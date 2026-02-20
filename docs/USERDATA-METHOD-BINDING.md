# Userdata Method Binding

Allow JavaScript objects exposed as Lua userdata to have callable methods via
Lua's `:` syntax (`obj:method(args)`). Currently, proxy userdata supports
property access (`obj.x`, `obj.x = 5`) through `__index`/`__newindex`
metamethods, but there is no way to define methods — functions attached to the
userdata that receive the object as `self`.

Method binding is the standard pattern for exposing object-oriented APIs to Lua.
6 of 7 surveyed Lua bridge libraries (sol2, LuaBridge3, mlua, gopher-lua,
fengari, NLua) support it.

---

## Motivation

### The Problem

Consider a `DatabaseConnection` object with a `query` method. Today, the only
way to expose it is through global wrapper functions:

```typescript
const db = new DatabaseConnection('localhost', 5432);

const lua = new lua_native.init({
  db_query: (handle, sql) => handle.query(sql),
  db_close: (handle) => handle.close(),
});

lua.set_userdata('db', db);

lua.execute_script(`
  -- Awkward: global functions, prefixed by convention
  local results = db_query(db, "SELECT * FROM users")
  db_close(db)
`);
```

This has several problems:

1. **Global namespace pollution.** Every method becomes a global function. With
   multiple object types, names collide or require ugly prefixes.
2. **Not idiomatic Lua.** Lua developers expect `obj:method()` syntax. The
   colon call passes `obj` as the implicit first argument — it's the standard
   OOP pattern in Lua (used by the standard library, every game engine, etc.).
3. **No discoverability.** Methods are scattered as globals rather than attached
   to the object they operate on. There's no way to inspect what operations an
   object supports.

### The Solution

With method binding, the same example becomes:

```typescript
const db = new DatabaseConnection('localhost', 5432);

lua.set_userdata('db', db, {
  methods: {
    query: (self, sql) => self.query(sql),
    close: (self) => self.close(),
  }
});

lua.execute_script(`
  -- Idiomatic Lua: methods on the object
  local results = db:query("SELECT * FROM users")
  db:close()
`);
```

The Lua code reads naturally. Methods are scoped to the object. No global
pollution. Multiple userdata instances of the same "type" share the same method
table.

---

## API Design

### Basic Usage

```typescript
const player = { x: 0, y: 0, hp: 100, name: 'Alice' };

lua.set_userdata('player', player, {
  readable: true,
  writable: true,
  methods: {
    move: (self, dx, dy) => {
      self.x += dx;
      self.y += dy;
    },
    heal: (self, amount) => {
      self.hp = Math.min(100, self.hp + amount);
    },
    get_pos: (self) => {
      return [self.x, self.y];
    },
    describe: (self) => {
      return `${self.name} at (${self.x}, ${self.y}) with ${self.hp}hp`;
    },
  }
});
```

From Lua:

```lua
player:move(10, 20)
player:heal(25)

local x, y = player:get_pos()
print(x, y)              -- 10  20

print(player:describe()) -- Alice at (10, 20) with 100hp

-- Property access still works alongside methods
print(player.name)       -- Alice
player.hp = 50
```

### Methods Without Property Access

Methods work independently of `readable`/`writable`. An opaque handle can have
methods even if its properties are hidden:

```typescript
const conn = new DatabaseConnection('localhost', 5432);

lua.set_userdata('conn', conn, {
  // No readable/writable — properties are hidden
  methods: {
    query: (self, sql) => self.query(sql),
    close: (self) => self.close(),
    is_connected: (self) => self.isConnected(),
  }
});
```

```lua
-- Methods work
local rows = conn:query("SELECT 1")
print(conn:is_connected())  -- true

-- Properties are inaccessible (returns nil)
print(conn.host)             -- nil
```

### Methods with Return Values

Methods follow the same return value conventions as callbacks:

```typescript
lua.set_userdata('vec', { x: 3, y: 4 }, {
  readable: true,
  methods: {
    length: (self) => Math.sqrt(self.x ** 2 + self.y ** 2),
    add: (self, other) => {
      // 'other' is the JS object from another userdata
      return { x: self.x + other.x, y: self.y + other.y };
    },
    normalized: (self) => {
      const len = Math.sqrt(self.x ** 2 + self.y ** 2);
      return [self.x / len, self.y / len]; // multiple return values
    },
  }
});
```

```lua
print(vec:length())            -- 5.0

local nx, ny = vec:normalized()
print(nx, ny)                  -- 0.6  0.8
```

