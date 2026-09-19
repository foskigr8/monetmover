import {
  state, emitter, importFile, addMedia, initTracks,
  clipById, sequenceDuration, selectAllInFocus, selectClip, selectNone, clipAtPoint, clipHandleAt, clipRect, clipAt, refitAll,
} from "./modules/state.js";
import {
  actAddTrack, actInsertPrepared, actDelete, actDeleteSelection, actSplitAllAtPlayhead, actNewSequence, actSetTransform, actTrimClip, actMoveClip,
} from "./modules/actions.js";
import { history } from "./modules/commands.js";
import { serializeDocument, restoreDocument, documentToJson } from "./modules/document.js";
import { Player } from "./modules/player.js";
import { TimelineUI } from "./modules/timeline-ui.js";
import { BinUI } from "./modules/bin-ui.js";
import { InspectorUI } from "./modules/inspector-ui.js";
import { exportSequence, mimeExt } from "./modules/export.js";
import { audio } from "./modules/audio.js";
import { ensureWaveform, clipPeaks } from "./modules/waveform.js";
import { fmtTime, fmtSec, clamp } from "./modules/util.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- boot
initTracks();

const programCanvas = $("program-canvas");
const sourceCanvas = $("source-canvas");

let lastProgTC = "", lastSrcTC = "", lastPlayingIcon = "";

const player = new Player(programCanvas, sourceCanvas, onTick);
const tl = new TimelineUI();
const bin = new BinUI();
const insp = new InspectorUI();

bin.onSelect = (id) => player.loadSource(id);
bin.onDbl = (id) => player.loadSource(id);

// Unlock audio on the very first user interaction (real browsers require a user gesture
// before an AudioContext can start). This runs before the user clicks Play, so playback
// is never blocked by the autoplay policy.
const unlockAudio = () => audio.resume();
window.addEventListener("pointerdown", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });
window.addEventListener("touchstart", unlockAudio, { once: true });
tl.render();
bin.render();

// ---------------------------------------------------------------- UI tick
function onTick() {
  tl.updatePlayhead();
  const pt = fmtTime(state.playhead);
  if (pt !== lastProgTC) { $("prog-tc").textContent = pt; lastProgTC = pt; }
  const st = fmtTime(state.src.t);
  if (st !== lastSrcTC) { $("src-tc").textContent = st; lastSrcTC = st; }
  // source scrub slider + io meta
  const media = state.src.mediaId ? state.media.get(state.src.mediaId) : null;
  const dur = media ? (media.duration || media._clipLen || 3) : 1;
  const range = $("src-time");
  range.max = String(Math.max(0.001, dur));
  if (!range.matches(":active")) range.value = String(state.src.t);
  const io = $("src-io");
  if (io) io.textContent = `in ${state.src.in.toFixed(2)}s / out ${state.src.out != null ? state.src.out.toFixed(2) + "s" : "—"}`;
  updateSrcSeg();
  // transport play icons
  const progIcon = player.playing ? "⏸" : "▶";
  if (progIcon !== lastPlayingIcon) { $("tp-play").textContent = progIcon; lastPlayingIcon = progIcon; }
  const srcIcon = state.src.playing ? "⏸" : "▶";
  const srcPlayBtn = $("src-play");
  if (srcPlayBtn && srcPlayBtn.textContent !== srcIcon) { srcPlayBtn.textContent = srcIcon; }
}

// Update the Source In/Out segment bar so the user can SEE exactly which part is selected.
function updateSrcSeg() {
  const bar = $("src-seg"); if (!bar) return;
  const media = state.src.mediaId ? state.media.get(state.src.mediaId) : null;
  const dur = media ? (media.duration || media._clipLen || 3) : 1;
  const inP = clamp((state.src.in / dur) * 100, 0, 100);
  const outP = clamp((state.src.out / dur) * 100, 0, 100);
  const tP = clamp((state.src.t / dur) * 100, 0, 100);
  $("seg-dim-l").style.width = inP + "%";
  $("seg-dim-r").style.left = outP + "%";
  $("seg-dim-r").style.width = (100 - outP) + "%";
  const region = $("seg-region");
  region.style.left = inP + "%";
  region.style.width = Math.max(0, outP - inP) + "%";
  $("seg-in").style.left = `calc(${inP}% - 5px)`;
  $("seg-out").style.left = `calc(${outP}% - 5px)`;
  $("seg-ph").style.left = `calc(${tP}% - 1px)`;
  const len = state.src.out - state.src.in;
  $("seg-label").textContent = len > 0 ? `▣ ${len.toFixed(1)}s selected` : "";
  // keep the loop toggle in sync with state
  const loopBox = $("src-loop");
  if (loopBox && loopBox.checked !== !!state.src.loop) loopBox.checked = !!state.src.loop;
}

