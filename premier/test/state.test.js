import {
  state, initTracks, addTrack, addClip, moveClip, trimClip,
  splitClip, removeClip, rippleDelete, sequenceDuration,
  clipAt, clipsAtTime, snapCandidates, firstTrackOfKind,
} from "../modules/state.js";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log("  ✗ FAIL:", msg); } }
const approx = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// seed a fake "video" media (bypass importFile / DOM)
state.media.set("m1", { id: "m1", name: "clip.mp4", type: "video", url: "blob:x", duration: 10, width: 1280, height: 720, el: null });
state.media.set("m2", { id: "m2", name: "b-roll.mp4", type: "video", url: "blob:y", duration: 20, width: 1920, height: 1080, el: null });
state.media.set("m3", { id: "m3", name: "music.mp3", type: "audio", url: "blob:z", duration: 30, width: 0, height: 0, el: null });
state.media.set("m4", { id: "m4", name: "logo.png", type: "image", url: "blob:w", duration: 0, width: 500, height: 500, el: null, _clipLen: 3 });

initTracks();
ok(state.tracks.length === 3, "init creates 3 tracks");
ok(state.tracks[0].kind === "video" && state.tracks[2].kind === "audio", "track kinds");

const V1 = firstTrackOfKind("video"); // bottom video
const A1 = state.tracks.find((t) => t.kind === "audio");

// add clips
const c1 = addClip({ mediaId: "m1", trackId: V1.id, start: 0, offset: 0, duration: 5 });
addClip({ mediaId: "m2", trackId: V1.id, start: 5, offset: 2, duration: 3 });
const c3 = addClip({ mediaId: "m3", trackId: A1.id, start: 0, offset: 0, duration: 8 });
addClip({ mediaId: "m4", trackId: V1.id, start: 12, offset: 0, duration: 3 });

ok(sequenceDuration() === 15, "sequence duration 15, got " + sequenceDuration());
ok(V1.clips.length === 3, "V1 has 3 clips");
ok(c3.duration === 8, "audio clip duration 8");
ok(c3.volume === 1 && c3.filters.opacity === 100, "clip defaults");

// clipAt / clipsAtTime
ok(!!clipAt(V1.id, 2) && clipAt(V1.id, 2).id === c1.id, "clipAt V1@2 -> c1");
ok(clipsAtTime(1).length === 2, "two clips active at t=1 (video+audio)");

// split
state.playhead = 2.5;
const right = splitClip(c1.id, 2.5);
ok(!!right, "split returns right clip");
ok(approx(c1.duration, 2.5) && approx(right.duration, 2.5), "split durations 2.5/2.5");
ok(approx(right.start, 2.5), "right start 2.5");
ok(V1.clips.length === 4, "V1 now 4 clips after split");

// move clip (same track)
moveClip(c3.id, 4, A1.id);
ok(approx(c3.start, 4), "audio clip moved to 4");

// trim right
trimClip(c3.id, { duration: 10 });
ok(approx(c3.duration, 10), "trim right duration 10");
trimClip(c3.id, { duration: 9999 });
ok(c3.duration <= 30, "trim clamped to media duration (<=30), got " + c3.duration);

// image clip min duration
trimClip(V1.clips.find(c => c.mediaId === "m4").id, { duration: 0.0001 });
ok(V1.clips.find(c => c.mediaId === "m4").duration >= 0.1, "image min dur 0.1");

// cross-track move (video clip onto the other video track)
const V2 = state.tracks.find((t) => t.kind === "video" && t.id !== V1.id);
const targetId = V2.id;
const vid = V1.clips[0];
moveClip(vid.id, 0, targetId);
ok(V2.clips.some(c => c.id === vid.id), "video clip moved to V2");
ok(!V1.clips.some(c => c.id === vid.id), "video clip removed from V1");

// audio clip cannot move onto a video track (kind check reverts it)
const audioId = c3.id;
ok(state.tracks.find(t => t.id === A1.id).clips.some(c => c.id === audioId), "audio clip is on A1 before cross-kind drop");
moveClip(audioId, 0, V2.id); // try to drop an audio clip on a video track
ok(state.tracks.find(t => t.id === A1.id).clips.some(c => c.id === audioId), "audio clip stays on A1 after cross-kind drop");
ok(!V2.clips.some(c => c.id === audioId), "audio clip not placed on V2");

// ripple delete: put a second clip after, ripple-delete the first, expect shift
const vidLen = vid.duration;
addClip({ mediaId: "m2", trackId: V2.id, start: 6, offset: 0, duration: 3 });
ok(V2.clips.length === 2, "V2 has 2 clips before ripple");
rippleDelete(V2.clips[0].id);
ok(V2.clips.length === 1, "ripple delete removes 1");
ok(approx(V2.clips[0].start, 6 - vidLen), "remaining clip shifted left by removed duration, got " + V2.clips[0].start);
ok(approx(V2.clips[0].duration, 3), "remaining clip duration unchanged");

// remove
removeClip(V2.clips[0].id);
ok(V2.clips.length === 0, "remove empties V2");

// add tracks
addTrack("video");
ok(state.tracks.some(t => t.name === "V3"), "added V3 video track");
addTrack("audio");
ok(state.tracks.some(t => t.name === "A2"), "added A2 audio track");

// snap candidates include playhead and clip edges
const cand = snapCandidates(c1.id);
ok(cand.includes(state.playhead), "snap candidates include playhead");
ok(cand.includes(0), "snap candidates include 0");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
