# CODE-REVIEW-17

**Date:** August 3, 2026
**Scope:** Seventeenth pass, against commit `67e3025` — the CR-16 remediation —
plus a re-read of both C++ layers, the handle lifetime machinery and the public
TypeScript surface.

**Method:** CR-16 exhausted one axis and named the other:

> *"The open question for CR-17 is whether the same partition-and-exhaust
> treatment can be applied to the **lifetime** class — the remaining highs that
> are not about occupancy at all — where the axis is not 'what does user JS do'
> but **in what order do these objects die**."*

So this pass built two lifetime matrices, each cell in its own process:

- an **orphan matrix** — 13 handle kinds × 21 operations, where the `LuaContext`
  wrapper is finalized **first** and the handle is used afterwards;
- a **life matrix** — 20 subjects × 15 kill events (`release`, `reset`,
  `gc('collect')`, double-release, cross-context release, JS GC, …).

Every finding below was driven to a reproduction; each recommendation was
implemented and re-verified before being recommended, per CR-12's rule.

**Baseline:** 849 TypeScript and 285 C++ tests pass at `67e3025`, all four
sanitizer harnesses are clean on it, and CR-16's 1242-cell injection matrix
re-runs clean. The high finding is reproducible against that baseline.

---

## Headline

**`reset()` swaps the runtime member and destroys the outgoing runtime in the
same statement, so `lua_close`'s `__gc` finalizers dispatch into JavaScript with
the member already pointing at the replacement — and every handle minted in that
window pairs a ref from the *retiring* registry with the *replacement*
runtime.** The `shared_ptr<LuaRuntime>` in each `*Data` struct is the codebase's
entire lifetime guarantee, and in this window it guarantees the wrong object's
lifetime.

Two consequences, both driven from a JS `__gc` metamethod plus `reset()` — two
documented, supported features and four lines of ordinary code:

- **A use-after-free at teardown.** `luaL_unref` runs against a freed
  `lua_State`. Deterministic **SIGSEGV, 3/3**; ASan names both halves.
- **Silent cross-state aliasing while the handle lives.** The ref index was
  minted in the old registry and is read against the new one. Driven: five
  escaped handles aliased five live tables of the replacement state
  **one-for-one and in order**, and a write through a retired handle landed in a
  table the program was actively using.

The second is the worse half, and it is the one the matrices were built to find:
no crash, no error, a plausible value, and the program's own data quietly
rewritten.

One medium and one low, both about **silently wrong answers rather than
crashes** — which is the shift this series has been trying to reach. The medium
is that `set_global` was the only one of six cross-context entry points that did
not refuse a foreign table handle; it fell through to "a plain deep copy", a
policy that is correct for the two object kinds it was written for and produces a
Lua table of the handle's *method names* for the third.

**Everything else survived.** 68 exercised orphan cells and 300 life cells came
back clean, and CR-16's injection matrix still does.

---

## Resolution status (August 3, 2026)

**All findings resolved.** After the fixes: **850 TypeScript tests** (up from 849
— six new CR-17 pins, and five existing assertions tightened) and **285 C++
tests** pass; all four sanitizer harnesses are clean; both lifetime matrices and
CR-16's injection matrix re-run clean; and the two F1 reproductions are clean
under ASan.

