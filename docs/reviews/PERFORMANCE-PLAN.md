# PERFORMANCE-PLAN

> **SUPERSEDED — executed August 6, 2026, the day it was written. This is a
> record, not an instruction.**
>
> All five steps of §11 are done. The instrument is `tools/crossing-cost`
> (`npm run crossing-cost`), documented where it executes in
> [`../../tools/README.md`](../../tools/README.md); the fail-closed half is the
> `perf-claims` invariant, which rides `npm run check-invariants` and therefore
> the suite. What survives as an *instruction* has moved into
> [`../CORRECTNESS.md`](../CORRECTNESS.md) §15.1 (cost is a third non-boundary
> instrument), §15.6 (the trigger table's first documentation-fired row), §15.7
> (the regression split) and §15.10 (the search's record). The reasoning behind
> each measurement decision is in `tools/crossing-cost/measure.mjs`, at the line
> it protects.
>
> **Read this file for the four things it got wrong**, which is the reason to
> keep it. Every one is written up in
> [`../../tools/crossing-cost/FINDINGS.md`](../../tools/crossing-cost/FINDINGS.md):
>
> - **§6's known-quadratic control is not quadratic** (H1). "String concatenation
>   in a loop" is O(n) in V8, which builds a rope. Had it shipped as written the
>   control would have failed against a correct classifier, and the obvious fix —
>   widening the band — produces an instrument that agrees with whatever it is
>   shown.
> - **§6's 10x ratio control is not 10x** (H4). Built by scaling an argument, it
>   measured 13.5x and 15.4x, because a loop bound the compiler can see is a loop
>   the compiler optimises differently: the same source line cost 0.452ns and
>   0.697ns per iteration at the two sizes. Built by repetition it measures 10.05x.
> - **§5's A3 proposition is not the claim the docs make** (H5). The plan
>   restated C3 as "overhead scales as 1/count"; the README says count mode
>   samples *instead of reporting everything*, which names **line mode**. The
>   invented proposition failed at 1.24x and read as a product finding. The real
>   claim is true by 77x.
> - **§1's claim enumeration was short by five** (E1). §7 specified a census over
>   README + `docs/*.md`; §1 searched only the README, and `types.d.ts` — which
>   ships — supplied three of the five it missed. Four of the five tell the reader
>   to route on them.
>
> The plan's own §12 predicted the first of those in general terms ("the harness
> will find defects in itself before it finds any in the product, and probably
> several") and was right about the count: **six harness defects against two
> product findings.** It did not predict that two of them would be defects in the
> plan itself.
>
> Its §9 closing condition was met on all four clauses. Its §2 declined in
> advance to bank this as `CORRECTNESS.md` §15.10's second clause-5 data point,
> and that decision stands — see §15.10 for why.

**Date:** August 6, 2026
**Status:** Executed and superseded, same day.

**Supersession rule, stated up front so this file cannot become the thing it is
correcting** (`docs/README.md`, rule 2 and its corollary): when the work below is
executed, this document moves to `docs/reviews/` with a banner naming what
replaced it, and whatever survives as an *instruction* moves into
`CORRECTNESS.md` §15, `tools/README.md`, or a source comment. Prose is the last
resort. If you are reading this after **December 2026** and §9's closing
condition has not been checked, treat every effort estimate and every
"currently" below as stale.

**Not survey-derived.** Every item traces to a measurement in this repository —
a grep that returns nothing, or a claim printed in shipped documentation with no
number behind it. That is the bar `docs/README.md` sets for writing a plan
document at all.

---

## 1. The region, declared

§15.9's first obligation: name the unsearched region, and say why nothing
currently searches it.

**The region is cost.** Nine harnesses ask whether an answer is *right*. None
asks what it *costs*, and nothing else does either:

```
grep -rin "benchmark" .            (excl. node_modules/build/vendor)  → nothing
grep -in  "performance" docs/CORRECTNESS.md                          → nothing
```

The second grep is the one that matters. `CORRECTNESS.md` §15.2 is the list of
areas deliberately *not* covered by a generated search, and since W4 every row in
it must name the clause of §15.1's criterion it fails. **Cost has no row.** It is
not excluded, not ledgered, not ruled on — it was never considered. That is a
different state from platform coverage and CI, which are settled scope decisions
(§14), and it is the state §15.10 says to look for: "a region nobody has named
yet."

**Meanwhile the shipped README makes four performance claims and measures none
of them:**

| # | Claim | Site |
|---|---|---|
| C1 | "every number and string crossing out of Lua stays on the **fast path**" | `README.md:614` |
| C2 | "**Performance:** every registered `match` runs for every object-valued result crossing Lua→JS, in registration order, until one matches. Keep `match` cheap." | `README.md:3177` |
| C3 | "it samples instead of reporting everything, so the **overhead stays bounded**" | `README.md:1030` |
| C4 | "compile Lua to bytecode … load with `load_bytecode()` for **faster startup**" | `README.md:35`, `README.md:1357` |

These are promises to a user, and C2 is a promise the user is expected to *act*
on — it tells them to keep `match` cheap, which is only advice if the linear
scan it describes is real. None of the four has a number, a test, or a harness
behind it.

The wider claim is structural: `reviews/BRIDGE-COMPARISON.md` rests the case
against wasmoon and fengari on this being a native binding rather than WASM or a
pure-JS VM. That is a performance argument, and it has never been measured here.

**One false start, recorded because it is a constraint on §7 rather than a
footnote.** Drafting this section, a wider grep surfaced two further candidates
that looked much stronger — a quantitative table at `docs/ASYNC.md:1099-1102`
("~1-10 microseconds", "Event loop scheduling latency: 0-1ms") under a heading
reading `### Performance Implications`, and a sub-millisecond latency bound at
`docs/ASYNC.md:437`. **Neither is a claim about this binding.** The first sits
under `## Phase 2: ThreadSafeFunction Callbacks (Future)`, an explicitly
unimplemented design; the second under `### Challenge 3`, weighing design options
that were not taken. They are estimates about code that does not exist.

The lesson is §7's: a grep for claim-shaped vocabulary **cannot distinguish a
promise about shipped behaviour from an estimate inside a design discussion**,
and a census that does not make that distinction will report `UNCLAIMED` on
hypothetical prose until someone ledgers the noise away — at which point it is
training its reader to dismiss it. §7 carries the scoping rule that follows.

---

## 2. What this is not

Recorded first, because the two most likely ways to get this wrong are to file it
as an eighth boundary and to let it become a benchmark suite.

**It is not an eighth boundary.** §15.1's criterion is *two systems with
different rules exchange a value such that a mismatch produces a plausible answer
rather than an error*. A cost defect returns the **correct** answer, slowly.
There is no mismatch, so the criterion is not merely failed on one clause — it
does not apply. This is a third category alongside `binding-balance`, which
searches what the binding *retains* rather than what crosses it. File it the same
way: **a cost search, not a boundary**, in §15.1's "two further instruments and
neither is an eighth boundary" paragraph, which becomes three.

**It does not claim a clause-5 data point, and the reason is worth stating.**
§15.10 clause 5 wants "two consecutive *new* searches, aimed at regions chosen by
§15.1's criterion, return zero serious findings", and §15.5 defines *serious* in
correctness terms. A clean cost run is evidence about cost; it says nothing about
whether a value crosses correctly, which is what clause 5 is counting. Note that
`binding-balance` was admitted as data point 1 while also not being a §15.1
region — so the precedent exists to stretch clause 5, and this plan declines to
use it. If the owner wants to widen clause 5 to non-boundary searches, that is a
decision to make explicitly in §15.10, not something a cost harness should
quietly bank.

**It is not a benchmark suite and not a comparison.** No marketing numbers, no
runs against wasmoon or fengari (`BRIDGE-COMPARISON.md` is frozen and that is a
different question, requiring their toolchains). No optimization work is proposed
here: this searches for cost-shape defects and unverified claims. Whether to act
on a finding is a separate decision.

**It is not a wall-clock regression gate.** See §4 — that is the design decision
this whole plan turns on.

---

## 3. The rule that generates the enumeration

§15.6's lesson, the one that cost the most: *an enumeration has to record the
rule that generated it, or it cannot be checked for completeness — only extended
when something leaks past.*

> **A cost cell is a place where the work per call is a function of something
> the caller controls, and the relationship is either claimed in shipped
> documentation or assumed by the shape of the API.**

Each clause does work. *Work is a function of caller-controlled input* is what
makes there be a curve to measure rather than a constant to record. *The
relationship is claimed or assumed* is what supplies an expectation to violate —
without it there is a number but no verdict. And *claimed in shipped
documentation* is what makes the first axis a promise to someone rather than an
internal curiosity.

Applying the rule gives three axes (§5). The rule is also what §7's fail-closed
census is written against, so a claim added to the docs later is scored by the
same sentence that generated the original list.

---

## 4. The design decision this turns on: differential, not absolute

A cost harness differs from all nine existing ones in a way that governs
everything else. Their cells are deterministic — a value round-trips or it does
not. A cost cell yields a *distribution*, and on a laptop with no CI (§14, a
settled scope decision, not a gap to solve here) thermal state, background load
and GC timing move that distribution more than a real regression plausibly
would.

The naive design — freeze nanosecond baselines in `expected.json`, fail on a 5%
delta — would report dirt constantly, and the dirt would be in the instrument.
That is precisely the failure this tree has paid for twelve times
(`tools/README.md`: *"a search that reports dirty must show the dirt is in the
subject"*). **Do not build it.**

**The decision: every cell is a ratio measured inside one process, never an
absolute time compared against a stored one.** Machine speed, thermal state and
Node version cancel in a ratio. This is the same move `diff-oracle` makes — it
does not assert "Lua returns 3", it asserts "lua-native agrees with stock Lua"
— and it is what makes a frozen expectation possible at all.

**All four shipped claims are already relative claims**, which is the
observation that makes this tractable. Not one of them says "X takes five
microseconds":

- C1 says numbers and strings are on a *faster path than* object-valued results,
  and — the load-bearing half — that their cost is **O(1) in the number of
  registered converters**.
- C2 says object-valued cost is **linear in the converter count**, scanned in
  registration order until a match.
- C3 says sampling overhead is **bounded relative to** per-instruction hooking.
- C4 says `load_bytecode` is **cheaper than** compiling the same chunk.

That is not luck. It is what survives review: an absolute figure in a document
ages against hardware, and the two absolute figures found in this tree (§1's
false start) are both in sections describing code that was never written — which
is the only place they are safe.

**The rule this yields, and it governs any future claim as much as this
harness:** a performance claim about shipped behaviour should be written as a
ratio or a complexity class, because that is the form that can be checked here
at all. An absolute number in shipped docs is a claim nothing in this repository
can defend.

So the claims axis never needs a stable absolute number. Neither does the
regression axis, if it is scoped correctly:

**Scope the regression guard to *shape*, not to elapsed time.** Assert
complexity class and in-process ratio — properties that hold on any machine:

- crossing a 1000-element table costs ≈10× a 100-element table (linear, not
  quadratic);
- a door's null crossing stays within a declared band of the cheapest door's;
- registering a converter that never matches does not change number/string cost
  at all.

A harness that catches an accidentally quadratic conversion path is worth far
more than one that catches a 5% drift, and unlike the 5% detector it can actually
be built here.

---

## 5. The axes

### Axis A — the four shipped claims

One cell per claim, each stated as a falsifiable proposition with a declared
verdict rule.

| Cell | Proposition | Falsified when |
|---|---|---|
| `A1-fast-path` | Number and string results crossing Lua→JS cost O(1) in the count of registered from-Lua converters | cost at 50 converters exceeds cost at 0 by more than the noise floor |
| `A2-converter-scan` | Object-valued result cost is linear in converter count, and position-sensitive (a match at index 0 beats a match at index N) | slope is flat (the scan is not happening — C2's advice is then wrong), or super-linear (worse than documented) |
| `A3-sampling-bound` | Hook overhead at `count=N` is ≈1/k of overhead at `count=N/k` | ratio does not track the sampling interval |
| `A4-bytecode-start` | `load_bytecode(compiled)` is cheaper than `execute_script(source)` for the same chunk | no measurable difference, or bytecode is slower |

`A2` is the one to build first. It is the only claim the docs ask the *user* to
act on, and both of its failure modes are interesting: a flat slope means the
advice is unnecessary, a super-linear slope means it is insufficient.

### Axis B — cost shape per value kind × door

**Ride the existing enumerations; do not write a new one.** Import
`tools/roundtrip-matrix/doors.mjs` (19 doors) and `values.mjs` (50 values). Two
reasons, and the second is the important one:

1. No new list to decay.
2. §15.6's trigger *"a new public entry point that takes a JS value →
   `roundtrip-matrix` (a door)"* already exists. Riding the same list means this
   harness inherits that trigger for free and **§15.6 needs no new row** — a new
   door is measured for cost the moment it is added for correctness.

Heed `tools/README.md`'s W2 convention while doing it: those modules are shared
semantics. **Import them; do not edit them.** The ledger that breaks will be
`roundtrip-matrix`'s, not this one's.

Measuring 19 × 50 with statistics is too slow for a routine run, so split it:

- **B1 — null-crossing ratio, all 19 doors.** Cheapest possible payload through
  each door, expressed as a multiple of the cheapest door. Declares each door's
  structural overhead. Expect `resume_async` and the worker doors to sit well
  above `set_global`; that is a ledger entry with a reason, not a finding.
- **B2 — complexity class, size-scalable values only.** Tables, arrays, strings
  and nested structures at N = 10 / 100 / 1000, one declared complexity class per
  kind, verified by the classifier (§6). This is where an accidental O(n²) shows,
  and it is the highest-value cell in the plan.

### Axis C — the scaling knobs

The caller-controlled quantities the API exposes, derived from §3's rule:

table width · table depth (against `kMaxDepth = 100`) · string length · argument
count · registered converter count (both directions) · registered global count ·
Lua registry population · handle count outstanding.

Each gets a declared expected class. `binding-balance`'s `CONTAINERS` list is the
natural source for the registration-count knobs — reuse it rather than
re-enumerating, for the same trigger-inheritance reason as Axis B.

---

## 6. Controls and vacuity

§15.9's third obligation, and `tools/README.md`'s first three conventions. A cost
harness gets unusually good controls, because the ground truth is constructible.

**Positive controls, run first; refuse to proceed if any fails.** The subject
under control is the *classifier*, not the product:

- a known-linear workload must be classified linear;
- a known-quadratic workload (string concatenation in a loop) must be classified
  super-linear — **a classifier that cannot tell O(n) from O(n²) on a synthetic
  input has no business ruling on a crossing**;
- a known-10× workload must produce a ratio of ≈10, not "different";
- a deliberately slowed converter (`match` doing fixed busy work) must move
  `A2-converter-scan` off its expected slope. This is the control that proves the
  claims axis is wired to the product at all.

**Per-cell vacuity.** A cell must demonstrate its own workload happened: time at
the largest N must exceed both the measured noise floor and time at the smallest
N. A cell that fails this reports **VACUOUS, not PASS** — the dead-code-elimination
and "the work isn't where you think" cases are the exception-matrix's two
never-invoked frames wearing different clothes (CR-18).

**Per-axis vacuity, because the knobs are knobs.** `tools/README.md`: *whenever a
new axis is a knob rather than a value, ask what it would look like if the knob
were disconnected.* Axis C is entirely knobs. Each must show that moving it from
minimum to maximum moves *something* measurable *somewhere* before its cells
count. A converter-count axis wired to nothing would report a beautifully flat
O(1) line and confirm C1 while searching nothing — the CR-23 F4 shape, at the one
place in this plan where a false clean is most convincing.

**The noise floor is measured, not assumed.** Establish it per run by timing the
same workload repeatedly and taking the spread. Any effect below it is VACUOUS.
Report the floor in the output; a run whose floor is unusually wide (a busy
machine) is a run whose results should not be trusted, and the harness should say
so rather than average it away.

**Drive every dirty result to a hand-run reproduction before believing it.** The
rule that has paid twelve times. Expect to use it heavily here (§12).

---

## 7. The fail-closed mechanism: a `perf-claims` census

**This is the part that survives, and it is what makes this an instrument rather
than a one-off benchmark.** Prose rots; a check runs. Three reflective documents
in this tree prove the first half (`docs/README.md`, corollary to rule 2).

Add an eleventh invariant, `tools/invariants/perf-claims.mjs`, modelled on
`assertion-strength` (which greps for bare `.toThrow()` and fails closed):

- Grep `README.md` and `docs/*.md` for claim-shaped vocabulary — `fast path`,
  `faster`, `overhead`, `cheap`, `free`, `bounded`, `linear`, `O(`,
  `**Performance:**`, `latency`, `microsecond` / `µs` / `ms`, `negligible`,
  `dominates`. The last four are in the list because the plan's own first draft
  omitted them; a vocabulary is an enumeration, and this one was short before it
  shipped.
- **Scope the hits to sections describing shipped behaviour** (§1's false start).
  Skip any hit under a heading marked `(Future)`, `Phase N`, `Challenge`,
  `Option`, or `Alternatives considered` — design discussions estimate costs for
  code that does not exist, and a census that flags them teaches its reader to
  ignore it. Getting this wrong in the permissive direction is worse than a
  missed claim: a census with a ledger full of hypotheticals is one nobody reads.
  The skip list is itself an enumeration and belongs in the harness, not here.
- Every hit must be either **COVERED** (named by an Axis A cell) or **LEDGERED**
  (an entry with a written reason — e.g. the claim is about the user's own code,
  not the binding).
- An unmatched hit reports `UNCLAIMED` and turns `npm run check-invariants` — and
  therefore `tests/ts/invariants.spec.ts`, and therefore the suite — red.
- A ledger entry whose claim text has been deleted reports `STALE`.

Fuzzy matching is acceptable here and errs in the right direction: a false
positive costs one ledger line with a reason; a missed claim is exactly the
failure mode being closed. This is the same trade `assertion-strength` already
makes.

**Consequence, and it is the reason to build this piece even if Axis B never
ships:** a future performance claim cannot be added to shipped docs without
either a cell measuring it or a written admission that nobody has. C1–C4 got in
because nothing was watching.

---

## 8. The ledger, and what may never go in it

Standard form (`tools/crossing-cost/accepted.mjs`): every entry carries its
reason; an entry whose case has started passing reports **STALE** rather than
being silently ignored.

Expected legitimate entries: a door whose structural overhead is inherent and
documented (`resume_async` minting a coroutine — cite `ASYNC.md`); a knob whose
class is deliberately super-linear.

**Two things that may never be ledgered.**

- **A false claim in the docs.** If a cell contradicts C1–C4, the resolution is
  to fix the product or **delete the sentence** — never to ledger the gap. The
  existing convention is *never ledger an undocumented defect, because while a
  loss is unspecified, ledgering it launders a finding into a feature*. A
  documented claim that is false is the sharper version of the same thing: it has
  already been promised to a user.
- **A cell that is noisy.** Ledgering a cell because it fluctuates converts the
  ledger into a place to put measurement problems. A cell that cannot be measured
  stably is either redesigned as a ratio or deleted, and the deletion is recorded
  in this plan's execution record.

---

## 9. Closing condition

Checkable, not felt — the bar `docs/README.md` sets, and the reason §15.10 exists
in `CORRECTNESS.md` rather than in a plan document.

> **The cost region is searched when all four hold:**
>
> 1. `perf-claims` reports **0 `UNCLAIMED`** and **0 `STALE`** over `README.md`
>    and `docs/*.md`;
> 2. every claim C1–C4 is either **confirmed by its cell**, **fixed in the
>    product**, or **deleted from the docs** — no fourth outcome;
> 3. every size-scalable crossing in Axis B2 and every knob in Axis C carries a
>    **declared complexity class** that its cell confirms;
> 4. the classifier's controls (§6) pass, including the injected-slowdown control
>    that proves Axis A is wired to the product.

Clause 4 is the one to check first and the one most likely to be quietly skipped.

---

## 10. What this deliberately does not do

- **No absolute-time regression gate**, for §4's reason. If one is ever wanted it
  needs stable hardware, which is CI, which is a settled scope decision (§14) —
  do not reopen it through this door.
- **No cross-bridge comparison.** Different question, frozen document, foreign
  toolchains.
- **No optimization.** This plan produces measurements and verdicts. Acting on a
  finding is a separate decision with its own scope.
- **Not in the regression matrix** (§15.7). Split it the way invariants and
  harnesses are already split: **the `perf-claims` census is cheap and fail-closed
  → it rides `check-invariants` and the suite. The measurement is slow and noisy
  → `npm run crossing-cost`, on demand.** A slow, variance-prone check wired into
  every run is a check people learn to ignore.

---

## 11. Order of work

Effort figures are a forecast dated August 6, 2026 (§0's rot rule).

| Step | What | Why this order | Rough |
|---|---|---|---|
| 1 | The classifier + its four controls (§6) | Nothing below is believable until a known O(n²) is called O(n²). Buildable and testable with zero product involvement. | half a day |
| 2 | `perf-claims` census (§7) | Cheapest, fail-closed, and it is the piece that survives if the rest is deferred. Independent of step 1. | half a day |
| 3 | Axis A, starting with `A2-converter-scan` | The only claim the docs tell a user to act on; both failure modes are findings. | one day |
| 4 | Axis B1 (null-crossing ratio × 19 doors) | Reuses `doors.mjs` wholesale; establishes the per-door baseline every other cell quotes. | one day |
| 5 | Axis B2 + Axis C (complexity classes) | Highest value, highest cost, and it depends on 1 and 4 being trustworthy. | two days |

Steps 1 and 2 are independently useful. If this plan stalls after step 2, the
docs still cannot grow a new unmeasured claim, which is most of the durable
value.

Harness location `tools/crossing-cost/`, entry point `run.mjs`, npm script
`npm run crossing-cost` — the directory named for what it does, per
`tools/README.md`.

---

## 12. Predicted failure modes

Dated predictions, so the execution record can score them (§15.9's culture of
recording what the plan got wrong — `UNSEARCHED-REGIONS-PLAN.md` §4.2's *"two
premises above were wrong"* is the model).

1. **The harness will find defects in itself before it finds any in the product,
   and probably several.** Twelve precedents. The specific forms to expect:
   timer resolution too coarse for the cheapest cells; the JIT eliminating a
   workload whose result is unused; measuring warmup rather than steady state; a
   GC pause landing inside one sample and being read as a cost cliff.
2. **At least one of C1–C4 will turn out to be true but unfalsifiable as
   written.** "Fast path" does not say fast relative to what. The resolution is a
   doc edit making the claim measurable — a deliverable, not a disappointment,
   and the reason §9 clause 2 carries three outcomes rather than one.
3. **The most likely real finding is a shape defect, not a slow constant** — a
   conversion path that is quadratic in table width or depth, or a scan that is
   linear where the API implies constant. That is also the class this design is
   strongest at detecting, which is a reason to be suspicious of a clean result
   and to re-read §6 before believing one.
4. **Axis C is where a false clean would hide**, because a disconnected knob
   produces a flat line that reads as excellent news. Its per-axis vacuity check
   is not optional.
