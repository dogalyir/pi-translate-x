import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { candidateProviders, hasTranslationModelAuth, resolveTranslationModel, resolveTranslationModelSync, type ResolvableModel } from "../src/core/model-resolution.js";
import { TranslationError } from "../src/core/contracts.js";

const require = createRequire(import.meta.url); const temp = mkdtempSync(join(tmpdir(), "pi-translate-x-resolution-")); process.env.PI_CODING_AGENT_DIR = temp;
const configPath = join(temp, "pi-translate-x.json");
writeFileSync(configPath, JSON.stringify({ version: 1, enabled: true, input: true, output: false, targetLanguage: "Spanish", provider: "cliproxyapi", model: "claude-haiku-5-5", displayMode: "bilingual", timeoutMs: 5000 }));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

type M = ResolvableModel & { name?: string };
/** Minimal live registry: providers can be (re)registered at any time, like Pi's ModelRegistry. */
function makeRegistry(initial: Record<string, string[]> = {}, options: { names?: Record<string, string>; auth?: (provider: string) => boolean; status?: (provider: string) => boolean; onRefresh?: (registry: ReturnType<typeof makeRegistry>, opts: any) => void | Promise<void> } = {}) {
  const providers = new Map<string, M[]>(Object.entries(initial).map(([p, ids]) => [p, ids.map((id) => ({ provider: p, id }))]));
  const registry = {
    set(provider: string, ids: string[]) { providers.set(provider, ids.map((id) => ({ provider, id }))); },
    find: (provider: string, id: string) => providers.get(provider)?.find((m) => m.id === id),
    getAll: () => [...providers.values()].flat(),
    hasConfiguredAuth: (model: M) => options.auth ? options.auth(model.provider) : true,
    getProviderAuthStatus: (provider: string) => ({ configured: options.status ? options.status(provider) : false }),
    getProviderDisplayName: (provider: string) => options.names?.[provider] ?? provider,
    refresh: vi.fn(async (opts: any) => { await options.onRefresh?.(registry, opts); return { aborted: false, errors: new Map() }; }),
  };
  return registry;
}

