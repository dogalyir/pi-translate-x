import { describe, expect, it } from "vitest";
import { QuestionnaireStateMachine } from "../src/domain/state.js";
import type { BilingualQuestionnaireParams } from "../src/tool/schema.js";

describe("QuestionnaireStateMachine", () => {
  const sampleParams: BilingualQuestionnaireParams = {
    title: "Project Setup",
    description: "Configure project options",
    notes: "Global project notes",
    questions: [
      {
        id: "auth",
        header: "Auth",
        prompt: "Choose auth method",
        type: "single",
        required: true,
        options: [
          { id: "jwt", label: "JWT Tokens" },
          { id: "oauth2", label: "OAuth 2.0" },
        ],
        allowCustom: true,
        textMinLength: 3,
        textMaxLength: 50,
      },
      {
        id: "features",
        header: "Features",
        prompt: "Select features",
        type: "multi",
        required: false,
        minSelections: 0,
        maxSelections: 2,
        options: [
          { id: "logging", label: "Structured Logging" },
          { id: "metrics", label: "Prometheus Metrics" },
          { id: "tracing", label: "OpenTelemetry" },
        ],
      },
      {
        id: "deploy_notes",
        header: "Deploy",
        prompt: "Deployment target details",
        type: "text",
        required: false,
        textMinLength: 5,
        textMaxLength: 100,
      },
    ],
  };

  it("initializes questions as unanswered with empty selections", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    expect(sm.currentQuestionIndex).toBe(0);
    expect(sm.currentQuestion.id).toBe("auth");
    expect(sm.isReviewTab).toBe(false);

    const q1 = sm.getAnswer("auth");
    expect(q1.isAnswered).toBe(false);
    expect(q1.selectedOptionIds).toEqual([]);
    expect(q1.customText).toBeUndefined();

    expect(sm.getUnansweredQuestionIds()).toEqual(["auth", "features", "deploy_notes"]);
    expect(sm.canSubmit()).toBe(false);
  });

  it("handles single-select question: selects option, overwrites prior selection", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    sm.selectOption("auth", "jwt");

    const ans = sm.getAnswer("auth");
    expect(ans.isAnswered).toBe(true);
    expect(ans.selectedOptionIds).toEqual(["jwt"]);

    // Switching selection
    sm.selectOption("auth", "oauth2");
    expect(ans.selectedOptionIds).toEqual(["oauth2"]);
    expect(ans.isAnswered).toBe(true);
  });

  it("distinguishes empty selection from unanswered on multi-select question", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);

    // Initial state: unanswered
    expect(sm.getAnswer("features").isAnswered).toBe(false);
    expect(sm.getUnansweredQuestionIds()).toContain("features");

    // Explicitly confirm empty selection
    sm.confirmEmptySelection("features");
    const ans = sm.getAnswer("features");
    expect(ans.isAnswered).toBe(true);
    expect(ans.selectedOptionIds).toEqual([]);
    expect(sm.getUnansweredQuestionIds()).not.toContain("features");

    // Resetting back to unanswered
    sm.resetToUnanswered("features");
    expect(sm.getAnswer("features").isAnswered).toBe(false);
    expect(sm.getUnansweredQuestionIds()).toContain("features");
  });

  it("enforces multi-select maxSelections bounds", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    sm.selectOption("features", "logging");
    sm.selectOption("features", "metrics");
    expect(sm.getQuestionValidationErrors("features")).toHaveLength(0);

    // Adding 3rd exceeds maxSelections: 2
    sm.selectOption("features", "tracing");
    const errors = sm.getQuestionValidationErrors("features");
    expect(errors).toContain("Select at most 2 option(s).");
  });

  it("enforces custom text length bounds", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    // auth question has textMinLength: 3, textMaxLength: 50
    sm.setCustomText("auth", "ab"); // too short
    expect(sm.getQuestionValidationErrors("auth")).toContain("Custom text must be at least 3 characters.");

    sm.setCustomText("auth", "Custom SSO");
    expect(sm.getQuestionValidationErrors("auth")).toHaveLength(0);
  });

  it("supports identical labels with distinct IDs across questions or options", () => {
    const paramsWithIdenticalLabels: BilingualQuestionnaireParams = {
      questions: [
        {
          id: "enable_metrics",
          header: "Metrics",
          prompt: "Enable metrics collection?",
          type: "single",
          options: [
            { id: "opt_yes_1", label: "Yes" },
            { id: "opt_no_1", label: "No" },
          ],
        },
        {
          id: "enable_tracing",
          header: "Tracing",
          prompt: "Enable tracing?",
          type: "single",
          options: [
            { id: "opt_yes_2", label: "Yes" }, // identical label "Yes", distinct ID
            { id: "opt_no_2", label: "No" },
          ],
        },
      ],
    };

    const sm = new QuestionnaireStateMachine(paramsWithIdenticalLabels);
    sm.selectOption("enable_metrics", "opt_yes_1");
    sm.selectOption("enable_tracing", "opt_yes_2");

    expect(sm.getAnswer("enable_metrics").selectedOptionIds).toEqual(["opt_yes_1"]);
    expect(sm.getAnswer("enable_tracing").selectedOptionIds).toEqual(["opt_yes_2"]);
    expect(sm.canSubmit()).toBe(true);
  });

  it("handles custom text identical to a predefined option label without confusion", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    // User types "JWT Tokens" into custom text instead of selecting option "jwt"
    sm.setCustomText("auth", "JWT Tokens");

    const ans = sm.getAnswer("auth");
    expect(ans.isAnswered).toBe(true);
    expect(ans.selectedOptionIds).toEqual([]); // not checked in option list
    expect(ans.customText).toBe("JWT Tokens");
    expect(sm.canSubmit()).toBe(true);
  });

  it("prevents submission when required question is unanswered", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    // auth is required, features and deploy_notes are optional
    expect(sm.canSubmit()).toBe(false);

    sm.selectOption("auth", "jwt");
    expect(sm.canSubmit()).toBe(true);

    sm.resetToUnanswered("auth");
    expect(sm.canSubmit()).toBe(false);
  });

  it("handles tab navigation and review tab transitions", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    expect(sm.currentQuestionIndex).toBe(0);

    expect(sm.next()).toBe(true);
    expect(sm.currentQuestionIndex).toBe(1);

    expect(sm.next()).toBe(true);
    expect(sm.currentQuestionIndex).toBe(2);

    // Next on last question moves to review tab
    expect(sm.next()).toBe(false);
    expect(sm.isReviewTab).toBe(true);

    // Prev moves back from review to last question
    expect(sm.prev()).toBe(true);
    expect(sm.isReviewTab).toBe(false);
    expect(sm.currentQuestionIndex).toBe(2);

    // Jump directly to review
    sm.goToReview();
    expect(sm.isReviewTab).toBe(true);

    // Jump to specific question
    sm.goToQuestion(0);
    expect(sm.isReviewTab).toBe(false);
    expect(sm.currentQuestionIndex).toBe(0);
  });

  it("preserves question notes and global notes", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    sm.setQuestionNotes("auth", "Remember to configure certs");
    sm.setGlobalNotes("Updated overall notes");

    expect(sm.getAnswer("auth").notes).toBe("Remember to configure certs");
    expect(sm.globalNotes).toBe("Updated overall notes");
  });

  it("disables submission on cancellation", () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    sm.selectOption("auth", "jwt");
    expect(sm.canSubmit()).toBe(true);

    sm.cancel();
    expect(sm.isCancelled).toBe(true);
    expect(sm.canSubmit()).toBe(false);
  });

  describe("State Discipline & Validation Boundary", () => {
    it("validates schema constraints on initialization", () => {
      // Duplicate question ID
      expect(() => {
        new QuestionnaireStateMachine({
          questions: [
            { id: "q1", header: "Q1", prompt: "P1" },
            { id: "q1", header: "Q1 dup", prompt: "P2" },
          ],
        });
      }).toThrow(/Duplicate question ID/);

      // Duplicate option ID
      expect(() => {
        new QuestionnaireStateMachine({
          questions: [
            {
              id: "q1",
              header: "Q1",
              prompt: "P1",
              options: [
                { id: "opt1", label: "Opt 1" },
                { id: "opt1", label: "Opt 1 dup" },
              ],
            },
          ],
        });
      }).toThrow(/Duplicate option ID/);

      // minSelections > maxSelections
      expect(() => {
        new QuestionnaireStateMachine({
          questions: [
            {
              id: "q1",
              header: "Q1",
              prompt: "P1",
              type: "multi",
              minSelections: 3,
              maxSelections: 2,
              options: [
                { id: "o1", label: "O1" },
                { id: "o2", label: "O2" },
                { id: "o3", label: "O3" },
              ],
            },
          ],
        });
      }).toThrow(/minSelections.*cannot exceed maxSelections/);

      // textMinLength > textMaxLength
      expect(() => {
        new QuestionnaireStateMachine({
          questions: [
            {
              id: "q1",
              header: "Q1",
              prompt: "P1",
              type: "text",
              textMinLength: 100,
              textMaxLength: 10,
            },
          ],
        });
      }).toThrow(/textMinLength.*cannot exceed textMaxLength/);
    });

    it("rejects unknown option IDs in selectOption", () => {
      const sm = new QuestionnaireStateMachine(sampleParams);
      expect(() => sm.selectOption("auth", "non-existent-opt")).toThrow(/Unknown option ID/);
    });

    it("enforces allowCustom boundary", () => {
      const sm = new QuestionnaireStateMachine(sampleParams);
      // features question has allowCustom: default true, but let's test a question with allowCustom: false
      const strictParams: BilingualQuestionnaireParams = {
        questions: [
          {
            id: "strict_q",
            header: "Strict",
            prompt: "No custom allowed",
            type: "single",
            allowCustom: false,
            options: [{ id: "opt_a", label: "A" }],
          },
        ],
      };
      const strictSm = new QuestionnaireStateMachine(strictParams);
      expect(() => strictSm.setCustomText("strict_q", "My custom text")).toThrow(/Custom text is not allowed/);
    });

    it("clearing custom text or toggling off last option resets to unanswered without implicit empty confirmation", () => {
      const sm = new QuestionnaireStateMachine(sampleParams);

      // Multi-select toggle on then off
      sm.selectOption("features", "logging");
      expect(sm.getAnswer("features").isAnswered).toBe(true);

      sm.selectOption("features", "logging"); // toggle off
      expect(sm.getAnswer("features").isAnswered).toBe(false);
      expect(sm.getAnswer("features").emptySelectionConfirmed).toBe(false);
      expect(sm.getUnansweredQuestionIds()).toContain("features");

      // Custom text on deploy_notes set then cleared
      sm.setCustomText("deploy_notes", "AWS us-east-1");
      expect(sm.getAnswer("deploy_notes").isAnswered).toBe(true);

      sm.setCustomText("deploy_notes", "");
      expect(sm.getAnswer("deploy_notes").isAnswered).toBe(false);
      expect(sm.getAnswer("deploy_notes").emptySelectionConfirmed).toBe(false);
      expect(sm.getUnansweredQuestionIds()).toContain("deploy_notes");
    });

    it("distinguishes conscious partial submit from invalid answered fields", () => {
      const sm = new QuestionnaireStateMachine(sampleParams);
      // auth is required
      // features has maxSelections: 2
      sm.selectOption("features", "logging");
      sm.selectOption("features", "metrics");
      sm.selectOption("features", "tracing"); // exceeds maxSelections: 2!

      // Has invalid answered field -> cannot submit even with allowPartial=true
      expect(sm.getInvalidAnswerErrors().length).toBeGreaterThan(0);
      expect(sm.canSubmit(true)).toBe(false);

      // Fix features
      sm.selectOption("features", "tracing"); // toggle off
      expect(sm.getInvalidAnswerErrors().length).toBe(0);

      // Now only unanswered required question "auth" remains
      // canSubmit() (full) is false
      expect(sm.canSubmit()).toBe(false);
      // canSubmit(true) (conscious partial) is true!
      expect(sm.canSubmit(true)).toBe(true);
    });

    it("requires deliberate confirmEmptySelection, but required questions still fail validation", () => {
      const sm = new QuestionnaireStateMachine(sampleParams);
      // auth is required
      sm.confirmEmptySelection("auth");
      expect(sm.getAnswer("auth").isAnswered).toBe(true);
      expect(sm.getAnswer("auth").emptySelectionConfirmed).toBe(true);
      expect(sm.getUnansweredQuestionIds()).not.toContain("auth");

      // Validation fails because auth is required!
      const errors = sm.getQuestionValidationErrors("auth");
      expect(errors).toContain("This question is required.");
    });
  });
});
