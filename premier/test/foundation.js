import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeVideo(page) {
  return page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const x = c.getContext("2d");
    const s = c.captureStream(30);
    const rec = new MediaRecorder(s, { mimeType: "video/webm" });
    const ch = []; rec.ondataavailable = (e) => ch.push(e.data);
    const st = new Promise((r) => (rec.onstop = r)); rec.start();
    let t = 0;
    await new Promise((res) => { const f = () => { t += 1 / 30; x.fillStyle = `hsl(${t * 40 % 360},70%,50%)`; x.fillRect(0, 0, 320, 180); if (t < 2.0) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    await new Promise((r) => setTimeout(r, 120)); rec.stop(); await st;
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}
const count = (page) => page.locator(".tl-canvas .clip").count();

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);

  const av = await makeVideo(page);
  await page.setInputFiles("#file-input", [{ name: "v.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1500);
  await page.locator(".bin-item").first().click();
  await sleep(200);

  // build a 2-clip timeline
  await page.click("#bin-insert"); await sleep(200);
  await page.evaluate(() => { window.__state.playhead = 3; });
  await page.click("#bin-insert"); await sleep(200);
  const n2 = await count(page);
  ok(n2 === 2, `two clips on timeline (got ${n2})`);

  console.log("== UNDO / REDO (semantic, via Ctrl/⌘) ==");
  await page.keyboard.press("Control+z"); await sleep(200);   // undo insert B
  const n1 = await count(page);
  ok(n1 === 1, `undo -> 1 clip (got ${n1})`);
  await page.keyboard.press("Control+z"); await sleep(200);   // undo insert A
  const n0 = await count(page);
  ok(n0 === 0, `undo -> 0 clips (got ${n0})`);
  await page.keyboard.press("Control+Shift+z"); await sleep(200); // redo A
  const n1b = await count(page);
  ok(n1b === 1, `redo -> 1 clip (got ${n1b})`);
  await page.keyboard.press("Control+Shift+z"); await sleep(200); // redo B
  const n2b = await count(page);
  ok(n2b === 2, `redo -> 2 clips (got ${n2b})`);

  // undo a delete (select the 2nd clip, Delete, undo)
  await page.evaluate(() => { const tr = window.__state.tracks.find(t => t.clips.length); window.__state.selectedClipId = tr.clips[1].id; });
  await page.keyboard.press("Delete"); await sleep(200);
  const nDel = await count(page);
  ok(nDel === 1, `delete removes a clip (got ${nDel})`);
  await page.keyboard.press("Control+z"); await sleep(200);
  const nDelU = await count(page);
  ok(nDelU === 2, `undo delete restores the clip (got ${nDelU})`);

  console.log("== DOCUMENT (versioned project) ==");
  const json = await page.evaluate(() => window.__doc.documentToJson());
  const doc = JSON.parse(json);
  ok(doc.version === 1, `document has version 1 (got ${doc.version})`);
  ok(Array.isArray(doc.tracks) && doc.tracks.length === 3, `document has 3 default tracks (got ${doc.tracks.length})`);
  const clipCount = doc.tracks.reduce((n, t) => n + (t.clips ? t.clips.length : 0), 0);
  ok(clipCount === 2, `document has 2 clips (got ${clipCount})`);
  ok(doc.assets && doc.assets.length === 1, `document lists 1 asset (got ${doc.assets ? doc.assets.length : 0})`);
  ok(doc.meta && doc.meta.comp && doc.meta.comp.fps === 30, `document has composition timebase (fps=${doc.meta?.comp?.fps})`);

  // mutate live state, then restore the document -> structure should revert
  await page.evaluate(() => {
    const tr = window.__state.tracks.find(t => t.clips.length);
    tr.clips[0].duration = 99; tr.clips[0].start = 55;
  });
  const reverted = await page.evaluate((s) => {
    window.__doc.restoreDocument(JSON.parse(s));
    const tr = window.__state.tracks.find(t => t.clips.length);
    const c = tr.clips[0];
    return { duration: c.duration, start: c.start, clips: window.__state.tracks.reduce((n, t) => n + t.clips.length, 0) };
  }, json);
  ok(reverted.clips === 2, `restore preserves clip count (got ${reverted.clips})`);
  ok(reverted.start === 0 && reverted.duration < 90, `restore reverts edits (start=${reverted.start}, dur=${reverted.duration})`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FOUNDATION CRASH:", e && e.message ? e.message : e); process.exit(2); });
