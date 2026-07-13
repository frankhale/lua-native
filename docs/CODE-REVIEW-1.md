# CODE-REVIEW-1

A full review of the native C++ sources (`src/core/lua-runtime.h`, `src/core/lua-runtime.cpp`,
`src/lua-native.h`, `src/lua-native.cpp`, `src/lua-async-worker.h`), focused on correctness,
modern C++ practice, maintainability, and cleanliness. Findings are ordered by severity.
Line numbers refer to the code as of commit `f9a2459`.

## Resolution status

All findings are resolved. Verified green after every change: **402 TypeScript tests + 162 C++
tests**, plus a `--expose-gc` stress test (M2) and an end-to-end behavior test (H2/H3/L7/M9).

| # | Status | Resolution |
|---|--------|------------|
| H1 | ✅ Done | C callbacks (`LuaCallHostFunction`, `UserdataMethodCall`, `UserdataIndex`, `UserdataNewIndex`, `ClassIndex`, `JsSearcher`) restructured so all C++ locals are destroyed before any `lua_error`/`lua_yieldk` longjmp (staged via a `HostCallOutcome`/flag pattern). |
| H2 | ✅ Done | Added `ProtectedTable{Get,Set,Len,ICollect}` trampolines run through `ProtectedTableCall` (`lua_pcall`); the table-ref ops now surface a raising metamethod as a `std::runtime_error` → JS exception instead of a panic/abort. |
| H3 | ✅ Done | `ResumeCoroutine`'s error path uses `CaptureError` (no `std::string` from a NULL `lua_tostring`). |
| H4 | ✅ Done | `async_mode_` / `is_busy_` are `std::atomic<bool>`; `LuaFunctionCallbackStatic`, every table-ref trap/handle method, and `GetMemoryUsage` reject while a worker owns the state. |
| H5 | ✅ Done | Per-run `async_generation_` carried by an `AwaitCookie`; `OnAwaitSettled` drops mismatched settlements, so a cancelled run can't drive a later one. |
| H6 | ✅ Done | The async workers hold a `Napi::ObjectReference` to the wrapping JS object. |
| M1 | ✅ Done | RAII refs via a shared control block (`detail::MakeRegistryOwner`); round-trip sites copy refs to share ownership; `~LuaRuntime` drops its error values before `lua_close`. |
| M2 | ✅ Done | The four `*Data` wrappers are owned by N-API finalizers tied to the JS object they back; the append-only vectors are gone. GC-stress validated. |
| M3 | ✅ Done | New `HostFunctionName` value type: nested JS functions become real Lua closures and round-trip back to the original JS function. |
| M4 | ✅ Done | `isSequentialArray` is order-independent (counts integer keys in `[1, rawlen]` and compares to `rawlen`). |
| M5 | ✅ Done | `ExecuteScript` / `CompileScript` / `CreateCoroutineFromScript` load size-aware via `luaL_loadbuffer` (embedded NULs preserved). |
| M6 | ✅ Done | `ResumeAsyncStep` checks `lua_status` before resuming. |
| M7 | ✅ Done | `StackGuard` added to `SetGlobal`, `RegisterFunction`, and both `CreateTableFrom` overloads. |
| M8 | ✅ Done | `CreateJsCallbackWrapper` / `CreateConstructorWrapper` use `find()` and raise a clear error instead of `operator[]`. |
| M9 | ✅ Done | Overflow-safe key parsing (`errno`/`ERANGE`) so a too-large numeric string stays a string key; the string-vs-integer key limitation is documented in-code. (The full variant-key redesign was scoped to this; see note below.) |
| M10 | ✅ Done | Constructor delegation, shared `ResultsToJs`, `RejectIfBusy` guard helper, de-duplicated worker `OnOK`. The two `NapiToCore` overloads are intentionally left distinct (their differences — round-trip markers, converters, function handling — are deliberate). |
| M11 | ✅ Done | Destruction-order invariants documented on `LuaRuntime` and (via M2) on the wrapper ownership. |
| M12 | ✅ Done | The stored `env` member is documented (safe on the JS thread; not for worker use). |
| L1 | ✅ Done | `#pragma once` in `lua-native.h`; `js_callbacks` → `js_callbacks_`. The `env`/`runtime` member renames and the class-body reindentation were deliberately not applied (see note). |
| L2 | ✅ Done | Registry keys/markers are `constexpr` constants shared by both layers. |
| L3 | ✅ Done | `kLibFlags` is a function-local static. |
| L4 | ✅ Done | `GetCoroutineStatus` documents that `Running` is never returned. |
| L5 | ✅ Done | `io.write` override's divergences documented in-code. |
| L6 | ✅ Done | `JsSearcher` returns `loader, modname` per Lua convention. |
| L7 | ✅ Done | Method closures cached in the method table (identity + speed). |
| L8 | ✅ Done | `HasPackageLibrary` uses `lua_istable` alone. |
| L9 | ✅ Done | The leaked constructor `FunctionReference` in `Init` removed; the instance-data ref is the single owner. |
| L10 | ✅ Done | The worker-thread vs. coroutine-driven async tradeoff is documented above `ExecuteScriptAsync`. |
| L11 | ✅ Done | `AsyncStepResult` default, allocator invariant, and `io.write` commented; `static_cast<lua_KContext>(0)` → `0`; `LuaValue::from` merged to by-value; unique-name id counters widened to `uint64_t`; unused params unnamed; type-converter per-crossing cost documented in `types.d.ts`. |

