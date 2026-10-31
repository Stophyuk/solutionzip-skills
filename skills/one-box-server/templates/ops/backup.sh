#!/usr/bin/env bash
# backup.sh — nightly (cron.d/ops): for every app in apps.conf a pg_dump -Fc and its storage volume as tar, plus every
# .env.generated and the live Caddyfile → the private bucket in ops.conf, under daily/<YYYY-MM-DD>/.
#
#   sudo sh -c '/srv/ops/ops/backup.sh >> /srv/ops/backup.log 2>&1'     # by hand, logged like the cron run
#
# Retention: 14 daily + the 1st of each month for ~3 months. The script deletes; the bucket needs no lifecycle rules.
# The bucket holds the generated keys too — keep it private, with a key that can reach this bucket only.
# .env.pushed is not copied: its source is your machine (deploy/env-push.sh).
# A failed night must not pass silently: the ERR trap mails, and check.sh mails when today's "backup ok" line is missing.
set -euo pipefail
. /srv/ops/ops/ops.conf
export AWS_PROFILE=$BACKUP_AWS_PROFILE PATH=/usr/local/bin:/usr/bin:/bin
trap 'echo "$(date -Is) backup FAILED at line $LINENO"; /srv/ops/ops/alert.sh backup-failed "[box] 백업 실패" "backup.sh 가 $LINENO 줄에서 멈췄습니다. /srv/ops/backup.log 를 보세요."' ERR
case "$BACKUP_BUCKET" in s3://your-*|"") echo "set BACKUP_BUCKET in /srv/ops/ops/ops.conf" >&2; exit 1 ;; esac
s3() { aws ${BACKUP_ENDPOINT:+--endpoint-url "$BACKUP_ENDPOINT"} s3 "$@"; }
DAY=$(date +%F); TMP=/srv/ops/backups; mkdir -p "$TMP"; umask 077
find "$TMP" -type f -mtime +1 -delete
for app in $(awk '!/^#/ && NF { print $1 }' /srv/ops/ops/apps.conf); do
  [ -f "/srv/$app/.env" ] || continue
  # grep without -q reads to the end, so pipefail never sees a SIGPIPE from dc (that would read as "db down")
  if ! dc "$app" ps --status running --services 2>/dev/null | grep -x db >/dev/null; then echo "skip $app (db down)"; continue; fi
  dc "$app" exec -T db pg_dump -U supabase_admin -Fc postgres </dev/null > "$TMP/$app-db-$DAY.dump"
  if docker volume inspect "${app}_storage_data" >/dev/null 2>&1; then
    docker run --rm -v "${app}_storage_data:/data:ro" alpine tar -C /data -czf - . > "$TMP/$app-storage-$DAY.tgz"
  fi
done
# shellcheck disable=SC2046  # the file list is meant to split; the names are fixed paths without spaces
( cd / && tar -czf "$TMP/env-$DAY.tgz" $(ls srv/*/.env.generated srv/edge/Caddyfile 2>/dev/null) )
s3 cp "$TMP" "$BACKUP_BUCKET/daily/$DAY/" --recursive --only-show-errors --exclude '*' --include "*-$DAY.*"
now=$(date +%s)
s3 ls "$BACKUP_BUCKET/daily/" | awk '{print $2}' | tr -d / | while read -r d; do
  # only a well-formed day ever reaches `rm --recursive` — an empty or odd name would widen it to daily/ itself
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
  age_days=$(( (now - $(date -d "$d" +%s)) / 86400 )); dom=${d##*-}
  if { [ "$age_days" -gt 14 ] && [ "$dom" != "01" ]; } || [ "$age_days" -gt 92 ]; then
    s3 rm "$BACKUP_BUCKET/daily/$d/" --recursive --only-show-errors
  fi
done
use=$(df --output=pcent / | tail -1 | tr -dc 0-9); [ "$use" -ge 85 ] && echo "WARNING disk ${use}% used" >&2
echo "$(date -Is) backup ok"
