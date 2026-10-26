import { describe, expect, it } from "vitest";
import { TranslationScheduler } from "../src/core/scheduler.js";

describe("scheduler priority regression", () => {
  it("runs queued input before output while preserving bounded concurrency", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const scheduler = new TranslationScheduler({
      translate: async (request) => {
        calls.push(request.source);
        if (request.source === "blocked-output") await new Promise<void>((resolve) => { release = resolve; });
        return { requestId: request.requestId, text: request.source };
      },
    }, 2, 1);
    const make = (source: string) => ({ requestId: source, sessionId: "s", branchId: "b", source, targetLanguage: "English", modelRef: "p/m", signal: new AbortController().signal });
    const active = scheduler.submit(make("blocked-output"), "output");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queuedOutput = scheduler.submit(make("queued-output"), "output");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queuedInput = scheduler.submit(make("queued-input"), "input");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["blocked-output", "queued-input"]);
    release();
    await Promise.all([active, queuedInput, queuedOutput]);
    expect(calls).toEqual(["blocked-output", "queued-input", "queued-output"]);
  });
});
