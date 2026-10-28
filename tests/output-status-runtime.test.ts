import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { TranslationError } from "../src/core/contracts.js";
import { createRecord } from "../src/core/records.js";

const require = createRequire(import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "pi-translate-x-output-status-runtime-"));
process.env.PI_CODING_AGENT_DIR = temp;
const configPath = join(temp, "pi-translate-x.json");
const defaults = {
  version: 1,
  enabled: true,
  input: true,
  output: true,
  targetLanguage: "French",
  provider: "fake",
  model: "fake-model",
  displayMode: "bilingual",
  timeoutMs: 5000,
};
writeFileSync(configPath, JSON.stringify(defaults));

const root = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core");
const { createExtensionRuntime, loadExtensionFromFactory } = require(join(root, "extensions/loader.js"));
const { ExtensionRunner } = require(join(root, "extensions/runner.js"));
const { createEventBus } = require(join(root, "event-bus.js"));
const { SessionManager } = require(join(root, "session-manager.js"));
const { default: register } = await import("../src/index.js");

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitForCondition timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function createHarness(options?: {
  sessionId?: string;
  complete?: (context: any, options: any) => Promise<any> | any;
  mode?: "tui" | "headless" | "rpc";
  setStatusThrows?: boolean;
}) {
  const sessionId = options?.sessionId ?? `status-${Math.random().toString(36).slice(2, 8)}`;
  const model = {
    provider: "fake",
    id: "fake-model",
    name: "Fake",
    api: "fake-api",
    baseUrl: "https://fake.invalid",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 100_000,
    maxTokens: 4096,
  };
  const registry = {
    find: () => model,
    hasConfiguredAuth: () => true,
    complete: async (_m: unknown, context: any, callOptions: any) => {
      if (options?.complete) {
        return options.complete(context, callOptions);
      }
      return fauxAssistantMessage("Translated output text");
    },
  };
  const session = SessionManager.inMemory("/tmp", { id: sessionId });
  const runtime = createExtensionRuntime();
  runtime.assertActive = () => {};
  runtime.trackEventBusSubscription = (fn: () => void) => fn;
  runtime.appendEntry = (type: string, data: unknown) => session.appendCustomEntry(type, data);
  runtime.registerNativeProvider = () => {};
  runtime.registerVirtualModel = () => {};
  runtime.unregisterVirtualModel = () => {};
  runtime.registerProvider = () => {};
  runtime.unregisterProvider = () => {};

  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn((_key: string, _text: string | undefined) => {
      if (options?.setStatusThrows) {
        throw new Error("UI crashed on setStatus");
      }
    }),
    input: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    custom: vi.fn(),
    getEditorText: () => "",
    setEditorText: vi.fn(),
  };

  const ext = await loadExtensionFromFactory(register, "/tmp", createEventBus(), runtime, `ext-${sessionId}.ts`);
  const runner = new ExtensionRunner([ext], runtime, "/tmp", session, registry);
  runner.setUIContext(ui as never, (options?.mode ?? "tui") as never);
  runner.bindCore(
    {
      sendMessage() {},
      sendUserMessage() {},
      appendEntry: runtime.appendEntry,
      setSessionName() {},
      getSessionName: () => undefined,
      setLabel() {},
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}),
      setActiveTools() {},
      refreshTools() {},
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel() {},
    } as never,
    {
      getModel: () => model,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => false,
      getSignal: () => undefined,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
    } as never,
  );

  return { runner, session, registry, ui, runtime, model };
}

async function emitTurnEnd(runner: any, session: any, text: string, turnIndex = 0) {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const messageEntryId = session.appendMessage(message as never);
  await runner.emitBoundary(
    {
      type: "turn_end",
      turnIndex,
      message,
      messageEntryId,
      toolResults: [],
      toolResultEntryIds: [],
    } as never,
    async () => ({
      contextEntries: [],
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    } as never),
  );
  return { message, id: messageEntryId };
}

