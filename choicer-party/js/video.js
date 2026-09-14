// Video playback for the package clip. Choicer Voicer exports Theora in Ogg,
// and no shipping browser decodes Theora any more (Chrome/Edge dropped it in
// 2024, Firefox 130 followed, Safari never had it). So: try the native
// <video> first for anything else a volunteer might have used (WebM, MP4),
// and fall back to ogv.js, a JS/wasm Theora+Vorbis decoder that renders to a
// canvas and mimics enough of HTMLMediaElement for our needs.
//
// Both paths are muted: the dub replaces the clip's audio.

const OGV_VERSION = '1.9.0';
const OGV_BASE = `https://cdn.jsdelivr.net/npm/ogv@${OGV_VERSION}/dist`;

let ogvLoading = null;
function loadOgv() {
  if (window.OGVPlayer) return Promise.resolve();
  if (!ogvLoading) {
    ogvLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${OGV_BASE}/ogv.js`;
      s.onload = () => { window.OGVLoader.base = OGV_BASE; resolve(); };
      s.onerror = () => { ogvLoading = null; reject(new Error('could not load the ogv.js decoder')); };
      document.head.appendChild(s);
    });
  }
  return ogvLoading;
}

const MIME = {
  ogv: 'video/ogg; codecs="theora"', ogg: 'video/ogg; codecs="theora"',
  webm: 'video/webm', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
};

export class VideoPlayer {
  constructor(container) {
    this.container = container;
    this.el = null;         // HTMLVideoElement or OGVPlayer
    this.engine = null;     // 'native' | 'ogv'
    this.url = null;
    this.ok = false;
    this.reason = '';
    this._lastSeek = 0;
  }

  /** Load a clip blob. Resolves to { ok, engine, reason }. */
  async load(blob, name) {
    this.dispose();
    const ext = (name.split('.').pop() || '').toLowerCase();
    const mime = MIME[ext] || '';
    this.url = URL.createObjectURL(blob);

    // 1. native
    if (mime && document.createElement('video').canPlayType(mime)) {
      try {
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'auto';
        await new Promise((resolve, reject) => {
          v.onloadedmetadata = resolve;
          v.onerror = () => reject(new Error('native decode failed'));
          v.src = this.url;
        });
        if (v.videoWidth > 0) { this._mount(v, 'native'); return this._result(); }
      } catch { /* fall through to ogv */ }
    }

    // 2. ogv.js for Theora (and as a second chance for WebM/VP8/VP9)
    if (['ogv', 'ogg', 'webm'].includes(ext)) {
      try {
        await loadOgv();
        if (!window.OGVCompat?.supported('OGVPlayer')) throw new Error('ogv.js not supported here');
        const p = new window.OGVPlayer();
        p.muted = true;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('ogv.js metadata timeout')), 15000);
          p.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); });
          p.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ogv.js decode failed')); });
          p.src = this.url;
        });
        if (!(p.videoWidth > 0)) throw new Error('ogv.js found no video track');
        this._mount(p, 'ogv');
        return this._result();
      } catch (err) {
        this.reason = err.message;
      }
    } else {
      this.reason = `no decoder for .${ext}`;
    }
    this.ok = false;
    return this._result();
  }

  _mount(el, engine) {
    this.el = el; this.engine = engine; this.ok = true;
    el.hidden = true;
    el.classList.add('clip');
    this.container.appendChild(el);
  }

  _result() { return { ok: this.ok, engine: this.engine, reason: this.reason }; }

  get duration() { return this.el?.duration ?? 0; }
  get currentTime() { return this.el?.currentTime ?? 0; }
  get videoWidth() { return this.el?.videoWidth ?? 0; }
  get videoHeight() { return this.el?.videoHeight ?? 0; }
  get paused() { return this.el ? this.el.paused : true; }

  show(on) { if (this.el) this.el.hidden = !on; }

  /** Something drawImage() accepts: the <video>, or the canvas inside the ogv.js element. */
  frameSource() {
    if (!this.el) return null;
    if (this.engine === 'native') return this.el;
    return this.el.querySelector?.('canvas') || null;
  }

  /** Jump to `t` seconds (paused or playing). */
  seekTo(t) {
    if (!this.el) return;
    try { this.el.currentTime = Math.max(0, t); } catch { /* ogv before load */ }
    this._lastSeek = performance.now();
  }

  /** Seek to `t` and start playing there. */
  async playFrom(t = 0) {
    if (!this.el) return;
    this.seekTo(t);
    await this.el.play();
  }

  pause() { this.el?.pause(); }

  /**
   * Nudge the picture back onto the audio clock. Native seeks are cheap; an
   * ogv.js seek is a bisection over the Ogg pages, so it gets a wider
   * tolerance and a cool-down.
   */
  sync(t) {
    if (!this.el || this.el.paused) return;
    const drift = this.el.currentTime - t;
    const tol = this.engine === 'ogv' ? 0.3 : 0.09;
    const cooldown = this.engine === 'ogv' ? 3000 : 250;
    if (Math.abs(drift) > tol && performance.now() - this._lastSeek > cooldown) {
      this._lastSeek = performance.now();
      this.el.currentTime = t;
    }
  }

  dispose() {
    if (this.el) {
      try { this.el.pause(); } catch { /* ignore */ }
      if (this.engine === 'native') { this.el.removeAttribute('src'); this.el.load(); }
      this.el.remove();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.el = null; this.engine = null; this.url = null; this.ok = false; this.reason = '';
  }
}
