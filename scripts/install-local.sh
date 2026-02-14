#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
DEST_BIN="${DEST_BIN:-$HOME/.local/bin/apr-trigger.mjs}"
WORKSPACE_MAP="${WORKSPACE_MAP:-$HOME/.local/etc/apr-trigger/workspaces.json}"
LOCK_DIR="${LOCK_DIR:-$HOME/.local/share/apr-trigger/locks}"
RUNS_DIR="${RUNS_DIR:-$HOME/.local/share/apr-trigger/runs}"
WRAPPER_TMP="${DEST_BIN}.tmp.$$"

if [[ -z "$NODE_BIN" ]]; then
  echo "[install] node not found in PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST_BIN")" "$(dirname "$WORKSPACE_MAP")" "$LOCK_DIR" "$RUNS_DIR"
chmod 700 "$LOCK_DIR" "$RUNS_DIR" || true

if [[ ! -f "$WORKSPACE_MAP" ]]; then
  cp "$REPO_ROOT/config/workspaces.json.example" "$WORKSPACE_MAP"
  chmod 600 "$WORKSPACE_MAP" || true
fi

cat > "$WRAPPER_TMP" <<'WRAP'
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const triggerHome = resolve(process.env.APR_TRIGGER_HOME || "__REPO_ROOT__");
const target = join(triggerHome, "src", "server.mjs");

if (!existsSync(target)) {
  console.error(`[apr-trigger wrapper] target missing: ${target}`);
  console.error("Set APR_TRIGGER_HOME to the apr-trigger repo root.");
  process.exit(1);
}

await import(pathToFileURL(target).href);
WRAP

sed -i.bak "s|__REPO_ROOT__|$REPO_ROOT|g" "$WRAPPER_TMP"
rm -f "${WRAPPER_TMP}.bak"

chmod +x "$WRAPPER_TMP"
mv "$WRAPPER_TMP" "$DEST_BIN"

echo "[install] installed wrapper: $DEST_BIN"
echo "[install] repo root: $REPO_ROOT"
echo "[install] workspace map: $WORKSPACE_MAP"
echo "[install] lock dir: $LOCK_DIR"
echo "[install] runs dir: $RUNS_DIR"

echo "[install] to run manually:"
echo "  APR_TRIGGER_HOME='$REPO_ROOT' '$NODE_BIN' '$DEST_BIN'"
