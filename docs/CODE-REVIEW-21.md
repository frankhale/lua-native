# CODE-REVIEW-21

**Date:** August 4, 2026
**Scope:** Twenty-first pass. Primary target: **the first two of the three
boundaries CODE-REVIEW-NEXT-STEPS A3 lists as never mechanically searched** —
the async surface end-to-end (`execute_script_async`, `execute_async`) and the
bytecode round trip (`compile` → `load_bytecode`) — plus verification of the
CR-20 remediation commits and an audit of the open programme items (A1, A2,
A5).

**Method:** A new instrument, `tools/exec-parity/` (`npm run exec-parity`),
per the announcement convention. The property is metamorphic, like the
round-trip matrix's: the doors are their own references. Every case from the
differential oracle's generated corpus is run through `execute_script` and
through each alternate execution door, and the outcomes — values *and* error
messages — must agree. The corpus is reused deliberately: it is generated, it
is known to terminate in the embedded VM, and `execute_script`'s answers over
it are oracle-verified against stock Lua 5.5 — so a door that disagrees with
`execute_script` here disagrees with the reference, not merely with a sibling.

**1339 cases × 3 doors = 4017 cells:**

- **worker** — `execute_script_async(s)`: same VM, executed on a libuv thread,
  marshalled by the worker's `OnOK`.
- **driver** — `execute_async(s)`: the script runs as a coroutine driven by
  `DriveAsync`/`ResumeAsyncStep`.
- **bytecode** — `compile(s)` then `load_bytecode(bc, s)`: the same chunk
  through the dump/undump cycle, chunk-named identically to every direct load
  site so an error-location difference is a real difference.

Eight positive controls run first (the standing rule: a search that reports
clean must first demonstrate it can report dirty), including the two vacuity
hazards specific to this instrument: the worker door proves the work is
deferred past the call (`is_busy()` true while queued), and the driver door
proves the await machinery actually suspends and resumes (a Promise-returning
host function resolves in-script). A door implemented as a thin synchronous
wrapper would otherwise sail through every comparison.

**Baseline:** 285 C++ tests pass; the exception matrix reports 297/297 clean;
the round-trip matrix 456 identical / 144 specified / 0 undocumented with
parity 50 of 50; the differential oracle 0 disagreements in 2678;
`test-ts-asan` runs the full suite under ASan+UBSan with no reports. **The
TypeScript suite arrived red**: 912 of 913, with `invariants.spec.ts` failing
on a `greppable-counts` drift introduced by the most recent commit — which is
itself a finding (F3), because the drift is a false positive.

**Findings were reported open and fixed subsequently.** The resolution table is
below; the findings themselves are unchanged from when they were written,
except that **F1's scope was corrected by the fix** — driving it turned up that
one of its two cells was not a defect at all. That correction is recorded in
the resolution rather than edited into the finding, because the finding is the
record of what the instrument reported.

---

## Headline

**4017 cells, two disagreements, one root cause — and every finding this pass
is the same shape: a rule applied at an enumerated set of sites that was one
member short.**

The parity results first, because two of them retire boundaries:

- **The worker door agrees with `execute_script` on all 1339 cases.** Values,
  error messages, error locations. The handoff to the libuv thread and the
  marshal back are transparent over the whole corpus.
- **The bytecode door agrees on all 1339 cases**, syntax errors included. The
  dump/undump cycle preserves behaviour exactly. A3's second boundary is
  searched and clean on first contact.
- **The driver door agrees on 1336, with one ledgered divergence** —
  `coroutine.isyieldable()` is true inside `execute_async`, which is the
  documented execution model ("Executes a Lua script as a coroutine",
  `types.d.ts`) observed from inside the script — **and two real
  disagreements, both in the error-object family, both one defect** (F1).

Then the shape. CR-19 named the recurring failure in this codebase: *a class
boundary drawn slightly too small — a considered boundary, argued for in
prose, and short by a little.* This pass found three instances, one per
finding:

> **F1**: the "describe a non-string error value" rule is implemented in the
> pcall message handler — and `lua_resume` has no message-handler slot, so the
> one execution door that doesn't go through `lua_pcall` never runs it.
> **F2**: CR-20 F2's cycle detection pushes plain objects and arrays onto the
> conversion path — and not the two builtin containers (`Map`, `Set`) that
> also recurse, so a cyclic Map still gets the wrong error. **F3**: the
> `greppable-counts` invariant counts `constexpr napi_type_tag` — a pattern
> one declaration-form too wide, which a benign `const`→`constexpr` cleanup
> stepped into, turning the suite red over a tag that does not exist.

None is serious by §10's definition — no crash, no memory error, no silent
wrong *value*, no leak. F1 is a wrong (and less informative) error message
reachable by an ordinary caller; F2 is a wrong diagnosis with a
wrong-direction remedy; F3 is red-suite noise. The high count is zero for the
third time in four passes.

---

## Resolution status (August 4, 2026)

**All three findings resolved.** After the fixes: **934 TypeScript tests** (up
from 913 — 21 CR-21 pins) and **285 C++ tests** pass; both ASan harnesses are
clean; the invariants, the exception matrix (297/297), the differential oracle
(0 disagreements), the round-trip matrix (456 identical / 0 undocumented,
parity 50 of 50) and this pass's parity matrix all run clean. **exec-parity is
now 4015 agree / 2 ledgered / 0 disagreements.**

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Fixed, and **the finding was half wrong** | `ResumeAsyncStep` now runs **`MessageHandler` itself**, under its own `lua_pcall`, instead of re-implementing half its rule. All doors now agree for `error({code=7})`, `error(true)` and `error(5)` — description *and* traceback. See below for the half that was not a defect. |
| F2 | ✅ Fixed | The cycle check and `ConversionPathEntry` moved **above** `ConvertBuiltinType`, so the two recursing builtins join the path they are compared against. Placement rather than a check inside each container branch, because "recurses" is a property of the builtin set — a new recursing builtin would otherwise be short by the same member a third time. Seven pins added, including CR-20's DAG control restated for Map, and one asserting the non-recursing builtins (`Date`, `RegExp`, the binary views) stay inert on the path. |
| F3 | ✅ Fixed, `expected.json` untouched | The pattern is anchored to the definitional form `inline constexpr napi_type_tag k…`. The count is 6 again, matching the frozen value, and the six are verified **by name**. Proven still able to report dirty: a genuine seventh tag appended to the header reports 7. |

### F1's correction: one of its two cells was never a defect

Driving the fix turned up that `error(nil)` differs at the driver door for a
reason that is **upstream of this binding entirely**. Lua replaces a nil error
object with the string `"<no error object>"` before `lua_resume` returns, so
the driver door receives a *string* where the pcall doors receive nil. Shown
from inside Lua, with no lua-native code involved:

```lua
local co = coroutine.create(function() error(nil) end)
local ok, e = coroutine.resume(co)
return type(e)     --> "string"
```

No formatting rule can recover the nil from that, and converging it would mean
matching on liblua's internal string — which would also mistranslate a user's
own `error("<no error object>")`. It is ledgered in
`tools/exec-parity/accepted.mjs` with that reason and pinned in the suite as a
*language* behaviour, so it cannot later be "fixed" by string-matching.

This is worth recording as a method note rather than an embarrassment: the
review reported two cells as one defect because they looked alike in the
matrix output. **The instrument was right that the cells differ; the finding
was wrong about why.** A finding is a hypothesis about a cause, and this one
survived to the fix stage before being tested — the same "confident about the
boundary" failure the pass's own headline is about, committed by the pass
describing it.

### A fourth change the fix forced, and the mechanism that demanded it

