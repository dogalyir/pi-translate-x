# Roadmap

This roadmap records possibilities, not commitments or dates. Current release scope is **cards-first**: canonical English remains visible; bilingual shows persisted translation/original cards and original mode hides them. Translated-first ordinary-message replacement is deferred due to missing public identity-aware Pi rendering APIs.

## Phase 1 — Core and cards-first package

Status: core implemented; orchestrator accepted the implementation milestone for controlled manual validation. Local automated checks passed (strict TypeScript check, 33 tests across 10 files, and 15-file package allowlist validation). This is not full production acceptance or release approval. Manual TUI/live-provider acceptance, first CI run, and npm trusted publisher/first-package setup remain pending. No adapter or first-party questionnaire implementation.

Automated evidence covers exact literal preservation, input FIFO and recovery, branch/lifecycle and settings cancellation, cached resume, context exclusion, ordered outputs, registered renderer modes/widths, and package allowlist validation. Remaining acceptance: manual TUI visual and live-provider validation, first CI execution, and setup-success timing through an actually completed UI interaction (the current success fixture manually resolves the custom UI screen). Host gaps are documented, not papered over. Release risks include inherited pinned Pi/undici development dependency audit findings, cards-first limitation from missing public ordinary-message identity rendering, and possible transcript redraw/reload after view changes.

## Two public interaction paths (decision pending evidence)

### Path A — Integration-first; contributors build adapters

Prefer safe integration with existing question/interaction extensions and invite adapter contributors. First candidate for research: [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question). Candidate status is **proposed / not verified**; no compatibility is claimed.

Before accepting an adapter, require evidence for:
- Stable, public hooks and supported host/package version range.
- Exact question/option identity preserved end-to-end; never translate values/options in a way that back-translates a selected answer incorrectly.
- English model-facing tool arguments/results; translation of questions, descriptions, previews and prose while protecting code/literals.
- Custom answers and per-question/global notes translated safely; cancel, partial response, multi-select and validation semantics unchanged.
- Fail-closed recovery, no stale async updates, correct persistence/branch behavior, and no history retranslation on resume.
- Deterministic adapter tests and host-level integration tests; privacy and threat-model review.

Decision gate: investigate public APIs and upstream cooperation first. If integration is unsafe or disproportionately complex, record concrete blockers and evaluate Path B with maintainers/users; do not assume unknown Pi APIs will be added.

### Path B — First-party bilingual question interaction

Only consider if Path A cannot be integrated safely and after documenting why. Reuse the translation core, preserve question/selection/cancel/partial/multiselect semantics, design collision-safe tool naming and migration, and avoid recreating unrelated workflow systems. This is not approved implementation scope yet.

## Later host capability

A supported ordinary-message renderer exposing stable entry identity could enable translated-first user/assistant views without mutating canonical messages. Any upstream API proposal is separate work, versioned, publicly supported, and tested for redraw/streaming/export/branch behavior. Until then translated-first remains unsupported.

## Candidate support matrix

| Candidate | Status | Evidence |
|---|---|---|
| Pi ordinary-message identity renderer | blocked / proposed upstream capability | Installed current type declarations expose Markdown transformer without message ID and custom renderers only for custom entries/messages; versions must be rechecked before claiming support. |
| `@juicesharp/rpiv-ask-user-question` | proposed / research not complete | No compatibility or behavior verified yet. |

## Release milestones

- CI validates install, typecheck, tests and package allowlist on pushes/PRs.
- Stable GitHub Release triggers the guarded npm workflow; prereleases/drafts cannot publish.
- Configure npm trusted publishing for exact GitHub owner/repository/workflow/environment and complete any npm first-package bootstrap by owner action. Workflow prepared does not mean trust configured or a release verified.
- First actual public release requires separate explicit approval.
