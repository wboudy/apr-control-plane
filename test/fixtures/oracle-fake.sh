#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  echo "0.8.6"
  exit 0
fi

prompt=""
model=""
engine=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt)
      prompt="${2:-}"
      shift 2
      ;;
    --model)
      model="${2:-}"
      shift 2
      ;;
    --engine)
      engine="${2:-}"
      shift 2
      ;;
    --wait)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$prompt" == *"FAIL_PLAN"* ]]; then
  echo "fake oracle forced failure" >&2
  exit 23
fi

if [[ "$prompt" == *"SLOW_PLAN"* ]]; then
  sleep 6
fi

if [[ -n "${ORACLE_FAKE_SLEEP_MS:-}" ]]; then
  python3 - <<PY
import time
ms=int("${ORACLE_FAKE_SLEEP_MS}")
time.sleep(ms/1000)
PY
fi

echo "# Fake Plan"
echo "model=${model}"
echo "engine=${engine}"
echo "## Step 1"
echo "Do deterministic thing A"
echo "## Step 2"
echo "Do deterministic thing B"
