# CODE-REVIEW-20

**Date:** August 3, 2026
**Scope:** Twentieth pass. Primary target: **the JavaScript → Lua direction**,
which is the one boundary in this codebase that has never had a mechanical
search of any kind.

**Method:** Eighteen passes searched for crashes; CR-18 built the first harness
that checks whether an answer is *right*, and it checks two things — that the
embedded VM matches stock Lua (mode A), and that values coming *out* of Lua are
faithful (mode B). Values going *in* were left uncovered, and
`docs/DIFFERENTIAL-ORACLE.md` says so explicitly under "What it does not cover".

They were left uncovered for a real reason: **there is no reference
implementation to compare against.** No second implementation exists of "what
should a JavaScript `Date` become in Lua". So this pass uses a metamorphic
oracle instead of a differential one — two properties that hold without a
reference:

- **Round trip.** Push a value in, read it back, and it should be what went in,
  except where `types.d.ts` says otherwise. The exceptions are enumerated, which
  makes this a test of the *documentation* as much as of the code: from inside
  the addon an undocumented loss and a documented one are indistinguishable.
- **Parity.** Every entry point should give the same answer for the same value.
  A door that differs from its siblings is a defect in the API's coherence even
  when no single answer is wrong alone. This is CR-17 F2's shape — one door of
  six accepting a value the other five refused, found by eyeballing a column —
  mechanized.

**12 doors × 50 values = 600 cells** (`tools/roundtrip-matrix/`). The doors are every public
entry point that takes a JS value into Lua: `set_global` read back two ways,
`create_table`, a table handle's `set`, a Lua function argument, a host callback
return, a coroutine `resume` argument, an environment, `pcall`, a proxy-userdata
field, a registered class method return, and a registered module field.

**Baseline:** 898 TypeScript and 285 C++ tests pass; all four sanitizer
harnesses clean; the CR-18 exception matrix reports 0 cells to read; the
differential oracle reports 0 disagreements.

**Findings were reported open and fixed subsequently**, along with CR-19's. The
resolution table is below; the findings themselves are unchanged from when they
were written.

---

## Headline

**The API is coherent, and it loses data quietly at the way in.**

The parity result is the strong one and it is a negative: **all 12 doors agree
on all 50 values, in every cell.** Whatever the binding does to a JS value, it
does the same thing whether the value arrives through `set_global`, a
coroutine resume argument, a class method's return, or a module field. CR-17 F2
— the one door of six that behaved differently — has no instances here. That is
the first time API coherence has been measured rather than assumed, and it came
back clean.

Against that, four values do not survive the crossing, all four identically at
all twelve doors, and **three of them are undocumented**:

- **F1 (medium).** A JS array containing `null` or `undefined` becomes a Lua
  sequence that **ends at the hole**. `[1, null, 3, 4]` gives `#rows == 1`;
  `ipairs` yields one element; `table.concat` returns `"1"`. Three of the four
  elements are invisible to every idiomatic Lua iteration, while `pairs` still
  sees three. Nothing warns, and `[a, b, c].map(f)` where `f` can return `null`
  is ordinary JavaScript.
- **F2 (low).** A **cyclic** object is refused with
  `"Value nesting depth exceeds the maximum of 100 levels"`. The object in the
  reproduction has two keys. The message names the wrong cause and implies a
  remedy — flatten it — that cannot work, since no amount of flattening removes
  a cycle.
- **F3 (low).** JS `-0` becomes Lua **integer** `0`, losing both the sign and
  the float subtype. `1/x` goes from `-inf` to `+inf` across the boundary. Lua
  represents `-0.0` perfectly well, so unlike `1.0` → `1` — which JavaScript
  cannot distinguish and so cannot preserve — this one is avoidable.

The fourth, `2^53` returning as a BigInt, is the documented threshold and is
filed as a nit.

The through-line is worth stating, because it is the same one CR-18 found in the
other direction:

> **This binding's remaining defects are all at the type-system seam, and all of
> them are silent.** CR-18 O1–O3 were three losses on the way out; F1–F3 are
> three on the way in. None crashes, none raises, and each produces a plausible
> value. The difference is that the way-out losses are now documented on
> `execute_script`, and the way-in losses are documented nowhere — `LuaInput`'s
> doc comment describes what the binding *accepts* and says nothing about what
> it discards.

---

## Resolution status (August 3, 2026)

**All findings resolved.** After the fixes: **913 TypeScript tests** (up from
898 — 10 CR-20 pins, 4 CR-19 pins and a tightened CR-15 test) plus one further
finding (F5) turned up while fixing them, and **285 C++
tests** pass; all four sanitizer harnesses are clean; the invariants, the CR-18
exception matrix, the differential oracle and this pass's round-trip matrix all
run clean. The round-trip matrix now reports **456 identical, 144 specified, 0
undocumented**, and parity remains 50 of 50.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Documented, not changed | The behaviour is specified on `LuaInput` in `types.d.ts`, with a four-item `@remarks` block mirroring the one CR-18 put on `execute_script` — the truncation, the object-key removal, the circular refusal, and an explicit statement that **nothing else is lost**. The workaround is named (`false` as a placeholder, or filter first) and pinned. **Preserving the length was deliberately not done**: it would mean an `n` field or refusing arrays containing `null`, and both change the shape of data every existing caller relies on. That is a product decision rather than a bug fix, and it is still available. |
| F2 | ✅ Fixed | `NapiToCoreImpl` carries a conversion **path** (`conversion_path_`, with RAII push/pop) and raises "Value contains a circular reference, which Lua tables cannot represent; break the cycle before passing it in" at the first repeat. Two controls are pinned because they are what make it a cycle check rather than a sharing check: **a DAG is accepted** (the same object as two siblings is popped on the way out, so it is not its own ancestor), and **a converter re-entering with a value from the outer tree is accepted** (the top-level entry hides the enclosing path rather than extending it, so two logical trees do not contaminate each other). A genuinely deep acyclic object still reports the depth limit. |
| F3 | ✅ Fixed | The numeric branch of `ConvertBuiltinType` special-cases negative zero before the integral test, so `-0` crosses as a Lua **float** with its sign: `math.type` is `float`, `1/nz` is `-inf`, and `Object.is(get_global('nz'), -0)` is true. `0` is still an integer. The `1.0` → `1` case is pinned *unchanged*, with a comment saying why: JavaScript cannot tell it from `1`, so no conversion can preserve a distinction the input never carried, and the -0 fix must not later be "generalized" into breaking that. |
| F4a | ✅ Done | `execute_script`'s remarks now state that a Lua integer outside ±(2^53 − 1) arrives as a BigInt, so `typeof` is not stable across a round trip at the boundary. |
| F4b | ✅ Done | `LuaInput` now documents the input direction to the same standard `execute_script` documents the output direction — which was the actual asymmetry, and the reason F1–F3 were findings rather than ledger entries. |

The round-trip ledger was updated only *after* the fixes, and deliberately so:
while a loss is undocumented, ledgering it launders a finding into a feature.
F1 and F2 are ledgerable now because they are specified; F3 needed no entry
because the value round-trips.

### F5. `AsSharedTable` had no type check at all once `Symbol.hasInstance` was forged (high) — found while fixing, ✅ fixed

Not a round-trip finding. It surfaced because CR-19 F3's pin was the first test
placed *after* CR-15 F5's, and it arrived as a suite-wide failure: every
`new init({}, { shared })` after that point failed with a bare
`"Invalid argument"`.

**The proximate cause was test hygiene.** CR-15 F5 patched
`Symbol.hasInstance` on the `SharedTable` constructor and never restored it —
the patch is process-global, so `AsSharedTable`'s `InstanceOf` filter accepted
every object for the remainder of the run. Latent for five passes because that
test was the last one in the suite to construct a shared context. Now restored
in a `finally`, with an assertion that an ordinary shared context still
constructs afterwards.

