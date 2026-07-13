# Contributing to cgraph

Thanks for improving cgraph.

## Development Setup

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Run tests with coverage gates: `npm run test:coverage`
4. Run full local gate: `npm run verify`

## Pull Request Guidelines

- Keep changes focused and explain motivation and risk.
- Add or update tests for behavior changes.
- Update docs for command/config/API changes.
- Keep CI green on Node 18 and Node 20.

## Commit Guidance

- Prefer conventional, scoped commit messages.
- Include benchmark or test evidence for performance/security changes.

## Issue Reporting

Please include:

- Environment (OS, Node version)
- Repro steps
- Expected vs actual behavior
- Relevant logs or stack traces
