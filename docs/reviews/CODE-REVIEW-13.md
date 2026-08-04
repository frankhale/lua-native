# CODE-REVIEW-13

**Date:** July 28, 2026
**Scope:** Thirteenth pass, against commit `8bf7018` — the CODE-REVIEW-12
remediation (`dc4891e`) plus a full re-read of both C++ layers, the async
worker, and — for the first time in this series — the public TypeScript surface
(`types.d.ts`) as a contract to be checked against the implementation rather
than as documentation to be read.

**Method:** CR-12 closed with a rule aimed at the reviewer: *"treat any comment
asserting completeness as a claim to be checked, not context to be read"*, and
the CR-12 remediation added a second: *"implement a recommendation before
believing it."* This pass applied both, and then asked the question they imply
about the reviewer's own instrument:

> Every pass since CR-9 has audited the reentrancy guard by asking **"is the
> guard armed before Lua runs?"** What happens if you instead ask **"is the
> guard armed before *user JS* runs?"**

Those are not the same question, and the second one is the one the guard
actually needs to answer, because JS is what can re-enter the binding. Asking it
produced this pass's high finding. Every finding below was driven to a
reproduction; where a consequence could not be driven, this review says so.

**Baseline:** 796 TypeScript and 283 C++ tests pass. Clean under `test-ts-asan`
(796/796), `test-cpp-asan` (283/283), `test-cpp-tsan` (283/283) and
`test-ts-tsan` (796/796). The high finding below is reproducible against that
clean baseline — a point the trajectory note returns to.

---

## Headline

**One high finding, and it is a class rather than a site.** `reset()` — the only
operation that can retire a `lua_State` out from under live references — is
correctly blocked while Lua is executing and while an async op is in flight. It
is *not* blocked while a binding method is running **user JavaScript before it
touches Lua**: a type converter, a definition-object getter, a Proxy trap. Seven
entry points were driven into that window; three of them do real damage,
including silent read/write access to unrelated live Lua objects and an
ASan-confirmed `heap-use-after-free` of the retired state.

The remaining findings are low: the `cancel()` contract is documented in three
places and wrong in all three (verified by probe), plus three nits.

The CR-12 remediation itself verifies clean, including an independent
re-derivation of the "can allocate from Lua" enumeration it recorded.

---

## Resolution status (July 28, 2026)

All findings resolved. After the fixes: **806 TypeScript tests** (up from 796 —
ten new CR-13 regression tests) and **283 C++ tests** (unchanged) pass, and all
four sanitizer harnesses are clean: `test-ts-asan` (806/806), `test-cpp-asan`
(283/283), `test-cpp-tsan` (283/283) and `test-ts-tsan` (806/806). The F1
reproduction that produced the `heap-use-after-free` above now refuses cleanly
under the ASan addon, with no sanitizer report.

