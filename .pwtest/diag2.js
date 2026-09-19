import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeAV(page) {
  return page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180; const x = c.getContext("2d");
    const vstream = c.captureStream(30);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(); o.frequency.value = 440; const g = ac.createGain(); g.gain.value = 0.6;
    const dest = ac.createMediaStreamDestination(); o.connect(g); g.connect(dest); o.start();
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" }); const ch = []; rec.ondataavailable = (e) => ch.push(e.data);
    const st = new Promise((r) => (rec.onstop = r)); rec.start(); let t = 0;
    await new Promise((res) => { const f = () => { t += 1 / 30; x.fillStyle = `hsl(${t * 50 % 360},70%,50%)`; x.fillRect(0, 0, 320, 180); if (t < 2.6) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    await new Promise((r) => setTimeout(r, 120)); rec.stop(); await st; o.stop(); ac.close();
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}
(async () => {
  const browser = await chromium.launch(); // realistic
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);
  const av = await makeAV(page);
  await page.setInputFiles("#file-input", [{ name: "av.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1500);
  await page.locator(".bin-item", { hasText: "av.webm" }).first().click(); await sleep(150);
  await page.evaluate(() => { const vid = [...window.__state.media.values()].find((x) => x.type === "video"); window.__player.loadSource(vid.id); window.__state.src.in = 0; window.__state.src.out = 2.4; });
  await sleep(100);
  await page.click("#bin-insert"); await sleep(250);
  // instrument: frame counter + duration
  await page.evaluate(() => {
    window.__frames = 0;
    const orig = window.__player._loop.bind(window.__player);
    window.__player._loop = (now) => { window.__frames++; return orig(now); };
  });
  const dur = await page.evaluate(() => window.__state.tracks.reduce((m, t) => Math.max(m, ...t.clips.map((c) => c.start + c.duration)), 0));
  console.log("sequence duration (longest track):", dur.toFixed(2), "s");
  console.log("frame counter BEFORE play:", await page.evaluate(() => window.__frames));
  await page.click("#tp-play");
  for (let i = 0; i < 6; i++) {
    await sleep(300);
    const s = await page.evaluate(() => ({
      t: +window.__state.playhead.toFixed(2), frames: window.__frames,
      playing: window.__state.playing, btn: document.getElementById("tp-play").textContent,
      el: (() => { const e = [...window.__player.clipEls.values()].find((x) => x && x.tagName === "VIDEO"); return e ? (e.paused ? "paused" : "playing") : "none"; })(),
    }));
    console.log(`t=${s.t}s frames=${s.frames} state.playing=${s.playing} btn=${s.btn} videoEl=${s.el}`);
  }
  await browser.close(); process.exit(0);
})().catch((e) => { console.error("CRASH", e.message); process.exit(2); });
