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
const tool = (page) => page.evaluate(() => window.__state.tool);
const selCount = (page) => page.evaluate(() => window.__state.selection.length);
const clipCount = (page) => page.locator(".tl-canvas .clip").count();
const selCls = (page) => page.locator(".tl-canvas .clip.sel").count();

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
  // three clips on V1 at 2s, 5s, 8s
  for (const p of [2, 5, 8]) { await page.evaluate((t) => { window.__state.playhead = t; }, p); await page.click("#bin-insert"); await sleep(150); }
  ok((await clipCount(page)) === 3, `set up 3 clips (got ${await clipCount(page)})`);

  console.log("== tool switching: razor auto-returns, A forces select ==");
  ok(await tool(page) === "select", `default tool is select (got ${await tool(page)})`);
  await page.keyboard.press("c"); await sleep(120);
  ok(await tool(page) === "razor", `C activates razor (got ${await tool(page)})`);
  // put playhead inside the first clip (2s..3.4s) and click it -> should cut AND return to select
  await page.evaluate(() => { window.__state.playhead = 2.6; });
  const before = await clipCount(page);
  const firstClip = page.locator(".tl-canvas .clip").first();
  await firstClip.click();
  await sleep(250);
  ok((await clipCount(page)) === before + 1, `razor cut split a clip (${before} -> ${await clipCount(page)})`);
  ok(await tool(page) === "select", `after a cut, tool auto-returned to select (got ${await tool(page)})`);
  // now clicking another clip should SELECT (not cut)
  const afterCut = await clipCount(page);
  await page.locator(".tl-canvas .clip").nth(3).click();
  await sleep(200);
  ok((await clipCount(page)) === afterCut, `next click selects, does not cut (${afterCut} clips, no change)`);

  await page.keyboard.press("a"); await sleep(120);
  ok(await tool(page) === "select", `A forces select (got ${await tool(page)})`);

  console.log("== marquee selection (drag a box over empty timeline space) ==");
  const canvas = await page.locator(".tl-canvas").boundingBox();
  // box around the actual clips (data-driven, so it works on whichever track they landed on)
  const firstBox = await page.locator(".tl-canvas .clip").first().boundingBox();
  const lastBox = await page.locator(".tl-canvas .clip").last().boundingBox();
  const yMid = firstBox.y + firstBox.height / 2;
  const x0 = firstBox.x - 50;                 // start before the first clip (empty space)
  const x1 = lastBox.x + lastBox.width + 50;  // extend past the last clip
  await page.mouse.move(x0, yMid);
  await page.mouse.down();
  await page.mouse.move(x1, yMid, { steps: 8 });
  await page.mouse.up();
  await sleep(200);
  const clipTotal = await clipCount(page);
  ok((await selCount(page)) >= 3, `marquee selected the clips in the box (selected ${await selCount(page)} of ${clipTotal})`);
  ok((await selCls(page)) >= 3, `marquee clips are visually highlighted (${await selCls(page)} .sel)`);

  console.log("== Ctrl+A selects all in the timeline context ==");
  await page.keyboard.press("Control+a");
  await sleep(150);
  const total = await clipCount(page);
  ok((await selCount(page)) === total, `Ctrl+A selected all clips (${await selCount(page)}/${total})`);

  console.log("== empty-area click clears selection ==");
  // click empty space on the clip track, well past the last clip
  const lastBox2 = await page.locator(".tl-canvas .clip").last().boundingBox();
  const yClip = lastBox2.y + lastBox2.height / 2;
  await page.mouse.click(lastBox2.x + lastBox2.width + 120, yClip);
  await sleep(150);
  ok((await selCount(page)) === 0, `clicking empty timeline space clears selection (selected ${await selCount(page)})`);

  console.log("== letter keys are ignored while typing in a text field ==");
  await page.keyboard.press("c"); await sleep(100); // set razor
  await page.locator("#seq-name").click();
  await page.locator("#seq-name").fill("Test");
  await page.keyboard.type("ca");
  await sleep(120);
  const val = await page.locator("#seq-name").inputValue();
  ok(val === "Testca", `typing 'ca' in the field typed normally (value "${val}")`);
  ok(await tool(page) === "razor", `tool did NOT change while typing (still ${await tool(page)})`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SECTION1 CRASH:", e && e.message ? e.message : e); process.exit(2); });
