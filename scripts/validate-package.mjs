import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync as readFile } from "node:fs";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.name !== "pi-translate-x") throw new Error(`Unexpected package name: ${pkg.name}`);
if (pkg.repository?.url !== "https://github.com/dogalyir/pi-translate-x.git") throw new Error("Repository metadata does not match the public repository");
if (pkg.license !== "MIT") throw new Error("Expected approved MIT license");
if (pkg.publishConfig?.access !== "public" || pkg.publishConfig?.provenance !== true) throw new Error("Public npm provenance publishConfig required");
if (!pkg.pi?.extensions?.includes("./src/index.ts")) throw new Error("Pi extension entrypoint missing");
for (const hostPackage of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
  if (pkg.peerDependencies?.[hostPackage] !== "*") throw new Error(`Host package must be a * peer dependency: ${hostPackage}`);
  if (pkg.dependencies?.[hostPackage]) throw new Error(`Host package must not be bundled as runtime dependency: ${hostPackage}`);
}
const tag = process.env.RELEASE_TAG;
if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error(`Release tag ${tag} does not match package version v${pkg.version}`);
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }))[0]?.files?.map((f) => f.path) ?? [];
const required = ["package.json", "LICENSE", "README.md", "CHANGELOG.md", "config.example.json", "ROADMAP.md", "CONTRIBUTING.md", "src/index.ts", "src/core/contracts.ts", "src/core/config.ts", "src/core/engine.ts", "src/core/lifecycle.ts", "src/core/protection.ts", "src/core/records.ts", "src/core/scheduler.ts"];
for (const file of required) if (!packed.includes(file)) throw new Error(`Required package file missing: ${file}`);
for (const file of packed) if (/^(GOAL|PLAN)\.md$|^tests\//.test(file) || /(?:session|secret|\.env)/i.test(file)) throw new Error(`Unexpected sensitive/internal file in tarball: ${file}`);
if (tag !== undefined) {
  const version = tag.slice(1);
  const semver = require("semver");
  if (!semver.valid(version) || version !== pkg.version) throw new Error("Release tag must be v<exact package.json semver>");
}
console.log(`Package manifest valid (${packed.length} files); version ${pkg.version}`);
