/**
 * Vision Bridge helper functions for image processing.
 */
import { fetchRemoteImage } from "@/shared/network/remoteImageFetch";
import { getRuntimePorts } from "@/lib/runtime/ports";
import { getBestVisionModel, getFallbackModels, recordLatency } from "./visionBridgeRouter";
/**
 * Provider to environment variable mapping for API key resolution.
 */
const PROVIDER_API_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Resolve API key based on model provider (issue #2232).
 *
 * Priority:
 *   1. `explicitKey` argument (caller override)
 *   2. `VISION_BRIDGE_API_KEY` env var — operator-set, takes precedence over
 *      per-provider env vars. Used when the operator wants every vision-bridge
 *      call to go through a single OpenAI-compatible endpoint (e.g.,
 *      OmniRoute itself, OpenRouter, a Gemini-OpenAI-compat URL).
 *   3. Per-provider env var (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
 *      `OPENAI_API_KEY`) based on the `provider/` prefix in the model id.
 *   4. `OPENAI_API_KEY` as final fallback when the prefix is unrecognized.
 *
 * @param model - Model identifier (e.g., "anthropic/claude-3-haiku", "openai/gpt-4o-mini")
 * @param explicitKey - Explicit API key passed as argument (takes precedence)
 * @returns Resolved API key string
 */
export function resolveProviderApiKey(model: string, explicitKey?: string): string {
  if (explicitKey) return explicitKey;
  const isAnthropic = model.startsWith("anthropic/");
  // VISION_BRIDGE_API_KEY only applies to the OpenAI-compatible branch — the
  // Anthropic branch keeps its dedicated key, since the wire format differs.
  if (!isAnthropic) {
    const bridgeKey = (process.env.VISION_BRIDGE_API_KEY || "").trim();
    if (bridgeKey) return bridgeKey;
  }
  const provider = model.includes("/") ? model.split("/")[0] : "";
  const envVar = PROVIDER_API_KEY_MAP[provider] || "OPENAI_API_KEY";
  return process.env[envVar] || "";
}

/**
 * Resolve the OpenAI-compatible base URL for non-Anthropic vision bridge calls
 * (issue #2232).
 *
 * Priority:
 *   1. `VISION_BRIDGE_BASE_URL` env var — operator-set, e.g. point this at
 *      OmniRoute's own `/v1` so the vision model can be any provider
 *      registered in OmniRoute (`google/gemini-2.0-flash`,
 *      `openrouter/...`, etc.) instead of being limited to OpenAI/Anthropic.
 *   2. `OPENAI_API_URL` env var (legacy)
 *   3. OmniRoute self-loop (`http://localhost:20128/v1`) — auto-detected when
 *      the model uses a known OmniRoute-internal provider (e.g. `kr/`, `if/`,
 *      `pol/`, `groq/`, etc.) instead of a direct OpenAI/Anthropic endpoint.
 *   4. `https://api.openai.com/v1` (fallback when the model is `openai/*` or
 *      unprefixed — works only when the operator actually has an OpenAI
 *      account and OPENAI_API_KEY set)
 *
 * @param model - Optional model identifier used to detect non-standard providers
 *                that require OmniRoute self-loop routing.
 */
export function resolveVisionBridgeBaseUrl(model?: string): string {
  const explicit = (process.env.VISION_BRIDGE_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const legacy = (process.env.OPENAI_API_URL || "").trim();
  if (legacy) return legacy.replace(/\/+$/, "");

  // When the model has a non-standard provider prefix (not openai/ or
  // anthropic/), it can only be resolved through OmniRoute's own router,
  // not through a direct OpenAI/Anthropic endpoint. Use the operator-configured
  // port via OMNIROUTE_PORT / PORT env vars, falling back to the default 20128.
  if (model && model.includes("/")) {
    const provider = model.split("/")[0].toLowerCase();
    if (provider !== "openai" && provider !== "anthropic") {
      const { port } = getRuntimePorts();
      return `http://localhost:${port}/v1`;
    }
  }

  return "https://api.openai.com/v1";
}

export interface ImagePart {
  messageIndex: number;
  /**
   * Path (indices/keys) from the message to the image-bearing node.
   * `[]` means the message content itself was the image (bare data-URI string).
   */
  partPath: Array<number | string>;
  imageUrl: string;
  imageType: "image_url" | "image" | "input_image" | "string" | "image-src";
}

export interface RequestMessage {
  role?: string;
  content?: string | RequestContentPart[];
}

export type RequestContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/**
 * Extract image parts from messages array.
 *
 * #8488-mirror: the combo capability gate detects images via a deep recursive
 * scan (valueContainsImagePart): strings starting with `data:image/`, parts of
 * type image/image_url/input_image, `image_url`/`input_image` keys, and any
 * source.media_type starting with `image/` (incl. URL-type Anthropic sources).
 * This helper must detect the SAME shapes, or images the gate sees will 400
 * before the bridge ever runs (e.g. bare data-URI strings in tool_results).
 */
export function extractImageParts(messages: RequestMessage[]): ImagePart[] {
  const results: ImagePart[] = [];

  if (!Array.isArray(messages)) {
    return results;
  }

  const scan = (
    value: unknown,
    depth: number,
    path: Array<number | string>,
    messageIndex: number
  ): void => {
    if (depth > 8 || value === null || value === undefined) return;

    if (typeof value === "string") {
      if (value.startsWith("data:image/")) {
        results.push({ messageIndex, partPath: path, imageUrl: value, imageType: "string" });
      }
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        scan(value[i], depth + 1, [...path, i], messageIndex);
      }
      return;
    }

    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const type = typeof obj.type === "string" ? (obj.type as string).toLowerCase() : null;

    if (
      type === "image" ||
      type === "image_url" ||
      type === "input_image" ||
      "image_url" in obj ||
      "input_image" in obj
    ) {
      let url: string | null = null;
      const imageUrlObj =
        typeof obj.image_url === "object" && obj.image_url !== null
          ? (obj.image_url as Record<string, unknown>)
          : null;
      if (imageUrlObj && typeof imageUrlObj.url === "string") {
        url = imageUrlObj.url;
      } else {
        const src =
          typeof obj.source === "object" && obj.source !== null
            ? (obj.source as Record<string, unknown>)
            : null;
        if (src) {
          if (typeof src.url === "string") {
            url = src.url;
          } else if (
            src.type === "base64" &&
            typeof src.media_type === "string" &&
            typeof src.data === "string"
          ) {
            url = `data:${src.media_type};base64,${src.data}`;
          }
        }
      }
      if (url) {
        results.push({ messageIndex, partPath: path, imageUrl: url, imageType: "image" });
      }
      return; // do not descend into an image node
    }

    const src =
      typeof obj.source === "object" && obj.source !== null
        ? (obj.source as Record<string, unknown>)
        : null;
    if (
      src &&
      typeof src.media_type === "string" &&
      src.media_type.toLowerCase().startsWith("image/")
    ) {
      results.push({
        messageIndex,
        partPath: path,
        imageUrl: typeof src.url === "string" ? src.url : "",
        imageType: "image-src",
      });
      return;
    }

    for (const key of Object.keys(obj)) {
      scan(obj[key], depth + 1, [...path, key], messageIndex);
    }
  };

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const message = messages[msgIdx];
    if (!message) continue;
    scan(message.content, 0, [], msgIdx);
  }

  return results;
}

