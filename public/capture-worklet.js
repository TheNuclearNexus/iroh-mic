// Captures mono audio and emits 10 ms frames of Float32 PCM (480 samples at
// 48 kHz) to the main thread. Accumulating here keeps the message rate at
// ~100/s instead of one message per 128-sample render quantum.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = 480;
    this.buffer = new Float32Array(this.frameSize);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let i = 0;
      while (i < channel.length) {
        const n = Math.min(channel.length - i, this.frameSize - this.offset);
        this.buffer.set(channel.subarray(i, i + n), this.offset);
        this.offset += n;
        i += n;
        if (this.offset === this.frameSize) {
          this.port.postMessage(this.buffer.slice(0));
          this.offset = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
