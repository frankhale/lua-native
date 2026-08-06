# UNSEARCHED-REGIONS-PLAN

> **SUPERSEDED — executed August 6, 2026. This is a record, not an instruction.**
>
> W1–W5 are all done; each carries its own execution record below, and those
> records are the reason to read this file — three of them contradict the premise
> that motivated the work (§4.2 W3.2 most sharply: *"two premises above were
> wrong"*).
>
> **What survives as an instruction is §7's closing condition, and it now lives
> in [`../CORRECTNESS.md`](../CORRECTNESS.md) §15.10** — together with its clause
> tally (1–4 met, **clause 5 at 0 of 2**) and the ordered list of what to search
> next. Read it there. The copy in §7 below is frozen at its August 6 state and
> will not be updated as the count moves.
>
> The instruments this plan produced are current and documented where they
> execute: `capability-matrix` (§2.1) in [`../../tools/README.md`](../../tools/README.md),
> `test-harness-asan` and the re-dated stress record (§4.1, §4.3) in
> [`../SANITIZERS.md`](../SANITIZERS.md), `tools/gc-stress` (§4.2) in
> `tools/README.md`, and the `surface-census` trigger-table census (§5) in
> `CORRECTNESS.md` §15.6.
>
> This document moved here under its own supersession rule, quoted directly
> below — the rule worked, which is worth one line of evidence in a programme
> whose recurring defect was the stale marker.

**Date:** August 6, 2026
**Status:** Executed and superseded, same day. **Not survey-derived** — every
item below came from a measurement in this repository (a frozen invariant
answer, a dated sanitizer record, a ledger residual, or the programme's own
yield law), which is the bar `docs/README.md` sets for writing a plan document
at all.

**Supersession rule, stated up front so this file cannot become the thing it is
correcting:** when the work below is executed, this document moves to
`docs/reviews/` with a banner naming what replaced it, and whatever survives as
an *instruction* moves into `CORRECTNESS.md` §15, `tools/README.md`, or a
source comment. Prose is the last resort (`docs/README.md`, corollary to rule 2).
If you are reading this after **October 2026** and the closing condition in §7
has not been checked, treat every effort estimate and every "currently" in it as
stale.

---

## 1. Why this exists: yield tracks unsearched region, not code quality

Twenty-three passes have produced findings at a roughly constant rate, and the
natural reading — "the code keeps being wrong" — is contradicted by the
programme's own measurement (`CORRECTNESS.md` §15.8, CR-23's trajectory note):

> **Re-running an existing instrument finds nothing. A genuinely new search
> finds about one thing.**

Seven instruments, seven confirmations. CR-23's mode sweep — forty lines against
existing axes, not even a new instrument — made it eight, and returned one
serious finding (F1) and one medium (F2).

The consequence for planning is direct: **"future reviews yield nothing
significant" is not reachable by reviewing harder.** It is reachable only by
driving the unsearched region to zero and keeping it there by machine. Every
workstream below is aimed at that, and §7 states when it has been achieved in a
form that can be checked rather than felt.

### 1.1 The second fact worth planning around

The recurring class — *a class boundary drawn one member short* — has now
recurred at five levels of the stack:

| Level | Instance |
|---|---|
| The product | CR-17 F2 (one of four round-trip markers) |
| A fix | CR-21 F2 (arrays and objects, not the two recursing builtins) |
| An instrument | CR-22's harness drafts |
| The boundary enumeration | CR-22 F2 (cross-context, absent for 21 passes) |
| The trigger table that decides when anyone looks | CR-23 F4 (no row for a mode) |

That progression is predictive, not decorative. The next member is at the level
above the trigger table: **the `surface-census`'s own list of surface *kinds*
(options, value-taking entry points, inbound markers, host-callable frames) and
§15.2's table of deliberate exclusions.** Neither states the rule that generated
it. W4 addresses this directly, and it is the item most likely to be the one
that matters in six months.

---

## 2. W1 — Close the two `UNCLASSIFIED` rows the machinery already reports

**Effort:** hours. **Highest value per hour in this document**, because the
search has already been performed and is sitting frozen in the repo.

