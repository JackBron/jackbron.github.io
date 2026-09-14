// Package tester: unit tests for the parsing/mixing modules, plus a validator
// for a real package. Runs in the browser against the exact modules the booth
// imports, so a change that breaks one layout shows up here first.

import { parseIni, parseValue, iniData } from '../js/ini.js';
import { encodeWav, parseWavHeader } from '../js/wav.js';
import { readZip } from '../js/zip.js';
import { buildPackage, summarizePackage, packageFromSummary, entriesFromFileList, entriesFromZip, entriesFromDataTransfer, entriesFromUrl } from '../js/package.js';
import { renderMix, normalize, autoGain } from '../js/mixer.js';
import { computePeaks } from '../js/waveform.js';
import * as store from '../js/store.js';

const $ = (id) => document.getElementById(id);

/* ================================================================== */
/* Tiny harness                                                       */

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'expected equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || 'expected near'}: got ${a}, want ${b} ±${tol}`); }

async function runAll() {
  const ul = $('unitResults');
  let pass = 0, fail = 0, skip = 0;
  for (const t of tests) {
    const li = document.createElement('li');
    const mark = document.createElement('span'); mark.className = 'mark';
    const body = document.createElement('span');
    body.textContent = t.name;
    li.append(mark, body);
    ul.appendChild(li);
    try {
      const r = await t.fn();
      if (r === 'skip') { li.className = 'skip'; mark.textContent = '–'; skip++; }
      else { li.className = 'pass'; mark.textContent = '✓'; pass++; }
      if (typeof r === 'string' && r !== 'skip') { const d = document.createElement('span'); d.className = 'detail'; d.textContent = r; body.appendChild(d); }
    } catch (err) {
      li.className = 'fail'; mark.textContent = '✕'; fail++;
      const d = document.createElement('span'); d.className = 'detail'; d.textContent = err.stack || String(err); body.appendChild(d);
      console.error(t.name, err);
    }
  }
  $('unitSummary').textContent = `${pass} passed${fail ? `, ${fail} failed` : ''}${skip ? `, ${skip} skipped` : ''}`;
  $('unitSummary').style.color = fail ? '#ff8a82' : 'var(--green)';
}

/* ================================================================== */
/* Fixtures                                                           */

const PNG_1x1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function toneWav(seconds, freq = 440, rate = 48000, amp = 0.5) {
  const n = Math.round(seconds * rate);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
  return encodeWav([s, s], rate);
}

function mem(files) {
  // files: { name: Blob|string }
  return Object.entries(files).map(([path, v]) => {
    const blob = v instanceof Blob ? v : new Blob([v], { type: 'text/plain' });
    return { path, size: blob.size, blob: async () => blob };
  });
}

/** A stored-only (method 0) zip built by hand; CRCs are zero because our reader ignores them. */
async function buildZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const bytes = data instanceof Uint8Array ? data : enc.encode(String(data));
    const nameB = enc.encode(name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x800, true); lh.setUint16(8, 0, true);
    lh.setUint32(18, bytes.length, true); lh.setUint32(22, bytes.length, true); lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameB, bytes);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x800, true); cd.setUint16(10, 0, true);
    cd.setUint32(20, bytes.length, true); cd.setUint32(24, bytes.length, true); cd.setUint16(28, nameB.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameB);
    offset += 30 + nameB.length + bytes.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, cdStart, true);
  return new File([...parts, ...central, new Uint8Array(eocd.buffer)], 'test.zip');
}

const NATIVE_INFO = `[data]

title="Test Native"
icon="ts.png"
authors=["Tester"]
readme="a synthetic pack"
preselected_dub_characters=["Woody","Buzz"]
`;
const card = (caption, image, ts, who) => `[data]\n\ncaption="${caption}"\nimage="${image}"\ndub_timestamps=[${ts}]\ndub_characters=["${who}"]\n`;