**Deliberately not applied (documented rather than changed):**

- **L1 member rename (`env`/`runtime`) and class-body reindentation.** These are pure style with
  no functional effect. The `env`/`runtime` renames alias local variables in the free trap/worker
  functions and the identically-named members of the `*Data` structs, so a mechanical rename
  carries real regression risk for zero benefit; the current names are unambiguous in context.
- **M9 full variant-key API.** Passing keys as a `string | int64 | double` variant end-to-end is
  a larger API change; the concrete correctness bug (silent overflow clamping) is fixed and the
  remaining string-vs-integer ambiguity is documented.
- **M10 `NapiToCore` twin merge.** The static and instance overloads differ intentionally
  (round-trip markers, converters, function handling); merging them would entangle those cases.

The original findings follow unchanged for reference.

## Overall assessment

The two-layer design (pure-C++ core, N-API binding) is sound and consistently applied, the
`std::variant`-based `LuaValue` is a good fit, `StackGuard` is used in most of the right
places, and the code is generally readable with helpful comments. The issues below are mostly
concentrated in three areas: **Lua's `longjmp` error model colliding with C++ objects**,
**manual (non-RAII) registry-reference management**, and **lifetime/threading gaps around the
async paths**.

---

## High severity

### H1. `lua_error` longjmps over live C++ objects (UB / leaks)  — ✅ DONE

Lua is linked as a **C library** from vcpkg (`<lua.hpp>` wraps the headers in `extern "C"`,
`binding.gyp` links the prebuilt lib). In that configuration `lua_error`/`luaL_error` unwind
with `longjmp`, which **skips C++ destructors** of anything on the stack between the raise
point and the enclosing `lua_pcall`. Jumping over a non-trivially-destructible object is
undefined behavior; in practice it leaks and can corrupt state.

The pattern occurs throughout the C callbacks in `lua-runtime.cpp`:

- `LuaCallHostFunction` (`lua-runtime.cpp:801-879`): `std::vector<LuaPtr> args`,
  `LuaPtr resultHolder` are live when `lua_error` is called in every error branch.
- `UserdataMethodCall` (`lua-runtime.cpp:330-410`): same pattern.
- `UserdataIndex` / `UserdataNewIndex` (`lua-runtime.cpp:182-259`): `std::string registry_key`
  and the caught exception object are live at `lua_error`.
- `ClassIndex` (`lua-runtime.cpp:472-519`): `std::string methods_key` live at `luaL_error`.
- `JsSearcher` (`lua-runtime.cpp:741-797`): `LuaPtr result`, `std::string chunkname`, `args`
  vector live at several `luaL_error` calls.