`tools/invariants/expected.json` currently freezes:

```json
"option: allowBytecode": "UNCLASSIFIED",
"option: libraries":     "UNCLASSIFIED",
"A. options UNCLASSIFIED": 2
```

Per `CLAUDE.md` and §15.6, `UNCLASSIFIED` means *nobody has ruled on that piece
of surface* — a review item, not a defect. These two are the only such surface
in the codebase, and both are **execution-rule options**, which is the precise
shape CR-23 F1 lived in: an option that re-rules an existing boundary, covered
by no instrument, whose loss enumeration was one member short.

**The work.** For each of `libraries` (including the `sandbox` preset) and
`allowBytecode`, decide and record one of:

- a **mode** in the instrument whose boundary the option re-rules (see W2), or
- a **ledger entry stating why it needs no search** — with a reason, per
  `tools/README.md`.

**Forbidden resolution:** editing `expected.json` to make the row say something
else. `CLAUDE.md` states this explicitly — do not silence a census row by
inventing a ledger entry; either point an instrument at it or write down why it
does not need one.

**Done when:** `A. options UNCLASSIFIED` is `0` and each former row cites either
a mode or a reason.

> ✅ **Done, August 6, 2026.** Both rows now read `COVERED` by
> `capability-matrix`. The execution record is §2.1, and it found two defects on
> the way — one of them serious. **W1's cost/benefit is the argument for W2:**
> the entire yield came from asking one question about a *mode*, which is the
> region W2 exists to search systematically.

---

## 2.1 W1 execution record — August 6, 2026

**Status: ruled, not yet closed.** One decision is the owner's (below), and one
census row cannot honestly be closed until it is taken.

### The ruling: neither option is a round-trip mode, and that is a census defect

Both options were examined against §15.1's criterion. **Neither changes how a
value converts**, so neither belongs in `roundtrip-matrix`'s Axis C. What they
re-rule is *capability*: which doors exist, and which loaders will run.

This exposes a structural flaw in census A itself. `surface-census.mjs` computes
option coverage as `modeCover` — the union of option keys set by a
`roundtrip-matrix` mode — so **an option can only ever score `COVERED` if a
round-trip mode sets it.** That is true for conversion options and false for
capability options. `libraries` and `allowBytecode` are therefore not merely
unclassified; under the census as built they are *unclassifiable*, with
`LEDGERED` the only reachable verdict.

This is §1.1's prediction landing on schedule: the member short is not an
option, it is a **kind** of option, and the enumeration that missed it is the
census — one level above the trigger table that CR-23 corrected.

### What the ruling required finding out, and what it found

Deciding whether `allowBytecode` needs a search meant asking whether its member
set is closed: **how many ways can a binary chunk enter the VM, and does the
guard cover all of them?** `FEATURES.md` E3 names two (`load_bytecode`, the
global `load`); two more are gated in passing by a hardcoded `"t"` mode
(`LoadFromReader`, `JsSearcher`).

Driven against a fresh `build-debug`, controls first (the option refuses at its
documented door; the same bytecode loads when the option is off; a *text* file
runs through the same path, so a refusal is about bytecode and not about the
path):

| Door | `allowBytecode: false` | |
|---|---|---|
| `load_bytecode()` (host) | refused | gated |
| `load(binary)` (Lua) | refused — `mode is 't'` | gated |
| file reader returning bytecode | refused — `mode is 't'` | gated |
| JS searcher returning bytecode | refused (`"t"` in `JsSearcher`) | gated |
| **`loadfile(path)`** | **loads and runs** | **not gated** |
| **`dofile(path)`** | **loads and runs** | **not gated** |
| **`require` via `package.path`** | **loads and runs** | **not gated** |
| **`require` via `add_search_path`** | **loads and runs** | **not gated** |
| **`execute_file(path)` (host)** | **loads and runs** | **not gated** |

Reachable from inside the VM with no host help, under `libraries: 'all'`:

```lua
local dumped = string.dump(function() return "OWNED" end)
local h = io.open(p, "wb"); h:write(dumped); h:close()
dofile(p)   --> "OWNED"
```

