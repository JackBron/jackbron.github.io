/* ============================================================
   io.js — save / load / export / print
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const S = PB.state;
  const el = U.el;
  const AUTOSAVE = 'pbstudio.autosave.v1';

  /* ==================================================================
     Project files
     ================================================================== */
  function docName() {
    return (S.doc.meta.name || 'protoboard').replace(/[^\w .-]+/g, '_').trim() || 'protoboard';
  }

  function saveProject() {
    const json = JSON.stringify(S.doc, null, 2);
    U.download(docName() + '.pbstudio', json, 'application/json');
    S.ui.dirty = false;
    PB.ui.updateStatus();
    PB.ui.toast('Saved ' + docName() + '.pbstudio', 'good');
  }

  function openProject() {
    U.pickFile('.pbstudio,.json,application/json', function (file) {
      U.readText(file).then(function (txt) {
        let obj;
        try { obj = JSON.parse(txt); }
        catch (e) { PB.ui.toast('That file is not valid JSON', 'bad'); return; }
        if (Array.isArray(obj)) {                    // a part library, not a project
          const r = PB.parts.importDefs(obj);
          PB.ui.toast('Imported ' + r.added + ' part(s)', 'good');
          return;
        }
        if (obj.format && obj.format !== PB.FORMAT) {
          PB.ui.toast('Unrecognised file format', 'bad'); return;
        }
        S.load(obj, { name: file.name });
        PB.render.invalidateStatics();
        PB.view.fit();
        PB.ui.refreshTab();
        PB.ui.toast('Opened ' + file.name, 'good');
      });
    });
  }

  function newProject() {
    let colsEl, rowsEl, typeEl, pitchEl;
    const body = el('div', null, [
      el('div.field', null, [el('label', { text: 'Board type' }),
        typeEl = el('select', { style: { width: '100%' } },
          PB.board.BOARD_TYPES.map(t => el('option', { value: t.id, text: t.name })))]),
      el('div.field', null, [el('label', { text: 'Columns' }),
        colsEl = el('input', { type: 'number', value: 30, min: 2, max: 200, step: 1 })]),
      el('div.field', null, [el('label', { text: 'Rows' }),
        rowsEl = el('input', { type: 'number', value: 20, min: 2, max: 200, step: 1 })]),
      el('div.field', null, [el('label', { text: 'Pitch (mm)' }),
        pitchEl = el('input', { type: 'number', value: 2.54, min: 1, max: 10, step: 0.01 })]),
      el('p.hint', { text: 'Common sizes: 30×20 (80×50 mm), 24×18, 40×30, 50×40. Changeable later in the Board tab.' })
    ]);
    PB.ui.modal({
      title: 'New project', body: body, width: '420px',
      buttons: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: function () {
        const d = PB.newDoc();
        d.board.type = typeEl.value;
        d.board.cols = U.clamp(+colsEl.value || 30, 2, 300);
        d.board.rows = U.clamp(+rowsEl.value || 20, 2, 300);
        d.board.pitch = +pitchEl.value || 2.54;
        S.load(d);
        PB.render.invalidateStatics();
        PB.view.fit();
        PB.ui.refreshTab();
      } }]
    });
  }

  /* ==================================================================
     Part library files
     ================================================================== */
  function exportParts() {
    const list = PB.parts.userParts();
    if (!list.length) { PB.ui.toast('You have no custom parts to export yet', 'warn'); return; }
    U.download('protoboard-parts.json', JSON.stringify(list, null, 2), 'application/json');
    PB.ui.toast('Exported ' + list.length + ' custom part(s)', 'good');
  }

  function importParts() {
    U.pickFile('.json,application/json', function (file) {
      U.readText(file).then(function (txt) {
        let obj;
        try { obj = JSON.parse(txt); }
        catch (e) { PB.ui.toast('That file is not valid JSON', 'bad'); return; }
        const list = Array.isArray(obj) ? obj : (obj.parts || obj.library ? Object.values(obj.library || {}) : null);
        if (!list) { PB.ui.toast('No part definitions found in that file', 'bad'); return; }
        const r = PB.parts.importDefs(list);
        PB.ui.toast('Added ' + r.added + ', replaced ' + r.replaced, 'good');
      });
    });
  }

  /* ==================================================================
     Graphics export
     ================================================================== */
  function buildStandaloneSVG(opts) {
    opts = opts || {};
    const stage = PB.dom.stage;
    const size = PB.board.sizeMM();
    const pad = opts.pad === undefined ? 4 : opts.pad;
    const world = U.$('#world', stage);
    if (!world) return null;

    const out = document.createElementNS(U.SVGNS, 'svg');
    out.setAttribute('xmlns', U.SVGNS);
    out.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    out.setAttribute('viewBox', (-pad) + ' ' + (-pad) + ' ' + (size.w + pad * 2) + ' ' + (size.h + pad * 2));
    const scale = opts.scale || 8;
    out.setAttribute('width', U.round((size.w + pad * 2) * scale, 1));
    out.setAttribute('height', U.round((size.h + pad * 2) * scale, 1));

    const bg = document.createElementNS(U.SVGNS, 'rect');
    bg.setAttribute('x', -pad); bg.setAttribute('y', -pad);
    bg.setAttribute('width', size.w + pad * 2); bg.setAttribute('height', size.h + pad * 2);
    bg.setAttribute('fill', opts.bg || '#0e1013');
    out.appendChild(bg);

    const defs = U.$('defs', stage);
    if (defs) out.appendChild(defs.cloneNode(true));

    const clone = world.cloneNode(true);
    clone.removeAttribute('transform');
    // drop the interactive overlay
    U.$$('[data-layer="overlay"]', clone).forEach(n => n.remove());
    if (opts.hideRats) U.$$('[data-layer="rats"]', clone).forEach(n => n.remove());
    out.appendChild(clone);

    if (opts.title !== false) {
      const t = document.createElementNS(U.SVGNS, 'text');
      t.setAttribute('x', 0); t.setAttribute('y', size.h + pad - 0.6);
      t.setAttribute('font-size', 2.2);
      t.setAttribute('font-family', 'system-ui, sans-serif');
      t.setAttribute('fill', '#8b93a1');
      t.textContent = S.doc.meta.name + '  ·  ' + S.doc.board.cols + '×' + S.doc.board.rows +
        ' holes  ·  ' + U.round(size.w, 1) + '×' + U.round(size.h, 1) + ' mm';
      out.appendChild(t);
    }
    return out;
  }

  function svgText(node) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(node);
  }

  function exportSVG() {
    const node = buildStandaloneSVG({});
    if (!node) return;
    U.download(docName() + '.svg', svgText(node), 'image/svg+xml;charset=utf-8');
    PB.ui.toast('Exported SVG', 'good');
  }

  function exportPNG() {
    let scaleEl, bgEl;
    const body = el('div', null, [
      el('div.field', null, [el('label', { text: 'Pixels per mm' }),
        scaleEl = el('input', { type: 'number', value: 12, min: 2, max: 60, step: 1 })]),
      el('div.field', null, [el('label', { text: 'Background' }),
        bgEl = el('select', null, [
          el('option', { value: '#0e1013', text: 'Dark' }),
          el('option', { value: '#ffffff', text: 'White' }),
          el('option', { value: 'transparent', text: 'Transparent' })
        ])]),
      el('p.hint', { text: 'Matches what is on screen — see-through setting and active side included.' })
    ]);
    PB.ui.modal({
      title: 'Export PNG', body: body, width: '400px',
      buttons: [{ label: 'Cancel' }, { label: 'Export', primary: true, onClick: function () {
        renderPNG(+scaleEl.value || 12, bgEl.value);
      } }]
    });
  }

  function renderPNG(scale, bg) {
    const size = PB.board.sizeMM();
    const pad = 4;
    const node = buildStandaloneSVG({ scale: scale, bg: bg === 'transparent' ? 'none' : bg, pad: pad });
    if (!node) return;
    if (bg === 'transparent') { const r = node.querySelector('rect'); if (r) r.setAttribute('fill-opacity', 0); }
    const w = Math.round((size.w + pad * 2) * scale);
    const h = Math.round((size.h + pad * 2) * scale);
    const blob = new Blob([svgText(node)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = function () {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0, w, h);
      cv.toBlob(function (b) {
        URL.revokeObjectURL(url);
        if (!b) { PB.ui.toast('PNG export failed', 'bad'); return; }
        U.download(docName() + '.png', b);
        PB.ui.toast('Exported ' + w + '×' + h + ' PNG', 'good');
      }, 'image/png');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      PB.ui.toast('PNG export failed — try SVG instead', 'bad');
    };
    img.src = url;
  }

  /* ==================================================================
     Data export
     ================================================================== */
  function exportNetlist() {
    U.download(docName() + '.net', PB.nets.netlistText(), 'text/plain;charset=utf-8');
    PB.ui.toast('Exported netlist', 'good');
  }
  function exportBOM() {
    U.download(docName() + '-bom.csv', U.toCSV(PB.nets.bomRows()), 'text/csv;charset=utf-8');
    PB.ui.toast('Exported BOM', 'good');
  }
  function exportWireList() {
    U.download(docName() + '-wires.csv', U.toCSV(PB.nets.wireRows()), 'text/csv;charset=utf-8');
    PB.ui.toast('Exported wire cut-list', 'good');
  }

  /* ==================================================================
     Assembly build sheet (print)
     ================================================================== */
  function buildSheet() {
    const area = document.getElementById('print-area') || el('div#print-area');
    if (!area.parentNode) document.body.appendChild(area);
    U.clear(area);

    const t = PB.nets.totals();
    const size = PB.board.sizeMM();
    const bd = S.doc.board;

    area.appendChild(el('h1', { text: S.doc.meta.name }));
    area.appendChild(el('div', {
      text: bd.cols + ' × ' + bd.rows + ' holes · ' + U.round(size.w, 1) + ' × ' + U.round(size.h, 1) +
        ' mm · ' + (PB.board.BOARD_TYPES.find(x => x.id === bd.type) || {}).name +
        ' · ' + t.parts + ' parts · ' + t.wires + ' jumpers · ' +
        U.round(t.wireMM / 10, 1) + ' cm of wire · printed ' + new Date().toLocaleString()
    }));
    if (S.doc.meta.notes) area.appendChild(el('p', { text: S.doc.meta.notes }));

    /* the two sides as pictures */
    const wrap = el('div', { style: { display: 'flex', gap: '10px', marginTop: '10px', flexWrap: 'wrap' } });
    ['front', 'back'].forEach(function (side) {
      const savedSide = S.ui.side, savedFlip = S.ui.flipped, savedOp = S.ui.partOpacity;
      S.ui.side = side;
      S.ui.flipped = side === 'back';
      S.ui.partOpacity = 0.75;
      PB.render.draw();
      PB.bus.emit('ui');
      PB.render.draw();
      const node = buildStandaloneSVG({ bg: '#ffffff', title: false, scale: 6, hideRats: true });
      S.ui.side = savedSide; S.ui.flipped = savedFlip; S.ui.partOpacity = savedOp;
      PB.bus.emit('ui');
      PB.render.draw();
      if (!node) return;
      node.removeAttribute('width'); node.removeAttribute('height');
      node.setAttribute('style', 'width:48%;min-width:250px;border:1px solid #999');
      wrap.appendChild(el('div', { style: { flex: '1 1 45%' } }, [
        el('h2', { text: side === 'front' ? 'Front (component side)' : 'Back (solder side, mirrored)' }),
        node
      ]));
    });
    area.appendChild(wrap);

    /* parts */
    area.appendChild(el('h2', { text: 'Parts' }));
    area.appendChild(table(PB.nets.bomRows()));

    /* wires */
    area.appendChild(el('h2', { text: 'Jumper wires — cut list' }));
    const wr = PB.nets.wireRows();
    const head = wr[0];
    const tbl = el('table');
    tbl.appendChild(el('thead', null, [el('tr', null, head.map(h => el('th', { text: h })))]));
    const tb = el('tbody');
    wr.slice(1).forEach(function (row) {
      const tr = el('tr');
      row.forEach(function (cell, i) {
        if (i === 5) {
          tr.appendChild(el('td', null, [
            el('span.swatch', { style: { background: String(cell) } }),
            document.createTextNode(String(cell))
          ]));
        } else tr.appendChild(el('td', { text: String(cell) }));
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    area.appendChild(tbl);

    /* cuts */
    if (S.doc.cuts.length) {
      area.appendChild(el('h2', { text: 'Track cuts' }));
      const rows = [['#', 'Hole', 'Type', 'Direction']];
      S.doc.cuts.forEach(function (c, i) {
        rows.push([i + 1, PB.board.holeLabel(c.col, c.row),
          c.style === 'drill' ? 'drill out hole' : 'knife cut after this hole',
          c.axis === 'col' ? 'downwards' : 'to the right']);
      });
      area.appendChild(table(rows));
    }

    /* netlist */
    area.appendChild(el('h2', { text: 'Netlist' }));
    area.appendChild(el('pre', { text: PB.nets.netlistText(), style: { fontSize: '9px', whiteSpace: 'pre-wrap' } }));

    setTimeout(function () { window.print(); }, 120);
  }

  function table(rows) {
    const t = el('table');
    t.appendChild(el('thead', null, [el('tr', null, rows[0].map(h => el('th', { text: String(h) })))]));
    t.appendChild(el('tbody', null, rows.slice(1).map(r => el('tr', null, r.map(c => el('td', { text: String(c) }))))));
    return t;
  }

  /* ==================================================================
     Autosave
     ================================================================== */
  function saveNow() { U.store.set(AUTOSAVE, { at: Date.now(), doc: S.doc }); }
  const autosave = U.debounce(saveNow, 1200);

  function restoreAutosave() {
    const a = U.store.get(AUTOSAVE, null);
    if (!a || !a.doc) return false;
    const empty = !a.doc.parts.length && !a.doc.wires.length && !a.doc.cuts.length;
    if (empty) return false;
    S.load(a.doc);
    return new Date(a.at);
  }

  function clearAutosave() { U.store.del(AUTOSAVE); }

  PB.io = {
    saveProject, openProject, newProject, exportParts, importParts,
    exportSVG, exportPNG, exportNetlist, exportBOM, exportWireList, buildSheet,
    buildStandaloneSVG, svgText, autosave, saveNow, restoreAutosave, clearAutosave
  };
})();
