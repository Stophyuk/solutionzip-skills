#!/usr/bin/env node
// Capture the public screens of an app for an intro deck: one PC screen and one phone screen per page,
// and (optionally) a smooth scroll recording of each page.
//
//   node capture.mjs https://example.com                  just the first page
//   node capture.mjs https://example.com / /pricing       these paths
//   node capture.mjs https://example.com / --record 10    + a 10-second scroll recording per page and width
//
// Options: --out <dir> (default ./shots) · --only pc|phone · --hide ".cookie-bar,.chat" (left out of the shots)
//          --full (also the whole page as one tall image) · --record <sec> · --screens <n> (how far the recording
//          scrolls, in screens; default 3) · --fps <n> (default 30)
//
// Output in <out>/: <slug>-pc.png (1440×900 @2x) · <slug>-phone.png (390×844 @2x) · <slug>-pc-full.png (--full)
//                   <slug>-pc.mp4 · <slug>-phone.mp4 (--record; H.264, needs ffmpeg on PATH)
//
// The recording is not real time: the page is scrolled one frame at a time and shot, so it stays smooth on a slow
// computer. Public screens only — this script never logs in, types or submits anything.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Playwright next to this script, or in the folder you run it from (`npm i playwright` there once).
async function need(name) {
  try {
    return await import(name);
  } catch {}
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    return await import(pathToFileURL(req.resolve(name)).href);
  } catch {
    return null;
  }
}
async function launch() {
  const pw = (await need("playwright")) ?? (await need("playwright-core"));
  if (!pw) {
    console.error("Playwright가 없습니다 — 작업 폴더에서 `npm i playwright` 한 번 실행하세요.");
    process.exit(1);
  }
  const chromium = pw.chromium ?? pw.default.chromium;
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const OUT = path.resolve(opt("out", "shots"));
const ONLY = opt("only", null);
const hide = opt("hide", "").split(",").map((s) => s.trim()).filter(Boolean);
const RECORD = Number(opt("record", 0));
const SCREENS = Number(opt("screens", 3));
const FPS = Number(opt("fps", 30));
const FULL = flag("full");
const base = (argv.find((a) => /^https?:\/\//.test(a)) || "").replace(/\/$/, "");
if (!base) {
  console.error("주소가 필요합니다 — node capture.mjs https://example.com [/경로 …] [--record 10]");
  process.exit(1);
}
const origin = new URL(base).origin;
const paths = argv.filter((a) => a.startsWith("/"));
if (!paths.length) paths.push(new URL(base).pathname || "/");

const VPS = {
  pc: { width: 1440, height: 900, dsf: 2, mobile: false },
  phone: { width: 390, height: 844, dsf: 2, mobile: true },
};
const slugOf = (p) => (p === "/" ? "home" : p.replace(/^\/|\/$/g, "").replace(/[^\w가-힣-]+/g, "-").slice(0, 60) || "page");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, key, url) {
  const vp = VPS[key];
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dsf,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    locale: "ko-KR",
    // still pictures and frame-by-frame scrolling: entrance animations would be caught half way
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  const res = await p.goto(url, { waitUntil: "load", timeout: 60000 });
  if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
  if (hide.length) await p.addStyleTag({ content: `${hide.join(",")} { display: none !important; }` });
  // smooth-scroll CSS would animate every scrollTo — the recording sets the position itself
  await p.addStyleTag({ content: "html, body { scroll-behavior: auto !important; }" });
  await p.evaluate(() => document.fonts.ready);
  // walk down once so lazy images load, then back to the top
  await p.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    scrollTo(0, 0);
  });
  await wait(800);
  return { ctx, p };
}

async function record(p, key, file) {
  const vp = VPS[key];
  const H = await p.evaluate(() => document.documentElement.scrollHeight);
  const maxY = Math.max(0, Math.min(H - vp.height, vp.height * (SCREENS - 1)));
  const frames = Math.round(RECORD * FPS);
  const hold = Math.min(1, RECORD / 6); // still at the top and at the bottom, in seconds
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const enc = spawn(
    process.env.FFMPEG || "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", file,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let err = "";
  enc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
  const done = new Promise((ok, bad) => enc.on("close", (c) => (c === 0 ? ok() : bad(new Error(`ffmpeg ${c}: ${err}`)))));
  enc.on("error", () => {});
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    const x = Math.min(1, Math.max(0, (t - hold) / Math.max(0.1, RECORD - 2 * hold)));
    await p.evaluate((y) => scrollTo(0, y), Math.round(maxY * ease(x)));
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // PC frames at 1x (1440×900) — a video frame is 1920 wide at most; the phone keeps 2x (780×1688)
    const buf = await p.screenshot({ type: "jpeg", quality: 90, scale: key === "phone" ? "device" : "css" });
    if (!enc.stdin.write(buf)) await new Promise((ok) => enc.stdin.once("drain", ok));
  }
  enc.stdin.end();
  await done;
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
let failed = 0;
for (const pth of paths) {
  for (const key of ["pc", "phone"]) {
    if (ONLY && ONLY !== key) continue;
    const slug = slugOf(pth);
    try {
      const { ctx, p } = await open(browser, key, origin + pth);
      const shot = path.join(OUT, `${slug}-${key}.png`);
      await p.screenshot({ path: shot });
      const made = [path.basename(shot)];
      if (FULL) {
        const h = await p.evaluate(() => document.documentElement.scrollHeight);
        const f = path.join(OUT, `${slug}-${key}-full.png`);
        // very tall pages make images no slide can use — stop at 8 screens
        await p.screenshot({ path: f, fullPage: true, clip: { x: 0, y: 0, width: VPS[key].width, height: Math.min(h, VPS[key].height * 8) } });
        made.push(path.basename(f));
      }
      if (RECORD > 0) {
        const f = path.join(OUT, `${slug}-${key}.mp4`);
        await p.evaluate(() => scrollTo(0, 0));
        await record(p, key, f);
        made.push(path.basename(f));
      }
      console.log(`${pth} ${key} → ${made.join(" · ")}`);
      await ctx.close();
    } catch (e) {
      failed++;
      console.log(`✗ ${pth} ${key} — ${e.message.split("\n")[0]}`);
    }
  }
}
await browser.close();
console.log(failed ? `\n실패 ${failed} — 주소를 확인하세요.` : `\n끝 → ${OUT}\n캡처에 다른 사람의 이름 · 메일 · 주문 내역이 보이면 가리거나 시험용 계정 화면으로 바꾸세요.`);
process.exit(failed ? 1 : 0);
