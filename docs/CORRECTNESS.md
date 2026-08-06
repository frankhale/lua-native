# CORRECTNESS

**Date:** August 4, 2026
**Status:** ⛳ **The correctness programme is closed.** Review is triggered by
**new surface, not by the calendar.**

**Scope:** what is in force. This document is the operational reference for the
correctness programme. Feature work is separate and has no roadmap document —
`FEATURE-HISTORY.md` and `BRIDGE-COMPARISON.md` are records of completed work (see
`docs/README.md`).

> **Read §15 first.** It is the exit record: the boundary enumeration and the
> criterion it was derived from, what is *not* covered, the closure assertions,
> the platform scope, the definition of "serious", **what reopens review
> (§15.6)**, and **the regression-run matrix (§15.7)**.
>
> | Section | What it is | Status |
> |---|---|---|
> | **§15** | The exit record — coverage, triggers, how to run | **Live. Start here.** |
> | **§15.9** | What a pass looks like now: no more numbered read-throughs | **Live.** Decided August 6, 2026. |
> | **§14** | Platform/CI closed as out of scope | **Live and binding.** Do not re-raise. |
> | §13 | What the final action items turned out to be | Record, with corrections worth keeping |
>
> **The history — §§1–12, the CR-17 assessment and the CR-20 revision, including
> the A1–A6 action items referenced below — is in
> [`CODE-REVIEW-HISTORY.md`](reviews/CODE-REVIEW-HISTORY.md).** It was split out on
> August 4, 2026 because a 900-line document with its operative content at the
> end is itself a drift hazard: five places to miss when updating a status, and
> this programme spent twenty-two passes on exactly that class of decay. Every
> item in it is done or closed.

---

# 13. Execution record — A1, A2, A5 (August 4, 2026)

**Done:** A1, A2, A5, and CR-21 F4a. *(A3 was completed afterwards by CR-22 and
A4 was closed by decision the same day — see HISTORY §12 for the final status of
every item. The action items themselves are defined in HISTORY §11.)*

Verified after each change and again at the end: **936 TypeScript tests**
(up from 934), **285 C++ tests**, nine invariants clean, `test-ts-asan` clean,
and all five harnesses clean (exec-parity 4015/2/0, exception matrix 297/297,
oracle 0 disagreements, round-trip 456 identical / 0 undocumented / parity 50
of 50).

**Every one of the three was measured before it was fixed, and all three turned
out to be stated slightly wrong.** That is the finding of this round, and it is
the same one the programme keeps producing about itself — an action item is a
hypothesis, and prose is where the boundary gets drawn too small.

## A1 — done, and the claim it rested on is now verified rather than asserted

HISTORY §11 said the provenance closure was "checked against the source, **already
correct**", and it is. Re-verified: two `ObjectWrap` subclasses, six
`napi_type_tag`s, `InstanceOf` at **zero** live uses (every remaining mention is
a comment saying it is *not* the mechanism — see A5), and `SharedTable::Unwrap`
the only unwrap of a JS-supplied value.

**What HISTORY §11 did not say is *why* the unbranded class is safe, and that gap was
worth closing by experiment.** `LuaContext` carries no brand. The obvious worry
is the CR-20 F5 shape one door over: `Object.getPrototypeOf(ctx).execute_script
.call(sharedTable, …)` reaches an ObjectWrap method with a foreign receiver, and
node-addon-api unwraps `this` internally. Driven, in both directions and with a
plain object:

```
LuaContext.execute_script.call(sharedTable)  -> TypeError: Illegal invocation
SharedTable.set.call(luaContext)             -> TypeError: Illegal invocation
init({}, { shared: { s: luaContext } })      -> TypeError: shared.s must be a
                                                shared table created with
                                                createSharedTable()
init({}, { shared: { s: genuine } })         -> constructed
```

All refused, and the *reasons differ*: `napi_define_class` gives instance
methods a V8 signature, so a foreign **receiver** is rejected before any unwrap
runs, while an **argument** has no such check and is what the type tag exists
for. That receiver/argument split is the real closure, and it is now written
down where the next person will look instead of being rediscovered.

**The invariant** (`objectwrap-branding`, the ninth) computes it: the ObjectWrap
subclasses, whether each brands itself at construction, and every `X::Unwrap(`
scored `TAG-CHECKED` or `UNGUARDED` by whether a `CheckTypeTag` precedes it in
the same function. Shown able to report dirty in both failure modes — deleting
the `CheckTypeTag` flips the row to `UNGUARDED`, and a third `ObjectWrap`
subclass appears as `branded: no`. The unwrap-site *count* is frozen too, so a
regex that goes blind cannot report a clean sheet.