**Eight of the ten new tests fail against the pre-fix binary** — the seven F1
doors and the message-distinction test. The two that pass either way are the F2
cancel pins, which is correct: F2 was a documentation defect, and the
timeout-only cancel test is the one that *disproves* the old claim, so it must
pass before and after.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | Fixed at the class level, as the finding recommended and in the form the prototype verified. `TableHandlePairs` gets the `CallScope` its eleven siblings have — closing the use-after-free and the silent cross-object reads/writes — and the sibling comment that argued it was unnecessary is corrected to say why raw traversal is not the test that matters. The other six doors move their `CallScope` **to the method's first line**, above every `def.Get()` / options read / argument conversion: `register_class`, `set_metatable`, `set_userdata`, `register_module`, `set_hook` (which had none, having "run no Lua"), the Lua-function handle call, plus `create_environment` (a member by inspection that the probe could not drive), `compile` / `compile_file` (their options reads can be accessors) and `CoroIteratorNext`. The now-redundant inner scopes were removed rather than left nested, so each method has exactly one and its position is the check. That check is then recorded where the invariant lives: the `CallScope` comment names the mechanical test (first scope vs. first `.Get(`/`.Call(`/conversion, per entry point) **and enumerates the six entry points that legitimately have user JS above their scope**, each with the reason it is inert — so a seventh is a regression rather than something the next reviewer has to re-derive. The three deliberate no-scope methods (`reset`, `cancel`, `is_busy`) are named too. The invariant is restated at `CallScope` itself as **"a binding method is on the stack, so JS may re-enter"**, explicitly *not* "Lua may be running", with the three deliberate exemptions named (`reset`, `cancel`, `is_busy`). `Reset()` now reports the two conditions separately — the old single message claimed Lua was executing in cases where no Lua was running at all, which is the confusion that produced the finding. Seven door pins plus a message-distinction pin. |
| F2 | ✅ Done | Corrected in all three places, in the direction the probes established: `types.d.ts` now documents both async families separately — `execute_async` is interruptible only while suspended awaiting a Promise, while a worker run *is* interruptible mid-loop whenever the count hook exists, which is when **any** of `maxInstructions`, `timeout`, or a counting `set_hook` is configured — and states the two real caveats the old text omitted (no limits configured means no hook and no cancellation; a synchronous `execute_script` is not reachable from `cancel()` at all). The `Cancel()` comment and DEFERRED **L8**'s resolution note carry the same correction, each recording what the old wording said so the drift is auditable. Two behavioural pins. |
| F3 | ✅ Done | **`next_userdata_id_`**: the review's own analysis said "widen the maps", but the id is stored *inside the Lua userdata block* as an `int`, so widening is a core-and-binding change rather than a one-liner. Range-checking it is both cheaper and strictly sufficient — the two increment sites are now the single `NextUserdataId()`, which throws instead of wrapping, converting UB into a clean JS error. The header records why the width stays. **The ERRMEM window**: recorded at the site rather than fixed, with the reasoning — `fn` joins `args` in a window that has always existed, and both alternatives (a second lookup, staging into C++ storage first) reintroduce hazards this file already closed. **`create_environment`**: guarded with the rest of its class, with a comment noting the probe bounded itself, not the hazard. The two release-time deferrals remain deferred by decision. |

The original findings follow unchanged for reference.

---

## Verification of the CODE-REVIEW-12 remediation

| CR-12 # | Verdict |
|---------|---------|
| F1 | ✅ Correct, and the placement is the part that matters. All three bridges take the owner as the first statement of the scoped block (`lua-runtime.cpp:1803`, `:908`, `:1701`) and never name the iterator again. The remediation deviated from the review's sketch for a real reason it recorded: a function-scope `shared_ptr` would be jumped over by the `lua_error` paths and leak a reference. One residual nit at F3 below — the copy is now live across the error-staging `lua_pushfstring`, which can itself raise `LUA_ERRMEM`. |
| F2 | ✅ Correct, and the invariant is now checkable rather than assertable. `grep -n 'lua_pushcclosure(.*LuaCallHostFunction' src/core/lua-runtime.cpp` returns exactly one hit, inside `PushHostFunctionClosure` — re-run this pass, still one. The comment states the grep, which is the right form for a completeness claim: the next reviewer verifies it in three seconds instead of re-deriving it. |
| F3 | ✅ Correct, and the enumeration holds under independent re-derivation. Rather than read the list recorded next to `IsExecuting()`, this pass regenerated it mechanically: strip comments, split `lua-runtime.cpp` by function, flag every allocating primitive, and bucket each function by whether it opens an `ExecutionScope`, runs inside a `RunProtected` thunk, or is a Lua C frame. Every allocating call lands in a declared bucket; the "unbracketed: nothing" line is true. Two spot-checks worth recording because they *look* like gaps and are not: `TablePairs` (`:3111`) has no scope and calls `lua_tolstring`, but only on keys already known to be strings, so nothing converts and nothing allocates — and `GetTableKeys` (`:2954`), which *does* stringify numeric keys, pushes a copy first and runs inside `RunProtected`. `GarbageCollectParam`'s scope-free asymmetry is documented and correct. |
| F4 | ✅ Correct, and the remediation's correction of the finding was itself correct. The review proposed guarding on `runtime->IsExecuting()`; the remediation rejected that because the async promise-settlement path stages from a microtask with no execution in flight, and used owner identity instead. Verified this pass: structured-error fidelity survives on all three staging paths — an ordinary callback, a `register_class` constructor, and an async promise rejection — and across a `reset()` (a custom `AppError` with `name`/`code` round-trips intact in all four). The CR-12 pin fails without the fix, as recorded. |
| F5 | ✅ Correct on all three, including the two corrections. Deleting `HasClass` rather than wiring it into `register_class` is right, and the header records the reason so the next pass does not re-propose it. The `Propagate` re-read is documented as a behaviour pin rather than a fix, which is the honest framing. The `uint64_t` widening round-trips through the `int64_t` Lua field and rejects a forged negative id before the cast. |

