# Release Operations and Verification

This document details the release processes, verified published packages, GitHub Actions workflows, and trusted publishing configurations for the repository.

---

## Published Packages Status

| Package | Workspace Path | Latest npm Version | Release Status | Distribution Mechanism |
|---|---|---|---|---|
| `pi-translate-x` | `.` (monorepo root) | `0.1.3` | **Published** | Automated via `.github/workflows/publish.yml` (OIDC Provenance) |
| `pi-ask-user-x` | `packages/ask-user` | `0.1.2` | **Published** | Automated via `.github/workflows/publish-ask-user.yml` (OIDC Provenance); `0.1.0` was a manual bootstrap |

### Verified Release Evidence

- **`pi-translate-x@0.1.3`**:
  - GitHub Release: [`v0.1.3`](https://github.com/dogalyir/pi-translate-x/releases/tag/v0.1.3)
  - CI Workflow run: `40629831032` (passed)
  - Publish Workflow run: `40629946624` (passed via GitHub Actions OIDC trusted publishing with provenance)
  - Published tarball: `pi-translate-x-0.1.3.tgz`

- **`pi-ask-user-x@0.1.0`**:
  - Public npm release: `0.1.0` (manual initial bootstrap, owner `carmelocampos`, tool name `bilingual_questionnaire`)
  - Prepared version `0.1.1`: Renames model tool to `ask_user` with neutral label and description.
  - Note: Package immutability prevents republishing `0.1.0`. Future releases will use automated workflow `.github/workflows/publish-ask-user.yml`.
  - `0.1.1` was published by `publish-ask-user.yml` (run `40635156053`) with npm provenance, confirming trusted publishing is configured.

- **`pi-ask-user-x@0.1.2`**:
  - GitHub Release: [`pi-ask-user-x-v0.1.2`](https://github.com/dogalyir/pi-translate-x/releases/tag/pi-ask-user-x-v0.1.2)
  - Protocol-aware keyboard handling, fullscreen mouse support, translated UI chrome, accurate footer hints.

---

## Workflow Architectures

Both release workflows enforce least-privilege security settings, Node 24, npm 11.11.0, action commit SHA pinning, and environment-variable tag validation.

### 1. Root Translator Package (`publish.yml`)

- **File**: `.github/workflows/publish.yml`
- **Trigger**: GitHub Release published (`GHrelease.published`), non-draft, non-prerelease, with tag matching `v<major>.<minor>.<patch>` (e.g., `v0.1.3`).
- **Permissions**:
  - `contents: read`
  - `id-token: write`
- **Trusted Publisher Configuration (npm)**:
  - Repository: `dogalyir/pi-translate-x`
  - Workflow filename: `publish.yml`
  - Environment name: `npm`
- **Execution Steps**:
  1. Check out release tag commit.
  2. Pin npm to `11.11.0`.
  3. Run `npm ci` and `npm run check` (typecheck and tests).
  4. Run `npm run validate:package` with `RELEASE_TAG`.
  5. Pack tarball via `npm pack --json > pack.json`.
  6. Validate exact tarball closure via `scripts/validate-tarball.mjs`.
  7. Publish validated tarball with `--access public --provenance`.

### 2. Companion Questionnaire Package (`publish-ask-user.yml`)

- **File**: `.github/workflows/publish-ask-user.yml`
- **Trigger**: GitHub Release published (`GHrelease.published`), non-draft, non-prerelease, with tag matching `pi-ask-user-x-v<major>.<minor>.<patch>` (e.g., `pi-ask-user-x-v0.1.1`).
- **Permissions**:
  - `contents: read`
  - `id-token: write`
- **Trusted Publisher Configuration (npm)**:
  - Repository: `dogalyir/pi-translate-x`
  - Workflow filename: `publish-ask-user.yml`
  - Environment name: `npm`
  - *Status*: Confirmed (used to publish `0.1.1`).
- **Execution Steps**:
  1. Check out release tag commit.
  2. Pin npm to `11.11.0`.
  3. Run `npm ci` and `npm run check`.
  4. Run `node scripts/validate-ask-user-package.mjs` with `RELEASE_TAG`.
  5. Pack workspace tarball via `npm pack --workspace packages/ask-user --json > pack-ask-user.json`.
  6. Validate exact ask-user tarball closure via `scripts/validate-ask-user-tarball.mjs`.
  7. Publish validated tarball with `--access public --provenance`.

---

## Release Commands Reference

### Cutting a Root `pi-translate-x` Release

```sh
# 1. Ensure local tree is clean and checked
npm run check
npm run validate:package

# 2. Tag and push release tag
git tag v0.1.4
git push origin v0.1.4

# 3. Create published GitHub Release
gh release create v0.1.4 --title "v0.1.4" --notes "Release v0.1.4"
```

### Cutting a Companion `pi-ask-user-x` Release

```sh
# 1. Ensure local tree and ask-user checks pass
npm run check
node scripts/validate-ask-user-package.mjs

# 2. Tag and push release tag
git tag pi-ask-user-x-v0.1.1
git push origin pi-ask-user-x-v0.1.1

# 3. Create published GitHub Release
gh release create pi-ask-user-x-v0.1.1 --title "pi-ask-user-x v0.1.1" --notes "Release pi-ask-user-x v0.1.1"
```

---

## Validation Scripts

- `scripts/validate-package.mjs`: Verifies root `package.json`, allowlist files, absence of sensitive files/tests in tarball, and semver tag matching.
- `scripts/validate-tarball.mjs`: Validates the generated root `.tgz` against package metadata.
- `scripts/validate-ask-user-package.mjs`: Verifies `packages/ask-user/package.json`, workspace files, and tag format.
- `scripts/validate-ask-user-tarball.mjs`: Validates the generated `pi-ask-user-x` `.tgz` archive closure.
