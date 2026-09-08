/* =====================================================================
   providers.js — cover/metadata lookup.

   A static page has nowhere to hide a secret, so there is no key baked
   into this repo. Each provider declares whether it needs one; the key
   the member pastes lives in their own browser and never leaves it
   except to the provider it belongs to.

   Every provider resolves to the same shape, so the UI never branches:
     { id, title, year, poster, provider }
   ===================================================================== */

const KEY_STORE = 'latefee.provider';

export const PROVIDERS = {
  none: {
    label: 'Off',
    needsKey: false,
    hint: 'Lookup is off. Add cover art with the upload button.',
    async search() { return []; },
  },

  tmdb: {
    label: 'TMDB',
    needsKey: true,
    hint: 'Free key from themoviedb.org → Settings → API. Stored in this browser only.',
    async search(q, key) {
      const url = 'https://api.themoviedb.org/3/search/movie'
        + `?api_key=${encodeURIComponent(key)}&include_adult=false&query=${encodeURIComponent(q)}`;
      const r = await fetch(url);
      if (r.status === 401) throw new Error('That key was rejected by TMDB.');
      if (!r.ok) throw new Error(`TMDB returned ${r.status}.`);
      const d = await r.json();
      return (d.results || []).slice(0, 12).map((m) => ({
        id: String(m.id),
        title: m.title || m.original_title || 'Untitled',
        year: (m.release_date || '').slice(0, 4) || null,
        // w500 is plenty for a 210px case and keeps the fetch small.
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
        provider: 'tmdb',
      }));
    },
  },

  omdb: {
    label: 'OMDb',
    needsKey: true,
    hint: 'Free key from omdbapi.com/apikey.aspx. Stored in this browser only.',
    async search(q, key) {
      const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}`
        + `&type=movie&s=${encodeURIComponent(q)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`OMDb returned ${r.status}.`);
      const d = await r.json();
      if (d.Response === 'False') {
        if (/invalid api key/i.test(d.Error || '')) throw new Error('That key was rejected by OMDb.');
        return [];
      }
      return (d.Search || []).slice(0, 12).map((m) => ({
        id: m.imdbID,
        title: m.Title,
        year: m.Year ? String(m.Year).slice(0, 4) : null,
        poster: m.Poster && m.Poster !== 'N/A' ? m.Poster : null,
        provider: 'omdb',
      }));
    },
  },
};

/* ---- which provider is configured -------------------------------- */

export function getConfig() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY_STORE) || '{}');
    return { provider: d.provider in PROVIDERS ? d.provider : 'none', key: d.key || '' };
  } catch {
    return { provider: 'none', key: '' };
  }
}

export function setConfig({ provider, key }) {
  try {
    localStorage.setItem(KEY_STORE, JSON.stringify({ provider, key }));
  } catch { /* private mode — lookup just stays off for the session */ }
}

export function isReady() {
  const { provider, key } = getConfig();
  const p = PROVIDERS[provider];
  return !!p && provider !== 'none' && (!p.needsKey || !!key);
}

export async function search(q) {
  const { provider, key } = getConfig();
  const p = PROVIDERS[provider];
  if (!p || provider === 'none') throw new Error('Lookup is switched off.');
  if (p.needsKey && !key) throw new Error(`${p.label} needs an API key.`);
  return p.search(q, key);
}

/* =====================================================================
   Poster → spine palette.

   A real spine is printed to match its cover, so the honest way to
   generate one is to read the cover. Both provider CDNs send
   `Access-Control-Allow-Origin: *`, which is what makes getImageData
   legal here; uploads are data URIs and are same-origin by definition.
   If either assumption ever breaks, the canvas taints, the read throws,
   and we fall back to a deterministic colour from the title.
   ===================================================================== */

/** Perceptual luminance (sRGB weights) — decides black vs white spine text. */
function luma(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

function hex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function shift(r, g, b, amount) {
  return amount > 0
    ? [r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount]
    : [r * (1 + amount), g * (1 + amount), b * (1 + amount)];
}

/**
 * Ink colours a rental spine actually got printed in. Sampling the full hue
 * circle looked wrong — it produced mint and lilac spines, and on a small
 * shelf it clustered anyway. A fixed set of period stock reads as a shelf
 * instead of a swatch chart, and every colour here is dark enough to carry
 * cream type.
 */
const SPINE_STOCK = [
  '#6e2230', '#8a4423', '#8a6a1f', '#2c4a2e',
  '#1f4b4d', '#23324f', '#34305c', '#4e2748',
  '#2e2b2a', '#7a3324', '#4a4a22', '#2b4257',
  '#57203a', '#93511d', '#24402f', '#3d2340',
];

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Deterministic fallback so a title always lands on the same spine colour. */
export function paletteFromTitle(title) {
  let h = 2166136261;
  for (let i = 0; i < title.length; i++) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const [r, g, b] = hexToRgb(SPINE_STOCK[h % SPINE_STOCK.length]);
  const [lr, lg, lb] = shift(r, g, b, 0.20);
  const [dr, dg, db] = shift(r, g, b, -0.45);

  return {
    base: hex(r, g, b),
    light: hex(lr, lg, lb),
    dark: hex(dr, dg, db),
    ink: luma(r, g, b) > 0.52 ? '#1b1310' : '#f2e9dd',
  };
}

/**
 * Average the poster's colour, weighting the middle band — the edges of a
 * poster are usually letterboxing or sky, the middle is the art.
 */
export function paletteFromImage(img) {
  const W = 40, H = 60;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);

  const { data } = ctx.getImageData(0, 0, W, H);   // throws if tainted
  let r = 0, g = 0, b = 0, n = 0;

  for (let y = 0; y < H; y++) {
    // triangular weight, peaking at the vertical centre
    const w = 1 - Math.abs(y - H / 2) / (H / 2) * 0.7;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] < 128) continue;
      r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; n += w;
    }
  }
  if (!n) throw new Error('empty image');
  r /= n; g /= n; b /= n;

  // Push toward a printable spine: saturated enough to read, dark enough
  // that white type sits on it. Flat grey posters otherwise make grey mush.
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 18) {                      // near-grey: lean it warm
    r = r * 1.06 + 6; g = g * 0.99; b = b * 0.92;
  }
  const l = luma(r, g, b);
  if (l > 0.62) { [r, g, b] = shift(r, g, b, -0.42); }
  else if (l < 0.10) { [r, g, b] = shift(r, g, b, 0.22); }

  const [lr, lg, lb] = shift(r, g, b, 0.20);
  const [dr, dg, db] = shift(r, g, b, -0.45);

  return {
    base: hex(r, g, b),
    light: hex(lr, lg, lb),
    dark: hex(dr, dg, db),
    ink: luma(r, g, b) > 0.52 ? '#1b1310' : '#f6efe5',
  };
}

/** Load an image for sampling. Resolves null rather than throwing. */
export function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Best palette available for this film, never throwing. */
export async function paletteFor(posterUrl, title) {
  if (posterUrl) {
    const img = await loadImage(posterUrl);
    if (img) {
      try { return paletteFromImage(img); }
      catch { /* tainted or unreadable — fall through */ }
    }
  }
  return paletteFromTitle(title || '');
}

/* =====================================================================
   Uploads.

   Full-size art would blow the ~5MB localStorage budget after a handful
   of films, so every upload is re-encoded to a poster-shaped JPEG before
   it is ever stored.
   ===================================================================== */

export function coverToDataUrl(file, { maxW = 400 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('That is not an image.'));

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode that image.'));
      img.onload = () => {
        const scale = Math.min(1, maxW / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
