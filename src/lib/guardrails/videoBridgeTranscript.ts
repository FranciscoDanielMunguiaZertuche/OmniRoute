import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

export type VideoTranscriptSource = "audio-bridge" | "client" | "embedded";

export interface VideoTranscriptContribution {
  confidence: number;
  endSeconds: number;
  source: VideoTranscriptSource;
  startSeconds: number;
}

export interface VideoTranscriptCue {
  confidence: number;
  /** Source-specific evidence retained when cross-source duplicates collapse. */
  contributions?: VideoTranscriptContribution[];
  endSeconds: number;
  source: VideoTranscriptSource;
  /** Every contributing provenance, ordered by the explicit source priority. */
  sources?: VideoTranscriptSource[];
  startSeconds: number;
  text: string;
}

export const VIDEO_TRANSCRIPT_MAX_CUES = 256;
export const VIDEO_TRANSCRIPT_MAX_CUE_TEXT_BYTES = 4 * 1024;
export const VIDEO_TRANSCRIPT_MAX_CUE_INPUT_CODE_UNITS = 4 * 1024;
export const VIDEO_TRANSCRIPT_MAX_TOTAL_TEXT_BYTES = 64 * 1024;
export const VIDEO_EMBEDDED_SUBTITLE_MAX_OUTPUT_BYTES = 256 * 1024;
export const VIDEO_EMBEDDED_SUBTITLE_MAX_LINE_CODE_UNITS = 4 * 1024;
export const VIDEO_EMBEDDED_SUBTITLE_MAX_TIMESTAMP_CODE_UNITS = 24;
export const VIDEO_EMBEDDED_SUBTITLE_MAX_STREAM_ATTEMPTS = 2;
export const VIDEO_EMBEDDED_SUBTITLE_TIMEOUT_MS = 10_000;
export const VIDEO_EMBEDDED_TRANSCRIPT_EXTRACTOR_VERSION = "embedded-text-v1";

export const VIDEO_EMBEDDED_SUBTITLE_CODECS = ["mov_text", "subrip", "webvtt"] as const;
export type VideoEmbeddedSubtitleCodec = (typeof VIDEO_EMBEDDED_SUBTITLE_CODECS)[number];

export interface VideoEmbeddedSubtitleStream {
  codecName: VideoEmbeddedSubtitleCodec;
  default: boolean;
  streamIndex: number;
}

export interface EmbeddedVideoTranscript {
  cues: VideoTranscriptCue[];
  fingerprint: string;
}

export type EmbeddedVideoTranscriptOutcome = "success" | "absent" | "transient_failure";

export type EmbeddedVideoTranscriptExtractionResult =
  | { outcome: "success"; transcript: EmbeddedVideoTranscript }
  | { outcome: "absent" | "transient_failure"; transcript?: never };

