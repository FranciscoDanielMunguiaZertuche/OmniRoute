/**
 * Gemini 3.7 Flash (stable, 2026-08-13) — registry + spec defense.
 *
 * The new model id was added to both the public `gemini` provider catalog and
 * MODEL_SPECS. These tests pin the observable contract so a future registry
 * cleanup cannot silently drop it:
 *   - the provider lists `gemini-3.7-flash` with tools + vision,
 *   - MODEL_SPECS carries a matching context-window/tool/vision spec, and
 *   - the Gemini rate-limit tracker reports 0 (no client-side gating) for the
 *     id, since its free-tier RPM/RPD were not yet published — upstream still
 *     enforces limits server-side.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { geminiProvider } = await import("../../open-sse/config/providers/registry/gemini/index.ts");
const { MODEL_SPECS } = await import("../../src/shared/constants/modelSpecs.ts");
const { getModelRpm, getModelRpd, getModelTpm } =
  await import("../../open-sse/services/geminiRateLimitTracker.ts");

const MODEL_ID = "gemini-3.7-flash";

test("gemini provider registry lists gemini-3.7-flash with tool calling and vision", () => {
  const model = geminiProvider.models.find((m) => m.id === MODEL_ID);
  assert.ok(model, `${MODEL_ID} must be present in the gemini provider catalog`);
  assert.equal(model.name, "Gemini 3.7 Flash");
  assert.equal(model.toolCalling, true, "expected toolCalling to be enabled");
  assert.equal(model.supportsVision, true, "expected supportsVision to be enabled");
});

test("MODEL_SPECS carries a context/tool/vision spec for gemini-3.7-flash", () => {
  const spec = MODEL_SPECS[MODEL_ID];
  assert.ok(spec, `${MODEL_ID} must have a MODEL_SPECS entry`);
  assert.equal(spec.contextWindow, 1048576, "expected 1M context window");
  assert.equal(spec.supportsTools, true, "expected supportsTools to be enabled");
  assert.equal(spec.supportsVision, true, "expected supportsVision to be enabled");
});

test("gemini rate-limit tracker returns 0 for the unpublished gemini-3.7-flash limits", () => {
  // No RPM/RPD/TPM published at launch; the tracker must not gate the model
  // client-side (upstream still enforces). Guard against a future fabricated entry.
  assert.equal(getModelRpm(MODEL_ID), 0, "rpm must be 0 (no client gate)");
  assert.equal(getModelRpd(MODEL_ID), 0, "rpd must be 0 (no client gate)");
  assert.equal(getModelTpm(MODEL_ID), 0, "tpm must be 0 (no client gate)");
});
