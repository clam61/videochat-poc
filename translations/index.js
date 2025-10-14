import dotenv from "dotenv";
import * as http from "http";
import { WebSocket } from "ws";
import avahqWrtc from "@avahq/wrtc";

const server = http.createServer();

dotenv.config();

const { RTCPeerConnection, RTCSessionDescription, MediaStream } = avahqWrtc;

const pcs = new Map();

const signalWssUrl = process.env.SIGNAL_SERVER;

if (!signalWssUrl) {
  throw Error("Set env SIGNAL_SERVER");
}
console.log(signalWssUrl);
const signaling = new WebSocket(signalWssUrl);

signaling.on("open", () => {
  const joinMessage = JSON.stringify({
    type: "join",
    from: "translation-server",
  });
  signaling.send(joinMessage);
  console.log("Translation server connected to signaling server", joinMessage);
});

signaling.on("message", async (msg) => {
  console.log("On message", msg.toString());
  const data = JSON.parse(msg);
  const { type, from, sdp, candidate } = data;

  if (type === "offer") {
    console.log(`Received offer from ${from}`);
    const pc = new RTCPeerConnection();
    pcs.set(from, pc);

    // ⬅️ ADDED: Create a stream to forward audio back
    const outgoingStream = new MediaStream();

    pc.ontrack = (event) => {
      const incomingStream = event.streams[0];
      console.log(`Received audio track from ${from}`);

      // ⬅️ ADDED: Forward all incoming audio tracks back
      incomingStream.getAudioTracks().forEach((track) => {
        outgoingStream.addTrack(track);
      });

      // ⬅️ ADDED: Add tracks back to connection
      outgoingStream
        .getTracks()
        .forEach((track) => pc.addTrack(track, outgoingStream));
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        signaling.send(
          JSON.stringify({
            type: "ice-candidate",
            candidate: e.candidate,
            from: "translation-server",
            to: from,
          })
        );
      }
    };

    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp })
    );
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    signaling.send(
      JSON.stringify({
        type: "answer",
        sdp: answer.sdp,
        from: "translation-server",
        to: from,
      })
    );
    console.log(`Sent answer to ${from}`);
  } else if (type === "ice-candidate") {
    const pc = pcs.get(from);
    if (pc && candidate) pc.addIceCandidate(candidate);
  }
});

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(
    `Translation server running on http server on http://localhost:${port}`
  );
});
