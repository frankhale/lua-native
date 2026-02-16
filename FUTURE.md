# Future Feature Considerations

This document outlines potential future enhancements for lua-native, with feasibility assessments and implementation approaches.

## Userdata Support

All userdata in lua-native uses Lua's **full userdata** - memory managed by Lua's GC with metatable support. This gives us `__gc` for automatic cleanup when Lua is done with a reference, and a path to property access via `__index` / `__newindex` in the future.

### Option A: Opaque JS Object References (Moderate Complexity)

Pass JS objects through Lua without conversion - Lua can store and pass them around, but not inspect them:

```typescript
const lua = new lua_native.init({
  processHandle: (handle) => {
    // handle is the original JS object, not converted
    handle.doSomething();
  }
});

const myObject = { data: [1,2,3], doSomething: () => console.log('called') };
lua.set_userdata('handle', myObject);  // Store as full userdata

lua.execute_script(`
  -- Lua can pass it around but not inspect it
  processHandle(handle)  -- JS receives original object
  local stored = handle  -- Can store in variables
`);
```

**Implementation:**
1. Add `LuaUserdataRef` type to the `LuaValue` variant (following the existing `LuaFunctionRef` / `LuaThreadRef` pattern)
2. Allocate full userdata containing a reference ID, with a `__gc` metamethod to clean up the JS reference automatically
3. Map reference IDs to JS objects in the context (similar to `js_callbacks` map)
4. When userdata flows back to JS via `CoreToNapi`, return the original object
5. Handle `LUA_TUSERDATA` in `ToLuaValue` (currently falls through to default/nil)

**Complexity:** ~100-150 lines of code

### Option B: Full Userdata with Property Access (High Complexity)

Allow Lua to read/write properties on JS objects:

```typescript
const obj = { x: 10, y: 20 };
lua.set_userdata('point', obj, {
  readable: true,   // Allow __index
  writable: true    // Allow __newindex
});

lua.execute_script(`
  print(point.x)      -- 10 (calls JS)
  point.y = 30        -- Updates JS object
`);
```

**Implementation requires:**
1. Full userdata allocation with metatables
2. `__index` metamethod calling back to JS
3. `__newindex` metamethod for writes
4. `__gc` metamethod for cleanup
5. Proper prevent-GC handling

**Why this is a significant architectural change:**

The current callback system is **name-based and global**. Host functions are stored in `host_functions_` keyed by name, and `LuaCallHostFunction` retrieves the function name from an upvalue to look it up. This works for named functions but doesn't support per-object behavior.

Property access metamethods need **per-userdata context**. When Lua calls `point.x`, the `__index` metamethod receives the userdata as `self` and `"x"` as the key. The C function handling this needs to:
- Identify *which* JS object this userdata refers to (not just a global name)
- Call back into JS to read/write the property on that specific object
- Convert the result back to Lua

This requires a new callback pattern in `LuaCallHostFunction` (`lua-runtime.cpp:55`) - the current closure-with-name-upvalue approach doesn't carry enough context. The metamethod closures would need the runtime pointer *and* the reference ID as upvalues, or the reference ID would need to be extracted from the userdata argument itself.

Specific code that would need changes:
- **`LuaValue` variant** (`lua-runtime.h:116`): Add `LuaUserdataRef` type
- **`ToLuaValue`** (`lua-runtime.cpp:254`): Handle `LUA_TUSERDATA` instead of falling through to nil
- **`PushLuaValue`** (`lua-runtime.cpp:259`): Push full userdata with metatable onto the Lua stack
- **`NapiToCoreInstance`** (`lua-native.cpp:231`): Recognize userdata handles coming back from JS
- **`CoreToNapi`** (`lua-native.cpp:343`): Map `LuaUserdataRef` back to the original JS object
- **New metatable C functions**: `__index`, `__newindex`, and `__gc` handlers that bridge per-userdata state back to JS
- **`LuaContext`** (`lua-native.h`): New storage for userdata→JS object mappings alongside the existing `js_callbacks` map

