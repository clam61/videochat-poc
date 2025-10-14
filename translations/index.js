import dotenv from "dotenv";
import * as http from "http";
import { WebSocket } from "ws";
import avahqWrtc from "@avahq/wrtc"; // Node.js WebRTC implementation

// Create a basic HTTP server (needed by some WebRTC libraries, but not strictly used for requests here)
const server = http.createServer();

dotenv.config(); // Load environment variables from .env file

// Extract WebRTC classes from the Node WebRTC library
const { RTCPeerConnection, RTCSessionDescription, MediaStream } = avahqWrtc;

// Map to store active peer connections; key = client ID, value = RTCPeerConnection instance
const pcs = new Map();

// Get the signaling server URL from environment variables
const signalWssUrl = process.env.SIGNAL_SERVER;
if (!signalWssUrl) {
  throw Error("Set env SIGNAL_SERVER");
}
console.log(signalWssUrl);

// Connect to the signaling server via WebSocket
// This server is used only for exchanging SDP and ICE candidates — not for the audio itself
const signaling = new WebSocket(signalWssUrl);

// When connection to signaling server is open, announce ourselves as the translation server
signaling.on("open", () => {
  const joinMessage = JSON.stringify({
    type: "join",
    from: "translation-server", // our ID used by signaling server to route messages
  });
  signaling.send(joinMessage);
  console.log("Translation server connected to signaling server", joinMessage);
});

// Handle messages from the signaling server (offers, ICE candidates, etc.)
signaling.on("message", async (msg) => {
  console.log("On message", msg.toString());
  const data = JSON.parse(msg);
  const { type, from, sdp, candidate } = data;

  // If a client wants to start a WebRTC connection, they send an "offer"
  if (type === "offer") {
    console.log(`Received offer from ${from}`);

    // Create a new peer connection for this client
    const pc = new RTCPeerConnection();

    // Store it in the map so we can reference it later (e.g., for ICE candidates)
    pcs.set(from, pc);

    // Create a new MediaStream for sending audio back to the client
    const outgoingStream = new MediaStream();

    // When the client sends us audio tracks, this event fires
    pc.ontrack = (event) => {
      const incomingStream = event.streams[0];
      console.log(`Received audio track from ${from}`);

      // Forward each incoming audio track into our outgoing stream
      // (This is where you could do audio processing/translation)
      incomingStream.getAudioTracks().forEach((track) => {
        outgoingStream.addTrack(track);
      });

      // Add all outgoing tracks to the peer connection so the client can hear them
      outgoingStream
        .getTracks()
        .forEach((track) => pc.addTrack(track, outgoingStream));
    };

    // When this peer connection generates ICE candidates (network info)
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        // Send ICE candidates back to the client via signaling server
        signaling.send(
          JSON.stringify({
            type: "ice-candidate",
            candidate: e.candidate,
            from: "translation-server",
            to: from, // send to the correct client
          })
        );
      }
    };

    // Set the remote description using the client's offer
    // This tells WebRTC what the client wants to send/receive
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp })
    );

    // Create our answer SDP (describes what the translation server can send/receive)
    const answer = await pc.createAnswer();

    // Set the answer as our local description (required before sending it back)
    await pc.setLocalDescription(answer);

    // Send the SDP answer back to the client via signaling server
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
    // If the client sends us an ICE candidate, add it to the peer connection
    const pc = pcs.get(from);
    if (pc && candidate) pc.addIceCandidate(candidate);
  }
});

// Start the HTTP server (not strictly used for WebRTC, but required by Node libraries sometimes)
const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(
    `Translation server running on http server on http://localhost:${port}`
  );
});
