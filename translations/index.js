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
// translation-server.fixed.js
// translation-server.js
// translation-server.js
import dotenv from "dotenv";
dotenv.config();

import avahqWrtc from "@avahq/wrtc";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
} from "@aws-sdk/client-transcribe-streaming";
import { TranslateClient, TranslateTextCommand } from "@aws-sdk/client-translate";
import { PassThrough } from "stream";
import { WebSocket } from "ws";

const { RTCPeerConnection, RTCSessionDescription, nonstandard } = avahqWrtc;
const { RTCAudioSink, RTCAudioSource } = nonstandard;

const SIGNAL_URL = process.env.SIGNAL_SERVER;
const AWS_REGION = process.env.AWS_REGION || "us-west-2";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

if (!SIGNAL_URL) throw new Error("Set SIGNAL_SERVER env");
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY)
  throw new Error("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in env");

// --- AWS clients ---
const transcribeClient = new TranscribeStreamingClient({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});
const translateClient = new TranslateClient({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});
const pollyClient = new PollyClient({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});

// Maps to track resources per client
const pcs = new Map(); // clientId -> RTCPeerConnection
const sinks = new Map(); // clientId -> RTCAudioSink
const audioSources = new Map(); // clientId -> RTCAudioSource (for sending TTS)
const languages = new Map(); // clientId -> language string (e.g., 'en-US')

// Connect to signaling server (simple WS client)
let signaling = null;
const connectSignaling = () => {
  signaling = new WebSocket(SIGNAL_URL);

  signaling.on("open", () => {
    console.log("[signal] connected");
    signaling.send(JSON.stringify({ type: "join", from: "translation-server" }));
  });

  signaling.on("message", async (m) => {
    try {
      const data = JSON.parse(m.toString());
      const { type, from, sdp, candidate, lang } = data;

      if (lang && from) {
        languages.set(from, lang);
      }

      if (type === "offer" && from) {
        console.log("[signal] offer from", from, "lang:", languages.get(from));
        await handleOffer(from, sdp);
      } else if (type === "ice-candidate" && from && candidate) {
        const pc = pcs.get(from);
        if (pc) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            console.warn("addIceCandidate err:", err);
          }
        }
      }
    } catch (err) {
      console.error("[signal] message parse error", err);
    }
  });

  signaling.on("close", () => {
    console.warn("[signal] closed, reconnecting in 2s...");
    setTimeout(connectSignaling, 2000);
  });

  signaling.on("error", (e) => {
    console.error("[signal] error", e);
    try {
      signaling.close();
    } catch {}
  });
};

