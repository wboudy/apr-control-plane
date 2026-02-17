import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SERVER_ENTRY = join(REPO_ROOT, "src", "server.mjs");
const ORACLE_FAKE_PATH = join(REPO_ROOT, "test", "fixtures", "oracle-fake.sh");
const TOKEN = "concurrency-test-token";
const PLAN_SUBDIR = "plans/apr";
const AGENT = "concurrency-agent";

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
        if (!port) return rejectPort(new Error("Failed to allocate free port"));
        resolvePort(port);
      });
    });
  });
}

async function waitForHealth(port, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status >= 200) return;
    } catch {
      // Retry until timeout.
    }
    await delay(100);
  }
  throw new Error(`Server did not become healthy on port ${port}`);
}

async function waitForExit(proc, timeoutMs = 2_000) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  const exited = await Promise.race([
    new Promise((resolveExit) => proc.once("exit", resolveExit)),
    delay(timeoutMs).then(() => false),
  ]);
  if (exited === false && proc.exitCode == null && proc.signalCode == null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Best effort only.
    }
    await new Promise((resolveExit) => proc.once("exit", resolveExit));
  }
}

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`Invalid JSONL at ${path}:${idx + 1}: ${String(err.message || err)}`);
    }
  });
}

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "apr-concurrency-test-"));
  const workspace = join(root, "workspace");
  const mapPath = join(root, "workspaces.json");
  const lockDir = join(root, "locks");
  const runRoot = join(root, "runs");
  const indexPath = join(runRoot, "index.jsonl");
  const requestIndexPath = join(runRoot, "requests.jsonl");
  await mkdir(workspace, { recursive: true });
  await mkdir(runRoot, { recursive: true });
  await writeFile(mapPath, `${JSON.stringify({ [AGENT]: workspace }, null, 2)}\n`);

  let proc = null;
  let port = null;

  function baseEnv(p) {
    return {
      ...process.env,
      PORT: String(p),
      APR_TOKEN: TOKEN,
      APR_HARDENING_V2: "1",
      APR_STRICT: "1",
      APR_SAVE_ARTIFACTS: "1",
      APR_ALLOW_NO_ARTIFACTS: "0",
      APR_ENGINE_TARGET: "browser",
      APR_MODEL_TARGET: "gpt-5.2-pro",
      APR_THINKING_POLICY: "extended",
      APR_ALLOW_UNVERIFIABLE_THINKING: "1",
      APR_ORACLE_PATH: ORACLE_FAKE_PATH,
      APR_ORACLE_TIMEOUT_MS: "120000",
      APR_ORACLE_VERSION_EXPECTED: "0.8.6",
      APR_WORKSPACE_MAP_FILE: mapPath,
      APR_DEFAULT_AGENT: AGENT,
      APR_PLAN_SUBDIR: PLAN_SUBDIR,
      APR_MAX_CONCURRENT_GLOBAL: "100",
      APR_MAX_CONCURRENT_PER_WORKSPACE: "100",
      APR_MAX_CONCURRENT_PER_PROJECT: "100",
      APR_LOCK_DIR: lockDir,
      APR_INDEX_PATH: indexPath,
      APR_REQUEST_INDEX_PATH: requestIndexPath,
    };
  }

  async function start() {
    if (proc && proc.exitCode == null && proc.signalCode == null) {
      throw new Error("Server already running");
    }
    port = await getFreePort();
    const stdout = [];
    const stderr = [];
    proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: baseEnv(port),
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    proc.stderr?.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    try {
      await waitForHealth(port);
    } catch (err) {
      await waitForExit(proc, 2_000);
      throw new Error(
        `${String(err.message || err)}\nSTDOUT:\n${stdout.join("")}\nSTDERR:\n${stderr.join("")}`,
      );
    }
  }

  async function stop(signal = "SIGTERM") {
    if (!proc || proc.exitCode != null || proc.signalCode != null) return;
    try {
      proc.kill(signal);
    } catch {
      return;
    }
    await waitForExit(proc, signal === "SIGKILL" ? 500 : 2_000);
  }

  async function restart() {
    await stop("SIGTERM");
    await start();
  }

  async function postPlan(payload) {
    if (!port) throw new Error("Server has not started");
    const response = await fetch(`http://127.0.0.1:${port}/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  }

  async function postPlanHttp(payload) {
    if (!port) throw new Error("Server has not started");
    return new Promise((resolvePost, rejectPost) => {
      const bodyText = JSON.stringify(payload);
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/plan",
          method: "POST",
          agent: false,
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bodyText),
            connection: "close",
          },
        },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            raw += chunk;
          });
          res.on("end", () => {
            try {
              resolvePost({
                status: Number(res.statusCode || 0),
                body: JSON.parse(raw),
              });
            } catch (err) {
              rejectPost(new Error(`Invalid JSON response: ${String(err.message || err)} (${raw})`));
            }
          });
        },
      );
      req.on("error", rejectPost);
      req.write(bodyText);
      req.end();
    });
  }

  async function postPlanCurl(payload) {
    if (!port) throw new Error("Server has not started");
    return new Promise((resolvePost, rejectPost) => {
      const bodyText = JSON.stringify(payload);
      const args = [
        "-sS",
        "-X",
        "POST",
        `http://127.0.0.1:${port}/plan`,
        "-H",
        "Content-Type: application/json",
        "-H",
        `Authorization: Bearer ${TOKEN}`,
        "-d",
        bodyText,
        "-w",
        "\\n%{http_code}",
      ];
      const proc = spawn("curl", args, { cwd: REPO_ROOT });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          rejectPost(new Error(`curl failed (${code}): ${stderr || "<no stderr>"}`));
          return;
        }
        const lines = stdout.split(/\r?\n/);
        const statusRaw = lines.pop() || "";
        const status = Number.parseInt(statusRaw.trim(), 10);
        const bodyRaw = lines.join("\n");
        try {
          resolvePost({
            status,
            body: JSON.parse(bodyRaw),
          });
        } catch (err) {
          rejectPost(new Error(`Invalid curl JSON response: ${String(err.message || err)} (${bodyRaw})`));
        }
      });
    });
  }

  async function cleanup() {
    await stop("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }

  return {
    root,
    workspace,
    indexPath,
    requestIndexPath,
    runsDir: join(workspace, "plans", "apr", "runs"),
    start,
    stop,
    restart,
    postPlan,
    postPlanHttp,
    postPlanCurl,
    cleanup,
  };
}

test("parallel /plan for same workspace+project returns one success and E_LOCK_CONTENDED for others", async () => {
  const harness = await createHarness();
  await harness.start();
  try {
    const firstPromise = harness.postPlanCurl({
      agent: AGENT,
      project: "lock-same-project",
      goal: "Create deterministic lock contention plan for concurrency validation.",
      context: "SLOW_PLAN",
      request_id: "parallel-lock-0",
    });

    await delay(1_000);

    const restResponses = await Promise.all(
      Array.from({ length: 4 }, (_, idx) =>
        harness.postPlanCurl({
          agent: AGENT,
          project: "lock-same-project",
          goal: "Create deterministic lock contention plan for concurrency validation.",
          context: `contention-${idx + 1}`,
          request_id: `parallel-lock-${idx + 1}`,
        }),
      ),
    );
    const firstResponse = await firstPromise;

    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.body.ok, true);

    const contended = restResponses.filter(
      (res) =>
        res.status === 409 &&
        res.body.ok === false &&
        res.body.error?.code === "E_LOCK_CONTENDED" &&
        res.body.error?.retryable === true,
    );

    assert.equal(contended.length, restResponses.length);
  } finally {
    await harness.cleanup();
  }
});

