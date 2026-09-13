// Waveform view: layered min/max peak drawings over one time axis with a
// playhead. The static layers are rendered once to an offscreen canvas and
// re-blitted each frame, so the sweep costs one drawImage and a line.

export function computePeaks(samples, sampleRate, columns, { from = 0, to = null } = {}) {
  const total = samples.length;
  const startS = Math.max(0, Math.floor(from * sampleRate));
  const endS = to == null ? total : Math.min(total, Math.floor(to * sampleRate));
  const span = Math.max(1, endS - startS);
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  let peak = 0;
  for (let c = 0; c < columns; c++) {
    const a = startS + Math.floor((c / columns) * span);
    const b = Math.max(a + 1, startS + Math.floor(((c + 1) / columns) * span));
    let lo = 0, hi = 0;
    for (let i = a; i < b && i < total; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo; max[c] = hi;
    if (-lo > peak) peak = -lo;
    if (hi > peak) peak = hi;
  }
  return { min, max, peak };
}

export function monoSamples(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i] / buffer.numberOfChannels;
  }
  return out;
}

export class WaveformView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts  colors + layout
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = {
      background: '#14110f',
      tailFill: 'rgba(255,255,255,0.04)',
      grid: 'rgba(255,255,255,0.08)',
      playhead: '#fff',
      progress: 'rgba(255,255,255,0.06)',
      ...opts,
    };
    this.layers = [];          // { samples, sampleRate, color, alpha, offset, normalize }
    this.window = 1;           // seconds shown across the width
    this.tailStart = null;     // shade from here to the end
    this.playhead = null;      // seconds, or null
    this.countdown = null;     // text drawn centered, or null
    this.static = document.createElement('canvas');
    this._dirty = true;
    this._ro = new ResizeObserver(() => { this._dirty = true; this.draw(); });
    this._ro.observe(canvas);
  }

  setWindow(seconds, tailStart = null) {
    this.window = Math.max(0.05, seconds);
    this.tailStart = tailStart;
    this._dirty = true;
  }

  /** layers: [{ samples|buffer, sampleRate?, color, alpha?, offset?, normalize? }] */
  setLayers(layers) {
    this.layers = layers.map((l) => ({
      samples: l.buffer ? monoSamples(l.buffer) : l.samples,
      sampleRate: l.buffer ? l.buffer.sampleRate : l.sampleRate,
      color: l.color,
      alpha: l.alpha ?? 1,
      offset: l.offset ?? 0,
      normalize: l.normalize ?? true,
      mode: l.mode ?? 'fill',
    }));
    this._dirty = true;
  }

  setPlayhead(t) { this.playhead = t; }
  setCountdown(text) { this.countdown = text; }

  _size() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.static.width = w; this.static.height = h;
      this._dirty = true;
    }
    return { w, h, dpr };
  }

  _renderStatic(w, h, dpr) {
    const g = this.static.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.fillStyle = this.opts.background;
    g.fillRect(0, 0, w, h);

    const pxPerSec = w / this.window;
    if (this.tailStart != null) {
      const x = this.tailStart * pxPerSec;
      g.fillStyle = this.opts.tailFill;
      g.fillRect(x, 0, w - x, h);
      g.strokeStyle = this.opts.grid; g.lineWidth = dpr;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }

    // second ticks
    g.strokeStyle = this.opts.grid; g.lineWidth = dpr;
    for (let s = 1; s < this.window; s++) {
      const x = Math.round(s * pxPerSec) + 0.5;
      g.beginPath(); g.moveTo(x, h - 8 * dpr); g.lineTo(x, h); g.stroke();
    }
    g.beginPath(); g.moveTo(0, h / 2 + 0.5); g.lineTo(w, h / 2 + 0.5); g.stroke();

    for (const layer of this.layers) {
      if (!layer.samples || !layer.samples.length) continue;
      const startX = Math.round(layer.offset * pxPerSec);
      const cols = Math.max(1, Math.min(w - startX, Math.round((layer.samples.length / layer.sampleRate) * pxPerSec)));
      if (cols <= 0) continue;
      const { min, max, peak } = computePeaks(layer.samples, layer.sampleRate, cols);
      const scale = layer.normalize ? (peak > 0.02 ? 0.92 / peak : 1) : 1;
      const mid = h / 2;
      g.globalAlpha = layer.alpha;
      g.fillStyle = layer.color;
      g.strokeStyle = layer.color;
      if (layer.mode === 'fill') {
        g.beginPath();
        for (let c = 0; c < cols; c++) g.lineTo(startX + c, mid - Math.max(0.5 * dpr, max[c] * scale * mid));
        for (let c = cols - 1; c >= 0; c--) g.lineTo(startX + c, mid - Math.min(-0.5 * dpr, min[c] * scale * mid));
        g.closePath(); g.fill();
      } else {
        g.lineWidth = dpr;
        g.beginPath();
        for (let c = 0; c < cols; c++) g.lineTo(startX + c, mid - max[c] * scale * mid);
        for (let c = cols - 1; c >= 0; c--) g.lineTo(startX + c, mid - min[c] * scale * mid);
        g.closePath(); g.stroke();
      }
      g.globalAlpha = 1;
    }
    this._dirty = false;
  }

  draw() {
    const { w, h, dpr } = this._size();
    if (this._dirty) this._renderStatic(w, h, dpr);
    const g = this.ctx;
    g.clearRect(0, 0, w, h);
    g.drawImage(this.static, 0, 0);

    if (this.playhead != null) {
      const x = Math.max(0, Math.min(w, (this.playhead / this.window) * w));
      g.fillStyle = this.opts.progress;
      g.fillRect(0, 0, x, h);
      g.fillStyle = this.opts.playhead;
      g.fillRect(Math.round(x) - dpr, 0, 2 * dpr, h);
    }
    if (this.countdown) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff';
      g.font = `700 ${Math.round(h * 0.6)}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(this.countdown, w / 2, h / 2);
    }
  }

  destroy() { this._ro.disconnect(); }
}
