#!/usr/bin/env node
// Screenshot every page of a site at desktop (1366) and phone (360) width, and flag what breaks on a phone.
//
//   node shots.mjs https://example.com                 pages from /sitemap.xml, else links found on the home page
//   node shots.mjs https://example.com / /about /faq   only these paths
//   node shots.mjs --config pages.json                 paths, hidden selectors and click steps from a file
//
// Options: --out <dir> (default ./shots) · --max <n> pages (default 30) · --chunks <n> per page (default 14)
//          --only d|m (one width) · --hide ".cookie-bar,.chat-button" (CSS selectors left out of the shots)
//
// Output in <out>/: <slug>-d-00.png … (one screen per file, so a long page stays readable),
// <slug>-m-pair-00.png (phone screens two side by side), index.html (every shot on one page), report.json.
//
// Checks per page and width (report.json; exit 1 when any page fails):
//   status    — fail: HTTP status 400 or above, or the page did not load
//   overflow  — fail (phone): the page is wider than the screen, so it scrolls sideways
//   image     — warn: <img> that did not load after scrolling the whole page once
//   console   — warn: JavaScript errors printed while loading
//   charset   — warn: the document is not UTF-8 (Korean text may turn into mojibake)
//
// pages.json: { "base": "https://example.com", "hide": [".sticky-cta"],
//   "pages": [ "/", { "slug": "menu-open", "path": "/", "only": "m", "click": [".nav-toggle"] } ] }
import fs from "node:fs";
import path from "node:path";

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

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const configFile = opt("config", null);
const OUT = path.resolve(opt("out", "shots"));
const MAX_PAGES = Number(opt("max", 30));
const MAX_CHUNKS = Number(opt("chunks", 14));
const ONLY = opt("only", null);
const hideArg = opt("hide", "");

