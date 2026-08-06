# CODE-REVIEW-23

**Date:** August 6, 2026
**Scope:** Twenty-third pass, and the second exercise of the new-surface
trigger (`docs/CORRECTNESS.md` §15.6). The surface is the two commits that
landed after the programme closed and were not covered by
`INTEROP-PARITY-PLAN.md`:

- `30732b3` — the `sandbox` library preset and the `binaryStrings` option;
- `09cf332` — the `strictConversion` option and `set_read_handler`'s
  synthesized-`io` rewiring with its new boolean return.

These are not new entry points, new handle kinds, new frames, or any other row
in §15.6's trigger table. They are three **options** — each one re-rules an
existing boundary rather than adding one — plus a behaviour change on an
existing entry point. Whether the trigger table has anything to say about that
is itself examined below (F4).

**Baseline (all green before review began):** 1074 TypeScript tests, 285 C++
tests, nine invariants clean; all seven harnesses clean — roundtrip 216
documented / 0 undocumented, 50-of-50 parity across 18 doors; oracle 2678
cases, 0 disagreements; exec-parity 6695 cells, 0 disagreements; lifecycle 78
cells, 0 findings; cross-context clean; exception matrix 396/396.

**Baseline caveat:** the working tree carries an uncommitted `package.json`
bump (`node-addon-api` 8.5.0 → 8.9.1, `vitest` 4.0.18 → 4.1.10), the bumped
versions are what is installed, and the debug build under test was compiled
against `node-addon-api` 8.9.1. Everything above passed on that tree, which is
evidence *for* the bump, but the record should say the baseline is not the
committed tree.

**Findings were reported open and fixed subsequently.** The resolution table is
below. Reproductions were hand-driven per the `tools/README.md` rule — a search
that reports dirty must show the dirt is in the subject — and this pass's own
probes produced two false findings, recorded below in the tradition CR-22
started. **F1 turned out to have a second member that the finding did not
name**, found while fixing it; that is recorded in the resolution rather than
edited into the finding, because what the pass reported is the point.

---

## Resolution status (August 6, 2026)

**All findings resolved.** After the fixes: **1092 TypeScript tests** (up from
1074 — 18 CR-23 pins), 285 C++ tests, nine invariants (three re-frozen, each
accounted for below), and **all seven harnesses clean** — including
`roundtrip-matrix` at its new size, **3600 cells across 4 modes**, 0
undocumented and 0 parity disagreements in every mode.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Fixed, **and the class had a second member** | `strictConversion` now refuses a table key whose bytes cannot become a JS property name. The finding named one member — invalid UTF-8; while fixing it, an **embedded NUL** turned out to be a second, and a nastier one: `{["a\0b"]="v1", ["a"]="v2"}` silently returned `{a:"v1"}`, one entry gone, with neither key looking unusual. Both are now refused by one predicate derived from a stated criterion (below). |
| F2 | ✅ Fixed | The format token is minted directly (`Napi::String::New` / `Napi::Number::New`) instead of via `CoreToNapi`, so `format === 'n'` compares correctly in every mode — matching `set_file_reader`, whose path argument always was. The return side accepts `Uint8Array`/`Buffer`/`ArrayBuffer` through `BinaryBytesToString`, in **every** mode rather than only under the option, because the inbound conversion path (B1) has always treated byte views as binary-safe Lua strings and this makes the one input channel agree with it. |
| F3 | ✅ Fixed | "Ours" now means **the table's identity**, not whether our C function is still in its `read` field: `InstallInputRedirection` keeps a registry ref to the table it created and `RemoveInputRedirection` compares with `lua_rawequal`. Both directions of the old bug are gone — a caller's replacement table survives, and our table is removed even after a script overwrote `io.read`. The ref is dropped only on a path that actually ran, so a throwing removal is no longer remembered as a completed one. |
| F4 | ✅ Fixed, both halves | `roundtrip-matrix` gained **Axis C — modes** (`tools/roundtrip-matrix/modes.mjs`): default, `strict`, `binary`, `strict+binary`, each with a **vacuity control** that must prove its option is in effect before its cells are counted. §15.6 gained the mode row *and* a stated criterion for what a trigger is. The false "checked against `doors.mjs`" claim in `LIMITATIONS.md` §5 now describes a check that runs. |
| F5 | ✅ Fixed | `ResumeAsyncStep` takes an `arg_role`, threaded from `BeginAsyncRun`; `call_async` passes `"argument"`. The other two doors and every awaited settlement keep `"resume value"`, which is what they are. |