---

## Findings

### F1. `reset()` is legal while a binding method is running user JS — and the state it retires is still in use (high)

**The invariant, and where it stops.** `reset()` refuses to retire the state
when either of two things is true (`lua-native.cpp:3153`):

```cpp
if (runtime->IsExecuting() || call_depth_ > 0) { /* reject */ }
```

CR-9 established the first, and moved it into the core precisely so that a
binding method could not *forget* to arm it. The second, `call_depth_`, is
raised by `CallScope`, which every method opens **around its call into Lua**.
That placement is deliberate and, for the hazard CR-9 was chasing, correct.

But a binding method does not start at its Lua call. It starts by turning
JavaScript into something the core can accept — converting arguments through
registered type converters, reading a definition object's properties, converting
results back through the Lua→JS converters. **All of that is user JS, all of it
can call back into the binding, and none of it is inside either guard**: no Lua
is running yet, so `IsExecuting()` is false, and the `CallScope` has not been
opened yet.

So `reset()` runs. `runtime` is swapped, `alive_` is re-minted — and the method
resumes mid-flight, holding values, refs and pointers minted by the state that
no longer exists.

**Membership.** Every entry point was probed by making its first piece of user
JS call `lua.reset()` and recording whether the call was rejected:

| Entry point | user JS runs at | guard armed at | `reset()` mid-method |
|---|---|---|---|
| `handle.pairs()` | `lua-native.cpp:505` (result converters) | *never* | **runs** |
| `set_metatable(handle, def)` | `:1670` (`mt.GetPropertyNames`/`Get`) | `:1727` | **runs** |
| `register_class(name, def)` | `:1486` (`def.Get`) | `:1601` | **runs** |
| `set_userdata(name, obj, {methods})` | `:1355` (`methodsObj.Get`) | `:1384` | **runs** |
| `register_module(name, tbl)` | `:1786` (`moduleObj.GetPropertyNames`) | `:1832` | **runs** |
| `set_hook(cb, opts)` | `:3384` (options getters) | *never* | **runs** |
| Lua-function handle call | `:602` (argument converters) | `:612` | **runs** |
| `create_environment(list)` | `:2097` (`options.Has`/`Get`) | `:2131` | not reproduced |
| `execute_script` / `get_global` / `call` / `handle.get` / `handle.set` / `handle.ipairs` / `resume` | — | before the JS | rejected ✅ |

The last row is the control, and it is what makes this an enumeration failure
rather than a design choice: eleven of the twelve table-handle entry points and
every scripting entry point reject the reset. The pattern is right nearly
everywhere. It is the *placement rule* — "open the scope around the Lua call" —
that is one step short of the hazard.

**Door 1 — `handle.pairs()`: silent corruption of unrelated objects, then a
use-after-free.** `TableHandlePairs` (`:490`) is the only one of the twelve
table-handle entry points with no `CallScope` at all. Its neighbours carry the
comment explaining why they have one; this one carries the opposite:

> `// See TableHandleGet: CallScope — the ipairs collection respects __index (CR-8 F5). pairs() is raw traversal and needs none.`

That reasoning is sound about *Lua* — `lua_next` fires no metamethod — and it
misses that the scope's other job is to bound the window in which **JS** runs.
The conversion loop at `:502-509` calls `CoreToNapi` per key and per value (`:505`, `:507`),
which runs the registered Lua→JS converters.

When a converter calls `reset()` mid-loop, `CoreToNapiBuiltin`'s table-ref
branch (`:3918`) keeps building handles out of the *context's current* members:

```cpp
auto data = std::make_unique<LuaTableRefData>(runtime, v, this, alive_);
```

`runtime` and `alive_` are now the **new** generation; `v` carries a registry ref
minted in the **old** state. The result is a handle that passes every identity
check in the codebase — `data->runtime.get() == runtime.get()` is true, the
liveness flag is the current one — while addressing `LUA_REGISTRYINDEX[oldRef]`
in a registry that has never heard of it. A fresh state hands out the same low
ref ids, so the collision is not theoretical:

```
stale.marked   = null           <- the old-state object is gone
stale.victim   = 1              <- it is reading an unrelated live table
stale.secret   = LIVE-1
!! victim 1 clobbered through the stale handle -> CLOBBER
```

Reads and writes through the mis-bound handle land on someone else's live
object, silently, with no error anywhere.

The endgame is worse. `LuaTableRef`'s registry-owner deleter captured the **old**
`lua_State*`, while the handle's `shared_ptr` keeps the **new** runtime alive —
so nothing holds the old state up. When the handle is finalized, ASan reports:

```
==59736==ERROR: AddressSanitizer: heap-use-after-free on address 0x61b00000d800
READ of size 8 at 0x61b00000d800 thread T0
    #0 lua_core::detail::UnrefRegistrySlot(lua_State*, int) lua-runtime.cpp:782
    #1 lua_core::detail::MakeRegistryOwner(lua_State*, int)::'lambda'(void*)::operator() lua-runtime.h:61
    #8 lua_core::LuaTableRef::release() lua-runtime.h:172
    #9 LuaTableRefData::~LuaTableRefData() lua-native.h:95
   #11 LuaContext::CoreToNapiBuiltin(...)::$_0::operator()<LuaTableRef> lua-native.cpp:3923
freed by thread T0 here:
    #1 lua_core::LuaRuntime::LuaAllocator(...) lua-runtime.cpp:159
    #2 lua_core::LuaRuntime::~LuaRuntime() lua-runtime.cpp:571
```

Uninstrumented, the same run terminates the process at exit
(`mutex lock failed: Invalid argument` — `UnrefOrDefer` taking
`deferred_unref_mutex_` on a destroyed `LuaRuntime`). This is the H3/H5/CR-7 F1
class — a raw `lua_State*` outliving its owner — reached through a generation
boundary rather than through a retained handle.

**Door 2 — `set_metatable(handle, def)`: a metatable attached to an unrelated
live table.** The method resolves its target and checks it (`:1646`):

```cpp
if (targetRef->runtime.get() != runtime.get()) { /* different context */ }
```

then reads the definition object (`:1670` onward, one `mt.Get(key)` per key, any
of which may be a getter or a Proxy trap), then calls (`:1729`):

```cpp
runtime->SetTableRefMetatable(targetRef->tableRef.ref, entries);
```

`runtime` is re-read at the call; `targetRef->tableRef.ref` is not. A getter that
resets makes the identity check above it stale, and the pair becomes
`new runtime + old ref` — the same mis-binding as door 1, except this one
*writes*. Driven, with the fresh registry repopulated from inside the getter so
the old ref id names a live table:

```
set_metatable: ok
!! victim 0 acquired a foreign metatable -> FOREIGN-__index
```

An unrelated table, created after the reset and owned by other code, silently
acquired the caller's `__index`. Without the repopulation the core's type check
catches it (`"table reference does not name a table"`) — so this door fails
closed only by luck of registry layout.

**Door 3 — `register_class(name, def)`: the L7 duplicate guard defeated.**
`registered_classes_.insert(class_name)` at `:1475` reserves the name *before*
any property read, with a `ReservationGuard` to roll it back — a fix made
deliberately (CR-6 F5) against exactly this threat model, hostile getters.
`reset()` clears `registered_classes_` wholesale (`:3221`), so the reservation
evaporates and the guard is disarmed for the rest of the process:

```
reset from a def getter: RESET RAN
second register_class("Foo"): ACCEPTED (duplicate guard defeated)
Foo.new():get()   -> attempt to call a nil value (method 'get')
Foo.new():other() -> 9
```

That is the L7 hazard verbatim: `luaL_newmetatable` silently returns the
existing metatable, the method table is replaced, and the class is a half-merge
of two definitions. No memory unsafety — but the guard that exists to prevent
precisely this outcome reports success.

**Doors 4–7** (`set_userdata`, `register_module`, `set_hook`, the Lua-function
handle call) admit the reset but were not driven to damage. They are listed
because they are members of the class, and because CR-9's clause applies:
*an unswept gap's severity is set by code that has not been written yet.* The
handle-call door is the one to watch — its argument conversion mints nested
callbacks on the **new** runtime while the call itself runs against the **old**
one, so a function passed as an argument becomes unreachable from the closure
that receives it.

