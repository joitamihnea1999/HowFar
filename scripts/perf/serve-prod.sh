#!/usr/bin/env bash
# Serve the PRODUCTION build against the local self-host provider stack, for perf
# measurement. LOCAL ONLY. This is the counterpart of `npm run dev:selfhost` but it
# serves `next start` (the optimized build) instead of `next dev` — perf numbers taken
# against `next dev` are void (uncompiled, HMR overhead), so the harness insists on prod.
#
# It reuses the SAME provider overlay (docker/selfhost/env.selfhost.example) so app and
# stack never drift. It does NOT run the one-time imports (see docs/SELFHOST.md); it
# assumes the engines are up + healthy (bring them up with `npm run dev:selfhost` once, or
# this script will start them via the same compose files).
#
# Prereqs: `next build` already run (.next present); catalogue imported (`/api/ready` 200).
# Usage:  bash scripts/perf/serve-prod.sh            # bring up stack (if needed) + next start :3000
#         PERF_PORT=3100 bash scripts/perf/serve-prod.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$APP_ROOT"

PORT="${PERF_PORT:-3000}"
SELF_COMPOSE="docker/selfhost/docker-compose.yml"
APP_COMPOSE="docker-compose.yml"
OVERLAY="docker/selfhost/env.selfhost.example"
WAIT_SECS="${SELFHOST_WAIT_SECS:-300}"
HEALTH_TARGETS=(howfar-postgis howfar-nominatim howfar-ors howfar-photon)

log() { echo "[perf:serve-prod] $*" >&2; }

[ -d .next ] || { log "MISSING .next — run 'npm run build' first (perf numbers require the prod build)."; exit 2; }
[ -f "$OVERLAY" ] || { log "MISSING overlay $OVERLAY"; exit 2; }

# Load the provider overlay into the process env (same mechanism as dev:selfhost — .env
# untouched, Next does not override process env from .env).
set -a
# shellcheck disable=SC1090
source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$OVERLAY")
set +a

# Bring the stack up (idempotent — already-running containers are left as-is).
log "Ensuring stack is up (db + engines) ..."
docker compose -f "$APP_COMPOSE" up -d db >/dev/null
docker compose -f "$SELF_COMPOSE" up -d nominatim ors photon >/dev/null

log "Waiting up to ${WAIT_SECS}s for db + engines to report healthy ..."
deadline=$(( $(date +%s) + WAIT_SECS ))
while :; do
  all=1
  for c in "${HEALTH_TARGETS[@]}"; do
    s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$c" 2>/dev/null || echo absent)"
    [ "$s" = "healthy" ] || all=0
  done
  [ "$all" -eq 1 ] && { log "engines healthy"; break; }
  [ "$(date +%s)" -ge "$deadline" ] && { log "engines not healthy within ${WAIT_SECS}s — aborting"; exit 1; }
  sleep 5
done

log "Serving PROD build on :${PORT} with the self-host overlay (Ctrl-C to stop; engines keep running)."
exec npx next start -p "$PORT"
