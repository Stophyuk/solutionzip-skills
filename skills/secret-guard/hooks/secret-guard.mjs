#!/usr/bin/env node
// UserPromptSubmit: refuse prompts that carry secrets (API keys, private keys, service_role JWTs,
// resident registration numbers, "password: xxx" lines). Prefix a prompt with "#허용" to send it anyway.
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";

// One line per hit (kinds only, never values) so the monthly harness tune can count blocks and overrides.
const log = (rec) => { try { appendFileSync(`${homedir()}/.claude/hooks/log.jsonl`, JSON.stringify({ t: new Date().toISOString(), hook: "secret-guard", ...rec }) + "\n"); } catch { /* logging is best effort */ } };

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const prompt = String(input.prompt ?? "");
if (!prompt) process.exit(0);
const allowed = prompt.trimStart().startsWith("#허용");

const checks = [
  ["Anthropic 키", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI 키", /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{24,}/],
  ["AWS 키", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub 토큰", /\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ["Google 키", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["Slack 토큰", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Apify 키", /apify_api_[A-Za-z0-9]{20,}/],
  ["개인 키", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["주민·외국인등록번호", /\b\d{6}-[1-8]\d{6}\b/],
];
const found = checks.filter(([, re]) => re.test(prompt)).map(([name]) => name);

// Supabase-style JWT: only the service_role kind is a secret (anon keys are public by design).
for (const m of prompt.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
  try {
    const payload = JSON.parse(Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (payload.role === "service_role") { found.push("service_role 키"); break; }
  } catch { /* not a JWT */ }
}

// "비밀번호는 abc123!" style: a token with both a letter and a digit right after a password word.
const pw = prompt.match(/(?:비밀번호|비번|패스워드|password|passwd|\bpw)\s*(?:[:=]|은|는)?\s*([^\s가-힣'"`]{6,64})/i);
if (pw && /[A-Za-z]/.test(pw[1]) && /\d/.test(pw[1])) found.push("비밀번호");

if (found.length && allowed) { log({ action: "allowed", kinds: [...new Set(found)] }); process.exit(0); }
if (found.length) {
  log({ action: "blocked", kinds: [...new Set(found)] });
  process.stderr.write(
    `비밀값으로 보이는 내용(${[...new Set(found)].join(", ")})이 있어 보내지 않았습니다.\n` +
    `키는 입력창에서 ! echo 'NAME=값' >> .env 처럼 직접 넣고, 대화에는 "저장했어"만 적어 주세요.\n` +
    `잘못 걸린 거라면 맨 앞에 #허용 을 붙여 다시 보내면 됩니다.\n`
  );
  process.exit(2);
}
process.exit(0);