**Four of the six new pins fail against the pre-fix binary.** The teardown
segfault itself is *not* among them, and that is worth stating plainly: it
manifests only when the process exits with the handle still alive, which a test
runner does not reliably do. The aliasing pin catches the same root cause and
fails loudly, so the defect is pinned even though its most spectacular symptom
is not directly testable in-suite.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | A new `lua_core::detail::OwningRuntime(lua_State*)` (`lua-runtime.cpp:820`) answers "which runtime owns the state this ref was taken on", resolving the main thread exactly as `MakeRegistryOwner` does and reading the same extraspace pointer `UnrefRegistrySlot` reads — so all three agree on what "this ref's runtime" means. `LuaContext::RefForThisRuntime` (`lua-native.cpp:4236`) returns the ref unchanged when it belongs to the current runtime and an **already-released** copy when it does not, and all four mint sites in `CoreToNapiBuiltin` now pass their ref through it. Releasing our copy is the whole fix: the core still holds its own share of the same slot and unrefs it correctly, against the live retiring state, when the dispatch returns. A valid pairing is not merely missing but *impossible* — the retiring runtime is inside its own `shared_ptr` deleter, so its use count is already zero — which is why the only correct handle is a dead one. **Derived from the ref rather than from a flag a caller sets**: the two wrappers that dispatch this way already captured `owner` for exactly this hazard (CR-12 F4) and used it only on the error path, so a scheme requiring callers to opt in had already failed once. |
| F2 | ✅ Done | The `_tableRef` branch of `NapiToCoreInstance` (`lua-native.cpp:4056`) now throws "table handle belongs to a different Lua context" instead of falling through to a deep copy, matching the five siblings that already refuse. The deep-copy policy is unchanged for the two kinds it was written for — the deferred ledger's M6 pins that a foreign class instance's fields survive, and that test still passes — because those are plain objects whose own enumerable keys *are* their data. Documented alternative added to `types.d.ts` and `FEATURES.md`: `b.set_global('cfg', a.get_global('cfg'))` copies the data and works. |
| F3 | ✅ Done | `reset()` and `~LuaContext` both flip `alive_`, so one message served two facts and a handle used after a reset that left the context **demonstrably alive** reported "its context has been destroyed". A `ContextLiveness` pair (`lua-native.h:220`) carries both `alive_` (re-minted by reset) and `context_alive_` (never re-minted); `DeadReason()` is the single place that turns the pair into words, so the four message sites cannot drift apart again. `LuaContext::Liveness()` is the single place that assembles the pair, so a new mint site cannot carry one flag and forget the other. Five existing assertions were **tightened** from `/destroyed\|released/` to `/replaced by reset/` — that loose regex accepting either cause is precisely why the wrong message survived. |

---

## Verification of the CODE-REVIEW-16 remediation

| CR-16 # | Verdict |
|---------|---------|
| F1 | ✅ Correct. `grep -n AsyncRunSuperseded src/lua-native.cpp` returns five call sites — `DriveAsync`'s attach-failure exit and both of its terminal exits, plus `OnAwaitSettled`'s two — against one definition. The `cancel()`-from-a-converter reproductions stay clean, and the whole 1242-cell injection matrix re-runs with 0 non-clean cells. |
| F2 | ✅ Correct. The header's model paragraph names `RejectIfOccupied` as the extension point and states why there is deliberately no whole-set accessor. `grep -rn 'RejectIfStateInUse\|CurrentClaims' src/` returns only the two intentional back-references in that paragraph. |
| F3 | ✅ Correct. `Resetting` is last in the chain; a replay-trap `reset()` blames the trap and the `lua_close` finalizer case keeps its own message. Both pinned. |
| F4 | ✅ Correct, and it fires. Re-verified in the negative this pass by substituting a bare `Claim::LuaExecuting` policy at the `RejectIfBusy` call site — the assert trips on the first context construction, message attached. |
| F5 | ✅ Correct in all three files. |
| Release deferrals | Unchanged, as decided. `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` and `prebuilds/` still contains `darwin-arm64` only. |

---

## The lifetime matrices

**Orphan matrix — 13 handle kinds × 21 operations.** The `LuaContext` wrapper is
finalized first; the handle is used afterwards. This is the path `contextAlive` /
`ContextLive()` exists for (CR-7 F1, CR-10 F2).

Two construction details decide whether this matrix means anything, and both had
to be got right before any cell was believed:

- **The context must be created inside an IIFE and only the handle allowed to
  escape.** V8 gives every closure in a function one shared context object, so a
  *sibling* closure that captures `lua` keeps the wrapper alive. The first
  version of the harness did exactly that and every cell was silently vacuous —
  it reported clean while collecting nothing.
- **A `FinalizationRegistry` proves the wrapper actually died** before each cell
  runs; a cell that could not collect is reported `VACUOUS`, not `clean`.

