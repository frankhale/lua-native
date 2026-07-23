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

**Dotted paths (July 2026):** When `name` contains a `.`, both methods treat it
as a path into nested tables (`config.db.host`). `SplitGlobalPath` (N-API layer)
validates the name and splits it into segments — rejecting empty segments from a
leading, trailing, or doubled dot — then routes to the core's `SetGlobalPath` /
`GetGlobalPath`. Those walk the path with `lua_gettable`/`lua_settable`, so each
hop fires `__index`/`__newindex`, inside one `RunProtected` frame (a metamethod
raise or OOM becomes a catchable error). `SetGlobalPath` auto-creates missing
intermediate tables and throws on a non-table intermediate; `GetGlobalPath`
short-circuits to nil when any intermediate is nil (optional-chaining) and lets
a non-nil, non-indexable intermediate raise the natural "attempt to index"
error. A name with no dot keeps the exact single-key behavior above (so a
literal key that contains a dot is still reachable by round-tripping through
`create_table`/handles or by never using the dotted form). A function value at a
dotted path is materialized as a nested closure via `NapiToCoreInstance`, not
the named-persistent top-level registration.

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

## Table Reference API (February 2026)

### Overview

`create_table()` creates a new Lua table and returns a live handle for direct manipulation from JavaScript. `get_global_ref()` returns a live handle to an existing global table. Both return `LuaTableHandle` objects that support `get`, `set`, `has`, `length`, `pairs`, `ipairs`, and `release` operations. Unlike `get_global()` which deep-copies plain tables, table handles maintain a live reference — mutations from either side are immediately visible to the other.

### Architecture

**Core layer:**
- `CreateTable()`: Creates an empty table via `lua_newtable`, stores it in the Lua registry via `luaL_ref`, returns the registry reference integer.
- `CreateTableFrom(LuaTable)`: Creates a table and populates it with string-keyed entries using `lua_setfield` for each entry.
- `CreateTableFrom(LuaArray)`: Creates a table with `lua_createtable` (pre-sized for the array length) and populates it using `lua_seti` for 1-indexed entries, matching Lua's sequence convention.
- `GetGlobalRef(name)`: Gets the named global, checks that it's a table (returning an error string if not), stores it in the registry, and returns the reference. Returns `std::variant<int, std::string>` — the int is the registry ref on success, the string is an error message on failure.
- `TablePairs(registry_ref)`: Pushes the table from the registry, iterates with `lua_next()`, and returns all key-value pairs as `vector<pair<LuaPtr, LuaPtr>>`. Keys are converted directly to string or int64 types (not through `ToLuaValue` which would consume the key and break `lua_next` iteration).
- `TableIPairs(registry_ref)`: Iterates from index 1 with `lua_geti`, stopping at the first nil value. Returns `vector<pair<int64_t, LuaPtr>>`.
- `ReleaseTableRef(registry_ref)`: Guards against `LUA_NOREF` and `LUA_REFNIL`, then calls `luaL_unref` to free the registry slot.

All methods that touch the Lua stack use `StackGuard` for automatic stack balancing.

**N-API layer:**
- Seven static table handle functions (`TableHandleGet`, `TableHandleSet`, `TableHandleHas`, `TableHandleLength`, `TableHandlePairs`, `TableHandleIPairs`, `TableHandleRelease`) are registered as methods on the handle object.
- `CreateTableHandle(env, registry_ref)`: Creates a `LuaTableRefData` struct (pairing the registry ref with `shared_ptr<LuaRuntime>` and `LuaContext*`), stores it in the `lua_table_ref_data_` vector for lifetime management, and creates a plain JS object with:
  - A non-enumerable `_tableRef` property containing a `Napi::External<LuaTableRefData>` for round-trip detection
  - Seven method functions attached via `DefineProperties`, each receiving the `LuaTableRefData*` as function data
- `CreateTableMethod`: Handles three cases — no arguments (empty table), array argument (`CreateTableFrom(LuaArray)`), and object argument (`CreateTableFrom(LuaTable)`)
- `GetGlobalRef`: Validates the string argument, calls `runtime->GetGlobalRef()`, and on success creates a handle via `CreateTableHandle`
- Both methods are registered as instance methods (`create_table`, `get_global_ref`) in `LuaContext::Init()`

**Round-trip support:** Table handles carry a `_tableRef` external marker (same pattern as metatabled table Proxy objects). When a handle is passed back to Lua via `NapiToCoreInstance`, the marker is detected and the original `LuaTableRef` is reconstructed, pushing the actual Lua table rather than creating a copy.

### Design Decisions

**Plain JS objects with closures, not ObjectWrap:** Table handles are plain JS objects with closure-based methods rather than `Napi::ObjectWrap` instances. This matches the pattern used by coroutine handles (`{ _coroutine, status }`) and keeps the implementation simple. Each method function receives the `LuaTableRefData*` through N-API's function data mechanism.

**Released state tracked by `ref == LUA_NOREF`:** After `release()`, the `LuaTableRef.ref` field is set to `LUA_NOREF`. All handle methods check this value and throw "table handle has been released" if set. Double release is a no-op. This avoids needing a separate boolean flag.

**`pairs()` key conversion avoids `ToLuaValue`:** During `lua_next` iteration, keys must remain on the stack for the next iteration. Using `ToLuaValue` on the key would consume it. Instead, `TablePairs` reads key type directly (`lua_type`) and converts to string or int64 without popping, then converts the value via `ToLuaValue`.

