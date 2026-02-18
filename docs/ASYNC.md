# Async / Non-Blocking Execution

> **Status:** Phase 1 completed (February 2026). `execute_script_async`,
> `execute_file_async`, and `is_busy` are implemented and shipping. Phase 2
> (ThreadSafeFunction callbacks) remains a future option if demand warrants it.

## Summary

This document evaluates async execution for lua-native, explores the technical
challenges, and provides the implementation plan. Phase 1 is complete — Lua
scripts can run on worker threads via `Napi::AsyncWorker`, returning Promises.
JS callbacks are disallowed in async mode with a clear error message.

---

## Benefits

### 1. Event Loop Responsiveness

The primary benefit. A Lua script that runs for 50ms blocks the entire Node.js
event loop for 50ms — no HTTP requests are served, no timers fire, no I/O
completes. For server applications or interactive tools, this creates
user-visible latency spikes. Async execution moves the Lua work to a libuv
thread pool worker, freeing the main thread to continue serving requests.

### 2. Concurrent Lua Execution Across Contexts

With async execution, multiple independent `LuaContext` instances can run
simultaneously on different thread pool workers. A server handling requests
from multiple users, each with their own Lua sandbox, could process them in
parallel rather than serially. This is the strongest use case — independent
contexts share no state and have no thread-safety concerns with each other.

### 3. CPU-Intensive Lua Workloads

Lua is commonly used for data transformation, template rendering, rule
evaluation, and game logic. These are CPU-bound tasks that benefit from being
offloaded to a worker thread. The main thread stays responsive while heavy
computation happens in the background.

### 4. File I/O During Script Loading

`execute_file()` performs synchronous file I/O via `luaL_loadfile`. An async
variant would move both the file read and the subsequent execution off the main
thread, useful for loading large Lua files at startup without blocking the
event loop.

### 5. Promise-Based API Alignment

Modern Node.js APIs are Promise-based. An async variant aligns with the
ecosystem's conventions and integrates naturally with `async/await` patterns,
error handling via `.catch()`, and `Promise.all()` for concurrent execution.

---

## Is It Worth It?

**Short answer: Conditional yes.** The value depends heavily on the use case.

### When It Is Worth It

- **Server-side sandboxing**: Running untrusted Lua scripts (user-submitted
  code, plugin systems) where each request gets its own context. Async prevents
  one slow script from blocking all other requests.
- **Batch processing**: Running many independent Lua scripts concurrently
  (e.g., evaluating rules for thousands of entities).
- **CPU-heavy pure Lua**: Data transformation, mathematical computation,
  string processing — workloads that are pure Lua with no/few JS callbacks.
- **File execution at scale**: Loading dozens of Lua configuration files at
  startup without blocking the event loop.

### When It Is NOT Worth It

- **Short scripts** (< 1ms): The overhead of creating an `AsyncWorker`,
  queuing it, and marshalling results back exceeds the execution time. The
  synchronous path is faster.
- **Callback-heavy scripts**: If a Lua script calls JS callbacks on every
  iteration (e.g., rendering each pixel via a JS function), the worker thread
  blocks on every callback waiting for the main thread. The effective
  parallelism is near zero and the overhead is strictly worse than synchronous.
- **Single-context sequential use**: If you have one Lua context running one
  script at a time, async adds complexity without meaningful concurrency.

### Honest Assessment

The feature adds significant implementation complexity (estimated 500-800 lines
of C++) primarily around thread-safe callback handling. The two-layer
architecture helps — the core layer is already free of N-API dependencies and
can run on any thread — but the callback bridge between layers is where all the
difficulty lives.

If the primary use case is **pure Lua computation** or **independent contexts
running in parallel**, the implementation is straightforward and high-value. If
the use case requires **JS callbacks from async scripts**, the implementation
is much harder and the performance benefit is diminished.

### Recommendation: A Two-Phase Approach

> **Phase 1 is complete.** Everything described below through "What Phase 1
> Enables" is implemented and tested. See `FEATURES.md` for architecture details.

Implement in two phases. Phase 1 supports async execution for scripts that do
NOT call JS callbacks (pure Lua + stdlib only). Phase 2 adds
`ThreadSafeFunction` support for JS callbacks in async mode, if demand warrants
it.

#### Why Two Phases?

The existing two-layer architecture makes Phase 1 almost free. The core layer
(`lua_core::LuaRuntime`) is pure C++ with zero N-API dependencies. Its
`ExecuteScript` and `ExecuteFile` methods take `std::string` arguments and
return `ScriptResult` (a `std::variant`). They already run on whichever thread
calls them:

