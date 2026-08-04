# CODE-REVIEW-16

**Date:** August 3, 2026
**Scope:** Sixteenth pass, against commit `4bd6717` — the occupancy-model
refactor that followed CR-15's remediation — plus a re-read of both C++ layers,
the async workers and the public TypeScript surface.

**Method:** This pass finally ran the experiment CR-15's closing note asked for,
verbatim:

> *"The remaining high-value step is a harness that injects a hostile callback —
> one that calls `reset()`, starts an async run, releases a handle, replaces
> itself — at **every** JS-crossing point and asserts survival, so the site list
> is generated rather than remembered."*

So the primary instrument this pass is not a reading of the code. It is a
**46-site × 27-action injection matrix**, 1242 combinations, each in its own
child process so a crash is isolated rather than fatal to the run. A *site* is a
place the addon calls into user JS while a native call is on the C stack; an
*action* is something hostile that JS does at that moment. The sites were
derived by grepping the call-into-JS surface (`\.Call(`, `\.Get("`,
`GetPropertyNames`), not by recalling which ones matter.

Every finding below was driven to a reproduction or is reported as undriven;
each recommendation was implemented and re-verified before being recommended,
per CR-12's rule.

**Baseline:** 838 TypeScript and 285 C++ tests pass at `4bd6717`, and all four
sanitizer harnesses are clean on it. The high finding is reproducible against
that clean baseline and none of the four harnesses can see it.

---

## Headline

**The occupancy model has exactly one deliberate exemption, and that exemption
is the one operation that conflicts.** `cancel()` is excluded from the guard on
purpose — it must work while `is_busy_` is true, that being its entire job. It
is therefore the *only* thing user JS can do during an `execute_async` result
marshal. What it does there is settle the very `Promise::Deferred` the marshal
is about to settle, after which `DriveAsync` concludes an already-concluded —
and by then freed — `napi_deferred`. **Deterministic SIGSEGV in
`ConcludeDeferred`, 8/8 and then 5/5** from an ordinary registered from-Lua
converter. The matrix found it as the single non-clean cell out of 1242.

The shape is worth stating plainly, because it is not the shape of the previous
five highs. Those were *missing* conditions — a guard that consulted a subset of
the facts. This one is a guard that is complete and correct, and a hole that was
put in it on purpose, for a good reason, by someone who did not ask what could
come through it. The hazard is described in prose **thirty lines away**, at the
sibling window `OnAwaitSettled`, naming `cancel()` explicitly and naming the
"or even starts a new run" variant. That analysis was done once and applied to
one of the two windows that needed it.

Four lows, all in the occupancy refactor itself, and all of the same family: the
refactor left three references to symbols it deleted, one of which instructs the
next maintainer to re-create the data race the refactor removed; it reordered
the claims and silently made one refusal message factually false; and its
central thread-safety property — the one TSan caught — is documented but
unenforced.

**Everything else survived.** 1241 of 1242 cells clean. For each of the three
`kExclusive` operations — `reset()` and both worker launchers — **43 of the 46
sites refuse through the occupancy guard**; two are sites where no context
exists yet (the constructor-time traps), so the operation is unreachable rather
than refused; and one is the deliberate control where the injection lands
*outside* the native call and the operation is legal. Nothing was allowed that
should have been refused. That is the first pass in this series where the
mechanically-generated search came back essentially empty.

---

## Resolution status (August 3, 2026)

**All findings resolved.** After the fixes: **843 TypeScript tests** (up from 838
— five new CR-16 pins) and **285 C++ tests** pass, and all four sanitizer
harnesses are clean: `test-ts-asan` (843/843), `test-cpp-asan` (285/285),
`test-cpp-tsan` (285/285) and `test-ts-tsan` (843/843). The full 1242-cell
matrix re-runs clean against the fixed binary.

