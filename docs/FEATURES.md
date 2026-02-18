# Feature Implementation Details

This document describes every feature in lua-native with architecture details and design decisions. The codebase is organized into two layers: a pure C++ Lua runtime wrapper (`src/core/lua-runtime.h/cpp`) and an N-API binding layer (`src/lua-native.h/cpp`) that bridges the runtime to Node.js.

---

## Architecture Overview

### Two-Layer Design

The codebase is split into two distinct layers with a clear boundary between them:

**Core layer (`lua_core` namespace):** A standalone C++ wrapper around the Lua C API. It has no knowledge of Node.js, N-API, or JavaScript types. All values flow through `LuaValue`, a tagged union (`std::variant`) supporting nil, bool, int64, double, string, array, table, function ref, thread ref, userdata ref, and table ref. The core layer owns the `lua_State*` and provides methods for script execution, global management, function calling, coroutine control, userdata lifecycle, metatable attachment, and table operations.

**N-API layer:** Bridges the core layer to Node.js via `Napi::ObjectWrap<LuaContext>`. Converts between `Napi::Value` and `lua_core::LuaValue`, manages JavaScript object lifetimes (`Napi::Reference`, `Napi::Persistent`), and exposes the API as `LuaContext` instance methods. Each `new lua_native.init()` call creates one `LuaContext` which owns one `shared_ptr<LuaRuntime>`.

**Why two layers:** The core layer is testable independently (the C++ test suite uses it directly without Node.js). It also means the Lua interop logic is not coupled to any particular JS runtime — the N-API layer could theoretically be replaced with a different binding (e.g., for embedding in a game engine). The core layer never `#include`s `<napi.h>`.

### The `LuaValue` Type System

All data crossing the Lua/JS boundary passes through `LuaValue`, a struct wrapping a `std::variant`:

```cpp
using Variant = std::variant<
    std::monostate,      // nil
    bool,
    int64_t,
    double,
    std::string,
    LuaArray,            // vector<shared_ptr<LuaValue>>
    LuaTable,            // unordered_map<string, shared_ptr<LuaValue>>
    LuaFunctionRef,      // Lua registry ref to a function
    LuaThreadRef,        // Lua registry ref to a coroutine thread
    LuaUserdataRef,      // JS object handle or Lua-created userdata ref
    LuaTableRef>;        // Lua registry ref to a metatabled table
```

Factory functions (`LuaValue::from(...)`) construct values. `LuaPtr` (`shared_ptr<LuaValue>`) is used throughout for shared ownership.

**Why `shared_ptr`:** Lua values frequently appear in multiple places simultaneously — as function arguments, return values, table entries, and callback parameters. Shared ownership avoids premature destruction and complex lifetime tracking. The overhead is acceptable since value conversions are not on a hot path (they happen at the JS/Lua boundary, not inside tight Lua loops).

### Registry Reference Pattern

Lua functions, coroutine threads, userdata, and metatabled tables all use the same pattern for cross-boundary lifetime management:

1. Push the Lua object onto the stack
2. Call `luaL_ref(L, LUA_REGISTRYINDEX)` to get a stable integer reference
3. Store the ref in a typed struct (`LuaFunctionRef`, `LuaThreadRef`, `LuaUserdataRef`, `LuaTableRef`)
4. When done, call `luaL_unref(L, LUA_REGISTRYINDEX, ref)` via the struct's `release()` method

Each ref struct supports default copy (shares the ref — only one copy should call `release()`), move (transfers ownership, invalidates the source), and explicit `release()`. The N-API layer wraps these in `*Data` structs (`LuaFunctionData`, `LuaThreadData`, `LuaUserdataData`, `LuaTableRefData`) that call `release()` in their destructors, stored in vectors on `LuaContext` for automatic cleanup.

### Stack Safety

All core layer methods that touch the Lua stack use `StackGuard` — a RAII helper that records `lua_gettop()` on construction and calls `lua_settop()` on destruction, ensuring the stack is always balanced even if an exception is thrown. This prevents stack leaks which are a common source of subtle bugs in Lua C API code.

### Conversion Functions

Four conversion functions handle the boundary:

| Function | Direction | Layer | Purpose |
|----------|-----------|-------|---------|
| `ToLuaValue` | Lua stack → `LuaValue` | Core | Reads a Lua stack slot, produces a `LuaPtr` |
| `PushLuaValue` | `LuaValue` → Lua stack | Core | Pushes a `LuaPtr` onto the Lua stack |
| `CoreToNapi` | `LuaValue` → `Napi::Value` | N-API | Converts core values to JS values |
| `NapiToCoreInstance` | `Napi::Value` → `LuaValue` | N-API | Converts JS values to core values |

