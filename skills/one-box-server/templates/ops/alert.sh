#!/usr/bin/env bash
# alert.sh <key> <subject> [body] — mail the owner. Never fails the caller (exit 0 even when sending fails).
#
#   /srv/ops/ops/alert.sh disk "[box] 디스크 85%" "$(df -h /)"
#
# Throttle: one mail per key per ALERT_EVERY_SEC (default 6 h). Alerts held back in between are counted and the count
# goes into the next mail — an hourly check that keeps failing sends four mails a day, not twenty-four.
# Config: /srv/ops/alert.env — root, mode 600, outside the repo:
#   RESEND_API_KEY=<YOUR_KEY>
#   ALERT_TO=<owner address>
#   ALERT_FROM=<sender on a domain your mail API has verified>
# Sends through the Resend HTTP API; another provider only needs the curl call at the end changed.
# The key reaches curl through a file descriptor, so it never shows in `ps`.
set -uo pipefail
key=$(printf '%s' "${1:?usage: alert.sh <key> <subject> [body]}" | tr -c 'A-Za-z0-9._-' '_')
subject=${2:?subject}; body=${3:-}
conf=/srv/ops/alert.env
if [ ! -r "$conf" ]; then logger -t ops-alert "no $conf — $subject"; exit 0; fi
. "$conf"
dir=/var/lib/ops-alert; mkdir -p "$dir"; stamp="$dir/$key"
every=${ALERT_EVERY_SEC:-21600}
if [ -f "$stamp" ] && [ $(( $(date +%s) - $(date -r "$stamp" +%s) )) -lt "$every" ]; then
  echo $(( $(cat "$stamp.held" 2>/dev/null || echo 0) + 1 )) > "$stamp.held"
  logger -t ops-alert "held $key"
  exit 0
fi
held=$(cat "$stamp.held" 2>/dev/null || echo 0); rm -f "$stamp.held"; touch "$stamp"
[ "$held" -gt 0 ] && body="$body

(그사이 같은 알림 ${held}건은 보내지 않았습니다)"
payload=$(jq -n --arg from "${ALERT_FROM:-}" --arg to "${ALERT_TO:-}" --arg s "$subject" \
  --arg t "$body

— $(hostname) · $(date '+%F %T %Z')" '{from: $from, to: [$to], subject: $s, text: $t}')
code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST https://api.resend.com/emails \
  -H @<(printf 'Authorization: Bearer %s\n' "${RESEND_API_KEY:-}") -H 'Content-Type: application/json' -d "$payload") || code=000
case "$code" in 2??) logger -t ops-alert "sent $key" ;; *) logger -t ops-alert "send failed $key ($code)" ;; esac
exit 0
