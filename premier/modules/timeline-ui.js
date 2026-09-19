import {
  state, getMedia, snapCandidates, emitter, sequenceDuration, firstTrackOfKind,
  selectClip, selectNone, addSelection, selectMany,
} from "./state.js";
import {
  actAddClip, actMoveClip, actTrimClip, actSplitClip, actRemoveTrack,
  actDelete, actRippleDelete, actDuplicate, actExtractAudio, actToggleLink, actZOrder,
} from "./actions.js";
import { history } from "./commands.js";
import { clipPeaks } from "./waveform.js";
import { fmtTime, fmtSec, clamp, uid } from "./util.js";

const ROW_H = 56;
const RULER_H = 26;
const HEADER_W = 118;

export class TimelineUI {
  constructor() {
    this.scroll = document.getElementById("tl-scroll");
    this.headers = document.getElementById("tl-headers");
    this.canvas = document.getElementById("tl-canvas");
    this.grid = document.getElementById("tl-grid");
    this.playheadEl = null;

    this._drag = null; // {clip, mode, startX, origStart, origOffset, origDur, mediaDur, el, targetTrackId}

    // persistent marquee overlay (re-appended after each canvas rebuild)
    this.marqueeEl = document.createElement("div");
    this.marqueeEl.className = "marquee";
    this.marqueeEl.style.display = "none";

    this._bindGlobal();
    this._bindDrop();
    this._bindMarquee();
  }

  // ------------------------------------------------------------- render
  render() {
    this._saveScroll();
    this._buildHeaders();
    this._buildCanvas();
    this.canvas.appendChild(this.marqueeEl); // rebuild clears children; re-add the marquee
    this._restoreScroll();
    this.updatePlayhead();
    this._updateZoomLabel();
  }

  _saveScroll() { this._sl = this.scroll.scrollLeft; this._st = this.scroll.scrollTop; }
  _restoreScroll() { this.scroll.scrollLeft = this._sl || 0; this.scroll.scrollTop = this._st || 0; }

  _contentWidth() {
    const d = sequenceDuration();
    const safe = Number.isFinite(d) ? d : 0;
    return Math.min(200000, Math.max(1200, (safe + 20) * state.pps));
  }

  _buildHeaders() {
    this.headers.innerHTML = "";
    const spacer = document.createElement("div");
    spacer.className = "ruler-spacer";
    spacer.style.height = RULER_H + "px";
    spacer.style.width = HEADER_W + "px";
    spacer.innerHTML = `<span style="position:absolute;top:6px;left:8px;font-size:10px;color:var(--text-dim);letter-spacing:.5px">TRACKS</span>`;
    spacer.style.position = "sticky";
    spacer.style.top = "0";
    this.headers.appendChild(spacer);

    for (const tr of state.tracks) {
      const h = document.createElement("div");
      h.className = "tl-track-head";
      h.style.width = HEADER_W + "px";
      const kindTag = tr.kind === "video" ? "V" : "A";
      h.innerHTML = `
        <div class="th-name"><span style="color:${tr.kind==='video'?'#6ea8e0':'#7fcf8a'}">${kindTag}</span> ${tr.name}</div>
        <div class="th-ctrls">
          <button class="th-btn ${tr.muted?'off':''}" data-act="mute" title="${tr.kind==='video'?'Mute audio':'Mute'}">${tr.kind==='video'?'M':'M'}</button>
          <button class="th-btn ${tr.hidden?'off':''}" data-act="hide" title="${tr.kind==='video'?'Hide':'Hide'}">${tr.kind==='video'?'H':'H'}</button>
          <button class="th-btn th-del" data-act="del" title="Remove track">✕</button>
        </div>`;
      h.addEventListener("click", () => { state.activeTrackId = tr.id; this.render(); });
      h.querySelector('[data-act=mute]').onclick = (e) => { e.stopPropagation(); tr.muted = !tr.muted; this.render(); };
      h.querySelector('[data-act=hide]').onclick = (e) => { e.stopPropagation(); tr.hidden = !tr.hidden; this.render(); };
      h.querySelector('[data-act=del]').onclick = (e) => { e.stopPropagation(); this._removeTrack(tr); };
      this.headers.appendChild(h);
    }
    this._markActive();
  }