With those in place: **68 exercised cells, 0 non-clean.** Every operation on an
orphaned handle fails with a clear JS error. The remaining 205 combinations are
marked not-applicable (`.next()` on a table handle and so on) rather than being
counted as passes.

A useful negative result fell out of building it: **handles do not root their
context wrapper.** The `_tableOwner` / `__luaFnOwner` Externals are GC roots for
the *data*, not back-references to the context, so the context-dies-first path is
genuinely reachable through all 13 kinds rather than being defensive-only. That
was worth establishing before trusting the machinery it exercises.

**Life matrix — 20 subjects × 15 kill events.** `release()`, `lua.release()`,
releasing a *parent* handle, `reset()`, double `reset()`, `gc('collect')`, JS GC,
double-release, cross-context release and use, `cancel()`, and combinations.
**300 cells, 4 crashes — all four the same root cause, F1** (`gc_finalizer` ×
`reset`, × `reset_then_gc`, × `second_reset`, × `release_then_reset`; SIGBUS,
SIGABRT and two SIGSEGVs, the varying signal being characteristic of a
use-after-free rather than four separate defects).

The life matrix's own `drop_ctx_then_gc` column is vacuous for the reason above
and is *not* counted as coverage; the orphan matrix is what covers that axis.

---

## Findings

### F1. Handles minted while the retiring state is closing are paired with the replacement runtime (high)

**The guarantee, and where it inverts.** Every registry-backed handle pairs a ref
with a `shared_ptr<LuaRuntime>`:

```cpp
auto data = std::make_unique<LuaTableRefData>(runtime, v, this, alive_);
```

`runtime` is the context's current member, and holding a share of it is what
stops the `lua_State` whose registry `v` indexes from being destroyed while the
handle lives. That is right on every path but one.

`reset()` does:

```cpp
runtime = std::move(fresh);   // member now points at the replacement;
                              // the outgoing runtime is destroyed *inside*
                              // this statement, and lua_close fires its __gc
                              // finalizers from there
```

The file already knows this — the comment three lines below says the finalizers
run "after the member already points at the replacement", and CR-9's re-entrancy
pin depends on those finalizers reaching JS. What nothing said is that a
finalizer's **arguments are converted in that window**. A JS `__gc` metamethod is
called by Lua with the object being finalized, that object is a metatabled table,
and converting it here takes a `luaL_ref` in the **retiring** registry and pairs
it with the **replacement** runtime.

**Driven — consequence 1, teardown.** Four lines:

```js
const lua = new lua_native.init({}, { libraries: 'all' });
lua.execute_script('fin = {}');
lua.set_metatable('fin', { __gc: () => { hits++; } });
lua.reset();
// script ends normally; the process then dies
```

**SIGSEGV, 3/3.** The fault location moves between runs (`pthread_mutex_lock`,
`lua_rawgeti`) — the signature of a use-after-free rather than one bad pointer.
ASan names both sides exactly:

```
READ of size 8 ... heap-use-after-free
  #0 lua_core::detail::UnrefRegistrySlot(lua_State*, int)   lua-runtime.cpp:819
  #8 lua_core::LuaTableRef::release()                       lua-runtime.h:172
  #9 LuaTableRefData::~LuaTableRefData()                    lua-native.h:281
 #14 Napi FinalizeData<LuaTableRefData>
 #18 napi_env__::DeleteMe()                                 <- env teardown
freed by thread T0 here:
  #1 lua_core::LuaRuntime::LuaAllocator(...)                lua-runtime.cpp:188
  #2 lua_core::LuaRuntime::~LuaRuntime()                    lua-runtime.cpp:608
```

**Driven — consequence 2, and this is the one with teeth.** The handle is a live
Proxy. Its ref index was minted in the old registry; reading it goes to the *new*
state's registry at that index:

```js
const escaped = [];
lua.execute_script('a = {} b = {} c = {} d = {} e = {}');
for (const n of ['a','b','c','d','e'])
  lua.set_metatable(n, { __gc: (t) => { escaped.push(t); } });
lua.reset();

const fresh = [];                       // populate the replacement registry
for (let i = 0; i < 12; i++) { const h = lua.create_table(); h.set('iam', 'fresh#' + i); fresh.push(h); }
```