### The `self` Parameter

When Lua calls `obj:method(a, b)`, it desugars to `obj.method(obj, a, b)`. The
`__index` metamethod intercepts the `.method` lookup and returns a closure that,
when called, receives `obj` as the first argument.

In the JS method function, `self` is the **original JavaScript object** (not a
copy, not a Lua table). This means:

- Mutations to `self` are visible in JS immediately.
- `self` has its full JS prototype chain (you can call `self.method()` on it).
- `self` is the same object reference as the one passed to `set_userdata`.

```typescript
lua.set_userdata('timer', timer, {
  methods: {
    start: (self) => {
      self.startTime = Date.now();  // Mutates the real JS object
    },
    elapsed: (self) => Date.now() - self.startTime,
  }
});
```

### Multiple Userdata Sharing Methods

Each `set_userdata` call with `methods` gets its own method table. If you want
multiple userdata instances to share the same methods, define them once:

```typescript
const enemyMethods = {
  attack: (self, target) => { /* ... */ },
  take_damage: (self, amount) => { self.hp -= amount; },
  is_alive: (self) => self.hp > 0,
};

for (const enemy of enemies) {
  lua.set_userdata(`enemy_${enemy.id}`, enemy, {
    readable: true,
    methods: enemyMethods,
  });
}
```

---

## Type Definitions

```typescript
/**
 * A method function registered on userdata.
 * The first argument is always the JS object (`self`).
 * Remaining arguments come from the Lua call.
 */
export interface UserdataMethod {
  (self: any, ...args: LuaValue[]): LuaValue | LuaValue[] | void;
}

/**
 * Options for set_userdata controlling property access and methods from Lua
 */
export interface UserdataOptions {
  /** Allow Lua to read properties via __index */
  readable?: boolean;
  /** Allow Lua to write properties via __newindex */
  writable?: boolean;
  /** Methods callable from Lua via obj:method() syntax */
  methods?: Record<string, UserdataMethod>;
}
```

No changes to `LuaContext`'s `set_userdata` signature — the existing
`options?: UserdataOptions` parameter gains the `methods` field.

---

## Implementation Plan

### Overview

The current proxy userdata has a single metatable (`lua_native_proxy_userdata`)
shared by all proxy userdata instances. Its `__index` calls back to JS for
property access, and `__newindex` does the same for writes. Methods need to be
dispatched from within `__index`: when the key matches a registered method name,
return a callable Lua closure instead of delegating to the property getter.

The challenge is that the metatable is shared but methods are per-userdata
(different objects may have different methods). The solution is to store method
tables per ref_id and check them in the `__index` metamethod before falling
through to property access.

### Phase 1: N-API Layer — Store Method Functions

**File: `src/lua-native.h`**

Extend `UserdataEntry` to hold method references:

```cpp
struct UserdataEntry {
  Napi::ObjectReference object;
  bool readable;
  bool writable;
  std::unordered_map<std::string, Napi::FunctionReference> methods;
};
```

Each method is stored as a persistent JS function reference keyed by the method
name.

**File: `src/lua-native.cpp` — `SetUserdata`**

After reading `readable` and `writable` from options, also read `methods`:

```cpp
if (options.Has("methods") && options.Get("methods").IsObject()) {
  auto methodsObj = options.Get("methods").As<Napi::Object>();
  Napi::Array methodKeys = methodsObj.GetPropertyNames();
  for (uint32_t i = 0; i < methodKeys.Length(); i++) {
    std::string methodName = methodKeys[i].As<Napi::String>().Utf8Value();
    Napi::Value methodVal = methodsObj.Get(methodName);
    if (methodVal.IsFunction()) {
      entry.methods[methodName] =
        Napi::Persistent(methodVal.As<Napi::Function>());
    }
  }
}
```

When `methods` is non-empty, always use the proxy metatable (even if `readable`
and `writable` are both false — the `__index` metamethod is needed to intercept
method lookups):

```cpp
bool needs_proxy = readable || writable || !entry.methods.empty();
if (needs_proxy) {
  runtime->CreateProxyUserdataGlobal(name, ref_id);
} else {
  runtime->CreateUserdataGlobal(name, ref_id);
}
```

### Phase 2: N-API Layer — Method Dispatch Callback

Add a new callback type to `LuaRuntime` for method resolution:

**File: `src/core/lua-runtime.h`**

```cpp
// Returns true and populates method_fn if the key is a method.
// Returns false if the key is not a method (fall through to property access).
using MethodResolver = std::function<bool(int ref_id, const std::string& key)>;
```

