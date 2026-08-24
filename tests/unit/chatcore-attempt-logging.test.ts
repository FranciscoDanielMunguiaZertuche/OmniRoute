// tests/unit/chatcore-attempt-logging.test.ts
// Characterization of persistAttemptLogs — the per-attempt call-log persistence extracted from
// handleChatCore (chatCore god-file decomposition, #3501). Uses a real temp DB and polls the
// persisted row (saveCallLog is async + fire-and-forget). Locks: the field mapping, the
// cacheSource semantic/upstream normalization, final credentials.connectionId attribution,
// credentials fallback, and error persistence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-attempt-logging-test-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const eventBus = await import("../../src/lib/events/eventBus.ts");
const { fingerprintVideoTranscriptDescription } =
  await import("../../src/lib/guardrails/videoTranscriptLogRedaction.ts");
const { getCallLogById } = await import("../../src/lib/usage/callLogs.ts");
const { persistAttemptLogs } = await import("../../open-sse/handlers/chatCore/attemptLogging.ts");

type CodexRotationEnvelope = {
  _omniroute?: {
    codexAccountRotation?: {
      initialConnectionId: unknown;
      finalConnectionId: unknown;
    };
  };
};

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    connectionId: "conn-1",
    model: "gpt-x",
    skillRequestId: "skill-1",
    detailedLoggingEnabled: false,
    reqLogger: null,
    pendingRequestId: "REPLACE",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    requestedModel: "gpt-x-requested",
    credentials: { connectionId: "cred-conn" },
    startTime: Date.now(),
    body: { messages: [{ role: "user", content: "hi" }] },
    sourceFormat: "openai",
    targetFormat: "openai",
    comboName: null,
    comboStepId: null,
    comboExecutionKey: null,
    tokensCompressed: 0,
    apiKeyInfo: { id: "key-1", name: "Key One" },
    noLogEnabled: false,
    videoTranscriptSensitive: false,
    ...overrides,
  } as Parameters<typeof persistAttemptLogs>[1];
}

async function pollForCallLog(id: string, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const row = await getCallLogById(id);
    if (row) return row as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

function getCodexAccountRotation(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  return (value as CodexRotationEnvelope)._omniroute?.codexAccountRotation;
}

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("persists a call log row with the mapped fields (default cacheSource=upstream)", async () => {
  const id = "attempt-basic-1";
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 } },
    baseCtx({ pendingRequestId: id, credentials: { connectionId: "conn-1" } })
  );
  const row = await pollForCallLog(id);
  assert.ok(row, "call log row should be persisted");
  assert.equal(row.status, 200);
  assert.equal(row.model, "gpt-x");
  assert.equal(row.provider, "openai");
  assert.equal(row.requestedModel, "gpt-x-requested");
  assert.equal(row.connectionId, "conn-1");
  assert.equal(row.cacheSource, "upstream");
});

test("uses final credentials connectionId when Codex failover rotates the account", async () => {
  const id = "attempt-codex-rotation-1";
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 }, responseBody: { id: "response-1" } },
    baseCtx({
      pendingRequestId: id,
      provider: "codex",
      connectionId: "initial-conn",
      credentials: { connectionId: "final-conn" },
    })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.connectionId, "final-conn");
  assert.deepEqual(getCodexAccountRotation(row.requestBody), {
    initialConnectionId: "initial-conn",
    finalConnectionId: "final-conn",
  });
  assert.deepEqual(getCodexAccountRotation(row.responseBody), {
    initialConnectionId: "initial-conn",
    finalConnectionId: "final-conn",
  });
});

test("cacheSource 'semantic' is preserved", async () => {
  const id = "attempt-semantic-1";
  persistAttemptLogs({ status: 200, cacheSource: "semantic" }, baseCtx({ pendingRequestId: id }));
  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.cacheSource, "semantic");
});

test("connectionId falls back to credentials.connectionId when null, and error is persisted", async () => {
  const id = "attempt-fallback-1";
  persistAttemptLogs(
    { status: 502, error: "upstream boom" },
    baseCtx({ pendingRequestId: id, connectionId: null })
  );
  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.connectionId, "cred-conn");
  assert.equal(row.status, 502);
  assert.match(String(row.error ?? ""), /upstream boom/);
});

test("omits non-stream response echoes for a transcript-sensitive attempt", async () => {
  const id = "attempt-video-transcript-sensitive-1";
  const traceId = "trace-video-transcript-sensitive-1";
  const rawCue = "private attempt-log subtitle echo sentinel";
  const description = `[Video description: transcript[source=embedded] text=${JSON.stringify(rawCue)}]`;
  persistAttemptLogs(
    {
      status: 502,
      error: `upstream echoed ${rawCue}`,
      responseBody: { choices: [{ message: { content: rawCue } }] },
      providerResponse: {
        choices: [{ message: { content: rawCue } }],
        warning: `safety filter echoed ${rawCue}`,
      },
      clientResponse: { choices: [{ message: { content: rawCue } }] },
    },
    baseCtx({
      detailedLoggingEnabled: true,
      pendingRequestId: id,
      skillRequestId: "skill-video-transcript-sensitive",
      traceId,
      body: {
        messages: [
          {
            role: "user",
            content: description,
          },
        ],
      },
      reqLogger: {
        getPipelinePayloads: () => ({}),
        isVideoTranscriptSensitive: () => true,
      },
      videoTranscriptDescriptionFingerprints: [fingerprintVideoTranscriptDescription(description)],
      videoTranscriptSensitive: true,
    })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  const serialized = JSON.stringify({
    error: row.error,
    pipelinePayloads: row.pipelinePayloads,
    responseBody: row.responseBody,
  });
  assert.equal(serialized.includes(rawCue), false);
  assert.match(serialized, /omitted: video transcript/);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const lifecycle = eventBus
    .getEventHistory(undefined, 100)
    .find(
      (entry) =>
        entry.event === "request.failed" &&
        (entry.payload as { id?: unknown } | undefined)?.id === traceId
    );
  assert.ok(lifecycle, "request.failed must be retained for dashboard lifecycle cleanup");
  const lifecyclePayload = JSON.stringify(lifecycle.payload);
  assert.equal(lifecyclePayload.includes(rawCue), false);
  assert.match(lifecyclePayload, /omitted: video transcript/);

  const auditRow = coreDb
    .getDbInstance()
    .prepare(
      "SELECT details FROM audit_log WHERE action = 'provider.warning' AND request_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get("skill-video-transcript-sensitive") as { details?: string } | undefined;
  assert.ok(auditRow, "provider.warning existence must survive transcript redaction");
  assert.equal(String(auditRow.details).includes(rawCue), false);
  assert.match(String(auditRow.details), /omitted: video transcript/);
});
