/* ============================================================
   model.js — document schema, application state, undo/redo, events
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;

  const FORMAT = 'protoboard-studio';
  const VERSION = 3;

  /* ------------------------------------------------------------------
     Default document
     ------------------------------------------------------------------ */
  function newBoard(over) {
    return Object.assign({
      cols: 30,
      rows: 20,
      pitch: 2.54,             // mm between holes
      type: 'perf',            // perf | strip | breadboard | padpair
      stripAxis: 'row',        // strip / padpair orientation
      /* Breadboard-style boards are described top-to-bottom as a stack of
         bands, which is how you read one off the real board.  See
         PB.board.BAND_KINDS. */
      bands: null,
      bb: { rails: 1, groupSize: 5, gutter: 2 },  // legacy, kept for migration
      margin: 3.0,             // mm of substrate beyond the outer hole ring
      color: '#1d6b45',
      padColor: '#d9ae42',
      copperColor: '#c98a3c',
      mountHoles: true,
      mountDia: 3.2,
      holeDia: 1.0,
      padDia: 1.9,
      /* "c,r" keys for holes this board simply does not have — the
         un-drilled gutter on a breadboard-style board, a cut-out, a
         corner someone snapped off.  Edited with the hole tool. */
      voids: []
    }, over || {});
  }

  function newDoc(over) {
    const now = new Date().toISOString();
    return Object.assign({
      format: FORMAT,
      version: VERSION,
      meta: { name: 'Untitled board', author: '', notes: '', created: now, modified: now, unit: 'mm' },
      board: newBoard(),
      library: {},   // project-embedded part definitions, keyed by def id
      parts: [],
      wires: [],
      rats: [],
      cuts: [],
      texts: [],
      nets: [
        { id: 'net_gnd', name: 'GND', color: '#2f3540', cls: 'power' },
        { id: 'net_vcc', name: '+5V', color: '#e04b4b', cls: 'power' },
        { id: 'net_3v3', name: '+3V3', color: '#e08a2f', cls: 'power' }
      ]
    }, over || {});
  }

  /* ------------------------------------------------------------------
     Event bus
     ------------------------------------------------------------------ */
  const bus = (function () {
    const map = {};
    let muted = 0;
    const pending = new Set();
    return {
      on(evt, fn) { (map[evt] = map[evt] || []).push(fn); return () => this.off(evt, fn); },
      off(evt, fn) { const a = map[evt]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
      emit(evt, payload) {
        if (muted) { pending.add(evt); return; }
        const a = map[evt];
        if (a) for (const fn of a.slice()) { try { fn(payload); } catch (e) { console.error('[' + evt + ']', e); } }
      },
      /** Batch several emits into one flush (avoids re-render storms). */
      batch(fn) {
        muted++;
        try { fn(); } finally {
          muted--;
          if (!muted) { const list = Array.from(pending); pending.clear(); list.forEach(e => bus.emit(e)); }
        }
      }
    };
  })();

  /* ------------------------------------------------------------------
     State
     ------------------------------------------------------------------ */
  const S = {
    doc: newDoc(),

    /* transient UI state (never saved with the document) */
    ui: {
      tool: 'select',
      side: 'front',          // side being edited
      flipped: false,         // viewing from the back (mirror X)
      partOpacity: 0.8,
      rubberBand: true,
      showLabels: true,
      showRulers: true,
      showRats: true,
      showHoleNums: false,
      showPinNames: 'auto',   // auto | always | never
      wireMode: 'ortho',      // ortho | diag | free
      wireColor: '#e04b4b',
      wireGauge: 0.51,
      wireAuto: true,
      placingDef: null,       // def id armed for the place tool
      placeRot: 0,
      snapToHoles: true,
      highlightNet: null,     // computed-net key to highlight
      unit: 'mm',
      dirty: false,
      filePath: null
    },

    sel: new Set(),           // "kind:id" strings
    clipboard: null,
    drc: [],

    /* ---------------- selection helpers ---------------- */
    selKey: (kind, id) => kind + ':' + id,
    isSel(kind, id) { return this.sel.has(kind + ':' + id); },
    selectOnly(list) {
      this.sel = new Set((list || []).map(o => o.kind + ':' + o.id));
      bus.emit('sel');
    },
    selectAdd(kind, id) { this.sel.add(kind + ':' + id); bus.emit('sel'); },
    selectToggle(kind, id) {
      const k = kind + ':' + id;
      if (this.sel.has(k)) this.sel.delete(k); else this.sel.add(k);
      bus.emit('sel');
    },
    selectNone() { if (this.sel.size) { this.sel.clear(); bus.emit('sel'); } },
    selection() {
      return Array.from(this.sel).map(k => {
        const i = k.indexOf(':');
        return { kind: k.slice(0, i), id: k.slice(i + 1) };
      });
    },
    selObjects() {
      const out = [];
      for (const s of this.selection()) {
        const o = this.find(s.kind, s.id);
        if (o) out.push({ kind: s.kind, id: s.id, obj: o });
      }
      return out;
    },
    /** Drop selection entries whose object no longer exists. */
    pruneSelection() {
      let changed = false;
      for (const k of Array.from(this.sel)) {
        const i = k.indexOf(':');
        if (!this.find(k.slice(0, i), k.slice(i + 1))) { this.sel.delete(k); changed = true; }
      }
      if (changed) bus.emit('sel');
    },

    /* ---------------- object lookup ---------------- */
    listOf(kind) {
      switch (kind) {
        case 'part': return this.doc.parts;
        case 'wire': return this.doc.wires;
        case 'rat':  return this.doc.rats;
        case 'cut':  return this.doc.cuts;
        case 'text': return this.doc.texts;
        case 'net':  return this.doc.nets;
        default: return [];
      }
    },
    find(kind, id) { return this.listOf(kind).find(o => o.id === id) || null; },
    remove(kind, id) {
      const a = this.listOf(kind);
      const i = a.findIndex(o => o.id === id);
      if (i >= 0) { a.splice(i, 1); return true; }
      return false;
    },
    net(id) { return this.doc.nets.find(n => n.id === id) || null; },
    netColor(id, fallback) {
      const n = this.net(id);
      return n ? n.color : (fallback || null);
    },

    /* ---------------- part definitions ----------------
       Project-embedded defs win, then the user library, then built-ins. */
    def(defId) {
      return this.doc.library[defId] || PB.parts.get(defId) || null;
    },
    /** Make sure a def used by a placed part is embedded in the document. */
    embedDef(defId) {
      if (this.doc.library[defId]) return this.doc.library[defId];
      const d = PB.parts.get(defId);
      if (d) this.doc.library[defId] = U.deepClone(d);
      return this.doc.library[defId] || null;
    },

    /* ---------------- undo / redo ----------------
       Snapshot-based: simple, always correct, and a protoboard document is
       tiny enough (tens of KB) that the memory cost is irrelevant. */
    _undo: [],
    _redo: [],
    _txn: null,
    LIMIT: 120,

    snapshot() { return JSON.stringify(this.doc); },

    /** Open a multi-step edit (drag, marquee-move, …). */
    begin(label) {
      if (this._txn) return;                      // nested begin: ignore
      this._txn = { label: label || 'Edit', snap: this.snapshot() };
    },
    /** Close it, pushing one undo entry if anything actually changed. */
    commit() {
      if (!this._txn) return false;
      const t = this._txn; this._txn = null;
      if (t.snap === this.snapshot()) return false;
      this._undo.push(t);
      if (this._undo.length > this.LIMIT) this._undo.shift();
      this._redo.length = 0;
      this.touch();
      return true;
    },
    abort() {
      if (!this._txn) return;
      const t = this._txn; this._txn = null;
      this.doc = JSON.parse(t.snap);
      this.pruneSelection();
      bus.emit('doc');
    },
    /** One-shot edit: S.edit('Delete part', () => {...}) */
    edit(label, fn) {
      this.begin(label);
      let r;
      try { r = fn(); }
      catch (e) { this.abort(); throw e; }
      this.commit();
      bus.emit('doc');
      return r;
    },
    undo() {
      if (this._txn) this.abort();
      const t = this._undo.pop();
      if (!t) return false;
      this._redo.push({ label: t.label, snap: this.snapshot() });
      this.doc = JSON.parse(t.snap);
      this.pruneSelection();
      this.touch();
      bus.emit('doc');
      return t.label;
    },
    redo() {
      const t = this._redo.pop();
      if (!t) return false;
      this._undo.push({ label: t.label, snap: this.snapshot() });
      this.doc = JSON.parse(t.snap);
      this.pruneSelection();
      this.touch();
      bus.emit('doc');
      return t.label;
    },
    canUndo() { return this._undo.length > 0; },
    canRedo() { return this._redo.length > 0; },
    undoLabel() { const t = this._undo[this._undo.length - 1]; return t ? t.label : null; },

    touch() {
      this.doc.meta.modified = new Date().toISOString();
      this.ui.dirty = true;
    },

    /** Replace the whole document (open / new). */
    load(doc, opts) {
      this.doc = migrate(doc);
      this._undo.length = 0; this._redo.length = 0; this._txn = null;
      this.sel.clear();
      this.ui.dirty = false;
      this.ui.highlightNet = null;
      if (opts && opts.name) this.ui.filePath = opts.name;
      bus.batch(() => { bus.emit('doc'); bus.emit('sel'); bus.emit('lib'); });
    },

    setUI(patch) {
      Object.assign(this.ui, patch);
      bus.emit('ui');
    }
  };

  /* ------------------------------------------------------------------
     Migration — keeps older saved files loadable
     ------------------------------------------------------------------ */
  function migrate(raw) {
    const d = Object.assign(newDoc(), raw || {});
    d.format = FORMAT;
    d.meta = Object.assign(newDoc().meta, raw && raw.meta);
    d.board = Object.assign(newBoard(), raw && raw.board);
    d.board.bb = Object.assign({ rails: 1, groupSize: 5, gutter: 2 }, d.board.bb);
    /* A breadboard saved before bands existed keeps exactly the layout it
       had: the old algorithm is replayed once and frozen into bands. */
    if (PB.board && d.board.type === 'breadboard' && !Array.isArray(d.board.bands)) {
      d.board.bands = PB.board.bandsFromLegacy(d.board);
    }
    if (PB.board && Array.isArray(d.board.bands) && d.board.bands.length) {
      d.board.rows = PB.board.bandRows(d.board) || d.board.rows;
    } else if (!Array.isArray(d.board.bands) || !d.board.bands.length) {
      d.board.bands = null;
    }
    if (!Array.isArray(d.board.voids)) d.board.voids = [];
    d.board.voids = d.board.voids.filter(k => /^\d+,\d+$/.test(String(k)));
    d.library = d.library || {};
    ['parts', 'wires', 'rats', 'cuts', 'texts', 'nets'].forEach(k => { if (!Array.isArray(d[k])) d[k] = []; });

    // v1 stored wire points as [col,row] pairs
    d.wires.forEach(w => {
      if (Array.isArray(w.pts) && w.pts.length && Array.isArray(w.pts[0])) {
        w.pts = w.pts.map(p => ({ c: p[0], r: p[1] }));
      }
      if (!w.mode) w.mode = 'ortho';
      if (!w.side) w.side = 'front';
      if (w.gauge === undefined) w.gauge = 0.51;
      if (!w.color) w.color = '#e04b4b';
      if (!w.id) w.id = U.uid('w');
    });
    d.parts.forEach(p => {
      if (!p.id) p.id = U.uid('p');
      if (p.rot === undefined) p.rot = 0;
      if (!p.side) p.side = 'front';
      if (p.mirror === undefined) p.mirror = false;
    });
    d.cuts.forEach(c => { if (!c.id) c.id = U.uid('c'); if (!c.style) c.style = 'knife'; });
    d.texts.forEach(t => { if (!t.id) t.id = U.uid('t'); if (!t.size) t.size = 2.2; });
    d.rats.forEach(r => { if (!r.id) r.id = U.uid('n'); });
    d.version = VERSION;
    return d;
  }

  /* ------------------------------------------------------------------
     Constructors used by the tools
     ------------------------------------------------------------------ */
  const make = {
    part(defId, col, row, over) {
      const def = S.def(defId) || PB.parts.get(defId);
      const prefix = (def && def.refPrefix) || 'U';
      const used = S.doc.parts.map(p => p.ref);
      return Object.assign({
        id: U.uid('p'),
        def: defId,
        ref: U.nextDesignator(prefix, used),
        value: (def && def.defaultValue) || '',
        col: col, row: row,
        rot: 0,
        mirror: false,
        side: 'front',
        locked: false
      }, over || {});
    },
    wire(pts, over) {
      return Object.assign({
        id: U.uid('w'),
        side: S.ui.side,
        mode: S.ui.wireMode,
        pts: pts.map(p => ({ c: p.c, r: p.r })),
        color: S.ui.wireColor,
        gauge: S.ui.wireGauge,
        net: null,
        locked: false
      }, over || {});
    },
    rat(a, b, over) {
      return Object.assign({ id: U.uid('n'), a: a, b: b, net: null }, over || {});
    },
    cut(col, row, axis, style) {
      return { id: U.uid('c'), col: col, row: row, axis: axis || S.doc.board.stripAxis, style: style || 'knife' };
    },
    text(col, row, str) {
      return {
        id: U.uid('t'), col: col, row: row, text: str || 'Text',
        size: 2.4, color: '#ffffff', side: S.ui.side, rot: 0, anchor: 'start'
      };
    },
    net(name, color) {
      return { id: U.uid('net'), name: name, color: color || U.hashColor(name), cls: 'signal' };
    }
  };

  PB.FORMAT = FORMAT;
  PB.VERSION = VERSION;
  PB.state = S;
  PB.bus = bus;
  PB.make = make;
  PB.newDoc = newDoc;
  PB.newBoard = newBoard;
  PB.migrate = migrate;
})();
