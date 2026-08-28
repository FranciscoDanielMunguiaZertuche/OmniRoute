/**
 * Gemini 3.7 Flash (Tiered) via Antigravity — registry + spec + reasoning defense.
 *
 * `gemini-3.7-flash-tiered` is the only 3.7 variant returned by the live
 * Antigravity `:fetchAvailableModels` probe (2026-08-20). It is a single
 * dynamic-thinking model (upstream `thinkingBudget:-1`, `recommended:true`)
 * that accepts and honors an explicit `thinkingBudget` — unlike the fixed
 * 3.5/3.6 tier ids, which reject client-supplied thinking params. These tests
 * pin the observable contract so a future registry/spec cleanup cannot silently
 * downgrade it:
 *   - the antigravity provider catalog lists the id with vision + tools + reasoning,
 *   - MODEL_SPECS carries an exact spec with supportsThinking:true and a 32768
 *     thinking budget (default + cap), so the highest reasoning effort is the
 *     default and the ceiling,
 *   - the Cloud Code thinking strip does NOT fire for the tiered id (it must
 *     keep its thinking config end-to-end), and
 *   - the capability resolver reports reasoning:true for the tiered id despite
 *     the broad `antigravity/gemini-` blocklist veto (#1361), while the fixed
 *     3.6 tier ids remain correctly blocked.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { antigravityProvider } =
  await import("../../open-sse/config/providers/registry/antigravity/index.ts");
const { MODEL_SPECS } = await import("../../src/shared/constants/modelSpecs.ts");
const { shouldStripCloudCodeThinking } =
  await import("../../open-sse/services/cloudCodeThinking.ts");
const { supportsReasoning, getResolvedModelCapabilities } =
  await import("../../src/lib/modelCapabilities.ts");

const MODEL_ID = "gemini-3.7-flash-tiered";
const QUALIFIED_ID = `antigravity/${MODEL_ID}`;

test("antigravity provider registry lists gemini-3.7-flash-tiered with vision, tools, reasoning", () => {
  const model = antigravityProvider.models.find((m) => m.id === MODEL_ID);
  assert.ok(model, `${MODEL_ID} must be present in the antigravity provider catalog`);
  assert.equal(model.name, "Gemini 3.7 Flash (Tiered)");
  assert.equal(model.supportsVision, true, "expected supportsVision to be enabled");
  assert.equal(model.toolCalling, true, "expected toolCalling to be enabled");
  assert.equal(model.supportsReasoning, true, "expected supportsReasoning to be enabled");
});

test("MODEL_SPECS carries an exact thinking-enabled spec for gemini-3.7-flash-tiered", () => {
  const spec = MODEL_SPECS[MODEL_ID];
  assert.ok(spec, `${MODEL_ID} must have an exact MODEL_SPECS entry (not a prefix match)`);
  assert.equal(spec.contextWindow, 1048576, "expected 1M context window");
  assert.equal(spec.maxOutputTokens, 65536, "expected 64K max output tokens");
  assert.equal(spec.supportsThinking, true, "expected supportsThinking to be enabled");
  assert.equal(spec.supportsTools, true, "expected supportsTools to be enabled");
  assert.equal(spec.supportsVision, true, "expected supportsVision to be enabled");
  assert.equal(spec.thinkingBudgetCap, 32768, "expected 32768 thinking budget cap");
  assert.equal(spec.defaultThinkingBudget, 32768, "expected 32768 default thinking budget");
});

test("exact spec wins over the gemini-3.7-flash prefix match", () => {
  // Without the exact entry, getCanonicalModelSpecId() prefix-matches
  // `gemini-3.7-flash` (supportsThinking:false) and the strip logic would fire.
  // The exact key must resolve to the thinking-enabled spec instead.
  const tiered = MODEL_SPECS[MODEL_ID];
  const plain = MODEL_SPECS["gemini-3.7-flash"];
  assert.ok(tiered, "tiered spec must exist");
  assert.ok(plain, "plain gemini-3.7-flash spec must still exist");
  assert.notEqual(
    tiered.supportsThinking,
    plain.supportsThinking,
    "tiered spec must differ from the prefix-matched plain spec on supportsThinking"
  );
  assert.equal(tiered.supportsThinking, true);
});

test("Cloud Code thinking strip does NOT fire for the tiered id", () => {
  assert.equal(
    shouldStripCloudCodeThinking("antigravity", MODEL_ID),
    false,
    "tiered model must keep its thinking config (supportsThinking:true)"
  );
  assert.equal(
    shouldStripCloudCodeThinking("antigravity", QUALIFIED_ID),
    false,
    "qualified antigravity/ prefix must also keep thinking config"
  );
});

test("Cloud Code thinking strip still fires for the fixed 3.6 tier ids (regression)", () => {
  // The fixed 3.6 tiers reject explicit thinking params upstream; they must
  // remain stripped. Guards against the tiered allowlist accidentally widening.
  assert.equal(shouldStripCloudCodeThinking("antigravity", "gemini-3.6-flash-high"), true);
  assert.equal(shouldStripCloudCodeThinking("antigravity", "gemini-3.6-flash-medium"), true);
  assert.equal(shouldStripCloudCodeThinking("antigravity", "gemini-3.6-flash-low"), true);
});

test("capability resolver reports reasoning:true for the tiered id despite the gemini blocklist", () => {
  // The broad `antigravity/gemini-` entry in REASONING_UNSUPPORTED_PATTERNS
  // (#1361) would veto reasoning for any antigravity gemini id. The tiered
  // model is an explicit allowlist exception; it must resolve reasoning:true.
  assert.equal(supportsReasoning(QUALIFIED_ID), true, "tiered id must report reasoning:true");
  const caps = getResolvedModelCapabilities(QUALIFIED_ID);
  assert.equal(caps.reasoning, true);
  assert.equal(caps.supportsThinking, true);
  assert.equal(caps.supportsVision, true);
  assert.equal(caps.toolCalling, true);
  assert.equal(caps.defaultThinkingBudget, 32768);
  assert.equal(caps.thinkingBudgetCap, 32768);
});

test("capability resolver still blocks reasoning for the fixed 3.6 tier ids (regression)", () => {
  assert.equal(supportsReasoning("antigravity/gemini-3.6-flash-high"), false);
  assert.equal(supportsReasoning("antigravity/gemini-3.6-flash-medium"), false);
  assert.equal(supportsReasoning("antigravity/gemini-3.6-flash-low"), false);
});