// single seek path: timeline ruler -> player -> (state.playhead + redraw + UI)
emitter.on("seek:playhead", (t) => player.seek(t));
// keep the program preview in sync with structural + property changes (incl. live effects while paused)
emitter.on("change", () => { player.redraw = true; });
emitter.on("filter", () => { player.redraw = true; });

// ---------------------------------------------------------------- import
async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const imported = [];
  for (const f of files) {
    try {
      const media = await importFile(f);
      addMedia(media);
      ensureWaveform(media); // decode real audio peaks for its timeline waveform (async)
      imported.push(media.id);
    } catch (err) {
      toast(`Could not load “${f.name}”: ${err.message}`);
    }
  }
  bin.render();
  if (!state.src.mediaId && imported.length) {
    bin.select(imported[0]);
    player.loadSource(imported[0]);
  }
}

$("file-input").addEventListener("change", (e) => { importFiles(e.target.files); e.target.value = ""; });
$("btn-import").addEventListener("click", () => $("file-input").click());

// drop anywhere
const veil = $("drop-veil");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (hasFiles(e)) { dragDepth++; veil.classList.add("show"); }
});
window.addEventListener("dragleave", (e) => {
  if (hasFiles(e)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) veil.classList.remove("show"); }
});
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
    dragDepth = 0; veil.classList.remove("show");
    importFiles(e.dataTransfer.files);
  }
});
function hasFiles(e) { return e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"); }

// ---------------------------------------------------------------- topbar
$("btn-new").addEventListener("click", () => {
  if (!state.tracks.some((t) => t.clips.length) && state.media.size === 0) { toast("Already empty."); return; }
  player.pause();
  actNewSequence();
  player.seek(0);
});

$("seq-name").addEventListener("input", (e) => { state.sequenceName = e.target.value; });

// ---------------------------------------------------------------- composition settings
// The composition is the project's own output frame. Changing it never touches imported
// media — the preview is just a window into the comp, and footage is placed by fitMode.
function applyComp() {
  player._applyComp();   // resize the program canvas to the comp's output size
  refitAll();            // re-fit every clip into the (new) frame per the active fit mode
}
function syncCompUI() {
  const c = state.comp;
  $("comp-w").value = c.width; $("comp-h").value = c.height; $("comp-fps").value = String(c.fps);
  $("comp-fit").value = state.fitMode || "fit";
  const preset = c.width + "x" + c.height;
  const sel = $("comp-preset");
  sel.value = [...sel.options].some((o) => o.value === preset) ? preset : "custom";
}
$("btn-comp").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("comp-pop");
  if (pop.classList.contains("open")) { pop.classList.remove("open"); }
  else { syncCompUI(); pop.classList.add("open"); }
});
document.addEventListener("click", (e) => {
  const pop = $("comp-pop");
  if (pop.classList.contains("open") && !e.target.closest(".comp-wrap")) pop.classList.remove("open");
});
$("comp-preset").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v === "custom") return;
  const [w, h] = v.split("x").map(Number);
  state.comp.width = w; state.comp.height = h;
  syncCompUI(); applyComp();
});
$("comp-w").addEventListener("change", (e) => { state.comp.width = clamp(parseInt(e.target.value, 10) || 1280, 16, 4096); syncCompUI(); applyComp(); });
$("comp-h").addEventListener("change", (e) => { state.comp.height = clamp(parseInt(e.target.value, 10) || 720, 16, 4096); syncCompUI(); applyComp(); });
$("comp-fps").addEventListener("change", (e) => { state.comp.fps = parseInt(e.target.value, 10) || 30; emitter.emit("change"); });
$("comp-fit").addEventListener("change", (e) => { state.fitMode = e.target.value; refitAll(); });

