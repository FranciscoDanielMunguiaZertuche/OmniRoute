import { z } from "zod";

const SAFE_VIDEO_FORMATS = new Set([
  "3g2",
  "3gp",
  "avi",
  "flac",
  "flv",
  "m4a",
  "matroska",
  "mj2",
  "mov",
  "mp4",
  "ogg",
  "webm",
]);

const FfprobeDispositionSchema = z
  .object({
    attached_pic: z.union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")]).optional(),
    default: z.union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")]).optional(),
  })
  .strict();

const FfprobeStreamSchema = z
  .object({
    codec_name: z.string().optional(),
    codec_type: z.string().optional(),
    disposition: FfprobeDispositionSchema.optional(),
    height: z.number().optional(),
    index: z.number().optional(),
    width: z.number().optional(),
  })
  .strict();

const FfprobeEnvelopeSectionsSchema = z.array(z.record(z.string(), z.unknown())).max(64);

const FfprobeResultSchema = z
  .object({
    format: z
      .object({
        duration: z.string().optional(),
        format_name: z.string().optional(),
      })
      .strict()
      .optional(),
    programs: FfprobeEnvelopeSectionsSchema.optional(),
    stream_groups: FfprobeEnvelopeSectionsSchema.optional(),
    streams: z.array(FfprobeStreamSchema).optional(),
  })
  .strict();

export const SAFE_VIDEO_FORMAT_WHITELIST = [...SAFE_VIDEO_FORMATS].join(",");

export interface ParsedVideoProbeStream {
  attachedPicture: boolean;
  codecName?: string;
  codecType?: string;
  default: boolean;
  height?: number;
  index?: number;
  width?: number;
}

export interface ParsedVideoProbeMetadata {
  durationSeconds: number;
  formatName: string;
  streams: ParsedVideoProbeStream[];
}

function isDispositionEnabled(value: 0 | 1 | "0" | "1" | undefined): boolean {
  return value === 1 || value === "1";
}

export function parseVideoProbeMetadata(stdout: string): ParsedVideoProbeMetadata {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch {
    throw new Error("Video runtime returned invalid duration metadata");
  }

  const validated = FfprobeResultSchema.safeParse(parsedJson);
  if (!validated.success) {
    if (validated.error.issues.some((issue) => issue.path[0] === "streams")) {
      throw new Error("Video runtime returned invalid stream metadata");
    }
    if (!validated.error.issues.some((issue) => issue.path[0] === "format")) {
      throw new Error("Video runtime returned invalid ffprobe metadata");
    }
    throw new Error("Video runtime returned invalid duration metadata");
  }

  const durationSeconds = Number(validated.data.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Video runtime returned invalid duration metadata");
  }

  return {
    durationSeconds,
    formatName: validated.data.format?.format_name ?? "",
    streams: (validated.data.streams ?? []).map((stream) => ({
      attachedPicture: isDispositionEnabled(stream.disposition?.attached_pic),
      codecName: stream.codec_name,
      codecType: stream.codec_type,
      default: isDispositionEnabled(stream.disposition?.default),
      height: stream.height,
      index: stream.index,
      width: stream.width,
    })),
  };
}

export function assertVideoContainerFormatAllowed(formatName: string): void {
  const formats = formatName
    .toLowerCase()
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (formats.length === 0 || formats.some((entry) => !SAFE_VIDEO_FORMATS.has(entry))) {
    throw new Error("Video container format is not allowed");
  }
}
