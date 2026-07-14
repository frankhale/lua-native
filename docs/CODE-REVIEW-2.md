# CODE-REVIEW-2

**Date:** July 14, 2026
**Scope:** Full review of the native sources (`src/core/lua-runtime.h/.cpp`,
`src/lua-native.h/.cpp`, `src/lua-async-worker.h`) **plus** — new in this review —
the JS/TS surface and packaging (`index.js`, `index.d.ts`, `types.d.ts`,
`package.json`, `binding.gyp`, CMake/test scripts). Line numbers refer to the
code as of commit `d87f62b`.

**Method:** Four independent review passes (core runtime, N-API binding,
JS/TS/packaging, and an adversarial async/lifetime deep-dive), findings then
deduplicated and individually re-verified against the source. Each finding
below is tagged **[Confirmed]** (re-verified by direct inspection during
synthesis) or **[Reported]** (verified by the originating pass; scenario
reproduced from code reading, not re-checked a second time).

**Baseline:** All 402 TypeScript tests and 162 C++ tests pass on the current
tree. **Caveat (at review time):** because of finding P2, the TypeScript suite
loaded `prebuilds/darwin-arm64/lua-native.node`, *not* `build/Debug` — the
passing run did not necessarily exercise the debug build.

---

## Resolution status (July 14, 2026)

All findings triaged and, except for the documented residuals below, fixed.
After the fixes: **411 TypeScript tests** (402 + 9 new CODE-REVIEW-2 regressions)
and **162 C++ tests** pass, now verified against the freshly built `build/Debug`
binary (P2 is fixed, so the suite exercises the real debug build). A standalone
behavioral harness additionally confirmed the reentrant-cancel, throwing-print,
reserved-metamethod, `2^63`, `_G`-metatable, and bytecode-re-enable paths.

| # | Status | Resolution |
|---|--------|------------|
| P1 | ✅ Fixed | `install` script no longer uses `cross-env`; a `skip_test%` gyp default removes the need for `GYP_DEFINES`, so consumer installs no longer depend on a devDependency. `cross-env` dropped entirely. |
| P2 | ✅ Fixed | Loader searches `build/Debug`/`build/Release` **before** `prebuilds/`; `ERR_DLOPEN_FAILED` is now non-fatal (tries the next candidate); `node-gyp-build` fallback always runs. |
| P3 | ✅ Fixed | `get_vcpkg_path.js` added to `files` (verified in `npm pack`); `prebuildify` added to devDependencies; the "build dir not found" early-throw that shadowed `node-gyp-build` is gone; prebuild script uses `--napi`. |
| H1 | ✅ Fixed | `async_resuming_` flag: a `cancel()` re-entered from a host callback during a resume defers to `RequestCancel()`, and `DriveAsync` honors it after the resume returns — no UAF, no empty-optional deref, no cross-run settle. |
| H2 | ✅ Fixed | `async_self_ref_` roots the wrapper JS object for the run's duration; `~LuaContext` also flips the liveness flag. |
| H3 | ✅ Fixed | `LuaFunctionData`/`LuaTableRefData` carry a shared `contextAlive` flag flipped in `~LuaContext`; the function trampoline and all table traps/handles check it and fail cleanly. |
| H4 | ✅ Fixed | `lua_checkstack` guards added to `ToLuaValue`, `PushLuaValue` (per level), `CallFunction`, `ResumeCoroutine`, and `ResumeAsyncStep`. |
| H5 | ✅ Fixed | `MakeRegistryOwner` resolves and captures the main thread (`LUA_RIDX_MAINTHREAD`) so the unref never targets a collected coroutine thread. |
| H6 | ✅ Fixed | `CaptureError` uses `lua_rawget` for `message` and a protected `__tostring` trampoline; a raising metamethod on a coroutine error path can no longer panic. |
| H7 | ✅ Fixed | `GetGlobal` binding wraps conversion in try/catch; `DriveAsync` and `OnAwaitSettled` catch marshalling exceptions, settle the deferred, and tear down. |
| H8 | ✅ Fixed | The print-handler invocation catches `Napi::Error` (and runs in a `HandleScope`) so a throwing handler can't unwind through Lua's C frames. |
| H9 | ✅ Fixed (a,b); ⚠️ residual (c) | (a) Lua-side guards now check `is_busy_`, closing the `Queue()`→`async_mode_` window. (b) Userdata/class property paths raise in async mode; the GC callback is skipped in async mode to avoid an off-thread N-API call. (c) Finalizer `luaL_unref` racing a worker still needs a deferred-unref queue — see residuals. |
| H10 | ✅ Fixed | Same `is_busy_` guard blocks reentry into a suspended `execute_async` from the function trampoline and table traps. |
| M2 | ✅ Fixed | `ResumeAsyncStep` rejects a finished coroutine (`LUA_OK` + empty stack), matching `ResumeCoroutine`. |
| M3 | ✅ Fixed | `GetTableKeys` checks `lua_istable` before `lua_next`. |
| M4 | ✅ Fixed (GetGlobal/SetGlobal); ⚠️ partial | `GetGlobal`/`SetGlobal` route through the protected-call path. `RegisterFunction`/`GetGlobalRef`/`SetGlobalMetatable`/`AddSearchPath` still use raw global access (rarer triggers) — noted as residual. |
| M6 | ✅ Fixed (`_tableRef`/`_userdata`); ⚠️ partial | Round-trip markers are honored only when `data->runtime` matches this context; foreign handles fall through to a deep copy. `__luaClassRef` (no runtime pointer) is a documented residual. |
| M7 | ✅ Fixed | `register_class` rejects `__gc`/`__index`/`__newindex`/`__name`/class-marker metamethods with a clear error. |
| M8 | ✅ Fixed | The converter loop indexes the vector and extracts both function handles before calling `match`, surviving a reentrant `register_type_converter`. |
| M9 | ✅ Fixed | Upper bound is now `num < 2^63` (both `NapiToCore` and `NapiToCoreInstance`); `2^63` no longer wraps to `INT64_MIN`. |
| M10 | ✅ Fixed | `HandleScope` added to the host-callback wrapper, property getter/setter, and print handler. |
| M13 | ✅ Fixed | `index.d.ts` re-exports `ClassDefinition`, `CompileOptions`, `MetatableDefinition`, `UserdataMethod`, `UserdataOptions`, `PcallResult`, `LuaTableHandle`. |
| M14 | ✅ Fixed | Loader and `run-tests.js` search the real CMake output dirs (`build/<Config>/macos`, `.../windows`). |
| M15 | ✅ Fixed | `MACOSX_DEPLOYMENT_TARGET` lowered from `26.0` to `11.0` (both blocks). |
| L1 | ✅ Fixed | `SetAllowBytecode` is idempotent and unwraps the `load()` shim on re-enable. |
| L2 | ✅ Fixed | `PushTableKey` treats only bare optional-`-` digit strings as integers; `" 12"`/`"+12"` stay string keys. |
| L3 | ✅ Fixed | `GetTableKeys` reads keys length-aware (embedded NULs preserved). |
| L4 | ✅ Fixed | `~LuaRuntime` clears `userdata_gc_callback_`/`output_handler_` before `lua_close`. |
| L9 | ✅ Fixed | Removed the stray `-fno-exceptions` from the MSVC-only blocks, the misleading `binary.napi_versions` metadata, and the ignored `-Dskip_test` args on the CMake scripts. |
| M5 | ⚠️ Partial | The most reachable OOM-in-unprotected-path sites (`GetGlobal`/`SetGlobal`) are now protected via M4; other allocating core methods (`CreateTableFrom`, `RegisterFunction`) remain unprotected. |
| M1, M11, M12, L5, L6, L7, L8, H9c | ⚠️ Documented residual | See below. |

