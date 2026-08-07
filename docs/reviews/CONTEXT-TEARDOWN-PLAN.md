# CONTEXT-TEARDOWN-PLAN

> **Superseded August 7, 2026 — executed in full and moved here the same day.**
> C1, C2 and C3 are done; §7's status table is the check. What survives as
> *instruction* lives where it executes: `dispose()` in `types.d.ts` and
> `README.md`, the pinning rule in `LIMITATIONS.md` §10, and the
> `liveness-guarding` census in `check-invariants`.
>
> **Read §0 first if you read nothing else.** The finding that motivated this
> plan was measured before any design work and its memory half did not survive —
> the states were already being closed. Two of the four predictions in §8 were
> wrong, and both execution records say how.

**Written August 7, 2026.** One gap, one question: **can a caller say "I am done
with this Lua context, end it now"?** Today it cannot — `close()` exists only as
`close(coroutine)`, and a context's `lua_State` lives until the JS wrapper is
garbage-collected.

**This is the fifth plan document**, and it is held to the bar the first four
set (`docs/README.md`): every item traceable to something measured in this
repository, a closing condition that can be checked rather than felt, and dated
predictions so execution can score them.

---

## 0. The finding as reported, and as measured — read this first

The gap was reported like this, in conversation:

> *"A context's Lua state is freed when the LuaContext is garbage-collected …
> For a process creating many short-lived contexts under `maxMemory`, that's a
> real behavioural difference."*

**Two-thirds of that survived contact with the addon, and the memory half did
not.** Driven before any design work, August 7, 2026:

| Probe | Result |
|---|---|
| 40 contexts, each holding ~20k strings; references dropped; `global.gc()` ×2 | RSS **127 → 130 MB** — no drop |
| Same, instrumented with a `FinalizationRegistry` | **20 of 20 contexts finalized** |
| 20 contexts, references dropped, **no** forced GC, half a second | **0 of 20 finalized** |
| …then one forced GC | **19 of 20 finalized** |
| A context whose `get_global_ref` handle is still held | **not finalized** |

So the states *are* closed, and RSS not falling is the process allocator
declining to return pages — not a leak, and not this binding's business. **The
motivating "memory is not reclaimed" reading was wrong, and it was wrong in the
direction that would have justified the most work.** What the measurements do
establish is narrower and still real:

1. **Reclamation is not deterministic.** Nothing was returned in half a second
   of ordinary operation; it took a forced GC. A caller cannot make it happen.
2. **A live handle pins the whole runtime.** The 21st context was not finalized
   because one `LuaTableHandle` was still held. That is CR-10 F2's note in
   `~LuaContext` — *"at an arbitrary later GC if a handle still holds a share of
   the runtime"* — reachable from ordinary code, and **`LIMITATIONS.md` has no
   row for it**.
3. **There is no way to express "done".** Not a memory question at all: a caller
   who wants a context's Lua-side effects to stop — timers of its own making,
   `__gc` finalizers, a sealed state's remaining capability — has no verb.

**The plan is therefore about (2) and (3), and explicitly not about (1) as a
memory-pressure argument.** Correcting this before designing is the whole of
`PERFORMANCE-PLAN`'s lesson, applied one plan later.

---

## 1. Why this item is admissible

`docs/README.md` says new work **must not** start from a survey's priority
matrix, and this gap surfaced in a comparison against wasmoon's
`engine.global.close()`. So the rule has to be stated, or the plan is exactly
what that instruction forbids:

> **A comparison may *raise* a question; only a measurement here may *seed* the
> work.** wasmoon's API is the reason anyone looked. What justifies the item is
> §0's driven evidence — a handle pinning a whole `lua_State`, and a lifetime
> with no verb to end it — both facts about this binding, both reproducible with
> the addon in this tree, and neither recorded in `LIMITATIONS.md`.

Under that rule, the item admitted here is **not** "wasmoon has `close()`, so we
should". It is "this binding has a lifetime a caller cannot end, and a pinning
rule it does not document".

---

## 2. What `close()` can mean here — the design space, from the source

The obvious implementation does not exist, and the reason is structural.