However, the core layer cannot call JS functions directly (it has no `napi.h`).
The existing pattern is that the core layer calls a host function by name
through `LuaCallHostFunction`. Methods should follow the same pattern.

**Chosen approach: per-userdata method table stored in the Lua registry.**

Instead of calling back to JS from `__index` to check for methods, store each
userdata's method names in a Lua table in the registry. The `__index`
metamethod can look up this table directly in C (no JS round-trip for the
check), and if a match is found, push a closure that calls the corresponding
host function.

#### Data Flow

1. `SetUserdata` in the N-API layer registers each method as a host function
   with a unique name (e.g., `__ud_method_<ref_id>_<name>`).
2. A Lua table mapping method names to their host function names is stored in
   the registry under a key derived from the ref_id.
3. In `UserdataIndex`, before calling the property getter:
   - Get the ref_id from the userdata block.
   - Look up the method table in the registry.
   - If the key exists in the method table, push a closure that calls the host
     function with the userdata prepended as the first argument.
   - If not, fall through to property access.

### Phase 3: Core Layer — Method Table Storage

**File: `src/core/lua-runtime.h`**

Add a new method to `LuaRuntime`:

```cpp
/// Register a method table for a userdata ref_id.
/// method_map: maps method name -> host function name
void SetUserdataMethodTable(int ref_id,
    const std::unordered_map<std::string, std::string>& method_map);
```

**File: `src/core/lua-runtime.cpp`**

Implementation:

```cpp
void LuaRuntime::SetUserdataMethodTable(
    int ref_id,
    const std::unordered_map<std::string, std::string>& method_map) {
  StackGuard guard(L_);

  // Create a table: { method_name = "host_func_name", ... }
  lua_newtable(L_);
  for (const auto& [name, func_name] : method_map) {
    lua_pushstring(L_, func_name.c_str());
    lua_setfield(L_, -2, name.c_str());
  }

  // Store in registry: _ud_methods_<ref_id> = table
  std::string registry_key = "_ud_methods_" + std::to_string(ref_id);
  lua_setfield(L_, LUA_REGISTRYINDEX, registry_key.c_str());
}
```

### Phase 4: Core Layer — Modify `UserdataIndex`

**File: `src/core/lua-runtime.cpp`**

The current `UserdataIndex`:

```cpp
int LuaRuntime::UserdataIndex(lua_State* L) {
  auto* block = static_cast<int*>(lua_touserdata(L, 1));
  if (!block) return 0;

  const char* key = lua_tostring(L, 2);
  if (!key) return 0;

  lua_getfield(L, LUA_REGISTRYINDEX, "_lua_core_runtime");
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  if (runtime && runtime->property_getter_) {
    // ... property access
  }
  lua_pushnil(L);
  return 1;
}
```

Modified version — check methods before property access:

```cpp
int LuaRuntime::UserdataIndex(lua_State* L) {
  auto* block = static_cast<int*>(lua_touserdata(L, 1));
  if (!block) return 0;

  const char* key = lua_tostring(L, 2);
  if (!key) return 0;

  lua_getfield(L, LUA_REGISTRYINDEX, "_lua_core_runtime");
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  if (!runtime) {
    lua_pushnil(L);
    return 1;
  }

  // 1. Check for a registered method
  std::string registry_key = "_ud_methods_" + std::to_string(*block);
  lua_getfield(L, LUA_REGISTRYINDEX, registry_key.c_str());
  if (lua_istable(L, -1)) {
    lua_getfield(L, -1, key);
    if (lua_isstring(L, -1)) {
      // Found a method. The value is the host function name.
      // Push a closure that calls the host function with self prepended.
      const char* func_name = lua_tostring(L, -1);

      // Store the host function name and the userdata value for the closure
      lua_pushvalue(L, 1);              // upvalue 1: the userdata (self)
      lua_pushstring(L, func_name);     // upvalue 2: host function name
      lua_pushcclosure(L, UserdataMethodCall, 2);

      lua_remove(L, -2);  // remove func_name string
      lua_remove(L, -2);  // remove method table
      return 1;
    }
    lua_pop(L, 1);  // pop nil (key not found in method table)
  }
  lua_pop(L, 1);  // pop method table (or nil if no table)

  // 2. Fall through to property access
  if (runtime->property_getter_) {
    try {
      auto result = runtime->property_getter_(*block, key);
      PushLuaValue(L, result);
      return 1;
    } catch (const std::exception& e) {
      lua_pushfstring(L, "Error reading property '%s': %s", key, e.what());
      lua_error(L);
    }
  }

  lua_pushnil(L);
  return 1;
}
```

