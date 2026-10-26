import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
const require = createRequire(import.meta.url); const root = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core");
const { createExtensionRuntime, loadExtensionFromFactory } = require(join(root, "extensions/loader.js")); const { ExtensionRunner } = require(join(root, "extensions/runner.js")); const { createEventBus } = require(join(root, "event-bus.js")); const { SessionManager } = require(join(root, "session-manager.js"));
const temp = mkdtempSync(join(tmpdir(), "pi-translate-x-output-order-")); process.env.PI_CODING_AGENT_DIR = temp;
const { writeFileSync } = await import("node:fs"); writeFileSync(join(temp, "pi-translate-x.json"), JSON.stringify({ version: 1, enabled: true, input: false, output: true, targetLanguage: "French", provider: "fake", model: "fake", displayMode: "bilingual", timeoutMs: 5000 }));
const { default: register } = await import("../src/index.js"); afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("automatic output commit lane in installed ExtensionRunner", () => {
  it("persists an automatic output card on startup/session generation", async () => {
    const model = { provider: "fake", id: "fake", name: "Fake", api: "fake-api", baseUrl: "https://fake.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 100000, maxTokens: 4096 };
    const registry = { find: () => model, hasConfiguredAuth: () => true, complete: async () => fauxAssistantMessage("automatic success") };
    const session = SessionManager.inMemory("/tmp", { id: "startup-lane-session" }); const runtime = createExtensionRuntime(); runtime.assertActive = () => {}; runtime.trackEventBusSubscription = (fn: () => void) => fn; runtime.registerProvider = () => {}; runtime.registerNativeProvider = () => {}; runtime.registerVirtualModel = () => {}; runtime.unregisterVirtualModel = () => {};
    const ext = await loadExtensionFromFactory(register, "/tmp", createEventBus(), runtime, "startup-output.ts"); const runner = new ExtensionRunner([ext], runtime, "/tmp", session, registry);
    const ui = { notify: vi.fn(), setStatus: vi.fn(), input: vi.fn(), select: vi.fn(), confirm: vi.fn(), custom: vi.fn(), getEditorText: () => "", setEditorText: vi.fn() }; runner.setUIContext(ui as never, "tui"); runtime.appendEntry = (type: string, data: unknown) => { session.appendCustomEntry(type, data); };
    runner.bindCore({ sendMessage() {}, sendUserMessage() {}, appendEntry: runtime.appendEntry, setSessionName() {}, getSessionName: () => undefined, setLabel() {}, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools() {}, refreshTools() {}, getCommands: () => [], setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel() {} } as never, { getModel: () => model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false, getSignal: () => undefined, abort() {}, hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => "" });
    await runner.emit({ type: "session_start", reason: "startup" });
    const assistant = await appendAssistant(session, "automatic assistant response");
    await runner.emitBoundary({ type: "turn_end", turnIndex: 0, message: assistant.message, messageEntryId: assistant.id, toolResults: [], toolResultEntryIds: [] } as never, async () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false } as never));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const card = session.getBranch().find((entry: any) => entry.type === "custom" && entry.customType === "pi-translate-x:output");
    expect(card).toBeDefined(); expect((card as any).data.messageEntryId).toBe(assistant.id); expect((card as any).data.translated).toBe("automatic success");
  });

  it("persists two cached/success outputs in source order despite completion order", async () => {
    const first = deferred<string>(); const started: string[] = [];
    const model = { provider: "fake", id: "fake", name: "Fake", api: "fake-api", baseUrl: "https://fake.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 100000, maxTokens: 4096 };
    const registry = { find: () => model, hasConfiguredAuth: () => true, complete: async (_m: unknown, context: any) => { const body = JSON.stringify(context.messages); if (body.includes("first success")) { started.push("first"); return fauxAssistantMessage(await first.promise); } return fauxAssistantMessage("unused"); } };
    const session = SessionManager.inMemory("/tmp", { id: "two-output-session" }); const runtime = createExtensionRuntime(); runtime.assertActive = () => {}; runtime.trackEventBusSubscription = (f: () => void) => f; runtime.registerProvider = () => {}; runtime.registerNativeProvider = () => {}; runtime.registerVirtualModel = () => {}; runtime.unregisterVirtualModel = () => {};
    const ext = await loadExtensionFromFactory(register, "/tmp", createEventBus(), runtime, "two-output-order.ts"); const runner = new ExtensionRunner([ext], runtime, "/tmp", session, registry); const ui = { notify: vi.fn(), setStatus: vi.fn(), input: vi.fn(), select: vi.fn(), confirm: vi.fn(), custom: vi.fn(), getEditorText: () => "", setEditorText: vi.fn() }; runner.setUIContext(ui as never, "tui"); runtime.appendEntry = (type: string, data: unknown) => { session.appendCustomEntry(type, data); };
    runner.bindCore({ sendMessage() {}, sendUserMessage() {}, appendEntry: runtime.appendEntry, setSessionName() {}, getSessionName: () => undefined, setLabel() {}, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools() {}, refreshTools() {}, getCommands: () => [], setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel() {} } as never, { getModel: () => model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false, getSignal: () => undefined, abort() {}, hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => "" });
    const one = await appendAssistant(session, "first success"); const two = await appendAssistant(session, "second cached"); const { createRecord } = await import("../src/core/records.js");
    session.appendCustomEntry("pi-translate-x:output", createRecord({ kind: "output", sessionId: session.getHeader()!.id, branchId: session.getHeader()!.id, messageEntryId: two.id, source: "second cached", translated: "second translated", targetLanguage: "French", modelRef: "fake/fake" }));
    await runner.emit({ type: "session_start", reason: "startup" });
    const dispatch = (item: any, turnIndex: number) => runner.emitBoundary({ type: "turn_end", turnIndex, message: item.message, messageEntryId: item.id, toolResults: [], toolResultEntryIds: [] } as never, async () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false } as never));
    await Promise.all([dispatch(one, 0), dispatch(two, 1)]); await waitUntil(() => started.length === 1); first.resolve("first translated"); await new Promise((resolve) => setTimeout(resolve, 10));
    const cards = session.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "pi-translate-x:output");
    const auto = cards.filter((entry: any) => [one.id, two.id].includes(entry.data.messageEntryId)).slice(-2);
    expect(auto.map((entry: any) => entry.data.messageEntryId)).toEqual([one.id, two.id]);
    expect(auto.map((entry: any) => entry.data.translated)).toEqual(["first translated", "second translated"]);
  });

  it("persists two automatic outputs in source order despite reverse completion; failed first slot advances; shutdown blocks late cards", async () => {
    const first = deferred<string>(); const second = deferred<string>(); const started: string[] = [];
    const model = { provider: "fake", id: "fake", name: "Fake", api: "fake-api", baseUrl: "https://fake.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 100000, maxTokens: 4096 };
    const registry = { find: () => model, hasConfiguredAuth: () => true, complete: async (_m: unknown, context: any) => { const body = JSON.stringify(context.messages); if (body.includes("first output")) { started.push("first"); return fauxAssistantMessage(await first.promise); } if (body.includes("second output")) { started.push("second"); return fauxAssistantMessage(await second.promise); } return fauxAssistantMessage("unused"); } };
    const session = SessionManager.inMemory("/tmp", { id: "output-session" }); const runtime = createExtensionRuntime(); runtime.assertActive = () => {}; runtime.trackEventBusSubscription = (f: () => void) => f; runtime.registerProvider = () => {}; runtime.registerNativeProvider = () => {}; runtime.registerVirtualModel = () => {}; runtime.unregisterVirtualModel = () => {};
    const ext = await loadExtensionFromFactory(register, "/tmp", createEventBus(), runtime, "output-order.ts"); const runner = new ExtensionRunner([ext], runtime, "/tmp", session, registry);
    const ui = { notify: vi.fn(), setStatus: vi.fn(), input: vi.fn(), select: vi.fn(), confirm: vi.fn(), custom: vi.fn(), getEditorText: () => "", setEditorText: vi.fn() }; runner.setUIContext(ui as never, "tui");
    runtime.appendEntry = (type: string, data: unknown) => { session.appendCustomEntry(type, data); };
    runner.bindCore({ sendMessage() {}, sendUserMessage() {}, appendEntry: runtime.appendEntry, setSessionName() {}, getSessionName: () => undefined, setLabel() {}, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools() {}, refreshTools() {}, getCommands: () => [], setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel() {} } as never, { getModel: () => model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false, getSignal: () => undefined, abort() {}, hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => "" });
    const one = await appendAssistant(session, "first output"); const two = await appendAssistant(session, "cached second output");
    const { createRecord } = await import("../src/core/records.js");
    session.appendCustomEntry("pi-translate-x:output", createRecord({ kind: "output", sessionId: session.getHeader()!.id, branchId: session.getHeader()!.id, messageEntryId: two.id, source: "cached second output", translated: "cached translation", targetLanguage: "French", modelRef: "fake/fake" }));
    const oneCached = await appendAssistant(session, "one already translated");
    session.appendCustomEntry("pi-translate-x:output", createRecord({ kind: "output", sessionId: session.getHeader()!.id, branchId: session.getHeader()!.id, messageEntryId: oneCached.id, source: "one already translated", translated: "cached one", targetLanguage: "French", modelRef: "fake/fake" }));
    await runner.emit({ type: "session_start", reason: "startup" });
    const dispatch = (message: any, entryId: string, turnIndex: number) => runner.emitBoundary({ type: "turn_end", turnIndex, message, messageEntryId: entryId, toolResults: [], toolResultEntryIds: [] } as never, async () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false } as never));
    await Promise.all([dispatch(one.message, one.id, 0), dispatch(two.message, two.id, 1)]);
    await waitUntil(() => started.length === 1);
    first.reject(new Error("first output failed")); await new Promise((r) => setTimeout(r, 10));
    const cards = session.getBranch().filter((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output");
    expect(cards).toHaveLength(3);
    expect(cards.find((card: any) => card.data.messageEntryId === two.id)).toBeDefined();
    expect(cards.some((card: any) => card.data.messageEntryId === one.id)).toBe(false);

    const pending = await appendAssistant(session, "late third output");
    const releaseLate = deferred<string>();
    (registry as any).complete = async (_m: unknown, request: any) => JSON.stringify(request.messages).includes("late third output") ? fauxAssistantMessage(await releaseLate.promise) : fauxAssistantMessage("unused");
    await dispatch(pending.message, pending.id, 2); await new Promise((r) => setTimeout(r, 0));
    await runner.emit({ type: "session_shutdown", reason: "quit" }); releaseLate.resolve("late translation"); await new Promise((r) => setTimeout(r, 10));
    expect(session.getBranch().filter((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output")).toHaveLength(3);
  });
});

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
async function appendAssistant(session: any, text: string) { const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() }; const id = session.appendMessage(message); return { message, id }; }
async function waitUntil(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); } throw new Error("condition timed out"); }
