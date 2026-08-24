import { createHash } from "node:crypto";

export const VIDEO_TRANSCRIPT_LOG_OMISSION_MARKER = "[omitted: video transcript]";
export const VIDEO_TRANSCRIPT_REDACTION_PIPELINE_KEY = "_omnirouteVideoTranscriptRedacted" as const;

const VIDEO_TRANSCRIPT_PAYLOAD_KEYS = new Set(["audioTranscript", "transcript"]);
const VIDEO_TRANSCRIPT_CARRIER_KEYS = new Set(["source", "video_url"]);
const VIDEO_BRIDGE_DESCRIPTION_PREFIX = "[Video description:";
const MAX_VIDEO_TRANSCRIPT_LOG_DEPTH = 8;
const SERIALIZED_VIDEO_TRANSCRIPT_CUE_RE =
  /(transcript\[source=(?:audio-bridge|client|embedded)[^\]\r\n]{0,1024}\]\s+text=)"(?:\\.|[^"\\])*"/g;
const VIDEO_TRANSCRIPT_CUE_PREFIX_RE =
  /transcript\[source=(?:audio-bridge|client|embedded)[^\]\r\n]{0,1024}\]\s+text=/;
const VIDEO_TRANSCRIPT_DESCRIPTION_FINGERPRINT_RE = /^sha256:([a-f0-9]{64}):(\d{1,8})$/;
const MAX_TRUSTED_DESCRIPTION_CODE_UNITS = 16 * 1024 * 1024;
const MAX_TRUSTED_DESCRIPTION_IDENTITIES = 64;
const MAX_TRUSTED_DESCRIPTION_HASH_CODE_UNITS = 64 * 1024 * 1024;
const MAX_TRUSTED_DESCRIPTION_PREFIX_OCCURRENCES = 128;
const MAX_TRUSTED_DESCRIPTION_CANDIDATE_HASHES = 512;

type JsonRecord = Record<string, unknown>;

export interface VideoTranscriptLogContext {
  /** Low-level compatibility seam; production request stages use exact fingerprints instead. */
  trustedDescriptionContext?: boolean;
  /** SHA-256 identities emitted only for descriptions produced by the Video Bridge guardrail. */
  trustedDescriptionFingerprints?: readonly string[];
}