test("process kill mid-run preserves parseable index and quarantines tmp.* on restart", async () => {
  const harness = await createHarness();
  await harness.start();
  try {
    const baseline = await harness.postPlan({
      agent: AGENT,
      project: "recovery-baseline",
      goal: "Create deterministic baseline plan before crash recovery test.",
      context: "baseline",
      request_id: "recovery-baseline-1",
    });
    assert.equal(baseline.status, 200);
    assert.equal(baseline.body.ok, true);

    const beforeCrashIndex = await readJsonl(harness.indexPath);
    assert.ok(beforeCrashIndex.length >= 1);

    const pending = harness
      .postPlanCurl({
      agent: AGENT,
      project: "recovery-crash",
      goal: "Create deterministic plan that will be interrupted mid-run for crash recovery.",
      context: "SLOW_PLAN",
      request_id: "recovery-crash-1",
    })
      .catch(() => null);
    await delay(500);
    await harness.stop("SIGKILL");
    await pending;

    const indexAfterKill = await readJsonl(harness.indexPath);
    assert.ok(indexAfterKill.length >= 1);

    const runsBeforeRestart = existsSync(harness.runsDir)
      ? await readdir(harness.runsDir, { withFileTypes: true })
      : [];
    const tmpBeforeRestart = runsBeforeRestart.filter((entry) => entry.isDirectory() && entry.name.startsWith("tmp."));
    let expectedRecoveredTmp = tmpBeforeRestart.length;
    if (expectedRecoveredTmp === 0) {
      await mkdir(join(harness.runsDir, "tmp.manual-recovery"), { recursive: true });
      expectedRecoveredTmp = 1;
    }

    await harness.restart();

    const indexAfterRestart = await readJsonl(harness.indexPath);
    assert.ok(indexAfterRestart.length >= 1);

    const runsAfterRestart = await readdir(harness.runsDir, { withFileTypes: true });
    const tmpAfterRestart = runsAfterRestart.filter((entry) => entry.isDirectory() && entry.name.startsWith("tmp."));
    const quarantineAfterRestart = runsAfterRestart.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("quarantine."),
    );
    assert.equal(tmpAfterRestart.length, 0);
    assert.ok(quarantineAfterRestart.length >= expectedRecoveredTmp);
  } finally {
    await harness.cleanup();
  }
});

test("global index.jsonl remains parseable after 100 sequential runs", async () => {
  const harness = await createHarness();
  await harness.start();
  try {
    for (let i = 0; i < 100; i += 1) {
      const response = await harness.postPlan({
        agent: AGENT,
        project: `seq-project-${i % 5}`,
        goal: "Create deterministic sequential run plan for JSONL parseability validation.",
        context: `sequential-${i}`,
        request_id: `sequential-${i}`,
      });
      assert.equal(response.status, 200, `Run ${i} failed: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.ok, true);
    }

    const globalEntries = await readJsonl(harness.indexPath);
    assert.equal(globalEntries.length, 100);

    const workspaceEntries = await readJsonl(join(harness.workspace, "plans", "apr", "index.jsonl"));
    assert.equal(workspaceEntries.length, 100);
  } finally {
    await harness.cleanup();
  }
});
