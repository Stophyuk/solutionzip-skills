#!/usr/bin/env node
// Measure whether a screen looks "AI-made" — not by its colors, but by how many surface effects pile up.
//
//   node check.mjs <url | page.html> [outDir] [--json]      (outDir defaults to ./anti-slop-out)
//
// The page is opened at two widths (PC 1366×768, phone 390×844), scrolled once top to bottom so lazy
// and reveal-on-scroll content shows up, then measured four ways:
//
//   pixels  first-screen screenshot → five axes + one gate. fire = how many axes are on (0–5).
//           fire ≥ 3: suspect (surfaces stacking up) · fire ≥ 4: strong
//     ramp        full-screen gradient: brightness fitted to a plane, R² × slope        on at ≥ 0.30
//     hue_travel  how far the hue wheel turns across a 3×3 grid of the screen            on at ≥ 0.35
//     sat_share   area covered by saturated color, counted only when the gate passes     on at ≥ 0.25
//     hue_n       hue families (of 12) holding ≥ 8% of the colored area                  on at ≥ 3
//     glow        dark screen whose center is brighter than its border                   on at ≥ 0.06
//     cdetail     GATE. detail inside colored areas: smooth (< 6) = gradient, rough = photo.
//                 Without it every axis above turns into a photo detector.
//   DOM     whole page: full-screen gradient, one box with 3+ decorations, card in card, neon glow,
//           gradient text, font families, off-scale spacing, emoji as labels, icon tiles,
//           filled buttons, motion length · bounce · endless loops
//   copy    cliché phrases (Korean + English, keep in sync with phrases.md), em dashes in running text
//   a11y    contrast, text under 13px, touch targets under 44px (phone), visible keyboard focus (PC)
//
// Writes <outDir>/report.json and screenshots pc.png · phone.png (first screen), pc-full.jpg · phone-full.jpg.
// Exit 0 clean · 1 when fire ≥ 3 or a high finding outside a11y · 2 when the page could not be measured.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WIDTHS = [
  { key: "pc", label: "PC", viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { key: "phone", label: "폰", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const FULL_MAX = 8000; // full-page screenshots stop here (CSS px)
const GROUPS = ["겹침", "문구", "구성", "움직임", "접근성"];

// Cliché phrases seen on generated landing pages. Korean: plain substring. English: whole word, any case.
const CLICHES_KO = ["혁신", "최적화", "솔루션", "시너지", "인사이트", "차세대", "획기적", "극대화", "원활",
  "올인원", "원스톱", "새로운 차원", "한 차원", "무한한 가능성", "게임 체인저", "압도적", "완벽", "최고의",
  "스마트한", "경험을 선사", "여정", "미래를 여", "잠재력", "가속화", "AI 기반", "강력한", "놀라운", "클릭 몇 번", "클릭만으로"];
const CLICHES_EN = ["seamless", "seamlessly", "effortless", "effortlessly", "revolutionize", "revolutionise", "revolutionary",
  "cutting-edge", "next-gen", "next-generation", "game-changer", "game-changing", "unlock your", "unleash", "supercharge",
  "elevate your", "empower", "empowers", "empowering", "streamline", "harness the power", "transform your", "to the next level",
  "all-in-one", "AI-powered", "world-class", "best-in-class", "state-of-the-art", "reimagine", "reimagined", "leverage",
  "robust", "fast-paced", "delve", "skyrocket", "boost your", "lorem ipsum"];

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
      process.exit(2);
    }
  }
  const chromium = pw.chromium ?? pw.default.chromium;
  try {
    return await chromium.launch({ channel: "chrome", headless: true, args: ["--hide-scrollbars"] });
  } catch {
    return await chromium.launch({ headless: true, args: ["--hide-scrollbars"] });
  }
}

