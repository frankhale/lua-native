# Dev Container Plan

A plan for developing and building `lua-native` inside a VS Code / GitHub Codespaces dev container.

## Goal

A container where a fresh clone can run:

```bash
npm run build-debug   # native addon + C++ test binary
npm test              # Vitest
npm run test-cpp      # Google Test
```

...with no host toolchain setup beyond Docker.

## The central problem: this project does not build on Linux today

A dev container is Linux. Two files hard-code a Windows/macOS-only world:

**`get_vcpkg_path.js`** picks a vcpkg triplet from `os.platform()`. Linux falls into the
`else` branch, which prints a warning and returns the triplet `x64-unknown` — a directory
that will never exist. Every `include_dirs` / `libraries` entry in `binding.gyp` is
populated by shelling out to this script, so on Linux the build gets a garbage include path
and a garbage `liblua.a` path.

**`binding.gyp`** has `conditions` for `OS=='win'` and `OS=='mac'` and nothing else. On
Linux, neither branch fires, so the target never receives `-fPIC`, never defines
`LUA_STATIC`, and inherits node-gyp's default `cflags_cc` of `-fno-rtti -fno-exceptions`.
That last part is fatal: the addon is compiled with `NODE_ADDON_API_CPP_EXCEPTIONS`, the
core uses `std::variant`, and Google Test wants RTTI.

So the dev container work is really two pieces of work: **add Linux to the build**, then
**wrap it in a container**. The container cannot paper over the first part.

`index.js` already resolves `linux-${arch}` prebuild paths and `run-tests.js` already looks
in `build/Debug/`, so the JS side needs no changes.

## Step 1 — Teach the build about Linux

### 1a. `get_vcpkg_path.js`

Replace the unsupported-platform fallback with real triplet selection. vcpkg's Linux
triplets are static by default, so the existing `liblua.a` library name is already correct.

```js
} else if (platform === "linux") {
  triplet = (arch === "arm64" || arch === "aarch64") ? "arm64-linux" : "x64-linux";
} else {
  ...
}
```

`arm64-linux` matters — an Apple Silicon host runs `linux/arm64` containers by default.

### 1b. `binding.gyp`

Add an `OS=='linux'` condition to **both** targets (`lua-native` and `lua-native-test`),
mirroring the macOS block:

```python
["OS=='linux'", {
  "defines": [ "LUA_STATIC" ],
  "cflags": [ "-fPIC" ],
  "cflags_cc": [ "-std=c++17", "-fPIC", "-fexceptions", "-frtti" ]
}]
```

`-fexceptions` and `-frtti` are the load-bearing flags; they override node-gyp's
`common.gypi` defaults because later flags win. `-fPIC` is needed to link the static
`liblua.a` into a shared `.node`.

Note that vcpkg builds Lua with `CMAKE_POSITION_INDEPENDENT_CODE=ON`, so `liblua.a` itself
is PIC-clean. If a `relocation R_X86_64_PC32 against symbol` link error appears anyway,
that assumption broke and the triplet needs a custom `VCPKG_CMAKE_CONFIGURE_OPTIONS`.

### 1c. `CMakeLists.txt` (optional)

The CMake path (`npm run build-cmake-debug`) has the same gap — its `else()` branch emits
"Unsupported platform" and sets `x64-unknown`. node-gyp is the primary path and is what the
container will use, so this is lower priority. Fix it for parity if the CMake build is
meant to stay supported; otherwise note in the doc that CMake is macOS/Windows only.

## Step 2 — Lua 5.5 has to come from vcpkg

There is no `vcpkg.json` manifest in this repo — it uses vcpkg **classic mode** and reads
`$VCPKG_ROOT/installed/<triplet>/`. So the image must bootstrap vcpkg and run
`vcpkg install lua` at build time.

Debian's `liblua5.4-dev` is **not** a substitute. This project targets Lua 5.5 (confirmed:
`LUA_VERSION_MINOR_N 5` in the vcpkg-installed `lua.h`), and 5.5 changed enough of the C API
that 5.4 headers will not compile `lua-runtime.cpp`.

Pin the vcpkg checkout to a commit known to carry `lua` at version `5.5.0`. The local
working checkout is at `1e199d32ad` (2026-03-06), whose `ports/lua/vcpkg.json` declares
`"version": "5.5.0"`. Pinning also keeps image builds reproducible.

Ordering constraint: `package.json` defines `"install": "cross-env GYP_DEFINES=... node-gyp-build"`,
which means **`npm install` itself compiles the addon**. Lua must therefore be installed in
the image *before* `npm install` ever runs in `postCreateCommand`. Getting this backwards
produces a confusing `npm install` failure rather than an obvious "Lua not found."

## Step 3 — Files to create

```
.devcontainer/
  devcontainer.json
  Dockerfile
```

### `.devcontainer/Dockerfile`

Base on the Microsoft dev container Node image (Debian 12 "bookworm", Node 24 LTS). It is
current, multi-arch (amd64 + arm64), and ships a non-root `node` user.