**Three of the five new tests fail against the pre-fix binary**, and two of those
three do not *fail* — they take the vitest worker process down (`Error: Worker
exited unexpectedly`), which is the correct pre-fix outcome for a segfault and
is why nothing in 838 tests had caught it. The other two are deliberate controls:
one pins the sibling window that was already right, so a later "unify these two"
edit cannot delete the copy that worked; one pins the CR-9 case that must keep
its own message after the F3 reordering.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | A new `AsyncRunSuperseded(gen)` (`lua-native.h:731`) is the single place that answers "is the run I was driving still the one this context is driving". `DriveAsync`'s terminal exit now calls it after the marshal and before settling, on both the Finished and the errored branch (`lua-native.cpp:3139`, `:3156`). The three existing hand-written copies of the predicate — `OnAwaitSettled`'s entry check, its post-marshal H2 re-check, and `DriveAsync`'s attach-failure check — were replaced with calls to it, because four copies with three of them right is exactly how this happened. The generation half is load-bearing and is not redundant with the optional check: a converter can `cancel()` **and start a replacement run**, re-engaging `async_deferred_` with a different promise, and testing the optional alone would pass and tear the new run down. Both halves pinned. |
| F2 | ✅ Done | Three stale symbol references left by the occupancy refactor, fixed together because they are one defect. The worst is `lua-native.h:128` (before), which told the reader that adding a claim means "one line in `CurrentClaims()`" — a function the same commit deleted, and deleted *specifically because* an eager claim set is a data race. The paragraph now says there is deliberately no such accessor and why, and says so at the place a reader goes to add a claim. Also: two live references to the deleted `RejectIfStateInUse` (`lua-native.h:569`, `lua-native.cpp:3507`), one "RejectIfBusy above" inside `reset()`, which no longer calls it, and a "33 synchronous methods" count stated in four places that `grep -c` puts at 31 — replaced with the grep rather than a corrected number. |
| F3 | ✅ Done | `Resetting` moved back to **last** in `RejectIfOccupied`'s chain, where the four hand-written `if` blocks had it before the refactor. The refactor moved it to second with a comment citing CR-13's lesson, and produced the error CR-13 is about: since CR-15 gave the replay phase a `CallScope`, a `reset()` from a replay Proxy trap holds `Resetting` **and** `BindingCall`, and was told "from inside a `__gc` finalizer of the state being retired" — no finalizer is involved. The ordering rule is now stated as what it is: most-specific-first, with `Resetting` last because it is true for the whole of `reset()`'s second half while the others say *where* in it we are. Two pins; the CR-9 finalizer case verified to keep its own message. |
| F4 | ✅ Done | The lazy-evaluation-order requirement — the property TSan caught the refactor breaking — is now enforced by an `assert` in `RejectIfOccupied` (`lua-native.cpp:2838`) rather than by a comment. It is **generative**: it fires for any caller, present or future, that assembles a policy naming a claim below `AsyncInFlight` without naming `AsyncInFlight`, so there is no list of policies to keep in sync. Verified in the negative — injecting exactly such a policy trips it with the explanation attached. |
| F5 | ✅ Done | `types.d.ts:671`, `docs/ASYNC.md:278` and `docs/FEATURES.md:450` all said the worker launchers refuse on "the same three conditions that make `reset()` refuse … with the same three messages" / "with distinct messages". After the refactor `reset()` has four conditions, and condition 1 is now the shared generic busy message that every synchronous method emits plus a trailing detail clause — so it neither names the method nor is distinct. All three corrected, with the advice to match on the reason rather than the method name. |

---

## Verification of the CODE-REVIEW-15 remediation

Verified by re-running each item's generator, not by reading its list — CR-15's
own F3 was a list that a `grep` would have corrected.

