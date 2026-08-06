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
                          (incl. surface-census.mjs: is each harness below
                           pointed at everything it should be?)
  exception-matrix/       can a C++ exception escape into the process?
  diff-oracle/            does lua-native agree with stock Lua?
  roundtrip-matrix/       does a JS value survive the crossing into Lua and back?
  exec-parity/            do the async and bytecode doors agree with execute_script?
  lifecycle-matrix/       what happens to a handle held across reset / GC?
  cross-context/          what happens when two contexts exchange values?
  capability-matrix/      what does a `libraries` / `allowBytecode` config grant?
  gc-stress/              not a search: makes the addon do dangerous things
                          so a sanitizer has something to watch
```

| Harness | Run | What it searches | Docs |
|---|---|---|---|
| **invariants** | `npm run check-invariants` | Enumerations that decay: the `CallScope` classification, `lua_next` traversal sites, occupancy policies, greppable counts, the exception surface, whether every binding path to a throwing core call is guarded, the scanner's own coverage, and — the tenth, `surface-census` — whether every piece of new surface is covered by one of the harnesses below or deliberately ledgered, **including §15.6's trigger table itself**, whose rows are read out of the document and required to carry a disposition | CODE-REVIEW-18 §4, CODE-REVIEW-19 F1/F2, `docs/CORRECTNESS.md` §15.3/§15.6 |
| **exception-matrix** | `npm run exception-matrix` | 39 Lua C frames × 13 throw kinds (two of them `strictConversion` refusals, so the conversion-throw-inside-a-frame class is searched at every frame rather than checked once by hand), one process per cell — a `std::runtime_error` reaching `std::terminate`, which the sanitizers are blind to | `docs/reviews/CODE-REVIEW-18.md` |
| **diff-oracle** | `npm run oracle` | 2678 cases against stock Lua 5.5: does the embedded VM behave like the reference (mode A), and do values coming *out* survive (mode B) — `--binary` re-runs mode B under `binaryStrings`, the only column that compares the byte form against a *reference* rather than against itself | `docs/DIFFERENTIAL-ORACLE.md` |
| **roundtrip-matrix** | `npm run roundtrip-matrix` | 4 context modes × 19 entry points × 50 values: does a value survive the crossing *in*, do all nineteen doors agree with each other, and does each answer hold under `strictConversion` / `binaryStrings` as well as the defaults | `docs/reviews/CODE-REVIEW-20.md`, `docs/reviews/CODE-REVIEW-23.md` |
| **exec-parity** | `npm run exec-parity` | 1339 corpus cases × 5 doors (`--config=sandbox` re-runs the four that remain under a sealed state): do `execute_script_async`, `execute_async`, `compile`→`load_bytecode`, `call_async` and `resume_async` agree with `execute_script` — values *and* error messages | `docs/reviews/CODE-REVIEW-21.md`, `docs/reviews/INTEROP-PARITY-PLAN.md` |
| **cross-context** | `npm run cross-context` | Two contexts in one process, over three pairings including a sealed one beside an unsealed one: handles are refused, data crosses intact, contexts stay independent. The boundary CR-22 F2 found missing from every earlier list — where CR-20 F5 and CR-22 F1 both live | `docs/reviews/CODE-REVIEW-22.md` |
| **capability-matrix** | `npm run capability-matrix` | 8 configurations × (8 host entry points, 10 bytecode doors, 10 libraries): does a door **work or refuse loudly** — never accept-and-retain; is the seal what the preset claims; and does a bytecode door refuse iff the guard is on | `docs/UNSEARCHED-REGIONS-PLAN.md` §2.1 |
| **lifecycle-matrix** | `npm run lifecycle-matrix` | 12 handle kinds × lifecycle events (reset, double reset, re-alias, GC, churn, release, double release, close, double close, close+release, release+close), one process per cell: a handle must stay valid or refuse — never answer with another state's data | `docs/reviews/CODE-REVIEW-22.md` |

## Conventions every harness follows

These are not stylistic. Each one exists because its absence produced a harness
that reported clean while measuring nothing.

- **Positive controls run first, and the harness refuses to proceed if they
  fail.** An exhaustive search that reports clean must first demonstrate it can
  report dirty (CR-17). Five of the eight have caught a real vacuity in
  themselves this way — most recently `capability-matrix`, whose library-closure
  control failed on its first run because the union parser had dropped `utf8`
  (a digit in the name). A count check would have passed; the control compared
  the parse against a specification that named the missing library.
- **Per-cell vacuity checks, not just per-run.** The run-level controls pass
  while an individual cell measures nothing — two frames of the exception matrix
  never invoked their callback and reported eleven swallowed exceptions each for
  exceptions that were never raised (CR-18).
- **…and per-*axis*, when an axis is a configuration rather than an input.**
  `roundtrip-matrix`'s modes are context options, and an option that were
  silently ignored produces a column that round-trips everything, agrees at
  every door and reports clean while searching nothing — vacuity at a scale no
  per-cell check can see, because every cell in it is individually valid. Each
  mode therefore proves its option is in effect before its cells are counted
  (CR-23 F4). The general rule: **whenever a new axis is a knob rather than a
  value, ask what it would look like if the knob were disconnected.**
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
- **A shared helper is shared semantics.** `js-canonical.mjs`'s `canon` is used
  by `diff-oracle`, `exec-parity` and `roundtrip-matrix`. Teaching it about
  `binaryStrings` for the oracle's new column made byte views canonicalise as
  text **for every caller**, and 532 of `roundtrip-matrix`'s ledger entries went
  STALE at once — its binary mode is written against the untouched
  representation. The fix was to decode on the oracle's side of the call and
  leave the shared function alone. Before changing anything under `tools/` that
  more than one harness imports, check who else imports it; the ledger that
  breaks will not be the one you were looking at (W2, August 6, 2026).
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

## The one file here that is not a search

`gc-stress/` reports no findings and searches nothing. It exists because a
sanitizer only sees bugs on paths that actually execute, so its value is a
function of how adversarial the execution is — and the instrumentation was
pointed at the gentlest code in the project. Run it under
`run-sanitized-ts.js` (`docs/SANITIZERS.md`); on its own it tells you only that
nothing threw. It replaces a scratch script whose results `SANITIZERS.md` cited
for two weeks after the script itself had ceased to exist.

Its patterns range over `lifecycle-matrix`'s Axis A rather than a list of its
own, so a handle kind added to the product is stressed without anyone
remembering to add it — and it fails the run if any pattern performs zero
operations, because a stress fixture reporting "no crash" over no work is the
vacuity failure every other convention here exists to prevent.

**It does carry one real check: the balance check** — the only leak detection
that works on this platform, since LeakSanitizer does not exist on macOS.
Every handle kind is minted and abandoned in one long-lived context for many
rounds, and the Lua registry high-water mark must stop growing. It runs a
control first (retain the handles instead of dropping them; the check must call
that a leak), because a leak detector that can only report clean is not one.

Two things it does **not** cover, stated so the gap is visible: the binding's own
bookkeeping (`js_userdata_`, `js_callbacks_`, the `Napi::Reference` set) has no
diagnostic accessor, and adding a public one to make a test easier is a change to
the shipped API rather than an instrument's business; and `lifecycle-matrix`'s
`gc-churn` already measures the same registry mark **per handle kind in its own
process**, which this does not replace — it runs every kind together for far more
rounds, which is the shape a slow per-cycle strand shows in and a per-kind cell
does not.

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

Nothing else here needs anything the addon build does not already need. All eight
expect a current `npm run build-debug`.
