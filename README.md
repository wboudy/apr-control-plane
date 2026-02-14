# apr-trigger

`apr-trigger` is a thin HTTP policy and orchestration layer for planning runs.
It is **not** APR itself.

It integrates with Dicklesworthstone's Automated Plan Reviser Pro (APR), which handles iterative refinement and workflow-level locking (for example `.apr/rounds/<workflow>/.lock`).
This service wraps Oracle/APR invocation behind authenticated HTTP endpoints and enforces local policy (routing, artifacts, strict mode, locks, idempotency).

## What It Does
- Exposes local HTTP endpoints (default `:9444`) such as `/health`, `/status`, `/plan`, `/runs/:run_id`.
- Routes plan requests to target agent workspaces.
- Persists per-run artifacts and indices for auditability.
- Enforces deterministic engine/model policy in strict mode.

## What It Does Not Do
- It does not replace APR.
- It does not implement APR's iterative planning/revision internals.

## Entrypoint
- Main service: `src/server.mjs`

## Local Run
```bash
node src/server.mjs
```
