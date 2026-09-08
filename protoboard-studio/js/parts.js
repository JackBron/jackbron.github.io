/* ============================================================
   parts.js — part-definition library + footprint geometry
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const LS_KEY = 'pbstudio.userparts.v1';

  /* Pin-type palette (dot colours) */
  const PIN_COLORS = {
    pwr: '#e04b4b', gnd: '#8b93a1', io: '#4da3ff', analog: '#c46bff',
    clk: '#ffb545', data: '#47c98a', in: '#4da3ff', out: '#4da3ff', nc: '#4a5160'
  };

  let userParts = [];      // user-created / imported definitions
  let index = new Map();   // id -> def  (built-ins overridden by user parts)

  /* ------------------------------------------------------------------
     Registry
     ------------------------------------------------------------------ */
  function rebuildIndex() {
    index = new Map();
    (PB.BUILTIN_PARTS || []).forEach(d => index.set(d.id, d));
    userParts.forEach(d => index.set(d.id, d));
  }

  function loadUser() {
    userParts = U.store.get(LS_KEY, []) || [];
    userParts.forEach(d => { d.builtin = false; });
    rebuildIndex();
  }

  function saveUser() {
    const ok = U.store.set(LS_KEY, userParts);
    rebuildIndex();
    PB.bus.emit('lib');
    return ok;
  }

  function get(id) { return index.get(id) || null; }
  function all() { return Array.from(index.values()); }
  function isUser(id) { return userParts.some(d => d.id === id); }

  function upsertUser(def) {
    def = U.deepClone(def);
    def.builtin = false;
    if (!def.id) def.id = U.uid('def');
    const i = userParts.findIndex(d => d.id === def.id);
    if (i >= 0) userParts[i] = def; else userParts.push(def);
    saveUser();
    return def;
  }

  function deleteUser(id) {
    const i = userParts.findIndex(d => d.id === id);
    if (i < 0) return false;
    userParts.splice(i, 1);
    saveUser();
    return true;
  }

  function resetUser() { userParts = []; saveUser(); }

  /** Merge an imported array of definitions; returns {added, replaced}. */
  function importDefs(list) {
    let added = 0, replaced = 0;
    (list || []).forEach(function (d) {
      if (!d || !d.name || !Array.isArray(d.pins)) return;
      const clean = normalise(d);
      const i = userParts.findIndex(x => x.id === clean.id);
      if (i >= 0) { userParts[i] = clean; replaced++; }
      else { userParts.push(clean); added++; }
    });
    saveUser();
    return { added, replaced };
  }

  /** Coerce an arbitrary object into a well-formed definition. */
  function normalise(d) {
    const out = {
      id: d.id || U.uid('def'),
      name: String(d.name || 'Untitled part'),
      category: d.category || 'Custom',
      refPrefix: d.refPrefix || 'U',
      desc: d.desc || '',
      color: d.color || '#2b3a4a',
      textColor: d.textColor || null,
      shape: d.shape || 'rounded',
      w: Number(d.w) || 2,
      h: Number(d.h) || 2,
      ox: d.ox === undefined ? -0.5 : Number(d.ox),
      oy: d.oy === undefined ? -0.5 : Number(d.oy),
      through: d.through !== false,
      notch: d.notch || null,
      usb: d.usb || null,
      defaultValue: d.defaultValue || '',
      tags: Array.isArray(d.tags) ? d.tags.slice() : [],
      builtin: false,
      pins: (d.pins || []).map(function (p, i) {
        return {
          n: String(p.n === undefined ? i + 1 : p.n),
          name: String(p.name === undefined ? (i + 1) : p.name),
          c: Math.round(Number(p.c) || 0),
          r: Math.round(Number(p.r) || 0),
          type: p.type || 'io'
        };
      })
    };
    return out;
  }

  /* ------------------------------------------------------------------
     Search
     ------------------------------------------------------------------ */
  function search(q) {
    const list = all();
    if (!q) return list;
    const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter(function (d) {
      const hay = (d.name + ' ' + d.category + ' ' + d.desc + ' ' +
        (d.tags || []).join(' ') + ' ' + d.pins.map(p => p.name).join(' ')).toLowerCase();
      return terms.every(t => hay.indexOf(t) >= 0);
    });
  }

  function byCategory(list) {
    const map = new Map();
    (list || all()).forEach(function (d) {
      const c = d.category || 'Misc';
      if (!map.has(c)) map.set(c, []);
      map.get(c).push(d);
    });
    const order = ['Dev boards', 'Sensors', 'Comms & display', 'Power', 'ICs & sockets',
      'Passives', 'Connectors', 'Electromechanical', 'Custom', 'Misc'];
    return Array.from(map.entries()).sort(function (a, b) {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
    });
  }

  /* ------------------------------------------------------------------
     Footprint geometry
     All functions work in HOLE units unless the name says mm.
     ------------------------------------------------------------------ */

  /** Local pin offset -> board-relative offset, honouring rotation + mirror. */
  function offset(pinC, pinR, rot, mirror) {
    const c = mirror ? -pinC : pinC;
    return U.rot90(c, pinR, rot || 0);
  }

  /** Absolute hole coordinate of one pin of a placed part. */
  function pinHole(part, p) {
    const o = offset(p.c, p.r, part.rot, part.mirror);
    return { c: part.col + o.x, r: part.row + o.y };
  }

  /** All pins of a placed part as [{pin, c, r}] */
  function pinHoles(part, def) {
    def = def || PB.state.def(part.def);
    if (!def) return [];
    return def.pins.map(function (p) {
      const h = pinHole(part, p);
      return { pin: p, c: h.c, r: h.r };
    });
  }

  /** Axis-aligned body rect in hole units (board relative), after rotation. */
  function bodyRect(part, def) {
    def = def || PB.state.def(part.def);
    if (!def) return { x: part.col - 0.5, y: part.row - 0.5, w: 1, h: 1 };
    const x0 = def.ox, y0 = def.oy, x1 = def.ox + def.w, y1 = def.oy + def.h;
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(function (pt) {
      const c = part.mirror ? -pt[0] : pt[0];
      const rr = rotF(c, pt[1], part.rot || 0);
      return { x: part.col + rr.x, y: part.row + rr.y };
    });
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
    const minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs);
    const miny = Math.min.apply(null, ys), maxy = Math.max.apply(null, ys);
    return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
  }

  /** Float rotation (bodies can have half-hole offsets). */
  function rotF(x, y, rot) {
    switch (((rot % 360) + 360) % 360) {
      case 90:  return { x: -y, y: x };
      case 180: return { x: -x, y: -y };
      case 270: return { x: y, y: -x };
      default:  return { x: x, y: y };
    }
  }

  /** Holes physically consumed by the part's leads. */
  function occupiedHoles(part, def) {
    def = def || PB.state.def(part.def);
    if (!def || def.through === false) return [];
    return pinHoles(part, def).map(h => ({ c: h.c, r: h.r }));
  }

  /** Bounding box that includes both the body and every pin. */
  function fullBounds(part, def) {
    const b = bodyRect(part, def);
    let minx = b.x, miny = b.y, maxx = b.x + b.w, maxy = b.y + b.h;
    pinHoles(part, def).forEach(function (h) {
      minx = Math.min(minx, h.c - 0.5); maxx = Math.max(maxx, h.c + 0.5);
      miny = Math.min(miny, h.r - 0.5); maxy = Math.max(maxy, h.r + 0.5);
    });
    return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
  }

  /** Bounds of the definition itself, unplaced (for thumbnails). */
  function defBounds(def) {
    let minx = def.ox, miny = def.oy, maxx = def.ox + def.w, maxy = def.oy + def.h;
    def.pins.forEach(function (p) {
      minx = Math.min(minx, p.c - 0.5); maxx = Math.max(maxx, p.c + 0.5);
      miny = Math.min(miny, p.r - 0.5); maxy = Math.max(maxy, p.r + 0.5);
    });
    return { x: minx, y: miny, w: Math.max(0.6, maxx - minx), h: Math.max(0.6, maxy - miny) };
  }

  function pinColor(type) { return PIN_COLORS[type] || PIN_COLORS.io; }

  function pinCount(def) { return def && def.pins ? def.pins.length : 0; }

  /** "15 x 7 holes · 30 pins" */
  function summary(def) {
    const b = defBounds(def);
    return U.round(b.w, 1) + '×' + U.round(b.h, 1) + ' holes · ' + pinCount(def) + 'p';
  }

  /* ------------------------------------------------------------------
     Thumbnail (small standalone SVG for the library list)
     ------------------------------------------------------------------ */
  function thumbSVG(def, w, h) {
    w = w || 44; h = h || 30;
    const b = defBounds(def);
    const pad = 0.35;
    const vb = [b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2];
    const s = Math.min(w / vb[2], h / vb[3]);
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb.join(' ') + '" preserveAspectRatio="xMidYMid meet">');
    parts.push('<rect x="' + def.ox + '" y="' + def.oy + '" width="' + def.w + '" height="' + def.h +
      '" rx="' + (def.shape === 'circle' || def.shape === 'radial' ? Math.min(def.w, def.h) / 2 : 0.2) +
      '" fill="' + U.esc(def.color) + '" stroke="#0008" stroke-width="0.06"/>');
    def.pins.forEach(function (p) {
      parts.push('<circle cx="' + p.c + '" cy="' + p.r + '" r="0.24" fill="' + pinColor(p.type) + '"/>');
    });
    parts.push('</svg>');
    void s;
    return parts.join('');
  }

  /* ------------------------------------------------------------------ */
  PB.parts = {
    PIN_COLORS,
    loadUser, saveUser, get, all, isUser, upsertUser, deleteUser, resetUser,
    importDefs, normalise, search, byCategory,
    offset, pinHole, pinHoles, bodyRect, rotF, occupiedHoles, fullBounds, defBounds,
    pinColor, pinCount, summary, thumbSVG,
    userParts: () => userParts.slice()
  };
})();
