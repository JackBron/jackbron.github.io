// Choicer Party — UI wiring.
//
// Three ways in:
//   solo    one browser, every line, the original single-player booth
//   host    loaded the package, opens a room, deals characters, plays the dub
//   player  joined with a code on a phone, records the lines dealt to them
//
// The booth (frame, caption, waveform, record/compare/nudge) is the same code
// for all three; a room only decides which lines are yours and ships takes
// around so every peer can render the same mix.

import {
  entriesFromFileList, entriesFromZip, entriesFromDataTransfer, entriesFromUrl,
  buildPackage, summarizePackage, packageFromSummary,
} from './package.js';
import { Recorder } from './recorder.js';
import { WaveformView } from './waveform.js';
import { renderMix, normalize } from './mixer.js';
import { audioBufferToWav } from './wav.js';
import { VideoPlayer } from './video.js';

const el = new Proxy({}, { get: (_, id) => document.getElementById(id) });

const TAIL = 0.5;        // seconds captured past the line's end
const PREROLL = 1.6;     // count-in before the take starts
const LEAD = 0.3;        // scheduling lead for local playback
const ROOM_LEAD = 2.5;   // seconds between "play for everyone" and the first sample

const state = {
  mode: null,             // 'solo' | 'host' | 'player'
  pkg: null,
  index: 0,
  takes: new Map(),       // lineId -> Take (local or remote)
  originals: new Map(),   // lineId -> AudioBuffer
  play: 'idle',           // idle | recording | playing | dub
  session: null,
  t0: 0,
  windowLen: 0,
  live: null, liveLen: 0, // take being recorded, drawn as it grows
  mix: null, mixDirty: true,
  videoStarted: false,

  // room
  net: null,              // room.js module, loaded on demand
  room: null,
  selfId: null,
  code: '',
  name: '',
  roster: { hostId: null, hostName: '', hostPlays: true, players: {}, assignments: {}, phase: 'lobby' },
  manualAssign: false,
  hostOffset: 0,          // host clock minus ours, ms (player side)
  receiving: { frames: 0, audio: 0, audioTotal: 0 },
  waitTimer: 0,
};

const recorder = new Recorder();
const wave = new WaveformView(el.wave);
const video = new VideoPlayer(el.dubView);

/* ================================================================== */
/* Small helpers                                                      */

