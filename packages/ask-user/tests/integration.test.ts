import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { renderQuestionnaireEntry } from "../src/ui/renderer.js";
import { TranslationServiceClient } from "../src/service/client.js";
import { extractTranslatableFields } from "../src/domain/projection.js";
import { UIQueue } from "../src/ui/queue.js";

const require = createRequire(import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "pi-ask-user-x-integration-"));
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

const root = new URL(
  "../../../node_modules/@earendil-works/pi-coding-agent/dist/core",
  import.meta.url,
).pathname;
const { createExtensionRuntime, loadExtensionFromFactory } = require(join(root, "extensions/loader.js"));
const { ExtensionRunner } = require(join(root, "extensions/runner.js"));
const { createEventBus } = require(join(root, "event-bus.js"));
const { SessionManager } = require(join(root, "session-manager.js"));

const { default: registerTranslator } = await import("../../../src/index.js");
const { default: registerQuestionnaire } = await import("../src/index.js");

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

function bindRunner(runner: any, runtime: any, session: any, model: any, ui: any) {
  runtime.assertActive = () => {};
  runtime.trackEventBusSubscription = (fn: () => void) => fn;
  runtime.appendEntry = (type: string, data: unknown) => session.appendCustomEntry(type, data);
  runtime.registerNativeProvider = () => {};
  runtime.registerVirtualModel = () => {};
  runtime.unregisterVirtualModel = () => {};
  runtime.registerProvider = () => {};
  runtime.unregisterProvider = () => {};
  runner.setUIContext(ui as never, "tui");
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
    },
  );
}

function makeTwoExtensionRuntime(
  sessionId: string,
  completeHandler: (messagesText: string) => Promise<string> | string,
  uiOverrides: Record<string, any> = {},
  options: { loadTranslator?: boolean } = {},
) {
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
    complete: async (_m: unknown, context: { messages: Array<{ content?: Array<{ type: string; text?: string }> }> }) => {
      const userMsg = context.messages[context.messages.length - 1];
      const textPart = userMsg?.content?.find((p) => p.type === "text");
      const promptText = textPart?.text ?? "";
      return fauxAssistantMessage(await completeHandler(promptText));
    },
  };

  const bus = createEventBus();
  const session = SessionManager.inMemory("/tmp", { id: sessionId });
  const runtime = createExtensionRuntime();

  const translatorExt = options.loadTranslator !== false
    ? loadExtensionFromFactory(
        registerTranslator,
        "/tmp",
        bus,
        runtime,
        `translator-${sessionId}.ts`,
      )
    : Promise.resolve(undefined as any);
  const questionnaireExt = loadExtensionFromFactory(
    registerQuestionnaire,
    "/tmp",
    bus,
    runtime,
    `questionnaire-${sessionId}.ts`,
  );

  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    input: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    custom: vi.fn(),
    getEditorText: () => "",
    setEditorText: vi.fn(),
    ...uiOverrides,
  };

  return { model, registry, session, runtime, bus, translatorExt, questionnaireExt, ui };
}

