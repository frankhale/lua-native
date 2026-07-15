# CODE-REVIEW-3

**Date:** July 15, 2026
**Scope:** Third full pass over the native sources (`src/core/lua-runtime.h/.cpp`,
`src/lua-native.h/.cpp`, `src/lua-async-worker.h`) plus the JS/TS surface and
packaging (`index.js`, `index.d.ts`, `types.d.ts`, `package.json`,
`binding.gyp`). Line numbers refer to the code as of commit `34d40c3`.

**Method:** Complete end-to-end read of every native source file, with two
explicit goals beyond fresh bug-hunting: (1) verify that the CODE-REVIEW-1 /
CODE-REVIEW-2 fixes are actually present and correct in the tree (not just
recorded as resolved), and (2) check whether the *patterns* those fixes
established (protected global access, staged-error raising, `DefineHiddenProp`
ownership, `CallScope` hygiene, identity checks on round-trip markers) were
applied to **all** the sites they apply to, not only the sites the earlier
reviews happened to name. Every finding below was re-verified against the
source at the cited lines before being written down.

**Baseline:** 438 TypeScript tests and 178 C++ tests pass, run during this
review against a freshly built `build/Debug/lua-native.node` (built today,
newer than the checked-in prebuild; the loader verifiably prefers it — the
CODE-REVIEW-2 P2 fix is working as intended).

---

## Resolution status (July 15, 2026)

All findings are resolved **except M5, which is deferred by decision** (see its
entry). After the fixes: 438 TypeScript tests and 178 C++ tests still pass, plus
a standalone behavioral harness (run with `--expose-gc`) that confirmed the H1
deep-nested-error, M4 throwing-`__tostring`, M1 cross-context-resume, L2
released-handle, L4/L7 register_class, H2 cancel-during-settle, H3
detached-handle-method + non-deletable owner, and M2 reclaim (0 bytes/iteration
steady-state growth over 20,000 anonymous-callback crossings, and a retained
callback staying callable after GC) paths.

| # | Status | Resolution |
|---|--------|------------|
| H1 | ✅ Done | `CaptureError` catches its own `ToLuaValue` throw and falls back to the display string; `CallFunction` guards the arg-push loop; the async workers use an RAII teardown (`SetAsyncMode(false)` + `EndWorkerUnrefDeferral`); `DriveAsync` sets `async_resuming_` via an RAII flag. |
| H2 | ✅ Done | `OnAwaitSettled` re-checks `async_co_`/`async_deferred_`/`gen` immediately before `DriveAsync`, so a `cancel()` (or a new run) triggered by user JS during value conversion can't drive a disengaged optional or inject into a newer run. |
| H3 | ✅ Done | The table-handle owner `External` is rooted on every method (via `DefineHiddenProp`) and `_tableRef` is non-configurable; the Proxy traps each root the owner too, so `delete proxy._tableRef` can't free the data while traps hold it (target `_tableRef` left configurable to preserve the ownKeys invariant). |
| M1 | ✅ Done | `resume()` rejects a coroutine whose `runtime` differs from this context's. |
| M2 | ✅ Done | Anonymous nested JS callbacks register via `RegisterReclaimableHostFunction`; the materialized Lua closure carries a sentinel userdata whose `__gc` decrements a per-name live count and, at zero, drops the `host_functions_` entry and (off worker threads) the paired `js_callbacks_` reference. |
| M3 | ✅ Done | `CreateUserdataGlobal`/`CreateProxyUserdataGlobal`, `SetUserdataMethodTable`, `RegisterClass`, `SetGlobalMetatable`, `RegisterModuleTable`, `AddSearchPath`, `InstallOutputRedirection`, `SetAllowBytecode`, `AddJsSearcher`, and the plain `CreateCoroutine` overload now run their builds/writes inside `RunProtected` (protects both the `_G`-metatable raise and the OOM-under-`maxMemory` paths). |
| M4 | ✅ Done | `LuaPrint`/`LuaIoWrite` assemble via a `luaL_Buffer` so a raising `__tostring` longjmps over no live `std::string`; the `lua_dump` writer lambdas trap `std::bad_alloc` and report a status, checked by the compilers. |
| M5 | ⏸️ Deferred | `MACOSX_DEPLOYMENT_TARGET` left at `"26.0"` by decision (single current user). Lower to `"11.0"` before publishing; the CODE-REVIEW-2 table row should read "deferred," not "fixed." |
| L1 | ✅ Done | `MessageHandler` probes `__jsErrorId` with `lua_rawget`. |
| L2 | ✅ Done | Round-tripping a released table handle throws instead of pushing nil. |
| L3 | ✅ Done | `CallScope` added to the `has` / `ownKeys` / `getOwnPropertyDescriptor` Proxy traps. |
| L4 | ✅ Done | `register_class` validates reserved metamethods (and rejects duplicates) before registering any callback. |
| L5 | ✅ Done | The dead static `NapiToCore` twin is removed; `ReleaseTableRef` routes through `UnrefOrDefer`. |
| L6 | ✅ Done | `class_id`/`mt_id`/`mod_id` are `uint64_t`; `GetTableLength` returns `int64_t`. |
| L7 | ✅ Done | `register_class` rejects a duplicate class name via a per-context `registered_classes_` set. |
| Observation | ✅ Done | `types.d.ts` documents that `maxInstructions` bounds pure-Lua compute only (the budget resets on host-callback re-entry). |