```
escaped[0].iam -> "fresh#0"   <== ALIASED a table belonging to the REPLACEMENT state
escaped[1].iam -> "fresh#1"
escaped[2].iam -> "fresh#2"
escaped[3].iam -> "fresh#3"
escaped[4].iam -> "fresh#4"

write through escaped[0] landed in fresh handles: [[0,"written through a retired handle"]]
```

One-for-one, in order, and a write through a retired handle lands in a table the
program is using. No error, no crash at the point of use — the same
cross-registry identity collision the deferred ledger's M6 is about, reached
*within one context* across a reset.

**The analysis existed, one loop away.** `CreateJsCallbackWrapper` captures
`owner = runtime.get()` and its comment says why:

> *"It tells StageJsError below whether the raise it is staging for is happening
> on this context's **current** state or on a retired one whose finalizers are
> still running (CR-12 F4)."*

That is exactly the fact F1 needs. It is used at the bottom of the lambda, on the
error path. Three lines above, the argument loop calls `CoreToNapi(*a)` with no
such qualification.

**Recommendation — implemented and verified before being recommended.**

The ref cannot be made valid: the retiring runtime is inside its own `shared_ptr`
deleter, so its use count is already zero and no new share can be created. The
only correct handle is therefore a **dead** one.

1. `lua_core::detail::OwningRuntime(lua_State*)` — the runtime that owns the
   state a ref was taken on, resolving the main thread the way `MakeRegistryOwner`
   does and reading the extraspace pointer `UnrefRegistrySlot` reads, so all three
   agree on the same notion.
2. `LuaContext::RefForThisRuntime(ref)` — returns the ref unchanged when it
   belongs to the current runtime, and a released copy otherwise. Applied at all
   four mint sites. Releasing our copy is the entire fix; the core's own share
   unrefs correctly against the live retiring state when the dispatch returns.

Derive it **from the ref, not from a flag callers set**. The `owner` capture is
proof that the opt-in approach fails: it was added for this hazard, in these
wrappers, and still missed the conversion sitting between the two places it was
used.

A JS `__gc` handler now receives a handle that reports "has been released", which
is the accurate answer rather than a fudge — the object is mid-finalization and
will not exist a moment later. The finalizer still dispatches, so CR-9's pin is
untouched.

### F2. `set_global` was the only cross-context door that did not refuse a foreign table handle (medium)

Six entry points can be handed a value belonging to another context. Five refuse:

```
B.release(handleFromA)             -> refused: value belongs to a different Lua context
B.execute_script_in(envFromA)      -> refused: environment belongs to a different Lua context
B.resume(coroFromA)                -> refused: coroutine belongs to a different Lua context
B.create_coroutine(fnFromA)        -> refused: Lua function belongs to a different Lua context
B.set_metatable(handleFromA, …)    -> refused: table handle belongs to a different Lua context
B.set_global(handleFromA)          -> "ACCEPTED"
```

`set_metatable` is the sharp contrast: same argument type, same file, refuses.

What "accepted" produced:

```
table handle -> fields survive:   [null, null]        (the real table has host="db1", port=5432)
table handle -> what B got:       "get,get_ref,has,ipairs,length,pairs,release,set"
```

The `_tableRef` branch's comment reads *"Foreign marker: fall through to a plain
deep copy."* That policy is deliberate and correct for the kinds it was written
against — the deferred ledger's M6 pins that a foreign **class instance**
deep-copies with its data intact, and a JS-created **userdata** copies its
`secret` field across. Both are plain JS objects whose own enumerable keys *are*
their data.

A table handle is a **Proxy** whose own keys are its API. The same policy
therefore copies the wrapper: eight functions named after the handle's methods,
and none of the referenced table's fields. Silently.

It is not free either. Each of those eight becomes a registered host callback in
the receiving context, so the copy costs registry slots: 200 foreign pushes grew
the receiving state from **27 KB to 331 KB**, ~1.5 KB each, for a value that
contains none of the caller's data.

