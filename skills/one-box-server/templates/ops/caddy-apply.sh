#!/usr/bin/env bash
# caddy-apply.sh [file] — the only way to put a Caddyfile live (default: this repo's edge/Caddyfile → /srv/edge/Caddyfile).
#
#   git -C /srv/ops pull && /srv/ops/ops/caddy-apply.sh
#
# Validates the new file inside the running container, keeps a dated copy (last five), writes the live file IN PLACE
# — the container bind-mounts it by inode, so a cp-over-rename or a git checkout would leave Caddy reading the old
# one — then `caddy reload`. A refused reload puts the old file back.
# Never apply by restarting the container: a bad file then keeps every host down, while reload refuses it and the
# old config keeps serving.
set -uo pipefail
src=${1:-/srv/ops/edge/Caddyfile}
live=/srv/edge/Caddyfile
c=edge-caddy-1
# lock outside /tmp: fs.protected_regular=2 keeps root out of a file another user created there
exec 9>/srv/edge/.apply.lock; flock -n 9 || { echo "another caddy-apply is running" >&2; exit 1; }

docker cp "$src" "$c:/tmp/Caddyfile.next" >/dev/null || exit 1
if ! docker exec "$c" caddy validate --config /tmp/Caddyfile.next --adapter caddyfile; then
  docker exec "$c" rm -f /tmp/Caddyfile.next; echo "invalid — nothing applied" >&2; exit 1
fi
docker exec "$c" rm -f /tmp/Caddyfile.next
if cmp -s "$src" "$live"; then echo "unchanged — validated only"; exit 0; fi

bak="$live.bak-$(date +%Y%m%d%H%M)"
cp -p "$live" "$bak" || exit 1
cat "$src" > "$live"
if ! docker exec "$c" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  cat "$bak" > "$live"; echo "reload refused — $live put back from $bak" >&2; exit 1
fi
# shellcheck disable=SC2012  # backup names are fixed-format dates, no spaces
ls -1t "$live".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
echo "applied — previous file kept as $bak"
