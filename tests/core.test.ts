import { describe, expect, it, vi } from "vitest";
import { validateConfig } from "../src/core/config.js";
import { ProtectedTranslationEngine, unwrapTranslation, wrapTranslationSource } from "../src/core/engine.js";
import { Lifecycle } from "../src/core/lifecycle.js";
import { cacheKey, createRecord, isDurableTranslationRecord, TranslationCache } from "../src/core/records.js";
import { protectLiterals } from "../src/core/protection.js";
import { TranslationScheduler } from "../src/core/scheduler.js";
import type { TranslationRequest } from "../src/core/contracts.js";
const request = (overrides: Partial<TranslationRequest> = {}): TranslationRequest => ({ requestId: "r1", sessionId: "s1", branchId: "b1", source: "Hola `x` https://a.test", targetLanguage: "English", modelRef: "provider/model", signal: new AbortController().signal, ...overrides });

describe("config", () => {
  it("strictly validates version and approved card modes", () => {
    const config = { version: 1, enabled: true, input: true, output: true, targetLanguage: "Japanese", provider: "p", model: "m", displayMode: "bilingual", timeoutMs: 60000 };
    expect(validateConfig(config).displayMode).toBe("bilingual"); expect(() => validateConfig({ ...config, displayMode: "translated-first" })).toThrow(/displayMode/); expect(() => validateConfig({ ...config, unknown: 1 })).toThrow(/Unknown/);
  });
});

describe("engine/protection", () => {
  it("preserves fences, inline code, CRLF, Windows paths and all JS replacement patterns exactly", () => {
    const source = "Translate this prose\r\n````js\r\nconst markers = '$& $$ $` $\\'';\r\n````\r\nAnd inline `$& $$ $` $\\''` plus C:\\Users\\me\\a.ts and literal ⟪PI_LITERAL_fake_0⟫.";
    const protectedText = protectLiterals(source); expect(protectedText.restore(protectedText.masked)).toBe(source);
  });
  it("skips protected-only content and enforces deadline cancellation", async () => {
    let calls = 0; const engine = new ProtectedTranslationEngine(async () => { calls++; return "ignored"; });
    const code = "```ts\nconst x = 1;\n```"; await expect(engine.translate(request({ source: code }))).resolves.toMatchObject({ text: code }); expect(calls).toBe(0);
    const slow = new ProtectedTranslationEngine(async () => await new Promise<string>(() => {}));
    await expect(slow.translate(request({ source: "Bonjour", timeoutMs: 1000 }))).rejects.toMatchObject({ code: "timeout" });
  });
  it("uses deterministic fake translator and fails on empty output", async () => {
    const engine = new ProtectedTranslationEngine(async (_req, text) => text.replace("Hola", "Hello"));
    await expect(engine.translate(request())).resolves.toMatchObject({ text: "Hello `x` https://a.test" });
    await expect(new ProtectedTranslationEngine(async () => " ").translate(request())).rejects.toThrow(/empty/);
  });
  it("retries once with token hint on placeholder integrity failure", async () => {
    const hints: unknown[] = [];
    const engine = new ProtectedTranslationEngine(async (_req, text, retry) => { hints.push(retry); return retry ? text.replace("Hola", "Hello") : text.replace(/⟪[^⟫]*_0⟫/, "").replace("Hola", "Hello"); });
    await expect(engine.translate(request())).resolves.toMatchObject({ text: "Hello `x` https://a.test" });
    expect(hints).toHaveLength(2); expect(hints[0]).toBeUndefined(); expect(hints[1]).toMatchObject({ attempt: 2, tokens: [expect.stringMatching(/_0⟫$/), expect.stringMatching(/_1⟫$/)] });
  });
  it("fences the source in the user turn and strips echoed wrapper tags", () => {
    const p = protectLiterals("Hola `x`"); const wrapped = wrapTranslationSource(p.masked, "English");
    expect(wrapped).toContain(`<source_text>\n${p.masked}\n</source_text>`); expect(wrapped).toMatch(/into English/);
    expect(unwrapTranslation(`<source_text>\nHello ${p.tokens[0]}\n</source_text>\n`)).toBe(`Hello ${p.tokens[0]}`);
    expect(unwrapTranslation("Plain\n\ntext")).toBe("Plain\n\ntext");
  });
  it("fails after the single retry and does not retry non-integrity errors", async () => {
    let calls = 0; const broken = new ProtectedTranslationEngine(async (_req, text) => { calls++; return text + text; });
    await expect(broken.translate(request())).rejects.toMatchObject({ code: "integrity" }); expect(calls).toBe(2);
    let emptyCalls = 0; const empty = new ProtectedTranslationEngine(async () => { emptyCalls++; return ""; });
    await expect(empty.translate(request())).rejects.toMatchObject({ code: "empty" }); expect(emptyCalls).toBe(1);
  });
});

