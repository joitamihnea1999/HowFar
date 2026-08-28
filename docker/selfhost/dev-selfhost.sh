#!/usr/bin/env bash
# One-command dev loop: bring the local self-host provider stack up and start the app.
# LOCAL ONLY.
#
# This is the DAY-2 convenience. It assumes the ONE-TIME import/build has already been
# done (docs/SELFHOST.md §1-§5: fetch extract, import Nominatim, build Photon index,
# build ORS graph, build tiles). It deliberately does NOT run those multi-hour imports:
# preflight fails loudly if the built artifacts OR the imported engine volumes are missing,
# so a bare `up` can never silently kick off a ~24-min Nominatim import behind your back
# (e.g. after a `down -v` or `rm -rf data/osm`).
#
# What it does:
#   1. Preflight (no writes): docker present; built host artifacts exist (self-built tiles
#      archive + Photon index + Photon jar); the imported engine VOLUMES exist
#      (nominatim-data, ors-graphs — dropped by `down -v`); required provider overlay keys
#      are set. Anything missing -> exit 2 with the runbook pointer. `--dry-run` stops here.
#   2. Bring up the app's dev Postgres (root docker-compose.yml `db`, :5433) and the
#      provider serve stack (nominatim + ors + photon) from docker/selfhost/.
#   3. Wait for the three engines to report `healthy`, bounded by SELFHOST_WAIT_SECS
#      (default 300). If they don't, it exits WITHOUT starting the app -- the app is
#      never pointed at dead engines.
#   4. Apply the provider overlay (read from env.selfhost.example so the two never drift;
#      layered via the process env, which Next.js does NOT override from .env -- so .env
#      keeps its public defaults and only THIS command runs the app against the local
#      engines) and exec `npm run dev`. Your existing DATABASE_URL / AUTH_SECRET in .env
#      are still used (the overlay is providers only).
#
# Matching down: `npm run dev:selfhost:down` stops everything this command started
# (provider engines + the dev `db`), preserving all named volumes for a fast restart.
#
# Not covered here: applying the schema (`prisma migrate deploy`) and importing the amenity
# catalogue (`npm run amenities:refresh`) are the normal app setup (README). And transit
# (/api/transit, /api/reach) is still NOT self-hosted (MOTIS/GTFS gate) -- those routes
# hit the network even under dev:selfhost. See docs/SELFHOST.md.
#
# Usage (from the app root, via npm):
#   npm run dev:selfhost                 # up (db + engines) + start the app
#   npm run dev:selfhost -- --dry-run    # preflight only: report prerequisites, no side effects
#   npm run dev:selfhost:down            # stop the stack (docker/selfhost/stop-selfhost.sh)
set -euo pipefail

# Resolve the app root (two levels up from this script) so the command works regardless
# of the caller's cwd; npm already runs scripts from the app root, but be robust.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$APP_ROOT"

SELF_COMPOSE="docker/selfhost/docker-compose.yml"
APP_COMPOSE="docker-compose.yml"
OVERLAY="docker/selfhost/env.selfhost.example"

# Compose project name (docker-compose.yml `name:`), used to resolve the named volumes.
SELF_PROJECT="howfar-selfhost"
# Imported engine volumes — present once §2/§4 have run, removed by `down -v`. Their
# absence (not the host files') is what a fresh box or a `down -v` leaves behind.
VOLUMES=("${SELF_PROJECT}_nominatim-data" "${SELF_PROJECT}_ors-graphs")
# Built host artifacts (gitignored). PHOTON index+jar live under data/selfhost/photon/.
PHOTON_INDEX="data/selfhost/photon/photon_data"
PHOTON_JAR="data/selfhost/photon/photon.jar"

# Provider serve containers (names from docker-compose.yml container_name:).
ENGINES=(howfar-nominatim howfar-ors howfar-photon)
WAIT_SECS="${SELFHOST_WAIT_SECS:-300}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,48p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $arg (try --dry-run or --help)" >&2; exit 64 ;;
  esac
done

log() { echo "[dev:selfhost] $*" >&2; }

# ── Load the provider overlay FIRST (single-source of the provider env + the tiles path) ──
# Only KEY=value assignment lines are taken; comments and the commented-out
# NEXT_PUBLIC_MAP_BBOX are skipped by the grep. Layered via the process env (set -a).
if [ ! -f "$OVERLAY" ]; then
  log "MISSING: provider overlay $OVERLAY (expected in the repo). Cannot continue."
  exit 2
fi
set -a
# shellcheck disable=SC1090
source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$OVERLAY")
set +a
# Derive the tiles-archive path from the overlay so an operator who repoints
# TILES_PMTILES_PATH in that same file does not get a false "tiles missing".
TILES="${TILES_PMTILES_PATH:-data/tiles/selfhost-romania.pmtiles}"

# ── Preflight: read-only prerequisite checks (no writes, starts nothing) ──────
missing=0

if ! command -v docker >/dev/null 2>&1; then
  log "MISSING: docker is not on PATH. Install Docker + Docker Compose v2 (docs/SELFHOST.md Prerequisites)."
  missing=1
