# jackbron.github.io

Static site served by GitHub Pages at <https://jackbron.github.io>.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Landing page / project index. Plain HTML, no build step, no dependencies. |
| `line-studio/index.html` | Line Studio — single-file cooking-mode app. Deployed copy. |
| `protoboard-studio/` | Protoboard Studio — stripboard layout designer. Deployed copy. |

Nothing here is built. Every page is hand-written HTML/CSS/JS served as-is, so
editing a file and pushing is the whole deploy.

## Adding a project

Copy the marked `<li class="project">` block in `index.html`. Each entry takes an
index number, a name, a status chip, a description and a tag list. Index numbers
are cosmetic but are kept contiguous, so renumber the entries below one you
remove.

**Status chips are hand-edited — nothing sets them automatically.** The chip is
one class in `index.html` and only changes colour:

```html
<span class="status wip">wip</span>     <!-- amber -->
<span class="status live">live</span>   <!-- green, the same dim green as the body text -->
```

The convention used here: **wip** means the page is published and reachable but
still changing under you, or has a known rough edge worth warning a visitor
about. **live** means it does what its description claims, on a phone as well as
a desktop, and you would not apologise before handing someone the link. Moving a
project from `wip` to `live` is a deliberate edit to `index.html`, usually in the
same commit that fixes the last thing you were embarrassed about.

## Home button

Every app links back to the index from its own header, so a visitor is never
stranded one level deep. The markup is a small inline house glyph plus an
`Index` label, styled to match whatever bar it sits in:

| Page | Lives in | Href |
|---|---|---|
| `line-studio/` | the `.rail`, after the theme toggle | `../` |
| `protoboard-studio/` | `.menubar-right`, after Save | `../` |
| `choicer-party/` | `.bar-right`, after Leave | `../` |
| `choicer-party/test/` | `.bar-right`, beside "Back to the booth" | `../../` |

The icon is inline SVG rather than a glyph or a font so it renders identically
everywhere. Two of these apps are deployed copies — see the sections below — so
the same edit has to land in the source of truth or the next deploy reverts it.

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

## Choicer Party (`choicer-party/`)

A browser dubbing booth for Choicer Voicer packages, solo or as a party game:
the host loads a package, opens a room, friends join on their phones with a
four-letter code, each gets a character, records their lines, and the room
plays the finished dub back in sync. Vanilla ES modules, no build. Needs
`http(s)://` (the AudioWorklet will not load from `file://`).

```
choicer-party/
  index.html                  markup: loader (+resume card), lobby, booth
  css/party.css               the booth
  js/ini.js                   Godot ConfigFile card parser (lenient numbers/arrays)
  js/zip.js                   zip reader on DecompressionStream, no library
  js/wav.js                   WAV header walk + 16-bit encoder
  js/package.js               folder / zip / drop / URL -> package model (both layouts); wire summary
  js/pcm-capture.worklet.js   AudioWorklet: sample-accurate mic capture, streams chunks
  js/recorder.js              shared AudioContext: mic, takes, playback; autoplay unlock
  js/waveform.js              layered peaks + playhead on a canvas, live-growing layer
  js/mixer.js                 OfflineAudioContext mixdown, backing track, autoGain, normalize
  js/video.js                 clip playback: native <video>, else ogv.js (Theora); seek/frameSource
  js/room.js                  Trystero room, wire format, image shrinking, dealing (lazy-loaded)
  js/store.js                 IndexedDB: session record, takes, package files; per-tab clientId
  js/qr.js                    QR code for the join link (qrcode-generator from cdnjs, lazy)
  js/export.js                canvas + MediaRecorder video export with burned-in captions
  js/app.js                   UI wiring for solo / host / player
  test/index.html, tests.js   unit tests + package validator (same modules as the booth)
```

**Package format.** Two layouts exist, both flat folders, both accepted:

*Native* (what the game itself writes; the "Woody and Buzz Argue" pack):
`_pack_info.ini` (title, icon, authors, `readme`, `preselected_dub_characters`),
one `NN_character.txt` card per line (Godot ConfigFile: `caption`, `image`,
`dub_timestamps`, `dub_characters`) with a matching `NN_character.mp3`, one
`character.png` shared by all of that character's cards, `_backing_track.mp3`
(music and effects with the voices removed) and `dub_video.ogv`. Line numbers
are *per character*, so `05_woody` at 33 s comes before `05_buzz` at 35 s: lines
are ordered by timestamp, never by filename.

*Export* (from converter tools; the "Kanye Gaga Rant" pack): `_pack_info.ini`,
one `NNN_line_NN.ini` / `.png` / `.wav` triple per line, a `dub_markers.json`
index with start/end times, `dub_video.ogv`, no backing track.