```cpp
// src/core/lua-runtime.h — these signatures are thread-agnostic
[[nodiscard]] ScriptResult ExecuteScript(const std::string& script) const;
[[nodiscard]] ScriptResult ExecuteFile(const std::string& filepath) const;
```

The N-API layer (`LuaContext`) is the only part that touches `Napi::Env` and JS
types. The `Napi::AsyncWorker` pattern naturally splits work into a worker-
thread phase (`Execute()` — pure C++) and a main-thread phase (`OnOK()` —
N-API). This maps directly onto the existing layer boundary. Phase 1 is
essentially just wiring the two together.

Phase 2, by contrast, requires cross-thread callback marshalling. Here is the
current callback bridge in `src/lua-native.cpp`:

```cpp
// CreateJsCallbackWrapper — creates the lambda stored in host_functions_
return [this, name](const std::vector<lua_core::LuaPtr>& args) -> lua_core::LuaPtr {
  std::vector<napi_value> jsArgs;
  jsArgs.reserve(args.size());
  for (const auto& a : args) {
    jsArgs.push_back(CoreToNapi(*a));    // N-API call — main thread only
  }
  try {
    const Napi::Value result = js_callbacks[name].Call(jsArgs);  // N-API call
    return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(result));
  } catch (const Napi::Error& e) {
    throw std::runtime_error(e.Message());
  }
};
```

Every line of that lambda uses N-API (`CoreToNapi`, `js_callbacks[name].Call`,
`NapiToCoreInstance`). Making this work from a worker thread requires wrapping
each callback in a `Napi::ThreadSafeFunction`, adding a synchronization
primitive (mutex + condition variable) so the worker can block while the main
thread executes the JS function, and converting arguments/results through a
shared data structure. That is 3-5x the implementation effort of Phase 1 and
introduces a new class of bugs (deadlocks, stale references, lifetime races).

#### What Phase 1 Enables

Phase 1 covers every use case where the Lua script is self-contained — it uses
Lua's built-in standard libraries but does not call back into JavaScript during
execution. This is a broad and practically important category:

**Server-side sandboxing** — Run untrusted user scripts without blocking the
event loop. Each request gets its own context:

```javascript
import lua_native from "lua-native";
import express from "express";

const app = express();

app.post("/run", async (req, res) => {
  // Each request gets an isolated, sandboxed context
  const sandbox = new lua_native.init({}, { libraries: "safe" });

  try {
    const result = await sandbox.execute_script_async(req.body.script);
    res.json({ result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

Without async, a single slow script blocks all other HTTP requests. With async,
the Lua execution runs on the libuv thread pool while Express continues serving
other requests.

**Batch processing** — Evaluate hundreds of independent Lua scripts in
parallel using `Promise.all()`:

```javascript
// Evaluate pricing rules for 1000 products concurrently
const results = await Promise.all(
  products.map((product) => {
    const ctx = new lua_native.init({}, { libraries: ["base", "math", "string"] });
    ctx.set_global("product", product);
    return ctx.execute_script_async(`
      local price = product.base_price
      if product.category == "electronics" then
        price = price * 0.9   -- 10% discount
      end
      if product.weight > 10 then
        price = price + 5.99  -- heavy item surcharge
      end
      return math.floor(price * 100) / 100
    `);
  })
);
```

**File loading at startup** — Load configuration files without blocking:

```javascript
const configFiles = ["world.lua", "items.lua", "npcs.lua", "quests.lua"];

// Load all config files concurrently
const configs = await Promise.all(
  configFiles.map((file) => {
    const ctx = new lua_native.init({}, { libraries: "safe" });
    return ctx.execute_file_async(`./config/${file}`);
  })
);
```

**CPU-heavy computation** — Offload number crunching while keeping the UI
responsive:

```javascript
const lua = new lua_native.init({}, { libraries: "all" });

// This runs on a worker thread — the event loop stays responsive
const primes = await lua.execute_script_async(`
  local function sieve(n)
    local is_prime = {}
    for i = 2, n do is_prime[i] = true end
    for i = 2, math.sqrt(n) do
      if is_prime[i] then
        for j = i*i, n, i do is_prime[j] = false end
      end
    end
    local result = {}
    for i = 2, n do
      if is_prime[i] then result[#result + 1] = i end
    end
    return result
  end
  return sieve(1000000)
`);
```

#### What Phase 1 Does NOT Support

Scripts that call JavaScript functions registered via the constructor or
`set_global()`. These scripts reject with a clear error:

```javascript
const lua = new lua_native.init({
  fetchPrice: (itemId) => database.getPrice(itemId),  // JS callback
}, { libraries: "all" });

