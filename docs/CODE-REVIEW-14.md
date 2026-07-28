# CODE-REVIEW-14

**Date:** July 28, 2026
**Scope:** Fourteenth pass, against commit `1cf81a6` — the CODE-REVIEW-13
remediation, plus a re-read of both C++ layers, the async worker, and the public
TypeScript surface.

**Method:** CR-13 closed by installing a *mechanical* check for its own finding:

> in every JS-facing entry point, this scope should appear above the first
> `.Get(` / `.Call(` / `GetPropertyNames(` / `NapiToCoreInstance(` /
> `CoreToNapi(` line. Split lua-native.cpp by function, find the first of each
> per entry point, compare. As of CR-13 exactly six entry points have user JS
> above their scope […] this is the whole list, so a seventh is a regression.

That is the right *shape* of remedy — CR-12 asked for invariants that can be
checked rather than believed. So this pass did not re-run the check. It asked
the question the check cannot ask about itself:

> **What is the universe the check ranges over, and is that universe the same as
> the hazard's?**

The check says "per entry point" and never defines *entry point*. Running it by
hand, the only reading that makes the enumeration come out at six is
"`LuaContext` instance method". The hazard's universe is *every place the addon
runs user JavaScript on the main thread while holding — or about to mint —
references into the current `lua_State`*. Those are not the same set, and the
difference is where this pass's high finding lives.

Every finding below was driven to a reproduction; each recommendation was
implemented and re-verified before being recommended, per CR-12's rule. Where a
consequence could not be driven, this review says so.

**Baseline:** 806 TypeScript and 283 C++ tests pass at `1cf81a6`. The high
finding is reproducible against that clean baseline, under the ASan addon the
suite itself runs clean on.

---

## Headline

**One high finding, and it is the CR-13 F1 class at a site CR-13's remedy
structurally could not see.** `reset()` is refused while a binding method runs
user JS — the fix works, and every one of the seven doors CR-13 named stays
shut. It is *not* refused while a **worker-async completion callback** marshals
its results: `LuaScriptAsyncWorker::OnOK` / `LuaFileAsyncWorker::OnOK` clear
`is_busy_` **before** converting the run's return values, and open no
`CallScope` — so a registered Lua→JS converter, running mid-marshal, retires the
state and the remaining values are wrapped as handles pairing the **new** runtime
with the **old** state's registry refs. Reproduced: a silent read and write onto
an unrelated live table in the fresh state, and an ASan-confirmed
`heap-use-after-free` at `lua-runtime.cpp:782` — the same instruction CR-13 F1
named.

One medium: `__luaClassOwner`, the cross-context identity guard added by CR-2
M6, is a **raw** `LuaRuntime*`. Once the owning context's runtime is freed the
address is recyclable, and a new context's runtime lands on it often enough that
a retained class instance from the dead context is accepted as one of the new
context's own userdata. Reproduced in 2 of 3 runs, with no hostile input.

The rest are low: the CR-13 enumeration asserts a completeness it does not have
(and F1 is outside its universe entirely), `types.d.ts` documents one of
`reset()`'s two throw conditions, and three nits.

The CR-13 remediation itself verifies clean, with one exception noted at F5.

---

## Resolution status (July 28, 2026)

All findings resolved. After the fixes: **814 TypeScript tests** (up from 806 —
eight new CR-14 pins) and **285 C++ tests** (up from 283) pass, and all four
sanitizer harnesses are clean: `test-ts-asan` (814/814), `test-cpp-asan`
(285/285), `test-cpp-tsan` (285/285) and `test-ts-tsan` (814/814). The F1
reproduction that produced the `heap-use-after-free` now refuses cleanly, with
no sanitizer report.