The F1 fix adds one `lua_pcall` to the core, which drifted the
`exception-surface` invariant (`lua_pcall calls (core): 7 → 8`). Every other
number in that invariant was verified unmoved before re-freezing. **This is the
legitimate use of `--update` and the exact contrast with F3**: here the
*subject* moved and the diff is the record of it; in F3 the *instrument* was
wrong and re-freezing would have laundered a false positive into the baseline.
Both arrived as the same red suite, one command apart — which is the argument
for reading drift rather than clearing it.

---

## Findings

### F1. `execute_async` formats non-string error values through a different path than every other door (medium)

Found by the instrument: 2 disagreeing cells of 4017, both at the driver door.

**Driven.**

```js
lua.execute_script('error({code=7})');   // and _async, and via bytecode
// Error: (error object is a table value)
//        stack traceback: ...

await lua.execute_async('error({code=7})');
// Error: table: 0x8c51c60d0          <-- raw address, no description, no traceback

lua.execute_script('error(nil)');
// Error: (error object is a nil value) + traceback

await lua.execute_async('error(nil)');
// Error: <no error object>            <-- liblua's own string
//        stack traceback: ...
```

Three doors agree — sync, worker, bytecode — because all three execute under
`ProtectedCall`, which installs `LuaRuntime::MessageHandler`
(`lua-runtime.cpp:2074`): preserve structured JS-error tables, try
`__tostring`, else describe the value as `(error object is a %s value)`, then
append a traceback.

The driver door cannot install it: **`lua_resume` takes no message handler**
— that is a Lua API fact, not an oversight in the call. `ResumeAsyncStep`
compensates, but only for half the cases (`lua-runtime.cpp:3710–3728`): a
*string* error gets `luaL_traceback` appended; a *non-string* error falls
through to `CaptureError` → `ErrorValueToString`, whose fallback chain is a
raw `.message` probe, a protected `tostring` — which for a plain table is the
address form — and only then the `(error object is a ...)` description. So
the description that three doors emit is produced at the fourth door only when
`tostring` itself fails, `error(nil)` surfaces whatever string liblua left on
the resume stack, and a table error additionally loses its traceback (note the
asymmetry inside the door: `error(nil)` *has* a traceback above, `error({...})`
does not, because only the string branch tracebacks).

**Why it matters beyond the message.** The differential oracle's ledger entry
for `error/e12`/`e13` reads: "lua-native describes a non-string error value
rather than calling tostring on it … Both are deliberate and strictly more
informative than an address." That is the binding's stated behaviour, and it
is now measured to hold at three doors of four. The door where it fails is the
one recommended for scripts that interact with JS — exactly where a rejection
value like `error({code=7})` is most likely to be used.

**Recommendation (implemented).** In `ResumeAsyncStep`'s error branch, apply
`MessageHandler`'s logic to non-string errors too. The logic wants to be
shared with `MessageHandler` rather than mirrored, or the next barrier added
will be short by the same member.

**What was done.** Stronger than "shared": the path now calls
**`MessageHandler` itself** through a `lua_pcall`, so there is no second copy
to keep in step. The protected call is not incidental — the handler invokes
`__tostring`, which is user Lua, and a raising `__tostring` reaching that
otherwise-unprotected frame would panic the state; `ErrorValueToString` guards
the identical hazard the same way, on the same thread, two lines below, so
pcall-ing a dead coroutine's stack is established practice here rather than a
new risk. A formatting failure keeps the original error rather than replacing
it.

One unplanned improvement fell out: the extra call frame shifts
`luaL_traceback`'s level such that the driver door's traceback now *also*
includes the `[C]: in global 'error'` line the pcall doors show. The doors
agreed on the message and disagreed on the traceback before; they now agree on
both.

### F2. A cyclic `Map` or `Set` is still reported as a depth-limit error (low)

CR-20 F2's fix, one boundary short. `NapiToCoreImpl` pushes the value being
converted onto `conversion_path_` in the object/array branch — *after*
`ConvertBuiltinType` has had its chance. `ConvertBuiltinType` recurses into
`Map` values and `Set` elements (`lua-native.cpp:148,161`) without pushing the
container, so a container that contains itself never appears on the path it
is compared against.