That is precisely the sequence `types.d.ts` says the option exists to prevent
(*"`string.dump` + `load` would otherwise reach the bytecode loader"*), reaching
the loader by a different door. Under `libraries: 'safe'` there is no `io` to
write with, but a **planted** binary file — attacker-controlled content already
on disk — loads the same way through both `dofile` and `require`. Under
`libraries: ['base']` alone, with no `package` and no `io`, `dofile` still
bypasses.

**Two configurations where the gate does hold, and both are accidents of
something else.** `libraries: 'sandbox'` clears `dofile`/`loadfile` and omits
`package`, so the doors are gone rather than guarded; and with a file reader
installed, `dofile` cannot reach the real filesystem at all. **The guard's
coverage is a property of the other options, not of the guard** — which is why
it can only be searched as an intersection, and is the sharpest evidence so far
for W2's premise.

### Severity, argued rather than asserted

`LIMITATIONS.md` §1 already documents that `'safe'` reaches the filesystem —
`dofile`, `loadfile` and `require` are listed there. What it does not say, and
what its own driven block invites the opposite conclusion about (it shows
`load(string.dump(f))` being stopped by `allowBytecode: false` directly beneath
that list), is that those three doors **bypass the bytecode guard**.

The distinction that makes this more than a documentation nit: executing
untrusted *source* is memory-safe, and loading untrusted *bytecode* is not —
Lua does not verify undumped chunks. So the gap converts a conceded capability
(run a `.lua` file that is on disk) into an unconceded one (corrupt the VM's
memory). By §15.5 — an ordinary caller, writing plausible JavaScript, reaching a
memory error — `{ libraries: 'safe', allowBytecode: false }` qualifies.

`execute_file` is the mildest member: the host is trusted, so it is an
inconsistency (`load_bytecode` refuses, `execute_file` does not) rather than a
hole.

### Resolution — close the gate (owner's decision, August 6, 2026)

`tools/README.md` forbids the shortcut (**never ledger an undocumented defect**,
because that launders a finding into a feature), so the row could not close
until the behaviour was fixed or specified. The owner chose to fix it.

All five file doors are now text-only under `allowBytecode: false`.
`InstallBytecodeFileGuards` wraps `loadfile` (forwarding a forced `"t"`) and
rebuilds `dofile` on the original `loadfile` (it takes no mode argument, so
there is nothing to forward), and replaces `package.searchers[2]` with
`SafeLuaSearcher`, which resolves through `package.searchpath` and loads with
`luaL_loadfilex(..., "t")`. `ExecuteFile` and `CompileFile` pass `"t"` directly.

**The wrappers install conditionally, which is the part that needed care.** A
file reader owns the same two globals and removes its overrides by *identity*;
wrapping `LuaDoFile` would have left a reader that could never be uninstalled —
CR-23 F3's failure one feature over. A global already text-only by construction
is therefore left alone, and both install orders are pinned.

**A second defect surfaced while fixing the first, and it was the more likely of
the two to be hit.** `SafeLoad` always pushed a fourth argument to the original
`load`, and Lua decides "was an `env` supplied" with `lua_isnone` — so an
explicit nil counted as *supplied* and `load_aux` set the chunk's `_ENV` to nil.
Every chunk that touched a global died under `allowBytecode: false`:

```
load("return x")()   -- attempt to index a nil value (upvalue '_ENV')
```

It survived because the pinning test loaded `return 7` — a chunk with no `_ENV`
upvalue, which cannot detect the bug. That is §10.4's class (a test unable to
distinguish the failure it exists to catch) in the guard's own suite, and the
replacement test now asserts what the original could not.

**Verified.** 1114 TypeScript tests (up 14), 285 C++ tests, ten invariants
(three re-frozen: `+9 toThrow examined` with bare still 0, `+5 core functions`,
`+3 Lua C frames` — all three scored non-host-callable by the computed
predicate, so no exception-matrix row was owed), and four harnesses re-run
against the change: exec-parity 6689/0, roundtrip 3800 cells / 0 undocumented /
0 parity disagreements, exception-matrix 429/429, oracle 2678 / 0 disagreements.
Nine doors refuse; twenty regression cases covering the text paths, both
composition orders with a file reader, `reset()`, and default mode all hold.
`FEATURES.md` E3, `LIMITATIONS.md` §1 and `types.d.ts` are corrected —
`allowBytecode` had no JSDoc at all and now states the guarantee door by door.