**Recommendation.** Refuse, with the message `set_metatable` already uses. That
converts a silent wrong answer into the same clear error the five siblings give,
and it is strictly more helpful than the status quo, because the working
alternative exists and can be named: `b.set_global('cfg', a.get_global('cfg'))`
copies the data. Leave the deep-copy policy alone for class instances and
userdata; M6's pin must keep passing, and it does.

### F3. One message served two different facts, and after a `reset()` it was the wrong one (low)

`alive_` is flipped to false by **both** `reset()` (which then re-mints it) and
`~LuaContext`. The four handle-liveness sites read that one flag and said:

```
Lua table handle's context has been destroyed
```

After a `reset()` the context is not destroyed. Driven:

```
context still alive ->  2            // lua.execute_script('return 1+1')
table handle        ->  Lua table handle's context has been destroyed
function            ->  Lua function's context has been destroyed
```

Meanwhile the coroutine and environment paths, which check runtime identity
rather than the flag, reported `belongs to a different Lua context` for the same
situation — so the four kinds gave three different accounts of one event, and the
two most common were false.

This is CR-13 F1's family and CR-16 F3's family again: two distinct facts
collapsed into one message. The distinguishing fact was already in the object —
`context_alive_` is deliberately never re-minted, and its comment says so — it
just was not on the handles.

**Recommendation.** Carry both flags as one `ContextLiveness` pair, with a single
`DeadReason()` that turns the pair into words and a single `Liveness()` that
assembles it, so the four message sites cannot drift and a new handle kind cannot
take one flag and forget the other. `handles == false && context == true` is
exactly "reset() replaced my state", the case the single flag could not name.

Then **tighten the tests that hid it.** Five assertions under "handles minted
before the reset" read `toThrow(/destroyed|released/)` — a regex that accepts
either cause, in a block whose entire subject is one specific cause. They now
assert `/replaced by reset/`. A test that accepts both branches of a distinction
cannot notice the distinction being wrong.

---

## Verified and rejected (adversarial suspicions that held up)

- **The 68 orphan cells and 296 clean life cells.** Stated as a finding in the
  negative. Calling, indexing, writing, iterating, releasing, double-releasing,
  `JSON.stringify`-ing and spreading an orphaned handle of all 13 kinds fails
  cleanly; so does every kill event on all 20 subjects other than the four F1
  cells.
- **Handles do not root their context.** Established with a
  `FinalizationRegistry` before the orphan matrix was trusted: for all 13 kinds
  the wrapper is finalized while the handle lives, so `ContextLive()` is
  load-bearing rather than defensive.
- **Nested handles outlive their parent.** `get_ref` children survive
  `parent.release()` on every operation, which is what `types.d.ts` promises.
- **Double release, and release from a foreign context.** Idempotent and refused
  respectively, at every handle kind that has a `release`.
- **`cancel()` against every subject.** Clean at all 20, including the two
  in-flight promise subjects — CR-16 F1's territory, re-probed from the lifetime
  side rather than the injection side.
- **The deferred-unref machinery under reset.** Re-read; the worker brackets and
  the mutex still cover every flag flip, and F1 was not a race — it is a pairing
  error visible on one thread.
- **`~LuaRuntime` teardown ordering.** Re-derived again; the destructor still
  drops both registry-backed error values and nulls the five bridges before
  `lua_close`. CR-15's recorded residual (the extraspace runtime pointer is never
  cleared) is now *load-bearing in a good way*: `OwningRuntime` reads it, and it
  is read only while the state is alive.
- **M6's deep-copy policy.** Deliberately preserved for class instances and
  JS-created userdata; its regression test passes unchanged after F2.
- **CR-16's injection matrix.** All 1242 cells re-run clean against the fixed
  binary, so none of this pass's three fixes regressed the occupancy work.

---

## Suggested priority order

1. **F1** — the ref/runtime pairing. It is the only memory-safety finding, and
   the aliasing half is worse than the crash half: it rewrites live data with no
   error at all.
2. **F2** — refuse the foreign table handle. A silent wrong answer plus an
   unbounded leak, reachable by an ordinary two-context program.
3. **F3** — the liveness pair, and tightening the five assertions that accepted
   either cause.

