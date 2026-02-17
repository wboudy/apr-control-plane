import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllowedTuples, resolveEngineModelPolicy } from "../../src/lib/policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const ORACLE_FAKE_PATH = join(REPO_ROOT, "test", "fixtures", "oracle-fake.sh");

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForHealth(port, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // Retry until timeout.
    }
    await delay(100);
  }
  throw new Error("server did not become healthy");
}

async function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function startServer(env) {
  const stdout = [];
  const stderr = [];
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  proc.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  try {
    await waitForHealth(env.PORT);
  } catch (err) {
    try {
      proc.kill("SIGTERM");
      await waitForExit(proc, 2_000);
    } catch {
      // Best effort only.
    }
    throw new Error(
      `${String(err.message || err)}\nSTDOUT:\n${stdout.join("")}\nSTDERR:\n${stderr.join("")}`,
    );
  }

  return {
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try {
        proc.kill("SIGTERM");
      } catch {
        return;
      }
      await waitForExit(proc, 2_000);
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Best effort only.
        }
        await waitForExit(proc, 1_000);
      }
    },
  };
}

test("strict=true + auto -> reject", () => {
  const result = resolveEngineModelPolicy({
    strict: true,
    engine: "auto",
    model: "gpt-5.2-pro",
    engineExplicit: true,
    modelExplicit: true,
    allowFallback: false,
    allowedTuples: parseAllowedTuples("browser:gpt-5.2-pro"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "E_POLICY_DISALLOWED_TUPLE");
});

test("strict=true + wrong tuple -> reject", () => {
  const result = resolveEngineModelPolicy({
    strict: true,
    engine: "browser",
    model: "gpt-4o-mini",
    engineExplicit: true,
    modelExplicit: true,
    allowFallback: false,
    allowedTuples: parseAllowedTuples("browser:gpt-5.2-pro"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "E_POLICY_DISALLOWED_TUPLE");
});

test("strict=false + fallback allowed -> accept and persist effective_config.json", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "apr-policy-test-"));
  const workspace = join(tmpRoot, "workspace");
  const mapFile = join(tmpRoot, "workspaces.json");
  const runsDir = join(tmpRoot, "runs");
  await mkdir(workspace, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await writeFile(mapFile, JSON.stringify({ "policy-agent": workspace }, null, 2));

  const port = String(19000 + Math.floor(Math.random() * 2000));
  const token = "policy-token";
  const server = await startServer({
    PORT: port,
    APR_TOKEN: token,
    APR_HARDENING_V2: "1",
    APR_STRICT: "0",
    APR_SAVE_ARTIFACTS: "1",
    APR_ALLOW_NO_ARTIFACTS: "0",
    APR_ENGINE_TARGET: "browser",
    APR_MODEL_TARGET: "gpt-4o-mini",
    APR_ALLOWED_TUPLES: "browser:gpt-5.2-pro",
    APR_ALLOW_TUPLE_FALLBACK: "1",
    APR_THINKING_POLICY: "extended",
    APR_ALLOW_UNVERIFIABLE_THINKING: "1",
    APR_ORACLE_PATH: ORACLE_FAKE_PATH,
    APR_ORACLE_TIMEOUT_MS: "120000",
    APR_ORACLE_VERSION_EXPECTED: "0.8.6",
    APR_WORKSPACE_MAP_FILE: mapFile,
    APR_DEFAULT_AGENT: "policy-agent",
    APR_PLAN_SUBDIR: "plans/apr",
    APR_LOCK_DIR: join(tmpRoot, "locks"),
    APR_INDEX_PATH: join(runsDir, "index.jsonl"),
    APR_REQUEST_INDEX_PATH: join(runsDir, "requests.jsonl"),
  });

  try {
    const planResponse = await fetch(`http://127.0.0.1:${port}/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agent: "policy-agent",
        project: "policy-project",
        goal: "Create a deterministic policy fallback test plan.",
        context: "policy test context",
        request_id: "policy-fallback-1",
      }),
    });

    assert.equal(planResponse.status, 200);
    const planJson = await planResponse.json();
    assert.equal(planJson.ok, true);
    assert.equal(typeof planJson.run_id, "string");
    assert.ok(planJson.run_id.length > 0);

    const runResponse = await fetch(`http://127.0.0.1:${port}/runs/${planJson.run_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(runResponse.status, 200);
    const runJson = await runResponse.json();
    assert.equal(runJson.ok, true);

    const indexPath = join(runsDir, "index.jsonl");
    const indexRaw = await readFile(indexPath, "utf8");
    const indexEntries = indexRaw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const runMeta = indexEntries.find((entry) => entry.run_id === planJson.run_id);
    assert.ok(runMeta, "run metadata should be indexed");
    assert.equal(typeof runMeta.artifacts_path, "string");
    assert.ok(runMeta.artifacts_path.length > 0);

    const effectiveRaw = await readFile(join(runMeta.artifacts_path, "effective_config.json"), "utf8");
    const effectiveConfig = JSON.parse(effectiveRaw);

    assert.equal(effectiveConfig.engine_target, "browser");
    assert.equal(effectiveConfig.model_target, "gpt-4o-mini");
    assert.equal(effectiveConfig.effective_engine, "browser");
    assert.equal(effectiveConfig.effective_model, "gpt-5.2-pro");
    assert.equal(effectiveConfig.tuple_fallback_applied, true);
  } finally {
    await server.stop();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
