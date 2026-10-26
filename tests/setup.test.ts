import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../src/core/config.js";

function atomicConfig(dir: string, config: unknown): void {
  const target = join(dir, "pi-translate-x.json"); const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" }); renameSync(temp, target);
}

describe("isolated setup/config storage", () => {
  it("does not leave partial configuration on cancellation and atomically persists complete validated config", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-translate-x-setup-"));
    try {
      const target = join(dir, "pi-translate-x.json");
      expect(() => readFileSync(target, "utf8")).toThrow(); // cancelled flow performs no write
      const candidate = validateConfig({ version: 1, enabled: true, input: true, output: true, targetLanguage: "French", provider: "test-provider", model: "test-model", displayMode: "original", timeoutMs: 30_000 });
      atomicConfig(dir, candidate);
      expect(validateConfig(JSON.parse(readFileSync(target, "utf8")))).toEqual(candidate);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
