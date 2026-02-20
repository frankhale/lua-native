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
| 2 | Error Stack Traces | Not started | Universal in bridges (6/7); no workaround for useful errors |
| 2 | Userdata Method Binding | Not started | Standard in bridges (6/7); no clean workaround |
| 2 | GC Control | Not started | Small scope, complements sandboxing |
| 2 | Context Reset | Not started | No workaround without re-registering everything |
| 3 | Table Reference API | Not started | Universal in bridges (7/7); workaround: `execute_script` |
| 3 | Environment Tables | Not started | Common in bridges (5/7); enables per-script sandboxing |
| 3 | Debug Hooks | Not started | Niche audience; shares `lua_sethook` with tier 1 |
| 3 | Execution Timeout (Wall Clock) | Not started | More intuitive than instruction count for users |
| 3 | State Introspection | Not started | Useful for diagnostics and monitoring |
| 3 | Reference Lifecycle Management | Not started | Prevents memory leaks in long-lived contexts |
| 4 | Dotted Path Globals | Not started | Workaround: `execute_script` |
| 4 | Shared State Between Contexts | Not started | Workaround: `set_global` on each context |
| — | ~~File Execution~~ | Completed | |
| — | ~~Selective Standard Library Loading~~ | Completed | |
| — | ~~Module / Require Integration~~ | Completed | |
| — | ~~Async / Non-Blocking Execution~~ | Completed | |
| — | ~~Bytecode Precompilation~~ | Completed | |

**Recommended implementation order:** Tier 1 features should be implemented
together as "sandboxing." Tier 2 follows naturally — error stack traces and
userdata methods are standard across Lua bridges and relatively straightforward.
Tier 3 and 4 can be driven by actual user requests.

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

## Tier 2 — Bridge Quality & Operational Control

These features are standard across Lua bridge libraries and address real gaps
in debugging, ergonomics, and operational control.

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

### Error Stack Traces

Automatically include Lua stack traces in error messages by pushing
`debug.traceback` as the message handler for `lua_pcall`:

```typescript
const lua = new lua_native.init({}, { libraries: 'all' });
lua.execute_script('function foo() error("boom") end foo()');
// Currently:  "[string \"...\"]:1: boom"
// With traces: "[string \"...\"]:1: boom\nstack traceback:\n\t[string \"...\"]:1: in function 'foo'\n\t..."
```

Currently all `lua_pcall` calls pass `0` (no message handler), so errors only
include the immediate error message with no call chain. This is the single most
requested debugging improvement across Lua bridge libraries — 6 of 7 surveyed
bridges integrate `debug.traceback` or equivalent.

**Why tier 2:** The implementation is small and low-risk. Error messages without
stack traces are a common source of frustration. No workaround exists from JS
short of wrapping every call in `xpcall` from Lua.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Before each `lua_pcall`, push `debug.traceback` (if the debug library is
  loaded) as the message handler:
  ```cpp
  int msgh = 0;
  lua_getglobal(L_, "debug");
  if (lua_istable(L_, -1)) {
    lua_getfield(L_, -1, "traceback");
    lua_remove(L_, -2);  // remove debug table
    msgh = stackBefore + 1;  // position of traceback function
    // adjust function position accordingly
  } else {
    lua_pop(L_, 1);
  }
  ```
- Pass `msgh` instead of `0` to `lua_pcall`.
- After pcall, remove the message handler from the stack.
- Apply to `ExecuteScript`, `ExecuteFile`, `CallFunction`, and
  `LoadBytecode`.

**N-API layer**: No changes needed — errors already propagate as strings.

**Types** (`types.d.ts`): No changes needed.

**Tests**:
- Execute a script that errors inside a nested function call, verify the error
  message contains "stack traceback" and line numbers.
- Verify stack traces work with `execute_file`.
- Verify that when the debug library is NOT loaded, errors still work (just
  without traces).
- Verify traces appear for errors thrown from JS callbacks called by Lua.

---

### Userdata Method Binding

Allow registering methods on userdata that are callable via Lua's `:` syntax
(`obj:method(args)`). Currently userdata only supports property access via
`__index`/`__newindex`. Method binding is the most common feature in Lua bridges
(6 of 7 surveyed libraries support it) and is the expected way to expose
object-oriented APIs to Lua.

