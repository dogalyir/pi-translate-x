import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const semver = require("semver");
const [manifestPath, tag] = process.argv.slice(2);
if (!manifestPath || !tag) throw new Error("Usage: validate-tarball <npm-pack-json> <release-tag>");
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`Release tag ${tag} must match stable format v<major>.<minor>.<patch>`);
}
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = tag.slice(1);
if (!semver.valid(version) || semver.prerelease(version) !== null || tag !== `v${pkg.version}`) {
  throw new Error(`Release tag ${tag} does not match stable package version v${pkg.version}`);
}
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
  function validateImportClosure(pkgRoot, startFile, fileList) {
    const visited = new Set();
    const queue = [startFile];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      const content = readFileSync(join(pkgRoot, current), "utf8");
      const currentDir = current.split("/").slice(0, -1).join("/");
      for (const match of content.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
        const spec = match[1];
        const normalized = join(currentDir, spec).replaceAll("\\", "/");
        const candidates = [
          normalized,
          `${normalized}.ts`,
          `${normalized.replace(/\.js$/, "")}.ts`,
          `${normalized}/index.ts`,
        ];
        const matched = candidates.find((c) => fileList.includes(c));
        if (!matched) throw new Error(`Unresolved import "${spec}" in ${current}`);
        if (matched.endsWith(".ts") && !visited.has(matched)) {
          queue.push(matched);
        }
      }
    }
  }

  validateImportClosure(root, "src/index.ts", files);

  if (!extractedPkg.pi?.extensions?.includes("./src/index.ts")) throw new Error("Pi entrypoint invalid");
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`Verified tarball ${filename} matches ${tag}`);

// Validate companion package tarball import closure (packages/ask-user)
const askUserDir = join(new URL("..", import.meta.url).pathname, "packages/ask-user");
const askUserPkg = JSON.parse(readFileSync(join(askUserDir, "package.json"), "utf8"));
const askUserTemp = mkdtempSync(join(tmpdir(), "pi-ask-user-tarball-"));
try {
  const packJson = execFileSync("npm", ["pack", "--json"], { cwd: askUserDir, encoding: "utf8" });
  const askUserTarball = JSON.parse(packJson)[0]?.filename;
  if (!askUserTarball) throw new Error("ask-user pack did not produce tarball filename");
  const tarballPath = join(askUserDir, askUserTarball);
  try {
    execFileSync("tar", ["-xzf", tarballPath, "-C", askUserTemp]);
    const root = join(askUserTemp, "package");
    const extractedPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (extractedPkg.name !== askUserPkg.name || extractedPkg.version !== askUserPkg.version) {
      throw new Error("ask-user tarball metadata differs from package metadata");
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

    const required = ["LICENSE", "README.md", "src/index.ts"];
    for (const p of required) if (!files.includes(p)) throw new Error(`ask-user tarball missing ${p}`);

    const visited = new Set();
    const queue = ["src/index.ts"];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      const content = readFileSync(join(root, current), "utf8");
      const currentDir = current.split("/").slice(0, -1).join("/");
      for (const match of content.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
        const spec = match[1];
        const normalized = join(currentDir, spec).replaceAll("\\", "/");
        const candidates = [
          normalized,
          `${normalized}.ts`,
          `${normalized.replace(/\.js$/, "")}.ts`,
          `${normalized}/index.ts`,
        ];
        const matched = candidates.find((c) => files.includes(c));
        if (!matched) throw new Error(`Unresolved import "${spec}" in ask-user ${current}`);
        if (matched.endsWith(".ts") && !visited.has(matched)) {
          queue.push(matched);
        }
      }
    }
    console.log(`Verified companion ask-user tarball ${askUserTarball} import closure`);
  } finally {
    rmSync(tarballPath, { force: true });
  }
} finally {
  rmSync(askUserTemp, { recursive: true, force: true });
}
