import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeVideoTone(page) {
  return page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const x = c.getContext("2d");
    const vstream = c.captureStream(30);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(); o.frequency.value = 440;
    const dest = ac.createMediaStreamDestination(); o.connect(dest); o.start();
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const ch = []; rec.ondataavailable = (e) => ch.push(e.data);
    const st = new Promise((r) => (rec.onstop = r)); rec.start();
    let t = 0;
    await new Promise((res) => { const f = () => { t += 1 / 30; x.fillStyle = `hsl(${t * 40 % 360},70%,50%)`; x.fillRect(0, 0, 320, 180); if (t < 2.0) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    await new Promise((r) => setTimeout(r, 120)); rec.stop(); await st;
    o.stop(); ac.close();
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}
const firstVideoClip = (page) => page.evaluate(() => {
  for (const t of window.__state.tracks) if (t.kind === "video" && t.clips.length) return t.clips[0].id;
  return null;
});
const audioClips = (page) => page.evaluate(() => {
  const out = [];
  for (const t of window.__state.tracks) if (t.kind === "audio") for (const c of t.clips) out.push({ id: c.id, start: c.start, offset: c.offset, linkedId: c.linkedId, linkMode: c.linkMode });
  return out;
});

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);

  const av = await makeVideoTone(page);
  await page.setInputFiles("#file-input", [{ name: "v.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1600);
  await page.locator(".bin-item").first().click(); await sleep(150);
  await page.evaluate(() => { window.__player._seekSource(0); window.__state.src.in = 0; window.__state.src.out = 1.5; });
  await page.click("#bin-insert"); await sleep(250);
  const clipId = await firstVideoClip(page);
  ok(!!clipId, "video clip on the timeline");

  console.log("== direct volume fader on the clip ==");
  // wait for audio decode so the fader shows for a video-with-audio
  let faderBox = null;
  for (let i = 0; i < 40; i++) { faderBox = await page.locator(".clip .vol-track").first().boundingBox().catch(() => null); if (faderBox) break; await sleep(120); }
  ok(!!faderBox, `volume fader is present on the clip (video-with-audio)`);
  const volBefore = await page.evaluate((id) => { for (const t of window.__state.tracks) for (const c of t.clips) if (c.id === id) return c.volume; return null; }, clipId);
  // drag the fader right (increases volume)
  await page.mouse.move(faderBox.x + faderBox.width / 2, faderBox.y + faderBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(faderBox.x + faderBox.width / 2 + 60, faderBox.y + faderBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  const volAfter = await page.evaluate((id) => { for (const t of window.__state.tracks) for (const c of t.clips) if (c.id === id) return c.volume; return null; }, clipId);
  ok(volAfter > volBefore, `dragging the fader raised the volume (${volBefore.toFixed(2)} -> ${volAfter.toFixed(2)})`);
  // undo the fader (one step) restores the original
  await page.keyboard.press("Control+z"); await sleep(150);
  const volUndo = await page.evaluate((id) => { for (const t of window.__state.tracks) for (const c of t.clips) if (c.id === id) return c.volume; return null; }, clipId);
  ok(Math.abs(volUndo - volBefore) < 0.01, `undo restored the original volume (${volUndo.toFixed(2)} ≈ ${volBefore.toFixed(2)})`);

  console.log("== extract audio from the video ==");
  const clipEl = page.locator(`.tl-canvas .clip[data-clip-id="${clipId}"]`);
  await clipEl.click({ button: "right" }); await sleep(150);
  const extractItem = page.locator(".ctx-item", { hasText: "Extract audio" });
  ok((await extractItem.count()) > 0, "context menu offers 'Extract audio'");
  await extractItem.click(); await sleep(200);
  const after = await page.evaluate((id) => {
    let video = null; for (const t of window.__state.tracks) for (const c of t.clips) if (c.id === id) video = c;
    const aud = []; for (const t of window.__state.tracks) if (t.kind === "audio") for (const c of t.clips) aud.push({ id: c.id, linkedId: c.linkedId, linkMode: c.linkMode, start: c.start });
    return { video: video && { audioExtracted: video.audioExtracted, linkedId: video.linkedId, linkMode: video.linkMode }, aud };
  }, clipId);
  ok(after.video && after.video.audioExtracted === true, "video marked as audio-extracted");
  ok(after.aud.length >= 1 && after.aud[0].linkedId === clipId, `an audio clip was created and linked to the video (aud=${after.aud.length})`);
  ok(after.video && after.aud[0] && after.video.linkedId === after.aud[0].id, "link is bidirectional");

  console.log("== link/unlink A/V ==");
  const audId = after.aud[0].id;
  const audStart0 = after.aud[0].start;
  const vidStart0 = await page.evaluate((id) => { for (const t of window.__state.tracks) for (const c of t.clips) if (c.id === id) return c.start; return 0; }, clipId);
  const vidTrack = await page.evaluate((id) => { for (const t of window.__state.tracks) if (t.clips.some((c) => c.id === id)) return t.id; return null; }, clipId);

  // LINKED: moving the video should move its audio together
  await page.evaluate(({ vid, s, tr }) => window.__move(vid, s + 1.5, tr), { vid: clipId, s: vidStart0, tr: vidTrack });
  await sleep(150);
  const audStartLinked = (await audioClips(page)).find((a) => a.id === audId)?.start;
  ok(Math.abs(audStartLinked - (audStart0 + 1.5)) < 0.05, `while linked, moving the video moved its audio too (audio ${audStart0} -> ${audStartLinked})`);
  // move it back for a clean baseline
  await page.evaluate(({ vid, s, tr }) => window.__move(vid, s - 1.5, tr), { vid: clipId, s: vidStart0 + 1.5, tr: vidTrack });
  await sleep(120);

  // unlink
  await clipEl.click({ button: "right" }); await sleep(120);
  await page.locator(".ctx-item", { hasText: "Unlink audio/video" }).click(); await sleep(150);
  const unlinked = await page.evaluate((vid) => { let v = null; for (const t of window.__state.tracks) for (const c of t.clips) if (c.id === vid) v = c; return v && v.linkMode; }, clipId);
  ok(unlinked === "unlinked", `unlink set linkMode=unlinked (got ${unlinked})`);
  // move the video (same track); the unlinked audio should NOT follow
  await page.evaluate(({ vid, s, tr }) => window.__move(vid, s + 2, tr), { vid: clipId, s: audStart0 >= 0 ? vidStart0 : vidStart0, tr: vidTrack });
  await sleep(150);
  const audStartAfterMove = (await audioClips(page)).find((a) => a.id === audId)?.start;
  ok(audStartAfterMove === audStart0, `after unlink, moving the video does NOT move the audio (audio start ${audStartAfterMove} unchanged)`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SECTION9 CRASH:\n", e && e.stack ? e.stack : e); process.exit(2); });