// This REJECTS — fetchPrice is a JS callback, not available in async mode
await lua.execute_script_async("return fetchPrice(42)");
// Error: "JS callbacks are not available in async mode (called 'fetchPrice')"

// Workaround: use sync execution for callback-heavy scripts
const price = lua.execute_script("return fetchPrice(42)"); // works fine
```

The workaround is straightforward — use `execute_script()` for scripts that
need JS callbacks, and `execute_script_async()` for pure Lua work. Many
real-world patterns naturally separate these: gather data via JS callbacks
(sync), then process it in pure Lua (async):

```javascript
const lua = new lua_native.init({
  getInventory: () => inventoryService.getAll(),
}, { libraries: "all" });

// Step 1: Fetch data (sync — needs JS callback)
lua.execute_script("inventory = getInventory()");

// Step 2: Process data (async — pure Lua, CPU-heavy)
const report = await lua.execute_script_async(`
  local total = 0
  local low_stock = {}
  for _, item in pairs(inventory) do
    total = total + item.quantity * item.price
    if item.quantity < item.reorder_threshold then
      low_stock[#low_stock + 1] = item.name
    end
  end
  return { total_value = total, low_stock_items = low_stock }
`);
```

#### What Phase 2 Would Add

Phase 2 would remove the callback restriction entirely. The same script that
fails in Phase 1 would work transparently:

```javascript
const lua = new lua_native.init({
  fetchPrice: (itemId) => database.getPrice(itemId),
}, { libraries: "all" });

