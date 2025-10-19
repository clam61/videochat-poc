"use client";
import { useEffect, useRef, useState } from "react";
import { v7 } from "uuid";

export default function Home() {
  const [userId, setUserId] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [startedCall, setStartedCall] = useState(false);

  type Language = "es-US" | "en-US" | "ko-KR" | "ru-RU";

  const ws = useRef<WebSocket | null>(null);
  const pcChat = useRef<RTCPeerConnection | null>(null);
  const translationConnection = useRef<RTCPeerConnection | null>(null);

  const peerId = useRef<string | null>(null);
  const selectedLanguage = useRef<string>("en-US");
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
        if (e.candidate && peerId.current) {
          console.log("send ice candidate to", peerId.current);
          ws.current?.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: e.candidate,
              from: userId,
              to: peerId.current,
              lang: selectedLanguage.current,
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
          "TRANSLATION ICE state:",
          translationConnection.current?.iceConnectionState
        );
      };

      // When remote track is received, set it to remoteAudio element
      translationConnection.current.ontrack = (e) => {
        // const remoteAudioStream = new MediaStream();
        // remoteAudioStream.addTrack(e.track);
        // if (remoteAudio.current) {
        //   remoteAudio.current.srcObject = remoteAudioStream;
        // }
        console.log(
          "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!Received track from translation",
          e.track,
          !!e.streams[0],
          !!remoteAudio.current
        );
        if (remoteAudio.current) {
          console.log("Setting remote audio****");
          remoteAudio.current.srcObject = e.streams[0];
        }
      };

      // ICE candidate gathering for audio connection to translation server
      translationConnection.current.onicecandidate = (e) => {
        if (!e.candidate || !ws.current) return;

        // What an ICE candidate actually is
        // An ICE candidate is essentially:
        // (IP address, port, transport protocol, type)

        // Where:
        // IP address & port → a possible address your peer can reach you at
        // Transport protocol → usually UDP, sometimes TCP
        // Type → how the address was discovered:
        // host → your local LAN address
        // srflx → your public IP discovered via STUN server
        // relay → a TURN server relay address

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
              lang: selectedLanguage.current,
            })
          );
        }
      };
    };

    ws.current = new WebSocket(
      process.env.NEXT_PUBLIC_SIGNAL_SERVER || "ws://localhost:3001"
    );

    ws.current.onopen = async () => {
      setWsConnected(true);
      // ✅ Connected to signaling server, sending join message
      console.log("send join");
      ws.current?.send(JSON.stringify({ type: "join", from: userId }));

      await initMedia();
    };

    ws.current.onclose = (event) => {
      console.log("WebSocket closed");
      console.log("Code:", event.code); // Close code (1000 = normal)
      console.log("Reason:", event.reason); // Optional reason string
      console.log("WasClean:", event.wasClean); // true if closed cleanly
    };

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      const { type, from, sdp, candidate } = data;

      console.log("RECEIVED MESSAGE", { type, from });
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
            lang: selectedLanguage.current,
          })
        );
      } else if (type === "answer") {
        console.log("Received answer from", from);
        if (from === "translation-server") {
          console.log(
            "Received answer from TRANSLATION server, setting remote desc",
            sdp
          );
          // 🎤 Translation server answer
          await translationConnection.current?.setRemoteDescription({
            type: "answer",
            sdp,
          });
        } else {
          await pcChat.current?.setRemoteDescription({ type: "answer", sdp });
        }
      } else if (type === "ice-candidate") {
        // Handle ICE candidates for both video and audio
        if (from === "translation-server") {
          console.log(
            "Received candidate from translation server",
            !!candidate
          );
          await translationConnection.current?.addIceCandidate(candidate);
        } else {
          await pcChat.current?.addIceCandidate(candidate);
        }
      }
    };

    return () => ws.current?.close();
  }, [userId]);

  // Call peer
  const callPeer = async () => {
    if (peerId.current?.length !== 3 || !pcChat.current) return;

    ////// start repeat code for trans server

    if (!translationConnection.current) return;

    // create the offer
    const offerAudio = await translationConnection.current.createOffer();

    // set the local description to start gathering ICE candidates and triggering
    // pcAudio.onicecandidate callbacks
    await translationConnection.current.setLocalDescription(offerAudio);

    //   The offerAudio contains an SDP (Session Description) describing:
    //  Audio/video codecs
    //  Media capabilities
    //  A list of ICE candidates (possible addresses/ports to connect to)

    console.log("Send offer to translation server");
    ws.current?.send(
      JSON.stringify({
        type: "offer",
        sdp: offerAudio.sdp,
        from: userId,
        to: "translation-server",
        lang: selectedLanguage.current,
      })
    );
    ////// end repeat code for trans serer
    console.log("📞 Calling peer:", peerId.current);
    setConnected(true);

    const offer = await pcChat.current.createOffer();
    await pcChat.current.setLocalDescription(offer);
    console.log("send offer to", peerId.current);
    ws.current?.send(
      JSON.stringify({
        type: "offer",
        sdp: offer.sdp,
        from: userId,
        to: peerId.current,
        lang: selectedLanguage.current,
      })
    );
  };

  // useEffect(() => {
  //   console.log("send lang to trans");
  //   ws.current?.send(
  //     JSON.stringify({
  //       type: "lang",
  //       from: userId,
  //       to: "translation-server",
  //       lang: selectedLanguage.current,
  //     })
  //   );
  // }, [selectedLanguage.current]);

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
        <div>
          My user ID: <code>{userId}</code>
        </div>
        <div>
          <select
            disabled={!wsConnected || startedCall}
            className="disabled:opacity-70 disabled:bg-gray-100 border border-gray-300 bg-white text-gray-900 px-3 py-2 rounded-md appearance-none"
            onChange={(e) => {
              selectedLanguage.current = e.target.options[
                e.target.selectedIndex
              ].value as Language;
            }}
          >
            <option value="en-US">en-US</option>
            <option value="es-US">es-US</option>
            <option value="ko-KR">ko-KR</option>
            <option value="ru-RU">ru-RU</option>
            <option value="zh-HK">zh-HK</option>
            <option value="zh-CN">zh-CN</option>
          </select>
        </div>
      </div>

      <div>
        <button
          className="disabled:bg-gray-400 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
          onClick={async () => {
            if (!translationConnection.current) return;

            setStartedCall(true);
            // create the offer
            const offerAudio =
              await translationConnection.current.createOffer();

            // set the local description to start gathering ICE candidates and triggering
            // pcAudio.onicecandidate callbacks
            await translationConnection.current.setLocalDescription(offerAudio);

            //   The offerAudio contains an SDP (Session Description) describing:
            //  Audio/video codecs
            //  Media capabilities
            //  A list of ICE candidates (possible addresses/ports to connect to)

            console.log("Send offer to translation server", offerAudio.sdp);
            ws.current?.send(
              JSON.stringify({
                type: "offer",
                sdp: offerAudio.sdp,
                from: userId,
                to: "translation-server",
                lang: selectedLanguage.current,
              })
            );
          }}
          disabled={!wsConnected || startedCall}
        >
          Start Call
        </button>
      </div>
      <div className="flex gap-4 items-center">
        <label>Enter peer ID: </label>
        <input
          className="border border-gray-300 rounded-md py-2 px-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          onChange={(e) => {
            peerId.current = e.target.value.toUpperCase();
            console.log(peerId.current);
          }}
          placeholder="Peer ID"
        />
        <button
          className="disabled:bg-gray-400 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
          onClick={callPeer}
          disabled={!wsConnected || connected}
        >
          Join Call
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
      <div>
        <audio ref={remoteAudio} autoPlay />
      </div>
    </div>
  );
}
