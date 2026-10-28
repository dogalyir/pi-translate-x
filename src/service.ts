import { randomUUID } from "node:crypto";
import type { PackageConfig } from "./core/config.js";
import { TranslationError } from "./core/contracts.js";
import { protectLiterals, type ProtectedText } from "./core/protection.js";
import type { TranslationScheduler } from "./core/scheduler.js";
import {
  CHANNELS,
  isBatchCancel,
  isBatchRequest,
  isDiscoverMessage,
  PROTOCOL_VERSION,
  type BatchErrorCode,
  type BatchItem,
  type ProtocolAnnounceMessage,
  type ProtocolBatchResponse,
  type ProtocolSettingsInvalidatedMessage,
} from "./service/protocol.js";

export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ActiveContextLike {
  sessionManager?: {
    getHeader?: () => { id: string; parentSession?: string | undefined } | null | undefined;
    getLeafId?: () => string | null | undefined;
    getBranch?: () => ReadonlyArray<{ id: string; type?: string | undefined }> | undefined;
  };
}

export interface TranslationServiceOptions {
  readonly events: EventBusLike;
  readonly getConfig: () => PackageConfig | undefined;
  readonly getState: () => { readonly configured: boolean; readonly error?: string };
  readonly getScheduler: (settings: PackageConfig) => TranslationScheduler;
  readonly serverVersion?: string;
  readonly maxConcurrentBatches?: number;
  readonly getActiveContext?: () => ActiveContextLike | undefined;
  readonly getSettingsEpoch?: () => number;
}

export function formatDelimitedFields(
  items: readonly { readonly id: string; readonly maskedText: string }[],
  nonce?: string,
): string {
  const prefix = nonce ? `PI_FIELD_${nonce}:` : `FIELD:`;
  return items
    .map((item) => `[${prefix}${item.id}]\n${item.maskedText}\n[/${prefix}${item.id}]`)
    .join("\n\n");
}

export function parseDelimitedFields(
  rawText: string,
  expectedIds: readonly string[],
  nonce?: string,
): Map<string, string> {
  const result = new Map<string, string>();
  const prefix = nonce ? `PI_FIELD_${nonce}:` : `FIELD:`;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `\\[${escapedPrefix}\\s*([a-zA-Z0-9_:-]+)\\s*\\]([\\s\\S]*?)\\[\\/${escapedPrefix}\\s*\\1\\s*\\]`,
    "g",
  );

  let match: RegExpExecArray | null;
  let lastEnd = 0;

  while ((match = regex.exec(rawText)) !== null) {
    const unparsed = rawText.slice(lastEnd, match.index).trim();
    if (unparsed.length > 0) {
      throw new TranslationError(
        "integrity",
        `Extraneous unparsed content outside field delimiters: ${JSON.stringify(unparsed)}`,
      );
    }
    lastEnd = regex.lastIndex;

    const id = match[1]!;
    const content = match[2]!;
    if (result.has(id)) {
      throw new TranslationError("integrity", `Duplicate field ID in translation response: ${id}`);
    }
    result.set(id, content.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
  }

  const trailingUnparsed = rawText.slice(lastEnd).trim();
  if (trailingUnparsed.length > 0) {
    throw new TranslationError(
      "integrity",
      `Extraneous unparsed content after last field delimiter: ${JSON.stringify(trailingUnparsed)}`,
    );
  }

  for (const id of expectedIds) {
    if (!result.has(id)) {
      throw new TranslationError("integrity", `Missing field ID in translation response: ${id}`);
    }
  }
  for (const id of result.keys()) {
    if (!expectedIds.includes(id)) {
      throw new TranslationError("integrity", `Unexpected field ID in translation response: ${id}`);
    }
  }
  return result;
}

export function toBatchErrorCode(error: unknown): BatchErrorCode {
  if (error instanceof TranslationError) {
    switch (error.code) {
      case "unavailable":
        return "unavailable";
      case "timeout":
        return "timeout";
      case "aborted":
        return "aborted";
      case "empty":
        return "empty";
      case "truncated":
        return "truncated";
      case "provider":
        return "provider";
      case "integrity":
        return "mapping_integrity";
      default:
        return "provider";
    }
  }
  return "provider";
}

