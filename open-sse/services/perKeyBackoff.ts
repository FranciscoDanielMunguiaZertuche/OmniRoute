/**
 * Per-key backoff for combo routing.
 *
 * Tracks when each connection (API key) last returned 429 and a fixed
 * "backoff until" timestamp. Combo target selection filters out keys
 * whose backoff has not yet expired. This lets each NVIDIA key recover
 * independently across the 4 keys we run with separate WireGuard egress.
 *
 * Design (2026-07-14):
 *  - Fixed initial backoff window: BACKOFF_MS_DEFAULT (default 60s = 60000ms). Deliberately
 *    NOT exponential: the goal is to discover NVIDIA's actual reset window
 *    by trying the key exactly once per window, not to mask it.
 *  - Per-connection granularity. Keys are identified by their `connectionId`
 *    (a UUID, stable across requests).
 *  - Resets to 0 on a recorded 200 OK. The key is "healthy" again.
 *  - Self-pruning: expired entries are filtered out lazily on read.
 *  - No DB writes. Pure in-memory, like providerCooldownTracker.
 *
 * The combo calls:
 *   - recordKeyBackoff(connectionId, BACKOFF_MS) when a target returns 429
 *   - recordKeySuccess(connectionId) when a target returns 200
 *   - recordKeyTimeout(connectionId) when a per-target timeout (524) fires
 *   - isKeyAvailable(connectionId) — true if no backoff or backoff expired
 *   - getBackoffState() — for status / monitoring
 *
 * 2026-08-08 (combo-hang fix): per-target upstream timeouts are the dominant
 * failure mode for saturated free tiers (NVIDIA NIM). The 524 path in
 * buildTargetTimeoutRunner records timeout health here via recordKeyTimeout, and
 * isKeyAvailable now also treats a key in timeout-health backoff as unavailable —
 * so the combo skips the benched key/egress entirely on subsequent requests
 * instead of hanging on it again.
 */

const BACKOFF_MS_DEFAULT = 60 * 1000;

/**
 * Per-provider 429 backoff (2026-08-12). The 60s default is right for
 * quota-style upstreams but WRONG for rate-limit-style upstreams that recover
 * in seconds — a 60s bench turns a transient throttle into a full-minute
 * lockout, and under client retry amplification (omp retries ×3, combo fail-fast
 * retries) every key gets benched simultaneously → "all round-robin unavailable"
 * 503 even though the upstream intermittently returns 200s.
 *
 *  - nvidia: NIM free tier is a per-key rate limit (not quota); keys recover in
 *    seconds and intermittently succeed mid-storm. 10s lets the combo retry each
 *    key ~6×/min to catch a 200 without hammering a saturated host (8 keys × 6 =
 *    48/min, well under typical NIM per-key RPM aggregate).
 *  - opencode-zen: free-tier quota storms last hours (recovers ~UTC midnight).
 *    60s × 8 keys = 480 wasted attempts/hr against a dead quota; 300s drops it
 *    to 96/hr and still rediscovers the provider within 5 min of recovery.
 *
 * Only 429 uses this map (see combo.ts call site — 5xx/524/WAF keep the 60s
 * default; 524 hang-escalation via recordKeyTimeout is untouched).
 */
const PROVIDER_429_BACKOFF_MS: Record<string, number> = {
  nvidia: 10 * 1000,
  "opencode-zen": 5 * 60 * 1000,
};

export function resolve429BackoffMs(provider?: string): number {
  if (provider && PROVIDER_429_BACKOFF_MS[provider]) return PROVIDER_429_BACKOFF_MS[provider];
  return BACKOFF_MS_DEFAULT;
}

/**
 * Timeout health windows (2026-08-08, #combo-hang): upstream HANGS (synthesized
 * 524 from the per-target timeout runner) are tracked separately from 429s with
 * a sliding window so one dead key/egress gets quarantined instead of burning
 * the full per-target timeout on every request.
 *
 *  - 1st timeout in window → 30s (transient blip)
 *  - 2nd-3rd timeout in window → 120s (degraded)
 *  - 4+ timeouts in window → 600s quarantine (dead; only success/cooldown recovers)
 *
 * A success clears the entry entirely (recordKeySuccess), recovering the key.
 */
