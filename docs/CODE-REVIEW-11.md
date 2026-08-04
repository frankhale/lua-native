# CODE-REVIEW-11

**Date:** July 28, 2026
**Scope:** Eleventh pass, against commit `076e9e4` — the CODE-REVIEW-10
remediation, plus a full re-read of both C++ layers. Like CR-10 this is a
*small-diff* window: one commit (`+1,307 / -43`) landed since the CR-10 baseline
`9260396`, and it is entirely remediation — the seven bracketed chunk loaders,
three new `CallScope`s, `context_alive_`, `LuaRuntime::ClearHostFunctions()`,
and the narrowed `GarbageCollect` scope.

Because the remediation itself was small and verifiable in an afternoon, this
pass spent most of its budget on the question CR-10's own closing note raises:
**"audit the wording against the mechanism."** Two lenses were used that no
earlier pass has applied systematically:

1. **Callable-lifetime.** CR-9 F4 established that a callable must not be
   destroyed while it is executing (`output_handler_`, `debug_hook_`). Which
   *other* callables can user code destroy from inside themselves?
2. **Container-stability across user JS.** CR-2 established that a member
   container iterated while user JS runs must be indexed, not iterated by
   reference. Are those loops still indexed?

Both lenses found confirmed heap-use-after-frees, and the second one found
that a previous review's fix had been **silently reverted by a later style
commit** while its explanatory comment stayed in place.

**Method:** Complete read of `lua-native.cpp`/`.h`, `lua-async-worker.h`,
`lua-runtime.cpp`/`.h`, then targeted adversarial verification. Every finding
below was **reproduced** against a freshly built debug binary
(`build/Debug/lua-native.node` at `076e9e4`). F1 and F2 were confirmed as
`heap-use-after-free` under the ASan+UBSan-instrumented addon
(`npm run build-asan-addon` plus the `run-sanitized-ts.js` preload mechanics).
F3 was measured with temporary `IsExecuting()` probes compiled into the C++ test
binary (removed afterwards). F4 was measured with `WeakRef` pins under
`--expose-gc`, against a working control.

**Baseline:** 777 TypeScript and 275 C++ tests pass at `076e9e4`, matching the
CR-10 remediation's own figures. The full TypeScript suite also passes under the
ASan+UBSan-instrumented addon (777/777, no sanitizer report). Nothing regressed —
and that is the point of F1 and F2: **the existing suite is clean on every one of
these paths, because none of them is exercised.**

---

## Resolution status (July 28, 2026)

All findings resolved. After the fixes: **792 TypeScript tests** (up from 777 —
fifteen new CR-11 regression tests) and **283 C++ tests** (up from 275 — eight
new) pass against a freshly built debug binary. The full suite also passes under
the ASan+UBSan-instrumented addon (`npm run test-ts-asan`, 792/792, no sanitizer
report) and the C++ core under `test-cpp-asan` (283/283, clean). Every
reproduction in this review was re-run against the fixed build.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | Both loops restored to the indexed form, each with a `// NOLINTNEXTLINE(modernize-loop-convert)` — the marker is the point of the fix, since prose is what the two style commits walked past. The comments now say *why* indexing protects the cursor and not just the operands, which is the part the previous wording left implicit. Three TS pins, all using **two** converters so the invalidated cursor is actually reached. **Verified to fail without the fix:** the range-for build crashes the vitest worker outright ("Worker exited unexpectedly"), and reports `heap-use-after-free` at `napi-inl.h:3733` under `test-ts-asan`. |
| F2 | ✅ Done | `host_functions_` is now `unordered_map<string, shared_ptr<Function>>`, and all three bridges (`LuaCallHostFunction`, `UserdataMethodCall`, `JsSearcher`) copy the owner out before invoking — the CR-9 F4 mechanism, applied to the population it skipped. `StoreHostFunction` / `RegisterFunction` / `RegisterReclaimableHostFunction` assign a fresh owner rather than into the existing `std::function`, so a replacement never touches a callable in flight; the in-flight call completes against the callable it started with and the replacement takes effect from the next one. The binding half of the same hazard was closed too: both wrappers now materialize `cbIt->second.Value()` before any user JS runs (F5). Four TS and two C++ pins. **Verified to fail without the fix:** `heap-use-after-free` at `lua-native.cpp:2427` (TS) and in the C++ pin's own closure, both under ASan. |
| F3 | ✅ Done | `ExecutionScope` added around the argument staging in `CallFunction`, `ResumeCoroutine` and `ResumeAsyncStep` (scoped to the staging alone, so the `ProtectedCall`/`lua_resume` below still starts the budget), around `HasClass`'s registry read, and restored on `gc('incremental')`/`gc('generational')`. The two pre-scope `lua_checkstack`s in `ToLuaValueProtected` and `PushProtectedGlobal` moved inside their scopes — growing the stack allocates. `GarbageCollectParam`'s comment corrected, and `SetTimeout` now records that a `__gc` finalizer is not interruptible at all (Lua clears `allowhook` around one), which bounds what the budget half of the invariant can ever do on these paths. Five C++ pins plus a read-only-command control; they live in the C++ suite because every binding entry point masks the gap. **Verified to fail without the fix:** 4 of 5 fail (the fifth is the control, which must pass both ways). |
| F4 | ✅ Done | `PushLuaValue`'s reclaim accounting factored into `LuaRuntime::PushHostFunctionClosure`, now the single place any host-function name becomes a Lua closure — so the metatable and module builders pick it up instead of pushing their own bare closure. `set_metatable` and `register_module` reserve their names via a new `ReserveReclaimableHostFunction` *before* the core call, which leaves the CR-8 F3 ordering exactly as it was (nothing enters `host_functions_`/`js_callbacks_` until the call succeeds) while still letting the closure carry a sentinel; the enclosing `JsCallbackCollectorScope` sweeps a reservation whose closure was never built. `set_userdata`'s method callbacks are keyed to their `ref_id` and dropped by the userdata GC callback that already erases the rest of that userdata's JS state. `register_class` deliberately left permanent, with a comment saying why. Six TS pins including the M2 control and a re-assertion of the CR-8 F3 no-stranding behaviour. **Verified to fail without the fix:** 3 of 6 fail. |
| F5 | ✅ Done | All four nits. The three raw `new`s in `CoreToNapiBuiltin` now use the `unique_ptr`-until-the-External-owns-it discipline, released the moment the External exists rather than after `DefineHiddenProp`. `~LuaRuntime` clears `property_getter_`/`property_setter_` alongside the other three bridging handlers, so the destructor's "the core must not depend on it" comment is finally true of all five — pinned by a C++ test that leaves a proxy-reading finalizer pending at `lua_close`. The held `cbIt` iterators are gone (folded into F2). `GarbageCollectParam`'s comment rewritten now that its neighbours are all bracketed. |

