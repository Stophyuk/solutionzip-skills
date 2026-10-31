#!/usr/bin/env node
// Scan an app repository for the risks AI-built apps often ship with, before it goes public.
//
//   node scan.mjs [repoDir] [--json] [--no-history]      (repoDir defaults to the current folder)
//
// fail = a definite risk, warn = a person should look. Checks:
//   secrets     every file in the working tree and every added line in history (git log -p --all):
//               fail — Supabase service_role JWT (payload decoded, role claim read) and secret keys,
//                      OpenAI · Anthropic · Stripe live · Toss Payments live · AWS · Google OAuth · GitHub ·
//                      Slack tokens, private key blocks; also built client bundles (.next/static, dist, build)
//               warn — test-mode payment keys, Google API keys, password · key literals written in code
//   env files   fail — a .env file or a key file (.p12 · .keystore · id_rsa) was ever committed
//               warn — .gitignore does not cover .env (fail when such a file is sitting there unignored)
//   public env  fail — a browser-exposed variable (NEXT_PUBLIC_ · VITE_ · EXPO_PUBLIC_ · REACT_APP_ ·
//                      NUXT_PUBLIC_ · PUBLIC_) whose name says SERVICE_ROLE · SECRET · PRIVATE · PASSWORD
//   database    SQL files: public tables without row level security, policies open to everyone
//               (using (true)), views that skip RLS. Firebase rules that allow everyone.
//   heuristics  warn — payment amount trusted from the request, admin · debug routes with no auth check
//
// A found secret is shown as its first 4 characters + **** only. The full value is never printed or saved.
// The folder this script lives in is skipped when it sits inside the scanned repository.
// Exit code: 1 when anything fails, 0 otherwise, 2 for a bad argument. Node 18+, no dependencies.
// git on PATH is needed for history; without it only the files are scanned.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------- arguments ----------

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--json", "--no-history"]);
if (args.includes("-h") || args.includes("--help") || args.some((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a))) {
  console.error("사용법: node scan.mjs [저장소 경로] [--json] [--no-history]");
  process.exit(2);
}
const asJson = args.includes("--json");
const withHistory = !args.includes("--no-history");
let root = path.resolve(args.find((a) => !a.startsWith("-")) ?? ".");
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`폴더가 아니다: ${root}`);
  process.exit(2);
}
const started = Date.now();

// ---------- file kinds ----------

const MAX_FILE = 5 * 1024 * 1024;
const BINARY_EXT = new Set(
  ("png jpg jpeg gif webp avif ico bmp tif tiff psd ai sketch fig pdf zip gz tgz bz2 xz 7z rar jar war apk aab ipa " +
    "mp3 mp4 m4a mov avi mkv webm wav ogg flac woff woff2 ttf otf eot exe dll so dylib bin dmg iso class pyc o a wasm map " +
    "p12 pfx jks keystore sqlite db").split(" "),
);
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const CONFIG_FILE = /\.(?:json|ya?ml|toml|ini|cfg|conf|properties|xml|plist|gradle|html?|sh|bash|zsh|ps1|py|rb|php|go|java|kt|swift|dart|rs|cs)$/i;
const LOCK_FILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|Podfile\.lock)$/;
const TEST_PATH = /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|spec|fixtures?|mocks?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel", ".netlify", ".expo", ".cache", "coverage", "Pods", ".venv", "venv", "__pycache__"]);
const BUNDLE_DIRS = [".next/static", "out/_next/static", "dist", "build", "web-build", ".svelte-kit/output/client", ".output/public"];

const base = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
const extOf = (rel) => {
  const b = base(rel);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
};
// .env, .env.local, .env.production … but not the templates meant to be committed.
const isEnvFile = (rel) => {
  const b = base(rel);
  return (/^\.env(?:\..+)?$/.test(b) || b === ".dev.vars" || b === ".envrc") && !/\.(?:example|sample|template|dist|defaults|schema|vault)$/i.test(b);
};
const isEnvLike = (rel) => /^\.env/.test(base(rel)) || base(rel) === ".dev.vars";
const isKeyFile = (rel) => {
  const b = base(rel);
  return (/\.(?:p12|pfx|jks|keystore)$/i.test(b) && b !== "debug.keystore") || /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(b);
};

// ---------- secret shapes ----------
// Regexes only. Test keys are built at run time by the fixture script, never written here.

