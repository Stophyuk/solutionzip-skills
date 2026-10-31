#!/usr/bin/env bash
# migrate.sh <app> <dir> [--dry-run] — apply the *.sql files in <dir> that supabase_migrations.schema_migrations does
# not list yet, in file-name order, as postgres. Each file and its record are one transaction: a file that fails
# leaves nothing behind and is tried again next time.
#
#   migrate.sh app1 /srv/app1/repo/supabase/migrations --dry-run   # pending file names only (deploy.sh uses this)
#   migrate.sh app1 /srv/app1/repo/supabase/migrations
#
# File names follow the Supabase CLI (<version>_<name>.sql) and so does the table, so `supabase db push --db-url …`
# through an SSH tunnel and this script can be mixed.
# The production DB is written through `deploy.sh --migrate` (dump first). By hand only after saying what will change.
# A statement that cannot run inside a transaction (create index concurrently, vacuum) fails here — apply that one by
# hand, then record its version in the table.
set -euo pipefail
app=${1:?usage: migrate.sh <app> <dir> [--dry-run]}; dir=${2:?dir}; dry=${3:-}
LC_COLLATE=C   # glob order = byte order, the same on every machine
pq() { dc "$app" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
pq -c "set client_min_messages = warning" \
   -c "create schema if not exists supabase_migrations" \
   -c "create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)" </dev/null
applied=$(pq -c "select version from supabase_migrations.schema_migrations" </dev/null)
shopt -s nullglob
files=("$dir"/*.sql)
if [ ${#files[@]} -eq 0 ]; then echo "no *.sql in $dir" >&2; exit 0; fi
for f in "${files[@]}"; do
  base=$(basename "$f" .sql); ver=${base%%_*}; name=${base#*_}
  if grep -qxF -- "$ver" <<<"$applied"; then continue; fi
  if [ "$dry" = "--dry-run" ]; then echo "$base"; continue; fi
  echo "apply $base"
  # version and name go in as psql variables (:'ver' is quoted by psql), never pasted into the SQL text
  { cat "$f"; printf '\n%s\n' "insert into supabase_migrations.schema_migrations (version, name) values (:'ver', :'name');"; } \
    | pq -1 -v ver="$ver" -v name="$name" -f -
done
[ "$dry" = "--dry-run" ] && exit 0
# PostgREST caches the schema: without this, new tables and columns answer 404 / "column not found" until a restart
pq -c "notify pgrst, 'reload schema'" </dev/null
echo "migrations up to date"
