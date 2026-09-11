/**
 * Provider Cooldown Tracker
 *
 * Global, cross-request cooldown state for failed providers/connections.
 * Prevents subsequent combo requests from re-walking the same failing
 * providers by remembering failure timestamps and enforcing a configurable
 * minimum/maximum cooldown window.
 */

import {
  DEFAULT_RESILIENCE_SETTINGS,
  type ResilienceSettings,
} from "../../src/lib/resilience/settings";

interface CooldownEntry {
  /** Timestamp of last recorded failure (ms since epoch) */
  lastFailureAt: number;
  /** Number of consecutive failures (resets on success) */
  failureCount: number;
  /** How long this entry must be retained for cleanup purposes */
  retentionMs: number;
}

// Global cooldown state: keyed by "provider:connectionId" or "provider"
const cooldownMap = new Map<string, CooldownEntry>();

/**
 * muse-spark 429 tolerance (fleet max-only policy) — mirrors perKeyBackoff.
 * Single decoy/transient 429s must not sideline healthy 1.3 quota (which
 * would push combo walks onto GLM while muse-spark can still serve). A 429
 * for `opencode`/`opencode-zen` only records cooldown after 3 consecutive
 * 429s inside 20s; all other statuses bench immediately as before. Callers
 * opt in by passing the upstream status.
 */
const MUSE_429_TOLERANCE_PROVIDERS = new Set(["opencode", "opencode-zen"]);
const MUSE_429_WINDOW_MS = 20 * 1000;
const MUSE_429_THRESHOLD = 3;
const recent429TimestampsMs = new Map<string, number[]>();

// Evict entries older than their configured retention horizon to prevent
// unbounded memory growth without shortening operator-configured cooldowns.
const DEFAULT_ENTRY_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Cleanup every 60s

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanupIfNeeded(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupExpiredCooldownEntries();
  }, CLEANUP_INTERVAL_MS);
  // Allow Node.js to exit even if the timer is running
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function getEntryRetentionMs(settings?: ResilienceSettings): number {
  const maxRetryCooldownMs =
    settings?.providerCooldown?.maxRetryCooldownMs ??
    DEFAULT_RESILIENCE_SETTINGS.providerCooldown.maxRetryCooldownMs;
  return Math.max(DEFAULT_ENTRY_RETENTION_MS, maxRetryCooldownMs);
}

/**
 * Remove expired cooldown entries using each entry's configured retention
 * horizon. Exported for diagnostics and focused tests; normal runtime cleanup is
 * still performed by the unref'd interval started on first cooldown record.
 */
export function cleanupExpiredCooldownEntries(now = Date.now()): void {
  for (const [key, entry] of cooldownMap) {
    if (now - entry.lastFailureAt > entry.retentionMs) {
      cooldownMap.delete(key);
    }
  }
}

/**
 * Build a cooldown key from provider and optional connectionId.
 */
function cooldownKey(provider: string, connectionId?: string): string {
  return connectionId ? `${provider}:${connectionId}` : provider;
}

/**
 * Record a failure for a provider/connection.
 *
 * @param provider - Provider ID (e.g. "openai", "anthropic")
 * @param connectionId - Optional connection ID for per-connection tracking
 * @param settings - Resilience settings for cooldown configuration
 */
export function recordProviderCooldown(
  provider: string,
  connectionId: string | undefined,
  settings?: ResilienceSettings,
  options?: { status?: number }
): void {
  if (!provider || provider === "unknown") return;

  const key = cooldownKey(provider, connectionId);
  const now = Date.now();

  // muse-spark 429 tolerance: 1–2 stray 429s inside the window are ignored;
  // only the 3rd consecutive 429 records cooldown.
  if (options?.status === 429 && MUSE_429_TOLERANCE_PROVIDERS.has(provider)) {
    const recent = (recent429TimestampsMs.get(key) ?? []).filter(
      (ts) => now - ts <= MUSE_429_WINDOW_MS
    );
    recent.push(now);
    if (recent.length < MUSE_429_THRESHOLD) {
      recent429TimestampsMs.set(key, recent);
      return;
    }
    recent429TimestampsMs.delete(key);
  }

  const existing = cooldownMap.get(key);
  const retentionMs = getEntryRetentionMs(settings);

  if (existing) {
    existing.lastFailureAt = now;
    existing.failureCount++;
    existing.retentionMs = Math.max(existing.retentionMs, retentionMs);
  } else {
    cooldownMap.set(key, { lastFailureAt: now, failureCount: 1, retentionMs });
  }

  startCleanupIfNeeded();
}

