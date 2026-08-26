-- Retire the Felo Web integration while its GPL-derived provenance remains on hold.
--
-- Keep connection rows and historical records for auditability. Disabling the
-- connections is deliberately fail-closed: API-key allowed_connections entries
-- continue to reference the same connection ids instead of becoming an empty
-- allowlist, which would mean unrestricted access in the policy layer.

UPDATE exclusive_connection_leases
SET state = 'INVALIDATED',
    ended_at = COALESCE(ended_at, datetime('now')),
    end_reason = 'CONNECTION_INELIGIBLE'
WHERE state = 'ACTIVE'
  AND (
    lower(trim(provider, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
      IN ('felo-web', 'felo')
    OR connection_id IN (
      SELECT id
      FROM provider_connections
      WHERE lower(trim(provider, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
        IN ('felo-web', 'felo')
    )
  );

UPDATE provider_connections
SET is_active = 0,
    test_status = 'unavailable',
    error_code = 'PROVIDER_REMOVED',
    last_error = 'Provider integration retired from OmniRoute v3.8.50',
    last_error_type = 'provider_removed',
    last_error_source = 'migration:163',
    last_error_at = datetime('now'),
    updated_at = datetime('now')
WHERE lower(trim(provider, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
    IN ('felo-web', 'felo')
  AND (
    is_active IS NOT 0
    OR test_status IS NOT 'unavailable'
    OR error_code IS NOT 'PROVIDER_REMOVED'
    OR last_error IS NOT 'Provider integration retired from OmniRoute v3.8.50'
    OR last_error_type IS NOT 'provider_removed'
    OR last_error_source IS NOT 'migration:163'
    OR last_error_at IS NULL
  );

-- Migrations run before settings imports. Keep the tombstone durable when an
-- old db.json snapshot or an admin PATCH later attempts to reactivate either
-- retired id. The WHEN predicates are null-safe and prevent timestamp churn
-- when an already-normalized row is written again.
CREATE TRIGGER IF NOT EXISTS provider_connections_retire_felo_web_insert
AFTER INSERT ON provider_connections
WHEN lower(trim(NEW.provider, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
    IN ('felo-web', 'felo')
  AND (
    NEW.is_active IS NOT 0
    OR NEW.test_status IS NOT 'unavailable'
    OR NEW.error_code IS NOT 'PROVIDER_REMOVED'
    OR NEW.last_error IS NOT 'Provider integration retired from OmniRoute v3.8.50'
    OR NEW.last_error_type IS NOT 'provider_removed'
    OR NEW.last_error_source IS NOT 'migration:163'
    OR NEW.last_error_at IS NULL
  )
BEGIN
  UPDATE provider_connections
  SET is_active = 0,
      test_status = 'unavailable',
      error_code = 'PROVIDER_REMOVED',
      last_error = 'Provider integration retired from OmniRoute v3.8.50',
      last_error_type = 'provider_removed',
      last_error_source = 'migration:163',
      last_error_at = datetime('now'),
      updated_at = datetime('now')
  WHERE id = NEW.id
    AND (
      is_active IS NOT 0
      OR test_status IS NOT 'unavailable'
      OR error_code IS NOT 'PROVIDER_REMOVED'
      OR last_error IS NOT 'Provider integration retired from OmniRoute v3.8.50'
      OR last_error_type IS NOT 'provider_removed'
      OR last_error_source IS NOT 'migration:163'
      OR last_error_at IS NULL
    );
END;

CREATE TRIGGER IF NOT EXISTS provider_connections_retire_felo_web_update
AFTER UPDATE OF provider, is_active, test_status, error_code, last_error,
  last_error_type, last_error_source, last_error_at ON provider_connections
WHEN lower(trim(NEW.provider, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
    IN ('felo-web', 'felo')
  AND (
    NEW.is_active IS NOT 0
    OR NEW.test_status IS NOT 'unavailable'
    OR NEW.error_code IS NOT 'PROVIDER_REMOVED'
    OR NEW.last_error IS NOT 'Provider integration retired from OmniRoute v3.8.50'
    OR NEW.last_error_type IS NOT 'provider_removed'
    OR NEW.last_error_source IS NOT 'migration:163'
    OR NEW.last_error_at IS NULL
  )
BEGIN
  UPDATE provider_connections
  SET is_active = 0,
      test_status = 'unavailable',
      error_code = 'PROVIDER_REMOVED',
      last_error = 'Provider integration retired from OmniRoute v3.8.50',
      last_error_type = 'provider_removed',
      last_error_source = 'migration:163',
      last_error_at = datetime('now'),
      updated_at = datetime('now')
  WHERE id = NEW.id
    AND (
      is_active IS NOT 0
      OR test_status IS NOT 'unavailable'
      OR error_code IS NOT 'PROVIDER_REMOVED'
      OR last_error IS NOT 'Provider integration retired from OmniRoute v3.8.50'
      OR last_error_type IS NOT 'provider_removed'
      OR last_error_source IS NOT 'migration:163'
      OR last_error_at IS NULL
    );
END;
