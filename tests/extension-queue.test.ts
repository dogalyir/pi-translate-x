import { afterAll, describe, expect, it, vi } from "vitest";
import register from "../src/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-translate-queue-")); process.env.PI_CODING_AGENT_DIR = tmp;
writeFileSync(join(tmp, "pi-translate-x.json"), JSON.stringify({ version: 1, enabled: true, input: true, output: true, targetLanguage: "French", provider: "fake", model: "m", displayMode: "bilingual", timeoutMs: 5000 }));
function setup() {
  const events = new Map<string, Function>(); const pi = { on: (name: string, fn: Function) => { events.set(name, fn); return () => events.delete(name); }, registerEntryRenderer: () => {}, registerCommand: () => {}, appendEntry: vi.fn() } as unknown as ExtensionAPI;
  register(pi); return { events, pi };
}
const ctx = (id: string, branch: unknown[] = []) => ({ mode: "tui", hasUI: true, ui: { notify: vi.fn(), getEditorText: () => "active draft", setEditorText: vi.fn() }, sessionManager: { getHeader: () => ({ id, cwd: "/tmp", timestamp: "now" }), getBranch: () => branch } });

describe("input stale-arrival guards", () => {
  it("handles queued prose after session replacement without touching old editor or recording", async () => {
    const h = setup(); const start = h.events.get("session_start")!; const old = ctx("s1"); await start({ type: "session_start", reason: "startup" }, old);
    const pending = h.events.get("input")!({ type: "input", text: "Hola", source: "interactive" }, old);
    await start({ type: "session_start", reason: "new" }, ctx("s2"));
    await expect(pending).resolves.toEqual({ action: "handled" }); expect(old.ui.setEditorText).not.toHaveBeenCalled(); expect(h.pi.appendEntry).not.toHaveBeenCalled();
  });
  it("does not forward queued pure-code bypass into another session after navigation", async () => {
    const h = setup(); const start = h.events.get("session_start")!; const old = ctx("s1"); await start({ type: "session_start", reason: "startup" }, old);
    const pending = h.events.get("input")!({ type: "input", text: "```ts\nconst x = 1;\n```", source: "interactive" }, old);
    await h.events.get("session_tree")!({ type: "session_tree", newLeafId: "branch-2", oldLeafId: "branch-1" }, ctx("s1"));
    await expect(pending).resolves.toEqual({ action: "handled" }); expect(old.ui.setEditorText).not.toHaveBeenCalled();
  });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
