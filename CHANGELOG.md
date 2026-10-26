# Changelog

## 0.1.2 — Unreleased

- Align GitHub Actions on npm 11.11.0 for consistent optional native dependency installation before CI and release checks. No runtime behavior changes.

## 0.1.1 — Not published

- Release workflow stopped at test startup before package validation or publication because npm 11.5.1 omitted a Vitest/Rolldown native optional dependency.

## 0.1.0 — Published

- Initial cards-first Pi translation package; canonical English remains visible.
- Added fail-closed input pipeline, assistant translation and no-agent-rerun retry, context-excluded versioned session records, exact cache, bounded/cancellable scheduler, literal protection and explicit model setup.
- Translated-first ordinary-message rendering and canonical user-input entry linkage are deferred due to public Pi identity API limitations.
- Added release workflow and two-path public roadmap. No adapters/questionnaire implemented.
