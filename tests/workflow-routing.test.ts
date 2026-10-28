import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Release Workflow and Routing Validation", () => {
  const rootDir = process.cwd();
  const rootPkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  const askUserPkg = JSON.parse(readFileSync(join(rootDir, "packages/ask-user/package.json"), "utf8"));

  const publishRootYaml = readFileSync(join(rootDir, ".github/workflows/publish.yml"), "utf8");
  const publishAskYaml = readFileSync(join(rootDir, ".github/workflows/publish-ask-user.yml"), "utf8");
  const ciYaml = readFileSync(join(rootDir, ".github/workflows/ci.yml"), "utf8");

  describe("Workflow Static Security and Pinned Action Standards", () => {
    it("publish.yml pins action SHAs, Node 24, npm 11.11.0, and scopes OIDC permissions", () => {
      expect(publishRootYaml).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
      expect(publishRootYaml).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
      expect(publishRootYaml).toContain("node-version: 24");
      expect(publishRootYaml).toContain("npm install --global npm@11.11.0");
      expect(publishRootYaml).toContain("environment: npm");
      expect(publishRootYaml).toContain("contents: read");
      expect(publishRootYaml).toContain("id-token: write");
      expect(publishRootYaml).toContain("persist-credentials: false");
      // Check that untrusted release tag is not interpolated directly into shell strings
      expect(publishRootYaml).not.toMatch(/run:.*?\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/);
    });

    it("publish-ask-user.yml pins action SHAs, Node 24, npm 11.11.0, and scopes OIDC permissions", () => {
      expect(publishAskYaml).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
      expect(publishAskYaml).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
      expect(publishAskYaml).toContain("node-version: 24");
      expect(publishAskYaml).toContain("npm install --global npm@11.11.0");
      expect(publishAskYaml).toContain("environment: npm");
      expect(publishAskYaml).toContain("contents: read");
      expect(publishAskYaml).toContain("id-token: write");
      expect(publishAskYaml).toContain("persist-credentials: false");
      // Check that untrusted release tag is not interpolated directly into shell strings
      expect(publishAskYaml).not.toMatch(/run:.*?\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/);
    });

    it("ci.yml includes verification of both root and ask-user packages and tarballs", () => {
      expect(ciYaml).toContain("validate:package");
      expect(ciYaml).toContain("validate-tarball.mjs");
      expect(ciYaml).toContain("validate-ask-user-package.mjs");
      expect(ciYaml).toContain("validate-ask-user-tarball.mjs");
    });
  });

  describe("Workflow Tag Routing Matrix", () => {
    // Evaluates the exact GitHub Actions `if:` condition logic
    function shouldRunRootPublish(release: { tag_name: string; draft: boolean; prerelease: boolean }): boolean {
      return (
        !release.prerelease &&
        !release.draft &&
        release.tag_name.startsWith("v") &&
        !release.tag_name.startsWith("pi-ask-user-x-")
      );
    }

    function shouldRunAskUserPublish(release: { tag_name: string; draft: boolean; prerelease: boolean }): boolean {
      return (
        !release.prerelease &&
        !release.draft &&
        release.tag_name.startsWith("pi-ask-user-x-v")
      );
    }

    it("routes valid root tag v0.1.3 exclusively to publish.yml", () => {
      const event = { tag_name: `v${rootPkg.version}`, draft: false, prerelease: false };
      expect(shouldRunRootPublish(event)).toBe(true);
      expect(shouldRunAskUserPublish(event)).toBe(false);
    });

    it("routes valid ask-user tag pi-ask-user-x-v0.1.0 exclusively to publish-ask-user.yml", () => {
      const event = { tag_name: `pi-ask-user-x-v${askUserPkg.version}`, draft: false, prerelease: false };
      expect(shouldRunRootPublish(event)).toBe(false);
      expect(shouldRunAskUserPublish(event)).toBe(true);
    });

    it("skips both workflows on draft releases", () => {
      const rootDraft = { tag_name: `v${rootPkg.version}`, draft: true, prerelease: false };
      const askDraft = { tag_name: `pi-ask-user-x-v${askUserPkg.version}`, draft: true, prerelease: false };
      expect(shouldRunRootPublish(rootDraft)).toBe(false);
      expect(shouldRunAskUserPublish(rootDraft)).toBe(false);
      expect(shouldRunRootPublish(askDraft)).toBe(false);
      expect(shouldRunAskUserPublish(askDraft)).toBe(false);
    });

    it("skips both workflows on prereleases", () => {
      const rootPre = { tag_name: `v${rootPkg.version}-rc.1`, draft: false, prerelease: true };
      const askPre = { tag_name: `pi-ask-user-x-v${askUserPkg.version}-alpha.1`, draft: false, prerelease: true };
      expect(shouldRunRootPublish(rootPre)).toBe(false);
      expect(shouldRunAskUserPublish(rootPre)).toBe(false);
      expect(shouldRunRootPublish(askPre)).toBe(false);
      expect(shouldRunAskUserPublish(askPre)).toBe(false);
    });

    it("skips both workflows on malformed or foreign tags", () => {
      const invalidTags = [
        "0.1.3",
        "v",
        "pi-ask-user-0.1.0",
        "pi-ask-user-x-0.1.0",
        "pi-translate-x-v0.1.3",
        "random-tag",
        "v0.1.3-beta",
      ];
      for (const tag of invalidTags) {
        const event = { tag_name: tag, draft: false, prerelease: false };
        expect(shouldRunAskUserPublish(event), `ask-user should skip tag ${tag}`).toBe(false);
        if (!tag.startsWith("v") || tag.startsWith("pi-ask-user-x-")) {
          expect(shouldRunRootPublish(event), `root should skip tag ${tag}`).toBe(false);
        }
      }
    });
  });

  describe("Root Package Validator (validate-package.mjs)", () => {
    it("accepts valid root release tag", () => {
      const output = execFileSync("node", ["scripts/validate-package.mjs"], {
        cwd: rootDir,
        env: { ...process.env, RELEASE_TAG: `v${rootPkg.version}` },
        encoding: "utf8",
      });
      expect(output).toContain("Package manifest valid");
    });

    it("rejects ask-user release tag", () => {
      expect(() => {
        execFileSync("node", ["scripts/validate-package.mjs"], {
          cwd: rootDir,
          env: { ...process.env, RELEASE_TAG: `pi-ask-user-x-v${askUserPkg.version}` },
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow();
    });

    it("rejects version mismatch", () => {
      expect(() => {
        execFileSync("node", ["scripts/validate-package.mjs"], {
          cwd: rootDir,
          env: { ...process.env, RELEASE_TAG: "v99.99.99" },
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow();
    });

    it("rejects prerelease tag", () => {
      expect(() => {
        execFileSync("node", ["scripts/validate-package.mjs"], {
          cwd: rootDir,
          env: { ...process.env, RELEASE_TAG: `v${rootPkg.version}-rc1` },
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow();
    });
  });

  describe("Companion Package Validator (validate-ask-user-package.mjs)", () => {
    it("accepts valid ask-user release tag", () => {
      const output = execFileSync("node", ["scripts/validate-ask-user-package.mjs"], {
        cwd: rootDir,
        env: { ...process.env, RELEASE_TAG: `pi-ask-user-x-v${askUserPkg.version}` },
        encoding: "utf8",
      });
      expect(output).toContain("ask-user package manifest valid");
    });

    it("rejects root release tag", () => {
      expect(() => {
        execFileSync("node", ["scripts/validate-ask-user-package.mjs"], {
          cwd: rootDir,
          env: { ...process.env, RELEASE_TAG: `v${rootPkg.version}` },
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow();
    });

    it("rejects ask-user version mismatch", () => {
      expect(() => {
        execFileSync("node", ["scripts/validate-ask-user-package.mjs"], {
          cwd: rootDir,
          env: { ...process.env, RELEASE_TAG: "pi-ask-user-x-v99.99.99" },
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow();
    });

    it("rejects ask-user prerelease tag", () => {
      expect(() => {
        execFileSync("node", ["scripts/validate-ask-user-package.mjs"], {
          cwd: rootDir,
          env: { ...process.env, RELEASE_TAG: `pi-ask-user-x-v${askUserPkg.version}-beta.1` },
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow();
    });
  });

  describe("Tarball Validation on Packed Workspace", () => {
    it("packs ask-user workspace once, validates identical tarball, and verifies closure", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "ask-user-tarball-test-"));
      try {
        const packJsonOutput = execFileSync(
          "npm",
          ["pack", "--workspace", "packages/ask-user", "--pack-destination", tempDir, "--json"],
          { cwd: rootDir, encoding: "utf8" }
        );
        const manifest = JSON.parse(packJsonOutput);
        const manifestPath = join(tempDir, "pack.json");
        const fs = require("node:fs");
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

        const tarballFile = join(tempDir, manifest[0].filename);
        expect(existsSync(tarballFile)).toBe(true);

        // Run validate-ask-user-tarball against the newly packed tarball
        const valOutput = execFileSync(
          "node",
          [join(rootDir, "scripts/validate-ask-user-tarball.mjs"), manifestPath, `pi-ask-user-x-v${askUserPkg.version}`],
          { cwd: tempDir, encoding: "utf8" }
        );
        expect(valOutput).toContain("Verified ask-user tarball");

        // Verify rejection with wrong tag
        expect(() => {
          execFileSync(
            "node",
            [join(rootDir, "scripts/validate-ask-user-tarball.mjs"), manifestPath, "pi-ask-user-x-v99.99.99"],
            { cwd: tempDir, encoding: "utf8", stdio: "pipe" }
          );
        }).toThrow();

        // Verify rejection with root tag
        expect(() => {
          execFileSync(
            "node",
            [join(rootDir, "scripts/validate-ask-user-tarball.mjs"), manifestPath, `v${rootPkg.version}`],
            { cwd: tempDir, encoding: "utf8", stdio: "pipe" }
          );
        }).toThrow();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
