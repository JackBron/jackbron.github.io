// RIFF/WAVE helpers. The package WAVs are 48 kHz stereo 16-bit PCM, one per
// line; the header walk is generic so other volunteer exports also parse.

export function parseWavHeader(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');

  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= dv.byteLength) {
    const id = tag(p);
    const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(p + 8, true),
        channels: dv.getUint16(p + 10, true),
        sampleRate: dv.getUint32(p + 12, true),
        byteRate: dv.getUint32(p + 16, true),
        blockAlign: dv.getUint16(p + 20, true),
        bitsPerSample: dv.getUint16(p + 22, true),
      };
    } else if (id === 'data') {
      data = { offset: p + 8, length: size };
      break; // the data chunk is last in every export we care about
    }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt or data chunk');
  return { ...fmt, dataOffset: data.offset, dataLength: data.length, duration: data.length / fmt.byteRate };
}

/** Encode Float32 channel arrays as a 16-bit PCM WAV blob. */
export function encodeWav(channels, sampleRate) {
  const numCh = channels.length;
  const frames = channels[0].length;
  const bytes = 44 + frames * numCh * 2;
  const buf = new ArrayBuffer(bytes);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * numCh * 2, true); dv.setUint16(32, numCh * 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, frames * numCh * 2, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function audioBufferToWav(buffer) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  return encodeWav(chans, buffer.sampleRate);
}