**`ipairs()` stops at first nil:** Matches Lua's `ipairs()` semantics — iterates from index 1 and stops at the first nil gap. This is the expected behavior for Lua sequences.

**`get_global_ref` validates table type:** Returns an error if the global is not a table (including nil). This is a deliberate choice — the API is specifically for table manipulation. Non-table globals should use `get_global()` instead.

**Metamethod support through existing infrastructure:** `get`, `set`, `has`, and `length` all use the existing `GetTableField`, `SetTableField`, `HasTableField`, and `GetTableLength` methods on `LuaRuntime`, which use `lua_getfield`/`lua_setfield`/`luaL_len` (not raw operations). This means metatabled tables accessed through `get_global_ref` will fire `__index`, `__newindex`, and `__len` metamethods naturally.

---

## Memory Limits (February 2026)

### Overview

`maxMemory` caps the total memory a Lua state can allocate. A custom allocator (`lua_Alloc`) tracks every allocation and returns `NULL` when the limit would be exceeded, which Lua handles gracefully as an out-of-memory error. `get_memory_usage()` reports current memory consumption even without a limit set.

### Architecture

**Core layer:**
- `MemoryAllocator` struct with `current` (bytes in use) and `limit` (0 = unlimited). Declared as a member of `LuaRuntime` **before** `L_` so the allocator outlives the Lua state during destruction.
- `LuaAllocator` static function matching the `lua_Alloc` signature. All Lua states are created with `lua_newstate(LuaAllocator, &allocator_, 0)` — even without a limit, the allocator tracks usage with negligible overhead.
- `RuntimeConfig` struct with `libraries` and `max_memory` fields. A new constructor `LuaRuntime(const RuntimeConfig& config)` accepts it, setting the allocator limit before creating the state.
- `GetMemoryUsage()` and `GetMemoryLimit()` inline getters return the allocator's current and limit values.

**Allocator logic:**
- `nsize == 0`: free the block, subtract `osize` from `current`.
- `ptr == NULL` (new allocation): `osize` is a Lua type tag (not a size), treated as 0.
- Otherwise: check `limit > 0 && current - old_size + nsize > limit`. If exceeded, return `NULL`. On success, `realloc` and update `current`.

**N-API layer:**
- `LuaContext` constructor parses `options.maxMemory` (number). Negative values throw a `TypeError`. When present, a `RuntimeConfig` is built and passed to the new core constructor.
- `get_memory_usage()` instance method returns `runtime->GetMemoryUsage()` as a JS number.

### Design Decisions

**Always use custom allocator:** Rather than conditionally switching between `luaL_newstate` (default allocator) and `lua_newstate` (custom allocator), all states use the custom allocator. With `limit=0`, it just tracks usage — the overhead is a single size_t addition per allocation. This makes `get_memory_usage()` universally available.

**`RuntimeConfig` struct:** Instead of adding more constructor overloads for each new option, a config struct groups them. This is future-proof for Execution Time Limits (the next Tier 1 feature).

**Member ordering:** `allocator_` is declared before `L_` in the class definition. C++ destroys members in reverse declaration order, so `L_` (and thus `lua_close`, which calls the allocator during teardown) is destroyed before `allocator_`. This prevents use-after-free during destruction.

**OOM recovery:** After an OOM error, the Lua state remains usable — Lua catches the `NULL` return from the allocator and raises a recoverable error via `lua_pcall`. The context can continue running smaller scripts.

---

## Type-System Fidelity (July 2026)

### Overview

The JS→Lua conversion path (`NapiToCoreInstance`) previously handled only
primitives, arrays, plain objects, and functions. Every other JS type silently
degraded — `BigInt`/`Symbol` became `nil`, and `Date`/`Map`/`Set`/`Buffer`/
`TypedArray`/`RegExp` became empty tables. Two features close this gap:

- **B1 — Built-in type handling:** common JS built-ins now convert to their
  natural Lua representation, and 64-bit integer precision is preserved in both
  directions.
- **B2 — Custom type converters:** `register_type_converter(match, convert)`
  lets applications control how their own types cross into Lua (and override the
  built-in handling).

### Type Mapping (JS → Lua)

| JS type | Lua result | Notes |
|---|---|---|
| `BigInt` | integer | Throws if outside signed 64-bit range |
| `Symbol` | — | Rejected with a descriptive error (cannot cross) |
| `Buffer` | string | Binary-safe (embedded nulls preserved) |
| `TypedArray` (any) | string | Raw bytes, honoring `byteOffset`/`byteLength` |
| `ArrayBuffer` | string | Raw bytes |
| `Date` | number | Epoch milliseconds (`getTime()`) |
| `Map` | table | Keys stringified, matching plain-object behavior; values recurse |
| `Set` | array | Values recurse |
| `RegExp` | string | The `.source` pattern (flags dropped) |

Reverse direction (`CoreToNapi`): a Lua integer whose magnitude exceeds
`2^53 - 1` is returned as a JS `BigInt` (rather than a lossy `Number`), so 64-bit
integers round-trip exactly. Smaller integers remain `Number`.

### Architecture

**Binding layer (`lua-native.cpp`):**

