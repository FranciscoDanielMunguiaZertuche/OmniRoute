import test from "node:test";
import assert from "node:assert/strict";

import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.ts";

/**
 * Regression tests — degenerate tool calls (empty/missing name, or arguments
 * that are not a JSON object, e.g. `"true"`) emitted by deepseek-v4-flash
 * family upstreams via opencode-zen must be stripped by the passthrough gate
 * before reaching the client, while valid tool calls pass through verbatim.
 *
 * These tests drive the REAL passthrough transform stream with an OpenAI-format
 * upstream SSE payload (the format opencode-zen serves).
 */

interface ToolCallFragment {
  index: number;
  id?: string;
  type?: string;
  name?: string;
  arguments?: string;
}

function makeToolCallChunk(
  toolCalls: ToolCallFragment[],
  finishReason: string | null = null
): string {
  const delta: Record<string, unknown> = {
    tool_calls: toolCalls.map((tc) => ({
      index: tc.index,
      ...(tc.id !== undefined ? { id: tc.id } : {}),
      type: tc.type ?? "function",
      function: {
        ...(tc.name !== undefined ? { name: tc.name } : {}),
        ...(tc.arguments !== undefined ? { arguments: tc.arguments } : {}),
      },
    })),
  };
  const chunk = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function makeFinishChunk(finishReason: string): string {
  const chunk = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function runPassthrough(rawSSE: string): Promise<string> {
  const transform = createPassthroughStreamWithLogger(
    "test-provider",
    null,
    null,
    "test-model",
    "conn-degenerate",
    { model: "test-model" }
  );

  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const readAll = (async () => {
    const out: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(decoder.decode(value));
    }
    return out.join("");
  })();

  await writer.write(encoder.encode(rawSSE));
  await writer.close();

  return readAll;
}

/** Parse all SSE data payloads (excluding [DONE]) from a raw SSE string. */
function parseDataEvents(raw: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      // skip non-JSON metadata lines
    }
  }
  return events;
}

function toolCallEvents(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.filter((e) =>
    Array.isArray(
      (e.choices?.[0] as Record<string, unknown> | undefined)?.delta &&
        ((e.choices?.[0] as Record<string, unknown>).delta as Record<string, unknown>).tool_calls
    )
  );
}

function lastFinishEvent(events: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return events
    .filter((e) => (e.choices?.[0] as Record<string, unknown> | undefined)?.finish_reason)
    .pop();
}

test("passthrough: degenerate 'true' tool call stripped, finish demoted to stop with placeholder", async () => {
  const rawSSE = [
    makeToolCallChunk([{ index: 0, id: "call_1", name: "get_weather", arguments: "" }]),
    makeToolCallChunk([{ index: 0, arguments: "true" }]),
    makeFinishChunk("tool_calls"),
    "data: [DONE]\n\n",
  ].join("");

  const result = await runPassthrough(rawSSE);
  const events = parseDataEvents(result);

  assert.equal(
    toolCallEvents(events).length,
    0,
    "degenerate tool-call fragments must be dropped entirely"
  );
  const finishEvent = lastFinishEvent(events);
  assert.equal(finishEvent?.choices?.[0]?.finish_reason, "stop");

  const contentEvents = events.filter(
    (e) =>
      typeof (e.choices?.[0] as Record<string, unknown> | undefined)?.delta === "object" &&
      typeof ((e.choices?.[0] as Record<string, unknown>).delta as Record<string, unknown>)
        .content === "string"
  );
  assert.equal(contentEvents.length, 1, "placeholder content chunk must be emitted");
  assert.match(
    ((contentEvents[0].choices[0] as Record<string, unknown>).delta as Record<string, unknown>)
      .content as string,
    /empty response/
  );
});

test("passthrough: valid tool call forwarded verbatim with finish tool_calls", async () => {
  const frag1 = makeToolCallChunk([
    { index: 0, id: "call_1", name: "get_weather", arguments: '{"city":' },
  ]);
  const frag2 = makeToolCallChunk([{ index: 0, arguments: '"SF"}' }]);
  const rawSSE = [frag1, frag2, makeFinishChunk("tool_calls"), "data: [DONE]\n\n"].join("");

  const result = await runPassthrough(rawSSE);
  const events = parseDataEvents(result);

  const toolEvents = toolCallEvents(events);
  assert.equal(toolEvents.length, 2, "valid fragments must be forwarded");
  // Forwarded verbatim — byte-identical delta payloads.
  assert.deepEqual(
    toolEvents.map((e) => (e.choices[0] as Record<string, unknown>).delta),
    [
      {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":' },
          },
        ],
      },
      {
        tool_calls: [{ index: 0, type: "function", function: { arguments: '"SF"}' } }],
      },
    ]
  );
  const finishEvent = lastFinishEvent(events);
  assert.equal(finishEvent?.choices?.[0]?.finish_reason, "tool_calls");
});

