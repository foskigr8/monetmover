// Web Audio routing: one MediaElementSource + Gain per timeline element.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.exportDest = null;
    this.nodes = new Map(); // element -> {src, gain}
  }

  _Ctor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    return AC;
  }

  ensure() {
    if (this.ctx) return;
    const AC = this._Ctor();
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
  }

  resume() {
    this.ensure();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  connect(el) {
    if (!el || this.nodes.has(el)) return this.nodes.get(el);
    this.ensure();
    if (!this.ctx) return null;
    let src;
    try {
      src = this.ctx.createMediaElementSource(el);
    } catch (e) {
      return null; // element may have been attached already elsewhere
    }
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    src.connect(gain);
    gain.connect(this.master);
    const node = { src, gain };
    this.nodes.set(el, node);
    return node;
  }

  disconnect(el) {
    const n = this.nodes.get(el);
    if (!n) return;
    try { n.src.disconnect(); } catch (e) {}
    try { n.gain.disconnect(); } catch (e) {}
    this.nodes.delete(el);
  }

  setVolume(el, v) {
    const n = this.nodes.get(el);
    if (n) {
      try { n.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); } catch (e) { n.gain.gain.value = v; }
    }
  }

  // Route everything to a MediaStreamDestination for export; returns its audio stream.
  startExport() {
    this.ensure();
    if (!this.ctx) return null;
    this.stopExport();
    this.exportDest = this.ctx.createMediaStreamDestination();
    this.master.connect(this.exportDest);
    return this.exportDest.stream;
  }

  stopExport() {
    if (this.exportDest) {
      try { this.master.disconnect(this.exportDest); } catch (e) {}
      this.exportDest = null;
    }
  }
}

export const audio = new AudioEngine();
