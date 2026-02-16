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

## Remaining: Metatable Support

Metatables enable operator overloading, custom indexing, and OOP patterns in Lua. With userdata and property access now implemented, the remaining metatable work is about tables specifically.

### Option A: Reference-Based Tables (Significant Architectural Change)

Keep tables as references like functions, use JS Proxy for transparent access:

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

### Option B: Explicit Metatable Methods (Simpler)

Add methods to set/get metatables on globals:

```typescript
const lua = new lua_native.init({});
lua.set_global('myTable', { value: 42 });
lua.set_metatable('myTable', {
  __tostring: () => 'MyTable object'
});
```

**Limitation:** Only works for globals, not arbitrary tables. Could be extended to work on table references if/when reference-based tables are implemented.

### Recommendation

Option B (explicit methods) as a stepping stone, with Option A (full proxy support) as a future enhancement if there's demand. For Option A, consider only returning table references when a metatable is present, preserving the current immediate-conversion behavior for plain tables.

---

## Implementation Priority

| Feature | Complexity | Usefulness | Status |
|---------|------------|------------|--------|
| Expose `get_global` | Low | High | **Done** |
| Opaque userdata + passthrough | Moderate | Medium-High | **Done** |
| Full userdata with properties | High | High | **Done** |
| Explicit metatables | Moderate | Medium | Planned |
| Reference-based tables with Proxy | High | High | Planned |

---

## Notes

- Coroutine support was implemented in January 2026
- Lua function returns to JS were implemented previously
- Full userdata support (opaque handles, passthrough, property access) was implemented in February 2026
- `get_global` was exposed in February 2026
- Reference-based table support (with Proxy) remains the main outstanding architectural change, sharing requirements with the now-implemented userdata reference pattern