  _markActive() {
    this.headers.querySelectorAll(".tl-track-head").forEach((el, i) => {
      const tr = state.tracks[i];
      el.style.background = tr && tr.id === state.activeTrackId ? "var(--bg-3)" : "";
    });
  }

  _removeTrack(tr) {
    if (state.tracks.length <= 1) return;
    actRemoveTrack(tr.id);
  }

  _buildCanvas() {
    const W = this._contentWidth();
    this.canvas.style.width = W + "px";
    this.canvas.innerHTML = "";

    // ruler
    const ruler = document.createElement("div");
    ruler.className = "ruler";
    ruler.style.width = W + "px";
    this._buildRuler(ruler, W);
    ruler.addEventListener("pointerdown", (e) => this._rulerPointerDown(e));
    this.canvas.appendChild(ruler);

    // track rows
    state.tracks.forEach((tr, idx) => {
      const row = document.createElement("div");
      row.className = "tl-row " + tr.kind + (tr.id === state.activeTrackId ? " active-track" : "");
      row.style.height = ROW_H + "px";
      row.style.width = W + "px";
      row.dataset.trackId = tr.id;
      row.dataset.idx = idx;
      this._buildRowClips(row, tr);
      this.canvas.appendChild(row);
    });

    // playhead
    const ph = document.createElement("div");
    ph.className = "playhead";
    ph.innerHTML = `<div class="ph-cap"></div>`;
    ph.style.left = (state.playhead * state.pps) + "px";
    this.canvas.appendChild(ph);
    this.playheadEl = ph;

    // dropline
    const dl = document.createElement("div");
    dl.className = "tl-dropline";
    dl.id = "tl-dropline";
    dl.style.display = "none";
    this.canvas.appendChild(dl);
  }

  _buildRuler(ruler, W) {
    const pps = state.pps;
    const step = this._tickStep(pps);
    let n = Math.ceil(W / pps / step);
    if (!Number.isFinite(n) || n > 20000) n = 20000; // hard cap, never an infinite loop
    for (let i = 0; i <= n; i++) {
      const t = i * step;
      const tick = document.createElement("div");
      tick.className = "tick major";
      tick.style.left = (t * pps) + "px";
      tick.innerHTML = `<span class="lbl">${this._fmtTick(t)}</span>`;
      ruler.appendChild(tick);
    }
    // minor
    const minor = step >= 1 ? step / 2 : step;
    let guard = 0;
    for (let t = minor; t * pps < W && guard++ < 40000; t += minor) {
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = (t * pps) + "px";
      ruler.appendChild(tick);
    }
  }

