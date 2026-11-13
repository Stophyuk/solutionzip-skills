#!/usr/bin/env node
// Bake an intro deck into files you can upload: one self-contained HTML file and the same slides as a PDF.
//
//   node build.mjs deck.html [--out out] [--name my-app] [--html-max 5] [--pdf-max 20]
//   node build.mjs --fonts [dir]       download Pretendard (SIL OFL) Regular · Bold · ExtraBold into dir (default ./fonts)
//
// What it does
//   fonts   — every @font-face url() that points at a local file is cut down to the characters in the deck
//             (subset-font, if installed) and put inside the HTML as data
//   images  — every local <img> and CSS url() is re-encoded at the size it is shown (×2 for sharp screens, never
//             bigger than the original) and put inside as data. If the file is over --html-max MB, it tries again
//             smaller and softer until it fits
//   output  — <out>/<name>.html · <name>.pdf (Chrome print, one slide per page) · <name>-cover.jpg (slide 1, for a
//             thumbnail) · slides/01.png … (1920×1080, for the video) · sandbox.png · report.json
//
// Checks (exit 1 when anything fails)
//   fail  outside request — the HTML is opened in <iframe sandbox="allow-scripts"> under a CSP that allows only
//         inline code and data: files; any request out of it, any CSP refusal, a missing picture or font fails
//   fail  size — HTML over --html-max MB (default 5) · PDF over --pdf-max MB (default 20)
//   fail  overflow — text outside its slide · slide content taller than the slide
//   fail  pages — the PDF page count differs from the slide count
//   warn  slides — fewer than 6 or more than 10
//   warn  small text — under 20px on a 1280×720 slide (the viewer shrinks each slide to fit a frame in the page, more on a phone)
//   warn  numbers — text with digits that is not inside an element with data-source="where it was measured"
//   warn  personal info — e-mail addresses, phone numbers, resident registration numbers in the text
//   warn  links — <a href="http…"> does not open inside a sandboxed viewer; write the address as text
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Packages next to this script, or in the folder you run it from (`npm i playwright subset-font` there once).
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
    console.error("Playwright가 없습니다 — 작업 폴더에서 `npm i playwright subset-font` 한 번 실행하세요.");
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

// ── --fonts: fetch Pretendard once ───────────────────────────────────────────
if (argv[0] === "--fonts") {
  const dir = path.resolve(argv[1] ?? "fonts");
  fs.mkdirSync(dir, { recursive: true });
  const base = "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/packages/pretendard/dist/web/static/woff2";
  for (const w of ["Regular", "Bold", "ExtraBold"]) {
    const res = await fetch(`${base}/Pretendard-${w}.woff2`);
    if (!res.ok) {
      console.error(`Pretendard-${w}.woff2 받기 실패 (HTTP ${res.status}) — github.com/orioncactus/pretendard 에서 직접 받아 ${dir}에 넣으세요.`);
      process.exit(1);
    }
    fs.writeFileSync(path.join(dir, `Pretendard-${w}.woff2`), Buffer.from(await res.arrayBuffer()));
    console.log(`받음 ${path.join(dir, `Pretendard-${w}.woff2`)}`);
  }
  console.log("Pretendard는 SIL Open Font License — 문서에 넣어 배포해도 됩니다. 글꼴 파일만 따로 팔 수는 없습니다.");
  process.exit(0);
}

const HTML_MAX = Number(opt("html-max", 5)) * 1024 * 1024;
const PDF_MAX = Number(opt("pdf-max", 20)) * 1024 * 1024;
const outOpt = opt("out", null);
const nameOpt = opt("name", null);
const deckArg = argv[0];
if (!deckArg) {
  console.error("쓰는 법: node build.mjs deck.html [--out out] [--name 파일이름] · 글꼴 받기: node build.mjs --fonts");
  process.exit(1);
}
const deckPath = path.resolve(deckArg);
const deckDir = path.dirname(deckPath);
const OUT = path.resolve(outOpt ?? path.join(deckDir, "out"));
const NAME = nameOpt ?? path.basename(deckPath).replace(/\.html?$/i, "");
fs.mkdirSync(path.join(OUT, "slides"), { recursive: true });
const src = fs.readFileSync(deckPath, "utf8");

