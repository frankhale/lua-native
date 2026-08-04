# CODE-REVIEW-NEXT-STEPS

**Date:** August 3, 2026
**Written after:** CODE-REVIEW-17, against commit `67e3025` plus the CR-17
remediation.

**Scope:** where the review programme should go next, and why. This is about the
*correctness programme* — what to search and how. `FUTURE.md` is the feature
roadmap and is a separate document.

> **Status (revised August 4, 2026, after CODE-REVIEW-21).** §§1–5 below are the
> assessment as of CR-17 and are kept unedited as the record. **Everything they
> recommended has been executed** except §3 (platform verification + CI), which
> is now **closed as out of scope** — see **§14**, which supersedes this whole
> document on that subject and should be read before acting on §1.5, §3, §10
> criterion 5, or A4. Read §§1–5 for the reasoning; read the revision beginning
> at **§6** for where the programme stands, **§13** for the A1/A2/A5 execution
> record, and **§14** for the scope decision.

---

## 1. Where the code actually stands

By any ordinary standard this is unusually hardened: **850 TypeScript and 285
C++ tests** over ~10.7k lines of C++, four sanitizer harnesses clean, three
exhaustive adversarial matrices clean, and every finding across seventeen passes
driven to a reproduction before being fixed.

### The finding curve

| Pass | Findings | Highs | | Pass | Findings | Highs |
|---|---|---|---|---|---|---|
| CR-1 | 29 | 6 | | CR-10 | 3 | 2 |
| CR-2 | 34 | 10 | | CR-11 | 5 | 2 |
| CR-3 | 15 | 3 | | CR-12 | 5 | 0 |
| CR-4 | 5 | 0 | | CR-13 | 3 | 1 |
| CR-5 | 10 | 0 | | CR-14 | 5 | 1 |
| CR-6 | 2 | 1 | | CR-15 | 6 | 1 |
| CR-7 | 5 | 1 | | CR-16 | 5 | 1 |
| CR-8 | 7 | ~1 | | CR-17 | 3 | 1 |
| CR-9 | 4 | 1 | | | | |

Total findings per pass collapsed by an order of magnitude and stayed there.
Highs dropped hard through CR-3 and then **plateaued at roughly one per pass for
eleven consecutive passes**. There is no saturation signal: seventeen passes in,
a pass still finds something serious.

### Why the plateau is misleading

**The count is flat; the density is collapsing.** CR-2 found ten highs by
reading the code. CR-16 found one crash in **1242** generated cells. CR-17 found
one root cause in **573** cells. Those are not the same "1" — each recent pass
builds a new instrument, and each instrument finds about one thing. That is a
fact about instruments, not about defect density.

**Families are being retired, not just sites.** Classifying the highs from CR-6
onward:

| Family | Passes that produced a high | Status |
|---|---|---|
| **Occupancy** (who holds the `lua_State`) | CR-9, CR-10 F1, CR-13, CR-14, CR-15, CR-16 | **Closed** structurally in the CR-15/16 refactor (`lua_occupancy::Claim`, one guard, a generative assert) |
| **Lifetime across layers** | CR-7 F1, CR-10 F2, CR-17 F1 | Mechanically searched as of CR-17 (orphan + life matrices) |
| **Exception escape / process abort** | CR-2 H8, CR-6 F1, CR-8 F1/F4 | **No mechanical search** |
| **Reentrancy invalidation** | CR-11 F1/F2 | Covered by CR-16's injection matrix |

The strongest single piece of evidence in the series: **CR-17's high is the
first high in five passes that is not occupancy.** That is exactly what closing
a class looks like — the recurring one stops recurring, and the next pass
surfaces a different family.

