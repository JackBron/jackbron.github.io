/* =====================================================================
   store.js — the data layer.

   Everything above this file talks to `Store`, never to localStorage.
   The API is async on purpose: today it resolves instantly off a local
   adapter, and the day the shelf becomes multi-member the only thing
   that changes is which adapter is installed. No caller changes.

   Record shape (v1) — `ownerId` is already here so the shelf can be
   filtered and merged by member before any server exists:

   {
     id:        "flm_l2k3j4",     // stable, client-generated
     ownerId:   "local",          // who shelved it
     title:     "Repo Man",
     year:      1984,
     format:    "vhs"|"dvd"|"bluray",
     poster:    "<data: or https: URL>" | null,
     colors:    { base:"#..", light:"#..", dark:"#..", ink:"#.." },
     watchedOn: "1984-07-02",     // ISO date, no time — a day, not a moment
     rating:    0..5 in .5 steps,
     note:      "",
     source:    { provider:"tmdb", id:"12345" } | null,
     addedAt:   epoch ms,
     updatedAt: epoch ms
   }
   ===================================================================== */

export const SCHEMA = 'latefee.shelf/1';

/* ------------------------------------------------------------------ */
/* adapters                                                            */
/* ------------------------------------------------------------------ */

const LS_KEY = 'latefee.v1';

/**
 * LocalAdapter — one browser, one member. What ships today.
 */
const LocalAdapter = {
  id: 'local',

  async read() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { films: [], profile: {} };
      const d = JSON.parse(raw);
      return {
        films: Array.isArray(d.films) ? d.films : [],
        profile: d.profile && typeof d.profile === 'object' ? d.profile : {},
      };
    } catch {
      return { films: [], profile: {} };
    }
  },

  async write(state) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ schema: SCHEMA, ...state }));
      return true;
    } catch (err) {
      // Almost always the 5MB quota, and almost always because of poster
      // data URIs. The caller surfaces this; art gets downsized on the way in
      // (see coverToDataUrl) specifically to stay under it.
      return false;
    }
  },
};

/**
 * RemoteAdapter — the shape the multi-member version slots into.
 * Deliberately unwired: the contract is two methods, and every consumer
 * above already awaits them.
 *
 *   const RemoteAdapter = {
 *     id: currentUserId,
 *     async read()      { return (await fetch(`${API}/shelf`)).json(); },
 *     async write(state){ return (await fetch(`${API}/shelf`, {
 *                           method:'PUT', body: JSON.stringify(state) })).ok; },
 *   };
 *
 * Switching is `let adapter = RemoteAdapter`. Records already carry
 * `ownerId`, so a shared shelf is a filter, not a migration.
 */

let adapter = LocalAdapter;
export function useAdapter(next) { adapter = next; }

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const now = () => Date.now();
const uid = () => 'flm_' + Math.random().toString(36).slice(2, 9) + now().toString(36).slice(-3);

/** Clamp to 0..5 on half-steps. Anything unparseable becomes 0. */
export function normalizeRating(v) {
  const n = Math.round((Number(v) || 0) * 2) / 2;
  return Math.min(5, Math.max(0, n));
}

/** Today as YYYY-MM-DD in *local* time — `toISOString` would drift a day west of UTC. */
export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sanitize(rec) {
  return {
    id: rec.id || uid(),
    ownerId: rec.ownerId || adapter.id,
    title: String(rec.title || '').trim().slice(0, 200) || 'Untitled',
    year: Number.isFinite(+rec.year) && +rec.year > 0 ? Math.trunc(+rec.year) : null,
    format: ['vhs', 'dvd', 'bluray'].includes(rec.format) ? rec.format : 'vhs',
    poster: rec.poster || null,
    colors: rec.colors || null,
    watchedOn: /^\d{4}-\d{2}-\d{2}$/.test(rec.watchedOn) ? rec.watchedOn : today(),
    rating: normalizeRating(rec.rating),
    note: String(rec.note || '').slice(0, 2000),
    source: rec.source || null,
    addedAt: rec.addedAt || now(),
    updatedAt: now(),
  };
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

export const Store = {
  /** The member acting right now. Becomes a real identity later. */
  async me() {
    const { profile } = await adapter.read();
    return { id: adapter.id, name: profile.name || 'Guest' };
  },

  async setProfile(patch) {
    const state = await adapter.read();
    state.profile = { ...state.profile, ...patch };
    await adapter.write(state);
    return state.profile;
  },

  async profile() {
    return (await adapter.read()).profile;
  },

  /** @param {{owner?:string}} opts — omit `owner` for every member's films. */
  async list({ owner } = {}) {
    const { films } = await adapter.read();
    return owner ? films.filter((f) => f.ownerId === owner) : films;
  },

  async get(id) {
    const { films } = await adapter.read();
    return films.find((f) => f.id === id) || null;
  },

  async add(rec) {
    const state = await adapter.read();
    const film = sanitize(rec);
    state.films.push(film);
    const ok = await adapter.write(state);
    if (!ok) throw new Error('QUOTA');
    return film;
  },

  async update(id, patch) {
    const state = await adapter.read();
    const i = state.films.findIndex((f) => f.id === id);
    if (i < 0) return null;
    state.films[i] = sanitize({ ...state.films[i], ...patch, id });
    const ok = await adapter.write(state);
    if (!ok) throw new Error('QUOTA');
    return state.films[i];
  },

  async remove(id) {
    const state = await adapter.read();
    state.films = state.films.filter((f) => f.id !== id);
    await adapter.write(state);
  },

  /* ---- portability -------------------------------------------------- */

  async exportAll() {
    const state = await adapter.read();
    return JSON.stringify({ schema: SCHEMA, exportedAt: new Date().toISOString(), ...state }, null, 2);
  },

  /**
   * Merge an export back in. Keyed on `id`, newest `updatedAt` wins — which
   * is also the conflict rule a shared shelf will need, so it is worth
   * getting right now rather than inventing twice.
   */
  async importAll(json) {
    const incoming = JSON.parse(json);
    const films = Array.isArray(incoming.films) ? incoming.films : [];
    const state = await adapter.read();
    const byId = new Map(state.films.map((f) => [f.id, f]));

    let added = 0;
    let updated = 0;
    for (const raw of films) {
      const f = sanitize(raw);
      const prev = byId.get(f.id);
      if (!prev) { byId.set(f.id, f); added++; }
      else if ((raw.updatedAt || 0) > (prev.updatedAt || 0)) { byId.set(f.id, f); updated++; }
    }

    state.films = [...byId.values()];
    const ok = await adapter.write(state);
    if (!ok) throw new Error('QUOTA');
    return { added, updated };
  },
};