**Deliberately deferred (documented, not changed):**

- **H9c — finalizer `luaL_unref` racing a worker run.** A correct fix needs a
  deferred-unref queue drained on the main thread after the worker completes;
  the trigger (V8 GC collecting a wrapper *during* a multi-second
  `execute_script_async`) is narrow. The worker-thread async model is already
  the lower-capability path (no JS callbacks); `execute_async` is preferred.
- **M1 — awaiting a JS promise from inside a *user* coroutine** yields to the
  wrong resumer. Needs a core guard that refuses to yield when the yielding
  state isn't the driver thread; deferred as a correctness-of-a-niche-usage item.
- **M5 (remainder), M4 (remainder)** — remaining unprotected allocating/global
  API sites; same protected-trampoline treatment applies when prioritized.
- **L5 — hostile `Promise` subclass double-firing** the await callbacks
  (spec-violating input) can double-free the cookie. Low-risk; a settled flag or
  finalizer-owned cookie would close it.
- **L6, L7, L8, M11/M12** — configurable owner props, `js_error_registry_`
  accumulation on non-`CallScope` paths, `cancel()` being a no-op for
  worker-thread async, and the stored-`env` documentation items — left as-is
  per their low severity. **Update (Execution Time Limits landed):** the
  `lua_sethook` count-hook this L8 note referred to (`FUTURE.md` /
  `BRIDGE-GAP-ANALYSIS.md` A3b) now exists — see `maxInstructions`. The hook
  polls `IsCancelRequested()`, so compute-bound loops are now cooperatively
  interruptible *once a cancel is signalled*; the remaining L8 piece is wiring
  the worker-thread `cancel()` path to call `RequestCancel()`.

The original findings follow unchanged for reference.

---

## Relationship to CODE-REVIEW-1

All 29 findings from CODE-REVIEW-1 were marked resolved. This review
re-verified those fixes. Most are **complete and correct**:

| Prior fix | Status |
|---|---|
| H1 staged error raising (`HostCallOutcome`) | ✅ Complete — all six C callbacks verified; no non-trivial locals live at any `lua_error` |
| H2 protected table-ref ops | ⚠️ One gap: `GetTableKeys` was missed (see M3) |
| H3 `CaptureError` in `ResumeCoroutine` | ⚠️ Present, but `CaptureError` itself has an unprotected-metamethod hole (see H6) |
| H4 atomics + busy guards | ⚠️ Guards on Lua-side entry points key off the wrong flag / are missing on some core hooks (see H9, H10) |
| H5 generation cookie | ✅ Correct for settle-after-finish/cancel; residual issues are new findings (H1, L5) |
| H6 worker `ObjectReference` | ✅ Correct — but the same pattern was *not* applied to `execute_async` or the `*Data` structs (see H2, H3) |
| M1 RAII registry owners | ⚠️ Scheme is sound; the captured `lua_State*` can dangle for coroutine-minted refs (see H5) |
| M4 `isSequentialArray` | ✅ Correct — order-independent logic verified airtight |
| M5 `luaL_loadbuffer` | ✅ Complete — no `luaL_loadstring` remains |
| M6 `ResumeAsyncStep` resumability check | ⚠️ Rejects errored threads but still accepts a *finished* (`LUA_OK`, empty-stack) one (see M2) |
| M7 `StackGuard` additions | ✅ Present and correct |
| M8 `find()` on `js_callbacks_` | ✅ Verified in both wrappers |
| M9 overflow-safe key parsing | ✅ ERANGE handled; two small residual nits (L2) |
| M2/M3/M10–M12, L1–L11 | ✅ Verified in place |

