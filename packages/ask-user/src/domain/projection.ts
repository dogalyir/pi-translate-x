import { randomUUID } from "node:crypto";
import type {
  BatchItem,
} from "../service/protocol.js";
import type { TranslationServiceClient } from "../service/client.js";
import type {
  BilingualQuestionnaireDetails,
  BilingualQuestionnaireParams,
  CanonicalQuestionAnswer,
  QuestionnaireQuestion,
  QuestionOption,
} from "../tool/schema.js";
import type { QuestionnaireStateMachine } from "./state.js";
import {
  createDurableRecord,
  type DurableAnswerDisplay,
  type DurableQuestionDisplay,
  type DurableQuestionnaireRecord,
} from "../persistence/record.js";
import {
  DEFAULT_EN_CHROME,
  type UIChromeStrings,
} from "./chrome.js";

export * from "./chrome.js";

export interface DisplayOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly preview?: string | undefined;
  readonly canonicalLabel: string;
}

export interface DisplayQuestion {
  readonly id: string;
  readonly header: string;
  readonly prompt: string;
  readonly description?: string | undefined;
  readonly notes?: string | undefined;
  readonly textPlaceholder?: string | undefined;
  readonly type: "single" | "multi" | "text";
  readonly options: readonly DisplayOption[];
  readonly allowCustom: boolean;
  readonly required: boolean;
  readonly minSelections?: number | undefined;
  readonly maxSelections?: number | undefined;
  readonly textMinLength?: number | undefined;
  readonly textMaxLength?: number | undefined;
  readonly canonicalHeader: string;
  readonly canonicalPrompt: string;
}

export interface DisplayQuestionnaire {
  readonly language: string;
  readonly isTranslated: boolean;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly notes?: string | undefined;
  readonly questions: readonly DisplayQuestion[];
  readonly chrome: UIChromeStrings;
}

/**
 * Extracts all translatable text fields with stable IDs.
 */
export function extractTranslatableFields(
  params: BilingualQuestionnaireParams,
  includeChrome = false,
): BatchItem[] {
  const items: BatchItem[] = [];

  if (params.title?.trim()) items.push({ id: "g:title", text: params.title.trim() });
  if (params.description?.trim()) items.push({ id: "g:desc", text: params.description.trim() });
  if (params.notes?.trim()) items.push({ id: "g:notes", text: params.notes.trim() });

  for (const q of params.questions) {
    items.push({ id: `q:${q.id}:header`, text: q.header });
    items.push({ id: `q:${q.id}:prompt`, text: q.prompt });
    if (q.description?.trim()) items.push({ id: `q:${q.id}:desc`, text: q.description.trim() });
    if (q.notes?.trim()) items.push({ id: `q:${q.id}:notes`, text: q.notes.trim() });
    if (q.textPlaceholder?.trim()) items.push({ id: `q:${q.id}:placeholder`, text: q.textPlaceholder.trim() });

    if (q.options) {
      for (const opt of q.options) {
        items.push({ id: `q:${q.id}:opt:${opt.id}:label`, text: opt.label });
        if (opt.description?.trim()) items.push({ id: `q:${q.id}:opt:${opt.id}:desc`, text: opt.description.trim() });
        if (opt.preview?.trim()) items.push({ id: `q:${q.id}:opt:${opt.id}:preview`, text: opt.preview.trim() });
      }
    }
  }

  if (includeChrome) {
    for (const [key, value] of Object.entries(DEFAULT_EN_CHROME)) {
      items.push({ id: `c:${key}`, text: value });
    }
  }

  return items;
}

/**
 * Builds the localized Display Questionnaire by mapping translated fields,
 * falling back to canonical English when translations are missing or disabled.
 */