const config = configFile ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
const base = (config.base || argv.find((a) => /^https?:\/\//.test(a)) || "").replace(/\/$/, "");
if (!base) {
  console.error("주소가 필요합니다 — node shots.mjs https://example.com");
  process.exit(1);
}
const origin = new URL(base).origin;
const hide = [...(config.hide || []), ...hideArg.split(",").map((s) => s.trim()).filter(Boolean)];
const argPaths = argv.filter((a) => a.startsWith("/"));

const VPS = {
  d: { width: 1366, height: 800, dsf: 1 },
  m: { width: 360, height: 780, dsf: 2 },
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const slugOf = (p) => (p === "/" ? "home" : p.replace(/^\/|\/$/g, "").replace(/[^\w가-힣-]+/g, "-").slice(0, 60) || "page");

// ── which pages ──────────────────────────────────────────────────────────────
async function discover(browser) {
  const sameSite = (u) => {
    try {
      const url = new URL(u, base);
      return url.origin === origin ? url.pathname : null;
    } catch {
      return null;
    }
  };
  const fileLike = /\.(png|jpe?g|webp|gif|svg|pdf|zip|xml|txt|json|ico)$/i;
  // 1) sitemap.xml (one level of sitemap index)
  try {
    const res = await fetch(`${origin}/sitemap.xml`);
    if (res.ok) {
      let xml = await res.text();
      const locs = (x) => [...x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      if (/<sitemapindex/i.test(xml)) {
        const first = locs(xml)[0];
        xml = first ? await (await fetch(first)).text() : "";
      }
      const paths = [...new Set(locs(xml).map(sameSite).filter((p) => p && !fileLike.test(p)))];
      if (paths.length) return { from: "sitemap.xml", paths };
    }
  } catch {}
  // 2) links on the home page — if even that does not open, shoot "/" alone and let its check report why
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  let hrefs = [];
  try {
    await p.goto(base, { waitUntil: "load", timeout: 60000 });
    hrefs = await p.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href));
  } catch {}
  await ctx.close();
  const paths = [...new Set(["/", ...hrefs.map(sameSite).filter((x) => x && !fileLike.test(x))])];
  return { from: "home page links", paths };
}

// ── one page at one width ────────────────────────────────────────────────────
async function shoot(browser, pg, key) {
  const vp = VPS[key];
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dsf,
    reducedMotion: "reduce",
    locale: "ko-KR",
    isMobile: key === "m",
    hasTouch: key === "m",
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  const result = { slug: pg.slug, path: pg.path, width: key, files: [], fail: [], warn: [] };
  let res;
  try {
    res = await p.goto(origin + pg.path, { waitUntil: "load", timeout: 60000 });
  } catch (e) {
    result.fail.push(`열리지 않음: ${e.message.split("\n")[0]}`);
    await ctx.close();
    return result;
  }
  if (res && res.status() >= 400) result.fail.push(`HTTP ${res.status()}`);
  // Fixed bars are drawn mid-page in a full-page clip — they are not part of the page, so leave them out
  if (hide.length) await p.addStyleTag({ content: `${hide.join(",")} { display: none !important; }` });
  await p.evaluate(() => document.fonts.ready);
  // Lazy images below the fold never load in a full-page clip — walk down once, back to the top, let them land
  const broken = await p.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    scrollTo(0, 0);
    const late = [...document.images].filter((i) => !i.complete);
    await Promise.race([
      Promise.all(late.map((i) => new Promise((r) => (i.addEventListener("load", r, { once: true }), i.addEventListener("error", r, { once: true }))))),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    return [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src).slice(0, 5);
  });
  for (const src of broken) result.warn.push(`그림이 안 뜸: ${src}`);
  // Without a charset the browser guesses a legacy encoding and Korean text turns into mojibake
  const charset = await p.evaluate(() => document.characterSet);
  if (charset.toUpperCase() !== "UTF-8") result.warn.push(`문자셋이 ${charset} — 한글이 깨질 수 있음(<meta charset="utf-8"> 확인)`);
  await wait(600);
  for (const sel of pg.click || []) {
    await p.locator(sel).first().click();
    await wait(500);
  }
  await p.evaluate(() => scrollTo(0, 0));
  await wait(300);
  if (key === "m") {
    const wide = await p.evaluate(() => {
      const W = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth <= W + 1) return null;
      // name the widest element that sticks out, so the fix has somewhere to start
      let worst = null;
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.right > W + 1 && (!worst || r.right > worst.right)) worst = { right: Math.round(r.right), tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40) };
      }
      return { scrollWidth: document.documentElement.scrollWidth, W, worst };
    });
    if (wide) result.fail.push(`가로로 밀림: 페이지 ${wide.scrollWidth}px > 화면 ${wide.W}px${wide.worst ? ` (가장 튀어나온 것 <${wide.worst.tag} class="${wide.worst.cls}"> ${wide.worst.right}px)` : ""}`);
  }
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  const n = Math.min(pg.max ?? MAX_CHUNKS, Math.ceil(h / vp.height));
  for (let i = 0; i < n; i++) {
    const y = i * vp.height;
    // the page can get shorter while it is shot (late images, sticky bars) — re-measure
    const now = await p.evaluate(() => document.documentElement.scrollHeight);
    if (y >= now) break;
    const f = path.join(OUT, `${pg.slug}-${key}-${String(i).padStart(2, "0")}.png`);
    await p.screenshot({ path: f, fullPage: true, clip: { x: 0, y, width: vp.width, height: Math.min(vp.height, now - y) } });
    result.files.push(path.basename(f));
  }
  for (const e of [...new Set(errors)].slice(0, 3)) result.warn.push(`스크립트 오류: ${e}`);
  console.log(`${pg.slug} ${key} ${h}px · ${result.files.length}장${result.fail.length ? ` · 실패 ${result.fail.length}` : ""}`);
  await ctx.close();
  return result;
}

