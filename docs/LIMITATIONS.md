# LIMITATIONS

**What `lua-native` deliberately does not do, and what it does less completely
than you might assume.** The companion to [`FEATURES.md`](FEATURES.md), which
covers what it does.

Every claim here was verified against the running addon on **August 4, 2026**,
not inferred from the source. Where a limitation has a workaround, the
workaround is given and has been driven.

**Revised August 5, 2026.** Two entries gained mitigations: §5's four *silent*
conversion losses can now be refused (`strictConversion`), and §8 turned out to
be fixable after all — its own conclusion had ruled out one bad solution and
stopped there. Both are marked below. The re-read that produced them is worth
repeating: an entry that says "not fixable" is a claim with an argument attached,
and the argument is the part to check.

---

## 1. `libraries: 'safe'` is not a sandbox for untrusted code

**The most important entry here, because the documentation used to say
otherwise.**

`'safe'` loads `base`, `package`, `coroutine`, `table`, `string`, `math` and
`utf8` — that is, everything except `io`, `os` and `debug`. That is exactly what
it claims, and it is **not sufficient to run untrusted code**, because the
filesystem is reachable from two libraries it keeps:

- **`base`** provides `dofile` and `loadfile`.
- **`package`** provides `require`, and `package.path` is writable from inside
  the sandbox.

Driven under `libraries: 'safe'`:

```
dofile("/tmp/x.lua")                          -> executed
loadfile("/tmp/x.lua")                        -> function
package.path = "/tmp/?.lua"; require("x")     -> executed
load(string.dump(f))                          -> function   (unless allowBytecode: false)
```

**Bounded honestly — and the bound was wrong, corrected August 7, 2026.** What
this paragraph used to say: *a script cannot read arbitrary file contents as
data, `loadfile` on a non-Lua file returns `nil`, so the target must parse as
Lua; but any readable `.lua` file on the host can be executed.* Both halves of
that are true and the conclusion is still too generous, because the list of
doors above is four short. `package` also carries **`loadlib`**, and
`package.searchers[3]`/`[4]` reach the same loader through `require`:

```
package.loadlib("/usr/lib/libSystem.B.dylib", "*")   -> true   (under 'safe')
```

That links a **native library** into the process — not a `.lua` file, so the
"must parse as Lua" limit does not apply to it at all. `package.searchpath`
additionally probes the filesystem for existence, which the old text did not
mention either. The doors
were found by deriving them from the source rather than from this list (T2), and
the list is now: `dofile`, `loadfile`, `searchers[2]`, `searchers[3]`,
`searchers[4]`, `loadlib`, `searchpath` — plus `io`'s and `os`'s file functions
where those libraries are loaded.

None of this changes what `'safe'` *claims*: it says it is not a sandbox, and it
is not. What changed is that the worst case is now stated accurately.

### The other fix: `filesystem: 'deny'` (added August 7, 2026)

`'sandbox'` seals by *removing* `package`, so `require` goes with it. The
option below seals by closing the doors instead, so the host can still serve
modules:

```js
const lua = new lua_native.init({}, { libraries: 'safe', filesystem: 'deny' });
lua.register_module('config', { env: 'prod' });
lua.execute_script('return require("config").env');   // 'prod'
lua.execute_script('dofile("/etc/passwd")');          // throws
```

Every door in the list above refuses, each in the idiom its real counterpart
uses for failure (`nil, msg` or a raise), and `add_search_path` refuses rather
than accepting a path `require` can never consult. It governs what *Lua* can
reach: `execute_file`, `compile_file` and a `set_file_reader` handler still
work, because the host asking for a file by name is the caller's own decision.
It is **not** a general sandbox — `os.execute` and `io.popen` are process doors,
not filesystem doors, and are untouched.

