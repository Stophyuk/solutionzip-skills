#!/usr/bin/env bash
# cron-call.sh <app> <path> [max-seconds] — what /etc/cron.d/<app> runs: call the app on 127.0.0.1 with its CRON_SECRET.
#
#   /srv/ops/ops/cron-call.sh app1 /api/cron/sweep 120
#
# Port: the third column of /srv/ops/ops/apps.conf. Secret: CRON_SECRET in /srv/<app>/.env.generated, sent as a bearer
# header through a file descriptor (never on curl's command line, where `ps` shows it).
# The edge answers 404 for /api/cron/* (edge/Caddyfile), so only the host itself can reach these routes.
# Every call lands in the journal (journalctl -t cron-<app>); anything but 2xx mails the owner through alert.sh —
# including the app being down (code 000), which the app itself could never report.
set -uo pipefail
app=${1:?usage: cron-call.sh <app> <path> [max-seconds]}; path=${2:?path}; max=${3:-120}
port=$(awk -v a="$app" '$1 == a { print $3; exit }' /srv/ops/ops/apps.conf 2>/dev/null)
secret=$(grep -E '^CRON_SECRET=' "/srv/$app/.env.generated" 2>/dev/null | tail -1 | cut -d= -f2-)
if [ -z "$port" ] || [ -z "$secret" ]; then
  logger -t "cron-$app" "no port (apps.conf) or CRON_SECRET (.env.generated) for $app"
  /srv/ops/ops/alert.sh "cron-$app-conf" "[$app] 크론 설정을 읽지 못함" "apps.conf 의 포트나 /srv/$app/.env.generated 의 CRON_SECRET 이 없습니다."
  exit 1
fi
out=$(mktemp); trap 'rm -f "$out"' EXIT
code=$(curl -sS -o "$out" -w '%{http_code}' -m "$max" -H @<(printf 'Authorization: Bearer %s\n' "$secret") \
  "http://127.0.0.1:$port$path" 2>>"$out") || code=000
logger -t "cron-$app" "$path $code $(head -c 400 "$out" | tr '\n' ' ')"
case "$code" in 2??) exit 0 ;; esac
/srv/ops/ops/alert.sh "cron-$app-$path" "[$app] 크론 실패 · $path · $code" "$(head -c 2000 "$out")"
exit 1
