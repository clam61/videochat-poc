import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [userId, setUserId] = useState();
  const [peerId, setPeerId] = useState("");

  const ws = useRef<WebSocket | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);

  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const localStream = useRef<MediaStream | null>(null);

  useEffect(() => {
    ws.current = new WebSocket("wss://videochat-poc.onrender.com");

    ws.current.onopen = () => {
      console.log("Connected to signaling server");
      ws.current?.send(JSON.stringify({ type: "join", from: userId }));
    };

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      const { type, from, sdp, candidate } = data;

      if (type === "offer") {
        await pc.current?.setRemoteDescription({ type: "offer", sdp });
        const answer = await pc.current?.createAnswer();
        await pc.current?.setLocalDescription(answer!);
        ws.current?.send(JSON.stringify({ type: "answer", sdp: answer?.sdp, from: userId, to: from }));
      } else if (type === "answer") {
        await pc.current?.setRemoteDescription({ type: "answer", sdp });
      } else if (type === "ice-candidate") {
        if (candidate) await pc.current?.addIceCandidate(candidate);
      }
    };

    return () => {
      ws.current?.close();
    };
  }, [userId]);

  useEffect(() => {
    const init = async () => {
      localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideo.current && localStream.current) {
        localVideo.current.srcObject = localStream.current;
      }

      pc.current = new RTCPeerConnection();

      localStream.current.getTracks().forEach((track) => pc.current?.addTrack(track, localStream.current!));

      pc.current.ontrack = (event) => {
        if (remoteVideo.current) remoteVideo.current.srcObject = event.streams[0];
      };

      pc.current.onicecandidate = (event) => {
        if (event.candidate) {
          ws.current?.send(JSON.stringify({ type: "ice-candidate", candidate: event.candidate, from: userId, to: peerId }));
        }
      };
    };

    init();
  }, [peerId, userId]);

  useEffect(() => {
    const userId = Math.random().toString(36).substr(2, 5)

    // @ts-ignore
    setUserId(userId);
  }, []);

  const callPeer = async () => {
    if (!peerId) return;

    const offer = await pc.current?.createOffer();
    await pc.current?.setLocalDescription(offer!);

    ws.current?.send(JSON.stringify({
      type: "offer",
      sdp: offer?.sdp,
      from: userId,
      to: peerId,
    }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h1>P2P Video Chat PoC</h1>

      <div>
        <label>Enter peer ID to call: </label>
        <input value={peerId} onChange={(e) => setPeerId(e.target.value)} />
        <button onClick={callPeer}>Call</button>
      </div>

      <div style={{ display: "flex", gap: "1rem" }}>
        <div>
          <h3>Local Video</h3>
          <video ref={localVideo} autoPlay muted style={{ width: 300, height: 200, backgroundColor: "black" }} />
        </div>

        <div>
          <h3>Remote Video</h3>
          <video ref={remoteVideo} autoPlay style={{ width: 300, height: 200, backgroundColor: "black" }} />
        </div>
      </div>

      <p>Your ID: <b>{userId}</b></p>
    </div>

  );
}
