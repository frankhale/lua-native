# Bytecode Precompilation

Compile Lua source code to bytecode with `compile()` and load precompiled bytecode with `load_bytecode()`. Bytecode can be cached to disk or kept in memory for faster startup — it skips the parsing and compilation phases on subsequent loads.

```typescript
const lua = new lua_native.init({}, { libraries: 'all' });

// Compile source to bytecode (returns a Buffer)
const bytecode = lua.compile('return function(x) return x * 2 end');

// Save to disk for later
fs.writeFileSync('my-script.luac', bytecode);

// Load and execute bytecode (identical result to execute_script)
const fn = lua.load_bytecode<LuaFunction>(bytecode);
fn(21); // 42
```

---

## API Surface

### `compile(script: string, options?: CompileOptions): Buffer`

Compiles a Lua source string to bytecode without executing it. Returns a Node.js `Buffer` containing the binary bytecode.

- **script** — Lua source code to compile.
- **options.stripDebug** — If `true`, strip debug information (line numbers, local variable names) from the bytecode. Produces smaller output but loses debug context on errors. Default: `false`.
- **options.chunkName** — Name used in error messages for this chunk (e.g., `"@my-script.lua"`). Default: the first 60 characters of the source.
- Throws if the source has syntax errors.
- The returned bytecode is tied to the Lua version (5.5). It is **not** portable across Lua major/minor versions or across different endianness/pointer sizes.

### `load_bytecode<T>(bytecode: Buffer, chunkName?: string): T`

Loads precompiled bytecode into the Lua state and executes it. Returns the result exactly like `execute_script()`.

- **bytecode** — A `Buffer` containing Lua bytecode (from `compile()` or `luac`).
- **chunkName** — Name used in error messages. Default: `"bytecode"`.
- Throws if the bytecode is invalid, corrupted, or from an incompatible Lua version.
- Only accepts binary bytecode (mode `"b"`) — raw source strings are rejected to prevent ambiguity. Use `execute_script()` for source.

### `compile_file(filepath: string, options?: CompileOptions): Buffer`

Convenience method that reads a Lua file from disk and compiles it to bytecode without executing it.

- **filepath** — Path to the `.lua` source file.
- **options** — Same as `compile()`.
- The `chunkName` defaults to `"@<filepath>"` (matching Lua convention for file chunks).
- Throws if the file cannot be read or has syntax errors.

---

## Type Definitions

```typescript
interface CompileOptions {
  /** Strip debug info for smaller bytecode. Default: false */
  stripDebug?: boolean;
  /** Chunk name for error messages. Default: source prefix or "@filepath" */
  chunkName?: string;
}

interface LuaContext {
  // ... existing methods ...

  /**
   * Compiles Lua source to bytecode without executing it.
   * @param script The Lua source code to compile
   * @param options Optional compilation settings
   * @returns Buffer containing the compiled bytecode
   */
  compile(script: string, options?: CompileOptions): Buffer;

  /**
   * Compiles a Lua file to bytecode without executing it.
   * @param filepath Path to the Lua source file
   * @param options Optional compilation settings
   * @returns Buffer containing the compiled bytecode
   */
  compile_file(filepath: string, options?: CompileOptions): Buffer;

  /**
   * Loads and executes precompiled Lua bytecode.
   * @param bytecode Buffer containing Lua bytecode
   * @param chunkName Optional name for error messages
   * @returns The result of executing the bytecode
   */
  load_bytecode<T extends LuaValue | LuaValue[] = LuaValue>(
    bytecode: Buffer,
    chunkName?: string
  ): T;
}
```

---

## Implementation Plan

### Core Layer (`lua-runtime.h` / `lua-runtime.cpp`)

The core layer handles all Lua C API interaction. Three new methods are added to `LuaRuntime`.

#### 1. `CompileScript`

Compiles a Lua source string to bytecode using `luaL_loadstring` + `lua_dump`.

**Header** (`lua-runtime.h`):

```cpp
using CompileResult = std::variant<std::vector<uint8_t>, std::string>;

[[nodiscard]] CompileResult CompileScript(
    const std::string& script,
    bool strip_debug = false,
    const std::string& chunk_name = "") const;
```

