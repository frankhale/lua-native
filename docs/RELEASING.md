# Releasing

Checklist for publishing `lua-native` to npm. Written up in response to
CODE-REVIEW-5 finding F8 (the tree shipped prebuilds for one of the two
supported platforms) and CODE-REVIEW-3 M5, which was the deferred
deployment-target decision — **M5 is settled as of August 10, 2026**: the
target is `13.5` and Lua is built to match via the overlay triplet. Step 1 is
now a verification, not a change.

**Supported targets: `darwin-arm64` and `win32-x64`.**

"Before publishing" is the preparation; "Publishing to npm" below is the
publish itself. **Nothing enforces the order automatically** — there is no
`prepublishOnly` or `prepack` script in `package.json`, so `npm publish` will
cheerfully ship whatever is in the working tree. This checklist is the guard.

## Before publishing

1. **Check the macOS deployment target and what Lua was built against.**
   This was CODE-REVIEW-3 M5 — `binding.gyp` used to set
   `MACOSX_DEPLOYMENT_TARGET` to `"26.0"`, deliberate for local development
   (single current user) but a package restricted to very recent macOS. **It is
   now `"13.5"`, in both of the two places `binding.gyp` sets it** (the addon
   target and the standalone C++ test target), matching the `minos` of the
   official Node 24 macOS arm64 build. The step is no longer a change to make;
   it is a pair of facts to confirm, because either can silently regress.

   The library matters as much as the flag. vcpkg's stock `arm64-osx` triplet
   sets no deployment target, so a bare `vcpkg install lua` builds `liblua.a`
   against the host SDK and the addon ends up claiming a minimum macOS it was
   never linked for. `triplets/arm64-osx.cmake` is an overlay that pins
   `VCPKG_OSX_DEPLOYMENT_TARGET 13.5`, and it applies only when
   `--overlay-triplets` is passed — which is the whole reason `npm run
   vcpkg-lua` exists. See the README's "vcpkg and Lua" section.

   ```bash
   grep -n MACOSX_DEPLOYMENT_TARGET binding.gyp        # expect 13.5, twice
   npm run vcpkg-lua                                   # prints liblua.a's minos
   otool -l prebuilds/darwin-arm64/lua-native.node | grep -A3 LC_BUILD_VERSION
   ```

   All three must agree on 13.5. **`prebuilds/` is gitignored, so lowering the
   target in `binding.gyp` does not by itself change what consumers get** — the
   binary has to be rebuilt and re-prebuilt afterwards, which is step 2. A
   prebuild produced before the change still carries the old `minos`; the
   `otool` line above is what catches that.

2. **Build a prebuild for every supported platform.** `prebuilds/` is
   gitignored and is regenerated locally at release time, never committed.
   Without `win32-x64`, a Windows consumer gets the "no prebuilt binary for
   this platform" error from `index.js` — **not** a source build, since the
   tarball no longer ships `src/`, `binding.gyp` or `get_vcpkg_path.js` (see
   step 4). Both platforms must be present before publishing.

   On each target machine:

   ```bash
   npm install
   npm run build-release
   ```

   Expected result, one per platform-arch:

   ```
   prebuilds/darwin-arm64/lua-native.node
   prebuilds/win32-x64/lua-native.node
   ```

   Cross-building is not set up, so the Windows binary has to come from a
   Windows machine and be copied into `prebuilds/win32-x64/` by hand.

3. **Keep one binary per platform directory, named `lua-native.node`.**
   `index.js` looks for `prebuilds/<platform>-<arch>/lua-native.node`
   explicitly, and only falls through to `node-gyp-build` — which resolves
   `prebuildify`'s `node.napi.node` convention instead — as a last resort. Both
   names therefore load, but by different routes. `npm run prebuildify`
   deposits `node.napi.node` *alongside* any existing `lua-native.node`,
   leaving two binaries of unknown relative vintage in one directory, and the
   older-named one wins. If you use `prebuildify`, rename its output to
   `lua-native.node` rather than shipping both.

4. **Verify the packed tarball.** `npm pack --dry-run` and confirm it contains
   exactly `index.js`, `index.d.ts`, `types.d.ts`, `package.json`, `README.md`,
   `LICENSE`, and one `prebuilds/<platform>/lua-native.node` per supported
   platform. The `files` list is prebuilds-only: **no `src/`, no `binding.gyp`,
   no `get_vcpkg_path.js`**, so a consumer on an unshipped platform cannot
   compile from the package and is sent to the issue tracker instead. That is
   the intended behaviour — it is also why step 2 is not optional.

5. **Smoke-test the tarball as a consumer would**, in a directory with no
   `VCPKG_ROOT` and no build toolchain expectations:

   ```bash
   npm pack
   cd $(mktemp -d) && npm init -y && npm i /path/to/lua-native-*.tgz
   node -e "import('lua-native').then(m => { const l = new m.default.init({}, {libraries:'all'}); console.log(l.execute_script('return 6*7')); })"

   # macOS: the installed binary, not the one in the source tree
   otool -l node_modules/lua-native/prebuilds/darwin-arm64/lua-native.node \
     | grep -A3 LC_BUILD_VERSION
   ```

   This step also exercises the `install` script (`node-gyp-build`), which is
   the one place a consumer install can still reach for a compiler. It must
   resolve the shipped `lua-native.node` and do nothing; if it instead falls
   through to `node-gyp rebuild` it will fail, because the tarball has no
   `binding.gyp`. A clean `npm i` here is the proof that it doesn't.

