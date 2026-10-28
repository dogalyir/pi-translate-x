import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireStateMachine } from "../src/domain/state.js";
import {
  buildDisplayQuestionnaire,
  type DisplayQuestionnaire,
} from "../src/domain/projection.js";
import { QuestionnaireTUIComponent } from "../src/ui/questionnaire-tui.js";
import type { BilingualQuestionnaireParams } from "../src/tool/schema.js";

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  style: (text: string, _opts: any) => text,
} as any;

const sampleParams: BilingualQuestionnaireParams = {
  title: "Architecture Decisions",
  questions: [
    {
      id: "db",
      header: "Database",
      prompt: "Which database should we use?",
      description: "Consider relational vs document requirements.",
      type: "single",
      required: true,
      options: [
        { id: "pg", label: "PostgreSQL", description: "Relational database", preview: "```sql\nSELECT 1;\n```" },
        { id: "mongo", label: "MongoDB", description: "Document store" },
      ],
      allowCustom: true,
    },
    {
      id: "cache",
      header: "Cache",
      prompt: "Select caching layers",
      type: "multi",
      required: false,
      minSelections: 1,
      maxSelections: 2,
      options: [
        { id: "redis", label: "Redis" },
        { id: "memcached", label: "Memcached" },
      ],
      allowCustom: true,
    },
  ],
};

function setupTUI(width = 100, translations?: Map<string, string>, targetLang = "English") {
  const sm = new QuestionnaireStateMachine(sampleParams);
  const display: DisplayQuestionnaire = buildDisplayQuestionnaire(sampleParams, translations, targetLang);
  const doneFn = vi.fn();
  const requestRenderFn = vi.fn();
  const tui = { requestRender: requestRenderFn } as any;

  const comp = new QuestionnaireTUIComponent({
    state: sm,
    display,
    tui,
    theme: mockTheme,
    onDone: doneFn,
  });

  return { sm, display, comp, doneFn, requestRenderFn, width };
}

