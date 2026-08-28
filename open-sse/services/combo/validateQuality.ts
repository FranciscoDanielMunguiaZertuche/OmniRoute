/**
 * Combo response-quality validation extracted from combo.ts.
 *
 * `validateResponseQuality` (bounded SSE peek + non-streaming content check) and
 * `toRetryAfterDisplayValue` moved out of the combo.ts god-file (Quality Gate v2
 * / Fase 9). Logic unchanged; re-exported from combo.ts for compatibility.
 */

import {
  createSSEDataLineNormalizer,
  hasOpenAIFinishReason,
  isKnownNonClaudeStreamPayload,
  isOpenAIChoicesPayload,
} from "../../utils/streamHelpers.ts";
import { evaluateResponseValidation, type ResponseValidationConfig } from "./responseValidation.ts";
import { getReasoningTokens } from "../../../src/lib/usage/tokenAccounting.ts";
import type { ComboRetryAfter } from "./types.ts";

export function toRetryAfterDisplayValue(value: ComboRetryAfter): string | Date {
  if (typeof value !== "number") return value;
  if (value > 0 && value < 1_000_000_000) {
    return new Date(Date.now() + value * 1000);
  }
  return new Date(value);
}

// Issue #6427: some providers mask credit/quota exhaustion behind an HTTP 200 —
// either an OpenAI-shape top-level `error` object, or a known exhaustion phrase
// living in the error envelope itself (never in assistant prose — see
// `extractEnvelopeErrorText`). Single-quantifier-per-token-class alternation,
// no nested/overlapping quantifiers — cannot backtrack catastrophically.
const EXHAUSTION_MARKER_PATTERN =
  /\b(insufficient\s+credit|insufficient\s+balance|quota\s+exceeded|out\s+of\s+credits?|credit\s+exhausted)\b/i;

/**
 * Collect the small set of top-level "error envelope" strings a 200 response may
 * carry alongside (or instead of) a normal completion: the OpenAI-shape `error`
 * object's `message`/`code`/`type`, a bare string `error`, or sibling top-level
 * `message`/`detail` fields some providers use for the same purpose. Deliberately
 * does NOT look inside `choices[].message.content` — assistant prose that merely
 * mentions "quota" or "credits" must never be misclassified as an upstream failure.
 */
function extractEnvelopeErrorText(json: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const err = json.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.code === "string") parts.push(e.code);
    if (typeof e.type === "string") parts.push(e.type);
  } else if (typeof err === "string" && err.length > 0) {
    parts.push(err);
  }
  if (typeof json.message === "string") parts.push(json.message);
  if (typeof json.detail === "string") parts.push(json.detail);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Mutable lifecycle flags threaded through {@link applySseLifecycleEvent}. */
interface SseLifecycleFlags {
  hasMessageStart: boolean;
  hasContentBlock: boolean;
  hasRealContent: boolean;
  hasLifecycleEnd: boolean;
}

