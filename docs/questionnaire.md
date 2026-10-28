# Questionnaire Guide: pi-ask-user-x

`pi-ask-user-x` is a companion package located in `packages/ask-user` that provides the `ask_user` tool for the Pi coding agent (`@earendil-works/pi-coding-agent`).

---

## Tool Separation Architecture

`pi-ask-user-x` adheres to strict architectural isolation:

- **Non-Interception**: The separate tool `ask_user_question` (provided by a distinct plugin) is **not intercepted**, wrapped, or monkey-patched.
- **Explicit Invocations**: The LLM invokes `ask_user` explicitly when structured forms, architectural decision trees, or multi-field selections are requested.
- **Standalone or Cooperative**:
  - **With `pi-translate-x` (>=0.1.3)**: Connects to the translation service on `pi.events` (protocol v1) to dynamically translate headers, prompts, and descriptions into the user's configured language, and back-translates custom free-form responses into canonical English. Translation is an internal presentation capability; the tool interface remains neutral.
  - **Standalone**: When `pi-translate-x` is not loaded or disabled, `ask_user` executes fully in canonical English.

### Migration Note (v0.1.0 to v0.1.1)

- In `pi-ask-user-x@0.1.0` (published on npm), the tool was registered as `bilingual_questionnaire`.
- In `pi-ask-user-x@0.1.1` (prepared in checkout), the tool is renamed to `ask_user` with label `Ask User` and neutral model guidance. The historical 0.1.0 release is preserved immutably on npm.

---

## Canonical English and Stable Option IDs

To guarantee agent predictability and prevent drift:

1. **Predefined Option IDs**: Every choice is identified by an immutable `id` (e.g., `"postgresql"`).
2. **Zero Back-Translation on Fixed Choices**: When a user selects a translated option label (e.g., a translated label in Spanish or Japanese), the tool resolves the answer strictly by its canonical `id`. The localized label is never back-translated.
3. **Selective Back-Translation**: Only custom supplemental prose (`allowCustom: true`) and notes are reverse-translated to canonical English before being returned to the LLM.

---

## Question Types and Constraints

The tool accepts 1 to 8 structured questions per invocation:

| Type | Navigation & Selection | Supported Properties |
|---|---|---|
| `single` (default) | Single-select radio choice. Press `Space` to toggle selection, or `Enter` to select and advance to the next tab. Navigate tabs with `Tab` / `Shift-Tab` (or `h` / `l`). | `options`, `allowCustom`, `required` |
| `multi` | Multi-select checkboxes. Press `Space` or `Enter` to toggle option selection. Does not advance on Enter; navigate tabs with `Tab` / `Shift-Tab` (or `h` / `l`). | `options`, `minSelections`, `maxSelections`, `allowCustom`, `required` |
| `text` | Free-form single-line text input (press `c` or `Enter` to edit via modal `Input`). | `textPlaceholder`, `textMinLength`, `textMaxLength`, `required` |

### Key Question Parameters

- `id`: Unique string identifier for the question (required).
- `header`: Short label displayed in navigation tabs and summaries.
- `prompt`: The question prompt displayed to the user.
- `description`: Optional contextual clarification or instructions.
- `allowCustom`: When true, allows user to enter supplemental text by pressing `c`.
- `options`: Array of `{ id, label, description?, preview? }` entries.
- `preview`: Optional Markdown code block or explanation, viewable with `p` in TUI.

---

## Complete Runnable Example

Below is a valid, runnable JSON schema invocation for `ask_user` demonstrating `single`, `multi`, and `text` question types, markdown previews, notes, and custom text:

```json
{
  "title": "Application Deployment Configuration",
  "description": "Select infrastructure, caching options, and environment variables for the deployment pipeline.",
  "notes": "Target environment: Staging US-East-1",
  "questions": [
    {
      "id": "database_backend",
      "header": "Database",
      "prompt": "Which primary database service should be provisioned?",
      "description": "Choose the primary transactional data store.",
      "type": "single",
      "required": true,
      "allowCustom": true,
      "options": [
        {
          "id": "aurora_postgres",
          "label": "Amazon Aurora PostgreSQL",
          "description": "Managed PostgreSQL-compatible relational database with multi-AZ replication.",
          "preview": "```sql\nCREATE TABLE deployment_records (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  environment TEXT NOT NULL,\n  deployed_at TIMESTAMPTZ DEFAULT now()\n);\n```"
        },
        {
          "id": "dynamodb",
          "label": "Amazon DynamoDB",
          "description": "Serverless NoSQL key-value store with single-digit millisecond latency.",
          "preview": "```json\n{\n  \"TableName\": \"Deployments\",\n  \"KeySchema\": [{ \"AttributeName\": \"DeploymentId\", \"KeyType\": \"HASH\" }]\n}\n```"
        }
      ]
    },
    {
      "id": "cache_layer",
      "header": "Cache",
      "prompt": "Select secondary caching mechanisms to enable:",
      "type": "multi",
      "required": false,
      "minSelections": 1,
      "maxSelections": 2,
      "allowCustom": true,
      "options": [
        {
          "id": "redis_cluster",
          "label": "ElastiCache Redis",
          "description": "In-memory distributed cache cluster for session and query results."
        },
        {
          "id": "cloudfront",
          "label": "CloudFront CDN Edge Cache",
          "description": "Global edge caching for static assets and public responses."
        }
      ]
    },
    {
      "id": "compliance_notes",
      "header": "Compliance",
      "prompt": "Enter any specific compliance or retention constraints:",
      "type": "text",
      "required": false,
      "textPlaceholder": "e.g., SOC2 compliant logging required; retain audit logs for 1 year.",
      "textMaxLength": 1000
    }
  ]
}
```

---

## Terminal UI (TUI) Layout & Responsiveness

The TUI component (`QuestionnaireTUIComponent`) provides responsive terminal layout adaptation:

- **Layout Breakpoints**:
  - `>= 80 columns`: Side-by-side layout (question list + detail preview).
  - `60–80 columns`: Stacked layout (preview below options).
  - `< 60 columns`: Compact stacked layout (renders prompt, all option rows, and collapsible preview without side-by-side split).
- **Terminal Height Caching**: The renderer caches terminal width **and** height (`termRows`). When terminal height changes (e.g. 24 -> 8 -> 4 rows) at the same width, layout immediately reflows without requiring manual invalidation.
- **Small-Viewport Dialogs**: Early confirmation and recovery screens render down to height 1 while preserving all action keys (`[r]`, `[e/Enter]`, `[c/Esc]`) via compact inline hints with ANSI-safe truncation.
- **Markdown Previews**: Syntax-highlighted code blocks in preview panels are focusable via `p` and scrollable with Up/Down/PageUp/PageDown.
- **Review Tab**: Accessible via `Tab`/`Shift-Tab` to inspect all responses, jump to any question, view validation status, and submit.

---

## Execution Modes: RPC vs Headless

| Execution Mode | Behavior |
|---|---|
| **Interactive TUI** (`ctx.mode === "tui" && ctx.hasUI`) | Full rich terminal component with interactive keyboard navigation, preview panels, and responsive reflow. |
| **Native RPC Dialogs** (`ctx.mode === "rpc"`) | Degrades gracefully to native Pi RPC dialogs (`ui.select`, `ui.input`, `ui.confirm`). Rich markdown previews degrade to text hints. |
| **Headless Execution** (`!ctx.hasUI \|\| ctx.mode === "json" \|\| ctx.mode === "print"`) | **Explicitly unsupported**. Returns an immediate failure message (`"Headless execution is not supported"`) to the calling agent without hanging or throwing unhandled errors. |

---

## Submit-Only Persistence and Privacy

- **In-Memory Drafts**: While editing, uncommitted selections, notes, and drafts remain strictly in memory.
- **Cancelled Questionnaires Discarded**: If the questionnaire is cancelled (via `Esc` or dialog confirmation), all entered data is discarded; **nothing is written to session transcript history**.
- **Confirmed Submissions Persisted**: Only confirmed, final submissions are persisted to session transcripts as custom entries of type `pi-ask-user-x:questionnaire`.
- **Context Exclusion**: Transcript records are styled for the human user but marked `customType` and excluded from LLM context injection.