**Driven.**

```js
const m = new Map(); m.set('self', m);
lua.set_global('x', m);
// Value nesting depth exceeds the maximum of 100 levels   <-- CR-20 F2's wrong message

const s = new Set(); s.add(s);
lua.set_global('x', s);
// Value nesting depth exceeds the maximum of 100 levels
```

The two controls that made CR-20's fix a cycle check rather than a sharing
check still hold through the containers — driven as part of this pass: a
cycle threaded object→Map→object **is** caught (the object is on the path),
and a DAG via a Map (the same object as two values) **is** accepted. Only a
cycle whose every participant is a builtin container misreports, plus the
self-containing container above.

The cost profile is also CR-20 F2's: a hundred levels of conversion work —
here including a hundred `Array.from` calls allocating entry arrays — before
the wrong answer.

**Recommendation (implemented).** Move the cycle check and path entry above
the `ConvertBuiltinType` call for object-typed values (a `Date` or `RegExp` on
the path is inert — they never recurse), or push the container inside the
`Map`/`Set` branches. Then extend CR-20's pinned cycle tests with the
container cases, which is the test the boundary was missing.

**What was done.** The first option, deliberately: pushing inside the `Map` and
`Set` branches would fix the two members that exist and leave the *next*
recursing builtin short in the same way. Moving the check makes "joins the
conversion path" a property of every object-typed value, which is the closure
rather than the enumeration. The inertness claim was verified rather than
assumed — the same `Date` and `Uint8Array` instance used twice in one object
still converts twice, and is pinned.

### F3. The `napi_type_tag` invariant counts a pattern, not the definitions — and the last commit turned the suite red with it (low, instrument)

`tools/invariants/invariants.mjs:165` computes "napi_type_tag definitions" as
`/constexpr napi_type_tag/g` over `lua-native.h`. Commit `d72a1dd` changed the
*local array* in `AllTagsDistinct()` from `const napi_type_tag all[]` to
`constexpr napi_type_tag all[]` — a correct cleanup — and the count went 6 → 7
with no tag added. `npm run check-invariants` and `invariants.spec.ts` have
been red since, which means **the commit landed without running either**, and
the suite has been failing on every run of this pass's baseline.

Two halves to this finding:

- **The pattern's universe is wrong.** The six definitions all have the form
  `inline constexpr napi_type_tag k…`; the pattern accepts any `constexpr`
  mention. This is CR-19 F1's question — *is the frozen universe the closure,
  or an enumeration?* — answered "an enumeration" for a counting regex: it
  enumerated the declaration forms that existed when it was written.
- **The tool's suggested remedy would launder the false positive.** The
  failure output says: "If the change is intended, re-freeze it with
  `--update`." The change *was* intended; the count is still wrong. Following
  the instruction freezes 7 as the expected number of tags when there are 6,
  and the next reader of `expected.json` inherits a lie. The `--update`
  guidance assumes drift means the *subject* moved; here the *instrument*
  moved. `tools/README.md`'s rule — read what moved before re-freezing — held
  only because this pass read it.

**Recommendation (implemented).** Tighten the pattern to the definitional form
(`/inline constexpr napi_type_tag k\w+/`), confirm the count stays 6, and leave
`expected.json` untouched. Consider the same one-form-too-wide audit for the
other counting patterns in `greppable-counts` while in the file.

**What was done.** As recommended, plus two things the finding did not ask for.
The header now goes through the shared `stripCommentsAndStrings` scanner rather
than an ad-hoc line-comment regex, matching its two sibling counts. And the
tightened pattern was checked in **both** directions, which is the standing
rule applied to an invariant for the first time: the six matches were listed by
name (they are the six real tags), and a genuine seventh appended to the header
reports 7 — so the tighter pattern did not buy its accuracy by going blind.
The other two counts in `greppable-counts` were re-read; both are anchored to
call syntax rather than to a declaration form, and neither has the same
exposure.

