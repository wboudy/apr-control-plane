const RUN_STATES = Object.freeze(["running", "done", "failed"]);

function isAllowedRunState(value) {
  return RUN_STATES.includes(value);
}

function assertRunState(value) {
  if (!isAllowedRunState(value)) {
    throw new Error(`Invalid run state: ${String(value)}`);
  }
  return value;
}

export { RUN_STATES, assertRunState, isAllowedRunState };
