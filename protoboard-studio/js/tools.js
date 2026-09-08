/* ============================================================
   tools.js — pointer interaction for every tool
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const S = PB.state;

  const T = {
    hover: null,        // last hit-test result
    mm: { x: 0, y: 0 }, // cursor in mm
    snap: null,         // nearest hole {c,r}
    drag: null,         // active drag descriptor
    wire: null,         // in-progress wire {pts:[], flip:false}
    link: null,         // in-progress ratsnest link
    measure: null,
    spaceDown: false,
    lastPlaced: null
  };

  let stage;

  /* ------------------------------------------------------------------ */
  function init(stageEl) {
    stage = stageEl;
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dblclick', onDblClick);
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    PB.bus.on('ui', function () { updateCursor(); refreshOverlay(); });
  }

  /* ------------------------------------------------------------------
     Helpers
     ------------------------------------------------------------------ */
  function snapAt(ev) {
    const mm = PB.view.eventToMM(ev);
    T.mm = mm;
    const n = PB.board.nearestHole(mm.x, mm.y);
    T.snap = n;
    return n;
  }

  /** Free (unsnapped) hole-space position, used by Alt-drag. */
  function freeHole() {
    const h = PB.board.mmToHole(T.mm.x, T.mm.y);
    return { c: U.round(h.c, 2), r: U.round(h.r, 2) };
  }

  function activeSideOf(kind, id) {
    if (kind === 'part' || kind === 'pin' || kind === 'pins') {
      const p = S.find('part', id); return p ? p.side : null;
    }
    if (kind === 'wire' || kind === 'wirept') { const w = S.find('wire', id); return w ? w.side : null; }
    if (kind === 'text') { const t = S.find('text', id); return t ? t.side : null; }
    return null;
  }

  /** Hit test that ignores objects on the side you are not working on. */
  function hit(ev, opts) {
    opts = opts || {};
    const els = document.elementsFromPoint(ev.clientX, ev.clientY);
    for (const e of els) {
      let n = e;
      while (n && n !== stage) {
        const k = n.getAttribute && n.getAttribute('data-hit');
        if (k) {
          const id = n.getAttribute('data-id');
          const side = activeSideOf(k, id);
          if (side && side !== S.ui.side && !opts.anySide) { n = n.parentNode; continue; }
          return { kind: k, id: id, node: n, index: n.getAttribute('data-i'), pin: n.getAttribute('data-pin') };
        }
        n = n.parentNode;
      }
    }
    return null;
  }

  function isPanGesture(ev) {
    return ev.button === 1 || T.spaceDown || S.ui.tool === 'pan' ||
      (ev.button === 0 && ev.altKey && ev.shiftKey);
  }

  function selKindOf(k) {
    if (k === 'pin' || k === 'pins') return 'part';
    if (k === 'wirept') return 'wire';
    return k;
  }

  /* ------------------------------------------------------------------
     Pointer down
     ------------------------------------------------------------------ */
  function onDown(ev) {
    stage.setPointerCapture && stage.setPointerCapture(ev.pointerId);
    snapAt(ev);
    const tool = S.ui.tool;

    if (isPanGesture(ev)) {
      T.drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, tx: PB.view.tx, ty: PB.view.ty };
      stage.classList.add('c-panning');
      ev.preventDefault();
      return;
    }
    if (ev.button === 2) { rightClick(ev); return; }
    if (ev.button !== 0) return;

    switch (tool) {
      case 'select': return downSelect(ev);
      case 'place':  return downPlace(ev);
      case 'wire':   return downWire(ev);
      case 'link':   return downLink(ev);
      case 'cut':    return downCut(ev);
      case 'holes':  return downHoles(ev);
      case 'text':   return downText(ev);
      case 'measure':return downMeasure(ev);
      case 'erase':  return downErase(ev);
    }
  }

  /* ---------------- select ---------------- */
  function downSelect(ev) {
    const h = hit(ev);
    if (!h) {
      if (!ev.shiftKey) S.selectNone();
      T.drag = { type: 'marquee', a: PB.board.mmToHole(T.mm.x, T.mm.y), b: PB.board.mmToHole(T.mm.x, T.mm.y),
        add: ev.shiftKey };
      refreshOverlay();
      return;
    }

    if (h.kind === 'wirept') {
      const w = S.find('wire', h.id);
      if (w) {
        S.begin('Move wire point');
        T.drag = { type: 'wirept', wire: w, index: +h.index, alt: ev.altKey };
      }
      return;
    }

    const kind = selKindOf(h.kind);
    const key = kind + ':' + h.id;
    if (ev.shiftKey) {
      S.selectToggle(kind, h.id);
      if (!S.sel.has(key)) return;
    } else if (!S.sel.has(key)) {
      S.selectOnly([{ kind: kind, id: h.id }]);
    }

    // begin move of everything selected
    const objs = S.selObjects().filter(o => !o.obj.locked);
    if (!objs.length) return;
    S.begin('Move');
    T.drag = {
      type: 'move',
      start: { c: T.snap.c, r: T.snap.r },
      origin: U.deepClone(objs.map(o => ({ kind: o.kind, id: o.id, snapshot: U.deepClone(o.obj) }))),
      attached: collectAttachedWireEnds(objs),
      moved: false
    };
  }

  /** Wire endpoints sitting in the pins of the parts being moved. */
  function collectAttachedWireEnds(objs) {
    if (!S.ui.rubberBand && S.ui.rubberBand !== undefined) return [];
    const holes = new Set();
    objs.forEach(function (o) {
      if (o.kind !== 'part') return;
      const def = S.def(o.obj.def);
      if (!def) return;
      PB.parts.pinHoles(o.obj, def).forEach(h => holes.add(h.c + ',' + h.r));
    });
    if (!holes.size) return [];
    const movingWires = new Set(objs.filter(o => o.kind === 'wire').map(o => o.id));
    const out = [];
    S.doc.wires.forEach(function (w) {
      if (movingWires.has(w.id) || w.locked) return;
      const last = w.pts.length - 1;
      [0, last].forEach(function (i) {
        const p = w.pts[i];
        if (holes.has(p.c + ',' + p.r)) out.push({ wire: w, index: i, from: { c: p.c, r: p.r } });
      });
    });
    return out;
  }

  /* ---------------- place ---------------- */
  function downPlace(ev) {
    const defId = S.ui.placingDef;
    if (!defId) { PB.ui.toast('Pick a part in the Library panel first', 'warn'); return; }
    const def = PB.parts.get(defId);
    if (!def) return;
    const ghost = ghostPart();
    if (!ghost) return;
    S.edit('Place ' + def.name, function () {
      S.embedDef(defId);
      const p = PB.make.part(defId, ghost.col, ghost.row, {
        rot: S.ui.placeRot, side: S.ui.side, mirror: !!S.ui.placeMirror
      });
      S.doc.parts.push(p);
      T.lastPlaced = p.id;
      S.selectOnly([{ kind: 'part', id: p.id }]);
    });
    if (!ev.shiftKey && S.ui.placeOnce) setTool('select');
    refreshOverlay();
  }

  function ghostPart() {
    if (!S.ui.placingDef || !T.snap) return null;
    return {
      id: '_ghost', def: S.ui.placingDef, ref: '?', value: '',
      col: T.snap.c, row: T.snap.r, rot: S.ui.placeRot,
      mirror: !!S.ui.placeMirror, side: S.ui.side
    };
  }

  /* ---------------- wire ---------------- */
  function downWire(ev) {
    const n = T.snap;
    if (!n || !n.inside) return;
    if (!n.usable) {
      PB.ui.toast(n.mount ? 'That hole is taken by a mounting hole'
        : 'This board has no hole there', 'warn');
      return;
    }
    if (!T.wire) {
      T.wire = { pts: [{ c: n.c, r: n.r }], flip: false };
      refreshOverlay();
      return;
    }
    if (ev.shiftKey) {                       // add a manual bend and keep going
      T.wire.pts.push({ c: n.c, r: n.r });
      refreshOverlay();
      return;
    }
    const start = T.wire.pts[0];
    if (start.c === n.c && start.r === n.r && T.wire.pts.length === 1) { T.wire = null; refreshOverlay(); return; }
    const pts = previewWirePts({ c: n.c, r: n.r });
    if (!pts || pts.length < 2) { T.wire = null; refreshOverlay(); return; }
    S.edit('Draw wire', function () {
      const w = PB.make.wire(pts);
      S.doc.wires.push(w);
      consumeRat(pts[0], pts[pts.length - 1]);
      S.selectOnly([{ kind: 'wire', id: w.id }]);
    });
    T.wire = null;
    refreshOverlay();
  }

  /* The A* preview is recomputed only when the target hole actually
     changes, so dragging across the board stays smooth on big layouts. */
  let autoCache = { key: null, pts: null };

  /** Full point list for the wire currently being drawn, ending at `end`. */
  function previewWirePts(end) {
    if (!T.wire) return null;
    const way = T.wire.pts.slice();
    const mode = S.ui.wireMode;
    if (!end) return way.length > 1 ? PB.router.chain(way, mode, T.wire.flip) : null;
    if (S.ui.wireAuto && mode !== 'free') {
      const from = way[way.length - 1];
      const key = [from.c, from.r, end.c, end.r, mode, S.ui.side, S.doc.wires.length, S.doc.parts.length].join('|');
      if (autoCache.key !== key) {
        autoCache = { key: key, pts: PB.router.autoroute(from, end, { mode: mode, side: S.ui.side }) };
      }
      if (autoCache.pts && autoCache.pts.length > 1) {
        return PB.router.simplify(way.slice(0, -1).concat(autoCache.pts));
      }
    }
    return PB.router.chain(way.concat([end]), mode, T.wire.flip);
  }

  /** Drop any ratsnest link that this new wire has just satisfied. */
  function consumeRat(a, b) {
    const nk = function (p) { return p.c + ',' + p.r; };
    const A = nk(a), B = nk(b);
    S.doc.rats = S.doc.rats.filter(function (rt) {
      const ra = ratHole(rt.a), rb = ratHole(rt.b);
      if (!ra || !rb) return true;
      const x = nk(ra), y = nk(rb);
      return !((x === A && y === B) || (x === B && y === A));
    });
  }

  function ratHole(e) {
    if (!e) return null;
    if (e.part) {
      const part = S.find('part', e.part);
      if (!part) return null;
      const def = S.def(part.def);
      const pin = def && def.pins.find(p => p.n === e.pin);
      return pin ? PB.parts.pinHole(part, pin) : null;
    }
    return { c: e.c, r: e.r };
  }

  /* ---------------- ratsnest link ---------------- */
  function downLink(ev) {
    const n = T.snap;
    if (!n || !n.inside) return;
    if (!n.usable) {
      PB.ui.toast(n.mount ? 'That hole is taken by a mounting hole'
        : 'This board has no hole there', 'warn');
      return;
    }
    const h = hit(ev);
    let end;
    if (h && h.kind === 'pin') end = { part: h.id, pin: h.pin };
    else end = { c: n.c, r: n.r };

    if (!T.link) { T.link = { a: end, at: { c: n.c, r: n.r } }; refreshOverlay(); return; }
    const a = ratHole(T.link.a), b = ratHole(end);
    if (a && b && (a.c !== b.c || a.r !== b.r)) {
      S.edit('Add ratsnest link', function () {
        S.doc.rats.push(PB.make.rat(T.link.a, end, { net: S.ui.linkNet || null }));
      });
    }
    T.link = null;
    refreshOverlay();
  }

  /* ---------------- cut ---------------- */
  function downCut(ev) {
    if (!PB.board.cutAllowed()) { PB.ui.toast('This board type has no copper strips to cut', 'warn'); return; }
    const c = cutUnderCursor(ev);
    if (!c) return;
    S.edit(c.exists ? 'Remove cut' : 'Add track cut', function () {
      if (c.exists) S.remove('cut', c.exists.id);
      else S.doc.cuts.push(PB.make.cut(c.col, c.row, c.axis, c.style));
    });
    PB.render.invalidateStatics();
  }

  function cutUnderCursor(ev) {
    const bd = S.doc.board;
    const axis = ev && ev.shiftKey
      ? (PB.board.defaultCutAxis() === 'row' ? 'col' : 'row')
      : PB.board.defaultCutAxis();
    const style = ev && ev.altKey ? 'drill' : 'knife';
    const h = PB.board.mmToHole(T.mm.x, T.mm.y);
    let col, row;
    if (style === 'drill') {
      col = Math.round(h.c); row = Math.round(h.r);
    } else if (axis === 'row') {
      col = Math.floor(h.c); row = Math.round(h.r);
    } else {
      col = Math.round(h.c); row = Math.floor(h.r);
    }
    if (!PB.board.inside(col, row)) return null;
    if (style === 'knife') {
      const n = axis === 'row' ? { c: col + 1, r: row } : { c: col, r: row + 1 };
      if (!PB.board.inside(n.c, n.r)) return null;
    }
    const exists = S.doc.cuts.find(x => x.col === col && x.row === row && x.axis === axis && x.style === style);
    void bd;
    return { col: col, row: row, axis: axis, style: style, exists: exists };
  }

  /* ---------------- holes ----------------
     Some real boards have no through-holes in places: the un-drilled
     gutter of a breadboard-style board, a cut-out, a snapped corner.
     Clicking removes a hole, clicking it again brings it back, and you
     can drag to paint a whole run in one gesture. */
  function downHoles(ev) {
    const n = T.snap;
    if (!n || !n.inside) return;
    if (n.mount) { PB.ui.toast('That hole is taken by a mounting hole', 'warn'); return; }
    const removing = !PB.board.isVoid(n.c, n.r);
    S.begin(removing ? 'Remove holes' : 'Restore holes');
    T.drag = { type: 'holes', removing: removing, touched: new Set(), changed: false };
    paintHole(n.c, n.r);
    refreshOverlay();
    void ev;
  }

  function paintHole(c, r) {
    const d = T.drag;
    if (!d || d.type !== 'holes') return;
    const key = c + ',' + r;
    if (d.touched.has(key)) return;
    d.touched.add(key);
    if (!PB.board.inside(c, r)) return;
    if (PB.board.isBlocked(c, r)) return;          // mounting holes are not ours to give back
    const bd = S.doc.board;
    const set = new Set(bd.voids || []);
    const before = set.size;
    if (d.removing) set.add(key); else set.delete(key);
    if (set.size === before) return;
    bd.voids = Array.from(set).sort(holeKeyOrder);
    d.changed = true;
    PB.board.invalidate();
    PB.render.invalidateStatics();
  }

  function holeKeyOrder(a, b) {
    const A = String(a).split(','), B = String(b).split(',');
    return (+A[1] - +B[1]) || (+A[0] - +B[0]);
  }

  /* ---------------- text ---------------- */
  function downText(ev) {
    const n = T.snap;
    if (!n) return;
    PB.ui.prompt('Annotation text', '', function (str) {
      if (!str) return;
      S.edit('Add text', function () {
        const t = PB.make.text(n.c, n.r, str);
        S.doc.texts.push(t);
        S.selectOnly([{ kind: 'text', id: t.id }]);
      });
    });
    void ev;
  }

  /* ---------------- measure ---------------- */
  function downMeasure(ev) {
    const n = T.snap;
    if (!n) return;
    T.measure = { a: { c: n.c, r: n.r }, b: { c: n.c, r: n.r } };
    T.drag = { type: 'measure' };
    refreshOverlay();
    void ev;
  }

  /* ---------------- erase ---------------- */
  function downErase(ev) {
    const h = hit(ev);
    if (h) {
      const kind = selKindOf(h.kind);
      if (['part', 'wire', 'text', 'rat'].indexOf(kind) >= 0) {
        S.edit('Delete', function () { S.remove(kind, h.id); });
        return;
      }
    }
    const c = cutUnderCursor(ev);
    if (c && c.exists) S.edit('Remove cut', function () { S.remove('cut', c.exists.id); });
  }

  /* ------------------------------------------------------------------
     Pointer move
     ------------------------------------------------------------------ */
  function onMove(ev) {
    snapAt(ev);
    const d = T.drag;

    if (d) {
      switch (d.type) {
        case 'pan': {
          PB.view.tx = d.tx + (ev.clientX - d.sx);
          PB.view.ty = d.ty + (ev.clientY - d.sy);
          PB.bus.emit('view');
          break;
        }
        case 'marquee': {
          d.b = PB.board.mmToHole(T.mm.x, T.mm.y);
          break;
        }
        case 'move': {
          const dc = T.snap.c - d.start.c, dr = T.snap.r - d.start.r;
          if (dc || dr) d.moved = true;
          applyMove(d, dc, dr, ev);
          PB.render.markContent();
          break;
        }
        case 'wirept': {
          const w = d.wire;
          const isEnd = d.index === 0 || d.index === w.pts.length - 1;
          const p = (ev.altKey && !isEnd) ? freeHole() : { c: T.snap.c, r: T.snap.r };
          w.pts[d.index] = p;
          PB.render.markContent();
          break;
        }
        case 'measure': {
          T.measure.b = { c: T.snap.c, r: T.snap.r };
          break;
        }
        case 'holes': {
          if (T.snap && T.snap.inside) paintHole(T.snap.c, T.snap.r);
          break;
        }
      }
    } else {
      T.hover = hit(ev);
    }

    refreshOverlay();
    PB.ui.updateStatus();
  }

  function applyMove(d, dc, dr, ev) {
    d.origin.forEach(function (o) {
      const obj = S.find(o.kind, o.id);
      if (!obj) return;
      const snap = o.snapshot;
      if (o.kind === 'part') { obj.col = snap.col + dc; obj.row = snap.row + dr; }
      else if (o.kind === 'text') { obj.col = snap.col + dc; obj.row = snap.row + dr; }
      else if (o.kind === 'wire') {
        obj.pts = snap.pts.map(p => ({ c: p.c + dc, r: p.r + dr }));
      }
    });
    if (!ev || !ev.ctrlKey) {
      d.attached.forEach(function (a) {
        a.wire.pts[a.index] = { c: a.from.c + dc, r: a.from.r + dr };
        if (a.wire.mode !== 'free' && a.wire.pts.length > 2) {
          a.wire.pts = PB.router.elbow(a.wire.pts[0], a.wire.pts[a.wire.pts.length - 1], a.wire.mode, false);
        }
      });
    }
  }

  /* ------------------------------------------------------------------
     Pointer up
     ------------------------------------------------------------------ */
  function onUp(ev) {
    const d = T.drag;
    stage.classList.remove('c-panning');
    if (!d) return;
    T.drag = null;

    if (d.type === 'marquee') {
      finishMarquee(d);
    } else if (d.type === 'move') {
      if (d.moved) { S.commit(); PB.bus.emit('doc'); }
      else S.abort();
    } else if (d.type === 'wirept') {
      S.commit(); PB.bus.emit('doc');
    } else if (d.type === 'holes') {
      if (d.changed) { S.commit(); PB.bus.emit('doc'); } else S.abort();
    } else if (d.type === 'measure') {
      // keep the measurement on screen until the next click
    }
    refreshOverlay();
    void ev;
  }

  function finishMarquee(d) {
    const x1 = Math.min(d.a.c, d.b.c), x2 = Math.max(d.a.c, d.b.c);
    const y1 = Math.min(d.a.r, d.b.r), y2 = Math.max(d.a.r, d.b.r);
    if (Math.abs(x2 - x1) < 0.15 && Math.abs(y2 - y1) < 0.15) return;
    const box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    const found = [];
    S.doc.parts.forEach(function (p) {
      if (p.side !== S.ui.side) return;
      const b = PB.parts.fullBounds(p);
      if (U.rectsOverlap(box, b)) found.push({ kind: 'part', id: p.id });
    });
    S.doc.wires.forEach(function (w) {
      if (w.side !== S.ui.side) return;
      if (w.pts.some(p => U.pointInRect(p.c, p.r, box))) found.push({ kind: 'wire', id: w.id });
    });
    S.doc.texts.forEach(function (t) {
      if (t.side !== S.ui.side) return;
      if (U.pointInRect(t.col, t.row, box)) found.push({ kind: 'text', id: t.id });
    });
    if (d.add) found.forEach(f => S.sel.add(f.kind + ':' + f.id));
    else S.selectOnly(found);
    PB.bus.emit('sel');
  }

  /* ------------------------------------------------------------------
     Wheel / dblclick / right click
     ------------------------------------------------------------------ */
  function onWheel(ev) {
    ev.preventDefault();
    const p = PB.view.clientToStage(ev);
    if (ev.ctrlKey || ev.metaKey || !ev.shiftKey) {
      const f = Math.pow(1.0016, -ev.deltaY);
      PB.view.zoomAt(p.x, p.y, f);
    } else {
      PB.view.panBy(-ev.deltaX, -ev.deltaY);
    }
  }

  function onDblClick(ev) {
    const h = hit(ev);
    if (!h) return;
    if (h.kind === 'wire' || h.kind === 'wirept') {
      const w = S.find('wire', h.id);
      if (!w) return;
      // insert a waypoint at the clicked position
      const mmPts = w.pts.map(p => PB.board.holeToMM(p.c, p.r));
      const near = U.polyDist(T.mm.x, T.mm.y, mmPts);
      if (near.index >= 0) {
        S.edit('Add wire point', function () {
          w.pts.splice(near.index + 1, 0, { c: T.snap.c, r: T.snap.r });
          w.pts = PB.router.simplify(w.pts);
        });
      }
      return;
    }
    if (h.kind === 'part' || h.kind === 'pin' || h.kind === 'pins') {
      S.selectOnly([{ kind: 'part', id: h.id }]);
      PB.ui.showTab('props');
    }
    if (h.kind === 'text') {
      const t = S.find('text', h.id);
      if (t) PB.ui.prompt('Edit text', t.text, function (v) {
        if (v !== null) S.edit('Edit text', function () { t.text = v; });
      });
    }
  }

  function rightClick(ev) {
    if (T.wire) { T.wire = null; refreshOverlay(); return; }
    if (T.link) { T.link = null; refreshOverlay(); return; }
    const h = hit(ev);
    if (h) PB.ui.contextMenu(ev, h);
    else PB.ui.contextMenu(ev, null);
  }

  /* ------------------------------------------------------------------
     Keyboard hooks used by main.js
     ------------------------------------------------------------------ */
  function onKey(ev) {
    const k = ev.key;
    if (k === 'Escape') {
      if (T.wire) { T.wire = null; refreshOverlay(); return true; }
      if (T.link) { T.link = null; refreshOverlay(); return true; }
      if (T.measure) { T.measure = null; refreshOverlay(); return true; }
      if (S.ui.tool === 'place') { PB.ui.finishPlacing(); return true; }
      if (T.drag) { S.abort(); T.drag = null; refreshOverlay(); return true; }
      if (S.sel.size) { S.selectNone(); return true; }
      return false;
    }
    if (k === 'Tab' && (T.wire || S.ui.tool === 'wire')) {
      if (T.wire) { T.wire.flip = !T.wire.flip; refreshOverlay(); return true; }
    }
    if ((k === 'Backspace') && T.wire && T.wire.pts.length > 1) {
      T.wire.pts.pop(); refreshOverlay(); return true;
    }
    if (k === ' ' && !T.spaceDown) { T.spaceDown = true; updateCursor(); return true; }
    if ((k === 'r' || k === 'R') && S.ui.tool === 'place') {
      S.setUI({ placeRot: ((S.ui.placeRot || 0) + (ev.shiftKey ? 270 : 90)) % 360 });
      refreshOverlay(); return true;
    }
    if ((k === 'm' || k === 'M') && S.ui.tool === 'place') {
      S.setUI({ placeMirror: !S.ui.placeMirror }); refreshOverlay(); return true;
    }
    return false;
  }

  function onKeyUp(ev) {
    if (ev.key === ' ') { T.spaceDown = false; updateCursor(); }
  }

  /* ------------------------------------------------------------------
     Overlay model
     ------------------------------------------------------------------ */
  function refreshOverlay() {
    const m = {};
    const tool = S.ui.tool;

    if (['wire', 'link', 'cut', 'holes', 'measure', 'place'].indexOf(tool) >= 0 ||
        (T.drag && T.drag.type === 'wirept')) {
      m.snap = T.snap && T.snap.inside ? T.snap : null;
      m.snapColor = (m.snap && m.snap.mount) ? '#ff5f56'
        : tool === 'holes' ? (m.snap && m.snap.missing ? '#47c98a' : '#ff5f56')
        : tool === 'cut' ? '#ff5f56'
        : tool === 'wire' ? S.ui.wireColor : '#4da3ff';
    }

    if (T.wire) {
      const end = T.snap && T.snap.usable ? { c: T.snap.c, r: T.snap.r } : null;
      m.preview = previewWirePts(end);
      m.previewMode = S.ui.wireMode;
      m.previewColor = S.ui.wireColor;
      m.previewGauge = S.ui.wireGauge;
    }

    if (T.link && T.snap) {
      const a = ratHole(T.link.a);
      if (a) { m.preview = [a, { c: T.snap.c, r: T.snap.r }]; m.previewMode = 'free'; m.previewColor = '#8fb8ff'; }
    }

    if (tool === 'place' && S.ui.placingDef && T.snap && T.snap.inside) {
      m.ghost = ghostPart();
      m.ghostBad = m.ghost ? !placementOK(m.ghost) : false;
    }

    if (T.drag && T.drag.type === 'marquee') {
      const a = PB.board.holeToMM(T.drag.a.c, T.drag.a.r);
      const b = PB.board.holeToMM(T.drag.b.c, T.drag.b.r);
      m.marquee = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }

    if (T.measure) m.measure = T.measure;

    if (tool === 'cut' && T.snap && !T.drag) {
      const c = cutUnderCursor({ shiftKey: false, altKey: false });
      if (c && !c.exists) m.cutPreview = { col: c.col, row: c.row, axis: c.axis, style: c.style };
    }

    if (T.hover && !T.drag && tool === 'select') {
      const kind = selKindOf(T.hover.kind);
      if (kind === 'part') {
        const p = S.find('part', T.hover.id);
        if (p && !S.sel.has('part:' + p.id)) {
          const b = PB.parts.fullBounds(p);
          const a = PB.board.holeToMM(b.x, b.y), z = PB.board.holeToMM(b.x + b.w, b.y + b.h);
          m.hoverRect = { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y };
        }
      }
    }

    PB.render.markOverlay(m);
  }

  function placementOK(ghost) {
    const def = S.def(ghost.def) || PB.parts.get(ghost.def);
    if (!def) return false;
    const holes = PB.parts.pinHoles(ghost, def);
    if (holes.some(h => !PB.board.inside(h.c, h.r))) return false;
    if (holes.some(h => PB.board.noHole(h.c, h.r))) return false;   // mounting hole, or no hole at all
    const occ = PB.nets.occupancy();
    return !holes.some(h => (occ.get(h.c + ',' + h.r) || []).length > 0);
  }

  /* ------------------------------------------------------------------ */
  function updateCursor() {
    if (!stage) return;
    stage.classList.remove('c-pan', 'c-cross', 'c-move', 'c-erase');
    if (T.spaceDown || S.ui.tool === 'pan') stage.classList.add('c-pan');
    else if (['wire', 'link', 'cut', 'holes', 'text', 'measure', 'place'].indexOf(S.ui.tool) >= 0) stage.classList.add('c-cross');
    else if (S.ui.tool === 'erase') stage.classList.add('c-erase');
  }

  function setTool(name) {
    if (S.ui.tool === name) return;
    T.wire = null; T.link = null;
    if (name !== 'measure') T.measure = null;
    S.setUI({ tool: name });
    updateCursor();
    refreshOverlay();
  }

  PB.tools = { init, onKey, onKeyUp, setTool, refreshOverlay, state: T, hit, placementOK, ratHole };
})();
