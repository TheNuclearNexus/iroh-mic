// Plays received Int16 PCM frames through a ring buffer and reports the
// measured output RMS so the UI can prove audio is actually non-silent.
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 32768; // ~0.68 s at 48 kHz
    this.ring = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.frames = 0;
    this.rmsAcc = 0;
    this.rmsN = 0;
    this.port.onmessage = (event) => {
      const pcm = new Int16Array(event.data);
      for (let i = 0; i < pcm.length; i++) {
        this.ring[this.write] = pcm[i] / 32768;
        this.write = (this.write + 1) % this.size;
      }
      this.available += pcm.length;
      if (this.available > this.size) {
        // Buffer overflow: drop the oldest audio, keep latency bounded.
        this.available = this.size;
        this.read = this.write;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      let sample = 0;
      if (this.available > 0) {
        sample = this.ring[this.read];
        this.read = (this.read + 1) % this.size;
        this.available--;
      }
      out[i] = sample;
      this.rmsAcc += sample * sample;
      this.rmsN++;
    }
    this.frames++;
    if (this.frames >= 10) {
      const rms = this.rmsN ? Math.sqrt(this.rmsAcc / this.rmsN) : 0;
      this.port.postMessage({ rms, bufferedSamples: this.available });
      this.frames = 0;
      this.rmsAcc = 0;
      this.rmsN = 0;
    }
    return true;
  }
}

registerProcessor("playback", PlaybackProcessor);
