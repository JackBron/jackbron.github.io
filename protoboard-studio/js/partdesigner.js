/* ============================================================
   partdesigner.js — visual editor for breakout-board footprints
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const el = U.el;
  const sv = U.svg;

  const SHAPES = [
    ['rounded', 'Module (rounded)'], ['rect', 'Plain rectangle'], ['dip', 'DIP body'],
    ['header', 'Pin header'], ['axial', 'Axial (resistor)'], ['led', 'LED'],
    ['disc', 'Disc'], ['radial', 'Radial / round'], ['to92', 'TO-92'], ['to220', 'TO-220'],
    ['screw', 'Screw terminal'], ['tact', 'Tact switch'], ['circle', 'Circle']
  ];
  const TYPES = ['io', 'pwr', 'gnd', 'analog', 'clk', 'data', 'nc'];

  const MM = 2.54;     // body art is drawn in mm, then scaled to hole units

  let D = null;        // definition being edited
  let mode = 'pin';    // pin | erase | body
  let selPin = null;
  let host, canvas, sideEl, dlg, svgNode;
  let dragBody = null;
  let dragPin = null;
  let frozenBounds = null;   // held steady for the duration of a drag

  /* ------------------------------------------------------------------ */
  function open(defId) {
    const src = defId ? PB.parts.get(defId) : null;
    D = src ? PB.parts.normalise(U.deepClone(src)) : blank();
    if (src && src.builtin) {
      D.id = U.uid('def');
      D.name = src.name + ' (copy)';
      D.category = 'Custom';
    }
    selPin = null;
    mode = 'pin';
    dragBody = null; dragPin = null; frozenBounds = null; svgNode = null;

    const body = el('div');
    dlg = PB.ui.modal({
      title: src ? 'Part Designer' : 'Part Designer — new part',
      sub: src && src.builtin ? 'built-in parts are copied, never overwritten' : '',
      body: body, width: 'min(94vw, 1120px)', resizable: true,
      buttons: [
        { label: 'Export JSON', onClick: function () { exportOne(); return false; } },
        { label: 'Cancel' },
        { label: 'Save to library', primary: true, onClick: save }
      ]
    });
    buildUI(body);
    redraw();
  }

  function blank() {
    return PB.parts.normalise({
      id: U.uid('def'), name: 'New part', category: 'Custom', refPrefix: 'U',
      color: '#2b5f8a', shape: 'rounded', w: 4, h: 3, ox: -0.5, oy: -0.5, pins: []
    });
  }

  /* ------------------------------------------------------------------ */
  function buildUI(body) {
    host = el('div.pd-wrap');
    canvas = el('div.pd-canvas');
    sideEl = el('div.pd-side');
    host.appendChild(canvas);
    host.appendChild(sideEl);
    body.appendChild(host);

    /* One <svg> for the life of the dialog.  Rebuilding it on every redraw
       tore the element out from under an in-flight drag, which killed the
       pointer capture and stranded the gesture. */
    svgNode = sv('svg', { preserveAspectRatio: 'xMidYMid meet' });
    svgNode.addEventListener('pointerdown', onDown);
    svgNode.addEventListener('pointermove', onMove);
    svgNode.addEventListener('pointerup', onUp);
    svgNode.addEventListener('pointercancel', onUp);
    canvas.appendChild(svgNode);

    canvas.appendChild(el('div.pd-mode', null, [
      seg([['pin', 'Pins'], ['erase', 'Erase'], ['body', 'Body']], function (v) { mode = v; redraw(); })
    ]));
    canvas.appendChild(el('div.pd-tip', {
      text: 'click a hole to add a pin  ·  drag to move  ·  '
        + 'Body mode drags the outline'
    }));
  }

  function seg(items, onPick) {
    const box = el('div.seg');
    items.forEach(function (it) {
      box.appendChild(el('button' + (it[0] === mode ? '.on' : ''), {
        text: it[1], dataset: { v: it[0] },
        onclick: function () {
          U.$$('button', box).forEach(b => b.classList.toggle('on', b.dataset.v === it[0]));
          onPick(it[0]);
        }
      }));
    });
    return box;
  }

  /* ------------------------------------------------------------------
     Canvas
     ------------------------------------------------------------------ */
  function gridBounds() {
    if (frozenBounds) return frozenBounds;
    const b = PB.parts.defBounds(D);
    const pad = 2;
    let x0 = Math.floor(Math.min(b.x, -1)) - pad, x1 = Math.ceil(Math.max(b.x + b.w, 1)) + pad;
    let y0 = Math.floor(Math.min(b.y, -1)) - pad, y1 = Math.ceil(Math.max(b.y + b.h, 1)) + pad;
    if (x1 - x0 < 10) { const g = (10 - (x1 - x0)) / 2; x0 -= Math.floor(g); x1 += Math.ceil(g); }
    if (y1 - y0 < 8) { const g = (8 - (y1 - y0)) / 2; y0 -= Math.floor(g); y1 += Math.ceil(g); }
    return { x0, y0, x1, y1 };
  }

  function redraw() {
    drawCanvas();
    drawSide();
  }

  function drawCanvas() {
    if (!svgNode) return;
    const g = gridBounds();
    const W = g.x1 - g.x0, H = g.y1 - g.y0;
    const s = U.clear(svgNode);
    s.setAttribute('viewBox', g.x0 + ' ' + g.y0 + ' ' + W + ' ' + H);

    // grid dots
    const dots = [];
    for (let r = g.y0; r <= g.y1; r++) {
      for (let c = g.x0; c <= g.x1; c++) {
        dots.push('M' + (c - 0.07) + ' ' + r + 'a0.07 0.07 0 1 0 0.14 0a0.07 0.07 0 1 0 -0.14 0z');
      }
    }
    s.appendChild(sv('path', { d: dots.join(''), fill: '#4a5160' }));

    // origin cross
    s.appendChild(sv('path', {
      d: 'M-0.45 0H0.45M0 -0.45V0.45', stroke: '#ffe066', 'stroke-width': 0.06, opacity: 0.8
    }));

    /* the actual body artwork, so the Shape dropdown previews for real.
       bodyArt() works in mm, so scale it back into hole units. */
    const art = PB.render.bodyArt(D, MM);
    art.setAttribute('transform', 'scale(' + (1 / MM) + ')');
    s.appendChild(art);
    // faint outline of the declared footprint, which can differ from the art
    s.appendChild(sv('rect', {
      x: D.ox, y: D.oy, width: D.w, height: D.h, rx: 0.08,
      fill: 'none', stroke: '#ffffff', 'stroke-width': 0.035,
      'stroke-opacity': 0.4, 'stroke-dasharray': '0.18 0.14'
    }));

    // pins
    D.pins.forEach(function (p, i) {
      const on = selPin === i;
      s.appendChild(sv('circle', {
        cx: p.c, cy: p.r, r: 0.32, fill: PB.parts.pinColor(p.type),
        stroke: on ? '#ffe066' : '#05070a', 'stroke-width': on ? 0.1 : 0.05,
        style: { cursor: mode === 'erase' ? 'crosshair' : 'move' }
      }));
      if (on) {
        s.appendChild(sv('circle', {
          cx: p.c, cy: p.r, r: 0.46, fill: 'none',
          stroke: '#ffe066', 'stroke-width': 0.05, 'stroke-opacity': 0.7,
          'pointer-events': 'none'
        }));
      }
      const t = sv('text', {
        x: p.c, y: p.r, 'font-size': 0.3, fill: '#05070a', 'text-anchor': 'middle',
        'dominant-baseline': 'central', 'font-family': 'ui-monospace, monospace', 'font-weight': 700
      });
      t.textContent = p.n;
      s.appendChild(t);
      // names run bottom-to-top so long ones never collide with a neighbour
      const nm = sv('text', {
        x: p.c + 0.5, y: p.r, 'font-size': 0.3, fill: '#dfe4ec', 'text-anchor': 'start',
        'font-family': 'ui-monospace, monospace', 'dominant-baseline': 'central',
        transform: 'rotate(-90 ' + p.c + ' ' + p.r + ')'
      });
      nm.textContent = p.name;
      s.appendChild(nm);
    });

  }

  /**
   * Client point -> hole coordinate.  Returns null when the canvas has no
   * usable size (a collapsed or hidden dialog), because dividing by a zero
   * scale would otherwise write NaN straight into the pin list.
   */
  function toHole(ev, svgEl, snapHalf) {
    const pt = svgEl.getBoundingClientRect();
    const g = gridBounds();
    const W = g.x1 - g.x0, H = g.y1 - g.y0;
    if (!(pt.width > 0) || !(pt.height > 0) || !(W > 0) || !(H > 0)) return null;
    // preserveAspectRatio meet -> uniform scale, centred
    const k = Math.min(pt.width / W, pt.height / H);
    if (!(k > 0)) return null;
    const ox = pt.left + (pt.width - W * k) / 2;
    const oy = pt.top + (pt.height - H * k) / 2;
    const x = (ev.clientX - ox) / k + g.x0;
    const y = (ev.clientY - oy) / k + g.y0;
    if (!isFinite(x) || !isFinite(y)) return null;
    const f = snapHalf ? 2 : 1;
    return { c: Math.round(x * f) / f, r: Math.round(y * f) / f, rawC: x, rawR: y };
  }

  function onDown(ev) {
    const s = svgNode;
    try { s.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointer */ }
    /* hold the viewBox steady so the drag does not chase a re-fitting grid */
    frozenBounds = gridBounds();

    if (mode === 'body') {
      const a = toHole(ev, s, true);
      if (!a) { frozenBounds = null; return; }
      dragBody = { a: a, b: a };
      return;
    }

    const h = toHole(ev, s, false);
    if (!h) { frozenBounds = null; return; }
    const idx = D.pins.findIndex(function (p) { return p.c === h.c && p.r === h.r; });

    if (mode === 'erase') {
      frozenBounds = null;
      if (idx >= 0) { D.pins.splice(idx, 1); renumber(); selPin = null; redraw(); }
      return;
    }

    if (idx >= 0) {                       // select, and start dragging it
      selPin = idx;
      dragPin = { index: idx, from: { c: h.c, r: h.r }, moved: false };
      redraw();
      return;
    }

    /* new pin — and you can keep the button down to drag it into place */
    D.pins.push({ n: String(D.pins.length + 1), name: String(D.pins.length + 1), c: h.c, r: h.r, type: 'io' });
    selPin = D.pins.length - 1;
    dragPin = { index: selPin, from: { c: h.c, r: h.r }, moved: false, fresh: true };
    growBodyToFit();
    redraw();
  }

  function onMove(ev) {
    if (dragBody) {
      const b = toHole(ev, svgNode, true);
      if (!b) return;
      dragBody.b = b;
      applyDragBody();
      drawCanvas();
      return;
    }
    if (dragPin) {
      const pin = D.pins[dragPin.index];
      if (!pin) { dragPin = null; return; }
      const h = toHole(ev, svgNode, false);
      if (!h) return;
      if (pin.c === h.c && pin.r === h.r) return;
      // one pin per hole
      const clash = D.pins.some(function (q, i) { return i !== dragPin.index && q.c === h.c && q.r === h.r; });
      if (clash) return;
      pin.c = h.c; pin.r = h.r;
      dragPin.moved = true;
      drawCanvas();
    }
  }

  function onUp() {
    const wasBody = !!dragBody;
    const movedPin = dragPin && dragPin.moved;
    dragBody = null;
    dragPin = null;
    frozenBounds = null;
    if (movedPin) growBodyToFit();
    if (wasBody || movedPin) redraw(); else drawSide();
  }

  function applyDragBody() {
    const a = dragBody.a, b = dragBody.b;
    const x = Math.min(a.c, b.c), y = Math.min(a.r, b.r);
    const w = Math.abs(b.c - a.c), h = Math.abs(b.r - a.r);
    if (w < 0.4 || h < 0.4) return;
    D.ox = x; D.oy = y; D.w = w; D.h = h;
  }

  function growBodyToFit() {
    if (!D.pins.length) return;
    const cs = D.pins.map(p => p.c), rs = D.pins.map(p => p.r);
    const x0 = Math.min.apply(null, cs) - 0.5, x1 = Math.max.apply(null, cs) + 0.5;
    const y0 = Math.min.apply(null, rs) - 0.5, y1 = Math.max.apply(null, rs) + 0.5;
    if (D.ox > x0) { D.w += D.ox - x0; D.ox = x0; }
    if (D.oy > y0) { D.h += D.oy - y0; D.oy = y0; }
    if (D.ox + D.w < x1) D.w = x1 - D.ox;
    if (D.oy + D.h < y1) D.h = y1 - D.oy;
  }

  function renumber() {
    D.pins.forEach(function (p, i) {
      if (/^\d+$/.test(p.n)) p.n = String(i + 1);
    });
  }

  /* ------------------------------------------------------------------
     Side panel
     ------------------------------------------------------------------ */
  function drawSide() {
    const s = U.clear(sideEl);
    const f = (label, ctrl) => el('div.field', null, [el('label', { text: label }), ctrl]);

    s.appendChild(el('div.sect', null, [
      el('h4', { text: 'Identity' }),
      f('Name', el('input', { type: 'text', value: D.name, onchange: e => { D.name = e.target.value; } })),
      f('Category', categoryField()),
      f('Ref prefix', el('input', { type: 'text', value: D.refPrefix, onchange: e => { D.refPrefix = e.target.value; } })),
      f('Description', el('input', { type: 'text', value: D.desc, onchange: e => { D.desc = e.target.value; } })),
      f('Tags', el('input', {
        type: 'text', value: (D.tags || []).join(' '),
        onchange: e => { D.tags = e.target.value.split(/\s+/).filter(Boolean); }
      }))
    ]));

    s.appendChild(el('div.sect', null, [
      el('h4', { text: 'Body' }),
      f('Shape', el('select', { value: D.shape, onchange: e => { D.shape = e.target.value; redraw(); } },
        SHAPES.map(x => el('option', { value: x[0], text: x[1] })))),
      f('Colour', el('input', { type: 'color', value: D.color, onchange: e => { D.color = e.target.value; redraw(); } })),
      f('Width', numF('w')), f('Height', numF('h')),
      f('Offset X', numF('ox')), f('Offset Y', numF('oy')),
      el('div.row', null, [
        el('button.mini', { text: 'Fit to pins', onclick: function () { fitBody(); redraw(); } }),
        el('button.mini', { text: 'Centre origin', onclick: function () { centreOrigin(); redraw(); } })
      ])
    ]));

    s.appendChild(el('div.sect', null, [
      el('h4', { text: 'Add pins quickly' }),
      el('div.row', null, [
        el('button.mini', { text: 'Single row…', onclick: () => addRow(false) }),
        el('button.mini', { text: 'Dual row…', onclick: () => addRow(true) }),
        el('button.mini.danger', { text: 'Clear pins', onclick: function () { D.pins = []; redraw(); } })
      ]),
      el('p.hint', { text: 'Space- or comma-separated pin names, e.g. "GND VCC SCL SDA".' })
    ]));

    s.appendChild(el('div.sect', null, [
      el('h4', { text: 'Pins (' + D.pins.length + ')' }),
      pinTable()
    ]));

    if (selPin !== null && D.pins[selPin]) {
      const p = D.pins[selPin];
      s.appendChild(el('div.sect', null, [
        el('h4', { text: 'Selected pin' }),
        f('Number', el('input', { type: 'text', value: p.n, onchange: e => { p.n = e.target.value; redraw(); } })),
        f('Name', el('input', { type: 'text', value: p.name, onchange: e => { p.name = e.target.value; redraw(); } })),
        f('Type', el('select', { value: p.type, onchange: e => { p.type = e.target.value; redraw(); } },
          TYPES.map(t => el('option', { value: t, text: t })))),
        f('Col / Row', el('div.row', null, [
          el('input', { type: 'number', value: p.c, step: 1, style: { width: '58px' },
            onchange: e => { p.c = Math.round(+e.target.value); redraw(); } }),
          el('input', { type: 'number', value: p.r, step: 1, style: { width: '58px' },
            onchange: e => { p.r = Math.round(+e.target.value); redraw(); } })
        ])),
        el('div.row', null, [el('button.mini.danger', {
          text: 'Remove pin', onclick: function () { D.pins.splice(selPin, 1); selPin = null; renumber(); redraw(); }
        })])
      ]));
    }

    function numF(key) {
      return el('input', {
        type: 'number', value: D[key], step: 0.5,
        onchange: e => { D[key] = +e.target.value; redraw(); }
      });
    }
  }

  /**
   * Category picker: every category already in the library, plus an entry
   * for inventing a new one.
   */
  const NEW_CAT = '__new__';

  function categoryField() {
    const cats = Array.from(new Set(
      PB.parts.all().map(function (d) { return d.category || 'Misc'; })
        .concat(['Custom', D.category || 'Custom'])
    )).filter(Boolean).sort(function (a, b) { return a.localeCompare(b); });

    return el('select', {
      value: D.category,
      onchange: function (e) {
        if (e.target.value === NEW_CAT) {
          e.target.value = D.category;                 // don't leave it on the sentinel
          PB.ui.prompt('New category name', '', function (v) {
            v = String(v || '').trim();
            if (v) { D.category = v; redraw(); }
          });
          return;
        }
        D.category = e.target.value;
      }
    }, cats.map(function (c) { return el('option', { value: c, text: c }); })
        .concat([el('option', { value: NEW_CAT, text: '\uff0b  New category\u2026' })]));
  }

  function pinTable() {
    const rows = D.pins.map(function (p, i) {
      return el('tr', {
        style: { cursor: 'pointer', background: selPin === i ? '#2f7fd6' : '' },
        onclick: function () { selPin = i; redraw(); }
      }, [
        el('td.pn', { text: p.n }),
        el('td', { text: p.name }),
        el('td.pn', { text: p.c + ',' + p.r }),
        el('td.pn', { text: p.type })
      ]);
    });
    return el('div.pinlist', null, [el('table', null, [
      el('thead', null, [el('tr', null, [el('th', { text: '#' }), el('th', { text: 'Name' }),
        el('th', { text: 'c,r' }), el('th', { text: 'Type' })])]),
      el('tbody', null, rows)
    ])]);
  }

  function fitBody() {
    if (!D.pins.length) return;
    const cs = D.pins.map(p => p.c), rs = D.pins.map(p => p.r);
    D.ox = Math.min.apply(null, cs) - 0.5;
    D.oy = Math.min.apply(null, rs) - 0.5;
    D.w = (Math.max.apply(null, cs) + 0.5) - D.ox;
    D.h = (Math.max.apply(null, rs) + 0.5) - D.oy;
  }

  function centreOrigin() {
    if (!D.pins.length) return;
    const c0 = Math.min.apply(null, D.pins.map(p => p.c));
    const r0 = Math.min.apply(null, D.pins.map(p => p.r));
    D.pins.forEach(function (p) { p.c -= c0; p.r -= r0; });
    D.ox -= c0; D.oy -= r0;
  }

  function addRow(dual) {
    let namesEl, gapEl, startC, startR;
    const body = el('div', null, [
      el('div.field-wide', null, [
        el('label', { text: dual ? 'Left-hand row names (top to bottom / left to right)' : 'Pin names' }),
        namesEl = el('input', { type: 'text', style: { width: '100%' }, placeholder: 'GND VCC SCL SDA' })
      ]),
      dual ? el('div.field-wide', null, [
        el('label', { text: 'Right-hand row names' }),
        gapEl = el('input', { type: 'text', style: { width: '100%' }, placeholder: 'D0 D1 D2 D3' })
      ]) : null,
      el('div.field', null, [el('label', { text: 'Start col / row' }), el('div.row', null, [
        startC = el('input', { type: 'number', value: 0, step: 1, style: { width: '60px' } }),
        startR = el('input', { type: 'number', value: 0, step: 1, style: { width: '60px' } })
      ])]),
      dual ? el('div.field', null, [el('label', { text: 'Row spacing (holes)' }),
        el('input', { type: 'number', value: 6, step: 1, min: 1, id: 'pdGap', style: { width: '60px' } })]) : null
    ]);
    PB.ui.modal({
      title: dual ? 'Add a dual row' : 'Add a row of pins', body: body, width: '460px',
      buttons: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: function (b) {
        const gap = dual ? (+U.$('#pdGap', b).value || 6) : 0;
        const c0 = +startC.value || 0, r0 = +startR.value || 0;
        split(namesEl.value).forEach(function (nm, i) { pushPin(nm, c0 + i, r0); });
        if (dual && gapEl) split(gapEl.value).forEach(function (nm, i) { pushPin(nm, c0 + i, r0 + gap); });
        renumber(); fitBody(); redraw();
      } }]
    });
    setTimeout(() => namesEl.focus(), 30);
  }

  function split(s) { return String(s || '').split(/[\s,]+/).filter(Boolean); }

  function pushPin(name, c, r) {
    const i = D.pins.findIndex(p => p.c === c && p.r === r);
    const pin = { n: String(D.pins.length + 1), name: name, c: c, r: r, type: guess(name) };
    if (i >= 0) D.pins[i] = Object.assign(D.pins[i], { name: name, type: pin.type });
    else D.pins.push(pin);
  }

  function guess(name) {
    const s = String(name).toUpperCase();
    if (/^(GND|VSS|AGND|DGND|0V|-)$/.test(s)) return 'gnd';
    if (/^(VCC|VDD|VIN|5V|3V3|3\.3V|\+.*|V\+|RAW|VBUS|VBAT)$/.test(s)) return 'pwr';
    if (/^(A\d|AREF|ADC.*)$/.test(s)) return 'analog';
    if (/^(SCL|SCK|CLK)$/.test(s)) return 'clk';
    if (/^(SDA|MOSI|MISO|TX|RX|DATA|DIO)$/.test(s)) return 'data';
    if (/^(NC)$/.test(s)) return 'nc';
    return 'io';
  }

  /* ------------------------------------------------------------------ */
  function save() {
    if (!D.name.trim()) { PB.ui.toast('Give the part a name first', 'warn'); return false; }
    if (!D.pins.length) { PB.ui.toast('A part needs at least one pin', 'warn'); return false; }
    const saved = PB.parts.upsertUser(D);
    // refresh any placed instances that embed this definition
    const doc = PB.state.doc;
    if (doc.library[saved.id]) {
      PB.state.edit('Update part definition', function () { doc.library[saved.id] = U.deepClone(saved); });
    }
    PB.nets.invalidate();
    PB.board.invalidate();
    PB.render.invalidateStatics();
    PB.render.markContent();
    PB.ui.toast('Saved "' + saved.name + '" to your library', 'good');
    PB.ui.showTab('library');
    PB.ui.armPlace(saved.id);
    return true;
  }

  function exportOne() {
    U.download(safeName(D.name) + '.part.json', JSON.stringify([D], null, 2), 'application/json');
  }
  function safeName(s) { return String(s).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'part'; }

  PB.partDesigner = { open };
})();
