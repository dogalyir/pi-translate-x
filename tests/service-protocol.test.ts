import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  CHANNELS,
  PROTOCOL_VERSION,
  type ProtocolAnnounceMessage,
  type ProtocolBatchCancel,
  type ProtocolBatchRequest,
  type ProtocolBatchResponse,
  type ProtocolDiscoverMessage,
} from "../src/service/protocol.js";
import { formatDelimitedFields, parseDelimitedFields, TranslationService } from "../src/service.js";
import { TranslationScheduler } from "../src/core/scheduler.js";
import { TranslationError } from "../src/core/contracts.js";

describe("Service Protocol & Dispatcher", () => {
  it("formats and parses delimited fields with 1:1 ID integrity", () => {
    const items = [
      { id: "q:auth:prompt", maskedText: "Which auth method?" },
      { id: "q:auth:opt:jwt:label", maskedText: "JWT Bearer Tokens" },
      { id: "q:db:opt:pg:label", maskedText: "PostgreSQL" },
    ];
    const formatted = formatDelimitedFields(items);
    expect(formatted).toContain("[FIELD:q:auth:prompt]\nWhich auth method?\n[/FIELD:q:auth:prompt]");
    expect(formatted).toContain("[FIELD:q:auth:opt:jwt:label]\nJWT Bearer Tokens\n[/FIELD:q:auth:opt:jwt:label]");

    const translatedRaw = `
[FIELD:q:auth:prompt]
Quelle méthode d'authentification ?
[/FIELD:q:auth:prompt]

[FIELD:q:auth:opt:jwt:label]
Jetons JWT Bearer
[/FIELD:q:auth:opt:jwt:label]

[FIELD:q:db:opt:pg:label]
PostgreSQL
[/FIELD:q:db:opt:pg:label]
`;
    const parsed = parseDelimitedFields(translatedRaw, ["q:auth:prompt", "q:auth:opt:jwt:label", "q:db:opt:pg:label"]);
    expect(parsed.get("q:auth:prompt")).toBe("Quelle méthode d'authentification ?");
    expect(parsed.get("q:auth:opt:jwt:label")).toBe("Jetons JWT Bearer");
    expect(parsed.get("q:db:opt:pg:label")).toBe("PostgreSQL");
  });

  it("throws mapping integrity error on missing, unexpected, or duplicate IDs", () => {
    const rawMissing = "[FIELD:q1]Hello[/FIELD:q1]";
    expect(() => parseDelimitedFields(rawMissing, ["q1", "q2"])).toThrow(/Missing field ID/);

    const rawUnexpected = "[FIELD:q1]Hello[/FIELD:q1]\n[FIELD:q_alien]Oops[/FIELD:q_alien]";
    expect(() => parseDelimitedFields(rawUnexpected, ["q1"])).toThrow(/Unexpected field ID/);

    const rawDuplicate = "[FIELD:q1]First[/FIELD:q1]\n[FIELD:q1]Second[/FIELD:q1]";
    expect(() => parseDelimitedFields(rawDuplicate, ["q1"])).toThrow(/Duplicate field ID/);
  });

  it("handles discovery and announce through event bus", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: true,
      input: true,
      output: true,
      targetLanguage: "Japanese",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };
    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => ({} as unknown as TranslationScheduler),
      serverVersion: "0.1.3",
    });
    service.start();

    let announced: ProtocolAnnounceMessage | undefined;
    bus.on(CHANNELS.ANNOUNCE, (data) => {
      announced = data as ProtocolAnnounceMessage;
    });

    const discoverMsg: ProtocolDiscoverMessage = {
      version: PROTOCOL_VERSION,
      correlationId: "corr-disc-1",
      client: "pi-ask-user-x@0.1.0",
    };
    bus.emit(CHANNELS.DISCOVER, discoverMsg);

    expect(announced).toBeDefined();
    expect(announced?.correlationId).toBe("corr-disc-1");
    expect(announced?.enabled).toBe(true);
    expect(announced?.inputEnabled).toBe(true);
    expect(announced?.outputEnabled).toBe(true);
    expect(announced?.targetLanguage).toBe("Japanese");
    expect(announced?.server).toBe("pi-translate-x@0.1.3");

    service.stop();
  });

  it("announces disabled when unconfigured or disabled", () => {
    const bus = createEventBus();
    const service = new TranslationService({
      events: bus,
      getConfig: () => undefined,
      getState: () => ({ configured: false, error: "Not configured" }),
      getScheduler: () => ({} as unknown as TranslationScheduler),
    });
    service.start();

    let announced: ProtocolAnnounceMessage | undefined;
    bus.on(CHANNELS.ANNOUNCE, (data) => {
      announced = data as ProtocolAnnounceMessage;
    });

    bus.emit(CHANNELS.DISCOVER, {
      version: PROTOCOL_VERSION,
      correlationId: "corr-disc-2",
      client: "pi-ask-user-x@0.1.0",
    });

    expect(announced?.enabled).toBe(false);
    expect(announced?.inputEnabled).toBe(false);
    expect(announced?.outputEnabled).toBe(false);

    service.stop();
  });

  it("translates batch with literal protection and returns mapped items", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: true,
      input: true,
      output: true,
      targetLanguage: "French",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };

    let submittedSource = "";
    const mockScheduler = new TranslationScheduler({
      translate: async (req) => {
        submittedSource = req.source;
        // Mock translation replacing English words with French words, preserving [FIELD:...] and nonces
        let translated = req.source
          .replace("Database choice", "Choix de base de données")
          .replace("PostgreSQL database", "Base de données PostgreSQL")
          .replace("SQLite database", "Base de données SQLite");
        return { requestId: req.requestId, text: translated };
      },
    }, 2, 1);

    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => mockScheduler,
    });
    service.start();

    const request: ProtocolBatchRequest = {
      version: PROTOCOL_VERSION,
      correlationId: "batch-corr-1",
      sessionId: "sess-1",
      branchId: "branch-1",
      direction: "to_target",
      targetLanguage: "French",
      timeoutMs: 5000,
      items: [
        { id: "q:db:prompt", text: "Database choice: see `config.yaml` or https://db.internal" },
        { id: "q:db:opt:pg:label", text: "PostgreSQL database" },
        { id: "q:db:opt:sqlite:label", text: "SQLite database" },
      ],
    };

    const responsePromise = new Promise<ProtocolBatchResponse>((resolve) => {
      bus.on(CHANNELS.BATCH_RESPONSE, (data) => {
        const resp = data as ProtocolBatchResponse;
        if (resp.correlationId === "batch-corr-1") resolve(resp);
      });
    });

    bus.emit(CHANNELS.BATCH_REQUEST, request);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(response.items).toHaveLength(3);
    const itemMap = new Map(response.items!.map((it) => [it.id, it.text]));

    // Literals `config.yaml` and https://db.internal must be preserved verbatim
    expect(itemMap.get("q:db:prompt")).toContain("Choix de base de données");
    expect(itemMap.get("q:db:prompt")).toContain("`config.yaml`");
    expect(itemMap.get("q:db:prompt")).toContain("https://db.internal");
    expect(itemMap.get("q:db:opt:pg:label")).toBe("Base de données PostgreSQL");
    expect(itemMap.get("q:db:opt:sqlite:label")).toBe("Base de données SQLite");

    service.stop();
  });

  it("handles identical labels with distinct IDs correctly", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: true,
      input: true,
      output: true,
      targetLanguage: "Spanish",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };

    const mockScheduler = new TranslationScheduler({
      translate: async (req) => {
        const translated = req.source.replace(/Yes/g, "Sí");
        return { requestId: req.requestId, text: translated };
      },
    }, 2, 1);

    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => mockScheduler,
    });
    service.start();

    const request: ProtocolBatchRequest = {
      version: PROTOCOL_VERSION,
      correlationId: "batch-corr-identical",
      sessionId: "sess-1",
      branchId: "branch-1",
      direction: "to_target",
      targetLanguage: "Spanish",
      timeoutMs: 5000,
      items: [
        { id: "q:enable_ssl:opt:yes:label", text: "Yes" },
        { id: "q:enable_auth:opt:yes:label", text: "Yes" },
      ],
    };

    const responsePromise = new Promise<ProtocolBatchResponse>((resolve) => {
      bus.on(CHANNELS.BATCH_RESPONSE, (data) => {
        const resp = data as ProtocolBatchResponse;
        if (resp.correlationId === "batch-corr-identical") resolve(resp);
      });
    });

    bus.emit(CHANNELS.BATCH_REQUEST, request);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(response.items).toHaveLength(2);
    expect(response.items?.find((it) => it.id === "q:enable_ssl:opt:yes:label")?.text).toBe("Sí");
    expect(response.items?.find((it) => it.id === "q:enable_auth:opt:yes:label")?.text).toBe("Sí");

    service.stop();
  });

  it("returns items unchanged without calling scheduler when targetLanguage is English for to_target", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: true,
      input: true,
      output: true,
      targetLanguage: "English",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };

    const schedulerSpy = vi.fn();
    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => ({ submit: schedulerSpy } as unknown as TranslationScheduler),
    });
    service.start();

    const request: ProtocolBatchRequest = {
      version: PROTOCOL_VERSION,
      correlationId: "batch-corr-en",
      sessionId: "sess-1",
      branchId: "branch-1",
      direction: "to_target",
      targetLanguage: "English",
      timeoutMs: 5000,
      items: [{ id: "q:1", text: "Select your database" }],
    };

    const responsePromise = new Promise<ProtocolBatchResponse>((resolve) => {
      bus.on(CHANNELS.BATCH_RESPONSE, (data) => {
        const resp = data as ProtocolBatchResponse;
        if (resp.correlationId === "batch-corr-en") resolve(resp);
      });
    });

    bus.emit(CHANNELS.BATCH_REQUEST, request);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(response.items?.[0]?.text).toBe("Select your database");
    expect(schedulerSpy).not.toHaveBeenCalled();

    service.stop();
  });

  it("allows questionnaire translation even if output or input switches are disabled as long as service is enabled", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: true,
      input: false, // ordinary input disabled
      output: false, // ordinary output disabled
      targetLanguage: "German",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };

    const mockScheduler = new TranslationScheduler({
      translate: async (req) => {
        const translated = req.source.replace(/Select your database/g, "Wählen Sie Ihre Datenbank");
        return { requestId: req.requestId, text: translated };
      },
    }, 2, 1);

    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => mockScheduler,
    });
    service.start();

    const request: ProtocolBatchRequest = {
      version: PROTOCOL_VERSION,
      correlationId: "batch-corr-out-disabled",
      sessionId: "sess-1",
      branchId: "branch-1",
      direction: "to_target",
      targetLanguage: "German",
      timeoutMs: 5000,
      items: [{ id: "q:1", text: "Select your database" }],
    };

    const responsePromise = new Promise<ProtocolBatchResponse>((resolve) => {
      bus.on(CHANNELS.BATCH_RESPONSE, (data) => {
        const resp = data as ProtocolBatchResponse;
        if (resp.correlationId === "batch-corr-out-disabled") resolve(resp);
      });
    });

    bus.emit(CHANNELS.BATCH_REQUEST, request);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(response.items?.[0]?.text).toBe("Wählen Sie Ihre Datenbank");

    service.stop();
  });

  it("returns disabled error if global service enabled is false", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: false, // globally disabled
      input: true,
      output: true,
      targetLanguage: "German",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };

    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => ({} as unknown as TranslationScheduler),
    });
    service.start();

    const request: ProtocolBatchRequest = {
      version: PROTOCOL_VERSION,
      correlationId: "batch-corr-globally-disabled",
      sessionId: "sess-1",
      branchId: "branch-1",
      direction: "to_target",
      targetLanguage: "German",
      timeoutMs: 5000,
      items: [{ id: "q:1", text: "Select your database" }],
    };

    const responsePromise = new Promise<ProtocolBatchResponse>((resolve) => {
      bus.on(CHANNELS.BATCH_RESPONSE, (data) => {
        const resp = data as ProtocolBatchResponse;
        if (resp.correlationId === "batch-corr-globally-disabled") resolve(resp);
      });
    });

    bus.emit(CHANNELS.BATCH_REQUEST, request);
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("disabled");

    service.stop();
  });

  it("handles cancellation via CANCEL channel", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: true,
      input: true,
      output: true,
      targetLanguage: "French",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };

    let abortedReason: unknown = undefined;
    let startedPromiseResolve: () => void;
    const startedPromise = new Promise<void>((r) => {
      startedPromiseResolve = r;
    });

    const mockScheduler = new TranslationScheduler({
      translate: async (req) => {
        startedPromiseResolve();
        return new Promise((resolve, reject) => {
          if (req.signal.aborted) {
            abortedReason = req.signal.reason;
            reject(new TranslationError("aborted", "Cancelled by client"));
            return;
          }
          req.signal.addEventListener("abort", () => {
            abortedReason = req.signal.reason;
            reject(new TranslationError("aborted", "Cancelled by client"));
          });
        });
      },
    }, 2, 1);

    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => mockScheduler,
    });
    service.start();

    const request: ProtocolBatchRequest = {
      version: PROTOCOL_VERSION,
      correlationId: "batch-corr-cancel-1",
      sessionId: "sess-1",
      branchId: "branch-1",
      direction: "to_target",
      targetLanguage: "French",
      timeoutMs: 5000,
      items: [{ id: "q:1", text: "Database choice" }],
    };

    bus.emit(CHANNELS.BATCH_REQUEST, request);
    await startedPromise;

    // Cancel the batch
    const cancelMsg: ProtocolBatchCancel = {
      version: PROTOCOL_VERSION,
      correlationId: "batch-corr-cancel-1",
      reason: "User closed questionnaire",
    };
    bus.emit(CHANNELS.CANCEL, cancelMsg);

    await new Promise((r) => setTimeout(r, 50));
    expect(abortedReason).toBe("aborted");

    service.stop();
  });

  it("sends exactly one aborted response to active clients on abortAll", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: true,
      input: true,
      output: true,
      targetLanguage: "Spanish",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };

    let schedulerResolve: (() => void) | undefined;
    const mockScheduler = new TranslationScheduler({
      translate: () => new Promise<any>((_, reject) => {
        schedulerResolve = () => reject(new TranslationError("aborted", "Service invalidation"));
      }),
    }, 2, 1);

    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => mockScheduler,
    });
    service.start();

    const responses: ProtocolBatchResponse[] = [];
    bus.on(CHANNELS.BATCH_RESPONSE, (data) => {
      responses.push(data as ProtocolBatchResponse);
    });

    const request: ProtocolBatchRequest = {
      version: PROTOCOL_VERSION,
      correlationId: "batch-corr-abortall",
      sessionId: "sess-1",
      branchId: "branch-1",
      direction: "to_target",
      targetLanguage: "Spanish",
      timeoutMs: 5000,
      items: [{ id: "q:1", text: "Some question" }],
    };

    bus.emit(CHANNELS.BATCH_REQUEST, request);
    await new Promise((r) => setTimeout(r, 20));

    // Invalidate/abort all
    service.abortAll("Session invalidated");
    schedulerResolve?.();

    await new Promise((r) => setTimeout(r, 50));
    expect(responses).toHaveLength(1);
    expect(responses[0]?.correlationId).toBe("batch-corr-abortall");
    expect(responses[0]?.ok).toBe(false);
    expect(responses[0]?.error?.code).toBe("aborted");

    service.stop();
  });

  it("announces settings invalidation on bus with version and settings epoch", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: true,
      input: true,
      output: true,
      targetLanguage: "German",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };

    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => ({} as unknown as TranslationScheduler),
    });
    service.start();

    let invalidatedMsg: any;
    bus.on(CHANNELS.SETTINGS_INVALIDATED, (data) => {
      invalidatedMsg = data;
    });

    service.invalidateSettings(5);

    expect(invalidatedMsg).toBeDefined();
    expect(invalidatedMsg.version).toBe(PROTOCOL_VERSION);
    expect(invalidatedMsg.settingsEpoch).toBe(5);
    expect(invalidatedMsg.enabled).toBe(true);
    expect(invalidatedMsg.targetLanguage).toBe("German");

    service.stop();
  });

  it("validates session context and active branch membership", async () => {
    const bus = createEventBus();
    const config = {
      version: 1 as const,
      enabled: true,
      input: true,
      output: true,
      targetLanguage: "Spanish",
      provider: "mock-prov",
      model: "mock-model",
      displayMode: "bilingual" as const,
      timeoutMs: 10_000,
    };

    const activeContext = {
      sessionManager: {
        getHeader: () => ({ id: "active-session-123" }),
        getLeafId: () => "leaf-node-1",
        getBranch: () => [{ id: "root-1" }, { id: "entry-active-1" }, { id: "leaf-node-1" }],
      },
    };

    const service = new TranslationService({
      events: bus,
      getConfig: () => config,
      getState: () => ({ configured: true }),
      getScheduler: () => ({} as unknown as TranslationScheduler),
      getActiveContext: () => activeContext,
    });
    service.start();

    const responses: ProtocolBatchResponse[] = [];
    bus.on(CHANNELS.BATCH_RESPONSE, (data) => {
      responses.push(data as ProtocolBatchResponse);
    });

    // 1. Mismatched session ID
    bus.emit(CHANNELS.BATCH_REQUEST, {
      version: PROTOCOL_VERSION,
      correlationId: "req-stale-session",
      sessionId: "stale-session-999",
      branchId: "entry-active-1",
      direction: "to_target",
      targetLanguage: "Spanish",
      timeoutMs: 5000,
      items: [{ id: "q:1", text: "Test text" }],
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(responses[0]?.correlationId).toBe("req-stale-session");
    expect(responses[0]?.ok).toBe(false);
    expect(responses[0]?.error?.code).toBe("aborted");
    expect(responses[0]?.error?.message).toContain("does not match active session");

    // 2. Mismatched branch ID (not in active branch membership)
    bus.emit(CHANNELS.BATCH_REQUEST, {
      version: PROTOCOL_VERSION,
      correlationId: "req-stale-branch",
      sessionId: "active-session-123",
      branchId: "unrelated-branch-entry",
      direction: "to_target",
      targetLanguage: "Spanish",
      timeoutMs: 5000,
      items: [{ id: "q:1", text: "Test text" }],
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(responses[1]?.correlationId).toBe("req-stale-branch");
    expect(responses[1]?.ok).toBe(false);
    expect(responses[1]?.error?.code).toBe("aborted");
    expect(responses[1]?.error?.message).toContain("not in active branch membership");

    service.stop();
  });
});
