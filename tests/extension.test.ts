import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { SettingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
import { InMemoryCredentialStore, createProvider, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession as createSdkSession } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js";
import { DefaultResourceLoader } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js";

function createMockPi() {
  const events = new Map<string, Function>(); const renderers = new Map<string, Function>(); const commands = new Map<string, unknown>();
  const pi = { on: (name: string, fn: Function) => { events.set(name, fn); return () => events.delete(name); }, registerEntryRenderer: (name: string, fn: Function) => renderers.set(name, fn), registerCommand: (name: string, command: unknown) => commands.set(name, command), appendEntry: vi.fn() } as unknown as ExtensionAPI;
  return { pi, events, renderers, commands };
}
const inertContext = { mode: "tui", hasUI: true, sessionManager: { getHeader: () => null, getBranch: () => [] } };
const contextWithSession = (id: string, branch: string[] = []) => ({ ...inertContext, sessionManager: { getHeader: () => ({ id, timestamp: "now", cwd: "/tmp" }), getBranch: () => branch.map((entryId) => ({ type: "custom", id: entryId, parentId: null, timestamp: "now", customType: "other" })) } });
async function loadExtension() { return (await import("../src/index.js")).default; }

describe("extension contracts", () => {
  it("performs installed Pi CLI help/discovery smoke in isolated agent dir", () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-translate-x-harness-"));
    try {
      const output = execFileSync(process.execPath, ["node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "--no-extensions", "--extension", "./src/index.ts", "--help"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: temp } });
      expect(output).toContain("Usage:");
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it("dispatches configured input through the real ExtensionRunner/session hook with a fake model", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-translate-x-runtime-"));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = temp;
    try {
      writeFileSync(join(temp, "pi-translate-x.json"), JSON.stringify({ version: 1, enabled: true, input: true, output: true, targetLanguage: "French", provider: "fake", model: "test-model", displayMode: "bilingual", timeoutMs: 5000 }));
      vi.resetModules();
      const register = await loadExtension();
      const fake = fauxProvider({ provider: "fake", api: "faux", models: [{ id: "test-model", name: "Test", input: ["text"] }] });
      fake.setResponses([fauxAssistantMessage("Hello there"), fauxAssistantMessage("Hi again"), fauxAssistantMessage("Reply in French")]);
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("fake", async () => ({ type: "api_key", key: "fake-test-key" }));
      const runtime = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js").then(({ ModelRuntime }) => ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false }));
      runtime.registerNativeProvider(fake.provider);
      runtime.hasConfiguredAuth = () => true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const model = runtime.getModel("fake", "test-model")!;
      const sessionManager = SessionManager.inMemory("/tmp");
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({ cwd: "/tmp", agentDir: temp, settingsManager, extensionFactories: [{ name: "pi-translate-x-test", factory: await loadExtension() }], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await resourceLoader.reload();
      const sessionResult = await createSdkSession({ cwd: "/tmp", agentDir: temp, modelRuntime: runtime, model, sessionManager, settingsManager, resourceLoader, noTools: "all" });
      const { session } = sessionResult;
      const ui = { notify: vi.fn(), setStatus: vi.fn(), input: vi.fn(), select: vi.fn(), confirm: vi.fn(), custom: vi.fn(), getEditorText: () => "draft", setEditorText: vi.fn() };
      await session.bindExtensions({ uiContext: ui as never, mode: "tui" });
      const commands = session.extensionRunner.getRegisteredCommands();
      expect(commands.some((command) => command.name === "translate-x")).toBe(true);
      await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
      const inputResult = await session.extensionRunner.emitInput("Bonjour le monde", undefined, "interactive");
      if (inputResult.action !== "transform") throw new Error(`Configured input failed: ${JSON.stringify(inputResult)} notifications=${JSON.stringify(ui.notify.mock.calls)}`);
      const saved = sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-translate-x:input");
      expect(saved).toHaveLength(1);
      const projection = sessionManager.buildSessionProjection();
      expect(JSON.stringify(projection.messages)).not.toContain("Bonjour le monde");
      expect(session.extensionRunner.getEntryRenderer("pi-translate-x:input")).toBeDefined();
      sessionManager.appendCustomEntry("test:leaf-growth", {});
      const secondInput = await session.extensionRunner.emitInput("¿Puedes ayudarme?", undefined, "interactive", "followUp");
      if (secondInput.action !== "transform") throw new Error(`Second configured input failed: ${JSON.stringify(secondInput)} notifications=${JSON.stringify(ui.notify.mock.calls)}`);
      expect(fake.state.callCount).toBe(2);
    } finally { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; rmSync(temp, { recursive: true, force: true }); }
  });

  it("supports fresh host context wrappers for the same stable session and branch", async () => {
    const mock = createMockPi(); (await loadExtension())(mock.pi);
    const first = contextWithSession("s1", ["b1"]); await mock.events.get("session_start")!({ type: "session_start", reason: "startup" }, first);
    const second = contextWithSession("s1", ["b1"]); expect(second).not.toBe(first);
    await expect(mock.events.get("input")!({ type: "input", text: "Bonjour", source: "interactive" }, second)).resolves.toEqual({ action: "continue" });
  });

  it("validates and renders only complete durable output records", async () => {
    const mock = createMockPi(); (await loadExtension())(mock.pi);
    const renderer = mock.renderers.get("pi-translate-x:output")!;
    expect(renderer({ data: { version: 2, kind: "output", translated: "x" } }, {}, {})).toBeUndefined();
    expect(mock.renderers.has("pi-translate-x:input")).toBe(true);
  });

  it("registers public hooks/control and remains inert without configuration", async () => {
    const mock = createMockPi(); (await loadExtension())(mock.pi);
    expect(mock.events.has("input")).toBe(true); expect(mock.events.has("turn_end")).toBe(true); expect(mock.events.has("session_start")).toBe(true);
    const result = await mock.events.get("input")!({ type: "input", text: "Bonjour", source: "interactive" }, inertContext);
    expect(result).toEqual({ action: "continue" }); expect(mock.pi.appendEntry).not.toHaveBeenCalled();
  });
});
