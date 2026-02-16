# Future Feature Considerations

Potential enhancements for lua-native, organized by priority.

---

## High Value

### ~~File Execution~~ (Completed)

Implemented. See `execute_file()` in the API documentation.

---

### ~~Selective Standard Library Loading~~ (Completed)

Implemented. See the `libraries` option in `LuaInitOptions` and the API documentation.

---

### Memory Limits

Cap memory usage via `lua_setallocf` with a custom allocator that tracks and limits total allocation:

```typescript
const lua = new lua_native.init({}, {
  maxMemory: 10 * 1024 * 1024  // 10 MB
});
```

Prevents a Lua script from consuming unbounded memory. The custom allocator wraps the default allocator, tracking cumulative bytes and returning `NULL` when the limit is exceeded (which Lua handles gracefully as an out-of-memory error).

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add a `MemoryAllocator` struct stored as a member of `LuaRuntime`:
  ```cpp
  struct MemoryAllocator {
    size_t current = 0;
    size_t limit = 0;  // 0 = unlimited
  };
  ```
- Add a static allocator function matching the `lua_Alloc` signature:
  ```cpp
  static void* LuaAllocator(void* ud, void* ptr, size_t osize, size_t nsize);
  ```
  Logic: if `nsize == 0`, free and subtract `osize`. Otherwise, check if `current - osize + nsize > limit`; if so return `NULL`. Otherwise, realloc, update `current`, and return the pointer.
- When `maxMemory > 0`, call `lua_setallocf(L_, LuaAllocator, &allocator_)` after creating the state. Note: `lua_newstate` can be used instead of `luaL_newstate` to set the allocator from the start.
- Add a getter: `size_t GetMemoryUsage() const` that returns `allocator_.current`.
- Add a new constructor overload or configuration method: `void SetMemoryLimit(size_t bytes)`.

**N-API layer** (`lua-native.h/.cpp`):
- Read `options.maxMemory` (number) in the `LuaContext` constructor and pass to `LuaRuntime`.
- Optionally expose `get_memory_usage()` as an instance method for diagnostics.

**Types** (`types.d.ts`):
- Add `maxMemory?: number` to `LuaInitOptions`.
- Add `get_memory_usage(): number` to `LuaContext`.

**Tests**:
- Allocate a large string in Lua (`string.rep('x', 20*1024*1024)`) with a 10MB limit, verify it throws an out-of-memory error.
- Verify normal scripts work within the memory limit.
- Verify `get_memory_usage()` returns a reasonable value.
- C++ tests: Verify the allocator tracks correctly across alloc/realloc/free cycles.

---

### Execution Time Limits

Use `lua_sethook` with `LUA_MASKCOUNT` to limit the number of instructions a script can execute:

```typescript
const lua = new lua_native.init({}, {
  maxInstructions: 1_000_000
});
```

Prevents infinite loops from hanging the process. The hook function checks the instruction count and calls `luaL_error` to abort execution when the limit is reached. Could also support a timeout-based approach using wall clock time in the hook.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add members to `LuaRuntime`:
  ```cpp
  size_t max_instructions_ = 0;       // 0 = unlimited
  size_t instruction_count_ = 0;
  ```
- Add a static hook function:
  ```cpp
  static void InstructionCountHook(lua_State* L, lua_Debug* ar);
  ```
  Implementation: retrieve the `LuaRuntime*` from the registry, increment `instruction_count_`, and if it exceeds `max_instructions_`, call `luaL_error(L, "instruction limit exceeded")`.
- Install the hook in `ExecuteScript`/`ExecuteFile` before `lua_pcall`: `lua_sethook(L_, InstructionCountHook, LUA_MASKCOUNT, checkInterval)` where `checkInterval` is a reasonable granularity (e.g., every 1000 instructions to minimize overhead). Reset `instruction_count_` to 0 before each execution. Remove the hook after pcall completes.
- Alternatively, set the hook once during construction if `maxInstructions > 0` and reset the counter before each `ExecuteScript`/`CallFunction`/`ResumeCoroutine` call.
- Add `void SetMaxInstructions(size_t limit)` to configure post-construction.

