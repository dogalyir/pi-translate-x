import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Domain & State Machine
export * from "./domain/state.js";
export * from "./domain/projection.js";

// Tool Schemas & Types
export * from "./tool/schema.js";

// Service Protocol & Correlation Client
export * from "./service/protocol.js";
export * from "./service/client.js";

// Persistence Records
export * from "./persistence/record.js";

// UI Components
export * from "./ui/queue.js";
export * from "./ui/questionnaire-tui.js";
export * from "./ui/renderer.js";
export * from "./rpc/flow.js";

import {
  BilingualQuestionnaireParamsSchema,
  type BilingualQuestionnaireParams,
  type BilingualQuestionnaireDetails,
} from "./tool/schema.js";
import { QuestionnaireStateMachine } from "./domain/state.js";
import {
  buildDisplayQuestionnaire,
  extractTranslatableFields,
  resolveCanonicalAnswers,
  type DisplayQuestionnaire,
} from "./domain/projection.js";
import { TranslationServiceClient } from "./service/client.js";
import {
  CHANNELS,
} from "./service/protocol.js";
import {
  QUESTIONNAIRE_ENTRY_TYPE,
} from "./persistence/record.js";
import { UIQueue, UIQueueBusyError, UIQueueAbortError } from "./ui/queue.js";
import {
  QuestionnaireTUIComponent,
  type TUIExitAction,
} from "./ui/questionnaire-tui.js";
import { runQuestionnaireRPC } from "./rpc/flow.js";
import { registerQuestionnaireRenderer } from "./ui/renderer.js";

export default function register(pi: ExtensionAPI): void {
  if (!pi) return;

  // 1. Register durable transcript entry renderer
  registerQuestionnaireRenderer(pi);

  // Per-runtime questionnaire queue (no module-global identity)
  const runtimeUIQueue = new UIQueue(1);
  let activeFlowController: AbortController | undefined;
  let navigationEpoch = 0;
  let settingsEpoch = 0;
  let currentSessionId: string | undefined;

  const abortActiveFlow = (reason: string) => {
    if (activeFlowController) {
      activeFlowController.abort(reason);
      activeFlowController = undefined;
    }
    runtimeUIQueue.reset(reason);
  };

  pi.on("session_start", (_event, ctx) => {
    navigationEpoch++;
    currentSessionId = ctx.sessionManager?.getHeader()?.id;
    abortActiveFlow("Session started");
  });

  pi.on("session_tree", (_event, ctx) => {
    navigationEpoch++;
    currentSessionId = ctx.sessionManager?.getHeader()?.id;
    abortActiveFlow("Session tree navigation");
  });

  pi.on("session_shutdown", () => {
    navigationEpoch++;
    abortActiveFlow("Session shutdown");
  });

  if (pi.events) {
    pi.events.on(CHANNELS.SETTINGS_INVALIDATED, () => {
      settingsEpoch++;
      abortActiveFlow("Translator settings invalidated");
    });
  }

  // 2. Register tool ask_user
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user structured questions with single or multiple choices, or open freeform input, to collect preferences, requirements, and decisions.",
    exposure: "model-only",
    parameters: BilingualQuestionnaireParamsSchema,
    execute: async (toolCallId, params: BilingualQuestionnaireParams, signal, _onUpdate, ctx) => {
      // Guard: Headless mode unsupported
      if (!ctx.hasUI || ctx.mode === "json" || ctx.mode === "print") {
        return makeUnsupportedResult(params, "Headless execution is not supported");
      }

      // Serialize UI access with bounded per-runtime queue
      try {
        return await runtimeUIQueue.runExclusive(
          (opSignal) => {
            const flowController = new AbortController();
            activeFlowController = flowController;
            const forwardAbort = () => {
              flowController.abort(opSignal.reason);
            };
            opSignal.addEventListener("abort", forwardAbort, { once: true });

            return executeQuestionnaireFlow(
              pi,
              toolCallId,
              params,
              flowController.signal,
              ctx,
              () => ({
                navigationEpoch,
                settingsEpoch,
                sessionId: ctx.sessionManager?.getHeader()?.id ?? currentSessionId,
              }),
            ).finally(() => {
              opSignal.removeEventListener("abort", forwardAbort);
              if (activeFlowController === flowController) {
                activeFlowController = undefined;
              }
            });
          },
          signal,
        );
      } catch (err) {
        if (err instanceof UIQueueBusyError) {
          return makeErrorResult(params, "UI is busy with another active request");
        }
        if (err instanceof UIQueueAbortError) {
          return makeAbortedResult(params, err.message);
        }
        if (signal?.aborted) {
          return makeAbortedResult(params, "Operation aborted while queued");
        }
        throw err;
      }
    },
  });
}

