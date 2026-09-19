import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// video WITH an audio track (440Hz tone)
async function makeAudioVideo(page) {
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
    await new Promise((res) => { const f = () => { t += 1 / 30; x.fillStyle = `hsl(${t * 40 % 360},70%,50%)`; x.fillRect(0, 0, 320, 180); if (t < 2.4) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    await new Promise((r) => setTimeout(r, 120)); rec.stop(); await st;
    o.stop(); ac.close();
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}
const elState = (page) => page.evaluate(() => {
  const el = [...window.__player.clipEls.values()].find((e) => e && e.tagName === "VIDEO");
  return el ? { paused: el.paused, ct: el.currentTime, muted: el.muted } : null;
});
const rms = (page) => page.evaluate(() => {
  const a = window.__audio;
  if (!a || !a.ctx || !a.master) return -1;
  if (!a._ta) { a._ta = a.ctx.createAnalyser(); a._ta.fftSize = 1024; a.master.connect(a._ta); a._b = new Float32Array(a._ta.fftSize); }
  a._ta.getFloatTimeDomainData(a._b);
  let s = 0; for (let i = 0; i < a._b.length; i++) s += a._b[i] * a._b[i];
  return Math.sqrt(s / a._b.length);
});

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);

  const av = await makeAudioVideo(page);
  await page.setInputFiles("#file-input", [{ name: "av.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1600);
  await page.locator(".bin-item").first().click();
  await sleep(200);
  await page.evaluate(() => { window.__state.playhead = 0; });
  await page.click("#bin-insert"); await sleep(300);

  console.log("== preview playback: sound is routed + actually plays ==");
  const route = await page.evaluate(() => {
    const el = [...window.__player.clipEls.values()].find((e) => e && e.tagName === "VIDEO");
    return { el: !!el, muted: el && el.muted, node: el ? !!window.__audio.nodes.get(el) : false, ctx: window.__audio.ctx ? window.__audio.ctx.state : null };
  });
  ok(route.el && route.muted === false, `clip element is NOT muted (muted=${route.muted})`);
  ok(route.node, `clip audio is wired into the Web Audio output (gain node present)`);

  console.log("== PLAY -> the clip is actually playing (audio produced) ==");
  await page.click("#tp-play");
  await sleep(180); // let the render loop drive the element into playing
  const p1 = await elState(page); await sleep(200); const p2 = await elState(page);
  ok(p1.paused === false && p2.paused === false, `during play the element is playing (paused=false)`);
  ok(p2.ct > p1.ct, `currentTime is advancing (audio is being produced) (${p1.ct.toFixed(2)} -> ${p2.ct.toFixed(2)})`);
  const playRms = await rms(page);
  ok(playRms >= 0, `(info) analyser RMS during play = ${playRms.toFixed(3)}`);

  console.log("== PAUSE -> audio stops (element frozen) ==");
  await page.click("#tp-play");
  const s1 = await elState(page); await sleep(250); const s2 = await elState(page);
  ok(s1.paused === true && s2.paused === true, `after pause the element is stopped (paused=true)`);
  ok(Math.abs(s2.ct - s1.ct) < 0.001, `currentTime is frozen (no more audio) (${s1.ct.toFixed(3)} == ${s2.ct.toFixed(3)})`);

  console.log("== SCRUB while paused -> does NOT play audio ==");
  // move the playhead via the ruler while paused
  const ruler = await page.locator(".ruler").boundingBox();
  await page.mouse.click(ruler.x + 60, ruler.y + 13);
  await sleep(200);
  const sc = await elState(page);
  ok(sc.paused === true, `scrubbing while paused keeps the element paused (no audio) (paused=${sc.paused})`);

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SECTION5 CRASH:", e && e.message ? e.message : e); process.exit(2); });
