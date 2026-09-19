// =============================================================
//  Real audio waveforms (S8)
//  ------------------------------------------------------------
//  Decodes each media asset's audio into a fixed set of amplitude
//  "peaks" across its FULL source length, cached per asset. The
//  timeline then renders only the sub-range a clip covers
//  ([offset, offset+duration]), so trimming/splitting a clip
//  automatically shows the matching audio — the waveform can never
//  drift from the sound that actually plays.
//  Decoding is async + lazy (triggered on import); the timeline
//  re-renders once peaks are ready.
// =============================================================
import { emitter } from "./state.js";

export const PEAKS = 512;
const cache = new Map(); // mediaId -> Float32Array|null
const pending = new Set();

export function peaksFor(mediaId) {
  return cache.has(mediaId) ? cache.get(mediaId) : null;
}

// Kick off decoding for a media asset (no-op if already cached/pending).
export function ensureWaveform(media) {
  if (!media || !media.url || !media.id) return;
  if (cache.has(media.id) || pending.has(media.id)) return;
  if (media.type === "image") { cache.set(media.id, null); return; }
  pending.add(media.id);
  (async () => {
    let peaks = null;
    try {
      const buf = await (await fetch(media.url)).arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const audioBuf = await ac.decodeAudioData(buf);
      try { ac.close(); } catch (e) {}
      peaks = computePeaks(audioBuf);
    } catch (e) {
      peaks = null; // no decodable audio (silent/unsupported)
    }
    pending.delete(media.id);
    cache.set(media.id, peaks);
    // mark whether this asset actually carries decodable audio (drives the volume fader)
    media._hasAudio = peaks != null;
    emitter.emit("waveform", media.id); // let the timeline re-render this clip's bars
  })();
}

function computePeaks(audioBuf) {
  const data = audioBuf.getChannelData(0);
  const peaks = new Float32Array(PEAKS);
  const step = data.length / PEAKS;
  for (let i = 0; i < PEAKS; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(data.length, Math.floor((i + 1) * step));
    // sample every few frames within the bin (fast, representative max amplitude)
    const every = Math.max(1, (end - start) >> 6);
    let max = 0;
    for (let j = start; j < end; j += every) {
      const v = data[j];
      const a = v < 0 ? -v : v;
      if (a > max) max = a;
    }
    peaks[i] = max;
  }
  // normalize to 0..1 (if there's any signal)
  let peak = 0;
  for (let i = 0; i < PEAKS; i++) if (peaks[i] > peak) peak = peaks[i];
  if (peak > 0) for (let i = 0; i < PEAKS; i++) peaks[i] = peaks[i] / peak;
  return peaks;
}

// Map a clip's [offset, offset+duration] onto the full source and return the
// sub-range peak array (so the clip's bars show exactly its audio).
export function clipPeaks(mediaId, offset, duration, mediaDuration) {
  const full = peaksFor(mediaId);
  if (!full || !mediaDuration || mediaDuration <= 0) return null;
  const f0 = clamp01(offset / mediaDuration);
  const f1 = clamp01((offset + duration) / mediaDuration);
  const i0 = Math.floor(f0 * PEAKS);
  const i1 = Math.max(i0 + 1, Math.ceil(f1 * PEAKS));
  const out = new Float32Array(i1 - i0);
  for (let i = 0; i < i1 - i0; i++) out[i] = full[i0 + i];
  return out;
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