**What `allowBytecode: false` does and does not buy you here** (corrected
August 6, 2026). The three file doors above reach the host's `.lua` files
whatever this option says — that is what this section is about, and the option
does not change it. What it *does* now guarantee is that whatever they reach is
loaded as **source**: until August 6, 2026 `dofile`, `loadfile` and both
`require` search paths loaded with mode `"bt"`, so a precompiled file was
undumped — the memory-unsafe step the option exists to prevent — while
`load(string.dump(f))` beside it was refused. All five file doors are now
text-only under the option, so the distinction that matters holds: under
`'safe'` an untrusted script can still *execute a readable `.lua` file*, and can
no longer *undump a binary one*.

### The fix: `libraries: 'sandbox'` (added August 4, 2026)

```js
const lua = new lua_native.init({}, {
  libraries: 'sandbox',
  maxMemory: 256 * 1024,
  maxInstructions: 1_000_000,
});
```

`'sandbox'` is `'safe'` minus `package`, with `dofile` and `loadfile` cleared
from the globals — they live in `base`, so they cannot be removed by omitting a
library — and `allowBytecode` defaulting to `false`, since `string.dump` +
`load` would otherwise reach the bytecode loader. An explicit
`allowBytecode: true` still wins. `base`, `coroutine`, `table`, `string`,
`math` and `utf8` remain, so ordinary scripting is unaffected, and **the seal
survives `reset()`**.

Verified:

```
dofile / loadfile / require / package  -> nil
io / os / debug                        -> nil
math.floor(3.7)..":"..("x"):rep(2)     -> 3:xx     (still works)
load(string.dump(f))                   -> nil      (bytecode off by default)
```

> **`'safe'` was not tightened in place**, deliberately: it would break every
> caller that uses `require` under it. `'safe'` keeps its documented meaning
> (all but `io`/`os`/`debug`) and its documented caveat.

Omitting `libraries` entirely gives a **bare state** with no standard library at
all, which is sealed by construction and is the right choice when the script
needs nothing but arithmetic. An explicit array still works too, if you want a
set `'sandbox'` does not give you.

---

## 2. Lua strings that are not valid UTF-8 do not survive the crossing

Lua strings are **byte** strings; JavaScript strings are sequences of UTF-16
code units. A byte sequence that is not valid UTF-8 is replaced with U+FFFD on
the way out. Driven:

```js
lua.execute_script('return "\xFF\xFE\x00\x01"')
// → 4 chars: fffd, fffd, 0, 1     — the two high bytes are gone
```

Embedded NULs survive. Lone surrogates survive *into* Lua. Anything ≥ 0x80 that
is not valid UTF-8 does not survive *out* of it.

**This is data-dependent, which is what makes it dangerous:**
`string.pack("i4", 7)` is all bytes below 0x80 and round-trips perfectly, so
binary handling appears to work until a byte goes high. It is also not
idempotent — `"\x00\x01\xFE\xFF"` is 4 bytes in Lua and returns as 8 after a
JS round trip.

**Affects:** `string.pack`/`unpack`, compression, crypto, image or protocol
buffers, anything reading a binary file through Lua.

**Without the option below**, the only workarounds are to keep binary data on
one side of the boundary or encode it before crossing (`base64`, or
`string.byte(s, 1, -1)` for an array of numbers) — both cost a copy, and the
byte-array form costs a JS number per byte.

### The fix: `binaryStrings: true` (added August 4, 2026)

```js
const lua = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
lua.execute_script('return string.pack("i4", -2)');   // → Uint8Array [254,255,255,255]
```

Every Lua string comes back as a `Uint8Array` of its exact bytes. Text is
decoded by the caller: `new TextDecoder().decode(bytes)`.

**Binary data round-trips exactly in this mode**, which is the one built-in
conversion that stops being one-way: a `Uint8Array` goes in as a binary-safe Lua
string and comes back as the same bytes. Verified at all nineteen doors by the
`binary` mode of `npm run roundtrip-matrix`, where it is the single value that
contradicts `LuaInput`'s blanket "the built-ins are one-way" and is ledgered as
such.

