import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// Keyless decoy pools (KEYLESS_DECOY_POOL_PROVIDERS, e.g. the keyless
// muse-spark contributor-free tier): quota is per upstream account, and the
// upstream sends decoy 429s on one account while siblings still have quota.
// The combo must keep retrying the pool instead of parking/skipping it:
//   - whole-provider breaker trips are exempt (per-connection benching and
//     cooldowns already isolate a sick account),
//   - synthetic (non-upstream-signalled) quota lockouts are capped at 5min
//     instead of parking the account until midnight,
//   - explicit upstream resets are always honored exactly.
describe("keyless decoy pools — keep retrying across 429s", () => {
  let accountFallback: typeof import("../../open-sse/services/accountFallback.ts");
  let comboPredicates: typeof import("../../open-sse/services/combo/comboPredicates.ts");

  const FIVE_MIN_MS = 5 * 60 * 1000;

  before(async () => {
    accountFallback = await import("../../open-sse/services/accountFallback.ts");
    comboPredicates = await import("../../open-sse/services/combo/comboPredicates.ts");
  });

  it("breaker: opencode 5xx never records a provider failure", () => {
    assert.strictEqual(
      comboPredicates.shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 500,
        sameProviderNext: false,
        provider: "opencode",
      }),
      false
    );
    assert.strictEqual(
      comboPredicates.shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 504,
        sameProviderNext: true,
        provider: "OPENCODE",
      }),
      false
    );
  });

  it("breaker: other providers still record 5xx failures", () => {
    assert.strictEqual(
      comboPredicates.shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 500,
        sameProviderNext: false,
        provider: "openai-compatible-kira",
      }),
      true
    );
    // No provider passed (legacy callers) — existing behavior unchanged.
    assert.strictEqual(
      comboPredicates.shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 503,
        sameProviderNext: false,
      }),
      true
    );
  });

  it("lockout: synthetic quota lockout on opencode is capped at 5min, not midnight", () => {
    accountFallback.clearAllModelLockouts();

    const result = accountFallback.recordModelLockoutFailure(
      "opencode",
      "conn-decoy-1",
      "muse-spark-1.3-contributor-free",
      "quota_exhausted",
      429,
      120_000,
      null,
      {}
    );

    assert.ok(
      result.cooldownMs <= FIVE_MIN_MS,
      `synthetic quota lockout on decoy pool must be <= 5min; got ${result.cooldownMs}`
    );
  });

  it("lockout: verified upstream reset on opencode is honored past the 5min cap", () => {
    accountFallback.clearAllModelLockouts();

    const thirteenDaysMs = 13 * 86_400_000;
    const result = accountFallback.recordModelLockoutFailure(
      "opencode",
      "conn-decoy-2",
      "muse-spark-1.3-contributor-free",
      "quota_exhausted",
      429,
      120_000,
      null,
      { exactCooldownMs: thirteenDaysMs, exactCooldownIsUpstreamReset: true }
    );

    assert.strictEqual(
      result.cooldownMs,
      thirteenDaysMs,
      `verified upstream reset must bypass the decoy cap; got ${result.cooldownMs}`
    );
  });

  it("lockout: non-pool providers keep the midnight default", () => {
    accountFallback.clearAllModelLockouts();

    accountFallback.recordModelLockoutFailure(
      "openai-compatible-kira",
      "conn-other-1",
      "glm-5.3-free",
      "quota_exhausted",
      429,
      120_000,
      null,
      {}
    );

    // Midnight default is hours-scale; skip the scale assertion when the test
    // runs within 6min of a midnight boundary (either local or UTC).
    const d = new Date();
    const minsToMidnight = Math.min(
      24 * 60 - (d.getHours() * 60 + d.getMinutes()),
      24 * 60 - (d.getUTCHours() * 60 + d.getUTCMinutes())
    );
    if (minsToMidnight <= 6) return;

    const info = accountFallback.getModelLockoutInfo(
      "openai-compatible-kira",
      "conn-other-1",
      "glm-5.3-free"
    );
    assert.ok(info, "expected a lockout entry for the non-pool provider");
    assert.ok(
      info.remainingMs > FIVE_MIN_MS,
      `non-pool quota lockout must keep the midnight default; got ${info.remainingMs}ms remaining`
    );
  });
});
