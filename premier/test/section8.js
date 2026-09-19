import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeAudioVideo(page) {
  return page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const x = c.getContext("2d");
    const vstream = c.captureStream(30);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(); o.frequency.value = 440;
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, ac.currentTime); g.gain.linearRampToValueAtTime(0.9, ac.currentTime + 2.2);
    const dest = ac.createMediaStreamDestination(); o.connect(g); g.connect(dest); o.start();
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const ch = []; rec.ondataavailable = (e) => ch.push(e.data);
    const st = new Promise((r) => (rec.onstop = r)); rec.start();
    let t = 0;
    await new Promise((res) => { const f = () => { t += 1 / 30; x.fillStyle = `hsl(${t * 40 % 360},70%,50%)`; x.fillRect(0, 0, 320, 180); if (t < 2.2) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    await new Promise((r) => setTimeout(r, 120)); rec.stop(); await st;
    o.stop(); ac.close();
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}
const barRects = (page, clipId) => page.evaluate((id) => {
  const el = document.querySelector(`.tl-canvas .clip[data-clip-id="${id}"] .wave`);
  return el ? [...el.querySelectorAll("rect")].map((r) => parseFloat(r.getAttribute("height"))) : null;
}, clipId);

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);

  const av = await makeAudioVideo(page);
  await page.setInputFiles("#file-input", [{ name: "av.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1600);
  const dur = await page.evaluate(() => { const m = [...window.__state.media.values()][0]; return m.duration || 1; });

  // place a clip that covers the SECOND HALF of the source (offset ~ dur*0.5)
  const off = dur * 0.5;
  await page.locator(".bin-item").first().click(); await sleep(150);
  await page.evaluate(({ o, d }) => { window.__player._seekSource(o); window.__state.src.in = o; window.__state.src.out = o + Math.min(0.6, d - o); }, { o: off, d: dur });
  await page.click("#src-insert"); await sleep(300);
  const clipId = await page.evaluate(() => window.__state.tracks.find((t) => t.clips.length).clips[0].id);
  const clip0 = await page.evaluate((id) => {
    for (const t of window.__state.tracks) { const c = t.clips.find((x) => x.id === id); if (c) return { offset: c.offset, duration: c.duration, start: c.start }; }
    return null;
  }, clipId);
  ok(Math.abs(clip0.offset - off) < 0.1, `clip placed on the 2nd half of the source (offset=${clip0.offset.toFixed(2)})`);

  // wait for the REAL decoded waveform for this clip's range
  let peaks = null;
  for (let i = 0; i < 40; i++) { peaks = await page.evaluate((id) => window.__clipPeaks(id) ? [...window.__clipPeaks(id)] : null, clipId); if (peaks && peaks.length) break; await sleep(120); }
  ok(peaks && peaks.length > 0, `clip has a real decoded waveform for its range (${peaks ? peaks.length : 0} bars)`);
  const rect1 = await barRects(page, clipId);
  ok(rect1 && rect1.length > 5, `waveform SVG rendered on the clip (${rect1 ? rect1.length : 0} bars)`);
  ok(new Set(rect1.map((r) => r.toFixed(1))).size > 3, "waveform bars vary with the audio (not a flat/fake fill)");

  console.log("== the waveform reflects the CLIP range, not the whole source ==");
  // a clip covering a DIFFERENT range of the same source should have different peaks
  const pFirst = await page.evaluate((o) => window.__rangePeaks(0, o) ? [...window.__rangePeaks(0, o)] : null, off);
  const pSecond = await page.evaluate((p) => window.__rangePeaks(p.o, p.d) ? [...window.__rangePeaks(p.o, p.d)] : null, { o: off, d: clip0.duration });
  const same = pFirst && pSecond && pFirst.length === pSecond.length && pFirst.every((v, i) => Math.abs(v - pSecond[i]) < 0.02);
  ok(pFirst && pSecond && !same, `first-half vs second-half of the source have different waveforms (first[0..2]=${pFirst ? pFirst.slice(0, 3).map((v) => v.toFixed(2)).join(",") : "?"}, second[0..2]=${pSecond ? pSecond.slice(0, 3).map((v) => v.toFixed(2)).join(",") : "?"})`);

  console.log("== trimming the clip changes its waveform to match the new range ==");
  const peaksBefore = await page.evaluate((id) => window.__clipPeaks(id) ? [...window.__clipPeaks(id)] : null, clipId);
  await page.evaluate(({ id, o, s, d }) => { window.__trim(id, s + 0.2, o + 0.2, d - 0.2); }, { id: clipId, o: clip0.offset, s: clip0.start, d: clip0.duration });
  await sleep(250);
  const peaksAfter = await page.evaluate((id) => window.__clipPeaks(id) ? [...window.__clipPeaks(id)] : null, clipId);
  const rect2 = await barRects(page, clipId);
  // with a ramped tone, the later (trimmed) range has a different amplitude profile than before
  const headBefore = peaksBefore ? peaksBefore.slice(0, 8).reduce((a, b) => a + b, 0) : -1;
  const headAfter = peaksAfter ? peaksAfter.slice(0, 8).reduce((a, b) => a + b, 0) : -1;
  const patternChanged = peaksBefore && peaksAfter && Math.abs(headAfter - headBefore) > 0.1;
  ok(patternChanged, `after left-trim the waveform's amplitude profile changed (first-8 sum ${headBefore.toFixed(2)} -> ${headAfter.toFixed(2)})`);
  ok(rect2 && rect2.length > 5, "waveform still renders after the trim");

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SECTION8 CRASH:\n", e && e.stack ? e.stack : e); process.exit(2); });