**Implementation** (`lua-runtime.cpp`):

```cpp
CompileResult LuaRuntime::CompileScript(const std::string& script,
                                         bool strip_debug,
                                         const std::string& chunk_name) const {
  StackGuard guard(L_);

  // Use luaL_loadbuffer to support custom chunk names.
  // If no chunk name is provided, luaL_loadstring behavior is used
  // (Lua derives the name from the source).
  const char* name = chunk_name.empty() ? nullptr : chunk_name.c_str();
  int status;
  if (name) {
    status = luaL_loadbuffer(L_, script.c_str(), script.size(), name);
  } else {
    status = luaL_loadstring(L_, script.c_str());
  }

  if (status != LUA_OK) {
    std::string err = lua_tostring(L_, -1);
    return err;
  }

  // The compiled function is now on top of the stack.
  // Dump it to bytecode using lua_dump.
  std::vector<uint8_t> bytecode;
  lua_dump(L_, [](lua_State*, const void* p, size_t sz, void* ud) -> int {
    auto* bc = static_cast<std::vector<uint8_t>*>(ud);
    auto* bytes = static_cast<const uint8_t*>(p);
    bc->insert(bc->end(), bytes, bytes + sz);
    return 0;  // 0 = success
  }, &bytecode, strip_debug ? 1 : 0);

  // lua_dump does not pop the function; StackGuard handles cleanup.
  return bytecode;
}
```

**How it works:**

1. `luaL_loadstring` (or `luaL_loadbuffer` with a chunk name) parses the source and pushes the compiled function onto the Lua stack. It does **not** execute it.
2. `lua_dump` serializes the function on top of the stack into binary bytecode by calling the writer callback repeatedly. The fourth parameter (`strip`) controls whether debug info is included.
3. The writer callback appends each chunk of bytes to a `std::vector<uint8_t>`.
4. `StackGuard` restores the stack to its original state on return.
5. If the source has syntax errors, `luaL_loadstring` returns non-OK and the error message is returned as a string.

#### 2. `CompileFile`

Compiles a Lua file to bytecode using `luaL_loadfile` + `lua_dump`.

**Header** (`lua-runtime.h`):

```cpp
[[nodiscard]] CompileResult CompileFile(
    const std::string& filepath,
    bool strip_debug = false) const;
```

**Implementation** (`lua-runtime.cpp`):

```cpp
CompileResult LuaRuntime::CompileFile(const std::string& filepath,
                                       bool strip_debug) const {
  if (filepath.empty()) {
    return std::string("File path cannot be empty");
  }

  StackGuard guard(L_);

  if (luaL_loadfile(L_, filepath.c_str()) != LUA_OK) {
    std::string err = lua_tostring(L_, -1);
    return err;
  }

  std::vector<uint8_t> bytecode;
  lua_dump(L_, [](lua_State*, const void* p, size_t sz, void* ud) -> int {
    auto* bc = static_cast<std::vector<uint8_t>*>(ud);
    auto* bytes = static_cast<const uint8_t*>(p);
    bc->insert(bc->end(), bytes, bytes + sz);
    return 0;
  }, &bytecode, strip_debug ? 1 : 0);

  return bytecode;
}
```

This mirrors `CompileScript` but uses `luaL_loadfile` which reads the file, sets the chunk name to `@filepath` automatically, and compiles it.

#### 3. `LoadBytecode`

Loads precompiled bytecode and executes it, returning results in the same format as `ExecuteScript`.

**Header** (`lua-runtime.h`):

```cpp
[[nodiscard]] ScriptResult LoadBytecode(
    const std::vector<uint8_t>& bytecode,
    const std::string& chunk_name = "bytecode") const;
```

**Implementation** (`lua-runtime.cpp`):

