#!/usr/bin/env node
// Check a "바이브코딩 월드컵 출품 양식" sheet before it is pasted into the entry form, and print the block to paste.
//
//   node sheet.mjs sheet.txt                  check a file
//   pbpaste | node sheet.mjs                  check what comes in on stdin
//   node sheet.mjs sheet.txt --block          print only the block (the report goes to stderr when it fails)
//   node sheet.mjs sheet.txt --also "MyApp"   other spellings of the app name, comma-separated
//   node sheet.mjs --blank                    print an empty sheet
//
// The sheet is a title line and one `키: 값` per line. The entry form reads these nine keys and drops everything else:
//
//   [바이브코딩 월드컵 출품 양식]
//   앱 이름: …            1–30 characters, required
//   컨셉 한 줄: …         6–22, required   ┐ shown in the match to everyone — the app name stays out of these three
//   누구의 어떤 문제: …    8–28, required   │
//   어떻게 푸나: …         8–28, required   ┘
//   들어가 볼 주소: …      https://, up to 300, required — a page or store link anyone can open
//   만든 사람: …          up to 30 — left blank, the form keeps the account's display name
//   만든 도구: …          up to 40
//   만든 기간: …          up to 20
//   긴 소개: …            up to 300, on one line
//
// Checks (exit 1 when anything fails)
//   fail  a required field is empty · a field is longer or shorter than its limits
//   fail  the address does not start with https://, is not a URL, or points at this computer
//   fail  the app name (or an --also spelling) or the maker is inside 컨셉 한 줄 · 누구의 어떤 문제 · 어떻게 푸나
//   fail  an address, "www.", a domain or a mail address inside those three lines (the entry form turns these away)
//   fail  the same key filled twice · 긴 소개 running over several lines · a value ending in a count or hint such as "(18자)"
//   warn  lines outside the form · the address's own name inside the three lines · numbers and superlatives to verify
//   warn  누구의 어떤 문제 not ending in "사람" · 어떻게 푸나 not ending in "니다" (the entry prompt's endings) · 만든 사람 blank
//
// Input may be decorated the way chat models decorate it (code fences, "- " or "**bold**" keys, a full-width colon,
// quotes around a value); the printed block is always the plain form. Lengths are counted in code points after NFC,
// so a Hangul syllable is one character. No dependencies, no network.
import fs from "node:fs";

const TITLE = "[바이브코딩 월드컵 출품 양식]";
// `open` = shown in the match before anyone logs in
const FIELDS = [
  { id: "name", label: "앱 이름", min: 1, max: 30, required: true },
  { id: "concept", label: "컨셉 한 줄", min: 6, max: 22, required: true, open: true },
  { id: "problem", label: "누구의 어떤 문제", min: 8, max: 28, required: true, open: true },
  { id: "solution", label: "어떻게 푸나", min: 8, max: 28, required: true, open: true },
  { id: "url", label: "들어가 볼 주소", min: 1, max: 300, required: true },
  { id: "maker", label: "만든 사람", min: 0, max: 30 },
  { id: "tools", label: "만든 도구", min: 0, max: 40 },
  { id: "period", label: "만든 기간", min: 0, max: 20 },
  { id: "about", label: "긴 소개", min: 0, max: 300 },
];
const block = (vals) => [TITLE, ...FIELDS.map((f) => (vals[f.id] ? `${f.label}: ${vals[f.id]}` : `${f.label}:`))].join("\n");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v ?? dflt;
};
if (flag("blank")) {
  console.log(block({}));
  process.exit(0);
}
const ONLY_BLOCK = flag("block");
const also = opt("also", "").split(",").map((s) => s.trim()).filter(Boolean);
const file = argv.find((a) => !a.startsWith("--"));

let text;
try {
  if (file) text = fs.readFileSync(file, "utf8");
  else if (!process.stdin.isTTY) text = fs.readFileSync(0, "utf8");
} catch (e) {
  console.error(`읽지 못했습니다 — ${e.message}`);
  process.exit(2);
}
if (text == null) {
  console.error("쓰는 법: node sheet.mjs sheet.txt [--block] [--also \"다른 표기\"] · 빈 양식: node sheet.mjs --blank · 붙여 넣기: pbpaste | node sheet.mjs");
  process.exit(2);
}