/**
 * Resolve image URL to data URI format for vision model.
 * - HTTP/HTTPS URLs: passed through as-is
 * - Data URIs: passed through as-is
 * - Base64 without media type: assumed PNG
 */
export function resolveImageAsDataUri(imageUrl: string): string {
  if (!imageUrl || typeof imageUrl !== "string") {
    throw new Error("Invalid image URL: must be a non-empty string");
  }

  // Already a data URI
  if (imageUrl.startsWith("data:")) {
    return imageUrl;
  }

  // HTTP/HTTPS URL - vision API will fetch it
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    return imageUrl;
  }

  // Assume it's a base64 string without prefix
  // Add PNG as default media type
  return `data:image/png;base64,${imageUrl}`;
}

async function fetchRemoteImageAsDataUri(imageUrl: string, signal: AbortSignal): Promise<string> {
  const remoteImage = await fetchRemoteImage(imageUrl, { signal });
  const mediaType = remoteImage.contentType.split(";")[0]?.trim() || "image/png";
  return `data:${mediaType};base64,${remoteImage.buffer.toString("base64")}`;
}

async function normalizeVisionImageInput(
  imageInput: string,
  isAnthropic: boolean,
  signal: AbortSignal
): Promise<string> {
  const normalizedImage = resolveImageAsDataUri(imageInput);

  if (
    isAnthropic &&
    (normalizedImage.startsWith("http://") || normalizedImage.startsWith("https://"))
  ) {
    return fetchRemoteImageAsDataUri(normalizedImage, signal);
  }

  return normalizedImage;
}

