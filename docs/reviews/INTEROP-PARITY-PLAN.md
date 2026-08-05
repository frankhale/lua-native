# INTEROP-PARITY-PLAN

> **SUPERSEDED — every item is implemented (August 5, 2026).** This is now the
> reasoning record for that work, not a plan. Moved to `reviews/` the same day it
> was written and executed, under `docs/README.md` rule 2. **Nothing here is an
> instruction.**
>
> | Item | Shipped as | Where it is documented now |
> |---|---|---|
> | P1a | `call_async(nameOrFn, ...args)` | `FEATURES.md` "Uniform Async Doors", `types.d.ts` |
> | P1b | `resume_async(coro, ...)` + `Symbol.asyncIterator` | same |
> | P2a | `register_class({ statics })` | `FEATURES.md` "Class Statics and Property Accessors" |
> | P2b | `register_class({ properties })` | same |
> | P3 | `close(coroutine)` | `FEATURES.md` "Coroutine Close" |
> | P4a | `set_read_handler()` | `FEATURES.md` "Input Redirection and Virtual Files" |
> | P4b | `set_file_reader()` | same |
> | P5 | dated correction at `BRIDGE-COMPARISON.md` §C1 | there |
> | Reflection / raw C API | **not built, by decision** | `LIMITATIONS.md` §6 and §7 |
>
> P4a and P4b were listed here as "not scheduled — wait for a concrete need".
> They were built anyway, on the owner's instruction to implement everything the
> document mentioned. That is the one place the executed work departs from the
> plan as written. (P3's open question — whether `release()` should close before
> unref'ing — went *against* this document's "it probably should": the two stay
> orthogonal. Not a departure, since the plan asked for a decision rather than
> an outcome, but recorded here so the lean below is not mistaken for one that
> was forgotten. The reasoning is in `FEATURES.md` "Coroutine Close" and on
> `close()` / `release()` in `types.d.ts`.)
>
> **Three things were found while building, none of which this document
> predicted**, and they are the most useful part of the record:
>
> 1. A **stale pending promise**. The binding stashes an awaited Promise before
>    the core decides whether the current thread is the driven one, so a
>    *refused* nested await (M1) left a promise behind that the next plain
>    `coroutine.yield` was misread as. Fixed by having the core report which kind
>    of yield happened (`AsyncStepResult::awaited`) instead of leaving the
>    binding to infer it.
> 2. A **swallowed getter exception**. `UserdataIndex` and `ClassIndex` caught
>    *every* property-getter exception and answered `nil` when the object had
>    methods — so a host getter that genuinely threw was indistinguishable from
>    an absent field. Fixed by narrowing the catch to a new
>    `PropertyAccessDenied`, which is what the comment always claimed it caught.
> 3. A **teardown path that could abort the process**. `DetachRuntimeHandlers`
>    calling `SetFileReader(nullptr)` ran a `RunProtected` removal that can throw,
>    from a path with no handler above it (the CR-6 F1 class). Found by
>    `check-invariants`, not by review; fixed with a `DropFileReader()` that
>    touches no Lua.
>
> Two of the three are exactly the defect class this document was written about —
> a behaviour that differs between siblings — and none was visible from the
> surface. The third was found by an instrument, not by a person — and the
> instruments made two further catches during the same work (a non-`Error` throw
> losing its text at the new `io.read` frame; a bare `.toThrow()` refused in a
> new test). `docs/CORRECTNESS.md` §15.6 records that partly different trio.

**Planned work on five interop gaps that the bridge survey's enumeration never
had a row for.** Each was found by checking the shipped surface rather than by
reading the survey, and each entry carries the source evidence it rests on.

**Date:** August 5, 2026
**Basis:** `types.d.ts` and `src/lua-native.cpp` as of `a84ca0f`, read against
[`BRIDGE-COMPARISON.md`](BRIDGE-COMPARISON.md),
[`../FEATURES.md`](../FEATURES.md) and [`../LIMITATIONS.md`](../LIMITATIONS.md).