function nativeFiles() {
  return {
    '_pack_info.ini': NATIVE_INFO,
    '01_buzz.txt': card('“According to my nava-computer”', 'buzz.png', '05.865', 'Buzz'),
    '01_buzz.wav': toneWav(1.9),
    '01_woody.txt': card('“Shut up!”', 'woody.png', '07.770', 'Woody'),
    '01_woody.wav': toneWav(2.6),
    '02_woody.txt': card('early woody', 'woody.png', '03.000', 'Woody'),
    '02_woody.wav': toneWav(1.0),
    '02_buzz.txt': card('late buzz', 'buzz.png', '12.5', 'Buzz'),
    '02_buzz.wav': toneWav(2.0),
    'buzz.png': new Blob([PNG_1x1], { type: 'image/png' }),
    'woody.png': new Blob([PNG_1x1], { type: 'image/png' }),
    'ts.png': new Blob([PNG_1x1], { type: 'image/png' }),
    '_backing_track.wav': toneWav(15, 110),
    'readme.txt': 'This is not a card.',
    'dub_video.ogv': new Blob([new Uint8Array([1, 2, 3])], { type: 'video/ogg' }),
  };
}

function exportFiles() {
  return {
    '_pack_info.ini': `[data]\ntitle="Test Export"\nsubtitle=""\nicon="Icon.png"\nauthors=["A & B"]\n`,
    '001_line_01.ini': `[data]\ncaption="And what he said is, \\"you are a celebrity!\\""\nimage="001_line_01.png"\ndub_timestamps=[0.000]\ndub_characters=["Kanye"]\n`,
    '001_line_01.png': new Blob([PNG_1x1], { type: 'image/png' }),
    '001_line_01.wav': toneWav(3.1),
    '002_line_03.ini': `[data]\ncaption="So basically"\nimage="002_line_03.png"\ndub_timestamps=[3.100]\ndub_characters=["Kanye"]\n`,
    '002_line_03.png': new Blob([PNG_1x1], { type: 'image/png' }),
    '002_line_03.wav': toneWav(3.767),
    'Icon.png': new Blob([PNG_1x1], { type: 'image/png' }),
    'dub_markers.json': JSON.stringify({ title: 'Test Export', markers: [
      { order: 1, filename: '001_line_01.wav', start: 0, end: 3.1, character: 'Kanye', caption: 'x' },
      { order: 2, filename: '002_line_03.wav', start: 3.1, end: 6.867, character: 'Kanye', caption: 'y' },
    ] }),
  };
}

/* ================================================================== */
/* Tests                                                              */

test('ini: Godot leading-zero numbers and arrays parse', () => {
  const d = iniData(card('“x”', 'buzz.png', '05.865', 'Buzz'));
  eq(d.image, 'buzz.png');
  assert(Array.isArray(d.dub_timestamps), 'timestamps is an array');
  near(d.dub_timestamps[0], 5.865, 1e-9, 'timestamp');
  eq(d.dub_characters[0], 'Buzz');
  eq(d.caption, '“x”');
});

test('ini: escaped quotes, commas inside strings, bools, sections', () => {
  const d = parseIni('[data]\ncaption="He said \\"hi\\", twice"\nlist=["a, b","c"]\nflag=true\nnothing=null\nn=07\n');
  eq(d.data.caption, 'He said "hi", twice');
  eq(d.data.list.length, 2); eq(d.data.list[0], 'a, b');
  eq(d.data.flag, true); eq(d.data.nothing, null); eq(d.data.n, 7);
  eq(parseValue('[05.865, 07.2]').length, 2);
});

test('wav: encode → header round trip', async () => {
  const b = toneWav(2.5, 440, 44100);
  const h = parseWavHeader(await b.slice(0, 64).arrayBuffer());
  eq(h.sampleRate, 44100); eq(h.channels, 2); eq(h.bitsPerSample, 16);
  near(h.duration, 2.5, 1e-6, 'duration');
});

test('zip: stored archive with a backslash path reads and normalises', async () => {
  const z = await buildZip([['Pack\\_pack_info.ini', NATIVE_INFO], ['Pack\\01_buzz.txt', card('c', 'buzz.png', '1.0', 'Buzz')], ['Pack\\01_buzz.wav', new Uint8Array(await toneWav(0.5).arrayBuffer())]]);
  const entries = await readZip(z);
  eq(entries.length, 3);
  const pkg = await buildPackage(entries);
  eq(pkg.title, 'Test Native');
  eq(pkg.lines.length, 1);
  return `${entries.map((e) => e.path).join(', ')}`;
});

