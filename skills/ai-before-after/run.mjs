#!/usr/bin/env node
// Run an AI feature over a fixed set of samples and write one JSON line per sample —
// the "before" or the "after" half of a comparison (compare.mjs reads two of these).
//
//   node run.mjs <module.mjs> <samples.jsonl> <out.jsonl> [options]
//
//   --mock              do not call the module's predict(). Use its `mock` export, else a built-in
//                       stand-in (label from input length, text = start of the input). The stand-in only
//                       proves that the files and the table work — it says nothing about quality.
//   --mock-file f.mjs   like --mock, but call f.mjs's predict (a fake model you wrote for this feature)
//   --concurrency 4     calls in flight at once
//   --retries 2         extra tries after a thrown error or a timeout (waits 0.5s, 1s, 2s …)
//   --timeout 60000     ms per try; a try that runs over counts as an error (the late call is not
//                       cancelled — a paid call may still finish and bill)
//   --limit N           first N samples only (one real call before paying for all of them)
//   --dry               load everything, print the sample count and input size, call nothing
//   --force             overwrite <out.jsonl> if it already has lines (it refuses by default, so a
//                       re-run after the code change cannot silently replace the "before" baseline)
//
// The module exports `async function predict(input, ctx)` and returns a string or a JSON-able object.
//   ctx.real   true only when the REAL=1 environment variable is set. Call the paid model only then;
//              otherwise use a fake model, so a run costs nothing until someone switches it on.
//   ctx.usage  call ctx.usage({ in, out }) with token counts (summed over retries); compare.mjs adds them up.
//   ctx.id     the sample id.
//
// Sample line:  {"id":"s01","input":"…","label":"…"}   label is optional — the right answer, when known.
// Out line:     {"id","input","label"?,"output","ok","error"?,"ms","tries","usage"?}
// Lines are appended as each call finishes (a crash keeps what is done), then rewritten in sample order.
// <out>.meta.json records the module, the mode, the git commit and a hash of the samples, so that
// compare.mjs can tell whether both halves saw the same samples the same way.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const USAGE = "쓰는 법: node run.mjs <module.mjs> <samples.jsonl> <out.jsonl> [--mock | --mock-file f.mjs] [--concurrency 4] [--retries 2] [--timeout 60000] [--limit N] [--dry] [--force]";

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { mock: false, mockFile: null, concurrency: 4, retries: 2, timeout: 60000, limit: 0, dry: false, force: false };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const num = () => {
    const v = Number(argv[++i]);
    if (!Number.isFinite(v) || v < 0) fail(`${a} 뒤에는 0 이상의 숫자가 와야 합니다.`);
    return v;
  };
  if (a === "--mock") opt.mock = true;
  else if (a === "--mock-file") {
    opt.mock = true;
    opt.mockFile = argv[++i];
    if (!opt.mockFile) fail("--mock-file 뒤에 파일 경로가 와야 합니다.");
  } else if (a === "--concurrency") opt.concurrency = Math.max(1, Math.floor(num()));
  else if (a === "--retries") opt.retries = Math.floor(num());
  else if (a === "--timeout") opt.timeout = num();
  else if (a === "--limit") opt.limit = Math.floor(num());
  else if (a === "--dry") opt.dry = true;
  else if (a === "--force") opt.force = true;
  else if (a.startsWith("--")) fail(`모르는 옵션: ${a}\n${USAGE}`);
  else pos.push(a);
}
if (pos.length !== 3) fail(USAGE);
const [modPath, samplesPath, outPath] = pos.map((p) => path.resolve(p));
const REAL = process.env.REAL === "1";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---- samples ----------------------------------------------------------------------------------
function readJsonl(file) {
  if (!fs.existsSync(file)) fail(`파일이 없습니다: ${file}`);
  const rows = [];
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push({ row: JSON.parse(line), line: i + 1 });
    } catch {
      fail(`${path.basename(file)} ${i + 1}번째 줄이 JSON이 아닙니다.`);
    }
  });
  return rows;
}

let samples = readJsonl(samplesPath).map(({ row, line }) => {
  if (!("input" in row)) fail(`${line}번째 줄에 "input" 칸이 없습니다.`);
  return { id: row.id != null ? String(row.id) : `L${line}`, input: row.input, ...("label" in row ? { label: row.label } : {}) };
});
const dup = samples.map((s) => s.id).filter((id, i, all) => all.indexOf(id) !== i);
if (dup.length) fail(`id가 겹칩니다: ${[...new Set(dup)].join(", ")}`);
if (opt.limit) samples = samples.slice(0, opt.limit);
if (!samples.length) fail("표본이 0건입니다.");

const textLen = (v) => [...(typeof v === "string" ? v : JSON.stringify(v))].length;
const totalChars = samples.reduce((n, s) => n + textLen(s.input), 0);

// ---- what to call -----------------------------------------------------------------------------
async function load(file) {
  if (!fs.existsSync(file)) fail(`모듈이 없습니다: ${file}`);
  return import(pathToFileURL(file).href);
}

// Built-in stand-in: deterministic, echoes the input, invents nothing.
function standIn(input) {
  const s = typeof input === "string" ? input : JSON.stringify(input);
  const n = [...s].length;
  return { label: n < 15 ? "short" : n < 40 ? "medium" : "long", text: [...s].slice(0, 30).join("") };
}

