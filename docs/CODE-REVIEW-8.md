# CODE-REVIEW-8

**Date:** July 22, 2026
**Scope:** Eighth pass, against commit `330cc30` (the CODE-REVIEW-7 remediation).
Primary targets: (1) re-verification of the CR-7 resolutions (F1–F4) in the
tree; (2) a fresh full read of both C++ layers (`lua-native.cpp`/`.h`,
`lua-async-worker.h`, `lua-runtime.cpp`/`.h`) organized around the project's
two recurring questions — *which guard/discipline was applied at some sites but
not its siblings*, and *which JS-influenced value is read without a guard on a
path that cannot tolerate a throw*; (3) the test harness's arming assumptions
(a side effect of running the baseline, which surfaced F2). Line numbers refer
to commit `330cc30`.

**Method:** Complete read of the two layers, then targeted adversarial
verification: every suspect below was **exercised** against the freshly
confirmed debug binary (`build/Debug/lua-native.node` at `330cc30`), using
`WeakRef` + `--expose-gc` observation for the stranding/pinning claims and
plain reproductions for the crash/wedge claims. One finding (F6) is
code-reading only and marked as such.

**Baseline:** 459 TypeScript and 178 C++ tests pass at `330cc30`. That number
carries an asterisk this pass: one of the 459 — the CR-7 F1 use-after-free
regression pin — is currently **vacuous** under `npm test` (see F2). The test
count says nothing it used to say.

---

## Resolution status (July 22, 2026)