The original findings follow unchanged for reference.

---

## Relationship to the prior reviews

The CODE-REVIEW-1 and CODE-REVIEW-2 remediations are, with two exceptions,
**present and correct**. Spot-verified in place this pass: the staged-error
(`HostCallOutcome`) restructuring, the shared-ownership registry refs with
main-thread resolution (H5), the H9c deferred-unref queue and its mutex
discipline, the protected-globals refactor for `get_global` / `set_global` /
`register_function` / `get_global_ref` / `set_metatable` /
`HasPackageLibrary`, `RunProtected` and its light-trampoline OOM reasoning,
the `async_self_ref_` rooting + generation cookie + `async_resuming_` cancel
deferral, the L5 cookie ownership, the 2⁶³ bound in both converters, the
`TableKey` variant API, the loader search order, and the `index.d.ts`
re-exports.

The two exceptions are **bookkeeping failures, not code failures**, and both
matter beyond their individual impact:

1. **CODE-REVIEW-2's resolution table is off by one in the M-series.** The
   table's "M9" row describes the 2⁶³ bound fix (the *text's* M10), its "M10"
   row describes the HandleScope fix (the text's M11), and the text's real M9
   — **unbounded `js_callbacks_` / `host_functions_` growth for every JS
   function crossing into Lua** — has no resolution row at all and was never
   fixed (see M2 below).
2. **M15 (`MACOSX_DEPLOYMENT_TARGET: "26.0"`) is recorded as "✅ Fixed |
   lowered … to 11.0 (both blocks)" but the fix is not in the tree** — both
   blocks still say `26.0`, and `git log -S` shows the value has never changed
   since the initial commit. The code change is **deliberately deferred** (the
   author is the only current user, so the OS floor is presently harmless);
   the point here is the record, which should read "deferred," not "fixed"
   (see M5 below).

Recommendation for process: when closing a review, verify each resolution row
against the diff that claims to implement it, and keep the text numbering and
the table numbering mechanically identical.

The remaining findings follow the established pattern of the second review:
the fixes were applied correctly *at the named sites*, but several hazard
classes have additional sites the earlier enumerations missed.

---

## Overall assessment

The architecture and the code quality trajectory remain strong. The new
findings cluster in five areas:

1. **C++ exceptions escaping on error-capture paths** — `CaptureError` can
   itself throw, and several binding entry points don't guard the core call,
   so an unusual (but ordinary-API) error object terminates the process (H1).
2. **A remaining reentrancy window in the async driver** — the settle path
   converts the awaited value (which can run user JS) *between* its liveness
   check and the resume (H2).
3. **JS-side ownership of native data for table handles** — the `__luaFnOwner`
   ownership pattern from L6 was not applied to the table-handle methods or
   the Proxy target, leaving an idiomatic-destructuring use-after-free (H3).
4. **Incomplete application of established patterns** — protected global
   access and protected allocation (M3), the staged-raise discipline in
   `LuaPrint`/`LuaIoWrite` (M4), identity checks on `resume()` (M1),
   `CallScope` on three of the five Proxy traps (L3).
5. **Tracking hygiene** — the two dropped findings above (M2, M5).

---

## High severity

### H1. `CaptureError` can throw a C++ exception, and multiple entry points let it escape the N-API boundary → process termination

`src/core/lua-runtime.cpp:1418` — `CaptureError` begins with
`last_error_value_ = ToLuaValue(L, -1);` outside any try/catch. `ToLuaValue`
throws `std::runtime_error` when the value nests deeper than `kMaxDepth`
(`:1651-1653`) or when `lua_checkstack` fails (`:1657-1659`). A plain
(metatable-less) table nested >100 deep thrown as an error object reaches this
path from ordinary API usage:

```js
ctx.execute_script(
  "local t={} local c=t for i=1,200 do c.n={} c=c.n end error(t)")
```

`CaptureError` is called on every error path: `ExecuteScript` (`:1509,1515`),
`ExecuteFile` (`:1544,1549`), `LoadBytecode` (`:1483`), `CallFunction`
(`:1628`), `ResumeCoroutine` (`:2186`), `ResumeAsyncStep` (`:2347`). The
exception propagates out of the core method, and these binding entry points
do **not** wrap the core call in try/catch:

- `LuaContext::ExecuteScript` (`src/lua-native.cpp:1446`)
- `LuaContext::ExecuteFile` (`:1464`)
- `LuaContext::LoadBytecode` (`:1138`)
- `LuaContext::CreateCoroutine` (`:2250`)
- `LuaContext::ResumeCoroutine` (`:2322`)
- `LuaFunctionCallbackStatic` (`:504`) — a returned Lua-function handle
- `DriveAsync` (`:1603`, via `ResumeAsyncStep`)
- the async workers' `Execute()` (`src/lua-async-worker.h:36, :73`)

node-addon-api's callback wrapper (with `NODE_ADDON_API_CPP_EXCEPTIONS`)
catches only `Napi::Error`; a `std::runtime_error` unwinds through the
`extern "C"` N-API boundary — in practice `std::terminate`. This is the same
hazard class as CODE-REVIEW-2's H7, which fixed `GetGlobal` but did not
enumerate the *throw source inside `CaptureError` itself*, which is reachable
from every execution path, not just conversion-heavy ones.

Two secondary consequences on the paths that *do* survive (the worker thread,
where `AsyncWorker` catches `std::exception`):

- **Worker flag corruption** (`src/lua-async-worker.h:34-38`): if
  `ExecuteScript` throws, `SetAsyncMode(false)` and
  `EndWorkerUnrefDeferral()` are skipped. `worker_active_` stays true forever
  (every future registry unref is queued and never drained — a permanent
  leak), and `async_mode_` stays true forever (every future host callback,
  property access, and searcher fails with "not available in async mode").
  The context is permanently degraded.
- **`async_resuming_` stuck true** (`src/lua-native.cpp:1602-1604`): if
  `ResumeAsyncStep` throws between the two assignments, every future
  `cancel()` takes the defer branch and full teardown never runs.

**Recommendation.** Fix at the source: wrap the `ToLuaValue` call in
`CaptureError` in try/catch and fall back to the protected-`__tostring` /
type-name string capture it already contains (the structured value is then
simply absent — `LuaErrorToJsValue` already handles that). Belt-and-braces:
add the try/catch → `ThrowAsJavaScriptException` pattern to the binding entry
points listed above (matching `GetGlobal`), make the worker's
`Begin…/SetAsyncMode` bracket an RAII guard, and set `async_resuming_` via a
small scope guard.

### H2. `cancel()` re-entered during `OnAwaitSettled`'s conversion window → disengaged-optional dereference or cross-run resume injection

`src/lua-native.cpp:1676-1717`. The liveness/generation guard runs at entry
(`:1682`), but **between** that check and the `DriveAsync` call (`:1716`) the
settle path executes code that can run arbitrary user JS:

- resolve path: `NapiToCoreInstance(value)` (`:1707`) — invokes registered
  type converters (`:2005-2010`), object getters, `Array.from` over Map/Set
  entries (`:84-107`), and Proxy traps on the awaited value;
- reject path: `value.As<Napi::Object>().Get("message")` (`:1689-1690`) and
  `StageJsError`'s `Get("name")` / `Get("stack")` (`:1299-1306`) — all
  getter-capable.

If that user JS calls `ctx.cancel()`: `async_resuming_` is false (we are not
inside a resume), so `Cancel` (`:1754-1769`) takes the full-teardown branch —
`FinishAsync()` resets `async_co_` and `async_deferred_`. Control returns to
`OnAwaitSettled`, which proceeds to `DriveAsync`, which immediately evaluates
`*async_co_` (`:1603`) on a **disengaged `std::optional`** — undefined
behavior.

Worse variant: after the reentrant `cancel()`, `is_busy_` is false, so the
same user JS can start a *new* `execute_async`. `async_co_` is re-engaged
for the new run, and the unwinding old settle then **resumes the new run's
coroutine with the old run's settlement value** — exactly the cross-run
injection the generation cookie exists to prevent, bypassed because the
generation is only checked at entry.

This is the same reentrancy class as CODE-REVIEW-2's H1 (fixed for the
*resume* window via `async_resuming_`); the *settle-conversion* window was
not enumerated.

