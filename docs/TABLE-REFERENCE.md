# Table Reference API

Provide a way to create, read, write, and iterate Lua tables from JavaScript
without round-tripping through `execute_script`. This is the single most
universal Lua bridge feature — every surveyed library (7 of 7) provides some
form of host-language table manipulation.

Currently, plain Lua tables are deep-copied when they cross the JS boundary.
Metatabled tables get live references (Proxy objects), but there is no way to:

- Create a new Lua table from JS
- Get a live reference to a plain (non-metatabled) global table
- Iterate a table's key-value pairs from JS
- Manipulate a table in Lua without `execute_script`

---

## Motivation

### The Problem

Without a table reference API, all table manipulation must go through script
execution:

```typescript
const lua = new lua_native.init({}, { libraries: 'all' });

// Creating a table
lua.execute_script('config = {}');

// Setting fields
lua.execute_script("config.host = 'localhost'");
lua.execute_script('config.port = 5432');
lua.execute_script("config.tags = {'primary', 'fast'}");

// Reading fields
const host = lua.execute_script<string>('return config.host');
const port = lua.execute_script<number>('return config.port');

// Iterating — no direct way, must return a copy
const config = lua.execute_script<LuaTable>('return config');
for (const [k, v] of Object.entries(config)) {
  console.log(k, v);
}
// But `config` is a copy — mutations don't affect the Lua table
```

Problems with this approach:

1. **Parsing overhead.** Every `execute_script` call compiles Lua source. For
   hot paths, this is wasteful.
2. **No live references.** `get_global` for a plain table returns a deep copy.
   Mutations to the copy don't affect the Lua state.
3. **String interpolation risks.** Building Lua code strings to set values
   invites injection bugs: `execute_script(\`config.name = '${userInput}'\`)`.
4. **Verbose.** Simple operations require multiple script calls.

### The Solution

With the table reference API:

```typescript
const lua = new lua_native.init({}, { libraries: 'all' });

// Create a table directly
const config = lua.create_table();
config.set('host', 'localhost');
config.set('port', 5432);
config.set('tags', [1, 2, 3]);

// Push to Lua as a global
lua.set_global('config', config);

// Read back a live reference to an existing global
const ref = lua.get_global_ref('config');
ref.get('host');    // 'localhost'
ref.get('port');    // 5432
ref.length();       // 0 (hash part doesn't count for #)

// Iterate
for (const [k, v] of ref.pairs()) {
  console.log(k, v);
}

// Mutate from JS — Lua sees the change
ref.set('debug', true);
lua.execute_script('print(config.debug)');  // true

// Release when done
ref.release();
config.release();
```

---

## Current State

### What Already Exists

The codebase already has significant table reference infrastructure built for
metatabled tables:

**Core layer** (`src/core/lua-runtime.h`, `src/core/lua-runtime.cpp`):

- `LuaTableRef` struct — holds a registry ref (`int ref`) and `lua_State*`
  pointer with move semantics and `release()` method
- `GetTableField(int ref, const std::string& key)` — retrieves a field,
  supports integer key detection, triggers `__index` metamethods
- `SetTableField(int ref, const std::string& key, const LuaPtr& value)` —
  sets a field, triggers `__newindex` metamethods
- `HasTableField(int ref, const std::string& key)` — checks key existence
- `GetTableKeys(int ref)` — iterates via `lua_next()`, returns
  `vector<string>`
- `GetTableLength(int ref)` — returns `luaL_len()` result

**Binding layer** (`src/lua-native.h`, `src/lua-native.cpp`):

- `LuaTableRefData` struct — pairs a `LuaTableRef` with a
  `shared_ptr<LuaRuntime>` and `LuaContext*` for correct destruction order
- Five JS Proxy trap functions (`TableRefGetTrap`, `TableRefSetTrap`,
  `TableRefHasTrap`, `TableRefOwnKeysTrap`,
  `TableRefGetOwnPropertyDescriptorTrap`)
- `CoreToNapi` creates Proxy objects for `LuaTableRef` values with
  `_tableRef` marker for round-trip detection
- `NapiToCoreInstance` detects `_tableRef` marker to restore the original
  registry reference

**Decision**: Metatabled tables automatically become live references (Proxies).
Plain tables are deep-copied. The table reference API extends this to give
explicit control — users can request live references to any table.

### What's Missing

| Capability                    | Status                                |
|-------------------------------|---------------------------------------|
| Create empty table from JS    | Not available                         |
| Get live ref to plain table   | Not available (deep-copies instead)   |
| Explicit `get`/`set` methods  | Only via Proxy traps on metatabled tables |
| `pairs()` iteration from JS   | Not available                         |
| `ipairs()` iteration from JS  | Not available                         |
| Explicit `release()`          | Not available (GC-driven cleanup)     |
| Set table ref as global       | Partially — Proxy objects round-trip  |

---

## API Design

### `LuaTableHandle` Interface