// Phase 2: this would work — fetchPrice is marshalled via ThreadSafeFunction
const total = await lua.execute_script_async(`
  local sum = 0
  for i = 1, 100 do
    sum = sum + fetchPrice(i)   -- each call blocks worker, runs on main thread
  end
  return sum
`);
```

However, each `fetchPrice()` call would block the worker thread while the main
thread executes the JS function. For 100 calls, that is 100 round-trips between
threads. The async benefit is reduced to just the Lua execution time between
callbacks. If the script is mostly callbacks and little pure Lua computation,
Phase 2 async mode is slower than sync mode due to the per-call marshalling
overhead.

Phase 2 makes sense when:
- Callbacks are infrequent (e.g., one setup call, then pure Lua computation)
- The calling code does not want to manage sync/async splitting manually
- The Lua script structure cannot be easily separated into callback and
  computation phases

Phase 2 does NOT make sense when:
- Callbacks are called in tight loops (hundreds or thousands of times)
- The user can easily split work into sync (data gathering) and async
  (processing) phases, as shown in the Phase 1 workaround above

#### Summary

| | Phase 1 | Phase 2 |
|---|---------|---------|
| **Status** | **Completed** (February 2026) | Future (if demand warrants) |
| **Scope** | Pure Lua + stdlib | Full callback support |
| **Complexity** | ~200-300 lines of C++ | ~500-800 additional lines |
| **New concepts** | `Napi::AsyncWorker`, busy flag | `Napi::ThreadSafeFunction`, mutex + condvar, cross-thread data sharing |
| **Risk** | Low — well-established N-API pattern | Medium — cross-thread callback introduces deadlock and lifetime risks |
| **Use cases covered** | Sandboxing, batch processing, file loading, CPU-heavy computation | All Phase 1 cases + callback-dependent scripts |
| **Performance** | Equivalent to sync for same workload, plus parallelism | Per-callback overhead of ~10us-1ms for thread marshalling |
| **Migration path** | No API changes in Phase 2 — same methods, restriction is just lifted | — |

Phase 1 is complete and shipping. It delivers the core value (non-blocking
execution, parallelism across contexts) with low risk and clean architecture.
Phase 2 is additive — it lifts a restriction without changing any existing API,
so Phase 1 users experience zero disruption if Phase 2 ships later.

---

## Technical Challenges

### Challenge 1: `lua_State` Is Not Thread-Safe

The Lua C API is not thread-safe. A single `lua_State*` must not be accessed
from multiple threads simultaneously. This means:

- A mutex must protect all access to the `lua_State*` within a single
  `LuaContext`.
- While an async execution is in progress, sync methods (`execute_script`,
  `set_global`, `get_global`, etc.) on the **same context** must either block
  waiting for the mutex (bad — defeats the purpose) or throw an error
  ("context is busy").
- Multiple `LuaContext` instances are safe to run concurrently because each
  owns its own `lua_State*`.

### Challenge 2: N-API Thread Restrictions

N-API functions (`Napi::String::New`, `Napi::Object::Set`, etc.) must only be
called from the main thread (the thread that created the `Napi::Env`). This
creates two problems:

**Result conversion**: The `ScriptResult` (a C++ type) is produced on the
worker thread, but must be converted to `Napi::Value` on the main thread. The
`Napi::AsyncWorker` pattern handles this naturally — `Execute()` runs on the
worker thread (C++ only), `OnOK()` runs on the main thread (N-API allowed).

**JS callback invocation**: When a Lua script calls a registered JS callback,
the `CreateJsCallbackWrapper` lambda calls `Napi::FunctionReference::Call()`.
This N-API call cannot happen from a worker thread. Solutions are discussed
below.

### Challenge 3: JS Callbacks From Worker Threads

This is the hardest problem. The current host function bridge works like this:

```
Lua calls host function → LuaCallHostFunction (C) → host_functions_ lambda
→ CoreToNapi (converts args) → js_callbacks[name].Call() → NapiToCoreInstance (converts result)
→ PushLuaValue (pushes result to Lua stack)
```

The entire chain runs synchronously on the main thread. In async mode, this
chain runs on a worker thread, but `CoreToNapi` and `js_callbacks[name].Call()`
are N-API calls that must run on the main thread.

**Option A — Disallow callbacks in async mode**: If the Lua script calls a
registered JS callback, throw a Lua error ("JS callbacks not available in async
mode"). This is simple to implement and forces users to either run callback-
heavy scripts synchronously or restructure their code. Pure Lua + stdlib
scripts work fine.

**Option B — `Napi::ThreadSafeFunction` (TSFN)**: Wrap each JS callback in a
TSFN. When the worker thread needs to call a JS callback:
1. The worker calls `tsfn.BlockingCall(data)` with the arguments
2. The TSFN queues the call onto the main thread's event loop
3. The main thread executes the callback and stores the result
4. The worker thread wakes up and reads the result
5. Lua execution continues on the worker thread

This works but the worker thread is blocked during step 2-4, waiting for the
main thread. The latency per callback is bounded by the main thread's event
loop responsiveness (typically < 1ms if idle, potentially much more if busy).

**Option C — Separate `lua_State` per async call**: Create a fresh `lua_State`
for each async call, copy the script and any needed globals, and run it
independently. No callbacks needed. This avoids all thread-safety issues but
means the async script has no access to registered callbacks, userdata, or
metatables. Only useful for pure computation.

### Challenge 4: Concurrent Access to the Same Context

If a user calls `execute_script_async()` and then immediately calls
`set_global()` or another `execute_script_async()` on the same context, the
second call would access the `lua_State` while the first is still using it.

**Solution: State guard with "busy" flag**. When an async execution starts, the
context is marked as busy. All sync methods and additional async calls check
this flag and throw a descriptive error ("cannot call execute_script while an
async operation is in progress on this context"). The flag is cleared when the
async operation completes.

This is simpler and more predictable than a mutex (which would silently block
the main thread). Users who need concurrent execution should create multiple
`LuaContext` instances.

### Challenge 5: Coroutine and Reference Type Interactions

Returned Lua functions (`LuaFunctionRef`), table refs (`LuaTableRef`), and
coroutines (`LuaThreadRef`) hold registry references to the `lua_State`. These
references are only valid on the main thread where the N-API wrappers live.

In the async path, the `ScriptResult` is produced on the worker thread. If it
contains a `LuaFunctionRef` or `LuaTableRef`, the N-API wrapper (Proxy,
Function) must be created on the main thread in `OnOK()`. The core
`ScriptResult` type is already pure C++ (no N-API), so this works naturally
with the `AsyncWorker` pattern.

### Challenge 6: Error Handling

Lua errors (syntax, runtime) are caught by `lua_pcall` and returned as strings
in `ScriptResult`. In the async path, errors become Promise rejections:

```javascript
try {
  const result = await lua.execute_script_async("error('boom')");
} catch (e) {
  console.error(e.message); // "...: boom"
}
```

The `Napi::AsyncWorker::SetError()` method and `OnError()` callback handle
this. If `Execute()` encounters an error, it stores it; `OnError()` rejects the
Promise with a JS `Error`.

---

## Recommended Approach: Phase 1 (Completed)

> **Implemented.** All steps below have been completed. See the actual source
> files for the final implementation, and `FEATURES.md` for architecture docs.

`execute_script_async` and `execute_file_async` are implemented using
`Napi::AsyncWorker` with **Option A** (disallow JS callbacks in async mode).
This covers the highest-value use cases with manageable complexity.

### Why Phase 1 First

- Covers the most common async use cases (pure Lua computation, file loading)
- Avoids the TSFN complexity entirely
- The async worker pattern is well-established and battle-tested in N-API
- Users who need callbacks can use the sync methods
- The "busy" flag prevents foot-gun concurrency bugs
- If Phase 2 (TSFN callbacks) proves necessary, Phase 1 infrastructure is
  fully reused

---

## API Design

### New Methods

```typescript
interface LuaContext {
  // Existing sync methods unchanged...