function setStatus(msg, isError = false) {
  el.status.textContent = msg;
  el.status.classList.toggle('err', isError);
}
function fmtTime(s) {
  if (s == null || Number.isNaN(s)) return '–:––';
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'package'; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function getCss(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function initials(name) { return String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(); }

function showScreen(name) {
  el.loader.hidden = name !== 'loader';
  el.lobby.hidden = name !== 'lobby';
  el.studio.hidden = name !== 'studio';
}

const inRoom = () => !!state.room;
const isHost = () => state.mode === 'host';
const isPlayer = () => state.mode === 'player';

function myName() {
  if (isHost()) return el.hostName.value.trim() || 'Host';
  if (isPlayer()) return state.name;
  return 'You';
}

/** Everyone who records: host (if performing) plus players. */
function performerIds() {
  const r = state.roster;
  const ids = r.hostPlays && r.hostId ? [r.hostId] : [];
  return ids.concat(Object.keys(r.players));
}
function nameOf(peerId) {
  const r = state.roster;
  if (peerId === r.hostId) return r.hostName || 'Host';
  return r.players[peerId]?.name || 'someone';
}
function ownerOf(line) { return inRoom() ? state.roster.assignments[line.id] || null : state.selfId; }
function isMine(line) { return !inRoom() || ownerOf(line) === state.selfId; }
function canRecord(line) { return isMine(line) && !!line.wav; }
function myLines() { return state.pkg ? state.pkg.lines.filter(isMine) : []; }
function takesFor(peerId) {
  return state.pkg.lines.filter((l) => state.roster.assignments[l.id] === peerId);
}

/* ================================================================== */
/* Loading a package (host / solo)                                    */

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
  resetAll();
  state.pkg = pkg;
  state.mode = 'host';
  showPackInfo(pkg);
  el.btnLeave.hidden = false;
  showScreen('lobby');
  el.lobbyHost.hidden = false;
  el.lobbyPlayer.hidden = true;
  renderHostLobby();
  setStatus(`Loaded “${pkg.title}”. Open a room for friends, or go solo.`);
  setupVideo(pkg); // in the background; the dub panel reports when it is ready
}

function showPackInfo(pkg) {
  el.packTitle.textContent = pkg.title;
  const bits = [];
  if (pkg.subtitle) bits.push(pkg.subtitle);
  if (pkg.authors?.length) bits.push(`by ${pkg.authors.join(', ')}`);
  bits.push(`${pkg.lines.length} line${pkg.lines.length === 1 ? '' : 's'}`);
  bits.push(pkg.characters.length === 1 ? '1 character' : `${pkg.characters.length} characters`);
  el.packMeta.textContent = bits.join(' · ');
  if (pkg.icon) { el.packIcon.src = pkg.url(pkg.icon); el.packIcon.hidden = false; } else el.packIcon.hidden = true;
  el.packInfo.hidden = false;
  document.title = `${pkg.title} — Choicer Party`;
}

async function setupVideo(pkg) {
  if (!pkg.hasVideo) { el.dubStatus.textContent = 'no video in package · frames only'; return; }
  el.dubStatus.textContent = 'loading video…';
  try {
    const blob = await pkg.getVideo();
    const r = await video.load(blob, pkg.videoName);
    if (state.pkg !== pkg) return;
    el.dubStatus.textContent = r.ok
      ? `video ${fmtTime(video.duration)} · ${video.videoWidth}×${video.videoHeight} · ${r.engine === 'ogv' ? 'ogv.js decoder' : 'native'}`
      : `video unplayable (${r.reason}) · frames only`;
  } catch (err) {
    console.warn(err);
    el.dubStatus.textContent = 'video failed to load · frames only';
  }
}

function resetAll() {
  stopEverything();
  if (state.room) { try { state.room.leave(); } catch { /* ignore */ } }
  clearTimeout(state.waitTimer);
  if (state.pkg) state.pkg.dispose();
  video.dispose();
  Object.assign(state, {
    mode: null, pkg: null, index: 0, room: null, code: '', name: '',
    roster: { hostId: null, hostName: '', hostPlays: true, players: {}, assignments: {}, phase: 'lobby' },
    manualAssign: false, hostOffset: 0, mix: null, mixDirty: true,
    receiving: { frames: 0, audio: 0, audioTotal: 0 },
  });
  state.takes.clear(); state.originals.clear();
  el.slide.hidden = true; el.slideCaption.textContent = ''; el.dubEmpty.hidden = false;
  el.roomBadge.hidden = true; el.roomBar.hidden = true; el.studio.classList.remove('in-room');
  el.packInfo.hidden = true; el.btnLeave.hidden = true;
  el.roomCodeWrap.hidden = true; el.playersBox.hidden = true; el.assignCard.hidden = true;
  el.btnOpenRoom.disabled = false; el.btnOpenRoom.hidden = false; el.btnSolo.hidden = false;
  el.btnPlayAll.hidden = true;
  el.dubStatus.textContent = '';
  document.title = 'Choicer Party — dubbing booth';
}

function leaveEverything() {
  if (state.takes.size && !confirm('Leave? Recorded takes on this device will be lost.')) return;
  resetAll();
  showScreen('loader');
  setStatus('Ready.');
}

/* ================================================================== */
/* Room plumbing                                                      */

async function net() {
  if (!state.net) {
    setStatus('Loading the room library…');
    state.net = await import('./room.js');
    state.selfId = state.net.selfId;
  }
  return state.net;
}

function wireRoom(room) {
  room.on('hello', onHello);
  room.on('roster', onRoster);
  room.on('pack', onPack);
  room.on('frame', onFrame);
  room.on('audio', onAudio);
  room.on('take', onTakeMsg);
  room.on('progress', onProgressMsg);
  room.on('play', onPlayMsg);
  room.on('stop', () => stopDub());
  room.onPeerJoin(onPeerJoin);
  room.onPeerLeave(onPeerLeave);
  room.onProgress('frame', (pct, peerId, meta) => { if (isPlayer()) el.receiving.textContent = `frame ${meta?.lineId?.slice(0, 3) || ''} ${Math.round(pct * 100)}%`; });
  room.onProgress('audio', (pct, peerId, meta) => { if (isPlayer()) el.receiving.textContent = `audio ${meta?.lineId?.slice(0, 3) || ''} ${Math.round(pct * 100)}%`; });
}

function updateRoomBadge() {
  if (!inRoom()) { el.roomBadge.hidden = true; return; }
  const n = Object.keys(state.roster.players).length;
  el.roomBadge.textContent = `${state.code} · ${n} player${n === 1 ? '' : 's'}`;
  el.roomBadge.hidden = false;
  el.roomBarCode.textContent = state.code;
}

/* -------------------------- host side -------------------------- */

async function openRoom() {
  const { Room, makeCode, selfId } = await net();
  el.btnOpenRoom.disabled = true;
  state.code = makeCode();
  state.room = new Room(state.code);
  state.roster.hostId = selfId;
  state.roster.hostName = myName();
  state.roster.hostPlays = el.hostPlays.checked;
  wireRoom(state.room);

  el.roomCode.textContent = state.code;
  const link = new URL(location.href);
  link.search = `?room=${state.code}`;
  el.roomLink.textContent = link.href.replace(/^https?:\/\//, '');
  el.roomCodeWrap.hidden = false;
  el.playersBox.hidden = false;
  el.assignCard.hidden = false;
  el.btnOpenRoom.hidden = true;
  el.btnSolo.hidden = true;
  el.roomState.textContent = 'Waiting for players. Anyone who opens the link or types the code will appear here.';
  updateRoomBadge();
  dealIfAuto();
  renderHostLobby();
  setStatus(`Room ${state.code} is open.`);
}

function onPeerJoin(peerId) {
  if (isPlayer()) {
    // Say hello to everyone; only the host cares, but we do not know who that is yet.
    state.room.send('hello', { name: state.name, role: 'player' }, peerId);
  }
}

function onPeerLeave(peerId) {
  if (isHost()) {
    if (state.roster.players[peerId]) {
      setStatus(`${nameOf(peerId)} left the room.`);
      delete state.roster.players[peerId];
      dealIfAuto();
      broadcastRoster();
      renderHostLobby(); renderRoomBar(); refreshLineList();
    }
  } else if (isPlayer() && peerId === state.roster.hostId) {
    setStatus('The host disconnected.', true);
    el.pWait.textContent = 'The host disconnected. Ask them to reopen the room, then rejoin.';
  }
}

function onHello(msg, peerId) {
  if (!isHost() || msg?.role !== 'player') return;
  const fresh = !state.roster.players[peerId];
  state.roster.players[peerId] = { name: String(msg.name || 'Player').slice(0, 24) };
  if (fresh) setStatus(`${nameOf(peerId)} joined.`);
  dealIfAuto();
  broadcastRoster();
  state.room.send('pack', summarizePackage(state.pkg), peerId);
  if (state.roster.phase !== 'lobby') sendAssets(peerId); // late joiner
  renderHostLobby(); renderRoomBar(); refreshLineList();
}

function dealIfAuto() {
  if (!state.net || !state.room || !state.pkg) return;
  if (state.manualAssign || state.roster.phase !== 'lobby') return;
  state.roster.assignments = state.net.autoAssign(state.pkg.lines, state.pkg.characters, performerIds());
}

function broadcastRoster() {
  if (!isHost() || !state.room) return;
  state.room.send('roster', { ...state.roster, code: state.code });
  updateRoomBadge();
}

function renderHostLobby() {
  if (!isHost()) return;
  const r = state.roster;
  const perf = performerIds();
  // players
  el.playerCount.textContent = `(${Object.keys(r.players).length})`;
  const items = [];
  const hostLine = `<li><span class="avatar">${escapeHtml(initials(myName()))}</span><span class="who">${escapeHtml(myName())}</span><span class="role">host${r.hostPlays ? ' · performing' : ' · not performing'}</span></li>`;
  items.push(hostLine);
  for (const [id, p] of Object.entries(r.players)) {
    const chars = [...new Set(takesFor(id).flatMap((l) => l.characters))];
    items.push(`<li><span class="avatar">${escapeHtml(initials(p.name))}</span><span class="who">${escapeHtml(p.name)}</span>${chars.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')}<span class="role">${takesFor(id).length} lines</span></li>`);
  }
  if (!Object.keys(r.players).length) items.push('<li class="none">nobody yet</li>');
  el.playerList.innerHTML = items.join('');

  // assignment table
  const tb = el.assignTable.querySelector('tbody');
  tb.innerHTML = state.pkg.lines.map((l) => {
    const opts = [`<option value="">—</option>`].concat(perf.map((id) => `<option value="${id}" ${r.assignments[l.id] === id ? 'selected' : ''}>${escapeHtml(nameOf(id))}</option>`));
    return `<tr><td class="mono">${String(l.order).padStart(2, '0')}</td><td><span class="chip">${escapeHtml(l.characters.join(' + '))}</span></td><td class="cap" title="${escapeHtml(l.caption)}">${escapeHtml(l.caption)}</td><td><select data-line="${l.id}" ${r.phase !== 'lobby' ? 'disabled' : ''}>${opts.join('')}</select></td></tr>`;
  }).join('');
  tb.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', () => {
    state.manualAssign = true;
    if (sel.value) r.assignments[sel.dataset.line] = sel.value; else delete r.assignments[sel.dataset.line];
    broadcastRoster(); renderHostLobby();
  }));

  const assigned = state.pkg.lines.filter((l) => r.assignments[l.id]).length;
  const unassigned = state.pkg.lines.length - assigned;
  el.assignHint.textContent = perf.length === 0
    ? 'No performers yet. Tick "I\'m performing too" or wait for players.'
    : perf.length > state.pkg.characters.length
      ? `More performers than characters, so lines are dealt round-robin.${unassigned ? ` ${unassigned} unassigned.` : ''}`
      : `Each performer takes whole characters.${unassigned ? ` ${unassigned} unassigned.` : ''}`;
  el.btnStart.disabled = assigned === 0 || r.phase !== 'lobby';
  el.btnRedeal.disabled = r.phase !== 'lobby';
}