- Two free helpers: `IsInstanceOfGlobal` (uses `napi_instanceof` against a named
  global constructor — robust for `Map`/`Set`/`RegExp`, which have no dedicated
  N-API predicate) and `BinaryBytesToString` (copies Buffer/TypedArray/
  ArrayBuffer bytes into a binary-safe `std::string`, guarding zero-length
  views).
- `ConvertBuiltinType(value, depth, recurse)` centralizes the built-in
  conversions and takes a `recurse` callback so nested `Map`/`Set` elements pass
  back through the caller's conversion path (preserving markers and converters).
  It is shared by both `NapiToCoreInstance` and the static `NapiToCore`.
- `NapiToCoreInstance` gains `napi_bigint` and `napi_symbol` cases, and inside
  the object branch runs (in order): internal round-trip markers → user
  converters → `ConvertBuiltinType` → array → plain object.
- `CoreToNapi` emits `Napi::BigInt::New` for out-of-safe-range `int64_t`.

**Converter registry:** `type_converters_` on `LuaContext` is an ordered vector
of `{match, convert}` `Napi::FunctionReference` pairs. During conversion, each
`match` is called with the value; the first truthy match's `convert` produces a
JS value that is then converted normally (via `NapiToCoreInstance`, so a
converter may return any Lua-convertible value, including nested structures).

### Design Decisions

**Converters run after internal markers, before built-ins.** Metatabled-table
Proxies (`_tableRef`) and userdata handles (`_userdata`) are detected *before*
converters so reference round-tripping is never hijacked by a catch-all
converter. Converters then take precedence over the built-in `Date`/`Map`/etc.
handling, so an application can override those if desired.

**Converters see objects only.** The converter loop lives in the `napi_object`
branch, so primitives, functions, `BigInt`, and `Symbol` bypass it. This keeps
primitive conversion fast and predictable; the registry targets the reference
types where custom handling is actually needed.

**BigInt only on overflow (out).** Returning `BigInt` for *every* Lua integer
would be a broad breaking change and awkward for the common case. Emitting it
only above `2^53 - 1` changes behavior solely for values that were already being
corrupted by precision loss — a pure improvement.

**Symbol rejects rather than nils.** A silent `nil` hides bugs. Since a JS
`Symbol` has no meaningful Lua representation, conversion throws with a clear
message (surfaced as a JS error by the existing `set_global`/callback try/catch
wrappers).

**Map/Set via `Array.from`.** Rather than reimplementing Map/Set iteration
through the N-API, the helper calls the global `Array.from` to materialize
entries/values, then walks the resulting array — simple and spec-correct.

---

## Class / Usertype Binding (July 2026)

### Overview

`register_class(name, definition)` lets Lua **construct and drive** JavaScript
objects, going beyond `set_userdata` (which only exposes a *pre-existing*
instance). A registered class produces a global constructor table so Lua can
write `local p = Player.new("Link", 100)`, call methods (`p:take_damage(10)`),
read/write properties (`p.health`), and use overloaded operators (`a + b`,
`a == b`, `tostring(a)`).

Three capabilities, per the roadmap:

- **C1 — Constructor binding:** `Class.new(...)` invokes the JS `construct`
  function and returns a fresh instance bound to the class.
- **C2 — Shared per-class metatable:** one metatable per class carries the
  methods, `__index`/`__newindex` (property access), and `__gc`, rather than
  wiring each instance individually.
- **C3 — Operator overloading:** `metamethods` (e.g. `__add`, `__eq`, `__lt`,
  `__len`, `__concat`, `__unm`, `__tostring`, `__call`) dispatch to JS.

### Architecture

**Core layer (`lua-runtime.cpp`):**

- `RegisterClass(class_name, constructor_func_name, method_map, metamethods)`
  builds three things:
  1. A shared instance metatable `_class_mt_<class_name>` with `__gc`
     (`UserdataGC`), `__index` (a new `ClassIndex` closure carrying the class
     name), `__newindex` (reuses `UserdataNewIndex` → the property setter),
     `__name`, a `__lua_native_class` marker, and one `LuaCallHostFunction`
     closure per metamethod (the same bridge `set_metatable` uses).
  2. A shared method table in the registry at `_class_methods_<class_name>`
     mapping method name → host function name.
  3. A global table `<class_name>` whose `new` field is a `LuaCallHostFunction`
     closure over the constructor host function.
- `ClassIndex` resolves `instance.key` by first checking the shared class
  method table (returning a bound `UserdataMethodCall` closure) and then falling
  through to the property getter — mirroring `UserdataIndex` but class-scoped
  rather than per-instance.
- `LuaUserdataRef` gained a `class_name` field. When non-empty, `PushLuaValue`
  materializes the instance with the class metatable (instead of the opaque/
  proxy metatables). `ToLuaValue` recognizes a class instance by the
  `__lua_native_class` marker on its metatable and reconstructs a JS-backed
  (`opaque = false`) `LuaUserdataRef` carrying the class name — so `self` and
  operands arrive in JS as the original instance object, not an opaque handle.

**Binding layer (`lua-native.cpp`):**

- `RegisterClass` validates the definition, then registers three kinds of host
  functions via the existing bridge: the constructor (`__class_ctor_<id>`),
  each method (`__class_method_<id>_<name>`), and each metamethod
  (`__class_mm_<id>_<key>`). Methods and metamethods reuse
  `CreateJsCallbackWrapper`; the constructor uses a dedicated
  `CreateConstructorWrapper`.