describe("Questionnaire TUI Component Layout & Keybindings", () => {
  it("renders responsive layout: side-by-side on wide screens (>= 80)", () => {
    const { comp } = setupTUI(100);
    const lines = comp.render(100);
    expect(lines.length).toBeGreaterThan(5);

    // Look for side-by-side divider
    const hasDivider = lines.some((l) => l.includes("│"));
    expect(hasDivider).toBe(true);

    // Header bar & tab bar
    expect(lines[0]).toContain("Architecture Decisions");
    expect(lines[2]).toContain("1. Database");
    expect(lines[2]).toContain("2. Cache");
    expect(lines[2]).toContain("Review & Submit");
  });

  it("renders stacked preview on medium screens (60 <= width < 80)", () => {
    const { comp } = setupTUI(70);
    const lines = comp.render(70);
    expect(lines.some((l) => l.includes("─ Preview ─"))).toBe(true);
    // On stacked, divider │ is not used
    expect(lines.some((l) => l.includes("│"))).toBe(false);
  });

  it("renders compact mode on narrow screens (< 60)", () => {
    const { comp } = setupTUI(50);
    const lines = comp.render(50);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.some((l) => l.includes("Database"))).toBe(true);
  });

  it("navigates tabs with Tab and Shift-Tab", () => {
    const { comp, sm } = setupTUI(100);
    expect(sm.currentQuestionIndex).toBe(0);
    expect(sm.isReviewTab).toBe(false);

    // Press Tab
    comp.handleInput("\t");
    expect(sm.currentQuestionIndex).toBe(1);

    // Press Tab again -> Review tab
    comp.handleInput("\t");
    expect(sm.isReviewTab).toBe(true);

    // Press Shift-Tab
    comp.handleInput("\x1b[Z");
    expect(sm.isReviewTab).toBe(false);
    expect(sm.currentQuestionIndex).toBe(1);
  });

  it("toggles single-select option on Enter and advances", () => {
    const { comp, sm } = setupTUI(100);
    // On question 0 (db), cursor is at option 0 (pg)
    comp.handleInput("\r");
    expect(sm.getAnswer("db").selectedOptionIds).toEqual(["pg"]);
    // Automatically advances to question 1 for single-select
    expect(sm.currentQuestionIndex).toBe(1);
  });

  it("toggles multi-select options on Space without advancing", () => {
    const { comp, sm } = setupTUI(100);
    sm.goToQuestion(1); // cache question
    comp.handleInput(" "); // toggle redis
    expect(sm.getAnswer("cache").selectedOptionIds).toEqual(["redis"]);
    expect(sm.currentQuestionIndex).toBe(1); // stays on question 1

    comp.handleInput("\x1b[B"); // Down to memcached
    comp.handleInput(" "); // toggle memcached
    expect(sm.getAnswer("cache").selectedOptionIds).toEqual(["redis", "memcached"]);
  });

  it("allows custom text input with Focusable and fake cursor markers", () => {
    const { comp, sm } = setupTUI(100);
    expect(comp.focused).toBe(true);

    // Press 'c' to enter custom text mode for db
    comp.handleInput("c");
    // Type "SQLite"
    for (const char of "SQLite") {
      comp.handleInput(char);
    }
    // Render while typing should contain CURSOR_MARKER
    const typingLines = comp.render(100);
    expect(typingLines.some((l) => l.includes("SQLite"))).toBe(true);

    // Press Enter to confirm custom text
    comp.handleInput("\r");
    expect(sm.getAnswer("db").customText).toBe("SQLite");
    expect(sm.getAnswer("db").isAnswered).toBe(true);
  });

  it("allows per-question note input", () => {
    const { comp, sm } = setupTUI(100);
    comp.handleInput("n"); // enter note editing
    for (const char of "Self-hosted only") {
      comp.handleInput(char);
    }
    comp.handleInput("\r"); // commit
    expect(sm.getAnswer("db").notes).toBe("Self-hosted only");
  });

  it("allows global user notes on Review tab", () => {
    const { comp, sm } = setupTUI(100);
    sm.goToReview();
    comp.handleInput("n"); // global notes hotkey
    for (const char of "Ship to production by Friday") {
      comp.handleInput(char);
    }
    comp.handleInput("\r"); // commit
    expect(sm.globalUserNotes).toBe("Ship to production by Friday");
  });

  it("jumps to edit question when pressing Enter on question row in Review tab", () => {
    const { comp, sm } = setupTUI(100);
    sm.goToReview();
    // Focused on row 0 (db)
    comp.handleInput("\r");
    expect(sm.isReviewTab).toBe(false);
    expect(sm.currentQuestionIndex).toBe(0);
  });

  it("handles submit in Review tab when valid", () => {
    const { comp, sm, doneFn } = setupTUI(100);
    sm.selectOption("db", "pg"); // answered required question
    sm.goToReview();

    // Move to submit button and press 's', then confirm with 'y'
    comp.handleInput("s");
    comp.handleInput("y");
    expect(doneFn).toHaveBeenCalledWith({ action: "submit" });
  });

  it("handles cancellation confirmation flow", () => {
    const { comp, doneFn } = setupTUI(100);
    // Press Esc to open confirm cancel
    comp.handleInput("\x1b");
    const confirmLines = comp.render(100);
    expect(confirmLines.some((l) => l.includes("Are you sure you want to cancel"))).toBe(true);

    // Press 'n' to decline
    comp.handleInput("n");
    expect(doneFn).not.toHaveBeenCalled();

    // Press Esc again, then 'y' to confirm
    comp.handleInput("\x1b");
    comp.handleInput("y");
    expect(doneFn).toHaveBeenCalledWith({ action: "cancel" });
  });

  it("handles display error recovery actions: retry, continue English, cancel", () => {
    const { comp, doneFn } = setupTUI(100);
    comp.setDisplayError("Provider timeout");
    const errLines = comp.render(100);
    expect(errLines.some((l) => l.includes("Display translation failed"))).toBe(true);

    // Press 'r' for retry
    comp.handleInput("r");
    expect(doneFn).toHaveBeenCalledWith({ action: "retry_display" });

    // Press 'e' for English
    comp.setDisplayError("Provider timeout");
    comp.handleInput("e");
    expect(doneFn).toHaveBeenCalledWith({ action: "continue_english" });
  });

  it("handles answer translation error recovery: retry, cancel, edit", () => {
    const { comp, doneFn } = setupTUI(100);
    comp.setAnswerError("Reverse translation failed");
    const errLines = comp.render(100);
    expect(errLines.some((l) => l.includes("Answer translation failed"))).toBe(true);

    comp.handleInput("r");
    expect(doneFn).toHaveBeenCalledWith({ action: "retry_answer" });
  });

  it("handles long CJK, emojis, combining characters, and bracketed paste with grapheme cluster preservation", () => {
    const { comp, sm } = setupTUI(80);
    comp.handleInput("c"); // enter custom text mode

    // Bracketed paste sequence with emoji, CJK, and combining marks
    const pasteContent = "🚀 数据库 👨‍👩‍👧‍👦 e\u0301";
    comp.handleInput(`\x1b[200~${pasteContent}\x1b[201~`);

    // Render should show the text and include CURSOR_MARKER
    const rendered = comp.render(80);
    expect(rendered.some((l) => l.includes("数据库"))).toBe(true);

    // Press backspace (\x7f): should delete the combining character cluster "e\u0301" cleanly
    comp.handleInput("\x7f");

    // Commit input
    comp.handleInput("\r");
    const val = sm.getAnswer("db").customText;
    expect(val).toBe("🚀 数据库 👨‍👩‍👧‍👦");
  });

  it("strictly enforces custom-disabled: no ghost row and shortcut 'c' cannot enter hidden custom", () => {
    const paramsNoCustom: BilingualQuestionnaireParams = {
      title: "Strict Selection",
      questions: [
        {
          id: "lang",
          header: "Language",
          prompt: "Pick one language",
          type: "single",
          options: [
            { id: "ts", label: "TypeScript" },
            { id: "rust", label: "Rust" },
          ],
          allowCustom: false,
        },
      ],
    };
    const sm = new QuestionnaireStateMachine(paramsNoCustom);
    const display = buildDisplayQuestionnaire(paramsNoCustom, undefined, "English");
    const doneFn = vi.fn();
    const tui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as any;
    const comp = new QuestionnaireTUIComponent({
      state: sm,
      display,
      tui,
      theme: mockTheme,
      onDone: doneFn,
    });

    const rows = comp.getQuestionRows(display.questions[0]!);
    // Rows should only be: ts, rust, empty (if optional) / note
    expect(rows.some((r) => r.kind === "custom")).toBe(false);

    // Press 'c' -> should NOT enter custom mode
    comp.handleInput("c");
    comp.handleInput("X");
    comp.handleInput("\r");

    expect(sm.getAnswer("lang").customText).toBeUndefined();

    // Down navigation should cycle between visible rows without phantom row
    expect(rows.length).toBe(3); // ts (0), rust (1), note (2)
    comp.handleInput("\x1b[B"); // down to rust
    comp.handleInput("\x1b[B"); // down to note
    comp.handleInput("\x1b[B"); // wrap to ts
  });

  it("handles height-bounded terminal viewport and ensures footer and active editor are never offscreen", () => {
    // Simulate constrained 12-row terminal
    const { comp } = setupTUI(60);
    (comp as any).tui = { requestRender: vi.fn(), terminal: { rows: 12, columns: 60 } };

    const lines = comp.render(60);
    expect(lines.length).toBeLessThanOrEqual(12);

    // Verify footer shortcuts are present on the last line
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toContain("Navigate");

    // Enter note editing on narrow terminal
    comp.handleInput("n");
    const editLines = comp.render(60);
    expect(editLines.length).toBeLessThanOrEqual(12);
    expect(editLines[editLines.length - 1]!).toContain("Confirm input");
  });

  it("announces validation failures and focuses first invalid field on submit attempt", () => {
    const { comp, sm } = setupTUI(100);
    // Question 1 (cache) has minSelections: 1, maxSelections: 2.
    // Question 0 (db) is required but unanswered.
    sm.goToReview();

    // Attempt submit while invalid
    comp.handleInput("s");

    // Renders warning alert
    const lines = comp.render(100);
    expect(lines.some((l) => l.includes("⚠"))).toBe(true);

    // Answer required question db
    sm.selectOption("db", "pg");

    // Now question 1 (cache) is optional, so submit should open confirmation
    comp.handleInput("s");
    const confirmLines = comp.render(100);
    expect(confirmLines.some((l) => l.includes("Confirm partial submission"))).toBe(true);
  });

  it("supports explicit mark-empty confirmation and note clearing with 'd' shortcut", () => {
    const { comp, sm } = setupTUI(100);
    sm.goToQuestion(1); // cache question (optional)

    // Press 'e' to confirm explicit empty selection
    comp.handleInput("e");
    expect(sm.getAnswer("cache").emptySelectionConfirmed).toBe(true);
    expect(sm.getAnswer("cache").isAnswered).toBe(true);

    // Add note, then clear with 'd'
    comp.handleInput("n");
    for (const ch of "Draft note") comp.handleInput(ch);
    comp.handleInput("\r");
    expect(sm.getAnswer("cache").notes).toBe("Draft note");

    // Down to note row and press 'd'
    comp.handleInput("d");
    expect(sm.getAnswer("cache").notes).toBeUndefined();
  });

  it("closes cleanly on AbortSignal and cleans up listeners", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");
    const doneFn = vi.fn();
    const abortCtrl = new AbortController();

    const comp = new QuestionnaireTUIComponent({
      state: sm,
      display,
      tui: { requestRender: vi.fn() } as any,
      theme: mockTheme,
      onDone: doneFn,
      signal: abortCtrl.signal,
    });

    // Fire abort
    abortCtrl.abort();
    expect(doneFn).toHaveBeenCalledWith({ action: "cancel" });

    // Explicit dispose does not throw
    expect(() => comp.dispose()).not.toThrow();
  });

  describe("Regression: REAL ANSI Theme, CJK, Small Viewports & Preview Reachability", () => {
    const realAnsiTheme = {
      fg: (color: string, text: string) => {
        const codes: Record<string, string> = {
          accent: "\x1b[36m",
          dim: "\x1b[2m",
          error: "\x1b[31m",
          warning: "\x1b[33m",
          success: "\x1b[32m",
        };
        const c = codes[color] ?? "\x1b[37m";
        return `${c}${text}\x1b[39m`;
      },
      bg: (_color: string, text: string) => `\x1b[40m${text}\x1b[49m`,
      style: (text: string, opts?: any) => {
        let res = text;
        if (opts?.fg) res = realAnsiTheme.fg(opts.fg, res);
        if (opts?.bold) res = `\x1b[1m${res}\x1b[22m`;
        return res;
      },
    } as any;

    const longPreviewLines = Array.from({ length: 30 }, (_, i) => `Preview line ${i + 1} with CJK: 数据库 / 日本語 / 🚀`);
    longPreviewLines.push("BOTTOM_PREVIEW_REACHABLE_MARKER");

    const longPreviewParams: BilingualQuestionnaireParams = {
      title: "Real ANSI Long Preview",
      questions: [
        {
          id: "q1",
          header: "Architecture",
          prompt: "Select architecture design for multi-region deployment with high availability and fault tolerance.",
          description: "Long description wrapping test with Japanese 日本語 and Chinese 数据库 details.",
          type: "single",
          required: true,
          options: [
            {
              id: "opt1",
              label: "Microservices",
              description: "Distributed services with event streaming and partitioned caching layers.",
              preview: longPreviewLines.join("\n"),
            },
            {
              id: "opt2",
              label: "Monolith",
              description: "Unified codebase",
            },
          ],
          allowCustom: true,
        },
      ],
    };

    function setupRealAnsiTUI(width: number, rows = 24, keybindings?: any) {
      const sm = new QuestionnaireStateMachine(longPreviewParams);
      const display = buildDisplayQuestionnaire(longPreviewParams, undefined, "English");
      const doneFn = vi.fn();
      const tui = {
        requestRender: vi.fn(),
        terminal: { rows, columns: width },
      } as any;

      const comp = new QuestionnaireTUIComponent({
        state: sm,
        display,
        tui,
        theme: realAnsiTheme,
        keybindings,
        onDone: doneFn,
      });

      return { sm, display, comp, doneFn, tui };
    }

    it("makes bottom of long preview reachable across widths 100, 70, 40 without snapping back on next render", () => {
      // 1. Width 100 (Side-by-side)
      {
        const { comp } = setupRealAnsiTUI(100, 20);
        // Press 'p' to focus preview
        comp.handleInput("p");
        // PageDown multiple times to scroll to bottom
        for (let i = 0; i < 10; i++) comp.handleInput("\x1b[6~");
        const rendered100 = comp.render(100);
        const hasMarker100 = rendered100.some((l) => l.includes("BOTTOM_PREVIEW_REACHABLE_MARKER"));
        expect(hasMarker100).toBe(true);

        // Subsequent render MUST NOT snap back to top row
        const nextRendered100 = comp.render(100);
        expect(nextRendered100.some((l) => l.includes("BOTTOM_PREVIEW_REACHABLE_MARKER"))).toBe(true);

        // Escape returns focus to controls
        comp.handleInput("\x1b");
        const afterEscLines = comp.render(100);
        expect(afterEscLines.some((l) => l.includes("Are you sure you want to cancel"))).toBe(false);
      }

      // 2. Width 70 (Stacked)
      {
        const { comp } = setupRealAnsiTUI(70, 20);
        comp.handleInput("p");
        for (let i = 0; i < 10; i++) comp.handleInput("\x1b[6~");
        const rendered70 = comp.render(70);
        expect(rendered70.some((l) => l.includes("BOTTOM_PREVIEW_REACHABLE_MARKER"))).toBe(true);

        // Next render does not snap back
        const nextRendered70 = comp.render(70);
        expect(nextRendered70.some((l) => l.includes("BOTTOM_PREVIEW_REACHABLE_MARKER"))).toBe(true);

        comp.handleInput("\x1b");
        const afterEsc70 = comp.render(70);
        expect(afterEsc70.some((l) => l.includes("Are you sure you want to cancel"))).toBe(false);
      }

      // 3. Width 40 (Compact)
      {
        const { comp } = setupRealAnsiTUI(40, 20);
        comp.handleInput("p");
        for (let i = 0; i < 15; i++) comp.handleInput("\x1b[6~");
        const rendered40 = comp.render(40);
        expect(rendered40.some((l) => l.includes("BOTTOM_PREVIEW_REACHABLE_MARKER"))).toBe(true);

        // Next render does not snap back
        const nextRendered40 = comp.render(40);
        expect(nextRendered40.some((l) => l.includes("BOTTOM_PREVIEW_REACHABLE_MARKER"))).toBe(true);

        comp.handleInput("\x1b");
        const afterEsc40 = comp.render(40);
        expect(afterEsc40.some((l) => l.includes("Are you sure you want to cancel"))).toBe(false);
      }
    });

    it("strictly bounds TOTAL rendered lines <= terminal rows at height 12 and 8 without broken ANSI fragments", () => {
      for (const termRows of [12, 8]) {
        const { comp } = setupRealAnsiTUI(80, termRows);
        const lines = comp.render(80);
        expect(lines.length).toBeLessThanOrEqual(termRows);

        // Check for broken ANSI fragments
        for (const line of lines) {
          const stripped = stripTerminalSequences(line);
          // Stripped text should have no raw ANSI escape remnants
          expect(stripped).not.toMatch(/\x1b/);
          expect(stripped).not.toMatch(/\[[0-9;]+m/);
        }

        // Active editor input mode should keep editor visible and bounded
        comp.handleInput("c");
        const editLines = comp.render(80);
        expect(editLines.length).toBeLessThanOrEqual(termRows);
        expect(editLines.some((l) => l.includes("Custom"))).toBe(true);
        comp.handleInput("\x1b"); // cancel custom
      }
    });

    it("windows tab bar onto strictly 1 line with active tab visible across 8 questions", () => {
      const eightQuestionsParams: BilingualQuestionnaireParams = {
        title: "Full 8 Questions",
        questions: Array.from({ length: 8 }, (_, i) => ({
          id: `q${i + 1}`,
          header: `LongQuestionHeader${i + 1}`,
          prompt: `Prompt for question ${i + 1}`,
          options: [{ id: "opt", label: "Option" }],
        })),
      };
      const sm = new QuestionnaireStateMachine(eightQuestionsParams);
      const display = buildDisplayQuestionnaire(eightQuestionsParams, undefined, "English");
      const comp = new QuestionnaireTUIComponent({
        state: sm,
        display,
        tui: { requestRender: vi.fn(), terminal: { rows: 24, columns: 60 } } as any,
        theme: realAnsiTheme,
        onDone: vi.fn(),
      });

      // At start (Question 1)
      const linesQ1 = comp.render(60);
      expect(linesQ1.some((l) => l.includes("1. LongQuestionHeader1"))).toBe(true);

      // Jump to Question 7
      sm.goToQuestion(6);
      comp.invalidate();
      const linesQ7 = comp.render(60);
      expect(linesQ7.some((l) => l.includes("7. LongQuestionHeader7"))).toBe(true);

      // Jump to Review tab
      sm.goToReview();
      comp.invalidate();
      const linesReview = comp.render(60);
      expect(linesReview.some((l) => l.includes("Review & Submit"))).toBe(true);
    });

    it("respects public injected keybindings for pageUp and pageDown", () => {
      const customKeybindings = {
        matches: (data: string, binding: string) => {
          if (binding === "tui.select.pageDown" && data === "\x06") return true; // Ctrl+F
          if (binding === "tui.select.pageUp" && data === "\x02") return true; // Ctrl+B
          return false;
        },
      };

      const { comp } = setupRealAnsiTUI(100, 20, customKeybindings);
      comp.handleInput("p"); // enter preview
      // Send Ctrl+F (pageDown)
      comp.handleInput("\x06");
      comp.handleInput("\x06");
      const lines = comp.render(100);
      // Scrolled down
      expect(lines.some((l) => l.includes("Preview line"))).toBe(true);
    });

    it("persists question-local validation feedback when editing from review tab", () => {
      const { comp, sm } = setupRealAnsiTUI(80, 24);
      // Question 1 has textMinLength
      (sm.questions[0] as any).textMinLength = 10;
      sm.goToReview();

      // Submit invalid
      comp.handleInput("s");

      // Review shows alert, pressing Enter jumps to question 1
      comp.handleInput("\r");
      expect(sm.currentQuestionIndex).toBe(0);

      // Question screen should display question-local validation feedback directly
      const qLines = comp.render(80);
      expect(qLines.some((l) => l.includes("⚠ Validation failed"))).toBe(true);
    });

    it("supports answer translation recovery screen with Enter defaulting to returnToEdit and Esc cancelling", () => {
      const { comp, doneFn } = setupRealAnsiTUI(80, 24);
      comp.setAnswerError("Network disconnected");
      const errLines = comp.render(80);
      expect(errLines.some((l) => l.includes("Answer translation failed"))).toBe(true);

      // Enter key (\r) should default to returnToEdit (dismisses error without cancel)
      comp.handleInput("\r");
      const draftLines = comp.render(80);
      expect(draftLines.some((l) => l.includes("Architecture"))).toBe(true);
      expect(doneFn).not.toHaveBeenCalled();

      // Set answer error again, then Esc cancels
      comp.setAnswerError("Network disconnected");
      comp.handleInput("\x1b");
      expect(doneFn).toHaveBeenCalledWith({ action: "cancel" });
    });

    it("preserves single selected option + supplemental custom text together", () => {
      const { comp, sm } = setupRealAnsiTUI(100, 24);
      // Select option 'opt1' with Space (does not advance to review)
      comp.handleInput(" ");
      // Add custom supplemental text
      comp.handleInput("c");
      for (const ch of "Supplemental custom text") comp.handleInput(ch);
      comp.handleInput("\r");

      const ans = sm.getAnswer("q1");
      expect(ans.selectedOptionIds).toEqual(["opt1"]);
      expect(ans.customText).toBe("Supplemental custom text");

      // Render question body shows both
      sm.goToQuestion(0);
      const qLines = comp.render(100);
      expect(qLines.some((l) => l.includes("Microservices"))).toBe(true);
      expect(qLines.some((l) => l.includes("Supplemental custom text"))).toBe(true);

      // Render review shows both
      sm.goToReview();
      comp.invalidate();
      const revLines = comp.render(100);
      expect(revLines.some((l) => l.includes("Microservices") && l.includes("Supplemental custom text"))).toBe(true);
    });

    it("computes termRows before cached return and reflows SAME-width height 24 -> 8 -> 4 without manual invalidate", () => {
      const { comp, tui } = setupRealAnsiTUI(100, 24);

      // Render at height 24, width 100
      const lines24 = comp.render(100);
      expect(lines24.length).toBeLessThanOrEqual(24);

      // Resize height from 24 to 8 at SAME width (100) without calling comp.invalidate()
      tui.terminal.rows = 8;
      const lines8 = comp.render(100);
      expect(lines8.length).toBeLessThanOrEqual(8);

      // Resize height from 8 to 4 at SAME width (100) without calling comp.invalidate()
      tui.terminal.rows = 4;
      const lines4 = comp.render(100);
      expect(lines4.length).toBeLessThanOrEqual(4);

      // Calling invalidate() explicitly clears cached height/width
      comp.invalidate();
      const linesAfterInvalidate = comp.render(100);
      expect(linesAfterInvalidate.length).toBeLessThanOrEqual(4);
    });

    it("compacts early screens at small heights and narrow widths while preserving all actions and key handling", () => {
      const { comp, tui, doneFn, sm } = setupRealAnsiTUI(100, 24);

      // 1. Display Error Screen
      comp.setDisplayError("Network connection reset by peer");
      for (const h of [24, 12, 8, 6, 4, 3, 2, 1]) {
        for (const w of [100, 60, 12, 6, 4, 3, 1]) {
          tui.terminal.rows = h;
          const lines = comp.render(w);
          expect(lines.length).toBeLessThanOrEqual(Math.max(1, h));
          for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(w);
          }
        }
      }

      // Verify all actions are preserved at height 4
      tui.terminal.rows = 4;
      const errLines4 = comp.render(100);
      expect(errLines4.length).toBeLessThanOrEqual(4);
      expect(errLines4.some((l) => l.includes("[r]") && l.includes("[e/Enter]") && l.includes("[c/Esc]"))).toBe(true);

      // Verify keys work in compact layout
      comp.handleInput("r");
      expect(doneFn).toHaveBeenCalledWith({ action: "retry_display" });

      comp.setDisplayError("Error 2");
      comp.handleInput("e");
      expect(doneFn).toHaveBeenCalledWith({ action: "continue_english" });

      comp.setDisplayError("Error 3");
      comp.handleInput("c");
      expect(doneFn).toHaveBeenCalledWith({ action: "cancel" });

      // 2. Answer Error Screen
      comp.setAnswerError("Reverse translation timed out");
      for (const h of [24, 8, 4, 3, 2, 1]) {
        for (const w of [80, 12, 6, 4, 1]) {
          tui.terminal.rows = h;
          const lines = comp.render(w);
          expect(lines.length).toBeLessThanOrEqual(Math.max(1, h));
          for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(w);
          }
        }
      }

      tui.terminal.rows = 4;
      const ansLines4 = comp.render(100);
      expect(ansLines4.some((l) => l.includes("[r]") && l.includes("[e/Enter]") && l.includes("[c/Esc]"))).toBe(true);

      // Test detail scroll in compact dialog
      tui.terminal.rows = 3;
      comp.setAnswerError("Long detailed answer error message");
      const linesBeforeScroll = comp.render(80);
      expect(linesBeforeScroll.some((l) => l.includes("Long detailed answer error"))).toBe(true);
      comp.handleInput("\x1b[B"); // scroll down
      const linesAfterScroll = comp.render(80);
      expect(linesAfterScroll.length).toBeLessThanOrEqual(3);
      comp.handleInput("\x1b[A"); // scroll up

      // Enter key recovers to edit
      comp.handleInput("\r");
      expect(comp.render(100).some((l) => l.includes("Real ANSI Long Preview"))).toBe(true);

      // 3. Confirm Cancel Screen
      tui.terminal.rows = 4;
      comp.handleInput("\x1b"); // opens confirm_cancel
      for (const h of [8, 4, 3, 2, 1]) {
        for (const w of [80, 12, 6, 1]) {
          tui.terminal.rows = h;
          const lines = comp.render(w);
          expect(lines.length).toBeLessThanOrEqual(Math.max(1, h));
          for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(w);
          }
        }
      }

      tui.terminal.rows = 3;
      const cancelLines3 = comp.render(100);
      expect(cancelLines3.some((l) => l.includes("[y/Enter]") && l.includes("[n/Esc]"))).toBe(true);
      comp.handleInput("n"); // dismisses cancel

      // 4. Confirm Submit Screens
      // Answer required question q1 so submit is permitted
      sm.selectOption("q1", "opt1");
      // Navigate to review and submit
      sm.goToReview();
      comp.invalidate();
      comp.handleInput("s"); // submit -> confirm_submit_full
      for (const h of [6, 4, 3, 2, 1]) {
        for (const w of [80, 12, 6, 1]) {
          tui.terminal.rows = h;
          const lines = comp.render(w);
          expect(lines.length).toBeLessThanOrEqual(Math.max(1, h));
          for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(w);
          }
        }
      }
      tui.terminal.rows = 4;
      const fullLines4 = comp.render(100);
      expect(fullLines4.some((l) => l.includes("[y/Enter]"))).toBe(true);
      expect(fullLines4.some((l) => l.includes("[n/Esc]"))).toBe(true);
      comp.handleInput("y");
      expect(doneFn).toHaveBeenCalledWith({ action: "submit" });
    });
  });
});
