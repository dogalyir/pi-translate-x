import { describe, expect, it } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { TranslationServiceClient, TranslationClientError } from "../src/service/client.js";
import {
  CHANNELS,
  PROTOCOL_VERSION,
  type ProtocolAnnounceMessage,
  type ProtocolBatchRequest,
  type ProtocolBatchResponse,
} from "../src/service/protocol.js";

describe("TranslationServiceClient over EventBus", () => {
  it("discovers active service and returns announced capabilities", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    bus.on(CHANNELS.DISCOVER, (data) => {
      const msg = data as { correlationId: string };
      const announce: ProtocolAnnounceMessage = {
        version: PROTOCOL_VERSION,
        correlationId: msg.correlationId,
        server: "pi-translate-x@0.1.2",
        enabled: true,
        inputEnabled: true,
        outputEnabled: true,
        targetLanguage: "Japanese",
        provider: "mock-prov",
        model: "mock-model",
      };
      bus.emit(CHANNELS.ANNOUNCE, announce);
    });

    const result = await client.discover(500);
    expect(result.available).toBe(true);
    expect(result.targetLanguage).toBe("Japanese");
    expect(result.server).toBe("pi-translate-x@0.1.2");
  });

  it("handles discovery timeout when service is absent, defaulting to English standalone", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    const result = await client.discover(50);
    expect(result.available).toBe(false);
    expect(result.targetLanguage).toBe("English");
  });

  it("requests batch translation and verifies correlation and returned items", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    bus.on(CHANNELS.BATCH_REQUEST, (data) => {
      const req = data as ProtocolBatchRequest;
      const resp: ProtocolBatchResponse = {
        version: PROTOCOL_VERSION,
        correlationId: req.correlationId,
        ok: true,
        items: req.items.map((it) => ({
          id: it.id,
          text: `[TR:${it.text}]`,
        })),
      };
      bus.emit(CHANNELS.BATCH_RESPONSE, resp);
    });

    const items = await client.requestBatch({
      correlationId: "req-1",
      sessionId: "s1",
      branchId: "b1",
      direction: "to_target",
      targetLanguage: "Spanish",
      timeoutMs: 1000,
      items: [
        { id: "q1", text: "Question 1" },
        { id: "q2", text: "Question 2" },
      ],
    });

    expect(items).toHaveLength(2);
    expect(items[0]?.text).toBe("[TR:Question 1]");
    expect(items[1]?.text).toBe("[TR:Question 2]");
  });

  it("throws mapping_integrity error if response omits requested field IDs", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    bus.on(CHANNELS.BATCH_REQUEST, (data) => {
      const req = data as ProtocolBatchRequest;
      const resp: ProtocolBatchResponse = {
        version: PROTOCOL_VERSION,
        correlationId: req.correlationId,
        ok: true,
        items: [{ id: "q1", text: "Only Q1 translated" }], // q2 is missing!
      };
      bus.emit(CHANNELS.BATCH_RESPONSE, resp);
    });

    await expect(
      client.requestBatch({
        correlationId: "req-missing-id",
        sessionId: "s1",
        branchId: "b1",
        direction: "to_target",
        targetLanguage: "Spanish",
        timeoutMs: 1000,
        items: [
          { id: "q1", text: "Question 1" },
          { id: "q2", text: "Question 2" },
        ],
      }),
    ).rejects.toThrow(/missing expected field IDs: q2/i);
  });

  it("emits cancel and rejects when signal is aborted", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    let cancelReceived = false;
    bus.on(CHANNELS.CANCEL, (data) => {
      const msg = data as { correlationId: string; reason: string };
      if (msg.correlationId === "req-abort") {
        cancelReceived = true;
      }
    });

    const controller = new AbortController();
    const promise = client.requestBatch(
      {
        correlationId: "req-abort",
        sessionId: "s1",
        branchId: "b1",
        direction: "to_target",
        targetLanguage: "German",
        timeoutMs: 5000,
        items: [{ id: "q1", text: "Question 1" }],
      },
      controller.signal,
    );

    controller.abort("User clicked cancel");
    await expect(promise).rejects.toThrow(/Request aborted/);
    expect(cancelReceived).toBe(true);
  });

  it("rejects when batch request times out", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    let cancelReceived = false;
    bus.on(CHANNELS.CANCEL, (data) => {
      const msg = data as { correlationId: string; reason: string };
      if (msg.correlationId === "req-timeout") {
        cancelReceived = true;
      }
    });

    const promise = client.requestBatch({
      correlationId: "req-timeout",
      sessionId: "s1",
      branchId: "b1",
      direction: "to_target",
      targetLanguage: "French",
      timeoutMs: 50, // very fast timeout
      items: [{ id: "q1", text: "Question 1" }],
    });

    await expect(promise).rejects.toThrow(/timed out/);
    expect(cancelReceived).toBe(true);
  });

  it("enforces max concurrent requests limit", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus, maxConcurrency: 2 });

    // Start 2 requests that never settle immediately
    void client.requestBatch({
      correlationId: "c1",
      sessionId: "s1",
      branchId: "b1",
      direction: "to_target",
      targetLanguage: "French",
      timeoutMs: 5000,
      items: [{ id: "q1", text: "Q1" }],
    });
    void client.requestBatch({
      correlationId: "c2",
      sessionId: "s1",
      branchId: "b1",
      direction: "to_target",
      targetLanguage: "French",
      timeoutMs: 5000,
      items: [{ id: "q2", text: "Q2" }],
    });

    // 3rd request exceeds limit of 2
    await expect(
      client.requestBatch({
        correlationId: "c3",
        sessionId: "s1",
        branchId: "b1",
        direction: "to_target",
        targetLanguage: "French",
        timeoutMs: 5000,
        items: [{ id: "q3", text: "Q3" }],
      }),
    ).rejects.toThrow(/Max concurrent requests \(2\) reached/);
  });

  it("splits large batches into bounded chunks of max 64 items with all-or-nothing exact ID resolution", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    const receivedChunks: ProtocolBatchRequest[] = [];
    bus.on(CHANNELS.BATCH_REQUEST, (data) => {
      const req = data as ProtocolBatchRequest;
      receivedChunks.push(req);
      const resp: ProtocolBatchResponse = {
        version: PROTOCOL_VERSION,
        correlationId: req.correlationId,
        ok: true,
        items: req.items.map((it) => ({
          id: it.id,
          text: `[TR:${it.text}]`,
        })),
      };
      bus.emit(CHANNELS.BATCH_RESPONSE, resp);
    });

    // 100 items: exceeds single server limit of 64
    const requestedItems = Array.from({ length: 100 }, (_, i) => ({
      id: `field_${i}`,
      text: `Text field number ${i}`,
    }));

    const result = await client.requestBatch({
      correlationId: "chunked-req",
      sessionId: "s1",
      branchId: "b1",
      direction: "to_target",
      targetLanguage: "Spanish",
      items: requestedItems,
      timeoutMs: 5000,
    });

    expect(receivedChunks).toHaveLength(2);
    expect(receivedChunks[0]?.items.length).toBe(64);
    expect(receivedChunks[1]?.items.length).toBe(36);
    // Every chunk complies with server max 64 limit
    for (const chunk of receivedChunks) {
      expect(chunk.items.length).toBeLessThanOrEqual(64);
    }

    expect(result).toHaveLength(100);
    expect(result[0]?.id).toBe("field_0");
    expect(result[99]?.id).toBe("field_99");
    expect(result[99]?.text).toBe("[TR:Text field number 99]");
  });

  it("fails immediately before provider when a single field exceeds 30,000 characters", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    let requestEmitted = false;
    bus.on(CHANNELS.BATCH_REQUEST, () => {
      requestEmitted = true;
    });

    const oversizedText = "x".repeat(30_001);
    await expect(
      client.requestBatch({
        correlationId: "req-oversized",
        sessionId: "s1",
        branchId: "b1",
        direction: "to_target",
        targetLanguage: "French",
        items: [{ id: "big_field", text: oversizedText }],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exceeds server maximum limit of 30000 characters/);

    // Verifies NO request was sent to provider over the bus
    expect(requestEmitted).toBe(false);
  });

  it("all-or-nothing guarantee: cancellation mid-chunking aborts and yields no partial projection", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });
    const controller = new AbortController();

    let chunkCount = 0;
    const cancelledIds: string[] = [];
    bus.on(CHANNELS.CANCEL, (data: any) => {
      cancelledIds.push(data.correlationId);
    });

    bus.on(CHANNELS.BATCH_REQUEST, (data) => {
      const req = data as ProtocolBatchRequest;
      chunkCount++;
      if (chunkCount === 1) {
        // Return first chunk successfully
        const resp: ProtocolBatchResponse = {
          version: PROTOCOL_VERSION,
          correlationId: req.correlationId,
          ok: true,
          items: req.items.map((it) => ({ id: it.id, text: `[TR:${it.text}]` })),
        };
        bus.emit(CHANNELS.BATCH_RESPONSE, resp);
      } else {
        // Abort on second chunk
        controller.abort("User aborted flow");
      }
    });

    const requestedItems = Array.from({ length: 80 }, (_, i) => ({
      id: `item_${i}`,
      text: `Text ${i}`,
    }));

    await expect(
      client.requestBatch(
        {
          correlationId: "req-cancel-chunk",
          sessionId: "s1",
          branchId: "b1",
          direction: "to_target",
          targetLanguage: "Spanish",
          items: requestedItems,
          timeoutMs: 5000,
        },
        controller.signal,
      ),
    ).rejects.toThrow(/Request aborted/);

    expect(cancelledIds.length).toBeGreaterThan(0);
  });
});
