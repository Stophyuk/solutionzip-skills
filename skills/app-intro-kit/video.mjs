#!/usr/bin/env node
// Turn the deck's slide pictures and a screen recording into a 30–60 second intro video with captions.
//
//   node video.mjs video.json [out.mp4] [--size 1920x1080|1080x1920] [--audio voice.m4a] [--fps 30]
//
// video.json (paths are relative to the json file):
//   {
//     "title": "앱 이름",                    shown on top in the vertical layout
//     "size": "1920x1080",                  or "1080x1920" (Shorts · Reels); --size wins
//     "accent": "#2F6BFF",                  progress bar and end card
//     "scenes": [
//       { "image": "out/slides/01.png", "sec": 4, "caption": "한 줄 자막" },
//       { "clip": "shots/home-pc.mp4", "from": 0, "sec": 10, "caption": ["자막 1", "자막 2"] },
//       { "card": "example.com", "sub": "한 줄", "sec": 3 }
//     ]
//   }
//   image — a slide (out/slides/NN.png from build.mjs) or any picture, shown whole with a slow push-in
//   clip  — a screen recording (capture.mjs --record, or your own .mp4/.mov); "from" = where to start, in seconds
//   card  — a plain end card: big text + one line
//   caption — one line, or several lines that split the scene time evenly. Every scene except a card gets one:
//             most people watch without sound
//
// Like html-shorts, nothing plays in real time: each frame is set with seek(t) and shot, so the same json makes the
// same video on any computer. Output: out.mp4 (H.264 · yuv420p · BT.709 · AAC · +faststart) and out.jpg (first frame).
// Needs ffmpeg on PATH and Playwright.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

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
const sizeArg = opt("--size", null);
const [jsonArg, outArg] = args;
if (!jsonArg) {
  console.error("쓰는 법: node video.mjs video.json [out.mp4] [--size 1920x1080|1080x1920] [--audio voice.m4a]");
  process.exit(1);
}
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const jsonPath = path.resolve(jsonArg);
const base = path.dirname(jsonPath);
const spec = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const [W, H] = String(sizeArg ?? spec.size ?? "1920x1080").split("x").map(Number);
const out = path.resolve(outArg ?? path.join(base, "out", `video-${W}x${H}.mp4`));
fs.mkdirSync(path.dirname(out), { recursive: true });
const land = W >= H;
const accent = spec.accent ?? "#2F6BFF";

// Layout. Landscape: the slide at 1600×900 with a caption band under it — captions never cover the slide.
// Portrait (Shorts · Reels): title on top, picture in the middle, caption below, all inside the safe area
// (x 80–960 · y 260–1540) that the platform's buttons and caption do not cover.
const L = land
  ? { media: { x: 160, y: 36, w: 1600, h: 900 }, cap: { x: 120, y: 950, w: 1680, h: 112, size: 46 } }
  : { head: { x: 80, y: 290, w: 880, h: 110, size: 64 }, media: { x: 60, y: 430, w: 960, h: 880 }, cap: { x: 80, y: 1340, w: 880, h: 200, size: 56 } };

