import { state, getMedia, sequenceDuration, clipAt, clipRect, clipAtPoint, pointInRect } from "./state.js";
import { audio } from "./audio.js";
import { clamp, finite, fmtTime } from "./util.js";

export class Player {
  constructor(programCanvas, sourceCanvas, onTick) {
    this.canvas = programCanvas;
    this.pctx = programCanvas.getContext("2d");
    this.srcCanvas = sourceCanvas;
    this.sctx = sourceCanvas.getContext("2d");
    this.onTick = onTick;
    // The Program canvas IS the composition frame (its dimensions = the comp's output
    // size). Resizing the on-screen panel only scales the CSS display — never these.
    this.W = state.comp.width || 1280;
    this.H = state.comp.height || 720;
    this._applyComp();

    this.t = 0;
    this.playing = false;
    this.last = 0;
    this.raf = 0;
    this.redraw = true;

    this.clipEls = new Map(); // clipId -> HTMLMediaElement
    this.srcPlaying = false;
    this.exporting = false;
    this.exportDone = null; // called when export playback reaches the end

    // Run the render loop continuously; it is a no-op when nothing needs drawing.
    this._looping = true;
    this.raf = requestAnimationFrame(this._loop);

    // When the tab returns to the foreground, reset the clock baseline so the big
    // rAF gap doesn't produce a jump (which would desync / glitch the media).
    this._onVis = () => { this.last = performance.now(); };
    document.addEventListener("visibilitychange", this._onVis);
  }

  // Single source of truth for the playhead is state.playhead.
  get t() { return state.playhead; }
  set t(v) { state.playhead = v; }

  // ------------------------------------------------------------- elements
  elFor(clip) {
    let el = this.clipEls.get(clip.id);
    if (el) return el;
    const media = getMedia(clip.mediaId);
    if (!media) return null;
    if (media.type === "image" || media.type === "svg") return null; // static visuals, no media element
    el = document.createElement(media.type);
    el.src = media.url;
    el.preload = "auto";
    el.playsInline = true;
    el.muted = false; // keep un-muted so Web Audio can capture it
    el._mediaId = media.id;
    el._clipId = clip.id;
    audio.connect(el);
    el.addEventListener("seeked", () => { if (!this.playing) this.redraw = true; });
    el.addEventListener("canplay", () => { if (!this.playing) this.redraw = true; });
    this.clipEls.set(clip.id, el);
    return el;
  }

  // Ensure every clip has a media element; drop orphans.
  syncClipElements() {
    const live = new Set();
    for (const tr of state.tracks) for (const c of tr.clips) {
      live.add(c.id);
      if (getMedia(c.mediaId)?.type !== "image") this.elFor(c);
    }
    for (const [id, el] of this.clipEls) {
      if (!live.has(id)) {
        try { el.pause(); } catch (e) {}
        audio.disconnect(el);
        this.clipEls.delete(id);
      }
    }
  }

  // ------------------------------------------------------------- transport
  duration() { return sequenceDuration(); }

  seek(t, { scrub = true } = {}) {
    this.t = clamp(t, 0, Math.max(0, this.duration()));
    this.syncClipElements();
    if (scrub) {
      // align each element's frame
      for (const tr of state.tracks) for (const c of tr.clips) {
        const el = this.clipEls.get(c.id);
        if (!el) continue;
        const target = clamp(c.offset + (this.t - c.start), 0, c.duration + 0.001);
        try { if (el.paused) el.currentTime = target; } catch (e) {}
      }
    }
    this.redraw = true;
    this._tickUI();
  }

