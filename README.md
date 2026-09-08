# jackbron.github.io

Static site served by GitHub Pages at <https://jackbron.github.io>.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Landing page / project index. Plain HTML, no build step, no dependencies. |
| `line-studio/index.html` | Line Studio — single-file cooking-mode app. Deployed copy. |
| `video-store/` | The Late Fee — film diary as a rental-store shelf. |

Nothing here is built. Every page is hand-written HTML/CSS/JS served as-is, so
editing a file and pushing is the whole deploy.

## Adding a project

Copy the marked `<li class="project">` block in `index.html`. Each entry takes an
index number, a name, a status chip (`live` or `wip`), a description and a tag list.

## Updating Line Studio

The app's source of truth lives outside the published tree in `Cooking_Mode/`
(gitignored, along with the recipe JSON and PDFs — that folder holds third-party
recipe content and is deliberately not published). To ship a new revision:

```
cp Cooking_Mode/line_studio_<rev>.html line-studio/index.html
```

The revision string stays visible in the app's status bar, bottom right.

## The Late Fee (`video-store/`)

```
video-store/
  index.html          markup only
  css/store.css       the shelf, the cases, the room
  js/store.js         data layer behind an adapter interface
  js/providers.js     cover lookup + poster→spine colour extraction
  js/app.js           UI wiring
```

**Data.** Everything lives in `localStorage` under `latefee.v1`. `store.js` talks
to an *adapter*, not to storage directly, and its whole API is already async —
so moving to a shared backend is `useAdapter(RemoteAdapter)` and nothing above it
changes. Records already carry an `ownerId`, and `importAll` already resolves
conflicts by newest `updatedAt`, which is the rule a multi-member shelf needs.

**Cover lookup.** A static page cannot hold a secret, so no API key is committed
here. The member picks TMDB or OMDb in settings and pastes their own free key,
which is stored in their browser and sent only to that provider. Lookup off is a
supported state — cover art can always be uploaded by hand.

**Spine colour** is sampled from the poster on a canvas (both provider CDNs send
`Access-Control-Allow-Origin: *`, and uploads are data URIs, so neither taints).
When there is no art, the title hashes into a fixed set of period ink colours.

**Uploads** are re-encoded to a ~400px JPEG before storage — full-size art would
exhaust the ~5MB localStorage budget in a handful of films. Seventeen films with
five covers came to 21KB.

**Cache busting.** `index.html` links its CSS and JS with `?v=N`. Bump that when
you change either, or returning visitors keep the cached copy.
