# CODE-REVIEW-7

**Date:** July 21, 2026
**Scope:** Seventh pass, the first conducted *with* the sanitizer harnesses in
hand. Primary targets: (1) the CODE-REVIEW-6 remediation commit (`5f7b8f6`) —
both resolutions re-verified against the tree, with the usual attention to what
the fixes left unswept; (2) a fresh adversarial sweep of the async
(`execute_async`/`cancel`) machinery, the one subsystem whose lifetime hazards
the CR-6 H1 matrix does not cover; (3) the sanitizer harness itself
(`binding.gyp` sanitizer targets, `run-sanitized-ts.js`, `run-tests.js`) as new
surface. Line numbers refer to commit `5f7b8f6`.

**Method:** Full read of the `5f7b8f6` diff against the surrounding code, then a
complete re-read of both layers (`lua-native.cpp`/`.h`, `lua-async-worker.h`,
`lua-runtime.cpp`/`.h`) with two systematic questions: (a) which core methods
can throw a C++ exception, and is every binding call site of each one guarded —
extending CR-6's `RunProtected`-only audit to *all* throwing core paths
(`ToLuaValue` depth/stack throws, result conversion, `luaL_ref` sites); (b)
which raw `LuaContext*` pointers can outlive the context — the H3/H5 class —
now that the H1 exception class is matrix-enforced. Every suspect was
**exercised**, not just read: reproductions were run against the freshly built
debug binary and, where the hazard was memory-unsafety, re-run against the
ASan-instrumented addon (`build-asan-addon` + the `run-sanitized-ts.js` preload
mechanics) to get an authoritative verdict.

**Baseline:** 454 TypeScript and 178 C++ tests pass on `5f7b8f6`. The full
vitest suite also passes under the ASan+UBSan-instrumented addon
(`run-sanitized-ts.js asan`): 454/454, no sanitizer report. That clean run and
finding F1 below coexist without contradiction — sanitizers only see the paths a
test executes, and no test exercises F1's path. That is the coverage lesson of
this pass.

---

## Resolution status (July 21, 2026)

All five findings resolved. After the fixes: **459 TypeScript tests** (up from
454 — five new CR-7 regression tests) and **178 C++ tests** pass against a
freshly built debug binary; the full suite also passes under the
ASan-instrumented addon (`run-sanitized-ts.js asan`), now *including* the F1
GC-lifetime path; and both original reproductions are clean — the F1 repro that
aborted (`exit 134`) runs to completion with no ASan report, and the F2 repro's
context is no longer wedged (the failure surfaces as an ordinary rejection).

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | `AwaitCookie` now carries the context's shared liveness flag (the same `alive_` the function/table handles use), and both settlement callbacks check it **before** touching `ctx`, discarding a settlement that outlived the context. Regression test: cancel → drop context → `gc()` → late-settle, asserting process survival. To make it actually run, `--expose-gc` is now provided everywhere: a new `vitest.config.ts` (forks pool `execArgv`) for `npm test`, and `run-sanitized-ts.js` passes it on the node invocation (worker_threads reject V8 flags in `execArgv` but inherit process-wide ones). Verified pre/post: abort + ASan `heap-use-after-free` before, clean run and clean ASan report after. |
| F2 | ✅ Done | The continuation attach in `DriveAsync` is guarded end-to-end: a non-callable `then` and a throwing lookup/call both settle the run — capture the deferred, `FinishAsync()`, reject with `failed to attach to the awaited Promise: …` — so `execute_async` returns a normally-rejecting promise instead of throwing synchronously and wedging the context. A generation re-check (`attach_gen`) prevents the failure branch from tearing down a run that a hostile synchronously-settling-then-throwing `then` already finished or superseded. The cookie is handed to its owning External before any throw-capable step, so no failure path leaks it. Two regression tests (throwing `then`, non-callable `then`). |
| F3 | ✅ Done | New core helper `LuaRuntime::RemoveGlobalRaw` (raw `_G[name] = nil` inside `RunProtected` — no metamethod can re-raise, and a key-push OOM surfaces as a throw). `set_userdata`'s rollback calls it, best-effort, **only when this call installed the global** (`global_installed` flag — a pre-existing same-named global is never deleted); if the removal itself OOMs, the inert global remains the accepted floor. Regression test walks the OOM boundary byte-by-byte (the CR-7 reproduction, adapted) and asserts no failing registration leaves `type(h) == 'userdata'` behind. |
| F4 | ✅ Done | `add_searcher` reordered to the N5 discipline: `AddJsSearcher` runs first; the `js_callbacks_`/`host_functions_` pair is registered only on success, so a failed call (e.g. no `package` library) strands nothing across retries. Safe because nothing resolves the name in `host_functions_` until a later `require()`. Regression test: three failed attempts throw cleanly and the context stays usable; a package-enabled context still registers and resolves a module through the searcher. |
| F5 | ✅ Done | `run-sanitized-ts.js`: `UBSAN_OPTIONS` now defaults to `halt_on_error=1:print_stacktrace=1`, so a UBSan finding fails `test-ts-asan` (matching the C++ harness) instead of passing green with findings in the scrollback; the Linux runtime probe derives the arch from `os.arch()` (`x86_64`/`aarch64`) and falls back to gcc's `libasan.so`/`libtsan.so`, reporting every candidate tried on failure. |

