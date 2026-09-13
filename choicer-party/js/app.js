// Choicer Party — UI wiring for the single-performer booth.
// Package in, lines listed, one line on the stage at a time: frame, caption,
// original waveform, record with a count-in, compare, nudge, then a full
// mixdown played over the clip (or a frame slideshow when there is no video).

import { entriesFromFileList, entriesFromZip, entriesFromDataTransfer, entriesFromUrl, buildPackage } from './package.js';
import { Recorder } from './recorder.js';
import { WaveformView } from './waveform.js';
import { renderMix, normalize } from './mixer.js';
import { audioBufferToWav } from './wav.js';

const $ = (id) => document.getElementById(id);
const el = {
  brandDot: $('brandDot'), packInfo: $('packInfo'), packIcon: $('packIcon'), packTitle: $('packTitle'), packMeta: $('packMeta'),
  btnChangePack: $('btnChangePack'),
  loader: $('loader'), drop: $('drop'), btnPickFolder: $('btnPickFolder'), btnPickZip: $('btnPickZip'),
  fileFolder: $('fileFolder'), fileZip: $('fileZip'), urlForm: $('urlForm'), urlInput: $('urlInput'), loadError: $('loadError'),
  studio: $('studio'), lineList: $('lineList'), takeCount: $('takeCount'),
  frame: $('frame'), charChip: $('charChip'), lineTime: $('lineTime'), recBadge: $('recBadge'), caption: $('caption'),
  wave: $('wave'),
  btnRecord: $('btnRecord'), btnRecordLabel: $('btnRecordLabel'), meter: $('meter'),
  btnPlayOrig: $('btnPlayOrig'), btnPlayTake: $('btnPlayTake'), btnPlayBoth: $('btnPlayBoth'), btnStopPlay: $('btnStopPlay'),
  nudge: $('nudge'), nudgeOut: $('nudgeOut'), monitor: $('monitor'), btnDeleteTake: $('btnDeleteTake'),
  btnPrev: $('btnPrev'), btnNext: $('btnNext'),
  dubStatus: $('dubStatus'), video: $('video'), slide: $('slide'), slideCaption: $('slideCaption'), dubEmpty: $('dubEmpty'),
  btnPlayDub: $('btnPlayDub'), btnStopDub: $('btnStopDub'), btnDownloadMix: $('btnDownloadMix'), dubTime: $('dubTime'),
  status: $('status'),
};

const TAIL = 0.5;        // seconds captured past the line's end
const PREROLL = 1.6;     // count-in before the take starts
const LEAD = 0.3;        // scheduling lead for playback

const state = {
  pkg: null,
  index: 0,
  takes: new Map(),       // lineId -> Take
  originals: new Map(),   // lineId -> AudioBuffer
  mode: 'idle',           // idle | recording | playing | dub
  session: null,          // active record session
  t0: 0,                  // context time the current timeline started
  windowLen: 0,           // seconds of the current playing/recording timeline
  mix: null,              // rendered AudioBuffer
  mixDirty: true,
  videoUrl: null,
  videoOk: false,
  videoStarted: false,
};

const recorder = new Recorder();
const wave = new WaveformView(el.wave);

/* ================================================================== */
/* Loading                                                            */

function setStatus(msg, isError = false) {
  el.status.textContent = msg;
  el.status.classList.toggle('err', isError);
}

async function loadFrom(entriesPromise, label) {
  el.loadError.hidden = true;
  setStatus(`Reading ${label}…`);
  try {
    const entries = await entriesPromise;
    const pkg = await buildPackage(entries);
    await openPackage(pkg);
  } catch (err) {
    console.error(err);
    el.loadError.textContent = err.message || String(err);
    el.loadError.hidden = false;
    setStatus(`Could not load ${label}.`, true);
  }
}