```dockerfile
FROM mcr.microsoft.com/devcontainers/javascript-node:2-24-bookworm

# node-gyp needs python3/make/g++; vcpkg needs curl/zip/unzip/tar/git/pkg-config,
# and on arm64 it needs system cmake + ninja.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
 && apt-get install -y --no-install-recommends \
      build-essential python3 pkg-config \
      curl zip unzip tar git \
      cmake ninja-build \
 && rm -rf /var/lib/apt/lists/*

ENV VCPKG_ROOT=/opt/vcpkg
ENV VCPKG_FORCE_SYSTEM_BINARIES=1
ENV PATH="${VCPKG_ROOT}:${PATH}"

ARG VCPKG_COMMIT=1e199d32ad
RUN git clone https://github.com/microsoft/vcpkg.git "${VCPKG_ROOT}" \
 && git -C "${VCPKG_ROOT}" checkout "${VCPKG_COMMIT}" \
 && "${VCPKG_ROOT}/bootstrap-vcpkg.sh" -disableMetrics \
 && "${VCPKG_ROOT}/vcpkg" install lua \
 && chown -R node:node "${VCPKG_ROOT}"
```

`VCPKG_FORCE_SYSTEM_BINARIES=1` is required on arm64 — vcpkg does not ship prebuilt
cmake/ninja for that arch and will otherwise try to download x64 binaries and fail. Setting
it unconditionally is harmless on x64 and keeps one code path.

`vcpkg install lua` with no triplet uses the host default (`x64-linux` / `arm64-linux`),
which is exactly what step 1a teaches `get_vcpkg_path.js` to look for.

The final `chown` matters: the container runs as `node`, and vcpkg writes lockfiles into its
own root even for read-only operations.

### `.devcontainer/devcontainer.json`

```jsonc
{
  "name": "lua-native",
  "build": { "dockerfile": "Dockerfile" },
  "remoteUser": "node",

  "containerEnv": {
    "VCPKG_ROOT": "/opt/vcpkg",
    "VCPKG_FORCE_SYSTEM_BINARIES": "1"
  },

  // Keep host (darwin-arm64) artifacts out of the Linux container.
  "mounts": [
    "source=lua-native-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume",
    "source=lua-native-build,target=${containerWorkspaceFolder}/build,type=volume"
  ],

  "postCreateCommand": "sudo chown node:node node_modules build && git submodule update --init --recursive && npm install && npm run build-debug",

  "customizations": {
    "vscode": {
      "extensions": [
        "ms-vscode.cpptools-extension-pack",
        "vitest.explorer",
        "sumneko.lua"
      ]
    }
  }
}
```

Three details worth calling out:

**The volume mounts are not an optimization.** The workspace is bind-mounted from the host,
which already contains `node_modules/` and `build/` full of `darwin-arm64` binaries. Without
volumes shadowing them, the container will happily `require()` a Mach-O `.node` and fail with
an unhelpable error. Docker creates fresh volumes owned by `root`, hence the `chown` at the
head of `postCreateCommand`.

**`git submodule update --init --recursive` is mandatory**, not hygiene. `binding.gyp`'s
test target compiles `vendor/googletest/googletest/src/gtest-all.cc` directly, and
googletest is a submodule. An uninitialized submodule breaks `build-debug`, which is the
build the tests require.

**`npm install` and `npm run build-debug` are both listed** even though `install` already
builds. The `install` hook builds release-mode via `node-gyp-build` with `skip_test=1`; per
`CLAUDE.md`, testing requires the debug build with the C++ test binary. Running both is
redundant-looking but correct.

## Step 4 — Verify

Inside the container, in order — each step gates the next:

1. `echo $VCPKG_ROOT && ls $VCPKG_ROOT/installed` → expect `x64-linux` or `arm64-linux`.
2. `npm run get-vcpkg-include` and `npm run get-vcpkg-lib` → expect real paths, no
   "Unsupported platform" warning, and `test -f "$(npm run get-vcpkg-lib --silent)"` passes.
3. `npm run build-debug` → produces `build/Debug/lua-native.node` and
   `build/Debug/lua-native-test`.
4. `npm run test-cpp` → Google Test suite green.
5. `npm test -- --run` → the ~256 Vitest tests green. (Bare `npm test` starts watch mode.)

Step 2 failing means step 1a is wrong. Step 3 failing on `-fno-exceptions` / RTTI errors
means step 1b is wrong. That split is the fastest way to localize a bad first run.

## Risks and open questions

**Prebuilds.** `prebuilds/` currently holds only `darwin-arm64`, and `.gitignore` ignores
the directory. Nothing here changes that; the container builds from source every time. If
Linux prebuilds are ever wanted, `npm run prebuild` inside the container is the mechanism —
but that is a separate decision from this plan.

**Image build time.** Cloning vcpkg and compiling Lua adds roughly 2–5 minutes to the
initial image build. It is cached in the image layer, so it costs once per Dockerfile
change, not once per container start. If that becomes annoying, a vcpkg binary cache
mounted at `/opt/vcpkg-cache` (via `VCPKG_DEFAULT_BINARY_CACHE`) is the escape hatch.

**vcpkg commit pin vs. Lua 5.5 stability.** Lua 5.5 is a pre-release; the vcpkg port version
`5.5.0` may be re-pointed at a different upstream snapshot over time. The pinned commit
insulates the container from that, but it also means the container can drift from whatever a
developer has in their host vcpkg. Worth deciding whether the pin should be bumped
deliberately or tracked against the host.

**`MACOSX_DEPLOYMENT_TARGET: "26.0"`** in `binding.gyp` is inside the `OS=='mac'` block and
is inert on Linux. No action, noted only so it is not mistaken for a container problem.

**CMake path stays broken on Linux** unless step 1c is done. If someone runs
`npm run build-cmake-debug` in the container it will fail at `find_package(Lua REQUIRED)`
with the `x64-unknown` triplet. Either fix it or document it as unsupported.