- `CreateConstructorWrapper` calls the JS `construct` function, requires an
  object result, allocates a `ref_id`, stores the instance in `js_userdata_`
  (with the class's `readable`/`writable` flags), tags it with non-enumerable
  `__luaClassRef`/`__luaClassName` markers, and returns a class-bound
  `LuaUserdataRef`. `LuaCallHostFunction` then pushes it as class userdata.
- `NapiToCoreInstance` detects the `__luaClassRef` marker (alongside the
  existing `_tableRef`/`_userdata` markers) so that a class instance passed
  *back* into Lua re-materializes as the same class userdata rather than
  deep-copying to a table.

### Design Decisions

**Reuses the userdata/host-function machinery.** Instances are ordinary
JS-backed userdata (an `int ref_id` block in `js_userdata_`), method dispatch
reuses `UserdataMethodCall`, property access reuses the existing
getter/setter callbacks, and operators reuse `LuaCallHostFunction` — exactly the
bridge behind `set_metatable`. The only genuinely new pieces are the per-class
metatable, `ClassIndex`, and the constructor wrapper.

**Shared metatable, shared method table.** Methods live once per class in the
registry (not per instance), so constructing many instances is cheap. `__gc`
still balances the per-instance ref count.

**Instance identity round-trips; freshly built JS objects do not.** An instance
created by `Class.new` is tagged, so passing it out to JS and back (or returning
`self`/an operand from a method) preserves its identity and class binding.
However, an object a JS handler constructs *itself* (e.g. `return new Vec(...)`
inside `__add`) is **not** tagged, so it arrives in Lua as a plain table.
Metamethods/methods that must yield a usable instance should mutate and return
`self`, or the instance should be built via `Class.new` in Lua. This matches the
library's existing userdata round-trip model (JS objects are userdata only when
the library created the binding).

**`construct` must return an object.** Returning a primitive, array, or function
throws a descriptive error — an instance needs property/method storage.

---

## Coroutine-Driven Async Execution (July 2026)

### Overview

`execute_async(script)` runs Lua as a coroutine **on the main thread** and
transparently awaits JavaScript Promises returned by host functions. This is
distinct from `execute_script_async` (which runs on a libuv worker thread and
forbids callbacks). When a host function returns a Promise, the Lua coroutine
suspends until it settles and resumes with the resolved value — so Lua code reads
naturally:

```lua
local user = fetchUser(42)   -- fetchUser is `async () => ...`; suspends here
return user.name
```

`cancel()` aborts an in-flight run. This closes gaps A1 (await promises), A2
(callbacks work during async, since we are on the main thread), and A3
(cancellation) from the gap analysis. A4 (coroutine-as-async-iterator) and A5
(worker pool) remain deferred.

### Architecture

The mechanism is a **main-thread coroutine driver** built on `lua_yieldk`:

**Core layer (`lua-runtime.cpp`):**

- `CreateCoroutineFromScript` loads the script chunk as a function on a fresh
  Lua thread (coroutine) and anchors it in the registry.
- The host dispatchers (`LuaCallHostFunction` and `UserdataMethodCall`), after
  invoking the JS function, check `await_pending_`. If set, they suspend the
  coroutine with `lua_yieldk(L, 0, 0, AsyncContinuation)` instead of pushing a
  return value.
- `AsyncContinuation` is the `lua_KFunction` resumed when the promise settles.
  It returns the resume argument (the resolved value) as the awaited call's
  result, or — when `await_is_error_` is set — raises it as a Lua error via
  `lua_error` (so rejections are catchable with `pcall`).
- `ResumeAsyncStep` performs one `lua_resume` and reports whether the coroutine
  **Finished** (with return values), is **Awaiting** (yielded to await a
  promise), or **Errored**. It sets `await_is_error_` before resuming so the
  continuation knows whether the resume value is a result or a rejection.

**Binding layer (`lua-native.cpp`):**

- `CreateJsCallbackWrapper` inspects each host call's result with `IsPromise()`.
  In async-driver mode it stashes the promise (`async_pending_promise_`), calls
  `RequestAwaitYield()`, and returns nil (the continuation supplies the real
  value later). Outside the driver, a returned Promise throws a descriptive
  error.
- `ExecuteAsync` creates the coroutine, enters driver mode, and calls
  `DriveAsync` for the initial resume. `DriveAsync` inspects the step result:
  **Finished** → resolve the JS Promise; **Errored** → reject it; **Awaiting** →
  attach `then(onResolve, onReject)` to the stashed promise. The `then`
  callbacks (`OnAwaitResolveStatic`/`OnAwaitRejectStatic`, carrying the context
  as function data) call back into `DriveAsync` with the settled value, driving
  the coroutine forward one await at a time.
- `Cancel` abandons the suspended coroutine, tears down driver state, and
  rejects the run's Promise; a later settlement of the outstanding promise
  becomes a no-op (the drive state is gone).

### Design Decisions

**Main thread, not a worker.** Awaiting a JS Promise and running JS callbacks
both require the main thread (N-API is not thread-safe). Running the coroutine on
the main thread makes both work; the event loop stays free during the `await`
gaps because control returns to it while the promise is pending.

**`lua_yieldk` for transparent await.** Suspending from *inside* a C host call
(rather than requiring an explicit Lua `await(...)`) needs a yield across the
C-call boundary, which `lua_yieldk` provides via a continuation. The result: any
host function returning a Promise suspends automatically — no special Lua syntax.