test("passthrough: mixed degenerate+valid — degenerate stripped, survivors reindexed", async () => {
  const rawSSE = [
    makeToolCallChunk([{ index: 0, id: "call_bad", name: "get_weather", arguments: "" }]),
    makeToolCallChunk([{ index: 1, id: "call_good", name: "lookup_user", arguments: '{"id":' }]),
    makeToolCallChunk([{ index: 0, arguments: "true" }]),
    makeToolCallChunk([{ index: 1, arguments: '"42"}' }]),
    makeFinishChunk("tool_calls"),
    "data: [DONE]\n\n",
  ].join("");

  const result = await runPassthrough(rawSSE);
  const events = parseDataEvents(result);

  const toolEvents = toolCallEvents(events);
  assert.equal(toolEvents.length, 2, "only the two valid fragments survive");
  for (const event of toolEvents) {
    for (const tc of (
      (event.choices[0] as Record<string, unknown>).delta as Record<string, unknown>
    ).tool_calls as Record<string, unknown>[]) {
      assert.equal(tc.index, 0, "surviving calls must be renumbered contiguously");
    }
  }
  assert.deepEqual((toolEvents[0].choices[0] as Record<string, unknown>).delta, {
    tool_calls: [
      {
        index: 0,
        id: "call_good",
        type: "function",
        function: { name: "lookup_user", arguments: '{"id":' },
      },
    ],
  });
  assert.deepEqual((toolEvents[1].choices[0] as Record<string, unknown>).delta, {
    tool_calls: [{ index: 0, type: "function", function: { arguments: '"42"}' } }],
  });
  const finishEvent = lastFinishEvent(events);
  assert.equal(finishEvent?.choices?.[0]?.finish_reason, "tool_calls");
});

test("passthrough: degenerate args and finish in the SAME chunk — stripped inline", async () => {
  const rawSSE = [
    makeToolCallChunk([{ index: 0, id: "call_1", name: "get_weather", arguments: "" }]),
    // Final arguments fragment arrives together with the finish_reason.
    makeToolCallChunk([{ index: 0, arguments: "true" }], "tool_calls"),
    "data: [DONE]\n\n",
  ].join("");

  const result = await runPassthrough(rawSSE);
  const events = parseDataEvents(result);

  assert.equal(
    toolCallEvents(events).length,
    0,
    "degenerate fragments must be dropped even when bundled with the finish"
  );
  const finishEvent = lastFinishEvent(events);
  assert.equal(finishEvent?.choices?.[0]?.finish_reason, "stop");
});

test("passthrough: FIRST chunk carries tool_calls + finish — degenerate stripped inline", async () => {
  // No prior buffered chunk: the finish chunk is also the only tool-call
  // chunk, so the inline resolve path (not Part A) must strip it.
  const rawSSE = [
    makeToolCallChunk(
      [{ index: 0, id: "call_1", name: "get_weather", arguments: "true" }],
      "tool_calls"
    ),
    "data: [DONE]\n\n",
  ].join("");

  const result = await runPassthrough(rawSSE);
  const events = parseDataEvents(result);

  assert.equal(
    toolCallEvents(events).length,
    0,
    "degenerate first-and-finish chunk must be stripped inline"
  );
  const finishEvent = lastFinishEvent(events);
  assert.equal(finishEvent?.choices?.[0]?.finish_reason, "stop");
});

test("passthrough: EOF without finish chunk — buffered degenerate calls stripped before synthetic finish", async () => {
  const rawSSE = [
    makeToolCallChunk([{ index: 0, id: "call_1", name: "get_weather", arguments: "" }]),
    makeToolCallChunk([{ index: 0, arguments: "true" }]),
    "data: [DONE]\n\n",
  ].join("");

  const result = await runPassthrough(rawSSE);
  const events = parseDataEvents(result);

  assert.equal(toolCallEvents(events).length, 0, "degenerate fragments must not leak on EOF flush");
  const finishEvent = lastFinishEvent(events);
  assert.equal(finishEvent?.choices?.[0]?.finish_reason, "stop");
});