**The audit of the other invariants came back better than expected**, and the
reason is structural rather than lucky. HISTORY §11 asked whether each frozen universe
is a closure or an enumeration. The answer splits by shape:

- **Row-shaped** (`callscope-classification`, `lua-next-sites`,
  `occupancy-policy-sites`, `core-call-guarding`): the frozen key set *is* the
  universe, and `diffInvariant` reports a vanished key as `(gone)`. Verified by
  renaming a classified function: the row disappeared and was reported. These
  need no added coverage number — they already have one, in a form nobody had
  named.
- **Count-shaped** (`greppable-counts`, `exception-surface`, plus the two new
  ones): a count that goes blind reports `0`, which is a value and not a missing
  key, so it needs its own total. Each has one. This is the distinction CR-21 F3
  ran into the hard way, and it is now a comment on `diffInvariant`.

## A2 — done; its central number was wrong in a way that mattered

HISTORY §11: "**70 bare `.toThrow()` / `.toThrowError()` call sites** … Give each a
pattern." Measured: **71**, of which **28 are `.not.toThrow()`**. The real
target was **43**.

**Patterning the 28 would have made the suite weaker, not stronger.** There is
no message to match on a negative assertion, and `expect(f).not.toThrow(/x/)`
asserts only "did not throw *this*" — it permits every other throw. So the
action item, followed literally, would have introduced 28 holes while closing
43. The invariant exempts `.not.` by design and says why.

All 43 now carry patterns, and none was guessed: each site's real message was
**harvested** by running the suite with a regex whose `test` was intercepted, so
the patterns match what the code actually produces rather than what it was
assumed to produce. (Three rounds were needed — a site sitting after another
failing assertion in the same test never executes, so those had to be
instrumented alone.) The suite is green on all 936.

`assertion-strength` (the eighth invariant) freezes **0 bare positive
assertions** and, alongside it, the **362 assertions examined** — because "0
bare" is exactly what a broken scanner reports too. It names an offender by its
`it(...)` title rather than by line number, and was shown to fire.

**The process-global guard is the part with the most leverage.** An `afterEach`
now asserts that no test left `Symbol.hasInstance` patched on the `SharedTable`
constructor. Proven dirty by deleting the `finally` that CR-20 added: the guard
fires immediately — and **94 tests fail**, which is the measured blast radius of
the leak that hid CR-20 F5 for five passes. It was latent only because the
offending test happened to be the last one to construct a shared context.

## A5 — done, and it was three comments, not one

HISTORY §11 named `lua-native.cpp:866–881`. Two more said the same wrong thing:

| Site | Claimed | Actually |
|---|---|---|
| `lua-native.cpp` `AsSharedTable` header | "the load-bearing guard is one line lower" (`Unwrap`) | `CheckTypeTag`; the `Unwrap` claim is what CR-20 F5 aborted the process through |
| `lua-native.cpp` `CreateSharedTable` | "identified by an InstanceOf check that no user object can satisfy" | a type tag — and "no user object can satisfy" is precisely what CR-15 F5 disproved |
| `lua-native.h` `SharedTable` class doc | "identified by an InstanceOf check against the stored constructor" | same |

All three now describe the brand, and each records both superseded claims so
neither can be reinstated by someone reading only one of them. The
`AsSharedTable` body lost a redundant third explanation. Every surviving mention
of `InstanceOf` in `src/` is now a statement that it is *not* the mechanism.

## What remains

- **A3** — ✅ done. CR-22 built the lifecycle matrix for the last row *and*
  found the enumeration itself was short (CR-22 F2), adding `cross-context`.
  The completed enumeration is §15.1.
- **A4** — ✅ **closed the same day by the project owner: out of scope.** See
  §14. Not a gap, not deferred, not a caveat.
- **A6** — ✅ done: it is §15.

---

# 14. Scope decision: platform coverage and CI are closed (August 4, 2026)

**Decided by the project owner. This supersedes every recommendation in this
document, in `CODE-REVIEW-18`, and in any earlier pass, on these two subjects.**

> **This project is macOS-only and has no CI, and neither is a gap.**
> Do not raise either as a finding, a risk, an action item, a release blocker,
> or a caveat on a "clean" or "complete" conclusion. Until the owner says
> otherwise, they are settled.

### What is closed

- The untested targets declared in `binding.gyp` (mac x64, win x64). Not a
  correctness gap. **Do not propose narrowing `binding.gyp` either** — the
  proposal itself is part of what was closed.
- CI, in every form: hosted runners, pre-push hooks, "runs without anyone
  remembering to run it" automation.
- `CODE-REVIEW-LEDGER` M5 (`MACOSX_DEPLOYMENT_TARGET`). Not a blocker.
- HISTORY §1 point 5, §3 in full, §10 criterion 5, §12 row A4, and A4 itself. Where
  those still argue the case, they are historical record, not live advice.

