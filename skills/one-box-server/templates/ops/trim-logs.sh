#!/usr/bin/env bash
# trim-logs.sh [dir] — nightly (cron.d/ops): Caddy access logs (they hold client IPs) keep DAYS days, matching what
# the privacy policy promises.
#
#   sudo /srv/ops/ops/trim-logs.sh                 # /srv/edge/logs
#
# Caddy rolls files by size only (roll_size), and roll_keep_for ages out only *rolled* files — the file being written
# can hold lines of any age when traffic is low. So: drop rolled files older than DAYS, and rewrite each live file
# without the lines whose `ts` is older (only when there is something to drop).
set -euo pipefail
DIR=${1:-/srv/edge/logs}
DAYS=30
[ -d "$DIR" ] || { echo "no $DIR" >&2; exit 1; }
find "$DIR" -type f -name '*.log*' ! -name '*.log' -mtime +$DAYS -delete
python3 - "$DIR" "$DAYS" <<'PY'
import json, pathlib, sys, time
root, days = pathlib.Path(sys.argv[1]), int(sys.argv[2])
cutoff = time.time() - days * 86400
def fresh(line):
    try:
        return float(json.loads(line).get('ts', 0)) >= cutoff
    except (ValueError, TypeError, AttributeError):
        return False          # an undatable line cannot prove it is young enough to keep
for f in sorted(root.glob('*.log')):
    with open(f, 'r+', encoding='utf-8', errors='replace') as fh:
        lines = fh.readlines()
        keep = [l for l in lines if fresh(l)]
        if len(keep) == len(lines):
            continue
        fh.seek(0); fh.writelines(keep); fh.truncate()   # same inode — Caddy keeps appending (O_APPEND)
    print(f'{f.name}: dropped {len(lines) - len(keep)} of {len(lines)} lines')
PY
echo "$(date -Is) trim ok"
