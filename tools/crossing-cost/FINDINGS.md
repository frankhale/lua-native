# crossing-cost — findings

Two kinds of entry, kept apart on purpose.

**H-entries are defects in the harness.** `PERFORMANCE-PLAN` §12 predicted these
would arrive first and outnumber the product findings, which is what happened:
four of them before a single line of Lua was measured. They are recorded in full
because `tools/README.md`'s most expensive convention is *a search that reports
dirty must show the dirt is in the subject*, and the only way that rule stays
alive is if the misreadings are written down as carefully as the findings.

**F-entries are findings about the product**, in §8's sense: a measurement that
contradicts something the binding or its documentation claims.

---

## H1 — the plan's known-quadratic control is not quadratic

**Predicted:** no. **Found by:** running the control.

`PERFORMANCE-PLAN` §6 named "string concatenation in a loop" as the known-O(n²)
workload that gives every shape verdict its meaning. It is O(n) in V8: `s += x`
builds a rope (a cons-string) in constant time and flattens only on demand.
Measured exponent over n = 100 / 1000 / 10000: **0.97–0.99, classified LINEAR**.

Had this shipped as written, the classifier control would have failed on a
correct classifier, and the obvious "fix" — widening the quadratic band until
the control passed — would have produced an instrument that agrees with whatever
it is shown. That is the failure mode the control exists to prevent, arriving
through the control itself.

**Resolution:** the control uses a nested loop, whose shape is not a runtime's
choice. The rope workload is kept in `controls.mjs` as a `NOTE` row — measured
and reported every run, never asserted on, because whether V8 flattens a rope is
V8's business and a control that depends on it is not a control.

## H2 — `await` on a synchronous workload taxes the cheapest cells 26x

**Predicted:** yes — §12.1, "measuring warmup rather than steady state" and its
neighbours. **Found by:** the H3 investigation.

The first `timePerCall` awaited every call so that async doors and sync doors
could share one code path. But `await` on a non-thenable still allocates a
promise and schedules a microtask turn. Measured on an empty workload:

| path | ns per call |
|---|---|
| `consume(await fn(i))` | 39.6 |
| `consume(fn(i))` | 1.5 |

39.6ns is larger than several of the crossings this harness exists to measure. It
lands hardest on exactly the cells where a claim is at stake — C1 is about a
number crossing out of Lua, which is the cheapest operation in the API — and it
lands as a *constant*, so it also flattens every shape it touches toward
CONSTANT.

**Resolution:** `timePerCall` probes the workload once for a thenable and takes a
straight-line synchronous loop when it can. Async doors still pay the turn, which
is correct: for an async door the turn is part of what the door costs.

## H3 — a batch-count warmup compares JIT tiers, not costs

**Predicted:** partly — §12.1 named warmup. The *mechanism* was not predicted and
is the sharpest thing found so far.

The first draft warmed by running two full batches, so a closure measured at
reps=800 got 1600 warmup calls and the same closure at reps=13312 got 26624. V8
promotes a function to an optimising tier after a few thousand calls, so those
two measurements were taken in **different tiers**, and a ratio between them
compares tiers rather than costs.

The identical 10x comparison, as reps varied:

```
reps:      1000    2000    4000    8000   13312   16384
ratio:     9.84   17.59   17.63   10.36    9.96    9.91
```

Nothing about that sequence looks like noise — it is stable and repeatable at
each reps value, so a single run would have reported 17.6 with total confidence.
With a call-count warmup (`MIN_WARM_CALLS = 4000`) the same sweep is:

```
ratio:     9.90    9.91    9.89    9.90    9.91    9.91
```

**Resolution:** `measure.mjs` warms to a minimum number of *calls* as well as a
minimum wall time. That constant is load-bearing; lowering it silently
reintroduces this.

## H4 — a "10x workload" built by scaling an argument is not 10x

**Predicted:** no. **Found by:** the ten-times control still failing after H2 and
H3 were fixed.

The ratio control compared `linearWork(1000)` against `linearWork(10000)` and
called it a 1:10 pair. It is not, on an optimising runtime. Measured per
iteration:

| n | ns per iteration |
|---|---|
| 1000 | 0.452 |
| 10000 | 0.697 |

A 1.54x difference in the cost of the *same source line*, because a loop bound
the compiler can see is a loop the compiler optimises differently. The control
reported 13.5x and 15.4x against an expected 10x, and the tempting repair —
widen the band to 6.5–16.5 — would have destroyed the only check that can rule on
A3's sampling bound.

