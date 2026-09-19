import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3090/index.html";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeAudioVideo(page) {
  return page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const ctx = c.getContext("2d");
    const vstream = c.captureStream(30);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator(); osc.frequency.value = 440;
    const dest = ac.createMediaStreamDestination(); osc.connect(dest); osc.start();
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const ch = []; rec.ondataavailable = (e) => ch.push(e.data);
    const st = new Promise((r) => { rec.onstop = r; }); rec.start();
    let t = 0;
    await new Promise((res) => { const d = () => { t += 1 / 30; ctx.fillStyle = `hsl(${t * 40 % 360},70%,50%)`; ctx.fillRect(0, 0, 320, 180); if (t < 3.0) requestAnimationFrame(d); else res(); }; requestAnimationFrame(d); });
    await new Promise((r) => setTimeout(r, 120));
    rec.stop(); await st;
    try { osc.stop(); } catch (e) {} ac.close();
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}

const drag = async (page, sel, dx, dy) => {
  const b = await page.locator(sel).boundingBox();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 6 });
  await page.mouse.up();
};

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);
  ok(true, "app booted");

  // ---------- RESIZABLE PANELS ----------
  console.log("== resizable panels ==");
  const tlH0 = await page.evaluate(() => parseInt(getComputedStyle(document.getElementById("app")).getPropertyValue("--tl-h")) || 360);
  await drag(page, '.split[data-resize="timeline"]', 0, -80); // drag up => taller timeline
  const tlH1 = await page.evaluate(() => parseInt(getComputedStyle(document.getElementById("app")).getPropertyValue("--tl-h")));
  ok(tlH1 > tlH0, `timeline grew on vertical drag (${tlH0}px -> ${tlH1}px)`);

  const binW0 = await page.evaluate(() => parseInt(getComputedStyle(document.querySelector(".middle")).getPropertyValue("--bin-w")) || 300);
  await drag(page, '.split[data-resize="bin"]', 70, 0); // drag right => wider bin
  const binW1 = await page.evaluate(() => parseInt(getComputedStyle(document.querySelector(".middle")).getPropertyValue("--bin-w")));
  ok(binW1 > binW0, `bin widened on horizontal drag (${binW0}px -> ${binW1}px)`);

  const inspW0 = await page.evaluate(() => parseInt(getComputedStyle(document.querySelector(".middle")).getPropertyValue("--insp-w")) || 280);
  await drag(page, '.split[data-resize="inspector"]', -60, 0); // drag left => wider inspector
  const inspW1 = await page.evaluate(() => parseInt(getComputedStyle(document.querySelector(".middle")).getPropertyValue("--insp-w")));
  ok(inspW1 > inspW0, `inspector widened on horizontal drag (${inspW0}px -> ${inspW1}px)`);

  const progW0 = await page.evaluate(() => { const n = parseInt(getComputedStyle(document.querySelector(".monitors")).getPropertyValue("--prog-w")); return Number.isFinite(n) ? n : 56; });
  await drag(page, '.split-mon[data-resize="monitor"]', 80, 0); // drag right => program wider
  const progW1 = await page.evaluate(() => { const n = parseInt(getComputedStyle(document.querySelector(".monitors")).getPropertyValue("--prog-w")); return Number.isFinite(n) ? n : 56; });
  ok(progW1 > progW0, `program/source split resized on drag (${progW0}% -> ${progW1}%)`);

  // ---------- SOURCE SEGMENT SELECTION ----------
  console.log("== source segment selection ==");
  ok((await page.locator("#src-seg").count()) === 1, "segment bar present");

  const av = await makeAudioVideo(page);
  await page.setInputFiles("#file-input", [{ name: "seg.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1500);
  await page.locator(".bin-item").first().click();
  await sleep(200);
  const dur = await page.evaluate(() => { const m = [...window.__state.media.values()][0]; return m && m.duration ? m.duration : 3; });
  const inT = dur * 0.2, outT = dur * 0.6;

  // seek to inT, set In; seek to outT, set Out (both within the real duration)
  await page.evaluate((t) => window.__player._seekSource(t), inT);
  await page.click("#src-set-in");
  await sleep(150);
  await page.evaluate((t) => window.__player._seekSource(t), outT);
  await page.click("#src-set-out");
  await sleep(150);
  const seg = await page.evaluate(() => {
    const region = document.getElementById("seg-region");
    return { in: window.__state.src.in, out: window.__state.src.out, regionW: parseFloat(getComputedStyle(region).width) };
  });
  ok(Math.abs(seg.in - inT) < 0.1, `In point set at ~${inT.toFixed(2)}s (got ${seg.in.toFixed(2)})`);
  ok(Math.abs(seg.out - outT) < 0.1, `Out point set at ~${outT.toFixed(2)}s (got ${seg.out.toFixed(2)})`);
  ok(seg.regionW > 40, `segment region highlights the selection (width ${seg.regionW.toFixed(0)}px)`);
  const label = await page.locator("#seg-label").textContent();
  const selLen = outT - inT;
  ok(new RegExp(`${selLen.toFixed(1)}s selected`, "i").test(label), `selection length shown ("${label.trim()}", expected ~${selLen.toFixed(1)}s)`);

  // dragging the Out handle to the right extends the selection
  const outBefore = await page.evaluate(() => window.__state.src.out);
  const ob = await page.locator("#seg-out").boundingBox();
  await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await page.mouse.down();
  await page.mouse.move(ob.x + ob.width / 2 + 30, ob.y + ob.height / 2, { steps: 5 });
  await page.mouse.up();
  await sleep(150);
  const outAfter = await page.evaluate(() => window.__state.src.out);
  ok(outAfter > outBefore + 0.05, `dragging the Out handle extends the selection (${outBefore.toFixed(2)} -> ${outAfter.toFixed(2)})`);

  // insert the SELECTED segment at the playhead -> clip = [in .. out]
  await page.evaluate(() => { window.__state.playhead = 0; });
  await page.click("#src-insert");
  await sleep(250);
  const clip = await page.evaluate(() => {
    const tr = window.__state.tracks.find((t) => t.clips.length);
    const c = tr ? tr.clips[0] : null;
    return c ? { dur: c.duration, offset: c.offset } : null;
  });
  ok(!!clip, "clip inserted from source selection");
  ok(clip && Math.abs(clip.offset - inT) < 0.1, `clip uses the In point as its offset (expected ~${inT.toFixed(2)}, got ${clip ? clip.offset.toFixed(2) : "?"})`);
  const expectLen = outAfter - inT;
  ok(clip && Math.abs(clip.dur - expectLen) < 0.2, `clip duration = selected segment length (expected ~${expectLen.toFixed(2)}s, got ${clip ? clip.dur.toFixed(2) : "?"})`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FEATURES CRASH:", e && e.message ? e.message : e); process.exit(2); });
