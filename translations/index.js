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

// A map to hold a promise that resolves when the server's track is added
const trackResolveFunctions = new Map();

// Map to store active peer connections; key = client ID, value = RTCPeerConnection instance
const pcs = new Map();

// Map to store offers
const offers = new Map();

// Map to store ice candidates
const iceCandidates = new Map();

// Function to add an item under a key
const addIceCandidate = (peer, iceCandidate) => {
  if (!iceCandidates.has(peer)) {
    iceCandidates.set(peer, []);
  }
  iceCandidates.get(peer).push(iceCandidate);
};

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

      // for (const [key, value] of languages) {
      //   console.log("\t", key, "-", value);
      // }
    }

    if (type === "pairing") {
      connections.set(from, to);
      connections.set(to, from);

      const pc1 = pcs.get(from);
      const pc2 = pcs.get(to);

      if (!pc1 || !pc2) {
        console.error("One or more connection in pairing is missing");
        return;
      }

      const peers = [to, from];

      const trackPromises = [];
      // Create promises for both ontrack handlers
      for (const peer of peers) {
        let resolveTrackPromise;
        const trackPromise = new Promise((resolve) => {
          resolveTrackPromise = resolve;
        });
        trackResolveFunctions.set(peer, resolveTrackPromise);
        trackPromises.push(trackPromise);
      }

      // Set remote descriptions for both peers
      for (const peer of peers) {
        const pc = pcs.get(peer);
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: "offer", sdp: offers.get(peer) })
        );
        offers.delete(peer);
      }

      // Wait for both ontrack handlers to complete
      await Promise.all(trackPromises);

      // Now proceed with creating and exchanging answers
      for (const peer of peers) {
        const pc = pcs.get(peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const iceCands = iceCandidates.get(peer);
        if (iceCands) {
          iceCands.forEach((candidate) => pc.addIceCandidate(candidate));
          iceCandidates.delete(peer);
        }

        signaling.send(
          JSON.stringify({
            type: "answer",
            sdp: answer.sdp,
            from: "translation-server",
            to: peer,
          })
        );
      }

      /*
      //peers.forEach(async (peer) => {
      for (const peer of peers) {
        // Get the peer connection
        const pc = pcs.get(peer);

        console.log("SET REMOTE FOR", peer);
        // set remote description with offer
        // this will trigger the ontrack event
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: "offer", sdp: offers.get(peer) })
        );

        // delete offer to free
        offers.delete(peer);

        // Wait for the ontrack handler to finish replacing the transceiver track
        // before creating the answer. Otherwise it will produce an answer with recvonly
        await trackAddedPromises.get(peer).promise;

        console.log("Got pc for pairing peer", !!pc);
        // Create our answer SDP (describes what the translation server can send/receive)
        const answer = await pc.createAnswer();

        //answer.sdp = answer.sdp.replace(/a=recvonly/g, "a=sendrecv");
        console.log("ANSWER", answer);

        // Set the answer as our local description (required before sending it back)
        await pc.setLocalDescription(answer);

        // Add all ice candidates
        iceCandidates
          .get(peer)
          .forEach((candidate) => pc.addIceCandidate(candidate));

        // delete from map to free up
        iceCandidates.delete(peer);

        // Send the SDP answer back to the client via signaling server
        signaling.send(
          JSON.stringify({
            type: "answer",
            sdp: answer.sdp,
            from: "translation-server",
            to: peer,
          })
        );
        console.log(`Sent answer to ${peer}`);
      }
      */
    }
    // If a client wants to start a WebRTC connection, they send an "offer"
    // this is peer 1
    else if (type === "offer") {
      // store offer for later
      offers.set(from, sdp);

      // Create a new peer connection for this peer
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      //pc.addTransceiver("audio", { direction: "sendrecv" });

      /*
      ////// stupid SHIT

      //console.log("Add transceiver", peer);
      const audioTransceiver = pc.addTransceiver("audio", {
        direction: "sendrecv",
        send: true,
        receive: true,
      });

      // Attach a silent dummy track so when we createAnswer()
      // for this connection so the answer is sendrcv
      const dummyTrack = new RTCAudioSource().createTrack();
      await audioTransceiver.sender.replaceTrack(dummyTrack);

      console.log("Sender track:", audioTransceiver.sender.track);
      console.log("Sender enabled:", audioTransceiver.sender.track?.enabled);

      console.log(
        "AUDIO TRANS",
        audioTransceiver.direction,
        audioTransceiver.currentDirection,
        audioTransceiver.sender
      );

      ////// stupid SHIT
      */

      // Store it in the map so we can reference it later (e.g., for ICE candidates)
      pcs.set(from, pc);

      pc.onicegatheringstatechange = () => {
        console.log("ICE gathering state:", pc.iceGatheringState);
      };

      pc.onconnectionstatechange = () => {
        console.log("Connection state:", from, pc.connectionState);
        if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
          // redundant for close, but harmless. needed for other states
          pc.close();

          pcs.delete(from);

          languages.delete(from);
          connections.delete(from);
          trackResolveFunctions.delete(from);
        }
      };

      // When the peer1 sends us audio tracks, this event fires
      pc.ontrack = async (event) => {
        // console.log(
        //   "Event has a transceiver?",
        //   event.transceiver.direction,
        //   event.transceiver.currentDirection,
        //   event.transceiver.sender,
        //   event.transceiver.sender?.track
        // );
        console.log(`Received audio track from ${from}`);

        // get who this track should be sent to
        const peer2 = connections.get(from);

        // Get the connection for peer 2
        const pc2 = pcs.get(peer2);

        const incomingStream = event.streams[0];
        const [audioTrack] = incomingStream.getAudioTracks();

        // Create an audio sink to capture PCM frames from the WebRTC track
        const sink = new RTCAudioSink(audioTrack);

        // Create a stream to hold the resampled audio from peer 1
        const downsampledAudioStream = new PassThrough();

        // Create an audio source for peer #2
        const pc2Source = new RTCAudioSource();
        const pc2OutTrack = pc2Source.createTrack();

        // const pc2Sender = pc2
        //   .getSenders()
        //   .find((s) => s.track?.kind === "audio");
        // await pc2Sender.replaceTrack(pc2OutTrack);
        // pc2Sender.transceiver.direction = "sendrecv";

        /*
        console.log("Transceivers", pc2.getTransceivers().length);
        for (const t of pc2.getTransceivers()) {
          console.log("Transceiver");
          if (!t.sender) {
            console.log("  Transceiver no sender");
            break;
          }
          if (!t.sender.track) {
            console.log("  Transceiver no sende trackr");
            break;
          }
          if (!t.sender.track.kind) {
            console.log("  No tranceivers sender track kind");
            break;
          }
          console.log(t.sender.track.kind);
        }
        */
        // const audioTransceiver2 = pc2
        //   .getTransceivers()
        //   .find((t) => t.sender?.track?.kind === "audio");

        // if (audioTransceiver2) {
        //   console.log("Audio transceiver:", {
        //     mid: audioTransceiver2.mid,
        //     direction: audioTransceiver2.direction,
        //     currentDirection: audioTransceiver2.currentDirection,
        //     receiverTrack: audioTransceiver2.receiver.track,
        //     senderTrack: audioTransceiver2.sender.track,
        //     receiverTrackState: audioTransceiver2.receiver.track?.readyState,
        //   });
        // } else {
        //   console.log("No audio transceiver found");
        // }

        // console.log("Transceivers", pc2.getTransceivers().length);
        // const audioTransceiver = pc2.getTransceivers()[0];
        // .find(
        //   (t) => t.sender && t.sender.track && t.sender.track.kind === "audio"
        // );
        // console.log("Got audo trans", !!audioTransceiver);
        // console.log(
        //   "before replace",
        //   audioTransceiver2.sender.track === pc2OutTrack
        // );

        // await event.transceiver.sender.replaceTrack(pc2OutTrack);
        // event.transceiver.direction = "sendrecv";

        // console.log(
        //   "after replace",
        //   audioTransceiver2.sender.track === pc2OutTrack
        // );

        // Add the track to pc2 so peer #2 will receive it
        const outStream = new MediaStream();
        outStream.addTrack(pc2OutTrack);
        pc2.addTrack(pc2OutTrack, outStream);

        // Resolve the promise to signal that the track is ready.
        if (trackResolveFunctions.has(from)) {
          trackResolveFunctions.get(from)(); // Directly call the resolve function
          trackResolveFunctions.delete(from);
        }

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
          downsampledAudioStream.write(buffer);
        };

        // When the track ends, close the stream
        audioTrack.onended = () => {
          console.log("Audio track ended");
          sink.stop();
          downsampledAudioStream.end();
        };

        // Send the stream to AWS Transcribe
        const startAwsTranscribe = async (pcmStream) => {
          // get source language
          const sourceLanguage = languages.get(from);
          // get target language of your peer
          const targetLanguage = languages.get(peer2);

          console.log(
            "Start AWS transcribe for language",
            from,
            sourceLanguage,
            targetLanguage
          );
          const command = new StartStreamTranscriptionCommand({
            LanguageCode: sourceLanguage, // or auto-detect if supported
            MediaEncoding: "pcm",
            MediaSampleRateHertz: 16000, // or 16000 depending on your input
            AudioStream: (async function* () {
              for await (const chunk of pcmStream) {
                yield { AudioEvent: { AudioChunk: chunk } };
              }
            })(),
          });
          // find a wau to send dummy data

          //           const silence = Buffer.alloc(320 * 2); // 20ms of silence @16kHz mono
          // if (Date.now() - lastAudioTime > 5000) {
          //   transcribeStream.sendAudioEvent({ AudioChunk: silence });
          // }
          while (true) {
            console.log(from, "Transcribe loop begin....");
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
                      console.log(
                        from,
                        "*** Final transcript:",
                        sourceLanguage,
                        transcript
                      );

                      let textToSynth;
                      if (sourceLanguage === targetLanguage) {
                        textToSynth = transcript;
                      } else {
                        const command = new TranslateTextCommand({
                          Text: transcript,
                          SourceLanguageCode: sourceLanguage.split("-")[0],
                          TargetLanguageCode: targetLanguage.split("-")[0],
                        });

                        const response = await translateClient.send(command);

                        console.log(
                          from,
                          "***    ↳ Translated:",
                          sourceLanguage,
                          " -> ",
                          targetLanguage,
                          response.TranslatedText
                        );
                        textToSynth = response.TranslatedText;
                      }

                      let voiceId;

                      if (targetLanguage === "es-US") {
                        voiceId = "Lupe";
                      } else if (targetLanguage === "en-US") {
                        voiceId = "Joanna";
                      } else if (targetLanguage === "ru-RU") {
                        voiceId = "Tatyana";
                      } else if (targetLanguage === "ko-KR") {
                        voiceId = "Seoyeon";
                      } else {
                        voiceId = "Joanna";
                      }

                      // now convert to audio
                      const synthSpeechCommand = new SynthesizeSpeechCommand({
                        OutputFormat: "pcm", // PCM audio suitable for streaming over WebRTC
                        VoiceId: voiceId,
                        SampleRate: "16000",
                        LanguageCode: targetLanguage,
                        Text: textToSynth,
                      });

                      const synthSpeechResponse = await pollyClient.send(
                        synthSpeechCommand
                      );

                      console.log(from, "***      ↳ Got synth voice response");

                      const CHUNK_FRAMES = 160; // 10ms @ 16kHz
                      const BYTES_PER_SAMPLE = 2;
                      let leftover = new Int16Array(0);

                      synthSpeechResponse.AudioStream.on("data", (chunk) => {
                        const sampleCount = chunk.length / BYTES_PER_SAMPLE;
                        const newSamples = new Int16Array(sampleCount);

                        for (let i = 0; i < sampleCount; i++) {
                          newSamples[i] = chunk.readInt16LE(
                            i * BYTES_PER_SAMPLE
                          );
                        }

                        // Combine with leftover
                        const allSamples = new Int16Array(
                          leftover.length + newSamples.length
                        );
                        allSamples.set(leftover, 0);
                        allSamples.set(newSamples, leftover.length);

                        let offset = 0;
                        while (offset + CHUNK_FRAMES <= allSamples.length) {
                          // Copy the chunk into a new Int16Array (important!)
                          const frameSamples = new Int16Array(CHUNK_FRAMES);
                          frameSamples.set(
                            allSamples.subarray(offset, offset + CHUNK_FRAMES)
                          );

                          pc2Source.onData({
                            samples: frameSamples,
                            sampleRate: 16000,
                            bitsPerSample: 16,
                            channelCount: 1,
                            numberOfFrames: CHUNK_FRAMES,
                          });

                          offset += CHUNK_FRAMES;
                        }

                        // Save leftover
                        leftover = allSamples.subarray(offset);
                      });
                    }
                  }
                }
              }
            } catch (err) {
              console.error(from, "Transcribe error:", err);
            }
          }
        };

        startAwsTranscribe(downsampledAudioStream);
      };

      // When this peer connection generates ICE candidates (network info)
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          console.log("Got ICE candidate for", from);
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
    }
    // If the client sends us an ICE candidate, add it to the peer connection
    else if (type === "ice-candidate") {
      // store for later
      addIceCandidate(from, candidate);
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