There is also a static `NapiToCore` which does the same as `NapiToCoreInstance` but without access to the `LuaContext` instance (cannot handle round-trip detection for userdata/table refs). `NapiToCoreInstance` is the preferred path for all conversions that might involve reference types.

Both `ToLuaValue` and `NapiToCoreInstance` enforce a maximum nesting depth of 100 levels to prevent stack overflow from deeply nested or circular structures.

---

## Script Execution

### Overview

`execute_script()` accepts a Lua source string and returns the result(s). Lua scripts can return zero, one, or multiple values via `return`.

### Architecture

**Core layer:** `ExecuteScript` uses `luaL_loadstring` to compile the script, then `lua_pcall` with `LUA_MULTRET` to execute it. The stack delta (top after vs. before) determines how many values were returned. Each is converted via `ToLuaValue` and collected into a `vector<LuaPtr>`. Errors from compilation or execution are returned as a `string` variant of `ScriptResult`.

**N-API layer:** Single return values are converted directly via `CoreToNapi`. Multiple return values are wrapped in a `Napi::Array`. Zero return values produce `undefined`. Errors become JS exceptions via `Napi::Error::New(...).ThrowAsJavaScriptException()`.

**Why `LUA_MULTRET`:** Lua natively supports multiple return values. Using `LUA_MULTRET` preserves this behavior rather than forcing single-value semantics. On the JS side, multiple returns are destructured with `const [a, b] = lua.execute_script("return 1, 2")`.

---

## Host Function Bridge (JS Callbacks in Lua)

### Overview

JavaScript functions registered via the constructor callbacks object, `set_global()`, or internally via `set_metatable()` become callable from Lua. This is the primary mechanism for JS-to-Lua interop.

### Architecture

**Registration:** Each JS callback is stored in two places:
1. `js_callbacks` map on `LuaContext` (a `Napi::FunctionReference` keyed by name)
2. `host_functions_` map on `LuaRuntime` (a `std::function<LuaPtr(vector<LuaPtr>)>` keyed by name)

`RegisterFunction` pushes the function name as a string upvalue and creates a `lua_pushcclosure` with `LuaCallHostFunction` as the C function, then sets it as a Lua global.

**Dispatch (`LuaCallHostFunction`):** This single static C function handles all host function calls from Lua:
1. Reads the function name from `lua_upvalueindex(1)`
2. Retrieves the `LuaRuntime*` from the Lua registry (`_lua_core_runtime` key)
3. Looks up the matching `std::function` in `host_functions_`
4. Converts all Lua arguments to `LuaPtr` via `ToLuaValue`
5. Calls the function
6. Converts the return value back via `PushLuaValue`

**The JS callback wrapper (`CreateJsCallbackWrapper`):** The `std::function` stored in `host_functions_` is a lambda that:
1. Converts `LuaPtr` args to `napi_value` via `CoreToNapi`
2. Calls the stored `Napi::FunctionReference`
3. Converts the JS return value back via `NapiToCoreInstance`

**Why upvalue-based dispatch:** Each Lua closure carries the function name as an upvalue. This avoids needing a separate C function per callback. A single `LuaCallHostFunction` handles all registered callbacks — the upvalue tells it which one to invoke. This is the standard Lua pattern for C function factories.

**Why two maps:** The core layer stores `std::function` (no N-API types). The N-API layer stores `Napi::FunctionReference` (prevents GC of the JS function). The wrapper lambda bridges them. This maintains the layer separation.

---

## Global Variable Management

### Overview

`set_global(name, value)` sets a Lua global from JS. `get_global(name)` reads one back.

### Architecture

**`set_global`:** Functions go through the callback registration path (stored in both maps, registered as closures). Non-function values are converted via `NapiToCoreInstance` and pushed with `PushLuaValue` + `lua_setglobal`.

**`get_global`:** Calls `lua_getglobal` + `ToLuaValue` in the core layer, then `CoreToNapi` in the N-API layer. Uses `StackGuard` so the global read is stack-safe.

**Constructor callbacks:** The callbacks object passed to `new lua_native.init({...})` is iterated in `RegisterCallbacks`. Functions and non-function values are handled identically to `set_global` — the constructor is just syntactic sugar for bulk registration.

---

## Lua Function Returns

### Overview

Lua functions returned from `execute_script()` or passed to JS callbacks become callable JavaScript functions. Closures, upvalues, and Lua state are preserved.

### Architecture