### Why this is written down as forcefully as it is

Because it kept coming back. In HISTORY, the platform/CI question was raised in
§1.5, argued at length in §3, promoted to "the largest un-searched risk in the
project" in §6, embedded as one of the five end-state criteria in §10, and
listed as A4 in both §11 and §12 — and it was carried forward each time under
the word
**"deferred"**, which reads as *still open, revisit next pass*. Every pass then
paid to re-derive a conclusion the owner had already reached, and the owner
named it as time wasting.

**The lesson generalizes past this one item, and is the reason for the emphasis:
"deferred" is not a resolution.** An item parked with that word has no owner and
no closing condition, so it regenerates on every review. A decision the owner
has made should be recorded as *closed* with the reasoning frozen behind it —
which is what this section does. If a future pass finds itself weighing macOS
versus Windows, or arguing that habit is a fragile substitute for automation, it
has rediscovered a closed question and should stop.

### What the end state now requires

HISTORY §10's criteria drop from five to four: the boundary enumeration
(§10.1), closure over computed closures (§10.2), instruments that state their
own universe (§10.3), and tests that can distinguish the failure they exist to
catch (§10.4).
Criterion 5 is struck. **A6 is therefore blocked on A3 alone** — the single
remaining boundary, the userdata/class lifecycle across `reset` and GC.

### Revocability

The owner's phrasing was "until further notice", so this is a decision rather
than a permanent property of the project. If cross-platform support or CI is
ever wanted, reopen it deliberately — but nothing should reopen it implicitly,
and no review pass should reopen it at all.

---

# 15. The exit record (August 4, 2026)

**This is A6.** A1, A2, A3 and A5 are done; A4 was closed by decision (§14).
The programme's open items are therefore empty, and this section is what HISTORY §11
asked to be written down before review changes mode: the boundary enumeration,
the closure assertions, the platform scope, and the definition of "serious".

**State at the exit:** 942 TypeScript tests, 285 C++ tests, 9 machine-checked
invariants, 7 generated search harnesses, 4 sanitizer harnesses. All green.

---

## 15.1 What counts as a boundary

The enumeration below is derived from a **criterion**, not assembled as a list,
and that distinction is the substance of this section. Every earlier list in the
series was organised by API surface — "the async methods", "the handle methods"
— which is what is easy to enumerate and is why cross-context never appeared on
one for twenty-one passes (CR-22 F2).

> **A boundary is a place where two systems with different rules exchange a
> value, such that a mismatch produces a plausible answer rather than an error.**

The three clauses each do work. *Two systems with different rules* is what makes
a mismatch possible at all. *Exchange a value* is what makes it a crossing
rather than an internal invariant. *A plausible answer rather than an error* is
what makes it need a search — anything that fails loudly is caught by the suite.

Applying it to this codebase gives seven, and each has a generated search:

| # | Boundary | The two rule-sets | Instrument |
|---|---|---|---|
| 1 | JS value → Lua | JS types / Lua types | `roundtrip-matrix` (4 modes × 19 doors × 50 values) |
| 2 | Lua value → JS | Lua types / JS types | `diff-oracle` mode B (1339 cases) |
| 3 | Embedded VM → reference Lua | this VM's hooks / stock Lua | `diff-oracle` mode A (1339 cases) |
| 4 | C++ exception → Lua C frame | C++ unwinding / Lua longjmp | `exception-matrix` (39 × 11, process/cell) |
| 5 | One execution door → another | sync / worker / coroutine / bytecode | `exec-parity` (1339 × 3) |
| 6 | Handle → a later state of its context | live handle / retired state | `lifecycle-matrix` (11 × 8, process/cell) |
| 7 | Context → context | two independent `lua_State`s | `cross-context` (handles, data, isolation) |

**Two further instruments exist and neither is an eighth boundary**, recorded
here so nobody counts them as one. `binding-balance` (August 6, 2026) is the
second: it searches what the binding *retains* rather than what crosses it, which
is not a value exchange between two rule-sets and so does not meet the criterion
above. It is a resource-lifetime search, filed as such — see §15.10 — and its
universe is derived by `surface-census`'s census F rather than from this list.
The first:

`capability-matrix` searches an *axis* that cuts
across the seven: what a `libraries` / `allowBytecode` configuration grants. One
of its three properties meets §15.1's criterion exactly — an entry point that
returns normally while doing nothing observable (`LIMITATIONS.md` §8's
accept-and-retain class) is a plausible answer rather than an error. The other
two, the seal and the bytecode-door implication, are capability assertions that
ride along because they share the fixture, and are labelled as such in the
harness rather than filed under a criterion they do not meet.