fi

check_artifact() {   # $1 = path, $2 = -f|-d, $3 = human description
  if [ "$2" = "-d" ] && [ -d "$1" ]; then log "ok: $3 ($1)"; return; fi
  if [ "$2" = "-f" ] && [ -f "$1" ]; then log "ok: $3 ($1)"; return; fi
  log "MISSING: $3 ($1) -- run the one-time build in docs/SELFHOST.md (§1-§5) before dev:selfhost."
  missing=1
}
# Host files first (pure filesystem — no docker), so a not-yet-built tree fails here fast.
check_artifact "$TILES"        -f "self-built tiles archive"
check_artifact "$PHOTON_INDEX" -d "Photon index"
check_artifact "$PHOTON_JAR"   -f "Photon jar"

# Required provider overlay keys — a partial overlay would let a provider silently fall
# back to its PUBLIC host while we claim local routing.
for k in NOMINATIM_BASE_URL PHOTON_BASE_URL ORS_BASE_URL; do
  if [ -z "${!k:-}" ]; then
    log "MISSING: overlay key $k is empty/unset in $OVERLAY -- provider would fall back to its public host."
    missing=1
  fi
done

# Imported engine volumes — the check the host-file check can't make. `down -v` (or a fresh
# box) removes these while the tiles/Photon files remain, so without this a bare `up` would
# silently start the ~24-min Nominatim import. Only enforce when the daemon is reachable
# (if it isn't, `up` fails fast anyway — the slow-silent-import harm can't occur).
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  for v in "${VOLUMES[@]}"; do
    if docker volume inspect "$v" >/dev/null 2>&1; then
      log "ok: engine volume ($v)"
    else
      log "MISSING: engine volume '$v' -- the import has not run, or was dropped by 'down -v'."
      log "        Re-import per docs/SELFHOST.md §2 (Nominatim) / §4 (ORS) — a bare 'up' would silently start a ~24-min import."
      missing=1
    fi
  done
else
  log "note: docker daemon not reachable — skipping engine-volume verification (the 'up' below fails fast if a volume is absent)."
fi

if [ "$missing" -ne 0 ]; then
  log "Preflight FAILED -- see docs/SELFHOST.md (§1-§5 for the one-time import/build)."
  exit 2
fi
log "Preflight OK: docker present, built host artifacts + imported engine volumes in place, overlay keys set."

if [ "$DRY_RUN" -eq 1 ]; then
  log "--dry-run: would now bring up '${APP_COMPOSE}:db' + '${SELF_COMPOSE}: ${ENGINES[*]}',"
  log "           wait up to ${WAIT_SECS}s for health, then run the app with the overlay from ${OVERLAY}."
  log "--dry-run: no containers started, no app launched, .env untouched."
  exit 0
fi

# ── Bring the stack up ────────────────────────────────────────────────────────
log "Starting app dev Postgres (${APP_COMPOSE}: db) ..."
docker compose -f "$APP_COMPOSE" up -d db

log "Starting provider engines (${SELF_COMPOSE}: nominatim ors photon) ..."
# `photon` sits behind the compose `serve` profile; naming it on `up` starts it.
docker compose -f "$SELF_COMPOSE" up -d nominatim ors photon

# ── Wait for engine health (bounded) ──────────────────────────────────────────
log "Waiting up to ${WAIT_SECS}s for engines to report healthy ..."
deadline=$(( $(date +%s) + WAIT_SECS ))
while :; do
  all_healthy=1
  statuses=""
  for c in "${ENGINES[@]}"; do
    s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$c" 2>/dev/null || echo absent)"
    statuses="${statuses} ${c}=${s}"
    [ "$s" = "healthy" ] || all_healthy=0
  done
  if [ "$all_healthy" -eq 1 ]; then
    log "Engines healthy:${statuses}"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "Engines NOT healthy within ${WAIT_SECS}s:${statuses}"
    log "A 'starting' engine on a cold box may still be warming up -- watch:"
    log "  docker compose -f ${SELF_COMPOSE} logs -f nominatim ors"
    log "Not starting the app against unready engines. Re-run once they are healthy, or raise SELFHOST_WAIT_SECS."
    exit 1
  fi
  sleep 5
done

# ── Point the app at the stack and run it ─────────────────────────────────────
# The overlay is already exported into this process env (sourced above), so `next dev`
# inherits it. .env is untouched.
log "Applying provider overlay from ${OVERLAY} (inline; .env untouched)."
log "TILE-CACHE NOTE: the overlay serves ${TILES}; if this origin previously loaded a DIFFERENT"
log "  archive (e.g. the public Bucharest cut under a plain 'npm run dev'), hard-reload (empty cache)"
log "  the first time, or the map may render blank/garbled from stale byte ranges (docs/SELFHOST.md §6)."
log "Starting the app: npm run dev (Ctrl-C stops the app; run 'npm run dev:selfhost:down' to stop the engines)."
exec npm run dev
