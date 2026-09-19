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
const trans = (page) => page.evaluate(() => {
  const t = window.__state.tracks.find((x) => x.clips.length);
  const c = t && t.clips[0];
  return c ? c.transform : null;
});
const selCount = (page) => page.evaluate(() => window.__state.selection.length);
const selClass = (page) => page.locator(".tl-canvas .clip.sel").count();

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
  await page.evaluate(() => { window.__state.playhead = 0.5; });
  await page.click("#bin-insert"); await sleep(250);

  // ---------- Part A: continuous Program|Source split ----------
  console.log("== Program|Source split is free / continuous (1:1 with pointer) ==");
  const progW0 = await page.evaluate(() => document.getElementById("program-monitor").getBoundingClientRect().width);
  const split = await page.locator('.split-mon[data-resize="monitor"]').boundingBox();
  await page.mouse.move(split.x + split.width / 2, split.y + 100);
  await page.mouse.down();
  await page.mouse.move(split.x + split.width / 2 + 73, split.y + 100, { steps: 6 });
  await page.mouse.up();
  await sleep(120);
  const progW1 = await page.evaluate(() => document.getElementById("program-monitor").getBoundingClientRect().width);
  const d = progW1 - progW0;
  ok(d > 60 && d < 90, `dragging the split by 73px changed program width ~1:1 (Δ=${Math.round(d)}px)`);

  // ---------- Part B: direct canvas manipulation ----------
  console.log("== canvas: select by clicking the preview ==");
  // clear any selection first, so this proves the CANVAS click does the selecting
  await page.evaluate(() => { window.__state.selection = []; window.__state.selectedClipId = null; });
  const rect = await page.locator("#program-canvas").boundingBox();
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  await page.mouse.click(cx, cy); // center of the full-frame clip
  await sleep(200);
  ok((await selCount(page)) === 1, `clicking the preview selected the clip (selected ${await selCount(page)})`);
  ok((await selClass(page)) === 1, `selection is shared: timeline clip highlighted too (${await selClass(page)} .sel)`);

  console.log("== canvas: drag a RESIZE handle (bottom-right, while full-frame) ==");
  const tR0 = await trans(page);
  // SE corner = frame bottom-right (object is full-frame), computed precisely in-page:
  const se = await page.evaluate(() => {
    const c = window.__state.tracks.find((x) => x.clips.length).clips[0];
    const comp = window.__state.comp, t = c.transform;
    const r = document.getElementById("program-canvas").getBoundingClientRect();
    const s = r.width / comp.width;
    const cx = (comp.width / 2 + t.x + t.w / 2) * s;
    const cy = (comp.height / 2 + t.y + t.h / 2) * s;
    return { x: r.x + cx, y: r.y + cy };
  });
  // aim a few px INSIDE the SE corner (the handle is grabbable within ~10px of it)
  await page.mouse.move(se.x - 4, se.y - 4);
  await page.mouse.down();
  await page.mouse.move(se.x - 4 - 30, se.y - 4 - 20, { steps: 5 }); // shrink
  await page.mouse.up();
  await sleep(150);
  const tR1 = await trans(page);
  ok(tR1.w < tR0.w && tR1.h < tR0.h, `dragging the SE handle resized the object (w ${Math.round(tR0.w)}→${Math.round(tR1.w)}, h ${Math.round(tR0.h)}→${Math.round(tR1.h)})`);

  console.log("== canvas: drag to MOVE (continuous, tracks pointer) ==");
  const tBefore = await trans(page);
  // re-center: the object was resized; drag from its current center
  const cRect = await page.evaluate(() => {
    const c = window.__state.tracks.find((x) => x.clips.length).clips[0];
    const comp = window.__state.comp, t = c.transform;
    const r = document.getElementById("program-canvas").getBoundingClientRect();
    const s = r.width / comp.width;
    return { x: r.x + (comp.width / 2 + t.x) * s, y: r.y + (comp.height / 2 + t.y) * s };
  });
  await page.mouse.move(cRect.x, cRect.y);
  await page.mouse.down();
  // sample mid-drag to confirm it's live + continuous
  await page.mouse.move(cRect.x + 13, cRect.y + 7, { steps: 4 });
  const tMid = await trans(page);
  await page.mouse.move(cRect.x + 40, cRect.y + 25, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  const tAfter = await trans(page);
  const scale = await page.evaluate(() => window.__state.comp.width / document.getElementById("program-canvas").getBoundingClientRect().width);
  const dxExp = 40 * scale, dyExp = 25 * scale;
  const dxGot = tAfter.x - tBefore.x, dyGot = tAfter.y - tBefore.y;
  ok(Math.abs(dxGot - dxExp) < 6 && Math.abs(dyGot - dyExp) < 6, `drag moved the object to match the pointer (Δx=${dxGot.toFixed(1)}≈${dxExp.toFixed(1)}, Δy=${dyGot.toFixed(1)}≈${dyExp.toFixed(1)})`);
  // continuous check: mid-drag value is a non-round, proportional position (not grid-snapped)
  ok(Math.abs(tMid.x - tBefore.x) > 1 && Math.abs(tMid.x - tBefore.x) < Math.abs(dxGot) * 0.95, `movement is continuous (mid-drag Δx=${(tMid.x - tBefore.x).toFixed(2)}, not a stepped value)`);

  console.log("== undo reverts the canvas transform ==");
  await page.keyboard.press("Control+z"); await sleep(150); // undo resize
  const tU1 = await trans(page);
  await page.keyboard.press("Control+z"); await sleep(150); // undo move
  const tU2 = await trans(page);
  ok(Math.abs(tU2.x) < 0.5 && Math.abs(tU2.y) < 0.5, `undo reverted position to origin (x=${tU2.x.toFixed(2)}, y=${tU2.y.toFixed(2)})`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SECTION4 CRASH:", e && e.message ? e.message : e); process.exit(2); });
