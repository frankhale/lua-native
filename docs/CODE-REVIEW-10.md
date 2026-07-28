# CODE-REVIEW-10

**Date:** July 28, 2026
**Scope:** Tenth pass, against commit `9260396` — the CODE-REVIEW-9 remediation
itself, plus a full re-read of both C++ layers. This is a *small-diff* window:
one commit (`+1,570 / -99`) landed since the CR-9 baseline `6839145`, and it is
entirely remediation — `LuaRuntime::ExecutionScope`, `IsExecuting()`, the
`in_reset_` flag, twelve new `CallScope`s, the `shared_ptr` output handler, the
`unique_ptr` handle-construction ownership, and the `add_searcher` replay. So
the pass had two targets: (1) verify each CR-9 fix in the tree, and (2) ask the
question CR-9's own remediation invites — **the invariant moved into the core,
so is the core's version of it actually complete?**

**Method:** Complete read of `lua-native.cpp`/`.h`, `lua-async-worker.h`,
`lua-runtime.cpp`/`.h`, then targeted adversarial verification. Every finding
below was **reproduced** against the freshly built debug binary
(`build/Debug/lua-native.node` at `9260396`), with controls isolating the exact
precondition. Both high-severity findings were additionally re-run against the
ASan+UBSan-instrumented addon (`npm run build-asan-addon` plus the
`run-sanitized-ts.js` preload mechanics) and are reported with their sanitizer
verdict. `--expose-gc` was used for the lifetime work.

**Baseline:** 767 TypeScript and 262 C++ tests pass at `9260396`, unchanged from
the CR-9 remediation's own figures. Nothing regressed.

---

## Resolution status (July 28, 2026)