One note on the harness, recorded because it is the lesson in miniature: the
first version of F3's C++ probe declared its recorder *after* the `LuaRuntime`,
so `~LuaRuntime`'s teardown finalizers fired into a destroyed `std::vector`.
`test-cpp-asan` caught it as a `stack-use-after-scope` immediately. The test for
a lifetime bug had the lifetime bug.

The original findings follow unchanged for reference.

---

## Verification of the CODE-REVIEW-10 remediation

| CR-10 # | Verdict |
|---------|---------|
| F1 | ✅ Correct at every site it names. All seven chunk loaders open an `ExecutionScope` around the load (`lua-runtime.cpp:1862`, `:1905`, `:2224`, `:2277`, `:2318`, `:3150`, `:3355`), tightly enough that parse time is not folded into the execution budget; `compile`, `compile_file` and `execute_async` received their `CallScope`s (`lua-native.cpp:1819`, `:1849`, `:2629`). The `compile` reproduction now survives (exit 0). The invariant's wording was corrected to "can allocate from Lua" at `IsExecuting()` and `SetTimeout`. **But the sweep implied by that wording stopped at the chunk loaders** — see F3. |
| F2 | ✅ Correct, and both halves hold. The seven-line teardown reproduction exits 0 (and the finalizer degrades to the documented "host function not found" path — `lua says:` is correctly absent); the `--expose-gc` mid-program reproduction exits 0. `context_alive_` is captured by both wrappers and checked before any member access including the `HandleScope`'s `env` (`lua-native.cpp:2399`, `:2449`); `ClearHostFunctions()` is called from `~LuaContext` only (`:2335`), and it clears `reclaimable_host_fns_` too so a teardown sentinel `__gc` finds nothing to decrement. |
| F3 | ⚠️ Three of four nits correct; **the fourth introduced a regression.** `PushLuaValueProtected`'s depth precondition and `add_searcher`'s two Persistents are documented as recommended. But narrowing `GarbageCollect`'s scope from the whole function to the `collect` and `step` blocks (`lua-runtime.cpp:412`, `:436`) also removed it from `incremental`/`generational`, which run pending `__gc` finalizers via `luaC_changemode`. Measured: 374 finalizers ran inside `gc('generational')` with `IsExecuting()` false. See F3. |

---

## Overall assessment

The CR-10 remediation is correct wherever it was aimed, and the CR-10 F2 fix in
particular is the right shape: a liveness flag that holds however the destruction
races, with the explicit unbind as belt-and-braces rather than as the mechanism.

The findings below are not about the remediation being wrong. They are about
**three different fixes from three different reviews each having been applied to
the sites that review happened to name, and the class having been left open.**
That is the thesis `CODE-REVIEW-HISTORY.md` (Part I) opened with, and this pass is the
first to find it in all three of its forms at once:

- **A fix that was applied, then undone.** CR-2 deliberately rewrote two
  converter loops from a range-`for` into an indexed loop, and wrote a comment
  saying why. Commit `545638e` (a `const`/`[[nodiscard]]`/style pass, July 23)
  turned one back into a range-`for`; commit `6839145` ("fix clang-tidy issues",
  July 24) turned the other back. **The comment explaining the indexed form is
  still there, three lines above the code that contradicts it.** Confirmed
  `heap-use-after-free` (F1). CR-8, CR-9 and CR-10 all reviewed trees containing
  this.
