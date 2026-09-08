/* ============================================================
   view.js — pan / zoom camera and the rulers
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const S = PB.state;

  const V = {
    scale: 8,        // screen px per mm
    tx: 40,          // px offset
    ty: 40,
    minScale: 0.8,
    maxScale: 90,
    w: 100, h: 100,  // viewport px

    /* ---------------- transforms ---------------- */

    /** Transform attribute for the <g id="world"> element. */
    worldTransform() {
      const bw = PB.board.sizeMM().w;
      const mirror = S.ui.flipped ? ' translate(' + U.round(bw, 4) + ',0) scale(-1,1)' : '';
      return 'translate(' + U.round(this.tx, 3) + ',' + U.round(this.ty, 3) + ') scale(' +
        U.round(this.scale, 6) + ')' + mirror;
    },

    mmToScreen(x, y) {
      const bw = PB.board.sizeMM().w;
      const mx = S.ui.flipped ? bw - x : x;
      return { x: this.tx + mx * this.scale, y: this.ty + y * this.scale };
    },

    screenToMM(px, py) {
      const bw = PB.board.sizeMM().w;
      const x = (px - this.tx) / this.scale;
      const y = (py - this.ty) / this.scale;
      return { x: S.ui.flipped ? bw - x : x, y: y };
    },

    /** Client (event) coords -> stage-local px. */
    clientToStage(ev) {
      const st = PB.dom.stage.getBoundingClientRect();
      return { x: ev.clientX - st.left, y: ev.clientY - st.top };
    },

    eventToMM(ev) {
      const p = this.clientToStage(ev);
      return this.screenToMM(p.x, p.y);
    },

    /* ---------------- camera ---------------- */
    resize() {
      const r = PB.dom.stage.getBoundingClientRect();
      this.w = r.width; this.h = r.height;
    },

    /** Zoom keeping the mm point under (px,py) pinned to that pixel. */
    zoomAt(px, py, factor) {
      const before = this.screenToMM(px, py);
      this.scale = U.clamp(this.scale * factor, this.minScale, this.maxScale);
      const bw = PB.board.sizeMM().w;
      const mx = S.ui.flipped ? bw - before.x : before.x;
      this.tx = px - mx * this.scale;
      this.ty = py - before.y * this.scale;
      PB.bus.emit('view');
    },

    zoomBy(factor) { this.zoomAt(this.w / 2, this.h / 2, factor); },

    panBy(dx, dy) { this.tx += dx; this.ty += dy; PB.bus.emit('view'); },

    fit(pad) {
      this.resize();
      const s = PB.board.sizeMM();
      const p = pad === undefined ? 26 : pad;
      const k = Math.min((this.w - p * 2) / Math.max(1, s.w), (this.h - p * 2) / Math.max(1, s.h));
      this.scale = U.clamp(k, this.minScale, this.maxScale);
      this.tx = (this.w - s.w * this.scale) / 2;
      this.ty = (this.h - s.h * this.scale) / 2;
      PB.bus.emit('view');
    },

    /** Bring a hole-space rect into view (used by DRC / search jumps). */
    centerOn(c, r, minScale) {
      const p = PB.board.holeToMM(c, r);
      if (minScale && this.scale < minScale) this.scale = minScale;
      const sc = this.scale;
      const bw = PB.board.sizeMM().w;
      const mx = S.ui.flipped ? bw - p.x : p.x;
      this.tx = this.w / 2 - mx * sc;
      this.ty = this.h / 2 - p.y * sc;
      PB.bus.emit('view');
    },

    /** How many px one hole pitch spans right now — drives LOD. */
    pitchPx() { return PB.board.pitch() * this.scale; }
  };

  /* ------------------------------------------------------------------
     Rulers (canvas, redrawn on view change)
     ------------------------------------------------------------------ */
  let topCv, leftCv;

  function initRulers() {
    topCv = document.createElement('canvas');
    leftCv = document.createElement('canvas');
    PB.dom.rulerTop.appendChild(topCv);
    PB.dom.rulerLeft.appendChild(leftCv);
  }

  function drawRulers() {
    if (!topCv || !S.ui.showRulers) return;
    const dpr = window.devicePixelRatio || 1;
    const rt = PB.dom.rulerTop.getBoundingClientRect();
    const rl = PB.dom.rulerLeft.getBoundingClientRect();
    sizeCanvas(topCv, rt.width, rt.height, dpr);
    sizeCanvas(leftCv, rl.width, rl.height, dpr);

    const bd = S.doc.board;
    const pitchPx = V.pitchPx();
    let every = 1;
    if (pitchPx < 9) every = 5;
    if (pitchPx < 4) every = 10;
    if (pitchPx < 2) every = 25;

    // top: columns
    let g = topCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, rt.width, rt.height);
    g.font = '9px ui-monospace, Consolas, monospace';
    g.textBaseline = 'middle';
    for (let c = 0; c < bd.cols; c++) {
      const mm = PB.board.holeToMM(c, 0);
      const sx = V.mmToScreen(mm.x, 0).x;
      if (sx < -20 || sx > rt.width + 20) continue;
      const major = (c % every === 0);
      g.strokeStyle = major ? '#5a6474' : '#333a46';
      g.beginPath(); g.moveTo(sx + 0.5, major ? 10 : 15); g.lineTo(sx + 0.5, rt.height); g.stroke();
      if (major && pitchPx * every > 16) {
        g.fillStyle = '#8b93a1';
        g.textAlign = 'center';
        g.fillText(PB.board.colName(c), sx, 6.5);
      }
    }

    // left: rows
    g = leftCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, rl.width, rl.height);
    g.font = '9px ui-monospace, Consolas, monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    for (let r = 0; r < bd.rows; r++) {
      const mm = PB.board.holeToMM(0, r);
      const sy = V.mmToScreen(0, mm.y).y;
      if (sy < -20 || sy > rl.height + 20) continue;
      const major = (r % every === 0);
      g.strokeStyle = major ? '#5a6474' : '#333a46';
      g.beginPath(); g.moveTo(major ? 10 : 15, sy + 0.5); g.lineTo(rl.width, sy + 0.5); g.stroke();
      if (major && pitchPx * every > 14) {
        g.fillStyle = '#8b93a1';
        g.save(); g.translate(6, sy); g.rotate(-Math.PI / 2);
        g.fillText(String(r + 1), 0, 0);
        g.restore();
      }
    }
  }

  function sizeCanvas(cv, w, h, dpr) {
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
  }

  V.initRulers = initRulers;
  V.drawRulers = drawRulers;
  PB.view = V;
})();
