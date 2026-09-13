// Room transport on Trystero: browsers find each other through public Nostr
// relays and then talk directly over WebRTC data channels. Nothing is hosted
// by us; the room code is the shared secret that names the room.
//
// The host is authoritative. Players send `hello`, `progress`, `take` and
// `clock`; the host answers with `roster`, `pack`, `frame`, `audio`, `phase`,
// `play` and `stop`. Takes are broadcast to every peer so each one can render
// the same mix locally.

import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm';

export { selfId };

const APP_ID = 'jackbron-choicer-party';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

export function makeCode(len = 4) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
}

/** 0.25 hands callbacks a peer object ({ peerId, ... }); older builds a string. */
const idOf = (p) => (p && typeof p === 'object' ? p.peerId : p);

export class Room {
  constructor(code) {
    this.code = code;
    this.room = joinRoom({ appId: APP_ID }, `choicer-${code}`);
    this.handlers = new Map();
    this.progressHandlers = new Map();
    this.actions = {};
    for (const name of ['hello', 'roster', 'pack', 'frame', 'audio', 'backing', 'take', 'progress', 'clock', 'play', 'stop']) {
      // Trystero 0.25 returns { send, onMessage, onReceiveProgress } where the
      // two handlers are assignable properties; earlier releases returned a
      // [send, onMessage, onProgress] tuple of functions. Support both.
      const action = this.room.makeAction(name);
      // 0.25 calls back with (data, { peerId, metadata }); older builds with
      // (data, peerId, metadata).
      const onMsg = (data, peer, meta) => {
        for (const h of this.handlers.get(name) || []) h(data, idOf(peer), meta ?? peer?.metadata);
      };
      const onProg = (pct, peer, meta) => {
        for (const h of this.progressHandlers.get(name) || []) h(pct, idOf(peer), meta ?? peer?.metadata);
      };
      if (Array.isArray(action)) {
        this.actions[name] = action[0]; action[1](onMsg); action[2]?.(onProg);
      } else {
        this.actions[name] = action.send;
        if (typeof action.onMessage === 'function') action.onMessage(onMsg); else action.onMessage = onMsg;
        if (typeof action.onReceiveProgress === 'function') action.onReceiveProgress(onProg); else action.onReceiveProgress = onProg;
      }
    }
    this._clockWaiters = new Map();
    this.on('clock', (msg, peerId) => {
      if (msg.t2 == null) {
        // a request: answer with our clock
        this.send('clock', { t1: msg.t1, t2: performance.now() }, peerId);
      } else {
        const w = this._clockWaiters.get(msg.t1);
        if (w) { this._clockWaiters.delete(msg.t1); w(msg); }
      }
    });
  }

  on(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(handler);
    return () => { const a = this.handlers.get(name); a.splice(a.indexOf(handler), 1); };
  }

  onProgress(name, handler) {
    if (!this.progressHandlers.has(name)) this.progressHandlers.set(name, []);
    this.progressHandlers.get(name).push(handler);
  }

  /** send(name, data, target?, metadata?) — target omitted broadcasts. */
  send(name, data, target = null, metadata = null) {
    const opts = {};
    if (target) opts.target = target;
    if (metadata) opts.metadata = metadata;
    return this.actions[name](data, opts);
  }

  // Same story as makeAction: 0.25 exposes these as assignable properties.
  onPeerJoin(fn) { const f = (p) => fn(idOf(p)); if (typeof this.room.onPeerJoin === 'function') this.room.onPeerJoin(f); else this.room.onPeerJoin = f; }
  onPeerLeave(fn) { const f = (p) => fn(idOf(p)); if (typeof this.room.onPeerLeave === 'function') this.room.onPeerLeave(f); else this.room.onPeerLeave = f; }
  peers() {
    const p = typeof this.room.getPeers === 'function' ? this.room.getPeers() : this.room.peers;
    return p instanceof Map ? [...p.keys()] : Object.keys(p || {});
  }
  leave() { return this.room.leave(); }

  /**
   * Estimate peer's clock minus ours (ms, performance.now() domain) with a
   * few round trips, keeping the sample with the shortest trip.
   */
  async syncClock(peerId, rounds = 6) {
    let best = null;
    for (let i = 0; i < rounds; i++) {
      const t1 = performance.now() + Math.random() * 1e-3; // unique key
      const reply = await new Promise((resolve) => {
        const timer = setTimeout(() => { this._clockWaiters.delete(t1); resolve(null); }, 2000);
        this._clockWaiters.set(t1, (m) => { clearTimeout(timer); resolve(m); });
        this.send('clock', { t1 }, peerId);
      });
      if (!reply) continue;
      const t3 = performance.now();
      const rtt = t3 - t1;
      const offset = reply.t2 - (t1 + t3) / 2;
      if (!best || rtt < best.rtt) best = { offset, rtt };
    }
    return best; // null when the peer never answered
  }
}

/* ---------------- take wire format ---------------- */

/** Float32 mono take -> Int16 buffer + JSON metadata. Halves the bytes. */
export function encodeTake(lineId, take, by) {
  const n = take.samples.length;
  const i16 = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, take.samples[i]));
    i16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return {
    data: i16,
    meta: { lineId, sampleRate: take.sampleRate, offset: take.offset || 0, gain: take.gain ?? 1, lineDuration: take.lineDuration, tail: take.tail, by },
  };
}

export function decodeTake(buffer, meta) {
  const i16 = new Int16Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / (i16[i] < 0 ? 0x8000 : 0x7fff);
  return {
    samples: f32, sampleRate: meta.sampleRate, offset: meta.offset || 0, gain: meta.gain ?? 1,
    lineDuration: meta.lineDuration, tail: meta.tail, by: meta.by, remote: true, recordedAt: Date.now(),
  };
}

/* ---------------- assignment ---------------- */

/**
 * Deal lines to performers. With at least as many characters as performers,
 * characters go round-robin and a line follows its first character. With more
 * performers than characters (a one-voice pack at a party), lines go
 * round-robin instead so everyone gets a turn.
 */
export function autoAssign(lines, characters, performerIds) {
  const out = {};
  if (!performerIds.length) return out;
  if (performerIds.length <= characters.length) {
    const byChar = {};
    characters.forEach((c, i) => { byChar[c] = performerIds[i % performerIds.length]; });
    for (const l of lines) out[l.id] = byChar[l.characters[0]] ?? performerIds[0];
  } else {
    lines.forEach((l, i) => { out[l.id] = performerIds[i % performerIds.length]; });
  }
  return out;
}
