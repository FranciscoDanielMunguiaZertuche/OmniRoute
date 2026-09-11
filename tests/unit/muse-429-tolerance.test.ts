/**
 * muse-spark 429 tolerance: single decoy/transient 429s must not sideline
 * healthy 1.3 quota (which would push combo walks onto GLM while muse-spark
 * can still serve). Only 3 consecutive 429s inside 20s from the same account
 * benches a lane — for both the per-key backoff and the provider cooldown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearAllBackoffs,
  isKeyAvailable,
  recordKeyBackoff,
  recordKeySuccess,
} from "../../open-sse/services/perKeyBackoff.ts";
import {
  clearCooldownState,
  isProviderInCooldown,
  recordProviderCooldown,
  recordProviderSuccess,
} from "../../open-sse/services/providerCooldownTracker.ts";

const KEYED = "opencode-zen";
const KEYLESS = "opencode";

test("per-key: 1-2 stray 429s leave a muse-spark lane available", () => {
  clearAllBackoffs();
  recordKeyBackoff("conn-a", KEYED);
  assert.equal(isKeyAvailable("conn-a"), true);
  recordKeyBackoff("conn-a", KEYED);
  assert.equal(isKeyAvailable("conn-a"), true);
});

test("per-key: 3rd 429 inside 20s benches the lane", () => {
  clearAllBackoffs();
  recordKeyBackoff("conn-b", KEYED);
  recordKeyBackoff("conn-b", KEYED);
  recordKeyBackoff("conn-b", KEYED);
  assert.equal(isKeyAvailable("conn-b"), false);
});

test("per-key: keyless opencode gets the same tolerance", () => {
  clearAllBackoffs();
  recordKeyBackoff("conn-c", KEYLESS);
  recordKeyBackoff("conn-c", KEYLESS);
  assert.equal(isKeyAvailable("conn-c"), true);
  recordKeyBackoff("conn-c", KEYLESS);
  assert.equal(isKeyAvailable("conn-c"), false);
});

test("per-key: success resets tolerance so the next lone 429 is ignored", () => {
  clearAllBackoffs();
  recordKeyBackoff("conn-d", KEYED);
  recordKeyBackoff("conn-d", KEYED);
  recordKeySuccess("conn-d");
  recordKeyBackoff("conn-d", KEYED);
  assert.equal(isKeyAvailable("conn-d"), true);
});

test("per-key: other providers bench on the first 429 (unchanged)", () => {
  clearAllBackoffs();
  recordKeyBackoff("conn-e", "nvidia");
  assert.equal(isKeyAvailable("conn-e"), false);
});

test("per-key: non-429 path (no provider) benches immediately (unchanged)", () => {
  clearAllBackoffs();
  recordKeyBackoff("conn-f");
  assert.equal(isKeyAvailable("conn-f"), false);
});

test("cooldown: 1-2 stray 429s do not cool down a muse-spark lane", () => {
  clearCooldownState();
  recordProviderCooldown(KEYED, "conn-g", undefined, { status: 429 });
  assert.equal(isProviderInCooldown(KEYED, "conn-g"), false);
  recordProviderCooldown(KEYED, "conn-g", undefined, { status: 429 });
  assert.equal(isProviderInCooldown(KEYED, "conn-g"), false);
});

test("cooldown: 3rd 429 inside 20s cools down the lane", () => {
  clearCooldownState();
  recordProviderCooldown(KEYED, "conn-h", undefined, { status: 429 });
  recordProviderCooldown(KEYED, "conn-h", undefined, { status: 429 });
  recordProviderCooldown(KEYED, "conn-h", undefined, { status: 429 });
  assert.equal(isProviderInCooldown(KEYED, "conn-h"), true);
});

test("cooldown: success resets tolerance", () => {
  clearCooldownState();
  recordProviderCooldown(KEYED, "conn-i", undefined, { status: 429 });
  recordProviderSuccess(KEYED, "conn-i");
  recordProviderCooldown(KEYED, "conn-i", undefined, { status: 429 });
  assert.equal(isProviderInCooldown(KEYED, "conn-i"), false);
});

test("cooldown: 5xx still cools down immediately (unchanged)", () => {
  clearCooldownState();
  recordProviderCooldown(KEYED, "conn-j", undefined, { status: 502 });
  assert.equal(isProviderInCooldown(KEYED, "conn-j"), true);
});

test("cooldown: calls without status opt-in bench immediately (unchanged)", () => {
  clearCooldownState();
  recordProviderCooldown("nvidia", "conn-k");
  assert.equal(isProviderInCooldown("nvidia", "conn-k"), true);
});
