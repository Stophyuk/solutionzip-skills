#!/usr/bin/env bash
# bootstrap-keys.sh <app> — generate an app's secrets once into /srv/<app>/.env.generated (mode 600). Prints no value.
#
#   /srv/ops/ops/bootstrap-keys.sh app1
#
# Run it BEFORE the first `dc <app> up -d db`: the image's init scripts read POSTGRES_PASSWORD and JWT_SECRET only on
# the very first start of an empty volume.
# Refuses when the file exists. A new JWT_SECRET ends every session and invalidates the anon/service keys baked into
# builds; on a rebuilt box RESTORE this file from the nightly env-<day>.tgz instead (ops/restore.md).
set -euo pipefail
app=${1:?usage: bootstrap-keys.sh <app>}; out=/srv/$app/.env.generated
if [ -e "$out" ]; then
  echo "exists: $out — regenerating would invalidate every key and session. Restore it from a backup, or delete it only if you really mean it." >&2
  exit 1
fi
umask 077
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() {   # $1=role $2=secret — HS256, 10 years, the claims self-hosted Supabase expects
  local now exp h p s
  now=$(date +%s); exp=$((now + 10*365*86400))
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  p=$(printf '{"iss":"supabase","ref":"%s","role":"%s","iat":%s,"exp":%s}' "$app" "$1" "$now" "$exp" | b64url)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -mac HMAC -macopt "key:$2" -binary | b64url)
  printf '%s.%s.%s' "$h" "$p" "$s"
}
PG=$(openssl rand -hex 24)        # hex only → safe inside connection URLs without escaping
JWT=$(openssl rand -hex 32)       # 64 chars (PostgREST / GoTrue want at least 32)
{
  echo "POSTGRES_PASSWORD=$PG"
  echo "JWT_SECRET=$JWT"
  echo "ANON_KEY=$(jwt anon "$JWT")"
  echo "SERVICE_ROLE_KEY=$(jwt service_role "$JWT")"
  # host cron → app (ops/cron-call.sh sends it as a bearer header)
  echo "CRON_SECRET=$(openssl rand -hex 24)"
  # fixed Next.js Server Actions key (Dockerfile): the action IDs stay the same across deploys, so a page left open
  # through a deploy can still submit its form
  echo "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$(openssl rand -base64 32)"
  # App keys that must outlive the box go here too, generated once: link-signing secrets (mailed unsubscribe links stop
  # working with a new one), hash peppers (every stored hash stops matching). Example:
  #   echo "LINK_SIGNING_SECRET=$(openssl rand -hex 32)"
} > "$out"
echo "wrote $out ($(wc -l < "$out" | tr -d ' ') keys)"
