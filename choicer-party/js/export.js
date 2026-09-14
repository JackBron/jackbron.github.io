// Video export: composite the picture (decoded clip, or the frame slideshow)
// with burned-in captions on a canvas, feed that canvas and the mixed audio
// into MediaRecorder, and hand back a file. It runs in real time because the
// clip has to be decoded in real time; a progress callback keeps the wait
// honest.

const MIME_CANDIDATES = [
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm'],
];

export function exportSupported() {
  return typeof MediaRecorder !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && MIME_CANDIDATES.some(([m]) => MediaRecorder.isTypeSupported(m));
}

function pickMime() {
  return MIME_CANDIDATES.find(([m]) => MediaRecorder.isTypeSupported(m)) || [null, null];
}

/**
 * @param {object} o
 * @param {object}   o.pkg        package model (lines with imageUrl / caption / start / end)
 * @param {AudioBuffer} o.mix     the rendered dub
 * @param {object}   o.video      VideoPlayer (may be !ok -> slideshow)
 * @param {object}   o.recorder   Recorder (for the AudioContext)
 * @param {boolean}  o.captions   burn captions in
 * @param {(t:number, total:number)=>void} o.onProgress
 * @param {AbortSignal} o.signal
 * @returns {Promise<{blob: Blob, ext: string, mime: string, duration: number}>}
 */
export async function exportDub({ pkg, mix, video, recorder, captions = true, onProgress = null, signal = null }) {
  const [mime, ext] = pickMime();
  if (!mime) throw new Error('This browser cannot record video (no MediaRecorder support)');

  const ctx = recorder.ctx;
  const useVideo = !!(video && video.ok);
  const W = useVideo ? Math.min(1280, video.videoWidth || 1280) : 1280;
  const H = useVideo ? Math.round(W * ((video.videoHeight || 720) / (video.videoWidth || 1280))) : 720;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');

  // Preload slideshow images.
  const images = new Map();
  if (!useVideo) {
    await Promise.all(pkg.lines.map((l) => new Promise((res) => {
      if (!l.imageUrl || images.has(l.imageUrl)) { res(); return; }
      const im = new Image();
      im.onload = () => { images.set(l.imageUrl, im); res(); };
      im.onerror = () => res();
      im.src = l.imageUrl;
    })));
  }

  // Audio: the mix into a stream destination (and the speakers, so the host hears it).
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = mix;
  src.connect(dest);
  src.connect(ctx.destination);

  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 160_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const done = new Promise((resolve, reject) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
    rec.onerror = (e) => reject(e.error || new Error('recorder error'));
  });

  const total = mix.duration;
  const t0 = ctx.currentTime + 0.4;
  let videoStarted = false;
  let stopped = false;
  let raf = 0;

  const drawFrame = (t) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const line = pkg.lines.find((l) => t >= l.start && t < l.end) || null;
    const source = useVideo ? video.frameSource() : (line && images.get(line.imageUrl)) || null;
    if (source) {
      const sw = source.videoWidth || source.naturalWidth || source.width;
      const sh = source.videoHeight || source.naturalHeight || source.height;
      if (sw && sh) {
        const k = Math.min(W / sw, H / sh);
        const dw = sw * k, dh = sh * k;
        try { g.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch { /* frame not ready */ }
      }
    }
    if (captions && line && line.caption) drawCaption(g, W, H, line.caption);
  };

  const finish = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    try { src.stop(); } catch { /* ended */ }
    if (useVideo) video.pause();
    if (rec.state !== 'inactive') rec.stop();
  };

  const abort = () => { finish(); };
  signal?.addEventListener('abort', abort, { once: true });

  const loop = () => {
    const t = ctx.currentTime - t0;
    if (t >= 0) {
      if (useVideo && !videoStarted) { videoStarted = true; video.playFrom(0).catch(() => {}); }
      else if (useVideo) video.sync(t);
      drawFrame(Math.max(0, t));
      onProgress?.(Math.min(t, total), total);
    } else {
      drawFrame(0);
    }
    if (t >= total + 0.2) { finish(); return; }
    raf = requestAnimationFrame(loop);
  };

  drawFrame(0);
  rec.start(500);
  src.start(t0);
  if (useVideo) { try { video.seekTo(0); } catch { /* ignore */ } }
  raf = requestAnimationFrame(loop);

  const blob = await done;
  signal?.removeEventListener('abort', abort);
  src.disconnect(); dest.disconnect?.();
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  return { blob, ext, mime, duration: total };
}

function drawCaption(g, W, H, text) {
  const fontPx = Math.round(H * 0.052);
  g.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  const maxWidth = W * 0.86;
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (g.measureText(trial).width > maxWidth && cur) { lines.push(cur); cur = w; } else cur = trial;
  }
  if (cur) lines.push(cur);
  const lineH = fontPx * 1.25;
  let y = H - Math.round(H * 0.05);
  // background band
  const bandH = lines.length * lineH + fontPx * 0.6;
  const grad = g.createLinearGradient(0, H - bandH - fontPx, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.75)');
  g.fillStyle = grad;
  g.fillRect(0, H - bandH - fontPx, W, bandH + fontPx);
  for (let i = lines.length - 1; i >= 0; i--) {
    g.lineWidth = Math.max(2, fontPx * 0.12);
    g.strokeStyle = 'rgba(0,0,0,0.9)';
    g.strokeText(lines[i], W / 2, y);
    g.fillStyle = '#fff';
    g.fillText(lines[i], W / 2, y);
    y -= lineH;
  }
}