**Table keys are unaffected by the option — which is not the same as being
safe.** A JS property name is a string in every mode, so a key is decoded as
text whatever this is set to. A key whose bytes are not valid UTF-8 is therefore
still mangled, and can still collapse two entries into one; that is §5's byte-key
row, and the answer there is `strictConversion` (a refusal) plus `handle.pairs()`
(which converts keys as *values*, so under this option they arrive as exact
bytes). The two options together leave no silent loss in either direction.

**All-or-nothing per context, deliberately.** Returning bytes *only* when the
decode would have been lossy is the obvious-looking design and is the one to
avoid: it makes the return type depend on the data, which is precisely the
defect class these reviews kept finding — code that looks correct until the
input changes. Either every string is text or every string is bytes, and the
caller knows which.

**The default is unchanged and still lossy**, because flipping it would change
the return type for every existing caller. That default is what the O1 entry in
`tools/diff-oracle/accepted.mjs` describes, and it stays ledgered.

**Why the converter registry was not used instead.** `register_from_lua_converter`
deliberately does not fire for primitives — `CoreToNapi` says so and gives the
reason (a JS call per number and string crossing out of Lua). Routing strings
through it would have violated that rule *and* required data-dependent dispatch
to deliver bytes at all.

---

## 3. No state snapshot or persistence

There is no way to serialize a `lua_State` and restore it later — the
capability that Eris/Pluto provide for Lua and that game engines use for save
states. `reset()` discards state; it does not checkpoint it.

**Not a gap against comparable JS bridges** — neither wasmoon nor fengari offers
it either — so this is a differentiator rather than a deficiency. Recorded
because it is the kind of thing an embedder assumes exists.

**Workaround:** serialize the data you care about from Lua (`create_table`
handles or a `pairs` walk) and replay it after `reset()`. Closures, coroutines
and userdata cannot be replayed this way.

---

## 4. No worker pool / true parallelism

`execute_script_async` runs a script on a libuv worker thread, but a
`LuaRuntime` is single-threaded by construction and the async model assumes one
owner at a time. There is no pool.

**A scope decision, not a pending item.** "True parallelism" means N independent
contexts plus a scheduler, which userland can build over `execute_script_async`
today — nothing in the binding blocks it. Putting a pool in C++ would move
policy (sizing, queueing, fairness, backpressure) into the addon, where it is
hardest to tune. Tracked as A5 in
[`reviews/BRIDGE-COMPARISON.md`](reviews/BRIDGE-COMPARISON.md).

Note that *one* async operation per context is a separate and firmer rule:
`execute_async`, `call_async`, `resume_async` and the worker doors all check
`is_busy()` and refuse while another is in flight. That is not a pool question —
a `LuaRuntime` is single-threaded by construction.

---

## 5. Documented conversion losses

These are specified rather than surprising, and are listed here only so this
document is a complete answer to "what should I not rely on". Full detail is on
`LuaInput` (in) and `execute_script` (out) in `types.d.ts`.

> **The rule this table is generated from** — stated August 6, 2026, because a
> list without its generating rule cannot be checked for completeness, only
> extended when something leaks past it:
>
> **A row belongs here when a value crosses between JS and Lua and arrives
> *different*, for a reason that is a property of the two type systems rather
> than of the caller's data.** Three clauses, each doing work. *Crosses* — an
> internal representation choice that is never observable is not a row.
> *Arrives different* — a refusal is not a loss, which is why the circular and
> depth rows are marked "no" rather than omitted: they are here for contrast.
> *A property of the type systems* — Lua keys are bytes and JS property names
> are text; Lua tables have one namespace and JS objects another. Anything that
> depends only on which values the caller happened to pass is a bug, not a row.
>
> **Why this is written down at all.** `strictConversion` was built from this
> table, and the table was one row short — Lua keys are bytes, so the byte-key
> row followed from the rule and nobody had derived it. The option shipped short
> the same row (CR-23 F1). The generating rule is the thing that would have
> caught it, and the three-way split above is what `roundtrip-matrix` and the
> `strict` mode now range over.

