# Roadmap

This roadmap records possibilities, not commitments or dates. Current release scope is **cards-first**: canonical English remains visible; bilingual shows persisted translation/original cards and original mode hides them. Translated-first ordinary-message replacement is deferred due to missing public identity-aware Pi rendering APIs.

## Phase 1 — Core translation and companion questionnaire workspace

Status: translation core and companion questionnaire implemented in monorepo workspace. Root package `pi-translate-x` (version `0.1.3`) is prepared for automated release. Companion questionnaire extension `packages/ask-user` (`pi-ask-user-x@0.1.0`) is prepared for manual initial npm bootstrap, with automated trusted publishing to follow once the package exists on npm.

Automated evidence covers exact literal preservation, input FIFO and recovery, branch/lifecycle and settings cancellation, cached resume, context exclusion, ordered outputs, registered renderer modes/widths, translation service protocol over `pi.events`, companion questionnaire TUI layout reflow (including SAME-width height resize and compact small-viewport dialogs), and recursive import closure validation for both packages. Remaining acceptance: manual TUI visual and live-provider validation, first CI execution, and setup-success timing through an actually completed UI interaction. Host gaps are documented, not papered over. Release risks include inherited pinned Pi/undici development dependency audit findings, cards-first limitation from missing public ordinary-message identity rendering, and possible transcript redraw/reload after view changes.

## Questionnaire interaction architecture

Rather than adapting external tools (e.g. `@juicesharp/rpiv-ask-user-question`, which was abandoned due to fragile third-party hooks and monkey-patching risks), the project implemented a first-party companion package `pi-ask-user-x` in `packages/ask-user`:
- **Clean Tool Separation**: Provides the `bilingual_questionnaire` tool without intercepting or mutating built-in `ask_user_question`. Agents choose `bilingual_questionnaire` explicitly or via manual guidance without global monkey-patching.
- **Event-Bus Translation Service**: Interacts with `pi-translate-x` via a versioned protocol (`protocolVersion: 1`) on `pi.events`, avoiding duplicate translator instances and maintaining strict fail-closed boundary isolation.
- **English-Canonical Contract**: Predefined question and option choices resolve strictly by stable, immutable string IDs; selections are never back-translated. Freeform custom prose and notes are reverse-translated to canonical English for the LLM.
- **Submit-Only Persistence**: Only confirmed, submitted questionnaires are written to session history (context-excluded). Cancelled flows and drafts remain in-memory and are never persisted.
- **TUI Responsiveness**: Dynamically reflows side-by-side, stacked, and compact layouts; calculates `termRows` before caching to reflow on same-width terminal height changes (e.g. 24 -> 8 -> 4); and compacts early error and confirmation screens down to height 1 while preserving all action keys and options without slicing.

## Later host capability

A supported ordinary-message renderer exposing stable entry identity could enable translated-first user/assistant views without mutating canonical messages. Any upstream API proposal is separate work, versioned, publicly supported, and tested for redraw/streaming/export/branch behavior. Until then translated-first remains unsupported.

## Support and integration matrix

| Capability / Package | Status | Evidence |
|---|---|---|
| Translation core (`pi-translate-x`) | implemented / publishable | Strict TypeScript checks, unit and integration suites, package allowlist validation, tarball import closure. Existing release automation retained. |
| Companion questionnaire (`pi-ask-user-x`) | implemented / unpublished workspace | Full TUI/RPC implementation, state machine, event-bus protocol v1, tarball closure. npm release deferred. |
| External rpiv adapter (`@juicesharp/rpiv-ask-user-question`) | abandoned / not pursued | Abandoned in favor of first-party event-bus protocol v1; avoids brittle monkey-patching of built-in question tools. |
| Pi ordinary-message identity renderer | blocked / proposed upstream capability | Current public type declarations expose Markdown transformer without message ID and custom renderers only for custom entries/messages. |

## Release milestones

- CI validates install, typecheck, tests and package allowlist on pushes/PRs.
- Stable GitHub Release triggers the guarded npm workflow; prereleases/drafts cannot publish.
- Configure npm trusted publishing for exact GitHub owner/repository/workflow/environment and complete any npm first-package bootstrap by owner action. Workflow prepared does not mean trust configured or a release verified.
- First actual public release requires separate explicit approval.
