/* ============================================================
   board.js — substrate geometry and copper connectivity
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;

  const BOARD_TYPES = [
    { id: 'perf',       name: 'Perfboard (isolated pads)', desc: 'Every hole its own pad. Everything is jumpered.' },
    { id: 'strip',      name: 'Stripboard / Veroboard',    desc: 'Continuous copper strips; break them with track cuts.' },
    { id: 'padpair',    name: 'Paired pads (2-hole)',      desc: 'Pads joined in twos along the strip axis.' },
    { id: 'breadboard', name: 'Breadboard-style (bands)',  desc: 'Describe the board as a stack of bands: rails, hole groups, blank channels.' }
  ];

  /* ------------------------------------------------------------------
     Basic geometry (mm)
     ------------------------------------------------------------------ */
  function b() { return PB.state.doc.board; }

  function pitch() { return b().pitch || 2.54; }
  function margin() { return b().margin === undefined ? 3 : b().margin; }

  /** Substrate size in mm. */
  function sizeMM(board) {
    const bd = board || b();
    const m = bd.margin === undefined ? 3 : bd.margin;
    const p = bd.pitch || 2.54;
    return { w: (bd.cols - 1) * p + m * 2, h: (bd.rows - 1) * p + m * 2 };
  }

  /** Hole (col,row) -> mm centre. Fractional input is fine. */
  function holeToMM(c, r, board) {
    const bd = board || b();
    const m = bd.margin === undefined ? 3 : bd.margin;
    const p = bd.pitch || 2.54;
    return { x: m + c * p, y: m + r * p };
  }

  /** mm -> fractional hole coordinate. */
  function mmToHole(x, y, board) {
    const bd = board || b();
    const m = bd.margin === undefined ? 3 : bd.margin;
    const p = bd.pitch || 2.54;
    return { c: (x - m) / p, r: (y - m) / p };
  }

  /** Nearest hole to a mm point, plus how far away it is (mm). */
  function nearestHole(x, y, board) {
    const h = mmToHole(x, y, board);
    const c = Math.round(h.c), r = Math.round(h.r);
    const p = holeToMM(c, r, board);
    const on = inside(c, r, board);
    const mount = on && isBlocked(c, r, board);
    const gone = on && isVoid(c, r, board);
    return {
      c: c, r: r, dist: Math.hypot(p.x - x, p.y - y),
      inside: on,
      mount: mount,
      missing: gone,
      usable: on && !mount && !gone
    };
  }

  function inside(c, r, board) {
    const bd = board || b();
    return c >= 0 && r >= 0 && c < bd.cols && r < bd.rows && c === Math.round(c) && r === Math.round(r);
  }

  function clampHole(c, r, board) {
    const bd = board || b();
    return { c: U.clamp(Math.round(c), 0, bd.cols - 1), r: U.clamp(Math.round(r), 0, bd.rows - 1) };
  }

  function holeKey(c, r) { return c + ',' + r; }

  /** Human label for a hole, e.g. "F12" — columns letters, rows numbers. */
  function holeLabel(c, r) { return colName(c) + (r + 1); }
  function colName(c) {
    let s = '';
    c = Math.round(c);
    do { s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26) - 1; } while (c >= 0);
    return s;
  }

  /* ------------------------------------------------------------------
     Band layout

     A breadboard-style board is described as a stack of horizontal
     bands, top to bottom — exactly how you would read one off the real
     thing.  A typical half-size Perma-Proto is:

       rail 1 · blank 1 · groups 5 · blank 2 (channel) · groups 5 ·
       blank 1 · rail 1

     The old code inferred the structure from the row count instead,
     which meant you could not state a layout you actually owned and
     kept getting stray extra channels.  Row count is now derived from
     the bands rather than the other way round.
     ------------------------------------------------------------------ */
  const BAND_KINDS = [
    { id: 'rail',  name: 'Power rail',     holes: true,  desc: 'each row is one strip running the full width' },
    { id: 'group', name: 'Hole groups',    holes: true,  desc: 'a column of joined holes spanning the band' },
    { id: 'perf',  name: 'Isolated pads',  holes: true,  desc: 'plain pads, nothing joined' },
    { id: 'blank', name: 'Blank / channel', holes: false, desc: 'bare board — no holes at all' }
  ];

  const BAND_PRESETS = [
    { id: 'bb-half', name: '2 rails + two banks of 5', bands: [
      { kind: 'rail', rows: 1 }, { kind: 'blank', rows: 1 }, { kind: 'group', rows: 5 },
      { kind: 'blank', rows: 2, mounts: true }, { kind: 'group', rows: 5 },
      { kind: 'blank', rows: 1 }, { kind: 'rail', rows: 1 }] },
    { id: 'bb-plain', name: 'Two banks of 5, no rails', bands: [
      { kind: 'group', rows: 5 }, { kind: 'blank', rows: 2, mounts: true }, { kind: 'group', rows: 5 }] },
    { id: 'bb-full', name: '4 rails + two banks of 5', bands: [
      { kind: 'rail', rows: 1 }, { kind: 'rail', rows: 1 }, { kind: 'blank', rows: 1 },
      { kind: 'group', rows: 5 }, { kind: 'blank', rows: 2, mounts: true }, { kind: 'group', rows: 5 },
      { kind: 'blank', rows: 1 }, { kind: 'rail', rows: 1 }, { kind: 'rail', rows: 1 }] },
    { id: 'bb-three', name: 'Three banks of 3', bands: [
      { kind: 'group', rows: 3 }, { kind: 'blank', rows: 1 }, { kind: 'group', rows: 3 },
      { kind: 'blank', rows: 1 }, { kind: 'group', rows: 3 }] }
  ];

  function bandKind(id) {
    return BAND_KINDS.find(k => k.id === id) || BAND_KINDS[2];
  }

  /** A fresh copy of a preset's bands, so callers cannot corrupt the table. */
  function presetBands(id) {
    const pre = BAND_PRESETS.find(x => x.id === id) || BAND_PRESETS[0];
    return U.deepClone(pre.bands);
  }

  /** Normalised bands with their row spans filled in, or null if unused. */
  function bands(board) {
    const bd = board || b();
    const list = Array.isArray(bd.bands) ? bd.bands : null;
    if (!list || !list.length) return null;
    const out = [];
    let r = 0;
    list.forEach(function (band) {
      const rows = U.clamp(Math.round(band.rows || 1), 1, 60);
      const kind = bandKind(band.kind).id;
      out.push({
        kind: kind, rows: rows, from: r, to: r + rows - 1,
        split: !!band.split, mounts: !!band.mounts
      });
      r += rows;
    });
    return out;
  }

  /** Rows implied by the band stack (0 when there is none). */
  function bandRows(board) {
    const bs = bands(board);
    return bs ? bs[bs.length - 1].to + 1 : 0;
  }

  /** Holes that a blank band removes, as "c,r" keys. */
  function bandBlanks(board) {
    const bd = board || b();
    const bs = bands(bd);
    const set = new Set();
    if (!bs) return set;
    bs.forEach(function (z) {
      if (bandKind(z.kind).holes) return;
      for (let r = z.from; r <= z.to && r < bd.rows; r++) {
        for (let c = 0; c < bd.cols; c++) set.add(c + ',' + r);
      }
    });
    return set;
  }

  /**
   * The pre-band algorithm, kept only so that a project saved before
   * bands existed migrates to the identical layout.
   */
  function legacyZones(bd) {
    const cfg = bd.bb || { rails: 1, groupSize: 5, gutter: 2 };
    const rails = Math.max(0, cfg.rails | 0);
    const gs = Math.max(2, cfg.groupSize | 0);
    const gutter = Math.max(0, cfg.gutter | 0);
    const zones = [];
    let r = 0;
    for (let i = 0; i < rails; i++) { zones.push({ from: r, to: r, kind: 'rail' }); r++; }
    if (rails) { zones.push({ from: r, to: r, kind: 'gap' }); r++; }
    let guard = 0;
    while (r < bd.rows && guard++ < 200) {
      const aTo = Math.min(bd.rows - 1, r + gs - 1);
      zones.push({ from: r, to: aTo, kind: 'field' });
      r = aTo + 1;
      if (r >= bd.rows) break;
      const remaining = bd.rows - r;
      const tailRails = rails ? rails + 1 : 0;
      if (remaining <= tailRails) break;
      const gTo = Math.min(bd.rows - 1, r + gutter - 1);
      if (gutter > 0) { zones.push({ from: r, to: gTo, kind: 'gutter' }); r = gTo + 1; }
      if (remaining - gutter <= tailRails) break;
    }
    for (let i = 0; i < rails && r < bd.rows; i++) {
      if (i === 0) { zones.push({ from: r, to: r, kind: 'gap' }); r++; }
      if (r < bd.rows) { zones.push({ from: r, to: r, kind: 'rail' }); r++; }
    }
    while (r < bd.rows) { zones.push({ from: r, to: r, kind: 'gap' }); r++; }
    return zones;
  }

  /**
   * Turn a legacy zone list into an equivalent band stack.
   *
   * The old gutter and gap rows carried ordinary isolated pads, so they
   * map to 'perf' rather than 'blank' — migrating a project must not
   * quietly delete holes from it.  Switch them to Blank by hand if your
   * real board has no through-holes there.
   */
  function bandsFromLegacy(bd) {
    const map = { rail: 'rail', field: 'group', gutter: 'perf', gap: 'perf' };
    const split = !!(bd.bb && bd.bb.railSplit);
    return legacyZones(bd).map(function (z) {
      const kind = map[z.kind] || 'perf';
      const band = { kind: kind, rows: z.to - z.from + 1 };
      if (kind === 'rail' && split) band.split = true;
      if (z.kind === 'gutter') band.mounts = false;
      return band;
    });
  }

  /**
   * Row bands for the renderer and the connectivity builder.  Band kinds
   * are mapped onto the zone names the rest of the code already speaks:
   * rail -> rail, group -> field, blank -> gutter, perf -> gap.
   */
  function bbZones(bd) {
    const bs = bands(bd);
    if (!bs) return legacyZones(bd);
    const kindToZone = { rail: 'rail', group: 'field', blank: 'gutter', perf: 'gap' };
    return bs.filter(z => z.from < bd.rows).map(function (z) {
      return {
        from: z.from, to: Math.min(z.to, bd.rows - 1),
        kind: kindToZone[z.kind], band: z.kind,
        split: z.split, mounts: z.mounts
      };
    });
  }

  function zoneOf(zones, row) {
    for (const z of zones) if (row >= z.from && row <= z.to) return z;
    return { from: row, to: row, kind: 'gap' };
  }

  /* ------------------------------------------------------------------
     Mount holes eat pads
     A corner M3 hole physically removes the pad it lands on, so those
     holes must not be drawn, soldered to, or routed through.
     ------------------------------------------------------------------ */
  let blockCache = null, blockSig = null;

  /** Set of "c,r" keys swallowed by a mounting hole. */
  function mountBlocked(board) {
    const bd = board || b();
    const sig = JSON.stringify([bd.cols, bd.rows, bd.pitch, bd.margin,
      bd.mountHoles, bd.mountDia, bd.padDia]);
    if (blockCache && blockSig === sig) return blockCache;

    const set = new Set();
    const holes = mountHoles(bd);
    if (holes.length) {
      /* a pad is gone once the drill encroaches on its annulus */
      const padR = (bd.padDia || 1.9) / 2;
      holes.forEach(function (mh) {
        const reach = mh.d / 2 + padR * 0.55;
        const c0 = Math.floor((mh.x - reach - (bd.margin === undefined ? 3 : bd.margin)) / bd.pitch);
        const c1 = Math.ceil((mh.x + reach - (bd.margin === undefined ? 3 : bd.margin)) / bd.pitch);
        const r0 = Math.floor((mh.y - reach - (bd.margin === undefined ? 3 : bd.margin)) / bd.pitch);
        const r1 = Math.ceil((mh.y + reach - (bd.margin === undefined ? 3 : bd.margin)) / bd.pitch);
        for (let r = Math.max(0, r0); r <= Math.min(bd.rows - 1, r1); r++) {
          for (let c = Math.max(0, c0); c <= Math.min(bd.cols - 1, c1); c++) {
            const p = holeToMM(c, r, bd);
            if (Math.hypot(p.x - mh.x, p.y - mh.y) < reach) set.add(c + ',' + r);
          }
        }
      });
    }
    blockCache = set; blockSig = sig;
    return set;
  }

  function isBlocked(c, r, board) { return mountBlocked(board).has(c + ',' + r); }

  /* ------------------------------------------------------------------
     Holes that are not there
     ------------------------------------------------------------------ */

  /** Explicitly removed holes, as a Set of "c,r".  Cached, because this
      is consulted on every pointer move. */
  let voidCache = null, voidSrc = null, voidLen = -1;

  function voidSet(board) {
    const bd = board || b();
    const list = bd.voids || [];
    if (voidCache && voidSrc === list && voidLen === list.length) return voidCache;
    voidCache = new Set(list);
    voidSrc = list;
    voidLen = list.length;
    return voidCache;
  }

  function isVoid(c, r, board) { return voidSet(board).has(c + ',' + r); }

  /** No pad here at all: a blank band, removed by hand, or a mounting hole. */
  function noHole(c, r, board) {
    return missingHoles(board).has(c + ',' + r);
  }

  /** Every hole key that has no pad. */
  function missingHoles(board) {
    const out = new Set(voidSet(board));
    mountBlocked(board).forEach(k => out.add(k));
    bandBlanks(board).forEach(k => out.add(k));
    return out;
  }

  /** The gutter holes of a breadboard-style board, as "c,r" keys. */
  function gutterHoleKeys(board) {
    const bd = board || b();
    if (bd.type !== 'breadboard') return [];
    const keys = [];
    bbZones(bd).forEach(function (z) {
      if (z.kind !== 'gutter') return;
      for (let r = z.from; r <= z.to; r++) {
        for (let c = 0; c < bd.cols; c++) keys.push(c + ',' + r);
      }
    });
    return keys;
  }

  /** Is this hole a real, usable, solderable pad? */
  function usable(c, r, board) {
    return inside(c, r, board) && !noHole(c, r, board) && !copper().isDrilled(c, r);
  }

  /* ------------------------------------------------------------------
     Copper connectivity
     Built by unioning adjacent holes that share copper, then removing
     links broken by cuts.  Cached until board/cuts change.
     ------------------------------------------------------------------ */
  let cache = null;

  function signature(bd, cuts) {
    return JSON.stringify([bd.cols, bd.rows, bd.type, bd.stripAxis, bd.bb,
      bd.mountHoles, bd.mountDia, bd.padDia, bd.margin, bd.pitch, bd.voids,
      cuts.map(c => c.col + '|' + c.row + '|' + c.axis + '|' + c.style)]);
  }

  function copper() {
    const bd = b();
    const cuts = PB.state.doc.cuts || [];
    const sig = signature(bd, cuts);
    if (cache && cache.sig === sig) return cache;

    const N = bd.cols * bd.rows;
    const idx = (c, r) => r * bd.cols + c;
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    function findp(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function uni(a, bb) { a = findp(a); bb = findp(bb); if (a !== bb) parent[bb] = a; }

    // cuts -> lookup sets
    const knifeH = new Set();  // "c,r" : link (c,r)-(c+1,r) broken
    const knifeV = new Set();  // "c,r" : link (c,r)-(c,r+1) broken
    const drill = new Set();   // "c,r" : hole isolated by a track cut
    cuts.forEach(function (ct) {
      const k = ct.col + ',' + ct.row;
      if (ct.style === 'drill') drill.add(k);
      else if (ct.axis === 'col') knifeV.add(k);
      else knifeH.add(k);
    });

    /* a mounting hole, or a hole the board never had, removes the copper
       just as thoroughly as a drill does */
    const mount = mountBlocked(bd);
    const voids = voidSet(bd);
    const blanks = bandBlanks(bd);
    const gone = k => drill.has(k) || mount.has(k) || voids.has(k) || blanks.has(k);

    const linkH = (c, r) => !gone(c + ',' + r) && !gone((c + 1) + ',' + r) && !knifeH.has(c + ',' + r);
    const linkV = (c, r) => !gone(c + ',' + r) && !gone(c + ',' + (r + 1)) && !knifeV.has(c + ',' + r);

    const axis = bd.stripAxis === 'col' ? 'col' : 'row';
    const zones = bd.type === 'breadboard' ? bbZones(bd) : null;

    if (bd.type === 'strip') {
      if (axis === 'row') {
        for (let r = 0; r < bd.rows; r++) for (let c = 0; c < bd.cols - 1; c++) if (linkH(c, r)) uni(idx(c, r), idx(c + 1, r));
      } else {
        for (let c = 0; c < bd.cols; c++) for (let r = 0; r < bd.rows - 1; r++) if (linkV(c, r)) uni(idx(c, r), idx(c, r + 1));
      }
    } else if (bd.type === 'padpair') {
      if (axis === 'row') {
        for (let r = 0; r < bd.rows; r++) for (let c = 0; c + 1 < bd.cols; c += 2) if (linkH(c, r)) uni(idx(c, r), idx(c + 1, r));
      } else {
        for (let c = 0; c < bd.cols; c++) for (let r = 0; r + 1 < bd.rows; r += 2) if (linkV(c, r)) uni(idx(c, r), idx(c, r + 1));
      }
    } else if (bd.type === 'breadboard') {
      zones.forEach(function (z) {
        if (z.kind === 'rail') {
          const splitAt = z.split ? Math.floor(bd.cols / 2) : -1;
          for (let r = z.from; r <= z.to; r++) {
            for (let c = 0; c < bd.cols - 1; c++) {
              if (c + 1 === splitAt) continue;
              if (linkH(c, r)) uni(idx(c, r), idx(c + 1, r));
            }
          }
        } else if (z.kind === 'field') {
          for (let c = 0; c < bd.cols; c++) {
            for (let r = z.from; r < z.to; r++) if (linkV(c, r)) uni(idx(c, r), idx(c, r + 1));
          }
        }
      });
    }
    // 'perf' adds no links at all.

    // group ids + member lists
    const groups = new Map();
    const keyOf = new Array(N);
    for (let r = 0; r < bd.rows; r++) {
      for (let c = 0; c < bd.cols; c++) {
        const i = idx(c, r);
        const root = findp(i);
        const key = 'b' + root;
        keyOf[i] = key;
        let g = groups.get(key);
        if (!g) { g = { key: key, holes: [], min: { c: c, r: r }, max: { c: c, r: r } }; groups.set(key, g); }
        g.holes.push({ c: c, r: r });
        if (c < g.min.c) g.min.c = c; if (r < g.min.r) g.min.r = r;
        if (c > g.max.c) g.max.c = c; if (r > g.max.r) g.max.r = r;
      }
    }

    cache = {
      sig: sig, cols: bd.cols, rows: bd.rows, groups: groups,
      dead: drill, mount: mount, voids: voids,
      key: function (c, r) {
        if (c < 0 || r < 0 || c >= bd.cols || r >= bd.rows) return null;
        return keyOf[r * bd.cols + c];
      },
      /** no copper here at all — track cut, mounting hole or missing hole */
      isDead: function (c, r) { const k = c + ',' + r; return gone(k); },
      /** drilled out by a track cut specifically */
      isDrilled: function (c, r) { return drill.has(c + ',' + r); },
      isMount: function (c, r) { return mount.has(c + ',' + r); },
      isVoid: function (c, r) { const k = c + ',' + r; return voids.has(k) || blanks.has(k); },
      /** Holes sharing copper with (c,r), excluding itself. */
      groupOf: function (c, r) {
        const k = this.key(c, r);
        return k ? (groups.get(k) || { holes: [] }) : { holes: [] };
      },
      /** true when the two holes are joined by the board's own copper. */
      joined: function (c1, r1, c2, r2) {
        const a = this.key(c1, r1), bb2 = this.key(c2, r2);
        return !!a && a === bb2 && !(c1 === c2 && r1 === r2);
      },
      zones: zones
    };
    return cache;
  }

  function invalidate() { cache = null; blockCache = null; voidCache = null; voidSrc = null; voidLen = -1; }
  PB.bus.on('doc', invalidate);

  /* ------------------------------------------------------------------
     Copper strip drawing runs — merged spans for the renderer
     Returns [{x1,y1,x2,y2,key}] in HOLE coordinates.
     ------------------------------------------------------------------ */
  function copperRuns() {
    const bd = b();
    const cp = copper();
    const runs = [];
    if (bd.type === 'perf') return runs;
    const seen = new Set();
    cp.groups.forEach(function (g) {
      if (g.holes.length < 2) return;
      // A group is drawn as horizontal and/or vertical spans of adjacent holes
      const set = new Set(g.holes.map(h => h.c + ',' + h.r));
      // horizontal runs
      g.holes.forEach(function (h) {
        if (!set.has((h.c - 1) + ',' + h.r) && set.has((h.c + 1) + ',' + h.r)) {
          let c2 = h.c;
          while (set.has((c2 + 1) + ',' + h.r)) c2++;
          const id = 'H' + h.c + ',' + h.r;
          if (!seen.has(id)) { seen.add(id); runs.push({ x1: h.c, y1: h.r, x2: c2, y2: h.r, key: g.key }); }
        }
      });
      // vertical runs
      g.holes.forEach(function (h) {
        if (!set.has(h.c + ',' + (h.r - 1)) && set.has(h.c + ',' + (h.r + 1))) {
          let r2 = h.r;
          while (set.has(h.c + ',' + (r2 + 1))) r2++;
          const id = 'V' + h.c + ',' + h.r;
          if (!seen.has(id)) { seen.add(id); runs.push({ x1: h.c, y1: h.r, x2: h.c, y2: r2, key: g.key }); }
        }
      });
    });
    return runs;
  }

  /* ------------------------------------------------------------------
     Mount hole positions (mm), corners inset by the margin
     ------------------------------------------------------------------ */
  function mountHoles(board) {
    const bd = board || b();
    const s = sizeMM(bd);
    const m = (bd.margin === undefined ? 3 : bd.margin);
    const d = bd.mountDia || 3.2;
    const inset = Math.max(m * 0.55, d * 0.62 + 0.4);
    if (s.w < inset * 3 || s.h < inset * 3) return [];
    const out = [];

    if (bd.mountHoles) {
      out.push({ x: inset, y: inset, d: d }, { x: s.w - inset, y: inset, d: d },
        { x: inset, y: s.h - inset, d: d }, { x: s.w - inset, y: s.h - inset, d: d });
    }

    /* a band can carry its own pair, which is where the mounting holes sit
       on a real breadboard-style board: in the centre channel */
    const bs = bands(bd);
    if (bs) {
      bs.forEach(function (z) {
        if (!z.mounts) return;
        const y = (holeToMM(0, z.from, bd).y + holeToMM(0, z.to, bd).y) / 2;
        out.push({ x: inset, y: y, d: d }, { x: s.w - inset, y: y, d: d });
      });
    }
    return out;
  }

  /** Does a cut make sense at this hole for the current board type? */
  function cutAllowed() { return b().type !== 'perf'; }

  /** Default cut axis for the current board. */
  function defaultCutAxis() {
    const bd = b();
    if (bd.type === 'breadboard') return 'col';
    return bd.stripAxis === 'col' ? 'col' : 'row';
  }

  PB.board = {
    BOARD_TYPES, sizeMM, holeToMM, mmToHole, nearestHole, inside, clampHole,
    holeKey, holeLabel, colName, copper, copperRuns, invalidate, mountHoles,
    mountBlocked, isBlocked, usable,
    voidSet, isVoid, noHole, missingHoles, gutterHoleKeys,
    BAND_KINDS, BAND_PRESETS, bandKind, presetBands, bands, bandRows, bandBlanks, bandsFromLegacy,
    bbZones, zoneOf, cutAllowed, defaultCutAxis, pitch, margin
  };
})();