const fails = [];
const warns = [];
const isLocal = (u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u.trim());
const mime = (f) => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif" })[path.extname(f).toLowerCase()] ?? "application/octet-stream";
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`;

// ── fonts: subset + inline ───────────────────────────────────────────────────
// The text to keep = every character in the source (slides, CSS strings such as --app, script labels) + ASCII.
const keep = [...new Set([...src, ..."!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~ ·—–…‘’“”←→↑↓"])].join("");
const subsetMod = await need("subset-font");
const subsetFont = subsetMod?.default ?? subsetMod;
let html = src;
const fontNotes = [];
for (const block of src.match(/@font-face\s*{[^}]*}/g) ?? []) {
  let out = block;
  for (const m of block.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
    const ref = m[2];
    if (!isLocal(ref)) {
      fails.push(`글꼴이 바깥 주소: ${ref} — 파일로 받아 ./fonts에 두세요(node build.mjs --fonts)`);
      continue;
    }
    const file = path.resolve(deckDir, ref);
    if (!fs.existsSync(file)) {
      fails.push(`글꼴 파일 없음: ${ref} — node build.mjs --fonts 로 받거나 경로를 고치세요`);
      continue;
    }
    const raw = fs.readFileSync(file);
    let data = raw;
    let how = "통째로";
    if (subsetFont) {
      data = await subsetFont(raw, keep, { targetFormat: "woff2" });
      how = "필요한 글자만";
    } else {
      warns.push("subset-font가 없어 글꼴을 통째로 넣었습니다 — `npm i subset-font` 뒤 다시 구우면 HTML이 훨씬 작아집니다");
    }
    fontNotes.push(`${path.basename(file)} ${(raw.length / 1024).toFixed(0)}KB → ${(data.length / 1024).toFixed(0)}KB (${how})`);
    out = out.replace(m[0], `url(data:font/woff2;base64,${data.toString("base64")})`);
  }
  html = html.replace(block, out);
}

// ── look at the deck in a browser ────────────────────────────────────────────
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(deckPath).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(200);

const look = await page.evaluate(() => {
  const res = { slides: [], images: {}, cssUrls: [], links: [] };
  const slides = [...document.querySelectorAll(".slide")];
  const skip = (el) => el.closest("[data-ignore], script, style, .nav");
  const reMail = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
  const rePhone = /(?:^|[^\d])(01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}|0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4})(?!\d)/;
  const reRrn = /\d{6}[-\s]?[1-4]\d{6}/;
  slides.forEach((sl, k) => {
    // make this slide the visible one so every measurement is in place
    slides.forEach((x, j) => x.toggleAttribute("data-on", j === k));
    const name = sl.dataset.slide || `${k + 1}`;
    const r = sl.getBoundingClientRect();
    const s = { name, overflow: [], small: [], numbers: [], personal: [] };
    if (sl.scrollHeight > sl.clientHeight + 1) s.overflow.push(`내용이 슬라이드보다 ${sl.scrollHeight - sl.clientHeight}px 김`);
    const walker = document.createTreeWalker(sl, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const t = walker.currentNode;
      const text = t.textContent.replace(/\s+/g, " ").trim();
      const el = t.parentElement;
      if (!text || skip(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const b of range.getClientRects()) {
        if (b.width && (b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1 || b.bottom > r.bottom + 1)) {
          s.overflow.push(`'${text.slice(0, 24)}' 슬라이드 밖으로 나감`);
          break;
        }
      }
      if (!seen.has(el)) {
        seen.add(el);
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 20) s.small.push(`'${text.slice(0, 20)}' ${size}px`);
      }
      if (/\d/.test(text) && !el.closest("[data-source]")) s.numbers.push(text.slice(0, 40));
      if (reMail.test(text)) s.personal.push(`메일 주소 '${text.match(reMail)[0]}'`);
      if (rePhone.test(text)) s.personal.push(`전화번호 꼴 '${text.match(rePhone)[1]}'`);
      if (reRrn.test(text)) s.personal.push("주민등록번호 꼴");
    }
    if (sl.matches(".result") && !sl.querySelector("[data-source]")) s.numbers.push("(써 본 결과 장에 data-source가 하나도 없음)");
    for (const img of sl.querySelectorAll("img")) {
      const key = img.getAttribute("src") || "";
      const it = (res.images[key] ??= { ok: true, natW: 0, natH: 0, needW: 0, alt: img.getAttribute("alt") });
      if (!img.complete || img.naturalWidth === 0) {
        it.ok = false;
        continue;
      }
      it.natW = img.naturalWidth;
      it.natH = img.naturalHeight;
      const w = img.offsetWidth, h = img.offsetHeight;
      const fitMode = getComputedStyle(img).objectFit;
      const scale = fitMode === "cover" ? Math.max(w / it.natW, h / it.natH) : fitMode === "contain" || fitMode === "scale-down" ? Math.min(w / it.natW, h / it.natH) : w / it.natW;
      it.needW = Math.max(it.needW, Math.ceil(it.natW * scale));
    }
    res.slides.push(s);
  });
  slides.forEach((x, j) => x.toggleAttribute("data-on", j === 0));
  for (const a of document.querySelectorAll("a[href]")) if (/^https?:/i.test(a.getAttribute("href"))) res.links.push(a.getAttribute("href"));
  return res;
});

// CSS url() outside @font-face (backgrounds) — inlined as they are, no resizing
const cssRefs = new Set();
for (const style of html.match(/<style[\s\S]*?<\/style>/gi) ?? []) {
  for (const m of style.replace(/@font-face\s*{[^}]*}/g, "").matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
    if (!m[2].startsWith("data:")) cssRefs.add(m[2]);
  }
}
for (const ref of [...html.matchAll(/style="[^"]*url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map((m) => m[2])) if (!ref.startsWith("data:")) cssRefs.add(ref);

// Anything that would be fetched from outside: scripts, stylesheets, frames, media, imports
for (const m of html.matchAll(/<(script|link|iframe|video|audio|source|embed|object)\b[^>]*\b(?:src|href|data)=["']([^"']+)["']/gi)) {
  if (m[1].toLowerCase() === "link" && !/rel=["']?(?:stylesheet|preload|icon|modulepreload)/i.test(m[0])) continue;
  fails.push(`<${m[1]}>가 파일을 불러옴: ${m[2]} — 안에 직접 쓰세요(스타일은 <style>, 그림은 <img>)`);
}
if (/@import/i.test(html)) fails.push("@import가 있음 — 스타일은 <style> 안에 직접 쓰세요");
for (const href of look.links) warns.push(`링크 ${href} — 월드컵 뷰어(sandbox) 안에서는 눌리지 않습니다. 주소는 글자로 보이게 쓰세요`);

// ── images: re-encode at the shown size, shrink until the HTML fits ─────────
const imgKeys = Object.keys(look.images);
for (const k of imgKeys) {
  const it = look.images[k];
  if (!isLocal(k)) fails.push(`그림이 바깥 주소: ${k.slice(0, 80)} — 파일로 받아 옆 폴더에 두세요`);
  else if (!it.ok) fails.push(`그림을 못 불러옴: ${k}`);
}
const originals = {};
for (const k of imgKeys) {
  if (!isLocal(k) || !look.images[k].ok) continue;
  const f = path.resolve(deckDir, decodeURI(k));
  originals[k] = `data:${mime(f)};base64,${fs.readFileSync(f).toString("base64")}`;
}
const cssData = {};
for (const ref of cssRefs) {
  if (!isLocal(ref)) {
    fails.push(`CSS가 바깥 주소를 씀: ${ref.slice(0, 80)}`);
    continue;
  }
  const f = path.resolve(deckDir, decodeURI(ref));
  if (!fs.existsSync(f)) {
    fails.push(`CSS 그림 파일 없음: ${ref}`);
    continue;
  }
  cssData[ref] = `data:${mime(f)};base64,${fs.readFileSync(f).toString("base64")}`;
}

const encode = (level) =>
  page.evaluate(
    async ({ items, level }) => {
      const out = {};
      for (const { key, data, needW, natW } of items) {
        const img = new Image();
        img.src = data;
        await img.decode();
        // needW 0 = the picture is never shown at a size (hidden) — keep it at most 1280px wide
        const w = Math.max(1, Math.min(natW, Math.round((needW || 640) * level.dpr)));
        const h = Math.max(1, Math.round((img.naturalHeight * w) / img.naturalWidth));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, w, h);
        // keep transparency (logos, cut-outs) as PNG; everything else as JPEG
        const a = g.getImageData(0, 0, w, h).data;
        let alpha = false;
        for (let i = 3; i < a.length; i += 16) if (a[i] < 250) { alpha = true; break; }
        out[key] = { url: alpha ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", level.q), w, h, type: alpha ? "png" : "jpg" };
      }
      return out;
    },
    { items: Object.keys(originals).map((key) => ({ key, data: originals[key], needW: look.images[key].needW, natW: look.images[key].natW })), level },
  );

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function assemble(enc) {
  let h = html;
  for (const [k, v] of Object.entries(enc)) h = h.replace(new RegExp(`(\\ssrc=)(["'])${escRe(k)}\\2`, "g"), `$1$2${v.url}$2`);
  for (const [k, v] of Object.entries(cssData)) h = h.replace(new RegExp(`url\\(\\s*(["']?)${escRe(k)}\\1\\s*\\)`, "g"), `url(${v})`);
  return h;
}
const LEVELS = [
  { dpr: 2, q: 0.86 },
  { dpr: 1.6, q: 0.8 },
  { dpr: 1.3, q: 0.74 },
  { dpr: 1, q: 0.68 },
  { dpr: 0.8, q: 0.6 },
];
let enc = {};
let out = html;
let used = LEVELS[0];
for (const level of LEVELS) {
  enc = await encode(level);
  out = assemble(enc);
  used = level;
  if (Buffer.byteLength(out) <= HTML_MAX * 0.96) break;
}
const htmlFile = path.join(OUT, `${NAME}.html`);
fs.writeFileSync(htmlFile, out);
const htmlSize = Buffer.byteLength(out);
if (htmlSize > HTML_MAX) fails.push(`HTML ${mb(htmlSize)} > ${mb(HTML_MAX)} — 그림 수를 줄이거나 작은 화면으로 바꾸세요`);
await page.close();

// ── sandbox check: the way a viewer that blocks every outside request opens it ──
const CSP = "default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src data: blob:";
const sb = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
const outside = [];
const refused = [];
// count every request that is not inline data, and never let one reach the network
sb.on("request", (r) => {
  if (!/^(data|blob|about):/i.test(r.url())) outside.push(r.url());
});
await sb.route("**/*", (route) => (/^https?:/i.test(route.request().url()) ? route.abort() : route.continue()));
sb.on("console", (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) refused.push(m.text().slice(0, 160));
});
await sb.setContent('<!doctype html><html><body style="margin:0;background:#8a8a8a"><iframe id="f" sandbox="allow-scripts" style="border:0;display:block;width:1280px;height:760px"></iframe></body></html>');
await sb.evaluate(() => {
  window.__msgs = [];
  addEventListener("message", (e) => window.__msgs.push(e.data));
});
await sb.evaluate(
  ({ doc, csp }) => {
    document.getElementById("f").srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">` + doc.replace(/^\s*<!doctype[^>]*>/i, "");
  },
  { doc: out, csp: CSP },
);
await sb.waitForTimeout(400);
const frame = sb.frames().find((f) => f !== sb.mainFrame());
let inside = null;
if (frame) {
  await frame.waitForLoadState("load").catch(() => {});
  inside = await frame
    .evaluate(async () => {
      await document.fonts.ready;
      const faces = [...document.fonts];
      return {
        slides: document.querySelectorAll(".slide").length,
        shown: [...document.querySelectorAll(".slide")].findIndex((s) => s.hasAttribute("data-on")) + 1,
        brokenImages: [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).length,
        fonts: faces.length,
        fontErrors: faces.filter((f) => f.status === "error").length,
        fontUsed: faces.length ? document.fonts.check('700 32px "Pretendard"') : true,
        script: document.documentElement.classList.contains("js") && !!document.querySelector(".nav"),
        // in a frame the viewer draws n/N itself — the deck's own page buttons must stay hidden
        navShown: !!document.querySelector(".nav") && getComputedStyle(document.querySelector(".nav")).display !== "none",
      };
    })
    .catch((e) => ({ error: e.message.split("\n")[0] }));
  // page through it from outside, the way a viewer's ↑ ↓ would
  await sb.evaluate(() => document.getElementById("f").contentWindow.postMessage({ type: "deck:go", to: "next" }, "*"));
  await sb.waitForTimeout(150);
  const after = await frame.evaluate(() => [...document.querySelectorAll(".slide")].findIndex((s) => s.hasAttribute("data-on")) + 1).catch(() => 0);
  const msgs = await sb.evaluate(() => window.__msgs);
  if (inside && !inside.error) inside.pagedTo = after;
  if (inside && !inside.error) inside.told = msgs.filter((m) => m && m.type === "deck:page").map((m) => `${m.page}/${m.pages}`);
  await sb.evaluate(() => document.getElementById("f").contentWindow.postMessage({ type: "deck:go", to: 1 }, "*"));
  await sb.waitForTimeout(200);
}
await sb.screenshot({ path: path.join(OUT, "sandbox.png") });
await sb.close();
if (outside.length) fails.push(`바깥 요청 ${outside.length}건: ${[...new Set(outside)].slice(0, 3).join(" · ")}`);
for (const r of [...new Set(refused)].slice(0, 3)) fails.push(`CSP가 막음: ${r}`);
if (!inside || inside.error) fails.push(`sandbox 안에서 열리지 않음${inside?.error ? `: ${inside.error}` : ""}`);
else {
  if (inside.brokenImages) fails.push(`sandbox 안에서 안 뜨는 그림 ${inside.brokenImages}개`);
  if (inside.fontErrors) fails.push(`sandbox 안에서 안 뜨는 글꼴 ${inside.fontErrors}개`);
  if (!inside.script) warns.push("sandbox 안에서 쪽 넘김 스크립트가 돌지 않음 — 슬라이드가 세로로 이어져 보입니다");
  if (inside.navShown) warns.push("프레임 안에서도 쪽 단추(n/N)가 보임 — 뷰어의 n/N과 두 번 보입니다(template.html의 쪽 넘김 스크립트를 쓰세요)");
}