`package.js` treats cards as the source of truth in both: any `.ini`/`.txt`
card, any audio next to it (`.wav` reads its header for the duration, anything
else is decoded once with an `OfflineAudioContext` and the buffer kept), any
image (`image=` in the card, else `stem.png`). Godot writes numbers with a
leading zero (`[05.865]`), which JSON rejects, so `ini.js` has a lenient pass
for arrays and scalars. When a backing track exists it goes under the takes in
the mix (at 0.8) and is sent to every player so their local mix matches.

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
tested locally. A static host has no directory listing, so a URL pack needs
either an `index.json` (a JSON array of its file names) or, for export packs,
the `dub_markers.json`. Players receive only the images, the backing track and
the audio of their own lines, over WebRTC.

**Identity and persistence.** People are identified by a `clientId` kept in
`sessionStorage` (per tab, survives reload) and mirrored into the saved
session record, never by the transport's per-load peer id. Assignments are
keyed by client id, so a refreshed player says hello again and gets the same
lines. Takes go into IndexedDB the moment they are saved, on every device; the
host also stores the package files. The loader shows a **Resume** card when a
session exists: a host resumes the same room code, players reconnect on their
own (a `roster` from a new peer with the known `hostClientId` is accepted, and
the player resends its own takes to the new host); a player resumes and gets
their takes back when the roster arrives. Session records are keyed per client
id, so a host testing with a second tab in the same browser does not clobber
its own record; stale records older than a week are pruned.

**Phases and rules.** `lobby` -> `record` -> `final`. The host's **Finalize**
(a confirmation, warning about unrecorded lines) locks every booth: no
recording, nudging or deleting, `take`/`progress` messages are ignored by all
peers, and the host's transport (play/pause/seek) drives everyone's playback.
**Unlock** returns to `record`. Room rules set in the lobby and fixed at Start:
*one take per line* (Record disables after a take, delete is off, and peers
ignore a second take from the same performer) and *performers may nudge*.
Mid-session the host can **Manage parts**: the assignment table stays live in
`record`, a change sends the new performer the line audio, and people who left
still show as holders until their lines are handed on.

**Transport.** Images are re-encoded to JPEG (<=640 px) once per shared
character image before sending. Players count what they are missing and send a
`need` (frames / line ids / backing) after 12 s, repeating until complete;
there is a manual "Resend my files" too. `room.js` wraps every send and handler
in try/catch and reports through `onError`; the header shows how many
signalling relays are open.

**Playback and export.** The dub has play/pause, a scrubber and a time
readout. Positions are mix seconds; `play {at, from}` / `stop {pos}` carry them
to the room when the host's "Everyone hears this" is on (forced on in
`final`). **Export video** composites the decoded clip (or the frame slideshow)
plus burned-in captions on a canvas at up to 1280 px, feeds it and the mix
into `MediaRecorder`, and saves MP4 (H.264/AAC) where supported, else WebM. It
runs in real time, shows progress, and can be cancelled. A 24 s clip came out
as 1.8 MB of MP4 in Chromium.

**Navigation.** Performers open on their first unrecorded line and, after a
take lands on the line they are viewing, move to their next unrecorded line;
non-performers follow the script. "Only mine" filters the list. The booth
shows a green banner when every assigned line is in (host: Finalize & play),
or when your own lines are done and others are still recording.

**Package tester** (`choicer-party/test/`): unit tests for the card parser,
zip reader, both package layouts, summary round trip, dealing, take codec,
image shrinking, autoGain/normalize, mixdown placement and the store, plus a
validator that loads a real pack and lists per-line warnings (missing image,
same-character overlaps, ends after the backing track, multi-speaker cards)
and unreferenced files.

**Rooms** run on [Trystero](https://github.com/dmotz/trystero) 0.25 (pinned,
from jsDelivr): peers meet through public Nostr relays, then talk directly over
WebRTC data channels. Nothing is hosted by us. The host is authoritative:

| action | from | to | payload |
|---|---|---|---|
| `hello` | player | host | `{name}` on peer join |
| `roster` | host | all | host id/name, players, `assignments` (lineId -> peerId), phase |
| `pack` | host | all | package summary without blobs |
| `frame` | host | all | image bytes, metadata `{lineId}`; a shared character image is sent once and fanned out by the receiver |
| `audio` | host | the line's performer | original line audio, metadata `{lineId}` |
| `backing` | host | all | backing track bytes |
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

Not yet: an onboarding explainer and demo pack, a host hand-off (the host's
package lives only on the host), and the two autoplay-policy edge cases that
are still being chased on Firefox and phones (waveform before the first Record,
sound before the mic permission).