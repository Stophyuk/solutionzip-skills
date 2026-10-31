#!/usr/bin/env node
// SessionStart hook — computes the project state from files every session instead of storing it in prose.
//
//   echo '{}' | node .claude/hooks/session-start.mjs     what the hook prints at session start
//   node .claude/hooks/session-start.mjs --list          also lists the open rows (the /record skill calls this)
//
// Claude Code adds stdout to the session context. Reads git and the ledgers named in CONFIG below.
// A ledger whose file is missing is skipped; a table with no rows says so. Always exits 0 — a line that
// cannot be computed is dropped, so a broken ledger never blocks a session.
//
// Ledger contract (the only part a machine reads):
//   milestones · owner tasks  rows of the markdown table under the heading. The LAST non-empty cell is the
//                             status and its FIRST character is the state: ✅ done · ◐ doing · ⏳ waiting · ☐ not started.
//   decisions                 rows under the open heading are open, rows under the decided heading are decided.
//                             The first cell is the number (a short letter prefix is fine: 12 or D12).
//   changelog                 rows whose first cell is a YYYY-MM-DD date. The newest date wins, so row order
//                             does not matter. **Bold** text in the second cell is used as the title.
// Header rows (any row followed by |---|) are skipped, so header wording is free.
//
// To adapt this to a project, change CONFIG only. Set an entry to null to drop that line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const CONFIG = {
  // First line of the summary — tells the agent where state lives (and that this text is computed).
  header:
    "[자동 요약 — 편집하지 말 것. 상태를 적는 곳은 docs/milestones.md · docs/decisions.md · docs/changelog.md 뿐]",
  // Subject pattern of /record commits (git --grep regex). The git line counts commits made since the last one.
  recordCommit: "^docs: 기록",
  milestones: { file: "docs/milestones.md", heading: "## 마일스톤", label: "마일스톤" },
  // `empty` is what an empty table prints; without it the line nudges to add the first row.
  ownerTasks: { file: "docs/milestones.md", heading: "## 사람 손", label: "사람 손", empty: "없음" },
  decisions: { file: "docs/decisions.md", open: "## 열린 결정", decided: "## 정한 것", label: "결정" },
  changelog: { file: "docs/changelog.md", show: 1, label: "변경 기록" },
  // Last line — the procedures this project has. Keep it to one line.
  footer: "절차: 한 덩어리가 끝나면 /record <제목> — 실수는 그 스킬 · 규칙 파일의 '지난 실수'에 적는다(/record가 묻는다)",
};

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const wantList = process.argv.includes("--list");
const out = [];
const extra = []; // --list details, printed after the summary

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const read = (rel) => {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null; // missing file → the caller skips its line
  }
};
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const plain = (s) => s.replace(/\*\*|~~|`/g, "").trim();
const firstChar = (s) => Array.from(s.replace(/^[\s*_~]+/, ""))[0] ?? "";
const block = (fn) => {
  try {
    fn();
  } catch {
    /* drop the line, keep the session going */
  }
};

// Lines under a heading, up to the next heading of the same or a higher level. Fenced code is not a heading.
// Returns null when the heading is not there.
const section = (text, heading) => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith(heading));
  if (start < 0) return null;
  const level = (heading.match(/^#+/) ?? ["##"])[0].length;
  const stop = new RegExp(`^#{1,${level}}\\s`);
  let fenced = false;
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    if (!fenced && stop.test(l)) break;
    body.push(l);
  }
  return body.join("\n");
};

// Data rows of the markdown tables in `text`, as arrays of trimmed cells. Rows may or may not end with `|`.
const tableRows = (text) => {
  const lines = (text ?? "").split("\n").map((l) => l.trim());
  const isSep = (l) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l);
  const rows = [];
  lines.forEach((l, i) => {
    if (!l.startsWith("|") || isSep(l) || isSep(lines[i + 1] ?? "")) return;
    rows.push(l.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim()));
  });
  return rows;
};
const lastCell = (cells) => [...cells].reverse().find((c) => c !== "") ?? "";
// Status marks of the milestone tables; anything else in the first position shows as "?".
const MARKS = ["✅", "◐", "⏳", "☐"];
const mark = (cells) => (MARKS.includes(firstChar(lastCell(cells))) ? firstChar(lastCell(cells)) : "?");
const isStruck = (cells) => /^~~/.test(cells[0] ?? "");

if (CONFIG.header) out.push(CONFIG.header);

