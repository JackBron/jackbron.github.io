export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 64 * 1024) throw new HttpError(413, "Request too large.");
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new HttpError(400, "Malformed request.");
  }
}

export function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export function clip(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

export function normCode(code) {
  return String(code ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

export function firstName(name) {
  return String(name).trim().split(/\s+/)[0];
}

// ---------- crypto ----------

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function randomId() {
  return b64url(crypto.getRandomValues(new Uint8Array(9)));
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Unbiased integer in [0, max) from the CSPRNG.
function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

export function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ---------- contact ----------

export function parseContact(raw) {
  const v = String(raw ?? "").trim();
  if (!v) throw new HttpError(400, "Add an email address or a mobile number.");
  if (v.includes("@")) {
    if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
      throw new HttpError(400, "That email address doesn't look right.");
    }
    return { type: "email", value: v };
  }
  if (/[a-z]/i.test(v)) throw new HttpError(400, "That doesn't look like an email address or a phone number.");
  const plus = v.startsWith("+");
  let d = v.replace(/\D/g, "");
  // No country code: assume North America, which is what a bare 10-digit number means here.
  if (!plus && d.length === 10) d = "1" + d;
  else if (!plus && !(d.length === 11 && d.startsWith("1"))) {
    throw new HttpError(400, "Include the country code for numbers outside the US, like +44 7700 900123.");
  }
  if (d.length < 8 || d.length > 15) throw new HttpError(400, "That phone number doesn't look right.");
  return { type: "sms", value: "+" + d };
}

// ---------- dates ----------

export function formatDate(d) {
  if (!d) return "";
  const day = new Date(d.date + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
  });
  if (!d.time) return day;
  const [h, m] = d.time.split(":").map(Number);
  return `${day} at ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
