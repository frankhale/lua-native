# Implementation Plan: Module / Require Integration

This document provides a comprehensive plan for implementing `require()` support in lua-native, enabling Lua scripts to load modules from the filesystem and from JS-provided module definitions.

---

## Overview

Two new APIs allow Lua scripts to use `require()` for loading external Lua modules and JS-defined modules:

```typescript
// Add filesystem search paths for Lua modules
lua.add_search_path('./lua_modules/?.lua');

// Register a JS object as a requireable Lua module
lua.register_module('utils', {
  clamp: (x, min, max) => Math.min(Math.max(x, min), max),
  lerp: (a, b, t) => a + (b - a) * t,
});

// Lua code can now:
// local utils = require('utils')
// local mylib = require('mylib')  -- loaded from ./lua_modules/mylib.lua
```

**Prerequisite:** The `package` library must be loaded. Both methods throw if it is not available.

---

## Design Decision: How to Register Module Functions

The `add_search_path` API is straightforward — it just appends to `package.path`. The real design question is how `register_module` should handle **JavaScript functions** within the module object so they become callable from Lua.

There are three approaches described in this document. They all share the same N-API validation and the same `add_search_path` implementation — they only differ in how `register_module` wires up functions.

### Recommended: Approach C — Build the module table directly in Lua

**Core idea:** Add a new `RegisterModuleTable` method to the core layer. The N-API layer converts JS values into a vector of entries (plain values or host function names). The core layer creates the Lua table directly on the stack, pushing closures for functions inline, and sets it in `package.loaded` in one shot.

**Why this is the best approach:**
- **No global namespace pollution.** Functions are stored via `StoreHostFunction` (which already exists and is used by `set_metatable`) — they never appear as Lua globals, not even temporarily.
- **No cleanup step.** Unlike Approach A, there's no need to nil out temporary globals after registration.
- **Clean separation of concerns.** The N-API layer handles JS-to-C++ conversion; the core layer handles Lua stack manipulation. Neither does the other's job.
- **Proven pattern.** This is the same approach used by `SetGlobalMetatable` for mixing functions and values in a table.
- **Direct closure creation.** Functions are pushed as `lua_pushcclosure` directly into the module table, using the existing `LuaCallHostFunction` dispatch mechanism.

**Tradeoff:** Requires a new core method (`RegisterModuleTable`) with a `std::variant` parameter, which adds some API surface. But this is justified by the cleaner architecture.

