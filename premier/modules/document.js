// =============================================================
//  Project document (Phase 0) — the source of truth
//  ------------------------------------------------------------
//  A versioned, serializable representation of the project. The live
//  editor (tracks, playhead, media) is a runtime view; the document is
//  the durable, shareable, saveable form. Preview, export, (future) AI,
//  and save/reopen all derive from this same structure.
//
//  v1 schema:
//    {
//      version: 1,
//      meta: { name, comp: { fps, width, height } },
//      assets: [ { id, name, type, duration, width, height, clipLen, missing } ],
//      tracks: [ { id, kind, name, muted, hidden, clips: [ {id, mediaId, start, duration, offset, volume, filters} ] } ]
//    }
//
//  Media blob URLs are intentionally NOT persisted (they don't survive a
//  reload). Assets are stored by identity + metadata; on load they are
//  marked `missing` and can be re-linked (see future §58 missing-media).
//  Timeline structure and all edit data survive intact.
// =============================================================

import { state, emitter, normalizeClip } from "./state.js";

export const SCHEMA_VERSION = 1;

// Forward-only migrations: an array of fn(doc) that upgrade doc to the next version.
// migrations[0]: v0 -> v1, etc. (Currently v1 is the first version: no migrations.)
const migrations = [];

export function migrate(doc) {
  let v = doc.version || 0;
  let out = doc;
  while (v < SCHEMA_VERSION) {
    const fn = migrations[v];
    if (!fn) throw new Error(`No migration from v${v} to v${v + 1}`);
    out = fn(out);
    v += 1;
  }
  out.version = SCHEMA_VERSION;
  return out;
}

export function serializeDocument() {
  const assets = [...state.media.values()].map((m) => ({
    id: m.id, name: m.name, type: m.type,
    duration: m.duration, width: m.width, height: m.height,
    clipLen: m._clipLen || null,
    missing: !m.url,
  }));
  return {
    version: SCHEMA_VERSION,
    meta: { name: state.sequenceName, comp: { ...state.comp }, fitMode: state.fitMode || "fit" },
    assets,
    tracks: JSON.parse(JSON.stringify(state.tracks)),
  };
}

export function validate(doc) {
  const e = [];
  if (!doc || typeof doc !== "object") return ["document is not an object"];
  if (!Number.isInteger(doc.version)) e.push("missing integer version");
  if (!Array.isArray(doc.tracks)) e.push("tracks must be an array");
  else doc.tracks.forEach((t, i) => {
    if (!t.id) e.push(`track[${i}] missing id`);
    if (!t.kind) e.push(`track[${i}] missing kind`);
    if (!Array.isArray(t.clips)) e.push(`track[${i}] clips must be an array`);
  });
  return e;
}

// Restore a document into the live state. Returns the restored tracks count.
export function restoreDocument(doc) {
  if (typeof doc !== "object" || doc === null) throw new Error("restoreDocument: not an object");
  const migrated = migrate(doc);
  const problems = validate(migrated).filter((p) => !p.startsWith("missing integer version"));
  if (problems.length) throw new Error("restoreDocument: " + problems.join("; "));

  state.sequenceName = migrated.meta?.name || "Sequence 01";
  state.comp = { fps: 30, width: 1280, height: 720, ...(migrated.meta?.comp || {}) };
  state.fitMode = migrated.meta?.fitMode || "fit";
  state.tracks = JSON.parse(JSON.stringify(migrated.tracks));
  // Backfill any fields the current model needs (transform, etc.) for older documents.
  for (const t of state.tracks) for (const c of t.clips) normalizeClip(c);
  state.selectedClipId = null;
  state.activeTrackId = state.tracks.find((t) => t.kind === "video")?.id || state.tracks[0]?.id;
  state.playhead = 0;

  // Rebuild asset registry from the document. Keep any already-loaded media whose id
  // matches (so it can play immediately); mark the rest as missing (re-linkable).
  const nextMedia = new Map();
  for (const a of migrated.assets || []) {
    const existing = state.media.get(a.id);
    nextMedia.set(a.id, {
      id: a.id, name: a.name, type: a.type,
      duration: a.duration, width: a.width, height: a.height,
      _clipLen: a.clipLen || (a.type === "image" ? 3 : undefined),
      url: existing ? existing.url : null,
      el: existing ? existing.el : null,
      missing: !existing,
    });
  }
  state.media = nextMedia;

  emitter.emit("change");
  return state.tracks.length;
}

export function documentToJson(doc = serializeDocument()) {
  return JSON.stringify(doc, null, 2);
}
