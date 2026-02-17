# Operations

## Deploy
1. Install or update the local service wrapper:
   - `bash scripts/install-local.sh`
2. Ensure required environment variables are present (`APR_*`), especially:
   - `APR_TOKEN`
   - `APR_ORACLE_PATH`
   - `APR_WORKSPACE_MAP_FILE`
   - `APR_LOCK_DIR`
   - `APR_INDEX_PATH`
   - `APR_REQUEST_INDEX_PATH`
3. Start or restart the service:
   - `node src/server.mjs`
   - or via your host service manager (for example launchd) pointing to `node /Users/will/.local/bin/apr-trigger.mjs`
4. Verify health:
   - `curl -sS http://127.0.0.1:9444/health | jq`

## Run Smoke
1. Execute:
   - `bash scripts/smoke.sh`
2. Expect terminal output:
   - `[smoke] pass`
3. If smoke fails, inspect the emitted server logs printed by the script, then check:
   - `GET /status`
   - `GET /metrics` (with auth header)

## Runtime Observability

### Required structured events
- `preflight.ok` / `preflight.fail`
- `plan.received`
- `lock.acquire`
- `run.started`
- `oracle.spawned`
- `oracle.timeout`
- `run.completed`
- `run.failed`

All events include:
- `request_id`
- `run_id`
- `workspace`
- `project`
- `duration_ms` (when applicable)

### Metrics
- `plan_requests_total{result,error_code?}`
- `run_duration_ms` (histogram)
- `lock_contention_total`
- `oracle_timeouts_total`

Fetch Prometheus-formatted metrics:
- `curl -sS -H "Authorization: Bearer $APR_TOKEN" http://127.0.0.1:9444/metrics`

## Diagnose Oracle Timeout
1. Confirm timeout pressure in metrics:
   - `oracle_timeouts_total` increasing
2. Check recent failed runs:
   - `GET /status` -> `metrics.recent`
3. Inspect a specific run:
   - `GET /runs/:run_id`
4. Inspect artifact files for that run:
   - `meta.json`
   - `stderr.log` / `oracle_stderr.txt`
   - `stdout.log` / `oracle_stdout.txt`
   - `oracle_cmd.json`
5. Verify Oracle health and configuration:
   - `APR_ORACLE_PATH`
   - `APR_ORACLE_TIMEOUT_MS`
   - `GET /health` / `GET /status` preflight output

## Diagnose Lock Contention
1. Confirm contention in metrics:
   - `lock_contention_total` increasing
2. Check failed requests for `E_LOCK_CONTENDED`:
   - in structured `run.failed` events
   - in `GET /status` -> recent failures
3. Verify active run overlap:
   - `GET /status` -> `active_run_count`
   - `GET /runs/:run_id` for conflicting projects/workspaces
4. Validate lock scope/cap settings:
   - `APR_MAX_CONCURRENT_GLOBAL`
   - `APR_MAX_CONCURRENT_PER_WORKSPACE`
   - `APR_MAX_CONCURRENT_PER_PROJECT`
   - `APR_LOCK_DIR`
5. Inspect lock files if needed:
   - `${APR_LOCK_DIR}/global_*`
   - `${APR_LOCK_DIR}/workspace_*`
   - `${APR_LOCK_DIR}/project_*`