```cpp
ScriptResult LuaRuntime::LoadBytecode(const std::vector<uint8_t>& bytecode,
                                       const std::string& chunk_name) const {
  if (bytecode.empty()) {
    return std::string("Bytecode cannot be empty");
  }

  const int stackBefore = lua_gettop(L_);

  // Use lua_load with a simple reader that provides the bytecode in one call.
  // The "b" mode restricts to binary-only, rejecting source text.
  struct ReaderData {
    const uint8_t* data;
    size_t size;
    bool consumed;
  };
  ReaderData reader{bytecode.data(), bytecode.size(), false};

  int status = lua_load(L_,
    [](lua_State*, void* ud, size_t* sz) -> const char* {
      auto* r = static_cast<ReaderData*>(ud);
      if (r->consumed) {
        *sz = 0;
        return nullptr;
      }
      *sz = r->size;
      r->consumed = true;
      return reinterpret_cast<const char*>(r->data);
    },
    &reader, chunk_name.c_str(), "b");

  if (status != LUA_OK) {
    std::string error = lua_tostring(L_, -1);
    lua_pop(L_, 1);
    return error;
  }

  // Execute the loaded function (same pattern as ExecuteScript)
  if (lua_pcall(L_, 0, LUA_MULTRET, 0) != LUA_OK) {
    std::string error = lua_tostring(L_, -1);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_) - stackBefore;
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  try {
    for (int i = 0; i < nresults; ++i) {
      results.push_back(ToLuaValue(L_, stackBefore + 1 + i));
    }
  } catch (const std::exception& e) {
    lua_pop(L_, nresults);
    return std::string(e.what());
  }
  lua_pop(L_, nresults);
  return results;
}
```

**How it works:**

1. A `ReaderData` struct provides the bytecode to `lua_load`'s reader callback in a single pass.
2. The mode parameter `"b"` restricts `lua_load` to binary input only. If someone passes raw source text instead of bytecode, Lua rejects it immediately. This prevents accidentally using `load_bytecode` as a second `execute_script`.
3. On success, `lua_load` pushes the deserialized function onto the stack.
4. `lua_pcall` executes the function and collects results using the same pattern as `ExecuteScript`.

---

### N-API Layer (`lua-native.h` / `lua-native.cpp`)

Three new instance methods are added to `LuaContext`.

#### Header additions (`lua-native.h`):

```cpp
class LuaContext final : public Napi::ObjectWrap<LuaContext> {
public:
    // ... existing methods ...
    Napi::Value Compile(const Napi::CallbackInfo& info);
    Napi::Value CompileFile(const Napi::CallbackInfo& info);
    Napi::Value LoadBytecode(const Napi::CallbackInfo& info);
};
```

#### Method registration (`lua-native.cpp`, inside `LuaContext::Init`):

```cpp
InstanceMethod("compile", &LuaContext::Compile),
InstanceMethod("compile_file", &LuaContext::CompileFile),
InstanceMethod("load_bytecode", &LuaContext::LoadBytecode),
```

#### `Compile` implementation:

```cpp
Napi::Value LuaContext::Compile(const Napi::CallbackInfo& info) {
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

  const std::string script = info[0].As<Napi::String>().Utf8Value();

  // Parse options (second argument)
  bool strip_debug = false;
  std::string chunk_name;
  if (info.Length() >= 2 && info[1].IsObject()) {
    auto options = info[1].As<Napi::Object>();
    if (options.Has("stripDebug") && options.Get("stripDebug").IsBoolean()) {
      strip_debug = options.Get("stripDebug").As<Napi::Boolean>().Value();
    }
    if (options.Has("chunkName") && options.Get("chunkName").IsString()) {
      chunk_name = options.Get("chunkName").As<Napi::String>().Utf8Value();
    }
  }

  const auto result = runtime->CompileScript(script, strip_debug, chunk_name);

  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env, std::get<std::string>(result))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& bytecode = std::get<std::vector<uint8_t>>(result);
  return Napi::Buffer<uint8_t>::Copy(env, bytecode.data(), bytecode.size());
}
```

The bytecode is returned as a `Napi::Buffer<uint8_t>` — this maps to a Node.js `Buffer` which can be written to disk with `fs.writeFileSync()`, stored in a cache, or passed directly to `load_bytecode()`.

#### `CompileFile` implementation:

```cpp
Napi::Value LuaContext::CompileFile(const Napi::CallbackInfo& info) {
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

  const std::string filepath = info[0].As<Napi::String>().Utf8Value();

  bool strip_debug = false;
  if (info.Length() >= 2 && info[1].IsObject()) {
    auto options = info[1].As<Napi::Object>();
    if (options.Has("stripDebug") && options.Get("stripDebug").IsBoolean()) {
      strip_debug = options.Get("stripDebug").As<Napi::Boolean>().Value();
    }
  }

  const auto result = runtime->CompileFile(filepath, strip_debug);

  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env, std::get<std::string>(result))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& bytecode = std::get<std::vector<uint8_t>>(result);
  return Napi::Buffer<uint8_t>::Copy(env, bytecode.data(), bytecode.size());
}
```

#### `LoadBytecode` implementation:

```cpp
Napi::Value LuaContext::LoadBytecode(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Expected Buffer argument")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
  std::vector<uint8_t> bytecode(buffer.Data(), buffer.Data() + buffer.Length());

  std::string chunk_name = "bytecode";
  if (info.Length() >= 2 && info[1].IsString()) {
    chunk_name = info[1].As<Napi::String>().Utf8Value();
  }

  const auto res = runtime->LoadBytecode(bytecode, chunk_name);

  if (std::holds_alternative<std::string>(res)) {
    Napi::Error::New(env, std::get<std::string>(res))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& values = std::get<std::vector<lua_core::LuaPtr>>(res);
  if (values.empty()) return env.Undefined();
  if (values.size() == 1) return CoreToNapi(*values[0]);

  const Napi::Array array = Napi::Array::New(env, values.size());
  for (size_t i = 0; i < values.size(); ++i) {
    array.Set(i, CoreToNapi(*values[i]));
  }
  return array;
}
```

The result handling mirrors `ExecuteScript` exactly: empty results return `undefined`, a single result is returned directly, and multiple results are returned as an array.

---

### Changes Summary

| File | Change |
|---|---|
| `src/core/lua-runtime.h` | Add `CompileResult` type alias. Add `CompileScript`, `CompileFile`, `LoadBytecode` method declarations. |
| `src/core/lua-runtime.cpp` | Implement `CompileScript`, `CompileFile`, `LoadBytecode`. |
| `src/lua-native.h` | Add `Compile`, `CompileFile`, `LoadBytecode` method declarations to `LuaContext`. |
| `src/lua-native.cpp` | Implement `Compile`, `CompileFile`, `LoadBytecode`. Register as instance methods in `LuaContext::Init`. |
| `types.d.ts` | Add `CompileOptions` interface. Add `compile`, `compile_file`, `load_bytecode` to `LuaContext`. |

---

## Security Considerations

### Binary-only loading

`load_bytecode` uses `lua_load` with mode `"b"` (binary only). This prevents source text from being smuggled in where bytecode is expected, which would bypass any bytecode-specific validation the caller may be relying on.

### Bytecode is version-specific

Lua bytecode is **not** portable. It encodes the Lua version, endianness, pointer size, and integer/float sizes. Attempting to load bytecode compiled with a different Lua version (or on a different architecture) will fail with a clear error from `lua_load`. This is by Lua's design and we surface the error directly.

### No bytecode tampering protection

Lua bytecode has no integrity checks beyond the header format. Malformed bytecode can crash the Lua VM. In untrusted environments where bytecode comes from an external source, the caller should verify bytecode integrity (e.g., via a checksum or signature) before passing it to `load_bytecode`. This is documented as a caller responsibility, not enforced by the library.

### Strip debug info for production

When `stripDebug: true` is used, local variable names, line numbers, and source file information are removed. This produces smaller bytecode and avoids leaking source structure in deployed artifacts.

---

## Tests

### TypeScript Tests (`tests/ts/lua-native.spec.ts`)

