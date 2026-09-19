import { uid, clamp, finite, resolveMediaDuration } from "./util.js";

export const emitter = {
  _h: {},
  on(ev, fn) { (this._h[ev] ||= new Set()).add(fn); return fn; },
  off(ev, fn) { this._h[ev]?.delete(fn); },
  emit(ev, data) { this._h[ev]?.forEach((fn) => fn(data)); },
};

function notify() { emitter.emit("change"); }

// ---------------------------------------------------------------- state
export const state = {
  media: new Map(),   // id -> Media
  tracks: [],         // display order, index 0 = top-most
  playhead: 0,
  playing: false,
  loop: false,
  pps: 60,            // pixels per second (UI-only; never part of the document)
  tool: "select",     // 'select' | 'razor'
  editMode: "move",   // 'move' (allow overlap, non-destructive) | 'insert' (ripple: make room)
  snap: true,
  selection: [],          // authoritative multi-select (clip ids)
  selectedClipId: null,   // primary selection = selection[0]
  focus: "timeline",      // 'timeline' | 'canvas' — where attention is (Ctrl+A scope)
  activeTrackId: null,
  sequenceName: "Sequence 01",
  // Composition settings = the project's own frame + timebase. This is INDEPENDENT of
  // any imported media: the comp defines the output shape/size/rate; each asset keeps
  // its own real properties. `fitMode` decides how footage is placed inside the frame.
  comp: { fps: 30, width: 1280, height: 720 },
  fitMode: "fit", // 'fit' (letterbox) | 'fill' (cover/crop) | 'original' (1:1)
  src: { mediaId: null, t: 0, in: 0, out: null, playing: false, loop: false, loopMode: "once" },
};

export function getMedia(id) { return state.media.get(id) || null; }
export function clipById(clipId) {
  for (const tr of state.tracks) {
    const clip = tr.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track: tr };
  }
  return null;
}

// ---- shared selection (single source of truth: what's selected + where focus is)
export function selectNone() { state.selection = []; state.selectedClipId = null; }
export function selectClip(clipId, { add = false, primary = false } = {}) {
  if (add) {
    const i = state.selection.indexOf(clipId);
    if (i === -1) state.selection.push(clipId);
    if (primary || i === -1) state.selectedClipId = clipId;
  } else {
    state.selection = [clipId];
    state.selectedClipId = clipId;
  }
}
export function selectMany(ids) { state.selection = ids.slice(); state.selectedClipId = ids[0] || null; }
export function addSelection(id) { if (!state.selection.includes(id)) { state.selection.push(id); state.selectedClipId = id; } }
export function removeSelection(id) {
  state.selection = state.selection.filter((x) => x !== id);
  if (state.selectedClipId === id) state.selectedClipId = state.selection[0] || null;
}
export function selectAllInFocus() {
  // 'timeline' focus -> all clips. (canvas focus -> all canvas objects, future)
  const ids = [];
  for (const tr of state.tracks) for (const c of tr.clips) ids.push(c.id);
  selectMany(ids);
}

export function sequenceDuration() {
  let end = 0;
  for (const tr of state.tracks) for (const c of tr.clips) {
    const s = finite(c.start, 0), d = finite(c.duration, 0);
    end = Math.max(end, s + d);
  }
  return end;
}

// ---- canvas transform geometry (comp-space; 1px = 1 composition unit) ----
// Default transform: media placed into the comp frame per the active FIT mode
// (fit=letterbox, fill=crop, original=1:1). A clip then owns its transform and can be
// dragged/resized directly on the canvas to override it.
export function defaultTransform(media, comp, fitMode = "fit") {
  const mw = media && media.width ? media.width : comp.width;
  const mh = media && media.height ? media.height : comp.height;
  let s;
  if (fitMode === "fill") s = Math.max(comp.width / mw, comp.height / mh);
  else if (fitMode === "original") s = 1;
  else s = Math.min(comp.width / mw, comp.height / mh); // fit (letterbox)
  return { x: 0, y: 0, w: Math.max(1, Math.round(mw * s)), h: Math.max(1, Math.round(mh * s)), rotation: 0 };
}
// The screen rect (comp-space) for a clip, from its transform. x/y offset from center.
export function clipRect(c, comp) {
  const t = c.transform;
  return { x: comp.width / 2 + t.x - t.w / 2, y: comp.height / 2 + t.y - t.h / 2, w: t.w, h: t.h };
}
// Is comp-space point (px,py) inside rect r (ignoring rotation for MVP)?
export function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}
// Topmost active video clip whose rect contains the point (front-most first).
export function clipAtPoint(t, px, py) {
  const comp = state.comp;
  for (const tr of state.tracks) { // state.tracks is top-first
    if (tr.kind !== "video" || tr.hidden) continue;
    const c = clipAt(tr.id, t);
    if (!c) continue;
    if (pointInRect(px, py, clipRect(c, comp))) return c;
  }
  return null;
}
// For direct canvas manipulation: what did (px,py) hit on clip c?
// Returns a handle id ('nw','n','ne','e','se','s','sw','w'), 'move', or null.
// radius (comp units) should be a constant *screen* size so handles stay grabbable
// at any preview scale.
export function clipHandleAt(c, comp, px, py, radius = comp.width / 40) {
  const r = clipRect(c, comp);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const H = [
    ["nw", r.x, r.y], ["n", cx, r.y], ["ne", r.x + r.w, r.y],
    ["w", r.x, cy], ["e", r.x + r.w, cy],
    ["sw", r.x, r.y + r.h], ["s", cx, r.y + r.h], ["se", r.x + r.w, r.y + r.h],
  ];
  for (const [id, hx, hy] of H) if (Math.abs(px - hx) <= radius && Math.abs(py - hy) <= radius) return id;
  if (pointInRect(px, py, r)) return "move";
  return null;
}