**The real defect was underneath it, and containing the throw exposed it.**
`AsSharedTable` was `InstanceOf` followed by `SharedTable::Unwrap`. CR-15 F5
concluded that what actually holds the line is "napi_unwrap rejecting an object
it never wrapped", and that is true only of objects that were *never wrapped at
all*. **`napi_unwrap` is not a type check.** Handed an object wrapped by a
*different* `ObjectWrap` subclass it succeeds and returns that pointer, which is
then reinterpreted. Driven, with the forgery active:

```
forged { s: aLuaContext }  -> ok            <-- accepted as a shared table
                              exit code 134 <-- SIGABRT
```

A `LuaContext*` reinterpreted as a `SharedTable*`, accepted, and the process
aborted. The pair `InstanceOf` + `Unwrap` provides **no type safety whatever**
once the first half is defeated — and the first half is defeated by four lines
of ordinary JavaScript.

This is CR-15 F6's finding — *provenance is not kind* — recurring on an
`ObjectWrap` instead of on a marker `External`, and it recurred because F6's
remedy was applied to the five Externals and not to the one wrapped class,
which nobody re-asked the question of.

**Resolution.** A sixth `napi_type_tag`, `lua_tags::kSharedTable`, applied in
the `SharedTable` constructor and checked in `AsSharedTable` in place of
`InstanceOf`. A 128-bit brand written at mint time and compared at read, which
JS cannot reach at all. `AllTagsDistinct()`'s `static_assert` covers it, and the
`greppable-counts` invariant moved from five tags to six. Two further
consequences fell out of the same change:

- **`Unwrap` is contained**, so `AsSharedTable` is a total predicate. The raw
  N-API `"Invalid argument"` no longer escapes in place of the caller's own
  `"shared.s must be a shared table created with createSharedTable()"`.
- **Legitimate callers stop paying for a forgery.** The constructor asks
  `AsSharedTable` of the options object *before* asking it of each entry, so a
  defeated filter failed the whole call — a correct
  `{ s: genuineSharedTable }` was rejected. It now works whether or not a
  forgery is active.

**And the assertion that could not see any of it was tightened.** CR-15 F5's two
checks were bare `.toThrow()` with no pattern, so they passed identically
whether the error was the intended refusal or `"Invalid argument"` — the exact
loose-assertion hazard CR-17 F3 recorded, sitting in the test for the very
behaviour it was hiding. They now match the message, the `LuaContext` case is
pinned explicitly as the type-confusion probe, and the legitimate-caller case is
pinned alongside.

---

## Verification of the CODE-REVIEW-19 findings

CR-19's findings were open when this pass ran and were fixed alongside CR-20's.
They are re-confirmed as fixed here; see CR-19's own resolution table for what
each fix was.

| CR-19 # | State |
|---------|-------|
| F1 | ✅ Fixed. The throwing set is transitive (47, up from 30) and the guarding question is asked of a path, not a function body. |
| F2 | ✅ Fixed, and a `scanner-coverage` invariant added so the scanner has to account for its own input. |
| F3 | ✅ Fixed. `JsThrowMessage` is a free function; `Propagate` uses it. |
| F4 | ✅ Fixed. The probe reports its own scope and a second, C++-side signal. |
| F5 | ✅ Fixed (a–c); F5d was a scope note. |

---

## The round-trip and parity matrix

The instrument, described so it can be re-run and extended.

```
node tools/roundtrip-matrix/run.mjs                 # the whole matrix
node tools/roundtrip-matrix/run.mjs --control       # just the controls
node tools/roundtrip-matrix/run.mjs --value=str:utf8
```