```typescript
describe('bytecode precompilation', () => {
  // --- compile() ---

  it('should compile a script to bytecode buffer', () => {
    const lua = new lua_native.init();
    const bytecode = lua.compile('return 42');
    expect(bytecode).toBeInstanceOf(Buffer);
    expect(bytecode.length).toBeGreaterThan(0);
  });

  it('should throw on syntax error in compile', () => {
    const lua = new lua_native.init();
    expect(() => lua.compile('return +')).toThrow();
  });

  it('should support stripDebug option', () => {
    const lua = new lua_native.init();
    const full = lua.compile('local x = 1; return x');
    const stripped = lua.compile('local x = 1; return x', { stripDebug: true });
    expect(stripped.length).toBeLessThanOrEqual(full.length);
  });

  it('should support chunkName option', () => {
    const lua = new lua_native.init();
    // chunkName appears in error messages
    const bytecode = lua.compile('error("test")', { chunkName: '@my-script' });
    expect(() => lua.load_bytecode(bytecode)).toThrow(/my-script/);
  });

  // --- load_bytecode() ---

  it('should load and execute bytecode with correct result', () => {
    const lua = new lua_native.init();
    const bytecode = lua.compile('return 42');
    const result = lua.load_bytecode<number>(bytecode);
    expect(result).toBe(42);
  });

  it('should produce identical results to execute_script', () => {
    const lua = new lua_native.init({}, { libraries: 'all' });
    const source = `
      local t = {}
      for i = 1, 5 do t[i] = i * 10 end
      return t
    `;
    const direct = lua.execute_script(source);
    const bytecode = lua.compile(source);
    const loaded = lua.load_bytecode(bytecode);
    expect(loaded).toEqual(direct);
  });

  it('should return functions from bytecode', () => {
    const lua = new lua_native.init();
    const bytecode = lua.compile('return function(x) return x * 2 end');
    const fn = lua.load_bytecode<LuaFunction>(bytecode);
    expect(fn(21)).toBe(42);
  });

  it('should return multiple values from bytecode', () => {
    const lua = new lua_native.init();
    const bytecode = lua.compile('return 1, "two", true');
    const result = lua.load_bytecode<LuaValue[]>(bytecode);
    expect(result).toEqual([1, 'two', true]);
  });

  it('should throw on invalid bytecode', () => {
    const lua = new lua_native.init();
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(() => lua.load_bytecode(garbage)).toThrow();
  });

  it('should throw on empty bytecode', () => {
    const lua = new lua_native.init();
    expect(() => lua.load_bytecode(Buffer.alloc(0))).toThrow();
  });

  it('should reject raw source text in load_bytecode', () => {
    const lua = new lua_native.init();
    const source = Buffer.from('return 42');
    expect(() => lua.load_bytecode(source)).toThrow();
  });

  it('should load the same bytecode multiple times', () => {
    const lua = new lua_native.init();
    const bytecode = lua.compile('return 99');
    expect(lua.load_bytecode<number>(bytecode)).toBe(99);
    expect(lua.load_bytecode<number>(bytecode)).toBe(99);
    expect(lua.load_bytecode<number>(bytecode)).toBe(99);
  });

  it('should support custom chunk name in load_bytecode', () => {
    const lua = new lua_native.init();
    const bytecode = lua.compile('error("boom")');
    expect(() => lua.load_bytecode(bytecode, 'my-chunk')).toThrow(/my-chunk/);
  });

  it('should work with callbacks registered on the context', () => {
    const lua = new lua_native.init({ double: (x: number) => x * 2 });
    const bytecode = lua.compile('return double(21)');
    expect(lua.load_bytecode<number>(bytecode)).toBe(42);
  });

  it('should interact with globals set before loading', () => {
    const lua = new lua_native.init();
    lua.set_global('multiplier', 10);
    const bytecode = lua.compile('return multiplier * 5');
    expect(lua.load_bytecode<number>(bytecode)).toBe(50);
  });

  it('should allow bytecode compiled on one context to run on another', () => {
    const lua1 = new lua_native.init();
    const lua2 = new lua_native.init();
    const bytecode = lua1.compile('return 123');
    expect(lua2.load_bytecode<number>(bytecode)).toBe(123);
  });

  // --- compile_file() ---

  it('should compile a file to bytecode', () => {
    const lua = new lua_native.init({}, { libraries: 'all' });
    const bytecode = lua.compile_file('./tests/fixtures/return-values.lua');
    expect(bytecode).toBeInstanceOf(Buffer);
    expect(bytecode.length).toBeGreaterThan(0);
    // Loading should produce the same result as execute_file
    const fromFile = lua.execute_file('./tests/fixtures/return-values.lua');
    const lua2 = new lua_native.init({}, { libraries: 'all' });
    const fromBytecode = lua2.load_bytecode(bytecode);
    expect(fromBytecode).toEqual(fromFile);
  });

  it('should throw on nonexistent file in compile_file', () => {
    const lua = new lua_native.init();
    expect(() => lua.compile_file('./nonexistent.lua')).toThrow();
  });
});
```

