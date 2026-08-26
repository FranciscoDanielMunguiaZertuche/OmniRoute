import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-felo-runtime-block-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { hashLeaseOwnerId } = await import("../../src/lib/db/exclusiveConnectionLeases.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");

const RETIRED_PROVIDER_VARIANTS = ["felo-web", "felo", " FeLo-Web ", "\tFELO\n"] as const;

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("retired Felo ids stay ineligible after imports, even if DB triggers are bypassed", async () => {
  const db = core.getDbInstance();

  for (const [index, providerId] of RETIRED_PROVIDER_VARIANTS.entries()) {
    const connectionId = `trigger-normalized-${index}`;
    db.prepare(
      "INSERT INTO provider_connections " +
        "(id, provider, auth_type, name, is_active, test_status, created_at, updated_at) " +
        "VALUES (?, ?, 'apikey', ?, 1, 'active', datetime('now'), datetime('now'))"
    ).run(connectionId, providerId, `${providerId}-post-migration-import`);

    const persistedState = db
      .prepare(
        "SELECT is_active, test_status, error_code, last_error_type, last_error_source " +
          "FROM provider_connections WHERE id = ?"
      )
      .get(connectionId) as {
      is_active: number;
      test_status: string;
      error_code: string;
      last_error_type: string;
      last_error_source: string;
    };
    assert.deepEqual(persistedState, {
      is_active: 0,
      test_status: "unavailable",
      error_code: "PROVIDER_REMOVED",
      last_error_type: "provider_removed",
      last_error_source: "migration:163",
    });

    const credentials = await getProviderCredentials(
      providerId,
      null,
      [connectionId],
      "felo-chat",
      { allowSuppressedConnections: true }
    );
    assert.equal(
      credentials,
      null,
      `${providerId} must remain blocked after trigger normalization`
    );
  }

  db.exec(`
    DROP TRIGGER provider_connections_retire_felo_web_insert;
    DROP TRIGGER provider_connections_retire_felo_web_update;
  `);

  for (const [index, providerId] of RETIRED_PROVIDER_VARIANTS.entries()) {
    const connectionId = `truly-active-${index}`;
    const leaseOwnerId = `vlo_${String.fromCharCode(65 + index).repeat(43)}`;
    const apiKeyId = `retired-key-${index}`;
    const generation = index + 1;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    db.prepare(
      "INSERT INTO provider_connections " +
        "(id, provider, auth_type, name, is_active, test_status, created_at, updated_at) " +
        "VALUES (?, ?, 'apikey', ?, 1, 'active', ?, ?)"
    ).run(connectionId, providerId, `${providerId}-trigger-bypass`, now, now);
    db.prepare(
      "INSERT INTO exclusive_connection_leases " +
        "(lease_owner_hash, api_key_id, provider, connection_id, generation, state, " +
        "acquired_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)"
    ).run(
      hashLeaseOwnerId(leaseOwnerId),
      apiKeyId,
      providerId,
      connectionId,
      generation,
      now,
      now,
      expiresAt
    );

    const activeBeforeSelection = db
      .prepare("SELECT is_active, test_status FROM provider_connections WHERE id = ?")
      .get(connectionId) as { is_active: number; test_status: string };
    assert.deepEqual(
      activeBeforeSelection,
      { is_active: 1, test_status: "active" },
      "fixture must bypass the migration triggers so the auth tombstone is tested independently"
    );

    const credentials = await getProviderCredentials(
      providerId,
      null,
      [connectionId],
      "felo-chat",
      {
        allowSuppressedConnections: true,
        lease: {
          apiKeyId,
          context: { leaseOwnerId, generation },
          mode: "request",
        },
      }
    );
    assert.equal(credentials, null, `${providerId} must be blocked even with a truly active row`);

    const lease = db
      .prepare("SELECT state, end_reason FROM exclusive_connection_leases WHERE connection_id = ?")
      .get(connectionId) as { state: string; end_reason: string | null };
    assert.deepEqual(lease, {
      state: "INVALIDATED",
      end_reason: "CONNECTION_INELIGIBLE",
    });
  }
});
