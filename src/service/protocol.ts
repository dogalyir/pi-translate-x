export const PROTOCOL_VERSION = 1 as const;

export const CHANNELS = {
  DISCOVER: "pi-translate:v1:discover",
  ANNOUNCE: "pi-translate:v1:announce",
  BATCH_REQUEST: "pi-translate:v1:batch-request",
  BATCH_RESPONSE: "pi-translate:v1:batch-response",
  CANCEL: "pi-translate:v1:cancel",
  SETTINGS_INVALIDATED: "pi-translate:v1:settings-invalidated",
} as const;

export interface ProtocolDiscoverMessage {
  readonly version: typeof PROTOCOL_VERSION;
  readonly correlationId: string;
  readonly client: string;
}

export interface ProtocolAnnounceMessage {
  readonly version: typeof PROTOCOL_VERSION;
  readonly correlationId: string;
  readonly server: string;
  readonly enabled: boolean;
  readonly inputEnabled: boolean;
  readonly outputEnabled: boolean;
  readonly targetLanguage: string;
  readonly provider: string;
  readonly model: string;
  readonly settingsEpoch?: number;
}

export interface ProtocolSettingsInvalidatedMessage {
  readonly version: typeof PROTOCOL_VERSION;
  readonly server: string;
  readonly settingsEpoch: number;
  readonly enabled: boolean;
  readonly targetLanguage: string;
  readonly provider: string;
  readonly model: string;
}

export interface BatchItem {
  readonly id: string;
  readonly text: string;
}

export type BatchDirection = "to_target" | "to_english";

export interface ProtocolBatchRequest {
  readonly version: typeof PROTOCOL_VERSION;
  readonly correlationId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly direction: BatchDirection;
  readonly sourceLanguage?: string;
  readonly targetLanguage: string;
  readonly items: readonly BatchItem[];
  readonly timeoutMs: number;
}

export type BatchErrorCode =
  | "disabled"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "empty"
  | "truncated"
  | "provider"
  | "invalid_request"
  | "mapping_integrity";

export interface ProtocolBatchResponse {
  readonly version: typeof PROTOCOL_VERSION;
  readonly correlationId: string;
  readonly ok: boolean;
  readonly items?: readonly BatchItem[];
  readonly error?: {
    readonly code: BatchErrorCode;
    readonly message: string;
  };
}

export interface ProtocolBatchCancel {
  readonly version: typeof PROTOCOL_VERSION;
  readonly correlationId: string;
  readonly reason: string;
}

export function isDiscoverMessage(data: unknown): data is ProtocolDiscoverMessage {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg["version"] === PROTOCOL_VERSION && typeof msg["correlationId"] === "string" && typeof msg["client"] === "string";
}

export function isAnnounceMessage(data: unknown): data is ProtocolAnnounceMessage {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg["version"] === PROTOCOL_VERSION &&
    typeof msg["correlationId"] === "string" &&
    typeof msg["server"] === "string" &&
    typeof msg["enabled"] === "boolean" &&
    typeof msg["inputEnabled"] === "boolean" &&
    typeof msg["outputEnabled"] === "boolean" &&
    typeof msg["targetLanguage"] === "string" &&
    typeof msg["provider"] === "string" &&
    typeof msg["model"] === "string"
  );
}

export function isBatchRequest(data: unknown): data is ProtocolBatchRequest {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (
    msg["version"] !== PROTOCOL_VERSION ||
    typeof msg["correlationId"] !== "string" ||
    !msg["correlationId"].trim() ||
    typeof msg["sessionId"] !== "string" ||
    typeof msg["branchId"] !== "string" ||
    (msg["direction"] !== "to_target" && msg["direction"] !== "to_english") ||
    typeof msg["targetLanguage"] !== "string" ||
    typeof msg["timeoutMs"] !== "number" ||
    !Array.isArray(msg["items"])
  ) {
    return false;
  }
  const items = msg["items"] as unknown[];
  if (items.length === 0 || items.length > 64) return false;
  const seenIds = new Set<string>();
  let totalLength = 0;
  for (const item of items) {
    if (typeof item !== "object" || item === null) return false;
    const it = item as Record<string, unknown>;
    if (typeof it["id"] !== "string" || !it["id"].trim() || typeof it["text"] !== "string") return false;
    if (seenIds.has(it["id"])) return false;
    seenIds.add(it["id"]);
    totalLength += it["text"].length;
  }
  return totalLength <= 30_000;
}

export function isBatchResponse(data: unknown): data is ProtocolBatchResponse {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg["version"] !== PROTOCOL_VERSION || typeof msg["correlationId"] !== "string" || typeof msg["ok"] !== "boolean") {
    return false;
  }
  if (msg["ok"]) {
    if (!Array.isArray(msg["items"])) return false;
    for (const item of msg["items"] as unknown[]) {
      if (typeof item !== "object" || item === null) return false;
      const it = item as Record<string, unknown>;
      if (typeof it["id"] !== "string" || typeof it["text"] !== "string") return false;
    }
    return true;
  }
  if (typeof msg["error"] !== "object" || msg["error"] === null) return false;
  const err = msg["error"] as Record<string, unknown>;
  return typeof err["code"] === "string" && typeof err["message"] === "string";
}

export function isBatchCancel(data: unknown): data is ProtocolBatchCancel {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg["version"] === PROTOCOL_VERSION && typeof msg["correlationId"] === "string" && typeof msg["reason"] === "string";
}

export function isSettingsInvalidatedMessage(data: unknown): data is ProtocolSettingsInvalidatedMessage {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg["version"] === PROTOCOL_VERSION &&
    typeof msg["server"] === "string" &&
    typeof msg["settingsEpoch"] === "number" &&
    typeof msg["enabled"] === "boolean" &&
    typeof msg["targetLanguage"] === "string" &&
    typeof msg["provider"] === "string" &&
    typeof msg["model"] === "string"
  );
}
