/* =====================================================================
   app.js — the shelf UI.
   ===================================================================== */

import { Store, today, normalizeRating } from './store.js';
import {
  PROVIDERS, getConfig, setConfig, isReady, search,
  paletteFor, paletteFromTitle, coverToDataUrl,
} from './providers.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const FORMAT_LABEL = { vhs: 'VHS', dvd: 'DVD', bluray: 'Blu-ray' };

/* ---- state -------------------------------------------------------- */

const S = {
  films: [],
  editing: null,      // film id when the sheet is editing rather than adding
  viewing: null,
  draft: {},          // poster/colors/source staged in the sheet
};

/* ---- utils -------------------------------------------------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** "1984-07-02" → "2 JUL 1984", parsed as local so the day never slips. */
function prettyDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '—';
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${+m[3]} ${months[+m[2] - 1]} ${m[1]}`;
}

function starString(rating) {
  const r = normalizeRating(rating);
  let out = '';
  for (let i = 1; i <= 5; i++) {
    if (r >= i) out += '<span>★</span>';
    else if (r >= i - 0.5) out += '<span>⯪</span>';
    else out += '<span class="off">★</span>';
  }
  return out;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---- rendering the shelf ------------------------------------------ */

function sortFilms(films) {
  const how = $('#sort').value;
  const by = {
    'watched-desc': (a, b) => (b.watchedOn || '').localeCompare(a.watchedOn || ''),
    'watched-asc': (a, b) => (a.watchedOn || '').localeCompare(b.watchedOn || ''),
    'rating-desc': (a, b) => b.rating - a.rating || (b.watchedOn || '').localeCompare(a.watchedOn || ''),
    'title-asc': (a, b) => a.title.localeCompare(b.title),
    'year-desc': (a, b) => (b.year || 0) - (a.year || 0),
  }[how];
  return [...films].sort(by);
}

function filterFilms(films) {
  const q = $('#filter').value.trim().toLowerCase();
  if (!q) return films;
  return films.filter((f) =>
    f.title.toLowerCase().includes(q)
    || String(f.year || '').includes(q)
    || (f.note || '').toLowerCase().includes(q));
}

/**
 * A stable per-film lean, so cases keep the same tilt between renders
 * instead of jittering every time the shelf redraws.
 */
function leanFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const steps = [0, 0, 0, -0.8, 0.7, -1.4, 1.2, 0];
  return steps[h % steps.length];
}

function caseEl(f) {
  const c = f.colors || paletteFromTitle(f.title);
  const btn = document.createElement('button');
  btn.className = `case case--${f.format}`;
  btn.type = 'button';
  btn.dataset.id = f.id;
  btn.setAttribute('role', 'listitem');
  btn.style.setProperty('--c-base', c.base);
  btn.style.setProperty('--c-light', c.light);
  btn.style.setProperty('--c-dark', c.dark);
  btn.style.setProperty('--c-ink', c.ink);
  btn.style.setProperty('--lean', leanFor(f.id) + 'deg');
  btn.setAttribute('aria-label',
    `${f.title}${f.year ? ', ' + f.year : ''} — ${FORMAT_LABEL[f.format]}, rated ${f.rating} of 5, watched ${prettyDate(f.watchedOn)}`);
  btn.title = `${f.title}${f.year ? ` (${f.year})` : ''}`;

  const pips = Array.from({ length: 5 }, (_, i) =>
    `<i class="case__pip${f.rating >= i + 1 ? ' case__pip--on' : ''}"></i>`).join('');

  btn.innerHTML =
    `<span class="case__body">
       <span class="case__cap"></span>
       <span class="case__title">${esc(f.title)}</span>
       <span class="case__pips">${pips}</span>
     </span>`;
  return btn;
}

function render() {
  const shelf = $('#shelf');
  const list = sortFilms(filterFilms(S.films));

  shelf.replaceChildren(...list.map(caseEl));

  const empty = $('#shelfEmpty');
  const nothingAtAll = S.films.length === 0;
  empty.hidden = !nothingAtAll;
  shelf.hidden = nothingAtAll;

  if (!nothingAtAll && list.length === 0) {
    shelf.hidden = true;
    empty.hidden = false;
    $('#shelfEmpty .shelf-empty__big').textContent = 'NO MATCHES';
    $('#shelfEmpty p:not(.shelf-empty__big)').textContent = 'Nothing on the shelf matches that filter.';
    $('#shelfEmpty [data-act="add-first"]').hidden = true;
  } else {
    $('#shelfEmpty .shelf-empty__big').textContent = 'SHELF EMPTY';
    $('#shelfEmpty p:not(.shelf-empty__big)').textContent =
      'Nothing checked in yet. Add a film and it gets a case on the rack.';
    $('#shelfEmpty [data-act="add-first"]').hidden = false;
  }

  $('#statCount').textContent = S.films.length;
  const rated = S.films.filter((f) => f.rating > 0);
  $('#statAvg').textContent = rated.length
    ? (rated.reduce((a, f) => a + f.rating, 0) / rated.length).toFixed(1)
    : '—';
}

/* ---- viewer -------------------------------------------------------- */

function openViewer(id) {
  const f = S.films.find((x) => x.id === id);
  if (!f) return;
  S.viewing = id;

  const c = f.colors || paletteFromTitle(f.title);
  const stage = $('#viewer');
  stage.style.setProperty('--c-base', c.base);
  stage.style.setProperty('--c-dark', c.dark);
  stage.style.setProperty('--c-ink', c.ink);

  const front = $('#vFront');
  if (f.poster) {
    front.style.backgroundImage = `url("${f.poster}")`;
    front.textContent = '';
  } else {
    front.style.backgroundImage = 'none';
    front.textContent = f.title;
  }

  $('#vFormat').textContent = FORMAT_LABEL[f.format];
  $('#vTitle').textContent = f.title;
  $('#vYear').textContent = f.year ? String(f.year) : '';
  $('#vWatched').textContent = prettyDate(f.watchedOn);
  $('#vStars').innerHTML = f.rating > 0 ? starString(f.rating) : '<span class="off">unrated</span>';
  $('#vNote').textContent = f.note || '';

  stage.hidden = false;
  $('.viewer__close').focus();
}

function closeViewer() {
  $('#viewer').hidden = true;
  S.viewing = null;
}

/* ---- the add / edit sheet ------------------------------------------ */

function setStars(v) {
  S.draft.rating = normalizeRating(v);
  const el = $('#fStars');
  el.setAttribute('aria-valuenow', S.draft.rating);
  el.setAttribute('aria-valuetext', `${S.draft.rating} of 5`);
  $$('span', el).forEach((s, i) => {
    const idx = i + 1;
    s.classList.toggle('on', S.draft.rating >= idx);
    s.classList.toggle('half', S.draft.rating >= idx - 0.5 && S.draft.rating < idx);
  });
}

function setCover(url, source = null) {
  S.draft.poster = url || null;
  S.draft.source = source;
  S.draft.colors = null;                       // recomputed on save
  const p = $('#coverPreview');
  p.style.backgroundImage = url ? `url("${url}")` : 'none';
  p.classList.toggle('has-art', !!url);
}

function openSheet(film = null) {
  S.editing = film ? film.id : null;
  S.draft = {};

  $('#sheetTitle').textContent = film ? 'Edit title' : 'Add a title';
  $('#fTitle').value = film ? film.title : '';
  $('#fYear').value = film && film.year ? film.year : '';
  $('#fWatched').value = film ? film.watchedOn : today();
  $('#fNote').value = film ? film.note : '';
  $$('input[name=fmt]').forEach((r) => { r.checked = r.value === (film ? film.format : 'vhs'); });
  setStars(film ? film.rating : 0);
  setCover(film ? film.poster : null, film ? film.source : null);
  if (film) S.draft.colors = film.colors;

  $('#q').value = '';
  $('#results').replaceChildren();
  refreshLookupHint();

  $('#sheet').showModal();
  $('#q').focus();
}

function refreshLookupHint() {
  const { provider } = getConfig();
  const p = PROVIDERS[provider];
  const hint = $('#lookupHint');
  const btn = $('#btnSearch');
  const box = $('#q');

  if (!isReady()) {
    hint.innerHTML = provider === 'none'
      ? 'Lookup is off — <button type="button" class="linkish" data-act="settings">switch on a provider</button> or upload art below.'
      : `${esc(p.label)} needs a key — <button type="button" class="linkish" data-act="settings">add it in settings</button>.`;
    btn.disabled = true;
    box.disabled = true;
  } else {
    hint.textContent = '';
    btn.disabled = false;
    box.disabled = false;
    box.placeholder = `search ${p.label}…`;
  }

  const note = $('#providerNote');
  note.innerHTML = isReady()
    ? `Cover lookup: ${esc(PROVIDERS[getConfig().provider].label)}`
    : 'Cover lookup is off — <button type="button" class="linkish" data-act="settings">add a free key</button> or upload art by hand.';
}

async function runSearch() {
  const q = $('#q').value.trim();
  if (!q) return;
  const results = $('#results');
  const hint = $('#lookupHint');

  hint.textContent = 'Searching…';
  results.replaceChildren();

  try {
    const hits = await search(q);
    hint.textContent = hits.length ? '' : 'Nothing found for that.';
    results.replaceChildren(...hits.map((h) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'result';
      b.innerHTML =
        (h.poster
          ? `<img src="${esc(h.poster)}" alt="" loading="lazy">`
          : '<span class="noart">no art</span>')
        + `<span><span class="result__t">${esc(h.title)}</span><br>
             <span class="result__y">${esc(h.year || '—')}</span></span>`;
      b.addEventListener('click', () => {
        $('#fTitle').value = h.title;
        $('#fYear').value = h.year || '';
        setCover(h.poster, { provider: h.provider, id: h.id });
        results.replaceChildren();
        hint.textContent = `Using art from ${PROVIDERS[h.provider].label}.`;
      });
      return b;
    }));
  } catch (err) {
    hint.textContent = err.message || 'Lookup failed.';
  }
}

async function saveSheet() {
  const rec = {
    title: $('#fTitle').value.trim(),
    year: $('#fYear').value ? +$('#fYear').value : null,
    format: ($$('input[name=fmt]').find((r) => r.checked) || {}).value || 'vhs',
    watchedOn: $('#fWatched').value,
    rating: S.draft.rating || 0,
    note: $('#fNote').value.trim(),
    poster: S.draft.poster || null,
    source: S.draft.source || null,
  };
  if (!rec.title) { toast('It needs a title.'); return; }

  rec.colors = S.draft.colors || await paletteFor(rec.poster, rec.title);

  try {
    if (S.editing) {
      await Store.update(S.editing, rec);
      toast('Updated.');
    } else {
      await Store.add(rec);
      toast(`${rec.title} is on the shelf.`);
    }
  } catch (err) {
    if (err.message === 'QUOTA') {
      toast('Out of browser storage — export and trim some cover art.');
      return;
    }
    throw err;
  }

  S.films = await Store.list();
  render();
}

/* ---- settings ------------------------------------------------------ */

async function openSettings() {
  const { provider, key } = getConfig();
  const prof = await Store.profile();
  $('#sOwner').value = prof.name || '';
  $('#sProvider').value = provider;
  $('#sKey').value = key;
  syncKeyField();
  $('#settings').showModal();
}

function syncKeyField() {
  const p = PROVIDERS[$('#sProvider').value];
  $('#keyField').hidden = !p.needsKey;
  $('#keyHint').textContent = p.hint;
}

async function saveSettings() {
  setConfig({ provider: $('#sProvider').value, key: $('#sKey').value.trim() });
  await Store.setProfile({ name: $('#sOwner').value.trim() });
  const me = await Store.me();
  $('#ownerName').textContent = me.name || 'Guest';
  refreshLookupHint();
}

/* ---- import / export ----------------------------------------------- */

async function doExport() {
  const json = await Store.exportAll();
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `late-fee-shelf-${today()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Shelf exported.');
}

