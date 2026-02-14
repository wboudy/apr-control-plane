# APR Trigger Hardening Plan v2.1 (Final, Copy/Paste)

Target service: `apr-trigger` (HTTP :9444)
Primary endpoint: `POST /plan` (Bearer auth)
Goals: reliable, auditable, deterministic, strict model/engine policy, safe concurrency, local-first/self-hostable.

---

## 0) Outcomes and Design Principles

### Must-have outcomes
1) Deterministic behavior: no “Auto” engine/model in strict mode.
2) Auditable by default: every run persists artifacts (request→effective config→oracle cmd→stdout/stderr→response→timings).
3) Workspace-correct output: plans always written under the intended agent workspace path.
4) Safe concurrency: multiple runs allowed where safe, blocked where unsafe (per project/workflow lock + global caps).
5) Operational clarity: health/status exposes effective defaults and oracle readiness/version.

### Core principle
If the service cannot PROVE it honored policy, it must either:
- FAIL in strict mode, OR
- record the policy as unverifiable and require explicit opt-in.

---

## 🔥 GOTCHAS (read this before implementing)

### G1) Locking must be correct (avoid deadlocks + multi-instance hazards)
- In-process mutex is NOT enough if the service restarts or two instances run.
- Use filesystem locks under a shared lock directory.
- Always acquire locks in a consistent order:
  1) global
  2) workspace
  3) project
- Return deterministic “busy” errors (or queue) when locks can’t be acquired.

### G2) Atomic writes are mandatory (avoid corrupt latest/index under concurrency)
Hotspots:
- `latest/<project>.md`
- `index.jsonl` (workspace and global)

Rules:
- Write to temp → fsync → atomic rename.
- Append to index under a dedicated index lock.
- Build run dir as `<run_id>.tmp/` then rename to final.

### G3) “Thinking mode” is not automatically provable
If Oracle does not expose an explicit “reasoning/thinking enabled” signal:
- DO NOT claim strict “thinking enforcement” as a fact.
- Track `thinking_verifiability`: PROVED | INFERRED | UNVERIFIABLE
- In strict mode, fail if UNVERIFIABLE unless explicitly allowed.

### G4) Browser engine parallelism can be unsafe
If browser runs share profile/cache, concurrent runs can fight even across workspaces.
- Default: `APR_MAX_CONCURRENT_GLOBAL=1` for `engine=browser`
- Only raise concurrency if you can isolate browser profiles per run.

---

## 1) API Contract

### 1.1 POST /plan
Request JSON:
- agent (string, optional; alias into workspace map; default APR_DEFAULT_AGENT)
- project (string, required; used for lock scope + paths)
- goal (string, required)
- context (string, optional)
- request_id (string, optional; idempotency key; strongly recommended)

Success response (200):
- run_id
- request_id (echo if provided)
- agent
- workspace_path
- artifacts_path
- effective_engine
- effective_model
- effective_thinking_policy
- thinking_verifiability (PROVED|INFERRED|UNVERIFIABLE)
- duration_ms
- status = "done"

Busy response (409 or 429):
- ok=false
- code="RUN_BUSY"
- lock_scope="global|workspace|project"
- locked_by_run_id (if known)
- retryable=true
- retry_after_ms (optional)

Queued response (optional mode, 202):
- run_id
- status="queued"
- poll_url="/runs/:run_id"
- queue_position (optional)

### 1.2 GET /health (lightweight)
Return at minimum:
- status: ok|degraded|fail
- oracle: { available, path, version }
- defaults: { strict, save_artifacts, engine, model, thinking_policy }
- routing: { workspace_map_file, default_agent }
- queue: { max_concurrent_global, max_concurrent_per_workspace, max_concurrent_per_project, active, depth }
- artifact_store: { root, writable, free_bytes }
- preflight: { ok, errors[] }
- build: { version, sha }

### 1.3 GET /status (recommended, auth-protected)
- recent run counts, failures by code
- active runs, queue depth
- last preflight summary
- disk watermark status

### 1.4 GET /runs/:run_id (recommended)
- state: received|validated|running|done|failed
- artifacts_path
- effective config summary
- error envelope if failed

---

## 2) Configuration Contract (Env Vars)

Feature flag:
- APR_HARDENING_V2=1

Strictness & artifacts:
- APR_STRICT=1 (default strict)
- APR_SAVE_ARTIFACTS=1 (default on)
- APR_ALLOW_NO_ARTIFACTS=0 (if 0, refuse to run when artifacts disabled)

Model/engine policy:
- APR_ENGINE_TARGET=browser
- APR_MODEL_TARGET=gpt-5.2-pro
- APR_THINKING_POLICY=extended
- APR_ALLOW_UNVERIFIABLE_THINKING=0

Oracle invocation determinism:
- APR_ORACLE_PATH=/usr/local/bin/oracle (absolute path; required in strict mode)
- APR_ORACLE_TIMEOUT_MS=900000 (15m)
- APR_ORACLE_VERSION_EXPECTED=0.8.6 (exact or range; always record actual)

