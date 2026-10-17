#!/usr/bin/env bash
# Records what the mock model answers to the conversation matrix's `ci` plan, for the offline CI subset
# (evals/tests/fixtures/matrix_ci_mock.jsonl, replayed by evals/tests/test_matrix_ci.py).
#
# LOCAL ONLY. It resets a dedicated database on the local Postgres cluster (`pnpm db:reset` with LOCAL_DB_NAME),
# adds a dedicated "Memory Lab" venture (evals/scripts/memory-lab.sql), starts the API on the mock model on a
# private port, plays the plan and writes the recording. The recorder refuses any reply that did not come from
# the mock, so nothing a real model or a real person said can end up in the repository. The owner access code
# printed by db:reset stays in this process (never echoed, never written outside a private temp directory).
#
# Usage: evals/scripts/record-matrix-ci.sh [database name] [port]
#   PYTHON  the Python with the evals requirements installed (default: python3)
#   PSQL    psql of the local cluster (default: psql on PATH)
set -euo pipefail

DB_NAME="${1:-foundry_matrix_ci}"
PORT="${2:-10587}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${PYTHON:-python3}"
PSQL="${PSQL:-psql}"
FIXTURE="${ROOT}/evals/tests/fixtures/matrix_ci_mock.jsonl"

if lsof -ti "tcp:${PORT}" > /dev/null 2>&1; then
  echo "port ${PORT} is busy" >&2
  exit 2
fi

umask 077
WORK="$(mktemp -d)"
API_PID=""
stop_tree() { # pid: the process and every descendant
  local child
  for child in $(pgrep -P "$1" 2> /dev/null || true); do stop_tree "${child}"; done
  kill "$1" 2> /dev/null || true
}
cleanup() {
  if [ -n "${API_PID}" ]; then stop_tree "${API_PID}"; fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

echo "resetting local database ${DB_NAME}"
(cd "${ROOT}" && LOCAL_DB_NAME="${DB_NAME}" pnpm db:reset > "${WORK}/reset.out" 2>&1)
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "${WORK}/reset.out" | head -n 1)"
FA_OWNER_ACCESS_CODE="$(grep -oE 'FA-[0-9A-Z]{5}(-[0-9A-Z]{5}){3}' "${WORK}/reset.out" | head -n 1 || true)"
rm -f "${WORK}/reset.out"
if [ -z "${DATABASE_URL}" ] || [ -z "${FA_OWNER_ACCESS_CODE}" ]; then
  echo "db:reset failed" >&2
  exit 1
fi
case "${DATABASE_URL}" in
  *localhost*) ;;
  *) echo "refusing a non-local database" >&2; exit 1 ;;
esac

"${PSQL}" "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "${ROOT}/evals/scripts/memory-lab.sql"

echo "starting the API on the mock model on :${PORT}"
ORIGIN="http://localhost:${PORT}"
(
  cd "${ROOT}/apps/api"
  APP_ENV=development DB_DRIVER=pg MODEL_PROVIDER=mock LOG_LEVEL=warn PORT="${PORT}" HOME_TENANT_SLUG=ain \
    CORE_TURN_RATE_LIMIT=2000 SITE_ORIGIN="${ORIGIN}" DATABASE_URL="${DATABASE_URL}" \
    exec pnpm exec tsx src/dev-server.ts
) > "${WORK}/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://localhost:${PORT}/api/v1/health" > /dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS -m 2 "http://localhost:${PORT}/api/v1/health" > /dev/null || { echo "the API did not start" >&2; exit 1; }

export FA_OWNER_ACCESS_CODE
set +e
(
  cd "${ROOT}/evals"
  "${PY}" -m foundry_evals run --suite matrix --matrix-budget ci --max-turns 400 --turn-rate-limit 1000 \
    --base-url "http://localhost:${PORT}" --memory-venture memorylab --out "${ROOT}/evals/results/matrix-ci-recording" \
    --record-replies "${FIXTURE}"
)
rc=$?
set -e
# Gate failures (exit 1) are expected while the mock has known gaps; anything else means no usable recording.
if [ "${rc}" -ne 0 ] && [ "${rc}" -ne 1 ]; then
  echo "the run failed (exit ${rc}); the recording was not refreshed" >&2
  exit "${rc}"
fi
echo "recorded ${FIXTURE}; now run: cd evals && python -m pytest tests/test_matrix_ci.py"
