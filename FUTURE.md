# Future Feature Considerations

This document outlines potential future enhancements for lua-native, with feasibility assessments and implementation approaches.

---

## Implemented: Full Userdata Support (February 2026)

All four phases of userdata support have been implemented and are fully tested (126 tests, all passing).

### What Was Implemented

**Phase 1 - Opaque JS Object References:** JS objects can be passed into Lua as full userdata via `set_userdata()`. Lua holds a reference to the original object (not a copy). When the userdata flows back to JS through callbacks or return values, the original object is returned. Automatic cleanup via `__gc` with reference counting.

**Phase 2 - Lua-Created Userdata Passthrough:** Userdata created by Lua libraries (e.g., `io.open()` file handles) can pass through JS callbacks and back to Lua without losing identity. Foreign userdata is detected by metatable check, stored in the Lua registry, and wrapped as `{ _userdata: External }` on the JS side for round-trip support.

**Phase 3 - Property Access:** JS objects can be exposed with `__index` and `__newindex` metamethods, allowing Lua to read and write properties directly. Per-userdata access control with `readable` and `writable` flags. Uses a separate proxy metatable (`lua_native_proxy_userdata`) from the opaque metatable (`lua_native_userdata`).

**Phase 4 - `get_global`:** The existing core `GetGlobal` method is now exposed through the N-API binding layer, complementing `set_global`.

### API

```typescript
// Opaque handle - Lua can pass it around but not inspect it
lua.set_userdata('handle', myObject);

// With property access - Lua can read/write properties
lua.set_userdata('player', playerObj, { readable: true, writable: true });

// Read-only - Lua can read but not write
lua.set_userdata('config', configObj, { readable: true });

// Get a global variable from Lua
const value = lua.get_global('myVar');
```

### Architecture

The implementation follows the existing `LuaFunctionRef` / `LuaThreadRef` patterns:

**Core layer (`lua-runtime.h/cpp`):**
- `LuaUserdataRef` struct with `ref_id` (JS object map key), `registry_ref` (for Lua-created passthrough), `opaque` flag, and `proxy` flag
- Added to the `LuaValue::Variant` type
- Two metatables registered at runtime construction:
  - `lua_native_userdata` - `__gc` only (opaque handles)
  - `lua_native_proxy_userdata` - `__gc`, `__index`, `__newindex` (property access)
- Reference counting via `IncrementUserdataRefCount` / `DecrementUserdataRefCount` with a GC callback to notify the N-API layer when Lua releases a reference
- `UserdataGC`, `UserdataIndex`, `UserdataNewIndex` static C functions as metamethod handlers
- `PropertyGetter` / `PropertySetter` callback types set by the N-API layer
- `CreateUserdataGlobal` / `CreateProxyUserdataGlobal` for creating userdata on the Lua stack

**N-API layer (`lua-native.h/cpp`):**
- `UserdataEntry` struct with `Napi::ObjectReference`, `readable`, `writable` flags
- `js_userdata_` map (`int` ref_id → `UserdataEntry`) for JS object storage
- `LuaUserdataData` struct for Lua-created userdata round-trip (similar to `LuaFunctionData`)
- `SetUserdata` method with optional `{ readable, writable }` options
- `GetGlobal` method
- GC callback clears entries from `js_userdata_` when Lua releases a reference
- Property handlers bridge Lua `__index`/`__newindex` to `obj.Get(key)` / `obj.Set(key, value)` on the original JS object
- `~LuaContext` nulls out GC and property callbacks before member destruction to prevent use-after-free during `lua_close()`

**Conversion layer changes:**
- `ToLuaValue` handles `LUA_TUSERDATA`: checks proxy metatable first, then opaque metatable (extracting ref_id), then falls back to opaque registry ref for foreign userdata
- `PushLuaValue` handles `LuaUserdataRef`: creates new userdata block with ref count increment for JS-created, pushes from registry for opaque
- `CoreToNapi` handles `LuaUserdataRef`: returns original JS object for JS-created, wraps as `{ _userdata: External }` for Lua-created
- `NapiToCoreInstance` detects `_userdata` external handles for Lua-created userdata round-trip

**Refactoring:**
- `LuaFunctionCallbackStatic` now routes through `context->CoreToNapi()` and `context->NapiToCoreInstance()` instead of the duplicate static `LuaValueToNapi` function. This was necessary so that userdata returned from Lua functions called in JS would convert correctly. The static `LuaValueToNapi` function was removed.
- `LuaFunctionData` gained a `LuaContext* context` pointer for this purpose.
- `CoreToNapi` and `NapiToCoreInstance` moved from private to public on `LuaContext`.

### Design Decisions

**Two metatables instead of one:** Opaque userdata uses `lua_native_userdata` (only `__gc`), while property-access-enabled userdata uses `lua_native_proxy_userdata` (`__gc` + `__index` + `__newindex`). This prevents accidental property dispatch on opaque handles and makes the metatable check in `ToLuaValue` unambiguous about the proxy flag.

**Reference counting for `__gc`:** When `PushLuaValue` creates a new userdata block (e.g., during round-trip through a host function), it increments the ref count for that ref_id. Each `__gc` decrements it. The JS object is only released from `js_userdata_` when the count reaches zero. This handles the case where multiple Lua userdata blocks share the same ref_id.

**Property handlers as callbacks:** The core layer doesn't know about N-API types. Property access is bridged via `PropertyGetter` / `PropertySetter` callbacks (`std::function`) set by the N-API layer during `LuaContext` construction. The `__index` C function extracts the ref_id from the userdata argument, retrieves the runtime from the registry, and calls the registered handler.

