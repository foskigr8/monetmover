import { state, getMedia, addMedia, emitter } from "./state.js";
import { fmtSec } from "./util.js";
import { clipPeaks } from "./waveform.js";

export class BinUI {
  constructor() {
    this.grid = document.getElementById("bin-grid");
    this.count = document.getElementById("bin-count");
    this.selectedId = null;
    this.onSelect = null; // (mediaId)
  }

  select(mediaId) {
    this.selectedId = mediaId;
    this.render();
    if (this.onSelect) this.onSelect(mediaId);
  }
  getSelected() { return this.selectedId ? getMedia(this.selectedId) : null; }

  remove(id) {
    const m = getMedia(id);
    if (!m) return;
    state.media.delete(id);
    try { URL.revokeObjectURL(m.url); } catch (e) {}
    if (this.selectedId === id) this.selectedId = null;
    if (state.src.mediaId === id) state.src.mediaId = null;
    emitter.emit("change");
  }

  render() {
    const items = [...state.media.values()];
    this.count.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
    this.grid.innerHTML = "";

    if (!items.length) {
      const e = document.createElement("div");
      e.className = "bin-empty";
      e.innerHTML = "No media yet.<br>Import video, audio or image files to start editing.";
      this.grid.appendChild(e);
      return;
    }

    for (const m of items) {
      const item = document.createElement("div");
      item.className = "bin-item" + (this.selectedId === m.id ? " sel" : "");
      item.draggable = true;
      item.dataset.mediaId = m.id;

      const thumb = document.createElement("div");
      thumb.className = "bin-thumb";
      if (m.type === "video") {
        // media.thumb is a real decoded frame (data URL) captured at import time in
        // state.js's videoThumb(). A live <video> with a "#t=" fragment on a blob: URL
        // does not reliably show a frame (media fragments don't apply to blob URLs), so
        // prefer the already-correct cached frame and only fall back if it's missing.
        if (m.thumb) {
          const img = document.createElement("img");
          img.src = m.thumb; img.alt = m.name;
          thumb.appendChild(img);
        } else {
          const v = document.createElement("video");
          v.muted = true; v.playsInline = true; v.preload = "metadata";
          v.src = m.url + "#t=0.1";
          thumb.appendChild(v);
        }
        const ov = document.createElement("div"); ov.className = "play-ov"; ov.textContent = "▶";
        thumb.appendChild(ov);
        const badge = document.createElement("div"); badge.className = "badge";
        badge.textContent = `${Math.round(m.width)}×${Math.round(m.height)}`;
        thumb.appendChild(badge);
      } else if (m.type === "image" || m.type === "svg") {
        const img = document.createElement("img");
        img.src = m.url; img.alt = m.name;
        thumb.appendChild(img);
        const badge = document.createElement("div"); badge.className = "badge";
        badge.textContent = m.type === "svg" ? "SVG" : "IMG";
        thumb.appendChild(badge);
      } else {
        // Real waveform preview (same decoded peaks the timeline uses), falling back to
        // the note icon only while peaks are still decoding or if the file has no audio.
        const peaks = clipPeaks(m.id, 0, m.duration || 0, m.duration || 0);
        if (peaks && peaks.length) {
          const bars = Math.min(80, peaks.length);
          let rects = "";
          for (let i = 0; i < bars; i++) {
            const v = peaks[Math.floor((i / bars) * peaks.length)] || 0;
            const bh = 6 + v * 70;
            rects += `<rect x="${(i / bars) * 100}" y="${40 - bh / 2}" width="${100 / bars}" height="${bh}"/>`;
          }
          thumb.innerHTML = `<svg viewBox="0 0 100 40" preserveAspectRatio="none" style="width:100%;height:100%;fill:var(--green)">${rects}</svg>`;
        } else {
          const ov = document.createElement("div"); ov.className = "audio-ov"; ov.textContent = "♪";
          thumb.appendChild(ov);
        }
      }
      const durBadge = document.createElement("div");
      durBadge.className = "badge";
      durBadge.style.right = "4px"; durBadge.style.top = "4px"; durBadge.style.bottom = "auto";
      durBadge.textContent = (m.type === "image" || m.type === "svg") ? "3s" : fmtSec(m.duration || 0);
      thumb.appendChild(durBadge);

      const meta = document.createElement("div");
      meta.className = "bin-meta";
      const nm = document.createElement("span"); nm.className = "bin-name"; nm.textContent = m.name; nm.title = m.name;
      const del = document.createElement("button"); del.className = "bin-del"; del.textContent = "✕"; del.title = "Remove from project";
      del.onclick = (e) => { e.stopPropagation(); this.remove(m.id); };
      meta.appendChild(nm); meta.appendChild(del);

      item.appendChild(thumb);
      item.appendChild(meta);

      item.addEventListener("click", () => this.select(m.id));
      item.addEventListener("dblclick", () => { this.select(m.id); if (this.onDbl) this.onDbl(m.id); });
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/mediaid", m.id);
        e.dataTransfer.effectAllowed = "copy";
      });

      this.grid.appendChild(item);
    }
  }
}