- **A fix that named its class and swept two of three members.** CR-9 F4 put
  `output_handler_` and `debug_hook_` behind `shared_ptr` so a handler that
  replaces itself mid-call cannot destroy the running `std::function`. The
  largest population of such callables — `host_functions_`, one per registered JS
  callback — was not swept. `set_global('foo', fn)` from inside `foo` destroys
  the closure it is running in. Confirmed `heap-use-after-free` (F2).
- **A fix whose *statement* was corrected but whose *sweep* was not repeated.**
  CR-10 F1 restated the invariant as "can allocate from Lua" and recommended
  re-reading every remaining bare `lua_*` allocation against it. The chunk
  loaders were swept; the three argument-staging paths — which call
  `PushLuaValue` on caller-supplied data, the single most allocation-heavy thing
  the library does outside the parser — were not (F3).

Severity distribution: two high (F1, F2), two medium (F3, F4), plus nits (F5).
No previously-fixed site regressed *behaviourally*, but F1 is a previously-fixed
site that regressed **textually** and went unnoticed for three passes.

---

## Findings

### F1. Both converter loops iterate a vector that the user JS they call can reallocate — confirmed use-after-free (high)

CR-2 found that the JS→Lua type-converter loop held a reference into
`type_converters_` across `match.Call()`, which can re-enter and register another
converter. The fix (commit `a0db1f1`, July 14) was an indexed loop, and it came
with a comment:

```cpp
// Index the vector and pull both function handles out BEFORE calling match():
// a match/convert callback may re-enter and register another converter,
// reallocating the vector and invalidating any reference held across the call.
```

That comment is still present at `lua-native.cpp:3645-3648`. The code beneath it
is not:

```cpp
// lua-native.cpp:3649  (NapiToCoreImpl, JS -> Lua)
for (auto &[fst, snd] : type_converters_) {
  Napi::Function match = fst.Value();
  Napi::Function convert = snd.Value();
  if (match.Call({value}).ToBoolean().Value()) { ... }
}

// lua-native.cpp:3715  (CoreToNapi, Lua -> JS) — same shape, same comment
for (auto &[fst, snd] : from_lua_converters_) { ... }
```

Pulling `fst`/`snd` into locals protects the *current* iteration's handles. It
does nothing for the range-`for`'s own iterator, which is a raw pointer into the
vector's buffer. `register_type_converter` (`:2294`) and
`register_from_lua_converter` (`:2310`) are ordinary public methods with no
reentrancy guard beyond `RejectIfBusy()`, so a `match` callback can `emplace_back`
and reallocate the buffer the loop is walking.

**Git archaeology.** `git log -S` identifies both regressions precisely:

| Commit | Date | What it did |
|---|---|---|
| `a0db1f1` | Jul 14 | CR-2 remediation: `for (auto& conv : ...)` → `for (size_t i = 0; ...)` |
| `545638e` | Jul 23 | "Apply code review fixes: add `const` and `[[nodiscard]]`…" → back to `for (auto &[fst, snd] : type_converters_)` |
| `6839145` | Jul 24 | "fix clang-tidy issues" → same, for `from_lua_converters_` |

Both regressing commits are *style* passes. Neither touched the comment.

**Reproduced under ASan**, JS→Lua direction:

```js
const lua = new lua_native.init({}, { libraries: 'all' });
lua.register_type_converter(
  (v) => { for (let i = 0; i < 16; i++) lua.register_type_converter(() => false, (x) => x);
           return false; },            // fall through to the next converter
  (v) => v);
lua.register_type_converter((v) => false, (v) => v);   // a second iteration to reach
lua.set_global('probe', { a: 1 });
```

```
==55744==ERROR: AddressSanitizer: heap-use-after-free ... READ of size 8
  #0  Napi::Reference<Napi::Function>::Value() const            napi-inl.h:3733
  #1  LuaContext::NapiToCoreImpl(Napi::Value const&, int)       lua-native.cpp:3650
  #2  LuaContext::NapiToCoreInstance(Napi::Value const&, int)   lua-native.cpp:3517
  #3  LuaContext::SetGlobal(Napi::CallbackInfo const&)          lua-native.cpp:1175
```

The Lua→JS direction is identical, through `execute_script('return {a=1}')`:

```
==56296==ERROR: AddressSanitizer: heap-use-after-free ... READ of size 8
  #0  Napi::Reference<Napi::Function>::Value() const            napi-inl.h:3733
  #1  LuaContext::CoreToNapi(lua_core::LuaValue const&)         lua-native.cpp:3716
```

**Why two converters are needed to see it, and why that matters.** A range-`for`
caches `end()` once, at loop entry. With a single registered converter the loop
body runs once and then compares two stale pointers that happen to compare equal,
so the invalidation is invisible. It only manifests when a converter that grows
the vector is followed by another converter — which is exactly the shape a
one-converter smoke test cannot produce. That is why the suite is clean.