async function openPackage(pkg) {
  closePackage();
  state.pkg = pkg;
  state.index = 0;

  el.packTitle.textContent = pkg.title;
  const bits = [];
  if (pkg.subtitle) bits.push(pkg.subtitle);
  if (pkg.authors.length) bits.push(`by ${pkg.authors.join(', ')}`);
  bits.push(`${pkg.lines.length} line${pkg.lines.length === 1 ? '' : 's'}`);
  bits.push(pkg.characters.length === 1 ? `1 character` : `${pkg.characters.length} characters`);
  el.packMeta.textContent = bits.join(' · ');
  if (pkg.icon) { el.packIcon.src = pkg.url(pkg.icon); el.packIcon.hidden = false; } else el.packIcon.hidden = true;
  el.packInfo.hidden = false;
  el.btnChangePack.hidden = false;
  el.loader.hidden = true;
  el.studio.hidden = false;
  document.title = `${pkg.title} — Choicer Party`;

  await setupVideo(pkg);
  renderLineList();
  showLine(0);
  updateDubControls();
  setStatus(`Loaded “${pkg.title}”. Pick a line and hit Record.`);
}

function closePackage() {
  stopEverything();
  if (state.pkg) state.pkg.dispose();
  state.pkg = null;
  state.takes.clear();
  state.originals.clear();
  state.mix = null; state.mixDirty = true;
  state.videoUrl = null; state.videoOk = false;
  el.video.removeAttribute('src'); el.video.load(); el.video.hidden = true;
  el.slide.hidden = true; el.slideCaption.textContent = ''; el.dubEmpty.hidden = false;
}

async function setupVideo(pkg) {
  state.videoOk = false;
  if (!pkg.hasVideo) { el.dubStatus.textContent = 'no video in package · frames only'; return; }
  const ext = pkg.videoName.split('.').pop().toLowerCase();
  // Choicer Voicer exports Theora in an Ogg container. Chrome and Edge dropped
  // the Theora decoder in 2024 and Safari never had one, so `video/ogg` alone
  // reports "maybe" (the Vorbis audio track is fine) while the picture would
  // come out black. Ask about the codec itself and, belt and braces, check the
  // decoded frame size after metadata arrives.
  const probe = {
    ogv: 'video/ogg; codecs="theora"', ogg: 'video/ogg; codecs="theora"',
    webm: 'video/webm', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  }[ext] || '';
  const unsupported = `this browser has no .${ext} decoder${ext.startsWith('og') ? ' (Theora: Firefox only)' : ''} · frames only`;
  if (!probe || !el.video.canPlayType(probe)) { el.dubStatus.textContent = unsupported; return; }

  el.dubStatus.textContent = 'loading video…';
  try {
    const blob = await pkg.getVideo();
    state.videoUrl = pkg.url(blob);
    await new Promise((resolve, reject) => {
      el.video.onloadedmetadata = resolve;
      el.video.onerror = () => reject(new Error('video decode failed'));
      el.video.src = state.videoUrl;
    });
    if (!el.video.videoWidth) { el.dubStatus.textContent = unsupported; return; }
    state.videoOk = true;
    el.dubStatus.textContent = `video ${fmtTime(el.video.duration)} · ${el.video.videoWidth}×${el.video.videoHeight} · ${(blob.size / 1048576).toFixed(1)} MB`;
  } catch (err) {
    console.warn(err);
    el.dubStatus.textContent = 'video failed to load · frames only';
  }
}

/* ================================================================== */
/* Line list + stage                                                  */

