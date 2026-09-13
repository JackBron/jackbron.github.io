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

A browser dubbing booth for Choicer Voicer packages, solo or as a party game:
the host loads a package, opens a room, friends join on their phones with a
four-letter code, each gets a character, records their lines, and the room
plays the finished dub back in sync. Vanilla ES modules, no build. Needs
`http(s)://` (the AudioWorklet will not load from `file://`).

```
choicer-party/
  index.html                  markup: loader, lobby, booth
  css/party.css               the booth
  js/ini.js                   Godot ConfigFile (.ini) card parser
  js/zip.js                   zip reader on DecompressionStream, no library
  js/wav.js                   WAV header walk + 16-bit encoder
  js/package.js               folder / zip / drop / URL -> package model; wire summary
  js/pcm-capture.worklet.js   AudioWorklet: sample-accurate mic capture, streams chunks
  js/recorder.js              shared AudioContext: mic, takes, playback
  js/waveform.js              layered peaks + playhead on a canvas, live-growing layer
  js/mixer.js                 OfflineAudioContext mixdown
  js/video.js                 clip playback: native <video>, else ogv.js (Theora)
  js/room.js                  Trystero room, wire format, character dealing (lazy-loaded)
  js/app.js                   UI wiring for solo / host / player
```

**Package format.** A flat folder: `_pack_info.ini` (title, authors, icon),
one `NNN_line_NN.ini` / `.png` / `.wav` triple per line (caption, 640x360 frame,
the original audio for that line at 48 kHz), an optional `dub_markers.json`
index with start/end times, and an optional `dub_video.ogv`. The `.ini` fields
`dub_timestamps` and `dub_characters` are arrays, so one card can carry several
speakers. The `.ini` cards are the source of truth; the JSON only supplies
timing when present.

**The video is Theora, and no browser decodes Theora any more.** Chrome and
Edge removed it in 2024, Firefox 130 followed, Safari never had it. Worse,
`canPlayType('video/ogg')` still answers "maybe" because the Vorbis audio track
is fine, so a naive `<video>` plays sound over a black picture. `video.js`
probes the codec, checks `videoWidth` after metadata, and otherwise loads
[ogv.js](https://github.com/bvibber/ogv.js) 1.9.0 from jsDelivr, a JS/wasm
Theora decoder that renders to a canvas and mimics the media-element API. It
plays the 1080p example fine and seeks from a `blob:` URL. Players' phones
never get the video; they see a slideshow of the line frames.

**Packages are never committed.** They contain the clip itself. The host reads
them from disk (folder pick, drag-drop, or `.zip`) or from any URL serving the
folder with CORS; `?pkg=<base-url>` loads one on open, which is how it is
tested locally. Players receive only the PNG frames and the WAVs of their own
lines, over WebRTC.

**Rooms** run on [Trystero](https://github.com/dmotz/trystero) 0.25 (pinned,
from jsDelivr): peers meet through public Nostr relays, then talk directly over
WebRTC data channels. Nothing is hosted by us. The host is authoritative:

| action | from | to | payload |
|---|---|---|---|
| `hello` | player | host | `{name}` on peer join |
| `roster` | host | all | host id/name, players, `assignments` (lineId -> peerId), phase |
| `pack` | host | all | package summary without blobs |
| `frame` | host | all | PNG bytes, metadata `{lineId}` |
| `audio` | host | the line's performer | WAV bytes, metadata `{lineId}` |
| `take` | anyone | all | Int16 mono PCM, metadata `{lineId, sampleRate, offset, by, ...}` |
| `progress` | performer | all | `{lineId, status:'deleted'}` |
| `clock` | player <-> host | | NTP-style offset estimate, best of six round trips |
| `play` / `stop` | host | all | `{at}` in the host's `performance.now()` clock |

Every peer holds every take, so every peer renders the same mix locally; the
host's `play {at}` is converted through the measured clock offset into a local
`AudioContext` start time. Two tabs on one machine started within 1 ms of each
other. Character dealing: with at least as many characters as performers, whole
characters go round-robin; with more performers than characters (a one-voice
pack at a party), lines go round-robin. The host can override per line.

Trystero 0.25 API notes, since they bit: `makeAction` returns
`{send, onMessage, onReceiveProgress}` where the two handlers are *assigned*,
not called; `onPeerJoin`/`onPeerLeave` are assigned the same way; callbacks
receive `(data, {peerId, metadata})`. `room.js` normalises all of that.

**Timing.** Capture and the playhead run on one `AudioContext` clock: the
worklet is told the exact start frame of the take, so a recording lines up
with the line to the sample rather than with `MediaRecorder`'s variable start
latency. The worklet also streams ~1024-frame chunks back while recording so
the take draws itself under the original as it is performed. Each take carries
an `offset` the performer can nudge; samples are never resampled or trimmed,
the offset is applied at mix time and travels with the take.

**Mixdown** is an `OfflineAudioContext` render with every take placed at its
line's start. It is deterministic, which is what lets every peer render the
same mix from the same takes. Each take also carries a `gain` set when it is
saved (`autoGain`: peak to -1.4 dBFS, between x0.5 and x8) because phones
record quietly; it travels with the take and is applied at mix and preview
time, never to the samples. The rendered mix is then peak-normalised both
ways, so overlapping levelled takes cannot clip on the way out.

**Autoplay policy.** Three rules, learned the hard way on a Firefox host and
a phone. (1) Decoding never touches the live `AudioContext`: Firefox holds
back `decodeAudioData` on a context that is not yet allowed to start, so the
waveform would wait for the first Record. Line audio is decoded through an
`OfflineAudioContext`, which the policy does not cover. (2) The live context
is only ever created inside a user gesture (`Recorder.unlock()`, called from
every button handler and from a page-wide first-interaction listener on
`pointerdown`/`mousedown`/`touchend`/`click`/`keydown`), because a context
created during activation starts everywhere, while `resume()` on one created
earlier is refused by some browsers. Nothing awaits `resume()`. (3) On iOS a
silent `<audio>` element is played once on the first gesture so WebKit leaves
the silent-switch-muted session; Web Audio is otherwise inaudible with the
ringer switched off. If a browser still refuses, the status bar says so.

**Microphone.** Browser voice processing (echo cancellation, noise suppression,
automatic gain) is left at the browser defaults; turning it off made Android
phones record almost silently. A picker in the booth lists input devices (labels
appear once permission has been granted) so a paired headset mic can be
spotted and switched.

**Follow along.** A room reads the script in order: everyone opens on the first
line nobody has recorded, and when a take lands on the line you are looking at,
you move to the next line a beat and a half later (a checkbox in the booth turns
this off). Navigating by hand or starting a take cancels the pending move.

Not yet: reassigning a line after recording has started (a player who drops
out strands their lines until the host re-deals from a fresh lobby), a muxed
video download (the `.wav` mix downloads today; ogv.js draws to a canvas, so
`canvas.captureStream` + the mix into `MediaRecorder` is the route), persisting
takes across a reload, and a QR code for the join link.
