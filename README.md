# pi-translate-x

Pi translation package. Intended flow: write in a chosen language, translate human prose to English for the main model, and persist translated input/output as cards. Translation is a separate model call and consumes tokens. No savings, zero-cost, perfect-fidelity, or all-context-English claims. Tool/file context is not translated wholesale.

## Install and setup

Once published: `pi install npm:pi-translate-x`. For a safe local trial from this checkout: `pi --extension ./src/index.ts --no-extensions`; the package is inert until configured and uses user-level config. Do not enable alongside the legacy global bilingual extension.

`/translate-x setup` (TUI only) asks for target language, exact available/authenticated provider/model, card visibility, and runs a cancellable test. Incomplete/cancelled setup is not saved. No default model or fallback to the main model/other providers. Runtime config path: `getAgentDir()/pi-translate-x.json`; `config.example.json` is illustrative. Malformed configuration disables translation. Credentials are not stored.

Commands: `/translate-x status`, `/translate-x on|off`, `/translate-x input on|off`, `/translate-x output on|off`, `/translate-x view original|bilingual`, `/translate-x retry [assistant-entry-id]`. Disabled mode means translation guarantees do not apply.

## Cards-first presentation

Canonical English messages remain visible. `bilingual` shows separate persisted cards; `original` hides cards and **does not** replace canonical English with translated text. Translated-first ordinary-message replacement and canonical user-bubble restoration are deferred because current Pi public render hooks lack ordinary-message identity.

Input cards have unique submission IDs and hold original + prepared English. Semantics: “prepared for input pipeline”; not proof that Pi persisted/delivered the canonical user message, and never linked by matching text/images. Assistant cards are linked to the actual assistant entry ID. Cards are session-persisted, sensitive custom entries excluded from model context. Old history is not backfilled; branch cache rebuild uses active branch records.

## Behavior and limits

- Input translation is fail-closed; untranslated prose is not submitted. Preserve images, extension-originated messages, slash commands, shell/code/literals; input submissions serialize across cached, untranslated and failure paths.
- Failed input recovery does not overwrite newer drafts; TUI attempts exact restoration. RPC/headless reports failure without claiming editor restoration.
- Output translates assistant human-facing prose only; canonical English remains unchanged/available. In TUI, pending automatic/retry translations show a transient status (`Translating response…`); visibility is controlled by the footer (via `ctx.ui.setStatus()`), and it clears when work ends or is invalidated, without replacing the footer. Output calls are bounded/background; failures preserve English. `/translate-x retry` re-translates a saved assistant response without rerunning the agent, using the currently configured provider/model/language (not necessarily the settings used for its prior card), only if its exact assistant entry remains on the active branch. A successful retry appends a new card and refreshes the cache for those current settings; the earlier card remains in history.
- Literal masking is best-effort, not perfect semantic fidelity or a guarantee all code stays on-device.

## Modes

| Mode | Behavior |
|---|---|
| TUI | Setup/status/on-off/input-output/view/retry; canonical English plus cards. Card visibility is read at render time; a Pi transcript redraw/reload may be required after changing view. |
| Print / JSON | No setup prompt; configured input can translate safely; output stays canonical English. |
| RPC | No custom terminal components; supported dialogs/notifications only. |

Local development evidence is from installed `@earendil-works/pi-coding-agent` 1.4.0 and Node 24; Node 22 has not been tested in this project. This is not a broad compatibility claim. Manual TUI/live-provider acceptance and the first CI run remain pending; TUI has not been visually verified. Release risks include inherited pinned Pi/undici development dependency audit findings, the cards-first host limitation from missing public ordinary-message identity rendering, and possible transcript redraw/reload after view changes. The setup-success test fixture manually resolves its custom UI screen, so it does not fully validate real UI/provider-success timing.

## Companion Extension: pi-ask-user-x

The workspace includes the companion questionnaire extension under `packages/ask-user` (`pi-ask-user-x`, published on npm). When loaded alongside `pi-translate-x` (minimum version `0.1.3`), it provides the `bilingual_questionnaire` tool using the shared event bus (`pi.events`) versioned translation service protocol (`TranslationService`, protocol v1) without creating duplicate translators. When `pi-translate-x` is absent or disabled, `pi-ask-user-x` runs standalone in canonical English.

The existing `ask_user_question` tool is **not intercepted**, patched, or globally mutated; agents choose `bilingual_questionnaire` explicitly or through prompt/system guidance manually without global state modifications.