**Recommendation.** Re-check `async_co_ && async_deferred_ && gen ==
async_generation_` immediately before the `DriveAsync` call (a three-line
guard), or widen the `async_resuming_` window (rename it, e.g.
`async_driver_active_`) to cover the whole settle path so a reentrant
`cancel()` defers exactly as it does during a resume.

### H3. Table-handle methods use-after-free on detach; `_tableRef` owner property is deletable

`src/lua-native.cpp:1147-1176` (`CreateTableHandle`). The handle's methods
(`get`/`set`/`has`/`length`/`pairs`/`ipairs`/`release`, `:1167-1173`) each
capture the raw `LuaTableRefData*` as `Napi::Function` data, but the **sole
owner** of that data is the `_tableRef` External's finalizer, and the
External is a property of the handle object only. Two failure modes:

1. **Idiomatic destructuring** — no misuse required:

   ```js
   const { get } = ctx.get_global_ref("config");
   // ... handle object now unreferenced → GC → finalizer deletes the data
   get("key");   // info.Data() → freed memory → use-after-free
   ```

   A detached method does not root the handle, so the data dies while the
   method still points at it. Even `RejectIfWorkerBusy`'s first dereference
   (`data->ContextLive()`, `:129`) reads freed memory.

2. **Deletable owner** — the `_tableRef` descriptor is built by hand with
   `configurable: true` (`:1163`), so `delete handle._tableRef; gc()` frees
   the data while the still-attached methods reference it. This is exactly
   the L6 class fixed for `__luaFnOwner` via `DefineHiddenProp(...,
   configurable: false)` — but `CreateTableHandle` predates that helper and
   was not converted.

