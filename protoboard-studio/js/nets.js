/* ============================================================
   nets.js — electrical connectivity, netlist, design checks
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const S = PB.state;

  /* ------------------------------------------------------------------
     Hole occupancy — which part pins sit in which hole
     ------------------------------------------------------------------ */
  let occCache = null, occSig = null;

  function occupancy() {
    const sig = JSON.stringify(S.doc.parts.map(p => [p.id, p.def, p.col, p.row, p.rot, p.mirror, p.side]));
    if (occCache && occSig === sig) return occCache;
    const map = new Map();   // "c,r" -> [{part, pin}]
    S.doc.parts.forEach(function (part) {
      const def = S.def(part.def);
      if (!def || def.through === false) return;
      PB.parts.pinHoles(part, def).forEach(function (h) {
        const k = h.c + ',' + h.r;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ part: part, pin: h.pin, c: h.c, r: h.r });
      });
    });
    occCache = map; occSig = sig;
    return map;
  }

  function pinsAt(c, r) { return occupancy().get(c + ',' + r) || []; }

  /* ------------------------------------------------------------------
     Connectivity
     ------------------------------------------------------------------ */
  let netCache = null, netSig = null;

  function sigOf() {
    const d = S.doc;
    return JSON.stringify([
      d.board.cols, d.board.rows, d.board.type, d.board.stripAxis, d.board.bb,
      d.cuts.map(c => [c.col, c.row, c.axis, c.style]),
      d.parts.map(p => [p.id, p.def, p.col, p.row, p.rot, p.mirror]),
      d.wires.map(w => [w.id, w.net, w.pts[0], w.pts[w.pts.length - 1]]),
      d.nets.map(n => [n.id, n.name])
    ]);
  }

  function compute() {
    const sig = sigOf();
    if (netCache && netSig === sig) return netCache;

    const bd = S.doc.board;
    const cp = PB.board.copper();
    const parent = new Map();

    function find(k) {
      if (!parent.has(k)) { parent.set(k, k); return k; }
      let root = k;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(k) !== root) { const nx = parent.get(k); parent.set(k, root); k = nx; }
      return root;
    }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent.set(b, a); return a; }

    // 1) board copper
    for (let r = 0; r < bd.rows; r++) {
      for (let c = 0; c < bd.cols; c++) {
        const hk = c + ',' + r;
        find(hk);
        const g = cp.key(c, r);
        if (g) union('G' + g, hk);
      }
    }
    // 2) jumper wires join their two end holes
    S.doc.wires.forEach(function (w) {
      if (!w.pts || w.pts.length < 2) return;
      const a = w.pts[0], b = w.pts[w.pts.length - 1];
      if (!PB.board.inside(a.c, a.r) || !PB.board.inside(b.c, b.r)) return;
      union(a.c + ',' + a.r, b.c + ',' + b.r);
    });

    // 3) collect components
    const comps = new Map();
    function comp(hk) {
      const root = find(hk);
      let cm = comps.get(root);
      if (!cm) {
        cm = { id: root, holes: [], pins: [], wires: [], netIds: new Set(), name: null, color: null };
        comps.set(root, cm);
      }
      return cm;
    }
    for (let r = 0; r < bd.rows; r++) {
      for (let c = 0; c < bd.cols; c++) comp(c + ',' + r).holes.push({ c: c, r: r });
    }
    const occ = occupancy();
    occ.forEach(function (list, hk) {
      const parts = hk.split(',');
      if (!PB.board.inside(+parts[0], +parts[1])) return;
      const cm = comp(hk);
      list.forEach(o => cm.pins.push(o));
    });
    S.doc.wires.forEach(function (w) {
      if (!w.pts || !w.pts.length) return;
      const a = w.pts[0];
      if (!PB.board.inside(a.c, a.r)) return;
      const cm = comp(a.c + ',' + a.r);
      cm.wires.push(w);
      if (w.net) cm.netIds.add(w.net);
    });

    // 4) naming: declared net wins, otherwise auto N#
    let autoN = 0;
    const holeComp = new Map();
    const list = [];
    comps.forEach(function (cm) {
      cm.holes.forEach(h => holeComp.set(h.c + ',' + h.r, cm.id));
      if (!cm.pins.length && !cm.wires.length) { cm.empty = true; return; }
      const ids = Array.from(cm.netIds);
      if (ids.length) {
        const n = S.net(ids[0]);
        cm.name = n ? n.name : 'NET';
        cm.color = n ? n.color : null;
        cm.netId = ids[0];
        cm.conflict = ids.length > 1 ? ids.slice(1) : null;
      } else {
        cm.name = 'N$' + (++autoN);
        cm.color = null;
      }
      list.push(cm);
    });

    list.sort(function (a, b) {
      return (b.pins.length + b.wires.length) - (a.pins.length + a.wires.length) ||
        String(a.name).localeCompare(String(b.name));
    });

    netCache = {
      comps: list,
      all: comps,
      holeComp: holeComp,
      compAt: function (c, r) {
        const id = holeComp.get(c + ',' + r);
        return id ? comps.get(id) : null;
      },
      keyAt: function (c, r) { return holeComp.get(c + ',' + r) || null; },
      /** effective colour of the node at a hole, if any */
      colorAt: function (c, r) {
        const cm = this.compAt(c, r);
        return cm && cm.color ? cm.color : null;
      }
    };
    netSig = sig;
    return netCache;
  }

  function invalidate() { netCache = null; occCache = null; }
  PB.bus.on('doc', invalidate);

  /* ------------------------------------------------------------------
     Netlist text (Tinycad-ish / readable)
     ------------------------------------------------------------------ */
  function netlistText() {
    const n = compute();
    const out = [];
    out.push('# Netlist — ' + S.doc.meta.name);
    out.push('# generated ' + new Date().toISOString() + ' by Protoboard Studio');
    out.push('');
    n.comps.filter(c => c.pins.length + c.wires.length > 0).forEach(function (cm) {
      const nodes = cm.pins.map(p => p.part.ref + '.' + p.pin.name + '(' + PB.board.holeLabel(p.c, p.r) + ')');
      out.push('NET ' + cm.name + '  [' + (nodes.length) + ' node' + (nodes.length === 1 ? '' : 's') + ']');
      if (nodes.length) out.push('    ' + nodes.join('  '));
      if (cm.wires.length) {
        out.push('    wires: ' + cm.wires.map(w =>
          PB.board.holeLabel(w.pts[0].c, w.pts[0].r) + '→' +
          PB.board.holeLabel(w.pts[w.pts.length - 1].c, w.pts[w.pts.length - 1].r) +
          '(' + w.side + ')').join(' '));
      }
      out.push('');
    });
    return out.join('\n');
  }

  function bomRows() {
    const counts = new Map();
    S.doc.parts.forEach(function (p) {
      const def = S.def(p.def);
      const key = p.def + '|' + (p.value || '');
      if (!counts.has(key)) {
        counts.set(key, { name: def ? def.name : p.def, value: p.value || '', refs: [], def: p.def });
      }
      counts.get(key).refs.push(p.ref);
    });
    const rows = [['Qty', 'Part', 'Value', 'References', 'Definition id']];
    Array.from(counts.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(function (g) {
        g.refs.sort(natCmp);
        rows.push([g.refs.length, g.name, g.value, g.refs.join(' '), g.def]);
      });
    return rows;
  }

  function natCmp(a, b) {
    const ra = /^([A-Za-z]*)(\d*)/.exec(a) || [], rb = /^([A-Za-z]*)(\d*)/.exec(b) || [];
    return (ra[1] || '').localeCompare(rb[1] || '') || (+(ra[2] || 0)) - (+(rb[2] || 0)) || a.localeCompare(b);
  }

  /** Cut-list: every jumper with its real length, ready for the bench. */
  function wireRows() {
    const p = PB.board.pitch();
    const rows = [['#', 'Side', 'From', 'To', 'Style', 'Colour', 'Gauge (mm)', 'Path length (mm)', 'Cut length (mm)', 'Net']];
    const n = compute();
    S.doc.wires.forEach(function (w, i) {
      const mm = wireLengthMM(w);
      const a = w.pts[0], b = w.pts[w.pts.length - 1];
      const cm = n.compAt(a.c, a.r);
      rows.push([
        i + 1, w.side,
        PB.board.holeLabel(a.c, a.r), PB.board.holeLabel(b.c, b.r),
        w.mode, w.color, w.gauge,
        U.round(mm, 1), U.round(mm + 12, 1),          // + strip/bend allowance
        cm ? cm.name : ''
      ]);
      void p;
    });
    return rows;
  }

  function wireLengthMM(w) {
    const p = PB.board.pitch();
    let L = 0;
    for (let i = 0; i < w.pts.length - 1; i++) {
      L += Math.hypot(w.pts[i + 1].c - w.pts[i].c, w.pts[i + 1].r - w.pts[i].r) * p;
    }
    return L;
  }

  function totals() {
    let mm = 0;
    S.doc.wires.forEach(w => { mm += wireLengthMM(w); });
    return {
      parts: S.doc.parts.length,
      wires: S.doc.wires.length,
      wireMM: mm,
      cuts: S.doc.cuts.length,
      nets: compute().comps.filter(c => c.pins.length > 1).length
    };
  }

  /* ------------------------------------------------------------------
     Design rule checks
     ------------------------------------------------------------------ */
  function drc() {
    const issues = [];
    const bd = S.doc.board;
    const cp = PB.board.copper();
    const n = compute();
    const occ = occupancy();

    function add(sev, msg, where, focus) {
      issues.push({ id: U.uid('i'), sev: sev, msg: msg, where: where || '', focus: focus || null });
    }

    /* --- parts ------------------------------------------------------ */
    S.doc.parts.forEach(function (part) {
      const def = S.def(part.def);
      if (!def) { add('err', 'Part ' + part.ref + ' uses a missing definition "' + part.def + '"', '', { kind: 'part', id: part.id }); return; }
      const holes = PB.parts.pinHoles(part, def);
      const out = holes.filter(h => !PB.board.inside(h.c, h.r));
      if (out.length) {
        add('err', part.ref + ' has ' + out.length + ' pin' + (out.length > 1 ? 's' : '') + ' off the board',
          def.name, { kind: 'part', id: part.id });
      }
      const onMount = holes.filter(h => PB.board.inside(h.c, h.r) && cp.isMount(h.c, h.r));
      if (onMount.length) {
        add('err', part.ref + ' sits over a mounting hole — there is no pad there',
          onMount.map(h => PB.board.holeLabel(h.c, h.r)).join(' '), { kind: 'part', id: part.id });
      }
      const onVoid = holes.filter(h => PB.board.inside(h.c, h.r) && cp.isVoid(h.c, h.r));
      if (onVoid.length) {
        add('err', part.ref + ' has ' + onVoid.length + ' pin' + (onVoid.length > 1 ? 's' : '') +
          ' where this board has no hole',
          onVoid.map(h => PB.board.holeLabel(h.c, h.r)).join(' '), { kind: 'part', id: part.id });
      }
      const dead = holes.filter(h => PB.board.inside(h.c, h.r) && cp.isDrilled(h.c, h.r));
      if (dead.length) {
        add('warn', part.ref + ' has pin(s) in a drilled-out hole', dead.map(h => PB.board.holeLabel(h.c, h.r)).join(' '),
          { kind: 'part', id: part.id });
      }
      // pins of one part shorted by the board's own copper
      const byGroup = new Map();
      holes.forEach(function (h) {
        if (!PB.board.inside(h.c, h.r)) return;
        const g = cp.key(h.c, h.r);
        if (!g) return;
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(h.pin.name);
      });
      byGroup.forEach(function (names) {
        if (names.length > 1) {
          add('warn', part.ref + ' pins ' + names.join(', ') + ' are shorted by the board copper',
            'add a track cut, or rotate the part', { kind: 'part', id: part.id });
        }
      });
    });

    // pin-in-pin collisions, grouped by the parts involved rather than
    // one line per hole (a clashing DIP would otherwise produce fourteen)
    const clashes = new Map();
    occ.forEach(function (list, hk) {
      if (list.length < 2) return;
      const ids = Array.from(new Set(list.map(o => o.part.id)));
      if (ids.length < 2) return;
      const key = ids.slice().sort().join('|');
      if (!clashes.has(key)) {
        clashes.set(key, { refs: ids.map(id => (S.find('part', id) || {}).ref || id), holes: [], first: list[0].part.id });
      }
      const xy = hk.split(',').map(Number);
      clashes.get(key).holes.push(PB.board.holeLabel(xy[0], xy[1]));
    });
    clashes.forEach(function (c) {
      const who = c.refs.length === 2 ? c.refs.join(' and ')
        : c.refs.slice(0, -1).join(', ') + ' and ' + c.refs[c.refs.length - 1];
      add('err', who + ' share ' + c.holes.length + ' hole' + (c.holes.length === 1 ? '' : 's'),
        c.holes.slice(0, 12).join(' ') + (c.holes.length > 12 ? ' …' : ''),
        { kind: 'part', id: c.first });
    });

    // body overlaps on the same side
    for (let i = 0; i < S.doc.parts.length; i++) {
      for (let j = i + 1; j < S.doc.parts.length; j++) {
        const a = S.doc.parts[i], b = S.doc.parts[j];
        if (a.side !== b.side) continue;
        const da = S.def(a.def), db = S.def(b.def);
        if (!da || !db) continue;
        const ra = PB.parts.bodyRect(a, da), rb = PB.parts.bodyRect(b, db);
        const shrink = 0.12;
        if (U.rectsOverlap(
          { x: ra.x + shrink, y: ra.y + shrink, w: ra.w - shrink * 2, h: ra.h - shrink * 2 },
          { x: rb.x + shrink, y: rb.y + shrink, w: rb.w - shrink * 2, h: rb.h - shrink * 2 })) {
          add('warn', 'Bodies overlap: ' + a.ref + ' and ' + b.ref, a.side + ' side', { kind: 'part', id: a.id });
        }
      }
    }

    /* --- wires ------------------------------------------------------ */
    const seenPairs = new Map();
    S.doc.wires.forEach(function (w, i) {
      const a = w.pts[0], b = w.pts[w.pts.length - 1];
      const label = 'wire #' + (i + 1);
      if (!a || !b) { add('err', label + ' has no endpoints', '', { kind: 'wire', id: w.id }); return; }
      if (!PB.board.inside(a.c, a.r) || !PB.board.inside(b.c, b.r)) {
        add('err', label + ' ends off the board', '', { kind: 'wire', id: w.id });
      }
      if (a.c === b.c && a.r === b.r) {
        add('err', label + ' starts and ends in the same hole', PB.board.holeLabel(a.c, a.r), { kind: 'wire', id: w.id });
      }
      if (cp.isMount(a.c, a.r) || cp.isMount(b.c, b.r)) {
        add('err', label + ' lands on a mounting hole', '', { kind: 'wire', id: w.id });
      } else if (cp.isVoid(a.c, a.r) || cp.isVoid(b.c, b.r)) {
        add('err', label + ' ends where this board has no hole', '', { kind: 'wire', id: w.id });
      } else if (cp.isDrilled(a.c, a.r) || cp.isDrilled(b.c, b.r)) {
        add('warn', label + ' lands in a drilled-out hole', '', { kind: 'wire', id: w.id });
      }
      if (cp.joined(a.c, a.r, b.c, b.r)) {
        add('warn', label + ' is redundant — both ends are already on the same copper strip',
          PB.board.holeLabel(a.c, a.r) + '→' + PB.board.holeLabel(b.c, b.r), { kind: 'wire', id: w.id });
      }
      const key = [a.c + ',' + a.r, b.c + ',' + b.r].sort().join('|');
      if (seenPairs.has(key)) {
        add('warn', label + ' duplicates wire #' + (seenPairs.get(key) + 1), '', { kind: 'wire', id: w.id });
      } else seenPairs.set(key, i);
    });

    /* --- nets -------------------------------------------------------- */
    const loose = [];
    n.comps.forEach(function (cm) {
      if (cm.conflict && cm.conflict.length) {
        const names = [cm.name].concat(cm.conflict.map(id => (S.net(id) || {}).name || id));
        add('err', 'Nets shorted together: ' + names.join(' + '), 'assign one net or remove a jumper',
          cm.wires[0] ? { kind: 'wire', id: cm.wires[0].id } : null);
      }
      const types = new Set(cm.pins.map(p => p.pin.type));
      if (types.has('pwr') && types.has('gnd')) {
        const nm = cm.pins.filter(p => p.pin.type === 'pwr' || p.pin.type === 'gnd')
          .map(p => p.part.ref + '.' + p.pin.name);
        add('err', 'Power and ground on the same node (' + cm.name + ')', nm.join(' '),
          cm.pins[0] ? { kind: 'part', id: cm.pins[0].part.id } : null);
      }
      if (cm.pins.length === 1 && !cm.wires.length) {
        const p0 = cm.pins[0];
        if (p0.pin.type !== 'nc') loose.push(p0);
      }
    });

    /* One line for the lot — a board mid-design has dozens of these, and
       burying the real errors under them helps nobody. */
    if (loose.length) {
      const names = loose.map(p => p.part.ref + '.' + p.pin.name);
      add('info', loose.length + ' pin' + (loose.length === 1 ? ' is' : 's are') + ' unconnected',
        names.slice(0, 14).join(' ') + (names.length > 14 ? ' … +' + (names.length - 14) + ' more' : ''),
        { kind: 'part', id: loose[0].part.id });
    }

    /* --- ratsnest ----------------------------------------------------- */
    if (S.doc.rats.length) {
      add('info', S.doc.rats.length + ' ratsnest link' + (S.doc.rats.length > 1 ? 's are' : ' is') + ' still unrouted',
        'Tools ▸ Auto-route ratsnest', null);
    }

    /* --- board -------------------------------------------------------- */
    if (bd.type === 'perf' && S.doc.cuts.length) {
      add('info', 'Track cuts are present but the board type has no copper strips', '', null);
    }

    const order = { err: 0, warn: 1, info: 2 };
    issues.sort((a, b) => order[a.sev] - order[b.sev]);
    S.drc = issues;
    PB.bus.emit('drc');
    return issues;
  }

  PB.nets = {
    occupancy, pinsAt, compute, invalidate,
    netlistText, bomRows, wireRows, wireLengthMM, totals, drc
  };
})();