All findings resolved (F6 by documentation, as recommended). After the fixes:
**467 TypeScript tests** (up from 459 — eight new CR-8 regression tests) and
**178 C++ tests** pass against a freshly built debug binary; the full suite
also passes under the ASan+UBSan-instrumented addon (`run-sanitized-ts.js
asan`, 467/467, no sanitizer report) — which now, with F2 fixed, once again
includes every GC-lifetime pin. All of this review's reproductions were re-run
against the fixed build and are clean.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | The whole `is_error` extraction in `OnAwaitSettled` (the `message` probe, the `ToString` fallback, and `StageJsError`'s name/stack reads) runs in one try/catch; on failure the message falls back to `"(rejection value could not be converted)"`, anything a partially-run `StageJsError` staged is dropped, and the rejection is delivered to Lua normally — the run's promise rejects and the context stays usable. Verified pre/post with both reproductions: `Promise.reject(Symbol(...))` and `Promise.reject(Object.create(null))` exited 1 before; after, both surface as ordinary rejections with `is_busy()` false. Two regression tests. |
| F2 | ✅ Done | `vitest.config.ts` migrated to Vitest 4's top-level `test.execArgv` — conditionally: worker_threads reject V8 flags in `execArgv` (verified: a top-level `--expose-gc` breaks the threads pool with `ERR_WORKER_INVALID_EXEC_ARGV`), so `run-sanitized-ts.js` now sets `LUA_NATIVE_SANITIZED=1` and the config leaves `execArgv` alone on that path (the runner provides `--expose-gc` process-wide, as before). Disarmament is now loud twice over: the CR-7 F1 guard **throws** instead of warn-and-return, and a dedicated test asserts `global.gc` is present. Both harness paths verified: `npm test` (forks) and the threads-pool invocation both run all 467 tests with gc available. |
| F3 | ✅ Done | All three sites reordered to the N5 discipline: the core call runs first and the `js_callbacks_`/`host_functions_` pairs are registered only on success (`set_metatable`, `register_module` collect their function entries into a deferred list; `register_class` defers the constructor, methods, and metamethods likewise). Safe for the same reason as `add_searcher` (CR-7 F4): the installed closures carry the names only as upvalues, nothing resolves them until Lua later calls them, and no Lua runs between the core call and the registration. Three WeakRef regression tests pin collectability after each failure mode (typo'd global, missing `package`, raising `_G`) and that the follow-up registration works — including `register_class` retrying the same name after the reservation rollback. |
| F4 | ✅ Done | Both workers' `OnOK` wrap the `ResultsToJs` marshal in try/catch and reject the deferred with `failed to convert async result: …`, mirroring `DriveAsync`. Verified with the oversized-string reproduction: uncaughtException + unsettled promise before; ordinary rejection with the context usable after. Regression test (with an explicit timeout for the sanitizer harness, where the 600 MB allocation outruns the 5 s default). |
| F5 | ✅ Done | `CallScope` added to the five metamethod-capable handle methods (`get`, `set`, `has`, `length`, `ipairs`; `pairs` is raw traversal, `release` touches no Lua). A staged entry is now cleared at the next handle call's outermost scope instead of accumulating. Regression test: two failing `handle.get`s; the first call's staged Error must be collectable after the second. |
| F6 | 📄 Documented | Recorded in `CODE-REVIEW-DEFERRED.md` (new "From CODE-REVIEW-8" section) as the accepted floor, alongside the M5 residual it parallels: leak-not-corruption, OOM-window-only, disproportionate to fix. |
| F7 | ✅ Done | Both nits fixed: `SetOutputHandler` installs the redirection before committing the handler (and the binding's `InstallPrintHandler` commits `print_handler_` after the runtime install succeeds), so a throw leaves the previous, consistent state; `set_userdata` records each method name in `registered_method_fns` *before* registering the pair, so the rollback always sees it (erase/remove are no-ops for unregistered names). |

The original findings follow unchanged for reference.

---

## Verification of the CODE-REVIEW-7 remediation

| CR-7 # | Verdict |
|--------|---------|
| F1 | ✅ Correct at both sites. The `AwaitCookie` carries the context's shared `alive_` flag (`lua-native.cpp:1795`), and both static callbacks check it **before** touching `ctx` (`:1932`, `:1943`). The fix's safety argument holds: a late settlement on a collected context is discarded reading only cookie memory, which the External finalizer owns. **However**, the regression test that pins this class no longer runs under `npm test` — see F2 below. It still runs under `run-sanitized-ts.js` (which passes `--expose-gc` on the node invocation itself). |
| F2 | ✅ Correct. The attach is guarded end-to-end (`:1789-1816`): a non-callable `then` and a throwing lookup/call both settle the run through the captured deferred, and the `attach_gen` re-check (`:1788`, `:1811`) prevents the failure branch from tearing down a run a synchronously-settling hostile `then` already finished or superseded. The cookie is handed to its owning External before any throw-capable step (`:1799`). |
| F3 | ✅ Correct. `set_userdata` tracks `global_installed` (`:860`, `:868`) and best-effort raw-removes the global in the catch, only when this call installed it (`:898-900`); `RemoveGlobalRaw` is raw + protected as documented (`lua-runtime.cpp:548-558`). |
| F4 | ✅ Correct. `AddSearcher` calls `AddJsSearcher` first and registers the `js_callbacks_`/`host_functions_` pair only on success (`lua-native.cpp:2054-2061`). |
| F5 | Not re-verified this pass (harness files not re-read). The adjacent discovery F2 below is, however, exactly the harness-arming class F5 lived in. |

---

## Overall assessment

The CR-7 fixes are present and correct at every site they name. But this pass
confirms — for the third review running — that the project's dominant failure
mode is no longer *new* hazard classes but **unswept siblings of already-fixed
ones**. Every finding below except F2 is a known discipline applied at some
sites and missing at others:

- The **resolve** path of the await-settlement handler guards its conversion;
  the **reject** path reads `message` / `ToString()` / `name` / `stack` off the
  rejection value unguarded (F1) — and unlike CR-7's hostile-`then`, the
  trigger here is not hostile at all: `Promise.reject(Object.create(null))` or
  a `Symbol` rejection crashes the process under Node defaults.
- `DriveAsync` guards result marshalling before settling; the worker-thread
  `OnOK` — the same operation on the same kind of path — does not (F4).
- The N5 registration-ordering/rollback discipline now covers
  `RegisterCallbacks`, `set_global`, `set_userdata`, and `add_searcher`; it
  still does not cover `set_metatable`, `register_module`, or `register_class`
  (F3), two of which fail on trivially reachable inputs (a typo'd global name;
  a missing `package` library).
- The Proxy traps got `CallScope`s (L7/L3); the table-handle methods, the
  other JS-side surface over the same table-ref machinery, did not (F5).

F2 is the one genuinely new class: **silent disarmament of a regression pin by
a dependency major-version change**. Vitest 4 removed `test.poolOptions`; the
config that was added in CR-7 specifically so the F1 use-after-free test could
run is now silently ignored, `global.gc` is absent in workers, and the test
self-skips — with its `console.warn` swallowed by the runner, so nothing in a
green `npm test` says so. The suite "passes 459" while the pin on the
highest-severity class of the last review never executes.

Severity distribution: one medium (F1), one medium-low (F2), four low (F3–F6).

---

## Findings

### F1. `execute_async`'s rejection-path value extraction is unguarded — a rejection value whose string coercion throws crashes the process by default and wedges the context (medium)

`OnAwaitSettled`'s `is_error` branch (`lua-native.cpp:1864-1877`) reads the
rejection value with no guard: `value.As<Napi::Object>().Get("message")`
(`:1866-1867`), the `value.ToString()` fallback (`:1869`), and — via
`StageJsError` — `obj.Get("name")` / `obj.Get("stack")`
(`:1421-1428`). Each of these can throw a `Napi::Error`: a `Symbol` rejection
value (`ToString` on a Symbol raises `TypeError`), a null-prototype object
(`Object.create(null)` has no `toString`), or an object with a throwing
`message`/`name`/`stack` getter. The throw unwinds out of `OnAwaitSettled` →
`OnAwaitRejectStatic` → the promise reaction job, so the derived promise
(which `DriveAsync` discarded after `thenFn.Call`) rejects with no handler.

Consequences, **reproduced** both ways against the `330cc30` debug build:

Under Node defaults (no rejection/exception handlers) the process exits:

```js
const lua = new lua_native.init(
  { slow: () => new Promise((_r, rej) => setTimeout(() => rej(Object.create(null)), 30)) },
  { libraries: 'all' });
lua.execute_async('return slow()').then(..., ...);
// -> triggerUncaughtException: [TypeError: Cannot convert object to primitive value]
// exit code 1. Same result with rej(Symbol('boom')).
```

With handlers installed, the run is left **wedged**: the extraction throws
before any settle/teardown, so `async_co_` stays engaged, `is_busy_` stays
true, the caller's promise never settles, and every sync entry point rejects
with "busy" until `cancel()`:

```
UNHANDLED REJECTION observed: Cannot convert a Symbol value to a string
after settle window: promise settled = false | is_busy = true
execute_script threw: Lua context is busy with an async operation
```

Calibration: **no hostility required.** Real code rejects with non-`Error`
values — `Object.create(null)` payloads and symbols occur in the wild — which
is why this is medium while CR-7 F2 (requiring a deliberately hostile `then`)
was low. The **resolve** path already guards its conversion
(`:1883-1891`, "failed to convert awaited value") and settles the run on
failure; the reject path is its unswept sibling.

**Recommendation.** Wrap the whole `is_error` extraction (message probe,
`ToString` fallback, `StageJsError`) in try/catch. On failure, don't wedge:
fall back to a generic message (e.g. `"(rejection value could not be
converted)"`) and deliver that to the coroutine as the raise value — the run
then proceeds exactly as for any other rejection. Sweep the class: any read of
a JS-influenced property on a path that cannot tolerate a throw (settlement
callbacks, reaction jobs) must be guarded; after this fix the resolve/reject
paths are symmetric.

**Test.** The two reproductions above (Symbol and null-prototype rejection),
asserting the caller's promise rejects and `is_busy()` returns false after.

### F2. Vitest 4 removed `test.poolOptions` — the CR-7 F1 use-after-free regression test silently self-skips under `npm test` (medium-low)

`vitest.config.ts` passes `--expose-gc` via `test.poolOptions.forks.execArgv`
— the mechanism CR-7 added specifically so its F1 regression test (cancel →
context GC → late settle, the pin on the H3/H5 use-after-free class) would
actually run. The installed Vitest is v4.1.10, which **removed**
`test.poolOptions` (the runner prints a deprecation line and ignores it).
**Verified** with a probe test: `typeof global.gc` is `"undefined"` inside the
workers under the current config, so the guard at
`tests/ts/lua-native.spec.ts:5076-5079` returns early and the test asserts
nothing. Its `console.warn` does not appear anywhere in the default reporter's
output of a passing run — the skip is fully silent. `npm test` reports 459
green tests while the regression pin for the last review's high-severity
finding never executes. (The sanitizer path is unaffected:
`run-sanitized-ts.js` passes `--expose-gc` on the node invocation itself, and
threads-pool workers inherit process-wide flags.)

**Verified fix shape:** the top-level `test.execArgv` option works in Vitest 4
— a probe config with

```ts
export default defineConfig({
  test: { execArgv: ['--expose-gc'] },
});
```

exposes `global.gc` to the workers (probe test passes).

**Recommendation.** Move the option per the Vitest 4 migration, and — the
durable half of the fix — make disarmament loud: replace the guard's
warn-and-return with a hard failure (or add one tiny test asserting
`typeof global.gc === 'function'`), so the next dependency bump that breaks
the plumbing fails the suite instead of quietly gutting it. Grep for any other
self-skipping guards and give them the same treatment.

### F3. Failed `set_metatable` / `register_module` / `register_class` strand `js_callbacks_` / `host_functions_` entries — the N5 rollback discipline, still unapplied at three sites (low)

All three methods register their function-valued entries eagerly
(`js_callbacks_[name] = Persistent(...)` + `StoreHostFunction`) and only then
make the core call that can fail:

- `set_metatable`: registration at `lua-native.cpp:1069-1074`, core call
  `SetGlobalMetatable` at `:1088-1093` — which throws on a **nonexistent or
  non-table global**, i.e. an everyday typo.
- `register_module`: registration at `:1148-1151`, core call
  `RegisterModuleTable` at `:1167-1172` — which throws when the `package`
  library isn't loaded.
- `register_class`: constructor/method/metamethod registration at
  `:991-1026`, core call `RegisterClass` at `:1032-1037` — reachable via a
  raising `__newindex` on a `_G` metatable or OOM under `maxMemory`. (The
  reservation guard rolls back `registered_classes_`, so a retry is allowed —
  and mints fresh ids, stranding the previous attempt's entries forever.)

On the throw, nothing is rolled back: each failed call permanently pins the JS
closures (a `Napi::FunctionReference` each) plus the `host_functions_`
entries, and a retry loop accumulates without bound. **Reproduced** at all
three sites with `WeakRef` + `--expose-gc` (control closure collects; each
site's closure stays pinned after the call throws):

```
set_metatable threw: Global 'no_such_global' does not exist
set_metatable failure strands closure (still pinned): true
register_module threw: Cannot register module: the 'package' library is not loaded. ...
register_module failure strands closure (still pinned): true
register_class threw: ...: no writes
register_class failure strands ctor: true | strands method: true
```

This is precisely the class CR-6 F1 added rollback for in `set_userdata` and
CR-7 F4 reordered `add_searcher` for; these are the remaining unswept
siblings. (The `JsCallbackCollectorScope` present in `set_metatable` /
`register_module` sweeps only the *reclaimable* `__js_callback_*` names minted
for non-function values — not these named host-function registrations.)

**Recommendation.** The CR-7 F4 reorder applies cleanly at all three sites:
the names registered are resolved in `host_functions_` only when a
metamethod/module function/constructor is later *called*, and no Lua runs
between the core call and the registrations — so make the core call first and
register the pairs only on success. (`SetGlobalMetatable` / `RegisterClass` /
`RegisterModuleTable` install closures that carry the names as upvalues;
installing them before the names exist is safe for exactly the reason
documented at `add_searcher`.) Where the reorder is awkward, rollback-on-catch
à la `set_userdata` is the fallback. Regression tests: the three WeakRef
reproductions above.

### F4. Worker-async `OnOK` marshals results unguarded — a result that fails to cross to JS becomes an uncaught exception and a promise that never settles (low)

`LuaScriptAsyncWorker::OnOK` / `LuaFileAsyncWorker::OnOK`
(`lua-native.cpp:2067-2076`, `:2083-2092`) call `context_->ResultsToJs(...)`
with no guard. A result whose conversion throws — e.g. a Lua string exceeding
V8's maximum string length — unwinds out of `OnOK` into the N-API callback
boundary: `uncaughtException` (process exit by default) and the deferred is
never settled. **Reproduced**:

```js
lua.execute_script_async('return string.rep("a", 600 * 1024 * 1024)')
// -> UNCAUGHT EXCEPTION from settle path: Unknown failure
//    (promise never settles; process exits by default)
```

The synchronous path is fine (`ExecuteScript` throws a catchable JS error
through the ObjectWrap wrapper), and `DriveAsync` learned this exact lesson
for the coroutine driver (`:1826-1840`, "failed to convert async result" — the
conversion is tried, and the deferred is always settled). `OnOK` is the
unswept sibling.

**Recommendation.** Wrap the `ResultsToJs` call in both `OnOK`s in try/catch
and `deferred_.Reject` with a descriptive error on failure, mirroring
`DriveAsync`. (`ClearBusy` already runs first, so the context is not wedged —
the defect is the crash-by-default and the forever-pending promise.)

### F5. Table-handle methods lack the `CallScope` the Proxy traps got — staged JS-error registry entries accumulate across handle calls (low)

The L7/L3 fixes gave every Proxy trap a `CallScope` so a `js_error_registry_`
entry staged by a raising host callback inside `__index`/`__newindex` is
cleared at the outermost access. The table-handle methods — `TableHandleGet` /
`Set` / `Has` / `Length` / `IPairs` (`lua-native.cpp:301-456`), the other JS
surface over the same metamethod-capable table-ref operations — have none. A
handle obtained via `get_global_ref` (or a `create_table` table later given a
metatable from Lua) whose `__index` calls a throwing JS host function stages
an entry that nothing consumes (the handle method surfaces the failure as the
plain `"table access error"` string) and nothing clears until an unrelated
`CallScope`-bearing entry point happens to run. Each entry pins the thrown JS
Error object. **Reproduced** with `WeakRef`:

```
handle.get threw: table access error
staged Error pinned after handle.get (no CallScope on handle methods): true
after an execute_script, staged Error released: true
```

A handle-only usage pattern accumulates one pinned Error per throwing access,
unbounded.

**Recommendation.** Add `LuaContext::CallScope` to the five metamethod-capable
handle methods (`get`, `set`, `has`, `length`, `ipairs`; `pairs` is raw
traversal and `release` touches no Lua), exactly as the traps do.

### F6. An ERRMEM longjmp mid-bridge skips live C++ locals — leak, not corruption (low; documented-residual candidate — code reading only, not reproduced)

The host bridges stage errors carefully and only `lua_error` after C++ locals
are destroyed — but a **Lua memory error raised by an allocation inside the
scope** (`PushLuaValue` of the result under an exhausted `maxMemory`:
`lua-runtime.cpp:1393` in `LuaCallHostFunction`, `:688` in
`UserdataMethodCall`, `:837` in `UserdataIndex`) longjmps directly to the
enclosing `pcall`, skipping the destructors of the live `args` vector and
`resultHolder` (`try`/`catch` cannot see a longjmp). The skipped
`shared_ptr`s leak their `LuaValue`s and any registry slots they own; the
constructor wrapper's freshly-inserted `js_userdata_` entry
(`lua-native.cpp:1543-1547`) is similarly stranded if the subsequent push of
its result raises. Because the frame *is* protected, the cost is a bounded
leak in an OOM window — not the panic/abort of the documented M5 residual, and
not memory corruption (nothing dangles; things merely never free).

**Recommendation.** Document it next to the M5 residual in
`CODE-REVIEW-DEFERRED.md` as the accepted floor (recommended — the fix would
mean restructuring every bridge's result push into a pre-staged protected
frame, disproportionate to a leak-under-OOM), or restructure if the OOM story
ever hardens. Either way the code and the docs should agree on what an ERRMEM
during result-push costs.

### F7. Nits

- **`InstallPrintHandler` partial state on throw** (`lua-native.cpp:2002-2016`,
  `lua-runtime.cpp:1046-1051`): `print_handler_` and `output_handler_` are
  assigned before `InstallOutputRedirection` runs its protected `_G` writes; if
  those throw (OOM), the handlers stay set while `print`/`io.write` were never
  redirected — the new handler is pinned but unreachable. Assign-after-install
  (or reset on catch) would keep the halves consistent.
- **`set_userdata` rollback window**: `js_callbacks_[func_name]` is assigned
  one statement before `registered_method_fns.push_back(func_name)`
  (`lua-native.cpp:878-880`); a `bad_alloc` from the intervening
  `StoreHostFunction` map insert would strand that one `js_callbacks_` entry
  (the rollback loop never learns the name). Registering the name in
  `registered_method_fns` first (reserving capacity up front) closes it.
  Ultra-narrow; listed for completeness.

---

## Verified and rejected (adversarial suspicions that held up)

- **The resolve path of `OnAwaitSettled`:** conversion of the resolved value is
  wrapped, and failure settles the deferred and tears down (`:1883-1891`).
  Correct — it is what F1's reject path should look like.
- **`Cancel()` reentrancy, all three windows:** during a resume
  (`async_resuming_` → deferred teardown honored post-resume at `:1747`),
  during the attach (`thenFn.Call` running user JS that cancels → teardown runs
  in `Cancel()`, and the attached-path code touches no async state afterward),
  and from marshalling inside `OnAwaitSettled` (the H2 re-check at `:1899`).
  No disengaged-optional dereference found.
- **`RejectIfBusy` coverage:** every synchronous instance method that touches
  the Lua state checks it (full sweep of the `Init` table against the method
  bodies); function handles, table handles, and all five Proxy traps check
  `ContextLive()` + `IsBusy()`. The H9c main-thread gate holds.
- **Constructor option reads vs. hostile getters:** `options.Get(...)` in the
  constructor can throw `Napi::Error`; the ObjectWrap callback wrapper converts
  it to a pending JS exception. Contained.
- **`PushTableKey` numeric-string edges:** `"-"`, `" 12"`, `"+12"`, and
  overflow all stay string keys (the bare-digit precheck plus `ERANGE`).
  Correct.
- **`NapiToCoreImpl` numeric bounds:** the `2^63` upper-exclusive bound and the
  BigInt lossless check are right; `NapiToTableKey` uses the same bounds.
- **Type-converter reentrancy:** the loop indexes `type_converters_` and pulls
  both handles before calling `match` (a reentrant registration reallocates the
  vector; no reference is held across the call). Correct.
- **N1 sentinel arm/count ordering in `PushLuaValue`:** re-verified — the
  re-find after the raise-capable allocations, the arm-then-count order, and
  the unwound-sentinel decrement all hold.
- **`EndWorkerUnrefDeferral` drain:** runs on the worker thread under the same
  mutex every finalizer unref takes; a concurrent main-thread finalizer blocks
  until the drain (and the worker's last Lua touch) is done. Correct.
- **`CreateCoroutineFromScript` stack discipline:** the chunk sits below the
  `RunProtected` frame and is `lua_xmove`d (non-allocating) after; a throw
  unwinds cleanly under the `StackGuard`. Correct.

---

## Suggested priority order

1. **F1** — guard the rejection-value extraction in `OnAwaitSettled`; deliver a
   fallback message instead of wedging. Medium: process exit under Node
   defaults from non-hostile API usage, plus a wedged context.
2. **F2** — migrate `vitest.config.ts` to Vitest 4's top-level `execArgv` and
   make the `global.gc` guard fail loudly. Until then, `npm test`'s green run
   does not exercise the CR-7 F1 use-after-free pin.
3. **F4** — guard `ResultsToJs` in both worker `OnOK`s; reject the deferred on
   conversion failure.
4. **F3** — apply the N5 reorder (core call first) at `set_metatable`,
   `register_module`, and `register_class`.
5. **F5** — `CallScope` on the five metamethod-capable table-handle methods.
6. **F6** — document the ERRMEM-longjmp leak residual in
   `CODE-REVIEW-DEFERRED.md` (or decide to restructure); F7 nits alongside.

(The M5 result-conversion residual and CR-3 M5 remain deferred by decision;
intentionally absent from this list.)

---

## Note on the trajectory

Two lessons this pass. First, the sibling-sweep lesson again, now with a
sharper statement: **every guard introduced by a prior review defines a class,
and the class is only closed when someone greps for its siblings.** F1 is the
unguarded twin of a guarded conversion six lines above it; F4 is `DriveAsync`'s
guard missing from `OnOK`; F3 is the N5 discipline's fourth, fifth, and sixth
sites; F5 is the trap `CallScope` missing from the handle methods. A
remediation that fixes the reported site without sweeping the pattern
reliably donates a finding to the next review.

Second, and new: **regression pins rot silently.** CR-7's most important test
was disarmed not by a code change but by a test-runner major version, and
nothing failed — the guard was polite (`warn` + `return`) and the warning
invisible in a green run. The fix costs one assertion: any test that
self-skips on a missing capability should instead *fail* when that capability
was supposed to be provided by the harness. The suite's numbers are only
meaningful if the tests behind them are actually running.