// Phone screens two side by side, so a long page reads like a spread. file:// images are blocked inside
// setContent, so the chunks go in as data URIs.
async function pairs(browser, slug, files) {
  const ctx = await browser.newContext({ viewport: { width: 1456, height: 1576 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const out = [];
  for (let i = 0; i < files.length; i += 2) {
    const imgs = files
      .slice(i, i + 2)
      .map((f) => `<img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, f)).toString("base64")}" style="width:720px;height:auto;display:block;box-shadow:0 0 0 1px #777">`)
      .join("");
    await p.setContent(`<html><body style="margin:0;background:#cfd3dc;display:flex;gap:16px;padding:8px;align-items:flex-start">${imgs}</body></html>`);
    await wait(200);
    const name = `${slug}-m-pair-${String(i / 2).padStart(2, "0")}.png`;
    await p.screenshot({ path: path.join(OUT, name), fullPage: true });
    out.push(name);
  }
  await ctx.close();
  return out;
}

function indexHtml(results) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = results
    .map((r) => {
      const notes = [...r.fail.map((x) => `<li class="fail">${esc(x)}</li>`), ...r.warn.map((x) => `<li>${esc(x)}</li>`)].join("");
      const imgs = (r.pairs?.length ? r.pairs : r.files).map((f) => `<a href="${f}"><img loading="lazy" src="${f}" alt=""></a>`).join("");
      return `<section><h2>${esc(r.path)} <small>${r.width === "d" ? "PC 1366" : "폰 360"}</small></h2>${notes ? `<ul>${notes}</ul>` : ""}<div class="row ${r.width}">${imgs}</div></section>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>페이지 캡처 — ${esc(origin)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;background:#f4f4f5;color:#18181b}h1{font-size:20px}h2{font-size:16px;margin:32px 0 8px}small{color:#71717a;font-weight:400}
ul{margin:0 0 8px;padding-left:20px}li.fail{color:#b91c1c;font-weight:600}.row{display:flex;gap:8px;overflow-x:auto}.row img{height:420px;border:1px solid #d4d4d8;background:#fff}</style>
<h1>${esc(origin)} · ${new Date().toISOString().slice(0, 10)}</h1>
${rows}`;
}

// ── run ──────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
let pages = config.pages || (argPaths.length ? argPaths : null);
if (!pages) {
  const found = await discover(browser);
  console.log(`페이지 ${found.paths.length}개 (${found.from})${found.paths.length > MAX_PAGES ? ` — 앞 ${MAX_PAGES}개만` : ""}`);
  pages = found.paths;
}
const seen = new Set();
const list = pages.slice(0, MAX_PAGES).map((x) => {
  const pg = typeof x === "string" ? { path: x } : { ...x };
  let slug = pg.slug || slugOf(pg.path);
  while (seen.has(slug)) slug += "-2";
  seen.add(slug);
  return { ...pg, slug };
});

const results = [];
for (const pg of list) {
  for (const key of ["d", "m"]) {
    if ((ONLY && ONLY !== key) || (pg.only && pg.only !== key)) continue;
    try {
      const r = await shoot(browser, pg, key);
      if (key === "m" && r.files.length) r.pairs = await pairs(browser, pg.slug, r.files);
      results.push(r);
    } catch (e) {
      results.push({ slug: pg.slug, path: pg.path, width: key, files: [], fail: [`멈춤: ${e.message.split("\n")[0]}`], warn: [] });
      console.log(`${pg.slug} ${key} 멈춤: ${e.message.split("\n")[0]}`);
    }
  }
}
await browser.close();

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ base: origin, at: new Date().toISOString(), results }, null, 2));
fs.writeFileSync(path.join(OUT, "index.html"), indexHtml(results));
const fails = results.filter((r) => r.fail.length);
const warns = results.filter((r) => r.warn.length);
for (const r of fails) console.log(`✗ ${r.path} (${r.width}) ${r.fail.join(" · ")}`);
console.log(`\n${list.length}페이지 · 실패 ${fails.length} · 경고 ${warns.length} → ${path.join(OUT, "index.html")}`);
process.exit(fails.length ? 1 : 0);