### Phase 5: Core Layer — `UserdataMethodCall` Static Function

**File: `src/core/lua-runtime.h`**

Add to the private section of `LuaRuntime`:

```cpp
static int UserdataMethodCall(lua_State* L);
```

**File: `src/core/lua-runtime.cpp`**

This closure is called when Lua invokes `obj:method(args)`. The Lua `:` syntax
means the stack looks like: `obj, arg1, arg2, ...` (Lua pushes `obj` as the
first argument automatically). But we need to forward this to the host function
as: `obj, arg1, arg2, ...`.

Since Lua already passes `obj` as the first argument when using `:` syntax, and
the host function registered for the method already expects `(self, ...args)` on
the JS side, we just need to call the host function with all the arguments as-is.

```cpp
int LuaRuntime::UserdataMethodCall(lua_State* L) {
  // upvalue 1: the userdata (self) — saved when __index created the closure
  // upvalue 2: host function name
  //
  // When called with obj:method(a, b), the stack has: obj, a, b
  // The obj on the stack IS the same userdata, so we can just forward
  // all arguments to the host function.

  const char* func_name = lua_tostring(L, lua_upvalueindex(2));

  lua_getfield(L, LUA_REGISTRYINDEX, "_lua_core_runtime");
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  if (!runtime) {
    lua_pushstring(L, "LuaRuntime not found in registry");
    lua_error(L);
    return 0;
  }

  const auto it = runtime->host_functions_.find(func_name ? func_name : "");
  if (it == runtime->host_functions_.end()) {
    lua_pushfstring(L, "Method '%s' not found", func_name ? func_name : "");
    lua_error(L);
    return 0;
  }

  if (runtime->async_mode_) {
    return luaL_error(L,
      "JS callbacks are not available in async mode (called method '%s')",
      func_name ? func_name : "<unknown>");
  }

  // Convert all arguments (including self at position 1)
  const int argc = lua_gettop(L);
  std::vector<LuaPtr> args;
  args.reserve(argc);
  try {
    for (int i = 1; i <= argc; ++i) {
      args.push_back(ToLuaValue(L, i));
    }
  } catch (const std::exception& e) {
    lua_pushfstring(L, "Error converting arguments for method '%s': %s",
                    func_name ? func_name : "<unknown>", e.what());
    lua_error(L);
    return 0;
  }

  // Call the host function
  LuaPtr resultHolder;
  try {
    resultHolder = it->second(args);
  } catch (const std::exception& e) {
    lua_pushfstring(L, "Method '%s' threw an exception: %s",
                    func_name ? func_name : "<unknown>", e.what());
    lua_error(L);
    return 0;
  } catch (...) {
    lua_pushfstring(L, "Method '%s' threw an unknown exception",
                    func_name ? func_name : "<unknown>");
    lua_error(L);
    return 0;
  }

  try {
    PushLuaValue(L, resultHolder);
  } catch (const std::exception& e) {
    lua_pushfstring(L, "Error converting return value from method '%s': %s",
                    func_name ? func_name : "<unknown>", e.what());
    lua_error(L);
    return 0;
  }
  return 1;
}
```

**Note on the self parameter:** When Lua calls `obj:method(a, b)`, it desugars
to `obj.method(obj, a, b)`. The `__index` metamethod is called for the
`.method` lookup and returns the `UserdataMethodCall` closure. Then Lua calls
that closure with `(obj, a, b)` on the stack. So the first argument (`argv[1]`)
is the userdata itself — which the N-API layer's JS wrapper converts back to
the original JS object.

This means the JS method function receives `(self, a, b)` where `self` is the
original JS object. No special handling is needed — the existing
`LuaUserdataRef` → JS object conversion in `CoreToNapi` handles it.

### Phase 6: N-API Layer — Wire It Up

**File: `src/lua-native.cpp` — `SetUserdata`**

After creating the `UserdataEntry` and calling `CreateProxyUserdataGlobal`:

```cpp
// Register methods if present
if (!entry.methods.empty()) {
  std::unordered_map<std::string, std::string> method_map;
  int method_id = next_method_id_++;

  for (auto& [name, funcRef] : entry.methods) {
    // Create a unique host function name
    std::string func_name = "__ud_method_" + std::to_string(ref_id)
                          + "_" + name;

    // Store the JS callback
    js_callbacks[func_name] = std::move(funcRef);

    // Register as a host function in the runtime
    runtime->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));

    method_map[name] = func_name;
  }

  // Store the method lookup table in the Lua registry
  runtime->SetUserdataMethodTable(ref_id, method_map);
}
```

