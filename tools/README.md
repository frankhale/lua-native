# tools/

Correctness harnesses, and — since August 6, 2026 — one cost harness. None of
these is part of the build or the published package: they are instruments the
review programme uses to search for defect classes the test suites do not cover.

`crossing-cost` is the odd one and is labelled as such throughout. Every other
instrument here asks whether an answer is **right**; it asks what the answer
**cost**, which is a different kind of question with a different kind of
evidence. A cost defect returns the correct value, slowly, so it is invisible to
all nine of the others and to every sanitizer.

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
  capability-matrix/      what does a `libraries` / `allowBytecode` /
                          `filesystem` config grant?
  binding-balance/        does the addon's own bookkeeping return to baseline?
  crossing-cost/          what does it cost, and are the docs right about that?
  gc-stress/              not a search: makes the addon do dangerous things
                          so a sanitizer has something to watch
  lint/                   not a search either: clang-tidy over src/, with the
                          checked-in /.clang-tidy
  target.mjs              which build the suite and the harnesses load
                          (native unless LUA_NATIVE_TARGET says otherwise)
  wasm-build/             builds the WASM target; not a search
```

| Harness | Run | What it searches | Docs |
|---|---|---|---|
| **invariants** | `npm run check-invariants` | Enumerations that decay: the `CallScope` classification, `lua_next` traversal sites, occupancy policies, greppable counts, the exception surface, whether every binding path to a throwing core call is guarded, the scanner's own coverage, and — the tenth, `surface-census` — whether every piece of new surface is covered by one of the harnesses below or deliberately ledgered, **including §15.6's trigger table itself**, whose rows are read out of the document and required to carry a disposition | CODE-REVIEW-18 §4, CODE-REVIEW-19 F1/F2, `docs/CORRECTNESS.md` §15.3/§15.6 |
| **exception-matrix** | `npm run exception-matrix` | 39 Lua C frames × 13 throw kinds (two of them `strictConversion` refusals, so the conversion-throw-inside-a-frame class is searched at every frame rather than checked once by hand), one process per cell — a `std::runtime_error` reaching `std::terminate`, which the sanitizers are blind to | `docs/reviews/CODE-REVIEW-18.md` |
| **diff-oracle** | `npm run oracle` | 2678 cases against stock Lua 5.5: does the embedded VM behave like the reference (mode A), and do values coming *out* survive (mode B) — `--binary` re-runs mode B under `binaryStrings`, the only column that compares the byte form against a *reference* rather than against itself | `docs/DIFFERENTIAL-ORACLE.md` |
| **roundtrip-matrix** | `npm run roundtrip-matrix` | 5 context modes × 19 entry points × 50 values: does a value survive the crossing *in*, do all nineteen doors agree with each other, and does each answer hold under `strictConversion`, `binaryStrings` and `tableAs: 'map'` as well as the defaults | `docs/reviews/CODE-REVIEW-20.md`, `docs/reviews/CODE-REVIEW-23.md` |
| **exec-parity** | `npm run exec-parity` | 1339 corpus cases × 5 doors (`--config=sandbox` re-runs the four that remain under a sealed state): do `execute_script_async`, `execute_async`, `compile`→`load_bytecode`, `call_async` and `resume_async` agree with `execute_script` — values *and* error messages | `docs/reviews/CODE-REVIEW-21.md`, `docs/reviews/INTEROP-PARITY-PLAN.md` |
| **cross-context** | `npm run cross-context` | Two contexts in one process, over three pairings including a sealed one beside an unsealed one: handles are refused, data crosses intact, contexts stay independent. The boundary CR-22 F2 found missing from every earlier list — where CR-20 F5 and CR-22 F1 both live | `docs/reviews/CODE-REVIEW-22.md` |
| **capability-matrix** | `npm run capability-matrix` | 10 configurations × (8 host entry points, 10 bytecode doors, 10 libraries): what `libraries`, `allowBytecode` and `filesystem` grant — does a door **work or refuse loudly** — never accept-and-retain; is the seal what the preset claims; and does a bytecode door refuse iff the guard is on | `docs/reviews/UNSEARCHED-REGIONS-PLAN.md` §2.1 |
| **lifecycle-matrix** | `npm run lifecycle-matrix` | 12 handle kinds × lifecycle events (reset, double reset, re-alias, GC, churn, release, double release, close, double close, close+release, release+close), one process per cell: a handle must stay valid or refuse — never answer with another state's data | `docs/reviews/CODE-REVIEW-22.md` |
| **crossing-cost** | `npm run crossing-cost` | 10 documented performance claims, 19 doors, 5 value kinds and 5 scaling knobs: does the binding cost what the docs say, and is any crossing accidentally the wrong complexity class. The **only harness here that measures time**, and the only one whose `expected.json` share holds no measurement — every verdict is a ratio or a shape taken in one process, because a frozen nanosecond baseline on a laptop reports dirt that is its own. Its `perf-claims` census rides `check-invariants`, so a new claim in shipped docs fails closed | `docs/reviews/PERFORMANCE-PLAN.md`, `tools/crossing-cost/FINDINGS.md` |
| **binding-balance** | `npm run binding-balance` | 13 bookkeeping containers × 4 series (repeat the same registration; a fixed population across pure resets; reset-and-re-register; reclaim the GC-reclaimable form), plus every counter watched in every context: does the **binding's own** retained-reference bookkeeping obey its declared lifetime policy, or strand an entry per cycle | `docs/CORRECTNESS.md` §15.10 |

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
- **A time measurement is a ratio, never a stored number.** The tenth harness
  had to be built around this and it is the reason it exists at all: a cost
  harness that freezes nanoseconds and fails on a 5% delta reports dirt on every
  busy machine, and the dirt is the instrument's. `crossing-cost` compares two
  measurements taken minutes apart in one process, so machine speed and thermal
  state cancel — the same move `diff-oracle` makes when it asserts agreement with
  stock Lua rather than asserting a value. Four of the six defects found building
  it were measurement artefacts that a stored baseline would have shipped as
  product findings (`crossing-cost/FINDINGS.md` H2–H4, H6).
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

One thing it does **not** cover, stated so the gap stays visible:
`lifecycle-matrix`'s `gc-churn` already measures the same registry mark **per
handle kind in its own process**, which this does not replace — it runs every
kind together for far more rounds, which is the shape a slow per-cycle strand
shows in and a per-kind cell does not.

**It measures the Lua side only, and `binding-balance` is now the other half.**
This paragraph used to name a second gap — the binding's own bookkeeping had no
diagnostic accessor, and adding a public one to make a test easier was a change
to the shipped API rather than an instrument's business. That was correct, and it
stood for exactly as long as it took someone to make the API decision rather than
route around it: `info().bindingRefs` ships, `binding-balance` searches it, and
`surface-census`'s census F now scores every retaining member against a declared
lifetime policy. The gap is recorded here rather than deleted because "an
instrument cannot decide this, a person must" is a real category and this is what
its resolution looks like.

## Which build is under test: `target.mjs`

Every harness and the suite import `tools/target.mjs` rather than `index.js`.
With `LUA_NATIVE_TARGET` unset it hands back `index.js`'s default export — the
same object, not a copy — so nothing about a native run changed when the file
was introduced (November 24, 2026). `LUA_NATIVE_TARGET=wasm` loads the node
variant of the debug WASM build and `wasm-release` the release one.

Two rules, both there so a green run cannot be about the wrong binary: **there
is no fallback** (a WASM target that is not built is an error naming the path,
never a quiet return to the native addon), and **an unknown value is an
error** (a typo must not mean `native`). It is an environment variable because
`exception-matrix` and `lifecycle-matrix` run one process per cell and children
inherit it. `index.js` was not edited to make this work.

The WASM binding (`docs/WASM-TARGET-PLAN.md`, Phase 2) has every method the
native one has, and all ten harnesses run under `LUA_NATIVE_TARGET=wasm` with
the native target's totals. One caveat: `crossing-cost` needs
`LUA_NATIVE_TARGET=wasm-release`, because on the unoptimised build its control
`product/injected-slowdown` fails and it refuses to proceed.

## The WASM build: `wasm-build/`

```bash
npm run vcpkg-lua-wasm       # Lua for wasm32-emscripten, via the overlay triplet
npm run build-wasm-debug     # build-wasm/debug/{node,web}/
npm run build-wasm-release   # build-wasm/release/{node,web}/
```

`run.mjs` compiles the core and `src/wasm/lua-wasm.cpp` with `em++` and links
two variants from the same objects: **node** (real filesystem; exists only so
this directory's instruments can run against the target) and **web** (the one
that ships). It refuses any Emscripten but the recorded version, and refuses a
`liblua.a` built by the stock triplet — a bare `vcpkg install
lua:wasm32-emscripten` produces one, and the reason it will not do is in
`triplets/wasm32-emscripten.cmake`.

Output goes to `build-wasm/`, **not `build/`**: `node-gyp rebuild` deletes
`build/` first, so a WASM build kept there would vanish on every
`npm run build-debug`.

It ends by running `check.mjs` against what it built, on the convention above
that a clean report must be able to come out dirty. The stack cells are the
part worth knowing about: the WASM stack cannot grow, and a release build has
no overflow check, so each cell builds the deepest call chain of one kind that
Lua allows and requires Lua's own `C stack overflow` — a trap fails, and so
does a return that never got deep. Their dirty control is a build
(`node tools/wasm-build/run.mjs release --stack-size=131072`), which fails two
of them by returning a wrong answer with no error at all.

The exhaustion cells ask about the *other* stack, the JavaScript engine's. On
this target a `RangeError` raised while Lua is running unwinds Lua's frames
without Lua or C++ being able to catch it (`docs/WASM-TARGET-PLAN.md`, "Slice
2 — as built"), so the shell detects it and refuses the context from then on.
Each cell runs one scenario under one `--stack-size` and requires that it fail
closed: an error and never a bare `WebAssembly.Exception` or a wrong answer, a
context that afterwards works or says it cannot be used, and a module other
contexts can still use. Their dirty controls are recorded beside them in
`check.mjs`. **Every number in them is Node's**; a browser's stack is a
different size.

**The web variant is validated but not executed** — Node cannot load it;
running it is the browser smoke set.

## The static check: `lint/`

```bash
npm run lint                         # controls, then src/
node tools/lint/run.mjs --control    # just the controls
node tools/lint/run.mjs --verbose    # every diagnostic with its source line
```

clang-tidy over both translation units and the three headers, using the one
configuration in `/.clang-tidy`, plus `tests/cpp/lua-native-test.cpp` held to
the **naming rules only** — the suite is gtest macros end to end, which the full
check set reads as findings. Exit 0 means zero findings. It is not counted
among the ten instruments above — it searches no boundary and runs no code —
but it obeys the first convention for the same reason they do: it lints
`lint/control.cpp` first, a file that is deliberately wrong, and refuses to go
on unless the checks named there fire — the naming check once per kind of
name, since each kind has its own option — **and** three checks the project
disables stay silent. The second half is what proves `/.clang-tidy` is the configuration
in effect rather than the tool's defaults.

Two things it treats as failures that clang-tidy itself does not:

- **A translation unit that does not compile.** clang-tidy carries on after a
  compile error and reports whatever it managed to see. The first run of this
  check's ancestor was missing an include path, produced a third of the
  diagnostics, and exited 0.
- **A bare `NOLINT`.** Every suppression must name its check; the run prints the
  full list so a new one is visible in review.

It never passes `--fix`, and nobody should without reading each change: that is
how CR-11 F1 shipped. `/.clang-tidy` lists every disabled check with its reason;
turning one off is a change to that file, not a `NOLINT` in the source.

It needs a `clang-tidy` binary, which Xcode does not ship. It looks in
`$CLANG_TIDY`, `PATH`, Homebrew's `llvm`, and a CLion install, in that order.

Its first run (November 18, 2026) found what the ten above could not, each for a
stated reason: a null test defeated by a dereference inside the branch it
guarded (two sites; the four sibling sites had it right), and — by reading the
constructor a lint pointed at — a `lua_State` leaked by every construction that
threw after `lua_newstate`, which no sanitizer here can see because none of them
sees a leak.

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

Nothing else here needs anything the addon build does not already need. All ten
expect a current `npm run build-debug`.