// ── scenes ───────────────────────────────────────────────────────────────────
const fails = [];
const warns = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-intro-video-"));
let t0 = 0;
const scenes = [];
for (const [k, s] of (spec.scenes ?? []).entries()) {
  const sec = Number(s.sec);
  if (!(sec > 0)) {
    fails.push(`${k + 1}번 장면에 sec(초)가 없음`);
    continue;
  }
  const lines = s.caption == null ? [] : Array.isArray(s.caption) ? s.caption : [s.caption];
  const sc = { kind: s.clip ? "clip" : s.card ? "card" : "image", start: t0, end: t0 + sec, lines };
  if (sc.kind !== "card" && !lines.length) warns.push(`${k + 1}번 장면에 자막이 없음 — 소리 없이 보는 사람이 많다`);
  if (sc.kind === "image") {
    const f = path.resolve(base, s.image ?? "");
    if (!s.image || !fs.existsSync(f)) fails.push(`${k + 1}번 장면 그림 없음: ${s.image}`);
    sc.src = pathToFileURL(f).href;
  } else if (sc.kind === "clip") {
    const f = path.resolve(base, s.clip);
    if (!fs.existsSync(f)) {
      fails.push(`${k + 1}번 장면 영상 없음: ${s.clip}`);
    } else {
      const dir = path.join(tmp, `clip-${k}`);
      fs.mkdirSync(dir);
      const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-ss", String(s.from ?? 0), "-t", String(sec), "-i", f,
        "-vf", `fps=${FPS},scale=w=${L.media.w}:h=${L.media.h}:force_original_aspect_ratio=decrease`, "-q:v", "3", path.join(dir, "%05d.jpg")]);
      if (r.error) {
        console.error("ffmpeg가 없습니다 — 설치 뒤 다시(맥: brew install ffmpeg). 다른 곳에 있으면 FFMPEG=경로 로 알려 주세요.");
        process.exit(1);
      }
      sc.frames = fs.readdirSync(dir).filter((x) => x.endsWith(".jpg")).length;
      if (!sc.frames) fails.push(`${k + 1}번 장면 영상에서 프레임을 못 뽑음: ${s.clip} (${r.stderr.toString().slice(0, 120)})`);
      else if (sc.frames < sec * FPS - 2) warns.push(`${k + 1}번 장면 영상이 ${(sc.frames / FPS).toFixed(1)}초뿐 — 나머지는 마지막 화면에 멈춤`);
      sc.dir = pathToFileURL(dir).href;
    }
  } else {
    sc.card = String(s.card);
    sc.sub = s.sub ?? "";
  }
  scenes.push(sc);
  t0 += sec;
}
const T = t0;
if (!scenes.length) fails.push("장면이 없음 — video.json의 scenes를 채우세요");
if (T && (T < 30 || T > 60)) warns.push(`길이 ${T.toFixed(1)}초 — 30~60초를 권합니다`);
if (fails.length) {
  for (const f of fails) console.log(`✗ ${f}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

// ── the timeline page ────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fontDir = [path.join(base, "fonts"), path.join(base, "..", "fonts")].find((d) => fs.existsSync(path.join(d, "Pretendard-Bold.woff2")));
const fontCss = fontDir
  ? ["Regular:400", "Bold:700", "ExtraBold:800"]
      .map((x) => x.split(":"))
      .filter(([n]) => fs.existsSync(path.join(fontDir, `Pretendard-${n}.woff2`)))
      .map(([n, w]) => `@font-face{font-family:"Pretendard";font-weight:${w};src:url("${pathToFileURL(path.join(fontDir, `Pretendard-${n}.woff2`)).href}") format("woff2");}`)
      .join("\n")
  : "";
const box = (b) => `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
const page = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
${fontCss}
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#111214;color:#fff;font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;word-break:keep-all}
.scene{position:absolute;inset:0;visibility:hidden}
.media{position:absolute;${box(L.media)};display:flex;align-items:center;justify-content:center;overflow:hidden}
.media img{max-width:100%;max-height:100%;display:block;transform-origin:50% 50%}
.clip img{border-radius:${land ? 14 : 22}px}
.head{position:absolute;${L.head ? box(L.head) : "display:none"};display:${L.head ? "flex" : "none"};align-items:center;justify-content:center;font-size:${L.head?.size ?? 0}px;font-weight:800;letter-spacing:-0.02em}
.cap{position:absolute;${box(L.cap)};display:flex;align-items:center;justify-content:center;text-align:center;font-size:${L.cap.size}px;font-weight:700;line-height:1.3}
.cap span{display:inline-block;max-width:100%;text-wrap:balance}
.card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${land ? 24 : 36}px;text-align:center;padding:0 ${land ? 160 : 100}px}
.card b{font-size:${land ? 120 : 108}px;font-weight:800;letter-spacing:-0.03em;color:${accent}}
.card p{font-size:${land ? 48 : 56}px;font-weight:700;color:#E8E8EA;line-height:1.35}
.bar{position:absolute;left:0;top:0;width:100%;height:${land ? 6 : 10}px;background:${accent};transform-origin:0 0}
</style></head><body>
${scenes
  .map((s, k) =>
    s.kind === "card"
      ? `<div class="scene" id="s${k}"><div class="card"><b>${esc(s.card)}</b>${s.sub ? `<p>${esc(s.sub)}</p>` : ""}</div></div>`
      : `<div class="scene ${s.kind}" id="s${k}"><div class="media"><img alt=""${s.kind === "image" ? ` src="${s.src}"` : ""}></div></div>`,
  )
  .join("\n")}
<div class="head">${esc(spec.title ?? "")}</div>
<div class="cap"><span id="cap"></span></div>
<div class="bar"></div>
<script>
const S = ${JSON.stringify(scenes.map(({ kind, start, end, lines, frames, dir }) => ({ kind, start, end, lines, frames, dir })))};
const T = ${T}, FPS = ${FPS};
const cap = document.getElementById("cap"), bar = document.querySelector(".bar"), head = document.querySelector(".head");
window.seek = async (t) => {
  let cur = S.findIndex((s) => t >= s.start && t < s.end);
  if (cur < 0) cur = S.length - 1;
  const s = S[cur], local = t - s.start, dur = s.end - s.start;
  const fade = cur === 0 ? 1 : Math.min(1, local / 0.3); // the first scene is fully there at 0s (the preview frame)
  S.forEach((x, k) => {
    const el = document.getElementById("s" + k);
    const on = k === cur || (k === cur - 1 && fade < 1);
    el.style.visibility = on ? "visible" : "hidden";
    el.style.opacity = k === cur ? fade : 1;
    el.style.zIndex = k === cur ? 2 : 1;
  });
  const img = document.querySelector("#s" + cur + " img");
  if (s.kind === "image" && img) img.style.transform = "scale(" + (1 + 0.035 * local / dur) + ")";
  if (s.kind === "clip" && img) {
    const n = Math.max(1, Math.min(s.frames, Math.floor(local * FPS) + 1));
    const src = s.dir + "/" + String(n).padStart(5, "0") + ".jpg";
    if (img.getAttribute("src") !== src) { img.src = src; await img.decode().catch(() => {}); }
  }
  // the previous scene may still be fading out underneath — make sure its picture is there too
  if (fade < 1 && cur > 0) {
    const p = S[cur - 1], pi = document.querySelector("#s" + (cur - 1) + " img");
    if (p.kind === "clip" && pi && !pi.getAttribute("src")) { pi.src = p.dir + "/" + String(p.frames).padStart(5, "0") + ".jpg"; await pi.decode().catch(() => {}); }
  }
  const line = s.lines.length ? s.lines[Math.min(s.lines.length - 1, Math.floor(local / (dur / s.lines.length)))] : "";
  cap.textContent = s.kind === "card" ? "" : line;
  head.style.visibility = s.kind === "card" ? "hidden" : "visible";
  bar.style.transform = "scaleX(" + Math.min(1, t / T) + ")";
};
</script></body></html>`;
const pageFile = path.join(tmp, "timeline.html");
fs.writeFileSync(pageFile, page);

// ── shoot ────────────────────────────────────────────────────────────────────
const browser = await launch();
const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await p.goto(pathToFileURL(pageFile).href, { waitUntil: "load" });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(100);

// captions that do not fit their band (more than two lines, or wider than the band)
for (const s of scenes) {
  for (const line of s.lines) {
    const over = await p.evaluate(async ({ t, line }) => {
      await window.seek(t);
      const cap = document.getElementById("cap");
      cap.textContent = line;
      const band = cap.parentElement;
      const lh = parseFloat(getComputedStyle(cap.parentElement).lineHeight);
      return cap.offsetHeight > band.clientHeight || cap.offsetHeight > lh * 2 + 2;
    }, { t: s.start + 0.01, line });
    if (over) warns.push(`자막이 두 줄을 넘음: '${line.slice(0, 30)}' — 짧게 나누세요`);
  }
}

const started = Date.now();
const input2 = audio ? ["-i", path.resolve(audio)] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
if (audio) {
  const pr = spawnSync(process.env.FFPROBE || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.resolve(audio)]);
  const d = Number(pr.stdout?.toString().trim());
  if (d && Math.abs(d - T) > 1) warns.push(`목소리 ${d.toFixed(1)}초 · 영상 ${T.toFixed(1)}초 — 장면 초를 목소리에 맞추세요`);
}
const enc = spawn(
  FFMPEG,
  [
    "-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    ...input2,
    "-map", "0:v", "-map", "1:a",
    // browser JPEG frames are full-range BT.601 — convert to limited-range BT.709 and tag it so every app shows the same colors
    "-vf", "scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", T.toFixed(3), out,
  ],
  { stdio: ["pipe", "ignore", "pipe"] },
);
let err = "";
enc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
const done = new Promise((ok, bad) => enc.on("close", (c) => (c === 0 ? ok() : bad(new Error(`ffmpeg ${c}: ${err}`)))));

async function frame(t, opts) {
  await p.evaluate((x) => window.seek(x), t);
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return p.screenshot({ type: "jpeg", quality: 92, ...opts });
}
const frames = Math.ceil(T * FPS);
for (let f = 0; f < frames; f++) {
  const buf = await frame(f / FPS);
  if (!enc.stdin.write(buf)) await new Promise((ok) => enc.stdin.once("drain", ok));
  if (f % FPS === 0) process.stdout.write(`\r${Math.round((f / frames) * 100)}%`);
}
enc.stdin.end();
await done;
const cover = out.replace(/\.mp4$/i, "") + ".jpg";
await frame(Number(spec.cover ?? 0), { path: cover });
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

const size = fs.statSync(out).size;
console.log(`\r${path.basename(out)} · ${W}×${H} · ${T.toFixed(1)}초 · ${frames}프레임 · ${(size / 1024 / 1024).toFixed(1)}MB · ${((Date.now() - started) / 1000).toFixed(0)}초 걸림\n표지 ${path.basename(cover)}`);
for (const w of [...new Set(warns)]) console.log(`  ! ${w}`);
