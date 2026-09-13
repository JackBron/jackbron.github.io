// Recorder: one AudioContext shared by capture and playback so that every
// take is scheduled on the same clock as the playhead the performer watches.
//
//   const rec = new Recorder();
//   await rec.init();                 // after a user gesture
//   await rec.openMic();
//   const original = await rec.decode(line.wav);
//   const session = rec.record({ duration: line.duration, monitor: original });
//   const take = await session.done; // { samples, sampleRate, offset, ... }
//
// A Take is mono Float32 PCM at the context sample rate plus an `offset`
// (seconds) the performer can nudge later; `offset` is applied at mix time,
// the samples are never touched.

export class Recorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.micSource = null;
    this.capture = null;
    this.analyser = null;
    this._pending = null;
    this._playing = new Set();
    this._level = new Uint8Array(0);
  }

  get sampleRate() { return this.ctx?.sampleRate ?? 48000; }
  get now() { return this.ctx?.currentTime ?? 0; }
  get micOpen() { return !!this.stream; }

  async init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(new URL('./pcm-capture.worklet.js', import.meta.url));
    this.capture = new AudioWorkletNode(this.ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.capture.port.onmessage = (e) => {
      if (e.data.type === 'done' && this._pending) {
        const resolve = this._pending; this._pending = null;
        resolve(e.data.samples);
      }
    };
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async openMic() {
    await this.init();
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    this.micSource = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this._level = new Uint8Array(this.analyser.fftSize);
    this.micSource.connect(this.analyser);
    this.micSource.connect(this.capture);
  }

  closeMic() {
    if (!this.stream) return;
    for (const t of this.stream.getTracks()) t.stop();
    this.micSource?.disconnect();
    this.stream = null; this.micSource = null; this.analyser = null;
  }

  /** 0..1 RMS input level right now, for a meter. */
  inputLevel() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this._level);
    let sum = 0;
    for (let i = 0; i < this._level.length; i++) { const v = (this._level[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / this._level.length) * 3);
  }

  async decode(blob) {
    await this.init();
    return this.ctx.decodeAudioData(await blob.arrayBuffer());
  }

  /**
   * Arm a take. Capture runs from t0 = now + preroll for `duration + tail`
   * seconds; `monitor` (an AudioBuffer) is played from t0 through the speakers
   * when given, so a performer on headphones can hear the original.
   */
  record({ duration, preroll = 1.6, tail = 0.5, monitor = null, monitorGain = 1 }) {
    if (!this.stream) throw new Error('Microphone is not open');
    if (this._pending) throw new Error('A take is already in progress');
    const sr = this.ctx.sampleRate;
    const t0 = this.ctx.currentTime + preroll;
    const startFrame = Math.round(t0 * sr);
    const endFrame = startFrame + Math.round((duration + tail) * sr);

    let monitorSrc = null;
    if (monitor) monitorSrc = this.play(monitor, { at: t0, gain: monitorGain });

    const done = new Promise((resolve) => { this._pending = resolve; }).then((samples) => ({
      samples, sampleRate: sr, offset: 0, gain: 1,
      lineDuration: duration, tail, recordedAt: Date.now(),
    }));
    this.capture.port.postMessage({ type: 'arm', startFrame, endFrame });

    return {
      t0, duration, tail,
      done,
      stop: () => { this.capture.port.postMessage({ type: 'stop' }); monitorSrc?.stop(); },
    };
  }

  /** Play an AudioBuffer; returns the source so it can be stopped. */
  play(buffer, { at = null, offset = 0, gain = 1 } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.ctx.destination);
    const when = at ?? this.ctx.currentTime;
    // A negative offset means "start this buffer later", positive "skip into it".
    if (offset >= 0) src.start(when, Math.min(offset, buffer.duration));
    else src.start(when - offset);
    this._playing.add(src);
    src.onended = () => { this._playing.delete(src); src.disconnect(); g.disconnect(); };
    return src;
  }

  stopAll() {
    for (const s of this._playing) { try { s.stop(); } catch { /* already ended */ } }
    this._playing.clear();
  }

  /** Wrap a mono Take as an AudioBuffer on this context. */
  takeBuffer(take) {
    const buf = this.ctx.createBuffer(1, take.samples.length, take.sampleRate);
    buf.copyToChannel(take.samples, 0);
    return buf;
  }
}
