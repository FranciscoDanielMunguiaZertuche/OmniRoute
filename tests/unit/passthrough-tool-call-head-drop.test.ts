import test from "node:test";
import assert from "node:assert/strict";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.ts";

/**
 * Regression tests — tool-call head drop on buffer overflow, and the
 * empty-stop placeholder guard.
 *
 * Bug (a): NaraRouter emits each tool-call argument fragment as a ~5-byte
 * payload wrapped in a ~240-byte SSE envelope (~60x inflation). The
 * degenerate tool-call gate counts SSE bytes (output.length), not argument
 * bytes, against PASSTHROUGH_TOOL_CALL_BUFFER_MAX_BYTES (256KB). A large
 * tool call (e.g. a `write` with a big payload) overflows the cap and the
 * overflow branch used to DISCARD the held head chunk — the one carrying the
 * tool-call id+name — so the client saw only tail fragments with name:"" and
 * id:"", which strict agent loops reject as "Tool not found".
 *
 * Fix 1: on overflow, flush everything already held (head first) before
 * forwarding live, and disable the gate for the rest of the stream.
 *
 * Bug (b): some upstreams end a turn with a terminal finish_reason but zero
 * content/reasoning/tool-call deltas. Forwarding that verbatim makes strict
 * agent loops burn their empty-stop retries.
 *
 * Fix 2: synthesize a placeholder content chunk BEFORE the finish chunk
 * (both the inline finish path and the EOF-synthesized-stop path).
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

/** A chunk with an arbitrary delta and (optionally) a finish_reason. */
function makeDeltaChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null
): string {
  const chunk = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function runPassthrough(rawSSE: string): Promise<string> {
  const transform = createPassthroughStreamWithLogger(
    "test-provider",
    null,
    null,
    "test-model",
    "conn-head-drop",
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

/** Concatenate every tool-call argument fragment across events, in order. */
function concatToolCallArguments(events: Record<string, unknown>[]): string {
  let out = "";
  for (const e of events) {
    const delta = (e.choices?.[0] as Record<string, unknown> | undefined)?.delta as
      Record<string, unknown> | undefined;
    const tcs = delta?.tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs as Record<string, unknown>[]) {
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn && typeof fn.arguments === "string") out += fn.arguments;
    }
  }
  return out;
}

const EMPTY_STOP_PLACEHOLDER =
  "[Model returned an empty response — please continue with the next steps or call a tool]";

function contentEvents(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.filter((e) => {
    const delta = (e.choices?.[0] as Record<string, unknown> | undefined)?.delta as
      Record<string, unknown> | undefined;
    return typeof delta?.content === "string" && (delta.content as string).length > 0;
  });
}

// ---------------------------------------------------------------------------
// Bug (a) / Fix 1 — overflow flushes the held head chunk instead of dropping it
// ---------------------------------------------------------------------------

test("passthrough: large tool call overflows buffer — head chunk (id+name) still reaches client first", async () => {
  const FRAGMENTS = 15;
  const FRAGMENT_SIZE = 20_000;
  const filler = "A".repeat(FRAGMENT_SIZE);

  const headArgs = '{"content":"';
  const tailArgs = '"}';
  const expectedArgs = headArgs + filler.repeat(FRAGMENTS) + tailArgs;

  const chunks: string[] = [];
  // Head chunk carries the tool-call id + name.
  chunks.push(
    makeToolCallChunk([{ index: 0, id: "call_big", name: "write_file", arguments: headArgs }])
  );
  for (let i = 0; i < FRAGMENTS; i++) {
    chunks.push(makeToolCallChunk([{ index: 0, arguments: filler }]));
  }
  chunks.push(makeToolCallChunk([{ index: 0, arguments: tailArgs }]));
  chunks.push(makeFinishChunk("tool_calls"));

  const rawSSE = chunks.join("");
  // Sanity: this stream genuinely exceeds the 256KB gate cap in SSE bytes.
  assert.ok(
    rawSSE.length > 262_144,
    `test stream must overflow the 256KB cap, got ${rawSSE.length} bytes`
  );

  const out = await runPassthrough(rawSSE);
  const events = parseDataEvents(out);
  const tcEvents = toolCallEvents(events);

  assert.ok(tcEvents.length > 0, "client must receive tool-call events");

  // The FIRST tool-call event the client sees must carry the id + name.
  const firstDelta = (tcEvents[0].choices?.[0] as Record<string, unknown>).delta as Record<
    string,
    unknown
  >;
  const firstTc = (firstDelta.tool_calls as Record<string, unknown>[])[0];
  assert.equal(firstTc.id, "call_big", "head chunk id must survive overflow");
  assert.equal(
    (firstTc.function as Record<string, unknown>).name,
    "write_file",
    "head chunk name must survive overflow"
  );

  // Arguments must be contiguous across every fragment (nothing dropped/reordered).
  const gotArgs = concatToolCallArguments(tcEvents);
  assert.equal(gotArgs, expectedArgs, "tool-call arguments must be contiguous");

  // Finish reason must still be tool_calls.
  const finish = lastFinishEvent(events);
  assert.equal(
    (finish?.choices?.[0] as Record<string, unknown> | undefined)?.finish_reason,
    "tool_calls"
  );
});

test("passthrough: small tool call under the cap still resolves normally (no regression)", async () => {
  const rawSSE = [
    makeToolCallChunk([{ index: 0, id: "call_small", name: "get_weather", arguments: '{"city":' }]),
    makeToolCallChunk([{ index: 0, arguments: '"Paris"}' }]),
    makeFinishChunk("tool_calls"),
  ].join("");

  const out = await runPassthrough(rawSSE);
  const events = parseDataEvents(out);
  const tcEvents = toolCallEvents(events);

  assert.ok(tcEvents.length > 0);
  const firstDelta = (tcEvents[0].choices?.[0] as Record<string, unknown>).delta as Record<
    string,
    unknown
  >;
  const firstTc = (firstDelta.tool_calls as Record<string, unknown>[])[0];
  assert.equal(firstTc.id, "call_small");
  assert.equal((firstTc.function as Record<string, unknown>).name, "get_weather");
  assert.equal(concatToolCallArguments(tcEvents), '{"city":"Paris"}');
});

// ---------------------------------------------------------------------------
// Bug (b) / Fix 2 — empty-stop placeholder (inline finish path)
// ---------------------------------------------------------------------------

test("passthrough: empty 'stop' stream yields exactly one placeholder before finish", async () => {
  const rawSSE = makeFinishChunk("stop");
  const out = await runPassthrough(rawSSE);
  const events = parseDataEvents(out);

  const placeholders = contentEvents(events).filter((e) => {
    const delta = (e.choices?.[0] as Record<string, unknown>).delta as Record<string, unknown>;
    return delta.content === EMPTY_STOP_PLACEHOLDER;
  });
  assert.equal(placeholders.length, 1, "exactly one placeholder chunk expected");

  // Placeholder must precede the finish chunk.
  const placeholderIdx = events.indexOf(placeholders[0]);
  const finishIdx = events.indexOf(lastFinishEvent(events)!);
  assert.ok(placeholderIdx >= 0 && finishIdx >= 0);
  assert.ok(placeholderIdx < finishIdx, "placeholder must come before the finish chunk");

  assert.equal(
    (lastFinishEvent(events)?.choices?.[0] as Record<string, unknown>)?.finish_reason,
    "stop"
  );
});

test("passthrough: content-bearing stream does NOT get a placeholder", async () => {
  const rawSSE = [makeDeltaChunk({ content: "Hello, world" }), makeFinishChunk("stop")].join("");
  const out = await runPassthrough(rawSSE);
  const events = parseDataEvents(out);

  const placeholders = contentEvents(events).filter((e) => {
    const delta = (e.choices?.[0] as Record<string, unknown>).delta as Record<string, unknown>;
    return delta.content === EMPTY_STOP_PLACEHOLDER;
  });
  assert.equal(placeholders.length, 0, "no placeholder when content is present");
});

test("passthrough: reasoning-only stream does NOT get a placeholder", async () => {
  const rawSSE = [
    makeDeltaChunk({ reasoning_content: "thinking about it" }),
    makeFinishChunk("stop"),
  ].join("");
  const out = await runPassthrough(rawSSE);
  const events = parseDataEvents(out);

  const placeholders = contentEvents(events).filter((e) => {
    const delta = (e.choices?.[0] as Record<string, unknown>).delta as Record<string, unknown>;
    return delta.content === EMPTY_STOP_PLACEHOLDER;
  });
  assert.equal(placeholders.length, 0, "no placeholder when reasoning is present");
});

test("passthrough: 'length' finish does NOT get a placeholder", async () => {
  const rawSSE = makeFinishChunk("length");
  const out = await runPassthrough(rawSSE);
  const events = parseDataEvents(out);

  const placeholders = contentEvents(events).filter((e) => {
    const delta = (e.choices?.[0] as Record<string, unknown>).delta as Record<string, unknown>;
    return delta.content === EMPTY_STOP_PLACEHOLDER;
  });
  assert.equal(placeholders.length, 0, "no placeholder for finish_reason=length");
});

test("passthrough: 'content_filter' finish does NOT get a placeholder", async () => {
  const rawSSE = makeFinishChunk("content_filter");
  const out = await runPassthrough(rawSSE);
  const events = parseDataEvents(out);

  const placeholders = contentEvents(events).filter((e) => {
    const delta = (e.choices?.[0] as Record<string, unknown>).delta as Record<string, unknown>;
    return delta.content === EMPTY_STOP_PLACEHOLDER;
  });
  assert.equal(placeholders.length, 0, "no placeholder for finish_reason=content_filter");
});

test("passthrough: tool-call stream does NOT get an empty-stop placeholder", async () => {
  const rawSSE = [
    makeToolCallChunk([{ index: 0, id: "call_x", name: "noop", arguments: "{}" }]),
    makeFinishChunk("tool_calls"),
  ].join("");
  const out = await runPassthrough(rawSSE);
  const events = parseDataEvents(out);

  const placeholders = contentEvents(events).filter((e) => {
    const delta = (e.choices?.[0] as Record<string, unknown>).delta as Record<string, unknown>;
    return delta.content === EMPTY_STOP_PLACEHOLDER;
  });
  assert.equal(placeholders.length, 0, "no placeholder when tool calls are present");
});

// ---------------------------------------------------------------------------
// Bug (b) / Fix 2 — empty-stop placeholder (EOF-synthesized-stop path)
// ---------------------------------------------------------------------------

test("passthrough: EOF without finish and no content — placeholder before synthesized stop", async () => {
  // A single role chunk with no finish_reason; the stream then ends. The
  // EOF path synthesizes a stop, and the guard must add a placeholder first.
  const rawSSE = makeDeltaChunk({ role: "assistant" });
  const out = await runPassthrough(rawSSE);
  const events = parseDataEvents(out);

  const placeholders = contentEvents(events).filter((e) => {
    const delta = (e.choices?.[0] as Record<string, unknown>).delta as Record<string, unknown>;
    return delta.content === EMPTY_STOP_PLACEHOLDER;
  });
  assert.equal(placeholders.length, 1, "exactly one placeholder on empty EOF");

  // A synthesized stop finish must be present, after the placeholder.
  const finish = lastFinishEvent(events);
  assert.equal(
    (finish?.choices?.[0] as Record<string, unknown> | undefined)?.finish_reason,
    "stop",
    "synthesized stop expected on EOF"
  );
  const placeholderIdx = events.indexOf(placeholders[0]);
  const finishIdx = events.indexOf(finish!);
  assert.ok(placeholderIdx < finishIdx, "placeholder must precede synthesized stop");
});
