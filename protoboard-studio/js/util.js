/* ============================================================
   util.js — DOM helpers, geometry, misc
   Establishes the global PB namespace used by every other file.
   ============================================================ */
var PB = window.PB || {};
window.PB = PB;

PB.util = (function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';

  /* ---------------------------------------------------------- DOM */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /** el('div.cls#id', {attr:val}, [children|string]) */
  function el(spec, attrs, kids) {
    const m = /^([a-zA-Z0-9-]+)?((?:[.#][\w-]+)*)$/.exec(spec) || [];
    const tag = m[1] || 'div';
    const node = document.createElement(tag);
    applyMini(node, m[2]);
    const deferred = applyAttrs(node, attrs);
    appendKids(node, kids);
    /* value/checked must land after the children exist: setting
       select.value on an option-less <select> is silently discarded and
       the control snaps back to its first entry. */
    if (deferred) for (const k in deferred) node[k] = deferred[k];
    return node;
  }

  function svg(spec, attrs, kids) {
    const m = /^([a-zA-Z0-9-]+)?((?:[.#][\w-]+)*)$/.exec(spec) || [];
    const node = document.createElementNS(SVGNS, m[1] || 'g');
    applyMini(node, m[2], true);
    applyAttrs(node, attrs, true);
    appendKids(node, kids);
    return node;
  }

  function applyMini(node, mini, isSvg) {
    if (!mini) return;
    const cls = [];
    mini.replace(/([.#])([\w-]+)/g, function (_, k, v) {
      if (k === '.') cls.push(v); else node.setAttribute('id', v);
      return '';
    });
    if (cls.length) {
      if (isSvg) node.setAttribute('class', cls.join(' '));
      else node.className = cls.join(' ');
    }
  }

  /** Returns a map of properties that must be assigned after children. */
  function applyAttrs(node, attrs, isSvg) {
    if (!attrs) return null;
    let deferred = null;
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') { node.textContent = v; }
      else if (k === 'html') { node.innerHTML = v; }
      else if (k === 'style' && typeof v === 'object') { Object.assign(node.style, v); }
      else if (k === 'dataset') { for (const d in v) node.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') { node.addEventListener(k.slice(2), v); }
      else if (!isSvg && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected')) {
        (deferred = deferred || {})[k] = v;
      }
      else node.setAttribute(k, v === true ? '' : v);
    }
    return deferred;
  }

  function appendKids(node, kids) {
    if (kids === null || kids === undefined) return;
    if (!Array.isArray(kids)) kids = [kids];
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      node.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
    }
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------------------------------------------------- ids */
  let seq = 0;
  function uid(prefix) {
    seq++;
    return (prefix || 'x') + '_' + Date.now().toString(36).slice(-5) + seq.toString(36) +
      Math.floor(Math.random() * 1296).toString(36);
  }

  /** Next free designator such as U3 / R7 given the ones already used. */
  function nextDesignator(prefix, used) {
    const taken = new Set(used);
    for (let i = 1; i < 10000; i++) if (!taken.has(prefix + i)) return prefix + i;
    return prefix + uid();
  }

  /* ---------------------------------------------------------- maths */
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const round = (v, dp) => { const f = Math.pow(10, dp || 0); return Math.round(v * f) / f; };
  const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

  /** Shortest distance from point p to segment a-b, plus the closest point. */
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = clamp(t, 0, 1);
    const cx = ax + t * dx, cy = ay + t * dy;
    return { d: Math.hypot(px - cx, py - cy), x: cx, y: cy, t: t };
  }

  /** Distance from point to a polyline [{x,y},…]; returns {d, index, x, y}. */
  function polyDist(px, py, pts) {
    let best = { d: Infinity, index: -1, x: 0, y: 0 };
    for (let i = 0; i < pts.length - 1; i++) {
      const r = segDist(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (r.d < best.d) best = { d: r.d, index: i, x: r.x, y: r.y };
    }
    if (pts.length === 1) {
      const d = dist(px, py, pts[0].x, pts[0].y);
      if (d < best.d) best = { d: d, index: 0, x: pts[0].x, y: pts[0].y };
    }
    return best;
  }

  function polyLength(pts) {
    let L = 0;
    for (let i = 0; i < pts.length - 1; i++) L += dist(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    return L;
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }
  function pointInRect(px, py, r) { return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; }

  /** Rotate integer grid offset (dx,dy) by rot (0/90/180/270 degrees). */
  function rot90(dx, dy, rot) {
    switch (((rot % 360) + 360) % 360) {
      case 90:  return { x: -dy, y: dx };
      case 180: return { x: -dx, y: -dy };
      case 270: return { x: dy, y: -dx };
      default:  return { x: dx, y: dy };
    }
  }

  /* ---------------------------------------------------------- colour */
  function hexToRgb(h) {
    h = String(h || '#000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    const c = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }
  function shade(hex, amt) {   // amt -1..1  (negative darkens)
    const c = hexToRgb(hex);
    const f = t => amt >= 0 ? t + (255 - t) * amt : t * (1 + amt);
    return rgbToHex(f(c.r), f(c.g), f(c.b));
  }
  function luminance(hex) {
    const c = hexToRgb(hex);
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }
  function readableOn(hex) { return luminance(hex) > 0.56 ? '#101319' : '#f2f5fa'; }

  /** Deterministic pleasant colour from a string (used for auto net colours). */
  function hashColor(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    const hue = Math.abs(h) % 360;
    return hslHex(hue, 68, 60);
  }
  function hslHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
    return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
  }

  /* ---------------------------------------------------------- units */
  const MM_PER_IN = 25.4;
  function fmtLen(mm, unit) {
    if (unit === 'in') return round(mm / MM_PER_IN, 3) + '"';
    if (unit === 'holes') return round(mm / 2.54, 2) + 'h';
    return round(mm, 2) + ' mm';
  }

  /* ---------------------------------------------------------- misc */
  function deepClone(o) {
    if (typeof structuredClone === 'function') { try { return structuredClone(o); } catch (e) { /* fall through */ } }
    return JSON.parse(JSON.stringify(o));
  }

  function debounce(fn, ms) {
    let t = 0;
    return function () {
      const a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms || 120);
    };
  }

  function throttleRaf(fn) {
    let queued = false, lastArgs = null;
    return function () {
      lastArgs = arguments;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn.apply(null, lastArgs); });
    };
  }

  function download(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 400);
  }

  function pickFile(accept, cb, multiple) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept || ''; inp.multiple = !!multiple;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      const files = Array.prototype.slice.call(inp.files || []);
      if (files.length) cb(multiple ? files : files[0]);
      inp.remove();
    });
    inp.click();
  }

  function readText(file) {
    return new Promise(function (res, rej) {
      const fr = new FileReader();
      fr.onload = function () { res(String(fr.result)); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsText(file);
    });
  }

  function csvCell(v) {
    const s = String(v === undefined || v === null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }

  /* Storage that never throws (private mode / file:// quirks). */
  const store = {
    get(key, dflt) {
      try { const v = localStorage.getItem(key); return v === null ? dflt : JSON.parse(v); }
      catch (e) { return dflt; }
    },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } },
    del(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  };

  return {
    SVGNS, $, $$, el, svg, clear, esc,
    uid, nextDesignator,
    clamp, round, dist, segDist, polyDist, polyLength, rectsOverlap, pointInRect, rot90,
    hexToRgb, rgbToHex, shade, luminance, readableOn, hashColor, hslHex,
    MM_PER_IN, fmtLen,
    deepClone, debounce, throttleRaf, download, pickFile, readText, toCSV, store
  };
})();