**Rejections become Lua errors.** A rejected promise is raised inside Lua via
`lua_error`, so scripts can `pcall` around awaited calls; an uncaught rejection
propagates out and rejects the JS Promise. This mirrors how synchronous host
exceptions already surface.

**One run per context, guarded by `is_busy_`.** A single `lua_State` is not
reentrant, so `execute_async` sets `is_busy_` for the whole run (including await
gaps). Concurrent async/sync calls on the same context throw; true concurrency
uses multiple contexts (each its own `lua_State`).

**Cancellation is settle-time, not preemptive.** Because JavaScript is
single-threaded, `cancel()` can only run while the coroutine is suspended
awaiting a promise (never mid-CPU-loop). It therefore rejects immediately and
abandons the suspended coroutine rather than needing an interrupt hook.

**Promise-returning host calls are rejected in sync mode.** Calling such a
function from `execute_script` throws (there is no coroutine to suspend),
pointing the user at `execute_async`.

---

## Error Fidelity (July 2026)

### Overview

Three related improvements to how errors cross the Lua/JS boundary:

- **D2 — Stack traces:** every Lua error now carries a `stack traceback`,
  produced by a message handler installed on all protected calls.
- **D1 — JS Error fidelity:** a JavaScript `Error` thrown by a host function is
  preserved. Inside Lua it appears as a readable table
  (`err.message`, `err.name`, `err.stack`); if it propagates uncaught back to
  JS, the **original `Error` instance** is re-thrown — same type, message,
  stack, and custom properties — not a flattened string.
- **D3 — Protected calls from JS:** `pcall(fn, ...args)` calls a function and
  returns `{ ok, value }` / `{ ok, error }` instead of throwing.

### Architecture

**Core layer (`lua-runtime.cpp`):**

- `MessageHandler` is a `lua_pcall` message handler that appends a traceback via
  `luaL_traceback` (which works even when the `debug` library is not loaded). It
  deliberately leaves structured JS-error tables (identified by a `__jsErrorId`
  field) untouched, so they are not flattened to strings.
- `ProtectedCall` installs `MessageHandler` beneath the target function and runs
  `lua_pcall`; it replaces the bare `lua_pcall` in `ExecuteScript`,
  `ExecuteFile`, `CallFunction`, and `LoadBytecode`. The async path appends a
  traceback to string errors via `luaL_traceback` on the coroutine thread.
- `CaptureError` records the raw error **value** (`last_error_value_`) alongside
  a display string, so the binding layer can inspect the structured error. It is
  cleared at the entry of every execution method to avoid stale reads.
- The host dispatchers (`LuaCallHostFunction`, `UserdataMethodCall`), when a
  wrapper stages a structured error (`HasPendingErrorValue()`), raise that Lua
  table instead of a formatted string.

**Binding layer (`lua-native.cpp`):**

- `StageJsError` handles a thrown `Napi::Value`: for object errors it stores the
  original in `js_error_registry_` under an integer id and stages a plain Lua
  table `{ message, name, stack, __jsErrorId }` (via `SetPendingErrorValue`);
  non-object throws fall back to a string.
- `LuaErrorToJsValue` inspects the captured error value: if it is a table with a
  known `__jsErrorId`, it returns the original `Error` from the registry (and
  erases it); otherwise it builds a plain `Error` from the (traceback-bearing)
  string. `ThrowLuaError` throws the result. These run at every error-surfacing
  point — `execute_script/file`, `load_bytecode`, returned-Lua-function calls,
  and async rejection.
- `CallScope` (RAII) clears the registry when the outermost Lua call begins,
  bounding its lifetime to a single call tree; the async path clears it in
  `execute_async`/`FinishAsync`.
- `Pcall` calls the function inside a C++ try/catch and packages the outcome as
  `{ ok, value }` or `{ ok, error }`, where `error` is whatever
  `LuaFunctionCallbackStatic` threw (a reconstructed original error when
  applicable).

### Design Decisions

**Plain table, not a marker string.** JS errors become a plain (metatable-free)
Lua table, so: Lua code reads `err.message`/`err.name`/`err.stack` naturally; the
value deep-copies cleanly for capture (no registry-ref leak); and no marker
characters ever appear in a user-visible message. The message handler skips
these tables so a traceback is not spliced into them.

**Re-throw the original object.** Rather than reconstructing an Error from parsed
fields, the exact `Error` instance is kept alive and re-thrown, giving 100%
fidelity (subclass, `name`, `stack`, custom properties). This is a behavior
change: object errors surface **unwrapped** (no "Host function 'x' threw…"
prefix). Non-object throws (`throw "str"`, `throw 42`) still surface as a
message string.

**Tracebacks via `luaL_traceback`, not the `debug` library.** Using the C
function directly means tracebacks work in sandboxed contexts that never load
`debug`.

**`pcall` is a thin, honest convenience.** It does not re-implement Lua's
`pcall`; it calls the JS-facing function under try/catch. Its value is not
throwing and surfacing the fidelity-preserved error as data.

---

## I/O, Output & Module Resolution (July 2026)

### Overview

Three capabilities for controlling how a Lua context talks to the outside world:

- **E1 — Output redirection:** `set_print_handler(fn)` (and the `print` init
  option) route `print()` and `io.write()` to a JS handler that receives the
  formatted output text, rather than the process stdout.