async function startRecordingPhase() {
  if (!isHost() || !state.room) return;
  state.roster.hostName = myName();
  state.roster.phase = 'record';
  broadcastRoster();
  enterBooth();
  setStatus('Sending frames and lines to players…');
  await sendAssets(null);
  setStatus('Everyone has their lines. Record yours, watch the room bar for the others.');
}

/** Frames to everyone (or one peer), each line's original audio to its performer. */
async function sendAssets(target) {
  const { room, pkg, roster } = state;
  const peers = target ? [target] : room.peers();
  if (!peers.length) return;
  await room.send('pack', summarizePackage(pkg), target || undefined);
  for (const l of pkg.lines) {
    if (l.image) await room.send('frame', new Uint8Array(await l.image.arrayBuffer()), target || undefined, { lineId: l.id });
  }
  for (const l of pkg.lines) {
    const owner = roster.assignments[l.id];
    if (!owner || owner === state.selfId) continue;
    if (target && owner !== target) continue;
    await room.send('audio', new Uint8Array(await l.wav.arrayBuffer()), owner, { lineId: l.id });
  }
  // a late joiner also needs the takes recorded so far
  if (target) {
    for (const [lineId, take] of state.takes) {
      const enc = state.net.encodeTake(lineId, take, take.by || myName());
      await room.send('take', enc.data, target, enc.meta);
    }
  }
}

/* -------------------------- player side -------------------------- */

async function joinRoomAs(codeRaw, nameRaw) {
  const { Room, normalizeCode, selfId } = await net();
  const code = normalizeCode(codeRaw);
  const name = nameRaw.trim().slice(0, 24);
  if (code.length < 4) { el.joinError.textContent = 'Room codes are four letters.'; el.joinError.hidden = false; return; }
  if (!name) { el.joinError.textContent = 'Pick a name so the host knows who you are.'; el.joinError.hidden = false; return; }
  el.joinError.hidden = true;
  resetAll();
  recorder.init().catch(() => {}); // unlock audio on this gesture for later scheduled playback
  state.mode = 'player';
  state.code = code; state.name = name;
  state.room = new Room(code);
  wireRoom(state.room);
  for (const p of state.room.peers()) state.room.send('hello', { name, role: 'player' }, p);

  el.pRoomCode.textContent = code; el.pName.textContent = name; el.pHost.textContent = '';
  el.pWait.textContent = 'Looking for the host…';
  el.pCharacters.innerHTML = '<span class="dim">waiting for the host to deal parts…</span>';
  el.pLines.textContent = ''; el.pPlayerList.innerHTML = ''; el.pPlayerCount.textContent = '';
  el.btnLeave.hidden = false;
  showScreen('lobby'); el.lobbyHost.hidden = true; el.lobbyPlayer.hidden = false;
  updateRoomBadge();
  setStatus(`Joined ${code} as ${name}. Finding the host…`);
  clearTimeout(state.waitTimer);
  state.waitTimer = setTimeout(() => {
    if (isPlayer() && !state.roster.hostId) el.pWait.textContent = 'Still looking. Check the code with the host, and that both of you are online.';
  }, 15000);
}

