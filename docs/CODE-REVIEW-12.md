# CODE-REVIEW-12

**Date:** July 28, 2026
**Scope:** Twelfth pass, against the CODE-REVIEW-11 remediation (working tree on
top of `076e9e4`), plus a full re-read of both C++ layers. This is the smallest
window in the series: the diff under review is `+926 / -149` across four source
files, and all of it is CR-11 remediation — the `shared_ptr<Function>`
host-function map, the three bridges that copy the owner before invoking, the
restored indexed converter loops, `PushHostFunctionClosure`,
`ReserveReclaimableHostFunction`, the `ud_method_fns_` lifetime, five new
`ExecutionScope`s, and three `unique_ptr` conversions.

**Method:** The remediation is the target. CR-11's own closing addendum named
two failure modes — *a fix undone by a later commit*, and *a fix whose class was
named but whose members were miscounted* — so this pass audited the CR-11 fixes
against exactly those two lenses, plus a third: **does the fix hold when the
thing it protects is superseded *from inside itself*?** Every CR-11 finding was
re-reproduced against the fixed tree; the new reclaim paths were then driven
under an adversarial and a stress harness (40 rounds × 25 supersessions of
metatables, modules and userdata, interleaved with `gc('step')`, `gc('collect')`,
live table handles and periodic `reset()`), all under the ASan+UBSan-instrumented
addon. Where a finding could not be driven to failure, this review says so
explicitly rather than asserting it.

**Baseline:** 792 TypeScript and 283 C++ tests pass. Clean under
`test-ts-asan` (792/792, no sanitizer report), `test-cpp-asan` (283/283) and
`test-cpp-tsan` (283/283, 0 races).

---

## Headline

**No high or medium findings.** Every CR-11 fix is correct, complete at the sites
it names, and survives the adversarial and stress harnesses. The five findings
below are all **low**: three are completeness/enumeration items whose present
consequence is nil, one is a latent cross-generation state leak with no reachable
consumer, and one is a re-entrancy ordering wart. Two long-standing release-time
deferrals were re-confirmed unchanged.

`CODE-REVIEW-THOUGHTS.md` defines convergence as *"findings have collapsed to
new-code and judgment calls, and no previously-identified class has
reappeared."* This pass is the first that meets that definition on both halves,
and the honest thing to do is say so rather than manufacture severity. The
caveat is in the trajectory note at the end: two of CR-11's five findings were
*reintroductions*, so "no class reappeared this pass" is a weaker claim than it
looks.

---

## Verification of the CODE-REVIEW-11 remediation

| CR-11 # | Verdict |
|---------|---------|
| F1 | ✅ Correct. Both loops are indexed again (`lua-native.cpp:3654`, `:3725`), each carrying a `// NOLINTNEXTLINE(modernize-loop-convert)` — which is the part that makes the fix survive the next modernization pass, and the part CR-2's version lacked. Both reproductions run clean under ASan. The comments now distinguish protecting the *operands* (copying the handles) from protecting the *cursor* (indexing), which is the distinction the old wording elided and the reason three passes read it approvingly. |
| F2 | ✅ Correct, and it holds under the sharper test. `host_functions_` is `unordered_map<string, shared_ptr<Function>>`; all three bridges copy the owner before invoking. Re-verified the ASan reproduction (clean), and confirmed the semantics are the right ones: the in-flight call completes against the callable it started with, the replacement takes effect from the next call. Also verified the harder variants — a metatable replaced from inside its own `__index`, a module re-registered from inside its own function, a userdata replaced from inside its own method — all return `first,second` and are ASan-clean. One residual, low: the *iterator* is still held across the argument conversion (F1 below). |
| F3 | ✅ Correct at the sites it names. Five new scopes verified in place; the C++ pins fail without them. `GarbageCollectParam`'s comment is accurate again now that `incremental`/`generational` are bracketed, and `SetTimeout` records the non-interruptible-finalizer fact. Two allocating calls remain outside a scope on error paths (F3 below), neither of which I could drive. |
| F4 | ✅ Correct, and the mechanism is the right one. Routing the metatable/module builders through `PushHostFunctionClosure` and reserving the names before the core call preserves the CR-8 F3 ordering exactly — nothing enters `host_functions_`/`js_callbacks_` until the core call succeeds — while still letting the closure carry a sentinel. I specifically checked the failure interleavings: a core call that throws after pushing entry 1 but before entry 2 leaves entry 2 at count 0 (swept by the collector) and entry 1 at count 1 (self-cleaning when its orphaned sentinel is collected). Measured 40/40 → 1/40 pinned, and the stress harness holds `_G` metatables, modules and userdata correct across 1,000 supersessions with GC interleaved. `register_class` correctly left permanent. |
| F5 | ✅ Correct. The three `unique_ptr` conversions release ownership at the External rather than after `DefineHiddenProp`. `~LuaRuntime` now clears all five bridging handlers. The binding's held iterators are gone. One residual: the core's equivalents were not swept (F1 below), and the helper-unification comment overstates its own reach (F2 below). |