function renderLineList() {
  const { pkg } = state;
  el.lineList.innerHTML = '';
  pkg.lines.forEach((line, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'line-item';
    btn.dataset.index = i;
    btn.innerHTML = `
      <img class="line-thumb" alt="" ${line.imageUrl ? `src="${line.imageUrl}"` : ''}>
      <span class="line-body">
        <span class="line-top">
          <span class="mono">${String(line.order).padStart(2, '0')}</span>
          <span class="chip">${escapeHtml(line.characters.join(' + '))}</span>
          <span class="mono">${fmtTime(line.start)}</span>
          <span class="tick" hidden>&#10003;</span>
        </span>
        <span class="line-cap">${escapeHtml(line.caption)}</span>
      </span>`;
    btn.addEventListener('click', () => { if (state.mode === 'idle') showLine(i); });
    li.appendChild(btn);
    el.lineList.appendChild(li);
  });
  refreshLineList();
}

function refreshLineList() {
  const items = el.lineList.querySelectorAll('.line-item');
  items.forEach((btn, i) => {
    const line = state.pkg.lines[i];
    const has = state.takes.has(line.id);
    btn.classList.toggle('current', i === state.index);
    btn.classList.toggle('done', has);
    btn.querySelector('.tick').hidden = !has;
  });
  el.takeCount.textContent = `${state.takes.size} / ${state.pkg.lines.length}`;
}

function currentLine() { return state.pkg.lines[state.index]; }

async function showLine(i) {
  const { pkg } = state;
  state.index = Math.max(0, Math.min(pkg.lines.length - 1, i));
  const line = currentLine();

  el.frame.src = line.imageUrl || '';
  el.charChip.textContent = line.characters.join(' + ');
  el.lineTime.textContent = `${fmtTime(line.start)} → ${fmtTime(line.end)} · ${line.duration.toFixed(2)}s`;
  el.caption.textContent = line.caption;
  el.btnPrev.disabled = state.index === 0;
  el.btnNext.disabled = state.index === pkg.lines.length - 1;

  wave.setWindow(line.duration + TAIL, line.duration);
  wave.setPlayhead(null);
  wave.setLayers([]);
  wave.draw();
  refreshLineList();
  refreshTakeControls();

  const original = await originalBuffer(line);
  if (currentLine() !== line) return; // moved on while decoding
  layerWave(line, original);
}

async function originalBuffer(line) {
  if (state.originals.has(line.id)) return state.originals.get(line.id);
  await recorder.init();
  const buf = await recorder.decode(line.wav);
  state.originals.set(line.id, buf);
  return buf;
}

function layerWave(line, original) {
  const take = state.takes.get(line.id);
  const layers = [{ buffer: original, color: getCss('--blue'), alpha: 0.85 }];
  if (take) layers.push({ samples: take.samples, sampleRate: take.sampleRate, color: getCss('--amber'), alpha: 0.8, offset: take.offset });
  wave.setLayers(layers);
  wave.draw();
}

function refreshTakeControls() {
  const take = state.takes.get(currentLine().id);
  const busy = state.mode !== 'idle';
  el.btnPlayTake.disabled = !take || busy;
  el.btnPlayBoth.disabled = !take || busy;
  el.btnPlayOrig.disabled = busy;
  el.btnDeleteTake.disabled = !take || busy;
  el.nudge.disabled = !take || busy;
  el.nudge.value = take ? Math.round(take.offset * 1000) : 0;
  el.nudgeOut.textContent = `${take ? Math.round(take.offset * 1000) : 0} ms`;
  el.btnRecordLabel.textContent = state.mode === 'recording' ? 'Stop' : (take ? 'Retake' : 'Record');
  el.btnRecord.classList.toggle('armed', state.mode === 'recording');
  el.btnRecord.disabled = busy && state.mode !== 'recording';
  el.btnStopPlay.hidden = state.mode !== 'playing';
  el.recBadge.hidden = state.mode !== 'recording';
  el.brandDot.classList.toggle('live', state.mode === 'recording');
  el.btnPrev.disabled = busy || state.index === 0;
  el.btnNext.disabled = busy || state.index === state.pkg.lines.length - 1;
  el.lineList.classList.toggle('busy', busy);
}

/* ================================================================== */
/* Recording                                                          */

