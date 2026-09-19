# MonetMover — Browser Video Editor

A non-linear video editor (Adobe Premiere-style) that runs entirely in the browser.
No backend, no build step, no dependencies to run it — just open it in a modern browser.
Built from scratch with plain HTML, CSS, ES modules and the Web platform's media APIs
(HTMLMediaElement, Canvas 2D, Web Audio, `MediaRecorder`).

> **MonetMover** is a from-scratch, standalone editor. It does **not** modify or delete
> anything outside this folder.

---

## Run it

The app uses ES modules and needs to be served over HTTP (not opened as `file://`).

```bash
cd premier
npm run dev          # serves http://127.0.0.1:3090
```

Then open **http://127.0.0.1:3090**. Any static server works:

```bash
python3 -m http.server 3090
# or: npx serve .
```

Works best in **Chrome / Edge** (they have the most complete `MediaRecorder` + Web
Audio support). Firefox works for editing/preview; export may fall back to WebM.

---

## What you can do

**Project / media bin (left)**
- Import **video, audio and image** files via the *Import Media* button or by
  **dragging files anywhere** onto the window.
- Double-click an item to load it into the **Source monitor**; single-click to select.
- **Append →** puts the selected item at the end of its track; **Insert @ playhead**
  puts it at the playhead (honoring the Source In/Out points).

**Monitors (center)**
- **Program** — live composite of the timeline (top video track over lower ones).
  Play/pause, jump to start/end, prev/next edit, loop, and split-at-playhead.
- **Source** — preview a media item, scrub it, and **choose exactly the segment you
  want**: a segment bar shows the In/Out region; drag the white handles to trim it,
  or use *⟨ In* / *Out ⟩*. Then **Insert @ playhead** / **Append →** drops just that
  selected portion onto the timeline.

**Resizable workspace**
- Drag the thin boundaries to resize anything: the **Project | Preview | Inspector**
  columns, and the **Preview ⇄ Timeline** split. Tune the workspace to what you're
  doing — bigger preview for visuals, bigger timeline for precise edits.

**Inspector (right)**
- Volume, opacity, and video **effects**: brightness, contrast, saturation, blur,
  grayscale, sepia, hue-rotate — updated live on the Program monitor.
- Actions: Split @ playhead, Duplicate, Ripple delete, Delete.

**Timeline (bottom)**
- Multiple **video (V)** and **audio (A)** tracks (add more with the toolbar).
- **Drag** a clip from the bin onto a track; **drag** clips to reposition (with
  magnetic snapping) or to a different compatible track.
- **Trim** by dragging a clip's left/right edge; **Razor** (C) to cut a clip at the
  playhead or at the click point; **M/H** to mute/hide a track.
- **Zoom** with the +/− buttons, *Fit*, or **Ctrl/Cmd + scroll wheel**.
- Per-track **Mute** and **Hide**.

**Export**
- **Export** plays the sequence back through a compositor and records it to a
  downloadable **WebM** (video + mixed audio) using `MediaRecorder`.
- Keep the tab in the foreground while rendering (it plays back in real time).

**Project (save / open)**
- **Save** writes the whole project as a versioned `.mmproj` document (structure,
  tracks, clips, in/points, effects, composition settings).
- **Open** restores it. Media blobs don't survive a reload, so imported files are
  re-linkable (the timeline and every edit remain intact — §58 missing-media).

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / Pause |
| `Ctrl/⌘ + C` | **Copy** selected clip to the clipboard |
| `Ctrl/⌘ + X` | **Cut** selected clip (copy + remove) |
| `Ctrl/⌘ + V` | **Paste** the clipboard clip at the playhead |
| `Ctrl/⌘ + K` or `S` | Split all clips at the playhead (razor) |
| `Ctrl/⌘ + Z` | **Undo** (one semantic edit) |
| `Ctrl/⌘ + Shift + Z` | **Redo** |
| `V` | Select tool (move / trim) |
| `C` | Razor tool |
| `Delete` / `Backspace` | Delete selected clip |
| `←` / `→` | Nudge playhead (1 frame; hold `Shift` for 1 s) |

> `Ctrl/⌘` is `Cmd` on macOS. Paste drops the clip onto the same track it was copied
> from, at the current playhead position (its In-point and effects are preserved).

---

## Tests

```bash
npm test              # pure data-model unit tests (no browser needed)
```

For a full end-to-end test (import → edit → play → export in headless Chromium):

```bash
npm run test:install  # installs playwright + chromium (one time)
npm run dev           # in another terminal
npm run test:smoke    # ~17 automated checks
```

---

## Architecture

| File | Responsibility |
| --- | --- |
| `index.html` | Layout: top bar, project bin, monitors, inspector, timeline |
| `styles.css` | Dark NLE theme + resizable panel layout |
| `app.js` | Wires modules, transport, keyboard, import/export, save/open, resize, undo |
| `modules/state.js` | Single source of truth: media, tracks, clips, composition settings, raw mutators |
| `modules/actions.js` | **Semantic edit actions** — every state mutation routed through here |
| `modules/commands.js` | **Command/transaction core + undo/redo** history |
| `modules/document.js` | **Versioned project document** (serialize / validate / migrate / restore) |
| `modules/player.js` | Master clock (rAF), per-clip element sync, canvas compositing, source preview, export hooks |
| `modules/audio.js` | Web Audio graph: one `MediaElementSource`+`Gain` per clip |
| `modules/timeline-ui.js` | Timeline DOM, drag/trim/razor, snapping, zoom, ruler scrub |
| `modules/bin-ui.js` | Media bin grid + drag-to-timeline |
| `modules/inspector-ui.js` | Clip property/effect controls (precision tool) |
| `modules/export.js` | `MediaRecorder` capture of the program canvas + audio graph |
| `modules/util.js` | Time formatting, clamps, WebM-duration fix, mime picker |