async function onRoster(msg, peerId) {
  if (!isPlayer()) return;
  if (state.roster.hostId && peerId !== state.roster.hostId) return; // only the host we know
  const firstTime = !state.roster.hostId;
  const was = state.roster.phase;
  state.roster = { hostId: peerId, hostName: msg.hostName, hostPlays: msg.hostPlays, players: msg.players || {}, assignments: msg.assignments || {}, phase: msg.phase || 'lobby' };
  updateRoomBadge();
  renderPlayerLobby();
  renderRoomBar(); refreshLineList();
  if (firstTime) {
    setStatus(`Connected to ${nameOf(peerId)}'s room.`);
    syncToHost();
  }
  if (state.roster.phase !== 'lobby' && state.pkg && el.studio.hidden) enterBooth();
  if (state.roster.phase !== was && state.roster.phase === 'record') syncToHost();
  if (!el.studio.hidden) { refreshTakeControls(); updateDubControls(); }
}

async function syncToHost() {
  if (!state.room || !state.roster.hostId) return;
  const r = await state.room.syncClock(state.roster.hostId);
  if (r) { state.hostOffset = r.offset; console.info(`clock offset to host ${r.offset.toFixed(1)} ms (rtt ${r.rtt.toFixed(0)} ms)`); }
}

function onPack(summary, peerId) {
  if (!isPlayer()) return;
  if (state.roster.hostId && peerId !== state.roster.hostId) return;
  if (state.pkg && state.pkg.title === summary.title && state.pkg.lines.length === summary.lines.length) return; // already have it
  const old = state.pkg;
  state.pkg = packageFromSummary(summary);
  // keep any assets that already arrived (frames can outrun the summary on a reconnect)
  if (old) for (const l of old.lines) { const n = state.pkg.lineById(l.id); if (n) { n.image = l.image; n.imageUrl = l.imageUrl; n.wav = l.wav; } }
  showPackInfo(state.pkg);
  state.mixDirty = true;
  renderPlayerLobby();
  if (state.roster.phase !== 'lobby' && el.studio.hidden) enterBooth();
  else if (!el.studio.hidden) { renderLineList(); showLine(state.index); }
}

function onFrame(buffer, peerId, meta) {
  if (!isPlayer() || !state.pkg) return;
  const line = state.pkg.lineById(meta?.lineId);
  if (!line) return;
  line.image = new Blob([buffer], { type: 'image/png' });
  line.imageUrl = state.pkg.url(line.image);
  state.receiving.frames++;
  el.receiving.textContent = '';
  if (!el.studio.hidden) {
    const thumb = el.lineList.querySelector(`[data-line="${line.id}"] img`);
    if (thumb) thumb.src = line.imageUrl;
    if (state.pkg.lines[state.index] === line) { el.frame.src = line.imageUrl; el.frameEmpty.hidden = true; }
  }
}

async function onAudio(buffer, peerId, meta) {
  if (!isPlayer() || !state.pkg) return;
  const line = state.pkg.lineById(meta?.lineId);
  if (!line) return;
  line.wav = new Blob([buffer], { type: 'audio/wav' });
  state.originals.delete(line.id);
  state.receiving.audio++;
  el.receiving.textContent = '';
  if (!el.studio.hidden && state.pkg.lines[state.index] === line) showLine(state.index);
  renderPlayerLobby();
}

function renderPlayerLobby() {
  if (!isPlayer()) return;
  const r = state.roster;
  el.pHost.textContent = r.hostId ? `Hosted by ${nameOf(r.hostId)}.` : '';
  const mine = state.pkg ? myLines() : [];
  if (state.pkg && r.hostId) {
    const chars = [...new Set(mine.flatMap((l) => l.characters))];
    el.pCharacters.innerHTML = chars.length
      ? chars.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')
      : '<span class="dim">nothing yet — the host may still be dealing</span>';
    el.pLines.textContent = mine.length ? `${mine.length} line${mine.length === 1 ? '' : 's'} · ${mine.map((l) => `#${l.order}`).join(', ')}` : '';
  }
  const items = [];
  if (r.hostId) items.push(`<li><span class="avatar">${escapeHtml(initials(r.hostName))}</span><span class="who">${escapeHtml(r.hostName)}</span><span class="role">host${r.hostPlays ? ' · performing' : ''}</span></li>`);
  for (const [id, p] of Object.entries(r.players)) {
    items.push(`<li><span class="avatar">${escapeHtml(initials(p.name))}</span><span class="who">${escapeHtml(p.name)}${id === state.selfId ? ' (you)' : ''}</span></li>`);
  }
  el.pPlayerList.innerHTML = items.join('');
  el.pPlayerCount.textContent = items.length ? `(${items.length})` : '';
  if (r.hostId) el.pWait.textContent = r.phase === 'lobby' ? 'Waiting for the host to start…' : 'Starting…';
}

