#!/usr/bin/env node
// PreToolUse gate for `git push` — runs the project's fast checks and blocks the push on the first failure.
//
//   (hook)  Claude Code pipes the Bash call as JSON on stdin: {"tool_input":{"command":"git push"}, ...}
//   node .claude/hooks/pre-push.mjs --dry-run     print the checks it would run, run nothing
//   node .claude/hooks/pre-push.mjs               run the checks by hand (no stdin → gate anyway)
//
// Which checks: every name in SCRIPTS that exists in package.json "scripts", in that order, run with the
// package manager the project uses (packageManager field, else the lockfile, else npm); then EXTRA.
// A missing name is skipped, so the same file works in any project — run --dry-run once to see the gate
// is not empty.
//
// Exit codes follow the Claude Code hook contract: 0 lets the call through quietly; 2 blocks it and hands
// stderr to Claude as the reason. The settings `if` filter already limits the hook to push commands; the
// command check below is a second net, so a stray call costs one process start.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Fast checks only — the gate must stay quick enough that nobody wants to skip it. Builds and slow test
// suites belong in CI. Order matters: the first failure stops the rest.
const SCRIPTS = ["preflight", "typecheck", "lint"];
// Checks outside package.json, as [label, [command, ...args]], e.g. ["ruff", ["ruff", "check", "."]].
const EXTRA = [];
// Per-check limit and total budget in ms. Keep TOTAL_MS under the hook "timeout" in settings (seconds there),
// so a slow check ends here as a block with a reason instead of a hook timeout.
const STEP_MS = 120_000;
const TOTAL_MS = 280_000;

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const dryRun = process.argv.includes("--dry-run");

// `git push`, `git -C dir push`, `cd x && git push origin main` — but not `git commit -m "push it"`.
const PUSH = /(^|[\s;&|("'`])git(\s+-[Cc]\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+push(?=$|[\s;&|)"'`])/;

if (!dryRun && !process.stdin.isTTY) {
  let input = null;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    /* empty or not JSON → treat as a manual run and gate anyway */
  }
  if (input && typeof input === "object" && !PUSH.test(input.tool_input?.command ?? "")) process.exit(0);
}

const pkg = (() => {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
})();

const pm = (() => {
  const named = String(pkg?.packageManager ?? "").split("@")[0];
  if (["npm", "pnpm", "yarn", "bun"].includes(named)) return named;
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  return "npm";
})();

const steps = [
  ...SCRIPTS.filter((s) => typeof pkg?.scripts?.[s] === "string").map((s) => [s, [pm, "run", s]]),
  ...EXTRA,
];

if (dryRun) {
  if (!steps.length) {
    console.log(`검사 없음 — package.json scripts에 ${SCRIPTS.join(" · ")} 중 하나도 없고 EXTRA도 비었다. 이대로면 푸시를 막지 않는다.`);
  } else {
    console.log("푸시 전 검사(순서대로, 첫 실패에서 멈춘다):");
    steps.forEach(([, cmd], i) => console.log(`  ${i + 1}. ${cmd.join(" ")}`));
  }
  process.exit(0);
}

const started = Date.now();
for (const [name, [bin, ...args]] of steps) {
  const left = TOTAL_MS - (Date.now() - started);
  const limit = Math.min(STEP_MS, left);
  const r =
    limit > 0
      ? spawnSync(bin, args, {
          cwd: root,
          encoding: "utf8",
          timeout: limit,
          maxBuffer: 16 * 1024 * 1024,
          shell: process.platform === "win32", // npm/pnpm are .cmd files on Windows
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        })
      : { status: null, error: { code: "ETIMEDOUT" } };
  if (r.status === 0) continue;

  const why =
    r.error?.code === "ENOENT"
      ? `${bin}을(를) 찾지 못했다 — 설치하거나 이 훅의 검사 목록을 고친다`
      : r.error?.code === "ETIMEDOUT" || r.signal
        ? `${Math.round(limit / 1000)}초 안에 끝나지 않았다 — 느린 검사는 CI로 옮긴다`
        : `종료 코드 ${r.status}`;
  const head = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().replace(/\n\s*\n+/g, "\n").split("\n").slice(0, 40).join("\n");
  process.stderr.write(`push 차단 — ${name} 실패(${why}). 고친 뒤 다시 push한다.\n$ ${[bin, ...args].join(" ")}\n${head}\n`);
  process.exit(2);
}
process.exit(0);
