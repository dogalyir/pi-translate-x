import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { QuestionnaireStateMachine } from "../domain/state.js";
import type { DisplayQuestionnaire } from "../domain/projection.js";
import { DEFAULT_EN_CHROME } from "../domain/chrome.js";

function dialogArgs(signal?: AbortSignal): [ExtensionUIDialogOptions] | [] {
  return signal ? [{ signal }] : [];
}

export type RPCFlowResult =
  | { status: "submitted" }
  | { status: "cancelled" }
  | { status: "aborted" };

type OptionAction =
  | { type: "option"; optionId: string }
  | { type: "custom" }
  | { type: "skip" }
  | { type: "empty" }
  | { type: "back" }
  | { type: "done" }
  | { type: "review" }
  | { type: "cancel" };

export async function runQuestionnaireRPC(
  ui: ExtensionUIContext,
  state: QuestionnaireStateMachine,
  display: DisplayQuestionnaire,
  signal?: AbortSignal,
): Promise<RPCFlowResult> {
  const chrome = display.chrome ?? DEFAULT_EN_CHROME;
  const questions = display.questions;
  let currentIndex = 0;

  while (currentIndex < questions.length && !signal?.aborted) {
    const q = questions[currentIndex]!;
    const currentAns = state.getAnswer(q.id);
    const reqBadge = q.required ? ` (*${chrome.requiredBadge})` : ` (${chrome.optionalBadge})`;
    const promptTitle = `[Q ${currentIndex + 1}/${questions.length}] ${q.prompt}${reqBadge}`;

    if (q.type === "text") {
      let textValid = false;
      while (!textValid && !signal?.aborted) {
        const input = await ui.input(
          promptTitle,
          currentAns.customText ?? q.textPlaceholder ?? chrome.typeCustomPlaceholder,
          ...dialogArgs(signal),
        );
        if (signal?.aborted) {
          return { status: "aborted" };
        }
        if (input === undefined) {
          return { status: "cancelled" };
        }
        state.setCustomText(q.id, input.trim() ? input.trim() : undefined);
        const errs = state.getQuestionValidationErrors(q.id);
        if (errs.length > 0) {
          ui.notify(errs[0]!, "warning");
        } else {
          textValid = true;
        }
      }
    } else if (q.type === "multi") {
      let multiDone = false;
      let backed = false;
      while (!multiDone && !signal?.aborted) {
        const ansNow = state.getAnswer(q.id);
        const optionsList: string[] = [];
        const actionMap = new Map<string, OptionAction>();

        const registerChoice = (label: string, action: OptionAction, ...aliases: string[]) => {
          optionsList.push(label);
          actionMap.set(label, action);
          for (const alias of aliases) {
            actionMap.set(alias, action);
          }
        };

        for (let idx = 0; idx < q.options.length; idx++) {
          const opt = q.options[idx]!;
          const checked = ansNow.selectedOptionIds.includes(opt.id) ? "[*]" : "[ ]";
          const descHint = opt.description ? ` (${opt.description})` : "";
          const token = `[${idx + 1}] ${checked} ${opt.label}${descHint}`;
          registerChoice(
            token,
            { type: "option", optionId: opt.id },
            `${checked} ${opt.label}`,
            opt.label,
          );
        }

        if (q.allowCustom) {
          const hasCustom = ansNow.customText ? ` (Current: "${ansNow.customText}")` : "";
          const customToken = `[${chrome.customLabel}]${hasCustom}`;
          registerChoice(
            customToken,
            { type: "custom" },
            `[${chrome.customLabel}]`,
            "[Custom]",
            "[Custom answer...]",
            chrome.typeCustomPlaceholder,
          );
        }

        registerChoice(
          `[Empty] ${chrome.emptySelectionConfirm}`,
          { type: "empty" },
          chrome.emptySelectionConfirm,
          "[Empty] Confirm empty selection",
          "Confirm empty selection",
        );
        registerChoice(
          chrome.skipQuestion,
          { type: "skip" },
          "[Skip]",
          "⏭ Skip this question",
          "Skip this question",
        );
        registerChoice(
          chrome.doneSelections,
          { type: "done" },
          "[Done] Confirm selections",
          "✔ Done (confirm selections)",
          "Done",
        );

        if (currentIndex > 0) {
          registerChoice(
            chrome.backQuestion,
            { type: "back" },
            "[Back]",
            "← Back to previous question",
            "Back",
          );
        }

        const choice = await ui.select(`${promptTitle} - ${chrome.toggleOptions}:`, optionsList, ...dialogArgs(signal));
        if (signal?.aborted) {
          return { status: "aborted" };
        }
        if (choice === undefined) {
          return { status: "cancelled" };
        }

        const action = actionMap.get(choice);
        if (!action) {
          const numMatch = choice.match(/^\[(\d+)\]/);
          if (numMatch) {
            const optIdx = parseInt(numMatch[1]!, 10) - 1;
            if (optIdx >= 0 && optIdx < q.options.length) {
              state.selectOption(q.id, q.options[optIdx]!.id);
            }
          } else {
            const clean = choice.replace(/^(?:\[[* ]\]|\([* ]\))\s*/, "").trim();
            const matchedOpt = q.options.find(
              (opt) => clean.endsWith(opt.label.trim()) || clean === opt.label.trim(),
            );
            if (matchedOpt) {
              state.selectOption(q.id, matchedOpt.id);
            }
          }
          continue;
        }

        if (action.type === "done") {
          const errs = state.getQuestionValidationErrors(q.id);
          if (errs.length > 0) {
            ui.notify(errs[0]!, "warning");
            continue;
          }
          multiDone = true;
        } else if (action.type === "custom") {
          const customVal = await ui.input(
            `${chrome.customLabel}:`,
            ansNow.customText ?? "",
            ...dialogArgs(signal),
          );
          if (signal?.aborted) return { status: "aborted" };
          if (customVal === undefined) return { status: "cancelled" };
          state.setCustomText(q.id, customVal.trim() ? customVal.trim() : undefined);
        } else if (action.type === "empty") {
          state.confirmEmptySelection(q.id);
          multiDone = true;
        } else if (action.type === "skip") {
          multiDone = true;
        } else if (action.type === "back") {
          currentIndex = Math.max(0, currentIndex - 1);
          backed = true;
          break;
        } else if (action.type === "option") {
          state.selectOption(q.id, action.optionId);
        }
      }

      if (backed) {
        continue;
      }
    } else {
      // Single select
      const optionsList: string[] = [];
      const actionMap = new Map<string, OptionAction>();

      const registerChoice = (label: string, action: OptionAction, ...aliases: string[]) => {
        optionsList.push(label);
        actionMap.set(label, action);
        for (const alias of aliases) {
          actionMap.set(alias, action);
        }
      };

      for (let idx = 0; idx < q.options.length; idx++) {
        const opt = q.options[idx]!;
        const descHint = opt.description ? ` (${opt.description})` : "";
        const token = `[${idx + 1}] ${opt.label}${descHint}`;
        registerChoice(
          token,
          { type: "option", optionId: opt.id },
          opt.label,
        );
      }

      if (q.allowCustom) {
        registerChoice(
          chrome.typeCustomPlaceholder,
          { type: "custom" },
          "Type custom answer...",
          "[Custom answer...]",
        );
      }

      registerChoice(
        chrome.skipQuestion,
        { type: "skip" },
        "[Skip]",
        "⏭ Skip this question",
      );
      registerChoice(
        chrome.emptySelectionConfirm,
        { type: "empty" },
        "[Empty]",
        "⊘ Confirm empty selection",
        "[Empty] Confirm empty selection",
      );

      if (currentIndex > 0) {
        registerChoice(
          chrome.backQuestion,
          { type: "back" },
          "[Back]",
          "← Back to previous question",
        );
      }

      const selected = await ui.select(promptTitle, optionsList, ...dialogArgs(signal));
      if (signal?.aborted) {
        return { status: "aborted" };
      }
      if (selected === undefined) {
        return { status: "cancelled" };
      }

      const action = actionMap.get(selected);
      if (!action) {
        const numMatch = selected.match(/^\[(\d+)\]/);
        if (numMatch) {
          const optIdx = parseInt(numMatch[1]!, 10) - 1;
          if (optIdx >= 0 && optIdx < q.options.length) {
            state.selectOption(q.id, q.options[optIdx]!.id);
          }
        } else {
          const clean = selected.replace(/^(?:\[[* ]\]|\([* ]\))\s*/, "").trim();
          const matched = q.options.find((opt) => opt.label.trim() === clean);
          if (matched) {
            state.selectOption(q.id, matched.id);
          }
        }
      } else if (action.type === "custom") {
        const customVal = await ui.input(
          `${chrome.customLabel}:`,
          q.textPlaceholder ?? "",
          ...dialogArgs(signal),
        );
        if (signal?.aborted) return { status: "aborted" };
        if (customVal === undefined) return { status: "cancelled" };
        state.setCustomText(q.id, customVal.trim() ? customVal.trim() : undefined);
      } else if (action.type === "option") {
        state.selectOption(q.id, action.optionId);
      } else if (action.type === "empty") {
        state.confirmEmptySelection(q.id);
      } else if (action.type === "skip") {
        // Leave unanswered
      } else if (action.type === "back") {
        currentIndex = Math.max(0, currentIndex - 1);
        continue;
      }
    }

    // Optional per-question note
    const ans = state.getAnswer(q.id);
    if (!ans.notes && ui.confirm && !signal?.aborted) {
      const addNote = await ui.confirm(
        `${chrome.noteLabel} for "${q.header}"?`,
        chrome.optionalBadge,
        ...dialogArgs(signal),
      );
      if (signal?.aborted) return { status: "aborted" };
      if (addNote === true) {
        const note = await ui.input(`${chrome.noteLabel} for "${q.header}":`, undefined, ...dialogArgs(signal));
        if (signal?.aborted) return { status: "aborted" };
        if (note && note.trim()) {
          state.setQuestionNotes(q.id, note.trim());
        }
      }
    }

    currentIndex++;
  }

  if (signal?.aborted) {
    return { status: "aborted" };
  }

  // Optional global notes
  if (ui.confirm && !state.globalUserNotes && !signal?.aborted) {
    const addGlobal = await ui.confirm(
      chrome.globalNotesLabel + "?",
      chrome.optionalBadge,
      ...dialogArgs(signal),
    );
    if (signal?.aborted) return { status: "aborted" };
    if (addGlobal === true) {
      const gNote = await ui.input(`${chrome.globalNotesLabel}:`, undefined, ...dialogArgs(signal));
      if (signal?.aborted) return { status: "aborted" };
      if (gNote && gNote.trim()) {
        state.setGlobalUserNotes(gNote.trim());
      }
    }
  }

  // Summary review & confirmation loop
  let reviewDone = false;
  let promptedInitialConfirm = false;

  while (!reviewDone && !signal?.aborted) {
    const invalidErrs = state.getInvalidAnswerErrors();
    const unansweredIds = state.getUnansweredQuestionIds();
    const unansweredRequired = unansweredIds.filter((id) => {
      const q = questions.find((item) => item.id === id);
      return q?.required ?? true;
    });

    const summaryParts: string[] = [];
    for (const q of questions) {
      const a = state.getAnswer(q.id);
      const chosen = a.selectedOptionIds
        .map((id) => q.options.find((o) => o.id === id)?.label)
        .filter(Boolean);
      if (a.customText) chosen.push(`Custom: ${a.customText}`);
      if (a.emptySelectionConfirmed) chosen.push(`(${chrome.markEmpty})`);
      summaryParts.push(`${q.header}: ${chosen.join(", ") || "(Unanswered)"}`);
    }

    if (invalidErrs.length > 0) {
      ui.notify(
        `${chrome.validationFailed}: ${invalidErrs.map((e) => e.message).join(", ")}`,
        "error",
      );

      // Present review menu to edit invalid questions or cancel
      const editChoices: string[] = [];
      const choiceActionMap = new Map<string, () => Promise<void>>();

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]!;
        const qErrs = state.getQuestionValidationErrors(q.id);
        const errTag = qErrs.length > 0 ? ` (*Invalid: ${qErrs[0]})` : "";
        const label = `[Edit Q${i + 1}] ${q.header}${errTag}`;
        editChoices.push(label);
        choiceActionMap.set(label, async () => {
          await editQuestionRPC(ui, state, display, i, signal);
        });
      }

      const notesLabel = `[Edit Notes] ${chrome.globalNotesLabel}: ${state.globalUserNotes ? `"${state.globalUserNotes}"` : "(None)"}`;
      editChoices.push(notesLabel);
      choiceActionMap.set(notesLabel, async () => {
        const edited = await ui.input(`${chrome.globalNotesLabel}:`, state.globalUserNotes ?? "", ...dialogArgs(signal));
        if (signal?.aborted) return;
        if (edited !== undefined) {
          state.setGlobalUserNotes(edited.trim() ? edited.trim() : undefined);
        }
      });

      editChoices.push(`[Cancel] ${chrome.cancelQuestionnaire}`);

      const choice = await ui.select(
        `${chrome.reviewTitle} - ${chrome.validationFailed}`,
        editChoices,
        ...dialogArgs(signal),
      );
      if (signal?.aborted) return { status: "aborted" };
      if (!choice || choice.startsWith("[Cancel]")) {
        return { status: "cancelled" };
      }

      const handler = choiceActionMap.get(choice);
      if (handler) {
        await handler();
      }
      continue;
    }

    // Initial confirmation prompt (only once before entering review menu)
    if (!promptedInitialConfirm) {
      promptedInitialConfirm = true;
      if (unansweredRequired.length > 0) {
        const confirmPartial = await ui.confirm(
          chrome.confirmPartialTitle,
          `${chrome.missingRequiredBadge}: ${unansweredRequired.join(", ")}\n\n${chrome.submitAnyway}`,
          ...dialogArgs(signal),
        );
        if (signal?.aborted) return { status: "aborted" };
        if (confirmPartial) {
          return { status: "submitted" };
        }
      } else {
        const confirmed = await ui.confirm(
          chrome.submitConfirmTitle,
          summaryParts.join("\n"),
          ...dialogArgs(signal),
        );
        if (signal?.aborted) return { status: "aborted" };
        if (confirmed) {
          return { status: "submitted" };
        }
      }
    }

    // User declined initial submission or wants to modify drafts: show selectable review options
    const reviewChoices: string[] = [];
    const choiceActionMap = new Map<string, () => Promise<void>>();

    const submitLabel = unansweredRequired.length > 0 || unansweredIds.length > 0
      ? `[Submit] ${chrome.submitPartial}`
      : `[Submit] ${chrome.submitAnswers}`;
    reviewChoices.push(submitLabel);
    choiceActionMap.set(submitLabel, async () => {
      const currentInvalid = state.getInvalidAnswerErrors();
      if (currentInvalid.length > 0) {
        ui.notify(`${chrome.validationFailed}: ${currentInvalid.map((e) => e.message).join(", ")}`, "error");
        return;
      }
      if (unansweredRequired.length > 0) {
        const confirmPartial = await ui.confirm(
          chrome.confirmPartialTitle,
          `${chrome.missingRequiredBadge}: ${unansweredRequired.join(", ")}\n\n${chrome.submitAnyway}`,
          ...dialogArgs(signal),
        );
        if (signal?.aborted) return;
        if (confirmPartial) {
          reviewDone = true;
        }
      } else {
        const confirmed = await ui.confirm(
          chrome.submitConfirmTitle,
          summaryParts.join("\n"),
          ...dialogArgs(signal),
        );
        if (signal?.aborted) return;
        if (confirmed) {
          reviewDone = true;
        }
      }
    });

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const ans = state.getAnswer(q.id);
      const tag = ans.isAnswered ? chrome.answeredBadge : (q.required ? chrome.missingRequiredBadge : chrome.skippedOptionalBadge);
      const label = `[Edit Q${i + 1}] ${q.header} (${tag})`;
      reviewChoices.push(label);
      choiceActionMap.set(label, async () => {
        await editQuestionRPC(ui, state, display, i, signal);
      });
    }

    const notesLabel = `[Edit Notes] ${chrome.globalNotesLabel}: ${state.globalUserNotes ? `"${state.globalUserNotes}"` : "(None)"}`;
    reviewChoices.push(notesLabel);
    choiceActionMap.set(notesLabel, async () => {
      const edited = await ui.input(`${chrome.globalNotesLabel}:`, state.globalUserNotes ?? "", ...dialogArgs(signal));
      if (signal?.aborted) return;
      if (edited !== undefined) {
        state.setGlobalUserNotes(edited.trim() ? edited.trim() : undefined);
      }
    });

    reviewChoices.push(`[Cancel] ${chrome.cancelQuestionnaire}`);

    const reviewChoice = await ui.select(chrome.reviewTitle, reviewChoices, ...dialogArgs(signal));
    if (signal?.aborted) return { status: "aborted" };
    if (!reviewChoice || reviewChoice.startsWith("[Cancel]")) {
      return { status: "cancelled" };
    }

    const handler = choiceActionMap.get(reviewChoice);
    if (handler) {
      await handler();
    }
  }

  if (signal?.aborted) return { status: "aborted" };
  return { status: "submitted" };
}