The original findings follow unchanged for reference.

---

## Overall assessment

The CR-6 remediation is present and correct at every site it names: the
constructor, all three `set_userdata` forms, and `set_print_handler` are
guarded; the rollback erases the JS-side state; the six-test regression matrix
pins the H1 class per entry point. The H1 exception-abort class is, as far as
this pass can determine, closed at every reachable site.

But the project's recurring pattern has recurred once more, in its other
long-standing class. With the exception class fenced off, this pass swept the
async machinery for the **H3/H5 class — a raw `LuaContext*` outliving its
owner** — and found a live instance at high severity: the `AwaitCookie` that
`execute_async`'s promise-settlement callbacks carry holds a bare `LuaContext*`
with **no liveness guard**. A promise that settles after `cancel()` has torn the
run down and the context has been garbage-collected invokes the callback on
freed memory. This is not a hostile-input bug: `cancel()` on a pending await is
the API working as designed (cancelling *because* the promise is slow is the
whole use case), and the late settlement is just that promise eventually
resolving. Reproduced two ways: on the plain debug build the process **aborts**
(`FATAL ERROR: Error::New napi_get_last_error_info`, exit 134); under the ASan
addon the report is a clean `heap-use-after-free` READ at
`OnAwaitSettled` (`lua-native.cpp:1801`) — precisely the class
`docs/SANITIZERS.md` says `test-ts-asan` exists for, and the harness pinpointed
it on the first run once a repro drove the path.

Every wrapper that crosses to JS learned this lesson already: `LuaFunctionData`
and `LuaTableRefData` carry the shared `contextAlive` flag (H3's fix), the async
workers hold a `Napi::ObjectReference` on the wrapper, and `async_self_ref_`
roots the context *for the run's duration*. The await-settlement callbacks are
the one crossing that got neither a root nor a liveness flag — and they are
precisely the crossing that outlives the run by design.

The remaining findings are low severity: a wedge via a hostile `then` on the
awaited promise (F2), the Lua-side tail of CR-6 F1's rollback (F3, reproduced
under an OOM window), a stranding regression-in-pattern in `add_searcher` (F4),
and harness polish (F5).

Severity distribution: one high (F1), four low (F2–F5).

---

## Verification of the CODE-REVIEW-6 remediation

| CR-6 # | Verdict |
|--------|---------|
| F1 | ✅ Correct at all named sites. The constructor's `allowBytecode`/`print` install paths are wrapped (`lua-native.cpp:716-730`); `set_userdata` wraps the whole core-call region and rolls back `js_userdata_`/`js_callbacks_`/`host_functions_` via the new `LuaRuntime::RemoveHostFunction` (`:859-892`, `lua-runtime.cpp:858-860`); `set_print_handler` wraps both the install and the clear path (`:1963-1974`). The code at each site matches the resolution's safety argument, and the six regression tests covering these paths pass in the baseline runs (both plain and under the ASan addon). One residual on the rollback's *Lua* side — see F3. |
| F2 | ✅ Correct. The `code-review-6 regressions` block (`lua-native.spec.ts:4991-5063`) arms a raising `_G.__newindex` and sweeps the three `set_userdata` forms, `set_print_handler`, the guarded `_G`-writing siblings, and the strand-nothing retry. All six pass. |