export function buildDisplayQuestionnaire(
  params: BilingualQuestionnaireParams,
  translations: Map<string, string> | undefined,
  targetLanguage = "English",
  chromeOverride?: UIChromeStrings,
): DisplayQuestionnaire {
  const isTranslated = !!translations && translations.size > 0 && targetLanguage.toLowerCase() !== "english";
  const tr = (id: string, fallback: string) => translations?.get(id) ?? fallback;

  const questions: DisplayQuestion[] = params.questions.map((q) => {
    const options: DisplayOption[] = (q.options ?? []).map((opt) => ({
      id: opt.id,
      label: tr(`q:${q.id}:opt:${opt.id}:label`, opt.label),
      description: opt.description ? tr(`q:${q.id}:opt:${opt.id}:desc`, opt.description) : undefined,
      preview: opt.preview ? tr(`q:${q.id}:opt:${opt.id}:preview`, opt.preview) : undefined,
      canonicalLabel: opt.label,
    }));

    return {
      id: q.id,
      header: tr(`q:${q.id}:header`, q.header),
      prompt: tr(`q:${q.id}:prompt`, q.prompt),
      description: q.description ? tr(`q:${q.id}:desc`, q.description) : undefined,
      notes: q.notes ? tr(`q:${q.id}:notes`, q.notes) : undefined,
      textPlaceholder: q.textPlaceholder ? tr(`q:${q.id}:placeholder`, q.textPlaceholder) : undefined,
      type: q.type ?? "single",
      options,
      allowCustom: q.allowCustom ?? true,
      required: q.required ?? true,
      minSelections: q.minSelections,
      maxSelections: q.maxSelections,
      textMinLength: q.textMinLength,
      textMaxLength: q.textMaxLength,
      canonicalHeader: q.header,
      canonicalPrompt: q.prompt,
    };
  });

  const chromeRecord: Record<string, string> = {};
  for (const [key, fallback] of Object.entries(DEFAULT_EN_CHROME)) {
    chromeRecord[key] = translations?.get(`c:${key}`) ?? fallback;
  }
  const resolvedChrome = chromeOverride ?? (chromeRecord as unknown as UIChromeStrings);

  return {
    language: targetLanguage,
    isTranslated,
    title: params.title ? tr("g:title", params.title) : undefined,
    description: params.description ? tr("g:desc", params.description) : undefined,
    notes: params.notes ? tr("g:notes", params.notes) : undefined,
    questions,
    chrome: resolvedChrome,
  };
}

export interface CanonicalResolutionContext {
  readonly client?: TranslationServiceClient | undefined;
  readonly sessionId: string;
  readonly branchId: string;
  readonly toolCallId: string;
  readonly isTranslatedMode: boolean;
  readonly targetLanguage?: string | undefined;
  readonly displayQuestionnaire?: DisplayQuestionnaire | undefined;
}

export interface CanonicalResolutionResult {
  readonly details: BilingualQuestionnaireDetails;
  readonly durableRecord?: DurableQuestionnaireRecord | undefined;
}

/**
 * Resolves user questionnaire answers to immutable canonical English representations.
 * Predefined selections are mapped by ID to original definitions (zero backtranslation).
 * Custom answers and notes written in user language are translated back to English.
 */
