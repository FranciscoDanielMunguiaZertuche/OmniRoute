import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

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
export const VIDEO_TRANSCRIPT_MAX_TOTAL_TEXT_BYTES = 64 * 1024;
export const VIDEO_EMBEDDED_SUBTITLE_MAX_OUTPUT_BYTES = 256 * 1024;
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

const VIDEO_TRANSCRIPT_SOURCES: ReadonlySet<VideoTranscriptSource> = new Set(
  VIDEO_TRANSCRIPT_SOURCE_PRIORITY
);

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
  if (value.includes("\0") || value.includes("\uFFFD") || !hasWellFormedUnicode(value)) {
    throw new Error("Invalid video transcript text encoding");
  }
  const text = value
    .normalize("NFC")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (Buffer.byteLength(text, "utf8") > VIDEO_TRANSCRIPT_MAX_CUE_TEXT_BYTES) {
    throw new Error("Video transcript cue text budget exceeded");
  }
  return text;
}

/** Canonical text identity shared by transcript and downstream fusion reconciliation. */
export function normalizeVideoTranscriptTextIdentity(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    const identity = normalizeVideoTranscriptTextIdentity(cue.text);
    const duplicate = merged.find(
      (candidate) =>
        normalizeVideoTranscriptTextIdentity(candidate.text) === identity &&
        cuesOverlap(candidate, cue)
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
  const rawCues = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).cues)
      ? (value as Record<string, unknown>).cues
      : null;
  if (!rawCues) throw new Error("Invalid video transcript: expected a cues array");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Invalid video transcript duration");
  }
  if (rawCues.length > VIDEO_TRANSCRIPT_MAX_CUES) {
    throw new Error("Video transcript cue budget exceeded");
  }

  const normalized: VideoTranscriptCue[] = [];
  let totalTextBytes = 0;
  for (const cue of rawCues) {
    if (!cue || typeof cue !== "object") throw new Error("Invalid video transcript cue");
    const record = cue as Record<string, unknown>;
    const text = normalizeCueText(record.text);
    const source = record.source;
    const startSeconds =
      typeof record.startSeconds === "number"
        ? record.startSeconds
        : typeof record.start === "number"
          ? record.start
          : Number.NaN;
    const endSeconds =
      typeof record.endSeconds === "number"
        ? record.endSeconds
        : typeof record.end === "number"
          ? record.end
          : Number.NaN;
    const confidence = record.confidence === undefined ? 1 : record.confidence;
    if (
      !text ||
      typeof source !== "string" ||
      !VIDEO_TRANSCRIPT_SOURCES.has(source as VideoTranscriptSource)
    ) {
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
      source: source as VideoTranscriptSource,
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

function parseWebVttTimestamp(value: string): number {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) return Number.NaN;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) return Number.NaN;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
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
  if (lines[0]?.trim() !== "WEBVTT") {
    throw new Error("Embedded video subtitle output is not WebVTT");
  }

  const rawCues: Array<Record<string, unknown>> = [];
  let index = 1;
  while (index < lines.length) {
    while (index < lines.length && lines[index].trim() === "") index += 1;
    if (index >= lines.length) break;
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[index])) {
      while (index < lines.length && lines[index].trim() !== "") index += 1;
      continue;
    }

    if (!lines[index].includes("-->")) index += 1;
    const timing = lines[index] ?? "";
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(timing.trim());
    if (!match) throw new Error("Embedded video subtitle cue timing is invalid");
    index += 1;
    const textLines: string[] = [];
    while (index < lines.length && lines[index].trim() !== "") {
      textLines.push(lines[index]);
      index += 1;
    }
    const startSeconds = parseWebVttTimestamp(match[1]);
    const endSeconds = parseWebVttTimestamp(match[2]);
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
): Promise<EmbeddedVideoTranscript | undefined> {
  if (!isAbsolute(inputPath) || inputPath.includes("\0") || inputPath.includes("://")) {
    throw new Error("Embedded video subtitle extraction requires a local path");
  }
  if (
    !options.formatWhitelist ||
    options.formatWhitelist.length > 512 ||
    !/^[a-z0-9_,]+$/.test(options.formatWhitelist)
  ) {
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
  for (const stream of candidates) {
    const remainingMs = Math.min(totalTimeoutMs, Math.floor(deadlineMs - now()));
    if (!Number.isFinite(remainingMs) || remainingMs < 1) break;
    try {
      const transcript = await extractEmbeddedSubtitleCandidate(inputPath, stream, {
        durationSeconds: options.durationSeconds,
        formatWhitelist: options.formatWhitelist,
        runner: options.runner,
        signal: options.signal,
        timeoutMs: remainingMs,
      });
      if (transcript) return transcript;
    } catch {
      if (options.signal?.aborted) throw new Error("Video subtitle extraction request aborted");
      // Embedded text is optional. A bad/unsupported stream must not discard valid video frames.
    }
  }
  return undefined;
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