// ── pixels ──────────────────────────────────────────────────────────────────
// Runs inside a blank page. Ports the five axes + gate measured on reference screenshots;
// resize follows Pillow's BILINEAR (triangle filter widened when shrinking), so small grids average areas.
async function pixelAxes(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const rgba = cx.getImageData(0, 0, W, H).data;
  const base = new Uint8ClampedArray(W * H * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    base[j] = rgba[i];
    base[j + 1] = rgba[i + 1];
    base[j + 2] = rgba[i + 2];
  }

  const coeffs = (inSize, outSize) => {
    const scale = inSize / outSize, fscale = Math.max(scale, 1);
    const out = [];
    for (let o = 0; o < outSize; o++) {
      const center = (o + 0.5) * scale;
      const lo = Math.max(Math.trunc(center - fscale + 0.5), 0);
      const hi = Math.min(Math.trunc(center + fscale + 0.5), inSize);
      const w = [];
      let sum = 0;
      for (let x = lo; x < hi; x++) {
        const t = Math.abs((x - center + 0.5) / fscale);
        const v = t < 1 ? 1 - t : 0;
        w.push(v);
        sum += v;
      }
      out.push({ lo, w: w.map((v) => (sum ? v / sum : 0)) });
    }
    return out;
  };
  const resize = (px, w, h, nw, nh) => {
    const kx = coeffs(w, nw), ky = coeffs(h, nh);
    const tmp = new Uint8ClampedArray(nw * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < nw; x++) {
        const { lo, w: k } = kx[x];
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let i = 0; i < k.length; i++) s += px[(y * w + lo + i) * 3 + c] * k[i];
          tmp[(y * nw + x) * 3 + c] = s;
        }
      }
    const out = new Uint8ClampedArray(nw * nh * 3);
    for (let y = 0; y < nh; y++) {
      const { lo, w: k } = ky[y];
      for (let x = 0; x < nw; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let i = 0; i < k.length; i++) s += tmp[((lo + i) * nw + x) * 3 + c] * k[i];
          out[(y * nw + x) * 3 + c] = s;
        }
    }
    return out;
  };
  const blur = (px, w, h, sigma) => {
    const r = Math.ceil(sigma * 3), k = [];
    let sum = 0;
    for (let i = -r; i <= r; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k.push(v);
      sum += v;
    }
    const kn = k.map((v) => v / sum);
    const pass = (src, horiz) => {
      const out = new Uint8ClampedArray(src.length);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < 3; c++) {
            let s = 0;
            for (let i = -r; i <= r; i++) {
              const xx = horiz ? Math.min(w - 1, Math.max(0, x + i)) : x;
              const yy = horiz ? y : Math.min(h - 1, Math.max(0, y + i));
              s += src[(yy * w + xx) * 3 + c] * kn[i + r];
            }
            out[(y * w + x) * 3 + c] = s;
          }
      return out;
    };
    return pass(pass(px, true), false);
  };
  const toL = (px) => {
    const n = px.length / 3, o = new Array(n);
    for (let i = 0; i < n; i++) o[i] = (px[i * 3] * 19595 + px[i * 3 + 1] * 38470 + px[i * 3 + 2] * 7471 + 0x8000) >> 16;
    return o;
  };
  const toHSV = (px) => {
    const n = px.length / 3, Hh = new Uint8Array(n), Ss = new Uint8Array(n), Vv = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      Vv[i] = mx;
      if (mx === mn) continue;
      const cr = mx - mn, rc = (mx - r) / cr, gc = (mx - g) / cr, bc = (mx - b) / cr;
      let h = r === mx ? bc - gc : g === mx ? 2 + rc - bc : 4 + gc - rc;
      h = (h / 6 + 1) % 1;
      Hh[i] = Math.min(255, Math.trunc(h * 255));
      Ss[i] = Math.min(255, Math.trunc((cr / mx) * 255));
    }
    return { H: Hh, S: Ss, V: Vv };
  };

  // ramp — 32×32 brightness (blurred) fitted to the plane z = a·x + b·y + c
  const z = toL(blur(resize(base, W, H, 32, 32), 32, 32, 1.2));
  const n = z.length;
  const xs = z.map((_, i) => (i % 32) / 31), ys = z.map((_, i) => Math.floor(i / 32) / 31);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs), my = mean(ys), mz = mean(z);
  let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my, dz = z[i] - mz;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy; sxz += dx * dz; syz += dy * dz; sst += dz * dz;
  }
  const det = sxx * syy - sxy * sxy;
  const a = Math.abs(det) < 1e-9 ? 0 : (sxz * syy - syz * sxy) / det;
  const b = Math.abs(det) < 1e-9 ? 0 : (syz * sxx - sxz * sxy) / det;
  let ssr = 0;
  for (let i = 0; i < n; i++) ssr += (a * (xs[i] - mx) + b * (ys[i] - my)) ** 2;
  const r2 = sst < 1e-9 ? 0 : Math.max(0, Math.min(1, ssr / sst));
  const ramp = r2 * Math.min((Math.abs(a) + Math.abs(b)) / 255 / 0.35, 1);

  // sat_share · hue_n — 96×96 HSV
  const q = toHSV(resize(base, W, H, 96, 96));
  const sat = [];
  for (let i = 0; i < q.S.length; i++) if (q.S[i] >= 60) sat.push(i);
  const sat_share = sat.length / q.S.length;
  const bins = new Array(12).fill(0);
  const keep = sat.filter((i) => q.V[i] > 20 && q.V[i] < 250);
  for (const i of keep) bins[Math.min(11, Math.floor((q.H[i] * 12) / 256))]++;
  const hue_n = keep.length ? bins.filter((c) => c / keep.length >= 0.08).length : 0;

  // hue_travel — 3×3, the two cells farthest apart on the hue wheel
  const t = toHSV(resize(base, W, H, 3, 3));
  const hs = [];
  for (let i = 0; i < 9; i++) if (t.S[i] >= 40) hs.push(t.H[i]);
  let hue_travel = 0;
  for (let i = 0; i < hs.length; i++)
    for (let j = i + 1; j < hs.length; j++) {
      const d = Math.abs(hs[i] - hs[j]);
      hue_travel = Math.max(hue_travel, Math.min(d, 256 - d) / 128);
    }

  // cdetail — the gate: how much brightness detail survives inside colored areas
  const d192 = resize(base, W, H, 192, 192);
  const dv = toHSV(d192), bv = toHSV(blur(d192, 192, 192, 2.5)).V;
  let csum = 0, cn = 0;
  for (let i = 0; i < dv.S.length; i++)
    if (dv.S[i] >= 60) {
      csum += Math.abs(dv.V[i] - bv[i]);
      cn++;
    }
  const cdetail = cn ? csum / cn : 0;

  // glow — only on a dark screen: center median vs border median
  const g32 = toL(resize(base, W, H, 32, 32));
  const border = g32.filter((_, i) => i < 32 || i >= 992 || i % 32 === 0 || i % 32 === 31).sort((p, q2) => p - q2);
  const bmed = border[Math.floor(border.length / 2)];
  let glow = 0;
  if (bmed < 90) {
    const cen = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) cen.push(g32[(8 + y) * 32 + 8 + x]);
    cen.sort((p, q2) => p - q2);
    glow = Math.max(0, (cen[Math.floor(cen.length / 2)] - bmed) / 255);
  }

  const on = [];
  if (ramp >= 0.3) on.push("ramp");
  if (hue_travel >= 0.35) on.push("hue_travel");
  if (sat_share >= 0.25 && cdetail < 6) on.push("sat_share");
  if (hue_n >= 3) on.push("hue_n");
  if (glow >= 0.06) on.push("glow");
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { ramp: r3(ramp), hue_travel: r3(hue_travel), sat_share: r3(sat_share), cdetail: Math.round(cdetail * 10) / 10,
    hue_n, glow: r3(glow), fire: on.length, on };
}