interface RuntimeSnapshot {
  readonly navigationEpoch: number;
  readonly settingsEpoch: number;
  readonly sessionId?: string | undefined;
}

function safeSetStatus(
  ctx: ExtensionContext | { ui?: { setStatus?: (key: string, text?: string) => void } },
  key: string,
  text?: string,
): void {
  try {
    ctx.ui?.setStatus?.(key, text);
  } catch {
    // Ignore UI status update failures safely
  }
}

async function executeQuestionnaireFlow(
  pi: ExtensionAPI,
  toolCallId: string,
  params: BilingualQuestionnaireParams,
  signal: AbortSignal,
  ctx: ExtensionContext,
  getSnapshot: () => RuntimeSnapshot,
) {
  const initialSnapshot = getSnapshot();
  const sessionId = ctx.sessionManager?.getHeader()?.id ?? initialSnapshot.sessionId ?? "default-session";
  const branchId = ctx.sessionManager?.getLeafId() ?? sessionId;

  // 1. Discover Translation Service
  const client = pi.events ? new TranslationServiceClient({ events: pi.events }) : undefined;
  let discovery: Awaited<ReturnType<TranslationServiceClient["discover"]>> | undefined;
  let discoveryError: string | undefined;

  if (client) {
    try {
      discovery = await client.discover(400, signal);
    } catch (err) {
      if (signal.aborted) {
        return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
      }
      discoveryError = err instanceof Error ? err.message : String(err);
    }
  }

  let servicePresentButIncompatible = false;

  // Handle incompatible / malformed translation service discovery or unexpected discovery errors
  while (
    (discoveryError ||
      discovery?.status === "unsupported_version" ||
      discovery?.status === "malformed") &&
    !signal.aborted
  ) {
    servicePresentButIncompatible = true;
    const errorMsg =
      discoveryError ??
      discovery?.error ??
      `Translation service incompatible (${discovery?.status ?? "unknown"})`;
    ctx.ui.notify(errorMsg, "warning");

    safeSetStatus(ctx, "pi-ask-user:translating", undefined);

    if (ctx.mode === "tui" && ctx.ui.custom) {
      const discAction = await ctx.ui.custom<TUIExitAction>((tui, theme, keybindings, done) => {
        const dummySm = new QuestionnaireStateMachine(params);
        const dummyDisplay = buildDisplayQuestionnaire(params, undefined, "English");
        return new QuestionnaireTUIComponent({
          state: dummySm,
          display: dummyDisplay,
          tui,
          theme,
          keybindings,
          onDone: done,
          displayError: errorMsg,
          signal,
        });
      });

      if (signal.aborted) {
        return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
      }

      if (!discAction || typeof discAction !== "object") {
        throw new Error(`Discovery recovery failed: unexpected UI presenter outcome (${String(discAction)})`);
      }

      if (discAction.action === "retry_discovery" || discAction.action === "retry_display") {
        discoveryError = undefined;
        try {
          discovery = client ? await client.discover(400, signal) : undefined;
        } catch (err) {
          if (signal.aborted) return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
          discoveryError = err instanceof Error ? err.message : String(err);
        }
        if (discovery?.status === "available") {
          servicePresentButIncompatible = false;
        }
      } else if (discAction.action === "continue_english") {
        discovery = undefined;
        discoveryError = undefined;
        break;
      } else if (discAction.action === "cancel") {
        return makeCancelledResult(params);
      } else {
        throw new Error(`Discovery recovery failed: unexpected UI presenter action (${String((discAction as any).action)})`);
      }
    } else {
      const choice = await ctx.ui.select(
        `Translation service incompatible: ${errorMsg}`,
        ["Retry discovery", "Continue in English", "Cancel questionnaire"],
        { signal },
      );
      if (signal.aborted) {
        return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
      }
      if (choice === "Retry discovery") {
        discoveryError = undefined;
        try {
          discovery = client ? await client.discover(400, signal) : undefined;
        } catch (err) {
          if (signal.aborted) return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
          discoveryError = err instanceof Error ? err.message : String(err);
        }
        if (discovery?.status === "available") {
          servicePresentButIncompatible = false;
        }
      } else if (choice === "Continue in English") {
        discovery = undefined;
        discoveryError = undefined;
        break;
      } else {
        return makeCancelledResult(params);
      }
    }
  }

  // Pin enabled service discovered initially
  const enabledServiceDiscovered = discovery?.status === "available";

  let display: DisplayQuestionnaire;
  let translatedMap: Map<string, string> | undefined = undefined;

  if (discovery?.status === "available" && client) {
    // Include UI chrome (labels, hints, dialogs) so the whole questionnaire is localized, not just the content.
    const fields = extractTranslatableFields(params, true);
    let fetchOk = false;
    let isRetry = false;
    let fetchError: string | undefined = undefined;

    while (!fetchOk && !signal.aborted) {
      // Rediscover settings on requested retry to refresh discovery and target language
      if (isRetry && client) {
        let rediscoveryErr: string | undefined;
        try {
          discovery = await client.discover(400, signal);
        } catch (err) {
          if (signal.aborted) return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
          rediscoveryErr = err instanceof Error ? err.message : String(err);
        }

        if (rediscoveryErr || discovery?.status !== "available") {
          fetchError =
            rediscoveryErr ??
            `Translation service unavailable on retry (${discovery?.status ?? "service lost"})`;
        } else {
          fetchError = undefined;
        }
        isRetry = false;
      }

      try {
        if (!fetchError) {
          safeSetStatus(ctx, "pi-ask-user:translating", "Translating questionnaire…");
          const returned = await client.requestBatch(
            {
              correlationId: randomUUID(),
              sessionId,
              branchId,
              direction: "to_target",
              targetLanguage: discovery?.targetLanguage ?? "English",
              items: fields,
              timeoutMs: 30_000,
            },
            signal,
          );

          translatedMap = new Map<string, string>();
          for (const item of returned) {
            translatedMap.set(item.id, item.text);
          }
          fetchOk = true;
          safeSetStatus(ctx, "pi-ask-user:translating", undefined);
        }
      } catch (error) {
        if (signal.aborted) {
          return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
        }
        fetchError = error instanceof Error ? error.message : String(error);
      } finally {
        safeSetStatus(ctx, "pi-ask-user:translating", undefined);
      }

      if (!fetchOk && !signal.aborted) {
        // Clear status BEFORE human recovery
        safeSetStatus(ctx, "pi-ask-user:translating", undefined);

        // Prompt user for recovery
        if (ctx.mode === "tui" && ctx.ui.custom) {
          const recoveryAction = await ctx.ui.custom<TUIExitAction>((tui, theme, keybindings, done) => {
            const dummySm = new QuestionnaireStateMachine(params);
            const dummyDisplay = buildDisplayQuestionnaire(params, undefined, "English");
            const comp = new QuestionnaireTUIComponent({
              state: dummySm,
              display: dummyDisplay,
              tui,
              theme,
              keybindings,
              onDone: done,
              displayError: fetchError,
              signal,
            });
            return comp;
          });

          if (signal.aborted) {
            return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
          }

          if (!recoveryAction || typeof recoveryAction !== "object") {
            throw new Error(
              `Display translation recovery failed: unexpected UI presenter outcome (${String(recoveryAction)})`,
            );
          }

          if (recoveryAction.action === "continue_english") {
            translatedMap = undefined;
            break;
          } else if (recoveryAction.action === "cancel") {
            return makeCancelledResult(params);
          } else if (
            recoveryAction.action === "retry_display" ||
            recoveryAction.action === "retry_discovery"
          ) {
            isRetry = true;
            fetchError = undefined;
            continue;
          } else {
            throw new Error(
              `Display translation recovery failed: unexpected UI presenter action (${String((recoveryAction as any).action)})`,
            );
          }
        } else {
          // RPC fallback recovery prompt
          const dummyDisplay = buildDisplayQuestionnaire(params, undefined, "English");
          const choices = [
            dummyDisplay.chrome?.retryTranslation ?? "Retry translation",
            dummyDisplay.chrome?.continueInEnglish ?? "Continue in English",
            dummyDisplay.chrome?.cancelQuestionnaire ?? "Cancel questionnaire",
          ];
          const choice = await ctx.ui.select(
            `Display translation failed: ${fetchError}`,
            choices,
            { signal },
          );
          if (signal.aborted) {
            return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
          }
          if (
            choice === (dummyDisplay.chrome?.continueInEnglish ?? "Continue in English") ||
            choice === "Continue in English"
          ) {
            translatedMap = undefined;
            break;
          } else if (
            choice === (dummyDisplay.chrome?.cancelQuestionnaire ?? "Cancel questionnaire") ||
            choice === "Cancel questionnaire" ||
            choice === undefined
          ) {
            return makeCancelledResult(params);
          } else if (
            choice === (dummyDisplay.chrome?.retryTranslation ?? "Retry translation") ||
            choice === "Retry translation"
          ) {
            isRetry = true;
            fetchError = undefined;
            continue;
          } else {
            throw new Error(
              `Display translation recovery failed: unexpected UI presenter choice (${String(choice)})`,
            );
          }
        }
      }
    }

    display = buildDisplayQuestionnaire(
      params,
      translatedMap,
      translatedMap && discovery ? discovery.targetLanguage : "English",
    );
  } else {
    // Standalone absent or disabled: proceed in English
    display = buildDisplayQuestionnaire(params, undefined, "English");
  }

  // 2. Interactive Presentation Loop
  const sm = new QuestionnaireStateMachine(params);
  let uiSubmitted = false;

  while (!uiSubmitted && !signal.aborted) {
    if (ctx.mode === "tui" && ctx.ui.custom) {
      const exitAction = await ctx.ui.custom<TUIExitAction>((tui, theme, keybindings, done) => {
        return new QuestionnaireTUIComponent({
          state: sm,
          display,
          tui,
          theme,
          keybindings,
          onDone: done,
          signal,
        });
      });

      if (signal.aborted) {
        return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
      }

      if (!exitAction || typeof exitAction !== "object") {
        throw new Error(
          `Questionnaire presentation failed: unexpected UI presenter outcome (${String(exitAction)})`,
        );
      }

      if (exitAction.action === "cancel") {
        return makeCancelledResult(params);
      } else if (exitAction.action === "submit") {
        uiSubmitted = true;
      } else {
        throw new Error(
          `Questionnaire presentation failed: unexpected UI presenter action (${String((exitAction as any).action)})`,
        );
      }
    } else {
      // RPC mode degradation
      const rpcResult = await runQuestionnaireRPC(ctx.ui, sm, display, signal);
      if (signal.aborted || rpcResult.status === "aborted") {
        return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
      }
      if (rpcResult.status === "cancelled") {
        return makeCancelledResult(params);
      }
      uiSubmitted = true;
    }
  }

  if (signal.aborted) {
    return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
  }

  // 3. Resolve Answers & Reverse-Translate Native Prose
  let canonicalResolution: Awaited<ReturnType<typeof resolveCanonicalAnswers>> | undefined = undefined;
  let answerOk = false;
  let confirmedEnglishAuthorship = false;

  while (!answerOk && !signal.aborted) {
    // Validate answered fields on EVERY iteration (initial and after recovery edits)
    const invalidFields = sm.getInvalidAnswerErrors();
    if (invalidFields.length > 0) {
      const validationErrorMsg = `Invalid answer fields: ${invalidFields.map((e) => e.message).join(", ")}`;
      ctx.ui.notify(validationErrorMsg, "warning");

      // Invalid edits stay recoverably editable - do NOT fatal discard
      if (ctx.mode === "tui" && ctx.ui.custom) {
        const editAction = await ctx.ui.custom<TUIExitAction>((tui, theme, keybindings, done) => {
          return new QuestionnaireTUIComponent({
            state: sm,
            display,
            tui,
            theme,
            keybindings,
            onDone: done,
            answerError: validationErrorMsg,
            signal,
          });
        });

        if (signal.aborted) {
          return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
        }
        if (!editAction || typeof editAction !== "object") {
          throw new Error(`Draft editing failed: unexpected UI presenter outcome (${String(editAction)})`);
        }
        if (editAction.action === "cancel") {
          return makeCancelledResult(params);
        }
        continue;
      } else {
        const rpcResult = await runQuestionnaireRPC(ctx.ui, sm, display, signal);
        if (signal.aborted || rpcResult.status === "aborted") {
          return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
        }
        if (rpcResult.status === "cancelled") {
          return makeCancelledResult(params);
        }
        continue;
      }
    }

    // Check translator availability: English fallback must still reverse-translate custom prose if translator is available
    if (client) {
      try {
        const checkDisc = await client.discover(400, signal);
        if (checkDisc?.status === "available") {
          discovery = checkDisc;
          servicePresentButIncompatible = false;
        } else if (enabledServiceDiscovered || servicePresentButIncompatible) {
          discovery = checkDisc;
        }
      } catch (err) {
        if (signal.aborted) {
          return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
        }
        if (enabledServiceDiscovered || servicePresentButIncompatible) {
          discovery = undefined;
        }
      }
    }

    // Policy: Predefined choices work in English. However, any authored prose (customText, question notes, globalUserNotes)
    // requires a valid translator or explicit confirmed English authorship whenever a translation service was enabled or
    // present-but-incompatible at launch. Standalone mode where no service was configured (absent/disabled) remains preserved.
    const hasCustomProse =
      sm.questions.some((q) => {
        const a = sm.getAnswer(q.id);
        return Boolean(a.customText?.trim() || a.notes?.trim());
      }) || Boolean(sm.globalUserNotes?.trim());

    const requiresTranslator =
      (enabledServiceDiscovered || servicePresentButIncompatible) &&
      hasCustomProse &&
      !confirmedEnglishAuthorship;

    if (requiresTranslator && discovery?.status !== "available") {
      const serviceLossError = servicePresentButIncompatible
        ? `Translation service incompatible (${discovery?.status ?? "unsupported"}): authored prose requires a valid translator or explicit confirmed English authorship`
        : `Translation service unavailable to reverse-translate answers (${discovery?.status ?? "disconnected"})`;
      // Clear status BEFORE human recovery
      safeSetStatus(ctx, "pi-ask-user:reversing", undefined);

      if (ctx.mode === "tui" && ctx.ui.custom) {
        const recoveryAction = await ctx.ui.custom<TUIExitAction>((tui, theme, keybindings, done) => {
          return new QuestionnaireTUIComponent({
            state: sm,
            display,
            tui,
            theme,
            keybindings,
            onDone: done,
            answerError: serviceLossError,
            signal,
          });
        });

        if (signal.aborted) {
          return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
        }
        if (!recoveryAction || typeof recoveryAction !== "object") {
          throw new Error(`Answer recovery failed: unexpected UI presenter outcome (${String(recoveryAction)})`);
        }
        if (recoveryAction.action === "cancel") {
          return makeCancelledResult(params);
        } else if (recoveryAction.action === "retry_answer" || recoveryAction.action === "submit") {
          continue;
        }
      } else {
        const choices = [
          display.chrome?.retryAnswers ?? "Retry translating answers",
          ...(servicePresentButIncompatible ? ["Confirm prose is in English"] : []),
          display.chrome?.returnToEdit ?? "Return to edit drafts",
          display.chrome?.cancelQuestionnaire ?? "Cancel questionnaire",
        ];
        const choice = await ctx.ui.select(
          `Answer translation failed: ${serviceLossError}`,
          choices,
          { signal },
        );
        if (signal.aborted) {
          return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
        }
        if (
          choice === (display.chrome?.cancelQuestionnaire ?? "Cancel questionnaire") ||
          choice === "Cancel questionnaire" ||
          choice === undefined
        ) {
          return makeCancelledResult(params);
        } else if (
          choice === (display.chrome?.retryAnswers ?? "Retry translating answers") ||
          choice === "Retry translating answers"
        ) {
          continue;
        } else if (choice === "Confirm prose is in English") {
          confirmedEnglishAuthorship = true;
          continue;
        } else if (
          choice === (display.chrome?.returnToEdit ?? "Return to edit drafts") ||
          choice === "Return to edit drafts" ||
          choice === "Edit draft answers"
        ) {
          const editResult = await runQuestionnaireRPC(ctx.ui, sm, display, signal);
          if (signal.aborted || editResult.status === "aborted") {
            return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
          }
          if (editResult.status === "cancelled") {
            return makeCancelledResult(params);
          }
          continue;
        }
      }
      continue;
    }

    try {
      safeSetStatus(ctx, "pi-ask-user:reversing", "Translating answers…");
      canonicalResolution = await resolveCanonicalAnswers(
        sm,
        {
          client: discovery?.status === "available" ? client : undefined,
          sessionId,
          branchId,
          toolCallId,
          isTranslatedMode: display.isTranslated,
          targetLanguage: display.isTranslated ? display.language : undefined,
          displayQuestionnaire: display,
        },
        signal,
      );
      answerOk = true;
      safeSetStatus(ctx, "pi-ask-user:reversing", undefined);
    } catch (error) {
      if (signal.aborted) {
        return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
      }
      const errMsg = error instanceof Error ? error.message : String(error);

      // Clear status BEFORE human recovery
      safeSetStatus(ctx, "pi-ask-user:reversing", undefined);

      // Offer recovery without losing draft answers
      if (ctx.mode === "tui" && ctx.ui.custom) {
        const recoveryAction = await ctx.ui.custom<TUIExitAction>((tui, theme, keybindings, done) => {
          return new QuestionnaireTUIComponent({
            state: sm,
            display,
            tui,
            theme,
            keybindings,
            onDone: done,
            answerError: errMsg,
            signal,
          });
        });

        if (signal.aborted) {
          return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
        }

        if (!recoveryAction || typeof recoveryAction !== "object") {
          throw new Error(
            `Answer translation recovery failed: unexpected UI presenter outcome (${String(recoveryAction)})`,
          );
        }

        if (recoveryAction.action === "cancel") {
          return makeCancelledResult(params);
        } else if (
          recoveryAction.action === "retry_answer" ||
          recoveryAction.action === "submit"
        ) {
          // Preserves edited draft state and re-attempts resolution
          continue;
        } else {
          throw new Error(
            `Answer translation recovery failed: unexpected UI presenter action (${String((recoveryAction as any).action)})`,
          );
        }
      } else {
        const choices = [
          display.chrome?.retryAnswers ?? "Retry translating answers",
          display.chrome?.returnToEdit ?? "Return to edit drafts",
          display.chrome?.cancelQuestionnaire ?? "Cancel questionnaire",
        ];
        const choice = await ctx.ui.select(
          `Answer translation failed: ${errMsg}`,
          choices,
          { signal },
        );
        if (signal.aborted) {
          return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
        }
        if (
          choice === (display.chrome?.cancelQuestionnaire ?? "Cancel questionnaire") ||
          choice === "Cancel questionnaire" ||
          choice === undefined
        ) {
          return makeCancelledResult(params);
        } else if (
          choice === (display.chrome?.retryAnswers ?? "Retry translating answers") ||
          choice === "Retry translating answers"
        ) {
          continue;
        } else if (
          choice === (display.chrome?.returnToEdit ?? "Return to edit drafts") ||
          choice === "Return to edit drafts" ||
          choice === "Edit draft answers"
        ) {
          const editResult = await runQuestionnaireRPC(ctx.ui, sm, display, signal);
          if (signal.aborted || editResult.status === "aborted") {
            return makeAbortedResult(params, signal.reason ? String(signal.reason) : "Operation aborted");
          }
          if (editResult.status === "cancelled") {
            return makeCancelledResult(params);
          }
          continue;
        } else {
          throw new Error(
            `Answer translation recovery failed: unexpected UI presenter choice (${String(choice)})`,
          );
        }
      }
    } finally {
      safeSetStatus(ctx, "pi-ask-user:reversing", undefined);
    }
  }

  if (!canonicalResolution) {
    return makeCancelledResult(params);
  }

  // Check current session/navigation/settings snapshot immediately before persistence/result
  const currentSnapshot = getSnapshot();
  const isStillValid =
    !signal.aborted &&
    currentSnapshot.navigationEpoch === initialSnapshot.navigationEpoch &&
    currentSnapshot.settingsEpoch === initialSnapshot.settingsEpoch &&
    (!currentSnapshot.sessionId || currentSnapshot.sessionId === initialSnapshot.sessionId);

  if (!isStillValid) {
    return makeAbortedResult(params, "Session or settings changed before submission");
  }

  // 4. Persistence to Durable Session Record
  if (canonicalResolution.durableRecord && pi.appendEntry) {
    pi.appendEntry(QUESTIONNAIRE_ENTRY_TYPE, canonicalResolution.durableRecord);
  }

  // 5. Build Canonical Result Output for LLM
  const summaryLines: string[] = [
    `Questionnaire Completed: ${params.title ?? "Untitled Questionnaire"}`,
  ];
  for (const a of canonicalResolution.details.answers) {
    const labelStr =
      a.selectedOptionLabels.length > 0
        ? a.selectedOptionLabels.join(", ")
        : "(None)";
    let line = `- ${a.questionHeader}: ${labelStr}`;
    if (a.customText) {
      line += ` [Custom: ${a.customText}]`;
    }
    if (a.notes) {
      line += ` [Note: ${a.notes}]`;
    }
    summaryLines.push(line);
  }
  if (canonicalResolution.details.globalUserNotes) {
    summaryLines.push(`Global Notes: ${canonicalResolution.details.globalUserNotes}`);
  }
  if (canonicalResolution.details.unansweredQuestionIds.length > 0) {
    summaryLines.push(
      `Unanswered Questions: ${canonicalResolution.details.unansweredQuestionIds.join(", ")}`,
    );
  }

  return {
    content: [
      {
        type: "text" as const,
        text: summaryLines.join("\n"),
      },
    ],
    details: canonicalResolution.details,
  };
}