### C++ Tests (`tests/cpp/lua-native-test.cpp`)

```cpp
// --- CompileScript ---

TEST(LuaRuntimeBytecode, CompileScriptReturnsBytes) {
  lua_core::LuaRuntime runtime;
  auto result = runtime.CompileScript("return 42");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(result));
  auto& bytecode = std::get<std::vector<uint8_t>>(result);
  EXPECT_GT(bytecode.size(), 0u);
}

TEST(LuaRuntimeBytecode, CompileScriptSyntaxError) {
  lua_core::LuaRuntime runtime;
  auto result = runtime.CompileScript("return +");
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, CompileScriptWithStripDebug) {
  lua_core::LuaRuntime runtime;
  auto full = runtime.CompileScript("local x = 1\nlocal y = 2\nreturn x + y");
  auto stripped = runtime.CompileScript("local x = 1\nlocal y = 2\nreturn x + y", true);
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(full));
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(stripped));
  EXPECT_LE(std::get<std::vector<uint8_t>>(stripped).size(),
            std::get<std::vector<uint8_t>>(full).size());
}

TEST(LuaRuntimeBytecode, CompileScriptWithChunkName) {
  lua_core::LuaRuntime runtime;
  auto result = runtime.CompileScript("error('test')", false, "@my-script");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(result));
  // Load and execute — error message should contain the chunk name
  auto& bytecode = std::get<std::vector<uint8_t>>(result);
  auto exec = runtime.LoadBytecode(bytecode, "@my-script");
  ASSERT_TRUE(std::holds_alternative<std::string>(exec));
  EXPECT_NE(std::get<std::string>(exec).find("my-script"), std::string::npos);
}

// --- CompileFile ---

TEST(LuaRuntimeBytecode, CompileFileReturnsBytes) {
  std::vector<std::string> libs = {"base", "string", "table", "math"};
  lua_core::LuaRuntime runtime(libs);
  auto result = runtime.CompileFile("tests/fixtures/return-values.lua");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(result));
  EXPECT_GT(std::get<std::vector<uint8_t>>(result).size(), 0u);
}

TEST(LuaRuntimeBytecode, CompileFileNonexistent) {
  lua_core::LuaRuntime runtime;
  auto result = runtime.CompileFile("nonexistent.lua");
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, CompileFileEmptyPath) {
  lua_core::LuaRuntime runtime;
  auto result = runtime.CompileFile("");
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

// --- LoadBytecode ---

TEST(LuaRuntimeBytecode, LoadBytecodeExecutesCorrectly) {
  lua_core::LuaRuntime runtime;
  auto compiled = runtime.CompileScript("return 42");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  auto result = runtime.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));
  ASSERT_TRUE(std::holds_alternative<std::vector<lua_core::LuaPtr>>(result));
  auto& values = std::get<std::vector<lua_core::LuaPtr>>(result);
  ASSERT_EQ(values.size(), 1u);
  ASSERT_TRUE(std::holds_alternative<int64_t>(values[0]->value));
  EXPECT_EQ(std::get<int64_t>(values[0]->value), 42);
}

TEST(LuaRuntimeBytecode, LoadBytecodeMatchesExecuteScript) {
  std::vector<std::string> libs = {"base", "string", "table", "math"};
  lua_core::LuaRuntime runtime1(libs);
  lua_core::LuaRuntime runtime2(libs);

  std::string source = "return 'hello', 42, true";

  auto direct = runtime1.ExecuteScript(source);
  auto compiled = runtime2.CompileScript(source);
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  auto loaded = runtime2.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));

  ASSERT_TRUE(std::holds_alternative<std::vector<lua_core::LuaPtr>>(direct));
  ASSERT_TRUE(std::holds_alternative<std::vector<lua_core::LuaPtr>>(loaded));

  auto& dv = std::get<std::vector<lua_core::LuaPtr>>(direct);
  auto& lv = std::get<std::vector<lua_core::LuaPtr>>(loaded);
  ASSERT_EQ(dv.size(), lv.size());
}

TEST(LuaRuntimeBytecode, LoadBytecodeInvalidData) {
  lua_core::LuaRuntime runtime;
  std::vector<uint8_t> garbage = {0x00, 0x01, 0x02, 0x03};
  auto result = runtime.LoadBytecode(garbage);
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, LoadBytecodeEmpty) {
  lua_core::LuaRuntime runtime;
  std::vector<uint8_t> empty;
  auto result = runtime.LoadBytecode(empty);
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, LoadBytecodeRejectSourceText) {
  lua_core::LuaRuntime runtime;
  std::string source = "return 42";
  std::vector<uint8_t> text(source.begin(), source.end());
  auto result = runtime.LoadBytecode(text);
  // Mode "b" should reject source text
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, LoadBytecodeSameBufferMultipleTimes) {
  lua_core::LuaRuntime runtime;
  auto compiled = runtime.CompileScript("return 99");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  auto& bc = std::get<std::vector<uint8_t>>(compiled);

  for (int i = 0; i < 3; ++i) {
    auto result = runtime.LoadBytecode(bc);
    ASSERT_TRUE(std::holds_alternative<std::vector<lua_core::LuaPtr>>(result));
    auto& values = std::get<std::vector<lua_core::LuaPtr>>(result);
    ASSERT_EQ(values.size(), 1u);
    EXPECT_EQ(std::get<int64_t>(values[0]->value), 99);
  }
}

TEST(LuaRuntimeBytecode, BytecodePortableBetweenStates) {
  lua_core::LuaRuntime runtime1;
  lua_core::LuaRuntime runtime2;

  auto compiled = runtime1.CompileScript("return 'hello'");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));

  auto result = runtime2.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));
  ASSERT_TRUE(std::holds_alternative<std::vector<lua_core::LuaPtr>>(result));
  auto& values = std::get<std::vector<lua_core::LuaPtr>>(result);
  ASSERT_EQ(values.size(), 1u);
  EXPECT_EQ(std::get<std::string>(values[0]->value), "hello");
}
```