### What F1's fix is, and the line it deliberately does not cross

The predicate is **"does this key survive the crossing byte-for-byte"** —
strictly valid UTF-8, and no embedded NUL — and it was settled by *measuring*
each case rather than by reading the spec. That mattered: overlong encodings
(`C0 AF`) and WTF-8 lone surrogates (`ED A0 80`) are also replaced with U+FFFD
on the way out, the surrogate becoming three of them, even though a lone
surrogate is documented as surviving in the *other* direction. Accepting them
would have refused nothing and lost data anyway; refusing a sequence that
actually round-trips would have been worse — a false alarm shipped as
behaviour. Both halves are pinned.

**String *values* are deliberately not refused, and the reason is a principle
rather than caution.** A lossy value is §2's representation question and it has
a **remedy** — `binaryStrings` carries the exact bytes — whereas a key has no
such switch, because a JS property name is a string in every mode. So the two
halves of the same byte problem get the two different answers their situations
allow: values get a mode that carries them, keys get a refusal that names them.
The line is *"refuse where no remedy exists"*, not *"refuse everything lossy"*.

The evidence this is the right line and not a rationalization: with both options
on there is now **no silent loss left in either direction**, which is the
strongest statement this API can make about conversion, and it is pinned as a
single test. A value-level refusal would also have had to throw from
`CoreToNapiBuiltin`, which `lua-native.cpp:5056` documents as reached from sites
that catch `Napi::Error` *specifically* — the CR-6 F1 abort class, once already
reintroduced there by a fix for CR-18 F2.

### What the mode axis found on its first run

Two things, which is the per-instrument yield law holding for a new *axis* as it
does for a new instrument:

- **`builtin:Uint8Array` round-trips under `binaryStrings`** — the one built-in
  conversion that stops being one-way, contradicting `LuaInput`'s unqualified
  "the built-ins are one-way". Not a defect; a stronger property that was
  undocumented. It is now ledgered as a **positive assertion**
  (`roundTripsInstead`): if it ever stops round-tripping, no entry matches and
  the cell reports UNDOCUMENTED rather than being quietly excused.
- **The uniformity claim is true.** All eighteen doors agree in all four modes,
  including the two that push arguments on a libuv worker thread — the two the
  suite's hand-picked four had omitted. §5 asserted this before anyone had run
  it; now it has been run.

### The three invariant drifts, each accounted for

