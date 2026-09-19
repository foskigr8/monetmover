import { state, getMedia, clipById, setClipProp, emitter } from "./state.js";
import { actSplitClip, actDuplicate, actRippleDelete, actDelete, actFitToComp, captureSnapshot, commitEdit } from "./actions.js";
import { fmtTime, fmtSec } from "./util.js";

const F = [
  { key: "brightness", label: "Brightness", min: 0, max: 200, step: 1, def: 100, unit: "%" },
  { key: "contrast", label: "Contrast", min: 0, max: 200, step: 1, def: 100, unit: "%" },
  { key: "saturate", label: "Saturation", min: 0, max: 200, step: 1, def: 100, unit: "%" },
  { key: "blur", label: "Blur", min: 0, max: 20, step: 0.1, def: 0, unit: "px" },
  { key: "grayscale", label: "Grayscale", min: 0, max: 100, step: 1, def: 0, unit: "%" },
  { key: "sepia", label: "Sepia", min: 0, max: 100, step: 1, def: 0, unit: "%" },
  { key: "hue", label: "Hue Rotate", min: 0, max: 360, step: 1, def: 0, unit: "°" },
];

export class InspectorUI {
  constructor() {
    this.body = document.getElementById("insp-body");
    this._clipId = null;
    this._controls = {};
    emitter.on("change", () => this.onChange());
    this.onChange();
  }

  onChange() {
    const found = clipById(state.selectedClipId);
    if (!found) { this._clipId = null; this.renderEmpty(); return; }
    if (found.clip.id !== this._clipId) { this._clipId = found.clip.id; this.build(found); }
    else this.syncValues(found);
  }

  renderEmpty() {
    this._controls = {};
    this.body.innerHTML = `<div class="empty-note">Select a clip on the timeline to edit its properties.</div>`;
  }

  build({ clip, track }) {
    const media = getMedia(clip.mediaId);
    const isAudio = media?.type === "audio";
    const c = clip;
    const f = c.filters;

    this.body.innerHTML = "";
    const wrap = document.createElement("div");

    const title = document.createElement("div");
    title.className = "insp-clip";
    title.textContent = media?.name || "clip";
    const sub = document.createElement("div");
    sub.className = "insp-sub";
    sub.textContent = `${track.name} · ${fmtSec(c.start)} → ${fmtSec(c.start + c.duration)} · ${fmtSec(c.duration)}${isAudio ? "" : ` · src ${fmtSec(c.offset)}`}`;
    wrap.appendChild(title); wrap.appendChild(sub);

    // --- Audio / volume
    const aGrp = document.createElement("div"); aGrp.className = "grp";
    aGrp.innerHTML = `<div class="grp-title">${isAudio ? "Audio" : "Audio & Opacity"}</div>`;
    aGrp.appendChild(this._slider("volume", "Volume", c.volume, 0, 2, 0.01, (v) => v.toFixed(2) + "×"));
    if (!isAudio) aGrp.appendChild(this._slider("filters.opacity", "Opacity", f.opacity, 0, 100, 1, (v) => Math.round(v) + "%"));
    wrap.appendChild(aGrp);

    // --- Video filters
    if (!isAudio) {
      const vGrp = document.createElement("div"); vGrp.className = "grp";
      vGrp.innerHTML = `<div class="grp-title">Video Effects</div>`;
      for (const cfg of F) vGrp.appendChild(this._slider("filters." + cfg.key, cfg.label, f[cfg.key], cfg.min, cfg.max, cfg.step, (v) => Math.round(v * 10) / 10 + cfg.unit));
      wrap.appendChild(vGrp);
    }

    // --- Actions
    const acts = document.createElement("div"); acts.className = "grp";
    acts.innerHTML = `<div class="grp-title">Actions</div>`;
    const row = document.createElement("div"); row.className = "insp-actions";
    const mk = (label, fn, danger) => {
      const b = document.createElement("button"); b.className = "chip" + (danger ? " danger" : ""); b.textContent = label;
      b.onclick = () => fn(); row.appendChild(b);
    };
    mk("✂ Split @ playhead", () => actSplitClip(c.id, state.playhead));
    mk("⧉ Duplicate", () => actDuplicate(c.id));
    if (!isAudio) mk("⊡ Fit to comp", () => actFitToComp(c.id));
    mk("⭦ Ripple delete", () => actRippleDelete(c.id), true);
    mk("✕ Delete", () => actDelete(c.id), true);
    acts.appendChild(row);

    wrap.appendChild(acts);
    this.body.appendChild(wrap);
    this.syncValues({ clip, track });
  }

  _slider(path, label, value, min, max, step, fmt) {
    const ctl = document.createElement("div"); ctl.className = "ctl";
    const lab = document.createElement("label"); lab.textContent = label;
    const range = document.createElement("input"); range.type = "range";
    range.min = min; range.max = max; range.step = step; range.value = value;
    const val = document.createElement("span"); val.className = "val"; val.textContent = fmt(value);
    let captured = null;
    range.addEventListener("input", () => {
      const v = parseFloat(range.value);
      val.textContent = fmt(v);
      const clip = clipById(state.selectedClipId);
      if (!clip) return;
      if (captured == null) captured = captureSnapshot(); // one undo step for the whole drag
      setClipProp(clip.clip.id, path, v);
    });
    range.addEventListener("change", () => {
      if (captured != null) { commitEdit(captured, label, "setProperty"); captured = null; }
    });
    ctl.appendChild(lab); ctl.appendChild(range); ctl.appendChild(val);
    this._controls[path] = { range, val, fmt };
    return ctl;
  }

  syncValues(found) {
    const clip = found.clip;
    for (const [path, c] of Object.entries(this._controls)) {
      let v;
      if (path.startsWith("filters.")) v = clip.filters[path.slice(8)];
      else v = clip[path];
      if (c.range.value != null && parseFloat(c.range.value) !== v) { c.range.value = v; }
      c.val.textContent = c.fmt(v);
    }
  }
}
