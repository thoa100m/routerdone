import { describe, it, expect } from "vitest";
import {
  MODEL_FAILURE_PREFIX,
  MODEL_FAILURE_ALL,
  getModelFailureKey,
  getModelFailureCount,
  getModelBackoffCooldownMs,
  buildModelFailureBackoffUpdate,
  buildClearModelFailureUpdate,
  MODEL_LOCK_PREFIX,
} from "../../open-sse/services/accountFallback.js";
import {
  MODEL_FAILURE_BACKOFF_BASE_MS,
  MODEL_FAILURE_BACKOFF_MAX_MS,
} from "../../open-sse/config/errorConfig.js";

describe("per-model consecutive-failure backoff", () => {
  it("uses a prefix distinct from modelLock_ so counters survive lock expiry", () => {
    expect(MODEL_FAILURE_PREFIX).toBe("modelFailure_");
    expect("modelFailure_gpt-4".startsWith(MODEL_LOCK_PREFIX)).toBe(false);
  });

  it("builds per-model and __all keys", () => {
    expect(getModelFailureKey("gpt-4")).toBe("modelFailure_gpt-4");
    expect(getModelFailureKey(null)).toBe(MODEL_FAILURE_ALL);
    expect(MODEL_FAILURE_ALL).toBe("modelFailure___all");
  });

  it("reads stored count, defaults to 0 for missing/invalid", () => {
    expect(getModelFailureCount({}, "gpt-4")).toBe(0);
    expect(getModelFailureCount(null, "gpt-4")).toBe(0);
    expect(getModelFailureCount({ "modelFailure_gpt-4": 3 }, "gpt-4")).toBe(3);
    expect(getModelFailureCount({ "modelFailure_gpt-4": -1 }, "gpt-4")).toBe(0);
    expect(getModelFailureCount({ "modelFailure_gpt-4": "oops" }, "gpt-4")).toBe(0);
  });

  it("doubles cooldown on each consecutive failure, capped at max", () => {
    expect(getModelBackoffCooldownMs(1)).toBe(MODEL_FAILURE_BACKOFF_BASE_MS);
    expect(getModelBackoffCooldownMs(2)).toBe(MODEL_FAILURE_BACKOFF_BASE_MS * 2);
    expect(getModelBackoffCooldownMs(3)).toBe(MODEL_FAILURE_BACKOFF_BASE_MS * 4);
    expect(getModelBackoffCooldownMs(4)).toBe(MODEL_FAILURE_BACKOFF_BASE_MS * 8);
    const huge = getModelBackoffCooldownMs(100);
    expect(huge).toBe(MODEL_FAILURE_BACKOFF_MAX_MS);
    expect(huge).toBeLessThanOrEqual(MODEL_FAILURE_BACKOFF_MAX_MS);
  });

  it("bumps the counter and returns the matching cooldown + update", () => {
    const r1 = buildModelFailureBackoffUpdate({}, "gpt-4");
    expect(r1.count).toBe(1);
    expect(r1.cooldownMs).toBe(MODEL_FAILURE_BACKOFF_BASE_MS);
    expect(r1.update).toEqual({ "modelFailure_gpt-4": 1 });

    const r2 = buildModelFailureBackoffUpdate({ "modelFailure_gpt-4": 1 }, "gpt-4");
    expect(r2.count).toBe(2);
    expect(r2.cooldownMs).toBe(MODEL_FAILURE_BACKOFF_BASE_MS * 2);
    expect(r2.update).toEqual({ "modelFailure_gpt-4": 2 });
  });

  it("clears only the succeeded model counter, preserving others", () => {
    const conn = { "modelFailure_gpt-4": 5, "modelFailure_claude": 3 };
    const upd = buildClearModelFailureUpdate(conn, "gpt-4");
    expect(upd).toEqual({ "modelFailure_gpt-4": 0 });
    expect(upd["modelFailure_claude"]).toBeUndefined();
  });

  it("clears __all counter on a model-less success", () => {
    const conn = { "modelFailure___all": 4, "modelFailure_gpt-4": 2 };
    const upd = buildClearModelFailureUpdate(conn, null);
    expect(upd).toEqual({ "modelFailure___all": 0 });
  });

  it("returns empty update when nothing to clear", () => {
    expect(buildClearModelFailureUpdate({}, "gpt-4")).toEqual({});
    expect(buildClearModelFailureUpdate(null, "gpt-4")).toEqual({});
  });
});