describe("Two-Extension ExtensionRunner Integration", () => {
  it("executes forward and reverse batch translation, preserves stable IDs even with duplicate translated labels, and persists context-excluded record", async () => {
    let forwardCalls = 0;
    let reverseCalls = 0;

    const env = makeTwoExtensionRuntime("test-full", async (body) => {
      // Forward translation to French
      if (body.includes("PI_FIELD_") && body.includes("Database")) {
        forwardCalls++;
        // Notice: deliberately translate BOTH 'pg' and 'pg_replica' to identical French label "PostgreSQL"
        // to prove duplicate translated labels retain stable option IDs!
        return body
          .replace("Which database should we use?", "Quelle base de données devrions-nous utiliser ?")
          .replace("Primary PostgreSQL", "PostgreSQL")
          .replace("Replica PostgreSQL", "PostgreSQL")
          .replace("Document database", "Base de données orientée documents");
      }
      // Reverse translation of user custom text & notes back to English
      if (body.includes("PI_FIELD_") && (body.includes("CockroachDB distribuée") || body.includes("Hébergement en France"))) {
        reverseCalls++;
        return body
          .replace("CockroachDB distribuée", "Distributed CockroachDB")
          .replace("Hébergement en France", "Hosted in France")
          .replace("Projet critique", "Critical project");
      }
      return body;
    });

    const [transExt, questExt] = await Promise.all([env.translatorExt, env.questionnaireExt]);
    const runner = new ExtensionRunner([transExt, questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    await runner.emit({ type: "session_start", reason: "startup" });

    // Mock interactive TUI selection
    env.ui.custom = vi.fn().mockImplementation(async (factory: (tui: any, theme: any, keyb: any, done: any) => any) => {
      let resultAction: any;
      const doneSpy = vi.fn((action: any) => {
        resultAction = action;
      });
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        doneSpy,
      );

      // Verify the TUI received translated French question
      expect(comp.render(100).some((l: string) => l.includes("Quelle base de données"))).toBe(true);

      // Select replica PostgreSQL (second option, which translated to duplicate label "PostgreSQL")
      comp.handleInput("\x1b[B"); // move down to replica
      comp.handleInput(" "); // select
      // Enter custom text in French
      comp.handleInput("c");
      for (const ch of "CockroachDB distribuée") comp.handleInput(ch);
      comp.handleInput("\r");
      // Enter question note in French
      comp.handleInput("n");
      for (const ch of "Hébergement en France") comp.handleInput(ch);
      comp.handleInput("\r");

      // Go to Review tab and add global note in French (2 questions: db -> optional_feature -> Review)
      comp.handleInput("\t"); // to optional_feature tab
      comp.handleInput("\t"); // to Review tab
      comp.handleInput("n");
      for (const ch of "Projet critique") comp.handleInput(ch);
      comp.handleInput("\r");

      // Submit
      comp.handleInput("s");
      comp.handleInput("y");
      expect(doneSpy).toHaveBeenCalledTimes(1);
      return resultAction;
    });

    const tool = runner.getToolDefinition("ask_user");
    expect(tool).toBeDefined();
    expect(tool?.exposure).toBe("model-only");
    expect(tool?.label).toBe("Ask User");
    expect(tool?.description).toContain("structured questions");
    expect(tool?.description).toContain("choices");
    expect(tool?.description).toContain("freeform");
    expect(tool?.description?.toLowerCase()).not.toContain("bilingual");
    expect(tool?.description?.toLowerCase()).not.toContain("translation");
    expect(runner.getToolDefinition("bilingual_questionnaire")).toBeUndefined();

    const toolParams = {
      title: "Tech Stack",
      questions: [
        {
          id: "db",
          header: "Database",
          prompt: "Which database should we use?",
          type: "single" as const,
          required: true,
          options: [
            { id: "pg_primary", label: "Primary PostgreSQL" },
            { id: "pg_replica", label: "Replica PostgreSQL" },
            { id: "mongo", label: "Document database" },
          ],
          allowCustom: true,
        },
        {
          id: "optional_feature",
          header: "Optional",
          prompt: "Optional feature flag",
          type: "single" as const,
          required: false,
          options: [{ id: "flag_a", label: "Flag A" }],
        },
      ],
    };

    const toolResult = await tool.execute(
      "call-1",
      toolParams,
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    expect(forwardCalls).toBe(1);
    expect(reverseCalls).toBe(1);

    expect(toolResult.isError).toBeUndefined();
    expect(toolResult.details.version).toBe(1);
    expect(toolResult.details.status).toBe("submitted");

    // Proves: stable ID 'pg_replica' retained and mapped back to author's English label
    const dbAnswer = toolResult.details.answers.find((a: any) => a.questionId === "db");
    expect(dbAnswer.selectedOptionIds).toEqual(["pg_replica"]);
    expect(dbAnswer.selectedOptionLabels).toEqual(["Replica PostgreSQL"]);

    // Proves: custom text and notes reverse-translated to canonical English
    expect(dbAnswer.customText).toBe("Distributed CockroachDB");
    expect(dbAnswer.notes).toBe("Hosted in France");
    expect(toolResult.details.globalUserNotes).toBe("Critical project");

    // Proves: unanswered optional question recorded explicitly
    expect(toolResult.details.unansweredQuestionIds).toEqual(["optional_feature"]);

    // Verify context-excluded session record
    const entries = env.session.getBranch().filter((e: any) => e.type === "custom" && e.customType === "pi-ask-user-x:questionnaire");
    expect(entries).toHaveLength(1);
    const durable = entries[0].data;
    expect(durable.canonical.answers[0].selectedOptionLabels).toEqual(["Replica PostgreSQL"]);
    // Original native text preserved in durable display entry
    expect(durable.display.answers[0].customTextOriginal).toBe("CockroachDB distribuée");
    expect(durable.display.answers[0].notesOriginal).toBe("Hébergement en France");
    expect(durable.display.globalUserNotesOriginal).toBe("Projet critique");

    // Verify session entry renderer functions with zero network calls
    const renderedCard = renderQuestionnaireEntry({ data: durable }, { expanded: true }, {
      bg: (_: any, t: string) => t,
      fg: (_: any, t: string) => t,
      style: (t: string) => t,
    } as any);
    expect(renderedCard).toBeDefined();
  });

  it("handles custom text equaling a predefined label without confusion", async () => {
    const env = makeTwoExtensionRuntime("test-custom-label", async (body) => body);
    const [transExt, questExt] = await Promise.all([env.translatorExt, env.questionnaireExt]);
    const runner = new ExtensionRunner([transExt, questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    await runner.emit({ type: "session_start", reason: "startup" });

    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      let resultAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          resultAction = action;
        },
      );
      // User types "PostgreSQL" into custom text (which matches label of opt 1)
      comp.handleInput("c");
      for (const ch of "PostgreSQL") comp.handleInput(ch);
      comp.handleInput("\r");
      comp.handleInput("\t"); // to Review
      comp.handleInput("s"); // submit
      comp.handleInput("y"); // confirm submit
      return resultAction;
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-custom",
      {
        questions: [
          {
            id: "db",
            header: "Database",
            prompt: "Choose db",
            options: [{ id: "pg_opt", label: "PostgreSQL" }],
            allowCustom: true,
          },
        ],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    // Selected option IDs should NOT include pg_opt because user typed it in custom!
    const ans = result.details.answers[0];
    expect(ans.selectedOptionIds).toEqual([]);
    expect(ans.customText).toBe("PostgreSQL");
  });

  it("runs standalone in English when translation service is absent or disabled", async () => {
    const env = makeTwoExtensionRuntime("test-standalone", async (body) => body, {}, { loadTranslator: false });
    // Only load questionnaire extension without translator extension
    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      let resultAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          resultAction = action;
        },
      );
      // Renders English prompt
      expect(comp.render(100).some((l: string) => l.includes("Pick backend"))).toBe(true);
      comp.handleInput(" "); // select first
      comp.handleInput("\t"); // review
      comp.handleInput("s"); // submit
      comp.handleInput("y"); // confirm submit
      return resultAction;
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-standalone",
      {
        questions: [
          {
            id: "backend",
            header: "Backend",
            prompt: "Pick backend",
            options: [{ id: "node", label: "Node.js" }],
          },
        ],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.details.answers[0].selectedOptionIds).toEqual(["node"]);
    expect(result.details.translatedDisplayLanguage).toBeUndefined();
  });

  it("handles version mismatch or malformed service with explicit degradation warning", async () => {
    const env = makeTwoExtensionRuntime("test-mismatch", async (body) => body, {}, { loadTranslator: false });
    // Emit fake announce with unsupported protocol version
    env.bus.on("pi-translate:v1:discover", (data: any) => {
      env.bus.emit("pi-translate:v1:announce", {
        version: 99, // unsupported version
        correlationId: data.correlationId,
        server: "pi-translate-x@99.0.0",
        enabled: true,
        inputEnabled: true,
        outputEnabled: true,
        targetLanguage: "Spanish",
        provider: "fake",
        model: "fake",
      });
    });

    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      let resultAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          resultAction = action;
        },
      );
      comp.handleInput(" ");
      comp.handleInput("\t");
      comp.handleInput("s");
      comp.handleInput("y");
      return resultAction;
    });

    const tool = runner.getToolDefinition("ask_user")!;
    await tool.execute(
      "call-mismatch",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1", options: [{ id: "o1", label: "Opt 1" }] }],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    // Notification of incompatible service
    expect(env.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/Unsupported protocol version/i),
      "warning",
    );
  });

  it("returns explicit error in headless mode", async () => {
    const env = makeTwoExtensionRuntime("test-headless", async (body) => body, {}, { loadTranslator: false });
    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    const tool = runner.getToolDefinition("ask_user")!;
    const headlessCtx = {
      ...runner.createToolContext(),
      hasUI: false,
      mode: "json",
    };

    const result = await tool.execute(
      "call-headless",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1" }],
      },
      new AbortController().signal,
      () => {},
      headlessCtx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ask_user requires interactive UI mode");
    expect(result.content[0].text).not.toContain("bilingual_questionnaire");
  });

  it("handles cancellation without persisting records or leaking drafts", async () => {
    const env = makeTwoExtensionRuntime("test-cancel", async (body) => body, {}, { loadTranslator: false });
    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      let resultAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          resultAction = action;
        },
      );
      // User presses Esc then y to cancel
      comp.handleInput("\x1b");
      comp.handleInput("y");
      return resultAction;
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-cancel",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1", options: [{ id: "o1", label: "Opt 1" }] }],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("cancelled");

    // Zero durable entries in session
    const entries = env.session.getBranch().filter((e: any) => e.type === "custom" && e.customType === "pi-ask-user-x:questionnaire");
    expect(entries).toHaveLength(0);
  });

  it("fails with explicit error and does not retry or spin when recovery screen returns invalid action or no callback", async () => {
    let providerCalls = 0;
    const env = makeTwoExtensionRuntime("test-invalid-recovery", async () => {
      providerCalls++;
      throw new Error("Simulated translation provider failure");
    });
    const [transExt, questExt] = await Promise.all([env.translatorExt, env.questionnaireExt]);
    const runner = new ExtensionRunner([transExt, questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);
    await runner.emit({ type: "session_start", reason: "startup" });

    // UI custom resolves with undefined (callback never invoked)
    env.ui.custom = vi.fn().mockResolvedValue(undefined);

    const tool = runner.getToolDefinition("ask_user")!;
    await expect(
      tool.execute(
        "call-fail-recovery-undefined",
        {
          questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1" }],
        },
        new AbortController().signal,
        () => {},
        runner.createToolContext(),
      ),
    ).rejects.toThrow(/unexpected UI presenter outcome/i);

    // Verifies it did NOT spin or request provider repeatedly
    expect(providerCalls).toBe(1);

    // Now test with invalid/unexpected action (e.g. submit on recovery screen)
    env.ui.custom = vi.fn().mockResolvedValue({ action: "submit" });
    await expect(
      tool.execute(
        "call-fail-recovery-invalid-action",
        {
          questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1" }],
        },
        new AbortController().signal,
        () => {},
        runner.createToolContext(),
      ),
    ).rejects.toThrow(/unexpected UI presenter action/i);

    // Provider should only have been called one more time (once per execute)
    expect(providerCalls).toBe(2);
  });

  it("fails with explicit error and does not fabricate cancellation when presentation loop returns invalid action or no callback", async () => {
    const env = makeTwoExtensionRuntime("test-invalid-presentation", async (body) => body, {}, { loadTranslator: false });
    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    // UI custom resolves undefined
    env.ui.custom = vi.fn().mockResolvedValue(undefined);

    const tool = runner.getToolDefinition("ask_user")!;
    await expect(
      tool.execute(
        "call-fail-presentation-undefined",
        {
          questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1" }],
        },
        new AbortController().signal,
        () => {},
        runner.createToolContext(),
      ),
    ).rejects.toThrow(/Questionnaire presentation failed: unexpected UI presenter outcome/i);

    // UI custom resolves invalid action
    env.ui.custom = vi.fn().mockResolvedValue({ action: "retry_display" });
    await expect(
      tool.execute(
        "call-fail-presentation-invalid",
        {
          questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1" }],
        },
        new AbortController().signal,
        () => {},
        runner.createToolContext(),
      ),
    ).rejects.toThrow(/Questionnaire presentation failed: unexpected UI presenter action/i);
  });

  it("aborts active flow on translator settings invalidation without appending records", async () => {
    const env = makeTwoExtensionRuntime("test-settings-abort", async (text) => text, {}, { loadTranslator: false });
    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    env.ui.custom = vi.fn().mockImplementation(async (_factory: any) => {
      // Simulate translator settings invalidation while UI is open
      env.bus.emit("pi-translate:v1:settings-invalidated", {
        version: 1,
        server: "pi-translate-x@0.1.2",
        settingsEpoch: 2,
        enabled: false,
        targetLanguage: "Spanish",
        provider: "fake",
        model: "fake",
      });
      // Wait for abort propagation
      await new Promise((r) => setTimeout(r, 20));
      return { action: "cancel" };
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-settings-invalidated",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1", options: [{ id: "o1", label: "O1" }] }],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("aborted");
    expect(result.details.answers).toEqual([]);

    const entries = env.session.getBranch();
    const persisted = entries.find((e: any) => e.customType === "pi-ask-user-x:questionnaire");
    expect(persisted).toBeUndefined();
  });

  it("recovers from answer translation failure by editing drafts and submitting successfully", async () => {
    let reverseCallCount = 0;
    const env = makeTwoExtensionRuntime(
      "test-recovery-loop",
      async (messagesText) => {
        if (messagesText.includes("ans:q1:custom")) {
          reverseCallCount++;
          if (reverseCallCount === 1) {
            throw new Error("Temporary reverse translation failure");
          }
          return "[PI_FIELD_test:ans:q1:custom]\nRecovered English answer\n[/PI_FIELD_test:ans:q1:custom]";
        }
        return `[FIELD:q:q1:header]\nHeader\n[/FIELD:q:q1:header]\n\n[FIELD:q:q1:prompt]\nPrompt\n[/FIELD:q:q1:prompt]\n\n[FIELD:q:q1:opt:o1:label]\nOpt 1\n[/FIELD:q:q1:opt:o1:label]`;
      },
      {},
      { loadTranslator: false },
    );

    // Provide mock translator service over bus
    env.bus.on("pi-translate:v1:discover", (data: any) => {
      env.bus.emit("pi-translate:v1:announce", {
        version: 1,
        correlationId: data.correlationId,
        server: "pi-translate-x@0.1.2",
        enabled: true,
        inputEnabled: true,
        outputEnabled: true,
        targetLanguage: "French",
        provider: "fake",
        model: "fake",
      });
    });

    env.bus.on("pi-translate:v1:batch-request", (data: any) => {
      if (data.direction === "to_english") {
        reverseCallCount++;
        if (reverseCallCount === 1) {
          env.bus.emit("pi-translate:v1:batch-response", {
            version: 1,
            correlationId: data.correlationId,
            ok: false,
            error: { code: "provider", message: "Answer translation temporary error" },
          });
          return;
        }
        env.bus.emit("pi-translate:v1:batch-response", {
          version: 1,
          correlationId: data.correlationId,
          ok: true,
          items: [{ id: "ans:q1:custom", text: "Recovered modified English answer" }],
        });
      } else {
        env.bus.emit("pi-translate:v1:batch-response", {
          version: 1,
          correlationId: data.correlationId,
          ok: true,
          items: [
            { id: "q:q1:header", text: "En-tête" },
            { id: "q:q1:prompt", text: "Question" },
            { id: "q:q1:opt:o1:label", text: "Option 1" },
          ],
        });
      }
    });

    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    let customCallCount = 0;
    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      customCallCount++;
      let resultAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          resultAction = action;
        },
      );

      if (customCallCount === 1) {
        // Initial presentation: set custom text and submit
        comp.state.setCustomText("q1", "Texte en français");
        comp.handleInput("\t");
        comp.handleInput("s");
        comp.handleInput("y");
        return resultAction;
      } else {
        // Recovery dialog: press 'e' to return to edit drafts, modify actual draft, and resubmit
        comp.handleInput("e");
        comp.state.setCustomText("q1", "Texte modifié en français");
        comp.handleInput("\t");
        comp.handleInput("s");
        comp.handleInput("y");
        return resultAction;
      }
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-recovery-test",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1", options: [{ id: "o1", label: "O1" }] }],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.details.status).toBe("submitted");
    expect(result.details.answers[0].customText).toBe("Recovered modified English answer");
  });

  it("aborts active questionnaire and prevents persistence on session_tree navigation", async () => {
    const env = makeTwoExtensionRuntime("test-session-tree", async (text) => text, {}, { loadTranslator: false });
    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    env.ui.custom = vi.fn().mockImplementation(async (_factory: any) => {
      await runner.emit({ type: "session_tree" });
      await new Promise((r) => setTimeout(r, 20));
      return { action: "cancel" };
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-tree-abort",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1", options: [{ id: "o1", label: "O1" }] }],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("aborted");
    expect(result.details.answers).toEqual([]);

    const entries = env.session.getBranch();
    const persisted = entries.find((e: any) => e.customType === "pi-ask-user-x:questionnaire");
    expect(persisted).toBeUndefined();
  });

  it("REAL ExtensionRunner loading both extensions aborts cleanly via actual callback-on-abort without stale persistence", async () => {
    const env = makeTwoExtensionRuntime("test-real-abort", async (text) => text);
    const [transExt, questExt] = await Promise.all([env.translatorExt, env.questionnaireExt]);
    const runner = new ExtensionRunner([transExt, questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);
    await runner.emit({ type: "session_start", reason: "startup" });

    const abortController = new AbortController();

    // UI custom simulates user waiting while external abort fires
    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      let doneAction: any;
      factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          doneAction = action;
        },
      );
      // Trigger external abort signal
      abortController.abort("Parent orchestrator timeout");
      await new Promise((r) => setTimeout(r, 10));
      return doneAction;
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-real-abort",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "Prompt 1" }],
      },
      abortController.signal,
      () => {},
      runner.createToolContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("aborted");

    const entries = env.session.getBranch();
    const persisted = entries.find((e: any) => e.customType === "pi-ask-user-x:questionnaire");
    expect(persisted).toBeUndefined();
  });

  it("safe namespaced setStatus helper tolerates UI setStatus throws without crashing flow", async () => {
    const env = makeTwoExtensionRuntime("test-status-throw", async (text) => text, {}, { loadTranslator: false });
    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    // setStatus throws synchronously
    env.ui.setStatus = vi.fn().mockImplementation(() => {
      throw new Error("Simulated UI setStatus terminal failure");
    });

    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      let doneAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          doneAction = action;
        },
      );
      comp.state.selectOption("q1", "o1");
      comp.handleInput("\t");
      comp.handleInput("s");
      comp.handleInput("y");
      return doneAction;
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-status-throws",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "P1", options: [{ id: "o1", label: "O1" }] }],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    // Succeeded despite setStatus exceptions
    expect(result.isError).toBeUndefined();
    expect(result.details.status).toBe("submitted");
  });

  it("pins answer translation obligation on service disappearance and prevents raw authored submit", async () => {
    const env = makeTwoExtensionRuntime("test-service-disappearance", async (text) => text, {}, { loadTranslator: false });

    let serviceAvailable = true;
    env.bus.on("pi-translate:v1:discover", (data: any) => {
      env.bus.emit("pi-translate:v1:announce", {
        version: 1,
        correlationId: data.correlationId,
        server: "pi-translate-x@0.1.2",
        enabled: serviceAvailable,
        inputEnabled: serviceAvailable,
        outputEnabled: serviceAvailable,
        targetLanguage: "Spanish",
        provider: "fake",
        model: "fake",
      });
    });

    env.bus.on("pi-translate:v1:batch-request", (data: any) => {
      if (data.direction === "to_target") {
        env.bus.emit("pi-translate:v1:batch-response", {
          version: 1,
          correlationId: data.correlationId,
          ok: true,
          items: [
            { id: "q:q1:header", text: "Encabezado" },
            { id: "q:q1:prompt", text: "Pregunta" },
          ],
        });
      }
    });

    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    let customCalls = 0;
    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      customCalls++;
      let doneAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          doneAction = action;
        },
      );

      if (customCalls === 1) {
        // Initial presentation: enter custom text in Spanish
        comp.state.setCustomText("q1", "Mi respuesta personalizada");
        // Service disappears before answer translation!
        serviceAvailable = false;
        comp.handleInput("\t");
        comp.handleInput("s");
        comp.handleInput("y");
        return doneAction;
      } else {
        // Recovery screen shown: cancel because translation service disappeared
        expect(comp.answerError).toMatch(/unavailable/i);
        comp.handleInput("c");
        return doneAction;
      }
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-service-loss",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "P1", allowCustom: true }],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    // Cancels cleanly; raw Spanish custom prose was NEVER submitted to LLM as canonical English
    expect(result.details.status).toBe("cancelled");
    expect(result.details.answers).toEqual([]);
  });

  it("validates answered fields on recovery resubmit and keeps invalid edits recoverably editable", async () => {
    let reverseAttempts = 0;
    const env = makeTwoExtensionRuntime("test-invalid-edits-recovery", async (text) => text, {}, { loadTranslator: false });

    env.bus.on("pi-translate:v1:discover", (data: any) => {
      env.bus.emit("pi-translate:v1:announce", {
        version: 1,
        correlationId: data.correlationId,
        server: "pi-translate-x@0.1.2",
        enabled: true,
        inputEnabled: true,
        outputEnabled: true,
        targetLanguage: "French",
        provider: "fake",
        model: "fake",
      });
    });

    env.bus.on("pi-translate:v1:batch-request", (data: any) => {
      if (data.direction === "to_english") {
        reverseAttempts++;
        if (reverseAttempts === 1) {
          // First attempt fails to trigger answer recovery loop
          env.bus.emit("pi-translate:v1:batch-response", {
            version: 1,
            correlationId: data.correlationId,
            ok: false,
            error: { code: "provider", message: "Initial reverse failure" },
          });
          return;
        }
        // Subsequent attempts succeed
        env.bus.emit("pi-translate:v1:batch-response", {
          version: 1,
          correlationId: data.correlationId,
          ok: true,
          items: [{ id: "ans:q1:custom", text: "valid-answer-english" }],
        });
      } else {
        env.bus.emit("pi-translate:v1:batch-response", {
          version: 1,
          correlationId: data.correlationId,
          ok: true,
          items: [
            { id: "q:q1:header", text: "Q1" },
            { id: "q:q1:prompt", text: "P1" },
          ],
        });
      }
    });

    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    let customCount = 0;
    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      customCount++;
      let doneAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          doneAction = action;
        },
      );

      if (customCount === 1) {
        // Initial presentation: valid custom text
        comp.state.setCustomText("q1", "initial-valid");
        comp.handleInput("\t");
        comp.handleInput("s");
        comp.handleInput("y");
        return doneAction;
      } else {
        // Recovery screen: press 'e' to edit draft answers
        comp.handleInput("e");
        // User first enters invalid text (< 5 chars)
        comp.state.setCustomText("q1", "abc");
        comp.handleInput("\t");
        comp.handleInput("s"); // Attempt submit with invalid draft
        // Submission is blocked in UI with warning; draft is not discarded
        expect(comp.alertMessage).toMatch(/at least 5 characters/i);

        // User fixes draft to valid length and successfully resubmits
        comp.state.setCustomText("q1", "valid-answer-length");
        comp.handleInput("s");
        comp.handleInput("y");
        return doneAction;
      }
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-invalid-edits",
      {
        questions: [{ id: "q1", header: "Q1", prompt: "P1", allowCustom: true, textMinLength: 5 }],
      },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    expect(result.details.status).toBe("submitted");
    expect(result.details.answers[0]?.customText).toBe("valid-answer-english");
    expect(customCount).toBe(2);
  });

  it("handles bounded chunking for 8 questions x 8 options with previews and chrome exceeding server 64 limit", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    const receivedChunks: any[] = [];
    bus.on("pi-translate:v1:batch-request", (data: any) => {
      receivedChunks.push(data);
      // Strictly enforce server bounds: max 64 items and max 30,000 characters
      expect(data.items.length).toBeLessThanOrEqual(64);
      const totalChars = data.items.reduce((acc: number, it: any) => acc + it.text.length, 0);
      expect(totalChars).toBeLessThanOrEqual(30_000);

      const resp = {
        version: 1,
        correlationId: data.correlationId,
        ok: true,
        items: data.items.map((it: any) => ({
          id: it.id,
          text: `[TR:${it.text}]`,
        })),
      };
      bus.emit("pi-translate:v1:batch-response", resp);
    });

    // 8 questions x 8 options with previews
    const questions = Array.from({ length: 8 }, (_, qIdx) => ({
      id: `q${qIdx + 1}`,
      header: `Question Header ${qIdx + 1}`,
      prompt: `Prompt for question ${qIdx + 1}`,
      options: Array.from({ length: 8 }, (_, oIdx) => ({
        id: `opt_${qIdx + 1}_${oIdx + 1}`,
        label: `Option Label ${qIdx + 1}.${oIdx + 1}`,
        preview: "```markdown\nPreview for Option " + (qIdx + 1) + "." + (oIdx + 1) + "\n```",
      })),
    }));

    // Extract translatable fields including chrome (~48 fields)
    const fields = extractTranslatableFields(
      { title: "Large Scale", questions },
      true, // include chrome
    );

    // Total fields: 8 questions * (2 header/prompt + 8*2 label/preview) + chrome strings > 200 items!
    expect(fields.length).toBeGreaterThan(150);

    const translatedItems = await client.requestBatch({
      correlationId: "req-chunk-8x8",
      sessionId: "s-chunk",
      branchId: "b-chunk",
      direction: "to_target",
      targetLanguage: "German",
      items: fields,
      timeoutMs: 10_000,
    });

    expect(translatedItems.length).toBe(fields.length);
    expect(receivedChunks.length).toBeGreaterThan(2);
    for (const chunk of receivedChunks) {
      expect(chunk.items.length).toBeLessThanOrEqual(64);
    }
  });

  it("UIQueue atomically reserves successor and stale finally cannot clear newer controller", async () => {
    const queue = new UIQueue(2);
    const executionOrder: string[] = [];

    // Task 1 starts
    let resolveTask1!: () => void;
    const task1Promise = queue.runExclusive(async () => {
      executionOrder.push("task1-start");
      await new Promise<void>((r) => {
        resolveTask1 = r;
      });
      executionOrder.push("task1-end");
    });

    // Task 2 is queued
    let resolveTask2!: () => void;
    const task2Promise = queue.runExclusive(async () => {
      executionOrder.push("task2-start");
      await new Promise<void>((r) => {
        resolveTask2 = r;
      });
      executionOrder.push("task2-end");
    });

    // Task 3 is queued (up to maxQueue = 2)
    const task3Promise = queue.runExclusive(async () => {
      executionOrder.push("task3-start");
    });

    expect(queue.isBusy).toBe(true);
    expect(queue.pendingCount).toBe(2);

    // Complete Task 1: successor (Task 2) must be atomically reserved
    resolveTask1();
    await task1Promise;

    // Queue must remain busy immediately during successor handoff
    expect(queue.isBusy).toBe(true);

    // Reset queue while Task 2 is active: aborts Task 2, rejects Task 3 with typed abort
    queue.reset("Session navigated away");

    await expect(task3Promise).rejects.toThrow(/Session navigated away/);

    // Complete task 2 in background: its stale finally cannot clear subsequent queue state
    resolveTask2();
    try {
      await task2Promise;
    } catch {
      /* expected */
    }

    // New task can now acquire queue cleanly
    let task4Ran = false;
    await queue.runExclusive(async () => {
      task4Ran = true;
    });
    expect(task4Ran).toBe(true);
  });

  it("UIQueue reset does not permit next UI until active callback unwinds, preserving non-overlapping screens", async () => {
    const queue = new UIQueue(1);
    const trace: string[] = [];

    let resolveActive!: () => void;
    const activePromise = queue.runExclusive(async (signal) => {
      trace.push("active-started");
      signal.addEventListener("abort", () => {
        trace.push("active-abort-received");
      });
      await new Promise<void>((r) => {
        resolveActive = r;
      });
      trace.push("active-unwound");
    });

    expect(queue.isBusy).toBe(true);

    // Reset while active is running
    queue.reset("Reset during screen active");

    // Queue must STILL be busy while active is unwinding
    expect(queue.isBusy).toBe(true);

    // Next caller enters while old callback is still unwinding: it must queue and NOT overlap
    let nextRan = false;
    const nextPromise = queue.runExclusive(async () => {
      nextRan = true;
      trace.push("next-started");
    });

    expect(nextRan).toBe(false);
    expect(trace).toEqual(["active-started", "active-abort-received"]);

    // Now active callback completes its unwinding
    resolveActive();
    await activePromise;
    expect(trace).toEqual(["active-started", "active-abort-received", "active-unwound", "next-started"]);

    await nextPromise;
    expect(nextRan).toBe(true);
  });

  it("queued callers reset typed abort returned as status aborted even when caller signal not aborted", async () => {
    const env = makeTwoExtensionRuntime("test-queued-reset-abort", async (text) => text, {}, { loadTranslator: false });
    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    let resolveFlow1UI!: () => void;
    let flow1Started = false;
    env.ui.custom = vi.fn().mockImplementation(async () => {
      flow1Started = true;
      await new Promise<void>((r) => {
        resolveFlow1UI = r;
      });
      return { action: "cancel" };
    });

    const tool = runner.getToolDefinition("ask_user")!;

    // Start Flow 1
    const flow1Promise = tool.execute(
      "call-flow-1",
      { questions: [{ id: "q1", header: "Q1", prompt: "P1" }] },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    // Wait until Flow 1 is active
    await vi.waitFor(() => expect(flow1Started).toBe(true));

    // Start Flow 2 with an un-aborted caller signal (caller signal stays aborted=false)
    const caller2Signal = new AbortController().signal;
    expect(caller2Signal.aborted).toBe(false);

    const flow2Promise = tool.execute(
      "call-flow-2",
      { questions: [{ id: "q2", header: "Q2", prompt: "P2" }] },
      caller2Signal,
      () => {},
      runner.createToolContext(),
    );

    // Reset queue via session navigation
    await runner.emit({ type: "session_tree", reason: "navigation" });

    // Unwind Flow 1
    resolveFlow1UI();
    await flow1Promise;

    // Flow 2 must receive typed abort and return status 'aborted' even though caller2Signal was NOT aborted
    expect(caller2Signal.aborted).toBe(false);
    const flow2Result = await flow2Promise;
    expect(flow2Result.isError).toBe(true);
    expect(flow2Result.details.status).toBe("aborted");
    expect(flow2Result.details.summary).toMatch(/Session tree navigation/);
  });

  it("activeFlowController per-flow identity: old aborted flow finally unwinding does not erase newer controller after queue.reset", async () => {
    const env = makeTwoExtensionRuntime("test-flow-controller-identity", async (text) => text, {}, { loadTranslator: false });
    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    let flow1Resolve!: () => void;
    let flow1StartedResolve!: () => void;
    const flow1Started = new Promise<void>((r) => {
      flow1StartedResolve = r;
    });
    let flow2StartedResolve!: () => void;
    const flow2Started = new Promise<void>((r) => {
      flow2StartedResolve = r;
    });

    let currentFlow = 1;
    env.ui.custom = vi.fn().mockImplementation(async (_factory: any) => {
      if (currentFlow === 1) {
        flow1StartedResolve();
        await new Promise<void>((r) => {
          flow1Resolve = r;
        });
        return { action: "cancel" };
      } else {
        flow2StartedResolve();
        // Wait until aborted by settings invalidation
        await new Promise((r) => setTimeout(r, 50));
        return { action: "cancel" };
      }
    });

    const tool = runner.getToolDefinition("ask_user")!;

    // Start flow 1
    const flow1Promise = tool.execute(
      "call-id-flow-1",
      { questions: [{ id: "q1", header: "Q1", prompt: "P1" }] },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    await flow1Started;

    // Abort flow 1 via session navigation
    await runner.emit({ type: "session_tree", reason: "navigation" });

    // Queue flow 2
    currentFlow = 2;
    const flow2Promise = tool.execute(
      "call-id-flow-2",
      { questions: [{ id: "q2", header: "Q2", prompt: "P2" }] },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    // Unwind flow 1
    flow1Resolve();
    await flow1Promise;

    // Flow 2 starts
    await flow2Started;

    // Now emit settings invalidation: if flow 1's finally had cleared activeFlowController,
    // flow 2 would NOT be aborted! But with per-flow identity check, flow 2's controller is preserved and aborted.
    env.bus.emit("pi-translate:v1:settings-invalidated", {
      version: 1,
      server: "pi-translate-x@0.1.2",
      settingsEpoch: 2,
      enabled: false,
      targetLanguage: "Spanish",
      provider: "fake",
      model: "fake",
    });

    const flow2Result = await flow2Promise;
    expect(flow2Result.isError).toBe(true);
    expect(flow2Result.details.status).toBe("aborted");
    expect(flow2Result.details.summary).toMatch(/Translator settings invalidated/);
  });

  it("display retry checks explicit retry state, refreshes discovery and target language, and never silently falls back to English", async () => {
    const env = makeTwoExtensionRuntime("test-display-retry", async (text) => text, {}, { loadTranslator: false });

    let currentTargetLang = "Spanish";
    let discoverCount = 0;
    env.bus.on("pi-translate:v1:discover", (data: any) => {
      discoverCount++;
      env.bus.emit("pi-translate:v1:announce", {
        version: 1,
        correlationId: data.correlationId,
        server: "pi-translate-x@0.1.2",
        enabled: true,
        inputEnabled: true,
        outputEnabled: true,
        targetLanguage: currentTargetLang,
        provider: "fake",
        model: "fake",
      });
    });

    let batchCount = 0;
    const receivedBatchLanguages: string[] = [];
    env.bus.on("pi-translate:v1:batch-request", (data: any) => {
      batchCount++;
      receivedBatchLanguages.push(data.targetLanguage);
      if (batchCount === 1) {
        // First batch fails with network error
        env.bus.emit("pi-translate:v1:batch-response", {
          version: 1,
          correlationId: data.correlationId,
          ok: false,
          error: { code: "provider", message: "Initial batch failed" },
        });
      } else {
        // Second batch succeeds with translated items
        env.bus.emit("pi-translate:v1:batch-response", {
          version: 1,
          correlationId: data.correlationId,
          ok: true,
          items: [
            { id: "q:q1:header", text: "German Header" },
            { id: "q:q1:prompt", text: "German Prompt" },
            { id: "q:q1:opt:o1:label", text: "German Option" },
          ],
        });
      }
    });

    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);

    let customCount = 0;
    let presentationDisplayLang = "";
    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      customCount++;
      let doneAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          doneAction = action;
        },
      );

      if (customCount === 1) {
        // Recovery screen shown for initial batch error: change language before retry!
        currentTargetLang = "German";
        // User triggers retry
        return { action: "retry_display" };
      } else {
        // Presentation screen: record language
        presentationDisplayLang = comp.display.language;
        comp.state.selectOption("q1", "o1");
        comp.handleInput("\t");
        comp.handleInput("s");
        comp.handleInput("y");
        return doneAction;
      }
    });

    const tool = runner.getToolDefinition("ask_user")!;
    const result = await tool.execute(
      "call-display-retry",
      { questions: [{ id: "q1", header: "Q1", prompt: "P1", options: [{ id: "o1", label: "O1" }] }] },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );

    expect(result.details.status).toBe("submitted");
    // Verify rediscovery occurred on retry
    expect(discoverCount).toBeGreaterThanOrEqual(2);
    // Verify refreshed target language "German" was used in the retried batch
    expect(receivedBatchLanguages).toEqual(["Spanish", "German"]);
    // Verify presentation used the refreshed language
    expect(presentationDisplayLang).toBe("German");
  });

  it("initial incompatible translation service: Continue in English allows choices in English, but authored prose fail-closes without valid translator", async () => {
    const env = makeTwoExtensionRuntime("test-incompatible-service", async (text) => text, {}, { loadTranslator: false });

    // Announce unsupported protocol version
    env.bus.on("pi-translate:v1:discover", (data: any) => {
      env.bus.emit("pi-translate:v1:announce", {
        version: 99,
        correlationId: data.correlationId,
        server: "pi-translate-x@0.1.2",
        enabled: true,
        inputEnabled: true,
        outputEnabled: true,
        targetLanguage: "Spanish",
        provider: "fake",
        model: "fake",
      });
    });

    const questExt = await env.questionnaireExt;
    const runner = new ExtensionRunner([questExt], env.runtime, "/tmp", env.session, env.registry);
    bindRunner(runner, env.runtime, env.session, env.model, env.ui);
    const tool = runner.getToolDefinition("ask_user")!;

    // Scenario A: User continues in English and only selects predefined choices (no custom prose)
    let customCallCount = 0;
    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      customCallCount++;
      let doneAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          doneAction = action;
        },
      );

      if (customCallCount === 1) {
        // Discovery recovery screen: user chooses Continue in English
        return { action: "continue_english" };
      } else {
        // Questionnaire presentation: select predefined choice
        comp.state.selectOption("q1", "o1");
        comp.handleInput("\t");
        comp.handleInput("s");
        comp.handleInput("y");
        return doneAction;
      }
    });

    const resultA = await tool.execute(
      "call-incompat-choices",
      { questions: [{ id: "q1", header: "Q1", prompt: "P1", options: [{ id: "o1", label: "O1" }] }] },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );
    expect(resultA.details.status).toBe("submitted");
    expect(resultA.details.answers[0]?.selectedOptionLabels).toEqual(["O1"]);

    // Scenario B: User continues in English but enters custom prose; fails closed because translator is incompatible
    customCallCount = 0;
    let answerErrorObserved = "";
    env.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      customCallCount++;
      let doneAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          doneAction = action;
        },
      );

      if (customCallCount === 1) {
        // Discovery recovery screen: user chooses Continue in English
        return { action: "continue_english" };
      } else if (customCallCount === 2) {
        // Questionnaire presentation: user enters custom text in Japanese
        comp.state.setCustomText("q1", "日本語のカスタム回答");
        comp.handleInput("\t");
        comp.handleInput("s");
        comp.handleInput("y");
        return doneAction;
      } else {
        // Answer error recovery screen: verify error notifies translator incompatible
        answerErrorObserved = comp.answerError ?? "";
        // User cancels on fail-closed
        comp.handleInput("c");
        return doneAction;
      }
    });

    const resultB = await tool.execute(
      "call-incompat-custom-prose",
      { questions: [{ id: "q1", header: "Q1", prompt: "P1", allowCustom: true }] },
      new AbortController().signal,
      () => {},
      runner.createToolContext(),
    );
    expect(resultB.details.status).toBe("cancelled");
    expect(answerErrorObserved).toMatch(/incompatible/i);
    expect(answerErrorObserved).toMatch(/authored prose requires a valid translator/i);

    // Scenario C: Preserves absent/disabled initial English standalone: custom prose accepted directly in English canonical
    const envStandalone = makeTwoExtensionRuntime("test-standalone-preserved", async (text) => text, {}, { loadTranslator: false });
    // Note: Do NOT emit any announce: service is absent (timeout => status: absent)
    const questExtStandalone = await envStandalone.questionnaireExt;
    const runnerStandalone = new ExtensionRunner([questExtStandalone], envStandalone.runtime, "/tmp", envStandalone.session, envStandalone.registry);
    bindRunner(runnerStandalone, envStandalone.runtime, envStandalone.session, envStandalone.model, envStandalone.ui);
    const toolStandalone = runnerStandalone.getToolDefinition("ask_user")!;

    envStandalone.ui.custom = vi.fn().mockImplementation(async (factory: any) => {
      let doneAction: any;
      const comp = factory(
        { requestRender() {} },
        { fg: (_: any, t: string) => t, bg: (_: any, t: string) => t, style: (t: string) => t },
        undefined,
        (action: any) => {
          doneAction = action;
        },
      );
      comp.state.setCustomText("q1", "English standalone custom note");
      comp.handleInput("\t");
      comp.handleInput("s");
      comp.handleInput("y");
      return doneAction;
    });

    const resultC = await toolStandalone.execute(
      "call-standalone-prose",
      { questions: [{ id: "q1", header: "Q1", prompt: "P1", allowCustom: true }] },
      new AbortController().signal,
      () => {},
      runnerStandalone.createToolContext(),
    );
    expect(resultC.details.status).toBe("submitted");
    expect(resultC.details.answers[0]?.customText).toBe("English standalone custom note");
  });
});
