/**
 * Provider ids that must remain unavailable even when stale rows are restored
 * after migrations have already run. Keep canonical ids and legacy aliases
 * together so neither executor dispatch nor credential selection can fall back.
 */
export const RUNTIME_RETIRED_PROVIDER_IDS: ReadonlySet<string> = new Set(["felo-web", "felo"]);

export function isRuntimeRetiredProviderId(providerId: unknown): providerId is string {
  return (
    typeof providerId === "string" &&
    RUNTIME_RETIRED_PROVIDER_IDS.has(providerId.trim().toLowerCase())
  );
}
