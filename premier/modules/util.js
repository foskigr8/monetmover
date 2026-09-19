// Small shared utilities.

let __id = 0;
export function uid(prefix = "id") {
  __id += 1;
  return `${prefix}_${Date.now().toString(36)}_${__id.toString(36)}`;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Guard against non-finite (Infinity/NaN) values coming from media metadata.
export function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

// Resolve the true duration of a media element. Handles the Chrome quirk where a
// MediaRecorder-produced WebM Blob reports duration === Infinity until a seek past
// the end is performed, after which the real end time is exposed via timeupdate.
export function resolveMediaDuration(el, timeout = 1500) {
  return new Promise((resolve) => {
    const good = (v) => Number.isFinite(v) && v > 0.01;
    if (good(el.duration)) return resolve(el.duration);
    let done = false;
    const cleanup = () => {
      clearTimeout(tm);
      el.removeEventListener("loadeddata", onDur);
      el.removeEventListener("timeupdate", onTu);
      el.removeEventListener("seeked", onDur);
    };
    const finish = (v) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(good(v) ? v : good(el.duration) ? el.duration : 0);
    };
    const tm = setTimeout(() => finish(el.duration), timeout);
    const onDur = () => { if (good(el.duration)) finish(el.duration); };
    const onTu = () => {
      if (!good(el.duration) && good(el.currentTime)) finish(el.currentTime);
      else if (good(el.duration)) finish(el.duration);
    };
    el.addEventListener("loadeddata", onDur);
    el.addEventListener("timeupdate", onTu);
    el.addEventListener("seeked", onDur);
    try { el.currentTime = 1e101; } catch (e) { finish(el.duration); }
  });
}

// Format seconds as HH:MM:SS.mmm
export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
}

// Short seconds label e.g. 12.4s
export function fmtSec(sec) {
  if (!isFinite(sec)) return "—";
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(0).padStart(2, "0");
    return `${m}m ${s}s`;
  }
  return `${sec.toFixed(1)}s`;
}

export function pickMime(mimeTypes) {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of mimeTypes) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch (e) { /* ignore */ }
  }
  return null;
}
