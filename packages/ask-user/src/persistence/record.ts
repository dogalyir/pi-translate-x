import { randomUUID } from "node:crypto";
import type { CanonicalQuestionAnswer } from "../tool/schema.js";

export const QUESTIONNAIRE_ENTRY_TYPE = "pi-ask-user-x:questionnaire" as const;

export interface DurableQuestionDisplay {
  readonly id: string;
  readonly header: string;
  readonly prompt: string;
  readonly description?: string | undefined;
  readonly options?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string | undefined;
    readonly preview?: string | undefined;
  }[] | undefined;
}

export interface DurableAnswerDisplay {
  readonly questionId: string;
  readonly customTextOriginal?: string | undefined;
  readonly notesOriginal?: string | undefined;
}

export interface DurableQuestionnaireRecord {
  readonly version: 1;
  readonly recordId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly toolCallId: string;
  readonly createdAt: string;
  readonly targetLanguage?: string | undefined;
  readonly canonical: {
    readonly title?: string | undefined;
    readonly answers: readonly CanonicalQuestionAnswer[];
    readonly unansweredQuestionIds: readonly string[];
    readonly globalUserNotes?: string | undefined;
  };
  readonly display?: {
    readonly language: string;
    readonly title?: string | undefined;
    readonly questions: readonly DurableQuestionDisplay[];
    readonly answers: readonly DurableAnswerDisplay[];
    readonly globalUserNotesOriginal?: string | undefined;
  } | undefined;
}

export function isDurableQuestionnaireRecord(data: unknown): data is DurableQuestionnaireRecord {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  if (rec["version"] !== 1 || typeof rec["recordId"] !== "string" || !rec["recordId"].trim()) return false;
  if (typeof rec["sessionId"] !== "string" || typeof rec["branchId"] !== "string") return false;
  if (typeof rec["canonical"] !== "object" || rec["canonical"] === null) return false;
  const canon = rec["canonical"] as Record<string, unknown>;
  if (!Array.isArray(canon["answers"]) || !Array.isArray(canon["unansweredQuestionIds"])) return false;

  for (const a of canon["answers"]) {
    if (typeof a !== "object" || a === null) return false;
    const ans = a as Record<string, unknown>;
    if (
      typeof ans["questionId"] !== "string" ||
      !Array.isArray(ans["selectedOptionIds"]) ||
      !Array.isArray(ans["selectedOptionLabels"])
    ) {
      return false;
    }
  }

  if (rec["display"] !== undefined) {
    if (typeof rec["display"] !== "object" || rec["display"] === null) return false;
    const disp = rec["display"] as Record<string, unknown>;
    if (typeof disp["language"] !== "string") return false;
    if (disp["questions"] !== undefined && !Array.isArray(disp["questions"])) return false;
    if (disp["answers"] !== undefined && !Array.isArray(disp["answers"])) return false;
  }

  return true;
}

export function createDurableRecord(params: {
  sessionId: string;
  branchId: string;
  toolCallId: string;
  targetLanguage?: string | undefined;
  title?: string | undefined;
  answers: readonly CanonicalQuestionAnswer[];
  unansweredQuestionIds: readonly string[];
  globalUserNotes?: string | undefined;
  display?: {
    language: string;
    title?: string | undefined;
    questions: readonly DurableQuestionDisplay[];
    answers: readonly DurableAnswerDisplay[];
    globalUserNotesOriginal?: string | undefined;
  } | undefined;
}): DurableQuestionnaireRecord {
  return {
    version: 1,
    recordId: randomUUID(),
    sessionId: params.sessionId,
    branchId: params.branchId,
    toolCallId: params.toolCallId,
    createdAt: new Date().toISOString(),
    ...(params.targetLanguage !== undefined ? { targetLanguage: params.targetLanguage } : {}),
    canonical: {
      ...(params.title !== undefined ? { title: params.title } : {}),
      answers: params.answers,
      unansweredQuestionIds: params.unansweredQuestionIds,
      ...(params.globalUserNotes !== undefined ? { globalUserNotes: params.globalUserNotes } : {}),
    },
    ...(params.display !== undefined ? { display: params.display } : {}),
  };
}