**The enumeration is complete against that criterion.** That is a stronger claim
than "we found nothing" and a weaker one than "there are no defects" — it says
the crossings have been identified by a rule rather than by recollection, and
each one has a search that has demonstrated it can report dirty.

## 15.2 What is *not* covered by a generated search, and why

Recorded because an exit that lists only its strengths is the same failure the
programme spent twenty-two passes correcting.

> **The rule this table is generated from** (stated August 6, 2026, W4 — it had
> none, which is the same defect §15.6 was found to have in CR-23):
>
> **An area belongs here when it fails a clause of §15.1's criterion, and the
> row must name which clause.** That is the whole test. The criterion is *two
> systems with different rules exchange a value such that a mismatch produces a
> plausible answer rather than an error*; an area that satisfies all three
> clauses is a boundary and needs an instrument, not an excuse.
>
> Applied to the rows below: resource limits and module resolution both fail
> **clause three** — they abort or raise, loudly, so the suite catches them.
> Re-entrancy fails **clause two** in its general form: it is not a value
> crossing but a call arriving while another is in flight, which is why it was
> closed structurally (one guard, one policy set) rather than by a matrix. Data
> races fail nothing — they are a genuine gap, and the row says so rather than
> justifying itself.
>
> **The distinction that keeps this honest:** a row saying "covered by the suite
> instead" is a claim about *sufficiency* and needs the clause it fails; a row
> saying "we have not searched this" is an admission and needs no clause. Mixing
> the two is how an exclusion list becomes a place to put things.

| Area | Covered by | Why not a matrix |
|---|---|---|
| Re-entrancy / occupancy (calling the API from inside a callback, metamethod, `__gc`, converter or Proxy trap) | `occupancy-policy-sites` invariant + a **generative `assert`** in `RejectIfOccupied` that fires for any policy naming a claim below `AsyncInFlight` without naming it, + the suite | CR-16's injection matrix found the last defect here and was a one-off; the class was then closed **structurally** (one guard, one policy set) rather than by continued searching. The assert covers policies that do not exist yet, which a matrix cannot. |
| Resource limits (`maxInstructions`, `maxMemory`, `timeout`) | 117 test references; `exception-matrix` covers the `ERRMEM` longjmp frame | The failure mode is a loud abort of the VM, not a plausible wrong answer, so it fails clause three of the criterion. |
| Module resolution (`require`, search paths, JS searchers) | 135 test references; `exception-matrix` covers the throwing-searcher frame | Same reason: a failed resolution raises. |
| Data races | 4 sanitizer harnesses, `test-ts-tsan` explicitly best-effort | TSan cannot see libuv/V8/Lua synchronization, so a clean run is not a proof. Stated as a limitation in `CLAUDE.md`, not as coverage. |

## 15.3 The closure assertions

**The principle underneath them, which is the one lesson the whole programme
reduces to:**

> **Fix classes, not sites.**

CODE-REVIEW-1 fixed the instances it found; CODE-REVIEW-2 found more instances
of the same hazard classes and observed that "several of the underlying hazard
classes have additional sites the first review didn't enumerate". Every high
from CR-6 onward was a version of that — a class fixed across the members
someone could enumerate, short by one. CR-17 F2 fixed one of four round-trip
markers; CR-21 F2 covered arrays and objects but not the two recursing
builtins; CR-22 F1 fixed one marker and the cross-context instrument
immediately found a fifth.

The corollary is what turned it into working code: **an enumeration decays, so
compute the closure and assert it.** A list in a comment is wrong within a
commit here — that is measured, not felt (the `CallScope` enumeration was
repaired in CR-13, CR-14 and CR-15 and was wrong each time). The invariants
below exist so that a new member of a closed class cannot arrive outside it
without turning the suite red.

This is stated here rather than left in `reviews/CODE-REVIEW-HISTORY.md`
because it is the *why* behind everything in this section, and a rule whose
rationale lives only in an archive is a rule that gets simplified away. This
codebase has the receipt: CR-11 F1 was a use-after-free reintroduced when a
later modernization pass reverted a `NOLINT`ed loop whose reason was not
attached to it. The comment now says "The NOLINT is load-bearing."

Ten invariants, each computing a universe from the source and comparing it to a
frozen answer. The ones that close a defect *class* rather than track a count:

| Invariant | Class closed | How a new member is caught |
|---|---|---|
| `core-call-guarding` | A binding path to a throwing core call without a `try` (CR-6 F1) | Transitive fixpoint over the core; a new throwing method changes the map |
| `objectwrap-branding` | Provenance ≠ kind: an `ObjectWrap` unwrapped from a JS value without a brand check (CR-15 F6, CR-20 F5) | Every `X::Unwrap` scored `TAG-CHECKED`/`UNGUARDED`; a third wrapped class appears as `branded: no` |
| `assertion-strength` | A bare `.toThrow()` that passes on the wrong error (CR-20 F5) | Bare positives frozen at 0, and the number examined frozen beside it |
| `exception-surface` | Drift in the throw/catch/barrier counts the CR-18 axes were derived from | Any change to the counts |
| `callscope-classification`, `lua-next-sites`, `occupancy-policy-sites` | Hand-maintained enumerations that decayed in CR-13/14/15 | The frozen key set *is* the universe; a vanished member reports `(gone)` |
| `scanner-coverage`, `greppable-counts` | The scanners' own blind spots (CR-19 F2) | Unattributed definitions and totals are frozen |
| `surface-census` | **§15.6's trigger table decaying like every other hand-maintained enumeration (CR-23 F4)** | Options, value-taking entry points, inbound markers and host-callable Lua C frames are each computed from the source and scored against the instrument that covers them; anything neither covered nor ledgered is `UNCLASSIFIED` |

Plus two compile-time and one runtime assertion in the source: `AllTagsDistinct`
(`static_assert`), the occupancy-policy `assert`, and the `ContextLiveness`
pairing.

## 15.4 Platform scope

**macOS/arm64. There is no CI, and neither is a gap** — see §14, which is
binding on this point and supersedes HISTORY §1.5, HISTORY §3 and HISTORY §10 criterion 5.

## 15.5 The definition of "serious"

Unchanged from HISTORY §10, and it is what makes the exit falsifiable:

> A finding is **serious** if an ordinary caller — one writing plausible
> JavaScript, without forging engine internals — can reach a crash, a memory
> error, a silent wrong value, or a leak.

By that definition the last five passes produced: CR-18 none, CR-19 none, CR-20
one (F5), CR-21 none, CR-22 one (F1, and narrower than first reported).

## 15.6 What reopens review

Review is now **triggered by new surface, not by the calendar.** Any of these
is a trigger, and the trigger names the instrument to extend:

| Trigger | Extend |
|---|---|
| A new public entry point that takes a JS value | `roundtrip-matrix` (a door) |
| A new entry point that executes a script | `exec-parity` (a door) |
| A new *asynchronous* entry point | both of the above — and check the door's own vacuity control proves it really awaits |
| A new handle kind, or a new marker on a JS object | `lifecycle-matrix` (Axis A) **and** `cross-context` (handle cases) |
| **A new option that changes *conversion*** | **`roundtrip-matrix` (Axis C, a mode) — and `exec-parity` if it is execution-visible** |
| **A new option, preset or library that changes *capability*** | **`capability-matrix` (Axis A, a config)** — the split is stated below |
| A new Lua C frame that can call back into the host | `exception-matrix` (Axis B) |
| **A new member that retains a JS value** | **`binding-balance` (a container, with a lifetime policy) — and a counter in `info().bindingRefs`** |
| A new `ObjectWrap` subclass | nothing — `objectwrap-branding` will fail until it is branded |
| A new `napi_type_tag` | nothing — `greppable-counts` and `AllTagsDistinct` will fail |
| A new occupancy policy | nothing — the generative `assert` will fire |
| A Lua version bump | `diff-oracle` (both modes) — the reference moves |
| A new threading mode | everything, plus a reconsideration of §15.2's race row |

The rows that say "nothing" are the ones worth noticing: for four classes the
mechanism now fails closed without anyone deciding to look.

**Since August 6, 2026 the table itself is checked (W4).** `surface-census`'s
fifth census reads these rows *out of this document* and requires each to carry a
disposition — `COMPUTED` (a census derives its universe), `FAILS-CLOSED` (no
census needed, the mechanism turns the suite red on its own), or `MANUAL` with
its reason. A row added here in prose without a ruling reports `UNDISPOSED` and
the suite goes red; a disposition whose row is deleted reports `STALE`. Twelve
rows, twelve dispositions: five computed, three fail closed, four manual.

That closes the level CR-23 opened. The trigger table was the enumeration
governing when anyone looks, and it had no way to notice a row that had never
been ruled on — which is precisely how `binaryStrings` went two commits
unsearched. **The four `MANUAL` rows are the honest residue**: "executes a
script" and "is asynchronous" are properties of a method body rather than of a
signature, a Lua version bump happens in vcpkg where nothing here can see it, and
a threading mode would invalidate every instrument's assumptions rather than add
a row. Those four are where a human still has to decide, and now they are the
*only* four.

