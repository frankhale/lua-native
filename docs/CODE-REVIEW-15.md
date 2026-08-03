# CODE-REVIEW-15

**Date:** August 3, 2026
**Scope:** Fifteenth pass, against commit `ba4982b` — the CODE-REVIEW-14
remediation (`3c51fe6`) plus the two cleanup commits that followed it
(`41fd8ec`, warning suppressions; `805d6a9`, const-correctness), and a re-read of
both C++ layers, the async workers and the public TypeScript surface.

**Method:** CR-14 closed by writing the *universe* beside the mechanical check,
because CR-13's check had returned clean on a tree containing the hazard it was
written for. That remedy verifies correct (see below), so this pass did not
re-run it either. It asked the question that neither the predicate nor the
universe can ask:

> **The check tests whether a guard is armed before the dangerous operation.
> Which operations did we decide are dangerous, and did we decide that once or
> twice?**

`reset()` is the operation four passes have hardened. It retires the
`lua_State`, so CR-9, CR-13 and CR-14 taught it to ask three separate questions
before proceeding — is an async run in flight, is Lua on this thread's stack, is
a binding method mid-flight. There is a **second** operation that takes the
state away from whoever currently holds it, and it was never audited as one:
`execute_script_async` / `execute_file_async` hand the `lua_State` to a libuv
worker thread. They ask one of the three.

Every finding below was driven to a reproduction or is reported as undriven;
each recommendation was implemented and re-verified before being recommended,
per CR-12's rule.

**Baseline:** 814 TypeScript and 285 C++ tests pass at `ba4982b`. The high
finding is reproducible against that clean baseline.

---

## Headline

**One high finding: nothing refuses a worker-thread async start while the main
thread is already inside the `lua_State`, and the result is two threads
executing in one Lua state.** `is_busy_` is a *one-directional* guard — written
by the launcher, read by everyone else. CR-1 H4 swept the direction it covers
exhaustively, and that sweep still holds: all 21 main-thread doors were
re-probed this pass and every one refuses while a worker runs. Nobody asked the
opposite question. Three doors reach it:

- **(a) from a host callback, metamethod or `__gc` finalizer** while Lua
  executes — a registered JS callback that calls `execute_script_async`.
  Deterministic **SIGSEGV, 5/5 and then 8/8**: the main thread faults in
  `_longjmp` on a shared `errorJmp` chain while the worker faults in `lua_load`.
- **(b) from a type converter, from-Lua converter or Proxy trap** running under
  a binding method. Accepted; the race window is narrower and was **not** driven
  to a crash.
- **(c) from `reset()`'s own replay phase**, where all three of `reset()`'s
  conditions are false. **SIGSEGV in 4 of 10 runs.**

Door (c) is the one that makes this a design finding rather than two missing
`if`s: `reset()`, having asked whether anyone else holds the state, then becomes
a holder itself for its entire replay — running the callbacks object's traps and
the registered type converters against the state it has just minted — and
declares nothing. So the fix has two halves, and the second is what makes the
first sufficient.

Two lows and three nits. The most interesting low is that CR-14 F5's own
enumeration, written one pass ago as the remedy for enumerations that decay, was
**incomplete on arrival**: it named two `lua_next` traversals that allocate and
missed `TablePairs`, which is the worst of the three and whose sibling
`TableIPairs` already contains the fix.

The CR-14 remediation itself verifies clean at every site it names.

---

## Resolution status (August 3, 2026)

**All findings resolved**, including the four F6 items initially carried as
outstanding. After the fixes: **829 TypeScript tests** (up from 814 — fifteen new
CR-15 pins) and **285 C++ tests** pass, and all four sanitizer harnesses are
clean: `test-ts-asan` (829/829), `test-cpp-asan` (285/285), `test-cpp-tsan`
(285/285) and `test-ts-tsan` (829/829). None of them could have found F1 — a
main-thread/worker data race is TSan's department, and `test-ts-tsan` is
explicitly a best-effort probe that cannot see libuv/V8/Lua synchronization —
which is recorded in the trajectory note below.

**Eight of the fifteen new tests fail against the pre-fix binary**: the four F1
doors and four of the five F6 marker-brand pins. The remaining seven are
deliberate controls and behaviour pins, labelled as such in the suite.

The F6 marker-External item was upgraded from "no crash produced" to a confirmed
defect while being fixed — see F6a below. It is the reason this pass ended with
more remediation than it started with.

