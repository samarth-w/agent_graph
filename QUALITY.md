# Quality Policy

## Required Gates

A change is considered merge-ready when all of the following pass:

1. Build: `npm run build`
2. Tests with coverage thresholds: `npm run test:coverage`
3. Performance budget checks: `npm run check:performance`
4. Combined local gate: `npm run verify`

## Expected Standards

- No unverified success claims without command evidence.
- New behavior requires tests.
- Security-impacting changes require threat-surface notes in docs.
- Performance claims should link to reproducible benchmark scripts and inputs.
