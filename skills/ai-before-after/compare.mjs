#!/usr/bin/env node
// Compare two runs of run.mjs — before and after a change — and print one Markdown report.
//
//   node compare.mjs <before.jsonl> <after.jsonl> [options]
//
//   --schema s.json   check each output against a small JSON Schema subset (type · enum · required ·
//                     properties · additionalProperties · items · minLength · maxLength · minItems ·
//                     maxItems · minimum · maximum). A string output is read as JSON first (```json fences
//                     are stripped); a string that is not JSON fails an object or array schema.
//   --pred label      where the predicted label sits in the output (dotted path). "." = the whole output.
//   --text reply      which output field is the text to measure. Default: every string and number in the
//                     output except the --pred field.
//   --ban words.txt   one pattern per line, read as a case-insensitive regex (# starts a comment)
//   --show s03,s07    also print input · before · after for these ids — read a few, never the whole file
//   --max-ids 30      ids listed per line before "… more"
//
// Without labels it measures only what needs no labels: count · failures · empty outputs · format
// violations · length · label distribution · outputs that changed (with ids) · numbers and Latin-letter
// words in the output that the input does not contain (one cause is a made-up fact — read those ids) ·
// banned patterns · time · tokens. Accuracy is printed only over samples that carry a "label"; with none,
// the table says so instead of a number. Only ids present in both files are compared.
import fs from "node:fs";
import path from "node:path";

const USAGE = "쓰는 법: node compare.mjs <before.jsonl> <after.jsonl> [--schema s.json] [--pred label] [--text field] [--ban words.txt] [--show id,id] [--max-ids 30]";

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { schema: null, pred: "label", text: null, ban: null, show: [], maxIds: 30 };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    const v = argv[++i];
    if (v === undefined) fail(`${a} 뒤에 값이 와야 합니다.`);
    return v;
  };
  if (a === "--schema") opt.schema = val();
  else if (a === "--pred") opt.pred = val();
  else if (a === "--text") opt.text = val();
  else if (a === "--ban") opt.ban = val();
  else if (a === "--show") opt.show = val().split(",").map((s) => s.trim()).filter(Boolean);
  else if (a === "--max-ids") opt.maxIds = Math.max(1, Number(val()) || 30);
  else if (a.startsWith("--")) fail(`모르는 옵션: ${a}\n${USAGE}`);
  else pos.push(a);
}
if (pos.length !== 2) fail(USAGE);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---- read -------------------------------------------------------------------------------------
function readRun(file) {
  if (!fs.existsSync(file)) fail(`파일이 없습니다: ${file}`);
  const rows = new Map();
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      fail(`${path.basename(file)} ${i + 1}번째 줄이 JSON이 아닙니다.`);
    }
    rows.set(String(r.id), r);
  });
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(file + ".meta.json", "utf8"));
  } catch {}
  return { file, rows, meta };
}

const A = readRun(pos[0]);
const B = readRun(pos[1]);
const ids = [...A.rows.keys()].filter((id) => B.rows.has(id));
const onlyA = [...A.rows.keys()].filter((id) => !B.rows.has(id));
const onlyB = [...B.rows.keys()].filter((id) => !A.rows.has(id));
if (!ids.length) fail("두 파일에 같은 id가 하나도 없습니다 — 같은 표본으로 돌렸는지 확인하세요.");

let schema = null;
if (opt.schema) {
  try {
    schema = JSON.parse(fs.readFileSync(opt.schema, "utf8"));
  } catch (e) {
    fail(`스키마를 읽지 못했습니다: ${e.message}`);
  }
}
let bans = [];
if (opt.ban) {
  bans = fs.readFileSync(opt.ban, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  bans = bans.map((p) => {
    try {
      return { p, re: new RegExp(p, "i") };
    } catch {
      fail(`금칙어 패턴을 읽지 못했습니다: ${p}`);
    }
  });
}

// ---- helpers ----------------------------------------------------------------------------------
const stable = (v) =>
  v && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
    : JSON.stringify(v ?? null);

function parsed(o) {
  if (typeof o !== "string") return o;
  const t = o.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!/^[[{]/.test(t)) return o;
  try {
    return JSON.parse(t);
  } catch {
    return o;
  }
}

const predPath = opt.pred === "." ? [] : opt.pred.split(".");
function getPath(v, parts) {
  for (const p of parts) {
    if (v == null || typeof v !== "object") return undefined;
    v = v[p];
  }
  return v;
}

function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === "string") return !v.trim();
  if (Array.isArray(v)) return v.every(isEmpty);
  if (typeof v === "object") return Object.values(v).every(isEmpty);
  return false;
}