/* -------------------------- shared: takes on the wire -------------------------- */

function onTakeMsg(buffer, peerId, meta) {
  if (!state.pkg || !meta?.lineId) return;
  const line = state.pkg.lineById(meta.lineId);
  if (!line) return;
  if (inRoom() && ownerOf(line) && ownerOf(line) !== peerId && peerId !== state.roster.hostId) return; // not theirs to send
  const take = state.net.decodeTake(buffer, meta);
  state.takes.set(line.id, take);
  state.mixDirty = true;
  if (!el.studio.hidden) {
    if (state.pkg.lines[state.index] === line) refreshStageTake(line);
    refreshLineList(); refreshTakeControls(); updateDubControls(); renderRoomBar();
  }
  if (isHost()) renderHostLobby();
  setStatus(`${take.by || nameOf(peerId)} recorded line ${line.order}.`);
}

function onProgressMsg(msg, peerId) {
  if (!state.pkg || msg?.status !== 'deleted') return;
  const line = state.pkg.lineById(msg.lineId);
  if (!line || ownerOf(line) !== peerId) return;
  state.takes.delete(line.id);
  state.mixDirty = true;
  if (!el.studio.hidden) {
    if (state.pkg.lines[state.index] === line) refreshStageTake(line);
    refreshLineList(); refreshTakeControls(); updateDubControls(); renderRoomBar();
  }
}

function shareTake(line, take) {
  if (!inRoom()) return;
  const enc = state.net.encodeTake(line.id, take, myName());
  state.room.send('take', enc.data, undefined, enc.meta);
}

function onPlayMsg(msg, peerId) {
  if (!isPlayer() || peerId !== state.roster.hostId) return;
  const localPerf = msg.at - state.hostOffset;                 // host clock -> ours
  const ctxAt = recorder.now + (localPerf - performance.now()) / 1000;
  startDub(ctxAt);
}

/* ================================================================== */
/* Booth                                                              */

function enterBooth() {
  showScreen('studio');
  const room = inRoom();
  el.roomBar.hidden = !room;
  el.studio.classList.toggle('in-room', room);
  el.btnPlayAll.hidden = !isHost() || !room;
  renderLineList();
  const first = state.pkg.lines.findIndex(isMine);
  showLine(first >= 0 ? first : 0);
  renderRoomBar();
  updateDubControls();
  if (isPlayer()) el.pWait.textContent = '';
}

function renderLineList() {
  const { pkg } = state;
  el.lineList.innerHTML = '';
  pkg.lines.forEach((line, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'line-item';
    btn.dataset.index = i; btn.dataset.line = line.id;
    btn.innerHTML = `
      <img class="line-thumb" alt="" ${line.imageUrl ? `src="${line.imageUrl}"` : ''}>
      <span class="line-body">
        <span class="line-top">
          <span class="mono">${String(line.order).padStart(2, '0')}</span>
          <span class="chip">${escapeHtml(line.characters.join(' + '))}</span>
          <span class="mono">${fmtTime(line.start)}</span>
          <span class="by"></span>
          <span class="tick" hidden>&#10003;</span>
        </span>
        <span class="line-cap">${escapeHtml(line.caption)}</span>
      </span>`;
    btn.addEventListener('click', () => { if (state.play === 'idle') showLine(i); });
    li.appendChild(btn);
    el.lineList.appendChild(li);
  });
  refreshLineList();
}

function refreshLineList() {
  if (!state.pkg || el.studio.hidden) return;
  const items = el.lineList.querySelectorAll('.line-item');
  items.forEach((btn, i) => {
    const line = state.pkg.lines[i];
    const has = state.takes.has(line.id);
    const mine = isMine(line);
    btn.classList.toggle('current', i === state.index);
    btn.classList.toggle('done', has);
    btn.classList.toggle('theirs', inRoom() && !mine);
    btn.querySelector('.tick').hidden = !has;
    const by = btn.querySelector('.by');
    by.textContent = inRoom() ? (ownerOf(line) ? (mine ? 'you' : nameOf(ownerOf(line))) : 'unassigned') : '';
  });
  const mine = myLines();
  const mineDone = mine.filter((l) => state.takes.has(l.id)).length;
  el.takeCount.textContent = inRoom() ? `you ${mineDone} / ${mine.length} · all ${state.takes.size} / ${state.pkg.lines.length}` : `${state.takes.size} / ${state.pkg.lines.length}`;
}

function currentLine() { return state.pkg.lines[state.index]; }

async function showLine(i) {
  const { pkg } = state;
  state.index = Math.max(0, Math.min(pkg.lines.length - 1, i));
  const line = currentLine();

  el.frame.src = line.imageUrl || '';
  el.frameEmpty.hidden = !!line.imageUrl;
  el.charChip.textContent = line.characters.join(' + ');
  el.lineTime.textContent = `${fmtTime(line.start)} → ${fmtTime(line.end)} · ${line.duration.toFixed(2)}s`;
  el.caption.textContent = line.caption;
  if (inRoom()) {
    const o = ownerOf(line);
    el.ownerChip.textContent = o ? (isMine(line) ? 'your line' : `${nameOf(o)}'s line`) : 'unassigned';
    el.ownerChip.hidden = false;
  } else el.ownerChip.hidden = true;

  wave.setWindow(line.duration + TAIL, line.duration);
  wave.setPlayhead(null);
  wave.setLayers([]);
  wave.draw();
  refreshLineList();
  refreshTakeControls();

  const original = await originalBuffer(line);
  if (currentLine() !== line) return;
  layerWave(line, original);
}

