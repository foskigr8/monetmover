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
  await page.locator(".bin-item").first().click(); await sleep(200);
  for (const p of [0, 5]) { await page.evaluate((t) => { window.__state.playhead = t; }, p); await page.click("#bin-insert"); await sleep(150); }

  const trackCount0 = await page.evaluate(() => window.__state.tracks.length);
  const per0 = await page.evaluate(() => window.__state.tracks.map((t) => t.clips.length));

  // move the clip at 5s to a FREE gap at 2s (clip A is 0..1.4s, so 2s is free on the same track)
  const id = await page.evaluate(() => (window.__state.tracks.find((t) => t.clips.length) || window.__state.tracks[1]).clips[1].id);
  const box = await page.evaluate((id) => { const el = document.querySelector(`.clip[data-clip-id="${id}"]`); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, id);
  const pps = await page.evaluate(() => window.__state.pps);
  const dx = (2 - 5) * pps; // move left by 3s
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w / 2 + dx, box.y + box.h / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(300);

  const trackCount1 = await page.evaluate(() => window.__state.tracks.length);
  const per1 = await page.evaluate(() => window.__state.tracks.map((t) => t.clips.length));
  ok(trackCount1 === trackCount0, `free move did NOT create a new track (${trackCount0} -> ${trackCount1})`);
  ok(per1.indexOf(Math.max(...per1)) === per0.indexOf(Math.max(...per0)) && Math.max(...per1) === 2, `both clips stayed on the same track (per-track [${per1.join(",")}])`);
  const startNow = await page.evaluate((id) => { for (const t of window.__state.tracks) { const c = t.clips.find((x) => x.id === id); if (c) return c.start; } return -1; }, id);
  ok(Math.abs(startNow - 2) < 0.3, `clip moved to the free spot ~2s (got ${startNow.toFixed(2)}s)`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH:", e && e.message ? e.message : e); process.exit(2); });