**Recommendation.** Two levels, both implemented and verified before being
recommended:

1. **Site fix, one line.** Give `TableHandlePairs` the `CallScope` its eleven
   siblings have. Verified: the probe flips from `RESET RAN` to the rejection
   message, and the full suite still passes. This also closes a second, smaller
   thing — `docs/CODE-REVIEW-LEDGER.md`'s **L7** records its own resolution as
   covering "table traps", and `pairs()` is a handle *method*, so a staged
   `js_error_registry_` entry from a raising converter still accumulates there.

2. **Class fix: arm the guard at method entry, not at the Lua call.** Move each
   method's `CallScope` to its first line, above the first property read or
   conversion. Prototyped for the two definition-snapshot doors: all three
   harmful probes flip to the rejection message, `register_class`'s duplicate
   guard holds, the resulting class is intact, and 796/796 TS tests still pass.
   Nesting is depth-counted, so a method that re-enters another (SharedTable's
   push → `set_global`) is unaffected, and moving the outermost-entry
   `js_error_registry_` clear earlier is harmless.

   State the invariant as **"a binding method is on the stack, so JS may
   re-enter"** rather than "Lua may be running". They are different facts and
   `reset()` needs both. A grep for `CallScope` that does not appear within the
   first few lines of a public method then becomes the check — the same shape as
   F2's one-hit grep, which is why that one works.

The deeper version — a counter maintained by the conversion funnels themselves,
the way the core owns `ExecutionScope` — was considered and is **not**
sufficient on its own: five of the seven doors run their user JS through
`Napi::Object::Get`, not through `CoreToNapi`/`NapiToCoreImpl`, so a funnel-only
guard would leave `register_class`, `set_metatable`, `set_userdata`,
`register_module` and `set_hook` open.
Entry-armed scoping covers both shapes.

### F2. `cancel()`'s contract is documented in three places and is wrong in all three (low)

`types.d.ts:712-719` is what users read:

> Cancels an in-flight `execute_async` run. […] No-op if nothing is running.
> Because JavaScript is single-threaded, this can only take effect while the
> script is suspended awaiting a Promise (not during a synchronous Lua loop).

The implementation (`lua-native.cpp:3002-3028`) has a second branch, added by
the deferred item **L8**, that cancels a *worker-thread* run — and it does so
precisely **during a synchronous Lua loop**, via the count hook. So the sentence
that reads as a caveat is, for the worker path, the exact opposite of the
behaviour. The worker path is not mentioned at all.

The C++ comment at that branch, and L8's resolution note, both add a second
claim:

> `// This therefore only takes effect when maxInstructions is set — the hook exists only then.`

`InstallExecutionHook` (`lua-runtime.cpp:299`) installs `LUA_MASKCOUNT` for
**three** consumers: `max_instructions_ > 0`, *or* `timeout_ms_ > 0`, *or* a
debug hook that asked for a count interval. The hook checks cancellation first,
before either limit. Driven:

| Probe | Result |
|---|---|
| worker run, `timeout` set, no `maxInstructions`, then `cancel()` | **rejects with `"execution cancelled"`** — the claim is false |
| worker run, no limits at all, then `cancel()` | runs to completion (undocumented, and the real caveat) |
| `cancel()` from a host callback during a *synchronous* `execute_script`, `maxInstructions` set | silent no-op — the hook is installed and would honour the flag; `Cancel()`'s `else if (is_busy_)` simply never reaches it |
| `cancel()` while idle, then a normal call | clean — the flag is not left set |

Three separate documents, one mechanism, and the mechanism is more capable than
any of them says. Worth fixing as documentation; the third row is arguably a
capability gap with a two-line fix, but making a synchronous run cancellable
from inside its own callback is a design decision, not a defect — and it would
need the flag cleared on the synchronous path, which nothing does today.

### F3. Nits

- **The bridges' owner copy is now live across a raise-capable staging call.**
  CR-12 F1 moved `const std::shared_ptr<Function> fn = it->second;` above the
  argument-conversion loop, which is correct for the iterator hazard. It also
  puts `fn` in scope across the `lua_pushfstring` calls that stage the error
  messages, and `lua_pushfstring` allocates — so under an exhausted `maxMemory`
  it can raise `LUA_ERRMEM` and longjmp past `~shared_ptr`, leaking a reference
  (and with it the JS callback). This is not new in kind: `args`, a
  `std::vector<LuaPtr>`, has always been live in the same window, and the whole
  `HostCallOutcome` structure exists because of it. It is one more object in an
  already-known window, recorded so the ledger is accurate rather than because
  it changes the risk.