export async function resolveCanonicalAnswers(
  state: QuestionnaireStateMachine,
  context: CanonicalResolutionContext,
  signal?: AbortSignal,
): Promise<CanonicalResolutionResult> {
  const answers: CanonicalQuestionAnswer[] = [];
  const unansweredQuestionIds = state.getUnansweredQuestionIds();

  // If user entered custom text, notes, or global user notes in translated mode, we must translate them to English
  const reverseBatchItems: BatchItem[] = [];
  const reverseMap = new Map<string, { questionId?: string; field: "customText" | "notes" | "globalNotes" }>();

  for (const q of state.questions) {
    const ans = state.getAnswer(q.id);
    if (!ans.isAnswered) continue;

    if (context.client) {
      if (ans.customText?.trim()) {
        const id = `ans:${q.id}:custom`;
        reverseBatchItems.push({ id, text: ans.customText.trim() });
        reverseMap.set(id, { questionId: q.id, field: "customText" });
      }
      if (ans.notes?.trim()) {
        const id = `ans:${q.id}:notes`;
        reverseBatchItems.push({ id, text: ans.notes.trim() });
        reverseMap.set(id, { questionId: q.id, field: "notes" });
      }
    }
  }

  if (context.client && state.globalUserNotes?.trim()) {
    const id = "ans:global:notes";
    reverseBatchItems.push({ id, text: state.globalUserNotes.trim() });
    reverseMap.set(id, { field: "globalNotes" });
  }

  const translatedReverseAnswers = new Map<string, string>();
  if (reverseBatchItems.length > 0 && context.client) {
    const returnedItems = await context.client.requestBatch(
      {
        correlationId: randomUUID(),
        sessionId: context.sessionId,
        branchId: context.branchId,
        direction: "to_english",
        targetLanguage: "English",
        items: reverseBatchItems,
        timeoutMs: 30_000,
      },
      signal,
    );

    for (const item of returnedItems) {
      translatedReverseAnswers.set(item.id, item.text);
    }
  }

  const displayQuestionsRecord: DurableQuestionDisplay[] = [];
  const displayAnswersRecord: DurableAnswerDisplay[] = [];

  for (const q of state.questions) {
    const ans = state.getAnswer(q.id);
    if (!ans.isAnswered) continue;

    // Resolve predefined option labels strictly from original English definitions by option.id
    const selectedOptionLabels: string[] = [];
    const selectedOptionPreviews: string[] = [];
    const availableOptions = q.options ?? [];
    for (const optId of ans.selectedOptionIds) {
      const originalOpt = availableOptions.find((o) => o.id === optId);
      if (originalOpt) {
        selectedOptionLabels.push(originalOpt.label);
        if (originalOpt.preview) {
          selectedOptionPreviews.push(originalOpt.preview);
        }
      }
    }

    let englishCustomText = ans.customText;
    let originalCustomText: string | undefined = undefined;
    if (ans.customText?.trim()) {
      if (context.client) {
        const trText = translatedReverseAnswers.get(`ans:${q.id}:custom`);
        if (!trText) {
          throw new Error(`Failed to translate custom answer for question ${q.id} to English`);
        }
        originalCustomText = ans.customText;
        englishCustomText = trText;
      } else if (context.isTranslatedMode) {
        throw new Error(
          `Translation service unavailable to translate custom answer for question ${q.id} to English`,
        );
      }
    }

    let englishNotes = ans.notes;
    let originalNotes: string | undefined = undefined;
    if (ans.notes?.trim()) {
      if (context.client) {
        const trNotes = translatedReverseAnswers.get(`ans:${q.id}:notes`);
        if (!trNotes) {
          throw new Error(`Failed to translate notes for question ${q.id} to English`);
        }
        originalNotes = ans.notes;
        englishNotes = trNotes;
      } else if (context.isTranslatedMode) {
        throw new Error(
          `Translation service unavailable to translate notes for question ${q.id} to English`,
        );
      }
    }

    answers.push({
      questionId: q.id,
      questionHeader: q.header,
      questionPrompt: q.prompt,
      selectedOptionIds: ans.selectedOptionIds,
      selectedOptionLabels,
      ...(selectedOptionPreviews.length > 0 ? { selectedOptionPreviews } : {}),
      ...(englishCustomText !== undefined ? { customText: englishCustomText } : {}),
      ...(englishNotes !== undefined ? { notes: englishNotes } : {}),
    });

    if (originalCustomText || originalNotes) {
      displayAnswersRecord.push({
        questionId: q.id,
        ...(originalCustomText !== undefined ? { customTextOriginal: originalCustomText } : {}),
        ...(originalNotes !== undefined ? { notesOriginal: originalNotes } : {}),
      });
    }
  }

  let englishGlobalUserNotes = state.globalUserNotes?.trim() || undefined;
  let originalGlobalUserNotes: string | undefined = undefined;
  if (state.globalUserNotes?.trim()) {
    if (context.client) {
      const trGlobal = translatedReverseAnswers.get("ans:global:notes");
      if (!trGlobal) {
        throw new Error("Failed to translate global user notes to English");
      }
      originalGlobalUserNotes = state.globalUserNotes.trim();
      englishGlobalUserNotes = trGlobal;
    } else if (context.isTranslatedMode) {
      throw new Error("Translation service unavailable to translate global user notes to English");
    }
  }

  // Create durable record for persistence
  let durableRecord: DurableQuestionnaireRecord | undefined = undefined;
  const hasDisplayData =
    Boolean(context.displayQuestionnaire) ||
    context.isTranslatedMode ||
    displayAnswersRecord.length > 0 ||
    originalGlobalUserNotes !== undefined;
  if (hasDisplayData) {
    if (context.displayQuestionnaire) {
      for (const dq of context.displayQuestionnaire.questions) {
        displayQuestionsRecord.push({
          id: dq.id,
          header: dq.header,
          prompt: dq.prompt,
          description: dq.description,
          options: dq.options.map((o) => ({
            id: o.id,
            label: o.label,
            description: o.description,
            preview: o.preview,
          })),
        });
      }
    }

    durableRecord = createDurableRecord({
      sessionId: context.sessionId,
      branchId: context.branchId,
      toolCallId: context.toolCallId,
      targetLanguage: context.targetLanguage,
      title: state.params.title,
      answers,
      unansweredQuestionIds,
      globalUserNotes: englishGlobalUserNotes,
      display: {
        language: context.displayQuestionnaire?.language ?? context.targetLanguage ?? "unknown",
        ...(context.displayQuestionnaire?.title !== undefined ? { title: context.displayQuestionnaire.title } : {}),
        questions: displayQuestionsRecord,
        answers: displayAnswersRecord,
        ...(originalGlobalUserNotes !== undefined ? { globalUserNotesOriginal: originalGlobalUserNotes } : {}),
      },
    });
  } else {
    durableRecord = createDurableRecord({
      sessionId: context.sessionId,
      branchId: context.branchId,
      toolCallId: context.toolCallId,
      title: state.params.title,
      answers,
      unansweredQuestionIds,
      globalUserNotes: englishGlobalUserNotes,
    });
  }

  const summary = `Completed questionnaire: ${answers.length} answered, ${unansweredQuestionIds.length} unanswered.`;

  const details: BilingualQuestionnaireDetails = {
    version: 1,
    status: "submitted",
    summary,
    answers,
    unansweredQuestionIds,
    ...(englishGlobalUserNotes !== undefined ? { globalUserNotes: englishGlobalUserNotes } : {}),
    durableRecordId: durableRecord.recordId,
    ...(context.targetLanguage !== undefined ? { translatedDisplayLanguage: context.targetLanguage } : {}),
  };

  return { details, durableRecord };
}