async function originalBuffer(line) {
  if (!line.wav) return null;
  if (state.originals.has(line.id)) return state.originals.get(line.id);
  await recorder.init();
  const buf = await recorder.decode(line.wav);
  state.originals.set(line.id, buf);
  return buf;
}

function layerWave(line, original) {
  const take = state.takes.get(line.id);
  const layers = [];
  if (original) layers.push({ buffer: original, color: getCss('--blue'), alpha: 0.85 });
  if (take) layers.push({ samples: take.samples, sampleRate: take.sampleRate, color: getCss('--amber'), alpha: 0.8, offset: take.offset });
  wave.setLayers(layers);
  wave.draw();
}

function refreshStageTake(line) {
  layerWave(line, state.originals.get(line.id) || null);
}

function refreshTakeControls() {
  if (!state.pkg) return;
  const line = currentLine();
  const take = state.takes.get(line.id);
  const busy = state.play !== 'idle';
  const mine = isMine(line);
  const hasOriginal = !!line.wav;
  el.btnPlayTake.disabled = !take || busy;
  el.btnPlayBoth.disabled = !take || !hasOriginal || busy;
  el.btnPlayOrig.disabled = !hasOriginal || busy;
  el.btnDeleteTake.disabled = !take || !mine || busy;
  el.nudge.disabled = !take || !mine || busy;
  el.nudge.value = take ? Math.round(take.offset * 1000) : 0;
  el.nudgeOut.textContent = `${take ? Math.round(take.offset * 1000) : 0} ms`;
  el.btnRecordLabel.textContent = state.play === 'recording' ? 'Stop' : (take ? 'Retake' : 'Record');
  el.btnRecord.classList.toggle('armed', state.play === 'recording');
  el.btnRecord.disabled = state.play === 'recording' ? false : (busy || !canRecord(line));
  el.btnRecord.title = !mine ? 'Not your line' : (!hasOriginal ? 'Waiting for the line audio to arrive' : '');
  el.btnStopPlay.hidden = state.play !== 'playing';
  el.recBadge.hidden = state.play !== 'recording';
  el.brandDot.classList.toggle('live', state.play === 'recording');
  el.btnPrev.disabled = busy || state.index === 0;
  el.btnNext.disabled = busy || state.index === state.pkg.lines.length - 1;
  const mineLeft = myLines().filter((l) => !state.takes.has(l.id)).length;
  el.pagerHint.textContent = inRoom() ? (mineLeft ? `${mineLeft} of yours left` : (myLines().length ? 'all yours recorded' : '')) : '';
}

/* ---------- recording ---------- */

async function toggleRecord() {
  if (state.play === 'recording') { state.session?.stop(); return; }
  if (state.play !== 'idle') return;
  const line = currentLine();
  if (!canRecord(line)) return;
  try {
    await recorder.init();
    if (!recorder.micOpen) { setStatus('Asking for the microphone…'); await recorder.openMic(); }
  } catch (err) {
    console.error(err);
    setStatus(`Microphone unavailable: ${err.message || err}`, true);
    return;
  }
  const original = await originalBuffer(line);
  const sr = recorder.sampleRate;
  state.live = new Float32Array(Math.round((line.duration + TAIL) * sr) + 8192);
  state.liveLen = 0;
  wave.setLayers([
    { buffer: original, color: getCss('--blue'), alpha: 0.85 },
    { samples: state.live, sampleRate: sr, length: 0, color: getCss('--amber'), alpha: 0.85 },
  ]);

  const session = recorder.record({
    duration: line.duration, preroll: PREROLL, tail: TAIL,
    monitor: el.monitor.checked ? original : null,
    onChunk: (chunk) => {
      const n = Math.min(chunk.length, state.live.length - state.liveLen);
      if (n <= 0) return;
      state.live.set(chunk.subarray(0, n), state.liveLen);
      state.liveLen += n;
      wave.setLayerLength(1, state.liveLen);
    },
  });
  state.session = session;
  state.play = 'recording';
  state.t0 = session.t0;
  state.windowLen = line.duration + TAIL;
  refreshTakeControls();
  setStatus(`Recording line ${line.order}… it stops on its own.`);
  startLoop();

  const take = await session.done;
  state.session = null;
  if (state.play === 'recording') state.play = 'idle';
  wave.setCountdown(null); wave.setPlayhead(null);
  state.live = null; state.liveLen = 0;
  if (take.samples.length > take.sampleRate * 0.15) {
    take.by = myName();
    state.takes.set(line.id, take);
    state.mixDirty = true;
    shareTake(line, take);
    setStatus(`Take saved for line ${line.order} (${(take.samples.length / take.sampleRate).toFixed(2)}s).`);
  } else {
    setStatus('Take was too short and was discarded.');
  }
  if (currentLine() === line) layerWave(line, original);
  refreshLineList(); refreshTakeControls(); updateDubControls(); renderRoomBar();
  if (isHost()) renderHostLobby();
}

function deleteTake() {
  const line = currentLine();
  if (!state.takes.has(line.id) || !isMine(line)) return;
  state.takes.delete(line.id);
  state.mixDirty = true;
  if (inRoom()) state.room.send('progress', { lineId: line.id, status: 'deleted' });
  refreshStageTake(line);
  refreshLineList(); refreshTakeControls(); updateDubControls(); renderRoomBar();
  setStatus(`Deleted the take for line ${line.order}.`);
}

let nudgeShareTimer = 0;
function onNudge() {
  const line = currentLine();
  const take = state.takes.get(line.id);
  if (!take || !isMine(line)) return;
  take.offset = Number(el.nudge.value) / 1000;
  state.mixDirty = true;
  el.nudgeOut.textContent = `${Math.round(take.offset * 1000)} ms`;
  refreshStageTake(line);
  updateDubControls();
  clearTimeout(nudgeShareTimer);
  nudgeShareTimer = setTimeout(() => shareTake(line, take), 600);
}

