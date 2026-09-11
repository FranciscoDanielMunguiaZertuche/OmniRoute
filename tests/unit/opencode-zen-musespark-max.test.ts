/**
 * Keyed Zen muse-spark native-max opt-in: opencode-zen terminates at the same
 * Zen backend as keyless opencode, whose gateway validator explicitly accepts
 * literal max — so keyed muse-spark/hy3 must pass max through instead of being
 * normalized down to xhigh. Non-muse-spark Zen models stay capped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { supportsMaxEffortForProvider } from "../../open-sse/executors/base/reasoningEffort.ts";

test("opencode-zen muse-spark passes literal max", () => {
  assert.equal(
    supportsMaxEffortForProvider("opencode-zen", "muse-spark-1.3-contributor-free"),
    true
  );
});

test("opencode-zen hy3 passes literal max", () => {
  assert.equal(supportsMaxEffortForProvider("opencode-zen", "hy3-free"), true);
});

test("keyless opencode muse-spark still passes literal max", () => {
  assert.equal(supportsMaxEffortForProvider("opencode", "muse-spark-1.3-contributor-free"), true);
});

test("other opencode-zen models stay capped (no blanket opt-in)", () => {
  assert.equal(supportsMaxEffortForProvider("opencode-zen", "gpt-5.5"), false);
  assert.equal(supportsMaxEffortForProvider("opencode-zen", "claude-fable-5"), false);
});

test("spec-compliant providers stay capped", () => {
  assert.equal(supportsMaxEffortForProvider("openai", "gpt-5.5"), false);
});