### W1 is closed — `A. options UNCLASSIFIED: 2 → 0`

**The instrument.** `tools/capability-matrix/` (`npm run capability-matrix`), the
eighth harness: **203 cells across 8 configurations** — `all`, `safe`,
`sandbox`, `bare`, `base-only`, `all+nobytecode`, `safe+nobytecode`,
`sandbox+bytecode` — against 8 host entry points, 10 bytecode doors and the 10
libraries. Three properties:

1. **Work or refuse loudly, never accept-and-retain.** An entry point that
   returns normally while doing nothing observable is a plausible answer rather
   than an error — §15.1's criterion exactly, and `LIMITATIONS.md` §8's class.
   CR-23 fixed one member on `set_read_handler` and checked its siblings **by
   hand**; that check now runs. Each door therefore declares how to *observe its
   effect*, not just how to be called.
2. **The seal is what the preset claims.** Every name in the `LuaLibrary` union
   is classified present-or-sealed in every configuration, and the union is
   parsed from `types.d.ts` — so a library added to the API cannot be forgotten
   by the matrix.
3. **A bytecode door refuses iff the guard is on** — an implication, so the
   guard-off columns are meaningful too, which is where an over-reaching guard
   would show. Two doors are marked `alwaysRefuses`: the file reader and the JS
   searcher are text-only in *every* mode by design, and saying so stops them
   reading as guard coverage they do not provide.

**Two things it caught on its own first runs, both in itself.** The library
closure control failed because the union parser used `[a-z]+` and dropped
`utf8` — a count check would have passed; the control compared the parse against
a specification that named the missing library. Then four cells reported
"BYTECODE DOOR CLOSED WITHOUT CAUSE" for the file-reader channel, which is
documented text-only in every mode: the implication was the harness's model, not
the product's contract. Both are the `tools/README.md` rules earning their place
again — the running count of probe/instrument false findings is now twelve, every
one the harness misreading itself.

**The census change.** Census A scored an option covered iff a `roundtrip-matrix`
mode set it. It now ranges over a **list of instrument axes** (`AXES` in
`surface-census.mjs`), with the rule stated beside it — *an option is covered iff
some instrument's configuration axis varies it* — and coverage names its
instrument (`capability-matrix:sandbox`). A third instrument with a config axis
joins by being added to that list.

**Verified after the change:** 1117 TypeScript tests, 285 C++ tests, ten
invariants clean (`surface-census` re-frozen: two rows UNCLASSIFIED → COVERED,
the two conversion rows re-labelled with their instrument, `+1` axis count), and
`capability-matrix` clean at 203 cells / 0 findings. `CORRECTNESS.md` §15.1
records that this is an **axis, not an eighth boundary**; §15.6 splits the
conversion/capability trigger; §15.7 and `tools/README.md` carry the new run.

## 3. W2 — Make *mode* a shared axis, not a `roundtrip-matrix` axis

**Effort:** ~1 day for the first cell, less for each after.

CR-23 F4 answered "an option forks a boundary into modes; who searches the
non-default mode?" for exactly one instrument. **The other six still run under
default options only.** That is the region CR-23's serious finding came out of,
and it is currently unsearched for six of seven boundaries.

