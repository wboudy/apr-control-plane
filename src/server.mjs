#!/usr/bin/env node
// APR Trigger Service
// HTTP bridge for APR + Oracle planning.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const SERVICE_NAME = "apr-trigger";
const SERVICE_VERSION = "2.1.0";

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envInt(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function isoNow() {
  return new Date().toISOString();
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function hashString(input) {
  return createHash("sha1").update(String(input)).digest("hex").slice(0, 16);
}

function slugify(value, maxLen = 64) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) return "x";
  return normalized.slice(0, maxLen);
}

function redactSecrets(text) {
  if (!text) return "";
  return String(text)
    .replace(/Authorization:\s*Bearer\s+[^\s\n]+/gi, "Authorization: Bearer <<REDACTED>>")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "<<REDACTED:OPENAI_KEY>>")
    .replace(/\bghp_[A-Za-z0-9]{10,}\b/g, "<<REDACTED:GITHUB_TOKEN>>");
}

function checkAuth(req, token) {
  const auth = req.headers.authorization;
  if (!auth) return false;
  return auth === `Bearer ${token}`;
}

function parseBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 200_000) {
        rejectBody(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolveBody({});
      try {
        resolveBody(JSON.parse(data));
      } catch {
        rejectBody(new Error("Invalid JSON"));
      }
    });
  });
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function errorResult(status, code, message, extras = {}) {
  return {
    status,
    body: {
      ok: false,
      code,
      error: message,
      message,
      retryable: Boolean(extras.retryable),
      ...extras,
    },
  };
}

function ensureDir(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}

function assertWritableDir(path) {
  ensureDir(path, 0o700);
  const probe = join(path, `.write-probe-${process.pid}-${Date.now()}`);
  writeFileSync(probe, "ok", { mode: 0o600 });
  unlinkSync(probe);
}

