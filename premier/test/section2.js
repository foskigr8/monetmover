import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeVideo(page) {
  // deliberately LANDSCAPE 16:9 so we can prove the frame is independent of the media
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
const compState = (page) => page.evaluate(() => ({ w: window.__state.comp.width, h: window.__state.comp.height, fps: window.__state.comp.fps, fit: window.__state.fitMode }));
const canvasWH = (page) => page.evaluate(() => { const c = document.getElementById("program-canvas"); return { w: c.width, h: c.height }; });
const mediaWH = (page) => page.evaluate(() => { const m = [...window.__state.media.values()][0]; return { w: m.width, h: m.height, type: m.type }; });
const displayWH = (page) => page.evaluate(() => { const b = document.getElementById("program-canvas").getBoundingClientRect(); return { w: b.width, h: b.height }; });

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
  await page.click("#bin-insert"); await sleep(250); // on timeline so the program shows it

  console.log("== composition is independent of the imported media ==");
  const m0 = await mediaWH(page);
  ok(m0.w === 320 && m0.h === 180, `imported media is 16:9 landscape (got ${m0.w}x${m0.h})`);
  const c0 = await canvasWH(page);
  ok(c0.w === 1280 && c0.h === 720, `default comp frame is 1280x720 (got ${c0.w}x${c0.h})`);

  console.log("== switch the comp to vertical 9:16 via the UI ==");
  await page.click("#btn-comp"); await sleep(120);
  await page.selectOption("#comp-preset", "1080x1920"); await sleep(250);
  await page.click("body"); await sleep(120); // close popover
  const c1 = await compState(page);
  ok(c1.w === 1080 && c1.h === 1920, `comp switched to 1080x1920 (got ${c1.w}x${c1.h})`);
  const c1cv = await canvasWH(page);
  ok(c1cv.w === 1080 && c1cv.h === 1920, `program canvas backing store is now the vertical frame (got ${c1cv.w}x${c1cv.h})`);

  const m1 = await mediaWH(page);
  ok(m1.w === 320 && m1.h === 180, `imported media is UNCHANGED after comp change (still ${m1.w}x${m1.h})`);

  console.log("== the on-screen frame shape changes (window != comp dims, but tracks it) ==");
  const d1 = await displayWH(page);
  ok(d1.h > d1.w, `preview frame is now portrait (displayed ${Math.round(d1.w)}x${Math.round(d1.h)})`);

  console.log("== fit mode: 16:9 footage letterboxed inside the 9:16 frame ==");
  await page.evaluate(() => { window.__state.playhead = 0.4; window.__player.redraw = true; });
  await sleep(400);
  const sample = (x, y) => page.evaluate(([x, y]) => { const d = document.getElementById("program-canvas").getContext("2d").getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; }, [x, y]);
  const center = await sample(540, 960);   // middle of frame -> footage
  const top = await sample(540, 120);      // near top edge -> letterbox (black)
  const isColor = (p) => p[0] + p[1] + p[2] > 60;
  ok(isColor(center), `center shows footage (rgb ${center})`);
  ok(!isColor(top), `top edge is letterbox black (rgb ${top})`);

  console.log("== fit=fill crops instead ==");
  await page.click("#btn-comp"); await sleep(100);
  await page.selectOption("#comp-fit", "fill"); await sleep(300);
  const topFill = await sample(540, 120);
  ok(isColor(topFill), `with Fill, top edge now shows cropped footage, not black (rgb ${topFill})`);

  console.log("== comp settings persist in the saved document ==");
  const json = await page.evaluate(() => window.__doc.documentToJson());
  const doc = JSON.parse(json);
  ok(doc.meta.comp.width === 1080 && doc.meta.comp.height === 1920, `document carries the comp (got ${doc.meta.comp.width}x${doc.meta.comp.height})`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SECTION2 CRASH:", e && e.message ? e.message : e); process.exit(2); });