// ---------------------------------------------------------------- media
// Grab a real frame from a video element for use as a thumbnail (data URL).
export function videoThumb(v, maxW = 160) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const grab = () => {
      try {
        if (!v.videoWidth) return done(null);
        const s = Math.min(1, maxW / v.videoWidth);
        const cw = Math.max(1, Math.round(v.videoWidth * s)), ch = Math.max(1, Math.round(v.videoHeight * s));
        const c = document.createElement("canvas"); c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(v, 0, 0, cw, ch);
        done(c.toDataURL("image/jpeg", 0.72));
      } catch (e) { done(null); }
    };
    // If frame is already available, grab it immediately.
    if (v.readyState >= 2) {
      grab();
      return;
    }
    // Otherwise wait for seeked after we seek.
    const onSeeked = () => {
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("loadeddata", onSeeked);
      grab();
    };
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadeddata", onSeeked);
    try {
      // If metadata is already loaded, seek now.
      if (v.readyState >= 1) {
        v.currentTime = Math.min(0.2, (v.duration || 1) * 0.1);
      } else {
        const onMeta = () => {
          v.removeEventListener("loadedmetadata", onMeta);
          try { v.currentTime = Math.min(0.2, (v.duration || 1) * 0.1); } catch (e) { done(null); }
        };
        v.addEventListener("loadedmetadata", onMeta);
        // Fallback if metadata never arrives.
        setTimeout(() => { v.removeEventListener("loadedmetadata", onMeta); if (!settled) done(null); }, 2000);
      }
    } catch (e) { done(null); }
    setTimeout(() => { if (!settled) done(null); }, 4000);
  });
}

export function mediaDurationForClip(media) {
  if (!media) return 3;
  if (media.type === "image" || media.type === "svg") return media._clipLen || 3;
  return finite(media.duration, 0);
}

// Load metadata + build a preview element for a File.
export function importFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    const type =
      isSvg ? "svg" :
      file.type.startsWith("video/") ? "video" :
      file.type.startsWith("audio/") ? "audio" :
      file.type.startsWith("image/") ? "image" :
      /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name) ? "video" :
      /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(file.name) ? "audio" : "image";

    const finish = (m) => resolve(m);
    const fail = () => { URL.revokeObjectURL(url); reject(new Error("Could not load " + file.name)); };

    if (type === "video") {
      const v = document.createElement("video");
      v.preload = "auto"; v.muted = true; v.playsInline = true;
      v.src = url;
      v.onloadedmetadata = async () => {
        let dur = v.duration;
        if (!Number.isFinite(dur)) dur = await resolveMediaDuration(v); // WebM-blob Infinity quirk
        const thumb = await videoThumb(v, 160); // real first frame for the bin + clip thumbnail
        finish({
          id: uid("m"), name: file.name, type, url,
          duration: finite(dur, 0), width: v.videoWidth || 1280, height: v.videoHeight || 720, el: v,
          thumb,
        });
      };
      v.onerror = fail;
    } else if (type === "audio") {
      const a = document.createElement("audio");
      a.preload = "auto"; a.src = url;
      a.onloadedmetadata = async () => {
        let dur = a.duration;
        if (!Number.isFinite(dur)) dur = await resolveMediaDuration(a);
        finish({
          id: uid("m"), name: file.name, type, url,
          duration: finite(dur, 0), width: 0, height: 0, el: a,
        });
      };
      a.onerror = fail;
    } else if (type === "svg") {
      // SVG is a first-class VECTOR element: we keep the raw SVG source (not a flattened
      // bitmap) so it can be transformed/layered/duplicated and re-exported/animated later.
      const img = new Image();
      img.onload = async () => finish({
        id: uid("m"), name: file.name, type, url,
        duration: 0, width: img.naturalWidth || 300, height: img.naturalHeight || 300,
        el: img, _clipLen: 3, vector: true,
        svg: await file.text().catch(() => null),
      });
      img.onerror = fail;
      img.src = url;
    } else {
      const img = new Image();
      img.onload = () => finish({
        id: uid("m"), name: file.name, type, url,
        duration: 0, width: img.naturalWidth || 1280, height: img.naturalHeight || 720, el: img, _clipLen: 3,
      });
      img.onerror = fail;
      img.src = url;
    }
  });
}