**Calibration.** High. It is memory corruption reached from two public methods
with no adversarial input — the trigger is "a converter's `match` touches a
lazily-initialized module that registers more converters", which is an ordinary
lazy-init pattern. It is ranked above the other findings partly for that and
partly because **it is a fix that was already made, and was undone by a commit
that believed it was only changing style.**

**Recommendation.** Restore the indexed form at both sites. Then close the
class rather than the two sites: any loop over a member container that calls
user JS from its body must either index, or snapshot first the way
`SharedTable::Propagate` (`:686-707`) already does — that function has the
correct discipline and a comment explaining it, and is the model. Add a clang-tidy
`NOLINT` (or a short "// intentional: index, not range-for" marker) at each
restored loop so the next modernization pass cannot silently undo it again.

**Test.** The two reproductions above, in the `test-ts-asan` suite. Each must use
**at least two** registered converters, and a comment should say why, or the pin
will rot into a test that passes for the wrong reason.

### F2. Replacing a JS callback from inside itself destroys the `std::function` currently executing — confirmed use-after-free (high)

CR-9 F4 established the rule and fixed two of its instances:

> a print handler that calls `set_print_handler()` from inside itself — to
> silence further output, the obvious use — would otherwise destroy the
> `std::function` currently executing.

`output_handler_` and `debug_hook_` are now `shared_ptr`s whose owner is copied
before dispatch. The third and by far largest population of host callables was
not swept:

```cpp
// core/lua-runtime.cpp:1786, inside LuaCallHostFunction
const auto it = runtime->host_functions_.find(func_name);
...
resultHolder = it->second(args);        // user JS runs here
```

```cpp
// core/lua-runtime.cpp:2378, inside RegisterFunction
host_functions_[name] = std::move(fn);  // destroys the previous std::function
```

The wrapper stored there captures `[this, name, alive]` — a pointer, a
`std::string` and a `shared_ptr`, 48 bytes, well past libc++'s 24-byte small-object
buffer, so the closure lives on the heap. Move-assigning over the map entry calls
`destroy_deallocate()` on the target **that is currently running**. Everything the
lambda touches after the JS call returns — `name`, `runtime`, `this` — is read
out of freed memory.

The binding reaches this from one ordinary public method:

```cpp
// lua-native.cpp:1169-1173, LuaContext::SetGlobal
if (const Napi::Value value = info[1]; value.IsFunction()) {
  runtime->RegisterFunction(name, CreateJsCallbackWrapper(name));
  js_callbacks_[name] = Napi::Persistent(value.As<Napi::Function>());
}
```

`set_global(name, fn)` is the only registration path whose name is chosen by the
caller; every other one (`__mt_<id>_*`, `__module_<id>_*`, `__class_*_<id>`,
`__ud_method_<id>_*`, `__searcher_<n>`, `__js_callback_<n>`) mints a monotonic
id and therefore cannot collide with a name in flight. One vector is enough.

**Reproduced under ASan** — seven lines, no adversary, no `reset()`, no metatable:

```js
const lua = new lua_native.init({
  foo: (n) => {
    lua.set_global('foo', (x) => x * 2);   // hot-swap the handler from inside it
    return Promise.resolve(1);             // makes the wrapper use captured `name`
  }
}, { libraries: 'all' });
lua.execute_script('return foo(1)');
```

```
==57098==ERROR: AddressSanitizer: heap-use-after-free ... READ of size 3
  #0  memcpy
  #1  std::__concatenate_strings<...>
  #2  std::operator+<char,...>(char const*, std::string const&)
  #3  LuaContext::CreateJsCallbackWrapper(...)::$_0::operator()(...)  lua-native.cpp:2427
  #7  std::__function::__func<...>::operator()(...)                    function.h:174
```

Frame #3 is `"'" + name + "' returned a Promise; …` — the captured `std::string`
whose buffer the `std::function` destructor freed while `operator()` was still on
the stack.

**A note on why the plainer variant looks clean.** Returning an ordinary object
instead of a Promise makes the wrapper use only the captured `this`, which the
compiler is free to keep in a callee-saved register across the JS call — so the
same defect exits 0 even under ASan. The Promise variant forces a reload of a
capture whose payload is a separate heap block, and the report is immediate. Any
regression pin must use the second shape; the first would pass without the fix.

**Calibration.** High, on the same grounds CR-10 F2 was: no adversary, no
unusual API. "Replace a handler from inside itself" is the same idiom CR-9 F4
called "the obvious use" when it fixed the print handler, and the fix note there
observed that the old behaviour "was benign only because the capture list fits
libc++'s small-buffer optimization, which is an implementation detail rather than
a guarantee." Here the capture list does *not* fit, so it is not even benign by
accident.

**Recommendation.** Fix at the class level, not at `SetGlobal`. Two options,
in order of preference:

1. **Store the callables behind a `shared_ptr`** — `unordered_map<string,
   shared_ptr<Function>>` — and have the three bridges
   (`LuaCallHostFunction`, `UserdataMethodCall`, `JsSearcher`) copy the owner out
   of the map *before* invoking it, exactly as `DispatchOutput` and
   `DispatchDebugHook` already do. This is the CR-9 F4 mechanism, applied to the
   population it skipped, and it also removes the (currently theoretical)
   iterator concern in F5.
