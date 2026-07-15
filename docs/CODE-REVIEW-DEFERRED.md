# CODE-REVIEW-DEFERRED

Consolidated list of findings from `CODE-REVIEW-1.md` and `CODE-REVIEW-2.md` that
were **deferred, only partially resolved, or deliberately not applied**. Every
other finding in those two reviews is fully resolved. Items are grouped by their
source review and tagged with the original finding ID so they can be traced back.

Use this as the backlog for a future hardening/cleanup pass. Severity labels are
carried over from the originating review.

---

## From CODE-REVIEW-1 (commit `f9a2459`)

All 29 findings were implemented **except** the following, which were
deliberately documented rather than changed:

### L1 (partial) — member rename + class-body reindentation *(style)*
- The `env` / `runtime` member renames on `LuaContext` and the class-body
  reindentation (4-space → 2-space) were **not applied**.
- **Reason deferred:** pure style, no functional effect. `env`/`runtime` alias
  local variables in the free trap/worker functions and the identically-named
  members of the `*Data` structs, so a mechanical rename carries real regression
  risk for zero benefit.
- The `#pragma once` change and `js_callbacks` → `js_callbacks_` rename from L1
  *were* applied.

### M9 — full variant-key API for table refs *(medium)* — ✅ RESOLVED
- **Original gap:** the overflow-clamping bug was fixed in CODE-REVIEW-1, but a
  Lua table with a genuine string key like `"123"` remained unreachable from JS
  because numeric-looking string keys were always coerced to integer keys, and
  `LuaTableHandle` numeric keys were truncated through `Int64Value()` (so
  `t.get(1.5)` hit key `1`).
- **Resolution:** added a `TableKey` variant (`std::string | int64_t | double`)
  to the core (`src/core/lua-runtime.h`) with `GetTableFieldKeyed` /
  `SetTableFieldKeyed` / `HasTableFieldKeyed` overloads that push the key with
  its explicit Lua type — a string alternative is always a Lua string, never
  coerced. The `LuaTableHandle` `get`/`set`/`has` bindings build a `TableKey`
  from the JS argument (`NapiToTableKey`): a JS number becomes an integer key
  when integral/in-range and a float key otherwise; a JS string becomes a
  string key verbatim. The Proxy path keeps the coercing `std::string`
  overloads (JS property keys are always strings, so `obj[1]` must reach the
  array part). Regression tests added at both the TS (`lua-native.spec.ts`,
  "table reference API") and core C++
  (`KeyedFieldsDistinguishStringFromIntegerKeys`) levels; `types.d.ts`
  documents the key-type mapping.

### M10 (partial) — `NapiToCore` twin merge *(medium/cleanup)*
- The static `NapiToCore` and instance `NapiToCoreInstance` overloads were
  **left distinct** (not merged).
- **Reason deferred:** they differ intentionally (round-trip markers,
  converters, function handling); merging them would entangle those cases.
- The other M10 consolidations (constructor delegation, shared `ResultsToJs`,
  `RejectIfBusy` helper, de-duplicated worker `OnOK`) *were* applied.

---

## From CODE-REVIEW-2 (commit `d87f62b`)

### Partially resolved

#### M4 — unprotected global access vs. a metatable on `_G` *(medium)* — ✅ RESOLVED
- **Original gap:** `GetGlobal` / `SetGlobal` routed through the protected-call
  path, but `RegisterFunction`, `GetGlobalRef`, `SetGlobalMetatable`, and
  `AddSearchPath` / `HasPackageLibrary` still used raw global access
  (`lua_getglobal` / `lua_setglobal`) outside any protected frame. A metatable on
  `_G` with a raising `__index` / `__newindex` reached through these paths could
  panic → process abort.
- **Resolution:** added a `LuaRuntime::PushProtectedGlobal(name)` helper
  (`src/core/lua-runtime.cpp`) that reads `_G[name]` through the existing
  `ProtectedTableGet` trampoline under `lua_pcall`, and refactored `GetGlobal`,
  `GetGlobalRef`, `SetGlobalMetatable`, and `HasPackageLibrary` / `AddSearchPath`
  onto it. `RegisterFunction` installs its closure inside a protected frame (see
  M5 — it now uses `RunProtected`, which subsumes the earlier `ProtectedTableSet`
  approach). A raising `_G` metamethod therefore surfaces as a caught
  `std::runtime_error`. The binding
  layer was hardened to match: `set_global` (both the function and value
  branches), `RegisterCallbacks`, and `get_global_ref` now wrap the core calls in
  try/catch so the exception becomes a JS error instead of unwinding past N-API
  (`set_metatable` / `add_search_path` were already guarded). Regression tests
  added at the core C++ level (`LuaRuntimeProtectedGlobals.*`) and the TS level
  (`lua-native.spec.ts`, "M4 remainder").