// ── PDF ──────────────────────────────────────────────────────────────────────
const pp = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await pp.goto(pathToFileURL(htmlFile).href, { waitUntil: "load" });
await pp.evaluate(() => document.fonts.ready);
await pp.emulateMedia({ media: "print" });
const pdfFile = path.join(OUT, `${NAME}.pdf`);
await pp.pdf({ path: pdfFile, preferCSSPageSize: true, printBackground: true });
await pp.close();
const pdfBuf = fs.readFileSync(pdfFile);
const pdfPages = (pdfBuf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
if (pdfBuf.length > PDF_MAX) fails.push(`PDF ${mb(pdfBuf.length)} > ${mb(PDF_MAX)}`);
if (pdfPages !== look.slides.length) fails.push(`PDF ${pdfPages}쪽 ≠ 슬라이드 ${look.slides.length}장 — 넘치는 슬라이드가 다음 쪽으로 밀렸을 수 있음`);

// ── slide pictures (video) + cover ──────────────────────────────────────────
const ps = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
await ps.goto(pathToFileURL(htmlFile).href, { waitUntil: "load" });
await ps.evaluate(() => document.fonts.ready);
await ps.addStyleTag({ content: ".nav { display: none !important; }" });
for (let k = 0; k < look.slides.length; k++) {
  await ps.evaluate((k) => document.querySelectorAll(".slide").forEach((s, j) => s.toggleAttribute("data-on", j === k)), k);
  await ps.waitForTimeout(50);
  await ps.screenshot({ path: path.join(OUT, "slides", `${String(k + 1).padStart(2, "0")}.png`) });
  if (k === 0) await ps.screenshot({ path: path.join(OUT, `${NAME}-cover.jpg`), type: "jpeg", quality: 88, scale: "css" });
}
await browser.close();

// ── report ───────────────────────────────────────────────────────────────────
const n = look.slides.length;
if (n < 6 || n > 10) warns.push(`슬라이드 ${n}장 — 6~10장을 권합니다`);
for (const s of look.slides) {
  for (const o of s.overflow) fails.push(`넘침 [${s.name}] ${o}`);
  for (const x of s.small) warns.push(`작은 글자 [${s.name}] ${x}`);
  for (const x of s.numbers) warns.push(`숫자 확인 [${s.name}] '${x}' — 잰 값이면 data-source에 어디서 잰 값인지, 아니면 빼기`);
  for (const x of s.personal) warns.push(`개인정보 [${s.name}] ${x} — 꼭 공개할 것이 아니면 빼기`);
}
const report = {
  deck: deckPath,
  html: { file: htmlFile, bytes: htmlSize, limit: HTML_MAX },
  pdf: { file: pdfFile, bytes: pdfBuf.length, pages: pdfPages, limit: PDF_MAX },
  slides: n,
  images: Object.fromEntries(Object.entries(enc).map(([k, v]) => [k, `${v.w}×${v.h} ${v.type} ${(v.url.length * 0.75 / 1024).toFixed(0)}KB`])),
  imageLevel: used,
  fonts: fontNotes,
  sandbox: { outsideRequests: outside.length, cspRefusals: refused.length, ...(inside ?? {}) },
  fail: fails,
  warn: [...new Set(warns)],
};
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

console.log(`HTML  ${mb(htmlSize)} / ${mb(HTML_MAX)}  ${path.relative(process.cwd(), htmlFile)}`);
console.log(`PDF   ${mb(pdfBuf.length)} / ${mb(PDF_MAX)}  ${pdfPages}쪽  ${path.relative(process.cwd(), pdfFile)}`);
console.log(`그림  ${Object.keys(enc).length}장 · 배율 ${used.dpr} · 품질 ${used.q}${fontNotes.length ? `\n글꼴  ${fontNotes.join(" · ")}` : ""}`);
console.log(`sandbox  바깥 요청 ${outside.length} · CSP 거절 ${refused.length}${inside && !inside.error ? ` · 슬라이드 ${inside.slides} · 그림 깨짐 ${inside.brokenImages} · 글꼴 ${inside.fonts - inside.fontErrors}/${inside.fonts} · 쪽 넘김 ${inside.pagedTo === 2 ? "됨" : "안 됨"}` : ""}`);
for (const f of fails) console.log(`  ✗ ${f}`);
for (const w of report.warn) console.log(`  ! ${w}`);
console.log(fails.length ? `\n실패 ${fails.length} — 고친 뒤 다시 구우세요.` : `\n통과 → ${OUT}  (경고 ${report.warn.length}개는 읽고 판단)`);
process.exit(fails.length ? 1 : 0);
