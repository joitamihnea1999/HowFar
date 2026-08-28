#!/usr/bin/env bash
# Static + fail-loud checks for the dev:selfhost scripts. Wired into `npm run check` /
# `check:ci` (and CI, .github/workflows/ci.yml) so a future edit that breaks them is caught
# by a gate, not just the one-off manual run that first validated them.
#
# Hermetic: needs bash + mktemp + the docker CLI on PATH (the positive-control case reaches the
# docker-present check), but NO running daemon — it forces an UNREACHABLE DOCKER_HOST so the
# child never touches a real daemon (the daemon-reachable branch is skipped); writes only to a
# private mktemp dir; parallel-safe. Coverage — each guard is watched-fail on its OWN
# diagnostic (rule #3), not just on a shared exit 2:
#   1. all three scripts parse                              -> bash -n
#   2. HOST-ARTIFACT guard: artifact-less root              -> exit 2 + "self-built tiles archive"
#   3. OSM-EXTRACT guard: everything present but the PBF    -> exit 2 + "OSM extract"
#   4. OVERLAY-KEY guard: artifacts present, a key blanked  -> exit 2 + "overlay key NOMINATIM_BASE_URL"
# It CANNOT exercise the engine-VOLUME guard (that needs a live daemon) -- by design.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Force the daemon unreachable so the child never talks to a real Docker (keeps this
# hermetic and off the docker socket even when one is present on the check/CI host).
export DOCKER_HOST="unix:///nonexistent/dev-selfhost-scriptcheck.sock"

echo "[script-check] bash -n ..."
bash -n "$SCRIPT_DIR/dev-selfhost.sh"
bash -n "$SCRIPT_DIR/stop-selfhost.sh"
bash -n "$SCRIPT_DIR/script-check.sh"

# Build a temp app-root with the script + overlay; optionally stub the host artifacts
# present (non-empty, since the tiles/PBF checks require non-empty) with per-artifact skips;
# tweak the overlay; run --dry-run; return its exit code and echo its output.
#   $1 = stub_artifacts (0/1) ; $2 = optional sed program on the overlay ; $3 = skip list (space-sep: pbf tiles photon jar)
run_case() {
  local stub="$1" sedprog="${2:-}" skip="${3:-}" tmp out rc
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/docker/selfhost"
  cp "$SCRIPT_DIR/dev-selfhost.sh" "$tmp/docker/selfhost/"
  cp "$SCRIPT_DIR/env.selfhost.example" "$tmp/docker/selfhost/env.selfhost.example"
  [ -n "$sedprog" ] && sed -i "$sedprog" "$tmp/docker/selfhost/env.selfhost.example"
  if [ "$stub" = "1" ]; then
    mkdir -p "$tmp/data/tiles" "$tmp/data/selfhost/photon/photon_data" "$tmp/data/osm"
    [[ " $skip " == *" tiles "*  ]] || printf 'x' > "$tmp/data/tiles/selfhost-romania.pmtiles"
    [[ " $skip " == *" jar "*    ]] || printf 'x' > "$tmp/data/selfhost/photon/photon.jar"
    [[ " $skip " == *" photon "* ]] || printf 'x' > "$tmp/data/selfhost/photon/photon_data/marker"  # non-empty index dir
    [[ " $skip " == *" pbf "*    ]] || printf 'x' > "$tmp/data/osm/romania-260824.osm.pbf"
  fi
  out="$(bash "$tmp/docker/selfhost/dev-selfhost.sh" --dry-run 2>&1)"; rc=$?
  rm -rf "$tmp"
  printf '%s' "$out"
  return "$rc"
}

assert() {   # $1 = exit code, $2 = expected code, $3 = expected substring, $4 = output, $5 = label
  [ "$1" -eq "$2" ] || { echo "[script-check] FAIL ($5): exit $1, expected $2." >&2; echo "$4" >&2; exit 1; }
  grep -q "$3" <<<"$4"   || { echo "[script-check] FAIL ($5): output missing \"$3\"." >&2; echo "$4" >&2; exit 1; }
}

echo "[script-check] host-artifact guard (artifact-less root) ..."
set +e; out="$(run_case 0 "")"; rc=$?; set -e
assert "$rc" 2 "MISSING: self-built tiles archive" "$out" "host-artifact"

echo "[script-check] OSM-extract guard (all present but the PBF) ..."
set +e; out="$(run_case 1 "" "pbf")"; rc=$?; set -e
assert "$rc" 2 "MISSING: OSM extract (PBF)" "$out" "osm-extract"

echo "[script-check] overlay-key guard (artifacts present, NOMINATIM_BASE_URL blanked) ..."
set +e; out="$(run_case 1 's#^NOMINATIM_BASE_URL=.*#NOMINATIM_BASE_URL=""#')"; rc=$?; set -e
assert "$rc" 2 "overlay key NOMINATIM_BASE_URL" "$out" "overlay-key"

# Positive control: everything present + unmodified overlay must PASS (exit 0). Without this a
# preflight that failed unconditionally would still satisfy the three fail cases above.
echo "[script-check] positive control (all artifacts present, unmodified overlay) ..."
set +e; out="$(run_case 1 "")"; rc=$?; set -e
assert "$rc" 0 "Preflight OK" "$out" "positive-control"

echo "[script-check] OK: scripts parse; 3 guards fail loud (exit 2) and the happy preflight passes (exit 0)."