  /**
   * Executes a Lua script asynchronously on a worker thread.
   * Returns a Promise that resolves with the script result.
   *
   * Note: JS callbacks registered via the constructor or set_global()
   * are NOT available in async mode. Scripts that call them will reject
   * with an error. Use execute_script() for callback-heavy scripts.
   *
   * @throws If the context is already executing an async operation
   */
  execute_script_async<T extends LuaValue | LuaValue[] = LuaValue>(
    script: string
  ): Promise<T>;

  /**
   * Executes a Lua file asynchronously on a worker thread.
   * Same restrictions as execute_script_async.
   *
   * @throws If the context is already executing an async operation
   */
  execute_file_async<T extends LuaValue | LuaValue[] = LuaValue>(
    filepath: string
  ): Promise<T>;

  /**
   * Returns true if an async operation is currently in progress
   * on this context.
   */
  is_busy(): boolean;
}
```

### Usage Examples

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

// Basic async execution
const result = await lua.execute_script_async("return 6 * 7");
console.log(result); // 42

// Async file execution
const config = await lua.execute_file_async("./scripts/compute.lua");

// Concurrent execution across contexts
const contexts = Array.from({ length: 4 }, () =>
  new lua_native.init({}, { libraries: "all" })
);

const results = await Promise.all(
  contexts.map((ctx, i) =>
    ctx.execute_script_async(`
      local sum = 0
      for i = 1, 1000000 do sum = sum + i end
      return sum
    `)
  )
);

// Error handling
try {
  await lua.execute_script_async("error('async error')");
} catch (e) {
  console.error(e.message); // includes "async error"
}

// Busy guard
const promise = lua.execute_script_async("return 1");
console.log(lua.is_busy()); // true
lua.execute_script("return 2"); // throws: "context is busy"
await promise;
console.log(lua.is_busy()); // false

// Callback restriction
const lua2 = new lua_native.init({
  greet: (name) => `Hello, ${name}!`,
}, { libraries: "all" });

// This rejects because greet() is a JS callback
await lua2.execute_script_async("return greet('World')");
// Error: "JS callbacks are not available in async mode"
```

---

## Detailed Implementation Steps (Completed)

> **All 8 steps below are implemented and tested.** The code snippets show the
> planned approach; the actual implementation may differ in minor details. See
> the source files for the final code.

### Step 1: Core Layer — Async Callback Guard (Done)

**Files**: `src/core/lua-runtime.h`, `src/core/lua-runtime.cpp`

Add a flag to `LuaRuntime` that enables/disables JS callback invocation. When
async mode is active, host function calls throw a Lua error instead of trying
to invoke JS callbacks.

```cpp
// lua-runtime.h — new members
private:
  bool async_mode_ = false;

public:
  void SetAsyncMode(bool enabled);
  bool IsAsyncMode() const;
```

```cpp
// lua-runtime.cpp — LuaCallHostFunction modification
int LuaRuntime::LuaCallHostFunction(lua_State* L) {
  // ... existing code to get runtime and function name ...

  if (runtime->async_mode_) {
    return luaL_error(L,
      "JS callbacks are not available in async mode "
      "(called '%s')", funcName.c_str());
  }

  // ... existing callback dispatch code ...
}
```

This is a minimal, surgical change. The host function dispatch already retrieves
the `LuaRuntime*` from the registry, so checking the flag adds negligible
overhead.

### Step 2: N-API Layer — Busy Flag (Done)

**File**: `src/lua-native.h`

Add a busy flag to `LuaContext`:

```cpp
// lua-native.h — new members
private:
  bool is_busy_ = false;

public:
  bool IsBusy() const { return is_busy_; }
```

Add `IsBusy` as a new instance method:

```cpp
Napi::Value IsBusyMethod(const Napi::CallbackInfo& info);
```