- **E2 — Dynamic `require`:** `add_searcher(fn)` installs a `package.searchers`
  entry backed by JavaScript, so modules can be resolved lazily/virtually
  (bundles, DB, in-memory) instead of only from the filesystem
  (`add_search_path`) or a static preload (`register_module`).
- **E3 — Bytecode guard:** the `allowBytecode: false` init option makes a context
  refuse binary chunks — `load_bytecode()` throws and Lua's `load()` is forced
  to text-only mode — for safely running untrusted scripts.

### Architecture

**Core layer (`lua-runtime.cpp`):**

- `SetOutputHandler` stores a `std::function<void(const std::string&)>` and
  installs `LuaPrint`/`LuaIoWrite` C functions over the `print` global and
  `io.write` field. `LuaPrint` reproduces Lua's own `print` (each argument via
  `luaL_tolstring`, tab-separated, trailing newline); `LuaIoWrite` writes
  arguments verbatim. Both fall back to `stdout` when no handler is set, and
  **skip the handler while `async_mode_` is active** (the worker-thread path)
  since JS calls are only safe on the main thread.
- `SetAllowBytecode(false)` records the flag (checked at the top of
  `LoadBytecode`) and wraps the global `load` with `SafeLoad`, a closure over the
  original `load` that forces the `mode` argument to `"t"` — so binary chunks
  fail regardless of the caller's arguments.
- `AddJsSearcher` appends `JsSearcher` (carrying the host function name as an
  upvalue) to `package.searchers`. `JsSearcher` calls the host function with the
  module name; a returned string is compiled with `luaL_loadbufferx(..., "t")`
  (text-only, so a searcher can never inject bytecode) and returned as the
  module loader; `nil` yields a "not found" message so the next searcher runs.
  It rejects Promise results (searchers must be synchronous) and is disabled in
  worker-thread async mode.

**Binding layer (`lua-native.cpp`):**

- `InstallPrintHandler` persists the JS function and sets a core output handler
  that forwards each chunk as a `Napi::String`. `set_print_handler(null)` clears
  it (output returns to stdout). The `print` option applies the same after
  callbacks are registered, so it wins over a callback-provided `print`.
- `add_searcher` registers the JS function as a host function (reusing
  `CreateJsCallbackWrapper`) and calls `AddJsSearcher`.
- The constructor reads `allowBytecode` and `print` from the options object
  after libraries are loaded and callbacks registered.
- The destructor clears the output handler alongside the GC/property handlers so
  a `print` during teardown can't reach a half-destroyed context.

### Design Decisions

**Handlers receive formatted text, not raw arguments.** The point of E1 is
"capture what would have gone to stdout," so `print` formatting (tabs,
`__tostring`, newline) happens in C before the handler runs. This differs from
the pre-existing trick of passing `print` in the callbacks object, which hands
the callback the raw Lua values; the dedicated handler is faithful stdout
capture and takes precedence.

**Searchers return source, not values.** A searcher returns Lua *source*, which
`require` compiles and runs — giving real modules with their own scope. Returning
a JS value/object is what `register_module` already does; E2 complements it for
the dynamic case.

**Text-only enforcement is defense-in-depth.** E3 gates both the explicit
`load_bytecode()` entry point and the in-Lua `load()` path (the vector an
untrusted script would actually use). `loadfile`/`dofile` remain gated by simply
not loading the `io`/`os` libraries (the `safe` preset excludes them).

---

## Reference Lifecycle — `release()` (July 2026)

### Overview

Every Lua value that crosses to JS as a *reference* (a function, a coroutine, a
table handle, or a metatabled-table Proxy) pins a Lua registry slot until its JS
wrapper is garbage-collected. For long-lived contexts that mint many references,
that accumulation is Lua-side memory the JS GC has no pressure to reclaim.
`lua.release(value)` drops the registry reference immediately;
`LuaTableHandle.release()` remains as the handle-local equivalent.

### Architecture

`LuaContext::Release` (binding layer only — no core changes) recognizes the
wrapper kind by its marker property and calls `release()` on the ref inside the
wrapper's `*Data` struct:

| Wrapper | Marker | Ref struct |
|---|---|---|
| Lua function (JS callable) | `__luaFnOwner` External | `LuaFunctionData.funcRef` |
| Coroutine object | `_coroutine` External | `LuaThreadData.threadRef` |
| Table handle / metatabled Proxy | `_tableRef` External | `LuaTableRefData.tableRef` |

The ref structs use shared ownership (`MakeRegistryOwner`), so `release()`
drops this wrapper's share and the slot is unref'd exactly once. The released
state is observable as `ref == LUA_NOREF`, which every consumer checks:

- The function trampoline (`LuaFunctionCallbackStatic`) throws
  `"Lua function has been released"` — covering direct calls, `pcall`, and a
  released function round-tripped into Lua and called from there.
- `resume()` throws `"coroutine has been released"` (a released `LuaThreadRef`
  carries a null thread pointer, so this check also prevents resuming a freed
  thread).
- The table-handle methods and all five Proxy traps (get/set/has/ownKeys/
  getOwnPropertyDescriptor) throw `"table handle has been released"`, as does
  passing a released table reference back into Lua.

### Design Decisions

**Double release is a no-op.** Matches `LuaTableHandle.release()`; release-heavy
cleanup code shouldn't need try/catch.