- `StackGuard` itself is skipped by the jump wherever it's on the path.

**Recommendation.** Restructure each C callback so that all C++ objects are destroyed before
raising. The standard idiom is to do the C++ work in an inner scope (or a helper returning a
status/message), stage the error message in a buffer or on the Lua stack, and only then call
`lua_error` from a frame containing no non-trivial objects:

```cpp
static int LuaCallHostFunction(lua_State* L) {
  bool failed = false;
  {   // all C++ objects live and die inside this scope
    std::vector<LuaPtr> args = ...;
    ...
    if (error) { lua_pushfstring(L, ...); failed = true; }
  }   // destructors run here
  if (failed) return lua_error(L);
  ...
}
```

Alternatively, compile Lua from source as C++ (errors become exceptions and destructors run),
but that changes the vcpkg-based build significantly; the scoping fix is local and safe.

### H2. Unprotected Lua calls that can raise → `lua_panic` → process abort  — ✅ DONE

The table-reference operations invoke metamethod-capable API functions on the main state with
**no enclosing `lua_pcall`**:

- `GetTableField` / `SetTableField` / `HasTableField` use `lua_geti` / `lua_getfield` /
  `lua_seti` / `lua_setfield` (`lua-runtime.cpp:1346-1390`) — these trigger `__index` /
  `__newindex`.
- `GetTableLength` uses `luaL_len` (`lua-runtime.cpp:1411-1415`) — triggers `__len`, and
  errors if the metamethod result isn't a number.
- `TableIPairs` uses `lua_geti` (`lua-runtime.cpp:1489-1509`).

Table refs exist precisely to preserve metatables, so `__index` functions on these tables are
the *expected* case, and a metamethod that raises (`error("...")` inside `__index`) has no
protected frame anywhere in the call chain (JS → trap → `GetTableField`). Lua then calls the
panic handler and **aborts the process**. It also longjmps over `StackGuard` (see H1).

**Recommendation.** Route these operations through a protected call: push a small C shim (or
use `lua_pcall` around a helper closure) so metamethod errors come back as `ScriptResult`-style
error strings that the binding layer can rethrow as JS exceptions.

### H3. `ResumeCoroutine` error path: `std::string` from a possibly-NULL pointer  — ✅ DONE

`lua-runtime.cpp:1609`:

```cpp
result.error = lua_tostring(threadRef.thread, -1);
```

If the coroutine failed with a non-string error object — `error({code = 1})`, or a structured
JS-error table raised through the D1 machinery — `lua_tostring` returns `NULL`, and
constructing `std::string`/`std::optional<std::string>` from a null `const char*` is undefined
behavior (typically a crash).

**Recommendation.** Use `CaptureError(threadRef.thread)` here, as `ExecuteScript` /
`ResumeAsyncStep` already do. That both fixes the crash and gives `resume()` the same
structured-error fidelity as the other execution paths.

### H4. Main-thread ↔ worker-thread races during `execute_script_async` / `execute_file_async`  — ✅ DONE

`LuaScriptAsyncWorker::Execute` runs `ExecuteScript` on a **libuv worker thread**
(`lua-async-worker.h:26-30`). The `is_busy_` guard protects most `LuaContext` methods, but not
all entry points that touch the same `lua_State`:

- `LuaFunctionCallbackStatic` (`lua-native.cpp:405`) — a previously returned Lua function can
  be called from JS while the worker is executing; it goes straight into `CallFunction` on the
  shared state. No `is_busy_` check.
- All table-ref Proxy traps and table-handle methods (`TableRefGetTrap`, `TableHandleGet`,
  `TableHandlePairs`, `TableHandleRelease`, …) — property access on a live proxy during an
  async run races the worker. No `is_busy_` check.
- `GetMemoryUsage` (`lua-native.cpp:1171`) reads `allocator_.current` while the worker
  allocates — a data race even if "only a counter."
