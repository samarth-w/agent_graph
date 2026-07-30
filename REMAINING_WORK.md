# Remaining Work Before Publish/Release

This file tracks what is still open after the provenance + invalidation evaluation updates.

## Completed in this branch

- Fixed L4 fingerprint soundness bug in TypeScript identifier canonicalization.
- B5 false negatives reduced from 5 to 0 on the current gold corpus.
- Added invalidation quality gate:
  - `fixtures/invalidation-quality-budget.json`
  - `scripts/check-invalidation-budget.mjs`
  - wired into `package.json` `check:invalidation` and `verify`
  - wired into `.github/workflows/ci.yml`
- Added provenance baseline version guard (`provenance_baseline_version`) so incompatible baselines force safe revalidation.
- Added/expanded tests for fingerprinting and tree-sitter behavior.

## Remaining (engineering)

1. Phase 2.2 incremental scope
- `syncProvenance` still computes and replaces full symbol baseline each run.
- `indexProject` should return changed symbol qnames and provenance sync should accept a scoped changed set.
- `replaceSymbolFingerprints` needs a scoped/incremental write path (not full delete+reinsert).

2. Evaluate skipped judgements
- `skipped` is still high (`6966`) from symbol disappearance or missing fingerprints in generated comparisons.
- Keep diagnosing and reduce avoidable skips where possible.

3. Stabilize and re-run full verify in one command
- Run `npm run verify` after all final tweaks and ensure green in local + CI matrix.
- Watch for Windows-specific timing flakes in git-heavy tests.

4. Update README claims for reproducibility
- Re-check or caveat the `21.4x` claim with reproducible command + pinned conditions.
- Add provenance/eval section with current metrics and quality-gate policy.

## Remaining (publication/IP)

1. Prior-art package and differentiation write-up
- Incremental computation + RTS + agent-memory invalidation comparison table.

2. Patent/IP disclosure draft
- 1 independent + 3 dependent claims with implementation mapping.

3. Paper packaging
- Venue-targeted draft, threats-to-validity section, and reproducibility appendix.

## Current key metric snapshot

From `reports/invalidation-eval.json` (fingerprint level 4):

- B5_cgraph: precision `0.5676`, recall `1.0`, F1 `0.7242`, KRR `0.9854`
- B2_file_hash: precision `0.0188`, recall `1.0`, F1 `0.0369`, KRR `0.0`
- `unsafeArms`: `B4_lexical` only
