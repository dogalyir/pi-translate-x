# Roadmap

This roadmap records architectural possibilities, completed milestones, and future work. Current release scope is **cards-first**: canonical English remains visible; bilingual shows persisted translation/original cards and original mode hides them. Translated-first ordinary-message replacement is deferred due to missing public identity-aware Pi rendering APIs.

## Current Milestones & Workspace Status

- **Translation Core (`pi-translate-x@0.1.3`)**: **Published on npm**. Verified via GitHub Release `v0.1.3` with OIDC trusted provenance (`publish.yml`, publish run `40629946624`).
- **Companion Questionnaire (`pi-ask-user-x@0.1.0` published / `0.1.1` prepared)**: Published on npm (manual initial bootstrap). Automated trusted publishing configured via `.github/workflows/publish-ask-user.yml` for future releases once trusted publisher is confirmed by the owner. Workspace prepares `0.1.1` with user-approved tool rename to `ask_user`.
- **Automated Evidence**: Unit/integration tests, package allowlist checks, tarball closure validation, literal lexical protection, FIFO input scheduling, same-width terminal height reflow, small-viewport dialogs down to 1 row, and versioned `pi.events` translation service (protocol v1).

## Questionnaire Interaction Architecture

Rather than adapting brittle third-party adapters (e.g. `@juicesharp/rpiv-ask-user-question`, which was abandoned due to monkey-patching risks), the project implemented the companion package `pi-ask-user-x` in `packages/ask-user`:
- **Tool Separation**: Provides `ask_user` without intercepting or mutating the separate `ask_user_question` plugin.
- **Event-Bus Service**: Interacts with `pi-translate-x` via versioned protocol v1 over `pi.events`, avoiding duplicate translator instances and isolating failures.
- **English-Canonical Contract**: Predefined question choices resolve strictly by immutable string IDs without back-translation. Freeform custom prose and notes are reverse-translated to canonical English for the LLM.
- **Submit-Only Persistence**: Only confirmed, submitted questionnaires are written to session history (context-excluded). Cancelled flows and drafts remain in-memory and are never persisted.
- **TUI Responsiveness**: Reflows side-by-side, stacked, and compact layouts; caches `termRows` to reflow on same-width terminal height changes (e.g. 24 -> 8 -> 4); compacts early error and confirmation screens down to height 1 while preserving all action keys.

## Later Host Capabilities

A supported upstream ordinary-message renderer exposing stable entry identity could enable translated-first user/assistant views without mutating canonical messages. Any upstream API proposal is separate work, versioned, publicly supported, and tested for redraw, streaming, export, and branch behavior. Until then, translated-first remains unsupported.

## Support & Integration Matrix

| Capability / Package | Status | Evidence |
|---|---|---|
| Translation core (`pi-translate-x`) | **Published** (`0.1.3`) | Strict TypeScript checks, unit and integration suites, package allowlist validation, OIDC provenance release. |
| Companion questionnaire (`pi-ask-user-x`) | **Published** (`0.1.0`), `0.1.1` prepared | Full TUI/RPC implementation, state machine, event-bus protocol v1, tarball closure. Renamed model tool to ask_user in 0.1.1. |
| External rpiv adapter (`@juicesharp/rpiv-ask-user-question`) | **Abandoned** | Avoided brittle monkey-patching of built-in question tools in favor of first-party protocol v1. |
| Pi ordinary-message identity renderer | **Proposed Upstream** | Current public type declarations lack ordinary-message identity for custom renderers. |

## Release Operations

- Continuous Integration (`.github/workflows/ci.yml`) runs on push and pull requests, validating both root and ask-user package manifests, closures, and type safety.
- Root releases trigger `.github/workflows/publish.yml` upon published GitHub Release with tag `v<version>`.
- Ask-user releases trigger `.github/workflows/publish-ask-user.yml` upon published GitHub Release with tag `pi-ask-user-x-v<version>` once trusted publisher confirmation is established.
