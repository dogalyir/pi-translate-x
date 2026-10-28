# pi-translate-x

[![pi-translate-x banner](https://raw.githubusercontent.com/dogalyir/pi-translate-x/main/docs/assets/banner.svg)](https://github.com/dogalyir/pi-translate-x)

[![pi-translate-x npm version](https://img.shields.io/npm/v/pi-translate-x?label=pi-translate-x)](https://www.npmjs.com/package/pi-translate-x)
[![pi-ask-user-x npm version](https://img.shields.io/npm/v/pi-ask-user-x?label=pi-ask-user-x)](https://www.npmjs.com/package/pi-ask-user-x)
[![CI Status](https://img.shields.io/github/actions/workflow/status/dogalyir/pi-translate-x/ci.yml?branch=main&label=CI)](https://github.com/dogalyir/pi-translate-x/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/dogalyir/pi-translate-x/blob/main/LICENSE)

A modular monorepo providing context-excluded bilingual translation and structured questionnaires for the [Pi coding agent](https://pi.dev).

---

## Installation & Setup

Install published extensions directly into Pi:

```sh
# Core translator extension (published v0.1.3)
pi install npm:pi-translate-x

# Companion structured questionnaire extension (published v0.1.0)
pi install npm:pi-ask-user-x
```

Run the interactive setup wizard in the Pi TUI to select your human language and authenticated translation model (requires `pi-translate-x >= 0.1.3`):

```text
/translate-x setup
```

### Tool Name Migration & Checkout Trial

- **Published `pi-ask-user-x@0.1.0`**: Exposes the tool under the historical name `bilingual_questionnaire`.
- **Workspace Checkout `0.1.1` (Prepared)**: Renames the model tool to `ask_user` with a neutral description (`structured questions / choices / freeform`) and neutral UI defaults.
- To run a safe local trial directly from this repository checkout (with `ask_user` and root `0.1.3`):
```sh
pi --no-extensions --extension ./src/index.ts --extension ./packages/ask-user/src/index.ts
```

---

## Core Flow: Canonical English Architecture

[![System Architecture](https://raw.githubusercontent.com/dogalyir/pi-translate-x/main/docs/assets/architecture.svg)](https://github.com/dogalyir/pi-translate-x/blob/main/docs/assets/architecture.svg)

`Canonical English → Translated Display → English Answers`

1. **Input Interception**: Human input prose is intercepted and translated into prepared canonical English before it reaches the main model.
2. **Prepared Human Prose Boundary**: User-submitted prose is translated to canonical English and confirmed questionnaire answers resolve to canonical IDs/English prose. Translations and UI cards are excluded from model context. Note: Tool execution output, files, diffs, and system context are not translated wholesale.
3. **Cards-First Display**: Assistant responses stay in canonical English, while translated prose is rendered as separate persisted cards.
4. **Stable Questionnaire IDs**: `ask_user` is a separate tool registered by `pi-ask-user-x` that **does not intercept** the separate `ask_user_question` plugin. Predefined options resolve by immutable string IDs, back-translating only custom notes and freeform prose.

---

## Monorepo Packages & Layout

| Package | Version | Path | Description | Key Tools & Commands |
|---|---|---|---|---|
| **`pi-translate-x`** | `0.1.3` (verified published) | `.` (root) | Translation core, cards engine, and event-bus service | `/translate-x setup`, `/translate-x status`, `/translate-x retry` |
| **`pi-ask-user-x`** | `0.1.0` (published) / `0.1.1` (prepared) | `packages/ask-user` | Companion structured questionnaire extension | Tool: `ask_user` (`0.1.1` prepared; `bilingual_questionnaire` in published `0.1.0`) |

```text
pi-translate-x/
├── package.json                   # Root translator manifest (pi-translate-x@0.1.3)
├── src/                           # Input/output translation pipeline & pi.events service
├── packages/
│   └── ask-user/                  # Workspace package (pi-ask-user-x@0.1.1 prepared)
│       └── src/                   # ask_user tool & responsive TUI
├── docs/                          # Developer & architecture documentation
│   ├── index.md                   # Documentation index
│   ├── translation.md             # In-depth translation pipeline guide
│   ├── questionnaire.md           # Questionnaire tool guide & runnable schema
│   ├── releases.md                # Release verification & workflow guide
│   └── assets/                    # Standalone SVG banner & architecture diagrams
├── scripts/                       # Manifest allowlist & tarball closure validators
├── CONTRIBUTING.md                # Contribution boundaries & guidelines
└── ROADMAP.md                     # Integration roadmap & host rendering status
```

---

## Essential Constraints & Cards

- **Fail-Closed Behavior**: Applies only when input translation is configured and enabled. If an active translation fails, submission halts and the TUI prepends original human text to the current draft. Disabled, unconfigured, or malformed configurations bypass translation and pass raw input directly to Pi.
- **Paid Translation**: Translation is an independent model call consuming tokens. There are no claims of cost reduction or token savings.
- **No Main-Model Fallback**: Translations use only the configured provider/model. No fallback to the main agent model or unauthenticated providers. Malformed config disables translation and bypasses input.
- **Sensitive Persisted Records**: Custom cards (`pi-translate-x:input`, `pi-translate-x:output`) and submitted questionnaires are saved to session history (context-excluded).
- **In-Memory Drafts**: In-progress questionnaire selections and cancelled flows stay in memory and are discarded; only submitted answers are persisted.
- **Literal Protection**: Code blocks, inline backticks, URLs, file paths, and internal placeholders receive best-effort lexical masking in `src/core/protection.ts`; arbitrary `$shell` syntax is not masked. Inputs beginning with `/` or `!` bypass the input translation hook entirely.
- **Partial Context Scope**: Tool calls, file buffers, and execution output are not translated wholesale into English; only human-facing prose.

---

## Execution Modes & Verified Limits

| Mode | Translation (`pi-translate-x`) | Questionnaire (`pi-ask-user-x`) |
|---|---|---|
| **TUI** (`ctx.mode === "tui"`) | Interactive setup, status, retry, and bilingual cards. User TUI acceptance testing has verified interactive behavior. | Full responsive layout reflows (side-by-side, stacked, compact down to height 1 row). |
| **Native RPC** (`ctx.mode === "rpc"`) | Configured input translates safely; output stays canonical English; setup notifies and exits. | Degrades gracefully to native Pi RPC dialogs (`ui.select`, `ui.input`, `ui.confirm`). |
| **Headless** (`json`/`print`) | Configured input translates safely; output stays canonical English. | **Explicitly unsupported**; returns `"Headless execution is not supported"`. |

*Verification note*: Automated tests use deterministic mocks. While layout tests verify responsive dimensions down to 1 row, no claims are made regarding full provider matrices, hardware terminal cursors, or assistive technologies.

---

## Releases & Developer Documentation

- [Documentation Index](https://github.com/dogalyir/pi-translate-x/blob/main/docs/index.md)
- [Translation Pipeline Guide](https://github.com/dogalyir/pi-translate-x/blob/main/docs/translation.md)
- [Questionnaire Tool Guide & Schema](https://github.com/dogalyir/pi-translate-x/blob/main/docs/questionnaire.md)
- [Release Operations & Verification](https://github.com/dogalyir/pi-translate-x/blob/main/docs/releases.md)
- [Contributing Guidelines](https://github.com/dogalyir/pi-translate-x/blob/main/CONTRIBUTING.md)
- [Project Roadmap](https://github.com/dogalyir/pi-translate-x/blob/main/ROADMAP.md)

`pi-translate-x@0.1.3` is verified published on npm via GitHub Actions OIDC trusted publishing (workflow run `40629946624`). `pi-ask-user-x@0.1.0` is published on npm via manual bootstrap (future automated releases prepared; npm owner trust pending).

Repository: [dogalyir/pi-translate-x](https://github.com/dogalyir/pi-translate-x). MIT License.
