// =============================================================
//  Command / transaction / history core (Phase 0)
//  ------------------------------------------------------------
//  The single mechanism through which project STATE is mutated.
//  Human UI, (future) AI, and tests all issue the same commands.
//
//  Undo/redo uses a lightweight structural snapshot of the tracks
//  (clips are plain data). This is deterministic and safe for every
//  timeline operation (move, trim, split, delete, duplicate, ripple,
//  add/remove track, property edits) and keeps "undo a logical edit"
//  coherent — which is what the future AI layer will rely on too.
// =============================================================

import { state, emitter } from "./state.js";

export const history = {
  undoStack: [],
  redoStack: [],
  depth: 60,
  label: null,
  _onUndo: null,
  _onRedo: null,

  canUndo() { return this.undoStack.length > 0; },
  canRedo() { return this.redoStack.length > 0; },

  _record(cmd) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.depth) this.undoStack.shift();
    this.redoStack.length = 0;
    this.label = cmd.label || cmd.id;
    emitter.emit("history", { label: this.label, canUndo: true, canRedo: false });
  },

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    try { cmd.undo(); } catch (e) { console.error("undo failed:", cmd.id, e); return false; }
    this.redoStack.push(cmd);
    this.label = (this.undoStack[this.undoStack.length - 1] || {}).label || cmd.label || cmd.id;
    emitter.emit("history", { label: this.label, canUndo: this.canUndo(), canRedo: true });
    if (this._onUndo) this._onUndo(cmd);
    return true;
  },

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    try { cmd.execute(); } catch (e) { console.error("redo failed:", cmd.id, e); return false; }
    this.undoStack.push(cmd);
    this.label = cmd.label || cmd.id;
    emitter.emit("history", { label: this.label, canUndo: true, canRedo: this.canRedo() });
    if (this._onRedo) this._onRedo(cmd);
    return true;
  },

  clear() { this.undoStack.length = 0; this.redoStack.length = 0; this.label = null; },

  // Record an already-applied custom command (for continuous gestures where the
  // "before" is captured explicitly rather than snapshotted after the fact).
  record(cmd) { this._record(cmd); },
};

// Deep structural snapshot of the timeline + transient edit context.
function snapshot() {
  return {
    tracks: JSON.parse(JSON.stringify(state.tracks)),
    playhead: state.playhead,
    selectedClipId: state.selectedClipId,
    activeTrackId: state.activeTrackId,
  };
}
function restore(snap) {
  state.tracks = snap.tracks;
  state.playhead = snap.playhead;
  state.activeTrackId = snap.activeTrackId;
  state.selectedClipId = snap.selectedClipId;
  if (state.selectedClipId && !state.tracks.some((t) => t.clips.some((c) => c.id === state.selectedClipId))) {
    state.selectedClipId = null;
  }
  emitter.emit("change");
}

// Wrap a state-mutating action as an undoable, transactional command.
// `apply` mutates state (and may notify); we snapshot before/after and
// restore on failure so a failing command never leaves partial state.
export function snapshotCommand(id, label, apply) {
  const before = snapshot();
  let result;
  try {
    result = apply();
  } catch (e) {
    restore(before);                 // transactional: leave project unchanged
    console.error("command failed:", id, e);
    return null;
  }
  const after = snapshot();
  const cmd = {
    id, label: label || id,
    execute: () => restore(after),   // used by redo
    undo: () => restore(before),
  };
  history._record(cmd);
  return result;
}

// For continuous gestures (e.g. a slider drag): capture the state once at the
// start, mutate freely, then commit ONE undoable action at the end.
export function captureSnapshot() { return snapshot(); }
export function commitEdit(before, label, id = "setProperty") {
  const after = snapshot();
  const cmd = { id, label: label || id, execute: () => restore(after), undo: () => restore(before) };
  history._record(cmd);
  return cmd;
}
