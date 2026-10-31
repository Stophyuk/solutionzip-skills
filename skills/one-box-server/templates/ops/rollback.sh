#!/usr/bin/env bash
# rollback.sh <app> [sha] — point <app>/app:latest back at a kept build and restart only the app container.
#
#   /srv/ops/ops/rollback.sh app1            # the newest kept build that is not the one running now
#   /srv/ops/ops/rollback.sh app1 a1b2c3d    # a given build; going forward again is the same command with the newer sha
#
# deploy.sh keeps the previous builds tagged by git sha (newest two). Images do not undo migrations — those only add,
# which is why the previous image keeps working on the newer schema.
set -euo pipefail
app=${1:?usage: rollback.sh <app> [sha]}; want=${2:-}
img=$app/app
cur=$(cat "/srv/$app/app.sha" 2>/dev/null || true)
if [ -z "$want" ]; then
  want=$(docker images "$img" --format '{{.CreatedAt}}|{{.Tag}}' | grep -v '|latest$' | sort -r | cut -d'|' -f2 | grep -vx "${cur:-none}" | head -1 || true)
fi
[ -n "$want" ] || { echo "no earlier build of $img to go back to" >&2; exit 1; }
docker image inspect "$img:$want" >/dev/null
# keep the build being replaced under its own sha, so going forward again is the same command
if [ -n "$cur" ] && [ "$cur" != "$want" ]; then docker tag "$img:latest" "$img:$cur"; fi
docker tag "$img:$want" "$img:latest"
/usr/local/bin/dc "$app" up -d --no-build --wait --wait-timeout 120 app
echo "$want" > "/srv/$app/app.sha"
echo "rolled $app back to $want (was ${cur:-unknown})"