**Stress and adversarial results** (all under the ASan+UBSan addon):

| Harness | Result |
|---|---|
| Metatable replaced from inside its own `__index` | `first,second` — correct, clean |
| Module re-registered from inside its own function | `first,second` — correct, clean |
| Userdata replaced from inside its own method | `first,second` — correct, clean |
| `host_functions_` mutated by a `__gc` finalizer during a host call's argument conversion | survives, clean |
| 200 module supersessions with a live table handle across them | correct, clean |
| 40 rounds × 25 supersessions of all three kinds + `gc('step')`/`gc('collect')`/handles/`reset()` | clean |

---

## Findings

### F1. The core's host-call bridges still hold the map iterator across the argument conversion (low)

CR-11 F5 identified this shape and fixed it in the binding:

> Both wrappers do `auto cbIt = js_callbacks_.find(name)` and then
> `cbIt->second.Call(jsArgs)`. A nested registration during that call can rehash
> the map, which invalidates iterators though not references.

The binding was fixed. The core's three bridges — which have the *same* shape,
over the *same* kind of container, with a *larger* window — were not:

| Bridge | `find()` | first use of `it` | what runs in between |
|---|---|---|---|
| `LuaCallHostFunction` | `lua-runtime.cpp:1792` | `:1825` | the whole `ToLuaValue` argument loop (`:1811`) |
| `UserdataMethodCall` | `:892` | `:928` | the whole `ToLuaValue` argument loop |
| `JsSearcher` | `:1695` | `:1711` | nothing that allocates |

`ToLuaValue` performs `luaL_ref` for every function, thread, userdata and
metatabled table argument, and allocates a Lua string for numeric keys. Any of
those can drive a GC step; a `__gc` finalizer is Lua; that Lua can call a JS
callback that calls `set_global('n', fn)`; and `RegisterFunction` *inserts* into
`host_functions_`, which is what triggers a rehash. So the window is real and
reachable — this is the CR-11 F3 "can allocate from Lua" reasoning applied to a
C++ container rather than to the Lua state.

**Calibration: low, and I could not make it fail.** Both libc++ and the MSVC STL
implement `unordered_map` with separately-allocated nodes that a rehash relinks
rather than moves, so `it->second` reads a live node afterwards; only iterator
*traversal* would misbehave, and none of the three bridges traverses. The
adversarial harness above drives exactly this interleaving (a finalizer
registering a global while a host call converts a 20,000-key table argument) and
is clean under ASan. It is formally undefined behaviour with no known platform
where it bites.

It is reported anyway for one reason: it is the unswept half of a fix CR-11 made
one file away, and the fix costs one line.

**Recommendation.** Take the owner immediately after the end-check, before
anything else runs, and stop naming `it` afterwards:

```cpp
const auto it = runtime->host_functions_.find(name);
if (it == runtime->host_functions_.end()) { /* raise */ }
const std::shared_ptr<Function> fn = it->second;   // it is dead from here
```

Apply to all three, including `JsSearcher` — its window is empty today, but
"empty today" is the property that changes silently.

