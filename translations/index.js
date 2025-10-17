// brew unlink node        # unlinks Node 24
// brew link --overwrite --force node@20

// brew unlink node@20
// brew link --overwrite --force node

// expat is keg-only, which means it was not symlinked into /opt/homebrew,
// because macOS already provides this software and installing another version in
// parallel can cause all kinds of trouble.

// If you need to have expat first in your PATH, run:
//   echo 'export PATH="/opt/homebrew/opt/expat/bin:$PATH"' >> /Users/chris-p/.zshrc

// For compilers to find expat you may need to set:
//   export LDFLAGS="-L/opt/homebrew/opt/expat/lib"
//   export CPPFLAGS="-I/opt/homebrew/opt/expat/include"

// For pkgconf to find expat you may need to set:
//   export PKG_CONFIG_PATH="/opt/homebrew/opt/expat/lib/pkgconfig"

// brew install git openssl pkg-config openssl homebrew/dupes/ncurses nss expat
// brew install ncurses
import fs from "fs";

// Create a writable stream
const file = fs.createWriteStream("test.raw");

import dotenv from "dotenv";
import { WebSocket } from "ws";
import avahqWrtc from "@avahq/wrtc"; // Node.js WebRTC implementation
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from "@aws-sdk/client-transcribe-streaming";
import { PassThrough } from "stream";
import {
  TranslateClient,
  TranslateTextCommand,
} from "@aws-sdk/client-translate";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";

// Extract WebRTC classes from the RTC libraries
const { RTCPeerConnection, RTCSessionDescription, MediaStream, nonstandard } =
  avahqWrtc;
const { RTCAudioSink, RTCAudioSource } = nonstandard;

dotenv.config(); // Load environment variables from .env file

// Create AWS client once
const transcribeClient = new TranscribeStreamingClient({
  region: "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.YOUR_SECRET_ACCESS_KEY,
  },
});

const translateClient = new TranslateClient({
  region: "us-west-2", // or whatever region your Transcribe/Polly setup uses
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.YOUR_SECRET_ACCESS_KEY,
  },
});

const pollyClient = new PollyClient({
  region: "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.YOUR_SECRET_ACCESS_KEY,
  },
});

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

const pcmStreamToTrack = (pcmStream) => {
  const source = new RTCAudioSource();
  const track = source.createTrack();

  const FRAME_SIZE_SAMPLES = 160; // 10ms @ 16kHz
  const BYTES_PER_SAMPLE = 2;
  const FRAME_SIZE_BYTES = FRAME_SIZE_SAMPLES * BYTES_PER_SAMPLE;

  let leftover = Buffer.alloc(0);

  pcmStream.on("data", (chunk) => {
    // Combine leftover + new chunk
    const buffer = Buffer.concat([leftover, chunk]);
    const totalFrames = Math.floor(buffer.length / FRAME_SIZE_BYTES);
    const validBytes = totalFrames * FRAME_SIZE_BYTES;
    leftover = buffer.subarray(validBytes);

    for (let i = 0; i < totalFrames; i++) {
      const frameStart = i * FRAME_SIZE_BYTES;
      const frame = buffer.subarray(frameStart, frameStart + FRAME_SIZE_BYTES);

      const int16Frame = new Int16Array(FRAME_SIZE_SAMPLES);
      for (let j = 0; j < FRAME_SIZE_SAMPLES; j++) {
        int16Frame[j] = frame.readInt16LE(j * BYTES_PER_SAMPLE);
      }

      source.onData({
        samples: int16Frame,
        sampleRate: 16000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: FRAME_SIZE_SAMPLES,
      });
    }
  });

  pcmStream.on("end", () => {
    // optional — if you ever want to close the track when done
    // track.stop();
  });

  return track;
};

