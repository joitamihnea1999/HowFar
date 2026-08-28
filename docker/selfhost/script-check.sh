#!/usr/bin/env bash
# Static + fail-loud checks for the dev:selfhost scripts. Wired into `npm run check` /
# `check:ci` so a future edit that breaks them is caught by a gate, not just the one-off
# manual run that first validated them.
#
# Hermetic: needs only bash + mktemp, and runs the child with an UNREACHABLE DOCKER_HOST so
# it never touches a real daemon (the daemon-reachable branch is skipped); writes only to a
# private mktemp dir; parallel-safe. Coverage — what it can prove WITHOUT a live daemon:
#   1. all three scripts parse                        -> bash -n
#   2. the HOST-ARTIFACT guard fails loud (exit 2)    -> artifact-less root
#   3. the OVERLAY-KEY guard fails loud (exit 2)      -> artifacts stubbed present, a key blanked
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
# present and tweak the overlay; run --dry-run; return its exit code, echo its output.
run_case() {   # $1 = stub_artifacts (0/1) ; $2 = optional sed program applied to the overlay copy
  local stub="$1" sedprog="${2:-}" tmp out rc
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/docker/selfhost"
  cp "$SCRIPT_DIR/dev-selfhost.sh" "$tmp/docker/selfhost/"
  cp "$SCRIPT_DIR/env.selfhost.example" "$tmp/docker/selfhost/env.selfhost.example"
  [ -n "$sedprog" ] && sed -i "$sedprog" "$tmp/docker/selfhost/env.selfhost.example"
  if [ "$stub" = "1" ]; then
    mkdir -p "$tmp/data/tiles" "$tmp/data/selfhost/photon/photon_data" "$tmp/data/osm"
    : > "$tmp/data/tiles/selfhost-romania.pmtiles"
    : > "$tmp/data/selfhost/photon/photon.jar"
    : > "$tmp/data/osm/romania-260824.osm.pbf"
  fi
  out="$(bash "$tmp/docker/selfhost/dev-selfhost.sh" --dry-run 2>&1)"; rc=$?
  rm -rf "$tmp"
  printf '%s' "$out"
  return "$rc"
}

echo "[script-check] host-artifact guard (artifact-less root must exit 2) ..."
set +e; out="$(run_case 0 "")"; rc=$?; set -e
[ "$rc" -eq 2 ] || { echo "[script-check] FAIL: artifact-less --dry-run returned $rc, expected 2." >&2; echo "$out" >&2; exit 1; }

echo "[script-check] overlay-key guard (artifacts present, NOMINATIM_BASE_URL blanked, must exit 2) ..."
set +e; out="$(run_case 1 's#^NOMINATIM_BASE_URL=.*#NOMINATIM_BASE_URL=""#')"; rc=$?; set -e
[ "$rc" -eq 2 ] || { echo "[script-check] FAIL: blanked-key --dry-run returned $rc, expected 2." >&2; echo "$out" >&2; exit 1; }
grep -q "overlay key NOMINATIM_BASE_URL" <<<"$out" || { echo "[script-check] FAIL: blanked-key run did not trip the overlay-key guard." >&2; echo "$out" >&2; exit 1; }

echo "[script-check] OK: scripts parse; host-artifact + overlay-key guards fail loud (exit 2)."