**The failure mode changed.** Every high from CR-1 to CR-16 announced itself
with a segfault or an abort. CR-17's high was found through *silent data
corruption* — stale handles aliasing live tables, a write landing in a table the
program was using — and its crash half was almost incidental. Its other two
findings are a wrong return value and a wrong error message. The code has moved
from **crashing to lying**, which is the normal maturation curve for a native
binding, and it means the previous discovery method stops working: a crash
announces itself, a wrong answer has to be asked for.

### What is not improving

1. **Every structural fix has introduced a fresh defect.** CR-15's occupancy
   refactor introduced a data race TSan caught pre-ship; all four of CR-16's
   lows lived inside that refactor. Change risk on this codebase is real.
2. **Comment and enumeration drift is chronic.** "Check enumerations against a
   generator" was written as a lesson in CR-14, CR-15 and CR-16 — and violated
   in CR-15, CR-16 and CR-17. Hand-maintained lists in comments decay within one
   commit here.
3. **All three matrices check survival, not truth.** CR-17 F2 and F3 were found
   by eyeballing a column of *successes*, not by any assertion.
4. **The exception-escape class has no generated coverage.** Sanitizers are
   explicitly blind to it (see `CLAUDE.md`); the CR-6 behavioural matrix is
   hand-written and therefore subject to point 2.
5. **Platform coverage is narrow.** Everything is verified on macOS/arm64.
   `binding.gyp` declares mac and win targets; `prebuilds/` has contained
   `darwin-arm64` only since CR-5. **There is no CI.**

---

## 2. Recommendation: CR-18 as an exception-escape matrix

Of the available next steps, this is the one to do.

### Why this one

- It is the **last known-live hazard family with no generated coverage**.
- It has produced highs three times, each found by a human thinking of a site.
- The **sanitizers cannot see it** — `CLAUDE.md` states that the exception-abort
  class (a `std::runtime_error` reaching `std::terminate`, e.g. CR-6 F1) is not
  caught by any of the four harnesses.