**Core layer:** When `ToLuaValue` encounters `LUA_TFUNCTION`, it pushes a copy of the function and calls `luaL_ref` to anchor it in the registry, returning a `LuaFunctionRef`. When `CallFunction` is called later, it pushes the function from the registry via `lua_rawgeti`, pushes arguments, and calls `lua_pcall`.

**N-API layer:** `CoreToNapi` wraps `LuaFunctionRef` in a `LuaFunctionData` struct (holding the runtime, func ref, and context pointer) and creates a `Napi::Function` with `LuaFunctionCallbackStatic` as the C callback and `LuaFunctionData*` as the function data.

**`LuaFunctionCallbackStatic`:** When the JS function is called:
1. Extracts the `LuaFunctionData*` from `info.Data()`
2. Converts JS arguments to `LuaPtr` via `NapiToCoreInstance`
3. Calls `CallFunction` on the runtime
4. Converts results back via `CoreToNapi`
5. Single return → direct value; multiple returns → `Napi::Array`

**Why `NapiToCoreInstance` (not `NapiToCore`):** `LuaFunctionCallbackStatic` uses the instance method so that round-trip detection works. If a Lua function receives a metatabled table Proxy or a userdata handle as an argument, `NapiToCoreInstance` detects the `_tableRef` or `_userdata` markers and reconstructs the original `LuaTableRef` or `LuaUserdataRef` instead of deep-copying the object.

---

## Coroutines

### Overview

`create_coroutine(script)` creates a pausable Lua coroutine. `resume(coro, ...args)` resumes it, returning yielded or final values along with the coroutine status.

### Architecture

**Core layer:**
- `CreateCoroutine`: Creates a new Lua thread via `lua_newthread`, anchors it in the registry, moves the function onto the thread's stack via `lua_xmove`.
- `ResumeCoroutine`: Pushes arguments onto the thread's stack, calls `lua_resume`. Collects yielded/returned values from the thread's stack. Returns a `CoroutineResult` with status, values, and optional error.
- `GetCoroutineStatus`: Checks `lua_status` — `LUA_YIELD` means suspended, `LUA_OK` with an empty stack means dead, otherwise suspended.

**N-API layer:**
- `CreateCoroutine`: Executes the script to get a function, creates a coroutine from it, wraps the `LuaThreadRef` in a `LuaThreadData`, returns a JS object with `{ _coroutine: External, status: "suspended" }`.
- `ResumeCoroutine`: Extracts the `LuaThreadData` from the coroutine object's `_coroutine` external, converts JS arguments, resumes, builds a result object with `{ status, values, error? }`, and updates the coroutine object's status.

**Why a separate thread:** Lua coroutines run on their own `lua_State` (thread). This is how Lua implements cooperative multitasking — each coroutine has its own stack but shares the global state with the main thread. The registry reference prevents GC of the thread while JS holds a handle to it.

---

## Error Handling

### Overview

Errors from Lua scripts, host function callbacks, and value conversion are all propagated as JavaScript exceptions with descriptive messages.

### Architecture

**Lua script errors:** `luaL_loadstring` (compile) and `lua_pcall` (execute) both return error codes. On failure, the error message is on top of the Lua stack. The core layer returns it as a `string` variant of `ScriptResult`. The N-API layer converts it to a `Napi::Error`.

**Host function errors:** `LuaCallHostFunction` wraps the call in try/catch. `std::exception` and unknown exceptions are caught and converted to Lua errors via `lua_pushfstring` + `lua_error`. The error message includes the function name for debugging (e.g., `"Host function 'riskyOperation' threw an exception: ..."`).

**Argument conversion errors:** If `ToLuaValue` fails while converting arguments for a host function call, the error is caught and reported with context (e.g., `"Error converting arguments for 'funcName': ..."`). Same for return value conversion.

**Nesting depth:** Both `ToLuaValue` and `NapiToCoreInstance` check a depth counter against `kMaxDepth` (100). Exceeding it throws a `std::runtime_error` which propagates up as a JS exception. This prevents stack overflow from circular or deeply nested structures.

**Why `lua_pcall` (not `lua_call`):** `lua_pcall` runs in protected mode — Lua errors are caught and returned as error codes instead of longjumping past C++ destructors. This is critical for correct RAII behavior (destructors must run) and for clean error propagation to JavaScript.

---

## Bidirectional Data Conversion

### Overview

Values are automatically converted between JavaScript and Lua types when crossing the boundary. The conversion is symmetric — a value that round-trips (JS → Lua → JS) should arrive as the same JS type.

### Type Mapping