**Safe destructor ordering:** `~LuaContext` explicitly nulls out the GC callback and property handlers before member destruction begins. This prevents the `__gc` metamethods (which fire during `lua_close()` in `~LuaRuntime`) from accessing `js_userdata_` or calling property handlers on a partially destroyed `LuaContext`.

### Actual Complexity

| File | Before | After | Delta |
|------|--------|-------|-------|
| `lua-runtime.h` | 193 | 249 | +56 |
| `lua-runtime.cpp` | 418 | 530 | +112 |
| `lua-native.h` | 66 | 97 | +31 |
| `lua-native.cpp` | 502 | 519 | +17 |
| `types.d.ts` | 126 | 145 | +19 |
| **Tests** | 1,138 | 1,529 | +391 |

Production code grew by ~235 lines (~20% increase). Test code grew by ~391 lines (~34% increase). The `lua-native.cpp` delta is small (+17) because the `LuaFunctionCallbackStatic` refactor removed the duplicate `LuaValueToNapi` function (~55 lines), offsetting the new `SetUserdata`, `GetGlobal`, and `CoreToNapi`/`NapiToCoreInstance` additions.

---

## Implemented: Explicit Metatable Support (February 2026)

The `set_metatable()` API allows JS to attach Lua metatables to global tables, enabling operator overloading, custom indexing, `__tostring`, `__call`, and other metamethods. All 147 tests passing (21 new metatable tests).

### What Was Implemented

JS functions in the metatable object become Lua C closures (not string references). A new `StoreHostFunction` method stores JS callbacks in `host_functions_` without creating a Lua global, allowing metamethod closures to be built directly in the metatable.

### API

```typescript
lua.execute_script('vec = {x = 1, y = 2}');
lua.set_metatable('vec', {
  __tostring: (t) => `(${t.x}, ${t.y})`,
  __add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  __call: (self, n) => self.x * n,
  __index: { default_key: 42 },  // non-function values are supported too
});
```

### Supported Metamethods

All standard Lua metamethods work: `__tostring`, `__add`, `__sub`, `__mul`, `__div`, `__mod`, `__unm`, `__concat`, `__len`, `__eq`, `__lt`, `__le`, `__call`, `__index` (as function or table), `__newindex`.

### Architecture

**Core layer (`lua-runtime.h/cpp`):**
- `MetatableEntry` struct: `key` (string), `is_function` (bool), `func_name` (string), `value` (LuaPtr)
- `StoreHostFunction(name, fn)`: stores in `host_functions_` without creating a Lua global
- `SetGlobalMetatable(name, entries)`: validates the global exists and is a table, creates a new metatable, pushes each entry as either a `lua_pushcclosure(LuaCallHostFunction, 1)` (for functions) or `PushLuaValue` (for values), then attaches with `lua_setmetatable`. Uses `StackGuard` for stack safety.

**N-API layer (`lua-native.h/cpp`):**
- `SetMetatable` method: validates arguments, iterates JS metatable properties, generates unique function names (`__mt_<id>_<key>`) for function entries, stores JS callbacks via `StoreHostFunction` + `CreateJsCallbackWrapper`, converts non-function values via `NapiToCoreInstance`, builds `vector<MetatableEntry>`, and delegates to `SetGlobalMetatable`
- `next_metatable_id_` counter ensures unique function names across multiple `set_metatable` calls

**Key design decision:** JS functions are stored as host functions with unique generated names rather than registered as globals. This avoids polluting the Lua global namespace with internal metamethod closures. The existing `LuaCallHostFunction` bridge is reused — the same upvalue-based dispatch mechanism that powers `RegisterFunction` works identically for metamethod closures.

### Limitation

Only works for global tables. Could be extended to work on table references if/when reference-based tables are implemented.

---

## Remaining: Reference-Based Tables

Keep tables as Lua references instead of immediately converting to JS objects/arrays. Use JS Proxy for transparent property access:

```typescript
const lua = new lua_native.init({});
const obj = lua.execute_script<LuaTableRef>(`
  local t = {}
  setmetatable(t, { __index = function(_, k) return k:upper() end })
  return t
`);
obj.hello  // "HELLO" - goes through metatable
```

**Challenges:**
- Currently, tables are converted to JS objects/arrays immediately (no Lua reference kept)
- Tables would need to remain as Lua references with JS Proxy wrappers
- Significant change to the conversion layer
- Would need a way to opt in/out to avoid breaking the existing immediate-conversion behavior (e.g., a `{ refTables: true }` option, or only returning refs for tables that have metatables)

With explicit metatable support now implemented, this becomes the natural next step for full metatable interop — allowing metatabled tables returned from Lua to preserve their metamethods when accessed from JS.

---

## Implementation Priority

| Feature | Complexity | Usefulness | Status |
|---------|------------|------------|--------|
| Expose `get_global` | Low | High | **Done** |
| Opaque userdata + passthrough | Moderate | Medium-High | **Done** |
| Full userdata with properties | High | High | **Done** |
| Explicit metatables | Moderate | Medium | **Done** |
| Reference-based tables with Proxy | High | High | Planned |

---

## Notes

- Coroutine support was implemented in January 2026
- Lua function returns to JS were implemented previously
- Full userdata support (opaque handles, passthrough, property access) was implemented in February 2026
- `get_global` was exposed in February 2026
- Explicit metatable support (`set_metatable`) was implemented in February 2026
- Reference-based table support (with Proxy) remains the main outstanding architectural change, sharing requirements with the now-implemented userdata reference pattern