- The **recipe already exists and has transferred cleanly twice** (CR-16's
  injection matrix, CR-17's lifetime matrices): partition, generate, one process
  per cell.
- The search space is **bounded and enumerable**: 78 `throw` sites across the
  two layers, 99 `catch` sites, 54 `RunProtected` / `lua_pcall` barriers.

The other two candidates lose on timing rather than merit. Mechanizing the
remaining comment invariants (§4) is real but small — it prevents recurrence
rather than finding anything, so it rides along rather than leading. A
differential oracle (§5) is the strategically correct answer for where the
failure mode is heading, but it is an open-ended project, and building it before
knowing whether the exception family is clean is the wrong order.

### What it concretely is

Two axes, both enumerable by `grep` rather than by memory — which is the point,
per CR-14's standing rule.

**Axis A — throw kinds reachable from user code:**

- a registered JS callback throwing
- a `Napi::Error` raised by a conversion (Symbol, out-of-range BigInt, over-deep object)
- an `ERRMEM` longjmp under `maxMemory`
- a throwing print handler
- a throwing debug hook
- a throwing `__gc` metamethod
- a throwing `require` searcher
- a raising `_G` metamethod (`__index` / `__newindex`)
- a throwing type converter / from-Lua converter
- a throwing Proxy trap on a definition object

**Axis B — the Lua C frame the exception must unwind through:**

- host-function call (`LuaCallHostFunction`)
- metamethod dispatch (`__index`, `__newindex`, `__add`, `__tostring`, comparison)
- `__gc` finalizer, both at ordinary GC and inside `lua_close`
- debug hook
- `print` / `io.write`
- `require` searcher
- coroutine resume boundary
- `lua_load` reader
- to-be-closed variables (`__close`)
- the async worker's off-thread `Execute()`

Roughly 80 cells.

**The assertion per cell** is the CR-6 shape: no abort; the failure surfaces as
a catchable Lua error or a JS throw; the context is usable afterwards; and no
callback registration or registry slot is stranded.

**Partitioning is mandatory here.** The failure mode is `std::terminate`, which
kills the run — so, exactly as in CR-16 and CR-17, each cell needs its own
process for a crash to be a data point rather than the end of the run.

### Two things to carry in from CR-17

1. **Prove the harness can report dirty before believing a clean cell.**
   CR-17's first orphan matrix was entirely vacuous and reported clean. For this
   matrix that means deliberately un-catching one known-contained site and
   watching it abort. An exhaustive search that reports clean must first
   demonstrate it can report dirty.
2. **Record the value, not just survival.** The interesting failure here may be
   a *swallowed* exception, which is indistinguishable from success unless the
   cell checks what actually happened. A silently-dropped error is the same
   class as CR-17 F2/F3 — the code lying rather than crashing.

---

## 3. The one thing that would outrank it

**If shipping to Windows x64 or Intel macOS is on the roadmap, do platform
verification and CI first.**

Two of three declared targets have never had a single test executed against
them. That is a *certain* correctness gap for those users, against a *probable*
one from exception escape. And with no CI, 850 tests, four sanitizer harnesses
and three matrices all depend on someone remembering to run them — a fair amount
of what seventeen passes bought is currently protected by habit rather than by
process.

If this stays a macOS/arm64 project for now, that reverses and CR-18 leads.

Minimum useful version: build + TypeScript suite + C++ suite on macOS arm64,
macOS x64 and Windows x64; `test-ts-asan` on at least one Linux or macOS runner.
The sanitizer harnesses are documented as local-only in `CLAUDE.md`, which was a
reasonable decision when they were new and is now the main thing standing
between a regression and a release.

---

## 4. Cheap task to do alongside, either way

**Convert the remaining comment-enforced invariants to assertions.** This is the
only intervention in seventeen passes that has demonstrably stopped a class from
recurring:

- the `static_assert` on marker-tag distinctness (CR-15 F6a)
- the generative `assert` on occupancy-policy shape (CR-16 F4)
- replacing the "33 synchronous methods" count with the `grep` that produces it
  (CR-16 F2)

Named candidates already sitting in the reviews:

- the hand-maintained **`CallScope` enumeration** (repaired in CR-13, CR-14 and
  CR-15, and wrong each time)
- the **`lua_next` traversal list** (incomplete on arrival, CR-15 F3)
- the occupancy matrix's **`EXCLUSIVE_OPS`**, which currently agrees with
  `grep -n 'lua_occupancy::k' src/lua-native.cpp` by luck rather than by
  construction

About a day's work. It is the difference between a lesson written down and a
lesson enforced.

---

## 5. After that: the oracle problem

Now that the failure mode is lying rather than crashing, the strategic gap is
that **no harness checks whether an answer is right** — all three matrices, and
most of the suite, check that nothing crashed and that errors are clean.

The tractable form is **differential testing against reference Lua**: run the
same script through `lua-native` and through the stock `lua` interpreter (already
available via vcpkg, per the build prerequisites) and compare results. That gives
a real oracle for the large surface where the binding should be transparent —
arithmetic, string handling, table semantics, error messages, coroutine
scheduling — and it is generated rather than hand-written, so it does not decay.

It will not cover the JS-boundary semantics, which have no reference
implementation; those need hand-written expectations. But it would put an oracle
under the majority of the Lua surface, which is where a silent wrong answer is
most likely to go unnoticed.

This is the largest of the three items and should follow CR-18, not precede it.

---

## Summary

| Priority | Task | Effort | Rationale |
|---|---|---|---|
| **1** | CR-18: exception-escape matrix | Medium | Last known-live family with no generated coverage; sanitizers blind to it; proven recipe |
| **1 (if shipping cross-platform)** | CI + macOS x64 / Windows x64 verification | Medium | Two of three declared targets never executed; no automated regression protection |
| **2** | Mechanize the remaining comment invariants | ~1 day | The only intervention that has stopped a class recurring |
| **3** | Differential oracle against reference Lua | Large | Addresses the failure mode the code has moved to; no harness currently checks truth |

**Direct answer to "are we making progress on the class of findings":** yes,
demonstrably — but the evidence is family retirement and defect density, not the
per-pass high count, which has been flat for eleven passes and will likely stay
flat as long as each pass brings a new instrument. The marginal value of another
review pass *in the CR-9-through-CR-15 style* is now low; the value is in
building searches for the families that have never had one.

---

# Revision — after CODE-REVIEW-20

**Date:** August 3, 2026
**Written after:** CODE-REVIEW-18, 19 and 20 and their remediations.
**Supersedes:** §§2–5 above, all of which have been executed.

---

## 6. What the CR-17 programme produced

| Item | Status | Outcome |
|---|---|---|
| §2 — CR-18 exception-escape matrix | ✅ Done | 297 cells (27 frames × 11 kinds), **zero aborts**. The family that produced CR-2 H8, CR-6 F1 and CR-8 F1/F4 is closed on evidence. It found three findings instead, all of a milder kind. |
| §3 — CI + cross-platform verification | ✅ **Closed, not deferred** (Aug 4, 2026) | Out of scope by decision. "Deferred" is what kept it being re-raised every pass; it is now closed. See §14. |
| §4 — mechanize the comment invariants | ✅ Done | `tools/invariants/` + `tests/ts/invariants.spec.ts`. Seven frozen invariants today. CR-19 then found two of them wrong, which is its own lesson (§8). |
| §5 — differential oracle | ✅ Done | `tools/diff-oracle/`, 2678 cases against stock Lua 5.5. The first harness in the series whose failure mode is "this answer is wrong". |
| — | ✅ Added, unplanned | `tools/roundtrip-matrix/` (CR-20): 12 doors × 50 values, the first mechanical search of the JS → Lua direction. |

Three of the four §-items shipped, the fourth was a decision rather than a
slip, and the programme added a fifth instrument nobody had scheduled.

---

## 7. The finding curve, extended

| Pass | Findings | Highs | | Pass | Findings | Highs |
|---|---|---|---|---|---|---|
| CR-1 | 29 | 6 | | CR-11 | 5 | 2 |
| CR-2 | 34 | 10 | | CR-12 | 5 | 0 |
| CR-3 | 15 | 3 | | CR-13 | 3 | 1 |
| CR-4 | 5 | 0 | | CR-14 | 5 | 1 |
| CR-5 | 10 | 0 | | CR-15 | 6 | 1 |
| CR-6 | 2 | 1 | | CR-16 | 5 | 1 |
| CR-7 | 5 | 1 | | CR-17 | 3 | 1 |
| CR-8 | 7 | ~1 | | **CR-18** | **3** | **0** |
| CR-9 | 4 | 1 | | **CR-19** | **5** | **0** |
| CR-10 | 3 | 2 | | **CR-20** | **4 + 1** | **1\*** |

\* CR-20 F5 (`AsSharedTable` type confusion → SIGABRT) was **not found by this
pass's instrument.** It surfaced when a five-pass-old test-hygiene defect
collided with a new pin. See §9.

---

## 8. What the last three passes establish

**The count was never the signal, and now it is not even flat.** §1 said the
evidence for progress was family retirement and defect density rather than the
per-pass high count. Three passes later the high count moved too:

1. **The crash era is over.** CR-18 pointed a 297-cell generated search at the
   last hazard family that had never had one, and **nothing aborted** — not at
   `__gc`-inside-`lua_close`, where there is no Lua error handler above the
   frame at all. Every high from CR-1 to CR-16 announced itself with a segfault
   or an abort. That discovery method now returns nothing, which is what closing
   a class looks like at the level of a whole era rather than a single family.

2. **CR-19 found no defect an ordinary caller can reach.** F1, F2 and F4 are
   defects in test infrastructure; F3 is a diagnostic string behind a
   deliberately-shadowed method. Nothing crashed, corrupted, leaked or returned
   a wrong value. Nineteen passes in, that had never happened before.

3. **API coherence was measured instead of assumed, and came back clean.**
   CR-20's parity result — 12 doors, 50 values, **zero disagreements**, including
   for the values that fail, which fail identically — retires CR-17 F2's whole
   worry. A negative result over a property nobody had checked is the only kind
   of search that can retire a worry, and this is the first one the series has
   produced.

4. **The remaining product findings are small and cheap.** CR-20 F2 (a cycle
   reported as a depth-limit error) and F3 (`-0` losing its sign) were each one
   condition. F1 was resolved by documenting, which is a legitimate resolution
   now that `types.d.ts` is load-bearing for the round-trip ledger.

**So: yes, the trend is real, and the direction is legible.** Crashing → lying →
losing data quietly → documenting the loss unevenly. Each step down that ladder
is a genuine reduction in what a user can be hurt by.

---

## 9. What they do not establish

Three things cut against declaring this finished, and they are the substance of
the action items.

**The yield falls per-instrument, not globally.** CR-20's own closing note is
the honest reading and it should be carried forward as the programme's central
caveat:

> Every pass that built a genuinely new instrument found something, and every
> pass that reused an existing one found less. The yield is not falling because
> the code is converging — it is falling per-instrument, and each new instrument
> resets it.

CR-16's injection matrix found one crash in 1242 cells; CR-17's lifetime
matrices one root cause in 573; CR-18's exception matrix no crashes but three
wrong answers; CR-20's round-trip matrix three more at a seam nothing had ever
looked at. **"Nothing serious" is currently a statement about which boundaries
have been searched, not about the code.** It becomes a statement about the code
only when the boundary list is exhausted *and written down as exhausted* — which
is the concrete path to an end state and is A3.

**The last high arrived sideways, and it had been latent for five passes.**
CR-20 F5 is the load-bearing counterexample to any claim of saturation.
`AsSharedTable` accepted a `LuaContext*` reinterpreted as a `SharedTable*` and
the process aborted — reachable from four lines of ordinary JavaScript. Three
things about how it was found matter more than the defect:

- **No instrument found it.** A test-hygiene bug from CR-15 finally collided
  with a pin placed after it. Serendipity is still producing highs.
- **It was a class recurrence.** CR-15 F6 established *provenance is not kind*
  and applied the remedy to five `External`s and not to the one wrapped class,
  which nobody re-asked the question of.
- **Two loose assertions hid it.** CR-15 F5's checks were bare `.toThrow()` with
  no pattern, so they passed identically whether the error was the intended
  refusal or the `"Invalid argument"` that meant the filter was defeated — the
  exact hazard CR-17 F3 had already recorded, sitting in the test for the very
  behaviour it was concealing.

**The recurring failure is a class boundary drawn slightly too small — and it is
now recurring inside the instruments.** CR-19 named it:

> The recurring failure in this codebase is not fixing the site instead of the
> class. It is being confident about the boundary of the class. […] Every one of
> those was a considered boundary, argued for in prose, and short by a little.

CR-19 F1 (the guarding check that was one level deep) and CR-19 F2 (the scanner
that silently swallowed a function) are that failure inside the checks written
to prevent it. And CR-19's other observation stands: mechanization **moves** the
decay into the generator's own coverage, where it is harder to see because the
output looks authoritative and nobody re-derives it by hand.

---

## 10. What an end state consists of

The series has never defined a termination criterion — every pass ends with
"what should CR-N+1 search", which is why it reads as open-ended. It is
definable. `CODE-REVIEW-THOUGHTS.md` is right that "zero findings" is the wrong
target; the right one is **a bounded, stated, and enforced search**, after which
review becomes triggered by new surface rather than by the calendar.

The programme is complete when all five hold:

1. **Every boundary has been searched once, and the list is recorded as empty.**
   Not "we found nothing" but "here is the enumeration of crossings, and each
   has an instrument". CR-20 leaves three (A3).
2. **Every class declared closed has been closed over its computed closure**,
   not over an enumeration someone wrote, and the closure is asserted so a new
   member cannot arrive outside it (A1).
3. **Every instrument states its own universe and asserts its own coverage** —
   the `scanner-coverage` pattern, generalized. A positive control proves an
   instrument can fire; it does not prove it is pointed at the whole subject.
4. **The tests can distinguish the failure they exist to catch** from an
   incidental one (A2). Seventy assertions currently cannot.
5. ~~**All of it runs without anyone remembering to run it**, on every platform
   the project claims to support (A4).~~ **Struck, August 4, 2026 (§14).** This
   criterion was the platform/CI question wearing a different hat, and it is
   closed. The end state does **not** require CI or any platform beyond
   macOS/arm64; four criteria remain, not five.

At that point a pass that finds a documentation nit is the *expected* result and
the programme moves to regression maintenance. Until then, a clean pass is
ambiguous between "clean" and "not looked at".

**A working definition of "serious", so the exit is falsifiable:** a finding is
serious if an ordinary caller — one writing plausible JavaScript, without
forging engine internals — can reach a crash, a memory error, a silent wrong
value, or a leak. By that definition CR-18 and CR-19 found nothing serious;
CR-20 found one (F5, which needs no forgery to reach the underlying type
confusion) and one borderline (F1, the array hole, now specified).

---

## 11. Action items

> **Status (August 4, 2026).** **A1, A2 and A5 are done**, along with CR-21's
> F4a. A3 is two-thirds done (CR-21). A4 is still an open decision and is the
> only item nobody can execute without the project owner. See §13 for what each
> turned out to be — three of them were not quite what this section described,
> and the differences are the interesting part.

Ordered. A1 and A2 come before another review pass: they target the mechanism
that produced the last high, and together they are under three days.

### A1 — Close the classes over their closures, and assert the closure *(1–2 days)*

The last several highs are all one shape: a class fixed across the members
someone could enumerate. Stop enumerating; compute.

- **Provenance / kind.** The closure here is small and, checked against the
  source, **already correct**: two `ObjectWrap` subclasses (`LuaContext`,
  `SharedTable`), six `napi_type_tag`s, `InstanceOf` now at **zero** uses in
  `src/`, and `SharedTable::Unwrap` (`lua-native.cpp:911`) the only `Unwrap` of
  a JS-supplied value. So the work is not a hunt — it is an **eighth invariant**
  asserting that every `ObjectWrap` subclass reachable as a JS value is
  tag-checked before unwrap, so that a third wrapped class cannot arrive
  untagged the way `SharedTable` did.
- **The other six invariants.** Ask each the CR-19 F1 question: *is the frozen
  universe the closure, or an enumeration?* `core-call-guarding` was rebuilt as
  a fixpoint after CR-19; `exception-surface`, `occupancy-policy-sites`,
  `lua-next-sites`, `callscope-classification` and `greppable-counts` have not
  been re-asked.
- **Done when:** each of the seven-plus invariants carries a documented universe
  **and** a coverage assertion in the `scanner-coverage` mould, so an
  unclassified input turns the suite red rather than shrinking the universe
  silently.

### A2 — Make the suite able to see the failures it exists to catch *(~half a day)*

- **70 bare `.toThrow()` / `.toThrowError()` call sites** in
  `tests/ts/lua-native.spec.ts` assert only that *something* threw. Two of them
  concealed CR-20 F5 for five passes. Give each a pattern.
- **Add an invariant that a bare `.toThrow()` fails the check**, so new ones
  cannot land. This is the cheapest item on the list with the clearest causal
  link to a real high.
- **Guard process-global state between tests.** One such mutation exists (the
  `Symbol.hasInstance` patch, now restored in a `finally` per CR-20) — a
  suite-level assertion beats trusting the next one to remember, particularly in
  a single 434 kB spec file where a leak propagates to every test after it.

### A3 — Search the three remaining boundaries, then declare the list empty *(CR-21–23)*

From CR-20's own enumeration. Each has an obvious metamorphic property and no
harness. Two of the three are cheap because the corpus already exists:

| Boundary | Property | Cost |
|---|---|---|
| Async surface end-to-end | `execute_script_async(s)` ≡ `execute_script(s)` | **Low** — reuse the oracle's 2678-case corpus |
| Bytecode round-trip | `compile → load_bytecode` ≡ `execute_script` | **Low** — same corpus |
| Userdata / class lifecycle across `reset` and GC | no stale handle, no stranded registry slot, no aliasing | **Medium** — new cells; closest to CR-17's lifetime matrices |

**Done when:** all three run clean *and* this document records the boundary
enumeration as complete. The enumeration being written down is the deliverable,
not the clean runs.

### A4 — Resolve the platform question — ✅ **CLOSED, August 4, 2026. Do not reopen.**

> **Decided by the project owner: neither branch. macOS-only scope and the
> absence of CI are settled, and are not to be raised again as gaps, risks,
> action items, or caveats.** See §14. The text below is kept as the record of
> what was weighed; it is no longer a live recommendation, and nothing in it
> should be carried into a future pass.

The only item here that is a decision rather than work, and the only one that
can invalidate the end state. Two of three targets declared in `binding.gyp`
have never had a test executed against them, there is no CI, and
`CODE-REVIEW-DEFERRED` M5 (`MACOSX_DEPLOYMENT_TARGET` at `"26.0"`, a documented
release blocker) sits in the same decision. Pick one:

- **Narrow.** Drop the untested targets from `binding.gyp`, and the end state is
  honest and small: verified on macOS/arm64, which is what has actually been
  tested.
- **Broaden.** CI on macOS arm64 + x64 and Windows x64, plus `test-ts-asan` on
  one runner, and resolve M5.

Doing neither means everything §§8–10 bought stays protected by habit.

### A5 — One live comment drift, cheap *(minutes)*

`src/lua-native.cpp:866–881` still argues that `InstanceOf` is not what makes
`AsSharedTable` safe and that "the load-bearing guard is one line lower"
(`Unwrap`) — a claim CR-20 F5 disproved by aborting the process with it. The
function contains no `InstanceOf`, and its actual guard is `CheckTypeTag` at
`:893`, described by a *second* comment at `:887`. Two comments on one function,
the first now wrong. This is the class the whole §4 mechanization effort exists
to fight, sitting on the function that produced the most recent high.

### A6 — Write the exit down, then switch modes

When A1–A4 are done, record it here: the boundary enumeration, the closure
assertions, the platform scope, and the definition of "serious" from §10.
Thereafter review is triggered by **new surface** — a new entry point, a new
callback frame, a new Lua version — not by a schedule.

### Standing rule for the run-in

Six consecutive passes found that a structural fix introduced a fresh defect,
and CR-18's was the most pointed: the fix for the exception class was itself an
instance of the exception class, written by the person who had spent the day
characterising it. What caught it was the pre-existing suite, not the new matrix
and not the reasoning. **Make each fix small and keep the suite green after each
one** — which is also why A2 comes first.

---

## 12. Summary

| Priority | Task | Effort | Rationale |
|---|---|---|---|
| **1** | A2 — pattern the 70 bare `.toThrow()`s; invariant against new ones | ~½ day | Cheapest item with a direct causal link to the last high; makes every later fix safer |
| **1** | A1 — close classes over computed closures; assert them | 1–2 days | Targets the failure mode still producing highs: a class boundary drawn slightly too small |
| **2** | A3 — async / bytecode / lifecycle boundaries, then declare the list empty | Medium (2 low, 1 medium) | The last three unsearched crossings; the recorded enumeration is what converts "clean" into "complete" |
| — | ~~A4 — narrow `binding.gyp` **or** stand up CI (+ M5)~~ | ✅ Closed | Out of scope by decision, Aug 4 2026 (§14). Not a gap; do not re-raise. |
| **3** | A5 — remove the superseded `AsSharedTable` comment | Minutes | Rides along |
| **4** | A6 — record the exit criteria; switch to regression mode | — | The end state itself |

**Direct answer to "are we trending toward lower-priority findings":** yes, and
CR-18–20 are the first passes that show it in the high count rather than only in
density — an era ended (no crashes in 297 cells), a pass landed with no
product defect an ordinary caller can reach, and API coherence was measured
clean for the first time. **The caveat is that yield falls per-instrument and
resets with each new one**, so "nothing serious" is still a claim about coverage
rather than about the code. A1–A4 are what convert it into a claim about the
code, and they are bounded — this is a few weeks of work, not another eleven
passes.

---

# 13. Execution record — A1, A2, A5 (August 4, 2026)

**Done:** A1, A2, A5, and CR-21 F4a. **Two-thirds done:** A3. **Open decision:**
A4. Verified after each change and again at the end: **936 TypeScript tests**
(up from 934), **285 C++ tests**, nine invariants clean, `test-ts-asan` clean,
and all five harnesses clean (exec-parity 4015/2/0, exception matrix 297/297,
oracle 0 disagreements, round-trip 456 identical / 0 undocumented / parity 50
of 50).

**Every one of the three was measured before it was fixed, and all three turned
out to be stated slightly wrong.** That is the finding of this round, and it is
the same one the programme keeps producing about itself — an action item is a
hypothesis, and prose is where the boundary gets drawn too small.

## A1 — done, and the claim it rested on is now verified rather than asserted

§11 said the provenance closure was "checked against the source, **already
correct**", and it is. Re-verified: two `ObjectWrap` subclasses, six
`napi_type_tag`s, `InstanceOf` at **zero** live uses (every remaining mention is
a comment saying it is *not* the mechanism — see A5), and `SharedTable::Unwrap`
the only unwrap of a JS-supplied value.

**What §11 did not say is *why* the unbranded class is safe, and that gap was
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
reason is structural rather than lucky. §11 asked whether each frozen universe
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

§11: "**70 bare `.toThrow()` / `.toThrowError()` call sites** … Give each a
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

§11 named `lua-native.cpp:866–881`. Two more said the same wrong thing:

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

- **A3** — one boundary left: the userdata/class lifecycle across `reset` and
  GC. The enumeration is in `docs/CODE-REVIEW-21.md`; when that row has an
  instrument, §10's criterion 1 is met.
- **A4** — ✅ **closed the same day by the project owner: out of scope.** See
  §14. Not a gap, not deferred, not a caveat.
- **A6** — blocked on A3 alone.

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
- §1 point 5, §3 in full, §10 criterion 5, §12 row A4, and A4 itself. Where
  those still argue the case, they are historical record, not live advice.

### Why this is written down as forcefully as it is

Because it kept coming back. The platform/CI question was raised in §1.5, argued
at length in §3, promoted to "the largest un-searched risk in the project" in
§6, embedded as one of the five end-state criteria in §10, and listed as A4 in
both §11 and §12 — and it was carried forward each time under the word
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

§10's criteria drop from five to four: the boundary enumeration (§10.1), closure
over computed closures (§10.2), instruments that state their own universe
(§10.3), and tests that can distinguish the failure they exist to catch (§10.4).
Criterion 5 is struck. **A6 is therefore blocked on A3 alone** — the single
remaining boundary, the userdata/class lifecycle across `reset` and GC.

### Revocability

The owner's phrasing was "until further notice", so this is a decision rather
than a permanent property of the project. If cross-platform support or CI is
ever wanted, reopen it deliberately — but nothing should reopen it implicitly,
and no review pass should reopen it at all.