- **`next_userdata_id_` is still `int`** (`lua-native.h:422`). CR-12 F5 widened
  its five siblings and justified leaving this one on the grounds that it keys
  the int-based userdata maps. That is a reason to widen the maps, not a reason
  to keep a signed counter that is UB on overflow; the same "long-lived server"
  argument that justified widening `next_js_error_id_` applies to a process that
  calls `set_userdata` per request.
- **`create_environment` did not reproduce.** Its whitelist read is a member of
  the F1 class by inspection, but the Proxy-trap probe did not trip it. Reported
  as *not reproduced*, not as *safe* — the distinction CR-12 asked for.
- **Two release-time deferrals re-confirmed unchanged.**
  `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` (`binding.gyp:142`, `:306`, CR-3
  M5) and `prebuilds/` still contains `darwin-arm64` only (CR-5 F8). Deferred by
  decision; listed so the ledger stays honest.

---

## Verified and rejected (adversarial suspicions that held up)

- **Worker-thread writes to non-atomic runtime state.** `ExecuteScript` runs on
  the libuv worker and opens an `ExecutionScope`, so `lua_depth_`,
  `instruction_count_` and `deadline_` — all plain members — are written
  off-thread. Every main-thread reader is behind `is_busy_`, which is set
  synchronously *before* `Queue()` and cleared in `OnOK`/`OnError`; `reset()`
  calls `RejectIfBusy()` before it reads `IsExecuting()`. The one main-thread
  entry point that deliberately runs during a worker run, `cancel()`, touches
  only the atomic `cancel_requested_`. Main-thread GC finalizers reach the
  registry only through `UnrefOrDefer`, which is mutex-guarded and queues while
  a worker is active (H9c). No race found; `test-cpp-tsan` and `test-ts-tsan`
  agree, with the standing caveat that TSan cannot see libuv/V8/Lua
  synchronization.
- **The proxy-userdata property setter's evaluation order.**
  `it->second.object.Value().Set(key, CoreToNapi(*value))` dereferences a map
  iterator in the same full-expression that runs user JS (`CoreToNapi` fires the
  Lua→JS converters, which can register a userdata and rehash `js_userdata_`).
  Safe: C++17 sequences the postfix-expression of a member call before its
  arguments, so the handle is materialized before the converter runs. This is
  the CR-11 F5 discipline satisfied by the language rather than by the code —
  worth a comment, since a later refactor to a local temporary in the wrong
  order would silently break it.
- **`release()` after a mid-call reset.** `Release`'s `obj.Has`/`obj.Get` can run
  Proxy traps on a user-supplied object, so it is nominally in the F1 class. It
  fails closed: the `data->runtime.get() != runtime.get()` check runs *after* the
  reads and rejects the now-foreign handle rather than unref'ing into the wrong
  registry.
- **`pcall()`.** Runs arbitrary JS with no `CallScope`, but touches no runtime
  state afterwards — it only packages the result. Not a member of the class.
