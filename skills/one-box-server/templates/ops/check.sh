#!/usr/bin/env bash
# check.sh [--test] — hourly (cron.d/ops): the box and the apps on it. Anything off → alert.sh (one mail per key per 6 h).
#
#   sudo /srv/ops/ops/check.sh --test                  # one test mail: is the alert path alive?
#   sudo ALERT=echo DISK_PCT=1 /srv/ops/ops/check.sh   # try a branch without mailing
#
# Read-only, bar its CPU counter in /var/lib/ops-check. App-specific checks (a cron that must succeed daily, a data
# invariant, sign-up spikes) live in ops/check.d/*.sh — each runs with ALERT set; see check.d/app1.sh.example.
set -uo pipefail
A=${ALERT:-/srv/ops/ops/alert.sh}
DISK_PCT=${DISK_PCT:-80}; MEM_MB=${MEM_MB:-400}; SWAP_MB=${SWAP_MB:-2048}
# Caddy renews when about a third of a certificate's life is left (~30 days for 90-day certificates), so 22 days left
# means renewal has been failing for more than a week. Lower it if your CA issues shorter-lived certificates.
CERT_DAYS=${CERT_DAYS:-22}
if [ "${1:-}" = "--test" ]; then
  "$A" check-test "[box] 감시 시험 메일" "check.sh --test 로 보낸 시험입니다. 이 메일이 왔으면 알림 길이 살아 있습니다."
  exit 0
fi

# disk · memory · swap
use=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[ "$use" -ge "$DISK_PCT" ] && "$A" disk "[box] 디스크 ${use}%" "$(df -h /)"
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
# swap really out on disk: SwapCached pages are copies already back in RAM, so Total − Free alone overstates it
swap=$(awk '/SwapTotal/ {t=$2} /SwapFree/ {f=$2} /SwapCached/ {c=$2} END {print int((t-f-c)/1024)}' /proc/meminfo)
[ "$avail" -lt "$MEM_MB" ] && "$A" mem "[box] 남은 메모리 ${avail}MB" "$(free -m)"
[ "$swap" -gt "$SWAP_MB" ] && "$A" swap "[box] 스왑 ${swap}MB 사용 중" "$(free -m)"

# OOM kills in the last hour
oom=$(journalctl -k --since -1h -q -o cat 2>/dev/null | grep -iE 'out of memory|oom-kill' || true)
[ -n "$oom" ] && "$A" oom "[box] 메모리 부족으로 프로세스가 죽음" "$(tail -5 <<<"$oom")"

# containers: restart: unless-stopped keeps them up — so unhealthy / exited / restarting means something is wrong
bad=$(docker ps -a --format '{{.Names}} · {{.Status}}' | grep -E 'unhealthy|Exited|Restarting' || true)
[ -n "$bad" ] && "$A" containers "[box] 컨테이너 이상" "$bad"

# certificates: every live site block in /srv/edge/Caddyfile, read from this box itself (SNI on 127.0.0.1:443)
for h in $(grep -E '^[a-z0-9.-]+\.[a-z]+ *\{' /srv/edge/Caddyfile | tr -d '{ '); do
  end=$(timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$h" </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -z "$end" ]; then "$A" "cert-$h" "[box] 인증서를 읽지 못함 · $h" "Caddy 가 이 이름의 인증서를 내주지 않습니다."; continue; fi
  left=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  [ "$left" -lt "$CERT_DAYS" ] && "$A" "cert-$h" "[box] 인증서 ${left}일 남음 · $h" "만료 $end — Caddy 의 자동 갱신이 실패하고 있을 수 있습니다."
done

# nightly backup (cron.d/ops, 03:17): after 04:00 today's "backup ok" line must be there
if [ "$(date +%H)" -ge 4 ] && ! grep -q "^$(date +%F)T.* backup ok" /srv/ops/backup.log 2>/dev/null; then
  "$A" backup "[box] 오늘 백업 기록이 없음" "$(tail -5 /srv/ops/backup.log 2>/dev/null)"
fi

# app-specific checks — executables only, so an .example file never runs
for f in /srv/ops/ops/check.d/*.sh; do
  [ -x "$f" ] || continue
  ALERT="$A" "$f" || logger -t ops-check "check.d $(basename "$f") exited $?"
done

# CPU since the last run: busy = user+nice+system+irq+softirq. Steal climbs when a burstable plan runs out of credits;
# logged only — the provider's own burst/CPU alarm (if it has one) does the alerting.
cur=$(awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat)
prev=$(cat /var/lib/ops-check/cpu.prev 2>/dev/null || true)
{ mkdir -p /var/lib/ops-check && echo "$cur" > /var/lib/ops-check/cpu.prev; } 2>/dev/null
read -r cpu steal < <(awk -v a="$prev" -v b="$cur" 'BEGIN {
  if (split(a, p, " ") < 8) { print "- -"; exit }
  split(b, c, " "); t = 0; for (k = 1; k <= 8; k++) { d[k] = c[k] - p[k]; t += d[k] }
  if (t <= 0) { print "- -"; exit }
  printf "%.1f%% %.1f%%\n", 100 * (d[1] + d[2] + d[3] + d[6] + d[7]) / t, 100 * d[8] / t }')

logger -t ops-check "ok disk=${use}% avail=${avail}MB swap=${swap}MB cpu=${cpu} steal=${steal}"
exit 0