function makeCancelledResult(params: BilingualQuestionnaireParams) {
  const details: BilingualQuestionnaireDetails = {
    version: 1,
    status: "cancelled",
    summary: "Questionnaire was cancelled by user.",
    answers: [],
    unansweredQuestionIds: params.questions.map((q) => q.id),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: "Questionnaire was cancelled by user. No answers were submitted.",
      },
    ],
    isError: true,
    details,
  };
}

function makeAbortedResult(params: BilingualQuestionnaireParams, reason: string) {
  const details: BilingualQuestionnaireDetails = {
    version: 1,
    status: "aborted",
    summary: `Questionnaire was aborted: ${reason}`,
    answers: [],
    unansweredQuestionIds: params.questions.map((q) => q.id),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: `Questionnaire was aborted: ${reason}. No answers were submitted.`,
      },
    ],
    isError: true,
    details,
  };
}

function makeErrorResult(params: BilingualQuestionnaireParams, error: string) {
  const details: BilingualQuestionnaireDetails = {
    version: 1,
    status: "error",
    summary: `Questionnaire error: ${error}`,
    answers: [],
    unansweredQuestionIds: params.questions.map((q) => q.id),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: `Questionnaire error: ${error}. No answers were submitted.`,
      },
    ],
    isError: true,
    details,
  };
}

function makeUnsupportedResult(params: BilingualQuestionnaireParams, reason: string) {
  const details: BilingualQuestionnaireDetails = {
    version: 1,
    status: "unsupported",
    summary: `Questionnaire unsupported: ${reason}`,
    answers: [],
    unansweredQuestionIds: params.questions.map((q) => q.id),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: "Error: ask_user requires interactive UI mode (TUI or RPC). Headless execution is not supported.",
      },
    ],
    isError: true,
    details,
  };
}
