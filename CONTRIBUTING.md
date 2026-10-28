# Contributing

Contributions are welcome, especially reproducible API research, deterministic tests, documentation, and improvements to the translation core or companion questionnaire workspace.

## Repository and workspace structure

The repository is organized as an npm workspace containing:
- **`pi-translate-x` (root package)**: The publishable translation package providing user/assistant cards-first translation and the versioned event-bus translation service (`TranslationService`, protocol v1).
- **`packages/ask-user` (`pi-ask-user-x`)**: A companion extension providing the `bilingual_questionnaire` tool. When loaded alongside `pi-translate-x` (>=0.1.3), it consumes translation services over `pi.events`. When loaded standalone, it runs in canonical English. Prepared for initial manual npm bootstrap.

The project does **not** use or adapt external rpiv adapters (`@juicesharp/rpiv-ask-user-question`). The built-in `ask_user_question` tool is **never intercepted or monkey-patched**. Agents and users choose `bilingual_questionnaire` explicitly without global mutations.

## Core and security boundaries

Use the versioned contracts/records in `src/core` and `src/service`. Preserve exact source/cache identity and session/branch isolation. Do not add blanket tool-string rewriting, hidden network services, main-model fallback, secrets, live paid calls in tests, or text-keyed original maps. Treat all model-returned translation as untrusted content. Keep failure paths fail-closed and do not overwrite active editor drafts.

Tests should use deterministic fake translators; never make live external paid calls. Host integrations need separate public-API harness evidence; visual UI claims require actual terminal verification. Automated tests do not constitute assistive technology (AT) or hardware terminal verification. Document privacy/cost and distinguish proposed, prototyped, host-tested, and visually verified support. Avoid promising unverified Pi versions without evidence.
