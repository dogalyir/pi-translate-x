# Documentation Index

Welcome to the `pi-translate-x` monorepo documentation. This index guides you to the relevant architectural specifications, guides, and release references.

---

## Architecture and Design

- [**System Architecture Diagram**](assets/architecture.svg): Vector SVG diagram detailing the context isolation boundary, user interaction layers, event-bus translation service, and dedicated model calls.
- [**Project Banner**](assets/banner.svg): Monorepo visual banner.

---

## Guides and References

- [**Translation Guide**](translation.md):
  - Canonical English flow and input interceptor
  - Interactive setup (`/translate-x setup`) and runtime configuration
  - Cards-first display model (`bilingual` vs `original`)
  - Assistant output background lane, transient footer status, and retry mechanics
  - Protection and lexical literal masking rules
  - Event-bus translation service (Protocol v1 over `pi.events`)

- [**Questionnaire Guide**](questionnaire.md):
  - Architecture and non-interception guarantee (`ask_user` tool vs separate `ask_user_question` plugin)
  - Standalone and cooperative dual execution modes
  - Question types (`single`, `multi`, `text`) and configuration schema
  - Complete, runnable JSON example
  - TUI responsiveness, height caching, and compact small-viewport dialogs
  - Native RPC dialog degradation vs unsupported headless execution
  - Submit-only session persistence contract

- [**Release Operations & Verification**](releases.md):
  - Verified npm published versions (`pi-translate-x@0.1.3` and `pi-ask-user-x@0.1.0` / `0.1.1` prepared)
  - GitHub Actions release workflows (`publish.yml` and `publish-ask-user.yml`)
  - OIDC trusted publishing configuration
  - Release commands and verification scripts

---

## Monorepo Layout

```
pi-translate-x/
├── package.json                   # Root package (pi-translate-x@0.1.3)
├── src/                           # Translation extension core and event bus service
├── packages/
│   └── ask-user/                  # Workspace package (pi-ask-user-x@0.1.1 prepared)
│       ├── package.json
│       ├── src/                   # ask_user tool and TUI component
│       └── tests/                 # Unit, integration, and layout tests
├── docs/                          # Developer and user documentation
│   ├── index.md                   # This documentation index
│   ├── translation.md             # In-depth translation pipeline documentation
│   ├── questionnaire.md           # Companion questionnaire tool reference
│   ├── releases.md                # Release verification and workflow guide
│   └── assets/                    # Standalone SVG banner and architecture diagrams
├── scripts/                       # Packaging, allowlist, and tarball validation scripts
├── tests/                         # Root translation test suites
├── CONTRIBUTING.md                # Contribution guidelines and security boundaries
└── ROADMAP.md                     # Roadmap and host integration status
```