test('package (native): ordered by timestamp, shared images, backing, skips non-cards', async () => {
  const pkg = await buildPackage(mem(nativeFiles()));
  eq(pkg.title, 'Test Native');
  eq(pkg.lines.length, 4);
  eq(pkg.lines.map((l) => l.id).join(','), '02_woody,01_buzz,01_woody,02_buzz', 'order by time');
  eq(pkg.lines.map((l) => l.order).join(','), '1,2,3,4');
  near(pkg.lines[1].start, 5.865, 1e-9, 'start from card');
  near(pkg.lines[1].end, 5.865 + 1.9, 1e-6, 'end = start + audio duration');
  eq(pkg.characters.join(','), 'Woody,Buzz', 'preselected order');
  assert(pkg.hasBacking, 'backing detected');
  eq(pkg.videoName, 'dub_video.ogv');
  eq(pkg.lines[1].imageUrl, pkg.lines[3].imageUrl, 'shared character image gets one URL');
  assert(pkg.skipped.includes('readme.txt'), 'readme.txt skipped');
  eq(pkg.readme, 'a synthetic pack');
  pkg.dispose();
});

test('package (export): markers supply timing', async () => {
  const pkg = await buildPackage(mem(exportFiles()));
  eq(pkg.title, 'Test Export');
  eq(pkg.lines.length, 2);
  near(pkg.lines[1].start, 3.1, 1e-9); near(pkg.lines[1].end, 6.867, 1e-9);
  eq(pkg.lines[0].caption, 'And what he said is, "you are a celebrity!"');
  eq(pkg.characters[0], 'Kanye');
  assert(!pkg.hasBacking, 'no backing');
  pkg.dispose();
});

test('package: no cards gives a clear error', async () => {
  let msg = '';
  try { await buildPackage(mem({ '_pack_info.ini': NATIVE_INFO, 'x.wav': toneWav(1) })); } catch (e) { msg = e.message; }
  assert(/No line cards/.test(msg), `error mentions cards: ${msg}`);
});

test('package: summary ↔ remote copy round trip', async () => {
  const pkg = await buildPackage(mem(nativeFiles()));
  const s = summarizePackage(pkg);
  const r = packageFromSummary(JSON.parse(JSON.stringify(s)));
  eq(r.lines.length, pkg.lines.length);
  eq(r.lines[2].id, pkg.lines[2].id);
  eq(r.hasBacking, true); eq(r.characters.join(','), 'Woody,Buzz');
  eq(r.lineById('01_buzz').imageName, 'buzz.png');
  pkg.dispose(); r.dispose();
});

test('room: autoAssign deals whole characters, or round-robin when outnumbered', async () => {
  let room;
  try { room = await import('../js/room.js'); } catch { return 'skip'; }
  const lines = [{ id: 'a', characters: ['Woody'] }, { id: 'b', characters: ['Buzz'] }, { id: 'c', characters: ['Woody'] }];
  const two = room.autoAssign(lines, ['Woody', 'Buzz'], ['p1', 'p2']);
  eq(two.a, 'p1'); eq(two.b, 'p2'); eq(two.c, 'p1');
  const three = room.autoAssign(lines, ['Solo'], ['p1', 'p2', 'p3']);
  eq(`${three.a}${three.b}${three.c}`, 'p1p2p3');
  eq(Object.keys(room.autoAssign(lines, ['X'], [])).length, 0);
});