The full cross-product is not worth running. Bound it with a rule, and record
the rule beside the enumeration (§1.1's lesson, applied pre-emptively):

> **Run instrument I under mode M only where M re-rules the boundary I
> searches.**

That selects four cells:

| Cell | Why it is on the list |
|---|---|
| `exception-matrix` × `strictConversion` | A strict refusal **throws from inside a Lua C frame** — the CR-6 F1 abort class, the one thing the sanitizers are structurally blind to. CR-23 verified this by hand, once, unrepeatably (see its "Verified and rejected" section). **Highest-value cell in this table.** |
| `exec-parity` × `allowBytecode` / `sandbox` | The bytecode door under a seal. Also discharges both W1 options. |
| `diff-oracle` mode B × `binaryStrings` | Values leaving Lua under byte mode, against the stock interpreter. |
| `lifecycle-matrix` / `cross-context` × `sandbox` | Handles from a sealed context, and a sealed ↔ unsealed pair. |

**Every new mode needs its own vacuity control** before its cells count —
`tools/README.md`'s per-*axis* rule, which exists because a disconnected knob
produces a column that agrees everywhere and searches nothing. This is not
optional and it is the part most likely to be skipped under time pressure.

**Done when:** each cell above either runs or carries a ledgered reason, and each
mode proves its option is in effect.

### W2 execution record — August 6, 2026

| Cell | Shape it took | Result |
|---|---|---|
| `exception-matrix` × `strictConversion` | **two new Axis-A kinds**, not a second matrix | 507 cells (was 429), **0 to read** |
| `exec-parity` × `sandbox` | `--config=` axis | 5356 cells, 0 disagreements |
| `diff-oracle` mode B × `binaryStrings` | `--binary` flag + a byte-aware canon | 1339 cases, 0 disagreements |
| `cross-context` × `sandbox` | **three pairings**, including the mixed pair | 72 checks, 0 findings |
| `lifecycle-matrix` × `sandbox` | **not built — ruled against, below** | — |

**The strict cells took the shape the instrument already had, and that is the
finding of this round.** Re-running all 429 cells with the option on would spend
8 of every 11 on kinds the option cannot affect. `strictConversion` changes
exactly one thing — whether a *conversion* refuses — and Axis A already models
"the addon's own conversion throws on the return path with the Lua frame still on
the stack" (`return_symbol`, `return_bigint_out_of_range`, `return_deep_object`),
with `options` already on every kind. So the mode entered as two more ways to
refuse, run against all 39 frames. **This is the class CR-23 could only check by
hand, for one frame, in a scratch script; it is now all thirty-nine, every run.**

Twenty of the new cells reported SWALLOWED on the first run — ten frames whose
return value never enters the JS→Lua converter at all (a searcher must return
source text, a setter's return is discarded, a from-Lua converter's result is
used verbatim, `pcall` hands its result back to *JavaScript*). The harness's
model again, not the product's contract. Each is now a ledger entry carrying its
own reason. The other 58 are clean, which is the assertion that was wanted.

**Why `lifecycle-matrix` × `sandbox` was ruled against rather than built** —
recorded because a bounded search must say what it dropped. Handle lifetime is a
property of registry references and `ContextLiveness`, neither of which the
library set touches; a sealed context cannot mint several of the handle kinds, so
the column would be *smaller* than the one it copies rather than differently
informative. The pairing that does raise a new question — a sealed context beside
an unsealed one — is a `cross-context` question, and it is the pairing that got
built. If that reasoning is wrong, the cheap disproof is one `--config` run of
the existing cells.

**Each new column proves its knob is connected.** The oracle's binary column
carries a vacuity control asserting a Lua string arrives as a `Uint8Array` *and*
that the byte form canonicalises to the text form — without it, an ignored option
would agree with the reference on all 1339 cases and report a clean sheet having
searched nothing. `exec-parity`'s sandbox column drops the bytecode door (it
refuses by definition when the guard is on) and **announces the drop**; its
"every active door runs the case" control follows the door set rather than a
hardcoded six, which is what it flagged on the first sandbox run.

---

## 4. W3 — Memory: three real gaps

This is the area whose coverage is weakest relative to its reputation. All three
sub-items are verifiable against files in the repo today.

### 4.1 The harnesses never run under ASan — **the biggest one**

`npm run test-ts-asan` instruments the addon and then runs **vitest**:
`run-sanitized-ts.js` hardcodes the vitest binary (`node --expose-gc <vitest>
run --pool=threads --no-file-parallelism`). Nothing else runs instrumented.

But the *adversarial* paths — released handles, double reset, re-alias, GC churn,
double close, throws from C frames, two contexts exchanging handles — live in
`lifecycle-matrix`, `exception-matrix` and `cross-context`. **That is exactly
where handle and finalizer use-after-frees live**, and it runs uninstrumented.
No new search is needed here; the cells exist. Only the instrumentation is
missing.