The pattern in this review's new findings: CODE-REVIEW-1's fixes were applied
correctly at the sites it named, but several of the underlying hazard classes
(thread-guarding, wrapper lifetimes, exception barriers) have **additional
sites the first review didn't enumerate**.

---

## Overall assessment

The core architecture remains sound and the CODE-REVIEW-1 remediation was
high quality. The new high-severity findings cluster in four areas:

1. **The `execute_async` driver's reentrancy and lifetime model** — teardown
   (`cancel`) can run on its own call stack, nothing roots the context wrapper
   across a suspension, and marshalling failures skip cleanup (H1, H2, H7).
2. **Object lifetimes across the JS boundary** — returned function/table
   handles hold a raw `LuaContext*` that survives the context (H3).
3. **Incomplete thread/reentrancy guards** — the worker-async guards check
   `async_mode_` where they need `is_busy_` (or exist not at all), and GC
   finalizers can mutate the registry mid-worker-run (H9, H10).
4. **Packaging** — the package as published is uninstallable for consumers,
   and the loader's search order undermines the documented dev workflow
   (P1–P3). These are trivial to fix but affect every user.

Two long-standing gaps surfaced that predate CODE-REVIEW-1: **no
`lua_checkstack` anywhere** (H4) and **unprotected metamethod-capable calls on
the globals table and in `CaptureError`** (H6, M4).

---

## High severity — native

### H1. Reentrant `cancel()` during an active resume → use-after-free and empty-optional deref  [Confirmed]

`src/lua-native.cpp:1556-1565` (`Cancel`), `:1449-1488` (`DriveAsync`),
`:1527-1538` (`FinishAsync`); `src/core/lua-runtime.cpp:1929-1938`.

`Cancel()` has no reentrancy guard and destructively tears down
`async_co_`/`async_deferred_`. If a host callback (or print handler) invoked
*during* a `DriveAsync` resume calls `ctx.cancel()`:

1. `FinishAsync()` runs `async_co_->release()` — un-anchoring the **currently
   executing** coroutine thread (GC can collect it mid-run) — and resets
   `async_deferred_`.
2. When `lua_resume` returns, `ResumeAsyncStep` touches `threadRef.thread`
   through a reference into the destroyed `LuaThreadRef` (use-after-free).
3. `DriveAsync` then executes `auto deferred = *async_deferred_;` on a
   disengaged `std::optional` — UB — and calls `FinishAsync()` a second time.
4. If the callback also starts a *new* `execute_async` (allowed —
   `is_busy_` is false after step 1), the unwinding old `DriveAsync` settles
   the new run's deferred with the old run's result.

**Recommendation:** add a `resume_in_progress_` flag (or reuse the generation
counter inside `DriveAsync`): `Cancel` during a live resume should set
`RequestCancel()` and return, letting `DriveAsync` observe it after the resume
returns; `DriveAsync` should re-check generation before dereferencing
`async_deferred_`.

### H2. Nothing keeps the `LuaContext` wrapper alive across an `execute_async` suspension  [Confirmed]

`src/lua-native.cpp:1409-1438` (`ExecuteAsync`), `:1466-1472` (cookie),
`:1540-1554` (settlement statics). Contrast `src/lua-async-worker.h:24-28`,
which holds `Napi::Persistent(info.This())` for exactly this reason.

The suspended run is continued only by `then`-callbacks whose `AwaitCookie`
holds a **raw** `LuaContext*`. The returned Promise does not reference the
wrapper. Sequence: start `execute_async`, drop the last JS reference to the
context, await the promise → GC finalizes the wrapper → the awaited promise
settles → `OnAwaitResolveStatic` dereferences the freed `cookie->ctx`. Even
without adversarial GC timing, `~LuaContext` never rejects `async_deferred_`,
so the returned promise hangs forever.

**Recommendation:** hold a `Napi::ObjectReference` to `info.This()` for the
duration of the run (acquire in `ExecuteAsync`, release in `FinishAsync`), as
the worker path already does; reject the deferred in `~LuaContext` as a
belt-and-braces measure.

### H3. `*Data` structs and host-function lambdas hold a raw `LuaContext*` that outlives the context  [Confirmed]

`src/lua-native.h:19,59` (`LuaFunctionData::context`,
`LuaTableRefData::context`); `src/lua-native.cpp:431-474`
(`LuaFunctionCallbackStatic` dereferences `data->context`), `:1232`
(`CreateJsCallbackWrapper` lambda captures `this`), table traps `:148+`.

