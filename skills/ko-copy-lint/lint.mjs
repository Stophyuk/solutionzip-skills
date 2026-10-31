#!/usr/bin/env node
// Lint the Korean words people will read — landing pages, app screens, posts, mails.
//
//   node lint.mjs [path…]            (default: the current folder; folders are walked)
//   node lint.mjs --json [path…]     machine-readable result
//   node lint.mjs --strict [path…]   exit 1 on warnings too
//   echo "문장" | node lint.mjs -    read stdin
//
// Reads only text a reader sees: string literals and JSX text in .js/.jsx/.ts/.tsx (comments skipped),
// text outside tags/<script>/<style> in .html, the body of .md/.mdx/.txt. Only segments with Hangul are checked.
//
// Kinds (fail → exit 1; warn → exit 0 unless --strict):
//   banned — fail: a word from copy-lint.json "banned" (project rules, old names, words that must never ship)
//   hype   — warn: superlatives · guarantees · rankings nobody can check (skipped in a "we do not …" sentence)
//   stock  — warn: empty template phrases
//   dash   — warn: an em dash in reader-facing text (off with "allowDash": true)
//   long   — warn: a sentence over 80 characters
//
// copy-lint.json (optional, in the current folder or any parent):
//   { "banned": ["옛 이름", "사장님"], "allow": ["다양한"], "allowDash": false, "ignore": ["legal/"] }
import fs from "node:fs";
import path from "node:path";
import { HYPE, STOCK, DASH, LONG_SENTENCE, NEGATION } from "./words.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const targets = args.filter((a) => !a.startsWith("--"));
if (!targets.length) targets.push(".");

const HANGUL = /[가-힣]/;
const EXT = /\.(jsx?|tsx?|mjs|html?|mdx?|txt)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", ".next", "dist", "build", "out", ".turbo", "coverage"]);

function findConfig(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const f = path.join(d, "copy-lint.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    if (path.dirname(d) === d) return {};
  }
}
const config = findConfig(process.cwd());
const allow = new Set(config.allow || []);
const banned = (config.banned || []).map((w) => [w, new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")]);
const ignore = config.ignore || [];

function walk(p, out) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    if (SKIP_DIR.has(path.basename(p))) return;
    for (const f of fs.readdirSync(p)) walk(path.join(p, f), out);
  } else if (EXT.test(p) && !ignore.some((i) => p.includes(i))) out.push(p);
}

// Returns [{ line, text }] — the reader-facing pieces of one file.
function piecesOf(file, src) {
  if (/\.(jsx?|tsx?|mjs)$/i.test(file)) return codePieces(src);
  if (/\.html?$/i.test(file)) return htmlPieces(src);
  return proseLines(src.replace(/^---\n[\s\S]*?\n---\n/, (m) => m.replace(/[^\n]/g, " ")));
}

function proseLines(src) {
  return src.split("\n").map((text, i) => ({ line: i + 1, text })).filter((p) => HANGUL.test(p.text));
}

function htmlPieces(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  const bare = src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, blank)
    .replace(/<[^>]*>/g, blank);
  return proseLines(bare);
}

// A small scanner: string literals (', ", `) and JSX text between > and <, skipping // and /* */ comments.
function codePieces(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let buf = "";
  let bufLine = 1;
  const flush = () => {
    if (HANGUL.test(buf)) out.push({ line: bufLine, text: buf.replace(/\s+/g, " ").trim() });
    buf = "";
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "\n") line++;
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      bufLine = line;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          buf += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (src[i] === "\n") {
          if (c !== "`") break; // unterminated '…' or "…" (an apostrophe in JSX text) — give up on it
          line++;
        }
        buf += src[i];
        i++;
      }
      i++;
      flush();
      continue;
    }
    if (c === ">") {
      // JSX text runs until the next tag or expression
      let j = i + 1;
      let t = "";
      let l = line;
      while (j < src.length && src[j] !== "<" && src[j] !== "{" && src[j] !== "}" && src[j] !== ";") {
        if (src[j] === "\n") l++;
        t += src[j];
        j++;
      }
      if (HANGUL.test(t) && (src[j] === "<" || src[j] === "{")) {
        bufLine = line;
        buf = t;
        flush();
        line = l;
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

function sentences(text) {
  return text.split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function check(file, pieces) {
  const hits = [];
  const add = (kind, level, word, p, s) => hits.push({ file, line: p.line, kind, level, word, text: s.slice(0, 100) });
  for (const p of pieces) {
    for (const s of sentences(p.text)) {
      for (const [w, re] of banned) if (re.test(s)) add("banned", "fail", w, p, s);
      const negated = NEGATION.test(s);
      for (const [w, re] of HYPE) if (!allow.has(w) && re.test(s) && !negated) add("hype", "warn", w, p, s);
      for (const [w, re] of STOCK) if (!allow.has(w) && re.test(s)) add("stock", "warn", w, p, s);
      if (!config.allowDash && DASH.test(s)) add("dash", "warn", "—", p, s);
      if (s.length > LONG_SENTENCE && HANGUL.test(s)) add("long", "warn", `${s.length}자`, p, s);
    }
  }
  return hits;
}

const files = [];
let hits = [];
for (const t of targets) {
  if (t === "-") {
    hits = hits.concat(check("(stdin)", proseLines(fs.readFileSync(0, "utf8"))));
    continue;
  }
  walk(t, files);
}
for (const f of files) hits = hits.concat(check(f, piecesOf(f, fs.readFileSync(f, "utf8"))));

const fails = hits.filter((h) => h.level === "fail").length;
const warns = hits.length - fails;
if (asJson) {
  console.log(JSON.stringify({ files: files.length, fails, warns, hits }, null, 2));
} else {
  for (const h of hits) console.log(`${h.level === "fail" ? "✗" : "△"} ${h.file}:${h.line} [${h.kind}] ${h.word} — ${h.text}`);
  console.log(`\n파일 ${files.length}개 · 실패 ${fails} · 경고 ${warns}`);
}
process.exit(fails || (strict && warns) ? 1 : 0);