// ── read ────────────────────────────────────────────────────────────────────────────────────────────────────────
const len = (s) => [...s].length;
// "**컨셉 한 줄** (6~22자)" → "컨셉한줄"
const keyOf = (s) => s.replace(/[*_`]/g, "").replace(/\s*[（(][^（()）]*[)）]\s*$/, "").replace(/\s+/g, "");
const BY_KEY = new Map(FIELDS.map((f) => [keyOf(f.label), f]));
const QUOTES = [['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["`", "`"]];
// what a blank sheet leaves behind — read as empty, never as a value
const PLACEHOLDER = /^(?:…+|\.{2,}|[-–—]+|없음|\(없음\)|해당 없음|모름|n\/a|https?:\/\/(?:…+|\.{2,})?)$/i;
function valueOf(s) {
  // invisible format characters (zero-width space, BOM …) — the entry form strips them too
  let v = s.replace(/\p{Cf}/gu, "").trim().replace(/^\*+\s*/, "").replace(/\s*\*+$/, "").trim(); // bold markers left around the value
  for (const [a, b] of QUOTES) {
    if (len(v) >= 2 && v.startsWith(a) && v.endsWith(b)) {
      v = v.slice(a.length, -b.length).trim();
      break;
    }
  }
  v = v.replace(/\s+/g, " ");
  return PLACEHOLDER.test(v) ? "" : v;
}

const vals = {};
const twice = [];
const dropped = []; // lines outside the form — left out of the block
const aboutMore = []; // lines right under 긴 소개 — the rest of an intro that was broken into several lines
let titled = false;
let last = null;
for (const raw of text.replace(/^﻿/, "").normalize("NFC").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || /^(```|~~~)/.test(line)) {
    last = null;
    continue;
  }
  if (line.replace(/[#*>\s[\]【】]/g, "") === "바이브코딩월드컵출품양식") {
    titled = true;
    last = null;
    continue;
  }
  const body = line.replace(/^(?:[-*•]\s+|\d+[.)]\s+|>\s*)+/, "");
  const m = body.match(/^([^:：]{1,40})[:：](.*)$/);
  const f = m && BY_KEY.get(keyOf(m[1]));
  if (!f) {
    (last === "about" ? aboutMore : dropped).push(line);
    continue;
  }
  const v = valueOf(m[2]);
  if (vals[f.id] && v) twice.push(f.label); // a placeholder line followed by the real one is not a repeat
  else if (v || !(f.id in vals)) vals[f.id] = v;
  last = f.id;
}

// ── check ───────────────────────────────────────────────────────────────────────────────────────────────────────
const fails = [];
const warns = [];
const missing = [];
const rows = FIELDS.map((f) => {
  const v = vals[f.id] ?? "";
  const n = len(v);
  let note = "";
  if (!n) {
    if (f.required) {
      note = "✗ 비어 있음";
      missing.push(f.label);
    } else note = "비움";
  } else if (n > f.max) {
    note = `✗ ${n - f.max}자 넘침`;
    fails.push(`${f.label} — ${n}자입니다. ${f.max}자 안으로 줄입니다(${n - f.max}자 넘침)`);
  } else if (n < f.min) {
    note = `✗ ${f.min - n}자 모자람`;
    fails.push(`${f.label} — ${n}자입니다. ${f.min}자부터입니다`);
  }
  return { f, n, note };
});

if (missing.length) fails.unshift(`필수 칸이 비었습니다: ${missing.join(" · ")} — 프로젝트에서 못 찾았으면 지어 채우지 말고 사용자에게 묻습니다`);
for (const label of new Set(twice)) fails.push(`${label} — 같은 칸이 두 번 나옵니다. 하나만 남깁니다`);
if (aboutMore.length) fails.push(`긴 소개 — 여러 줄로 나뉘어 있습니다(아래 ${aboutMore.length}줄). 양식은 칸마다 한 줄이니 한 줄로 잇습니다`);
// "(18자)" · "(6~22자 · 앱 이름을 넣지 않는다)" — a count or the form's own hint copied onto the end of a value
for (const f of FIELDS) {
  const m = (vals[f.id] ?? "").match(/[（(][^（()）]*\d\s*자[^（()）]*[)）]$/);
  if (m) fails.push(`${f.label} — 값 끝의 "${m[0]}"를 지웁니다. 괄호 설명 · 글자 수 표기까지 그대로 화면에 나갑니다`);
}

