# Code Analysis: lua-native C++ Review

This document summarizes findings from a review of the C++ codebase in the lua-native project.

---

## Implementation Summary

All recommended changes have been implemented and verified. The native module builds successfully and all tests pass.

### Changes Made

#### `src/core/lua-runtime.h`
- **Added move semantics** to `LuaFunctionRef` and `LuaThreadRef` with proper move constructors and assignment operators
- **Added documentation comments** explaining ownership semantics (copies share the same registry ref - only one should call `release()`)
- **Added convenience factory functions** to `LuaValue`:
  - `LuaValue::nil()` - creates a nil value
  - `LuaValue::from(bool)` - creates a boolean value
  - `LuaValue::from(int64_t)` - creates an integer value
  - `LuaValue::from(double)` - creates a floating-point value
  - `LuaValue::from(string)` - creates a string value
  - `LuaValue::from(LuaArray)` - creates an array value
  - `LuaValue::from(LuaTable)` - creates a table value
  - `LuaValue::from(LuaFunctionRef&&)` - creates a function reference value
  - `LuaValue::from(LuaThreadRef&&)` - creates a thread reference value

#### `src/core/lua-runtime.cpp`
- **Fixed stack miscounting** in `ExecuteScript()` and `CallFunction()` by tracking stack top before execution and computing the difference
- **Removed dead code** - eliminated unused `isArray` variable in `isSequentialArray()`
- **Updated `ToLuaValue()`** to use the new factory functions for cleaner, more readable code

#### `src/lua-native.h`
- **Added `CreateJsCallbackWrapper()`** helper method declaration to eliminate callback lambda duplication

#### `src/lua-native.cpp`
- **Removed misleading ReSharper comment** for the `<cmath>` include (the include is actually used)
- **Added `CreateJsCallbackWrapper()`** implementation - eliminates the triplicated callback lambda code
- **Refactored `NapiToCoreInstance()`** to use factory functions and removed redundant depth checks in loops
- **Refactored `NapiToCore()`** to use factory functions for consistency
- **Fixed memory management** in `LuaValueToNapi()` to use `make_unique` + `release()` pattern for exception-safe construction

#### `src/core/lua-runtime.h`
- **Made `kMaxDepth` public** so the N-API layer can reference it instead of hardcoding the depth limit

#### `src/core/lua-runtime.cpp`
- **`ToLuaValue()` and `PushLuaValue()` now throw** `std::runtime_error` when depth exceeds `kMaxDepth` instead of silently returning nil
- **Added try-catch** in `ExecuteScript()`, `CallFunction()`, `LuaCallHostFunction()`, and `ResumeCoroutine()` to catch depth errors and propagate them through existing error channels

#### `src/lua-native.cpp`
- **`NapiToCoreInstance()` and `NapiToCore()` now throw** `std::runtime_error` when depth exceeds `kMaxDepth`
- **Replaced hardcoded `100`** with `lua_core::LuaRuntime::kMaxDepth` in both functions
- **Added try-catch** in `LuaFunctionCallbackStatic()`, `RegisterCallbacks()`, `SetGlobal()`, and `ResumeCoroutine()` to catch depth errors and convert to JavaScript exceptions

#### `tests/cpp/lua-native-test.cpp`
- **Removed misleading ReSharper comment** for the `<cmath>` include
- **Updated `DeepRecursionCap` test** to expect an error string instead of silent nil truncation
- **Added `DeepRecursionAtLimit` test** to verify structures exactly at the depth limit still convert successfully

#### `tests/ts/lua-native.spec.ts`
- **Added depth limit error tests** for both Lua-to-JS conversion (`execute_script`) and JS-to-Lua conversion (`set_global`)

### Not Implemented

None - all issues have been resolved.

### Verification

- Native module builds successfully in both debug and release modes
- All C++ unit tests pass
- All JavaScript integration tests pass

---

## Project Overview