// strings and numbers of v, skipping the node at `skip` (the label, so "question" is not counted as text)
function leaves(v, skip, at = []) {
  if (skip && at.length === skip.length && at.every((p, i) => p === skip[i])) return [];
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => leaves(x, skip, [...at, k]));
  return [];
}
function textOf(out) {
  if (opt.text) return leaves(getPath(out, opt.text.split("."))).join("\n");
  if (opt.pred === ".") return "";
  return leaves(out, predPath).join("\n");
}

function predOf(out) {
  const v = getPath(out, predPath);
  if (v == null || (typeof v === "string" && !v.trim())) return null;
  return typeof v === "string" ? v.trim() : stable(v);
}
const sameLabel = (p, gold) =>
  p != null && (typeof gold === "string" ? p.toLowerCase() === gold.trim().toLowerCase() : p === stable(gold));

const numbersIn = (s) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
// leading "1. " / "2) " list markers are layout, not facts
const outNumbers = (s) => numbersIn(s.replace(/^\s*\d{1,2}[.)]\s/gm, " "));
const latinIn = (s) => s.match(/[A-Za-z][A-Za-z0-9]+/g) ?? [];
const inputText = (v) => (typeof v === "string" ? v : leaves(v).join("\n"));

function typeMatch(t, v) {
  if (t === "null") return v === null;
  if (t === "array") return Array.isArray(v);
  if (t === "object") return v !== null && typeof v === "object" && !Array.isArray(v);
  if (t === "integer") return Number.isInteger(v);
  return typeof v === t;
}
function check(v, s, at = "$") {
  if (!s || typeof s !== "object") return null;
  if (s.type) {
    const types = [].concat(s.type);
    if (!types.some((t) => typeMatch(t, v))) {
      const got = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
      return `${at}: ${types.join("|")}여야 하는데 ${got}`;
    }
  }
  if (s.enum && !s.enum.some((e) => stable(e) === stable(v))) return `${at}: 허용 값 밖 ${JSON.stringify(v)}`;
  if (typeof v === "string") {
    const n = [...v].length;
    if (s.minLength != null && n < s.minLength) return `${at}: ${n}자 < ${s.minLength}`;
    if (s.maxLength != null && n > s.maxLength) return `${at}: ${n}자 > ${s.maxLength}`;
  }
  if (typeof v === "number") {
    if (s.minimum != null && v < s.minimum) return `${at}: ${v} < ${s.minimum}`;
    if (s.maximum != null && v > s.maximum) return `${at}: ${v} > ${s.maximum}`;
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) return `${at}: ${v.length}개 < ${s.minItems}`;
    if (s.maxItems != null && v.length > s.maxItems) return `${at}: ${v.length}개 > ${s.maxItems}`;
    if (s.items) for (let i = 0; i < v.length; i++) {
      const e = check(v[i], s.items, `${at}[${i}]`);
      if (e) return e;
    }
  } else if (v && typeof v === "object") {
    for (const k of s.required ?? []) if (!(k in v)) return `${at}.${k}: 없음`;
    for (const [k, sub] of Object.entries(s.properties ?? {})) {
      if (!(k in v)) continue;
      const e = check(v[k], sub, `${at}.${k}`);
      if (e) return e;
    }
    if (s.additionalProperties === false) {
      const extra = Object.keys(v).find((k) => !(k in (s.properties ?? {})));
      if (extra) return `${at}.${extra}: 스키마에 없는 칸`;
    }
  }
  return null;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const N = ids.length;
