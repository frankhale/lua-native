# The differential oracle

**Added:** August 3, 2026 (CODE-REVIEW-18, §5 of `CODE-REVIEW-HISTORY.md`)

```bash
npm run oracle              # the whole corpus, both modes
npm run oracle -- --control # just the controls
node tools/diff-oracle/run.mjs --mode=b --category=string
node tools/diff-oracle/run.mjs --json=out.json
```

---

## Why

Eighteen review passes, four sanitizer harnesses and four exhaustive matrices
all answer the same question: **did it survive**. None of them asks whether the
answer was *right*.

That was adequate while every finding announced itself with a segfault. It
stopped being adequate at CR-17, whose high was silent data corruption and whose
other two findings were a wrong return value and a wrong error message — none of
which any amount of running finds, because they all execute successfully and
return plausible values.

> **A crash announces itself; a wrong answer has to be asked for.**

An oracle is the thing that asks. For the large surface where this binding
should be transparent — arithmetic, strings, tables, error messages, coroutine
scheduling — a second implementation of Lua *is* the specification, and stock
Lua is right there.

## What it is

**The reference** is stock `lua` from vcpkg — the same port, at the same
version, that supplies the `liblua.a` the addon embeds. It is not installed by
default; the port ships it behind a feature:

```bash
vcpkg install lua[tools]
```

Same-port-same-version is not incidental: a reference at a different Lua version
turns every version-specific behaviour into a false mismatch, and an oracle that
cries wolf is one nobody runs twice. The oracle prints both versions at startup
and warns if they differ, so a run is never ambiguous about what it compared
against.

**There is deliberately no fallback.** The first version of this harness built a
small interpreter out of `liblua.a` so the oracle would run without the `tools`
feature. That was the wrong call and it has been removed: the package already
requires vcpkg for its Lua, so one more feature of the same port costs a
developer here nothing they have not already paid — while a hand-written
interpreter is a second implementation to maintain, and one whose agreement with
the real thing is precisely what nobody would be checking. A reference
implementation you wrote yourself is not a reference implementation.

**Two modes**, and the split is the whole design:

| | Reference side | lua-native side | What a difference means |
|---|---|---|---|
| **A** | serializes in Lua | serializes in Lua | The addon's hooks changed the *language*: the instruction-count hook, the allocator under `maxMemory`, the print override, a metatabled `_G`, the `__gc` bridge |
| **B** | serializes in Lua | returns the marshalled **JavaScript** value, canonicalized by a mirror serializer | The value did not survive the **crossing** — the half with no reference implementation of its own |

**The corpus is generated**, not written out, so adding an operator or a string
function multiplies through every operand set instead of needing a new case:
arithmetic and comparison over 29 numeric operands × 7 operators, bitwise over
13 integer operands, 14 strings × 17 string operations, 13 table shapes × 8
table operations, 25 error expressions each run bare *and* through `pcall`,
14 coroutine scenarios, 19 metamethods, and a `crossing` category whose whole
point is to compare values *as values* rather than as strings the Lua side
built. **2678 comparisons.**

## The erasures are the specification

JavaScript cannot represent every Lua value distinctly, so a raw comparison
would report hundreds of differences that are the binding's design. Those are
erased once, in `canonical.lua`'s header, each with its reason — and **the
boundary of each erasure is as load-bearing as the erasure**:

- **The integer/float subtype** is erased *within* ±2^53 and deliberately **not**
  beyond it, because the addon emits a BigInt there and so the subtype genuinely
  does cross. A large integer arriving as a float is a real finding and this form
  shows it.
- **Table key iteration order** — unspecified in Lua, so keys are sorted.
- **Function / thread / userdata identity** — opaque either way; type name only.

Not erased, deliberately: string bytes (escaped, so an encoding difference shows
up rather than being normalised away), NaN vs the two infinities, negative zero,
and error message text.

Separately from the erasures, two **harness** normalisations are applied to both
sides, because leaving them in produced rows that said nothing: addresses
(`table: 0x...`, which two processes can never agree on) and the error location
prefix plus lua-native's traceback appendix. The message *body* — where CR-17
F3's family lives — survives both untouched.

## The controls

Eight, run before the corpus, on the same rule the matrices use: **a comparator
that reports clean must first demonstrate it can report dirty.** Identical
sources must compare equal and deliberately different ones unequal; each side
must be shown to actually run the case rather than return a constant; an error
must be a comparable *outcome* rather than a missing row; and both edges of the
integer/float erasure must hold. The run refuses to proceed if any fails.

