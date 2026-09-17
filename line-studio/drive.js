/* =====================================================================
   LINE STUDIO — Save to Google Drive
   ---------------------------------------------------------------------
   Importing from Drive was dropped on purpose: on iOS the existing
   "Choose files" button already opens the Files app with Drive in it, so
   an in-app importer bought nothing. Saving is the direction with no
   built-in shortcut — otherwise the cookbook has to be downloaded, found
   in Files, and re-filed by hand every time.

   Deploy-only add-on. Lives outside line_studio_rNN.html so the app stays
   a single file you can open from disk and no revision ever has to be
   merged with this. It touches the app only through globals its top-level
   <script> already exposes (save, say).

   Scope is drive.file — the app may only touch files it created itself.
   It is non-sensitive, so it avoids Google's restricted-scope
   verification review, and it is exactly the right shape for this: a
   writer that never needs to read the rest of your Drive.

   The access token is held in memory only and never written to storage.
   ===================================================================== */

(function () {
  'use strict';

  /* ---------------- CONFIG — fill this in ----------------
     Only an OAuth client ID. There is no API key here: that was only ever
     needed by the file Picker, and saving does not use one.
     Setup steps are in line-studio/DRIVE-SETUP.md.                      */

  const CLIENT_ID = '';   // e.g. '1234567890-abc123.apps.googleusercontent.com'

  /* ------------------------------------------------------- */

  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GSI = 'https://accounts.google.com/gsi/client';
  const FILENAME = 'line_studio_cookbook.json';
  const LS_KEY = 'linestudio.v1';
  const ID_KEY = 'linestudio.drive.fileId';

  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

  // OAuth origins cannot be file://, so this only applies to the hosted copy.
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  let token = null;
  let tokenClient = null;

  const note = (m) => (typeof window.say === 'function' ? window.say(m) : console.log('[drive]', m));

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('could not reach Google (offline, or blocked)'));
      document.head.appendChild(s);
    });
  }

  /* Google's script is pulled on first click, not page load, so an ordinary
     cooking session never contacts Google at all. */
  async function ensureAuth() {
    await loadScript(GSI);
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE, callback: () => {},
      });
    }
    if (!token) await newToken();
  }

  function newToken() {
    return new Promise((resolve, reject) => {
      tokenClient.callback = (res) => {
        if (res.error) return reject(new Error(res.error_description || res.error));
        token = res.access_token;
        resolve(token);
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  /** fetch with one retry after refreshing an expired token. */
  async function api(url, opts) {
    const send = () => fetch(url, {
      ...opts,
      headers: { ...(opts && opts.headers), Authorization: 'Bearer ' + token },
    });
    let r = await send();
    if (r.status === 401) { await newToken(); r = await send(); }
    return r;
  }

  /**
   * The cookbook, in the same shape File ▸ Export writes.
   *
   * Built from localStorage rather than from the app's state directly: `S`
   * is a top-level const and so is not reachable from here, but `save()` is
   * a function declaration and therefore is. Calling it first guarantees
   * what we read back is current.
   */
  function payload() {
    if (typeof window.save === 'function') window.save();
    const d = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return JSON.stringify({
      schema: 'linestudio.cookbook/1',
      exported: new Date().toISOString(),
      recipes: d.book || [],
      plan: d.plan || {},
    }, null, 2);
  }

  /**
   * The id of our previous upload, if it still exists.
   *
   * A remembered id alone is not enough — the file may have been deleted or
   * trashed in Drive, and blindly PATCHing a dead id fails. drive.file means
   * a listing only ever returns files this app created, so asking Drive is
   * both safe and authoritative.
   */
  async function findExisting() {
    const remembered = localStorage.getItem(ID_KEY);
    if (remembered) {
      const r = await api(`${API}/${encodeURIComponent(remembered)}?fields=id,trashed`);
      if (r.ok) {
        const f = await r.json();
        if (!f.trashed) return f.id;
      }
      localStorage.removeItem(ID_KEY);
    }

    const q = encodeURIComponent(`name='${FILENAME}' and trashed=false`);
    const r = await api(`${API}?q=${q}&spaces=drive&fields=files(id)&pageSize=1`);
    if (!r.ok) return null;
    const d = await r.json();
    return (d.files && d.files[0] && d.files[0].id) || null;
  }

  async function upload(body) {
    const existing = await findExisting();

    if (existing) {
      const r = await api(`${UPLOAD}/${encodeURIComponent(existing)}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!r.ok) throw new Error('Drive returned ' + r.status + ' updating the file');
      return { id: existing, created: false };
    }

    // multipart: metadata part, then the file itself
    const boundary = 'ls' + Math.random().toString(36).slice(2);
    const meta = { name: FILENAME, mimeType: 'application/json' };
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(meta) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      body +
      `\r\n--${boundary}--`;

    const r = await api(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    if (!r.ok) throw new Error('Drive returned ' + r.status + ' creating the file');
    const d = await r.json();
    return { id: d.id, created: true };
  }

  async function run() {
    if (!CLIENT_ID) {
      note('Drive is not configured yet — see line-studio/DRIVE-SETUP.md');
      return;
    }

    const btn = document.getElementById('btnDrive');
    if (btn) btn.disabled = true;

    try {
      const body = payload();
      const n = (JSON.parse(body).recipes || []).length;
      if (!n) { note('nothing to save — the library is empty'); return; }

      note('saving to Drive…');
      await ensureAuth();
      const { id, created } = await upload(body);

      try { localStorage.setItem(ID_KEY, id); } catch (e) { /* private mode */ }
      note(`saved ${n} recipe${n === 1 ? '' : 's'} to Drive${created ? '' : ' (updated)'}`);
    } catch (err) {
      note('Drive: ' + (err && err.message ? err.message : 'save failed'));
      console.error('[drive]', err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---------------- the button ---------------- */

  function mount() {
    const rail = document.querySelector('.rail');
    if (!rail || rail.querySelector('#btnDrive')) return;

    const btn = document.createElement('button');
    btn.className = 'rbtn';
    btn.id = 'btnDrive';
    btn.title = 'Save the cookbook and week plan to Google Drive';
    btn.textContent = 'Save to Drive';
    btn.addEventListener('click', run);

    const index = rail.querySelector('a.rbtn[href="../"]');
    rail.insertBefore(btn, index || null);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
