export type DisplayMode = "bilingual" | "original";

export interface TranslationSettings {
  readonly enabled: boolean;
  readonly input: boolean;
  readonly output: boolean;
  readonly targetLanguage: string;
  readonly provider: string;
  readonly model: string;
  readonly displayMode: DisplayMode;
  readonly timeoutMs: number;
}

export interface TranslationRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly source: string;
  readonly targetLanguage: string;
  readonly modelRef: string;
  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
}

export interface TranslationResult {
  readonly requestId: string;
  readonly text: string;
}

export type TranslationErrorCode = "aborted" | "timeout" | "unavailable" | "empty" | "truncated" | "integrity" | "provider";

export class TranslationError extends Error {
  constructor(readonly code: TranslationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranslationError";
  }
}

export interface Translator {
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

export interface DurableTranslationRecord {
  readonly version: 1;
  readonly kind: "input" | "output";
  readonly recordId: string;
  readonly sessionId: string;
  readonly branchId: string;
  /** Assistant cards link to their exact assistant entry; input records intentionally do not claim canonical-entry binding. */
  readonly messageEntryId?: string;
  readonly source: string;
  /** For input records, identifies this submission and states its limited persistence semantics. */
  readonly submissionId?: string;
  readonly inputDisposition?: "prepared-for-input-pipeline";
  readonly translated: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage: string;
  readonly modelRef: string;
  readonly protectionVersion: number;
  readonly createdAt: string;
}