`runtime` is a `std::shared_ptr<LuaRuntime>`, and **every handle holds a copy**
— that is deliberate, and it is what guarantees the destruction order
(`LuaFunctionData`, `LuaTableRefData` and the rest pair a ref with a share of
the runtime so a handle can never outlive the state its registry ref points
into). Dropping the context's share therefore frees nothing while any handle is
alive. Three candidate semantics follow:

**(A) `close()` = drop the context's share, invalidate the context.**
Small and honest, and it frees the state *iff* no handle is outstanding — which
is precisely the case where GC would have done it anyway. It does not deliver
"now", so it does not answer the question that motivated the item.

**(B) `close()` = close the `lua_State` now; handles fail closed.**
This is what wasmoon does and what "free it now" means. `~LuaContext` already
performs three of the four steps — it flips `alive_` (every handle refuses),
flips `context_alive_` (host-function wrappers refuse), calls
`DetachRuntimeHandlers()` and `ClearHostFunctions()`. The missing step is
closing the state while `shared_ptr`s to the `LuaRuntime` remain.
**The whole risk of this plan is that last clause**: every core method assumes
`L_` is valid, so the guarantee needed is *no path from JS reaches the core
after close*. That is a closure question of exactly the shape
`core-call-guarding` already answers for exceptions, and §4 makes it an
invariant rather than a promise.

**(C) Refuse, and document instead.** A `LIMITATIONS.md` entry stating the
pinning rule and the non-determinism, with `reset()` named as the way to release
a state's *contents* deterministically. This is a legitimate outcome — R1's
precedent in `FIDELITY-AND-REACH-PLAN` §7 is "shipped **or refused in writing**"
— and it is the outcome if §4's closure cannot be established.

**The plan does not pre-commit.** §4 is ordered so the deciding evidence is
gathered before the API is designed, which is the opposite of how this gap was
first framed.

---

## 3. The rule that generates the enumeration

> **An item belongs here iff it is required to answer "may the state be closed
> while a handle still references the runtime?" — or, if the answer is no, to
> write that down where a caller will find it.**

That keeps the plan to one question. Anything else a context lifetime suggests
(pooling, reuse, a `using`/`Symbol.dispose` protocol) fails the rule and is
listed in §6.

---

## 4. Items

### C1 — Derive the closure: what can still reach the core after `alive_` flips?

**The deciding item, and it runs first because it decides the API.** Every JS
entry point that reaches a core method must be shown to check liveness *before*
the call. `~LuaContext` relies on this today, but only for the window between
the destructor body and the last handle's death — nobody has enumerated it.

Deliverable: a `check-invariants` census — a sibling of `core-call-guarding`,
computed the same way (transitive fixpoint over the binding) — scoring every
binding→core path as **LIVENESS-CHECKED** or **UNCHECKED**. `UNCHECKED` rows are
the answer to §2's question: zero means (B) is available, any number means the
work is "fix these first", and a number that will not go to zero means (C).

**This is the item that could end the plan**, and that is deliberate.

### C1 execution record — August 7, 2026

**Shipped as the `liveness-guarding` invariant** (`tools/invariants/liveness-guarding.mjs`),
running in `check-invariants` and the suite. **141 binding→core edges, 21
UNCHECKED**, frozen.

**Prediction 1 was right on both halves.** It did not come back zero, and the
useful question was whether the residue is a class or a list. It is **two
classes**, and the census took three runs to say so — each run's universe was
wrong in a way the previous one hid:

| Run | Universe | UNCHECKED | What the residue actually was |
|---|---|---|---|
| 1 | every binding function | 41 / 147 | mostly `LuaContext::LuaContext`, `InstallRuntimeHandlers`, `RegisterCallbacks`, `~LuaContext` — functions JavaScript cannot call |
| 2 | functions with N-API callback shape | 38 / 144 | same family, because the **constructor** has callback shape (`new lua_native.init(...)` is a JS call) |
| 3 | …excluding construction and teardown | **21 / 141** | the real answer |

