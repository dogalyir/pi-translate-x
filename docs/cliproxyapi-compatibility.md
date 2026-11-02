# CLIProxyAPI Provider Compatibility: Research, Explanation, and Proposal

Status: **released in pi-translate-x 0.1.5**.
Date: 2026-11-02. Pi host checked: `@earendil-works/pi-coding-agent` 1.5.0 (dev dependency 1.4.0).

---

## 1. Goal

Each CLIProxyAPI provider package must work well on its own, and pi-translate-x must work together with any of them:

- **No load-order dependency.** pi-translate-x must not need to load before or after the provider extension.
- **No spurious "model not found" / "model unavailable" errors** when the translation model is served by a CLIProxyAPI provider package.
- No changes are required in the provider packages.

Packages in scope:

| Repository | npm package | Version / commit checked | Default provider id |
|---|---|---|---|
| [router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) | `@router-for-me/pi-cliproxyapi-provider` | 1.4.24 / `991f87c` (2026-10-27) | `cliproxyapi` (`providerId` in `~/.pi/agent/cliproxyapi.json`, `CLIPROXYAPI_PROVIDER_ID`) |
| [xiangsam/pi-cliproxyapi-provider](https://github.com/xiangsam/pi-cliproxyapi-provider) | `@samrito/pi-cliproxyapi-provider` | 0.17.24 / `73b1562` (2026-11-02) | `cpa` (`providerName` in `~/.pi/agent/pi-cliproxyapi-provider/config.json`, `CLIPROXYAPI_PROVIDER_NAME`) |
| [0xRichardH/pi-cliproxyapi-provider](https://github.com/0xRichardH/pi-cliproxyapi-provider) | `pi-cliproxyapi-provider` | 0.16.0 / `c4976cf` (2026-11-03) | `cpa` (same settings as xiangsam, which is a fork) |

The local setup that prompted this work: `~/.pi/agent/models.json` defines provider `cliproxyapi` (`openai-responses`, base URL on the LAN at `192.168.5.14:8317`), and `~/.pi/agent/pi-translate-x.json` uses `provider: "cliproxyapi"`, `model: "claude-haiku-5-5"`.

---

## 2. Research findings

### 2.1 How Pi registers providers and models (host behavior)

Sources: `docs/extensions.md`, `docs/custom-provider.md`, `dist/core/model-registry.js`, `dist/core/model-runtime.js`, `dist/core/provider-composer.js`.

- An async extension factory is awaited before startup continues. Provider registrations made in the factory are queued and flushed after loading.
- `pi.registerProvider()` / `pi.unregisterProvider()` called after loading take effect immediately. Re-registration **merges** defined fields over the previous registration.
- A provider may implement `refreshModels(context)`. Pi calls it during a model refresh and publishes the returned list. Until then, the registry holds whatever static `models` were registered (often a placeholder).
- `ModelRegistry.refresh({ allowNetwork, providers, force, signal })` exists for extensions. Unknown and static providers are ignored.
- `hasConfiguredAuth(model)` reads an **asynchronously updated availability snapshot**. `markProvisionallyConfigured` covers stored credentials and configured API keys right after registration, but the full availability pass lands later. `getProviderAuthStatus(provider)` checks runtime, stored, and configured auth directly.
- `complete()` goes through `provider.stream`. For a provider that only registers `streamSimple` with a custom `api`, the composer routes `stream` to that `streamSimple`, so `registry.complete()` works for the router-for-me custom API too.

### 2.2 How each provider package registers

**router-for-me (`cliproxyapi`)**
- At load: `unregisterProvider(id)` + `registerProvider(id, …)`. This is an OAuth-capable registration with no models yet, so `/login` works right after install.
- Then it calls `resolveMappedModels()`:
  - If `~/.pi/agent/cliproxyapi-models.json` matches the base URL, it registers the cached models **immediately** and starts a background `/v1/models` fetch that unregisters and re-registers the provider when it finishes.
  - With no cache, it fetches synchronously. If the fetch fails, **no models are registered** until the proxy responds.
- Custom API `cliproxyapi-codex-responses` with its own `streamSimple` (plus a pi-ai compat registration).
- Other hooks: `before_provider_request` (pause guard), `message_end` (transient retry), `turn_end` (proactive compaction), and TPS/fast footers.

**xiangsam and 0xRichardH (`cpa`)**
- At load: `ProviderRuntime.start()` loads the catalog (cache or bundled data) and registers. If no models are known, it registers a **placeholder model `login-required`**. Startup failures also register only that placeholder.
- Real models arrive through `refreshModels` when Pi runs a model refresh (network), or through `/cliproxyapi` refresh.
- `api: "openai-completions"` (GPT-5.6 family uses Responses). A `before_provider_request` hook rewrites the Codex-compatible tool payload.
- The two forks register the same provider and command, so they cannot be installed together.

### 2.3 How pi-translate-x resolved its model before this change

`src/index.ts`, input path and scheduler:

```ts
const model = ctx.modelRegistry.find(settings.provider, settings.model);
if (!model || !ctx.modelRegistry.hasConfiguredAuth(model))
  throw new TranslationError("unavailable", "Configured model … unavailable/authentication missing");
```

The lookup was already lazy (per request), so load order did not matter by itself. The failures came from what the registry contained at the moment of the request.

---

## 3. Explanation: why "model not found" happened

| # | Scenario | Cause | Symptom |
|---|---|---|---|
| 1 | Switch from `models.json` / router-for-me to xiangsam or 0xRichardH | Provider id changes `cliproxyapi` → `cpa`; the config still says `cliproxyapi` | Every translation fails: "unavailable" |
| 2 | xiangsam/0xRichardH with an empty catalog cache (first run, cache cleared, proxy slow) | Only `cpa/login-required` exists until Pi's `refreshModels` pass completes | First translations fail, later ones work |
| 3 | router-for-me with no cache and the proxy briefly unreachable at startup | No models registered until a later refresh | Translations fail until the background recovery succeeds |
| 4 | Any provider just (re)registered | The `hasConfiguredAuth` snapshot lags behind the stored/configured credentials | Spurious "authentication missing" |

From the user's side, 2–4 look like "it only works if the provider loaded and finished first", which is the "one after the other" dependency. 1 is a plain id mismatch.

---

## 4. Proposal (implemented)

### 4.1 Design

A new module, `src/core/model-resolution.ts`, is used by both the input pre-check and the translation scheduler:

1. **Exact match first.** `find(provider, model)`. If found and authenticated, use it with no extra work.
2. **CLIProxyAPI family fallback.** This only applies when the configured provider is a CLIProxyAPI one:
   - It counts as one if its id is `cliproxyapi` or `cpa`, equals `CLIPROXYAPI_PROVIDER_ID` / `CLIPROXYAPI_PROVIDER_NAME`, or its id or display name matches `/cli-?proxy/i` (xiangsam/0xRichardH display `CLIProxyAPI (<id>)`).
   - The same model id is then looked up under every other registered CLIProxyAPI provider, in this order: configured id → env ids → `cliproxyapi` → `cpa` → other detected ones.
   - Within a provider, matching is exact, then case-insensitive, then compares the id with any vendor prefix (`vendor/…`) stripped.
   - Non-CLIProxyAPI providers are **never rerouted**, which keeps the README's "no fallback to another model/vendor" guarantee.
3. **Authentication.** A candidate is accepted when `hasConfiguredAuth(model)` **or** `getProviderAuthStatus(provider).configured` is true. Authenticated candidates win over unauthenticated ones.
4. **One bounded refresh on a miss.** It calls `registry.refresh({ allowNetwork: true, providers: candidates })` with a 15 s timeout, then looks up again.
   - Concurrent callers share the same refresh (deduplicated per registry + provider set), and there is a 30 s cooldown, so the proxy is never hammered.
   - A caller's abort stops only its own wait, not the shared refresh.
5. **Clear errors.** These are `TranslationError("unavailable")` errors:
   - `Translation model cliproxyapi/claude-haiku-5-5 not found (checked providers: cliproxyapi, cpa). …`
   - or `… has no configured authentication (configured as …)`.
   - The existing fail-closed path still prepends the original text back into the editor.
6. **Observability.** `/translate-x status` prints the resolved model, e.g. `Model cliproxyapi/claude-haiku-5-5 → cpa/claude-haiku-5-5`, or `not available yet`.
7. **Graceful degradation.** `getAll`, `refresh`, `getProviderAuthStatus`, and `getProviderDisplayName` are optional. With a minimal registry (older hosts, test doubles), resolution reduces to the previous exact-match behavior.

Cache keys and persisted records keep the **configured** `modelRef`, so switching provider packages does not invalidate the session translation cache.

### 4.2 Why this approach

- **Nothing changes in the provider packages**, so each keeps working on its own and can be upgraded independently.
- **No load-time coupling:** pi-translate-x registers no provider and captures no model at load.
- **Fallback is limited to the CLIProxyAPI family.** The same model id under another CLIProxyAPI provider id still reaches the same proxy, so it's the same backend model, not a different vendor.

### 4.3 Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Rewrite `pi-translate-x.json` automatically to the detected provider | Mutates user config silently, and breaks again when switching packages back |
| Match any provider with the same model id | Could route translation (and spend) to a different vendor; violates the documented guarantee |
| Wait/poll at `session_start` until the provider is ready | Delays startup and recreates a load-order dependency |
| Ship our own CLIProxyAPI provider registration | Duplicates the provider packages and conflicts with them (same ids, merge semantics) |
| Read each package's config file to learn custom ids | Couples us to private file formats; display-name and env detection cover the defaults |

---

## 5. Changes

| File | Change |
|---|---|
| `src/core/model-resolution.ts` | **New.** `resolveTranslationModel`, `resolveTranslationModelSync`, `candidateProviders`, `isCliproxyProvider`, `CLIPROXYAPI_PROVIDER_IDS` |
| `src/index.ts` | Input pre-check and scheduler use the resolver; `/translate-x status` shows the resolved model; `/translate-x setup` uses the lag-tolerant auth check (`hasTranslationModelAuth`) and reports why it stopped instead of exiting silently; module re-exported |
| `tests/model-resolution.test.ts` | **New.** 9 unit tests + 1 ExtensionRunner integration test (config `cliproxyapi`, provider registered late as `cpa`) |
| `scripts/validate-package.mjs`, `scripts/validate-tarball.mjs` | Require the new source file in the package |
| `README.md`, `CHANGELOG.md` | Document load-order independence and CLIProxyAPI compatibility |

### Verification

- `npx tsc --noEmit`: clean.
- `npx vitest run`: 23 files, 208 tests passed (this includes the placeholder retry and prompt-wrapping tests).
- `npm run validate:package`: valid.
- A one-off smoke test against Pi's **real** `ModelRegistry`/`ModelRuntime` (not kept in the repo):
  - setup: provider `cpa` registered with only `login-required` plus a `refreshModels` that returns `claude-haiku-5-5`;
  - result: `resolveTranslationModel(registry, "cliproxyapi", "claude-haiku-5-5")` returned `cpa/claude-haiku-5-5` through one real refresh.

---

## 6. Known limitations and recommendations

- **router-for-me proactive compaction.** It keys a pending compaction marker by `provider/model`. If the translation model is also the main chat model, an output translation issued on `turn_end` could consume that marker. **Recommendation:** use a separate small translation model (e.g. `claude-haiku-5-5`), which is the current setup.
- **router-for-me Fast mode** applies the priority tier to every request to fast-capable models of its provider, including translation calls. That's expected, but it costs more.
- **Do not install two sources for the same provider id.**
  - A `models.json` `cliproxyapi` entry and router-for-me both define `cliproxyapi`, and their registrations merge.
  - xiangsam and 0xRichardH cannot be installed together.
  - Pick one source per id.
- **Custom provider ids** are detected through `CLIPROXYAPI_PROVIDER_ID` / `CLIPROXYAPI_PROVIDER_NAME` or a display name containing "CLIProxy". A custom id with an unrelated display name needs the config to name that id directly (`/translate-x setup`).
- **Translation prompt placement.** Measured live on 2026-11-02 against `cliproxyapi/claude-haiku-5-5`: with the instruction only in the system prompt, the model *answered* conversational source text instead of translating it, dropping every placeholder. Spanish output failed 6 of 6 tries, English input 2 of 3. `claude-sonnet-5-5`, `deepseek-flash` and `gpt-6-luna` passed. The source is now fenced in `<source_text>` tags with the task restated in the user turn (`wrapTranslationSource` / `unwrapTranslation` in `src/core/engine.ts`): 7 of 7 passed with Haiku. On top of that, a placeholder integrity failure gets one retry with a stricter prompt, inside the same `timeoutMs`.
- **`temperature: 0.1`** is still sent to translation requests. A Responses/Codex route serving a reasoning model may reject `temperature`. If that happens, choose a non-reasoning translation model.

## 7. Rollout

1. Shipped in pi-translate-x 0.1.5, together with the placeholder retry and `<source_text>` prompt wrapping (`src/core/engine.ts`).
2. Update the installed package (`pi update`); older installs do not contain this change.
3. After updating, run `/translate-x status` and confirm the resolved model line.
