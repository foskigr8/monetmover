import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeAV(page) {
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
  return el ? { paused: el.paused, ct: el.currentTime, vol: el.volume, muted: el.muted } : null;
});
const rms = (page) => page.evaluate(() => {
  const a = window.__audio;
  if (!a || !a.ctx || !a.master) return 0;
  if (!a._ta) { a._ta = a.ctx.createAnalyser(); a._ta.fftSize = 1024; a.master.connect(a._ta); a._b = new Float32Array(a._ta.fftSize); }
  a._ta.getFloatTimeDomainData(a._b);
  let s = 0; for (let i = 0; i < a._b.length; i++) s += a._b[i] * a._b[i];
  return Math.sqrt(s / a._b.length);
});
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);
  const av = await makeAV(page);
  await page.setInputFiles("#file-input", [{ name: "av.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1600);
  await page.locator(".bin-item").first().click(); await sleep(200);
  await page.evaluate(() => { window.__state.playhead = 0; });
  await page.click("#bin-insert"); await sleep(300);

  await page.click("#tp-play");
  await sleep(400);
  console.log("playing: el=", JSON.stringify(await elState(page)), "rms=", (await rms(page)).toFixed(3), "playing=", await page.evaluate(() => window.__player.playing));
  await page.click("#tp-play"); // pause
  for (const d of [80, 250, 500, 900]) {
    await sleep(d);
    console.log(`after pause +${d}ms: el=`, JSON.stringify(await elState(page)), "rms=", (await rms(page)).toFixed(3), "playing=", await page.evaluate(() => window.__player.playing));
  }
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("CRASH:", e.message); process.exit(2); });
