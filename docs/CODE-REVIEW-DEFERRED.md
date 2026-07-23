# CODE-REVIEW-DEFERRED

Consolidated tracker for findings across **all code reviews (CODE-REVIEW-1
through CODE-REVIEW-8)** that were **deferred, only partially resolved,
deliberately not applied, or resolved by documentation** — the standing
backlog the reviews' priority lists point at. Items are grouped by their source
review and tagged with the original finding ID so they can be traced back.
Severity labels are carried over from the originating review.

**Last audited: July 22, 2026** (tree at the CODE-REVIEW-8 remediation; every
"still current" claim below was re-checked against it). **Updated July 23,
2026**: the CR-8 F6 main class was closed by code (`PushLuaValueProtected`);
see its entry for the two narrowed residuals that replace it.

## Ledger

| Review | Commit reviewed | Outstanding |
|--------|-----------------|-------------|
| CODE-REVIEW-1 | `f9a2459` | L1 (partial, style) and M10 (partial, cleanup) — deliberately not applied |
| CODE-REVIEW-2 | `d87f62b` | none (the M5 residual — result conversion *and* the argument-staging gap it exposed — closed July 22, 2026) |
| CODE-REVIEW-3 | `34d40c3` | M5 ⏸️ deferred — `MACOSX_DEPLOYMENT_TARGET` still `"26.0"`; release blocker per `docs/RELEASING.md` |
| CODE-REVIEW-4 | `d031eea` | none |
| CODE-REVIEW-5 | `052099b` | F3 caveat — Windows CMake path fixed but never verified; F8 — prebuilds still `darwin-arm64` only (release-time task, recorded in `docs/RELEASING.md`) |
| CODE-REVIEW-6 | `08f4560` | none |
| CODE-REVIEW-7 | `5f7b8f6` | none (its audit annotated the CR-2 M5 residual, since closed) |
| CODE-REVIEW-8 | `330cc30` | F6 ✅ main restructure done July 23, 2026 (bridge value pushes now protected); two narrow residuals remain documented (error-message staging allocations; the stranded constructor `js_userdata_` entry) |

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
  (`src/core/lua-runtime.cpp`) that reads `_G[name]` under `lua_pcall` (via the
  `ProtectedTableGet` trampoline at the time; since the M5 argument-staging fix
  below, via its own `ProtectedGlobalGetRunner`), and refactored `GetGlobal`,
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
- **Former residual — now closed (July 22, 2026).** The `luaL_ref` calls buried
  in the value-conversion path (`ToLuaValue` materializing a
  function/thread/userdata/metatabled-table *result*) were not individually
  wrapped. They run after the execution `pcall` has already returned, so under an
  exhausted `maxMemory` the `LUA_ERRMEM` longjmped with no protected frame in
  sight → panic → **process abort**. CODE-REVIEW-7's audit pinned the concrete
  instance: converting a metatabled-table error object, and any
  function/thread/table-ref result after `ProtectedCall` returns.
- **Resolution:** added `LuaRuntime::ToLuaValueProtected(from, index)`
  (`src/core/lua-runtime.cpp`), the read-side counterpart to `RunProtected`. It
  runs `ToLuaValue` inside a `lua_pcall` frame via a light C-function trampoline
  (`ProtectedConvertRunner`, 0 upvalues → its push never allocates), passing the
  value to convert **as the trampoline's argument** — a pcall frame can't address
  the caller's stack slots, so it can't be handed an index the way `RunProtected`
  ops work on the caller's stack. An `LUA_ERRMEM` is rethrown as a
  `std::runtime_error`; a C++ exception from `ToLuaValue` (depth/stack limits) is
  captured and rethrown after the frame unwinds. The frame always runs on the
  main state — `lua_pcall` on a suspended coroutine is illegal — so a value
  living on a coroutine thread is `lua_xmove`d across first, which is equivalent
  because the registry the refs land in is shared. Scalars (nil/boolean/number/
  string) allocate nothing on this path and are converted directly, keeping the
  pcall off the common path.
- Every previously unprotected conversion site now routes through it:
  `CaptureError`, the four post-`ProtectedCall` result loops
  (`ExecuteScript`/`ExecuteFile`/`CallFunction`/the bytecode path), `GetGlobal`,
  `GetTableField` / `GetTableFieldKeyed`, `TablePairs` / `TableIPairs`, and the
  three coroutine result loops (`ResumeCoroutine` yield + return,
  `ResumeAsyncStep`). Sites already inside a `pcall` (the host bridges) are left
  alone. Regression test:
  `LuaRuntimeProtectedAlloc.ResultConversionUnderExhaustedMemoryReportsInsteadOfAborting`
  — it drives the budget to within ~100 bytes of the wall with a chain of
  fixed-size nodes, then calls a Lua function returning a metatabled table until
  the registry has to grow; **verified to abort the test process without the
  fix**, and to come back as an ordinary error result with it.