Built by repeating an identical inner call ten times, the same machinery measures
**10.05x** (9.82 / 10.00 / 10.24 over three runs).

**Two things this changes beyond the control.** It is why the shape classifier
uses decade spacing and 0.5-wide class bands rather than tight ones: a 1.54x
per-iteration drift across a 10x size range moves the exponent by
log(1.54)/log(10) = 0.19, which is comfortably inside a band and would be fatal
to a tighter one. And it is a standing caution for Axis B2 and Axis C — a
declared complexity class is a claim about the *crossing*, and part of what any
such measurement sees is the compiler changing its mind about the loop around it.

**A note on how close this came to passing.** Before H4 was understood, one
configuration of the broken control returned 9.85 and looked correct. It was two
errors partially cancelling. A control that passes for the wrong reason is worse
than one that fails, and the only thing that separated them here was that the
number was checked against a second construction rather than accepted because it
was near 10.

## H5 — the cell tested a restatement the plan invented, not the claim

**Predicted:** no. **Found by:** an Axis A cell failing and being driven to a
reproduction before it was believed.

`A3-sampling-bound` failed at a ratio of 1.24 against an expected 10, which read
as a clean product finding: *hook overhead barely responds to the sampling
interval*. Sweeping the interval across four decades to reproduce it showed why:
at `count=100000` and `count=1000000` the hook fires **zero times** and the
overhead is still ~68µs, statistically identical to `count=10000`.

