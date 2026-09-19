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
    await new Promise((res) => { const f = () => { t += 1 / 30; x.fillStyle = `hsl(${t * 40 % 360},70%,50%)`; x.fillRect(0, 0, 320, 180); if (t < 2.2) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    await new Promise((r) => setTimeout(r, 120)); rec.stop(); await st;
    o.stop(); ac.close();
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(ch, { type: "video/webm" })); });
  });
}
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);
  const av = await makeAV(page);
  await page.setInputFiles("#file-input", [{ name: "av.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1600);
  const dur = await page.evaluate(() => { const m = [...window.__state.media.values()][0]; return m.duration || 1; });
  console.log("media duration:", dur);
  await page.locator(".bin-item").first().click(); await sleep(150);
  const off = dur * 0.5;
  await page.evaluate(({ o, d }) => { window.__player._seekSource(o); window.__state.src.in = o; window.__state.src.out = o + Math.min(0.6, d - o); }, { o: off, d: dur });
  const io = await page.evaluate(() => ({ in: window.__state.src.in, out: window.__state.src.out, mediaId: window.__state.src.mediaId }));
  console.log("src in/out:", JSON.stringify(io));
  await page.click("#src-insert"); await sleep(300);
  const tracks = await page.evaluate(() => window.__state.tracks.map((t) => ({ name: t.name, clips: t.clips.map((c) => ({ id: c.id, offset: +c.offset.toFixed(2), dur: +c.duration.toFixed(2) })) })));
  console.log("tracks:", JSON.stringify(tracks, null, 1));
  const peak0 = await page.evaluate(() => window.__rangePeaks(0, 0.5) ? window.__rangePeaks(0, 0.5).length : "null");
  console.log("__rangePeaks(0,0.5) len:", peak0);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("CRASH:", e.message); process.exit(2); });