let call;
let mode;
if (opt.mockFile) {
  mode = "mock";
  const m = await load(path.resolve(opt.mockFile));
  call = m.predict ?? m.mock ?? m.default;
  if (typeof call !== "function") fail(`${opt.mockFile}에 predict 함수가 없습니다.`);
} else if (opt.mock) {
  mode = "mock";
  const mod = await load(modPath);
  call = typeof mod.mock === "function" ? mod.mock : standIn;
} else {
  mode = REAL ? "real" : "plain";
  const mod = await load(modPath);
  call = mod.predict ?? mod.default;
  if (typeof call !== "function") fail(`${path.basename(modPath)}에 export async function predict(input, ctx)가 없습니다.`);
}
const callName = opt.mock ? (opt.mockFile ? path.basename(opt.mockFile) : call === standIn ? "기본 모의" : "mock()") : "predict()";

const maxCalls = samples.length * (1 + opt.retries);
console.error(`표본 ${samples.length}건 · 입력 글자 합 ${totalChars} (평균 ${Math.round(totalChars / samples.length)}) · ${callName}`);
if (opt.mock && REAL) console.error("REAL=1이 켜져 있지만 --mock이라 실제 모델은 부르지 않습니다.");
if (mode === "real") console.error(`REAL=1 — 모듈이 실제 모델을 부릅니다. 최대 ${maxCalls}번(재시도 포함).`);
if (opt.dry) {
  console.error("--dry: 아무것도 부르지 않았습니다.");
  process.exit(0);
}

// ---- run --------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(s, usage) {
  let timer;
  const add = (u) => {
    for (const [k, v] of Object.entries(u ?? {})) if (typeof v === "number") usage[k] = (usage[k] ?? 0) + v;
  };
  const ctx = { id: s.id, real: mode === "real", usage: add };
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`시간 초과 ${opt.timeout}ms`)), opt.timeout);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => call(s.input, ctx)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runOne(s) {
  let lastErr;
  const usage = {}; // summed over every try — a failed try can cost tokens too
  for (let k = 0; k <= opt.retries; k++) {
    if (k) await sleep(500 * 2 ** (k - 1));
    const t0 = performance.now();
    try {
      const out = await once(s, usage);
      const ms = Math.round(performance.now() - t0);
      const output = out === undefined ? null : JSON.parse(JSON.stringify(out));
      return { ...s, output, ok: true, ms, tries: k + 1, ...(Object.keys(usage).length ? { usage } : {}) };
    } catch (e) {
      lastErr = { e, ms: Math.round(performance.now() - t0) };
    }
  }
  const msg = String(lastErr.e?.message ?? lastErr.e).slice(0, 300);
  return { ...s, output: null, ok: false, error: msg, ms: lastErr.ms, tries: opt.retries + 1, ...(Object.keys(usage).length ? { usage } : {}) };
}

if (!opt.force && fs.existsSync(outPath) && fs.readFileSync(outPath, "utf8").trim()) {
  fail(`결과 파일이 이미 있습니다: ${path.basename(outPath)} — 기준선을 덮어쓰지 않게 멈춥니다. 다른 이름을 쓰거나 --force.`);
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, "");
const done = new Map();
const started = Date.now();
let next = 0;
async function worker() {
  while (next < samples.length) {
    const s = samples[next++];
    const r = await runOne(s);
    done.set(s.id, r);
    fs.appendFileSync(outPath, JSON.stringify(r) + "\n");
    if (done.size % 10 === 0 && done.size < samples.length) console.error(`  ${done.size}/${samples.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(opt.concurrency, samples.length) }, worker));
const wallMs = Date.now() - started;

// rewrite in sample order so two runs line up when read side by side
fs.writeFileSync(outPath, samples.map((s) => JSON.stringify(done.get(s.id))).join("\n") + "\n");

// ---- meta -------------------------------------------------------------------------------------
function git(args) {
  try {
    return execFileSync("git", args, { cwd: path.dirname(modPath), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}
const sha = git(["rev-parse", "--short", "HEAD"]);
const dirty = sha ? git(["status", "--porcelain"]) : null;
const hash = crypto.createHash("sha256").update(JSON.stringify(samples.map((s) => [s.id, s.input, s.label ?? null]))).digest("hex").slice(0, 12);
const failed = [...done.values()].filter((r) => !r.ok).length;
const shown = (p) => {
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith("..") ? rel : p;
};
const meta = {
  module: opt.mockFile ? null : shown(modPath),
  mockFile: opt.mockFile ? shown(path.resolve(opt.mockFile)) : null,
  call: callName,
  mode,
  commit: sha ? sha + (dirty ? "+dirty" : "") : null,
  samples: shown(samplesPath),
  samplesHash: hash,
  count: samples.length,
  limit: opt.limit || null,
  concurrency: opt.concurrency,
  retries: opt.retries,
  timeout: opt.timeout,
  failed,
  wallMs,
  startedAt: new Date(started).toISOString(),
  node: process.version,
};
fs.writeFileSync(outPath + ".meta.json", JSON.stringify(meta, null, 2) + "\n");

console.error(`${samples.length}건 · 실패 ${failed} · ${(wallMs / 1000).toFixed(1)}초 → ${shown(outPath)}`);