test('room: take encode ↔ decode within 16-bit tolerance, metadata intact', async () => {
  let room;
  try { room = await import('../js/room.js'); } catch { return 'skip'; }
  const samples = new Float32Array(4800);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20) * 0.7;
  const take = { samples, sampleRate: 48000, offset: 0.08, gain: 2.5, lineDuration: 0.1, tail: 0.5 };
  const enc = room.encodeTake('01_buzz', take, 'Sam', 'client-x');
  const dec = room.decodeTake(enc.data.buffer, enc.meta);
  eq(dec.samples.length, 4800);
  let maxErr = 0;
  for (let i = 0; i < 4800; i++) maxErr = Math.max(maxErr, Math.abs(dec.samples[i] - samples[i]));
  assert(maxErr <= 1 / 32000, `max error ${maxErr}`);
  eq(dec.offset, 0.08); eq(dec.gain, 2.5); eq(dec.byClientId, 'client-x'); eq(dec.by, 'Sam'); assert(dec.remote);
  // a Uint8Array view with an offset must also decode
  const bytes = new Uint8Array(enc.data.buffer);
  const padded = new Uint8Array(bytes.length + 6); padded.set(bytes, 6);
  const dec2 = room.decodeTake(padded.subarray(6), enc.meta);
  eq(dec2.samples.length, 4800);
});

test('room: shrinkImage produces a smaller JPEG no wider than 640', async () => {
  let room;
  try { room = await import('../js/room.js'); } catch { return 'skip'; }
  const c = document.createElement('canvas'); c.width = 900; c.height = 700;
  const g = c.getContext('2d');
  for (let i = 0; i < 60; i++) { g.fillStyle = `hsl(${i * 6},70%,50%)`; g.fillRect(i * 15, 0, 15, 700); }
  const png = await new Promise((r) => c.toBlob(r, 'image/png'));
  const out = await room.shrinkImage(png);
  assert(out.size < png.size, `smaller: ${out.size} < ${png.size}`);
  const bmp = await createImageBitmap(out);
  assert(bmp.width <= 640, `width ${bmp.width}`);
  return `${(png.size / 1024).toFixed(0)} KB → ${(out.size / 1024).toFixed(0)} KB, ${bmp.width}×${bmp.height}`;
});

test('mixer: autoGain boosts quiet, caps at x8, leaves silence alone', () => {
  const quiet = new Float32Array(1000).fill(0.05);
  eq(autoGain(quiet), 8);
  const mid = new Float32Array(1000).fill(0.5);
  near(autoGain(mid), 1.7, 1e-9);
  eq(autoGain(new Float32Array(1000)), 1);
});

test('mixer: normalize scales up and down to the target', () => {
  const ctx = new OfflineAudioContext(1, 100, 48000);
  const loud = ctx.createBuffer(1, 100, 48000); loud.getChannelData(0).fill(1.6);
  normalize(loud); near(loud.getChannelData(0)[0], 0.89, 1e-6, 'down');
  const soft = ctx.createBuffer(1, 100, 48000); soft.getChannelData(0).fill(0.2);
  normalize(soft); near(soft.getChannelData(0)[0], 0.89, 1e-6, 'up');
});

test('mixer: renderMix places a take at its line start and covers the backing track', async () => {
  const pkg = await buildPackage(mem(nativeFiles()));
  const sr = 48000;
  const line = pkg.lineById('01_buzz'); // starts at 5.865
  const samples = new Float32Array(sr); samples.fill(0.5);
  const takes = new Map([[line.id, { samples, sampleRate: sr, offset: 0.1, gain: 1 }]]);
  const mix = await renderMix(pkg, takes, { sampleRate: sr });
  const d = mix.getChannelData(0);
  let first = -1; for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 1e-4) { first = i; break; }
  near(first / sr, 5.865 + 0.1, 0.002, 'first sample at start+offset');
  const backing = new OfflineAudioContext(1, sr * 15, sr).createBuffer(1, sr * 15, sr);
  backing.getChannelData(0).fill(0.1);
  const mix2 = await renderMix(pkg, takes, { sampleRate: sr, backing });
  assert(mix2.duration >= 15, `covers backing: ${mix2.duration}`);
  near(mix2.getChannelData(0)[10], 0.08, 1e-6, 'backing at 0.8 gain');
  pkg.dispose();
});

test('waveform: computePeaks tracks amplitude', () => {
  const s = new Float32Array(1000);
  for (let i = 500; i < 1000; i++) s[i] = 0.8;
  const p = computePeaks(s, 1000, 10);
  near(p.max[2], 0, 1e-6); near(p.max[7], 0.8, 1e-6); near(p.peak, 0.8, 1e-6);
});

