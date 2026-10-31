#!/usr/bin/env bash
# env-merge.sh <app> — build /srv/<app>/.env (mode 600) from three pieces, in this order:
#   .env.fixed      copied from the repo's <deploy dir>/env.fixed — committed, no secrets (host names, expiry …)
#   .env.generated  made on the box by bootstrap-keys.sh — Postgres password, JWT secret, anon/service keys …
#   .env.pushed     sent from your machine by deploy/env-push.sh — third-party API keys
#
#   /srv/ops/ops/env-merge.sh app1        (deploy.sh and env-push.sh call it; apply with `dc app1 up -d`)
#
# Every `$` is doubled: compose interpolates its --env-file, so a value like pbkdf2$210000$salt$hash would otherwise
# lose everything after each `$`. Services therefore read values through `environment:` (interpolated, `$$` → `$`),
# never through `env_file:` (which would hand them the literal `$$`).
set -euo pipefail
app=${1:?usage: env-merge.sh <app>}; d=/srv/$app; umask 077
dir=$(awk -v a="$app" '$1 == a { print $2; exit }' /srv/ops/ops/apps.conf 2>/dev/null || true)
[ -n "$dir" ] || { echo "unknown app '$app' — add it to /srv/ops/ops/apps.conf" >&2; exit 2; }
[ -f "$d/.env.generated" ] || { echo "no $d/.env.generated — run bootstrap-keys.sh $app first" >&2; exit 1; }
if [ -f "$d/repo/$dir/env.fixed" ]; then cp "$d/repo/$dir/env.fixed" "$d/.env.fixed"; fi
parts=()
for p in "$d/.env.fixed" "$d/.env.generated" "$d/.env.pushed"; do
  if [ -f "$p" ]; then parts+=("$p"); fi
done
# awk ends every line with a newline, so a piece without a final newline cannot glue its last line to the next piece
awk '{ gsub(/\$/, "$$"); print }' "${parts[@]}" > "$d/.env.new"
mv "$d/.env.new" "$d/.env"
echo "merged: $(wc -l < "$d/.env" | tr -d ' ') lines from ${#parts[@]} pieces"
