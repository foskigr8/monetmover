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
    await new Promise((res) => { const f = () => { t += 1 / 30; x.fillStyle = `hsl(${t * 40 % 360},70%,50%)`; x.fillRect(0, 0, 320, 180); if (t < 2.2) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    await new Promise((r) => setTimeout(r, 120)); rec.stop(); await st;
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}
const srcT = (page) => page.evaluate(() => window.__state.src.t);
const srcPlaying = (page) => page.evaluate(() => window.__state.src.playing);

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

  // set in/out as fractions of the ACTUAL media duration (recorded length varies)
  const dur = await page.evaluate(() => { const m = [...window.__state.media.values()][0]; return m.duration || 1; });
  const inT = dur * 0.2, outT = dur * 0.6;
  await page.evaluate((t) => { window.__player._seekSource(t); }, inT);
  await page.click("#src-set-in"); await sleep(120);
  await page.evaluate((t) => { window.__player._seekSource(t); }, outT);
  await page.click("#src-set-out"); await sleep(120);
  const io = await page.evaluate(() => ({ in: window.__state.src.in, out: window.__state.src.out }));
  ok(Math.abs(io.in - inT) < 0.08 && Math.abs(io.out - outT) < 0.08, `In/Out set (in=${io.in.toFixed(2)}≈${inT.toFixed(2)}, out=${io.out.toFixed(2)}≈${outT.toFixed(2)})`);

  console.log("== source LOOP ON: playback bounces only within the In/Out range ==");
  await page.click("#src-loop"); await sleep(100);
  ok(await page.evaluate(() => window.__state.src.loop) === true, "loop toggle is on");
  // start at in point
  await page.evaluate((t) => { window.__player._seekSource(t); }, inT);
  await page.click("#src-play"); await sleep(150);
  const samples = [];
  for (let i = 0; i < 16; i++) { samples.push(await srcT(page)); await sleep(140); }
  const inB = inT - 0.06, outB = outT + 0.06;
  const allInRange = samples.every((t) => t >= inB && t <= outB);
  const sawHigh = samples.some((t) => t > (inT + outT) / 2 + 0.05);
  const sawLowAfter = samples.some((t, i) => t < (inT + outT) / 2 - 0.05 && samples.slice(0, i).some((p) => p > (inT + outT) / 2 + 0.05));
  console.log("   samples:", samples.map((t) => t.toFixed(2)).join(", "));
  ok(allInRange, `every sample stays within the In/Out range [${inB.toFixed(2)},${outB.toFixed(2)}]`);
  ok(sawHigh && sawLowAfter, `playback bounces: reached near out then wrapped back to in (loop)`);
  await page.click("#src-play"); await sleep(120); // pause

  console.log("== source LOOP OFF: plays to the end and stops ==");
  await page.evaluate(() => { window.__state.src.loop = false; document.getElementById("src-loop").checked = false; });
  await page.evaluate(() => { window.__player._seekSource(0); window.__state.src.t = 0; });
  await page.click("#src-play"); await sleep(150);
  // let it run to the end (~2.2s)
  let stopped = false, lastT = 0;
  for (let i = 0; i < 22; i++) { lastT = await srcT(page); if (!(await srcPlaying(page))) { stopped = true; break; } await sleep(150); }
  ok(stopped, `source stopped on its own at the end (lastT=${lastT.toFixed(2)})`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SECTION6 CRASH:", e && e.message ? e.message : e); process.exit(2); });
