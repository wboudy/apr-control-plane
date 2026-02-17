import {
  E_POLICY_AUTO_FORBIDDEN,
  E_POLICY_DISALLOWED_TUPLE,
  E_POLICY_MISSING_REQUIRED,
} from "./errors.mjs";

const DEFAULT_ALLOWED_TUPLES = Object.freeze([{ engine: "browser", model: "gpt-5.2-pro" }]);

function normalizeValue(value) {
  if (value == null) return "";
  return String(value).trim().toLowerCase();
}

function normalizeTuple(tuple) {
  if (!tuple || typeof tuple !== "object") return null;
  const engine = normalizeValue(tuple.engine);
  const model = normalizeValue(tuple.model);
  if (!engine || !model) return null;
  return { engine, model };
}

export function parseAllowedTuples(raw, fallback = DEFAULT_ALLOWED_TUPLES) {
  const fallbackTuples = (Array.isArray(fallback) ? fallback : DEFAULT_ALLOWED_TUPLES)
    .map(normalizeTuple)
    .filter(Boolean);

  if (raw == null || String(raw).trim() === "") {
    return fallbackTuples;
  }

  const tuples = String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [engine, model] = item.split(":");
      return normalizeTuple({ engine, model });
    })
    .filter(Boolean);

  return tuples.length > 0 ? tuples : fallbackTuples;
}

function tupleAllowed(allowedTuples, engine, model) {
  return allowedTuples.some((tuple) => tuple.engine === engine && tuple.model === model);
}

function reject(code, reason, requested, allowedTuples) {
  return {
    ok: false,
    code,
    reason,
    requested,
    effective: null,
    fallback_applied: false,
    allowed_tuples: allowedTuples,
  };
}

export function resolveEngineModelPolicy({
  strict,
  engine,
  model,
  engineExplicit,
  modelExplicit,
  allowFallback,
  allowedTuples,
}) {
  const allowed = (Array.isArray(allowedTuples) ? allowedTuples : DEFAULT_ALLOWED_TUPLES)
    .map(normalizeTuple)
    .filter(Boolean);
  const requested = {
    engine: normalizeValue(engine) || null,
    model: normalizeValue(model) || null,
    explicit: {
      engine: Boolean(engineExplicit),
      model: Boolean(modelExplicit),
    },
  };

  if (strict && (!requested.explicit.engine || !requested.explicit.model)) {
    return reject(
      E_POLICY_MISSING_REQUIRED,
      "Strict mode requires explicit engine and model targets",
      requested,
      allowed,
    );
  }

  if (strict && (requested.engine === "auto" || requested.model === "auto")) {
    return reject(E_POLICY_AUTO_FORBIDDEN, "Strict mode forbids auto engine/model targets", requested, allowed);
  }

  if (requested.engine && requested.model && tupleAllowed(allowed, requested.engine, requested.model)) {
    return {
      ok: true,
      code: null,
      reason: null,
      requested,
      effective: { engine: requested.engine, model: requested.model },
      fallback_applied: false,
      allowed_tuples: allowed,
    };
  }

  if (!strict && allowFallback && allowed.length > 0) {
    return {
      ok: true,
      code: null,
      reason: null,
      requested,
      effective: { ...allowed[0] },
      fallback_applied: true,
      allowed_tuples: allowed,
    };
  }

  return reject(E_POLICY_DISALLOWED_TUPLE, "Requested engine/model tuple is not allowed by policy", requested, allowed);
}

export { DEFAULT_ALLOWED_TUPLES };
