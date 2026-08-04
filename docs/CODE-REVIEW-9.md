# CODE-REVIEW-9

**Date:** July 27, 2026
**Scope:** Ninth pass, against commit `6839145`. This is the first pass since
CODE-REVIEW-8 that reviews a substantially *larger* tree: fourteen feature
commits landed between `330cc30` (the CR-8 baseline) and HEAD, adding
`release()`, `reset()`, `gc()`, dotted-path globals, environment tables
(`create_environment` / `execute_script_in`), `createSharedTable`, `info()`,
debug hooks (`set_hook` / `remove_hook`), the wall-clock `timeout` option,
Lua→JS type converters, coroutine iteration (`Symbol.iterator`), `call()`, and
`get_ref()` — roughly +3,000 lines across the two C++ layers. Primary targets:
(1) re-verification of the CR-8 resolutions (F1–F7) in the tree; (2) a full read
of both layers organized around the project's two standing questions — *which
guard/discipline was applied at some sites but not its siblings*, and *which
JS-influenced value is read without a guard on a path that cannot tolerate a
throw*; (3) the new features as fresh surface, with particular attention to
every new way JS can be re-entered from inside Lua. Line numbers refer to
`6839145`.

**Method:** Complete read of `lua-native.cpp`/`.h`, `lua-async-worker.h`,
`lua-runtime.cpp`/`.h`, then targeted adversarial verification: every suspect
below was **exercised** against the freshly built debug binary
(`build/Debug/lua-native.node` at `6839145`). The memory-safety claim (F1) was
additionally re-run against the ASan+UBSan-instrumented addon
(`npm run build-asan-addon` plus the `run-sanitized-ts.js` preload mechanics)
and is reported here with its sanitizer verdict. `WeakRef` + `--expose-gc` was
used for the pinning claims. One nit (F4's output-handler item) is
code-reading-only and marked as such.

**Baseline:** 737 TypeScript and 250 C++ tests pass at `6839145` (up from
467/178 at the CR-8 remediation — the feature work brought its own coverage).
The harness itself is healthy this time: the CR-8 F2 plumbing
(`vitest.config.ts`'s top-level `execArgv`, plus the test that *asserts*
`global.gc` is present) is in place and the GC-lifetime pins really run.

---

## Resolution status (July 27, 2026)

All findings resolved. After the fixes: **767 TypeScript tests** (up from 737 —
thirty new CR-9 regression tests) and **262 C++ tests** (up from 250 — twelve
new) pass against a freshly built debug binary. The full suite also passes under
the ASan+UBSan-instrumented addon (`npm run test-ts-asan`, 767/767, no
sanitizer report) and the C++ core under `test-cpp-asan` (262/262, clean). Every
reproduction in this review was re-run against the fixed build: all twelve F1
crash vectors now report the guard's error and the process survives, and the F2
reproductions return their expected values instead of aborting.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | The invariant moved into the core, per the recommendation's first option. `LuaRuntime::ExecutionScope` is a non-throwing RAII bracket opened by **every** path that can run Lua — `ProtectedCall`, `ProtectedTableCall`, `RunProtected`, `PushProtectedGlobal`, `ToLuaValueProtected`, `CaptureError`'s `__tostring` trampoline, both `lua_resume` sites, and `GarbageCollect` — and `LuaRuntime::IsExecuting()` reports it. `reset()` now consults that instead of `call_depth_`, so a binding method cannot disarm the guard by omission; `call_depth_` is kept as a cheap second opinion. A new `in_reset_` flag closes the one window the core's depth cannot see: `lua_close` fires the outgoing state's `__gc` finalizers *after* `runtime` already points at the replacement, so a finalizer calling `reset()` would find a fresh runtime reporting depth 0. Separately, the twelve unguarded methods (plus `call()`'s lookup, whose scope moved above it) received a `CallScope`, closing the accumulation half. Eleven regression tests for the guard and four for the accumulation. **Verified to fail without the fix:** the guard tests crash the vitest worker outright ("Worker exited unexpectedly"); the accumulation tests fail 4/4. |
| F2 | ✅ Done | `BeginExecutionBudget` is now called only by `ExecutionScope`, at the outermost entry — so the budget starts wherever Lua starts running (the same set of paths F1 brackets), and a nested re-entry deliberately *shares* the enclosing budget instead of refreshing it. That second half also closes a latent evasion: a Lua loop calling a JS callback that re-entered `execute_script` previously reset the tally on every iteration and could run forever under a finite `maxInstructions`. Seven TS and four C++ regression tests, including two that pin the limits still binding on the affected paths (the defect was mistimed enforcement, never an escape, and the fix must not turn it into one). `SetTimeout` / `SetMaxInstructions`, `types.d.ts` and the README were corrected to describe the real contract. **Verified to fail without the fix:** four of the seven fail; the nested-budget test hangs forever (the evasion). |
| F3 | ✅ Done | `add_searcher` records its function in a new `searchers_` vector — after the core call succeeds, mirroring `add_search_path` — and `Reset()` replays them onto the fresh state, minting new `__searcher_N` names from the still-monotonic `next_searcher_id_` so a pre-reset name can never collide with a post-reset one. Three regression tests, including a negative one pinning that a *failed* registration is not resurrected. **Verified to fail without the fix** (2 of 3; the negative test correctly passes both ways). |
| F4 | ✅ Done | All four nits. `InstallDebugHook` is wrapped at both call sites (`set_hook`, `reset`). The output handler moved behind a `shared_ptr` and is dispatched through a new `LuaRuntime::DispatchOutput`, which copies the owner before calling and contains everything the handler throws — the discipline `DispatchDebugHook` documents for itself, finally swept back to its older sibling. The registry-ref leak is closed by holding the freshly-minted data in a `unique_ptr` until the External's finalizer takes ownership, in `CreateTableHandle`, `CreateCoroutineObject` (whose signature now takes a `unique_ptr`) and the coroutine iterator's state. Four TS and three C++ tests. These are **guard tests, not regression pins**: as the finding recorded, the output-handler hazard does not reproduce (the capture list fits libc++'s small-buffer optimization), and all four pass pre-fix. |

The original findings follow unchanged for reference.

---

## Verification of the CODE-REVIEW-8 remediation

| CR-8 # | Verdict |
|--------|---------|
| F1 | ✅ Correct. The whole `is_error` extraction in `OnAwaitSettled` runs in one try/catch (`lua-native.cpp:2736-2751`) and falls back to `"(rejection value could not be converted)"`. Re-exercised all three triggers — `Promise.reject(Symbol(...))`, `Promise.reject(Object.create(null))`, and a rejection object with a throwing `message` getter: each surfaces as an ordinary rejection with `is_busy()` false and the context still usable. |
| F2 | ✅ Correct, and still armed. `vitest.config.ts` uses the top-level `test.execArgv`, conditionally skipped under `LUA_NATIVE_SANITIZED`; the CR-7 F1 guard now throws instead of warning, and `tests/ts/lua-native.spec.ts:6180` asserts `typeof global.gc === 'function'`. |
| F3 | ✅ Correct at all three sites. `set_metatable` (`:1629`, `:1667`), `register_module` (`:1724`, `:1758`), and `register_class` (`:1512`, `:1557`) all collect function entries into a `deferred_fns` list and register the `js_callbacks_`/`host_functions_` pairs only after the core call succeeds. Re-reproduced with `WeakRef` + a control closure at all three, plus `add_searcher`: after a failing call, nothing is pinned. |
| F4 | ✅ Correct. Both workers' `OnOK` wrap `ResultsToJs` in try/catch (`:3277-3282`, `:3300-3305`). The oversized-string reproduction comes back as `failed to convert async result: …` with the context usable. |
| F5 | ✅ Correct, **within the surface it named.** All six metamethod-capable table-handle methods carry a `CallScope` (`:357`, `:393`, `:429`, `:460`, `:481`, `:529`); fifteen failing `handle.get` calls leave exactly one pinned JS Error, versus twenty for the unswept siblings — see F1 below, which is where this class went next. |
| F6 | ✅ Correct. Every bridge value push routes through `PushLuaValueProtected` (`lua-runtime.cpp:641`, `:901`, `:933`, `:1179`, `:1750`, `:1784`); the two documented residuals are unchanged. |
| F7 | ✅ Correct. `SetOutputHandler` installs the redirection before committing the handler (`lua-runtime.cpp:1428-1439`) and `InstallPrintHandler` commits `print_handler_` after the runtime install (`lua-native.cpp:3088-3101`); `set_userdata` records each method name in `registered_method_fns` before registering the pair (`:1364-1366`). |

---

## Overall assessment

The CR-8 fixes are present and correct at every site they name, and the
feature work is, in isolation, careful: the new code is visibly written by
someone who had read the prior reviews. `create_environment` opens a
`CallScope` because "reading a whitelisted name can fire an `__index` on `_G`
that re-enters JS." `SetTableRefMetatable` protects its whole build for the
same reasons as `SetGlobalMetatable`. The debug hook holds its callback behind
a `shared_ptr` copy so a hook that removes itself mid-dispatch cannot destroy
the running `std::function`. `add_search_path` records the path only after the
core call succeeds. Each of those is the right instinct applied to new code.

But the review's standing thesis has recurred in its sharpest form yet, and
this time it runs in the *opposite* direction from the previous passes. The
danger is no longer only "a fix named a class and swept one site." It is that
**a new feature can turn a previously-cosmetic gap into a memory-safety bug.**

`reset()` (added since CR-8) is the first API that can free the `lua_State`
while the context stays alive, and it correctly refuses to run when
`call_depth_ > 0` — "Retiring the state under it would free the lua_State the
frames below are still executing on." `call_depth_` is raised by `CallScope`.
Before `reset()` existed, a missing `CallScope` cost one leaked
`js_error_registry_` entry (the CR-8 F5 class, low severity). After `reset()`
exists, a missing `CallScope` means **the reentrancy guard is simply not
armed** on that path — and of the thirty-six binding methods, only eight open a
`CallScope`. Nine separate entry points were reproduced crashing the process
with a use-after-free, ASan-confirmed (F1). One of them, `gc('collect')`,
requires no hostile `_G` metatable at all: an ordinary Lua `__gc` finalizer
that calls a JS callback that calls `reset()` is enough.

That is the same missing `CallScope` CR-8 F5 identified, at the sites CR-8 did
not sweep — promoted from low to high by a feature that landed afterwards. The
durable lesson is in the trajectory note below.

The second finding is a genuinely new class, and belongs to the new `timeout`
feature: the per-execution budget is started only by the three "real" entry
points, so every metamethod-driven path (table handles, Proxy traps, `_G`
metatable reads and writes, environments) runs Lua against **whatever deadline
and instruction tally the last execution left behind** (F2). It fails closed —
"execution timeout" on a metamethod that ran for microseconds, "instruction
limit exceeded" on the fifth of thirty identical calls none of which
approaches the limit — so it is a correctness and usability defect, not a
sandbox escape.

Severity distribution: one high (F1), one medium (F2), one low (F3), plus nits
(F4).

---

## Findings

### F1. `reset()`'s reentrancy guard is disarmed on every entry point that lacks a `CallScope` — use-after-free → process crash (high)

`LuaContext::Reset` refuses to retire the Lua state while Lua is executing:

```cpp
// lua-native.cpp:2970
if (call_depth_ > 0) {
  Napi::Error::New(env, "reset() cannot be called while Lua is executing (from "
    "inside a host callback or metamethod)").ThrowAsJavaScriptException();
  return env.Undefined();
}
```

The reasoning is exactly right, and the comment states it: "Retiring the state
under it would free the `lua_State` the frames below are still executing on."
But `call_depth_` is incremented **only** by `LuaContext::CallScope`
(`lua-native.h:260-266`), and a sweep of the `Init` table against the method
bodies shows only eight of the thirty-six binding methods open one:

| Opens a `CallScope` | Runs Lua, opens **no** `CallScope` |
|---|---|
| `execute_script`, `execute_file`, `execute_script_in`, `load_bytecode`, `create_coroutine`, `resume`, `create_environment`, `call` *(after its lookup)* | `get_global`, `set_global`, `get_global_ref`, `set_userdata`, `set_metatable`, `register_module`, `register_class`, `add_search_path`, `add_searcher`, `set_print_handler`, `create_table`, `gc` |

Every method in the right-hand column can run user Lua — a `__index` /
`__newindex` on a metatabled `_G` or `package`, or (for `gc('collect')`) a Lua
`__gc` finalizer — and that Lua can call a registered JS host function, which
can call `reset()`. `call()` is in both columns: its global lookup
(`:1246-1248`) runs before the `CallScope` at `:1278`, so the lookup's
`__index` is unguarded.

`reset()` then proceeds to `runtime = std::move(fresh)` (`:3011`), which drops
the context's share of the outgoing runtime. With no outstanding handles that
is the last share: `~LuaRuntime` runs `lua_close` on the very state whose
`lua_pcall` frames are live on the C stack below.

**Reproduced at nine entry points** against the `6839145` debug build. The
shape is always the same:

```js
const lua = new lua_native.init(
  { doreset: () => { try { lua.reset(); } catch { } return 1; } },
  { libraries: 'all' });
lua.execute_script(`setmetatable(_G, { __index = function(t, k) return doreset() end })`);
lua.get_global('missing');     // <- never returns
```

| Entry point | Trigger | Result |
|---|---|---|
| `get_global` (plain and dotted) | `_G.__index` | SIGSEGV (139) |
| `set_global` (plain and dotted) | `_G.__newindex` | SIGBUS (138) |
| `get_global_ref` | `_G.__index` | SIGSEGV |
| `call` | `_G.__index` during the lookup | SIGBUS |
| `set_userdata` | `_G.__newindex` | SIGSEGV |
| `set_metatable` | `_G.__index` | SIGSEGV |
| `register_class` | `_G.__newindex` | SIGSEGV |
| `add_search_path` | `package.__index` | SIGSEGV |
| `add_searcher` | `package.searchers.__newindex` | ASan `heap-use-after-free` |
| `gc('collect')` | a Lua `__gc` finalizer | ASan `heap-use-after-free` |

Under the ASan-instrumented addon the verdict is unambiguous:

```
==9405==ERROR: AddressSanitizer: heap-use-after-free ... READ of size 1
  #0  lua_core::LuaRuntime::LuaCallHostFunction(lua_State*)   lua-runtime.cpp:1765
  #6  lua_gettable
  #7  lua_core::LuaRuntime::ProtectedGlobalGetRunner(lua_State*)  lua-runtime.cpp:2305
  #13 lua_core::LuaRuntime::PushProtectedGlobal(...)          lua-runtime.cpp:2318
  #14 lua_core::LuaRuntime::GetGlobal(...)                    lua-runtime.cpp:2332
  #15 LuaContext::GetGlobal(Napi::CallbackInfo const&)        lua-native.cpp:1211
```

The freed byte being read at frame #0 is `runtime->await_pending_` — the host
bridge consulting the `LuaRuntime` that `reset()` destroyed two frames of Lua
ago, while still executing on that runtime's `lua_State`.

The control confirms the guard works where it is armed: the same callback
reached through `execute_script` (which does open a `CallScope`) is rejected
with `"reset() cannot be called while Lua is executing"` and the process
survives.

**Calibration.** The `gc('collect')` vector is what makes this high rather
than medium. It needs no hostile metatable and no adversary — a `__gc`
finalizer that notifies JS is an ordinary pattern, `gc('collect')` is an
ordinary call, and `reset()` from a callback ("the state is dirty, start
over") is the feature working as advertised. The rest require a metatable on
`_G` or `package`, which is still ordinary Lua that this library explicitly
supports (the M4 work exists precisely because users do it).

**Second consequence of the same gap — the unswept half of CR-8 F5.** A
`CallScope` also clears `js_error_registry_` at the outermost call. On the
paths above, a JS host callback that throws inside a metamethod stages an
entry that nothing consumes (the failure surfaces as a plain string) and
nothing clears. **Reproduced** with `WeakRef` + `--expose-gc`, twenty failing
calls each:

```
get_global       20 failing calls -> 20 JS Errors still pinned
set_global       20 failing calls -> 20 JS Errors still pinned
get_global_ref   20 failing calls -> 20 JS Errors still pinned
call             20 failing calls -> 20 JS Errors still pinned
--- controls (already carry a CallScope) ---
handle.get       20 failing calls ->  1 JS Error  still pinned
execute_script   20 failing calls ->  0 JS Errors still pinned
```

This is exactly the accumulation CR-8 F5 fixed for the table handles, at the
global-access surface it did not sweep. One fix closes both consequences.

**Recommendation.** Give every binding method that can run Lua an outermost
`CallScope` — the whole right-hand column above, and in `call()` move the
existing scope *above* the global lookup. That both arms `reset()`'s guard and
closes the accumulation. Then make the invariant mechanical rather than
remembered: the reentrancy guard should not depend on a bookkeeping counter
that exists for an unrelated purpose. Two options, in order of preference:

1. Have `reset()` (and any future state-retiring API) consult a dedicated
   "Lua is on the C stack" depth that is incremented by the core — e.g. in
   `RunProtected` / `ProtectedTableCall` / `ProtectedCall` / `PushProtectedGlobal`,
   which is where Lua actually starts running. Then a new binding method
   cannot forget to arm it, because it never had to know about it.
2. Failing that, add a debug-build assertion that no `RunProtected` frame is
   entered at `call_depth_ == 0` from a binding entry point, so the next
   method that omits the scope fails the suite instead of the user's process.

**Test.** The `gc('collect')` reproduction (no hostile metatable) and the
`get_global` reproduction, both asserting the call throws the guard's error and
the process survives; plus the twenty-call `WeakRef` accumulation pin on
`get_global` / `set_global` / `get_global_ref` / `call`, mirroring the CR-8 F5
test. Both belong in the suite `test-ts-asan` runs — the harness reported this
on the first instrumented run once a repro drove the path.

### F2. The per-execution budget is never started on metamethod-driven paths — `timeout` and `maxInstructions` fire against a stale deadline and a stale tally (medium)

`BeginExecutionBudget` (`lua-runtime.cpp:351-357`) clears
`instruction_count_` and, when a timeout is configured, sets `deadline_ =
now() + timeout_ms_`. It is called from exactly three places
(`lua-runtime.cpp:1909`, `:3161`, `:3314`): `ProtectedCall`,
`ResumeCoroutine`, and `ResumeAsyncStep`.

The count-hook that enforces both limits (`ExecutionHook`, `:210-246`) is
installed on the main state and inherited by every coroutine thread, so it
fires during *any* Lua execution — including the many that do not go through
those three entry points. Every `RunProtected` / `ProtectedTableCall`-based
path runs a metamethod without ever starting a budget:

- the table-handle methods (`get`/`get_ref`/`set`/`has`/`length`/`ipairs`) and
  all five Proxy traps, via `GetTableField*` / `GetTableLength` / `TableIPairs`;
- `GetGlobal` / `SetGlobal` / `GetGlobalPath` / `SetGlobalPath` /
  `GetGlobalRef` when `_G` carries a metatable;
- `CreateEnvironment`'s whitelist reads;
- `SetGlobalMetatable` / `RegisterModuleTable` / `AddSearchPath` /
  `AddJsSearcher`, all of which read through a metatabled `_G` or `package`.

Those executions are judged against whatever `deadline_` and
`instruction_count_` the *last* real execution left. Two failure modes, both
**reproduced**:

**Stale deadline — a spurious abort.** With `timeout: 200`, arm a table whose
`__index` runs a short loop, idle 400 ms (past the deadline the arming
`execute_script` set), then read one field:

```
handle.get THREW: execution timeout
```

The metamethod ran for microseconds. The same context aborts every such call
until some `ProtectedCall`-based entry point happens to run and reset the
clock.

**Stale tally — accumulation across calls.** With `maxInstructions: 200000`
and an `__index` costing roughly 20,000 VM instructions, thirty identical
`handle.get` calls should each be well inside the budget. They are not:

```
handle.get  #5 THREW: instruction limit exceeded     (table handle)
proxy read  #5 THREW: instruction limit exceeded     (Proxy trap)
get_global  #5 THREW: instruction limit exceeded     (_G metatable)
```

The tally accumulates across every unbudgeted call and never resets until a
real entry point runs — after which a plain `execute_script` works fine,
confirming the reset is the missing piece and not the limit itself.

**Calibration.** This is fail-*closed*: because `deadline_` is always at most
`now + timeout_ms_` as of the last reset, an unbudgeted path can only get
*less* time than configured, never more, and the instruction tally only
over-counts. Verified: an infinite-looping `__index` reached through
`handle.get` is still aborted. So the limits are not evadable — the defect is
that documented, correctly-configured limits fire on work that is nowhere near
them, which for a sandboxing feature is a serious usability and correctness
problem but not a security one. Hence medium.

Note also that the header's own contract is narrower than reality:
`SetTimeout` (`lua-runtime.h:588-600`) enumerates the reset points as
"execute_script/file, load_bytecode, a Lua-function call, each coroutine
resume" — the metamethod-driven paths are not in that list, and the
consequence of their absence is not stated.

**Recommendation.** Start a budget wherever Lua starts running, not only at
the three entry points that happen to be named. The natural home is
`RunProtected` / `ProtectedTableCall` / `PushProtectedGlobal` — the same three
places option 1 of F1's recommendation points at, which is not a coincidence:
both findings are "the binding layer knows it is about to run Lua; the core
does not get told." A nested-budget rule has to be chosen deliberately (an
inner metamethod call should probably *not* reset an enclosing execution's
budget — a depth counter that only starts a budget at depth 0 gives the
intuitive semantics). Whatever is chosen, update the `SetTimeout` /
`SetMaxInstructions` documentation so the code and the contract agree.

**Test.** The two reproductions above: (a) `timeout` + idle-past-deadline +
one cheap metamethod read must succeed; (b) N identical metamethod-driven
reads under `maxInstructions` must all succeed when each is individually well
inside the limit. Add the same for the Proxy-trap and `_G`-metatable surfaces.

### F3. `reset()` replays `add_search_path` but silently drops `add_searcher` (low)

`Reset()` replays the context-level configuration it recorded: the bytecode
guard, the search paths (`lua-native.cpp:3029`), the callbacks, the print
handler, the debug hook, and the shared-table globals. `add_searcher` records
nothing — `AddSearcher` (`:3239-3262`) mints a `__searcher_N` name, calls
`AddJsSearcher`, and stores the pair, but keeps no list for replay — so a JS
searcher registered before a reset is gone afterwards, with no error.
**Reproduced:**

```
before reset: require("jsmod").v = 99
after reset:  require("jsmod") FAILED -> module 'jsmod' not found
after reset:  package.path still carries the replayed search path = true
```

The inconsistency is the finding: the two halves of the same feature
(`docs/REQUIRE.md`'s static and dynamic module resolution) behave differently
across a reset, and the surviving half makes the missing half look like a bug
rather than a documented limit. `reset()`'s own comment says what it does not
replay is "bound to Lua-side objects that die with the old state" — a JS
searcher function is not; it is exactly as replayable as a search path.

**Recommendation.** Record the searcher functions the way `search_paths_`
records paths and replay them in `Reset()` (registering after the core call
succeeds, per the N5 ordering already used at `:3253-3260`). If replay is
deliberately not wanted, say so in `reset()`'s documentation next to the
modules/userdata/classes list, so the code and the docs agree.

### F4. Nits

- **`InstallDebugHook` is unguarded at both call sites** (`lua-native.cpp:3201`
  in `set_hook`, `:3057` in `reset`). It calls `LuaRuntime::SetDebugHook`,
  whose `std::make_shared<DebugHookCallback>` can throw `std::bad_alloc`; that
  would unwind past the N-API boundary and terminate the process — the H1
  class. Every neighbouring install (`InstallPrintHandler`, `SetAllowBytecode`,
  `AddSearchPath`) is wrapped; this one is the exception. Ultra-narrow (a
  small control-block allocation), listed for symmetry.
- **The debug hook's self-modification discipline was not swept back to the
  output handler** *(code reading only — probed, does not reproduce)*.
  `DispatchDebugHook` deliberately copies its callback owner before invoking it
  (`lua-runtime.cpp:255`) because "a hook that calls `set_hook` or
  `remove_hook` from inside itself … would otherwise destroy the
  `std::function` mid-call." `LuaPrint` / `LuaIoWrite` invoke
  `runtime->output_handler_` in place (`:1491`, `:1532`) with no such copy, and
  a print handler that calls `set_print_handler(null)` from inside itself does
  exactly that — assigns `output_handler_ = nullptr` while its `operator()` is
  on the stack. Probed four ways (self-clear and self-replace, via both `print`
  and `io.write`): all survive, because the capture list is a single pointer
  and so lives in libc++'s `std::function` small-buffer rather than on the
  heap. That is an implementation detail of the standard library, not a
  guarantee. The same one-line `shared_ptr` copy (or simply moving the handler
  into a local before invoking it) makes it true by construction.
- **The core's containment is likewise asymmetric.** `DispatchDebugHook` wraps
  the host call in `try { … } catch (...) {}` "the way the output handler
  does" — but the output handler is *not* wrapped on the core side; only the
  binding lambda's inner `catch (const Napi::Error&)` exists, and the
  `Napi::HandleScope` construction that precedes it sits outside that try and
  can itself throw `Napi::Error`. The comment describes a discipline the older
  site never had.
- **A registry slot leaks if handle construction fails after the core call.**
  `TableHandleGetRef` (`:404`), `GetGlobalRef` (`:1957`), `CreateTableMethod`
  (`:1929`) and `CreateEnvironment` (`:2035`) mint a registry ref in the core
  and then call `CreateTableHandle`, whose N-API allocations can throw. The
  ref is then owned by nobody. OOM-window only; listed for completeness.

---

## Verified and rejected (adversarial suspicions that held up)

- **`reset()` re-entered from a `__gc` finalizer of the outgoing state.**
  `runtime = std::move(fresh)` destroys the old runtime inside the assignment,
  so `lua_close`'s finalizers run with `runtime` already pointing at the
  replacement. Exercised three ways — a finalizer that calls a host callback,
  one that calls `execute_script` (running on the *new* state), and one that
  calls `reset()` again (a fully nested reset). All three complete and leave
  the context usable. The nested case wastes one runtime and replays the
  configuration twice, but is consistent. (A callback in that window that
  returns a *function* registers the reclaimable entry on the new runtime while
  the closure materializes on the old one, so the closure would fail with
  "host function not found" — contrived enough to note rather than file.)
- **`SharedTable` lifetime.** Subscribers are held weakly and pruned on the
  next propagation; `Propagate` snapshots the live targets before running any
  user JS, so a push that constructs another subscribing context cannot mutate
  the vector under iteration. The strong `shared_tables_` → SharedTable and
  weak SharedTable → context pairing forms no cycle.
- **`SharedTable` failure reporting.** A push into a context that is busy with
  an async operation is collected and reported *after* every other context has
  been updated, exactly as the class documents. Verified: `set()` threw
  `"shared table update failed for 1 of 2 contexts …"` and the healthy context
  still received the update.
- **`RejectIfBusy` coverage.** Swept all thirty-six methods in the `Init` table
  against their bodies: every one that touches the Lua state checks it
  (`cancel` and `is_busy` deliberately do not). `SharedTable::set`/`sync` reach
  Lua only through each subscriber's own `set_global`, so they inherit the
  guard. The H9c main-thread gate holds.
- **New lifetime-bearing crossings carry the liveness flag.** `LuaContextBinding`
  (the coroutine `[Symbol.iterator]` factory) and `LuaCoroIterState` (the
  per-loop cursor) both hold `contextAlive` and check it before touching
  `context`, matching the H3/H5 convention — the CR-7 F1 checklist applied to
  new code. `LuaThreadData` and `LuaUserdataData` hold no context pointer at
  all and rely on the `runtime.get() == runtime.get()` identity check instead,
  which `ResumeCoroutineObject` and `Release` both perform.
- **The `AwaitCookie` liveness guard (CR-7 F1)** is intact: the cookie still
  carries `alive_` (`:2658`) and both static callbacks check it before
  dereferencing `ctx` (`:2810`, `:2821`).
- **Debug-hook self-modification.** A hook that calls `remove_hook()` or
  `set_hook()` from inside itself is safe — the `shared_ptr` copy at
  `lua-runtime.cpp:255` does what its comment claims. Lua's own
  `allowhook` flag prevents the hook from re-entering itself, so a hook that
  re-enters `execute_script` does not recurse.
- **Hook sharing between `maxInstructions`, `timeout` and the debug hook.**
  `InstallExecutionHook` ORs the masks and takes the *finer* count interval,
  and each consumer tallies up to its own granularity — so installing or
  removing a debug hook can neither disable nor coarsen the instruction limit.
  Correct in every combination read.
- **`get_ref` and nested handle lifetime.** A handle obtained via
  `parent.get_ref('inner')` owns its own registry slot and keeps working after
  `parent.release()`. Verified.
- **The stale budget is not a sandbox escape.** An infinite-looping `__index`
  reached through `handle.get` is still aborted (F2 is fail-closed).
- **`ExecuteScriptInEnvironment` stack discipline.** The `lua_setupvalue`
  failure branch pops both slots itself (`lua_setupvalue` pops nothing on an
  out-of-range index); `stackBefore` is captured before the load, so the result
  count is right on every path.
- **`SplitGlobalPath` edge cases.** Leading, trailing, and doubled dots are all
  rejected with a clear error rather than silently producing an empty segment.
- **`GetGlobalPath` optional-chaining semantics.** A nil intermediate
  short-circuits to nil before the next `lua_gettable` can raise on it; a
  non-nil non-indexable intermediate raises inside the protected frame and is
  reported, matching what the equivalent Lua expression does.
- **Type-converter reentrancy, both directions.** Both loops index the vector
  and pull the two handles out before calling `match`, so a converter that
  registers another converter cannot invalidate a held reference. The Lua→JS
  loop additionally uses the converter's return value verbatim, avoiding the
  self-matching infinite loop.
- **Worker-thread reads of the budget state.** `ExecutionHook` reads
  `max_instructions_` / `timeout_ms_` / `deadline_` / `debug_hook_` from the
  worker thread, but every main-thread mutator (`set_hook`, `remove_hook`,
  `reset`) is behind `RejectIfBusy`, and `timeout` / `maxInstructions` have no
  post-construction setter exposed. No race found.
- **`js_userdata_` iterator stability across re-entrant JS.** The property
  getter and setter both finish with their map iterator before any user JS can
  run (C++17 sequences the postfix-expression before the arguments), so a
  getter that re-enters and inserts into `js_userdata_` cannot rehash under a
  live iterator.

---

## Suggested priority order

1. **F1** — arm the reentrancy guard on every path that runs Lua: `CallScope`
   on the twelve unguarded methods (and above `call()`'s lookup), then move the
   invariant into the core so it cannot be forgotten again. High: an
   ASan-confirmed use-after-free reachable from ordinary API usage, at nine
   entry points. The same fix closes the CR-8 F5 accumulation at its unswept
   sites.
2. **F2** — start the per-execution budget wherever Lua starts running, decide
   the nested-budget rule explicitly, and correct the `SetTimeout` /
   `SetMaxInstructions` contract text. Medium: documented, correctly-configured
   limits fire on work nowhere near them.
3. **F3** — replay `add_searcher` in `reset()` alongside `add_search_path`, or
   document the asymmetry.
4. **F4** — the nits: guard `InstallDebugHook`; give the output handler the
   `shared_ptr` copy and the core-side `catch (...)` the debug hook already
   has; note the handle-construction ref leak.

(The CR-3 M5 deployment target, the CR-5 F3/F8 release-time items, and the two
narrowed CR-8 F6 residuals remain deferred by decision; intentionally absent
from this list.)

---

## Note on the trajectory

Every previous pass told a version of the same story: a fix named a class,
swept one site, and donated the next site to the next review. CR-9 tells the
inverse, and it is the more uncomfortable version.

Nothing regressed. Every CR-8 fix is intact, and the new feature code is
demonstrably written with the prior reviews in hand — `create_environment`
opens a `CallScope` and says why; the debug hook guards its own
self-modification and says why. The high-severity finding here was not
introduced by careless new code. **It was created by careful new code landing
next to an old, unswept gap.** `reset()` did the right thing by consulting
`call_depth_`; it simply inherited a counter that only eight of thirty-six
entry points maintain, because before `reset()` existed nothing depended on
those other twenty-eight maintaining it. A latent, low-severity hole became a
use-after-free without anyone touching the code that contains it.

So the lesson `CODE-REVIEW-HISTORY.md` (Part I) records — *fix classes, not sites* —
needs a second clause: **an unswept gap is not merely a known low-severity
residual; it is a hazard whose severity is set by code that has not been
written yet.** CR-8 F5 was correctly triaged as low *at the time*. The reason
to have swept it anyway was not its severity but the fact that a partially-held
invariant is a trap for the next feature. When a review says "this discipline
is applied at some sites and not others," the cost of leaving it that way is
not the leak it currently causes.

The mechanical follow-through matters more than usual here. Both F1 and F2
have the same root shape: the binding layer knows it is about to run Lua, and
the core — which owns both the reentrancy question and the execution budget —
is not told. Fixing that once, in `RunProtected` and its siblings, closes both
findings and makes the thirty-seventh binding method safe by construction
rather than by review. That is what "enforce the class mechanically" looks like
for this particular hazard, and it is a better use of the effort than adding
twelve `CallScope`s and hoping the next author remembers the thirteenth.

One process note in the harness's favour: the CR-8 F2 plumbing held. The
`global.gc` assertion is present, the pins really ran, and the ASan harness
identified F1 on the first instrumented run once a reproduction drove the
path — again confirming that its value is bounded entirely by the adversarial
coverage of the suite it runs. F1's reproductions belong in that suite.
