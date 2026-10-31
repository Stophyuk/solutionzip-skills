#!/usr/bin/env bash
# Send a message to KakaoTalk "나와의 채팅" (macOS, GUI automation — no server, bot or token).
#
#   KAKAO_SELF_TITLE="<self chat window title>" kakao_send.sh "message"
#   echo "message" | KAKAO_SELF_TITLE="…" kakao_send.sh
#
# KAKAO_SELF_TITLE is the exact title of your "나와의 채팅" window (usually your own name). The message is sent
# only when KakaoTalk's front window has that title; otherwise it prints SKIP and exits 0.
# KAKAO_NOTIFY_DRY=1 prints the message instead of sending (for testing).
set -euo pipefail

if [[ $# -ge 1 ]]; then
  MSG="$1"
else
  MSG="$(cat)"
fi

if [[ -z "${MSG// /}" ]]; then
  echo "ERROR: empty message" >&2
  exit 1
fi

if [[ "${KAKAO_NOTIFY_DRY:-}" == "1" ]]; then
  echo "DRY: ${MSG}"
  exit 0
fi

if [[ -z "${KAKAO_SELF_TITLE:-}" ]]; then
  echo "ERROR: set KAKAO_SELF_TITLE to the title of your 나와의 채팅 window" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/osascript "${SCRIPT_DIR}/kakao_self.applescript" "$MSG" "$KAKAO_SELF_TITLE"