**Four of the eight new tests fail against the pre-fix binary**, and one of them
fails by terminating the vitest worker outright — `libc++abi: terminating due to
uncaught exception of type std::__1::system_error: mutex lock failed: Invalid
argument`, which is the uninstrumented signature of F1's use-after-free
(`UnrefOrDefer` taking `deferred_unref_mutex_` on a destroyed `LuaRuntime`). The
other four are deliberate **controls** and pass either way: two assert the fixes
do not over-reach (a converter may still call the context synchronously during
the marshal; a same-context instance still round-trips as userdata), and two pin
behaviour that already existed (an instance does not survive its own context's
`reset()`; `reset()`'s three refusal messages — F4 was a documentation defect,
so a pin that failed before the fix would have meant the code was wrong too).

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | Both worker `OnOK`s open a `CallScope` for the duration of the marshal, immediately after `ClearBusy()`. Fixed as recommended and in the form the prototype verified — not by deferring `ClearBusy()`, because a converter is legitimately allowed to call back into the context synchronously there, and a control test now pins that. The rule the three marshalling sites depend on is recorded **at `ClearBusy()`** rather than at the two sites that were wrong: *the busy flag may not be dropped while values from the completed run are still being converted*, with all three sites named and `DriveAsync` / `OnAwaitSettled` marked as satisfying it by ordering instead of by a scope. Three pins (script worker, file worker, and the GC-lifetime pin that drives the use-after-free to a finalizer) plus one control. |
| F2 | ✅ Done | `LuaRuntime` gains a process-wide monotonic `Id()`; class instances carry it as `__luaClassOwnerId` (a BigInt) alongside the existing `__luaClassOwner` External, and **both** must match. The id is the test — it is never reused, so there is no ABA — and the External stays as a second barrier, since a genuine one cannot be minted from JS. The retention-based alternative (an owning `shared_ptr` share) was rejected as recommended: it would pin an entire Lua state from a plain JS object the user does not think of as a handle. `Id()`'s comment states why the raw pointer was insufficient, and the round-trip check now says out loud that the sibling `_tableRef` / `_userdata` / `_coroutine` comparisons are sound *because* their `*Data` holds a share — the distinction that is invisible at the comparison. Two C++ tests (distinct ids; an id is never reused across 32 replacement states in recycled storage) and three TS pins. The TS pin retains instances from **eight** collected contexts rather than one: a single A→B pair reproduced the defect in only about 2 runs in 3, while the eight-way shape failed 5 of 5 pre-fix. |
| F3 | ✅ Done | The `CallScope` comment now states **the universe before the predicate**, and states it as the hazard's rather than as "instance method": *every function in `lua-native.cpp` that, on the main thread, reads `runtime` / `alive_` / `js_userdata_` (or mints a handle from them) and can also run user JS* — explicitly including the N-API completion callbacks, which are not methods and take no `CallbackInfo`, and naming `LuaFunctionDataFrom` / `TableRefDataFrom` as helpers whose `.Get(` counts as their caller's (so the predicate now lists them too). Both enumerations are repaired: `CreateCoroutine`, `ExecuteScriptIn`, `SharedTable::Set` and `SharedTable::Sync` join the "user JS above the scope" list with the reason each is inert, and the seven scope-free methods join the three that were named. `DriveAsync` and `OnAwaitSettled` are recorded as guarded by `is_busy_` instead — a different mechanism, and the one most likely to be mis-read as an omission. The comment closes by saying the lists are hand-maintained and should be re-derived rather than trusted, which is the honest thing to write above a list that had ten omissions. |
| F4 | ✅ Done | `types.d.ts` now documents `reset()`'s **three** refusal conditions as three numbered facts with the reason each is distinct, rather than one sentence plus a clause — including the case CR-13 added and nothing documented: a type converter, a definition-object getter or a Proxy trap, with no Lua executing at all. The busy condition is extended to name the async-result-marshalling window F1 just closed, so the contract covers the fix. One pin, asserting all three messages. |
| F5 | ✅ Done | The redundant shadowing `CallScope` in `create_environment` is removed, with a note saying why "exactly one" is what makes "find the first one" a check. The proxy-userdata setter's evaluation-order dependency is commented at the site, naming both refactors that would silently break it. The `lua_next`-traversal residual is recorded where the "can allocate from Lua" rule lives (next to `IsExecuting()`), as a bounded, not-driven consequence of that rule rather than as a claim. The two release-time deferrals remain deferred by decision. |

The original findings follow unchanged for reference.

---

## Verification of the CODE-REVIEW-13 remediation