6. **Run both suites against a release build**, not just the debug one:

   ```bash
   npm run build-release && npx vitest run
   npm run build-debug && npm run test-cpp
   ```

   Note the ordering hazard: `build-release`, `build-debug` and `prebuildify`
   all invoke `node-gyp rebuild`, which **wipes the other configuration's
   output**. Whatever you do last is what's on disk. Do the prebuild work
   (step 2) *after* the test runs, and **never run `npm run clean` afterwards** —
   its `rmSync` list includes `prebuilds/`, so it deletes exactly the artifacts
   you are about to publish.

## Publishing to npm

`lua-native` is an **unscoped, public** package. It is already on the registry —
`latest` is `1.0.4`; the working tree is at `1.1.0`. Publishing happens from a
maintainer's macOS machine, with the Windows binary copied in by hand (step 2),
because `npm publish` packs whatever `prebuilds/` contains locally.

### 1. Authenticate

```bash
npm whoami          # ENEEDAUTH means you are not logged in
npm login           # opens a browser; the account needs publish rights
```

The npm account should have 2FA on. With "Require two-factor authentication"
set for writes, every publish needs a one-time code — pass it inline rather
than waiting for the prompt to time out:

```bash
npm publish --otp=123456
```

### 2. Set the version

The registry rejects a republish of an existing version, so the version in
`package.json` must be new. Either bump it in place, or let npm do it:

```bash
npm version patch     # 1.1.0 -> 1.1.1, commits and tags v1.1.1
npm version minor     # 1.1.0 -> 1.2.0
npm version major     # 1.1.0 -> 2.0.0
```

`npm version` writes `package.json`, creates a commit and an annotated tag in
one step. If you would rather control the commit yourself, edit the `version`
field by hand and tag afterwards (`git tag -a v1.1.0 -m 'v1.1.0'`). Either way
**tag it** — the repo has only `v1.0.0`, so `1.0.1` and `1.0.4` shipped without
tags and there is no commit on record for what those users received.

Choose the number by what changed for a *consumer*, not by how much code moved.
1.1.0 is a case in point: no API changed, but the package stopped shipping
`src/` and `binding.gyp`, so a consumer on an unsupported platform who used to
get a source build now gets an error. That is consumer-visible and belongs in
the release notes.

### 3. Dry-run the publish

`--dry-run` does everything except upload, and prints the file list and the
resolved version:

```bash
npm publish --dry-run
```

Confirm the version is what you intend and the contents match step 4 above —
8 files: `index.js`, `index.d.ts`, `types.d.ts`, `package.json`, `README.md`,
`LICENSE`, and the two `prebuilds/<platform>/lua-native.node` binaries. **A
missing prebuild is silent here** — it just shows up as a shorter list, so
count the platform directories rather than skimming.

### 4. Publish

```bash
npm publish --otp=123456
```

`--access public` is only needed for *scoped* packages; unscoped packages are
public by default, and passing it is harmless but unnecessary. No `--provenance`
is used: it requires a supported CI publisher, and releases here are cut
locally.

To ship a prerelease **without moving `latest`**, publish under another dist-tag:

```bash
npm version prerelease --preid=beta   # 1.1.0 -> 1.1.1-beta.0
npm publish --tag next --otp=123456
```

Consumers then get it only via `npm i lua-native@next`. Promote later with
`npm dist-tag add lua-native@1.1.1 latest`.

### 5. Verify the published artifact

Registry state, then a real consumer install from the registry (not from a local
tarball — this is the one check that exercises the published bits end to end):

```bash
npm view lua-native version
npm view lua-native dist-tags
npm view lua-native@<version> dist.fileCount dist.unpackedSize

cd $(mktemp -d) && npm init -y && npm i lua-native
node -e "import('lua-native').then(m => { const l = new m.default.init({}, {libraries:'all'}); console.log(l.execute_script('return 6*7')); })"
```

Then push the tag, so the published version is traceable to a commit:

```bash
git push && git push --tags
```

### If a publish goes wrong

`npm unpublish lua-native@<version>` works only within **72 hours** of
publishing, and republishing that same version number is then blocked forever —
so unpublishing costs you the version number. Prefer marking it instead, which
leaves installs working while warning anyone who takes it:

```bash
npm deprecate lua-native@1.1.0 "Broken prebuild; use 1.1.1"
```

Then fix, bump, and publish the successor.

## Type definitions

`index.d.ts` imports from `./types.js` (not `./types`). The explicit extension
is required: the package is `"type": "module"`, so consumers using TypeScript's
`node16`/`nodenext` module resolution get a hard error on an extensionless
relative import (CODE-REVIEW-5 F12). Keep the extension if these files are
reorganized.
