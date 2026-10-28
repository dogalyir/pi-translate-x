import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const semver = require("semver");
const askUserDir = join(new URL("..", import.meta.url).pathname, "packages/ask-user");
const pkg = JSON.parse(readFileSync(join(askUserDir, "package.json"), "utf8"));

if (pkg.name !== "pi-ask-user-x") throw new Error(`Unexpected package name: ${pkg.name}`);
if (pkg.repository?.url !== "https://github.com/dogalyir/pi-translate-x.git" || pkg.repository?.directory !== "packages/ask-user") {
  throw new Error("Repository metadata does not match packages/ask-user in public repository");
}
if (pkg.license !== "MIT") throw new Error("Expected approved MIT license");
if (pkg.publishConfig?.access !== "public" || pkg.publishConfig?.provenance !== true) {
  throw new Error("Public npm provenance publishConfig required");
}
if (!pkg.pi?.extensions?.includes("./src/index.ts")) {
  throw new Error("Pi extension entrypoint missing in pi.extensions");
}
for (const hostPackage of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
  if (pkg.peerDependencies?.[hostPackage] !== "*") throw new Error(`Host package must be a * peer dependency: ${hostPackage}`);
  if (pkg.dependencies?.[hostPackage]) throw new Error(`Host package must not be bundled as runtime dependency: ${hostPackage}`);
}

const tag = process.env.RELEASE_TAG;
if (tag !== undefined) {
  const match = /^pi-ask-user-x-v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) {
    throw new Error(`Release tag must match stable pi-ask-user-x-v<major>.<minor>.<patch>, got "${tag}"`);
  }
  const version = match[1];
  if (!semver.valid(version) || semver.prerelease(version) !== null || version !== pkg.version) {
    throw new Error(`Release tag ${tag} does not match stable package version pi-ask-user-x-v${pkg.version}`);
  }
}

const packJson = execFileSync("npm", ["pack", "--workspace", "packages/ask-user", "--dry-run", "--json"], { encoding: "utf8" });
const packed = JSON.parse(packJson)[0]?.files?.map((f) => f.path) ?? [];
const required = [
  "package.json",
  "LICENSE",
  "README.md",
  "src/index.ts",
  "src/domain/chrome.ts",
  "src/domain/projection.ts",
  "src/domain/state.ts",
  "src/persistence/record.ts",
  "src/rpc/flow.ts",
  "src/service/client.ts",
  "src/service/protocol.ts",
  "src/tool/schema.ts",
  "src/ui/questionnaire-tui.ts",
  "src/ui/queue.ts",
  "src/ui/renderer.ts",
];
for (const file of required) {
  if (!packed.includes(file)) throw new Error(`Required ask-user package file missing: ${file}`);
}
for (const file of packed) {
  if (/^(GOAL|PLAN)\.md$|^tests\/|\.test\.ts$|\.spec\.ts$/.test(file) || /(?:session|secret|\.env)/i.test(file)) {
    throw new Error(`Unexpected sensitive/internal/test file in tarball: ${file}`);
  }
}

console.log(`ask-user package manifest valid (${packed.length} files); version ${pkg.version}`);
