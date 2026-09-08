/* ============================================================
   main.js — bootstrap, keyboard, window plumbing
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const S = PB.state;

  PB.dom = {};

  function boot() {
    PB.dom.stage = U.$('#stage');
    PB.dom.rulerTop = U.$('#ruler-top');
    PB.dom.rulerLeft = U.$('#ruler-left');
    PB.dom.wrap = U.$('#canvas-wrap');

    PB.parts.loadUser();

    const restored = PB.io.restoreAutosave();
    if (!restored && !U.store.get('pbstudio.seen', false)) {
      S.load(exampleProject());
      U.store.set('pbstudio.seen', true);
    }

    PB.render.init(PB.dom.stage);
    PB.view.initRulers();
    PB.tools.init(PB.dom.stage);
    PB.ui.init();

    /* The stage can still be zero-sized on DOMContentLoaded (and inside
       preview panes it often is), so fit once it really has a size. */
    let fitted = false;
    function sync() {
      PB.view.resize();
      if (!fitted && PB.view.w > 30 && PB.view.h > 30) { fitted = true; PB.view.fit(); }
      PB.view.drawRulers();
      PB.render.schedule();
    }
    sync();
    requestAnimationFrame(sync);
    if (window.ResizeObserver) new ResizeObserver(sync).observe(PB.dom.wrap);
    window.addEventListener('resize', U.debounce(sync, 80));
    PB.view.refit = function () { fitted = false; sync(); };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', function (e) { PB.tools.onKeyUp(e); });

    PB.bus.on('doc', function () { PB.io.autosave(); });
    PB.bus.on('ui', function () { PB.io.autosave(); });

    window.addEventListener('pagehide', function () { PB.io.saveNow(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') PB.io.saveNow();
    });

    window.addEventListener('beforeunload', function (e) {
      PB.io.saveNow();
      if (!S.ui.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });

    PB.nets.drc();
    PB.ui.updateStatus();
    PB.io.saveNow();

    if (restored) {
      PB.ui.toast('Restored your last session (' + restored.toLocaleTimeString() + ')', 'good', 4000);
    }
  }

  /* ------------------------------------------------------------------
     Keyboard
     ------------------------------------------------------------------ */
  function typingInField(ev) {
    const t = ev.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  const TOOL_KEYS = { v: 'select', h: 'pan', p: 'place', w: 'wire', q: 'link',
    x: 'cut', o: 'holes', t: 'text', d: 'measure', e: 'erase' };

  function onKeyDown(ev) {
    if (ev.key === 'Escape' && PB.ui.closeTopModal()) { ev.preventDefault(); return; }
    if (typingInField(ev)) return;

    const ctrl = ev.ctrlKey || ev.metaKey;
    const k = ev.key;
    const lower = typeof k === 'string' ? k.toLowerCase() : '';

    /* let the active tool have first refusal */
    if (PB.tools.onKey(ev)) { ev.preventDefault(); return; }

    if (ctrl) {
      switch (lower) {
        case 'z': ev.preventDefault(); PB.ui.run(ev.shiftKey ? 'edit.redo' : 'edit.undo'); return;
        case 'y': ev.preventDefault(); PB.ui.run('edit.redo'); return;
        case 's': ev.preventDefault(); PB.ui.run('file.save'); return;
        case 'o': ev.preventDefault(); PB.ui.run('file.open'); return;
        case 'n': ev.preventDefault(); PB.ui.run('file.new'); return;
        case 'c': ev.preventDefault(); PB.ui.run('edit.copy'); return;
        case 'v': ev.preventDefault(); PB.ui.run('edit.paste'); return;
        case 'd': ev.preventDefault(); PB.ui.run('edit.duplicate'); return;
        case 'a': ev.preventDefault(); PB.ui.run('edit.selectAll'); return;
        case 'e': ev.preventDefault(); PB.ui.run('tools.drc'); return;
        case 'p': ev.preventDefault(); PB.ui.run('export.buildsheet'); return;
        case '0': ev.preventDefault(); PB.view.fit(); return;
      }
      return;
    }

    switch (k) {
      case 'Delete': case 'Backspace':
        ev.preventDefault(); PB.ui.run('edit.delete'); return;
      case 'ArrowLeft':  ev.preventDefault(); PB.ui.nudgeSel(ev.shiftKey ? -5 : -1, 0); return;
      case 'ArrowRight': ev.preventDefault(); PB.ui.nudgeSel(ev.shiftKey ? 5 : 1, 0); return;
      case 'ArrowUp':    ev.preventDefault(); PB.ui.nudgeSel(0, ev.shiftKey ? -5 : -1); return;
      case 'ArrowDown':  ev.preventDefault(); PB.ui.nudgeSel(0, ev.shiftKey ? 5 : 1); return;
      case '+': case '=': ev.preventDefault(); PB.view.zoomBy(1.25); return;
      case '-': case '_': ev.preventDefault(); PB.view.zoomBy(0.8); return;
      case '1': PB.ui.setSide('front'); return;
      case '2': PB.ui.setSide('back'); return;
      case '?': PB.ui.run('help.shortcuts'); return;
    }

    if (ev.altKey) return;

    if (lower === 'r') { ev.preventDefault(); PB.ui.rotateSel(ev.shiftKey ? 270 : 90); return; }
    if (lower === 'm') { ev.preventDefault(); PB.ui.mirrorSel(); return; }
    if (lower === 'f') { ev.preventDefault(); PB.ui.flipSideSel(); return; }
    if (lower === 'b') { ev.preventDefault(); PB.ui.run('view.flipBoard'); return; }
    if (lower === 'l') { ev.preventDefault(); PB.ui.run('view.toggleLabels'); return; }
    if (lower === 'n') { ev.preventDefault(); PB.ui.run('view.toggleRats'); return; }

    if (TOOL_KEYS[lower]) {
      ev.preventDefault();
      const tool = TOOL_KEYS[lower];
      PB.tools.setTool(tool);
      U.$$('#toolbar .tool').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
      PB.ui.updateStatus();
    }
  }

  /* ------------------------------------------------------------------
     A small worked example so the app opens with something real
     ------------------------------------------------------------------ */
  function exampleProject() {
    const d = PB.newDoc();
    d.meta.name = 'Example — Nano + OLED + sensor';
    d.meta.notes = 'A worked example: an Arduino Nano driving an I2C OLED and a BMP280, ' +
      'with the I2C bus and power routed on the back of a 34x22 perfboard.';
    d.board.cols = 34;
    d.board.rows = 22;
    d.board.type = 'perf';

    function place(defId, col, row, over) {
      const def = PB.parts.get(defId);
      if (!def) return null;
      d.library[defId] = U.deepClone(def);
      const p = Object.assign({
        id: U.uid('p'), def: defId, ref: '', value: '',
        col: col, row: row, rot: 0, mirror: false, side: 'front', locked: false
      }, over || {});
      p.ref = p.ref || U.nextDesignator(def.refPrefix || 'U', d.parts.map(x => x.ref));
      d.parts.push(p);
      return p;
    }

    const nano = place('nano-v3', 3, 7);
    const oled = place('oled-i2c-4', 24, 3);
    const bmp = place('bme280', 24, 16);
    const cap = place('cap-elec-2', 20, 10);
    const led = place('led-5mm', 20, 19);
    const res = place('r-axial-3', 16, 19);

    function pinHole(part, name) {
      const def = d.library[part.def];
      const pin = def.pins.find(p => p.name === name);
      return pin ? { c: part.col + pin.c, r: part.row + pin.r } : null;
    }

    function jumper(a, b, color, side, mode) {
      if (!a || !b) return;
      const pts = PB.router.elbow(a, b, mode || 'ortho', false);
      d.wires.push({
        id: U.uid('w'), side: side || 'back', mode: mode || 'ortho',
        pts: pts, color: color, gauge: 0.51, net: null, locked: false
      });
    }

    const RED = '#e04b4b', BLK = '#111417', BLU = '#4d7fe0', YEL = '#f2d13c', GRN = '#47c98a';

    // power
    jumper(pinHole(nano, '5V'), pinHole(oled, 'VCC'), RED);
    jumper(pinHole(nano, '5V'), pinHole(cap, '+'), RED);
    jumper(pinHole(cap, '-'), pinHole(nano, 'GND'), BLK);
    jumper(pinHole(oled, 'GND'), pinHole(nano, 'GND'), BLK);
    jumper(pinHole(bmp, 'VCC'), pinHole(oled, 'VCC'), RED);
    jumper(pinHole(bmp, 'GND'), pinHole(oled, 'GND'), BLK);

    // I2C bus
    jumper(pinHole(nano, 'A4'), pinHole(oled, 'SDA'), BLU);
    jumper(pinHole(nano, 'A5'), pinHole(oled, 'SCL'), YEL);
    jumper(pinHole(oled, 'SDA'), pinHole(bmp, 'SDA'), BLU);
    jumper(pinHole(oled, 'SCL'), pinHole(bmp, 'SCL'), YEL);

    // status LED on the front, any-angle to show the style off
    jumper(pinHole(nano, 'D9'), pinHole(res, '1'), GRN, 'front', 'diag');
    jumper(pinHole(res, '2'), pinHole(led, 'A'), GRN, 'front', 'ortho');
    jumper(pinHole(led, 'K'), pinHole(nano, 'GND'), BLK, 'front', 'ortho');

    d.texts.push({
      id: U.uid('t'), col: 2, row: 1, text: 'I2C sensor + display demo',
      size: 2.6, color: '#ffffff', side: 'front', rot: 0, anchor: 'start'
    });
    return d;
  }

  PB.exampleProject = exampleProject;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