Workspace routing:
- APR_WORKSPACE_MAP_FILE=~/.local/etc/apr-trigger/workspaces.json
- APR_DEFAULT_AGENT=captain-rusty
- APR_PLAN_SUBDIR=plans/apr

Concurrency:
- APR_MAX_CONCURRENT_GLOBAL=1 (default 1 for engine=browser)
- APR_MAX_CONCURRENT_PER_WORKSPACE=1
- APR_MAX_CONCURRENT_PER_PROJECT=1
- APR_LOCK_DIR=~/.local/share/apr-trigger/locks
- APR_QUEUE_MODE=none|inprocess (start with none + busy errors)

Indexing + retention:
- APR_INDEX_PATH=~/.local/share/apr-trigger/runs/index.jsonl
- APR_RETENTION_DAYS=30
- APR_MAX_DISK_GB=20 (optional)

---

## 3) Startup Preflight (Fail-Fast)

On startup (and periodically for /health), check:
- oracle exists and is executable at APR_ORACLE_PATH
- `oracle --version` works; record version; optionally enforce APR_ORACLE_VERSION_EXPECTED in strict
- lock dir exists + writable
- artifact store root exists + writable
- workspace map file exists + parseable JSON
- disk free above watermark

If preflight fails:
- /health.status = fail
- POST /plan returns 503 DEPENDENCY_UNAVAILABLE with preflight errors

---

## 4) Workspace Routing

Workspace map file format:
{
  "captain-rusty": "/Users/will/.openclaw/workspace-captain-rusty"
}

Routing rules:
1) Resolve agent from request else APR_DEFAULT_AGENT
2) Look up workspace path in map
3) Strict mode: missing/unknown alias -> 422 UNKNOWN_AGENT_ALIAS
4) Validate workspace path: exists, directory, writable
5) Invalid mapping -> 422 INVALID_WORKSPACE_MAPPING (preferred) or 503 WORKSPACE_UNAVAILABLE (if you treat it as dependency)

Security:
- Normalize paths; never allow traversal from request fields
- Workspace map is the only source of truth for base paths

---

## 5) Deterministic Oracle Invocation

Non-negotiables:
- No shell: spawn with argv array (never `sh -c`)
- Absolute oracle path: APR_ORACLE_PATH
- Explicit cwd: intended workspace/project root
- Minimal env allowlist (do not inherit full env)
- Timeout kill: APR_ORACLE_TIMEOUT_MS

Persist `oracle_cmd.json`:
- argv
- cwd
- oracle path + version
- timeout
- env keys allowlisted (not values)

On timeout:
- kill process
- persist partial stdout/stderr
- return 504 ORACLE_TIMEOUT (retryable=true)

---

## 6) Model + Thinking Enforcement Policy

### 6.1 Provable strict guarantees
- engine must equal APR_ENGINE_TARGET
- model must equal APR_MODEL_TARGET
- no auto engine/model allowed in strict

Implement as whitelist: allowed (engine, model) tuples.

### 6.2 Thinking policy when explicit flag is missing
Persist and return:
- effective_thinking_policy (policy intent)
- enforced_thinking_mechanism (how enforced: engine/model selection, oracle version pin)
- thinking_verifiability:
  - PROVED: oracle emits explicit reasoning signal
  - INFERRED: strong evidence via exact engine/model + no fallback + oracle version pinned
  - UNVERIFIABLE: no signal, cannot infer

Strict mode:
- if thinking_verifiability=UNVERIFIABLE and APR_ALLOW_UNVERIFIABLE_THINKING=0:
  fail with 409 THINKING_POLICY_UNVERIFIABLE

---

## 7) Concurrency (Robust Multi-Run Support)

Goal: match APR semantics (single-flight per workflow/project), not global single-flight.

Lock scope key:
- lock_key = hash(workspace_path + project)

Default rule:
- Same workspace + same project: no overlap (single-flight)
- Same workspace + different projects: allowed (subject to global cap)
- Different workspaces: allowed (subject to global cap)

Two-level limits:
- Global cap (protect browser):
  APR_MAX_CONCURRENT_GLOBAL (default 1 for engine=browser)
- Per-workspace cap:
  APR_MAX_CONCURRENT_PER_WORKSPACE (default 1)
- Per-project cap:
  APR_MAX_CONCURRENT_PER_PROJECT (default 1)

Filesystem locks:
- APR_LOCK_DIR contains:
  - global.lock (or semaphore if >1)
  - workspace_<agent>.lock
  - project_<agent>_<project>.lock
Lock acquisition order:
1) global
2) workspace
3) project

On contention:
- If no queue: return 409 RUN_BUSY (include scope + holder if known)
- If queue: enqueue FIFO, return 202 queued, poll via /runs/:run_id

Browser engine caveat:
- If you cannot isolate browser profile per run, keep global cap = 1.

---

## 8) Auditability & Artifact Persistence

Per run dir:
<workspace>/<APR_PLAN_SUBDIR>/<YYYY-MM-DD>/<timestamp>_<project>_<run_id>/