/**
 * Check if a provider/connection is currently in cooldown and should be skipped.
 *
 * @param provider - Provider ID
 * @param connectionId - Optional connection ID
 * @param settings - Resilience settings for cooldown configuration
 * @returns true if the provider should be skipped (still in cooldown)
 */
export function isProviderInCooldown(
  provider: string,
  connectionId: string | undefined,
  settings?: ResilienceSettings
): boolean {
  if (!provider || provider === "unknown") return false;

  const key = cooldownKey(provider, connectionId);
  const entry = cooldownMap.get(key);
  if (!entry) return false;

  if (entry.failureCount === 0) return false;

  const now = Date.now();
  const elapsed = now - entry.lastFailureAt;

  const minCooldownMs =
    settings?.providerCooldown?.minRetryCooldownMs ??
    DEFAULT_RESILIENCE_SETTINGS.providerCooldown.minRetryCooldownMs;

  const maxCooldownMs =
    settings?.providerCooldown?.maxRetryCooldownMs ??
    DEFAULT_RESILIENCE_SETTINGS.providerCooldown.maxRetryCooldownMs;

  const exponent = Math.min(Math.max(0, entry.failureCount - 1), 10);
  const scaledCooldownMs = Math.min(minCooldownMs * Math.pow(2, exponent), maxCooldownMs);

  return elapsed < scaledCooldownMs;
}

/**
 * Get the remaining cooldown time for a provider/connection.
 * Returns 0 if not in cooldown.
 */
export function getRemainingCooldownMs(
  provider: string,
  connectionId: string | undefined,
  settings?: ResilienceSettings
): number {
  if (!provider || provider === "unknown") return 0;

  const key = cooldownKey(provider, connectionId);
  const entry = cooldownMap.get(key);
  if (!entry) return 0;

  const now = Date.now();
  const elapsed = now - entry.lastFailureAt;

  const minCooldownMs =
    settings?.providerCooldown?.minRetryCooldownMs ??
    DEFAULT_RESILIENCE_SETTINGS.providerCooldown.minRetryCooldownMs;

  const maxCooldownMs =
    settings?.providerCooldown?.maxRetryCooldownMs ??
    DEFAULT_RESILIENCE_SETTINGS.providerCooldown.maxRetryCooldownMs;

  const exponent = Math.min(Math.max(0, entry.failureCount - 1), 10);
  const scaledCooldownMs = Math.min(minCooldownMs * Math.pow(2, exponent), maxCooldownMs);

  const remaining = scaledCooldownMs - elapsed;
  return remaining > 0 ? remaining : 0;
}

/**
 * Record a successful request for a provider/connection.
 * Resets the failure count (but keeps the entry for reference).
 */
export function recordProviderSuccess(provider: string, connectionId: string | undefined): void {
  if (!provider || provider === "unknown") return;

  const key = cooldownKey(provider, connectionId);
  // A success breaks consecutiveness: stray-429 tolerance starts over.
  recent429TimestampsMs.delete(key);
  const entry = cooldownMap.get(key);
  if (entry) {
    // Reset failure count but keep the entry
    entry.failureCount = 0;
  }
}

/**
 * Clear all cooldown state. Useful for testing or manual reset.
 */
export function clearCooldownState(): void {
  cooldownMap.clear();
  recent429TimestampsMs.clear();
}

/**
 * Get the number of entries in the cooldown map (for diagnostics).
 */
export function getCooldownEntryCount(): number {
  return cooldownMap.size;
}
