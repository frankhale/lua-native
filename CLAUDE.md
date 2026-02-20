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
npm run prebuild

# Run TypeScript tests (Vitest, watch mode by default)
npm test

# Run C++ tests (Google Test)
npm run test-cpp

# Clean build artifacts
npm run clean
```

**Prerequisites:** Lua must be available via vcpkg. The `get_vcpkg_path.js` script resolves include/lib paths from `VCPKG_ROOT` environment variable.

**Important:** After C++ changes, you must `npm run build-debug` before running `npm test`. The debug build is required for testing — do not use prebuilt binaries.

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