---

## Note on the trajectory

The user's standing question is whether findings are moving from high to lower.
CR-16 answered "yes, on cost of discovery". CR-17 answers it on **character**,
and the two answers are different things worth separating.

There is still one high. But look at what the three findings *are*: a wrong
pointer pairing whose most damaging symptom is silently rewriting live data; an
API door that returns a plausible wrong value; a diagnostic that names the wrong
cause. Only the first is a memory-safety defect, and even it was found through
its data-corruption half rather than its crash half. Compare CR-9 through CR-15,
where every high was "two threads in one `lua_State`" or "use-after-free of the
state" — findings whose only symptom was a segfault. **The failure mode this
codebase produces has moved from crashing to lying**, which is the normal
progression for a maturing native binding and is exactly the shift the series was
looking for.

That shift has a cost, and it is the reason this pass needed matrices rather than
reading:

> **A crash announces itself; a wrong answer has to be asked for.** Every earlier
> high in this series was discoverable by *running* something. F1's aliasing,
> F2's method-name table and F3's wrong message all execute successfully and
> return plausible values, so no amount of running finds them — the harness has
> to compare the value against what it should have been. That is why both
> matrices report the *value* of every cell, not just whether it threw, and why
> the F2 finding came out of reading a column of successes rather than a column
> of failures.

Three second-order observations:

**A safety mechanism can be perfectly implemented and still point at the wrong
object.** The `shared_ptr<LuaRuntime>` pairing is right at all four mint sites,
correct in its ordering, and documented in `CLAUDE.md` as *the* lifetime
guarantee. It never failed to hold a runtime alive. It held the wrong one, for
one window, because the expression that names the object — `runtime`, the member
— means something different inside `reset()`'s swap than it does everywhere else.
**A guarantee expressed as "hold a reference to X" is only as good as the
expression that computes X, and that expression is invisible in every review that
checks whether the reference is held.** Fourteen passes checked the pairing
existed. None asked what it was pairing with.

**The fact needed was already captured, by a previous pass, in the same
lambda.** `owner = runtime.get()` was added by CR-12 F4 for precisely this
hazard — a dispatch from a retired state — and used on the error path fifteen
lines below the argument loop that needed it. This is CR-16's lesson recurring
one notch tighter: there, the analysis was in a comment at a sibling function;
here, the *value* was in scope. So the fix deliberately does not extend the
opt-in scheme:

> **When a fact has to be supplied by callers, the set of callers is the
> maintenance burden — and it has already been shown incomplete once.** Deriving
> "which runtime owns this ref" from the ref itself covers every conversion path,
> including the ones nobody enumerated, and cannot be forgotten at a new one.
> This is CR-16 F4's "generative rather than a list" applied to data flow instead
> of to policies.

**A loose assertion is worse than no assertion, because it reports coverage.**
Five tests sat directly on F3 — in a `describe` block named "handles minted
before the reset", asserting on the message a handle gives after a reset — and
matched `/destroyed|released/`. They passed with the wrong word for as long as
the wrong word has existed. A regex that accepts every branch of a distinction is
not a weak test of that distinction; it is a test of something else entirely,
filed where a reader will believe the distinction is covered.

Finally, the harness, and an honest note about how nearly this pass produced
nothing. **The first orphan matrix was entirely vacuous and reported clean.**
Every cell dropped the context, ran three GC cycles, used the handle, and passed
— while a sibling closure in the same function held the wrapper alive through
V8's shared closure context, so nothing was ever collected. It looked exactly
like a clean result, and it would have been written up as one.

> **A negative result needs a positive control.** What saved it was adding a
> `FinalizationRegistry` and making the harness *prove* the wrapper died before
> counting the cell — after which the vacuous cells announced themselves and the
> matrix was rebuilt to escape only the handle. CR-12's rule was "I could not
> crash it is a statement about the probe"; CR-15 added "re-read the ones that
> confirm you first". CR-17 adds the mechanical version: **an exhaustive search
> that reports clean must first demonstrate it can report dirty**, and for a
> lifetime harness that means proving the thing you are killing actually died.