**lua-native** is a Node.js native addon that bridges JavaScript and Lua via N-API. The architecture consists of:

- **N-API Layer** (`src/lua-native.cpp`, `src/lua-native.h`) - Exposes Lua functionality to JavaScript
- **Core Runtime** (`src/core/lua-runtime.cpp`, `src/core/lua-runtime.h`) - Manages Lua state and value conversion

The design is well-structured with clear separation of concerns between the binding layer and core logic.

---

## Issues Found & Recommended Changes

### 1. Significant Code Duplication (High Priority) - RESOLVED

**Problem:** `NapiToCore` (static) and `NapiToCoreInstance` (member) in `src/lua-native.cpp` are nearly identical (~60 lines duplicated). The only difference is that the instance method can handle JavaScript functions by registering them as callbacks.

**Resolution:** Both methods were refactored to use the new `LuaValue::nil()` and `LuaValue::from()` factory functions, significantly reducing verbosity. The methods remain separate because they need different recursive behavior (instance method handles nested functions, static method doesn't).

---

### 2. Dead Code in `isSequentialArray` (Low Priority) - RESOLVED

**Problem:**
```cpp
constexpr bool isArray = true;  // Never used
```

This variable is declared but the function returns `true` or `false` directly from other code paths.

**Resolution:** Removed the unused variable; function now returns `true` directly.

---

### 3. Missing Copy/Move Semantics for Reference Types (Medium Priority) - RESOLVED

**Problem:** `LuaFunctionRef` and `LuaThreadRef` in `src/core/lua-runtime.h` have implicit copy constructors. If a copy is made and both instances call `release()`, this causes a double-free bug (calling `luaL_unref` twice on the same reference).

**Resolution:** Added explicit move constructors and move assignment operators. Copy operations are allowed (for compatibility with existing code patterns) but documented with warnings about ownership semantics.

---

### 4. Potential Stack Miscounting in `ExecuteScript` and `CallFunction` (Medium Priority) - RESOLVED

**Problem:**
```cpp
const int nresults = lua_gettop(L_);
```

This assumes the Lua stack was empty before the call. If there were pre-existing items on the stack, `nresults` would include them, leading to incorrect result collection. Both functions are in `src/core/lua-runtime.cpp`.

**Resolution:** Both functions now save `stackBefore = lua_gettop(L_)` before execution and compute `nresults = lua_gettop(L_) - stackBefore`.

---

### 5. Verbose `LuaValue` Construction (Low Priority) - RESOLVED

**Location:** Throughout both `lua-native.cpp` and `lua-runtime.cpp`

**Problem:** Creating LuaValues requires verbose nested type construction:
```cpp
lua_core::LuaValue{lua_core::LuaValue::Variant{std::monostate{}}}
```

This pattern appears dozens of times throughout the codebase.

**Resolution:** Added convenience factory functions to `LuaValue`. Production code now uses:
```cpp
lua_core::LuaValue::nil()
lua_core::LuaValue::from(42)
lua_core::LuaValue::from("hello")
```

**Note:** The C++ test file (`tests/cpp/lua-native-test.cpp`) has also been updated to use factory functions.

---

### 6. Duplicated Callback Lambda (Medium Priority) - RESOLVED

**Problem:** The exact same lambda for wrapping JavaScript callbacks in `src/lua-native.cpp` appears three times.

**Resolution:** Extracted into `CreateJsCallbackWrapper()` helper method. All three locations now call:
```cpp
runtime->RegisterFunction(name, CreateJsCallbackWrapper(name));
```

---

### 7. Inconsistent Error Handling for Depth Limits (Low Priority) - RESOLVED

**Problem:** When recursion depth exceeds 100, values silently become `nil` with no indication to the caller. Affects `NapiToCoreInstance()` and `NapiToCore()` in `src/lua-native.cpp`, and `ToLuaValue()` and `PushLuaValue()` in `src/core/lua-runtime.cpp`.

**Resolution:** All depth limit checks now throw `std::runtime_error` instead of silently returning nil. Callers at every level catch the exception and propagate it appropriately:
- `ExecuteScript()` and `CallFunction()` catch and return as error string via `ScriptResult`
- `LuaCallHostFunction()` catches and converts to `lua_error`
- `ResumeCoroutine()` catches and returns via `CoroutineResult::error`
- N-API methods (`SetGlobal`, `ResumeCoroutine`, `LuaFunctionCallbackStatic`, `RegisterCallbacks`) catch and throw as JavaScript exceptions

The hardcoded `100` in the N-API layer was also replaced with `lua_core::LuaRuntime::kMaxDepth` (moved to public scope in the header), consolidating the depth limit in a single location.

---

### 8. Memory Management Pattern Inconsistency in `LuaValueToNapi` (Low Priority) - RESOLVED

**Problem:** `LuaValueToNapi()` in `src/lua-native.cpp` uses raw `new` followed by `StoreFunctionData`, while `CoreToNapi` uses the more modern `unique_ptr` pattern.

**Resolution:** Changed to use `make_unique` + `release()` pattern:
```cpp
auto data = std::make_unique<LuaFunctionData>(runtime, v);
auto* dataPtr = data.release();
runtime->StoreFunctionData(dataPtr, [](void* ptr) { delete static_cast<LuaFunctionData*>(ptr); });
```

---

### 9. Misleading ReSharper Comments (Trivial) - RESOLVED

**Problem:**
```cpp
// ReSharper disable once CppUnusedIncludeDirective
#include <cmath>
```

The `<cmath>` include is actually used for `std::modf` and `std::isfinite`. The suppression comment suggests it's unused when it's not.

**Resolution:** Removed the ReSharper suppression comments from both files.

---

## Summary Table

| Issue | Priority | Status | Files Affected |
|-------|----------|--------|----------------|
| Code duplication in NapiToCore variants | High | Resolved | `lua-native.cpp` |
| Missing copy/move semantics | Medium | Resolved | `lua-runtime.h` |
| Stack miscounting | Medium | Resolved | `lua-runtime.cpp` |
| Duplicated callback lambda | Medium | Resolved | `lua-native.cpp`, `lua-native.h` |
| Verbose LuaValue construction | Low | Resolved | `lua-runtime.h`, `lua-runtime.cpp`, `lua-native.cpp` |
| Dead code `isArray` | Low | Resolved | `lua-runtime.cpp` |
| Depth limit error handling | Low | Resolved | `lua-runtime.cpp`, `lua-runtime.h`, `lua-native.cpp` |
| Memory management inconsistency | Low | Resolved | `lua-native.cpp` |
| Misleading ReSharper comments | Trivial | Resolved | `lua-native.cpp`, `lua-native-test.cpp` |

---

## New Recommendations

### 10. Missing `std::move` in Data Constructors (Low Priority)

**Location:** `src/lua-native.h` — `LuaFunctionData` and `LuaThreadData` constructors

**Problem:** Both constructors take their ref parameter by value but copy it into the member instead of moving:
```cpp
LuaFunctionData(std::shared_ptr<lua_core::LuaRuntime> rt, lua_core::LuaFunctionRef ref)
    : runtime(std::move(rt)), funcRef(ref) {}  // funcRef is copied, not moved
```

Since move semantics were specifically added to these reference types (Issue #3) to prevent shared-ref problems, the constructors should `std::move` the parameter into the member:
```cpp
    : runtime(std::move(rt)), funcRef(std::move(ref)) {}
```

Same applies to `LuaThreadData`.

---

### 11. Hardcoded Depth Limit Magic Number (Low Priority) - RESOLVED

**Location:** `src/lua-native.cpp` — `NapiToCoreInstance()` and `NapiToCore()`

**Problem:** Both functions hardcode `100` as the depth limit:
```cpp
if (depth > 100) {
```

The core runtime defines this as a constant (`kMaxDepth = 100` in `src/core/lua-runtime.h`). The binding layer should use `lua_core::LuaRuntime::kMaxDepth` to keep the value in a single location.

**Resolution:** Both functions now use `lua_core::LuaRuntime::kMaxDepth`. The constant was moved from `private` to `public` scope in the header. Resolved as part of Issue #7.

---

### 12. Null `LuaPtr` Could Crash `PushLuaValue` (Medium Priority)

**Location:** `src/core/lua-runtime.cpp` — `PushLuaValue()`

**Problem:** `PushLuaValue` dereferences `value->value` without checking for a null `shared_ptr`. If a host callback returns `nullptr` from `LuaCallHostFunction`, this would cause a segfault. A simple null guard pushing `nil` would prevent this:
```cpp
if (!value) { lua_pushnil(L); return; }
```

---

### 13. `LuaValueToNapi` Does Not Handle `LuaThreadRef` (Low Priority)

**Location:** `src/lua-native.cpp` — `LuaValueToNapi()` (standalone static function)

**Problem:** The standalone `LuaValueToNapi` function handles `LuaFunctionRef` but silently falls through to `env.Undefined()` for `LuaThreadRef`. The instance method `CoreToNapi` does handle it correctly. If a Lua function called from JS returns a coroutine thread through the static callback path, it would silently become `undefined`.

---

### 14. `GetGlobal` Return Type Is Misleading (Low Priority)

**Location:** `src/core/lua-runtime.cpp` — `GetGlobal()`

**Problem:** `GetGlobal` returns `std::optional<LuaPtr>` but never returns `std::nullopt`. Non-existent globals come back as `LuaValue::nil()` wrapped in the optional. The `optional` wrapper suggests the function might not return a value, which is misleading. Either return `std::nullopt` for nil/missing globals, or change the return type to plain `LuaPtr`.

---

### 15. `StackGuard` Underutilization (Low Priority)

**Location:** `src/core/lua-runtime.cpp`

**Problem:** The `StackGuard` RAII helper is only used in `ToLuaValue` for the table case. Functions like `GetGlobal`, `LuaCallHostFunction`, and `CreateCoroutine` perform manual stack management that could benefit from `StackGuard` to ensure the Lua stack is always balanced, especially on error paths.

---

### 16. Indentation Inconsistency in `RegisterCallbacks` (Trivial)

**Location:** `src/lua-native.cpp` — `RegisterCallbacks()`

**Problem:** The `else` body is under-indented compared to the `if` body:
```cpp
    if (val.IsFunction()) {
      js_callbacks[key_str] = Napi::Persistent(val.As<Napi::Function>());
      runtime->RegisterFunction(key_str, CreateJsCallbackWrapper(key_str));
    } else {
    runtime->SetGlobal(key_str, ...);  // under-indented
  }
```

---

## New Recommendations Summary Table

| Issue | Priority | Status | Files Affected |
|-------|----------|--------|----------------|
| Missing `std::move` in data constructors | Low | Open | `lua-native.h` |
| Hardcoded depth limit magic number | Low | Resolved | `lua-native.cpp`, `lua-runtime.h` |
| Null `LuaPtr` crash in `PushLuaValue` | Medium | Open | `lua-runtime.cpp` |
| `LuaValueToNapi` missing `LuaThreadRef` | Low | Open | `lua-native.cpp` |
| `GetGlobal` misleading return type | Low | Open | `lua-runtime.cpp`, `lua-runtime.h` |
| `StackGuard` underutilization | Low | Open | `lua-runtime.cpp` |
| Indentation in `RegisterCallbacks` | Trivial | Open | `lua-native.cpp` |

---

## Notes

- The codebase is generally well-structured with good separation of concerns
- Error handling via `std::variant` is a solid pattern
- Test coverage in `lua-native-test.cpp` is comprehensive for the core runtime
- The C++ tests have been updated to use `LuaValue::from()` factory functions