// Save / Open the versioned project document (structure + edit data).
// Media blobs don't survive a reload, so saved assets are re-linkable on open.
function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime || "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$("btn-save").addEventListener("click", () => {
  const doc = serializeDocument();
  download(slug(state.sequenceName) + ".mmproj", documentToJson(doc));
  toast(`Saved ${doc.tracks.reduce((n, t) => n + t.clips.length, 0)} clips across ${doc.tracks.length} tracks.`);
});
$("btn-open").addEventListener("click", () => $("proj-input").click());
$("proj-input").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const doc = JSON.parse(await file.text());
    const tracks = restoreDocument(doc);
    applyComp();        // re-size the program canvas to the restored composition
    syncCompUI();
    bin.render();
    player.seek(0);
    toast(`Opened project (${tracks} tracks). Missing media can be re-linked by re-importing.`);
  } catch (err) {
    toast("Could not open project: " + (err.message || err));
  }
});

// ---------------------------------------------------------------- transport
$("tp-play").addEventListener("click", () => player.toggle());
$("tp-to-start").addEventListener("click", () => player.toStart());
$("tp-to-end").addEventListener("click", () => player.toEnd());
$("tp-prev").addEventListener("click", () => player.prevEdit());
$("tp-next").addEventListener("click", () => player.nextEdit());
$("tp-loop").addEventListener("change", (e) => { state.loop = e.target.checked; });
$("tp-split").addEventListener("click", () => { const n = actSplitAllAtPlayhead(); if (!n) toast("Playhead is not inside a clip."); });

// source
$("src-play").addEventListener("click", () => player.toggleSource());
$("src-time").addEventListener("input", (e) => { player._seekSource(parseFloat(e.target.value)); onTick(); });
$("src-set-in").addEventListener("click", () => { state.src.in = clamp(state.src.t, 0, state.src.out - 0.05); onTick(); });
$("src-set-out").addEventListener("click", () => { state.src.out = clamp(state.src.t, state.src.in + 0.05, srcDur()); onTick(); });