2. Alternatively, make `RegisterFunction`/`StoreHostFunction` refuse to replace a
   name while it is executing. That is cheaper but weaker: it turns a hot-swap
   into an error rather than making it work, and it needs per-name depth
   bookkeeping the runtime does not have.

Whichever is chosen, sweep all three bridges and both wrapper factories, and add
a line to the `host_functions_` declaration recording the rule — the reason this
survived nine passes is that the rule lives in a comment on `output_handler_`,
1,000 lines away from the map it also governs.

**Test.** The Promise-returning reproduction above, plus the ordinary-return
variant (which is silent today but should be pinned anyway), plus a control that
replacing a *different* name from inside a callback keeps working. In the
`test-ts-asan` suite.

### F3. The "can allocate from Lua" sweep stopped at the chunk loaders — argument staging and two `lua_gc` modes still run finalizers at depth 0 (medium)

CR-10 F1 restated the invariant and asked for a sweep:

> Every remaining bare `lua_*` allocation outside a scope should be re-read
> against that wording.

The chunk loaders were swept. Three sites were not, and one lost its bracket in
the same commit.

**(a) Argument staging.** Every entry into Lua that takes caller-supplied
arguments pushes them *before* the scope opens:

| Core method | Unbracketed allocation | Binding entry point | Armed by |
|---|---|---|---|
| `CallFunction` | `PushLuaValue` loop, `lua-runtime.cpp:2517` | `call`, function handles | binding `CallScope` only |
| `ResumeCoroutine` | `PushLuaValue` loop, `:3250` | `resume`, coroutine iterator | binding `CallScope` only |
| `ResumeAsyncStep` | `PushLuaValue` loop, `:3435` | `DriveAsync` (no `CallScope`) | `is_busy_` only |

`PushLuaValue` on a caller-supplied table allocates a Lua table, a string per
key, and a closure plus a sentinel userdata per nested JS function. It is the
heaviest allocator in the library after the parser — the very argument CR-10 F1
used about `luaL_loadbuffer`.

**(b) `gc('incremental')` / `gc('generational')`.** CR-10 F3 narrowed
`GarbageCollect`'s scope to the two commands it identified as collecting:

```cpp
if (command == "collect") { ExecutionScope exec(this); ... }     // :412
...
if (command == "step")    { ExecutionScope exec(this); ... }     // :436
...
if (command == "incremental" || command == "generational") {     // :442 — no scope
  const int prev = CheckGCAvailable(lua_gc(L_, ...), command);
```

`lua_gc(L, LUA_GCGEN)` calls `luaC_changemode`, whose `entergen` drives the
collector through `luaC_runtilstate` — including the `GCScallfin` state, which
runs pending `__gc` finalizers. Before CR-10 F3 the scope covered the whole
function and these were bracketed; the narrowing removed that.

**Measured**, with temporary `IsExecuting()` probes compiled into the C++ test
binary at `076e9e4` (a host function called from a `__gc` metamethod records
`rt.IsExecuting()`; probes removed afterwards):

```
[CR11] gc('generational')      : finalizers=374  IsExecuting true=0    false=374
[CR11] gc('collect')           : finalizers=35   IsExecuting true=35   false=0     <- control
[CR11] CallFunction arg push   : finalizers=1751 IsExecuting true=0    false=1751
[CR11] ResumeAsyncStep arg push: finalizers=1750 IsExecuting true=0    false=1750
```

The `gc('collect')` control confirms the probe works and that the bracketed
command reports correctly.

**Calibration: medium, and deliberately not high.** No crash was reproduced,
because every one of these paths is masked. `call`, `resume` and the coroutine
iterator each open a `CallScope`, so `reset()`'s `|| call_depth_ > 0` still
rejects; `DriveAsync` runs under `is_busy_`, so `RejectIfBusy()` rejects; and
`LuaContext::GC` opens a `CallScope`. A `__gc` finalizer that calls `reset()`
from any of them is correctly refused today, and that was verified for all four.

It is reported anyway, at medium, for one reason: **masking by the binding's
counters is precisely the co-dependency CR-10 F1 set out to remove.** CR-10 fixed
four chunk-loader rows that were "not currently exploitable, but masked by the
*binding's* `call_depth_` — the very second-opinion counter CR-9 demoted precisely
because it depends on each method remembering." These four rows are the same
rows, one method deeper. Leaving them is the CR-9 lesson in miniature: *an unswept
gap is a hazard whose severity is set by code that has not been written yet*, and
the next binding method that reaches `CallFunction` without a `CallScope` (or the
next core caller of `ResumeAsyncStep`) inherits an unarmed guard.

