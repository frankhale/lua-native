# Future Feature Considerations

Potential enhancements for lua-native, organized by priority.

---

## High Value

### File Execution

Execute Lua files directly via `luaL_dofile` / `luaL_loadfile` instead of requiring scripts to be passed as strings.

```typescript
lua.execute_file('./scripts/init.lua');
```

Straightforward to implement — mirror `ExecuteScript` but use `luaL_loadfile` instead of `luaL_loadstring`.

### Selective Standard Library Loading

The core layer already has an `openStdLibs` boolean, but it's all-or-nothing and not exposed to JS. Allow users to choose which standard libraries are available:

```typescript
const lua = new lua_native.init({}, {
  libraries: ['string', 'table', 'math']  // no io, os, debug
});
```

Important for sandboxing untrusted scripts. Lua provides individual loader functions (`luaopen_string`, `luaopen_math`, etc.) that can be called selectively instead of `luaL_openlibs`.

### Memory Limits

Cap memory usage via `lua_setallocf` with a custom allocator that tracks and limits total allocation:

```typescript
const lua = new lua_native.init({}, {
  maxMemory: 10 * 1024 * 1024  // 10 MB
});
```

Prevents a Lua script from consuming unbounded memory. The custom allocator wraps the default allocator, tracking cumulative bytes and returning `NULL` when the limit is exceeded (which Lua handles gracefully as an out-of-memory error).

### Execution Time Limits

Use `lua_sethook` with `LUA_MASKCOUNT` to limit the number of instructions a script can execute:

```typescript
const lua = new lua_native.init({}, {
  maxInstructions: 1_000_000
});
```

Prevents infinite loops from hanging the process. The hook function checks the instruction count and calls `luaL_error` to abort execution when the limit is reached. Could also support a timeout-based approach using wall clock time in the hook.

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

### Async / Non-Blocking Execution

All Lua execution currently blocks the Node.js event loop. For long-running scripts, an async variant using a worker thread would be useful:

```typescript
const result = await lua.execute_script_async('return expensive_computation()');
```

This would require running the Lua state on a separate thread (via `Napi::AsyncWorker` or Node.js worker threads) and marshalling results back. Adds significant complexity around thread safety since `lua_State` is not thread-safe.

### GC Control

Expose `lua_gc` to trigger or configure Lua's garbage collector from JS:

```typescript
lua.gc('collect');           // Full GC cycle
lua.gc('stop');              // Pause GC
lua.gc('restart');           // Resume GC
const kb = lua.gc('count');  // Current memory usage
```

Useful for performance tuning — e.g., pausing GC during a batch of operations, then collecting afterward.

### Bytecode Precompilation

Compile Lua scripts to bytecode with `luaL_dump` and load them with `lua_load`:

```typescript
const bytecode = lua.compile('return function(x) return x * 2 end');
// bytecode is a Buffer — can be cached to disk

const fn = lua.load(bytecode);
fn(21); // 42
```

Faster startup for frequently-used scripts. Skips the parsing/compilation step on subsequent loads.

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

### Shared State Between Contexts

Currently each `new lua_native.init()` is fully isolated. Allow multiple contexts to share specific tables or values:

```typescript
const shared = lua_native.createSharedTable({ config: { debug: true } });
const lua1 = new lua_native.init({}, { shared: { settings: shared } });
const lua2 = new lua_native.init({}, { shared: { settings: shared } });
// Both contexts see the same 'settings' table
```

Complex to implement safely since Lua states are independent. Would likely require a shared registry or cross-state value copying with change notification.
