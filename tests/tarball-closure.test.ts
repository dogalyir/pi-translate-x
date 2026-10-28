import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Tarball Import Closures", () => {
  function validatePackageClosure(pkgDir: string) {
    const temp = mkdtempSync(join(tmpdir(), "tarball-closure-test-"));
    try {
      const packJson = execFileSync("npm", ["pack", "--json"], { cwd: pkgDir, encoding: "utf8" });
      const tarballName = JSON.parse(packJson)[0]?.filename;
      expect(tarballName).toBeDefined();
      const tarballPath = join(pkgDir, tarballName);

      try {
        execFileSync("tar", ["-xzf", tarballPath, "-C", temp]);
        const root = join(temp, "package");
        const files: string[] = [];
        const walk = (dir: string) => {
          for (const item of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, item.name);
            if (item.isDirectory()) walk(full);
            else files.push(full.slice(root.length + 1).replaceAll("\\", "/"));
          }
        };
        walk(root);

        // Verify recursive import closure from src/index.ts
        const visited = new Set<string>();
        const queue = ["src/index.ts"];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (visited.has(current)) continue;
          visited.add(current);

          const content = readFileSync(join(root, current), "utf8");
          const currentDir = current.split("/").slice(0, -1).join("/");
          for (const match of content.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
            const spec = match[1]!;
            const normalized = join(currentDir, spec).replaceAll("\\", "/");
            const candidates = [
              normalized,
              `${normalized}.ts`,
              `${normalized.replace(/\.js$/, "")}.ts`,
              `${normalized}/index.ts`,
            ];
            const matched = candidates.find((c) => files.includes(c));
            expect(matched, `Unresolved import "${spec}" in ${current}`).toBeDefined();
            if (matched!.endsWith(".ts") && !visited.has(matched!)) {
              queue.push(matched!);
            }
          }
        }
      } finally {
        rmSync(tarballPath, { force: true });
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  it("verifies root pi-translate-x tarball contains complete recursive import closure", () => {
    validatePackageClosure(process.cwd());
  });

  it("verifies companion packages/ask-user tarball contains complete recursive import closure", () => {
    validatePackageClosure(join(process.cwd(), "packages/ask-user"));
  });
});