**Known implementation risk, flagged rather than discovered later:** the
matrices spawn one child process per cell, and `run-sanitized-ts.js` documents
that the preload does *not* survive vitest's fork pool on macOS — which is why
it forces the threads pool. Verify early that the preload reaches a harness's
child processes (set explicitly on the spawn env) before budgeting the rest.

**Cost note:** ASan × one-process-per-cell is slow (396 exception cells, 78
lifecycle cells). This belongs in the pre-release sweep, not the routine loop.

### 4.2 There is no leak detection at all

`SANITIZERS.md`: `detect_leaks=0`, because LeakSanitizer is unsupported on
macOS. So none of the four sanitizer harnesses can see a leak — a fact stated
plainly in that document and easy to miss behind "four sanitizer harnesses, all
clean".

**The substitute that works here is a registry-balance assertion in the
product:** after reset / close / GC-drain, the `luaL_ref` registry population,
`js_userdata_`, the stored host-function table and the `Napi::Reference` set all
return to baseline. Make it **fail closed**, the way the four classes in §15.6
already do, and drive it from `lifecycle-matrix`, which is the only thing that
exercises the events that would strand an entry.

Precedent that this class is real and still open: `CODE-REVIEW-LEDGER`'s CR-8 F6
residual — *"the stranded constructor `js_userdata_` entry"* — is exactly this
shape and is one of the two residuals that ledger still carries.

### W3.2 execution record — August 6, 2026, and **two premises above were wrong**

**"Nothing sees a leak" was too strong.** `lifecycle-matrix`'s `gc-churn` event
already measures the Lua registry high-water mark per handle kind, one process
each, with the correct technique (a warm-up round to establish the mark, then
require it to hold — because `luaL_unref` frees a slot onto a free list rather
than deleting the key, so a raw count only rises). That is a real leak check and
it predates this plan.

**And the CR-8 F6 residual is not an open bug to close.** Reading it: an eager
rollback of the stranded entry is *deliberately* not attempted, because whether
the partially-pushed value already materialized the Lua userdata — whose `__gc`
would erase the entry, making the rollback a double free — is undecidable at the
failure site. It is OOM-window-only, bounded, and reclaimed at teardown. A leak
check does not close it; it would merely observe it under OOM.

**What was actually missing, and is now built:** the *aggregate* balance —
every handle kind minted and abandoned together in one long-lived context over
many rounds, which is the shape a slow per-cycle strand shows in and a per-kind
cell does not. It lives in `tools/gc-stress/run.mjs`, runs after the stress
patterns, and **runs a control first**: retain the handles instead of dropping
them, and require the check to call that a leak. Measured: control fires (growth
120 over four rounds); the real run is flat at 67 slots across twelve.

**Its first run reported a 40-slot-per-round leak in the product, and the dirt
was mine.** A napi finalizer is *queued*, not run inline, so a synchronous
`gc(); gc()` collects the JS handle and never runs the finalizer that releases
its registry slot. `lifecycle-matrix` already had this right — its `forceGc`
awaits a turn of the event loop between collections — and the fix was to import
that helper rather than keep a second definition of "force a collection". Eleventh
instrument false finding in this tree; the rule that caught it is the same one
that caught the other ten.

**What it still does not cover, stated rather than implied:** the binding's own
bookkeeping (`js_userdata_`, `js_callbacks_`, the `Napi::Reference` set) has no
diagnostic accessor. Adding a public one to make a test easier is a change to the
shipped API and therefore the owner's call, not an instrument's side effect. Both
leak checks measure the Lua side only.

### 4.3 The ASan evidence is stale

`SANITIZERS.md`'s clean run is dated **July 21, 2026** against a **454-test**
suite. The suite is now ~1092 tests, and `sandbox`, `binaryStrings`,
`strictConversion`, `set_read_handler`'s synthesized `io`, the class accessors
and the new async doors **all landed after that date**.

**The work:** re-run all four harnesses, re-date the record, and extend the
`--expose-gc` stress patterns to the handle kinds added since — above all the
**async coroutine cursor**, which §15.6 notes is `shared_ptr`-owned and can
outlive its iterator, and which did not exist when those patterns were written.

