# Changelog

## 0.1.3 — Unreleased

- Show a transient namespaced TUI status while automatic or retry response translations are pending.
- Added versioned translation service (`TranslationService`, protocol v1 on `pi.events`) providing translation capabilities to companion workspace packages without duplicate model calls. Minimum translator `pi-translate-x@0.1.3` required for companion questionnaire translation service.
- Added companion workspace package `packages/ask-user` (`pi-ask-user-x@0.1.0`) implementing `bilingual_questionnaire` tool with responsive TUI layouts, single/multi/text question types, markdown previews, review tab, and submit-only session persistence. Prepared for manual first npm bootstrap; automated trusted publishing configured after initial publication.
- Fixed questionnaire TUI caching: compute `termRows` before cached return, cache both width and height, and reflow same-width terminal height changes (e.g. 24 -> 8 -> 4) without requiring manual `invalidate()`.
- Compacted early recovery and confirmation screens (`displayError`, `answerError`, `confirm_cancel`, `confirm_submit_full`, `confirm_submit_partial`) to render within bounded `termRows` down to height 1 and narrow widths (1, 3, 4, 6, 12) with safe ANSI truncation, preserving all action choices in discoverable short hints without slicing action lines, and supporting detail scrolling via Up/Down navigation.
- Verified recursive import closure for both root `pi-translate-x` and companion `pi-ask-user-x` tarballs.

## 0.1.2 — Published

- Align GitHub Actions on npm 11.11.0 for consistent optional native dependency installation before CI and release checks. No runtime behavior changes.

## 0.1.1 — Not published

- Release workflow stopped at test startup before package validation or publication because npm 11.5.1 omitted a Vitest/Rolldown native optional dependency.

## 0.1.0 — Published

- Initial cards-first Pi translation package; canonical English remains visible.
- Added fail-closed input pipeline, assistant translation and no-agent-rerun retry, context-excluded versioned session records, exact cache, bounded/cancellable scheduler, literal protection and explicit model setup.
- Translated-first ordinary-message rendering and canonical user-input entry linkage are deferred due to public Pi identity API limitations.
- Added release workflow and two-path public roadmap. No adapters/questionnaire implemented.