| CR-15 # | Verdict |
|---------|---------|
| F1 | ✅ Correct, and superseded by the occupancy refactor. `grep -n 'lua_occupancy::k' src/lua-native.cpp` returns exactly four sites: one `kSyncApi`, two `kExclusive` (the worker launchers), one `kRetireState` (`reset()`). The `CallScope` over `reset()`'s replay is in place and correctly placed *after* the state swap (`:3512`), with the reason recorded. The matrix re-drove all three of CR-15 F1's doors: door (a) from a host callback, door (b) from a type converter, door (c) from a replay trap — all three refuse. |
| F2 | ✅ Correct. `ProtectedTablePairsCollect` exists (`lua-runtime.cpp:113-135`) and flattens the traversal into a Lua array before converting, with the comment naming CR-15's driven case. |
| F3 | ✅ Correct as to the generator. `grep -n lua_next src/core/lua-runtime.cpp` returns four call sites; both collect-first members carry the comment saying so, and the two exposed ones are grouped as such. |
| F4 | ✅ Correct. The `CallScope` enumeration's split heading is intact. One entry went stale for an unrelated reason — it still points at `RejectIfStateInUse` — which is F2, not a regression of F4. |
| F5 | ✅ Correct. `AsSharedTable`'s comment now names `Unwrap` as the load-bearing line. |
| F6a | ✅ Correct, and the `static_assert` is real. `AllTagsDistinct()` (`lua-native.h:90-103`) does the full pairwise comparison; the five literals are distinct. `grep -n 'External<Lua'` and `grep -n 'TaggedData<'` — the two generators the comment names — agree on the five tagged kinds. |
| F6b–f | ✅ All correct. Both GC bridges contain exceptions (`lua-runtime.cpp:907`, `:1392`); the depth-0 precondition is on the declaration; `TakeLastErrorValue()` is non-`const`; the `-Wunused-but-set-variable` warning is gone and the debug build is warning-free. |
| CR-12 F2 | ✅ Still one hit. `grep -c 'lua_pushcclosure(.*LuaCallHostFunction' src/core/lua-runtime.cpp` returns 1, as it has for four passes. |
| Release deferrals | Unchanged, as decided. `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` and `prebuilds/` still contains `darwin-arm64` only. |

---

## The injection matrix

The instrument, described so it can be re-run and extended.

**46 sites**, grouped by what is on the C stack when the user JS runs:

- *Lua executing* (13): host callback, `__index` and `__add` metamethods, `__gc`
  finalizer, print handler, debug hook, `require` searcher, proxy-userdata
  getter and setter, userdata method, class constructor, class method, argument
  marshalling into a returned Lua function.
- *Binding call, no Lua running* (16): both halves of both converter families,
  a getter on a plain object and on a nested one, Proxy traps on the callbacks
  object / init options / metatable definition / class definition / class
  methods / module object / userdata options / userdata methods / compile
  options / environment options / hook options.
- *Patchable globals and hidden reads* (5): a getter on a thrown Error's `name`,
  a patched `Array.from` reached by Map/Set conversion, a patched
  `Object.defineProperty` reached by `DefineHiddenProp`, a hostile `then` on an
  awaited promise, a getter on a value stored through a table handle.
- *Result marshalling* (9): the coroutine iterator's conversion, `resume`'s
  conversion, both worker `OnOK`s, `execute_async`'s terminal marshal, `pcall`,
  `execute_script_in`, `get()` on a table handle, and `reset()`'s own replay.
- *Miscellaneous* (3): the coroutine `for…of` body (a deliberate control — the
  injection lands *outside* `next()`, so hostile actions there are legal), the
  SharedTable push, the coroutine iterator.

**27 actions**: `reset`, both worker launchers, `execute_script`,
`execute_async`, `gc('collect')`, mint-and-release a handle, `set_global`,
`get_global_ref`, **`cancel`**, `set_hook`/`remove_hook`, throw, construct a
second context, flood both converter lists (the CR-11 F1 class), and eleven
registration/compilation methods.

**Result: 1242 cells, one crash.** The allowed/refused map is the other half of
the output and is where the reassurance lives. Taking `reset()` and the two
worker launchers — the three `kExclusive` operations — across all 46 sites:

| Outcome | Sites | |
|---|---|---|
| Refused by the occupancy guard | 43 | the result being checked |
| Unreachable — no context exists yet | 2 | `callbacks_object_trap`, `init_options_trap`; the harness's own JS throws, so the guard is not exercised at these two and they are not evidence either way |
| Allowed, and correctly | 1 | `coroutine_iterator`, where the injection lands in the `for…of` body rather than inside `next()` — a deliberate control for a legal moment |

