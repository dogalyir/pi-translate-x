import { describe, expect, it } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  buildDisplayQuestionnaire,
  extractTranslatableFields,
  resolveCanonicalAnswers,
} from "../src/domain/projection.js";
import { QuestionnaireStateMachine } from "../src/domain/state.js";
import { TranslationServiceClient } from "../src/service/client.js";
import {
  CHANNELS,
  PROTOCOL_VERSION,
  type ProtocolBatchRequest,
  type ProtocolBatchResponse,
} from "../src/service/protocol.js";
import type { BilingualQuestionnaireParams } from "../src/tool/schema.js";

describe("Projection & Canonical Resolution", () => {
  const sampleParams: BilingualQuestionnaireParams = {
    title: "Database Configuration",
    description: "Select backend database",
    notes: "Affects backup strategy",
    questions: [
      {
        id: "db_choice",
        header: "Database",
        prompt: "Which database should we use?",
        description: "Consider scale and operations",
        notes: "Postgres is recommended",
        textPlaceholder: "Enter custom DB",
        type: "single",
        options: [
          {
            id: "pg",
            label: "PostgreSQL",
            description: "Relational ACID database",
            preview: "```sql\nCREATE TABLE users ();\n```",
          },
          {
            id: "mongo",
            label: "MongoDB",
            description: "Document database",
          },
        ],
        allowCustom: true,
      },
      {
        id: "cache",
        header: "Cache",
        prompt: "Choose cache layer",
        type: "single",
        options: [{ id: "redis", label: "Redis" }],
        required: false,
      },
    ],
  };

  it("extracts all translatable fields with stable identifiers", () => {
    const fields = extractTranslatableFields(sampleParams);
    const fieldMap = new Map(fields.map((f) => [f.id, f.text]));

    expect(fieldMap.get("g:title")).toBe("Database Configuration");
    expect(fieldMap.get("g:desc")).toBe("Select backend database");
    expect(fieldMap.get("g:notes")).toBe("Affects backup strategy");
    expect(fieldMap.get("q:db_choice:header")).toBe("Database");
    expect(fieldMap.get("q:db_choice:prompt")).toBe("Which database should we use?");
    expect(fieldMap.get("q:db_choice:desc")).toBe("Consider scale and operations");
    expect(fieldMap.get("q:db_choice:notes")).toBe("Postgres is recommended");
    expect(fieldMap.get("q:db_choice:placeholder")).toBe("Enter custom DB");
    expect(fieldMap.get("q:db_choice:opt:pg:label")).toBe("PostgreSQL");
    expect(fieldMap.get("q:db_choice:opt:pg:desc")).toBe("Relational ACID database");
    expect(fieldMap.get("q:db_choice:opt:pg:preview")).toBe("```sql\nCREATE TABLE users ();\n```");
  });

  it("builds localized display questionnaire falling back to canonical English", () => {
    const translations = new Map<string, string>([
      ["g:title", "Configuration de la base de données"],
      ["q:db_choice:header", "Base de données"],
      ["q:db_choice:prompt", "Quelle base de données devons-nous utiliser ?"],
      ["q:db_choice:opt:pg:label", "PostgreSQL (FR)"],
    ]);

    const display = buildDisplayQuestionnaire(sampleParams, translations, "French");
    expect(display.isTranslated).toBe(true);
    expect(display.title).toBe("Configuration de la base de données");
    expect(display.questions[0]?.header).toBe("Base de données");
    expect(display.questions[0]?.prompt).toBe("Quelle base de données devons-nous utiliser ?");
    expect(display.questions[0]?.options[0]?.label).toBe("PostgreSQL (FR)");

    // Field not present in translations falls back to original English
    expect(display.questions[0]?.description).toBe("Consider scale and operations");
    expect(display.questions[0]?.canonicalHeader).toBe("Database");
    expect(display.questions[0]?.options[0]?.canonicalLabel).toBe("PostgreSQL");
  });

  it("resolves canonical answers with ZERO backtranslation for predefined options", async () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    sm.selectOption("db_choice", "pg");

    const display = buildDisplayQuestionnaire(sampleParams, new Map([["q:db_choice:opt:pg:label", "PostgreSQL (Translated)"]]), "French");

    const result = await resolveCanonicalAnswers(sm, {
      sessionId: "session-1",
      branchId: "branch-1",
      toolCallId: "call-1",
      isTranslatedMode: true,
      targetLanguage: "French",
      displayQuestionnaire: display,
    });

    expect(result.details.status).toBe("submitted");
    expect(result.details.answers).toHaveLength(1);
    const ans = result.details.answers[0]!;

    // Must resolve strictly to canonical English "PostgreSQL", NOT "PostgreSQL (Translated)"
    expect(ans.selectedOptionIds).toEqual(["pg"]);
    expect(ans.selectedOptionLabels).toEqual(["PostgreSQL"]);
    expect(ans.questionHeader).toBe("Database");
    expect(ans.questionPrompt).toBe("Which database should we use?");

    // Unanswered optional question is tracked
    expect(result.details.unansweredQuestionIds).toEqual(["cache"]);

    // Durable record contains display and canonical definitions
    expect(result.durableRecord).toBeDefined();
    expect(result.durableRecord?.sessionId).toBe("session-1");
    expect(result.durableRecord?.canonical.answers[0]?.selectedOptionLabels).toEqual(["PostgreSQL"]);
  });

  it("translates custom answers and notes to English before returning canonical result", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    // Mock service that translates French custom answer and notes back to English
    bus.on(CHANNELS.BATCH_REQUEST, (data) => {
      const req = data as ProtocolBatchRequest;
      const resp: ProtocolBatchResponse = {
        version: PROTOCOL_VERSION,
        correlationId: req.correlationId,
        ok: true,
        items: req.items.map((it) => {
          if (it.text === "CockroachDB distribuée") {
            return { id: it.id, text: "Distributed CockroachDB" };
          }
          if (it.text === "Doit être conforme RGPD") {
            return { id: it.id, text: "Must be GDPR compliant" };
          }
          return { id: it.id, text: it.text };
        }),
      };
      bus.emit(CHANNELS.BATCH_RESPONSE, resp);
    });

    const sm = new QuestionnaireStateMachine(sampleParams);
    sm.setCustomText("db_choice", "CockroachDB distribuée");
    sm.setQuestionNotes("db_choice", "Doit être conforme RGPD");

    const result = await resolveCanonicalAnswers(sm, {
      client,
      sessionId: "session-1",
      branchId: "branch-1",
      toolCallId: "call-2",
      isTranslatedMode: true,
      targetLanguage: "French",
    });

    expect(result.details.answers).toHaveLength(1);
    const ans = result.details.answers[0]!;
    expect(ans.customText).toBe("Distributed CockroachDB");
    expect((ans as any).customTextOriginal).toBeUndefined();
    expect(ans.notes).toBe("Must be GDPR compliant");
    // Original native text is preserved strictly in context-excluded durable record
    expect(result.durableRecord?.display?.answers[0]?.customTextOriginal).toBe("CockroachDB distribuée");
  });

  it("fails closed on answer translation failure: throws error and preserves drafts in state machine", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    // Service returns error
    bus.on(CHANNELS.BATCH_REQUEST, (data) => {
      const req = data as ProtocolBatchRequest;
      const resp: ProtocolBatchResponse = {
        version: PROTOCOL_VERSION,
        correlationId: req.correlationId,
        ok: false,
        error: {
          code: "provider",
          message: "Translation service unavailable",
        },
      };
      bus.emit(CHANNELS.BATCH_RESPONSE, resp);
    });

    const sm = new QuestionnaireStateMachine(sampleParams);
    sm.setCustomText("db_choice", "Mon texte personnalisé");

    await expect(
      resolveCanonicalAnswers(sm, {
        client,
        sessionId: "session-1",
        branchId: "branch-1",
        toolCallId: "call-3",
        isTranslatedMode: true,
        targetLanguage: "French",
      }),
    ).rejects.toThrow();

    // Draft is strictly preserved in state machine for retry/edit
    expect(sm.getAnswer("db_choice").customText).toBe("Mon texte personnalisé");
  });

  it("preserves previews and descriptions in durable record and includes preview in canonical output", async () => {
    const sm = new QuestionnaireStateMachine(sampleParams);
    sm.selectOption("db_choice", "pg");

    const display = buildDisplayQuestionnaire(sampleParams, undefined, "English");
    const result = await resolveCanonicalAnswers(sm, {
      sessionId: "session-prev",
      branchId: "branch-prev",
      toolCallId: "call-prev",
      isTranslatedMode: false,
      displayQuestionnaire: display,
    });

    // Canonical answer contains canonical selected previews
    expect(result.details.answers[0]?.selectedOptionPreviews).toEqual([
      "```sql\nCREATE TABLE users ();\n```",
    ]);

    // Durable record contains option description and preview
    const dq = result.durableRecord?.display?.questions[0];
    const opt = dq?.options?.[0];
    expect(opt?.description).toBe("Relational ACID database");
    expect(opt?.preview).toBe("```sql\nCREATE TABLE users ();\n```");
  });

  it("reverse-translates custom text even in English fallback mode when translator is available", async () => {
    const bus = createEventBus();
    const client = new TranslationServiceClient({ events: bus });

    bus.on(CHANNELS.BATCH_REQUEST, (data) => {
      const req = data as ProtocolBatchRequest;
      const resp: ProtocolBatchResponse = {
        version: PROTOCOL_VERSION,
        correlationId: req.correlationId,
        ok: true,
        items: req.items.map((it) => ({
          id: it.id,
          text: it.text === "Texte en français" ? "Text in English" : it.text,
        })),
      };
      bus.emit(CHANNELS.BATCH_RESPONSE, resp);
    });

    const sm = new QuestionnaireStateMachine(sampleParams);
    sm.setCustomText("db_choice", "Texte en français");

    const result = await resolveCanonicalAnswers(sm, {
      client,
      sessionId: "session-fallback",
      branchId: "branch-fallback",
      toolCallId: "call-fallback",
      isTranslatedMode: false, // ENGLISH FALLBACK DISPLAY
      targetLanguage: "English",
    });

    // Custom text was reverse-translated to English
    expect(result.details.answers[0]?.customText).toBe("Text in English");
    // Canonical result never contains non-English original
    expect(JSON.stringify(result.details.answers)).not.toContain("Texte en français");
    // Original is in durable display record only
    expect(result.durableRecord?.display?.answers[0]?.customTextOriginal).toBe("Texte en français");
  });

  it("validates durable records robustly against malformed history records", async () => {
    const { isDurableQuestionnaireRecord } = await import("../src/persistence/record.js");

    expect(isDurableQuestionnaireRecord(null)).toBe(false);
    expect(isDurableQuestionnaireRecord(undefined)).toBe(false);
    expect(isDurableQuestionnaireRecord("not-an-object")).toBe(false);
    expect(isDurableQuestionnaireRecord({})).toBe(false);
    expect(isDurableQuestionnaireRecord({ version: 2 })).toBe(false);
    expect(
      isDurableQuestionnaireRecord({
        version: 1,
        recordId: "rec-1",
        sessionId: "sess-1",
        branchId: "branch-1",
        canonical: {
          answers: "invalid-answers-not-array",
          unansweredQuestionIds: [],
        },
      }),
    ).toBe(false);
  });
});
