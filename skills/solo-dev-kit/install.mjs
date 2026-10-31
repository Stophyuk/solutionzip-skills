#!/usr/bin/env node
// Install the solo-dev-kit templates into a project. Never overwrites a file that already exists.
//
//   node install.mjs [projectDir]            plan only: what would be added, what already exists (same / differs)
//   node install.mjs [projectDir] --apply    copy the new files and merge the hooks into .claude/settings.json
//
// templates/<path> goes to <projectDir>/<path>, except:
//   CLAUDE.md.example    → CLAUDE.md, only when the project has none (otherwise lists the sections it lacks)
//   settings.hooks.json  → merged into .claude/settings.json. Existing hooks and permissions are kept; a hook
//                          whose command and `if` are already registered for that event is not added again.
// A file that exists and differs is left alone and reported, so it can be diffed and decided by hand.
// Running it twice is safe: the second run finds everything "same" or "already registered".
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tplDir = path.join(here, "templates");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const project = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");

const SETTINGS_FRAGMENT = "settings.hooks.json";
const CLAUDE_EXAMPLE = "CLAUDE.md.example";
// Sections CLAUDE.md.example brings; an existing CLAUDE.md is checked for these headings.
const CLAUDE_SECTIONS = ["## 상태는 여기 없다", "## 먼저 읽을 것", "## 하지 말 것", "## 확인 명령"];

if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
  console.error(`프로젝트 폴더가 없습니다: ${project}`);
  process.exit(1);
}

const walk = (dir, base = dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p)];
  });

// 1. files
const plan = []; // { rel, target, state: "new" | "same" | "differs" | "kept", note }
for (const rel of walk(tplDir).sort()) {
  if (rel === SETTINGS_FRAGMENT) continue;
  const targetRel = rel === CLAUDE_EXAMPLE ? "CLAUDE.md" : rel;
  const target = path.join(project, targetRel);
  const src = path.join(tplDir, rel);
  if (!fs.existsSync(target)) {
    plan.push({ src, targetRel, target, state: "new" });
  } else if (rel === CLAUDE_EXAMPLE) {
    const have = fs.readFileSync(target, "utf8");
    const missing = CLAUDE_SECTIONS.filter((h) => !have.split("\n").some((l) => l.trim().startsWith(h)));
    plan.push({ src, targetRel, target, state: "kept", note: missing.length ? `빠진 절: ${missing.join(" · ")}` : "네 절 다 있음" });
  } else {
    const same = fs.readFileSync(target).equals(fs.readFileSync(src));
    plan.push({ src, targetRel, target, state: same ? "same" : "differs" });
  }
}

// 2. settings — merge the hook fragment into .claude/settings.json (a copy while planning)
const settingsPath = path.join(project, ".claude", "settings.json");
const fragment = JSON.parse(fs.readFileSync(path.join(tplDir, SETTINGS_FRAGMENT), "utf8"));
let settings = {};
let settingsError = "";
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (e) {
    settingsError = `JSON으로 읽지 못했습니다(${e.message}) — 손으로 합칩니다`;
  }
}
const added = [];
if (!settingsError) {
  settings.hooks ??= {};
  for (const [event, groups] of Object.entries(fragment.hooks)) {
    const have = (settings.hooks[event] ??= []);
    if (!Array.isArray(have)) {
      settingsError = `hooks.${event}가 배열이 아닙니다 — 손으로 합칩니다`;
      break;
    }
    for (const group of groups) {
      for (const hook of group.hooks) {
        const dup = have.some((g) =>
          (g.hooks ?? []).some((h) => h.command === hook.command && (h.if ?? "") === (hook.if ?? "")),
        );
        if (dup) continue;
        let target = have.find((g) => (g.matcher ?? "") === (group.matcher ?? ""));
        if (!target) {
          target = group.matcher === undefined ? { hooks: [] } : { matcher: group.matcher, hooks: [] };
          have.push(target);
        }
        (target.hooks ??= []).push(hook);
        added.push(`${event}${group.matcher ? ` [${group.matcher}]` : ""}${hook.if ? ` if ${hook.if}` : ""}`);
      }
    }
  }
}

// 3. report
const LABEL = { new: "새로", same: "같음", differs: "다름", kept: "있음" };
console.log(`프로젝트: ${project}${apply ? "" : "  (계획만 — 깔려면 --apply)"}\n`);
console.log("파일:");
for (const p of plan) {
  const hint = p.state === "differs" ? `  → diff -u "${p.targetRel}" "${p.src}"` : p.note ? `  → ${p.note}` : "";
  console.log(`  ${LABEL[p.state]}  ${p.targetRel}${hint}`);
}
console.log("\n.claude/settings.json 훅:");
if (settingsError) console.log(`  ! ${settingsError}`);
else if (!added.length) console.log("  이미 등록됨");
else for (const a of added) console.log(`  보탬  ${a}`);

const gate = spawnSync(process.execPath, [path.join(tplDir, ".claude/hooks/pre-push.mjs"), "--dry-run"], {
  cwd: project,
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: project },
});
console.log(`\n${(gate.stdout || gate.stderr || "").trim()}`);
if (!fs.existsSync(path.join(project, ".git"))) console.log("\n! git 저장소가 아닙니다 — 요약의 git 줄이 빠집니다.");

// 4. apply
if (apply) {
  let copied = 0;
  for (const p of plan.filter((x) => x.state === "new")) {
    fs.mkdirSync(path.dirname(p.target), { recursive: true });
    fs.copyFileSync(p.src, p.target, fs.constants.COPYFILE_EXCL); // EXCL: fail rather than overwrite
    copied++;
  }
  if (!settingsError && added.length) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  const differs = plan.filter((x) => x.state === "differs").length;
  console.log(
    `\n깔았습니다 — 파일 ${copied}개${added.length && !settingsError ? ` · 훅 ${added.length}개` : ""}.` +
      (differs ? ` 다른 파일 ${differs}개는 그대로 뒀습니다(위 diff 명령으로 비교).` : ""),
  );
}
