"use client";
import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [userId, setUserId] = useState<string>("");
  const [peerId, setPeerId] = useState<string>("");
  const [connected, setConnected] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const pcVideo = useRef<RTCPeerConnection | null>(null);
  const pcAudio = useRef<RTCPeerConnection | null>(null);

  const localStream = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement | null>(null);
  const remoteVideo = useRef<HTMLVideoElement | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const id = Math.random().toString(36).substr(2, 5);
    setUserId(id);
  }, []);

  useEffect(() => {
    if (!userId) return;

    console.log(process.env.NEXT_PUBLIC_SIGNAL_SERVER);
    ws.current = new WebSocket(
      process.env.NEXT_PUBLIC_SIGNAL_SERVER || "ws://localhost:3001"
    );

    ws.current.onopen = () => {
      console.log(
        "✅ Connected to signaling server, sending:",
        JSON.stringify({ type: "join", from: userId })
      );
      ws.current?.send(JSON.stringify({ type: "join", from: userId }));
    };

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      const { type, from, sdp, candidate } = data;

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
          })
        );
      } else if (type === "answer") {
        if (from === "translation-server") {
          console.log("Connect to translation server", sdp);
          await pcAudio.current?.setRemoteDescription({ type: "answer", sdp });

          // ✅ Now that the connection is established, disconnect from signaling
          if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            console.log("Disconnecting from signaling server");
            ws.current.close();
          }
        } else {
          await pcVideo.current?.setRemoteDescription({ type: "answer", sdp });
        }
      } else if (type === "ice-candidate") {
        if (from === "translation-server") {
          await pcAudio.current?.addIceCandidate(candidate);
        } else {
          await pcVideo.current?.addIceCandidate(candidate);
        }
      }
    };

    return () => ws.current?.close();
  }, [userId]);

  useEffect(() => {
    if (!userId) return;

    const initMedia = async () => {
      localStream.current = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (localVideo.current && localStream.current) {
        localVideo.current.srcObject = localStream.current;
      }

      pcVideo.current = new RTCPeerConnection();
      localStream.current
        .getTracks()
        .forEach((t) => pcVideo.current?.addTrack(t, localStream.current!));

      pcVideo.current.ontrack = (e) => {
        if (remoteVideo.current) remoteVideo.current.srcObject = e.streams[0];
      };

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

      pcAudio.current = new RTCPeerConnection();
      localStream.current
        .getAudioTracks()
        .forEach((track) =>
          pcAudio.current?.addTrack(track, localStream.current!)
        );

      pcAudio.current.ontrack = (e) => {
        if (remoteAudio.current) remoteAudio.current.srcObject = e.streams[0];
      };

      // pcAudio.current.onicecandidate = (e) => {
      //   if (e.candidate) {
      //     ws.current?.send(JSON.stringify({
      //       type: "ice-candidate",
      //       candidate: e.candidate,
      //       from: userId,
      //       to: "translation-server",
      //     }));
      //   }
      // };

      pcAudio.current.onicecandidate = (e) => {
        if (e.candidate) {
          // @ts-ignore
          if (ws.current.readyState === WebSocket.OPEN) {
            console.log(
              "Sending to already open ws",
              JSON.stringify({
                type: "ice-candidate",
                candidate: e.candidate,
                from: userId,
                to: "translation-server",
              })
            );
            // @ts-ignore
            ws.current.send(
              JSON.stringify({
                type: "ice-candidate",
                candidate: e.candidate,
                from: userId,
                to: "translation-server",
              })
            );
          } else {
            // @ts-ignore
            ws.current.addEventListener(
              "open",
              () => {
                console.log(
                  "Sending to ws on listener",
                  JSON.stringify({
                    type: "ice-candidate",
                    candidate: e.candidate,
                    from: userId,
                    to: "translation-server",
                  })
                );
                // @ts-ignore
                ws.current.send(
                  JSON.stringify({
                    type: "ice-candidate",
                    candidate: e.candidate,
                    from: userId,
                    to: "translation-server",
                  })
                );
              },
              { once: true }
            );
          }
        }
      };

      // The offerAudio contains an SDP (Session Description) describing:
      // * Audio/video codecs
      // * Media capabilities
      // A list of ICE candidates (possible addresses/ports to connect to)

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

      Example (simplified):

      {
        "candidate": "candidate:842163049 1 udp 1677729535 192.168.1.5 52345 typ host",
        "sdpMid": "0",
        "sdpMLineIndex": 0
      }
      */
      const offerAudio = await pcAudio.current.createOffer();
      await pcAudio.current.setLocalDescription(offerAudio);

      // ws.current?.send(JSON.stringify({
      //   type: "offer",
      //   sdp: offerAudio.sdp,
      //   from: userId,
      //   to: "translation-server",
      // }));

      // @ts-ignore
      const sendWhenOpen = (ws, msg) => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log("Send already open", msg);
          ws.send(msg);
        } else {
          ws.addEventListener("open", () => {
            console.log("Send on listener", msg);
            ws.send(msg), { once: true };
          });
        }
      };

      sendWhenOpen(
        ws.current,
        JSON.stringify({
          type: "offer",
          sdp: offerAudio.sdp,
          from: userId,
          to: "translation-server",
        })
      );
    };

    initMedia();
  }, [userId, peerId]);

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
      })
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h1>🎥 P2P Video + 🎧 Translation Hybrid</h1>

      <div>
        <label>Enter peer ID: </label>
        <input
          value={peerId}
          onChange={(e) => setPeerId(e.target.value)}
          placeholder="Peer ID"
        />
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

      <div>
        <h3>Translated Audio</h3>
        <audio ref={remoteAudio} autoPlay controls />
      </div>

      <p>
        Your ID: <b>{userId}</b>
      </p>
    </div>
  );
}