export function addMedia(media) {
  state.media.set(media.id, media);
  if (!state.activeTrackId) state.activeTrackId = firstTrackOfKind("video")?.id || state.tracks[0]?.id;
  notify();
}

// ---------------------------------------------------------------- tracks
let vCount = 0, aCount = 0;
export function firstTrackOfKind(kind) {
  // return the "main" (bottom-most / first added) track of a kind for default inserts
  const ofKind = state.tracks.filter((t) => t.kind === kind);
  return ofKind.length ? ofKind[ofKind.length - 1] : null;
}

export function initTracks() {
  vCount = 2; aCount = 1;
  state.tracks = [
    { id: uid("t"), kind: "video", name: "V2", muted: false, hidden: false, clips: [] },
    { id: uid("t"), kind: "video", name: "V1", muted: false, hidden: false, clips: [] },
    { id: uid("t"), kind: "audio", name: "A1", muted: false, hidden: false, clips: [] },
  ];
  state.activeTrackId = state.tracks[1].id; // V1
  notify();
}

export function addTrack(kind) {
  let track;
  if (kind === "video") {
    vCount += 1;
    track = { id: uid("t"), kind, name: `V${vCount}`, muted: false, hidden: false, clips: [] };
    state.tracks.unshift(track); // new video on top
  } else {
    aCount += 1;
    track = { id: uid("t"), kind, name: `A${aCount}`, muted: false, hidden: false, clips: [] };
    state.tracks.push(track); // new audio at bottom
  }
  state.activeTrackId = track.id;
  notify();
  return track;
}

export function removeTrack(trackId) {
  state.tracks = state.tracks.filter((t) => t.id !== trackId);
  if (!state.tracks.length) initTracks();
  notify();
}

// ---------------------------------------------------------------- clips
export function makeClip({ mediaId, start, offset = 0, duration }) {
  const media = getMedia(mediaId);
  const mediaLen = (media?.type === "image" || media?.type === "svg") ? (media._clipLen || 3) : finite(media?.duration, 0);
  const rawDur = duration != null ? duration : (mediaLen || 3);
  const dur = clamp(finite(rawDur, 3), 0.1, 36000);
  const off = clamp(finite(offset, 0), 0, Math.max(0, mediaLen - 0.05 || 0));
  return {
    id: uid("c"), mediaId,
    start: clamp(finite(start, 0), 0, 1e6),
    duration: dur,
    offset: Math.min(off, Math.max(0, mediaLen - dur)),
    volume: 1,
    audioExtracted: false, // true once its audio was extracted to a separate clip (its own audio is then muted)
    zIndex: 0,        // visual stacking (independent of track order); higher = in front
    linkedId: null,   // for video-with-audio: id of the linked audio clip (if extracted)
    linkMode: "auto", // 'auto' (linked by default) | 'linked' | 'unlinked'
    transform: defaultTransform(media, state.comp, state.fitMode),
    filters: { brightness: 100, contrast: 100, saturate: 100, blur: 0, grayscale: 0, sepia: 0, hue: 0, opacity: 100 },
  };
}

export function addClip({ mediaId, trackId, start, offset, duration }) {
  const track = state.tracks.find((t) => t.id === trackId) || state.tracks[0];
  const clip = normalizeClip(makeClip({ mediaId, start, offset, duration }));
  track.clips.push(clip);
  track.clips.sort((a, b) => a.start - b.start);
  state.activeTrackId = track.id;
  selectClip(clip.id);
  notify();
  return clip;
}

