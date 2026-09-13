// Loads a Choicer Voicer package into one in-memory model, whatever shape it
// arrives in: a folder picked or dropped, a .zip, or a base URL.
//
// A package is a flat directory:
//   _pack_info.ini            title / subtitle / icon / authors
//   NNN_line_NN.ini/.png/.wav one card per line: caption, frame, original audio
//   dub_markers.json          optional flattened index with start/end times
//   dub_video.ogv             optional full clip (Theora, so Safari cannot play it)
//
// The .ini cards are treated as the source of truth (the game reads them);
// dub_markers.json is used for timing when present and the WAV header's
// duration fills in when it is not.

import { iniData } from './ini.js';
import { parseWavHeader } from './wav.js';
import { readZip } from './zip.js';

const PACK_INFO = '_pack_info.ini';
const MARKERS = 'dub_markers.json';
const VIDEO_EXT = /\.(ogv|ogg|webm|mp4|m4v|mov)$/i;

/* ------------------------------------------------------------------ */
/* Entry sources. Each yields [{ path, blob(): Promise<Blob> }].       */

export async function entriesFromFileList(fileList) {
  return Array.from(fileList).map((f) => ({
    path: f.webkitRelativePath || f.name,
    size: f.size,
    blob: async () => f,
  }));
}

export async function entriesFromZip(file) {
  return readZip(file);
}

export async function entriesFromDataTransfer(dt) {
  const items = Array.from(dt.items || []);
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ path: prefix + f.name, size: f.size, blob: async () => f });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + '/');
      }
    }
  };
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) await walk(entry, '');
    else { const f = item.getAsFile(); if (f) out.push({ path: f.name, size: f.size, blob: async () => f }); }
  }
  if (out.length === 1 && /\.zip$/i.test(out[0].path)) return entriesFromZip(await out[0].blob());
  return out;
}

/** Package hosted at a URL. Needs _pack_info.ini and dub_markers.json there. */
export async function entriesFromUrl(base) {
  if (!base.endsWith('/')) base += '/';
  const fetchText = async (name) => {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.text();
  };
  const markers = JSON.parse(await fetchText(MARKERS));
  const names = new Set([PACK_INFO, MARKERS]);
  for (const m of markers.markers || []) {
    const stem = m.filename.replace(/\.wav$/i, '');
    names.add(`${stem}.ini`); names.add(`${stem}.wav`); names.add(`${stem}.png`);
  }
  if (markers.hasDubVideo) names.add('dub_video.ogv');
  try {
    const info = iniData(await fetchText(PACK_INFO));
    if (info.icon) names.add(info.icon);
  } catch { /* icon optional */ }
  return Array.from(names).map((name) => ({
    path: name,
    blob: async () => {
      const r = await fetch(base + name);
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      return r.blob();
    },
  }));
}

/* ------------------------------------------------------------------ */
/* Build the model.                                                   */

export async function buildPackage(entries) {
  const byName = locateRoot(entries);

  const infoEntry = byName.get(PACK_INFO);
  const info = infoEntry ? iniData(await (await infoEntry.blob()).text()) : {};

  let markers = null;
  if (byName.has(MARKERS)) {
    try { markers = JSON.parse(await (await byName.get(MARKERS).blob()).text()); } catch { markers = null; }
  }
  const markerByStem = new Map();
  for (const m of markers?.markers || []) markerByStem.set(m.filename.replace(/\.wav$/i, ''), m);

  const cardNames = Array.from(byName.keys())
    .filter((n) => /\.ini$/i.test(n) && n !== PACK_INFO)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!cardNames.length) throw new Error('No line cards (*.ini) found in this package');

  const lines = [];
  for (const name of cardNames) {
    const stem = name.replace(/\.ini$/i, '');
    const card = iniData(await (await byName.get(name).blob()).text());
    const wavEntry = byName.get(`${stem}.wav`);
    if (!wavEntry) continue; // a card with no audio is not a dub line
    const wav = await wavEntry.blob();
    const wavInfo = parseWavHeader(await wav.slice(0, 8192).arrayBuffer());

    const imageName = card.image || `${stem}.png`;
    const imageEntry = byName.get(imageName) ?? byName.get(`${stem}.png`);
    const image = imageEntry ? await imageEntry.blob() : null;

    const timestamps = toArray(card.dub_timestamps).map(Number).filter((n) => !Number.isNaN(n));
    const characters = toArray(card.dub_characters).map(String).filter(Boolean);
    const marker = markerByStem.get(stem);

    const start = marker?.start ?? timestamps[0] ?? null;
    const duration = wavInfo.duration;
    const end = marker?.end ?? (start != null ? start + duration : null);

    lines.push({
      id: stem,
      order: lines.length + 1,
      caption: String(card.caption ?? marker?.caption ?? ''),
      characters: characters.length ? characters : [marker?.character || 'Unknown'],
      timestamps,
      start, end, duration,
      image, wav, wavInfo,
    });
  }
  if (!lines.length) throw new Error('No lines with audio found in this package');

  // Cards with no timing information fall back to laying lines end to end.
  let cursor = 0;
  for (const l of lines) {
    if (l.start == null) { l.start = cursor; l.end = cursor + l.duration; }
    cursor = l.end;
  }

  const characters = [];
  for (const l of lines) for (const c of l.characters) if (!characters.includes(c)) characters.push(c);

  const iconEntry = info.icon ? byName.get(info.icon) : null;
  const videoName = Array.from(byName.keys()).find((n) => VIDEO_EXT.test(n)) || null;

  const urls = [];
  const pkg = {
    title: String(info.title || markers?.title || 'Untitled package'),
    subtitle: String(info.subtitle || markers?.subtitle || ''),
    authors: toArray(info.authors ?? markers?.authors).map(String),
    icon: iconEntry ? await iconEntry.blob() : null,
    characters,
    lines,
    totalDuration: Math.max(...lines.map((l) => l.end)),
    hasVideo: !!videoName,
    videoName,
    lineById(id) { return lines.find((l) => l.id === id) || null; },
    async getVideo() { return videoName ? byName.get(videoName).blob() : null; },
    /** Object URL for a blob, revoked on dispose(). */
    url(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; },
    dispose() { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; },
  };
  for (const l of lines) l.imageUrl = l.image ? pkg.url(l.image) : null;
  return pkg;
}

/** Find the directory holding the package and index its files by basename. */
function locateRoot(entries) {
  // Windows zip writers (PowerShell's Compress-Archive among them) store
  // backslash separators, so normalise before splitting paths.
  entries = entries.map((e) => (e.path.includes('\\') ? { ...e, path: e.path.replace(/\\/g, '/') } : e));
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

  let rootDir = null;
  const info = entries.find((e) => baseOf(e.path) === PACK_INFO);
  if (info) rootDir = dirOf(info.path);
  else {
    const idx = entries.find((e) => baseOf(e.path) === MARKERS);
    if (idx) rootDir = dirOf(idx.path);
    else {
      const card = entries.find((e) => /_line_\d+\.ini$/i.test(baseOf(e.path)));
      if (card) rootDir = dirOf(card.path);
    }
  }
  if (rootDir === null) throw new Error('Not a Choicer Voicer package (no _pack_info.ini, dub_markers.json or line cards found)');

  const byName = new Map();
  for (const e of entries) {
    if (dirOf(e.path) !== rootDir) continue;
    const base = baseOf(e.path);
    if (base.startsWith('.')) continue;
    byName.set(base, e);
  }
  return byName;
}

function toArray(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}
