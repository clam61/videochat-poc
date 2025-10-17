import fs from "fs";
import Speaker from "speaker";

// PCM settings must match your raw audio
const speaker = new Speaker({
  channels: 1, // mono
  bitDepth: 16, // 16-bit PCM
  sampleRate: 16000, // 16 kHz
  signed: true, // signed PCM
  float: false, // not floating point
  endianness: "LE", // little endian
});

// Pipe the raw PCM file to the speaker
fs.createReadStream("test.raw").pipe(speaker);

speaker.on("close", () => {
  console.log("Finished playing");
});
