import { describe, expect, it, vi } from "vitest";
import { QuestionnaireStateMachine } from "../src/domain/state.js";
import { buildDisplayQuestionnaire } from "../src/domain/projection.js";
import { runQuestionnaireRPC } from "../src/rpc/flow.js";
import type { BilingualQuestionnaireParams } from "../src/tool/schema.js";

const sampleParams: BilingualQuestionnaireParams = {
  title: "RPC Flow Test",
  questions: [
    {
      id: "framework",
      header: "Framework",
      prompt: "Choose framework",
      type: "single",
      options: [
        { id: "react", label: "React" },
        { id: "vue", label: "Vue" },
      ],
      allowCustom: true,
    },
    {
      id: "tools",
      header: "Tools",
      prompt: "Select developer tools",
      type: "multi",
      options: [
        { id: "eslint", label: "ESLint" },
        { id: "prettier", label: "Prettier" },
      ],
      allowCustom: false,
    },
  ],
};

describe("RPC Fallback Flow", () => {
  it("progresses sequentially through single, multi, notes, and confirm dialogs", async () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");

    const mockUI = {
      select: vi
        .fn()
        // 1. Framework single select
        .mockResolvedValueOnce("React")
        // 2. Tools multi select first toggle: ESLint
        .mockResolvedValueOnce("[ ] ESLint")
        // 3. Tools multi select second toggle: Done
        .mockResolvedValueOnce("✔ Done (confirm selections)"),
      input: vi
        .fn()
        // 1. Framework note
        .mockResolvedValueOnce("Use v19")
        // 2. Global note
        .mockResolvedValueOnce("Fast build setup"),
      confirm: vi
        .fn()
        // Framework want note?
        .mockResolvedValueOnce(true)
        // Tools want note?
        .mockResolvedValueOnce(false)
        // Want global notes?
        .mockResolvedValueOnce(true)
        // Submit confirmation
        .mockResolvedValueOnce(true),
      notify: vi.fn(),
    } as any;

    const result = await runQuestionnaireRPC(mockUI, sm, display);
    expect(result.status).toBe("submitted");

    expect(sm.getAnswer("framework").selectedOptionIds).toEqual(["react"]);
    expect(sm.getAnswer("framework").notes).toBe("Use v19");
    expect(sm.getAnswer("tools").selectedOptionIds).toEqual(["eslint"]);
    expect(sm.globalUserNotes).toBe("Fast build setup");
  });

  it("handles custom answer selection in RPC mode", async () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");

    const mockUI = {
      select: vi
        .fn()
        // 1. Choose custom answer option for framework
        .mockResolvedValueOnce("Type custom answer...")
        // 2. Tools multi select: toggle ESLint
        .mockResolvedValueOnce("[ ] ESLint")
        // 3. Tools: done
        .mockResolvedValueOnce("✔ Done (confirm selections)"),
      input: vi
        .fn()
        // Custom text entered
        .mockResolvedValueOnce("Svelte 5"),
      confirm: vi
        .fn()
        .mockResolvedValueOnce(false) // framework note decline
        .mockResolvedValueOnce(false) // tools note decline
        .mockResolvedValueOnce(false) // global note decline
        .mockResolvedValueOnce(true), // final submit confirm
      notify: vi.fn(),
    } as any;

    const result = await runQuestionnaireRPC(mockUI, sm, display);
    expect(result.status).toBe("submitted");
    expect(sm.getAnswer("framework").customText).toBe("Svelte 5");
  });

  it("returns cancelled if user cancels any prompt in RPC mode", async () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");

    const mockUI = {
      select: vi.fn().mockResolvedValueOnce(undefined), // User cancelled select
      input: vi.fn(),
      confirm: vi.fn(),
      notify: vi.fn(),
    } as any;

    const result = await runQuestionnaireRPC(mockUI, sm, display);
    expect(result.status).toBe("cancelled");
  });

  it("returns cancelled if user declines final submit confirm", async () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");

    const mockUI = {
      select: vi
        .fn()
        .mockResolvedValueOnce("React")
        .mockResolvedValueOnce("✔ Done (confirm selections)"),
      input: vi.fn(),
      confirm: vi
        .fn()
        .mockResolvedValueOnce(false) // decline note
        .mockResolvedValueOnce(false) // decline note
        .mockResolvedValueOnce(false) // decline global note
        .mockResolvedValueOnce(false), // decline final submit!
      notify: vi.fn(),
    } as any;

    const result = await runQuestionnaireRPC(mockUI, sm, display);
    expect(result.status).toBe("cancelled");
  });

  describe("RPC Substrings, Duplicates, Back Navigation, and Partial Validation", () => {
    it("handles substring and duplicate labels without wrong option toggling", async () => {
      const trickyParams: BilingualQuestionnaireParams = {
        questions: [
          {
            id: "lang",
            header: "Language",
            prompt: "Choose language",
            type: "multi",
            options: [
              { id: "c", label: "C" },
              { id: "cpp", label: "C++" }, // Substring of C++ is C
            ],
            allowCustom: false,
          },
          {
            id: "db",
            header: "Database",
            prompt: "Choose DB",
            type: "single",
            options: [
              { id: "sql", label: "SQL" },
              { id: "nosql", label: "NoSQL" }, // Substring contains SQL
            ],
          },
        ],
      };

      const sm = new QuestionnaireStateMachine(trickyParams);
      const display = buildDisplayQuestionnaire(trickyParams, undefined, "English");

      const mockUI = {
        select: vi
          .fn()
          // 1. In lang multi-select: toggle C++ using exact token [2] [ ] C++
          .mockResolvedValueOnce("[2] [ ] C++")
          // 2. Done with lang
          .mockResolvedValueOnce("✔ Done (confirm selections)")
          // 3. In db single-select: choose NoSQL using exact token [2] NoSQL
          .mockResolvedValueOnce("[2] NoSQL"),
        input: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        notify: vi.fn(),
      } as any;

      const result = await runQuestionnaireRPC(mockUI, sm, display);
      expect(result.status).toBe("submitted");

      // C++ was toggled, NOT C
      expect(sm.getAnswer("lang").selectedOptionIds).toEqual(["cpp"]);
      // NoSQL was selected, NOT SQL
      expect(sm.getAnswer("db").selectedOptionIds).toEqual(["nosql"]);
    });

    it("supports back navigation to re-answer prior questions", async () => {
      const sm = new QuestionnaireStateMachine(sampleParams);
      const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");

      const mockUI = {
        select: vi
          .fn()
          // 1. Q1: select Vue
          .mockResolvedValueOnce("Vue")
          // 2. Q2: decide to go back
          .mockResolvedValueOnce("← Back to previous question")
          // 3. Q1 again: change to React
          .mockResolvedValueOnce("React")
          // 4. Q2: toggle ESLint
          .mockResolvedValueOnce("[1] [ ] ESLint")
          // 5. Q2: done
          .mockResolvedValueOnce("✔ Done (confirm selections)"),
        input: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        notify: vi.fn(),
      } as any;

      const result = await runQuestionnaireRPC(mockUI, sm, display);
      expect(result.status).toBe("submitted");
      expect(sm.getAnswer("framework").selectedOptionIds).toEqual(["react"]);
    });

    it("requires conscious confirmation for partial submission with unanswered required questions", async () => {
      const sm = new QuestionnaireStateMachine(sampleParams);
      const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");

      const mockUI = {
        select: vi
          .fn()
          // 1. Q1 Framework: answered validly
          .mockResolvedValueOnce("React")
          // 2. Q2 Tools: skip question
          .mockResolvedValueOnce("⏭ Skip this question"),
        input: vi.fn(),
        confirm: vi
          .fn()
          // Note declines
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(false)
          // Conscious confirmation for partial submission
          .mockResolvedValueOnce(true),
        notify: vi.fn(),
      } as any;

      const result = await runQuestionnaireRPC(mockUI, sm, display);
      expect(result.status).toBe("submitted");
      expect(mockUI.confirm).toHaveBeenCalledWith(
        "Confirm partial submission?",
        expect.stringMatching(/tools/i),
      );
    });

    it("multi-select with invalid custom text blocks Done even when no options are selected", async () => {
      const customParams: BilingualQuestionnaireParams = {
        questions: [
          {
            id: "deps",
            header: "Dependencies",
            prompt: "Select or add dependencies",
            type: "multi",
            options: [{ id: "opt1", label: "Lib A" }],
            allowCustom: true,
            required: false,
            textMinLength: 5,
          },
        ],
      };

      const sm = new QuestionnaireStateMachine(customParams);
      const display = buildDisplayQuestionnaire(customParams, undefined, "English");

      const mockUI = {
        select: vi
          .fn()
          // 1. Choose custom answer
          .mockResolvedValueOnce("[Custom]")
          // 2. Try Done -> should be blocked by warning because custom text "ab" < 5 chars!
          .mockResolvedValueOnce("✔ Done (confirm selections)")
          // 3. Enter custom again to fix it
          .mockResolvedValueOnce("[Custom]")
          // 4. Try Done again -> now valid!
          .mockResolvedValueOnce("✔ Done (confirm selections)"),
        input: vi
          .fn()
          // First custom input: "ab" (2 chars, too short!)
          .mockResolvedValueOnce("ab")
          // Second custom input: "library-xyz" (11 chars, valid!)
          .mockResolvedValueOnce("library-xyz"),
        confirm: vi
          .fn()
          .mockResolvedValueOnce(false) // decline question note
          .mockResolvedValueOnce(false) // decline global note
          .mockResolvedValueOnce(true), // confirm submit
        notify: vi.fn(),
      } as any;

      const result = await runQuestionnaireRPC(mockUI, sm, display);
      expect(result.status).toBe("submitted");
      // Verify warning was triggered when done was attempted with invalid custom text
      expect(mockUI.notify).toHaveBeenCalledWith(
        expect.stringMatching(/Custom text must be at least 5 characters/i),
        "warning",
      );
      expect(sm.getAnswer("deps").customText).toBe("library-xyz");
    });

    it("supports selectable review menu to jump to edit question and edit global notes while preserving drafts", async () => {
      const sm = new QuestionnaireStateMachine(sampleParams);
      const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");

      const mockUI = {
        select: vi
          .fn()
          // 1. Q1: select React
          .mockResolvedValueOnce("React")
          // 2. Q2: toggle ESLint
          .mockResolvedValueOnce("[1] [ ] ESLint")
          // 3. Q2: done
          .mockResolvedValueOnce("✔ Done (confirm selections)")
          // In review menu: user chooses to edit Q1 to change to Vue
          .mockResolvedValueOnce("[Edit Q1] Framework (✓ Answered)")
          // In Q1 edit: select Vue
          .mockResolvedValueOnce("Vue")
          // Back in review menu: user chooses to edit Notes
          .mockResolvedValueOnce('[Edit Notes] Global Notes: (None)')
          // Back in review menu: user submits
          .mockResolvedValueOnce("[Submit] Submit Answers"),
        input: vi
          .fn()
          // Edit global notes
          .mockResolvedValueOnce("Updated global notes via review"),
        confirm: vi
          .fn()
          // Sequential notes declines
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(false)
          // Review submit confirm initial: decline to enter review menu
          .mockResolvedValueOnce(false)
          // Q1 note during edit
          .mockResolvedValueOnce(false)
          // Final review submit confirm
          .mockResolvedValueOnce(true),
        notify: vi.fn(),
      } as any;

      const result = await runQuestionnaireRPC(mockUI, sm, display);
      expect(result.status).toBe("submitted");
      // Framework was changed to Vue
      expect(sm.getAnswer("framework").selectedOptionIds).toEqual(["vue"]);
      // ESLint from Q2 was strictly preserved
      expect(sm.getAnswer("tools").selectedOptionIds).toEqual(["eslint"]);
      // Global notes were set
      expect(sm.globalUserNotes).toBe("Updated global notes via review");
    });

    it("returns aborted immediately when public signal is aborted during native RPC dialogs", async () => {
      const sm = new QuestionnaireStateMachine(sampleParams);
      const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");
      const controller = new AbortController();

      const mockUI = {
        select: vi.fn().mockImplementation(async () => {
          controller.abort("RPC aborted externally");
          return undefined;
        }),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
      } as any;

      const result = await runQuestionnaireRPC(mockUI, sm, display, controller.signal);
      expect(result.status).toBe("aborted");
    });
  });
});