Required files:
- request.json (redacted)
- effective_config.json
- oracle_cmd.json
- oracle_stdout.txt
- oracle_stderr.txt
- response.json
- plan.md (on success; optional error summary on failure)
- meta.json (run summary)

Convenience:
- <workspace>/<APR_PLAN_SUBDIR>/latest/<project>.md (atomic replace on success only)
- <workspace>/<APR_PLAN_SUBDIR>/index.jsonl (append under lock)
- Global index: APR_INDEX_PATH (append under lock)

meta.json minimum fields:
- run_id, request_id
- agent, project
- workspace_path, artifacts_path
- started_at, finished_at, duration_ms
- oracle: { path, version, exit_code }
- effective_engine, effective_model
- effective_thinking_policy, thinking_verifiability
- status
- error: { code, message, retryable } (if failed)

Atomicity requirements:
- write run outputs to <run_id>.tmp/ then rename to final
- latest/<project>.md: write temp then rename
- indexes: lock → append JSON line → fsync

Permissions & redaction:
- dirs 0700, files 0600
- never persist tokens/auth headers
- redact secrets in request/context
- optionally store request_hash for integrity/dedup without indexing sensitive text

---

## 9) Error Model (Stable Taxonomy)

Envelope:
- ok=false
- run_id (when available)
- request_id (echo)
- code (stable)
- message
- retryable
- details (structured)

Suggested codes/status:
- 400 REQUEST_INVALID
- 401 AUTH_INVALID
- 403 AUTH_FORBIDDEN
- 409 REQUEST_ID_IN_FLIGHT
- 409 RUN_BUSY
- 409 CONFIG_NOT_SATISFIABLE
- 409 THINKING_POLICY_UNVERIFIABLE
- 422 UNKNOWN_AGENT_ALIAS
- 422 INVALID_WORKSPACE_MAPPING
- 503 DEPENDENCY_UNAVAILABLE
- 504 ORACLE_TIMEOUT
- 500 ARTIFACT_PERSIST_FAILED (fail early; do not run without audit trail)
- 500 INTERNAL_ERROR

---

## 10) Observability

Structured logs (JSON), one per phase transition:
- run_id, request_id, agent, project
- phase
- effective_engine, effective_model, thinking_verifiability
- status, duration_ms, oracle_exit_code
- error_code if any
Avoid raw goal/context; log lengths/hashes.

Metrics (Prometheus-style recommended):
- apr_runs_total{status, error_code}
- apr_run_duration_seconds{status}
- apr_oracle_duration_seconds{status}
- apr_active_runs
- apr_queue_depth
- apr_disk_free_bytes

Alerts:
- preflight failing / oracle unavailable
- high failure rate by error_code
- disk below watermark
- repeated timeouts

---

## 11) Retention Policy
- delete runs older than APR_RETENTION_DAYS
- enforce disk budget APR_MAX_DISK_GB (delete oldest first)
- optional “pinned” runs (future)

---

## 12) Rollout and Rollback
- keep old behavior behind APR_HARDENING_V2=0
- canary by agent alias first (config-only)
- rollback by flipping flag + restart
- preserve artifacts for postmortem

---

## 13) Validation Matrix (Smoke + Negative + Concurrency)

Smoke:
1) /health shows oracle path/version and defaults and preflight status
2) /plan success produces complete artifact folder + indices + latest pointer
3) response includes run_id + effective engine/model + thinking verifiability

Negative:
4) missing/invalid auth -> 401/403 (no artifacts)
5) unknown agent alias -> 422
6) workspace unwritable -> 422/503 deterministic
7) unsupported model/engine in strict -> 400 POLICY_VIOLATION
8) oracle missing/unexec -> 503 DEPENDENCY_UNAVAILABLE
9) timeout -> 504 ORACLE_TIMEOUT, stdout/stderr persisted
10) artifact persistence failure -> 500 ARTIFACT_PERSIST_FAILED (fail early)

Concurrency:
11) two runs same (workspace, project): second RUN_BUSY or queued; no overlap
12) two runs same workspace, different projects: can run concurrently (subject to global cap)
13) latest/index never corrupt under parallel requests

Acceptance:
- every run traceable by run_id with complete artifacts
- no silent fallback to auto in strict
- locks + atomic writes prevent contention corruption
- strict mode never claims “thinking” without verifiability

---

## 14) Phased Implementation Roadmap

Same-day quick wins:
1) run_id + artifact folder + persist request/response/stdout/stderr
2) APR_ORACLE_PATH + no-shell spawn + timeouts
3) startup preflight + /health expanded
4) error envelope + stable codes
5) atomic run dir + latest + index writes

Medium-term hardening:
6) strict policy engine (engine/model whitelist)
7) filesystem locks + per-project single-flight + global caps
8) /runs/:run_id + /status
9) structured logs + metrics

Long-term upgrades:
10) optional queue (FIFO) + 202 semantics
11) export bundle + signed manifest (optional)
12) per-run browser profile isolation to raise global concurrency safely

(END)