**No site allowed a hostile `reset()` or worker start that should have been
refused.** The two "unreachable" rows are called out rather than folded into the
43 because "allowed" and "refused" in the raw output mean something different
there, and rolling them in would have inflated the number the pass is resting
on.

The harness is deliberately not checked in. It is slow (~15 minutes), it needs
one child process per cell, and its value was in being *written from the grep*
this pass. The five findings it produced are pinned in the suite; the sixth
thing it produced is the knowledge that the other 1241 cells are clean, and that
belongs in this document rather than in CI.

---

## Findings

### F1. `cancel()` during an `execute_async` result marshal double-concludes a freed `napi_deferred` (high)

**The exemption.** The occupancy model's premise is that every operation
declares a policy and the guard turns away anything that conflicts. During
`DriveAsync`'s terminal marshal, `is_busy_` is still true — `FinishAsync()` has
not run yet — so the guard is fully armed, and the matrix confirms it works:
of 27 hostile actions attempted from inside a from-Lua converter running on an
`execute_async` result, **25 are refused**. `create_ctx` is allowed and is
harmless (a different context).

The twenty-seventh is `cancel()`, and `cancel()` is exempt by design. It has to
be: interrupting a run in flight is the only thing it does, and a `cancel()`
that refused while busy would be a `cancel()` that never worked. So it is the
one operation a marshal cannot refuse — and what it does is:

```cpp
const auto deferred = *async_deferred_;
FinishAsync();
deferred.Reject(Napi::Error::New(env, "execution cancelled").Value());
```

— settle the deferred and tear the run down. Meanwhile `DriveAsync`, thirty
lines up, took its own copy of that same deferred *before* the marshal:

```cpp
auto deferred = *async_deferred_;              // :3080, pre-fix
if (step.state == Finished) {
  try { resolved = ResultsToJs(step.values); } // <-- runs user JS
  ...
  FinishAsync();
  if (ok) deferred.Resolve(resolved);          // <-- second conclude
```

`napi_resolve_deferred` frees the deferred on the first conclude. The second
call reads it.

**Driven — ordinary code, no hostile input.**

```js
const lua = new lua_native.init({}, { libraries: 'all' });
lua.register_from_lua_converter(
  (v) => !!(v && v.k === 1),
  (v) => { lua.cancel(); return v; });

lua.execute_async('return {k=1}');
```

**SIGSEGV, 8/8.** Under lldb:

```
* thread #1, name = 'MainThread', stop reason = EXC_BAD_ACCESS (code=1, address=0x73c99da0e4e23add)
    frame #0: libnode.137.dylib`v8impl::(anonymous namespace)::ConcludeDeferred + 176