| CR-13 # | Verdict |
|---------|---------|
| F1 | ✅ Correct at every site it names, and the site fix is the important one. `TableHandlePairs` has its `CallScope` (`lua-native.cpp:512`) and the comment that argued against it is replaced with the reason the argument was wrong. All seven doors were re-driven this pass with the CR-13 probes' shape: each now returns the rejection message. `Reset()` reports the two conditions separately (`:3236`, `:3242`), and the distinction is pinned. The class-level move landed at every method the review listed: `register_class` (`:1474`), `set_metatable` (`:1678`), `set_userdata` (`:1349`), `register_module` (`:1822`), `set_hook` (`:3460`), the Lua-function handle call (`:610`), `create_environment` (`:2139`), `compile` (`:1901`), `compile_file` (`:1940`), `CoroIteratorNext` (`:4125`). **Two residuals**: the remediation's claim that "the now-redundant inner scopes were removed … so each method has exactly one" is false for `create_environment`, which still nests a second, shadowing scope at `:2186` (F5); and the enumeration recorded at `CallScope` is incomplete in three ways, one of which hides F1 (F3). |
| F2 | ✅ Correct in all three places, and the correction is the one the mechanism supports. `types.d.ts:712-736` now separates the two async families, names the three hook consumers, and states both real caveats. Re-derived independently this pass from `InstallExecutionHook` (`lua-runtime.cpp:299-332`) and `ExecutionHook` (`:220-243`): the count mask is set for `max_instructions_ > 0`, else `timeout_ms_ > 0`, and additionally whenever a debug hook asked for a count interval; cancellation is tested first, before either limit; a line-only debug hook yields no count event and so no cancellation, which matches the text. The two behavioural pins are present and the timeout-only one is the load-bearing half. |
| F3 | ✅ Correct on all three. `NextUserdataId()` (`:2691`) is the single increment site and throws at `INT_MAX` instead of wrapping; both callers (`set_userdata`, `CreateConstructorWrapper`) are on paths that convert a `std::exception` into a JS error. The ERRMEM window is recorded at the site (`lua-runtime.cpp:1817-1825`) with the reasoning for not fixing it, which is the honest form. `create_environment` is guarded with the note that the probe, not the hazard, was what bounded CR-13. |
| Release deferrals | Unchanged, as decided. `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` (`binding.gyp:142`, `:306`) and `prebuilds/` still contains `darwin-arm64` only. |

---

## Findings

### F1. `reset()` is legal while a worker-async run marshals its results — and the values it is still converting belong to the state being retired (high)

**Where the guard stops.** `reset()` refuses on three conditions
(`lua-native.cpp:3216-3249`): `RejectIfBusy()`, `runtime->IsExecuting()`, and
`call_depth_ > 0`. Between them they cover every path CR-13 enumerated. The
worker-async completion path satisfies **none** of them:

```cpp
void LuaScriptAsyncWorker::OnOK() {          // lua-native.cpp:3605
  Napi::Env env = Env();
  context_->ClearBusy();                     // :3607  -> is_busy_ = false
  if (std::holds_alternative<std::string>(result_)) { … }
  try {
    deferred_.Resolve(context_->ResultsToJs(  // :3617  -> runs the Lua->JS converters
      std::get<std::vector<lua_core::LuaPtr>>(result_)));
```

`ClearBusy()` (`:2684`) drops `is_busy_` as its *first* act, before a single
result value has been converted. The worker has left Lua, so `IsExecuting()` is
false. `OnOK` is not a binding method and opens no `CallScope`, so `call_depth_`
is 0. Every guard reads "idle".

`ResultsToJs` → `CoreToNapi` runs the registered **Lua→JS converters** — user
JS, and one of the exact callback kinds CR-13's own test category names. A
converter calling `reset()` there is accepted.

**Contrast, and why this is an enumeration failure rather than a design
choice.** The two other places the addon marshals async results both close the
window, and they close it *by accident of ordering* rather than by a stated
rule:

| Site | Marshals via | `is_busy_` during the marshal | `reset()` |
|---|---|---|---|
| `DriveAsync`, Finished (`:2933-2949`) | `ResultsToJs(step.values)` | **true** — `FinishAsync()` runs *after* | rejected ✅ |
| `OnAwaitSettled` (`:2968-3016`) | `NapiToCoreInstance(value)`, plus the reject path's `message`/`name`/`stack` getters | **true** | rejected ✅ |
| `LuaScriptAsyncWorker::OnOK` (`:3605`) | `ResultsToJs(result_)` | **false** — `ClearBusy()` runs *first* | **runs** |
| `LuaFileAsyncWorker::OnOK` (`:3629`) | idem | **false** | **runs** |

Three sites, one operation, one of them ordered the other way. Nothing states
which order is required, so the two `OnOK`s are not a regression from a rule —
they predate the rule and were never brought under it.

**Driven — silent cross-object aliasing.** With a from-Lua converter that resets
on first call and then repopulates the fresh registry:

```
resetRan = true
stale.tag    = null    <- the old-state object is unreachable
stale.secret = LIVE-1  <- it is reading an unrelated live table in the NEW state
!! victim1 clobbered through the stale handle -> CLOBBER
```