test('store: takes round trip under a scratch session key', async () => {
  const key = `test-${Date.now()}`;
  const samples = new Float32Array([0.1, -0.2, 0.3]);
  await store.putTake(key, 'L1', { samples, sampleRate: 48000, offset: 0.02, gain: 1.5, by: 'T', byClientId: 'c1' });
  const got = await store.getTakes(key);
  eq(got.size, 1);
  const t = got.get('L1');
  near(t.samples[2], 0.3, 1e-6); eq(t.offset, 0.02); eq(t.gain, 1.5); eq(t.byClientId, 'c1');
  await store.deleteTake(key, 'L1');
  eq((await store.getTakes(key)).size, 0);
  assert(store.clientId().length >= 8, 'clientId present');
});

runAll();

/* ================================================================== */
/* Package check                                                      */

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const AUD_EXT = /\.(wav|mp3|ogg|oga|opus|flac|m4a|aac|weba)$/i;

async function checkEntries(entriesPromise, label) {
  $('packError').hidden = true;
  $('report').innerHTML = '<p class="dim">Reading…</p>';
  $('packSummary').textContent = label;
  try {
    const entries = await entriesPromise;
    const pkg = await buildPackage(entries);
    renderReport(pkg, entries);
  } catch (err) {
    console.error(err);
    $('report').innerHTML = '';
    $('packError').textContent = err.message || String(err);
    $('packError').hidden = false;
    $('packSummary').textContent = 'failed';
  }
}

