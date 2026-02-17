import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import {
  buildOracleArgv,
  normalizeOracleCmdRecord,
  runOracleInvocation,
} from "../../src/lib/oracle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SERVER_ENTRY = join(REPO_ROOT, "src/server.mjs");
const ORACLE_FIXTURE = join(REPO_ROOT, "test/fixtures/oracle-fake.sh");
const DEFAULT_TOKEN = "oracle-test-token";

function responseErrorCode(body) {
  return body?.error?.code || body?.code || null;
}

function responseErrorDetails(body) {
  return body?.error?.details || body?.details || {};
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.on("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : null;
      srv.close((err) => {
        if (err) return rejectPort(err);
        if (!port) return rejectPort(new Error("Failed to allocate test port"));
        resolvePort(port);
      });
    });
  });
}

async function waitForServer(port, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status >= 200) return;
    } catch {
      // Retry until timeout.
    }
    await delay(100);
  }
  throw new Error("Server failed to become reachable");
}

async function stopServer(proc) {
  if (proc.exitCode != null) return;
  proc.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => proc.once("exit", resolveExit)),
    delay(2_000).then(() => false),
  ]);
  if (exited === false && proc.exitCode == null) {
    proc.kill("SIGKILL");
    await new Promise((resolveExit) => proc.once("exit", resolveExit));
  }
}