Option A (opaque handles) is a prerequisite - it establishes the `LuaUserdataRef` type, the reference mapping, and the `__gc` cleanup. Option B layers property access on top of that foundation.

### Option C: Receiving Userdata from Lua Libraries (Moderate Feasibility for Passthrough)

If Lua code creates userdata (e.g., from `io.open()` or C libraries):

```typescript
const file = lua.execute_script('return io.open("test.txt", "r")');
// file is userdata created by Lua's io library
```

**Problem:** These are opaque C pointers with library-specific layouts. JS cannot meaningfully interact with them without knowing the exact memory layout.

**Best approach:** Return an opaque handle that can only be passed back to Lua. This is straightforward to implement using the same `LuaUserdataRef` pattern from Option A - store a registry reference via `luaL_ref` and return it as an opaque external. The existing `LuaFunctionRef` pattern demonstrates exactly this approach.

**Feasibility:** Low for meaningful property inspection, but moderate for opaque passthrough (which is the practical use case - e.g., passing a file handle between Lua functions via JS).

### Recommendation

Start with Option A (opaque handles) - it's useful and self-contained. Implement Option C's passthrough support at the same time since it shares the same `LuaUserdataRef` infrastructure. Option B would be a future enhancement that builds on both this and metatable support.

---

## Metatable Support

Metatables enable operator overloading, custom indexing, and OOP patterns in Lua.

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

## Prerequisite: Expose `get_global`

The core `LuaRuntime` already implements `GetGlobal`, but it is not exposed through the N-API binding layer. Exposing it would complement `set_global` and is a natural prerequisite for several features above (e.g., retrieving userdata handles, inspecting metatable-equipped globals). This is a small change (~10-15 lines in `lua-native.cpp` and `lua-native.h`).

---

## Implementation Todo

A phased refactoring plan for full userdata support. Each phase builds on the previous one.

### Phase 1: Foundation (Option A - Opaque Handles)

**`lua-runtime.h` - New types:**
- [ ] Define `LuaUserdataRef` struct with `int ref` and `lua_State* L` (same pattern as `LuaFunctionRef`)
- [ ] Add `LuaUserdataRef` to the `LuaValue::Variant`
- [ ] Add `LuaValue::from(LuaUserdataRef&&)` factory method
- [ ] Define a userdata metadata type name constant (e.g., `static constexpr const char* kUserdataMetaName = "lua_native_userdata"`) for metatable identity

**`lua-runtime.cpp` - Core userdata handling:**
- [ ] Create a static `__gc` C function that extracts the reference ID from the userdata block and releases the mapping
- [ ] Add a `RegisterUserdataMetatable()` method that creates the shared metatable with `__gc` and stores it in the registry (called once during `LuaRuntime` construction)
- [ ] Handle `LUA_TUSERDATA` in `ToLuaValue` - extract the reference ID from the userdata memory block, return as `LuaUserdataRef`
- [ ] Handle `LuaUserdataRef` in `PushLuaValue` - allocate full userdata via `lua_newuserdata`, write the reference ID into the memory block, attach the shared metatable via `luaL_setmetatable`
- [ ] Add a `SetUserdataGlobal(name, ref_id)` method that creates the userdata on the Lua stack and sets it as a global

**`lua-native.h` - N-API storage:**
- [ ] Add `std::unordered_map<int, Napi::ObjectReference> js_userdata_` to `LuaContext` for mapping reference IDs to JS objects
- [ ] Add a reference ID counter (`int next_userdata_id_`)

**`lua-native.cpp` - N-API binding:**
- [ ] Implement `SetUserdata(const Napi::CallbackInfo&)` - assigns a reference ID, stores the JS object in `js_userdata_`, calls core `SetUserdataGlobal`
- [ ] Handle `LuaUserdataRef` in `CoreToNapi` - look up the reference ID in `js_userdata_` and return the original JS object
- [ ] Handle userdata objects in `NapiToCoreInstance` - if the value is a recognized userdata handle, convert back to `LuaUserdataRef`
- [ ] Register `set_userdata` in `LuaContext::Init` as a new instance method