#### M5 — allocation failure in unprotected API paths aborts *(medium)* — ✅ RESOLVED
- **Original gap:** `GetGlobal` / `SetGlobal` were protected via M4, but other
  allocating core methods stayed unprotected — `CreateTable`, `CreateTableFrom`
  (`lua_newtable`), `RegisterFunction` (`lua_pushstring` / `lua_pushcclosure`),
  and the `luaL_ref` sites in `GetGlobalRef` / `CreateCoroutineFromScript`. With
  `maxMemory` set, hitting the limit on one of these direct API calls (no
  surrounding script `pcall`) raised `LUA_ERRMEM` → unprotected panic → process
  abort, converting "operation fails" into "process aborts."
- **Resolution:** added a general `LuaRuntime::RunProtected(op)` helper
  (`src/core/lua-runtime.cpp`) that runs an operation inside a `lua_pcall` frame
  via a **light C-function trampoline** (0 upvalues → its push never allocates, so
  the protected frame is established before any allocation can fail). A Lua
  `LUA_ERRMEM` longjmps to the pcall and is rethrown as a `std::runtime_error`; a
  C++ exception from `op` (e.g. `PushLuaValue` depth/stack) is captured in the
  trampoline and rethrown after the frame unwinds, so it never crosses the pcall C
  frame (the linked Lua is a C/longjmp build). `CreateTable`, both
  `CreateTableFrom` overloads, `RegisterFunction`, `GetGlobalRef`, and
  `CreateCoroutineFromScript` now build-and-ref entirely inside `RunProtected`;
  `RegisterFunction` folds its M4 `__newindex` protection into the same frame. The
  binding layer catches the new throws (`create_table`, `execute_async`;
  `set_global` / `get_global_ref` were already guarded). Tests:
  `LuaRuntimeProtectedAlloc.*` (C++, an over-limit `CreateTableFrom` throws
  instead of aborting) and the two `M5:` TS cases.
- **Documented residual:** the `luaL_ref` calls buried in the value-conversion
  path (`ToLuaValue` materializing a function/thread/metatable *result*) are not
  individually wrapped. In the common case they run inside the execution `pcall`
  (script results are converted right after `ProtectedCall`); a bare-API result
  conversion under an exhausted `maxMemory` remains a narrower unprotected site,
  orthogonal to the direct-allocation-API class this finding targeted.

#### M6 — cross-context round-trip marker identity check *(medium)* — ✅ RESOLVED
- **Original gap:** `_tableRef` / `_userdata` markers were already honored only
  when `data->runtime` matched this context, but `__luaClassRef` carried no
  runtime pointer — it was a bare integer validated only by a `js_userdata_`
  lookup. A class instance from context A (ref id `N`) passed into context B
  could alias B's own userdata slot `N`, a cross-context identity collision.
- **Resolution:** class instances now also carry a `__luaClassOwner` hidden
  property — an `Napi::External<lua_core::LuaRuntime>` wrapping this context's
  runtime pointer (identity comparison only; no ownership, no finalizer). The
  round-trip check in `NapiToCoreInstance` (`src/lua-native.cpp`) honors
  `__luaClassRef` only when `__luaClassOwner` matches `runtime.get()`, mirroring
  the `_tableRef` / `_userdata` identity checks; a foreign or missing owner falls
  through to a plain deep copy. Regression tests added at the TS level
  (`lua-native.spec.ts`, "round-trip identity" → the two `M6:` cases: a foreign
  instance is deep-copied rather than aliased, and same-context round-trip still
  works).

### Formerly deferred — now resolved

#### H9c — finalizer `luaL_unref` racing a worker run *(high)* — ✅ RESOLVED
- **Original gap:** an N-API finalizer running `luaL_unref` on the main thread at
  GC time could mutate the Lua registry **concurrently** with a
  `execute_script_async` / `execute_file_async` worker executing on a libuv
  thread → heap corruption.
