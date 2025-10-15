import dotenv from "dotenv";
import { WebSocket } from "ws";
import avahqWrtc from "@avahq/wrtc"; // Node.js WebRTC implementation
import { TranscribeClient } from "@aws-sdk/client-transcribe";

const client = new TranscribeClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: "YOUR_ACCESS_KEY_ID",
    secretAccessKey: "YOUR_SECRET_ACCESS_KEY",
  },
});

dotenv.config(); // Load environment variables from .env file

// Extract WebRTC classes from the Node WebRTC library
const { RTCPeerConnection, RTCSessionDescription, MediaStream } = avahqWrtc;

// Map to store active peer connections; key = client ID, value = RTCPeerConnection instance
const pcs = new Map();

// Map to store language ; key = client ID, value = language of the incoming audio
/// TODO lang map would continue to grow indefinitely
const languages = new Map();

/// TODO lang map would continue to grow indefinitely
const connections = new Map();

// Get the signaling server URL from environment variables
const signalWssUrl = process.env.SIGNAL_SERVER;
if (!signalWssUrl) {
  throw Error("Set env SIGNAL_SERVER");
}

console.log(`Signaling server: ${signalWssUrl}`);

// --- Connection state tracking variables ---
let signaling; // WebSocket connection instance
let reconnectAttempts = 0; // Number of times we've tried to reconnect
let reconnectTimeout = null; // Used to prevent multiple simultaneous reconnect attempts

/**
 * Connects to the signaling server via WebSocket.
 * If the connection drops, automatically attempts to reconnect with exponential backoff.
 */
const connectSignaling = () => {
  signaling = new WebSocket(signalWssUrl);

  // When connection to signaling server is open, announce ourselves as the translation server
  signaling.on("open", () => {
    reconnectAttempts = 0; // Reset reconnection counter after success

    const joinMessage = JSON.stringify({
      type: "join",
      from: "translation-server", // our ID used by signaling server to route messages
    });

    signaling.send(joinMessage);
    console.log(
      "✅ Translation server connected to signaling server",
      joinMessage
    );
  });

  // Handle messages from the signaling server (offers, ICE candidates, etc.)
  signaling.on("message", async (msg) => {
    console.log("On message", msg.toString());
    const data = JSON.parse(msg);
    const { type, from, sdp, candidate, lang } = data;

    // set the language in a map if it exists
    if (lang) {
      languages.set(from, lang);

      for (const [key, value] of languages) {
        console.log("\t", key, "-", value);
      }
    }

    // if a client accepts a WebRTC connection, they send an "answer"
    if (type === "answer") {
      // add connections for fast querying
      connections.set(from, to);
      connections.set(to, from);
    }
    // If a client wants to start a WebRTC connection, they send an "offer"
    else if (type === "offer") {
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

        // get the peer this user is connected to
        const pc2 = pcs.get(connections.get(from));

        // no peer connection then return
        if (!pc2) return;

        // encode audio to pcm
        // stream audio to speech to text
        // translate text to text
        // create text to speech audio
        // add audio to pc2 peer connection so the other client can hear them

        // outgoingStream
        //   .getTracks()
        //   .forEach((track) => pc2.addTrack(track, outgoingStream));
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
    }
    // If the client sends us an ICE candidate, add it to the peer connection
    else if (type === "ice-candidate") {
      const pc = pcs.get(from);
      if (pc && candidate) pc.addIceCandidate(candidate);
    }
  });

  // If the signaling connection closes unexpectedly, attempt to reconnect
  signaling.on("close", () => {
    console.warn("⚠️ Signaling connection closed. Attempting to reconnect...");

    scheduleReconnect();
  });

  // Handle signaling connection errors
  signaling.on("error", (err) => {
    console.error("❌ Signaling error:", err.message);
    signaling.close(); // Trigger close event to handle reconnect logic
  });
};

/**
 * Schedules a reconnection attempt using exponential backoff.
 * Example delays: 1s, 2s, 4s, 8s, 16s, up to 30s max.
 */
const scheduleReconnect = () => {
  // Avoid duplicate reconnect timers
  if (reconnectTimeout) return;

  // Exponential backoff delay, capped at 30 seconds
  const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts);
  console.log(`⏳ Reconnecting in ${delay / 1000}s...`);

  // Schedule reconnect attempt
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null; // Reset timer
    reconnectAttempts += 1; // Increase backoff
    connectSignaling(); // Try reconnecting
  }, delay);
};

// Start the initial connection
connectSignaling();
