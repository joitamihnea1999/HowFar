#!/usr/bin/env bash
# Reclaim the Nominatim flatnode file after a successful import — LOCAL ONLY.
#
# osm2pgsql sizes the flatnode file by the WHOLE planet node-ID space, not by the
# extract, so a Romania import still produces a ~105 GB flatnode.file. That file is
# read only during import and during minutely/replication updates — a serve-only
# instance (plain /search + /reverse, which is all this app does) never touches it.
# Deleting it after the import reclaims ~105 GB and the geocoder keeps answering
# byte-identically (verified: /search + /reverse return the same coords after the
# file is removed and the container restarted).
#
# Default: DELETE the flatnode. Opt out with KEEP_FLATNODE=1 if you plan to run
# minutely OSM updates / replication against this instance (then the file must stay).
#
# TRADEOFF if you delete and later need the flatnode back (e.g. to enable updates):
# there is no rebuild-in-place — you re-import Nominatim from the extract, ~24 min
# on a 16-core box (docs/SELFHOST.md resource table).
#
# Usage (after Nominatim reports healthy):
#   bash docker/selfhost/prune-flatnode.sh          # delete (default)
#   KEEP_FLATNODE=1 bash docker/selfhost/prune-flatnode.sh   # keep, print size, no-op
set -euo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-howfar-selfhost}"
VOLUME="${PROJECT}_nominatim-flatnode"
CONTAINER="${NOMINATIM_CONTAINER:-howfar-nominatim}"
FLATNODE_PATH="/fn/flatnode.file"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "flatnode volume '$VOLUME' not found — nothing to prune (has Nominatim imported yet?)." >&2
  exit 0
fi

# Refuse to delete unless the import has COMPLETED. The flatnode file is written by
# osm2pgsql throughout the ~24-min import; removing it mid-import corrupts a build
# that has no in-place rebuild. The container's own healthcheck reports 'healthy'
# only once /status returns 0 (= import done and serving), so gate on that. If the
# import already finished but you stopped the container, start it, wait for healthy,
# then re-run. (Override the name with NOMINATIM_CONTAINER if you renamed it.)
health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$CONTAINER" 2>/dev/null || echo absent)"
if [ "$health" != "healthy" ]; then
  echo "Refusing to prune: Nominatim container '$CONTAINER' is '$health', not 'healthy'." >&2
  echo "  healthy   = import finished & serving  -> safe to prune" >&2
  echo "  starting  = still importing            -> DO NOT prune (would corrupt the import)" >&2
  echo "  absent/nohealth = container not up      -> start it, wait for healthy, then re-run" >&2
  echo "Start with: docker compose -f docker/selfhost/docker-compose.yml up -d nominatim" >&2
  exit 1
fi

size="$(docker run --rm -v "${VOLUME}:/fn" alpine sh -c \
  'if [ -f /fn/flatnode.file ]; then du -sh /fn/flatnode.file | cut -f1; else echo none; fi')"

if [ "$size" = "none" ]; then
  echo "No flatnode.file in '$VOLUME' — already pruned or import used none. Nothing to do." >&2
  exit 0
fi

if [ "${KEEP_FLATNODE:-}" = "1" ]; then
  echo "KEEP_FLATNODE=1 — keeping flatnode.file (${size}). Required for minutely/replication updates." >&2
  exit 0
fi

echo "Deleting flatnode.file (${size}) from '$VOLUME' — serve-only instance does not need it." >&2
docker run --rm -v "${VOLUME}:/fn" alpine rm -f "$FLATNODE_PATH"
echo "Done. Reclaimed ~${size}. Re-import (~24 min) is the cost if you later need it back." >&2