---

## Usage Examples

### Basic compile and load

```typescript
const lua = new lua_native.init({}, { libraries: 'all' });

const bytecode = lua.compile('return 2 + 2');
const result = lua.load_bytecode<number>(bytecode); // 4
```

### Cache bytecode to disk

```typescript
import fs from 'fs';

const lua = new lua_native.init({}, { libraries: 'all' });

const cacheFile = './cache/init.luac';

let bytecode: Buffer;
if (fs.existsSync(cacheFile)) {
  bytecode = fs.readFileSync(cacheFile);
} else {
  bytecode = lua.compile_file('./scripts/init.lua');
  fs.mkdirSync('./cache', { recursive: true });
  fs.writeFileSync(cacheFile, bytecode);
}

lua.load_bytecode(bytecode);
```

### Compile once, run many times

```typescript
const lua = new lua_native.init({}, { libraries: 'all' });

const template = lua.compile(`
  return function(name, score)
    return string.format("Player %s scored %d points", name, score)
  end
`);

// Each load_bytecode call is faster than re-parsing the source
const format = lua.load_bytecode<LuaFunction>(template);
format('Alice', 100);  // "Player Alice scored 100 points"
format('Bob', 200);    // "Player Bob scored 200 points"
```

### Strip debug info for production

```typescript
const lua = new lua_native.init({}, { libraries: 'all' });

const devBytecode = lua.compile(source);                           // includes debug info
const prodBytecode = lua.compile(source, { stripDebug: true });    // smaller, no debug info

console.log(`Dev: ${devBytecode.length} bytes`);
console.log(`Prod: ${prodBytecode.length} bytes`);
```

### Cross-context bytecode sharing

```typescript
// Compile once
const compiler = new lua_native.init();
const bytecode = compiler.compile('return function(x) return x * x end');

// Load into multiple independent contexts
const ctx1 = new lua_native.init();
const ctx2 = new lua_native.init();

const square1 = ctx1.load_bytecode<LuaFunction>(bytecode);
const square2 = ctx2.load_bytecode<LuaFunction>(bytecode);

square1(5); // 25
square2(7); // 49
```
