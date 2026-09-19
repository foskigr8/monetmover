import { state, sequenceDuration } from "./state.js";
import { audio } from "./audio.js";
import { pickMime } from "./util.js";

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export function mimeExt(mime) {
  if (!mime) return "webm";
  return mime.includes("mp4") ? "mp4" : "webm";
}

// Records the program canvas + audio graph while the player runs through the sequence.
export function exportSequence({ canvas, player, onProgress }) {
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder === "undefined") {
      reject(new Error("MediaRecorder is not supported in this browser."));
      return;
    }
    const d = sequenceDuration();
    if (d <= 0.05) {
      reject(new Error("The timeline is empty — add some clips before exporting."));
      return;
    }

    audio.resume();
    player.seek(0, { scrub: true });

    const canvasStream = canvas.captureStream(30);
    const audioStream = audio.startExport();
    const tracks = [...canvasStream.getVideoTracks()];
    if (audioStream) tracks.push(...audioStream.getAudioTracks());
    const stream = new MediaStream(tracks);

    const mime = pickMime(MIME_CANDIDATES);
    const rec = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: 10_000_000,
      audioBitsPerSecond: 192_000,
    });

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => { cleanup(); reject(e.error || new Error("Recording error")); };
    rec.start(100);

    let finished = false;
    function cleanup() {
      try { rec.stop(); } catch (e) {}
      canvasStream.getTracks().forEach((t) => t.stop());
      audio.stopExport();
      player.endExport();
      if (timer) clearInterval(timer);
    }

    const timer = setInterval(() => {
      if (onProgress) onProgress(Math.min(1, player.t / Math.max(0.001, d)));
    }, 120);

    player.beginExport();
    player.exportDone = () => {
      if (finished) return;
      finished = true;
      // give the recorder a tick to flush the final data
      setTimeout(() => {
        try { rec.stop(); } catch (e) {}
        canvasStream.getTracks().forEach((t) => t.stop());
        audio.stopExport();
        player.endExport();
        if (timer) clearInterval(timer);
        const blob = new Blob(chunks, { type: rec.mimeType || mime || "video/webm" });
        if (onProgress) onProgress(1);
        resolve(blob);
      }, 200);
    };

    player.play();
  });
}
