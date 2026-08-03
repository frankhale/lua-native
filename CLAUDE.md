# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

lua-native is a native Node.js addon (N-API) that embeds Lua 5.5 (pre-release) into JavaScript/TypeScript applications. It enables bidirectional data exchange and function calls between Node.js and Lua. The module is an ES module (`type: "module"` in package.json).

## Build & Test Commands

```bash
# Build (debug, includes C++ test binary)
npm run build-debug

# Build (release, no test binary)
npm run build-release

# Build (prebuild)
npm run prebuildify

# Run TypeScript tests (Vitest, watch mode by default)
npm test

# Run C++ tests (Google Test)
npm run test-cpp

# Sanitizer harnesses (macOS/Linux; see docs/SANITIZERS.md)
npm run test-cpp-asan   # C++ core under ASan+UBSan
npm run test-ts-asan    # .node addon under ASan+UBSan, via the full vitest suite
npm run test-cpp-tsan   # C++ core under TSan (single-threaded — regression guard)
npm run test-ts-tsan    # addon under TSan, via the async vitest suite

# Source invariants (generated lists vs their frozen answers)
npm run check-invariants
node tools/check-invariants.mjs --update   # re-freeze after a reviewed change

# CR-18 exception-escape matrix (27 Lua C frames x 11 throw kinds, 1 process/cell)
npm run cr18-matrix

# Differential oracle vs stock Lua 5.5 (2678 cases)
# Needs the vcpkg port's interpreter:  vcpkg install lua[tools]
npm run oracle

# Clean build artifacts
npm run clean
```

**Prerequisites:** Lua must be available via vcpkg. The `get_vcpkg_path.js` script resolves include/lib/interpreter paths from the `VCPKG_ROOT` environment variable. Building and testing the addon needs only the library; `npm run oracle` additionally needs the port's interpreter (`vcpkg install lua[tools]`).

**Important:** After C++ changes, you must `npm run build-debug` before running `npm test`. The debug build is required for testing — do not use prebuilt binaries.

**Sanitizers (local, no CI required):** four harnesses cover the memory-safety /
UB / data-race hazard classes the code reviews track. `test-cpp-asan` and
`test-cpp-tsan` instrument the standalone C++ test binary; `test-ts-asan` and
`test-ts-tsan` instrument the `.node` addon and run the full vitest suite under a
preloaded sanitizer runtime (`run-sanitized-ts.js` handles the
`DYLD_INSERT_LIBRARIES` preload and forces vitest's threads pool, since a forked
worker would load the runtime too late). Each `test-*` script rebuilds the target,
so run `build-debug` afterward to return to the normal binary. Highest-value one is
`test-ts-asan` — the binding layer is where handle/finalizer use-after-frees live.
`test-ts-tsan` is a best-effort probe only (TSan can't see libuv/V8/Lua
synchronization, so a clean run is not a proof of race-freedom). Full details, the
preload mechanics, and the July 2026 stress-test results are in
`docs/SANITIZERS.md`. These sanitizers do **not** catch the exception-abort class
(a `std::runtime_error` reaching `std::terminate`, e.g. CR-6 F1) — that is now
the job of `npm run cr18-matrix`, the generated search for that class
(`docs/CODE-REVIEW-18.md`), alongside the CODE-REVIEW-6 behavioral matrix in the
suite. See also `docs/CODE-REVIEW-THOUGHTS.md`.

**Correctness harnesses (`tools/`).** Three things the test suites do not do:

- `npm run check-invariants` — lists that used to live in comments (the
  `CallScope` classification, the `lua_next` traversal sites, the occupancy
  policy set, greppable counts, and every binding call to a `RunProtected`-backed
  core method scored guarded or not) are computed from the source and compared
  against `tools/invariants.expected.json`. `tests/ts/invariants.spec.ts` runs the
  same checks, so drift is a red suite; re-freeze with `--update` so the change
  lands as a reviewable diff. **Do not "fix" a drifted invariant by editing the
  expected file without reading what moved** — the whole point is that the diff
  gets looked at.
- `npm run cr18-matrix` — the exception-escape matrix. Runs its own controls
  first and refuses to proceed if they fail.
- `npm run oracle` — differential testing against stock `lua` from the same
  vcpkg port that supplies `liblua.a`. Requires `vcpkg install lua[tools]`; the
  oracle prints both Lua versions and warns if they differ. The only harness here
  that checks whether an answer is *right* rather than whether nothing crashed.
  See `docs/DIFFERENTIAL-ORACLE.md`.

All three follow the same rule, which is worth knowing before extending any of
them: **an exhaustive search that reports clean must first demonstrate it can
report dirty**, so each runs positive controls before its real work, and each
keeps a ledger of known-acceptable results where every entry carries its reason
and a stale entry is reported rather than silently ignored.