**Foreign wrappers are rejected.** A wrapper minted by another context is
refused (`"value belongs to a different Lua context"`), mirroring the round-trip
identity checks in `NapiToCoreImpl` — a registry index is only meaningful in the
registry that issued it.

**Non-reference values throw a `TypeError`.** A plain JS function or object
holds no registry slot; silently succeeding would mask bugs in cleanup paths.

**Release is rejected while busy.** Like other sync entry points,
`release()` throws while an async operation is in flight — the unref mutates the
registry, which the worker thread may be using.

---

## GC Control — `gc()` (July 2026)

### Overview

`lua.gc(command, ...)` exposes `lua_gc` so JavaScript can trigger, pause, and
tune Lua's collector. It pairs with the memory limits: users who care about
`maxMemory` want `gc('count')` for monitoring and `gc('collect')` for
deterministic cleanup, and latency-sensitive code wants to pause collection
across a batch.

```typescript
lua.gc('collect');                    // full cycle
lua.gc('stop'); /* batch */ lua.gc('restart');
const kb = lua.gc('count');           // 19.07
const wasRunning = lua.gc('isrunning');
const done = lua.gc('step', 1024);    // incremental slice
const prev = lua.gc('generational');  // 'incremental'
const oldPause = lua.gc('param', 'pause', 400);
```

### Architecture

Core: `LuaRuntime::GarbageCollect(command, step_size)` returning
`GCResult = variant<monostate, double, bool, string>`, plus
`GarbageCollectParam(name, value)` returning the previous value. Binding:
`LuaContext::GC` parses the JS arguments and `std::visit`s the result into the
matching JS type.

The command vocabulary deliberately mirrors Lua's own `collectgarbage` names —
`collect`, `stop`, `restart`, `count`, `step`, `isrunning`, `incremental`,
`generational`, `param` — so anything a user knows from Lua transfers directly.

`lua_gc` is documented `[-0, +0, –]`: it never raises a Lua error, so unlike the
allocating operations elsewhere in the core it needs no `RunProtected` frame.

### Lua 5.5 specifics

The plan in `FUTURE.md` was written against 5.4's `lua_gc`. In 5.5:

- `LUA_GCSTEP` takes a `size_t` vararg (bytes to treat as newly allocated; 0 =
  one basic step) and returns whether the step finished a cycle.
- `LUA_GCGEN` / `LUA_GCINC` take **no** varargs and return the previous mode.
- `LUA_GCSETPAUSE` / `LUA_GCSETSTEPMUL` are gone, replaced by `LUA_GCPARAM`
  with `(int param, int value)`, where a negative value reads without writing.

Passing the wrong number of varargs to a `...` function is undefined behavior,
so each option's arity was taken from `lapi.c` rather than assumed.

### Design Decisions

**`-1` is translated into a thrown error.** `lua_gc` answers -1 to *every*
option while the collector is internally stopped — mid-collection or during
state close. The manual states the function "should not be called by a
finalizer", and that is exactly the reachable case here: a Lua `__gc` metamethod
can call a host function that calls back into `lua.gc()`. Every option we issue
otherwise returns a non-negative value, so -1 is unambiguous and becomes
`"gc('...') is not available while a collection is in progress"` rather than a
nonsensical in-band result (a -1 KB count).

**No reentrancy guard beyond the busy check.** Unlike `reset()`, `lua_gc` is
safe with Lua frames live on the C stack — it is what the VM does implicitly on
any allocation. `RejectIfBusy` is still required: a worker thread owns the state
during async execution, and a finalizer reaching the userdata GC callback would
be an off-thread N-API call.

**`gc('count')` and `get_memory_usage()` measure different things.** `count` is
Lua's own GC accounting (`gettotalbytes`) in KB, verified to agree with
`collectgarbage('count')` run inside Lua. `get_memory_usage()` is this binding's
allocator tally in bytes, and it is the larger of the two: `luaL_Buffer` scratch
memory (used by `string.rep`, `table.concat`, `string.format`, …) is obtained by
calling the allocator function directly, bypassing `luaM_*` and therefore Lua's
GC accounting, until the buffer's box userdata is collected. The allocator tally
is what `maxMemory` enforces against, so it stays the authoritative figure;
`count` is the right number for reasoning about collector behavior.

**Stopping the collector cannot defeat `maxMemory`.** Lua's user stop flag
(`gcstp`) is distinct from its emergency-collection flag (`gcstopem`), so an
allocation that would exceed the cap still triggers a full emergency collection
before failing. `gc('stop')` is therefore a safe latency knob rather than a way
to turn a soft limit into a hard one.

**`reset()` does not preserve a stopped collector.** A paused collector is a
transient tuning knob, not context configuration; a fresh state inheriting one
would be a memory leak waiting to happen. The replacement state starts with
collection running.

---

## Context Reset — `reset()` (July 2026)

### Overview

`lua.reset()` discards the Lua state and replaces it with a fresh one carrying
the same options, without creating a new `LuaContext`. It targets long-lived
server processes that run many independent scripts: without it, the only way to
get a clean state is a new context, which means re-registering every callback,
module, search path, and userdata binding.

```typescript
const lua = new lua_native.init({ log: console.log }, { libraries: 'safe' });
lua.execute_script('x = expensive_computation()');
lua.reset();                     // fresh state — same callbacks, same options
lua.execute_script('return x');  // null
lua.execute_script('log("hi")'); // callbacks still work
```

