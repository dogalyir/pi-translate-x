# Contributing

Contributions are welcome, especially reproducible API research, deterministic tests, documentation, and improvements to the translation core or companion questionnaire workspace.

## Repository & Workspace Structure

The repository is organized as an npm workspace containing:
- **`pi-translate-x` (root package)**: The core translation package (`pi-translate-x@0.1.3`) providing user/assistant cards-first translation and the versioned event-bus translation service (`TranslationService`, protocol v1 over `pi.events`).
- **`packages/ask-user` (`pi-ask-user-x`)**: A companion extension (`pi-ask-user-x@0.1.1` prepared; `0.1.0` published) providing the `ask_user` tool. When loaded alongside `pi-translate-x` (>=0.1.3), it consumes translation services over `pi.events`. When loaded standalone, it operates in canonical English.

The project does **not** adapt external third-party adapters (`@juicesharp/rpiv-ask-user-question`). The separate `ask_user_question` plugin is **never intercepted or monkey-patched**. Agents invoke `ask_user` explicitly without global mutations.

## Core & Security Boundaries

- **Versioned Contracts**: Use versioned records and protocols in `src/core` and `src/service`. Preserve exact source/cache identity and session/branch isolation.
- **Fail-Closed Guarantees**: When input translation is configured and enabled, untranslated human prose must never be submitted to the main agent if translation fails or aborts. Keep failure paths fail-closed (halting submission and prepending to the editor draft) without overwriting active editor drafts. Note that unconfigured or disabled states bypass input directly.
- **Zero Fallback & No Secrets**: Do not add blanket tool-string rewriting, hidden network services, main-model fallback, or secrets. Treat all model-returned translation as untrusted content.
- **Context Exclusion**: Translation cards and questionnaire transcript records are sensitive and must remain excluded from LLM context injection (`customType` entries).
- **Deterministic Testing**: Tests must use deterministic fake translators; never make live external paid calls in tests.
- **Verification Accuracy**: Automated Vitest assertions do not constitute hardware terminal or assistive technology (AT) verification. Visual UI claims require actual terminal verification. Document privacy/cost accurately.

## Validation Commands

Before submitting pull requests, run local checks:

```sh
npm ci
npm run check              # TypeScript check and unit/integration tests
npm run validate:package   # Package manifest allowlist and tarball closure
node scripts/validate-ask-user-package.mjs  # Ask-user package validation
```
