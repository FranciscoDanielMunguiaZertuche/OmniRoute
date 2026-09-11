import { KEYLESS_DECOY_POOL_PROVIDERS } from "@omniroute/open-sse/services/accountFallback.ts";
import { isLocalStreamLifecycleError } from "../../shared/utils/circuitBreaker";
import { isRequestScopedUpstreamFailure } from "./comboFailureLogging";

export const PROVIDER_BREAKER_FAILURE_STATUSES = new Set([408, 500, 502, 503, 504]);

// #7907/#7908: single-model breaker trip bypasses the `isFailure` option (only applies
// inside `breaker.execute()`), so it needs its own `isLocalStreamLifecycleError` guard —
// otherwise a client abort (502 default, error='request_signal_aborted') trips the
// provider-wide breaker. Pure predicate, unit-testable without the full request path.
// Decoy-pool exemption (mirrors combo shouldRecordProviderBreakerFailure): quota on
// these keyless pools is strictly per upstream account, so a whole-provider trip
// silences healthy sibling accounts because of one bad apple. Per-connection
// cooldowns already isolate the sick account.
export function shouldTripProviderBreakerForResult(
  result: { status: number; errorCode?: string | null; errorType?: string | null; error?: unknown },
  isCombo: boolean,
  forceLiveComboTest: boolean,
  provider?: string | null
): boolean {
  if (provider && KEYLESS_DECOY_POOL_PROVIDERS.has(provider.toLowerCase())) {
    return false;
  }
  return (
    !forceLiveComboTest &&
    !isCombo &&
    !isRequestScopedUpstreamFailure({ code: result.errorCode, type: result.errorType }) &&
    !isLocalStreamLifecycleError(result.error) &&
    PROVIDER_BREAKER_FAILURE_STATUSES.has(Number(result.status))
  );
}

export function isAntigravityMissingProjectError(
  provider: string,
  result: { status?: number; errorCode?: string; errorType?: string }
): boolean {
  return (
    provider === "antigravity" &&
    result.status === 422 &&
    result.errorCode === "missing_project_id" &&
    result.errorType === "oauth_missing_project_id"
  );
}

/**
 * Keep stream-readiness routing decisions on the stable gate diagnostic.
 * The operator-facing error can contain arbitrary upstream words such as
 * "quota" or "retry after", which must not change account/combo classification.
 */
export function resolveStreamReadinessClassificationError(
  result: {
    classificationError?: unknown;
    error?: unknown;
    errorCode?: unknown;
  },
  fallback = "Antigravity stream ended before useful content"
): string {
  for (const value of [result.classificationError, result.error, result.errorCode]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}