## Results

```
Cases: 2678  (mode A 1339, mode B 1339)
  agree               2659
  accepted divergence   19   (4 ledger entries)
  DISAGREE               0
```

**Mode A is completely clean.** 1339 cases, zero differences: the embedded VM
behaves exactly like stock Lua 5.5 across arithmetic, comparison, bitwise ops,
the string library, patterns, table semantics, error text, coroutine scheduling
and all nineteen metamethods. Nothing the addon installs — the hooks, the
allocator, the print override, the `__gc` bridge — perturbs the language. That
is a substantial negative result and it is the first time it has been measured
rather than assumed.

**Mode B found three things, all silent data loss on the crossing**, all now
documented on `execute_script()` in `types.d.ts` and pinned in the suite:

### O1. A Lua string that is not valid UTF-8 is mangled

Lua strings are byte strings; JavaScript strings are UTF-16. Every invalid byte
becomes U+FFFD, and the loss is **not idempotent**:

```
#blob in Lua            = 4      -- "\x00\x01\xFE\xFF"
#back after round trip  = 8
blob == back            = false
```

Four bytes out, eight bytes back, and Lua reports the two strings as different.
It is also **data-dependent**, which is the dangerous part: `string.pack('i4', 7)`
is all bytes below 0x80 and survives intact, so binary handling can appear to
work for a long time before a byte goes high.

*Workaround, pinned as a test:* encode across the boundary (hex or base64), or
keep the value behind a `LuaTableHandle` and never marshal it out. *Fix, if
wanted:* return a `Uint8Array` for non-UTF-8 strings — an API decision rather
than a bug fix, which is why this is recorded rather than changed.

### O2. Table keys that are neither strings nor numbers are dropped

`{[true] = 1, [false] = 2}` arrives as `{}` — not null values, absent entries.
Deliberate in the core, and now stated on the API.

### O3. A string key and a number key with the same text collide

`{["1"] = "strkey", [1] = "intkey"}` is two distinct entries in Lua and arrives
as a single JavaScript property; one value is lost, and which one depends on
table order. JavaScript object keys are strings, so the collision is unavoidable.

### The nineteenth row

`error({code = 7})` and `error(nil)`: lua-native reports
`(error object is a table value)` and `(error object is a nil value)` where
stock Lua reports `table: 0x...` and `<no error object>`. Deliberate, and
strictly more informative than an address. A difference in wording, not in what
happened.

## The ledger

Accepted divergences live in `accepted.mjs`, on the same terms as CR-18's
matrix ledger:

- **Every entry carries the reason it is not a defect.** "It was like that
  before" is not one.
- **An entry whose case starts agreeing is reported as STALE**, not silently
  ignored. A ledger that can only ever suppress hides regressions in the other
  direction too.

That second rule earned itself immediately: the first O1 entry was written as
the prefix `^string/s10/`, which also covered the cases returning a *length* or
a *byte value* — which carry none of the bytes and therefore agree. The oracle
reported six ledger entries suppressing nothing, and the entry was narrowed to
the fifteen cases that actually carry the invalid bytes.

## Two things that had to be got right

**Speed decides whether it gets run.** The first version spawned the reference
once per case and took ten minutes to not finish. Batching the whole corpus into
one reference process brings it to seconds — which is the difference between a
harness in the workflow and a harness in the repository.

**A generated corpus will generate something that does not terminate.** This one
already did: `ipairs` over `setmetatable({}, {__index = function() return 42 end})`
never stops, because it ends at the first `nil` and `__index` never yields one.
Nobody chose that combination; the generator produced it, which is exactly the
value of a generator. Two changes came out of it — the walks are capped, so a
non-terminating case is a *comparable outcome* on both sides, and the reference
batch is chunked with a timeout and **bisected down to the individual case** on
failure, so a future hang produces one row naming the culprit instead of killing
the run with no result.

**And one case was removed**, which is worth recording because the instinct is
to keep coverage: `#{[1]=1, [2]=2, [4]=4}` returned 2 on one run and agreed on
the next. The length operator on a table with a hole may return any border, so
both answers are correct and the result depends on allocation history. A
*flapping* case is worse than a missing one — it teaches the reader to ignore
the report.

## What it does not cover

The JavaScript-boundary semantics have no reference implementation, so nothing
here checks whether `set_userdata`, `register_class`, the converter families or
the async surface behave correctly — only that values crossing back from Lua are
faithful. Those need hand-written expectations, and have them, in the main
suite.
