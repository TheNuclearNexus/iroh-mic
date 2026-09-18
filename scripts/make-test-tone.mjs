// Writes a mono 48 kHz 16-bit WAV sine tone for Chrome's
// --use-file-for-fake-audio-capture flag, so the microphone code path can be
// exercised with real (non-silent) samples in a headless browser.
import { writeFileSync } from "node:fs";

const sampleRate = 48000;
const seconds = 5;
const frequency = 440;
const amplitude = 0.3;
const out = process.argv[2] ?? "/tmp/iroh-mic-tone.wav";

const samples = sampleRate * seconds;
const pcm = Buffer.alloc(samples * 2);
for (let i = 0; i < samples; i++) {
  const value = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
  pcm.writeInt16LE(value, i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);

writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`wrote ${out} (${seconds}s ${frequency}Hz)`);