**Since August 6, 2026 the rest of the table is computed too, and that is the
point of the `surface-census` invariant** (`tools/invariants/surface-census.mjs`).
The four triggers that are mechanically decidable — a new option, a new
value-taking entry point, a new inbound marker, a new host-callable Lua C frame
— have their universe derived from the source and scored against the instrument
that claims them. Surface that is neither covered nor deliberately ledgered
reports `UNCLASSIFIED` and turns the suite red. So the table above is now
documentation of a check rather than the check itself, which is the state every
other enumeration in this programme had to reach before it stopped decaying.

Two things it deliberately does not do, both recorded because the temptation is
obvious. It does **not** demand parity between `lifecycle-matrix` and
`cross-context` — the note above about the coroutine cursor is exactly why, and
a census that required every handle kind in both would regenerate CR-22 F1's
false finding on every run. And `UNCLASSIFIED` is **not** a defect claim; it is
the same contract `callscope-classification` offers, where a row that changes
class is a review item and nothing more. What it ends is the third state:
surface that is neither searched nor consciously excluded, which is what
`binaryStrings` was for two commits and what §15.6 had no way to notice.

**Exercised August 5, 2026, and it worked.** The `INTEROP-PARITY-PLAN` work added
three entry points that take JS values, two that execute, a handle kind, nine Lua
C frames and a `PropertyAccessDenied` type. Following this table found three
defects that review had not:

- `check-invariants` flagged `DetachRuntimeHandlers -> SetFileReader` as
  `UNGUARDED_AND_PROPAGATES` — a `RunProtected` removal reachable from a teardown
  path with no handler above it, i.e. the CR-6 F1 abort class, in code that had
  just been written and read twice.
- `exception-matrix`, on the new `read_handler` frame, showed a non-`Error` throw
  losing its text — CR-18 F2 recurring at a new site, the first time it had been
  caught by the instrument rather than by a person.
- The `assertion-strength` invariant refused a bare `.toThrow()` in a new test,
  which is the fail-closed row above doing exactly what it promises.

(These three are what the *table* caught. The plan's banner records a partly
different trio — the "three things found while building": the stale pending
promise, the swallowed getter exception, and the same teardown abort, which is
the one member the two lists share. Five distinct catches in all; neither list
subsumes the other.)

Two further points the table does *not* cover, recorded so the next pass has
them:

- **A new handle kind does not automatically belong in `cross-context`.** The
  async coroutine cursor is a real Axis-A handle for `lifecycle-matrix` (its
  state is shared_ptr-owned and can outlive the iterator) and is *not* a
  cross-context case, because it carries no marker the addon ever reads back.
  Listing it there reproduces CR-22 F1's false finding. The distinction is
  "is there a marker to reinterpret", not "is it a handle".
- **A new door needs its own vacuity control.** `exec-parity` requires each door
  to prove the property that makes it *that* door; a door whose control only
  showed it returns the right value would pass while being a thin synchronous
  wrapper.
- **So does a new mode, and for the same reason.** `roundtrip-matrix`'s Axis C
  requires each mode to demonstrate its option is actually in effect before its
  cells are counted. A mode whose option were silently ignored would round-trip
  everything, agree at every door, and report a clean column that searched
  nothing — a whole axis of false confidence, which is worse than an absent one.