- **Resolution:** a deferred-unref queue guarded by a mutex (`src/core`). The
  worker brackets its off-thread run with
  `BeginWorkerUnrefDeferral` / `EndWorkerUnrefDeferral`; while a worker is active,
  the registry-owner deleter routes through `LuaRuntime::UnrefOrDefer`, which
  *queues* the ref instead of unref'ing. `EndWorkerUnrefDeferral` drains the
  queue on the main state under the mutex after the worker finishes touching Lua.
  Every `luaL_unref` (finalizer path and drain) and every flag flip happens under
  the one mutex, so no two unrefs — and no unref and the worker's own registry
  mutation — race. The deleter resolves the runtime from the main state's
  **extra space** (`lua_getextraspace`, set in `InitState`), so it reads no
  registry and takes no Lua lock. C++ tests: `LuaRuntimeWorkerUnref.*`.

#### M1 — awaiting a JS promise from inside a *user* coroutine *(medium)* — ✅ RESOLVED
- **Original gap:** under `execute_async`, `await`-ing a JS promise from inside a
  user-created coroutine yielded the wrong thread and delivered the settled value
  to the driver frame.
- **Resolution:** the core records the driver coroutine thread
  (`SetAwaitDriverThread`, set in `ExecuteAsync`, cleared in `FinishAsync`). The
  host-call bridge and the method bridge (`LuaCallHostFunction` / the userdata
  method dispatch) now compare the running `lua_State` against the driver thread
  before suspending; a promise awaited from a non-driver thread raises
  `"cannot await a JS Promise inside a coroutine … await only at the top level of
  execute_async"` instead of yielding. TS tests: the two `M1:` cases (rejects
  inside a user coroutine; top-level await still works).

#### L5 — hostile `Promise` subclass double-firing the await callbacks *(low)* — ✅ RESOLVED
- **Original gap:** a spec-violating `Promise` whose `then` invoked the callbacks
  twice caused a read-after-free of the `AwaitCookie` (freed on first
  settlement); a never-settling promise leaked it.
- **Resolution:** the cookie carries a `settled` flag (a second invocation is a
  no-op) and is no longer freed by the callbacks. Its lifetime is owned by an
  `Napi::External` finalizer rooted as a hidden prop on **both** callback
  functions, so it stays valid for any late/duplicate settlement and is reclaimed
  only when the promise (and its callbacks) is garbage-collected — which also
  fixes the never-settling leak. TS test: the `L5:` double-firing case.

#### L6 — hidden owner properties are `configurable` / deletable from JS *(low)* — ✅ RESOLVED
- **Original gap:** the hidden `__luaFnOwner` owner property was `configurable`
  and `writable`, so `delete fn.__luaFnOwner; gc(); fn()` (or reassigning it)
  freed the `LuaFunctionData` the bound C function still calls through.
- **Resolution:** `DefineHiddenProp` now defines all hidden markers
  `configurable: false` (blocks `delete`), and `__luaFnOwner` — the only true
  lifetime owner — additionally `writable: false` (blocks reassignment). Identity
  markers that may legitimately be re-tagged (a `construct()` returning a pooled
  object gets a fresh `__luaClassRef`) stay `writable: true`, so re-tagging
  doesn't throw. TS tests: the two `L6:` cases.

#### L7 — `js_error_registry_` accumulation on non-`CallScope` paths *(low)* — ✅ RESOLVED
- **Original gap:** JS errors staged on paths without a `CallScope` (coroutine
  resume, table traps) were neither consumed nor cleared until an unrelated
  guarded call ran.
- **Resolution:** `LuaContext::ResumeCoroutine` now runs under a `CallScope` and
  consumes the staged fidelity state (registry entry + `last_error_value_`) via
  `LuaErrorToJsValue` on the error path (the string API is preserved; the
  reconstructed Error is discarded). The `TableRefGetTrap` / `TableRefSetTrap`
  Proxy traps scope their field operation under a `CallScope` so a staged entry
  from a raising `__index`/`__newindex` host callback is cleared at the outermost
  access instead of accumulating.