The rule the third run states, and the reason: *a context under construction
cannot have been closed, and a destructor **is** the teardown*, so asking a
liveness question of either is asking whether teardown checks that teardown has
not happened.

**The 21 rows, classified — and this is the deciding evidence:**

- **Runs only while Lua is executing** — `StageJsError`, `LuaErrorToJsValue`,
  `CreateJsCallbackWrapper`, `NapiToCoreImpl`, `CoreToNapi`, `TableRefToMap`.
  These are reached from a host callback, a converter or an error path, all of
  which require Lua to be on the stack.
- **Async continuations** — `DriveAsync`, `OnAwaitSettled`, `FinishAsync`. These
  fire from a microtask *after* the call that started them returned, which is
  the one shape that genuinely outlives its entry point.
- **One deliberate outlier** — `Cancel -> RequestCancel`. `cancel()` is designed
  to work while a run is in flight and is unguarded on purpose.

**`kRetireState` already covers the first two, and that is the finding.** Read
from the source rather than assumed:

```
kExclusive   = AsyncInFlight | LuaExecuting | BindingCall
kRetireState = kExclusive | Resetting
```

A `close()` carrying `kRetireState` — the policy `reset()` already uses, because
`reset()` retires a state too — is **refused** while Lua executes, while a
binding call is mid-flight, and while an async run is in flight. So no
continuation can fire on a closed state: by the time `close()` is permitted,
none is pending.

> **Decision: option (B) is available.** The census does not say "21 things to
> fix"; it says the claim set answers twenty of them and `cancel()` needs an
> explicit ruling. C2 proceeds, with `cancel()` after `close()` as a named
> sub-item rather than something to discover later.

**What the frozen map is for afterwards.** It is the `callscope-classification`
contract: a **new** UNCHECKED row is a review item, because it means a path
reaches the core in a state the claim set may not cover. That is the check that
survives this plan.

### C2 — `close()`, iff C1 comes back zero



`close()` on the context: retire the state permanently, invalidate every handle,
refuse every subsequent call with a message naming the cause. Idempotent —
double `close()` is safe, matching `release()` and `close(coroutine)`.

Guarded by `lua_occupancy::kRetireState`, which is what `reset()` already uses
and what its three claims already say: `LuaExecuting` (Lua frames live on this
thread's C stack), `BindingCall` (a method mid-flight with user JS above a
conversion), `Resetting`. A close during a worker run is refused by the same
claim set.

**What it does not do:** free the C++ `LuaRuntime` shell while handles hold
shares. That is `shared_ptr` semantics and not worth fighting; what it frees is
the `lua_State`, which is where the memory is.

### C2 execution record — August 7, 2026

**Shipped as `dispose()`**, not `close()`, and the rename is the first thing to
record. It shipped for an hour as a no-argument `close()` dispatching on arity
beside `close(coroutine)`, on my reasoning that *a bare `close()` already threw,
so nothing could depend on it*. **The suite disproved that in one run:** a P3
test pins `close()` → "requires a coroutine object", and that throw is the
*guard against a typo*. Under arity dispatch, `lua.close()` written while
meaning `lua.close(coro)` would have silently destroyed the context — a
destructive branch reached by omission, which is the accept-and-do-something-else
shape this tree refuses everywhere else. One verb per subject.

**Implementation:** `CloseState()` extracted from `~LuaRuntime` — not copied, so
the ordering that took several passes to get right (error values unref'd while
the state is open, the five bridging handlers cleared before `lua_close` fires
the `__gc` metamethods that reach them, the count-hook removed first) has one
home. `dispose()` is the retire half of `reset()` without the rebuild half,
under the same `kRetireState` policy, and `cancel()` — C1's named outlier — is
guarded at its own site as a no-op.

**Two defects found while building, and neither by the same means:**

- **A segfault, found by the suite.** `~LuaContext` calls
  `DetachRuntimeHandlers()` on every context, which calls `RemoveDebugHook()`,
  which **re-installs** the execution hook: `lua_sethook(nullptr, ...)` once the
  state is closed. So a disposed context crashed the process at whatever later
  moment it happened to be collected. Filtered runs never showed it — only the
  full suite, because a short run never gets round to collecting. This is
  precisely the risk §2 named for option (B) — *every core method assumes `L_`
  is valid* — arriving at the one path **C1's census could not see**, since C1
  ranges over JS-reachable paths and this one is reached from a destructor.
  Pinned by a test that disposes thirty contexts and then keeps using the
  process.
