"use client";
import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [userId, setUserId] = useState<string>("");
  const [peerId, setPeerId] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [isTranslationActive, setIsTranslationActive] = useState<boolean>(false);
  const [selectedLanguage, setSelectedLanguage] = useState<
    { type: "none" } | { type: "source"; language: "es-MX" | "en-US" }
  >({ type: "none" });

  const ws = useRef<WebSocket | null>(null);
  const pcVideo = useRef<RTCPeerConnection | null>(null);
  const pcAudio = useRef<RTCPeerConnection | null>(null);

  const localStream = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement | null>(null);
  const remoteVideo = useRef<HTMLVideoElement | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);

  const dropDownRef = useRef<HTMLDivElement | null>(null);

  // Generate random user ID
  useEffect(() => {
    const id = Math.random().toString(36).substr(2, 5);
    setUserId(id);
  }, []);

  // Connect to signaling server
  useEffect(() => {
    if (!userId) return;

    ws.current = new WebSocket(process.env.NEXT_PUBLIC_SIGNAL_SERVER || "ws://localhost:3001");

    ws.current.onopen = () => {
      // ✅ Connected to signaling server, sending join message
      ws.current?.send(JSON.stringify({ type: "join", from: userId }));
    };

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      const { type, from, sdp, candidate } = data;

      // Handle video offers/answers
      if (type === "offer" && from !== "translation-server") {
        console.log("📨 Received offer from peer:", from);
        await pcVideo.current?.setRemoteDescription({ type: "offer", sdp });
        const answer = await pcVideo.current?.createAnswer();
        await pcVideo.current?.setLocalDescription(answer!);
        ws.current?.send(
          JSON.stringify({
            type: "answer",
            sdp: answer?.sdp,
            from: userId,
            to: from,
            language: "wewewew",
          })
        );
      } else if (type === "answer") {
        if (from === "translation-server") {
          // 🎤 Translation server answer
          await pcAudio.current?.setRemoteDescription({ type: "answer", sdp });

          // ✅ Optionally, disconnect from signaling if translation is established
          // if (ws.current && ws.current.readyState === WebSocket.OPEN) ws.current.close();
        } else {
          await pcVideo.current?.setRemoteDescription({ type: "answer", sdp });
        }
      } else if (type === "ice-candidate") {
        // Handle ICE candidates for both video and audio
        if (from === "translation-server") {
          await pcAudio.current?.addIceCandidate(candidate);
        } else {
          await pcVideo.current?.addIceCandidate(candidate);
        }
      }
    };

    return () => ws.current?.close();
  }, [userId]);

  // Initialize local media and peer connections
  useEffect(() => {
    if (!userId) return;

    const initMedia = async () => {
      // Get local video/audio stream
      localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideo.current && localStream.current)
        localVideo.current.srcObject = localStream.current;

      // --- Video PeerConnection ---
      pcVideo.current = new RTCPeerConnection();

      // Add all local tracks to video peer connection
      localStream.current
        .getTracks()
        .forEach((t) => pcVideo.current?.addTrack(t, localStream.current!));

      // When remote track is received, set it to remoteVideo element
      pcVideo.current.ontrack = (e) => {
        if (remoteVideo.current) remoteVideo.current.srcObject = e.streams[0];
      };

      // ICE candidate gathering for video
      pcVideo.current.onicecandidate = (e) => {
        if (e.candidate && peerId) {
          ws.current?.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: e.candidate,
              from: userId,
              to: peerId,
              language: "spanish",
            })
          );
        }
      };

      // --- Audio PeerConnection ---
      pcAudio.current = new RTCPeerConnection();

      // Add only audio tracks to audio peer connection (for translation server)
      localStream.current
        .getAudioTracks()
        .forEach((t) => pcAudio.current?.addTrack(t, localStream.current!));

      // When remote track is received, set it to remoteAudio element
      pcAudio.current.ontrack = (e) => {
        if (remoteAudio.current) remoteAudio.current.srcObject = e.streams[0];
      };

      // ICE candidate gathering for audio connection to translation server
      pcAudio.current.onicecandidate = (e) => {
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
          console.log("Sending ICE candidate to translation server", e.candidate);
          ws.current.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: e.candidate,
              from: userId,
              to: "translation-server",
              language: "french",
            })
          );
        }
      };

      // Create audio offer only if translation is active
      if (isTranslationActive && pcAudio.current) {
        const offerAudio = await pcAudio.current.createOffer();
        await pcAudio.current.setLocalDescription(offerAudio);

        /*
        The offerAudio contains an SDP (Session Description) describing:
        * Audio/video codecs
        * Media capabilities
        * A list of ICE candidates (possible addresses/ports to connect to)
        */
        ws.current?.send(
          JSON.stringify({
            type: "offer",
            sdp: offerAudio.sdp,
            from: userId,
            to: "translation-server",
            language: "english",
          })
        );
      }
    };

    initMedia();
  }, [userId, peerId, isTranslationActive]);

  // Call peer
  const callPeer = async () => {
    if (!peerId || !pcVideo.current) return;

    console.log("📞 Calling peer:", peerId);
    setConnected(true);

    const offer = await pcVideo.current.createOffer();
    await pcVideo.current.setLocalDescription(offer);

    ws.current?.send(
      JSON.stringify({
        type: "offer",
        sdp: offer.sdp,
        from: userId,
        to: peerId,
        language: "mexican",
      })
    );
  };

  // --- Language dropdown ---
  const toggleDropdown = () => {
    if (dropDownRef.current)
      dropDownRef.current.style.display =
        dropDownRef.current.style.display === "block" ? "none" : "block";
  };

  const handleLanguageSelection = (language: "es-MX" | "en-US") => {
    setSelectedLanguage({ type: "source", language });
    toggleDropdown();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h1>🎥 P2P Video + 🎧 Translation Hybrid</h1>

      <div>
        <label>Enter peer ID: </label>
        <input value={peerId} onChange={(e) => setPeerId(e.target.value)} placeholder="Peer ID" />
        <button onClick={callPeer} disabled={!peerId || connected}>
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
        <div className="relative inline-block text-left">
          <div>
            <button
              onClick={toggleDropdown}
              className="inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {selectedLanguage.type === "none" ? "Languages" : selectedLanguage.language}
            </button>
          </div>
          <div
            ref={dropDownRef}
            className="absolute left-0 z-10 mt-2 w-32 rounded-md shadow-lg bg-white ring-1 ring-black ring-opacity-5"
            style={{ display: "none" }}
          >
            <div className="py-1">
              <button
                onClick={() => handleLanguageSelection("en-US")}
                className="block px-4 py-2 w-full text-sm text-gray-700 hover:bg-gray-100"
              >
                en-US
              </button>
              <button
                onClick={() => handleLanguageSelection("es-MX")}
                className="block px-4 py-2 w-full text-sm text-gray-700 hover:bg-gray-100"
              >
                es-MX
              </button>
            </div>
          </div>
        </div>

        <button
          onClick={() => setIsTranslationActive(!isTranslationActive)}
          className={`${
            isTranslationActive ? "bg-red-900" : "bg-green-700"
          } text-white font-bold py-2 px-4 rounded transition-colors duration-300`}
        >
          {isTranslationActive ? "Stop Translation" : "Start Translation"}
        </button>
      </div>

      <p>
        Your ID: <b>{userId}</b>
      </p>

      <div>
        <h3>Translated Audio</h3>
        <audio ref={remoteAudio} autoPlay controls />
      </div>
    </div>
  );
}