async function toggleRecord() {
  if (state.mode === 'recording') { state.session?.stop(); return; }
  if (state.mode !== 'idle') return;
  const line = currentLine();
  try {
    await recorder.init();
    if (!recorder.micOpen) { setStatus('Asking for the microphone…'); await recorder.openMic(); }
  } catch (err) {
    console.error(err);
    setStatus(`Microphone unavailable: ${err.message || err}`, true);
    return;
  }
  const original = await originalBuffer(line);
  const session = recorder.record({
    duration: line.duration, preroll: PREROLL, tail: TAIL,
    monitor: el.monitor.checked ? original : null,
  });
  state.session = session;
  state.mode = 'recording';
  state.t0 = session.t0;
  state.windowLen = line.duration + TAIL;
  refreshTakeControls();
  setStatus(`Recording line ${line.order}… speak on the beat, it stops on its own.`);
  startLoop();

  const take = await session.done;
  state.session = null;
  if (state.mode === 'recording') state.mode = 'idle';
  wave.setCountdown(null);
  wave.setPlayhead(null);
  if (take.samples.length > take.sampleRate * 0.15) {
    state.takes.set(line.id, take);
    state.mixDirty = true;
    setStatus(`Take saved for line ${line.order} (${(take.samples.length / take.sampleRate).toFixed(2)}s).`);
  } else {
    setStatus('Take was too short and was discarded.');
  }
  if (currentLine() === line) layerWave(line, original);
  refreshLineList();
  refreshTakeControls();
  updateDubControls();
}

function deleteTake() {
  const line = currentLine();
  if (!state.takes.has(line.id)) return;
  state.takes.delete(line.id);
  state.mixDirty = true;
  const original = state.originals.get(line.id);
  if (original) layerWave(line, original);
  refreshLineList(); refreshTakeControls(); updateDubControls();
  setStatus(`Deleted the take for line ${line.order}.`);
}

function onNudge() {
  const take = state.takes.get(currentLine().id);
  if (!take) return;
  take.offset = Number(el.nudge.value) / 1000;
  state.mixDirty = true;
  el.nudgeOut.textContent = `${Math.round(take.offset * 1000)} ms`;
  const original = state.originals.get(currentLine().id);
  if (original) layerWave(currentLine(), original);
  updateDubControls();
}

/* ================================================================== */
/* Line playback                                                      */

async function playLine(which) {
  if (state.mode !== 'idle') return;
  const line = currentLine();
  const original = await originalBuffer(line);
  const take = state.takes.get(line.id);
  if ((which === 'take' || which === 'both') && !take) return;

  const t0 = recorder.now + LEAD;
  if (which === 'original' || which === 'both') recorder.play(original, { at: t0 });
  if (which === 'take' || which === 'both') recorder.play(recorder.takeBuffer(take), { at: t0, offset: -take.offset });

  state.mode = 'playing';
  state.t0 = t0;
  state.windowLen = line.duration + TAIL;
  refreshTakeControls();
  startLoop();
}

function stopPlayback() {
  recorder.stopAll();
  if (state.mode === 'playing') state.mode = 'idle';
  wave.setPlayhead(null); wave.draw();
  refreshTakeControls();
}

/* ================================================================== */
/* Full dub                                                           */

function updateDubControls() {
  const any = state.takes.size > 0;
  el.btnPlayDub.disabled = !any || state.mode !== 'idle';
  el.btnDownloadMix.disabled = !any || state.mode !== 'idle';
  el.btnStopDub.hidden = state.mode !== 'dub';
  el.dubEmpty.hidden = any || state.mode === 'dub';
}

async function ensureMix() {
  if (state.mix && !state.mixDirty) return state.mix;
  setStatus('Rendering mix…');
  const buf = await renderMix(state.pkg, state.takes, { sampleRate: recorder.sampleRate });
  state.mix = normalize(buf);
  state.mixDirty = false;
  return state.mix;
}