### F4. Nits

**a. The oracle ledger overstates what a table error leaves reachable.** The
`error/e1[23]` entry's reason ends: "the structured value is still reachable
through the thrown JS Error." Driven: for a Lua-origin `error({code=7})` the
thrown JS Error carries own-properties `message` and `stack` only, at every
door. The reconstruction machinery the clause is thinking of applies to
JS-origin errors (the `__jsErrorId` path), not to Lua table errors. One
sentence to correct — but it is a ledger *reason*, and the reasons are what
make the ledger auditable.

**b. The superseded `AsSharedTable` comment (NEXT-STEPS A5) is still live.**
`lua-native.cpp:868–881` still argues that "the load-bearing guard is one line
lower" (the `Unwrap`) — the claim CR-20 F5 disproved by aborting the process
through it — directly above the newer comment explaining that `CheckTypeTag`
is the load-bearing check. Two comments on one function, the first wrong.
Minutes to fix, flagged for one pass already.

**c. A2 remains open: 70 bare `.toThrow()` / `.toThrowError()` sites.**
Unchanged since CR-20 wrote that two of them concealed F5 for five passes.
Recorded here so the count has a fresh timestamp; the remediation and the
"no new bare throws" invariant are still the cheapest high-linked item on the
programme's list.

---

## Verified and rejected (adversarial suspicions that held up)

- **The worker door's marshal.** `OnOK` re-implements the settle-or-reject
  logic per worker class and runs converters under a `CallScope` after
  `ClearBusy` — the CR-14 F1 site. Suspected as a divergence source; the
  matrix says all 1339 cases agree, including every error case.
- **The bytecode round trip.** Suspected of at least chunk-name drift in
  error messages; agrees on all 1339, syntax errors included (`compile`'s
  refusal message is `execute_script`'s load error, verbatim).
- **The CR-20 conversion-path fix under re-entry.** A registered type
  converter calling back into the context mid-conversion gets a fresh path
  (`ConversionPathScope` swap in `NapiToCoreInstance`); a converter's *result*
  continues the enclosing path at `depth + 1`, so a converter that returns an
  ancestor is caught as the genuine cycle it creates. Both behaviours
  confirmed against the source; the suite's two CR-20 controls (DAG accepted,
  re-entrant converter accepted) pass, and this pass added the Map-DAG probe
  above.
- **The `-0` fix's blast radius.** `Object.is(get_global('nz'), -0)` true;
  `0` still an integer; `1.0` → `1` still pinned unchanged. The special case
  did not leak into the general integral rule.
