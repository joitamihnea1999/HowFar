#!/usr/bin/env bash
# CI initial-JS budget gate runner (task 017). Serves the PROD build with a PLAIN
# `next start` — NO provider stack needed: the gate only measures the JS the browser pulls, and
# a 404 on /api/tiles does not change the byte counts (the map engine chunk still downloads, so
# lazy-detection still works). This is what makes the gate runnable in CI without Docker.
#
# Fail-closed: builds if needed, starts the server, and FAILS if the server never comes up
# or the budget check exits non-zero. There is no skip-green path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$APP_ROOT"

PORT="${PERF_BUDGET_PORT:-3010}"
log() { echo "[perf:budget:serve] $*" >&2; }

# Fail LOUD (never skip-green) if the isolated perf deps (puppeteer/chrome-launcher) are not
# installed. They live in scripts/perf/node_modules (gitignored, separate install) so the gate can
# not silently no-op when they are absent.
if [ ! -d "${SCRIPT_DIR}/node_modules/puppeteer-core" ]; then
  log "MISSING perf deps — run:  (cd scripts/perf && npm install)   [and ensure a Chrome/Chromium is available]"
  exit 1
fi

# ALWAYS rebuild before measuring (task 017 fix): the close verify contract runs `npm run check`
# (no build) then this gate, so a "build only if .next missing" would grade a changed tree against
# a STALE bundle left by an earlier build — a regression could then close green. A fresh build is
# the only way "a regression blocks the close" is actually true. (Set PERF_BUDGET_SKIP_BUILD=1 to
# reuse .next when you have JUST built current source, e.g. inside check:ci.)
if [ -z "${PERF_BUDGET_SKIP_BUILD:-}" ] || [ ! -d .next ]; then
  log "building current source ..."
  npm run build >&2
fi

# Refuse to measure a FOREIGN server: if the port is already in use, a stale process could satisfy
# the readiness curl and we would certify someone else's build. Fail rather than mis-measure.
if curl -s -o /dev/null "http://localhost:${PORT}/" 2>/dev/null; then
  log "port ${PORT} is already serving — refusing to measure a foreign server. Set PERF_BUDGET_PORT to a free port."
  exit 1
fi

log "starting plain next start on :${PORT} (no stack) ..."
npx next start -p "$PORT" >/tmp/perf-budget-server.log 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

# Wait for OUR server to serve /. Fail if the child we spawned has died (e.g. the port was taken
# between the check above and `next start`), so we never fall through to a foreign listener.
deadline=$(( $(date +%s) + 90 ))
until curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/" | grep -qE '^(200|500)$'; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    log "the next start process exited before serving — FAIL"; cat /tmp/perf-budget-server.log >&2 || true; exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "server did not serve / within 90s — FAIL"; cat /tmp/perf-budget-server.log >&2 || true; exit 1
  fi
  sleep 2
done
log "server up (pid ${SERVER_PID}) — running the budget gate"

PERF_URL="http://localhost:${PORT}/" node "${SCRIPT_DIR}/perf-budget.mjs"