- **A use-after-free, found by reasoning then reproduced.** Registry-slot owners
  captured the main `lua_State*` on the documented promise that *"it stays valid
  until `lua_close`"* — true when `lua_close` ran only from `~LuaRuntime`, which
  cannot happen while a handle lives. `CloseState()` broke it: finalizing a
  handle after a dispose unref'd into a freed state (exit 139). Owners now
  capture a shared "state open" token and do nothing when it is false. That also
  closes a pre-existing hazard the destructor's own comment warned about: refs
  held by the *runtime's own members*, which are destroyed after the body has
  already run `lua_close`.

**Prediction 2 was right that the `lifecycle-matrix` event would report, and
wrong about what.** It predicted a handle kind that answers instead of refusing;
what it reported was nine cells of `UNEXPECTED-REFUSAL` on the three
`notAHandle` kinds, because the matrix's rule — *a caller's own JS object stays
usable across a state-replacing event* — assumes the **context survives**. It
does not survive `dispose()`, and every `use` in that matrix goes through the
context. Model gap, fixed with a `retiresContext` flag. Then a tenth finding
that was a **name collision**: the ids `close` and `close-twice` already existed
there, meaning `close(coroutine)`. Renamed `context-close*`. **114 cells, 0
findings** after both.

**Prediction 3 was wrong.** It expected `dispose()` during a `__gc` finalizer to
need a fourth occupancy claim. It needed none: setting `closed_` before
`CloseState()` makes a re-entrant dispose a no-op via the same idempotency the
public contract already promises, and `kRetireState`'s existing claims cover the
rest.

**Regression:** 1196 TS tests (9 new), 285 C++ tests, `check-invariants` green,
and all ten harnesses clean — `lifecycle-matrix` 114 cells / 0 findings,
`roundtrip-matrix`, `capability-matrix`, `exception-matrix`, `exec-parity`,
`oracle`, `cross-context`, `binding-balance`, and `gc-stress` balanced.

### C3 — the `LIMITATIONS.md` entry, whichever way C1 goes

Two facts have no row today and need one in either outcome:

- **A live handle pins the entire runtime** (§0, driven). A forgotten
  `get_global_ref` keeps a whole `lua_State` alive for the life of the process.
- **Reclamation is not deterministic** — 0 of 20 collected in half a second of
  ordinary operation. With `close()`: the entry says how to be deterministic. Without it:
  the entry says `reset()` releases the contents and the state itself waits for
  GC.

C3 ships even if C2 does not. It is the item that makes the honest outcome a
deliverable rather than a shrug.

---

## 5. Trigger cost (`CORRECTNESS.md` §15.6)

- **`lifecycle-matrix` gains a 13th event**, applied to all 12 handle kinds:
  *held across `close()`*. This is the instrument that would catch (B) going
  wrong, and its existing contract is exactly the property at stake — *a handle
  must stay valid or refuse, never answer with another state's data.* Expect
  this to be the largest single piece of work, and expect it to find something:
  every previous lifecycle event did.
- **`cross-context`**: a handle from a closed context offered to a live one.
- **`surface-census`** will rule on the new entry point automatically. `close()`
  takes no JS value, so a `roundtrip-matrix` door is unlikely to be owed — but
  the census decides that, not this document.
- **No `capability-matrix` config**: `close()` is not a capability option.

---

## 6. What this plan deliberately does not do

- **No context pooling or reuse.** A closed context stays closed; `reset()`
  already covers "same context, fresh state".
- **No `Symbol.dispose` / `using` protocol.** It would be a thin wrapper over
  `close()` and belongs to whoever wants the syntax, after the semantics exist.
- **No change to `shared_ptr` ownership.** The handle-holds-a-share design is
  what makes destruction order correct; this plan works within it and says so.
