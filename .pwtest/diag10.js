import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// video with a 440Hz tone for the FULL length (so we KNOW there's audio)
async function makeAV(page) {
  return page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const x = c.getContext("2d");
    const vstream = c.captureStream(30);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(); o.frequency.value = 440;
    const g = ac.createGain(); g.gain.value = 0.6;
    const dest = ac.createMediaStreamDestination(); o.connect(g); g.connect(dest); o.start();
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const ch = []; rec.ondataavailable = (e) => ch.push(e.data);
    const st = new Promise((r) => (rec.onstop = r)); rec.start();
    let t = 0;
    await new Promise((res) => { const f = () => { t += 1 / 30; x.fillStyle = `hsl(${t * 50 % 360},70%,50%)`; x.fillRect(0, 0, 320, 180); if (t < 2.4) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    await new Promise((r) => setTimeout(r, 120)); rec.stop(); await st;
    o.stop(); ac.close();
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}
// pure audio wav (sine)
async function makeWav(page) {
  return page.evaluate(() => {
    const sr = 22050, dur = 2, n = sr * dur;
    const d = new Int16Array(n); for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 12000;
    const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, n * 2, true);
    new Int16Array(buf, 44).set(d);
    return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob([buf], { type: "audio/wav" })); });
  });
}
(async () => {
  // REALISTIC: no --autoplay-policy override (like a real user's browser)
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text()); });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);

  const av = await makeAV(page);
  const wav = await makeWav(page);
  await page.setInputFiles("#file-input", [
    { name: "av.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") },
    { name: "tone.wav", mimeType: "audio/wav", buffer: Buffer.from(wav.split(",")[1], "base64") },
  ]);
  await sleep(1600);

  // put the video on a video track and the wav on an audio track
  await page.evaluate(() => { const m = [...window.__state.media.values()]; const vid = m.find((x) => x.type === "video"); window.__player._seekSource(0); const s = window.__state.src; s.mediaId = vid.id; s.in = 0; s.out = 1.5; });
  await page.evaluate(() => { const vid = [...window.__state.media.values()].find((x) => x.type === "video"); const tr = window.__state.tracks.find((t) => t.kind === "video"); window.__state.tracks = window.__state.tracks; });
  // use the bin + insert to add the video clip
  await page.locator(".bin-item", { hasText: "av.webm" }).first().click(); await sleep(150);
  await page.evaluate(() => { const vid = [...window.__state.media.values()].find((x) => x.type === "video"); window.__player.loadSource(vid.id); });
  await sleep(100);
  await page.click("#bin-insert"); await sleep(250);
  // add the wav to an audio track
  await page.locator(".bin-item", { hasText: "tone.wav" }).first().click(); await sleep(150);
  await page.evaluate(() => { const a = [...window.__state.media.values()].find((x) => x.type === "audio"); window.__player.loadSource(a.id); });
  await sleep(100);
  await page.click("#bin-insert"); await sleep(250);

  console.log("=== TIMELINE CLIP DOM (thumbnails + waveforms) ===");
  const dom = await page.evaluate(() => {
    const out = {};
    const vc = document.querySelector(".tl-canvas .clip.video");
    out.videoClip = vc ? {
      html_len: vc.innerHTML.length,
      has_img: !!vc.querySelector("img"),
      has_video_frame: !!vc.querySelector("video,canvas"),
      has_wave: !!vc.querySelector(".wave"),
      wave_rects: vc ? vc.querySelectorAll(".wave rect").length : 0,
      has_fader: !!vc.querySelector(".vol-track"),
      classes: vc.className,
    } : "NO VIDEO CLIP";
    const ac = document.querySelector(".tl-canvas .clip.audio");
    out.audioClip = ac ? {
      has_wave: !!ac.querySelector(".wave"),
      wave_rects: ac ? ac.querySelectorAll(".wave rect").length : 0,
      has_fader: !!ac.querySelector(".vol-track"),
    } : "NO AUDIO CLIP";
    return out;
  });
  console.log(JSON.stringify(dom, null, 1));

  console.log("\n=== AUDIO during PROGRAM playback (realistic, no autoplay unlock) ===");
  // attach an analyser on the master bus
  await page.evaluate(() => {
    const a = window.__audio; a.resume();
    if (!a._diagAnalyser) { a._diagAnalyser = a.ctx.createAnalyser(); a._diagAnalyser.fftSize = 2048; a.master.connect(a._diagAnalyser); a._diagBuf = new Float32Array(a._diagAnalyser.fftSize); }
    window.__rms = () => { a._diagAnalyser.getFloatTimeDomainData(a._diagBuf); let s = 0; for (let i = 0; i < a._diagBuf.length; i++) s += a._diagBuf[i] * a._diagBuf[i]; return Math.sqrt(s / a._diagBuf.length); };
  });
  const before = await page.evaluate(() => window.__audio.ctx.state);
  console.log("AudioContext state before play (realistic):", before);
  // real gesture: click the program play button
  await page.click("#tp-play");
  await sleep(500);
  let peak = 0;
  for (let i = 0; i < 10; i++) { const r = await page.evaluate(() => window.__rms()); peak = Math.max(peak, r); await sleep(120); }
  const after = await page.evaluate(() => ({ state: window.__audio.ctx.state, playing: window.__state.playing, btn: document.getElementById("tp-play").textContent, elPaused: (() => { const el = [...window.__player.clipEls.values()].find((e) => e && e.tagName === "VIDEO"); return el ? { paused: el.paused, muted: el.muted, ct: +el.currentTime.toFixed(2) } : null; })() }));
  console.log("after clicking program play:");
  console.log(JSON.stringify(after, null, 1));
  console.log("peak RMS during playback:", peak.toFixed(4), peak > 0.03 ? "(AUDIO IS FLOWING)" : "(NO AUDIO)");

  console.log("\npage errors:", pageErrors.length ? pageErrors.join(" | ") : "none");
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("DIAG CRASH:\n", e && e.stack ? e.stack : e); process.exit(2); });