---

## 5. W4 — Every enumeration gets the rule that generated it

**Effort:** hours each, and this is the item that pays off latest and largest.

This is CR-23's own closing conclusion, not a new idea:

> **An enumeration has to record the rule that generated it, or it cannot be
> checked for completeness — only extended when something leaks past.**

§15.1 (boundaries) has its criterion. §15.6 (triggers) got one in CR-23. Three
enumerations still lack one:

| Enumeration | Why it matters |
|---|---|
| `LIMITATIONS.md` §5, the documented silent losses | **The direct root cause of CR-23 F1** — `strictConversion` was built from this list and was short the same member the list was short. |
| `CORRECTNESS.md` §15.2, "not covered by a generated search, and why" | An exclusion list with no generating rule is the same failure one level over: it can only be extended when something leaks past. |
| `surface-census`'s list of surface **kinds** (options / entry points / markers / frames) | §1.1's prediction. A new *kind* of surface is the next member-short, and today nothing would notice one. |

Where the rule is mechanical, **compute it** — `surface-census.mjs` is the
template for what that looks like and is the reason this programme stopped
re-deriving the same lists by hand.

### W4 execution record — August 6, 2026

All three done, and the third turned out to be computable.

**`LIMITATIONS.md` §5** now states the rule its rows come from: *a value crosses
between JS and Lua and arrives different, for a reason that is a property of the
two type systems rather than of the caller's data*. Three clauses, each doing
work — which is what makes the refusal rows ("no — throws") belong in the table
for contrast rather than be omitted, and what makes the byte-key row **derivable**
rather than discovered. Lua keys are bytes and JS property names are text; the
row follows from the rule. Nobody had derived it, `strictConversion` was built
from the table, and the option shipped short the same row (CR-23 F1).

**`CORRECTNESS.md` §15.2** now states its rule: *an area belongs here when it
fails a clause of §15.1's criterion, and the row must name which clause*. Applied,
it separates two things the table had been mixing — a row claiming the suite is
*sufficient* (resource limits, module resolution: both fail clause three, they
raise) from a row admitting a **gap** (data races, which fail no clause and are
simply unsearched). An exclusion list that cannot tell those apart is a place to
put things.

**The third was the mechanical one, and it closes the level CR-23 opened.**
`surface-census` gained a fifth census that reads §15.6's trigger table **out of
`CORRECTNESS.md`** and requires every row to carry a disposition: `COMPUTED` (a
census derives its universe), `FAILS-CLOSED` (the mechanism reddens the suite on
its own), or `MANUAL` with its reason. Twelve rows — five computed, three fail
closed, four manual. A row added in prose without a ruling reports `UNDISPOSED`
and the suite goes red; a disposition whose row is deleted reports `STALE`.
Demonstrated in both directions before freezing.

**The four `MANUAL` rows are the honest residue**, and naming them is most of the
value: "executes a script" and "is asynchronous" are properties of a method body
rather than of a signature; a Lua version bump happens in vcpkg where nothing
here can observe it; a new threading mode would invalidate every instrument's
assumptions rather than add a row. Those four are where a human still decides —
and they are now the only four, which is a statement §15.6 could not previously
make about itself.

---

## 6. W5 — Change what a pass *is*

**Effort:** none. It is a decision, and it saves time rather than costing it.

Stop producing numbered general read-throughs. The last month's data is
unambiguous about where yield comes from:

| Pass shape | Result |
|---|---|
| Named sweep against a **declared unsearched region** (`INTEROP-PARITY-PLAN`) | 5 catches, 3 of them defects review had not found |
| A **new axis** on an existing instrument (CR-23's mode sweep) | 1 serious, 1 medium |
| Re-running the seven instruments | 0, seven times |

So each future pass should **declare its unsearched region up front**, and its
deliverable should be **an instrument plus a ledger entry**, not a document. The
trigger stays what §15.6 made it — new surface, or the census reporting
`UNCLASSIFIED` — and never a date.

### W5 execution record — August 6, 2026

**Adopted, and recorded where it executes rather than here.** The decision is
`CORRECTNESS.md` **§15.9**, listed in that document's own header table, with the
yield data that justifies it and the three obligations a pass now carries:
declare the region, deliver an instrument and a ledger entry, prove the
instrument can report dirty before believing it clean. `CLAUDE.md` carries the
short form.

Recorded there and not here for the reason `docs/README.md` gives about the three
reflective documents that rotted: **a rule whose only home is a plan document
dies with the plan.** This file becomes history the moment its items are done;
§15.9 is the operating manual and stays current. CODE-REVIEW-23 was the last
numbered pass.

---

## 7. The closing condition, stated so it can be checked

> **Frozen at its August 6, 2026 state.** The live copy — the one that gets
> updated as clause 5 moves — is `CORRECTNESS.md` §15.10.

Without this, the question "what should we do about correctness?" regenerates
every few weeks — which is §14's lesson about the word *deferred*, applied to
the exit criterion itself.

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

**Clause 5 is the load-bearing one, and today the count is zero.** Every new
search ever built here has found something. Until a genuinely new search comes
back empty twice, the region space is not closed, however clean clauses 1–4
read. Clauses 1–4 are the work; clause 5 is the evidence.

### Status — August 6, 2026, after W1–W5

| # | Clause | State |
|---|---|---|
| 1 | `surface-census` reports 0 `UNCLASSIFIED` | ✅ **met** — and it now also reports 0 `UNDISPOSED` on the trigger table itself |
| 2 | Every enumeration cites its generating rule | ✅ **met** for the three that lacked one (§5, §15.2, the census's kind list) |
| 3 | Every instrument runs under every mode that re-rules its boundary | ✅ **met**, with one cell ruled against and the ruling written down |
| 4 | ASan covers the harnesses; a leak check that works on macOS | ✅ **met** — `test-harness-asan`, and two registry-balance checks |
| 5 | **Two consecutive new searches return zero serious findings** | ⏳ **0 of 2** |

**Clause 5 did not move, and that is the honest reading of this work.** W1's
ruling produced a serious finding (the bytecode guard, five doors short) plus a
second defect beside it. W2's four columns found none — but three of them are
*new axes on existing instruments* rather than new searches, and the fourth
(`exception-matrix` × strict) found nothing only after twenty of its cells turned
out to be the harness's model rather than the product's. W3 and W4 found two more
things about the *instruments* — a stale claim citing a script that no longer
existed, and a balance check that reported a 40-slot leak that was its own
missing `await`.

So the count stands at zero, and the next two genuinely new searches are what
would move it. **The most likely candidates, in order:** the binding's own
bookkeeping maps (no diagnostic accessor exists — see W3.2), and the four
`MANUAL` rows in §15.6, which are now precisely identified as the places a human
still has to decide.

---

## 8. Two things deliberately *not* on this plan

**Do not build an eighth boundary instrument for its own sake.** §15.8 predicts
it would find about one thing — but there is **no unsearched boundary left to
aim it at**. The remaining yield is in *modes and intersections* (W1, W2), which
is empirically where CR-23's serious finding actually came from.

**Do not re-run the existing seven expecting yield.** That is the half of the
yield law with seven confirmations. Run them as regression (§15.7), not as
search.

---

## 9. Suggested order

| # | Item | Effort | Rationale |
|---|---|---|---|
| 1 | **W1** — the two `UNCLASSIFIED` options | hours | The machine is already pointing at it; it is the only surface nobody has ruled on |
| 2 | **W3.1** + **W3.3** — ASan over the harnesses; re-date the record | hours–1 day | Existing cells, missing instrumentation; and the current evidence predates half the surface |
| 3 | **W2**, `exception-matrix` × `strictConversion` first | ~1 day | The abort class the sanitizers cannot see, currently verified once by hand |
| 4 | **W3.2** — the registry-balance assertion | ~1 day | The only leak check possible on this platform; closes a standing ledger residual |
| 5 | **W4** — criteria beside enumerations | hours each | Latest payoff, largest; §1.1 says this is where the next one is |
| 6 | **W5** — adopt the sweep format | — | A decision, not work |