interface EmbeddedSubtitleCommandOptions {
  maxBufferBytes?: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

export type EmbeddedSubtitleCommandRunner = (
  executable: "ffmpeg",
  args: readonly string[],
  options: EmbeddedSubtitleCommandOptions
) => Promise<{ stdout: string; stderr: string }>;

/** Prefer caller-aligned text, then container subtitles, then optional STT output. */
export const VIDEO_TRANSCRIPT_SOURCE_PRIORITY: readonly VideoTranscriptSource[] = [
  "client",
  "embedded",
  "audio-bridge",
];

const RawVideoTranscriptCueSchema = z
  .object({
    confidence: z.number().optional(),
    end: z.number().optional(),
    endSeconds: z.number().optional(),
    source: z.enum(["audio-bridge", "client", "embedded"]),
    start: z.number().optional(),
    startSeconds: z.number().optional(),
    text: z.string().max(VIDEO_TRANSCRIPT_MAX_CUE_INPUT_CODE_UNITS),
  })
  .strict();

const RawVideoTranscriptCuesSchema = z
  .array(RawVideoTranscriptCueSchema)
  .max(VIDEO_TRANSCRIPT_MAX_CUES);

const RawVideoTranscriptSchema = z.union([
  RawVideoTranscriptCuesSchema,
  z.object({ cues: RawVideoTranscriptCuesSchema }).strict(),
]);

const SINGLE_UNICODE_WHITESPACE = /^\s$/u;
const SINGLE_UNICODE_LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;
const SINGLE_UNICODE_MARK = /^\p{M}$/u;
const SINGLE_UNICODE_PUNCTUATION_SYMBOL_OR_FORMAT = /^[\p{P}\p{S}\p{Cf}]$/u;

function sourceRank(source: VideoTranscriptSource): number {
  return VIDEO_TRANSCRIPT_SOURCE_PRIORITY.indexOf(source);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeCueText(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length > VIDEO_TRANSCRIPT_MAX_CUE_INPUT_CODE_UNITS) {
    throw new Error("Video transcript raw cue text budget exceeded");
  }
  if (value.includes("\0") || value.includes("\uFFFD") || !hasWellFormedUnicode(value)) {
    throw new Error("Invalid video transcript text encoding");
  }
  let text = "";
  let pendingSpace = false;
  for (const character of value.normalize("NFC")) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl =
      (codePoint >= 0x01 && codePoint <= 0x08) ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f);
    if (isControl || SINGLE_UNICODE_WHITESPACE.test(character)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) text += " ";
    text += character;
    pendingSpace = false;
  }
  if (Buffer.byteLength(text, "utf8") > VIDEO_TRANSCRIPT_MAX_CUE_TEXT_BYTES) {
    throw new Error("Video transcript cue text budget exceeded");
  }
  return text;
}

/** Canonical text identity shared by transcript and downstream fusion reconciliation. */
export function normalizeVideoTranscriptTextIdentity(text: string): string {
  let identity = "";
  let hasLetterOrNumber = false;
  let markCanAttach = false;
  let pendingSpace = false;
  for (const character of text.normalize("NFKC").toLocaleLowerCase("en-US")) {
    if (
      SINGLE_UNICODE_PUNCTUATION_SYMBOL_OR_FORMAT.test(character) ||
      SINGLE_UNICODE_WHITESPACE.test(character)
    ) {
      pendingSpace = identity.length > 0;
      markCanAttach = false;
      continue;
    }
    if (SINGLE_UNICODE_MARK.test(character)) {
      if (markCanAttach) identity += character;
      continue;
    }
    if (pendingSpace) identity += " ";
    identity += character;
    if (SINGLE_UNICODE_LETTER_OR_NUMBER.test(character)) {
      hasLetterOrNumber = true;
      markCanAttach = true;
    } else {
      markCanAttach = false;
    }
    pendingSpace = false;
  }
  return hasLetterOrNumber ? identity : "";
}

function videoTranscriptCueDedupIdentity(text: string): string {
  const canonical = normalizeVideoTranscriptTextIdentity(text);
  return canonical ? `canonical:${canonical}` : `exact:${text}`;
}

function cuesOverlap(left: VideoTranscriptCue, right: VideoTranscriptCue): boolean {
  return (
    Math.min(left.endSeconds, right.endSeconds) > Math.max(left.startSeconds, right.startSeconds)
  );
}

function contributingSources(cue: VideoTranscriptCue): VideoTranscriptSource[] {
  return cue.sources?.length ? [...cue.sources] : [cue.source];
}

function cueContributions(cue: VideoTranscriptCue): VideoTranscriptContribution[] {
  return cue.contributions?.length
    ? cue.contributions.map((contribution) => ({ ...contribution }))
    : [
        {
          confidence: cue.confidence,
          endSeconds: cue.endSeconds,
          source: cue.source,
          startSeconds: cue.startSeconds,
        },
      ];
}

