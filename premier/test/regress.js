import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";

const BASE = "http://127.0.0.1:3090/index.html";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Generate a short WebM that has BOTH a video track (canvas) and an audio track (tone).
async function makeAudioVideo(page) {
  return page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const ctx = c.getContext("2d");
    const vstream = c.captureStream(30);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator(); osc.frequency.value = 440;
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const ch = []; rec.ondataavailable = (e) => ch.push(e.data);
    const st = new Promise((r) => { rec.onstop = r; });
    rec.start();
    let t = 0;
    await new Promise((res) => { const d = () => { t += 1 / 30; ctx.fillStyle = `hsl(${t * 70 % 360},70%,50%)`; ctx.fillRect(0, 0, 320, 180); if (t < 3.0) requestAnimationFrame(d); else res(); }; requestAnimationFrame(d); });
    await new Promise((r) => setTimeout(r, 120));
    rec.stop(); await st;
    try { osc.stop(); } catch (e) {} ac.close();
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);
  ok(true, "app booted");

  // import a video that actually carries an audio track
  const av = await makeAudioVideo(page);
  await page.setInputFiles("#file-input", [{ name: "avaudio.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1500);
  ok((await page.locator(".bin-item").count()) === 1, "imported audio+video item");

  // add it to the timeline
  await page.locator(".bin-item").first().click();
  await sleep(200);
  await page.click("#bin-insert");
  await sleep(300);
  const clips0 = await page.locator(".tl-canvas .clip").count();
  ok(clips0 === 1, "clip on timeline");

  // ---- AUDIO FIX: force the context suspended, then clicking Play must run it
  await page.evaluate(() => { if (window.__audio.ctx) window.__audio.ctx.suspend(); });
  const ctxBefore = await page.evaluate(() => window.__audio.ctx ? window.__audio.ctx.state : "none");
  await page.click("#tp-play");
  await sleep(500);
  const ctxAfter = await page.evaluate(() => window.__audio.ctx ? window.__audio.ctx.state : "none");
  ok(ctxBefore === "suspended", `context started suspended (got ${ctxBefore})`);
  ok(ctxAfter === "running", `AudioContext resumes on Play (before=${ctxBefore}, after=${ctxAfter})`);

  // ---- SMOOTH PLAYBACK: the video element should be playing natively and advancing
  const sample = () => page.evaluate(() => {
    const el = [...window.__player.clipEls.values()].find((e) => e && e.tagName === "VIDEO");
    return el ? { paused: el.paused, ct: el.currentTime } : null;
  });
  const s1 = await sample();
  await sleep(400);
  const s2 = await sample();
  await sleep(400);
  const s3 = await sample();
  ok(!!s1 && s1.paused === false, "video element is playing (not frozen)");
  const a1 = s2 ? s2.ct - s1.ct : 0;
  const a2 = s3 ? s3.ct - s2.ct : 0;
  ok(a1 > 0.05 && a2 > 0.05, `video advancing steadily (Δ=${a1.toFixed(2)}s, ${a2.toFixed(2)}s)`);
  ok(s3.ct >= s2.ct && s2.ct >= s1.ct, "monotonic (no backward re-seek glitches)");
  await page.click("#tp-play"); // pause

  // ---- COPY / CUT / PASTE
  // 1 clip selected. Ctrl+C copy (no change), Ctrl+V paste (+1), Ctrl+X cut selected (-1), Ctrl+V paste (+1)
  const c0 = await page.locator(".tl-canvas .clip").count();
  await page.keyboard.press("Control+c"); await sleep(150);
  const cCopy = await page.locator(".tl-canvas .clip").count();
  await page.keyboard.press("Control+v"); await sleep(200);
  const cPaste = await page.locator(".tl-canvas .clip").count();
  await page.keyboard.press("Control+x"); await sleep(200);
  const cCut = await page.locator(".tl-canvas .clip").count();
  await page.keyboard.press("Control+v"); await sleep(200);
  const cPaste2 = await page.locator(".tl-canvas .clip").count();
  ok(cCopy === c0, `Ctrl+C copies without removing (${c0} -> ${cCopy})`);
  ok(cPaste === c0 + 1, `Ctrl+V pastes a new clip (${cCopy} -> ${cPaste})`);
  ok(cCut === c0, `Ctrl+X cuts the selected clip (${cPaste} -> ${cCut})`);
  ok(cPaste2 === c0 + 1, `Ctrl+V pastes again (${cCut} -> ${cPaste2})`);

  // pasted clip duration matches the original media
  const dur = await page.evaluate(() => {
    const t = window.__state.tracks.find((x) => x.clips.length);
    return t ? t.clips[0].duration : -1;
  });
  ok(dur > 0.5, `pasted clip has a real duration (${dur.toFixed(2)}s)`);

  // ---- Ctrl+K split at playhead
  const ruler = await page.locator(".ruler").boundingBox();
  await page.mouse.click(ruler.x + 40, ruler.y + 13); // ~0.66s
  await sleep(150);
  const beforeSplit = await page.locator(".tl-canvas .clip").count();
  await page.keyboard.press("Control+k");
  await sleep(250);
  const afterSplit = await page.locator(".tl-canvas .clip").count();
  ok(afterSplit >= beforeSplit + 1, `Ctrl+K splits at playhead (${beforeSplit} -> ${afterSplit})`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("REGRESS CRASH:", e && e.message ? e.message : e); process.exit(2); });