Re-frozen only after reading what moved, per `CLAUDE.md`: `+9 toThrow
assertions examined` (the new pins, all pattern-bearing — the bare count stayed
0), `+1 throw site (core)` (F1's single refusal), `+1 core function`
(`ClassifyKeyCrossing`). `core-call-guarding` was unchanged, which is the
check that `ResumeAsyncStep`'s new parameter did not disturb the guarding map.

### The second false finding

The verification probe reported `binaryStrings` rejecting valid UTF-8 keys. The
dirt was in the probe: it compared `JSON.stringify` output against a literal
whose key order was wrong — `std::map` sorts by UTF-8 bytes, so `日本` precedes
`😀` precedes `café`. The behaviour was correct and identical to default mode. A
second probe reported the awaited-settlement path as uncaught; it was the probe
that failed to catch. **Running count across the programme: ten probe/instrument
false findings, every one the harness misreading its own probe** — the rule that
caught all ten is still the most load-bearing one in `tools/README.md`.

---

## Headline

**The two conversion options each do what they claim through every door — and
the claim's edge is drawn one member short, in exactly the way the programme's
closing principle predicts.**

`strictConversion` was driven through all eighteen `roundtrip-matrix` doors
with a lossy value and refused at every one, including the two doors that push
arguments on a libuv worker thread — no abort, no silent acceptance, every
error message naming the loss. `binaryStrings` delivers a `Uint8Array` at
every value exit that was probed, including the async doors. The `sandbox`
preset's seal held against everything thrown at it, and the accept-and-retain
class that `set_read_handler` was just cured of has no surviving sibling
(`register_module`, `add_search_path`, `add_searcher` all refuse loudly
without `package`).

But:

- **F1 (serious).** A Lua table with two distinct binary string keys loses an
  entire entry crossing to JS — silently, under the default, **and under
  `strictConversion`**, whose whole purpose is refusing exactly this class.
  The §5 enumeration of silent losses that the option was built from is one
  member short, so the option is short the same member.
- **F2 (medium).** Under `binaryStrings`, the read-handler channel is
  incoherent in both directions: the *format token* arrives as a `Uint8Array`
  (the declared signature says `string | number`, so `format === 'n'` silently
  never matches), and a handler that returns a `Uint8Array` — the natural act
  in a byte-mode context — has it stringified to the *text* `"255,65"`.
- **F3 (medium).** Removing a synthesized `io` violates the "only take back
  what is still ours" rule its own comment states: it can destroy a
  replacement table the script created, and its postcondition comment is false
  on both early-return paths.
- **F4 (medium, meta).** §15.6's trigger table has no row for a *mode*. All
  seven instruments run under default options only, and nothing in the table
  said otherwise — the second exercise of the trigger worked only because a
  person asked a question the table does not ask.

---

## Method

The §15.6 table was applied first, as written: no row fires for either commit
(no new entry point, door, handle kind, marker, frame, `ObjectWrap`, tag,
policy, or version bump — `set_read_handler` already had its roundtrip door
and exception-matrix frame from the interop work). The pass therefore asked
the question the table does not: **an option forks a boundary into modes; who
searches the non-default mode?**

Probes (scratchpad scripts, not yet instruments):

1. `strictConversion` × all 18 doors, reusing `tools/roundtrip-matrix/doors.mjs`
   directly with the value `[1, null, 3]`.
2. Strict-mode throws on the hazardous paths: a host function *returning* a
   lossy array inside a Lua C frame, `call_async`/`resume_async` arguments
   pushed on the worker thread, a lossy value crossing *out* through
   `execute_script_async`.
3. `binaryStrings` × eleven Lua→JS value exits, sync and async.
4. Binary string *keys* under all four option combinations.
5. The synthesized-`io` install/remove/reinstall state machine against a
   script that mutates `io`.
6. The package-dependent registration APIs on a `sandbox` state.

---

## Findings

### F1. Two distinct binary keys collapse to one JS property and an entry vanishes — and `strictConversion` cannot see it (serious)

**Driven:**

```js
const strict = new lua_native.init({}, { libraries: 'all', strictConversion: true });
strict.execute_script('return {["\\xFF"]="a", ["\\xFE"]="b"}')
// → { "�": "a" }        — no throw; one of the two entries is GONE
```

Two keys that are distinct in Lua both decode to `U+FFFD` when the binding
materializes the JS property name, so the second `obj.Set` overwrites the
first (`lua-native.cpp:5173`). Which value survives depends on hash order —
the same unpredictability §5 already records for the number/string collision.
By §15.5's definition this is serious: an ordinary caller (any table keyed by
`string.pack` output, a hash, or bytes read from a wire) reaches a silent
wrong value.

**Why strict mode misses it.** The collision check lives in the core
(`lua-runtime.cpp:3247`) and compares **raw bytes** — `"\xFF"` and `"\xFE"`
are distinct `std::string`s, so `map.emplace` succeeds twice and nothing
refuses. The loss happens later, at the binding's UTF-8 decode of the property
name, where no strict check exists. The boundary the option guards was drawn
at the core conversion; the loss straddles the core *and* the binding
materialization, and the second half is unguarded. This is the closure
principle from §15.3 — *fix classes, not sites* — failing in a brand-new
feature: the class "distinct Lua keys, one JS property" had two members
enumerated (number/string collision, non-string/number key) and this third
member was not on the list, so `LIMITATIONS.md` §5 is short a row and the
option built from §5 is short the same row.

Three aggravations, in decreasing order:

1. **`binaryStrings` does not help, by documented design** — "table keys are
   unaffected" (`LIMITATIONS.md` §2). But the sentence beside it, "a JS
   property key is a string either way", *sidesteps* rather than states the
   consequence: a single binary key is mangled (`{["k\xFF"]="v"}` arrives
   keyed `"k�"`) and colliding ones lose an entry. The doc reads as
   "keys are fine"; the truth is "keys are exactly as lossy as values were
   before the option existed".
2. **The two collision sites have opposite survivor rules.** The core's
   number/string collision keeps the *first* entry `lua_next` yields
   (`map.emplace` does not overwrite); the binding's binary collision keeps
   the *last* (`obj.Set` does). Nothing observable today distinguishes them —
   both are "unpredictable" from JS — but the first change to either site will
   inherit an inconsistency nobody chose.
