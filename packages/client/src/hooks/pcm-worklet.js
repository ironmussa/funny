/**
 * AudioWorklet processor for real-time dictation.
 *
 * Runs in the AudioWorkletGlobalScope (separate thread). Receives float32
 * mic samples in 128-frame render quanta, converts them to PCM16, and buffers
 * up to `BUFFER_SIZE` samples before posting a chunk to the main thread —
 * matching the chunk size the old ScriptProcessorNode used (2048) so the WS
 * message rate stays the same.
 */

const BUFFER_SIZE = 2048;

class PCMProcessor extends AudioWorkletProcessor {
  #buf;
  #off;

  constructor() {
    super();
    this.#buf = new Int16Array(BUFFER_SIZE);
    this.#off = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.#buf[this.#off++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.#off === this.#buf.length) {
        // Transfer a copy so this.#buf can keep filling.
        const out = this.#buf.slice(0);
        this.port.postMessage(out.buffer, [out.buffer]);
        this.#off = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
