#!/usr/bin/env bash
# Stop the local self-host dev stack — the matching down path for dev-selfhost.sh.
# LOCAL ONLY.
#
# Symmetry: `dev:selfhost` starts the provider engines AND the app's dev Postgres (`db`),
# so this stops BOTH — nothing it started is left running. It STOPS containers but
# PRESERVES the named volumes (imported Nominatim DB, ORS graph, Postgres data): a fresh
# re-import is ~24 min (docs/SELFHOST.md), so "stop for now" must not throw that away.
#
# Keep the shared dev `db` running instead (e.g. another app is using :5433)? Stop only the
# provider engines:
#   docker compose -f docker/selfhost/docker-compose.yml --profile serve --profile import stop
#
# The app process (npm run dev) is foreground under dev:selfhost — stop it with Ctrl-C.
#
# Fuller teardown (see docs/SELFHOST.md → Teardown) is intentionally NOT the default:
#   docker compose -f docker/selfhost/docker-compose.yml down       # remove containers, keep volumes
#   docker compose -f docker/selfhost/docker-compose.yml down -v     # ALSO delete engine volumes (re-import needed)
#   rm -rf data/osm data/selfhost                                    # reclaim downloaded build data
#
# Usage:
#   npm run dev:selfhost:down            # stop engines + dev db, keep volumes (default)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$APP_ROOT"

SELF_COMPOSE="docker/selfhost/docker-compose.yml"
APP_COMPOSE="docker-compose.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "[dev:selfhost:down] docker is not on PATH — nothing to stop." >&2
  exit 0
fi

echo "[dev:selfhost:down] Stopping provider engines (volumes preserved) ..." >&2
# `--profile serve --profile import` so the profiled `photon`/`photon-import` services are
# included in the stop set.
docker compose -f "$SELF_COMPOSE" --profile serve --profile import stop

echo "[dev:selfhost:down] Stopping app dev Postgres (db) ..." >&2
docker compose -f "$APP_COMPOSE" stop db

echo "[dev:selfhost:down] Stopped engines + db. Restart with 'npm run dev:selfhost'. Fuller teardown: docs/SELFHOST.md." >&2