  _tickStep(pps) {
    const target = 70 / pps;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    for (const s of steps) if (s >= target) return s;
    return 3600;
  }
  _fmtTick(t) {
    if (t >= 3600) { const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); return `${h}:${String(m).padStart(2, "0")}`; }
    if (t >= 60) { const m = Math.floor(t / 60); const s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, "0")}`; }
    if (Number.isInteger(t)) return `${t}s`;
    return `${t.toFixed(1)}s`;
  }

  _buildRowClips(row, tr) {
    for (const c of tr.clips) {
      row.appendChild(this._makeClipEl(c, tr));
    }
  }

  _makeClipEl(c, tr) {
    const el = document.createElement("div");
    el.className = "clip " + (tr.kind === "video" ? "video" : "audio") + (state.selection.includes(c.id) ? " sel" : "");
    el.dataset.clipId = c.id;
    el.style.left = (c.start * state.pps) + "px";
    el.style.width = Math.max(4, c.duration * state.pps) + "px";
    const media = getMedia(c.mediaId);
    const name = media?.name || "clip";
    const wave = this._waveSVG(c, media);
    // Show thumbnail for video clips (use first frame)
    const thumb = (media?.type === "video" && media?.thumb) ? `<div class="clip-thumb" style="background-image:url(${media.thumb})"></div>` : "";
    const hasAudio = tr.kind === "audio" || (tr.kind === "video" && media && media.type === "video" && media._hasAudio && !c.audioExtracted);
    el.innerHTML = `
      ${thumb}
      ${wave ? `<div class="clip-wave">${wave}</div>` : ""}
      <div class="clip-name">${esc(name)}${c.linkedId ? ` <span class="clip-link" title="Linked audio/video">${c.linkMode === "unlinked" ? "🔓" : "🔗"}</span>` : ""}</div>
      ${hasAudio ? `<div class="vol-track" data-audio="${c.id}"><div class="vol-fill" style="width:${clamp((c.volume ?? 1) * 50, 0, 100)}%"></div><div class="vol-grab"></div></div>` : ""}
      <div class="handle l" data-mode="left"></div>
      <div class="handle r" data-mode="right"></div>`;

    // Add cursor styles for better UX
    el.style.cursor = "grab";
    
    el.addEventListener("pointerdown", (e) => this._clipPointerDown(e, c, tr, el));
    el.addEventListener("contextmenu", (e) => this._openClipMenu(e, c, tr));
    const fader = el.querySelector(".vol-track");
    if (fader) fader.addEventListener("pointerdown", (e) => this._faderDown(e, c, fader));
    return el;
  }

  _openClipMenu(e, c, tr) {
    e.preventDefault();
    e.stopPropagation();
    const media = getMedia(c.mediaId);
    const isVideo = tr.kind === "video";
    const canExtract = isVideo && (media?.type === "video" || media?._hasAudio || !media?.type);
    const items = [
      { ico: "✂", label: "Split at playhead", fn: () => actSplitClip(c.id, state.playhead) },
      { ico: "⧉", label: "Duplicate", fn: () => actDuplicate(c.id) },
    ];
    if (isVideo) {
      items.push({ sep: true });
      items.push({ ico: "▲", label: "Bring to front", fn: () => actZOrder(c.id, "front") });
      items.push({ ico: "△", label: "Bring forward", fn: () => actZOrder(c.id, "forward") });
      items.push({ ico: "▽", label: "Send backward", fn: () => actZOrder(c.id, "backward") });
      items.push({ ico: "▼", label: "Send to back", fn: () => actZOrder(c.id, "back") });
    }
    if (canExtract) items.push({ ico: "♪", label: c.linkedId ? "Audio already extracted" : "Extract audio", fn: () => actExtractAudio(c.id), disabled: !!c.linkedId });
    if (c.linkedId) items.push({ ico: "🔗", label: c.linkMode === "unlinked" ? "Re-link audio/video" : "Unlink audio/video", fn: () => actToggleLink(c.id) });
    items.push({ sep: true });
    items.push({ ico: "⭦", label: "Ripple delete", fn: () => actRippleDelete(c.id), danger: true });
    items.push({ ico: "✕", label: "Delete", fn: () => actDelete(c.id), danger: true });

    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    for (const it of items) {
      if (it.sep) { const s = document.createElement("div"); s.className = "ctx-sep"; menu.appendChild(s); continue; }
      const mi = document.createElement("div");
      mi.className = "ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "");
      mi.innerHTML = `<span class="ico">${it.ico}</span><span>${it.label}</span>`;
      if (!it.disabled) mi.addEventListener("click", () => { it.fn(); this._closeMenus(); });
      else mi.style.opacity = .45;
      menu.appendChild(mi);
    }
    document.body.appendChild(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + "px";
  }
  _closeMenus() {
    document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  }

  // Direct volume fader: drag left/right on a clip to set its volume (0..200%).
  _faderDown(e, c, fader) {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startVol = c.volume ?? 1;
    const setFill = (v) => {
      const fill = fader.querySelector(".vol-fill");
      if (fill) fill.style.width = clamp(v * 50, 0, 100) + "%";
    };
    setFill(startVol);
    const move = (ev) => {
      const v = clamp(startVol + (ev.clientX - startX) * 0.004, 0, 2);
      c.volume = v;               // live update (same value the inspector reads)
      setFill(v);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const final = c.volume;
      if (Math.abs(final - startVol) > 0.001) {
        // one undoable step: restore startVol on undo, restore final on redo
        history.record({ id: "volume", label: "Volume", execute: () => { c.volume = final; }, undo: () => { c.volume = startVol; } });
      }
      this.render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _waveSVG(c, media) {
    if (!media) return "";
    // Real decoded peaks for the clip's exact [offset, offset+duration] range.
    const peaks = clipPeaks(media.id, c.offset, c.duration, media.duration || 0);
    if (!peaks || !peaks.length) return "";
    const n = peaks.length;
    const bars = Math.min(120, n);
    let rects = "";
    for (let i = 0; i < bars; i++) {
      const v = peaks[Math.floor(i / bars * n)] || 0;
      const bh = 8 + v * 84;
      rects += `<rect x="${(i / bars) * 120}" y="${50 - bh / 2}" width="${120 / bars}" height="${bh}"/>`;
    }
    return `<svg class="wave" viewBox="0 0 120 100" preserveAspectRatio="none" style="fill:rgba(255,255,255,.55)">${rects}</svg>`;
  }

  // ------------------------------------------------------------- playhead
  updatePlayhead() {
    if (!this.playheadEl) return;
    this.playheadEl.style.left = (state.playhead * state.pps) + "px";
  }

  _timeFromClientX(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    return clamp((clientX - rect.left) / state.pps, 0, 1e6);
  }

  _trackFromClientY(clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const y = clientY - rect.top - RULER_H;
    const idx = Math.floor(y / ROW_H);
    
    // If clicking below all tracks, allow dropping there by creating a new track
    if (idx >= state.tracks.length && state.tracks.length > 0) {
      // Get the kind from the last track or from the currently dragged clip
      if (this._drag) {
        const wantKind = this._drag.track.kind;
        const newTrack = { id: uid("t"), kind: wantKind, name: wantKind === "video" ? `V${state.tracks.filter(t => t.kind === "video").length + 1}` : `A${state.tracks.filter(t => t.kind === "audio").length + 1}`, muted: false, hidden: false, clips: [] };
        state.tracks.push(newTrack);
        return newTrack;
      }
    }
    
    return state.tracks[idx] || null;
  }

  _rulerPointerDown(e) {
    e.preventDefault();
    audioResume();
    const go = (ev) => emitter.emit("seek:playhead", this._timeFromClientX(ev.clientX));
    go(e);
    const up = () => { window.removeEventListener("pointermove", go); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", go);
    window.addEventListener("pointerup", up);
  }

  // ------------------------------------------------------------- clip interactions
  _selectClipInTrack(e, c, tr, el) {
    // Helper to set cursor on handles
    const handle = e.target.closest(".handle");
    if (handle) {
      const mode = handle.dataset.mode;
      if (mode === "left" || mode === "right") {
        el.style.cursor = "ew-resize";
      }
    }
  }
  
  _clipPointerDown(e, c, tr, el) {
    e.stopPropagation();
    audioResume();
    this._selectClipInTrack(e, c, tr, el);
    
    if (state.tool === "razor") {
      // A cut is a brief action: split, then silently return to Select (no extra step).
      const t = state.playhead > c.start + 0.05 && state.playhead < c.start + c.duration - 0.05 ? state.playhead : this._timeFromClientX(e.clientX);
      actSplitClip(c.id, t);
      this.setTool("select");
      return;
    }

    const modeHandle = e.target.closest(".handle");
    const mode = modeHandle ? modeHandle.dataset.mode : "move";
    
    // Set cursor based on mode
    if (mode === "move") el.style.cursor = "grabbing";
    else if (mode === "left") el.style.cursor = "ew-resize";
    else if (mode === "right") el.style.cursor = "ew-resize";

    // Select (Shift adds to the multi-selection instead of replacing it).
    if (e.shiftKey && mode === "move") addSelection(c.id);
    else selectClip(c.id, { add: e.shiftKey });
    state.focus = "timeline";
    emitter.emit("change"); // rebuilds timeline + refreshes inspector
    // DOM was rebuilt synchronously by the 'change' handler, so grab the live node for this drag
    const liveEl = this.canvas.querySelector(`.clip[data-clip-id="${cssEscape(c.id)}"]`) || el;

    const media = getMedia(c.mediaId);
    this._drag = {
      clip: c, track: tr, el: liveEl, mode,
      startX: e.clientX,
      origStart: c.start, origOffset: c.offset, origDur: c.duration,
      mediaDur: media?.type === "image" ? 600 : (media?.duration || 600),
      mediaIsAudio: media?.type === "audio",
      targetTrackId: tr.id,
    };

    const move = (ev) => this._dragMove(ev);
    const up = (ev) => {
      this._dragMove(ev);
      this._dragEnd();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _dragMove(e) {
    const d = this._drag;
    if (!d) return;
    const dSec = (e.clientX - d.startX) / state.pps;

    if (d.mode === "move") {
      let ns = d.origStart + dSec;
      if (state.snap) {
        ns = this._snapStart(ns, d.origDur, d.clip.id);
      }
      ns = Math.max(0, ns);
      // target track (same kind only)
      const tt = this._trackFromClientY(e.clientY);
      if (tt && tt.kind === d.track.kind) d.targetTrackId = tt.id;
      d.el.style.left = (ns * state.pps) + "px";
      if (tt && tt.kind === d.track.kind && tt.id !== d.track.id) {
        const targetRow = this.canvas.querySelector(`.tl-row[data-track-id="${cssEscape(tt.id)}"]`);
        if (targetRow && d.el.parentElement !== targetRow) targetRow.appendChild(d.el);
      }
      this._dStart = ns;
    } else if (d.mode === "left") {
      const end = d.origStart + d.origDur; // right edge stays fixed
      let ns = d.origStart + dSec;
      let no = d.origOffset + dSec;
      let nd = end - ns;
      // constraints
      if (ns < 0) { ns = 0; nd = end - ns; no = d.origOffset; }
      if (no < 0) { no = 0; ns = d.origStart + no - d.origOffset; nd = end - ns; }
      if (nd < 0.1) { nd = 0.1; ns = end - nd; no = d.origOffset + (ns - d.origStart); }
      // snap the moving start edge
      if (state.snap) {
        const s = this._snapStart(ns, nd, d.clip.id);
        if (s >= 0 && s !== ns) { ns = s; nd = end - ns; no = d.origOffset + (ns - d.origStart); }
      }
      d.el.style.left = (ns * state.pps) + "px";
      d.el.style.width = Math.max(4, nd * state.pps) + "px";
      this._dStart = ns; this._dOffset = no; this._dDur = nd;
    } else if (d.mode === "right") {
      let nd = d.origDur + dSec;
      nd = Math.max(0.1, nd);
      const maxEnd = d.mediaDur - d.origOffset;
      if (nd > maxEnd) nd = maxEnd;
      d.el.style.width = Math.max(4, nd * state.pps) + "px";
      this._dDur = nd;
    }
    
    // Update cursor during drag
    if (d.mode === "move") {
      document.body.style.cursor = "grabbing";
    }
  }

  _dragEnd() {
    const d = this._drag;
    if (!d) return;
    if (d.mode === "move") {
      actMoveClip(d.clip.id, this._dStart ?? d.clip.start, d.targetTrackId);
    } else if (d.mode === "left") {
      actTrimClip(d.clip.id, { start: this._dStart, offset: this._dOffset, duration: this._dDur });
    } else if (d.mode === "right") {
      actTrimClip(d.clip.id, { duration: this._dDur });
    }
    document.body.style.cursor = "";
    this._drag = null;
  }

  _snapStart(candidateStart, duration, excludeId) {
    const cands = snapCandidates(excludeId);
    const thr = 8 / state.pps;
    let best = candidateStart, bestDist = Infinity;
    for (const cand of cands) {
      const dS = Math.abs(candidateStart - cand);
      if (dS < bestDist) { bestDist = dS; best = cand; }
      const dE = Math.abs(candidateStart + duration - cand);
      if (dE < bestDist) { bestDist = dE; best = cand - duration; }
    }
    if (bestDist <= thr) return best;
    return candidateStart;
  }

  // ------------------------------------------------------------- bin drop (native DnD)
  _bindDrop() {
    this.canvas.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const t = this._timeFromClientX(e.clientX);
      let st = t;
      if (state.snap) st = this._snapStart(t, 2, ""); // approximate
      const dl = this.canvas.querySelector("#tl-dropline");
      if (dl) { dl.style.display = "block"; dl.style.left = (st * state.pps) + "px"; }
    });
    this.canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      const dl = this.canvas.querySelector("#tl-dropline"); if (dl) dl.style.display = "none";
      const mediaId = e.dataTransfer.getData("text/mediaid");
      if (!mediaId) return;
      const media = getMedia(mediaId);
      if (!media) return;
      const tt = this._trackFromClientY(e.clientY);
      const wantKind = media.type === "audio" ? "audio" : "video";
      const target = (tt && tt.kind === wantKind) ? tt : firstTrackOfKind(wantKind);
      if (!target) return;
      const t = this._timeFromClientX(e.clientX);
      let st = state.snap ? this._snapStart(t, 2, "") : t;
      // Find the best position - if we're between clips, insert there
      actAddClip({ mediaId, trackId: target.id, start: Math.max(0, st), offset: 0 });
    });
  }

  // ------------------------------------------------------------- marquee selection
  // Drag over empty timeline space to box-select every clip it intersects.
  _bindMarquee() {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const onEmpty = !e.target.closest(".clip") && !e.target.closest(".ruler");
      if (!onEmpty) return;
      state.focus = "timeline";
      if (state.tool !== "select") return;
      const canvasRect = this.canvas.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      let moved = false;
      const mq = this.marqueeEl;
      const move = (ev) => {
        const x0 = Math.min(sx, ev.clientX), x1 = Math.max(sx, ev.clientX);
        const y0 = Math.min(sy, ev.clientY), y1 = Math.max(sy, ev.clientY);
        if (x1 - x0 > 4 || y1 - y0 > 4) moved = true;
        if (moved) {
          const cx0 = x0 - canvasRect.left, cx1 = x1 - canvasRect.left;
          const cy0 = y0 - canvasRect.top, cy1 = y1 - canvasRect.top;
          mq.style.display = "block";
          mq.style.left = cx0 + "px"; mq.style.top = cy0 + "px";
          mq.style.width = (cx1 - cx0) + "px"; mq.style.height = (cy1 - cy0) + "px";
          // select clips whose box intersects the marquee rectangle
          const ids = [];
          for (const tr of state.tracks) for (const c of tr.clips) {
            const lx = c.start * state.pps, lw = c.duration * state.pps;
            const ly = RULER_H + state.tracks.indexOf(tr) * ROW_H;
            if (!(lx + lw < cx0 || lx > cx1 || ly + ROW_H < cy0 || ly > cy1)) ids.push(c.id);
          }
          selectMany(e.shiftKey ? state.selection.concat(ids.filter((i) => !state.selection.includes(i))) : ids);
          this.render();
        }
      };
      const up = (ev) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        mq.style.display = "none";
        if (!moved) { if (!ev.shiftKey) { selectNone(); this.render(); } }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  // ------------------------------------------------------------- global
  _bindGlobal() {
    emitter.on("change", () => this.render());
    // re-render once a media's real audio peaks are decoded (so waveforms appear)
    emitter.on("waveform", () => {
      clearTimeout(this._waveTimer);
      this._waveTimer = setTimeout(() => this.render(), 30);
    });
    // close any open context menu when clicking/pressing elsewhere (registered once)
    this._menuDismiss = (ev) => {
      if (document.querySelector(".ctx-menu") && !ev.target.closest(".ctx-menu")) this._closeMenus();
    };
    document.addEventListener("pointerdown", this._menuDismiss, true);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") this._closeMenus(); });
  }

  // ------------------------------------------------------------- zoom
  _updateZoomLabel() {
    const el = document.getElementById("zoom-val");
    if (el) el.textContent = `${Math.round(state.pps)} px/s`;
  }
  zoom(factor) {
    const center = state.playhead;
    const cx = this.scroll.scrollLeft + this.canvas.getBoundingClientRect().width * 0; // keep simple
    state.pps = clamp(state.pps * factor, 5, 260);
    this.render();
  }
  zoomFit() {
    const d = sequenceDuration();
    const avail = this.scroll.clientWidth - HEADER_W - 20;
    state.pps = clamp(avail / Math.max(1, d), 5, 260);
    this.render();
    this.scroll.scrollLeft = 0;
  }

  // ------------------------------------------------------------- tools
  setTool(tool) {
    state.tool = tool;
    document.getElementById("tool-select").classList.toggle("active", tool === "select");
    document.getElementById("tool-razor").classList.toggle("active", tool === "razor");
  }
}

function audioResume() {
  import("./audio.js").then((m) => m.audio.resume());
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/"/g, '\\"'); }