| Direction | Loss | Silent? |
|---|---|---|
| JS → Lua | `null`/`undefined` in an **array** truncates the Lua sequence at that index | **yes** |
| JS → Lua | `null` as an object value removes the key | **yes** |
| JS → Lua | a **`Map`**'s keys are stringified, so `1` and `"1"` collide and `true` becomes `"true"` | **yes** |
| JS → Lua | a circular reference is refused; nesting past 100 levels is refused | no — throws |
| Lua → JS | a table key that is neither string nor number is dropped | **yes** |
| Lua → JS | a string key and an integer key with the same text collide | **yes** |
| Lua → JS | a table key whose **bytes** are not valid UTF-8, or contain a NUL, cannot become a JS property name | **yes** |
| Lua → JS | an integer outside ±(2^53−1) arrives as a `BigInt`, so `typeof` is not stable | no — a type change, visible |

**The byte-key row was added August 6, 2026 (CR-23 F1)**, and it is the nastiest
of the five because it can lose an entire entry without either key looking
unusual:

```js
lua.execute_script('return {["\xFF"]="a", ["\xFE"]="b"}')
// → { "�": "a" }   — two distinct Lua keys, one JS property, one value gone

lua.execute_script('return {["a\0b"]="v1", ["a"]="v2"}')
// → { "a": "v1" }       — the NUL key truncates onto the plain one
```

A JS property name is *text*; a Lua key is *bytes*. Anything not strictly valid
UTF-8 has each bad byte replaced with U+FFFD (including overlong encodings and
lone surrogates — `"\xED\xA0\x80"` comes back as three replacement characters),
and an embedded NUL truncates the name there. Either way two keys can land on
one property, and which value survives depends on table order.

**`binaryStrings` does not help here, and §2's "table keys are unaffected" is
about the mode, not about safety** — a key is decoded as text in every mode,
which is exactly why this row exists and why the answer for keys is a refusal
rather than a switch. The remedy that does work is
[`handle.pairs()`](TABLE-REFERENCE.md): it converts keys as *values*, so under
`binaryStrings` both keys arrive as exact `Uint8Array`s and nothing collides.

**The Map row was added August 7, 2026 (T1)**, and it is the second time this
table has been found a row short by the rule that generates it — CR-23 F1 was
the first. It was missed for a specific reason worth recording: `Map` was
believed to *be* the answer to the Lua→JS key losses, so nobody asked what
happened to a Map's own keys on the way **in**. Driven:

```js
lua.set_global('m', new Map([[1, 'int'], ['1', 'str'], [true, 'bool']]));
// Lua sees two entries, both string-keyed: "1" (one value lost) and "true"
```

It follows from the rule exactly as the byte-key row did: a Lua key is bytes, a
`Map` key is any JS value, and the two type systems disagree about what a key
is. `tableAs: 'map'` fixes this direction too.

### The fix: `tableAs: 'map'` (added August 7, 2026)

Where `strictConversion` **refuses** the Lua→JS key losses, this one **represents**
them — a `Map` holds what a JS object cannot:

```js
const lua = new lua_native.init({}, { libraries: 'all', tableAs: 'map' });
lua.execute_script('return {[1]="int", ["1"]="str", [true]="bool"}');
// → Map { 1 => 'int', '1' => 'str', true => 'bool' }   — nothing lost, nothing refused
```

Three of the four Lua→JS rows above stop being losses, and the Map row on the
JS→Lua side stops too: in this mode a `Map` crosses into Lua with its key types
intact, so the option is symmetric.

**Every table becomes a Map, including sequences** — `{"a","b"}` arrives as
`Map { 1 => "a", 2 => "b" }`. Making the shape depend on whether the table
happened to be a sequence is the data-dependent return type §2 refuses.