The Proxy variant (`:2197-2227`) has the second vector only: the target's
`_tableRef` is also `configurable: true` (`:2212`) and there is no
`deleteProperty` trap, so `delete proxy._tableRef` forwards to the target and
frees the data the five traps still hold. (Detached-trap exposure doesn't
exist — the handler object is never exposed to JS.)

**Recommendation.** For the handle: root the owner External on each method
function as well (a hidden non-configurable prop, one `DefineHiddenProp` call
per method), or give each method shared ownership (e.g. the data behind a
`shared_ptr` with one External finalizer per function). For both sites,
create `_tableRef` through `DefineHiddenProp` (non-configurable). **Caveat
for the Proxy:** making the target's `_tableRef` non-configurable obliges the
`ownKeys` trap (which currently omits it, `:225-241`) to include it, or
`Reflect.ownKeys(proxy)` throws a Proxy-invariant TypeError — either add it
to the trap result or solve the Proxy side purely with trap-side shared
ownership and leave the target property configurable.

---

## Medium severity

### M1. Cross-context coroutine `resume()` has no identity check → cross-VM `lua_resume`

`src/lua-native.cpp:2281-2322`. `resume()` extracts the `_coroutine`
External (`:2304`) and calls
`runtime->ResumeCoroutine(threadData->threadRef, args)` (`:2322`) using
**this** context's runtime, without verifying
`threadData->runtime.get() == runtime.get()`. Passing a coroutine object
created by context A into `ctxB.resume(...)` executes
`lua_resume(A_thread, B_main_state, ...)` — two unrelated Lua universes in
one call, undefined behavior. CODE-REVIEW-2's M6 added exactly this identity
check to the `_tableRef` / `_userdata` / `__luaClassRef` round-trip markers;
the coroutine handle was the one cross-context surface it missed.

**Recommendation.** Reject with a clear error when the runtimes differ
(mirroring the M6 policy; a deep-copy fallback is meaningless for a
coroutine).

### M2. Every JS function crossing into Lua permanently grows `js_callbacks_` / `host_functions_` (the finding dropped from CODE-REVIEW-2's resolution table)