// ── DOM ─────────────────────────────────────────────────────────────────────
// Runs inside the measured page, scrolled to the top.
function measureDom({ phone, clichesKo, clichesEn }) {
  const vw = innerWidth, vh = innerHeight, vpArea = vw * vh;
  const findings = [];
  const SC = new Map(), RC = new Map(), CC = new Map();
  const st = (el) => SC.get(el) || (SC.set(el, getComputedStyle(el)), SC.get(el));
  const rect = (el) => RC.get(el) || (RC.set(el, el.getBoundingClientRect()), RC.get(el));

  // any CSS color (rgb, oklch, color(), …) → [r, g, b, a] in sRGB, via a 1px canvas
  const cvs = document.createElement("canvas");
  cvs.width = cvs.height = 1;
  const c2 = cvs.getContext("2d", { willReadFrequently: true });
  const color = (c) => {
    if (!c || c === "transparent") return [0, 0, 0, 0];
    if (CC.has(c)) return CC.get(c);
    c2.clearRect(0, 0, 1, 1);
    c2.fillStyle = "rgba(0, 0, 0, 0)";
    c2.fillStyle = c;
    c2.fillRect(0, 0, 1, 1);
    const d = c2.getImageData(0, 0, 1, 1).data;
    const v = [d[0], d[1], d[2], d[3] / 255];
    CC.set(c, v);
    return v;
  };
  const COLOR_RE = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi;
  const chroma = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (p, q) => {
    const a = lum(p), b = lum(q);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const splitTop = (s) => {
    const out = [];
    let depth = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const shadows = (v) =>
    !v || v === "none"
      ? []
      : splitTop(v).map((layer) => {
          const cs = layer.match(COLOR_RE) || [];
          const nums = (layer.replace(COLOR_RE, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
          return { inset: /inset/.test(layer), x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, c: cs.length ? color(cs[0]) : [0, 0, 0, 1] };
        });
  // a soft shadow that is actually visible (a 0-blur ring is a border, not a decoration)
  const hasShadow = (v) => shadows(v).some((s) => !s.inset && s.c[3] > 0.02 && (s.blur > 0 || s.x || s.y));
  // a gradient that really changes color; neutral fades over photos (scrims) are marked
  const gradOf = (s) => {
    const v = (s.backgroundImage || "").replace(/url\([^)]*\)/gi, "");
    if (!/gradient\(/i.test(v)) return null;
    const cs = (v.match(COLOR_RE) || []).map(color);
    if (cs.length < 2) return null;
    let spread = 0;
    for (const p of cs) for (const q of cs) spread = Math.max(spread, ...[0, 1, 2].map((i) => Math.abs(p[i] * p[3] - q[i] * q[3])), Math.abs(p[3] - q[3]) * 255);
    if (spread < 8) return null;
    const neutral = cs.every((c) => chroma(c) <= 12 || c[3] < 0.05);
    return { spread, scrim: neutral && cs.some((c) => c[3] < 0.95) };
  };
  const clipText = (s) => /text/.test(s.backgroundClip || "") || /text/.test(s.webkitBackgroundClip || "");
  const ownText = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  };
  const label = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 28);
    const own = `${tag}${id}${cls.slice(0, 40)}${txt ? ` "${txt}"` : ""}`;
    // a bare <i> or <span> says nothing — name its parent too
    return !id && !cls && !txt && el.parentElement && el.parentElement !== document.body ? `${own} (in ${label(el.parentElement)})` : own;
  };
  const add = (group, rule, level, els, hint, extra = (el) => "") => {
    if (!els.length) return;
    findings.push({ group, rule, level, count: els.length, where: els.slice(0, 4).map((el) => label(el) + extra(el)), hint });
  };
  const addRaw = (group, rule, level, count, where, hint) => findings.push({ group, rule, level, count, where, hint });

  const all = [...document.querySelectorAll("body *")].filter(
    (el) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META|BR|SOURCE|TRACK)$/.test(el.tagName) && !(el.closest("svg") && el.tagName.toLowerCase() !== "svg")
  );
  const shown = all.filter((el) => {
    const s = st(el);
    if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
    const r = rect(el);
    return r.width > 0 && r.height > 0;
  });
  const roots = [document.documentElement, document.body].filter(Boolean);
  const area = (el) => (rect(el).width * rect(el).height) / vpArea;
  // first opaque color behind an element; null when an image or gradient sits in between (unknowable)
  const backdrop = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = st(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = color(s.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 0.99) break;
    }
    let bg = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };

  // 1. full-screen gradient — the DOM side of the ramp axis: a real gradient over ≥ 30% of the viewport
  const grads = [...roots, ...shown].filter((el) => {
    const g = gradOf(st(el));
    return g && !g.scrim && !clipText(st(el));
  });
  add("겹침", "화면을 덮는 그라디언트", "high", grads.filter((el) => gradOf(st(el)).spread >= 24 && area(el) >= 0.3),
    "큰 면은 한 색으로. 그라디언트가 꼭 필요하면 화면 30% 밑, 한 군데만");
  if (grads.length >= 4) add("겹침", "그라디언트 면이 여럿", "mid", grads, "한 화면에 그라디언트 면은 하나까지");

  // 1b. surface stacking — the core of the definition: one box carrying 3+ decorations
  const surfaces = (el) => {
    const s = st(el), out = [];
    if (gradOf(s) && !clipText(s)) out.push("그라디언트");
    if (hasShadow(s.boxShadow)) out.push("그림자");
    if (parseFloat(s.borderTopWidth) > 1 && color(s.borderTopColor)[3] > 0.05) out.push("굵은 테두리");
    if (s.backdropFilter && s.backdropFilter !== "none") out.push("블러");
    if (parseFloat(s.borderTopLeftRadius) >= 16) out.push("큰 라운드");
    if (s.textShadow && s.textShadow !== "none" && shadows(s.textShadow).some((x) => x.c[3] > 0.05)) out.push("글자 그림자");
    return out;
  };
  const stacked = shown.filter((el) => rect(el).width > 40 && rect(el).height > 24 && surfaces(el).length >= 3);
  add("겹침", "한 상자에 장식 3겹", "high", stacked, "그라디언트 · 그림자 · 굵은 테두리 · 블러 · 큰 라운드 · 글자 그림자 중 하나만 남긴다",
    (el) => ` [${surfaces(el).join("+")}]`);

  // 3. neon glow — big colored shadow (not bad alone: it matters when it joins other surfaces)
  add("겹침", "네온 글로우", "mid",
    shown.filter((el) => {
      const s = st(el);
      return shadows(s.boxShadow).some((x) => !x.inset && x.blur > 24 && chroma(x.c) > 40 && x.c[3] > 0.15) ||
        shadows(s.textShadow).some((x) => x.blur > 12 && chroma(x.c) > 40 && x.c[3] > 0.15);
    }),
    "빛나게 하지 말고 크게. 그림자는 회색 계열 한두 단계만");

  // gradient text
  add("겹침", "그라디언트 글자", "mid", shown.filter((el) => clipText(st(el)) && gradOf(st(el))), "강조는 한 색 글자로. 굵기와 크기로 세운다");

  // 2. card in card
  const isCard = (el) => {
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A|IMG|VIDEO|PRE|CODE|svg|LABEL)$/i.test(el.tagName)) return false;
    const r = rect(el), s = st(el);
    if (r.width < 80 || r.height < 48 || parseFloat(s.borderTopLeftRadius) < 6) return false;
    if (Math.max(parseFloat(s.paddingTop), parseFloat(s.paddingLeft)) < 12) return false;
    const border = parseFloat(s.borderTopWidth) >= 1 && color(s.borderTopColor)[3] > 0.05;
    return border || hasShadow(s.boxShadow) || color(s.backgroundColor)[3] > 0.05 || !!gradOf(s);
  };
  const cards = new Set(shown.filter(isCard));
  add("구성", "카드 안에 카드", "high",
    [...cards].filter((el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (cards.has(p)) return true;
      return false;
    }),
    "바깥 상자를 걷고 1px 선과 여백으로 나눈다");

  // 4. font families on visible text (code and icon fonts aside), weighted by characters
  const fam = new Map();
  let chars = 0;
  for (const el of shown) {
    const t = ownText(el);
    if (!t || el.closest("code, pre, kbd, samp")) continue;
    let f = st(el).fontFamily.split(",")[0].replace(/["']/g, "").trim().toLowerCase();
    f = f.replace(/^__(.+?)_[0-9a-f]{5,}$/, "$1").replace(/[_\s]+(variable|vf|web)$/, "").replace(/_/g, " ");
    if (!f || /^(-apple-system|blinkmacsystemfont|system-ui|sans-serif|serif|monospace|ui-sans-serif|ui-serif|ui-monospace|inherit)$/.test(f)) f = "system-ui";
    if (/icon|awesome|symbols|glyph/.test(f)) continue;
    fam.set(f, (fam.get(f) || 0) + t.length);
    chars += t.length;
  }
  const fonts = [...fam].map(([name, n]) => ({ name, share: Math.round((n / Math.max(chars, 1)) * 100) / 100 })).sort((p, q) => q.share - p.share);
  const realFonts = fonts.filter((f) => f.share >= 0.03);
  if (realFonts.length >= 3)
    addRaw("구성", `글꼴 ${realFonts.length}벌`, "mid", realFonts.length, realFonts.map((f) => `${f.name} ${Math.round(f.share * 100)}%`),
      "본문 한 벌(제목용 한 벌까지). 위계는 크기와 굵기로");

  // 5. off-scale spacing — values that are not a multiple of 4 (1–2px hairlines allowed)
  let spaced = 0;
  const off = shown.filter((el) => {
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON|svg)$/i.test(el.tagName)) return false;
    const s = st(el);
    const vals = [s.paddingTop, s.paddingLeft, s.marginTop, s.rowGap, s.columnGap].map(parseFloat).filter((v) => v > 0);
    if (!vals.length) return false;
    spaced++;
    return vals.some((v) => Math.round(v) > 2 && Math.round(v) % 4 !== 0);
  });
  if (off.length >= 5 && off.length / Math.max(spaced, 1) >= 0.1)
    add("구성", `4의 배수가 아닌 여백 (${Math.round((off.length / spaced) * 100)}%)`, "mid", off, "간격 단계를 4의 배수 몇 개로 정하고 그것만 쓴다",
      (el) => {
        const s = st(el);
        const bad = [["p", s.paddingTop], ["p", s.paddingLeft], ["m", s.marginTop], ["gap", s.rowGap], ["gap", s.columnGap]]
          .filter(([, v]) => parseFloat(v) > 2 && Math.round(parseFloat(v)) % 4).map(([k, v]) => `${k} ${v}`);
        return ` [${[...new Set(bad)].join(", ")}]`;
      });

  // 6. emoji carrying meaning — an emoji-only label, or emoji inside headings and buttons
  const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;
  add("구성", "이모지로 의미 전달", "mid",
    (() => {
      const hit = shown.filter((el) => {
        const t = ownText(el);
        if (!t || !EMOJI.test(t)) return false;
        const bare = t.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}|️|‍|\s/gu, "");
        return !bare.length || el.closest("h1, h2, h3, h4, h5, h6, button, [role=button], nav, li");
      });
      return hit.length >= 2 ? hit : [];
    })(),
    "이모지는 장식이지 라벨이 아니다. 글자와 숫자로 말한다");

  // 8. icon tiles — a 32–128px rounded square holding an icon, right above a heading (feature-grid default)
  const headingNear = (el) => {
    for (let n = el, d = 0; n && d < 2; n = n.parentElement, d++)
      for (let sib = n.nextElementSibling, k = 0; sib && k < 2; sib = sib.nextElementSibling, k++)
        if (/^H[2-6]$/.test(sib.tagName) || sib.querySelector?.("h2, h3, h4, h5, h6")) return true;
    return false;
  };
  const tiles = shown.filter((el) => {
    const r = rect(el), s = st(el);
    if (r.width < 32 || r.width > 128 || r.height < 32 || r.height > 128 || r.width / r.height < 0.7 || r.width / r.height > 1.4) return false;
    const box = color(s.backgroundColor)[3] > 0.05 || gradOf(s) || parseFloat(s.borderTopWidth) >= 1;
    if (!box) return false;
    const icon = el.querySelector("svg, img, i, [class*=icon]") || EMOJI.test(ownText(el));
    if (!icon) return false;
    if (el.querySelector("svg, img, i")) {
      const ir = el.querySelector("svg, img, i").getBoundingClientRect();
      if (ir.width > r.width * 0.85) return false;
    }
    return headingNear(el);
  });
  if (tiles.length >= 3) add("구성", "아이콘 타일 줄", "mid", tiles, "아이콘은 동작을 가리킬 때만. 특징 목록은 글자만으로도 된다");

  // 7. filled buttons — one primary action per screen (header · footer · nav CTAs are global, not counted)
  const filled = shown.filter((el) => {
    if (!(/^(A|BUTTON)$/.test(el.tagName) || el.getAttribute("role") === "button" || (el.tagName === "INPUT" && /submit|button/.test(el.type)))) return false;
    if (el.closest("header, footer, nav, [role=navigation], [role=banner], [role=contentinfo]")) return false;
    const txt = (el.innerText || el.value || "").replace(/\s+/g, " ").trim();
    if (!txt || txt.length > 40) return false;
    const s = st(el), r = rect(el);
    if (r.height < 28 || r.width > vw * 0.95) return false;
    const g = gradOf(s);
    const bg = color(s.backgroundColor);
    if (!g && bg[3] < 0.6) return false;
    if (g) return true;
    const behind = el.parentElement ? backdrop(el.parentElement) : [255, 255, 255];
    return !behind || contrast(over(bg, behind), behind) >= 1.6;
  });
  // "Start →" and "Start" are the same action
  const labelOf = (el) => (el.innerText || el.value || "").replace(/[→›»↗➔>]+/g, "").replace(/\s+/g, " ").trim();
  const firstScreen = [...new Set(filled.filter((el) => rect(el).top < vh && rect(el).bottom > 0).map(labelOf))];
  if (firstScreen.length >= 2)
    addRaw("구성", "첫 화면 채움 버튼 2개 이상", "high", firstScreen.length, firstScreen.slice(0, 4), "채움 버튼은 하나. 나머지는 외곽선 · 글자 링크로 내린다");
  const pageWide = [...new Set(filled.map(labelOf))];
  if (pageWide.length >= 2)
    addRaw("구성", "채움 버튼 종류가 여럿", "mid", pageWide.length, pageWide.slice(0, 5), "같은 행동의 반복은 괜찮다. 다른 행동이면 하나만 채운다");

  // 9. motion — role caps, overshoot easing, endless decorative loops
  const secs = (list) => (list || "").split(",").map((v) => parseFloat(v) * (/ms/.test(v) ? 0.001 : 1)).filter((v) => v > 0);
  const durs = (s) => [...(s.transitionProperty === "none" ? [] : secs(s.transitionDuration)), ...(s.animationName === "none" ? [] : secs(s.animationDuration))];
  const roleCap = (el) => {
    const c = `${typeof el.className === "string" ? el.className : ""} ${el.id} ${Object.values(el.dataset || {}).join(" ")}`;
    if (/count|num|ticker/i.test(c)) return 1.1;
    if (/reveal|enter|hero|fade|appear/i.test(c)) return 0.5;
    if (/route|page|accordion|expand|drawer|sheet|collapse/i.test(c)) return 0.4;
    if (/modal|dialog|toast|popover|tooltip|panel|menu/i.test(c)) return 0.3;
    return 0.2; // everything else is treated as hover · press · color change
  };
  // a transition is treated by its role (hover by default); an animation that plays a few times is an entrance
  const tooSlow = (el) => {
    const s = st(el), cap = roleCap(el);
    if (s.transitionProperty !== "none" && secs(s.transitionDuration).some((v) => v > cap + 0.001)) return true;
    if (s.animationName === "none" || /infinite/.test(s.animationIterationCount)) return false;
    return secs(s.animationDuration).some((v) => v > Math.max(cap, 0.5) + 0.001);
  };
  add("움직임", "역할 상한을 넘는 움직임", "mid",
    shown.filter(tooSlow),
    "hover · press 0.2s / 진입 · 모달 0.3s / 큰 전환 0.4s / 한 번 보는 등장 0.5s / 숫자 카운트업 1.1s",
    (el) => ` [${Math.max(...durs(st(el)))}s]`);
  add("움직임", "바운스 · 오버슈트 이징", "high",
    shown.filter((el) => {
      const s = st(el);
      const t = `${s.transitionTimingFunction} ${s.animationTimingFunction} ${s.animationName}`;
      if (/bounce|elastic|wobble|jiggle|spring/i.test(t)) return true;
      return [...t.matchAll(/cubic-bezier\(([^)]+)\)/g)].some((m) => {
        const p = m[1].split(",").map(Number);
        return p.length === 4 && (p[1] > 1 || p[1] < 0 || p[3] > 1 || p[3] < 0);
      });
    }),
    "진입 ease-out / 퇴장 ease-in / 이동 ease-in-out 셋만. 라이브러리 spring 기본값은 bounce 0으로");
  add("움직임", "끝없이 도는 장식 모션", "mid",
    shown.filter((el) => {
      const s = st(el);
      if (s.animationName === "none" || !/infinite/.test(s.animationIterationCount)) return false;
      const c = `${typeof el.className === "string" ? el.className : ""} ${el.id} ${el.getAttribute("role") || ""}`;
      return !/spin|load|progress|skeleton|skel|busy/i.test(c) && !el.closest("[aria-busy=true], [role=progressbar], [role=status]");
    }),
    "모션을 끄면 사용자가 모르게 되는 사실이 없다면 장식이다. 등장은 요소당 한 번");

  // 10. copy — clichés and em dashes in running text
  const text = document.body.innerText || "";
  const low = text.toLowerCase();
  const hits = [];
  for (const w of clichesKo) {
    const k = text.split(w).length - 1;
    if (k) hits.push(`${w} ×${k}`);
  }
  for (const w of clichesEn) {
    const re = new RegExp(`(^|[^a-z])${w.toLowerCase().replace(/[-]/g, "[- ]")}(?![a-z])`, "g");
    const k = (low.match(re) || []).length;
    if (k) hits.push(`${w} ×${k}`);
  }
  if (hits.length) addRaw("문구", "상투 문구", hits.length >= 4 ? "high" : "mid", hits.length, hits, "무엇이 어떻게 바뀌는지 동사로. phrases.md의 '대신'을 본다");
  const dashEls = shown.filter((el) => /^(P|LI|DD|BLOCKQUOTE|TD|FIGCAPTION)$/.test(el.tagName) && /\S\s?—\s?\S/.test(ownText(el)));
  if (dashEls.length >= 3) add("문구", "본문 문장 안 긴 대시(—)", "mid", dashEls, "문장을 나누거나 쉼표로. 긴 대시는 제목 · 라벨에만");

  // a11y — contrast, small text, touch targets
  const textEls = shown.filter((el) => ownText(el));
  add("접근성", "대비 4.5:1 미만", "high",
    textEls.filter((el) => {
      if (el.closest("[disabled], [aria-disabled=true]")) return false; // WCAG 1.4.3 exempts disabled controls
      const s = st(el), bg = backdrop(el);
      if (!bg) return false;
      const fg = color(s.color);
      const fs = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700;
      const need = fs >= 24 || (fs >= 18.66 && bold) ? 3 : 4.5;
      return contrast(over(fg, bg), bg) < need;
    }),
    "본문 글자는 배경과 4.5:1 이상(큰 글자 3:1)", (el) => {
      const bg = backdrop(el);
      return ` [${contrast(over(color(st(el).color), bg), bg).toFixed(2)}:1]`;
    });
  add("접근성", "13px 미만 글자", "mid", textEls.filter((el) => parseFloat(st(el).fontSize) < 13), "보조 글자도 13px부터", (el) => ` [${st(el).fontSize}]`);
  if (phone)
    add("접근성", "터치 영역 44px 미만", "mid",
      shown.filter((el) => {
        if (!(/^(A|BUTTON|SELECT)$/.test(el.tagName) || el.getAttribute("role") === "button" || (el.tagName === "INPUT" && !/hidden|radio|checkbox/.test(el.type)))) return false;
        if (el.tagName === "A" && el.closest("p, li, td, dd, blockquote")) return false; // links inside running text
        if (st(el).display === "inline") return false;
        const after = getComputedStyle(el, "::after");
        if (after.content !== "none" && parseFloat(after.height) >= 44) return false; // hit area extended
        return rect(el).height < 44;
      }),
      "보이는 크기가 작으면 안쪽 여백이나 ::after로 손가락 자리를 44px까지", (el) => ` [${Math.round(rect(el).height)}px]`);

  return { findings, fonts, elements: shown.length };
}