export interface VisionModelConfig {
  model: string;
  prompt: string;
  timeoutMs: number;
  maxImages: number;
}

/**
 * Call the vision model to get an image description.
 * Supports both OpenAI-compatible and Anthropic API formats.
 * Uses auto-routing to select the fastest available model.
 */
export async function callVisionModel(
  imageDataUri: string,
  config: VisionModelConfig,
  apiKey?: string,
  routerConfig?: Partial<import("./visionBridgeRouter").VisionBridgeRouterConfig>
): Promise<string> {
  // Auto-select the best vision model if not explicitly configured
  const modelToUse = await getBestVisionModel({
    fixedModel: config.model,
    ...routerConfig,
  });
  let lastError: Error | null = null;

  // Try primary model + fallbacks
  const modelsToTry = [modelToUse, ...(await getFallbackModels(modelToUse, routerConfig))];
  const maxAttempts = Math.min(modelsToTry.length, routerConfig?.maxFallbackAttempts ?? 3);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentModel = modelsToTry[attempt];
    const attemptStart = Date.now();
    try {
      const result = await callVisionModelSingle(
        imageDataUri,
        { ...config, model: currentModel },
        apiKey
      );
      recordLatency(currentModel, Date.now() - attemptStart, true);
      return result;
    } catch (error) {
      recordLatency(currentModel, Date.now() - attemptStart, false);
      lastError = error instanceof Error ? error : new Error(String(error));
      // Continue to next model on failure
    }
  }

  // All models failed
  throw lastError || new Error("All vision models failed");
}

/**
 * Internal function to call a single vision model.
 */
