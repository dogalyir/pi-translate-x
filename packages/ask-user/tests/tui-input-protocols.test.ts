import { describe, expect, it, vi } from "vitest";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { QuestionnaireStateMachine } from "../src/domain/state.js";
import { buildDisplayQuestionnaire, extractTranslatableFields } from "../src/domain/projection.js";
import { QuestionnaireTUIComponent } from "../src/ui/questionnaire-tui.js";
import type { BilingualQuestionnaireParams } from "../src/tool/schema.js";

/**
 * Regression tests: keys must be matched protocol-aware, not by raw bytes.
 * Terminals using the kitty keyboard protocol (Ghostty, Kitty, WezTerm, Herdr, ...)
 * or SS3 application-cursor mode encode Esc / Shift+Tab / arrows differently.
 */

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  style: (text: string, _opts: any) => text,
} as any;

const params: BilingualQuestionnaireParams = {
  title: "Protocol Test",
  questions: [
    {
      id: "db",
      header: "Database",
      prompt: "Which database?",
      type: "single",
      required: true,
      options: [
        { id: "pg", label: "PostgreSQL" },
        { id: "mongo", label: "MongoDB" },
      ],
    },
    {
      id: "cache",
      header: "Cache",
      prompt: "Which caches?",
      type: "multi",
      required: false,
      options: [
        { id: "redis", label: "Redis" },
        { id: "memcached", label: "Memcached" },
      ],
    },
  ],
};

function setup(translations?: Map<string, string>, lang = "English") {
  const sm = new QuestionnaireStateMachine(params);
  const display = buildDisplayQuestionnaire(params, translations, lang);
  const doneFn = vi.fn();
  const comp = new QuestionnaireTUIComponent({
    state: sm,
    display,
    tui: { requestRender: vi.fn(), terminal: { rows: 30 } } as any,
    theme: mockTheme,
    onDone: doneFn,
  });
  return { sm, comp, doneFn };
}

const ENCODINGS = {
  escape: { legacy: "\x1b", kitty: "\x1b[27u" },
  shiftTab: { legacy: "\x1b[Z", kitty: "\x1b[9;2u" },
  left: { legacy: "\x1b[D", ss3: "\x1bOD", kitty: "\x1b[1;1D" },
  right: { legacy: "\x1b[C", ss3: "\x1bOC", kitty: "\x1b[1;1C" },
} as const;

describe("protocol-aware keyboard handling", () => {
  it.each(Object.entries(ENCODINGS.shiftTab))("Shift+Tab (%s) goes to the previous question", (_name, seq) => {
    const { comp, sm } = setup();
    comp.handleInput("\t");
    expect(sm.currentQuestionIndex).toBe(1);
    comp.handleInput(seq);
    expect(sm.currentQuestionIndex).toBe(0);
  });

  it.each(Object.entries(ENCODINGS.left))("Left arrow (%s) goes to the previous question", (_name, seq) => {
    const { comp, sm } = setup();
    sm.goToQuestion(1);
    comp.handleInput(seq);
    expect(sm.currentQuestionIndex).toBe(0);
  });

  it.each(Object.entries(ENCODINGS.right))("Right arrow (%s) goes to the next question", (_name, seq) => {
    const { comp, sm } = setup();
    comp.handleInput(seq);
    expect(sm.currentQuestionIndex).toBe(1);
  });

  it.each(Object.entries(ENCODINGS.shiftTab))("Shift+Tab (%s) also leaves preview focus mode", (_name, seq) => {
    const { comp, sm } = setup();
    sm.goToQuestion(1);
    (comp as any).previewFocusMode = true;
    comp.handleInput(seq);
    expect((comp as any).previewFocusMode).toBe(false);
    expect(sm.currentQuestionIndex).toBe(0);
  });

  it.each(Object.entries(ENCODINGS.escape))("Esc (%s) on the submit confirmation returns to editing", (_name, seq) => {
    const { comp, sm, doneFn } = setup();
    comp.handleInput("\r"); // select pg, advance
    comp.handleInput("\t"); // review tab
    expect(sm.isReviewTab).toBe(true);
    comp.handleInput("s");
    expect((comp as any).inputMode).toBe("confirm_submit_partial");

    comp.handleInput(seq);
    expect((comp as any).inputMode).toBe("none");
    expect(doneFn).not.toHaveBeenCalled();
  });

  it.each(Object.entries(ENCODINGS.escape))("Esc (%s) opens and then dismisses the cancel confirmation", (_name, seq) => {
    const { comp, doneFn } = setup();
    comp.handleInput(seq);
    expect((comp as any).inputMode).toBe("confirm_cancel");
    comp.handleInput(seq);
    expect((comp as any).inputMode).toBe("none");
    expect(doneFn).not.toHaveBeenCalled();
  });

  it("kitty-encoded Enter confirms submission", () => {
    const { comp, doneFn } = setup();
    comp.handleInput("\r");
    comp.handleInput("\t");
    comp.handleInput("s");
    comp.handleInput("\x1b[13u");
    expect(doneFn).toHaveBeenCalledWith({ action: "submit" });
  });
});