The mechanism is CR-13 F1's verbatim. `CoreToNapiBuiltin`'s table-ref branch
(`:4013`) keeps building out of the context's *current* members:

```cpp
auto data = std::make_unique<LuaTableRefData>(runtime, v, this, alive_);
```

`runtime` and `alive_` are the **new** generation; `v` carries a registry ref
minted in the **old** state. The handle passes every identity check in the
codebase — `data->runtime.get() == runtime.get()` is true, the liveness flag is
the current one — while addressing `LUA_REGISTRYINDEX[oldRef]` in a registry
that has never heard of it. The `LuaFunctionRef` branch (`:3965`) and the
`LuaThreadRef` branch (`:3979`) mis-bind identically; the non-opaque
`LuaUserdataRef` branch silently returns `null`, because `reset()` cleared
`js_userdata_`.

**Driven — the endgame.** `LuaTableRef`'s registry-owner deleter captured the
**old** `lua_State*`; the handle's `shared_ptr` keeps only the **new** runtime
alive. Once the worker (the last holder of a share of the old runtime) is
destroyed, nothing holds the old state up. Under the ASan addon:

```
==52560==ERROR: AddressSanitizer: heap-use-after-free on address 0x61b00000d800
READ of size 8 at 0x61b00000d800 thread T0
    #0 lua_core::detail::UnrefRegistrySlot(lua_State*, int) lua-runtime.cpp:782
    #1 lua_core::detail::MakeRegistryOwner(lua_State*, int)::'lambda'(void*)::operator() lua-runtime.h:61
    #8 lua_core::LuaTableRef::release() lua-runtime.h:172
    #9 LuaTableRefData::~LuaTableRefData() lua-native.h:95
   #11 LuaContext::CoreToNapiBuiltin(...)::$_0::operator()<LuaTableRef> lua-native.cpp:4018
freed by thread T0 here:
    #1 lua_core::LuaRuntime::LuaAllocator(...) lua-runtime.cpp:159
    #2 lua_core::LuaRuntime::~LuaRuntime() lua-runtime.cpp:571
```

Same address, same instruction, same free site as CR-13 F1 — reached through the
async completion path instead of a binding method.

**Why no prior pass looked here.** CR-8 F4 audited these two functions
*specifically* — it is the finding that added the `try`/`catch` around the very
`ResultsToJs` call above, because a marshalling failure used to escape `OnOK` as
an uncaughtException. That pass asked "can this throw?" and answered it
correctly. It did not ask "can this *re-enter*?", and five reviews later CR-13
asked exactly that question but scoped it to methods. The line has been read
carefully, twice, for two different properties, neither of which was this one.

**Recommendation — implemented and verified before being recommended.**

Open a `CallScope` on `context_` for the duration of both `OnOK` bodies:

```cpp
void LuaScriptAsyncWorker::OnOK() {
  Napi::Env env = Env();
  context_->ClearBusy();
  LuaContext::CallScope _cs(context_);   // the marshal below runs user JS
  …
```

`CallScope` is a nested class, so it reaches `call_depth_` and
`js_error_registry_` without widening any access; clearing the registry at the
outermost entry is inert here, since a worker run cannot stage a JS error
(callbacks are disabled in `async_mode_`). Verified: the probe flips from
`RESET RAN` to the rejection message, `stale.tag` reads back `"B"` — its own
object, in a state that still exists — and 806/806 TS tests pass. Prototype
reverted; the tree as reviewed is unchanged.

Prefer this to the alternative of moving `ClearBusy()` below the marshal: a
converter running during a completion callback is legitimately allowed to call
back into the context synchronously, and leaving `is_busy_` set would break that
while also needing a new guarantee that it is cleared on every throw path.

State the rule the three sites currently satisfy by coincidence, at
`ClearBusy()`: **the busy flag may not be dropped while values from the
completed run are still being converted.** And add the missing pins — a
converter that resets, one per worker family, plus a GC-lifetime pin that drives
the use-after-free (drop the pre-reset handle, collect, then drop the mis-bound
one), which is the only form ASan can see.

### F2. `__luaClassOwner` is a raw `LuaRuntime*`, so a freed context's address identifies a live one (medium)

CR-2 M6 added `__luaClassOwner` because `__luaClassRef` alone is "just an
integer and would collide across contexts". The owner is minted as a bare
pointer (`lua-native.cpp:2630-2631`):

```cpp
DefineHiddenProp(env, instObj, "__luaClassOwner",
  Napi::External<lua_core::LuaRuntime>::New(env, runtime.get()));
```

