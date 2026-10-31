#!/usr/bin/env bash
# bootstrap-db.sh <app> — once, after `dc <app> up -d db` is healthy and BEFORE storage/auth start. Idempotent.
#
#   dc app1 up -d --wait db && /srv/ops/ops/bootstrap-db.sh app1
#
# Applies ops/db-bootstrap.sql as supabase_admin. The password travels on stdin as a psql \set line (it is hex only,
# so it needs no quoting), not as an argument that `ps` would show.
set -euo pipefail
app=${1:?usage: bootstrap-db.sh <app>}
PW=$(grep '^POSTGRES_PASSWORD=' "/srv/$app/.env.generated" | cut -d= -f2-)
[ -n "$PW" ] || { echo "no POSTGRES_PASSWORD in /srv/$app/.env.generated — run bootstrap-keys.sh first" >&2; exit 1; }
{ printf "\\\\set pw '%s'\n" "$PW"; cat /srv/ops/ops/db-bootstrap.sql; } \
  | docker exec -i "$app-db-1" psql -U supabase_admin -v ON_ERROR_STOP=1 -qAt -f -
echo "db bootstrap ok ($app)"