**Where the option had to live, which is the interesting part.** It was designed
as a rendering switch in the binding: build a Map instead of an object. That is
impossible — `LuaTable` is a `std::unordered_map<std::string, LuaPtr>`, so the
number key `1` and the string key `"1"` have **already merged** before the
binding sees the table. Rendering a Map from that would have produced a
faithful-looking container full of data that was already lossy. So the mode
instead makes the core keep a plain table **by reference** — the branch
metatabled tables always used — and the binding materializes the Map by walking
the real table. The lesson generalizes: *a fidelity option has to be applied
where the fidelity is lost, and that is not always where the value is rendered.*

**Composes with `strictConversion`**: nothing is left for it to refuse on those
rows, so the pair is the first configuration with no silent loss **and** no
refusal in either direction. A metatabled table is unaffected — still a live
Proxy in both modes.

### The fix: `strictConversion: true` (added August 5, 2026)

The **silent** rows can be refused instead of performed:

```js
const lua = new lua_native.init({}, { libraries: 'all', strictConversion: true });

lua.set_global('rows', [1, null, 3]);
// throws: null/undefined at array index 1 becomes a Lua nil, which ends the
//         sequence there — #t and ipairs would stop before the later elements.
//         Filter the array, or use false as a present placeholder.

lua.execute_script('return {["1"]="a",[1]="b"}');
// throws: the Lua table keys 1 (number) and "1" (string) both become the
//         JavaScript property "1", so one value would be lost. Read the table
//         in place with get_global_ref() to keep both.

lua.execute_script('return {["\xFF"]="a"}');
// throws: a Lua table key containing bytes that are not valid UTF-8 has each of
//         them replaced with U+FFFD when it becomes a JavaScript property name,
//         so two distinct keys can collapse into one and a value would be lost.
```

Each message names what would have been lost and what to do instead. The two
rows that already throw keep their own messages — strict mode does not relabel
them — and the `BigInt` row is untouched, because a type change the caller can
see is not the thing this option is for.

**Refused uniformly at all nineteen entry points** a value can cross at. A mode
honoured by `set_global` but not by a Lua function argument would be worse than
no mode at all — so this is *checked*, not asserted: `npm run roundtrip-matrix`
runs its whole corpus through every door in `tools/roundtrip-matrix/doors.mjs`
under this mode as well as the default, and a door that answered differently
from its eighteen siblings would be a parity disagreement.

**That check dates from August 6, 2026 (CR-23 F4).** The sentence above used to
claim it while no such run existed — the suite hand-picked four of the then-eighteen
doors, and the two it omitted were the two that push arguments on a worker
thread. The property held when it was finally measured; the point is that it had
been stated before it was.

**All-or-nothing per context, deliberately** — the rule §2 states, for the reason
§2 gives. A mode that refused only *some* lossy conversions would make behaviour
depend on the data, which is the defect class it exists to surface.

**The default is unchanged**, because turning it on makes previously-working
programs throw. A non-boolean value is rejected rather than ignored, so
`strictConversion: 'yes'` cannot quietly mean "off" — which for an option whose
whole job is catching mistakes would be the exact failure it is meant to prevent.

> The escape hatch that needs no option is still there and is still the better
> answer when it fits: a handle from `get_global_ref` reads the real table in
> place, so boolean keys and colliding keys survive because nothing is converted.
>
> **That sentence was half false until August 7, 2026, and the half that failed
> is worth recording.** Colliding keys did survive. Boolean keys did not:
> `handle.pairs()` skipped every key that was not a string or number, and
> `get`/`set`/`has` took no boolean, so a `t[true]` entry could be neither
> enumerated nor read — this row's own silent-loss class, reappearing in the API
> this document nominates as the way out of it. The skip was deliberate and its
> comment gave the reason: *"only string and number keys survive the crossing"*,
> which is true of a table converted to a JS **object**, where a key becomes a
> property name. `pairs()` emits `[key, value]` tuples and converts the key as a
> *value*, so the constraint was inherited from a path this one is not on. Both
> halves are now fixed together — `pairs()` emits boolean keys and the accessors
> take them — because emitting a key nothing could address would have been the
> worse limitation. Table, function and userdata keys are still skipped, and
> `pairs()` now says so.