- `async_mode_` and `is_busy_` are plain `bool`s written on one thread and read on another
  (`SetAsyncMode` is called from `Execute()` on the worker; `LuaPrint` reads it wherever the
  script runs). This is a formal data race (UB) regardless of how benign it looks.

**Recommendation.** Add the `is_busy_` guard to `LuaFunctionCallbackStatic`, every table-ref
trap/handle method, and `GetMemoryUsage`; make `is_busy_` / `async_mode_` / `cancel_requested_`
`std::atomic<bool>`. (Longer term, consider whether the thread-pool execution mode is worth
its cost versus the coroutine-driven `execute_async`, which stays on the main thread.)

### H5. Cancelled `execute_async` can leak its continuation into the *next* run  — ✅ DONE

`Cancel()` (`lua-native.cpp:1566-1575`) rejects and clears `async_co_` / `async_deferred_`,
but the `onResolve` / `onReject` callbacks attached to the in-flight JS promise
(`DriveAsync`, `lua-native.cpp:1477-1482`) remain scheduled. `OnAwaitSettled`
(`lua-native.cpp:1509-1541`) only checks that *some* run exists:

```cpp
if (!async_co_ || !async_deferred_) return env.Undefined();
```

Sequence: `execute_async(A)` awaits promise P → `cancel()` → `execute_async(B)` starts and
suspends → P settles → the stale callback passes its guard and **resumes B's coroutine with
A's promise value** (or rejects B with A's error).

**Recommendation.** Add a generation counter: bump `async_generation_` in `ExecuteAsync` and
`FinishAsync`, capture the current generation when attaching `onResolve`/`onReject`, and drop
the settlement if it doesn't match. (Capturing it via the callback `data` pointer requires a
small heap cookie, or store it in `async_pending_promise_`'s wrapper.)

### H6. Async workers hold a raw `LuaContext*` that can dangle  — ✅ DONE

`LuaScriptAsyncWorker` / `LuaFileAsyncWorker` keep `LuaContext* context_` and call
`context_->ClearBusy()` / `context_->CoreToNapi(...)` in `OnOK` (`lua-native.cpp:1653-1706`).
The worker keeps the *runtime* alive via `shared_ptr`, but nothing keeps the `LuaContext`
wrapper alive. If the JS object is garbage-collected while a worker is queued or running,
`OnOK` dereferences a destroyed object.

**Recommendation.** Have the worker hold a `Napi::ObjectReference` (persistent ref) to the
wrapping JS object for its lifetime — the idiomatic N-API pattern — or route results through a
`ThreadSafeFunction` owned by the context.

---

## Medium severity

### M1. Registry references are not RAII; leaks are systemic and copies invite double-unref  — ✅ DONE

`LuaFunctionRef` / `LuaThreadRef` / `LuaUserdataRef` / `LuaTableRef` are copyable, share the
raw registry ref, and only release when someone *manually* calls `release()`
(`lua-runtime.h:24-187`). `LuaValue` therefore holds refs that are silently dropped on
destruction. Concrete consequences:

- `last_error_value_` / `pending_error_value_`: `CaptureError` deep-converts the error object
  (`lua-runtime.cpp:967`); if it contains functions or metatabled tables, `luaL_ref`s are
  taken and never released when the member is `reset()` or overwritten
  (`ExecuteScript:1044`, etc.).
- `LuaContext::CreateCoroutine` (`lua-native.cpp:2017-2058`): the chunk's `LuaFunctionRef` in
  `values[0]` is never released — one registry slot leaked per call.
- Any conversion-error path that discards a partially built `std::vector<LuaPtr>` (e.g.
  `ExecuteScript:1065-1067`) leaks refs already collected into it.
- `TablePairs` converts the value *before* checking the key type and leaks the converted
  value's refs when the key is skipped (`lua-runtime.cpp:1462-1481`).
- Conversely, because copies share the ref, any future code path that wraps the same
  `LuaValue` in two `*Data` structs would double-`luaL_unref`, freeing a slot that may have
  been reallocated to an unrelated object — a nasty aliasing bug waiting to happen.