```typescript
const player = { x: 0, y: 0, hp: 100 };

lua.set_userdata('player', player, {
  readable: true,
  writable: true,
  methods: {
    move: (self, dx, dy) => { self.x += dx; self.y += dy; },
    heal: (self, amount) => { self.hp = Math.min(100, self.hp + amount); },
    get_pos: (self) => [self.x, self.y],
  }
});

lua.execute_script(`
  player:move(10, 20)       -- calls methods.move(player, 10, 20)
  player:heal(25)
  local x, y = player:get_pos()
  print(x, y)               -- 10  20
`);
```

**Why tier 2:** Without this, exposing object methods requires either polluting
the global namespace with wrapper functions (`function player_move(p, dx, dy)`)
or round-tripping through `execute_script` to define Lua-side method tables.
Neither approach is ergonomic. Method binding on userdata is the standard
pattern that Lua developers expect.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Extend the proxy userdata metatable's `__index` metamethod to check for
  registered methods before falling back to property access:
  ```cpp
  int UserdataIndex(lua_State* L) {
    // 1. Check if key matches a registered method name
    // 2. If yes, push the method closure (which will receive self as first arg)
    // 3. If no, fall through to property getter as today
  }
  ```
- Store methods per-userdata-type as a map of name → host function, keyed by
  the userdata's reference ID or a type identifier.
- Methods receive the original JS object as the first argument (`self`),
  matching Lua's `:` call convention.

**N-API layer** (`lua-native.cpp`):
- Extend `SetUserdata` to accept an optional `methods` object in options.
- Each method value is stored as a `Napi::FunctionReference`.
- When the `__index` metamethod fires and finds a method match, push a
  C closure that calls the corresponding JS function with the userdata's
  JS object prepended as the first argument.

**Types** (`types.d.ts`):
- Extend `UserdataOptions`:
  ```typescript
  interface UserdataOptions {
    readable?: boolean;
    writable?: boolean;
    methods?: Record<string, (self: any, ...args: LuaValue[]) => LuaValue | void>;
  }
  ```

**Tests**:
- Register userdata with methods, call `obj:method()` from Lua, verify the
  method fires and receives `self`.
- Verify methods and property access coexist (read a property and call a method
  on the same userdata).
- Verify that method names don't shadow properties (or document the precedence).
- Verify error messages when calling a non-existent method.
- Test methods that return multiple values.

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

### Table Reference API

Provide a way to create, read, write, and iterate Lua tables from JS without
round-tripping through `execute_script`. This is the single most universal Lua
bridge feature — every surveyed library (7 of 7) provides some form of
host-language table manipulation. Currently, plain tables are deep-copied on
return and there is no way to hold a live reference to a plain Lua table.

```typescript
const tbl = lua.create_table();           // empty table in Lua
tbl.set('name', 'Alice');
tbl.set('scores', [95, 87, 92]);
tbl.get('name');                          // 'Alice'
tbl.length();                             // 1 (hash part) or array length
lua.set_global('player', tbl);            // push to Lua as a global

// Iterate over an existing table
const config = lua.get_global_ref('config');  // live reference, not a copy
for (const [k, v] of config.pairs()) {
  console.log(k, v);
}
config.release();                         // explicitly free the registry ref
```

**Why tier 3:** The workaround (`execute_script` for all table manipulation)
works but is verbose and incurs parsing overhead. For hot paths that frequently
read/write Lua state, a direct API is significantly faster. However, the
deep-copy approach works well enough for most use cases.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add `int CreateTable()` — creates an empty table, stores in registry, returns
  ref ID.
- Add `void TableSet(int ref, const std::string& key, const LuaPtr& value)` —
  pushes the table from registry, sets the field, pops.
- Add `LuaPtr TableGet(int ref, const std::string& key)` — pushes table, gets
  field, converts to LuaPtr.
- Add `std::vector<std::pair<LuaPtr, LuaPtr>> TablePairs(int ref)` — iterates
  `lua_next` and returns all key-value pairs.
- Add `int TableLength(int ref)` — returns `lua_rawlen`.
- Add `void ReleaseRef(int ref)` — calls `luaL_unref`.
- Add `int GetGlobalRef(const std::string& name)` — gets the global, stores in
  registry, returns ref ID.

**N-API layer** (`lua-native.cpp`):
- Expose a `LuaTableHandle` class or add methods directly to `LuaContext`:
  `create_table()`, `table_set()`, `table_get()`, `table_pairs()`,
  `table_length()`, `release_ref()`, `get_global_ref()`.

**Types** (`types.d.ts`):
- Add `LuaTableHandle` interface with `get`, `set`, `pairs`, `length`,
  `release` methods.
- Add `create_table(): LuaTableHandle` and
  `get_global_ref(name: string): LuaTableHandle` to `LuaContext`.

