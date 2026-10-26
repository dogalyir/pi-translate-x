import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const configDir = mkdtempSync(join(tmpdir(), "pi-translate-render-")); process.env.PI_CODING_AGENT_DIR = configDir;
writeFileSync(join(configDir, "pi-translate-x.json"), JSON.stringify({ version: 1, enabled: true, input: true, output: true, targetLanguage: "Japanese", provider: "p", model: "m", displayMode: "bilingual", timeoutMs: 5000 }));
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRecord } from "../src/core/records.js";

async function setup() {
  vi.resetModules();
  const register = (await import("../src/index.js")).default;
  const renderers = new Map<string, Function>(); const handlers = new Map<string, Function>();
  const pi = { registerEntryRenderer: (name: string, render: Function) => renderers.set(name, render), on() {}, registerCommand: (name: string, command: any) => handlers.set(name, command.handler) } as unknown as ExtensionAPI;
  register(pi);
  return { renderers, handlers };
}
const theme = { bg: (_name: string, value: string) => value, fg: (_name: string, value: string) => value };

describe("registered durable card renderers", () => {
  afterAll(() => rmSync(configDir, { recursive: true, force: true }));
  it("validates schema and renders multiline/CJK card content at narrow and wide widths; original hides cards", async () => {
    const { renderers, handlers } = await setup();
    const input = createRecord({ kind: "input", sessionId: "s", branchId: "s", source: "こんにちは", original: "こんにちは", translated: "Hello", targetLanguage: "English", modelRef: "p/m", submissionId: "sub", inputDisposition: "prepared-for-input-pipeline" });
    const renderer = renderers.get("pi-translate-x:input")!;
    expect(renderer({ data: { ...input, version: 99 } }, { expanded: false }, theme)).toBeUndefined();
    const component = renderer({ data: input }, { expanded: false }, theme);
    expect(component).toBeDefined();
    for (const width of [20, 80]) for (const line of component!.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    const output = createRecord({ kind: "output", sessionId: "s", branchId: "s", messageEntryId: "assistant-id", source: "Hello", translated: "日本語の返答", targetLanguage: "Japanese", modelRef: "p/m" });
    const outComponent = renderers.get("pi-translate-x:output")!({ data: output }, { expanded: false }, theme);
    for (const width of [20, 80]) for (const line of outComponent!.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    await handlers.get("translate-x")!("view original", { mode: "tui", ui: { notify: vi.fn() } });
    expect(renderers.get("pi-translate-x:input")!({ data: input }, { expanded: false }, theme)).toBeUndefined();
    expect(renderers.get("pi-translate-x:output")!({ data: output }, { expanded: false }, theme)).toBeUndefined();
    await handlers.get("translate-x")!("view bilingual", { mode: "tui", ui: { notify: vi.fn() } });
    expect(renderers.get("pi-translate-x:input")!({ data: input }, { expanded: false }, theme)).toBeDefined();
  });
});