describe("translation model resolution", () => {
  it("uses the exact configured model without refreshing", async () => {
    const registry = makeRegistry({ cliproxyapi: ["claude-haiku-5-5"], cpa: ["claude-haiku-5-5"] });
    const resolved = await resolveTranslationModel(registry, "cliproxyapi", "claude-haiku-5-5");
    expect(resolved).toMatchObject({ resolvedRef: "cliproxyapi/claude-haiku-5-5", fallback: false });
    expect(registry.refresh).not.toHaveBeenCalled();
  });

  it("maps cliproxyapi to the cpa provider of xiangsam/0xRichardH packages and back", async () => {
    const cpaOnly = makeRegistry({ cpa: ["claude-haiku-5-5"] }, { names: { cpa: "CLIProxyAPI (cpa)" } });
    expect(await resolveTranslationModel(cpaOnly, "cliproxyapi", "claude-haiku-5-5")).toMatchObject({ resolvedRef: "cpa/claude-haiku-5-5", fallback: true });
    const routerOnly = makeRegistry({ cliproxyapi: ["claude-haiku-5-5"] }, { names: { cliproxyapi: "CLIProxyAPI" } });
    expect(await resolveTranslationModel(routerOnly, "cpa", "claude-haiku-5-5")).toMatchObject({ resolvedRef: "cliproxyapi/claude-haiku-5-5", fallback: true });
  });

  it("detects renamed CLIProxyAPI providers by display name and matches ids case-insensitively", async () => {
    const registry = makeRegistry({ myproxy: ["Claude-Haiku-5-5"] }, { names: { myproxy: "CLIProxyAPI (myproxy)" } });
    expect(candidateProviders(registry, "cliproxyapi")).toEqual(["cliproxyapi", "myproxy"]);
    expect(resolveTranslationModelSync(registry, "cliproxyapi", "claude-haiku-5-5")?.resolvedRef).toBe("myproxy/Claude-Haiku-5-5");
  });

  it("never reroutes non-CLIProxyAPI providers to another vendor", async () => {
    const registry = makeRegistry({ cpa: ["claude-haiku-5-5"] }, { names: { cpa: "CLIProxyAPI (cpa)" } });
    expect(candidateProviders(registry, "anthropic")).toEqual(["anthropic"]);
    await expect(resolveTranslationModel(registry, "anthropic", "claude-haiku-5-5")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("waits for a late provider registration through one bounded refresh", async () => {
    const registry = makeRegistry({ cpa: ["login-required"] }, { names: { cpa: "CLIProxyAPI (cpa)" }, onRefresh: (r) => r.set("cpa", ["claude-haiku-5-5"]) });
    const resolved = await resolveTranslationModel(registry, "cliproxyapi", "claude-haiku-5-5");
    expect(resolved.resolvedRef).toBe("cpa/claude-haiku-5-5");
    expect(registry.refresh).toHaveBeenCalledTimes(1);
    expect(registry.refresh.mock.calls[0]![0]).toMatchObject({ allowNetwork: true, providers: ["cliproxyapi", "cpa"] });
  });

  it("reports a clear not-found error and does not hammer refresh", async () => {
    const registry = makeRegistry({ cpa: ["other"] }, { names: { cpa: "CLIProxyAPI (cpa)" } });
    const error = await resolveTranslationModel(registry, "cliproxyapi", "claude-haiku-5-5").catch((e) => e);
    expect(error).toBeInstanceOf(TranslationError);
    expect(error.message).toContain("cliproxyapi/claude-haiku-5-5 not found");
    expect(error.message).toContain("cliproxyapi, cpa");
    await resolveTranslationModel(registry, "cliproxyapi", "claude-haiku-5-5").catch(() => undefined);
    expect(registry.refresh).toHaveBeenCalledTimes(1);
  });

  it("accepts stored/provider auth while the availability snapshot lags and prefers authenticated candidates", async () => {
    const lagging = makeRegistry({ cliproxyapi: ["claude-haiku-5-5"] }, { auth: () => false, status: () => true });
    expect((await resolveTranslationModel(lagging, "cliproxyapi", "claude-haiku-5-5")).resolvedRef).toBe("cliproxyapi/claude-haiku-5-5");
    const split = makeRegistry({ cliproxyapi: ["claude-haiku-5-5"], cpa: ["claude-haiku-5-5"] }, { auth: (p) => p === "cpa" });
    expect((await resolveTranslationModel(split, "cliproxyapi", "claude-haiku-5-5")).resolvedRef).toBe("cpa/claude-haiku-5-5");
    const none = makeRegistry({ cliproxyapi: ["claude-haiku-5-5"] }, { auth: () => false });
    await expect(resolveTranslationModel(none, "cliproxyapi", "claude-haiku-5-5")).rejects.toThrow(/no configured authentication/);
    const model = { provider: "cliproxyapi", id: "claude-haiku-5-5" };
    expect(hasTranslationModelAuth(lagging, model)).toBe(true); expect(hasTranslationModelAuth(none, model)).toBe(false);
  });

  it("stops waiting on abort without cancelling the shared refresh", async () => {
    let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
    const registry = makeRegistry({}, { onRefresh: () => gate });
    const controller = new AbortController();
    const pending = resolveTranslationModel(registry, "cliproxyapi", "claude-haiku-5-5", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    finish();
  });

  it("works with minimal registries that only expose find/hasConfiguredAuth", async () => {
    const model = { provider: "fake", id: "m" };
    await expect(resolveTranslationModel({ find: () => model, hasConfiguredAuth: () => true }, "fake", "m")).resolves.toMatchObject({ model });
    await expect(resolveTranslationModel({ find: () => undefined, hasConfiguredAuth: () => true }, "fake", "m")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("extension with a CLIProxyAPI provider package", () => {
  const root = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core");
  const { createExtensionRuntime, loadExtensionFromFactory } = require(join(root, "extensions/loader.js")); const { ExtensionRunner } = require(join(root, "extensions/runner.js")); const { createEventBus } = require(join(root, "event-bus.js")); const { SessionManager } = require(join(root, "session-manager.js"));

  it("translates input through a provider registered after startup under a different id", async () => {
    const { default: register } = await import("../src/index.js");
    const live = new Map<string, any>();
    const registry = {
      find: (provider: string, id: string) => live.get(`${provider}/${id}`),
      getAll: () => [...live.values()],
      hasConfiguredAuth: () => true,
      getProviderDisplayName: (provider: string) => (provider === "cpa" ? "CLIProxyAPI (cpa)" : provider),
      refresh: vi.fn(async () => { live.set("cpa/claude-haiku-5-5", { provider: "cpa", id: "claude-haiku-5-5", name: "Haiku", api: "openai-completions", baseUrl: "http://proxy.invalid/v1", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 100_000, maxTokens: 4096 }); }),
      complete: vi.fn(async (model: any) => fauxAssistantMessage(`Hello via ${model.provider}`)),
    };
    const session = SessionManager.inMemory("/tmp", { id: "cpa-late" }); const runtime = createExtensionRuntime();
    const ext = await loadExtensionFromFactory(register, "/tmp", createEventBus(), runtime, "cpa-late.ts");
    runtime.assertActive = () => {}; runtime.trackEventBusSubscription = (fn: () => void) => fn; runtime.appendEntry = (type: string, data: unknown) => session.appendCustomEntry(type, data); runtime.registerProvider = () => {}; runtime.unregisterProvider = () => {};
    const runner = new ExtensionRunner([ext], runtime, "/tmp", session, registry);
    const ui = { notify: vi.fn(), setStatus: vi.fn(), input: vi.fn(), select: vi.fn(), confirm: vi.fn(), custom: vi.fn(), getEditorText: () => "", setEditorText: vi.fn() };
    runner.setUIContext(ui as never, "tui");
    runner.bindCore({ sendMessage() {}, sendUserMessage() {}, appendEntry: runtime.appendEntry, setSessionName() {}, getSessionName: () => undefined, setLabel() {}, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools() {}, refreshTools() {}, getCommands: () => [], setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel() {} } as never, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false, getSignal: () => undefined, abort() {}, hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => "" });
    await runner.emit({ type: "session_start", reason: "startup" });
    const result = await runner.emitInput("Hola, ¿cómo estás?", undefined, "interactive");
    expect(result).toMatchObject({ action: "transform", text: "Hello via cpa" });
    expect(registry.refresh).toHaveBeenCalledTimes(1);
    await runner.getCommand("translate-x")!.handler("status", runner.createCommandContext());
    expect(ui.notify.mock.calls.some(([m]) => String(m).includes("cliproxyapi/claude-haiku-5-5 → cpa/claude-haiku-5-5"))).toBe(true);
  });
});
