# pi-ask-user-x

Bilingual structured questionnaire extension for the Pi coding agent (`@earendil-works/pi-coding-agent`).

## Overview & Architecture

`pi-ask-user-x` provides the `ask_user` tool for interactive user questionnaires, preference elicitation, and architectural decision trees.

- **Non-Interception & Tool Separation**: The separate `ask_user_question` plugin is **not intercepted**, patched, or monkey-patched. Models invoke `ask_user` directly to ask structured questions with single or multiple choices, or open freeform input, without global state mutations.
- **Dual Execution Modes**:
  - **Co-operative with `pi-translate-x`**: When `pi-translate-x` (>=0.1.3) is active and enabled, question headers, prompts, descriptions, and predefined options are dynamically translated into the user's target language via the versioned translation service (`TranslationService`, protocol v1 over `pi.events`). Custom user prose and notes are reverse-translated back to English for the LLM. Translation is a presentation implementation detail—the model tool name, label, and description remain clean and neutral.
  - **Standalone Mode**: When `pi-translate-x` is absent or disabled at launch, `pi-ask-user-x` operates standalone in canonical English without failure. When an active translation service is detected but incompatible, malformed, or fails rediscovery/retry, users are presented with an explicit recovery choice (Retry discovery, Continue in English, or Cancel questionnaire) rather than silently degrading. Once an enabled service is discovered, answer translation obligation is pinned: custom user prose and notes are never submitted raw to the LLM without translation or explicit user recovery choice.
- **English-Canonical Contract & Stable IDs**: Predefined choices resolve strictly by stable, immutable string identifiers (`id`), completely independent of translated display text or duplicate localized labels. Predefined option choices are never back-translated. The model-facing tool arguments and return results remain strictly canonical English.
- **Submit-Only Privacy & Persistence**: Only confirmed, submitted questionnaire answers and their durable bilingual display snapshot are persisted to the session transcript (as context-excluded custom entries of type `pi-ask-user-x:questionnaire`). In-progress drafts, uncommitted answers, and cancelled questionnaire sessions are discarded from memory and never written to transcript storage. Persisted records are static; changing translator settings later does not re-translate or mutate session history. Durable transcript records are rendered visually for the human user but excluded from LLM context injection.

## Question Types and Configuration

The `ask_user` tool supports 1 to 8 structured questions per invocation:

| Question Type | Behavior & Fields |
|---|---|
| `single` (default) | Single-select radio choices. Pressing `Enter` selects the option and advances. Allows custom supplemental text alongside selection when `allowCustom: true`. |
| `multi` | Multi-select checkbox choices. Toggled with `Space`. Enforces optional `minSelections` and `maxSelections` constraints. Allows custom supplemental text when `allowCustom: true`. |
| `text` | Pure free-form text input. Options are omitted; uses `textPlaceholder`, `textMinLength`, and `textMaxLength`. |

- **Options**: Each option defines a unique `id` (e.g. `'postgres'`), display `label`, optional `description`, and optional Markdown `preview`.
- **Supplemental Custom Input**: When `allowCustom: true` (default for `single` and `multi`), users can press `c` to enter custom text. For single-select questions, custom text is preserved as supplemental qualification alongside the selected choice, rather than a conflicting radio indicator.
- **Notes**: Supports per-question notes (press `n` on any question row) and global questionnaire notes (edited in the Review tab).
- **Validation**: Enforces mandatory fields (`required: true`), selection count bounds (`minSelections`, `maxSelections`), and text lengths. Attempted submissions with invalid fields announce warnings and automatically jump focus to the first invalid row.
- **Explicit Mark-Empty**: Optional questions support explicit blank confirmation (`e` shortcut) to distinguish conscious skips from unvisited rows.

## Terminal UI (TUI) & Layout Responsiveness

The TUI component (`QuestionnaireTUIComponent`) provides an accessible, fully responsive terminal interface:
- **Screen Layouts**: Responsive side-by-side (>= 80 columns), stacked preview (60–80 columns), and compact (< 60 columns) modes.
- **Height-Bounded Viewport**: Computes `termRows` before checking cached renders, caching terminal height alongside width. Terminal height resizes (e.g. 24 -> 8 -> 4 rows) at the same width reflow immediately without requiring manual `invalidate()`.
- **Markdown Previews**: Syntax-highlighted code blocks in previews (via public `Markdown` and `getMarkdownTheme()`). Focusable with `p`, scrollable with Up/Down/PageUp/PageDown without clipping.
- **Review Tab**: Accessible via `Tab`/`Shift-Tab`, listing all question statuses, answers, validation errors, global notes, and submit trigger. Pressing `Enter` on any row jumps directly to edit that question.
- **Confirmations**:
  - Full submit confirmation (`confirm_submit_full`).
  - Conscious partial submit confirmation (`confirm_submit_partial`), explicitly listing headers and IDs of unanswered questions.
  - Cancellation confirmation (`confirm_cancel`), confirming before discarding draft responses.
- **Error Recovery**:
  - Display translation failure: `[r]` Retry translation, `[e/Enter]` Continue in English, `[c/Esc]` Cancel questionnaire.
  - Answer translation failure: `[r]` Retry translation, `[e/Enter]` Return to edit drafts, `[c/Esc]` Cancel questionnaire.
- **Compact Small-Viewport Dialogs**: Early error and confirmation dialogs adapt dynamically to constrained heights (down to height 1) and narrow widths (1, 3, 4, 6, 12 columns). All action choices (`[r]`, `[e/Enter]`, `[c/Esc]` or `[y/Enter]`, `[n/Esc]`) are preserved in discoverable short hints without slicing action lines. Detail messages scroll vertically via Up/Down navigation when viewports are constrained. Truncation uses ANSI-safe width calculations.

