import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

function ensureDir(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}

function fsyncDir(path) {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best effort only.
  }
}

function writeFileDurable(path, content, mode = 0o600) {
  ensureDir(dirname(path), 0o700);
  const fd = openSync(path, "w", mode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}

function appendJsonl(path, obj) {
  ensureDir(dirname(path), 0o700);
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(obj)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeFileAtomic(path, content, mode = 0o600) {
  ensureDir(dirname(path), 0o700);
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileDurable(tmpPath, content, mode);
  renameSync(tmpPath, path);
  fsyncDir(dirname(path));
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only.
  }
}

function toJsonContent(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function buildRunPaths(workspacePath, planSubdir, runId) {
  const planRoot = join(workspacePath, planSubdir);
  const runsDir = join(planRoot, "runs");
  const tmpDir = join(runsDir, `tmp.${runId}`);
  const finalDir = join(runsDir, runId);

  return {
    planRoot,
    runsDir,
    tmpDir,
    finalDir,
    workspaceIndexPath: join(planRoot, "index.jsonl"),
    latestPath: join(planRoot, "latest.json"),
  };
}

export function initializeRunTempDir(paths) {
  ensureDir(paths.planRoot, 0o700);
  ensureDir(paths.runsDir, 0o700);
  if (existsSync(paths.finalDir)) {
    throw new Error(`Final run directory already exists: ${paths.finalDir}`);
  }
  if (existsSync(paths.tmpDir)) {
    rmSync(paths.tmpDir, { recursive: true, force: true });
  }
  mkdirSync(paths.tmpDir, { recursive: false, mode: 0o700 });
  fsyncDir(paths.runsDir);
}

export function writeRunArtifact(paths, filename, content) {
  writeFileDurable(join(paths.tmpDir, filename), content, 0o600);
}

function buildLatestRecord(indexRecord) {
  return {
    run_id: indexRecord.run_id,
    request_id: indexRecord.request_id,
    agent: indexRecord.agent,
    project: indexRecord.project,
    project_slug: indexRecord.project_slug,
    workspace_path: indexRecord.workspace_path,
    artifacts_path: indexRecord.artifacts_path,
    status: indexRecord.status,
    code: indexRecord.code,
    updated_at: indexRecord.ts,
  };
}

export async function commitRunArtifacts({
  lockManager,
  runId,
  paths,
  indexRecord,
  globalIndexPath,
  latestRecord,
  lockTimeoutMs = 10_000,
}) {
  fsyncDir(paths.tmpDir);
  renameSync(paths.tmpDir, paths.finalDir);
  fsyncDir(paths.runsDir);

  const lockResult = await lockManager.acquireMany(
    [
      { scope: "index", key: paths.workspaceIndexPath },
      { scope: "index", key: globalIndexPath },
      { scope: "latest", key: paths.latestPath },
    ],
    {
      run_id: runId,
      operation: "persist_index_latest",
    },
    {
      timeoutMs: lockTimeoutMs,
      retryDelayMs: 25,
    },
  );

  if (!lockResult.ok) {
    const err = new Error("Unable to acquire persistence lock(s)");
    err.code = lockResult.code || "E_LOCK_INTERNAL";
    err.retryable = Boolean(lockResult.retryable);
    err.holder = lockResult.holder || null;
    err.resource = lockResult.resource || null;
    throw err;
  }

  try {
    appendJsonl(paths.workspaceIndexPath, indexRecord);
    appendJsonl(globalIndexPath, indexRecord);
    writeFileAtomic(paths.latestPath, toJsonContent(latestRecord || buildLatestRecord(indexRecord)));
  } finally {
    lockManager.releaseMany(lockResult.locks);
  }
}

function nextQuarantinePath(runsDir, runId) {
  const base = `quarantine.${runId || "unknown"}.${Date.now()}.${process.pid}`;
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? "" : `.${attempt}`;
    const candidate = join(runsDir, `${base}${suffix}`);
    if (!existsSync(candidate)) return candidate;
    attempt += 1;
  }
}

export function recoverTemporaryRunDirs(workspacePath, planSubdir) {
  const runsDir = join(workspacePath, planSubdir, "runs");
  if (!existsSync(runsDir)) return [];

  const recovered = [];
  const entries = readdirSync(runsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("tmp.")) continue;

    const runId = entry.name.slice("tmp.".length) || "unknown";
    const sourcePath = join(runsDir, entry.name);
    const quarantinePath = nextQuarantinePath(runsDir, runId);
    renameSync(sourcePath, quarantinePath);

    const record = {
      recovered_at: new Date().toISOString(),
      action: "quarantined",
      reason: "startup_recovery_tmp_dir",
      run_id: runId,
      source_dir: entry.name,
      quarantine_dir: basename(quarantinePath),
    };
    try {
      writeFileDurable(join(quarantinePath, "recovery.json"), toJsonContent(record), 0o600);
    } catch {
      // Best effort only.
    }
    recovered.push(record);
  }

  return recovered;
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}