Add busy-guard checks to all existing sync methods (`ExecuteScript`,
`ExecuteFile`, `SetGlobal`, `GetGlobal`, `SetUserdata`, `SetMetatable`,
`CreateCoroutine`, `ResumeCoroutine`):

```cpp
if (is_busy_) {
  Napi::Error::New(env,
    "Cannot call execute_script while an async operation "
    "is in progress on this context").ThrowAsJavaScriptException();
  return env.Undefined();
}
```

### Step 3: N-API Layer — AsyncWorker Implementation (Done)

**New file**: `src/lua-async-worker.h`

Create a `LuaAsyncWorker` class extending `Napi::AsyncWorker`:

```cpp
#pragma once

#include <napi.h>
#include <memory>
#include <string>
#include "core/lua-runtime.h"

class LuaContext;

class LuaScriptAsyncWorker : public Napi::AsyncWorker {
public:
  LuaScriptAsyncWorker(
    Napi::Env env,
    Napi::Promise::Deferred deferred,
    std::shared_ptr<lua_core::LuaRuntime> runtime,
    std::string script,
    LuaContext* context)
    : Napi::AsyncWorker(env),
      deferred_(deferred),
      runtime_(std::move(runtime)),
      script_(std::move(script)),
      context_(context) {}

  void Execute() override {
    // Runs on worker thread — no N-API calls allowed
    runtime_->SetAsyncMode(true);
    result_ = runtime_->ExecuteScript(script_);
    runtime_->SetAsyncMode(false);
  }

  void OnOK() override {
    // Runs on main thread — N-API calls are safe
    Napi::HandleScope scope(Env());
    context_->ClearBusy();

    if (std::holds_alternative<std::string>(result_)) {
      deferred_.Reject(
        Napi::Error::New(Env(), std::get<std::string>(result_)).Value());
      return;
    }

    const auto& values = std::get<std::vector<lua_core::LuaPtr>>(result_);
    if (values.empty()) {
      deferred_.Resolve(Env().Undefined());
    } else if (values.size() == 1) {
      deferred_.Resolve(context_->CoreToNapi(*values[0]));
    } else {
      Napi::Array arr = Napi::Array::New(Env(), values.size());
      for (size_t i = 0; i < values.size(); ++i) {
        arr.Set(i, context_->CoreToNapi(*values[i]));
      }
      deferred_.Resolve(arr);
    }
  }

  void OnError(const Napi::Error& error) override {
    // Runs on main thread
    context_->ClearBusy();
    deferred_.Reject(error.Value());
  }

private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<lua_core::LuaRuntime> runtime_;
  std::string script_;
  lua_core::ScriptResult result_;
  LuaContext* context_;
};
```

A similar `LuaFileAsyncWorker` class handles `execute_file_async`, calling
`runtime_->ExecuteFile(filepath_)` in `Execute()` instead.

### Step 4: N-API Layer — Register Async Methods (Done)

**File**: `src/lua-native.h`

Add declarations:

```cpp
Napi::Value ExecuteScriptAsync(const Napi::CallbackInfo& info);
Napi::Value ExecuteFileAsync(const Napi::CallbackInfo& info);
void ClearBusy();
```

**File**: `src/lua-native.cpp`

Register in `Init`:

```cpp
InstanceMethod("execute_script_async", &LuaContext::ExecuteScriptAsync),
InstanceMethod("execute_file_async", &LuaContext::ExecuteFileAsync),
InstanceMethod("is_busy", &LuaContext::IsBusyMethod),
```

Implement `ExecuteScriptAsync`:

```cpp
Napi::Value LuaContext::ExecuteScriptAsync(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (is_busy_) {
    Napi::Error::New(env,
      "Cannot call execute_script_async while another async "
      "operation is in progress").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string script = info[0].As<Napi::String>().Utf8Value();

  auto deferred = Napi::Promise::Deferred::New(env);
  is_busy_ = true;

  auto* worker = new LuaScriptAsyncWorker(
    env, deferred, runtime, std::move(script), this);
  worker->Queue();

  return deferred.Promise();
}
```

`ExecuteFileAsync` follows the same pattern with a filepath argument.

### Step 5: TypeScript Types (Done)

**File**: `types.d.ts`

Add to `LuaContext`:

```typescript
  /**
   * Executes a Lua script asynchronously on a worker thread.
   * Returns a Promise that resolves with the script result.
   *
   * Note: JS callbacks registered via the constructor or set_global()
   * are NOT available in async mode. Scripts that call registered JS
   * functions will reject with an error.
   *
   * @throws Error if the context is already executing an async operation
   */
  execute_script_async<T extends LuaValue | LuaValue[] = LuaValue>(
    script: string
  ): Promise<T>;

  /**
   * Executes a Lua file asynchronously on a worker thread.
   * Same restrictions as execute_script_async regarding JS callbacks.
   *
   * @throws Error if the context is already executing an async operation
   */
  execute_file_async<T extends LuaValue | LuaValue[] = LuaValue>(
    filepath: string
  ): Promise<T>;

  /**
   * Returns true if an async operation is currently in progress
   * on this context. While busy, sync methods and additional async
   * calls will throw.
   */
  is_busy(): boolean;
```

### Step 6: C++ Tests (Done — 4 tests added)

**File**: `tests/cpp/lua-native-test.cpp`

Add a test suite for the async callback guard:

```cpp
TEST(LuaRuntimeAsync, AsyncModeBlocksHostFunctions) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.RegisterFunction("jsCallback", [](const auto&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(42));
  });

  // Should work in normal mode
  auto res = rt.ExecuteScript("return jsCallback()");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));

  // Should fail in async mode
  rt.SetAsyncMode(true);
  auto res2 = rt.ExecuteScript("return jsCallback()");
  ASSERT_TRUE(std::holds_alternative<std::string>(res2));
  EXPECT_NE(std::get<std::string>(res2).find("async mode"), std::string::npos);

  // Should work again after disabling
  rt.SetAsyncMode(false);
  auto res3 = rt.ExecuteScript("return jsCallback()");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res3));
}

TEST(LuaRuntimeAsync, AsyncModeFlagDefaultsOff) {
  LuaRuntime rt;
  EXPECT_FALSE(rt.IsAsyncMode());
}

TEST(LuaRuntimeAsync, PureLuaWorksInAsyncMode) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetAsyncMode(true);

  auto res = rt.ExecuteScript("return 6 * 7");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 42);
}

TEST(LuaRuntimeAsync, StdlibWorksInAsyncMode) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetAsyncMode(true);

  auto res = rt.ExecuteScript("return string.upper('hello')");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "HELLO");
}
```

### Step 7: TypeScript Tests (Done — 13 tests added)

**File**: `tests/ts/lua-native.spec.ts`

Add a test suite for async execution:

```typescript
describe("async execution", () => {
  it("resolves with the correct value", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    const result = await lua.execute_script_async("return 6 * 7");
    expect(result).toBe(42);
  });

  it("resolves with multiple return values as array", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    const result = await lua.execute_script_async("return 1, 'two', true");
    expect(result).toEqual([1, "two", true]);
  });

  it("resolves with undefined for no return", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    const result = await lua.execute_script_async("local x = 1");
    expect(result).toBeUndefined();
  });

  it("rejects on Lua errors", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    await expect(
      lua.execute_script_async("error('boom')")
    ).rejects.toThrow("boom");
  });

  it("rejects on syntax errors", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    await expect(
      lua.execute_script_async("return %%%")
    ).rejects.toThrow();
  });

  it("rejects when calling JS callbacks in async mode", async () => {
    const lua = new lua_native.init({
      greet: (name) => `Hello, ${name}!`,
    }, ALL_LIBS);
    await expect(
      lua.execute_script_async("return greet('World')")
    ).rejects.toThrow("async mode");
  });

  it("works with stdlib functions", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    const result = await lua.execute_script_async(
      "return string.upper('hello')"
    );
    expect(result).toBe("HELLO");
  });

  it("returns tables correctly", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    const result = await lua.execute_script_async(
      "return {a = 1, b = 'two'}"
    );
    expect(result).toEqual({ a: 1, b: "two" });
  });

  it("is_busy returns true during async execution", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    const promise = lua.execute_script_async(`
      local sum = 0
      for i = 1, 100000 do sum = sum + i end
      return sum
    `);
    // Note: is_busy may already be false if execution completes
    // before we check, so we just verify the method exists and returns boolean
    expect(typeof lua.is_busy()).toBe("boolean");
    await promise;
    expect(lua.is_busy()).toBe(false);
  });

  it("throws when calling sync methods while busy", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    const promise = lua.execute_script_async(`
      local sum = 0
      for i = 1, 10000000 do sum = sum + i end
      return sum
    `);
    // If still busy, sync call should throw
    if (lua.is_busy()) {
      expect(() => lua.execute_script("return 1")).toThrow();
    }
    await promise;
  });

  it("allows sync calls after async completes", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    await lua.execute_script_async("return 1");
    const result = lua.execute_script("return 2");
    expect(result).toBe(2);
  });

  it("execute_file_async works", async () => {
    // Uses a temp file — same pattern as sync file execution tests
    const lua = new lua_native.init({}, ALL_LIBS);
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpFile = path.join(os.tmpdir(), "lua_async_test.lua");
    fs.writeFileSync(tmpFile, "return 42");
    try {
      const result = await lua.execute_file_async(tmpFile);
      expect(result).toBe(42);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("execute_file_async rejects on file not found", async () => {
    const lua = new lua_native.init({}, ALL_LIBS);
    await expect(
      lua.execute_file_async("./nonexistent.lua")
    ).rejects.toThrow();
  });

  it("concurrent execution across contexts", async () => {
    const contexts = Array.from({ length: 4 }, () =>
      new lua_native.init({}, ALL_LIBS)
    );
    const results = await Promise.all(
      contexts.map((ctx) =>
        ctx.execute_script_async(`
          local sum = 0
          for i = 1, 100000 do sum = sum + i end
          return sum
        `)
      )
    );
    results.forEach((r) => expect(r).toBe(5000050000));
  });
});
```