| Lua Type | Core Type | JS Type | Notes |
|----------|-----------|---------|-------|
| `nil` | `monostate` | `null` | `undefined` also maps to nil |
| `boolean` | `bool` | `boolean` | |
| `number` (integer) | `int64_t` | `number` | Lua integers are preserved as int64 internally |
| `number` (float) | `double` | `number` | |
| `string` | `std::string` | `string` | Binary-safe via `lua_tolstring`/`lua_pushlstring` |
| `table` (array) | `LuaArray` | `Array` | Sequential integer keys starting from 1, no metatable |
| `table` (map) | `LuaTable` | `Object` | String or mixed keys, no metatable |
| `table` (metatabled) | `LuaTableRef` | `Proxy` | Registry reference, metamethods preserved |
| `function` | `LuaFunctionRef` | `Function` | Registry reference, callable from JS |
| `thread` | `LuaThreadRef` | `Object` | `{ _coroutine, status }` |
| `userdata` (JS-created) | `LuaUserdataRef` | `Object` | Original JS object returned by reference |
| `userdata` (Lua-created) | `LuaUserdataRef` | `Object` | Opaque `{ _userdata: External }` for round-trip |

### Design Decisions

**Array detection (`isSequentialArray`):** Before converting a plain Lua table, the code iterates with `lua_next` to check if all keys are consecutive integers starting from 1. If so, it becomes a JS `Array`; otherwise a JS `Object`. This matches user expectations — Lua uses tables for both arrays and maps, but JS distinguishes them.

**Integer preservation:** JS has only `number` (IEEE 754 double). When converting JS → Lua, whole numbers within int64 range become Lua integers (via `lua_pushinteger`). When converting Lua → JS, integers become `Number` (which can represent integers exactly up to 2^53). The core layer preserves the distinction (`int64_t` vs `double`) for accurate round-tripping within the C++ layer.

**Binary-safe strings:** `lua_tolstring` with explicit length and `lua_pushlstring` are used instead of `lua_tostring`/`lua_pushstring`. This preserves strings containing embedded null bytes, which are valid in Lua.

---

## Userdata (February 2026)

### Overview

JavaScript objects can be passed into Lua as userdata — Lua holds a reference to the original object, not a copy. Three modes are supported: opaque handles, property-access-enabled handles, and Lua-created userdata passthrough.

### Architecture

**Core layer:**
- `LuaUserdataRef` struct with `ref_id` (JS object map key), `registry_ref` (for Lua-created passthrough), `opaque` flag, and `proxy` flag
- Two metatables registered at runtime construction:
  - `lua_native_userdata` — `__gc` only (opaque handles)
  - `lua_native_proxy_userdata` — `__gc`, `__index`, `__newindex` (property access)
- Reference counting via `IncrementUserdataRefCount` / `DecrementUserdataRefCount` with a GC callback to notify the N-API layer when Lua releases a reference
- `UserdataGC`, `UserdataIndex`, `UserdataNewIndex` static C functions as metamethod handlers
- `PropertyGetter` / `PropertySetter` callback types set by the N-API layer

**N-API layer:**
- `UserdataEntry` struct with `Napi::ObjectReference`, `readable`, `writable` flags
- `js_userdata_` map (`int` ref_id → `UserdataEntry`) for JS object storage
- GC callback clears entries from `js_userdata_` when Lua releases a reference
- Property handlers bridge Lua `__index`/`__newindex` to `obj.Get(key)` / `obj.Set(key, value)` on the original JS object

**Lua-created userdata passthrough:** Userdata from Lua libraries (e.g., `io.open()` file handles) are detected by metatable check — if the userdata doesn't match either of our metatables, it's foreign. It's stored in the registry and wrapped as `{ _userdata: External }` on the JS side. `NapiToCoreInstance` detects this marker for round-trip back to Lua.

### Design Decisions

**Two metatables instead of one:** Opaque userdata uses `lua_native_userdata` (only `__gc`), while property-access-enabled userdata uses `lua_native_proxy_userdata` (`__gc` + `__index` + `__newindex`). This prevents accidental property dispatch on opaque handles and makes the metatable check in `ToLuaValue` unambiguous about the proxy flag.

**Reference counting for `__gc`:** When `PushLuaValue` creates a new userdata block (e.g., during round-trip through a host function), it increments the ref count for that ref_id. Each `__gc` decrements it. The JS object is only released from `js_userdata_` when the count reaches zero. This handles the case where multiple Lua userdata blocks share the same ref_id.

**Property handlers as callbacks:** The core layer doesn't know about N-API types. Property access is bridged via `PropertyGetter` / `PropertySetter` callbacks (`std::function`) set by the N-API layer during `LuaContext` construction. The `__index` C function extracts the ref_id from the userdata, retrieves the runtime from the registry, and calls the registered handler.

