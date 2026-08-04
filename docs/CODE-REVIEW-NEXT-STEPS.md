# CODE-REVIEW-NEXT-STEPS

**Date:** August 4, 2026
**Status:** ⛳ **The correctness programme is closed.** Review is triggered by
**new surface, not by the calendar.**

**Scope:** what is in force. This document is the operational reference for the
correctness programme; `FUTURE.md` is the feature roadmap and is separate.

> **Read §15 first.** It is the exit record: the boundary enumeration and the
> criterion it was derived from, what is *not* covered, the closure assertions,
> the platform scope, the definition of "serious", **what reopens review
> (§15.6)**, and **the regression-run matrix (§15.7)**.
>
> | Section | What it is | Status |
> |---|---|---|
> | **§15** | The exit record — coverage, triggers, how to run | **Live. Start here.** |
> | **§14** | Platform/CI closed as out of scope | **Live and binding.** Do not re-raise. |
> | §13 | What the final action items turned out to be | Record, with corrections worth keeping |
>
> **The history — §§1–12, the CR-17 assessment and the CR-20 revision, including
> the A1–A6 action items referenced below — is in
> [`CODE-REVIEW-HISTORY.md`](CODE-REVIEW-HISTORY.md).** It was split out on
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
- `CODE-REVIEW-DEFERRED` M5 (`MACOSX_DEPLOYMENT_TARGET`). Not a blocker.
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
| 1 | JS value → Lua | JS types / Lua types | `roundtrip-matrix` (12 doors × 50 values) |
| 2 | Lua value → JS | Lua types / JS types | `diff-oracle` mode B (1339 cases) |
| 3 | Embedded VM → reference Lua | this VM's hooks / stock Lua | `diff-oracle` mode A (1339 cases) |
| 4 | C++ exception → Lua C frame | C++ unwinding / Lua longjmp | `exception-matrix` (27 × 11, process/cell) |
| 5 | One execution door → another | sync / worker / coroutine / bytecode | `exec-parity` (1339 × 3) |
| 6 | Handle → a later state of its context | live handle / retired state | `lifecycle-matrix` (11 × 8, process/cell) |
| 7 | Context → context | two independent `lua_State`s | `cross-context` (handles, data, isolation) |

**The enumeration is complete against that criterion.** That is a stronger claim
than "we found nothing" and a weaker one than "there are no defects" — it says
the crossings have been identified by a rule rather than by recollection, and
each one has a search that has demonstrated it can report dirty.

## 15.2 What is *not* covered by a generated search, and why

Recorded because an exit that lists only its strengths is the same failure the
programme spent twenty-two passes correcting.

| Area | Covered by | Why not a matrix |
|---|---|---|
| Re-entrancy / occupancy (calling the API from inside a callback, metamethod, `__gc`, converter or Proxy trap) | `occupancy-policy-sites` invariant + a **generative `assert`** in `RejectIfOccupied` that fires for any policy naming a claim below `AsyncInFlight` without naming it, + the suite | CR-16's injection matrix found the last defect here and was a one-off; the class was then closed **structurally** (one guard, one policy set) rather than by continued searching. The assert covers policies that do not exist yet, which a matrix cannot. |
| Resource limits (`maxInstructions`, `maxMemory`, `timeout`) | 117 test references; `exception-matrix` covers the `ERRMEM` longjmp frame | The failure mode is a loud abort of the VM, not a plausible wrong answer, so it fails clause three of the criterion. |
| Module resolution (`require`, search paths, JS searchers) | 135 test references; `exception-matrix` covers the throwing-searcher frame | Same reason: a failed resolution raises. |
| Data races | 4 sanitizer harnesses, `test-ts-tsan` explicitly best-effort | TSan cannot see libuv/V8/Lua synchronization, so a clean run is not a proof. Stated as a limitation in `CLAUDE.md`, not as coverage. |

## 15.3 The closure assertions

Nine invariants, each computing a universe from the source and comparing it to a
frozen answer. The ones that close a defect *class* rather than track a count:

| Invariant | Class closed | How a new member is caught |
|---|---|---|
| `core-call-guarding` | A binding path to a throwing core call without a `try` (CR-6 F1) | Transitive fixpoint over the core; a new throwing method changes the map |
| `objectwrap-branding` | Provenance ≠ kind: an `ObjectWrap` unwrapped from a JS value without a brand check (CR-15 F6, CR-20 F5) | Every `X::Unwrap` scored `TAG-CHECKED`/`UNGUARDED`; a third wrapped class appears as `branded: no` |
| `assertion-strength` | A bare `.toThrow()` that passes on the wrong error (CR-20 F5) | Bare positives frozen at 0, and the number examined frozen beside it |
| `exception-surface` | Drift in the throw/catch/barrier counts the CR-18 axes were derived from | Any change to the counts |
| `callscope-classification`, `lua-next-sites`, `occupancy-policy-sites` | Hand-maintained enumerations that decayed in CR-13/14/15 | The frozen key set *is* the universe; a vanished member reports `(gone)` |
| `scanner-coverage`, `greppable-counts` | The scanners' own blind spots (CR-19 F2) | Unattributed definitions and totals are frozen |

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
| A new handle kind, or a new marker on a JS object | `lifecycle-matrix` (Axis A) **and** `cross-context` (handle cases) |
| A new Lua C frame that can call back into the host | `exception-matrix` (Axis B) |
| A new `ObjectWrap` subclass | nothing — `objectwrap-branding` will fail until it is branded |
| A new `napi_type_tag` | nothing — `greppable-counts` and `AllTagsDistinct` will fail |
| A new occupancy policy | nothing — the generative `assert` will fire |
| A Lua version bump | `diff-oracle` (both modes) — the reference moves |
| A new threading mode | everything, plus a reconsideration of §15.2's race row |

The rows that say "nothing" are the ones worth noticing: for four classes the
mechanism now fails closed without anyone deciding to look.

## 15.7 Regression mode

```bash
npm run build-debug && npm test && npm run test-cpp   # after any change
npm run check-invariants                              # after any source change
npm run lifecycle-matrix && npm run cross-context     # after handle/marker changes
npm run exec-parity                                   # after execution-path changes
npm run oracle                                        # after core VM changes
npm run roundtrip-matrix                              # after conversion changes
npm run exception-matrix                              # after error-path changes
npm run test-ts-asan                                  # before a release
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

**The per-instrument yield law still holds, and it now has seven data points.**
Every genuinely new instrument found something; every re-run of an existing one
found nothing new. There is no reason to think an eighth instrument would find
nothing — only that there is no longer an unsearched *boundary* to point it at.
If a new one is ever built, expect it to find about one thing.

**The instruments are the newest and least-tested code here.** The lifecycle
matrix produced eight false findings before it produced a true one, every one of
them the harness misreading its own probe, several with passing controls at the
time. Both halves of the rule that came out of that are in `tools/README.md`,
and they are the most likely thing in this programme to be needed again.

---

**The programme is closed.** A pass that finds a documentation nit is now the
expected result rather than a disappointment, and the next review should be
provoked by a change in the code, not by a date.