**Tests**:
- Create a table, set/get values, verify round-trip.
- Iterate pairs, verify all keys returned.
- Push a table ref as a global, access from Lua, verify it's the same table.
- Release a ref, verify it no longer works.
- Get a global ref, modify from JS, verify Lua sees the change.

---

### Environment Tables

Provide per-script or per-function environment isolation using Lua's `_ENV`
mechanism. This goes beyond the `libraries` preset by allowing different scripts
within the same context to have different sets of available globals.

```typescript
const lua = new lua_native.init({}, { libraries: 'safe' });

// Create a restricted environment with only math and print
const env = lua.create_environment({ whitelist: ['math', 'print'] });

// Execute in the restricted environment — cannot access string, table, etc.
lua.execute_script_in(env, `
  print(math.sqrt(16))      -- works: 4
  print(string.rep('x', 3)) -- error: 'string' is nil
`);
```

5 of 7 surveyed bridges support environment manipulation. This is particularly
valuable for multi-tenant sandboxing where different scripts need different
permission levels within the same Lua state.

**Why tier 3:** The `libraries` option covers the common case (one permission
level per context). Per-script environments add flexibility but require creating
separate contexts as a workaround. The implementation is moderately complex —
`_ENV` in Lua 5.4+ requires setting the first upvalue of a loaded chunk.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add `int CreateEnvironment(const std::vector<std::string>& whitelist)`:
  - Create a new table.
  - Copy whitelisted globals from the current state.
  - Set the table's `__index` to itself (or optionally to `_G` for fallback).
  - Store in registry, return ref ID.
- Add `ScriptResult ExecuteInEnvironment(int envRef, const std::string& script)`:
  - Load the chunk with `luaL_loadstring`.
  - Push the environment table from registry.
  - Set it as the first upvalue: `lua_setupvalue(L_, -2, 1)` (upvalue 1 of a
    loaded chunk is `_ENV`).
  - Call with `lua_pcall`.

**N-API layer** (`lua-native.cpp`):
- Add `create_environment(options)` and `execute_script_in(env, script)`.

**Types** (`types.d.ts`):
- Add `LuaEnvironment` opaque type.
- Add `EnvironmentOptions` with `whitelist?: string[]` and
  `inherit?: boolean` (whether unlisted globals fall through to `_G`).
- Add `create_environment(options: EnvironmentOptions): LuaEnvironment`.
- Add `execute_script_in(env: LuaEnvironment, script: string): LuaValue`.

**Tests**:
- Create an environment with only `math`, execute `math.sqrt(4)`, verify success.
- In the same environment, attempt `io.open(...)`, verify it errors.
- Verify the main context's globals are unaffected by the environment.
- Test with `inherit: true` — unlisted globals should be readable.

---

### Reference Lifecycle Management

Provide explicit control over registry references to prevent memory leaks in
long-lived contexts. When Lua functions, coroutines, or metatabled tables are
returned to JS, they are stored in the Lua registry via `luaL_ref`. Without
explicit release, these references accumulate indefinitely.

```typescript
const fn = lua.execute_script<LuaFunction>('return function(x) return x * 2 end');
fn(21);  // 42

// When done with the function, release the registry reference
lua.release(fn);

// Attempting to call after release throws
fn(21);  // Error: reference has been released
```

6 of 7 surveyed bridges provide some form of reference lifecycle management
(RAII, explicit release, or scope-based cleanup).

**Why tier 3:** Only matters for long-lived contexts that create many
function/table references over time. Context Reset (tier 2) is the nuclear
option. Most short-lived use cases never accumulate enough references to matter.

#### Implementation Plan

**Core layer** (`lua-runtime.h/.cpp`):
- Add `void ReleaseRef(int ref)` — calls `luaL_unref(L_, LUA_REGISTRYINDEX, ref)`.
- Track live reference IDs to prevent double-free.

**N-API layer** (`lua-native.cpp`):
- Add `release(value)` to `LuaContext`. Accepts any value that holds a registry
  reference (LuaFunction, LuaCoroutine, LuaTableRef).
- Extract the ref ID from the JS object and call `ReleaseRef`.
- Mark the JS wrapper as released so subsequent use throws a clear error.

**Types** (`types.d.ts`):
- Add `release(value: LuaFunction | LuaCoroutine | LuaTableRef): void` to
  `LuaContext`.

**Tests**:
- Create a function ref, release it, verify calling it throws.
- Create many refs in a loop, release them, verify `gc('count')` decreases.
- Double-release should not crash (no-op or warning).
- Release a coroutine, verify resuming it throws.

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
