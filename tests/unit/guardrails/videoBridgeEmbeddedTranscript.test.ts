import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { extractVideoFramesViaBroker } from "../../../src/lib/guardrails/videoBridgeBrokerClient.ts";
import {
  extractVideoFramesFromBytes,
  probeLocalVideo,
  type VideoCommandRunner,
} from "../../../src/lib/guardrails/videoBridgeRuntime.ts";
import {
  extractEmbeddedVideoTranscript,
  fingerprintVideoTranscriptCues,
  normalizeVideoTranscript,
  parseEmbeddedSubtitleWebVtt,
  VIDEO_EMBEDDED_SUBTITLE_MAX_OUTPUT_BYTES,
  VIDEO_EMBEDDED_SUBTITLE_TIMEOUT_MS,
  VIDEO_TRANSCRIPT_MAX_CUES,
  VIDEO_TRANSCRIPT_MAX_CUE_TEXT_BYTES,
  VIDEO_TRANSCRIPT_MAX_TOTAL_TEXT_BYTES,
} from "../../../src/lib/guardrails/videoBridgeTranscript.ts";

const execFileAsync = promisify(execFile);

test("derives timestamped embedded subtitles from a real deterministic FFmpeg fixture", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "video-embedded-subtitle-fixture-"));
  const subtitlePath = join(directory, "captions.srt");
  const videoPath = join(directory, "fixture.mkv");
  try {
    await writeFile(
      subtitlePath,
      [
        "1",
        "00:00:00,500 --> 00:00:01,750",
        "first embedded cue",
        "",
        "2",
        "00:00:02,000 --> 00:00:03,250",
        "second embedded cue",
        "",
      ].join("\n"),
      "utf8"
    );
    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=160x90:r=1:d=4",
          "-f",
          "srt",
          "-i",
          subtitlePath,
          "-map",
          "0:v:0",
          "-map",
          "1:s:0",
          "-c:v",
          "ffv1",
          "-c:s",
          "srt",
          "-t",
          "4",
          "-y",
          videoPath,
        ],
        { timeout: 20_000 }
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        t.skip("FFmpeg is optional and is not installed on this host");
        return;
      }
      throw error;
    }

    const extracted = await extractVideoFramesFromBytes(await readFile(videoPath), {
      frameCount: 1,
      maxDurationSeconds: 600,
      timeoutMs: 20_000,
    });

    assert.deepEqual(extracted.embeddedTranscript?.cues, [
      {
        confidence: 1,
        endSeconds: 1.75,
        source: "embedded",
        startSeconds: 0.5,
        text: "first embedded cue",
      },
      {
        confidence: 1,
        endSeconds: 3.25,
        source: "embedded",
        startSeconds: 2,
        text: "second embedded cue",
      },
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("normalizes overlapping WebVTT cues and clamps container rounding to the video duration", () => {
  const cues = parseEmbeddedSubtitleWebVtt(
    [
      "WEBVTT",
      "",
      "first-id",
      "00:00.100 --> 00:01.500",
      "<i>HELLO</i>",
      "",
      "00:01.400 --> 00:08.000 align:start",
      "hello!",
      "",
    ].join("\n"),
    3
  );

  assert.deepEqual(cues, [
    {
      confidence: 1,
      endSeconds: 3,
      source: "embedded",
      startSeconds: 0.1,
      text: "HELLO",
    },
  ]);
});

test("fractional-duration embedded cues survive millisecond normalization and broker round-trip", async () => {
  const durationSeconds = 1.0006;
  const cues = parseEmbeddedSubtitleWebVtt(
    "WEBVTT\n\n00:00.000 --> 00:02.000\nfractional duration cue\n",
    durationSeconds
  );
  const tinyCue = normalizeVideoTranscript(
    {
      cues: [
        {
          end: 0.00049,
          source: "embedded",
          start: 0.0004,
          text: "sub-millisecond cue",
        },
      ],
    },
    durationSeconds,
    "embedded"
  );

  assert.equal(cues[0].endSeconds, durationSeconds);
  assert.equal(tinyCue[0].endSeconds > tinyCue[0].startSeconds, true);

  const roundTripped = await extractVideoFramesViaBroker(
    Buffer.from("safe-video"),
    { frameCount: 1, timeoutMs: 5_000 },
    {
      fetchImpl: async () =>
        Response.json({
          durationSeconds,
          embeddedTranscript: {
            cues,
            fingerprint: fingerprintVideoTranscriptCues(cues),
          },
          frames: [{ timestampSeconds: 0.5, dataUri: "data:image/jpeg;base64,QQ==" }],
        }),
    }
  );

  assert.deepEqual(roundTripped.embeddedTranscript?.cues, cues);
});

test("rejects invalid subtitle encoding and enforces cue, per-text, and total-text budgets", () => {
  assert.throws(
    () => parseEmbeddedSubtitleWebVtt("WEBVTT\n\nnot a timing line\ntext\n", 2),
    /timing/i
  );
  assert.throws(
    () => parseEmbeddedSubtitleWebVtt("WEBVTT\n\n00:00.000 --> 00:01.000\nbad\uFFFDtext\n", 2),
    /encoding/i
  );
  for (const malformedText of ["high\ud800surrogate", "low\udc00surrogate", "terminal\ud800"]) {
    assert.throws(
      () =>
        normalizeVideoTranscript(
          {
            cues: [{ end: 1, source: "client", start: 0, text: malformedText }],
          },
          2,
          "client"
        ),
      /encoding/i
    );
  }
  assert.equal(
    normalizeVideoTranscript(
      {
        cues: [{ end: 1, source: "client", start: 0, text: "alpha\u009bbeta" }],
      },
      2,
      "client"
    )[0].text,
    "alpha beta"
  );
  assert.throws(
    () =>
      normalizeVideoTranscript(
        {
          cues: Array.from({ length: VIDEO_TRANSCRIPT_MAX_CUES + 1 }, (_unused, index) => ({
            end: index + 0.5,
            source: "client",
            start: index,
            text: `cue ${index}`,
          })),
        },
        VIDEO_TRANSCRIPT_MAX_CUES + 2,
        "client"
      ),
    /cue budget/i
  );
  assert.throws(
    () =>
      normalizeVideoTranscript(
        {
          cues: [
            {
              end: 1,
              source: "client",
              start: 0,
              text: "x".repeat(VIDEO_TRANSCRIPT_MAX_CUE_TEXT_BYTES + 1),
            },
          ],
        },
        2,
        "client"
      ),
    /cue text budget/i
  );
  const text = "x".repeat(1024);
  assert.throws(
    () =>
      normalizeVideoTranscript(
        {
          cues: Array.from(
            { length: VIDEO_TRANSCRIPT_MAX_TOTAL_TEXT_BYTES / text.length + 1 },
            (_unused, index) => ({
              end: index + 0.75,
              source: "client",
              start: index,
              text,
            })
          ),
        },
        100,
        "client"
      ),
    /total text budget/i
  );
});

test("bounds stream attempts and uses fixed local-only FFmpeg argv", async () => {
  const calls: Array<{ args: string[]; maxBufferBytes?: number; timeoutMs: number }> = [];
  const result = await extractEmbeddedVideoTranscript("/tmp/input.mkv", {
    durationSeconds: 5,
    formatWhitelist: "matroska,webm",
    runner: async (_executable, args, options) => {
      calls.push({
        args: [...args],
        maxBufferBytes: options.maxBufferBytes,
        timeoutMs: options.timeoutMs,
      });
      throw new Error("malformed or unsupported subtitle stream");
    },
    streams: [
      { codecName: "subrip", default: false, streamIndex: 5 },
      { codecName: "webvtt", default: true, streamIndex: 4 },
      { codecName: "mov_text", default: false, streamIndex: 3 },
    ],
    timeoutMs: 30_000,
  });

  assert.equal(result, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.args[call.args.indexOf("-map") + 1]),
    ["0:4", "0:3"]
  );
  assert.equal(
    calls.every(
      (call) =>
        call.args[call.args.indexOf("-protocol_whitelist") + 1] === "file" &&
        !call.args.some((argument) => argument.includes("://")) &&
        call.maxBufferBytes === VIDEO_EMBEDDED_SUBTITLE_MAX_OUTPUT_BYTES &&
        call.timeoutMs > 0 &&
        call.timeoutMs <= VIDEO_EMBEDDED_SUBTITLE_TIMEOUT_MS
    ),
    true
  );
});

test("shares one caller-bounded timeout budget across subtitle stream attempts", async () => {
  const timeouts: number[] = [];
  let clockMs = 100;
  const result = await extractEmbeddedVideoTranscript("/tmp/input.mkv", {
    durationSeconds: 5,
    formatWhitelist: "matroska,webm",
    now: () => clockMs,
    runner: async (_executable, _args, options) => {
      timeouts.push(options.timeoutMs);
      clockMs += 3_000;
      throw new Error("unsupported subtitle stream");
    },
    streams: [
      { codecName: "subrip", default: true, streamIndex: 1 },
      { codecName: "webvtt", default: false, streamIndex: 2 },
    ],
    timeoutMs: 5_000,
  });

  assert.equal(result, undefined);
  assert.deepEqual(timeouts, [5_000, 2_000]);
});

test("rejects malformed stream descriptors before constructing FFmpeg argv", async () => {
  let runnerCalls = 0;
  const result = await extractEmbeddedVideoTranscript("/tmp/input.mkv", {
    durationSeconds: 5,
    formatWhitelist: "matroska,webm",
    runner: async () => {
      runnerCalls += 1;
      throw new Error("must not run");
    },
    streams: [
      { codecName: "subrip", default: true, streamIndex: Number.NaN },
      { codecName: "ass", default: false, streamIndex: 1 },
    ] as never,
    timeoutMs: 5_000,
  });

  assert.equal(result, undefined);
  assert.equal(runnerCalls, 0);
});

test("a malformed preferred stream fails open to the next supported text stream", async () => {
  const attemptedMaps: string[] = [];
  const result = await extractEmbeddedVideoTranscript("/tmp/input.mkv", {
    durationSeconds: 5,
    formatWhitelist: "matroska,webm",
    runner: async (_executable, args) => {
      const streamMap = args[args.indexOf("-map") + 1];
      attemptedMaps.push(streamMap);
      return {
        stderr: "",
        stdout:
          streamMap === "0:1"
            ? "malformed subtitle output"
            : "WEBVTT\n\n00:01.000 --> 00:02.000\nvalid fallback cue\n",
      };
    },
    streams: [
      { codecName: "subrip", default: true, streamIndex: 1 },
      { codecName: "webvtt", default: false, streamIndex: 2 },
    ],
    timeoutMs: 5_000,
  });

  assert.deepEqual(attemptedMaps, ["0:1", "0:2"]);
  assert.equal(result?.cues[0].text, "valid fallback cue");
});

test("a missing or unsupported subtitle stream fails open without spawning a subtitle pass", async () => {
  let runnerCalls = 0;
  const absent = await extractEmbeddedVideoTranscript("/tmp/input.mp4", {
    durationSeconds: 5,
    formatWhitelist: "mp4",
    runner: async () => {
      runnerCalls += 1;
      throw new Error("must not run");
    },
    streams: [],
    timeoutMs: 5_000,
  });

  assert.equal(absent, undefined);
  assert.equal(runnerCalls, 0);
});

test("probe excludes unsupported subtitle codecs from the extraction candidate list", async () => {
  const runner: VideoCommandRunner = async (executable) => {
    assert.equal(executable, "ffprobe");
    return {
      stderr: "",
      stdout: JSON.stringify({
        format: { duration: "2", format_name: "matroska,webm" },
        streams: [
          { index: 0, codec_name: "ffv1", codec_type: "video", width: 160, height: 90 },
          { index: 1, codec_name: "ass", codec_type: "subtitle" },
        ],
      }),
    };
  };

  const metadata = await probeLocalVideo("/tmp/input.mkv", { runner });

  assert.deepEqual(metadata.subtitleStreams, []);
});

test("subtitle timeout fails open and the shared byte-extraction lifecycle removes temp files", async () => {
  let temporaryInput = "";
  const runner: VideoCommandRunner = async (executable, args) => {
    if (executable === "ffprobe") {
      temporaryInput = args.at(-1) ?? "";
      return {
        stderr: "",
        stdout: JSON.stringify({
          format: { duration: "2", format_name: "matroska,webm" },
          streams: [
            { index: 0, codec_name: "ffv1", codec_type: "video", width: 160, height: 90 },
            { index: 1, codec_name: "subrip", codec_type: "subtitle" },
          ],
        }),
      };
    }
    if (args.includes("-c:s"))
      throw Object.assign(new Error("subtitle timeout"), { code: "ETIMEDOUT" });
    await writeFile(args.at(-1) ?? "", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { stderr: "", stdout: "" };
  };

  const result = await extractVideoFramesFromBytes(Buffer.from("video"), {
    frameCount: 1,
    maxDurationSeconds: 600,
    runner,
    timeoutMs: 5_000,
  });

  assert.equal(result.frames.length, 1);
  assert.equal(result.embeddedTranscript, undefined);
  assert.notEqual(temporaryInput, "");
  await assert.rejects(() => access(temporaryInput));
});

test("subtitle abort rejects safely and still removes the shared private temporary tree", async () => {
  const controller = new AbortController();
  let temporaryInput = "";
  const runner: VideoCommandRunner = async (executable, args) => {
    if (executable === "ffprobe") {
      temporaryInput = args.at(-1) ?? "";
      return {
        stderr: "",
        stdout: JSON.stringify({
          format: { duration: "2", format_name: "matroska,webm" },
          streams: [
            { index: 0, codec_name: "ffv1", codec_type: "video", width: 160, height: 90 },
            { index: 1, codec_name: "subrip", codec_type: "subtitle" },
          ],
        }),
      };
    }
    if (args.includes("-c:s")) {
      controller.abort();
      throw new Error("private abort detail");
    }
    await writeFile(args.at(-1) ?? "", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { stderr: "", stdout: "" };
  };

  await assert.rejects(
    () =>
      extractVideoFramesFromBytes(Buffer.from("video"), {
        frameCount: 1,
        maxDurationSeconds: 600,
        runner,
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
    /subtitle extraction request aborted/i
  );
  assert.notEqual(temporaryInput, "");
  await assert.rejects(() => access(temporaryInput));
});
