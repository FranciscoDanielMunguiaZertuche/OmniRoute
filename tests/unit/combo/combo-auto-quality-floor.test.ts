// tests/unit/combo/combo-auto-quality-floor.test.ts
// No-silent-downgrade guard (combo-hang fix): a quality-seeking auto combo
// (weights.taskFit >= 0.25, e.g. auto/best-coding / auto/smart) must never let
// the scoring serve a model whose task fitness is far below the pool's best
// routable candidate. Here the quality-first scoring picks llama-3.1-8b (fast,
// cheap, stable) over deepseek-v4-flash-free (higher fitness but slow + bursty) —
// the guard re-routes the selection to the best-fit candidate.
import { test, after } from "node:test";
import assert from "node:assert/strict";

import { resolveAutoStrategyOrder } from "@omniroute/open-sse/services/combo/resolveAutoStrategy.ts";
import { MODE_PACKS } from "@omniroute/open-sse/services/autoCombo/modePacks.ts";
import { resetDbInstance } from "@/lib/db/core.ts";

// resolveAutoStrategyOrder loads the LKGP via the DB singleton (dynamic import);
// release the handle so the node:test runner does not hang on teardown.
after(() => {
  resetDbInstance();
});

const noopLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as never;

const target = (provider: string, modelStr: string): never =>
  ({
    kind: "model",
    stepId: "s1",
    executionKey: `${provider}>${modelStr}`,
    modelStr,
    provider,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  }) as never;

// deepseek-v4-flash-free has HIGH task fitness (0.74 static) but terrible
// latency/stability/cost in this synthetic pool; llama-3.1-8b-instruct has LOW
// task fitness (0.55 static) but perfect latency/stability/cost — so under
// quality-first scoring the ENGINE picks llama, and the floor guard must
// re-route back to deepseek.
const pool = () =>
  [
    {
      kind: "model",
      stepId: "deepseek",
      executionKey: "opencode>deepseek-v4-flash-free",
      modelStr: "opencode/deepseek-v4-flash-free",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      quotaRemaining: 100,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 500,
      p95LatencyMs: 50000,
      latencyStdDev: 50000,
      errorRate: 0,
    },
    {
      kind: "model",
      stepId: "llama",
      executionKey: "opencode>llama-3.1-8b-instruct",
      modelStr: "opencode/llama-3.1-8b-instruct",
      provider: "opencode",
      model: "llama-3.1-8b-instruct",
      quotaRemaining: 100,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 0.01,
      p95LatencyMs: 10,
      latencyStdDev: 1,
      errorRate: 0,
    },
  ] as never;

const floorDeps = (autoConfig: Record<string, unknown>) =>
  ({
    orderedTargets: [
      target("opencode", "opencode/deepseek-v4-flash-free"),
      target("opencode", "opencode/llama-3.1-8b-instruct"),
    ],
    body: { messages: [{ role: "user", content: "hi" }] },
    combo: {
      id: "auto/best-coding",
      name: "auto/best-coding",
      autoConfig: {
        candidatePool: ["opencode"],
        explorationRate: 0,
        routerStrategy: "rules",
        ...autoConfig,
      },
    },
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } },
    log: noopLog,
    buildAutoCandidates: (async () => pool()) as never,
  }) as never;

test("quality-first auto combo re-routes away from a far-weaker model", async () => {
  const result = await resolveAutoStrategyOrder(
    floorDeps({ modePack: "quality-first", weights: MODE_PACKS["quality-first"] })
  );
  assert.ok("orderedTargets" in result, "expected a normal ordering result, not earlyResponse");
  if (!("orderedTargets" in result)) return;

  // Without the floor, the engine picks llama (fast/cheap/stable). With it, the
  // best-fit candidate (deepseek-v4-flash-free) must lead the ordered targets.
  assert.ok(
    result.orderedTargets[0]?.modelStr?.includes("deepseek-v4-flash-free"),
    `expected deepseek-v4-flash-free first, got ${result.orderedTargets[0]?.modelStr}`
  );
});

test("cost-saver auto combo (weights.taskFit < 0.25) does NOT re-route", async () => {
  const result = await resolveAutoStrategyOrder(
    floorDeps({ modePack: "cost-saver", weights: MODE_PACKS["cost-saver"] })
  );
  assert.ok("orderedTargets" in result, "expected a normal ordering result, not earlyResponse");
  if (!("orderedTargets" in result)) return;

  // Under cost-saver weights the cheap/healthy llama legitimately wins — the
  // floor must NOT re-route for cheap/free variants (auto/cheap, auto/best-free).
  assert.ok(
    result.orderedTargets[0]?.modelStr?.includes("llama-3.1-8b-instruct"),
    `expected llama-3.1-8b-instruct first under cost-saver, got ${result.orderedTargets[0]?.modelStr}`
  );
});
