import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const semver = require("semver");
const [manifestPath, tag] = process.argv.slice(2);
if (!manifestPath || !tag) throw new Error("Usage: validate-tarball <npm-pack-json> <release-tag>");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (tag !== `v${pkg.version}` || !semver.valid(tag.slice(1))) throw new Error(`Release tag ${tag} does not match package version ${pkg.version}`);
const filename = JSON.parse(readFileSync(manifestPath, "utf8"))[0]?.filename;
if (!filename) throw new Error("npm pack did not report a tarball filename");
const temp = mkdtempSync(join(tmpdir(), "pi-translate-x-tarball-"));
try {
  execFileSync("tar", ["-xzf", filename, "-C", temp]);
  const root = join(temp, "package");
  const extractedPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (extractedPkg.name !== pkg.name || extractedPkg.version !== pkg.version || extractedPkg.license !== "MIT") throw new Error("Tarball metadata differs from package metadata");
  const files = [];
  const walk = (dir) => { for (const item of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, item.name); if (item.isDirectory()) walk(full); else files.push(full.slice(root.length + 1).replaceAll("\\", "/")); } };
  walk(root);
  const required = ["LICENSE", "README.md", "ROADMAP.md", "CONTRIBUTING.md", "CHANGELOG.md", "config.example.json", "src/index.ts", "src/core/contracts.ts", "src/core/config.ts", "src/core/engine.ts", "src/core/lifecycle.ts", "src/core/protection.ts", "src/core/records.ts", "src/core/scheduler.ts"];
  for (const path of required) if (!files.includes(path)) throw new Error(`Tarball missing ${path}`);
  for (const path of files) if (/^(GOAL|PLAN)\.md$|^tests\//.test(path) || /(?:session|secret|\.env)/i.test(path)) throw new Error(`Forbidden tarball path: ${path}`);
  const entry = readFileSync(join(root, "src/index.ts"), "utf8");
  for (const match of entry.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const spec = match[1].replace(/^\.\//, "");
    const candidates = [join(root, "src", spec), join(root, "src", `${spec.replace(/\.js$/, "")}.ts`), join(root, "src", spec, "index.ts")];
    if (!candidates.some((path) => files.includes(path.slice(root.length + 1).replaceAll("\\", "/")))) throw new Error(`Unresolved entrypoint import: ${match[1]}`);
  }
  if (!extractedPkg.pi?.extensions?.includes("./src/index.ts")) throw new Error("Pi entrypoint invalid");
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`Verified tarball ${filename} matches ${tag}`);