interface ActiveBatchRecord {
  readonly correlationId: string;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export class TranslationService {
  private readonly events: EventBusLike;
  private readonly getConfig: () => PackageConfig | undefined;
  private readonly getState: () => { readonly configured: boolean; readonly error?: string };
  private readonly getScheduler: (settings: PackageConfig) => TranslationScheduler;
  private readonly serverVersion: string;
  private readonly maxConcurrentBatches: number;
  private readonly getActiveContext?: (() => ActiveContextLike | undefined) | undefined;
  private readonly getSettingsEpoch?: (() => number) | undefined;
  private readonly unsubs: Array<() => void> = [];
  private readonly activeBatches = new Map<string, ActiveBatchRecord>();

  constructor(options: TranslationServiceOptions) {
    this.events = options.events;
    this.getConfig = options.getConfig;
    this.getState = options.getState;
    this.getScheduler = options.getScheduler;
    this.serverVersion = options.serverVersion ?? "0.1.3";
    this.maxConcurrentBatches = options.maxConcurrentBatches ?? 8;
    this.getActiveContext = options.getActiveContext;
    this.getSettingsEpoch = options.getSettingsEpoch;
  }

  public start(): this {
    this.unsubs.push(
      this.events.on(CHANNELS.DISCOVER, (data) => this.handleDiscover(data)),
      this.events.on(CHANNELS.BATCH_REQUEST, (data) => {
        void this.handleBatchRequest(data);
      }),
      this.events.on(CHANNELS.CANCEL, (data) => this.handleCancel(data)),
    );
    return this;
  }

  public stop(): void {
    while (this.unsubs.length > 0) {
      const unsub = this.unsubs.pop()!;
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    this.abortAll("Translation service stopped");
  }

  public abortAll(reason: string): void {
    for (const [correlationId, batch] of Array.from(this.activeBatches.entries())) {
      if (batch.settled) continue;
      batch.settled = true;
      clearTimeout(batch.timer);
      batch.controller.abort(reason);
      if (this.activeBatches.get(correlationId) === batch) {
        this.activeBatches.delete(correlationId);
      }
      this.sendError(correlationId, "aborted", reason);
    }
  }

  public invalidateSettings(epoch?: number): void {
    const config = this.getConfig();
    const state = this.getState();
    const currentEpoch = epoch ?? (this.getSettingsEpoch?.() ?? 0);
    const msg: ProtocolSettingsInvalidatedMessage = {
      version: PROTOCOL_VERSION,
      server: `pi-translate-x@${this.serverVersion}`,
      settingsEpoch: currentEpoch,
      enabled: Boolean(state.configured && config?.enabled),
      targetLanguage: config?.targetLanguage ?? "English",
      provider: config?.provider ?? "",
      model: config?.model ?? "",
    };
    this.events.emit(CHANNELS.SETTINGS_INVALIDATED, msg);
    this.abortAll("Translation settings invalidated");
  }

  private handleDiscover(data: unknown): void {
    if (!isDiscoverMessage(data)) return;
    const config = this.getConfig();
    const state = this.getState();
    const announce: ProtocolAnnounceMessage = {
      version: PROTOCOL_VERSION,
      correlationId: data.correlationId,
      server: `pi-translate-x@${this.serverVersion}`,
      enabled: Boolean(state.configured && config?.enabled),
      inputEnabled: Boolean(state.configured && config?.enabled && config?.input),
      outputEnabled: Boolean(state.configured && config?.enabled && config?.output),
      targetLanguage: config?.targetLanguage ?? "English",
      provider: config?.provider ?? "",
      model: config?.model ?? "",
      settingsEpoch: this.getSettingsEpoch?.() ?? 0,
    };
    this.events.emit(CHANNELS.ANNOUNCE, announce);
  }

  private handleCancel(data: unknown): void {
    if (!isBatchCancel(data)) return;
    const batch = this.activeBatches.get(data.correlationId);
    if (batch && !batch.settled) {
      batch.settled = true;
      clearTimeout(batch.timer);
      batch.controller.abort(data.reason);
      if (this.activeBatches.get(data.correlationId) === batch) {
        this.activeBatches.delete(data.correlationId);
      }
    }
  }

  private async handleBatchRequest(data: unknown): Promise<void> {
    const rawMsg = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
    const correlationId = typeof rawMsg?.["correlationId"] === "string" ? rawMsg["correlationId"] : undefined;

    if (!isBatchRequest(data)) {
      if (correlationId) {
        const errorResponse: ProtocolBatchResponse = {
          version: PROTOCOL_VERSION,
          correlationId,
          ok: false,
          error: {
            code: "invalid_request",
            message: "Malformed or invalid batch request payload",
          },
        };
        this.events.emit(CHANNELS.BATCH_RESPONSE, errorResponse);
      }
      return;
    }

    const request = data;
    const config = this.getConfig();
    const state = this.getState();

    // Questionnaire service translation requests are gated ONLY on the global enabled state,
    // separated from the ordinary human input/assistant output message interception switches.
    if (!state.configured || !config?.enabled) {
      this.sendError(request.correlationId, "disabled", "pi-translate-x is disabled or unconfigured");
      return;
    }

    // Session and active branch membership validation
    const activeCtx = this.getActiveContext?.();
    if (activeCtx) {
      const activeSessionId = activeCtx.sessionManager?.getHeader?.()?.id;
      if (activeSessionId && request.sessionId !== activeSessionId) {
        this.sendError(
          request.correlationId,
          "aborted",
          `Request session "${request.sessionId}" does not match active session "${activeSessionId}"`,
        );
        return;
      }

      const branch = activeCtx.sessionManager?.getBranch?.();
      if (branch && Array.isArray(branch)) {
        const inBranch =
          branch.some((entry) => entry.id === request.branchId) ||
          request.branchId === activeSessionId ||
          activeCtx.sessionManager?.getLeafId?.() === request.branchId;
        if (!inBranch) {
          this.sendError(
            request.correlationId,
            "aborted",
            `Request branch "${request.branchId}" is not in active branch membership`,
          );
          return;
        }
      }
    }

    // Direction and target language validation
    if (request.direction === "to_target") {
      if (request.targetLanguage.trim().toLowerCase() !== config.targetLanguage.trim().toLowerCase()) {
        this.sendError(
          request.correlationId,
          "invalid_request",
          `Requested targetLanguage "${request.targetLanguage}" does not match configured targetLanguage "${config.targetLanguage}"`,
        );
        return;
      }
    } else if (request.direction === "to_english") {
      if (request.targetLanguage.trim().toLowerCase() !== "english") {
        this.sendError(
          request.correlationId,
          "invalid_request",
          `to_english direction requires targetLanguage "English", received "${request.targetLanguage}"`,
        );
        return;
      }
    }

    // Concurrency limit check
    if (this.activeBatches.size >= this.maxConcurrentBatches) {
      this.sendError(request.correlationId, "unavailable", "Max concurrent translation service batches reached");
      return;
    }

    // Optimization: if direction is to_target and target is English, display is already in English
    if (request.direction === "to_target" && request.targetLanguage.trim().toLowerCase() === "english") {
      const immediateResponse: ProtocolBatchResponse = {
        version: PROTOCOL_VERSION,
        correlationId: request.correlationId,
        ok: true,
        items: request.items.map((it) => ({ id: it.id, text: it.text })),
      };
      this.events.emit(CHANNELS.BATCH_RESPONSE, immediateResponse);
      return;
    }

    if (this.activeBatches.has(request.correlationId)) {
      this.sendError(request.correlationId, "invalid_request", "Batch correlation ID already active");
      return;
    }

    const controller = new AbortController();
    const configuredTimeout = config.timeoutMs ?? 60_000;
    const requestedTimeout = request.timeoutMs > 0 ? request.timeoutMs : configuredTimeout;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 1_000), Math.min(configuredTimeout, 120_000));
    let batchRecord!: ActiveBatchRecord;
    const timer = setTimeout(() => {
      if (batchRecord && !batchRecord.settled) {
        batchRecord.settled = true;
        controller.abort("Batch request timed out");
        if (this.activeBatches.get(request.correlationId) === batchRecord) {
          this.activeBatches.delete(request.correlationId);
        }
        this.sendError(request.correlationId, "timeout", `Batch request exceeded ${timeoutMs}ms`);
      }
    }, timeoutMs);

    batchRecord = {
      correlationId: request.correlationId,
      controller,
      timer,
      settled: false,
    };
    this.activeBatches.set(request.correlationId, batchRecord);

    const finishBatch = (sendFn: () => void) => {
      if (batchRecord.settled) return;
      batchRecord.settled = true;
      clearTimeout(timer);
      if (this.activeBatches.get(request.correlationId) === batchRecord) {
        this.activeBatches.delete(request.correlationId);
      }
      sendFn();
    };

    try {
      // Mask literals in each item individually to preserve nonces
      const protectedItems: Array<{ id: string; text: string; protectedText: ProtectedText }> = [];
      let anyProse = false;
      for (const item of request.items) {
        const pt = protectLiterals(item.text);
        if (pt.prose) anyProse = true;
        protectedItems.push({ id: item.id, text: item.text, protectedText: pt });
      }

      // If no item contains any prose at all, return verbatim
      if (!anyProse) {
        finishBatch(() => {
          this.sendSuccess(request.correlationId, request.items.map((it) => ({ id: it.id, text: it.text })));
        });
        return;
      }

      const batchNonce = randomUUID().replace(/-/g, "").slice(0, 12);
      const formattedBatch = formatDelimitedFields(
        protectedItems.map((p) => ({ id: p.id, maskedText: p.protectedText.masked })),
        batchNonce,
      );

      const scheduler = this.getScheduler(config);
      const priority = request.direction === "to_english" ? "input" : "output";
      const modelRef = `${config.provider}/${config.model}`;

      const translationResult = await scheduler.submit(
        {
          requestId: randomUUID(),
          sessionId: request.sessionId,
          branchId: request.branchId,
          source: formattedBatch,
          targetLanguage: request.targetLanguage,
          modelRef,
          timeoutMs,
          signal: controller.signal,
        },
        priority,
      );

      if (controller.signal.aborted || batchRecord.settled) {
        return;
      }

      if (!translationResult.text || !translationResult.text.trim()) {
        throw new TranslationError("empty", "Translation output was empty");
      }

      const expectedIds = request.items.map((it) => it.id);
      const extractedMap = parseDelimitedFields(translationResult.text, expectedIds, batchNonce);

      const restoredItems: BatchItem[] = [];
      for (const p of protectedItems) {
        const extracted = extractedMap.get(p.id)!;
        if (!extracted || !extracted.trim()) {
          throw new TranslationError("empty", `Translation output for field "${p.id}" was empty`);
        }
        const restored = p.protectedText.restore(extracted);
        restoredItems.push({ id: p.id, text: restored });
      }

      finishBatch(() => {
        this.sendSuccess(request.correlationId, restoredItems);
      });
    } catch (error) {
      if (!controller.signal.aborted && !batchRecord.settled) {
        const code = toBatchErrorCode(error);
        const message = error instanceof Error ? error.message : String(error);
        finishBatch(() => {
          this.sendError(request.correlationId, code, message);
        });
      }
    } finally {
      clearTimeout(timer);
      if (this.activeBatches.get(request.correlationId) === batchRecord) {
        this.activeBatches.delete(request.correlationId);
      }
    }
  }

  private sendSuccess(correlationId: string, items: readonly BatchItem[]): void {
    const response: ProtocolBatchResponse = {
      version: PROTOCOL_VERSION,
      correlationId,
      ok: true,
      items,
    };
    this.events.emit(CHANNELS.BATCH_RESPONSE, response);
  }

  private sendError(correlationId: string, code: BatchErrorCode, message: string): void {
    const response: ProtocolBatchResponse = {
      version: PROTOCOL_VERSION,
      correlationId,
      ok: false,
      error: { code, message },
    };
    this.events.emit(CHANNELS.BATCH_RESPONSE, response);
  }
}