**Exercised again August 6, 2026 (CR-23), and the table was found short.** The
`sandbox` / `binaryStrings` / `strictConversion` work matched **no row above** —
it added no entry point, door, handle kind, marker, frame, `ObjectWrap`, tag or
policy — so the trigger correctly fired nothing while two defects sat in the
region it did not name. The mode row was added as a result, and it is the fourth
level at which this codebase has found a class boundary drawn one member short:
in the product (CR-17), in a fix (CR-21), in an instrument (CR-22's drafts), in
the boundary enumeration (CR-22 F2), and now in the trigger table itself.

**And the mode row was itself half a row (August 6, 2026, W1).** CR-23 wrote it
as "a new option that changes conversion **or VM rules**", which reads as one
trigger and is two. An option that re-rules *conversion* is a `roundtrip-matrix`
mode; an option that re-rules *capability* — which doors exist, which loaders
run — cannot be, because no round-trip mode would ever set it. `surface-census`
inherited the conflation and scored coverage as "a round-trip mode sets this
key", so `libraries` and `allowBytecode` were not merely unclassified but
**unclassifiable**: `LEDGERED` was the only verdict they could reach. Ruling on
them found a guard five doors short of its own claim
(`reviews/UNSEARCHED-REGIONS-PLAN.md` §2.1). The table now splits the row, the census
ranges over a list of instrument axes rather than one instrument, and
`capability-matrix` is the eighth harness.

The lesson that generalizes, and the reason §15.1 states a *criterion* rather
than only a list: **an enumeration has to record the rule that generated it, or
it cannot be checked for completeness — only extended when something leaks
past.** The boundary list has its criterion (§15.1). This table did not have
one. It does now:

> A trigger is anything that adds a **new way for a value or a call to cross a
> boundary** — a new place (an entry point, a frame, a handle kind) *or a new
> rule at an existing place* (an option, a preset, a version bump). The second
> half is what the table was missing, and it is the half that is cheap to add
> and easy to forget, because it ships as a flag rather than as a function.

## 15.7 Regression mode

```bash
npm run build-debug && npm test && npm run test-cpp   # after any change
npm run check-invariants                              # after any source change
npm run lifecycle-matrix && npm run cross-context     # after handle/marker or context-boundary changes
npm run exec-parity                                   # after execution-path changes
npm run oracle                                        # after core VM changes
npm run roundtrip-matrix                              # after conversion changes, or a new conversion option/mode
npm run capability-matrix                             # after library/preset/seal or bytecode-guard changes
node tools/exec-parity/run.mjs --config=sandbox       # door parity under a sealed state
node tools/diff-oracle/run.mjs --mode=b --binary      # values out under binaryStrings, vs stock Lua
npm run exception-matrix                              # after error-path changes
npm run binding-balance                               # after any change to what the binding retains
node tools/gc-stress/run.mjs                          # after handle/finalizer changes: the aggregate registry balance
npm run test-ts-asan                                  # before a release
npm run test-harness-asan                             # before a release: the adversarial paths instrumented
```

The suite and the invariants are the always-run pair; the harnesses are keyed to
what changed. `test-ts-asan` is the highest-value sanitizer and the one to run
before shipping.

## 15.8 What this record does not claim

Three caveats, carried forward deliberately.

**"Complete" is a claim about the enumeration, not about the code.** Seven
boundaries have searches; the searches have found what they found. A defect
inside a boundary that its instrument's axes do not reach is still possible —
`exec-parity` covers four doors and there are more entry points than four,
`lifecycle-matrix` covers eleven handle kinds under eight events.

**The per-instrument yield law held for eight instruments and broke on the
ninth (August 6, 2026).** Every genuinely new instrument found something, and
every re-run of an existing one found nothing new — until `binding-balance`,
which searched a region no instrument had ever read and came back empty
(§15.10). The amended law, with the failure included rather than explained away:

> A new instrument finds about one thing **in the region it searches**. A region
> that was unsearched because nobody could *read* it is not thereby a region
> where something is wrong.

The distinction is worth the words. The eight prior instruments were pointed at
regions that were unsearched because nobody had *thought to look* — and code
nobody has examined tends to contain something. The binding's bookkeeping was
unsearched for a different reason: it had no accessor, so the question could not
be asked at all. Those are different kinds of dark, and only the first predicts
defects. The revised expectation for a tenth instrument therefore depends on
which kind of region it is aimed at, and that is a question to answer before
building it rather than after.

**The instruments are the newest and least-tested code here.** The lifecycle
matrix produced eight false findings before it produced a true one, every one of
them the harness misreading its own probe, several with passing controls at the
time. Both halves of the rule that came out of that are in `tools/README.md`,
and they are the most likely thing in this programme to be needed again.

## 15.9 What a pass looks like now (decided August 6, 2026)

**There are no more numbered general read-throughs.** CODE-REVIEW-23 is the last
one. The evidence is the yield law's other half, and by August 2026 it had
enough data points to act on:

| Pass shape | Yield |
|---|---|
| A named sweep against a **declared unsearched region** (`INTEROP-PARITY-PLAN`) | 5 catches, 3 of them defects review had not found |
| A **new axis** on an existing instrument (CR-23's mode sweep; W1's option ruling) | 1 serious each |
| Re-running the existing instruments | 0, every time |
| A general read-through of code the instruments already cover | documentation nits |

So a pass now has three obligations, and they replace the old format entirely:

1. **Declare the unsearched region up front** — which boundary, which axis, and
   why nothing currently searches it. "Read the diff again" is not a region.
2. **Deliver an instrument and a ledger entry**, not a document. The write-up is
   a by-product; the thing that survives is the check that runs next time.
   Prose rots, and this programme has three reflective documents to prove it
   (`docs/README.md`'s corollary).
3. **Prove the instrument can report dirty before believing it clean**, and
   drive every dirty result to a hand-run reproduction before believing *that*.
   Twelve of this tree's findings have been the harness misreading itself; that
   is more than any single defect class in the product.

**The trigger is unchanged and is now checked**: new surface that §15.6 names, or
`surface-census` reporting `UNCLASSIFIED` / `UNDISPOSED`. Never a date. A
calendar-driven pass is how this programme spent twenty-two rounds re-deriving
conclusions it had already reached.

## 15.10 The closing condition, and where it stands (moved here August 6, 2026)

`UNSEARCHED-REGIONS-PLAN.md` was written and executed on August 6, 2026 and now
lives in [`reviews/`](reviews/UNSEARCHED-REGIONS-PLAN.md). Its five workstreams
are done and its narrative is history. **What survives as an instruction is its
§7 closing condition**, which is carried here because it is the answer to "what
should we do about correctness?" in a form that can be checked rather than felt —
and because leaving it in a plan document is how that question regenerates every
few weeks (§14, on the word *deferred*).

> **Review is producing nothing significant when all five hold:**
>
> 1. `surface-census` reports **0 `UNCLASSIFIED`**;
> 2. every enumeration in `docs/` **cites the rule that generated it**;
> 3. every instrument runs under **every mode that re-rules its boundary**, each
>    mode carrying a vacuity control;
> 4. **ASan covers the harnesses as well as the suite**, and a leak check exists
>    that works on macOS;
> 5. **two consecutive *new* searches, aimed at regions chosen by §15.1's
>    criterion, return zero serious findings.**

| # | Clause | State (August 6, 2026) |
|---|---|---|
| 1 | 0 `UNCLASSIFIED` | ✅ met — and 0 `UNDISPOSED` on §15.6's trigger table itself |
| 2 | Every enumeration cites its generating rule | ✅ met |
| 3 | Every instrument runs under every re-ruling mode | ✅ met, with one cell ruled against and the ruling recorded |
| 4 | ASan over the harnesses; a macOS-viable leak check | ✅ met — `test-harness-asan`, plus three balance checks (two Lua-side, one binding-side) |
| 5 | **Two consecutive new searches return zero serious findings** | ⏳ **1 of 2** — `binding-balance`, August 6, 2026 |

**Clause 5 moved for the first time on August 6, 2026, and the way it moved
matters more than the fact.** Clauses 1–4 are the work; clause 5 is the evidence,
and it does not move by re-running instruments or by tightening the ones that
exist — §15.9's table is the reason. A *new axis* on an existing instrument does
not count either: W1 and CR-23 were both new axes and both found a serious
defect, which is a reason to keep building them and not a clause-5 data point.

### The first data point: `binding-balance` (August 6, 2026)

The region was the one named below as candidate 1 and it is now searched. Both
prior leak checks measure the **Lua registry**; the binding's own retained
references — the callbacks, userdata wrappers, converters, searchers, accessors
and handlers it holds so Lua can reach them — were measured by nothing, because
nothing could read them. `info().bindingRefs` is the accessor that made the
question askable; `tools/binding-balance` is the search; `surface-census`'s
census F scores every retaining member against a declared lifetime policy, so a
new one fails closed. **Zero findings in the product**, across 13 containers × 4
series plus every counter watched in every context.

**Three things about that zero, stated because a clean result is exactly when
this record should be least comfortable:**

- **It is the first new instrument here to find nothing**, which contradicts
  §15.8's per-instrument yield law on its face. The law is amended rather than
  abandoned below.
- **The instrument found ten defects in itself first**, in two rounds, both the
  documented class: it churned *fresh registrations* and called the resulting
  growth a leak, when a named host function persisting until its name is reused
  is what `LuaContext::SetGlobal` says it does, and a converter list with no
  removal API grows because you called the API. `tools/binding-balance/policy.mjs`
  records the misreading in full. Every one of those was caught by driving the
  dirty result to a reproduction, which is the rule that has now paid twelve
  times.
- **The API decision was the actual blocker, not the search.** This region sat
  uncovered because an instrument may not add public surface to make itself
  possible, and `tools/README.md` had recorded that as a standing gap. Nothing
  about it was hard once someone ruled on the accessor.

**The next search, and what would make it count.** The remaining candidate is
**the four `MANUAL` rows in §15.6**: two of them ("executes a script", "is
asynchronous") look mechanizable from a method body rather than a signature,
which would convert them to `COMPUTED`. That is hardening of the W4 kind and is
unlikely to move clause 5 on its own — it tightens a census rather than searching
a region. So clause 5's second point needs a region nobody has named yet, and
the honest position is that **no such region is currently identified**. That is
the most interesting state this record has been in: the list of known-unsearched
regions is empty for the first time, which is either the closing condition
arriving or the enumeration being one member short again. §15.8's first caveat
says which of those to assume.

**And two things deliberately not on the list**, carried over from the plan's §8:
do not build a ninth instrument for its own sake — §15.8 predicts it would find
about one thing, but there is no unsearched *boundary* left to aim it at, and the
remaining yield is in modes and intersections. And do not re-run the existing
eight expecting yield; that is the half of the yield law with eight
confirmations. Run them as regression (§15.7), not as search.

---

**The programme is closed.** A pass that finds a documentation nit is now the
expected result rather than a disappointment, and the next review should be
provoked by a change in the code, not by a date.