function mergeCueContributions(
  left: VideoTranscriptCue,
  right: VideoTranscriptCue
): VideoTranscriptContribution[] {
  const bySource = new Map<VideoTranscriptSource, VideoTranscriptContribution>();
  for (const contribution of [...cueContributions(left), ...cueContributions(right)]) {
    const existing = bySource.get(contribution.source);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, contribution.confidence);
      existing.endSeconds = Math.max(existing.endSeconds, contribution.endSeconds);
      existing.startSeconds = Math.min(existing.startSeconds, contribution.startSeconds);
    } else {
      bySource.set(contribution.source, { ...contribution });
    }
  }
  return [...bySource.values()].sort(
    (leftContribution, rightContribution) =>
      sourceRank(leftContribution.source) - sourceRank(rightContribution.source)
  );
}

function cloneCue(cue: VideoTranscriptCue): VideoTranscriptCue {
  return {
    ...cue,
    ...(cue.contributions
      ? { contributions: cue.contributions.map((contribution) => ({ ...contribution })) }
      : {}),
    ...(cue.sources ? { sources: [...cue.sources] } : {}),
  };
}

function normalizeCueInterval(
  startSeconds: number,
  endSeconds: number,
  durationSeconds: number
): { endSeconds: number; startSeconds: number } {
  const clampToDuration = (value: number): number => Math.max(0, Math.min(durationSeconds, value));
  let normalizedStart = clampToDuration(Math.round(startSeconds * 1000) / 1000);
  let normalizedEnd = clampToDuration(Math.round(endSeconds * 1000) / 1000);
  if (normalizedEnd <= normalizedStart) {
    // Preserve a valid sub-millisecond cue by expanding outward to the nearest
    // representable millisecond, while the duration clamp remains authoritative.
    normalizedStart = clampToDuration(Math.floor(startSeconds * 1000) / 1000);
    normalizedEnd = clampToDuration(Math.ceil(endSeconds * 1000) / 1000);
  }
  if (normalizedEnd <= normalizedStart || normalizedEnd > durationSeconds) {
    throw new Error("Invalid video transcript timestamp after normalization");
  }
  return { endSeconds: normalizedEnd, startSeconds: normalizedStart };
}

function sortCues(cues: VideoTranscriptCue[]): VideoTranscriptCue[] {
  return cues.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      left.endSeconds - right.endSeconds ||
      sourceRank(left.source) - sourceRank(right.source) ||
      compareCodeUnits(left.text, right.text)
  );
}

function applyCombinedBudget(cues: VideoTranscriptCue[]): VideoTranscriptCue[] {
  const selected: VideoTranscriptCue[] = [];
  let totalTextBytes = 0;
  const byPriority = [...cues].sort(
    (left, right) =>
      sourceRank(left.source) - sourceRank(right.source) ||
      left.startSeconds - right.startSeconds ||
      left.endSeconds - right.endSeconds ||
      compareCodeUnits(left.text, right.text)
  );
  for (const cue of byPriority) {
    const cueBytes = Buffer.byteLength(cue.text, "utf8");
    if (
      selected.length >= VIDEO_TRANSCRIPT_MAX_CUES ||
      totalTextBytes + cueBytes > VIDEO_TRANSCRIPT_MAX_TOTAL_TEXT_BYTES
    ) {
      continue;
    }
    selected.push(cue);
    totalTextBytes += cueBytes;
  }
  return sortCues(selected);
}

/** Keep only positive-overlap cues and clamp them to a resolved focus window. */
export function scopeVideoTranscriptCues(
  cues: readonly VideoTranscriptCue[],
  focusWindow: { endSeconds: number; startSeconds: number } | null
): VideoTranscriptCue[] {
  if (!focusWindow) return cues.map(cloneCue);
  if (
    !Number.isFinite(focusWindow.startSeconds) ||
    !Number.isFinite(focusWindow.endSeconds) ||
    focusWindow.startSeconds < 0 ||
    focusWindow.endSeconds <= focusWindow.startSeconds
  ) {
    throw new Error("Invalid video transcript focus window");
  }
  return cues
    .filter(
      (cue) =>
        cue.endSeconds > focusWindow.startSeconds && cue.startSeconds < focusWindow.endSeconds
    )
    .map((cue) => ({
      ...cloneCue(cue),
      endSeconds: Math.min(cue.endSeconds, focusWindow.endSeconds),
      startSeconds: Math.max(cue.startSeconds, focusWindow.startSeconds),
    }));
}