## RPC Mode Degradation

When running headless or via RPC (`ctx.mode === "rpc"`), interactive terminal components degrade gracefully to standard dialog methods (`ui.select`, `ui.input`, `ui.confirm`). Rich Markdown previews degrade to text label and description hints.

## Installation & Usage

### Installing Published Packages

Install the companion questionnaire package directly from npm:
```sh
pi install npm:pi-ask-user-x
```

When using alongside `pi-translate-x` for bilingual translation support, ensure `pi-translate-x` is at least version `0.1.3`:
```sh
pi install npm:pi-translate-x
```

### Source Checkout, Migration, and Release Status

- **Tool Name Migration**:
  - In `pi-ask-user-x@0.1.0` (published on npm): The tool was named `bilingual_questionnaire`.
  - In `pi-ask-user-x@0.1.1` (prepared in checkout): The tool is renamed to `ask_user` with label `Ask User` and a neutral model description (`structured questions / choices / freeform`).
- **Published Tarball vs Source**: Version `0.1.0` of `pi-ask-user-x` is verified public latest on npm (integrity `sha512-MYTZ9F1Ll7DKmyeUtq5iAzBF/r6vwomizfeR2WUjr25KK+si36iHINRgMon5WzUcNkxzjnc/mGeWtnG/d1Mdiw==`, owner `carmelocampos`). Because npm enforces package immutability, version 0.1.0 cannot and will not be republished. Version `0.1.1` is prepared in this repository workspace.
- **Future Automated Releases**: Subsequent releases will be automated via GitHub Actions workflow `.github/workflows/publish-ask-user.yml` triggered exclusively by published GitHub Releases (`GHrelease.published`) with tag `pi-ask-user-x-v<packageversion>`.
- **npm Trusted Publisher Configuration**:
  - GitHub repository: `dogalyir/pi-translate-x`
  - Workflow name: `publish-ask-user.yml`
  - Environment name: `npm`
  *(Do not configure the trusted publisher in the npm owner UI until confirmed.)*

### Local Development from Checkout

To run or test both extensions locally from this checkout without loading duplicate extensions:
```sh
pi --no-extensions --extension ./src/index.ts --extension ./packages/ask-user/src/index.ts
```

## Runnable Schema Example

Below is a complete, runnable invocation of `ask_user` demonstrating `single`, `multi`, and `text` question types, markdown previews, supplemental custom text, notes, and selection bounds:

```json
{
  "title": "System Architecture Decisions",
  "description": "Please specify preferences for storage, caching, and custom deployment requirements.",
  "notes": "Decisions will be recorded in ADR-004.",
  "questions": [
    {
      "id": "database_engine",
      "header": "Database",
      "prompt": "Which primary database engine should the microservices utilize?",
      "description": "Consider ACID guarantees, relational consistency, and read/write access patterns.",
      "type": "single",
      "required": true,
      "allowCustom": true,
      "options": [
        {
          "id": "postgresql",
          "label": "PostgreSQL",
          "description": "Relational database with JSONB support, strict ACID compliance, and robust extension ecosystem.",
          "preview": "```sql\nCREATE TABLE tenants (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  name TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT now()\n);\n```"
        },
        {
          "id": "mongodb",
          "label": "MongoDB",
          "description": "Document-oriented database optimized for flexible schemas and horizontal sharding.",
          "preview": "```javascript\ndb.tenants.insertOne({\n  name: 'Acme Corp',\n  createdAt: new Date()\n});\n```"
        }
      ]
    },
    {
      "id": "caching_layer",
      "header": "Cache",
      "prompt": "Select caching technologies to support high-throughput read operations:",
      "type": "multi",
      "required": false,
      "minSelections": 1,
      "maxSelections": 2,
      "allowCustom": true,
      "options": [
        {
          "id": "redis",
          "label": "Redis",
          "description": "In-memory data store supporting pub/sub, clustering, and rich data structures."
        },
        {
          "id": "memcached",
          "label": "Memcached",
          "description": "Simple multithreaded key-value cache."
        }
      ]
    },
    {
      "id": "compliance_notes",
      "header": "Compliance",
      "prompt": "Specify any regulatory or data residency constraints (e.g. GDPR, HIPAA, FedRAMP):",
      "type": "text",
      "required": false,
      "textPlaceholder": "e.g. EU data residency required; logs retained for 90 days max.",
      "textMaxLength": 1000
    }
  ]
}
```

## Testing & Verification Limits

Automated test suites pass deterministically using headless Vitest assertions, mock terminal renderers, and simulated event busses. **No manual assistive technology (AT), hardware cursor, screen-reader, or live terminal/provider verification is claimed.** Manual terminal inspection remains required for physical terminal emulator quirks.

## Documentation & Monorepo Links

For additional architectural details and guides, see the repository documentation:
- [Questionnaire Guide](https://github.com/dogalyir/pi-translate-x/blob/main/docs/questionnaire.md)
- [Translation Pipeline Guide](https://github.com/dogalyir/pi-translate-x/blob/main/docs/translation.md)
- [Release Operations & Verification](https://github.com/dogalyir/pi-translate-x/blob/main/docs/releases.md)
- [Monorepo Documentation Index](https://github.com/dogalyir/pi-translate-x/blob/main/docs/index.md)

## License

MIT