async function doImport(file) {
  try {
    const { added, updated } = await Store.importAll(await file.text());
    S.films = await Store.list();
    render();
    toast(`Imported — ${added} added, ${updated} updated.`);
  } catch (err) {
    toast(err.message === 'QUOTA' ? 'Not enough browser storage for that import.' : 'That file was not a shelf export.');
  }
}

/* ---- wiring -------------------------------------------------------- */

function wire() {
  $('#btnAdd').addEventListener('click', () => openSheet());
  $('#btnSettings').addEventListener('click', openSettings);
  $('#filter').addEventListener('input', render);
  $('#sort').addEventListener('change', render);

  // one delegated handler for everything that carries a data-act
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'close-viewer') closeViewer();
    if (act === 'add-first') openSheet();
    if (act === 'settings') { if ($('#sheet').open) $('#sheet').close('cancel'); openSettings(); }
    if (act === 'edit') { const f = S.films.find((x) => x.id === S.viewing); closeViewer(); openSheet(f); }
    if (act === 'delete') removeCurrent();
  });

  $('#shelf').addEventListener('click', (e) => {
    const c = e.target.closest('.case');
    if (c) openViewer(c.dataset.id);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#viewer').hidden) closeViewer();
  });

  /* sheet */
  $('#btnSearch').addEventListener('click', runSearch);
  $('#q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  });

  $('#sheetForm').addEventListener('submit', (e) => {
    // <form method=dialog> closes on any submit; only the save button saves.
    if (e.submitter && e.submitter.value === 'save') {
      if (!$('#fTitle').value.trim()) { e.preventDefault(); toast('It needs a title.'); return; }
      saveSheet();
    }
  });

  /* stars — click position within a star picks the half */
  const stars = $('#fStars');
  stars.innerHTML = '<span></span>'.repeat(5);
  stars.addEventListener('click', (e) => {
    const s = e.target.closest('span');
    if (!s) return;
    const i = $$('span', stars).indexOf(s);
    const r = s.getBoundingClientRect();
    setStars(i + (e.clientX - r.left < r.width / 2 ? 0.5 : 1));
  });
  stars.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setStars((S.draft.rating || 0) + 0.5); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setStars((S.draft.rating || 0) - 0.5); }
  });

  /* cover upload */
  $('#btnUpload').addEventListener('click', () => $('#fCover').click());
  $('#btnClearCover').addEventListener('click', () => setCover(null));
  $('#fCover').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { setCover(await coverToDataUrl(file)); }
    catch (err) { toast(err.message); }
    e.target.value = '';
  });

  /* settings */
  $('#sProvider').addEventListener('change', syncKeyField);
  $('#settings').addEventListener('close', () => {
    if ($('#settings').returnValue === 'save') saveSettings();
  });
  $('#btnExport').addEventListener('click', doExport);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) doImport(f);
    e.target.value = '';
  });
}

async function removeCurrent() {
  const f = S.films.find((x) => x.id === S.viewing);
  if (!f) return;
  if (!confirm(`Remove "${f.title}" from the shelf? This cannot be undone.`)) return;
  await Store.remove(f.id);
  S.films = await Store.list();
  closeViewer();
  render();
  toast('Taken off the shelf.');
}

/* ---- boot ---------------------------------------------------------- */

(async function boot() {
  wire();
  const me = await Store.me();
  $('#ownerName').textContent = me.name || 'Guest';
  S.films = await Store.list();
  refreshLookupHint();
  render();
})();
