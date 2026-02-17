#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PREFLIGHT_CONTRACT_PORT:-19446}"
TOKEN="${PREFLIGHT_CONTRACT_TOKEN:-preflight-contract-token}"
TMP_DIR="$(mktemp -d -t apr-trigger-preflight-contract-XXXXXX)"
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
export APR_ORACLE_PATH="$TMP_DIR/does-not-exist/oracle"
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
  echo "[preflight-health-contract] server did not start" >&2
  cat "$LOG_OUT" >&2 || true
  cat "$LOG_ERR" >&2 || true
  exit 1
fi

HEALTH_JSON="$TMP_DIR/health.json"
HEALTH_HTTP="$(curl -sS -o "$HEALTH_JSON" -w "%{http_code}" "http://127.0.0.1:$PORT/health")"
if [[ "$HEALTH_HTTP" != "503" ]]; then
  echo "[preflight-health-contract] expected HTTP 503 from /health, got $HEALTH_HTTP" >&2
  cat "$HEALTH_JSON" >&2 || true
  exit 1
fi
jq -e '.ok == false and .error.code == "E_PREFLIGHT_FAILED" and .error.details.state == "FAIL"' "$HEALTH_JSON" >/dev/null

PLAN_JSON="$TMP_DIR/plan.json"
PLAN_HTTP="$(curl -sS -o "$PLAN_JSON" -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/plan" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"agent":"smoke-agent","project":"smokeproj","goal":"Create a concise deterministic smoke plan.","context":"smoke","request_id":"preflight-contract-req-1"}')"
if [[ "$PLAN_HTTP" != "503" ]]; then
  echo "[preflight-health-contract] expected HTTP 503 from /plan, got $PLAN_HTTP" >&2
  cat "$PLAN_JSON" >&2 || true
  exit 1
fi
jq -e '.ok == false and ((.error.code // .code) == "E_PREFLIGHT_FAILED")' "$PLAN_JSON" >/dev/null

echo "[preflight-health-contract] pass"