**Recommendation.** Make the ref structs genuinely RAII: delete the copy operations, keep the
moves, and call `release()` from the destructor. Where sharing is required, hold them as
`std::shared_ptr<LuaRegistryRef>` with the unref in the deleter. This removes the whole class
of leaks and makes the `*Data` wrappers' explicit `release()` calls unnecessary. The four
structs are also near-identical (~40 lines each) — one `LuaRegistryRef` base (or a template
tagged by kind) would collapse ~160 lines to ~40.

### M2. Per-crossing bookkeeping grows without bound for the life of the context  — ✅ DONE

Every Lua function, coroutine, opaque userdata, or metatabled table returned to JS appends a
`unique_ptr<...Data>` to `lua_function_data_` / `lua_thread_data_` / `lua_userdata_data_` /
`lua_table_ref_data_` (`lua-native.cpp:1946-1986`), and every JS function passed into Lua adds
a permanent `js_callbacks["__js_callback_N"]` entry plus a Lua global
(`lua-native.cpp:1724-1730`). None of these are ever pruned — a long-lived context that calls
`get_global('fn')` in a loop grows memory linearly even though each JS wrapper is immediately
garbage-collected.

**Recommendation.** Attach an N-API finalizer to each wrapper
(`Napi::Function::New(env, cb, name, data, finalizer)` or `Napi::External` finalizers) that
removes the `*Data` entry (and unrefs the registry slot) when the JS object is collected. Use
a `std::unordered_map<uint64_t, ...>` keyed by id rather than an append-only vector so removal
is O(1).

### M3. JS functions nested inside objects/arrays convert to Lua *strings*  — ✅ DONE

`NapiToCoreInstance` for a function registers a global `__js_callback_N` and returns **the
name as a Lua string** (`lua-native.cpp:1724-1730`). So
`ctx.set_global("t", { fn: () => 1 })` produces a Lua table where `t.fn` is the string
`"__js_callback_0"`, not a callable — `t.fn()` fails. It also mutates the global namespace as
a hidden side effect of a value conversion.

**Recommendation.** Return a `LuaFunctionRef`-like value that `PushLuaValue` materializes as a
closure over `LuaCallHostFunction` (the machinery already exists via
`StoreHostFunction` + `lua_pushcclosure`), so nested functions become real Lua functions and
no global is created.

### M4. `isSequentialArray` depends on `lua_next` iteration order  — ✅ DONE

`lua-runtime.cpp:15-28` requires `lua_next` to yield integer keys in exactly ascending order.
Lua only guarantees that for the *array part* of a table; a sequence whose keys landed in the
hash part (e.g. built via `t[3]=..., t[2]=..., t[1]=...`, or after `table.remove` churn) can
iterate out of order and be misclassified as a map — the JS side then sees
`{ "1": ..., "2": ... }` instead of an array. It's also O(n) with a full traversal even when
the first key already disqualifies... (it does bail early, but the true-array case walks
everything twice, once here and once in the copy loop).

**Recommendation.** Count keys while verifying each is an integer in `[1, rawlen]`, then
compare the count to `lua_rawlen` — order-independent and still one pass. Decide and document
the empty-table case explicitly (currently empty → array → `[]` in JS).

### M5. `luaL_loadstring` truncates scripts at the first embedded NUL  — ✅ DONE

`ExecuteScript` (`lua-runtime.cpp:1047`), `CompileScript` (`lua-runtime.cpp:888-890`), and
`CreateCoroutineFromScript` (`lua-runtime.cpp:1648`) pass `script.c_str()` to
`luaL_loadstring`. JS strings may legally contain `\0`; everything after it is silently
dropped. `CompileScript` already uses `luaL_loadbuffer` when a chunk name is given — the
size-aware call should be used unconditionally:

```cpp
luaL_loadbuffer(L_, script.data(), script.size(), chunk_name);
```

### M6. `ResumeAsyncStep` doesn't check whether the coroutine is resumable  — ✅ DONE