/* ---------- line playback ---------- */

async function playLine(which) {
  if (state.play !== 'idle') return;
  const line = currentLine();
  const original = await originalBuffer(line);
  const take = state.takes.get(line.id);
  if ((which === 'take' || which === 'both') && !take) return;
  if ((which === 'original' || which === 'both') && !original) return;

  const t0 = recorder.now + LEAD;
  if (which === 'original' || which === 'both') recorder.play(original, { at: t0 });
  if (which === 'take' || which === 'both') recorder.play(recorder.takeBuffer(take), { at: t0, offset: -take.offset });

  state.play = 'playing';
  state.t0 = t0;
  state.windowLen = line.duration + TAIL;
  refreshTakeControls();
  startLoop();
}

function stopPlayback() {
  recorder.stopAll();
  if (state.play === 'playing') state.play = 'idle';
  wave.setPlayhead(null); wave.draw();
  refreshTakeControls();
}

/* ================================================================== */
/* Full dub                                                           */

function updateDubControls() {
  if (!state.pkg) return;
  const any = state.takes.size > 0;
  const idle = state.play === 'idle';
  el.btnPlayDub.disabled = !any || !idle;
  el.btnPlayAll.disabled = !any || !idle;
  el.btnDownloadMix.disabled = !any || !idle;
  el.btnStopDub.hidden = state.play !== 'dub';
  el.dubEmpty.hidden = any || state.play === 'dub';
}

async function ensureMix() {
  if (state.mix && !state.mixDirty) return state.mix;
  setStatus('Rendering mix…');
  const buf = await renderMix(state.pkg, state.takes, { sampleRate: recorder.sampleRate });
  state.mix = normalize(buf);
  state.mixDirty = false;
  return state.mix;
}

/** Start the dub with the first sample at AudioContext time `ctxAt` (or soon). */
async function startDub(ctxAt = null) {
  if (!state.takes.size) return;
  if (state.play !== 'idle') stopDub();
  await recorder.init();
  const mix = await ensureMix();
  state.play = 'dub';
  updateDubControls(); refreshTakeControls();

  const now = recorder.now;
  let t0 = ctxAt ?? now + LEAD;
  if (t0 < now + 0.02) {
    // The moment already passed (slow render, late message): start now, skipped in.
    const skip = now + 0.02 - t0;
    recorder.play(mix, { at: now + 0.02, offset: skip });
  } else {
    recorder.play(mix, { at: t0 });
  }
  state.t0 = t0;
  state.windowLen = mix.duration;
  state.videoStarted = false;
  if (video.ok) { video.show(true); el.slide.hidden = true; } else { video.show(false); el.slide.hidden = false; }
  el.dubEmpty.hidden = true;
  setStatus(ctxAt ? `Dub starts in ${Math.max(0, t0 - now).toFixed(1)}s…` : 'Playing the dub.');
  startLoop();
}

function stopDub() {
  recorder.stopAll();
  video.pause();
  if (state.play === 'dub') state.play = 'idle';
  el.slideCaption.textContent = '';
  el.dubTime.textContent = '';
  updateDubControls(); refreshTakeControls();
}

function playForEveryone() {
  if (!isHost() || !state.room || !state.takes.size) return;
  const at = performance.now() + ROOM_LEAD * 1000;
  state.room.send('play', { at });
  startDub(recorder.now + ROOM_LEAD);
}