3. **The documented escape hatch half-works and says nothing about it.** §5
   points at `get_global_ref` — correct for *reading in place*, but a binary
   key cannot even be *addressed* from JS (`h.get('�')` pushes the
   replacement bytes, not the original key). What actually works, verified:
   **`handle.pairs()` under `binaryStrings` is fully byte-faithful for keys**
   — it converts keys as *values* (`CoreToNapi`, `lua-native.cpp:575`), so
   both entries arrive as `Uint8Array[255]` / `Uint8Array[254]`. That is the
   real remedy, it is an undocumented exception to "keys are unaffected", and
   it is one door behaving differently from its siblings — benignly, this
   time.

**Recommendation (not implemented).** Under `strictConversion`, refuse a table
key that is not valid UTF-8 — the check belongs beside the existing key checks
in `ToLuaValue`, refusing *before* the decode can lose anything, with a
message pointing at `handle.pairs()` + `binaryStrings`. Add the row to §5's
table and a sentence to §2 stating what "unaffected" costs. This changes no
default behaviour; it wants a pin per the other four refusals.

### F2. The read-handler channel is mode-incoherent under `binaryStrings`, in both directions (medium)

**Driven, format direction:**

```js
const lua = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
lua.set_read_handler((format) => { /* format is Uint8Array[110], not "n" */ });
lua.execute_script('io.read("n")');
```

The handler receives `Uint8Array [110]`. The declared signature
(`types.d.ts`: `(format: string | number)`) and every documented example
(`format === 'l'`, a `switch` on the format) silently stop matching. The
format is not user data — it is an API token the binding relays — but it is
relayed through the *value* converter (`CoreToNapi`,
`lua-native.cpp:4429`), so the mode leaks into it. The sibling channel proves
this is a fall-through rather than a choice: `set_file_reader` passes its path
via `Napi::String::New` directly (`lua-native.cpp:4495`) and stays a string in
byte mode. Two host-callback channels, two behaviours.

**Driven, return direction:**

```js
lua.set_read_handler(() => new Uint8Array([0xFF, 0x41]));
lua.execute_script('return io.read()')   // → the 6-char TEXT "255,65"
```

The install path coerces with `result.ToString()` (`lua-native.cpp:4446`), and
`ToString` on a `Uint8Array` is `Array.prototype.toString` — comma-joined
decimals. So in the one mode whose premise is "strings are bytes", the input
channel can neither describe its format as a string nor accept bytes as input.
A byte-mode context can *read* binary through every other door and cannot
*feed* binary through this one.

**Recommendation (not implemented).** The format token should stay a string —
it is protocol metadata the binding mints, exactly like the file-reader path —
which is a one-line change from `CoreToNapi` to `Napi::String::New`. The
return side should accept a `Uint8Array`/`Buffer` via the existing
`BinaryBytesToString` before falling back to `ToString`. Both want pins;
neither changes default-mode behaviour.

### F3. Removing a synthesized `io` breaks the rule its own comment states (medium)

`RemoveInputRedirection` (`lua-runtime.cpp:1859`) opens with the rule: *"Only
take back what is still ours … the caller may have replaced `io` in the
meantime, and removing a handler is not a licence to undo that."* The
implementation tests whether **`io.read` is the wrapper function**; "ours" in
the rule refers to **the table**. Those are different questions, and each way
they can disagree produces a defect:

**a. The caller's table is destroyed (rule violated).** Driven:

```js
const lua = new lua_native.init({}, { libraries: 'sandbox' });
lua.set_read_handler(() => 'x');
lua.execute_script('io = { read = io.read, mine = 1 }');  // caller's own table
lua.set_read_handler(null);
lua.execute_script('return type(io)')                     // → "nil"
```

The script built its own table — kept the wrapper as `read`, added its own
field — and the removal nuked it, because `io.read == LuaIoRead` answered
"ours". The comment's own words describe this as the thing it must not do.

