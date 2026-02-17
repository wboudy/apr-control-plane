import test from "node:test";
import assert from "node:assert/strict";

import { E_INTERNAL } from "../../src/lib/errors.mjs";
import { errorEnvelope, successEnvelope } from "../../src/lib/envelope.mjs";
import { RUN_STATES, assertRunState } from "../../src/lib/run-state.mjs";

test("envelope success shape", () => {
  const body = successEnvelope(
    {
      run_id: "run_123",
      state: "done",
    },
    "req_123",
  );

  assert.equal(body.ok, true);
  assert.equal(body.request_id, "req_123");
  assert.equal(typeof body.ts, "string");
  assert.ok(!Number.isNaN(Date.parse(body.ts)));
  assert.equal(body.run_id, "run_123");
  assert.equal(body.state, "done");
});

test("envelope error shape", () => {
  const body = errorEnvelope({
    requestId: "req_456",
    code: E_INTERNAL,
    message: "boom",
    retryable: false,
    details: { field: "goal" },
  });

  assert.equal(body.ok, false);
  assert.equal(body.request_id, "req_456");
  assert.equal(typeof body.ts, "string");
  assert.ok(!Number.isNaN(Date.parse(body.ts)));
  assert.deepEqual(body.error, {
    code: E_INTERNAL,
    message: "boom",
    retryable: false,
    details: { field: "goal" },
  });
});

test("run state rejects invalid values", () => {
  assert.deepEqual(RUN_STATES, ["running", "done", "failed"]);
  assert.equal(assertRunState("running"), "running");
  assert.equal(assertRunState("done"), "done");
  assert.equal(assertRunState("failed"), "failed");
  assert.throws(() => assertRunState("received"), /Invalid run state/);
});