// ── page steps ──────────────────────────────────────────────────────────────
async function settle(page) {
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // scroll once so lazy images and reveal-on-scroll blocks appear, then back to the top
  await page.evaluate(async () => {
    const step = Math.max(200, innerHeight * 0.8);
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 40; y += step, i++) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.waitForTimeout(700);
}

// Tab through the first stops; a stop whose look does not change when focused has no visible focus.
async function focusCheck(page) {
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  const bad = [];
  let stops = 0;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(80);
    const r = await page.evaluate((i) => {
      const snap = (el) => {
        const s = getComputedStyle(el);
        return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.backgroundColor, s.borderTopColor, s.color, s.textDecorationLine].join("|");
      };
      let prev = null;
      const p = document.querySelector(`[data-anti-slop-focus="${i - 1}"]`);
      if (p) prev = { same: snap(p) === p.dataset.antiSlopSnap, label: p.dataset.antiSlopLabel };
      const a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement || a.hasAttribute("data-anti-slop-focus")) return { prev, cur: false };
      a.setAttribute("data-anti-slop-focus", String(i));
      a.dataset.antiSlopSnap = snap(a);
      a.dataset.antiSlopLabel = `${a.tagName.toLowerCase()} "${(a.innerText || a.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 24)}"`;
      return { prev, cur: true };
    }, i);
    if (r.prev && r.prev.same) bad.push(r.prev.label);
    if (!r.cur) break;
    stops++;
  }
  return { stops, bad };
}

