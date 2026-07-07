# Release process

## Continuous integration

Every push and pull request to `main` runs [.github/workflows/ci.yml](../.github/workflows/ci.yml):

- Installs dependencies with `npm ci`.
- Builds the TypeScript sources with `npm run build`.
- Runs the full test suite with `npm test`.
- Enforces the performance budget with `npm run check:performance`.

The matrix runs against Node.js 18.x and 20.x.

## Cutting a release

1. Bump the version in [package.json](../package.json).
2. Commit the version bump and push to `main`.
3. Create and push a tag matching `vMAJOR.MINOR.PATCH`, for example:

   ```bash
   git tag v0.4.0
   git push origin v0.4.0
   ```

4. [.github/workflows/release.yml](../.github/workflows/release.yml) triggers automatically and:
   - Builds and tests the package.
   - Packs a release tarball with `npm pack`.
   - Creates a GitHub release with auto-generated notes and attaches the tarball.
   - Publishes to npm if an `NPM_TOKEN` repository secret is configured.

## Local verification before tagging

Run the same checks CI runs before cutting a release:

```bash
npm run verify
```