```

The fault address is garbage rather than null, which is the signature of a freed
`napi_deferred__` being read rather than a null one being dereferenced.

**Driven — the worse variant.** The converter may also start a *replacement*
run, which re-engages `async_deferred_` with a different promise:

```js
lua.cancel();
lua.execute_async('return 99');   // accepted: is_busy_ is false again
```

**SIGSEGV, 5/5**, and this one is not merely a double-conclude: the outer
`DriveAsync` then calls `FinishAsync()` on the *new* run, releasing its
coroutine ref and clearing its deferred, before crashing on the old one. Post-fix
the trace is `OLD run rejected execution cancelled` / `NEW run resolved 99`,
which is the correct outcome for both. (The pre-fix teardown of the replacement
is not directly observable, because the process dies two statements later.)

**The analysis already existed.** `OnAwaitSettled` — the *other* place that
marshals a value with a run engaged — carries this comment at `:3165`:

> *"Marshalling the settled value above (type converters, object getters, the
> reject path's message/name/stack reads) can run user JS that **calls
> `cancel()`** — which, since we are not inside a resume, takes the full-teardown
> branch and disengages `async_co_`/`async_deferred_` — **or even starts a new
> run**. Re-check the liveness+generation guard before driving…"*

Both variants of F1, named, in the file, one function away. And the re-check it
prescribes is present there — `promise_then_getter × cancel` and a type
converter firing inside `OnAwaitSettled` were both probed and both survive
cleanly. The window that has the check and the window that does not are
siblings, and the one without it is the one that settles a promise.

**Recommendation — implemented and verified before being recommended.**

Give `DriveAsync`'s terminal exit the re-check its sibling already has, and stop
keeping four copies of the predicate:

1. `AsyncRunSuperseded(gen)` on `LuaContext` — the single place that answers
   "has the run I was driving been settled or replaced". `!async_co_ ||
   !async_deferred_ || gen != async_generation_`. The generation term is not
   redundant with the optional term; it is what covers the replacement-run case.
2. Call it in `DriveAsync` after the marshal, before `FinishAsync()`, on both
   terminal branches, and replace the three existing copies with it.

Put it on the error branch too, even though `LuaErrorToJsValue` runs no user JS
today. That safety is a property of *its* body, not of this call site, and CR-14
F2's lesson was that a guard whose soundness lives elsewhere stops holding
without anyone editing the guard.

### F2. The occupancy refactor left three references to symbols it deleted, and one of them prescribes re-creating the race (low)

`grep -rn 'RejectIfStateInUse\|CurrentClaims' src/` returns three live comment
references to two functions that no longer exist. Individually these are stale
comments. One of them is not.

`lua-native.h:128`, in the "**The model**" paragraph that a maintainer reads
when adding a claim:

> *"`LuaContext::CurrentClaims()` computes which are held — the single place
> that knows … Adding a fifth kind of holder means adding one enumerator, **one
> line in `CurrentClaims()`**, and one line in the message switch."*

`CurrentClaims()` was deleted in the same commit that wrote this paragraph, and
it was deleted for a specific reason: an eagerly-computed claim set reads
`lua_depth_` and `call_depth_` on every `kSyncApi` call while a worker may be
writing them, which is the ten-race TSan report CR-15 documents at length. So
the instruction at the extension point is: *do the thing we removed because it
was a data race.* The reason it was removed is recorded — in `CODE-REVIEW-15.md`
and in `CODE-REVIEW-HISTORY.md` (Part I), and at `RejectIfOccupied`'s definition. It is
not recorded where somebody would act on it.

The other two: `lua-native.h:569` and `lua-native.cpp:3507` both send the reader
to `RejectIfStateInUse` for the worker launchers' guard; and `reset()`'s body
says "RejectIfBusy above means a run in flight can't reach here" when the guard
above it is now `kRetireState`.

Also in this family, and the reason it is worth counting: **the "33 synchronous
methods" figure is 31.** It appears in four comments and three places in CR-15's
own text. `grep -c 'if (RejectIfBusy())' src/lua-native.cpp` returns 31. Nothing
depends on the number; it is here because it is the fourth enumeration in four
passes that was written from memory next to a one-line command that produces it.

**Recommendation.** Fix the three references. State at the extension point that
there is deliberately no whole-set accessor and why, so the paragraph that
teaches the model also carries the constraint the model was rebuilt around.
Replace the count with the grep that produces it.

### F3. Reordering the claims made one refusal message factually false (low)

The refactor collapsed four hand-written `if` blocks into one ordered chain and,
in doing so, moved `in_reset_` from **last** to **second**, with this rationale:

> *"`Resetting` precedes `BindingCall` because a reset reached from the retiring
> state's own teardown is a distinct situation from a reset reached from a
> converter, and CR-13's lesson was that collapsing two distinct facts into one
> message is how the distinction gets lost."*

The premise is right and the conclusion is backwards, because since CR-15 the
two facts are **not** mutually exclusive. CR-15 F1's own fix gave `reset()`'s
replay phase a `CallScope`. So during the replay both `in_reset_` and
`call_depth_ > 0` hold, and the first test in the chain wins. Driven:

```
replay-trap reset()  -> reset() cannot be called re-entrantly
                        (from inside a __gc finalizer of the state being retired)
