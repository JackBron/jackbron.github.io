/* ============================================================
   ui.js — panels, menus, dialogs, status bar, commands
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const S = PB.state;
  const el = U.el;

  const WIRE_COLORS = ['#e04b4b', '#111417', '#e8edf5', '#e08a2f', '#f2d13c',
    '#47c98a', '#4d7fe0', '#a35bd6', '#7a5230', '#5b6472'];

  let activeTab = 'library';
  let libFilter = '';

  /* ==================================================================
     Toasts
     ================================================================== */
  function toast(msg, kind, ms) {
    const stack = U.$('#toast-stack');
    const t = el('div.toast' + (kind ? '.' + kind : ''), { text: msg });
    stack.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(() => t.remove(), 260);
    }, ms || 2600);
  }

  /* ==================================================================
     Modal plumbing
     ================================================================== */
  let modalStack = [];

  function modal(opts) {
    const root = U.$('#modal-root');
    root.hidden = false;
    const box = el('div.modal' + (opts.resizable ? '.resizable' : ''), {
      style: opts.width ? (opts.resizable ? { width: opts.width } : { minWidth: opts.width }) : null
    });
    const head = el('div.modal-head', null, [
      el('h3', { text: opts.title || '' }),
      opts.sub ? el('span.sub', { text: opts.sub }) : null,
      el('button.modal-x', { html: '&times;', title: 'Close (Esc)', onclick: close })
    ]);
    const body = el('div.modal-body');
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    const foot = el('div.modal-foot');
    (opts.buttons || [{ label: 'Close', primary: true }]).forEach(function (b) {
      foot.appendChild(el('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), {
        text: b.label,
        onclick: function () {
          if (!b.onClick || b.onClick(body) !== false) close();
        }
      }));
    });
    box.appendChild(head); box.appendChild(body);
    if (opts.buttons !== null) box.appendChild(foot);
    root.appendChild(box);
    modalStack.push(box);
    if (opts.onOpen) opts.onOpen(body, box);

    function close() {
      const i = modalStack.indexOf(box);
      if (i >= 0) modalStack.splice(i, 1);
      box.remove();
      if (!modalStack.length) root.hidden = true;
      if (opts.onClose) opts.onClose();
    }
    box._close = close;
    return { close: close, body: body, box: box };
  }

  function closeTopModal() {
    const m = modalStack[modalStack.length - 1];
    if (m && m._close) { m._close(); return true; }
    return false;
  }

  function prompt(title, value, cb) {
    let input;
    const body = el('div', null, [
      input = el('input', { type: 'text', value: value === undefined ? '' : value, style: { width: '100%' } })
    ]);
    const m = modal({
      title: title, body: body, width: '380px',
      buttons: [
        { label: 'Cancel' },
        { label: 'OK', primary: true, onClick: function () { cb(input.value); } }
      ]
    });
    setTimeout(function () { input.focus(); input.select(); }, 20);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { cb(input.value); m.close(); }
      e.stopPropagation();
    });
  }

  function confirm(title, message, cb, danger) {
    modal({
      title: title, body: el('p', { text: message, style: { margin: 0, lineHeight: '1.6' } }), width: '400px',
      buttons: [{ label: 'Cancel' }, { label: 'OK', primary: !danger, danger: danger, onClick: function () { cb(); } }]
    });
  }

  /* ==================================================================
     Commands
     ================================================================== */
  const CMD = {
    'file.new': function () {
      confirm('New project', 'Discard the current board and start a new one?', function () {
        PB.io.newProject();
      });
    },
    'file.open': function () { PB.io.openProject(); },
    'file.save': function () { PB.io.saveProject(); },
    'file.importParts': function () { PB.io.importParts(); },
    'file.exportParts': function () { PB.io.exportParts(); },
    'export.svg': function () { PB.io.exportSVG(); },
    'export.png': function () { PB.io.exportPNG(); },
    'export.netlist': function () { PB.io.exportNetlist(); },
    'export.bom': function () { PB.io.exportBOM(); },
    'export.wirelist': function () { PB.io.exportWireList(); },
    'export.buildsheet': function () { PB.io.buildSheet(); },

    'edit.undo': function () { const l = S.undo(); toast(l ? 'Undo: ' + l : 'Nothing to undo', l ? '' : 'warn'); },
    'edit.redo': function () { const l = S.redo(); toast(l ? 'Redo: ' + l : 'Nothing to redo', l ? '' : 'warn'); },
    'edit.copy': function () { copySel(); },
    'edit.paste': function () { pasteSel(); },
    'edit.duplicate': function () { duplicate(); },
    'edit.delete': function () { deleteSel(); },
    'edit.selectAll': function () {
      const all = [];
      S.doc.parts.filter(p => p.side === S.ui.side).forEach(p => all.push({ kind: 'part', id: p.id }));
      S.doc.wires.filter(w => w.side === S.ui.side).forEach(w => all.push({ kind: 'wire', id: w.id }));
      S.doc.texts.filter(t => t.side === S.ui.side).forEach(t => all.push({ kind: 'text', id: t.id }));
      S.selectOnly(all);
    },
    'edit.selectNone': function () { S.selectNone(); },
    'edit.rotate': function () { rotateSel(90); },
    'edit.mirror': function () { mirrorSel(); },
    'edit.flipSide': function () { flipSideSel(); },

    'view.fit': function () { PB.view.fit(); },
    'view.zoomIn': function () { PB.view.zoomBy(1.25); },
    'view.zoomOut': function () { PB.view.zoomBy(0.8); },
    'view.side.front': function () { setSide('front'); },
    'view.side.back': function () { setSide('back'); },
    'view.flipBoard': function () {
      S.setUI({ flipped: !S.ui.flipped });
      PB.render.schedule();
      PB.view.drawRulers();
      toast(S.ui.flipped ? 'Viewing from the BACK (mirrored)' : 'Viewing from the FRONT');
    },
    'view.toggleLabels': function () { S.setUI({ showLabels: !S.ui.showLabels }); },
    'view.toggleRulers': function () {
      S.setUI({ showRulers: !S.ui.showRulers });
      U.$('#canvas-wrap').classList.toggle('no-rulers', !S.ui.showRulers);
      PB.view.resize(); PB.view.drawRulers();
    },
    'view.toggleRats': function () { S.setUI({ showRats: !S.ui.showRats }); },
    'view.toggleHoleNums': function () { S.setUI({ showHoleNums: !S.ui.showHoleNums }); },

    'tools.partDesigner': function () { PB.partDesigner.open(null); },
    'tools.boardSetup': function () { showTab('board'); },
    'tools.drc': function () { const n = PB.nets.drc(); showTab('checks'); toast(n.length + ' check result' + (n.length === 1 ? '' : 's')); },
    'tools.autoroute': function () { autorouteRats(); },
    'tools.tidyWires': function () { tidyWires(); },
    'tools.resetLibrary': function () {
      confirm('Reset library', 'Delete every custom part you have created or imported? Built-in parts are unaffected.',
        function () { PB.parts.resetUser(); toast('Custom parts cleared', 'good'); }, true);
    },

    'help.shortcuts': function () { shortcutsDialog(); },
    'help.about': function () { aboutDialog(); },
    'help.example': function () {
      confirm('Load example', 'Replace the current board with the worked example?', function () {
        S.load(PB.exampleProject());
        PB.render.invalidateStatics();
        PB.view.fit();
        refreshTab();
        toast('Example project loaded', 'good');
      });
    }
  };

  function run(cmd) {
    const fn = CMD[cmd];
    if (fn) fn();
    else console.warn('unknown command', cmd);
  }

  /* ==================================================================
     Selection operations
     ================================================================== */
  function deleteSel() {
    const objs = S.selection();
    if (!objs.length) return;
    S.edit('Delete ' + objs.length + ' item' + (objs.length > 1 ? 's' : ''), function () {
      objs.forEach(o => S.remove(o.kind, o.id));
      S.sel.clear();
    });
    PB.render.invalidateStatics();
  }

  function rotateSel(deg) {
    const objs = S.selObjects();
    if (!objs.length) { if (S.ui.tool === 'place') S.setUI({ placeRot: ((S.ui.placeRot || 0) + deg) % 360 }); return; }
    S.edit('Rotate', function () {
      objs.forEach(function (o) {
        if (o.kind === 'part') o.obj.rot = (((o.obj.rot || 0) + deg) % 360 + 360) % 360;
        else if (o.kind === 'text') o.obj.rot = (((o.obj.rot || 0) + deg) % 360 + 360) % 360;
        else if (o.kind === 'wire') {
          // rotate the polyline about its first point
          const a = o.obj.pts[0];
          o.obj.pts = o.obj.pts.map(function (p) {
            const r = U.rot90(p.c - a.c, p.r - a.r, deg);
            return { c: a.c + r.x, r: a.r + r.y };
          });
        }
      });
    });
  }

  function mirrorSel() {
    const objs = S.selObjects();
    if (!objs.length) { if (S.ui.tool === 'place') S.setUI({ placeMirror: !S.ui.placeMirror }); return; }
    S.edit('Mirror', function () {
      objs.forEach(function (o) {
        if (o.kind === 'part') o.obj.mirror = !o.obj.mirror;
        else if (o.kind === 'wire') {
          const a = o.obj.pts[0];
          o.obj.pts = o.obj.pts.map(p => ({ c: a.c - (p.c - a.c), r: p.r }));
        }
      });
    });
  }

  function flipSideSel() {
    const objs = S.selObjects();
    if (!objs.length) return;
    S.edit('Flip side', function () {
      objs.forEach(function (o) {
        if (o.obj.side) o.obj.side = o.obj.side === 'front' ? 'back' : 'front';
      });
    });
    toast('Moved ' + objs.length + ' item(s) to the other side');
  }

  function copySel(silent) {
    const objs = S.selObjects();
    if (!objs.length) return;
    S.clipboard = {
      items: objs.map(o => ({ kind: o.kind, obj: U.deepClone(o.obj) })),
      defs: {}
    };
    objs.forEach(function (o) {
      if (o.kind === 'part') {
        const d = S.def(o.obj.def);
        if (d) S.clipboard.defs[o.obj.def] = U.deepClone(d);
      }
    });
    if (!silent) toast('Copied ' + objs.length + ' item' + (objs.length > 1 ? 's' : ''));
  }

  function pasteSel(dc, dr) {
    const cb = S.clipboard;
    if (!cb || !cb.items.length) { toast('Clipboard is empty', 'warn'); return; }
    dc = dc === undefined ? 1 : dc; dr = dr === undefined ? 1 : dr;
    const created = [];
    S.edit('Paste', function () {
      Object.keys(cb.defs).forEach(function (id) {
        if (!S.doc.library[id]) S.doc.library[id] = U.deepClone(cb.defs[id]);
      });
      cb.items.forEach(function (it) {
        const o = U.deepClone(it.obj);
        o.id = U.uid(it.kind[0]);
        if (it.kind === 'part') {
          o.col += dc; o.row += dr;
          const def = S.def(o.def);
          o.ref = U.nextDesignator((def && def.refPrefix) || 'U', S.doc.parts.map(p => p.ref));
        } else if (it.kind === 'wire') {
          o.pts = o.pts.map(p => ({ c: p.c + dc, r: p.r + dr }));
        } else if (it.kind === 'text') { o.col += dc; o.row += dr; }
        S.listOf(it.kind).push(o);
        created.push({ kind: it.kind, id: o.id });
      });
    });
    S.selectOnly(created);
  }

  /** Bounding box of the current selection, in hole units. */
  function selectionBounds(objs) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const grow = function (x, y) {
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    };
    objs.forEach(function (o) {
      if (o.kind === 'part') {
        const r = PB.parts.fullBounds(o.obj);
        grow(r.x, r.y); grow(r.x + r.w, r.y + r.h);
      } else if (o.kind === 'wire') {
        o.obj.pts.forEach(function (pt) { grow(pt.c, pt.r); });
      } else if (o.kind === 'text') {
        grow(o.obj.col, o.obj.row);
      }
    });
    if (!isFinite(minx)) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
  }

  /** Would the selection, shifted by (dc,dr), land somewhere sensible? */
  function offsetFits(objs, dc, dr) {
    const bd = S.doc.board;
    const occ = PB.nets.occupancy();
    const shrink = 0.15;
    for (const o of objs) {
      if (o.kind === 'part') {
        const ghost = Object.assign({}, o.obj, { col: o.obj.col + dc, row: o.obj.row + dr });
        const def = S.def(ghost.def);
        if (!def) continue;
        const holes = PB.parts.pinHoles(ghost, def);
        for (const h of holes) {
          if (!PB.board.inside(h.c, h.r)) return false;
          if (PB.board.noHole(h.c, h.r)) return false;                  // no pad there
          if ((occ.get(h.c + ',' + h.r) || []).length) return false;    // pad already taken
        }
        /* and the copy must not sit under an existing body, or you would
           not be able to see that anything happened */
        const rct = PB.parts.bodyRect(ghost, def);
        const test = { x: rct.x + shrink, y: rct.y + shrink, w: rct.w - shrink * 2, h: rct.h - shrink * 2 };
        for (const other of S.doc.parts) {
          if (other.side !== ghost.side) continue;
          const od = S.def(other.def);
          if (!od) continue;
          const orct = PB.parts.bodyRect(other, od);
          if (U.rectsOverlap(test, {
            x: orct.x + shrink, y: orct.y + shrink,
            w: orct.w - shrink * 2, h: orct.h - shrink * 2
          })) return false;
        }
      } else if (o.kind === 'wire') {
        for (const pt of o.obj.pts) {
          const c = pt.c + dc, r = pt.r + dr;
          if (c < 0 || r < 0 || c > bd.cols - 1 || r > bd.rows - 1) return false;
        }
      } else if (o.kind === 'text') {
        if (!PB.board.inside(o.obj.col + dc, o.obj.row + dr)) return false;
      }
    }
    return true;
  }

  /**
   * Duplicate into the nearest genuinely free spot.  The old fixed
   * one-hole offset buried the copy underneath anything bigger than a
   * resistor, which looked exactly like nothing having happened.
   */
  function duplicate() {
    const objs = S.selObjects();
    if (!objs.length) { toast('Select something to duplicate first', 'warn'); return; }
    const bd = S.doc.board;
    const b = selectionBounds(objs);
    const w = Math.max(1, Math.ceil(b.w) + 1), h = Math.max(1, Math.ceil(b.h) + 1);

    /* try clean side-by-side placements first, then widen the search */
    const cands = [[w, 0], [0, h], [-w, 0], [0, -h], [w, h], [-w, h], [w, -h], [-w, -h]];
    for (let d = 1; d <= bd.cols + bd.rows; d++) {
      for (let dc = -d; dc <= d; dc++) {
        const dr = d - Math.abs(dc);
        cands.push([dc, dr]);
        if (dr) cands.push([dc, -dr]);
      }
    }

    let pick = null;
    for (const cd of cands) {
      if (offsetFits(objs, cd[0], cd[1])) { pick = cd; break; }
    }

    copySel(true);
    if (pick) {
      pasteSel(pick[0], pick[1]);
      toast('Duplicated ' + objs.length + ' item' + (objs.length > 1 ? 's' : ''), 'good');
    } else {
      pasteSel(1, 1);
      toast('No clear space left \u2014 the copy is on top of the original', 'warn', 4000);
    }
  }

  function nudgeSel(dc, dr) {
    const objs = S.selObjects();
    if (!objs.length) return;
    S.edit('Nudge', function () {
      objs.forEach(function (o) {
        if (o.kind === 'part' || o.kind === 'text') { o.obj.col += dc; o.obj.row += dr; }
        else if (o.kind === 'wire') o.obj.pts = o.obj.pts.map(p => ({ c: p.c + dc, r: p.r + dr }));
      });
    });
  }

  /**
   * Choosing a side also turns the board over, the way you would in your
   * hand: on the back, column A sits on the right.  `B` still toggles the
   * mirror on its own for anyone who wants the other convention.
   */
  function setSide(side) {
    S.setUI({ side: side, flipped: side === 'back' });
    U.$$('.side-switch button').forEach(b => b.classList.toggle('on', b.dataset.side === side));
    PB.view.drawRulers();
    PB.render.schedule();
  }

  /* ==================================================================
     Auto-routing helpers
     ================================================================== */
  function autorouteRats() {
    if (!S.doc.rats.length) { toast('No ratsnest links to route', 'warn'); return; }
    let ok = 0, fail = 0;
    S.edit('Auto-route ratsnest', function () {
      const field = PB.router.buildField(S.ui.side, {});
      const remaining = [];
      S.doc.rats.forEach(function (rt) {
        const a = PB.tools.ratHole(rt.a), b = PB.tools.ratHole(rt.b);
        if (!a || !b) { remaining.push(rt); return; }
        const pts = PB.router.autoroute(a, b, { mode: S.ui.wireMode === 'free' ? 'ortho' : S.ui.wireMode, side: S.ui.side, field: field });
        if (pts && pts.length > 1) {
          const w = PB.make.wire(pts, { net: rt.net, color: rt.net ? (S.netColor(rt.net) || S.ui.wireColor) : S.ui.wireColor });
          S.doc.wires.push(w);
          ok++;
        } else { remaining.push(rt); fail++; }
      });
      S.doc.rats = remaining;
    });
    toast('Routed ' + ok + ' link' + (ok === 1 ? '' : 's') + (fail ? ', ' + fail + ' failed' : ''), fail ? 'warn' : 'good');
  }

  function tidyWires() {
    const objs = S.selObjects().filter(o => o.kind === 'wire');
    const list = objs.length ? objs.map(o => o.obj) : S.doc.wires.filter(w => w.side === S.ui.side);
    const targets = list.filter(w => w.mode !== 'free' && !w.locked);
    if (!targets.length) { toast('No right-angle wires to re-flow', 'warn'); return; }
    S.edit('Re-flow wires', function () {
      const field = PB.router.buildField(S.ui.side, { wires: new Set(targets.map(w => w.id)) });
      targets.forEach(function (w) { PB.router.reflow(w, { auto: true, field: field }); });
    });
    toast('Re-flowed ' + targets.length + ' wire' + (targets.length === 1 ? '' : 's'), 'good');
  }

  /* ==================================================================
     Inspector: tabs
     ================================================================== */
  function showTab(name) {
    activeTab = name;
    U.$$('#inspTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    U.$$('.tabpane').forEach(p => p.classList.toggle('on', p.dataset.pane === name));
    refreshTab();
  }

  function refreshTab() {
    if (activeTab === 'library') renderLibrary();
    else if (activeTab === 'props') renderProps();
    else if (activeTab === 'board') renderBoard();
    else if (activeTab === 'nets') renderNets();
    else if (activeTab === 'checks') renderDRC();
  }

  /* ==================================================================
     Library panel
     ================================================================== */
  const COLLAPSE_KEY = 'pbstudio.libcollapsed.v1';
  let libClosed = new Set(U.store.get(COLLAPSE_KEY, []) || []);

  function toggleCategory(cat) {
    if (libClosed.has(cat)) libClosed.delete(cat); else libClosed.add(cat);
    U.store.set(COLLAPSE_KEY, Array.from(libClosed));
    renderLibrary();
  }

  function renderLibrary() {
    const host = U.clear(U.$('#libList'));
    const list = PB.parts.search(libFilter);
    if (!list.length) { host.appendChild(el('div.empty', { text: 'No parts match "' + libFilter + '".' })); return; }
    const searching = !!libFilter;         // a search always reveals what it found
    PB.parts.byCategory(list).forEach(function (entry) {
      const cat = entry[0];
      const closed = !searching && libClosed.has(cat);
      host.appendChild(el('button.lib-group' + (closed ? '.closed' : ''), {
        title: (closed ? 'Show ' : 'Hide ') + cat,
        onclick: function () { toggleCategory(cat); }
      }, [
        el('span.caret', { text: '\u25be' }),
        el('span', { text: cat }),
        el('span.cnt', { text: String(entry[1].length) })
      ]));
      if (closed) return;
      entry[1].sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (def) {
        const isSel = S.ui.placingDef === def.id;
        const row = el('div.lib-item' + (isSel ? '.on' : ''), {
          onclick: function () { armPlace(def.id); },
          title: def.name + (def.desc ? '\n' + def.desc : '') + '\n' + PB.parts.summary(def)
        }, [
          el('div.lib-thumb', { html: PB.parts.thumbSVG(def) }),
          el('div.li-main', null, [
            el('div.li-name', { text: def.name }),
            el('div.li-sub', { text: PB.parts.summary(def) })
          ]),
          el('div.li-act', null, [
            el('button', {
              text: '✎', title: 'Edit / duplicate this part',
              onclick: function (e) { e.stopPropagation(); PB.partDesigner.open(def.id); }
            }),
            PB.parts.isUser(def.id) ? el('button', {
              text: '🗑', title: 'Delete this custom part',
              onclick: function (e) {
                e.stopPropagation();
                confirm('Delete part', 'Delete the custom part "' + def.name + '"?', function () {
                  PB.parts.deleteUser(def.id); toast('Deleted', 'good');
                }, true);
              }
            }) : null
          ])
        ]);
        host.appendChild(row);
      });
    });
  }

  function armPlace(defId) {
    S.setUI({ placingDef: defId, tool: 'place' });
    U.$$('#toolbar .tool').forEach(b => b.classList.toggle('on', b.dataset.tool === 'place'));
    PB.tools.refreshOverlay();
    renderLibrary();
    updateStatus();
  }

  /* ==================================================================
     Properties panel
     ================================================================== */
  function renderProps() {
    const host = U.clear(U.$('#propsBody'));
    const objs = S.selObjects();

    if (!objs.length) { host.appendChild(docSummary()); return; }
    if (objs.length > 1) { host.appendChild(multiProps(objs)); return; }

    const o = objs[0];
    if (o.kind === 'part') host.appendChild(partProps(o.obj));
    else if (o.kind === 'wire') host.appendChild(wireProps(o.obj));
    else if (o.kind === 'text') host.appendChild(textProps(o.obj));
    else host.appendChild(el('div.empty', { text: 'Nothing editable selected.' }));
  }

  function sect(title, kids) { return el('div.sect', null, [el('h4', { text: title })].concat(kids)); }
  function field(label, control) { return el('div.field', null, [el('label', { text: label }), control]); }

  function docSummary() {
    const t = PB.nets.totals();
    const bd = S.doc.board;
    const size = PB.board.sizeMM();
    return el('div', null, [
      sect('Project', [
        field('Name', el('input', {
          type: 'text', value: S.doc.meta.name,
          onchange: function (e) { S.edit('Rename project', function () { S.doc.meta.name = e.target.value; }); updateStatus(); }
        })),
        el('div.field-wide', null, [
          el('label', { text: 'Notes' }),
          el('textarea', {
            rows: 3, value: S.doc.meta.notes, style: { width: '100%' },
            onchange: function (e) { S.edit('Edit notes', function () { S.doc.meta.notes = e.target.value; }); }
          })
        ])
      ]),
      sect('Summary', [
        el('div.kv', null, [
          el('b', { text: 'Board' }), el('span', { text: bd.cols + ' × ' + bd.rows + ' holes' }),
          el('b', { text: 'Size' }), el('span', { text: U.round(size.w, 1) + ' × ' + U.round(size.h, 1) + ' mm' }),
          el('b', { text: 'Parts' }), el('span', { text: String(t.parts) }),
          el('b', { text: 'Jumpers' }), el('span', { text: String(t.wires) }),
          el('b', { text: 'Wire total' }), el('span', { text: U.round(t.wireMM / 10, 1) + ' cm' }),
          el('b', { text: 'Track cuts' }), el('span', { text: String(t.cuts) }),
          el('b', { text: 'Nets' }), el('span', { text: String(t.nets) })
        ])
      ]),
      sect('Display', [
        checkRow('Part designators', 'showLabels'),
        checkRow('Ratsnest', 'showRats'),
        checkRow('Rulers', 'showRulers', function () { run('view.toggleRulers'); return true; }),
        field('Pin names', el('select', {
          value: S.ui.showPinNames,
          onchange: function (e) { S.setUI({ showPinNames: e.target.value }); }
        }, [
          el('option', { value: 'auto', text: 'When zoomed in' }),
          el('option', { value: 'always', text: 'Always' }),
          el('option', { value: 'never', text: 'Never' })
        ])),
        field('Units', el('select', {
          value: S.ui.unit,
          onchange: function (e) { S.setUI({ unit: e.target.value }); updateStatus(); }
        }, [
          el('option', { value: 'mm', text: 'Millimetres' }),
          el('option', { value: 'in', text: 'Inches' }),
          el('option', { value: 'holes', text: 'Hole pitches' })
        ]))
      ]),
      el('p.hint', { text: 'Select a part or a wire to edit it.' })
    ]);
  }

  function checkRow(label, key, custom) {
    return el('div.field', null, [
      el('label', { text: label }),
      el('input', {
        type: 'checkbox', checked: !!S.ui[key],
        onchange: function () {
          if (custom && custom()) return;
          const patch = {}; patch[key] = !S.ui[key]; S.setUI(patch);
        }
      })
    ]);
  }

  function partProps(part) {
    const def = S.def(part.def) || {};
    const nets = PB.nets.compute();
    const holes = PB.parts.pinHoles(part, def);
    const rows = holes.map(function (h) {
      const cm = nets.compAt(h.c, h.r);
      const others = cm ? cm.pins.filter(p => p.part.id !== part.id).map(p => p.part.ref + '.' + p.pin.name) : [];
      return el('tr', null, [
        el('td.pn', { text: h.pin.n }),
        el('td', { text: h.pin.name }),
        el('td.pn', { text: PB.board.inside(h.c, h.r) ? PB.board.holeLabel(h.c, h.r) : '—' }),
        el('td.pn', { text: others.length ? others.join(', ') : (cm && cm.wires.length ? cm.name : '') })
      ]);
    });

    return el('div', null, [
      sect(def.name || 'Part', [
        field('Designator', el('input', {
          type: 'text', value: part.ref,
          onchange: function (e) { S.edit('Rename part', function () { part.ref = e.target.value; }); }
        })),
        field('Value', el('input', {
          type: 'text', value: part.value || '',
          onchange: function (e) { S.edit('Set value', function () { part.value = e.target.value; }); }
        })),
        field('Position', el('div.row', null, [
          numInput(part.col, function (v) { S.edit('Move', function () { part.col = v; }); }, 'col'),
          numInput(part.row, function (v) { S.edit('Move', function () { part.row = v; }); }, 'row'),
          el('span.dim', { text: PB.board.holeLabel(part.col, part.row) })
        ])),
        field('Rotation', el('div.row', null, [
          el('select', {
            value: String(part.rot || 0),
            onchange: function (e) { S.edit('Rotate', function () { part.rot = +e.target.value; }); }
          }, [0, 90, 180, 270].map(d => el('option', { value: String(d), text: d + '°' }))),
          el('button.mini', { text: 'Rotate 90°', onclick: function () { rotateSel(90); } })
        ])),
        field('Side', sideSelect(part)),
        field('Mirrored', el('input', {
          type: 'checkbox', checked: !!part.mirror,
          onchange: function () { S.edit('Mirror', function () { part.mirror = !part.mirror; }); }
        })),
        field('Locked', el('input', {
          type: 'checkbox', checked: !!part.locked,
          onchange: function () { S.edit('Lock', function () { part.locked = !part.locked; }); }
        }))
      ]),
      sect('Pins (' + holes.length + ')', [
        el('div.pinlist', null, [
          el('table', null, [
            el('thead', null, [el('tr', null, [
              el('th', { text: '#' }), el('th', { text: 'Name' }), el('th', { text: 'Hole' }), el('th', { text: 'Connects to' })
            ])]),
            el('tbody', null, rows)
          ])
        ])
      ]),
      sect('Actions', [
        el('div.row', null, [
          el('button.mini', { text: 'Edit definition…', onclick: function () { PB.partDesigner.open(part.def); } }),
          el('button.mini', { text: 'Select same type', onclick: function () {
            S.selectOnly(S.doc.parts.filter(p => p.def === part.def).map(p => ({ kind: 'part', id: p.id })));
          } }),
          el('button.mini.danger', { text: 'Delete', onclick: deleteSel })
        ])
      ])
    ]);
  }

  function sideSelect(obj) {
    return el('select', {
      value: obj.side || 'front',
      onchange: function (e) { S.edit('Change side', function () { obj.side = e.target.value; }); }
    }, [el('option', { value: 'front', text: 'Front (component)' }), el('option', { value: 'back', text: 'Back (solder)' })]);
  }

  function numInput(v, onChange, title) {
    return el('input', {
      type: 'number', value: v, step: 1, title: title || '', style: { width: '64px' },
      onchange: function (e) { onChange(Math.round(+e.target.value || 0)); }
    });
  }

  function wireProps(w) {
    const nets = PB.nets.compute();
    const cm = nets.compAt(w.pts[0].c, w.pts[0].r);
    const len = PB.nets.wireLengthMM(w);
    return el('div', null, [
      sect('Jumper wire', [
        field('Style', el('select', {
          value: w.mode,
          onchange: function (e) {
            S.edit('Change wire style', function () {
              w.mode = e.target.value;
              PB.router.reflow(w, { auto: false });
            });
          }
        }, [
          el('option', { value: 'ortho', text: 'Right angle' }),
          el('option', { value: 'diag', text: '45°' }),
          el('option', { value: 'free', text: 'Any angle' })
        ])),
        field('Side', sideSelect(w)),
        field('Colour', el('div.row', null, [
          el('input', {
            type: 'color', value: w.color,
            onchange: function (e) { S.edit('Wire colour', function () { w.color = e.target.value; }); }
          }),
          swatchRow(w.color, function (c) { S.edit('Wire colour', function () { w.color = c; }); })
        ])),
        field('Gauge', el('select', {
          value: String(w.gauge),
          onchange: function (e) { S.edit('Wire gauge', function () { w.gauge = +e.target.value; }); }
        }, [['0.30', '30 AWG'], ['0.40', '26 AWG'], ['0.51', '24 AWG'], ['0.64', '22 AWG'],
            ['0.81', '20 AWG'], ['1.02', '18 AWG']].map(o => el('option', { value: o[0], text: o[1] })))),
        field('Net', netSelect(w))
      ]),
      sect('Geometry', [
        el('div.kv', null, [
          el('b', { text: 'From' }), el('span', { text: PB.board.holeLabel(w.pts[0].c, w.pts[0].r) }),
          el('b', { text: 'To' }), el('span', { text: PB.board.holeLabel(w.pts[w.pts.length - 1].c, w.pts[w.pts.length - 1].r) }),
          el('b', { text: 'Bends' }), el('span', { text: String(Math.max(0, w.pts.length - 2)) }),
          el('b', { text: 'Length' }), el('span', { text: U.fmtLen(len, S.ui.unit) }),
          el('b', { text: 'Cut to' }), el('span', { text: U.round(len + 12, 0) + ' mm' }),
          el('b', { text: 'Net' }), el('span', { text: cm ? cm.name : '—' })
        ]),
        el('div.row', { style: { marginTop: '8px' } }, [
          el('button.mini', { text: 'Auto-route', onclick: function () {
            S.edit('Auto-route wire', function () { PB.router.reflow(w, { auto: true }); });
          } }),
          el('button.mini', { text: 'Flip elbow', onclick: function () {
            S.edit('Flip elbow', function () { PB.router.reflow(w, { auto: false, flip: true }); });
          } }),
          el('button.mini', { text: 'Straighten', onclick: function () {
            S.edit('Straighten', function () { w.pts = [w.pts[0], w.pts[w.pts.length - 1]]; });
          } }),
          el('button.mini', { text: 'Reverse', onclick: function () {
            S.edit('Reverse', function () { w.pts = w.pts.slice().reverse(); });
          } }),
          el('button.mini.danger', { text: 'Delete', onclick: deleteSel })
        ])
      ]),
      el('p.hint', { text: 'Double-click a wire to add a bend; drag the handles to shape it. Alt for off-grid.' })
    ]);
  }

  function swatchRow(current, onPick) {
    const box = el('span.swatches');
    WIRE_COLORS.forEach(function (c) {
      box.appendChild(el('b' + (c === current ? '.on' : ''), {
        style: { background: c }, title: c, onclick: function () { onPick(c); }
      }));
    });
    return box;
  }

  function netSelect(w) {
    const sel = el('select', {
      value: w.net || '',
      onchange: function (e) {
        S.edit('Assign net', function () {
          w.net = e.target.value || null;
          if (w.net) { const n = S.net(w.net); if (n) w.color = n.color; }
        });
      }
    }, [el('option', { value: '', text: '— none —' })].concat(
      S.doc.nets.map(n => el('option', { value: n.id, text: n.name }))
    ));
    return el('div.row', null, [sel, el('button.mini', {
      text: '+', title: 'New net', onclick: function () {
        prompt('New net name', '', function (name) {
          if (!name) return;
          S.edit('Add net', function () {
            const n = PB.make.net(name);
            S.doc.nets.push(n);
            w.net = n.id; w.color = n.color;
          });
        });
      }
    })]);
  }

  function textProps(t) {
    return el('div', null, [
      sect('Annotation', [
        el('div.field-wide', null, [
          el('label', { text: 'Text' }),
          el('input', { type: 'text', value: t.text, style: { width: '100%' },
            onchange: function (e) { S.edit('Edit text', function () { t.text = e.target.value; }); } })
        ]),
        field('Size (mm)', el('input', { type: 'number', value: t.size, step: 0.2, min: 0.5,
          onchange: function (e) { S.edit('Text size', function () { t.size = +e.target.value; }); } })),
        field('Colour', el('input', { type: 'color', value: t.color,
          onchange: function (e) { S.edit('Text colour', function () { t.color = e.target.value; }); } })),
        field('Rotation', el('select', { value: String(t.rot || 0),
          onchange: function (e) { S.edit('Rotate text', function () { t.rot = +e.target.value; }); } },
          [0, 90, 180, 270].map(d => el('option', { value: String(d), text: d + '°' })))),
        field('Side', sideSelect(t)),
        field('Align', el('select', { value: t.anchor || 'start',
          onchange: function (e) { S.edit('Align text', function () { t.anchor = e.target.value; }); } },
          [['start', 'Left'], ['middle', 'Centre'], ['end', 'Right']].map(o => el('option', { value: o[0], text: o[1] }))))
      ]),
      el('div.row', null, [el('button.mini.danger', { text: 'Delete', onclick: deleteSel })])
    ]);
  }

  function multiProps(objs) {
    const counts = {};
    objs.forEach(o => { counts[o.kind] = (counts[o.kind] || 0) + 1; });
    return el('div', null, [
      sect(objs.length + ' items selected',
        [el('div.kv', null, Object.keys(counts).flatMap(k => [el('b', { text: k }), el('span', { text: String(counts[k]) })]))]),
      sect('Actions', [
        el('div.row', null, [
          el('button.mini', { text: 'Rotate 90°', onclick: function () { rotateSel(90); } }),
          el('button.mini', { text: 'Mirror', onclick: mirrorSel }),
          el('button.mini', { text: 'Flip side', onclick: flipSideSel }),
          el('button.mini', { text: 'Duplicate', onclick: function () { run('edit.duplicate'); } })
        ]),
        el('div.row', { style: { marginTop: '6px' } }, [
          el('button.mini', { text: 'Align left', onclick: function () { align('left'); } }),
          el('button.mini', { text: 'Align top', onclick: function () { align('top'); } }),
          el('button.mini', { text: 'Space H', onclick: function () { space('h'); } }),
          el('button.mini', { text: 'Space V', onclick: function () { space('v'); } })
        ]),
        el('div.row', { style: { marginTop: '6px' } }, [
          el('button.mini.danger', { text: 'Delete all', onclick: deleteSel })
        ])
      ])
    ]);
  }

  function align(how) {
    const parts = S.selObjects().filter(o => o.kind === 'part').map(o => o.obj);
    if (parts.length < 2) return;
    S.edit('Align', function () {
      if (how === 'left') { const c = Math.min.apply(null, parts.map(p => p.col)); parts.forEach(p => { p.col = c; }); }
      else { const r = Math.min.apply(null, parts.map(p => p.row)); parts.forEach(p => { p.row = r; }); }
    });
  }

  function space(dir) {
    const parts = S.selObjects().filter(o => o.kind === 'part').map(o => o.obj);
    if (parts.length < 3) { toast('Select at least three parts', 'warn'); return; }
    S.edit('Distribute', function () {
      const key = dir === 'h' ? 'col' : 'row';
      parts.sort((a, b) => a[key] - b[key]);
      const lo = parts[0][key], hi = parts[parts.length - 1][key];
      const step = (hi - lo) / (parts.length - 1);
      parts.forEach((p, i) => { p[key] = Math.round(lo + step * i); });
    });
  }

  /* ==================================================================
     Board panel
     ================================================================== */
  function renderBoard() {
    const host = U.clear(U.$('#boardBody'));
    const bd = S.doc.board;

    function set(key, val, label) {
      S.edit(label || 'Board setup', function () { bd[key] = val; });
      PB.render.invalidateStatics();
      renderBoard();
    }
    function num(key, opts) {
      return el('input', Object.assign({
        type: 'number', value: bd[key],
        onchange: function (e) { set(key, +e.target.value); }
      }, opts || {}));
    }

    host.appendChild(sect('Board type', [
      el('select', {
        value: bd.type, style: { width: '100%' },
        onchange: function (e) {
          const ty = e.target.value;
          S.edit('Change board type', function () {
            bd.type = ty;
            /* a breadboard needs a band stack; seed a sensible one */
            if (ty === 'breadboard' && !(bd.bands && bd.bands.length)) {
              bd.bands = PB.board.presetBands('bb-half');
              bd.rows = PB.board.bandRows(bd) || bd.rows;
            }
          });
          PB.board.invalidate();
          PB.render.invalidateStatics();
          PB.view.fit();
          renderBoard();
        }
      }, PB.board.BOARD_TYPES.map(t => el('option', { value: t.id, text: t.name }))),
      el('p.hint', { text: (PB.board.BOARD_TYPES.find(t => t.id === bd.type) || {}).desc || '' })
    ]));

    const bandList = PB.board.bands(bd);

    host.appendChild(sect('Size', [
      field('Columns', num('cols', { min: 2, max: 200, step: 1 })),
      bandList
        ? field('Rows', el('div.row', null, [
            el('input', { type: 'number', value: bd.rows, disabled: true, style: { width: '64px' } }),
            el('span.dim', { text: 'set by the bands' })
          ]))
        : field('Rows', num('rows', { min: 2, max: 200, step: 1 })),
      field('Pitch (mm)', num('pitch', { min: 1, max: 10, step: 0.01 })),
      field('Margin (mm)', num('margin', { min: 0, max: 20, step: 0.5 })),
      el('div.row', null, [
        el('button.mini', { text: '30×20', onclick: function () { preset(30, 20); } }),
        el('button.mini', { text: '24×18', onclick: function () { preset(24, 18); } }),
        el('button.mini', { text: '40×30', onclick: function () { preset(40, 30); } }),
        el('button.mini', { text: '50×40', onclick: function () { preset(50, 40); } })
      ]),
      el('p.hint', { text: 'Substrate: ' + U.round(PB.board.sizeMM().w, 1) + ' × ' +
        U.round(PB.board.sizeMM().h, 1) + ' mm  (' +
        U.round(PB.board.sizeMM().w / 25.4, 2) + '" × ' + U.round(PB.board.sizeMM().h / 25.4, 2) + '")' })
    ]));

    if (bd.type === 'strip' || bd.type === 'padpair') {
      host.appendChild(sect('Copper', [
        field('Strips run', el('select', {
          value: bd.stripAxis,
          onchange: function (e) { set('stripAxis', e.target.value, 'Strip direction'); }
        }, [el('option', { value: 'row', text: 'Horizontally (along rows)' }),
            el('option', { value: 'col', text: 'Vertically (along columns)' })])),
        el('p.hint', { text: 'Cut tool (X) breaks a strip. Shift+click cuts the other axis, Alt+click drills the hole out.' })
      ]));
    }

    if (bd.type === 'breadboard') {
      host.appendChild(sect('Band layout', bandEditor(bd)));
    }

    /* ---- holes that this board does not have ---- */
    const voids = new Set(bd.voids || []);
    const gutter = PB.board.gutterHoleKeys(bd);
    const gutterVoided = gutter.length > 0 && gutter.every(function (k) { return voids.has(k); });

    function setVoids(keys, label) {
      S.edit(label, function () { bd.voids = keys; });
      PB.board.invalidate();
      PB.render.invalidateStatics();
      renderBoard();
    }

    host.appendChild(sect('Holes', [
      el('p.hint', {
        text: voids.size
          ? voids.size + ' hole' + (voids.size === 1 ? '' : 's') + ' removed from this board.'
          : 'Every hole on this board is drilled.'
      }),
      (bd.type === 'breadboard' && !bandList) ? field('Gutter holes', el('div.row', null, [
        el('input', {
          type: 'checkbox', checked: !gutterVoided,
          title: 'Untick for a board with no through-holes in the centre channel',
          onchange: function (e) {
            const next = new Set(voids);
            if (e.target.checked) gutter.forEach(function (k) { next.delete(k); });
            else gutter.forEach(function (k) { next.add(k); });
            setVoids(Array.from(next).sort(holeKeyOrder),
              e.target.checked ? 'Drill gutter holes' : 'Remove gutter holes');
          }
        }),
        el('span.dim', { text: gutter.length + ' in the channel' })
      ])) : null,
      el('div.row', null, [
        el('button.mini', {
          text: 'Hole tool (O)',
          onclick: function () {
            PB.tools.setTool('holes');
            U.$$('#toolbar .tool').forEach(b => b.classList.toggle('on', b.dataset.tool === 'holes'));
          }
        }),
        voids.size ? el('button.mini', {
          text: 'Restore all',
          onclick: function () { setVoids([], 'Restore all holes'); }
        }) : null
      ]),
      el('p.hint', {
        text: 'Hole tool: click or drag to remove holes, click a gap to restore. '
          + 'Removed holes have no pad, break the copper, and take no pins or jumpers.'
      })
    ]));

    host.appendChild(sect('Appearance', [
      field('Substrate', el('input', { type: 'color', value: bd.color, onchange: function (e) { set('color', e.target.value); } })),
      field('Pad ring', el('input', { type: 'color', value: bd.padColor, onchange: function (e) { set('padColor', e.target.value); } })),
      field('Copper', el('input', { type: 'color', value: bd.copperColor, onchange: function (e) { set('copperColor', e.target.value); } })),
      el('div.row', null, [
        el('button.mini', { text: 'Green', onclick: function () { theme('#1d6b45', '#d9ae42', '#c98a3c'); } }),
        el('button.mini', { text: 'Tan FR2', onclick: function () { theme('#b08a4a', '#c9a24a', '#c98a3c'); } }),
        el('button.mini', { text: 'Blue', onclick: function () { theme('#1b3f7a', '#d9ae42', '#c98a3c'); } }),
        el('button.mini', { text: 'Black', onclick: function () { theme('#16191e', '#d9ae42', '#c98a3c'); } })
      ]),
      field('Pad Ø (mm)', num('padDia', { min: 0.5, max: 4, step: 0.1 })),
      field('Hole Ø (mm)', num('holeDia', { min: 0.3, max: 3, step: 0.1 })),
      field('Mount holes', el('input', { type: 'checkbox', checked: !!bd.mountHoles,
        onchange: function (e) { set('mountHoles', e.target.checked); } }))
    ]));

    function holeKeyOrder(a, b) {
      const A = String(a).split(','), B = String(b).split(',');
      return (+A[1] - +B[1]) || (+A[0] - +B[0]);
    }

    function preset(c, r) {
      S.edit('Board size', function () { bd.cols = c; bd.rows = r; });
      PB.render.invalidateStatics(); PB.view.fit(); renderBoard();
    }
    function theme(a, b, c) {
      S.edit('Board colours', function () { bd.color = a; bd.padColor = b; bd.copperColor = c; });
      PB.render.invalidateStatics(); renderBoard();
    }
  }

  /* ------------------------------------------------------------------
     Band layout editor

     A breadboard-style board is a stack of horizontal bands read top to
     bottom, which is exactly how you describe the real thing: rail,
     blank, five, channel, five, blank, rail.
     ------------------------------------------------------------------ */
  function bandEditor(bd) {
    const list = PB.board.bands(bd) || [];

    function commit(next, label) {
      S.edit(label || 'Band layout', function () {
        bd.bands = next.map(function (z) {
          const o = { kind: z.kind, rows: z.rows };
          if (z.split) o.split = true;
          if (z.mounts) o.mounts = true;
          return o;
        });
        bd.rows = PB.board.bandRows(bd) || bd.rows;
      });
      PB.board.invalidate();
      PB.render.invalidateStatics();
      PB.view.fit();
      renderBoard();
    }

    const rows = list.map(function (z, i) {
      const kind = PB.board.bandKind(z.kind);
      const row = el('div.band-row.k-' + z.kind, { title: kind.desc });

      row.appendChild(el('select', {
        value: z.kind,
        onchange: function (e) {
          const next = list.slice();
          next[i] = Object.assign({}, z, { kind: e.target.value });
          commit(next, 'Change band');
        }
      }, PB.board.BAND_KINDS.map(k => el('option', { value: k.id, text: k.name }))));

      row.appendChild(el('input.bw', {
        type: 'number', value: z.rows, min: 1, max: 60, step: 1, title: 'rows in this band',
        onchange: function (e) {
          const next = list.slice();
          next[i] = Object.assign({}, z, { rows: U.clamp(Math.round(+e.target.value || 1), 1, 60) });
          commit(next, 'Resize band');
        }
      }));

      if (z.kind === 'rail') {
        row.appendChild(el('button.bx' + (z.split ? '.on' : ''), {
          html: '&#9134;', title: z.split ? 'Split in the middle — click to join' : 'One strip — click to split in the middle',
          onclick: function () {
            const next = list.slice();
            next[i] = Object.assign({}, z, { split: !z.split });
            commit(next, 'Split rail');
          }
        }));
      } else if (z.kind === 'blank') {
        row.appendChild(el('button.bx' + (z.mounts ? '.on' : ''), {
          html: '&#9678;', title: z.mounts ? 'Has mounting holes — click to remove' : 'Add a mounting hole at each end',
          onclick: function () {
            const next = list.slice();
            next[i] = Object.assign({}, z, { mounts: !z.mounts });
            commit(next, 'Band mounting holes');
          }
        }));
      } else {
        row.appendChild(el('span', { style: { width: '18px' } }));
      }

      row.appendChild(el('button.bx', {
        html: '&#9650;', title: 'Move up', disabled: i === 0,
        onclick: function () {
          if (i === 0) return;
          const next = list.slice();
          next.splice(i - 1, 0, next.splice(i, 1)[0]);
          commit(next, 'Reorder bands');
        }
      }));
      row.appendChild(el('button.bx', {
        html: '&#9660;', title: 'Move down', disabled: i === list.length - 1,
        onclick: function () {
          if (i === list.length - 1) return;
          const next = list.slice();
          next.splice(i + 1, 0, next.splice(i, 1)[0]);
          commit(next, 'Reorder bands');
        }
      }));
      row.appendChild(el('button.bx.del', {
        html: '&times;', title: 'Remove this band', disabled: list.length < 2,
        onclick: function () {
          if (list.length < 2) return;
          const next = list.slice();
          next.splice(i, 1);
          commit(next, 'Remove band');
        }
      }));
      return row;
    });

    const presetSel = el('select', {
      value: '', style: { width: '100%' },
      onchange: function (e) {
        const pre = PB.board.BAND_PRESETS.find(x => x.id === e.target.value);
        e.target.value = '';
        if (pre) commit(PB.board.presetBands(pre.id), 'Apply ' + pre.name);
      }
    }, [el('option', { value: '', text: 'Start from a preset\u2026' })]
      .concat(PB.board.BAND_PRESETS.map(x => el('option', { value: x.id, text: x.name }))));

    return [
      el('div.band-list', null, rows.length ? rows : [el('p.hint', { text: 'No bands yet.' })]),
      el('div.row', null, [
        el('button.mini', {
          text: '+ Band',
          onclick: function () {
            commit(list.concat([{ kind: 'group', rows: 5 }]), 'Add band');
          }
        }),
        el('button.mini', {
          text: 'Mirror',
          title: 'Make the stack symmetrical top to bottom',
          onclick: function () {
            const half = list.slice();
            const rev = half.slice(0, -1).reverse().map(z => U.deepClone(z));
            commit(half.concat(rev), 'Mirror bands');
          }
        })
      ]),
      el('div', { style: { marginTop: '6px' } }, [presetSel]),
      el('p.hint', {
        html: 'List the bands top to bottom. <b>Power rail</b> joins each row across, '
          + '<b>Hole groups</b> joins each column down, <b>Blank</b> is bare board, '
          + '<b>Isolated pads</b> is perfboard. Row count follows from the bands.'
      })
    ];
  }

  /* ==================================================================
     Nets panel
     ================================================================== */
  let netFilter = '';
  let showLoneNets = false;

  function renderNets() {
    const host = U.clear(U.$('#netList'));
    const nets = PB.nets.compute();
    const connected = c => (c.pins.length + c.wires.length) > 1 || c.wires.length > 0;
    const lone = nets.comps.filter(c => (c.pins.length + c.wires.length) > 0 && !connected(c));
    const list = nets.comps
      .filter(c => connected(c) || showLoneNets)
      .filter(c => (c.pins.length + c.wires.length) > 0)
      .filter(c => !netFilter || String(c.name).toLowerCase().indexOf(netFilter.toLowerCase()) >= 0);

    if (!list.length) {
      host.appendChild(el('div.empty', { html: 'No connections yet.<br>Place a couple of parts and run some jumpers.' }));
    }

    list.forEach(function (cm) {
      const row = el('div.net-row' + (S.ui.highlightNet === cm.id ? '.on' : ''), {
        title: cm.pins.map(p => p.part.ref + '.' + p.pin.name).join(', ') || 'wires only',
        onclick: function () {
          S.setUI({ highlightNet: S.ui.highlightNet === cm.id ? null : cm.id });
          if (S.ui.highlightNet && cm.pins[0]) PB.view.centerOn(cm.pins[0].c, cm.pins[0].r);
          renderNets();
        }
      }, [
        el('span.net-dot', { style: { background: cm.color || '#4a5160' } }),
        el('span.net-name', { text: cm.name }),
        el('span.net-cnt', { text: cm.pins.length + 'p/' + cm.wires.length + 'w' }),
        el('button.mini', {
          text: '✎', title: 'Name this net',
          onclick: function (e) { e.stopPropagation(); nameNet(cm); }
        })
      ]);
      host.appendChild(row);
    });

    if (lone.length) {
      host.appendChild(el('div.net-row', {
        style: { justifyContent: 'center' },
        onclick: function () { showLoneNets = !showLoneNets; renderNets(); }
      }, [el('span.net-cnt', {
        text: (showLoneNets ? 'hide' : 'show') + ' ' + lone.length + ' unconnected pin' + (lone.length === 1 ? '' : 's')
      })]));
    }

    host.appendChild(el('div.lib-group', { text: 'Declared nets' }));
    S.doc.nets.forEach(function (n) {
      host.appendChild(el('div.net-row', null, [
        el('input', {
          type: 'color', value: n.color, style: { width: '26px', height: '20px' },
          onchange: function (e) { S.edit('Net colour', function () { n.color = e.target.value; }); }
        }),
        el('input', {
          type: 'text', value: n.name, style: { flex: '1 1 auto', minWidth: 0 },
          onchange: function (e) { S.edit('Rename net', function () { n.name = e.target.value; }); }
        }),
        el('button.mini.danger', {
          text: '×', title: 'Delete net',
          onclick: function () {
            S.edit('Delete net', function () {
              S.doc.wires.forEach(w => { if (w.net === n.id) w.net = null; });
              S.remove('net', n.id);
            });
          }
        })
      ]));
    });
  }

  function nameNet(cm) {
    prompt('Net name', cm.name && cm.name[0] !== 'N' ? cm.name : '', function (name) {
      if (!name) return;
      S.edit('Name net', function () {
        let n = S.doc.nets.find(x => x.name === name);
        if (!n) { n = PB.make.net(name); S.doc.nets.push(n); }
        cm.wires.forEach(function (wref) {
          const w = S.find('wire', wref.id);
          if (w) { w.net = n.id; w.color = n.color; }
        });
        if (!cm.wires.length) toast('That node has no jumper to carry the name yet', 'warn');
      });
      renderNets();
    });
  }

  /* ==================================================================
     Checks panel
     ================================================================== */
  function renderDRC() {
    const host = U.clear(U.$('#drcList'));
    const issues = S.drc || [];
    if (!issues.length) {
      host.appendChild(el('div.empty', { html: 'No issues found.<br><span class="dim">Run the checks after changing the layout.</span>' }));
      return;
    }
    issues.forEach(function (it) {
      host.appendChild(el('div.drc-item.' + (it.sev === 'err' ? 'err' : it.sev === 'warn' ? 'warn' : 'info'), {
        onclick: function () { focusIssue(it); }
      }, [
        el('div.drc-ico'),
        el('div.drc-txt', null, [el('b', { text: it.msg }), it.where ? el('span', { text: it.where }) : null])
      ]));
    });
  }

  function focusIssue(it) {
    if (!it.focus) return;
    const o = S.find(it.focus.kind, it.focus.id);
    if (!o) return;
    S.selectOnly([it.focus]);
    if (it.focus.kind === 'part') PB.view.centerOn(o.col, o.row, 8);
    else if (it.focus.kind === 'wire') PB.view.centerOn(o.pts[0].c, o.pts[0].r, 8);
  }

  /* ==================================================================
     Context menu
     ================================================================== */
  let ctxNode = null, ctxOff = null;
  const SEP = { sep: true };

  function closeContext() {
    if (ctxOff) { ctxOff(); ctxOff = null; }
    if (ctxNode) { ctxNode.remove(); ctxNode = null; }
  }

  function contextMenu(ev, h) {
    closeContext();
    const items = [];

    if (S.ui.tool === 'place' && S.ui.placingDef) {
      /* Placing is a mode of its own, so the menu is about that. */
      const d = PB.parts.get(S.ui.placingDef);
      items.push({ head: 'Placing ' + (d ? d.name : 'part') });
      items.push({ label: 'Finish placing', kbd: 'Esc', run: finishPlacing });
      items.push(SEP);
      items.push({ label: 'Rotate 90\u00b0', kbd: 'R', run: function () { bumpPlaceRot(90); } });
      items.push({ label: 'Rotate \u221290\u00b0', kbd: 'Shift R', run: function () { bumpPlaceRot(270); } });
      items.push({
        label: S.ui.placeMirror ? 'Stop mirroring' : 'Mirror', kbd: 'M',
        run: function () { S.setUI({ placeMirror: !S.ui.placeMirror }); PB.tools.refreshOverlay(); }
      });
      items.push(SEP);
      items.push({ label: 'Pick a different part\u2026', run: function () { showTab('library'); } });
    } else if (h) {
      const kind = h.kind === 'pin' || h.kind === 'pins' ? 'part' : (h.kind === 'wirept' ? 'wire' : h.kind);
      if (!S.sel.has(kind + ':' + h.id)) S.selectOnly([{ kind: kind, id: h.id }]);
      const n = S.sel.size;

      if (kind === 'part') {
        const part = S.find('part', h.id);
        const def = part && S.def(part.def);
        items.push({ head: n > 1 ? n + ' items' : (part ? part.ref + ' \u2014 ' + (def ? def.name : part.def) : 'Part') });
        items.push({ label: 'Rotate 90\u00b0', kbd: 'R', run: function () { rotateSel(90); } });
        items.push({ label: 'Mirror', kbd: 'M', run: mirrorSel });
        items.push({ label: 'Flip to the other side', kbd: 'F', run: flipSideSel });
        items.push(SEP);
        items.push({ label: 'Properties\u2026', run: function () { showTab('props'); } });
        items.push({ label: 'Edit definition\u2026', run: function () { if (part) PB.partDesigner.open(part.def); } });
        items.push({
          label: 'Select every ' + (def ? def.name : 'one like this'),
          run: function () {
            if (part) S.selectOnly(S.doc.parts.filter(x => x.def === part.def).map(x => ({ kind: 'part', id: x.id })));
          }
        });
      } else if (kind === 'wire') {
        const w = S.find('wire', h.id);
        items.push({ head: n > 1 ? n + ' items' : 'Jumper wire' });
        items.push({ label: 'Auto-route', run: function () { S.edit('Auto-route', function () { PB.router.reflow(w, { auto: true }); }); } });
        items.push({ label: 'Flip elbow', run: function () { S.edit('Flip elbow', function () { PB.router.reflow(w, { auto: false, flip: true }); }); } });
        items.push({ label: 'Straighten', run: function () { S.edit('Straighten', function () { w.pts = [w.pts[0], w.pts[w.pts.length - 1]]; }); } });
        items.push({ label: 'Reverse', run: function () { S.edit('Reverse', function () { w.pts = w.pts.slice().reverse(); }); } });
        items.push(SEP);
        items.push({ label: 'Flip to the other side', kbd: 'F', run: flipSideSel });
        items.push({ label: 'Properties\u2026', run: function () { showTab('props'); } });
      } else if (kind === 'text') {
        const t = S.find('text', h.id);
        items.push({ head: 'Annotation' });
        items.push({
          label: 'Edit text\u2026',
          run: function () {
            if (t) prompt('Edit text', t.text, function (v) {
              if (v !== null) S.edit('Edit text', function () { t.text = v; });
            });
          }
        });
        items.push({ label: 'Flip to the other side', kbd: 'F', run: flipSideSel });
      } else {
        items.push({ head: kind });
      }

      items.push(SEP);
      items.push({ label: 'Copy', kbd: 'Ctrl C', run: function () { copySel(); } });
      items.push({ label: 'Duplicate', kbd: 'Ctrl D', run: duplicate });
      items.push({ label: 'Delete', kbd: 'Del', run: deleteSel });
    } else {
      const snap = PB.tools.state.snap;
      items.push({ head: snap && snap.inside ? PB.board.holeLabel(snap.c, snap.r) : 'Board' });
      items.push({ label: 'Paste here', kbd: 'Ctrl V', run: pasteHere });
      items.push({ label: 'Select all on this side', kbd: 'Ctrl A', run: function () { run('edit.selectAll'); } });
      items.push(SEP);
      items.push({
        label: 'Work on the ' + (S.ui.side === 'front' ? 'BACK' : 'FRONT'),
        kbd: S.ui.side === 'front' ? '2' : '1',
        run: function () { setSide(S.ui.side === 'front' ? 'back' : 'front'); }
      });
      items.push({
        label: S.ui.flipped ? 'Un-mirror the view' : 'Mirror the view',
        kbd: 'B', run: function () { run('view.flipBoard'); }
      });
      items.push(SEP);
      items.push({ label: 'Zoom to fit', kbd: 'Ctrl 0', run: function () { PB.view.fit(); } });
    }

    ctxNode = el('div.menu-pop', {
      style: { display: 'block', position: 'fixed', left: '0px', top: '0px', zIndex: 300 }
    }, items.map(function (it) {
      if (it.sep) return el('hr');
      if (it.head) return el('div.pop-head', { text: it.head });
      return el('button', {
        text: it.label,
        /* Bound to pointerdown, not click: the dismiss-on-outside-click
           listener fires on pointerdown and used to remove the button
           before its click event could ever be delivered. */
        onpointerdown: function (e) {
          e.preventDefault();
          e.stopPropagation();
          const fn = it.run;
          closeContext();
          fn();
        }
      }, it.kbd ? [el('kbd', { text: it.kbd })] : null);
    }));
    document.body.appendChild(ctxNode);

    /* keep the whole menu on screen */
    const r = ctxNode.getBoundingClientRect();
    ctxNode.style.left = Math.max(6, Math.min(ev.clientX, window.innerWidth - r.width - 6)) + 'px';
    ctxNode.style.top = Math.max(6, Math.min(ev.clientY, window.innerHeight - r.height - 6)) + 'px';

    /* Dismiss on a click elsewhere, Escape, scroll or losing focus.
       Anything inside the menu is left to the item handler. */
    const openedAt = ev.timeStamp;
    const onDown = function (e) {
      if (e.timeStamp === openedAt) return;
      if (ctxNode && ctxNode.contains(e.target)) return;
      closeContext();
    };
    const onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeContext(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContext);
    document.addEventListener('wheel', closeContext, { once: true, passive: true });
    ctxOff = function () {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeContext);
      document.removeEventListener('wheel', closeContext);
    };
  }

  function bumpPlaceRot(deg) {
    S.setUI({ placeRot: (((S.ui.placeRot || 0) + deg) % 360 + 360) % 360 });
    PB.tools.refreshOverlay();
  }

  /** Leave place mode cleanly. */
  function finishPlacing() {
    S.setUI({ placingDef: null, placeRot: 0, placeMirror: false });
    PB.tools.setTool('select');
    renderLibrary();
    updateStatus();
  }

  /** Paste with the first copied item landing on the hole under the cursor. */
  function pasteHere() {
    if (!S.clipboard || !S.clipboard.items.length) { toast('Clipboard is empty', 'warn'); return; }
    const snap = PB.tools.state.snap;
    if (!snap || !snap.inside) { pasteSel(1, 1); return; }
    const first = S.clipboard.items[0].obj;
    const anchor = first.col !== undefined
      ? { c: first.col, r: first.row }
      : { c: first.pts[0].c, r: first.pts[0].r };
    pasteSel(snap.c - anchor.c, snap.r - anchor.r);
  }

  /* ==================================================================
     Status bar
     ================================================================== */
  function updateStatus() {
    const t = PB.tools.state;
    const names = { select: 'Select', pan: 'Pan', place: 'Place', wire: 'Wire', link: 'Link',
      cut: 'Cut', holes: 'Holes', text: 'Text', measure: 'Measure', erase: 'Erase' };
    U.$('#st-tool').textContent = names[S.ui.tool] || S.ui.tool;

    let coord = '—';
    if (t.snap) {
      const mm = PB.board.holeToMM(t.snap.c, t.snap.r);
      coord = PB.board.holeLabel(t.snap.c, t.snap.r) +
        '  (' + t.snap.c + ',' + t.snap.r + ')  ' +
        U.round(mm.x, 1) + ',' + U.round(mm.y, 1) + ' mm';
      if (!t.snap.inside) coord += '  off-board';
    }
    U.$('#st-coord').textContent = coord;

    let hoverTxt = '';
    if (S.ui.tool === 'place' && S.ui.placingDef) {
      const d = PB.parts.get(S.ui.placingDef);
      hoverTxt = 'Placing ' + (d ? d.name : '?') + '  ·  R rotate  ·  M mirror  ·  Esc cancel';
    } else if (t.wire) {
      hoverTxt = 'Wire from ' + PB.board.holeLabel(t.wire.pts[0].c, t.wire.pts[0].r) +
        '  ·  Shift+click adds a bend  ·  Tab flips the elbow';
    } else if (t.link) {
      hoverTxt = 'Link started — click the second pad';
    } else if (S.ui.tool === 'holes') {
      const n = (S.doc.board.voids || []).length;
      hoverTxt = 'Click or drag to remove holes, click again to restore'
        + (n ? '  \u00b7  ' + n + ' removed' : '');
    } else if (t.hover) {
      hoverTxt = describeHover(t.hover);
    }
    U.$('#st-hover').textContent = hoverTxt;

    const tot = PB.nets.totals();
    U.$('#st-stats').textContent = tot.parts + 'p · ' + tot.wires + 'w · ' +
      U.round(tot.wireMM / 10, 1) + 'cm · ' + tot.nets + ' nets' + (S.ui.dirty ? ' · ●' : '');
    U.$('#st-zoom').textContent = Math.round(PB.view.scale / 8 * 100) + '%';
  }

  function describeHover(h) {
    if (h.kind === 'part' || h.kind === 'pins') {
      const p = S.find('part', h.id);
      const d = p && S.def(p.def);
      return p ? p.ref + ' — ' + (d ? d.name : p.def) : '';
    }
    if (h.kind === 'pin') {
      const p = S.find('part', h.id);
      const d = p && S.def(p.def);
      const pin = d && d.pins.find(x => x.n === h.pin);
      return p && pin ? p.ref + '.' + pin.name + '  (pin ' + pin.n + ')' : '';
    }
    if (h.kind === 'wire' || h.kind === 'wirept') {
      const w = S.find('wire', h.id);
      if (!w) return '';
      return 'jumper ' + PB.board.holeLabel(w.pts[0].c, w.pts[0].r) + ' → ' +
        PB.board.holeLabel(w.pts[w.pts.length - 1].c, w.pts[w.pts.length - 1].r) +
        '  ' + U.fmtLen(PB.nets.wireLengthMM(w), S.ui.unit);
    }
    if (h.kind === 'text') { const t = S.find('text', h.id); return t ? '"' + t.text + '"' : ''; }
    return '';
  }

  /* ==================================================================
     Help dialogs
     ================================================================== */
  function shortcutsDialog() {
    const rows = [
      ['V / H', 'Select / Pan'], ['P', 'Place part'], ['W', 'Wire'], ['Q', 'Ratsnest link'],
      ['X', 'Track cut'], ['O', 'Add / remove board holes'],
      ['T', 'Text'], ['D', 'Measure'], ['E', 'Erase'],
      ['Space (hold)', 'Temporary pan'], ['Middle drag', 'Pan'], ['Wheel', 'Zoom at cursor'],
      ['Shift + wheel', 'Pan vertically'], ['Ctrl 0', 'Zoom to fit'],
      ['1 / 2', 'Work on front / back (the back view is mirrored)'],
      ['B', 'Mirror the view on its own'],
      ['R', 'Rotate 90°'], ['Shift R', 'Rotate −90°'], ['M', 'Mirror'], ['F', 'Flip to the other side'],
      ['L', 'Toggle designators'], ['N', 'Toggle ratsnest'],
      ['Ctrl Z / Ctrl Y', 'Undo / Redo'], ['Ctrl C / Ctrl V', 'Copy / Paste'], ['Ctrl D', 'Duplicate'],
      ['Delete', 'Delete selection'], ['Arrows', 'Nudge by one hole'], ['Shift + arrows', 'Nudge by five'],
      ['Ctrl A', 'Select all on this side'], ['Esc', 'Cancel / deselect'],
      ['Tab', 'Flip the elbow while drawing'], ['Shift + click', 'Add a bend point'],
      ['Alt + drag', 'Move a bend off-grid'], ['Ctrl + drag part', 'Move without dragging wires'],
      ['Ctrl S / Ctrl O', 'Save / Open'], ['Ctrl E', 'Run design checks'], ['Ctrl P', 'Build sheet']
    ];
    const grid = el('div.sc-grid');
    rows.forEach(function (r) {
      grid.appendChild(el('b', { html: r[0].split(' ').map(k => '<kbd>' + U.esc(k) + '</kbd>').join(' ') }));
      grid.appendChild(el('span', { text: r[1] }));
    });
    modal({ title: 'Keyboard shortcuts', body: grid, width: '520px' });
  }

  function aboutDialog() {
    modal({
      title: 'Protoboard Studio', sub: 'quick start', width: '640px',
      body: el('div.doc', {
        html: [
          '<h4>1 · Board</h4>',
          '<p>Pick a type and hole count in the <code>Board</code> tab. Everything works in hole coordinates — the <code>A1</code> labels on the rulers.</p>',
          '<h4>2 · Parts</h4>',
          '<p>Pick a breakout in <code>Library</code> and click the board. <code>R</code> rotate, <code>M</code> mirror, <code>Esc</code> stop. Not in the list? <code>Tools ▸ Part Designer</code> draws a footprint hole by hole.</p>',
          '<h4>3 · Jumpers</h4>',
          '<p><code>W</code>, click the start pad, click the end. The floating bar picks right-angle, <b>45°</b> or free routing. <b>Auto-route</b> steers around parts; <code>Tab</code> flips a plain elbow, <code>Shift</code>+click adds a bend.</p>',
          '<h4>4 · Sides</h4>',
          '<p><code>FRONT</code>/<code>BACK</code> picks the side you are wiring; the other dims out. The back view also turns the board over, so column A moves to the right as it would in your hand — <code>B</code> toggles that mirror alone. <b>See-through</b> fades part bodies so you can route underneath them.</p>',
          '<h4>5 · Check and build</h4>',
          '<p><code>Checks</code> flags off-board pins, collisions, shorted strips and redundant jumpers. When it is clean, <code>File ▸ Assembly build sheet</code> prints the cut list, BOM and netlist.</p>',
          '<p class="hint">Projects save as one <code>.pbstudio</code> file. Custom parts live in this browser — <code>File ▸ Export part library</code> moves them.</p>'
        ].join('')
      })
    });
  }

  /* ==================================================================
     Wiring up the chrome
     ================================================================== */
  function init() {
    /* menus */
    U.$$('.menu').forEach(function (m) {
      const btn = U.$('.menu-btn', m);
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const open = m.classList.contains('open');
        U.$$('.menu').forEach(x => x.classList.remove('open'));
        if (!open) m.classList.add('open');
      });
      m.addEventListener('pointerenter', function () {
        if (U.$$('.menu.open').length) {
          U.$$('.menu').forEach(x => x.classList.remove('open'));
          m.classList.add('open');
        }
      });
    });
    document.addEventListener('click', function () { U.$$('.menu').forEach(x => x.classList.remove('open')); });

    /* any element with data-cmd */
    document.addEventListener('click', function (e) {
      const t = e.target.closest && e.target.closest('[data-cmd]');
      if (t) { e.preventDefault(); run(t.dataset.cmd); }
    });

    /* toolbar */
    U.$$('#toolbar .tool[data-tool]').forEach(function (b) {
      b.addEventListener('click', function () {
        U.$$('#toolbar .tool').forEach(x => x.classList.toggle('on', x === b));
        PB.tools.setTool(b.dataset.tool);
        updateStatus();
      });
    });

    /* side switch */
    U.$$('.side-switch button').forEach(function (b) {
      b.addEventListener('click', function () { setSide(b.dataset.side); });
    });

    /* opacity */
    const op = U.$('#partOpacity');
    op.addEventListener('input', function () {
      S.setUI({ partOpacity: +op.value / 100 });
      U.$('#partOpacityOut').value = op.value + '%';
    });

    /* inspector tabs */
    U.$$('#inspTabs button').forEach(function (b) {
      b.addEventListener('click', function () { showTab(b.dataset.tab); });
    });

    /* library search */
    U.$('#libSearch').addEventListener('input', U.debounce(function (e) {
      libFilter = e.target.value; renderLibrary();
    }, 110));
    U.$('#netSearch').addEventListener('input', U.debounce(function (e) {
      netFilter = e.target.value; renderNets();
    }, 110));
    U.$('#netAddBtn').addEventListener('click', function () {
      prompt('New net name', '', function (name) {
        if (!name) return;
        S.edit('Add net', function () { S.doc.nets.push(PB.make.net(name)); });
        renderNets();
      });
    });

    /* wire option bar */
    U.$$('#wireModeSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        U.$$('#wireModeSeg button').forEach(x => x.classList.toggle('on', x === b));
        S.setUI({ wireMode: b.dataset.mode });
        PB.tools.refreshOverlay();
      });
    });
    const sw = U.$('#wireSwatches');
    WIRE_COLORS.forEach(function (c) {
      sw.appendChild(el('b' + (c === S.ui.wireColor ? '.on' : ''), {
        style: { background: c }, title: c,
        onclick: function () {
          S.setUI({ wireColor: c });
          U.$$('#wireSwatches b').forEach((x, i) => x.classList.toggle('on', WIRE_COLORS[i] === c));
        }
      }));
    });
    U.$('#wireGauge').addEventListener('change', function (e) { S.setUI({ wireGauge: +e.target.value }); });
    U.$('#wireAuto').addEventListener('change', function (e) { S.setUI({ wireAuto: e.target.checked }); });

    U.$('#drcLive').addEventListener('change', function (e) { liveDRC = e.target.checked; });

    /* redraw panels when things change */
    PB.bus.on('doc', U.debounce(function () { refreshTab(); updateStatus(); maybeDRC(); }, 60));
    PB.bus.on('sel', function () { if (activeTab === 'props') renderProps(); updateStatus(); });
    PB.bus.on('lib', function () { if (activeTab === 'library') renderLibrary(); });
    PB.bus.on('drc', function () { if (activeTab === 'checks') renderDRC(); });
    PB.bus.on('ui', function () {
      U.$('#wire-optbar').hidden = S.ui.tool !== 'wire';
      /* keep the chrome in step when state changes from anywhere else */
      const pct = Math.round(S.ui.partOpacity * 100);
      if (+op.value !== pct) { op.value = pct; U.$('#partOpacityOut').value = pct + '%'; }
      U.$$('.side-switch button').forEach(b => b.classList.toggle('on', b.dataset.side === S.ui.side));
      U.$$('#toolbar .tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === S.ui.tool));
      U.$$('#wireModeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.ui.wireMode));
      updateStatus();
    });
    PB.bus.on('stats', U.debounce(updateStatus, 80));

    showTab('library');
    updateStatus();
  }

  let liveDRC = true;
  const maybeDRC = U.debounce(function () { if (liveDRC) PB.nets.drc(); }, 450);

  PB.ui = {
    init, toast, modal, prompt, confirm, showTab, refreshTab, updateStatus,
    contextMenu, closeContext,
    run, deleteSel, rotateSel, mirrorSel, flipSideSel, nudgeSel, copySel, pasteSel,
    duplicate, finishPlacing,
    setSide, armPlace, closeTopModal, WIRE_COLORS, renderLibrary
  };
})();