**Safe destructor ordering:** `~LuaContext` explicitly nulls out the GC callback and property handlers before member destruction begins. This prevents the `__gc` metamethods (which fire during `lua_close()` in `~LuaRuntime`) from accessing `js_userdata_` or calling property handlers on a partially destroyed `LuaContext`.

---

## Explicit Metatable Support (February 2026)

### Overview

`set_metatable()` attaches Lua metatables to global tables from JavaScript, enabling operator overloading, custom indexing, `__tostring`, `__call`, and other metamethods.

### Architecture

**Core layer:**
- `MetatableEntry` struct: `key` (string), `is_function` (bool), `func_name` (string), `value` (LuaPtr)
- `StoreHostFunction(name, fn)`: stores in `host_functions_` without creating a Lua global
- `SetGlobalMetatable(name, entries)`: validates the global exists and is a table, creates a new metatable via `lua_newtable`, pushes each entry as either a C closure or a value, then attaches with `lua_setmetatable`

**N-API layer:**
- `SetMetatable` iterates JS metatable properties, generates unique function names (`__mt_<id>_<key>`) for function entries, stores JS callbacks via `StoreHostFunction` + `CreateJsCallbackWrapper`, converts non-function values via `NapiToCoreInstance`, builds `vector<MetatableEntry>`, and delegates to `SetGlobalMetatable`
- `next_metatable_id_` counter ensures unique function names across multiple `set_metatable` calls

All standard Lua metamethods work: `__tostring`, `__add`, `__sub`, `__mul`, `__div`, `__mod`, `__unm`, `__concat`, `__len`, `__eq`, `__lt`, `__le`, `__call`, `__index` (as function or table), `__newindex`.

### Design Decisions

**Closures, not global functions:** JS metamethod functions are stored as host functions with unique generated names (`__mt_1___add`, etc.) rather than registered as globals. This avoids polluting the Lua global namespace with internal metamethod closures. The existing `LuaCallHostFunction` bridge is reused — the same upvalue-based dispatch mechanism that powers `RegisterFunction` works identically for metamethod closures.

**`set_metatable()` only works for global tables.** To set metatables on non-global tables, use `setmetatable()` in Lua code directly. This is a deliberate simplification — the API takes a global name string, which is unambiguous. Supporting arbitrary table references would require the Proxy-based table ref system (which was built later).

---

## Reference-Based Tables with Proxy (February 2026)

### Overview

Metatabled Lua tables are kept as Lua registry references and wrapped in JS Proxy objects, preserving metamethods (`__index`, `__newindex`, `__tostring`, `__add`, etc.) across the Lua/JS boundary. Plain tables (no metatable) continue to deep-copy as before — fully backward compatible.

### Architecture

**Core layer:**
- `LuaTableRef` struct: `int ref` (Lua registry reference), `lua_State* L`. Same pattern as `LuaFunctionRef`.
- `ToLuaValue` LUA_TTABLE case: checks `lua_getmetatable()` before deep-copy. If metatable exists, creates `LuaTableRef` via `luaL_ref`. Otherwise falls through to existing deep-copy logic.
- `PushLuaValue` handles `LuaTableRef`: `lua_rawgeti(L, LUA_REGISTRYINDEX, ref)` to push the original table.
- Five table operation methods on `LuaRuntime`:
  - `GetTableField(registry_ref, key)` — uses `lua_getfield` (triggers `__index`), with integer key detection via `strtoll` for `lua_geti`
  - `SetTableField(registry_ref, key, value)` — uses `lua_setfield` (triggers `__newindex`), with integer key detection for `lua_seti`
  - `HasTableField(registry_ref, key)` — `lua_getfield` + nil check
  - `GetTableKeys(registry_ref)` — iterates with `lua_next`
  - `GetTableLength(registry_ref)` — uses `luaL_len` (triggers `__len`)

**N-API layer:**
- `LuaTableRefData` struct: holds `shared_ptr<LuaRuntime>`, `LuaTableRef`, and `LuaContext*` pointer
- `CoreToNapi` handler for `LuaTableRef`: creates a JS Proxy with a target object, a non-enumerable `_tableRef` external for round-trip detection, and a handler with five traps
- Five static trap functions (`TableRefGetTrap`, `TableRefSetTrap`, `TableRefHasTrap`, `TableRefOwnKeysTrap`, `TableRefGetOwnPropertyDescriptorTrap`) each receive `LuaTableRefData*` via N-API function data
- `NapiToCoreInstance` round-trip: detects `_tableRef` external on incoming objects (before the existing `_userdata` check) and reconstructs the `LuaTableRef`