async function renderReport(pkg, entries) {
  const warnings = [];
  const rows = [];
  const byChar = new Map();
  for (const l of pkg.lines) { if (!byChar.has(l.characters[0])) byChar.set(l.characters[0], []); byChar.get(l.characters[0]).push(l); }

  let backingDur = null;
  if (pkg.backing) {
    try { const b = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await pkg.backing.arrayBuffer()); backingDur = b.duration; } catch { /* ignore */ }
  }

  pkg.lines.forEach((l, i) => {
    const w = [];
    if (!l.imageUrl) w.push('no image');
    if (!l.caption) w.push('empty caption');
    if (!l.timestamps.length) w.push('no timestamp (laid end to end)');
    if (l.duration < 0.3) w.push(`very short audio (${l.duration.toFixed(2)}s)`);
    const prev = pkg.lines[i - 1];
    if (prev && l.start < prev.end - 0.05 && prev.characters[0] === l.characters[0]) w.push(`overlaps #${prev.order} (same character)`);
    if (backingDur && l.end > backingDur + 0.5) w.push(`ends ${(l.end - backingDur).toFixed(1)}s after the backing track`);
    if (l.characters.length > 1) w.push(`multi-speaker card (${l.characters.join(' + ')})`);
    rows.push({ l, w });
    warnings.push(...w.map((x) => `#${l.order}: ${x}`));
  });

  const rootNames = new Set(pkg.lines.flatMap((l) => [l.file, l.audioName, l.imageName].filter(Boolean).map((n) => n.toLowerCase())));
  const used = new Set([...rootNames, '_pack_info.ini', 'dub_markers.json', 'index.json', (pkg.videoName || '').toLowerCase(), (pkg.backingName || '').toLowerCase()]);
  if (pkg.icon) { const info = entries.find((e) => /_pack_info\.ini$/i.test(e.path)); if (info) used.add('__icon__'); }
  const unref = entries.map((e) => e.path.replace(/\\/g, '/').split('/').pop()).filter((n) => {
    const low = n.toLowerCase();
    if (used.has(low)) return false;
    if (pkg.skipped.includes(n)) return false;
    if (low.endsWith('.png') && pkg.icon) return false; // icon named in _pack_info
    return true;
  });

  const v = document.createElement('video');
  const videoNote = pkg.videoName
    ? (/\.og[gv]$/i.test(pkg.videoName)
      ? (v.canPlayType('video/ogg; codecs="theora"') ? 'Theora, native decode available' : 'Theora: no native decoder here, the booth will use ogv.js')
      : `native decode: ${v.canPlayType(`video/${pkg.videoName.split('.').pop()}`) || 'unknown'}`)
    : 'none (frames only)';

  const html = [];
  html.push(`<dl>
    <dt>Title</dt><dd>${esc(pkg.title)}${pkg.subtitle ? ` · ${esc(pkg.subtitle)}` : ''}</dd>
    <dt>Authors</dt><dd>${esc(pkg.authors.join(', ') || '—')}</dd>
    <dt>Readme</dt><dd>${esc(pkg.readme || '—')}</dd>
    <dt>Characters</dt><dd>${pkg.characters.map((c) => `<span class="chip">${esc(c)}</span> <span class="dim">${(byChar.get(c) || []).length} lines</span>`).join(' &nbsp; ')}</dd>
    <dt>Lines</dt><dd>${pkg.lines.length}, ${fmt(pkg.totalDuration)} to the last line's end</dd>
    <dt>Backing track</dt><dd>${pkg.hasBacking ? `<span class="ok">yes</span> ${esc(pkg.backingName)}${backingDur ? `, ${fmt(backingDur)}` : ''}` : '<span class="w">none — the dub plays over silence</span>'}</dd>
    <dt>Video</dt><dd>${pkg.videoName ? esc(pkg.videoName) : '—'} <span class="dim">${esc(videoNote)}</span></dd>
    <dt>Skipped files</dt><dd>${pkg.skipped.length ? esc(pkg.skipped.join(', ')) : '—'}</dd>
    <dt>Unreferenced files</dt><dd>${unref.length ? `<span class="w">${esc(unref.join(', '))}</span>` : '—'}</dd>
  </dl>`);
  html.push(`<div class="summary"><span><b>${pkg.lines.length}</b> lines</span><span><b>${warnings.length}</b> warning${warnings.length === 1 ? '' : 's'}</span><span><b>${pkg.characters.length}</b> characters</span></div>`);
  html.push('<div class="table-wrap"><table><thead><tr><th>#</th><th>Character</th><th>Start</th><th>Length</th><th>Line</th><th>Notes</th></tr></thead><tbody>');
  for (const { l, w } of rows) {
    html.push(`<tr class="${w.length ? 'warn' : ''}"><td class="mono">${String(l.order).padStart(2, '0')}</td><td><span class="chip">${esc(l.characters.join(' + '))}</span></td><td class="mono">${fmt(l.start)}</td><td class="mono">${l.duration.toFixed(2)}s</td><td class="cap" title="${esc(l.caption)}">${esc(l.caption)}</td><td class="w">${esc(w.join('; ')) || '<span class="ok">✓</span>'}</td></tr>`);
  }
  html.push('</tbody></table></div>');
  $('report').innerHTML = html.join('');
  $('packSummary').textContent = `${pkg.lines.length} lines · ${warnings.length} warnings`;
  $('packSummary').style.color = warnings.length ? 'var(--amber)' : 'var(--green)';
  pkg.dispose();
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt(s) { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; }

$('btnPickFolder').addEventListener('click', () => $('fileFolder').click());
$('btnPickZip').addEventListener('click', () => $('fileZip').click());
$('fileFolder').addEventListener('change', () => { if ($('fileFolder').files.length) checkEntries(entriesFromFileList($('fileFolder').files), 'folder'); $('fileFolder').value = ''; });
$('fileZip').addEventListener('change', () => { if ($('fileZip').files[0]) checkEntries(entriesFromZip($('fileZip').files[0]), $('fileZip').files[0].name); $('fileZip').value = ''; });
$('urlForm').addEventListener('submit', (e) => { e.preventDefault(); const u = $('urlInput').value.trim(); if (u) checkEntries(entriesFromUrl(u), 'URL'); });
for (const evt of ['dragenter', 'dragover']) document.addEventListener(evt, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) $('drop').classList.remove('over'); });
document.addEventListener('drop', (e) => { e.preventDefault(); $('drop').classList.remove('over'); if (e.dataTransfer) checkEntries(entriesFromDataTransfer(e.dataTransfer), 'dropped package'); });

const params = new URLSearchParams(location.search);
if (params.get('pkg')) { $('urlInput').value = params.get('pkg'); checkEntries(entriesFromUrl(params.get('pkg')), 'URL'); }

window.__tester = { checkEntries, buildZip, nativeFiles, exportFiles };