// the address: https, a real host, not this computer
const url = vals.url ?? "";
let host = "";
if (url) {
  let why = null;
  let u = null;
  if (/\s/.test(url)) why = "주소 안에 빈칸이 있습니다";
  else if (!/^https:\/\//i.test(url)) why = "https://로 시작해야 합니다";
  else {
    try {
      u = new URL(url);
    } catch {
      why = "주소로 읽히지 않습니다";
    }
  }
  if (u) {
    host = u.hostname.toLowerCase();
    const ip = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
    const here = host === "localhost" || /\.(local|localhost|test|internal|invalid|example)$/.test(host) || /^example\.(com|org|net)$/.test(host);
    const inside = host.startsWith("[") || (ip && (ip[1] === "127" || ip[1] === "10" || ip[1] === "0" || (ip[1] === "192" && ip[2] === "168") || (ip[1] === "172" && ip[2] >= 16 && ip[2] <= 31)));
    if (u.username || u.password) why = "주소에 계정 정보가 들어 있습니다";
    else if (here || inside) why = "내 컴퓨터나 예시 주소입니다. 누구나 들어가 볼 수 있는 주소나 스토어 링크를 적습니다";
    else if (!ip && !/^[^.]+(\.[^.]+)*\.([a-z]{2,}|xn--[a-z0-9-]+)$/.test(host)) why = "도메인 꼴이 아닙니다";
    else if (ip) warns.push("들어가 볼 주소 — IP 주소입니다. 도메인이나 스토어 링크가 있으면 그쪽을 적습니다");
    else if (/(^|\.)(github\.com|gitlab\.com)$/.test(host)) warns.push("들어가 볼 주소 — 저장소 주소로 보입니다. 앱이 열리는 주소나 스토어 링크를 적고, 저장소는 등록 화면의 저장소 칸에 넣습니다");
    else if (/(ngrok|trycloudflare\.com|loca\.lt|localhost\.run)/.test(host)) warns.push("들어가 볼 주소 — 임시 터널 주소로 보입니다. 꺼지면 아무도 들어가 볼 수 없습니다");
  }
  if (why) fails.push(`들어가 볼 주소 — ${why}`);
}

// the app name stays out of the three lines everyone sees
const squash = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const names = [vals.name, ...also].filter(Boolean).map((s) => ({ shown: s, key: squash(s) }));
if (vals.name && len(squash(vals.name)) < 2) warns.push("앱 이름이 한 글자라 컨셉 · 문제 · 해결에 들어갔는지 기계로 못 가립니다. 직접 봅니다");
// the first label of the app's own address is usually the name in Latin letters (myapp.kr → myapp)
const hostName = host && !/(^|\.)(apple\.com|google\.com|microsoft\.com|samsung\.com|onestore\.co\.kr|onestore\.net|galaxy\.store|github\.com|gitlab\.com)$/.test(host) ? host.replace(/^www\./, "").split(".")[0] : "";
for (const f of FIELDS.filter((x) => x.open)) {
  const v = squash(vals[f.id] ?? "");
  if (!v) continue;
  const hit = names.find((nm) => len(nm.key) >= 2 && v.includes(nm.key));
  if (hit) fails.push(`${f.label} — 앱 이름("${hit.shown}")이 들어 있습니다. 대결 화면에서는 이름을 가리니 이름 없이 씁니다`);
  else if (len(hostName) >= 3 && v.includes(squash(hostName))) warns.push(`${f.label} — 주소의 "${hostName}"이 들어 있습니다. 앱 이름의 다른 표기라면 뺍니다`);
  const maker = squash(vals.maker ?? "");
  if (len(maker) >= 2 && v.includes(maker)) fails.push(`${f.label} — 만든 사람("${vals.maker}")이 들어 있습니다. 대결 화면에서는 누가 만들었는지도 가리니 빼고 씁니다`);
}

// an address or a mail address in the three lines — the entry form refuses the field (same test as the site, full-width folded)
const TLDS = "kr|com|net|org|io|app|dev|me|ai|co|xyz|site|page|link|shop|store|ly|gg|tv|be|fm|cc|info|biz|club|online|tech|cloud|run|sh|one|pro|blog|work|live|news|today|jp|cn|uk|us|example|invalid|test";
const LINKISH = new RegExp(`https?://|www\\.[a-z0-9가-힣]|[a-z0-9가-힣][a-z0-9가-힣-]*\\.(?:${TLDS})(?![a-z0-9-])|[^\\s@]@[^\\s@]+\\.[^\\s@]`);
for (const f of FIELDS.filter((x) => x.open)) {
  const s = (vals[f.id] ?? "").normalize("NFKC").toLowerCase();
  const m = s.match(LINKISH);
  if (!m) continue;
  const word = s.slice(s.lastIndexOf(" ", m.index) + 1).split(" ")[0]; // the whole word around the hit
  fails.push(`${f.label} — 주소나 메일 꼴("${word}")이 들어 있습니다. 등록 화면이 이 칸을 받지 않으니 빼고 씁니다`);
}

// the entry prompt ends these two the same way, so the cards read alike side by side
const tail = (s) => s.replace(/[\s.!?。…]+$/, "");
if (vals.problem && !/사람$/.test(tail(vals.problem))) warns.push(`누구의 어떤 문제 — "~하는 사람"으로 끝냅니다. 직업 이름보다 그 사람이 겪는 상황으로 씁니다`);
if (vals.solution && !/니다$/.test(tail(vals.solution))) warns.push(`어떻게 푸나 — "~합니다"로 끝냅니다. 쓰는 사람이 무엇을 하면 무엇이 되는지 씁니다`);
if (!vals.maker) warns.push("만든 사람 — 비어 있습니다. 비워 두면 등록 화면이 로그인한 계정의 표시 이름을 그대로 씁니다. 다른 이름으로 나가려면 사용자에게 묻고 적습니다");

// things only the maker can verify
const digits = [];
const hype = [];
for (const f of FIELDS.filter((x) => x.open || x.id === "about")) {
  const v = vals[f.id] ?? "";
  const d = v.match(/\d[\d,.]*/g);
  if (d) digits.push(`${f.label}(${[...new Set(d)].join(" · ")})`);
  const h = v.match(/최초|유일|완벽|최고|혁신|1위|무조건|보장|100\s*%/g);
  if (h) hype.push(`${f.label}(${[...new Set(h)].join(" · ")})`);
}
if (digits.length) warns.push(`숫자가 든 칸: ${digits.join(" · ")} — 프로젝트에 근거가 있는 값인지 봅니다. 지어낸 숫자는 뺍니다`);
if (hype.length) warns.push(`확인하기 어려운 표현: ${hype.join(" · ")} — 근거가 없으면 뺍니다`);
if (dropped.length) warns.push(`양식 밖의 줄 ${dropped.length}개(블록에 넣지 않습니다) — ${dropped.slice(0, 3).map((l) => `"${len(l) > 24 ? [...l].slice(0, 24).join("") + "…" : l}"`).join(" · ")}${dropped.length > 3 ? " …" : ""}`);
if (!titled) warns.push(`첫 줄 ${TITLE}이 없습니다 — 출력하는 블록에는 넣습니다`);

// ── report ──────────────────────────────────────────────────────────────────────────────────────────────────────
const wide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch);
const pad = (s, w) => s + " ".repeat(Math.max(0, w - [...s].reduce((n, ch) => n + (wide(ch) ? 2 : 1), 0)));
const out = fails.length && ONLY_BLOCK ? console.error : console.log;
if (!ONLY_BLOCK || fails.length) {
  for (const { f, n, note } of rows) {
    const limit = f.min > 1 ? `${f.min}~${f.max}자` : `${f.max}자 안`;
    out(`${pad(f.label, 18)}${String(n).padStart(3)}자 / ${pad(limit, 10)}${pad(f.open ? "대결에 보임" : "", 13)}${note}`.trimEnd());
  }
  for (const f of fails) out(`  ✗ ${f}`);
  for (const w of warns) out(`  ! ${w}`);
}
if (fails.length) {
  out(`\n실패 ${fails.length} — 고친 뒤 다시 검사하세요.`);
  process.exit(1);
}
if (!ONLY_BLOCK) console.log(`\n통과 — 아래 블록을 그대로 붙여 넣으세요.${warns.length ? `  (경고 ${warns.length}개는 읽고 판단)` : ""}\n`);
console.log(block(vals));
