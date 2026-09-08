/* ============================================================
   render.js — draws the whole scene into the SVG stage
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const S = PB.state;
  const sv = U.svg;

  let stage = null;
  const L = {};            // layer groups
  let staticSig = '';
  let dirty = { statics: true, content: true, overlay: true };
  let overlayModel = null; // set by tools.js each frame

  /* ------------------------------------------------------------------
     Setup
     ------------------------------------------------------------------ */
  function init(stageEl) {
    stage = stageEl;
    U.clear(stage);

    const defs = sv('defs');
    defs.appendChild(fr4Pattern());
    defs.appendChild(hatchPattern());
    defs.appendChild(copperGradient());
    defs.appendChild(glowFilter());
    stage.appendChild(defs);

    const world = sv('g#world');
    ['board', 'copper', 'pads', 'backWires', 'backParts', 'frontWires', 'frontParts',
      'pins', 'rats', 'annot', 'overlay'].forEach(function (name) {
        L[name] = sv('g', { 'data-layer': name });
        world.appendChild(L[name]);
      });
    L.world = world;
    stage.appendChild(world);

    PB.bus.on('doc', function () { dirty.statics = true; dirty.content = true; schedule(); });
    PB.bus.on('sel', function () { dirty.overlay = true; dirty.content = true; schedule(); });
    /* `flipped` lives in ui state, so the world transform has to be
       re-applied here too, not only when the camera moves. */
    PB.bus.on('ui', function () { applyTransform(); dirty.content = true; dirty.overlay = true; schedule(); });
    PB.bus.on('view', function () { applyTransform(); dirty.overlay = true; schedule(); });
    applyTransform();
    schedule();
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; draw(); });
  }
  function markOverlay(model) { overlayModel = model; dirty.overlay = true; schedule(); }
  function markContent() { dirty.content = true; schedule(); }

  function applyTransform() {
    if (L.world) L.world.setAttribute('transform', PB.view.worldTransform());
    PB.view.drawRulers();
  }

  function draw() {
    if (!stage) return;
    if (dirty.statics) { drawStatics(); dirty.statics = false; }
    if (dirty.content) { drawContent(); dirty.content = false; }
    if (dirty.overlay) { drawOverlay(); dirty.overlay = false; }
  }

  /* ------------------------------------------------------------------
     defs
     ------------------------------------------------------------------ */
  function fr4Pattern() {
    const p = sv('pattern', { id: 'fr4', width: 7, height: 7, patternUnits: 'userSpaceOnUse' });
    p.appendChild(sv('rect', { width: 7, height: 7, fill: '#000', opacity: 0 }));
    p.appendChild(sv('circle', { cx: 1.4, cy: 1.9, r: 0.45, fill: '#fff', opacity: 0.035 }));
    p.appendChild(sv('circle', { cx: 5.1, cy: 4.6, r: 0.6, fill: '#000', opacity: 0.05 }));
    p.appendChild(sv('circle', { cx: 3.2, cy: 6.2, r: 0.35, fill: '#fff', opacity: 0.03 }));
    return p;
  }
  function hatchPattern() {
    const p = sv('pattern', { id: 'hatch', width: 3, height: 3, patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)' });
    p.appendChild(sv('line', { x1: 0, y1: 0, x2: 0, y2: 3, stroke: '#000', 'stroke-width': 1, opacity: 0.22 }));
    return p;
  }
  function copperGradient() {
    const g = sv('linearGradient', { id: 'cu', x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(sv('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': 0.22 }));
    g.appendChild(sv('stop', { offset: '45%', 'stop-color': '#ffffff', 'stop-opacity': 0 }));
    g.appendChild(sv('stop', { offset: '100%', 'stop-color': '#000000', 'stop-opacity': 0.25 }));
    return g;
  }
  function glowFilter() {
    const f = sv('filter', { id: 'glow', x: '-60%', y: '-60%', width: '220%', height: '220%' });
    f.appendChild(sv('feGaussianBlur', { stdDeviation: 0.55, result: 'b' }));
    const m = sv('feMerge');
    m.appendChild(sv('feMergeNode', { in: 'b' }));
    m.appendChild(sv('feMergeNode', { in: 'SourceGraphic' }));
    f.appendChild(m);
    return f;
  }

  /* ------------------------------------------------------------------
     Static layers: substrate, copper, pads
     ------------------------------------------------------------------ */
  function drawStatics() {
    const bd = S.doc.board;
    const sig = JSON.stringify([bd, S.doc.cuts]);
    if (sig === staticSig) return;
    staticSig = sig;

    const size = PB.board.sizeMM();
    const p = bd.pitch;

    /* --- substrate --- */
    const g = U.clear(L.board);
    const r = Math.min(2.4, size.w / 12, size.h / 12);
    g.appendChild(sv('rect', {
      x: 0, y: 0, width: size.w, height: size.h, rx: r,
      fill: bd.color, stroke: U.shade(bd.color, -0.4), 'stroke-width': 0.25
    }));
    g.appendChild(sv('rect', { x: 0, y: 0, width: size.w, height: size.h, rx: r, fill: 'url(#fr4)' }));
    g.appendChild(sv('rect', {
      x: 0.35, y: 0.35, width: size.w - 0.7, height: size.h - 0.7, rx: Math.max(0, r - 0.35),
      fill: 'none', stroke: '#ffffff', 'stroke-width': 0.18, opacity: 0.10
    }));
    PB.board.mountHoles(bd).forEach(function (m) {
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: m.d / 2 + 0.75, fill: U.shade(bd.color, -0.25) }));
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: m.d / 2, fill: '#07090c' }));
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: m.d / 2, fill: 'none', stroke: '#fff', 'stroke-width': 0.12, opacity: 0.2 }));
    });

    /* --- copper --- */
    const cg = U.clear(L.copper);
    const runs = PB.board.copperRuns();
    const cw = p * 0.66;
    runs.forEach(function (run) {
      const a = PB.board.holeToMM(run.x1, run.y1), b = PB.board.holeToMM(run.x2, run.y2);
      cg.appendChild(sv('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: bd.copperColor || '#c98a3c', 'stroke-width': cw, 'stroke-linecap': 'round', opacity: 0.92
      }));
      cg.appendChild(sv('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: 'url(#cu)', 'stroke-width': cw, 'stroke-linecap': 'round'
      }));
    });
    if (bd.type === 'breadboard') drawBreadboardMarks(cg, bd);

    /* --- cuts --- */
    S.doc.cuts.forEach(function (ct) { drawCut(cg, ct, bd); });

    /* --- pads ---
       Holes swallowed by a mounting hole are simply not there: the drill
       has taken the pad away, so nothing is drawn over it. */
    const pg = U.clear(L.pads);
    const padR = (bd.padDia || 1.9) / 2;
    const holeR = (bd.holeDia || 1.0) / 2;
    const big = bd.cols * bd.rows > 6000;
    const blocked = PB.board.missingHoles(bd);
    const ringD = [], holeD = [];
    for (let rr = 0; rr < bd.rows; rr++) {
      for (let cc = 0; cc < bd.cols; cc++) {
        if (blocked.has(cc + ',' + rr)) continue;
        const m = PB.board.holeToMM(cc, rr);
        if (!big) ringD.push(circlePath(m.x, m.y, padR));
        holeD.push(circlePath(m.x, m.y, holeR));
      }
    }
    if (!big) {
      pg.appendChild(sv('path', {
        d: ringD.join('') + holeD.join(''), 'fill-rule': 'evenodd',
        fill: bd.padColor || '#d9ae42', opacity: 0.95
      }));
    }
    pg.appendChild(sv('path', { d: holeD.join(''), fill: '#0a0c10', opacity: big ? 0.75 : 0.92 }));
  }

  function circlePath(cx, cy, r) {
    return 'M' + U.round(cx - r, 3) + ' ' + U.round(cy, 3) +
      'a' + r + ' ' + r + ' 0 1 0 ' + (r * 2) + ' 0' +
      'a' + r + ' ' + r + ' 0 1 0 ' + (-r * 2) + ' 0z';
  }

  function drawBreadboardMarks(g, bd) {
    const zones = PB.board.bbZones(bd);
    const size = PB.board.sizeMM(bd);
    /* the central channel, drawn as a recessed band */
    zones.forEach(function (z) {
      if (z.kind !== 'gutter') return;
      const a = PB.board.holeToMM(0, z.from), b = PB.board.holeToMM(0, z.to);
      const pad = bd.pitch * 0.5;
      g.appendChild(sv('rect', {
        x: 1.2, y: a.y - pad, width: size.w - 2.4, height: (b.y - a.y) + pad * 2,
        rx: 0.6, fill: '#000000', opacity: 0.18
      }));
    });
    zones.forEach(function (z) {
      if (z.kind !== 'rail') return;
      const y = PB.board.holeToMM(0, z.from).y;
      const isTop = z.from < bd.rows / 2;
      const col = isTop ? '#e04b4b' : '#4d7fe0';
      const off = (bd.pitch * 0.62) * (isTop ? -1 : 1);
      g.appendChild(sv('line', {
        x1: 1.2, y1: y + off, x2: size.w - 1.2, y2: y + off,
        stroke: col, 'stroke-width': 0.28, opacity: 0.75
      }));
    });
  }

  function drawCut(g, ct, bd) {
    const p = bd.pitch;
    if (ct.style === 'drill') {
      const m = PB.board.holeToMM(ct.col, ct.row);
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: p * 0.36, fill: U.shade(bd.color, -0.15) }));
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: p * 0.36, fill: 'none', stroke: '#ff5f56', 'stroke-width': 0.16, opacity: 0.8 }));
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: (bd.holeDia || 1) / 2, fill: '#0a0c10' }));
      return;
    }
    // knife cut: a gap in the copper between this hole and the next one along
    const along = ct.axis === 'col' ? { c: 0, r: 1 } : { c: 1, r: 0 };
    const a = PB.board.holeToMM(ct.col, ct.row);
    const b = PB.board.holeToMM(ct.col + along.c, ct.row + along.r);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const perp = ct.axis === 'col' ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const half = p * 0.42;
    const gapW = p * 0.16;
    g.appendChild(sv('line', {
      x1: mx - perp.x * half, y1: my - perp.y * half,
      x2: mx + perp.x * half, y2: my + perp.y * half,
      stroke: bd.color, 'stroke-width': gapW * 2.2, 'stroke-linecap': 'butt'
    }));
    g.appendChild(sv('line', {
      x1: mx - perp.x * half, y1: my - perp.y * half,
      x2: mx + perp.x * half, y2: my + perp.y * half,
      stroke: '#ff5f56', 'stroke-width': 0.14, opacity: 0.65
    }));
  }

  /* ------------------------------------------------------------------
     Content layers
     ------------------------------------------------------------------ */
  function drawContent() {
    const bd = S.doc.board;
    const ui = S.ui;
    const pitchPx = PB.view.pitchPx();
    const active = ui.side;
    const nets = PB.nets.compute();

    const groups = {
      front: { wires: U.clear(L.frontWires), parts: U.clear(L.frontParts) },
      back: { wires: U.clear(L.backWires), parts: U.clear(L.backParts) }
    };
    const pins = U.clear(L.pins);
    const rats = U.clear(L.rats);
    const annot = U.clear(L.annot);

    ['front', 'back'].forEach(function (side) {
      const isActive = side === active;
      const op = isActive ? 1 : 0.38;
      groups[side].wires.setAttribute('opacity', op);
      groups[side].parts.setAttribute('opacity', isActive ? 1 : 0.45);
      groups[side].wires.setAttribute('data-side', side);
    });
    L.frontParts.setAttribute('opacity',
      (active === 'front' ? 1 : 0.45) * (ui.partOpacity));
    L.backParts.setAttribute('opacity',
      (active === 'back' ? 1 : 0.45) * (ui.partOpacity));

    /* --- wires --- */
    S.doc.wires.forEach(function (w) {
      const g = groups[w.side === 'back' ? 'back' : 'front'].wires;
      g.appendChild(wireNode(w, w.side === active, nets));
    });

    /* --- parts --- */
    S.doc.parts.forEach(function (part) {
      const def = S.def(part.def);
      const g = groups[part.side === 'back' ? 'back' : 'front'].parts;
      g.appendChild(partNode(part, def, pitchPx));
    });

    /* --- pin dots on top of everything solid --- */
    S.doc.parts.forEach(function (part) {
      const def = S.def(part.def);
      if (!def) return;
      pins.appendChild(pinNode(part, def, pitchPx, nets));
    });

    /* --- highlighted net --- */
    if (ui.highlightNet) {
      const cm = nets.all.get(ui.highlightNet);
      if (cm) {
        const hg = sv('g', { 'pointer-events': 'none' });
        cm.holes.forEach(function (h) {
          const m = PB.board.holeToMM(h.c, h.r);
          hg.appendChild(sv('circle', {
            cx: m.x, cy: m.y, r: bd.pitch * 0.42,
            fill: 'none', stroke: '#ffe066', 'stroke-width': 0.22, opacity: 0.9
          }));
        });
        pins.appendChild(hg);
      }
    }

    /* --- ratsnest --- */
    if (ui.showRats) {
      S.doc.rats.forEach(function (rt) {
        const a = ratEnd(rt.a), b = ratEnd(rt.b);
        if (!a || !b) return;
        const ma = PB.board.holeToMM(a.c, a.r), mb = PB.board.holeToMM(b.c, b.r);
        const col = rt.net ? (S.netColor(rt.net) || '#8fb8ff') : '#8fb8ff';
        rats.appendChild(sv('line', {
          x1: ma.x, y1: ma.y, x2: mb.x, y2: mb.y,
          stroke: col, 'stroke-width': 0.2, 'stroke-dasharray': '0.9 0.7',
          opacity: 0.85, 'data-hit': 'rat', 'data-id': rt.id
        }));
      });
    }

    /* --- annotation text --- */
    S.doc.texts.forEach(function (t) {
      const m = PB.board.holeToMM(t.col, t.row);
      const node = sv('text', {
        x: m.x, y: m.y, fill: t.color || '#fff',
        'font-size': t.size || 2.4, 'font-family': 'system-ui, sans-serif',
        'dominant-baseline': 'middle', 'text-anchor': t.anchor || 'start',
        opacity: t.side === active ? 0.95 : 0.35,
        transform: textTransform(t.rot, m.x, m.y),
        'data-hit': 'text', 'data-id': t.id
      });
      node.textContent = t.text;
      annot.appendChild(node);
    });

    PB.bus.emit('stats');
  }

  /** rotation + flipped-view un-mirroring, in the right order */
  function textTransform(rot, x, y) {
    const tf = [];
    if (rot) tf.push('rotate(' + rot + ' ' + U.round(x, 3) + ' ' + U.round(y, 3) + ')');
    if (S.ui.flipped) tf.push('translate(' + U.round(2 * x, 3) + ',0) scale(-1,1)');
    return tf.length ? tf.join(' ') : null;
  }

  function ratEnd(e) {
    if (!e) return null;
    if (e.part) {
      const part = S.find('part', e.part);
      if (!part) return null;
      const def = S.def(part.def);
      if (!def) return null;
      const pin = def.pins.find(p => p.n === e.pin || p.name === e.pin);
      if (!pin) return null;
      return PB.parts.pinHole(part, pin);
    }
    return { c: e.c, r: e.r };
  }

  /* ------------------------------------------------------------------
     Wire node
     ------------------------------------------------------------------ */
  function wireNode(w, isActive, nets) {
    const bd = S.doc.board;
    const g = sv('g', { 'data-hit': 'wire', 'data-id': w.id, class: 'wire' });
    const selected = S.sel.has('wire:' + w.id);
    const radius = w.mode === 'free' ? 0 : bd.pitch * 0.34;
    const d = PB.router.toPath(w.pts, radius);
    if (!d) return g;

    let col = w.color || '#e04b4b';
    if (w.net) col = S.netColor(w.net, col);
    const gauge = Math.max(0.22, w.gauge || 0.51);
    const insul = gauge + 0.42;   // insulation thickness

    // selection halo
    if (selected) {
      g.appendChild(sv('path', {
        d: d, fill: 'none', stroke: '#ffe066', 'stroke-width': insul + 0.9,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.65
      }));
    }
    // net highlight
    if (S.ui.highlightNet && nets) {
      const cm = nets.compAt(w.pts[0].c, w.pts[0].r);
      if (cm && cm.id === S.ui.highlightNet) {
        g.appendChild(sv('path', {
          d: d, fill: 'none', stroke: '#ffe066', 'stroke-width': insul + 0.7,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.5
        }));
      }
    }
    // dark outline, body, highlight
    g.appendChild(sv('path', {
      d: d, fill: 'none', stroke: '#05070a', 'stroke-width': insul,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.55
    }));
    g.appendChild(sv('path', {
      d: d, fill: 'none', stroke: col, 'stroke-width': insul - 0.16,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'stroke-dasharray': isActive ? null : '1.4 0.9'
    }));
    g.appendChild(sv('path', {
      d: d, fill: 'none', stroke: '#ffffff', 'stroke-width': Math.max(0.08, insul * 0.22),
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.22,
      transform: 'translate(0,' + (-insul * 0.2) + ')'
    }));

    // solder ends
    [w.pts[0], w.pts[w.pts.length - 1]].forEach(function (p) {
      const m = PB.board.holeToMM(p.c, p.r);
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: gauge * 0.62 + 0.34, fill: '#b9c2cf', opacity: 0.9 }));
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: gauge * 0.62 + 0.34, fill: 'none', stroke: '#05070a', 'stroke-width': 0.1, opacity: 0.6 }));
    });

    // waypoint handles when selected
    if (selected && PB.view.pitchPx() > 9) {
      w.pts.forEach(function (p, i) {
        const m = PB.board.holeToMM(p.c, p.r);
        g.appendChild(sv('rect', {
          x: m.x - 0.42, y: m.y - 0.42, width: 0.84, height: 0.84, rx: 0.14,
          fill: i === 0 || i === w.pts.length - 1 ? '#ffe066' : '#ffffff',
          stroke: '#05070a', 'stroke-width': 0.09,
          'data-hit': 'wirept', 'data-id': w.id, 'data-i': i
        }));
      });
    }
    return g;
  }

  /* ------------------------------------------------------------------
     Part node
     ------------------------------------------------------------------ */
  function partNode(part, def, pitchPx) {
    const bd = S.doc.board;
    const p = bd.pitch;
    const origin = PB.board.holeToMM(part.col, part.row);
    const selected = S.sel.has('part:' + part.id);
    const g = sv('g', {
      'data-hit': 'part', 'data-id': part.id,
      transform: 'translate(' + U.round(origin.x, 3) + ',' + U.round(origin.y, 3) + ') ' +
        'rotate(' + (part.rot || 0) + ') scale(' + (part.mirror ? -1 : 1) + ',1)'
    });

    if (!def) {
      g.appendChild(sv('rect', { x: -p / 2, y: -p / 2, width: p, height: p, fill: '#ff5f56', opacity: 0.6 }));
      return g;
    }

    const x = def.ox * p, y = def.oy * p, w = def.w * p, h = def.h * p;
    const col = def.color || '#2b3a4a';
    const txt = def.textColor || U.readableOn(col);

    if (selected) {
      g.appendChild(sv('rect', {
        x: x - 0.55, y: y - 0.55, width: w + 1.1, height: h + 1.1, rx: 0.7,
        fill: 'none', stroke: '#ffe066', 'stroke-width': 0.35, opacity: 0.9
      }));
    }

    g.appendChild(bodyArt(def, p));

    /* silkscreen text */
    if (S.ui.showLabels && pitchPx > 7) {
      const cx = x + w / 2, cy = y + h / 2;
      const flipText = (part.rot === 180 || part.mirror);
      const label = part.ref + (part.value ? ' ' + part.value : '');
      const fs = Math.min(p * 0.78, Math.max(p * 0.42, Math.min(w, h) * 0.42));
      const tnode = sv('text', {
        x: cx, y: cy, fill: txt, 'font-size': fs,
        'font-family': 'system-ui, sans-serif', 'font-weight': 600,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        opacity: 0.92, 'pointer-events': 'none',
        transform: flipText ? 'rotate(180 ' + cx + ' ' + cy + ')' : null
      });
      tnode.textContent = label;
      // long labels on narrow parts sit outside the body
      if (fs * label.length * 0.58 > w && h < w) {
        tnode.setAttribute('y', y - fs * 0.45);
        tnode.setAttribute('fill', '#e8edf5');
        tnode.setAttribute('font-size', p * 0.6);
      }
      g.appendChild(tnode);
    }

    /* pin-1 marker */
    if (def.pins.length > 1 && def.shape !== 'axial' && def.shape !== 'led') {
      const p1 = def.pins[0];
      g.appendChild(sv('circle', {
        cx: p1.c * p - p * 0.42, cy: p1.r * p - p * 0.42, r: p * 0.1,
        fill: txt, opacity: 0.85, 'pointer-events': 'none'
      }));
    }
    return g;
  }

  /**
   * Just the body artwork for a definition, drawn in mm about the part
   * origin.  Shared with the Part Designer so its shape preview is the
   * real thing rather than a stand-in rectangle.
   */
  function bodyArt(def, p) {
    const g = sv('g');
    const x = def.ox * p, y = def.oy * p, w = def.w * p, h = def.h * p;
    const col = def.color || '#2b3a4a';
    switch (def.shape) {
      case 'circle': case 'radial': drawRadial(g, x, y, w, h, col); break;
      case 'disc':   drawDisc(g, x, y, w, h, col); break;
      case 'axial':  drawAxial(g, def, p, col); break;
      case 'led':    drawLed(g, def, p, col); break;
      case 'to92':   drawTO92(g, x, y, w, h, col); break;
      case 'to220':  drawTO220(g, x, y, w, h, col); break;
      case 'header': drawHeader(g, def, p, col); break;
      case 'screw':  drawScrew(g, def, p, col); break;
      case 'tact':   drawTact(g, x, y, w, h, col); break;
      case 'dip':    drawDIP(g, x, y, w, h, col); break;
      default:       drawBoardBody(g, def, x, y, w, h, col);
    }
    return g;
  }

  function drawBoardBody(g, def, x, y, w, h, col) {
    const rx = def.shape === 'rect' ? 0 : Math.min(w, h) * 0.09;
    g.appendChild(sv('rect', { x: x, y: y, width: w, height: h, rx: rx, fill: col,
      stroke: U.shade(col, -0.35), 'stroke-width': 0.16 }));
    g.appendChild(sv('rect', { x: x, y: y, width: w, height: h, rx: rx, fill: 'url(#cu)', opacity: 0.55 }));
    g.appendChild(sv('rect', { x: x + 0.22, y: y + 0.22, width: Math.max(0, w - 0.44), height: Math.max(0, h - 0.44),
      rx: Math.max(0, rx - 0.2), fill: 'none', stroke: '#ffffff', 'stroke-width': 0.1, opacity: 0.14 }));
    if (def.usb) {
      const uw = Math.min(w * 0.42, 3.4), uh = 1.6;
      g.appendChild(sv('rect', { x: x - uh * 0.35, y: y + h / 2 - uw / 2, width: uh, height: uw,
        rx: 0.25, fill: '#9aa3b1', stroke: '#05070a', 'stroke-width': 0.1 }));
    }
  }
  function drawDIP(g, x, y, w, h, col) {
    g.appendChild(sv('rect', { x: x, y: y, width: w, height: h, rx: 0.25, fill: col,
      stroke: '#05070a', 'stroke-width': 0.14 }));
    g.appendChild(sv('rect', { x: x, y: y, width: w, height: h, rx: 0.25, fill: 'url(#cu)', opacity: 0.7 }));
    g.appendChild(sv('path', {
      d: 'M' + x + ' ' + (y + h / 2 - 0.85) + 'a0.85 0.85 0 0 0 0 1.7z',
      fill: '#05070a', opacity: 0.55
    }));
  }
  function drawRadial(g, x, y, w, h, col) {
    const r = Math.min(w, h) / 2;
    const cx = x + w / 2, cy = y + h / 2;
    g.appendChild(sv('circle', { cx: cx, cy: cy, r: r, fill: col, stroke: U.shade(col, -0.4), 'stroke-width': 0.16 }));
    g.appendChild(sv('circle', { cx: cx, cy: cy, r: r * 0.94, fill: 'url(#cu)', opacity: 0.6 }));
    g.appendChild(sv('path', {
      d: 'M' + (cx - r) + ' ' + cy + 'a' + r + ' ' + r + ' 0 0 0 ' + (r) + ' ' + r + 'z',
      fill: '#e8edf5', opacity: 0.18
    }));
  }
  function drawDisc(g, x, y, w, h, col) {
    const cx = x + w / 2, cy = y + h / 2;
    const rx = w / 2 * 0.96, ry = h / 2 * 1.05;
    g.appendChild(sv('ellipse', { cx: cx, cy: cy - ry * 0.15, rx: rx, ry: ry,
      fill: col, stroke: U.shade(col, -0.4), 'stroke-width': 0.14 }));
  }
  /**
   * Where the two leads of an axial part sit.  Falls back to the body
   * outline when the definition has fewer than two pins, which happens
   * while a part is still being drawn in the Part Designer.
   */
  function leadLine(def, p) {
    const n = def.pins.length;
    if (n >= 2) {
      const a = def.pins[0], b = def.pins[n - 1];
      return { x1: a.c * p, y1: a.r * p, x2: b.c * p, y2: b.r * p };
    }
    if (n === 1) {
      const a = def.pins[0];
      return { x1: a.c * p, y1: a.r * p, x2: a.c * p + Math.max(p, (def.w - 1) * p), y2: a.r * p };
    }
    const midY = (def.oy + def.h / 2) * p;
    return { x1: (def.ox + 0.5) * p, y1: midY, x2: (def.ox + def.w - 0.5) * p, y2: midY };
  }

  function drawAxial(g, def, p, col) {
    const L2 = leadLine(def, p);
    const x1 = L2.x1, y1 = L2.y1, x2 = L2.x2, y2 = L2.y2;
    const len = Math.hypot(x2 - x1, y2 - y1) || p;
    const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    const bodyLen = Math.max(p * 0.7, len - p * 0.75);
    const bodyH = p * 0.62;
    const gg = sv('g', { transform: 'translate(' + x1 + ',' + y1 + ') rotate(' + ang + ')' });
    gg.appendChild(sv('line', { x1: 0, y1: 0, x2: len, y2: 0, stroke: '#b9c2cf', 'stroke-width': 0.28 }));
    const bx = (len - bodyLen) / 2;
    gg.appendChild(sv('rect', { x: bx, y: -bodyH / 2, width: bodyLen, height: bodyH, rx: bodyH * 0.35,
      fill: col, stroke: U.shade(col, -0.4), 'stroke-width': 0.12 }));
    gg.appendChild(sv('rect', { x: bx, y: -bodyH / 2, width: bodyLen, height: bodyH, rx: bodyH * 0.35,
      fill: 'url(#cu)', opacity: 0.5 }));
    if (def.notch === 'cathode') {
      gg.appendChild(sv('rect', { x: bx + bodyLen - bodyLen * 0.22, y: -bodyH / 2,
        width: bodyLen * 0.14, height: bodyH, fill: '#e8edf5', opacity: 0.9 }));
    }
    g.appendChild(gg);
  }
  function drawLed(g, def, p, col) {
    const L2 = leadLine(def, p);
    const cx = (L2.x1 + L2.x2) / 2, cy = (L2.y1 + L2.y2) / 2;
    const r = p * 0.72;
    g.appendChild(sv('line', { x1: L2.x1, y1: L2.y1, x2: L2.x2, y2: L2.y2, stroke: '#b9c2cf', 'stroke-width': 0.28 }));
    g.appendChild(sv('circle', { cx: cx, cy: cy, r: r, fill: col, opacity: 0.92,
      stroke: U.shade(col, -0.35), 'stroke-width': 0.14 }));
    g.appendChild(sv('circle', { cx: cx - r * 0.28, cy: cy - r * 0.28, r: r * 0.34, fill: '#fff', opacity: 0.5 }));
    g.appendChild(sv('path', { d: 'M' + (cx + r * 0.72) + ' ' + (cy - r) + 'L' + (cx + r * 0.72) + ' ' + (cy + r),
      stroke: U.shade(col, -0.5), 'stroke-width': 0.16, fill: 'none' }));
  }
  function drawTO92(g, x, y, w, h, col) {
    const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h * 1.4) / 2;
    g.appendChild(sv('path', {
      d: 'M' + (cx - r) + ' ' + (cy + r * 0.55) + 'A' + r + ' ' + r + ' 0 1 1 ' + (cx + r) + ' ' + (cy + r * 0.55) + 'Z',
      fill: col, stroke: '#05070a', 'stroke-width': 0.14
    }));
  }
  function drawTO220(g, x, y, w, h, col) {
    g.appendChild(sv('rect', { x: x, y: y, width: w, height: h * 0.62, rx: 0.2,
      fill: '#8e97a3', stroke: '#05070a', 'stroke-width': 0.12 }));
    g.appendChild(sv('circle', { cx: x + w / 2, cy: y + h * 0.2, r: Math.min(w, h) * 0.11, fill: '#05070a', opacity: 0.6 }));
    g.appendChild(sv('rect', { x: x, y: y + h * 0.5, width: w, height: h * 0.5, rx: 0.2,
      fill: col, stroke: '#05070a', 'stroke-width': 0.12 }));
  }
  function drawHeader(g, def, p, col) {
    def.pins.forEach(function (pin) {
      const cx = pin.c * p, cy = pin.r * p;
      const s = p * 0.86;
      g.appendChild(sv('rect', { x: cx - s / 2, y: cy - s / 2, width: s, height: s, rx: 0.15,
        fill: col, stroke: '#05070a', 'stroke-width': 0.1 }));
      g.appendChild(sv('rect', { x: cx - s * 0.22, y: cy - s * 0.22, width: s * 0.44, height: s * 0.44,
        fill: '#c9a24a', opacity: 0.85 }));
    });
  }
  function drawScrew(g, def, p, col) {
    const b = PB.parts.defBounds(def);
    g.appendChild(sv('rect', { x: def.ox * p, y: def.oy * p, width: def.w * p, height: def.h * p,
      rx: 0.3, fill: col, stroke: U.shade(col, -0.4), 'stroke-width': 0.16 }));
    def.pins.forEach(function (pin) {
      const cx = pin.c * p, cy = pin.r * p - p * 0.9;
      const r = p * 0.52;
      g.appendChild(sv('circle', { cx: cx, cy: cy, r: r, fill: '#8e97a3', stroke: '#05070a', 'stroke-width': 0.1 }));
      g.appendChild(sv('line', { x1: cx - r * 0.65, y1: cy, x2: cx + r * 0.65, y2: cy, stroke: '#05070a', 'stroke-width': 0.18 }));
    });
    void b;
  }
  function drawTact(g, x, y, w, h, col) {
    g.appendChild(sv('rect', { x: x, y: y, width: w, height: h, rx: 0.2, fill: col,
      stroke: '#05070a', 'stroke-width': 0.14 }));
    g.appendChild(sv('circle', { cx: x + w / 2, cy: y + h / 2, r: Math.min(w, h) * 0.24, fill: '#d8dde5' }));
    g.appendChild(sv('circle', { cx: x + w / 2, cy: y + h / 2, r: Math.min(w, h) * 0.24, fill: 'none',
      stroke: '#05070a', 'stroke-width': 0.1 }));
  }

  /* ------------------------------------------------------------------
     Pin markers + names
     ------------------------------------------------------------------ */
  function pinNode(part, def, pitchPx, nets) {
    const p = S.doc.board.pitch;
    const g = sv('g', { 'data-hit': 'pins', 'data-id': part.id });
    const layout = labelLayout(def, p);
    const selected = S.sel.has('part:' + part.id);
    const showNames = S.ui.showPinNames === 'always' ||
      (S.ui.showPinNames !== 'never' && pitchPx > (layout.inside ? 18 : 22));
    const dim = part.side === S.ui.side ? 1 : 0.4;

    PB.parts.pinHoles(part, def).forEach(function (h, i) {
      const m = PB.board.holeToMM(h.c, h.r);
      const col = PB.parts.pinColor(h.pin.type);
      const r = p * 0.3;
      g.appendChild(sv('circle', {
        cx: m.x, cy: m.y, r: r, fill: col, opacity: 0.95 * dim,
        stroke: '#05070a', 'stroke-width': 0.1,
        'data-hit': 'pin', 'data-id': part.id, 'data-pin': h.pin.n
      }));
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: (S.doc.board.holeDia || 1) / 2 * 0.75,
        fill: '#0a0c10', opacity: 0.55 * dim, 'pointer-events': 'none' }));
      if (i === 0) {
        g.appendChild(sv('rect', {
          x: m.x - r * 1.5, y: m.y - r * 1.5, width: r * 3, height: r * 3, rx: 0.1,
          fill: 'none', stroke: col, 'stroke-width': 0.13, opacity: 0.85 * dim, 'pointer-events': 'none'
        }));
      }
      if (showNames || selected) {
        g.appendChild(pinLabel(part, def, h.pin, m, p, 0.95 * dim, layout));
      }
      void nets;
    });
    return g;
  }

  /**
   * Decide where a part's pin names go.
   *
   * They are written *on the module body*, silkscreen style, whenever the
   * longest of them fits there — that gives every name a solid backdrop
   * instead of leaving it lying across the bare board among the pads and
   * jumpers.  Parts with no room inside (pin headers, small DIPs, a bare
   * 2x4 socket) fall back to labelling outside, and it is decided for the
   * whole part at once so one footprint never mixes the two.
   */
  function labelLayout(def, p) {
    const rows = new Set(), cols = new Set();
    def.pins.forEach(function (pin) { rows.add(pin.r); cols.add(pin.c); });

    // pins spread across more columns than rows => laid out in rows
    const axis = cols.size >= rows.size ? 'row' : 'col';
    const midR = def.oy + def.h / 2;
    const midC = def.ox + def.w / 2;
    const font = p * 0.42;
    const gap = p * 0.5;

    let inside = def.pins.length > 0;
    for (const pin of def.pins) {
      const room = (axis === 'row' ? Math.abs(midR - pin.r) : Math.abs(midC - pin.c)) * p;
      const need = gap + String(pin.name).length * font * 0.62 + p * 0.12;
      if (need > room) { inside = false; break; }
    }
    return { axis: axis, inside: inside, midR: midR, midC: midC, font: font, gap: gap };
  }

  /**
   * One pin name, running away from (or into) the body along the pin row,
   * turned bottom-to-top on a horizontal header so that long names never
   * collide with their neighbours one pitch away.
   */
  function pinLabel(part, def, pin, m, p, opacity, layout) {
    const outward = layout.axis === 'row'
      ? (pin.r <= layout.midR ? -1 : 1)
      : (pin.c <= layout.midC ? -1 : 1);
    const dir = layout.inside ? -outward : outward;
    const o = layout.axis === 'row'
      ? PB.parts.offset(0, dir, part.rot, part.mirror)
      : PB.parts.offset(dir, 0, part.rot, part.mirror);

    const gap = layout.gap;
    const vertical = Math.abs(o.y) >= Math.abs(o.x);

    let x, y = m.y, anchor, rot;
    if (vertical) {
      rot = -90;                       // reads bottom-to-top
      if (o.y < 0) { x = m.x + gap; anchor = 'start'; }   // label runs up
      else { x = m.x - gap; anchor = 'end'; }             // label runs down
    } else {
      rot = 0;
      if (o.x > 0) { x = m.x + gap; anchor = 'start'; }
      else { x = m.x - gap; anchor = 'end'; }
    }

    /* In a flipped view the glyphs must be un-mirrored *before* the
       rotation, so the mirror correction goes last in the list. */
    const tf = [];
    if (rot) tf.push('rotate(' + rot + ' ' + U.round(m.x, 3) + ' ' + U.round(m.y, 3) + ')');
    if (S.ui.flipped) tf.push('translate(' + U.round(2 * m.x, 3) + ',0) scale(-1,1)');

    /* A halo keeps the name readable however far the see-through slider
       has faded the body underneath it. */
    const body = def.color || '#2b3a4a';
    const t = sv('text', {
      x: x, y: y,
      fill: layout.inside ? U.readableOn(body) : '#e8edf5',
      'font-size': layout.font,
      'font-family': 'ui-monospace, Consolas, monospace',
      'text-anchor': anchor, 'dominant-baseline': 'central',
      stroke: layout.inside ? body : '#0b0e12',
      'stroke-width': p * 0.12,
      'stroke-opacity': layout.inside ? 0.92 : 0.6,
      'stroke-linejoin': 'round', 'paint-order': 'stroke',
      opacity: opacity, 'pointer-events': 'none',
      transform: tf.length ? tf.join(' ') : null
    });
    t.textContent = pin.name;
    return t;
  }

  /* ------------------------------------------------------------------
     Overlay: cursor, previews, marquee, measurements
     ------------------------------------------------------------------ */
  function drawOverlay() {
    const g = U.clear(L.overlay);
    const m = overlayModel;
    if (!m) return;
    const bd = S.doc.board;
    const p = bd.pitch;

    /* snapped hole cursor */
    if (m.snap && PB.board.inside(m.snap.c, m.snap.r)) {
      const c = PB.board.holeToMM(m.snap.c, m.snap.r);
      g.appendChild(sv('circle', {
        cx: c.x, cy: c.y, r: p * 0.46, fill: 'none',
        stroke: m.snapColor || '#4da3ff', 'stroke-width': 0.22, opacity: 0.95
      }));
      g.appendChild(sv('circle', { cx: c.x, cy: c.y, r: p * 0.1, fill: m.snapColor || '#4da3ff' }));
    }

    /* hovered object outline */
    if (m.hoverRect) {
      g.appendChild(sv('rect', {
        x: m.hoverRect.x, y: m.hoverRect.y, width: m.hoverRect.w, height: m.hoverRect.h,
        rx: 0.5, fill: 'none', stroke: '#4da3ff', 'stroke-width': 0.2,
        'stroke-dasharray': '0.8 0.5', opacity: 0.9
      }));
    }

    /* wire preview */
    if (m.preview && m.preview.length > 1) {
      const d = PB.router.toPath(m.preview, m.previewMode === 'free' ? 0 : p * 0.34);
      g.appendChild(sv('path', {
        d: d, fill: 'none', stroke: '#05070a', 'stroke-width': (m.previewGauge || 0.5) + 0.42,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.35
      }));
      g.appendChild(sv('path', {
        d: d, fill: 'none', stroke: m.previewColor || '#e04b4b',
        'stroke-width': (m.previewGauge || 0.5) + 0.26,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.85,
        'stroke-dasharray': '1.6 0.9'
      }));
    }

    /* part ghost while placing / dragging */
    if (m.ghost) {
      const ghost = partNode(m.ghost, S.def(m.ghost.def), PB.view.pitchPx());
      ghost.setAttribute('opacity', m.ghostBad ? 0.4 : 0.65);
      ghost.setAttribute('pointer-events', 'none');
      if (m.ghostBad) ghost.setAttribute('filter', null);
      g.appendChild(ghost);
      if (m.ghostBad) {
        const b = PB.parts.fullBounds(m.ghost);
        const a = PB.board.holeToMM(b.x, b.y), z = PB.board.holeToMM(b.x + b.w, b.y + b.h);
        g.appendChild(sv('rect', {
          x: a.x, y: a.y, width: z.x - a.x, height: z.y - a.y, rx: 0.5,
          fill: 'none', stroke: '#ff5f56', 'stroke-width': 0.28
        }));
      }
    }

    /* marquee */
    if (m.marquee) {
      const a = m.marquee;
      g.appendChild(sv('rect', {
        x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2),
        width: Math.abs(a.x2 - a.x1), height: Math.abs(a.y2 - a.y1),
        fill: '#4da3ff', 'fill-opacity': 0.12, stroke: '#4da3ff', 'stroke-width': 0.2,
        'stroke-dasharray': '0.9 0.6'
      }));
    }

    /* measurement */
    if (m.measure) {
      const a = PB.board.holeToMM(m.measure.a.c, m.measure.a.r);
      const b = PB.board.holeToMM(m.measure.b.c, m.measure.b.r);
      g.appendChild(sv('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: '#ffe066', 'stroke-width': 0.2, 'stroke-dasharray': '1 0.6' }));
      [a, b].forEach(pt => g.appendChild(sv('circle', { cx: pt.x, cy: pt.y, r: 0.42, fill: '#ffe066' })));
      const dx = m.measure.b.c - m.measure.a.c, dy = m.measure.b.r - m.measure.a.r;
      const mm = Math.hypot(dx, dy) * p;
      const t = sv('text', {
        x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 1.2, fill: '#ffe066',
        'font-size': 2, 'font-family': 'ui-monospace, monospace', 'text-anchor': 'middle',
        transform: textTransform(0, (a.x + b.x) / 2, 0)
      });
      t.textContent = U.round(mm, 2) + ' mm · ' + Math.abs(dx) + '×' + Math.abs(dy) + ' holes';
      g.appendChild(t);
    }

    /* cut preview */
    if (m.cutPreview) {
      drawCut(g, m.cutPreview, bd);
    }
  }

  /* ------------------------------------------------------------------
     Hit testing (uses document.elementFromPoint on the stage)
     ------------------------------------------------------------------ */
  function hitTest(ev) {
    const els = document.elementsFromPoint(ev.clientX, ev.clientY);
    for (const e of els) {
      if (e === stage) break;
      let n = e;
      while (n && n !== stage) {
        if (n.getAttribute && n.getAttribute('data-hit')) {
          return { kind: n.getAttribute('data-hit'), id: n.getAttribute('data-id'), node: n,
            index: n.getAttribute('data-i'), pin: n.getAttribute('data-pin') };
        }
        n = n.parentNode;
      }
    }
    return null;
  }

  PB.render = {
    init, schedule, markOverlay, markContent, hitTest, draw, bodyArt,
    invalidateStatics: function () { staticSig = ''; dirty.statics = true; schedule(); },
    layers: L, partNode: partNode, wireNode: wireNode
  };
})();
