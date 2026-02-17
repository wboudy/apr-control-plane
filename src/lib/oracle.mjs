import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  E_ORACLE_EXIT_NONZERO,
  E_ORACLE_NOT_FOUND,
  E_ORACLE_SPAWN_FAILED,
  E_ORACLE_TIMEOUT,
} from "./errors.mjs";

export const ORACLE_ERROR_NOT_FOUND = E_ORACLE_NOT_FOUND;
export const ORACLE_ERROR_TIMEOUT = E_ORACLE_TIMEOUT;
export const ORACLE_ERROR_EXIT_NONZERO = E_ORACLE_EXIT_NONZERO;
export const ORACLE_ERROR_SPAWN_FAILED = E_ORACLE_SPAWN_FAILED;

const DEFAULT_CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;

function isoNow() {
  return new Date().toISOString();
}

function makeStreamCapture(limitBytes) {
  return {
    limitBytes,
    totalBytes: 0,
    keptBytes: 0,
    truncated: false,
    chunks: [],
  };
}

function appendCapture(capture, chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  capture.totalBytes += buf.length;

  if (capture.keptBytes >= capture.limitBytes) {
    capture.truncated = true;
    return;
  }

  const remaining = capture.limitBytes - capture.keptBytes;
  if (buf.length <= remaining) {
    capture.chunks.push(buf);
    capture.keptBytes += buf.length;
    return;
  }

  capture.chunks.push(buf.subarray(0, remaining));
  capture.keptBytes += remaining;
  capture.truncated = true;
}

function captureToText(capture) {
  if (capture.chunks.length === 0) return "";
  return Buffer.concat(capture.chunks).toString("utf8");
}

function killProcessGroup(pid, signal = "SIGKILL") {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function buildOracleCmdRecord({
  runId,
  argv,
  cwd,
  timeoutMs,
  startedAt,
  endedAt,
  exitCode,
  signal,
  timedOut,
  stdoutBytes,
  stderrBytes,
  stdoutTruncated,
  stderrTruncated,
}) {
  return {
    run_id: runId,
    argv,
    cwd,
    timeout_ms: timeoutMs,
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: exitCode,
    signal,
    timed_out: timedOut,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
  };
}

function immediateFailure({
  runId,
  argv,
  cwd,
  timeoutMs,
  startedAt,
  stderr,
  code,
}) {
  const endedAt = isoNow();
  return {
    ok: false,
    code: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr,
    errorCode: code,
    invocation: buildOracleCmdRecord({
      runId,
      argv,
      cwd,
      timeoutMs,
      startedAt,
      endedAt,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr, "utf8"),
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  };
}

export function buildOracleArgv({ oraclePath, prompt, model, engine }) {
  return [oraclePath, "--prompt", prompt, "--model", model, "--engine", engine, "--wait"];
}

export function normalizeOracleCmdRecord(record) {
  const out = { ...record };
  delete out.started_at;
  delete out.ended_at;
  return out;
}

export function runOracleInvocation({
  runId,
  argv,
  cwd,
  env,
  timeoutMs,
  stdoutLimitBytes = DEFAULT_CAPTURE_LIMIT_BYTES,
  stderrLimitBytes = DEFAULT_CAPTURE_LIMIT_BYTES,
}) {
  return new Promise((resolveRun) => {
    const startedAt = isoNow();
    if (!Array.isArray(argv) || argv.length < 1) {
      resolveRun(
        immediateFailure({
          runId,
          argv: [],
          cwd,
          timeoutMs,
          startedAt,
          stderr: "Oracle argv is required",
          code: ORACLE_ERROR_SPAWN_FAILED,
        }),
      );
      return;
    }

    const command = String(argv[0] || "");
    if (!command || !isAbsolute(command)) {
      resolveRun(
        immediateFailure({
          runId,
          argv: [...argv],
          cwd,
          timeoutMs,
          startedAt,
          stderr: `Oracle path must be absolute: ${command || "<empty>"}`,
          code: ORACLE_ERROR_NOT_FOUND,
        }),
      );
      return;
    }

    if (!cwd || !isAbsolute(cwd)) {
      resolveRun(
        immediateFailure({
          runId,
          argv: [...argv],
          cwd,
          timeoutMs,
          startedAt,
          stderr: `Oracle cwd must be absolute: ${cwd || "<empty>"}`,
          code: ORACLE_ERROR_SPAWN_FAILED,
        }),
      );
      return;
    }

    const stdoutCapture = makeStreamCapture(stdoutLimitBytes);
    const stderrCapture = makeStreamCapture(stderrLimitBytes);
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    let timeoutHandle = null;
    let proc;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const endedAt = isoNow();
      const stdout = captureToText(stdoutCapture).trim();
      let stderr = captureToText(stderrCapture).trim();

      if (spawnError?.message) {
        stderr = stderr ? `${stderr}\n${spawnError.message}` : spawnError.message;
      }

      let errorCode = null;
      let ok = false;
      let exitCode = typeof code === "number" ? code : null;
      const exitSignal = signal || null;

      if (timedOut) {
        errorCode = ORACLE_ERROR_TIMEOUT;
      } else if (spawnError) {
        errorCode = spawnError.code === "ENOENT" ? ORACLE_ERROR_NOT_FOUND : ORACLE_ERROR_SPAWN_FAILED;
        exitCode = null;
      } else if (exitCode === 0) {
        ok = true;
      } else {
        errorCode = ORACLE_ERROR_EXIT_NONZERO;
      }

      resolveRun({
        ok,
        code: exitCode,
        signal: exitSignal,
        timedOut,
        stdout,
        stderr,
        errorCode,
        invocation: buildOracleCmdRecord({
          runId,
          argv: [...argv],
          cwd,
          timeoutMs,
          startedAt,
          endedAt,
          exitCode,
          signal: exitSignal,
          timedOut,
          stdoutBytes: stdoutCapture.totalBytes,
          stderrBytes: stderrCapture.totalBytes,
          stdoutTruncated: stdoutCapture.truncated,
          stderrTruncated: stderrCapture.truncated,
        }),
      });
    };

    try {
      proc = spawn(command, argv.slice(1), {
        shell: false,
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      spawnError = err;
      finish(null, null);
      return;
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      const killed = killProcessGroup(proc.pid, "SIGKILL");
      if (!killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Best effort.
        }
      }
    }, timeoutMs);
    timeoutHandle.unref?.();

    proc.stdout?.on("data", (d) => appendCapture(stdoutCapture, d));
    proc.stderr?.on("data", (d) => appendCapture(stderrCapture, d));

    proc.on("error", (err) => {
      spawnError = err;
      finish(null, null);
    });

    proc.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}
