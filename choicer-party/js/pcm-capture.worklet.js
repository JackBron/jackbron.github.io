// AudioWorklet processor that captures raw microphone PCM between two
// absolute frame positions on the AudioContext clock.
//
// The main thread schedules the reference playback / playhead to begin at
// time t0 and tells this node the matching startFrame = round(t0 * sampleRate).
// Because `currentFrame` here is the same clock the scheduled playback runs
// on, the captured samples line up with the line to the sample, without the
// variable start latency MediaRecorder would add.

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.startFrame = 0;
    this.endFrame = 0;
    this.chunks = [];
    this.live = [];        // chunks not yet streamed to the main thread
    this.liveLen = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'arm') {
        this.startFrame = msg.startFrame;
        this.endFrame = msg.endFrame;
        this.chunks = [];
        this.live = []; this.liveLen = 0;
        this.armed = true;
      } else if (msg.type === 'stop') {
        this.finish();
      }
    };
  }

  process(inputs) {
    if (!this.armed) return true;
    const input = inputs[0];
    if (!input || !input.length) return true;

    const n = input[0].length;
    const blockStart = currentFrame;
    const blockEnd = blockStart + n;
    if (blockEnd <= this.startFrame) return true;

    const from = Math.max(0, this.startFrame - blockStart);
    const to = Math.min(n, this.endFrame - blockStart);
    if (to > from) {
      // Fold to mono: a voice is one source and it halves what we ship later.
      const out = new Float32Array(to - from);
      const scale = 1 / input.length;
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = from; i < to; i++) out[i - from] += ch[i] * scale;
      }
      this.chunks.push(out);
      this.live.push(out); this.liveLen += out.length;
      // Stream roughly every 1024 frames so the waveform grows as it is sung.
      if (this.liveLen >= 1024) this.flushLive();
    }
    if (blockEnd >= this.endFrame) this.finish();
    return true;
  }

  flushLive() {
    if (!this.liveLen) return;
    const out = new Float32Array(this.liveLen);
    let o = 0;
    for (const c of this.live) { out.set(c, o); o += c.length; }
    this.live = []; this.liveLen = 0;
    this.port.postMessage({ type: 'chunk', samples: out }, [out.buffer]);
  }

  finish() {
    if (!this.armed) return;
    this.armed = false;
    this.live = []; this.liveLen = 0;
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const all = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = [];
    this.port.postMessage({ type: 'done', samples: all }, [all.buffer]);
  }
}

registerProcessor('pcm-capture', PcmCapture);