// Source segment bar: click to scrub, drag the In/Out handles to trim the selection.
const srcDur = () => { const m = state.src.mediaId ? state.media.get(state.src.mediaId) : null; return m ? (m.duration || m._clipLen || 3) : 1; };
const srcTimeFromX = (clientX) => {
  const bar = $("src-seg").getBoundingClientRect();
  return clamp(((clientX - bar.left) / bar.width) * srcDur(), 0, srcDur());
};
$("src-seg").addEventListener("pointerdown", (e) => {
  if (e.target.closest(".seg-handle")) return; // handles handled below
  audio.resume();
  player._seekSource(srcTimeFromX(e.clientX));
  const move = (ev) => player._seekSource(srcTimeFromX(ev.clientX));
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});
function bindSegHandle(id, which) {
  $(id).addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const move = (ev) => {
      let t = srcTimeFromX(ev.clientX);
      if (which === "in") { state.src.in = clamp(t, 0, state.src.out - 0.05); }
      else { state.src.out = clamp(t, state.src.in + 0.05, srcDur()); }
      player._seekSource(state.src[which]); // move the playhead with the handle so the preview follows
      onTick();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}
bindSegHandle("seg-in", "in");
bindSegHandle("seg-out", "out");
// Source playback mode: once, loop, or play range once
$("src-loop-mode").addEventListener("change", (e) => {
  state.src.loopMode = e.target.value;
  // For backward compatibility
  state.src.loop = e.target.value === "loop";
  if (!state.src.loop && state.src.playing) {
    // keep playing to the end
  }
});
// clear source actions: append / insert the SELECTED segment
$("src-insert").addEventListener("click", () => {
  const m = bin.getSelected() || (state.src.mediaId ? state.media.get(state.src.mediaId) : null);
  if (!m) return toast("Load a media item into the Source first (click one in the Project panel).");
  const kind = m.type === "audio" ? "audio" : "video";
  const track = state.tracks.find((t) => t.kind === kind) || state.tracks[0];
  const offset = state.src.in || 0;
  const len = Math.max(0.1, state.src.out - offset);
  addClipAt(track.id, state.playhead, offset, len, m.id);
});
$("src-append").addEventListener("click", () => {
  const m = bin.getSelected() || (state.src.mediaId ? state.media.get(state.src.mediaId) : null);
  if (!m) return toast("Load a media item into the Source first (click one in the Project panel).");
  const kind = m.type === "audio" ? "audio" : "video";
  const track = state.tracks.find((t) => t.kind === kind) || state.tracks[0];
  let end = 0; for (const c of track.clips) end = Math.max(end, c.start + c.duration);
  const offset = state.src.in || 0;
  const len = Math.max(0.1, state.src.out - offset);
  addClipAt(track.id, end, offset, len, m.id);
});

// ---------------------------------------------------------------- bin tools
$("bin-append").addEventListener("click", () => {
  const m = bin.getSelected(); if (!m) return toast("Select a media item in the Project panel first.");
  const kind = m.type === "audio" ? "audio" : "video";
  const track = state.tracks.find((t) => t.kind === kind) || state.tracks[0];
  let end = 0; for (const c of track.clips) end = Math.max(end, c.start + c.duration);
  const offset = kind === "audio" || m.type === "image" ? 0 : state.src.in || 0;
  const len = m.type === "image" ? (m._clipLen || 3) : (m.duration - offset) || m.duration;
  addClipAt(track.id, end, offset, len, m.id);
});
$("bin-insert").addEventListener("click", () => {
  const m = bin.getSelected(); if (!m) return toast("Select a media item in the Project panel first.");
  const kind = m.type === "audio" ? "audio" : "video";
  const track = state.tracks.find((t) => t.kind === kind) || state.tracks[0];
  const offset = m.type === "image" ? 0 : (state.src.in || 0);
  const out = state.src.out;
  const len = m.type === "image" ? (m._clipLen || 3) : (out != null ? out - offset : m.duration - offset) || m.duration;
  addClipAt(track.id, state.playhead, offset, len, m.id);
});

function addClipAt(trackId, start, offset, duration, mediaId) {
  actInsertPrepared({ mediaId, trackId, start: Math.max(0, start), offset: Math.max(0, offset), duration: Math.max(0.1, duration) });
}

// ---------------------------------------------------------------- timeline toolbar
$("tool-select").addEventListener("click", () => tl.setTool("select"));
$("tool-razor").addEventListener("click", () => tl.setTool("razor"));
$("snap-toggle").addEventListener("change", (e) => { state.snap = e.target.checked; });
$("zoom-in").addEventListener("click", () => tl.zoom(1.2));
$("zoom-out").addEventListener("click", () => tl.zoom(1 / 1.2));
$("zoom-fit").addEventListener("click", () => tl.zoomFit());
$("add-vtrack").addEventListener("click", () => actAddTrack("video"));
$("add-audtrack").addEventListener("click", () => actAddTrack("audio"));

// ctrl/cmd + wheel zoom on timeline
$("tl-scroll").addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    tl.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }
}, { passive: false });

// ---------------------------------------------------------------- clipboard
// Copy / Cut / Paste of timeline clips. Ctrl+C copies the selected clip to an
// in-app clipboard; Ctrl+X copies then removes it; Ctrl+V inserts a copy at the
// playhead on the same track (Ctrl+K splits at the playhead, like Premiere).
let clipboard = null; // { mediaId, offset, duration, volume, filters, trackId }

function clipboardCopy() {
  const f = clipById(state.selectedClipId);
  if (!f) { toast("Select a clip on the timeline first."); return; }
  clipboard = {
    mediaId: f.clip.mediaId,
    offset: f.clip.offset,
    duration: f.clip.duration,
    volume: f.clip.volume,
    filters: { ...f.clip.filters },
    trackId: f.track.id,
  };
  toast("Copied clip — paste with Ctrl/⌘+V at the playhead.");
}

function clipboardCut() {
  if (!state.selectedClipId) { toast("Select a clip on the timeline first."); return; }
  const f = clipById(state.selectedClipId);
  clipboard = {
    mediaId: f.clip.mediaId,
    offset: f.clip.offset,
    duration: f.clip.duration,
    volume: f.clip.volume,
    filters: { ...f.clip.filters },
    trackId: f.track.id,
  };
  actDelete(state.selectedClipId);
  toast("Cut clip — paste with Ctrl/⌘+V.");
}