async function callVisionModelSingle(
  imageDataUri: string,
  config: VisionModelConfig,
  apiKey?: string
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  // Resolve API key based on provider
  const resolvedApiKey = resolveProviderApiKey(config.model, apiKey);

  // Detect provider from model identifier
  const isAnthropic = config.model.startsWith("anthropic/");

  try {
    // Extract model name from provider/model format
    const modelName = config.model.includes("/") ? config.model.split("/")[1] : config.model;
    const normalizedImageInput = await normalizeVisionImageInput(
      imageDataUri,
      isAnthropic,
      controller.signal
    );

    let response: Response;

    if (isAnthropic) {
      // Anthropic API path
      const anthropicBaseUrl = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com";

      // Parse data URI to extract media type and base64 data
      const matches = normalizedImageInput.match(/^data:([^;]+);base64,(.+)$/);
      let mediaType = "image/png";
      let base64Data = normalizedImageInput;

      if (matches) {
        mediaType = matches[1];
        base64Data = matches[2];
      }

      response = await fetch(`${anthropicBaseUrl}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "x-api-key": resolvedApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: base64Data,
                  },
                },
                {
                  type: "text",
                  text: config.prompt,
                },
              ],
            },
          ],
          max_tokens: 300,
        }),
      });
    } else {
      // OpenAI-compatible path (default) — issue #2232: honor
      // VISION_BRIDGE_BASE_URL so the vision-bridge call can be routed through
      // OmniRoute itself or any other OpenAI-compatible endpoint instead of
      // hardcoded api.openai.com.
      const baseUrl = resolveVisionBridgeBaseUrl(config.model);

      // When routing through the OmniRoute self-loop (non-standard provider),
      // keep the full provider-prefixed model ID so OmniRoute can resolve the
      // correct provider backend. Only strip the prefix for direct OpenAI calls.
      const useFullModelId =
        baseUrl.startsWith("http://localhost") &&
        config.model.includes("/") &&
        !config.model.startsWith("openai/");
      const requestModel = useFullModelId ? config.model : modelName;

      // Build headers with optional recursion guard for self-loop calls.
      // When routing through OmniRoute's own API, omit the vision-bridge
      // guardrail on the sub-request to prevent infinite recursion.
      // Use sk_omniroute as fallback for self-loop if no API key is resolved.
      const selfLoopApiKey = resolvedApiKey || "sk_omniroute";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${selfLoopApiKey}`,
      };
      if (useFullModelId) {
        headers["x-omniroute-disabled-guardrails"] = "vision-bridge";
      }

      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: requestModel,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: normalizedImageInput,
                    detail: "low",
                  },
                },
                { type: "text", text: config.prompt },
              ],
            },
          ],
          max_tokens: 300,
        }),
      });
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Vision API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    if (isAnthropic) {
      // Anthropic response format: { content: [{ type: "text", text: "..." }] }
      const anthropicData = data as {
        content?: Array<{ type?: string; text?: string }>;
        error?: { message?: string };
      };

      if (anthropicData.error) {
        throw new Error(
          `Vision API error: ${anthropicData.error.message || JSON.stringify(anthropicData.error)}`
        );
      }

      const textContent = anthropicData.content?.find((c) => c.type === "text");
      const content = textContent?.text;
      if (!content || typeof content !== "string") {
        throw new Error("Vision API returned empty or invalid response");
      }

      return content.trim();
    } else {
      // OpenAI-compatible response format: { choices: [{ message: { content: "..." } }] }
      const openaiData = data as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };

      if (openaiData.error) {
        throw new Error(
          `Vision API error: ${openaiData.error.message || JSON.stringify(openaiData.error)}`
        );
      }

      const content = openaiData.choices?.[0]?.message?.content;
      if (!content || typeof content !== "string") {
        throw new Error("Vision API returned empty or invalid response");
      }

      return content.trim();
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Vision model call timed out");
    }

    throw error;
  }
}

export interface RequestBody {
  model?: string;
  messages?: RequestMessage[];
  [key: string]: unknown;
}

/**
 * Replace image content parts with text descriptions.
 * Concatenates descriptions with labels: "[Image 1]: ..."
 */
export function replaceImageParts(
  body: RequestBody,
  // #4012: a `null` entry means the describe call failed for that image — keep
  // the original image part instead of dropping it / stubbing "(unavailable)".
  descriptions: (string | null)[]
): RequestBody {
  if (!descriptions || descriptions.length === 0) {
    return body;
  }

  const result = structuredClone(body) as RequestBody;

  if (!Array.isArray(result.messages)) {
    return result;
  }

  // Re-extract on the clone so hits are aligned with the same traversal order
  // the bridge used (extractImageParts now mirrors the gate's recursive scan).
  const hits = extractImageParts(result.messages as RequestMessage[]);
  let descriptionIndex = 0;

  for (const hit of hits) {
    if (descriptionIndex >= descriptions.length) break;
    const description = descriptions[descriptionIndex++];
    if (description == null) {
      // #4012: describe failed for this image — preserve the original
      // image so a vision-capable upstream can still process it.
      continue;
    }

    const message = result.messages?.[hit.messageIndex];
    if (!message) continue;

    if (hit.partPath.length === 0) {
      // The message content itself was a bare data-URI image string.
      (message as { content?: unknown }).content = description;
      continue;
    }

    // Paths are relative to message.content (extractImageParts scans content).
    let node: unknown = (message as Record<string, unknown>).content;
    if (node === null || typeof node !== "object") continue;
    for (let i = 0; i < hit.partPath.length - 1; i++) {
      if (node === null || typeof node !== "object") break;
      node = (node as Record<string, unknown>)[hit.partPath[i]];
    }
    if (node === null || typeof node !== "object") continue;
    const last = hit.partPath[hit.partPath.length - 1];
    const previous = (node as Record<string, unknown>)[last];
    (node as Record<string, unknown>)[last] =
      typeof previous === "object" && previous !== null && !Array.isArray(previous)
        ? { type: "text", text: description }
        : description;
  }

  return result;
}
