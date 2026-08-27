// Reserved provider prefixes — single source of truth shared by:
//
//   1. The runtime model resolver guard (src/sse/services/model.ts): user-defined
//      compatible-node prefixes must not be allowed to shadow built-in provider
//      ids/aliases, otherwise a node with prefix="cf" would hijack cloudflare-ai
//      requests (ported from upstream 9router 047fdc89).
//   2. The write-path validation schemas (createProviderNodeSchema /
//      updateProviderNodeSchema in src/shared/validation/schemas/provider.ts):
//      a prefix that the runtime will never honor must be rejected at creation
//      time with a clear message instead of silently routing to the built-in
//      provider (tokenrouter bug: "No active credentials for provider:
//      tokenrouter" despite a fully configured compatible node).
//
// Semantics:
//   - REGISTRY entry ids + aliases plus the permanently retired common
//     ChatGPT Web ids. Manual alias ids outside REGISTRY
//     (xiaomi/llamacpp/aq) do NOT intercept nodes at runtime and are therefore
//     deliberately NOT reserved — including them would cause false-positive
//     rejections.
//   - Registry ids/aliases stay case-sensitive: mixed-case input like
//     "TokenRouter" does not collide with the runtime lookup (`Set.has` is
//     exact-match), so it stays allowed. The retired ids are the deliberate
//     exception and are matched trim/case-insensitively because every request
//     using them fails closed with 410.
import { REGISTRY } from "@omniroute/open-sse/config/providerRegistry.ts";

import {
  isCommonChatGptWebRetiredProviderId,
  RETIRED_COMMON_CHATGPT_WEB_PROVIDER_IDS,
} from "@/shared/constants/chatgptWebRetirement";

let _reserved: Set<string> | null = null;

function buildReservedProviderPrefixes(): Set<string> {
  if (_reserved) return _reserved;
  const reserved = new Set<string>();
  for (const entry of Object.values(REGISTRY)) {
    if (entry?.id) reserved.add(entry.id);
    if (entry?.alias) reserved.add(entry.alias);
  }
  for (const retiredId of RETIRED_COMMON_CHATGPT_WEB_PROVIDER_IDS) reserved.add(retiredId);
  _reserved = reserved;
  return reserved;
}

/**
 * All reserved provider prefixes (REGISTRY ids + aliases and canonical retired
 * ids). Built lazily so the registry is only walked once per process.
 */
export function getReservedProviderPrefixes(): ReadonlySet<string> {
  return buildReservedProviderPrefixes();
}

/**
 * Number of unique reserved prefixes (ids + aliases deduplicated). Exposed for
 * tests/docs so counts are measured, not memorized.
 */
export const RESERVED_PREFIX_COUNT = buildReservedProviderPrefixes().size;

/**
 * Frozen snapshot of the reserved set (test/documentation convenience). Prefer
 * `isReservedProviderPrefix` / `getReservedProviderPrefixes` on hot paths.
 */
export const RESERVED_PROVIDER_PREFIXES: ReadonlySet<string> = getReservedProviderPrefixes();

/**
 * True when `value` is a reserved provider prefix. Non-strings are never
 * reserved (mirrors the runtime guard's typeof check).
 */
export function isReservedProviderPrefix(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (isCommonChatGptWebRetiredProviderId(value) || buildReservedProviderPrefixes().has(value))
  );
}

/**
 * Zod-friendly rejection message for a reserved prefix. Names the colliding
 * prefix and tells the operator what to pick instead.
 */
export function reservedProviderPrefixMessage(value: string): string {
  return `"${value}" is a reserved provider prefix — choose a different prefix (reserved ids/aliases cannot be used for custom nodes because requests like <prefix>/model route to a built-in provider or fail closed when retired)`;
}