/** Read `parsed.<key>` as a nested object bag, or null when absent/not an object. */
function asObject(parsed: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = parsed[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * A content_block_start is real signal only for tool_use / redacted_thinking —
 * a tool call is meaningful even before its input_json_delta arrives. text and
 * thinking blocks routinely open empty; keep peeking for a delta instead.
 */
function contentBlockStartIsRealSignal(parsed: Record<string, unknown>): boolean {
  const blockType = asObject(parsed, "content_block")?.type;
  return blockType === "tool_use" || blockType === "redacted_thinking";
}

/**
 * A content_block_delta is real signal when it carries non-empty text/thinking,
 * or any input_json_delta fragment — even an empty-string first chunk proves a
 * tool_use block is actively streaming its arguments.
 */
function contentBlockDeltaIsRealSignal(parsed: Record<string, unknown>): boolean {
  const delta = asObject(parsed, "delta");
  if (!delta) return false;
  const deltaType = typeof delta.type === "string" ? delta.type : "";
  if (deltaType === "input_json_delta") return true;
  if (deltaType !== "text_delta" && deltaType !== "thinking_delta") return false;
  const text = delta.text ?? delta.thinking;
  return typeof text === "string" && text.length > 0;
}

/** A message_delta closes the lifecycle once it carries a stop_reason. */
function messageDeltaEndsLifecycle(parsed: Record<string, unknown>): boolean {
  return asObject(parsed, "delta")?.stop_reason != null;
}

/**
 * Mutable OpenAI-shape lifecycle flags (#7285) — tracked independently of
 * {@link SseLifecycleFlags} because the truncation signal here (a stream that
 * closes without ever carrying `finish_reason` or a `[DONE]` sentinel) is
 * orthogonal to the Claude event switch and must fire even when
 * `hasOpenAICompatibleStreamValue()` never sees real content (e.g. a
 * role-only delta).
 */
interface OpenAiLifecycleFlags {
  hasChoicePayload: boolean;
  hasTerminalMarker: boolean;
  // Crumb-stop accounting (user log 2026-08-21, ox-alpha on opencode zen):
  // a stream can also terminate CLEANLY (finish_reason=stop / [DONE]) after
  // emitting only a crumb — a heading line, reasoning-only deltas with no
  // answer/tool-call, or nothing at all — which the #7285/#5297 branches
  // below cannot catch because real content deltas exit the peek loop as
  // "content". These counters accumulate while the peek is still running so
  // the done-branch can distinguish a real turn (text past the threshold,
  // any tool call) from an empty or reasoning-only stop, regardless of
  // whether usage was reported.
  contentChars: number;
  reasoningChars: number;
  sawToolCallDelta: boolean;
  sawUsage: boolean;
}

/**
 * Max accumulated visible output (text + reasoning chars, streaming) for a
 * cleanly-terminated stream to still be classified as a "crumb stop" when no
 * usage was ever reported. Above this the response is unambiguously real and
 * the peek exits early. Chosen well above one heading/short sentence but far
 * below any agent turn: legit coding turns emit tool calls (never reach this
 * check) or hundreds+ of chars.
 */
export const OPENAI_CRUMB_STOP_MAX_CHARS = 200;

/** Accumulate one OpenAI-shape choice's delta/message into the crumb counters. */
function accumulateOpenAiChoiceCrumb(
  choice: Record<string, unknown>,
  flags: OpenAiLifecycleFlags
): void {
  const delta = asObject(choice, "delta") ?? asObject(choice, "message");
  if (!delta) return;
  if (typeof delta.content === "string") {
    flags.contentChars += delta.content.length;
  }
  const reasoning = delta.reasoning_content ?? delta.reasoning_text ?? delta.reasoning;
  if (typeof reasoning === "string") {
    flags.reasoningChars += reasoning.length;
  }
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    flags.sawToolCallDelta = true;
  }
}

/** Update `flags` in place from one parsed OpenAI-shape SSE `data:` payload. */
function applyOpenAiLifecycleEvent(
  parsed: Record<string, unknown>,
  flags: OpenAiLifecycleFlags
): void {
  if (isRecord(parsed.usage)) flags.sawUsage = true;
  const choices = parsed.choices;
  if (!Array.isArray(choices)) return;
  flags.hasChoicePayload = true;
  if (hasOpenAIFinishReason(parsed)) {
    flags.hasTerminalMarker = true;
    // Some providers ride the usage object on the finish_reason chunk itself
    // with `choices: []` — already past the array guard, so capture it.
    if (isRecord(parsed.usage)) flags.sawUsage = true;
  }
  for (const choice of choices) {
    if (isRecord(choice)) accumulateOpenAiChoiceCrumb(choice, flags);
  }
}

/**
 * Apply a single parsed Claude SSE event to the peeked lifecycle `flags`
 * (mutated in place). Extracted from `parseAccumulatedSse`'s inline switch to
 * keep that function under the complexity/line ratchets — logic unchanged.
 *
 * Returns true once REAL content (not just an empty content_block_start) is
 * detected — the caller should stop peeking and treat the stream as non-empty.
 */
function applySseLifecycleEvent(
  eventType: string,
  parsed: Record<string, unknown>,
  flags: SseLifecycleFlags
): boolean {
  switch (eventType) {
    case "message_start":
      flags.hasMessageStart = true;
      return false;
    case "content_block_start":
      flags.hasContentBlock = true;
      if (!contentBlockStartIsRealSignal(parsed)) return false;
      flags.hasRealContent = true;
      return true;
    case "content_block_delta":
      flags.hasContentBlock = true;
      if (!contentBlockDeltaIsRealSignal(parsed)) return false;
      flags.hasRealContent = true;
      return true;
    case "content_block_stop":
      flags.hasContentBlock = true;
      return false;
    case "message_stop":
      flags.hasLifecycleEnd = true;
      return false;
    case "message_delta":
      if (messageDeltaEndsLifecycle(parsed)) flags.hasLifecycleEnd = true;
      return false;
    default:
      return false;
  }
}

function responsesApiOutputHasContent(output: unknown): boolean {
  return (
    Array.isArray(output) &&
    output.some((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      if (record.type !== "message") return Boolean(record.type);
      const content = record.content;
      return (
        Array.isArray(content) &&
        content.some(
          (part) =>
            !!part &&
            typeof part === "object" &&
            typeof (part as Record<string, unknown>).text === "string" &&
            ((part as Record<string, string>).text as string).length > 0
        )
      );
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStreamingUpstreamError(parsed: unknown, eventType: string): boolean {
  if (eventType === "response.failed" || eventType === "error") return true;
  if (!isRecord(parsed)) return false;
  if (parsed.error != null) return true;

  const nestedResponse = isRecord(parsed.response) ? parsed.response : null;
  return nestedResponse?.status === "failed" && nestedResponse.error != null;
}

type StreamingPeekOutcome = "content" | "error" | null;

/**
 * Validate that a successful (HTTP 200) non-streaming response actually contains
 * meaningful content. Returns { valid: true } or { valid: false, reason }.
 *
 * Only inspects non-streaming JSON responses — streaming responses are passed through
 * because buffering the full stream would defeat the purpose of streaming.
 *
 * Checks:
 * 1. Body is valid JSON
 * 2. Has at least one choice with non-empty content or tool_calls
 */
function parseJsonRecord(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function validateResponseQuality(
  response: Response,
  isStreaming: boolean,
  log: { warn?: (...args: unknown[]) => void },
  responseValidation?: ResponseValidationConfig | null
): Promise<{ valid: boolean; reason?: string; clonedResponse?: Response }> {
  // Issue #3685: For Claude SSE streaming responses, use a BOUNDED PEEK to
  // detect the empty-content-block pattern (content_filter stop_reason with
  // no content_block_* events) WITHOUT de-streaming non-empty responses.
  //
  // Parse SSE events incrementally. Stop buffering once a content_block_* event
  // or a known non-Claude SSE payload appears, replay the buffered prefix, then
  // pipe the original reader so the rest of the stream keeps flowing normally.
  // Only fail over when a complete Claude lifecycle ends without content_block.
  //
  // Non-text/event-stream streaming responses are not buffered at all.
  if (isStreaming) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      return { valid: true };
    }

    if (!response.body) {
      return { valid: true };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    // Raw Uint8Array chunks accumulated so far — used to replay the prefix
    // in the returned clonedResponse.
    const bufferedChunks: Uint8Array[] = [];
    // Decoded text accumulated across chunks for incremental SSE parsing.
    // Only the tail of the most-recently-processed line window remains here
    // between iterations (incomplete lines are deferred to the next chunk).
    let decodedSoFar = "";

    // SSE lifecycle state.
    //
    // #1382: hasContentBlock only means "a content_block_* event was observed"
    // — it does NOT mean the block carried usable content. A content_block_start
    // for a text/thinking block routinely opens with empty text (real content
    // arrives via subsequent content_block_delta events); some upstreams
    // (reported: DeepSeek/GLM via claude→openai translation on tool-heavy
    // requests) open and close such a block without ever emitting a delta.
    // hasRealContent tracks whether we've actually seen usable output: a
    // tool_use/redacted_thinking block start (self-evidently real, even before
    // any delta), or a delta carrying non-empty text/thinking/tool-input.
    const sse: SseLifecycleFlags = {
      hasMessageStart: false,
      hasContentBlock: false,
      hasRealContent: false,
      hasLifecycleEnd: false,
    };
    let anyContentFound = false;
    // #7285: OpenAI-shape lifecycle tracking, parallel to `sse` above.
    const openAi: OpenAiLifecycleFlags = {
      hasChoicePayload: false,
      hasTerminalMarker: false,
      contentChars: 0,
      reasoningChars: 0,
      sawToolCallDelta: false,
      sawUsage: false,
    };
    // User log 1784230812441-bf3789: the previous `!sawAnyBytes` gate below let
    // ANY byte — even unparseable garbage with no SSE framing at all — pass
    // combo failover through. These two flags are tracked in parallel to
    // `sse`/`openAi` above and only tighten the GENERIC done-branch gate
    // further down; the #1382 (`sse.hasRealContent`) and #7285
    // (`openAi.hasTerminalMarker`) branches are untouched.
    //   - sawStructuredSSE — a parseable `event:` or `data:` frame was seen,
    //     even one that carries no recognised content (ping/metadata) — the
    //     #3399 pass-through contract for those streams is preserved.
    //   - sawTerminator     — a recognised terminator arrived: `data: [DONE]`,
    //     an OpenAI `finish_reason` (mirrors `openAi.hasTerminalMarker`), a
    //     Claude `message_stop`/`message_delta` with `stop_reason` (mirrors
    //     `sse.hasLifecycleEnd`), or a terminal `usage`-only chunk (new).
    let sawStructuredSSE = false;
    let sawTerminator = false;
    const sseLineNormalizer = createSSEDataLineNormalizer();
    let pendingEventType = "";

    /**
     * Parse any complete SSE lines from `decodedSoFar`, updating lifecycle
     * flags in the closure. The last (potentially incomplete) line is kept in
     * `decodedSoFar` for the next iteration.
     *
     * Returns "content" once REAL content (not just an empty content_block_start)
     * is detected, or "error" when the upstream reports a failure before content.
     * Otherwise peeking continues.
     */
    // Some providers send a terminal `usage`-only chunk (no `choices`) as the
    // final SSE frame instead of a `[DONE]`/`finish_reason` marker. Excludes
    // Responses API `response.*` events, which have their own dedicated
    // handling via `isKnownNonClaudeStreamPayload`.
    function isTerminalUsageOnlyChunk(parsed: Record<string, unknown>, eventType: string): boolean {
      return Boolean(
        parsed.usage &&
        typeof parsed.usage === "object" &&
        !Array.isArray(parsed.choices) &&
        !eventType.startsWith("response.")
      );
    }

    // Consume one normalized SSE line: track `event:` framing / keepalives /
    // `[DONE]` terminators in the enclosing state, and return the JSON-parsed
    // `data:` payload when (and only when) the line carries one.
    function consumeSseLine(line: string): Record<string, unknown> | null {
      const trimmed = line.trim();

      if (trimmed.startsWith("event:")) {
        pendingEventType = trimmed.slice(6).trim();
        // An `event:` line is structured SSE framing on its own, even
        // before any `data:` payload arrives (e.g. a bare keepalive ping).
        sawStructuredSSE = true;
        return null;
      }

      if (!trimmed.startsWith("data:")) {
        if (!trimmed) pendingEventType = "";
        return null;
      }

      const data = trimmed.slice(5).trim();
      if (!data) return null;
      if (data === "[DONE]") {
        // #7285: `[DONE]` is itself a terminal marker for OpenAI-shape
        // streams, even when no earlier chunk carried `finish_reason`.
        openAi.hasTerminalMarker = true;
        sawTerminator = true;
        return null;
      }

      return parseJsonRecord(data);
    }

    function parseAccumulatedSse(): StreamingPeekOutcome {
      const lines = decodedSoFar.split(/\r?\n/);
      // Retain the potentially-incomplete trailing fragment.
      decodedSoFar = lines[lines.length - 1];

      for (const line of sseLineNormalizer.normalize(lines.slice(0, -1))) {
        const parsed = consumeSseLine(line);
        if (!parsed) continue;

        // A successfully parsed `data:` payload is structured SSE activity
        // regardless of shape or content — tracked only for the generic
        // done-branch gate below; the #1382/#7285 branches are unaffected.
        sawStructuredSSE = true;

        applyOpenAiLifecycleEvent(parsed, openAi);
        if (openAi.hasTerminalMarker) sawTerminator = true;

        // Crumb-stop accounting: once accumulated output is unambiguously real
        // (enough visible TEXT, or any tool call) stop peeking and forward.
        // Reasoning deltas deliberately do NOT clear this bar (#ox-reasoning):
        // ox-alpha on opencode zen glitches emit large reasoning payloads and
        // then terminate CLEANLY with zero text and zero tool calls — exactly
        // the shape the done-branch below must see to invalidate. Healthy
        // agent turns still exit here as soon as answer text flows past the
        // threshold, so live downstream streaming is preserved for everything
        // except a pure-thinking prefix.
        const crumbThresholdExceeded =
          openAi.sawToolCallDelta || openAi.contentChars > OPENAI_CRUMB_STOP_MAX_CHARS;
        if (crumbThresholdExceeded) {
          return "content";
        }

        const eventType =
          (typeof parsed.type === "string" ? parsed.type : null) || pendingEventType || "";
        pendingEventType = "";

        if (isStreamingUpstreamError(parsed, eventType)) {
          return "error";
        }

        if (isTerminalUsageOnlyChunk(parsed, eventType)) sawTerminator = true;
        // Usage may also ride a usage-only chunk with no choices[] at all.
        if (isRecord(parsed.usage)) openAi.sawUsage = true;

        // While an OpenAI-shape stream is still in crumb territory (no tool
        // calls, sub-threshold output) its small deltas must NOT exit the peek
        // early via isKnownNonClaudeStreamPayload — the whole point is to see
        // whether the stream terminates cleanly without ever reporting usage.
        // Non-OpenAI shapes keep the legacy behavior untouched.
        const isOpenAiShape = Array.isArray(parsed.choices);
        if (!isOpenAiShape && isKnownNonClaudeStreamPayload(parsed, eventType)) {
          return "content";
        }

        if (applySseLifecycleEvent(eventType, parsed, sse)) {
          return "content";
        }
        if (sse.hasLifecycleEnd) sawTerminator = true;
      }
      return null;
    }

    /**
     * Build a Response whose body first replays all bytes in `bufferedChunks`,
     * then forwards the remainder of `readerToForward` chunk-by-chunk.
     * Preserves the original response's status, statusText, and headers.
     */
    function buildReplayResponse(
      readerToForward: ReadableStreamDefaultReader<Uint8Array>
    ): Response {
      // Snapshot the prefix so mutations after this point don't affect it.
      const prefix = bufferedChunks.slice();
      let prefixIdx = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          // 1. Drain the buffered prefix one chunk at a time.
          if (prefixIdx < prefix.length) {
            controller.enqueue(prefix[prefixIdx++]);
            return;
          }
          // 2. Forward the remainder from the original reader.
          try {
            const { done, value } = await readerToForward.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // Main bounded-peek loop.
    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Stream finished — flush the TextDecoder and parse any remaining text.
          const tail = decoder.decode(undefined, { stream: false });
          if (tail) decodedSoFar += tail;
          if (decodedSoFar.trim()) decodedSoFar += "\n\n";
          const terminalOutcome = parseAccumulatedSse();

          if (terminalOutcome === "error") {
            log.warn?.(
              "COMBO",
              "Streaming response reported an upstream error before content — marking as invalid for combo failover"
            );
            return { valid: false, reason: "streaming upstream error" };
          }

          if (sse.hasMessageStart && sse.hasLifecycleEnd && !sse.hasRealContent) {
            // Complete Claude lifecycle with zero content blocks, or with
            // content_block_start/stop pairs that never carried real text/
            // thinking/tool_use content (#1382 — tool-heavy claude→openai
            // requests against upstreams like DeepSeek/GLM can "complete" a
            // lifecycle around an empty block) → failover.
            log.warn?.(
              "COMBO",
              sse.hasContentBlock
                ? "Streaming Claude response has complete lifecycle but its content block(s) carried no usable text/tool_use — marking as invalid for combo failover"
                : "Streaming Claude response has complete lifecycle but zero content blocks (content_filter?) — marking as invalid for combo failover"
            );
            return { valid: false, reason: "streaming empty content block" };
          }

          // Stream ended with a truly EMPTY body (e.g. Gemini returning HTTP
          // 200 with zero bytes), or with bytes that never formed a single
          // recognizable SSE frame and never signalled termination — mark as
          // invalid for combo failover so the sibling model gets tried.
          // Streams that carried ANY structured SSE activity (an explicit
          // `data: [DONE]`, ping/metadata events, an incomplete Claude
          // lifecycle) or a recognised terminator keep the pass-through
          // contract (#3399/#3685): those are handled by the stream-readiness
          // timeout, not failover.
          //
          // Tightened after user log 1784230812441-bf3789: the previous
          // `!sawAnyBytes` check let ANY byte — even unparseable garbage that
          // never produced a single structured SSE frame — pass through,
          // leaving the downstream SSE parser hung on a half-finished stream.
          if (!anyContentFound && !sse.hasContentBlock && !sawTerminator && !sawStructuredSSE) {
            log.warn?.(
              "COMBO",
              "Streaming response ended with no recognized content or SSE terminator — marking as invalid for combo failover"
            );
            return { valid: false, reason: "streaming no recognized content" };
          }

          // Issue #7285: an OpenAI-shape stream (`choices[]` chunks) that
          // closes without ever carrying `finish_reason` or a `[DONE]`
          // sentinel, and without producing recognized content, is a
          // truncated response — failover to a sibling combo target rather
          // than forwarding the incomplete stream as a success. Does not
          // affect Claude-shape streams (`openAi.hasChoicePayload` stays
          // false for those) and does not regress the #3399/#3685
          // pass-through contract: a healthy stream exits the peek loop
          // early via the `foundContent` branch above and never reaches here.
          if (openAi.hasChoicePayload && !openAi.hasTerminalMarker && !anyContentFound) {
            log.warn?.(
              "COMBO",
              "Streaming OpenAI-shape response ended with no finish_reason or [DONE] — marking as invalid for combo failover"
            );
            return { valid: false, reason: "streaming openai truncated without finish_reason" };
          }

          // #5297 + #ox-reasoning: an OpenAI-shape stream that terminates
          // cleanly (`finish_reason` or `[DONE]`) with zero TEXT and zero
          // tool-call deltas is not a completion, whether it carried nothing
          // at all (classic "empty stop" — GLM 5.2 on NVIDIA NIM, DeepSeek
          // free tier) or a large reasoning-only payload that then stopped
          // (ox-alpha on opencode zen, user log 2026-08-21: the agent
          // received a lone thinking block and silently ended its turn).
          // Usage presence deliberately does NOT rescue this shape anymore
          // (supersedes the old #2341 carve-out): zen reports usage even on
          // these glitched turns. An agentic turn ALWAYS ends in text or a
          // tool call; anything else is truncation → retry/failover.
          if (
            openAi.hasChoicePayload &&
            openAi.hasTerminalMarker &&
            !openAi.sawToolCallDelta &&
            openAi.contentChars === 0
          ) {
            log.warn?.(
              "COMBO",
              openAi.reasoningChars > 0
                ? `Streaming OpenAI-shape response terminated cleanly after ${openAi.reasoningChars} reasoning chars with NO text/tool-call (reasoning-only stop) — marking as invalid for combo failover`
                : "Streaming OpenAI-shape response terminated with zero content deltas (empty stop) — marking as invalid for combo failover"
            );
            return {
              valid: false,
              reason:
                openAi.reasoningChars > 0
                  ? "streaming openai reasoning-only stop"
                  : "streaming openai empty stop",
            };
          }

          // Crumb stop (user log 2026-08-21, ox-alpha on opencode zen): the
          // stream terminated cleanly after emitting only a micro-answer — a
          // bare heading or similar — and NEVER reported usage. Legit short
          // answers report usage (both omp and opencode request
          // stream_options.include_usage), so clean-stop + sub-threshold text
          // + no usage is an upstream glitch, not a completion:
          // retry/failover instead of surfacing a silently-truncated turn.
          if (
            openAi.hasChoicePayload &&
            openAi.hasTerminalMarker &&
            !openAi.sawToolCallDelta &&
            !openAi.sawUsage &&
            openAi.contentChars <= OPENAI_CRUMB_STOP_MAX_CHARS &&
            openAi.reasoningChars <= OPENAI_CRUMB_STOP_MAX_CHARS
          ) {
            log.warn?.(
              "COMBO",
              `Streaming OpenAI-shape response stopped cleanly with a crumb (${openAi.contentChars} text + ${openAi.reasoningChars} reasoning chars) and no usage — marking as invalid for combo failover`
            );
            return { valid: false, reason: "streaming openai crumb stop without usage" };
          }
          // Incomplete lifecycle or non-Claude stream — replay all buffered
          // bytes. The reader is exhausted so the forwarding reader will
          // immediately signal done.
          const clonedResponse = buildReplayResponse(reader);
          return { valid: true, clonedResponse };
        }

        // Accumulate raw bytes for potential replay.
        bufferedChunks.push(value);

        // Decode incrementally (stream:true keeps multi-byte char state).
        decodedSoFar += decoder.decode(value, { stream: true });
        const outcome = parseAccumulatedSse();

        if (outcome === "error") {
          // Do not await cancellation of a Response.clone() tee branch: the
          // promise may remain pending until the client-facing branch drains.
          reader.cancel().catch(() => {});
          log.warn?.(
            "COMBO",
            "Streaming response reported an upstream error before content — marking as invalid for combo failover"
          );
          return { valid: false, reason: "streaming upstream error" };
        }

        if (outcome === "content") {
          anyContentFound = true;
          // A content_block_* event was found — stop peeking. Return a
          // clonedResponse that replays all buffered bytes (the current chunk
          // is already in bufferedChunks) and then forwards the remainder of
          // the original reader unchanged.
          const clonedResponse = buildReplayResponse(reader);
          return { valid: true, clonedResponse };
        }
      }
    } catch (streamErr) {
      // If reading the stream fails due to a locked stream or pipe error,
      // the content cannot be verified — mark as invalid for combo failover.
      // A locked ReadableStream means the response body is already consumed
      // or corrupted (e.g. "Invalid state: The ReadableStream is locked").
      // Broad match: Chrome/V8 throws "body used already", Firefox throws
      // "ReadableStream is locked", etc.
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (
        streamErr instanceof TypeError &&
        (errMsg.includes("locked") ||
          errMsg.includes("disturbed") ||
          errMsg.includes("used already"))
      ) {
        return { valid: false, reason: "stream locked or disturbed" };
      }
      // Other read errors — pass through (stream readiness timeout will catch truly broken streams)
      return { valid: true };
    }
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json") && !contentType.includes("text/")) {
    return { valid: true };
  }

  let cloned: Response;
  try {
    cloned = response.clone();
  } catch {
    return { valid: true };
  }

  let text: string;
  try {
    text = await cloned.text();
  } catch {
    return { valid: true };
  }

  if (!text || text.trim().length === 0) {
    return { valid: false, reason: "empty response body" };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    if (text.startsWith("data:") || text.startsWith("event:")) return { valid: true };
    return { valid: false, reason: "response is not valid JSON" };
  }

  // Feature 4985: apply the combo's configured response-body predicate. A failure here
  // fails over to the next target via the same path as the built-in empty-content checks.
  if (responseValidation) {
    const verdict = evaluateResponseValidation(json, responseValidation);
    if (!verdict.valid) {
      return { valid: false, reason: verdict.reason };
    }
  }

  // Issue #6427: a masked 200 — an OpenAI-shape top-level `error` object, or a
  // known exhaustion phrase in the error envelope — is a failure regardless of
  // whether `choices`/`output` also look structurally present (some providers
  // echo a stub completion alongside the error). Checked unconditionally, before
  // any shape-specific branch, so it can't be shadowed by an otherwise-valid body.
  const rawError = json?.error;
  const errorIsMeaningful =
    (typeof rawError === "string" && rawError.length > 0) ||
    (!!rawError && typeof rawError === "object" && Object.keys(rawError).length > 0);
  if (errorIsMeaningful) {
    const envelopeText = extractEnvelopeErrorText(json);
    const errMsg =
      rawError &&
      typeof rawError === "object" &&
      typeof (rawError as Record<string, unknown>).message === "string"
        ? ((rawError as Record<string, unknown>).message as string)
        : envelopeText || JSON.stringify(rawError).substring(0, 200);
    return { valid: false, reason: `upstream error in 200 body: ${errMsg}` };
  }
  {
    const envelopeText = extractEnvelopeErrorText(json);
    if (envelopeText && EXHAUSTION_MARKER_PATTERN.test(envelopeText)) {
      const snippet = envelopeText.length > 80 ? `${envelopeText.slice(0, 80)}…` : envelopeText;
      return { valid: false, reason: `upstream exhaustion marker in 200 body: ${snippet}` };
    }
  }

  const choices = json?.choices;
  if (json?.object === "response") {
    if (!responsesApiOutputHasContent(json.output))
      return { valid: false, reason: "empty_choices" };
    const status = typeof json.status === "string" ? json.status : "";
    if (status && !["completed", "done"].includes(status)) {
      return { valid: false, reason: "no_terminal" };
    }
    return {
      valid: true,
      clonedResponse: new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  }

  if (!Array.isArray(choices) || choices.length === 0) {
    // `json?.error` is already handled unconditionally above (#6427); reaching
    // here means no error envelope was present.
    if (json?.output || json?.result || json?.data || json?.response) return { valid: true };
    return { valid: true };
  }

  const firstChoice = choices[0];
  const message = firstChoice?.message || firstChoice?.delta;
  if (!message) {
    return { valid: false, reason: "choice has no message object" };
  }

  const content = message.content;
  const toolCalls = message.tool_calls;
  // Issue #2341: Reasoning models (Kimi-K2.5-TEE, GLM-5-TEE, etc.) emit their
  // output in `reasoning_content` (or `reasoning`) with `content: null`. The
  // validator used to flag those as empty and trigger a false-positive 502
  // fallback. Count a non-empty reasoning_content as valid output too.
  const reasoningContent = message.reasoning_content ?? message.reasoning;
  const hasReasoningContent =
    typeof reasoningContent === "string" && reasoningContent.trim().length > 0;
  // Issue #7000: content can be a string, an array of content parts
  // (multimodal), or null. An empty array [] or an array of empty parts
  // must NOT count as valid content — only arrays with at least one
  // non-empty text/image part do.
  let hasContent: boolean;
  if (Array.isArray(content)) {
    hasContent = content.some(
      (part) =>
        !!part &&
        typeof part === "object" &&
        ((typeof (part as Record<string, unknown>).text === "string" &&
          ((part as Record<string, string>).text as string).trim().length > 0) ||
          (part as Record<string, unknown>).type === "image_url" ||
          (part as Record<string, unknown>).type === "input_audio" ||
          (part as Record<string, unknown>).type === "file")
    );
  } else {
    hasContent =
      (content !== null &&
        content !== undefined &&
        content !== "" &&
        (typeof content !== "string" || content.trim().length > 0)) ||
      hasReasoningContent;
  }
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

  if (!hasContent && !hasToolCalls) {
    return { valid: false, reason: "empty content and no tool_calls in response" };
  }

  // Crumb stop — non-streaming twin of the streaming rule above: a clean
  // `finish_reason: "stop"` carrying only a micro-answer, with NO usage
  // object. Healthy non-streaming completions always report usage; absence
  // plus a sub-threshold answer is an upstream glitch → retry/failover.
  // Reasoning-only bodies remain valid (#2341).
  if (!hasToolCalls && !hasReasoningContent && !isRecord(json.usage)) {
    const finishReason = (firstChoice as Record<string, unknown> | undefined)?.finish_reason;
    const textLen = Array.isArray(content)
      ? content.reduce(
          (n: number, part: unknown) =>
            n +
            (!!part &&
            typeof part === "object" &&
            typeof (part as Record<string, unknown>).text === "string"
              ? ((part as Record<string, string>).text as string).length
              : 0),
          0
        )
      : typeof content === "string"
        ? content.trim().length
        : 0;
    if (finishReason === "stop" && textLen <= OPENAI_CRUMB_STOP_MAX_CHARS) {
      log.warn?.(
        "COMBO",
        `Non-streaming response stopped cleanly with a ${textLen}-char crumb and no usage — marking as invalid for combo failover`
      );
      return { valid: false, reason: "crumb stop without usage" };
    }
  }

  // Issue #3587 + #ox-reasoning: Reasoning models (deepseek-v4-flash,
  // nemotron, ox-alpha on opencode zen) may consume ALL completion budget for
  // reasoning_tokens, leaving content empty — or simply stop cleanly after a
  // reasoning-only body (streaming twin above). When content is empty with
  // reasoning present and no tool calls, a clean `finish_reason: "stop"` is
  // always invalid regardless of the token ratio (usage rides these glitched
  // turns too); for non-stop finishes keep the legacy ≥90% heuristic.
  const contentIsEmpty = content === null || content === undefined || content === "";
  if (contentIsEmpty && hasReasoningContent && !hasToolCalls) {
    const finishReason = (firstChoice as Record<string, unknown> | undefined)?.finish_reason;
    if (finishReason === "stop") {
      log.warn?.(
        "COMBO",
        "Non-streaming response stopped cleanly with reasoning-only output and no text/tool-call — marking as invalid for combo failover"
      );
      return { valid: false, reason: "non-streaming reasoning-only stop" };
    }
    const usage = json?.usage as Record<string, unknown> | undefined;
    if (usage) {
      const completionTokens = Number(usage.completion_tokens) || 0;
      const reasoningTokens = getReasoningTokens(usage);
      // If reasoning consumed 90%+ of completion tokens, the model ran out of
      // budget before producing any content output.
      if (completionTokens > 0 && reasoningTokens >= completionTokens * 0.9) {
        return {
          valid: false,
          reason: `reasoning consumed ${reasoningTokens}/${completionTokens} tokens — no content output`,
        };
      }
    }
  }

  return {
    valid: true,
    clonedResponse: new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

/**
 * Release the peek-and-abandon clone used by {@link validateResponseQuality}.
 *
 * The quality check clones the upstream response, reads the clone only until the
 * first content block, then hands back a `clonedResponse` that callers on the
 * streaming path DISCARD (they forward the original, untouched response). Because
 * a `Response.clone()` tees the body, that abandoned branch would otherwise buffer
 * the entire remaining body in memory until the original finishes streaming.
 *
 * Cancelling the abandoned branch releases that buffer. Per the ReadableStream tee
 * contract, cancelling one branch does NOT cancel the shared source while the other
 * branch (the original response being streamed to the client) is still active, so
 * this is safe. No-op when the clone fell back to the original (clone unsupported)
 * or when quality reading already exhausted the body (no `clonedResponse`).
 */
export function releaseQualityClone(
  clone: Response,
  original: Response,
  quality: { clonedResponse?: Response }
): void {
  if (clone === original) return;
  void quality.clonedResponse?.body?.cancel().catch(() => {});
}

/**
 * Cancel every response branch after a failed quality check when the caller is
 * discarding the upstream response and falling back to another target.
 *
 * Streaming validation cancels its reader, but a reader on a `Response.clone()`
 * tee cannot cancel the shared source until the untouched original branch is
 * cancelled too. Best-effort cancellation of both branches also releases an
 * unread quality clone for non-streaming failures.
 */
export function releaseRejectedQualityResponse(clone: Response, original: Response): void {
  if (clone !== original) {
    void clone.body?.cancel().catch(() => {});
  }
  void original.body?.cancel().catch(() => {});
}