### Phase 0 — the behavioral foundation (invariants this build enforces)

> **The UI is not the editor.** The UI, timeline, canvas, inspector (and the future AI)
> are all *interfaces to one editor core*. This is what keeps it predictable and lets
> every future feature — and the AI — plug into the same systems instead of forking them.

**1. One source of truth, one way to mutate it.**
All state mutation goes through **semantic actions** (`modules/actions.js`), never
through raw DOM or ad-hoc handlers. The raw mutators in `state.js` are internal.

```
human UI  ─
           ├─▶  action (semantic command)  ─▶  editor core (state)  ─▶  renderer / timeline / audio / preview
future AI ─┘
```

**2. Every mutation is transactional + undoable.** Each action snapshots before/after,
applies, and records a **semantic undo/redo** step (`Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z`).
A command that fails leaves the project unchanged (no half-states). This is the same
mechanism the AI will use — one "logical edit" = one undo step.

**3. A versioned project document is the durable form** (`modules/document.js`).
The live editor is a runtime view; the document (v1, with a `version` field + forward
migrations) is what you **Save/Open**. Preview, export, save/reopen and the AI all
derive from the same structure. Media blobs don't persist, so assets are re-linkable —
the timeline and every edit survive a reload.

**4. Stable identities.** Every track/clip carries a stable `id` (survives move,
duplicate, save/load, re-order) — never an array index or a DOM node.

**5. A defined time model.** The composition has an explicit timebase
(`fps`/`width`/`height`); one master clock drives the playhead, video, audio and
preview so "the same project time means the same thing everywhere." Zoom is a view
concern and never alters project timing.

**6. Non-destructive by default.** Overlapping items on a track coexist; a normal drag
is a *move*, not an overwrite. Explicit editing modes (insert / ripple / overwrite) are
defined in the core so they can be invoked deliberately (next batch).

**7. Renderer-independent semantics.** The document owns meaning; the canvas/DOM is an
adapter. Konva / GSAP / WebCodecs can be introduced later without becoming the project
format.

> **Not yet in this build (defined next):** editing *modes* as explicit user-facing
> operations, explicit track z-order, and canvas direct-manipulation of future elements.
> The architecture already accommodates all of them.

### Key design decisions
- **Single playhead** — `state.playhead` is the only time cursor; the player's clock
  and the timeline ruler both read/write it, so they can never drift.
- **Per-clip media elements** — each timeline clip owns a `<video>`/`<audio>` element
  routed through Web Audio, so every clip has independent volume/offset/effects and
  audio is mixed correctly.
- **Live compositing** — the Program monitor is a 1280×720 canvas; each frame the top
  non-hidden video track is drawn over lower ones with CSS `ctx.filter` effects.
- **Robust to broken media** — `Infinity`/`NaN` durations (a known Chrome quirk with
  recorded WebM blobs) are resolved at import and guarded everywhere, so the UI can
  never freeze.

### Notes / limitations
- Export renders in **real time** and uses the tab's `requestAnimationFrame`, so keep
  it in the foreground; very long sequences take as long to export as to play.
- **Save/Open** persists the project *document* (structure + edits), but **media blobs**
  are in-memory only and do not survive a reload — re-import the same files to relink
  (structure and edits are preserved). Full media relocation/relinking is a later batch.
- Image clips default to a 3-second duration; adjust with the right-edge trim handle.

---

## Vision & roadmap

**Principle: professional flexibility without professional complexity.** Powerful
underneath, simple on top. The long-term goal is an **AI-native** editor where a human
and an AI edit the *same structured project* — the AI adds clips/shapes/animations, the
human drags them, the AI reads the new state and continues. Every AI-generated edit must
stay fully human-editable.

```
Editor UI  <->  Shared Project State  <->  AI Agent
```

| Phase | Focus | Status |
| --- | --- | --- |
| **0 — Behavioral foundation** | Command/transaction/undo-redo core, versioned project document, stable IDs, time model, non-destructive default, source preview states, resizable panels, save/open | ✅ done (this build) |
| **1 — Foundation** | Working preview, import, segment (In/Out) selection, real timeline, drag/drop, multi-track, copy/cut/paste, reliable audio/video playback | ✅ done |
| **1b — Editing modes + direct manipulation** | Explicit move/insert/ripple/overwrite modes, track z-order, multi-select, group/ungroup, layer/track reorder, intentional gaps & overlaps, canvas direct-manipulation | ⏭ next |
| **2 — Editing flexibility** | Text, shapes, more element types, layer management, advanced timeline behavior, more effects | 🔜 |
| **3 — Motion & animation** | Keyframes, animation/timing, motion paths, transform animation, graph editor | 🔜 |
| **4 — AI-native** | AI reads/modifies the project structure; AI edits stay editable; human changes reflect back; MCP-style hooks for external tools | 🔜 |

The project is built in **batches** — solidify the foundation first, add complexity
later — so the UI never collapses into an overwhelming dashboard. Features appear when
they're relevant (select a thing → its controls appear).
