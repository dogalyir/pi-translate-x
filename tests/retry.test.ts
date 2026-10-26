import { describe, expect, it, vi } from "vitest";
import { TranslationScheduler } from "../src/core/scheduler.js";
import { createRecord, isDurableTranslationRecord } from "../src/core/records.js";
import type { TranslationRequest } from "../src/core/contracts.js";

const request = (signal = new AbortController().signal): TranslationRequest => ({ requestId: "retry-1", sessionId: "session", branchId: "branch", source: "Hello world", targetLanguage: "French", modelRef: "provider/model", signal });

describe("saved assistant output retry contract", () => {
  it("retries translation from saved source without an agent invocation and persists identity to exact assistant entry", async () => {
    const agent = vi.fn();
    const translator = { translate: vi.fn(async (r: TranslationRequest) => ({ requestId: r.requestId, text: "Bonjour le monde" })) };
    const scheduler = new TranslationScheduler(translator, 2, 1);
    const original = createRecord({ kind: "output", sessionId: "session", branchId: "branch", messageEntryId: "assistant-entry-17", source: "Hello world", translated: "old", targetLanguage: "French", modelRef: "provider/model" });
    expect(isDurableTranslationRecord(original)).toBe(true);
    const retried = await scheduler.submit({ ...request(), requestId: "retry-unique" }, "output");
    const persisted = createRecord({ kind: "output", sessionId: original.sessionId, branchId: original.branchId, messageEntryId: original.messageEntryId!, source: original.source, translated: retried.text, targetLanguage: original.targetLanguage, modelRef: original.modelRef });
    expect(persisted.messageEntryId).toBe("assistant-entry-17");
    expect(persisted.source).toBe(original.source);
    expect(persisted.translated).toBe("Bonjour le monde");
    expect(isDurableTranslationRecord(persisted)).toBe(true);
    expect(agent).not.toHaveBeenCalled();
    expect(translator.translate).toHaveBeenCalledTimes(1);
  });

  it("keeps prior saved translation on retry failure and honors cancellation", async () => {
    const prior = createRecord({ kind: "output", sessionId: "session", branchId: "branch", messageEntryId: "entry", source: "Hello", translated: "Bonjour", targetLanguage: "French", modelRef: "provider/model" });
    const scheduler = new TranslationScheduler({ translate: async () => { throw new Error("provider unavailable"); } }, 2, 1);
    await expect(scheduler.submit(request(), "output")).rejects.toThrow("provider unavailable");
    expect(prior.translated).toBe("Bonjour");
    const controller = new AbortController(); controller.abort();
    await expect(scheduler.submit(request(controller.signal), "output")).rejects.toMatchObject({ code: "aborted" });
  });
});