The primary new type. Wraps a Lua registry reference to a table and provides
methods for direct manipulation.

```typescript
interface LuaTableHandle {
  /**
   * Get a field from the table.
   * Triggers __index metamethod if the table has a metatable.
   */
  get(key: string | number): LuaValue;

  /**
   * Set a field on the table.
   * Triggers __newindex metamethod if the table has a metatable.
   */
  set(key: string | number, value: LuaValue): void;

  /**
   * Check if a key exists in the table.
   */
  has(key: string | number): boolean;

  /**
   * Get the length of the table (equivalent to # in Lua).
   * Returns the length of the sequence part.
   * Triggers __len metamethod if the table has a metatable.
   */
  length(): number;

  /**
   * Iterate all key-value pairs (equivalent to pairs() in Lua).
   * Returns an iterable of [key, value] tuples.
   * Keys can be strings or numbers.
   */
  pairs(): IterableIterator<[string | number, LuaValue]>;

  /**
   * Iterate the integer-keyed sequence part (equivalent to ipairs() in Lua).
   * Iterates from 1 to the first nil value.
   * Returns an iterable of [index, value] tuples.
   */
  ipairs(): IterableIterator<[number, LuaValue]>;

  /**
   * Explicitly release the Lua registry reference.
   * After calling release(), all other methods throw.
   * If not called, the reference is released when the handle is GC'd,
   * but explicit release is strongly recommended.
   */
  release(): void;
}
```

### New Methods on `LuaContext`

```typescript
interface LuaContext {
  // ... existing methods ...

  /**
   * Create a new empty Lua table and return a handle to it.
   * The table lives in the Lua registry until released.
   */
  create_table(): LuaTableHandle;

  /**
   * Create a new Lua table pre-populated with values from a JS object/array.
   * Equivalent to create_table() + set() for each entry.
   */
  create_table(initial: LuaTable | LuaValue[]): LuaTableHandle;

  /**
   * Get a live reference to a global variable's value.
   * Unlike get_global() which deep-copies plain tables, this returns a
   * handle that reads/writes the actual Lua table in place.
   * Throws if the global is not a table.
   */
  get_global_ref(name: string): LuaTableHandle;
}
```

### Usage Examples

#### Creating and Populating a Table

```typescript
const lua = new lua_native.init({}, { libraries: 'all' });

const inventory = lua.create_table();
inventory.set('sword', 1);
inventory.set('shield', 1);
inventory.set('potion', 5);

lua.set_global('inventory', inventory);

lua.execute_script(`
  print(inventory.sword)   -- 1
  print(inventory.potion)  -- 5
  inventory.potion = inventory.potion - 1
`);

console.log(inventory.get('potion'));  // 4 — live reference
inventory.release();
```

#### Creating an Array-Like Table

```typescript
const scores = lua.create_table([95, 87, 92, 78]);

lua.set_global('scores', scores);
lua.execute_script(`
  for i, score in ipairs(scores) do
    print(i, score)
  end
  -- 1  95
  -- 2  87
  -- 3  92
  -- 4  78
`);

console.log(scores.length());  // 4

// Iterate from JS
for (const [i, score] of scores.ipairs()) {
  console.log(i, score);  // 1 95, 2 87, etc.
}
scores.release();
```

#### Getting a Live Reference to an Existing Table

```typescript
lua.execute_script(`
  config = {
    host = 'localhost',
    port = 5432,
    options = { timeout = 30, retries = 3 }
  }
`);

const config = lua.get_global_ref('config');
console.log(config.get('host'));  // 'localhost'
console.log(config.get('port'));  // 5432

// Nested table is returned as a deep copy (unless it has a metatable)
const options = config.get('options') as LuaTable;
console.log(options.timeout);  // 30

// Modify from JS — Lua sees it
config.set('host', '10.0.0.1');
lua.execute_script('print(config.host)');  // 10.0.0.1

config.release();
```

#### Iterating with `pairs()`

```typescript
lua.execute_script(`
  stats = { hp = 100, mp = 50, str = 15, dex = 12 }
`);

const stats = lua.get_global_ref('stats');
for (const [key, value] of stats.pairs()) {
  console.log(`${key} = ${value}`);
}
// hp = 100
// mp = 50
// str = 15
// dex = 12

stats.release();
```

#### Passing Table Handles Between Functions

```typescript
// A table handle can be passed as an argument to set_global
const enemies = lua.create_table();
lua.set_global('enemies', enemies);

// A table handle can be passed as a value to another table handle
const goblin = lua.create_table({ name: 'Goblin', hp: 30 });
enemies.set(1, goblin);  // enemies[1] = goblin

lua.execute_script('print(enemies[1].name)');  // Goblin

goblin.release();
enemies.release();
```

---

## Implementation Plan

### Phase 1: Core Layer — New Table Operations

**File: `src/core/lua-runtime.h`**

Add new methods to `LuaRuntime`:

```cpp
/// Create an empty table, store in registry, return ref ID.
int CreateTable();

/// Create a table from initial values, store in registry, return ref ID.
int CreateTableFrom(const LuaTable& initial);
int CreateTableFrom(const LuaArray& initial);

/// Get a global's value as a registry reference. Returns the ref ID.
/// Throws/returns error if the global is not a table.
std::variant<int, std::string> GetGlobalRef(const std::string& name);

/// Get all key-value pairs from a table ref.
/// Returns vector of (key, value) where keys can be strings or numbers.
std::vector<std::pair<LuaPtr, LuaPtr>> TablePairs(int ref);

/// Get the integer-keyed sequence entries from a table ref.
/// Iterates from index 1 until the first nil.
std::vector<std::pair<int64_t, LuaPtr>> TableIPairs(int ref);

/// Release a registry reference explicitly.
void ReleaseTableRef(int ref);
```

**File: `src/core/lua-runtime.cpp`**

#### `CreateTable()`

```cpp
int LuaRuntime::CreateTable() {
  StackGuard guard(L_);
  lua_newtable(L_);
  return luaL_ref(L_, LUA_REGISTRYINDEX);
}
```

#### `CreateTableFrom(const LuaTable& initial)`

```cpp
int LuaRuntime::CreateTableFrom(const LuaTable& initial) {
  StackGuard guard(L_);
  lua_newtable(L_);
  for (const auto& [key, value] : initial) {
    PushLuaValue(L_, value);
    lua_setfield(L_, -2, key.c_str());
  }
  return luaL_ref(L_, LUA_REGISTRYINDEX);
}
```

#### `CreateTableFrom(const LuaArray& initial)`

```cpp
int LuaRuntime::CreateTableFrom(const LuaArray& initial) {
  StackGuard guard(L_);
  lua_createtable(L_, static_cast<int>(initial.size()), 0);
  for (size_t i = 0; i < initial.size(); ++i) {
    PushLuaValue(L_, initial[i]);
    lua_seti(L_, -2, static_cast<lua_Integer>(i + 1));  // Lua 1-indexed
  }
  return luaL_ref(L_, LUA_REGISTRYINDEX);
}
```

#### `GetGlobalRef()`

```cpp
std::variant<int, std::string> LuaRuntime::GetGlobalRef(const std::string& name) {
  StackGuard guard(L_);
  lua_getglobal(L_, name.c_str());
  if (!lua_istable(L_, -1)) {
    std::string type_name = lua_typename(L_, lua_type(L_, -1));
    lua_pop(L_, 1);
    return "global '" + name + "' is not a table (got " + type_name + ")";
  }
  // Store in registry (pops the value)
  return luaL_ref(L_, LUA_REGISTRYINDEX);
}
```

Note: `luaL_ref` pops the value from the stack, so the StackGuard should
account for this. The implementation may need to push a copy before calling
`luaL_ref`, or the StackGuard should be adjusted accordingly. Review the
existing `StackGuard` behavior to ensure correctness.

#### `TablePairs()`

```cpp
std::vector<std::pair<LuaPtr, LuaPtr>> LuaRuntime::TablePairs(int ref) {
  StackGuard guard(L_);
  std::vector<std::pair<LuaPtr, LuaPtr>> result;

  lua_rawgeti(L_, LUA_REGISTRYINDEX, ref);
  if (!lua_istable(L_, -1)) {
    lua_pop(L_, 1);
    return result;
  }

  lua_pushnil(L_);  // first key
  while (lua_next(L_, -2) != 0) {
    // key at -2, value at -1
    LuaPtr key = ToLuaValue(L_, lua_absindex(L_, -2));
    LuaPtr value = ToLuaValue(L_, lua_absindex(L_, -1));
    result.emplace_back(std::move(key), std::move(value));
    lua_pop(L_, 1);  // pop value, keep key for next iteration
  }
  lua_pop(L_, 1);  // pop table

  return result;
}
```

