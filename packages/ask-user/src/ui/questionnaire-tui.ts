import {
  Input,
  Markdown,
  CURSOR_MARKER,
  renderFakeCursor,
  truncateToWidth,
  visibleWidth,
  sliceByColumn,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { QuestionnaireStateMachine } from "../domain/state.js";
import type {
  DisplayOption,
  DisplayQuestion,
  DisplayQuestionnaire,
} from "../domain/projection.js";
import { DEFAULT_EN_CHROME, type UIChromeStrings } from "../domain/chrome.js";

export type TUIExitAction =
  | { action: "submit" }
  | { action: "cancel" }
  | { action: "retry_display" }
  | { action: "continue_english" }
  | { action: "retry_answer" }
  | { action: "retry_discovery" };

export interface QuestionnaireTUIOptions {
  readonly state: QuestionnaireStateMachine;
  readonly display: DisplayQuestionnaire;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings?: KeybindingsManager | undefined;
  readonly onDone: (result: TUIExitAction) => void;
  readonly displayError?: string | undefined;
  readonly answerError?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

type ActiveInputMode =
  | "none"
  | "custom_text"
  | "question_note"
  | "global_note"
  | "confirm_cancel"
  | "confirm_submit_full"
  | "confirm_submit_partial";

export type QuestionRowDescriptor =
  | { readonly kind: "option"; readonly optionIndex: number; readonly option: DisplayOption }
  | { readonly kind: "custom" }
  | { readonly kind: "empty" }
  | { readonly kind: "note" };

export type ReviewRowDescriptor =
  | { readonly kind: "question"; readonly questionIndex: number; readonly question: DisplayQuestion }
  | { readonly kind: "global_note" }
  | { readonly kind: "submit" };

export class QuestionnaireTUIComponent implements Component, Focusable {
  public focused = true;

  private readonly state: QuestionnaireStateMachine;
  private readonly display: DisplayQuestionnaire;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings?: KeybindingsManager | undefined;
  private readonly onDone: (result: TUIExitAction) => void;
  private readonly chrome: UIChromeStrings;
  private readonly signal?: AbortSignal | undefined;
  private abortListener?: (() => void) | undefined;

  private inputMode: ActiveInputMode = "none";
  private focusedItemIndex = 0;
  private focusedItemChanged = false;
  private activeInput?: Input | undefined;

  private displayError?: string | undefined;
  private answerError?: string | undefined;
  private alertMessage?: string | undefined;
  private previewExpanded = false;
  private previewFocusMode = false;

  private bodyScrollOffset = 0;
  private maxScrollOffset = 0;
  private lastMaxBodyHeight = 10;
  private cachedWidth?: number | undefined;
  private cachedHeight?: number | undefined;
  private cachedLines?: string[] | undefined;
  private dialogScrollOffset = 0;

  constructor(options: QuestionnaireTUIOptions) {
    this.state = options.state;
    this.display = options.display;
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.onDone = options.onDone;
    this.displayError = options.displayError;
    this.answerError = options.answerError;
    this.chrome = options.display.chrome ?? DEFAULT_EN_CHROME;
    this.signal = options.signal;

    if (this.signal) {
      this.abortListener = () => {
        this.cleanup();
        this.onDone({ action: "cancel" });
      };
      if (this.signal.aborted) {
        this.abortListener();
      } else {
        this.signal.addEventListener("abort", this.abortListener, { once: true });
      }
    }
  }

  public dispose(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.abortListener && this.signal) {
      this.signal.removeEventListener("abort", this.abortListener);
      this.abortListener = undefined;
    }
  }

  private finish(action: TUIExitAction): void {
    this.displayError = undefined;
    this.answerError = undefined;
    this.dialogScrollOffset = 0;
    this.cleanup();
    this.onDone(action);
  }

  public setDisplayError(error?: string): void {
    this.displayError = error;
    this.dialogScrollOffset = 0;
    this.invalidate();
  }

  public setAnswerError(error?: string): void {
    this.answerError = error;
    this.dialogScrollOffset = 0;
    this.invalidate();
  }

  public invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  public getQuestionRows(q: DisplayQuestion): QuestionRowDescriptor[] {
    const rows: QuestionRowDescriptor[] = [];
    for (let i = 0; i < q.options.length; i++) {
      rows.push({ kind: "option", optionIndex: i, option: q.options[i]! });
    }
    if (q.allowCustom || q.type === "text") {
      rows.push({ kind: "custom" });
    }
    if (!q.required || (q.type === "multi" && (q.minSelections ?? 0) === 0)) {
      rows.push({ kind: "empty" });
    }
    rows.push({ kind: "note" });
    return rows;
  }

  public getReviewRows(): ReviewRowDescriptor[] {
    const rows: ReviewRowDescriptor[] = [];
    for (let i = 0; i < this.display.questions.length; i++) {
      rows.push({ kind: "question", questionIndex: i, question: this.display.questions[i]! });
    }
    rows.push({ kind: "global_note" });
    rows.push({ kind: "submit" });
    return rows;
  }

  private hasPreviewContent(): boolean {
    const q = this.display.questions[this.state.currentQuestionIndex];
    if (!q) return false;
    const rows = this.getQuestionRows(q);
    const focusedRow = rows[this.focusedItemIndex];
    if (focusedRow && focusedRow.kind === "option") {
      if (focusedRow.option.preview?.trim() || focusedRow.option.description?.trim()) return true;
    }
    return Boolean(q.description?.trim());
  }

  public render(width: number): string[] {
    const termRows = Math.max(
      1,
      this.tui.terminal?.rows ?? (typeof process !== "undefined" && process.stdout?.rows ? process.stdout.rows : 24),
    );

    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === termRows) {
      return this.cachedLines;
    }

    this.cachedWidth = width;
    this.cachedHeight = termRows;

    // 1. Display Error Recovery Screen
    if (this.displayError) {
      return this.renderCompactDialog(
        width,
        termRows,
        this.theme.fg("error", " Display translation failed:"),
        [this.theme.fg("dim", `  ${this.displayError}`)],
        [
          { key: "[r]", label: this.chrome.retryTranslation, short: "Retry" },
          { key: "[e/Enter]", label: this.chrome.continueInEnglish, short: "English" },
          { key: "[c/Esc]", label: this.chrome.cancelQuestionnaire, short: "Cancel" },
        ],
      );
    }

    // 2. Answer Error Recovery Screen
    if (this.answerError) {
      return this.renderCompactDialog(
        width,
        termRows,
        this.theme.fg("error", " Answer translation failed:"),
        [
          this.theme.fg("dim", `  ${this.answerError}`),
          this.theme.fg("dim", "  Your draft answers are preserved in memory."),
        ],
        [
          { key: "[r]", label: this.chrome.retryAnswers, short: "Retry" },
          { key: "[e/Enter]", label: this.chrome.returnToEdit, short: "Edit" },
          { key: "[c/Esc]", label: this.chrome.cancelQuestionnaire, short: "Cancel" },
        ],
      );
    }

    // 3. Cancel Confirmation Screen
    if (this.inputMode === "confirm_cancel") {
      return this.renderCompactDialog(
        width,
        termRows,
        this.theme.fg("warning", ` ${this.chrome.confirmCancelTitle}`),
        [this.theme.fg("dim", `  ${this.chrome.confirmCancelPrompt}`)],
        [
          { key: "[y/Enter]", label: this.chrome.confirmCancelYes, short: "Yes" },
          { key: "[n/Esc]", label: this.chrome.confirmCancelNo, short: "No" },
        ],
      );
    }

    // 4. Submit Confirmation Screens
    if (this.inputMode === "confirm_submit_full") {
      return this.renderCompactDialog(
        width,
        termRows,
        this.theme.fg("accent", ` ${this.chrome.confirmSubmitTitle}`),
        [this.theme.fg("dim", `  ${this.chrome.confirmSubmitPrompt}`)],
        [
          { key: "[y/Enter]", label: this.chrome.confirmSubmitYes, short: "Yes" },
          { key: "[n/Esc]", label: this.chrome.confirmSubmitNo, short: "No" },
        ],
      );
    }

    if (this.inputMode === "confirm_submit_partial") {
      const unansweredIds = this.state.getUnansweredQuestionIds();
      const headers = unansweredIds.map((id) => this.display.questions.find((q) => q.id === id)?.header ?? id);
      return this.renderCompactDialog(
        width,
        termRows,
        this.theme.fg("warning", ` ${this.chrome.confirmPartialTitle}`),
        [
          this.theme.fg("dim", `  Unanswered questions: ${headers.join(", ")}`),
          this.theme.fg("dim", `  ${this.chrome.submitAnyway}`),
        ],
        [
          { key: "[y/Enter]", label: this.chrome.submitPartial, short: "Yes" },
          { key: "[n/Esc]", label: this.chrome.confirmSubmitNo, short: "No" },
        ],
      );
    }

    // 5. Build Header Bar
    const headerLines: string[] = [];
    const langBadge = this.display.isTranslated ? `[${this.display.language.toUpperCase()}]` : "[EN]";
    const titleText = this.display.title ?? "Questionnaire";
    const curIdx = this.state.currentQuestionIndex;
    const totalQ = this.state.questions.length;
    const progressText = this.state.isReviewTab
      ? `[${this.chrome.reviewAndSubmit}]`
      : `[Q ${curIdx + 1} of ${totalQ}]`;

    const headerLeft = ` ${this.theme.style(titleText, { bold: true, fg: "accent" })} ${this.theme.fg("dim", langBadge)}`;
    const headerRight = `${this.theme.fg("dim", progressText)} `;
    const padding = Math.max(0, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
    headerLines.push(headerLeft + " ".repeat(padding) + headerRight);
    if (termRows > 12) {
      headerLines.push(this.theme.fg("dim", "─".repeat(width)));
    }

    // 6. Build Windowed Tab Bar (Strictly 1 line, active tab always visible)
    const allChips: string[] = [];
    for (let i = 0; i < this.display.questions.length; i++) {
      const q = this.display.questions[i]!;
      const ans = this.state.getAnswer(q.id);
      let statusIcon = "○";
      if (ans.isAnswered) {
        statusIcon = "✓";
      } else if (q.required) {
        statusIcon = "*";
      }

      const isCurrent = !this.state.isReviewTab && this.state.currentQuestionIndex === i;
      const chipText = `${i + 1}. ${q.header} ${statusIcon}`;
      if (isCurrent) {
        allChips.push(this.theme.style(`[ ${chipText} ]`, { bold: true, fg: "accent" }));
      } else {
        allChips.push(this.theme.fg("dim", `[ ${chipText} ]`));
      }
    }

    const reviewChipText = this.chrome.reviewAndSubmit;
    if (this.state.isReviewTab) {
      allChips.push(this.theme.style(`[ ${reviewChipText} ]`, { bold: true, fg: "accent" }));
    } else {
      allChips.push(this.theme.fg("dim", `[ ${reviewChipText} ]`));
    }

    const activeTabIdx = this.state.isReviewTab ? this.display.questions.length : this.state.currentQuestionIndex;
    const fullTabStr = " " + allChips.join(" ");
    let tabLine = "";
    if (visibleWidth(fullTabStr) <= width) {
      tabLine = fullTabStr;
    } else {
      const activeChip = allChips[activeTabIdx]!;
      let startIdx = activeTabIdx;
      let endIdx = activeTabIdx;
      let curWidth = 1 + visibleWidth(activeChip);

      let expanded = true;
      while (expanded) {
        expanded = false;
        if (endIdx + 1 < allChips.length) {
          const nextRight = allChips[endIdx + 1]!;
          const rightLen = 1 + visibleWidth(nextRight);
          const ellipsisLeft = startIdx > 0 ? 5 : 0;
          const ellipsisRight = endIdx + 1 < allChips.length - 1 ? 5 : 0;
          if (curWidth + rightLen + ellipsisLeft + ellipsisRight <= width) {
            endIdx++;
            curWidth += rightLen;
            expanded = true;
          }
        }
        if (startIdx - 1 >= 0) {
          const nextLeft = allChips[startIdx - 1]!;
          const leftLen = 1 + visibleWidth(nextLeft);
          const ellipsisLeft = startIdx - 1 > 0 ? 5 : 0;
          const ellipsisRight = endIdx < allChips.length - 1 ? 5 : 0;
          if (curWidth + leftLen + ellipsisLeft + ellipsisRight <= width) {
            startIdx--;
            curWidth += leftLen;
            expanded = true;
          }
        }
      }

      const visibleSlice = allChips.slice(startIdx, endIdx + 1);
      tabLine =
        " " +
        (startIdx > 0 ? this.theme.fg("dim", "‹... ") : "") +
        visibleSlice.join(" ") +
        (endIdx < allChips.length - 1 ? this.theme.fg("dim", " ...›") : "");
    }
    headerLines.push(tabLine);
    headerLines.push(this.theme.fg("dim", "─".repeat(width)));

    // 7. Footer Lines
    const footerLines: string[] = [this.theme.fg("dim", "─".repeat(width))];
    if (this.alertMessage) {
      if (termRows > 14) {
        footerLines.push(this.theme.fg("error", ` ⚠ ${this.alertMessage}`));
        if (this.previewFocusMode) {
          footerLines.push(this.theme.fg("accent", ` ${this.chrome.previewScrollHint}`));
        } else if (this.inputMode === "none") {
          footerLines.push(this.theme.fg("dim", ` ${this.chrome.footerNav}`));
        } else {
          footerLines.push(this.theme.fg("dim", ` ${this.chrome.footerEdit}`));
        }
      } else {
        footerLines.push(this.theme.fg("error", ` ⚠ ${this.alertMessage}`));
      }
    } else {
      if (this.previewFocusMode) {
        footerLines.push(this.theme.fg("accent", ` ${this.chrome.previewScrollHint}`));
      } else if (this.inputMode === "none") {
        footerLines.push(this.theme.fg("dim", ` ${this.chrome.footerNav}`));
      } else {
        footerLines.push(this.theme.fg("dim", ` ${this.chrome.footerEdit}`));
      }
    }

    // 8. Body Viewport Calculation
    const fixedLines = headerLines.length + footerLines.length;
    const maxBodyHeight = Math.max(1, termRows - fixedLines);
    this.lastMaxBodyHeight = maxBodyHeight;

    const bodyLines: string[] = [];
    const rowLineRanges: Array<{ start: number; end: number }> = [];

    if (this.state.isReviewTab) {
      this.renderReviewBody(bodyLines, rowLineRanges, width);
    } else {
      this.renderQuestionBody(bodyLines, rowLineRanges, width);
    }

    this.maxScrollOffset = Math.max(0, bodyLines.length - maxBodyHeight);

    // Clamp focused item index and adjust viewport scroll
    const activeRowsCount = this.state.isReviewTab
      ? this.getReviewRows().length
      : this.getQuestionRows(this.display.questions[this.state.currentQuestionIndex]!).length;

    this.focusedItemIndex = Math.max(0, Math.min(this.focusedItemIndex, activeRowsCount - 1));

    const focusedRange = rowLineRanges[this.focusedItemIndex] ?? { start: 0, end: 0 };

    if (this.inputMode !== "none") {
      // Input mode: keep active editor visible so cursor marker is never clipped
      if (focusedRange.start < this.bodyScrollOffset) {
        this.bodyScrollOffset = focusedRange.start;
      } else if (focusedRange.start >= this.bodyScrollOffset + maxBodyHeight) {
        this.bodyScrollOffset = Math.max(0, focusedRange.start - maxBodyHeight + 1);
      }
    } else if (this.focusedItemChanged && !this.previewFocusMode) {
      // Normal row navigation: keep focused row visible
      if (focusedRange.start < this.bodyScrollOffset) {
        this.bodyScrollOffset = focusedRange.start;
      } else if (focusedRange.end >= this.bodyScrollOffset + maxBodyHeight) {
        this.bodyScrollOffset = Math.max(0, focusedRange.end - maxBodyHeight + 1);
      }
      this.focusedItemChanged = false;
    }

    // Ensure scroll offset stays within bounds without snapping back on manual scroll
    this.bodyScrollOffset = Math.max(0, Math.min(this.bodyScrollOffset, this.maxScrollOffset));

    // Update dividers with scroll indicators instead of slicing visible body lines
    if (this.bodyScrollOffset > 0) {
      const scrollUpText = ` ▲ ${this.chrome.scrollUpMore} `;
      const padLeft = "──";
      const padRightLen = Math.max(0, width - visibleWidth(padLeft) - visibleWidth(scrollUpText));
      headerLines[headerLines.length - 1] =
        this.theme.fg("dim", padLeft) +
        this.theme.fg("accent", scrollUpText) +
        this.theme.fg("dim", "─".repeat(padRightLen));
    }

    if (this.bodyScrollOffset + maxBodyHeight < bodyLines.length) {
      const scrollDownText = ` ▼ ${this.chrome.scrollDownMore} `;
      const padLeft = "──";
      const padRightLen = Math.max(0, width - visibleWidth(padLeft) - visibleWidth(scrollDownText));
      footerLines[0] =
        this.theme.fg("dim", padLeft) +
        this.theme.fg("accent", scrollDownText) +
        this.theme.fg("dim", "─".repeat(padRightLen));
    }

    const visibleBody = bodyLines.slice(this.bodyScrollOffset, this.bodyScrollOffset + maxBodyHeight);

    let assembled = [...headerLines, ...visibleBody, ...footerLines];
    if (assembled.length > termRows) {
      const excess = assembled.length - termRows;
      if (visibleBody.length > excess) {
        visibleBody.splice(visibleBody.length - excess, excess);
        assembled = [...headerLines, ...visibleBody, ...footerLines];
      } else {
        assembled = assembled.slice(0, termRows);
      }
    }

    this.cachedLines = assembled.map((l) => truncateToWidth(l, width));
    return this.cachedLines;
  }

  private renderCompactDialog(
    width: number,
    termRows: number,
    title: string,
    details: string[],
    actions: Array<{ key: string; label: string; short: string }>,
  ): string[] {
    const maxLines = Math.max(1, termRows);
    let lines: string[] = [];

    const fullHeightNeeded = 1 + details.length + 1 + actions.length;

    if (maxLines >= fullHeightNeeded) {
      lines.push(title);
      lines.push(...details);
      lines.push("");
      for (const act of actions) {
        lines.push(`  ${this.theme.fg("accent", act.key)} ${act.label}`);
      }
    } else if (maxLines >= 1 + details.length + actions.length) {
      lines.push(title);
      lines.push(...details);
      for (const act of actions) {
        lines.push(`  ${this.theme.fg("accent", act.key)} ${act.label}`);
      }
    } else if (maxLines === 1) {
      const actionHints = actions.map((a) => `${this.theme.fg("accent", a.key)} ${a.short}`).join(" ");
      lines.push(`${title.trim()} ${actionHints}`);
    } else {
      const actionLine = "  " + actions.map((a) => `${this.theme.fg("accent", a.key)} ${a.short}`).join("  ");
      const availableContentLines = maxLines - 1;
      lines.push(title);

      const availableDetailLines = availableContentLines - 1;
      if (availableDetailLines > 0 && details.length > 0) {
        const maxOffset = Math.max(0, details.length - availableDetailLines);
        const offset = Math.min(this.dialogScrollOffset, maxOffset);
        const visibleDetails = details.slice(offset, offset + availableDetailLines);
        lines.push(...visibleDetails);
      }

      while (lines.length < maxLines - 1) {
        lines.push("");
      }
      lines.push(actionLine);
    }

    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
    }

    this.cachedLines = lines.map((l) => truncateToWidth(l, width));
    return this.cachedLines;
  }

  private renderQuestionBody(
    bodyLines: string[],
    rowLineRanges: Array<{ start: number; end: number }>,
    width: number,
  ): void {
    const q = this.display.questions[this.state.currentQuestionIndex]!;
    const ans = this.state.getAnswer(q.id);
    const rows = this.getQuestionRows(q);

    const isSideBySide = width >= 80;
    const isStacked = width >= 60 && width < 80;

    const leftWidth = isSideBySide ? Math.floor(width * 0.55) : width;
    const rightWidth = isSideBySide ? width - leftWidth - 3 : width;

    const leftLines: string[] = [];
    const reqBadge = q.required
      ? this.theme.fg("warning", `*${this.chrome.requiredBadge}`)
      : this.theme.fg("dim", this.chrome.optionalBadge);

    // 1. Question-local validation errors persist when editing from review
    const qValidationErrors = this.state.getQuestionValidationErrors(q.id);
    if (qValidationErrors.length > 0) {
      for (const err of qValidationErrors) {
        const errText = `⚠ ${this.chrome.validationFailed}: ${err}`;
        const wrappedErr = wrapTextWithAnsi(this.theme.fg("error", errText), Math.max(10, leftWidth - 2));
        for (const l of wrappedErr) {
          leftLines.push(" " + l);
        }
      }
    }

    // 2. Wrap prompt to ensure readability without native truncation
    const promptText = ` ${this.theme.style(q.prompt, { bold: true })} ${reqBadge}`;
    const wrappedPrompt = wrapTextWithAnsi(promptText, Math.max(10, leftWidth - 1));
    for (const l of wrappedPrompt) {
      leftLines.push(l);
    }

    // 3. Wrap description
    if (q.description) {
      const descText = ` ${this.theme.fg("dim", q.description)}`;
      const wrappedDesc = wrapTextWithAnsi(descText, Math.max(10, leftWidth - 1));
      for (const l of wrappedDesc) {
        leftLines.push(l);
      }
    }

    // 4. Wrap question notes
    if (q.notes) {
      const notesText = ` ${this.theme.fg("dim", `${this.chrome.noteLabel}: ${q.notes}`)}`;
      const wrappedNotes = wrapTextWithAnsi(notesText, Math.max(10, leftWidth - 1));
      for (const l of wrappedNotes) {
        leftLines.push(l);
      }
    }
    leftLines.push("");

    const isMulti = q.type === "multi";

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx]!;
      const isFocused = !this.previewFocusMode && this.focusedItemIndex === rIdx;
      const cursor = isFocused ? this.theme.fg("accent", "> ") : "  ";
      const startLine = leftLines.length;

      if (row.kind === "option") {
        const opt = row.option;
        const isSelected = ans.selectedOptionIds.includes(opt.id);
        const marker = isMulti
          ? isSelected ? "[*]" : "[ ]"
          : isSelected ? "(*)" : "( )";

        const labelStyle = isFocused
          ? this.theme.style(opt.label, { bold: true, fg: "accent" })
          : opt.label;

        const optPrefix = `${cursor}${marker} `;
        const availOptWidth = Math.max(10, leftWidth - visibleWidth(optPrefix));
        const wrappedLabel = wrapTextWithAnsi(labelStyle, availOptWidth);
        leftLines.push(`${optPrefix}${wrappedLabel[0] ?? ""}`);
        for (let i = 1; i < wrappedLabel.length; i++) {
          leftLines.push("      " + wrappedLabel[i]);
        }
        if (opt.description) {
          const optDesc = this.theme.fg("dim", opt.description);
          const wrapped = wrapTextWithAnsi(optDesc, Math.max(10, leftWidth - 7));
          for (const wl of wrapped) {
            leftLines.push(`      ${wl}`);
          }
        }
      } else if (row.kind === "custom") {
        const hasCustom = typeof ans.customText === "string" && ans.customText.trim().length > 0;
        const customPrefix = isMulti
          ? hasCustom ? "[*] " : "[ ] "
          : hasCustom ? "✏ " : "  ";

        if (this.inputMode === "custom_text" && this.activeInput) {
          const prompt = `${cursor}${customPrefix}${this.chrome.customLabel}: `;
          const avail = Math.max(10, leftWidth - visibleWidth(prompt));
          const renderedInput = this.activeInput.render(avail)[0] ?? "";
          leftLines.push(prompt + renderedInput);
        } else {
          const customDisplay = hasCustom
            ? ans.customText
            : this.theme.fg("dim", q.textPlaceholder ?? this.chrome.typeCustomPlaceholder);
          const customText = `[c] ${this.chrome.customLabel}: ${customDisplay}`;
          const customStyle = isFocused
            ? this.theme.style(customText, { bold: true, fg: "accent" })
            : customText;
          const avail = Math.max(10, leftWidth - visibleWidth(`${cursor}${customPrefix}`));
          const wrappedCustom = wrapTextWithAnsi(customStyle, avail);
          leftLines.push(`${cursor}${customPrefix}${wrappedCustom[0] ?? ""}`);
          for (let i = 1; i < wrappedCustom.length; i++) {
            leftLines.push("    " + wrappedCustom[i]);
          }
        }
      } else if (row.kind === "empty") {
        const isConfirmedEmpty = ans.emptySelectionConfirmed;
        const marker = isConfirmedEmpty ? "[*]" : "[ ]";
        const emptyLabel = `${marker} [e] ${this.chrome.markEmpty}`;
        const emptyStyle = isFocused
          ? this.theme.style(emptyLabel, { bold: true, fg: "accent" })
          : emptyLabel;
        leftLines.push(`${cursor}${emptyStyle}`);
      } else if (row.kind === "note") {
        if (this.inputMode === "question_note" && this.activeInput) {
          const prompt = `${cursor}  [n] ${this.chrome.noteLabel}: `;
          const avail = Math.max(10, leftWidth - visibleWidth(prompt));
          const renderedNote = this.activeInput.render(avail)[0] ?? "";
          leftLines.push(prompt + renderedNote);
        } else {
          const noteDisplay = ans.notes
            ? ans.notes
            : this.theme.fg("dim", this.chrome.addQuestionNotesPrompt);
          const noteText = `[n] ${this.chrome.noteLabel}: ${noteDisplay}`;
          const noteStyle = isFocused
            ? this.theme.style(noteText, { bold: true, fg: "accent" })
            : noteText;
          const avail = Math.max(10, leftWidth - visibleWidth(`${cursor}  `));
          const wrappedNote = wrapTextWithAnsi(noteStyle, avail);
          leftLines.push(`${cursor}  ${wrappedNote[0] ?? ""}`);
          for (let i = 1; i < wrappedNote.length; i++) {
            leftLines.push("    " + wrappedNote[i]);
          }
        }
      }

      const endLine = leftLines.length - 1;
      rowLineRanges.push({ start: startLine, end: endLine });
    }

    // Determine preview content for focused item
    let previewContent = "";
    const focusedRow = rows[this.focusedItemIndex];
    if (focusedRow && focusedRow.kind === "option") {
      previewContent = focusedRow.option.preview ?? focusedRow.option.description ?? "";
    }
    if (!previewContent && q.description) {
      previewContent = q.description;
    }

    if (isSideBySide) {
      const rightLines: string[] = [];
      const previewHeaderTitle = this.previewFocusMode
        ? `─ ${this.chrome.previewHeader} [focused] ─`
        : `─ ${this.chrome.previewHeader} ─`;
      rightLines.push(this.theme.fg("dim", previewHeaderTitle));
      if (previewContent.trim()) {
        try {
          const mdTheme = getMarkdownTheme();
          const md = new Markdown(previewContent, 0, 0, mdTheme);
          rightLines.push(...md.render(rightWidth));
        } catch {
          rightLines.push(...previewContent.split("\n"));
        }
      } else {
        rightLines.push(this.theme.fg("dim", this.chrome.noPreview));
      }

      const maxBodyLines = Math.max(leftLines.length, rightLines.length);
      for (let i = 0; i < maxBodyLines; i++) {
        const left = leftLines[i] ?? "";
        const right = rightLines[i] ?? "";
        const paddedLeft = truncateToWidth(left, leftWidth);
        const padLen = Math.max(0, leftWidth - visibleWidth(paddedLeft));
        const divider = this.theme.fg("dim", " │ ");
        const paddedRight = truncateToWidth(right, rightWidth);
        bodyLines.push(paddedLeft + " ".repeat(padLen) + divider + paddedRight);
      }
    } else if (isStacked) {
      bodyLines.push(...leftLines);
      const previewTitle = this.previewFocusMode
        ? `─ ${this.chrome.previewHeader} [focused] ─`
        : `─ ${this.chrome.previewHeader} ─`;
      bodyLines.push(this.theme.fg("dim", previewTitle));
      if (previewContent.trim()) {
        try {
          const mdTheme = getMarkdownTheme();
          const md = new Markdown(previewContent, 0, 0, mdTheme);
          const rendered = md.render(width);
          if (this.previewExpanded || this.previewFocusMode) {
            bodyLines.push(...rendered);
          } else {
            bodyLines.push(...rendered.slice(0, 4));
            if (rendered.length > 4) {
              bodyLines.push(this.theme.fg("dim", ` (${this.chrome.previewFocusHint})`));
            }
          }
        } catch {
          bodyLines.push(...previewContent.split("\n").slice(0, this.previewExpanded || this.previewFocusMode ? undefined : 4));
        }
      }
    } else {
      // Compact mode (< 60)
      bodyLines.push(...leftLines);
      if (previewContent.trim()) {
        if (this.previewExpanded || this.previewFocusMode) {
          const previewTitle = this.previewFocusMode
            ? `─ ${this.chrome.previewHeader} [focused] ─`
            : `─ ${this.chrome.previewHeader} [p: collapse] ─`;
          bodyLines.push(this.theme.fg("dim", previewTitle));
          try {
            const mdTheme = getMarkdownTheme();
            const md = new Markdown(previewContent, 0, 0, mdTheme);
            bodyLines.push(...md.render(width));
          } catch {
            bodyLines.push(...previewContent.split("\n"));
          }
        } else {
          bodyLines.push(this.theme.fg("dim", `─ ${this.chrome.previewHeader} (${this.chrome.previewFocusHint}) ─`));
        }
      }
    }
  }

  private renderReviewBody(
    bodyLines: string[],
    rowLineRanges: Array<{ start: number; end: number }>,
    width: number,
  ): void {
    bodyLines.push(` ${this.theme.style(this.chrome.reviewTitle, { bold: true, fg: "accent" })}`);
    bodyLines.push(this.theme.fg("dim", ` ${this.chrome.reviewHint}`));
    bodyLines.push("");

    const rows = this.getReviewRows();
    const errors = this.state.getAllValidationErrors();
    const errorMap = new Map<string, string[]>();
    for (const err of errors) {
      const list = errorMap.get(err.questionId) ?? [];
      list.push(err.message);
      errorMap.set(err.questionId, list);
    }

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx]!;
      const isFocused = this.focusedItemIndex === rIdx;
      const cursor = isFocused ? this.theme.fg("accent", "> ") : "  ";
      const startLine = bodyLines.length;

      if (row.kind === "question") {
        const q = row.question;
        const ans = this.state.getAnswer(q.id);
        const errs = errorMap.get(q.id);

        let statusBadge = this.theme.fg("accent", `[${this.chrome.answeredBadge}]`);
        if (!ans.isAnswered) {
          statusBadge = q.required
            ? this.theme.fg("error", `[${this.chrome.missingRequiredBadge}]`)
            : this.theme.fg("dim", `[${this.chrome.skippedOptionalBadge}]`);
        } else if (errs && errs.length > 0) {
          statusBadge = this.theme.fg("error", `[! ${errs[0]}]`);
        }

        const chosenLabels: string[] = [];
        for (const optId of ans.selectedOptionIds) {
          const found = q.options.find((o) => o.id === optId);
          if (found) chosenLabels.push(found.label);
        }
        if (ans.customText) {
          chosenLabels.push(`Custom: "${ans.customText}"`);
        }
        if (ans.emptySelectionConfirmed) {
          chosenLabels.push(`(${this.chrome.markEmpty})`);
        }
        const answerSummary = chosenLabels.length > 0 ? chosenLabels.join(", ") : "(Empty)";

        const rowText = `${cursor}${row.questionIndex + 1}. ${this.theme.style(q.header, { bold: true })}: ${answerSummary}  ${statusBadge}`;
        const wrappedRow = wrapTextWithAnsi(rowText, Math.max(10, width - 1));
        for (const l of wrappedRow) {
          bodyLines.push(l);
        }
        if (ans.notes) {
          const wrappedNotes = wrapTextWithAnsi(this.theme.fg("dim", `${this.chrome.noteLabel}: ${ans.notes}`), Math.max(10, width - 6));
          for (const l of wrappedNotes) {
            bodyLines.push("     " + l);
          }
        }
      } else if (row.kind === "global_note") {
        if (this.inputMode === "global_note" && this.activeInput) {
          const prompt = `${cursor}  [n] ${this.chrome.globalNotesLabel}: `;
          const avail = Math.max(10, width - visibleWidth(prompt));
          const renderedGlobal = this.activeInput.render(avail)[0] ?? "";
          bodyLines.push(prompt + renderedGlobal);
        } else {
          const noteText = this.state.globalUserNotes
            ? this.state.globalUserNotes
            : this.theme.fg("dim", this.chrome.addGlobalNotesPrompt);
          const noteStyle = isFocused
            ? this.theme.style(`[n] ${this.chrome.globalNotesLabel}: ${noteText}`, { bold: true, fg: "accent" })
            : `[n] ${this.chrome.globalNotesLabel}: ${noteText}`;
          const wrappedGlobal = wrapTextWithAnsi(noteStyle, Math.max(10, width - visibleWidth(`${cursor}  `)));
          bodyLines.push(`${cursor}  ${wrappedGlobal[0] ?? ""}`);
          for (let i = 1; i < wrappedGlobal.length; i++) {
            bodyLines.push("    " + wrappedGlobal[i]);
          }
        }
      } else if (row.kind === "submit") {
        bodyLines.push("");
        const canSubmitAll = this.state.canSubmit(false);
        const canSubmitPartial = this.state.canSubmit(true);

        if (canSubmitAll) {
          const btn = isFocused
            ? this.theme.style(` [ ${this.chrome.submitAnswers.toUpperCase()} ] `, { bold: true, fg: "accent" })
            : ` [ ${this.chrome.submitAnswers} ] `;
          bodyLines.push(`${cursor}${btn}`);
        } else if (canSubmitPartial) {
          const btn = isFocused
            ? this.theme.style(` [ ${this.chrome.submitPartial.toUpperCase()} ] `, { bold: true, fg: "warning" })
            : ` [ ${this.chrome.submitPartial} ] `;
          bodyLines.push(`${cursor}${btn}`);
        } else {
          const btn = this.theme.fg("dim", ` [ ${this.chrome.submitIncomplete} ] `);
          bodyLines.push(`${cursor}${btn}`);
        }
      }

      const endLine = bodyLines.length - 1;
      rowLineRanges.push({ start: startLine, end: endLine });
    }
  }

  public handleInput(data: string): void {
    // 1. Recovery screen hotkeys (Enter defaults to edit/continue; respects public keybindings)
    if (this.displayError) {
      if (data === "r" || data === "R") {
        this.displayError = undefined;
        this.dialogScrollOffset = 0;
        this.finish({ action: "retry_display" });
        return;
      }
      if (data === "e" || data === "E" || this.matchesBinding(data, "tui.select.confirm", ["\r", "\n"]) || data === " ") {
        this.displayError = undefined;
        this.dialogScrollOffset = 0;
        this.finish({ action: "continue_english" });
        return;
      }
      if (data === "c" || data === "C" || this.matchesBinding(data, "tui.select.cancel", ["\x1b"])) {
        this.dialogScrollOffset = 0;
        this.finish({ action: "cancel" });
        return;
      }
      if (this.matchesBinding(data, "tui.select.up", ["\x1b[A", "k"])) {
        if (this.dialogScrollOffset > 0) {
          this.dialogScrollOffset--;
          this.invalidate();
        }
        return;
      }
      if (this.matchesBinding(data, "tui.select.down", ["\x1b[B", "j"])) {
        this.dialogScrollOffset++;
        this.invalidate();
        return;
      }
      return;
    }

    if (this.answerError) {
      if (data === "r" || data === "R") {
        this.answerError = undefined;
        this.dialogScrollOffset = 0;
        this.finish({ action: "retry_answer" });
        return;
      }
      if (data === "e" || data === "E" || this.matchesBinding(data, "tui.select.confirm", ["\r", "\n"]) || data === " ") {
        this.answerError = undefined;
        this.dialogScrollOffset = 0;
        this.invalidate();
        return;
      }
      if (data === "c" || data === "C" || this.matchesBinding(data, "tui.select.cancel", ["\x1b"])) {
        this.dialogScrollOffset = 0;
        this.finish({ action: "cancel" });
        return;
      }
      if (this.matchesBinding(data, "tui.select.up", ["\x1b[A", "k"])) {
        if (this.dialogScrollOffset > 0) {
          this.dialogScrollOffset--;
          this.invalidate();
        }
        return;
      }
      if (this.matchesBinding(data, "tui.select.down", ["\x1b[B", "j"])) {
        this.dialogScrollOffset++;
        this.invalidate();
        return;
      }
      return;
    }

    // 2. Cancellation Confirmation Mode
    if (this.inputMode === "confirm_cancel") {
      if (data === "y" || data === "Y" || data === "\r" || data === "\n") {
        this.dialogScrollOffset = 0;
        this.finish({ action: "cancel" });
        return;
      }
      if (data === "n" || data === "N" || data === "\x1b") {
        this.dialogScrollOffset = 0;
        this.inputMode = "none";
        this.invalidate();
        return;
      }
      if (this.matchesBinding(data, "tui.select.up", ["\x1b[A", "k"])) {
        if (this.dialogScrollOffset > 0) {
          this.dialogScrollOffset--;
          this.invalidate();
        }
        return;
      }
      if (this.matchesBinding(data, "tui.select.down", ["\x1b[B", "j"])) {
        this.dialogScrollOffset++;
        this.invalidate();
        return;
      }
      return;
    }

    // 3. Submit Confirmation Modes
    if (this.inputMode === "confirm_submit_full" || this.inputMode === "confirm_submit_partial") {
      if (
        data === "y" ||
        data === "Y" ||
        data === "\r" ||
        data === "\n" ||
        data === "s" ||
        data === "S"
      ) {
        this.dialogScrollOffset = 0;
        this.finish({ action: "submit" });
        return;
      }
      if (data === "n" || data === "N" || data === "\x1b") {
        this.dialogScrollOffset = 0;
        this.inputMode = "none";
        this.invalidate();
        return;
      }
      if (this.matchesBinding(data, "tui.select.up", ["\x1b[A", "k"])) {
        if (this.dialogScrollOffset > 0) {
          this.dialogScrollOffset--;
          this.invalidate();
        }
        return;
      }
      if (this.matchesBinding(data, "tui.select.down", ["\x1b[B", "j"])) {
        this.dialogScrollOffset++;
        this.invalidate();
        return;
      }
      return;
    }

    // 4. Active Text Input Editing Mode
    if (this.activeInput && this.inputMode !== "none") {
      this.activeInput.handleInput(data);
      this.invalidate();
      return;
    }

    // 5. Preview Focus Mode Navigation
    if (this.previewFocusMode) {
      if (data === "p" || data === "P" || this.matchesBinding(data, "tui.select.cancel", ["\x1b"])) {
        this.previewFocusMode = false;
        this.invalidate();
        return;
      }

      if (this.matchesBinding(data, "tui.select.up", ["\x1b[A", "k"])) {
        if (this.bodyScrollOffset === 0) {
          this.previewFocusMode = false;
          this.focusedItemChanged = true;
        } else {
          this.bodyScrollOffset = Math.max(0, this.bodyScrollOffset - 1);
        }
        this.invalidate();
        return;
      }

      if (this.matchesBinding(data, "tui.select.down", ["\x1b[B", "j"])) {
        this.bodyScrollOffset += 1;
        this.invalidate();
        return;
      }

      if (this.matchesBinding(data, "tui.select.pageUp", ["\x1b[5~"])) {
        this.bodyScrollOffset = Math.max(0, this.bodyScrollOffset - Math.max(1, this.lastMaxBodyHeight - 1));
        this.invalidate();
        return;
      }

      if (this.matchesBinding(data, "tui.select.pageDown", ["\x1b[6~"])) {
        this.bodyScrollOffset += Math.max(1, this.lastMaxBodyHeight - 1);
        this.invalidate();
        return;
      }

      if (data === "\t" || data === "\x1b[C" || data === "l") {
        this.previewFocusMode = false;
        this.state.next();
        this.focusedItemIndex = 0;
        this.focusedItemChanged = true;
        this.bodyScrollOffset = 0;
        this.alertMessage = undefined;
        this.invalidate();
        return;
      }

      if (data === "\x1b[Z" || data === "\x1b[D" || data === "h") {
        this.previewFocusMode = false;
        this.state.prev();
        this.focusedItemIndex = 0;
        this.focusedItemChanged = true;
        this.bodyScrollOffset = 0;
        this.alertMessage = undefined;
        this.invalidate();
        return;
      }

      return;
    }

    // 6. Main Navigation Hotkeys
    if (this.matchesBinding(data, "tui.select.cancel", ["\x1b"])) {
      this.dialogScrollOffset = 0;
      this.inputMode = "confirm_cancel";
      this.invalidate();
      return;
    }

    if (data === "\t" || data === "\x1b[C" || data === "l") {
      this.state.next();
      this.focusedItemIndex = 0;
      this.focusedItemChanged = true;
      this.bodyScrollOffset = 0;
      this.previewFocusMode = false;
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    if (data === "\x1b[Z" || data === "\x1b[D" || data === "h") {
      this.state.prev();
      this.focusedItemIndex = 0;
      this.focusedItemChanged = true;
      this.bodyScrollOffset = 0;
      this.previewFocusMode = false;
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    if (data === "p" || data === "P") {
      if (!this.state.isReviewTab && this.hasPreviewContent()) {
        this.previewFocusMode = !this.previewFocusMode;
        this.previewExpanded = this.previewFocusMode;
      } else {
        this.previewExpanded = !this.previewExpanded;
      }
      this.invalidate();
      return;
    }

    if (this.state.isReviewTab) {
      this.handleReviewInput(data);
    } else {
      this.handleQuestionInput(data);
    }
  }

  private handleQuestionInput(data: string): void {
    const q = this.display.questions[this.state.currentQuestionIndex]!;
    const rows = this.getQuestionRows(q);
    const maxItems = rows.length;

    if (this.matchesBinding(data, "tui.select.up", ["\x1b[A", "k"])) {
      this.focusedItemIndex = (this.focusedItemIndex - 1 + maxItems) % maxItems;
      this.focusedItemChanged = true;
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    if (this.matchesBinding(data, "tui.select.down", ["\x1b[B", "j"])) {
      if (this.focusedItemIndex === maxItems - 1 && this.hasPreviewContent()) {
        this.previewFocusMode = true;
        this.previewExpanded = true;
        this.bodyScrollOffset += 1;
        this.alertMessage = undefined;
        this.invalidate();
        return;
      }
      this.focusedItemIndex = (this.focusedItemIndex + 1) % maxItems;
      this.focusedItemChanged = true;
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    if (this.matchesBinding(data, "tui.select.pageUp", ["\x1b[5~"])) {
      if (this.focusedItemIndex > 0) {
        this.focusedItemIndex = Math.max(0, this.focusedItemIndex - 5);
        this.focusedItemChanged = true;
      } else {
        this.bodyScrollOffset = Math.max(0, this.bodyScrollOffset - Math.max(1, this.lastMaxBodyHeight - 1));
      }
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    if (this.matchesBinding(data, "tui.select.pageDown", ["\x1b[6~"])) {
      if (this.focusedItemIndex < maxItems - 1) {
        this.focusedItemIndex = Math.min(maxItems - 1, this.focusedItemIndex + 5);
        this.focusedItemChanged = true;
      } else {
        if (this.hasPreviewContent() && !this.previewFocusMode) {
          this.previewFocusMode = true;
          this.previewExpanded = true;
        }
        this.bodyScrollOffset += Math.max(1, this.lastMaxBodyHeight - 1);
      }
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    const row = rows[this.focusedItemIndex];
    if (!row) return;

    if (data === " ") {
      if (row.kind === "option") {
        this.state.selectOption(q.id, row.option.id);
        this.invalidate();
        return;
      }
      if (row.kind === "empty") {
        this.state.confirmEmptySelection(q.id);
        this.invalidate();
        return;
      }
    }

    if (this.matchesBinding(data, "tui.select.confirm", ["\r", "\n"])) {
      if (row.kind === "option") {
        this.state.selectOption(q.id, row.option.id);
        if ((q.type ?? "single") === "single") {
          this.state.next();
          this.focusedItemIndex = 0;
          this.focusedItemChanged = true;
          this.bodyScrollOffset = 0;
        }
        this.invalidate();
        return;
      }
      if (row.kind === "custom") {
        this.startCustomInput(q);
        return;
      }
      if (row.kind === "empty") {
        this.state.confirmEmptySelection(q.id);
        this.invalidate();
        return;
      }
      if (row.kind === "note") {
        this.startNoteInput(q);
        return;
      }
    }

    if (data === "c" || data === "C") {
      const cIdx = rows.findIndex((r) => r.kind === "custom");
      if (cIdx !== -1) {
        this.focusedItemIndex = cIdx;
        this.focusedItemChanged = true;
        this.startCustomInput(q);
      }
      return;
    }

    if (data === "n" || data === "N") {
      const nIdx = rows.findIndex((r) => r.kind === "note");
      if (nIdx !== -1) {
        this.focusedItemIndex = nIdx;
        this.focusedItemChanged = true;
        this.startNoteInput(q);
      }
      return;
    }

    if (data === "e" || data === "E" || data === "x" || data === "X") {
      const eIdx = rows.findIndex((r) => r.kind === "empty");
      if (eIdx !== -1) {
        this.focusedItemIndex = eIdx;
        this.focusedItemChanged = true;
        this.state.confirmEmptySelection(q.id);
        this.invalidate();
      }
      return;
    }

    if (data === "d" || data === "D" || data === "\x1b[3~") {
      if (row.kind === "note") {
        this.state.setQuestionNotes(q.id, undefined);
        this.invalidate();
        return;
      }
      if (row.kind === "custom") {
        this.state.setCustomText(q.id, undefined);
        this.invalidate();
        return;
      }
    }
  }

  private handleReviewInput(data: string): void {
    const rows = this.getReviewRows();
    const maxItems = rows.length;

    if (this.matchesBinding(data, "tui.select.up", ["\x1b[A", "k"])) {
      this.focusedItemIndex = (this.focusedItemIndex - 1 + maxItems) % maxItems;
      this.focusedItemChanged = true;
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    if (this.matchesBinding(data, "tui.select.down", ["\x1b[B", "j"])) {
      this.focusedItemIndex = (this.focusedItemIndex + 1) % maxItems;
      this.focusedItemChanged = true;
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    if (this.matchesBinding(data, "tui.select.pageUp", ["\x1b[5~"])) {
      this.focusedItemIndex = Math.max(0, this.focusedItemIndex - 5);
      this.focusedItemChanged = true;
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    if (this.matchesBinding(data, "tui.select.pageDown", ["\x1b[6~"])) {
      this.focusedItemIndex = Math.min(maxItems - 1, this.focusedItemIndex + 5);
      this.focusedItemChanged = true;
      this.alertMessage = undefined;
      this.invalidate();
      return;
    }

    const row = rows[this.focusedItemIndex];
    if (!row) return;

    if (this.matchesBinding(data, "tui.select.confirm", ["\r", "\n"])) {
      if (row.kind === "question") {
        this.state.goToQuestion(row.questionIndex);
        this.focusedItemIndex = 0;
        this.focusedItemChanged = true;
        this.previewFocusMode = false;
        this.bodyScrollOffset = 0;
        this.alertMessage = undefined;
        this.invalidate();
        return;
      }
      if (row.kind === "global_note") {
        this.startGlobalNoteInput();
        return;
      }
      if (row.kind === "submit") {
        this.triggerSubmit();
        return;
      }
    }

    if (data === "s" || data === "S") {
      this.triggerSubmit();
      return;
    }

    if (data === "n" || data === "N") {
      const gIdx = rows.findIndex((r) => r.kind === "global_note");
      if (gIdx !== -1) {
        this.focusedItemIndex = gIdx;
        this.focusedItemChanged = true;
        this.startGlobalNoteInput();
      }
      return;
    }

    if (data === "d" || data === "D" || data === "\x1b[3~") {
      if (row.kind === "global_note") {
        this.state.setGlobalUserNotes(undefined);
        this.invalidate();
        return;
      }
    }
  }

  private triggerSubmit(): void {
    const invalidErrors = this.state.getInvalidAnswerErrors();
    if (invalidErrors.length > 0) {
      const firstErr = invalidErrors[0]!;
      this.alertMessage = `${this.chrome.validationFailed}: ${firstErr.message}`;
      const targetIdx = this.display.questions.findIndex((q) => q.id === firstErr.questionId);
      if (targetIdx !== -1) {
        this.focusedItemIndex = targetIdx;
        this.focusedItemChanged = true;
      }
      this.invalidate();
      return;
    }

    const unansweredIds = this.state.getUnansweredQuestionIds();
    const requiredMissing = unansweredIds.filter((id) => {
      const q = this.state.questions.find((item) => item.id === id);
      return q?.required ?? true;
    });

    if (requiredMissing.length > 0) {
      const firstMissing = requiredMissing[0]!;
      const qFound = this.display.questions.find((q) => q.id === firstMissing);
      const header = qFound ? qFound.header : firstMissing;
      this.alertMessage = `${this.chrome.missingRequiredBadge}: ${header}`;
      const targetIdx = this.display.questions.findIndex((q) => q.id === firstMissing);
      if (targetIdx !== -1) {
        this.focusedItemIndex = targetIdx;
        this.focusedItemChanged = true;
      }
      this.invalidate();
      return;
    }

    this.dialogScrollOffset = 0;
    if (unansweredIds.length > 0) {
      this.inputMode = "confirm_submit_partial";
    } else {
      this.inputMode = "confirm_submit_full";
    }
    this.invalidate();
  }

  private startCustomInput(q: DisplayQuestion): void {
    const current = this.state.getAnswer(q.id).customText ?? "";
    this.activeInput = new Input({
      placeholder: q.textPlaceholder ?? this.chrome.typeCustomPlaceholder,
    });
    this.activeInput.focused = true;
    this.activeInput.setValue(current);
    this.activeInput.onSubmit = (val) => {
      this.state.setCustomText(q.id, val.trim() ? val.trim() : undefined);
      this.inputMode = "none";
      this.activeInput = undefined;
      this.invalidate();
    };
    this.activeInput.onEscape = () => {
      this.inputMode = "none";
      this.activeInput = undefined;
      this.invalidate();
    };
    this.inputMode = "custom_text";
    this.invalidate();
  }

  private startNoteInput(q: DisplayQuestion): void {
    const current = this.state.getAnswer(q.id).notes ?? "";
    this.activeInput = new Input({
      placeholder: this.chrome.addQuestionNotesPrompt,
    });
    this.activeInput.focused = true;
    this.activeInput.setValue(current);
    this.activeInput.onSubmit = (val) => {
      this.state.setQuestionNotes(q.id, val.trim() ? val.trim() : undefined);
      this.inputMode = "none";
      this.activeInput = undefined;
      this.invalidate();
    };
    this.activeInput.onEscape = () => {
      this.inputMode = "none";
      this.activeInput = undefined;
      this.invalidate();
    };
    this.inputMode = "question_note";
    this.invalidate();
  }

  private startGlobalNoteInput(): void {
    const current = this.state.globalUserNotes ?? "";
    this.activeInput = new Input({
      placeholder: this.chrome.addGlobalNotesPrompt,
    });
    this.activeInput.focused = true;
    this.activeInput.setValue(current);
    this.activeInput.onSubmit = (val) => {
      this.state.setGlobalUserNotes(val.trim() ? val.trim() : undefined);
      this.inputMode = "none";
      this.activeInput = undefined;
      this.invalidate();
    };
    this.activeInput.onEscape = () => {
      this.inputMode = "none";
      this.activeInput = undefined;
      this.invalidate();
    };
    this.inputMode = "global_note";
    this.invalidate();
  }

  private matchesBinding(data: string, binding: string, fallbacks: string[]): boolean {
    if (this.keybindings && (this.keybindings as any).matches?.(data, binding)) {
      return true;
    }
    return fallbacks.includes(data);
  }
}