describe("output status runtime lifecycle in ExtensionRunner", () => {
  it("keeps status visible while deferred auto and queued retry of another saved response are pending until both finish", async () => {
    writeFileSync(configPath, JSON.stringify(defaults));
    const autoStarted = deferred<void>();
    const autoRelease = deferred<string>();
    const retryStarted = deferred<void>();
    const retryRelease = deferred<string>();

    const h = await createHarness({
      sessionId: "deferred-auto-and-retry",
      complete: async (context: any) => {
        const body = JSON.stringify(context.messages);
        if (body.includes("First deferred automatic response")) {
          autoStarted.resolve();
          return fauxAssistantMessage(await autoRelease.promise);
        }
        if (body.includes("Second saved response to retry")) {
          retryStarted.resolve();
          return fauxAssistantMessage(await retryRelease.promise);
        }
        return fauxAssistantMessage("fallback");
      },
    });

    await h.runner.emit({ type: "session_start", reason: "startup" });

    // Seed earlier saved assistant response that we will retry
    const savedMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Second saved response to retry" }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const savedId = h.session.appendMessage(savedMsg as never);

    // Trigger automatic translation for first response
    await emitTurnEnd(h.runner, h.session, "First deferred automatic response", 0);
    await autoStarted.promise;

    // Status was shown
    expect(h.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", "Translating response…");

    // While auto translation is still pending, trigger retry for the second saved message.
    // Because 1 output slot is reserved for input in the scheduler, retry is queued behind auto.
    const retryPromise = h.runner.getCommand("translate-x")!.handler(`retry ${savedId}`, h.runner.createCommandContext());

    // Status is still visible, no duplicate show, no clear
    expect(h.ui.setStatus).toHaveBeenCalledTimes(1);

    // Auto translation completes first
    autoRelease.resolve("Premier message différé traduit");
    await waitForCondition(() =>
      h.session.getBranch().some((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output" && e.data.translated === "Premier message différé traduit"),
    );

    // With auto finished, the queued retry runs now
    await retryStarted.promise;

    // Status MUST NOT be cleared yet because retry is in flight!
    expect(h.ui.setStatus.mock.calls.some(([_, text]) => text === undefined)).toBe(false);

    // Now release retry
    retryRelease.resolve("Deuxième message sauvegardé retraduit");
    await retryPromise;
    await waitForCondition(() =>
      h.session.getBranch().some((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output" && e.data.translated === "Deuxième message sauvegardé retraduit"),
    );

    // Now that both finished, status has cleared
    expect(h.ui.setStatus.mock.calls).toEqual([
      ["pi-translate-x:output", "Translating response…"],
      ["pi-translate-x:output", undefined],
    ]);
  });

  it("releases status on provider rejection and timeout while preserving canonical English", async () => {
    writeFileSync(configPath, JSON.stringify(defaults));
    // Test provider rejection
    const failStarted = deferred<void>();
    const h1 = await createHarness({
      sessionId: "provider-rejection",
      complete: async () => {
        failStarted.resolve();
        throw new Error("Translation provider outage 503");
      },
    });
    await h1.runner.emit({ type: "session_start", reason: "startup" });
    const { id: failId } = await emitTurnEnd(h1.runner, h1.session, "English text surviving rejection", 0);
    await failStarted.promise;
    await waitForCondition(() => h1.ui.setStatus.mock.calls.length >= 2);

    expect(h1.ui.setStatus.mock.calls).toEqual([
      ["pi-translate-x:output", "Translating response…"],
      ["pi-translate-x:output", undefined],
    ]);
    const branch1 = h1.session.getBranch();
    const assistantMsg1 = branch1.find((e: any) => e.type === "message" && e.id === failId);
    expect(assistantMsg1.message.content[0].text).toBe("English text surviving rejection");
    expect(branch1.some((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output")).toBe(false);

    // Test timeout release
    const timeoutStarted = deferred<void>();
    const h2 = await createHarness({
      sessionId: "provider-timeout",
      complete: async () => {
        timeoutStarted.resolve();
        throw new TranslationError("timeout", "Request timed out");
      },
    });
    await h2.runner.emit({ type: "session_start", reason: "startup" });
    const { id: timeoutId } = await emitTurnEnd(h2.runner, h2.session, "English text surviving timeout", 0);
    await timeoutStarted.promise;
    await waitForCondition(() => h2.ui.setStatus.mock.calls.length >= 2);

    expect(h2.ui.setStatus.mock.calls).toEqual([
      ["pi-translate-x:output", "Translating response…"],
      ["pi-translate-x:output", undefined],
    ]);
    const branch2 = h2.session.getBranch();
    const assistantMsg2 = branch2.find((e: any) => e.type === "message" && e.id === timeoutId);
    expect(assistantMsg2.message.content[0].text).toBe("English text surviving timeout");
    expect(branch2.some((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output")).toBe(false);
  });

  it("cleans up status on both retry success and retry failure", async () => {
    writeFileSync(configPath, JSON.stringify(defaults));
    // Retry success
    const hSuccess = await createHarness({
      sessionId: "retry-success",
      complete: async () => fauxAssistantMessage("Retranslated successfully"),
    });
    await hSuccess.runner.emit({ type: "session_start", reason: "startup" });
    const successMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Original assistant response to succeed" }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const sId = hSuccess.session.appendMessage(successMsg as never);
    await hSuccess.runner.getCommand("translate-x")!.handler(`retry ${sId}`, hSuccess.runner.createCommandContext());

    expect(hSuccess.ui.setStatus.mock.calls).toEqual([
      ["pi-translate-x:output", "Translating response…"],
      ["pi-translate-x:output", undefined],
    ]);
    const successCard = hSuccess.session.getBranch().find((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output");
    expect(successCard.data.translated).toBe("Retranslated successfully");

    // Retry failure
    const hFail = await createHarness({
      sessionId: "retry-failure",
      complete: async () => {
        throw new Error("Retry upstream error");
      },
    });
    await hFail.runner.emit({ type: "session_start", reason: "startup" });
    const failMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Original assistant response to fail" }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const fId = hFail.session.appendMessage(failMsg as never);
    await hFail.runner.getCommand("translate-x")!.handler(`retry ${fId}`, hFail.runner.createCommandContext());

    expect(hFail.ui.setStatus.mock.calls).toEqual([
      ["pi-translate-x:output", "Translating response…"],
      ["pi-translate-x:output", undefined],
    ]);
    expect(hFail.session.getBranch().some((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output")).toBe(false);
  });

  it("immediately clears status on off, output-off, settings invalidation, malformed config, session start, tree, and shutdown", async () => {
    writeFileSync(configPath, JSON.stringify(defaults));

    async function setupPendingTranslation(sessionId: string) {
      const started = deferred<void>();
      const release = deferred<string>();
      const h = await createHarness({
        sessionId,
        complete: async () => {
          started.resolve();
          return fauxAssistantMessage(await release.promise);
        },
      });
      await h.runner.emit({ type: "session_start", reason: "startup" });
      await emitTurnEnd(h.runner, h.session, "Deferred long-running prose", 0);
      await started.promise;
      expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", "Translating response…");
      return { h, release };
    }

    // 4a: off command
    {
      writeFileSync(configPath, JSON.stringify(defaults));
      const { h, release } = await setupPendingTranslation("pending-off");
      await h.runner.getCommand("translate-x")!.handler("off", h.runner.createCommandContext());
      expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", undefined);
      release.resolve("resolved after cancel");
    }

    // 4b: output off command
    {
      writeFileSync(configPath, JSON.stringify(defaults));
      const { h, release } = await setupPendingTranslation("pending-output-off");
      await h.runner.getCommand("translate-x")!.handler("output off", h.runner.createCommandContext());
      expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", undefined);
      release.resolve("resolved after cancel");
    }

    // 4c: settings invalidation (changing language/provider/model via command)
    {
      writeFileSync(configPath, JSON.stringify(defaults));
      const { h, release } = await setupPendingTranslation("pending-settings-change");
      writeFileSync(configPath, JSON.stringify({ ...defaults, targetLanguage: "Spanish" }));
      await h.runner.getCommand("translate-x")!.handler("on", h.runner.createCommandContext());
      expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", undefined);
      release.resolve("resolved after cancel");
    }

    // 4d: malformed config encountered
    {
      writeFileSync(configPath, JSON.stringify(defaults));
      const { h, release } = await setupPendingTranslation("pending-malformed-config");
      writeFileSync(configPath, '{"version":1,"malformed":true}');
      await h.runner.getCommand("translate-x")!.handler("on", h.runner.createCommandContext());
      expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", undefined);
      release.resolve("resolved after cancel");
    }

    // 4e: session_start
    {
      writeFileSync(configPath, JSON.stringify(defaults));
      const { h, release } = await setupPendingTranslation("pending-session-start");
      await h.runner.emit({ type: "session_start", reason: "new session" });
      expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", undefined);
      release.resolve("resolved after cancel");
    }

    // 4f: session_tree
    {
      writeFileSync(configPath, JSON.stringify(defaults));
      const { h, release } = await setupPendingTranslation("pending-session-tree");
      await h.runner.emit({ type: "session_tree", newLeafId: "leaf-2", oldLeafId: "leaf-1" });
      expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", undefined);
      release.resolve("resolved after cancel");
    }

    // 4g: session_shutdown
    {
      writeFileSync(configPath, JSON.stringify(defaults));
      const { h, release } = await setupPendingTranslation("pending-session-shutdown");
      await h.runner.emit({ type: "session_shutdown", reason: "quit" });
      expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", undefined);
      release.resolve("resolved after cancel");
    }
  });

  it("prevents an old aborted completion from clearing a newer generation's status", async () => {
    writeFileSync(configPath, JSON.stringify(defaults));
    const job1Started = deferred<void>();
    const job1Release = deferred<string>();
    const job2Started = deferred<void>();
    const job2Release = deferred<string>();

    const h = await createHarness({
      sessionId: "gen-isolation",
      complete: async (context: any) => {
        const body = JSON.stringify(context.messages);
        if (body.includes("Job 1 from generation 1")) {
          job1Started.resolve();
          return fauxAssistantMessage(await job1Release.promise);
        }
        if (body.includes("Job 2 from generation 2")) {
          job2Started.resolve();
          return fauxAssistantMessage(await job2Release.promise);
        }
        return fauxAssistantMessage("fallback");
      },
    });

    await h.runner.emit({ type: "session_start", reason: "startup" });

    // Start Job 1 in generation 1
    await emitTurnEnd(h.runner, h.session, "Job 1 from generation 1", 0);
    await job1Started.promise;
    expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", "Translating response…");

    // Invalidate generation 1 via tree navigation (increments generation to gen 2)
    const root = h.session.appendCustomEntry("root", {});
    await h.runner.emit({ type: "session_tree", newLeafId: root, oldLeafId: h.session.getLeafId() });
    expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", undefined);

    // Start Job 2 in generation 2
    await emitTurnEnd(h.runner, h.session, "Job 2 from generation 2", 1);
    await job2Started.promise;
    expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", "Translating response…");

    // Clear setStatus mock calls so we only see subsequent calls
    h.ui.setStatus.mockClear();

    // Now Job 1 (old generation 1) finishes
    job1Release.resolve("Old job 1 finished late");
    await new Promise((r) => setTimeout(r, 20));

    // Crucial assertion: Job 1 MUST NOT have cleared status for generation 2!
    expect(h.ui.setStatus).not.toHaveBeenCalledWith("pi-translate-x:output", undefined);

    // Now Job 2 finishes
    job2Release.resolve("New job 2 finished");
    await waitForCondition(() =>
      h.session.getBranch().some((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output" && e.data.translated === "New job 2 finished"),
    );

    // Now status IS cleared for generation 2
    expect(h.ui.setStatus).toHaveBeenLastCalledWith("pi-translate-x:output", undefined);
  });

  it("does not start or show status on cache-hit, skipped prose, disabled output, input translation, or non-TUI mode", async () => {
    writeFileSync(configPath, JSON.stringify(defaults));

    // 6a: Cache-hit
    {
      const h = await createHarness({ sessionId: "cache-hit" });
      // Pre-seed cache before session_start so restoreCache loads it
      const seedMsg = { role: "assistant", content: [{ type: "text", text: "Already cached assistant prose." }], stopReason: "stop", timestamp: Date.now() };
      const seedId = h.session.appendMessage(seedMsg as never);
      h.session.appendCustomEntry(
        "pi-translate-x:output",
        createRecord({
          kind: "output",
          sessionId: "cache-hit",
          branchId: "cache-hit",
          messageEntryId: seedId,
          source: "Already cached assistant prose.",
          translated: "Prose déjà en cache.",
          targetLanguage: "French",
          modelRef: "fake/fake-model",
        }),
      );
      await h.runner.emit({ type: "session_start", reason: "startup" });
      await emitTurnEnd(h.runner, h.session, "Already cached assistant prose.", 1);
      await new Promise((r) => setTimeout(r, 15));
      expect(h.ui.setStatus).not.toHaveBeenCalled();
    }

    // 6b: Skipped prose (code blocks only, no letters, or aborted stopReason)
    {
      const h = await createHarness({ sessionId: "skipped" });
      await h.runner.emit({ type: "session_start", reason: "startup" });
      // Message with no prose (only numbers / symbols)
      await emitTurnEnd(h.runner, h.session, "12345 67890 + - = !?", 0);
      // Message with aborted stopReason
      const abortedMsg = { role: "assistant", content: [{ type: "text", text: "Aborted prose" }], stopReason: "aborted", timestamp: Date.now() };
      const abortedId = h.session.appendMessage(abortedMsg as never);
      await h.runner.emitBoundary(
        { type: "turn_end", turnIndex: 1, message: abortedMsg, messageEntryId: abortedId, toolResults: [], toolResultEntryIds: [] } as never,
        async () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false } as never),
      );
      await new Promise((r) => setTimeout(r, 15));
      expect(h.ui.setStatus).not.toHaveBeenCalled();
    }

    // 6c: Disabled globally (enabled: false)
    {
      writeFileSync(configPath, JSON.stringify({ ...defaults, enabled: false }));
      const h = await createHarness({ sessionId: "disabled-global" });
      await h.runner.emit({ type: "session_start", reason: "startup" });
      await emitTurnEnd(h.runner, h.session, "Should not translate when disabled", 0);
      await new Promise((r) => setTimeout(r, 15));
      expect(h.ui.setStatus).not.toHaveBeenCalled();
      writeFileSync(configPath, JSON.stringify(defaults));
    }

    // 6d: Output disabled (output: false)
    {
      writeFileSync(configPath, JSON.stringify({ ...defaults, output: false }));
      const h = await createHarness({ sessionId: "disabled-output" });
      await h.runner.emit({ type: "session_start", reason: "startup" });
      await emitTurnEnd(h.runner, h.session, "Should not translate when output is false", 0);
      await new Promise((r) => setTimeout(r, 15));
      expect(h.ui.setStatus).not.toHaveBeenCalled();
      writeFileSync(configPath, JSON.stringify(defaults));
    }

    // 6e: Input translation (must not show output status)
    {
      const h = await createHarness({
        sessionId: "input-no-status",
        complete: async () => fauxAssistantMessage("Translated user input"),
      });
      await h.runner.emit({ type: "session_start", reason: "startup" });
      const result = await h.runner.emitInput("Bonjour tout le monde", undefined, "interactive");
      expect(result.action).toBe("transform");
      expect(h.ui.setStatus).not.toHaveBeenCalled();
    }

    // 6f: Non-TUI mode (headless or RPC)
    {
      const hRpc = await createHarness({ sessionId: "rpc-mode", mode: "rpc" });
      await hRpc.runner.emit({ type: "session_start", reason: "startup" });
      await emitTurnEnd(hRpc.runner, hRpc.session, "Prose in rpc mode", 0);
      await new Promise((r) => setTimeout(r, 15));
      expect(hRpc.ui.setStatus).not.toHaveBeenCalled();
    }
  });

  it("permits output card persistence and retry completion even when setStatus throws", async () => {
    writeFileSync(configPath, JSON.stringify(defaults));

    // 7a: Automatic output persists despite throwing setStatus
    const hAuto = await createHarness({
      sessionId: "throwing-status-auto",
      setStatusThrows: true,
      complete: async () => fauxAssistantMessage("Translated despite setStatus error"),
    });
    await hAuto.runner.emit({ type: "session_start", reason: "startup" });
    const { id: autoMsgId } = await emitTurnEnd(hAuto.runner, hAuto.session, "Prose during throwing setStatus", 0);

    await waitForCondition(() =>
      hAuto.session.getBranch().some((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output" && e.data.messageEntryId === autoMsgId),
    );
    const autoCard = hAuto.session.getBranch().find((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output" && e.data.messageEntryId === autoMsgId);
    expect(autoCard.data.translated).toBe("Translated despite setStatus error");

    // 7b: Retry succeeds and persists despite throwing setStatus
    const hRetry = await createHarness({
      sessionId: "throwing-status-retry",
      setStatusThrows: true,
      complete: async () => fauxAssistantMessage("Retried despite setStatus error"),
    });
    await hRetry.runner.emit({ type: "session_start", reason: "startup" });
    const savedMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Saved message to retry with throwing setStatus" }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const savedId = hRetry.session.appendMessage(savedMsg as never);

    await hRetry.runner.getCommand("translate-x")!.handler(`retry ${savedId}`, hRetry.runner.createCommandContext());

    await waitForCondition(() =>
      hRetry.session.getBranch().some((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output" && e.data.messageEntryId === savedId),
    );
    const retryCard = hRetry.session.getBranch().find((e: any) => e.type === "custom" && e.customType === "pi-translate-x:output" && e.data.messageEntryId === savedId);
    expect(retryCard.data.translated).toBe("Retried despite setStatus error");
    expect(hRetry.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Assistant response retranslated; agent was not rerun."),
      "info",
    );
  });
});