### Design Decisions

**Only metatabled tables become refs:** The `lua_getmetatable()` check in `ToLuaValue` is the sole decision point. No opt-in flag needed — metatabled tables get Proxy wrappers, plain tables deep-copy. Fully backward compatible.

**Proxy traps go through the Lua C API:** `lua_getfield`/`lua_setfield` are used (not `lua_rawget`/`lua_rawset`) so that `__index` and `__newindex` metamethods fire naturally on property access.

**"then" suppression:** The `get` trap returns `undefined` for `prop === "then"` to prevent JS from treating the Proxy as a thenable/Promise (which would break `await` and other async patterns).

**`_tableRef` non-enumerable:** Hidden from `Object.keys()` / `for...in` but detectable for round-trip reconstruction. Same pattern as the `_userdata` external used for userdata passthrough.

**Integer key detection:** `GetTableField` and `SetTableField` attempt to parse string keys as integers via `strtoll`. If the key is a pure integer string (e.g., `"1"`, `"42"`), `lua_geti`/`lua_seti` are used instead of `lua_getfield`/`lua_setfield` for correct Lua sequence access.

---

## Module Loading

### Overview

`index.js` handles locating and loading the native `.node` binary across different build configurations and platforms.

### Architecture

The loader tries multiple paths in priority order:

1. **Prebuilds** (`prebuilds/<platform>-<arch>/lua-native`) — for distributed packages
2. **CMake output** (`build/Debug/<platform>/`, `build/Release/<platform>/`) — for development
3. **node-gyp output** (`build/Debug/`, `build/Release/`) — for standard builds
4. **`node-gyp-build` fallback** — scans the build directory using the standard prebuild detection library

The loader uses `createRequire(import.meta.url)` for ESM compatibility. If no binary is found, it throws a descriptive error pointing the user to `npm run build-debug`.

**Why this complexity:** The native binary can end up in different locations depending on the build system (node-gyp vs CMake), build type (Debug vs Release), and platform. Rather than requiring users to copy binaries to a fixed location, the loader searches all reasonable paths. The prebuild path is checked first for installed packages; development paths are fallbacks.

---

## File Execution (February 2026)

### Overview

`execute_file()` executes a Lua file directly from a filesystem path, mirroring `execute_script()` but using `luaL_loadfile` instead of `luaL_loadstring`. Return values, globals, callbacks, and error handling all work identically.

### Architecture

**Core layer:** `ExecuteFile` validates the filepath is non-empty (returning an early error string), then follows the exact same pattern as `ExecuteScript`: `luaL_loadfile` to compile, `lua_pcall` with `LUA_MULTRET` to execute, stack delta to count results, `ToLuaValue` to convert each result. Lua handles file-not-found errors naturally — `luaL_loadfile` returns a descriptive error string.

**N-API layer:** `ExecuteFile` accepts a single string argument, delegates to `runtime->ExecuteFile(path)`, and converts results identically to `ExecuteScript` — single value returned directly, multiple values as `Napi::Array`, zero values as `undefined`, errors as JS exceptions.

### Design Decisions

**Empty path guard:** The core layer rejects empty paths before calling `luaL_loadfile`. This provides a clear error message rather than Lua's generic "cannot open" message for an empty string.

**No path normalization:** File paths are passed directly to `luaL_loadfile` without normalization or resolution. This keeps the implementation simple and lets the caller control path handling. Relative paths resolve against the process working directory, matching standard filesystem behavior.

---

## Opt-In Standard Library Loading (February 2026)

### Overview

Standard library loading is now opt-in. The default `LuaRuntime()` constructor creates a bare Lua state with no standard libraries loaded. Users choose what to load via preset strings (`'all'`, `'safe'`) or an explicit array of library names. This is the primary mechanism for sandboxing untrusted scripts.

### Architecture

**Core layer:** The `LuaRuntime()` default constructor creates a bare state (no libraries). The `LuaRuntime(bool openStdLibs)` constructor was removed. Two static helpers provide named library lists:

- `LuaRuntime::AllLibraries()` — returns a `vector<string>` of all 10 standard library names
- `LuaRuntime::SafeLibraries()` — returns a `vector<string>` of all libraries except `io`, `os`, and `debug`

The `LuaRuntime(const std::vector<std::string>& libraries)` constructor loads the specified libraries. All constructors share common initialization via a private `InitState()` method that stores the runtime in the registry and registers userdata metatables.