export function fingerprintVideoTranscriptDescription(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}:${value.length}`;
}

/** Keep raw provider text transient while replacing every retained/logged copy. */
export function redactVideoTranscriptSensitiveText(value: string, sensitive: boolean): string {
  return sensitive ? VIDEO_TRANSCRIPT_LOG_OMISSION_MARKER : value;
}

type WalkFrame = {
  directCarrier: boolean;
  depth: number;
  value: object;
};

type CloneFrame = WalkFrame & {
  target: JsonRecord | unknown[];
};

type CloneMemo = {
  carrier?: JsonRecord | unknown[];
  ordinary?: JsonRecord | unknown[];
};

type TrustedDescriptionIdentity = {
  fingerprint: string;
  length: number;
};

type TrustedDescriptionRange = {
  end: number;
  start: number;
};

function parseTrustedDescriptionIdentity(value: unknown): TrustedDescriptionIdentity | null {
  if (typeof value !== "string") return null;
  const match = VIDEO_TRANSCRIPT_DESCRIPTION_FINGERPRINT_RE.exec(value);
  if (!match) return null;
  const length = Number(match[2]);
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_TRUSTED_DESCRIPTION_CODE_UNITS) {
    return null;
  }
  return { fingerprint: value, length };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Accept only identities emitted by a successful server-side Video Bridge rewrite. */
export function extractVideoTranscriptDescriptionFingerprints(results: unknown): string[] {
  if (!Array.isArray(results)) return [];
  const fingerprints = new Set<string>();
  for (const result of results) {
    if (!isJsonRecord(result) || result.guardrail !== "video-bridge" || result.modified !== true) {
      continue;
    }
    const meta = isJsonRecord(result.meta) ? result.meta : null;
    if (
      !meta ||
      typeof meta.transcriptCuesApplied !== "number" ||
      meta.transcriptCuesApplied <= 0 ||
      !Array.isArray(meta.videoTranscriptDescriptionFingerprints)
    ) {
      continue;
    }
    for (const fingerprint of meta.videoTranscriptDescriptionFingerprints) {
      const identity = parseTrustedDescriptionIdentity(fingerprint);
      if (identity) fingerprints.add(identity.fingerprint);
    }
  }
  return [...fingerprints].sort();
}

function urlFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isJsonRecord(value)) return undefined;
  return typeof value.url === "string" ? value.url : undefined;
}

function isRecognizedVideoPart(record: JsonRecord): boolean {
  const type = typeof record.type === "string" ? record.type : undefined;
  if (type === "input_video") {
    return Boolean(urlFrom(record.video_url ?? record.input_video ?? record.url));
  }
  if (type === "video_url") return Boolean(urlFrom(record.video_url));

  const source = isJsonRecord(record.source) ? record.source : undefined;
  if (!source) return false;
  const videoMediaType =
    typeof source.media_type === "string" && source.media_type.toLowerCase().startsWith("video/");
  // Keep this aligned with mediaParts.ts: empty base64 is malformed media, but still a
  // recognized video carrier whose transcript fields must never bypass log protection.
  if (videoMediaType && typeof source.data === "string") return true;
  const sourceUrl = urlFrom(source.url);
  return Boolean(
    sourceUrl &&
    ((type === "video" && source.type === "url") || type === "video_source" || videoMediaType)
  );
}

function findTrustedDescriptionRanges(
  value: string,
  context: VideoTranscriptLogContext | boolean
): TrustedDescriptionRange[] | null {
  if (!value.includes(VIDEO_BRIDGE_DESCRIPTION_PREFIX)) return [];
  if (typeof context === "boolean" ? context : context.trustedDescriptionContext === true) {
    return [{ end: value.length, start: 0 }];
  }

  const identities = (context as VideoTranscriptLogContext).trustedDescriptionFingerprints
    ?.map(parseTrustedDescriptionIdentity)
    .filter((identity): identity is TrustedDescriptionIdentity => identity !== null);
  if (!identities || identities.length === 0) return [];
  // A successful request can only produce a bounded number of video descriptions.
  // If internal metadata violates that contract, omit the whole retained string
  // rather than risk leaking a cue or performing attacker-amplified hashing.
  if (identities.length > MAX_TRUSTED_DESCRIPTION_IDENTITIES) return null;

  const ranges: TrustedDescriptionRange[] = [];
  let candidateHashes = 0;
  let hashBudget = 0;
  let prefixOccurrences = 0;
  let start = value.indexOf(VIDEO_BRIDGE_DESCRIPTION_PREFIX);
  while (start >= 0) {
    prefixOccurrences += 1;
    // Bound synchronous work independently of byte length: many tiny forged
    // prefixes would otherwise amplify hashing and block the event loop. A
    // retained copy fails closed while the live request remains untouched.
    if (prefixOccurrences > MAX_TRUSTED_DESCRIPTION_PREFIX_OCCURRENCES) return null;
    for (const identity of identities) {
      const end = start + identity.length;
      if (end > value.length) continue;
      candidateHashes += 1;
      if (candidateHashes > MAX_TRUSTED_DESCRIPTION_CANDIDATE_HASHES) return null;
      hashBudget += identity.length;
      if (hashBudget > MAX_TRUSTED_DESCRIPTION_HASH_CODE_UNITS) return null;
      const candidate = value.slice(start, end);
      if (fingerprintVideoTranscriptDescription(candidate) === identity.fingerprint) {
        ranges.push({ end, start });
      }
    }
    start = value.indexOf(VIDEO_BRIDGE_DESCRIPTION_PREFIX, start + 1);
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TrustedDescriptionRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function omitVideoTranscriptFromLogString(
  value: string,
  context: VideoTranscriptLogContext | boolean = false
): string {
  const ranges = findTrustedDescriptionRanges(value, context);
  if (ranges === null) return VIDEO_TRANSCRIPT_LOG_OMISSION_MARKER;
  if (ranges.length === 0) return value;
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += value.slice(cursor, range.start);
    result += value
      .slice(range.start, range.end)
      .replace(
        SERIALIZED_VIDEO_TRANSCRIPT_CUE_RE,
        (_match, prefix: string) =>
          `${prefix}${JSON.stringify(VIDEO_TRANSCRIPT_LOG_OMISSION_MARKER)}`
      );
    cursor = range.end;
  }
  return result + value.slice(cursor);
}

function fieldIsTranscript(key: string, carrier: boolean): boolean {
  return carrier && VIDEO_TRANSCRIPT_PAYLOAD_KEYS.has(key);
}

function childIsDirectCarrier(key: string, recognizedParent: boolean, value: unknown): boolean {
  return recognizedParent && VIDEO_TRANSCRIPT_CARRIER_KEYS.has(key) && isJsonRecord(value);
}

function walkContains(root: unknown, context: VideoTranscriptLogContext | boolean): boolean {
  const stack: Array<WalkFrame | { directCarrier: boolean; depth: number; value: string }> = [];
  if (typeof root === "string") stack.push({ directCarrier: false, depth: 0, value: root });
  else if (root && typeof root === "object" && !ArrayBuffer.isView(root)) {
    stack.push({ directCarrier: false, depth: 0, value: root });
  }
  const seen = new WeakMap<object, number>();

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (typeof frame.value === "string") {
      const stringValue = frame.value;
      const ranges = findTrustedDescriptionRanges(stringValue, context);
      if (ranges === null) return true;
      if (
        ranges.some((range) =>
          VIDEO_TRANSCRIPT_CUE_PREFIX_RE.test(stringValue.slice(range.start, range.end))
        )
      ) {
        return true;
      }
      continue;
    }
    if (frame.depth > MAX_VIDEO_TRANSCRIPT_LOG_DEPTH) continue;

    const record = Array.isArray(frame.value) ? null : (frame.value as JsonRecord);
    const recognized = record ? isRecognizedVideoPart(record) : false;
    const carrier = frame.directCarrier || recognized;
    const seenBit = carrier ? 2 : 1;
    const previousBits = seen.get(frame.value) ?? 0;
    if ((previousBits & seenBit) !== 0) continue;
    seen.set(frame.value, previousBits | seenBit);

    const entries = Array.isArray(frame.value)
      ? frame.value.map((value, index) => [String(index), value] as const)
      : Object.entries(record!);
    for (const [key, value] of entries) {
      if (fieldIsTranscript(key, carrier)) {
        return true;
      }
      if (typeof value === "string") {
        stack.push({
          directCarrier: fieldIsTranscript(key, carrier),
          depth: frame.depth + 1,
          value,
        });
      } else if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
        stack.push({
          directCarrier: childIsDirectCarrier(key, recognized, value),
          depth: frame.depth + 1,
          value,
        });
      }
    }
  }
  return false;
}

/** Detect transcript data only in recognized video carriers or a trusted bridge description. */
export function containsVideoTranscriptForLog(
  value: unknown,
  context: VideoTranscriptLogContext | boolean = {}
): boolean {
  return walkContains(value, context);
}

function prepareClone(
  value: unknown,
  depth: number,
  directCarrier: boolean,
  context: VideoTranscriptLogContext | boolean,
  memo: WeakMap<object, CloneMemo>
): { frame?: CloneFrame; value: unknown } {
  if (typeof value === "string") {
    return { value: omitVideoTranscriptFromLogString(value, context) };
  }
  if (!value || typeof value !== "object") return { value };
  if (ArrayBuffer.isView(value)) return { value: `[binary ${value.byteLength} bytes]` };
  if (depth > MAX_VIDEO_TRANSCRIPT_LOG_DEPTH) return { value: "[MaxDepth]" };

  const record = Array.isArray(value) ? null : (value as JsonRecord);
  const carrier = directCarrier || Boolean(record && isRecognizedVideoPart(record));
  const memoKey = carrier ? "carrier" : "ordinary";
  const previous = memo.get(value)?.[memoKey];
  if (previous) return { value: "[Circular]" };

  const target: JsonRecord | unknown[] = Array.isArray(value) ? [] : {};
  const entry = memo.get(value) ?? {};
  entry[memoKey] = target;
  memo.set(value, entry);
  return { frame: { directCarrier: carrier, depth, target, value }, value: target };
}

/** Remove Video Bridge source fields and trusted generated segments from a bounded log copy. */
export function omitVideoTranscriptForLog(
  payload: unknown,
  context: VideoTranscriptLogContext | boolean = {}
): unknown {
  const memo = new WeakMap<object, CloneMemo>();
  const prepared = prepareClone(payload, 0, false, context, memo);
  if (!prepared.frame) return prepared.value;
  const stack = [prepared.frame];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const sourceRecord = Array.isArray(frame.value) ? null : (frame.value as JsonRecord);
    const recognized = Boolean(sourceRecord && isRecognizedVideoPart(sourceRecord));
    const entries = Array.isArray(frame.value)
      ? frame.value.map((value, index) => [String(index), value] as const)
      : Object.entries(sourceRecord!);

    for (const [key, value] of entries) {
      const targetKey: string | number = Array.isArray(frame.target) ? Number(key) : key;
      if (fieldIsTranscript(key, frame.directCarrier)) {
        (frame.target as JsonRecord)[targetKey] = VIDEO_TRANSCRIPT_LOG_OMISSION_MARKER;
        continue;
      }
      const child = prepareClone(
        value,
        frame.depth + 1,
        childIsDirectCarrier(key, recognized, value),
        context,
        memo
      );
      (frame.target as JsonRecord)[targetKey] = child.value;
      if (child.frame) stack.push(child.frame);
    }
  }
  return prepared.value;
}