// Ensure a clip has all the fields the current model requires (backfill defaults).
// Used on load/restore so older documents and partial data never break rendering.
export function normalizeClip(c) {
  if (!c) return c;
  if (!c.transform) c.transform = defaultTransform(getMedia(c.mediaId), state.comp, state.fitMode);
  c.transform = { x: 0, y: 0, w: 1, h: 1, rotation: 0, ...c.transform };
  if (c.filters == null) c.filters = { brightness: 100, contrast: 100, saturate: 100, blur: 0, grayscale: 0, sepia: 0, hue: 0, opacity: 100 };
  if (c.volume == null) c.volume = 1;
  if (c.audioExtracted == null) c.audioExtracted = false;
  if (c.zIndex == null) c.zIndex = 0;
  if (c.linkedId == null) c.linkedId = null;
  if (!c.linkMode) c.linkMode = "auto";
  return c;
}

// Re-apply the default (fit-mode) transform to every clip. Called when the comp's
// Fit mode or frame size changes, so all footage re-fits into the new frame.
export function refitAll() {
  for (const tr of state.tracks) for (const c of tr.clips) {
    c.transform = defaultTransform(getMedia(c.mediaId), state.comp, state.fitMode);
  }
  notify();
}

export function removeClip(clipId) {
  const found = clipById(clipId);
  if (!found) return;
  found.track.clips = found.track.clips.filter((c) => c.id !== clipId);
  removeSelection(clipId);
  notify();
}

export function rippleDelete(clipId) {
  const found = clipById(clipId);
  if (!found) return;
  found.track.clips = found.track.clips.filter((c) => c.id !== clipId);
  const gap = found.clip.duration;
  for (const c of found.track.clips) if (c.start >= found.clip.start + 0.0001) c.start -= gap;
  removeSelection(clipId);
  notify();
}

export function moveClip(clipId, newStart, newTrackId) {
  // ensure target track kind matches media kind (audio clip can't go to a video track, and vice versa)
  const found = clipById(clipId);
  if (!found) return;
  const c = found.clip;
  const sourceTrack = found.track;
  const media = getMedia(c.mediaId);
  const wantKind = media.type === "audio" ? "audio" : "video";
  let effTarget = state.tracks.find((t) => t.id === newTrackId);
  if (!effTarget || effTarget.kind !== wantKind) effTarget = sourceTrack;
  if (effTarget !== sourceTrack) {
    sourceTrack.clips = sourceTrack.clips.filter((c) => c.id !== clipId);
    effTarget.clips.push(c);
  }
  const delta = clamp(newStart, 0, 1e6) - c.start;
  c.start = clamp(newStart, 0, 1e6);
  if (effTarget !== sourceTrack) effTarget.clips.sort((a, b) => a.start - b.start);
  // Linked audio moves together with its video (unless explicitly unlinked).
  if (c.linkedId && c.linkMode !== "unlinked" && delta !== 0) {
    const linked = clipById(c.linkedId);
    if (linked) linked.clip.start = Math.max(0, linked.clip.start + delta);
  }
  notify();
}

export function trimClip(clipId, { start, offset, duration }) {
  const found = clipById(clipId);
  if (!found) return;
  const c = found.clip;
  const media = getMedia(c.mediaId);
  const maxLen = media?.type === "image" ? 600 : Math.max(1, finite(media?.duration, 600));
  if (duration != null) c.duration = clamp(finite(duration, c.duration), 0.1, Math.max(0.1, maxLen - c.offset));
  if (start != null) c.start = clamp(finite(start, c.start), 0, 1e6);
  if (offset != null) c.offset = clamp(finite(offset, c.offset), 0, Math.max(0, maxLen - c.duration));
  notify();
}