function clipboardPaste() {
  if (!clipboard) { toast("Clipboard is empty (Ctrl/⌘+C or Ctrl/⌘+X first)."); return; }
  const track = state.tracks.find((t) => t.id === clipboard.trackId) || state.tracks[0];
  actInsertPrepared({
    mediaId: clipboard.mediaId,
    trackId: track.id,
    start: Math.max(0, state.playhead),
    offset: Math.max(0, clipboard.offset),
    duration: Math.max(0.1, clipboard.duration),
    volume: clipboard.volume,
    filters: clipboard.filters,
  });
  toast("Pasted at playhead.");
}

// ---------------------------------------------------------------- direct canvas manipulation
// The preview canvas is an editing surface: select, drag to move, drag a handle to resize.
// Movement/resizing are CONTINUOUS (comp-space px == pointer px, 1:1) — no rounding or
// grid snapping. It updates the same transform the inspector reads, so both always agree.
function bindCanvasManipulation() {
  programCanvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (state.tool !== "select") return;
    const rect = programCanvas.getBoundingClientRect();
    const sc = state.comp.width / rect.width; // screen px -> comp units
    const px = (e.clientX - rect.left) * sc;
    const py = (e.clientY - rect.top) * sc;
    const handleR = 10 * sc; // ~10 screen px grab zone, constant at any preview scale
    state.focus = "canvas";

    // what did we hit?
    let target = null, handle = null;
    // check selected clips' handles first (so resizing the selected object wins)
    for (const tr of state.tracks) {
      if (tr.kind !== "video" || tr.hidden) continue;
      const c = tr.clips.find((x) => x.id === state.selectedClipId);
      if (!c) continue;
      if (clipAt(tr.id, state.playhead) !== c) continue;
      const h = clipHandleAt(c, state.comp, px, py, handleR);
      if (h) { target = c; handle = h; break; }
    }
    if (!target) {
      target = clipAtPoint(state.playhead, px, py);
      if (target) handle = clipHandleAt(target, state.comp, px, py, handleR) || "move";
    }
    if (!target) {
      if (e.shiftKey) selectClip(null); else selectNone();

      player.redraw = true;
      return; // empty area -> clear selection (no drag)
    }

    selectClip(target.id, { add: e.shiftKey });
    player.redraw = true;
    const t0 = target.transform;
    const startX = e.clientX, startY = e.clientY;
    const moving = (handle === "move");
    const startRect = { x: state.comp.width / 2 + t0.x - t0.w / 2, y: state.comp.height / 2 + t0.y - t0.h / 2, w: t0.w, h: t0.h };
    const origAspect = t0.w / t0.h;
    const origW = t0.w, origH = t0.h;
    let committed = false;

    // Set cursor based on handle
    if (handle === "move") programCanvas.style.cursor = "move";
    else if (handle === "nw" || handle === "se") programCanvas.style.cursor = "nwse-resize";
    else if (handle === "ne" || handle === "sw") programCanvas.style.cursor = "nesw-resize";
    else if (handle === "n" || handle === "s") programCanvas.style.cursor = "ns-resize";
    else if (handle === "w" || handle === "e") programCanvas.style.cursor = "ew-resize";

    const applyTransform = (x, y, w, h) => {
      target.transform = { ...t0, x, y, w: Math.max(4, w), h: Math.max(4, h) };
      player.redraw = true;
    };

    const move = (ev) => {
      const dx = (ev.clientX - startX) * sc;
      const dy = (ev.clientY - startY) * sc;
      
      if (moving) {
        const x = t0.x + dx;
        const y = t0.y + dy;
        applyTransform(x, y, t0.w, t0.h);
      } else {
        let left = startRect.x, top = startRect.y, right = startRect.x + startRect.w, bottom = startRect.y + startRect.h;
        if (handle.includes("w")) left = startRect.x + dx;
        if (handle.includes("e")) right = startRect.x + startRect.w + dx;
        if (handle.includes("n")) top = startRect.y + dy;
        if (handle.includes("s")) bottom = startRect.y + startRect.h + dy;
        
        let nw = Math.max(4, right - left);
        let nh = Math.max(4, bottom - top);
        
        // If not holding Shift, constrain to aspect ratio
        if (!ev.shiftKey) {
          const widthDriven = handle.includes("w") || handle.includes("e");
          if (widthDriven) {
            nh = nw / origAspect;
          } else {
            nw = nh * origAspect;
          }
          
          // Recalculate position
          if (handle.includes("w")) left = right - nw;
          if (handle.includes("n")) top = bottom - nh;
        }
        
        // Snap to original size when close (within 5%)
        const currentArea = nw * nh;
        const origArea = origW * origH;
        const areaRatio = currentArea / origArea;
        if (areaRatio > 0.95 && areaRatio < 1.05 && !ev.shiftKey) {
          nw = origW;
          nh = origH;
          if (handle.includes("w")) left = right - nw;
          if (handle.includes("n")) top = bottom - nh;
        }
        
        const x = ((left + nw / 2) - state.comp.width / 2);
        const y = ((top + nh / 2) - state.comp.height / 2);
        
        applyTransform(x, y, nw, nh);
      }
      
      if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) committed = true;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      programCanvas.style.cursor = "";
      if (committed) {
        const final = { ...target.transform };
        target.transform = { ...t0 };
        actSetTransform(target.id, final);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}
bindCanvasManipulation();
window.addEventListener("keydown", (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  const mod = e.ctrlKey || e.metaKey;

  // --- Ctrl/⌘ edit shortcuts (checked before single-key so 'C' ≠ razor) ---
  if (mod) {
    switch (e.key.toLowerCase()) {
      case "c": e.preventDefault(); clipboardCopy(); return;
      case "x": e.preventDefault(); clipboardCut(); return;
      case "v": e.preventDefault(); clipboardPaste(); return;
      case "k": e.preventDefault(); { const n = actSplitAllAtPlayhead(); if (!n) toast("Playhead is not inside a clip."); } return;
      case "a": e.preventDefault(); selectAllInFocus(); tl.render(); return; // select all in current focus context
      case "z":
        e.preventDefault();
        if (e.shiftKey) { if (!history.redo()) toast("Nothing to redo."); }
        else { if (!history.undo()) toast("Nothing to undo."); }
        return;
    }
    return;
  }

  // --- single-key shortcuts ---
  switch (e.key) {
    case " ": e.preventDefault(); player.toggle(); break;
    case "s": case "S": { const n = actSplitAllAtPlayhead(); if (!n) toast("Playhead is not inside a clip."); break; }
    case "v": case "V": tl.setTool("select"); break;   // Select tool
    case "a": case "A": tl.setTool("select"); break;   // A always forces Select
    case "c": case "C": tl.setTool("razor"); break;    // Razor (returns to Select after a cut)
    case "Delete": case "Backspace":
      e.preventDefault();
      if (state.selection.length) actDeleteSelection(state.selection.slice());
      break;
    case "ArrowLeft":
      e.preventDefault();
      player.seek(state.playhead - (e.shiftKey ? 1 : 1 / state.pps));
      break;
    case "ArrowRight":
      e.preventDefault();
      player.seek(state.playhead + (e.shiftKey ? 1 : 1 / state.pps));
      break;
  }
});

// ---------------------------------------------------------------- export
$("btn-export").addEventListener("click", async () => {
  const ov = showExportOverlay();
  try {
    const blob = await exportSequence({
      canvas: programCanvas,
      player,
      onProgress: (p) => setExportProgress(ov, p),
    });
    const mime = "video/webm";
    const ext = blob.type && blob.type.includes("mp4") ? "mp4" : "webm";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(state.sequenceName)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    ov.remove();
    toast(`Exported ${a.download} (${(blob.size / 1048576).toFixed(1)} MB)`);
  } catch (err) {
    ov.remove();
    toast("Export failed: " + (err.message || err));
  }
});

function showExportOverlay() {
  const ov = document.createElement("div");
  ov.className = "drop-veil show";
  ov.style.cursor = "wait";
  ov.innerHTML = `
    <div style="background:var(--bg-3);border:1px solid var(--line-2);border-radius:12px;padding:28px 36px;min-width:360px;text-align:center">
      <div style="font-size:16px;font-weight:600;margin-bottom:6px">Rendering sequence…</div>
      <div style="color:var(--text-dim);font-size:12px;margin-bottom:16px">Playing back the timeline to encode. Don't close this tab.</div>
      <div class="xbar"><div class="xbar-fill"></div></div>
      <div class="xpct" style="margin-top:10px;font-family:Consolas,monospace;color:var(--text-dim)">0%</div>
    </div>`;
  document.body.appendChild(ov);
  // inject minimal styles
  if (!document.getElementById("xstyles")) {
    const s = document.createElement("style");
    s.id = "xstyles";
    s.textContent = `.xbar{height:8px;background:var(--bg-4);border-radius:4px;overflow:hidden}.xbar-fill{height:100%;width:0;background:var(--orange);transition:width .12s linear}`;
    document.head.appendChild(s);
  }
  return ov;
}
function setExportProgress(ov, p) {
  const fill = ov.querySelector(".xbar-fill");
  const pct = ov.querySelector(".xpct");
  if (fill) fill.style.width = Math.round(p * 100) + "%";
  if (pct) pct.textContent = Math.round(p * 100) + "%";
}

// ---------------------------------------------------------------- toast
let toastTimer = null;
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#000c;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:200;box-shadow:0 6px 20px #0008;transition:opacity .3s;max-width:80vw";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = "0"; }, 3200);
}