Unlike `ResumeCoroutine` (`lua-runtime.cpp:1549-1561`), `ResumeAsyncStep`
(`lua-runtime.cpp:1682-1742`) pushes args and calls `lua_resume` without verifying
`lua_status` is `LUA_OK`/`LUA_YIELD`. The binding's state machine makes a dead resume unlikely
today, but the core API shouldn't rely on its caller for state validity — a stray
`DriveAsync` after completion would corrupt the thread. Add the same guard.

### M7. Missing stack hygiene when `PushLuaValue` throws  — ✅ DONE

`SetGlobal` (`lua-runtime.cpp:1107-1110`), `CreateTableFrom` (both overloads,
`lua-runtime.cpp:1424-1440`), and `RegisterFunction` have no `StackGuard`. `PushLuaValue`
throws on depth overflow, and a table push that throws mid-construction leaves the partially
built table (and for `SetGlobal`, nothing to pop it) on the stack permanently. Wrap these in
`StackGuard` like the other methods (note the guard must not run on the success path of
`CreateTableFrom`, where `luaL_ref` already pops — take care to structure accordingly, e.g.
`guard` only around the fill loop, or re-push before ref).

### M8. `CreateJsCallbackWrapper` uses `operator[]` on `js_callbacks`  — ✅ DONE

`lua-native.cpp:1261`: `js_callbacks[name].Call(...)` default-constructs an **empty**
`Napi::FunctionReference` if the name is missing (e.g. a future refactor that unregisters
callbacks), and calling an empty reference is UB. Use `find()` and raise a descriptive error.

### M9. Numeric-string key coercion in table refs is lossy and irreversible  — ✅ DONE

`GetTableField` / `SetTableField` / `HasTableField` treat any key that parses fully as an
integer as an integer key (`lua-runtime.cpp:1350-1390`). A Lua table with a genuine *string*
key `"123"` is unreachable from JS, and `strtoll` overflow (`"99999999999999999999"`) silently
clamps to `INT64_MAX` (errno is never checked). Meanwhile `TableHandleGet` converts JS numbers
with `Int64Value`, silently truncating `t.get(1.5)` to key `1` (`lua-native.cpp:242-249`).
Consider passing keys as a small variant (string | int64 | double) end-to-end instead of
stringly-typed round-tripping.

### M10. Duplicated code blocks that will drift  — ✅ DONE

- `NapiToCore` (static) duplicates ~80 lines of `NapiToCoreInstance`
  (`lua-native.cpp:1843-1911` vs `1718-1841`); the only differences are the round-trip
  markers, converters, and function handling. Extract the shared scalar/array/object logic
  into one helper parameterized by a recursion callback (as `ConvertBuiltinType` already
  does). Also note the static version silently converts functions to `nil`.
- The "values → JS result (undefined / single / array)" marshalling appears five times
  (`ExecuteScript`, `ExecuteFile`, `LoadBytecode`, both `AsyncWorker::OnOK`s, `DriveAsync`).
  One `Napi::Value ResultsToJs(Napi::Env, const std::vector<LuaPtr>&)` removes all of them.
- The `if (is_busy_) { throw... }` prologue is copy-pasted into ~20 methods; a small
  `bool EnsureNotBusy()` helper (or a guard macro) keeps them in sync.
- The three `LuaRuntime` constructors repeat `lua_newstate` + null-check + `InitState`
  (`lua-runtime.cpp:102-131`). Delegate: `LuaRuntime() : LuaRuntime(RuntimeConfig{}) {}` and
  `LuaRuntime(const std::vector<std::string>& libs) : LuaRuntime(RuntimeConfig{libs, 0}) {}`.
- The two async workers in `lua-async-worker.h` are identical except for the
  string/`ExecuteScript`-vs-`ExecuteFile` call; a single worker taking a
  `std::function<ScriptResult()>` (or an enum) halves the file.

### M11. Undocumented destruction-order dependencies  — ✅ DONE

