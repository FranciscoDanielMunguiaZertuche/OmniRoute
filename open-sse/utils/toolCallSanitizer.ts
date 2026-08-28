/**
 * Tool-call degenerate-argument sanitization.
 *
 * Some upstreams (observed: deepseek-v4-flash-family models served through
 * opencode-zen) occasionally emit a tool call whose accumulated `arguments`
 * is empty or a bare JSON literal (`"true"`, `"null"`, `"[]"`) instead of a
 * JSON object. Forwarding those verbatim makes strict clients render a
 * nonsense tool call (an "empty tool call that just says true") and then try
 * to execute it with garbage input.
 *
 * The contract here is intentionally strict: OpenAI-compatible tool
 * `arguments` are a JSON **object** by specification. Anything else is a
 * model-side failure, so the call is stripped at the gateway instead of
 * poisoning the client's tool loop.
 *
 * Kept dependency-free and pure so the passthrough stream gate, the
 * non-streaming sanitizer, and the translate-mode call-log path all share one
 * predicate.
 */

type ToolCallFunctionShape = {
  name?: unknown;
  arguments?: unknown;
};

/**
 * True when `arguments` would be usable by a strict OpenAI-compatible client:
 * a non-empty string that parses to a JSON object (not array/scalar), or an
 * already-parsed plain object.
 */
export function areToolCallArgumentsValid(args: unknown): boolean {
  if (args === null || args === undefined) return false;
  // Some providers return the arguments pre-parsed as an object.
  if (typeof args === "object" && !Array.isArray(args)) return true;
  if (typeof args !== "string") return false;

  const trimmed = args.trim();
  if (!trimmed) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

/**
 * True when a completed tool call has no usable payload: the function name is
 * missing/empty or the arguments are not a JSON object.
 */
export function isDegenerateToolCall(call: ToolCallFunctionShape): boolean {
  const name = typeof call?.name === "string" ? call.name.trim() : "";
  if (!name) return true;
  return !areToolCallArgumentsValid(call?.arguments);
}

/**
 * Drop degenerate tool calls from an array of OpenAI-style tool calls
 * (each carrying `function: { name, arguments }`). Returns a new array.
 * Entries without a `function` field are passed through untouched (pre-existing
 * passthrough contract — characterization-tested); only calls that DO carry a
 * `function` object are subject to the degenerate check.
 */
export function filterDegenerateToolCalls<T extends { function?: ToolCallFunctionShape }>(
  toolCalls: readonly T[]
): T[] {
  return toolCalls.filter((tc) => {
    if (tc?.function === undefined || tc.function === null) return true;
    return !isDegenerateToolCall(tc.function);
  });
}