const PRIVATE_KEY_RE = /-{5}BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-{5}/g;
const SECRET_PATTERNS = [
  { id: "supabase-service-role", level: "fail", title: "Supabase service_role 키", re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, check: (v) => jwtRole(v) === "service_role", raw: true },
  { id: "supabase-secret", level: "fail", title: "Supabase secret 키", re: /(?<![\w-])sb_secret_[A-Za-z0-9_-]{20,}/g },
  { id: "anthropic", level: "fail", title: "Anthropic API 키", re: /(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai", level: "fail", title: "OpenAI API 키", re: /(?<![\w-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, check: mixedCase },
  { id: "stripe-live", level: "fail", title: "Stripe 라이브 비밀 키", re: /(?<![\w-])(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { id: "stripe-test", level: "warn", title: "Stripe 테스트 비밀 키", re: /(?<![\w-])(?:sk|rk)_test_[A-Za-z0-9]{20,}/g },
  { id: "stripe-webhook", level: "fail", title: "Stripe 웹훅 서명 비밀", re: /(?<![\w-])whsec_[A-Za-z0-9+/=]{20,}/g },
  { id: "toss-live", level: "fail", title: "토스페이먼츠 라이브 시크릿 키", re: /(?<![\w-])live_g?sk_[A-Za-z0-9]{16,}/g },
  { id: "toss-test", level: "warn", title: "토스페이먼츠 테스트 시크릿 키", re: /(?<![\w-])test_g?sk_[A-Za-z0-9]{16,}/g },
  { id: "aws-access-key", level: "fail", title: "AWS 액세스 키", re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g },
  { id: "aws-secret", level: "fail", title: "AWS 시크릿 액세스 키", re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi, group: 1 },
  { id: "google-oauth-secret", level: "fail", title: "Google OAuth 클라이언트 시크릿", re: /(?<![\w-])GOCSPX-[A-Za-z0-9_-]{20,}/g },
  { id: "google-api-key", level: "warn", title: "Google API 키", re: /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/g },
  { id: "github-token", level: "fail", title: "GitHub 토큰", re: /(?<![\w-])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: "slack-token", level: "fail", title: "Slack 토큰", re: /(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: "private-key", level: "fail", title: "개인키 블록", re: PRIVATE_KEY_RE, raw: true },
];
const PREFILTER = /eyJ|sk-|sk_|rk_|whsec_|_g?sk_|AKIA|ASIA|secret_?access|AIza|GOCSPX-|gh[pousr]_|github_pat_|xox|PRIVATE KEY|sb_secret_/i;
const PLACEHOLDER = /^<.*>$|^env\(|^\$[A-Za-z_]|\$\{|\{\{|your[_-]?|xxxx|example|placeholder|changeme|change[_-]me|dummy|sample|fake|replace|insert|todo|\*\*\*|•••|process\.env|import\.meta\.env/i;

const SECRET_META = {
  "supabase-service-role": ["RLS를 전부 건너뛰는 관리자 키다. 가진 사람은 모든 테이블을 읽고 쓰고 지운다.", "Supabase 대시보드의 API 키 설정에서 재발급하고, 서버 환경 변수에만 둔다."],
  "supabase-secret": ["RLS를 건너뛰는 서버용 키다.", "Supabase 대시보드의 API 키 설정에서 이 키를 지우고 새로 만든다."],
  anthropic: ["남이 쓰면 요금이 이 계정으로 나간다.", "Anthropic 콘솔에서 키를 지우고 새로 만든다."],
  openai: ["남이 쓰면 요금이 이 계정으로 나간다.", "OpenAI 대시보드에서 키를 폐기하고 새로 만든다."],
  "stripe-live": ["결제 · 환불 · 고객 정보를 다루는 키다.", "Stripe 대시보드의 API 키 화면에서 키를 교체(roll)한다."],
  "stripe-test": ["돈은 안 움직이지만, 라이브 키도 같은 길로 새기 쉽다.", "환경 변수로 옮기고 테스트 키도 교체한다."],
  "stripe-webhook": ["이 값이 있으면 서명까지 맞춘 가짜 결제 완료 알림을 보낼 수 있다.", "Stripe 대시보드의 웹훅 설정에서 서명 비밀을 교체한다."],
  "toss-live": ["결제 승인 · 취소 API를 부를 수 있는 키다.", "토스페이먼츠 개발자센터에서 재발급한다."],
  "toss-test": ["돈은 안 움직이지만, 라이브 키도 같은 길로 새기 쉽다.", "환경 변수로 옮기고 테스트 키도 재발급한다."],
  "aws-access-key": ["권한에 따라 서버 · 파일 · 청구까지 닿는다.", "IAM에서 키를 비활성화 · 삭제하고 새로 발급한다. CloudTrail에서 사용 기록을 본다."],
  "aws-secret": ["권한에 따라 서버 · 파일 · 청구까지 닿는다.", "IAM에서 키를 비활성화 · 삭제하고 새로 발급한다. CloudTrail에서 사용 기록을 본다."],
  "google-oauth-secret": ["로그인 앱을 사칭하는 데 쓰인다.", "Google Cloud 콘솔의 사용자 인증 정보에서 시크릿을 재설정한다."],
  "google-api-key": ["Firebase 웹 설정 키는 원래 공개되지만, Gemini · 지도 같은 유료 API 키라면 요금이 나간다.", "어떤 키인지 본다. 공개용이면 앱 제한(웹 리퍼러 · 패키지 이름)을 걸고, 서버용이면 폐기 · 재발급한다."],
  "github-token": ["저장소 · 조직 권한이 그대로 넘어간다.", "GitHub 설정의 토큰 목록에서 지우고 새로 만든다."],
  "slack-token": ["워크스페이스 메시지를 읽고 보낼 수 있다.", "Slack 앱 설정에서 토큰을 폐기 · 재발급한다."],
  "private-key": ["서명 · 접속 · 배포 권한이 통째로 넘어간다.", "무엇에 쓰는 키인지 확인하고 새 키 쌍으로 바꾼 뒤, 옛 공개키를 등록 해제한다."],
};

function jwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload.role : undefined;
  } catch {
    return undefined;
  }
}
function mixedCase(v) {
  const body = v.replace(/^sk-(?:proj-|svcacct-|admin-)?/, "");
  return /[a-z]/.test(body) && /[A-Z]/.test(body) && /\d/.test(body);
}
// First 4 characters only. Never return or log more of a secret than this.
const mask = (v) => `${v.slice(0, 4)}****`;
const hashOf = (v) => crypto.createHash("sha256").update(v).digest("hex");

function scanLine(line, onHit) {
  if (line.length > 2_000_000 || !PREFILTER.test(line)) return;
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(line))) {
      const value = p.group ? m[p.group] : m[0];
      if (p.check && !p.check(value)) continue;
      if (!p.raw && PLACEHOLDER.test(value)) continue;
      onHit(p, value, m);
    }
  }
}
const matchesKnownSecret = (v) => {
  let hit = false;
  scanLine(v, () => (hit = true));
  return hit;
};

// ---------- literal passwords and keys in code (heuristic) ----------

const ASSIGN_RE = /(?:^|[^\w$.-])["']?([A-Za-z_$][\w$-]*)["']?\s*(?::|=(?![=>]))\s*(["'`])([^"'`\r\n]{4,200})\2/g;
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^"'\s#]+)/;
const SECRET_NAME = /(?:password|passwd|pwd|secret|secretkey|apikey|privatekey|clientsecret|servicerole|servicerolekey|(?:access|auth|api|bearer|refresh|bot|admin)token)$/i;
const PASSWORD_NAME = /(?:password|passwd|pwd)$/i;
const DUMMY = /^(?:password|passw0rd|pass|secret|test|testing|example|admin|user|demo|dummy|sample|foo|bar|baz|qwerty|1234|12345|123456|abcd|string|null|undefined|none|empty|required|hidden|\*+|x+|•+)$/i;
const PW_COMPARE_RE = /\b((?:[A-Za-z_$][\w$]*)?(?:password|passwd|pwd))\s*(?:===?|!==?)\s*(["'`])([^"'`\r\n]{3,100})\2|(["'`])([^"'`\r\n]{3,100})\4\s*(?:===?|!==?)\s*[\w$.]*?(?:password|passwd|pwd)\b/gi;

function looksLikeSecretValue(name, value) {
  if (!/^[\x21-\x7e]+$/.test(value)) return false; // ASCII without spaces: labels and i18n text drop out
  if (PLACEHOLDER.test(value) || DUMMY.test(value) || /^\/|:\/\//.test(value) || /^[A-Z0-9_]+$/.test(value)) return false;
  if (PASSWORD_NAME.test(name)) return value.length >= 4;
  return value.length >= 16 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

// ---------- SQL (Supabase · Postgres) ----------

const ID = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QN = String.raw`${ID}(?:\s*\.\s*${ID})?`;
const SQL_RE = new RegExp(
  [
    String.raw`\bdo\s+(?<dq>\$[A-Za-z_]*\$)(?<db>[\s\S]*?)\k<dq>`,
    String.raw`\bcreate\s+(?<tmp>(?:global\s+|local\s+)?(?:temporary|temp)\s+)?(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?<ct>${QN})`,
    String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?<at>${QN})\s+(?<ar>enable|disable)\s+row\s+level\s+security`,
    String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?<rf>${QN})\s+rename\s+to\s+(?<rt>${ID})`,
    String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?(?<dt>${QN}(?:\s*,\s*${QN})*)`,
    String.raw`\bcreate\s+(?:or\s+replace\s+)?(?<mat>materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?<cv>${QN})(?<cvo>[^;]*?)\bas\b`,
    String.raw`\balter\s+view\s+(?:if\s+exists\s+)?(?<av>${QN})\s+set\s*\((?<avo>[^)]*)\)`,
    String.raw`\bdrop\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?(?<dv>${QN}(?:\s*,\s*${QN})*)`,
    String.raw`\bcreate\s+policy\s+(?<pn>${ID})\s+on\s+(?<pt>${QN})(?<pb>[^;]*);`,
    String.raw`\bdrop\s+policy\s+(?:if\s+exists\s+)?(?<dpn>${ID})\s+on\s+(?<dpt>${QN})`,
    String.raw`\brevoke\s+all(?:\s+privileges)?\s+on\s+(?:(?<rva>all\s+tables\s+in\s+schema\s+public)|(?:table\s+)?(?<rv>${QN}(?:\s*,\s*${QN})*))\s+from\s+(?<rvf>[^;]+)`,
    String.raw`\bgrant\s+[\w\s,]+?\s+on\s+(?:table\s+)?(?<gr>${QN}(?:\s*,\s*${QN})*)\s+to\s+(?<grt>[^;]+)`,
  ].join("|"),
  "gi",
);

function qname(raw) {
  const parts = raw.split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => (p.startsWith('"') ? p.slice(1, -1) : p.toLowerCase()));
  const [schema, name] = parts.length > 1 ? parts : ["public", parts[0]];
  return { schema, name, key: `${schema}.${name}` };
}
// Replace comments with spaces so match offsets still map to the right line.
const blank = (s) => s.replace(/[^\n]/g, " ");
const stripSqlComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank);
const stripJsComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:"'\\])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// Tables a DO block touches with dynamic SQL (execute format('… %I …', t)): names listed in
// array['a', 'b'] / in ('a', 'b'), or every public table so far when the loop reads the catalog.
function dynamicTargets(body, tables) {
  if (/\b(?:pg_tables|pg_class|information_schema\.tables)\b/i.test(body)) return [...tables.values()].filter((t) => t.schema === "public");
  const found = [];
  for (const a of body.matchAll(/\barray\s*\[([^\]]*)\]|\bin\s*\(([^)]*)\)/gi)) {
    for (const s of (a[1] ?? a[2]).matchAll(/'([^']+)'/g)) {
      const t = tables.get(qname(s[1]).key);
      if (t) found.push(t);
    }
  }
  return found;
}
// Revoking everything from both API roles keeps a table off the API even without RLS.
const coversApiRoles = (roles) => /\banon\b/i.test(roles) && /\bauthenticated\b/i.test(roles);

function analyzeSql(sqlFiles) {
  const tables = new Map();
  const views = new Map();
  const policies = new Map();
  for (const { rel, text } of [...sqlFiles].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const src = stripSqlComments(text);
    SQL_RE.lastIndex = 0;
    let m;
    while ((m = SQL_RE.exec(src))) {
      const g = m.groups;
      const at = { file: rel, line: lineOf(src, m.index) };
      if (g.dq) {
        const dynamic = (what) => new RegExp(String.raw`\bexecute\b[^;]*` + what, "i").test(g.db);
        if (dynamic(String.raw`enable\s+row\s+level\s+security`)) for (const t of dynamicTargets(g.db, tables)) t.rls = true;
        const rv = new RegExp(String.raw`\bexecute\b[^;]*revoke\s+all[^;]*\bfrom\b([^;']*)`, "i").exec(g.db);
        if (rv && coversApiRoles(rv[1])) for (const t of dynamicTargets(g.db, tables)) t.revoked = true;
        SQL_RE.lastIndex = m.index + 2; // keep reading the static statements inside the block
      } else if (g.rva || g.rv) {
        if (coversApiRoles(g.rvf)) {
          const list = g.rva ? [...tables.values()].filter((t) => t.schema === "public") : g.rv.split(/\s*,\s*/).map((n) => tables.get(qname(n).key));
          for (const t of list) if (t) t.revoked = true;
        }
      } else if (g.gr) {
        if (/\b(?:anon|authenticated)\b/i.test(g.grt)) for (const n of g.gr.split(/\s*,\s*/)) {
          const t = tables.get(qname(n).key);
          if (t) t.revoked = false;
        }
      } else if (g.ct && !g.tmp) {
        const q = qname(g.ct);
        if (!tables.has(q.key)) tables.set(q.key, { ...q, ...at, rls: false });
      } else if (g.at) {
        const t = tables.get(qname(g.at).key);
        if (t) {
          t.rls = g.ar.toLowerCase() === "enable";
          if (!t.rls) Object.assign(t, { disabledAt: at });
        }
      } else if (g.rf) {
        const from = qname(g.rf);
        const t = tables.get(from.key);
        if (t) {
          tables.delete(from.key);
          const to = qname(`${from.schema === "public" ? "" : `"${from.schema}".`}${g.rt}`);
          tables.set(to.key, { ...t, ...to });
        }
      } else if (g.dt) {
        for (const n of g.dt.split(/\s*,\s*/)) tables.delete(qname(n).key);
      } else if (g.cv) {
        const q = qname(g.cv);
        views.set(q.key, { ...q, ...at, materialized: !!g.mat, invoker: /security_invoker\s*=\s*(?:true|on|1)/i.test(g.cvo) });
      } else if (g.av) {
        const v = views.get(qname(g.av).key);
        if (v && /security_invoker\s*=\s*(?:true|on|1)/i.test(g.avo)) v.invoker = true;
      } else if (g.dv) {
        for (const n of g.dv.split(/\s*,\s*/)) views.delete(qname(n).key);
      } else if (g.pn) {
        const q = qname(g.pt);
        const cmd = (/\bfor\s+(all|select|insert|update|delete)\b/i.exec(g.pb)?.[1] ?? "all").toLowerCase();
        const openUsing = /\busing\s*\(\s*\(?\s*true\s*\)?\s*\)/i.test(g.pb);
        const openCheck = /\bwith\s+check\s*\(\s*\(?\s*true\s*\)?\s*\)/i.test(g.pb);
        policies.set(`${q.key}:${g.pn}`, { table: q.key, name: g.pn.replace(/^"|"$/g, ""), cmd, open: openUsing || openCheck, ...at });
      } else if (g.dpn) {
        policies.delete(`${qname(g.dpt).key}:${g.dpn}`);
      }
    }
  }
  const publicOnly = (x) => x.schema === "public";
  return {
    noRls: [...tables.values()].filter((t) => publicOnly(t) && !t.rls && !t.revoked),
    leakyViews: [...views.values()].filter((v) => publicOnly(v) && (v.materialized || !v.invoker)),
    openPolicies: [...policies.values()].filter((p) => p.open && p.table.startsWith("public.")),
  };
}

// ---------- Firebase rules ----------

function analyzeFirebaseRules(rel, text, out) {
  if (/\.rules$/.test(rel) && /service\s+(?:cloud\.firestore|firebase\.storage)/.test(text)) {
    const src = stripJsComments(text);
    const re = /\ballow\s+([a-z]+(?:\s*,\s*[a-z]+)*)\s*(?::\s*if\s+([^;]*?))?\s*;/g;
    let m;
    while ((m = re.exec(src))) {
      const cond = (m[2] ?? "").trim();
      const testMode = /^request\.time\s*<\s*timestamp\.date\s*\(/.test(cond);
      if (cond !== "" && cond !== "true" && !testMode) continue;
      const write = m[1].split(/\s*,\s*/).some((x) => /^(?:write|create|update|delete)$/.test(x));
      out.push({ rel, line: lineOf(src, m.index), write, testMode, rule: `allow ${m[1]}${cond ? `: if ${cond}` : ""}` });
    }
  } else if (/(?:^|\/)(?:database\.rules|[\w.-]*\.rules)\.json$/.test(rel)) {
    const re = /"\.(read|write)"\s*:\s*(?:true|"true")/g;
    let m;
    while ((m = re.exec(text))) out.push({ rel, line: lineOf(text, m.index), write: m[1] === "write", testMode: false, rule: `".${m[1]}": true` });
  }
}

// ---------- payment and admin heuristics ----------

const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;
const CLIENT_PAY = /\b(?:requestPayment|request_pay|redirectToCheckout|loadTossPayments|loadPaymentWidget|requestBillingAuth)\s*\(/;
const SERVER_CONFIRM = /api\.tosspayments\.com\/v1\/payments|\/v1\/payments\/confirm|api\.portone\.io\/payments|api\.iamport\.kr\/payments|paymentIntents\.create|checkout\.sessions\.create|charges\.create/;
const AMOUNT_FROM_REQUEST = /\b(?:req|request|ctx\.request|event)\.(?:body|query)\??\.amount\b|searchParams\.get\(\s*["'`]amount["'`]\s*\)|\{[^}]*\bamount\b[^}]*\}\s*=\s*(?:await\s+)?(?:req|request|event)\.(?:json\(\)|body|query)|\b(?:body|query|params|payload|input)\??\.amount\b/;
const AMOUNT_COMPARED = /amount\s*!==?|!==?\s*[\w.?[\]"']*amount\b|amount\s*===?\s*[\w.?]*(?:order|expected|saved|stored|price|total)|(?:order|expected|saved|stored|price|total)[\w.?]*\s*[!=]==?\s*[\w.?]*amount/i;
const PAYMENT_PATH = /pay|checkout|order|billing|toss|stripe|portone|iamport/i;
const SERVER_PATH = /(?:^|\/)(?:api|server|functions|routes|backend)\/|(?:^|\/)route\.[cm]?[jt]s$|\.server\.[jt]s$/;
const AUTH_SIGNAL = new RegExp(
  String.raw`\b(?:getUser|getSession|getServerSession|getClaims|currentUser|auth\s*\(|requireAuth|requireAdmin|requireUser|isAdmin|assertAdmin|ensureAdmin|checkAdmin|verifyAdmin|withAuth|withAdmin|authorize|authenticate|verifyToken|verifyJwt|jwtVerify|jwt\.verify|verifyIdToken|verifySession|validateSession|timingSafeEqual|basicAuth|clerkMiddleware|getAuth|unauthorized|forbidden)\b|status\s*:\s*40[13]\b|\(\s*40[13]\s*[,)]|redirect\(\s*["'\x60][^"'\x60]*(?:login|signin|sign-in)`,
  "i",
);

function isAdminEntry(rel) {
  if (!CODE_FILE.test(rel) || TEST_PATH.test(rel)) return false;
  const segs = rel.split("/");
  const b = segs.pop();
  const adminDir = segs.some((d) => /^[([_@]?admin(?:[-_.][\w-]*)?[)\]]?$/i.test(d));
  const adminFile = /^[_+$]?admin(?:[._-]|$)/i.test(b);
  if (!adminDir && !adminFile) return false;
  if (/^(?:page|route)\.[cm]?[jt]sx?$/.test(b)) return true; // Next.js app router
  if (/^\+(?:page|server)(?:\.server)?\.(?:[jt]s|svelte)$/.test(b)) return true; // SvelteKit
  if (/^_(?:app|document)\./.test(b)) return false;
  return /(?:^|\/)(?:pages|routes|api|server)\//.test(rel);
}
const isDebugEntry = (rel) => CODE_FILE.test(rel) && !TEST_PATH.test(rel) && /(?:^|\/)(?:api|routes|pages|app)\/(?:[^/]+\/)*_?debug(?:\/|[._-]|$)/i.test(rel);
const isLayout = (rel) => /^(?:layout|\+layout(?:\.server)?|_layout)\.(?:[cm]?[jt]sx?|svelte)$/.test(base(rel));
const isGuard = (rel) => /(?:^|\/)(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$|(?:^|\/)hooks\.server\.[jt]s$|(?:^|\/)server\/middleware\//.test(rel);

// ---------- listing files ----------

const execOpts = { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] };
const gitOut = (a) => execFileSync("git", ["-c", "core.quotePath=false", "-C", root, ...a], execOpts);
const split0 = (s) => s.split("\0").filter(Boolean);

let isGit = false;
let hasCommits = false;
try {
  const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], execOpts).trim();
  if (top) {
    root = top;
    isGit = true;
    try {
      gitOut(["rev-parse", "--verify", "HEAD"]);
      hasCommits = true;
    } catch {}
  }
} catch {}

function walk(dir = "", out = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(rel, out);
    } else if (e.isFile()) out.push(rel);
    if (out.length > 100_000) break;
  }
  return out;
}

const selfDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const selfRel = path.relative(fs.realpathSync(root), selfDir).split(path.sep).join("/");
const selfPrefix = selfRel && !selfRel.startsWith("..") && !path.isAbsolute(selfRel) ? `${selfRel}/` : null;
const notSelf = (rel) => !selfPrefix || !rel.startsWith(selfPrefix);

const tracked = (isGit ? split0(gitOut(["ls-files", "-z"])) : walk()).filter(notSelf);
const untracked = isGit ? split0(gitOut(["ls-files", "-z", "-o", "--exclude-standard"])).filter(notSelf) : [];
const ignoredEnv = isGit ? split0(gitOut(["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"])).filter((r) => isEnvLike(r) && notSelf(r)) : [];
const listed = new Set([...tracked, ...untracked]);

function readText(rel) {
  if (BINARY_EXT.has(extOf(rel))) return null;
  let buf;
  try {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString("utf8");
}

// ---------- collecting ----------

const secrets = new Map(); // key -> record; the value itself is never stored
const hardcoded = new Map();
const publicEnv = new Map(); // variable name -> Set of files
const envFiles = new Map(); // file -> { tracked, commits:Set, oldest }
const keyFiles = new Map();
const sqlFiles = [];
const firebase = [];
const adminEntries = [];
const debugEntries = [];
const layouts = new Map(); // dir -> text
const guards = [];
const payClient = [];
const payServer = [];
const amountTrusted = [];
let supabaseSeen = false;
let envSecretRead = false; // code reads a secret-named variable from the environment
let filesScanned = 0;

function addSecret(p, value, m, loc) {
  const key = p.id === "private-key" ? `${p.id}:${loc.file}` : `${p.id}:${hashOf(value)}`;
  let s = secrets.get(key);
  if (!s) {
    const kind = p.id === "private-key" ? (m[1] || "").trim() : "";
    s = { id: p.id, level: p.level, title: kind ? `${p.title} (${kind})` : p.title, masked: p.id === "private-key" ? null : mask(value), length: p.id === "private-key" ? undefined : value.length, where: [], commits: new Set(), oldest: null };
    secrets.set(key, s);
  }
  if (loc.source === "history") {
    s.commits.add(loc.commit);
    s.oldest = loc; // git log runs newest first, so the last one seen is the oldest
  } else if (!s.where.some((w) => w.file === loc.file && w.line === loc.line) && s.where.length < 50) {
    s.where.push(loc);
  }
}

function noteFile(map, rel, commit, isTracked) {
  let r = map.get(rel);
  if (!r) map.set(rel, (r = { tracked: false, commits: new Set(), oldest: null }));
  if (isTracked) r.tracked = true;
  if (commit) {
    r.commits.add(commit);
    r.oldest = commit;
  }
}

function scanFile(rel, source) {
  if (isGit && source === "tree" && isKeyFile(rel)) noteFile(keyFiles, rel, null, true);
  if (isGit && source === "tree" && isEnvFile(rel)) noteFile(envFiles, rel, null, true);
  const text = readText(rel);
  if (text == null) return;
  if (!isGit && isEnvFile(rel)) {
    // Outside git a local .env is where secrets belong; only the variable names are checked.
    for (const line of text.split(/\r?\n/)) checkPublicEnv(line, rel);
    return;
  }
  filesScanned++;
  if (!supabaseSeen && (rel.startsWith("supabase/") || /@supabase\/|supabase\.co\b|SUPABASE_URL/.test(text))) supabaseSeen = true;
  if (!envSecretRead && ENV_SECRET_READ.test(text)) envSecretRead = true;

  const lines = text.split(/\r?\n/);
  const code = CODE_FILE.test(rel);
  const heuristicFile = (code || CONFIG_FILE.test(rel) || isEnvLike(rel)) && !LOCK_FILE.test(rel);
  const publicEnvFile = code || isEnvLike(rel) || /\.(?:ya?ml|toml|json|html?)$/i.test(rel) || /(?:^|\/)Dockerfile$/.test(rel);
  const client = code && (USE_CLIENT.test(text) || /\.(?:vue|svelte)$/.test(rel));

  lines.forEach((line, i) => {
    const loc = { source, file: rel, line: i + 1 };
    scanLine(line, (p, value, m) => addSecret(p, value, m, loc));
    if (publicEnvFile) checkPublicEnv(line, rel);
    if (!heuristicFile) return;
    const pairs = [];
    if (isEnvLike(rel)) {
      const e = ENV_LINE_RE.exec(line);
      if (e) pairs.push([e[1], e[2]]);
    } else {
      ASSIGN_RE.lastIndex = 0;
      let a;
      while ((a = ASSIGN_RE.exec(line))) pairs.push([a[1], a[3]]);
    }
    for (const [name, value] of pairs) {
      if (!SECRET_NAME.test(name.replace(/[-_]/g, "")) || !looksLikeSecretValue(name, value) || matchesKnownSecret(value)) continue;
      const k = `assign:${hashOf(value)}`;
      if (!hardcoded.has(k)) hardcoded.set(k, { kind: "assign", name, masked: mask(value), length: value.length, client, where: [] });
      const h = hardcoded.get(k);
      if (h.where.length < 20) h.where.push(loc);
    }
    if (code) {
      PW_COMPARE_RE.lastIndex = 0;
      let c;
      while ((c = PW_COMPARE_RE.exec(line))) {
        const value = c[3] ?? c[5];
        if (!value) continue;
        const k = `compare:${rel}:${i}`;
        if (!hardcoded.has(k)) hardcoded.set(k, { kind: "compare", name: c[1] ?? "password", masked: mask(value), length: value.length, client, where: [loc] });
      }
    }
  });

  if (/\.sql$/i.test(rel)) sqlFiles.push({ rel, text });
  analyzeFirebaseRules(rel, text, firebase);
  if (!code || TEST_PATH.test(rel)) return;
  if (isLayout(rel)) layouts.set(rel.slice(0, rel.lastIndexOf("/") + 1), text);
  if (isGuard(rel)) guards.push(text);
  if (isAdminEntry(rel)) adminEntries.push({ rel, text });
  if (isDebugEntry(rel)) debugEntries.push({ rel, text });
  if (CLIENT_PAY.test(text)) payClient.push(rel);
  const confirms = SERVER_CONFIRM.test(text);
  if (confirms) payServer.push(rel);
  const serverish = !client && (confirms || (PAYMENT_PATH.test(rel) && (SERVER_PATH.test(rel) || /["']use server["']/.test(text))));
  if (serverish && AMOUNT_FROM_REQUEST.test(text) && !AMOUNT_COMPARED.test(text)) amountTrusted.push(rel);
}

const ENV_SECRET_READ = /(?:process\.env|import\.meta\.env|Deno\.env\.get\(\s*["'])\.?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|SERVICE_ROLE)/;
const PUBLIC_ENV_RE = /\b(?:NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|REACT_APP_|NUXT_PUBLIC_|PUBLIC_)[A-Z0-9_]+/g;
const SECRETISH = /SERVICE_?ROLE|SECRET|PRIVATE|PASSWORD|PASSWD/;
function checkPublicEnv(line, rel) {
  PUBLIC_ENV_RE.lastIndex = 0;
  let m;
  while ((m = PUBLIC_ENV_RE.exec(line))) {
    if (!SECRETISH.test(m[0])) continue;
    if (!publicEnv.has(m[0])) publicEnv.set(m[0], new Set());
    publicEnv.get(m[0]).add(rel);
  }
}

for (const rel of tracked) scanFile(rel, "tree");
for (const rel of untracked) scanFile(rel, "untracked");

// Ignored local env files hold secrets on purpose; only their variable names are checked.
for (const rel of ignoredEnv) {
  const text = readText(rel);
  if (text) for (const line of text.split(/\r?\n/)) checkPublicEnv(line, rel);
}

// Built client bundles that git does not track: anything secret in here is downloaded by every visitor.
const bundleRoots = [];
for (const d of BUNDLE_DIRS) bundleRoots.push(d);
try {
  for (const app of fs.readdirSync(path.join(root, "apps"))) for (const d of BUNDLE_DIRS) bundleRoots.push(`apps/${app}/${d}`);
} catch {}
let bundleBytes = 0;
function scanBundleDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules") scanBundleDir(rel);
      continue;
    }
    if (!/\.[cm]?js$/.test(e.name) || listed.has(rel) || !notSelf(rel) || bundleBytes > 200 * 1024 * 1024) continue;
    const text = readText(rel);
    if (text == null) continue;
    bundleBytes += text.length;
    text.split(/\r?\n/).forEach((line, i) => scanLine(line, (p, value, m) => addSecret(p, value, m, { source: "bundle", file: rel, line: i + 1 })));
  }
}
for (const d of bundleRoots) if (fs.existsSync(path.join(root, d))) scanBundleDir(d);

// ---------- history ----------

function unquote(p) {
  if (!p.startsWith('"')) return p;
  return p.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
}
function diffPath(raw) {
  const s = raw.slice("diff --git ".length);
  const q = s.lastIndexOf(' "b/');
  if (q >= 0) return unquote(s.slice(q + 1)).replace(/^b\//, "");
  const i = s.lastIndexOf(" b/");
  return i >= 0 ? s.slice(i + 3) : s;
}

async function scanHistory() {
  const child = spawn("git", ["-c", "core.quotePath=false", "-C", root, "log", "-p", "--all", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "--format=%x01%h"], { stdio: ["ignore", "pipe", "ignore"] });
  const done = new Promise((resolve) => child.on("close", resolve));
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let commit = "";
  let file = "";
  let line = 0;
  let inHunk = false;
  let skip = false;
  let commits = 0;
  for await (const raw of rl) {
    if (raw.charCodeAt(0) === 1) {
      commit = raw.slice(1);
      commits++;
      inHunk = false;
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      file = diffPath(raw);
      skip = !notSelf(file) || LOCK_FILE.test(file);
      if (!skip && isEnvFile(file)) noteFile(envFiles, file, commit, false);
      if (!skip && isKeyFile(file)) noteFile(keyFiles, file, commit, false);
      continue;
    }
    if (raw.startsWith("@@")) {
      inHunk = true;
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
      continue;
    }
    if (!inHunk || skip || raw.charCodeAt(0) !== 43 /* + */) continue;
    const content = raw.slice(1);
    const at = { source: "history", commit, file, line };
    scanLine(content, (p, value, m) => addSecret(p, value, m, at));
    line++;
  }
  await done;
  return commits;
}

const commitsScanned = isGit && hasCommits && withHistory ? await scanHistory() : 0;

// ---------- findings ----------

const findings = [];
const add = (f) => findings.push({ where: [], ...f });

for (const s of secrets.values()) {
  const [why, fix] = SECRET_META[s.id];
  const where = [...s.where];
  if (s.commits.size) where.push({ source: "history", commits: s.commits.size, commit: s.oldest.commit, file: s.oldest.file, line: s.oldest.line });
  const inTree = s.where.some((w) => w.source === "tree" || w.source === "untracked");
  const inBundle = s.where.some((w) => w.source === "bundle");
  const detail = inBundle
    ? "빌드된 번들에 들어 있다 — 사이트를 여는 사람 누구나 내려받는다."
    : !inTree && s.commits.size
      ? "지금 파일에는 없고 히스토리에만 남아 있다 — 저장소를 clone한 사람은 볼 수 있다."
      : undefined;
  const inGit = s.commits.size > 0 || (isGit && s.where.some((w) => w.source === "tree"));
  add({ id: `secret.${s.id}`, level: s.level, title: s.title, masked: s.masked ?? undefined, length: s.length, detail, where, why, fix: inGit ? `${fix} 히스토리 지우기는 폐기 다음이다.` : fix });
}

for (const h of hardcoded.values()) {
  if (h.kind === "assign") {
    add({ id: "secret.literal", level: "warn", title: `코드에 적힌 비밀값 꼴 — ${h.name}`, masked: h.masked, length: h.length, where: h.where, why: "비밀번호 · 키를 코드에 적으면 저장소를 보는 사람 모두가 안다.", fix: "진짜 값이면 바꾸고 환경 변수로 옮긴다. 시험용 가짜 값이면 무시한다." });
  } else {
    add({ id: "secret.password-compare", level: h.client ? "fail" : "warn", title: "비밀번호를 코드에 적어 두고 비교한다", masked: h.masked, length: h.length, detail: h.client ? "브라우저에서 도는 파일이다 — 소스 보기로 누구나 본다." : undefined, where: h.where, why: "적어 둔 비밀번호는 코드를 본 사람 모두가 알고, 브라우저에서 비교하면 건너뛸 수도 있다.", fix: "서버에서 로그인 · 권한으로 확인하고, 비밀번호는 해시로만 저장한다." });
  }
}

if (envFiles.size) {
  const where = [...envFiles].map(([file, r]) => ({ source: r.tracked ? "tree" : "history", file, commit: r.oldest ?? undefined, note: r.tracked ? "지금도 추적 중" : "지운 뒤에도 히스토리에 남음" }));
  add({ id: "env.committed", level: "fail", title: ".env 파일이 커밋된 적 있다", where, why: "안에 있던 키는 저장소를 본 사람 모두가 가진 것으로 본다.", fix: "안에 있던 키를 전부 폐기 · 재발급한다 → git rm --cached → .gitignore에 추가 → 필요하면 폐기 뒤에 히스토리 정리." });
}
if (keyFiles.size) {
  const where = [...keyFiles].map(([file, r]) => ({ source: r.tracked ? "tree" : "history", file, commit: r.oldest ?? undefined, note: r.tracked ? "지금도 추적 중" : "지운 뒤에도 히스토리에 남음" }));
  add({ id: "keyfile.committed", level: "fail", title: "키 파일(.p12 · .keystore · id_rsa)이 커밋된 적 있다", where, why: "앱 서명 · 서버 접속 권한이 파일째 넘어간다.", fix: "인증서 · 키를 새로 만들고 옛것을 폐기한다. 그다음 저장소에서 빼고 히스토리를 정리한다." });
}

for (const [name, files] of publicEnv) {
  add({ id: "env.public-secret", level: "fail", title: `브라우저로 나가는 변수에 비밀값 이름 — ${name}`, where: [...files].slice(0, 10).map((file) => ({ source: listed.has(file) ? "tree" : "local", file })), why: "이 접두어가 붙은 변수는 빌드 때 브라우저 코드에 그대로 박힌다.", fix: "접두어를 빼고 서버 코드에서만 읽는다. 이미 배포했다면 그 키를 재발급한다." });
}

// .gitignore coverage of .env
{
  const names = [".env", ".env.local", ".env.production"];
  let uncovered;
  if (isGit) {
    uncovered = names.filter((n) => {
      try {
        execFileSync("git", ["-C", root, "check-ignore", "-q", "--no-index", n], execOpts);
        return false;
      } catch {
        return true;
      }
    });
  } else {
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
    } catch {}
    const globs = lines.map((l) => new RegExp(`^${l.replace(/^\//, "").replace(/\/$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`));
    uncovered = names.filter((n) => !globs.some((g) => g.test(n)));
  }
  const usesEnv = envSecretRead || ignoredEnv.length > 0 || [...listed].some(isEnvLike) || envFiles.size > 0;
  if (uncovered.length && usesEnv) {
    const exposed = untracked.filter(isEnvFile);
    add({ id: "gitignore.env", level: exposed.length ? "fail" : "warn", title: `.gitignore가 ${uncovered.join(" · ")}를 막지 않는다`, detail: exposed.length ? "막히지 않은 env 파일이 지금 폴더에 있다 — git add . 한 번이면 올라간다." : undefined, where: exposed.map((file) => ({ source: "untracked", file })), why: "막혀 있지 않으면 git add . 한 번에 키가 저장소로 올라간다.", fix: ".gitignore에 .env* 줄을 넣고, 예시 파일은 !.env.example로 따로 연다." });
  }
}

// SQL
if (sqlFiles.length) {
  const { noRls, leakyViews, openPolicies } = analyzeSql(sqlFiles);
  if (noRls.length) {
    add({
      id: "db.no-rls",
      level: supabaseSeen ? "fail" : "warn",
      title: `RLS가 켜지지 않은 테이블 ${noRls.length}개 — ${noRls.slice(0, 6).map((t) => t.name).join(" · ")}${noRls.length > 6 ? " …" : ""}`,
      detail: supabaseSeen ? "Supabase는 public 스키마를 API로 열어 둔다. anon 키는 브라우저에 공개되는 값이라, RLS가 없으면 누구나 읽고 쓴다." : "브라우저가 DB API(PostgREST 등)에 바로 붙는 구조일 때 위험하다. 서버만 DB에 붙는다면 낮다.",
      where: noRls.map((t) => ({ source: "tree", file: t.disabledAt?.file ?? t.file, line: t.disabledAt?.line ?? t.line, note: t.disabledAt ? `${t.name} — RLS를 끄는 문장` : t.name })),
      why: "RLS가 없으면 테이블 전체가 키 하나로 열린다.",
      fix: "alter table … enable row level security; 를 넣고, 필요한 만큼만 여는 정책(예: auth.uid() = user_id)을 만든다.",
    });
  }
  const writes = openPolicies.filter((p) => ["all", "update", "delete"].includes(p.cmd));
  const inserts = openPolicies.filter((p) => p.cmd === "insert");
  const reads = openPolicies.filter((p) => p.cmd === "select");
  const policyWhere = (list) => list.map((p) => ({ source: "tree", file: p.file, line: p.line, note: `${p.table.replace(/^public\./, "")} · ${p.name} · for ${p.cmd}` }));
  if (writes.length) add({ id: "db.open-policy-write", level: "fail", title: "누구나 고치고 지울 수 있는 정책 (using (true))", where: policyWhere(writes), why: "정책이 true면 RLS를 켠 의미가 없다. 남의 행까지 바꾸고 지운다.", fix: "조건을 auth.uid() = user_id 처럼 행 주인으로 좁힌다." });
  if (inserts.length) add({ id: "db.open-policy-insert", level: "warn", title: "누구나 행을 넣을 수 있는 정책 (with check (true))", where: policyWhere(inserts), why: "문의 폼처럼 일부러 연 것이면 괜찮지만, 스팸 · 대량 입력에는 열려 있다.", fix: "일부러 연 것인지 확인한다. 열어 둔다면 서버 함수로 받고 횟수 제한을 건다." });
  if (reads.length) add({ id: "db.open-policy-read", level: "warn", title: "누구나 모든 행을 읽는 정책 (using (true))", where: policyWhere(reads), why: "공개 글이면 괜찮지만, 개인정보 열이 있으면 전부 새어 나간다.", fix: "공개해도 되는 열만 있는지 본다. 아니면 조건을 좁히거나 공개용 뷰를 따로 만든다." });
  if (leakyViews.length) add({ id: "db.view-bypass", level: "warn", title: "RLS를 건너뛸 수 있는 뷰", where: leakyViews.map((v) => ({ source: "tree", file: v.file, line: v.line, note: `${v.name}${v.materialized ? " (materialized — RLS 없음)" : " (security_invoker 없음)"}` })), why: "뷰는 기본으로 만든 사람 권한으로 돌아서, 밑 테이블의 RLS가 안 먹을 수 있다.", fix: "with (security_invoker = true)를 붙이거나, API로 열리지 않는 스키마로 옮긴다." });
}

// Firebase
{
  const writes = firebase.filter((r) => r.write || r.testMode);
  const reads = firebase.filter((r) => !r.write && !r.testMode);
  const where = (list) => list.map((r) => ({ source: "tree", file: r.rel, line: r.line, note: r.rule }));
  if (writes.length) add({ id: "firebase.open-write", level: "fail", title: "Firebase 규칙이 누구나 쓰게 열려 있다", where: where(writes), why: "if true · 조건 없음 · 날짜만 보는 테스트 모드는 로그인 없이 쓰고 지울 수 있다.", fix: "request.auth != null 과 request.auth.uid == userId 처럼 주인만 쓰게 좁힌다." });
  if (reads.length) add({ id: "firebase.open-read", level: "warn", title: "Firebase 규칙이 누구나 읽게 열려 있다", where: where(reads), why: "공개 데이터면 괜찮지만, 그 경로 아래 개인정보가 있으면 전부 보인다.", fix: "공개해도 되는 경로만 열고 나머지는 로그인 · 주인 조건을 건다." });
}

// Payments
if (payClient.length && !payServer.length) {
  add({ id: "pay.no-server-confirm", level: "warn", title: "결제창은 있는데 서버에서 승인 · 금액을 확인하는 코드가 안 보인다", where: payClient.slice(0, 10).map((file) => ({ source: "tree", file })), why: "금액을 브라우저가 정하면 개발자 도구로 바꿔 보낼 수 있다.", fix: "주문을 서버에 먼저 저장하고, 승인 API를 서버에서 부르기 전에 저장한 금액과 비교한다." });
}
if (amountTrusted.length) {
  add({ id: "pay.amount-from-request", level: "warn", title: "결제 금액을 요청에서 받아 그대로 쓰는 것 같다", where: amountTrusted.slice(0, 10).map((file) => ({ source: "tree", file })), why: "1,000원짜리를 10원으로 바꿔 보내도 승인될 수 있다.", fix: "주문 ID로 DB에서 금액을 다시 읽고, 다르면 승인하지 않는다." });
}

// Admin and debug routes
{
  const guarded = guards.some((t) => /admin/i.test(t) && AUTH_SIGNAL.test(t));
  const ancestorsGuarded = (rel) => {
    for (const [dir, t] of layouts) if (rel.startsWith(dir) && AUTH_SIGNAL.test(t)) return true;
    return false;
  };
  const open = adminEntries.filter((e) => !AUTH_SIGNAL.test(e.text) && !ancestorsGuarded(e.rel) && !guarded);
  if (open.length) add({ id: "admin.no-auth", level: "warn", title: `관리자 경로에 인증 검사가 안 보인다 (${open.length}곳)`, where: open.slice(0, 10).map((e) => ({ source: "tree", file: e.rel })), why: "주소만 알면 누구나 관리자 화면 · API를 연다.", fix: "그 경로의 서버 코드(페이지 · API 둘 다)에서 로그인과 관리자 권한을 확인한다. 미들웨어 한 곳에만 기대지 않는다." });
  const debug = debugEntries.filter((e) => !AUTH_SIGNAL.test(e.text));
  if (debug.length) add({ id: "debug.route", level: "warn", title: "디버그 경로가 열려 있다", where: debug.map((e) => ({ source: "tree", file: e.rel })), why: "환경 변수 · 요청 내용 같은 내부 정보를 보여 주는 일이 많다.", fix: "지우거나, 개발 환경에서만 켜지게 하고 인증 뒤로 둔다." });
}

// ---------- output ----------

const order = (f) => (f.level === "fail" ? 0 : 1);
findings.sort((a, b) => order(a) - order(b));
const summary = { fail: findings.filter((f) => f.level === "fail").length, warn: findings.filter((f) => f.level === "warn").length };
const report = {
  target: root,
  git: { repo: isGit, history: isGit && hasCommits && withHistory, commits: commitsScanned },
  filesScanned,
  skipped: selfPrefix ? [selfPrefix] : [],
  supabase: supabaseSeen,
  summary,
  findings,
  durationMs: Date.now() - started,
};

function fmtWhere(w) {
  const at = w.line ? `${w.file}:${w.line}` : w.file;
  if (w.source === "history" && w.commits) return `히스토리 — 커밋 ${w.commits}개에 있음 (가장 오래된 ${w.commit} · ${at})`;
  if (w.source === "history") return `${at} — 히스토리 ${w.commit}${w.note ? ` · ${w.note}` : ""}`;
  const tag = { untracked: " (커밋 전 · .gitignore에 없음)", bundle: " (빌드된 번들)", local: " (로컬 파일 · git 밖)" }[w.source] ?? "";
  return `${at}${tag}${w.note ? ` — ${w.note}` : ""}`;
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const out = [];
  out.push(`바이브코딩 앱 점검 — ${root}`);
  const histNote = !isGit ? "git 저장소가 아니라 히스토리는 못 봤다" : !hasCommits ? "커밋이 없다" : withHistory ? `커밋 ${commitsScanned}개` : "히스토리 건너뜀(--no-history)";
  out.push(`${histNote} · 파일 ${filesScanned}개 · ${(report.durationMs / 1000).toFixed(1)}초${selfPrefix ? ` · 건너뜀: ${selfPrefix}(이 점검 스킬)` : ""}`);
  out.push("");
  out.push(`실패 ${summary.fail} · 경고 ${summary.warn}`);
  findings.forEach((f, i) => {
    out.push("");
    const len = f.length ? `(${f.length}자)` : "";
    out.push(`${i + 1}. [${f.level === "fail" ? "실패" : "경고"}] ${f.title}${f.masked ? ` — ${f.masked}${len}` : ""}`);
    if (f.detail) out.push(`   ${f.detail}`);
    for (const w of f.where.slice(0, 5)) out.push(`   ${fmtWhere(w)}`);
    if (f.where.length > 5) out.push(`   … 외 ${f.where.length - 5}곳`);
    out.push(`   → ${f.fix}`);
  });
  out.push("");
  out.push(findings.length ? "기계로 못 잡는 것은 checklist.md에서 사람이 본다." : "기계로 잡히는 위험은 없었다. 안전하다는 뜻은 아니다 — 나머지는 checklist.md.");
  console.log(out.join("\n"));
}
process.exitCode = summary.fail ? 1 : 0;