## Architecture

### Two-Layer C++ Design

The native code has a deliberate two-layer separation:

1. **Core layer** (`src/core/lua-runtime.h`, `src/core/lua-runtime.cpp`) — `lua_core::LuaRuntime` class. Pure C++ with no N-API dependency. Manages the Lua state (`lua_State*`), executes scripts, handles globals, userdata, metatables, coroutines, bytecode, and modules. Uses `std::variant`-based `LuaValue` type for all Lua↔C++ data exchange.

2. **Binding layer** (`src/lua-native.h`, `src/lua-native.cpp`) — `LuaContext` class (extends `Napi::ObjectWrap`). N-API wrapper that converts between `Napi::Value` and `lua_core::LuaValue`, manages JavaScript object references (`Napi::Reference`), and exposes the public API to JS.

Data flows: **JS ↔ N-API (LuaContext) ↔ Core (LuaRuntime) ↔ Lua state**

### Lua Reference Management

Lua objects that cross the C++ boundary (functions, coroutines, userdata, metatabled tables) are stored in the Lua registry via `luaL_ref` and wrapped in ref structs (`LuaFunctionRef`, `LuaThreadRef`, `LuaUserdataRef`, `LuaTableRef`). These use move semantics — `release()` calls `luaL_unref`. The binding layer wraps these in `*Data` structs (e.g., `LuaFunctionData`) that pair the ref with a `shared_ptr<LuaRuntime>` to ensure correct destruction order.

### Module Entry Point

`index.js` is an ES module loader that tries multiple paths (prebuilds → debug → release → node-gyp-build) to find the compiled `.node` binary. It exports the native module as default.

### Type Definitions

`types.d.ts` contains the full TypeScript API. `index.d.ts` re-exports it. Key types: `LuaContext`, `LuaValue`, `LuaTable`, `LuaTableRef`, `LuaFunction`, `LuaCoroutine`, `MetatableDefinition`, `UserdataOptions`.

### Test Structure

- **TypeScript tests:** `tests/ts/lua-native.spec.ts` (~2900 lines, 256+ tests) — comprehensive coverage of all features
- **C++ tests:** `tests/cpp/lua-native-test.cpp` — Google Test suite for `LuaRuntime` directly
- **Fixtures:** `tests/fixtures/*.lua` — Lua scripts used by tests

### Key Features & Their Implementation Locations

| Feature                         | Core (lua-runtime.cpp)                                                        | Binding (lua-native.cpp)                         |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| Script/file execution           | `ExecuteScript`, `ExecuteFile`                                                | `ExecuteScript`, `ExecuteFile`                   |
| Async execution                 | —                                                                             | `ExecuteScriptAsync` (uses `lua-async-worker.h`) |
| Globals                         | `SetGlobal`, `GetGlobal`                                                      | `SetGlobal`, `GetGlobal`                         |
| Userdata (opaque/proxy/methods) | `CreateUserdataGlobal`, `CreateProxyUserdataGlobal`, `SetUserdataMethodTable` | `SetUserdata`                                    |
| Metatables                      | `SetGlobalMetatable`, `StoreHostFunction`                                     | `SetMetatable`                                   |
| Coroutines                      | `CreateCoroutine`, `ResumeCoroutine`                                          | `CreateCoroutine`, `ResumeCoroutine`             |
| Bytecode                        | `CompileScript`, `CompileFile`, `LoadBytecode`                                | `Compile`, `CompileFile`, `LoadBytecode`         |
| Modules/require                 | `RegisterModuleTable`, `AddSearchPath`                                        | `RegisterModule`, `AddSearchPath`                |
| Reference tables                | `GetTableField`, `SetTableField`, etc.                                        | Exposed via JS Proxy in `CoreToNapi`             |

## Documentation

Detailed design docs live in `docs/`: `ASYNC.md`, `BYTECODE.md`, `FEATURES.md`, `FUTURE.md`, `REQUIRE.md`, `USERDATA.md`, `USERDATA-METHOD-BINDING.md`. Consult these before implementing features on the roadmap.

## Conventions

- C++17 standard, compiled via node-gyp (`binding.gyp`)
- N-API version 8, with `NODE_ADDON_API_CPP_EXCEPTIONS` enabled
- Platform targets: macOS (arm64, x64), Windows (x64)
- All public `LuaRuntime` methods that can fail return `ScriptResult` (`variant<vector<LuaPtr>, string>`) where the string variant is an error message
- `LuaValue` uses `std::variant` with `std::monostate` for nil — use the `LuaValue::from()` factory functions
- Max recursion depth for table conversion: `kMaxDepth = 100`