`src/lua-native.cpp:1904-1911`. The function branch of `NapiToCoreInstance`
mints a fresh `__js_callback_N` name, a persistent `FunctionReference`, and a
stored host `std::function` on **every crossing** — there is no removal path
anywhere in the codebase (no `js_callbacks_.erase` exists outside of nothing;
grep confirms). A callback-heavy pattern such as

```js
setInterval(() => luaFn(x => x + 1), 10);   // one leak per tick
```

grows all three structures for the life of the context, even though each Lua
closure becomes garbage immediately. This is the identical leak class
CODE-REVIEW-1's M2 fixed for the `*Data` wrappers, still open for function
values. Related minor variant: `set_global("f", 5)` after
`set_global("f", fn)` leaves the stale `js_callbacks_["f"]` /
`host_functions_["f"]` entries behind.

**Recommendation.** Two composable steps: (a) dedupe — tag the JS function
with a hidden marker carrying its assigned name so the *same* function object
crossing repeatedly reuses one entry; (b) reclaim — tie entry removal to the
Lua closure's collection (e.g. give the pushed closure a userdata upvalue
whose `__gc` queues the name for removal, drained on the next main-thread
entry, reusing the H9c deferral idea).

### M3. Residual raw-global-access and unprotected-allocation sites (the M4/M5 classes, incompletely applied)

The protected-globals / `RunProtected` treatment covers the sites
CODE-REVIEW-2 named, but these remain, all reachable from the public API:

Raw `lua_setglobal` / `lua_getglobal` (a raising `__index`/`__newindex` on a
`_G` metatable → unprotected raise → panic → **process abort**):

- `CreateUserdataGlobal` / `CreateProxyUserdataGlobal`
  (`src/core/lua-runtime.cpp:519, :527`) — reached by `set_userdata()`
- `RegisterClass` (`:737`) — reached by `register_class()`
- `RegisterModuleTable` (`:910`, `lua_getglobal("package")`) — reached by
  `register_module()` (note `HasPackageLibrary` right above it *was*
  converted; the second read was missed)
- `InstallOutputRedirection` (`:948, :950`) — reached by
  `set_print_handler()` and the constructor's `print` option
- `SetAllowBytecode` (`:1015, :1018, :1024, :1027`) — reached by the
  `allowBytecode` option
- `AddJsSearcher` (`:1052`) — reached by `add_searcher()`

Unprotected allocation under `maxMemory` (`LUA_ERRMEM` → panic → abort, the
M5 class):

- `lua_newuserdata` in the two userdata-global creators (`:516, :524`)
- `luaL_newmetatable` / `lua_newtable` / closure pushes in `RegisterClass`
  (`:691-737`), `SetUserdataMethodTable` (`:563`), `SetGlobalMetatable`'s
  metatable build (`:847-861`), `RegisterModuleTable` (`:918-932`)
- `lua_pushstring` of the joined path in `AddSearchPath` (`:896`)
- the plain `CreateCoroutine` overload (`:2090-2096`,
  `lua_newthread`/`luaL_ref`) — contrast `CreateCoroutineFromScript`, which
  got the `RunProtected` treatment; this one didn't

Repro for the first class:
`ctx.execute_script("setmetatable(_G, {__newindex=function() error('t') end})")`
then `ctx.set_userdata("u", {})` → abort.

**Recommendation.** Same fixes as before, applied to the remaining sites:
globals through the `lua_rawgeti(LUA_RIDX_GLOBALS)` + protected-set pattern
`SetGlobal` uses; allocating builds inside `RunProtected`.

### M4. `LuaPrint` / `LuaIoWrite`: `luaL_tolstring` can raise over a live `std::string` (H1-class residual)

`src/core/lua-runtime.cpp:962-971` (`LuaPrint`), `:990-997` (`LuaIoWrite`).
`std::string out` is alive while `luaL_tolstring` runs, and `luaL_tolstring`
fires `__tostring`, which can raise:

```lua
print(setmetatable({}, {__tostring = function() error("x") end}))
```

The raise longjmps over `out`'s destructor — a leak per occurrence and
formally UB (the exact pattern CODE-REVIEW-1's H1 eliminated from the other
six C callbacks; these two were added later for E1 without the staged
discipline). Additionally, `out.append` can throw `std::bad_alloc`, which
would unwind a C++ exception through Lua's C frame. Same sub-class:
the `lua_dump` writer lambdas in `CompileScript` / `CompileFile`
(`:1283-1288, :1307-1312`) call `std::vector::insert`, which can throw
`bad_alloc` across `lua_dump`'s C frame; a writer should trap and return a
nonzero status instead.

