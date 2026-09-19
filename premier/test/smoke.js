import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

const BASE = "http://127.0.0.1:3090/index.html";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(e.message));

  console.log("== load ==");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".tl-row");
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);
  ok(true, "app booted, timeline rendered");
  ok((await page.locator(".tl-row").count()) >= 3, ">=3 track rows");
  ok((await page.locator(".ruler .tick.major").count()) > 0, "ruler has major ticks");
  ok((await page.locator(".playhead").count()) === 1, "playhead present");

  console.log("== generate + import media ==");
  const vidDataUrl = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const ctx = c.getContext("2d");
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    let t = 0;
    await new Promise((res) => {
      const draw = () => {
        t += 1 / 30;
        ctx.fillStyle = `hsl(${(t * 70) % 360},70%,50%)`; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = "#fff"; ctx.font = "44px sans-serif"; ctx.fillText(Math.floor(t) + "s", 110, 105);
        if (t < 1.6) requestAnimationFrame(draw); else res();
      };
      requestAnimationFrame(draw);
    });
    await new Promise((r) => setTimeout(r, 120));
    rec.stop(); await stopped;
    const blob = new Blob(chunks, { type: "video/webm" });
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  });
  const pngDataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 64; c.height = 36;
    const x = c.getContext("2d"); x.fillStyle = "#1f8a4c"; x.fillRect(0, 0, 64, 36);
    return new Promise((r) => c.toBlob((b) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }));
  });
  const wavDataUrl = await page.evaluate(() => {
    const sr = 22050, dur = 2, n = sr * dur;
    const d = new Int16Array(n); for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 12000;
    const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, n * 2, true);
    new Int16Array(buf, 44).set(d);
    const blob = new Blob([buf], { type: "audio/wav" });
    return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  });

  await page.setInputFiles("#file-input", [
    { name: "footage.webm", mimeType: "video/webm", buffer: Buffer.from(vidDataUrl.split(",")[1], "base64") },
    { name: "green.png", mimeType: "image/png", buffer: Buffer.from(pngDataUrl.split(",")[1], "base64") },
    { name: "tone.wav", mimeType: "audio/wav", buffer: Buffer.from(wavDataUrl.split(",")[1], "base64") },
  ]);
  await sleep(1800);
  const binCount = await page.locator(".bin-item").count();
  ok(binCount === 3, "bin has 3 imported items (got " + binCount + ")");

  console.log("== build timeline ==");
  await page.locator(".bin-item", { hasText: "footage" }).first().click();
  await sleep(250);
  await page.click("#bin-insert");
  await sleep(300);
  let clips = await page.locator(".tl-canvas .clip").count();
  ok(clips >= 1, "video clip on timeline (got " + clips + ")");

  await page.locator(".bin-item", { hasText: "green" }).first().click();
  await sleep(200);
  await page.click("#bin-append");
  await sleep(300);
  clips = await page.locator(".tl-canvas .clip").count();
  ok(clips >= 2, "image clip appended (total " + clips + ")");

  await page.locator(".bin-item", { hasText: "tone" }).first().click();
  await sleep(200);
  await page.click("#bin-insert");
  await sleep(300);
  clips = await page.locator(".tl-canvas .clip").count();
  ok(clips >= 3, "audio clip on A1 (total " + clips + ")");

  console.log("== program preview shows a frame ==");
  await sleep(500);
  let px = await page.evaluate(() => { const c = document.getElementById("program-canvas"); const d = c.getContext("2d").getImageData(160, 120, 1, 1).data; return [d[0], d[1], d[2]]; });
  ok(!(px[0] < 8 && px[1] < 8 && px[2] < 8), "program canvas non-black at t=0 (rgb " + px + ")");

  console.log("== playback ==");
  await page.click("#tp-play");
  await sleep(700);
  const tcDuring = await page.locator("#prog-tc").textContent();
  const pxPlay = await page.evaluate(() => { const c = document.getElementById("program-canvas"); const d = c.getContext("2d").getImageData(160, 120, 1, 1).data; return [d[0], d[1], d[2]]; });
  await page.click("#tp-play");
  ok(tcDuring !== "00:00:00.000", "timecode advanced during play (" + tcDuring + ")");
  ok(!(pxPlay[0] < 8 && pxPlay[1] < 8 && pxPlay[2] < 8), "program canvas non-black during play (rgb " + pxPlay + ")");

  console.log("== scrub via ruler ==");
  const box = await page.locator(".ruler").boundingBox();
  await page.mouse.click(box.x + 60, box.y + 13);
  await sleep(200);
  const phLeft = await page.evaluate(() => document.querySelector(".playhead").style.left);
  ok(parseFloat(phLeft) > 40, "playhead moved on ruler scrub (left " + phLeft + ")");

  console.log("== split at playhead ==");
  const before = await page.locator(".tl-canvas .clip").count();
  await page.keyboard.press("s");
  await sleep(300);
  const after = await page.locator(".tl-canvas .clip").count();
  // "S" splits every clip the playhead crosses (video on V1 + audio on A1 here -> +2)
  ok(after > before, "razor split added clips at playhead (" + before + " -> " + after + ")");

  console.log("== inspector reflects selection ==");
  const hasSliders = await page.locator("#insp-body input[type=range]").count();
  ok(hasSliders >= 1, "inspector shows effect sliders (" + hasSliders + ")");

  console.log("== export ==");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 25000 }),
    page.click("#btn-export"),
  ]);
  const fname = download.suggestedFilename();
  const dest = path.join(os.tmpdir(), "moneymover-smoke-" + fname);
  await download.saveAs(dest);
  const sz = fs.statSync(dest).size;
  ok(/\.(webm|mp4)$/.test(fname), "export produced a video file: " + fname);
  ok(sz > 5000, "export file has meaningful size (" + (sz / 1024).toFixed(1) + " KB)");

  console.log("\n== console / page errors ==");
  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));
  console.log("  console errors captured:", consoleErrors.length ? consoleErrors.slice(0, 10).join(" | ") : "(none)");

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SMOKE CRASH:", e && e.message ? e.message : e); process.exit(2); });
