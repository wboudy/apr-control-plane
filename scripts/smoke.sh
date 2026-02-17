#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-19444}"
TOKEN="${SMOKE_TOKEN:-smoke-token}"
TMP_DIR="$(mktemp -d -t apr-trigger-smoke-XXXXXX)"
WORKSPACE="$TMP_DIR/workspace"
MAP_FILE="$TMP_DIR/workspaces.json"
INDEX_DIR="$TMP_DIR/runs"
REQUESTS_PATH="$INDEX_DIR/requests.jsonl"
INDEX_PATH="$INDEX_DIR/index.jsonl"
LOG_OUT="$TMP_DIR/server.out.log"
LOG_ERR="$TMP_DIR/server.err.log"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$WORKSPACE" "$INDEX_DIR"
cat > "$MAP_FILE" <<MAP
{
  "smoke-agent": "$WORKSPACE"
}
MAP

export PORT
export APR_TOKEN="$TOKEN"
export APR_HARDENING_V2=1
export APR_STRICT=1
export APR_SAVE_ARTIFACTS=1
export APR_ALLOW_NO_ARTIFACTS=0
export APR_ENGINE_TARGET=browser
export APR_MODEL_TARGET=gpt-5.2-pro
export APR_THINKING_POLICY=extended
export APR_ALLOW_UNVERIFIABLE_THINKING=1
export APR_ORACLE_PATH="$REPO_ROOT/test/fixtures/oracle-fake.sh"
export APR_ORACLE_TIMEOUT_MS=120000
export APR_ORACLE_VERSION_EXPECTED=0.8.6
export APR_WORKSPACE_MAP_FILE="$MAP_FILE"
export APR_DEFAULT_AGENT=smoke-agent
export APR_PLAN_SUBDIR=plans/apr
export APR_MAX_CONCURRENT_GLOBAL=1
export APR_MAX_CONCURRENT_PER_WORKSPACE=1
export APR_MAX_CONCURRENT_PER_PROJECT=1
export APR_LOCK_DIR="$TMP_DIR/locks"
export APR_INDEX_PATH="$INDEX_PATH"
export APR_REQUEST_INDEX_PATH="$REQUESTS_PATH"

node "$REPO_ROOT/src/server.mjs" >"$LOG_OUT" 2>"$LOG_ERR" &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -sS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -sS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "[smoke] server did not start" >&2
  cat "$LOG_OUT" >&2 || true
  cat "$LOG_ERR" >&2 || true
  exit 1
fi

HEALTH_JSON="$TMP_DIR/health.json"
curl -sS "http://127.0.0.1:$PORT/health" > "$HEALTH_JSON"
jq -e '.ok == true and .state == "OK"' "$HEALTH_JSON" >/dev/null

PLAN_JSON="$TMP_DIR/plan.json"
curl -sS -X POST "http://127.0.0.1:$PORT/plan" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"agent":"smoke-agent","project":"smokeproj","goal":"Create a concise deterministic smoke plan.","context":"smoke","request_id":"smoke-req-1"}' \
  > "$PLAN_JSON"

jq -e '.ok == true and (.run_id|length>0) and .state == "done"' "$PLAN_JSON" >/dev/null
RUN_ID="$(jq -r '.run_id' "$PLAN_JSON")"
RUN_JSON="$TMP_DIR/run.json"
curl -sS "http://127.0.0.1:$PORT/runs/$RUN_ID" \
  -H "Authorization: Bearer $TOKEN" \
  > "$RUN_JSON"
jq -e --arg run_id "$RUN_ID" \
  '.ok == true and .run_id == $run_id and (.state == "done" or .state == "failed")' \
  "$RUN_JSON" >/dev/null
ART_PATH="$(jq -r --arg run_id "$RUN_ID" 'select(.run_id == $run_id) | .artifacts_path' "$INDEX_PATH" | tail -n 1)"
for f in request.json effective_config.json oracle_cmd.json oracle_stdout.txt oracle_stderr.txt response.json meta.json plan.md; do
  test -f "$ART_PATH/$f"
done

FIRST_CONC="$TMP_DIR/concurrency.first.json"
SECOND_CONC="$TMP_DIR/concurrency.second.json"
(
  curl -sS -X POST "http://127.0.0.1:$PORT/plan" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"agent":"smoke-agent","project":"sameproj","goal":"Create a deterministic plan for lock testing.","context":"SLOW_PLAN","request_id":"smoke-lock-1"}' > "$FIRST_CONC"
) &
PID_A=$!
sleep 1
curl -sS -X POST "http://127.0.0.1:$PORT/plan" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"agent":"smoke-agent","project":"sameproj","goal":"Create a deterministic plan for lock testing.","context":"smoke second","request_id":"smoke-lock-2"}' > "$SECOND_CONC"
wait "$PID_A"

jq -e '.ok == false and .error.code == "E_LOCK_CONTENDED"' "$SECOND_CONC" >/dev/null

IDEM_FIRST="$TMP_DIR/idem.first.json"
IDEM_SECOND="$TMP_DIR/idem.second.json"
curl -sS -X POST "http://127.0.0.1:$PORT/plan" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"agent":"smoke-agent","project":"idemproj","goal":"Create deterministic idempotency plan.","context":"idem","request_id":"idem-1"}' > "$IDEM_FIRST"

curl -sS -X POST "http://127.0.0.1:$PORT/plan" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"agent":"smoke-agent","project":"idemproj","goal":"Create deterministic idempotency plan.","context":"idem","request_id":"idem-1"}' > "$IDEM_SECOND"

jq -e '.ok == true and .replayed == true' "$IDEM_SECOND" >/dev/null

echo "[smoke] pass"
