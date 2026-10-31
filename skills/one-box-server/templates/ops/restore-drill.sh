#!/usr/bin/env bash
# restore-drill.sh <app> [YYYY-MM-DD] — the monthly rehearsal (ops/restore.md): pull a nightly dump from the bucket,
# restore it into a throwaway Postgres (same image as the live db, no network) and print it next to the live database.
#
#   sudo /srv/ops/ops/restore-drill.sh app1               # last night's dump
#   sudo /srv/ops/ops/restore-drill.sh app1 2026-01-31    # a given day
#
# Every app: row counts of every table in public + auth, drill vs live (only the tables that differ are listed).
# App-specific checks (money totals, a ledger invariant): one "label|SQL returning one value" per line in
# ops/drill.d/<app>.txt, run on both sides. Nothing here touches the running stack. Record the result in restore-log.md.
set -euo pipefail
. /srv/ops/ops/ops.conf
export AWS_PROFILE=$BACKUP_AWS_PROFILE PATH=/usr/local/bin:/usr/bin:/bin
app=${1:?usage: restore-drill.sh <app> [YYYY-MM-DD]}; day=${2:-$(date +%F)}
s3() { aws ${BACKUP_ENDPOINT:+--endpoint-url "$BACKUP_ENDPOINT"} s3 "$@"; }
work=$(mktemp -d /srv/ops/drill.XXXX)
# cleanup names its own files — no recursive delete on a variable path
trap 'docker rm -f "drill-$app" >/dev/null 2>&1 || true; rm -f "$work/db.dump" "$work/drill.rows" "$work/live.rows"; rmdir "$work" 2>/dev/null || true' EXIT
t0=$(date +%s)
s3 cp "$BACKUP_BUCKET/daily/$day/$app-db-$day.dump" "$work/db.dump" --only-show-errors
img=$(docker inspect -f '{{.Config.Image}}' "$app-db-1")
docker run -d --name "drill-$app" --network none -e POSTGRES_PASSWORD=drill -v "$work:/drill:ro" "$img" >/dev/null
for _ in $(seq 1 90); do docker exec "drill-$app" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
# restore public + auth only — the other schemas belong to the image and already exist in the fresh container
errors=$(docker exec "drill-$app" pg_restore -U supabase_admin -d postgres --no-owner --clean --if-exists -n public -n auth /drill/db.dump 2>&1 | grep -c 'error:' || true)
# </dev/null: inside the `while read` below, a command that reads stdin would swallow the rest of the list
sql() { docker exec "$1" psql -U supabase_admin -d postgres -qAt -c "$2" </dev/null; }
# "schema.table=rows" for every table in public and auth — the same query on both sides
rows="select n.nspname || '.' || c.relname || '=' ||
    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname in ('public', 'auth') order by 1"
sql "drill-$app" "$rows" > "$work/drill.rows"
sql "$app-db-1" "$rows" > "$work/live.rows"
total() { awk -F= '{ s += $2 } END { print s + 0 }' "$1"; }
differ=$(awk -F= 'NR == FNR { d[$1] = $2; next } { l[$1] = $2 }
  END { for (k in l) if (!(k in d) || d[k] != l[k]) printf "  %s drill=%s live=%s\n", k, (k in d ? d[k] : "-"), l[k]
        for (k in d) if (!(k in l)) printf "  %s drill=%s live=-\n", k, d[k] }' "$work/drill.rows" "$work/live.rows" | sort)
echo "dump      $app $day  ($(du -h "$work/db.dump" | cut -f1))"
echo "restore   errors=$errors"
echo "tables    $(wc -l < "$work/live.rows" | tr -d ' ') in public + auth · rows drill=$(total "$work/drill.rows") live=$(total "$work/live.rows")"
if [ -n "$differ" ]; then printf 'differs   (live may be ahead by what came after the dump)\n%s\n' "$differ"; else echo "differs   none"; fi
extra=/srv/ops/ops/drill.d/$app.txt
if [ -f "$extra" ]; then
  while IFS='|' read -r label query; do
    case "$label" in ''|'#'*) continue ;; esac
    echo "check     $label drill=$(sql "drill-$app" "$query") live=$(sql "$app-db-1" "$query")"
  done < "$extra"
fi
echo "minutes   $(( ($(date +%s) - t0 + 59) / 60 ))"