and checked by address (`:3822-3823`):

```cpp
const bool owned = owner.IsExternal() &&
  owner.As<Napi::External<lua_core::LuaRuntime>>().Data() == runtime.get();
```

The comment at the mint site is precise about what the External is — "identity
comparison only; it never owns or dereferences the runtime, so no finalizer is
needed" — and that is exactly the problem. **A pointer is a unique token only
while the object it points at is alive.** Nothing keeps the runtime alive here,
so once the minting context is collected the address returns to the allocator,
and `make_shared<LuaRuntime>` for the *next* context is a same-sized request
that the allocator is happy to satisfy from the same block.

**Driven.** Create context A with a class, retain one instance, drop A and force
GC, create context B with a class, pass A's instance into B:

```
A instance: alpha A
context A collected (its LuaRuntime block is now free)
B instance: beta B
B sees the foreign instance as -> userdata:beta:B
!! ALIASED: the foreign instance was accepted as one of B's own userdata
```

Reported honestly: **2 of 3 runs**. It is heap-layout dependent — a variant with
different class names in the two contexts perturbed the layout enough that the
addresses no longer matched and the instance deep-copied correctly. That
non-determinism is a property of the reproduction, not of the defect.

The consequence is silent substitution, not memory unsafety. `js_userdata_`
holds a live entry under that `ref_id`, so Lua receives a real userdata for a
real object — just *the wrong object*. `incoming.name` reads `"beta"`. When the
foreign instance's `__luaClassName` names a class the receiving state never
registered, `luaL_setmetatable` finds no metatable and installs none, so the
userdata gets no `__gc`, and the `IncrementUserdataRefCount` performed at push
time is never balanced — the receiving context's `js_userdata_` entry is then
pinned for its lifetime.

**Why the sibling checks are sound and this one is not.** Every other identity
guard in the file compares `data->runtime.get()` against `runtime.get()` where
`data` is a `*Data` struct that **holds a `shared_ptr<LuaRuntime>`**. That share
is what makes the comparison meaningful: the old runtime cannot be freed while
the marker exists, so its address cannot be recycled. `_tableRef`, `_userdata`,
`_coroutine` and `__luaFnOwner` all have it. `__luaClassOwner` is the one marker
whose token has no lifetime tied to it, and at the comparison site the two
shapes are textually identical.

Note the neighbouring protection that *does* work, because it was chosen for
this reason: within a single context, `next_userdata_id_` is deliberately never
rewound by `reset()`, so a post-reset instance can never re-mint a pre-reset
`ref_id` and the stale marker's lookup misses. That defence is per-context, and
two contexts' counters both start at 1 — which is precisely the case
`__luaClassOwner` exists to cover.

**Recommendation.** Give the token a lifetime, or make it non-recyclable:

1. **A monotonic runtime id** (preferred). Add a `uint64_t id_` to `LuaRuntime`
   from a process-wide atomic counter, expose `Id()`, and carry it in the hidden
   prop alongside the External; require both to match. A monotonic counter is
   never reused, so there is no ABA at all, and nothing is kept alive.
2. **Or make the External own a share** — a `std::shared_ptr<LuaRuntime>` (or a
   small token object) copied per instance, with a finalizer. Correct, and
   consistent with how the `*Data` structs already work, but it changes retention:
   a plain JS object the user does not think of as a handle would pin an entire
   Lua state.

Whichever is chosen, record the rule where the comparison happens: **an identity
token that is a raw pointer is only valid while something else guarantees the
pointee's lifetime; say what that something is, or don't use a pointer.**

Not attempted here, because both options touch a documented contract and the
choice is the author's.

### F3. The CR-13 completeness enumeration is incomplete, and its mechanical check cannot see F1 (low)

`CallScope`'s comment (`lua-native.h:261-313`) makes two completeness claims and
prescribes a check. All three need correcting; the third is why F1 survived.

**(a) The six-entry-point exemption list is missing two, both of which are
inert.** The list covers entry points whose *own* body has a `.Get(` above the
scope. Two more have one via a **helper function**, which a per-function split of
`lua-native.cpp` cannot see:

- `create_coroutine` (`:4270`) calls `LuaFunctionDataFrom(info[0])` (`:4255`),
  which runs `fn.Has("__luaFnOwner")` / `fn.Get(…)`. Given a `Proxy` over a Lua
  function — `typeof` is `"function"`, so `IsFunction()` accepts it — those are
  user traps, and no scope is open. It **fails closed**: the
  `fnData->runtime.get() != runtime.get()` and `funcRef.ref == LUA_NOREF` checks
  both run after the reads.
