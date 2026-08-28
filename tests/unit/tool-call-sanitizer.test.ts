import test from "node:test";
import assert from "node:assert/strict";

import {
  areToolCallArgumentsValid,
  filterDegenerateToolCalls,
  isDegenerateToolCall,
} from "../../open-sse/utils/toolCallSanitizer.ts";
import { sanitizeOpenAIResponse } from "../../open-sse/handlers/responseSanitizer.ts";

test("areToolCallArgumentsValid: accepts a JSON object string", () => {
  assert.equal(areToolCallArgumentsValid('{"city":"SF"}'), true);
  assert.equal(areToolCallArgumentsValid(' { "a" : 1 } '), true);
});

test("areToolCallArgumentsValid: accepts an already-parsed plain object", () => {
  assert.equal(areToolCallArgumentsValid({ city: "SF" }), true);
});

test("areToolCallArgumentsValid: rejects empty, scalar, array, and malformed arguments", () => {
  assert.equal(areToolCallArgumentsValid(""), false);
  assert.equal(areToolCallArgumentsValid("   "), false);
  assert.equal(areToolCallArgumentsValid(null), false);
  assert.equal(areToolCallArgumentsValid(undefined), false);
  assert.equal(areToolCallArgumentsValid(42), false);
  assert.equal(areToolCallArgumentsValid("true"), false);
  assert.equal(areToolCallArgumentsValid("false"), false);
  assert.equal(areToolCallArgumentsValid("null"), false);
  assert.equal(areToolCallArgumentsValid("[]"), false);
  assert.equal(areToolCallArgumentsValid("[1,2]"), false);
  assert.equal(areToolCallArgumentsValid('"str"'), false);
  assert.equal(areToolCallArgumentsValid("{broken json"), false);
  assert.equal(areToolCallArgumentsValid([]), false);
});

test("isDegenerateToolCall: name missing or empty is degenerate", () => {
  assert.equal(isDegenerateToolCall({ name: "", arguments: "{}" }), true);
  assert.equal(isDegenerateToolCall({ name: "  ", arguments: "{}" }), true);
  assert.equal(isDegenerateToolCall({ arguments: "{}" }), true);
  assert.equal(isDegenerateToolCall({}), true);
});

test("isDegenerateToolCall: non-object arguments are degenerate even with a name", () => {
  assert.equal(isDegenerateToolCall({ name: "get_weather", arguments: "true" }), true);
  assert.equal(isDegenerateToolCall({ name: "get_weather", arguments: "" }), true);
  assert.equal(isDegenerateToolCall({ name: "get_weather", arguments: "[]" }), true);
  assert.equal(isDegenerateToolCall({ name: "get_weather", arguments: "null" }), true);
});

test("isDegenerateToolCall: valid call passes", () => {
  assert.equal(isDegenerateToolCall({ name: "get_weather", arguments: '{"city":"SF"}' }), false);
  assert.equal(isDegenerateToolCall({ name: "get_weather", arguments: { city: "SF" } }), false);
});

test("filterDegenerateToolCalls: drops degenerate, keeps valid, preserves order", () => {
  const calls = [
    { id: "a", index: 0, function: { name: "get_weather", arguments: "true" } },
    { id: "b", index: 1, function: { name: "lookup_user", arguments: '{"id":"42"}' } },
    { id: "c", index: 2, function: { name: "", arguments: "{}" } },
  ];
  assert.deepEqual(filterDegenerateToolCalls(calls), [calls[1]]);
});

test("filterDegenerateToolCalls: returns empty when all degenerate", () => {
  const filtered = filterDegenerateToolCalls([
    { id: "a", index: 0, function: { name: "get_weather", arguments: "" } },
  ]);
  assert.deepEqual(filtered, []);
});

test("sanitizeOpenAIResponse: degenerate tool calls removed, finish demoted to stop", () => {
  const body = {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1700000000,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "true" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const sanitized = sanitizeOpenAIResponse(body) as Record<string, unknown>;
  const message = (sanitized.choices as Record<string, unknown>[])[0].message as Record<
    string,
    unknown
  >;
  assert.equal("tool_calls" in message, false, "degenerate tool_calls field must be omitted");
  assert.equal(
    (sanitized.choices as Record<string, unknown>[])[0].finish_reason,
    "stop",
    "finish_reason demoted when every call was degenerate"
  );
});

test("sanitizeOpenAIResponse: valid tool calls kept", () => {
  const body = {
    id: "chatcmpl-2",
    object: "chat.completion",
    created: 1700000000,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const sanitized = sanitizeOpenAIResponse(body) as Record<string, unknown>;
  const message = (sanitized.choices as Record<string, unknown>[])[0].message as Record<
    string,
    unknown
  >;
  assert.deepEqual(message.tool_calls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"SF"}' },
    },
  ]);
  assert.equal((sanitized.choices as Record<string, unknown>[])[0].finish_reason, "tool_calls");
});

test("sanitizeOpenAIResponse: mixed — degenerate dropped, valid kept", () => {
  const body = {
    id: "chatcmpl-3",
    object: "chat.completion",
    created: 1700000000,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bad",
              type: "function",
              function: { name: "get_weather", arguments: "true" },
            },
            {
              id: "call_good",
              type: "function",
              function: { name: "lookup_user", arguments: '{"id":"42"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const sanitized = sanitizeOpenAIResponse(body) as Record<string, unknown>;
  const message = (sanitized.choices as Record<string, unknown>[])[0].message as Record<
    string,
    unknown
  >;
  assert.deepEqual(message.tool_calls, [
    {
      id: "call_good",
      type: "function",
      function: { name: "lookup_user", arguments: '{"id":"42"}' },
    },
  ]);
  assert.equal((sanitized.choices as Record<string, unknown>[])[0].finish_reason, "tool_calls");
});