---

## Why this document exists at all

[`README.md`](../README.md) says there is no roadmap document, and that new work
should start from a concrete need rather than from a survey. That rule stands
and this document does not overturn it: **nothing below came from the survey's
priority matrix.** Every item came from driving the shipped API and finding a
door that behaves differently from its neighbours. The survey is what these
findings are *reported against*, not where they came from.

The survey's own enumeration (A–F) really is closed. The point of this document
is that the enumeration had blind spots — it was organised by *capability*
("can Lua await a Promise?") and every capability question answers yes, while
the questions that answer no are all *uniformity* questions ("can Lua await a
Promise **through this door**?"). That is the same defect class the correctness
programme kept finding, and it is why `exec-parity` and `roundtrip-matrix`
exist: a capability that works through one entry point and not its siblings
looks complete from a feature list and is not.

### How this document retires

*(Done — see the banner. Kept as written so the rule and its execution can be
read together.)*

Per `README.md` rule 2, when the items below are resolved this file gets a
superseded banner in its first screen and moves to `reviews/`. It must not be
left at the top level of `docs/` describing work that is finished — that is
exactly the failure the four August 4 renames were correcting. If a *single*
item is dropped rather than built, it moves to the "Recorded as decisions"
section below and stops being a plan item; it does not sit here as a permanent
open row.

---

## Verification method

Every claim below names a file and line. Nothing here is inferred from
documentation — where the docs and the source disagree, that disagreement is
itself recorded (see P5).

---

## P1 — Await is reachable through exactly one door

**The one item here that is a capability hole rather than ergonomics.**

`LuaCallHostFunction` gates all Promise handling on
`runtime->IsAwaitDriverMode()` (`src/lua-native.cpp:2749`), and that flag is set
in exactly one place: `ExecuteAsync` (`src/lua-native.cpp:3114`). Every other
entry point rejects a Promise-returning host callback with
`"'<name>' returned a Promise; call it inside execute_async() to await it"`.

| Door | Host fn returns a Promise |
|---|---|
| `execute_async(script)` | suspends and resumes |
| `call(name, ...)` | throws |
| a held `LuaFunction` | throws |
| `pcall(fn, ...)` | throws |
| `resume(coro, ...)` | throws |
| `execute_script_in(env, s)` | throws |
| `load_bytecode(...)` | throws |
| `execute_script` / `execute_file` | throws |

There is a second, narrower guard for the same reason inside the method-call
path (`src/core/lua-runtime.cpp:1060` and `:1989`): a promise-returning method
called from a thread that is not `await_driver_thread_` raises *"cannot await a
JS Promise inside a coroutine (method '%s'); await only at the top level of
execute_async"*. Both guards are **deliberate and commented** (marked M1) — they
are not oversights, and any fix has to move the guard rather than delete it.

This splits cleanly into a cheap half and a hard half. They are worth treating
as separate items because the cheap half delivers most of the value.

### P1a — `call_async(nameOrFn, ...args)`

The gap: a `LuaFunction` you hold on the JS side, but which is not reachable as
a global, **cannot await at all.** The documented workaround — re-source the
call as script text for `execute_async` — needs a name to call, so it does not
apply. And where it does apply it reintroduces exactly the cost that F2
(`call()`) was built to remove: `reviews/BRIDGE-COMPARISON.md:381` argues
`call()` exists because the `get_global` route "mints a JS function wrapper and
a Lua registry slot per call". Routing an await through `execute_async` means
compiling a fresh chunk per call, which is strictly worse than either.

**Approach.** Almost all the machinery is already there. `ExecuteAsync` builds
its driver thread with `CreateCoroutineFromScript`; the core already has
`CreateCoroutine(LuaFunctionRef)` — shipped for A4 and recorded at
`reviews/BRIDGE-COMPARISON.md:486` — so `call_async` is the same driver seeded
from a function ref instead of a compiled chunk. Resolve the first argument the
way `Call` already does (dotted path via `GetGlobalPath`, or an existing
`LuaFunction` ref), push the args as the coroutine's initial resume values, and
hand off to the existing `DriveAsync`.

`await_driver_thread_` still designates exactly one thread, so the M1 guard is
untouched and no core change is needed.

**Inherited constraint, to be documented not fixed:** `is_busy_` plus
`Claim::AsyncInFlight` (`src/lua-native.cpp:2989`) allow one async run per
context. `call_async` inherits that — it is not a concurrency primitive.

- **Layer:** binding only.
- **Instruments to extend (§15.6):** `roundtrip-matrix` (a new door taking JS
  values) **and** `exec-parity` (a new door that executes). Both are required;
  a new execution door that only one of them knows about is the exact shape of
  CR-21's finding.
- **Effort:** small. Comparable to F2.

### P1b — an awaitable `resume`

The gap: `resume()` is synchronous and returns `CoroutineResult`, so a
**user-created coroutine cannot await a host Promise on any path.** A1 (await)
and A4 (coroutines as iterators) never intersected. `for await (const v of
coro)` appears to work and is listed under "Checked and *not* limitations" in
`LIMITATIONS.md:191` — correctly, but the reason it works is that JS falls back
to the *synchronous* iterator, which is precisely why a yield needing a Promise
cannot work through it.

**Approach.** A new `resume_async(coro, ...args): Promise<CoroutineResult>` that
drives a caller-owned thread. This is the hard half, because it breaks the
assumption both guards rest on: today the driven thread is one the binding
created and owns (`async_co_`, a single `std::optional` slot,
`src/lua-native.cpp:3115`), and `SetAwaitDriverThread` designates it globally.
Driving a user-owned thread means:

- `async_co_` becomes "the thread currently being driven", which the binding may
  not own and must not release on teardown;
- the M1 guard becomes *"is this the thread being driven right now"* rather than
  *"is this the driver thread"* — same check, per-run scope;
- `cancel()` semantics need a stated answer for a thread the caller still holds
  (the `execute_async` path abandons its coroutine; abandoning a caller's
  coroutine is a different contract and should probably leave it suspended and
  resumable, matching the early-`break` behaviour the iterator already has).

Once `resume_async` exists, `Symbol.asyncIterator` on a coroutine is a thin
wrapper over it and should ship in the same change — that is the point at which
`for await` stops being a sync-fallback coincidence.

- **Layer:** core and binding.
- **Instruments to extend (§15.6):** `roundtrip-matrix`, `exec-parity`, and
  `lifecycle-matrix` — the last because "a coroutine handle driven by
  `resume_async` and then reset / GC'd / cancelled mid-await" is a new set of
  cells on Axis A, and a suspended thread the binding drove but does not own is
  a genuinely new lifecycle shape.
- **Effort:** medium. This is the item that needs a design decision before code.

**Recommendation:** ship P1a first and separately. It is small, closes the
held-`LuaFunction` hole, and does not touch the guards. P1b is the more
architecturally interesting item and should not be rushed into the same change.

---

## P2 — `register_class` has no statics and no property accessors

`RegisterClass` reads `construct`, `extends`, `metamethods`, `methods`,
`readable`, `writable` (`src/lua-native.cpp:1687-1768`) — and `ClassDefinition`
in `types.d.ts:265-315` matches. Against the sol2 / LuaBridge / kaguya bar that
`BRIDGE-COMPARISON.md` §C explicitly sets, two pieces are missing:

**P2a. Static / class-level members.** `Player.count`, `Player.from_json(...)`.
All three C++ comparables support them. Today you register a separate global
table beside the class, which means the class name in Lua is not the whole
class. Approach: a `statics` key whose functions become closures on the class
table itself (not the instance metatable) and whose plain values are set
directly — the class table is already built, so this is where it goes.

**P2b. Named property accessors.** sol2's `property(getter, setter)`. Today
`readable` / `writable` are whole-instance booleans, so there is no computed
property, no validated setter, and no read-only field on an otherwise writable
object. Approach: a `properties: Record<string, {get?, set?}>` consulted by
`ClassIndex` / the `__newindex` path ahead of the `readable` / `writable`
fallback, so existing definitions keep their exact behaviour.

Both are per-class and, like `readable` / `writable`, are instance-construction
concerns rather than name resolution — so both should follow the existing
`extends` precedent and **not** inherit, with that stated in the doc comment the
way `extends` already states it (`types.d.ts:277-283`).

- **Layer:** binding only.
- **Instruments to extend (§15.6):** `roundtrip-matrix` — a static function and
  a property setter are both new paths a JS value crosses on. No new handle
  kind, no new tag, so nothing else is triggered.
- **Effort:** small, and independent of P1. Good candidate to land first.

---

## P3 — no `coroutine.close`, so abandoned coroutines skip their finalizers

There is no `lua_closethread` or `lua_resetthread` call anywhere in `src/`.
`release()` frees the registry slot; it does not run pending to-be-closed
variables.

This matters more here than it would in most bridges, because two shipped
features conspire to make abandoned coroutines ordinary rather than exceptional:

- `MetatableDefinition` in `types.d.ts:197` **specifically advertises**
  `__close` support, and calls it out because "it is easy to assume Lua 5.4+
  scoping features stop at the binding; it does not."
- the A4 iterator contract deliberately leaves a coroutine suspended when the
  loop `break`s (`types.d.ts:124-126`), so producing an abandoned suspended
  thread is a documented, expected outcome of a `for..of` with an early exit.

So the binding invites you to use `<close>`, and provides a normal path that
silently skips it.

**Approach.** Expose `close(coro)` (or a `close()` method on the coroutine
object, matching `LuaTableHandle.release()`) over `lua_closethread`, returning
the status so a failing `__close` is reportable rather than swallowed. Then
decide — and document — whether `release(coro)` should close before unref'ing.
It probably should, but that is a behaviour change to an existing method and
deserves its own line in `FEATURES.md` rather than being folded in silently.

- **Layer:** core (the `lua_closethread` call) and binding (the surface).
- **Instruments to extend (§15.6):** `exception-matrix` Axis B — a `__close`
  handler running from a *new* site is a new Lua C frame that can call back into
  the host, and "JS throws from `__close` during an explicit close" is exactly
  the escape cell that matrix exists to find. Also `lifecycle-matrix`: "closed,
  then reset" and "closed twice" are new Axis-B events on the coroutine handle.
- **Effort:** small in code, and the instrument extension is the larger half —
  which is the correct ratio for this repo.

---

## P4 — two smaller asymmetries

Recorded together because neither justifies its own change on its own, and both
are cheap if something else is already open in that area.

**P4a. Output redirection is one-way.** E1 gave you `print` / `io.write` → JS
via `set_print_handler`. There is no counterpart for `io.read` / stdin. A script
that prompts for input under a print handler gets its output captured and then
blocks on the real stdin, which in a server or Electron embedding is the wrong
answer twice over. Approach: an optional read handler on the same mechanism,
symmetrical with `set_print_handler`.

**P4b. `add_searcher` covers `require` only.** `dofile`, `loadfile` and
`io.open` still reach the real filesystem. Mostly a non-issue for a native addon
where the real filesystem is legitimately available — with one exception that
makes it worth recording: under `libraries: 'sandbox'` (`LIMITATIONS.md:40`)
`dofile` and `loadfile` are *cleared*, so a sandboxed script has no file access
at all, virtual or otherwise. If virtual file access under the sandbox is
wanted, `add_searcher` is the shape to follow and there is currently no
mechanism.

- **Instruments to extend (§15.6):** `roundtrip-matrix` for P4a (a handler is a
  new door values cross on). P4b depends on the shape chosen.
- **Effort:** small each. **Recommendation: do not schedule these on their own.**
  They are the kind of item that should wait for a concrete need, per the
  `README.md` rule — they are here so that the need, when it appears, does not
  have to rediscover them.

---

## P5 — a documentation defect found while verifying

`reviews/BRIDGE-COMPARISON.md:285` describes C1 as

> `register_class(name, { construct, methods, properties })`

There is no `properties` key in `RegisterClass` and never has been; the shipped
shape is `readable` / `writable`. The survey describes an API that did not land.

This is a one-line fix, but it is worth doing deliberately rather than as a
drive-by, because of what it is an instance of: `reviews/` is frozen and its
documents are supposed to be safe *because* "each only claims what was true on
its date" (`README.md:45`). This one did not — it was wrong on the day it was
written. The correct repair is a dated correction note at that line, not an edit
that makes the survey look like it was always right.

**If P2b ships, this resolves itself** and the note becomes "described ahead of
the implementation; landed August 2026". That is the tidier outcome and is
another small argument for doing P2 first.

- **Effort:** trivial. Do it with P2, or immediately if P2 is not scheduled.

---

## Recorded as decisions, not gaps

Two capability classes that comparable bridges have and this one structurally
does not. **Neither is planned work.** They are written down so they stop being
rediscovered, in the same spirit as A5 (worker pool).

**Generic JS reflection from inside Lua.** fengari exposes a `js` library —
`js.global`, `js.new`, `js.of` — so Lua can reach the JS environment without
host wiring. Here, everything must be registered from JS first. That is the
right call and should stay: an allowlist is the whole basis of the sandbox
story, and `libraries: 'sandbox'` would be meaningless with a `js.global` in
scope. Recorded because it is the largest single capability difference against
fengari and someone will ask.

**A raw Lua C API surface.** fengari exposes the entire `lua_*` / `lauxlib` API
to JS. This is deliberately a high-level bridge; the two-layer split described
in `CLAUDE.md` exists precisely so the C API stays on the C++ side. Recorded for
the same reason.

Both should move into `LIMITATIONS.md` — that is where "deliberately does not
do" belongs, and it already carries A5 and the state-snapshot entry in exactly
this form.

---

## Sequencing

| Order | Item | Why here |
|---|---|---|
| 1 | **P2** (+ P5) | Smallest, binding-only, independent, and it retires a false claim in a frozen document as a side effect. |
| 2 | **P1a** `call_async` | Closes a real capability hole (a held `LuaFunction` cannot await), reuses the existing driver, touches no guard. |
| 3 | **P3** `close(coro)` | Small code, real semantics question about `release()`, and the instrument work is the interesting part. |
| 4 | **P1b** `resume_async` | Needs a design decision on driving a caller-owned thread before any code. Ships with `Symbol.asyncIterator`. |
| — | **P4a / P4b** | Not scheduled. Wait for a concrete need. |
| — | Reflection / raw C API | Not planned. Move to `LIMITATIONS.md`. |

## Regression runs

Per §15.7, plus what §15.6 adds for each item:

```bash
npm run build-debug && npm test && npm run test-cpp   # after any change
npm run check-invariants                              # after any source change

# P1a / P1b — new execution doors
npm run exec-parity && npm run roundtrip-matrix
npm run lifecycle-matrix                              # P1b only (driven-thread lifetime)

# P2 — new value paths, no new handle kind
npm run roundtrip-matrix

# P3 — a __close frame at a new site
npm run exception-matrix && npm run lifecycle-matrix

npm run test-ts-asan                                  # before shipping any of it
```

Note that P1a and P1b each add a *door*, which is the trigger §15.6 names
explicitly. Adding the door without extending `exec-parity` and
`roundtrip-matrix` would leave the new path outside every generated search —
and "a capability that works through one door and not its siblings" is the
defect class this whole document is about.