Two places depend silently on member declaration order:

- `LuaRuntime`: `allocator_` before `L_` is commented (good) — but `host_functions_` and
  `stored_function_data_` are *after* `L_`, while `lua_close(L_)` in the destructor body runs
  `__gc` metamethods that can call back into `host_functions_` via the stored callbacks. The
  explicit destructor ordering currently saves this (callbacks cleared first), but only
  because `LuaContext::~LuaContext` nulls the std::function members first. Fragile.
- `LuaContext`: the `lua_*_data_` vectors must be destroyed **before** `runtime` (each `*Data`
  calls `luaL_unref` through its own `shared_ptr` copy, so it's actually safe either way — but
  the reason it's safe is the per-`*Data` `shared_ptr`, which deserves a comment where the
  vectors are declared).

Add comments stating the invariant, as was already done for `allocator_`.

### M12. `Napi::Env` stored as a member and used from arbitrary later callbacks  — ✅ DONE

`LuaContext::env` (`lua-native.h:132`) is captured at construction and used everywhere,
including inside `InstallPrintHandler`'s lambda and `CoreToNapi`. Node-API guidance is to use
the env of the *current* callback (`info.Env()`); a stored env is valid only while the addon's
env is alive and is easy to misuse from a finalizer or worker context (the `async_mode_` check
in `LuaPrint` is the only thing preventing exactly that). Prefer passing `info.Env()` down, or
at minimum document why the stored env is safe in each use.

---

## Low severity / style / polish

### L1. Inconsistent file and naming conventions  — ✅ DONE

- Header guards: `lua-native.h` uses `#ifndef LUA_NATIVE_H`; the other headers use
  `#pragma once`. Pick one (the codebase clearly prefers `#pragma once`).
- Indentation: `LuaContext`'s class body is 4-space indented (`lua-native.h:77-190`); the rest
  of the codebase is 2-space.
- Member naming: `runtime`, `env`, `js_callbacks`, `js_userdata_`, `is_busy_`,
  `lua_function_data_` — the trailing-underscore convention is applied to some members and not
  others within the same class. Standardize (trailing underscore, per the core layer).
- Free functions in `lua-native.cpp` use `static`; prefer an anonymous namespace for
  consistency with `lua-runtime.cpp`.

### L2. Magic registry-key strings scattered across the core  — ✅ DONE

`"_lua_core_runtime"`, `"_ud_methods_"`, `"_class_mt_"`, `"_class_methods_"`,
`"__lua_native_class"`, `"__jsErrorId"` are string literals repeated at each use site
(`lua-runtime.cpp` and `lua-native.cpp` both build `"__jsErrorId"` knowledge independently).
Define them as `constexpr const char*` next to `kUserdataMetaName`. Also, building
`"_ud_methods_" + std::to_string(ref_id)` on **every property access** (`UserdataIndex`,
`lua-runtime.cpp:200`) allocates twice per index; a registry *subtable* keyed by integer
(`rawgeti`) is both cleaner and faster.

### L3. `kLibFlags` is a global with dynamic initialization  — ✅ DONE

`lua-runtime.cpp:32-43` constructs a heap `unordered_map<std::string,int>` at load time
(static-init-order fiasco surface, unnecessary allocation). A function-local
`static const std::array<std::pair<std::string_view,int>,10>` (or a local static map inside
`LibraryMask`) is cheaper and safe.

### L4. `GetCoroutineStatus` never reports `Running`, and misreports "normal" state  — ✅ DONE

`lua-runtime.cpp:1616-1632`: a status of `LUA_OK` with a non-empty stack is reported as
`Suspended` even for a not-yet-started body, and `CoroutineStatus::Running` is unreachable.
Harmless today (single-threaded driver), but the enum promises more than the function
delivers; either implement it (compare against the currently running thread) or document that
`Running` is never returned.

### L5. `io.write` override diverges from stock behavior  — ✅ DONE