async function playDub() {
  if (state.mode !== 'idle' || !state.takes.size) return;
  await recorder.init();
  const mix = await ensureMix();
  state.mode = 'dub';
  updateDubControls(); refreshTakeControls();

  const t0 = recorder.now + LEAD;
  state.t0 = t0;
  state.windowLen = mix.duration;
  state.videoStarted = false;
  recorder.play(mix, { at: t0 });

  if (state.videoOk) {
    el.video.pause();
    el.video.currentTime = 0;
    el.video.hidden = false; el.slide.hidden = true;
  } else {
    el.video.hidden = true; el.slide.hidden = false;
  }
  el.dubEmpty.hidden = true;
  setStatus('Playing the dub.');
  startLoop();
}

function stopDub() {
  recorder.stopAll();
  el.video.pause();
  if (state.mode === 'dub') state.mode = 'idle';
  el.slideCaption.textContent = '';
  el.dubTime.textContent = '';
  updateDubControls(); refreshTakeControls();
}

async function downloadMix() {
  if (!state.takes.size) return;
  await recorder.init();
  const mix = await ensureMix();
  const blob = audioBufferToWav(mix);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(state.pkg.title)}-dub.wav`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus(`Saved ${a.download} (${(blob.size / 1048576).toFixed(1)} MB).`);
}

/* ================================================================== */
/* Animation loop: playhead, count-in, meter, dub sync                */

// requestAnimationFrame stops in a background tab (a phone that has switched
// apps mid-dub) and can stall when the compositor is not painting, so every
// frame is raced against a coarse timer: whichever fires first runs the tick.
// The worklet keeps capturing regardless; this only keeps the UI, the
// end-of-playback stop and the end-of-dub stop moving.
let rafHandle = 0;
let timerHandle = 0;
function startLoop() {
  if (rafHandle || timerHandle) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0; clearTimeout(timerHandle); timerHandle = 0; tick();
  });
  timerHandle = setTimeout(() => {
    timerHandle = 0; cancelAnimationFrame(rafHandle); rafHandle = 0; tick();
  }, 250);
}

function tick() {
  const t = recorder.now - state.t0;

  if (recorder.micOpen) el.meter.style.width = `${Math.round(recorder.inputLevel() * 100)}%`;

  if (state.mode === 'recording' || state.mode === 'playing') {
    if (t < 0) {
      wave.setCountdown(state.mode === 'recording' ? String(Math.min(3, Math.ceil(-t / 0.5))) : null);
      wave.setPlayhead(null);
    } else {
      wave.setCountdown(null);
      wave.setPlayhead(Math.min(t, state.windowLen));
    }
    wave.draw();
    if (state.mode === 'playing' && t >= state.windowLen) stopPlayback();
  } else if (state.mode === 'dub') {
    const pkg = state.pkg;
    if (t >= 0) {
      if (state.videoOk) {
        if (!state.videoStarted) { state.videoStarted = true; el.video.play().catch(() => {}); }
        else if (!el.video.paused && Math.abs(el.video.currentTime - t) > 0.09) el.video.currentTime = t;
      } else {
        const line = pkg.lines.find((l) => t >= l.start && t < l.end) || null;
        if (line && el.slide.src !== line.imageUrl) el.slide.src = line.imageUrl || '';
      }
      const line = pkg.lines.find((l) => t >= l.start && t < l.end);
      el.slideCaption.textContent = line ? line.caption : '';
      el.dubTime.textContent = `${fmtTime(t)} / ${fmtTime(state.windowLen)}`;
    }
    if (t >= state.windowLen) { stopDub(); setStatus('Dub finished.'); return; }
  }

  if (state.mode !== 'idle' || recorder.micOpen) startLoop();
}

function stopEverything() {
  state.session?.stop();
  recorder.stopAll();
  el.video.pause();
  state.mode = 'idle';
  wave.setCountdown(null); wave.setPlayhead(null);
}

/* ================================================================== */
/* Helpers                                                            */

function fmtTime(s) {
  if (s == null || Number.isNaN(s)) return '–:––';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'package'; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function getCss(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* ================================================================== */
/* Wire up                                                            */

el.btnPickFolder.addEventListener('click', () => el.fileFolder.click());
el.btnPickZip.addEventListener('click', () => el.fileZip.click());
el.fileFolder.addEventListener('change', () => { if (el.fileFolder.files.length) loadFrom(entriesFromFileList(el.fileFolder.files), 'folder'); el.fileFolder.value = ''; });
el.fileZip.addEventListener('change', () => { if (el.fileZip.files[0]) loadFrom(entriesFromZip(el.fileZip.files[0]), el.fileZip.files[0].name); el.fileZip.value = ''; });
el.urlForm.addEventListener('submit', (e) => { e.preventDefault(); const u = el.urlInput.value.trim(); if (u) loadFrom(entriesFromUrl(u), 'URL'); });

for (const evt of ['dragenter', 'dragover']) {
  document.addEventListener(evt, (e) => { e.preventDefault(); if (!el.loader.hidden) el.drop.classList.add('over'); });
}
document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) el.drop.classList.remove('over'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  el.drop.classList.remove('over');
  if (!e.dataTransfer) return;
  loadFrom(entriesFromDataTransfer(e.dataTransfer), 'dropped package');
});

el.btnChangePack.addEventListener('click', () => {
  if (state.takes.size && !confirm('Close this package? Recorded takes will be lost.')) return;
  closePackage();
  el.packInfo.hidden = true; el.btnChangePack.hidden = true;
  el.studio.hidden = true; el.loader.hidden = false;
  document.title = 'Choicer Party — dubbing booth';
  setStatus('Ready.');
});

el.btnRecord.addEventListener('click', toggleRecord);
el.btnPlayOrig.addEventListener('click', () => playLine('original'));
el.btnPlayTake.addEventListener('click', () => playLine('take'));
el.btnPlayBoth.addEventListener('click', () => playLine('both'));
el.btnStopPlay.addEventListener('click', stopPlayback);
el.btnDeleteTake.addEventListener('click', deleteTake);
el.nudge.addEventListener('input', onNudge);
el.btnPrev.addEventListener('click', () => showLine(state.index - 1));
el.btnNext.addEventListener('click', () => showLine(state.index + 1));
el.btnPlayDub.addEventListener('click', playDub);
el.btnStopDub.addEventListener('click', stopDub);
el.btnDownloadMix.addEventListener('click', downloadMix);

document.addEventListener('keydown', (e) => {
  if (!state.pkg || e.target.matches('input, textarea, select')) return;
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleRecord(); }
  else if (e.key === 'ArrowLeft' && state.mode === 'idle') { e.preventDefault(); showLine(state.index - 1); }
  else if (e.key === 'ArrowRight' && state.mode === 'idle') { e.preventDefault(); showLine(state.index + 1); }
  else if (e.key === '1') playLine('original');
  else if (e.key === '2') playLine('take');
  else if (e.key === '3') playLine('both');
  else if (e.key === 'Escape') { if (state.mode === 'playing') stopPlayback(); else if (state.mode === 'dub') stopDub(); else if (state.mode === 'recording') state.session?.stop(); }
});

window.addEventListener('beforeunload', (e) => { if (state.takes.size) { e.preventDefault(); e.returnValue = ''; } });

// ?pkg=<base url> loads a hosted package straight away (handy for testing).
const params = new URLSearchParams(location.search);
if (params.get('pkg')) { el.urlInput.value = params.get('pkg'); loadFrom(entriesFromUrl(params.get('pkg')), 'URL'); }

// Debug handle for the console.
window.__party = { state, recorder, wave, loadFrom, entriesFromZip, entriesFromUrl, buildPackage, tick };
