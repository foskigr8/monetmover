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
const trackCount = (page) => page.evaluate(() => window.__state.tracks.length);
const clipCount = (page) => page.evaluate(() => window.__state.tracks.reduce((n, t) => n + t.clips.length, 0));
const clipsPerTrack = (page) => page.evaluate(() => window.__state.tracks.map((t) => t.clips.length));
const trackOfClip = (page, id) => page.evaluate((id) => {
  for (const t of window.__state.tracks) if (t.clips.some((c) => c.id === id)) return t.id;
  return null;
}, id);

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
  // two clips on the SAME track at 0s and 3s
  for (const p of [0, 3]) { await page.evaluate((t) => { window.__state.playhead = t; }, p); await page.click("#bin-insert"); await sleep(150); }
  const before = { tracks: await trackCount(page), clips: await clipCount(page) };
  ok(before.clips === 2, `set up 2 clips on one track (got ${before.clips})`);
  const perBefore = await clipsPerTrack(page);
  const filledTrackBefore = perBefore.indexOf(Math.max(...perBefore));

  // get the second clip's id and its on-screen box
  const secondId = await page.evaluate(() => {
    const t = window.__state.tracks.find((x) => x.clips.length === 2) || window.__state.tracks[1];
    return t.clips[1].id;
  });
  const clipBox = await page.evaluate((id) => {
    for (const t of window.__state.tracks) if (t.clips.some((c) => c.id === id)) {
      // find its DOM via data-clip-id
      const el = document.querySelector(`.clip[data-clip-id="${id}"]`);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return null;
  }, secondId);
  const pps = await page.evaluate(() => window.__state.pps);

  console.log("== drag the 2nd clip to FULLY overlap the 1st (same track) ==");
  // target: left edge to 0s -> x offset = (0 - clipStart) * pps. The clip starts at 3s, so drag left by 3*pps.
  const dx = -3 * pps;
  await page.mouse.move(clipBox.x + clipBox.w / 2, clipBox.y + clipBox.h / 2);
  await page.mouse.down();
  await page.mouse.move(clipBox.x + clipBox.w / 2 + dx, clipBox.y + clipBox.h / 2, { steps: 10 });
  await page.mouse.up();
  await sleep(300);

  const after = { tracks: await trackCount(page), clips: await clipCount(page) };
  ok(after.clips === before.clips, `NEITHER clip destroyed: still ${before.clips} clips (got ${after.clips})`);
  const perAfter = await clipsPerTrack(page);
  const tracksWithClips = perAfter.filter((n) => n > 0);
  const movedToOtherTrack = !(perAfter[filledTrackBefore] >= 2); // filled track no longer has both
  ok(movedToOtherTrack, `dragged clip moved off the occupied track (per-track now [${perAfter.join(",")}])`);
  const newTrackId = await trackOfClip(page, secondId);
  ok(!!newTrackId && newTrackId !== undefined, `dragged clip now sits on a distinct track`);
  // nothing on the same track overlaps
  const overlap = await page.evaluate((id) => {
    for (const t of window.__state.tracks) {
      const c = t.clips.find((x) => x.id === id);
      if (!c) continue;
      return t.clips.some((o) => o.id !== id && o.start < c.start + c.duration && o.start + o.duration > c.start);
    }
    return false;
  }, secondId);
  ok(!overlap, "no overlap remains on the dragged clip's track");

  console.log("== single undo reverts position AND any created track together ==");
  await page.keyboard.press("Control+z");
  await sleep(250);
  const afterUndo = { tracks: await trackCount(page), clips: await clipCount(page) };
  const perUndo = await clipsPerTrack(page);
  ok(afterUndo.clips === before.clips, `undo: clip count back to ${before.clips} (got ${afterUndo.clips})`);
  ok(afterUndo.tracks === before.tracks, `undo: track count back to ${before.tracks} (got ${afterUndo.tracks})`);
  ok(perUndo[filledTrackBefore] === 2, `undo: both clips back on the original track (per-track [${perUndo.join(",")}])`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SECTION3 CRASH:", e && e.message ? e.message : e); process.exit(2); });