// Handle incoming offer from client -> create PC, add outgoing TTS track before answer
async function handleOffer(clientId, offerSdp) {
  // Create PC
  const pc = new RTCPeerConnection();
  pcs.set(clientId, pc);

  // Create (and store) one RTCAudioSource per client to reuse for all TTS chunks
  const audioSource = new RTCAudioSource();
  audioSources.set(clientId, audioSource);
  const ttsTrack = audioSource.createTrack();
  // Add track BEFORE createAnswer so answer SDP contains our send capability
  pc.addTrack(ttsTrack);

  // Clean-up helper
  const cleanup = () => {
    try {
      ttsTrack.stop();
    } catch {}
    try {
      audioSources.delete(clientId);
    } catch {}
    const s = sinks.get(clientId);
    if (s)
      try {
        s.stop();
      } catch {}
    sinks.delete(clientId);
    pcs.delete(clientId);
    languages.delete(clientId);
  };

  // ICE candidate -> send back to client via signaling server
  pc.onicecandidate = (e) => {
    if (e.candidate && signaling && signaling.readyState === WebSocket.OPEN) {
      signaling.send(
        JSON.stringify({
          type: "ice-candidate",
          candidate: e.candidate,
          from: "translation-server",
          to: clientId,
        })
      );
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[pc ${clientId}] state:`, pc.connectionState);
    if (
      pc.connectionState === "closed" ||
      pc.connectionState === "failed" ||
      pc.connectionState === "disconnected"
    ) {
      cleanup();
    }
  };

  // When client sends audio -> create sink and stream to Transcribe
  pc.ontrack = (ev) => {
    console.log(`[pc ${clientId}] ontrack got streams count:`, ev.streams.length);
    const incomingStream = ev.streams[0];
    if (!incomingStream) return;
    const [audioTrack] = incomingStream.getAudioTracks();
    if (!audioTrack) return;

    // create sink for that track
    const sink = new RTCAudioSink(audioTrack);
    sinks.set(clientId, sink);

    // Create PassThrough that will receive PCM16LE frames at 16k
    const pcmStream = new PassThrough();

    sink.ondata = (d) => {
      // d.samples may be Float32Array or Int16Array
      let int16Buffer;
      if (d.samples instanceof Float32Array) {
        // convert float32 [-1,1] -> int16
        const f = d.samples;
        const tmp = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) {
          const s = Math.max(-1, Math.min(1, f[i]));
          tmp[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        int16Buffer = Buffer.from(tmp.buffer);
      } else if (d.samples instanceof Int16Array) {
        int16Buffer = Buffer.from(d.samples.buffer);
      } else {
        // fallback
        int16Buffer = Buffer.from(d.samples.buffer || d.samples);
      }

      const sampleRate = d.sampleRate || 48000;
      if (sampleRate !== 16000) {
        const int16 = new Int16Array(
          int16Buffer.buffer,
          int16Buffer.byteOffset,
          int16Buffer.byteLength / 2
        );
        const down = simpleDownsampleInt16(int16, sampleRate, 16000);
        pcmStream.write(Buffer.from(down.buffer));
      } else {
        pcmStream.write(int16Buffer);
      }
    };

    audioTrack.onended = () => {
      console.log(`[pc ${clientId}] audioTrack ended`);
      try {
        sink.stop();
      } catch {}
      pcmStream.end();
    };

    // Spawn the transcribe->translate->polly pipeline
    startAwsTranscribePipeline(pcmStream, clientId).catch((err) =>
      console.error("transcribe pipeline error", err)
    );
  };

  // Set remote description from client
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: offerSdp }));

  // Create and set local answer (we already added ttsTrack so answer includes send capability)
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // send answer back via signaling server
  if (signaling && signaling.readyState === WebSocket.OPEN) {
    signaling.send(
      JSON.stringify({
        type: "answer",
        sdp: answer.sdp,
        from: "translation-server",
        to: clientId,
      })
    );
    console.log(`[signal] sent answer to ${clientId}`);
  }
}

// Simple downsample of Int16Array
function simpleDownsampleInt16(inputInt16, inputRate, outputRate) {
  if (outputRate === inputRate) return inputInt16;
  const sampleRatio = inputRate / outputRate;
  const newLength = Math.round(inputInt16.length / sampleRatio);
  const out = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLength) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRatio);
    let acc = 0,
      count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < inputInt16.length; i++) {
      acc += inputInt16[i];
      count++;
    }
    out[offsetResult] = count ? Math.round(acc / count) : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return out;
}

// Convert arbitrary stream/Uint8Array to Buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    if (!stream) return resolve(Buffer.alloc(0));
    if (stream instanceof Uint8Array) return resolve(Buffer.from(stream));
    const chunks = [];
    stream.on?.("data", (c) => chunks.push(Buffer.from(c)));
    stream.on?.("end", () => resolve(Buffer.concat(chunks)));
    stream.on?.("error", (e) => reject(e));
  });
}

// Buffering function to feed chunks of 320 bytes (10ms @16k) into RTCAudioSource.onData
function feedAudioBufferToSource(audioSource, buffer) {
  // buffer is Buffer of PCM16LE at 16000Hz
  const BYTES_PER_FRAME = 160 * 2; // 160 samples * 2 bytes
  // keep leftover between calls
  if (!audioSource._leftover) audioSource._leftover = Buffer.alloc(0);
  let combined = Buffer.concat([audioSource._leftover, buffer]);
  const frames = Math.floor(combined.length / BYTES_PER_FRAME);
  const usedBytes = frames * BYTES_PER_FRAME;
  const leftover = combined.subarray(usedBytes);
  audioSource._leftover = Buffer.from(leftover);

  for (let i = 0; i < frames; i++) {
    const start = i * BYTES_PER_FRAME;
    const frameBuf = combined.subarray(start, start + BYTES_PER_FRAME);
    const int16 = new Int16Array(BYTES_PER_FRAME / 2);
    for (let j = 0; j < int16.length; j++) {
      int16[j] = frameBuf.readInt16LE(j * 2);
    }
    audioSource.onData({
      samples: int16,
      sampleRate: 16000,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: 160,
    });
  }
}

// Main pipeline: stream PCM -> AWS Transcribe Streaming -> Translate -> Polly -> push to client RTCAudioSource
// Main pipeline: stream PCM -> AWS Transcribe Streaming -> Translate -> Polly -> push to client RTCAudioSource
async function startAwsTranscribePipeline(pcmStream, clientId) {
  const language = languages.get(clientId) || "en-US";
  console.log(`[transcribe] start for ${clientId} lang=${language}`);

  const command = new StartStreamTranscriptionCommand({
    LanguageCode: language,
    MediaEncoding: "pcm",
    MediaSampleRateHertz: 16000,
    AudioStream: (async function* () {
      for await (const chunk of pcmStream) {
        yield { AudioEvent: { AudioChunk: chunk } };
      }
    })(),
  });

  const resp = await transcribeClient.send(command);

  for await (const event of resp.TranscriptResultStream) {
    if (event.TranscriptEvent) {
      for (const r of event.TranscriptEvent.Transcript.Results) {
        if (!r.IsPartial && r.Alternatives && r.Alternatives[0]) {
          const text = r.Alternatives[0].Transcript;
          console.log(`[transcribe][${clientId}] final:`, text);

          // Choose target language: for demo, translate to Spanish (es) if source is English, else to English.
          const srcLangCode = (language || "en-US").split("-")[0];
          const targetLangCode = srcLangCode === "en" ? "es" : "en";

          // Translate
          const tr = await translateClient.send(
            new TranslateTextCommand({
              Text: text,
              SourceLanguageCode: srcLangCode,
              TargetLanguageCode: targetLangCode,
            })
          );
          const translatedText = tr.TranslatedText;
          console.log(`[translate] ->`, translatedText);

          // Send translated text to signaling server
          if (signaling && signaling.readyState === WebSocket.OPEN) {
            signaling.send(
              JSON.stringify({
                type: "translation-text",
                from: "translation-server",
                to: clientId,
                text: translatedText,
              })
            );
          }

          // Polly synth
          const voice = targetLangCode === "es" ? "Lucia" : "Joanna";
          const synth = await pollyClient.send(
            new SynthesizeSpeechCommand({
              OutputFormat: "pcm",
              Text: translatedText,
              VoiceId: voice,
              SampleRate: "16000",
            })
          );

          // normalize AudioStream -> buffer
          const audioBuf = await streamToBuffer(synth.AudioStream);
          if (!audioBuf || audioBuf.length === 0) continue;

          // find audioSource for client
          const audioSource = audioSources.get(clientId);
          if (!audioSource) {
            console.warn("No audioSource for client:", clientId);
            continue;
          }

          // Feed the buffer to the audioSource in 320-byte frames
          feedAudioBufferToSource(audioSource, audioBuf);
        }
      }
    }
  }
}

// start
connectSignaling();