One incidental fact worth recording, since it bounds how much the *budget* half
of `ExecutionScope` matters here: Lua sets `L->allowhook = 0` around a `__gc`
metamethod, so the count hook does not fire inside a finalizer. The instruction
limit, the wall-clock timeout and `cancel()` therefore cannot interrupt a
finalizer regardless of scope. Only the reentrancy half of the invariant is at
stake on these paths — but that is the half `reset()` depends on. This is worth a
sentence in `SetMaxInstructions`/`SetTimeout`'s documentation on its own account:
"a `__gc` finalizer is not interruptible" belongs next to "a single long-running
C call is not interrupted."

**Recommendation.** Bracket the three argument-staging loops (scoped to the
push alone, so the `ProtectedCall`/`lua_resume` below still starts the budget —
the same shape the chunk-loader fix used), and restore the bracket on
`incremental`/`generational`. While there, `HasClass` (`:978-982`) reads a
registry key by name outside any scope, and `lua_checkstack` sits just *before*
the scope in `ToLuaValueProtected` (`:2071` vs `:2081`) and `PushProtectedGlobal`
(`:2403` vs `:2410`); a stack grow is an allocation. These are the last ones I can
find, so this sweep should be able to close the class rather than move it.

**Test.** C++ pins in the shape of the probes above — a host function invoked
from a `__gc` finalizer asserting `IsExecuting()`, driven from `CallFunction` with
a large argument, from `ResumeAsyncStep`, and from `GarbageCollect("generational")`
— plus the `gc('collect')` control. These belong in the C++ suite rather than the
TypeScript one: the binding masks all four, so a JS-level test could not fail even
with the bug present.

### F4. Superseded metatable / module / userdata-method registrations strand their callbacks forever (medium)

M2 introduced `RegisterReclaimableHostFunction` so that anonymous JS callbacks
nested inside crossing values do not accumulate for the life of the context. The
mechanism works. It was applied to exactly one of the five registration sites —
`NapiToCoreImpl`'s `__js_callback_<n>` (`lua-native.cpp:3548`). The other four use
plain `StoreHostFunction`, which is never reclaimed:

| Site | Name minted | Reclaimed when the Lua-side object dies? |
|---|---|---|
| `set_metatable` (`:1692`) | `__mt_<id>_<key>` | ✗ |
| `register_module` (`:1789`) | `__module_<id>_<key>` | ✗ |
| `set_userdata` methods (`:1384`) | `__ud_method_<ref_id>_<name>` | ✗ |
| `register_class` methods (`:1579`) | `__class_method_<id>_<name>` | ✗ (class is permanent — correct) |
| `NapiToCoreImpl` (`:3548`) | `__js_callback_<n>` | ✓ |

Because the id is monotonic, calling any of the first three again mints a *new*
name and leaves the previous generation's `host_functions_` entry and its paired
`js_callbacks_` `Napi::Persistent` in place — pinning the JS closure, and
everything it captures, until the context is destroyed. The Lua-side object that
made them reachable is gone; nothing can ever call them again.

**Measured** with `WeakRef` pins under `--expose-gc`, after
`gc('collect')` and three GC settles:

```
superseded set_metatable callbacks pinned  : 40 / 40
superseded register_module callbacks pinned: 40 / 40
collected-userdata method callbacks pinned : 40 / 40
nested anonymous callbacks pinned          :  1 / 40   <- control (M2 path, working)
```

The control is the diagnostic one: the reclaimable path releases 39 of 40 (the
40th is still live in Lua), so the harness is measuring what it claims to.

`set_userdata` is the sharpest case: the runtime *does* clean up when the
userdata is collected — `DecrementUserdataRefCount` fires
`userdata_gc_callback_`, which erases `js_userdata_[ref_id]` and clears the
`_ud_methods_<ref_id>` registry key (`lua-runtime.cpp:822-843`) — but it does not
touch the method callbacks that entry was created alongside. Half the teardown is
implemented.

**Calibration.** Medium. Not memory-unsafe, but unbounded and silent, in
patterns that are the point of the API: re-installing a sandbox metatable per
request, re-registering a module on config reload, minting a short-lived userdata
with methods per operation. Each iteration pins a JS closure and its captured
scope graph. The existing CR-8 F3 tests confirm a *failed* `set_metatable` strands
nothing (`lua-native.spec.ts:6214`); nobody tested a *successful, superseded* one.

**Recommendation.** Route the three reclaimable sites through
`RegisterReclaimableHostFunction` — the closures the core installs already carry
the name as an upvalue, which is exactly the shape the sentinel `__gc` mechanism
reclaims. `register_class` should stay as it is (a class registration is
permanent by design and cannot be superseded, which `registered_classes_`
enforces); note that explicitly at the site so the asymmetry reads as a decision.
For `set_userdata`, alternatively, extend the existing GC callback to erase the
method-callback names alongside `js_userdata_[ref_id]` — it already knows the
`ref_id`, and the names are derived from it.

**Test.** The `WeakRef` probes above, with the M2 control alongside so the
measurement can't rot into a vacuous pass.

### F5. Nits