Note: `ToLuaValue` on the key must not pop or consume it — it should read the
value at the given stack index without modifying the stack. The existing
`ToLuaValue` implementation already does this (it uses `lua_absindex` and
doesn't pop). However, `lua_next` requires the key to remain on the stack
unmodified, so ensure `ToLuaValue` doesn't push to the registry for key values
that happen to be tables/functions (unlikely for typical table keys, but worth
verifying).

#### `TableIPairs()`

```cpp
std::vector<std::pair<int64_t, LuaPtr>> LuaRuntime::TableIPairs(int ref) {
  StackGuard guard(L_);
  std::vector<std::pair<int64_t, LuaPtr>> result;

  lua_rawgeti(L_, LUA_REGISTRYINDEX, ref);
  if (!lua_istable(L_, -1)) {
    lua_pop(L_, 1);
    return result;
  }

  for (int64_t i = 1; ; ++i) {
    lua_geti(L_, -1, static_cast<lua_Integer>(i));
    if (lua_isnil(L_, -1)) {
      lua_pop(L_, 1);
      break;
    }
    result.emplace_back(i, ToLuaValue(L_, lua_absindex(L_, -1)));
    lua_pop(L_, 1);
  }
  lua_pop(L_, 1);  // pop table

  return result;
}
```

#### `ReleaseTableRef()`

```cpp
void LuaRuntime::ReleaseTableRef(int ref) {
  if (ref != LUA_NOREF && ref != LUA_REFNIL) {
    luaL_unref(L_, LUA_REGISTRYINDEX, ref);
  }
}
```

### Phase 2: Binding Layer — `LuaTableHandle` as N-API ObjectWrap

There are two design options for exposing `LuaTableHandle` to JavaScript:

**Option A: Plain JS object with closures.** Create a plain `Napi::Object` with
`get`, `set`, `has`, `length`, `pairs`, `ipairs`, `release` as function
properties. Each closure captures a `LuaTableRefData*`.

**Option B: N-API `ObjectWrap`.** Define a `LuaTableHandle` class extending
`Napi::ObjectWrap<LuaTableHandle>` with instance methods.

**Chosen approach: Option A (plain object with closures).** This is simpler,
avoids registering a new class constructor in the module exports, and matches
the lightweight pattern used for coroutine objects. The handle is a plain JS
object with method functions attached — no prototype chain complexity.

**File: `src/lua-native.h`**

No new class needed. Reuse `LuaTableRefData` (already exists). Add a helper
to create handle objects:

```cpp
// In LuaContext (private):
Napi::Object CreateTableHandle(Napi::Env env, int registry_ref);
```

**File: `src/lua-native.cpp`**

#### `CreateTableHandle()`

Creates a JS object with `get`, `set`, `has`, `length`, `pairs`, `ipairs`,
and `release` methods. Stores the `LuaTableRefData` as an external so all
closures share the same data.

```cpp
Napi::Object LuaContext::CreateTableHandle(Napi::Env env, int registry_ref) {
  auto data = std::make_unique<LuaTableRefData>(
    runtime_, lua_core::LuaTableRef(registry_ref, runtime_->GetState()),
    this
  );
  auto* dataPtr = data.get();
  lua_table_ref_data_.push_back(std::move(data));

  Napi::Object handle = Napi::Object::New(env);

  // Store the external for round-trip detection (same pattern as Proxy)
  auto external = Napi::External<LuaTableRefData>::New(env, dataPtr);

  // Non-enumerable _tableRef marker for set_global round-trip
  auto Object = env.Global().Get("Object").As<Napi::Object>();
  auto defineProperty = Object.Get("defineProperty").As<Napi::Function>();
  Napi::Object descriptor = Napi::Object::New(env);
  descriptor.Set("value", external);
  descriptor.Set("enumerable", Napi::Boolean::New(env, false));
  descriptor.Set("configurable", Napi::Boolean::New(env, true));
  defineProperty.Call({handle, Napi::String::New(env, "_tableRef"), descriptor});

  // Attach methods as properties
  handle.Set("get", Napi::Function::New(env, TableHandleGet, "get", dataPtr));
  handle.Set("set", Napi::Function::New(env, TableHandleSet, "set", dataPtr));
  handle.Set("has", Napi::Function::New(env, TableHandleHas, "has", dataPtr));
  handle.Set("length", Napi::Function::New(env, TableHandleLength, "length", dataPtr));
  handle.Set("pairs", Napi::Function::New(env, TableHandlePairs, "pairs", dataPtr));
  handle.Set("ipairs", Napi::Function::New(env, TableHandleIPairs, "ipairs", dataPtr));
  handle.Set("release", Napi::Function::New(env, TableHandleRelease, "release", dataPtr));

  return handle;
}
```

#### `set_global` Integration

When `set_global` receives a `LuaTableHandle` (detected by the `_tableRef`
marker), it should push the referenced table rather than deep-copying. This
already works via the existing `NapiToCoreInstance` logic that detects
`_tableRef` and reconstructs the `LuaTableRef`.

Verify: the existing `NapiToCoreInstance` path for `_tableRef` constructs a
`LuaTableRef` with the same registry ref. When `SetGlobal` processes this, it
calls `PushLuaValue` which does `lua_rawgeti(L, LUA_REGISTRYINDEX, ref)` to
push the actual table. Then `lua_setglobal` assigns it. This means the global
points to the same table — modifications from either side are visible. This
already works.

#### Handle Method Implementations

Each method is a static `Napi::Value(*)(const Napi::CallbackInfo&)` function
that extracts the `LuaTableRefData*` from the callback's `Data()` pointer.

**Released check:** Every method should check if the handle has been released
(ref set to `LUA_NOREF`) and throw if so.

```cpp
static Napi::Value TableHandleGet(const Napi::CallbackInfo& info) {
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (data->tableRef.ref == LUA_NOREF) {
    throw Napi::Error::New(info.Env(), "table handle has been released");
  }

  if (info.Length() < 1) {
    throw Napi::TypeError::New(info.Env(), "get() requires a key argument");
  }

  std::string key;
  if (info[0].IsNumber()) {
    key = std::to_string(info[0].As<Napi::Number>().Int64Value());
  } else {
    key = info[0].As<Napi::String>().Utf8Value();
  }

  auto result = data->runtime->GetTableField(data->tableRef.ref, key);
  return data->context->CoreToNapi(info.Env(), result);
}
```

```cpp
static Napi::Value TableHandleSet(const Napi::CallbackInfo& info) {
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (data->tableRef.ref == LUA_NOREF) {
    throw Napi::Error::New(info.Env(), "table handle has been released");
  }

  if (info.Length() < 2) {
    throw Napi::TypeError::New(info.Env(), "set() requires key and value arguments");
  }

  std::string key;
  if (info[0].IsNumber()) {
    key = std::to_string(info[0].As<Napi::Number>().Int64Value());
  } else {
    key = info[0].As<Napi::String>().Utf8Value();
  }

  auto value = data->context->NapiToCoreInstance(info[1]);
  data->runtime->SetTableField(data->tableRef.ref, key, value);
  return info.Env().Undefined();
}
```

```cpp
static Napi::Value TableHandleHas(const Napi::CallbackInfo& info) {
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (data->tableRef.ref == LUA_NOREF) {
    throw Napi::Error::New(info.Env(), "table handle has been released");
  }

  std::string key;
  if (info[0].IsNumber()) {
    key = std::to_string(info[0].As<Napi::Number>().Int64Value());
  } else {
    key = info[0].As<Napi::String>().Utf8Value();
  }

  bool exists = data->runtime->HasTableField(data->tableRef.ref, key);
  return Napi::Boolean::New(info.Env(), exists);
}
```

```cpp
static Napi::Value TableHandleLength(const Napi::CallbackInfo& info) {
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (data->tableRef.ref == LUA_NOREF) {
    throw Napi::Error::New(info.Env(), "table handle has been released");
  }

  int len = data->runtime->GetTableLength(data->tableRef.ref);
  return Napi::Number::New(info.Env(), len);
}
```

```cpp
static Napi::Value TableHandlePairs(const Napi::CallbackInfo& info) {
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (data->tableRef.ref == LUA_NOREF) {
    throw Napi::Error::New(info.Env(), "table handle has been released");
  }

  auto pairs = data->runtime->TablePairs(data->tableRef.ref);
  Napi::Env env = info.Env();

  // Return an array of [key, value] arrays
  // The caller wraps this in an iterator (see JS shim below)
  Napi::Array result = Napi::Array::New(env, pairs.size());
  for (size_t i = 0; i < pairs.size(); ++i) {
    Napi::Array entry = Napi::Array::New(env, 2);
    entry.Set(static_cast<uint32_t>(0),
              data->context->CoreToNapi(env, pairs[i].first));
    entry.Set(static_cast<uint32_t>(1),
              data->context->CoreToNapi(env, pairs[i].second));
    result.Set(static_cast<uint32_t>(i), entry);
  }

  return result;
}
```

**Iterator pattern decision:** The native layer returns an array of
`[key, value]` tuples. The TypeScript type declaration marks `pairs()` and
`ipairs()` as returning `IterableIterator`. To bridge this, two options:

1. **JS shim in `index.js`**: Wrap the returned array in a generator function.
2. **Native iterator**: Return an object with `next()` and `Symbol.iterator`.

**Chosen approach: return plain array.** The type declaration can type
`pairs()` as returning `Array<[string | number, LuaValue]>` instead of
`IterableIterator`. Arrays are already iterable via `for...of` in JS. This
avoids generator complexity in the native layer. If users want a lazy iterator
(for very large tables), it can be added later as `pairs_lazy()`.

Revised type for `pairs()` and `ipairs()`:

```typescript
pairs(): Array<[string | number, LuaValue]>;
ipairs(): Array<[number, LuaValue]>;
```

The `ipairs()` native implementation:

```cpp
static Napi::Value TableHandleIPairs(const Napi::CallbackInfo& info) {
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (data->tableRef.ref == LUA_NOREF) {
    throw Napi::Error::New(info.Env(), "table handle has been released");
  }

  auto ipairs = data->runtime->TableIPairs(data->tableRef.ref);
  Napi::Env env = info.Env();

  Napi::Array result = Napi::Array::New(env, ipairs.size());
  for (size_t i = 0; i < ipairs.size(); ++i) {
    Napi::Array entry = Napi::Array::New(env, 2);
    entry.Set(static_cast<uint32_t>(0),
              Napi::Number::New(env, static_cast<double>(ipairs[i].first)));
    entry.Set(static_cast<uint32_t>(1),
              data->context->CoreToNapi(env, ipairs[i].second));
    result.Set(static_cast<uint32_t>(i), entry);
  }

  return result;
}
```

#### `TableHandleRelease()`

```cpp
static Napi::Value TableHandleRelease(const Napi::CallbackInfo& info) {
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (data->tableRef.ref == LUA_NOREF) {
    // Already released — no-op (not an error)
    return info.Env().Undefined();
  }

  data->runtime->ReleaseTableRef(data->tableRef.ref);
  data->tableRef.ref = LUA_NOREF;
  return info.Env().Undefined();
}
```

### Phase 3: Wire Up New `LuaContext` Methods

**File: `src/lua-native.cpp`**

#### `CreateTable()`

```cpp
Napi::Value LuaContext::CreateTable(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() > 0 && !info[0].IsUndefined()) {
    // Initial values provided
    if (info[0].IsArray()) {
      // Array initializer
      auto arr = info[0].As<Napi::Array>();
      lua_core::LuaArray luaArr;
      for (uint32_t i = 0; i < arr.Length(); ++i) {
        luaArr.push_back(NapiToCoreInstance(arr.Get(i)));
      }
      int ref = runtime_->CreateTableFrom(luaArr);
      return CreateTableHandle(env, ref);
    } else if (info[0].IsObject()) {
      // Object initializer
      auto obj = info[0].As<Napi::Object>();
      lua_core::LuaTable luaTbl;
      auto keys = obj.GetPropertyNames();
      for (uint32_t i = 0; i < keys.Length(); ++i) {
        std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
        luaTbl[key] = NapiToCoreInstance(obj.Get(key));
      }
      int ref = runtime_->CreateTableFrom(luaTbl);
      return CreateTableHandle(env, ref);
    }
  }

  int ref = runtime_->CreateTable();
  return CreateTableHandle(env, ref);
}
```

#### `GetGlobalRef()`

```cpp
Napi::Value LuaContext::GetGlobalRef(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    throw Napi::TypeError::New(env, "get_global_ref() requires a string name");
  }

  std::string name = info[0].As<Napi::String>().Utf8Value();
  auto result = runtime_->GetGlobalRef(name);

  if (auto* error = std::get_if<std::string>(&result)) {
    throw Napi::Error::New(env, *error);
  }

  int ref = std::get<int>(result);
  return CreateTableHandle(env, ref);
}
```

#### Register Instance Methods

In the `LuaContext` class constructor registration:

```cpp
InstanceMethod("create_table", &LuaContext::CreateTable),
InstanceMethod("get_global_ref", &LuaContext::GetGlobalRef),
```

**File: `src/lua-native.h`**

Add method declarations to `LuaContext`:

```cpp
Napi::Value CreateTable(const Napi::CallbackInfo& info);
Napi::Value GetGlobalRef(const Napi::CallbackInfo& info);
```

### Phase 4: Type Definitions

**File: `types.d.ts`**

Add the `LuaTableHandle` interface and new `LuaContext` methods:

```typescript
/**
 * A handle to a Lua table stored in the Lua registry.
 * Provides direct get/set/iterate access without execute_script.
 *
 * The handle holds a live reference — mutations from JS are visible
 * in Lua and vice versa. Call release() when done to free the
 * registry slot.
 */
export interface LuaTableHandle {
  /** Get a field. Triggers __index if the table has a metatable. */
  get(key: string | number): LuaValue;

  /** Set a field. Triggers __newindex if the table has a metatable. */
  set(key: string | number, value: LuaValue): void;

  /** Check if a key exists. */
  has(key: string | number): boolean;

  /** Get the table length (# operator). Triggers __len metamethod. */
  length(): number;

  /** Get all key-value pairs (like Lua pairs()). */
  pairs(): Array<[string | number, LuaValue]>;

  /** Get integer-keyed sequence (like Lua ipairs()). */
  ipairs(): Array<[number, LuaValue]>;

  /** Release the registry reference. Methods throw after release. */
  release(): void;
}
```

Add to `LuaContext`:

```typescript
/**
 * Create a new Lua table, optionally pre-populated with values.
 * Returns a handle for direct manipulation.
 */
create_table(initial?: LuaTable | LuaValue[]): LuaTableHandle;

/**
 * Get a live reference to a global table.
 * Unlike get_global(), this does not deep-copy — changes are live.
 * @throws If the global is not a table
 */
get_global_ref(name: string): LuaTableHandle;
```

Add `LuaTableHandle` to the `LuaValue` union so handles can be stored in
tables and passed to Lua:

```typescript
export type LuaValue =
  | null
  | boolean
  | number
  | string
  | LuaValue[]
  | LuaTable
  | LuaTableRef
  | LuaTableHandle
  | LuaFunction;
```

---

## Design Decisions

### Why plain objects, not `ObjectWrap`

Using `Napi::ObjectWrap` for `LuaTableHandle` would give us destructor-based
cleanup (release the registry ref when the JS object is GC'd). However:

1. `ObjectWrap` requires registering a constructor in the module exports,
   adding API surface.
2. Coroutine handles already use the "plain object with methods" pattern.
3. The `LuaTableRefData` destructor (stored in `lua_table_ref_data_`) already
   handles cleanup when the `LuaContext` is destroyed.
4. Users should call `release()` explicitly for deterministic cleanup — relying
   on GC for registry refs is a footgun in long-lived contexts.

If the Reference Lifecycle Management feature (tier 3 in FUTURE.md) is
implemented later, it can provide a unified `release()` mechanism for all
reference types.

### Why `pairs()` returns an array, not an iterator

Lua tables are typically small. Returning a materialized array of `[k, v]`
tuples is simpler than implementing a native JS iterator protocol (which would
require a stateful C++ object that holds a Lua stack position across multiple
`next()` calls — fragile if the user interleaves other Lua operations between
iterations).

JS arrays are iterable, so `for (const [k, v] of handle.pairs())` works. For
very large tables, a lazy `pairs_iter()` can be added later.

### Why `get_global_ref` only works for tables

Returning a live reference to a non-table global (like a number or string)
doesn't make sense — primitives are immutable in both JS and Lua. Functions
already have live references via `LuaFunction`. The only case where a "get
reference instead of copy" distinction matters is for tables.

If users need a reference to a global that might be a function, they can use
`execute_script<LuaFunction>('return globalName')`.

### Why `_tableRef` marker is reused

Table handles use the same `_tableRef` non-enumerable marker as Proxy-based
metatabled table references. This means:

- Passing a handle to `set_global` works automatically (the existing
  `NapiToCoreInstance` detects `_tableRef` and pushes the registry ref).
- Passing a handle as a value in `table.set(key, handle)` works — the table
  field points to the same Lua table, not a copy.
- The handle and any Proxy reference to the same underlying table share the
  same registry ref.

### Relationship to existing metatabled table Proxies

The existing Proxy-based references (for metatabled tables) and the new
`LuaTableHandle` are complementary:

| Aspect                | Proxy (metatabled)          | Handle (explicit)          |
|-----------------------|-----------------------------|----------------------------|
| Created by            | Automatic on return         | `create_table()` / `get_global_ref()` |
| Access pattern        | `proxy.key` / `proxy.key =` | `handle.get(key)` / `handle.set(key, v)` |
| Iteration             | `Object.keys(proxy)`        | `handle.pairs()` / `handle.ipairs()` |
| Works on plain tables | No (deep-copied)            | Yes                        |
| Metamethod support    | Yes (via traps)             | Yes (methods delegate to Lua C API) |
| Explicit release      | No                          | `handle.release()`         |

Users who want transparent JS object syntax should continue using metatabled
tables with Proxies. Users who need explicit control or work with plain tables
should use handles.

---

## Edge Cases

### Released handle

```typescript
const t = lua.create_table();
t.release();
t.get('x');  // throws: "table handle has been released"
t.release(); // no-op (safe to call twice)
```

### Handle outlives `LuaContext`

The `LuaTableRefData` destructor calls `luaL_unref` via `tableRef.release()`.
When the `LuaContext` is destroyed, its `lua_table_ref_data_` vector is
cleared, which destroys all `LuaTableRefData` entries and releases their
registry refs. Any dangling JS handle objects will have their `data` pointer
invalidated — calling methods on them after context destruction is undefined
behavior.

This is the same behavior as existing Proxy-based table references and function
references. The Reference Lifecycle Management feature (future) would add
proper invalidation tracking.

### Concurrent modification

If Lua modifies a table while JS is iterating via `pairs()`, this is safe
because `pairs()` materializes all entries into an array before returning.
The iteration happens entirely within the `TablePairs` C++ call (under the
Lua stack's control), and the result is a snapshot.

However, if JS modifies a table between calls to `get()` and `set()`, the
usual race conditions apply. Since Lua and N-API calls are synchronous on the
main thread, this is not a concurrency issue — it's the expected sequential
behavior.

### Nested tables

When `handle.get('nested_key')` returns a table value:

- If the nested table has a metatable → returns a Proxy (existing behavior)
- If the nested table is plain → returns a deep copy (existing behavior)

To get a live reference to a nested plain table, use:

```typescript
// Option 1: Get it via Lua
const nested = lua.get_global_ref('parent.child');
// This won't work — get_global_ref looks up a global named "parent.child"

// Option 2: Navigate from Lua
lua.execute_script('_tmp = parent.child');
const nested = lua.get_global_ref('_tmp');
lua.execute_script('_tmp = nil');
```

This is admittedly awkward. A future `get_field_ref(handle, key)` method could
address this by returning a handle to a nested table. This is deferred to keep
the initial implementation simple.

### Integer keys vs string keys

The existing `GetTableField` and `SetTableField` methods already handle
integer key detection (they parse the string key as an integer if possible
and use `lua_geti`/`lua_seti` for numeric keys). The `LuaTableHandle.get()`
and `set()` methods accept `string | number`, converting numbers to strings
before passing to the core layer. This leverages the existing integer
detection logic.

---

## Implementation Checklist

### Core Layer (`src/core/lua-runtime.h` / `src/core/lua-runtime.cpp`)

- [ ] Add `int CreateTable()` — create empty table, return registry ref
- [ ] Add `int CreateTableFrom(const LuaTable&)` — create from object map
- [ ] Add `int CreateTableFrom(const LuaArray&)` — create from array
- [ ] Add `std::variant<int, std::string> GetGlobalRef(const std::string&)` — get global as ref
- [ ] Add `std::vector<std::pair<LuaPtr, LuaPtr>> TablePairs(int ref)` — iterate all pairs
- [ ] Add `std::vector<std::pair<int64_t, LuaPtr>> TableIPairs(int ref)` — iterate sequence
- [ ] Add `void ReleaseTableRef(int ref)` — explicit ref release
- [ ] Add C++ unit tests for all new methods

### N-API Layer (`src/lua-native.h` / `src/lua-native.cpp`)

- [ ] Add `CreateTableHandle(Napi::Env, int ref)` helper to `LuaContext`
- [ ] Implement `TableHandleGet`, `TableHandleSet`, `TableHandleHas`, `TableHandleLength` static functions
- [ ] Implement `TableHandlePairs`, `TableHandleIPairs` static functions
- [ ] Implement `TableHandleRelease` static function
- [ ] Add `CreateTable(const Napi::CallbackInfo&)` to `LuaContext`
- [ ] Add `GetGlobalRef(const Napi::CallbackInfo&)` to `LuaContext`
- [ ] Register `create_table` and `get_global_ref` as instance methods
- [ ] Verify `set_global` works with table handles via existing `_tableRef` path

### Type Definitions (`types.d.ts`)

- [ ] Add `LuaTableHandle` interface
- [ ] Add `create_table()` overloads to `LuaContext`
- [ ] Add `get_global_ref()` to `LuaContext`
- [ ] Add `LuaTableHandle` to `LuaValue` union

### Tests (`tests/ts/lua-native.spec.ts`)

- [ ] `create_table()` returns a handle with all methods
- [ ] `create_table()` with object initializer pre-populates fields
- [ ] `create_table()` with array initializer creates 1-indexed sequence
- [ ] `handle.get()` returns correct values for string and numeric keys
- [ ] `handle.set()` sets values visible from Lua
- [ ] `handle.has()` returns true for existing keys, false for missing
- [ ] `handle.length()` returns sequence length
- [ ] `handle.pairs()` returns all key-value pairs
- [ ] `handle.ipairs()` returns sequential integer-keyed entries
- [ ] `handle.release()` frees the registry reference
- [ ] Methods throw after `handle.release()`
- [ ] Double `release()` is a no-op (not an error)
- [ ] `set_global` with a table handle makes it accessible from Lua
- [ ] Mutations from JS via handle are visible in Lua
- [ ] Mutations from Lua are visible via handle
- [ ] `get_global_ref()` returns a live reference to a global table
- [ ] `get_global_ref()` throws for non-table globals
- [ ] Table handle works with metatabled tables (metamethods fire)
- [ ] Nested table access via `get()` returns deep copy (plain) or Proxy (metatabled)
- [ ] Passing a handle as a value to another handle's `set()` references the same table

### C++ Tests (`tests/cpp/lua-native-test.cpp`)

- [ ] `CreateTable` returns a valid registry ref
- [ ] `CreateTableFrom` (table) populates fields correctly
- [ ] `CreateTableFrom` (array) creates 1-indexed sequence
- [ ] `GetGlobalRef` returns ref for table globals
- [ ] `GetGlobalRef` returns error for non-table globals
- [ ] `TablePairs` iterates all entries
- [ ] `TableIPairs` iterates sequential integer keys, stops at nil
- [ ] `ReleaseTableRef` frees the registry slot
- [ ] Released ref cannot be used (verify graceful failure)

---

## Future Extensions

These are not part of the initial implementation but are natural follow-ups:

- **`get_field_ref(handle, key)`** — Get a handle to a nested table without
  going through `execute_script`. Avoids the nested table awkwardness.
- **`table_remove(handle, key)`** — Delete a key from a table (set to nil).
  Currently achievable via `handle.set(key, null)`.
- **`pairs_iter()` / `ipairs_iter()`** — Lazy iterators for large tables
  using the JS iterator protocol. Requires careful stack management.
- **`to_object(handle)`** — Deep-copy a handle's table to a plain JS object
  (inverse of `create_table(obj)`). Currently achievable via
  `handle.pairs()` + manual construction.
- **FinalizationRegistry cleanup** — Use JS `FinalizationRegistry` to
  automatically release handles that become unreachable without `release()`.
  This requires N-API support for weak references or a custom poller.