const r0 = (x) => (x == null ? "—" : String(Math.round(x)));
const pct = (n, d = N) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
const cnt = (n, d = N) => (n ? `${n} (${pct(n, d)})` : "0");
const sgn = (x) => (x == null || Number.isNaN(x) ? "" : x > 0 ? `+${Math.round(x)}` : x < 0 ? `−${Math.abs(Math.round(x))}` : "0");
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const cut = (s, n) => ([...s].length > n ? [...s].slice(0, n).join("") + "…" : s);
function list(xs) {
  if (!xs.length) return "없음";
  const head = xs.slice(0, opt.maxIds).join(", ");
  return xs.length > opt.maxIds ? `${head} 외 ${xs.length - opt.maxIds}건` : head;
}

// ---- measure one side -------------------------------------------------------------------------
function measure(run) {
  const m = { failed: [], empty: [], bad: [], lens: [], ms: [], retried: 0, newNum: [], newLatin: [], banned: [], usage: null, pred: new Map(), right: new Set() };
  for (const id of ids) {
    const r = run.rows.get(id);
    if (typeof r.ms === "number") m.ms.push(r.ms);
    if ((r.tries ?? 1) > 1) m.retried++;
    if (r.usage && typeof r.usage === "object") {
      m.usage ??= {};
      for (const [k, v] of Object.entries(r.usage)) if (typeof v === "number") m.usage[k] = (m.usage[k] ?? 0) + v;
    }
    if (!r.ok) {
      m.failed.push(id);
      m.pred.set(id, null);
      continue;
    }
    const out = parsed(r.output);
    if (isEmpty(out)) m.empty.push(id);
    if (schema) {
      const e = check(out, schema);
      if (e) m.bad.push(`${id} (${e})`);
    }
    const text = textOf(out);
    if (text.trim()) m.lens.push([...text].length);
    const inp = inputText(r.input);
    const inNums = new Set(numbersIn(inp));
    const nums = [...new Set(outNumbers(text))].filter((n) => !inNums.has(n));
    if (nums.length) m.newNum.push(`${id}(${cut(nums.join(" "), 30)})`);
    const lowIn = inp.toLowerCase();
    const words = [...new Set(latinIn(text))].filter((w) => !lowIn.includes(w.toLowerCase()));
    if (words.length) m.newLatin.push(`${id}(${cut(words.join(" "), 30)})`);
    if (bans.length) {
      const all = leaves(out).join("\n");
      const hit = bans.find((b) => b.re.test(all));
      if (hit) m.banned.push(`${id}(${cut(hit.p, 20)})`);
    }
    const p = predOf(out);
    m.pred.set(id, p);
    const gold = r.label ?? A.rows.get(id).label;
    if (gold != null && sameLabel(p, gold)) m.right.add(id);
  }
  return m;
}
const a = measure(A);
const b = measure(B);

// ---- report -----------------------------------------------------------------------------------
const out = [];
const say = (s = "") => out.push(s);
const MODE = { mock: "모의", real: "실제 모델(REAL=1)", plain: "REAL 없이" };
function who(run) {
  const name = path.relative(process.cwd(), run.file) || run.file;
  const m = run.meta;
  if (!m) return `\`${name}\` — 설정 기록(.meta.json) 없음`;
  return `\`${name}\` — ${m.call ?? "predict()"} · ${MODE[m.mode] ?? m.mode} · ${m.commit ? `commit ${m.commit}` : "git 없음"} · 표본 ${m.count}건 #${m.samplesHash}${m.failed ? ` · 실패 ${m.failed}` : ""}`;
}
say("## 전 · 후 비교");
say();
say(`- 전: ${who(A)}`);
say(`- 후: ${who(B)}`);
say(`- 견준 표본: ${N}건${onlyA.length || onlyB.length ? ` (전에만 ${onlyA.length} · 후에만 ${onlyB.length} — 빼고 셌다)` : ""}`);