### Architecture

Reset is implemented almost entirely in the binding layer. The core contributes
only `LuaRuntime::GetConfig()` — the `RuntimeConfig` a runtime was constructed
from, kept verbatim so a caller can build an identically-configured replacement
(`max_instructions` tracks `SetMaxInstructions`; the rest is fixed at
construction).

`LuaContext::Reset` runs this sequence:

1. **Reject if busy, or if Lua is on the C stack.** An in-flight async op
   (worker-thread or coroutine-driven) owns the state. A non-zero `call_depth_`
   — the counter `CallScope` maintains at every synchronous Lua entry point —
   means a host callback, metamethod, or table trap has re-entered JS from a
   live Lua frame; retiring the state there would free the `lua_State` those
   frames are still executing on.
2. **Build the replacement first.** `make_shared<LuaRuntime>(runtime->GetConfig())`
   runs before anything is torn down, so a construction failure leaves the
   context with its current, working state rather than no state at all.
3. **Detach the outgoing runtime** (`DetachRuntimeHandlers`) — the userdata GC,
   host-function GC, property, and output handlers all close over `this`, and
   `lua_close` fires `__gc` metamethods that must not reach members this call is
   about to clear.
4. **Drop `async_co_`**, the one registry ref the context holds directly rather
   than through a handle, while its state is still guaranteed open.
5. **Invalidate outstanding handles**: flip `alive_` and mint a fresh flag.
6. **Swap** `runtime`, then clear the bookkeeping that described the old state's
   contents (`js_callbacks_`, `js_userdata_`, `js_error_registry_`,
   `registered_classes_`).
7. **Replay** the context-level configuration onto the new state, in the
   constructor's order: `allowBytecode`, search paths, callbacks, print handler.

What is replayed versus what must be re-applied:

| Replayed automatically | Not replayed (rebind after reset) |
|---|---|
| Constructor callbacks object | `set_global` |
| Print handler (option or `set_print_handler`) | `set_userdata` |
| `allowBytecode` guard | `set_metatable` |
| `add_search_path` paths | `register_module` |
| Libraries, `maxMemory`, `maxInstructions` | `register_class` |
| Type converters (JS-side, never touched) | `add_searcher` |

### Design Decisions

**The retired state is not closed — it is orphaned.** Every handle that crossed
the boundary (`LuaFunctionData`, `LuaThreadData`, `LuaUserdataData`,
`LuaTableRefData`) holds a `shared_ptr<LuaRuntime>`, so the old state stays open
for exactly as long as some handle can still reach it. Closing it out from under
them would dangle both their registry refs and the raw `lua_State*` their unref
deleters captured (`MakeRegistryOwner` resolves the runtime from the main
state's extra space — a use-after-free on a closed state). With no outstanding
handles, the old runtime is destroyed synchronously inside `reset()`, which is
the common case and the one the feature exists for.

This is why the FUTURE.md sketch's `LuaRuntime::Reset()` (close + recreate
in place) was **not** implemented: it would hand every ref-holding wrapper a
dangling state with no way to detect it.

**Stale handles are invalidated, not silently repointed.** `alive_` is flipped
and re-minted, so pre-reset function handles and table Proxies throw. Coroutines
and opaque userdata are covered by the existing `data->runtime.get() ==
runtime.get()` identity checks in `resume()`, `release()`, and the
`NapiToCoreImpl` round-trip markers — after the swap those simply stop matching,
so a pre-reset value is treated as foreign rather than indexing an unrelated
slot in the new registry.

**Reentrancy is rejected, not deferred.** `reset()` from inside a host callback
could in principle be queued and applied once the Lua call unwinds, but the
callback's own return value would then be pushed onto a state that no longer
exists. Failing loudly at the call site is both simpler and easier to diagnose.

**Id counters stay monotonic across a reset.** `next_userdata_id_`,
`next_js_callback_id_`, and friends are deliberately *not* rewound: a name or
`ref_id` minted before the reset must never collide with one minted after, since
the old runtime may still be alive and its GC callbacks reference those names.

**Search paths are replayed but modules are not.** A search path is a plain
string with no Lua-side identity, so replaying it is free. `register_module`,
`register_class`, `set_metatable`, and `set_userdata` all mint generated
host-function names bound to objects in the old state; replaying them would mean
rebuilding that graph, so they are documented as the caller's job instead.

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
| Table reference API | Moderate | February 2026 |
| Memory limits | Low | February 2026 |
| Type-system fidelity (built-in types + converter registry) | Moderate | July 2026 |
| Class / usertype binding (constructor, methods, operators) | High | July 2026 |
| Coroutine-driven async (await JS promises, callbacks, cancel) | High | July 2026 |
| Error fidelity (stack traces, JS Error round-trip, pcall) | Moderate | July 2026 |
| I/O redirection, JS require searcher, bytecode guard | Moderate | July 2026 |
| Reference lifecycle (`release()` for function/coroutine/table refs) | Low | July 2026 |
| Dotted path globals (`set_global`/`get_global` nested field access) | Low | July 2026 |
| Context reset (`reset()` — fresh state, replayed configuration) | Moderate | July 2026 |
| GC control (`gc()` — collect, stop/restart, step, count, mode, params) | Low | July 2026 |
