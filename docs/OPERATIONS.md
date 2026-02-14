# Operations

## Default Port
- `9444`

## Core Endpoints
- `GET /health`
- `GET /status`
- `POST /plan`
- `GET /runs/:run_id`

## Service Manager
Typical host setup uses launchd with:
- program: `node /Users/will/.local/bin/apr-trigger.mjs`

## Environment
Service behavior is configured via `APR_*` variables (strict mode, workspace routing, oracle invocation, artifact paths, lock behavior).
See `.env.example`.
