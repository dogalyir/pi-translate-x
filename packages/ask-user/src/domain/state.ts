import type {
  BilingualQuestionnaireParams,
  QuestionnaireQuestion,
} from "../tool/schema.js";

export interface QuestionAnswerState {
  readonly questionId: string;
  selectedOptionIds: string[];
  customText?: string | undefined;
  notes?: string | undefined;
  isAnswered: boolean;
  emptySelectionConfirmed?: boolean;
}

export interface ValidationError {
  readonly questionId: string;
  readonly message: string;
}

export function validateQuestionnaireParams(params: BilingualQuestionnaireParams): void {
  if (!params || !Array.isArray(params.questions) || params.questions.length === 0) {
    throw new Error("Questionnaire must have at least one question.");
  }
  if (params.questions.length > 8) {
    throw new Error("Questionnaire cannot have more than 8 questions.");
  }

  const seenQuestionIds = new Set<string>();

  for (const q of params.questions) {
    if (!q.id || typeof q.id !== "string" || !q.id.trim()) {
      throw new Error("Question ID is required and cannot be empty.");
    }
    if (seenQuestionIds.has(q.id)) {
      throw new Error(`Duplicate question ID: ${q.id}`);
    }
    seenQuestionIds.add(q.id);

    const type = q.type ?? "single";

    if (q.options && q.options.length > 0) {
      if (q.options.length > 8) {
        throw new Error(`Question "${q.id}" cannot have more than 8 options.`);
      }

      const seenOptionIds = new Set<string>();
      for (const opt of q.options) {
        if (!opt.id || typeof opt.id !== "string" || !opt.id.trim()) {
          throw new Error(`Option in question "${q.id}" must have a non-empty ID.`);
        }
        if (seenOptionIds.has(opt.id)) {
          throw new Error(`Duplicate option ID: ${opt.id} in question ${q.id}`);
        }
        seenOptionIds.add(opt.id);
      }
    }

    if (type === "multi") {
      if (q.minSelections !== undefined && q.maxSelections !== undefined) {
        if (q.minSelections > q.maxSelections) {
          throw new Error(
            `Question "${q.id}": minSelections (${q.minSelections}) cannot exceed maxSelections (${q.maxSelections}).`,
          );
        }
      }
      if (q.maxSelections !== undefined && q.options && q.maxSelections > q.options.length) {
        throw new Error(
          `Question "${q.id}": maxSelections (${q.maxSelections}) cannot exceed option count (${q.options.length}).`,
        );
      }
    }

    if (q.textMinLength !== undefined && q.textMaxLength !== undefined) {
      if (q.textMinLength > q.textMaxLength) {
        throw new Error(
          `Question "${q.id}": textMinLength (${q.textMinLength}) cannot exceed textMaxLength (${q.textMaxLength}).`,
        );
      }
    }
  }
}

export class QuestionnaireStateMachine {
  public readonly params: BilingualQuestionnaireParams;
  public readonly questions: readonly QuestionnaireQuestion[];
  public globalUserNotes?: string | undefined = undefined;

  public get globalNotes(): string | undefined {
    return this.globalUserNotes;
  }

  public set globalNotes(val: string | undefined) {
    this.globalUserNotes = val;
  }

  private answers = new Map<string, QuestionAnswerState>();
  private activeIndex = 0;
  private reviewing = false;
  private cancelled = false;

  constructor(params: BilingualQuestionnaireParams) {
    validateQuestionnaireParams(params);
    this.params = params;
    this.questions = params.questions;
    this.globalUserNotes = undefined;

    for (const q of this.questions) {
      this.answers.set(q.id, {
        questionId: q.id,
        selectedOptionIds: [],
        customText: undefined,
        notes: undefined,
        isAnswered: false,
        emptySelectionConfirmed: false,
      });
    }
  }

  public get currentQuestionIndex(): number {
    return this.activeIndex;
  }

  public get currentQuestion(): QuestionnaireQuestion {
    return this.questions[this.activeIndex]!;
  }

  public get isReviewTab(): boolean {
    return this.reviewing;
  }

  public get isCancelled(): boolean {
    return this.cancelled;
  }

  public getAnswer(questionId: string): QuestionAnswerState {
    const ans = this.answers.get(questionId);
    if (!ans) throw new Error(`Unknown question ID: ${questionId}`);
    return ans;
  }

  public selectOption(questionId: string, optionId: string): void {
    const q = this.getQuestion(questionId);
    const available = q.options ?? [];
    const matched = available.find((opt) => opt.id === optionId);
    if (!matched) {
      throw new Error(`Unknown option ID "${optionId}" for question "${questionId}"`);
    }

    const ans = this.getAnswer(questionId);
    const type = q.type ?? "single";
    ans.emptySelectionConfirmed = false;

    if (type === "single") {
      ans.selectedOptionIds = [optionId];
      ans.isAnswered = true;
    } else if (type === "multi") {
      const idx = ans.selectedOptionIds.indexOf(optionId);
      if (idx >= 0) {
        ans.selectedOptionIds.splice(idx, 1);
      } else {
        ans.selectedOptionIds.push(optionId);
      }
      ans.isAnswered = ans.selectedOptionIds.length > 0 || Boolean(ans.customText?.trim());
    }
  }

