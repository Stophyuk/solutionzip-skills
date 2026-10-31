#!/usr/bin/env bash
# env-push.sh — run on your machine: send the secrets the box cannot make itself (third-party API keys, admin login
# hash …) from a local env file to /srv/<app>/.env.pushed, then merge. Values travel only through the pipe; nothing
# is printed.
#
#   bash deploy/env-push.sh                               # reads .env.local at the repo root
#   ENV_FILE=.env.production.local bash deploy/env-push.sh
#   ssh myserver 'dc app1 up -d'                          # then apply (or run deploy.sh)
#
# The box REPLACES .env.pushed with what arrives: a name missing locally disappears on the box too. So the names the
# app cannot run without (REQUIRED) are checked first, and nothing is sent when one is missing.
# What the box generates (Postgres password, JWT secret, anon/service keys, CRON_SECRET) is not sent from here.
set -euo pipefail
APP=app1
VM=${VM:-myserver}
ENV_FILE=${ENV_FILE:-.env.local}
KEYS='RESEND_API_KEY|OPENAI_API_KEY|ADMIN_PASSWORD_HASH'   # names to send — a name not in the file is skipped
REQUIRED='RESEND_API_KEY'                                  # names that must be there, with a value
cd "$(dirname "$0")/.."
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE" >&2; exit 1; }
for k in ${REQUIRED//|/ }; do
  grep -qE "^$k=." "$ENV_FILE" || { echo "$ENV_FILE has no value for $k — nothing sent" >&2; exit 1; }
done
grep -E "^(${KEYS})=" "$ENV_FILE" | ssh "$VM" "umask 077 && cat > /srv/$APP/.env.pushed && /srv/ops/ops/env-merge.sh $APP"
echo "sent $(grep -cE "^(${KEYS})=" "$ENV_FILE") names to $VM:/srv/$APP/.env.pushed — apply: ssh $VM 'dc $APP up -d'"
