# LIMITATIONS

**What `lua-native` deliberately does not do, and what it does less completely
than you might assume.** The companion to [`FEATURES.md`](FEATURES.md), which
covers what it does.

Every claim here was verified against the running addon on **August 4, 2026**,
not inferred from the source. Where a limitation has a workaround, the
workaround is given and has been driven.

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

**Bounded honestly:** a script cannot read arbitrary file *contents* as data —
`loadfile` on a non-Lua file returns `nil`, so the target must parse as Lua. But
any readable `.lua` file on the host can be executed.

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

Every Lua string comes back as a `Uint8Array` of its exact bytes. Values
round-trip (a `Uint8Array` passed back in was already a Lua byte string), and
**table keys are unaffected** — a JS property key is a string either way. Text
is decoded by the caller: `new TextDecoder().decode(bytes)`.

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

| Direction | Loss |
|---|---|
| JS → Lua | `null`/`undefined` in an **array** truncates the Lua sequence at that index |
| JS → Lua | `null` as an object value removes the key |
| JS → Lua | a circular reference is refused; nesting past 100 levels is refused |
| Lua → JS | a table key that is neither string nor number is dropped |
| Lua → JS | a string key and an integer key with the same text collide |
| Lua → JS | an integer outside ±(2^53−1) arrives as a `BigInt`, so `typeof` is not stable |

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

## 8. `set_read_handler` needs the `io` library

`set_print_handler` works everywhere because `print` lives in the base library.
There is no base-library *input* function, so `io.read` is the only thing to
redirect and a bare or `libraries: 'sandbox'` state has nothing to hook.
`set_read_handler` is a no-op there, and does not throw.

Inventing a non-standard global to fill the gap would be worse than the gap: a
script written against it would not run on stock Lua.

**Workaround under `'sandbox'`:** pass input in as a global or a host callback
before the script runs, which is the same shape every other host capability takes
in a sealed context.

---

## Checked and *not* limitations

Recorded so they are not re-investigated. Each was verified on August 4, 2026.

| Assumption | Reality |
|---|---|
| ~~`for await (… of coroutine)` needs `Symbol.asyncIterator`~~ | **Superseded August 5, 2026.** It *did* work through JS's sync-iterable fallback — and that was the mechanism of a real gap, because the fallback drives the *synchronous* cursor, so a yield needing a host Promise could not work. Coroutines now carry `Symbol.asyncIterator`, which steps through `resume_async`. Kept here because "we checked, it's fine" was the wrong conclusion and the reasoning is worth not repeating. |
| `__close` / to-be-closed variables are unsupported | **Supported.** Works in pure Lua and via `set_metatable`. It was merely undocumented; `MetatableDefinition` now lists it. |
| Registered classes cannot overload operators | **They can** — metamethods including `__add`/`__tostring` apply to instances. |
| Handles can be passed between contexts | Refused by design, with a clear error. See `CORRECTNESS.md` §15 and CODE-REVIEW-22. |
