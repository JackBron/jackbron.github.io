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
//
// People are identified by a stable clientId (store.js), not the per-load
// peer id, so a reload keeps their part. Takes and, for the host, the package
// files are persisted in IndexedDB as they happen, and a session can be
// resumed from the loader.
//
// Room phases: lobby -> record -> final. In `final` nobody can record, nudge
// or delete, peers ignore late takes, and the host drives playback for all.

import {
  entriesFromFileList, entriesFromZip, entriesFromDataTransfer, entriesFromUrl,
  buildPackage, summarizePackage, packageFromSummary,
} from './package.js';
import { Recorder } from './recorder.js';
import { WaveformView } from './waveform.js';
import { renderMix, normalize, autoGain } from './mixer.js';
import { audioBufferToWav } from './wav.js';
import { VideoPlayer } from './video.js';
import * as store from './store.js';

const el = new Proxy({}, { get: (_, id) => document.getElementById(id) });

const TAIL = 0.5;        // seconds captured past the line's end
const PREROLL = 1.6;     // count-in before the take starts
const LEAD = 0.3;        // scheduling lead for local playback
const ROOM_LEAD = 2.5;   // seconds between the host pressing play and the first sample everywhere
const DEFAULT_RULES = { oneTake: false, allowNudge: true };

const state = {
  mode: null,             // 'solo' | 'host' | 'player'
  pkg: null,
  index: 0,
  takes: new Map(),       // lineId -> Take (local or remote)
  originals: new Map(),   // lineId -> AudioBuffer
  play: 'idle',           // idle | recording | playing | dub
  session: null,          // active record session
  t0: 0,
  windowLen: 0,
  live: null, liveLen: 0, // take being recorded, drawn as it grows
  mix: null, mixDirty: true,
  backingBuffer: null,
  dub: { pos: 0, playing: false, startAt: 0, videoStarted: false, exporting: false, scrubbing: false },
  exportAbort: null,

  // identity + persistence
  clientId: store.clientId(),
  sessionKey: null,
  knownNames: {},         // clientId -> name, remembered after they leave
  pendingResume: null,

  // room
  net: null,
  room: null,
  selfId: null,
  code: '',
  name: '',
  roster: freshRoster(),
  manualAssign: false,
  hostOffset: 0,          // host clock minus ours, ms (player side)
  waitTimer: 0,
  followTimer: 0,
  needTimer: 0,
  wireImages: new Map(),  // image key -> { blob, type } re-encoded for the wire
  onlyMine: false,
};

function freshRoster() {
  return { hostId: null, hostClientId: null, hostName: '', hostPlays: true, players: {}, assignments: {}, rules: { ...DEFAULT_RULES }, phase: 'lobby' };
}

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
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'package'; }
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
const phase = () => (inRoom() ? state.roster.phase : 'record');
const locked = () => inRoom() && state.roster.phase === 'final';
const rules = () => (inRoom() ? state.roster.rules || DEFAULT_RULES : DEFAULT_RULES);

function myName() {
  if (isHost()) return el.hostName.value.trim() || 'Host';
  if (isPlayer()) return state.name;
  return 'You';
}

/** Client ids of everyone who records: host (if performing) plus players, deduplicated. */
function performerIds() {
  const r = state.roster;
  const ids = r.hostPlays && r.hostClientId ? [r.hostClientId] : [];
  for (const p of Object.values(r.players)) if (p.clientId && !ids.includes(p.clientId)) ids.push(p.clientId);
  return ids;
}
function isPerformer(clientId) { return performerIds().includes(clientId); }
function nameOfClient(cid) {
  const r = state.roster;
  if (cid && cid === r.hostClientId) return r.hostName || 'Host';
  for (const p of Object.values(r.players)) if (p.clientId === cid) return p.name;
  return state.knownNames[cid] || 'someone';
}
function clientOfPeer(peerId) {
  if (peerId === state.roster.hostId) return state.roster.hostClientId;
  return state.roster.players[peerId]?.clientId || null;
}
function peerOfClient(cid) {
  if (cid === state.roster.hostClientId) return state.roster.hostId;
  for (const [pid, p] of Object.entries(state.roster.players)) if (p.clientId === cid) return pid;
  return null;
}
function isPresent(cid) { return cid === state.clientId || !!peerOfClient(cid); }

function ownerOf(line) { return inRoom() ? state.roster.assignments[line.id] || null : state.clientId; }
function isMine(line) { return !inRoom() || ownerOf(line) === state.clientId; }
function canRecord(line) {
  if (!isMine(line) || !line.audio || locked()) return false;
  if (rules().oneTake && state.takes.has(line.id)) return false;
  return true;
}
function canDelete(line) { return isMine(line) && state.takes.has(line.id) && !locked() && !rules().oneTake; }
function canNudge(line) { return isMine(line) && state.takes.has(line.id) && !locked() && rules().allowNudge; }
function myLines() { return state.pkg ? state.pkg.lines.filter(isMine) : []; }
function linesOf(cid) { return state.pkg.lines.filter((l) => state.roster.assignments[l.id] === cid); }
function assignedLines() { return inRoom() ? state.pkg.lines.filter((l) => state.roster.assignments[l.id]) : state.pkg.lines; }
function allRecorded() { const a = assignedLines(); return a.length > 0 && a.every((l) => state.takes.has(l.id)); }

/* ================================================================== */
/* Persistence                                                        */

function sessionRecord() {
  const r = state.roster;
  const names = { ...state.knownNames };
  if (r.hostClientId) names[r.hostClientId] = r.hostName;
  for (const p of Object.values(r.players)) if (p.clientId) names[p.clientId] = p.name;
  return {
    key: state.sessionKey, mode: state.mode, code: state.code, name: state.name, clientId: state.clientId,
    hostPlays: r.hostPlays, rules: r.rules, assignments: r.assignments, phase: r.phase,
    hostClientId: r.hostClientId, names,
    packTitle: state.pkg?.title || '', lineCount: state.pkg?.lines.length || 0,
    takeCount: state.takes.size, onlyMine: state.onlyMine, createdAt: state.sessionCreated || Date.now(),
  };
}
let saveTimer = 0;
function saveSessionSoon() {
  if (!state.sessionKey || !state.mode) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.putSession(sessionRecord()), 300);
}
function persistTake(lineId, take) { if (state.sessionKey) store.putTake(state.sessionKey, lineId, take); saveSessionSoon(); }
function unpersistTake(lineId) { if (state.sessionKey) store.deleteTake(state.sessionKey, lineId); saveSessionSoon(); }

async function restoreTakes() {
  if (!state.sessionKey || !state.pkg) return 0;
  const saved = await store.getTakes(state.sessionKey);
  let n = 0;
  for (const [lineId, rec] of saved) {
    if (!state.pkg.lineById(lineId)) continue;
    state.takes.set(lineId, { ...rec, samples: rec.samples instanceof Float32Array ? rec.samples : new Float32Array(rec.samples) });
    n++;
  }
  if (n) state.mixDirty = true;
  return n;
}