**Four of the ten new tests fail against the pre-fix binary** — the three F1
doors plus the `execute_file_async` sibling. The other six are deliberate
**controls and behaviour pins** and pass either way: three assert the new guard
does not over-reach (a top-level worker start, a worker start from a settled
promise callback, and `execute_async` remaining deliberately unguarded), two pin
`pairs()` semantics across the F2 rewrite, and one pins the fail-closed
behaviour F5 is about — F5 was a comment defect, so a pin that failed before the
fix would have meant the code was wrong too.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | Both halves. (i) A new `RejectIfStateInUse(op)` (`lua-native.cpp:2768`) replaces `RejectIfBusy()` in `execute_script_async` and `execute_file_async`, asking the same three questions `reset()` asks, with three distinct messages naming the method. (ii) `reset()` opens a `CallScope` (`:3398`) immediately **after** the state swap, for the whole replay phase — which is what makes (i) sufficient, since the replay's user JS runs with no Lua executing and no async in flight, so `call_depth_` is the only condition that can answer. The scope is placed after the swap deliberately: `lua_close` fires the retiring state's `__gc` finalizers *inside* that statement, and those must keep reaching `in_reset_`'s more specific message, which the existing CR-9 pin asserts. The rule is recorded at `RejectIfStateInUse`, i.e. at the operation that can violate it rather than at the two callers that did — the same relocation CR-14 made at `ClearBusy()`. Deliberately **not** applied to `execute_async`, which is coroutine-driven and stays on the main thread; a control test pins that nested starts still work. |
| F2 | ✅ Done | `TablePairs` now snapshots the traversal into a flat Lua array under protection (`ProtectedTablePairsCollect`) and converts afterwards, mirroring what `TableIPairs` and `ProtectedTableICollect` already did for `ipairs`. Fixed as hardening, not as a closed defect: repeated attempts could **not** get a finalizer to fire inside the cursor, and the review says so. Two behaviour pins (mixed key types round-trip; unsupported key types still skipped). |
| F3 | ✅ Done | The `lua_next` enumeration next to `IsExecuting()` is rewritten as two groups — exposed (`GetTableKeys`, `ToLuaValue`'s table branch) and not-exposed-because-they-collect-first (`TablePairs`, `TableIPairs`) — with the note that it was wrong on arrival and the instruction to re-derive it by grepping `lua_next` rather than trusting it. |
| F4 | ✅ Done | The `CallScope` enumeration is split into "runs user JS with a *later* scope" (4 entries) and "runs user JS with *no scope at all*" (11), because six of the previous heading's nine entries had no scope to be above — and "find the first `CallScope`" returns nothing rather than a line to compare for those. Nine omissions added (the six `SharedTable` push methods, `RegisterCallbacks`, `CreateTableHandle`, `CreateCoroutineObject`, `CoroSymbolIterator`), two helpers added to the "counts as its caller's" set (`DefineHiddenProp`, `SymbolIteratorKey`), and CR-13's stated reason for `SharedTable::Set`/`Sync` corrected: the pushes do **not** necessarily route through `set_global`, since `PushValue` reads `context.Get("set_global")` and an own property shadows the prototype method. They are still inert, but for a different reason than the one written down — SharedTable holds no runtime, `alive_` or `js_userdata_` at all. |
| F5 | ✅ Done | `AsSharedTable`'s comment claimed "the InstanceOf check matters: Unwrap on an arbitrary object would read a garbage pointer out of it." `Napi::Object::InstanceOf` is `napi_instanceof`, which consults `Symbol.hasInstance`, and the constructor is reachable from JS as `createSharedTable().constructor`. Driven: the filter passes for a plain object and for a `LuaContext`. What actually holds is `Unwrap` — `napi_unwrap` rejects an object it never wrapped and node-addon-api throws. The comment now says which line is load-bearing and names the two refactors that would remove it. One pin. |
| F6 | ✅ Done | All six. **(a) Marker Externals are now type-tagged** — see below, this one grew teeth. **(b)** The two GC-notification bridges (`DecrementUserdataRefCount`'s `userdata_gc_callback_`, `OnHostFnClosureCollected`'s `host_fn_gc_callback_`) now contain exceptions like their siblings `DispatchOutput` and `DispatchDebugHook`, and the comment records that these four are the complete set of core→binding bridges dispatching from inside a Lua frame. **(c)** `DecrementUserdataRefCount`'s depth-0 precondition is stated on the declaration, the way `PushLuaValueProtected` states its own, with the allocation that requires it named. **(d)** `TakeLastErrorValue()` is non-`const` again, with the reason recorded so the next mechanical cleanup does not re-apply it. **(e)** The `-Wunused-but-set-variable` warning `805d6a9` introduced is fixed at `lua-native.cpp:1436`. **(f)** `types.d.ts`'s `reset()` condition 1 now states that the worker families refuse with message 3 rather than message 1. |

### F6a, restated: the marker Externals were a live defect, not a latent one

This shipped in the first draft under "verified and rejected" as *"reachable but
no crash produced; that is luck rather than a guard."* Fixing it produced a
better reproduction, and the honest correction is that **the original assessment
was too generous.**

JS cannot mint a `Napi::External`. It can take a genuine one the addon handed
out — `handle._tableRef`, `fn.__luaFnOwner`, `coro._coroutine` are all readable —
and present it under a *different* marker name. Every read site validated
`IsExternal()` and then `data->runtime.get() == runtime.get()`, which is
provenance, not kind; and since all four `*Data` structs begin with a
`shared_ptr<LuaRuntime>`, the identity check reads the right field of the wrong
struct and agrees. Against the pre-fix binary:

```
ACCEPTED  set_global({_tableRef: coroExt}) then type() in Lua -> thread
ACCEPTED  release({_coroutine: fnExt})
ACCEPTED  release({_tableRef: coroExt})
ACCEPTED  release(fn with __luaFnOwner = tableExt)
ACCEPTED  set_global({_userdata: tableExt}) -> userdata
refused   CONTROL genuine table handle round-trip -> table handle has been released
refused   CONTROL genuine coroutine resume        -> coroutine has been released
```

The last two lines are the finding. Those controls are *supposed* to pass — they
use the untouched, genuine handles. They fail because the three forged
`release()` calls above **succeeded and destroyed those handles' registry refs**,
each through a `release()` on a mistyped struct. This is not a theoretical
type-confusion window; it is one JS object literal away from silently
invalidating live handles a program is still using, and the "no crash" that made
it look latent is only because a `shared_ptr` reset at the wrong offset happens
to land on a null pointer here.

**Fix.** N-API type tags — a 128-bit brand applied at mint and checked before
the payload is read — via two helpers (`NewTaggedExternal`, `TaggedData<T>`) and
one tag per kind in a `lua_tags` namespace. `CheckTypeTag` returns false rather
than throwing for an untagged or wrong-kind External, so every site fails closed
exactly the way it already tried to. The read sites also collapse to a **single
`Get`**: several did `Has(k)` then two separate `Get(k)`s, which a Proxy can
answer differently each time. Only the five dereferenced markers are tagged;
`_tableOwner`, `__coroIterOwner`, `__coroBindingOwner` and `__cookie` are GC
roots that are written and never read back, since their payload reaches the
callbacks through `info.Data()`, which is not JS-reachable. Five pins, four of
which fail pre-fix.

**A defect in the fix, found by review of the fix.** The first version of the
tag block used five hand-typed hex constants that *looked* like UUIDs and were
not — they were patterns typed to look random. Two things were wrong with that,
and only one of them is cosmetic:

- The values must be **globally** unique, not merely distinct from each other.
  The threat model is a foreign External reaching one of our read sites, so
  another addon that type-tags its own objects and happens to collide would be
  accepted and reinterpreted. Hand-invented values are exactly the ones likely
  to collide with someone else's hand-invented values. They are now generated
  with `uuidgen`, which is what Node's documentation specifies.
- Nothing checked that the five were distinct. **A copy-paste repeating one
  value would silently merge two kinds — and every regression pin would still
  pass**, because each pin checks one specific wrong pairing (`_coroutine` as
  `_tableRef`, and so on) rather than all ten. The branding would be off for the
  merged pair and the suite would report green.

That second point is CR-15 F3 committed inside CR-15's own remediation: an
invariant the code depends on, stated nowhere and checked by reading. It is now
a `static_assert` over the pairwise comparison, verified to fire by duplicating
a tag and watching the build fail. The comment records why the literals are
opaque rather than derived — stability rules out anything address-based (which
is CR-14 F2's lesson), and global uniqueness rules out a hash of the type name,
which would otherwise be the obvious self-documenting alternative.

Alongside the code fixes, the public contract was updated where behaviour
changed: `types.d.ts` documents the three new refusal conditions on
`execute_script_async` / `execute_file_async` and points callers at
`execute_async` for the in-callback case, and `docs/FEATURES.md` and
`docs/ASYNC.md` carry the same note — the reverse-direction restriction is the
surprising half, so it is stated where a reader hits the async section rather
than only in the type definitions.

### Outstanding

Only the standing release-time deferrals, unchanged by decision as in every pass
since CR-3: `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` (`binding.gyp:142`,
`:306`, CR-3 M5) and `prebuilds/` still contains `darwin-arm64` only (CR-5 F8).
These are packaging decisions, not correctness items, and they stay in this
review rather than moving to `CODE-REVIEW-DEFERRED.md` for the reason CR-2
established: the deferred ledger is a record of *triaged, accepted risk*, and an
item nobody has decided about does not belong in it.

The original findings follow unchanged for reference.

---

## Verification of the CODE-REVIEW-14 remediation

| CR-14 # | Verdict |
|---------|---------|
| F1 | ✅ Correct. Both worker `OnOK`s open a `CallScope` immediately after `ClearBusy()` (`lua-native.cpp:3657`, `:3685`), covering the `ResultsToJs` marshal at `:3667` / `:3694`. The ordering rule is recorded at `ClearBusy()` (`:2703-2723`) and names all three marshalling sites, with `DriveAsync` and `OnAwaitSettled` marked as satisfying it by ordering. Both `OnError`s run no user JS. |
| F2 | ✅ Correct, and the mechanism is sound. `NextRuntimeId()` (`lua-runtime.cpp:519-522`) is a `static std::atomic<uint64_t>` with `fetch_add`, never rewound; `id_` is `const` and the copy/move constructors are deleted, so no id can be transplanted. Single mint site (`lua-native.cpp:2647-2650`), single check site (`:3879-3891`), and **both** the External and the BigInt must match. The BigInt read uses the `lossless` flag, so a forged or truncating BigInt fails closed. No site checks only the External. |
| F3 | ✅ Correct as to the universe, which was the load-bearing half — it now states the hazard's universe before the predicate and explicitly includes the N-API completion callbacks. The lists it repaired have new problems of their own (F4), which is a different failure than the one CR-14 fixed. |
| F4 | ✅ Correct. `types.d.ts:1190-1212` documents three numbered refusal conditions. One imprecision noted at F5. |
| F5 | ✅ Correct on all three. `create_environment` has exactly one `CallScope` (`:2146`); the proxy-userdata setter's evaluation-order dependency is commented at the site and names both breaking refactors; the `lua_next` residual is recorded next to `IsExecuting()` — incompletely, which is F2/F3. |
| Cleanup commits | ✅ No regression. `41fd8ec` and `805d6a9` did not undo any load-bearing form: the `OnOK` scopes, the F2 marker sites, the single `create_environment` scope and the setter-ordering line are all intact, and `CreateTableHandle`'s rewrite (`(void)data.release()` → `LuaTableRefData* const dataPtr = data.release()`) preserves the required "External first, release second" ordering. Two nits recorded below. |
| Release deferrals | Unchanged, as decided. `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` and `prebuilds/` still contains `darwin-arm64` only. |

---

## Findings

### F1. A worker-thread async run can be started while the main thread is already inside the `lua_State` (high)

**The asymmetry.** `is_busy_` is set by `execute_script_async` /
`execute_file_async` / `execute_async` and read by every other entry point.
That makes it an excellent answer to one question:

> *May I enter this context while a worker owns the state?*

CR-1 H4 is the finding that established it, and its sweep was exhaustive. Every
main-thread door was re-probed this pass during a live worker run — the Lua
function trampoline, all seven table-handle methods, the coroutine iterator,
`release`, `gc`, `get_memory_usage`, `info`, `get_global`, `set_global`,
`compile`, `create_table`, `get_global_ref`, `create_environment`,
`register_class`, `set_hook`, `remove_hook` — and **21 of 21 refuse**, with
`cancel()` correctly allowed. That guard is in good order.

It says nothing at all about the other direction:

> *May I hand the state to a worker while I am already inside it?*

`ExecuteScriptAsync` (`lua-native.cpp:2757`) and `ExecuteFileAsync` (`:2774`)
each begin with `RejectIfBusy()` and nothing else. Neither consults
`runtime->IsExecuting()` nor `call_depth_`. `LuaScriptAsyncWorker::Execute`
(`lua-async-worker.h:32-45`) takes no lock and re-checks nothing — it calls
`runtime_->ExecuteScript(script_)` straight onto the shared state.

**Contrast with `reset()`, which is the same kind of operation.** Both
`reset()` and a worker start take the `lua_State` away from whoever currently
holds it. `reset()` asks three questions (`:3250`, `:3270`, `:3276`), added over
three separate passes, each because the previous set was insufficient:

| Condition | `reset()` | worker start (before) |
|---|---|---|
| `is_busy_` — another async run owns it | ✅ | ✅ |
| `IsExecuting()` — Lua is on this thread's C stack | ✅ (CR-9 F1) | ❌ |
| `call_depth_ > 0` — a binding method is mid-flight | ✅ (CR-13 F1) | ❌ |

Three passes of hardening landed on one of the two operations in the class, and
nothing ever said the class had two members.

**Driven — door (a), ordinary code, no hostile input.**

```js
const lua = new lua_native.init({}, ALL_LIBS);
lua.set_global('cb', () => {
  lua.execute_script_async('local s=0 for i=1,4e6 do s=s+i end return s');
  return 1;
});
lua.execute_script('cb() local t = 0 for i = 1, 4e6 do t = t + i end return t');
```

`cb()` is dispatched from inside Lua, so `IsExecuting()` is true and the main
thread returns into the loop below it. The worker begins parsing on the same
state. **SIGSEGV, 5/5 then 8/8.** Under lldb, both threads fault:

```
* thread #1, name = 'MainThread', stop reason = EXC_BAD_ACCESS
    frame #0: libsystem_platform.dylib`_longjmp + 72
  thread #8, name = 'libuv-worker', stop reason = EXC_BAD_ACCESS
    frame #0: lua-native.node`lua_load + 116
```

The main thread faulting inside `_longjmp` is the signature: `lua_State` holds
one `errorJmp` chain, and two threads pushing and popping protected frames on it
corrupt the `jmp_buf` linkage. This is the H9 class reached from the direction
CR-1 H4 did not sweep.

**Driven — door (c), and this is the one with teeth.** `reset()`'s replay phase
(`:3348` onward) calls `RegisterCallbacks(callbacks_ref_.Value())`, which runs
`GetPropertyNames` and `Get` on the caller's callbacks object; then
`InstallPrintHandler`; then `SharedTable::PushTo`, which pushes through
`set_global` and so through the registered type converters. All of that is user
JS, all of it runs against the state `reset()` has just minted, and at that
point:

- `is_busy_` is false — the guard at the top of `reset()` required it;
- `IsExecuting()` is false — no Lua is running between the replay steps;
- `call_depth_` is 0 — `reset()` opened no scope;
- `in_reset_` is true — and it blocks a nested `reset()` and **nothing else**.

```js
const cbs = new Proxy({ a(){}, b(){}, c(){} }, {
  get(t, k) {
    if (k === 'a' && lua) lua.execute_script_async('local s=0 for i=1,8e6 do s=s+i end return s');
    return t[k];
  },
});
lua = new lua_native.init(cbs, ALL_LIBS);
lua.reset();
```

**SIGSEGV in 4 of 10 runs**; on the surviving runs `reset()` returns with
`is_busy() === true` and a worker mutating the state the replay just finished
writing. Note what this means for the fix: adding the two missing conditions to
the launchers does **not** close this door, because all three conditions read
false. `reset()` has to say that it is holding.

**Not driven — door (b).** A type converter or from-Lua converter calling
`execute_script_async` mid-conversion is accepted (`call_depth_ > 0`, no Lua
executing). Confirmed accepted through both a `register_type_converter` handler
during `set_global` and a `register_from_lua_converter` handler during a
`pairs()` traversal. Neither was driven to a crash across a dozen runs with
widened windows — the remaining main-thread Lua work after the converter returns
is short. Reported as a real gap in the same guard, at unproven severity.

**Recommendation — implemented and verified before being recommended.**

Two halves; the second is what makes the first sufficient.

1. Replace `RejectIfBusy()` in both worker launchers with a guard that asks all
   three of `reset()`'s questions, with distinct messages per CR-13's lesson.
   Put the rule at the guard — the operation that can violate it — rather than
   at the two call sites, which is the relocation CR-14 made at `ClearBusy()`.
2. Open a `CallScope` in `reset()` for its replay phase, **after** the state
   swap. After, not before: `lua_close` fires the retiring state's `__gc`
   finalizers inside the swap statement, and those must keep reaching
   `in_reset_`'s more specific diagnosis, which an existing CR-9 pin asserts.

Do **not** extend the guard to `execute_async`. It is coroutine-driven and stays
on the main thread, so a nested start re-enters Lua on the thread that already
owns it — which Lua supports, which the suite exercises, and which was verified
working (a nested `execute_async` suspending on an await resolves correctly and
leaves `is_busy_` false). The hazard is the thread handoff, not the reentrancy,
and a guard that cannot tell them apart would break a supported pattern. A
control test pins this.

### F2. `TablePairs` runs a `lua_pcall` inside a live `lua_next` cursor (low, not driven)

CR-14 F5 recorded, as a bounded consequence of the "can allocate from Lua" rule,
that two raw `lua_next` traversals allocate from inside the loop: `GetTableKeys`
stringifies numeric keys, and `ToLuaValue`'s table branch takes a `luaL_ref` per
nested handle. An allocation can drive a GC step, a GC step can run a `__gc`
finalizer, and Lua's manual makes `lua_next` undefined if a finalizer adds a key
to the table being traversed.

There is a third, and it is the largest by a wide margin.
`TablePairs` (`lua-runtime.cpp:3154`) called `ToLuaValueProtected` **per value**
with the cursor live — and that is a full `lua_pcall`, not a string intern.

The telling detail is one function below it. `TableIPairs` collects into a Lua
array under protection *first* and converts afterwards, and says why:

> *"then convert that array to C++ afterwards so no C++ locals are live across a
> potential metamethod raise."*

The sibling written to avoid a neighbouring hazard was already the fix for this
one.

**Not driven.** Several shapes were tried — garbage held uncollected across the
traversal, `collectgarbage("stop")`/`("restart")` to time the finalizers into the
window, values heavy enough to force allocation per entry — and in every case
zero finalizers fired inside the cursor. An earlier probe that appeared to drive
it was misread: its injections all happened *before* the traversal began, so a
200-entry table honestly contained 2682 entries by the time `pairs()` ran. That
correction is recorded here because "I could not drive it" bounds the harness,
not the hazard, and the difference between the two is exactly what CR-12's
addendum warns about.

**Recommendation.** Rewrite `TablePairs` in `TableIPairs`' shape — a
`ProtectedTablePairsCollect` trampoline that flattens the traversal into a Lua
array of alternating keys and values, converted after the cursor is gone. It
costs one extra table and removes the exposure entirely rather than bounding it,
which is worth doing for a hazard nobody can currently drive but nobody can
argue is absent.

### F3. CR-14 F5's `lua_next` enumeration was incomplete on arrival (low)

This is F2 stated as a process finding, and it is the reason F2 is worth writing
up at all.

CR-14's closing note prescribed: *"check an enumeration against a generator, not
against your memory of writing it. A grep that produces the list is worth more
than a list a grep would have produced."* The enumeration CR-14 F5 wrote in the
same remediation lists two members. `grep -n lua_next src/core/lua-runtime.cpp`
returns four call sites, of which three are traversals in the class described
and the list names two. The missing one is the worst.

The list was one pass old when it was found incomplete, and the omission was not
inert in the way CR-14's ten were — it was simply the largest member of its own
class.

**Recommendation.** Restate it as two groups (exposed; not exposed *because*
they collect first), so a new traversal has an obvious bucket to join, and say
in the comment that it should be re-derived by grepping `lua_next` rather than
read. A list that names the safe members and the reason they are safe is
checkable in a way that a list of hazards is not.

### F4. The `CallScope` enumeration has a wrong heading and nine omissions (low)

CR-14 repaired this list and warned that it is hand-maintained. Both remain
true; a fresh census found:

**(a) The heading is wrong for six of its nine entries.** "Members with user JS
*above their scope*" implies a scope exists lower down to compare against.
`SharedTable::Get`, `Set`, `Sync`, the `LuaContext` constructor, `Pcall` and
`Release` have **no scope at all**. Only `TableRefGetTrap`, `CoroIteratorNext`,
`CreateCoroutine` and `ExecuteScriptIn` actually match the heading. This matters
because the prescribed check is "find the first `CallScope` and compare" — for
six entries it returns nothing, and "nothing" is indistinguishable from "the
check does not apply here".

**(b) Nine functions in the stated universe appear on neither list.** The six
`SharedTable` push methods (`PushValue`, `PushTo`, `Subscribe`, `Propagate`, and
`Set`/`Sync` by way of them), `RegisterCallbacks`, `CreateTableHandle`,
`CreateCoroutineObject` and `CoroSymbolIterator`. All inert — the `SharedTable`
methods hold no runtime state at all, and the three handle-minting functions
build their `*Data` and pair it with the runtime *before* the first patchable
call, so a `reset()` from a trap flips `alive_` and the handle fails closed. The
last point is worth stating out loud in the comment, because it is a property of
statement order inside those functions and a reordering re-opens CR-13 F1.

**(c) Two helpers are invisible.** The comment names `LuaFunctionDataFrom` and
`TableRefDataFrom` as helpers whose user JS counts as their caller's.
`DefineHiddenProp` reads `Object.defineProperty` off the global and
`SymbolIteratorKey` reads `Symbol.iterator` — both user-patchable, and between
them called from eight sites.

**(d) One stated reason is false.** CR-13 justified `SharedTable::Set`/`Sync` by
*"each push routes through that context's own `set_global`, which opens its own
scope."* `PushValue` (`:673`) reads `context.Get("set_global")`, and an own
property on the wrapper object shadows the prototype method — so the push can be
an arbitrary user function that opens no scope. The conclusion survives, because
`SharedTable` holds no `runtime`, `alive_` or `js_userdata_` and there is
nothing for a reset to invalidate; the *reason* does not. This is the CR-14 F2
shape again: a check whose soundness comes from somewhere other than where the
comment says it does.

### F5. `AsSharedTable`'s `InstanceOf` filter is defeatable, and the comment credits it (low)

`AsSharedTable` (`lua-native.cpp:797`) is the guard that stops
`SharedTable::Unwrap` running on a foreign object, and its comment is explicit
about why it exists:

> *"The InstanceOf check matters: Unwrap on an arbitrary object would read a
> garbage pointer out of it."*

`Napi::Object::InstanceOf` is `napi_instanceof`, which is the JS `instanceof`
operator and therefore consults `Symbol.hasInstance`. The constructor is
deliberately not exported — but it is reachable as
`createSharedTable().constructor`. **Driven:**

```js
const st = lua_native.createSharedTable({ a: 1 });
Object.defineProperty(st.constructor, Symbol.hasInstance, { value: () => true });
```

after which the filter passes for a plain `{}` and for a `LuaContext`. Both are
then rejected — by `Unwrap`, because `napi_unwrap` refuses an object it never
wrapped and node-addon-api converts the status into a thrown `Napi::Error`. It
fails closed, and it fails closed at a line the comment does not mention.

Reported as a comment defect, not a vulnerability. The consequence is that the
next person to touch this function has been told the wrong thing about which
line they may not remove.

### F6. Nits

- **`TakeLastErrorValue()` was made `const` by `805d6a9`.** It is a method whose
  entire purpose is to empty the object (`return std::move(last_error_value_)`),
  and it compiles only because `last_error_value_` was made `mutable` years
  earlier for `CaptureError() const`. Behaviour is identical and there is one
  caller, so this is cosmetic — but it is the CR-11 pattern in miniature: a
  mechanical cleanup applying a qualifier that makes a mutating operation read
  as a query. The same commit made a dozen state-mutating methods `const`
  (`RegisterClass`, `CreateTable`, `SetGlobalMetatable`, …); those are defensible
  because they mutate through `L_` rather than through members, but the file no
  longer distinguishes "does not change the Lua state" from "does not change a
  C++ member", and this codebase's threading story cares about the first.
- **`805d6a9` introduced a compiler warning.** `if (bool needs_proxy = readable
  || writable || has_methods)` at `lua-native.cpp:1421` produces
  `-Wunused-but-set-variable` on every debug build. The declaration-in-condition
  form buys nothing here, since the name is never used in either branch.
- **`DecrementUserdataRefCount` is an unbracketed allocator on a public core
  method.** `lua-runtime.cpp:851-854` builds a registry key and calls
  `lua_setfield(L_, LUA_REGISTRYINDEX, …)`, which interns the key — an
  allocation, with no `ExecutionScope` and no `RunProtected`. It has exactly one
  caller in the tree, `UserdataGC` (`:615`), which is a `__gc` metamethod and so
  is bucket-2 correct by the `IsExecuting()` enumeration's own rules; the addon
  never reaches it at depth 0. So this is a core-API contract gap rather than a
  live defect: the method is public, the C++ tests call it directly, and nothing
  documents the depth-0 precondition that `PushLuaValueProtected` states for
  itself.
- **Two GC-notification callbacks dispatch without exception containment.**
  `userdata_gc_callback_(ref_id)` (`:860`) and `host_fn_gc_callback_(name)`
  (`:1333`) are invoked from inside `__gc` C frames with no `try`/`catch`, unlike
  their three sibling bridges `DispatchOutput` (`:1516`) and `DispatchDebugHook`
  (`:292`), whose comments state the rule they follow: *"Lua is built as C — a
  C++ exception must not unwind through its frames."* Latent today, because the
  binding's two handlers are map erasures and effectively non-throwing — but the
  file's own doctrine is that the core must not depend on that.
- **`types.d.ts`'s `reset()` contract, condition 1, is imprecise.** It cites
  `execute_async` as the async-result-marshalling example, which is correct and
  genuinely refuses under `is_busy_`. The window CR-14 F1 actually closed is the
  *worker* families, whose marshal refuses under condition 3 (`call_depth_`)
  because `ClearBusy()` runs first there. Every sentence is true; the mapping of
  window to message is left implicit, and the CR-14 pin's regex accepts either.
- **Two release-time deferrals re-confirmed unchanged.**
  `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` (`binding.gyp:142`, `:306`, CR-3
  M5) and `prebuilds/` still contains `darwin-arm64` only (CR-5 F8). Deferred by
  decision.

---

## Verified and rejected (adversarial suspicions that held up)

- **CR-1 H4's sweep, re-driven in full.** All 21 main-thread entry points refuse
  during a live worker run — including the ones added after CR-1 (the coroutine
  iterator, `get_ref`, `create_environment`, `register_class`, `set_hook`).
  `cancel()` is correctly allowed. The guard is complete in the direction it was
  built for; F1 is about the direction nobody built one for.
- **`execute_async` nested inside a synchronous run.** Accepted, and correct: it
  is coroutine-driven and stays on the main thread. Verified end to end — a
  nested `execute_async` started from a host callback, suspending on an awaited
  promise, resolves with the right value, leaves `is_busy_` false, and the
  context is usable afterwards. Deliberately excluded from F1's guard, with a
  control test so a later "consistency" edit does not add it.
- **The `Symbol.hasInstance` forgery reaching `SharedTable::Unwrap`.** Defeats
  the filter, does not defeat the unwrap. Reported as F5, a comment defect.
- **`AsSharedTable` called from `reset()`'s SharedTable replay.** The stored
  references are genuine SharedTables validated at subscribe time, so the
  forgery cannot reach that call site; the `if (!table) continue` there stays
  defensive rather than load-bearing.
- ~~**Marker Externals are untyped.**~~ **Withdrawn — this was a finding, not a
  rejection, and it is now F6a.** It was filed here on the strength of "no crash
  produced", which was true and irrelevant: driving it properly while
  implementing the fix showed that the forged `release()` calls *succeed* and
  destroy the genuine handles' registry refs through a mistyped struct. The
  original entry is the exact error CR-12's addendum warns about — treating "I
  could not crash it" as a statement about the hazard rather than about the
  probe — committed in the same document that quotes that warning. See F6a.
- **The hook/coroutine cancel blind spot.** `InstallExecutionHook` installs on
  `L_` only, and threads inherit the hook at `lua_newthread` time — so a
  coroutine created before any count hook exists can never observe
  `cancel_requested_`. Reachable only via `set_hook` with a count interval after
  the fact, since `maxInstructions` and `timeout` are construction-time options
  and therefore always precede every coroutine. Verified: with no limits
  configured, both a pre-existing and a fresh coroutine run to completion
  identically. Narrow, and partly documented at `lua-runtime.h:627`.
- **`~LuaRuntime` teardown ordering.** Re-derived independently: the destructor
  resets both registry-backed error values while `this` and `L_` are still valid,
  then nulls five bridges — `userdata_gc_callback_`, `output_handler_`,
  `host_fn_gc_callback_`, `property_getter_`, `property_setter_` — and removes
  the hook, all before `lua_close`. `host_functions_` is deliberately retained
  and the binding clears it. Nothing added since CR-10 fires into a destroyed
  member during close.
- **The deferred-unref machinery.** Every flag flip and every `luaL_unref` on the
  deferral path happens under `deferred_unref_mutex_`, the drain holds the lock
  so a concurrent main-thread finalizer blocks, and the workers' brackets are
  first and last statements with RAII teardown. No window found. (The residual:
  the extraspace runtime pointer is never cleared, so a future member holding a
  `LuaPtr` destroyed after the destructor body would touch a closed `lua_State`.
  No member does today.)
- **`grep -n 'lua_pushcclosure(.*LuaCallHostFunction' src/core/lua-runtime.cpp`
  still returns exactly one hit** (CR-12 F2), at `:2811`. The one-hit grep
  remains the best-aged invariant in this codebase, and F3 is the argument for
  writing more of them.
- **Stack discipline.** Every push sequence that scales with user data is
  preceded by `lua_checkstack`; the remaining raw pushes are bounded constants
  within their C frame's `LUA_MINSTACK` guarantee.

---

## Suggested priority order

1. **F1** — the three-condition guard on both worker launchers, *and* the
   `CallScope` over `reset()`'s replay. The second is not optional: door (c)
   reads false on all three conditions without it. Closes a deterministic
   two-thread-one-`lua_State` segfault reachable from an ordinary registered
   callback.
2. **F4** — repair the heading and the omissions, and correct the
   `SharedTable::Set` reason. The wrong heading is the more damaging half,
   because it makes the prescribed check silently inapplicable to six entries.
3. **F2/F3** — rewrite `TablePairs` in its sibling's shape and restate the
   `lua_next` enumeration as two groups.
4. **F6a** — brand the marker Externals. Promoted from a nit after the
   reproduction improved: forged markers destroy live handles' registry refs
   today, and the reason it never crashed is two accidents of struct layout.
5. **F5** — say which line is load-bearing in `AsSharedTable`.
6. **F6b–f** — exception containment on the two GC bridges, the depth-0
   precondition, the `const` revert, the warning, the contract wording.

---

## Note on the trajectory

CR-14's clause was about mechanical checks: *a check has a predicate and a
universe, the universe is usually unwritten, and a check whose universe is
narrower than its class returns "clean" forever.* That was right, and the
universe CR-14 wrote down is why re-verifying its remediation took minutes.

CR-15 is the same idea moved one level out. Writing the universe fixes *where*
you look. It does not fix *what you are looking for*, and this pass's high
finding is entirely in that gap. The check asks "is the guard armed before the
dangerous operation" — and the set of dangerous operations was decided once, for
`reset()`, and never re-opened. `execute_script_async` sits in the same file,
does the same thing to the same object (takes the `lua_State` away from its
current holder), and was audited as a *reader*: the `CallScope` comment listed it
under "runs no user JS and touches no state a reset can invalidate", which is
true and beside the point. It is not a reader at all. It is the other writer.

> **A guard is defined by a pair — the hazard and the operations that create it
> — and only the hazard tends to get written down. When you harden an operation,
> ask what else does the same thing to the same object; the answer is rarely one
> thing, and the sibling you miss will be guarded by whatever it happened to
> inherit.** `reset()` accumulated three conditions across three passes; the
> sibling that needed all three had one, and the one it had was the only one
> that had ever been about the sibling.

Three second-order observations, each of which cost something:

**A one-directional guard reads as a bidirectional one.** `is_busy_` looks like
a mutual-exclusion flag and is used like one at 21 call sites, which is exactly
what makes the 22nd site invisible: the launcher *writes* the flag, so it looks
like a participant in the protocol rather than an unguarded operation. CR-1 H4
swept the read side exhaustively and the sweep held perfectly for fourteen
passes. Nothing about a complete sweep of one direction suggests the other
direction exists. **When a flag is written by one operation and read by many,
the writer is not covered by the protocol it establishes** — and it is the one
member of the set that no amount of auditing the readers will find.

**`reset()` stopped being only the guarded operation and nobody updated its
description.** Door (c) exists because reset() acquired a second half — the
replay phase, added incrementally as CR-9 F3 (searchers), CR-12 (shared tables)
and the print/hook re-arming each landed — that runs user JS against a live state
while the method's own documentation still described it as "the operation being
guarded". Every guard in the file trusted that description. The fix is one line,
and the reason it was missing for six passes is that the comment describing
reset() was accurate when written and nobody re-read it after the function grew.
**A function's classification is a claim with an expiry date, and the expiry is
whenever somebody appends to it.**

**An enumeration written as a remedy for decaying enumerations decayed
immediately.** CR-14 F5 recorded the `lua_next` residual as a two-member list and
closed with the instruction to check enumerations against generators rather than
memory. `grep -n lua_next` returns three traversals in the class. The missed one,
`TablePairs`, is not a marginal member — it runs a `lua_pcall` per value where
the two listed members intern a string and take a `luaL_ref`. And its own sibling
thirty lines below already implemented the fix, with a comment explaining the
reasoning for the neighbouring case. There is no cleverness required to have
caught this; there is only the difference between writing a list and running the
grep that produces it. **The instruction to use a generator has to be followed in
the same commit that writes the list, because that is the only moment when
whoever writes it still believes it might be wrong.**

Finally, the harness. All four sanitizer harnesses and 814 tests passed on the
tree containing F1 — the fourth consecutive pass where that sentence is true —
and this time the sanitizers were never going to help: a data race between the
main thread and a libuv worker is TSan's department, and `test-ts-tsan` cannot
see libuv/V8/Lua synchronization well enough for a clean run to mean anything.
What found F1 was a probe that asked one question of twenty-two entry points and
noticed that the twenty-second answered differently. CR-14's rule was *one test
per kind of user code × per site that can run it*. F1 suggests a third axis, and
it is cheap:

> **For every guarded resource, one probe per *direction*.** The suite has
> thorough coverage of "call X while an async run is in flight" — that is CR-1
> H4's legacy and it is why 21 of 21 doors refuse. It had nothing for "start an
> async run while X is on the stack", because the guard's name describes a state
> rather than a transition, and a state suggests only one question.