- `execute_script_in` (`:2200`) calls `TableRefDataFrom(info[0])` (`:2117`) at
  `:2209`; its `CallScope` is at `:2232`. Same shape, same fail-closed outcome —
  the identity check at `:2219` is after the reads and nothing but a
  `Utf8Value()` separates it from the use.

Both are harmless *today*, and both are exactly the shape the list exists to
enumerate so a future edit cannot make them harmful quietly.

**(b) The "three methods deliberately have no scope" list is missing seven.**
`reset`, `cancel` and `is_busy` are named. Also scope-free, all verifiably
running no user JS: `remove_hook` (`:3531`), `get_memory_usage` (`:2241`),
`info` (`:2256`), `register_type_converter` (`:2393`),
`register_from_lua_converter` (`:2409`), `execute_script_async` (`:2723`) and
`execute_file_async` (`:2740`). And `SharedTable::Get` is listed as an exemption
while its far more JS-heavy siblings `Set` (`:776`) and `Sync` (`:788`) are not
mentioned at all — they are safe, because every push routes through the target
context's own `set_global`, which opens its own scope; but the list either
covers `SharedTable` or it does not.

Ten omissions, every one inert. That is the tell: a hand-maintained enumeration
decays toward its maintainer's mental model, and it decays *silently* precisely
where the omissions are harmless.

**(c) The check's universe is "instance method", and the hazard's is not.**
This is the one with teeth. The prescribed procedure — "split lua-native.cpp by
function, find the first of each per entry point, compare" — needs a definition
of *entry point*, and the only definition under which the count comes out at six
is `LuaContext` instance method. F1 lives in `LuaScriptAsyncWorker::OnOK`: a
main-thread N-API completion callback, not a method, with no `CallbackInfo` at
all, which runs `CoreToNapi` and mints handles from `runtime` and `alive_`.
Running the check exactly as written on the tree that contains F1 returns
"clean".

**Recommendation.** State the universe with the check, and make it the hazard's:
*every function in `lua-native.cpp` that reads `runtime`, `alive_` or
`js_userdata_` on the main thread and can also run user JS* — which adds the two
worker `OnOK`s and the await-settlement callbacks (the latter already covered,
by `is_busy_` rather than by a scope, which is worth saying out loud since it is
a different mechanism). Then repair the two lists, and add the helper functions
(`LuaFunctionDataFrom`, `TableRefDataFrom`) to the set of things whose `.Get(`
counts as their caller's.

### F4. `reset()`'s documented throw conditions are one short of its implemented ones (low)

CR-13 F1's remediation split `Reset()`'s single rejection into two, deliberately,
because "a single message that said 'while Lua is executing' for a case where no
Lua was running is exactly how the distinction got lost". The C++ now says both
things (`:3236` and `:3242`) and the distinction is pinned by a test.

`types.d.ts:1190-1195` still says one:

> Throws if an async operation is in flight (`is_busy()`), or if called while
> Lua is executing — from inside a host callback, metamethod, table trap, debug
> hook, or `__gc` finalizer — since the state being retired is the one those
> frames are running on.

A registered type converter, a definition-object getter and a `Proxy` trap are
none of the five things listed, no Lua is executing in any of them, and
`reset()` throws from all three — with a message that says so. A user reading the
contract and calling `reset()` from a `register_from_lua_converter` handler gets
a throw the documentation says cannot happen.

This is CR-13 F2's shape one document later: the mechanism grew a second branch
and the public contract kept describing the first. Worth fixing as documentation
— and, per CR-13's own framing, worth writing as the two distinct facts rather
than as one sentence with an appended clause, because collapsing them is the
failure mode being corrected.

### F5. Nits

- **`create_environment` has two `CallScope`s, and the CR-13 remediation says it
  has one.** `:2139` (method entry, correct) and `:2186` (inside the `try`,
  redundant), the inner declaration shadowing the outer `_cs`. Nesting is
  depth-counted so the behaviour is right; the claim in CR-13's resolution table
  — "the now-redundant inner scopes were removed rather than left nested, so each
  method has exactly one and its position is the check" — is not. It matters
  because *"exactly one"* is what makes "find the first one" a check rather than
  a search.