  play() {
    audio.resume(); // (un)suspend the AudioContext on the user gesture that triggers playback
    const d = this.duration();
    if (this.t >= d - 0.001) this.t = 0;
    this.playing = true;
    state.playing = true;
    this.last = performance.now();
    this.redraw = true;
    this._syncMedia(this.t);          // start active elements NOW, inside the user gesture
    if (!this._looping) { this._looping = true; this.raf = requestAnimationFrame(this._loop); }
    this._tickUI();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    state.playing = false;
    // freeze media elements at current position (no more audio)
    for (const el of this.clipEls.values()) { try { el.pause(); } catch (e) {} }
    this._tickUI();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  toStart() { this.seek(0); }
  toEnd() { this.seek(this.duration(), { scrub: true }); }

  _editPoints() {
    const pts = new Set([0]);
    for (const tr of state.tracks) for (const c of tr.clips) { pts.add(c.start); pts.add(c.start + c.duration); }
    pts.add(this.duration());
    return [...pts].sort((a, b) => a - b);
  }
  prevEdit() { const p = this._editPoints(); let best = 0; for (const x of p) if (x < this.t - 0.03) best = x; this.seek(best); }
  nextEdit() { const p = this._editPoints(); let best = this.duration(); for (const x of p) if (x > this.t + 0.03) { best = x; break; } this.seek(best); }

  // ------------------------------------------------------------- main loop
  _loop = (now) => {
    this.syncClipElements();
    if (this.playing) {
      const dt = Math.min(0.5, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      const d = this.duration();
      if (this.t >= d) {
        if (!this.exporting && state.loop && d > 0) { this.t = this.t % d; }
        else {
          this.t = d;
          this._syncMedia(this.t);
          this._drawProgram(this.t);
          if (state.src.playing) this._drawSource(state.src.t);
          this.pause();
          if (this.exporting) { this.exporting = false; this.exportDone && this.exportDone(); }
          this._tickUI();
        }
      } else {
        this._syncMedia(this.t);
        this._drawProgram(this.t);
        if (state.src.playing) this._drawSource(state.src.t);
      }
    }
    if (state.src.playing) this._advanceSource();

    if (this.redraw && !this.playing) {
      this._drawProgram(this.t);
      this._drawSource(state.src.t);
      this.redraw = false;
      this._tickUI();
    }
    if (this.playing) this._tickUI();
    this.raf = requestAnimationFrame(this._loop);
  };

  // Align every clip's media element with the master clock.
  //
  // KEY (fixes audio spikes / "looping" after a cut): once a clip's element is playing,
  // we let it FREE-RUN. We never re-seek it for small drift, because re-seeking a playing
  // element produces an audible spike in audio and a jump in video. We only (a) seek+play
  // when the element (re)activates, and (b) hard-recover if it drifts >1s (rare).
  _syncMedia(t) {
    const now = performance.now();
    for (const tr of state.tracks) {
      for (const c of tr.clips) {
        const media = getMedia(c.mediaId);
        if (!media || media.type === "image") continue;
        const el = this.clipEls.get(c.id);
        if (!el) continue;
        const active = t >= c.start && t < c.start + c.duration;
        // If this video's audio was extracted to a linked clip, mute the video's own
        // audio (the extracted clip plays it) so the sound isn't doubled.
        const showAudio = !tr.muted && !(c.audioExtracted && c.linkedId);
        if (active) {
          audio.setVolume(el, showAudio ? c.volume : 0);
          const maxPos = Math.max(0, (media.duration || c.duration));
          if (el.paused) {
            const target = clamp(c.offset + (t - c.start), 0, maxPos);
            try { el.currentTime = target; el.play().catch(() => {}); el._alignAt = now; } catch (e) {}
          } else {
            const drift = Math.abs(el.currentTime - (c.offset + (t - c.start)));
            if (drift > 1.0 && now - (el._alignAt || 0) > 1500) {
              try { el.currentTime = clamp(c.offset + (t - c.start), 0, maxPos); el._alignAt = now; } catch (e) {}
            }
          }
        } else if (!el.paused) {
          el.pause();
        }
      }
    }
  }

  // Set the canvas backing store to the composition's output size. Called on load and
  // whenever the comp settings change. (The CSS display size is separate/adaptive.)
  _applyComp() {
    this.W = state.comp.width || 1280;
    this.H = state.comp.height || 720;
    this.canvas.width = this.W;
    this.canvas.height = this.H;
  }

  // ------------------------------------------------------------- compositing
  _drawProgram(t) {
    const ctx = this.pctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.W, this.H);

    // Composite by VISUAL z-order (independent of track order); track order is the
    // tiebreaker so, at equal z, the top track still wins (matches the old default).
    const active = [];
    for (let i = 0; i < state.tracks.length; i++) {
      const tr = state.tracks[i];
      if (tr.kind !== "video" || tr.hidden) continue;
      const c = clipAt(tr.id, t);
      if (c) active.push({ c, trackIdx: i });
    }
    active.sort((a, b) => ((a.c.zIndex || 0) - (b.c.zIndex || 0)) || (b.trackIdx - a.trackIdx));
    for (const { c } of active) this._drawClipVideo(ctx, c);
    this._drawSelection(ctx, t);
  }

  _drawClipVideo(ctx, c) {
    const media = getMedia(c.mediaId);
    if (!media) return;
    let src;
    if (media.type === "image") src = media.el;
    else src = this.clipEls.get(c.id) || media.el;
    const f = c.filters;
    const t = c.transform || { x: 0, y: 0, w: this.W, h: this.H, rotation: 0 };
    const cx = this.W / 2 + (t.x || 0), cy = this.H / 2 + (t.y || 0);
    ctx.save();
    ctx.globalAlpha = (f.opacity ?? 100) / 100;
    ctx.filter = `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%) blur(${f.blur}px) grayscale(${f.grayscale}%) sepia(${f.sepia}%) hue-rotate(${f.hue}deg)`;
    if (t.rotation) { ctx.translate(cx, cy); ctx.rotate(t.rotation * Math.PI / 180); ctx.translate(-cx, -cy); }
    const dx = cx - t.w / 2, dy = cy - t.h / 2;
    try { ctx.drawImage(src, dx, dy, t.w, t.h); } catch (e) {}
    ctx.restore();
  }

  // Selection box + 8 resize handles (drawn in comp space on the program canvas).
  _drawSelection(ctx, t) {
    if (!state.selection || !state.selection.length) return;
    const comp = state.comp;
    for (const tr of state.tracks) {
      if (tr.kind !== "video" || tr.hidden) continue;
      const c = clipAt(tr.id, t);
      if (!c || !state.selection.includes(c.id)) continue;
      const r = clipRect(c, comp);
      ctx.save();
      ctx.lineWidth = Math.max(1, this.W / 480);
      ctx.strokeStyle = "#1ec8ff";
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      const hs = Math.max(6, this.W / 90);
      const pts = [[r.x, r.y], [r.x + r.w / 2, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h / 2],
        [r.x + r.w, r.y + r.h / 2], [r.x, r.y + r.h], [r.x + r.w / 2, r.y + r.h], [r.x + r.w, r.y + r.h]];
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#1ec8ff";
      for (const [hx, hy] of pts) { ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs); ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs); }
      ctx.restore();
    }
  }

  // ------------------------------------------------------------- source monitor
  loadSource(mediaId) {
    const media = getMedia(mediaId);
    if (!media) return;
    state.src.mediaId = mediaId;
    state.src.t = 0;
    state.src.in = 0;
    state.src.out = media.type === "image" ? (media._clipLen || 3) : finite(media.duration, 0);
    state.src.playing = false;
    state.src.loopMode = state.src.loopMode || "once";
    if (media.type !== "image" && media.el) {
      try { media.el.currentTime = 0; media.el.pause(); media.el.muted = false; } catch (e) {}
      // Connect source element to Web Audio so volume/filters work
      if (media.type === "video" || media.type === "audio") {
        audio.connect(media.el);
        audio.setVolume(media.el, media._volume ?? 1);
      }
    }
    this.redraw = true;
    this._tickUI();
  }

  _seekSource(t) {
    const media = getMedia(state.src.mediaId);
    if (!media) return;
    const dur = media.type === "image" ? (media._clipLen || 3) : finite(media.duration, 0);
    const ct = clamp(t, 0, dur);
    if (media.type !== "image" && media.el) {
      try { media.el.currentTime = ct; } catch (e) {}
    }
    state.src.t = ct;
    this.redraw = true;
  }

  _advanceSource() {
    const media = getMedia(state.src.mediaId);
    if (!media) { state.src.playing = false; return; }
    if (media.type === "image") {
      const d = media._clipLen || 3;
      state.src.t += 1 / 30;
      if (state.src.t >= d) { state.src.t = d; state.src.playing = false; }
    } else if (media.el) {
      // Ensure audio is connected for source playback
      if (media.type === "video" || media.type === "audio") {
        audio.connect(media.el);
        audio.setVolume(media.el, media._volume ?? 1);
        media.el.muted = false;
      }
      if (state.src.playing && media.el.paused) media.el.play().catch(() => {});
      state.src.t = media.el.currentTime || 0;
      
      // Handle different loop modes
      if (state.src.loopMode === "loop") {
        // Loop selected range: bounce back to in point when reaching out point
        if (state.src.t >= (state.src.out || media.duration) - 0.02) {
          try { media.el.currentTime = state.src.in; state.src.t = state.src.in; } catch (e) {}
        }
      } else if (state.src.loopMode === "play-range") {
        // Play range once: stop at out point
        if (state.src.t >= (state.src.out || media.duration) - 0.02) {
          state.src.t = (state.src.out || media.duration);
          state.src.playing = false;
        }
      } else { // "once" - play to end then stop
        if (state.src.t >= (media.duration || 0) - 0.02) {
          state.src.t = (media.duration || 0);
          state.src.playing = false;
        }
      }
    }
    this.redraw = true;
  }

  toggleSource() {
    if (!state.src.mediaId) return;
    const media = getMedia(state.src.mediaId);
    if (!media) return;
    state.src.playing = !state.src.playing;
    audio.resume();
    if (state.src.playing) {
      const d = media.duration || media._clipLen || 3;
      // Start at in-point for loop/play-range modes
      if ((state.src.loopMode === "loop" || state.src.loopMode === "play-range") && state.src.t < state.src.in) {
        state.src.t = state.src.in;
      } else if (state.src.t >= d - 0.01) {
        state.src.t = 0;
      }
      if (media.type !== "image" && media.el) {
        // Ensure audio is connected and unmuted for source preview
        if (media.type === "video" || media.type === "audio") {
          audio.connect(media.el);
          audio.setVolume(media.el, media._volume ?? 1);
          media.el.muted = false;
        }
        try { media.el.currentTime = state.src.t; media.el.play().catch(() => {}); } catch (e) {}
      }
    } else if (media.type !== "image" && media.el) {
      try { media.el.pause(); } catch (e) {}
    }
    this.redraw = true;
    this._tickUI();
  }

  _drawSource(t) {
    const ctx = this.sctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.W, this.H);
    const media = getMedia(state.src.mediaId);
    if (!media) return;
    let src, sw, sh;
    if (media.type === "image") { src = media.el; sw = media.width; sh = media.height; }
    else { src = media.el; sw = src.videoWidth || media.width; sh = src.videoHeight || media.height; if (!sw || !sh) return; }
    const scale = Math.min(this.W / sw, this.H / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(src, (this.W - dw) / 2, (this.H - dh) / 2, dw, dh);
  }

  // ------------------------------------------------------------- export
  beginExport() {
    this.exporting = true;
  }
  endExport() { this.exporting = false; }

  // ------------------------------------------------------------- ui tick
  _tickUI() { if (this.onTick) this.onTick(); }
}
