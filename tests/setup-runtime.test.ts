import { afterAll, describe, expect, it, vi } from "vitest";
const viTest = vi;
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url); const dir = mkdtempSync(join(tmpdir(), "pi-translate-setup-runtime-")); process.env.PI_CODING_AGENT_DIR = dir;
const configPath = join(dir, "pi-translate-x.json"); const originalConfig = { version: 1, enabled: false, input: true, output: true, targetLanguage: "Japanese", provider: "keep", model: "keep-model", displayMode: "bilingual", timeoutMs: 5000 }; writeFileSync(configPath, JSON.stringify(originalConfig));
const core = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core"); const { createExtensionRuntime, loadExtensionFromFactory } = require(join(core, "extensions/loader.js")); const { ExtensionRunner } = require(join(core, "extensions/runner.js")); const { createEventBus } = require(join(core, "event-bus.js")); const { SessionManager } = require(join(core, "session-manager.js"));
const { default: register } = await import("../src/index.js"); afterAll(() => rmSync(dir, { recursive: true, force: true }));
const model = { provider: "available", id: "selected", name: "Selected", api: "fake", baseUrl: "https://fake.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 10000, maxTokens: 1000 };
function harness(ui: any) {
  const session = SessionManager.inMemory("/tmp", { id: "setup-session" }); const runtime = createExtensionRuntime();
  const registry = { find: () => model, hasConfiguredAuth: () => true, getAvailableOfType: async () => [model], complete: vi.fn(async () => new Promise<any>(() => {})) };
  const ext = loadExtensionFromFactory(register, "/tmp", createEventBus(), runtime, "setup-test.ts");
  return ext.then((loaded: any) => { const runner = new ExtensionRunner([loaded], runtime, "/tmp", session, registry); runtime.assertActive = () => {}; runner.setUIContext(ui, "tui"); runner.bindCore({ sendMessage() {}, sendUserMessage() {}, appendEntry() {}, setSessionName() {}, getSessionName: () => undefined, setLabel() {}, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools() {}, refreshTools() {}, getCommands: () => [], setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel() {} } as never, { getModel: () => model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false, getSignal: () => undefined, abort() {}, hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => "" }); return { runner, session, registry, command: runner.getCommand("translate-x")! }; });
}

describe("setup command lifecycle with installed ExtensionRunner", () => {
  it("initial dialog cancellation leaves original config untouched", async () => {
    let prompts = 0; const ui = { notify: vi.fn(), input: async () => { prompts++; return undefined; }, select: vi.fn(), custom: vi.fn() };
    const { command, session } = await harness(ui); await command.handler("setup", { mode: "tui", ui, sessionManager: session, modelRegistry: { getAvailableOfType: async () => [model] } } as never);
    expect(prompts).toBe(1); expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(originalConfig);
  });
  it("successful setup persists validated config after stopped model response", async () => {
    const ui = { notify: vi.fn(), input: async () => "French", select: async (title: string) => title.toLowerCase().includes("card") ? "original" : "available/selected", custom: async (factory: Function) => await new Promise<boolean>((resolve) => { factory({}, { fg: (_n: string, s: string) => s }, { matches: () => false }, resolve); resolve(true); }) };
    const { command, session, registry } = await harness(ui); registry.complete = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: "Bonjour" }] }));
    await command.handler("setup", { mode: "tui", ui, sessionManager: session, modelRegistry: registry } as never);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ enabled: true, targetLanguage: "French", provider: "available", model: "selected", displayMode: "original" });
  });
  it("Escape cancels a never-settling fake provider and clears its timer", async () => {
    vi.useFakeTimers();
    let component: any; let resolveCustom!: (value: boolean) => void; let providerSignal: AbortSignal | undefined;
    const ui = { notify: vi.fn(), input: async () => "French", select: async (title: string) => title.toLowerCase().includes("card") ? "bilingual" : "available/selected", custom: async (factory: Function) => await new Promise<boolean>((resolve) => { resolveCustom = resolve; component = factory({}, { fg: (_n: string, s: string) => s }, { matches: (data: string) => data === "ESC" }, resolve); }) };
    writeFileSync(configPath, JSON.stringify(originalConfig));
    const { command, session, registry } = await harness(ui);
    const originalComplete = registry.complete;
    registry.complete = vi.fn(async (...args: any[]) => { providerSignal = args[2]?.signal; return await originalComplete(...args); });
    const customUi = ui;
    const pending = command.handler("setup", { mode: "tui", ui: customUi, sessionManager: session, modelRegistry: registry } as never);
    for (let i = 0; i < 20 && !component; i++) await viTest.advanceTimersByTimeAsync(0);
    if (!component) throw new Error("setup screen not opened");
    expect(registry.complete).toHaveBeenCalledTimes(1);
    if (!component) throw new Error("setup custom test screen was not entered");
    component.handleInput("ESC"); await expect(pending).resolves.toBeUndefined();
    expect(providerSignal?.aborted).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(originalConfig);
    expect(viTest.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