/**
 * Reconcile transcript tracks conservatively on text identity plus temporal overlap.
 *
 * A duplicate keeps the highest-priority source's wording, expands to the union of
 * both intervals, and records every contributing provenance. Repeated text at a
 * disjoint point in the timeline remains a separate cue.
 */
export function mergeVideoTranscriptCues(
  ...tracks: ReadonlyArray<readonly VideoTranscriptCue[]>
): VideoTranscriptCue[] {
  const merged: VideoTranscriptCue[] = [];
  for (const cue of sortCues(tracks.flatMap((track) => [...track]))) {
    const identity = videoTranscriptCueDedupIdentity(cue.text);
    const duplicate = merged.find(
      (candidate) =>
        videoTranscriptCueDedupIdentity(candidate.text) === identity && cuesOverlap(candidate, cue)
    );
    if (!duplicate) {
      merged.push(cloneCue(cue));
      continue;
    }

    const duplicateRank = sourceRank(duplicate.source);
    const incomingRank = sourceRank(cue.source);
    const preferred = incomingRank < duplicateRank ? cue : duplicate;
    const sources = [
      ...new Set([...contributingSources(duplicate), ...contributingSources(cue)]),
    ].sort((left, right) => sourceRank(left) - sourceRank(right));
    const contributions = mergeCueContributions(duplicate, cue);
    duplicate.confidence = Math.max(duplicate.confidence, cue.confidence);
    duplicate.endSeconds = Math.max(duplicate.endSeconds, cue.endSeconds);
    duplicate.source = preferred.source;
    duplicate.startSeconds = Math.min(duplicate.startSeconds, cue.startSeconds);
    duplicate.text = preferred.text;
    if (sources.length > 1) {
      duplicate.contributions = contributions;
      duplicate.sources = sources;
    } else {
      delete duplicate.contributions;
      delete duplicate.sources;
    }
  }
  return applyCombinedBudget(merged);
}

/** Validate explicit transcript metadata without invoking a transcription provider. */
export function normalizeVideoTranscript(
  value: unknown,
  durationSeconds: number,
  expectedSource?: VideoTranscriptSource
): VideoTranscriptCue[] {
  if (value === undefined || value === null) return [];
  const unvalidatedCues = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).cues
      : null;
  if (Array.isArray(unvalidatedCues) && unvalidatedCues.length > VIDEO_TRANSCRIPT_MAX_CUES) {
    throw new Error("Video transcript cue budget exceeded");
  }
  const parsed = RawVideoTranscriptSchema.safeParse(value);
  if (!parsed.success) {
    const textBudgetExceeded = parsed.error.issues.some(
      (issue) => issue.code === "too_big" && issue.path.at(-1) === "text"
    );
    if (textBudgetExceeded) throw new Error("Video transcript cue text budget exceeded");
    const cueBudgetExceeded = parsed.error.issues.some((issue) => issue.code === "too_big");
    if (cueBudgetExceeded) throw new Error("Video transcript cue budget exceeded");
    throw new Error("Invalid video transcript source or strict cue shape");
  }
  const rawCues = Array.isArray(parsed.data) ? parsed.data : parsed.data.cues;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Invalid video transcript duration");
  }

  const normalized: VideoTranscriptCue[] = [];
  let totalTextBytes = 0;
  for (const cue of rawCues) {
    const text = normalizeCueText(cue.text);
    const source = cue.source;
    const startSeconds =
      typeof cue.startSeconds === "number"
        ? cue.startSeconds
        : typeof cue.start === "number"
          ? cue.start
          : Number.NaN;
    const endSeconds =
      typeof cue.endSeconds === "number"
        ? cue.endSeconds
        : typeof cue.end === "number"
          ? cue.end
          : Number.NaN;
    const confidence = cue.confidence === undefined ? 1 : cue.confidence;
    if (!text) {
      throw new Error("Invalid video transcript source or provenance");
    }
    if (expectedSource && source !== expectedSource) {
      throw new Error(`Invalid video transcript: expected ${expectedSource} provenance`);
    }
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      startSeconds < 0 ||
      endSeconds > durationSeconds ||
      endSeconds <= startSeconds
    ) {
      throw new Error("Invalid video transcript timestamp or confidence range");
    }
    const normalizedInterval = normalizeCueInterval(startSeconds, endSeconds, durationSeconds);
    totalTextBytes += Buffer.byteLength(text, "utf8");
    if (totalTextBytes > VIDEO_TRANSCRIPT_MAX_TOTAL_TEXT_BYTES) {
      throw new Error("Video transcript total text budget exceeded");
    }
    normalized.push({
      confidence,
      endSeconds: normalizedInterval.endSeconds,
      source,
      startSeconds: normalizedInterval.startSeconds,
      text,
    });
  }
  return mergeVideoTranscriptCues(normalized);
}