- **The proxy-userdata setter's evaluation-order dependency is still
  uncommented.** `it->second.object.Value().Set(key, CoreToNapi(*value))`
  (`:1110`) is safe only because C++17 sequences a member call's
  postfix-expression before its arguments, so the map iterator is dereferenced
  before `CoreToNapi` can run a converter that rehashes `js_userdata_`.
  Re-verified this pass. CR-13 recommended a comment from its "verified and
  rejected" section and the remediation did not add one; by CR-11's own lesson a
  refactor to a local temporary in the wrong order would break it silently, and
  prose is the minimum here.
- **A bounded theoretical residual, recorded rather than claimed.** `GetTableKeys`
  (`lua-runtime.cpp:2964`) allocates inside a raw `lua_next` traversal (it
  stringifies numeric keys), and `ToLuaValue`'s table branch (`:2682`) allocates
  via `luaL_ref` inside one. By this codebase's own "can allocate from Lua" rule
  those allocations can drive a GC step and run a `__gc` finalizer, and a
  finalizer that *adds a key to the table currently being traversed* makes
  `lua_next` undefined. Not driven, and it needs a finalizer that names the
  specific table under iteration; listed so the ledger is honest about a
  consequence of the rule the last two passes established.
- **Two release-time deferrals re-confirmed unchanged.**
  `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` (`binding.gyp:142`, `:306`, CR-3
  M5) and `prebuilds/` still contains `darwin-arm64` only (CR-5 F8). Deferred by
  decision.

---

## Verified and rejected (adversarial suspicions that held up)

- **The other two async marshalling sites.** `DriveAsync`'s Finished branch calls
  `ResultsToJs` *before* `FinishAsync()`, and `OnAwaitSettled` converts its
  settled value (and, on the reject path, reads `message` / `name` / `stack`
  through possibly-hostile getters) while the run is still engaged — so
  `is_busy_` is true throughout both and `reset()` is refused. Correct, but by
  ordering rather than by a stated rule; see F1's recommendation.
- **`create_coroutine` and `execute_script_in` running helper traps above their
  scope.** Both fail closed: the `data->runtime.get() != runtime.get()` and
  released-ref checks run *after* the reads, and nothing but a `Utf8Value()`
  separates check from use. Reported as unlisted (F3a), not as unsafe.
- **`CoroIteratorNext` with a hostile `this`.** `CoroSymbolIterator` only checks
  `info.This().IsObject()`, so `coro[Symbol.iterator].call(proxy)` makes the
  later `coro.Get("_coroutine")` a user trap above the scope. It fails closed:
  `ResumeCoroutineObject` re-reads the marker *inside* the scope and rejects on
  the runtime-identity check. The header's exemption holds for a reason slightly
  broader than the one it states.
- **The `*Data` identity checks.** Every `data->runtime.get() == runtime.get()`
  comparison other than `__luaClassOwner` is backed by a `shared_ptr` share, so
  the compared address cannot be recycled. This is what makes F2 a singleton
  rather than a class.
- **`next_userdata_id_`'s deliberate non-rewind across `reset()`.** Re-derived:
  it is what stops a stale `__luaClassRef` from aliasing a *same-context*
  post-reset userdata. The counter comment says "must stay monotonic so a name or
  ref_id minted before the reset can never collide with one minted after"; that
  is load-bearing, not hygiene.
- **Worker-thread reads of `host_functions_`.** `LuaCallHostFunction` does its
  `find()` *before* the `async_mode_` rejection, so the map is read off-thread.
  Safe: every mutator is behind `RejectIfBusy()`, and the GC-driven erasures
  (`OnHostFnClosureCollected`, the userdata GC callback) can only fire from a Lua
  allocation, which during a worker run happens on the worker's own thread. Same
  reasoning clears the non-atomic `debug_hook_` / `output_handler_` shared_ptr
  copies taken in the hook and print bridges.
- **The reserve/sweep accounting for reclaimable host functions.**
  `ReserveReclaimableHostFunction` uses `emplace`, which would silently keep an
  existing count if a name repeated. It cannot: every reclaimable name is built
  from a monotonic counter (`__mt_<id>_`, `__module_<id>_`, `__js_callback_<n>`,
  `__ud_method_<ref_id>_`), and `next_*` are never rewound — including by
  `reset()`.
- **`SharedTable::Propagate`'s snapshot-then-push.** A push runs user JS that can
  construct another context and subscribe it, mutating `subscribers_` mid-loop.
  The pre-loop snapshot and prune make that safe, and the per-target re-read of
  `value_` behaves as CR-12's remediation documented.
