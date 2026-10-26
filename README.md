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
- Output translates assistant human-facing prose only; canonical English remains unchanged/available. Output calls are bounded/background; failures preserve English. `/translate-x retry` re-translates a saved assistant response without rerunning the agent, using the currently configured provider/model/language (not necessarily the settings used for its prior card), only if its exact assistant entry remains on the active branch. A successful retry appends a new card and refreshes the cache for those current settings; the earlier card remains in history.
- Literal masking is best-effort, not perfect semantic fidelity or a guarantee all code stays on-device.

## Modes

| Mode | Behavior |
|---|---|
| TUI | Setup/status/on-off/input-output/view/retry; canonical English plus cards. Card visibility is read at render time; a Pi transcript redraw/reload may be required after changing view. |
| Print / JSON | No setup prompt; configured input can translate safely; output stays canonical English. |
| RPC | No custom terminal components; supported dialogs/notifications only. |

Local development evidence is from installed `@earendil-works/pi-coding-agent` 1.4.0 and Node 24; Node 22 has not been tested in this project. This is not a broad compatibility claim. Manual TUI/live-provider acceptance and the first CI run remain pending; TUI has not been visually verified. Release risks include inherited pinned Pi/undici development dependency audit findings, the cards-first host limitation from missing public ordinary-message identity rendering, and possible transcript redraw/reload after view changes. The setup-success test fixture manually resolves its custom UI screen, so it does not fully validate real UI/provider-success timing.

## Roadmap and contributing

See [ROADMAP.md](ROADMAP.md) for future paths: integration-first adapters (first research candidate [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)), or considering a first-party bilingual interaction only if safe integration proves impractical. No adapters/questionnaire are implemented now. See [CONTRIBUTING.md](CONTRIBUTING.md).

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

`.github/workflows/ci.yml` is read-only on push/PR. Stable GitHub Release triggers `.github/workflows/publish.yml`: exact `v<package.json.version>`, content validation, and publishing of the same verified tarball with provenance. Workflow is **prepared**, not verified by a release. npm trusted publisher is **not configured**; npm owner must set exact repository/workflow/environment `dogalyir/pi-translate-x`, `publish.yml`, `npm`, and any required first-package bootstrap. No token secret is stored. First public release needs separate approval.

Repository: [dogalyir/pi-translate-x](https://github.com/dogalyir/pi-translate-x). npm E404 on 2026-10-26 means not currently visible, not reserved. MIT; Copyright (c) 2026 dogalyir contributors.