describe("records/cache", () => {
  it("validates record discriminants and exact cache key identity", () => {
    const input = createRecord({ kind: "input", sessionId: "s", branchId: "b", source: "same", original: "same", translated: "English", targetLanguage: "English", modelRef: "p/m", submissionId: "unique", inputDisposition: "prepared-for-input-pipeline" });
    expect(isDurableTranslationRecord(input)).toBe(true); expect(isDurableTranslationRecord({ ...input, version: 2 })).toBe(false);
    const c = new TranslationCache(); const parts = { source: " exact ", targetLanguage: "English", modelRef: "p/m", protectionVersion: 2 };
    c.set(parts, "x"); expect(c.get(parts)).toBe("x"); expect(c.get({ ...parts, source: "exact" })).toBeUndefined(); expect(cacheKey(parts)).not.toBe(cacheKey({ ...parts, targetLanguage: "French" }));
  });
});

describe("scheduler/lifecycle", () => {
  it("deduplicates shared work while returning consumer-specific identity", async () => {
    let finish!: (r: { requestId: string; text: string }) => void;
    const scheduler = new TranslationScheduler({ translate: vi.fn(async (_r: TranslationRequest) => await new Promise<{ requestId: string; text: string }>((resolve) => { finish = resolve; })) }, 1, 0);
    const first = scheduler.submit(request()); const second = scheduler.submit(request({ requestId: "r2" }), "output"); await Promise.resolve();
    finish({ requestId: "internal", text: "ok" }); await expect(Promise.all([first, second])).resolves.toEqual([{ requestId: "r1", text: "ok" }, { requestId: "r2", text: "ok" }]);
  });
  it("cancellation frees bounded capacity even when provider ignores signal", async () => {
    let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
    const never = new Promise<{ requestId: string; text: string }>(() => {});
    const scheduler = new TranslationScheduler({ translate: async (r) => { if (r.source === "blocked") { started(); return await never; } return { requestId: r.requestId, text: "next" }; } }, 1, 0);
    const aborter = new AbortController(); const blocked = scheduler.submit(request({ source: "blocked", signal: aborter.signal }), "output"); await began;
    aborter.abort(); await expect(blocked).rejects.toMatchObject({ code: "aborted" });
    await expect(scheduler.submit(request({ source: "next" }))).resolves.toMatchObject({ text: "next" });
  });
  it("applies input priority before queued output", async () => {
    const calls: string[] = []; let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new TranslationScheduler({ translate: async (r) => { calls.push(r.source); if (r.source === "blocked") await blocked; return { requestId: r.requestId, text: r.source }; } }, 2, 1);
    const active = scheduler.submit(request({ source: "blocked" }), "output"); await new Promise((r) => setTimeout(r, 0));
    const output = scheduler.submit(request({ source: "output" }), "output"); await new Promise((r) => setTimeout(r, 0));
    const input = scheduler.submit(request({ source: "input" }), "input"); await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["blocked", "input"]); release(); await Promise.all([active, input, output]); expect(calls).toEqual(["blocked", "input", "output"]);
  });
  it("uses stable session identity across fresh context wrappers; tree navigation invalidates", () => {
    const life = new Lifecycle(); life.activate("s1"); const old = life.snapshot(); const wrappers = [{ sessionId: "s1" }, { sessionId: "s1" }];
    expect(wrappers[0]).not.toBe(wrappers[1]); life.activate("s1"); expect(life.isCurrent(old.generation, old.identity)).toBe(true);
    life.invalidate("tree navigation"); expect(life.isCurrent(old.generation, old.identity)).toBe(false); expect(old.signal.aborted).toBe(true);
  });
});