describe("mouse support", () => {
  const mouse = (type: TuiMouseEvent["type"], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 100,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
  });

  function locate(lines: string[], text: string): { x: number; y: number } {
    const y = lines.findIndex((l) => l.includes(text));
    expect(y).toBeGreaterThanOrEqual(0);
    const line = lines[y]!;
    return { x: visibleWidth(line.slice(0, line.indexOf(text))), y };
  }

  function click(comp: QuestionnaireTUIComponent, x: number, y: number, clickCount = 1) {
    const press = comp.handleMouse(mouse("press", x, y));
    expect(press?.handled).toBe(true);
    return comp.handleMouse(mouse("click", x, y, { clickCount }));
  }

  it("clicking a tab chip switches question, including the review tab", () => {
    const { comp, sm } = setup();
    let pos = locate(comp.render(100), "2. Cache");
    click(comp, pos.x + 1, pos.y);
    expect(sm.currentQuestionIndex).toBe(1);

    pos = locate(comp.render(100), "Review & Submit ]");
    click(comp, pos.x, pos.y);
    expect(sm.isReviewTab).toBe(true);
  });

  it("clicking an option selects it without advancing; double-click on single-choice advances", () => {
    const { comp, sm } = setup();
    let pos = locate(comp.render(100), "MongoDB");
    click(comp, pos.x, pos.y);
    expect(sm.getAnswer("db").selectedOptionIds).toEqual(["mongo"]);
    expect(sm.currentQuestionIndex).toBe(0);

    pos = locate(comp.render(100), "PostgreSQL");
    click(comp, pos.x, pos.y, 1);
    click(comp, pos.x, pos.y, 2);
    expect(sm.getAnswer("db").selectedOptionIds).toEqual(["pg"]);
    expect(sm.currentQuestionIndex).toBe(1);
  });

  it("clicking multi-select options toggles them", () => {
    const { comp, sm } = setup();
    sm.goToQuestion(1);
    const pos = locate(comp.render(100), "Redis");
    click(comp, pos.x, pos.y);
    expect(sm.getAnswer("cache").selectedOptionIds).toEqual(["redis"]);
    click(comp, pos.x, pos.y);
    expect(sm.getAnswer("cache").selectedOptionIds).toEqual([]);
  });

  it("clicking the submit row on the review tab opens the submit confirmation", () => {
    const { comp, sm } = setup();
    sm.selectOption("db", "pg");
    sm.goToReview();
    const pos = locate(comp.render(100), "[ Submit");
    click(comp, pos.x + 2, pos.y);
    expect((comp as any).inputMode).toMatch(/^confirm_submit/);
  });

  it("leaves wheel, right-click, preview pane and dialogs to pi's default handling", () => {
    const { comp } = setup();
    const lines = comp.render(100);
    const pos = locate(lines, "MongoDB");
    expect(comp.handleMouse(mouse("wheel", pos.x, pos.y, { button: "none", wheelDelta: 1 }))).toBeUndefined();
    expect(comp.handleMouse(mouse("press", pos.x, pos.y, { button: "right" }))).toBeUndefined();
    expect(comp.handleMouse(mouse("press", 95, pos.y))).toBeUndefined(); // side-by-side preview pane

    comp.handleInput("\x1b"); // cancel dialog
    comp.render(100);
    expect(comp.handleMouse(mouse("press", pos.x, pos.y))).toBeUndefined();
  });
});

describe("footer hints and localized chrome", () => {
  it("advertises arrow navigation on questions and review-specific keys on the review tab", () => {
    const { comp, sm } = setup();
    let footer = comp.render(200).at(-1)!;
    expect(footer).toContain("←/→");
    expect(footer).toContain("Shift+Tab");
    expect(footer).toContain("[Space] Select");

    sm.goToReview();
    comp.invalidate();
    footer = comp.render(200).at(-1)!;
    expect(footer).toContain("[s] Submit");
    expect(footer).not.toContain("[Space] Select");
  });

  it("renders translated chrome labels (custom, leave blank, empty answer) instead of English", () => {
    const tr = new Map<string, string>([
      ["c:customLabel", "Personalizado"],
      ["c:markEmpty", "Dejar en blanco"],
      ["c:emptyAnswer", "(Vacío)"],
      ["c:questionLabel", "Pregunta"],
    ]);
    const { comp, sm } = setup(tr, "Spanish");
    sm.goToQuestion(1);
    let text = comp.render(100).join("\n");
    expect(text).toContain("Personalizado");
    expect(text).toContain("Dejar en blanco");
    expect(text).toContain("[Pregunta 2/2]");
    expect(text).not.toContain("Explicit empty");

    sm.goToReview();
    comp.invalidate();
    text = comp.render(100).join("\n");
    expect(text).toContain("(Vacío)");
  });

  it("chrome strings are part of the translatable field set", () => {
    const ids = extractTranslatableFields(params, true).map((f) => f.id);
    expect(ids).toContain("c:customLabel");
    expect(ids).toContain("c:markEmpty");
    expect(ids).toContain("c:footerReview");
  });
});