// =============================================================
//  Non-destructive placement (S3)
//  When a clip is dropped so it would OVERLAP other clips on the target track,
//  we never overwrite/destroy. We keep the requested start time, then find a
//  same-kind track that's free across the whole [start, start+dur) range
//  (excluding the moving clip). If none exists we create a new track of the
//  correct kind. A plain move to empty space just moves in place.
//  Returns { track, newStart } and does NOT mutate state (caller does the move).
// =============================================================
// desiredIndex: an exact position in state.tracks (0 = very front) to create the new
// track at, when one has to be created because every existing same-kind track is
// occupied at this time range. Computed by the UI from the pointer's precise vertical
// position across the WHOLE stack during a drag, so dropping between two specific
// existing layers works directly, not just "front of" or "behind" whatever single
// track happens to be nearest. Falls back to the old front-of/behind-anchor behavior
// if no exact index is given.
export function resolvePlacement(clipId, trackId, start, dur, desiredIndex = null) {
  // Determine the clip's kind from ITS media (clipId is a clip id, not a media id).
  let wantKind = "video";
  const clip = clipById(clipId);
  if (clip) wantKind = (getMedia(clip.clip.mediaId)?.type === "audio") ? "audio" : "video";
  const cand = state.tracks.filter((t) => t.kind === wantKind);
  const freeAt = (t) => !t.clips.some((c) => c.id !== clipId && c.start < start + dur && c.start + c.duration > start);
  const byId = (id) => state.tracks.find((t) => t.id === id);

  let t = byId(trackId);
  if (t && t.kind === wantKind && freeAt(t)) return { track: t, newStart: start };
  for (const other of cand) if (other.id !== clipId && freeAt(other)) return { track: other, newStart: start };

  // no free same-kind track -> create one, at the exact stack position requested.
  const name = wantKind === "video"
    ? `V${state.tracks.filter((x) => x.kind === "video").length + 1}`
    : `A${state.tracks.filter((x) => x.kind === "audio").length + 1}`;
  const nt = { id: uid("t"), kind: wantKind, name, muted: false, hidden: false, clips: [] };

  let idx;
  if (Number.isFinite(desiredIndex)) {
    idx = Math.max(0, Math.min(state.tracks.length, Math.round(desiredIndex)));
  } else {
    const anchorIdx = t ? state.tracks.indexOf(t) : -1;
    idx = anchorIdx === -1 ? (wantKind === "video" ? 0 : state.tracks.length) : anchorIdx;
  }
  state.tracks.splice(idx, 0, nt);
  return { track: nt, newStart: start, created: true };
}

// After adding or moving a clip, if it now overlaps other clips on its track,
// relocate it to a free same-kind track (creating one if necessary). Never destroys.
export function repositionIfOverlapping(clipId, desiredIndex = null) {
  const f = clipById(clipId);
  if (!f) return;
  const c = f.clip;
  const overlaps = f.track.clips.some((o) => o.id !== clipId && o.start < c.start + c.duration && o.start + o.duration > c.start);
  if (!overlaps) return;
  const place = resolvePlacement(clipId, f.track.id, c.start, c.duration, desiredIndex);
  moveClip(clipId, place.newStart, place.track.id);
}

export function setClipProp(clipId, path, value) {
  const found = clipById(clipId);
  if (!found) return;
  if (path in found.clip) found.clip[path] = value;
  else if (path.startsWith("filters.")) found.clip.filters[path.slice(8)] = value;
  // Per-clip property tweak: emit a light event so the preview redraws without rebuilding the timeline.
  emitter.emit("filter", clipId);
}

// Split a clip at absolute time. Returns the new right-half clip or null.
export function splitClip(clipId, time) {
  const found = clipById(clipId);
  if (!found) return null;
  const c = found.clip;
  const local = time - c.start;
  if (local <= 0.05 || local >= c.duration - 0.05) return null;
  const right = { ...c, id: uid("c"), start: c.start + local, duration: c.duration - local, offset: c.offset + local, filters: { ...c.filters } };
  c.duration = local;
  found.track.clips.push(right);
  found.track.clips.sort((a, b) => a.start - b.start);
  selectMany([c.id, right.id]);
  notify();
  return right;
}

// Split every clip (on every track) that the playhead crosses.
export function splitAllAtPlayhead() {
  let n = 0;
  for (const tr of state.tracks.slice()) {
    for (const c of tr.clips.slice()) {
      if (state.playhead > c.start + 0.05 && state.playhead < c.start + c.duration - 0.05) {
        if (splitClip(c.id, state.playhead)) n += 1;
      }
    }
  }
  return n;
}

// Return the clip on a track covering time t, or null.
export function clipAt(trackId, t) {
  const tr = state.tracks.find((x) => x.id === trackId);
  if (!tr) return null;
  return tr.clips.find((c) => t >= c.start && t < c.start + c.duration) || null;
}

// All clips covering t, with their track.
export function clipsAtTime(t) {
  const out = [];
  for (const tr of state.tracks) {
    const c = tr.clips.find((c) => t >= c.start && t < c.start + c.duration);
    if (c) out.push({ clip: c, track: tr });
  }
  return out;
}

// A set of candidate times for snapping within the visible neighborhood.
export function snapCandidates(excludeClipId) {
  const cands = [0, state.playhead];
  for (const tr of state.tracks) for (const c of tr.clips) {
    if (c.id === excludeClipId) continue;
    cands.push(c.start, c.start + c.duration);
  }
  return cands;
}