- **No memory-pressure claim.** §0 measured it and the claim did not survive.

---

## 7. Closing condition

> **This plan is done when all three hold:**
>
> 1. **C1's census exists and runs in `check-invariants`**, with every
>    binding→core path scored and the count frozen — whatever the count is.
> 2. **`close()` has shipped or been refused in writing**, and the decision
>    cites C1's number rather than a preference. If it shipped, the
>    `lifecycle-matrix` `close` event covers all 12 handle kinds and is clean;
>    if it did not, §2 (C) is written into `LIMITATIONS.md` with C1's number as
>    the reason.
> 3. **`LIMITATIONS.md` states the pinning rule**, with the driven numbers from
>    §0 — this one is unconditional.

---

### Status — August 7, 2026, after C1, C2 and C3

| # | Clause | State |
|---|---|---|
| 1 | C1's census exists, runs in `check-invariants`, count frozen | ✅ met — `liveness-guarding`, 143 edges / 21 UNCHECKED, frozen |
| 2 | `close()` shipped or refused in writing, citing C1's number | ✅ met — shipped as `dispose()`; C1's classification (20 of 21 covered by `kRetireState`, one — `cancel()` — guarded by hand) is what made (B) available |
| 3 | `LIMITATIONS.md` states the pinning rule with §0's numbers | ✅ met — §10, unconditional |

**The plan is closed**, and what survives as instruction has moved to where it
executes: `dispose()` and its contract in `types.d.ts` and the README, the
pinning rule and the non-determinism in `LIMITATIONS.md` §10, and the
`liveness-guarding` census in `check-invariants` — where a **new** UNCHECKED row
now means a path reaches the core in a state the claim set may not cover.

**What this plan is evidence for.** Its motivating claim was wrong (§0), and
measuring that before designing is what kept it from becoming a memory-pressure
feature. Its central question was answered by a census rather than an opinion.
And the two defects it produced were caught by different means — a full-suite
run for the segfault, reasoning-then-reproduction for the use-after-free —
neither of which the other would have found.

---

## 8. Predicted failure modes

Dated August 7, 2026, so execution can score them.

1. **C1 will not come back zero on the first run.** Every census in this tree
   has found something on its first run, and this one ranges over ~45 entry
   points written across seven months against a rule nobody was enforcing. The
   interesting number is not whether it is zero but whether the non-zero rows
   are a *class* (fixable once) or a list (fixable one at a time).
2. **The `lifecycle-matrix` event will find a handle kind that answers instead
   of refusing.** Twelve kinds, and the two most likely are the async coroutine
   cursor (state shared via `shared_ptr`, already the odd one out in that
   instrument) and the iteration cursors added by T4, which hold a JS reference
   to the object being walked and are not in that matrix at all.
3. **`close()` during a `__gc` finalizer is the sharp edge**, not `close()`
   during execution — the occupancy guard covers the second, and the first is
   the case `reset()` needed `in_reset_` for. Expect a fourth claim, or a reason
   why the existing three suffice.
4. **The honest outcome may be (C)**, and the plan should be read as expecting
   that rather than as committing to `close()`. §0 already removed the argument
   that would have forced (B).

---

## 9. Order of work

| # | Item | Why this order | Rough |
|---|---|---|---|
| 1 | ✅ **C1** — the liveness census — done August 7, 2026 (§4) | It decides whether C2 is possible at all. Buildable with zero product change. | ~1 day |
| 2 | ✅ **C3** — done August 7, 2026 (`LIMITATIONS.md` §10) | Unconditional, independent, and it is the deliverable if C1 says no. | half a day |
| 3 | ✅ **C2** — done August 7, 2026, as `dispose()` (§4) | Plus the `lifecycle-matrix` event, which is most of it. | 1–2 days |

---

## 10. When this plan is done

It moves to [`reviews/`](reviews/) with a superseded banner naming what replaced
it, per `docs/README.md` rule 2 — as all four of its predecessors did. Anything
surviving as *instruction* moves to `CORRECTNESS.md` or `LIMITATIONS.md` first.