Wait — there is a subtlety. The JS method functions expect `self` to be the
original JS object, but `UserdataMethodCall` converts argv[1] through the
standard `ToLuaValue` path, which produces a `LuaUserdataRef`. When the N-API
layer's `CreateJsCallbackWrapper` converts this back to JS via `CoreToNapi`, it
looks up `js_userdata_[ref_id]` and returns the original JS object.

So the `self` arrives as the original JS object in the JS callback. This
already works correctly — no special `self`-injection logic needed.

**File: `src/lua-native.h`**

No new members needed beyond what's already in `UserdataEntry`. But we should
move the method `FunctionReference`s into the entry before it's stored:

The methods are initially parsed into `entry.methods` as
`Napi::FunctionReference`s. Then when wiring up, we move them into
`js_callbacks` under unique names. The `entry.methods` map doesn't need to
persist after setup — but we might want to keep the method names around for
debugging or introspection. For simplicity, just use `js_callbacks`.

**Revised `UserdataEntry`:**

Actually, the method references don't need to live on `UserdataEntry` at all.
They can go directly into `js_callbacks` during `SetUserdata`. The entry only
needs to track `readable`, `writable`, and the object reference:

```cpp
struct UserdataEntry {
  Napi::ObjectReference object;
  bool readable;
  bool writable;
  // Methods are stored in js_callbacks under "__ud_method_<ref_id>_<name>"
};
```

This means `UserdataEntry` doesn't change. The methods are handled entirely
through the existing `js_callbacks` + `host_functions_` infrastructure.

### Phase 7: Cleanup on GC

When a userdata is garbage-collected, its method table in the Lua registry
should be cleaned up. Extend the GC callback:

**File: `src/core/lua-runtime.cpp` — `DecrementUserdataRefCount`**

When the ref count drops to zero and the GC callback fires, also remove the
method table from the registry:

```cpp
void LuaRuntime::DecrementUserdataRefCount(int ref_id) {
  auto it = userdata_ref_counts_.find(ref_id);
  if (it != userdata_ref_counts_.end()) {
    if (--it->second <= 0) {
      userdata_ref_counts_.erase(it);

      // Clean up method table if one exists
      std::string registry_key = "_ud_methods_" + std::to_string(ref_id);
      lua_pushnil(L_);
      lua_setfield(L_, LUA_REGISTRYINDEX, registry_key.c_str());

      if (userdata_gc_callback_) {
        userdata_gc_callback_(ref_id);
      }
    }
  }
}
```

The N-API layer's existing GC callback (`js_userdata_.erase(ref_id)`) will also
clean up the JS object reference. The host functions registered under
`__ud_method_<ref_id>_*` keys will remain in `host_functions_` and
`js_callbacks` — this is acceptable since they're keyed by ref_id and won't be
called again. For long-lived contexts, the context reset feature (future tier 2)
will clean these up.

---

## Implementation Checklist

### Core Layer (`src/core/lua-runtime.h` / `src/core/lua-runtime.cpp`)

- [ ] Add `SetUserdataMethodTable(int ref_id, const unordered_map<string, string>& method_map)` to `LuaRuntime`
- [ ] Add `static int UserdataMethodCall(lua_State* L)` to `LuaRuntime` (private)
- [ ] Modify `UserdataIndex` to check for methods before property access
- [ ] Modify `DecrementUserdataRefCount` to clean up the method registry entry
- [ ] Add C++ unit tests for the core layer

### N-API Layer (`src/lua-native.h` / `src/lua-native.cpp`)

- [ ] Extend `SetUserdata` to read `options.methods` object
- [ ] Register each method as a host function via `StoreHostFunction`
- [ ] Call `SetUserdataMethodTable` with the name → function name mapping
- [ ] Use proxy metatable when methods are present (even without readable/writable)

### Type Definitions (`types.d.ts`)

- [ ] Add `UserdataMethod` type
- [ ] Add `methods?: Record<string, UserdataMethod>` to `UserdataOptions`

### Tests (`tests/ts/lua-native.spec.ts`)