Each wrapper keeps the **runtime** alive via `shared_ptr` (so the finalizers
are safe — verified) but the **context** only as a bare pointer. A returned
Lua function handle or table Proxy is an independent GC root, so:
`let fn = ctx.get_global("f"); ctx = null;` → GC collects the `LuaContext` →
`fn()` → `data->context->NapiToCoreInstance(...)` on freed memory.

**Recommendation:** either have each `*Data` hold a `Napi::ObjectReference` to
the context wrapper (making handles root their context — simple, matches user
intuition), or store a `std::weak_ptr`-style liveness token and throw
"context has been destroyed" when it's gone.

### H4. No `lua_checkstack` anywhere in the codebase  [Confirmed]

`src/core/lua-runtime.cpp` — grep confirms zero `lua_checkstack` /
`luaL_checkstack` calls. Hot spots: `CallFunction` (pushes N args),
`PushLuaValue` (recursive, ~2 slots per nesting level, `kMaxDepth` allows
100), `ResumeCoroutine` / `ResumeAsyncStep` (push arg vectors).

Lua guarantees only `LUA_MINSTACK` (20) free slots; raw `lua_push*` does not
grow the stack in release builds. `ctx.set_global("x", fiftyLevelsDeepObject)`
or `fn.call(...30 args)` writes past the stack end — memory corruption. A host
function returning a deeply nested object pushes inside a C-call frame with
only the minimum guarantee.

**Recommendation:** `luaL_checkstack` at the top of every public method that
pushes a caller-controlled number of values, and once per recursion level in
`PushLuaValue` (or reserve `2 * remaining_depth` up front).

### H5. Registry-ref owners capture the converting `lua_State*`, which can be a collectable coroutine thread  [Confirmed]

`src/core/lua-runtime.h:28-33` (`MakeRegistryOwner` captures `L`);
`src/core/lua-runtime.cpp:1796` (`CaptureError(threadRef.thread)`), plus
`ToLuaValue(threadRef.thread, …)` for yielded/returned values in
`ResumeCoroutine`, and args converted inside `LuaCallHostFunction` when called
from a user coroutine.

The unref deleter runs `luaL_unref(L, …)` on whatever state converted the
value. When that state is a coroutine thread: coroutine yields a function →
JS holds the `LuaFunctionRef` (owner captured the thread pointer) → JS
releases the thread ref → GC collects the thread → the function ref drops →
`luaL_unref` through a dangling `lua_State*` → use-after-free.