async function measureWidth(browser, url, w, outDir) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  const page = await ctx.newPage();
  const res = { viewport: `${w.viewport.width}×${w.viewport.height}` };
  try {
    await page.goto(url, { waitUntil: "load", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    await settle(page);

    const shot = await page.screenshot({ path: path.join(outDir, `${w.key}.png`) });
    const pix = await browser.newPage();
    await pix.setContent("<!doctype html><title>pixels</title>");
    res.axes = await pix.evaluate(pixelAxes, `data:image/png;base64,${shot.toString("base64")}`);
    await pix.close();

    const dom = await page.evaluate(measureDom, { phone: w.isMobile, clichesKo: CLICHES_KO, clichesEn: CLICHES_EN });
    res.findings = dom.findings;
    res.fonts = dom.fonts;
    res.elements = dom.elements;

    const fullH = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({
      path: path.join(outDir, `${w.key}-full.jpg`), type: "jpeg", quality: 70, fullPage: true,
      ...(fullH > FULL_MAX ? { clip: { x: 0, y: 0, width: w.viewport.width, height: FULL_MAX } } : {}),
    });

    if (!w.isMobile) {
      const f = await focusCheck(page);
      res.focusStops = f.stops;
      if (f.bad.length)
        res.findings.push({ group: "접근성", rule: "키보드 포커스가 안 보임", level: "mid", count: f.bad.length, where: f.bad.slice(0, 4),
          hint: `Tab으로 ${f.stops}곳을 지나며 봤다. outline을 지우지 말고, 지웠으면 :focus-visible에 다른 표시를 둔다` });
    }
  } catch (e) {
    res.error = String(e?.message || e).split("\n")[0].slice(0, 200);
  }
  await ctx.close();
  return res;
}

// ── main ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const pos = args.filter((a) => !a.startsWith("--"));
if (!pos[0]) {
  console.error("쓰는 법: node check.mjs <URL 또는 page.html> [outDir] [--json]");
  process.exit(2);
}
const isUrl = /^https?:\/\//i.test(pos[0]);
if (!isUrl && !fs.existsSync(path.resolve(pos[0]))) {
  console.error(`파일이 없습니다: ${pos[0]}`);
  process.exit(2);
}
const url = isUrl ? pos[0] : pathToFileURL(path.resolve(pos[0])).href;
const outDir = path.resolve(pos[1] ?? "anti-slop-out");
fs.mkdirSync(outDir, { recursive: true });

const browser = await launch();
const widths = {};
for (const w of WIDTHS) widths[w.key] = await measureWidth(browser, url, w, outDir);
await browser.close();

// merge the two widths by rule
const merged = new Map();
for (const w of WIDTHS)
  for (const f of widths[w.key].findings || []) {
    const key = `${f.group}|${f.rule.replace(/ \(\d+%\)$/, "")}`;
    const m = merged.get(key) || { group: f.group, rule: f.rule, level: f.level, hint: f.hint, by: {} };
    if (f.level === "high") m.level = "high";
    m.by[w.key] = { count: f.count, where: f.where };
    merged.set(key, m);
  }
const findings = [...merged.values()].sort((p, q) => GROUPS.indexOf(p.group) - GROUPS.indexOf(q.group) || (p.level === "high" ? -1 : 1) - (q.level === "high" ? -1 : 1));
const fire = Math.max(...WIDTHS.map((w) => widths[w.key].axes?.fire ?? 0));
const look = findings.filter((f) => f.group !== "접근성");
const failed = WIDTHS.filter((w) => widths[w.key].error);
const verdict = {
  measured: WIDTHS.length - failed.length,
  fire,
  surfaces: fire >= 4 ? "강함" : fire >= 3 ? "후보" : "낮음",
  high: look.filter((f) => f.level === "high").length,
  mid: look.filter((f) => f.level === "mid").length,
  a11yHigh: findings.filter((f) => f.group === "접근성" && f.level === "high").length,
  a11yMid: findings.filter((f) => f.group === "접근성" && f.level === "mid").length,
};
const report = { target: pos[0], measuredAt: new Date().toISOString(), verdict, widths, findings };
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  const n = (v) => (typeof v === "number" ? String(v) : "-");
  console.log(`\nanti-slop · ${pos[0]}\n`);
  console.log("표면 효과 — 첫 화면 픽셀 (켜진 축에 *)");
  for (const w of WIDTHS) {
    const r = widths[w.key];
    if (r.error) {
      console.log(`  ${w.label} ${r.viewport}  ! ${r.error}`);
      continue;
    }
    const a = r.axes, star = (k) => (a.on.includes(k) ? "*" : "");
    console.log(`  ${w.label} ${r.viewport}  fire ${a.fire}/5 · ramp ${n(a.ramp)}${star("ramp")} · hue_travel ${n(a.hue_travel)}${star("hue_travel")} · sat_share ${n(a.sat_share)}${star("sat_share")} (cdetail ${n(a.cdetail)}) · hue_n ${a.hue_n}${star("hue_n")} · glow ${n(a.glow)}${star("glow")}`);
  }
  if (failed.length === WIDTHS.length) {
    console.log("\n측정하지 못했습니다 — 주소가 열리는지(개발 서버가 켜져 있는지, 로그인이 필요한지) 확인하세요.\n");
    process.exit(2);
  }
  console.log(`  판정: 겹침 ${verdict.surfaces} (fire ≥ 3 후보 · ≥ 4 강함)`);
  let group = "";
  for (const f of findings) {
    if (f.group !== group) console.log(`\n[${(group = f.group)}]`);
    const counts = WIDTHS.filter((w) => f.by[w.key]).map((w) => `${w.label} ${f.by[w.key].count}`).join(" · ");
    console.log(`  ${f.level === "high" ? "중요" : "보통"}  ${f.rule} — ${counts}`);
    const where = (f.by.pc || f.by.phone).where;
    console.log(`        ${where.join(" / ")}`);
    console.log(`        → ${f.hint}`);
  }
  const fonts = (widths.pc.fonts || widths.phone.fonts || []).slice(0, 4).map((f) => `${f.name} ${Math.round(f.share * 100)}%`).join(" · ");
  if (fonts) console.log(`\n글꼴(PC, 글자 수 비율): ${fonts}`);
  console.log(`\n요약: fire ${fire}/5 · 중요 ${verdict.high} · 보통 ${verdict.mid} (접근성 따로: 중요 ${verdict.a11yHigh} · 보통 ${verdict.a11yMid})`);
  console.log(`→ ${outDir}/report.json · pc.png · phone.png · pc-full.jpg · phone-full.jpg\n`);
}
process.exit(failed.length === WIDTHS.length ? 2 : fire >= 3 || verdict.high ? 1 : 0);
