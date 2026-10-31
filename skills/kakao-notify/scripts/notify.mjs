#!/usr/bin/env node
// Claude Code hook → KakaoTalk "나와의 채팅". One script, three hook events:
//
//   node notify.mjs start   (UserPromptSubmit) remembers when the turn began
//   node notify.mjs stop    (Stop)             "✅ <folder> 끝 (12분)" — only when the turn ran ≥ KAKAO_MIN_MINUTES
//   node notify.mjs wait    (Notification)    "⏳ <folder> 확인이 필요해요" — Claude is asking for permission or input
//
// The hook's JSON arrives on stdin (session_id, cwd, …). Sending is detached so the hook returns at once.
// Settings come from ~/.claude/kakao-notify/config.json (written by the skill):
//   { "title": "<self chat window title>", "minMinutes": 3, "wait": true }
// KAKAO_NOTIFY_DRY=1 prints the message instead of sending.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const event = process.argv[2];

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function readConfig() {
  const file = path.join(os.homedir(), ".claude", "kakao-notify", "config.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const input = readStdin();
const config = readConfig();
const session = String(input.session_id || "default").replace(/[^\w-]/g, "");
const stamp = path.join(os.tmpdir(), `kakao-notify-${session}`);
const folder = path.basename(input.cwd || process.cwd());

function send(message) {
  if (process.env.KAKAO_NOTIFY_DRY === "1") {
    console.log(`DRY: ${message}`);
    return;
  }
  if (!config.title) return; // not set up yet — stay quiet rather than paste into a wrong window
  const child = spawn("bash", [path.join(here, "kakao_send.sh"), message], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KAKAO_SELF_TITLE: config.title },
  });
  child.unref();
}

if (event === "start") {
  fs.writeFileSync(stamp, String(Date.now()));
} else if (event === "stop") {
  let began = 0;
  try {
    began = Number(fs.readFileSync(stamp, "utf8"));
  } catch {}
  const minutes = began ? (Date.now() - began) / 60000 : 0;
  const min = Number(config.minMinutes ?? process.env.KAKAO_MIN_MINUTES ?? 3);
  if (began && minutes >= min) send(`✅ ${folder} 작업 끝 (${Math.round(minutes)}분)`);
} else if (event === "wait") {
  // The idle reminder ("waiting for your input") follows every finished turn — the stop message already covered it
  const idle = input.notification_type === "idle_prompt" || /waiting for your input/i.test(input.message || "");
  if (config.wait !== false && !idle) send(`⏳ ${folder} 확인이 필요해요`);
} else {
  console.error("usage: node notify.mjs start|stop|wait  (hook JSON on stdin)");
  process.exit(1);
}
