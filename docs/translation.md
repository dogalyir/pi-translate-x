# Translation Guide: pi-translate-x

`pi-translate-x` is a cards-first translation extension for the Pi coding agent (`@earendil-works/pi-coding-agent`).

---

## Core Flow: Canonical English Architecture

The core flow of `pi-translate-x` prepares human input prose into canonical English for the underlying coding agent while allowing the user to interact in their preferred human language. Note that canonical English conversation history is **not** wholesale translated: files, tool execution outputs, diffs, and system context are not translated into English. Only configured, eligible user input prose is translated.

```
User (Native Language Prose)
       │
       ▼
[Input Pipeline (Active when Configured & Enabled)]
       │
       ├─► Translated prose → Canonical English → Pi Agent LLM Context
       │
       └─► Original + Prepared English → Stored as `pi-translate-x:input` card (Context-Excluded)

[Assistant Output Pipeline]
       │
       ├─► Assistant response (Canonical English) → Main transcript
       │
       └─► Background Translator → Translated prose → Stored as `pi-translate-x:output` card (Context-Excluded)
```

1. **User input prose** in any configured language is intercepted before submission when input translation is configured and enabled (`settings.enabled && settings.input`).
2. The input pipeline translates eligible human prose to canonical English using a dedicated, separately configured translation model.
3. The **canonical English text** is delivered to Pi's LLM context window. When enabled, a system prompt instruction (`"Work in English. User input may have been translated; preserve intent and clarify ambiguity."`) is appended to steer the assistant to respond in canonical English; this is prompt steering, not an unconditional guarantee.
4. The assistant generates its response in canonical English.
5. In the background, `pi-translate-x` translates assistant prose and persists a translation card.
6. The terminal UI displays the card according to the active view mode (`bilingual` or `original`).

---

## Interactive Setup and Configuration

Setup is initiated interactively from within the Pi TUI:

```text
/translate-x setup
```

> **Note**: Setup requires an interactive TUI (`ctx.mode === "tui"`). In headless or RPC modes, `/translate-x setup` notifies the user and exits cleanly.

### Setup Steps

1. **Target Language**: Prompted for the human language to write and read (e.g., `es`, `ja`, `de`, `fr`, `zh`).
2. **Provider and Model**: Scans authenticated providers and models available in Pi's model registry. You select an exact authenticated model. There is **no default model** and **no fallback to the main model**.
3. **Card Visibility**: Choose initial card visibility (`bilingual` or `original`).
4. **Cancellable Verification Test**: Runs a test translation call. If cancelled or unsuccessful, settings are **not saved**.

### Configuration Storage