- [ ] Basic method call: register userdata with a method, call it from Lua with `:` syntax, verify it fires
- [ ] Self parameter: verify the method receives the original JS object as `self`
- [ ] Self mutation: modify `self` in a method, verify JS sees the change
- [ ] Method return values: verify methods can return values to Lua
- [ ] Multiple return values: verify methods can return arrays (multi-return)
- [ ] Methods + properties: verify methods and readable properties coexist on the same userdata
- [ ] Methods without properties: verify methods work when `readable`/`writable` are both false
- [ ] Method precedence: when a method name matches a property name, verify the method takes precedence
- [ ] Non-existent method: verify accessing a key that's neither a method nor a property returns nil (when readable) or nil (when not readable)
- [ ] Error in method: verify that throwing in a JS method produces a Lua error with descriptive message
- [ ] Multiple userdata with shared methods: verify two userdata instances with the same method definitions both work
- [ ] Async mode: verify calling a method during async execution returns an error

### C++ Tests (`tests/cpp/lua-native-test.cpp`)

- [ ] Register method table, verify `__index` dispatches to the method closure
- [ ] Verify method table cleanup on userdata GC
- [ ] Verify property fallback when key doesn't match a method
- [ ] Verify `UserdataMethodCall` error handling for missing host functions

---

## Design Decisions

### Why methods take precedence over properties

When a method name collides with a property name, the method wins. This matches
Lua convention — in standard Lua OOP, the method table is the `__index`, and
properties are stored directly on the object. Since our userdata doesn't have a
"real" Lua table backing it (properties live on the JS object), we check
methods first in `__index` and fall through to the JS property getter only if no
method matches.

This also avoids subtle bugs: if a JS object has a property named `close` that
holds a function, and the user also registers `close` as a method, the method
is the intended entry point — not the raw function object.

### Why not use a shared metatable with per-type methods

An alternative design would define "userdata types" with a metatable per type,
like sol2 and LuaBridge do. This is more memory-efficient when many instances
share the same methods, but it requires a `define_userdata_type()` API and
more complex lifecycle management.

The per-instance registry table approach is simpler, requires no new API
concepts, and works naturally with JavaScript's dynamic nature (different
objects can have different method sets without declaring types upfront). The
overhead of one small Lua table per userdata is negligible for typical use
cases.

If performance profiling shows the per-instance table lookup is a bottleneck
(unlikely — it's a single registry lookup + table field access), a shared
metatable approach can be added later as an optimization without changing the
public API.

### Why methods are dispatched through host functions

Methods reuse the existing `host_functions_` infrastructure rather than
introducing a new callback path. This means:

- Method closures go through `UserdataMethodCall`, which is nearly identical to
  `LuaCallHostFunction` (argument conversion, error handling, return value
  conversion).
- The N-API layer registers methods the same way it registers any callback:
  `StoreHostFunction` + `CreateJsCallbackWrapper`.
- No new callback types or dispatch mechanisms are needed.

The only new code path is in `__index`, which checks the method table before
falling through to properties.

### Why the upvalue stores the userdata

The closure returned by `__index` captures the userdata as upvalue 1. This is
technically redundant — when Lua calls `obj:method(a, b)`, `obj` is already
passed as the first argument. However, the upvalue ensures correctness even if
the method is called with `.` syntax and the wrong first argument:

```lua
local fn = obj.method  -- get the closure
fn(42)                 -- 42 is not a userdata!
```

In this case, `argv[1]` is `42`, not `obj`. With the upvalue, we could detect
this. For the initial implementation, we don't special-case this — the method
will receive `42` as `self` and likely fail at the JS level. This matches how
Lua's standard `:` convention works (there's no built-in protection against
wrong-self calls).

---

## Edge Cases

### Method called with `.` instead of `:`

```lua
-- User forgets the colon
obj.method(arg1, arg2)
```

This calls the method without passing `obj` as the first argument. The JS
function receives `arg1` as `self` instead of the JS object. This will likely
cause a runtime error in the JS method (e.g., "Cannot read property 'x' of
number"). This is standard Lua behavior — the same thing happens with any
Lua OOP pattern.

### Accessing a method by name for storage

```lua
local m = obj.method  -- returns the closure
m(obj, 42)            -- works: obj is passed explicitly
```

The closure is a regular Lua function that can be stored and called later.

### Userdata passed to another userdata's method

```lua
enemy:take_damage_from(player)
```

Here `player` is a different userdata. It arrives in the JS method as the
original JS object — the standard `LuaUserdataRef` → JS conversion handles it.

### nil methods table

If `methods` is omitted or empty, behavior is identical to today. No method
table is created in the registry. `__index` falls straight through to property
access.