All findings resolved. After the fixes: **777 TypeScript tests** (up from 767 —
ten new CR-10 regression tests) and **275 C++ tests** (up from 262 — thirteen
new) pass against a freshly built debug binary. The full suite also passes under
the ASan+UBSan-instrumented addon (`npm run test-ts-asan`, 777/777, no sanitizer
report) and the C++ core under `test-cpp-asan` (275/275, clean). Every
reproduction in this review was re-run against the fixed build: all three F1
crash vectors now report the guard's error and the process survives, and both F2
vectors — teardown and mid-program — exit cleanly with no ASan or UBSan report.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | Fixed as a class, per the recommendation. All **seven** core chunk loaders now open an `ExecutionScope` around the load — `CompileScript`, `CompileFile`, `ExecuteScript`, `ExecuteFile`, `ExecuteScriptInEnvironment`, `LoadBytecode` and `CreateCoroutineFromScript` — so the core's invariant no longer depends on the binding's `call_depth_` at the four rows that were merely *masked*. The scope is deliberately tight around the load on the five paths that then call `ProtectedCall`, so parse time is not folded into the execution budget. `compile`, `compile_file` and `execute_async` received the `CallScope` their twelve siblings already had (`execute_async`'s scoped to the load alone, so it is not held across a suspended await). The invariant's wording was corrected at its source: `IsExecuting()` and `SetTimeout` now state the trigger as **"can allocate from Lua"**, not "runs Lua", and say why parsing counts. Six C++ pins plus three TS pins. **Verified to fail without the fix:** 6 of the 7 C++ pins fail; the TS pins crash the vitest worker outright ("Worker exited unexpectedly"). |
| F2 | ✅ Done | Both halves of the recommendation. (1) A new `context_alive_` flag — deliberately *distinct* from `alive_`, which `reset()` re-mints — is captured by value into `CreateJsCallbackWrapper` and `CreateConstructorWrapper` and checked before any member access, including the `HandleScope`'s `env`. That is the class-level fix: it holds however the destruction races, including the runtime-outlives-context case ordering alone cannot reach. (2) A new core `LuaRuntime::ClearHostFunctions()` is called from `~LuaContext` before its members die, so a teardown finalizer fails at lookup rather than relying on every wrapper remembering to check. It is deliberately **not** called from `~LuaRuntime` or `DetachRuntimeHandlers`, both of which are on the `reset()` path where the retiring state's finalizers must still reach the live context — pinned by a control test. Five TS and three C++ tests. **Verified to fail without the fix:** the TS pins crash the vitest worker. |
| F3 | ✅ Done | All four nits. `GarbageCollect` now scopes `collect` and `step` individually instead of bracketing the whole function, so the read-only commands no longer claim `IsExecuting()` or restart the per-execution budget; `GarbageCollectParam` carries a comment recording that its lack of a scope is deliberate. `PushLuaValueProtected`'s "every call site is already nested" precondition is written down at its declaration. `add_searcher`'s two `Napi::Persistent`s are explained at the site. Two C++ and two TS tests, including one pinning that a read-only `gc()` command cannot refresh an instruction budget. |

The original findings follow unchanged for reference.

---

## Verification of the CODE-REVIEW-9 remediation

| CR-9 # | Verdict |
|--------|---------|
| F1 | ✅ Correct **at every site it names**, and the relocation is the right shape. `LuaRuntime::ExecutionScope` (`lua-runtime.h:794-805`) is non-throwing and allocation-free; `IsExecuting()` is consulted by `reset()` ahead of `call_depth_` (`lua-native.cpp:3028`); `in_reset_` closes the `lua_close`-finalizer window. Re-exercised the `gc('collect')` and `execute_script` vectors: both reject with the guard's error and the process survives. But the invariant the core now owns is stated as "every path that can run Lua," and that is narrower than the hazard — see F1 below. |
| F2 | ✅ Correct, and it did not become an escape. Both CR-9 reproductions now pass: a cheap metamethod read after idling 400 ms past a 200 ms deadline succeeds, and thirty `handle.get` calls each well inside a 200,000-instruction budget all succeed. The negative control still binds — an infinite-looping `__index` reached through a table handle is aborted with `instruction limit exceeded`. `BeginExecutionBudget` is called only from `ExecutionScope`, so nested re-entry shares the enclosing budget as documented. |
| F3 | ✅ Correct. `searchers_` records the function after the core call succeeds (`lua-native.cpp:3372`) and `Reset()` replays it with a freshly minted `__searcher_N` name from the still-monotonic counter. Verified end to end: `require("jsmod").v` returns 99 both before and after a `reset()`. |
| F4 | ✅ Correct at all four items. `output_handler_` is a `shared_ptr` dispatched through `DispatchOutput`, which copies the owner and contains throws; a print handler that calls `set_print_handler(null)` from inside itself survives. `InstallDebugHook` is wrapped at both call sites. `CreateTableHandle`, `CreateCoroutineObject` and the coroutine iterator hold their data in a `unique_ptr` until the External's finalizer takes ownership. |

---

## Overall assessment

The CR-9 remediation is the best piece of work in this series. It did not add
twelve guards and hope; it moved the fact into the core so that a new *binding*
method is safe by construction. That was the right call, and it holds: every
binding method added from here on inherits the guard without knowing it exists.

The two findings below are both consequences of where that relocation stopped.

**The invariant the core adopted is "a path that can run Lua opens an
`ExecutionScope`."** The actual hazard is broader: **a path that can *allocate
from Lua*.** An allocation drives a GC step, a GC step runs `__gc` finalizers,
and a `__gc` finalizer is Lua code that can re-enter the host. The remediation
knew this — `ToLuaValueProtected`'s new comment says so almost verbatim ("its
`luaL_ref` and table allocations can drive a GC step, and a `__gc` finalizer is
Lua code that can re-enter the host") — but the reasoning was applied at that
one site and not swept to the largest allocator in the codebase: **the chunk
loader.** `luaL_loadbuffer` / `luaL_loadfile` allocate heavily while parsing,
and none of the seven core methods that call them opens a scope. Three of those
are reachable from binding methods that also carry no `CallScope`, so on those
three `reset()`'s guard is completely disarmed. Reproduced and ASan-confirmed as
a `heap-use-after-free` at the identical instruction CR-9 F1 reported — reached
through the *parser* instead of a metamethod (F1).

The second finding is older and, in this reviewer's judgement, the most serious
thing any pass has surfaced, precisely because nothing about it is adversarial.
`~LuaRuntime` carefully clears three binding-bridging handlers before
`lua_close` so teardown finalizers cannot call into a torn-down host — but not
`host_functions_`, the primary JS-callback bridge. `~LuaContext` destroys
`js_callbacks_` before `runtime`, so `lua_close`'s `__gc` finalizers reach the
callback wrapper and index a **destroyed `unordered_map`**. Seven lines of
entirely ordinary code segfault; with a table handle in play it segfaults
*mid-program* at an arbitrary GC point rather than at exit (F2).

Severity distribution: two high (F1, F2), plus nits (F3). No previously-fixed
site regressed.

---

## Findings

### F1. The chunk loaders allocate outside any `ExecutionScope` — `reset()`'s guard is disarmed on `compile`, `compile_file` and `execute_async` (high)

CR-9 F1 established that the core owns the "Lua is live on the C stack" fact,
and `reset()` consults it:

```cpp
// lua-native.cpp:3028
if (runtime->IsExecuting() || call_depth_ > 0) { /* reject */ }
```

`IsExecuting()` is true only inside an `ExecutionScope`. Seven core methods load
a Lua chunk, and **none of them brackets the load**:

| Core method | Unbracketed call | Binding entry point | `CallScope`? |
|---|---|---|---|
| `CompileScript` | `luaL_loadbuffer` (`lua-runtime.cpp:1842`) | `compile` (`lua-native.cpp:1816`) | ✗ **none** |
| `CompileFile` | `luaL_loadfile` (`:1879`) | `compile_file` | ✗ **none** |
| `CreateCoroutineFromScript` | `luaL_loadbuffer` (`:3293`) | `execute_async` (`lua-native.cpp:2584`) | ✗ **none** |
| `ExecuteScript` | `luaL_loadbuffer` (`:2236`) | `execute_script` | ✓ masks it |
| `ExecuteFile` | `luaL_loadfile` (`:2270`) | `execute_file` | ✓ masks it |
| `ExecuteScriptInEnvironment` | `luaL_loadbuffer` (`:3096`) | `execute_script_in` | ✓ masks it |
| `LoadBytecode` | `lua_load` (`:2191`) | `load_bytecode` | ✓ masks it |

Parsing a chunk allocates continuously — every string the lexer interns, every
prototype the parser builds — and each allocation can drive a GC step, which
runs pending `__gc` finalizers. A finalizer is Lua, and Lua can call a
registered JS host function, which can call `reset()`. On the top three rows
nothing is armed: the core reports depth 0 and the binding never opened a
`CallScope`. `reset()` proceeds to `runtime = std::move(fresh)`, `~LuaRuntime`
runs `lua_close`, and the parser's frames continue on a freed `lua_State`.

**Reproduced at all three entry points** against the `9260396` debug build. The
shape is the same each time — an ordinary finalizer, no metatable on `_G`, no
hostile input:

```js
const lua = new lua_native.init({
  notify: () => { try { lua.reset(); } catch {} return 1; }
}, { libraries: 'all' });

lua.execute_script(`function mk(n)
  for i=1,n do local t = setmetatable({}, { __gc = function() notify() end }); t = nil end
end`);
lua.execute_script('mk(400)');          // leave garbage pending

const big = 'local x = 0\n' + 'x = x + 1\n'.repeat(4000) + 'return x';
lua.compile(big);                       // <- reset() succeeds inside the parser
```

| Entry point | Result |
|---|---|
| `compile` | reset() **succeeds** inside `__gc` → SIGBUS (138) |
| `compile_file` | reset() **succeeds** inside `__gc` → SIGSEGV (139) |
| `execute_async` | reset() **succeeds** inside `__gc` → SIGBUS (138) |

Under the ASan-instrumented addon the verdict is unambiguous, and lands on the
identical instruction CR-9 F1 reported:

```
==3197==ERROR: AddressSanitizer: heap-use-after-free ... READ of size 1
  #0  lua_core::LuaRuntime::LuaCallHostFunction(lua_State*)  lua-runtime.cpp:1789
  #6  GCTM
  #7  singlestep
  #8  luaC_step
  #10 llex
  #13 luaY_parser
  #17 lua_load
  #18 luaL_loadbufferx
  #19 lua_core::LuaRuntime::CompileScript(...)              lua-runtime.cpp:1842
  #20 LuaContext::Compile(Napi::CallbackInfo const&)        lua-native.cpp:1816
```

The freed byte at frame #0 is `runtime->await_pending_` — the exact read CR-9
F1 named. Only the route changed: `luaC_step` from inside `llex`, rather than a
metamethod.

**Controls confirm the guard works where it is armed.** The same finalizer
reached through `execute_script` and through `gc('collect')` — both of which do
carry a scope — is rejected with `"reset() cannot be called while Lua is
executing (from inside a host callback, metamethod, or __gc finalizer)"` and the
process survives (exit 0) in both cases.

**Calibration.** High, for the same reason CR-9 F1 was: no adversary is
required. A `__gc` finalizer that notifies JS is an ordinary pattern, `compile`
is an ordinary call, and `reset()` from a callback is the feature working as
advertised. `execute_async` is the most exposed of the three, since it is the
recommended path for Lua that calls back into JS. The four masked rows are not
currently exploitable, but they are masked by the *binding's* `call_depth_` —
the very second-opinion counter CR-9 demoted precisely because it depends on
each method remembering.

**Second consequence, same gap.** `compile`, `compile_file` and `execute_async`
also never clear `js_error_registry_`, so a JS callback that throws from inside
a finalizer on those paths stages an entry nothing consumes — the CR-8 F5
accumulation at three more unswept sites. (The sites CR-9 *did* sweep are
healthy: a 20-call `WeakRef` pin on `get_global_ref` leaves 0 pinned and
`handle.get` leaves 1, matching the fixed behaviour.)

**Recommendation.** Fix the class, not the three reachable rows. Open an
`ExecutionScope` around the chunk load in all seven core methods — `ExecuteScript`,
`ExecuteFile`, `ExecuteScriptInEnvironment` and `LoadBytecode` included, so the
core's invariant stops depending on the binding's counter — and give `compile`,
`compile_file` and `execute_async` the `CallScope` their twelve siblings
received. Then correct the invariant's statement in `IsExecuting()`'s and
`SetTimeout`'s documentation: the trigger is **"can allocate from Lua"**, not
"can run Lua." Every remaining bare `lua_*` allocation outside a scope should be
re-read against that wording; `ToLuaValueProtected`'s comment already contains
the correct reasoning and is the model.

**Test.** The three reproductions above, asserting the call throws the guard's
error and the process survives, plus the `execute_script` / `gc('collect')`
controls. They belong in the suite `test-ts-asan` runs — the harness reported
this on the first instrumented run once a reproduction drove the path.

**Related, same window (not filed separately).** `execute_async` sets
`is_busy_` only *after* `CreateCoroutineFromScript` returns, so a finalizer
firing during that load can re-enter `execute_async` itself. Verified accepted;
both the inner and outer promises settled correctly and `is_busy()` returned to
false, so no separate defect was demonstrated — but the inner run would strand
its own promise if it suspended on an await, since the outer then overwrites
`async_co_` / `async_deferred_`. Bracketing the load closes this window too.

### F2. The host-function bridge outlives the `LuaContext` it calls through — use-after-free on any Lua `__gc` finalizer that calls a JS callback (high)

`~LuaRuntime` deliberately unbinds the host before `lua_close` fires teardown
finalizers:

```cpp
// lua-runtime.cpp:529-533
userdata_gc_callback_ = nullptr;
output_handler_.reset();
host_fn_gc_callback_ = nullptr;
```

Three handlers, with a comment explaining exactly why ("lua_close() below runs
`__gc` metamethods, which can reach the … callbacks. Clear them first so
teardown never calls back into a … torn-down host handler"). The fourth bridge
— `host_functions_`, the map every registered JS callback is dispatched through
— is cleared by neither `~LuaRuntime` nor `DetachRuntimeHandlers`
(`lua-native.cpp:1073-1082`, which clears the other four plus the debug hook).

The destruction order does the rest. In `LuaContext`, `runtime` is declared at
`lua-native.h:321` and `js_callbacks_` at `:322`, so members are destroyed in
reverse and **`js_callbacks_` dies first**. `~LuaContext`'s body
(`lua-native.cpp:2310-2317`) runs `DetachRuntimeHandlers()`, then the members go,
then `~shared_ptr<LuaRuntime>` runs `lua_close` — which fires `__gc`, reaches
`LuaCallHostFunction`, finds the still-populated `host_functions_` entry, and
calls the wrapper lambda. That lambda's first act is:

```cpp
// lua-native.cpp:2380, inside CreateJsCallbackWrapper
auto cbIt = js_callbacks_.find(name);
```

on a destroyed `unordered_map`.

**Reproduced in seven lines**, no adversary, no `reset()`, no metatable on `_G`:

```js
const lua = new lua_native.init(
  { log: (m) => { console.log('lua says:', m); return 1; } },
  { libraries: 'all' });

lua.execute_script(`
  local resource = setmetatable({}, { __gc = function() log("closing resource") end })
  _G.keep = resource
`);
console.log('script done; exiting normally now');
// prints the message, then: NODE EXIT=139 (SIGSEGV)
```

The controls isolate the precondition exactly:

| Variant | Result |
|---|---|
| `__gc` finalizer that calls a JS callback | **SIGSEGV (139)** |
| `__gc` finalizer that runs only Lua | clean (exit 0) |
| JS callback, no `__gc` finalizer | clean (exit 0) |
| `__gc` finalizer calling JS, drained by `reset()` while the context is alive | clean — prints `lua says: closing` |

That last row is the diagnostic one: the bridge works correctly whenever the
context is alive. Only `~LuaContext`'s member ordering breaks it.

Under UBSan the mechanism is spelled out in full — `reference binding to null
pointer` in `__hash_table::find`, called from
`CreateJsCallbackWrapper::$_0::operator()` at `lua-native.cpp:2380`, reached
from `LuaCallHostFunction` (`lua-runtime.cpp:1766`) ← `GCTM` ←
`luaC_freeallobjects` ← `close_state` ← `~LuaRuntime` (`lua-runtime.cpp:546`)
← `~LuaContext` (`lua-native.cpp:2317`) ← `ObjectWrap<LuaContext>::FinalizeCallback`.

**This is not confined to process exit.** Because every returned handle holds a
`shared_ptr<LuaRuntime>`, the runtime routinely outlives its context — that is
the documented design of `reset()` and of the handle types. When the last handle
is then collected, `lua_close` runs at an arbitrary GC point with the
`LuaContext` long gone. **Reproduced mid-program**, with `--expose-gc`:

```js
let handle = null;
(function build() {
  const lua = new lua_native.init({ log: (m) => { console.log('lua says:', m); return 1; } },
                                  { libraries: 'all' });
  lua.execute_script(`_G.keep = setmetatable({}, { __gc = function() log("late finalizer") end })`);
  handle = lua.create_table({ a: 1 });   // holds a share of the runtime
})();
global.gc();                              // context collected; runtime survives
handle = null;
global.gc();                              // <- lua_close here: SIGSEGV, mid-program
```

**Root cause, stated at the class level.** `CreateJsCallbackWrapper`
(`lua-native.cpp:2371`) and `CreateConstructorWrapper` (`:2408`) capture a raw
`LuaContext* this` and check nothing before touching `js_callbacks_`,
`js_userdata_` and `next_userdata_id_`. Every *other* holder that can outlive
the context carries the shared liveness flag and checks it first —
`LuaFunctionData`, `LuaTableRefData`, `LuaContextBinding`, `LuaCoroIterState`
and `AwaitCookie` all do, and CR-9 explicitly re-verified the newest of them
against that checklist. The host-function wrappers are the oldest crossing in
the codebase and the only one that never received the discipline H3/H5 and
CR-7 F1 established.

**Recommendation.** Both halves:

1. **Make the wrappers honour the liveness flag.** Capture the `alive_`
   `shared_ptr<atomic<bool>>` alongside `this` in both wrappers and return early
   (or throw, so Lua reports it as an ordinary finalizer warning) when it is
   false. This is the class-level fix — it holds no matter who destroys what
   first, including the runtime-outlives-context case that ordering alone cannot
   address.
2. **Close the teardown window explicitly.** Give the core a
   `ClearHostFunctions()` and call it from `~LuaContext` *before* the members
   die, so a teardown finalizer degrades to the existing "host function not
   found" path rather than reaching a half-destroyed object. Do **not** put it
   in `~LuaRuntime` or `DetachRuntimeHandlers` unqualified: both are also on the
   `reset()` path, where finalizers of the retiring state legitimately reach a
   live context today (the fourth control row above), and clearing there would
   silently remove that.

**Test.** The seven-line teardown reproduction and the `--expose-gc`
mid-program reproduction, both asserting the process survives, plus the three
controls that isolate the precondition. Both belong in the `test-ts-asan` suite.

**Why nine passes missed it.** The suite has eleven `__gc` tests and several do
call a JS callback from a finalizer — but every one of them drains the finalizer
with an explicit `lua.gc('collect')` *during* the test, while the context is
alive (`lua-native.spec.ts:6527`, `:6726`, `:8203`, `:8236`). None ever leaves a
finalizer **pending at context destruction**, which is the only state in which
this fires. The hazard was never a subtle one; it simply sat one step past where
every test stopped.

### F3. Nits

- **`GarbageCollectParam` has no `ExecutionScope`, its sibling `GarbageCollect`
  has one** (`lua-runtime.cpp:448` vs `:401`). Benign — `lua_gc(LUA_GCPARAM)`
  reads or writes a tuning field and runs no finalizer — but the two are
  adjacent, near-identical wrappers over `lua_gc`, and the asymmetry invites the
  reader to conclude one of them is wrong. Listed for symmetry.
- **`GarbageCollect` brackets its non-collecting commands too.** The scope is
  opened before the command dispatch, so `gc('count')`, `gc('stop')`,
  `gc('restart')` and `gc('isrunning')` each report `IsExecuting()` true and,
  at depth 0, restart the per-execution budget via `BeginExecutionBudget`. The
  comment argues the cost is "only an integer increment," which is true of the
  increment but overlooks the budget reset. Harmless today (these are callable
  only between executions, where a reset is what you would want anyway); worth
  narrowing to `collect`/`step` so the scope means what `IsExecuting()` says.
- **`PushLuaValueProtected` is `static` and therefore cannot open an
  `ExecutionScope`** (`lua-runtime.cpp:2105`), unlike every other
  protected-frame helper. It is safe only because all six call sites are host
  bridges already nested inside one of ours, so the depth is never 0. That is a
  real invariant and it holds — but it is unwritten, and it is the one
  protected-frame helper a future caller could reach from depth 0 without the
  compiler objecting. One comment.
- **`add_searcher` holds two independent strong references to the same
  function** — `js_callbacks_[name]` (`lua-native.cpp:3368`) and `searchers_`
  (`:3372`), each its own `Napi::Persistent`. Correct, and deliberate given the
  two lifetimes, but the second is easy to misread as a leak; a line saying why
  both exist would pay for itself.

---

## Verified and rejected (adversarial suspicions that held up)

- **`ExecutionScope` under worker-thread async.** `lua_depth_` is a
  non-atomic `mutable int` written by the worker thread inside
  `ProtectedCall`. Every main-thread reader (`reset()`, `gc`, `set_hook`) is
  behind `RejectIfBusy`, and the only main-thread work that runs during a worker
  run — N-API finalizers — reaches `UnrefOrDefer`, which touches the mutexed
  deferral queue and never `lua_depth_`. Same for `instruction_count_` /
  `deadline_`, which only the worker touches. No race found.
- **`ExecutionScope` placement around the two `lua_resume` sites.** Scoped
  tightly around the resume, so the result conversion below runs at the depth it
  would otherwise have — and the conversion is itself `ToLuaValueProtected`,
  which opens its own. A host callback reached during the resume sees depth ≥ 1
  and `reset()` is rejected. Correct.
- **The `ExecutionScope` in `CaptureError`.** Opened immediately before the
  `ProtectedToString` pcall and after the raw `message` probe, which is the
  tightest correct placement: the raw probe cannot fire a metamethod, the
  `__tostring` can.
- **Property handlers at teardown.** The obvious sibling of F2 — a `__gc`
  finalizer that reads a proxy-userdata property during `lua_close` — is
  **clean**. `~LuaContext`'s `DetachRuntimeHandlers()` nulls
  `property_getter_`/`property_setter_` before the members die. `host_functions_`
  really is the only uncovered bridge, which is why F2 is one finding rather
  than a class of four.
- **`reset()` re-entered from a `__gc` finalizer of the retiring state.** The
  `in_reset_` flag added by CR-9 F1 rejects it, and the retiring state's
  finalizers still reach a live context and run normally. Verified.
- **CR-9 F2 did not become a sandbox escape.** An infinite-looping `__index`
  reached through a table handle is still aborted with `instruction limit
  exceeded`; a 30-call sequence each well inside the budget now completes. The
  fix is a correction, not a relaxation.
- **The CR-8 F5 accumulation at the sites CR-9 swept.** Twenty failing calls
  through `get_global_ref` leave 0 JS Errors pinned and through `handle.get`
  leave 1, matching the post-fix expectation. The class is healthy everywhere
  except the three F1 sites.
- **`TableHandlePairs` has no `CallScope` while its five siblings do.**
  Deliberate and correct: `TablePairs` traverses with `lua_next` (raw, no
  metamethod) and converts each value through `ToLuaValueProtected`, which
  opens its own scope; the whole vector is built before any `CoreToNapi` runs,
  so no Lua is live when user JS is re-entered.
- **`DispatchOutput`'s ordering.** Copies the owner, then checks the handler,
  then `async_mode_`, then contains everything the handler throws — the
  discipline `DispatchDebugHook` documents, now genuinely symmetric.
- **`Reset()`'s replay running user JS.** `RegisterCallbacks`, the searcher
  replay, the print-handler install and the shared-table re-publish can all
  re-enter JS on the fresh runtime; a `reset()` from any of them is rejected by
  `in_reset_`. Verified.
- **`reset()` and `package.path` duplication.** Replaying `search_paths_` onto a
  fresh state appends to the default path exactly once per recorded entry; no
  accumulation across repeated resets.

---

## Suggested priority order

1. **F2** — give the host-function wrappers the liveness check every other
   cross-boundary holder already carries, and clear `host_functions_` from
   `~LuaContext` before its members die. High, and ranked first because it needs
   no adversary and no unusual API: a JS callback plus a Lua `__gc` finalizer is
   enough, it fires mid-program as well as at exit, and it has been reachable
   for the whole life of the project.
2. **F1** — bracket the chunk load in all seven core methods and give
   `compile` / `compile_file` / `execute_async` a `CallScope`. High: an
   ASan-confirmed use-after-free at three entry points from ordinary API usage.
   Then restate the core invariant as "can allocate from Lua."
3. **F3** — the nits: narrow `GarbageCollect`'s scope to the collecting
   commands, give `GarbageCollectParam` the matching treatment or a note,
   document `PushLuaValueProtected`'s depth precondition, and explain
   `add_searcher`'s two references.

(The CR-3 M5 deployment target, the CR-5 F3/F8 release-time items, and the two
narrowed CR-8 F6 residuals remain deferred by decision; intentionally absent
from this list.)

---

## Note on the trajectory

CR-9's addendum to `CODE-REVIEW-THOUGHTS.md` drew the right lesson and the
remediation acted on it properly: the fix relocated an invariant into the core
rather than adding guards at the sites a review happened to name. That is the
first structural fix in this series, and it works — F1 does not report a single
binding method that forgot a `CallScope`, because the core no longer lets them.

What CR-10 adds is the next turn of the same screw. **Relocating an invariant
does not make it complete; it makes its statement load-bearing.** Once the core
owns "Lua is executing," everything downstream depends on the core's definition
of that phrase, and the definition chosen — *runs Lua* — is one word away from
the hazard, which is *allocates from Lua*. Every metamethod path was found and
bracketed. Every `lua_resume` was found. `lua_gc` was found, including the
`__gc`-finalizer reasoning, written out in the comment. The chunk loader — the
single heaviest allocator in the library, called by seven core methods — was
not, because it does not *look* like it runs Lua. It only allocates, and
allocation is how the collector gets its turn.

So the clause to add is about scope statements rather than about sweeping:

> **When a fix moves an invariant into one place, the invariant's *wording*
> becomes the new single point of failure. Audit the wording against the
> mechanism, not against the sites the last review listed.**

F2 makes the complementary point, and it is the more humbling of the two. It is
not subtle, not adversarial, and not new: `host_functions_` sits three lines
below `userdata_gc_callback_` and `output_handler_` in a teardown block whose
comment states the exact hazard it fails to cover, and CR-9 *edited that very
block* (changing `output_handler_ = nullptr` to `output_handler_.reset()`)
without noticing the fourth bridge. Nine passes missed it for one reason: the
suite's eleven `__gc` tests all drain their finalizers with an explicit
`gc('collect')` while the context is alive, and none leaves one pending at
destruction. The bug lives exactly one step past where every test stops.

That is the sharper form of the harness lesson CR-6 and CR-9 both recorded. The
sanitizers found both of these findings instantly — but only once a
reproduction drove the path, and neither path had ever been driven. **A
teardown-ordering bug is invisible to a suite that always tears down cleanly.**
Worth adding as a standing category: for each piece of state that bridges the
two layers, one test that leaves it *in use* at destruction time, rather than
draining it first.
