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
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parseAllowedTuples, resolveEngineModelPolicy } from "./lib/policy.mjs";
import {
  buildOracleArgv,
  runOracleInvocation,
} from "./lib/oracle.mjs";
import {
  errorCodeOf,
  errorMessageOf,
  errorResult,
  errorRetryableOf,
  normalizeRequestId,
  successResult,
} from "./lib/envelope.mjs";
import {
  E_INTERNAL,
  E_LOCK_CONTENDED,
  E_ORACLE_EXIT_NONZERO,
  E_ORACLE_NOT_FOUND,
  E_ORACLE_TIMEOUT,
  E_POLICY_DISALLOWED_TUPLE,
  E_POLICY_NO_AUTO_IN_STRICT,
  E_PREFLIGHT_FAILED,
} from "./lib/errors.mjs";
import { assertRunState, isAllowedRunState } from "./lib/run-state.mjs";

const SERVICE_NAME = "apr-trigger";
const SERVICE_VERSION = "2.1.0";
const SERVICE_STARTED_AT_MS = Date.now();
const SENSITIVE_KEY_RE =
  /(?:^|[_-])(authorization|token|tokens|cookie|cookies|secret|secrets|api[_-]?key|password|passwd)(?:$|[_-])/i;

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
  if (text == null) return "";
  return String(text)
    .replace(/Authorization:\s*Bearer\s+[^\s\n]+/gi, "<<REDACTED:AUTHORIZATION_HEADER>>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g, "Bearer <<REDACTED>>")
    .replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\n]+/gi, "<<REDACTED:COOKIE_HEADER>>")
    .replace(
      /([?&](?:access_token|id_token|token|tokens|api[_-]?key|secret|secrets|cookie|cookies|authorization)=)([^&\s]+)/gi,
      "$1<<REDACTED>>",
    )
    .replace(
      /\b((?:access_)?token|id_token|api[_-]?key|secret|secrets|cookie|cookies|authorization)\b(\s*[:=]\s*)([^,\s;]+)/gi,
      "$1$2<<REDACTED>>",
    )
    .replace(
      /("(?:access_token|id_token|token|tokens|api[_-]?key|secret|secrets|cookie|cookies|authorization)"\s*:\s*)"[^"]*"/gi,
      '$1"<<REDACTED>>"',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "<<REDACTED:OPENAI_KEY>>")
    .replace(/\bghp_[A-Za-z0-9]{10,}\b/g, "<<REDACTED:GITHUB_TOKEN>>");
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || ""));
}

function redactForPersistence(value, keyHint = "") {
  if (value == null) return value;

  if (typeof value === "string") {
    if (isSensitiveKey(keyHint)) return "<<REDACTED>>";
    return redactSecrets(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    if (isSensitiveKey(keyHint)) return "<<REDACTED>>";
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForPersistence(item, keyHint));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        out[key] = "<<REDACTED>>";
      } else {
        out[key] = redactForPersistence(nested, key);
      }
    }
    return out;
  }

  return value;
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

function textResponse(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
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

function writeRedactedJsonArtifact(path, value) {
  const redacted = redactForPersistence(value);
  writeFileAtomic(path, `${JSON.stringify(redacted, null, 2)}\n`);
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

const STRICT_MODE = envBool("APR_STRICT", true);
const ENGINE_TARGET_RAW = process.env.APR_ENGINE_TARGET;
const MODEL_TARGET_RAW = process.env.APR_MODEL_TARGET;
const ENGINE_TARGET_EXPLICIT = ENGINE_TARGET_RAW != null && String(ENGINE_TARGET_RAW).trim() !== "";
const MODEL_TARGET_EXPLICIT = MODEL_TARGET_RAW != null && String(MODEL_TARGET_RAW).trim() !== "";
const ENGINE_TARGET = ENGINE_TARGET_EXPLICIT ? String(ENGINE_TARGET_RAW).trim() : "auto";
const MODEL_TARGET = MODEL_TARGET_EXPLICIT ? String(MODEL_TARGET_RAW).trim() : "auto";
const ALLOWED_TUPLES = parseAllowedTuples(process.env.APR_ALLOWED_TUPLES);
const ALLOW_TUPLE_FALLBACK = envBool("APR_ALLOW_TUPLE_FALLBACK", !STRICT_MODE);

const CONFIG = {
  port: envInt("PORT", 9444, 1),
  token: process.env.APR_TOKEN || "Zayy8714",
  hardeningV2: envBool("APR_HARDENING_V2", true),
  strict: STRICT_MODE,
  saveArtifacts: envBool("APR_SAVE_ARTIFACTS", true),
  allowNoArtifacts: envBool("APR_ALLOW_NO_ARTIFACTS", false),
  engineTarget: ENGINE_TARGET,
  modelTarget: MODEL_TARGET,
  engineTargetExplicit: ENGINE_TARGET_EXPLICIT,
  modelTargetExplicit: MODEL_TARGET_EXPLICIT,
  allowTupleFallback: ALLOW_TUPLE_FALLBACK,
  allowedTuples: ALLOWED_TUPLES,
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
const RUN_DURATION_BUCKETS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000];

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
    plan_requests_total: {
      success: 0,
      error: 0,
      by_error_code: {},
    },
    run_duration_ms: {
      buckets: [...RUN_DURATION_BUCKETS_MS],
      counts: RUN_DURATION_BUCKETS_MS.map(() => 0),
      count: 0,
      sum: 0,
    },
    lock_contention_total: 0,
    oracle_timeouts_total: 0,
  },
  preflightCache: {
    atMs: 0,
    result: null,
  },
};