- **Table handles across a `reset()`.** `RejectIfWorkerBusy` checks the
  re-minted `alive_`, so a pre-reset handle fails cleanly ("context has been
  destroyed"). The documented invalidation contract holds; F1's handles are
  dangerous precisely because they are minted *after* the swap and so carry the
  current flag.
- **Structured-error fidelity after CR-12 F4.** The `owner`-identity guard could
  plausibly have suppressed legitimate staging. It does not: a custom `AppError`
  with `name` and `code` round-trips through an ordinary callback, a class
  constructor, an async promise rejection, and a post-`reset()` callback.
- **The registry-owner deleter's extra-space lookup.** `UnrefRegistrySlot`
  resolving the runtime from `lua_getextraspace` rather than the registry is
  correct and lock-free by design — the only way it misbehaves is when the state
  itself has been retired, which is F1's endgame rather than a defect in the
  deleter.
- **CR-12 F2's routing of `RegisterClass` through the shared closure builder.**
  The suspicion was a stack-depth or ordering change: `PushHostFunctionClosure`
  pushes a transient registry lookup and possibly a sentinel where the old code
  pushed one string. Net stack effect is identical (+1), the absolute `mt_idx`
  and the `lua_settable(L_, -3)` below it are unaffected, and the sentinel branch
  is unreachable for class and `set_global` names because neither is ever
  reserved reclaimable.

---

## Suggested priority order

1. **F1, site fix** — one `CallScope` in `TableHandlePairs`. Closes the
   ASan-confirmed use-after-free and the silent cross-object corruption.
   Verified.
2. **F1, class fix** — move every public method's `CallScope` to its first line
   and restate the invariant as "a binding method is on the stack". Verified on
   the two definition-snapshot doors; the rest is mechanical. Add one pin per
   door, since three of them are one-line regressions away from returning.
3. **F2** — correct `types.d.ts`, the `Cancel()` comment, and L8's resolution
   note to say what the mechanism does: cancellable whenever the count hook is
   installed (`maxInstructions` **or** `timeout` **or** a counting debug hook),
   not cancellable otherwise, and not reachable from inside a synchronous run.
4. **F3** — the nits.

---

## Note on the trajectory

CR-12 reported nothing above low and argued, correctly and against its own
interest, that this measured the *diff* rather than the *tree*:

> The right reading of CR-12 is therefore "the CR-11 remediation is sound", not
> "the tree is correct."

CR-13 is the evidence for that sentence. The CR-12 remediation is sound — every
one of its five fixes verifies, including under an independent re-derivation of
the enumeration it recorded. And the tree contains an ASan-confirmed
use-after-free reachable from three public entry points, none of which the CR-12
diff touched. A pass scoped to the diff could not have found it, and a pass that
inherited CR-12's headline would not have looked.

**What actually found it was changing one word in the question.** Nine passes
have audited this guard by asking whether it is armed before *Lua* runs. It
always is — CR-9 made that structurally true by moving the fact into the core,
and that fix has held for four passes. The guard's *other* half was never
relocated: `call_depth_`, the flag that says "a binding method is on the stack,
so JS may re-enter", is still armed by hand, at each site, at a point chosen for
the Lua call. And it decayed in exactly the way CR-9 predicted for
hand-armed guards — not everywhere, but in one method out of twelve, and at the
wrong end of five others.

So the clause this pass adds is about where to point an existing lens:

> **A reentrancy guard must be armed above the first line that can run
> *attacker-or-application code*, not above the first line that can run the
> thing the guard is named after.** For a JS↔native boundary those differ by the
> whole argument-conversion and definition-reading phase, which is where the
> host's own extension points — type converters, property getters, Proxy traps —
> all live.

Three second-order observations, recorded because each cost something:

**The comment that justifies an omission deserves more scrutiny than the one
that justifies a fix.** `TableHandlePairs` does not lack a `CallScope` by
oversight; it lacks one by argument — *"pairs() is raw traversal and needs
none"* — and that argument is correct about the metamethod hazard it names and
silent about the JS hazard it does not. Every prior pass read it and agreed.
A comment explaining why a sibling's guard is *unnecessary here* is a
completeness claim wearing different clothes, and CR-12's rule should be
extended to cover it.

**The identity checks that protect against foreign references all share a
failure mode.** `targetRef->runtime.get() != runtime.get()`,
`threadData->runtime.get() != runtime.get()`, `data->runtime.get() !=
runtime.get()` — each compares a captured pointer against a member that
user JS can change between the check and the use. They are correct against the
threat they were written for (a handle from *another* context) and blind to the
same context becoming a different generation. Where these appear, the check and
the use should be adjacent, or the guard should make the change impossible; the
F1 class fix does the latter for all of them at once.

**The harness found nothing again, and again that is the warning.** All four
sanitizer runs and 796 tests pass on the tree that contains F1. ASan reported
the use-after-free within seconds of a reproduction existing — and had no way to
invent one, because no test in the suite calls `reset()` from inside a converter
or a getter. CR-10's standing recommendation ("for every piece of state that
bridges the two layers, one test that leaves it *in use* at destruction time")
now has a sibling worth adding to the suite as a category:

> **For every guard, one test that calls the guarded operation from inside each
> kind of user code the surrounding method can run** — a converter, a definition
> getter, a Proxy trap, a metamethod, a finalizer. The guard is only as good as
> the callback shapes someone thought to try.
