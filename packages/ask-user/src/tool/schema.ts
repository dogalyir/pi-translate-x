import { Type, type Static } from "typebox";

export const QuestionOptionSchema = Type.Object({
  id: Type.String({
    pattern: "^[a-zA-Z0-9_-]+$",
    maxLength: 64,
    description: "Stable explicit identifier for this option (e.g. 'oauth2', 'jwt'). Unique within the question. Independent of labels.",
  }),
  label: Type.String({
    maxLength: 120,
    description: "Concise display label in English (e.g. 'OAuth 2.0 / OIDC').",
  }),
  description: Type.Optional(
    Type.String({
      maxLength: 500,
      description: "Optional description explaining implications or tradeoffs of choosing this option.",
    }),
  ),
  preview: Type.Optional(
    Type.String({
      description: "Optional Markdown preview content (code snippets, diagrams, markdown tables) rendered when this option is focused.",
    }),
  ),
});

export const QuestionnaireQuestionSchema = Type.Object({
  id: Type.String({
    pattern: "^[a-zA-Z0-9_-]+$",
    maxLength: 64,
    description: "Stable explicit identifier for this question (e.g. 'auth_method'). Unique within questionnaire.",
  }),
  header: Type.String({
    maxLength: 24,
    description: "Short chip/tag shown in tab bar and navigation (e.g. 'Auth', 'Database'). Max 24 characters.",
  }),
  prompt: Type.String({
    description: "Full question prompt text in English (e.g. 'Which authentication strategy should the backend implement?').",
  }),
  description: Type.Optional(
    Type.String({
      description: "Optional markdown context or instructions displayed below the prompt.",
    }),
  ),
  notes: Type.Optional(
    Type.String({
      description: "Optional question-level notes or constraints displayed in the question pane.",
    }),
  ),
  type: Type.Optional(
    Type.Union(
      [Type.Literal("single"), Type.Literal("multi"), Type.Literal("text")],
      {
        default: "single",
        description: "Question type: 'single' (radio choices), 'multi' (checkbox choices), or 'text' (pure free-form text input).",
      },
    ),
  ),
  options: Type.Optional(
    Type.Array(QuestionOptionSchema, {
      minItems: 1,
      maxItems: 8,
      description: "Available choices for single or multi questions. Omitted for text questions.",
    }),
  ),
  allowCustom: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Allow user to supply custom text alongside or instead of predefined options (default true for single/multi).",
    }),
  ),
  required: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Whether an answer is mandatory before submission (default true). If false, question can be skipped.",
    }),
  ),
  minSelections: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 8,
      description: "Minimum selections required for multi-select questions.",
    }),
  ),
  maxSelections: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 8,
      description: "Maximum selections allowed for multi-select questions.",
    }),
  ),
  textPlaceholder: Type.Optional(
    Type.String({
      maxLength: 100,
      description: "Placeholder text for text-only questions or custom text input.",
    }),
  ),
  textMinLength: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 1000,
      description: "Minimum character length if custom text is provided.",
    }),
  ),
  textMaxLength: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 4000,
      description: "Maximum character length for custom text.",
    }),
  ),
});

export const BilingualQuestionnaireParamsSchema = Type.Object({
  title: Type.Optional(
    Type.String({
      maxLength: 120,
      description: "Optional global title for the questionnaire displayed in the header.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional global background or guidance for the user.",
    }),
  ),
  notes: Type.Optional(
    Type.String({
      description: "Optional global questionnaire notes.",
    }),
  ),
  questions: Type.Array(QuestionnaireQuestionSchema, {
    minItems: 1,
    maxItems: 8,
    description: "1 to 8 structured questions to ask the user.",
  }),
});

export type QuestionOption = Static<typeof QuestionOptionSchema>;
export type QuestionnaireQuestion = Static<typeof QuestionnaireQuestionSchema>;
export type BilingualQuestionnaireParams = Static<typeof BilingualQuestionnaireParamsSchema>;

/** Canonical answer for one question returned to the model. */
export interface CanonicalQuestionAnswer {
  readonly questionId: string;
  readonly questionHeader: string;
  readonly questionPrompt: string;
  readonly selectedOptionIds: readonly string[];
  readonly selectedOptionLabels: readonly string[];
  readonly selectedOptionPreviews?: readonly string[];
  readonly customText?: string;
  readonly notes?: string;
}

/** Structured details attached to tool result for transcript rendering & state tracking. */
export interface BilingualQuestionnaireDetails {
  readonly version: 1;
  readonly status: "submitted" | "cancelled" | "aborted" | "unsupported" | "error";
  readonly summary: string;
  readonly answers: readonly CanonicalQuestionAnswer[];
  readonly unansweredQuestionIds: readonly string[];
  readonly globalUserNotes?: string;
  readonly durableRecordId?: string;
  readonly translatedDisplayLanguage?: string;
}