**Recommendation.** Build the output line under protection: run the per-arg
stringification through the existing `ProtectedToString` trampoline (or
assemble with `luaL_Buffer` on the Lua side of the boundary), and only then
copy once into the C++ string with no raise-capable call afterwards.

### M5. `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` — the CODE-REVIEW-2 M15 fix was recorded as done but never applied — ⏸️ DEFERRED (intentional)

`binding.gyp:127, :266`. Both `xcode_settings` blocks still pin the
deployment target to macOS 26; `git log -S "MACOSX_DEPLOYMENT_TARGET"` shows
the value has never been changed in any commit. Prebuilds compiled with this
fail to `dlopen` on anything older than the current-year macOS, and the
CMake build (which doesn't set it) produces artifacts with a different OS
floor. CODE-REVIEW-2's resolution table marks M15 "✅ Fixed"; it isn't.

**Status — deferred by decision (July 15, 2026).** The project author is
currently the only user, so the restrictive OS floor has no real-world
impact today; lowering it is postponed rather than applied. The value should
be lowered to `"11.0"` (arm64's floor) as originally specified **before the
package is published for outside consumers** — at that point the mismatch
between the recorded resolution and the tree becomes a real distribution bug.
The bookkeeping correction still stands: CODE-REVIEW-2's table marks this
"✅ Fixed" when it is not, so the resolution record should be amended to
"deferred" regardless of when the code change lands (see the process note in
"Relationship to the prior reviews").

---

## Low severity

### L1. `MessageHandler` probes the error object with metamethod-capable `lua_getfield`
`src/core/lua-runtime.cpp:1321`. A metatabled error table with a raising
`__index` turns the probe into an error-inside-the-message-handler
(`LUA_ERRERR`), degrading the reported error. `CaptureError` deliberately
uses `lua_rawget` for the same probe (`:1420-1421`); use it here too.

### L2. A released table handle round-trips to `nil` silently
`src/lua-native.cpp:1960-1966`. The `_tableRef` marker path checks runtime
identity but not `ref != LUA_NOREF`; passing a released handle back into Lua
pushes `registry[-2]` → `nil` with no error. The handle *methods* raise
"handle has been released"; the round-trip path should too.

### L3. `CallScope` missing on three of the five Proxy traps (L7 residual)
`src/lua-native.cpp:203-267`. `TableRefHasTrap`, `TableRefOwnKeysTrap`, and
`TableRefGetOwnPropertyDescriptorTrap` run field operations that can fire
`__index` → a throwing JS host callback → a staged `js_error_registry_`
entry nothing clears until the next scoped call. The get/set traps received
the `CallScope` (`:169, :193`); apply it to these three.

### L4. `register_class` validates reserved metamethods after registering the constructor and methods
`src/lua-native.cpp:876-917`. The constructor (`:879-882`) and instance
methods (`:885-899`) are installed into `js_callbacks_` /
`host_functions_` *before* the reserved-metamethod rejection (`:912-917`);
a rejected definition leaves those entries permanently registered while the
class global is never created. Hoist the validation loop above any
registration.

### L5. Dead code
- The static `LuaContext::NapiToCore` twin (`src/lua-native.cpp:2042-2112`,
  declaration `src/lua-native.h:252`) has no remaining callers outside its
  own recursion — ~75 lines guaranteed to drift from `NapiToCoreInstance`.
  The M10 "deliberately distinct twins" rationale no longer applies now that
  nothing calls it; delete it.
- `LuaRuntime::ReleaseTableRef` (`src/core/lua-runtime.cpp:2078-2082`) is
  used only by the C++ tests; production releases route through the registry
  owner → `UnrefOrDefer`. It also calls `luaL_unref` directly, bypassing the
  H9c deferral — harmless in-tree today, but a core-API consumer calling it
  during a worker run would race the registry. Route it through
  `UnrefOrDefer` (one-line change) or remove it in favor of the ref structs.

### L6. Type-width nits
- `const int class_id = next_class_id_++` (`src/lua-native.cpp:876`),
  `int mt_id` (`:948`), `int mod_id` (`:1023`) — implicit `uint64_t → int`
  narrowing that quietly defeats the L11 counter widening. Make the locals
  `uint64_t` (they only feed `std::to_string`).
- `GetTableLength` returns `int` (`src/core/lua-runtime.cpp:1943`),
  truncating `lua_Integer` for tables ≥ 2³¹ elements; return `int64_t` and
  emit a JS number from it.

### L7. Re-registering a class name silently merges old and new definitions
`src/core/lua-runtime.cpp:691`. `luaL_newmetatable` returns the *existing*
metatable for a repeated name; a second `register_class("Point", ...)`
overwrites the built-ins and adds the new metamethods but leaves any old
metamethods (and, via the separate registry key, replaces the method table
wholesale) — half-old, half-new semantics with no error. Detect the reuse
(`luaL_newmetatable`'s return value) and either reject the duplicate or
document + fully reset the metatable.

### Observation (documented behavior, listed for visibility): the instruction budget resets on every re-entry
`src/core/lua-runtime.cpp:1339-1345`. `ProtectedCall` zeroes
`instruction_count_` per entry, so a Lua loop whose body calls a JS callback
that re-enters Lua (via a function handle or `CallFunction`) resets the outer
loop's budget every iteration. The comment acknowledges this as intended;
worth stating in `types.d.ts` as well: `maxInstructions` bounds *pure-Lua*
compute — it is not a wall-clock or total-work sandbox once host callbacks
re-enter the VM.

---

## Verified and rejected (spot-checks that held up)

Suspicions pursued this pass and refuted against the code:

- **H9c deferral**: every unref and every flag flip is under the one mutex;
  the worker-thread drain runs strictly after the worker's last Lua touch;
  a finalizer blocked on the mutex during the drain correctly falls into the
  immediate-unref branch afterwards. Sound.
- **`MakeRegistryOwner`** resolves `LUA_RIDX_MAINTHREAD` before capturing —
  coroutine-minted refs unref against the main state. Correct.
- **`RunProtected`**: the light C-function push cannot allocate, the
  `active_thunk_` save/restore is reentrancy-safe, and C++ exceptions from
  `op` are rethrown only after the pcall frame is gone. Correct.
- **Cancel-during-resume** (`async_resuming_`) handles the *resume* window
  correctly, including the instruction-hook "execution cancelled" raise
  landing in the same teardown (H2 above concerns the *settle* window only).
- **`PushTableKey`** string coercion: `"-"`, `"+12"`, `" 12"`, and overflow
  all stay string keys; `NapiToTableKey`'s ±2⁶³ bounds are exact.
- **L5 cookie**: External-owned, `settled`-flagged, rooted on both callbacks
  — double-fire and never-settle both safe.
- **`isSequentialArray`** remains order-independent; `ToLuaValue` /
  `PushLuaValue` reserve stack headroom per level.
- **Packaging**: install script, loader order, `ERR_DLOPEN_FAILED`
  tolerance, `node-gyp-build` fallback, `files` list (includes
  `get_vcpkg_path.js`), `prebuildify` in devDependencies, and the
  `index.d.ts` re-export list are all correct in the tree. The stray
  `-fno-exceptions` and `binary.napi_versions` metadata are gone. (M15 is
  the one packaging item that is not — see M5.)
- **`SafeLoad`** wrap/unwrap is idempotent and respects a user-replaced
  `load`; **`JsSearcher`** discards its staged error before raising (M12
  fix verified).

---

## Suggested priority order

1. **H1** — one core fix (`CaptureError` catching its own conversion) defuses
   the process-kill on every execution path; add the binding-side try/catch
   belt-and-braces and the two RAII flag guards (worker bracket,
   `async_resuming_`) in the same PR.
2. **H2** — a three-line post-conversion re-check in `OnAwaitSettled` (or the
   widened driver-active window). Interacts with H1's `DriveAsync` guard;
   same PR is natural.
3. **H3** — ownership for table-handle methods and the two `_tableRef`
   descriptors; mind the Proxy `ownKeys` invariant.
4. **M1** — a one-line identity check on `resume()`.
5. **M2–M4** — the leak class (function crossings), the panic class
   (residual raw globals / unprotected allocation), and the longjmp class
   (`LuaPrint`/`LuaIoWrite`); each is mechanical and independently testable.
6. **L1–L7** — the hygiene items, opportunistically.
7. **M5** — deferred by decision; the deployment-target one-liner (and the
   CODE-REVIEW-2 table correction) is only required before the package ships
   to outside consumers.