const downsampleBuffer = (buffer, inputRate = 48000, outputRate = 16000) => {
  const sampleRatio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / sampleRatio);
  const result = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRatio);
    // simple average of samples in this window
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = accum / count;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
};

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
    const data = JSON.parse(msg);
    const { type, from, sdp, candidate, lang, to } = data;
    console.log(
      `On message type:${type}, from:${from}, to:${to}, lang:${lang}`
    );

    // set the language in a map if it exists
    if (lang) {
      languages.set(from, lang);

      for (const [key, value] of languages) {
        console.log("\t", key, "-", value);
      }
    }

    if (type === "pairing") {
      connections.set(from, to);
      connections.set(to, from);
    }
    // If a client wants to start a WebRTC connection, they send an "offer"
    else if (type === "offer") {
      // || type === "answer") {
      // set the connections mapping
      // if (type === "answer") {
      // connections.set(from, to);
      // } else {
      //   connections.set(to, from);
      // }

      const audioLanguage = languages.get(from);

      // Create a new peer connection for this client
      const pc = new RTCPeerConnection();

      // Store it in the map so we can reference it later (e.g., for ICE candidates)
      pcs.set(from, pc);

      // Create a new MediaStream for sending audio back to the client
      // const outgoingStream = new MediaStream();

      // When the client sends us audio tracks, this event fires
      pc.ontrack = (event) => {
        console.log(`Received audio track from ${from}`);

        // get the peer this user is connected to
        const pc2 = pcs.get(connections.get(from));

        const incomingStream = event.streams[0];
        const [audioTrack] = incomingStream.getAudioTracks();

        // Create an audio sink to capture PCM frames from the WebRTC track
        const sink = new RTCAudioSink(audioTrack);

        const audioStream = new PassThrough();

        // When frames arrive, push them into the stream
        sink.ondata = (data) => {
          // we get data as PCM-16 bit, but we need to downsize to 16000
          // as most devices send higher quality
          const resampled = downsampleBuffer(
            data.samples,
            data.sampleRate,
            16000
          );
          const buffer = Buffer.from(resampled.buffer);
          audioStream.write(buffer);
        };

        // sink.ondata = (data) => {
        //   // data.samples is a Float32Array, convert to PCM16 for AWS
        //   const buffer = Buffer.alloc(data.samples.length * 2);
        //   for (let i = 0; i < data.samples.length; i++) {
        //     const s = Math.max(-1, Math.min(1, data.samples[i]));
        //     //buffer.writeInt16LE(s * 0x7fff, i * 2);
        //     buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2);
        //   }
        //   //audioStream.write(buffer);
        //   file.write(buffer);
        // };

        // When the track ends, close the stream
        audioTrack.onended = () => {
          console.log("Audio track ended");
          sink.stop();
          audioStream.end();
        };

        // Send the stream to AWS Transcribe
        const startAwsTranscribe = async (pcmStream, language) => {
          console.log("Start AWS transcribe for language", language);
          const command = new StartStreamTranscriptionCommand({
            LanguageCode: language, // or auto-detect if supported
            MediaEncoding: "pcm",
            MediaSampleRateHertz: 16000, // or 16000 depending on your input
            AudioStream: (async function* () {
              for await (const chunk of pcmStream) {
                yield { AudioEvent: { AudioChunk: chunk } };
              }
            })(),
          });

          try {
            const response = await transcribeClient.send(command);
            for await (const event of response.TranscriptResultStream) {
              if (event.TranscriptEvent) {
                const results = event.TranscriptEvent.Transcript.Results;
                for (const result of results) {
                  // if the result is final
                  if (!result.IsPartial) {
                    // now translate to the target language
                    const transcript = result.Alternatives[0].Transcript;
                    console.log("Final transcript:", transcript);

                    // get source language
                    const sourceLanguage = languages.get(from);
                    // get target language
                    // const targetLanguage = languages.get(connections.get(from))
                    const targetLanguage = "es-mx";

                    const command = new TranslateTextCommand({
                      Text: transcript,
                      SourceLanguageCode: sourceLanguage.split("-")[0],
                      TargetLanguageCode: targetLanguage.split("-")[0],
                    });

                    const response = await translateClient.send(command);

                    console.log("Translated:", response.TranslatedText);

                    // now convert to audio
                    const synthSpeechCommand = new SynthesizeSpeechCommand({
                      OutputFormat: "pcm", // PCM audio suitable for streaming over WebRTC
                      VoiceId: "Lucia", // Spanish voice
                      SampleRate: "16000",
                      LanguageCode: languages.get(connections.get(from)),
                      Text: response.TranslatedText,
                    });

                    const synthSpeechResponse = await pollyClient.send(
                      synthSpeechCommand
                    );

                    console.log("Got synth response");

                    // response.AudioStream is a readable stream of PCM audio
                    // convert it to a track
                    const translatedSynthTrack = pcmStreamToTrack(
                      synthSpeechResponse.AudioStream
                    );

                    // get the peer this user is connected to
                    const peer = connections.get(from);
                    console.log("Peer of", from, "is", peer);

                    if (peer) {
                      // get peer's connection
                      const peerConn = pcs.get(peer);

                      console.log("Peer's conn?", !!peerConn);
                      console.log("Synth track", !!translatedSynthTrack);
                      // send audio to peer
                      peerConn?.addTrack(translatedSynthTrack);
                    }
                  }
                }
              }
            }
          } catch (err) {
            console.error("Transcribe error:", err);
          }
        };
        startAwsTranscribe(audioStream, audioLanguage);

        // Forward each incoming audio track into our outgoing stream
        // (This is where you could do audio processing/translation)
        // incomingStream.getAudioTracks().forEach((track) => {
        //   outgoingStream.addTrack(track);
        // });

        // no peer connection then return
        //if (!pc2) return;

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
