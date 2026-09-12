/**
 * Fleet max-only policy: main/task/fast combos route exclusively to
 * muse-spark-1.3 (max) with glm-5.3 (max) fallback — never xhigh, never high.
 * Every combo member pair must pass literal max through the sanitizer, and a
 * stray high must be upgraded to max (not left below the top tier).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeReasoningEffortForProvider,
  supportsMaxEffortForProvider,
} from "../../open-sse/executors/base/reasoningEffort.ts";

const COMBO_LANES: Array<[string, string]> = [
  ["opencode", "muse-spark-1.3-contributor-free"],
  ["opencode-zen", "muse-spark-1.3-contributor-free"],
  ["openai-compatible-kira", "glm-5.3-free"],
  ["openai-compatible-onerouter", "glm-5.3:free"],
  ["tokenrouter", "z-ai/glm-5.3-free"],
];

for (const [provider, model] of COMBO_LANES) {
  test(`${provider}/${model} supports literal max`, () => {
    assert.equal(supportsMaxEffortForProvider(provider, model), true);
  });

  test(`${provider}/${model} keeps reasoning_effort=max (never xhigh/high)`, () => {
    const out = sanitizeReasoningEffortForProvider(
      { model, reasoning_effort: "max" },
      provider,
      model,
      null
    ) as Record<string, unknown>;
    assert.equal(out["reasoning_effort"], "max");
  });

  test(`${provider}/${model} upgrades stray high → max`, () => {
    const out = sanitizeReasoningEffortForProvider(
      { model, reasoning_effort: "high" },
      provider,
      model,
      null
    ) as Record<string, unknown>;
    assert.equal(out["reasoning_effort"], "max");
  });
}

test("spec-compliant providers stay capped (no blanket opt-in)", () => {
  assert.equal(supportsMaxEffortForProvider("openai", "gpt-5.5"), false);
  assert.equal(supportsMaxEffortForProvider("opencode-zen", "gpt-5.5"), false);
});

test("agentrouter GPT steps max down to high (operator-ordered lane)", () => {
  const out = sanitizeReasoningEffortForProvider(
    { model: "gpt-5.6-sol", reasoning_effort: "max" },
    "agentrouter",
    "gpt-5.6-sol",
    null
  ) as Record<string, unknown>;
  assert.equal(out["reasoning_effort"], "high");
});

test("agentrouter GPT keeps an explicit high (never xhigh)", () => {
  const out = sanitizeReasoningEffortForProvider(
    { model: "gpt-5.6-sol", reasoning_effort: "high" },
    "agentrouter",
    "gpt-5.6-sol",
    null
  ) as Record<string, unknown>;
  assert.equal(out["reasoning_effort"], "high");
});
