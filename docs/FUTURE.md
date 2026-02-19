# Future Feature Considerations

Potential enhancements for lua-native, organized by priority.

## Priority Assessment

Features are grouped into tiers based on impact and the availability of
workarounds. The guiding principle: features that protect against unrecoverable
problems (OOM, infinite loops) rank highest; features with trivial JS-side
workarounds rank lowest.

| Tier | Feature | Status | Rationale |
|---|---|---|---|
| 1 | Memory Limits | Not started | No workaround — a script can OOM the process |
| 1 | Execution Time Limits | Not started | No workaround — an infinite loop hangs the process |
| 2 | GC Control | Not started | Small scope, complements sandboxing |
| 2 | Context Reset | Not started | No workaround without re-registering everything |
| 3 | Debug Hooks | Not started | Niche audience; shares `lua_sethook` with tier 1 |
| 3 | Execution Timeout (Wall Clock) | Not started | More intuitive than instruction count for users |
| 3 | State Introspection | Not started | Useful for diagnostics and monitoring |
| 4 | Dotted Path Globals | Not started | Workaround: `execute_script` |
| 4 | Shared State Between Contexts | Not started | Workaround: `set_global` on each context |
| — | ~~File Execution~~ | Completed | |
| — | ~~Selective Standard Library Loading~~ | Completed | |
| — | ~~Module / Require Integration~~ | Completed | |
| — | ~~Async / Non-Blocking Execution~~ | Completed | |
| — | ~~Bytecode Precompilation~~ | Completed | |

**Recommended implementation order:** Tier 1 features should be implemented
together as "sandboxing." Tier 2 follows naturally. Tier 3 and 4 can be driven
by actual user requests.

---

## Tier 1 — Sandboxing Essentials

These two features are the most important remaining work. Without them, the
`'safe'` library preset only restricts *which functions* are available — it does
nothing to prevent resource exhaustion. Together, memory limits and execution
limits make it safe to run untrusted Lua code.

### Memory Limits

Cap memory usage via `lua_setallocf` with a custom allocator that tracks and limits total allocation:

```typescript
const lua = new lua_native.init({}, {
  maxMemory: 10 * 1024 * 1024  // 10 MB
});
```

Prevents a Lua script from consuming unbounded memory. The custom allocator wraps the default allocator, tracking cumulative bytes and returning `NULL` when the limit is exceeded (which Lua handles gracefully as an out-of-memory error).

**Why tier 1:** There is no workaround from JavaScript. A single `string.rep('x', 1e9)` in Lua can crash the host process. This is the single most important missing feature for anyone running user-provided scripts.

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

**Why tier 1:** There is no workaround from JavaScript. `while true do end` will hang the process (or permanently block a worker thread in async mode). This is the second half of sandboxing — memory limits prevent resource exhaustion, instruction limits prevent runaway execution.

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

## Tier 2 — Operational Control

### GC Control

Expose `lua_gc` to trigger or configure Lua's garbage collector from JS:

```typescript
lua.gc('collect');           // Full GC cycle
lua.gc('stop');              // Pause GC
lua.gc('restart');           // Resume GC
const kb = lua.gc('count');  // Current memory usage
```

Useful for performance tuning — e.g., pausing GC during a batch of operations, then collecting afterward. Pairs well with memory limits: users who care about memory will want `gc('count')` for monitoring and `gc('collect')` for deterministic cleanup.

**Why tier 2:** Not critical — Lua's GC works fine automatically. But the implementation is small, low-risk, and fills a natural gap alongside memory limits.

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

### Context Reset

Destroy and recreate the Lua state without creating a new `LuaContext`. Useful
for long-lived server processes that execute many scripts over time.

```typescript
const lua = new lua_native.init({ log: console.log }, { libraries: 'safe' });

lua.execute_script('x = expensive_computation()');
lua.reset(); // fresh state — same callbacks, same options, clean globals

lua.execute_script('print(x)'); // nil — state was reset
```

Without this, the only way to get a clean state is to create a new `LuaContext`,
which means re-registering all callbacks, modules, search paths, and userdata.

**Why tier 2:** For short-lived scripts this doesn't matter. For server-like use
cases (e.g., a Lua sandbox service), global state accumulation is a real problem
with no easy workaround.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add `void Reset()` that calls `lua_close(L_)`, creates a new state with the
  same library configuration, and re-runs `InitState()`.
- Store the library list from construction so it can be replayed.
- Clear `host_functions_` and `stored_function_data_` before closing.

**N-API layer** (`lua-native.cpp`):
- Add `Napi::Value Reset(const Napi::CallbackInfo& info)` to `LuaContext`.
- After resetting the runtime, re-register all JS callbacks and re-apply
  userdata, modules, and search paths from stored state.
- Alternatively, only re-register callbacks (the simpler approach) and document
  that modules/search paths/userdata need to be re-added manually.

**Types** (`types.d.ts`):
- Add `reset(): void` to `LuaContext`.

**Tests**:
- Set a global, reset, verify the global is gone.
- Register a callback, reset, verify the callback still works.
- Verify reset during async throws an error.

