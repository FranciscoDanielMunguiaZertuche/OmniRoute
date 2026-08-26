import assert from "node:assert/strict";
import test from "node:test";

import { VideoBridgeGuardrail } from "../../../src/lib/guardrails/videoBridge.ts";
import type { BridgeCacheEntry } from "../../../src/lib/guardrails/modalityBridge/bridgeCache.ts";
import { fingerprintVideoTranscriptDescription } from "../../../src/lib/guardrails/videoTranscriptLogRedaction.ts";

test("result cache records embedded transcript identity without retaining raw cue text in metadata", async () => {
  const entries = new Map<string, BridgeCacheEntry>();
  let storedKey = "";
  let storedEntry: BridgeCacheEntry | undefined;
  let describeCalls = 0;
  const embeddedCueText = "private embedded subtitle sentinel";
  const embeddedTranscriptFingerprint = `sha256:${"c".repeat(64)}`;
  const description =
    `[Video description: transcript[source=embedded;confidence=1.00;` +
    `interval=00:01.000-00:02.000] text=${JSON.stringify(embeddedCueText)}]`;
  const bridge = new VideoBridgeGuardrail({
    deps: {
      getSettings: async () => ({
        modalityBridgeCacheEnabled: true,
        modalityBridgeCacheMaxEntries: 10,
        modalityBridgeCacheTtlMinutes: 60,
        modalityBridgeVideoEnabled: true,
        modalityBridgeVideoModel: "openai/gpt-4o-mini",
        modalityBridgeVisionPrompt: "FU-05 embedded transcript cache identity",
      }),
      getCapabilities: () => ({ supportsVideo: false }),
      selectVisionModel: async () => "openai/gpt-4o-mini",
      resultCache: {
        delete: (key) => entries.delete(key),
        getEntry: (key) => entries.get(key),
        setEntry: (key, entry) => {
          storedKey = key;
          storedEntry = entry;
          entries.set(key, entry);
        },
      },
      describePart: async () => {
        describeCalls += 1;
        return {
          description,
          durationSeconds: 4,
          embeddedTranscriptCueCount: 1,
          embeddedTranscriptFingerprint,
          framesRequested: 1,
          framesUsed: 1,
          transcriptCues: [
            {
              confidence: 1,
              endSeconds: 2,
              source: "embedded" as const,
              startSeconds: 1,
              text: embeddedCueText,
            },
          ],
        };
      },
    },
  });
  const payload = {
    model: "example/text-only",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_video",
            video_url: "data:video/mp4;base64,RlUtMDUtRU1CRURERUQ=",
          },
        ],
      },
    ],
  };

  const first = await bridge.preCall(structuredClone(payload), {});
  const second = await bridge.preCall(structuredClone(payload), {});

  assert.equal(describeCalls, 1, "the complete result must remain cacheable");
  assert.match(storedKey, /^[a-f0-9]{64}$/);
  assert.equal(storedKey.includes(embeddedCueText), false);
  assert.equal(storedEntry?.metadata?.embeddedTranscriptFingerprint, embeddedTranscriptFingerprint);
  assert.equal(storedEntry?.metadata?.embeddedTranscriptCueCount, 1);
  assert.equal(JSON.stringify(storedEntry?.metadata).includes(embeddedCueText), false);
  for (const result of [first, second]) {
    assert.deepEqual(result.meta?.videoTranscriptDescriptionFingerprints, [
      fingerprintVideoTranscriptDescription(description),
    ]);
    assert.equal(JSON.stringify(result.meta).includes(embeddedCueText), false);
  }
});

test("result cache retries after a transient embedded subtitle failure but caches genuine absence", async () => {
  const entries = new Map<string, BridgeCacheEntry>();
  let extractionCalls = 0;
  const bridge = new VideoBridgeGuardrail({
    deps: {
      callVisionModel: async () => "bounded visual observation",
      extractFrames: async () => {
        extractionCalls += 1;
        return {
          durationSeconds: 4,
          embeddedTranscriptOutcome:
            extractionCalls === 1 ? "transient_failure" : ("absent" as const),
          frames: [{ dataUri: "data:image/jpeg;base64,AA==", timestampSeconds: 1 }],
          sampling: {
            candidateCount: 1,
            policyEffective: "uniform" as const,
            policyRequested: "uniform" as const,
          },
        };
      },
      getCapabilities: () => ({ supportsVideo: false }),
      getSettings: async () => ({
        modalityBridgeCacheEnabled: true,
        modalityBridgeCacheMaxEntries: 10,
        modalityBridgeCacheTtlMinutes: 60,
        modalityBridgeVideoEnabled: true,
        modalityBridgeVideoFrameCount: 1,
        modalityBridgeVideoModel: "openai/gpt-4o-mini",
        modalityBridgeVisionPrompt: "FU-05 transient embedded transcript cache outcome",
      }),
      resultCache: {
        delete: (key) => entries.delete(key),
        getEntry: (key) => entries.get(key),
        setEntry: (key, entry) => {
          entries.set(key, entry);
        },
      },
      selectVisionModel: async () => "openai/gpt-4o-mini",
    },
  });
  const payload = {
    model: "example/text-only",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_video",
            video_url: "data:video/mp4;base64,RlUtMDUtVFJBTlNJR U5U".replace(" ", ""),
          },
        ],
      },
    ],
  };

  await bridge.preCall(structuredClone(payload), {});
  assert.equal(entries.size, 0, "a degraded description must not become a complete cache entry");

  await bridge.preCall(structuredClone(payload), {});
  assert.equal(extractionCalls, 2, "the identical request must retry after transient failure");
  assert.equal(entries.size, 1, "confirmed subtitle absence may be cached");

  await bridge.preCall(structuredClone(payload), {});
  assert.equal(extractionCalls, 2, "the confirmed-absence result must be reused");
});