  public setCustomText(questionId: string, text: string | undefined): void {
    const q = this.getQuestion(questionId);
    const cleanText = text !== undefined && text.trim().length > 0 ? text : undefined;

    if (cleanText !== undefined && q.type !== "text" && q.allowCustom === false) {
      throw new Error(`Custom text is not allowed for question "${questionId}"`);
    }

    const ans = this.getAnswer(questionId);
    ans.customText = cleanText;
    ans.emptySelectionConfirmed = false;

    if (cleanText !== undefined) {
      ans.isAnswered = true;
    } else {
      ans.isAnswered = ans.selectedOptionIds.length > 0;
    }
  }

  public setQuestionNotes(questionId: string, notes: string | undefined): void {
    const ans = this.getAnswer(questionId);
    ans.notes = notes;
  }

  public setGlobalUserNotes(notes: string | undefined): void {
    this.globalUserNotes = notes;
  }

  public setGlobalNotes(notes: string | undefined): void {
    this.globalUserNotes = notes;
  }

  /**
   * Explicitly confirm empty selection (distinct from unanswered).
   */
  public confirmEmptySelection(questionId: string): void {
    const ans = this.getAnswer(questionId);
    ans.selectedOptionIds = [];
    ans.customText = undefined;
    ans.emptySelectionConfirmed = true;
    ans.isAnswered = true;
  }

  /**
   * Reset answer to unanswered.
   */
  public resetToUnanswered(questionId: string): void {
    const ans = this.getAnswer(questionId);
    ans.selectedOptionIds = [];
    ans.customText = undefined;
    ans.notes = undefined;
    ans.emptySelectionConfirmed = false;
    ans.isAnswered = false;
  }

  public next(): boolean {
    if (this.activeIndex < this.questions.length - 1) {
      this.activeIndex++;
      return true;
    }
    this.reviewing = true;
    return false;
  }

  public prev(): boolean {
    if (this.reviewing) {
      this.reviewing = false;
      this.activeIndex = this.questions.length - 1;
      return true;
    }
    if (this.activeIndex > 0) {
      this.activeIndex--;
      return true;
    }
    return false;
  }

  public goToQuestion(index: number): void {
    if (index >= 0 && index < this.questions.length) {
      this.activeIndex = index;
      this.reviewing = false;
    }
  }

  public goToReview(): void {
    this.reviewing = true;
  }

  public cancel(): void {
    this.cancelled = true;
  }

  public getQuestionValidationErrors(questionId: string): string[] {
    const q = this.getQuestion(questionId);
    const ans = this.getAnswer(questionId);
    const errors: string[] = [];

    const isRequired = q.required ?? true;
    const type = q.type ?? "single";

    if (!ans.isAnswered) {
      if (isRequired) {
        errors.push("This question is required.");
      }
      return errors;
    }

    const hasOptions = ans.selectedOptionIds.length > 0;
    const hasCustom = typeof ans.customText === "string" && ans.customText.trim().length > 0;

    if (ans.emptySelectionConfirmed && isRequired) {
      errors.push("This question is required.");
    }

    if (isRequired && !hasOptions && !hasCustom && !ans.emptySelectionConfirmed) {
      errors.push("An answer or custom text is required.");
    }

    if (type === "multi") {
      const minSel = q.minSelections ?? (isRequired ? 1 : 0);
      const maxSel = q.maxSelections ?? 8;

      if (ans.selectedOptionIds.length < minSel && !ans.emptySelectionConfirmed) {
        errors.push(`Select at least ${minSel} option(s).`);
      }
      if (ans.selectedOptionIds.length > maxSel) {
        errors.push(`Select at most ${maxSel} option(s).`);
      }
    }

    if (hasCustom && typeof ans.customText === "string") {
      const textLen = ans.customText.trim().length;
      if (q.textMinLength !== undefined && textLen < q.textMinLength) {
        errors.push(`Custom text must be at least ${q.textMinLength} characters.`);
      }
      if (q.textMaxLength !== undefined && textLen > q.textMaxLength) {
        errors.push(`Custom text cannot exceed ${q.textMaxLength} characters.`);
      }
    }

    return errors;
  }

  public getInvalidAnswerErrors(): ValidationError[] {
    const result: ValidationError[] = [];
    for (const q of this.questions) {
      const ans = this.getAnswer(q.id);
      if (!ans.isAnswered) continue; // Unanswered is not an invalid answered field
      const errors = this.getQuestionValidationErrors(q.id);
      for (const err of errors) {
        result.push({ questionId: q.id, message: err });
      }
    }
    return result;
  }

  public getAllValidationErrors(): ValidationError[] {
    const result: ValidationError[] = [];
    for (const q of this.questions) {
      const errors = this.getQuestionValidationErrors(q.id);
      for (const err of errors) {
        result.push({ questionId: q.id, message: err });
      }
    }
    return result;
  }

  public canSubmit(allowPartial = false): boolean {
    if (this.cancelled) return false;
    if (this.getInvalidAnswerErrors().length > 0) return false;
    if (allowPartial) return true;
    return this.getAllValidationErrors().length === 0;
  }

  public getUnansweredQuestionIds(): string[] {
    const unanswered: string[] = [];
    for (const q of this.questions) {
      const ans = this.getAnswer(q.id);
      if (!ans.isAnswered) {
        unanswered.push(q.id);
      }
    }
    return unanswered;
  }

  private getQuestion(questionId: string): QuestionnaireQuestion {
    const q = this.questions.find((it) => it.id === questionId);
    if (!q) throw new Error(`Unknown question ID: ${questionId}`);
    return q;
  }
}