```

There is no finalizer. The caller is a Proxy `get` trap on the callbacks object,
reached from `RegisterCallbacks` during the replay. Before the refactor this
case produced the accurate "from inside another lua-native call (a type
converter, a definition-object getter, or a **Proxy trap** …)".

`Resetting` is the *least* specific of the four claims, not the most: it is true
for the whole of `reset()`'s second half, and during that half a more specific
claim usually also holds and says *where*. Tested last, it is left holding
exactly the case nothing else can see — a finalizer of the retiring state firing
inside `lua_close`, where `runtime` already points at the replacement (so
`IsExecuting()` is false) and the replay's scope is not yet open (so
`call_depth_` is 0). That is the CR-9 case it was written for, and it keeps its
own message; verified by the existing CR-9 pin, which passes either way and so
could not have caught this.

**Recommendation.** Move `Resetting` back to last and say why the order is
most-specific-first, naming the overlap that CR-15 introduced. Pin both halves —
the replay trap must blame the trap, and the finalizer must keep its own
message. The first pin fails against the pre-fix binary.

### F4. The refactor's central thread-safety property is documented but unenforced (low)

`RejectIfOccupied` evaluates claims lazily, in order, returning on the first
conflict, and both the declaration and the definition explain at length that
this is a thread-safety requirement: everything below `AsyncInFlight` reads
state a worker thread mutates, and `AsyncInFlight` returning first is what makes
those reads single-threaded.

The property is one step weaker than the comments describe. The first test is
not "check `is_busy_`" — it is:

```cpp
if (wants(Claim::AsyncInFlight) && is_busy_) { ... }
```

A policy that does not name `AsyncInFlight` skips that branch entirely and falls
straight through to `runtime->IsExecuting()`. So the safety of every future
operation depends on an unstated rule — *every policy must include
`AsyncInFlight`* — that is satisfied by all three policies today, is written
down nowhere, and is checked by nobody. The three existing policies make it look
automatic; it is not, and the failure is silent (a race, on a code path that
passes every test).

This is CR-15 F6a's own lesson, one screen away in the same header. CR-15 found
that the type tags' distinctness was "an invariant the code depends on, stated
nowhere and checked by reading", and fixed it with a `static_assert` over the
pairwise comparison. The same header then introduced a second invariant of
exactly that kind.

**Recommendation.** Assert it, and assert it **generatively** rather than over a
list of policies — a list has the decay problem this series keeps paying for.
The check belongs in `RejectIfOccupied`, where it sees every caller:

```cpp
assert((!Any(disallowed & (Claim::LuaExecuting | Claim::BindingCall |
                           Claim::Resetting)) ||
        wants(Claim::AsyncInFlight)) && "…");
```

Verified in the negative, which is the only verification an assertion deserves:
replacing `kSyncApi` with a bare `Claim::LuaExecuting` at the `RejectIfBusy`
call site trips it on the first context construction, with the explanation
attached.

### F5. The documented refusal contract is wrong on both counts (low)

`types.d.ts:671` promises that the worker launchers refuse on

> *"the same three conditions that make `reset()` refuse … for the same reason
> and **with the same three messages**"*

and `docs/ASYNC.md:278` says the three conditions are `reset()`'s "with distinct
messages". Both were accurate when CR-15 wrote them, against a
`RejectIfStateInUse` that emitted three messages each naming the method. After
the refactor:

- `reset()` has **four** conditions, not three — `Resetting` is its own.
- Condition 1 no longer names the method. It is the shared
  `"Lua context is busy with an async operation"` that all 31 synchronous
  methods emit, deliberately left unparameterized because a great many tests
  match it verbatim, plus a trailing `": handing the state to a worker thread
  requires that nothing else holds it"`. So a caller branching on the message
  cannot tell `execute_script_async()`'s condition-1 refusal from `get_global`'s.

Driven, all four messages captured. Reported as a contract defect: the type
definitions are the public surface, and this is the one place a user is told how
to distinguish the refusals.

**Recommendation.** Say three of `reset()`'s four; say that conditions 2 and 3
name the method and condition 1 does not; advise matching on the reason. Same
correction in `ASYNC.md` and `FEATURES.md`, which carry the same claim.