**`types.d.ts`:**
- [ ] Add `set_userdata(name: string, value: object): void` to `LuaContext`

**Tests:**
- [ ] Store a JS object as userdata, pass it to a Lua callback, verify the original object is received
- [ ] Pass userdata between Lua variables, verify identity is preserved
- [ ] Verify userdata cleanup on Lua GC (`collectgarbage()`)
- [ ] Verify userdata returned from `execute_script` maps back to the original JS object

### Phase 2: Lua-Created Userdata Passthrough (Option C)

Builds on Phase 1's `LuaUserdataRef` type. Handles userdata created by Lua libraries (e.g., `io.open`).

**`lua-runtime.cpp`:**
- [ ] Extend `ToLuaValue` `LUA_TUSERDATA` handling - if the userdata doesn't carry a lua-native reference ID (check metatable name), store it in the registry via `luaL_ref` and return a `LuaUserdataRef` with an opaque flag
- [ ] Extend `PushLuaValue` `LuaUserdataRef` handling - if the ref is opaque (Lua-created), push it back from the registry via `lua_rawgeti`

**`lua-native.cpp`:**
- [ ] Extend `CoreToNapi` - for opaque userdata refs, return a JS object with `{ _userdata: External }` (same pattern as coroutines with `_coroutine`)

**Tests:**
- [ ] `io.open` returns a handle, pass it back to Lua's `io.close` via a JS callback
- [ ] Verify opaque userdata survives a round-trip through JS

### Phase 3: Property Access (Option B)

Builds on Phase 1. Adds `__index` and `__newindex` metamethods so Lua can read/write properties on JS objects.

**`lua-runtime.h`:**
- [ ] Add a `UserdataPropertyHandler` callback type: `std::function<LuaPtr(int ref_id, const std::string& key)>` for reads and `std::function<void(int ref_id, const std::string& key, const LuaPtr& value)>` for writes
- [ ] Add `SetPropertyHandlers(UserdataPropertyHandler getter, UserdataPropertyHandler setter)` to `LuaRuntime`

**`lua-runtime.cpp` - New metamethods:**
- [ ] Create a static `UserdataIndex` C function (`__index` handler):
  - Extract the reference ID from the userdata argument (`self`)
  - Read the key from the second argument
  - Look up the `LuaRuntime` from the registry
  - Call the registered property getter handler
  - Push the result onto the Lua stack
- [ ] Create a static `UserdataNewIndex` C function (`__newindex` handler):
  - Extract the reference ID from the userdata argument
  - Read the key and value from arguments
  - Call the registered property setter handler
- [ ] Extend `RegisterUserdataMetatable()` to conditionally include `__index` and `__newindex` in the metatable (or create a second metatable for property-enabled userdata)

**`lua-native.h`:**
- [ ] Add per-userdata access flags to `js_userdata_` (readable, writable) - change the map value from `Napi::ObjectReference` to a struct containing the reference and flags

**`lua-native.cpp`:**
- [ ] Implement the property getter handler: look up JS object by reference ID, call `obj.Get(key)`, convert result via `NapiToCoreInstance`
- [ ] Implement the property setter handler: look up JS object by reference ID, call `obj.Set(key, value)`, converting via `CoreToNapi`
- [ ] Register the handlers with the runtime during `LuaContext` construction
- [ ] Extend `SetUserdata` to accept an optional options argument `{ readable: bool, writable: bool }`
- [ ] Update `RegisterUserdataMetatable` call or create a separate metatable for property-enabled userdata

**`types.d.ts`:**
- [ ] Update `set_userdata` signature: `set_userdata(name: string, value: object, options?: { readable?: boolean, writable?: boolean }): void`

