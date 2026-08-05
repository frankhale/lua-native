# tools/

Correctness harnesses. None of these is part of the build or the published
package — they are instruments the review programme uses to search for defect
classes the test suites do not cover.

Each harness is a directory named for **what it does**, with `run.mjs` as its
entry point and an `npm` script as the usual way in. (They were originally named
after the review that produced them — `cr18/`, `cr20/` — which said when they
were written rather than what they were for, and stopped meaning anything about
a week later.)

```
tools/
  cpp-scan.mjs            shared: a minimal C++ scanner (comments/strings,
                          top-level functions, try-block regions)
  invariants/             lists that used to live in comments, generated and frozen
  exception-matrix/       can a C++ exception escape into the process?
  diff-oracle/            does lua-native agree with stock Lua?
  roundtrip-matrix/       does a JS value survive the crossing into Lua and back?
  exec-parity/            do the async and bytecode doors agree with execute_script?
  lifecycle-matrix/       what happens to a handle held across reset / GC?
  cross-context/          what happens when two contexts exchange values?
```

| Harness | Run | What it searches | Docs |
|---|---|---|---|
| **invariants** | `npm run check-invariants` | Enumerations that decay: the `CallScope` classification, `lua_next` traversal sites, occupancy policies, greppable counts, the exception surface, whether every binding path to a throwing core call is guarded, and the scanner's own coverage | CODE-REVIEW-18 §4, CODE-REVIEW-19 F1/F2 |
| **exception-matrix** | `npm run exception-matrix` | 36 Lua C frames × 11 throw kinds, one process per cell — a `std::runtime_error` reaching `std::terminate`, which the sanitizers are blind to | `docs/reviews/CODE-REVIEW-18.md` |
| **diff-oracle** | `npm run oracle` | 2678 cases against stock Lua 5.5: does the embedded VM behave like the reference (mode A), and do values coming *out* survive (mode B) | `docs/DIFFERENTIAL-ORACLE.md` |
| **roundtrip-matrix** | `npm run roundtrip-matrix` | 18 entry points × 50 values: does a value survive the crossing *in*, and do all eighteen doors agree with each other | `docs/reviews/CODE-REVIEW-20.md` |
| **exec-parity** | `npm run exec-parity` | 1339 corpus cases × 5 doors: do `execute_script_async`, `execute_async`, `compile`→`load_bytecode`, `call_async` and `resume_async` agree with `execute_script` — values *and* error messages | `docs/reviews/CODE-REVIEW-21.md`, `docs/reviews/INTEROP-PARITY-PLAN.md` |
| **cross-context** | `npm run cross-context` | Two contexts in one process: handles are refused, data crosses intact, contexts stay independent. The boundary CR-22 F2 found missing from every earlier list — where CR-20 F5 and CR-22 F1 both live | `docs/reviews/CODE-REVIEW-22.md` |
| **lifecycle-matrix** | `npm run lifecycle-matrix` | 12 handle kinds × lifecycle events (reset, double reset, re-alias, GC, churn, release, double release, close, double close, close+release, release+close), one process per cell: a handle must stay valid or refuse — never answer with another state's data | `docs/reviews/CODE-REVIEW-22.md` |

## Conventions every harness follows

These are not stylistic. Each one exists because its absence produced a harness
that reported clean while measuring nothing.

- **Positive controls run first, and the harness refuses to proceed if they
  fail.** An exhaustive search that reports clean must first demonstrate it can
  report dirty (CR-17). Four of the six have caught a real vacuity in
  themselves this way.
- **Per-cell vacuity checks, not just per-run.** The run-level controls pass
  while an individual cell measures nothing — two frames of the exception matrix
  never invoked their callback and reported eleven swallowed exceptions each for
  exceptions that were never raised (CR-18).
- **A ledger of known-acceptable results, where every entry carries its
  reason** — and a *stale* entry, one whose case has started passing, is
  reported rather than silently ignored. A suppression list that can only ever
  hide things hides regressions in the other direction too.
- **Never ledger an undocumented defect.** While a loss is unspecified,
  ledgering it launders a finding into a feature. It becomes ledgerable when it
  is fixed or specified on the public API.
- **Report the value, not just survival.** A swallowed error and a correct
  result are the same row unless the cell checks what actually happened
  (CR-17/CR-18).
- **A search that reports *dirty* must show the dirt is in the subject.** The
  converse of the control rule, and it cost more than the original: the
  lifecycle matrix's first three drafts produced seven findings and every one
  was the harness misreading its own probe — a registry key count read as a
  live-reference count (twice, in different ways) and a mis-typed API silently
  producing vacuous cells. All three drafts had passing positive controls at the
  time, because a control proves an instrument *can* fire, not that what made it
  fire was real. Drive every reported finding to a hand-run reproduction before
  believing it, and keep the reproduction — it is what the review writes up
  (CR-22).
- **…and then check that the thing you think is a handle *is* one.** The second
  half, learned the same day at the cost of an eighth false finding. CR-22 F1
  reproduced perfectly — an "opaque" userdata really did read as a plain table
  in a second context — and was still wrong, because `set_userdata` returns the
  caller's *own JS object* with no marker on it, so nothing had been lost and no
  handle had failed. A reproduction proves a behaviour; it does not prove the
  behaviour is a defect. Before concluding that a value was degraded, look at
  what it actually carries (`Object.getOwnPropertyNames`) and at whether the
  behaviour is already someone's deliberate, pinned decision — CR-22's first
  fix draft would have reversed the review ledger's M6 without noticing.

## Re-freezing the invariants

```bash
npm run check-invariants                 # report drift (exit 1)
node tools/invariants/run.mjs --update   # re-freeze after reviewing the diff
```

`--update` is not a way to make a red suite green. The drift is the message;
read what moved before re-freezing, or the mechanism is worth nothing.

## Prerequisites

The differential oracle needs stock Lua from the same vcpkg port that supplies
`liblua.a`:

```bash
vcpkg install lua[tools]
```

Nothing else here needs anything the addon build does not already need. All seven
expect a current `npm run build-debug`.
