export interface UIChromeStrings {
  readonly reviewAndSubmit: string;
  readonly reviewTitle: string;
  readonly reviewHint: string;
  readonly answeredBadge: string;
  readonly missingRequiredBadge: string;
  readonly skippedOptionalBadge: string;
  readonly globalNotesLabel: string;
  readonly customLabel: string;
  readonly noteLabel: string;
  readonly submitAnswers: string;
  readonly submitIncomplete: string;
  readonly submitPartial: string;
  readonly confirmCancelTitle: string;
  readonly confirmCancelPrompt: string;
  readonly confirmCancelYes: string;
  readonly confirmCancelNo: string;
  readonly confirmSubmitTitle: string;
  readonly confirmSubmitPrompt: string;
  readonly confirmSubmitYes: string;
  readonly confirmSubmitNo: string;
  readonly retryTranslation: string;
  readonly continueInEnglish: string;
  readonly cancelQuestionnaire: string;
  readonly retryAnswers: string;
  readonly returnToEdit: string;
  readonly previewHeader: string;
  readonly noPreview: string;
  readonly addGlobalNotesPrompt: string;
  readonly addQuestionNotesPrompt: string;
  readonly typeCustomPlaceholder: string;
  readonly footerNav: string;
  readonly footerEdit: string;
  readonly emptySelectionConfirm: string;
  readonly skipQuestion: string;
  readonly doneSelections: string;
  readonly backQuestion: string;
  readonly confirmPartialTitle: string;
  readonly submitAnyway: string;
  readonly validationFailed: string;
  readonly requiredBadge: string;
  readonly optionalBadge: string;
  readonly markEmpty: string;
  readonly clearNote: string;
  readonly clearCustom: string;
  readonly togglePreview: string;
  readonly toggleOptions: string;
  readonly submitConfirmTitle: string;
  readonly scrollUpMore: string;
  readonly scrollDownMore: string;
  readonly previewFocusHint: string;
  readonly previewScrollHint: string;
  readonly previewCollapseHint: string;
}

export const DEFAULT_EN_CHROME: UIChromeStrings = {
  reviewAndSubmit: "Review & Submit",
  reviewTitle: "Review & Submit Answers",
  reviewHint: "Press [Enter] on any question row to jump back and edit it.",
  answeredBadge: "✓ Answered",
  missingRequiredBadge: "* Missing - Required",
  skippedOptionalBadge: "○ Skipped - Optional",
  globalNotesLabel: "Global Notes",
  customLabel: "Custom",
  noteLabel: "Note",
  submitAnswers: "Submit Answers",
  submitIncomplete: "Incomplete - Fix Required Questions Above",
  submitPartial: "Submit Partial Answers (Unanswered Remain)",
  confirmCancelTitle: "Are you sure you want to cancel?",
  confirmCancelPrompt: "All entered answers and drafts will be discarded.",
  confirmCancelYes: "Confirm cancel",
  confirmCancelNo: "Keep editing",
  confirmSubmitTitle: "Ready to Submit Questionnaire",
  confirmSubmitPrompt: "All required questions have been answered. Confirm submission?",
  confirmSubmitYes: "Submit answers",
  confirmSubmitNo: "Keep editing",
  retryTranslation: "Retry translation",
  continueInEnglish: "Continue in English",
  cancelQuestionnaire: "Cancel questionnaire",
  retryAnswers: "Retry translating answers",
  returnToEdit: "Return to edit drafts",
  previewHeader: "Preview",
  noPreview: "(No preview available)",
  addGlobalNotesPrompt: "(Press Enter to add overall questionnaire notes...)",
  addQuestionNotesPrompt: "(Add a note for this question...)",
  typeCustomPlaceholder: "(Type custom answer...)",
  footerNav: "[Tab/Shift-Tab] Switch Question  [↑/↓] Navigate  [PgUp/PgDn] Page  [p] Preview  [Space] Select  [Enter] Action  [Esc] Cancel",
  footerEdit: "[Enter] Confirm input  [Esc] Revert/cancel input",
  emptySelectionConfirm: "[Empty] Confirm empty selection",
  skipQuestion: "⏭ Skip this question",
  doneSelections: "✔ Done (confirm selections)",
  backQuestion: "← Back to previous question",
  confirmPartialTitle: "Confirm partial submission?",
  submitAnyway: "Submit anyway?",
  validationFailed: "Validation failed: fix invalid fields",
  requiredBadge: "*required",
  optionalBadge: "optional",
  markEmpty: "Explicit empty selection (mark blank)",
  clearNote: "Clear note",
  clearCustom: "Clear custom text",
  togglePreview: "Toggle preview",
  toggleOptions: "Toggle options",
  submitConfirmTitle: "Submit questionnaire answers?",
  scrollUpMore: "▲ (scroll up for more)",
  scrollDownMore: "▼ (scroll down for more)",
  previewFocusHint: "Press [p] to focus preview",
  previewScrollHint: "[↑/↓/PgUp/PgDn] Scroll preview  [Esc/p] Return to controls",
  previewCollapseHint: "Press [p] to collapse preview",
};