---

## Tier 3 — Developer Tooling

### Debug Hooks

Expose `lua_sethook` for line/call/return tracing from JS:

```typescript
lua.set_hook((event, line) => {
  console.log(`${event} at line ${line}`);
}, { call: true, line: true });

lua.execute_script(myScript);
lua.remove_hook();
```

Useful for profiling Lua scripts or building debugger integrations. The hook fires on each line/call/return and reports to a JS callback.

**Why tier 3:** Niche audience — only useful for people building Lua debugging or profiling tools on top of this library. However, the implementation shares `lua_sethook` infrastructure with execution time limits. If both features are active, combine the hook masks and dispatch accordingly. Consider implementing alongside tier 1 to avoid rework.

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

### Execution Timeout (Wall Clock)

The instruction limit from tier 1 is approximate — different instructions take
different amounts of real time. A wall-clock timeout is more intuitive:

```typescript
const lua = new lua_native.init({}, {
  timeout: 5000  // 5 seconds
});
```

Can be implemented alongside instruction limits using `LUA_MASKCOUNT` with a
time check inside the hook. The hook fires every N instructions and compares
`std::chrono::steady_clock::now()` against a deadline set before each execution.

**Why tier 3:** Instruction limits already solve the core problem (preventing
hangs). Wall-clock timeouts add user-friendliness but aren't strictly necessary.
The instruction limit approach is also more deterministic and testable.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add members:
  ```cpp
  std::chrono::milliseconds timeout_{0};  // 0 = no timeout
  std::chrono::steady_clock::time_point deadline_;
  ```
- In the hook function (shared with instruction limits), check if
  `steady_clock::now() > deadline_`. If so, `luaL_error(L, "execution timeout")`.
- Set `deadline_` before each `lua_pcall`: `deadline_ = now() + timeout_`.
- The hook interval should be frequent enough for reasonable granularity (e.g.,
  every 1000 instructions) but not so frequent that the time check dominates.

**N-API layer** (`lua-native.h/.cpp`):
- Read `options.timeout` (number, milliseconds) in the `LuaContext` constructor.

**Types** (`types.d.ts`):
- Add `timeout?: number` to `LuaInitOptions`.

**Tests**:
- Run a slow script with a 100ms timeout, verify it throws within a reasonable window.
- Verify fast scripts complete normally.
- Verify timeout works with async execution.

---

### State Introspection

Expose Lua version, memory usage, and basic state information for diagnostics
and monitoring:

```typescript
lua.info();
// { version: 'Lua 5.5', memoryKB: 142 }
```

**Why tier 3:** Useful for production monitoring but not essential. Memory usage
overlaps with `gc('count')` and `get_memory_usage()`. The Lua version is a
build-time constant. Low implementation effort.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add `std::string GetVersion() const` — returns `LUA_VERSION` macro.
- Memory usage is already available via `gc('count')` or the custom allocator.

**N-API layer** (`lua-native.cpp`):
- Add `Napi::Value Info(const Napi::CallbackInfo& info)` returning an object.

**Types** (`types.d.ts`):
- Add `info(): { version: string, memoryKB: number }` to `LuaContext`.

---

## Tier 4 — Defer or Skip

These features have straightforward JS-side workarounds. Implement only if users
specifically request them.

### Dotted Path Globals

Access nested table fields from JS without round-tripping through `execute_script`:

```typescript
lua.set_global('config.db.host', 'localhost');
const host = lua.get_global('config.db.host');
```

**Workaround:** `lua.execute_script("config.db.host = 'localhost'")` — trivial,
one line, no limitation. The convenience gain doesn't justify the implementation
complexity (parsing dot paths, handling missing intermediate tables, deciding
whether to auto-create vs error).

---

### Shared State Between Contexts

Currently each `new lua_native.init()` is fully isolated. Allow multiple contexts to share specific tables or values:

```typescript
const shared = lua_native.createSharedTable({ config: { debug: true } });
const lua1 = new lua_native.init({}, { shared: { settings: shared } });
const lua2 = new lua_native.init({}, { shared: { settings: shared } });
// Both contexts see the same 'settings' table
```

**Workaround:** Call `set_global()` on each context with the same JS object.
This is fundamentally what the "shared" implementation would do internally
anyway — Lua states cannot share memory. The "shared" abstraction is just
copy-and-sync with extra API surface.

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

---

## Completed

### ~~File Execution~~ (Completed)

Implemented. See `execute_file()` in the API documentation.

### ~~Selective Standard Library Loading~~ (Completed)

Implemented. See the `libraries` option in `LuaInitOptions` and the API documentation.

### ~~Module / Require Integration~~ (Completed)

Implemented. See `add_search_path()` and `register_module()` in the API documentation.

### ~~Async / Non-Blocking Execution~~ (Completed)

Implemented. See `execute_script_async()` and `execute_file_async()` in the API documentation.

### ~~Bytecode Precompilation~~ (Completed)

Implemented. See `compile()`, `compile_file()`, and `load_bytecode()` in the API documentation.
