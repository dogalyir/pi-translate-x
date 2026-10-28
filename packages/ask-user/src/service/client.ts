import { randomUUID } from "node:crypto";
import {
  CHANNELS,
  isAnnounceMessage,
  isBatchResponse,
  PROTOCOL_VERSION,
  type BatchItem,
  type ProtocolBatchCancel,
  type ProtocolBatchRequest,
  type ProtocolDiscoverMessage,
} from "./protocol.js";

export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export type ServiceDiscoveryStatus =
  | "available"
  | "disabled"
  | "absent"
  | "malformed"
  | "unsupported_version";

export interface ServiceDiscoveryResult {
  readonly status: ServiceDiscoveryStatus;
  readonly available: boolean;
  readonly inputEnabled: boolean;
  readonly outputEnabled: boolean;
  readonly targetLanguage: string;
  readonly provider: string;
  readonly model: string;
  readonly server?: string | undefined;
  readonly error?: string | undefined;
}

export class TranslationClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TranslationClientError";
  }
}

export interface TranslationServiceClientOptions {
  readonly events: EventBusLike;
  readonly clientVersion?: string;
  readonly maxConcurrency?: number;
}

const MAX_SERVER_BATCH_ITEMS = 64;
const MAX_SERVER_BATCH_CHARS = 30_000;

export class TranslationServiceClient {
  private readonly events: EventBusLike;
  private readonly clientVersion: string;
  private readonly maxConcurrency: number;
  private activeCount = 0;

  constructor(options: TranslationServiceClientOptions) {
    this.events = options.events;
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.maxConcurrency = options.maxConcurrency ?? 4;
  }

  public async discover(timeoutMs = 400, signal?: AbortSignal): Promise<ServiceDiscoveryResult> {
    if (signal?.aborted) {
      throw new TranslationClientError("aborted", signal.reason ? String(signal.reason) : "Discovery aborted");
    }

    const correlationId = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;
    let abortListener: (() => void) | undefined;

    return new Promise<ServiceDiscoveryResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (unsub) {
          try {
            unsub();
          } catch {
            /* ignore */
          }
        }
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      };

      if (signal) {
        abortListener = () => {
          cleanup();
          reject(new TranslationClientError("aborted", signal.reason ? String(signal.reason) : "Discovery aborted"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }

      unsub = this.events.on(CHANNELS.ANNOUNCE, (data) => {
        if (typeof data !== "object" || data === null) return;
        const msg = data as Record<string, unknown>;
        if (msg["correlationId"] !== correlationId) return;

        cleanup();

        // Check protocol version
        if (typeof msg["version"] === "number" && msg["version"] !== PROTOCOL_VERSION) {
          resolve({
            status: "unsupported_version",
            available: false,
            inputEnabled: false,
            outputEnabled: false,
            targetLanguage: typeof msg["targetLanguage"] === "string" ? msg["targetLanguage"] : "English",
            provider: typeof msg["provider"] === "string" ? msg["provider"] : "",
            model: typeof msg["model"] === "string" ? msg["model"] : "",
            server: typeof msg["server"] === "string" ? msg["server"] : undefined,
            error: `Unsupported protocol version ${msg["version"]}, expected ${PROTOCOL_VERSION}`,
          });
          return;
        }

        if (!isAnnounceMessage(data)) {
          resolve({
            status: "malformed",
            available: false,
            inputEnabled: false,
            outputEnabled: false,
            targetLanguage: "English",
            provider: "",
            model: "",
            server: typeof msg["server"] === "string" ? msg["server"] : undefined,
            error: "Malformed announce payload received from translation service",
          });
          return;
        }

        resolve({
          status: data.enabled ? "available" : "disabled",
          available: data.enabled,
          inputEnabled: data.inputEnabled,
          outputEnabled: data.outputEnabled,
          targetLanguage: data.targetLanguage,
          provider: data.provider,
          model: data.model,
          server: data.server,
        });
      });

      timer = setTimeout(() => {
        cleanup();
        resolve({
          status: "absent",
          available: false,
          inputEnabled: false,
          outputEnabled: false,
          targetLanguage: "English",
          provider: "",
          model: "",
        });
      }, timeoutMs);

      const discoverMsg: ProtocolDiscoverMessage = {
        version: PROTOCOL_VERSION,
        correlationId,
        client: `pi-ask-user-x@${this.clientVersion}`,
      };
      this.events.emit(CHANNELS.DISCOVER, discoverMsg);
    });
  }

