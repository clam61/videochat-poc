"use client";
import { useEffect, useRef, useState } from "react";
import { v7 } from "uuid";

export default function Home() {
  const [userId, setUserId] = useState<string>("");
  const [peerId, setPeerId] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [isTranslationActive, setIsTranslationActive] = useState<boolean>(false);

  type Language = "es-MX" | "en-US";
  const [selectedLanguage, setSelectedLanguage] = useState<Language>("en-US");

  const ws = useRef<WebSocket | null>(null);
  const pcVideo = useRef<RTCPeerConnection | null>(null);
  const pcAudio = useRef<RTCPeerConnection | null>(null);

  const localStream = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement | null>(null);
  const remoteVideo = useRef<HTMLVideoElement | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);

  // Generate random user ID
  useEffect(() => {
    setUserId(v7());
  }, []);

  const speakTranslatedText = (text: string) => {
    const voices = speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang.startsWith("es"));
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice || null;
    utterance.lang = "es-ES";
    utterance.rate = 1;
    utterance.pitch = 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  };

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
      const { type, from, sdp, candidate, text } = data;

      // Handle video offers/answers
      /*  if (type === "translation-text") {
        if (text) {
          // const utterance = new SpeechSynthesisUtterance(text);
          // utterance.lang = selectedLanguage;
          // speechSynthesis.speak(utterance);

          console.log("[CLIENT] Translated text from", from, ":", text);
        }
      } */
      let lastText = "";

      if (type === "translation-text" && text) {
        if (text !== lastText) {
          lastText = text;
          console.log("[CLIENT] Translated text from", from, ":", text);
          // speakTranslatedText(text);
        }
      } else if (type === "offer" && from !== "translation-server") {
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
            lang: selectedLanguage,
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
      // pcAudio.current.ontrack = (e) => {
      //   console.log("[CLIENT] Audio track received:", e.streams[0]);
      //   if (remoteAudio.current) {
      //     if (!remoteAudio.current.srcObject) {
      //       remoteAudio.current.autoplay = true;
      //       remoteAudio.current.srcObject = e.streams[0];
      //       console.log("[CLIENT] Connected remoteAudio.srcObject");
      //     } else {
      //       console.log("[CLIENT] remoteAudio already connected");
      //     }
      //   }
      // };

      pcAudio.current.ontrack = (e) => {
        const stream = e.streams[0];
        console.log(e, "EEEVENT");
        if (!stream) return console.warn("[CLIENT] No stream in ontrack", e);
        const track = stream.getAudioTracks()[0];
        if (!track) return console.warn("[CLIENT] No audio track in stream", e);

        if (remoteAudio.current) {
          if (!remoteAudio.current.srcObject) {
            remoteAudio.current.srcObject = stream;
            remoteAudio.current.autoplay = true;
            console.log("[CLIENT] Connected remoteAudio.srcObject");
          }
        }
      };

      pcAudio.current.onicecandidate = (e) => {
        if (!e.candidate || !ws.current) return;
        if (ws.current.readyState === WebSocket.OPEN) {
          console.log("[CLIENT] Sending ICE candidate to translation-server", e.candidate);
          ws.current.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: e.candidate,
              from: userId,
              to: "translation-server",
            })
          );
        }
      };

      // // ICE candidate gathering for audio connection to translation server
      // pcAudio.current.onicecandidate = (e) => {
      //   if (!e.candidate || !ws.current) return;

      //   /*
      //   What an ICE candidate actually is
      //   An ICE candidate is essentially:
      //   (IP address, port, transport protocol, type)

      //   Where:
      //   IP address & port → a possible address your peer can reach you at
      //   Transport protocol → usually UDP, sometimes TCP
      //   Type → how the address was discovered:
      //   host → your local LAN address
      //   srflx → your public IP discovered via STUN server
      //   relay → a TURN server relay address
      //   */
      //   if (ws.current.readyState === WebSocket.OPEN) {
      //     console.log("Sending ICE candidate to translation server", e.candidate);
      //     ws.current.send(
      //       JSON.stringify({
      //         type: "ice-candidate",
      //         candidate: e.candidate,
      //         from: userId,
      //         to: "translation-server",
      //       })
      //     );
      //   }
      // };

      // Create audio offer only if translation is active
      // if (isTranslationActive && pcAudio.current) {
      //   const offerAudio = await pcAudio.current.createOffer();
      //   await pcAudio.current.setLocalDescription(offerAudio);

      //   /*
      //   The offerAudio contains an SDP (Session Description) describing:
      //   * Audio/video codecs
      //   * Media capabilities
      //   * A list of ICE candidates (possible addresses/ports to connect to)
      //   */
      //   ws.current?.send(
      //     JSON.stringify({
      //       type: "offer",
      //       sdp: offerAudio.sdp,
      //       from: userId,
      //       to: "translation-server",
      //       lang: selectedLanguage,
      //     })
      //   );
      // }

      if (isTranslationActive && pcAudio.current) {
        const offerAudio = await pcAudio.current.createOffer();
        await pcAudio.current.setLocalDescription(offerAudio);

        console.log("[CLIENT] Sending audio offer to translation-server");

        ws.current?.send(
          JSON.stringify({
            type: "offer",
            sdp: offerAudio.sdp,
            from: userId,
            to: "translation-server",
            lang: selectedLanguage,
          })
        );
      }
    };

    initMedia();
  }, [userId, peerId, isTranslationActive]);

  // Create pcAudio once during initialization
  useEffect(() => {
    if (!userId) return;

    const initAudioPC = async () => {
      pcAudio.current = new RTCPeerConnection();

      localStream.current
        ?.getAudioTracks()
        .forEach((t) => pcAudio.current?.addTrack(t, localStream.current!));

      pcAudio.current.ontrack = (e) => {
        const stream = e.streams[0];
        if (!stream) {
          console.log("[CLIENT] No stream in ontrack");
          return;
        }
        console.log("[CLIENT] Got TTS MediaStream!", stream);
        remoteAudio.current!.srcObject = stream;
        remoteAudio.current!.autoplay = true;
      };

      pcAudio.current.onicecandidate = (e) => {
        if (e.candidate && ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: e.candidate,
              from: userId,
              to: "translation-server",
            })
          );
        }
      };

      if (isTranslationActive) {
        const offerAudio = await pcAudio.current.createOffer();
        await pcAudio.current.setLocalDescription(offerAudio);

        ws.current?.send(
          JSON.stringify({
            type: "offer",
            sdp: offerAudio.sdp,
            from: userId,
            to: "translation-server",
            lang: selectedLanguage,
          })
        );
      }
    };

    initAudioPC();
  }, [userId, isTranslationActive]);

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
        lang: selectedLanguage,
      })
    );
  };

  useEffect(() => {
    ws.current?.send(
      JSON.stringify({
        type: "lang",
        from: userId,
        to: "translation-server",
        lang: selectedLanguage,
      })
    );
  }, [selectedLanguage]);

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
            setSelectedLanguage(e.target.options[e.target.selectedIndex].value as Language)
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
