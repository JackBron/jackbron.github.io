// Loads a Choicer Voicer package into one in-memory model, whatever shape it
// arrives in: a folder picked or dropped, a .zip, or a base URL.
//
// Two layouts exist in the wild, both flat directories:
//
//   native (the game's own):
//     _pack_info.ini              title / icon / authors / readme / preselected_dub_characters
//     NN_character.txt            Godot ConfigFile card: caption, image, dub_timestamps, dub_characters
//     NN_character.mp3            the original audio of that line
//     character.png               one image per character, shared by its cards
//     _backing_track.mp3          music + effects with the voices removed
//     dub_video.ogv               the clip (Theora)
//
//   export (seen from converter tools):
//     _pack_info.ini, NNN_line_NN.ini/.png/.wav per line, dub_markers.json, dub_video.ogv
//
// Cards are the source of truth. Numbering is per character in the native
// layout, so lines are ordered by their timestamp, not their filename. Any
// card extension (.ini/.txt), any audio (.wav/.mp3/.ogg/...) and any image
// (.png/.jpg/.webp) is accepted; durations come from the WAV header when there
// is one and from decoding otherwise.

import { iniData } from './ini.js';
import { parseWavHeader } from './wav.js';
import { readZip } from './zip.js';

const PACK_INFO = '_pack_info.ini';
const MARKERS = 'dub_markers.json';
const INDEX = 'index.json';
const VIDEO_EXT = /\.(ogv|webm|mp4|m4v|mov)$/i;
const CARD_EXT = /\.(ini|txt)$/i;
const AUDIO_EXTS = ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const BACKING = /^_backing_track\.(mp3|wav|ogg|oga|opus|flac|m4a)$/i;

