import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { E_LOCK_CONTENDED, E_LOCK_INTERNAL } from "./errors.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow() {
  return new Date().toISOString();
}

function hashString(input) {
  return createHash("sha1").update(String(input)).digest("hex").slice(0, 16);
}

function slugifyToken(value, maxLen = 64) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) return "x";
  return normalized.slice(0, maxLen);
}

function ensureDir(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
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

function isStaleLock(metadata, staleMs) {
  if (!metadata || typeof metadata !== "object") return true;
  if (!Number.isFinite(metadata.created_at_ms)) return true;
  if (Date.now() - metadata.created_at_ms > staleMs) return true;
  if (Number.isInteger(metadata.pid) && !pidAlive(metadata.pid)) return true;
  return false;
}

function normalizeResource(resource) {
  const scope = slugifyToken(resource?.scope || "lock", 48);
  const key = String(resource?.key || "");
  return {
    scope,
    key,
    orderKey: `${scope}:${key}`,
  };
}

function buildLockPath(lockDir, normalizedResource) {
  const keyHash = hashString(normalizedResource.key);
  const keyPreview = slugifyToken(normalizedResource.key, 48);
  return join(lockDir, `${normalizedResource.scope}_${keyHash}_${keyPreview}.lock`);
}

function acquireOnce({ lockDir, staleMs, resource, owner }) {
  ensureDir(lockDir, 0o700);
  const normalized = normalizeResource(resource);
  const lockPath = buildLockPath(lockDir, normalized);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      const payload = {
        scope: normalized.scope,
        key: normalized.key,
        run_id: owner?.run_id || null,
        owner: owner || {},
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

      return {
        ok: true,
        lock: {
          path: lockPath,
          scope: normalized.scope,
          key: normalized.key,
        },
      };
    } catch (err) {
      if (err?.code !== "EEXIST") {
        return {
          ok: false,
          code: E_LOCK_INTERNAL,
          retryable: false,
          error: String(err?.message || err),
          resource: { scope: normalized.scope, key: normalized.key },
        };
      }

      const holder = readLockMetadata(lockPath);
      if (isStaleLock(holder, staleMs)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // Another process may have replaced the lock between read/unlink.
        }
      }

      return {
        ok: false,
        code: E_LOCK_CONTENDED,
        retryable: true,
        resource: { scope: normalized.scope, key: normalized.key },
        holder: holder || null,
      };
    }
  }

  return {
    ok: false,
    code: E_LOCK_CONTENDED,
    retryable: true,
    resource: normalizeResource(resource),
    holder: null,
  };
}

function release(lock) {
  if (!lock?.path) return;
  try {
    unlinkSync(lock.path);
  } catch {
    // Best effort only.
  }
}

function releaseMany(locks) {
  for (const lock of (locks || []).slice().reverse()) {
    release(lock);
  }
}

export function createLockManager({ lockDir, staleMs }) {
  async function acquire(resource, owner, options = {}) {
    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 0));
    const retryDelayMs = Math.max(5, Number(options.retryDelayMs ?? 25));
    const startedAt = Date.now();

    while (true) {
      const attempt = acquireOnce({ lockDir, staleMs, resource, owner });
      if (attempt.ok || attempt.code !== E_LOCK_CONTENDED) return attempt;
      if (timeoutMs === 0) return attempt;

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) return attempt;
      await sleep(Math.min(retryDelayMs, timeoutMs - elapsed));
    }
  }

  async function acquireMany(resources, owner, options = {}) {
    const entries = Array.from(
      new Map(
        (resources || []).map((resource) => {
          const normalized = normalizeResource(resource);
          return [normalized.orderKey, resource];
        }),
      ).values(),
    );

    // Lock ordering rule: always acquire by "<scope>:<key>" lexicographic order.
    // This guarantees a consistent global acquisition order and avoids deadlocks.
    entries.sort((a, b) => normalizeResource(a).orderKey.localeCompare(normalizeResource(b).orderKey));

    const heldLocks = [];
    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 0));
    const startedAt = Date.now();

    for (const resource of entries) {
      const elapsed = Date.now() - startedAt;
      const remaining = timeoutMs > 0 ? Math.max(timeoutMs - elapsed, 0) : 0;
      const result = await acquire(resource, owner, {
        ...options,
        timeoutMs: timeoutMs > 0 ? remaining : 0,
      });
      if (!result.ok) {
        releaseMany(heldLocks);
        return result;
      }
      heldLocks.push(result.lock);
    }

    return { ok: true, locks: heldLocks };
  }

  return {
    acquire,
    acquireMany,
    release,
    releaseMany,
  };
}
