/**
 * Per-connection proxy resolver
 *
 * Reads `provider_specific_data.proxy_url` from a provider_connections row
 * and parses it into the `ProxyConfig` shape that `runWithProxyContext()`
 * (proxyFetch.ts:305) accepts.
 *
 * Supported URL forms:
 *   socks5://user:pass@host:1080
 *   socks5h://host:1080
 *   http://host:8080
 *   https://user:pass@host:8443
 *
 * Adding `proxy_url` to a connection's provider_specific_data JSON makes
 * every outbound request for that connection egress through the named
 * proxy. Combined with per-account connectionId routing in the combo
 * engine, this gives each account its own egress path (e.g. one
 * WireGuard/Gluetun tunnel per account).
 */

export interface ConnectionProxyConfig {
  type: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * Pull `proxy_url` out of a connection row's `providerSpecificData` and
 * return a typed proxy config, or null if the field is absent / invalid.
 *
 * The connection row shape matches what `getProviderConnections()`
 * returns: `{ id, provider, name, ..., providerSpecificData: {...} | null }`.
 * Tolerates a stringified-JSON form (some older rows stored it as TEXT).
 */
export function resolveConnectionProxy(
  connection: Record<string, unknown> | null | undefined
): ConnectionProxyConfig | null {
  if (!connection) return null;
  const raw = connection.providerSpecificData;
  const psd =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!psd) return null;

  const candidate =
    typeof psd.proxyUrl === "string"
      ? psd.proxyUrl
      : typeof psd.proxy_url === "string"
        ? psd.proxy_url
        : null;
  if (!candidate) return null;

  return parseProxyUrl(candidate);
}

/**
 * Parse a single proxy URL string into a typed config. Returns null on
 * malformed input rather than throwing — the caller treats null as
 * "no proxy configured for this connection".
 */
export function parseProxyUrl(input: string): ConnectionProxyConfig | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(":", "").toLowerCase();
  // Map socks5h:// → socks5:// (hostnames resolved remotely; we always do
  // that, so the bare socks5 scheme is enough).
  const type = scheme === "socks5h" ? "socks5" : scheme;
  if (!["http", "https", "socks5", "socks4"].includes(type)) return null;

  const host = url.hostname;
  if (!host) return null;
  const port = url.port ? Number(url.port) : defaultPortFor(type);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;

  let username: string | undefined;
  let password: string | undefined;
  if (url.username) {
    username = decodeURIComponent(url.username);
    password = url.password ? decodeURIComponent(url.password) : "";
  }

  return username !== undefined ? { type, host, port, username, password } : { type, host, port };
}

function defaultPortFor(type: string): number {
  if (type === "https") return 443;
  if (type === "socks5" || type === "socks4") return 1080;
  return 80;
}