**Tests:**
- [ ] Read properties from Lua: `point.x` returns the JS value
- [ ] Write properties from Lua: `point.y = 30` updates the JS object
- [ ] Read-only userdata: writes throw a Lua error
- [ ] Write-only userdata: reads return nil or throw
- [ ] Nested property access: `obj.nested.value` (returns a table, not a proxy - one level deep)
- [ ] Non-existent property access returns nil
- [ ] Method calls: `obj:method()` works if the property is a function

### Phase 4: Expose `get_global` (Independent, Can Be Done Anytime)

**`lua-native.h`:**
- [ ] Declare `Napi::Value GetGlobal(const Napi::CallbackInfo& info)` on `LuaContext`

**`lua-native.cpp`:**
- [ ] Implement `GetGlobal` - call `runtime->GetGlobal(name)`, convert result via `CoreToNapi`
- [ ] Register `get_global` in `LuaContext::Init`

**`types.d.ts`:**
- [ ] Add `get_global(name: string): LuaValue` to `LuaContext`

**Tests:**
- [ ] Set a global, retrieve it, verify the value matches
- [ ] Retrieve a global that was set from Lua script
- [ ] Retrieve a non-existent global returns null

---

## Complexity Assessment

Current production code is ~1,179 lines across four source files. All four phases combined add an estimated ~310 lines of production code (~26% increase) and ~195 lines of tests (~17% increase).

### Per-file impact

| File | Current | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Total Added |
|------|---------|---------|---------|---------|---------|-------------|
| `lua-runtime.h` | 193 | +39 | +2 | +6 | — | +47 |
| `lua-runtime.cpp` | 418 | +56 | +15 | +65 | — | +136 |
| `lua-native.h` | 66 | +4 | — | +8 | +1 | +13 |
| `lua-native.cpp` | 502 | +42 | +10 | +45 | +12 | +109 |
| `types.d.ts` | 126 | +2 | — | +3 | +1 | +6 |
| **Tests** | 1,138 | +55 | +30 | +90 | +20 | +195 |

### Per-phase difficulty

**Phase 1 and Phase 4 are mechanical.** They follow the existing `LuaFunctionRef`/`LuaThreadRef` patterns almost exactly - define a ref struct, add variant branches, wire up the N-API method. Low risk.

**Phase 2 is small.** It's essentially an "else" branch in the Phase 1 code for userdata that doesn't carry a lua-native reference ID.

**Phase 3 is where the real complexity lives.** Not because of the line count (~124 lines) but because it introduces a new callback flow. Everything in the codebase today goes through `LuaCallHostFunction`, which dispatches via a name lookup in `host_functions_`. The `__index`/`__newindex` metamethods don't fit that pattern - they extract a reference ID from the userdata argument, map it to a JS object, then do a property get/set on that specific object. This is a fundamentally different dispatch path and the one piece that adds genuine architectural weight to the codebase.

### Summary

The total growth is moderate and won't significantly change the character of the codebase. Most of the new code is boilerplate mirroring existing patterns. The only part that warrants careful design is Phase 3's metamethod dispatch.

---

## Implementation Priority

| Feature | Complexity | Usefulness | Recommended Priority |
|---------|------------|------------|---------------------|
| Expose `get_global` | Low | High | 0 |
| Opaque userdata (Option A) + passthrough (Option C) | Moderate | Medium-High | 1 |
| Explicit metatables (Option B) | Moderate | Medium | 2 |
| Full userdata with properties | High | High | 3 |
| Reference-based tables with Proxy | High | High | 4 |

---

## Notes

- Coroutine support was implemented in January 2026
- Lua function returns to JS were implemented previously
- Both userdata and full metatable support share architectural requirements around keeping Lua references instead of immediate conversion
- The existing `LuaFunctionRef` and `LuaThreadRef` types demonstrate the registry-reference pattern that new features should follow
- The `LuaValue` variant in `lua-runtime.h` will need to be extended with new types (e.g., `LuaUserdataRef`) for each new feature
