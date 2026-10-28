import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const semver = require("semver");
const [manifestPath, tag] = process.argv.slice(2);
if (!manifestPath || !tag) throw new Error("Usage: validate-ask-user-tarball <npm-pack-json> <release-tag>");

const match = /^pi-ask-user-x-v(\d+\.\d+\.\d+)$/.exec(tag);
if (!match) {
  throw new Error(`Release tag must match stable pi-ask-user-x-v<major>.<minor>.<patch>, got "${tag}"`);
}
const version = match[1];

const askUserDir = join(new URL("..", import.meta.url).pathname, "packages/ask-user");
const pkg = JSON.parse(readFileSync(join(askUserDir, "package.json"), "utf8"));
if (!semver.valid(version) || semver.prerelease(version) !== null || version !== pkg.version) {
  throw new Error(`Release tag ${tag} does not match stable package version pi-ask-user-x-v${pkg.version}`);
}

const packData = JSON.parse(readFileSync(manifestPath, "utf8"))[0];
const filename = packData?.filename;
if (!filename) throw new Error("npm pack manifest did not report a tarball filename");
if (packData.name !== "pi-ask-user-x" || packData.version !== pkg.version) {
  throw new Error(`Pack manifest identity mismatch: expected pi-ask-user-x@${pkg.version}, got ${packData.name}@${packData.version}`);
}

const tarballPath = existsSync(filename) ? filename : join(askUserDir, filename);
if (!existsSync(tarballPath)) throw new Error(`Tarball file not found: ${filename}`);

const temp = mkdtempSync(join(tmpdir(), "pi-ask-user-tarball-val-"));
try {
  execFileSync("tar", ["-xzf", tarballPath, "-C", temp]);
  const root = join(temp, "package");
  const extractedPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (extractedPkg.name !== pkg.name || extractedPkg.version !== pkg.version || extractedPkg.license !== "MIT") {
    throw new Error("Tarball metadata differs from package metadata");
  }
  if (extractedPkg.publishConfig?.access !== "public" || extractedPkg.publishConfig?.provenance !== true) {
    throw new Error("Tarball publishConfig must specify public access and provenance");
  }
  if (!extractedPkg.pi?.extensions?.includes("./src/index.ts")) {
    throw new Error("Pi entrypoint invalid in tarball");
  }

  const files = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else files.push(full.slice(root.length + 1).replaceAll("\\", "/"));
    }
  };
  walk(root);

  const required = [
    "LICENSE",
    "README.md",
    "package.json",
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
  for (const path of required) {
    if (!files.includes(path)) throw new Error(`Tarball missing required file: ${path}`);
  }
  for (const path of files) {
    if (/^(GOAL|PLAN)\.md$|^tests\/|\.test\.ts$|\.spec\.ts$/i.test(path) || /(?:session|secret|\.env)/i.test(path)) {
      throw new Error(`Forbidden tarball path: ${path}`);
    }
  }

  const visited = new Set();
  const queue = ["src/index.ts"];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const content = readFileSync(join(root, current), "utf8");
    const currentDir = current.split("/").slice(0, -1).join("/");
    for (const m of content.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
      const spec = m[1];
      const normalized = join(currentDir, spec).replaceAll("\\", "/");
      const candidates = [
        normalized,
        `${normalized}.ts`,
        `${normalized.replace(/\.js$/, "")}.ts`,
        `${normalized}/index.ts`,
      ];
      const matched = candidates.find((c) => files.includes(c));
      if (!matched) throw new Error(`Unresolved import "${spec}" in ${current}`);
      if (matched.endsWith(".ts") && !visited.has(matched)) {
        queue.push(matched);
      }
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`Verified ask-user tarball ${filename} matches ${tag}`);