So the model is `overhead = fixed + per-fire x fires`, with the fixed part
dominating — and the proposition the cell was testing ("overhead at count=N is
1/k of overhead at count=N/k") is not what the README says. The sentence is:

> `count` is the option to reach for when tracing whole programs — it **samples
> instead of reporting everything**, so the overhead stays bounded

"Reporting everything" is **line mode**. The claim is a comparison against
`line: true`, and `PERFORMANCE-PLAN` §5's table had written down a different
proposition and attributed it to the docs. Measured properly, C3 is not merely
true but true by two orders of magnitude: line mode costs 6.70ms of overhead
against 88µs for `count=1000`, **77x**.

**The lesson, and it is not "read more carefully".** A plan that restates a claim
in order to make it measurable has introduced a step where the restatement can be
wrong, and nothing downstream will notice — the cell fails, the failure looks
like a finding, and the finding is against the product. The defence is the
standing rule: drive every dirty result to a hand-run reproduction. It has now
paid thirteen times, and this is the first time what it caught was a *plan*
rather than a product or a harness.

## H6 — a shape cell measured at the wrong scale reports the wrong class

**Predicted:** partly — §12.1 named dead-code elimination and warmup, not scale.

`B2/string-of-length-n` declared LINEAR and measured CONSTANT: 2.98µs, 2.82µs,
3.30µs at n = 10, 100, 1000. String copying is not free, and the binding is not
defective. Copying a kilobyte is simply invisible beside the ~2.8µs that a
`set_global` + `get_global` round trip costs whatever it carries. The cell was
measuring the door.

It cleared the vacuity gate by a hair — growth was 1.11 against a 1.10 noise
floor — which is the uncomfortable part: a slightly quieter machine would have
reported VACUOUS and been *right*, and a slightly noisier one would have reported
a confident FAIL against the product. At 1e3/1e4/1e5 the same cell measures
3.50µs, 7.40µs, 44.34µs and classifies LINEAR.

**Generalised into the harness:** a shape cell has to be run where the term it is
looking for dominates, so `KINDS` entries carry their own `sizes` when the
default decade triple is in the wrong place. The per-kind override is in
`shape.mjs` and the reason is in `accepted.mjs` under `SIZE_NOTES`.

## H7 — the census's wrap window let one claim absorb another

**Predicted:** no, but the trade was written down before it bit, which is the
only reason it was caught in one step.

`perf-claims` matches line by line, and prose wraps, so `docs/ASYNC.md` has a
line reading exactly `overhead.` — the tail of a sentence whose subject is on the
line above. No honest ledger entry can be written for a word on its own, so the
matcher was widened to a three-line window.

That immediately produced `UNCLAIMED: 0` **and** `stale claim: C9`: C2's phrase
"in registration order, until one matches" reached across the window and claimed
the *next* sentence, which is the Proxy warning `A9-proxy-read` exists to measure.
Every line was accounted for and one cell was measuring something nothing pointed
at — a clean-looking census with a hole in it, which is the exact failure the
STALE half of the ledger convention exists to expose. It worked on the first run.

**Resolution:** the line wins over the window. A neighbour is evidence about an
orphan fragment, never about a line that can speak for itself.

## H8 — the harness did not record which binary it measured

**Predicted:** no. **Found by:** a reader asking what the harness bought, given
that no C++ had changed — not by the harness, and not by the plan.

`index.js` resolves `build/Debug` before `build/Release` before `prebuilds/`, so
a developer running `npm run crossing-cost` measures the **debug** build. Nothing
in the output said so. Measured on identical current source:

| operation | debug | release | debug penalty |
|---|---|---|---|
| `set_global` + `get_global` (int) | 1.76µs | 364ns | 4.8x |
| Lua function returning a number | 1.05µs | 89ns | **11.8x** |
| 1000-number array round trip | 1.16ms | 150µs | 7.7x |
| `execute_script('return 1')` | 1.63µs | 596ns | 2.7x |

**The shape verdicts survive this and that is the design working** — a ratio
cancels the build, which is exactly why §4 refused stored absolutes. Had this
harness frozen nanosecond baselines, every one of them would have been wrong by
between 2.7x and 12x depending on which binary happened to resolve, and the
"regression" would have been a build flag.

**What does not survive is quoting an absolute figure out of a run.** The penalty
is uneven — 11.8x on the cheapest operation against 2.7x on the most expensive —
so debug numbers are not even uniformly pessimistic; they distort the *relative
weight* of the cheap operations against the expensive ones. Anyone reasoning
about where time goes from a debug run is reasoning about the wrong profile.

**Resolution:** the run prints the binary, its path and its build date, and warns
when it is not the optimised one. `diff-oracle` set the precedent by printing
both Lua versions and warning when they differ; an instrument that does not say
what it measured is asking to be misquoted, and this one was.

**A second thing this turned up, and it was fixed rather than filed.** The first
debug-vs-release comparison ran against `prebuilds/darwin-arm64/lua-native.node`
dated **July 13** against source from **August 6** — three weeks behind the tree,
missing `strictConversion`, the `sandbox` preset, `binaryStrings` and
`info().bindingRefs`, and it hung outright on a `timeout` probe that current code
passes. That was written up here as a standing measurement trap, which was the
wrong response to a problem with a one-line fix: `npm run prebuildify` already
existed. Regenerated (617KB → 877KB), verified to carry all four missing
features and to enforce `timeout` at 50.2ms against a 50ms deadline, and the full
suite run against it — **1122 tests, all passing on the artifact users actually
receive**, which nothing else in the tree routinely exercises.

The numbers in the table above are from a release build of current source, not
from the stale prebuild.

**Two operational notes worth keeping**, since both cost a rebuild to learn:
`npm run prebuildify` and `npm run build-release` both invoke `node-gyp rebuild`,
which **wipes `build/Debug`** — CLAUDE.md requires the debug build for testing,
so either one needs `npm run build-debug` afterward. And `prebuilds/` is
gitignored, so regenerating it is free and leaves no diff.

---

# E — findings about the plan

## E1 — the plan's claim enumeration was short by five

`PERFORMANCE-PLAN` §1 enumerated four performance claims, C1–C4, all from
`README.md`. §7 then specified a census over "README.md and docs/*.md". Building
that census and running it found **five more**, every one shipped and unmeasured:

| | Claim | Where | Cell |
|---|---|---|---|
| C5 | "Short scripts (< 1ms) … the synchronous path is faster" | `docs/ASYNC.md:84-86` | `A5-async-threshold` |
| C6 | timeout "overshoot on the order of a few hundred microseconds" | `types.d.ts` | `A6-timeout-overshoot` |
| C7 | "Every `execute_script` call compiles Lua source. For hot paths, this is wasteful." | `docs/TABLE-REFERENCE.md:50` | `A7-parse-overhead` |
| C8 | "every registered `match` predicate runs for every object-typed value crossing JS→Lua" | `types.d.ts` | `A8-js-to-lua-scan` |
| C9 | "Matching against a Proxy is not free either" | `README.md`, `types.d.ts` | `A9-proxy-read` |

Two things about that list. **Four of the five tell the reader to route on them** —
C5 says don't use async here, C7 is the stated rationale for an entire API, C8
says register fewer converters, C9 says a Proxy read is not what it looks like.
They are the same class as C2, which §1 singled out as the only claim of its
kind.

And **`types.d.ts` supplied three of them**, from a file §1 never looked at. It
ships in `package.json`'s `files`, an editor surfaces it at the call site, and it
carries claims the README never makes. The plan's own §7 named the right surface
and its §1 searched a narrower one; the census is what closed the gap, on the
first run, which is the argument for having built it before Axis A rather than
after.

This is the same shape `CORRECTNESS.md` §15.6 records at four previous levels —
an enumeration one member short — arriving now in a plan document that was
written specifically to avoid it.

---

# F — findings about the product

## F1 — hook overhead is dominated by a fixed cost the docs do not mention

**Status:** an omission, not a false claim. C3 is confirmed. Recommended: one
sentence in the README.

`set_hook` with a `count` interval costs `fixed + per-fire x fires`, and on this
machine the fixed component is **~68µs against 88µs total** at `count=1000` — 76%
of the overhead, and it is there whether the hook fires six hundred times or not
at all:

| interval | fires | overhead |
|---|---|---|
| `count=100` | 600 | 267.9µs |
| `count=1000` | 60 | 86.3µs |
| `count=10000` | 6 | 68.6µs |
| `count=100000` | 0 | 68.8µs |
| `count=1000000` | 0 | 67.0µs |

The per-fire cost is ~310ns and consistent across the rows. The fixed part is the
cost of the VM taking its hook-dispatch path at all.

**Why it is worth a sentence.** A reader tuning a sampling profiler will assume a
coarser interval keeps buying cheaper, and past roughly `count=10000` on a script
this size it buys nothing measurable — the choice is between *a hook* and *no
hook*, not between intervals. The documented claim ("overhead stays bounded") is
true and, if anything, understated.

## F2 — a shipped absolute figure was wrong by 5–20x, and has been restated

**Status:** fixed in `types.d.ts`. `PERFORMANCE-PLAN` §9 clause 2's "restated so
it is measurable" outcome, and §12.2's prediction, both landing on the same
sentence.

`types.d.ts` said timeout enforcement gives "overshoot on the order of a few
hundred microseconds". Measured over a 50ms deadline: **13–85µs**, i.e. tens of
microseconds — wrong by roughly 5–20x, in the forgiving direction.

It was never a defect in the binding. It was an absolute number in shipped
documentation, and an absolute number is a claim about the machine it was written
on. The mechanism is fixed and knowable — `InstallExecutionHook` checks the
deadline every 1000 VM instructions for a timeout-only context
(`lua-runtime.cpp:399-402`) — but how long 1000 instructions take is not.

The sentence now states the interval, says the overshoot is however long those
instructions take on your hardware, gives the measured order for a tight numeric
loop with its date, and adds the property that is actually invariant: **overshoot
does not grow with the length of the timeout**. `A6-timeout-overshoot` tests that
last pair rather than the figure, so the cell is valid on any machine.

This is the whole of `PERFORMANCE-PLAN` §4 arriving as evidence: **a performance
claim about shipped behaviour should be written as a ratio, a complexity class,
or a mechanism — never as an absolute number, because nothing in this repository
can defend one.**

## What was confirmed

Nine documented claims, all measured, none falsified. Worth stating plainly
because the interesting ones are the two that are *dramatically* true:

| Claim | Measured |
|---|---|
| C1 numbers/strings skip the converter list | flat at k = 1, 10, 100 (exponent 0.00) |
| C2 converter scan is linear and ordered | exponent 0.53; match-first 3.3µs vs match-last 13.7µs |
| C3 count-mode overhead is bounded | **77x** cheaper than line mode |
| C4 bytecode loads faster than source | 1.3x |
| C5 sync beats async for short scripts | async costs **3.8x** sync |
| C6 overshoot is bounded by the sampling interval | 0.038% of a 50ms deadline, flat as the deadline grows |
| C7 `execute_script` recompiles every call | 2.3x a retained handle |
| C8 JS→Lua converter scan is linear | exponent 0.38 |
| C9 a Proxy read is not free | **212x** a plain object read |

And no shape defect anywhere: every size-scalable crossing and every scaling knob
measured the class it declared, with no accidental quadratic in the tree.
