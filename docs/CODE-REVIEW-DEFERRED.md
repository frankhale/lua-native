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

#### M4 (partial) — unprotected global access vs. a metatable on `_G` *(medium)*
- **Fixed:** `GetGlobal` / `SetGlobal` now route through the protected-call path.
- **Still open:** `RegisterFunction`, `GetGlobalRef`, `SetGlobalMetatable`, and
  `AddSearchPath` still use raw global access (`lua_getglobal` /
  `lua_setglobal`) outside any protected frame. A metatable on `_G` with a
  raising `__index` / `__newindex` reached through these paths can still panic →
  process abort. Rarer triggers than `GetGlobal`/`SetGlobal`, hence deferred.
- **Fix shape:** route through the existing protected-call shim.

#### M5 (partial) — allocation failure in unprotected API paths aborts *(medium)*
- **Fixed (via M4):** the most reachable OOM sites (`GetGlobal` / `SetGlobal`)
  are now protected.
- **Still open:** other allocating core methods remain unprotected —
  `CreateTableFrom` (`lua_newtable`), `RegisterFunction` (`lua_pushstring`),
  `luaL_ref` sites. With `maxMemory` set, hitting the limit raises `LUA_ERRMEM`
  on these paths → unprotected panic → process abort. The memory-limit feature
  thus converts "operation fails" into "process aborts" on some paths.
- **Fix shape:** run these mutations through protected shims too.

#### M6 (partial) — cross-context round-trip marker identity check *(medium)*
- **Fixed:** `_tableRef` / `_userdata` markers are honored only when
  `data->runtime` matches this context; foreign handles fall through to a deep
  copy.
- **Still open:** `__luaClassRef` (which carries no runtime pointer) is a
  documented residual — it partially mitigates via its `js_userdata_` lookup but
  is not fully identity-checked.

### Deliberately deferred (documented, not changed)

#### H9c — finalizer `luaL_unref` racing a worker run *(high)*
- An N-API finalizer running `luaL_unref` on the main thread at GC time can
  mutate the Lua registry **concurrently** with a `execute_script_async` /
  `execute_file_async` worker executing on a libuv thread → heap corruption.
- **Reason deferred:** the trigger is narrow (V8 GC collecting a wrapper *during*
  a multi-second worker run). The worker-thread async model is already the
  lower-capability path (no JS callbacks); `execute_async` (coroutine-driven,
  main-thread) is preferred.
- **Fix shape:** a deferred-unref queue drained on the main thread after the
  worker completes (or on the next main-thread entry).

#### M1 — awaiting a JS promise from inside a *user* coroutine *(medium)*
- Under `execute_async`, `await`-ing a JS promise from inside a user-created
  coroutine (`coroutine.create(...)` + `coroutine.resume`) yields to the wrong
  resumer: it suspends the innermost coroutine, the script's `resume` returns
  immediately with no values, and when the promise settles the binding resumes
  the *driver* thread — the value is delivered to the wrong frame (compounding
  M2 if the driver has finished).
- **Reason deferred:** correctness-of-a-niche-usage item.
- **Fix shape:** a core guard that refuses to yield when the yielding state
  isn't the driver thread (raise "cannot await inside a user coroutine"), or
  document the feature as top-level-only.

#### L5 — hostile `Promise` subclass double-firing the await callbacks *(low)*
- A spec-violating `Promise` subclass whose `then` invokes callbacks twice
  causes read-after-free of the `AwaitCookie` (freed on first settlement). A
  never-settling promise leaks it (minor).
- **Reason deferred:** low risk; requires deliberately malformed input.
- **Fix shape:** a settled flag inside the cookie, or a finalizer-owned cookie.

#### L6 — hidden owner properties are `configurable` / deletable from JS *(low)*
- The hidden `__luaFnOwner` (and similar) owner properties are `configurable`,
  so `delete fn.__luaFnOwner; gc(); fn()` frees the `*Data` while bound
  functions still hold the raw pointer.
- **Reason deferred:** deliberate misuse required.
- **Fix shape:** define the owner props with `configurable: false`.

#### L7 — `js_error_registry_` accumulation on non-`CallScope` paths *(low)*
- Staged JS errors on paths without a `CallScope` (coroutine resume, table
  traps) are neither consumed (error fidelity silently absent) nor cleared until
  an unrelated guarded call runs.
- **Reason deferred:** low severity.

#### L8 — `cancel()` is a no-op for worker-thread async *(low)*
- Nothing ever calls `RequestCancel()`; worker-thread runs
  (`execute_script_async` / `execute_file_async`) cannot be interrupted at all,
  and the `IsCancelRequested` branch in `OnAwaitSettled` is dead code.
- **Reason deferred:** tracked separately as the `lua_sethook` instruction-limit
  work — gap **A3b** in `FUTURE.md` / `BRIDGE-GAP-ANALYSIS.md` (hook-based
  cancellation).

#### M11 — no `HandleScope` in Lua→JS reentrant callbacks *(medium)*
- Every `CoreToNapi` result / `Call` return created during a long script run
  accumulates in the outer N-API entry's scope (e.g. `for i=1,1e7 do cb(i) end`
  holds tens of millions of handles until the call returns).
- **Reason deferred:** left as-is per low practical severity in the residuals
  triage. *(Note: M10 in CODE-REVIEW-2 added `HandleScope` to the host-callback
  wrapper, property getter/setter, and print handler; M11's remaining reentrant
  sites were not all wrapped.)*
- **Fix shape:** wrap each callback body in `Napi::HandleScope`, escaping values
  that must survive.

#### M12 — stale staged searcher error mis-raised by a later failure *(medium)*
- When a JS searcher throws, the wrapper stages `pending_error_value_` but
  `JsSearcher`'s catch raises its own string without consuming it. The stale
  structured error survives until the next wrapper error that doesn't stage, at
  which point the **old** error object is raised.
- **Reason deferred:** left as-is per the residuals triage.
- **Fix shape:** clear or consume the staged value on the searcher error path.

#### Stored-`env` documentation *(low, from M11/M12 grouping)*
- The `LuaContext::env` stored-member documentation items (see CODE-REVIEW-1
  M12) were left as-is.

---

## Suggested order for a future hardening pass

1. **M4 / M5 remainder** — route the remaining unprotected allocating/global API
   sites (`RegisterFunction`, `GetGlobalRef`, `SetGlobalMetatable`,
   `AddSearchPath`, `CreateTableFrom`) through protected shims. Closes the last
   panic/abort surface from ordinary API usage under `maxMemory` or a trapped
   `_G`.
2. **M12** — consume/clear the staged searcher error (one-site correctness fix).
3. **M6 remainder / M1** — `__luaClassRef` identity check; user-coroutine await
   guard.
4. **H9c** — deferred-unref queue for the worker-thread async path (or continue
   steering users to `execute_async`).
5. **M11** — `HandleScope` coverage on the remaining reentrant callback sites.
6. **L5–L8, L6, stored-env docs, M9/M10/L1 cleanups** — polish, done
   opportunistically. L8 in particular is subsumed by the A3b hook-based
   cancellation work.