#### L8 — `cancel()` is a no-op for worker-thread async *(low)* — ✅ RESOLVED
- **Original gap:** nothing called `RequestCancel()` for worker-thread runs, and
  the `IsCancelRequested` branch in `OnAwaitSettled` was dead code.
- **Resolution:** `cancel()` now calls `runtime->RequestCancel()` when a
  worker-thread run is in flight; the instruction count-hook (gap **A3b**, see
  below) polls `IsCancelRequested()` and aborts the VM loop, so a compute-bound
  worker run is cooperatively interruptible when `maxInstructions` is set (the
  hook exists only then). `ClearBusy` clears the flag on worker teardown so a
  cancelled run can't pre-abort the next one. The unreachable `OnAwaitSettled`
  cancel branch was removed (a cancel while suspended awaiting a promise tears the
  run down in `Cancel()`; worker and coroutine async are mutually exclusive, so
  the branch could never fire). TS test: the `L8:` worker-cancel case.

#### M11 — no `HandleScope` in Lua→JS reentrant callbacks *(medium)* — ✅ RESOLVED
- **Original gap:** handles created in reentrant Lua→JS callbacks accumulated in
  the outer N-API entry scope (e.g. `for i=1,1e6 do MyClass() end`).
- **Resolution:** the one remaining unbounded reentrant site,
  `CreateConstructorWrapper`, now opens a `Napi::HandleScope` at the top of its
  lambda (mirroring the M10 placement in `CreateJsCallbackWrapper`). Nothing needs
  escaping — the constructed instance survives via its `Napi::Persistent`. Every
  other Lua-invoked callback either was already scoped in M10 or routes through
  the scoped `CreateJsCallbackWrapper`; the Proxy traps / table-handle methods are
  JS→Lua boundaries that already get an automatic N-API scope. TS smoke test: the
  `M11:` 5,000-instance construction loop.

#### M12 — stale staged searcher error mis-raised by a later failure *(medium)* — ✅ RESOLVED
- **Original gap:** when a JS searcher threw, the wrapper staged
  `pending_error_value_` but `JsSearcher`'s catch raised its own string without
  consuming it; the stale structured error survived and was mis-raised by the
  next host call that didn't stage.
- **Resolution:** `JsSearcher` now discards any staged `pending_error_value_` on
  its raise path (`TakePendingErrorValue`) before `lua_error`, so a searcher
  failure can't leak a structured error into a later, unrelated raise. TS test:
  the `M12:` stale-searcher-error case.

#### Stored-`env` documentation *(low, from M11/M12 grouping)* — ✅ RESOLVED
- The `LuaContext::env` stored-member is documented at its declaration
  (`src/lua-native.h`): it is captured at construction and safe to reuse from
  later instance methods (same JS thread, ObjectWrap lifetime) but must not be
  used from a worker thread — the async workers take their `env` from the
  `AsyncWorker` instead.

---

## Suggested order for a future hardening pass

**Every finding from CODE-REVIEW-1 and CODE-REVIEW-2 is now resolved.** The only
remaining item is the narrow, documented M5 residual (result-conversion
`luaL_ref` sites — see the M5 entry above), which is orthogonal to the
direct-allocation-API panic class the review targeted and normally runs inside
the execution `pcall` anyway.

---

## Feature work completed since these reviews

- **Execution Time Limits (`maxInstructions`)** — ✅ **fully complete (A3b
  closed).** The tier-1 `lua_sethook` / `LUA_MASKCOUNT` count-hook from
  `FUTURE.md` (gap **A3b**) is implemented. A
  per-execution VM-instruction budget aborts runaway scripts with
  `"instruction limit exceeded"`; the budget is reset per execution call at every
  entry point (`ProtectedCall`, `ResumeCoroutine`, `ResumeAsyncStep`), the hook
  is installed once on the main state and inherited by coroutine threads
  (`lua_newthread` copies it), and it is removed when the limit is set back to 0.
  The hook also polls `IsCancelRequested()` so compute-bound loops become
  cooperatively cancellable. With the L8 worker-`cancel()` → `RequestCancel()`
  wiring now in place (see the L8 entry above), **A3b is fully closed** — both the
  instruction-limit and hook-based-`cancel()` halves are done. Covered by
  `LuaRuntimeInstructions.*` (C++) and the `maxInstructions` / `L8:` TS suites.