---

## 6. No generic JavaScript reflection from inside Lua

fengari exposes a `js` library *inside* Lua — `js.global`, `js.new`, `js.of` —
so a script can reach the JavaScript environment with no host wiring. Here,
everything Lua can touch must be registered from JS first: a global, a userdata,
a class, a module, a searcher.

**A deliberate design decision, not a gap**, and it should stay that way: an
allowlist is the entire basis of the sandboxing story. `libraries: 'sandbox'`
would be meaningless with a `js.global` in scope, and so would `maxMemory`,
`maxInstructions` and `allowBytecode`, since a script could reach the host's own
facilities directly.

Recorded because it is the largest single capability difference against fengari
and someone will ask. Revocable by the owner; nothing should reopen it
implicitly.

**Workaround:** register what a script legitimately needs. `set_userdata` with
`methods`, `register_class`, and `register_module` cover the object-model cases;
a host callback covers the rest.

---

## 7. No raw Lua C API surface

fengari exposes the entire `lua_*` / `lauxlib` C API to JavaScript. This is
deliberately a high-level bridge — the two-layer split in `CLAUDE.md` exists so
the C API stays on the C++ side, where the stack discipline, the `ExecutionScope`
bracketing and the protected-call barriers can be enforced rather than hoped for.

Everything the correctness programme mechanized (the occupancy model, the
exception-escape matrix, the handle branding) assumes the binding is the only
thing that touches the state. A raw stack API would put all of it back in the
caller's hands.

**Not a gap, and not planned.** Recorded for the same reason as §6.

---

## 8. ~~`set_read_handler` needs the `io` library~~ — fixed August 5, 2026

**This entry was wrong twice over, and both halves are now fixed.**

`set_print_handler` works everywhere because `print` lives in the base library.
There is no base-library *input* function, so `io.read` is the only thing to
redirect — and a bare or `libraries: 'sandbox'` state has no `io` to hook.

The old entry concluded that this was unfixable, on the grounds that *"inventing
a non-standard global to fill the gap would be worse than the gap: a script
written against it would not run on stock Lua."* That reasoning is sound and it
ruled out a global nobody needed to invent. **`io.read` is the standard name.**
When `io` is absent, `set_read_handler` now creates a minimal `io` table holding
`read` and nothing else, so a script written against a sealed context still runs
on stock Lua:

```js
const lua = new lua_native.init({}, { libraries: 'sandbox' });
lua.set_read_handler(() => 'Ada');           // → true
lua.execute_script('return io.read()');      // → 'Ada'
lua.execute_script('return type(io.open)');  // → nil — still sealed
```

This is exactly what `set_file_reader` already did for `dofile`/`loadfile`, which
`'sandbox'` also clears and which also come back host-backed (§1). **The seal is
not widened**: no `open`, `lines`, `write`, `stdout` — only the one function the
host just supplied. Passing `null` takes the synthesized table back, so `io`
returns to `nil` and a script's `if io then` sees what it saw before. Where `io`
is the real library, nothing changed: the wrapper stays installed on clear and
falls through to the original `io.read`.

### The second half: it was never a no-op

The old entry said `set_read_handler` "is a no-op there, and does not throw".
It did not throw, but it was not a no-op either — it **accepted the handler,
stored it, wired nothing, and returned `undefined`**. The context held a strong
reference to a JS closure that could never fire, and no caller could detect it.

`set_read_handler` now **returns whether `io.read` is wired**. With the synthesis
above the answer is almost always `true`; the one `false` case is a global `io`
that exists and is not a table (`io = 42`), which belongs to the caller and is
left alone rather than overwritten. A refused handler is not retained.