// git — branch · dirty files · last commit · commits since the last /record commit
block(() => {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!branch) {
    // no commits yet (HEAD is unborn) — still say which branch; not a git repo → no line
    const unborn = git("symbolic-ref", "--short", "HEAD");
    if (unborn) out.push(`git: ${unborn} · 커밋 아직 없음`);
    return;
  }
  const dirty = git("status", "--porcelain").split("\n").filter(Boolean).length;
  const last = git("log", "-1", "--format=%h %ad %s", "--date=short");
  let since = "";
  if (CONFIG.recordCommit) {
    const rec = git("log", "-1", "--format=%H", `--grep=${CONFIG.recordCommit}`);
    if (rec) {
      const n = Number(git("rev-list", "--count", `${rec}..HEAD`) || 0);
      since = n ? ` · 기록 뒤 커밋 ${n}개` : " · 기록 뒤 커밋 없음";
      if (wantList && n) extra.push("기록 뒤 커밋:", ...git("log", "--oneline", "-15", `${rec}..HEAD`).split("\n").map((l) => `- ${l}`));
    } else {
      since = " · 기록 커밋 아직 없음";
    }
  }
  out.push(`git: ${branch} · ${dirty ? `변경 ${dirty}개` : "clean"} · ${clip(last, 80)}${since}`);
});

// milestones and owner tasks — same table shape, status is the first character of the last cell
for (const key of ["milestones", "ownerTasks"]) {
  block(() => {
    const c = CONFIG[key];
    const text = c && read(c.file);
    if (!text) return;
    const body = section(text, c.heading);
    if (body === null) {
      out.push(`${c.label}: ${c.file}에 '${c.heading}' 절이 없다 — 절 이름이나 이 훅의 CONFIG를 고친다`);
      return;
    }
    const rows = tableRows(body).filter((r) => !isStruck(r));
    if (!rows.length) {
      out.push(`${c.label}: ${c.empty ?? `표가 비었다 — ${c.file} '${c.heading.replace(/^#+\s*/, "")}'에 첫 행을 적는다`}`);
      return;
    }
    const open = rows.filter((r) => mark(r) !== "✅");
    const ids = open.map((r) => `${plain(r[0])}(${mark(r)})`);
    out.push(
      open.length
        ? `${c.label}: 끝 ${rows.length - open.length}/${rows.length} · 남은 것 ${ids.join(" ")}`
        : `${c.label}: 전부 ✅ (${rows.length}개)`,
    );
    if (wantList && open.length) {
      extra.push(`남은 ${c.label}:`, ...open.map((r) => `- ${plain(r[0])} · ${clip(plain(r[1] ?? ""), 40)} · ${clip(plain(lastCell(r)), 30)}`));
    }
  });
}

// decisions — open count with numbers, decided count, next free number across both tables
block(() => {
  const c = CONFIG.decisions;
  const text = c && read(c.file);
  if (!text) return;
  const openBody = section(text, c.open);
  const doneBody = section(text, c.decided);
  if (openBody === null && doneBody === null) {
    out.push(`${c.label}: ${c.file}에 '${c.open}' · '${c.decided}' 절이 없다 — 절 이름이나 이 훅의 CONFIG를 고친다`);
    return;
  }
  const allOpen = tableRows(openBody);
  const openRows = allOpen.filter((r) => !isStruck(r));
  const doneRows = tableRows(doneBody);
  // struck-through rows still hold their number, so it is never handed out twice
  const num = (r) => Number(plain(r[0] ?? "").match(/^[A-Za-z]{0,3}-?(\d+)$/)?.[1] ?? NaN);
  const nums = [...allOpen, ...doneRows].map(num).filter(Number.isFinite);
  const next = Math.max(0, ...nums) + 1;
  const openIds = openRows.map((r) => plain(r[0])).filter(Boolean);
  out.push(
    `${c.label}: 열린 것 ${openRows.length}건${openIds.length ? `(${openIds.join(" ")})` : ""} — 임의로 정하지 않는다 · 정한 것 ${doneRows.length}건 · 다음 번호 ${next}`,
  );
  if (wantList && openRows.length) {
    extra.push("열린 결정:", ...openRows.map((r) => `- ${plain(r[0])} · ${clip(plain(r[1] ?? ""), 60)}`));
  }
});

// changelog — newest dated rows (ties keep file order, so a row appended later counts as newer)
block(() => {
  const c = CONFIG.changelog;
  const text = c && read(c.file);
  if (!text) return;
  const rows = tableRows(text)
    .map((r, i) => ({ date: plain(r[0] ?? ""), raw: r[1] ?? "", i }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i));
  if (!rows.length) {
    out.push(`${c.label}: 아직 없음`);
    return;
  }
  const year = `${new Date().getFullYear()}-`;
  const title = (r) => clip(plain(r.raw.match(/\*\*(.+?)\*\*/)?.[1] ?? r.raw), 70);
  const shown = rows.slice(-Math.max(1, c.show ?? 1)).reverse();
  out.push(`${c.label}(${rows.length}건): ` + shown.map((r) => `${r.date.replace(year, "")} ${title(r)}`).join("  |  "));
});

if (CONFIG.footer) out.push(CONFIG.footer);
if (wantList && extra.length) out.push("", ...extra);

process.stdout.write(out.join("\n") + "\n");
process.exit(0);
