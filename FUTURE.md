# Future Feature Considerations

This document outlines potential future enhancements for lua-native, with feasibility assessments and implementation approaches.

## Userdata Support

Lua has two userdata types:
1. **Light userdata** - A raw C pointer, no GC, no metatables
2. **Full userdata** - Memory managed by Lua GC, can have metatables

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
lua.set_userdata('handle', myObject);  // Store as light userdata

lua.execute_script(`
  -- Lua can pass it around but not inspect it
  processHandle(handle)  -- JS receives original object
  local stored = handle  -- Can store in variables
`);
```

**Implementation:**
1. Add `LuaUserdataRef` type storing a reference ID
2. Map reference IDs to JS objects in the context
3. When userdata flows back to JS, return the original object

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

This is essentially metatable support - requires significant architectural changes.

### Option C: Receiving Userdata from Lua Libraries (Low Feasibility)

If Lua code creates userdata (e.g., from `io.open()` or C libraries):

```typescript
const file = lua.execute_script('return io.open("test.txt", "r")');
// file is userdata created by Lua's io library
```

**Problem:** These are opaque C pointers with library-specific layouts. JS cannot meaningfully interact with them without knowing the exact memory layout.

**Best approach:** Return an opaque handle that can only be passed back to Lua.

### Recommendation

Start with Option A (opaque handles) - it's useful and self-contained. Option B would be a future enhancement that builds on both this and metatable support.

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

### Option B: Explicit Metatable Methods (Simpler)

Add methods to set/get metatables on globals:

```typescript
const lua = new lua_native.init({});
lua.set_global('myTable', { value: 42 });
lua.set_metatable('myTable', {
  __tostring: () => 'MyTable object'
});
```

**Limitation:** Only works for globals, not arbitrary tables.

### Recommendation

Option B (explicit methods) as a stepping stone, with Option A (full proxy support) as a future enhancement if there's demand.

---

## Implementation Priority

| Feature | Complexity | Usefulness | Recommended Priority |
|---------|------------|------------|---------------------|
| Opaque userdata (Option A) | Moderate | Medium | 1 |
| Explicit metatables (Option B) | Moderate | Medium | 2 |
| Full userdata with properties | High | High | 3 |
| Reference-based tables with Proxy | High | High | 4 |

---

## Notes

- Coroutine support was implemented in January 2025
- Lua function returns to JS were implemented previously
- Both userdata and full metatable support share architectural requirements around keeping Lua references instead of immediate conversion