- **`JsThrowMessage` as a free function (CR-19 F3's fix).** `SharedTable::
  Propagate` now reaches it; the aggregate-failure message includes non-Error
  throw causes. Confirmed in source; no behavioural probe needed beyond the
  existing pins.
- **The d72a1dd designated-initializer change.** `.lower`/`.upper` initializers
  and `std::size` are semantically identical to the previous forms; the only
  consequence was F3, which is about the instrument.
- **Driver-door structured JS errors.** A JS callback's throw awaited through
  `execute_async` still reconstructs the original error (the exception
  matrix's coroutine-resume cells, re-run clean this pass) — F1 is confined to
  *Lua-origin* non-string errors.

---

## Suggested priority order

F1–F3 are done (see the resolution table). What remains from this pass, in
order:

1. **F4a** — correct the oracle ledger's "the structured value is still
   reachable through the thrown JS Error" clause, which is true of JS-origin
   errors and not of Lua table errors. It is a ledger *reason*, and the
   reasons are what make a ledger auditable rather than a suppression list.
2. **F4b** — delete the superseded `AsSharedTable` comment (NEXT-STEPS A5).
   Flagged for two passes now, minutes to do.
3. **A2, A1** — unchanged from NEXT-STEPS §11, and still ahead of any further
   review pass by that document's own ordering. This pass jumped the queue
   because A3's two cheap boundaries were about to get an instrument for free;
   the queue's logic still stands.
4. **A3's remaining boundary** — the userdata/class lifecycle across `reset`
   and GC, the last entry on the enumeration.

---

## Note on the trajectory

The finding curve, extended: CR-18 **3/0**, CR-19 **5/0**, CR-20 **4+1/1**,
CR-21 **3+nits/0**. Zero highs for the third time in four passes, and for the
second pass running no finding an ordinary caller can be *hurt* by — F1 is a
worse error message, not a wrong result.

**The boundary list is now one long.** A3 named three never-searched
boundaries; this pass searched two (async, bytecode) and both came back clean
apart from F1's single root cause. What remains is the userdata/class-object
lifecycle across `reset` and GC — the medium-cost one, closest in shape to
CR-17's lifetime matrices. When that instrument exists and runs clean, the
enumeration CODE-REVIEW-NEXT-STEPS §10 requires can be recorded as complete,
and "nothing serious" starts being a statement about the code rather than
about coverage.

**The per-instrument yield pattern held exactly.** A genuinely new instrument
found something (one root cause in 4017 cells — the same ~1-per-matrix rate as
CR-16, 17, 18 and 20), and the reused instruments found nothing new. Two
passes of evidence now say the strongest results are the negatives: the worker
and bytecode doors' perfect parity retires two standing worries the way CR-20's
twelve-door parity retired CR-17 F2's.

**And the recurring class recurred, in quadruplicate.** Three findings, three
boundaries drawn one member short — in the product (F1), in a fix for a
previous finding (F2), and in the instrument built to stop exactly this class
(F3) — and then a fourth, in this review's own F1, which asserted two cells
had one cause and was wrong about one of them. The F3 instance deserves the
emphasis: the invariant mechanism *worked* — it fired on drift — and its
failure mode was still the class it polices, because the pattern that computes
the count is itself a hand-drawn boundary. The lesson for A1's closure work is
that "compute, don't enumerate" only moves the enumeration into the
computation; the universe of the computation then needs the same skeptical
audit, which is what §10's criterion 3 (every instrument states its own
universe) is for.

**The fixes bear out the standing rule, in the good direction.** Six
consecutive passes found that a structural fix introduced a fresh defect. This
pass's three fixes introduced none that survived to the end of the session —
but only because each one was driven and then measured against the whole
battery, and two of the three *changed shape* under that measurement: F1 shed a
cell that turned out to be Lua's behaviour rather than ours, and F3's
verification had to be run in both directions before its "clean" meant
anything. Neither correction came from reasoning about the fix; both came from
running it. That is the same finding CR-18 recorded about its own remediation
— what catches a bad fix is the pre-existing suite, not the reasoning that
produced it.

One process note, stated without ceremony: the F3 drift means the last commit
landed without `npm run check-invariants` or the suite being run. The
programme's §10 criterion 5 — "all of it runs without anyone remembering to
run it" — is not hypothetical; this pass's baseline was red on arrival for
exactly that reason. A4 (CI, or a pre-push hook at minimum) converts that from
a habit back into a property.

**The boundary enumeration, updated.** With this pass A3 has one entry left:

| Boundary | Instrument | State |
|---|---|---|
| JS → Lua values | `roundtrip-matrix` | ✅ CR-20 |
| Lua → JS values, embedded VM | `diff-oracle` | ✅ CR-18 |
| Exception escape | `exception-matrix` | ✅ CR-18 |
| Async surface end-to-end | `exec-parity` | ✅ CR-21 |
| Bytecode round trip | `exec-parity` | ✅ CR-21 |
| **Userdata / class lifecycle across `reset` and GC** | **—** | **open** |

When that last row has an instrument and it runs clean, §10's criterion 1 is
met and the enumeration can be *recorded as empty* — which is the deliverable,
not the clean run.