Installation from npm:
```sh
# Install companion questionnaire package:
pi install npm:pi-ask-user-x

# Install translator package (minimum 0.1.3 required for bilingual questionnaire integration):
pi install npm:pi-translate-x
```

For local development or testing both extensions simultaneously from checkout without loading global duplicates:
```sh
pi --no-extensions --extension ./src/index.ts --extension ./packages/ask-user/src/index.ts
```

- **Submitted only**: Only submitted questionnaires and answers are persisted to session transcripts (context-excluded). Drafts and cancelled flows are not written to transcript history. Persisted records are static; translator setting changes do not trigger retranslation.
- **RPC preview degradation**: Full terminal markdown previews degrade to text/token hints in RPC mode.
- **Release status**: `pi-ask-user-x` (`0.1.0`) is published on npm. Future releases are automated via `.github/workflows/publish-ask-user.yml` on published GitHub releases with tag `pi-ask-user-x-v<version>`. Root `pi-translate-x` (`0.1.3`) release is prepared for automated deployment via `.github/workflows/publish.yml` on published GitHub releases with tag `v<version>`.
- **Verification bounds**: Automated tests use deterministic mocks; no manual assistive technology (AT), hardware cursor, screen-reader, or live terminal/provider verification is claimed.

## Roadmap and contributing

See [ROADMAP.md](ROADMAP.md) and [packages/ask-user/README.md](packages/ask-user/README.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy and legacy migration

Legacy global plugin/config are untouched. Disable old extension before enabling this one. Session originals/translations are sensitive and persisted intentionally. Requests send source prose and unmasked content to the configured provider; review provider privacy terms. No new translation service is bundled.

## Development and validation

```sh
npm ci
npm run check
npm run validate:package
npm pack --dry-run
```

Tests use deterministic fakes; no paid calls. Visual checklist: narrow/wide width, CJK, resize/theme, regular/fullscreen, streaming, reload/resume/branch/fork, view changes and recovery.

## Release automation

`.github/workflows/ci.yml` is read-only on push/PR, validating both root and ask-user package manifests and tarballs.

Publishing uses GitHub Actions OIDC trusted publishing triggered exclusively by published GitHub Releases (`GHrelease.published`, not tag push `tagpush`). Draft and prerelease releases are strictly excluded.

### Workflows and Trusted Publishing Configuration

1. **Translator package (`pi-translate-x`)**:
   - Workflow: `.github/workflows/publish.yml`
   - Trigger: GitHub Release published with exact stable tag `v<rootversion>` (e.g. `v0.1.3`).
   - npm trusted publisher configuration:
     - GitHub repository: `dogalyir/pi-translate-x`
     - Workflow name: `publish.yml`
     - Environment name: `npm`
   - Tag & Release commands:
     ```sh
     git tag v0.1.3
     git push origin v0.1.3
     gh release create v0.1.3 --title "v0.1.3" --notes "Release v0.1.3"
     ```

2. **Questionnaire package (`pi-ask-user-x`)**:
   - Workflow: `.github/workflows/publish-ask-user.yml`
   - Trigger: GitHub Release published with exact stable tag `pi-ask-user-x-v<packageversion>` (e.g. `pi-ask-user-x-v0.1.1` for future releases).
   - npm trusted publisher configuration:
     - GitHub repository: `dogalyir/pi-translate-x`
     - Workflow name: `publish-ask-user.yml`
     - Environment name: `npm`
     - *Note*: Do not configure the trusted publisher in the npm owner UI until the user confirms. Version 0.1.0 is already published manually and cannot be republished.
   - Tag & Release commands (for future releases):
     ```sh
     git tag pi-ask-user-x-v0.1.1
     git push origin pi-ask-user-x-v0.1.1
     gh release create pi-ask-user-x-v0.1.1 --title "pi-ask-user-x v0.1.1" --notes "Release pi-ask-user-x v0.1.1"
     ```

Both workflows run with scoped least-privilege permissions (`contents: read`, `id-token: write`), Node 24, npm 11.11.0, action SHA pinning, tag validation via environment variables without shell interpolation, single workspace packing, tarball verification for identity, version, PI entry, allowlist, absence of secrets/tests, and complete import closure, publishing the exact verified tarball with `--access public --provenance`.

Repository: [dogalyir/pi-translate-x](https://github.com/dogalyir/pi-translate-x). MIT; Copyright (c) 2026 dogalyir contributors.