**N-API layer** (`lua-native.h/.cpp`):
- Read `options.maxInstructions` (number) in the `LuaContext` constructor and pass to `LuaRuntime`.

**Types** (`types.d.ts`):
- Add `maxInstructions?: number` to `LuaInitOptions`.

**Tests**:
- Execute `while true do end` with `maxInstructions: 100000`, verify it throws "instruction limit exceeded" rather than hanging.
- Execute a normal script, verify it completes without hitting the limit.
- Verify the counter resets between `execute_script` calls (one long script shouldn't affect the next).
- Test with coroutines to ensure the hook persists across resume calls.

---

## Medium Value

### Module / Require Integration

Register custom `package.searchers` so Lua's `require()` can resolve modules from JS-provided paths or load JS-defined modules:

```typescript
lua.addSearchPath('./lua_modules/?.lua');

// Or register a JS object as a Lua module
lua.registerModule('utils', {
  clamp: (x, min, max) => Math.min(Math.max(x, min), max),
});
// Lua: local utils = require('utils'); utils.clamp(5, 0, 10)
```

Important for larger Lua projects with multiple files and dependencies.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- `AddSearchPath(const std::string& path)`: Append to `package.path` via:
  ```cpp
  lua_getglobal(L_, "package");
  lua_getfield(L_, -1, "path");
  std::string current = lua_tostring(L_, -1);
  current += ";" + path;
  lua_pop(L_, 1);
  lua_pushstring(L_, current.c_str());
  lua_setfield(L_, -2, "path");
  lua_pop(L_, 1);
  ```
- `RegisterModule(const std::string& name, const LuaPtr& value)`: Pre-load a module into `package.loaded` so `require(name)` returns it without searching:
  ```cpp
  lua_getglobal(L_, "package");
  lua_getfield(L_, -1, "loaded");
  PushLuaValue(L_, value);
  lua_setfield(L_, -2, name.c_str());
  lua_pop(L_, 2);
  ```
- Both methods require the `package` library to be loaded. Throw if it's not available.

**N-API layer** (`lua-native.h/.cpp`):
- Add `Napi::Value AddSearchPath(const Napi::CallbackInfo& info)` — accepts a string.
- Add `Napi::Value RegisterModule(const Napi::CallbackInfo& info)` — accepts a name (string) and value (object/table). Convert the JS object to a `LuaValue` via `NapiToCoreInstance` and pass to the core layer. For function values in the module table, register them as host functions (similar to `RegisterCallbacks`).
- Register both as instance methods in `Init`.

**Types** (`types.d.ts`):
- Add `add_search_path(path: string): void` and `register_module(name: string, module: LuaTable | LuaCallbacks): void` to `LuaContext`.

**Tests**:
- Create a temp `.lua` module file, add its directory as a search path, verify `require('modname')` loads it.
- Register a JS module with functions, verify `require('modname').fn()` works from Lua.
- Verify requiring an unknown module still errors.

**Depends on**: Selective Standard Library Loading (the `package` library must be loaded).

---

### Async / Non-Blocking Execution

All Lua execution currently blocks the Node.js event loop. For long-running scripts, an async variant using a worker thread would be useful:

```typescript
const result = await lua.execute_script_async('return expensive_computation()');
```

This would require running the Lua state on a separate thread (via `Napi::AsyncWorker` or Node.js worker threads) and marshalling results back. Adds significant complexity around thread safety since `lua_State` is not thread-safe.

#### Implementation Plan

**Approach**: Use `Napi::AsyncWorker` to run Lua execution on the libuv thread pool. The key constraint is that `lua_State` is not thread-safe, so only one operation can use it at a time.

**Core layer** (`lua-runtime.h/.cpp`):
- No changes needed. `ExecuteScript` and `CallFunction` are already pure C++ functions that don't touch N-API. They can be called from any thread as long as access to `lua_State` is serialized.

**N-API layer** — new file `lua-async-worker.h`:
- Create a `LuaAsyncWorker` class extending `Napi::AsyncWorker`:
  ```cpp
  class LuaAsyncWorker : public Napi::AsyncWorker {
    std::shared_ptr<LuaRuntime> runtime_;
    std::string script_;
    lua_core::ScriptResult result_;
  public:
    void Execute() override {
      result_ = runtime_->ExecuteScript(script_);
    }
    void OnOK() override {
      // Convert result_ to Napi values via Deferred
    }
    void OnError(const Napi::Error& error) override {
      // Reject the promise
    }
  };
  ```
- Use `Napi::Promise::Deferred` to return a Promise to JS.
- Add a mutex to `LuaRuntime` (or `LuaContext`) to prevent concurrent access. The async worker acquires the lock in `Execute()` and releases it when done.

**N-API layer** (`lua-native.cpp`):
- Add `Napi::Value ExecuteScriptAsync(const Napi::CallbackInfo& info)` to `LuaContext`.
- Register as `InstanceMethod("execute_script_async", ...)`.

**Types** (`types.d.ts`):
- Add `execute_script_async<T extends LuaValue | LuaValue[] = LuaValue>(script: string): Promise<T>` to `LuaContext`.

**Risks / considerations**:
- JS callbacks registered with the Lua state cannot be called from the worker thread (N-API calls must happen on the main thread). Scripts using JS callbacks will need to run synchronously or use `Napi::ThreadSafeFunction`.
- For full callback support in async mode, wrap each JS callback in a `Napi::ThreadSafeFunction` and call it via `BlockingCall` from the worker thread.
- Consider a simpler initial version that disallows JS callbacks in async mode and throws if the script calls one.

**Tests**:
- Verify `execute_script_async` returns a Promise that resolves with the correct value.
- Verify errors reject the Promise.
- Verify multiple async calls serialize correctly (don't corrupt state).
- Verify that sync and async calls on the same context don't interleave.

---

### GC Control

Expose `lua_gc` to trigger or configure Lua's garbage collector from JS:

```typescript
lua.gc('collect');           // Full GC cycle
lua.gc('stop');              // Pause GC
lua.gc('restart');           // Resume GC
const kb = lua.gc('count');  // Current memory usage
```

Useful for performance tuning — e.g., pausing GC during a batch of operations, then collecting afterward.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add `GarbageCollect(const std::string& command)` returning a `std::variant<int, double, std::monostate>`:
  ```cpp
  if (command == "collect")  { lua_gc(L_, LUA_GCCOLLECT); return std::monostate{}; }
  if (command == "stop")     { lua_gc(L_, LUA_GCSTOP);    return std::monostate{}; }
  if (command == "restart")  { lua_gc(L_, LUA_GCRESTART); return std::monostate{}; }
  if (command == "count")    { return lua_gc(L_, LUA_GCCOUNT) + lua_gc(L_, LUA_GCCOUNTB) / 1024.0; }
  if (command == "step")     { lua_gc(L_, LUA_GCSTEP, 0); return std::monostate{}; }
  ```
- Alternatively, return a `LuaPtr` to keep it consistent with the rest of the API.

**N-API layer** (`lua-native.cpp`):
- Add `Napi::Value GC(const Napi::CallbackInfo& info)` to `LuaContext`.
- Accept a string argument, call `runtime->GarbageCollect(cmd)`, return a number for "count" or undefined otherwise.
- Register as `InstanceMethod("gc", &LuaContext::GC)`.

**Types** (`types.d.ts`):
- Add `gc(command: 'collect' | 'stop' | 'restart' | 'count' | 'step'): number | void` to `LuaContext`.

**Tests**:
- Call `gc('count')` and verify it returns a positive number.
- Call `gc('collect')` and verify it doesn't throw.
- Create a large table, release it, call `gc('collect')`, verify `gc('count')` decreased.
- Call `gc('stop')`, allocate, verify count doesn't decrease until `gc('restart')` + `gc('collect')`.

---

### Bytecode Precompilation

Compile Lua scripts to bytecode with `luaL_dump` and load them with `lua_load`:

```typescript
const bytecode = lua.compile('return function(x) return x * 2 end');
// bytecode is a Buffer — can be cached to disk

const fn = lua.load(bytecode);
fn(21); // 42
```

Faster startup for frequently-used scripts. Skips the parsing/compilation step on subsequent loads.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- `CompileScript(const std::string& script)` returning `std::variant<std::vector<uint8_t>, std::string>`:
  ```cpp
  if (luaL_loadstring(L_, script.c_str()) != LUA_OK) {
    std::string err = lua_tostring(L_, -1);
    lua_pop(L_, 1);
    return err;
  }
  std::vector<uint8_t> bytecode;
  lua_dump(L_, [](lua_State*, const void* p, size_t sz, void* ud) -> int {
    auto* bc = static_cast<std::vector<uint8_t>*>(ud);
    auto* bytes = static_cast<const uint8_t*>(p);
    bc->insert(bc->end(), bytes, bytes + sz);
    return 0;
  }, &bytecode, 0);
  lua_pop(L_, 1);  // pop the compiled function
  return bytecode;
  ```
- `LoadBytecode(const std::vector<uint8_t>& bytecode)` returning `ScriptResult`:
  ```cpp
  if (lua_load(L_, [](lua_State*, void* ud, size_t* sz) -> const char* {
    auto* data = static_cast<BytecodeReader*>(ud);
    if (data->consumed) { *sz = 0; return nullptr; }
    *sz = data->bytes.size();
    data->consumed = true;
    return reinterpret_cast<const char*>(data->bytes.data());
  }, &reader, "bytecode", nullptr) != LUA_OK) { ... }
  // Then lua_pcall and collect results like ExecuteScript
  ```

**N-API layer** (`lua-native.cpp`):
- `Napi::Value Compile(const Napi::CallbackInfo& info)` — takes a script string, returns a `Napi::Buffer<uint8_t>`.
- `Napi::Value Load(const Napi::CallbackInfo& info)` — takes a `Buffer`, calls `LoadBytecode`, returns results.
- Register both as instance methods.

**Types** (`types.d.ts`):
- Add `compile(script: string): Buffer` and `load<T extends LuaValue | LuaValue[] = LuaValue>(bytecode: Buffer): T` to `LuaContext`.

**Tests**:
- Compile a script, load the bytecode, verify the result matches direct execution.
- Verify that invalid bytecode returns a descriptive error.
- Verify compiled bytecode can be loaded multiple times.
- Benchmark: compare execution time of `load(bytecode)` vs `execute_script(source)` for a non-trivial script.

---

## Lower Priority

### Debug Hooks

Expose `lua_sethook` for line/call/return tracing from JS:

```typescript
lua.setHook((event, line) => {
  console.log(`${event} at line ${line}`);
}, { call: true, line: true });

lua.execute_script(myScript);
lua.removeHook();
```

Useful for profiling Lua scripts or building debugger integrations. The hook fires on each line/call/return and reports to a JS callback.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add a `DebugHookCallback` type alias:
  ```cpp
  using DebugHookCallback = std::function<void(const std::string& event, int line, const std::string& name)>;
  ```
- Add members: `DebugHookCallback debug_hook_` and `int hook_mask_ = 0`.
- Add `SetDebugHook(DebugHookCallback cb, int mask)` — stores the callback and calls `lua_sethook(L_, DebugHookDispatch, mask, 0)`.
- Add `RemoveDebugHook()` — calls `lua_sethook(L_, nullptr, 0, 0)` and clears the callback.
- Static `DebugHookDispatch(lua_State* L, lua_Debug* ar)`:
  ```cpp
  lua_getinfo(L, "nSl", ar);
  // Retrieve runtime from registry, call debug_hook_ with event type, line, name
  ```
- Map `ar->event` to strings: `LUA_HOOKCALL` → "call", `LUA_HOOKRET` → "return", `LUA_HOOKLINE` → "line", `LUA_HOOKCOUNT` → "count".

**N-API layer** (`lua-native.cpp`):
- `Napi::Value SetHook(const Napi::CallbackInfo& info)` — accepts a JS callback and an options object `{ call?: bool, line?: bool, return?: bool, count?: number }`.
- Store the JS callback as a `Napi::FunctionReference`. Build the mask from options: `LUA_MASKCALL | LUA_MASKLINE | LUA_MASKRET | LUA_MASKCOUNT`.
- The core callback calls the JS function reference. Since hooks fire synchronously during Lua execution (which runs on the main thread), this is safe.
- `Napi::Value RemoveHook(const Napi::CallbackInfo& info)` — calls `runtime->RemoveDebugHook()` and releases the JS callback reference.

**Types** (`types.d.ts`):
- Add `HookOptions` interface and `set_hook(callback: (event: string, line: number, name: string) => void, options: HookOptions): void`.
- Add `remove_hook(): void`.

**Tests**:
- Set a line hook, execute a multi-line script, verify the callback fires with correct line numbers.
- Set a call hook, call a function, verify "call" and "return" events fire.
- Verify `remove_hook()` stops further callbacks.
- Verify hooks don't interfere with normal execution results.

**Shares infrastructure with**: Execution Time Limits (both use `lua_sethook`). If both are active, combine masks: the hook function checks which features are enabled and dispatches accordingly.

---

### Shared State Between Contexts

Currently each `new lua_native.init()` is fully isolated. Allow multiple contexts to share specific tables or values:

```typescript
const shared = lua_native.createSharedTable({ config: { debug: true } });
const lua1 = new lua_native.init({}, { shared: { settings: shared } });
const lua2 = new lua_native.init({}, { shared: { settings: shared } });
// Both contexts see the same 'settings' table
```

Complex to implement safely since Lua states are independent. Would likely require a shared registry or cross-state value copying with change notification.

#### Implementation Plan

**Approach**: Use a JS-side shared object with Proxy-based change propagation. Each Lua context gets its own copy of the shared table, but mutations are synchronized through a JS-side coordinator.

**Core layer**: No changes needed. Each `LuaRuntime` remains independent.

**N-API layer** — new class `SharedTable`:
- `SharedTable` is a plain JS object that tracks which `LuaContext` instances are subscribed.
- On construction, it deep-copies the initial value and stores it.
- Each subscribing `LuaContext` gets the value set as a global via `set_global`.
- Mutations go through a `set(key, value)` method on `SharedTable` that:
  1. Updates the internal JS value.
  2. Iterates all subscribed contexts and calls `runtime->SetGlobal(path, newValue)` to push the update.
- Alternatively, use a JS Proxy on the shared object that intercepts `set` and propagates changes.

**Simpler alternative**: A `SharedTable` is just a JS object. Each context's `set_global` stores a reference. When the user mutates the shared object and calls `sync()`, each context re-pushes the value. This avoids automatic propagation complexity.

**Types** (`types.d.ts`):
- Add `SharedTable` interface with `get(key: string): LuaValue`, `set(key: string, value: LuaValue): void`, `sync(): void`.
- Add `createSharedTable(initial: LuaTable): SharedTable` to `LuaNative`.
- Add `shared?: Record<string, SharedTable>` to `LuaInitOptions`.

**Tests**:
- Create a shared table, attach to two contexts, verify both see the initial value.
- Mutate via `shared.set()`, call `sync()`, verify both contexts see the update.
- Verify contexts remain independent for non-shared globals.

**Risks**: This is fundamentally a JS-level abstraction since Lua states can't share memory. The "shared" illusion is maintained by copying values, so large tables will have performance implications. Document this clearly.