**Recommendation:** resolve the main state in `MakeRegistryOwner` (via
`lua_rawgeti(L, LUA_REGISTRYINDEX, LUA_RIDX_MAINTHREAD)` or by passing the
runtime's `L_`) — the registry is shared, so the main state is always the
correct unref target.

### H6. `CaptureError` runs metamethod-capable calls unprotected on coroutine error paths → panic/abort  [Confirmed]

`src/core/lua-runtime.cpp:1147-1163` (`CaptureError` uses `lua_getfield` and
`luaL_tolstring`), reached with no protected frame from
`ResumeCoroutine:1796` and `ResumeAsyncStep:1937`.

`lua_getfield(L,-1,"message")` fires `__index`; `luaL_tolstring` fires
`__tostring`. On the `ExecuteScript` path the message handler already
normalized the error inside `lua_pcall`, but the coroutine resume paths call
`CaptureError` directly on the thread with no handler:
`resume` of a coroutine that does
`error(setmetatable({}, {__tostring=function() error("boom") end}))` →
unprotected raise → `lua_panic` → the Node process aborts.

**Recommendation:** run the field access and `tolstring` through a small
protected trampoline (the `ProtectedTableCall` machinery from the H2 fix is
reusable), falling back to a generic "unprintable error object" string.

### H7. Conversion exceptions escape N-API boundaries and skip async teardown  [Confirmed]

- `src/lua-native.cpp:696-697`: `GetGlobal` calls `runtime->GetGlobal` +
  `CoreToNapi` with no try/catch. `ToLuaValue` throws `std::runtime_error` on
  a >100-deep table; node-addon-api's callback wrapper catches only
  `Napi::Error`, so the exception unwinds into V8 → `std::terminate`. Nearly
  every other entry point wraps conversions; this one doesn't.
- `src/lua-native.cpp:1477-1487` (`DriveAsync`) and `:1504-1523`
  (`OnAwaitSettled`): `ResultsToJs` / `CoreToNapi` / `NapiToCoreInstance` run
  with no catch **before** `FinishAsync()`. An awaited promise resolving to a
  `Symbol`, an out-of-range BigInt, or a 101-deep object throws — the
  exception escapes (terminating via the static settlement callback, a
  non-`Napi::Error`), `is_busy_` never clears, the coroutine ref leaks, and
  the returned promise never settles. The context is permanently bricked.

**Recommendation:** wrap `GetGlobal`'s conversion in the same
try/catch-→-`ThrowAsJavaScriptException` pattern used elsewhere; in
`DriveAsync`/`OnAwaitSettled`, catch all exceptions, `FinishAsync()`, and
reject the deferred with the error.

### H8. A throwing print handler propagates a C++ exception through Lua's C call frames  [Confirmed]

`src/core/lua-runtime.cpp:787-791` (`LuaPrint`), `:813-817` (`LuaIoWrite`):
`runtime->output_handler_(out)` — a `std::function` that calls into JS and can
throw `Napi::Error` (`NODE_ADDON_API_CPP_EXCEPTIONS` is on) — has **no
try/catch**. Every other JS-calling bridge in the core catches
`std::exception`; this one lets the exception unwind through `lua_pcall`'s C
frames (Lua compiled as C → longjmp-based unwinding) — undefined behavior.
`ctx.set_print_handler(() => { throw new Error("x") });
ctx.execute_script("print(1)")` is enough to reach it.

**Recommendation:** catch in the handler invocation and either swallow (log to
stderr) or stage a Lua error via the `HostCallOutcome` pattern.

### H9. Worker-async guard coverage is still incomplete (three distinct gaps)  [Confirmed for (b); Reported for (a),(c)]

The CODE-REVIEW-1 H4 fix guarded the sites that review named, but:

- **(a) Queue window.** `RejectIfWorkerBusy` (`src/lua-native.cpp:118-125`)
  and `LuaFunctionCallbackStatic` (`:443-447`) gate on
  `runtime->IsAsyncMode()`, which the worker sets only when `Execute()` starts
  on the libuv thread. Between `worker->Queue()` and that first line, the
  guard passes while the worker begins running — a main-thread proxy access
  races the worker. These call sites should check the context's `is_busy_`
  (set synchronously before `Queue()`), which they currently never consult.
- **(b) Unguarded core hooks.** `UserdataIndex` / `UserdataNewIndex` /
  `ClassIndex` property paths and `UserdataGC`
  (`src/core/lua-runtime.cpp:240-339, 566-641, 226-238`) have **no
  `async_mode_` guard** (unlike `LuaCallHostFunction` / `UserdataMethodCall` /
  `JsSearcher`, verified guarded at `:430/:878/:974`). A worker-thread script
  reading `u.x` on a property-proxied userdata calls
  `Napi::ObjectReference::Value()` / `.Get()` **off the JS thread** — N-API
  misuse. Lua GC on the worker thread collecting a JS-backed userdata
  destroys a `Napi::ObjectReference` off-thread the same way.
- **(c) Finalizer unrefs race the worker.** The N-API finalizers owning the
  `*Data` structs run `luaL_unref` on the main thread at GC time with no
  synchronization; if V8 GC fires during a multi-second worker run, the
  registry is mutated concurrently with the worker's execution — heap
  corruption. Finalizers need to queue the unref while the worker owns the
  state.

**Recommendation:** (a) switch the Lua-side guards to the atomically-set
`is_busy_`; (b) add the `async_mode_` reject to the four unguarded hooks (a
worker-run script that touches a property-proxied userdata should fail with
the same "not available in async mode" error the host-function path gives);
(c) have finalizers push deferred unrefs onto a queue drained after the worker
completes (or on the next main-thread entry).

### H10. During an `execute_async` suspension, reentry is gated on the wrong flag  [Confirmed]

`src/lua-native.cpp:443-447` and `:118-125` check `IsAsyncMode()` — the
**worker** flag, which is `false` during coroutine-driven async. While an
`execute_async` run is suspended awaiting a promise (`is_busy_ == true`),
timers/microtasks can freely call previously returned Lua-function handles and
table Proxies, re-entering the shared `lua_State`:

- A re-entered Lua function calling a promise-returning host callback finds
  `IsAwaitDriverMode() == true`, overwrites `async_pending_promise_`
  (corrupting the suspended run's bookkeeping), and attempts `lua_yieldk`
  inside an unyieldable `lua_pcall` frame — "attempt to yield across a
  C-call boundary".
- `LuaFunctionCallbackStatic`'s `CallScope` at depth 0 **clears
  `js_error_registry_`** mid-run, dropping staged error objects the suspended
  run still needs for error reconstruction.

**Recommendation:** these entry points should reject when `is_busy_` is set
(consistent with every N-API instance method), or — if calling handles during
a suspension is meant to be supported — the await-driver state
(`async_pending_promise_`, driver-mode flag, error registry) must become
per-run rather than context-global.

---

## High severity — packaging & distribution

### P1. `npm install lua-native` fails for every consumer: `install` script depends on a devDependency  [Confirmed]

`package.json:23` — `"install": "cross-env GYP_DEFINES=... node-gyp-build"`.
`cross-env` is in `devDependencies` (`:58`); dependents never install a
dependency's devDependencies, so the lifecycle script exits non-zero and the
entire install aborts **even when a valid prebuild exists**. Note when fixing:
plain `node-gyp rebuild` also needs `skip_test` defined or `binding.gyp:140`'s
`"skip_test!=1"` condition errors — the env var can't simply be dropped.

### P2. Loader search order: `prebuilds/` shadows `build/Debug`, so tests exercise the prebuilt binary  [Confirmed — live in this repo]

`index.js:33-37` puts `['prebuilds', platformDir, baseName]` first.
`prebuilds/darwin-arm64/lua-native.node` exists and is what the Vitest suite
(which imports `index.js`) actually loads — directly contradicting the
CLAUDE.md requirement that tests run against the debug build. After any C++
change, `npm run build-debug && npm test` silently tests the **old** prebuilt
binary. Additionally, a prebuild that fails to `dlopen` throws
`ERR_DLOPEN_FAILED` (`index.js:73-74`), aborting the search even though a
working debug build sits later in the list.

**Recommendation:** search `build/Debug` → `build/Release` → `prebuilds` in
dev (or honor an env override like `LUA_NATIVE_DEV=1`), and treat
`ERR_DLOPEN_FAILED` as "try next path" rather than fatal.

### P3. Install-from-source and standard prebuilds are both broken for published consumers  [Confirmed for files list; Reported for naming]

- `package.json:35-43` — `files` omits `get_vcpkg_path.js`, but
  `binding.gyp:11` shells out to it (`npm run get-vcpkg-include`); a
  compile-from-source install of the published tarball fails during gyp
  expansion. (Even shipped, source builds require vcpkg + Lua on the end-user
  machine with no graceful "prebuild required" message.)
- `index.js:79-88` — in a registry install there is no `build/` directory, so
  the loader throws "Build directory not found" **before** the
  `node-gyp-build` fallback that would have found a standard-named prebuild.
  And `npm run prebuild` (prebuildify) emits `node.napi.node`, which the
  explicit `prebuilds/<platform>/lua-native.node` path never matches — the
  checked-in `lua-native.node` cannot have been produced by the repo's own
  prebuild script.
- `prebuildify` is invoked by the `prebuild` script but is not a dependency at
  all (absent from `package.json` and `node_modules`)  [Confirmed].

**Recommendation:** make `node-gyp-build` the primary loader path (it handles
prebuildify naming), align the prebuild filename convention, add
`get_vcpkg_path.js` to `files`, and add `prebuildify` to devDependencies.

---

## Medium severity

### M1. Awaiting a JS promise from inside a user coroutine yields to the wrong resumer  [Reported]

`src/core/lua-runtime.cpp:1020-1043`. `HostCallOutcome::Yield` suspends the
*innermost* resume boundary. Under `execute_async`, a script that does
`local co = coroutine.create(function() return jsAsyncFn() end);
coroutine.resume(co)` suspends the **inner** coroutine; the script's `resume`
returns immediately with no values, and when the promise settles the binding
resumes the *driver* thread — the value is delivered to the wrong frame (or
resumes a finished driver, compounding M2). The core should raise a clear
error ("cannot await inside a user coroutine") when the yielding state is not
the driver thread, or the feature should be documented as top-level-only.

### M2. `ResumeAsyncStep` still resumes a *finished* coroutine  [Confirmed]

`src/core/lua-runtime.cpp:1884-1891`. The CODE-REVIEW-1 M6 fix rejects
`status != LUA_OK && != LUA_YIELD`, but a coroutine that has already
**finished** has status `LUA_OK` with an empty stack — exactly what
`ResumeAsyncStep` leaves behind — and passes the check. `ResumeCoroutine`
(`:1740`) additionally checks stack emptiness for the `LUA_OK` case; this
function needs the same guard (reachable via the H1/H10 reentrancy windows).

### M3. `GetTableKeys` runs raw `lua_next` unprotected with no type check  [Confirmed]

`src/core/lua-runtime.cpp:1565-1582`. Unlike `TablePairs` (checks
`lua_istable`) and the `ProtectedTable*` trampolines, `GetTableKeys` calls
`lua_next` directly on whatever `lua_rawgeti` produced. A stale/released ref
pushes nil → `lua_next` on a non-table → api-check violation / unprotected
error → UB or panic. Also uses NUL-truncating `lua_tostring` for keys (L3).

### M4. `lua_getglobal` / `lua_setglobal` unprotected against a metatable on `_G`  [Confirmed pattern]

`src/core/lua-runtime.cpp:1289-1310` (`SetGlobal`/`GetGlobal`), `:1621-1629`
(`GetGlobalRef`), plus `RegisterFunction`/`SetGlobalMetatable`. These respect
metatables on the globals table and run outside any protected frame:
`setmetatable(_G, {__index=function() error("trap") end})` in a script, then
`ctx.get_global("missing")` from JS → unprotected raise → panic → process
abort. Same class as the fixed H2, one table further out. Route through the
existing protected-call shim.

### M5. With `maxMemory` set, allocation failure in unprotected API paths aborts the process  [Reported]

Class finding (e.g. `src/core/lua-runtime.cpp:1294, 1372, 1595`). Any
allocating Lua call made directly from C++ outside `lua_pcall` —
`lua_newtable` in `CreateTableFrom`, `lua_pushstring` in `SetGlobal`,
`luaL_ref` — can raise `LUA_ERRMEM` when the configured limit is hit, and an
unprotected raise panics. The memory-limit feature thus converts "operation
fails" into "process aborts" on exactly the paths it is meant to protect.
Longer-term this argues for running these mutations through protected shims
too.

### M6. Cross-context round-trip markers are trusted without a runtime-identity check  [Confirmed]

`src/lua-native.cpp:1732-1746`. The `_tableRef` / `_userdata` externals are
copied by ref index without verifying `data->runtime` matches *this*
context's runtime. Passing a table Proxy from context A into
`ctxB.set_global(...)` executes `lua_rawgeti(B, A_ref)` — dereferencing an
unrelated slot in B's registry: silent data corruption. (The `__luaClassRef`
path partially mitigates via its `js_userdata_` lookup.) Compare runtimes and
fall through to deep copy on mismatch.

### M7. `register_class` lets user metamethods overwrite the built-in `__gc`/`__index`/`__newindex`  [Confirmed]

`src/core/lua-runtime.cpp:519-546`. The built-ins are installed first, then
the user `metamethods` loop writes unconditionally. A definition containing
`metamethods: { __gc: ... }` (or `__index`) silently replaces `UserdataGC` /
`ClassIndex`: refcounts never decrement (permanent `ObjectReference` leaks per
instance), methods/properties break, and a user `__gc` host function is
invoked during `lua_close` in the destructor — a JS call during teardown.
Reject or ignore the reserved keys with a clear error.

### M8. Type-converter loop can dereference a reallocated vector  [Confirmed]

`src/lua-native.cpp:1765-1769`. The registry is iterated by range-for while
`match`/`convert` callbacks run arbitrary JS; a callback that calls
`register_type_converter` triggers `emplace_back` reallocation and the loop's
reference dangles — use-after-free. Iterate by index, or reject reentrant
registration while a conversion is in flight.

### M9. Every JS function crossing into Lua permanently grows `js_callbacks_` / `host_functions_`  [Confirmed]

`src/lua-native.cpp:1680-1687`. Each crossing mints `__js_callback_N`, a
persistent `FunctionReference`, and a stored host function — with no removal
path. Callback-heavy patterns (`luaFn(() => {})` in a loop/interval) grow
memory unboundedly for the context's life. This is the same leak class
CODE-REVIEW-1's M2 fixed for the `*Data` wrappers, now for function values;
the fix shape is the same (finalizer- or refcount-driven removal keyed to the
Lua closure's lifetime).

### M10. Number→int64 upper-bound check is off by one: `2**63` passes and the cast is UB  [Confirmed]

`src/lua-native.cpp:1709-1711` and `:1824-1826`.
`num <= static_cast<double>(int64_max)` compares against exactly 2⁶³ (the
double rounds up), so `ctx.set_global("x", 2**63)` passes the guard and
`static_cast<int64_t>` of an out-of-range double is UB (in practice
`INT64_MIN`: x becomes −9223372036854775808). Use `num < 9223372036854775808.0`
as the upper bound.

### M11. No `HandleScope` in Lua→JS reentrant callbacks — handles accumulate for the whole script run  [Reported]

`src/lua-native.cpp:1232-1260` (host-call wrapper), `:1595-1598` (print
handler), `:600-621` (property getter/setter). Every `CoreToNapi` result and
`Call` return created during a long script run accumulates in the outer
N-API entry's scope: `for i=1,1e7 do cb(i) end` holds tens of millions of
handles until the call returns. Wrap each callback body in
`Napi::HandleScope` (escape values that must survive).

### M12. A JS searcher's staged error can be mis-raised by a later, unrelated failure  [Reported]

`src/core/lua-runtime.cpp:900-916` with `src/lua-native.cpp:1258`. When a
searcher throws, the wrapper stages `pending_error_value_`, but `JsSearcher`'s
catch raises its own string without consuming it. The stale structured error
survives until the next wrapper error that *doesn't* stage (e.g. the
"returned a Promise" throw), at which point `LuaCallHostFunction` sees
`HasPendingErrorValue()` and raises the **old** error object. Clear or consume
the staged value on the searcher error path.

### M13. `index.d.ts` fails to re-export seven public types  [Confirmed]

`PcallResult`, `CompileOptions`, `MetatableDefinition`, `UserdataMethod`,
`UserdataOptions`, `ClassDefinition`, `LuaTableHandle` are declared in
`types.d.ts` and referenced by exported method signatures, but absent from the
`index.d.ts` export list — `import type { UserdataOptions } from 'lua-native'`
is a compile error.

### M14. CMake output directories don't match what the loader and test runner search  [Reported]

`CMakeLists.txt:411-421` outputs to `build/Debug/macos` / `build/Debug/windows`;
`index.js:36-37` searches `build/Debug/darwin-arm64` etc., and
`run-tests.js` checks `build/Debug/windows` but not `build/Debug/macos`. A
CMake-built binary is never found (or a stale node-gyp/prebuild binary loads
instead), and `npm run test-cpp` on macOS after a CMake build reports the test
binary missing.

### M15. `MACOSX_DEPLOYMENT_TARGET: "26.0"` restricts node-gyp binaries to the newest macOS  [Confirmed]

`binding.gyp:124, 266`. Prebuilds compiled with this fail to `dlopen` on
macOS 15 and earlier; CMake builds don't set it, so the two build systems
produce artifacts with different OS floors. Almost certainly unintended for a
published library.

---

## Low severity

### L1. `SetAllowBytecode(true)` doesn't unwrap the `SafeLoad` shim  [Reported]
`src/core/lua-runtime.cpp:823-834`. Re-enabling restores the flag but leaves
Lua-side `load()` wrapped text-only forever; repeated `false` calls stack
wrappers.

### L2. `strtoll` key parsing accepts leading whitespace and `+`  [Reported]
`src/core/lua-runtime.cpp:55-64`. `table[" 12"]` / `table["+12"]` silently
alias integer key `12` beyond the documented `"123"` caveat.

### L3. `GetTableKeys` truncates keys with embedded NULs  [Confirmed]
`src/core/lua-runtime.cpp:1573-1576` uses `lua_tostring` where `TablePairs`
and `ToLuaValue` are length-aware.

### L4. `~LuaRuntime` doesn't clear `userdata_gc_callback_` / `output_handler_` before `lua_close`  [Reported]
`src/core/lua-runtime.cpp:186-202`. `lua_close` fires `__gc` → JS callbacks
during teardown; safety currently depends on the binding's destruction order.
Clear them first (the destructor already documents this pattern for other
members).

### L5. `AwaitCookie` freed on first settlement callback — a hostile thenable can double-settle  [Reported]
`src/lua-native.cpp:1540-1554`. A `Promise` subclass whose `then` invokes
callbacks twice causes read-after-free of the cookie (the generation check
can't help; the cookie itself is gone). A never-settling promise leaks it
(minor). Guard with a settled flag inside the cookie, freed via a finalizer.

### L6. Hidden owner properties are `configurable` and deletable from JS  [Reported]
`src/lua-native.cpp:13-23, 1077`. `delete fn.__luaFnOwner; gc(); fn()` frees
the `*Data` while bound functions still hold the raw pointer. Deliberate
misuse, but `configurable: false` closes it.

### L7. `js_error_registry_` entries accumulate on paths without a `CallScope`  [Reported]
`src/lua-native.cpp:2033-2106` (coroutine resume), table traps. Staged JS
errors on these paths are neither consumed (fidelity silently absent) nor
cleared until an unrelated guarded call runs.

### L8. `cancel()` is a silent no-op for worker-thread async; `IsCancelRequested` branch in `OnAwaitSettled` is dead  [Confirmed]
`src/lua-native.cpp:1497-1502, 1556-1565`. Nothing ever calls
`RequestCancel()`; worker runs cannot be interrupted at all. (Tracked as gap
A3b in `BRIDGE-GAP-ANALYSIS.md` — hook-based cancellation.)

> **Partially addressed** (Execution Time Limits): the A3b count-hook now
> exists (`maxInstructions`) and polls `IsCancelRequested()`, so a compute-bound
> loop *is* interruptible when a cancel is signalled. The still-open half is
> that the worker-thread `cancel()` path does not yet call `RequestCancel()`.

### L9. `binding.gyp` misc  [Reported]
`-fno-exceptions` (a GCC flag) inside the MSVC-only `OS=='win'` blocks
(`:36-38, 178-180`); `binary.napi_versions: [3,6,8,9]` metadata contradicts
the actual `NAPI_VERSION=8` build (`package.json:44-51`); the
`-Dskip_test=0/1` args to `cmake-build.js` are silently ignored
(`package.json:26-27` vs `cmake-build.js:14-17`).

---

## Verified and rejected (spot-checks that held up)

For the record, suspicions the review pursued and refuted against the code:

- Generation-cookie double-free on normal paths: exactly one of
  resolve/reject fires per real promise; stale settlements correctly dropped.
- Worker vs. driver `is_busy_` TOCTOU on the N-API methods: both flags are
  set/read on the JS thread before `Queue()` — no window there (the windows
  that do exist are H9a/H10).
- `*Data` finalizers vs. `lua_close`: the per-wrapper
  `shared_ptr<LuaRuntime>` guarantees the state outlives every unref (the
  surviving issue is the *thread* of the unref, H9c, and the *context*
  pointer, H3 — not the finalizer itself).
- `async_co_` release vs. runtime destruction order in `~LuaContext`: member
  order makes it safe.
- `isSequentialArray`: airtight, including hole/border cases.
- `LuaAllocator` shrink-under-limit invariant: holds.
- `SafeLoad` zero-arg edge, `MessageHandler` reentrant error,
  `PushLuaValue` of released refs (`LUA_NOREF` → nil), stock-`ipairs`
  semantics of `ProtectedTableICollect`: all graceful.
- types.d.ts method coverage: all 26 registered native methods declared, no
  phantoms; doc-comment behavioral claims (null-for-unset, coroutine result
  shape, BigInt round-trip, release semantics, pcall shape) verified accurate.
- Test hygiene: no skipped/`only` tests; all July 2026 features have real
  coverage (subject to the P2 caveat about *which binary* they exercise).

---

## Suggested priority order

1. **P1–P3** — the package is currently uninstallable for consumers and the
   test suite exercises the wrong binary. Small, mechanical fixes with the
   highest blast radius; fix P2 first so every subsequent native fix is
   actually tested.
2. **H1, H2, H7 (async driver hardening)** — reentrancy guard for
   `cancel`, a persistent context ref across suspensions, and
   catch-→-`FinishAsync`-→-reject in the drive path. One focused PR; these
   three interact.
3. **H3 (context lifetime for handles)** and **H5 (main-state registry
   owners)** — the two remaining use-after-free classes.
4. **H4, H6, M4 (Lua API discipline)** — `luaL_checkstack` coverage,
   protected `CaptureError`, protected globals access. Same theme as
   CODE-REVIEW-1's H1/H2; closes the remaining panic/UB surface.
5. **H8–H10** — exception barrier in the print handler; the three
   worker-guard gaps; the wrong-flag reentrancy gate. (H10's clean fix may
   fall out of the H1/H2 work if driver state becomes per-run.)
6. **M1–M12** — independently small; M7 (reserved metamethods), M8
   (converter reentrancy), and M10 (2⁶³ bound) are one-liners worth batching
   immediately.
7. **M13–M15, L1–L9** — packaging polish and hardening, opportunistically.
