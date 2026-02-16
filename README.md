# APR Control Plane

A policy-enforcing, concurrency-safe HTTP execution layer for
Dicklesworthstone's **Automated Plan Reviser Pro (APR)**.

Upstream APR repository:
https://github.com/Dicklesworthstone/automated_plan_reviser_pro

---

## What This Is

APR Control Plane is an HTTP service that governs, routes, and audits
execution of Automated Plan Reviser Pro (APR) runs.

APR itself is a powerful CLI that performs iterative planning and
spec refinement via Oracle. It already provides:

- Workflow-level locking (`.apr/rounds/<workflow>/.lock`)
- Iterative plan stabilization logic
- Robust CLI UX for local use

This repository does **not replace APR**.

Instead, it provides a deterministic, multi-agent-safe execution layer
on top of APR for environments where:

- Multiple agents may request plans
- Plans are triggered remotely (for example Discord, container, API call)
- Strict model/engine policy must be enforced
- Concurrency must be controlled
- Runs must be auditable and replayable
- Workspaces must be isolated and routed explicitly

Think of this as the control plane around APR.

---

## Why This Exists

APR is a CLI tool designed to run inside a repository.

In simple local workflows, that is perfect.

However, in more advanced environments:

- Multiple agents may trigger APR
- Workspaces may exist on the host while agents run in containers
- Model/engine drift must be prevented
- Browser engine parallelism must be constrained
- Artifacts must be indexed and reproducible
- Plans must not silently overwrite each other

APR Control Plane adds those guarantees.

---

## Primary Use Case

My specific use case:

- Agents (for example Discord bots or containerized systems) trigger APR remotely.
- Oracle and browser execution occur on the host.
- Multiple agents may have separate workspaces.
- Model selection (for example GPT-5.2 Pro) must never silently downgrade to Auto.
- Concurrent runs for the same project must never overlap.
- Every run must be auditable with persisted metadata.

This service sits between:

- Remote agent callers (Discord bots, containers, API clients)
- APR + Oracle execution on the host
- Workspace routing and artifact persistence on disk

---

## What It Does

- Exposes local HTTP endpoints (default `:9444`) such as `/health`, `/status`, `/plan`, `/runs/:run_id`.
- Routes plan requests to target agent workspaces.
- Enforces deterministic engine/model policy in strict mode.
- Applies filesystem locking for safe overlap behavior.
- Persists per-run artifacts and run indices for auditability.

## What It Does Not Do

- It does not replace APR.
- It does not implement APR's iterative planning/revision internals.

---

## Entrypoint

- Main service: `src/server.mjs`
- Legacy host wrapper path (service-managed): `~/.local/bin/apr-trigger.mjs`

## Local Run

```bash
node src/server.mjs
```

## Install / Upgrade

```bash
bash scripts/install-local.sh
```

## Smoke Test

```bash
bash scripts/smoke.sh
```

## Operations

See `docs/OPERATIONS.md` and `docs/APR_TRIGGER_HARDENING_PLAN.md`.

## Planning Handoffs (for GPT/Codex)

If you are splitting hardening work across multiple fresh agents, use:

- `docs/HANDOFF_PROMPTS.md`

This includes a master coordinator prompt plus separate section prompts
for deterministic oracle invocation, preflight, policy/thinking,
concurrency/atomicity, auditability, and observability.
