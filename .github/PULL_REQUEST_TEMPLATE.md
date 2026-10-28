## Summary of Changes

- 

## Verification & Checks Run

- [ ] `npm run check` (TypeScript + test suite)
- [ ] `npm run validate:package` (Manifest allowlist & tarball closure)
- [ ] `node scripts/validate-ask-user-package.mjs` (Companion package validation)
- [ ] `git diff --check`

## Safety & Boundaries

- [ ] Untranslated prose is never submitted (fail-closed)
- [ ] No main-model fallback or hidden network services
- [ ] Sensitive session records remain excluded from LLM context
