"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { getMeeting } from "../../lib/meetingApi";
import { Meeting, Role } from "../../types/meeting";

export default function MeetingRoom() {
  const router = useRouter();
  const { id: meetingId, role } = router.query;

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Loading...");
  const [peerId, setPeerId] = useState<string>("");
  const [translateEnabled, setTranslateEnabled] = useState(true);
  const [isConnected, setIsConnected] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const pcChat = useRef<RTCPeerConnection | null>(null);
  const translationConnection = useRef<RTCPeerConnection | null>(null);

  const remotePeerId = useRef<string | null>(null);
  const myLanguage = useRef<string>("en-US");
  const localStream = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement | null>(null);
  const remoteVideo = useRef<HTMLVideoElement | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  const directAudio = useRef<HTMLAudioElement | null>(null);
  const translatedAudioStream = useRef<MediaStream | null>(null);
  const directAudioStream = useRef<MediaStream | null>(null);
  const hasStartedCall = useRef(false);

  // Generate a random 3-letter peer ID
  const generatePeerId = () =>
    Array.from({ length: 3 }, () =>
      String.fromCharCode(65 + Math.floor(Math.random() * 26))
    ).join("");

  // Fetch meeting data
  useEffect(() => {
    if (!meetingId || typeof meetingId !== "string") return;
    if (!role || (role !== "owner" && role !== "attendee")) {
      setError("Invalid role. Use ?role=owner or ?role=attendee");
      return;
    }

    const fetchMeeting = async () => {
      const meetingData = await getMeeting(meetingId);
      if (!meetingData) {
        setError(`Meeting "${meetingId}" not found`);
        return;
      }

      setMeeting(meetingData);

      // Set language based on role
      const participant =
        role === "owner" ? meetingData.owner : meetingData.attendee;
      myLanguage.current = participant.language;

      setStatus(`Joining as ${role} (${participant.language})...`);
    };

    fetchMeeting();
  }, [meetingId, role]);

  // Initialize WebRTC and connect to signaling
  useEffect(() => {
    if (!meeting || !role) return;

    const myPeerId = generatePeerId();
    setPeerId(myPeerId);

    const initMedia = async () => {
      // Get local video/audio stream
      localStream.current = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          sampleSize: 16,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (localVideo.current && localStream.current) {
        localVideo.current.srcObject = localStream.current;
      }

      // --- Video + Direct Audio PeerConnection ---
      pcChat.current = new RTCPeerConnection();

      // Add video tracks
      localStream.current
        .getVideoTracks()
        .forEach((t) => pcChat.current?.addTrack(t, localStream.current!));

      // Add audio tracks (disabled by default - used when translate is OFF)
      localStream.current.getAudioTracks().forEach((t) => {
        const audioTrack = t.clone();
        audioTrack.enabled = false; // Disabled when translate is ON
        pcChat.current?.addTrack(audioTrack, localStream.current!);
      });

      pcChat.current.ontrack = (e) => {
        if (e.track.kind === "video") {
          if (remoteVideo.current) {
            remoteVideo.current.srcObject = e.streams[0];
          }
        } else if (e.track.kind === "audio") {
          // Store direct audio stream for when translate is OFF
          directAudioStream.current = e.streams[0];
          if (directAudio.current) {
            directAudio.current.srcObject = e.streams[0];
          }
        }
      };

      pcChat.current.onicecandidate = (e) => {
        if (e.candidate && remotePeerId.current) {
          ws.current?.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: e.candidate,
              from: myPeerId,
              to: remotePeerId.current,
              lang: myLanguage.current,
            })
          );
        }
      };

      // --- Audio PeerConnection (for translation server) ---
      translationConnection.current = new RTCPeerConnection();

      const localAudioTracks = localStream.current.getAudioTracks();
      localAudioTracks.forEach((t) => {
        translationConnection.current?.addTrack(t, localStream.current!);
      });

      translationConnection.current.ontrack = (e) => {
        // Store translated audio stream
        translatedAudioStream.current = e.streams[0];
        if (remoteAudio.current) {
          remoteAudio.current.srcObject = e.streams[0];
        }
      };

      translationConnection.current.onicecandidate = (e) => {
        if (!e.candidate || !ws.current) return;
        if (ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: e.candidate,
              from: myPeerId,
              to: "translation-server",
              lang: myLanguage.current,
            })
          );
        }
      };
    };

    // Connect to signaling server
    ws.current = new WebSocket(
      process.env.NEXT_PUBLIC_SIGNAL_SERVER || "ws://localhost:10000"
    );

    ws.current.onopen = async () => {
      setStatus("Initializing media...");

      // Initialize media FIRST so pcChat is ready when peer-ready arrives
      await initMedia();

      setStatus("Connected to signaling server. Waiting for peer...");

      // Join with meeting context AFTER media is initialized
      ws.current?.send(
        JSON.stringify({
          type: "join",
          from: myPeerId,
          meetingId: meeting.id,
          role: role,
          lang: myLanguage.current,
        })
      );
    };

    ws.current.onclose = () => {
      setStatus("Disconnected from signaling server");
    };

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      const { type, from, sdp, candidate, peerId: remotePeer } = data;

      console.log("Received message:", { type, from });

      // Signal server tells us our peer is ready
      if (type === "peer-ready") {
        remotePeerId.current = remotePeer;
        setStatus(`Peer joined! Connecting...`);

        // Only owner initiates the call
        if (role === "owner" && !hasStartedCall.current) {
          hasStartedCall.current = true;
          await startCall(myPeerId);
        }
      }

      // Handle video offers/answers
      if (type === "offer" && from !== "translation-server") {
        remotePeerId.current = from;

        // Attendee starts translation connection BEFORE sending P2P answer
        // This ensures translation-server has both peer connections ready
        // before the "pairing" message arrives (triggered by P2P answer)
        if (!hasStartedCall.current) {
          hasStartedCall.current = true;
          await startTranslationConnection(myPeerId);
        }

        await pcChat.current?.setRemoteDescription({ type: "offer", sdp });
        const answer = await pcChat.current?.createAnswer();
        await pcChat.current?.setLocalDescription(answer!);

        ws.current?.send(
          JSON.stringify({
            type: "answer",
            sdp: answer?.sdp,
            from: myPeerId,
            to: from,
            lang: myLanguage.current,
          })
        );

        setStatus("Connected!");
        setIsConnected(true);
      } else if (type === "answer") {
        if (from === "translation-server") {
          await translationConnection.current?.setRemoteDescription({
            type: "answer",
            sdp,
          });
        } else {
          await pcChat.current?.setRemoteDescription({ type: "answer", sdp });
          setStatus("Connected!");
          setIsConnected(true);
        }
      } else if (type === "ice-candidate") {
        if (from === "translation-server") {
          await translationConnection.current?.addIceCandidate(candidate);
        } else {
          await pcChat.current?.addIceCandidate(candidate);
        }
      }
    };

    async function startTranslationConnection(myPeerId: string) {
      if (!translationConnection.current) return;

      const offerAudio = await translationConnection.current.createOffer();
      await translationConnection.current.setLocalDescription(offerAudio);

      ws.current?.send(
        JSON.stringify({
          type: "offer",
          sdp: offerAudio.sdp,
          from: myPeerId,
          to: "translation-server",
          lang: myLanguage.current,
        })
      );
    }

    async function startCall(myPeerId: string) {
      if (!pcChat.current || !remotePeerId.current) return;

      // Start translation connection first
      await startTranslationConnection(myPeerId);

      // Then start video connection
      const offer = await pcChat.current.createOffer();
      await pcChat.current.setLocalDescription(offer);

      ws.current?.send(
        JSON.stringify({
          type: "offer",
          sdp: offer.sdp,
          from: myPeerId,
          to: remotePeerId.current,
          lang: myLanguage.current,
        })
      );
    }

    return () => {
      ws.current?.close();
      pcChat.current?.close();
      translationConnection.current?.close();
      localStream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [meeting, role]);

  // Toggle between translated and direct audio
  useEffect(() => {
    if (!isConnected) return;

    if (translateEnabled) {
      // Enable translation: use translated audio, disable direct P2P audio
      if (remoteAudio.current && translatedAudioStream.current) {
        remoteAudio.current.srcObject = translatedAudioStream.current;
        remoteAudio.current.muted = false;
      }
      if (directAudio.current) {
        directAudio.current.muted = true;
      }
      // Disable outgoing direct audio on pcChat
      pcChat.current?.getSenders().forEach((sender) => {
        if (sender.track?.kind === "audio") {
          sender.track.enabled = false;
        }
      });
      // Enable outgoing audio to translation server
      translationConnection.current?.getSenders().forEach((sender) => {
        if (sender.track?.kind === "audio") {
          sender.track.enabled = true;
        }
      });
    } else {
      // Disable translation: use direct P2P audio
      if (remoteAudio.current) {
        remoteAudio.current.muted = true;
      }
      if (directAudio.current && directAudioStream.current) {
        directAudio.current.srcObject = directAudioStream.current;
        directAudio.current.muted = false;
      }
      // Enable outgoing direct audio on pcChat
      pcChat.current?.getSenders().forEach((sender) => {
        if (sender.track?.kind === "audio") {
          sender.track.enabled = true;
        }
      });
      // Disable outgoing audio to translation server
      translationConnection.current?.getSenders().forEach((sender) => {
        if (sender.track?.kind === "audio") {
          sender.track.enabled = false;
        }
      });
    }
  }, [translateEnabled, isConnected]);

  if (error) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="bg-white p-6 rounded-lg shadow">
          <h1 className="text-xl font-bold text-red-600 mb-2">Error</h1>
          <p>{error}</p>
          <a href="/meeting" className="text-blue-600 hover:underline mt-4 block">
            Create a new meeting
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold">
                Meeting: {meetingId}
              </h1>
              <p className="text-sm text-gray-600">
                Role: <span className="font-medium capitalize">{role}</span> |
                Language: <span className="font-medium">{myLanguage.current}</span> |
                My ID: <code className="bg-gray-100 px-1">{peerId}</code>
              </p>
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={() => setTranslateEnabled(!translateEnabled)}
                disabled={!isConnected}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  translateEnabled
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "bg-gray-300 text-gray-700 hover:bg-gray-400"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                Translate: {translateEnabled ? "ON" : "OFF"}
              </button>
              <span
                className={`inline-block px-2 py-1 rounded text-sm ${
                  status.includes("Connected!")
                    ? "bg-green-100 text-green-800"
                    : "bg-yellow-100 text-yellow-800"
                }`}
              >
                {status}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-sm font-medium mb-2">Local Video</h3>
            <video
              ref={localVideo}
              autoPlay
              muted
              playsInline
              className="w-full bg-black rounded"
              style={{ aspectRatio: "4/3" }}
            />
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-sm font-medium mb-2">Remote Video</h3>
            <video
              ref={remoteVideo}
              autoPlay
              playsInline
              className="w-full bg-black rounded"
              style={{ aspectRatio: "4/3" }}
            />
          </div>
        </div>

        {/* Translated audio (from translation server) */}
        <audio ref={remoteAudio} autoPlay />
        {/* Direct audio (P2P, when translate is OFF) */}
        <audio ref={directAudio} autoPlay muted />
      </div>
    </div>
  );
}
