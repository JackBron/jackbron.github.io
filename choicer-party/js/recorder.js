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

import { encodeWav } from './wav.js';

// Decoding must not depend on the live AudioContext: under autoplay rules
// (Firefox especially) a context that is not yet allowed to start also holds
// back decodeAudioData, and the waveform would wait for the first Record.
// OfflineAudioContexts are not subject to the policy.
const decoders = new Map();
function decoderFor(rate) {
  if (!decoders.has(rate)) decoders.set(rate, new OfflineAudioContext(1, 1, rate));
  return decoders.get(rate);
}

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class Recorder {
  constructor() {
    this._unmuter = null;
    this.ctx = null;
    this.stream = null;
    this.deviceId = '';
    this.micSource = null;
    this.capture = null;
    this.analyser = null;
    this._ready = null;
    this._pending = null;
    this._playing = new Set();
    this._level = new Uint8Array(0);
  }

  get sampleRate() { return this.ctx?.sampleRate ?? 48000; }
  get now() { return this.ctx?.currentTime ?? 0; }
  get micOpen() { return !!this.stream; }
  get running() { return this.ctx?.state === 'running'; }

  /**
   * Create the context and kick off the worklet load. Synchronous on purpose
   * and ONLY ever called from inside a user gesture (click/tap/key handlers
   * and a page-wide first-interaction listener): a context created during
   * activation starts running everywhere, whereas resume() on one created
   * earlier is refused by some browsers. Never awaits resume().
   */
  unlock() {
    if (IS_IOS) this._unmuteIOS();
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this._ready = this.ctx.audioWorklet.addModule(new URL('./pcm-capture.worklet.js', import.meta.url)).then(() => {
        this.capture = new AudioWorkletNode(this.ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
        this.capture.port.onmessage = (e) => {
          if (e.data.type === 'chunk') {
            this._onChunk?.(e.data.samples);
          } else if (e.data.type === 'done' && this._pending) {
            const resolve = this._pending; this._pending = null;
            this._onChunk = null;
            resolve(e.data.samples);
          }
        };
        if (this.micSource) this.micSource.connect(this.capture);
      });
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /**
   * iOS mutes Web Audio while the ringer switch is on silent, but not media
   * elements. Playing a (silent) <audio> once switches WebKit's audio session
   * to playback mode, after which the AudioContext is audible too.
   */
  _unmuteIOS() {
    if (this._unmuter) return;
    try {
      const a = document.createElement('audio');
      a.setAttribute('playsinline', '');
      a.src = URL.createObjectURL(encodeWav([new Float32Array(800)], 8000));
      a.loop = false;
      a.play().catch(() => {});
      this._unmuter = a;
    } catch { /* not fatal */ }
  }

  /** Context + worklet ready. Does not require the context to be running. */
  async init() {
    this.unlock();
    await this._ready;
  }

  /** Audio input devices; labels are empty until the mic permission is granted. */
  async listMics() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  /**
   * Open the microphone, optionally a specific device. Browser voice
   * processing (echo cancellation, noise suppression, automatic gain) is left
   * on: phones in particular record very quietly without the AGC.
   */
  async openMic(deviceId = this.deviceId) {
    await this.init();
    if (this.stream && deviceId === this.deviceId) return;
    this.closeMic();
    const audio = { channelCount: { ideal: 1 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    this.deviceId = deviceId || '';
    this.micSource = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this._level = new Uint8Array(this.analyser.fftSize);
    this.micSource.connect(this.analyser);
    if (this.capture) this.micSource.connect(this.capture);
  }

  /** Label of the device actually in use, if the browser tells us. */
  activeMicLabel() {
    return this.stream?.getAudioTracks()[0]?.label || '';
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

  /** Decode without needing (or creating) the live context. */
  async decode(blob) {
    const rate = this.ctx?.sampleRate ?? 48000;
    return decoderFor(rate).decodeAudioData(await blob.arrayBuffer());
  }

  /**
   * Arm a take. Capture runs from t0 = now + preroll for `duration + tail`
   * seconds; `monitor` (an AudioBuffer) is played from t0 through the speakers
   * when given, so a performer on headphones can hear the original.
   */
  record({ duration, preroll = 1.6, tail = 0.5, monitor = null, monitorGain = 1, onChunk = null }) {
    if (!this.stream) throw new Error('Microphone is not open');
    if (!this.capture) throw new Error('Audio engine is still loading');
    if (this._pending) throw new Error('A take is already in progress');
    this.unlock();
    const sr = this.ctx.sampleRate;
    const t0 = this.ctx.currentTime + preroll;
    const startFrame = Math.round(t0 * sr);
    const endFrame = startFrame + Math.round((duration + tail) * sr);

    let monitorSrc = null;
    if (monitor) monitorSrc = this.play(monitor, { at: t0, gain: monitorGain });
    this._onChunk = onChunk; // Float32Array pieces, in order, as they are captured

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