**Axis A — 50 values**: numeric edge cases (`-0`, `2^53`, `2^53 ± 1`, the
int64 bounds as BigInt, NaN, both infinities, `1e300`), strings (empty, ASCII,
UTF-8, emoji, embedded NUL, a lone surrogate, 5 kB), booleans, `null`,
`undefined`, arrays (empty, nested, with a `null`, mixed), objects (nested,
numeric keys, colliding keys, a `null` value), the six built-ins the binding
converts, a function, an object past `kMaxDepth`, a cyclic object, and a Symbol.

**Axis B — 12 doors**, listed above. A door must take the value in and hand the
same value back using only the public API; a throw is recorded as an outcome
rather than as a missing cell, because a door that refuses what its siblings
accept is precisely what the parity half is looking for.

**Controls**, on the standing rule that a search reporting clean must first show
it can report dirty. Four, all passing: the comparator sees a value change and a
type change; a known documented loss registers as a difference; and — the one
that matters most here — **every door is shown to actually enter Lua**, by
checking that what comes back is not the identical JS object reference. A door
implemented wrongly enough to hand the input straight back would otherwise
report a perfect round trip and a perfect parity score.

**Result.**

| | |
|---|---|
| Round-trips identically | 444 |
| Changed, documented (4 ledger entries) | 108 |
| **Changed, undocumented** | **48** (4 values × 12 doors) |
| Values where all 12 doors agree | **50 of 50** |
| Values where doors disagree | **0** |

The ledger deliberately does **not** contain F1–F3. Adding them would record
them as intended rather than as open, which is a ledger being used to launder a
finding into a feature.

---

## Findings

### F1. A JS array containing `null` becomes a Lua sequence that ends at the hole (medium)

`null` and `undefined` both convert to Lua `nil`, and assigning `nil` to a table
key removes it. For an object that is merely surprising. For an **array** it
truncates the sequence, because Lua's length operator and `ipairs` both stop at
the first absent index.

**Driven.**

```js
lua.set_global('rows', [1, null, 3, 4]);
```

```
#rows                                    = 1
ipairs count                             = 1
pairs count                              = 3
table.concat(rows, ",")                  = "1"
```

Four elements in; one visible to `#`, one to `ipairs`, one to `table.concat`;
three to `pairs`. The data for indices 3 and 4 is still present and still
reachable as `rows[3]` and `rows[4]` — it is only the *sequence* that has been
broken, which is the worst version of this: nothing is missing if you look for
it by index, and almost everything is missing if you iterate.

Round-tripped back to JavaScript it returns as an object, not an array:

```
[1, null, 3]   ->   {"1": 1, "3": 3}
```

`undefined` behaves identically. All 12 doors behave identically.

**Why this is more than a documentation gap.** The other two findings in this
pass produce a wrong *value*; this one produces a Lua table that later Lua code
iterates incorrectly, arbitrarily far from the crossing. A JS caller writing
`lua.set_global('rows', results)` where `results` came from a `.map()` that can
yield `null` has handed Lua a sequence whose length silently depends on the
data. That is the CR-17 class — a plausible value that misbehaves later — moved
to the input side.

**Recommendation (not implemented).** Two defensible options and they are
genuinely different products, so this is a decision rather than a fix:

1. **Document it**, in `LuaInput` where the caller reads, alongside a stated
   workaround (`false`, or a sentinel table, or filtering before the push).
   Cheapest, and consistent with how CR-18 resolved O1–O3.
2. **Preserve the length**, by converting a JS array to a Lua table plus an
   explicit `n` field, or by refusing an array containing `null` outright.
   Both change the shape of data every existing caller already relies on, so
   neither is a drop-in.

The one thing that should not happen is a silent partial fix — converting
`null` in arrays but not in objects would make the two inconsistent, and the
parity result above is currently this API's best property.

### F2. A cyclic object is reported as a depth-limit error (low)

**Driven.**

```js
const cyc = { a: 1 };
cyc.self = cyc;
lua.set_global('c', cyc);
```

```
Value nesting depth exceeds the maximum of 100 levels
```

