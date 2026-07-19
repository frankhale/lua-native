# Releasing

Checklist for publishing `lua-native` to npm. Written up in response to
CODE-REVIEW-5 finding F8 (the committed tree ships prebuilds for one of the
three supported platforms) and the still-deferred CODE-REVIEW-3 M5.

## Before publishing

1. **Lower the macOS deployment target.** `binding.gyp` sets
   `MACOSX_DEPLOYMENT_TARGET` to `"26.0"`, which is deliberate for local
   development (single current user) but would restrict a published package to
   very recent macOS. Set it to `"11.0"` before the first outside release.
   This is CODE-REVIEW-3 M5, deferred by decision — releasing is the event
   that un-defers it.

2. **Build a prebuild for every supported platform.** `prebuilds/` currently
   contains `darwin-arm64` only. Without the others, `npm install lua-native`
   on `darwin-x64` or `win32-x64` falls through `node-gyp-build` to
   `node-gyp rebuild`, which requires the *consumer* to have `VCPKG_ROOT` set
   and Lua installed via vcpkg — an install failure for anyone without a
   development setup.

   On each target machine (or via CI runners):

   ```bash
   npm ci
   npm run prebuildify   # prebuildify --napi --strip
   ```

   Expected result, one per platform-arch:

   ```
   prebuilds/darwin-arm64/node.napi.node
   prebuilds/darwin-x64/node.napi.node
   prebuilds/win32-x64/node.napi.node
   ```

3. **Reconcile the legacy prebuild name.** The committed
   `prebuilds/darwin-arm64/lua-native.node` predates `prebuildify` and does not
   follow its `node.napi.node` convention. `node-gyp-build` still resolves it
   (tag guards are skipped when no tags are present), but running
   `npm run prebuildify` deposits `node.napi.node` *alongside* it, leaving two
   binaries of unknown relative vintage in one directory. Delete the legacy
   file once real prebuilds are generated.

4. **Verify the packed tarball.** `npm pack --dry-run` and confirm it contains
   `index.js`, `index.d.ts`, `types.d.ts`, `binding.gyp`, `get_vcpkg_path.js`,
   `src/**`, and every `prebuilds/**` binary — and that it does *not* contain
   `tests/` or `vendor/` (the C++ test target's inputs, which a consumer source
   build must never need; `skip_test` defaults to 1 to keep that true).

5. **Smoke-test the tarball as a consumer would**, in a directory with no
   `VCPKG_ROOT` and no build toolchain expectations:

   ```bash
   npm pack
   cd $(mktemp -d) && npm init -y && npm i /path/to/lua-native-*.tgz
   node -e "import('lua-native').then(m => { const l = new m.default.init({}, {libraries:'all'}); console.log(l.execute_script('return 6*7')); })"
   ```

6. **Run both suites against a release build**, not just the debug one:

   ```bash
   npm run build-release && npx vitest run
   npm run build-debug && npm run test-cpp
   ```

## Type definitions

`index.d.ts` imports from `./types.js` (not `./types`). The explicit extension
is required: the package is `"type": "module"`, so consumers using TypeScript's
`node16`/`nodenext` module resolution get a hard error on an extensionless
relative import (CODE-REVIEW-5 F12). Keep the extension if these files are
reorganized.
