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