### F2. `PushHostFunctionClosure` is not the single closure builder its comment claims (low)

CR-11 F4 factored the reclaim accounting into one helper so that every closure
built over a host-function name would pick it up, and documented it as such:

```cpp
// The single place a host-function name becomes a Lua closure. Public so the
// metatable / module / searcher builders share the reclaim accounting rather
// than each pushing its own bare lua_pushcclosure (CR-11 F4).
```

Three sites still push their own:

| Site | Line | Name family | Reclaimable today? |
|---|---|---|---|
| `RegisterClass`, metamethod loop | `lua-runtime.cpp:1067` | `__class_mm_<id>_<key>` | no |
| `RegisterClass`, the class `new` | `:1117` | `__class_ctor_<id>` | no |
| `RegisterFunction` | `:2414` | user-chosen (`set_global`) | no |

**Present consequence: none.** None of those three name families is ever
reserved as reclaimable, so `PushHostFunctionClosure` would build the identical
one-upvalue closure for them. `RegisterClass`'s omission is even deliberate in
spirit — CR-11 explicitly decided class registrations are permanent because
`registered_classes_` forbids superseding them.

**Why it is worth a finding anyway.** This is an enumeration error committed
inside the fix for an enumeration error, in the same commit whose review
addendum reads *"when a fix names a class, write the full member list down at the
class's home."* The comment asserts a completeness property that the code does
not have, which is precisely the failure mode CR-11 F1 was about — a comment
that describes intent while the code does something else, with three review
passes reading the comment. If any of those name families is ever made
reclaimable, it will silently never be reclaimed, and the comment will say it is.

**Recommendation.** Route all three through the helper. For non-reclaimable
names it is a no-op by construction (the `reclaimable_host_fns_.count(name)`
probe fails and it pushes the same one-upvalue closure), so the change is
behaviour-preserving and makes the comment true. If `RegisterClass` is instead
left deliberate, say so at those two lines and narrow the helper's comment to
"every closure over a name that may be reclaimable."

### F3. Two allocating calls remain outside any `ExecutionScope`, both on error paths (low)

CR-11 F3 swept the success paths. A full re-enumeration of the core against the
"can allocate from Lua" rule finds exactly two remaining sites, both reached only
when an execution has already failed:

| Site | Call | Why it allocates |
|---|---|---|
| `CaptureError` (`lua-runtime.cpp:2170`) | `lua_pushstring(L, "message")` | interns the key string when probing a table error object |
| `ResumeAsyncStep` error branch (`:3541`) | `luaL_traceback(co, co, m, 1)` | builds the whole traceback string |

`ResumeAsyncStep` is the more exposed of the two: `DriveAsync` opens no
`CallScope`, so only `is_busy_` guards that path at all.

**Neither could be driven.** Probes compiled into the C++ test binary — 4,000
pending finalizable objects, then a coroutine erroring with a 500 KB message so
`luaL_traceback` copies half a megabyte, and separately a table error object to
force `CaptureError`'s key push — observed **zero** finalizers running at either
site. `"message"` is a short string Lua has almost always already interned, and
the traceback's allocation did not move the collector's debt far enough to take a
step with the objects that remained. So this is an inspection finding, not a
reproduction.

**What is worth having is the enumeration.** Every other allocating path in the
core is now accounted for, which lets the class be *closed* rather than moved
again:

- bracketed: the seven chunk loaders; both `lua_resume` sites; all three argument
  stagings; `RunProtected`, `ProtectedTableCall`, `PushProtectedGlobal`,
  `ToLuaValueProtected`; `lua_gc`'s four collecting commands; `HasClass`;
  `CaptureError`'s `__tostring` pcall.
- correct without a scope, by construction: everything reached from inside a Lua
  C frame (the bridges, `LuaPrint`/`LuaIoWrite`, `JsSearcher`, the userdata and
  class metamethods, `MessageHandler`, `AsyncContinuation`, the debug hook);
  everything inside a `RunProtected` thunk; `PushLuaValueProtected` (documented
  static precondition); the constructor's `InitState` and library opening, where
  the state is fresh and no finalizable object can exist yet; and the non-allocating
  reads (`lua_rawgeti`, `lua_next`, `lua_sethook`, `luaL_unref`, `lua_setupvalue`).