// Durations of non-WAV audio come from decoding; OfflineAudioContext is not
// subject to the autoplay policy, so this works before any user gesture.
let decoder = null;
async function decodeBlob(blob) {
  decoder ??= new OfflineAudioContext(1, 1, 48000);
  return decoder.decodeAudioData(await blob.arrayBuffer());
}

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
  // A static host has no directory listing, so accept either an index.json
  // (a JSON array of file names) or, for export-layout packs, dub_markers.json.
  const names = new Set([PACK_INFO]);
  let listed = null;
  try { const j = JSON.parse(await fetchText(INDEX)); if (Array.isArray(j)) listed = j; } catch { /* no index */ }
  if (listed) {
    for (const n of listed) if (typeof n === 'string' && !n.endsWith('/')) names.add(n.replace(/^.*\//, ''));
  } else {
    const markers = JSON.parse(await fetchText(MARKERS));
    names.add(MARKERS);
    for (const m of markers.markers || []) {
      const stem = m.filename.replace(/\.wav$/i, '');
      names.add(`${stem}.ini`); names.add(`${stem}.wav`); names.add(`${stem}.png`);
    }
    if (markers.hasDubVideo) names.add('dub_video.ogv');
    try {
      const info = iniData(await fetchText(PACK_INFO));
      if (info.icon) names.add(info.icon);
    } catch { /* icon optional */ }
  }
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
  const lower = new Map();
  for (const [n, e] of byName) lower.set(n.toLowerCase(), e);
  const get = (name) => (name ? lower.get(String(name).toLowerCase()) : undefined);
  const names = Array.from(byName.keys());

  const infoEntry = get(PACK_INFO) || names.map((n) => get(n)).find((e) => /^_pack_info\.(ini|txt)$/i.test(e.path.split('/').pop()));
  const info = infoEntry ? iniData(await (await infoEntry.blob()).text()) : {};

  let markers = null;
  if (get(MARKERS)) {
    try { markers = JSON.parse(await (await get(MARKERS).blob()).text()); } catch { markers = null; }
  }
  const markerByStem = new Map();
  for (const m of markers?.markers || []) markerByStem.set(m.filename.replace(/\.[^.]+$/, '').toLowerCase(), m);

  const cardNames = names
    .filter((n) => CARD_EXT.test(n) && !/^_pack_info\./i.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!cardNames.length) throw new Error('No line cards found: expected NN_character.txt (native) or NNN_line_NN.ini (export) files next to _pack_info.ini');

  const lines = [];
  const skipped = [];
  for (const name of cardNames) {
    const stem = name.replace(CARD_EXT, '');
    let card;
    try { card = iniData(await (await get(name).blob()).text()); } catch { skipped.push(name); continue; }
    if (card.caption == null && card.dub_timestamps == null) { skipped.push(name); continue; } // some other text file

    const audioName = AUDIO_EXTS.map((e) => `${stem}.${e}`).find((n) => get(n));
    if (!audioName) { skipped.push(name); continue; }
    const audio = await get(audioName).blob();

    let duration;
    let audioBuffer = null;
    if (/\.wav$/i.test(audioName)) {
      duration = parseWavHeader(await audio.slice(0, 8192).arrayBuffer()).duration;
    } else {
      audioBuffer = await decodeBlob(audio);
      duration = audioBuffer.duration;
    }

    const imageName = (card.image && get(card.image) ? card.image : null)
      ?? IMAGE_EXTS.map((e) => `${stem}.${e}`).find((n) => get(n))
      ?? null;
    const image = imageName ? await get(imageName).blob() : null;

    const timestamps = toArray(card.dub_timestamps).map(Number).filter((n) => !Number.isNaN(n));
    const characters = toArray(card.dub_characters).map(String).filter(Boolean);
    const marker = markerByStem.get(stem.toLowerCase());

    const start = marker?.start ?? (timestamps.length ? Math.min(...timestamps) : null);
    const end = marker?.end ?? (start != null ? start + duration : null);

    lines.push({
      id: stem,
      file: name,
      caption: String(card.caption ?? marker?.caption ?? ''),
      characters: characters.length ? characters : [marker?.character || 'Unknown'],
      timestamps,
      start, end, duration,
      image, imageName, audio, audioName, audioBuffer,
    });
  }
  if (!lines.length) throw new Error(`Found ${cardNames.length} card file(s) but none had a matching audio file (${AUDIO_EXTS.join('/')})`);

  // Cards with no timing information fall back to laying lines end to end.
  let cursor = 0;
  for (const l of lines) {
    if (l.start == null) { l.start = cursor; l.end = cursor + l.duration; }
    cursor = Math.max(cursor, l.end);
  }
  // Native packs number lines per character, so the read order is by time.
  lines.sort((a, b) => (a.start - b.start) || a.file.localeCompare(b.file, undefined, { numeric: true }));
  lines.forEach((l, i) => { l.order = i + 1; });

  const characters = toArray(info.preselected_dub_characters).map(String).filter(Boolean);
  for (const l of lines) for (const c of l.characters) if (!characters.includes(c)) characters.push(c);

  const iconEntry = info.icon ? get(info.icon) : null;
  const videoName = names.find((n) => VIDEO_EXT.test(n)) || names.find((n) => /\.ogg$/i.test(n) && !BACKING.test(n)) || null;
  const backingName = names.find((n) => BACKING.test(n)) || null;
  const backing = backingName ? await get(backingName).blob() : null;

  const urls = [];
  const pkg = {
    title: String(info.title || markers?.title || 'Untitled package'),
    subtitle: String(info.subtitle || markers?.subtitle || ''),
    readme: String(info.readme || ''),
    authors: toArray(info.authors ?? markers?.authors).map(String),
    icon: iconEntry ? await iconEntry.blob() : null,
    characters,
    lines,
    skipped,
    totalDuration: Math.max(...lines.map((l) => l.end)),
    hasVideo: !!videoName,
    videoName,
    backing,
    backingName,
    hasBacking: !!backing,
    lineById(id) { return lines.find((l) => l.id === id) || null; },
    async getVideo() { return videoName ? get(videoName).blob() : null; },
    /** Object URL for a blob, revoked on dispose(). */
    url(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; },
    dispose() { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; },
  };
  // Shared character images get one object URL each.
  const imageUrls = new Map();
  for (const l of lines) {
    if (!l.image) { l.imageUrl = null; continue; }
    const key = l.imageName.toLowerCase();
    if (!imageUrls.has(key)) imageUrls.set(key, pkg.url(l.image));
    l.imageUrl = imageUrls.get(key);
  }
  return pkg;
}

/* ------------------------------------------------------------------ */
/* Wire form for a room: everything but the blobs.                    */

export function summarizePackage(pkg) {
  return {
    title: pkg.title, subtitle: pkg.subtitle, readme: pkg.readme, authors: pkg.authors, characters: pkg.characters,
    totalDuration: pkg.totalDuration, videoName: pkg.videoName, hasBacking: pkg.hasBacking,
    lines: pkg.lines.map((l) => ({
      id: l.id, order: l.order, caption: l.caption, characters: l.characters,
      timestamps: l.timestamps, start: l.start, end: l.end, duration: l.duration, imageName: l.imageName,
    })),
  };
}

/** A player's copy: same shape as buildPackage's model, assets arrive later. */
export function packageFromSummary(s) {
  const urls = [];
  const lines = s.lines.map((l) => ({ ...l, image: null, imageUrl: null, audio: null, audioBuffer: null }));
  return {
    title: s.title, subtitle: s.subtitle || '', readme: s.readme || '', authors: s.authors || [], icon: null,
    characters: s.characters, lines, totalDuration: s.totalDuration,
    hasVideo: false, videoName: null, backing: null, hasBacking: !!s.hasBacking, remote: true,
    lineById(id) { return lines.find((l) => l.id === id) || null; },
    async getVideo() { return null; },
    url(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; },
    dispose() { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; },
  };
}

/** Find the directory holding the package and index its files by basename. */
function locateRoot(entries) {
  // Windows zip writers (PowerShell's Compress-Archive among them) store
  // backslash separators, so normalise before splitting paths.
  entries = entries.map((e) => (e.path.includes('\\') ? { ...e, path: e.path.replace(/\\/g, '/') } : e));
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

  let rootDir = null;
  const info = entries.find((e) => /^_pack_info\.(ini|txt)$/i.test(baseOf(e.path)));
  if (info) rootDir = dirOf(info.path);
  else {
    const idx = entries.find((e) => baseOf(e.path) === MARKERS);
    if (idx) rootDir = dirOf(idx.path);
    else {
      const card = entries.find((e) => /^\d+_[^/]+\.(ini|txt)$/i.test(baseOf(e.path)));
      if (card) rootDir = dirOf(card.path);
    }
  }
  if (rootDir === null) throw new Error('Not a Choicer Voicer package: no _pack_info.ini, dub_markers.json or numbered line cards found');

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
