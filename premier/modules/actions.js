// =============================================================
//  Semantic editing actions (Phase 0)
//  ------------------------------------------------------------
//  The UI (and later the AI) call THESE, not the raw state mutators.
//  Each action is a snapshot-based command -> undoable + transactional.
//  This is the single entry point that makes every mutation recoverable
//  and deterministic, and it's what future AI commands will reuse.
// =============================================================

import {
  state, getMedia, clipById, addClip, moveClip, trimClip, splitClip, splitAllAtPlayhead,
  removeClip, rippleDelete, setClipProp, addTrack, initTracks, resolvePlacement, repositionIfOverlapping,
  makeClip, emitter, defaultTransform,
} from "./state.js";
import { uid } from "./util.js";
import { snapshotCommand, captureSnapshot, commitEdit } from "./commands.js";
export { captureSnapshot, commitEdit };

// --- timeline items -------------------------------------------------
export const actAddClip = (params) =>
  snapshotCommand("addClip", "Add clip", () => {
    const clip = addClip(params);
    repositionIfOverlapping(clip.id); // never overwrite an occupied slot
    return clip;
  });

// Insert a fully-specified clip (mediaId + placement + properties) as ONE command.
export const actInsertPrepared = (p) =>
  snapshotCommand("insert", "Insert clip", () => {
    const clip = addClip({
      mediaId: p.mediaId, trackId: p.trackId,
      start: p.start != null ? p.start : 0,
      offset: p.offset != null ? p.offset : 0,
      duration: p.duration != null ? p.duration : undefined,
    });
    if (p.volume != null) clip.volume = p.volume;
    if (p.filters) clip.filters = { ...p.filters };
    repositionIfOverlapping(clip.id); // never overwrite an occupied slot
    emitter.emit("change");
    return clip;
  });

export const actMoveClip = (clipId, start, trackId, desiredIndex = null) =>
  snapshotCommand("moveClip", "Move clip", () => {
    moveClip(clipId, start, trackId);
    repositionIfOverlapping(clipId, desiredIndex); // overlap -> auto free/new track, never destroy
  });

export const actTrimClip = (clipId, parts) =>
  snapshotCommand("trimClip", "Trim clip", () => trimClip(clipId, parts));

// Direct canvas manipulation: set a clip's transform (x/y/w/h/rotation) in comp space.
export const actSetTransform = (clipId, transform) =>
  snapshotCommand("transform", "Transform", () => {
    const f = clipById(clipId);
    if (!f) return;
    f.clip.transform = { ...f.clip.transform, ...transform };
    emitter.emit("change");
  });

export const actSplitClip = (clipId, t) =>
  snapshotCommand("splitClip", "Split clip", () => splitClip(clipId, t));

export const actSplitAllAtPlayhead = () =>
  snapshotCommand("splitAtPlayhead", "Split at playhead", () => splitAllAtPlayhead());

export const actDelete = (clipId) =>
  snapshotCommand("delete", "Delete clip", () => removeClip(clipId));

// Delete every selected clip as ONE undoable action.
export const actDeleteSelection = (ids) =>
  snapshotCommand("deleteSelection", "Delete selection", () => {
    for (const id of ids) {
      const tr = state.tracks.find((t) => t.clips.some((c) => c.id === id));
      if (tr) tr.clips = tr.clips.filter((c) => c.id !== id);
    }
    state.selection = [];
    state.selectedClipId = null;
    emitter.emit("change");
  });

export const actRippleDelete = (clipId) =>
  snapshotCommand("rippleDelete", "Ripple delete", () => rippleDelete(clipId));

export const actDuplicate = (clipId) => {
  const f = findClip(clipId);
  if (!f) return null;
  return snapshotCommand("duplicate", "Duplicate clip", () => {
    const c = f.clip;
    const clip = addClip({
      mediaId: c.mediaId, trackId: f.track.id, start: c.start + c.duration,
      offset: c.offset, duration: c.duration,
    });
    clip.volume = c.volume; clip.filters = { ...c.filters };
    emitter.emit("change");
    return clip;
  });
};

export const actSetProp = (clipId, path, value) =>
  snapshotCommand("setProperty", "Edit property", () => setClipProp(clipId, path, value));

// --- tracks ---------------------------------------------------------
export const actAddTrack = (kind) =>
  snapshotCommand("addTrack", "Add track", () => addTrack(kind));