**b. The documented postcondition fails, and the state machine loses track
(comment false).** `types.d.ts` says *"Passing `null` removes a table created
this way, so `io` goes back to `nil`"*. Driven: script replaces `io.read` with
its own function; `set_read_handler(null)` finds `read` is not the wrapper,
returns without removing — correct caution — **but then still clears
`io_synthesized_`** (`lua-runtime.cpp:1882`), under a comment claiming
*"reaching this line means `io` is gone"*. It is not gone: `type(io)` is
`table`, the doc's promise is false, and the host has permanently lost the
knowledge that it created that table — a later install/remove cycle wraps the
script's function as "the original" and leaves an `io` table in a `sandbox`
context that `set_read_handler(null)` can never again remove. No seal widening
(the table holds only what the script itself put there), but a documented
claim and an internal comment are both wrong on the same site — the
comment-drift-on-the-exact-site class of CR-21 A5 / CR-22 F3a, in code written
eight days ago.

**Recommendation (not implemented).** Make "ours" mean the table: keep a
registry ref (or identity) of the synthesized table and compare *that* on
removal; clear `io_synthesized_` only on the path that actually removed it;
soften the `types.d.ts` sentence to name the script-mutated case. Fixing only
the comment would be the smaller change and would leave both behaviours —
state which is intended.

### F4. The trigger table has no row for a mode (medium, meta)

§15.6 reopens review for a new entry point, handle kind, marker, frame,
`ObjectWrap`, tag, occupancy policy, Lua bump, or threading mode. This
surface is none of those, and the table therefore fired **no row** — every
instrument still runs under default options, and the only reason the modes got
searched is that this pass asked a question the table does not contain. The
enumeration-one-member-short class, found in the product by CR-17–21, in the
boundary list by CR-22 F2, is now present in **the list of things that reopen
review**. One level further up again.

The gap is not vacuous, and it is not hypothetical:

- F1 and F2 both live in mode space, and both were found by exactly the sweep
  an instrument would have run.
- `LIMITATIONS.md` §5 claims strict mode is *"refused uniformly at all
  eighteen entry points … **checked against `tools/roundtrip-matrix/doors.mjs`**"*.
  Nothing checks it against `doors.mjs`. The suite's uniformity test
  hand-picks four doors; no test imports the doors file. The property happens
  to be true — this pass verified all eighteen — but the claim describes a
  check that does not exist, which is the `assertion-strength` class
  (a check weaker than the sentence above it) at the documentation level.
  Notably the two doors the hand-picked four omit are the two that push on a
  worker thread — the ones with a genuinely different failure mode.