A static map (`kLibFlags`) maps user-facing library names to Lua 5.5's bitmask constants (`LUA_GLIBK`, `LUA_LOADLIBK`, etc.). The static `LibraryMask()` method OR's the requested library flags into a single integer. The constructor calls `luaL_openselectedlibs(L_, mask, 0)` — a Lua 5.5 API that loads exactly the specified libraries in a single call.

Unknown library names throw `std::runtime_error` with a descriptive message including the bad name.

**N-API layer:** The `LuaContext` constructor checks for a second argument (options object). The `options.libraries` field accepts:

- A preset string `'all'` — resolved to `LuaRuntime::AllLibraries()`
- A preset string `'safe'` — resolved to `LuaRuntime::SafeLibraries()`
- An array of library name strings — passed directly to the `vector<string>` constructor
- Omitted or empty array — creates a bare state via the default `LuaRuntime()` constructor

Non-string elements in the array produce a `TypeError`. Unknown preset strings produce a `TypeError`.

**TypeScript types:** `LuaLibraryPreset = 'all' | 'safe'` is a new type alias. `LuaInitOptions.libraries` accepts `LuaLibrary[] | LuaLibraryPreset`.

**Available libraries:** `base`, `package`, `coroutine`, `table`, `io`, `os`, `string`, `math`, `utf8`, `debug`.

### Design Decisions

**`luaL_openselectedlibs` over `luaL_requiref`:** Lua 5.5 provides `luaL_openselectedlibs(L, load, preload)` which handles all library name registration internally. This is cleaner than calling `luaL_requiref` in a loop and avoids the special-case handling of the base library (which registers under `"_G"` rather than `"base"`).

**Bare by default:** The default constructor creates a bare state to encourage explicit library selection. This is safer for sandboxing — users must opt in to potentially dangerous libraries like `io`, `os`, and `debug` rather than remembering to opt out. The `'all'` preset provides a convenient one-word escape hatch for scripts that need everything.

**Static helpers over enum:** `AllLibraries()` and `SafeLibraries()` return plain vectors rather than using an enum or bitfield. This keeps the API consistent — both presets and manual lists use the same `vector<string>` constructor path.

**Preset strings in the N-API layer:** Preset resolution (`'all'` and `'safe'`) happens in the N-API layer, not the core layer. The core layer only knows about `vector<string>`. This keeps the core layer simple and testable — presets are a convenience feature for the JS API.

**Validation at construction:** Unknown library names throw immediately during `LuaRuntime` construction rather than silently ignoring them. This catches typos early.

---

## Async Execution (February 2026)

### Overview

`execute_script_async()` and `execute_file_async()` run Lua scripts on the libuv thread pool via `Napi::AsyncWorker`, returning Promises. This keeps the Node.js event loop free during CPU-heavy Lua computation. JS callbacks are disallowed in async mode — scripts that call registered JS functions get a clear error.

### Architecture

**AsyncWorker pattern:** Two classes (`LuaScriptAsyncWorker`, `LuaFileAsyncWorker`) extend `Napi::AsyncWorker`. The libuv worker thread calls `Execute()`, which is pure C++ (no N-API). The main thread calls `OnOK()`, where N-API conversions happen.

- `Execute()`: Sets `async_mode_` on the runtime, calls `ExecuteScript`/`ExecuteFile`, clears `async_mode_`. The result is stored in a `ScriptResult` member.
- `OnOK()`: Clears the busy flag, converts the `ScriptResult` to N-API values via `CoreToNapi`, resolves or rejects the deferred Promise.
- `OnError()`: Clears the busy flag, rejects the deferred Promise.

**Busy flag:** `LuaContext` has an `is_busy_` flag that is set to `true` when an async operation starts and cleared in `OnOK()`/`OnError()`. All 8 sync methods (`execute_script`, `execute_file`, `set_global`, `get_global`, `set_userdata`, `set_metatable`, `create_coroutine`, `resume`) check this flag and throw if set. The async methods also check it, preventing concurrent async operations on the same context.

**Callback guard:** `LuaRuntime::async_mode_` is checked in `LuaCallHostFunction` right after the host function lookup. If set, the function returns a Lua error (`luaL_error`) with a message including "async mode" and the function name. This is caught by `lua_pcall` and propagated through the `ScriptResult` error path.

### Design Decisions

**Why a busy flag instead of a mutex:** A mutex would allow queuing sync operations behind an async one, which would still block the event loop (defeating the purpose). The busy flag provides a clear, immediate error: "you started an async operation, wait for it to complete before touching this context." This is simpler and more predictable.