/** Produce a cache-safe identity without exposing cue text. */
export function fingerprintVideoTranscriptCues(cues: readonly VideoTranscriptCue[]): string {
  const canonical = sortCues(cues.map(cloneCue)).map((cue) => ({
    confidence: cue.confidence,
    contributions: cue.contributions
      ? [...cue.contributions].sort(
          (left, right) =>
            sourceRank(left.source) - sourceRank(right.source) ||
            left.startSeconds - right.startSeconds ||
            left.endSeconds - right.endSeconds ||
            left.confidence - right.confidence
        )
      : null,
    endSeconds: cue.endSeconds,
    source: cue.source,
    sources: cue.sources
      ? [...cue.sources].sort((left, right) => sourceRank(left) - sourceRank(right))
      : null,
    startSeconds: cue.startSeconds,
    text: cue.text,
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function parseBoundedUnsignedInteger(value: string, exactLength?: number): number {
  if (!value || (exactLength !== undefined && value.length !== exactLength)) return Number.NaN;
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return Number.NaN;
    result = result * 10 + code - 0x30;
    if (!Number.isSafeInteger(result)) return Number.NaN;
  }
  return result;
}

function parseWebVttTimestamp(value: string): number {
  if (value.length > VIDEO_EMBEDDED_SUBTITLE_MAX_TIMESTAMP_CODE_UNITS) {
    throw new Error("Embedded video subtitle timestamp budget exceeded");
  }
  const segments = value.split(":");
  if (segments.length !== 2 && segments.length !== 3) return Number.NaN;
  const secondsParts = segments.at(-1)?.split(".") ?? [];
  if (secondsParts.length !== 2) return Number.NaN;
  const hours = segments.length === 3 ? parseBoundedUnsignedInteger(segments[0]) : 0;
  const minutes = parseBoundedUnsignedInteger(segments.at(-2) ?? "", 2);
  const seconds = parseBoundedUnsignedInteger(secondsParts[0], 2);
  const milliseconds = parseBoundedUnsignedInteger(secondsParts[1], 3);
  if (segments.length === 3 && segments[0].length < 2) return Number.NaN;
  if (![hours, minutes, seconds, milliseconds].every(Number.isFinite)) return Number.NaN;
  if (minutes > 59 || seconds > 59) return Number.NaN;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function isWebVttMetadataBlock(line: string): boolean {
  return ["NOTE", "STYLE", "REGION"].some(
    (prefix) =>
      line === prefix ||
      (line.startsWith(prefix) && (line[prefix.length] === " " || line[prefix.length] === "\t"))
  );
}

function firstWhitespaceIndex(value: string): number {
  let offset = 0;
  for (const character of value) {
    if (SINGLE_UNICODE_WHITESPACE.test(character)) return offset;
    offset += character.length;
  }
  return -1;
}

function parseWebVttTimingLine(line: string): { end: string; start: string } | null {
  const arrowIndex = line.indexOf("-->");
  if (arrowIndex < 1 || line.indexOf("-->", arrowIndex + 3) !== -1) return null;
  if (
    !SINGLE_UNICODE_WHITESPACE.test(line[arrowIndex - 1]) ||
    !SINGLE_UNICODE_WHITESPACE.test(line[arrowIndex + 3] ?? "")
  ) {
    return null;
  }
  const start = line.slice(0, arrowIndex).trim();
  const remainder = line.slice(arrowIndex + 3).trimStart();
  const separatorIndex = firstWhitespaceIndex(remainder);
  const end = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex);
  if (!start || !end || firstWhitespaceIndex(start) !== -1) return null;
  return { end, start };
}

function sanitizeWebVttCueText(lines: readonly string[]): string {
  return lines
    .join(" ")
    .replace(/<[^>\n]{0,128}>/g, " ")
    .replace(/&lrm;|&rlm;|&nbsp;/gi, " ");
}

/** Parse the bounded UTF-8 WebVTT representation produced by the local FFmpeg process. */
export function parseEmbeddedSubtitleWebVtt(
  output: string,
  durationSeconds: number
): VideoTranscriptCue[] {
  if (
    Buffer.byteLength(output, "utf8") > VIDEO_EMBEDDED_SUBTITLE_MAX_OUTPUT_BYTES ||
    output.includes("\0") ||
    output.includes("\uFFFD")
  ) {
    throw new Error("Embedded video subtitle output or encoding is invalid");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Embedded video subtitle duration is invalid");
  }
  const lines = output
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  if (lines.some((line) => line.length > VIDEO_EMBEDDED_SUBTITLE_MAX_LINE_CODE_UNITS)) {
    throw new Error("Embedded video subtitle line budget exceeded");
  }
  if (lines[0]?.trim() !== "WEBVTT") {
    throw new Error("Embedded video subtitle output is not WebVTT");
  }

  const rawCues: Array<Record<string, unknown>> = [];
  let index = 1;
  while (index < lines.length) {
    while (index < lines.length && lines[index].trim() === "") index += 1;
    if (index >= lines.length) break;
    if (isWebVttMetadataBlock(lines[index])) {
      while (index < lines.length && lines[index].trim() !== "") index += 1;
      continue;
    }

    if (!lines[index].includes("-->")) index += 1;
    const timing = lines[index] ?? "";
    const parsedTiming = parseWebVttTimingLine(timing.trim());
    if (!parsedTiming) throw new Error("Embedded video subtitle cue timing is invalid");
    index += 1;
    const textLines: string[] = [];
    while (index < lines.length && lines[index].trim() !== "") {
      textLines.push(lines[index]);
      index += 1;
    }
    const startSeconds = parseWebVttTimestamp(parsedTiming.start);
    const endSeconds = parseWebVttTimestamp(parsedTiming.end);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      throw new Error("Embedded video subtitle cue timestamp is invalid");
    }
    const normalizedStart = Math.max(0, Math.min(durationSeconds, startSeconds));
    const normalizedEnd = Math.max(0, Math.min(durationSeconds, endSeconds));
    if (normalizedEnd <= normalizedStart) {
      throw new Error("Embedded video subtitle cue interval is invalid");
    }
    rawCues.push({
      confidence: 1,
      endSeconds: normalizedEnd,
      source: "embedded",
      startSeconds: normalizedStart,
      text: sanitizeWebVttCueText(textLines),
    });
  }
  return normalizeVideoTranscript({ cues: rawCues }, durationSeconds, "embedded");
}

/**
 * Derive one bounded embedded text-subtitle track from an already validated local video file.
 * Unsupported, malformed, timed-out, or undecodable tracks fail open to the next candidate.
 */
export async function extractEmbeddedVideoTranscript(
  inputPath: string,
  options: {
    durationSeconds: number;
    formatWhitelist: string;
    now?: () => number;
    runner: EmbeddedSubtitleCommandRunner;
    signal?: AbortSignal;
    streams: readonly VideoEmbeddedSubtitleStream[];
    timeoutMs: number;
  }
): Promise<EmbeddedVideoTranscriptExtractionResult> {
  if (!isAbsolute(inputPath) || inputPath.includes("\0") || inputPath.includes("://")) {
    throw new Error("Embedded video subtitle extraction requires a local path");
  }
  if (!/^[a-z0-9_,]{1,512}$/.test(options.formatWhitelist)) {
    throw new Error("Embedded video subtitle extraction requires a fixed format whitelist");
  }
  if (options.signal?.aborted) throw new Error("Video subtitle extraction request aborted");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("Embedded video subtitle extraction timeout is invalid");
  }
  const now = options.now ?? Date.now;
  const totalTimeoutMs = Math.max(
    1,
    Math.min(options.timeoutMs, VIDEO_EMBEDDED_SUBTITLE_TIMEOUT_MS)
  );
  const startedAtMs = now();
  if (!Number.isFinite(startedAtMs)) {
    throw new Error("Embedded video subtitle extraction clock is invalid");
  }
  const deadlineMs = startedAtMs + totalTimeoutMs;
  const candidates = selectEmbeddedSubtitleCandidates(options.streams);
  let transientFailure = false;
  for (const stream of candidates) {
    const remainingMs = Math.min(totalTimeoutMs, Math.floor(deadlineMs - now()));
    if (!Number.isFinite(remainingMs) || remainingMs < 1) {
      transientFailure = true;
      break;
    }
    try {
      const transcript = await extractEmbeddedSubtitleCandidate(inputPath, stream, {
        durationSeconds: options.durationSeconds,
        formatWhitelist: options.formatWhitelist,
        runner: options.runner,
        signal: options.signal,
        timeoutMs: remainingMs,
      });
      if (transcript) return { outcome: "success", transcript };
    } catch {
      if (options.signal?.aborted) throw new Error("Video subtitle extraction request aborted");
      transientFailure = true;
      // Embedded text is optional. A bad/unsupported stream must not discard valid video frames.
    }
  }
  return { outcome: transientFailure ? "transient_failure" : "absent" };
}

function selectEmbeddedSubtitleCandidates(
  streams: readonly VideoEmbeddedSubtitleStream[]
): VideoEmbeddedSubtitleStream[] {
  return [...streams]
    .filter(
      (stream) =>
        typeof stream.default === "boolean" &&
        VIDEO_EMBEDDED_SUBTITLE_CODECS.includes(stream.codecName) &&
        Number.isSafeInteger(stream.streamIndex) &&
        stream.streamIndex >= 0
    )
    .sort(
      (left, right) =>
        Number(right.default) - Number(left.default) || left.streamIndex - right.streamIndex
    )
    .slice(0, VIDEO_EMBEDDED_SUBTITLE_MAX_STREAM_ATTEMPTS);
}

async function extractEmbeddedSubtitleCandidate(
  inputPath: string,
  stream: VideoEmbeddedSubtitleStream,
  options: {
    durationSeconds: number;
    formatWhitelist: string;
    runner: EmbeddedSubtitleCommandRunner;
    signal?: AbortSignal;
    timeoutMs: number;
  }
): Promise<EmbeddedVideoTranscript | undefined> {
  const result = await options.runner(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      options.formatWhitelist,
      "-threads",
      "1",
      "-i",
      inputPath,
      "-map",
      `0:${stream.streamIndex}`,
      "-vn",
      "-an",
      "-dn",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "-",
    ],
    {
      maxBufferBytes: VIDEO_EMBEDDED_SUBTITLE_MAX_OUTPUT_BYTES,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }
  );
  if (options.signal?.aborted) throw new Error("Video subtitle extraction request aborted");
  const cues = parseEmbeddedSubtitleWebVtt(result.stdout, options.durationSeconds);
  return cues.length > 0 ? { cues, fingerprint: fingerprintVideoTranscriptCues(cues) } : undefined;
}