- **Three of the five cross-boundary `*Data` constructions still use a raw
  `new`.** CR-9 F4 introduced the `unique_ptr`-until-the-External-owns-it
  discipline and applied it to `CreateTableHandle` (`:1894`) and
  `CreateCoroutineObject` (`:4005`). `CoreToNapiBuiltin` still does
  `auto* dataPtr = new LuaFunctionData(...)` (`:3760`),
  `new LuaUserdataData(...)` (`:3789`) and `new LuaTableRefData(...)` (`:3800`)
  before the N-API allocation that will own them. Milder than the case CR-9 F4
  fixed — these refs are *shared* copies, so a throw leaks the heap block but
  does not orphan a registry slot — but it is the same three lines of discipline,
  and the inconsistency invites the reader to conclude one of the two forms is
  wrong.
- **`~LuaRuntime` clears three of the five handlers that bridge into the binding**
  (`lua-runtime.cpp:539-543`): `userdata_gc_callback_`, `output_handler_`,
  `host_fn_gc_callback_`. `property_getter_` and `property_setter_` are left
  installed across `lua_close`. The block's own comment says "The binding layer
  also clears these, but the core must not depend on it" — and for the property
  handlers it does depend on it (`DetachRuntimeHandlers`, `lua-native.cpp:1077`).
  A `__gc` finalizer that reads a property off a proxy userdata during teardown
  reaches them. Not reachable through the binding, which detaches correctly; it
  matters for direct use of the core, which the C++ suite exercises. Two lines.
- **`cbIt` is an `unordered_map` iterator held across user JS.** Both wrappers do
  `auto cbIt = js_callbacks_.find(name)` and then `cbIt->second.Call(jsArgs)`
  (`:2413`/`:2423` and `:2459`/`:2472`). A nested registration during that call
  (`set_global`, or any JS function crossing into Lua, which mints a
  `__js_callback_<n>` entry) can rehash the map, which invalidates iterators
  though not references. libc++'s node-based layout makes this benign in
  practice, but it is formally UB and it is free to fix — copy the
  `napi_value`/`Napi::Function` out before the call, the way the converter loops
  are supposed to. Folds into F2's option (1) if that is taken.
- **`GarbageCollectParam`'s "no scope is deliberate" comment is right about the
  mechanism but is now load-bearing for the wrong reason.** With `incremental`
  and `generational` also unbracketed (F3), the comment reads as though the
  asymmetry is confined to `param`. Once F3 is fixed the comment is accurate
  again; until then it is actively misleading and should be revisited in the same
  edit.

---

## Verified and rejected (adversarial suspicions that held up)

- **`ClearHostFunctions()` and a retired runtime.** After a `reset()`, the
  retiring runtime keeps its `host_functions_` populated by design, and
  `~LuaContext` clears only the *current* runtime's. A finalizer of the retired
  state firing after the context dies therefore reaches a live wrapper — and is
  correctly stopped by `context_alive_`, which is never re-minted. The
  belt-and-braces unbind is genuinely just braces here; the flag is the
  mechanism, as CR-10 said.
- **`ExecutionScope` on the worker thread.** The new chunk-load scopes run inside
  `LuaScriptAsyncWorker::Execute`, so `lua_depth_` (a non-atomic `mutable int`)
  is now written off-thread on one more path. CR-10's argument still holds
  unchanged: every main-thread reader is behind `RejectIfBusy`, and the only
  main-thread work during a worker run reaches `UnrefOrDefer`, which touches the
  mutexed queue and never `lua_depth_`. No race found.
- **The double `BeginExecutionBudget` on the execute paths.** `ExecuteScript`
  now opens a scope for the load (starting a budget) and `ProtectedCall` opens
  another (starting a second). Harmless and correct — the second is the one that
  bounds the run, which is what the header now documents.
- **Re-registering a *different* name from inside a callback.** Safe:
  `unordered_map` insertion may rehash, but references to existing elements are
  stable, so the executing `std::function` is untouched. Only the same-name
  overwrite is fatal (F2).
- **A reclaimable callback erasing itself mid-call.** `OnHostFnClosureCollected`
  erases `host_functions_[name]` when the last closure for that name is
  collected. It cannot fire for a name currently executing: the closure being
  called is live on the Lua stack, so the count cannot reach zero. Verified by
  inspection of `PushLuaValue`'s sentinel accounting and
  `EraseReclaimableIfUnpushed`'s zero-count guard.
- **`searchers_` and `shared_tables_` replay in `Reset()`.** Both are range-`for`
  loops over member vectors, i.e. F1's shape. Neither is reachable: they run
  against a freshly-built state with no metatables on `_G`, `package` or
  `package.searchers`, so the core calls inside them cannot re-enter user JS, and
  no public method appends to either vector from JS anyway. Safe by construction
  rather than by guard — worth a comment, not a finding.
- **`SharedTable::Propagate`.** Snapshots its subscriber list before running any
  user JS and explains why (`:686-698`). This is the correct discipline and the
  model F1 should be fixed to.
- **`type_converters_` handle extraction.** Pulling `match`/`convert` into locals
  before the call is correct and necessary — it is only insufficient. The fix is
  additive, not a replacement.
