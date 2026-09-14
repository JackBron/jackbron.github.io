// QR code for the join link. qrcode-generator is loaded from cdnjs on demand;
// nothing else in the app needs it, and a host without internet has no room
// to share anyway.

const SRC = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
let loading = null;

function load() {
  if (window.qrcode) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.onload = resolve;
      s.onerror = () => { loading = null; reject(new Error('QR library did not load')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/** Render `text` as an SVG QR code inside `container`. Resolves false if it could not. */
export async function renderQr(container, text) {
  try {
    await load();
    const q = window.qrcode(0, 'M'); // type 0 = pick the smallest that fits
    q.addData(text);
    q.make();
    let svg;
    try { svg = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch { svg = q.createSvgTag(4, 2); }
    container.innerHTML = svg;
    const el = container.querySelector('svg');
    if (el) { el.removeAttribute('width'); el.removeAttribute('height'); el.setAttribute('role', 'img'); el.setAttribute('aria-label', `QR code for ${text}`); }
    return true;
  } catch (err) {
    console.warn(err);
    container.innerHTML = '';
    return false;
  }
}
