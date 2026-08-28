/**
 * Crumb-stop detection for combo quality validation (user log 2026-08-21,
 * ox-alpha / x-preview-f-free on opencode zen).
 *
 * Failure shape observed live: the upstream terminated a stream CLEANLY
 * (finish_reason=stop + [DONE]) after emitting only a micro-answer — a single
 * heading line, or reasoning deltas with no answer/tool-call — and never
 * reported usage. The #5297 empty-stop branch cannot catch it because the one
 * content delta exits the peek loop as "content", and the agent (omp/opencode)
 * ends the turn silently on hasText=false.
 *
 * Rule added (round 1): a cleanly-terminated OpenAI-shape stream with
 * sub-threshold accumulated output and NO usage object is a glitch → invalid
 * for failover. Legit short answers report usage (both harnesses send
 * stream_options.include_usage=true), so they stay valid.
 *
 * Round 2 (same day, tendo session): zen ALSO glitches with large
 * reasoning-only streams that terminate cleanly WITH usage — omp received a
 * lone thinking block and silently ended its turn. Usage no longer rescues a
 * text-less/tool-call-less turn (#2341 carve-out reversed): an agentic turn
 * ALWAYS ends in visible text or a tool call. The peek loop therefore only
 * early-exits on TEXT past threshold or tool calls; reasoning-only prefixes
 * stay buffered until classification.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { validateResponseQuality } = await import("../../open-sse/services/combo.ts");

const silentLog = { warn: () => {} };

function sseResponse(frames: unknown[], opts: { withDone?: boolean } = {}): Response {
  const withDone = opts.withDone ?? true;
  let body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  if (withDone) body += "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function roleChunk(): unknown {
  return { object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] };
}

function textChunk(text: string): unknown {
  return { object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] };
}

function reasoningChunk(text: string): unknown {
  return {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { reasoning_content: text } }],
  };
}

function stopChunk(reason = "stop"): unknown {
  return {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  };
}

test("crumb stop: heading line + clean stop + no usage is INVALID", async () => {
  const res = sseResponse([
    roleChunk(),
    textChunk("**5. Resumen ejecutivo de 1 página (entregable escrito):**"),
    stopChunk("stop"),
  ]);
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, false, `expected invalid, got valid (${out.reason ?? "-"})`);
  assert.match(out.reason ?? "", /crumb stop/);
});

test("crumb stop: reasoning-only + clean stop + no usage is INVALID", async () => {
  const res = sseResponse([
    roleChunk(),
    reasoningChunk("Let me check the layout file."),
    reasoningChunk("The drift items come from useQuery."),
    stopChunk("stop"),
  ]);
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, false);
  assert.match(out.reason ?? "", /reasoning-only stop/);
});

test("short legit answer WITH usage stays VALID", async () => {
  const res = sseResponse([
    roleChunk(),
    textChunk("Bright red"),
    stopChunk("stop"),
    {
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
    },
  ]);
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, true, `expected valid, got reason: ${out.reason ?? "-"}`);
});

test("tool-call stream stays VALID (early exit before terminal)", async () => {
  const res = sseResponse([
    roleChunk(),
    {
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: "" },
              },
            ],
          },
        },
      ],
    },
    stopChunk("tool_calls"),
  ]);
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, true, `expected valid, got reason: ${out.reason ?? "-"}`);
});

test("long text (>200 chars cumulative) stays VALID even without usage", async () => {
  const res = sseResponse([
    roleChunk(),
    ...Array.from({ length: 5 }, (_, i) => textChunk("abcdefgh".repeat(6) + ` part ${i}. `)),
    stopChunk("stop"),
  ]);
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, true, `expected valid, got reason: ${out.reason ?? "-"}`);
});

test("reasoning-only WITH reported usage is now INVALID (#2341 carve-out reversed — tendo glitch)", async () => {
  const res = sseResponse([
    roleChunk(),
    reasoningChunk("Orchestration reasoning... ".repeat(80)),
    stopChunk("stop"),
    {
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 },
    },
  ]);
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, false, `expected invalid, got valid (${out.reason ?? "-"})`);
  assert.match(out.reason ?? "", /reasoning-only stop/);
});

test("large reasoning prefix followed by answer text stays VALID (live streaming preserved)", async () => {
  const res = sseResponse([
    roleChunk(),
    ...Array.from({ length: 30 }, (_, i) => reasoningChunk(`thinking block ${i}; `.repeat(4))),
    textChunk("Here is the full implementation plan. ".repeat(12)),
    stopChunk("stop"),
    {
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 900, total_tokens: 1000 },
    },
  ]);
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, true, `expected valid, got reason: ${out.reason ?? "-"}`);
});

test("reasoning prefix followed by tool call stays VALID", async () => {
  const res = sseResponse([
    roleChunk(),
    reasoningChunk("Need to inspect the repo first."),
    {
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_9",
                type: "function",
                function: { name: "bash", arguments: "{}" },
              },
            ],
          },
        },
      ],
    },
    stopChunk("tool_calls"),
    {
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 60, total_tokens: 110 },
    },
  ]);
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, true, `expected valid, got reason: ${out.reason ?? "-"}`);
});

test("#5297 zero-delta empty stop remains INVALID (regression guard)", async () => {
  const res = sseResponse([roleChunk(), stopChunk("stop")]);
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, false);
  assert.equal(out.reason, "streaming openai empty stop");
});

test("#7285 truncation without finish_reason/[DONE] remains INVALID (regression guard)", async () => {
  const res = sseResponse([roleChunk()], { withDone: false });
  const out = await validateResponseQuality(res, true, silentLog);
  assert.equal(out.valid, false);
  assert.equal(out.reason, "streaming openai truncated without finish_reason");
});

test("non-streaming crumb stop: tiny content + stop + no usage is INVALID", async () => {
  const res = new Response(
    JSON.stringify({
      choices: [{ message: { content: "**heading**" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const out = await validateResponseQuality(res, false, silentLog);
  assert.equal(out.valid, false);
  assert.match(out.reason ?? "", /crumb stop/);
});

test("non-streaming tiny content WITH usage stays VALID", async () => {
  const res = new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const out = await validateResponseQuality(res, false, silentLog);
  assert.equal(out.valid, true, `expected valid, got reason: ${out.reason ?? "-"}`);
});

test("non-streaming reasoning-only WITHOUT usage is INVALID (twin of streaming rule)", async () => {
  const res = new Response(
    JSON.stringify({
      choices: [
        { message: { content: null, reasoning_content: "Deduction body." }, finish_reason: "stop" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const out = await validateResponseQuality(res, false, silentLog);
  assert.equal(out.valid, false, `expected invalid, got valid (${out.reason ?? "-"})`);
  assert.match(out.reason ?? "", /reasoning-only stop/);
});

test("non-streaming reasoning-only WITH usage + clean stop is INVALID", async () => {
  const res = new Response(
    JSON.stringify({
      choices: [
        { message: { content: null, reasoning_content: "Long deduction." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 500, total_tokens: 520 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const out = await validateResponseQuality(res, false, silentLog);
  assert.equal(out.valid, false, `expected invalid, got valid (${out.reason ?? "-"})`);
});

test("non-streaming reasoning + text content stays VALID", async () => {
  const res = new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: "The answer is 42.", reasoning_content: "Let me compute." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 30, total_tokens: 35 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const out = await validateResponseQuality(res, false, silentLog);
  assert.equal(out.valid, true, `expected valid, got reason: ${out.reason ?? "-"}`);
});