  public async requestBatch(
    request: Omit<ProtocolBatchRequest, "version">,
    signal?: AbortSignal,
  ): Promise<readonly BatchItem[]> {
    if (signal?.aborted) {
      throw new TranslationClientError("aborted", signal.reason ? String(signal.reason) : "Request aborted");
    }

    // 1. Oversized single field validation: fail before calling provider
    for (const item of request.items) {
      if (item.text.length > MAX_SERVER_BATCH_CHARS) {
        throw new TranslationClientError(
          "oversized_field",
          `Field "${item.id}" exceeds server maximum limit of ${MAX_SERVER_BATCH_CHARS} characters (${item.text.length} chars)`,
        );
      }
    }

    if (request.items.length === 0) {
      return [];
    }

    // 2. Bounded chunking: chunk by max items (64) and max chars (30,000)
    const chunks: BatchItem[][] = [];
    let currentChunk: BatchItem[] = [];
    let currentChunkChars = 0;

    for (const item of request.items) {
      const itemLen = item.text.length;
      if (
        currentChunk.length >= MAX_SERVER_BATCH_ITEMS ||
        (currentChunk.length > 0 && currentChunkChars + itemLen > MAX_SERVER_BATCH_CHARS)
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentChunkChars = 0;
      }
      currentChunk.push(item);
      currentChunkChars += itemLen;
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    // Single chunk optimization
    if (chunks.length === 1) {
      return this.executeSingleBatch(request, signal);
    }

    // Multi-chunk execution with all-or-nothing guarantee
    const allItems: BatchItem[] = [];
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      if (signal?.aborted) {
        throw new TranslationClientError("aborted", signal.reason ? String(signal.reason) : "Request aborted");
      }
      const chunkItems = chunks[chunkIdx]!;
      const chunkCorrelationId = `${request.correlationId}:c${chunkIdx}`;
      const chunkReturned = await this.executeSingleBatch(
        {
          ...request,
          correlationId: chunkCorrelationId,
          items: chunkItems,
        },
        signal,
      );
      allItems.push(...chunkReturned);
    }

    // Final mapping integrity verification across all chunks
    const expectedIds = request.items.map((it) => it.id);
    const expectedSet = new Set(expectedIds);
    const seenIds = new Set<string>();

    for (const item of allItems) {
      if (!expectedSet.has(item.id)) {
        throw new TranslationClientError(
          "mapping_integrity",
          `Response contained unexpected field ID: ${item.id}`,
        );
      }
      if (seenIds.has(item.id)) {
        throw new TranslationClientError(
          "mapping_integrity",
          `Response contained duplicate field ID: ${item.id}`,
        );
      }
      seenIds.add(item.id);
    }

    if (allItems.length !== expectedIds.length) {
      throw new TranslationClientError(
        "mapping_integrity",
        `Response count mismatch: expected ${expectedIds.length}, received ${allItems.length}`,
      );
    }

    return allItems;
  }

  private async executeSingleBatch(
    request: Omit<ProtocolBatchRequest, "version">,
    signal?: AbortSignal,
  ): Promise<readonly BatchItem[]> {
    if (signal?.aborted) {
      throw new TranslationClientError("aborted", signal.reason ? String(signal.reason) : "Request aborted");
    }

    if (this.activeCount >= this.maxConcurrency) {
      throw new TranslationClientError("busy", `Max concurrent requests (${this.maxConcurrency}) reached`);
    }

    this.activeCount++;
    const correlationId = request.correlationId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;
    let abortListener: (() => void) | undefined;

    try {
      return await new Promise<readonly BatchItem[]>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (unsub) {
            try {
              unsub();
            } catch {
              /* ignore */
            }
          }
          if (signal && abortListener) {
            signal.removeEventListener("abort", abortListener);
          }
        };

        if (signal) {
          abortListener = () => {
            this.cancel(correlationId, signal.reason ? String(signal.reason) : "Aborted by client");
            cleanup();
            reject(new TranslationClientError("aborted", "Request aborted"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        }

        const timeoutMs = request.timeoutMs ?? 30_000;
        timer = setTimeout(() => {
          this.cancel(correlationId, "Request timeout");
          cleanup();
          reject(new TranslationClientError("timeout", `Batch translation timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        unsub = this.events.on(CHANNELS.BATCH_RESPONSE, (data) => {
          if (!isBatchResponse(data) || data.correlationId !== correlationId) return;
          cleanup();

          if (!data.ok) {
            const errCode = data.error?.code ?? "unknown";
            const errMsg = data.error?.message ?? "Batch translation error";
            reject(new TranslationClientError(errCode, errMsg));
            return;
          }

          const items = data.items ?? [];
          const expectedIds = request.items.map((it) => it.id);
          const expectedSet = new Set(expectedIds);

          const seenReturnedIds = new Set<string>();
          for (const item of items) {
            if (!expectedSet.has(item.id)) {
              reject(
                new TranslationClientError(
                  "mapping_integrity",
                  `Response contained unexpected field ID: ${item.id}`,
                ),
              );
              return;
            }
            if (seenReturnedIds.has(item.id)) {
              reject(
                new TranslationClientError(
                  "mapping_integrity",
                  `Response contained duplicate field ID: ${item.id}`,
                ),
              );
              return;
            }
            seenReturnedIds.add(item.id);
          }

          const missingIds = expectedIds.filter((id) => !seenReturnedIds.has(id));
          if (missingIds.length > 0) {
            reject(
              new TranslationClientError(
                "mapping_integrity",
                `Response missing expected field IDs: ${missingIds.join(", ")}`,
              ),
            );
            return;
          }

          if (items.length !== expectedIds.length) {
            reject(
              new TranslationClientError(
                "mapping_integrity",
                `Response item count mismatch: expected ${expectedIds.length}, received ${items.length}`,
              ),
            );
            return;
          }

          resolve(items);
        });

        const fullRequest: ProtocolBatchRequest = {
          ...request,
          version: PROTOCOL_VERSION,
        };
        this.events.emit(CHANNELS.BATCH_REQUEST, fullRequest);
      });
    } finally {
      this.activeCount--;
    }
  }

  public cancel(correlationId: string, reason = "Cancelled by client"): void {
    const cancelMsg: ProtocolBatchCancel = {
      version: PROTOCOL_VERSION,
      correlationId,
      reason,
    };
    this.events.emit(CHANNELS.CANCEL, cancelMsg);
  }
}
