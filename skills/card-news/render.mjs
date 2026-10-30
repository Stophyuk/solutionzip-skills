#!/usr/bin/env node
// Render every card in a deck HTML to its own PNG, then check what breaks on a phone.
//
//   node render.mjs deck.html [outDir]        (outDir defaults to ./out next to the deck)
//
// A card is any element with data-card="<file name>". Its CSS width × height is the image size
// (1080×1350 for a 4:5 feed card, 1080×1080 square, 1080×1920 story).
//
// Checks per card (written to <outDir>/report.json; exit 1 when any card fails):
//   fit       — [data-fit] headings shrink in 2px steps until every line fits its box (not below 60%)
//   overflow  — fail: text still wider than its box, or the card content taller than the card
//   unsafe    — fail: text outside the safe area (4:5 keeps 60px at the sides and 70px top and bottom
//               so the profile grid's 3:4 crop does not cut it; 9:16 keeps 250px top and 340px bottom)
//   small     — warn: text smaller than 28px (hard to read on a phone at 1080 wide)
//   long      — warn: more than 90 characters on one card (one card, one message)
//   image     — fail: an <img> that did not load
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function launch() {
  // `npm i playwright` (or playwright-core) once. Uses your installed Chrome when it can,
  // otherwise the bundled Chromium (`npx playwright install chromium`).
  let pw;
  try {
    pw = await import("playwright");
  } catch {
    try {
      pw = await import("playwright-core");
    } catch {
      console.error("Playwright가 없습니다 — `npm i playwright` 한 번 실행하세요.");
      process.exit(1);
    }
  }
  const chromium = pw.chromium ?? pw.default.chromium;
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

// Runs inside the page, once per card.
function measure(name) {
  const card = document.querySelector(`[data-card="${name}"]`);
  const r = card.getBoundingClientRect();
  const W = Math.round(r.width);
  const H = Math.round(r.height);
  const ratio = Math.abs(W / H - 9 / 16) < 0.01 ? "9:16" : Math.abs(W / H - 4 / 5) < 0.01 ? "4:5" : "other";
  const safe = ratio === "9:16" ? [60, 250, 60, 340] : ratio === "4:5" ? [60, 70, 60, 70] : [60, 60, 60, 60]; // left, top, right, bottom
  const out = { name, W, H, ratio, fitted: [], fail: [], warn: [] };

  // 1) fit headings line by line
  for (const el of card.querySelectorAll("[data-fit]")) {
    const start = parseFloat(getComputedStyle(el).fontSize);
    const min = Math.round(start * 0.6);
    const lines = el.querySelectorAll(".ln").length ? [...el.querySelectorAll(".ln")] : [el];
    let size = start;
    while (size > min && lines.some((l) => l.scrollWidth > el.clientWidth + 1)) {
      size -= 2;
      el.style.fontSize = `${size}px`;
    }
    if (size !== start) out.fitted.push(`${el.textContent.trim().slice(0, 20)} ${start}→${size}px`);
    if (lines.some((l) => l.scrollWidth > el.clientWidth + 1)) out.fail.push(`overflow: '${el.textContent.trim().slice(0, 24)}' 한 줄이 칸보다 넓음`);
  }
  // 2) content taller than the card
  if (card.scrollHeight > card.clientHeight + 1) out.fail.push(`overflow: 내용이 카드보다 ${card.scrollHeight - card.clientHeight}px 김`);

  // 3) every text box inside the safe area; small text; character count
  let chars = 0;
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode;
    const text = t.textContent.trim();
    if (!text) continue;
    const el = t.parentElement;
    if (el.closest("[data-ignore]")) continue;
    chars += [...text.replace(/\s+/g, "")].length;
    if (seen.has(el)) continue;
    seen.add(el);
    const range = document.createRange();
    range.selectNodeContents(t);
    for (const b of range.getClientRects()) {
      const x0 = b.left - r.left, y0 = b.top - r.top, x1 = b.right - r.left, y1 = b.bottom - r.top;
      if (x0 < safe[0] - 1 || y0 < safe[1] - 1 || x1 > W - safe[2] + 1 || y1 > H - safe[3] + 1) {
        out.fail.push(`unsafe: '${text.slice(0, 20)}' 안전 영역 밖`);
        break;
      }
    }
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 28) out.warn.push(`small: '${text.slice(0, 20)}' ${size}px`);
  }
  if (chars > 90) out.warn.push(`long: 글자 ${chars}자 — 한 장에 한 메시지인지 보기`);

  // 4) images
  for (const img of card.querySelectorAll("img")) if (!img.complete || img.naturalWidth === 0) out.fail.push(`image: ${img.getAttribute("src")} 못 불러옴`);
  return out;
}

const deck = process.argv[2];
if (!deck) {
  console.error("쓰는 법: node render.mjs deck.html [outDir]");
  process.exit(1);
}
const deckPath = path.resolve(deck);
const outDir = path.resolve(process.argv[3] ?? path.join(path.dirname(deckPath), "out"));
fs.mkdirSync(outDir, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(deckPath).href, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);

const names = await page.$$eval("[data-card]", (els) => els.map((e) => e.dataset.card));
if (!names.length) {
  console.error('data-card="이름"이 붙은 카드가 없습니다.');
  process.exit(1);
}
const report = [];
for (const name of names) {
  const m = await page.evaluate(measure, name);
  await page.locator(`[data-card="${name}"]`).screenshot({ path: path.join(outDir, `${name}.png`) });
  report.push(m);
  const tag = m.fail.length ? "실패" : m.warn.length ? "경고" : "통과";
  console.log(`${tag}  ${name}.png  ${m.W}×${m.H}${m.fitted.length ? `  (줄 맞춤 ${m.fitted.length})` : ""}`);
  for (const f of m.fail) console.log(`      ✗ ${f}`);
  for (const w of m.warn) console.log(`      ! ${w}`);
}
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
await browser.close();
const failed = report.filter((m) => m.fail.length).length;
console.log(failed ? `\n실패 ${failed}장 — 고친 뒤 다시 찍으세요.` : `\n${report.length}장 모두 통과 → ${outDir}`);
process.exit(failed ? 1 : 0);
