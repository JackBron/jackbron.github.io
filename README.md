# jackbron.github.io

Static site served by GitHub Pages at <https://jackbron.github.io>.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Landing page / project index. Plain HTML, no build step, no dependencies. |
| `line-studio/index.html` | Line Studio — single-file cooking-mode app. Deployed copy. |
| `video-store/` | The Late Fee — film diary as a rental-store shelf. |
| `protoboard-studio/` | Protoboard Studio — stripboard layout designer. Deployed copy. |

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

## Updating Protoboard Studio

Source of truth is the working copy at `Python Scripts/Protoboard_Studio`. The
deployed copy is a straight file copy — every path in it is relative and the
scripts are classic (non-module), so it runs unchanged from a subpath:

```
cp -r <source>/index.html <source>/css <source>/js <source>/parts protoboard-studio/
```

Its `localStorage` keys are all namespaced `pbstudio.*`, so they do not collide
with the other apps now sharing the `jackbron.github.io` origin.

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

## Choicer Party (`choicer-party/`)

A browser dubbing booth for Choicer Voicer
packages, and the first slice of a multiplayer version. Vanilla ES modules, no
build. Needs `http(s)://` (the AudioWorklet will not load from `file://`); the
`landing` server in `.claude/launch.json` serves it at
`http://localhost:4173/choicer-party/`.

```
choicer-party/
  index.html                  markup
  css/party.css               the booth
  js/ini.js                   Godot ConfigFile (.ini) card parser
  js/zip.js                   zip reader on DecompressionStream, no library
  js/wav.js                   WAV header walk + 16-bit encoder
  js/package.js               folder / zip / drop / URL -> package model
  js/pcm-capture.worklet.js   AudioWorklet: sample-accurate mic capture
  js/recorder.js              shared AudioContext: mic, takes, playback
  js/waveform.js              layered peaks + playhead on a canvas
  js/mixer.js                 OfflineAudioContext mixdown
  js/app.js                   UI wiring
```

**Package format.** A flat folder: `_pack_info.ini` (title, authors, icon),
one `NNN_line_NN.ini` / `.png` / `.wav` triple per line (caption, 640x360 frame,
the original audio for that line at 48 kHz), an optional `dub_markers.json`
index with start/end times, and an optional `dub_video.ogv`. The video is
Theora: Firefox still decodes it, Chrome and Edge dropped the decoder in 2024
and Safari never had it, and `canPlayType('video/ogg')` still answers "maybe"
in Chrome because the Vorbis audio track is fine. The app probes the codec and
checks `videoWidth` after metadata, and falls back to a slideshow of the
line frames when the picture cannot be decoded. The `.ini` fields
`dub_timestamps` and `dub_characters` are arrays, so one card can carry several
speakers. The `.ini` cards are the source of truth; the JSON only supplies
timing when present.

**Packages are never committed.** They contain the clip itself. The app reads
them from disk (folder pick, drag-drop, or `.zip`) or from any URL that serves
the folder with CORS; `?pkg=<base-url>` loads one on open, which is how it is
tested locally.

**Timing.** Capture and the playhead run on one `AudioContext` clock: the
worklet is told the exact start frame of the take, so a recording lines up
with the line to the sample rather than with `MediaRecorder`'s variable start
latency. Each take carries an `offset` the performer can nudge; samples are
never resampled or trimmed, the offset is applied at mix time.

**Mixdown** is an `OfflineAudioContext` render with every take placed at its
line's start. It is deterministic, which is what lets the multiplayer build
have every peer render the same mix locally from the same takes.

Not yet: rooms, character assignment, shipping takes between browsers, a
muxed video download (the `.wav` mix downloads today), persisting takes
across a reload, and a way to watch the real video outside Firefox (a
one-time transcode of `dub_video.ogv` to WebM/VP9 on the host, in-browser or
via ffmpeg, is the likely answer).