function normalizeLogDimension(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function logEvent(event, fields = {}) {
  const payload = { ts: isoNow(), service: SERVICE_NAME, event, ...fields };
  payload.request_id = normalizeLogDimension(payload.request_id);
  payload.run_id = normalizeLogDimension(payload.run_id);
  payload.workspace = normalizeLogDimension(payload.workspace);
  payload.project = normalizeLogDimension(payload.project);
  payload.duration_ms = Number.isFinite(payload.duration_ms) ? Math.max(0, Math.round(payload.duration_ms)) : null;
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

function incrementPlanRequestsTotal(result, errorCode = null) {
  if (result === "success") {
    state.metrics.plan_requests_total.success += 1;
    return;
  }
  state.metrics.plan_requests_total.error += 1;
  if (errorCode) {
    const current = state.metrics.plan_requests_total.by_error_code[errorCode] || 0;
    state.metrics.plan_requests_total.by_error_code[errorCode] = current + 1;
  }
}

function observeRunDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const histogram = state.metrics.run_duration_ms;
  histogram.count += 1;
  histogram.sum += durationMs;
  for (let i = 0; i < histogram.buckets.length; i += 1) {
    if (durationMs <= histogram.buckets[i]) {
      histogram.counts[i] += 1;
      break;
    }
  }
}

function operationalMetricsSnapshot() {
  const histogram = state.metrics.run_duration_ms;
  return {
    plan_requests_total: {
      success: state.metrics.plan_requests_total.success,
      error: state.metrics.plan_requests_total.error,
      by_error_code: state.metrics.plan_requests_total.by_error_code,
    },
    run_duration_ms: {
      buckets: histogram.buckets.map((le, idx) => ({ le, count: histogram.counts[idx] })),
      count: histogram.count,
      sum: histogram.sum,
    },
    lock_contention_total: state.metrics.lock_contention_total,
    oracle_timeouts_total: state.metrics.oracle_timeouts_total,
  };
}

function escapePromLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatPrometheusMetrics() {
  const lines = [];
  lines.push("# HELP plan_requests_total Total count of POST /plan requests grouped by result and error code.");
  lines.push("# TYPE plan_requests_total counter");
  lines.push(`plan_requests_total{result="success"} ${state.metrics.plan_requests_total.success}`);
  lines.push(`plan_requests_total{result="error"} ${state.metrics.plan_requests_total.error}`);
  for (const [errorCode, count] of Object.entries(state.metrics.plan_requests_total.by_error_code)) {
    lines.push(
      `plan_requests_total{result="error",error_code="${escapePromLabel(errorCode)}"} ${count}`,
    );
  }
  lines.push("");

  lines.push("# HELP run_duration_ms End-to-end duration of plan runs in milliseconds.");
  lines.push("# TYPE run_duration_ms histogram");
  const histogram = state.metrics.run_duration_ms;
  let cumulative = 0;
  for (let i = 0; i < histogram.buckets.length; i += 1) {
    cumulative += histogram.counts[i];
    lines.push(`run_duration_ms_bucket{le="${histogram.buckets[i]}"} ${cumulative}`);
  }
  lines.push(`run_duration_ms_bucket{le="+Inf"} ${histogram.count}`);
  lines.push(`run_duration_ms_sum ${histogram.sum}`);
  lines.push(`run_duration_ms_count ${histogram.count}`);
  lines.push("");

  lines.push("# HELP lock_contention_total Count of lock acquisition failures due to contention.");
  lines.push("# TYPE lock_contention_total counter");
  lines.push(`lock_contention_total ${state.metrics.lock_contention_total}`);
  lines.push("");

  lines.push("# HELP oracle_timeouts_total Count of oracle executions terminated due to timeout.");
  lines.push("# TYPE oracle_timeouts_total counter");
  lines.push(`oracle_timeouts_total ${state.metrics.oracle_timeouts_total}`);

  return `${lines.join("\n")}\n`;
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
  const configuredRaw = CONFIG.oraclePath ? expandHome(CONFIG.oraclePath) : "";
  if (configuredRaw) {
    if (!isAbsolute(configuredRaw)) return null;
    const configured = resolve(configuredRaw);
    if (!isExecutable(configured)) return null;
    return { command: configured, source: "configured" };
  }

  const oracleBin = findInPath("oracle");
  if (oracleBin && isAbsolute(oracleBin)) {
    return { command: oracleBin, source: "path" };
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
    const proc = spawn(invocation.command, ["--version"], {
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
  const startedAt = Date.now();
  const fatalErrors = [];
  const warnings = [];
  const invocation = resolveOracleInvocation();
  const policyDecision = resolveEngineModelPolicy({
    strict: CONFIG.strict,
    engine: CONFIG.engineTarget,
    model: CONFIG.modelTarget,
    engineExplicit: CONFIG.engineTargetExplicit,
    modelExplicit: CONFIG.modelTargetExplicit,
    allowFallback: CONFIG.allowTupleFallback,
    allowedTuples: CONFIG.allowedTuples,
  });
  const checks = {
    oracle_path: {
      fatal: true,
      ok: false,
      configured_path: CONFIG.oraclePath ? resolve(expandHome(CONFIG.oraclePath)) : null,
      resolved_path: invocation ? invocation.command : null,
      source: invocation ? invocation.source : null,
      message: null,
    },
    artifacts_dir: {
      fatal: true,
      ok: false,
      path: artifactStoreRoot(),
      message: null,
    },
    lock_dir: {
      fatal: true,
      ok: false,
      path: CONFIG.lockDir,
      message: null,
    },
  };
  const result = {
    ok: true,
    state: "OK",
    checked_at: isoNow(),
    errors: fatalErrors,
    fatal_errors: fatalErrors,
    warnings,
    checks,
    oracle: {
      available: false,
      path: invocation ? invocation.command : null,
      version: null,
      source: invocation ? invocation.source : null,
      error_code: null,
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
    policy: {
      ok: policyDecision.ok,
      code: policyDecision.code,
      requested: policyDecision.requested,
      effective: policyDecision.effective,
      fallback_applied: policyDecision.fallback_applied,
      allowed_tuples: policyDecision.allowed_tuples,
    },
  };

  if (!invocation) {
    result.oracle.error_code = E_ORACLE_NOT_FOUND;
    const msg = "Oracle path is invalid or not executable";
    checks.oracle_path.message = msg;
    fatalErrors.push(msg);
  } else {
    checks.oracle_path.ok = true;
    const probe = await probeOracleVersion(invocation);
    if (!probe.ok) {
      result.oracle.error_code = E_ORACLE_EXIT_NONZERO;
      warnings.push(`Oracle version probe failed: ${probe.raw || `exit ${String(probe.code)}`}`);
    } else {
      result.oracle.available = true;
      result.oracle.version = probe.version;
      if (CONFIG.oracleVersionExpected && probe.version !== CONFIG.oracleVersionExpected) {
        warnings.push(
          `Oracle version mismatch: expected ${CONFIG.oracleVersionExpected}, got ${probe.version}`,
        );
      }
    }
  }

  try {
    assertWritableDir(CONFIG.lockDir);
    checks.lock_dir.ok = true;
  } catch (err) {
    const msg = `Lock dir not writable: ${String(err.message || err)}`;
    checks.lock_dir.message = msg;
    fatalErrors.push(msg);
  }

  try {
    assertWritableDir(artifactStoreRoot());
    checks.artifacts_dir.ok = true;
    result.artifact_store.writable = true;
  } catch (err) {
    const msg = `Artifact store not writable: ${String(err.message || err)}`;
    checks.artifacts_dir.message = msg;
    fatalErrors.push(msg);
  }

  result.artifact_store.free_bytes = freeBytesForPath(artifactStoreRoot());

  try {
    const map = loadWorkspaceMap();
    const keys = Object.keys(map);
    if (keys.length === 0) {
      warnings.push("Workspace map is empty");
    }
    result.routing.map_loaded = true;
  } catch (err) {
    warnings.push(`Workspace map load failed: ${String(err.message || err)}`);
  }

  if (!policyDecision.ok) {
    warnings.push(`${policyDecision.code}: ${policyDecision.reason}`);
  }

  if (CONFIG.strict && invocation && !isAbsolute(invocation.command)) {
    warnings.push("Strict mode requires absolute Oracle command path");
  }

  if (fatalErrors.length > 0) {
    result.state = "FAIL";
    result.ok = false;
  } else if (warnings.length > 0) {
    result.state = "DEGRADED";
    result.ok = true;
  } else {
    result.state = "OK";
    result.ok = true;
  }

  logEvent(result.ok ? "preflight.ok" : "preflight.fail", {
    request_id: null,
    run_id: null,
    workspace: null,
    project: null,
    duration_ms: Date.now() - startedAt,
    state: result.state,
    fatal_errors: fatalErrors,
    warnings,
  });
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

function acquireRunLocks(workspacePath, projectSlug, runId) {
  const lockKey = `${resolve(workspacePath)}::${projectSlug}`;
  // Lock ordering rule: if this expands to multiple run-scoped locks, acquire by "<scope>:<key>"
  // lexicographic order; current behavior acquires a single workspace+project lock.
  const result = acquireScopedLock("workspace_project", lockKey, 1, runId);
  if (!result.ok) {
    return {
      ok: false,
      lock_scope: "workspace+project",
      lock_key: lockKey,
      holder: result.holder || null,
    };
  }
  return {
    ok: true,
    lock_scope: "workspace+project",
    lock_key: lockKey,
    locks: [result.lock],
  };
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
  const persistedResponse = redactForPersistence(responseBody);
  const record = {
    request_id: requestId,
    run_id: runId,
    http_status: status,
    response: persistedResponse,
    saved_at: isoNow(),
  };
  state.requestCache.set(requestId, {
    http_status: status,
    response: persistedResponse,
    run_id: runId,
    saved_at: record.saved_at,
  });
  appendJsonl(CONFIG.requestIndexPath, record);
}

function recoverAllWorkspaceTempRuns() {
  let workspaceMap = {};
  try {
    workspaceMap = loadWorkspaceMap();
  } catch {
    return;
  }

  for (const [agent, rawPath] of Object.entries(workspaceMap)) {
    if (typeof rawPath !== "string" || !rawPath.trim()) continue;
    const workspacePath = resolve(expandHome(rawPath));
    const runsDir = join(workspacePath, CONFIG.planSubdir, "runs");
    if (!existsSync(runsDir)) continue;
    let entries = [];
    try {
      entries = readdirSync(runsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("tmp.")) continue;
      const runId = entry.name.slice("tmp.".length) || "unknown";
      const quarantineName = `quarantine.${runId}.${Date.now()}.${process.pid}`;
      const fromPath = join(runsDir, entry.name);
      const toPath = join(runsDir, quarantineName);
      try {
        renameSync(fromPath, toPath);
        writeFileAtomic(
          join(toPath, "recovery.json"),
          `${JSON.stringify(
            {
              recovered_at: isoNow(),
              action: "quarantined",
              reason: "startup_recovery_tmp_dir",
              run_id: runId,
              source_dir: entry.name,
              quarantine_dir: quarantineName,
            },
            null,
            2,
          )}\n`,
        );
        logEvent("run.recovered_tmp", {
          request_id: null,
          run_id: runId,
          workspace: workspacePath,
          project: null,
          duration_ms: 0,
          agent,
          quarantine_dir: quarantineName,
        });
      } catch (err) {
        logEvent("run.recovery_failed", {
          request_id: null,
          run_id: runId,
          workspace: workspacePath,
          project: null,
          duration_ms: 0,
          agent,
          error: String(err.message || err),
        });
      }
    }
  }
}

function makeRunId() {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function updateRunStore(runId, patch) {
  if ("state" in patch) {
    assertRunState(patch.state);
  }
  const existing = state.runStore.get(runId) || {};
  state.runStore.set(runId, { ...existing, ...patch });
}

function resolvePolicyDecision() {
  return resolveEngineModelPolicy({
    strict: CONFIG.strict,
    engine: CONFIG.engineTarget,
    model: CONFIG.modelTarget,
    engineExplicit: CONFIG.engineTargetExplicit,
    modelExplicit: CONFIG.modelTargetExplicit,
    allowFallback: CONFIG.allowTupleFallback,
    allowedTuples: CONFIG.allowedTuples,
  });
}

function buildThinkingVerifiability(preflight, effectiveEngine, effectiveModel) {
  const hasPinnedModel = effectiveModel && effectiveModel !== "auto";
  const hasPinnedEngine = effectiveEngine && effectiveEngine !== "auto";
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

function runOracle({ runId, prompt, workspacePath, invocation, effectiveEngine, effectiveModel }) {
  return runOracleInvocation({
    runId,
    argv: buildOracleArgv({
      oraclePath: invocation.command,
      prompt,
      model: effectiveModel,
      engine: effectiveEngine,
    }),
    cwd: workspacePath,
    env: buildOracleEnv(invocation.command),
    timeoutMs: CONFIG.oracleTimeoutMs,
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
  void projectSlug;
  const planRoot = join(workspacePath, CONFIG.planSubdir);
  const runsDir = join(planRoot, "runs");
  const finalDir = join(runsDir, runId);
  return {
    planRoot,
    runsDir,
    finalDir,
    tmpDir: join(runsDir, `tmp.${runId}`),
    latestPath: join(planRoot, "latest.json"),
    workspaceIndexPath: join(planRoot, "index.jsonl"),
  };
}

function serviceStatusBody(preflight) {
  const uptimeMs = Math.max(0, Date.now() - SERVICE_STARTED_AT_MS);
  return {
    ok: preflight.ok,
    state: preflight.state,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptime_ms: uptimeMs,
    active_run_count: state.activeRuns.size,
    build: {
      version: SERVICE_VERSION,
      sha: process.env.APR_BUILD_SHA || "unknown",
    },
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
      state: preflight.state,
      checked_at: preflight.checked_at,
      checks: preflight.checks,
      fatal_errors: preflight.fatal_errors,
      warnings: preflight.warnings,
    },
    metrics: {
      total: state.metrics.total,
      success: state.metrics.success,
      failed: state.metrics.failed,
      by_code: state.metrics.byCode,
      recent: state.metrics.recent.slice(-20),
      operational: operationalMetricsSnapshot(),
    },
  };
}

async function handlePlan(body) {
  const startedAt = Date.now();
  const providedRequestId =
    typeof body.request_id === "string" && body.request_id.trim()
      ? normalizeRequestId(body.request_id)
      : null;
  const canonicalRequestId = providedRequestId || normalizeRequestId();
  const runId = makeRunId();

  const finalizePlanResult = (result) => {
    const ok = Boolean(result?.body?.ok);
    incrementPlanRequestsTotal(ok ? "success" : "error", ok ? null : errorCodeOf(result?.body) || E_INTERNAL);
    return result;
  };

  if (providedRequestId && state.requestInFlight.has(providedRequestId)) {
    const inFlightRunId = state.requestInFlight.get(providedRequestId);
    return finalizePlanResult(
      errorResult(409, E_LOCK_CONTENDED, "request_id is already running", {
        request_id: canonicalRequestId,
        retryable: true,
        details: {
          run_id: inFlightRunId,
          reason: "request_id_in_flight",
        },
      }),
    );
  }

  if (providedRequestId && state.requestCache.has(providedRequestId)) {
    const cached = state.requestCache.get(providedRequestId);
    return finalizePlanResult({
      status: cached.http_status,
      body: cached.response.ok ? { ...cached.response, replayed: true } : cached.response,
    });
  }

  const project = typeof body.project === "string" ? body.project.trim() : "";
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  const context = typeof body.context === "string" ? body.context : "";
  const agent =
    typeof body.agent === "string" && body.agent.trim()
      ? slugify(body.agent, 80)
      : slugify(CONFIG.defaultAgent, 80);
  const failPlan = (status, code, message, details = {}, workspace = null, retryable = false) => {
    const durationMs = Date.now() - startedAt;
    observeRunDuration(durationMs);
    const result = errorResult(status, code, message, {
      request_id: canonicalRequestId,
      retryable,
      details: { run_id: runId, ...details },
    });
    logEvent("run.failed", {
      request_id: canonicalRequestId,
      run_id: runId,
      workspace,
      project: project || null,
      duration_ms: durationMs,
      code,
      http_status: status,
    });
    return finalizePlanResult(result);
  };

  if (!project) {
    return failPlan(400, E_INTERNAL, "Missing or invalid 'project' field", { field: "project" });
  }

  if (!goal || goal.length < 10) {
    return failPlan(400, E_INTERNAL, "Missing or invalid 'goal' field (min 10 chars)", { field: "goal" });
  }

  if (goal.length > 20_000 || context.length > 50_000) {
    return failPlan(400, E_INTERNAL, "goal/context too large", { field: "goal_or_context_size" });
  }

  const policyDecision = resolvePolicyDecision();
  if (!policyDecision.ok) {
    return failPlan(409, E_POLICY_DISALLOWED_TUPLE, policyDecision.reason, {
      requested: policyDecision.requested,
      allowed_tuples: policyDecision.allowed_tuples,
    });
  }

  const effectiveEngine = policyDecision.effective.engine;
  const effectiveModel = policyDecision.effective.model;

  const projectSlug = slugify(project, 80);
  updateRunStore(runId, {
    run_id: runId,
    request_id: canonicalRequestId,
    state: "running",
    project,
    project_slug: projectSlug,
    agent,
    started_at: isoNow(),
  });
  logEvent("plan.received", {
    request_id: canonicalRequestId,
    run_id: runId,
    workspace: null,
    project,
    duration_ms: 0,
    agent,
    goal_length: goal.length,
    context_length: context.length,
  });

  if (providedRequestId) {
    state.requestInFlight.set(providedRequestId, runId);
  }
  state.activeRuns.set(runId, {
    run_id: runId,
    request_id: canonicalRequestId,
    project,
    agent,
    started_at: startedAt,
  });

  let locks = [];
  let artifactsPath = null;
  let workspacePath = null;

  try {
    const preflight = await getPreflight();
    if (!preflight.ok) {
      return failPlan(
        503,
        E_PREFLIGHT_FAILED,
        "Preflight checks failed",
        {
          state: preflight.state,
          fatal_errors: preflight.fatal_errors,
          checks: preflight.checks,
        },
        null,
        true,
      );
    }

    let workspaceMap;
    try {
      workspaceMap = loadWorkspaceMap();
    } catch (err) {
      return failPlan(
        503,
        E_PREFLIGHT_FAILED,
        "Workspace map unavailable",
        { cause: String(err.message || err) },
        null,
        true,
      );
    }

    try {
      workspacePath = workspaceForAgent(agent, workspaceMap);
    } catch (err) {
      return failPlan(422, E_POLICY_DISALLOWED_TUPLE, String(err.message || err), {
        agent,
        cause: String(err.message || err),
      });
    }

    const thinkingVerifiability = buildThinkingVerifiability(preflight, effectiveEngine, effectiveModel);
    if (CONFIG.strict && thinkingVerifiability === "UNVERIFIABLE" && !CONFIG.allowUnverifiableThinking) {
      return failPlan(
        409,
        E_POLICY_NO_AUTO_IN_STRICT,
        "Thinking policy cannot be verified under strict mode",
        {},
        workspacePath,
      );
    }

    const lockStartedAt = Date.now();
    const lockResult = acquireRunLocks(workspacePath, projectSlug, runId);
    const lockDurationMs = Date.now() - lockStartedAt;
    if (!lockResult.ok) {
      state.metrics.lock_contention_total += 1;
      logEvent("lock.acquire", {
        request_id: canonicalRequestId,
        run_id: runId,
        workspace: workspacePath,
        project,
        duration_ms: lockDurationMs,
        status: "contention",
        lock_scope: lockResult.lock_scope,
        lock_key: lockResult.lock_key,
        locked_by_run_id: lockResult.holder?.run_id || null,
      });
      return failPlan(
        409,
        E_LOCK_CONTENDED,
        "Run lock is busy",
        {
          lock_scope: lockResult.lock_scope,
          lock_key: lockResult.lock_key,
          locked_by_run_id: lockResult.holder?.run_id || null,
        },
        workspacePath,
        true,
      );
    }
    locks = lockResult.locks;
    logEvent("lock.acquire", {
      request_id: canonicalRequestId,
      run_id: runId,
      workspace: workspacePath,
      project,
      duration_ms: lockDurationMs,
      status: "ok",
      lock_scope: lockResult.lock_scope,
      lock_key: lockResult.lock_key,
      scopes: locks.map((lock) => lock.scope),
    });

    updateRunStore(runId, { workspace_path: workspacePath });

    const invocation = resolveOracleInvocation();
    if (!invocation) {
      return failPlan(503, E_ORACLE_NOT_FOUND, "Oracle invocation unavailable", {}, workspacePath, true);
    }

    const paths = buildRunPaths(workspacePath, projectSlug, runId);
    artifactsPath = paths.finalDir;

    if (!CONFIG.saveArtifacts && !CONFIG.allowNoArtifacts) {
      return failPlan(
        500,
        E_INTERNAL,
        "Artifacts are required by policy",
        { cause: "artifacts_required_by_policy" },
        workspacePath,
      );
    }

    if (CONFIG.saveArtifacts) {
      try {
        ensureDir(paths.runsDir, 0o700);
        if (existsSync(paths.tmpDir)) {
          rmSync(paths.tmpDir, { recursive: true, force: true });
        }
        if (existsSync(paths.finalDir)) {
          throw new Error(`Final run directory already exists: ${paths.finalDir}`);
        }
        mkdirSync(paths.tmpDir, { recursive: false, mode: 0o700 });
      } catch (err) {
        return failPlan(
          500,
          E_INTERNAL,
          "Failed to initialize artifact directory",
          { cause: String(err.message || err) },
          workspacePath,
        );
      }
    }

    const prompt = planningPrompt(project.slice(0, 200), goal.slice(0, 20_000), context.slice(0, 50_000));

    const effectiveConfig = {
      strict: CONFIG.strict,
      engine_target: CONFIG.engineTarget,
      model_target: CONFIG.modelTarget,
      effective_engine: effectiveEngine,
      effective_model: effectiveModel,
      tuple_fallback_applied: policyDecision.fallback_applied,
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
      writeRedactedJsonArtifact(join(paths.tmpDir, "request.json"), {
        agent,
        project,
        goal,
        context,
        request_id: canonicalRequestId,
        received_at: isoNow(),
      });
      writeRedactedJsonArtifact(join(paths.tmpDir, "effective_config.json"), effectiveConfig);
    }

    updateRunStore(runId, { state: "running" });
    logEvent("run.started", {
      run_id: runId,
      request_id: canonicalRequestId,
      workspace: workspacePath,
      project,
      duration_ms: Date.now() - startedAt,
      agent,
      goal_length: goal.length,
      effective_engine: effectiveEngine,
      effective_model: effectiveModel,
      thinking_verifiability: thinkingVerifiability,
      workspace_path: workspacePath,
    });

    const oracleStartedAt = Date.now();
    logEvent("oracle.spawned", {
      run_id: runId,
      request_id: canonicalRequestId,
      workspace: workspacePath,
      project,
      duration_ms: Date.now() - startedAt,
      oracle_path: invocation.command,
      oracle_source: invocation.source,
    });
    const oracle = await runOracle({ runId, prompt, workspacePath, invocation, effectiveEngine, effectiveModel });
    const oracleDurationMs = Date.now() - oracleStartedAt;
    const durationMs = Date.now() - startedAt;

    let result;
    if (!oracle.ok) {
      const oracleFailureCode =
        oracle.errorCode === E_ORACLE_TIMEOUT
          ? E_ORACLE_TIMEOUT
          : oracle.errorCode === E_ORACLE_NOT_FOUND
            ? E_ORACLE_NOT_FOUND
            : oracle.errorCode === E_ORACLE_EXIT_NONZERO
              ? E_ORACLE_EXIT_NONZERO
              : E_ORACLE_EXIT_NONZERO;
      const httpStatus = oracleFailureCode === E_ORACLE_TIMEOUT ? 504 : 503;
      const errorMessage =
        oracleFailureCode === E_ORACLE_TIMEOUT
          ? "Oracle planning timed out"
          : oracleFailureCode === E_ORACLE_EXIT_NONZERO
            ? "Oracle planning exited with non-zero status"
            : oracleFailureCode === E_ORACLE_NOT_FOUND
              ? "Oracle invocation unavailable"
              : "Oracle planning failed to spawn";
      if (oracleFailureCode === E_ORACLE_TIMEOUT) {
        state.metrics.oracle_timeouts_total += 1;
        logEvent("oracle.timeout", {
          run_id: runId,
          request_id: canonicalRequestId,
          workspace: workspacePath,
          project,
          duration_ms: oracleDurationMs,
        });
      }
      result = errorResult(httpStatus, oracleFailureCode, errorMessage, {
        request_id: canonicalRequestId,
        retryable: oracleFailureCode === E_ORACLE_TIMEOUT,
        details: {
          run_id: runId,
          workspace_path: workspacePath,
          artifacts_path: artifactsPath,
          oracle_exit_code: oracle.code,
          oracle_signal: oracle.signal,
          stderr: oracle.stderr.slice(0, 2000),
        },
      });
    } else {
      result = successResult(
        200,
        {
          run_id: runId,
          state: "done",
        },
        canonicalRequestId,
      );
    }

    const startedAtIso = new Date(startedAt).toISOString();
    const finishedAtIso = isoNow();
    const runState = result.body.ok ? "done" : "failed";
    const errorCode = result.body.ok ? null : errorCodeOf(result.body) || E_INTERNAL;
    const meta = {
      ts: finishedAtIso,
      run_id: runId,
      request_id: canonicalRequestId,
      agent,
      project,
      project_slug: projectSlug,
      workspace: workspacePath,
      workspace_path: workspacePath,
      artifacts_path: artifactsPath,
      state: runState,
      status: runState,
      engine: effectiveEngine,
      model: effectiveModel,
      timestamps: {
        started_at: startedAtIso,
        finished_at: finishedAtIso,
        duration_ms: durationMs,
      },
      started_at: startedAtIso,
      finished_at: finishedAtIso,
      duration_ms: durationMs,
      error_code: errorCode,
      oracle: {
        path: invocation.command,
        version: preflight.oracle.version,
        exit_code: oracle.code,
        signal: oracle.signal,
        timed_out: oracle.timedOut,
      },
      effective_engine: effectiveEngine,
      effective_model: effectiveModel,
      effective_thinking_policy: CONFIG.thinkingPolicy,
      thinking_verifiability: thinkingVerifiability,
      error: errorCode
        ? {
            code: errorCode,
            message: errorMessageOf(result.body),
            retryable: errorRetryableOf(result.body),
          }
        : null,
    };

    if (CONFIG.saveArtifacts) {
      try {
        const persistedStdout = redactSecrets(oracle.stdout);
        const persistedStderr = redactSecrets(oracle.stderr);
        const persistedResponse = redactForPersistence(result.body);
        const persistedMeta = redactForPersistence(meta);
        const persistedOracleInvocation = redactForPersistence(oracle.invocation);

        writeFileAtomic(join(paths.tmpDir, "stdout.log"), `${persistedStdout}\n`);
        writeFileAtomic(join(paths.tmpDir, "stderr.log"), `${persistedStderr}\n`);
        writeFileAtomic(
          join(paths.tmpDir, "oracle_cmd.json"),
          `${JSON.stringify(persistedOracleInvocation, null, 2)}\n`,
        );
        // Backwards-compatible legacy names.
        writeFileAtomic(join(paths.tmpDir, "oracle_stdout.txt"), `${persistedStdout}\n`);
        writeFileAtomic(join(paths.tmpDir, "oracle_stderr.txt"), `${persistedStderr}\n`);
        writeFileAtomic(join(paths.tmpDir, "response.json"), `${JSON.stringify(persistedResponse, null, 2)}\n`);
        writeFileAtomic(join(paths.tmpDir, "meta.json"), `${JSON.stringify(persistedMeta, null, 2)}\n`);
        if (result.body.ok) {
          writeFileAtomic(join(paths.tmpDir, "plan.md"), `${persistedStdout}\n`);
        }
        renameSync(paths.tmpDir, paths.finalDir);

        appendJsonl(paths.workspaceIndexPath, persistedMeta);
        appendJsonl(CONFIG.indexPath, persistedMeta);
        const latestLock = acquireScopedLock("latest", `${workspacePath}_${projectSlug}`, 1, runId);
        if (!latestLock.ok) {
          throw new Error("Latest lock unavailable");
        }
        try {
          writeFileAtomic(
            paths.latestPath,
            `${JSON.stringify(
              {
                run_id: runId,
                request_id: canonicalRequestId,
                project,
                project_slug: projectSlug,
                agent,
                workspace_path: workspacePath,
                artifacts_path: paths.finalDir,
                status: runState,
                code: errorCode,
                updated_at: finishedAtIso,
              },
              null,
              2,
            )}\n`,
          );
        } finally {
          releaseLocks([latestLock.lock]);
        }
      } catch (err) {
        const persistError = errorResult(500, E_INTERNAL, "Failed to persist run artifacts", {
          request_id: canonicalRequestId,
          details: {
            run_id: runId,
            cause: String(err.message || err),
          },
        });
        updateRunStore(runId, {
          state: "failed",
          finished_at: isoNow(),
          error: persistError.body,
          artifacts_path: artifactsPath,
        });
        const errorCode = errorCodeOf(persistError.body) || E_INTERNAL;
        state.metrics.total += 1;
        state.metrics.failed += 1;
        incrementErrorCode(errorCode);
        observeRunDuration(durationMs);
        safePushRecent({
          ts: isoNow(),
          run_id: runId,
          request_id: canonicalRequestId,
          project,
          status: "failed",
          code: errorCode,
          duration_ms: durationMs,
        });
        logEvent("run.failed", {
          run_id: runId,
          request_id: canonicalRequestId,
          workspace: workspacePath,
          project,
          duration_ms: durationMs,
          code: errorCode,
          http_status: persistError.status,
          artifacts_path: artifactsPath,
        });
        if (providedRequestId) {
          persistRequestCache(providedRequestId, runId, persistError.status, persistError.body);
        }
        return finalizePlanResult(persistError);
      }
    }

    updateRunStore(runId, {
      state: runState,
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
      incrementErrorCode(errorCode || E_INTERNAL);
    }
    observeRunDuration(durationMs);

    safePushRecent({
      ts: isoNow(),
      run_id: runId,
      request_id: canonicalRequestId,
      project,
      status: runState,
      code: errorCode,
      duration_ms: durationMs,
    });

    logEvent(result.body.ok ? "run.completed" : "run.failed", {
      run_id: runId,
      request_id: canonicalRequestId,
      workspace: workspacePath,
      project,
      status: runState,
      code: errorCode,
      duration_ms: durationMs,
      oracle_exit_code: oracle.code,
      artifacts_path: artifactsPath,
    });

    if (providedRequestId) {
      persistRequestCache(providedRequestId, runId, result.status, result.body);
    }

    return finalizePlanResult(result);
  } catch (err) {
    return failPlan(500, E_INTERNAL, String(err.message || err), { cause: String(err.message || err) }, workspacePath);
  } finally {
    if (providedRequestId) {
      state.requestInFlight.delete(providedRequestId);
    }
    state.activeRuns.delete(runId);
    if (locks.length > 0) {
      releaseLocks(locks);
    }
  }
}
async function handleHealth() {
  const preflight = await getPreflight();
  return {
    status: preflight.ok ? 200 : 503,
    body: {
      ok: preflight.ok,
      state: preflight.state,
    },
  };
}

async function handleServiceStatus() {
  const preflight = await getPreflight();
  return {
    status: preflight.ok ? 200 : 503,
    body: serviceStatusBody(preflight),
  };
}

function handleMetrics() {
  return successResult(200, { metrics: formatPrometheusMetrics() }, normalizeRequestId());
}

async function handleRunLookup(runId) {
  const found = state.runStore.get(runId);
  if (!found) {
    return errorResult(404, E_INTERNAL, "Run ID not found", {
      request_id: normalizeRequestId(),
      details: { run_id: runId },
    });
  }
  if (!isAllowedRunState(found.state)) {
    return errorResult(409, E_INTERNAL, "Invalid run state", {
      request_id: normalizeRequestId(found.request_id),
      details: {
        run_id: found.run_id || runId,
        state: found.state,
        allowed: ["running", "done", "failed"],
      },
    });
  }
  return successResult(
    200,
    {
      run_id: found.run_id || runId,
      state: found.state,
    },
    normalizeRequestId(found.request_id),
  );
}

function aprErrorResult(requestId, command, result) {
  return errorResult(500, E_INTERNAL, "APR command failed", {
    request_id: requestId,
    retryable: true,
    details: {
      command,
      exit_code: result.code,
      stderr: String(result.stderr || "").slice(0, 2_000),
    },
  });
}

function aprSuccessResult(requestId, command, result) {
  return successResult(
    200,
    {
      command,
      exit_code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    requestId,
  );
}

async function runAprRoute({ command, args, timeoutMs, requestId }) {
  const result = await runApr(args, timeoutMs);
  if (!result.ok) {
    return aprErrorResult(requestId, command, result);
  }
  return aprSuccessResult(requestId, command, result);
}

function routeRequestId(body) {
  if (body && typeof body.request_id === "string" && body.request_id.trim()) {
    return normalizeRequestId(body.request_id);
  }
  return normalizeRequestId();
}

const INVALID_ROUND_DETAILS = Object.freeze({ field: "round" });

function invalidRoundError(requestId, message) {
  return errorResult(400, E_INTERNAL, message, {
    request_id: requestId,
    details: INVALID_ROUND_DETAILS,
  });
}

const routes = {
  async run(body) {
    const requestId = routeRequestId(body);
    const round = validateRound(body.round);
    if (!round) return invalidRoundError(requestId, "Invalid round (1-100)");

    const args = ["run", String(round), "--wait"];
    if (body.include_impl) args.push("--include-impl");
    if (body.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    return runAprRoute({ command: "run", args, requestId });
  },

  async show(body) {
    const requestId = routeRequestId(body);
    const round = validateRound(body.round);
    if (!round) return invalidRoundError(requestId, "Invalid round");

    const args = ["show", String(round)];
    if (body.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    return runAprRoute({ command: "show", args, timeoutMs: 30_000, requestId });
  },

  async aprStatus() {
    return runAprRoute({
      command: "status",
      args: ["status"],
      timeoutMs: 30_000,
      requestId: normalizeRequestId(),
    });
  },

  async stats(body) {
    const requestId = routeRequestId(body);
    const args = ["stats"];
    if (body?.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    return runAprRoute({ command: "stats", args, timeoutMs: 30_000, requestId });
  },

  async diff(body) {
    const requestId = routeRequestId(body);
    const round = validateRound(body.round);
    if (!round) return invalidRoundError(requestId, "Invalid round");

    const args = ["diff", String(round)];
    if (body.round2) {
      const r2 = validateRound(body.round2);
      if (r2) args.push(String(r2));
    }
    if (body.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    return runAprRoute({ command: "diff", args, timeoutMs: 30_000, requestId });
  },

  async history() {
    return runAprRoute({
      command: "history",
      args: ["history"],
      timeoutMs: 30_000,
      requestId: normalizeRequestId(),
    });
  },

  async integrate(body) {
    const requestId = routeRequestId(body);
    const round = validateRound(body.round);
    if (!round) return invalidRoundError(requestId, "Invalid round");

    const args = ["integrate", String(round)];
    if (body.workflow) args.push("-w", String(body.workflow).slice(0, 50));

    return runAprRoute({ command: "integrate", args, timeoutMs: 30_000, requestId });
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

  async metrics() {
    return handleMetrics();
  },
};

bootstrapWorkspaceMap();
ensureDir(CONFIG.lockDir, 0o700);
ensureDir(dirname(CONFIG.indexPath), 0o700);
ensureDir(dirname(CONFIG.requestIndexPath), 0o700);
loadRequestCache();
recoverAllWorkspaceTempRuns();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const path = url.pathname;
  const method = req.method || "GET";
  const requestId = normalizeRequestId(req.headers["x-request-id"]);

  if (path !== "/health" && !checkAuth(req, CONFIG.token)) {
    const out = errorResult(401, E_INTERNAL, "Unauthorized. Set Authorization: Bearer <token>", {
      request_id: requestId,
      details: { path },
    });
    if (typeof out.body === "string" && out.content_type) {
      textResponse(res, out.status, out.body, out.content_type);
    } else {
      jsonResponse(res, out.status, out.body);
    }
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
    } else if (method === "GET" && path === "/metrics") {
      out = await routes.metrics();
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
      out = errorResult(404, E_INTERNAL, `Unknown endpoint: ${path}`, {
        request_id: requestId,
        details: { path, method },
      });
    }

    if (typeof out.body === "string" && out.content_type) {
      textResponse(res, out.status, out.body, out.content_type);
    } else {
      jsonResponse(res, out.status, out.body);
    }
  } catch (err) {
    const out = errorResult(500, E_INTERNAL, String(err.message || err), {
      request_id: requestId,
      details: { path, method },
    });
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
|    GET  /metrics           (prometheus metrics)
|    GET  /runs/:run_id
|    POST /plan
|    POST /run, /show, /diff, /integrate
|    GET  /stats, /history
+--------------------------------------------------------------+
|  Preflight: ${preflight.state}
+--------------------------------------------------------------+
`);
});