---

## Verified and rejected (adversarial suspicions that held up)

- **The 1241 clean cells.** Stated once as a finding in the negative, because it
  is the most substantive result this pass produced. Every hostile action at
  every JS-crossing site, and the only thing that got through was `cancel()` at
  one of nine marshalling sites. In particular: `reset()` from inside all 13
  Lua-executing sites and all 16 conversion sites refuses; both worker launchers
  refuse at all 41 sites where they should; flooding both converter lists from
  inside a converter (the CR-11 F1 reallocation class) survives at every site;
  and a hostile throw at all 46 sites leaves the context usable.
- **`cancel()` at the other eight marshalling sites.** Both worker `OnOK`s clear
  `is_busy_` before marshalling, so a converter's `cancel()` there finds
  `async_co_` null and `is_busy_` false and is a no-op — which is correct, and is
  the reason CR-14 F1's fix (a `CallScope`, not a busy flag) did not create this
  problem in the worker family. `pcall`, `execute_script_in`, `resume`, the
  coroutine iterator and `get()` on a handle have no deferred to conclude.
- **`OnAwaitSettled`'s re-check, re-driven.** A type converter calling
  `cancel()` while the settled value is converted into resume arguments: the run
  rejects with "execution cancelled", the context stays usable, no crash. The
  guard works; F1 is about its sibling.
- **The `Awaiting` branch's attach-failure check.** A hostile `then` that
  settles synchronously and then throws is handled — `attached` is false but the
  generation has moved, so the teardown is skipped. Re-derived independently and
  now expressed through `AsyncRunSuperseded`, which strengthens it slightly (it
  also tests `async_co_`) without changing behaviour.
- **The occupancy matrix's completeness.** `grep -n 'lua_occupancy::k'` returns
  four call sites; three are `kExclusive`/`kRetireState`, and `EXCLUSIVE_OPS` in
  the suite names exactly those three. The enforcement instruction CR-15 added
  is currently satisfied.
- **`execute_async` nested inside a synchronous run**, re-driven at all 13
  Lua-executing sites. Accepted at every one, correct at every one, context
  usable afterwards. The deliberate `kExclusive` exclusion still holds.
- **The type-tag branding.** `grep -n 'External<Lua'` and `grep -n 'TaggedData<'`
  agree; `AllTagsDistinct()` is a real pairwise comparison over a real array, not
  a comment. Forging a marker (`set_global({_tableRef: coro._coroutine})`) fails
  closed.
- **Constructor-time hostility.** Traps on the callbacks object and the options
  object are the two sites where no context exists yet, so `reset()` and the
  launchers are unreachable rather than refused. Both survive all 27 actions;
  the distinction is recorded because "allowed" in the matrix output means two
  different things at those two rows.
- **Stack discipline and the deferred-unref machinery.** Re-read; unchanged
  since CR-15 and no new pushes that scale with user data lack a
  `lua_checkstack`.

---

## Suggested priority order

1. **F1** — the re-check on `DriveAsync`'s terminal exit, and the collapse of
   the four copies of the predicate into `AsyncRunSuperseded`. Closes a
   deterministic segfault reachable from an ordinary registered converter, and
   the collapse is what stops the fifth copy from being written wrong.
2. **F3** — move `Resetting` last. A refusal message that names the wrong cause
   is worse than a generic one, because it sends the reader looking for a
   finalizer that does not exist.
3. **F4** — the generative assert. Cheap, and it is the only one of the five
   that prevents a *future* instance rather than fixing a present one.
4. **F2** — the three stale references, starting with the header paragraph that
   prescribes the deleted accessor.
5. **F5** — the contract wording in `types.d.ts`, `ASYNC.md`, `FEATURES.md`.

---

## Note on the trajectory

The user's standing question for this series is whether the findings are
shifting from high to lower. This is the first pass where the answer is clearly
yes, and it is worth being precise about *why*, because the raw count does not
show it: one high, again, five passes running.