const warn = [];
if (!A.meta || !B.meta) warn.push("설정 기록이 없는 쪽이 있다 — 같은 표본 · 같은 설정인지 확인하지 못했다.");
else {
  if (A.meta.samplesHash !== B.meta.samplesHash) warn.push("표본이 다르다(해시가 다름) — 같은 표본 파일로 다시 떠야 견줄 수 있다.");
  if (A.meta.mode !== B.meta.mode) warn.push(`돌린 방식이 다르다(${MODE[A.meta.mode] ?? A.meta.mode} → ${MODE[B.meta.mode] ?? B.meta.mode}) — 이 표로 품질을 말하지 않는다.`);
  for (const k of ["retries", "timeout", "limit"]) if (A.meta[k] !== B.meta[k]) warn.push(`설정이 다르다 — ${k}: ${A.meta[k] ?? "없음"} → ${B.meta[k] ?? "없음"}`);
}
for (const w of warn) say(`> 주의: ${w}`);
say();

const anyPred = [...a.pred.values(), ...b.pred.values()].some((p) => p != null);
const gold = new Map(ids.map((id) => [id, A.rows.get(id).label ?? B.rows.get(id).label]).filter(([, g]) => g != null));

say("| 항목 | 전 | 후 | 차이 |");
say("|---|--:|--:|--:|");
const row = (k, x, y, d = "") => say(`| ${cell(k)} | ${cell(x)} | ${cell(y)} | ${cell(d)} |`);
row("건수", N, N);
row("실패(에러)", cnt(a.failed.length), cnt(b.failed.length), sgn(b.failed.length - a.failed.length));
row("빈 출력", cnt(a.empty.length), cnt(b.empty.length), sgn(b.empty.length - a.empty.length));
if (schema) row("형식 위반(스키마)", cnt(a.bad.length), cnt(b.bad.length), sgn(b.bad.length - a.bad.length));
else row("형식 위반", "스키마 없음 — 재지 않았다", "", "");
row("길이 평균 · 중앙(글자, 빈 출력 뺌)", `${r0(mean(a.lens))} · ${r0(median(a.lens))}`, `${r0(mean(b.lens))} · ${r0(median(b.lens))}`,
  a.lens.length && b.lens.length ? `${sgn(mean(b.lens) - mean(a.lens))} · ${sgn(median(b.lens) - median(a.lens))}` : "");
row("입력에 없는 숫자가 나온 건", cnt(a.newNum.length), cnt(b.newNum.length), sgn(b.newNum.length - a.newNum.length));
row("입력에 없는 영문 낱말이 나온 건", cnt(a.newLatin.length), cnt(b.newLatin.length), sgn(b.newLatin.length - a.newLatin.length));
if (bans.length) row("금칙어가 나온 건", cnt(a.banned.length), cnt(b.banned.length), sgn(b.banned.length - a.banned.length));
row("걸린 시간 중앙 · 최대(ms)", `${r0(median(a.ms))} · ${r0(a.ms.length ? Math.max(...a.ms) : null)}`, `${r0(median(b.ms))} · ${r0(b.ms.length ? Math.max(...b.ms) : null)}`,
  a.ms.length && b.ms.length ? sgn(median(b.ms) - median(a.ms)) : "");
row("재시도한 건", a.retried, b.retried, sgn(b.retried - a.retried));
if (a.usage || b.usage) {
  const u = (m) => (m ? Object.entries(m).map(([k, v]) => `${k} ${v}`).join(" · ") : "기록 없음");
  row("토큰 합(재시도 포함)", u(a.usage), u(b.usage), "");
}
if (gold.size) {
  const label = gold.size === N ? "정확도" : `정확도(라벨 있는 ${gold.size}/${N}건)`;
  const ra = [...gold.keys()].filter((id) => a.right.has(id)).length;
  const rb = [...gold.keys()].filter((id) => b.right.has(id)).length;
  row(label, `${ra}/${gold.size} (${pct(ra, gold.size)})`, `${rb}/${gold.size} (${pct(rb, gold.size)})`, `${sgn(rb - ra)}건`);
} else row("정확도", "라벨 없음 — 정확도는 재지 않았다", "", "");
say();
if (gold.size) say(`라벨 있는 표본 ${gold.size}건 — 한 건이 ${(100 / gold.size).toFixed(1)}%p다.`);
if (gold.size && !anyPred) say(`출력에서 \`${opt.pred}\` 칸을 찾지 못해 정확도가 0일 수 있다 — 출력 전체가 라벨이면 \`--pred .\`.`);
if (gold.size) say();

