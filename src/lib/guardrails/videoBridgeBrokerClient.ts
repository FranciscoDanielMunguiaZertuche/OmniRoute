import { z } from "zod";

import {
  fetchModelSyncInternal,
  resolveModelSyncInternalBaseUrl,
} from "@/shared/services/modelSyncScheduler";

import {
  VIDEO_BRIDGE_BROKER_PATH,
  buildVideoBridgeBrokerHeaders,
  isVideoBridgeBrokerInternalRequest,
} from "./videoBridgeBrokerAuth";
import type {
  VideoFocusBounds,
  VideoSamplingMetadata,
  VideoSamplingPolicy,
} from "./videoBridgeRuntime";
import {
  fingerprintVideoTranscriptCues,
  normalizeVideoTranscript,
  VIDEO_TRANSCRIPT_MAX_CUES,
  type EmbeddedVideoTranscript,
  type EmbeddedVideoTranscriptOutcome,
} from "./videoBridgeTranscript";

export {
  VIDEO_BRIDGE_BROKER_PATH,
  buildVideoBridgeBrokerHeaders,
  isVideoBridgeBrokerInternalRequest,
};

export interface BrokerExtractedFrame {
  dataUri: string;
  timestampSeconds: number;
}

export interface BrokerExtractionResult {
  durationSeconds: number;
  embeddedTranscript?: EmbeddedVideoTranscript;
  embeddedTranscriptOutcome?: EmbeddedVideoTranscriptOutcome;
  frames: BrokerExtractedFrame[];
  sampling?: VideoSamplingMetadata;
}

export interface BrokerExtractionOptions {
  frameCount: number;
  focusWindow?: VideoFocusBounds | null;
  samplingPolicy?: VideoSamplingPolicy;
  signal?: AbortSignal;
  timeoutMs: number;
}

const MAX_BROKER_RESPONSE_BYTES = 32 * 1024 * 1024;
const BROKER_JPEG_DATA_URI_PREFIX = "data:image/jpeg;base64,";

const BrokerFrameSchema = z
  .object({
    dataUri: z.string().max(MAX_BROKER_RESPONSE_BYTES),
    timestampSeconds: z.number(),
  })
  .strict();

const BrokerFocusWindowSchema = z
  .object({
    endSeconds: z.number(),
    startSeconds: z.number(),
  })
  .strict();

const BrokerSamplingSchema = z
  .object({
    candidateCount: z.number().int().nonnegative().optional(),
    focusWindow: BrokerFocusWindowSchema.optional(),
    policyEffective: z.enum(["uniform", "scene_aware", "segment_aware"]).optional(),
    policyRequested: z.enum(["uniform", "scene_aware", "segment_aware"]).optional(),
  })
  .strict();

const BrokerEmbeddedTranscriptSchema = z
  .object({
    cues: z.array(z.unknown()).min(1).max(VIDEO_TRANSCRIPT_MAX_CUES),
    fingerprint: z.string(),
  })
  .strict();

const BrokerExtractionResultSchema = z
  .object({
    durationSeconds: z.number(),
    embeddedTranscript: BrokerEmbeddedTranscriptSchema.optional(),
    embeddedTranscriptOutcome: z.enum(["success", "absent", "transient_failure"]).optional(),
    frames: z.array(BrokerFrameSchema),
    sampling: BrokerSamplingSchema.optional(),
  })
  .strict();

function isAsciiAlphaNumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function isCanonicalBase64(value: string): boolean {
  if (value.length < 4 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!isAsciiAlphaNumeric(code) && code !== 0x2b && code !== 0x2f) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function isBrokerJpegDataUri(value: string): boolean {
  return (
    value.startsWith(BROKER_JPEG_DATA_URI_PREFIX) &&
    isCanonicalBase64(value.slice(BROKER_JPEG_DATA_URI_PREFIX.length))
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolveVideoBridgeBrokerBaseUrl(_candidate?: string): string {
  return resolveModelSyncInternalBaseUrl();
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel("Video extraction broker response exceeded its byte limit");
    throw new Error("Video extraction broker response exceeded its byte limit");
  }
  if (!response.body) {
    throw new Error("Video extraction broker returned an invalid response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Video extraction broker response exceeded its byte limit");
        throw new Error("Video extraction broker response exceeded its byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes
  ).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Video extraction broker returned an invalid response");
  }
}

function parseBrokerResult(value: unknown, frameCount: number): BrokerExtractionResult {
  const rawRecord = isUnknownRecord(value) ? value : null;
  const rawFrames = rawRecord?.frames;
  if (Array.isArray(rawFrames) && (rawFrames.length < 1 || rawFrames.length > frameCount)) {
    throw new Error("Video extraction broker returned an invalid frame count");
  }
  const rawEmbeddedTranscript = isUnknownRecord(rawRecord?.embeddedTranscript)
    ? rawRecord.embeddedTranscript
    : null;
  const rawEmbeddedCues = rawEmbeddedTranscript?.cues;
  if (
    Array.isArray(rawEmbeddedCues) &&
    (rawEmbeddedCues.length < 1 || rawEmbeddedCues.length > VIDEO_TRANSCRIPT_MAX_CUES)
  ) {
    throw new Error("Video extraction broker returned an invalid embedded transcript");
  }
  const parsed = BrokerExtractionResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Video extraction broker returned invalid metadata");
  }
  const record = parsed.data;
  const durationSeconds = record.durationSeconds;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Video extraction broker returned invalid metadata");
  }
  if (record.frames.length < 1 || record.frames.length > frameCount) {
    throw new Error("Video extraction broker returned an invalid frame count");
  }
  let previousTimestampSeconds = Number.NEGATIVE_INFINITY;
  const frames = record.frames.map((entry) => {
    const timestampSeconds = entry.timestampSeconds;
    const dataUri = entry.dataUri;
    if (
      !Number.isFinite(timestampSeconds) ||
      timestampSeconds < 0 ||
      timestampSeconds > durationSeconds ||
      timestampSeconds < previousTimestampSeconds ||
      !isBrokerJpegDataUri(dataUri)
    ) {
      throw new Error("Video extraction broker returned an invalid frame");
    }
    previousTimestampSeconds = timestampSeconds;
    return { dataUri, timestampSeconds };
  });
  const samplingRecord = record.sampling ?? {};
  const policyRequested = samplingRecord.policyRequested ?? "uniform";
  const policyEffective = samplingRecord.policyEffective ?? "uniform";
  const candidateCount = samplingRecord.candidateCount ?? 0;
  const focusWindow = samplingRecord.focusWindow;
  if (
    focusWindow &&
    (!Number.isFinite(focusWindow.startSeconds) ||
      !Number.isFinite(focusWindow.endSeconds) ||
      focusWindow.startSeconds < 0 ||
      focusWindow.endSeconds <= focusWindow.startSeconds ||
      focusWindow.endSeconds > durationSeconds)
  ) {
    throw new Error("Video extraction broker returned an invalid focus window");
  }
  let embeddedTranscript: EmbeddedVideoTranscript | undefined;
  if (record.embeddedTranscript !== undefined) {
    const transcript = record.embeddedTranscript;
    const cues = normalizeVideoTranscript({ cues: transcript.cues }, durationSeconds, "embedded");
    const fingerprint = fingerprintVideoTranscriptCues(cues);
    if (transcript.fingerprint !== fingerprint) {
      throw new Error("Video extraction broker returned invalid embedded transcript metadata");
    }
    embeddedTranscript = { cues, fingerprint };
  }
  const embeddedTranscriptOutcome = record.embeddedTranscriptOutcome;
  if (
    embeddedTranscriptOutcome !== undefined &&
    (embeddedTranscriptOutcome === "success") !== Boolean(embeddedTranscript)
  ) {
    throw new Error("Video extraction broker returned invalid embedded transcript outcome");
  }
  return {
    durationSeconds,
    ...(embeddedTranscript ? { embeddedTranscript } : {}),
    ...(embeddedTranscriptOutcome ? { embeddedTranscriptOutcome } : {}),
    frames,
    sampling: {
      candidateCount,
      ...(focusWindow ? { focusWindow } : {}),
      policyEffective,
      policyRequested,
    },
  };
}

export async function extractVideoFramesViaBroker(
  bytes: Uint8Array,
  options: BrokerExtractionOptions,
  dependencies: { fetchImpl?: typeof fetch; maxResponseBytes?: number } = {}
): Promise<BrokerExtractionResult> {
  if (options.signal?.aborted) throw new Error("Video extraction request aborted");
  const baseUrl = resolveVideoBridgeBrokerBaseUrl();
  const url = new URL(`${baseUrl}${VIDEO_BRIDGE_BROKER_PATH}`);
  url.searchParams.set("frames", String(options.frameCount));
  if (options.samplingPolicy && options.samplingPolicy !== "uniform") {
    url.searchParams.set("samplingPolicy", options.samplingPolicy);
  }
  if (options.focusWindow?.startSeconds !== undefined) {
    url.searchParams.set("start", String(options.focusWindow.startSeconds));
  }
  if (options.focusWindow?.endSeconds !== undefined) {
    url.searchParams.set("end", String(options.focusWindow.endSeconds));
  }
  const fetchImpl = dependencies.fetchImpl ?? fetchModelSyncInternal;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      body: Buffer.from(bytes),
      headers: {
        "Content-Type": "application/octet-stream",
        ...buildVideoBridgeBrokerHeaders(),
      },
      redirect: "error",
      signal,
    });
  } catch {
    if (signal.aborted) throw new Error("Video extraction request aborted");
    throw new Error("Video extraction broker is unavailable");
  }
  if (!response.ok) {
    throw new Error(`Video extraction broker failed (${response.status})`);
  }
  const maxResponseBytes = Math.min(
    MAX_BROKER_RESPONSE_BYTES,
    dependencies.maxResponseBytes ?? MAX_BROKER_RESPONSE_BYTES
  );
  return parseBrokerResult(
    await readBoundedResponse(response, maxResponseBytes),
    options.frameCount
  );
}
