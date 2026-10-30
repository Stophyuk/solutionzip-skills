#!/usr/bin/env node
// Turn a 1080×1920 HTML timeline into a vertical MP4 (Shorts · Reels · TikTok), frame by frame.
//
//   node render.mjs short.html [out.mp4] [--audio voice.mp3] [--fps 30]
//
// The page is never played in real time. For every frame the renderer calls seek(t):
//   - window.seek(t) if the page defines one (full control), otherwise
//   - scenes: every [data-start][data-end] element gets data-on while start <= t < end
//   - CSS animations: all of them are paused and set to t (so animation-delay = seconds from the start)
// Same input, same video — every time.
//
// Length: <main data-duration="13"> or the largest data-end. Cover image: data-cover="1.0" (seconds).
// Output: out.mp4 (H.264 · yuv420p · BT.709 tagged · AAC · +faststart) and out.jpg (cover).
// Needs ffmpeg on PATH and Playwright (`npm i playwright`).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const audio = opt("--audio", null);
const FPS = Number(opt("--fps", "30"));
const [input, outArg] = args;
if (!input) {
  console.error("쓰는 법: node render.mjs short.html [out.mp4] [--audio voice.mp3] [--fps 30]");
  process.exit(1);
}
const htmlPath = path.resolve(input);
const out = path.resolve(outArg ?? htmlPath.replace(/\.html?$/i, "") + ".mp4");
fs.mkdirSync(path.dirname(out), { recursive: true });

async function launch() {
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

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

const info = await page.evaluate(() => {
  const main = document.querySelector("[data-duration]");
  const ends = [...document.querySelectorAll("[data-end]")].map((e) => Number(e.dataset.end));
  const T = main ? Number(main.dataset.duration) : Math.max(0, ...ends);
  const cover = Number(document.querySelector("[data-cover]")?.dataset.cover ?? 1);
  // Default seek: scenes by data-start/data-end, CSS animations by time.
  if (typeof window.seek !== "function") {
    window.seek = (t) => {
      for (const el of document.querySelectorAll("[data-start][data-end]")) {
        const on = t >= Number(el.dataset.start) && t < Number(el.dataset.end);
        el.toggleAttribute("data-on", on);
      }
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = t * 1000;
      }
    };
  }
  return { T, cover };
});
if (!(info.T > 0)) {
  console.error('길이를 모릅니다 — <main data-duration="초"> 또는 장면마다 data-end를 적으세요.');
  process.exit(1);
}

// Warn about text outside the safe area at the end of each scene (everything has arrived by then).
const unsafe = await page.evaluate(() => {
  const res = [];
  for (const sc of document.querySelectorAll("[data-start][data-end]")) {
    window.seek(Number(sc.dataset.end) - 0.05);
    const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      if (!text || walker.currentNode.parentElement.closest("[data-ignore]")) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const b of range.getClientRects()) {
        if (b.left < 79 || b.right > 961 || b.top < 259 || b.bottom > 1541) {
          res.push(`${sc.dataset.start}초 장면 '${text.slice(0, 24)}' — 안전 영역(x 80–960 · y 260–1540) 밖`);
          break;
        }
      }
    }
  }
  return res;
});
for (const u of unsafe) console.log(`! ${u}`);

async function frame(t, opts) {
  await page.evaluate((x) => window.seek(x), t);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.screenshot({ type: "jpeg", quality: 92, ...opts });
}

const started = Date.now();
const input2 = audio ? ["-i", path.resolve(audio)] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
const enc = spawn(
  "ffmpeg",
  [
    "-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    ...input2,
    "-map", "0:v", "-map", "1:a",
    // Browser JPEG frames are full-range BT.601 with an sRGB ICC profile. Convert to limited-range BT.709,
    // tag it, and drop the ICC so every app shows the same colors.
    "-vf", "scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709,sidedata=mode=delete:type=ICC_PROFILE",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", info.T.toFixed(3), out,
  ],
  { stdio: ["pipe", "ignore", "pipe"] },
);
let err = "";
enc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
const done = new Promise((ok, bad) => enc.on("close", (c) => (c === 0 ? ok() : bad(new Error(`ffmpeg ${c}: ${err}`)))));

const frames = Math.ceil(info.T * FPS);
for (let f = 0; f < frames; f++) {
  const buf = await frame(f / FPS);
  if (!enc.stdin.write(buf)) await new Promise((ok) => enc.stdin.once("drain", ok));
  if (f % FPS === 0) process.stdout.write(`\r${Math.round((f / frames) * 100)}%`);
}
enc.stdin.end();
await done;
const cover = out.replace(/\.mp4$/i, "") + ".jpg";
await frame(Math.min(info.cover, info.T - 1 / FPS), { path: cover });
await browser.close();
console.log(`\r${path.basename(out)} · ${info.T}초 · ${frames}프레임 · ${((Date.now() - started) / 1000).toFixed(0)}초 걸림\n표지 ${path.basename(cover)}`);