// label distribution
if (anyPred) {
  const keys = new Map();
  const tally = (m, side) => {
    for (const id of ids) {
      const failed = m.failed.includes(id);
      const k = failed ? "(실패)" : m.pred.get(id) ?? "(라벨 없음)";
      const c = keys.get(k) ?? [0, 0];
      c[side]++;
      keys.set(k, c);
    }
  };
  tally(a, 0);
  tally(b, 1);
  say(`### 라벨 분포 (\`${opt.pred}\`)`);
  say();
  say("| 라벨 | 전 | 후 | 차이 |");
  say("|---|--:|--:|--:|");
  for (const [k, [x, y]] of [...keys].sort((p, q) => q[1][0] - p[1][0] || q[1][1] - p[1][1])) row(cut(k, 40), x, y, sgn(y - x));
  say();
} else if (opt.pred !== ".") {
  say(`라벨 분포: 출력에 \`${opt.pred}\` 칸이 없어 건너뛰었다(출력 전체가 라벨이면 \`--pred .\`).`);
  say();
}

// what changed
const changed = ids.filter((id) => {
  const x = A.rows.get(id);
  const y = B.rows.get(id);
  return x.ok !== y.ok || stable(x.output) !== stable(y.output);
});
say("### 달라진 표본");
say();
say(`- 출력이 달라진 건: ${changed.length}/${N} — ${list(changed)}`);
if (anyPred) {
  const moved = ids.filter((id) => a.pred.get(id) !== b.pred.get(id)).map((id) => `${id} ${cut(a.pred.get(id) ?? "∅", 20)}→${cut(b.pred.get(id) ?? "∅", 20)}`);
  say(`- 라벨이 바뀐 건: ${moved.length} — ${list(moved)}`);
}
if (gold.size) {
  const fixed = [...gold.keys()].filter((id) => !a.right.has(id) && b.right.has(id));
  const broke = [...gold.keys()].filter((id) => a.right.has(id) && !b.right.has(id));
  say(`- 새로 맞은 건: ${fixed.length} — ${list(fixed)}`);
  say(`- 새로 틀린 건: ${broke.length} — ${list(broke)}`);
}
say();
say("### 살펴볼 표본");
say();
const both = (name, x, y) => say(`- ${name} — 전: ${list(x)} · 후: ${list(y)}`);
both("실패", a.failed, b.failed);
both("빈 출력", a.empty, b.empty);
if (schema) both("형식 위반", a.bad, b.bad);
both("입력에 없는 숫자", a.newNum, b.newNum);
both("입력에 없는 영문 낱말", a.newLatin, b.newLatin);
if (bans.length) both("금칙어", a.banned, b.banned);
say();
say("숫자 · 영문 낱말은 '입력에 없다'는 것만 잰다 — 지어낸 사실인지는 그 id를 열어 사람이 본다. 출력 본문은 찍지 않았다(몇 건만 볼 때 `--show id,id`).");

// a few samples side by side, on request
for (const id of opt.show) {
  const x = A.rows.get(id);
  const y = B.rows.get(id);
  say();
  say(`### ${id}`);
  if (!x && !y) {
    say("두 파일 모두에 없다.");
    continue;
  }
  const show = (r) => (!r ? "(이 파일에 없음)" : r.ok ? cut(typeof r.output === "string" ? r.output : JSON.stringify(r.output), 400) : `실패: ${r.error}`);
  const src = x ?? y;
  say(`- 입력: ${cut(typeof src.input === "string" ? src.input : JSON.stringify(src.input), 400)}`);
  if (src.label != null) say(`- 라벨: ${typeof src.label === "string" ? src.label : JSON.stringify(src.label)}`);
  say(`- 전: ${show(x)}`);
  say(`- 후: ${show(y)}`);
}

console.log(out.join("\n"));
