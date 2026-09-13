// Offline mixdown: every take dropped at its line's start (plus the
// performer's nudge) on a silent timeline the length of the clip. Deterministic,
// so in the multiplayer build every peer can render the same mix from the same
// takes without anyone shipping the result around.

/**
 * @param {object} pkg      package model
 * @param {Map<string, Take>} takes   lineId -> take
 * @param {object} opts
 * @returns {Promise<AudioBuffer>} mono mix
 */
export async function renderMix(pkg, takes, { sampleRate = 48000, tailPad = 0.75 } = {}) {
  const length = Math.max(1, Math.ceil((pkg.totalDuration + tailPad) * sampleRate));
  const off = new OfflineAudioContext(1, length, sampleRate);

  for (const [lineId, take] of takes) {
    const line = pkg.lineById(lineId);
    if (!line || !take?.samples?.length) continue;
    const buf = off.createBuffer(1, take.samples.length, take.sampleRate);
    buf.copyToChannel(take.samples, 0);
    const src = off.createBufferSource();
    src.buffer = buf;
    const gain = off.createGain();
    gain.gain.value = take.gain ?? 1;
    src.connect(gain).connect(off.destination);
    const at = line.start + (take.offset || 0);
    if (at >= 0) src.start(at);
    else src.start(0, -at);
  }
  return off.startRendering();
}

/**
 * Gain that brings a take's peak to `target`, within limits. Phones record
 * quietly; a shy performer more so. Stored on the take, applied at mix time,
 * the samples themselves are never touched.
 */
export function autoGain(samples, target = 0.85, min = 0.5, max = 8) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  if (peak < 1e-3) return 1;
  return Math.max(min, Math.min(max, target / peak));
}

/** Peak-normalise a rendered mix in place so quiet phone mics still carry. */
export function normalize(buffer, target = 0.89) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
  }
  if (peak < 1e-4 || peak >= target) return buffer;
  const k = target / peak;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return buffer;
}