function writeFileAtomic(path, content, mode = 0o600) {
  ensureDir(dirname(path), 0o700);
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(tmpPath, "w", mode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}

function readJsonFile(path) {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function buildRuntimePath() {
  const paths = new Set((process.env.PATH || "").split(delimiter).filter(Boolean));
  paths.add(dirname(process.execPath));
  paths.add(join(homedir(), ".local", "bin"));
  paths.add("/opt/homebrew/bin");
  paths.add("/usr/local/bin");
  paths.add("/usr/bin");
  paths.add("/bin");
  return Array.from(paths).join(delimiter);
}

const RUNTIME_PATH = buildRuntimePath();

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(binName, pathValue = RUNTIME_PATH) {
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binName);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

const CONFIG = {
  port: envInt("PORT", 9444, 1),
  token: process.env.APR_TOKEN || "Zayy8714",
  hardeningV2: envBool("APR_HARDENING_V2", true),
  strict: envBool("APR_STRICT", true),
  saveArtifacts: envBool("APR_SAVE_ARTIFACTS", true),
  allowNoArtifacts: envBool("APR_ALLOW_NO_ARTIFACTS", false),
  engineTarget: process.env.APR_ENGINE_TARGET || "browser",
  modelTarget: process.env.APR_MODEL_TARGET || "gpt-5.2-pro",
  thinkingPolicy: process.env.APR_THINKING_POLICY || "extended",
  allowUnverifiableThinking: envBool("APR_ALLOW_UNVERIFIABLE_THINKING", false),
  oraclePath: expandHome(process.env.APR_ORACLE_PATH || "") || "",
  oracleTimeoutMs: envInt("APR_ORACLE_TIMEOUT_MS", 900_000, 1_000),
  oracleVersionExpected: process.env.APR_ORACLE_VERSION_EXPECTED || "",
  workspaceMapFile:
    expandHome(process.env.APR_WORKSPACE_MAP_FILE || "~/.local/etc/apr-trigger/workspaces.json"),
  defaultAgent: process.env.APR_DEFAULT_AGENT || "captain-rusty",
  planSubdir: process.env.APR_PLAN_SUBDIR || "plans/apr",
  maxConcurrentGlobal: envInt("APR_MAX_CONCURRENT_GLOBAL", 1, 1),
  maxConcurrentPerWorkspace: envInt("APR_MAX_CONCURRENT_PER_WORKSPACE", 1, 1),
  maxConcurrentPerProject: envInt("APR_MAX_CONCURRENT_PER_PROJECT", 1, 1),
  lockDir: expandHome(process.env.APR_LOCK_DIR || "~/.local/share/apr-trigger/locks"),
  queueMode: process.env.APR_QUEUE_MODE || "none",
  indexPath: expandHome(process.env.APR_INDEX_PATH || "~/.local/share/apr-trigger/runs/index.jsonl"),
  retentionDays: envInt("APR_RETENTION_DAYS", 30, 1),
  maxDiskGb: envInt("APR_MAX_DISK_GB", 20, 1),
  requestIndexPath:
    expandHome(process.env.APR_REQUEST_INDEX_PATH || "~/.local/share/apr-trigger/runs/requests.jsonl"),
};

const LOCK_STALE_MS = Math.max(CONFIG.oracleTimeoutMs + 5 * 60 * 1000, 30 * 60 * 1000);
const MAX_ROUND = 100;
const BASE_ENV = { PATH: RUNTIME_PATH, HOME: homedir(), TERM: "dumb", NO_COLOR: "1" };

const ORACLE_ENV_ALLOWLIST = new Set([
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ORACLE_HOME_DIR",
]);

const state = {
  activeRuns: new Map(),
  runStore: new Map(),
  requestInFlight: new Map(),
  requestCache: new Map(),
  metrics: {
    total: 0,
    success: 0,
    failed: 0,
    byCode: {},
    recent: [],
  },
  preflightCache: {
    atMs: 0,
    result: null,
  },
};

function logEvent(phase, fields = {}) {
  const payload = {
    ts: isoNow(),
    service: SERVICE_NAME,
    phase,
    ...fields,
  };
  console.log(JSON.stringify(payload));
}

function safePushRecent(entry) {
  state.metrics.recent.push(entry);
  if (state.metrics.recent.length > 200) {
    state.metrics.recent.shift();
  }
}

function incrementErrorCode(code) {
  const current = state.metrics.byCode[code] || 0;
  state.metrics.byCode[code] = current + 1;
}

function bootstrapWorkspaceMap() {
  if (existsSync(CONFIG.workspaceMapFile)) return;
  const defaultWorkspace = join(homedir(), ".openclaw", `workspace-${CONFIG.defaultAgent}`);
  if (!existsSync(defaultWorkspace)) return;
  ensureDir(dirname(CONFIG.workspaceMapFile), 0o700);
  writeFileAtomic(
    CONFIG.workspaceMapFile,
    `${JSON.stringify({ [CONFIG.defaultAgent]: defaultWorkspace }, null, 2)}\n`,
    0o600,
  );
}

function loadWorkspaceMap() {
  const parsed = readJsonFile(CONFIG.workspaceMapFile);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workspace map must be a JSON object");
  }
  return parsed;
}

function workspaceForAgent(agent, workspaceMap) {
  if (!workspaceMap[agent] || typeof workspaceMap[agent] !== "string") {
    throw new Error(`Unknown agent alias: ${agent}`);
  }
  const resolved = resolve(expandHome(workspaceMap[agent]));
  if (!existsSync(resolved)) {
    throw new Error(`Workspace path does not exist: ${resolved}`);
  }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  assertWritableDir(resolved);
  return resolved;
}

function resolveOracleInvocation() {
  const configured = CONFIG.oraclePath ? resolve(expandHome(CONFIG.oraclePath)) : "";
  if (configured) {
    if (!isAbsolute(configured)) return null;
    if (!isExecutable(configured)) return null;
    return { command: configured, prefixArgs: [], source: "configured" };
  }

  const oracleBin = findInPath("oracle");
  if (oracleBin) {
    return { command: oracleBin, prefixArgs: [], source: "path" };
  }

  if (CONFIG.strict) return null;

  const npxBin = findInPath("npx");
  if (npxBin) {
    return { command: npxBin, prefixArgs: ["-y", "@steipete/oracle"], source: "npx" };
  }

  return null;
}

function buildOracleEnv(oracleCommandPath) {
  const env = { ...BASE_ENV };
  const commandDir = dirname(oracleCommandPath);
  env.PATH = [commandDir, RUNTIME_PATH].join(delimiter);
  for (const key of ORACLE_ENV_ALLOWLIST) {
    if (key in process.env && process.env[key] != null && process.env[key] !== "") {
      env[key] = String(process.env[key]);
    }
  }
  return env;
}

function probeOracleVersion(invocation, timeoutMs = 15_000) {
  return new Promise((resolveProbe) => {
    const proc = spawn(invocation.command, [...invocation.prefixArgs, "--version"], {
      shell: false,
      env: buildOracleEnv(invocation.command),
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", (code) => {
      const combined = `${stdout}\n${stderr}`.trim();
      const firstLine = (combined.split(/\r?\n/)[0] || "").trim();
      const versionMatch = firstLine.match(/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/);
      resolveProbe({
        ok: code === 0,
        code,
        raw: combined,
        version: versionMatch ? versionMatch[1] : firstLine || "unknown",
      });
    });

    proc.on("error", (err) => {
      resolveProbe({ ok: false, code: -1, raw: err.message, version: "unknown" });
    });
  });
}

function artifactStoreRoot() {
  return dirname(CONFIG.indexPath);
}

function freeBytesForPath(path) {
  try {
    const stat = statfsSync(path);
    return Number(stat.bsize) * Number(stat.bavail);
  } catch {
    return null;
  }
}

async function runPreflightChecks() {
  const errors = [];
  const invocation = resolveOracleInvocation();
  const result = {
    ok: true,
    errors,
    oracle: {
      available: false,
      path: invocation ? invocation.command : null,
      version: null,
      source: invocation ? invocation.source : null,
    },
    routing: {
      workspace_map_file: CONFIG.workspaceMapFile,
      default_agent: CONFIG.defaultAgent,
      map_loaded: false,
    },
    artifact_store: {
      root: artifactStoreRoot(),
      writable: false,
      free_bytes: null,
    },
    queue: {
      max_concurrent_global: CONFIG.maxConcurrentGlobal,
      max_concurrent_per_workspace: CONFIG.maxConcurrentPerWorkspace,
      max_concurrent_per_project: CONFIG.maxConcurrentPerProject,
      active: state.activeRuns.size,
      depth: 0,
    },
  };

  if (!invocation) {
    errors.push("Oracle CLI invocation could not be resolved");
  } else {
    const probe = await probeOracleVersion(invocation);
    if (!probe.ok) {
      errors.push(`Oracle version probe failed: ${probe.raw || `exit ${String(probe.code)}`}`);
    } else {
      result.oracle.available = true;
      result.oracle.version = probe.version;
      if (CONFIG.oracleVersionExpected && probe.version !== CONFIG.oracleVersionExpected) {
        errors.push(
          `Oracle version mismatch: expected ${CONFIG.oracleVersionExpected}, got ${probe.version}`,
        );
      }
    }
  }

  try {
    assertWritableDir(CONFIG.lockDir);
  } catch (err) {
    errors.push(`Lock dir not writable: ${String(err.message || err)}`);
  }

  try {
    assertWritableDir(artifactStoreRoot());
    result.artifact_store.writable = true;
  } catch (err) {
    errors.push(`Artifact store not writable: ${String(err.message || err)}`);
  }

  result.artifact_store.free_bytes = freeBytesForPath(artifactStoreRoot());

  try {
    const map = loadWorkspaceMap();
    const keys = Object.keys(map);
    if (keys.length === 0) {
      errors.push("Workspace map is empty");
    }
    result.routing.map_loaded = true;
  } catch (err) {
    errors.push(`Workspace map load failed: ${String(err.message || err)}`);
  }

  if (CONFIG.strict) {
    if (CONFIG.engineTarget === "auto") {
      errors.push("Strict mode forbids APR_ENGINE_TARGET=auto");
    }
    if (CONFIG.modelTarget === "auto") {
      errors.push("Strict mode forbids APR_MODEL_TARGET=auto");
    }
    if (invocation && !isAbsolute(invocation.command)) {
      errors.push("Strict mode requires absolute Oracle command path");
    }
  }

  result.ok = errors.length === 0;
  return result;
}

async function getPreflight(force = false) {
  const now = Date.now();
  if (!force && state.preflightCache.result && now - state.preflightCache.atMs < 15_000) {
    return state.preflightCache.result;
  }
  const computed = await runPreflightChecks();
  state.preflightCache = { atMs: now, result: computed };
  return computed;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockMetadata(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isStaleLock(metadata) {
  if (!metadata || typeof metadata !== "object") return true;
  if (!Number.isFinite(metadata.created_at_ms)) return true;
  if (Date.now() - metadata.created_at_ms > LOCK_STALE_MS) return true;
  if (Number.isInteger(metadata.pid) && !pidAlive(metadata.pid)) return true;
  return false;
}

function acquireScopedLock(scope, key, maxSlots, runId) {
  ensureDir(CONFIG.lockDir, 0o700);
  const safeScope = slugify(scope, 40);
  const safeKey = slugify(key, 80);
  let firstHolder = null;

  for (let slot = 0; slot < maxSlots; slot += 1) {
    const lockPath = join(CONFIG.lockDir, `${safeScope}_${safeKey}_${slot}.lock`);
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      const payload = {
        run_id: runId,
        scope: safeScope,
        key: safeKey,
        slot,
        pid: process.pid,
        created_at: isoNow(),
        created_at_ms: Date.now(),
      };
      try {
        writeFileSync(fd, JSON.stringify(payload));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { ok: true, lock: { path: lockPath, scope: safeScope, key: safeKey, slot } };
    } catch (err) {
      if (err?.code !== "EEXIST") {
        return { ok: false, error: String(err.message || err), scope: safeScope };
      }

      const metadata = readLockMetadata(lockPath);
      if (!firstHolder && metadata) firstHolder = metadata;

      if (isStaleLock(metadata)) {
        try {
          unlinkSync(lockPath);
          slot -= 1;
          continue;
        } catch {
          // Another process may own it now; keep scanning.
        }
      }
    }
  }

  return {
    ok: false,
    scope: safeScope,
    holder: firstHolder,
  };
}

function releaseLocks(locks) {
  for (const lock of locks.slice().reverse()) {
    try {
      unlinkSync(lock.path);
    } catch {
      // Best effort only.
    }
  }
}

function acquireRunLocks(agent, projectSlug, runId) {
  const locks = [];

  const lockPlan = [
    { scope: "global", key: "global", slots: CONFIG.maxConcurrentGlobal },
    { scope: "workspace", key: agent, slots: CONFIG.maxConcurrentPerWorkspace },
    { scope: "project", key: `${agent}_${projectSlug}`, slots: CONFIG.maxConcurrentPerProject },
  ];

  for (const spec of lockPlan) {
    const result = acquireScopedLock(spec.scope, spec.key, spec.slots, runId);
    if (!result.ok) {
      releaseLocks(locks);
      return {
        ok: false,
        lock_scope: spec.scope,
        holder: result.holder || null,
      };
    }
    locks.push(result.lock);
  }

  return { ok: true, locks };
}

function appendJsonl(path, obj) {
  ensureDir(dirname(path), 0o700);
  const lock = acquireScopedLock("index", hashString(path), 1, `index-${hashString(path)}`);
  if (!lock.ok) {
    throw new Error(`Index lock unavailable for ${path}`);
  }

  try {
    const fd = openSync(path, "a", 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(obj)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    releaseLocks([lock.lock]);
  }
}

function loadRequestCache() {
  if (!existsSync(CONFIG.requestIndexPath)) return;
  const lines = readFileSync(CONFIG.requestIndexPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (!item.request_id || !item.response || typeof item.http_status !== "number") continue;
      state.requestCache.set(item.request_id, {
        http_status: item.http_status,
        response: item.response,
        run_id: item.run_id,
        saved_at: item.saved_at,
      });
    } catch {
      // Skip malformed lines.
    }
  }
}

function persistRequestCache(requestId, runId, status, responseBody) {
  const record = {
    request_id: requestId,
    run_id: runId,
    http_status: status,
    response: responseBody,
    saved_at: isoNow(),
  };
  state.requestCache.set(requestId, {
    http_status: status,
    response: responseBody,
    run_id: runId,
    saved_at: record.saved_at,
  });
  appendJsonl(CONFIG.requestIndexPath, record);
}

function makeRunId() {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function updateRunStore(runId, patch) {
  const existing = state.runStore.get(runId) || {};
  state.runStore.set(runId, { ...existing, ...patch });
}

function buildThinkingVerifiability(preflight) {
  const hasPinnedModel = CONFIG.modelTarget && CONFIG.modelTarget !== "auto";
  const hasPinnedEngine = CONFIG.engineTarget && CONFIG.engineTarget !== "auto";
  const versionPinned = !CONFIG.oracleVersionExpected || preflight.oracle.version === CONFIG.oracleVersionExpected;
  if (hasPinnedModel && hasPinnedEngine && versionPinned) {
    return "INFERRED";
  }
  return "UNVERIFIABLE";
}

function planningPrompt(project, goal, context) {
  return `
# Deep Implementation Planning Request

You are an expert software architect. Create a comprehensive implementation plan for the following goal.

## Project: ${project}
## Goal: ${goal}
${context ? `## Additional Context:\n${context}` : ""}

---

## Instructions

Think deeply about the architecture before listing steps. Your plan will be converted into trackable work items (beads) for a team of AI coding agents.

### Required Output Format

Provide your response in the following structured markdown format:

## Architecture Decisions

For each major decision, explain:
- What: The decision made
- Why: The rationale
- Alternatives Considered: What else was evaluated
- Trade-offs: What we gain and what we sacrifice

## Implementation Steps

Number each step sequentially. For each step:

### Step N: [Action-oriented title]

**Description:** What this step accomplishes

**Dependencies:** Which previous steps must complete first (or "None")

**Parallelizable:** Yes/No - Can this run alongside other steps?

**Estimated Complexity:** Low / Medium / High

**Acceptance Criteria:**
- [ ] Specific, testable outcome 1
- [ ] Specific, testable outcome 2

**Files Likely Touched:**
- path/to/file1
- path/to/file2

**Risks/Edge Cases:**
- Potential issue and mitigation

---

## Sequencing Summary

Show the dependency graph as a simple ASCII diagram or list.

## Decisions Requiring Human Input

List anything that needs clarification before implementation can proceed.

---

Now create the implementation plan.
`;
}

function runOracle({ prompt, workspacePath, invocation }) {
  return new Promise((resolveRun) => {
    const args = [
      ...invocation.prefixArgs,
      "--prompt",
      prompt,
      "--model",
      CONFIG.modelTarget,
      "--engine",
      CONFIG.engineTarget,
      "--wait",
    ];

    const proc = spawn(invocation.command, args, {
      shell: false,
      cwd: workspacePath,
      env: buildOracleEnv(invocation.command),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Best effort.
      }
    }, CONFIG.oracleTimeoutMs);

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      resolveRun({
        ok: !timedOut && code === 0,
        code,
        signal,
        timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        command: invocation.command,
        args,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutHandle);
      resolveRun({
        ok: false,
        code: -1,
        signal: null,
        timedOut,
        stdout: stdout.trim(),
        stderr: err.message,
        command: invocation.command,
        args,
      });
    });
  });
}

function runApr(args, timeoutMs = CONFIG.oracleTimeoutMs) {
  return new Promise((resolveRun) => {
    const aprPath = findInPath("apr") || "apr";
    const proc = spawn(aprPath, args, {
      shell: false,
      env: BASE_ENV,
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      resolveRun({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.on("error", (err) => {
      resolveRun({ ok: false, code: -1, stdout: "", stderr: err.message });
    });
  });
}

function validateRound(round) {
  const n = Number.parseInt(String(round), 10);
  if (!Number.isFinite(n) || n < 1 || n > MAX_ROUND) return null;
  return n;
}

function buildRunPaths(workspacePath, projectSlug, runId) {
  const day = isoNow().slice(0, 10);
  const baseDir = join(workspacePath, CONFIG.planSubdir, day);
  const runName = `${compactTimestamp()}_${projectSlug}_${runId}`;
  const finalDir = join(baseDir, runName);
  return {
    baseDir,
    finalDir,
    tmpDir: `${finalDir}.tmp`,
    latestDir: join(workspacePath, CONFIG.planSubdir, "latest"),
    workspaceIndexPath: join(workspacePath, CONFIG.planSubdir, "index.jsonl"),
  };
}

function serviceStatusBody(preflight) {
  return {
    ok: preflight.ok,
    status: preflight.ok ? "ok" : "fail",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    oracle: preflight.oracle,
    defaults: {
      strict: CONFIG.strict,
      save_artifacts: CONFIG.saveArtifacts,
      engine: CONFIG.engineTarget,
      model: CONFIG.modelTarget,
      thinking_policy: CONFIG.thinkingPolicy,
    },
    routing: preflight.routing,
    queue: {
      ...preflight.queue,
      active: state.activeRuns.size,
      depth: 0,
    },
    artifact_store: preflight.artifact_store,
    preflight: {
      ok: preflight.ok,
      errors: preflight.errors,
    },
    metrics: {
      total: state.metrics.total,
      success: state.metrics.success,
      failed: state.metrics.failed,
      by_code: state.metrics.byCode,
      recent: state.metrics.recent.slice(-20),
    },
    build: {
      version: SERVICE_VERSION,
      sha: process.env.APR_BUILD_SHA || "unknown",
    },
  };
}

async function handlePlan(body) {
  const startedAt = Date.now();
  const requestId =
    typeof body.request_id === "string" && body.request_id.trim()
      ? body.request_id.trim().slice(0, 128)
      : undefined;

  if (requestId && state.requestInFlight.has(requestId)) {
    const inFlightRunId = state.requestInFlight.get(requestId);
    return errorResult(409, "REQUEST_ID_IN_FLIGHT", "request_id is already running", {
      retryable: true,
      run_id: inFlightRunId,
      request_id: requestId,
    });
  }

  if (requestId && state.requestCache.has(requestId)) {
    const cached = state.requestCache.get(requestId);
    return {
      status: cached.http_status,
      body: {
        ...cached.response,
        replayed: true,
      },
    };
  }

  const project = typeof body.project === "string" ? body.project.trim() : "";
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  const context = typeof body.context === "string" ? body.context : "";
  const agent =
    typeof body.agent === "string" && body.agent.trim()
      ? slugify(body.agent, 80)
      : slugify(CONFIG.defaultAgent, 80);

  if (!project) {
    return errorResult(400, "REQUEST_INVALID", "Missing or invalid 'project' field", {
      request_id: requestId,
    });
  }

  if (!goal || goal.length < 10) {
    return errorResult(400, "REQUEST_INVALID", "Missing or invalid 'goal' field (min 10 chars)", {
      request_id: requestId,
    });
  }

  if (goal.length > 20_000 || context.length > 50_000) {
    return errorResult(400, "REQUEST_INVALID", "goal/context too large", { request_id: requestId });
  }

  const runId = makeRunId();
  const projectSlug = slugify(project, 80);
  updateRunStore(runId, {
    run_id: runId,
    request_id: requestId,
    state: "received",
    project,
    project_slug: projectSlug,
    agent,
    started_at: isoNow(),
  });

  if (requestId) {
    state.requestInFlight.set(requestId, runId);
  }
  state.activeRuns.set(runId, {
    run_id: runId,
    request_id: requestId,
    project,
    agent,
    started_at: startedAt,
  });

  let locks = [];
  let artifactsPath = null;

  try {
    const preflight = await getPreflight();
    if (!preflight.ok) {
      return errorResult(503, "DEPENDENCY_UNAVAILABLE", "Preflight checks failed", {
        request_id: requestId,
        run_id: runId,
        details: { errors: preflight.errors },
      });
    }

    let workspaceMap;
    try {
      workspaceMap = loadWorkspaceMap();
    } catch (err) {
      return errorResult(503, "DEPENDENCY_UNAVAILABLE", "Workspace map unavailable", {
        request_id: requestId,
        run_id: runId,
        details: { cause: String(err.message || err) },
      });
    }

    let workspacePath;
    try {
      workspacePath = workspaceForAgent(agent, workspaceMap);
    } catch (err) {
      return errorResult(422, "UNKNOWN_AGENT_ALIAS", String(err.message || err), {
        request_id: requestId,
        run_id: runId,
      });
    }

    const thinkingVerifiability = buildThinkingVerifiability(preflight);
    if (CONFIG.strict && thinkingVerifiability === "UNVERIFIABLE" && !CONFIG.allowUnverifiableThinking) {
      return errorResult(
        409,
        "THINKING_POLICY_UNVERIFIABLE",
        "Thinking policy cannot be verified under strict mode",
        { request_id: requestId, run_id: runId },
      );
    }

    const lockResult = acquireRunLocks(agent, projectSlug, runId);
    if (!lockResult.ok) {
      return errorResult(409, "RUN_BUSY", "Run lock is busy", {
        request_id: requestId,
        run_id: runId,
        retryable: true,
        lock_scope: lockResult.lock_scope,
        locked_by_run_id: lockResult.holder?.run_id || null,
      });
    }
    locks = lockResult.locks;

    updateRunStore(runId, { state: "validated", workspace_path: workspacePath });

    const invocation = resolveOracleInvocation();
    if (!invocation) {
      return errorResult(503, "DEPENDENCY_UNAVAILABLE", "Oracle invocation unavailable", {
        request_id: requestId,
        run_id: runId,
      });
    }

    if (CONFIG.strict && invocation.source === "npx") {
      return errorResult(409, "CONFIG_NOT_SATISFIABLE", "Strict mode forbids npx Oracle fallback", {
        request_id: requestId,
        run_id: runId,
      });
    }

    const paths = buildRunPaths(workspacePath, projectSlug, runId);
    artifactsPath = paths.finalDir;

    if (!CONFIG.saveArtifacts && !CONFIG.allowNoArtifacts) {
      return errorResult(500, "ARTIFACT_PERSIST_FAILED", "Artifacts are required by policy", {
        request_id: requestId,
        run_id: runId,
      });
    }

    if (CONFIG.saveArtifacts) {
      try {
        ensureDir(paths.tmpDir, 0o700);
      } catch (err) {
        return errorResult(500, "ARTIFACT_PERSIST_FAILED", "Failed to initialize artifact directory", {
          request_id: requestId,
          run_id: runId,
          details: { cause: String(err.message || err) },
        });
      }
    }

    const prompt = planningPrompt(project.slice(0, 200), goal.slice(0, 20_000), context.slice(0, 50_000));

    const effectiveConfig = {
      strict: CONFIG.strict,
      engine_target: CONFIG.engineTarget,
      model_target: CONFIG.modelTarget,
      thinking_policy: CONFIG.thinkingPolicy,
      thinking_verifiability: thinkingVerifiability,
      oracle_timeout_ms: CONFIG.oracleTimeoutMs,
      oracle_version_expected: CONFIG.oracleVersionExpected || null,
      oracle_path: invocation.command,
      oracle_source: invocation.source,
      agent,
      workspace_path: workspacePath,
    };

    if (CONFIG.saveArtifacts) {
      writeFileAtomic(
        join(paths.tmpDir, "request.json"),
        `${JSON.stringify(
          {
            agent,
            project,
            goal: redactSecrets(goal),
            context: redactSecrets(context),
            request_id: requestId || null,
            received_at: isoNow(),
          },
          null,
          2,
        )}\n`,
      );
      writeFileAtomic(
        join(paths.tmpDir, "effective_config.json"),
        `${JSON.stringify(effectiveConfig, null, 2)}\n`,
      );
      writeFileAtomic(
        join(paths.tmpDir, "oracle_cmd.json"),
        `${JSON.stringify(
          {
            command: invocation.command,
            args: [
              ...invocation.prefixArgs,
              "--prompt",
              "<redacted_prompt>",
              "--model",
              CONFIG.modelTarget,
              "--engine",
              CONFIG.engineTarget,
              "--wait",
            ],
            cwd: workspacePath,
            timeout_ms: CONFIG.oracleTimeoutMs,
            env_keys: Array.from(ORACLE_ENV_ALLOWLIST).sort(),
          },
          null,
          2,
        )}\n`,
      );
    }

    updateRunStore(runId, { state: "running" });
    logEvent("plan_run_started", {
      run_id: runId,
      request_id: requestId || null,
      agent,
      project,
      goal_length: goal.length,
      effective_engine: CONFIG.engineTarget,
      effective_model: CONFIG.modelTarget,
      thinking_verifiability: thinkingVerifiability,
      workspace_path: workspacePath,
    });

    const oracle = await runOracle({ prompt, workspacePath, invocation });
    const durationMs = Date.now() - startedAt;

    const successBody = {
      ok: true,
      status: "done",
      run_id: runId,
      request_id: requestId || null,
      agent,
      workspace_path: workspacePath,
      artifacts_path: artifactsPath,
      effective_engine: CONFIG.engineTarget,
      effective_model: CONFIG.modelTarget,
      effective_thinking_policy: CONFIG.thinkingPolicy,
      thinking_verifiability: thinkingVerifiability,
      duration_ms: durationMs,
      project,
      goal,
      plan: oracle.stdout,
      message: "Plan generated. Use 'decompose' palette command to convert to beads.",
    };

    let result;

    if (oracle.timedOut) {
      result = errorResult(504, "ORACLE_TIMEOUT", "Oracle planning timed out", {
        retryable: true,
        run_id: runId,
        request_id: requestId,
        workspace_path: workspacePath,
        artifacts_path: artifactsPath,
      });
    } else if (!oracle.ok) {
      result = errorResult(503, "DEPENDENCY_UNAVAILABLE", "Oracle planning failed", {
        run_id: runId,
        request_id: requestId,
        workspace_path: workspacePath,
        artifacts_path: artifactsPath,
        details: {
          oracle_exit_code: oracle.code,
          oracle_signal: oracle.signal,
          stderr: oracle.stderr.slice(0, 2000),
        },
      });
    } else {
      result = { status: 200, body: successBody };
    }

    const meta = {
      run_id: runId,
      request_id: requestId || null,
      agent,
      project,
      workspace_path: workspacePath,
      artifacts_path: artifactsPath,
      started_at: new Date(startedAt).toISOString(),
      finished_at: isoNow(),
      duration_ms: durationMs,
      status: result.body.ok ? "done" : "failed",
      oracle: {
        path: invocation.command,
        version: preflight.oracle.version,
        exit_code: oracle.code,
        signal: oracle.signal,
        timed_out: oracle.timedOut,
      },
      effective_engine: CONFIG.engineTarget,
      effective_model: CONFIG.modelTarget,
      effective_thinking_policy: CONFIG.thinkingPolicy,
      thinking_verifiability: thinkingVerifiability,
      error: result.body.ok
        ? null
        : {
            code: result.body.code,
            message: result.body.message,
            retryable: result.body.retryable,
          },
    };

    if (CONFIG.saveArtifacts) {
      try {
        writeFileAtomic(join(paths.tmpDir, "oracle_stdout.txt"), `${oracle.stdout}\n`);
        writeFileAtomic(join(paths.tmpDir, "oracle_stderr.txt"), `${oracle.stderr}\n`);
        writeFileAtomic(join(paths.tmpDir, "response.json"), `${JSON.stringify(result.body, null, 2)}\n`);
        writeFileAtomic(join(paths.tmpDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
        if (result.body.ok) {
          writeFileAtomic(join(paths.tmpDir, "plan.md"), `${oracle.stdout}\n`);
        }
        ensureDir(paths.baseDir, 0o700);
        renameSync(paths.tmpDir, paths.finalDir);

        if (result.body.ok) {
          ensureDir(paths.latestDir, 0o700);
          writeFileAtomic(join(paths.latestDir, `${projectSlug}.md`), `${oracle.stdout}\n`);
        }

        const indexRecord = {
          ts: isoNow(),
          run_id: runId,
          request_id: requestId || null,
          agent,
          project,
          project_slug: projectSlug,
          workspace_path: workspacePath,
          artifacts_path: paths.finalDir,
          status: result.body.ok ? "done" : "failed",
          code: result.body.code || null,
          duration_ms: durationMs,
          effective_engine: CONFIG.engineTarget,
          effective_model: CONFIG.modelTarget,
          thinking_verifiability: thinkingVerifiability,
        };

        appendJsonl(paths.workspaceIndexPath, indexRecord);
        appendJsonl(CONFIG.indexPath, indexRecord);
      } catch (err) {
        const persistError = errorResult(
          500,
          "ARTIFACT_PERSIST_FAILED",
          "Failed to persist run artifacts",
          {
            run_id: runId,
            request_id: requestId,
            details: { cause: String(err.message || err) },
          },
        );
        updateRunStore(runId, {
          state: "failed",
          finished_at: isoNow(),
          error: persistError.body,
          artifacts_path: artifactsPath,
        });
        return persistError;
      }
    }

    updateRunStore(runId, {
      state: result.body.ok ? "done" : "failed",
      finished_at: isoNow(),
      artifacts_path: artifactsPath,
      response: result.body,
      http_status: result.status,
    });

    state.metrics.total += 1;
    if (result.body.ok) {
      state.metrics.success += 1;
    } else {
      state.metrics.failed += 1;
      incrementErrorCode(result.body.code || "UNKNOWN");
    }

    safePushRecent({
      ts: isoNow(),
      run_id: runId,
      request_id: requestId || null,
      project,
      status: result.body.ok ? "done" : "failed",
      code: result.body.code || null,
      duration_ms: durationMs,
    });

    logEvent("plan_run_finished", {
      run_id: runId,
      request_id: requestId || null,
      project,
      status: result.body.ok ? "done" : "failed",
      code: result.body.code || null,
      duration_ms: durationMs,
      oracle_exit_code: oracle.code,
      artifacts_path: artifactsPath,
    });

    if (requestId) {
      persistRequestCache(requestId, runId, result.status, result.body);
    }

    return result;
  } finally {
    if (requestId) {
      state.requestInFlight.delete(requestId);
    }
    state.activeRuns.delete(runId);
    if (locks.length > 0) {
      releaseLocks(locks);
    }
  }
}

async function handleHealth() {
  const preflight = await getPreflight();
  const body = serviceStatusBody(preflight);
  return {
    status: preflight.ok ? 200 : 503,
    body,
  };
}

async function handleServiceStatus() {
  const preflight = await getPreflight();
  return {
    status: preflight.ok ? 200 : 503,
    body: serviceStatusBody(preflight),
  };
}

async function handleRunLookup(runId) {
  const found = state.runStore.get(runId);
  if (!found) {
    return errorResult(404, "RUN_NOT_FOUND", "Run ID not found", { run_id: runId });
  }
  return {
    status: 200,
    body: {
      ok: true,
      ...found,
    },
  };
}

const routes = {
  async run(body) {
    const round = validateRound(body.round);
    if (!round) return errorResult(400, "REQUEST_INVALID", "Invalid round (1-100)");

    const args = ["run", String(round), "--wait"];
    if (body.include_impl) args.push("--include-impl");
    if (body.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    const result = await runApr(args);
    return { status: result.ok ? 200 : 500, body: result };
  },

  async show(body) {
    const round = validateRound(body.round);
    if (!round) return errorResult(400, "REQUEST_INVALID", "Invalid round");

    const args = ["show", String(round)];
    if (body.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    const result = await runApr(args, 30_000);
    return { status: result.ok ? 200 : 500, body: result };
  },

  async aprStatus() {
    const result = await runApr(["status"], 30_000);
    return { status: result.ok ? 200 : 500, body: result };
  },

  async stats(body) {
    const args = ["stats"];
    if (body?.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    const result = await runApr(args, 30_000);
    return { status: result.ok ? 200 : 500, body: result };
  },

  async diff(body) {
    const round = validateRound(body.round);
    if (!round) return errorResult(400, "REQUEST_INVALID", "Invalid round");

    const args = ["diff", String(round)];
    if (body.round2) {
      const r2 = validateRound(body.round2);
      if (r2) args.push(String(r2));
    }
    if (body.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    const result = await runApr(args, 30_000);
    return { status: result.ok ? 200 : 500, body: result };
  },

  async history() {
    const result = await runApr(["history"], 30_000);
    return { status: result.ok ? 200 : 500, body: result };
  },

  async integrate(body) {
    const round = validateRound(body.round);
    if (!round) return errorResult(400, "REQUEST_INVALID", "Invalid round");

    const args = ["integrate", String(round)];
    if (body.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    const result = await runApr(args, 30_000);
    return { status: result.ok ? 200 : 500, body: result };
  },

  async plan(body) {
    return handlePlan(body);
  },

  async health() {
    return handleHealth();
  },

  async serviceStatus() {
    return handleServiceStatus();
  },
};

bootstrapWorkspaceMap();
ensureDir(CONFIG.lockDir, 0o700);
ensureDir(dirname(CONFIG.indexPath), 0o700);
ensureDir(dirname(CONFIG.requestIndexPath), 0o700);
loadRequestCache();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const path = url.pathname;
  const method = req.method || "GET";

  if (path !== "/health" && !checkAuth(req, CONFIG.token)) {
    const out = errorResult(401, "AUTH_INVALID", "Unauthorized. Set Authorization: Bearer <token>");
    jsonResponse(res, out.status, out.body);
    return;
  }

  try {
    if (method === "GET" && /^\/runs\/[^/]+$/.test(path)) {
      const runId = decodeURIComponent(path.slice("/runs/".length));
      const out = await handleRunLookup(runId);
      jsonResponse(res, out.status, out.body);
      return;
    }

    let out;
    if (method === "GET" && path === "/health") {
      out = await routes.health();
    } else if (method === "GET" && path === "/status") {
      out = await routes.serviceStatus();
    } else if (method === "GET" && path === "/apr-status") {
      out = await routes.aprStatus();
    } else if (method === "GET" && path === "/history") {
      out = await routes.history();
    } else if (method === "GET" && path === "/stats") {
      out = await routes.stats({ workflow: url.searchParams.get("workflow") || undefined });
    } else if (method === "POST" && path === "/run") {
      out = await routes.run(await parseBody(req));
    } else if (method === "POST" && path === "/show") {
      out = await routes.show(await parseBody(req));
    } else if (method === "POST" && path === "/diff") {
      out = await routes.diff(await parseBody(req));
    } else if (method === "POST" && path === "/integrate") {
      out = await routes.integrate(await parseBody(req));
    } else if (method === "POST" && path === "/plan") {
      out = await routes.plan(await parseBody(req));
    } else {
      out = errorResult(404, "NOT_FOUND", `Unknown endpoint: ${path}`);
    }

    jsonResponse(res, out.status, out.body);
  } catch (err) {
    const out = errorResult(500, "INTERNAL_ERROR", String(err.message || err));
    jsonResponse(res, out.status, out.body);
  }
});

server.listen(CONFIG.port, "0.0.0.0", async () => {
  const preflight = await getPreflight(true);
  const tokenMask = `${CONFIG.token.slice(0, 4)}${"*".repeat(Math.max(CONFIG.token.length - 4, 0))}`;
  console.log(`
+--------------------------------------------------------------+
|  APR Trigger Service v${SERVICE_VERSION.padEnd(38)}|
|  Listening on 0.0.0.0:${String(CONFIG.port).padEnd(34)}|
|  Token: ${tokenMask.padEnd(52)}|
+--------------------------------------------------------------+
|  Endpoints:
|    GET  /health
|    GET  /status            (service status)
|    GET  /apr-status        (legacy APR status)
|    GET  /runs/:run_id
|    POST /plan
|    POST /run, /show, /diff, /integrate
|    GET  /stats, /history
+--------------------------------------------------------------+
|  Preflight: ${preflight.ok ? "OK" : "FAIL"}
+--------------------------------------------------------------+
`);
});