- Saved runtime configuration is stored at:
  ```text
  <agent-directory>/pi-translate-x.json
  ```
  (where `<agent-directory>` is resolved via Pi's `getAgentDir()`).
- See `config.example.json` in the root repository for format illustration.
- **Malformed or unconfigured configuration disables or bypasses input**: raw input passes directly to Pi without translation rather than falling back to an unverified model. Fail-closed safety applies only when input translation is actively configured and enabled.
- Credentials and API keys are managed by Pi's credential manager; `pi-translate-x.json` contains only provider IDs and model identifiers.

---

## Command Reference

| Command | Purpose |
|---|---|
| `/translate-x setup` | Interactive TUI setup wizard (language, model, visibility test). |
| `/translate-x status` | Displays active configuration, model, language, toggle states, and mode. |
| `/translate-x on` / `/translate-x off` | Master toggle enabling or disabling the translation extension. |
| `/translate-x input on` / `/translate-x input off` | Toggles human input translation on or off independently. |
| `/translate-x output on` / `/translate-x output off` | Toggles assistant output translation cards on or off independently. |
| `/translate-x view original` | Hides translation cards; displays canonical English messages. |
| `/translate-x view bilingual` | Shows translation cards alongside canonical English messages. |
| `/translate-x retry [assistant-entry-id]` | Re-translates a prior assistant message without re-running the agent. |

---

## Cards-First Presentation Model

Rather than mutating or replacing ordinary message bubbles in place—which current Pi public extension APIs do not permit with stable identity—`pi-translate-x` uses dedicated custom session entries:

- **`pi-translate-x:input`**: Persisted entry holding the original human prose and the prepared English submission. Tagged as "prepared for input pipeline"; never linked by ambiguous text matching.
- **`pi-translate-x:output`**: Persisted entry linked directly to the assistant's message entry ID.
- **Context Exclusion**: Custom cards are marked `customType` entries and excluded from model context injection. They consume zero tokens in subsequent agent prompts.
- **View Switching**: In `original` view, cards are hidden. Changing view reads state at render time; a transcript redraw or reload may be required depending on terminal state.

---

## Output Lane, Transient Status, and Retry

- **Background Output Lane**: Assistant prose is translated asynchronously without blocking agent streaming.
- **Transient Status Indicator**: While translation is pending, a namespaced status indicator (`Translating response…`) is displayed in the TUI footer via `ctx.ui.setStatus()`. When the translation completes or is cancelled/invalidated, the status is cleared without overwriting other footer elements.
- **`/translate-x retry`**:
  - Re-translates an assistant response using the **currently configured** model and language settings.
  - Does **not** re-run the agent or call the main model.
  - Requires the target assistant entry to remain on the active session branch.
  - Appends a new card and refreshes the cache; earlier cards remain in session history.

---

## Protection and Literal Masking

Before sending human text to the translation provider, sensitive syntactic constructs are scanned and masked by `protectLiterals` in `src/core/protection.ts`:

- **Code blocks and backticks**: Inline \`code\` and fenced code blocks (\`\`\`...\`\`\` or \~\~\~...\~\~\~) are masked with unique cryptographic nonce placeholders (`⟪PI_LITERAL_<nonce>_<index>⟫`).
- **URLs**: Web addresses (`http://`, `https://`) are masked.
- **File paths**: Relative and absolute file system paths (e.g., `./`, `../`, `~/`, `/`, `[A-Za-z]:\`) are masked.
- **Pre-existing placeholders**: Nested or existing `⟪PI_LITERAL_...⟫` tokens are preserved.
- **Arbitrary shell syntax not masked**: The scanner does **not** recognize or mask arbitrary `$shell` syntax (such as `$ ...`).
- **Bypassed prefixes**: The input hook in `src/index.ts` bypasses translation entirely when an input begins with `!` (shell execution) or `/` (slash command), or when no prose is detected.
- **Best-Effort Scope**: Masking is best-effort lexical protection. It does not provide cryptographic sanitization or guarantee that no code tokens are sent to the translation API.

---

## Fail-Closed Input Safety

Fail-closed behavior applies **only when input translation is configured and enabled** (`settings.enabled && settings.input`). When translation is unconfigured, disabled, or malformed, input bypasses translation directly to Pi.

When input translation is active, if the translation provider fails, is rate-limited, times out, or encounters a cancellation (e.g., navigation or settings epoch change):
1. **Input Submission Halts**: The untranslated input is not forwarded to the agent.
2. **Draft Handling (`src/index.ts:58`)**:
   - In **TUI mode** (`ctx.mode === "tui"` and `ctx.hasUI`), the extension halts input and prepends the original human text to any current draft (`draft ? `${source}\n${draft}` : source`) via `ctx.ui.setEditorText()`, displaying an error notification. It does **not** restore the exact prior state.
   - In **RPC or other UI modes** (`ctx.hasUI`), the extension notifies the user to restore the original text in their client.
   - In **Headless mode** without UI, it logs the failure to `console.error`.

---

## Event Bus Translation Service (Protocol v1)

`pi-translate-x` exposes a versioned translation service over Pi's event bus (`pi.events`) using protocol version `1` (`PROTOCOL_VERSION = 1`). Companion packages (such as `pi-ask-user-x`) connect to this service to translate UI elements and back-translate user inputs without duplicate model instances or configurations.

### Protocol Channels (`src/service/protocol.ts`)

The service communicates over the following event channels:

| Event Channel | Direction | Payload Interface | Purpose |
|---|---|---|---|
| `pi-translate:v1:discover` | Client → Server | `ProtocolDiscoverMessage` | Client announces presence with `version: 1`, `correlationId`, and `client` identifier. |
| `pi-translate:v1:announce` | Server → Client | `ProtocolAnnounceMessage` | Server announces `version: 1`, matching `correlationId`, `server`, `enabled`, `inputEnabled`, `outputEnabled`, `targetLanguage`, `provider`, `model`, and `settingsEpoch`. |
| `pi-translate:v1:batch-request` | Client → Server | `ProtocolBatchRequest` | Client submits translation items with `correlationId`, `sessionId`, `branchId`, `direction` (`"to_target"` or `"to_english"`), `targetLanguage`, `timeoutMs`, and `items`. |
| `pi-translate:v1:batch-response` | Server → Client | `ProtocolBatchResponse` | Server responds with matching `correlationId`, `ok: boolean`, translated `items` (on success) or `error: { code, message }` (on failure). |
| `pi-translate:v1:cancel` | Client → Server | `ProtocolBatchCancel` | Client cancels an in-flight batch request by `correlationId` and `reason`. |
| `pi-translate:v1:settings-invalidated` | Server → Client (Broadcast) | `ProtocolSettingsInvalidatedMessage` | Server broadcasts updated `settingsEpoch`, `enabled`, `targetLanguage`, `provider`, and `model` whenever settings change. |

### Correlated Client Behavior and Request Bounds

- **Batch Size Limits**:
  - Each batch must contain between **1 and 64 items** (`items.length > 0 && items.length <= 64`).
  - Total cumulative text length across all items in a single batch request must not exceed **30,000 characters**.
  - Each item must contain a non-empty, unique `id` and a `text` string.
- **Session & Active Branch Membership**: Requests must match the server's active `sessionId` and `branchId`. Requests with mismatched sessions or branches outside active membership are aborted with code `aborted`.
- **Gating**: Translation service requests are gated only on the global translator `enabled` setting (`state.configured && config.enabled`), independent of the individual `input` or `output` message interception toggles.
- **Error Codes**: Structured error codes in failure responses: `disabled`, `unavailable`, `timeout`, `aborted`, `empty`, `truncated`, `provider`, `invalid_request`, or `mapping_integrity`.
