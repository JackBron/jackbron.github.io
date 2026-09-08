/* ============================================================
   router.js — jumper path generation

   Three wiring styles:
     ortho  right angles only (Manhattan)
     diag   45 degree octilinear
     free   straight point-to-point, any angle

   Plus an A* auto-router that works on a half-pitch grid, so wires can
   run either along the hole lines or neatly between them, and steers
   around part bodies on the same side of the board.
   ============================================================ */
(function () {
  'use strict';
  const U = PB.util;
  const S = PB.state;

  const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
  const P = (c, r) => ({ c: c, r: r });

  /* ------------------------------------------------------------------
     Point-list hygiene
     ------------------------------------------------------------------ */
  function simplify(pts) {
    const out = [];
    for (const p of pts) {
      const q = { c: U.round(p.c, 3), r: U.round(p.r, 3) };
      const last = out[out.length - 1];
      if (last && last.c === q.c && last.r === q.r) continue;
      out.push(q);
    }
    // drop collinear middles
    for (let i = 1; i < out.length - 1;) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      const cross = (b.c - a.c) * (c.r - a.r) - (b.r - a.r) * (c.c - a.c);
      if (Math.abs(cross) < 1e-6) out.splice(i, 1); else i++;
    }
    return out;
  }

  /* ------------------------------------------------------------------
     Two-segment elbows
     ------------------------------------------------------------------ */
  function elbow(a, b, mode, flip) {
    if (!a || !b) return [];
    if (mode === 'free') return simplify([a, b]);

    if (mode === 'diag') {
      const dx = b.c - a.c, dy = b.r - a.r;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (adx === ady || adx === 0 || ady === 0) return simplify([a, b]);
      const m = Math.min(adx, ady);
      const mid = flip
        ? P(b.c - sign(dx) * m, b.r - sign(dy) * m)   // straight first, then 45
        : P(a.c + sign(dx) * m, a.r + sign(dy) * m);  // 45 first, then straight
      return simplify([a, mid, b]);
    }

    // ortho
    const mid = flip ? P(a.c, b.r) : P(b.c, a.r);
    return simplify([a, mid, b]);
  }

  /** Re-flow a whole waypoint chain in the given style. */
  function chain(points, mode, flip) {
    if (points.length < 2) return simplify(points);
    let out = [points[0]];
    for (let i = 0; i < points.length - 1; i++) {
      const seg = elbow(points[i], points[i + 1], mode, flip);
      out = out.concat(seg.slice(1));
    }
    return simplify(out);
  }

  /* ------------------------------------------------------------------
     Obstacle field for the auto-router
     ------------------------------------------------------------------ */
  /* Body cost is deliberately a *penalty*, not a hard wall.  Pads live
     underneath their own part's body, so a wire almost always starts
     inside an obstacle — a hard wall would make it unroutable.  A steep
     cost sends the path around a module whenever going around exists,
     and still lets it escape when it does not. */
  const BODY_COST = 8;

  function buildField(side, ignore) {
    const bd = S.doc.board;
    const W = bd.cols * 2 - 1;      // half-pitch nodes across
    const H = bd.rows * 2 - 1;
    const cost = new Float32Array(W * H);  // extra cost added per node
    const blocked = new Uint8Array(W * H); // informational: inside a body
    ignore = ignore || {};

    const at = (x, y) => y * W + x;
    const gridToHole = (x, y) => ({ c: x / 2, r: y / 2 });

    // part bodies on this side
    S.doc.parts.forEach(function (part) {
      if (part.side !== side) return;
      if (ignore.parts && ignore.parts.has(part.id)) return;
      const def = S.def(part.def);
      if (!def) return;
      const rct = PB.parts.bodyRect(part, def);
      const x0 = Math.max(0, Math.ceil((rct.x) * 2)), x1 = Math.min(W - 1, Math.floor((rct.x + rct.w) * 2));
      const y0 = Math.max(0, Math.ceil((rct.y) * 2)), y1 = Math.min(H - 1, Math.floor((rct.y + rct.h) * 2));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = at(x, y);
          if (!blocked[i]) { blocked[i] = 1; cost[i] += BODY_COST; }
        }
      }
    });

    // existing wires on this side: discourage overlap, allow crossing
    S.doc.wires.forEach(function (w) {
      if (w.side !== side) return;
      if (ignore.wires && ignore.wires.has(w.id)) return;
      for (let i = 0; i < w.pts.length - 1; i++) {
        const a = w.pts[i], b = w.pts[i + 1];
        const steps = Math.max(2, Math.ceil(Math.hypot(b.c - a.c, b.r - a.r) * 4));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const gx = Math.round((a.c + (b.c - a.c) * t) * 2);
          const gy = Math.round((a.r + (b.r - a.r) * t) * 2);
          if (gx >= 0 && gy >= 0 && gx < W && gy < H) cost[at(gx, gy)] += 2.2;
        }
      }
    });

    // slight preference for running between holes rather than over pads
    const occ = PB.nets.occupancy();
    occ.forEach(function (list, hk) {
      const p = hk.split(',');
      const gx = (+p[0]) * 2, gy = (+p[1]) * 2;
      if (gx >= 0 && gy >= 0 && gx < W && gy < H) cost[at(gx, gy)] += 1.4;
      void list;
    });

    return { W: W, H: H, cost: cost, blocked: blocked, at: at, gridToHole: gridToHole };
  }

  /* ------------------------------------------------------------------
     A*
     ------------------------------------------------------------------ */
  const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIRS8 = DIRS4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);

  /**
   * autoroute(a, b, opts) -> array of hole-space points, or null.
   * opts: { mode:'ortho'|'diag', side, ignoreParts:Set, ignoreWires:Set, turnCost }
   */
  function autoroute(a, b, opts) {
    opts = opts || {};
    const mode = opts.mode === 'diag' ? 'diag' : 'ortho';
    const side = opts.side || S.ui.side;
    const field = opts.field || buildField(side, { parts: opts.ignoreParts, wires: opts.ignoreWires });
    const W = field.W, H = field.H;

    const sx = Math.round(a.c * 2), sy = Math.round(a.r * 2);
    const gx = Math.round(b.c * 2), gy = Math.round(b.r * 2);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H || gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
    if (sx === gx && sy === gy) return null;

    const dirs = mode === 'diag' ? DIRS8 : DIRS4;
    const ND = dirs.length;
    const turnCost = opts.turnCost === undefined ? 2.6 : opts.turnCost;
    const N = W * H * (ND + 1);
    const gScore = new Float32Array(N).fill(Infinity);
    const cameFrom = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);

    const sIdx = d => ((sy * W + sx) * (ND + 1)) + d;
    const key = (x, y, d) => ((y * W + x) * (ND + 1)) + d;

    function heur(x, y) {
      const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
      return mode === 'diag'
        ? (Math.max(dx, dy) + 0.414 * Math.min(dx, dy))
        : (dx + dy);
    }

    // binary heap
    const heap = [];
    function push(node, f) {
      heap.push({ n: node, f: f });
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].f <= heap[i].f) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
      }
    }
    function pop() {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l].f < heap[m].f) m = l;
          if (r < heap.length && heap[r].f < heap[m].f) m = r;
          if (m === i) break;
          const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
        }
      }
      return top;
    }

    const start = sIdx(ND);   // ND == "no direction yet"
    gScore[start] = 0;
    push(start, heur(sx, sy));

    let goalNode = -1, guard = 0;
    const LIMIT = 900000;

    while (heap.length && guard++ < LIMIT) {
      const cur = pop().n;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cell = Math.floor(cur / (ND + 1));
      const cd = cur % (ND + 1);
      const cx = cell % W, cy = Math.floor(cell / W);
      if (cx === gx && cy === gy) { goalNode = cur; break; }

      for (let d = 0; d < ND; d++) {
        const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        const diagonal = dirs[d][0] !== 0 && dirs[d][1] !== 0;
        let step = diagonal ? 1.414 : 1;
        step += field.cost[ni];
        if (cd !== ND && d !== cd) step += turnCost;
        const nk = key(nx, ny, d);
        const ng = gScore[cur] + step;
        if (ng < gScore[nk]) {
          gScore[nk] = ng;
          cameFrom[nk] = cur;
          push(nk, ng + heur(nx, ny) * 1.12);
        }
      }
    }

    if (goalNode < 0) return null;

    const path = [];
    let n = goalNode;
    while (n >= 0) {
      const cell = Math.floor(n / (ND + 1));
      path.push({ c: (cell % W) / 2, r: Math.floor(cell / W) / 2 });
      n = cameFrom[n];
    }
    path.reverse();
    return simplify(path);
  }

  /* ------------------------------------------------------------------
     Convenience wrappers used by the tools
     ------------------------------------------------------------------ */

  /** Best path between two holes for the current settings. */
  function connect(a, b, opts) {
    opts = opts || {};
    const mode = opts.mode || S.ui.wireMode;
    if (mode === 'free') return simplify([a, b]);
    if (opts.auto) {
      const r = autoroute(a, b, { mode: mode, side: opts.side || S.ui.side,
        ignoreParts: opts.ignoreParts, ignoreWires: opts.ignoreWires, field: opts.field });
      if (r && r.length) return r;
    }
    return elbow(a, b, mode, !!opts.flip);
  }

  /** Recompute the geometry of an existing wire, keeping its endpoints. */
  function reflow(wire, opts) {
    opts = opts || {};
    const a = wire.pts[0], b = wire.pts[wire.pts.length - 1];
    const pts = connect(a, b, {
      mode: wire.mode, side: wire.side, auto: opts.auto !== false,
      ignoreWires: new Set([wire.id]), flip: !!opts.flip, field: opts.field
    });
    if (pts && pts.length >= 2) wire.pts = pts;
    return wire;
  }

  /** Convert a polyline in hole space to an SVG path in mm. */
  function toPath(pts, radius) {
    if (!pts || pts.length < 2) return '';
    const mm = pts.map(p => PB.board.holeToMM(p.c, p.r));
    if (!radius) return 'M' + mm.map(p => U.round(p.x, 3) + ' ' + U.round(p.y, 3)).join('L');
    // rounded corners
    let d = 'M' + U.round(mm[0].x, 3) + ' ' + U.round(mm[0].y, 3);
    for (let i = 1; i < mm.length - 1; i++) {
      const prev = mm[i - 1], cur = mm[i], next = mm[i + 1];
      const l1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const l2 = Math.hypot(next.x - cur.x, next.y - cur.y);
      const r = Math.min(radius, l1 / 2, l2 / 2);
      if (r < 0.05) { d += 'L' + U.round(cur.x, 3) + ' ' + U.round(cur.y, 3); continue; }
      const p1 = { x: cur.x + (prev.x - cur.x) / l1 * r, y: cur.y + (prev.y - cur.y) / l1 * r };
      const p2 = { x: cur.x + (next.x - cur.x) / l2 * r, y: cur.y + (next.y - cur.y) / l2 * r };
      d += 'L' + U.round(p1.x, 3) + ' ' + U.round(p1.y, 3) +
           'Q' + U.round(cur.x, 3) + ' ' + U.round(cur.y, 3) + ' ' + U.round(p2.x, 3) + ' ' + U.round(p2.y, 3);
    }
    const last = mm[mm.length - 1];
    d += 'L' + U.round(last.x, 3) + ' ' + U.round(last.y, 3);
    return d;
  }

  PB.router = { simplify, elbow, chain, autoroute, buildField, connect, reflow, toPath };
})();
