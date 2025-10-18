"use client";
import { useEffect, useRef, useState } from "react";
import { v7 } from "uuid";

export default function Home() {
  const [userId, setUserId] = useState<string>("");
  const [peerId, setPeerId] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [isTranslationActive, setIsTranslationActive] = useState<boolean>(true);

  type Language = "es-MX" | "en-US";
  const [selectedLanguage, setSelectedLanguage] = useState<Language>("en-US");

  const ws = useRef<WebSocket | null>(null);
  const pcChat = useRef<RTCPeerConnection | null>(null);
  const translationConnection = useRef<RTCPeerConnection | null>(null);

  const localStream = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement | null>(null);
  const remoteVideo = useRef<HTMLVideoElement | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);

  const random3Letter = () =>
    Array.from({ length: 3 }, () =>
      String.fromCharCode(65 + Math.floor(Math.random() * 26))
    ).join("");

  // Generate random user ID
  useEffect(() => {
    //setUserId(v7());
    setUserId(random3Letter());
  }, []);

  // Connect to signaling server
  useEffect(() => {
    if (!userId) return;

    ws.current = new WebSocket(
      process.env.NEXT_PUBLIC_SIGNAL_SERVER || "ws://localhost:3001"
    );

    ws.current.onopen = () => {
      // ✅ Connected to signaling server, sending join message
      console.log("send join");
      ws.current?.send(JSON.stringify({ type: "join", from: userId }));
    };

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      const { type, from, sdp, candidate } = data;

      console.log("Received message", { type, from });
      // Handle video offers/answers
      if (type === "offer" && from !== "translation-server") {
        console.log("📨 Received offer from peer:", from);
        await pcChat.current?.setRemoteDescription({ type: "offer", sdp });
        const answer = await pcChat.current?.createAnswer();
        await pcChat.current?.setLocalDescription(answer!);
        console.log("send answer to", from);
        ws.current?.send(
          JSON.stringify({
            type: "answer",
            sdp: answer?.sdp,
            from: userId,
            to: from,
            lang: selectedLanguage,
          })
        );
      } else if (type === "answer") {
        console.log("Received answer from", from);
        if (from === "translation-server") {
          // 🎤 Translation server answer
          await translationConnection.current?.setRemoteDescription({
            type: "answer",
            sdp,
          });

          // ✅ Optionally, disconnect from signaling if translation is established
          // if (ws.current && ws.current.readyState === WebSocket.OPEN) ws.current.close();
        } else {
          await pcChat.current?.setRemoteDescription({ type: "answer", sdp });
        }
      } else if (type === "ice-candidate") {
        // Handle ICE candidates for both video and audio
        if (from === "translation-server") {
          await translationConnection.current?.addIceCandidate(candidate);
        } else {
          await pcChat.current?.addIceCandidate(candidate);
        }
      }
    };

    return () => ws.current?.close();
  }, [userId]);

  // Initialize local media and peer connections
  useEffect(() => {
    if (!userId) return;

    console.log("Useeffect", userId, peerId);
    const initMedia = async () => {
      // Get local video/audio stream
      localStream.current = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: {
          channelCount: 1, // Force mono
          sampleRate: 16000, // Optional, matches AWS Transcribe preferred rate
          sampleSize: 16, // 16-bit PCM resolution
          echoCancellation: true, // Keep or remove depending on your use case
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // show your own video in the page
      if (localVideo.current && localStream.current)
        localVideo.current.srcObject = localStream.current;

      // --- Video PeerConnection ---
      pcChat.current = new RTCPeerConnection();

      // Add all local video tracks to video peer connection chat
      localStream.current
        .getVideoTracks()
        .forEach((t) => pcChat.current?.addTrack(t, localStream.current!));

      // get the local audio tracks
      const localAudioTracks = localStream.current.getAudioTracks();

      // add a clone of all audio tracks to the peer connection chat
      // localAudioTracks.forEach((t) => {
      //   console.log("Add audio track pchat");
      //   pcChat.current?.addTrack(t.clone(), localStream.current!);

      // });

      // When remote track is received, set it to remoteVideo element
      pcChat.current.ontrack = (e) => {
        if (remoteVideo.current) remoteVideo.current.srcObject = e.streams[0];
      };

      // ICE candidate gathering for video
      pcChat.current.onicecandidate = (e) => {
        console.log("onicecandidate fired");
        if (e.candidate && peerId) {
          console.log("send ice candidate to", peerId);
          ws.current?.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: e.candidate,
              from: userId,
              to: peerId,
              lang: selectedLanguage,
            })
          );
        }
      };

      // --- Audio PeerConnection ---
      translationConnection.current = new RTCPeerConnection();

      // Add only audio tracks to audio peer connection (for translation server)
      localAudioTracks.forEach((t) => {
        console.log("add adio track to trans audo");
        // const tc = t.clone();
        // tc.enabled = false;
        // translatedAudio.current?.addTrack(tc, localStream.current!);
        translationConnection.current?.addTrack(t, localStream.current!);
      });

      translationConnection.current.oniceconnectionstatechange = () => {
        console.log(
          "ICE state:",
          translationConnection.current?.iceConnectionState
        );
      };

      // When remote track is received, set it to remoteAudio element
      translationConnection.current.ontrack = (e) => {
        if (remoteAudio.current) remoteAudio.current.srcObject = e.streams[0];
      };

      // ICE candidate gathering for audio connection to translation server
      translationConnection.current.onicecandidate = (e) => {
        if (!e.candidate || !ws.current) return;

        /*
        What an ICE candidate actually is
        An ICE candidate is essentially:
        (IP address, port, transport protocol, type)
        
        Where:
        IP address & port → a possible address your peer can reach you at
        Transport protocol → usually UDP, sometimes TCP
        Type → how the address was discovered:
        host → your local LAN address
        srflx → your public IP discovered via STUN server
        relay → a TURN server relay address
        */
        if (ws.current.readyState === WebSocket.OPEN) {
          console.log(
            "Sending ICE candidate to translation server",
            e.candidate
          );
          console.log("send ice cand to trans");
          ws.current.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: e.candidate,
              from: userId,
              to: "translation-server",
              lang: selectedLanguage,
            })
          );
        }
      };

      // Create audio offer only if translation is active

      // create the offer
      const offerAudio = await translationConnection.current.createOffer();

      // set the local description to start gathering ICE candidates and triggering
      // pcAudio.onicecandidate callbacks
      await translationConnection.current.setLocalDescription(offerAudio);

      /*
        The offerAudio contains an SDP (Session Description) describing:
        * Audio/video codecs
        * Media capabilities
        * A list of ICE candidates (possible addresses/ports to connect to)
        */
      console.log("Send offer to translation server");
      ws.current?.send(
        JSON.stringify({
          type: "offer",
          sdp: offerAudio.sdp,
          from: userId,
          to: "translation-server",
          lang: selectedLanguage,
        })
      );
    };

    initMedia();
  }, [userId, peerId]);

  // Call peer
  const callPeer = async () => {
    if (!peerId || !pcChat.current) return;

    console.log("📞 Calling peer:", peerId);
    setConnected(true);

    const offer = await pcChat.current.createOffer();
    await pcChat.current.setLocalDescription(offer);
    console.log("send offer to", peerId);
    ws.current?.send(
      JSON.stringify({
        type: "offer",
        sdp: offer.sdp,
        from: userId,
        to: peerId,
        lang: selectedLanguage,
      })
    );
  };

  useEffect(() => {
    console.log("send lang to trans");
    ws.current?.send(
      JSON.stringify({
        type: "lang",
        from: userId,
        to: "translation-server",
        lang: selectedLanguage,
      })
    );
  }, [selectedLanguage]);

  // // enable and disable
  // useEffect(() => {
  //   if (translatedAudio.current) {
  //     console.log("Set trans audio", isTranslationActive);
  //     translatedAudio.current
  //       .getSenders()
  //       .forEach((s) => s.track && (s.track.enabled = isTranslationActive));
  //   }

  //   if (pcChat.current) {
  //     console.log("Set pc chat audio", isTranslationActive);
  //     pcChat.current.getSenders().forEach((s) => {
  //       if (s.track?.kind === "audio") {
  //         s.track.enabled = !isTranslationActive;
  //       }
  //     });
  //   }
  // }, [isTranslationActive]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h1>🎥 P2P Video + 🎧 Translation Hybrid</h1>

      <div className="flex gap-4 items-center">
        <label>
          My user ID: <code>{userId}</code>
        </label>
        <label>Enter peer ID: </label>
        <input
          className="border border-gray-300 rounded-md py-2 px-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          value={peerId}
          onChange={(e) => setPeerId(e.target.value)}
          placeholder="Peer ID"
        />
        <button
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
          onClick={callPeer}
          disabled={!peerId || connected}
        >
          Call
        </button>
      </div>

      <div style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}>
        <div>
          <h3>Local Video</h3>
          <video
            ref={localVideo}
            autoPlay
            muted
            playsInline
            style={{ width: 300, height: 200, backgroundColor: "black" }}
          />
        </div>
        <div>
          <h3>Remote Video</h3>
          <video
            ref={remoteVideo}
            autoPlay
            playsInline
            style={{ width: 300, height: 200, backgroundColor: "black" }}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <select
          className="border border-gray-300 bg-white text-gray-900 px-3 py-2 rounded-md appearance-none"
          value={selectedLanguage}
          onChange={(e) =>
            setSelectedLanguage(
              e.target.options[e.target.selectedIndex].value as Language
            )
          }
        >
          <option value="en-US">en-US</option>
          <option value="es-MX">es-MX</option>
        </select>

        <button
          onClick={() => setIsTranslationActive(!isTranslationActive)}
          className={`${
            isTranslationActive ? "bg-red-900" : "bg-green-700"
          } text-white font-bold py-2 px-4 rounded transition-colors duration-300`}
        >
          {isTranslationActive ? "Stop Translation" : "Start Translation"}
        </button>
      </div>

      <div>
        <h3>Translated Audio</h3>
        <audio ref={remoteAudio} autoPlay controls />
      </div>
    </div>
  );
}