function slug(s) {
  return (s || "sequence").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sequence";
}

// ---------------------------------------------------------------- resizable panels
// Drag a split handle to resize the bin / inspector (widths) or the timeline (height).
function initResize() {
  const app = document.getElementById("app");
  const middle = document.querySelector(".middle");
  const num = (s, fb) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : fb; };
  document.querySelectorAll(".split, .split-mon").forEach((h) => {
    h.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const kind = h.dataset.resize;
      const startX = e.clientX, startY = e.clientY;
      const startTlH = num(getComputedStyle(app).getPropertyValue("--tl-h"), 360);
      const startBinW = num(getComputedStyle(middle).getPropertyValue("--bin-w"), 300);
      const startInspW = num(getComputedStyle(middle).getPropertyValue("--insp-w"), 280);
      const startProgW = document.getElementById("program-monitor").getBoundingClientRect().width; // px, exact
      h.classList.add("active");
      document.body.style.userSelect = "none";
      document.body.style.cursor = kind === "timeline" ? "row-resize" : "col-resize";
      const move = (ev) => {
        if (kind === "timeline") {
          let hgt = startTlH + (startY - ev.clientY); // drag up => taller
          app.style.setProperty("--tl-h", clamp(hgt, 160, window.innerHeight - 40 - 160) + "px");
        } else if (kind === "bin") {
          const w = startBinW + (ev.clientX - startX); // drag right => wider
          middle.style.setProperty("--bin-w", clamp(w, 180, window.innerWidth * 0.5) + "px");
        } else if (kind === "inspector") {
          const w = startInspW - (ev.clientX - startX); // drag left => wider
          middle.style.setProperty("--insp-w", clamp(w, 200, window.innerWidth * 0.5) + "px");
        } else if (kind === "monitor") {
          // FREE / CONTINUOUS: program width in px tracks the pointer 1:1 (no rounding/step).
          const bar = document.querySelector(".monitors").getBoundingClientRect();
          const min = 220, max = Math.max(min + 40, bar.width - 180);
          const w = clamp(startProgW + (ev.clientX - startX), min, max);
          document.querySelector(".monitors").style.setProperty("--prog-w", w + "px");
        }
      };
      const up = () => {
        h.classList.remove("active");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  });
}
initResize();

// expose for other modules + automated tests / debugging (and the future AI bridge)
window.__state = state;
window.__player = player;
window.__audio = audio;
window.__history = history;
window.__clipboard = () => clipboard;
window.__doc = { serializeDocument, restoreDocument, documentToJson };
// test / debugging hooks
window.__clipPeaks = (clipId) => {
  for (const tr of state.tracks) { const c = tr.clips.find((x) => x.id === clipId); if (c) { const m = state.media.get(c.mediaId); return c && m ? clipPeaks(m.id, c.offset, c.duration, m.duration || 0) : null; } }
  return null;
};
window.__rangePeaks = (offset, duration) => {
  const m = [...state.media.values()][0];
  return m ? clipPeaks(m.id, offset, duration, m.duration || 0) : null;
};
window.__trim = (clipId, start, offset, duration) => actTrimClip(clipId, { start, offset, duration });
window.__move = (clipId, start, trackId) => actMoveClip(clipId, start, trackId);
console.log("MonetMover editor ready");