The difference is what it took to find it. CR-9 through CR-15 each found their
high by a human thinking of a site. This pass built the generator CR-15
prescribed, ran 1242 combinations, and the generator found the one cell that
crashes — out of a space that a year of hand-auditing had left with exactly one
hole in it. **1241 of 1242 is the finding.** The five sites where a hostile
`reset()` is *allowed* are all legal by construction, and there was no second
crash, no wedged context, no unusable handle. That is a different state of
affairs from CR-13, where the same class produced a new site every pass.

And the hole that remained is not the shape of the previous five. Those were
guards that consulted a subset of the facts — omissions. This one is a guard
that is complete, with a hole cut in it deliberately, for a correct reason:

> **Every exemption from a guard is an unguarded operation, and it is invisible
> precisely because it was a decision rather than an oversight.** `cancel()` is
> exempt from the occupancy model because it must be. Nothing followed that
> decision with the question it implies — *what runs while the guard is armed,
> and what can the one exempt operation do to it?* The 33 refusals in the matrix
> row for that site are the guard working exactly as designed. The 34th cell is
> the design.

Three second-order observations:

**The analysis was already written, one function away.** `OnAwaitSettled`'s
comment names `cancel()`, names the "or even starts a new run" variant, and
prescribes the exact re-check that F1 needed — and `DriveAsync`, in the same
file, thirty lines up, marshals the same kind of value with the same run engaged
and has no such check. This is CR-15's rule (*"ask what else does the same thing
to the same object"*) failing in its easiest possible case: not a subtle sibling
in another layer, but the other exit of a two-exit relationship, where one exit
had a comment explaining the hazard. **A comment that explains a hazard is
evidence the hazard was understood, and no evidence at all that it was searched
for.** The fix collapses four copies of the predicate into one function for
exactly this reason: three of four being right is the natural steady state of a
hand-copied guard, and which one is wrong is not predictable from reading any of
them.

**A refactor's own remediation is the highest-density place to look for the
class it was built to retire.** All four lows this pass are in the occupancy
refactor, and each is a small instance of what that refactor exists to prevent:
F2 is an enumeration that decayed within one commit — and decayed into an
instruction to re-create the very race being retired; F3 is two facts collapsed
into one message, which is CR-13's finding, committed by a comment citing CR-13;
F4 is an unenforced invariant, which is CR-15 F6a's finding, one screen from
CR-15 F6a's `static_assert`. CR-15 already recorded the general form of this
("a refactor whose entire purpose was to retire a recurring hazard class
introduced a fresh instance of a different one"). What CR-16 adds is that the
instances are not random: **a refactor reproduces the class it was written to
kill, because the author is thinking about the abstraction and not about the
prose and the constants around it.** The code was right; everything describing
the code was one revision behind.

**The count that nobody depends on is the honest measure.** "33 synchronous
methods" appears in four comments and three paragraphs of CR-15. It is 31.
Nothing breaks — which is the point. It is the fourth enumeration in four passes
that was written from memory while a one-line command that produces it sat in
the same repository, and it is the cheapest possible demonstration that the
instruction CR-14 wrote and CR-15 re-wrote is still not being followed. This
pass replaced the number with the grep rather than with a corrected number,
which is the only version of the fix that stays true.

Finally, the harness. All four sanitizer harnesses and 838 tests passed on the
tree containing F1 — the fifth consecutive pass where that sentence is true.
ASan cannot see it: the double-conclude is inside libnode's own allocator, not
the addon's. TSan cannot see it: there is no second thread. It is a
use-after-free that a memory sanitizer misses because the freed object belongs
to Node. The two pre-fix pins do not fail; they take the worker process down,
which is why 838 tests could not have caught it either.

> **A test suite catches the failures a test can survive.** Two of this pass's
> five pins kill the runner against the pre-fix binary. Any suite that had
> contained them before the fix would have reported an infrastructure error, not
> a test failure — which is a thing people mute. The matrix works because it puts
> each cell in its own process, and that, rather than the size of the site list,
> is the part worth keeping: **the search space has to be partitioned so that
> finding a crash is a data point instead of the end of the run.**
