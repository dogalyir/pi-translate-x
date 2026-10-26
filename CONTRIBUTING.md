# Contributing

Contributions are welcome, especially reproducible API research, tests, documentation, and proposed adapters. No adapters or first-party questionnaire are in the current implementation scope.

## Adapter proposals

Open a proposal with the exact package/repository and version, host Pi version, public hooks/types relied upon, and a runnable test matrix. Demonstrate exact option identity (never translate option values and back-translate selections), question/description/preview translation, protected code/literals, English model-facing args/results, notes/custom answers, cancellation/partial/multiselect semantics, stale-request handling, persistence/resume behavior, and privacy. Include negative tests and proof the extension does not intercept unrelated tools/extensions or rewrite arbitrary strings.

## Core and security boundaries

Use the versioned contracts/records in `src/core`. Preserve exact source/cache identity and session/branch isolation. Do not add blanket tool-string rewriting, hidden network services, main-model fallback, secrets, live paid calls in tests, or text-keyed original maps. Treat all model-returned translation as untrusted content. Keep failure paths fail-closed and do not overwrite active editor drafts.

Tests should use deterministic fake translators. Host integrations need separate public-API harness evidence; visual UI claims require actual terminal verification. Document privacy/cost and distinguish proposed, prototyped, host-tested, and visually verified support. Avoid promising old Pi versions without evidence.