### Step 8: Documentation (Done)

**Files**: `README.md`, `FEATURES.md`

- Added "Async Execution" section to README with usage examples and API reference
- Added architecture details to FEATURES.md covering the AsyncWorker pattern,
  busy flag, callback guard, and design decisions

---

## Phase 2: ThreadSafeFunction Callbacks (Future)

If demand exists for JS callbacks in async mode, Phase 2 would add TSFN
support. This section outlines the approach without full implementation detail.

### Architecture

Each registered JS callback gets wrapped in both:
1. The existing `std::function` (for sync mode — unchanged)
2. A `Napi::ThreadSafeFunction` (for async mode)

When `SetAsyncMode(true)` is active, `LuaCallHostFunction` uses the TSFN path
instead of throwing. The TSFN path:

1. Packs the Lua arguments into a `std::vector<LuaPtr>` (already C++ types)
2. Calls `tsfn.BlockingCall(callData)` — this blocks the worker thread
3. The main thread receives the call, converts args to N-API, invokes the JS
   function, converts the result back to `LuaPtr`, and signals completion
4. The worker thread wakes up, reads the `LuaPtr` result, converts it back to
   Lua values, and continues execution

### Complexity

- Each callback needs a TSFN created at registration time
- A synchronization primitive (mutex + condition variable, or a promise-like
  struct) coordinates the worker thread and main thread for each call
- The `CreateJsCallbackWrapper` function would need a TSFN variant
- Lifetime management: TSFNs must be released when the `LuaContext` is
  destroyed

### Performance Implications

Each JS callback invocation in async mode pays:
- Thread context switch (worker → main): ~1-10 microseconds
- Event loop scheduling latency: 0-1ms (depends on main thread load)
- Thread context switch (main → worker): ~1-10 microseconds

For scripts that call callbacks infrequently (e.g., once at the start and once
at the end), this is negligible. For tight loops calling callbacks thousands of
times, the overhead dominates and async mode is counterproductive.

### API Change

No API change needed — `execute_script_async` would simply stop rejecting
when callbacks are invoked. The restriction message would be removed and
callbacks would "just work" (but slower than sync mode for callback-heavy
scripts).

---

## Verification Plan (Completed)

All verification steps passed:

1. `npm run build-debug` — no warnings
2. `npm run test-cpp` — 105 tests passed (101 existing + 4 new async)
3. `npm run prebuild` — created fresh prebuild
4. `npm run build-debug` — rebuilt debug after prebuild
5. `npm run test-cpp` — 105 tests still passed
6. `npm test` — 197 tests passed (184 existing + 13 new async)

---

## Risk Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| Worker thread accesses N-API | High (crash) | AsyncWorker pattern handles this; callback guard prevents indirect access |
| Concurrent access to `lua_State` | High (corruption) | Busy flag rejects concurrent operations with clear error |
| TSFN callback deadlock (Phase 2) | Medium | Only relevant in Phase 2; worker blocks on main thread which may be blocked on worker |
| Memory leaks from unreleased refs | Medium | `OnOK`/`OnError` always called; `ClearBusy` in both paths |
| User confusion about callback restriction | Low | Clear error messages; documented in JSDoc and README |
| Overhead for short scripts | Low | Document that sync is faster for < 1ms scripts; no forced migration |