> **Worth keeping as a lesson, not just a fix.** The entry recorded a real
> constraint, drew a correct conclusion about one bad solution, and then let that
> stand as a conclusion about *all* solutions — while a working precedent for the
> right one sat in the neighbouring capability, documented three sections up.

---

## 9. Lua 5.5 only, which is narrower than it sounds

**This document had no entry for the single most likely reason an existing Lua
codebase will not run here** until August 7, 2026 (R2). It is not a defect and
nothing is going to be fixed; it is a fact about reach that an embedder should
learn before porting rather than during.

`lua-native` links **Lua 5.5** (`info().version` → `Lua 5.5`, release
`Lua 5.5.0`, `versionNumber` 505), and that is the only version there is — the
build resolves one `liblua.a` from vcpkg. There is no 5.4 build, no 5.1 build,
and no LuaJIT. Comparable bridges sit a version or two back: wasmoon ships 5.4,
fengari 5.3/5.4.

**Why that matters more than a version number usually does.** Most published
Lua code — and most of LuaRocks — targets 5.1 through 5.4, and 5.1-era code is
still common because LuaJIT is pinned there. Driven under `libraries: 'all'`:

| Removed before 5.5 | Here |
|---|---|
| `setfenv`, `getfenv` (5.1) | `nil` — use [`create_environment`](FEATURES.md) / `execute_script_in` |
| `unpack` (5.1) | `nil` — `table.unpack` |
| `loadstring` (5.1) | `nil` — `load` |
| `module` (5.1) | `nil` — return a table, or `register_module` from JS |
| `math.pow`, `math.mod`, `table.getn` (5.1) | `nil` — `^`, `%`, `#` |
| `bit32` (5.2), `math.atan2` (5.2) | `nil` — native bitwise operators |

A script written for 5.1 therefore fails at the first call, loudly, which is the
good case. **The quiet case is the integer/float split** introduced in 5.3:
`3` and `3.0` are distinct (`tostring` gives `3` and `3.0`), `7 // 2` is `3`,
and `math.type` exists to tell them apart. Code written before 5.3 that assumed
one number type can produce subtly different output rather than an error — and
that difference reaches JavaScript, where §5's BigInt row is its other end.

What 5.5 does have, and 5.1 does not: integer division, bitwise operators,
`goto`, `<const>` and `<close>` (with `__close` honoured), `coroutine.close`,
`table.move`, `warn`. String→number coercion still works (`"10" + 5` → `15`).

**Not planned, and the reason is scope rather than difficulty.** Supporting a
second Lua would mean a second `liblua.a`, a matrix over both for every
instrument that asserts VM behaviour (`diff-oracle` compares against *the* stock
interpreter from the same vcpkg port), and a version axis on the exception and
capability matrices. A Lua version bump is already a `diff-oracle` trigger
(`CORRECTNESS.md` §15.6); a version *choice* would be a standing axis. If you
need 5.4 or LuaJIT, this is the wrong bridge — better learned from this page
than part-way through a port.

---

## Checked and *not* limitations

Recorded so they are not re-investigated. Each was verified on August 4, 2026.

| Assumption | Reality |
|---|---|
| ~~`for await (… of coroutine)` needs `Symbol.asyncIterator`~~ | **Superseded August 5, 2026.** It *did* work through JS's sync-iterable fallback — and that was the mechanism of a real gap, because the fallback drives the *synchronous* cursor, so a yield needing a host Promise could not work. Coroutines now carry `Symbol.asyncIterator`, which steps through `resume_async`. Kept here because "we checked, it's fine" was the wrong conclusion and the reasoning is worth not repeating. |
| `__close` / to-be-closed variables are unsupported | **Supported.** Works in pure Lua and via `set_metatable`. It was merely undocumented; `MetatableDefinition` now lists it. |
| Registered classes cannot overload operators | **They can** — metamethods including `__add`/`__tostring` apply to instances. |
| Handles can be passed between contexts | Refused by design, with a clear error. See `CORRECTNESS.md` §15 and CODE-REVIEW-22. |