async function editQuestionRPC(
  ui: ExtensionUIContext,
  state: QuestionnaireStateMachine,
  display: DisplayQuestionnaire,
  index: number,
  signal?: AbortSignal,
): Promise<"ok" | "cancelled" | "aborted"> {
  const chrome = display.chrome ?? DEFAULT_EN_CHROME;
  const q = display.questions[index];
  if (!q) return "ok";

  const reqBadge = q.required ? ` (*${chrome.requiredBadge})` : ` (${chrome.optionalBadge})`;
  const promptTitle = `[Q ${index + 1}/${display.questions.length}] ${q.prompt}${reqBadge}`;

  if (q.type === "text") {
    let textValid = false;
    while (!textValid && !signal?.aborted) {
      const currentAns = state.getAnswer(q.id);
      const input = await ui.input(
        promptTitle,
        currentAns.customText ?? q.textPlaceholder ?? chrome.typeCustomPlaceholder,
        ...dialogArgs(signal),
      );
      if (signal?.aborted) return "aborted";
      if (input === undefined) return "cancelled";
      state.setCustomText(q.id, input.trim() ? input.trim() : undefined);
      const errs = state.getQuestionValidationErrors(q.id);
      if (errs.length > 0) {
        ui.notify(errs[0]!, "warning");
      } else {
        textValid = true;
      }
    }
  } else if (q.type === "multi") {
    let multiDone = false;
    while (!multiDone && !signal?.aborted) {
      const ansNow = state.getAnswer(q.id);
      const optionsList: string[] = [];
      const actionMap = new Map<string, OptionAction>();

      const registerChoice = (label: string, action: OptionAction, ...aliases: string[]) => {
        optionsList.push(label);
        actionMap.set(label, action);
        for (const alias of aliases) {
          actionMap.set(alias, action);
        }
      };

      for (let idx = 0; idx < q.options.length; idx++) {
        const opt = q.options[idx]!;
        const checked = ansNow.selectedOptionIds.includes(opt.id) ? "[*]" : "[ ]";
        const descHint = opt.description ? ` (${opt.description})` : "";
        const token = `[${idx + 1}] ${checked} ${opt.label}${descHint}`;
        registerChoice(token, { type: "option", optionId: opt.id });
      }

      if (q.allowCustom) {
        const hasCustom = ansNow.customText ? ` (Current: "${ansNow.customText}")` : "";
        const customToken = `[${chrome.customLabel}]${hasCustom}`;
        registerChoice(
          customToken,
          { type: "custom" },
          `[${chrome.customLabel}]`,
          "[Custom]",
          "[Custom answer...]",
          chrome.typeCustomPlaceholder,
        );
      }

      registerChoice(`[Empty] ${chrome.emptySelectionConfirm}`, { type: "empty" });
      registerChoice(chrome.skipQuestion, { type: "skip" });
      registerChoice(chrome.doneSelections, { type: "done" });

      const choice = await ui.select(`${promptTitle} - ${chrome.toggleOptions}:`, optionsList, ...dialogArgs(signal));
      if (signal?.aborted) return "aborted";
      if (choice === undefined) return "cancelled";

      const action = actionMap.get(choice);
      if (action) {
        if (action.type === "done") {
          const errs = state.getQuestionValidationErrors(q.id);
          if (errs.length > 0) {
            ui.notify(errs[0]!, "warning");
            continue;
          }
          multiDone = true;
        } else if (action.type === "custom") {
          const customVal = await ui.input(`${chrome.customLabel}:`, ansNow.customText ?? "", ...dialogArgs(signal));
          if (signal?.aborted) return "aborted";
          if (customVal !== undefined) {
            state.setCustomText(q.id, customVal.trim() ? customVal.trim() : undefined);
          }
        } else if (action.type === "empty") {
          state.confirmEmptySelection(q.id);
          multiDone = true;
        } else if (action.type === "skip") {
          multiDone = true;
        } else if (action.type === "option") {
          state.selectOption(q.id, action.optionId);
        }
      } else {
        const numMatch = choice.match(/^\[(\d+)\]/);
        if (numMatch) {
          const optIdx = parseInt(numMatch[1]!, 10) - 1;
          if (optIdx >= 0 && optIdx < q.options.length) {
            state.selectOption(q.id, q.options[optIdx]!.id);
          }
        }
      }
    }
  } else {
    // Single
    const optionsList: string[] = [];
    const actionMap = new Map<string, OptionAction>();

    const registerChoice = (label: string, action: OptionAction, ...aliases: string[]) => {
      optionsList.push(label);
      actionMap.set(label, action);
      for (const alias of aliases) {
        actionMap.set(alias, action);
      }
    };

    for (let idx = 0; idx < q.options.length; idx++) {
      const opt = q.options[idx]!;
      const descHint = opt.description ? ` (${opt.description})` : "";
      const token = `[${idx + 1}] ${opt.label}${descHint}`;
      registerChoice(token, { type: "option", optionId: opt.id }, opt.label);
    }

    if (q.allowCustom) {
      registerChoice(chrome.typeCustomPlaceholder, { type: "custom" });
    }
    registerChoice(chrome.skipQuestion, { type: "skip" });
    registerChoice(chrome.emptySelectionConfirm, { type: "empty" });

    const selected = await ui.select(promptTitle, optionsList, ...dialogArgs(signal));
    if (signal?.aborted) return "aborted";
    if (selected === undefined) return "cancelled";

    const action = actionMap.get(selected);
    if (action) {
      if (action.type === "custom") {
        const customVal = await ui.input(`${chrome.customLabel}:`, q.textPlaceholder ?? "", ...dialogArgs(signal));
        if (signal?.aborted) return "aborted";
        if (customVal !== undefined) {
          state.setCustomText(q.id, customVal.trim() ? customVal.trim() : undefined);
        }
      } else if (action.type === "option") {
        state.selectOption(q.id, action.optionId);
      } else if (action.type === "empty") {
        state.confirmEmptySelection(q.id);
      } else if (action.type === "skip") {
        // Leave unanswered
      }
    } else {
      const numMatch = selected.match(/^\[(\d+)\]/);
      if (numMatch) {
        const optIdx = parseInt(numMatch[1]!, 10) - 1;
        if (optIdx >= 0 && optIdx < q.options.length) {
          state.selectOption(q.id, q.options[optIdx]!.id);
        }
      } else {
        const clean = selected.replace(/^(?:\[[* ]\]|\([* ]\))\s*/, "").trim();
        const matched = q.options.find((opt) => opt.label.trim() === clean);
        if (matched) {
          state.selectOption(q.id, matched.id);
        }
      }
    }
  }

  // Question note
  if (ui.confirm && !signal?.aborted) {
    const ans = state.getAnswer(q.id);
    const wantNote = await ui.confirm(
      `${chrome.noteLabel} for "${q.header}"?`,
      ans.notes ? `Current note: "${ans.notes}"` : chrome.optionalBadge,
      ...dialogArgs(signal),
    );
    if (signal?.aborted) return "aborted";
    if (wantNote) {
      const note = await ui.input(`${chrome.noteLabel} for "${q.header}":`, ans.notes ?? "", ...dialogArgs(signal));
      if (signal?.aborted) return "aborted";
      if (note !== undefined) {
        state.setQuestionNotes(q.id, note.trim() ? note.trim() : undefined);
      }
    }
  }

  return "ok";
}