const TIMEOUT_HEALTH_WINDOW_MS = 5 * 60 * 1000;
const TIMEOUT_BACKOFF_1ST_MS = 30 * 1000;
const TIMEOUT_BACKOFF_DEGRADED_MS = 120 * 1000;
const TIMEOUT_BACKOFF_QUARANTINE_MS = 600 * 1000;
const TIMEOUT_QUARANTINE_THRESHOLD = 4;

type BackoffEntry = {
  backoffUntilMs: number;
  setAtMs: number;
  consecutiveFailures: number;
  /** Sliding window of timeout timestamps (pruned lazily on read). */
  timeoutTimestampsMs: number[];
};

const state: Map<string, BackoffEntry> = new Map();

function getNowMs(): number {
  return Date.now();
}

export function recordKeyBackoff(
  connectionId: string,
  providerOrBackoffMs?: string | number
): void {
  if (!connectionId) return;
  const now = getNowMs();
  const existing = state.get(connectionId);
  const prevFailures = existing?.consecutiveFailures ?? 0;
  const backoffMs =
    typeof providerOrBackoffMs === "number"
      ? providerOrBackoffMs
      : resolve429BackoffMs(providerOrBackoffMs);
  // Fixed window: do NOT extend on consecutive failures. We want to learn
  // the true reset window, not hide it.
  state.set(connectionId, {
    backoffUntilMs: now + backoffMs,
    setAtMs: now,
    consecutiveFailures: prevFailures + 1,
    timeoutTimestampsMs: existing?.timeoutTimestampsMs ?? [],
  });
}

/**
 * Record an upstream hang/timeout for a connection (synthesized 524 from the
 * per-target timeout runner). Uses a sliding window of recent timeouts to
 * escalate: transient blips get a short backoff, consistently-dead keys get a
 * quarantine so the combo stops wasting the per-target budget on them.
 */
export function recordKeyTimeout(connectionId: string): void {
  if (!connectionId) return;
  const now = getNowMs();
  const existing = state.get(connectionId);
  const timestamps = (existing?.timeoutTimestampsMs ?? []).filter(
    (ts) => now - ts <= TIMEOUT_HEALTH_WINDOW_MS
  );
  timestamps.push(now);
  const countInWindow = timestamps.length;
  let backoffMs: number;
  if (countInWindow >= TIMEOUT_QUARANTINE_THRESHOLD) {
    backoffMs = TIMEOUT_BACKOFF_QUARANTINE_MS;
  } else if (countInWindow >= 2) {
    backoffMs = TIMEOUT_BACKOFF_DEGRADED_MS;
  } else {
    backoffMs = TIMEOUT_BACKOFF_1ST_MS;
  }
  state.set(connectionId, {
    backoffUntilMs: now + backoffMs,
    setAtMs: now,
    consecutiveFailures: existing?.consecutiveFailures ?? 0,
    timeoutTimestampsMs: timestamps,
  });
}

export function recordKeySuccess(connectionId: string): void {
  if (!connectionId) return;
  state.delete(connectionId);
}

export function isKeyAvailable(connectionId: string): boolean {
  if (!connectionId) return true;
  const entry = state.get(connectionId);
  if (!entry) return true;
  if (getNowMs() >= entry.backoffUntilMs) {
    // Expired — lazily prune
    state.delete(connectionId);
    return true;
  }
  return false;
}

export function getBackoffState(): Array<{
  connectionId: string;
  remainingMs: number;
  consecutiveFailures: number;
  timeoutCountInWindow: number;
}> {
  const now = getNowMs();
  const out: Array<{
    connectionId: string;
    remainingMs: number;
    consecutiveFailures: number;
    timeoutCountInWindow: number;
  }> = [];
  for (const [connectionId, entry] of state.entries()) {
    const remaining = entry.backoffUntilMs - now;
    if (remaining > 0) {
      out.push({
        connectionId,
        remainingMs: remaining,
        consecutiveFailures: entry.consecutiveFailures,
        timeoutCountInWindow: entry.timeoutTimestampsMs.filter(
          (ts) => now - ts <= TIMEOUT_HEALTH_WINDOW_MS
        ).length,
      });
    } else {
      state.delete(connectionId);
    }
  }
  return out;
}

export function clearAllBackoffs(): void {
  state.clear();
}

export function getDefaultBackoffMs(provider?: string): number {
  return resolve429BackoffMs(provider);
}