---

## Findings

### F1. `execute_async`'s await-settlement callbacks dereference a freed `LuaContext` — use-after-free → process abort (high) — ✅ DONE

`DriveAsync` attaches settlement callbacks to the awaited promise carrying a
heap `AwaitCookie{ LuaContext* ctx; uint64_t gen; bool settled; }`
(`lua-native.cpp:1701-1707`, `:1755-1762`). The cookie's lifetime is correctly
owned by an External finalizer rooted on both callbacks (the L5 fix), but the
`ctx` pointer inside it is **bare**: no `Napi::ObjectReference` roots the
context for the callbacks' lifetime, and no liveness flag is checked before the
dereference. The only root, `async_self_ref_`, is released by `FinishAsync`
(`:1862`) — which runs not just on completion but on **`cancel()`**
(`:1899-1901`).

So the ordinary sequence

1. `execute_async` suspends awaiting a slow promise (callbacks + cookie now
   attached to it),
2. `cancel()` — rejects the run, `FinishAsync` drops `async_self_ref_`,
3. JS drops its last reference to the context; GC collects the ObjectWrap
   (`~LuaContext` runs, the memory is freed),
4. the promise settles late (it was slow — that's why it was cancelled),

lands in `OnAwaitResolveStatic` → `cookie->ctx->OnAwaitSettled(...)` on freed
memory. The very first statements read members of the dead object: the
`!async_co_ || !async_deferred_ || gen != async_generation_` guard (`:1801`) and
`env.Undefined()` (`:1802`) — the guard that is supposed to discard late
settlements is itself the use-after-free.

**Reproduced** (freshly built binaries, both ways):

```js
function startRun() {
  const lua = new lua_native.init(
    { slow: () => new Promise((res) => setTimeout(() => res(42), 120)) },
    { libraries: 'all' });
  lua.execute_async('return slow()').catch(() => {});
  lua.cancel();          // tears down the run; callbacks stay on the timer promise
}                        // context goes out of scope
startRun();
await delay(10); global.gc(); await delay(10); global.gc();
await delay(200);        // promise settles -> stale callback fires
```

Plain debug build:

```
FATAL ERROR: Error::New napi_get_last_error_info
 5: Napi::Env::Undefined() const
 6: LuaContext::OnAwaitSettled(...)
 7: LuaContext::OnAwaitResolveStatic(...)
 9: Builtins_PromiseFulfillReactionJob
exit code: 134
```

ASan-instrumented addon (`build-asan-addon` + runtime preload):

```
==ERROR: AddressSanitizer: heap-use-after-free ... READ of size 1
  #0 std::__1::__optional_storage_base<lua_core::LuaThreadRef,...>::has_value()
  #2 LuaContext::OnAwaitSettled(...)  lua-native.cpp:1801
  #3 LuaContext::OnAwaitResolveStatic(...)  lua-native.cpp:1874
  #9 Builtins_PromiseFulfillReactionJob
```

This is the H3/H5 class — "raw `LuaContext*` that outlives its owner" — in the
one crossing that never received the class's fix. `LuaFunctionData` and
`LuaTableRefData` both carry the shared `contextAlive` atomic precisely so a
retained handle fails cleanly after `~LuaContext`; the `AwaitCookie` is a
retained handle in every sense that matters and carries nothing.

**Recommendation.** Give `AwaitCookie` the same discipline as the other
crossings: add `std::shared_ptr<std::atomic<bool>> alive` (populated from the
context's `alive_`), and have both static callbacks return immediately when
`!alive->load()` — before touching `ctx`. (Rooting the wrapper on the callbacks
via a hidden prop would also work but extends the context's lifetime to that of
an arbitrary user promise; the liveness flag matches the existing pattern and
the intended semantics — a late settlement is discarded either way.) Then sweep
the class one more time: the cookie was the last raw `LuaContext*` I could find
that survives its rooting scope (`worker->context_` is covered by
`contextRef_`), and the fix should keep it that way by convention — any future
callback that stashes `this` for a later tick must carry `alive_`.

**Test.** Add the reproduction above (guarded by `typeof global.gc ===
'function'`, as the stress runs already do) to the suite so `test-ts-asan`
exercises the path — the harness proved it reports this instantly *when driven*.
This pass's clean 454-test ASan run is the demonstration that the harness's
value is bounded by the adversarial coverage of the suite it runs.

### F2. A hostile `then` on the awaited promise wedges the run; the forced recovery then exits the process by default (low) — ✅ DONE

`DriveAsync`'s continuation attach is unguarded: `promise.Get("then")`,
`.As<Napi::Function>()`, `thenFn.Call(...)` (`:1752-1762`). `IsPromise` (checked
in `CreateJsCallbackWrapper`) verifies a *native* promise, but an own `then`
property shadows `Promise.prototype.then` at the `Get`, and a monkey-patched or
throwing `then` makes the attach throw a `Napi::Error` that unwinds out of
`DriveAsync` mid-run. **Reproduced:**

```
execute_async threw synchronously: hostile then
is_busy after throw: true
context wedged: Lua context is busy with an async operation
after cancel, is_busy: false – execute_script: 2
Error: execution cancelled   <- unhandled rejection, process exits 1
```

Two consequences: (1) the run is left engaged (`is_busy_` true, `async_co_`
set, every sync entry point rejected) with the returned promise never handed to
the caller — `execute_async` threw instead of returning it; (2) recovery via
`cancel()` therefore rejects a promise **no JS code can have attached a handler
to**, which is an unhandled rejection and a default process exit. The caller
cannot avoid this: the promise object never reached them. On a *second* await
(the attach inside `OnAwaitSettled`-driven resumes) the throw instead escapes an
N-API reaction-job callback — an `uncaughtException` by default.

Calibration: this requires a promise deliberately (or via an instrumentation
polyfill) carrying a throwing `then`, the same trust level as the L5 hostile
promise — hence low, despite the ugly default outcome.

**Recommendation.** Wrap the attach step (from `Get("then")` through
`thenFn.Call`) in try/catch; on failure — including a non-function `then`,
which today is an unchecked `.As<Napi::Function>()` — settle the run: capture
the deferred, `FinishAsync()`, reject with a descriptive error. `ExecuteAsync`
then still returns the (now rejected) promise, so the failure surfaces as an
ordinary rejection instead of a wedge. Same guard at the `OnAwaitSettled` call
site of `DriveAsync`.

### F3. `set_userdata`'s rollback restores the JS side but can leave the Lua global installed — the "strands nothing" claim has a Lua-side tail (low) — ✅ DONE

The CR-6 F1 rollback runs when any core call in the guarded region throws. But
the region contains *two* independently-failing Lua operations: the global
install (`CreateProxyUserdataGlobal`, `:863`) and the method-table build
(`SetUserdataMethodTable`, `:882`). When the first succeeds and the second hits
the `maxMemory` limit, the catch erases `js_userdata_[ref_id]` and the callback
entries — but the proxy userdata is already installed as `_G[name]` and is not
removed. The result: `set_userdata` throws, yet the global exists as a
permanently inert proxy (every property read is nil — the getter's
missing-`ref_id` branch — and writes are silently dropped).

**Reproduced** by padding Lua memory to byte precision under
`maxMemory: 200000`:

```
SPLIT at pad=189313: set_userdata threw ('not enough memory')
                     but type(h) == 'userdata'; h.x -> null
```

No memory-unsafety (the GC/refcount path handles the orphaned userdata
correctly, and the erased `ref_id` is never reused — `next_userdata_id_` is
monotonic); this is a consistency residual in an OOM window, hence low. Note the
CR-6 regression tests could not see it: the hostile-`__newindex` trigger fails
at the global *write itself*, so the split state — write succeeded, later step
failed — is reachable only via the OOM trigger, which the matrix doesn't drive.

**Recommendation.** In the catch, best-effort-remove the global before erasing
the maps: raw-set `_G[name] = nil` inside its own try/catch (raw, so a hostile
`__newindex` can't re-raise; guarded, because the key push can itself OOM — if
that fails, the inert global is the accepted floor). Alternatively, document the
residual in `CODE-REVIEW-DEFERRED.md` alongside the M5 remainder; either
resolution is defensible, but today the code and CR-6's "strands nothing" claim
disagree.

### F4. `add_searcher` strands `js_callbacks_`/`host_functions_` entries on failure — the N5 ordering discipline, not applied (low) — ✅ DONE

`AddSearcher` (`:1978-1995`) registers the JS reference and the host function
*first* (`:1986-1987`) and only then calls `AddJsSearcher` inside its try. On
throw — trivially reachable: `add_searcher(fn)` on a context whose `libraries`
omit `package` throws "Cannot add searcher: the 'package' library is not
loaded" — nothing is rolled back. Each failed call permanently strands a
`Napi::FunctionReference` (pinning the JS closure) plus a `host_functions_`
entry and burns a `__searcher_N` name; a retry loop accumulates them without
bound. This is exactly the hazard the N5 fix ordered `RegisterFunction` around
("Runtime registration first: if the protected `_G` write throws, no
`js_callbacks_`/`host_functions_` entry is left behind" — `:744-746`, `:772-774`)
and that CR-6 F1 added rollback for in `set_userdata`; `add_searcher` predates
the discipline and was never swept into it.

**Recommendation.** Reorder: call `runtime->AddJsSearcher(name)` first, then
register the callback pair on success. This is safe here — `AddJsSearcher` only
stores the name in the closure's upvalue; nothing resolves it in
`host_functions_` until a later `require()`, and no Lua runs between the two
statements. (Rollback-on-catch works too, but the reorder is strictly simpler
and matches N5.)

### F5. Sanitizer harness: UBSan findings cannot fail the TS run, and the Linux runtime probe is x86_64/clang-only (low) — ✅ DONE

Two gaps in the otherwise solid new harness:

- **UBSan silent pass (TS harness).** The addon is deliberately built
  *recoverable* (no `-fno-sanitize-recover`, `binding.gyp:145-149`), so a UBSan
  violation logs and continues — and `run-sanitized-ts.js` sets only
  `UBSAN_OPTIONS=print_stacktrace=1` (`:76`). Nothing makes a logged violation
  fail the run: `test-ts-asan` exits green with UBSan findings in the scrollback.
  This is inconsistent with the C++ harness, where `run-tests.js` sets
  `UBSAN_OPTIONS=halt_on_error=1` *and* the binary is built
  `-fno-sanitize-recover=all`. Either add `halt_on_error=1` to the TS harness's
  `UBSAN_OPTIONS` (a recoverable build still halts when the runtime is told to),
  or keep the log-and-continue behavior but have `run-sanitized-ts.js` capture
  output and exit non-zero on `runtime error:` matches.
- **Linux probe portability.** The runtime library names hardcode
  `libclang_rt.{asan,tsan}-x86_64.so` (`:31-36`): on arm64 Linux the probe fails
  outright, and with gcc (whose runtime is `libasan.so`/`libtsan.so`) the error
  message ("Ensure a clang…") contradicts the header comment's "clang/gcc"
  claim. Derive the arch from `os.arch()` and/or probe the gcc names as a
  fallback — or narrow the documented support to clang and say so in the error.

Cosmetic, macOS is the primary platform, and the ASan half (the one that
matters most) fails correctly via `abort_on_error=1` — hence low.

---

## Verified and rejected (adversarial suspicions that held up)

- **Unguarded binding calls into throwing core paths (the F1-class audit,
  extended past `RunProtected`):** `ExecuteScript`, `ExecuteFile`,
  `CallFunction`, `LoadBytecode`, `ResumeCoroutine`, `ResumeAsyncStep`, and
  `CreateCoroutine` are all called without a binding-side try/catch — and all
  are safe: each converts results/arguments inside an internal try/catch and
  returns the failure through its error variant (`lua-runtime.cpp:1794-1801`,
  `:1812-1819`, `:2355-2363`, `:2525-2533`, …), so a `ToLuaValue`/`PushLuaValue`
  depth or stack throw cannot escape them. `CompileScript`/`CompileFile` cannot
  throw (protected load, writer traps its own `bad_alloc`). `GetCoroutineStatus`
  is throw-free. The audit found no new H1 site.
- **`CaptureError` under pathological error objects:** the `ToLuaValue` capture
  is wrapped, the `message` probe is raw, stringification runs under a protected
  `__tostring` trampoline. Correct. (The known, *documented* M5 residual stands
  and gains one noted instance: converting a metatabled-table error object — and
  any function/thread/table-ref **result** after `ProtectedCall` returns — runs
  `luaL_ref` outside any protected frame, so an ERRMEM longjmp there under an
  exhausted `maxMemory` remains an unprotected panic. Same accepted class as the
  `CODE-REVIEW-DEFERRED.md` M5 entry; ASan cannot see it — it is a longjmp, not
  a memory error.)
- **`CreateConstructorWrapper` vs. a frozen `construct()` return:**
  `DefineHiddenProp` on a frozen/sealed instance throws `Napi::Error` outside
  the lambda's try — but it lands in `LuaCallHostFunction`'s
  `catch (const std::exception&)` and is staged as a Lua error. Contained.
- **`set_userdata` rollback re-entrancy:** the GC callback erasing
  `js_userdata_` for an already-rolled-back `ref_id` is a no-op erase;
  `next_userdata_id_` monotonicity prevents aliasing a recycled id. Correct
  (F3's residue is the global, not the maps).
- **Worker `context_` raw pointer (same shape as F1):** covered — the worker
  holds `contextRef_`, a `Napi::ObjectReference` on the wrapper, for its whole
  lifetime, so `OnOK`/`OnError` cannot see a freed context. The cookie was the
  only unrooted, unguarded crossing found.
- **`Pcall` catching only `Napi::Error`:** the callee is a JS function; a Lua
  handle called through it throws only via `ThrowAsJavaScriptException` →
  `Napi::Error`. No `std::exception` leak path found.
- **Sanitizer flag plumbing:** `-Daddon_asan`/`-Daddon_tsan`/`-Dsanitize`/
  `-Dcpp_tsan` reach both `cflags` and `xcode_settings` on every target;
  `run-sanitized-ts.js` forcing the threads pool is correct and necessary (a
  forked worker re-execs without `DYLD_INSERT_LIBRARIES` — confirmed
  incidentally when a bare `node` run against the instrumented addon failed with
  "interceptors are not working"). TSan's `halt_on_error=0` still fails the run
  at exit via TSan's default non-zero `exitcode` when a race was reported.

---

## Suggested priority order

1. **F1** — liveness-guard the `AwaitCookie` (carry `alive_`, check it in both
   static callbacks before touching `ctx`), and add the cancel→GC→late-settle
   reproduction to the suite so `test-ts-asan` pins the class. High:
   use-after-free → process abort from ordinary, non-hostile API usage.
2. **F2** — guard the continuation attach; settle the deferred on failure so
   the error surfaces as a rejection instead of a wedge plus an unavoidable
   unhandled rejection.
3. **F4** — reorder `add_searcher` registration after the core call (N5
   discipline); closes an unbounded accumulation on a trivially-reachable
   failure.
4. **F3** — best-effort global removal in `set_userdata`'s rollback, or
   document the inert-global residual in `CODE-REVIEW-DEFERRED.md`.
5. **F5** — make UBSan findings fail `test-ts-asan`; fix or narrow the Linux
   runtime probe.

(M5's result-conversion residual and CR-3 M5 remain deferred by decision;
intentionally absent from this list.)

---

## Note on the trajectory

CR-6 closed the H1 exception class with a per-entry-point matrix; this pass
confirms that closure held — the extended audit found no new H1 site, a first
across seven reviews. But F1 is the H3/H5 pointer-lifetime class recurring in
the async subsystem, at high severity, in code every prior pass read. The
matrix-and-sanitizer strategy works exactly as far as it is driven: the ASan
harness reported F1 flawlessly *once a reproduction exercised the path*, while
454 green tests under the same harness said nothing. The durable lesson matches
`CODE-REVIEW-THOUGHTS.md`: each lifetime-bearing crossing (today: function
handles, table handles, workers, await cookies) needs both the liveness
convention *and* an adversarial teardown test — created-then-killed-then-used —
in the suite the sanitizers run. F1's test is the template; the crossing
inventory in its recommendation is the checklist.