**Why disallow JS callbacks in async mode:** N-API calls (`Napi::Function::Call`, `Napi::Value` construction) are only safe on the main thread. The `Execute()` method runs on a worker thread. Rather than adding complex marshalling to bounce callbacks back to the main thread (which would negate the async benefit for callback-heavy scripts), Phase 1 takes the simple approach: callbacks are blocked with a clear error. Users can set up globals before the async call and read results after.

**Why one operation per context:** Lua states are not thread-safe — a single `lua_State*` must not be accessed from multiple threads simultaneously. The busy flag enforces this invariant. For true concurrency, users should create multiple `LuaContext` instances (each with its own `lua_State`).

**Result conversion on the main thread:** `OnOK()` runs on the main thread, where N-API calls are safe. The `ScriptResult` (a `variant<vector<LuaPtr>, string>`) is a pure C++ type that was populated on the worker thread. The conversion to `Napi::Value` via `CoreToNapi` mirrors the existing sync path exactly.

---

## Module / Require Integration (February 2026)

### Overview

`add_search_path()` appends filesystem search paths to Lua's `package.path`, enabling `require()` to find `.lua` module files. `register_module()` pre-loads a JavaScript object into `package.loaded`, making it available via `require(name)` without any filesystem search. Functions within the module object become callable from Lua.

### Architecture

**Core layer:**
- `HasPackageLibrary()` (private helper): Checks that the `package` global is a table. Used by both methods to validate the prerequisite.
- `AddSearchPath(path)`: Uses `StackGuard`. Gets `package.path`, appends the new path with `;` separator, sets it back.
- `RegisterModuleTable(name, entries)`: Uses `StackGuard`. Gets `package.loaded`, creates a new Lua table, iterates the entries vector — for function entries, pushes a `lua_pushcclosure` with `LuaCallHostFunction` (function name as upvalue); for value entries, pushes via `PushLuaValue`. Sets the table in `package.loaded[name]`.

**N-API layer:**
- `AddSearchPath`: Busy check, string validation, `?` placeholder validation, delegates to core.
- `RegisterModule`: Busy check, argument validation (string + object), iterates JS object properties. Functions are stored via `StoreHostFunction` + `CreateJsCallbackWrapper` with generated names (`__module_<id>_<key>`). Non-function values are converted via `NapiToCoreInstance`. Builds a `vector<MetatableEntry>` and delegates to `RegisterModuleTable`.
- `next_module_id_` counter ensures unique function names across multiple `register_module` calls.

Both methods require the `package` library to be loaded. The `'safe'` and `'all'` presets include `package` by default.

### Design Decisions

**Approach C — Build the module table directly in Lua:** Three approaches were considered (see `docs/REQUIRE.md` for the full comparison). The chosen approach builds the Lua table directly on the Lua stack inside `RegisterModuleTable`, pushing closures for functions inline. This avoids creating temporary Lua globals (Approach A's global-then-nil pattern) and cleanly separates concerns between the N-API and core layers.

**Reuses `MetatableEntry`:** The `MetatableEntry` struct has exactly the right shape for module entries (key + is_function flag + func_name or value). Rather than creating a duplicate struct, it's reused directly. The name is semantically off but the structure is identical.

**`StoreHostFunction` over `RegisterFunction`:** Module functions are stored via `StoreHostFunction` (same as `set_metatable`), which places them in `host_functions_` without creating Lua globals. The closures are pushed directly into the module table. This prevents namespace pollution — internal function names like `__module_1_clamp` never appear as Lua globals.

**`?` placeholder validation in N-API layer:** The core layer doesn't validate path format — it just manipulates `package.path`. The `?` check is a user-facing concern handled at the N-API boundary.

**JS modules win over filesystem modules:** If a JS-registered module and a filesystem module share the same name, the JS module wins because `package.loaded` is checked before any searcher runs. This is standard Lua behavior for pre-loaded modules.

---

## Implementation Timeline

| Feature | Complexity | Date |
|---------|------------|------|
| Script execution, data conversion, host functions | Foundation | January 2026 |
| Lua function returns to JS | Moderate | January 2026 |
| Coroutine support | Moderate | January 2026 |
| Expose `get_global` | Low | February 2026 |
| Opaque userdata + passthrough | Moderate | February 2026 |
| Full userdata with properties | High | February 2026 |
| Explicit metatables | Moderate | February 2026 |
| Reference-based tables with Proxy | High | February 2026 |
| File execution | Low | February 2026 |
| Opt-in standard library loading with presets | Low | February 2026 |
| Async execution (Phase 1) | Moderate | February 2026 |
| Module / require integration | Moderate | February 2026 |