async function startServer({ oraclePath, oracleTimeoutMs = 5_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "apr-oracle-test-"));
  const workspace = join(root, "workspace");
  const mapPath = join(root, "workspaces.json");
  const lockDir = join(root, "locks");
  const runRoot = join(root, "runs");
  const requestIndexPath = join(runRoot, "requests.jsonl");
  const indexPath = join(runRoot, "index.jsonl");
  const logsDir = join(root, "logs");
  const outLog = join(logsDir, "server.out.log");
  const errLog = join(logsDir, "server.err.log");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(mapPath, `${JSON.stringify({ "oracle-agent": workspace }, null, 2)}\n`);

  const port = await getFreePort();
  const env = {
    ...process.env,
    PORT: String(port),
    APR_TOKEN: DEFAULT_TOKEN,
    APR_HARDENING_V2: "1",
    APR_STRICT: "1",
    APR_SAVE_ARTIFACTS: "1",
    APR_ALLOW_NO_ARTIFACTS: "0",
    APR_ENGINE_TARGET: "browser",
    APR_MODEL_TARGET: "gpt-5.2-pro",
    APR_THINKING_POLICY: "extended",
    APR_ALLOW_UNVERIFIABLE_THINKING: "1",
    APR_ORACLE_PATH: oraclePath || ORACLE_FIXTURE,
    APR_ORACLE_TIMEOUT_MS: String(oracleTimeoutMs),
    APR_ORACLE_VERSION_EXPECTED: "0.8.6",
    APR_WORKSPACE_MAP_FILE: mapPath,
    APR_DEFAULT_AGENT: "oracle-agent",
    APR_PLAN_SUBDIR: "plans/apr",
    APR_MAX_CONCURRENT_GLOBAL: "1",
    APR_MAX_CONCURRENT_PER_WORKSPACE: "1",
    APR_MAX_CONCURRENT_PER_PROJECT: "1",
    APR_LOCK_DIR: lockDir,
    APR_INDEX_PATH: indexPath,
    APR_REQUEST_INDEX_PATH: requestIndexPath,
  };

  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  const err = [];
  proc.stdout?.on("data", (chunk) => out.push(Buffer.from(chunk)));
  proc.stderr?.on("data", (chunk) => err.push(Buffer.from(chunk)));

  try {
    await waitForServer(port);
  } catch (waitErr) {
    const outText = Buffer.concat(out).toString("utf8");
    const errText = Buffer.concat(err).toString("utf8");
    writeFileSync(outLog, outText);
    writeFileSync(errLog, errText);
    await stopServer(proc);
    throw waitErr;
  }

  return {
    port,
    root,
    workspace,
    async stop() {
      await stopServer(proc);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function postPlan(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/plan`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEFAULT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return { status: response.status, body };
}

function readOracleCmd(path) {
  return JSON.parse(readFileSync(join(path, "oracle_cmd.json"), "utf8"));
}

function findArtifactsPath(workspace, runId) {
  const root = join(workspace, "plans", "apr");
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(current, entry.name);
      if (entry.name.includes(runId) && !entry.name.endsWith(".tmp")) {
        return fullPath;
      }
      stack.push(fullPath);
    }
  }
  return null;
}

function assertOracleCmdShape(cmd) {
  const expectedKeys = [
    "run_id",
    "argv",
    "cwd",
    "timeout_ms",
    "started_at",
    "ended_at",
    "exit_code",
    "signal",
    "timed_out",
    "stdout_bytes",
    "stderr_bytes",
    "stdout_truncated",
    "stderr_truncated",
  ];
  for (const key of expectedKeys) {
    assert.ok(Object.hasOwn(cmd, key), `oracle_cmd.json missing key: ${key}`);
  }
  assert.ok(Array.isArray(cmd.argv), "oracle_cmd.json argv must be an array");
  assert.equal(typeof cmd.cwd, "string");
  assert.equal(typeof cmd.timeout_ms, "number");
  assert.equal(typeof cmd.started_at, "string");
  assert.equal(typeof cmd.ended_at, "string");
  assert.equal(typeof cmd.timed_out, "boolean");
  assert.equal(typeof cmd.stdout_bytes, "number");
  assert.equal(typeof cmd.stderr_bytes, "number");
  assert.equal(typeof cmd.stdout_truncated, "boolean");
  assert.equal(typeof cmd.stderr_truncated, "boolean");
}

test("invalid oracle path returns E_ORACLE_NOT_FOUND", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "apr-oracle-notfound-"));
  try {
    const result = await runOracleInvocation({
      runId: "run-invalid-path",
      argv: [
        "/definitely/not/a/real/oracle",
        "--prompt",
        "p",
        "--model",
        "gpt-5.2-pro",
        "--engine",
        "browser",
        "--wait",
      ],
      cwd: workspace,
      env: {
        ...process.env,
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
        TERM: "dumb",
        NO_COLOR: "1",
      },
      timeoutMs: 2_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "E_ORACLE_NOT_FOUND");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("invalid cwd returns E_ORACLE_SPAWN_FAILED", async () => {
  const result = await runOracleInvocation({
    runId: "run-invalid-cwd",
    argv: buildOracleArgv({
      oraclePath: ORACLE_FIXTURE,
      prompt: "invalid cwd",
      model: "gpt-5.2-pro",
      engine: "browser",
    }),
    cwd: "relative/path",
    env: {
      ...process.env,
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TERM: "dumb",
      NO_COLOR: "1",
    },
    timeoutMs: 2_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "E_ORACLE_SPAWN_FAILED");
});

test("timeout returns E_ORACLE_TIMEOUT and persists invocation metadata", async () => {
  const ctx = await startServer({ oracleTimeoutMs: 1_000 });
  try {
    const { status, body } = await postPlan(ctx.port, {
      agent: "oracle-agent",
      project: "oracle-timeout",
      goal: "Generate deterministic timeout test plan with forced delay.",
      context: "SLOW_PLAN",
      request_id: "oracle-timeout-1",
    });
    assert.equal(status, 504);
    assert.equal(responseErrorCode(body), "E_ORACLE_TIMEOUT");

    const details = responseErrorDetails(body);
    const runId = details.run_id;
    assert.equal(typeof runId, "string");
    assert.ok(runId.length > 0);
    const artifactsPath = details.artifacts_path || findArtifactsPath(ctx.workspace, runId);
    assert.equal(typeof artifactsPath, "string");
    assert.ok(artifactsPath.length > 0);

    const cmd = readOracleCmd(artifactsPath);
    assertOracleCmdShape(cmd);
    assert.equal(cmd.run_id, runId);
    assert.equal(cmd.timed_out, true);
    assert.equal(cmd.timeout_ms, 1_000);
    assert.equal(cmd.argv[0], ORACLE_FIXTURE);
    assert.equal(cmd.cwd, ctx.workspace);
  } finally {
    await ctx.stop();
  }
});

test("nonzero oracle exit returns E_ORACLE_EXIT_NONZERO", async () => {
  const ctx = await startServer({ oracleTimeoutMs: 5_000 });
  try {
    const { status, body } = await postPlan(ctx.port, {
      agent: "oracle-agent",
      project: "oracle-nonzero",
      goal: "Generate deterministic nonzero exit test plan.",
      context: "FAIL_PLAN",
      request_id: "oracle-nonzero-1",
    });
    assert.equal(status, 503);
    assert.equal(responseErrorCode(body), "E_ORACLE_EXIT_NONZERO");

    const details = responseErrorDetails(body);
    const runId = details.run_id;
    const artifactsPath = details.artifacts_path || findArtifactsPath(ctx.workspace, runId);
    assert.equal(typeof artifactsPath, "string");
    assert.ok(artifactsPath.length > 0);

    const cmd = readOracleCmd(artifactsPath);
    assertOracleCmdShape(cmd);
    assert.equal(cmd.run_id, runId);
    assert.equal(cmd.timed_out, false);
    assert.equal(cmd.exit_code, 23);
  } finally {
    await ctx.stop();
  }
});

test("deterministic invocation metadata differs only by timestamps", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "apr-oracle-determinism-"));
  try {
    const argv = buildOracleArgv({
      oraclePath: ORACLE_FIXTURE,
      prompt: "deterministic prompt content",
      model: "gpt-5.2-pro",
      engine: "browser",
    });
    const env = {
      ...process.env,
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TERM: "dumb",
      NO_COLOR: "1",
    };

    const run1 = await runOracleInvocation({
      runId: "run-deterministic",
      argv,
      cwd: workspace,
      env,
      timeoutMs: 2_000,
    });
    const run2 = await runOracleInvocation({
      runId: "run-deterministic",
      argv,
      cwd: workspace,
      env,
      timeoutMs: 2_000,
    });

    assert.equal(run1.ok, true);
    assert.equal(run2.ok, true);

    const normalized1 = normalizeOracleCmdRecord(run1.invocation);
    const normalized2 = normalizeOracleCmdRecord(run2.invocation);
    assert.deepEqual(normalized2, normalized1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