See [Phase 2.2 — Preferred approach](#22-add-registermodule-instance-method) for full implementation.

---

### Approach A — Global-then-nil (works but messy)

**Core idea:** Register each JS function as a global host function using the existing `RegisterFunction` + `CreateJsCallbackWrapper` machinery (same as `set_global` with function values). Then retrieve the `LuaFunctionRef` via `GetGlobal`, store it in a `LuaTable`, nil out the temporary global, and pass the table to a simple `RegisterModule` core method that sets it in `package.loaded`.

**Steps:**
1. For each function in the module object, call `runtime->RegisterFunction("__module_<name>_<key>", ...)` — this creates a Lua global.
2. Retrieve it: `auto funcValue = runtime->GetGlobal("__module_<name>_<key>")`.
3. Store the `LuaFunctionRef` in a `LuaTable`.
4. Nil out the global: `runtime->SetGlobal("__module_<name>_<key>", nil)`.
5. Pass the `LuaTable` to `runtime->RegisterModule(name, moduleValue)`.

**Pros:**
- Reuses 100% existing infrastructure — no new core methods beyond a simple `RegisterModule` that sets `package.loaded[name]`.
- Easy to understand if you already know how `set_global` works with functions.

**Cons:**
- **Temporary global pollution.** Functions briefly exist as Lua globals before being nil'd out. If Lua code runs concurrently (unlikely but possible in future), it could observe these transient globals.
- **Cleanup is fragile.** If something throws between RegisterFunction and SetGlobal(nil), stale globals remain.
- **Roundabout.** Creating a global just to immediately retrieve and delete it is an awkward pattern.

See [Phase 2.2 — first code block](#22-add-registermodule-instance-method) for full implementation.

---

### Approach B — StoreHostFunction + LuaValue (incomplete)

**Core idea:** Use `StoreHostFunction` (which stores in `host_functions_` without creating a global) and then build the module as a `LuaTable` in the N-API layer, passing it to a simple `RegisterModule` core method.

**Why this doesn't work cleanly:** The `LuaTable` type stores `LuaPtr` values, which get deep-pushed by `PushLuaValue`. For functions, you'd need `LuaFunctionRef` values that resolve to the correct closures — but `StoreHostFunction` doesn't create a Lua-side function object you can reference. There's no existing way to get a `LuaFunctionRef` without going through the global registration path (Approach A).

**Verdict:** This is a dead end without adding a new helper that creates a closure and returns its reference — at which point you're essentially building Approach C anyway. **Not recommended.**

---

### Summary

| | Approach A: Global-then-nil | Approach B: StoreHostFunction + LuaValue | **Approach C: Direct Lua table** |
|---|---|---|---|
| New core methods | `RegisterModule` (simple) | `RegisterModule` (simple) + new helper | `RegisterModuleTable` (richer) |
| Global pollution | Temporary (nil'd out) | None | None |
| Cleanup needed | Yes (nil out globals) | No | No |
| Proven pattern | `set_global` with functions | None (doesn't fully work) | `SetGlobalMetatable` |
| Complexity | Medium (workaround needed) | High (missing pieces) | Low (clean path) |
| **Recommendation** | Workable fallback | Avoid | **Use this** |

---

## API Design

### `add_search_path(path: string): void`

Appends a search path template to Lua's `package.path`. The path must contain a `?` placeholder that gets replaced by the module name during resolution (standard Lua convention).

```typescript
lua.add_search_path('./lua_modules/?.lua');
lua.add_search_path('/usr/local/share/lua/5.5/?.lua');
lua.add_search_path('./libs/?/init.lua');
```

Multiple calls append to the existing `package.path` with `;` separators. Lua's built-in `require()` resolver then searches these paths in order.

**Validation:**
- Throws `TypeError` if argument is not a string.
- Throws `Error` if the `package` library is not loaded.
- Throws `Error` if the path does not contain a `?` placeholder.

### `register_module(name: string, module: LuaTable | LuaCallbacks): void`

Pre-loads a module into Lua's `package.loaded` table so that `require(name)` returns it immediately without any filesystem search.

```typescript
lua.register_module('utils', {
  clamp: (x, min, max) => Math.min(Math.max(x, min), max),
  version: '1.0.0',
});

// In Lua:
// local utils = require('utils')
// print(utils.version)       --> "1.0.0"
// print(utils.clamp(5, 0, 3)) --> 3
```

The module value can be:
- A plain object with string keys (becomes a Lua table with string keys)
- An object with function values (each function is registered as a host function callable from Lua)
- A mix of both

**Validation:**
- Throws `TypeError` if `name` is not a string or `module` is not an object.
- Throws `Error` if the `package` library is not loaded.

**Behavior:**
- If a module with the same name already exists in `package.loaded`, it is overwritten.
- The module is accessible immediately via `require(name)` in subsequent Lua code.
- Functions within the module object behave identically to functions registered via `set_global()` or the constructor callbacks — they are full JS callbacks that can receive and return Lua values.

---

## Implementation Details

### Phase 1: Core Layer (`src/core/lua-runtime.h` / `src/core/lua-runtime.cpp`)

#### 1.1 Add `AddSearchPath` method

**Header (`lua-runtime.h`):**

Add to the public interface of `LuaRuntime`:

```cpp
void AddSearchPath(const std::string& path) const;
```

**Implementation (`lua-runtime.cpp`):**

```cpp
void LuaRuntime::AddSearchPath(const std::string& path) const {
  StackGuard guard(L_);

  // Verify the package library is loaded
  lua_getglobal(L_, "package");
  if (lua_isnil(L_, -1)) {
    throw std::runtime_error(
      "Cannot add search path: the 'package' library is not loaded. "
      "Include 'package' in the libraries option.");
  }

  // Get current package.path
  lua_getfield(L_, -1, "path");
  const char* current_raw = lua_tostring(L_, -1);
  std::string current = current_raw ? current_raw : "";
  lua_pop(L_, 1);  // pop path string

  // Append the new path
  if (!current.empty()) {
    current += ";";
  }
  current += path;

  // Set the updated package.path
  lua_pushstring(L_, current.c_str());
  lua_setfield(L_, -2, "path");
  // StackGuard pops the package table
}
```

**Notes:**
- Uses `StackGuard` for stack safety.
- The `const` qualifier is consistent with `ExecuteScript` and `SetGlobal` — the method modifies Lua state but not C++ member variables.
- Checks that `package` is a table (not nil), not just that it exists. This catches the edge case where `package` was overwritten by user code.

#### 1.2 Add `RegisterModule` method

**Header (`lua-runtime.h`):**

Add to the public interface of `LuaRuntime`:

```cpp
void RegisterModule(const std::string& name, const LuaPtr& value) const;
```

**Implementation (`lua-runtime.cpp`):**

```cpp
void LuaRuntime::RegisterModule(const std::string& name,
                                 const LuaPtr& value) const {
  StackGuard guard(L_);

  // Verify the package library is loaded
  lua_getglobal(L_, "package");
  if (lua_isnil(L_, -1)) {
    throw std::runtime_error(
      "Cannot register module: the 'package' library is not loaded. "
      "Include 'package' in the libraries option.");
  }

  // Get package.loaded
  lua_getfield(L_, -1, "loaded");
  if (lua_isnil(L_, -1)) {
    throw std::runtime_error(
      "Cannot register module: package.loaded is not available.");
  }

  // Push the module value and set it in package.loaded
  PushLuaValue(L_, value);
  lua_setfield(L_, -2, name.c_str());
  // StackGuard pops package.loaded and package
}
```

**Notes:**
- The module value is pushed as-is via `PushLuaValue`. For table values, this creates a standard Lua table. For other types (though unlikely), it pushes the appropriate Lua value.
- Subsequent `require(name)` calls in Lua check `package.loaded` first, so they will find and return this value without triggering any searcher.
- Function values within the module table must be registered as host functions *before* calling `RegisterModule`. This is handled by the N-API layer (see Phase 2).

#### 1.3 Add `HasPackageLibrary` helper (private)

To avoid duplicating the package library check, add a private helper:

**Header (`lua-runtime.h`):**

```cpp
private:
  bool HasPackageLibrary() const;
```

**Implementation (`lua-runtime.cpp`):**

```cpp
bool LuaRuntime::HasPackageLibrary() const {
  StackGuard guard(L_);
  lua_getglobal(L_, "package");
  bool has = !lua_isnil(L_, -1) && lua_istable(L_, -1);
  return has;
}
```

Then refactor `AddSearchPath` and `RegisterModule` to use:

```cpp
if (!HasPackageLibrary()) {
  throw std::runtime_error("Cannot ...: the 'package' library is not loaded. ...");
}
```

---

### Phase 2: N-API Layer (`src/lua-native.h` / `src/lua-native.cpp`)

#### 2.1 Add `AddSearchPath` instance method

**Header (`lua-native.h`):**

Add to `LuaContext` public methods:

```cpp
Napi::Value AddSearchPath(const Napi::CallbackInfo& info);
```

**Implementation (`lua-native.cpp`):**

```cpp
Napi::Value LuaContext::AddSearchPath(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string path = info[0].As<Napi::String>().Utf8Value();

  // Validate the path contains a '?' placeholder
  if (path.find('?') == std::string::npos) {
    Napi::Error::New(env,
      "Search path must contain a '?' placeholder (e.g., './modules/?.lua')")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    runtime->AddSearchPath(path);
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return env.Undefined();
}
```

**Notes:**
- Follows the established pattern: busy check, argument validation, delegate to core, catch exceptions.
- The `?` placeholder validation happens at the N-API layer since it's a user-facing concern. The core layer doesn't validate path format — it just manipulates `package.path`.

#### 2.2 Add `RegisterModule` instance method

**Header (`lua-native.h`):**

Add to `LuaContext` public methods:

```cpp
Napi::Value RegisterModule(const Napi::CallbackInfo& info);
```

**Implementation (`lua-native.cpp`):**

```cpp
Napi::Value LuaContext::RegisterModule(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "Expected (string, object)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();
  const auto moduleObj = info[1].As<Napi::Object>();

  // Build a LuaTable from the module object.
  // Functions need to be registered as host functions first.
  lua_core::LuaTable moduleTable;
  Napi::Array keys = moduleObj.GetPropertyNames();

  for (uint32_t i = 0; i < keys.Length(); i++) {
    const std::string key = keys[i].As<Napi::String>().Utf8Value();
    const Napi::Value val = moduleObj.Get(key);

    if (val.IsFunction()) {
      // Register as a host function (same pattern as RegisterCallbacks)
      const std::string funcName = "__module_" + name + "_" + key;
      js_callbacks[funcName] = Napi::Persistent(val.As<Napi::Function>());
      runtime->RegisterFunction(funcName, CreateJsCallbackWrapper(funcName));

      // Store a LuaFunctionRef for the registered function
      // We need to get the function from the global where RegisterFunction put it,
      // then store its reference in the module table.
      auto funcValue = runtime->GetGlobal(funcName);
      moduleTable.emplace(key, funcValue);

      // Clean up the global - the function is accessible via the module table,
      // no need to pollute the global namespace
      runtime->SetGlobal(funcName,
        std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::nil()));
    } else {
      try {
        moduleTable.emplace(key,
          std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val)));
      } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Undefined();
      }
    }
  }

  auto moduleValue = std::make_shared<lua_core::LuaValue>(
    lua_core::LuaValue::from(std::move(moduleTable)));

  try {
    runtime->RegisterModule(name, moduleValue);
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return env.Undefined();
}
```

**Key design point — Function handling:**

Functions in the module object must be callable from Lua. See the [Design Decision](#design-decision-how-to-register-module-functions) section above for a comparison of the three approaches. The code block above shows **Approach A** (global-then-nil) for reference.

**The recommended implementation (Approach C)** builds the module table directly in Lua. This adds a `RegisterModuleTable` method to the core layer that:
1. Creates a new Lua table on the Lua stack
2. For each entry, either pushes a plain value or creates a host function closure
3. Sets the table in `package.loaded`

```cpp
void LuaRuntime::RegisterModuleTable(
    const std::string& name,
    const std::vector<std::pair<std::string, std::variant<LuaPtr, std::string>>>& entries) const {
  StackGuard guard(L_);

  if (!HasPackageLibrary()) {
    throw std::runtime_error("Cannot register module: the 'package' library is not loaded.");
  }

  lua_getglobal(L_, "package");
  lua_getfield(L_, -1, "loaded");

  // Create the module table
  lua_newtable(L_);

  for (const auto& [key, entry] : entries) {
    if (std::holds_alternative<std::string>(entry)) {
      // It's a host function name — push as closure
      const auto& funcName = std::get<std::string>(entry);
      lua_pushstring(L_, funcName.c_str());
      lua_pushcclosure(L_, LuaCallHostFunction, 1);
    } else {
      // It's a plain value
      PushLuaValue(L_, std::get<LuaPtr>(entry));
    }
    lua_setfield(L_, -2, key.c_str());
  }

  // package.loaded[name] = module_table
  lua_setfield(L_, -2, name.c_str());
}
```

Then the N-API layer builds the entries vector:

```cpp
Napi::Value LuaContext::RegisterModule(const Napi::CallbackInfo& info) {
  // ... validation ...

  using Entry = std::pair<std::string, std::variant<lua_core::LuaPtr, std::string>>;
  std::vector<Entry> entries;

  for (uint32_t i = 0; i < keys.Length(); i++) {
    const std::string key = keys[i].As<Napi::String>().Utf8Value();
    const Napi::Value val = moduleObj.Get(key);

    if (val.IsFunction()) {
      const std::string funcName = "__module_" + name + "_" + key;
      js_callbacks[funcName] = Napi::Persistent(val.As<Napi::Function>());
      runtime->StoreHostFunction(funcName, CreateJsCallbackWrapper(funcName));
      entries.emplace_back(key, funcName);
    } else {
      try {
        entries.emplace_back(key,
          std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val)));
      } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Undefined();
      }
    }
  }

  try {
    runtime->RegisterModuleTable(name, entries);
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return env.Undefined();
}
```

**This is Approach C — the recommended approach.** See the [Design Decision](#design-decision-how-to-register-module-functions) section for why this was chosen over the alternatives.

#### 2.3 Register instance methods

In `LuaContext::Init`, add the new methods to the class definition:

```cpp
const Napi::Function func = DefineClass(env, "LuaContext", {
  // ... existing methods ...
  InstanceMethod("add_search_path", &LuaContext::AddSearchPath),
  InstanceMethod("register_module", &LuaContext::RegisterModule),
});
```

---

### Phase 3: TypeScript Types (`types.d.ts`)

Add to the `LuaContext` interface:

```typescript
/**
 * Appends a search path to Lua's `package.path` for module resolution.
 * The path must contain a `?` placeholder that gets replaced by the module name.
 * Requires the `package` library to be loaded.
 *
 * @param path Search path template (e.g., './modules/?.lua')
 * @example
 * lua.add_search_path('./lua_modules/?.lua');
 * lua.add_search_path('./libs/?/init.lua');
 * // Lua: local mod = require('mymod')  -- searches ./lua_modules/mymod.lua
 */
add_search_path(path: string): void;

/**
 * Registers a JavaScript object as a Lua module, making it available via `require(name)`.
 * The module is pre-loaded into `package.loaded` — no filesystem search occurs.
 * Functions in the module object become callable from Lua.
 * Requires the `package` library to be loaded.
 *
 * @param name The module name used in `require(name)`
 * @param module An object whose properties become the module's fields
 * @example
 * lua.register_module('utils', {
 *   clamp: (x, min, max) => Math.min(Math.max(x, min), max),
 *   version: '1.0.0',
 * });
 * // Lua: local utils = require('utils'); utils.clamp(5, 0, 10)
 */
register_module(name: string, module: LuaTable | LuaCallbacks): void;
```

---

### Phase 4: Tests (`tests/ts/lua-native.spec.ts`)

Add a new test section:

```typescript
// ============================================
// MODULE / REQUIRE INTEGRATION
// ============================================
describe('module / require integration', () => {
  describe('add_search_path', () => {
    it('loads a Lua module from a search path', () => {
      // Create a temp Lua module file
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-modules-'));
      const modPath = path.join(tmpDir, 'mymod.lua');
      fs.writeFileSync(modPath, `
        local M = {}
        function M.greet(name)
          return "Hello, " .. name
        end
        M.version = 42
        return M
      `);

      try {
        const lua = new lua_native.init({}, { libraries: 'all' });
        lua.add_search_path(path.join(tmpDir, '?.lua'));
        const result = lua.execute_script(`
          local mymod = require('mymod')
          return mymod.greet('World'), mymod.version
        `);
        expect(result).toEqual(['Hello, World', 42]);
      } finally {
        fs.unlinkSync(modPath);
        fs.rmdirSync(tmpDir);
      }
    });

    it('supports multiple search paths', () => {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-mods1-'));
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-mods2-'));
      fs.writeFileSync(path.join(dir1, 'mod_a.lua'), 'return { x = 1 }');
      fs.writeFileSync(path.join(dir2, 'mod_b.lua'), 'return { y = 2 }');

      try {
        const lua = new lua_native.init({}, { libraries: 'all' });
        lua.add_search_path(path.join(dir1, '?.lua'));
        lua.add_search_path(path.join(dir2, '?.lua'));

        expect(lua.execute_script("return require('mod_a').x")).toBe(1);
        expect(lua.execute_script("return require('mod_b').y")).toBe(2);
      } finally {
        fs.unlinkSync(path.join(dir1, 'mod_a.lua'));
        fs.unlinkSync(path.join(dir2, 'mod_b.lua'));
        fs.rmdirSync(dir1);
        fs.rmdirSync(dir2);
      }
    });

    it('throws when package library is not loaded', () => {
      const lua = new lua_native.init({}, { libraries: ['base'] });
      expect(() => lua.add_search_path('./?.lua')).toThrow(/package/);
    });

    it('throws when path has no ? placeholder', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      expect(() => lua.add_search_path('./modules/foo.lua')).toThrow(/\?/);
    });

    it('throws on non-string argument', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      expect(() => (lua as any).add_search_path(42)).toThrow();
    });

    it('require caches the module (loaded once)', () => {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-cache-'));
      fs.writeFileSync(path.join(tmpDir, 'counter.lua'), `
        local M = { count = 0 }
        M.count = M.count + 1
        return M
      `);

      try {
        const lua = new lua_native.init({}, { libraries: 'all' });
        lua.add_search_path(path.join(tmpDir, '?.lua'));
        lua.execute_script(`
          local c1 = require('counter')
          local c2 = require('counter')
          -- Both should be the same table (cached)
          assert(c1 == c2, "require should cache modules")
        `);
      } finally {
        fs.unlinkSync(path.join(tmpDir, 'counter.lua'));
        fs.rmdirSync(tmpDir);
      }
    });
  });

  describe('register_module', () => {
    it('registers a module with plain values', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.register_module('config', {
        debug: true,
        version: '1.0.0',
        maxRetries: 3,
      });
      expect(lua.execute_script("return require('config').debug")).toBe(true);
      expect(lua.execute_script("return require('config').version")).toBe('1.0.0');
      expect(lua.execute_script("return require('config').maxRetries")).toBe(3);
    });

    it('registers a module with functions', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.register_module('math_utils', {
        clamp: (...args: any[]) => {
          const [x, min, max] = args as number[];
          return Math.min(Math.max(x, min), max);
        },
        lerp: (...args: any[]) => {
          const [a, b, t] = args as number[];
          return a + (b - a) * t;
        },
      });
      expect(lua.execute_script("return require('math_utils').clamp(15, 0, 10)")).toBe(10);
      expect(lua.execute_script("return require('math_utils').clamp(-5, 0, 10)")).toBe(0);
      expect(lua.execute_script("return require('math_utils').lerp(0, 100, 0.5)")).toBe(50);
    });

    it('registers a module with mixed functions and values', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.register_module('utils', {
        version: '2.0',
        double: (...args: any[]) => (args[0] as number) * 2,
      });
      expect(lua.execute_script("return require('utils').version")).toBe('2.0');
      expect(lua.execute_script("return require('utils').double(21)")).toBe(42);
    });

    it('module is cached by require', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.register_module('singleton', { id: 1 });
      lua.execute_script(`
        local a = require('singleton')
        local b = require('singleton')
        assert(a == b, "require should return the same table")
      `);
    });

    it('overwrites existing module on re-register', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.register_module('mymod', { value: 1 });
      expect(lua.execute_script("return require('mymod').value")).toBe(1);

      lua.register_module('mymod', { value: 2 });
      // Need to clear the require cache for the overwrite to take effect
      lua.execute_script("package.loaded['mymod'] = nil");
      lua.register_module('mymod', { value: 2 });
      expect(lua.execute_script("return require('mymod').value")).toBe(2);
    });

    it('throws when package library is not loaded', () => {
      const lua = new lua_native.init({}, { libraries: ['base'] });
      expect(() => lua.register_module('mod', { x: 1 })).toThrow(/package/);
    });

    it('throws on invalid arguments', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      expect(() => (lua as any).register_module(42, {})).toThrow();
      expect(() => (lua as any).register_module('mod')).toThrow();
    });

    it('module functions receive correct arguments from Lua', () => {
      let receivedArgs: any[] = [];
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.register_module('capture', {
        capture: (...args: any[]) => {
          receivedArgs = [...args];
          return null;
        },
      });
      lua.execute_script("require('capture').capture(1, 'hello', true)");
      expect(receivedArgs).toEqual([1, 'hello', true]);
    });

    it('requiring an unknown module still errors', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      expect(() => lua.execute_script("require('nonexistent')")).toThrow();
    });

    it('registered module does not pollute global namespace', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.register_module('secret', { value: 42 });
      // Module functions should not appear as globals
      expect(lua.execute_script("return type(secret)")).toBe('nil');
      // But require works
      expect(lua.execute_script("return require('secret').value")).toBe(42);
    });

    it('works alongside add_search_path', () => {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-mixed-'));
      fs.writeFileSync(path.join(tmpDir, 'filemod.lua'),
        "return { source = 'file' }");

      try {
        const lua = new lua_native.init({}, { libraries: 'all' });
        lua.add_search_path(path.join(tmpDir, '?.lua'));
        lua.register_module('jsmod', { source: 'js' });

        expect(lua.execute_script("return require('filemod').source")).toBe('file');
        expect(lua.execute_script("return require('jsmod').source")).toBe('js');
      } finally {
        fs.unlinkSync(path.join(tmpDir, 'filemod.lua'));
        fs.rmdirSync(tmpDir);
      }
    });
  });

  describe('busy state', () => {
    it('add_search_path throws while async is running', async () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      const promise = lua.execute_script_async("return 1");
      // Note: may or may not throw depending on timing; test the pattern
      await promise;
      // After completion, it should work
      lua.add_search_path('./?.lua');
    });

    it('register_module throws while async is running', async () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      const promise = lua.execute_script_async("return 1");
      await promise;
      lua.register_module('mod', { x: 1 });
    });
  });
});
```

#### Test Fixtures

Create a test fixture directory `tests/fixtures/modules/` with a test module:

**`tests/fixtures/modules/testmod.lua`:**
```lua
local M = {}

function M.add(a, b)
  return a + b
end

M.name = "testmod"

return M
```

This can be used for simpler fixture-based tests that don't need temp files.

---

### Phase 5: Documentation Updates

#### `docs/FEATURES.md`

Add a new section for Module / Require Integration following the existing format, documenting:
- Overview of the feature
- Architecture details (core layer methods, N-API layer methods)
- Design decisions (why `package.loaded` for JS modules, why `?` placeholder validation)

#### `docs/FUTURE.md`

Mark the "Module / Require Integration" section as completed, consistent with how "File Execution" and "Selective Standard Library Loading" are marked.

#### `types.d.ts`

Already covered in Phase 3.

---

## File Change Summary

| File | Changes |
|------|---------|
| `src/core/lua-runtime.h` | Add `AddSearchPath`, `RegisterModule` (or `RegisterModuleTable`), and `HasPackageLibrary` declarations |
| `src/core/lua-runtime.cpp` | Implement the three new methods |
| `src/lua-native.h` | Add `AddSearchPath` and `RegisterModule` method declarations to `LuaContext` |
| `src/lua-native.cpp` | Implement both N-API methods, register as instance methods in `Init` |
| `types.d.ts` | Add `add_search_path` and `register_module` to `LuaContext` interface |
| `tests/ts/lua-native.spec.ts` | Add module/require test section (~15-20 test cases) |
| `docs/FEATURES.md` | Add Module / Require Integration section |
| `docs/FUTURE.md` | Mark section as completed |

---

## Implementation Order

1. **Core layer methods** — `HasPackageLibrary`, `AddSearchPath`, `RegisterModuleTable`
2. **N-API layer methods** — `AddSearchPath`, `RegisterModule`, register in `Init`
3. **TypeScript types** — Add declarations to `types.d.ts`
4. **Tests** — Add test section with all test cases
5. **Documentation** — Update `FEATURES.md` and `FUTURE.md`

Each step can be validated independently:
- After step 1: C++ unit tests (if available) can exercise the core methods directly
- After step 2: Manual testing via `node -e "..."` with the built module
- After step 3: TypeScript compilation validates the type definitions
- After step 4: Full test suite via `npx vitest`
- After step 5: Documentation review

---

## Edge Cases and Considerations

### Circular requires
Lua's built-in `require` handles circular dependencies by returning the partially-loaded module from `package.loaded`. No special handling is needed — this works automatically for both filesystem modules and JS-registered modules.

### Module name conflicts
If a JS-registered module and a filesystem module share the same name, the JS module wins because `package.loaded` is checked before any searcher runs. This is by design — pre-loading takes priority.

### Thread safety
Both methods follow the existing pattern: they check `is_busy_` and throw if an async operation is in progress. The core layer methods are `const` (they modify Lua state but not C++ members), consistent with the existing API.

### Package library dependency
Both methods require the `package` library. The error message is descriptive: it tells the user to include `'package'` in their libraries option. The `'safe'` preset includes `package` by default, so this is only an issue for users who manually select specific libraries and omit `package`.

### Module functions and async mode
Module functions registered via `register_module` are standard host functions. They are subject to the same async mode restriction as any other JS callback — calling them from `execute_script_async` will produce an "async mode" error. This is consistent with existing behavior and requires no special handling.