- **unbracketed: the two above, and nothing else.**

**Recommendation.** Bracket both — two lines — and record the enumeration next to
`IsExecuting()` so the next pass can verify the class is closed by reading one
list instead of re-deriving it.

### F4. A retired state's finalizer stages its error onto the live runtime (low)

`reset()` deliberately lets the retiring runtime's `__gc` finalizers reach the
still-live context — CR-10 pinned that with a control test, because the alternative
breaks the documented `reset()` contract. Confirmed working:

```js
lua.execute_script(`_G.keep = setmetatable({}, { __gc = function() boom() end })`);
let handle = lua.create_table({ a: 1 });   // keeps the retiring runtime alive
lua.reset();                                // calls = []
handle = null; await gcSettle();            // calls = ["boom"]   <- the finalizer ran
```

The wrapper it reaches captures the *context*, so when the callback throws,
`StageJsError` runs `runtime->SetPendingErrorValue(...)` — and `runtime` is the
context's member, which after the reset points at the **new** runtime. The raise,
meanwhile, happens on the **old** one. So:

- the old runtime's `LuaCallHostFunction` sees `HasPendingErrorValue() == false`
  on its own state and pushes the plain message — correct for the finalizer;
- the new runtime is left holding a `pending_error_value_` that belongs to an
  execution on a different Lua state, plus a `js_error_registry_` entry.

This is the M12 hazard — a staged value stranded for a later, unrelated host call
to mis-raise — reached through generations rather than through the searcher.

**Calibration: low, and bounded by an invariant elsewhere.** I could not
construct a consumer. `pending_error_value_` is only consulted by the three
bridges' catch blocks, and reaching one of them *without* staging requires
`js_callbacks_` and `host_functions_` to be out of sync for a name — which every
path deliberately prevents (the GC callback, the sweep, and the rollback paths all
erase from both, or neither). The staged value is also pure C++ data (strings and
an int), so it carries no cross-state registry reference. The observable residue
is one stranded map entry until the next outermost `CallScope`.

**Recommendation.** The cheap, precedented fix: have the wrapper drop a staged
value it cannot deliver, the way `JsSearcher` already does for M12 —
or, more precisely, have `StageJsError` no-op when
`runtime->IsExecuting()` is false on the context's *current* runtime, which is
the condition that distinguishes "a finalizer of a retired state" from every
normal call. A comment at `StageJsError` recording that its `runtime` may not be
the state currently raising would be the minimum.

### F5. Nits

- **`SharedTable::Propagate` re-enters and the outer loop then applies the older
  value** (`lua-native.cpp:686`). The subscriber list is snapshotted before any
  user JS runs — that part is careful and is the model F1 of CR-11 was fixed
  toward — but the *value* is read once, before the push loop. A push runs user
  JS (a type converter, a `__newindex` on the target global) which can call
  `set()` or `sync()` re-entrantly; the inner `Propagate` updates every
  subscriber, and the outer loop then continues writing the stale value to its
  remaining targets. No memory unsafety, and the JS-side value is correct
  afterwards; the anomaly is that some contexts end up one generation behind
  with no error reported. Re-reading `value_.Value()` per target, or a simple
  in-progress flag, closes it.
- **`HasClass` has no callers.** CR-11 F3 gave it an `ExecutionScope` on the
  strength of its registry-key allocation; that is the right treatment for a
  public core method, but the method is dead code today. Either wire it into
  `register_class`'s duplicate check (which currently uses the binding-side
  `registered_classes_` only, and so cannot see a class registered on a state the
  binding did not mint) or delete it.