export const actRemoveTrack = (trackId) =>
  snapshotCommand("removeTrack", "Remove track", () => {
    if (state.tracks.length <= 1) throw new Error("Cannot remove the last track");
    state.tracks = state.tracks.filter((t) => t.id !== trackId);
    if (!state.activeTrackId || !state.tracks.find((t) => t.id === state.activeTrackId)) {
      state.activeTrackId = state.tracks[0]?.id;
    }
    let v = 0, a = 0;
    for (const t of state.tracks.slice().reverse()) { if (t.kind === "video") t.name = `V${++v}`; else t.name = `A${++a}`; }
    emitter.emit("change");
  });

// Reset the timeline to a fresh empty set of tracks (undoable).
export const actNewSequence = () =>
  snapshotCommand("newSequence", "New sequence", () => {
    initTracks();
    state.playhead = 0;
    state.selectedClipId = null;
    emitter.emit("change");
  });

// Extract a video clip's audio into its own linked audio clip on a free audio track.
// The video stays (its audio is now represented by the new clip) and the two are linked.
export const actExtractAudio = (videoClipId) =>
  snapshotCommand("extractAudio", "Extract audio", () => {
    const f = clipById(videoClipId);
    if (!f) return null;
    const c = f.clip;
    const media = getMedia(c.mediaId);
    if (!media || media.type === "audio") return null;
    // build a lightweight audio "asset" that shares the video's blob url
    if (!state.media.has(media.id + "#audio")) {
      state.media.set(media.id + "#audio", { ...media, id: media.id + "#audio", type: "audio", name: media.name + " (audio)" });
    }
    const audioMediaId = media.id + "#audio";
    const clip = makeClip({ mediaId: audioMediaId, start: c.start, offset: c.offset, duration: c.duration });
    // place on a FREE audio track at the same start (create one if needed) — never destroys
    const freeAudio = () => state.tracks.filter((t) => t.kind === "audio")
      .find((t) => !t.clips.some((o) => o.start < clip.start + clip.duration && o.start + o.duration > clip.start));
    let target = freeAudio();
    if (!target) {
      target = { id: uid("t"), kind: "audio", name: `A${state.tracks.filter((t) => t.kind === "audio").length + 1}`, muted: false, hidden: false, clips: [] };
      state.tracks.push(target); // new audio track at the bottom
    }
    target.clips.push(clip);
    target.clips.sort((a, b) => a.start - b.start);
    c.linkedId = clip.id;
    c.linkMode = "linked";
    c.audioExtracted = true;
    clip.linkedId = c.id;
    clip.linkMode = "linked";
    emitter.emit("change");
    return clip.id;
  });

// Toggle link/unlink between a clip and its linked partner (moves together or not).
export const actToggleLink = (clipId) =>
  snapshotCommand("toggleLink", "Link / unlink", () => {
    const f = clipById(clipId);
    if (!f) return null;
    const c = f.clip;
    if (!c.linkedId) return null;
    c.linkMode = c.linkMode === "unlinked" ? "linked" : "unlinked";
    const partner = clipById(c.linkedId);
    if (partner) partner.clip.linkMode = c.linkMode;
    emitter.emit("change");
    return c.linkMode;
  });

// Visual stacking (z-order), independent of track order. Each op adjusts the clip's
// zIndex among the currently-visible video clips so it moves relative to the rest.
function _visibleZs(excludeId) {
  const zs = [];
  for (const tr of state.tracks) if (tr.kind === "video" && !tr.hidden) for (const c of tr.clips) if (c.id !== excludeId) zs.push(c.zIndex || 0);
  return zs;
}
export const actZOrder = (clipId, op) =>
  snapshotCommand("zOrder", "Z-order", () => {
    const f = clipById(clipId);
    if (!f) return null;
    const c = f.clip;
    const zs = _visibleZs(clipId);
    const cur = c.zIndex || 0;
    let next = cur;
    if (op === "front") next = (zs.length ? Math.max(...zs) : 0) + 1;
    else if (op === "back") next = (zs.length ? Math.min(...zs) : 0) - 1;
    else if (op === "forward") next = zs.length ? Math.min(...zs.filter((z) => z > cur), cur + 1) : cur + 1;
    else if (op === "backward") next = zs.length ? Math.max(...zs.filter((z) => z < cur), cur - 1) : cur - 1;
    c.zIndex = next;
    emitter.emit("change");
    return next;
  });

// Fit the clip to the composition using the current fit mode.
export const actFitToComp = (clipId) =>
  snapshotCommand("fitToComp", "Fit to comp", () => {
    const f = clipById(clipId);
    if (!f) return;
    const c = f.clip;
    const media = getMedia(c.mediaId);
    if (!media) return;
    c.transform = defaultTransform(media, state.comp, state.fitMode);
    emitter.emit("change");
  });

function findClip(id) {
  for (const tr of state.tracks) { const c = tr.clips.find((x) => x.id === id); if (c) return { clip: c, track: tr }; }
  return null;
}