function stopForEveryone() {
  if (isHost() && state.room) state.room.send('stop', {});
  stopDub();
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
/* Room bar in the booth                                              */

function renderRoomBar() {
  if (!inRoom() || !state.pkg || el.studio.hidden) return;
  const perf = performerIds();
  el.perfChips.innerHTML = perf.map((id) => {
    const lines = takesFor(id);
    const done = lines.filter((l) => state.takes.has(l.id)).length;
    const pct = lines.length ? Math.round((done / lines.length) * 100) : 0;
    return `<span class="perf-chip ${id === state.selfId ? 'me' : ''}" title="${escapeHtml(nameOf(id))}: ${done}/${lines.length}">
      <span class="avatar">${escapeHtml(initials(nameOf(id)))}</span>${escapeHtml(nameOf(id))}
      <span class="bar"><i style="width:${pct}%"></i></span><span class="mono">${done}/${lines.length}</span></span>`;
  }).join('');
  const assigned = state.pkg.lines.filter((l) => state.roster.assignments[l.id]).length;
  el.roomProgress.textContent = `${state.takes.size} / ${assigned} recorded`;
  if (isPlayer()) {
    const mine = myLines().length;
    const got = myLines().filter((l) => l.wav).length;
    const frames = state.pkg.lines.filter((l) => l.imageUrl).length;
    el.receiving.textContent = (got < mine || frames < state.pkg.lines.length) ? `receiving… frames ${frames}/${state.pkg.lines.length}, lines ${got}/${mine}` : '';
  }
}

/* ================================================================== */
/* Animation loop                                                     */

// requestAnimationFrame stops in a background tab and can stall when the
// compositor is not painting, so each frame is raced against a coarse timer.
let rafHandle = 0;
let timerHandle = 0;
function startLoop() {
  if (rafHandle || timerHandle) return;
  rafHandle = requestAnimationFrame(() => { rafHandle = 0; clearTimeout(timerHandle); timerHandle = 0; tick(); });
  timerHandle = setTimeout(() => { timerHandle = 0; cancelAnimationFrame(rafHandle); rafHandle = 0; tick(); }, 250);
}

function tick() {
  const t = recorder.now - state.t0;
  if (recorder.micOpen) el.meter.style.width = `${Math.round(recorder.inputLevel() * 100)}%`;

  if (state.play === 'recording' || state.play === 'playing') {
    if (t < 0) {
      wave.setCountdown(state.play === 'recording' ? String(Math.min(3, Math.ceil(-t / 0.5))) : null);
      wave.setPlayhead(null);
    } else {
      wave.setCountdown(null);
      wave.setPlayhead(Math.min(t, state.windowLen));
    }
    wave.draw();
    if (state.play === 'playing' && t >= state.windowLen) stopPlayback();
  } else if (state.play === 'dub') {
    const pkg = state.pkg;
    if (t >= 0) {
      const line = pkg.lines.find((l) => t >= l.start && t < l.end) || null;
      if (video.ok) {
        if (!state.videoStarted) { state.videoStarted = true; video.start().catch(() => {}); }
        else video.sync(t);
      } else if (line && line.imageUrl && el.slide.src !== line.imageUrl) {
        el.slide.src = line.imageUrl;
      }
      el.slideCaption.textContent = line ? line.caption : '';
      el.dubTime.textContent = `${fmtTime(t)} / ${fmtTime(state.windowLen)}`;
    } else {
      el.dubTime.textContent = `starts in ${(-t).toFixed(1)}s`;
    }
    if (t >= state.windowLen) { stopDub(); setStatus('Dub finished.'); return; }
  }

  if (state.play !== 'idle' || recorder.micOpen) startLoop();
}

function stopEverything() {
  state.session?.stop();
  recorder.stopAll();
  video.pause();
  state.play = 'idle';
  wave.setCountdown(null); wave.setPlayhead(null);
}

/* ================================================================== */
/* Wire up                                                            */

// loader
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
  if (e.dataTransfer && !el.loader.hidden) loadFrom(entriesFromDataTransfer(e.dataTransfer), 'dropped package');
});
el.joinForm.addEventListener('submit', (e) => { e.preventDefault(); joinRoomAs(el.joinCode.value, el.joinName.value); });
el.joinCode.addEventListener('input', () => { el.joinCode.value = el.joinCode.value.toUpperCase().replace(/[^A-Z]/g, ''); });

// lobby (host)
el.btnOpenRoom.addEventListener('click', () => openRoom().catch((err) => { console.error(err); el.btnOpenRoom.disabled = false; setStatus(`Could not open a room: ${err.message || err}`, true); }));
el.btnSolo.addEventListener('click', () => { state.mode = 'solo'; state.selfId = null; enterBooth(); setStatus('Solo booth. Pick a line and hit Record.'); });
el.hostPlays.addEventListener('change', () => { state.roster.hostPlays = el.hostPlays.checked; dealIfAuto(); broadcastRoster(); renderHostLobby(); });
el.hostName.addEventListener('change', () => { state.roster.hostName = myName(); broadcastRoster(); renderHostLobby(); });
el.btnRedeal.addEventListener('click', () => { state.manualAssign = false; dealIfAuto(); broadcastRoster(); renderHostLobby(); });
el.btnStart.addEventListener('click', startRecordingPhase);
el.btnLeave.addEventListener('click', leaveEverything);

// booth
el.btnRecord.addEventListener('click', toggleRecord);
el.btnPlayOrig.addEventListener('click', () => playLine('original'));
el.btnPlayTake.addEventListener('click', () => playLine('take'));
el.btnPlayBoth.addEventListener('click', () => playLine('both'));
el.btnStopPlay.addEventListener('click', stopPlayback);
el.btnDeleteTake.addEventListener('click', deleteTake);
el.nudge.addEventListener('input', onNudge);
el.btnPrev.addEventListener('click', () => showLine(state.index - 1));
el.btnNext.addEventListener('click', () => showLine(state.index + 1));
el.btnPlayDub.addEventListener('click', () => startDub());
el.btnPlayAll.addEventListener('click', playForEveryone);
el.btnStopDub.addEventListener('click', stopForEveryone);
el.btnDownloadMix.addEventListener('click', downloadMix);

document.addEventListener('keydown', (e) => {
  if (!state.pkg || el.studio.hidden || e.target.matches('input, textarea, select')) return;
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleRecord(); }
  else if (e.key === 'ArrowLeft' && state.play === 'idle') { e.preventDefault(); showLine(state.index - 1); }
  else if (e.key === 'ArrowRight' && state.play === 'idle') { e.preventDefault(); showLine(state.index + 1); }
  else if (e.key === '1') playLine('original');
  else if (e.key === '2') playLine('take');
  else if (e.key === '3') playLine('both');
  else if (e.key === 'Escape') { if (state.play === 'playing') stopPlayback(); else if (state.play === 'dub') stopForEveryone(); else if (state.play === 'recording') state.session?.stop(); }
});

window.addEventListener('beforeunload', (e) => { if (state.takes.size) { e.preventDefault(); e.returnValue = ''; } });

// ?room=CODE prefills the join form; ?pkg=<base url> loads a hosted package.
const params = new URLSearchParams(location.search);
if (params.get('room')) { el.joinCode.value = params.get('room').toUpperCase(); el.joinName.focus(); }
if (params.get('pkg')) { el.urlInput.value = params.get('pkg'); loadFrom(entriesFromUrl(params.get('pkg')), 'URL'); }

// Debug handle for the console.
window.__party = { state, recorder, wave, video, loadFrom, entriesFromZip, entriesFromUrl, buildPackage, tick, openRoom, joinRoomAs, startDub };