- **`next_js_error_id_` is `int` and monotonic** (`lua-native.h:427`). Its
  siblings (`next_metatable_id_`, `next_module_id_`, `next_class_id_`,
  `next_searcher_id_`, `next_js_callback_id_`) were widened to `uint64_t`
  explicitly "to avoid overflow"; this one and `next_userdata_id_` stayed `int`.
  `next_userdata_id_` is documented as needing to stay `int` because it keys the
  int-based userdata maps; `next_js_error_id_` has no such constraint and keys a
  map that is cleared at every outermost call. Signed overflow is UB, and a
  long-lived server with a throwing callback per request is the shape that
  reaches 2³¹. One-line widening.
- **Two release-time deferrals re-confirmed unchanged.** `MACOSX_DEPLOYMENT_TARGET`
  is still `"26.0"` at `binding.gyp:142` and `:306` (CR-3 M5 — this pins a
  published addon to macOS 26+ and is recorded in `docs/RELEASING.md` as a
  blocker), and `prebuilds/` still contains `darwin-arm64` only (CR-5 F8). Both
  remain deferred by decision; listed so the ledger stays honest, not as new
  findings.

---

## Verified and rejected (adversarial suspicions that held up)

- **The reserve-before-core-call ordering (CR-11 F4).** The suspicion was that
  moving *anything* ahead of the core call reintroduces CR-8 F3 stranding. It
  does not: `ReserveReclaimableHostFunction` touches only
  `reclaimable_host_fns_`, never `host_functions_` or `js_callbacks_`, and the
  enclosing `JsCallbackCollectorScope` sweeps a count-0 reservation on every
  failure exit. Re-verified the CR-8 F3 behaviour explicitly (a failed
  `set_metatable` still strands nothing) and traced the partial-failure
  interleaving by hand.
- **The `PushHostFunctionClosure` re-find.** The `reclaimable_host_fns_.find`
  after the sentinel allocations exists because a GC step inside them can erase
  the entry. For a *freshly reserved* name that cannot happen — the entry is at
  count 0, so no sentinel exists to fire `OnHostFnClosureCollected`, and
  `EraseReclaimableIfUnpushed` only runs at collector-scope exit. The re-find is
  correct for the `__js_callback_<n>` case it was written for and harmless for
  the new one.
- **Reclaiming a metamethod whose closure is executing.** Superseding a metatable
  from inside its own `__index` makes the old closure garbage — but it is the
  running Lua function, hence on the call stack, hence reachable, so its sentinel
  cannot fire mid-call. Same argument for a userdata replaced from inside its own
  method (`self` is stack slot 1). Both driven under ASan; both clean.
- **`ud_method_fns_` erasure during a method call.** The erase path runs from the
  userdata GC callback, which requires that userdata's refcount to hit zero — it
  cannot while one of its methods is executing.
- **`js_callbacks_.erase` during a call to another callback.** Now safe by
  construction: both wrappers materialize the `Napi::Function` before any user JS
  runs, so the handle outlives the reference's destruction (CR-11 F5).
- **Off-thread writers to `lua_depth_`.** CR-11 added `ExecutionScope`s to
  `CallFunction`, `ResumeCoroutine`, `ResumeAsyncStep` and `HasClass`; none is
  reachable from the worker thread, which calls only `ExecuteScript`/`ExecuteFile`.
  CR-10's analysis is unchanged, and `test-cpp-tsan` reports 0 races.
- **The double `BeginExecutionBudget` on the staging paths.** The staging scope
  and the call/resume scope each start a budget at depth 0. Harmless: the second
  is the one that bounds the run, and a nested entry (a host callback re-entering)
  correctly does not restart either.
- **`SafeLoad` with fewer arguments than it forwards.** `load()` with no
  arguments makes `lua_pushvalue(L, 1)` address a slot above the top, which Lua
  resolves to nil rather than reading garbage; the wrapped `load` then reports
  `bad argument #1 (function expected, got no value)`. Verified for zero-, one-
  and four-argument calls, and that binary chunks are still rejected with
  `attempt to load a binary chunk (mode is 't')`.
- **`__luaClassOwner` identity after a `reset()` that reuses the old runtime's
  address.** Defended by the monotonic id counters, which `reset()` deliberately
  does not reset: even if a new runtime lands at the same address and a stale
  marker compares equal, `js_userdata_.find(stale_ref_id)` cannot hit. The
  `_tableRef` and `_userdata` markers are stronger still — their `*Data` holds a
  `shared_ptr<LuaRuntime>`, so the address cannot be reused while the handle
  lives.
