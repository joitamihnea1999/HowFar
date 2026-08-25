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
FLATNODE_PATH="/fn/flatnode.file"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "flatnode volume '$VOLUME' not found — nothing to prune (has Nominatim imported yet?)." >&2
  exit 0
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
