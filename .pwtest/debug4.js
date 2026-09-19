import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
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
  page.on("console", (m) => console.log("  [page]", m.text()));
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);
  const av = await makeVideo(page);
  await page.setInputFiles("#file-input", [{ name: "v.webm", mimeType: "video/webm", buffer: Buffer.from(av.split(",")[1], "base64") }]);
  await sleep(1500);
  await page.locator(".bin-item").first().click(); await sleep(200);
  await page.evaluate(() => { window.__state.playhead = 0.5; });
  await page.click("#bin-insert"); await sleep(250);

  const info = await page.evaluate(() => {
    const c = window.__state.tracks.find((x) => x.clips.length).clips[0];
    const r = document.getElementById("program-canvas").getBoundingClientRect();
    return { trans: c.transform, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, focus: window.__state.focus, sel: window.__state.selection };
  });
  console.log("before drag:", JSON.stringify(info.trans), "focus=", info.focus, "sel=", JSON.stringify(info.sel));
  console.log("canvas rect:", JSON.stringify(info.rect));

  // install a probe to log whether pointerdown/pointermove fire on the canvas
  await page.evaluate(() => {
    const cv = document.getElementById("program-canvas");
    cv.addEventListener("pointerdown", () => console.log("PROBE pointerdown"), { once: false });
    window.addEventListener("pointermove", () => console.log("PROBE window pointermove"));
  });

  const cx = info.rect.x + info.rect.w / 2, cy = info.rect.y + info.rect.h / 2;
  const top = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? (el.tagName + "." + (el.className || "") + "#" + el.id) : "none"; }, [cx, cy]);
  console.log("elementFromPoint(center):", top);
  const cvTop = await page.evaluate(() => { const cv = document.getElementById("program-canvas"); const s = getComputedStyle(cv); return { pe: s.pointerEvents, pos: s.position, z: s.zIndex }; });
  console.log("canvas computed:", JSON.stringify(cvTop));
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await sleep(80);
  await page.mouse.move(cx + 50, cy + 30, { steps: 5 });
  await sleep(120);
  const mid = await page.evaluate(() => window.__state.tracks.find((x) => x.clips.length).clips[0].transform);
  console.log("mid-drag transform:", JSON.stringify(mid), "focus=", await page.evaluate(() => window.__state.focus));
  await page.mouse.up();
  await sleep(150);
  const after = await page.evaluate(() => window.__state.tracks.find((x) => x.clips.length).clips[0].transform);
  console.log("after up transform:", JSON.stringify(after));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("CRASH:", e.message); process.exit(2); });