- **`PushTableKey`'s numeric coercion** (`"007"` and `"7"` addressing the same
  integer key through the Proxy). Documented behaviour, and the `TableKey`
  overloads used by `handle.get`/`set`/`has` preserve genuine string keys — which
  is exactly the split CR-1 M9 introduced.
- **A `std::bad_alloc` from the sentinel's `new std::string`** inside a
  `RunProtected` thunk. Captured by `ProtectedThunkRunner` and rethrown after the
  frame unwinds; the sentinel is left inert with the count untouched, so the
  accounting stays balanced (the N1 discipline, which the factored helper
  preserved verbatim).

---

## Suggested priority order

1. **F1** — take the owner immediately at lookup in all three core bridges. One
   line each, closes the last member of a class CR-11 named.
2. **F2** — route `RegisterClass`'s two sites and `RegisterFunction` through
   `PushHostFunctionClosure`, or narrow the helper's comment. Behaviour-preserving
   either way; the point is that the comment stops asserting a property the code
   lacks.
3. **F3** — bracket `CaptureError`'s key push and `ResumeAsyncStep`'s
   `luaL_traceback`, and record the enumeration next to `IsExecuting()` so the
   class can be declared closed.
4. **F4** — a guard or, at minimum, a comment at `StageJsError` recording that
   its `runtime` may not be the state currently raising.
5. **F5** — the nits: `Propagate`'s stale value, `HasClass`'s deadness,
   `next_js_error_id_`'s width.

(The CR-3 M5 deployment target and the CR-5 F3/F8 release-time items remain
deferred by decision and are not in this list, though they are the two things
standing between this tree and a publishable package.)

---

## Note on the trajectory

This is the first pass in twelve to report nothing above low severity, and the
first where every finding is either a one-line completeness item or a documented
judgment call. By the definition this project set for itself nine passes ago,
that is convergence.

Two caveats keep it from being a victory lap.

**The first is that convergence was measured on a diff, not on a tree.** The
window here was 926 lines of remediation, all written days ago with the prior
reviews in hand. `CODE-REVIEW-THOUGHTS.md` predicted this shape — *"once the tree
is clean, review the diff, not the whole tree"* — but it also warned what the
prediction costs: **"few/no findings" is only meaningful if the baseline was
genuinely clean, and CR-11 is the proof that a baseline can look clean for three
consecutive passes while containing a reverted fix.** The right reading of CR-12
is therefore "the CR-11 remediation is sound", not "the tree is correct."

**The second is the shape of what this pass did find.** F2 is an enumeration
error inside the fix for an enumeration error — a comment claiming a completeness
property its code does not have, committed in the same change whose review
addendum warned about exactly that. That is not carelessness; it is evidence for
how strong the pull is. Writing "this is now the single place X happens" is
satisfying, cheap, and unverifiable by the person writing it, because they are
the one who just made it true at the sites they were looking at.

So the clause to add is a small one, aimed at the reviewer rather than the author:

> **Treat any comment asserting completeness — "the single place", "every path",
> "all callers" — as a claim to be checked, not context to be read.** They are the
> highest-yield lines in the file: cheap to write, rarely re-verified, and wrong
> in exactly the cases that matter.

Both CR-11 F1 and CR-12 F2 were found by grepping for the mechanism and comparing
against the prose, rather than by reading the prose. That is the technique worth
carrying forward, and it is cheap: `grep` for the primitive the comment claims to
have centralized, and count the hits.

On the harness, one observation worth recording because it cuts against
complacency: the three sanitizer runs and the 1,000-supersession stress harness
found **nothing** this pass. That is the correct outcome and it is also the
warning — a clean sanitizer run bounds nothing beyond the paths the harness
drove, and three of this pass's five findings (F1, F3, F4) are precisely the ones
no harness can currently reach. The adversarial coverage is what produces value;
the sanitizers only convert it.
