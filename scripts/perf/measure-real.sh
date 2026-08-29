#!/usr/bin/env bash
# One command to re-measure on a real Android over Chrome remote debugging.
# Validates the device, establishes BOTH adb mappings, then runs the requested metric(s).
#
# Prereqs: the phone has USB debugging on and Chrome open; the prod server is serving on the
# host (bash scripts/perf/serve-prod.sh); harness deps installed (npm install in scripts/perf).
#
# Usage (from scripts/perf/):
#   bash measure-real.sh              # all metrics (lighthouse + profile + api)
#   bash measure-real.sh lighthouse   # one metric: lighthouse | profile | api | bundle
#
# NB the API run over this path uses the adb-reverse USB tunnel, NOT a cellular link, so its
# latency is local-transport (the CPU/GPU/render numbers ARE real). For a real-network API
# figure, put the phone on wifi/cellular and set PERF_URL to the host's routable IP instead.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

METRIC="${1:-all}"
HOST_PORT="${PERF_HOST_PORT:-3000}"
CDP_PORT="${PERF_CDP_PORT:-9222}"

log() { echo "[measure-real] $*" >&2; }

command -v adb >/dev/null 2>&1 || { log "adb not on PATH — install platform-tools."; exit 2; }
[ -d node_modules ] || { log "run 'npm install' in scripts/perf first."; exit 2; }

# Exactly one authorized device.
DEVS="$(adb devices | awk 'NR>1 && $2=="device"{print $1}')"
COUNT="$(printf '%s\n' "$DEVS" | grep -c . || true)"
if [ "$COUNT" -eq 0 ]; then log "no authorized device (check USB + 'Allow debugging' prompt)."; exit 2; fi
if [ "$COUNT" -gt 1 ]; then log "more than one device attached — set ANDROID_SERIAL to pick one."; exit 2; fi
log "device: $DEVS"

# Phone → host prod server; host → phone's Chrome DevTools.
adb reverse "tcp:${HOST_PORT}" "tcp:${HOST_PORT}" >/dev/null
adb forward "tcp:${CDP_PORT}" localabstract:chrome_devtools_remote >/dev/null
# Verify the device's Chrome is actually reachable before running anything.
if ! curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null; then
  log "device Chrome not reachable on :${CDP_PORT} — open Chrome on the phone and retry."
  exit 2
fi
log "adb reverse :${HOST_PORT} + forward :${CDP_PORT} established; device Chrome reachable."

export PERF_DEVICE=real
export PERF_URL="http://localhost:${HOST_PORT}/"
export PERF_CDP_PORT="${CDP_PORT}"

run() { log "running $1 ..."; node "$1"; }
case "$METRIC" in
  lighthouse) run run-lighthouse.mjs ;;
  profile)    run run-runtime-profile.mjs ;;
  api)        run run-api-latency.mjs ;;
  bundle)     run analyze-bundle.mjs ;;
  all)        run run-lighthouse.mjs; run run-runtime-profile.mjs; run run-api-latency.mjs ;;
  *) log "unknown metric '$METRIC' (lighthouse|profile|api|bundle|all)"; exit 64 ;;
esac
log "done. Results in results/*.json."
