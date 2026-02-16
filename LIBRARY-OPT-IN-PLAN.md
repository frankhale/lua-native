# Plan: Opt-In Standard Library Loading with Presets

## Context

lua-native currently loads all 10 Lua standard libraries by default. For an embedding library, this is a security concern — `io`, `os`, and `debug` provide file system access, shell execution, and introspection. Changing the default to **no libraries** (opt-in) forces users to be explicit about their needs. Presets (`'all'`, `'safe'`) provide ergonomic shortcuts.

## Files to Modify

1. `src/core/lua-runtime.h` — Constructor signatures, add static helpers
2. `src/core/lua-runtime.cpp` — Constructor implementations, static helpers
3. `src/lua-native.cpp` — N-API constructor: preset string handling, new default
4. `types.d.ts` — Add `LuaLibraryPreset` type, update `LuaInitOptions`
5. `index.d.ts` — Export new types
6. `tests/cpp/lua-native-test.cpp` — Update ~92 `LuaRuntime` constructions + library tests
7. `tests/ts/lua-native.spec.ts` — Update ~150 `lua_native.init()` calls + library tests
8. `FEATURES.md` — Update architecture docs
9. `README.md` — Update examples, API reference

## Implementation Steps

### Step 1: Core C++ (`lua-runtime.h` / `lua-runtime.cpp`)

- **Remove** `explicit LuaRuntime(bool openStdLibs = true)`
- **Add** `LuaRuntime()` — bare state, no libraries
- **Keep** `LuaRuntime(const std::vector<std::string>& libraries)` unchanged
- **Add** static helpers:
  ```cpp
  static std::vector<std::string> AllLibraries();
  static std::vector<std::string> SafeLibraries();  // excludes io, os, debug
  ```

### Step 2: C++ Tests

- Replace all `LuaRuntime rt;` / `const LuaRuntime rt;` with `LuaRuntime rt(LuaRuntime::AllLibraries());`
- Rewrite `LuaRuntimeLibraries` suite:
  - `AllLibsLoadedByDefault` → `BareStateByDefault` (verify no libs)
  - Add `AllLibsViaHelper` and `SafeLibsViaHelper` tests
  - Remove `BoolConstructorStillWorks` (bool constructor gone)
- Build and run `npm run test-cpp`

### Step 3: N-API Constructor (`lua-native.cpp`)

- No options / no `libraries` field → `LuaRuntime()` (bare state)
- `libraries: 'all'` → `LuaRuntime(LuaRuntime::AllLibraries())`
- `libraries: 'safe'` → `LuaRuntime(LuaRuntime::SafeLibraries())`
- `libraries: [...]` → unchanged (specific array)
- Unknown preset string → `TypeError`

### Step 4: TypeScript Types (`types.d.ts`, `index.d.ts`)

- Add `LuaLibraryPreset = 'all' | 'safe'`
- Update `LuaInitOptions.libraries` to accept `LuaLibrary[] | LuaLibraryPreset`
- Update JSDoc: "If omitted, NO libraries are loaded (bare state)"
- Export `LuaLibraryPreset`, `LuaInitOptions`, `LuaLibrary`, `LuaTableRef` from `index.d.ts`

### Step 5: TypeScript Tests

- Add `const ALL_LIBS = { libraries: 'all' as const };` at top of file
- Update ~150 `new lua_native.init()` / `new lua_native.init({...})` calls to include `ALL_LIBS`
- Rewrite selective library loading tests:
  - Default → bare state test
  - Add preset `'all'` and `'safe'` tests
  - Add unknown preset error test
- Rename prebuilds, run `npm test`, restore prebuilds

### Step 6: Documentation

- **README.md**: Update examples to show `{ libraries: 'all' }`, document presets, update API reference
- **FEATURES.md**: Update selective library loading section to reflect new default and presets

## Verification

1. `npm run build-debug` — no warnings
2. `npm run prebuild`
3. `npm run test-cpp` — all C++ tests pass
4. `npm test` — all TS tests pass