The object has two keys. The same message, verbatim, is what a genuinely
150-deep object gets. So one message serves two facts — CR-13 F1's family, and
the same one CR-17 F3 and CR-18 F1 were about — and here the wrong one is also
*actionable in the wrong direction*: "reduce your nesting" is advice a user can
follow all day without fixing a cycle.

It is also detected the expensive way. The conversion recurses 100 levels,
building Lua values as it goes, before the depth counter trips. A `seen` set
would answer in O(1) at the first repeat, and would have the cause exactly.

All 12 doors report it identically, each wrapped in that door's own prefix
(`Host function 'give' threw an exception: …`, `Error reading property 'k': …`),
so the misattribution is uniform rather than door-specific.

**Recommendation (not implemented).** Carry a `seen` set through
`NapiToCoreImpl` and raise a distinct message naming the cycle. The depth limit
stays for genuinely deep acyclic input. Note this changes an error message that
tests may match on — `grep` for `nesting depth` before touching it.

### F3. JS `-0` becomes Lua integer `0` (low)

**Driven.**

```
lua.set_global('nz', -0)

math.type(nz)      = integer      <-- not even a float
tostring(nz)       = 0
1/nz               = inf          <-- in Lua, 1/(-0.0) is -inf
Object.is(get_global('nz'), -0)   = false
```

Two distinct losses in one crossing. The value becomes an **integer**, so the
float subtype is gone; and the sign of the zero is gone with it, so a division
that should yield `-inf` yields `+inf`.

The first half is mostly unavoidable and is the documented trade: the converter
maps any integral JS number to a Lua integer, because JavaScript cannot tell
`1.0` from `1` and picking the integer is the useful choice. But `-0` **is**
distinguishable in JavaScript — `Object.is(x, -0)` — and `-0.0` **is**
representable in Lua. This is the one member of the class where information
exists on both sides and is discarded in the middle.

Reachability is low: `-0` arises from `-1 * 0`, `Math.round(-0.2)`,
`parseFloat("-0")` and similar, and most programs never divide by it. Filed as
low for that reason, not because the loss is ambiguous.

**Recommendation (not implemented).** In the numeric branch of
`ConvertBuiltinType`, special-case negative zero before the integral test and
push it as a float. One condition, and it makes the rule "an integral JS number
becomes a Lua integer" true with a stated exception rather than true with a
silent one.

### F4. Nits

**a. `2^53` changes type across a round trip.** A JS number in, a BigInt out.
This is the documented BigInt threshold working as specified — beyond
±(2^53 − 1) the binding widens so a 64-bit Lua integer survives — and 2^53 is
the first value past it. Worth a sentence in `types.d.ts` all the same, because
`typeof` changing across `set_global`/`get_global` will surprise someone, and
the threshold is currently stated only in terms of what Lua can hold.

**b. `LuaInput`'s doc comment covers what is accepted, not what is discarded.**
It is accurate and well-written about the widening — `undefined`, `Date`, `Map`,
`Set`, `ArrayBuffer`, and that "none of which Lua can produce on the way out".
That last clause is the only statement anywhere about the input direction being
lossy, and it covers the six built-ins and none of F1–F3. Compare
`execute_script`, which after CR-18 carries a three-item `@remarks` block on the
output direction. The two directions are documented to very different standards.

---

## Verified and rejected (adversarial suspicions that held up)

- **Parity across all 12 doors.** Stated as a finding in the negative, and the
  most substantial result of the pass. 50 values, 12 doors, zero disagreements —
  including for the values that fail, which fail identically. `set_global`,
  the coroutine resume path, the environment path and the module path are the
  four with the most independent code, and they agree with the rest.
- **The one-way built-in conversions.** `Date` → number, `Map` → table,
  `Set` → sequence, `Uint8Array` → byte string, `ArrayBuffer` → byte string,
  `RegExp` → source string. Suspected as an undocumented asymmetry and refuted:
  `LuaInput`'s doc comment states it directly. Ledgered, not filed.
