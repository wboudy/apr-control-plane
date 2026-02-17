import { randomUUID } from "node:crypto";

function isoNow() {
  return new Date().toISOString();
}

function normalizeRequestId(requestId) {
  if (typeof requestId === "string" && requestId.trim()) {
    return requestId.trim().slice(0, 128);
  }
  return `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function successEnvelope(payload = {}, requestId) {
  return {
    ok: true,
    request_id: normalizeRequestId(requestId),
    ts: isoNow(),
    ...payload,
  };
}

function errorEnvelope({ requestId, code, message, retryable = false, details } = {}) {
  const error = {
    code: String(code || ""),
    message: String(message || "Internal error"),
    retryable: Boolean(retryable),
  };
  if (details && typeof details === "object") {
    error.details = details;
  }
  return {
    ok: false,
    request_id: normalizeRequestId(requestId),
    ts: isoNow(),
    error,
  };
}

function errorResult(status, code, message, options = {}) {
  const { request_id: requestId, retryable = false, details } = options;
  return {
    status,
    body: errorEnvelope({
      requestId,
      code,
      message,
      retryable,
      details,
    }),
  };
}

function successResult(status, payload = {}, requestId) {
  return {
    status,
    body: successEnvelope(payload, requestId),
  };
}

function errorCodeOf(body) {
  return body?.error?.code || "";
}

function errorMessageOf(body) {
  return body?.error?.message || "";
}

function errorRetryableOf(body) {
  return Boolean(body?.error?.retryable);
}

export {
  errorCodeOf,
  errorEnvelope,
  errorMessageOf,
  errorResult,
  errorRetryableOf,
  normalizeRequestId,
  successEnvelope,
  successResult,
};