`LuaIoWrite` (`lua-runtime.cpp:674-694`) doesn't return the file handle (stock `io.write`
returns it for chaining: `io.write("a"):write("b")`), ignores `io.output()` redirection, and
stringifies non-string/number arguments via `__tostring` where the real `io.write` raises an
error. Also `SetOutputHandler(nullptr)` leaves the overrides installed (falling back to
`fwrite`, so `print` loses nothing, but the original functions are unrecoverable). Worth
noting in `docs/FEATURES.md` if intentional.

### L6. `JsSearcher` omits the loader-data return value  — ✅ DONE

Lua searchers conventionally return `loader, data` (the extra value is passed as the loader's
second argument and used in error messages). Returning only the loader
(`lua-runtime.cpp:796`) is legal but a one-line fidelity improvement:
`lua_pushstring(L, modname); return 2;`.

### L7. Per-access method closures break identity  — ✅ DONE

`UserdataIndex` / `ClassIndex` create a fresh closure on every method lookup, so
`obj.method ~= obj.method` in Lua. Caching the closure in the method table (replace the string
value with the closure on first access) fixes identity and speeds up hot method calls.

### L8. `HasPackageLibrary` redundant check  — ✅ DONE

`lua-runtime.cpp:561`: `!lua_isnil(...) && lua_istable(...)` — `lua_istable` already implies
non-nil. Cosmetic.

### L9. `Init` leaks a `FunctionReference` deliberately, then `InitModule` makes another  — ✅ DONE

`lua-native.cpp:484-486` heap-allocates a persistent constructor reference and drops the
pointer (a common but crufty idiom); `InitModule` (`lua-native.cpp:1709-1714`) then creates a
*second* persistent reference to the same function as instance data. Keep only the instance
data one — it's the modern, env-safe pattern — and delete the leaked allocation.

### L10. `ExecuteScriptAsync` model comment  — ✅ DONE

Since `execute_async` (coroutine-driven, main-thread) landed, the worker-thread
`execute_script_async` / `execute_file_async` exist alongside it with strictly fewer
capabilities (no JS callbacks, no print redirection, plus the thread-safety exposure in H4).
Consider documenting when each is appropriate, or deprecating the worker-thread pair.

### L11. Miscellaneous nits  — ✅ DONE

- `LuaContext::GetMemoryUsage` and `IsBusyMethod` ignore `info` — fine, but mark the parameter
  `[[maybe_unused]]` or omit its name for clarity.
- `AsyncStepResult::State state = State::Error;` defaulting to `Error` is a reasonable
  fail-safe but deserves a comment; a reader may assume it's a bug.
- `MemoryAllocator` arithmetic (`lua-runtime.cpp:73`) is correct but subtle
  (`current - old_size + nsize` in `size_t`); a comment noting `current >= old_size` is
  invariant would help.
- `static_cast<lua_KContext>(0)` (`lua-runtime.cpp:867`) — just `0`.
- `LuaValue::from(const std::string&)` + `from(std::string&&)` could be a single
  `from(std::string)` taking by value; same for several by-value opportunities.
- `int` ids (`next_userdata_id_` etc.) can theoretically overflow; `int64_t`/`uint64_t` costs
  nothing.
- `type_converters_` match functions run for *every* object crossing JS→Lua
  (`lua-native.cpp:1808-1812`) — worth documenting the per-conversion cost in `types.d.ts`.

---

## Suggested priority order

1. **H1/H2** — the longjmp-vs-C++ issues (restructure C callbacks; protect metamethod-capable
   table-ref ops). These are the only findings that can abort or corrupt the process from
   ordinary, documented API usage.
2. **H3** — one-line class of crash in `resume()` error handling.
3. **H4–H6** — async lifetime/threading (guards + atomics + generation token + persistent ref
   in workers).
4. **M1/M2** — RAII refs and finalizer-driven cleanup; removes whole leak classes and ~150
   lines of duplicated ref-struct code.
5. **M3–M9** — behavioral correctness items; each is small and independently testable.
6. **M10–M12, L1–L11** — consolidation and polish, best done opportunistically or as one
   cleanup PR.