- **Property handlers at teardown, through the binding.** Still clean:
  `~LuaContext` runs `DetachRuntimeHandlers()` before its members die. The core's
  own omission (F5) does not reach the binding.
- **`Cancel()` during the async argument push.** `DriveAsync`'s `ResumeFlag`
  covers the whole `ResumeAsyncStep` call including the unbracketed push, so a
  `cancel()` from a finalizer there is deferred rather than freeing the running
  coroutine. Verified by reading the RAII extent; no defect.
- **`gc('collect')`, `gc('step')`, `gc('count')`, `gc('stop')`, `gc('restart')`,
  `gc('isrunning')`.** Measured: only `collect`, `step` and `generational` run
  finalizers. The first two are bracketed; the read-only commands genuinely run
  no Lua, so CR-10 F3's narrowing was right about them.
- **The CR-10 F2 reproductions.** Both the seven-line teardown case and the
  `--expose-gc` mid-program case exit 0 at `076e9e4`, and the teardown finalizer
  degrades exactly as documented (no output, no crash).

---

## Suggested priority order

1. **F2** — put `host_functions_` behind the same owner-copy discipline
   `output_handler_` and `debug_hook_` already have. High: a confirmed
   use-after-free from `set_global(name, fn)` called inside `name`, which is the
   same idiom CR-9 F4 called "the obvious use". Ranked first because the fix is
   small, the class is already understood, and this is the last unswept member of
   it.
2. **F1** — restore the indexed converter loops and mark them against future
   modernization. High, and arguably the more important of the two for process
   reasons: it is a fix that was made, undone by a style commit, and missed by
   three subsequent reviews with its own explanatory comment sitting on top of it.
3. **F3** — bracket the three argument-staging pushes and restore the bracket on
   `incremental`/`generational`; sweep `HasClass` and the two pre-scope
   `lua_checkstack`s while there. Medium: measured at depth 0 with 374–1,751
   finalizers each, masked today by exactly the binding counters CR-10 F1 set out
   to stop depending on.
4. **F4** — route `set_metatable`, `register_module` and `set_userdata`'s method
   callbacks through the reclaimable path. Medium: measured 40/40 pinned against
   a 1/40 control.
5. **F5** — the nits: the three raw `new`s, the two uncleared core handlers, the
   held `cbIt`, and `GarbageCollectParam`'s comment.

(The CR-3 M5 deployment target, the CR-5 F3/F8 release-time items, and the two
narrowed CR-8 F6 residuals remain deferred by decision; intentionally absent from
this list.)

---

## Note on the trajectory

CR-9 relocated an invariant into the core. CR-10 observed that relocation makes
the invariant's *wording* load-bearing. CR-11's contribution is the third term in
that sequence, and it is about the repository rather than the design:

> **A fix is only as durable as the thing that stops it being undone. A comment
> is not that thing.**

F1 is the cleanest demonstration this series has produced. CR-2 identified a real
hazard, chose the right fix, and wrote a comment explaining precisely why the
loop had to be indexed. Nine days later a commit whose message was "add `const`
and `[[nodiscard]]` annotations" turned it back into a range-`for`; a day after
that, "fix clang-tidy issues" did the same to its twin. Neither commit touched
the comment, so the file now *documents* the fix immediately above code that does
not implement it — and three full review passes read that comment, agreed with
it, and moved on. The reviews were not careless; they were reading the wrong
artifact. **A comment describes intent; only a test or a lint suppression
describes what the code is currently doing.**

The complementary point comes from F2 and F4, which are the same failure in the
other direction: a fix that named its class correctly and then enumerated its
members incompletely. CR-9 F4's comment says "for the same reason `debug_hook_`
does" — two members named, a third (`host_functions_`, the largest population by
far) never counted. M2's reclaimable-callback mechanism was built to stop host
functions accumulating, and was wired to one of the five sites that mint them.
Neither is a reasoning error; both are enumeration errors, and enumeration errors
are invisible to a reviewer who checks the sites the fix names.

So the concrete process suggestions, in decreasing order of how mechanical they
are:

1. **When a fix depends on a non-obvious *form* of code** — indexed loop, copy
   before call, scope placement — leave a marker the tooling honours
   (`// NOLINT(modernize-loop-convert)`, a named helper, a static assertion), not
   only prose. Prose loses to the next automated cleanup.
2. **When a fix names a class, write down the full member list at the class's
   home**, not at the site being fixed. `output_handler_`'s comment is the right
   text in the wrong file: the rule it states governs a map declared 1,000 lines
   away and never mentions it.
3. **Add "supersede" to the standing test categories, beside CR-10's "leave it in
   use at destruction".** The suite has thorough coverage of *failed*
   registrations stranding nothing (CR-8 F3) and none at all of *successful,
   replaced* ones — the same one-step-past-where-every-test-stops shape that hid
   CR-10 F2.
4. **A regression pin must fail without the fix, in the exact shape it will be
   written.** F1 needs two converters and F2 needs a Promise-returning callback;
   the one-converter and plain-object variants exit 0 even under ASan. A pin that
   passes for the wrong reason is worse than no pin, because it advertises
   coverage that does not exist.
