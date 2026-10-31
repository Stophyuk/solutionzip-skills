#!/usr/bin/env bash
# deploy.sh [--migrate] — run on your machine: gate → git push → on the box: pull · env-merge · migrations · build ·
# swap the app container → check the public URL.
#
#   bash deploy/deploy.sh             # code only; stops (app untouched) if the DB has migrations not applied yet
#   bash deploy/deploy.sh --migrate   # dump first (predeploy/<sha>.dump, newest three), apply them, then build
#
# A push alone ships nothing: this script is the one road to production — and to the production DB. Images roll
# back, the DB does not (migrations only add), so pending migrations stop the run until the owner has been told what
# changes and --migrate is given.
# The running build is kept under its git sha (newest two); if the new one is not healthy within 120 s,
# ops/rollback.sh puts the previous one back.
set -euo pipefail
APP=app1                                  # the name in the box's apps.conf
VM=${VM:-myserver}                        # Host alias in ~/.ssh/config
URL=https://app1.example.com/             # must answer 200 after the swap
MIGRATIONS=repo/supabase/migrations       # relative to /srv/$APP on the box
migrate=0
case "${1:-}" in --migrate) migrate=1 ;; "") ;; *) echo "usage: deploy.sh [--migrate]" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "main 에서만 배포한다" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "커밋하지 않은 변경이 있다" >&2; git status --short >&2; exit 1; }
pnpm check        # the gate: typecheck · lint · tests — your project's command
git push origin main

# The remote script arrives on stdin — every command in it that reads stdin gets </dev/null, or it swallows the rest
# of the script and the deploy stops halfway without an error.
ssh "$VM" "APP=$APP MIGRATE=$migrate MIGRATIONS=$MIGRATIONS bash -s" <<'REMOTE'
set -euo pipefail
# one deploy at a time; cron jobs that must not overlap a deploy take the same lock (ops/cron.d)
exec 9>/tmp/deploy.lock; flock 9
cd "/srv/$APP"
git -C repo pull --ff-only
sha=$(git -C repo rev-parse --short HEAD)
/srv/ops/ops/env-merge.sh "$APP"
pending=$(/srv/ops/ops/migrate.sh "$APP" "$MIGRATIONS" --dry-run </dev/null)
if [ -n "$pending" ]; then
  if [ "$MIGRATE" != 1 ]; then
    echo "운영 DB에 안 올린 마이그레이션이 있다 — 무엇이 바뀌는지 말한 뒤 --migrate 로 다시 돌린다 (앱은 그대로 둠):" >&2
    echo "$pending" >&2
    exit 1
  fi
  umask 077   # the dump holds every user's rows — owner-only
  mkdir -p predeploy
  dc "$APP" exec -T db pg_dump -U supabase_admin -Fc postgres </dev/null > "predeploy/$sha.dump"
  # shellcheck disable=SC2012  # dump names are git shas, no spaces
  ls -1t predeploy/*.dump | tail -n +4 | xargs -r rm -f
  echo "migrate: $(tr '\n' ' ' <<<"$pending")"
  /srv/ops/ops/migrate.sh "$APP" "$MIGRATIONS" </dev/null
fi
prev=$(cat app.sha 2>/dev/null || echo initial)
if docker image inspect "$APP/app:latest" >/dev/null 2>&1; then docker tag "$APP/app:latest" "$APP/app:$prev"; fi
dc "$APP" build app </dev/null
if ! dc "$APP" up -d --wait --wait-timeout 120 app </dev/null; then
  echo "not healthy — back to $prev" >&2
  /srv/ops/ops/rollback.sh "$APP" "$prev" </dev/null
  exit 1
fi
echo "$sha" > app.sha
# keep the newest two sha tags; prune only drops untagged layers
{ docker images "$APP/app" --format '{{.CreatedAt}}|{{.Tag}}' | grep -v '|latest$' | sort -r | cut -d'|' -f2 | tail -n +3 \
  | xargs -r -I{} docker rmi "$APP/app:{}" >/dev/null; } || true
docker image prune -f >/dev/null
echo "app.sha=$sha (prev $prev)"
dc "$APP" ps app </dev/null
echo done
REMOTE

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL")
echo "$URL → $code"
[ "$code" = 200 ]
