# Protoboard Studio

A 2D protoboard / stripboard layout designer for planning real-world hand-wired
builds: place breakout boards, run the jumpers on the front or the back, check
the result, and print a cut list you can work from at the bench.

No build step, no install, no server. **Double-click `index.html`.**

---

## Contents

- [Running it](#running-it)
- [The five-minute tour](#the-five-minute-tour)
- [Boards](#boards)
- [Parts](#parts)
- [Wiring](#wiring)
- [Front, back and see-through](#front-back-and-see-through)
- [Nets and design checks](#nets-and-design-checks)
- [Files and exports](#files-and-exports)
- [Keyboard](#keyboard)
- [Part definition format](#part-definition-format)
- [Project file format](#project-file-format)
- [Source layout](#source-layout)

---

## Running it

Open `index.html` in any current browser. Everything is plain classic scripts,
so it runs straight off the filesystem.

If you would rather serve it over `http://` (handy when you want a stable
origin for the browser's local storage, or want to reach it from another
machine on the LAN):

```bash
python -m http.server 8777
```

then browse to `http://localhost:8777`. `serve.bat` does the same thing on
Windows and opens the browser for you.

Your work is auto-saved to browser local storage as you go and restored on the
next visit, but that is a convenience, not a backup — use **File ▸ Save
project** for anything you care about.

---

## The five-minute tour

1. **Board** tab — pick perfboard / stripboard / paired pads / breadboard-style
   and set the hole count. Sizes are shown in both mm and inches.
2. **Library** tab — click a breakout, then click on the board to drop it.
   `R` rotates, `M` mirrors, `Esc` stops placing.
3. Press `2` to move to the **back** of the board, press `W`, and click pad →
   pad to run a jumper. The three style buttons on the floating bar switch
   between right-angle, 45° and any-angle routing.
4. **Checks** tab — catches pins hanging off the board, colliding footprints,
   shorted strips, power/ground shorts and redundant jumpers.
5. **File ▸ Assembly build sheet** — prints both sides of the board plus a BOM,
   a wire-by-wire cut list with lengths, a track-cut list and the netlist.

`Help ▸ Load the example project` brings back the worked example (an Arduino
Nano driving an I2C OLED and a BMP280) if you want something to poke at.

---

## Boards

| Type | Copper |
| --- | --- |
| **Perfboard** | Every hole is an isolated pad. All connections are jumpers. |
| **Stripboard / Veroboard** | Continuous strips along rows or columns. Break them with the cut tool. |
| **Paired pads** | Pads joined in twos along the strip axis. |
| **Breadboard-style** | A stack of bands you describe yourself — rails, hole groups, blank channels. |

Everything is configured in the **Board** tab: hole counts, pitch (2.54 mm by
default, but anything works), substrate margin, pad and hole diameters, corner
mount holes, and the substrate/pad/copper colours. Four colour presets are
provided (green FR4, tan FR2, blue, black).

### Band layout

A breadboard-style board is described as a stack of horizontal bands, read off
the real board top to bottom. A half-size Perma-Proto is:

| Band | Rows | |
| --- | --- | --- |
| Power rail | 1 | one strip across the full width |
| Blank | 1 | bare board |
| Hole groups | 5 | each column of 5 joined |
| Blank | 2 | the centre channel, with a mounting hole at each end |
| Hole groups | 5 | |
| Blank | 1 | |
| Power rail | 1 | |

Set that up in **Board ▸ Band layout**: pick a kind per band, set its row
count, reorder with the arrows, add and remove bands. The **row count of the
board follows from the bands** rather than the other way round, so the Rows
field goes read-only while a band stack is in use.

The four band kinds are:

- **Power rail** — every row in the band is one strip running the full width.
  The ⎎ button splits it in the middle, as many boards do.
- **Hole groups** — each column is joined down the height of the band. A
  5-row band gives the familiar groups of five.
- **Isolated pads** — plain perfboard, nothing joined.
- **Blank / channel** — bare board with no holes at all. The ◎ button puts a
  mounting hole at each end of the band, which is where they sit on a real
  breadboard-style board.

`Start from a preset…` offers the common arrangements, and **Mirror** makes a
stack symmetrical so you only have to describe the top half.

Earlier versions inferred this structure from the row count, which meant you
could not state a layout you actually owned. A project saved by one of those
versions is migrated to the band stack that reproduces its exact previous
layout — including keeping the pads its gutter rows had, so nothing
disappears. If your real board has no through-holes in the channel, switch
that band from **Isolated pads** to **Blank**.

### Mounting holes

The corner M3 holes physically take the pad they land on, so those holes are
not drawn, are excluded from the copper (they break a stripboard strip just as
a drilled cut would), cannot be wired to, and refuse a part pin. The snap
cursor turns red over one, and the design checks flag anything that ends up
there. Turn them off in the Board tab and the pads come back. A blank band can
carry its own pair instead, independently of the corner holes.

### Removing holes

Real protoboards are not always fully drilled — the centre channel of a
breadboard-style board often has no through-holes at all, and boards get
cut-outs and snapped corners. Pick the **hole tool** (`O`) and click a hole to
take it away, or drag across a run to clear several in one go; click a missing
one to bring it back. The whole gesture is a single undo step.

A removed hole carries no pad, breaks the copper passing through it (exactly as
a drilled cut would), refuses both jumper ends and part pins, and shows red
under the snap cursor. The design checks flag anything already sitting there.

A **Blank** band already has no holes, so on a breadboard-style board the
channel is handled by the band layout rather than by hand. The hole tool is for
everything else — a cut-out, a snapped corner, a board that is only drilled in
places. **Restore all** clears the list.

The list lives in the project file as `board.voids`, so it travels with the
design and survives save/load.

### Track cuts

With the cut tool (`X`) on a stripboard:

- **click** — knife cut, severing the strip between the hole under the cursor
  and the next one along
- **Shift + click** — cut across the other axis
- **Alt + click** — drill the hole out entirely, isolating it from both
  neighbours
- **click again** — remove the cut

Connectivity is recomputed from the copper every time, so the Nets tab and the
design checks always reflect the cuts you have made.

---

## Parts

Roughly 130 built-in definitions ship in `parts/builtin-parts.js`, grouped into
dev boards, sensors, comms & display, power, ICs & sockets, passives,
connectors and electromechanical. Click a category heading to collapse it; the
app remembers which ones you closed. Search matches the name, category, tags
*and pin names*, so typing `sda` finds every I2C part, and a search always
shows what it found regardless of what is collapsed.

### Making your own

**Tools ▸ Part Designer** (or `+ New` in the Library tab):

- click a hole to add a pin — keep the button down and drag to place it
- **drag any pin** to move it; the grid holds still for the gesture and two
  pins will not stack in one hole
- **Erase** mode removes a pin on click
- **Body** mode: drag out the outline, or type exact width / height / offsets
  (half-hole steps allowed, so bodies can overhang their pins)
- the preview is drawn with the same renderer the board uses, so **Shape**
  shows the real artwork — a TO-220 tab, an electrolytic can, header squares
- drag the dialog's bottom-right corner to make it bigger; the canvas re-fits
  as it grows, which helps on a 40-pin footprint
- **Single row… / Dual row…** takes a pasted list of pin names — `GND VCC SCL
  SDA` — and lays them out for you, guessing each pin's type from its name
- **Category** is a dropdown of every category already in the library, with a
  `＋ New category…` entry when you want your own
- pick a silkscreen colour and one of thirteen body shapes (module, DIP,
  header, axial, LED, radial, TO-92, TO-220, screw terminal, tact switch…)

Opening a built-in part in the designer makes a copy rather than overwriting
it, so the stock library is always intact (`Tools ▸ Reset part library to
defaults` clears only your own).

Custom parts live in browser local storage. **File ▸ Export part library**
writes them to a JSON file; **Import part library** merges one back, which is
how you move a library between machines or share one. Every project also
embeds a copy of the definitions it uses, so a `.pbstudio` file opens correctly
on a machine that has never seen your custom parts.

---

## Wiring

Press `W`, click the starting pad, click the destination. In between:

| | |
| --- | --- |
| **Right angle** | Manhattan routing — the default, and what most hand-wiring looks like. |
| **45°** | Octilinear routing, for tidier diagonal runs. |
| **Any angle** | A straight line from A to B, the way a real flying lead sits. |
| **Auto-route** | On by default. Runs an A\* search on a half-pitch grid that steers around part bodies on the same side and avoids doubling up on top of existing wires. Untick it for a plain two-segment elbow. |

- `Tab` flips the elbow while you are drawing
- `Shift` + click adds a bend of your own and keeps going
- `Backspace` removes the last bend, `Esc` cancels
- double-click an existing wire to insert a bend; drag the square handles to
  shape it, holding `Alt` to place a bend off-grid
- picking a colour and gauge (30–18 AWG) on the floating bar sets what the next
  wire uses; the **Properties** tab changes an existing one

Wires drag with their parts: move a breakout and any jumper landing in one of
its pads follows. Hold `Ctrl` while dragging to leave the wires where they are.

### Ratsnest

The link tool (`Q`) records a connection you *want* without committing to a
path — click pad A, click pad B, and a dashed line appears. **Tools ▸
Auto-route ratsnest** turns every outstanding link into a real jumper in one
go, and any link you happen to route by hand disappears on its own.

**Tools ▸ Re-flow right-angle wires** re-runs the router over the selected
wires (or every right-angle wire on the current side) after you have moved
things around.

---

## Front, back and see-through

The `FRONT` / `BACK` switch chooses which side you are working on, and
switching to the back turns the whole board over: the view mirrors, so column A
moves to the right-hand edge exactly as it would in your hand. The other side
stays visible but dimmed and dashed, and is not clickable — so you can see what
is on the component side while you wire the solder side without selecting it by
accident.

The **See-through** slider fades the breakout bodies. That is what lets you run
a jumper underneath an Arduino Nano and still see where it goes; drop it to
around 20 % when you are routing under a big module, put it back up when you
want to read the silkscreen.

`B` toggles the mirror on its own, if you would rather read the back without
flipping it (or study the front mirrored). Text and pin names stay the right
way round either way.

---

## Nets and design checks

Connectivity is computed from the board's own copper, the track cuts, the
jumper wires and the part pins together. The **Nets** tab lists every node,
with the number of pins and wires on it; click one to highlight it on the
board, and use the pencil to give it a real name like `SDA`, which then colours
its wires.

**Checks** (`Ctrl E`, live by default) reports:

- pins off the board, or in a hole that has been drilled out
- two parts wanting the same hole
- part bodies overlapping on the same side
- **pins of one part shorted together by the board's copper** — the classic
  stripboard mistake, where a DIP drops across a strip
- power and ground on the same node
- jumpers whose ends were already on the same strip (redundant)
- duplicate jumpers, zero-length jumpers
- unconnected pins, and ratsnest links you have not routed yet

Clicking a result selects the offending object and centres the view on it.

---

## Files and exports

| | |
| --- | --- |
| `.pbstudio` | The project — one JSON file, including embedded part definitions. |
| **SVG** | Vector export of the current view, exactly as drawn. |
| **PNG** | Raster export, choice of resolution and dark / white / transparent background. |
| **Netlist** `.net` | Readable net list with the hole label for every node. |
| **BOM** `.csv` | Quantity, part, value and references. |
| **Wire cut-list** `.csv` | Every jumper: side, from, to, style, colour, gauge, path length and a cut length with 12 mm of stripping/bending allowance. |
| **Assembly build sheet** | A print view with both sides drawn, the BOM, the cut list, the track cuts and the netlist. |

---

## Keyboard

**Tools** `V` select · `H` pan · `P` place · `W` wire · `Q` link · `X` cut ·
`O` add/remove holes · `T` text · `D` measure · `E` erase

**View** wheel zooms at the cursor · `Shift`+wheel pans · middle-drag or hold
`Space` to pan · `Ctrl 0` fit · `+` / `-` zoom · `1` / `2` front / back (the
back view is mirrored) · `B` mirror the view on its own · `L` designators ·
`N` ratsnest

**Edit** `R` rotate (`Shift R` counter-clockwise) · `M` mirror · `F` flip to
the other side · arrows nudge one hole (`Shift` five) · `Ctrl Z` / `Ctrl Y` ·
`Ctrl C` / `Ctrl V` / `Ctrl D` duplicate · `Delete` · `Ctrl A` select all on
this side · `Esc` cancel

**Right-click** anything for its own menu — rotate, mirror, flip side,
auto-route, straighten, properties, duplicate, delete. Right-clicking while
placing a part offers **Finish placing** along with rotate and mirror.
`Duplicate` drops the copy into the nearest free space rather than on top of
the original.

**File** `Ctrl S` save · `Ctrl O` open · `Ctrl N` new · `Ctrl E` checks ·
`Ctrl P` build sheet · `?` shortcut list

---

## Part definition format

A part is plain data, so `parts/builtin-parts.js` and any exported library are
straightforward to hand-edit:

```js
{
  id: 'nano-v3',
  name: 'Arduino Nano v3',
  category: 'Dev boards',
  refPrefix: 'U',                 // designators become U1, U2, …
  desc: '18 x 45 mm, 0.6" row spacing',
  tags: ['arduino', 'nano', 'atmega328'],
  color: '#1d4f7c',
  shape: 'rounded',               // rounded rect dip header axial led disc
                                  // radial to92 to220 screw tact circle
  w: 15, h: 7,                    // body size, in HOLES
  ox: -0.5, oy: -0.5,             // body top-left, in holes, from the origin
  usb: 'mini',                    // optional connector stub on the silkscreen
  pins: [
    { n: '1', name: 'D1/TX', c: 0, r: 0, type: 'data' },
    { n: '2', name: 'D0/RX', c: 1, r: 0, type: 'data' },
    …
  ]
}
```

A pin with offset `(c, r)` lands on board hole `(part.col + c, part.row + r)`
before rotation and mirroring are applied. Pin `type` is cosmetic apart from
`pwr` / `gnd`, which the power-short check uses; the values are `io`, `pwr`,
`gnd`, `analog`, `clk`, `data` and `nc`.

An exported library is a JSON array of these objects. Importing one merges by
`id`, replacing anything that already exists.

---

## Project file format

```jsonc
{
  "format": "protoboard-studio",
  "version": 3,
  "meta":    { "name": "…", "notes": "…", "created": "…", "modified": "…" },
  "board":   { "cols": 30, "rows": 20, "pitch": 2.54, "type": "perf",
               "stripAxis": "row", "margin": 3, "color": "#1d6b45",
               // breadboard-style boards: the band stack, top to bottom
               "bands": [{ "kind": "rail", "rows": 1 },
                         { "kind": "blank", "rows": 1 },
                         { "kind": "group", "rows": 5 },
                         { "kind": "blank", "rows": 2, "mounts": true },
                         { "kind": "group", "rows": 5 },
                         { "kind": "blank", "rows": 1 },
                         { "kind": "rail", "rows": 1 }],
               "voids": ["12,7", "13,7"],        // holes removed by hand
               … },
  "library": { "<defId>": { …part definition… } },
  "parts":   [ { "id": "…", "def": "nano-v3", "ref": "U1",
                 "col": 3, "row": 7, "rot": 0, "mirror": false, "side": "front" } ],
  "wires":   [ { "id": "…", "side": "back", "mode": "ortho",
                 "pts": [ { "c": 3, "r": 10 }, { "c": 9, "r": 10 } ],
                 "color": "#e04b4b", "gauge": 0.51, "net": null } ],
  "rats":    [ … unrouted links … ],
  "cuts":    [ { "col": 8, "row": 4, "axis": "row", "style": "knife" } ],
  "texts":   [ … ],
  "nets":    [ { "id": "…", "name": "GND", "color": "#2f3540" } ]
}
```

Older files are migrated on load, so a project saved by an earlier version
still opens.

---

## Source layout

```
index.html                 markup and panel structure
css/app.css                the whole UI theme
parts/builtin-parts.js     stock part library (data only)
js/util.js                 DOM/SVG builders, geometry, colour, files
js/model.js                document schema, state, undo/redo, event bus
js/parts.js                part registry, search, footprint geometry
js/board.js                substrate geometry, copper connectivity, cuts
js/nets.js                 nets, netlist, BOM, cut list, design checks
js/router.js               elbow/45°/free paths and the A* auto-router
js/view.js                 pan/zoom camera and the rulers
js/render.js               SVG scene rendering
js/tools.js                pointer interaction for every tool
js/ui.js                   menus, panels, dialogs, commands, status bar
js/partdesigner.js         the visual footprint editor
js/io.js                   save/load, exports, build sheet, autosave
js/main.js                 bootstrap, keyboard, example project
```

Files load in that order as classic scripts sharing a single `PB` global — no
bundler, no module loader, and it works straight from `file://`.