async function checkResume() {
  const rec = await store.getSession(state.clientId);
  if (!rec || !rec.mode) return;
  state.pendingResume = rec;
  const when = rec.updatedAt ? new Date(rec.updatedAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
  const what = rec.mode === 'player'
    ? `You were in room ${rec.code} as ${rec.name}`
    : rec.mode === 'host' ? `You were hosting room ${rec.code}` : 'You had a solo booth open';
  el.resumeText.textContent = `${what}${rec.packTitle ? ` · “${rec.packTitle}”` : ''} · ${rec.takeCount || 0} take${rec.takeCount === 1 ? '' : 's'} saved${when ? ` · ${when}` : ''}`;
  el.resumeCard.hidden = false;
}

async function resumeSession() {
  const rec = state.pendingResume;
  if (!rec) return;
  el.resumeCard.hidden = true;
  recorder.unlock();
  // Be the same person the room knew, even from a brand-new tab.
  if (rec.clientId) state.clientId = store.setClientId(rec.clientId);
  try {
    if (rec.mode === 'player') {
      await joinRoomAs(rec.code, rec.name, rec);
      return;
    }
    setStatus('Restoring the package…');
    const files = await store.getFiles(rec.key);
    if (!files.length) throw new Error('the package files were not saved; load the package again');
    const entries = files.map((f) => ({ path: f.name, size: f.blob.size, blob: async () => f.blob }));
    const pkg = await buildPackage(entries);
    await openPackage(pkg, { resume: rec });
    if (rec.mode === 'solo') {
      state.mode = 'solo';
      enterBooth();
      setStatus(`Resumed the solo booth with ${state.takes.size} take${state.takes.size === 1 ? '' : 's'}.`);
    } else {
      el.hostName.value = rec.names?.[rec.hostClientId] || 'Host';
      el.hostPlays.checked = rec.hostPlays !== false;
      el.ruleOneTake.checked = !!rec.rules?.oneTake;
      el.ruleNudge.checked = rec.rules?.allowNudge !== false;
      await openRoom(rec.code, rec);
      if (state.roster.phase !== 'lobby') enterBooth();
      setStatus(`Room ${rec.code} is open again. Players reconnect on their own.`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Could not resume: ${err.message || err}`, true);
    showScreen('loader');
  }
}

async function discardSession() {
  el.resumeCard.hidden = true;
  const rec = state.pendingResume;
  state.pendingResume = null;
  if (rec) await store.clearSession(rec.key, rec.clientId); else await store.clearAll();
  setStatus('Previous session discarded.');
  checkResume(); // another tab's session may still be there
}

/* ================================================================== */
/* Loading a package (host / solo)                                    */

async function loadFrom(entriesPromise, label) {
  el.loadError.hidden = true;
  setStatus(`Reading ${label}…`);
  try {
    const entries = await entriesPromise;
    const pkg = await buildPackage(entries);
    await openPackage(pkg, { entries });
  } catch (err) {
    console.error(err);
    el.loadError.textContent = err.message || String(err);
    el.loadError.hidden = false;
    setStatus(`Could not load ${label}: ${err.message || err}`, true);
  }
}

async function openPackage(pkg, { entries = null, resume = null } = {}) {
  resetAll({ keepStore: !!resume });
  state.pkg = pkg;
  state.mode = 'host';
  state.sessionKey = resume ? resume.key : `${Date.now().toString(36)}-${slug(pkg.title)}`;
  state.sessionCreated = resume?.createdAt || Date.now();
  state.knownNames = resume?.names || {};
  showPackInfo(pkg);
  el.btnLeave.hidden = false;
  showScreen('lobby');
  el.lobbyHost.hidden = false;
  el.lobbyPlayer.hidden = true;
  el.lobbyTitle.textContent = 'Game lobby';
  el.btnStart.hidden = false; el.btnBackToBooth.hidden = true;
  renderHostLobby();
  setStatus(`Loaded “${pkg.title}”. Open a room for friends, or go solo.`);
  setupVideo(pkg);
  if (resume) {
    const n = await restoreTakes();
    if (n) setStatus(`Restored ${n} take${n === 1 ? '' : 's'}.`);
  } else if (entries) {
    // A new package starts a new session for this tab; forget this tab's old one.
    const prev = await store.getSession(state.clientId);
    if (prev && prev.clientId === state.clientId) await store.clearSession(prev.key, prev.clientId);
    storePackage(entries);
  }
  saveSessionSoon();
}

/** Save the package files so a host refresh can resume the room. */
async function storePackage(entries) {
  try {
    const files = [];
    for (const e of entries) {
      const name = e.path.replace(/\\/g, '/').split('/').pop();
      files.push({ name, blob: await e.blob() });
    }
    await store.putFiles(state.sessionKey, files);
    saveSessionSoon();
  } catch (err) {
    console.warn(err);
    setStatus('Package loaded, but could not be saved for resume (storage full or blocked).', true);
  }
}

function showPackInfo(pkg) {
  el.packTitle.textContent = pkg.title;
  const bits = [];
  if (pkg.subtitle) bits.push(pkg.subtitle);
  else if (pkg.readme) bits.push(pkg.readme);
  if (pkg.authors?.length) bits.push(`by ${pkg.authors.join(', ')}`);
  bits.push(`${pkg.lines.length} line${pkg.lines.length === 1 ? '' : 's'}`);
  bits.push(pkg.characters.length === 1 ? '1 character' : `${pkg.characters.length} characters`);
  if (pkg.hasBacking) bits.push('backing track');
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

function resetAll({ keepStore = false } = {}) {
  stopEverything();
  state.exportAbort?.abort();
  if (state.room) state.room.leave();
  clearTimeout(state.waitTimer); clearTimeout(state.followTimer); clearTimeout(state.needTimer);
  if (state.pkg) state.pkg.dispose();
  video.dispose();
  Object.assign(state, {
    mode: null, pkg: null, index: 0, room: null, code: '', name: '', sessionKey: null,
    roster: freshRoster(), manualAssign: false, hostOffset: 0,
    mix: null, mixDirty: true, backingBuffer: null, onlyMine: false,
    dub: { pos: 0, playing: false, startAt: 0, videoStarted: false, exporting: false, scrubbing: false },
  });
  if (!keepStore) state.knownNames = {};
  state.takes.clear(); state.originals.clear(); state.wireImages.clear();
  el.slide.hidden = true; el.slideCaption.textContent = ''; el.dubEmpty.hidden = false;
  el.roomBadge.hidden = true; el.relayBadge.hidden = true; el.roomBar.hidden = true;
  el.studio.classList.remove('in-room', 'locked', 'exporting');
  el.packInfo.hidden = true; el.btnLeave.hidden = true;
  el.roomCodeWrap.hidden = true; el.playersBox.hidden = true; el.assignCard.hidden = true; el.qrBox.innerHTML = '';
  el.btnOpenRoom.disabled = false; el.btnOpenRoom.hidden = false; el.btnSolo.hidden = false;
  el.syncWrap.hidden = true; el.btnManage.hidden = true; el.btnFinalize.hidden = true; el.btnUnlock.hidden = true; el.btnResend.hidden = true;
  el.doneBanner.hidden = true; el.lockBanner.hidden = true; el.onlyMineWrap.hidden = true; el.onlyMine.checked = false;
  el.dubStatus.textContent = ''; el.exportProgress.textContent = '';
  el.dubSeek.value = 0; el.dubTime.textContent = '0:00.0 / 0:00.0';
  document.title = 'Choicer Party — dubbing booth';
}

function leaveEverything() {
  const msg = isHost() && inRoom()
    ? 'Close the room? Players will be disconnected. Your takes and package stay saved here until you start something new.'
    : 'Leave? Your takes stay saved here and can be resumed from the front page.';
  if (state.takes.size && !confirm(msg)) return;
  resetAll({ keepStore: true });
  showScreen('loader');
  checkResume();
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
  room.on('backing', onBacking);
  room.on('take', onTakeMsg);
  room.on('progress', onProgressMsg);
  room.on('need', onNeed);
  room.on('play', onPlayMsg);
  room.on('stop', onStopMsg);
  room.onPeerJoin(onPeerJoin);
  room.onPeerLeave(onPeerLeave);
  room.onProgress('frame', (pct) => { if (isPlayer() && pct < 1) el.receiving.textContent = `receiving frames ${Math.round(pct * 100)}%`; });
  room.onProgress('audio', (pct, peerId, meta) => { if (isPlayer() && pct < 1) el.receiving.textContent = `receiving line ${meta?.lineId?.slice(0, 8) || ''} ${Math.round(pct * 100)}%`; });
  room.onProgress('backing', (pct) => { if (isPlayer() && pct < 1) el.receiving.textContent = `receiving backing track ${Math.round(pct * 100)}%`; });
  room.onError = (err, action) => { if (action !== 'clock') setStatus(`Network hiccup (${action}): ${err?.message || err}`, true); };
  relayTicker();
}

let relayTimer = 0;
function relayTicker() {
  clearInterval(relayTimer);
  const update = () => {
    if (!state.room || !state.net) { el.relayBadge.hidden = true; return; }
    const { open, total } = state.net.Room.relayStatus();
    el.relayBadge.textContent = `${open}/${total} relays`;
    el.relayBadge.classList.toggle('bad', open === 0);
    el.relayBadge.hidden = false;
    if (isHost() && !el.roomCodeWrap.hidden) {
      el.roomState.textContent = open === 0
        ? 'No relay connection yet. Players cannot find the room until one connects.'
        : `Waiting for players. Anyone who opens the link, scans the code or types it will appear here. (${open} relay${open === 1 ? '' : 's'} connected)`;
    }
  };
  update();
  relayTimer = setInterval(update, 3000);
}

function updateRoomBadge() {
  if (!inRoom()) { el.roomBadge.hidden = true; return; }
  const n = Object.keys(state.roster.players).length;
  el.roomBadge.textContent = `${state.code} · ${n} player${n === 1 ? '' : 's'}`;
  el.roomBadge.hidden = false;
  el.roomBarCode.textContent = state.code;
}

/* -------------------------- host side -------------------------- */

async function openRoom(code = null, resume = null) {
  const { Room, makeCode, selfId } = await net();
  el.btnOpenRoom.disabled = true;
  state.code = code || makeCode();
  state.room = new Room(state.code);
  const r = state.roster;
  r.hostId = selfId;
  r.hostClientId = state.clientId;
  r.hostName = myName();
  r.hostPlays = el.hostPlays.checked;
  r.rules = { oneTake: el.ruleOneTake.checked, allowNudge: el.ruleNudge.checked };
  if (resume) {
    r.assignments = resume.assignments || {};
    r.phase = resume.phase || 'lobby';
    r.hostPlays = resume.hostPlays !== false;
    r.rules = { ...DEFAULT_RULES, ...(resume.rules || {}) };
    state.manualAssign = true; // keep the dealt parts as they were
  }
  wireRoom(state.room);

  el.roomCode.textContent = state.code;
  const link = new URL(location.href);
  link.search = `?room=${state.code}`;
  link.hash = '';
  el.roomLink.textContent = link.href.replace(/^https?:\/\//, '');
  el.roomCodeWrap.hidden = false;
  el.playersBox.hidden = false;
  el.assignCard.hidden = false;
  el.btnOpenRoom.hidden = true;
  el.btnSolo.hidden = true;
  updateRoomBadge();
  dealIfAuto();
  renderHostLobby();
  saveSessionSoon();
  setStatus(`Room ${state.code} is open.`);
  import('./qr.js').then((m) => m.renderQr(el.qrBox, link.href)).catch(() => {});
}

function onPeerJoin(peerId) {
  if (isPlayer()) state.room.send('hello', { name: state.name, clientId: state.clientId }, peerId);
}

function onPeerLeave(peerId) {
  if (isHost()) {
    const p = state.roster.players[peerId];
    if (p) {
      state.knownNames[p.clientId] = p.name;
      delete state.roster.players[peerId];
      const stranded = linesOf(p.clientId).filter((l) => !state.takes.has(l.id)).length;
      setStatus(stranded && state.roster.phase !== 'lobby'
        ? `${p.name} left with ${stranded} line${stranded === 1 ? '' : 's'} unrecorded. Their part is kept for them; use Manage parts to hand it to someone else.`
        : `${p.name} left the room.`);
      if (state.roster.phase === 'lobby') dealIfAuto();
      broadcastRoster();
      renderHostLobby(); renderRoomBar(); refreshLineList(); saveSessionSoon();
    }
  } else if (isPlayer() && peerId === state.roster.hostId) {
    setStatus('The host disconnected. If they come back, you will reconnect automatically.', true);
    if (!el.lobby.hidden) el.pWait.textContent = 'The host disconnected. Waiting for them to come back…';
  }
}

function onHello(msg, peerId) {
  if (!isHost() || !msg?.clientId) return;
  const cid = String(msg.clientId);
  const name = String(msg.name || 'Player').slice(0, 24);
  // A reload gives the same person a new peer id: drop the stale entry.
  for (const [pid, p] of Object.entries(state.roster.players)) if (p.clientId === cid && pid !== peerId) delete state.roster.players[pid];
  const returning = Object.values(state.knownNames).length && state.knownNames[cid] !== undefined;
  const fresh = !state.roster.players[peerId];
  state.roster.players[peerId] = { name, clientId: cid };
  state.knownNames[cid] = name;
  if (fresh) setStatus(returning && state.roster.phase !== 'lobby' ? `${name} is back.` : `${name} joined.`);
  dealIfAuto();
  broadcastRoster();
  state.room.send('pack', summarizePackage(state.pkg), peerId);
  if (state.roster.phase !== 'lobby') sendAssets(peerId);
  renderHostLobby(); renderRoomBar(); refreshLineList(); saveSessionSoon();
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

function setPhase(p) {
  state.roster.phase = p;
  broadcastRoster();
  saveSessionSoon();
  applyPhase();
}

function applyPhase() {
  if (el.studio.hidden || !state.pkg) return;
  const lock = locked();
  el.studio.classList.toggle('locked', lock);
  el.lockBanner.hidden = !lock;
  if (lock) {
    el.lockText.textContent = isHost()
      ? 'Takes are locked. Everyone hears what you play below. Unlock if someone needs a retake.'
      : 'Takes are locked. The host is playing the final dub; sit back.';
  }
  el.btnFinalize.hidden = !(isHost() && inRoom() && !lock);
  el.btnUnlock.hidden = !(isHost() && inRoom() && lock);
  refreshTakeControls(); updateDubControls(); renderRoomBar(); refreshLineList();
}

function renderHostLobby() {
  if (!isHost()) return;
  const r = state.roster;
  const perf = performerIds();
  const mid = r.phase !== 'lobby';
  el.lobbyTitle.textContent = mid ? 'Manage parts' : 'Game lobby';
  el.rulesBox.hidden = mid; // rules are fixed once recording has begun
  el.playerCount.textContent = `(${Object.keys(r.players).length})`;
  const items = [];
  items.push(`<li><span class="avatar">${escapeHtml(initials(myName()))}</span><span class="who">${escapeHtml(myName())}</span><span class="role">host${r.hostPlays ? ' · performing' : ' · not performing'}</span></li>`);
  const seen = new Set([r.hostClientId]);
  for (const p of Object.values(r.players)) {
    seen.add(p.clientId);
    const chars = [...new Set(linesOf(p.clientId).flatMap((l) => l.characters))];
    items.push(`<li><span class="avatar">${escapeHtml(initials(p.name))}</span><span class="who">${escapeHtml(p.name)}</span>${chars.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')}<span class="role">${linesOf(p.clientId).length} lines</span></li>`);
  }
  // people who left but still hold lines
  for (const cid of new Set(Object.values(r.assignments))) {
    if (seen.has(cid)) continue;
    const n = linesOf(cid).length;
    items.push(`<li class="gone"><span class="avatar">${escapeHtml(initials(nameOfClient(cid)))}</span><span class="who">${escapeHtml(nameOfClient(cid))}</span><span class="role">left · still holds ${n} line${n === 1 ? '' : 's'}</span></li>`);
  }
  if (!Object.keys(r.players).length) items.push('<li class="none">nobody yet</li>');
  el.playerList.innerHTML = items.join('');

  const tb = el.assignTable.querySelector('tbody');
  const options = new Set(perf);
  for (const cid of Object.values(r.assignments)) options.add(cid); // absent holders stay selectable so the host can see them
  tb.innerHTML = state.pkg.lines.map((l) => {
    const has = state.takes.has(l.id);
    const opts = ['<option value="">—</option>'].concat([...options].map((cid) => `<option value="${cid}" ${r.assignments[l.id] === cid ? 'selected' : ''}>${escapeHtml(nameOfClient(cid))}${isPresent(cid) ? '' : ' (left)'}</option>`));
    return `<tr><td class="mono">${String(l.order).padStart(2, '0')}</td><td><span class="chip">${escapeHtml(l.characters.join(' + '))}</span></td><td class="cap" title="${escapeHtml(l.caption)}">${has ? '✓ ' : ''}${escapeHtml(l.caption)}</td><td><select data-line="${l.id}" ${locked() ? 'disabled' : ''}>${opts.join('')}</select></td></tr>`;
  }).join('');
  tb.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', () => onAssignChange(sel.dataset.line, sel.value)));

  const assigned = assignedLines().length;
  const unassigned = state.pkg.lines.length - assigned;
  const absent = [...new Set(Object.values(r.assignments))].filter((cid) => !isPresent(cid));
  el.assignHint.textContent = perf.length === 0
    ? 'No performers yet. Tick "I\'m performing too" or wait for players.'
    : absent.length
      ? `${absent.map(nameOfClient).join(', ')} left with lines still assigned. Hand them to someone present, or wait for them to come back.`
      : perf.length > state.pkg.characters.length
        ? `More performers than characters, so lines are dealt round-robin.${unassigned ? ` ${unassigned} unassigned.` : ''}`
        : `Each performer takes whole characters.${unassigned ? ` ${unassigned} unassigned.` : ''}`;
  el.btnStart.disabled = assigned === 0 || mid;
  el.btnStart.hidden = mid; el.btnBackToBooth.hidden = !mid;
  el.btnRedeal.disabled = mid || locked();
}

function onAssignChange(lineId, cid) {
  const r = state.roster;
  state.manualAssign = true;
  const before = r.assignments[lineId];
  if (cid) r.assignments[lineId] = cid; else delete r.assignments[lineId];
  broadcastRoster(); renderHostLobby(); saveSessionSoon();
  // Mid-session: the new performer needs the original audio for that line.
  if (r.phase !== 'lobby' && cid && cid !== before && cid !== state.clientId) {
    const pid = peerOfClient(cid);
    const line = state.pkg.lineById(lineId);
    if (pid && line?.audio) line.audio.arrayBuffer().then((ab) => state.room.send('audio', new Uint8Array(ab), pid, { lineId }));
  }
}

async function startRecordingPhase() {
  if (!isHost() || !state.room) return;
  recorder.unlock();
  state.roster.hostName = myName();
  state.roster.rules = { oneTake: el.ruleOneTake.checked, allowNudge: el.ruleNudge.checked };
  setPhase('record');
  enterBooth();
  setStatus('Sending frames and lines to players…');
  await sendAssets(null);
  setStatus('Everyone has their lines. Record yours, watch the room bar for the others.');
}

async function wireImage(line) {
  const key = (line.imageName || line.id).toLowerCase();
  if (!state.wireImages.has(key)) {
    const blob = await state.net.shrinkImage(line.image);
    state.wireImages.set(key, { blob, type: blob.type || 'image/jpeg' });
  }
  return state.wireImages.get(key);
}

/**
 * Frames to everyone (or one peer), each line's original audio to its
 * performer, the backing track to all, and to a late joiner the takes so far.
 * `only` limits what is sent (used to answer a `need`).
 */
async function sendAssets(target, only = null) {
  const { room, pkg } = state;
  if (!room || !pkg) return;
  const peers = target ? [target] : room.peers();
  if (!peers.length) return;
  const want = only || { pack: true, frames: true, audio: null, backing: true, takes: !!target };
  if (want.pack) await room.send('pack', summarizePackage(pkg), target || undefined);
  if (want.frames) {
    const sent = new Set();
    for (const l of pkg.lines) {
      if (!l.image) continue;
      const key = (l.imageName || l.id).toLowerCase();
      if (sent.has(key)) continue;
      sent.add(key);
      const w = await wireImage(l);
      await room.send('frame', new Uint8Array(await w.blob.arrayBuffer()), target || undefined, { lineId: l.id, type: w.type });
    }
  }
  const audioLines = want.audio ? pkg.lines.filter((l) => want.audio.includes(l.id)) : pkg.lines;
  for (const l of audioLines) {
    const owner = state.roster.assignments[l.id];
    if (!owner || owner === state.clientId) continue;
    const pid = peerOfClient(owner);
    if (!pid) continue;
    if (target && pid !== target) continue;
    if (!want.audio && only) continue; // a `need` without audio asks for nothing here
    await room.send('audio', new Uint8Array(await l.audio.arrayBuffer()), pid, { lineId: l.id });
  }
  if (want.backing && pkg.backing) {
    await room.send('backing', new Uint8Array(await pkg.backing.arrayBuffer()), target || undefined, { name: pkg.backingName });
  }
  if (want.takes && target) {
    for (const [lineId, take] of state.takes) {
      const enc = state.net.encodeTake(lineId, take, take.by || myName(), take.byClientId || state.clientId);
      await room.send('take', enc.data, target, enc.meta);
    }
  }
}

function onNeed(msg, peerId) {
  if (!isHost() || !msg) return;
  const audio = Array.isArray(msg.audio) ? msg.audio.filter((id) => state.pkg.lineById(id)) : [];
  setStatus(`${nameOfClient(clientOfPeer(peerId))} asked for missing files; resending.`);
  sendAssets(peerId, { pack: !!msg.pack, frames: !!msg.frames, audio: audio.length ? audio : null, backing: !!msg.backing, takes: !!msg.takes });
}

function finalize() {
  if (!isHost() || !inRoom()) return;
  const missing = assignedLines().filter((l) => !state.takes.has(l.id));
  const q = missing.length
    ? `${missing.length} line${missing.length === 1 ? ' is' : 's are'} still unrecorded and will play as silence. Lock the takes anyway?`
    : 'Lock all takes? Nobody can record, nudge or delete until you unlock. Your playback controls will drive everyone\'s screens.';
  if (!confirm(q)) return;
  dubPause({ broadcast: true });
  setPhase('final');
  el.syncAll.checked = true;
  setStatus('Takes locked. Press play below to run the dub for the whole room.');
}

function unlock() {
  if (!isHost() || !inRoom()) return;
  dubPause({ broadcast: true });
  setPhase('record');
  setStatus('Takes unlocked. Retakes and nudges are allowed again.');
}

function manageParts() {
  if (!isHost()) return;
  stopPlayback(); dubPause({ broadcast: false });
  showScreen('lobby');
  el.lobbyHost.hidden = false; el.lobbyPlayer.hidden = true;
  renderHostLobby();
}

/* -------------------------- player side -------------------------- */

async function joinRoomAs(codeRaw, nameRaw, resume = null) {
  recorder.unlock();
  const { Room, normalizeCode } = await net();
  const code = normalizeCode(codeRaw);
  const name = nameRaw.trim().slice(0, 24);
  if (code.length < 4) { el.joinError.textContent = 'Room codes are four letters.'; el.joinError.hidden = false; return; }
  if (!name) { el.joinError.textContent = 'Pick a name so the host knows who you are.'; el.joinError.hidden = false; return; }
  el.joinError.hidden = true;
  resetAll({ keepStore: !!resume });
  recorder.init().catch(() => {});
  state.mode = 'player';
  state.code = code; state.name = name;
  state.sessionKey = `p-${code}-${state.clientId}`;
  state.sessionCreated = resume?.createdAt || Date.now();
  if (resume?.names) state.knownNames = resume.names;
  state.room = new Room(code);
  wireRoom(state.room);
  for (const p of state.room.peers()) state.room.send('hello', { name, clientId: state.clientId }, p);

  el.pRoomCode.textContent = code; el.pName.textContent = name; el.pHost.textContent = '';
  el.pWait.textContent = 'Looking for the host…';
  el.pCharacters.innerHTML = '<span class="dim">waiting for the host to deal parts…</span>';
  el.pLines.textContent = ''; el.pRules.textContent = ''; el.pPlayerList.innerHTML = ''; el.pPlayerCount.textContent = '';
  el.btnLeave.hidden = false;
  showScreen('lobby'); el.lobbyHost.hidden = true; el.lobbyPlayer.hidden = false;
  updateRoomBadge();
  saveSessionSoon();
  setStatus(`Joined ${code} as ${name}. Finding the host…`);
  clearTimeout(state.waitTimer);
  state.waitTimer = setTimeout(() => {
    if (isPlayer() && !state.roster.hostId) el.pWait.textContent = 'Still looking. Check the code with the host, and that both of you are online.';
  }, 15000);
}

async function onRoster(msg, peerId) {
  if (!isPlayer() || !msg?.hostClientId) return;
  const r = state.roster;
  if (r.hostClientId && msg.hostClientId !== r.hostClientId) return; // a different host: not our room
  const firstTime = !r.hostId;
  const hostChanged = r.hostId && r.hostId !== peerId;
  const was = r.phase;
  state.roster = {
    hostId: peerId, hostClientId: msg.hostClientId, hostName: msg.hostName, hostPlays: msg.hostPlays,
    players: msg.players || {}, assignments: msg.assignments || {},
    rules: { ...DEFAULT_RULES, ...(msg.rules || {}) }, phase: msg.phase || 'lobby',
  };
  for (const p of Object.values(state.roster.players)) if (p.clientId) state.knownNames[p.clientId] = p.name;
  updateRoomBadge();
  renderPlayerLobby();
  if (firstTime) {
    setStatus(`Connected to ${state.roster.hostName}'s room.`);
    syncToHost();
    const n = await restoreTakes();
    if (n) { setStatus(`Reconnected. ${n} of your take${n === 1 ? '' : 's'} restored.`); resendOwnTakes(peerId); }
  } else if (hostChanged) {
    setStatus('The host is back. Reconnected.');
    syncToHost();
    resendOwnTakes(peerId);
  }
  if (state.roster.phase !== 'lobby' && state.pkg && el.studio.hidden) enterBooth();
  if (state.roster.phase !== was) { if (state.roster.phase === 'record') syncToHost(); applyPhase(); }
  if (!el.studio.hidden) { refreshTakeControls(); updateDubControls(); renderRoomBar(); refreshLineList(); }
  saveSessionSoon();
}

/** After a reload (ours or the host's), make sure the host holds our takes. */
function resendOwnTakes(hostPeerId) {
  for (const [lineId, take] of state.takes) {
    if (take.remote) continue;
    const enc = state.net.encodeTake(lineId, take, myName(), state.clientId);
    state.room.send('take', enc.data, hostPeerId, enc.meta);
  }
}

async function syncToHost() {
  if (!state.room || !state.roster.hostId) return;
  const r = await state.room.syncClock(state.roster.hostId);
  if (r) { state.hostOffset = r.offset; console.info(`clock offset to host ${r.offset.toFixed(1)} ms (rtt ${r.rtt.toFixed(0)} ms)`); }
}

async function onPack(summary, peerId) {
  if (!isPlayer()) return;
  if (state.roster.hostId && peerId !== state.roster.hostId) return;
  if (state.pkg && state.pkg.title === summary.title && state.pkg.lines.length === summary.lines.length) return;
  const old = state.pkg;
  state.pkg = packageFromSummary(summary);
  if (old) for (const l of old.lines) { const n = state.pkg.lineById(l.id); if (n) { n.image = l.image; n.imageUrl = l.imageUrl; n.audio = l.audio; n.audioBuffer = l.audioBuffer; } }
  showPackInfo(state.pkg);
  state.mixDirty = true;
  renderPlayerLobby();
  await restoreTakes(); // before the booth picks a starting line
  if (state.roster.phase !== 'lobby' && el.studio.hidden) enterBooth();
  else if (!el.studio.hidden) { renderLineList(); showLine(state.index); }
}

function onFrame(buffer, peerId, meta) {
  if (!isPlayer() || !state.pkg) return;
  const line = state.pkg.lineById(meta?.lineId);
  if (!line) return;
  line.image = new Blob([buffer], { type: meta?.type || 'image/jpeg' });
  line.imageUrl = state.pkg.url(line.image);
  for (const other of state.pkg.lines) {
    if (other !== line && !other.imageUrl && other.imageName && other.imageName === line.imageName) {
      other.image = line.image; other.imageUrl = line.imageUrl;
      const th = el.lineList.querySelector(`[data-line="${other.id}"] img`);
      if (th) th.src = other.imageUrl;
    }
  }
  el.receiving.textContent = '';
  if (!el.studio.hidden) {
    const thumb = el.lineList.querySelector(`[data-line="${line.id}"] img`);
    if (thumb) thumb.src = line.imageUrl;
    if (state.pkg.lines[state.index]?.imageUrl === line.imageUrl) { el.frame.src = line.imageUrl; el.frameEmpty.hidden = true; }
    renderRoomBar();
  }
}

async function onAudio(buffer, peerId, meta) {
  if (!isPlayer() || !state.pkg) return;
  const line = state.pkg.lineById(meta?.lineId);
  if (!line) return;
  line.audio = new Blob([buffer], { type: 'audio/wav' });
  state.originals.delete(line.id);
  el.receiving.textContent = '';
  if (!el.studio.hidden && state.pkg.lines[state.index] === line) showLine(state.index);
  renderPlayerLobby(); renderRoomBar();
}

function onBacking(buffer, peerId, meta) {
  if (!isPlayer() || !state.pkg) return;
  state.pkg.backing = new Blob([buffer], { type: /\.wav$/i.test(meta?.name || '') ? 'audio/wav' : 'audio/mpeg' });
  state.pkg.hasBacking = true;
  state.backingBuffer = null;
  state.mixDirty = true;
  el.receiving.textContent = '';
  showPackInfo(state.pkg);
  renderRoomBar();
}

/** What this player still lacks; used to ask the host for a resend. */
function missingAssets() {
  if (!isPlayer() || !state.pkg) return null;
  const frames = state.pkg.lines.some((l) => l.imageName && !l.imageUrl);
  const audio = myLines().filter((l) => !l.audio).map((l) => l.id);
  const backing = state.pkg.hasBacking && !state.pkg.backing;
  return (frames || audio.length || backing) ? { frames, audio, backing } : null;
}

function requestMissing(manual = false) {
  const m = missingAssets();
  if (!m || !state.roster.hostId) return;
  state.room.send('need', { ...m, pack: false, takes: false }, state.roster.hostId);
  if (manual) setStatus('Asked the host to resend your files.');
}

function scheduleNeedCheck() {
  clearTimeout(state.needTimer);
  if (!isPlayer()) return;
  state.needTimer = setTimeout(() => {
    if (missingAssets()) { requestMissing(false); scheduleNeedCheck(); }
    else el.btnResend.hidden = true;
  }, 12000);
}

function renderPlayerLobby() {
  if (!isPlayer()) return;
  const r = state.roster;
  el.pHost.textContent = r.hostId ? `Hosted by ${r.hostName}.` : '';
  const mine = state.pkg ? myLines() : [];
  if (state.pkg && r.hostId) {
    const chars = [...new Set(mine.flatMap((l) => l.characters))];
    el.pCharacters.innerHTML = chars.length
      ? chars.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')
      : '<span class="dim">nothing yet — the host may still be dealing</span>';
    el.pLines.textContent = mine.length ? `${mine.length} line${mine.length === 1 ? '' : 's'} · ${mine.map((l) => `#${l.order}`).join(', ')}` : '';
    const rl = [];
    if (r.rules?.oneTake) rl.push('one take per line, no retakes');
    if (r.rules && !r.rules.allowNudge) rl.push('no nudging');
    el.pRules.textContent = rl.length ? `Rules: ${rl.join(' · ')}` : '';
  }
  const items = [];
  if (r.hostId) items.push(`<li><span class="avatar">${escapeHtml(initials(r.hostName))}</span><span class="who">${escapeHtml(r.hostName)}</span><span class="role">host${r.hostPlays ? ' · performing' : ''}</span></li>`);
  for (const p of Object.values(r.players)) {
    items.push(`<li><span class="avatar">${escapeHtml(initials(p.name))}</span><span class="who">${escapeHtml(p.name)}${p.clientId === state.clientId ? ' (you)' : ''}</span></li>`);
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
  const senderClient = clientOfPeer(peerId) || meta.byClientId || null;
  const fromHost = peerId === state.roster.hostId;
  const owner = ownerOf(line);
  if (inRoom() && owner && owner !== senderClient && !fromHost) return;         // not theirs to send
  if (locked() && !fromHost) return;                                             // no late takes once final
  const existing = state.takes.get(line.id);
  if (existing && !existing.remote && owner === state.clientId) return;          // never overwrite our own with an echo
  if (existing && rules().oneTake && existing.byClientId === (meta.byClientId || senderClient) && !fromHost) return; // one take means one
  const take = state.net.decodeTake(buffer, meta);
  take.byClientId = take.byClientId || senderClient;
  const fresh = !existing;
  state.takes.set(line.id, take);
  state.mixDirty = true;
  persistTake(line.id, take);
  if (!el.studio.hidden) {
    if (state.pkg.lines[state.index] === line) refreshStageTake(line);
    refreshLineList(); refreshTakeControls(); updateDubControls(); renderRoomBar();
    if (fresh) followAlong(line);
  }
  if (isHost()) renderHostLobby();
  if (fresh) setStatus(`${take.by || nameOfClient(senderClient)} recorded line ${line.order}.`);
}

function onProgressMsg(msg, peerId) {
  if (!state.pkg || msg?.status !== 'deleted' || locked()) return;
  const line = state.pkg.lineById(msg.lineId);
  if (!line || ownerOf(line) !== clientOfPeer(peerId)) return;
  if (rules().oneTake) return;
  state.takes.delete(line.id);
  state.mixDirty = true;
  unpersistTake(line.id);
  if (!el.studio.hidden) {
    if (state.pkg.lines[state.index] === line) refreshStageTake(line);
    refreshLineList(); refreshTakeControls(); updateDubControls(); renderRoomBar();
  }
  if (isHost()) renderHostLobby();
}

function shareTake(line, take) {
  if (!inRoom()) return;
  const enc = state.net.encodeTake(line.id, take, myName(), state.clientId);
  state.room.send('take', enc.data, undefined, enc.meta);
}

function onPlayMsg(msg, peerId) {
  if (!isPlayer() || peerId !== state.roster.hostId || !msg) return;
  const localPerf = msg.at - state.hostOffset;
  const ctxAt = recorder.now + (localPerf - performance.now()) / 1000;
  dubStart(msg.from || 0, ctxAt, { broadcast: false });
}

function onStopMsg(msg, peerId) {
  if (!isPlayer() || peerId !== state.roster.hostId) return;
  dubPause({ broadcast: false, pos: typeof msg?.pos === 'number' ? msg.pos : null });
}

/* ================================================================== */
/* Booth                                                              */

function enterBooth() {
  showScreen('studio');
  const room = inRoom();
  el.roomBar.hidden = !room;
  el.studio.classList.toggle('in-room', room);
  el.syncWrap.hidden = !(isHost() && room);
  el.btnManage.hidden = !(isHost() && room);
  el.followWrap.hidden = !room;
  el.onlyMineWrap.hidden = !(room && isPerformer(state.clientId));
  el.btnResend.hidden = !(isPlayer() && missingAssets());
  renderLineList();
  showLine(startIndex());
  renderRoomBar();
  updateDubControls();
  applyPhase();
  refreshMicList();
  if (isPlayer()) { el.pWait.textContent = ''; scheduleNeedCheck(); }
  saveSessionSoon();
}

/** Where to open: your first unrecorded line if you perform, else the script's. */
function startIndex() {
  const lines = state.pkg.lines;
  if (!inRoom() || isPerformer(state.clientId)) {
    const i = lines.findIndex((l) => isMine(l) && !state.takes.has(l.id));
    if (i >= 0) return i;
  }
  const j = lines.findIndex((l) => !state.takes.has(l.id));
  return j >= 0 ? j : 0;
}

/** Next line to move to after `from`: yours first, then the script. -1 = stay. */
function nextLineIndex(from) {
  const lines = state.pkg.lines;
  const n = lines.length;
  if (!inRoom() || isPerformer(state.clientId)) {
    const wanted = (i) => isMine(lines[i]) && !state.takes.has(lines[i].id);
    for (let i = from + 1; i < n; i++) if (wanted(i)) return i;
    for (let i = 0; i < from; i++) if (wanted(i)) return i;
    if (state.onlyMine) return -1;
  }
  return from + 1 < n ? from + 1 : -1;
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
    btn.classList.toggle('filtered', state.onlyMine && inRoom() && !mine);
    btn.querySelector('.tick').hidden = !has;
    const by = btn.querySelector('.by');
    const o = ownerOf(line);
    by.textContent = inRoom() ? (o ? (mine ? 'you' : nameOfClient(o)) : 'unassigned') : '';
  });
  const mine = myLines();
  const mineDone = mine.filter((l) => state.takes.has(l.id)).length;
  el.takeCount.textContent = inRoom() ? `you ${mineDone} / ${mine.length} · all ${state.takes.size} / ${assignedLines().length}` : `${state.takes.size} / ${state.pkg.lines.length}`;
}

function currentLine() { return state.pkg.lines[state.index]; }

async function showLine(i) {
  const { pkg } = state;
  clearTimeout(state.followTimer);
  state.index = Math.max(0, Math.min(pkg.lines.length - 1, i));
  const line = currentLine();

  el.frame.src = line.imageUrl || '';
  el.frameEmpty.hidden = !!line.imageUrl;
  el.charChip.textContent = line.characters.join(' + ');
  el.lineTime.textContent = `${fmtTime(line.start)} → ${fmtTime(line.end)} · ${line.duration.toFixed(2)}s`;
  el.caption.textContent = line.caption;
  if (inRoom()) {
    const o = ownerOf(line);
    el.ownerChip.textContent = o ? (isMine(line) ? 'your line' : `${nameOfClient(o)}'s line`) : 'unassigned';
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
  if (!line.audio) return null;
  if (state.originals.has(line.id)) return state.originals.get(line.id);
  const buf = line.audioBuffer || await recorder.decode(line.audio);
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

function refreshStageTake(line) { layerWave(line, state.originals.get(line.id) || null); }

function refreshTakeControls() {
  if (!state.pkg || el.studio.hidden) return;
  const line = currentLine();
  const take = state.takes.get(line.id);
  const busy = state.play !== 'idle';
  const mine = isMine(line);
  const hasOriginal = !!line.audio;
  el.btnPlayTake.disabled = !take || busy;
  el.btnPlayBoth.disabled = !take || !hasOriginal || busy;
  el.btnPlayOrig.disabled = !hasOriginal || busy;
  el.btnDeleteTake.disabled = !canDelete(line) || busy;
  el.nudge.disabled = !canNudge(line) || busy;
  el.nudge.value = take ? Math.round(take.offset * 1000) : 0;
  el.nudgeOut.textContent = `${take ? Math.round(take.offset * 1000) : 0} ms`;
  el.btnRecordLabel.textContent = state.play === 'recording' ? 'Stop' : (take ? 'Retake' : 'Record');
  el.btnRecord.classList.toggle('armed', state.play === 'recording');
  el.btnRecord.disabled = state.play === 'recording' ? false : (busy || !canRecord(line));
  el.btnRecord.title = locked() ? 'Takes are locked' : !mine ? 'Not your line' : (!hasOriginal ? 'Waiting for the line audio to arrive' : (take && rules().oneTake ? 'One take per line in this room' : ''));
  el.btnStopPlay.hidden = state.play !== 'playing';
  el.recBadge.hidden = state.play !== 'recording';
  el.brandDot.classList.toggle('live', state.play === 'recording');
  el.btnPrev.disabled = busy || stepIndex(-1) < 0;
  el.btnNext.disabled = busy || stepIndex(1) < 0;
  const mineLeft = myLines().filter((l) => !state.takes.has(l.id)).length;
  el.pagerHint.textContent = inRoom() ? (mineLeft ? `${mineLeft} of yours left` : (myLines().length ? 'all yours recorded' : '')) : '';
}

/** Prev/next respecting the "only mine" filter. -1 when there is nowhere to go. */
function stepIndex(dir) {
  const lines = state.pkg.lines;
  for (let i = state.index + dir; i >= 0 && i < lines.length; i += dir) {
    if (!state.onlyMine || !inRoom() || isMine(lines[i])) return i;
  }
  return -1;
}

/* ---------- recording ---------- */

async function toggleRecord() {
  if (state.play === 'recording') { state.session?.stop(); return; }
  if (state.play !== 'idle') return;
  recorder.unlock();
  const line = currentLine();
  if (!canRecord(line)) return;
  try {
    await recorder.init();
    if (!recorder.micOpen) { setStatus('Asking for the microphone…'); await recorder.openMic(); refreshMicList(); }
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
    ...(original ? [{ buffer: original, color: getCss('--blue'), alpha: 0.85 }] : []),
    { samples: state.live, sampleRate: sr, length: 0, color: getCss('--amber'), alpha: 0.85 },
  ]);
  const liveIndex = original ? 1 : 0;

  const session = recorder.record({
    duration: line.duration, preroll: PREROLL, tail: TAIL,
    monitor: el.monitor.checked ? original : null,
    onChunk: (chunk) => {
      const n = Math.min(chunk.length, state.live.length - state.liveLen);
      if (n <= 0) return;
      state.live.set(chunk.subarray(0, n), state.liveLen);
      state.liveLen += n;
      wave.setLayerLength(liveIndex, state.liveLen);
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
    take.byClientId = state.clientId;
    take.gain = autoGain(take.samples);
    state.takes.set(line.id, take);
    state.mixDirty = true;
    persistTake(line.id, take);
    shareTake(line, take);
    const boost = take.gain > 1.05 ? `, levelled +${(20 * Math.log10(take.gain)).toFixed(0)} dB` : '';
    setStatus(`Take saved for line ${line.order} (${(take.samples.length / take.sampleRate).toFixed(2)}s${boost}).`);
    followAlong(line);
  } else {
    setStatus('Take was too short and was discarded.');
  }
  if (currentLine() === line) layerWave(line, original);
  refreshLineList(); refreshTakeControls(); updateDubControls(); renderRoomBar();
  if (isHost()) renderHostLobby();
}

function deleteTake() {
  const line = currentLine();
  if (!canDelete(line)) return;
  state.takes.delete(line.id);
  state.mixDirty = true;
  unpersistTake(line.id);
  if (inRoom()) state.room.send('progress', { lineId: line.id, status: 'deleted' });
  refreshStageTake(line);
  refreshLineList(); refreshTakeControls(); updateDubControls(); renderRoomBar();
  setStatus(`Deleted the take for line ${line.order}.`);
}

let nudgeShareTimer = 0;
function onNudge() {
  const line = currentLine();
  const take = state.takes.get(line.id);
  if (!take || !canNudge(line)) return;
  take.offset = Number(el.nudge.value) / 1000;
  state.mixDirty = true;
  el.nudgeOut.textContent = `${Math.round(take.offset * 1000)} ms`;
  refreshStageTake(line);
  updateDubControls();
  clearTimeout(nudgeShareTimer);
  nudgeShareTimer = setTimeout(() => { persistTake(line.id, take); shareTake(line, take); }, 600);
}

/* ---------- line playback ---------- */

function warnIfBlocked() {
  setTimeout(() => {
    if (recorder.ctx && recorder.ctx.state !== 'running') {
      setStatus('The browser is blocking sound until you interact with the page. Click or tap once, then try again.', true);
    }
  }, 400);
}

async function playLine(which) {
  if (state.play !== 'idle') return;
  recorder.unlock();
  warnIfBlocked();
  const line = currentLine();
  const original = await originalBuffer(line);
  const take = state.takes.get(line.id);
  if ((which === 'take' || which === 'both') && !take) return;
  if ((which === 'original' || which === 'both') && !original) return;

  const t0 = recorder.now + LEAD;
  if (which === 'original' || which === 'both') recorder.play(original, { at: t0 });
  if (which === 'take' || which === 'both') recorder.play(recorder.takeBuffer(take), { at: t0, offset: -take.offset, gain: take.gain ?? 1 });

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

/* ---------- follow along ---------- */

function followAlong(line) {
  clearTimeout(state.followTimer);
  if (!inRoom() || !el.follow.checked) return;
  if (currentLine() !== line) return;
  const next = nextLineIndex(state.index);
  if (next < 0 || next === state.index) return;
  state.followTimer = setTimeout(() => {
    if (state.play !== 'idle' || currentLine() !== line || el.studio.hidden) return;
    const target = state.pkg.lines[next];
    showLine(next);
    setStatus(isMine(target) ? `Line ${line.order} is in. Your next line is #${target.order}.` : `Line ${line.order} is in. On to line ${target.order}.`);
  }, 1500);
}

/* ================================================================== */
/* Full dub: transport, sync, export                                  */

function dubDuration() { return state.mix ? state.mix.duration : Math.max(state.pkg?.totalDuration || 0, state.backingBuffer?.duration || 0); }

function updateDubControls() {
  if (!state.pkg || el.studio.hidden) return;
  const any = state.takes.size > 0;
  const idle = state.play === 'idle' || state.play === 'dub';
  const driven = isPlayer() && locked();           // host drives everyone's playback in final
  const busy = state.dub.exporting || state.play === 'recording' || state.play === 'playing';
  el.btnDubToggle.disabled = !any || busy || driven;
  el.dubSeek.disabled = !any || busy || driven;
  el.btnDownloadMix.disabled = !any || busy;
  el.btnExport.disabled = !any || busy || !state.exportOk;
  el.btnExport.title = state.exportOk ? (video.ok ? 'Render the clip with the new voices to a video file' : 'Render the frames and captions with the new voices to a video file') : 'This browser cannot record video';
  el.btnDubToggle.innerHTML = state.dub.playing ? '&#10074;&#10074;' : '&#9654;';
  el.dubEmpty.hidden = any || state.dub.playing;
  if (!state.dub.playing) updateDubTime(state.dub.pos);
  if (isHost() && inRoom()) el.syncAll.disabled = false;
}

function updateDubTime(t) {
  const dur = dubDuration();
  el.dubTime.textContent = `${fmtTime(Math.max(0, t))} / ${fmtTime(dur)}`;
  if (!state.dub.scrubbing) {
    el.dubSeek.max = dur ? dur.toFixed(2) : 100;
    el.dubSeek.value = Math.max(0, Math.min(dur, t)).toFixed(2);
  }
}

async function ensureMix() {
  if (state.mix && !state.mixDirty) return state.mix;
  setStatus('Rendering mix…');
  let backing = null;
  if (state.pkg.backing) {
    state.backingBuffer ||= await recorder.decode(state.pkg.backing);
    backing = state.backingBuffer;
  }
  const buf = await renderMix(state.pkg, state.takes, { sampleRate: recorder.sampleRate, backing });
  state.mix = normalize(buf);
  state.mixDirty = false;
  return state.mix;
}

const shouldSync = () => isHost() && inRoom() && el.syncAll.checked;

/** Start (or restart) the dub from mix position `from`, first sample at context time `ctxAt`. */
async function dubStart(from = state.dub.pos, ctxAt = null, { broadcast = 'auto' } = {}) {
  if (!state.takes.size || state.dub.exporting) return;
  if (state.play === 'recording' || state.play === 'playing') return;
  recorder.unlock();
  warnIfBlocked();
  recorder.stopAll();
  await recorder.init();
  const mix = await ensureMix();
  from = Math.max(0, Math.min(mix.duration - 0.05, from || 0));

  const sync = broadcast === true || (broadcast === 'auto' && shouldSync());
  const now = recorder.now;
  let startAt = ctxAt ?? (sync ? now + ROOM_LEAD : now + LEAD);
  if (sync) state.room.send('play', { at: performance.now() + (startAt - now) * 1000, from });
  if (startAt < now + 0.02) {
    const skip = now + 0.02 - startAt;
    recorder.play(mix, { at: now + 0.02, offset: from + skip });
  } else {
    recorder.play(mix, { at: startAt, offset: from });
  }
  state.play = 'dub';
  state.dub.playing = true;
  state.dub.pos = from;
  state.dub.startAt = startAt;
  state.dub.videoStarted = false;
  state.t0 = startAt - from;           // so that mix time t = now - t0
  state.windowLen = mix.duration;
  if (video.ok) { video.show(true); el.slide.hidden = true; video.seekTo(from); } else { video.show(false); el.slide.hidden = false; }
  el.dubEmpty.hidden = true;
  updateDubControls();
  setStatus(startAt - now > 0.5 ? `Dub starts in ${(startAt - now).toFixed(1)}s…` : 'Playing the dub.');
  startLoop();
}

function dubPause({ broadcast = 'auto', pos = null } = {}) {
  const wasPlaying = state.dub.playing;
  if (wasPlaying) {
    const t = recorder.now - state.t0;
    state.dub.pos = pos ?? Math.max(0, Math.min(dubDuration(), t));
  } else if (pos != null) {
    state.dub.pos = pos;
  }
  recorder.stopAll();
  video.pause();
  state.dub.playing = false;
  if (state.play === 'dub') state.play = 'idle';
  const sync = broadcast === true || (broadcast === 'auto' && shouldSync());
  if (sync && state.room) state.room.send('stop', { pos: state.dub.pos });
  showDubFrame(state.dub.pos);
  updateDubControls(); refreshTakeControls();
}

function dubSeek(pos) {
  pos = Math.max(0, Math.min(dubDuration(), pos));
  if (state.dub.playing) { dubStart(pos); return; }
  state.dub.pos = pos;
  if (shouldSync() && state.room) state.room.send('stop', { pos });
  showDubFrame(pos);
  updateDubTime(pos);
}

function dubToggle() {
  if (state.dub.playing) dubPause(); else dubStart(state.dub.pos >= dubDuration() - 0.1 ? 0 : state.dub.pos);
}

/** Paused picture at `t`: the clip frame or the slideshow image. */
function showDubFrame(t) {
  const line = state.pkg?.lines.find((l) => t >= l.start && t < l.end) || null;
  if (video.ok) { video.show(true); el.slide.hidden = true; video.seekTo(t); }
  else if (line?.imageUrl) { el.slide.src = line.imageUrl; el.slide.hidden = false; }
  el.slideCaption.textContent = line ? line.caption : '';
  updateDubTime(t);
}

async function downloadMix() {
  if (!state.takes.size) return;
  await recorder.init();
  const mix = await ensureMix();
  const blob = audioBufferToWav(mix);
  saveBlob(blob, `${slug(state.pkg.title)}-dub.wav`);
  setStatus(`Saved ${slug(state.pkg.title)}-dub.wav (${(blob.size / 1048576).toFixed(1)} MB).`);
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function runExport() {
  if (!state.takes.size || state.dub.exporting || state.play === 'recording' || state.play === 'playing') return;
  recorder.unlock();
  dubPause({ broadcast: false });
  const { exportDub } = await import('./export.js');
  await recorder.init();
  const mix = await ensureMix();
  state.dub.exporting = true;
  state.exportAbort = new AbortController();
  el.studio.classList.add('exporting');
  el.btnExportCancel.hidden = false;
  el.dubEmpty.hidden = true;
  if (video.ok) { video.show(true); el.slide.hidden = true; } else { el.slide.hidden = false; }
  updateDubControls();
  setStatus('Exporting… the clip plays once in real time while the file is written.');
  try {
    const res = await exportDub({
      pkg: state.pkg, mix, video, recorder, captions: true, signal: state.exportAbort.signal,
      onProgress: (t, total) => {
        el.exportProgress.textContent = `exporting ${fmtTime(t)} / ${fmtTime(total)}`;
        updateDubTime(t);
        const line = state.pkg.lines.find((l) => t >= l.start && t < l.end);
        el.slideCaption.textContent = line ? line.caption : '';
        if (!video.ok && line?.imageUrl && el.slide.src !== line.imageUrl) el.slide.src = line.imageUrl;
      },
    });
    const name = `${slug(state.pkg.title)}-dub.${res.ext}`;
    saveBlob(res.blob, name);
    setStatus(`Saved ${name} (${(res.blob.size / 1048576).toFixed(1)} MB).`);
  } catch (err) {
    if (err?.name === 'AbortError') setStatus('Export cancelled.');
    else { console.error(err); setStatus(`Export failed: ${err.message || err}`, true); }
  } finally {
    state.dub.exporting = false;
    state.exportAbort = null;
    el.studio.classList.remove('exporting');
    el.btnExportCancel.hidden = true;
    el.exportProgress.textContent = '';
    video.pause();
    showDubFrame(state.dub.pos);
    updateDubControls();
  }
}

/* ================================================================== */
/* Room bar + banners                                                 */

function renderRoomBar() {
  if (!state.pkg || el.studio.hidden) return;
  if (!inRoom()) { el.doneBanner.hidden = !(allRecorded() && state.pkg.lines.length > 1); if (!el.doneBanner.hidden) { el.doneText.textContent = 'Every line is recorded. Play the dub or export it below.'; el.btnFinalizeBanner.hidden = true; } return; }
  const perf = performerIds();
  const holders = [...new Set([...perf, ...Object.values(state.roster.assignments)])];
  el.perfChips.innerHTML = holders.map((cid) => {
    const lines = linesOf(cid);
    const done = lines.filter((l) => state.takes.has(l.id)).length;
    const pct = lines.length ? Math.round((done / lines.length) * 100) : 0;
    const here = isPresent(cid);
    return `<span class="perf-chip ${cid === state.clientId ? 'me' : ''} ${here ? '' : 'gone'}" title="${escapeHtml(nameOfClient(cid))}: ${done}/${lines.length}${here ? '' : ' (left)'}">
      <span class="avatar">${escapeHtml(initials(nameOfClient(cid)))}</span>${escapeHtml(nameOfClient(cid))}${here ? '' : ' ✕'}
      <span class="bar"><i style="width:${pct}%"></i></span><span class="mono">${done}/${lines.length}</span></span>`;
  }).join('');
  const assigned = assignedLines().length;
  const done = allRecorded();
  el.roomProgress.textContent = done ? `all ${assigned} recorded ✓` : `${state.takes.size} / ${assigned} recorded`;
  el.roomProgress.style.color = done ? getCss('--green') : '';

  if (isPlayer()) {
    const m = missingAssets();
    const mine = myLines().length;
    const got = myLines().filter((l) => l.audio).length;
    const frames = state.pkg.lines.filter((l) => l.imageUrl).length;
    el.receiving.textContent = m ? `receiving… frames ${frames}/${state.pkg.lines.length}, lines ${got}/${mine}${m.backing ? ', backing track' : ''}` : '';
    el.btnResend.hidden = !m;
  }

  // completion banner
  const lock = locked();
  if (lock) { el.doneBanner.hidden = true; return; }
  const mineLeft = myLines().filter((l) => !state.takes.has(l.id)).length;
  if (done) {
    el.doneText.textContent = isHost()
      ? `All ${assigned} lines are in. Finalize to lock the takes and play the dub for everyone.`
      : `All ${assigned} lines are in. Waiting for the host to finalize and play the dub.`;
    el.btnFinalizeBanner.hidden = !isHost();
    el.doneBanner.hidden = false;
  } else if (isPerformer(state.clientId) && myLines().length && mineLeft === 0) {
    const waiting = holders.filter((cid) => cid !== state.clientId && linesOf(cid).some((l) => !state.takes.has(l.id))).map(nameOfClient);
    el.doneText.textContent = `Your lines are done. Still recording: ${waiting.join(', ') || 'nobody'}.`;
    el.btnFinalizeBanner.hidden = true;
    el.doneBanner.hidden = false;
  } else {
    el.doneBanner.hidden = true;
  }
}

/* ================================================================== */
/* Microphone picker                                                  */

async function refreshMicList() {
  let mics = [];
  try { mics = await recorder.listMics(); } catch { /* no enumerate */ }
  const sel = el.micSelect;
  const current = recorder.deviceId;
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = 'default microphone';
  sel.appendChild(def);
  for (const m of mics) {
    if (!m.deviceId || m.deviceId === 'default') continue;
    const o = document.createElement('option');
    o.value = m.deviceId;
    o.textContent = m.label || `microphone ${sel.options.length}`;
    sel.appendChild(o);
  }
  sel.value = current && [...sel.options].some((o) => o.value === current) ? current : '';
  const active = recorder.activeMicLabel();
  sel.title = active ? `using: ${active}` : 'labels appear after the first recording grants access';
}

async function onMicChange() {
  recorder.unlock();
  try {
    await recorder.openMic(el.micSelect.value);
    await refreshMicList();
    setStatus(`Microphone: ${recorder.activeMicLabel() || 'default'}.`);
  } catch (err) {
    console.error(err);
    setStatus(`Could not open that microphone: ${err.message || err}`, true);
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
  } else if (state.play === 'dub' && state.dub.playing) {
    const pkg = state.pkg;
    const now = recorder.now;
    if (now >= state.dub.startAt) {
      const line = pkg.lines.find((l) => t >= l.start && t < l.end) || null;
      if (video.ok) {
        if (!state.dub.videoStarted) { state.dub.videoStarted = true; video.playFrom(Math.max(0, t)).catch(() => {}); }
        else video.sync(t);
      } else if (line && line.imageUrl && el.slide.src !== line.imageUrl) {
        el.slide.src = line.imageUrl;
      }
      el.slideCaption.textContent = line ? line.caption : '';
      updateDubTime(t);
    } else {
      el.dubTime.textContent = `starts in ${(state.dub.startAt - now).toFixed(1)}s`;
    }
    if (t >= state.windowLen) { dubPause({ broadcast: false, pos: 0 }); setStatus('Dub finished.'); return; }
  }

  if (state.play !== 'idle' || recorder.micOpen) startLoop();
}

function stopEverything() {
  state.session?.stop();
  recorder.stopAll();
  video.pause();
  state.play = 'idle';
  state.dub.playing = false;
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
el.btnResume.addEventListener('click', resumeSession);
el.btnDiscard.addEventListener('click', discardSession);

// lobby (host)
el.btnOpenRoom.addEventListener('click', () => openRoom().catch((err) => { console.error(err); el.btnOpenRoom.disabled = false; setStatus(`Could not open a room: ${err.message || err}`, true); }));
el.btnSolo.addEventListener('click', () => { recorder.unlock(); state.mode = 'solo'; enterBooth(); setStatus('Solo booth. Pick a line and hit Record.'); saveSessionSoon(); });
el.hostPlays.addEventListener('change', () => { state.roster.hostPlays = el.hostPlays.checked; dealIfAuto(); broadcastRoster(); renderHostLobby(); saveSessionSoon(); });
el.hostName.addEventListener('change', () => { state.roster.hostName = myName(); broadcastRoster(); renderHostLobby(); saveSessionSoon(); });
el.ruleOneTake.addEventListener('change', () => { state.roster.rules.oneTake = el.ruleOneTake.checked; broadcastRoster(); saveSessionSoon(); });
el.ruleNudge.addEventListener('change', () => { state.roster.rules.allowNudge = el.ruleNudge.checked; broadcastRoster(); saveSessionSoon(); });
el.btnRedeal.addEventListener('click', () => { state.manualAssign = false; dealIfAuto(); broadcastRoster(); renderHostLobby(); saveSessionSoon(); });
el.btnStart.addEventListener('click', startRecordingPhase);
el.btnBackToBooth.addEventListener('click', () => { enterBooth(); });
el.btnLeave.addEventListener('click', leaveEverything);

// booth
el.btnRecord.addEventListener('click', toggleRecord);
el.btnPlayOrig.addEventListener('click', () => playLine('original'));
el.btnPlayTake.addEventListener('click', () => playLine('take'));
el.btnPlayBoth.addEventListener('click', () => playLine('both'));
el.btnStopPlay.addEventListener('click', stopPlayback);
el.btnDeleteTake.addEventListener('click', deleteTake);
el.nudge.addEventListener('input', onNudge);
el.micSelect.addEventListener('change', onMicChange);
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (!el.studio.hidden) refreshMicList(); });
el.btnPrev.addEventListener('click', () => { const i = stepIndex(-1); if (i >= 0) showLine(i); });
el.btnNext.addEventListener('click', () => { const i = stepIndex(1); if (i >= 0) showLine(i); });
el.onlyMine.addEventListener('change', () => { state.onlyMine = el.onlyMine.checked; refreshLineList(); refreshTakeControls(); saveSessionSoon(); });
el.btnManage.addEventListener('click', manageParts);
el.btnFinalize.addEventListener('click', finalize);
el.btnFinalizeBanner.addEventListener('click', finalize);
el.btnUnlock.addEventListener('click', unlock);
el.btnResend.addEventListener('click', () => requestMissing(true));

// dub transport
el.btnDubToggle.addEventListener('click', dubToggle);
el.dubSeek.addEventListener('pointerdown', () => { state.dub.scrubbing = true; });
el.dubSeek.addEventListener('input', () => { updateDubTime(Number(el.dubSeek.value)); if (!state.dub.playing) showDubFrame(Number(el.dubSeek.value)); });
const endScrub = () => { if (!state.dub.scrubbing) return; state.dub.scrubbing = false; dubSeek(Number(el.dubSeek.value)); };
el.dubSeek.addEventListener('pointerup', endScrub);
el.dubSeek.addEventListener('change', endScrub);
el.dubSeek.addEventListener('keyup', endScrub);
el.btnDownloadMix.addEventListener('click', downloadMix);
el.btnExport.addEventListener('click', runExport);
el.btnExportCancel.addEventListener('click', () => state.exportAbort?.abort());

document.addEventListener('keydown', (e) => {
  if (!state.pkg || el.studio.hidden || e.target.matches('input, textarea, select, button')) return;
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleRecord(); }
  else if (e.key === 'ArrowLeft' && state.play === 'idle') { e.preventDefault(); const i = stepIndex(-1); if (i >= 0) showLine(i); }
  else if (e.key === 'ArrowRight' && state.play === 'idle') { e.preventDefault(); const i = stepIndex(1); if (i >= 0) showLine(i); }
  else if (e.key === '1') playLine('original');
  else if (e.key === '2') playLine('take');
  else if (e.key === '3') playLine('both');
  else if (e.key === ' ') { e.preventDefault(); if (!el.btnDubToggle.disabled) dubToggle(); }
  else if (e.key === 'Escape') { if (state.play === 'playing') stopPlayback(); else if (state.dub.playing) dubPause(); else if (state.play === 'recording') state.session?.stop(); }
});

// Autoplay policy: the first tap or key anywhere creates and resumes the
// AudioContext, so later scheduled playback is allowed to make sound.
for (const evt of ['pointerdown', 'mousedown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(evt, () => recorder.unlock(), { passive: true, capture: true });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && recorder.ctx) recorder.unlock(); });

window.addEventListener('beforeunload', (e) => {
  if (state.play === 'recording' || state.dub.exporting) { e.preventDefault(); e.returnValue = ''; }
});

// capability check for export
import('./export.js').then((m) => { state.exportOk = m.exportSupported(); if (!el.studio.hidden) updateDubControls(); }).catch(() => { state.exportOk = false; });

// ?room=CODE prefills the join form; ?pkg=<base url> loads a hosted package.
const params = new URLSearchParams(location.search);
if (params.get('room')) { el.joinCode.value = params.get('room').toUpperCase(); el.joinName.focus(); }
if (params.get('pkg')) { el.urlInput.value = params.get('pkg'); loadFrom(entriesFromUrl(params.get('pkg')), 'URL'); }
else checkResume();

// Debug handle for the console.
window.__party = { state, recorder, wave, video, store, loadFrom, entriesFromZip, entriesFromUrl, buildPackage, tick, openRoom, joinRoomAs, dubStart, dubPause, dubSeek, runExport, finalize, unlock, resumeSession };