**Recommendation (not implemented).** Two parts. (1) Add the row to §15.6:
*"a new option that changes conversion or VM rules → run `roundtrip-matrix`
(and `exec-parity` if execution-visible) under that mode"*. (2) Make
`roundtrip-matrix` mode-parameterized — the axes exist; this pass's probe
reused `doors.mjs` unmodified in ~40 lines — and let the §5 sentence cite a
check that runs. The declaration should follow the instrument, not precede it
(CR-22 F2's rule).

### F5. Nit: `call_async` reports its argument errors as "resume value" errors

`call_async('id', [1, null, 3])` under strict rejects with *"Error converting
**resume value**: strict conversion: …"* (`lua-runtime.cpp:4164`) — the call
door speaking in the vocabulary of the resume machinery it is built on. The
strict message inside is right; the prefix attributes it to an operation the
caller never performed. CR-13 F1 is the record of why messages naming the
wrong operation cost more than they look like they should.

---

## The probe's own false finding

The `binaryStrings` exit sweep initially reported `pcall` as a differing door
("cannot read `results[0]`"). The dirt was in the probe: `pcall` returns
`{ ok, value }`, not `{ results }`, and the value arrives as a correct
`Uint8Array`. Caught by driving the "finding" to a hand-run reproduction
before believing it — the CR-22 rule, doing for this pass what it was written
to do. Running count of instrument/probe false findings across the programme:
nine, every one the harness misreading its own probe.

---

## Verified and rejected (suspicions that held up)

- **Strict-mode uniformity, all eighteen doors.** Every door refuses
  `[1, null, 3]` with a message naming the loss — including `call_async` and
  `resume_async`, whose arguments are pushed on a **libuv worker thread** and
  where the suspicion was a `std::runtime_error` with no handler above it (the
  CR-6 F1 abort class). The throw surfaces as a promise rejection /
  in-band coroutine error on every path. Outbound async too:
  `execute_script_async('return {[true]=1}')` rejects with the strict message.
- **Strict throws inside Lua C frames.** A host function returning a lossy
  array throws mid-C-frame; it arrives as a catchable Lua error
  (`pcall` → `false, "Error converting return value from 'f': strict …"`).
  No abort.
- **`binaryStrings` exit parity.** Eleven exits probed — script return,
  `get_global`, handle `.get`, metatabled proxy field, Lua-function return,
  host-function argument, coroutine resume value, `pcall`, iterator pairs,
  `execute_script_async`, `call_async` — all deliver `Uint8Array`. The one
  divergence is F2's format token.
- **Byte round-trip symmetry.** Inbound `Uint8Array`/`Buffer`/`ArrayBuffer`
  were already binary-safe Lua strings (`BinaryBytesToString`, B1), so bytes
  out → bytes in is an identity. Not luck: the inbound half predates the
  option and the option's design leaned on it.
- **The accept-and-retain class (`LIMITATIONS` §8) has no surviving sibling.**
  `register_module`, `add_search_path`, `add_searcher` on a `package`-less
  state all throw naming the missing library. The class the read-handler fix
  closed was checked across its members rather than at the fixed site — the
  CR-17 lesson, applied.
- **The mixed-table bypass does not exist.** `{[1]="a", ["1"]="b"}` fails
  `isSequentialArray` (a non-integer key), takes the map branch, and the
  strict collision check fires. The array fast-path cannot smuggle a
  colliding key past strict mode.
- **The `sandbox` seal.** Filesystem doors gone (and pinned), bytecode off by
  default with an explicit override honoured, seal and strict mode both ride
  `RuntimeConfig` so `reset()` preserves them (driven and pinned),
  `set_read_handler`'s synthesized table carries `read` alone so the granted
  capability is exactly as wide as the grant. F3 is a teardown-bookkeeping
  defect, not a seal defect.
- **Option parsing fails closed.** `strictConversion: 'yes'` throws;
  `binaryStrings` accepts only a boolean `true`; an unknown preset string
  names the valid set.

---

## Suggested priority order

*(Executed in this order on August 6, 2026 — see the Resolution section. Kept as
written, since the ordering argument is the reasoning that produced the work.)*

1. **F1** — the binary-key entry loss. The only serious finding; it defeats
   the new option's core promise on a member of exactly the class the option
   was built to refuse. Comes with a doc row (§5) and the `handle.pairs()`
   escape-hatch sentence.
2. **F2** — the read-handler token and return coercion, before `binaryStrings`
   has adopters whose handlers are written against the accidental behaviour.
3. **F3** — decide table-identity vs comment-fix for the synthesized-`io`
   removal; either way the false comment and the `types.d.ts` sentence go.
4. **F4** — add the §15.6 row and mode-parameterize `roundtrip-matrix`; then
   the §5 "checked against" sentence becomes true instead of aspirational.
5. **F5** — the message prefix, whenever `call_async` is next touched.

---

## Note on the trajectory

The finding curve: CR-20 **4+1/1**, CR-21 **3/0**, CR-22 **3/1 serious**,
interop exercise **5 catches**, CR-23 **5/1 serious**.

**The per-instrument yield law held for the seventh time, in its generalized
form.** The seven existing instruments, re-run, found nothing new. A genuinely
new *search* — the mode sweep, forty lines against existing axes — found one
serious thing and one medium thing in the region no instrument covers. The law
has never been about instruments; it is about unsearched regions, and §15.8
said as much when it predicted an eighth instrument would find about one
thing. It found exactly one serious thing.

**The recurring class has now recurred at every level of the stack.** A class
boundary drawn one member short has been found in the product (CR-17), in a
fix (CR-21), in an instrument (CR-22's drafts), in the boundary enumeration
(CR-22 F2), and now in **the trigger table that governs when anyone looks**
(F4) — and simultaneously in the newest feature's own loss enumeration (F1),
written by people who demonstrably know the class exists, in a commit whose
comments *cite the class by name*. The conclusion the programme should carry
forward is not "enumerate harder"; it is that **an enumeration's criterion has
to be recorded next to the enumeration** (§15.1 did this for boundaries; §5
and §15.6 do not state theirs), because a list without its generating rule
cannot be checked for completeness, only extended when something leaks past
it.

**The trigger mechanism half-worked, and the half matters.** §15.6's table was
applied and correctly fired nothing — the failure was in the table, not the
applying. The first exercise (August 5) succeeded because the surface was made
of things the table enumerates; this one required a question from outside the
table. Until F4's row exists, the honest statement is: **review reopens on new
surface the table can name, and on new *rules* only if someone notices** —
which is the calendar-free version of the same gap the programme closed by
moving from recollection to criterion.
