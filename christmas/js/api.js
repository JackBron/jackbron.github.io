// Shared by the guest page and the admin page.
//
// API_DEFAULT is the Worker in christmas/worker — paste the URL `wrangler deploy`
// prints. For local testing, open the page with ?api=http://127.0.0.1:8787 once;
// it sticks in localStorage until ?api=default.
const API_DEFAULT = "https://christmas.atlasclark.workers.dev";

const Api = (() => {
  const qs = new URLSearchParams(location.search);
  try {
    if (qs.has("api")) {
      const v = qs.get("api");
      if (v === "default") localStorage.removeItem("xmas.api");
      else localStorage.setItem("xmas.api", v);
    }
  } catch {}
  let base = API_DEFAULT;
  try { base = localStorage.getItem("xmas.api") || API_DEFAULT; } catch {}
  base = base.replace(/\/+$/, "");

  async function call(method, path, body, token) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Object.assign(new Error("Can't reach the party server. Check your connection and try again."), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(data?.error || `Server error (${res.status}).`), { status: res.status });
    return data;
  }

  return { call, base, configured: !base.includes("YOUR-SUBDOMAIN") };
})();

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmtDay(d, opts = { weekday: "long", month: "long", day: "numeric" }) {
  return new Date(`${d.date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...opts });
}
function fmtTime(d) {
  if (!d.time) return "";
  const [h, m] = d.time.split(":").map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(undefined, { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
}
function fmtDate(d) {
  return d ? [fmtDay(d), fmtTime(d)].filter(Boolean).join(" · ") : "";
}

function toast(msg, bad = false) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show${bad ? " bad" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = "toast"; }, bad ? 4500 : 2500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy — select the text and copy it yourself.", true);
  }
}

const ICON_HOME = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7l6-4.5L14 7"/><path d="M3.5 6.5V13h9V6.5"/></svg>`;
const ICON_STAR = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M8 .8l1.9 4.6 4.9.4-3.7 3.2 1.1 4.8L8 11.3l-4.2 2.5 1.1-4.8L1.2 5.8l4.9-.4z"/></svg>`;
const ICON_UP = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10l4.5-4.5 4.5 4.5"/></svg>`;
const ICON_DOWN = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6l4.5 4.5 4.5-4.5"/></svg>`;
const ICON_X = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
const ICON_KEY = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="8" r="3"/><path d="M8 8h6.5M12 8v2.5M14.5 8v2"/></svg>`;
const ICON_GIFT = `<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2" y="6" width="12" height="8" rx="1"/><path d="M1.5 6h13M8 6v8"/><path d="M8 6C6.5 3.5 4 3.5 4.5 5.2 4.8 6 8 6 8 6zM8 6c1.5-2.5 4-2.5 3.5-.8C11.2 6 8 6 8 6z"/></svg>`;

// "RSVP by" tag in the header corner, ticking down to the deadline.
const Countdown = (() => {
  let timer = null;
  let at;
  function start(ts) {
    const el = document.getElementById("countdown");
    if (!el || ts === at) return;
    at = ts;
    clearInterval(timer);
    if (!ts) {
      el.hidden = true;
      return;
    }
    const day = new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const full = new Date(ts).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    el.hidden = false;
    el.title = `RSVP by ${full}`;
    el.innerHTML = `<span class="cd-label">RSVP by ${esc(day)}</span><span class="cd-time" role="timer" aria-label="RSVP by ${esc(full)}"></span>`;
    const out = el.querySelector(".cd-time");
    const pad = (n) => String(n).padStart(2, "0");
    const tick = () => {
      const left = Math.floor((ts - Date.now()) / 1000);
      if (left <= 0) {
        el.classList.add("closed");
        out.textContent = "passed";
        return clearInterval(timer);
      }
      el.classList.remove("closed");
      const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
      out.textContent = d ? `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s` : `${pad(h)}:${pad(m)}:${pad(s)}`;
    };
    tick();
    timer = setInterval(tick, 1000);
  }
  return { start };
})();

// Header decoration: a string of lights across the top and a tree in the
// corner. Purely visual.
(() => {
  const hero = document.querySelector(".hero");
  if (!hero) return;
  const swags = 8, w = 100 / swags;
  let path = "M0,1", bulbs = "";
  for (let k = 0; k < swags; k++) {
    path += ` Q${(k + 0.5) * w},9 ${(k + 1) * w},1`;
    for (const t of [0.25, 0.5, 0.75]) {
      const y = (1 - t) ** 2 + 2 * t * (1 - t) * 9 + t ** 2; // point on the curve, viewBox units
      bulbs += `<i class="${t === 0.5 ? "" : "q"}" style="left:${(k + t) * w}%;top:${y * 3}px"></i>`;
    }
  }
  const lights = document.createElement("div");
  lights.className = "lights";
  lights.setAttribute("aria-hidden", "true");
  lights.innerHTML = `<svg viewBox="0 0 100 10" preserveAspectRatio="none"><path d="${path}"/></svg>${bulbs}`;
  hero.prepend(lights);

  hero.querySelector(".hero-inner")?.insertAdjacentHTML("beforeend", `
    <svg class="hero-tree" viewBox="0 0 80 100" aria-hidden="true">
      <rect x="34" y="83" width="12" height="11" rx="2" fill="#6b4226"/>
      <path d="M40 42L73 85H7z" fill="#2c7d50"/>
      <path d="M40 24L64 60H16z" fill="#33905c"/>
      <path d="M40 10L56 38H24z" fill="#3aa168"/>
      <path d="M20 74q20 8 40-4M26 52q14 6 28-3M31 33q9 4 18-2" fill="none" stroke="#f5e7c6" stroke-width="1.4" stroke-linecap="round" opacity=".8"/>
      <circle cx="28" cy="68" r="3.2" fill="#e5484d"/><circle cx="52" cy="76" r="3.2" fill="#f2c14e"/>
      <circle cx="46" cy="56" r="2.8" fill="#e5484d"/><circle cx="30" cy="48" r="2.6" fill="#f2c14e"/>
      <circle cx="40" cy="33" r="2.4" fill="#e5484d"/><circle cx="60" cy="82" r="2.4" fill="#fff"/>
      <circle cx="18" cy="81" r="2.4" fill="#fff"/>
      <path class="tree-star" d="M40 1.5l2.4 5 5.4.6-4 3.7 1.1 5.3-4.9-2.7-4.9 2.7 1.1-5.3-4-3.7 5.4-.6z" fill="#f2c14e"/>
    </svg>`);
})();