- **Second half, found while closing the above (July 22, 2026) — also fixed.**
  Closing the read side exposed the mirror-image gap on the *write* side: the
  bare-API entry points staged their arguments on the caller's stack **before**
  entering the protected frame, so the staging allocations were themselves
  unprotected. `PushProtectedGlobal` pushed the key string outside its
  `lua_pcall` (masked in practice only because global names are usually already
  interned); worse, `SetGlobal`, `SetTableField` and `SetTableFieldKeyed` ran the
  entire `PushLuaValue` of the caller's value — arbitrarily large — outside the
  frame. Same failure mode as the residual above: ERRMEM → panic → abort.
- **Resolution:** the six field accessors (`Get`/`Set`/`Has` × plain/`Keyed`),
  `SetGlobal` and `GetTableKeys` now do key staging, value staging, the table
  operation *and* the result conversion inside a single `RunProtected` frame,
  calling `lua_gettable` / `lua_settable` directly. `PushProtectedGlobal` grew a
  dedicated trampoline (`ProtectedGlobalGetRunner`) that pushes the key string
  from *inside* the frame; the name reaches it out-of-band via
  `active_global_name_`, because pushing it as an argument is the very
  allocation being protected. `GetTableKeys` is protected for its number-key
  stringification (traversal itself is raw and fires no metamethod). The now-dead
  `ProtectedTableGet` / `ProtectedTableSet` trampolines were removed —
  `ProtectedTableCall` remains for `GetTableLength` / `TableIPairs`, whose
  arguments are pushed with `lua_rawgeti` and so allocate nothing. Only PODs live
  inside the thunks and every C++ result is declared outside, so an ERRMEM
  longjmp has no destructor of consequence to skip. Regression test:
  `LuaRuntimeProtectedAlloc.ArgumentStagingUnderExhaustedMemoryThrowsInsteadOfAborting`
  — **verified to abort the test process without the fix.**
- Distinct from CR-8 F6 below: that one was a *leak inside* a protected frame
  (its main class now also closed, by `PushLuaValueProtected`); both of these
  were a *panic outside* any, and are now gone.

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

## From CODE-REVIEW-3 (commit `34d40c3`)

All findings resolved **except M5**, which remains deferred by decision:

### M5 — `MACOSX_DEPLOYMENT_TARGET` is `"26.0"` *(medium)* — ⏸️ DEFERRED (intentional; release blocker)
- **The gap:** both `xcode_settings` blocks in `binding.gyp` pin the macOS
  deployment target to `26.0` (**still true as of July 22, 2026** —
  `binding.gyp:142`, `:306`). Prebuilds compiled with this fail to `dlopen` on
  anything older than the current-year macOS, and the CMake build (which
  doesn't set it) produces artifacts with a different OS floor.
- **Why deferred:** the project author is currently the only user, so the
  restrictive floor has no real-world impact today. Lower to `"11.0"` (arm64's
  floor) **before publishing for outside consumers** — `docs/RELEASING.md`
  records this as a release blocker, alongside the related prebuild coverage
  item (CR-5 F8 below).

---

## From CODE-REVIEW-4 (commit `d031eea`)

**Nothing deferred.** All five findings (N1–N5) fully resolved in the
remediation pass. (N1's resolution deviates deliberately from the review's
recommended reorder for a GC-safety reason — that is a design record in
CODE-REVIEW-4's resolution table, not an open item.)

---

## From CODE-REVIEW-5 (commit `052099b`)

All twelve findings (F1–F10 plus the discovered F11/F12) resolved, with two
state-of-tree caveats that stay open until acted on:

### F3 (caveat) — Windows CMake discovery fixed but never verified *(medium)* — ⚠️ UNVERIFIED
- The CMake Node.js discovery rewrite (node-gyp cache candidate lists,
  `node.lib` location on Windows) is structurally complete, but **no Windows
  machine was available** — the Windows path has never been exercised. Verify
  (or delegate to a Windows CI job) before treating the CMake build as a
  supported Windows path.

### F8 — prebuild coverage *(low, state-of-tree)* — 📄 DOCUMENTED (release-time task)
- `prebuilds/` still contains **`darwin-arm64` only** (re-checked July 22,
  2026) of the three declared platforms (macOS arm64/x64, Windows x64).
  Resolved by documentation: `docs/RELEASING.md` records the per-platform
  prebuild requirement, the legacy `lua-native.node` name to delete once real
  prebuilds exist, and the CR-3 M5 un-deferral — all release-time work, not
  tree defects.

---

## From CODE-REVIEW-6 (commit `08f4560`)

**Nothing deferred.** Both findings (F1, F2) fully resolved.

---

## From CODE-REVIEW-7 (commit `5f7b8f6`)

**Nothing deferred.** All five findings (F1–F5) fully resolved. The pass's
audit additionally pinned a concrete instance onto the CR-2 M5 documented
residual — that residual has since been closed (see the CR-2 M5 entry above). (The CR-7 F1
regression test was later silently disarmed by a Vitest major-version change;
that was found and fixed as CODE-REVIEW-8 F2, and the guard now fails loudly.)

---

## From CODE-REVIEW-8 (commit `330cc30`)

### F6 — ERRMEM longjmp over live C++ locals in the host bridges *(low)* — ✅ RESOLVED (main class, July 23, 2026); two narrow residuals documented below
- **Original gap:** the host bridges (`LuaCallHostFunction`, `UserdataMethodCall`,
  `UserdataIndex`, `ClassIndex` in `src/core/lua-runtime.cpp`) stage errors
  carefully and only `lua_error` after C++ locals are destroyed — but a **Lua
  memory error raised by an allocation inside the scope** (the `PushLuaValue` of
  the result under an exhausted `maxMemory`) longjmped directly to the enclosing
  `pcall`, skipping the destructors of the live `args` vector and `resultHolder`
  (`try`/`catch` cannot see a longjmp; the linked Lua is a C build). The skipped
  `shared_ptr`s leaked their `LuaValue`s and any registry slots they own.
- **Resolution:** every bridge value push now runs inside its own `lua_pcall`
  frame via `LuaRuntime::PushLuaValueProtected` / `ProtectedPushRunner` — the
  result pushes in `LuaCallHostFunction` and `UserdataMethodCall`, both bridges'
  staged-JS-error (`errVal`) pushes, and the property-getter result pushes in
  `UserdataIndex` and `ClassIndex`. The descriptor travels as a light-userdata
  pcall argument (pushing one never allocates), so the helper works on whichever
  thread the bridge was invoked on with no registry read. An ERRMEM now returns
  as a status code with the message (Lua's preallocated memory-error string) on
  top; the bridge destroys its locals normally and only then re-raises. Two
  regression tests
  (`LuaRuntimeProtectedAlloc.HostFunctionResultPushUnderExhaustedMemoryReportsAndFrees`,
  `…PropertyGetterPushUnderExhaustedMemoryReportsAndFrees`) pin the leak by
  `shared_ptr` use_count on a sentinel result (LSan is unavailable under Apple
  clang) — **verified to fail (count 3, holder leaked) without the fix**, which
  also upgrades F6 from code-reading-only to reproduced.
- **Narrowed residuals (accepted floor):**
  1. The bridges' *error-message* stagings (`lua_pushfstring`, and the
     `lua_pushstring(e.what())` fallback when a staged error value fails to
     push) still allocate from Lua inside the scope, so an ERRMEM there can
     still skip locals. Bounded to small string buffers on paths already
     reporting a failure; no registry slots involved.
  2. The constructor wrapper's freshly-committed `js_userdata_` entry
     (`CreateConstructorWrapper`, `src/lua-native.cpp`) is still stranded if
     the — now protected, non-leaking — push of its result fails: the entry
     pins the JS instance until context teardown. Whether a partially-pushed
     value already materialized the Lua userdata (whose `__gc` would erase the
     entry, making an eager rollback a double-free of the slot) is undecidable
     at the failure site, so the rollback is deliberately not attempted.
     OOM-window-only, bounded, reclaimed at context teardown.

---

## Suggested order for a future hardening pass

Every code-defect finding from CODE-REVIEW-1 through CODE-REVIEW-8 is resolved.
What remains, in the order it should be acted on:

1. **Before the first publish for outside consumers** (release blockers, both
   already recorded in `docs/RELEASING.md`): lower `MACOSX_DEPLOYMENT_TARGET`
   to `"11.0"` (CR-3 M5) and produce the missing `darwin-x64` / `win32-x64`
   prebuilds (CR-5 F8).
2. **If the CMake build is ever offered as a supported Windows path:** verify
   the node-gyp-cache discovery on a real Windows machine or CI job (CR-5 F3
   caveat).
3. **Accepted floor — revisit only if the OOM/`maxMemory` story hardens:**
   the two narrowed CR-8 F6 residuals (error-message staging allocations in the
   bridges; the stranded constructor `js_userdata_` entry — see the F6 entry).
   The main F6 class — the bridge *value* pushes — was closed on July 23, 2026
   with `PushLuaValueProtected`. Not visible to the sanitizer harnesses. Its
   former companion, the CR-2 M5 result-conversion residual (a panic *outside*
   any frame), was closed on July 22, 2026.
4. **No action planned:** CR-1 L1/M10 (style/cleanup, deliberately not
   applied).

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