- **`reset()` re-entered from the retiring state's own teardown.** The window
  between `runtime = std::move(fresh)` and `js_callbacks_.clear()` lets a
  `__gc` finalizer of the outgoing state dispatch a JS callback while `runtime`
  already names the replacement. `in_reset_` blocks a nested `reset()`;
  `StageJsError`'s owner check (CR-12 F4) correctly declines to stage on the new
  runtime; the worst outcome found is a `js_callbacks_` entry registered by that
  callback being cleared moments later, which degrades to the ordinary
  "no longer registered" raise. Not a defect, but the narrowest margin in the
  file.

---

## Suggested priority order

1. **F1** — a `CallScope` in both worker `OnOK`s. Closes an ASan-confirmed
   use-after-free and silent cross-object corruption reachable from
   `execute_script_async` / `execute_file_async` with an ordinary registered
   converter. Verified; two door pins plus one GC-lifetime pin.
2. **F3c** — write the check's universe down next to the check, and bring the
   two worker callbacks (and the await-settlement pair, noting they are covered
   by `is_busy_` instead) inside it. Without this, F1's site is invisible to the
   next pass for the same reason it was invisible to this one before the question
   changed.
3. **F2** — replace the raw-pointer owner token with a monotonic runtime id (or
   an owning share), and record why a pointer was not enough. Reproduced, but
   non-deterministic; a regression pin should force the collection rather than
   hope for it.
4. **F3a/F3b, F4** — repair the two enumerations and the `reset()` contract.
5. **F5** — the nits.

---

## Note on the trajectory

CR-13's remediation did the thing this series has been asking for since CR-2: it
converted a property that lived in a reviewer's head into a procedure the next
reviewer can run in three seconds. That was right, and it is why every one of
CR-13's seven doors is still shut and why re-verifying them took minutes rather
than a pass.

It also produced this pass's finding, in the most instructive way available:
**the check ran clean on a tree containing the very hazard it was written for.**
Not because it was performed carelessly — because the sentence that defines it
says "per entry point" and never says what an entry point is. Read at all, the
only definition that makes the recorded count of six come out right is
`LuaContext` instance method. The hazard does not care whether the frame on the
stack is a method; it cares whether user JS can run while the addon holds live
references into a `lua_State` that `reset()` can retire. `OnOK` is not a method,
takes no `CallbackInfo`, and does exactly that.

So the clause this pass adds is about mechanical checks rather than about
guards:

> **A mechanical check has two halves: the predicate and the universe it ranges
> over. The predicate is usually written down and the universe usually is not —
> and a check whose universe is smaller than its class returns "clean" forever.
> When you install one, write the universe beside it, and justify the universe
> against the hazard rather than against the sites the finding happened to
> name.**

Two second-order observations, each of which cost something:

**A completeness claim decays fastest where being wrong is harmless.** CR-13's
list has ten omissions and every single one is inert — seven scope-free methods
that run no user JS, two helper-hidden reads that fail closed, one `SharedTable`
sibling that delegates. That is not a coincidence, it is the mechanism: an
omission with a consequence gets found by a test or a crash, so the omissions
that survive in a hand-maintained list are precisely the ones nothing detects.
The list therefore *looks* healthy right up to the moment a non-inert member
joins it. CR-12 taught "treat a comment asserting completeness as a claim to be
checked"; the sharper form is **check the enumeration against a generator, not
against your memory of writing it** — a grep that produces the list is worth more
than a list that a grep would have produced.

**Address identity is not identity, and the two are textually identical.** F2's
comparison reads exactly like the four sound ones beside it. What makes those
sound is not visible at the comparison at all — it is a `shared_ptr` member
declared in a different file, whose job of keeping the address unique is not
mentioned anywhere near the check. CR-13 already observed that this codebase's
identity guards "all share a failure mode" along the generation axis; the
lifetime axis is a second one, and it is the axis where the guard is wrong rather
than merely narrow. Where a pointer is used as a token, the token's uniqueness
comes from a lifetime, so the lifetime belongs in the comment at the comparison.

Finally, the harness. Every sanitizer harness and 806 tests pass on the tree
containing F1, and ASan reported the use-after-free within seconds of a
reproduction existing — the third consecutive pass where that sentence is true.
CR-13's standing rule was "for every guard, one test per kind of user code the
surrounding method can run". The suite *has* the kind: a from-Lua converter that
calls `reset()` is CR-13's own first regression test. What it does not have is
that converter at this **site**. So the rule needs its other half:

> **One test per kind of user code × per site that can run it.** The kinds are a
> short list and the sites are a long one, which is why the sites are the half
> that has to be generated rather than remembered.
