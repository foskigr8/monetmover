import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3090/index.html";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__state && document.querySelectorAll(".tl-row").length >= 3);

  // hover over several points in the source preview and confirm the cursor is never a text caret
  const cursorAt = (x, y) => page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? getComputedStyle(el).cursor : "none";
  }, [x, y]);
  const box = await page.locator("#source-monitor").boundingBox();
  const pts = [
    [box.x + box.width / 2, box.y + 60],           // over the source video
    [box.x + box.width / 2, box.y + box.height - 40], // over the segment bar
    [box.x + 20, box.y + box.height - 20],          // over the in/out area
  ];
  let anyText = false;
  for (const [x, y] of pts) {
    const c = await cursorAt(x, y);
    console.log(`   cursor at (${Math.round(x - box.x)},${Math.round(y - box.y)}): ${c}`);
    if (c === "text" || c === "i-beam") anyText = true;
  }
  ok(!anyText, "no text-insertion cursor anywhere over the source preview");

  ok(pageErrors.length === 0, "no page-level JS errors" + (pageErrors.length ? " -> " + pageErrors.join(" | ") : ""));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SECTION7 CRASH:", e && e.message ? e.message : e); process.exit(2); });
