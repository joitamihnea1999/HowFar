#!/usr/bin/env bash
# One-command dev loop: bring the local self-host provider stack up and start the app.
# LOCAL ONLY.
#
# This is the DAY-2 convenience. It assumes the ONE-TIME import/build has already been
# done (docs/SELFHOST.md §1-§5: fetch extract, import Nominatim, build Photon index,
# build ORS graph, build tiles). It deliberately does NOT run those multi-hour imports:
# preflight fails loud if the built host artifacts, the OSM extract, or the imported engine
# VOLUMES are missing, so a bare `up` won't silently kick off a ~24-min Nominatim import
# after a `down -v` (drops volumes) or `rm -rf data/osm` (drops the extract) removed them.
# Caveat: the volume check confirms the volumes EXIST, not that an import ran to completion
# -- an interrupted import leaves a volume behind, which preflight cannot distinguish, so
# watch the health wait on the first start after an aborted import.
#
# What it does:
#   1. Preflight (read-only): docker present; built host artifacts exist (self-built tiles
#      archive + Photon index + Photon jar); the OSM extract exists; the imported engine
#      VOLUMES exist (nominatim-data, ors-graphs); required provider overlay keys are set.
#      Anything missing -> exit 2 with the runbook pointer. `--dry-run` stops here.
#   2. Bring up the app's dev Postgres (root docker-compose.yml `db`, :5433) and the
#      provider serve stack (nominatim + ors + photon) from docker/selfhost/.
#   3. Wait for the dev db AND the three engines to report `healthy`, bounded by
#      SELFHOST_WAIT_SECS (default 300). If they don't, it exits WITHOUT starting the app
#      -- the app is never pointed at a cold db or dead engines.
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

# Compose project name, used to resolve the named volumes. Compose honours
# COMPOSE_PROJECT_NAME over the compose-file `name:` key, so respect it here too or the
# volume check would inspect the wrong project's volumes.
SELF_PROJECT="${COMPOSE_PROJECT_NAME:-howfar-selfhost}"
# Imported engine volumes — present once §2/§4 have run, removed by `down -v`.
VOLUMES=("${SELF_PROJECT}_nominatim-data" "${SELF_PROJECT}_ors-graphs")
# Built host artifacts (gitignored). PHOTON index+jar live under data/selfhost/photon/.
PHOTON_INDEX="data/selfhost/photon/photon_data"
PHOTON_JAR="data/selfhost/photon/photon.jar"
# OSM extract bind-mounted by the nominatim + ors services (docker-compose.yml). Its
# absence makes `up` create an empty directory at the mount path (SELFHOST.md caveats),
# so guard it here. Keep in sync with the compose bind mounts when the extract changes.
PBF="data/osm/romania-260824.osm.pbf"

# Containers to wait on for health: the dev db + the three provider engines
# (names from the compose container_name: keys).
HEALTH_TARGETS=(howfar-postgis howfar-nominatim howfar-ors howfar-photon)
ENGINES=(nominatim ors photon)
WAIT_SECS="${SELFHOST_WAIT_SECS:-300}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) awk 'NR>=2{ if(/^set -euo pipefail$/) exit; sub(/^# ?/,""); print }' "${BASH_SOURCE[0]}"; exit 0 ;;
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
volumes_verified=0

if ! command -v docker >/dev/null 2>&1; then
  log "MISSING: docker is not on PATH. Install Docker + Docker Compose v2 (docs/SELFHOST.md Prerequisites)."
  missing=1
fi

check_artifact() {   # $1 = path, $2 = -d (dir) | -f (file exists) | -s (file non-empty), $3 = description
  case "$2" in
    -d) [ -d "$1" ] && { log "ok: $3 ($1)"; return; } ;;
    -f) [ -f "$1" ] && { log "ok: $3 ($1)"; return; } ;;
    -s) [ -s "$1" ] && { log "ok: $3 ($1)"; return; } ;;   # exists AND non-empty (catches a truncated build)
  esac
  log "MISSING: $3 ($1) -- missing or empty; run the one-time build in docs/SELFHOST.md (§1-§5) before dev:selfhost."
  missing=1
}
# Host files first (pure filesystem — no docker), so a not-yet-built tree fails here fast.
# The two large binary artifacts must be NON-EMPTY (a 0-byte archive/extract is a broken build).
check_artifact "$TILES"        -s "self-built tiles archive"
check_artifact "$PHOTON_INDEX" -d "Photon index"
check_artifact "$PHOTON_JAR"   -f "Photon jar"
check_artifact "$PBF"          -s "OSM extract (PBF)"

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
  volumes_verified=1
  for v in "${VOLUMES[@]}"; do
    if docker volume inspect "$v" >/dev/null 2>&1; then
      log "ok: engine volume present ($v)"
    else
      log "MISSING: engine volume '$v' -- absent (dropped by 'down -v', or never imported)."
      log "        Re-import per docs/SELFHOST.md §2 (Nominatim) / §4 (ORS) — a bare 'up' would silently start a ~24-min import."
      missing=1
    fi
  done
else
  log "note: docker daemon not reachable — engine volumes NOT verified (the 'up' below fails fast if a volume is absent)."
fi

if [ "$missing" -ne 0 ]; then
  log "Preflight FAILED -- see docs/SELFHOST.md (§1-§5 for the one-time import/build)."
  exit 2
fi
if [ "$volumes_verified" -eq 1 ]; then
  log "Preflight OK: docker present, built host artifacts + extract present, engine volumes present, overlay keys set."
else
  log "Preflight OK (host artifacts + extract + overlay keys); engine volumes UNVERIFIED — docker daemon was unreachable."
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "--dry-run: would now bring up '${APP_COMPOSE}:db' + '${SELF_COMPOSE}: ${ENGINES[*]}',"
  log "           wait up to ${WAIT_SECS}s for db + engine health, then run the app with the overlay from ${OVERLAY}."
  log "--dry-run: no containers started, no app launched, .env untouched."
  exit 0
fi

# ── Bring the stack up ────────────────────────────────────────────────────────
log "Starting app dev Postgres (${APP_COMPOSE}: db) ..."
docker compose -f "$APP_COMPOSE" up -d db

log "Starting provider engines (${SELF_COMPOSE}: ${ENGINES[*]}) ..."
# `photon` sits behind the compose `serve` profile; naming it on `up` starts it.
docker compose -f "$SELF_COMPOSE" up -d "${ENGINES[@]}"

# ── Wait for db + engine health (bounded) ─────────────────────────────────────
log "Waiting up to ${WAIT_SECS}s for db + engines to report healthy ..."
deadline=$(( $(date +%s) + WAIT_SECS ))
while :; do
  all_healthy=1
  statuses=""
  for c in "${HEALTH_TARGETS[@]}"; do
    s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$c" 2>/dev/null || echo absent)"
    statuses="${statuses} ${c}=${s}"
    [ "$s" = "healthy" ] || all_healthy=0
  done
  if [ "$all_healthy" -eq 1 ]; then
    log "Healthy:${statuses}"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "NOT all healthy within ${WAIT_SECS}s:${statuses}"
    log "A 'starting' engine on a cold box may still be warming up (or resuming an interrupted import) -- watch:"
    log "  docker compose -f ${SELF_COMPOSE} logs -f nominatim ors"
    log "Not starting the app against an unready db/engines. Re-run once healthy, or raise SELFHOST_WAIT_SECS."
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
