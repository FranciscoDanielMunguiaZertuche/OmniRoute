import { redactVideoTranscriptSensitiveText } from "@/lib/guardrails/videoTranscriptLogRedaction";
import { logProxyEvent } from "../../lib/proxyLogger";
import { logTranslationEvent } from "../../lib/translatorEvents";

type ProxyLogConfig = {
  host: string;
  port: number | string;
  type: string;
};

export interface SafeLogEventsInput {
  clientRawRequest?: {
    endpoint?: string;
    headers?: Record<string, string | string[] | undefined>;
  } | null;
  comboName?: string | null;
  credentials: { connectionId?: string | null };
  model: string;
  provider: string;
  proxyInfo?: {
    level?: string;
    levelId?: string | null;
    proxy?: ProxyLogConfig | null;
  } | null;
  proxyLatency: number;
  result: { error?: unknown; status?: number; success: boolean };
  sourceFormat: string;
  targetFormat: string;
  tlsFingerprintUsed?: boolean;
  videoTranscriptSensitive?: boolean;
}

/** Retain safe proxy/translation metadata without retaining a sensitive provider error echo. */
export async function safeLogEvents({
  result,
  proxyInfo,
  proxyLatency,
  provider,
  model,
  sourceFormat,
  targetFormat,
  credentials,
  comboName,
  clientRawRequest,
  tlsFingerprintUsed = false,
  videoTranscriptSensitive = false,
}: SafeLogEventsInput): Promise<void> {
  try {
    const rawIp =
      clientRawRequest?.headers?.["x-forwarded-for"] ||
      clientRawRequest?.headers?.["x-real-ip"] ||
      clientRawRequest?.headers?.["cf-connecting-ip"] ||
      null;
    const rawIpValue = Array.isArray(rawIp) ? rawIp[0] : rawIp;
    const clientIp = typeof rawIpValue === "string" ? rawIpValue.split(",")[0].trim() : null;

    let egressIp: string | null = null;
    try {
      const { getCachedEgressIp, warmEgressIp } = await import("../../lib/proxyEgress");
      const { proxyConfigToUrl } = await import("@omniroute/open-sse/utils/proxyDispatcher.ts");
      const proxyUrl = proxyInfo?.proxy ? proxyConfigToUrl(proxyInfo.proxy) : null;
      egressIp = getCachedEgressIp(proxyUrl);
      warmEgressIp(proxyUrl);
    } catch {
      // Egress visibility is best-effort and never breaks the request path.
    }

    logProxyEvent({
      account: credentials.connectionId?.slice(0, 8) || null,
      clientIp,
      comboId: comboName || null,
      connectionId: credentials.connectionId,
      egressIp,
      error:
        result.success || !result.error
          ? null
          : redactVideoTranscriptSensitiveText(String(result.error), videoTranscriptSensitive),
      latencyMs: proxyLatency,
      level: proxyInfo?.level || "direct",
      levelId: proxyInfo?.levelId || null,
      provider,
      proxy: proxyInfo?.proxy || null,
      status: result.success
        ? "success"
        : result.status === 408 || result.status === 504
          ? "timeout"
          : "error",
      targetUrl: `${provider}/${model}`,
      tlsFingerprint: tlsFingerprintUsed,
    });
  } catch {}

  try {
    logTranslationEvent({
      comboName: comboName || null,
      connectionId: credentials.connectionId || null,
      endpoint: clientRawRequest?.endpoint || "/v1/chat/completions",
      latency: proxyLatency,
      model,
      provider,
      sourceFormat,
      status: result.success ? "success" : "error",
      statusCode: result.success ? 200 : result.status || 500,
      targetFormat,
    });
  } catch {}
}