- **Symbol and the depth limit.** Refused correctly and identically at all
  twelve doors, with messages that name the real cause.
- **Embedded NUL, a lone surrogate, and a 5 kB string.** All three round-trip
  exactly, at every door. The lone surrogate was the one expected to fail —
  `"\uD800"` is not encodable as UTF-8 — and it survives, which is worth
  recording as the mirror image of CR-18 O1: the *output* direction mangles
  invalid UTF-8 and the *input* direction does not.
- **Numeric keys and key collisions on the way in.** `{1: 'one', 2: 'two'}`
  round-trips; the string/number key collision that CR-18 O3 found on the way
  out does not have an input-direction counterpart, because JS object keys are
  already strings before the crossing.
- **Functions.** A JS function crosses as a callable and comes back as a
  callable at every door. No door drops or duplicates the registration.
- **The CR-18 and CR-19 instruments.** Re-run; the exception matrix is 297/297
  and the oracle 0 disagreements against the same tree.

---

## Suggested priority order

1. **F1** — the array hole. It is the only finding here whose damage happens
   away from the crossing, in Lua code that iterates a sequence the binding
   quietly truncated. Decide between documenting and preserving before doing
   either.
2. **F2** — the cycle reported as depth. Cheap, and it removes a message that
   sends users in the wrong direction.
3. **F3** — negative zero. One condition.
4. **F4** — nits, and specifically bringing `LuaInput`'s documentation up to the
   standard `execute_script` now sets.

---

## Note on the trajectory

Two passes ago the findings were in the product; last pass they were entirely in
the instruments; this pass they are in the product again, but at the one seam
nothing had ever looked at.

That is the pattern worth naming, because it is not "the code is getting
better" and it is not "the code is getting worse":

> **Every pass that built a genuinely new instrument found something, and every
> pass that reused an existing one found less.** CR-16's injection matrix found
> one crash in 1242 cells; CR-17's lifetime matrices found one root cause in
> 573; CR-18's exception matrix found no crashes at all but three wrong answers;
> this pass pointed the first instrument at the input direction and found three
> more. The yield is not falling because the code is converging — it is falling
> per-instrument, and each new instrument resets it.

Which raises the question this series should probably ask next, and it is not
"what should CR-21 search". It is **how many boundaries are left that have never
been searched**. After this pass the answer is short and worth writing down:
the async surface end-to-end (does `execute_async` agree with `execute_script`
on the same script?), bytecode round-tripping (`compile` → `load_bytecode` →
same behaviour), and the userdata/class object lifecycle across `reset` and GC.
Each is a boundary with an obvious metamorphic property and no harness.

Two second-order observations.

**A negative result costs the same as a positive one and is worth more here.**
The parity check found nothing, and it is the most valuable output of this pass:
it converts "the twelve doors probably behave the same" from an assumption every
previous review implicitly made into a measured fact. CR-17 F2 existed because
nobody had checked; the check is 20 lines and now runs in seconds. The
temptation with an exhaustive search is to judge it by its findings, and a
search that comes back empty over a property nobody had verified is not a
wasted search — it is the only kind that can retire a worry.

**The documentation is now part of the correctness surface, and it is uneven.**
CR-18 resolved three findings by documenting them, which was the right call —
each was a JavaScript type-system consequence rather than a mistake. But that
decision quietly made `types.d.ts` load-bearing: this pass's ledger consults it
to decide which round-trip changes are findings, so a loss is a defect exactly
when the docs do not mention it. That is a good property and it means the
docs' *unevenness* is now measurable — the output direction has a three-item
`@remarks` block and the input direction has one subordinate clause, which is
why F1–F3 are findings rather than ledger entries. If documenting is going to be
a legitimate resolution, both directions have to be documented to the same
standard, or the next reviewer will read the asymmetry as a statement about
which direction is safe.
