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

### The workaround: seal it explicitly

There is no missing API — the `libraries` array already expresses this. Omit
`package`, disable bytecode, and clear the two base-library functions:

```js
const lua = new lua_native.init({}, {
  libraries: ['base', 'coroutine', 'table', 'string', 'math', 'utf8'],
  allowBytecode: false,
  maxMemory: 256 * 1024,
  maxInstructions: 1_000_000,
});
lua.execute_script('dofile = nil loadfile = nil');
```

Verified with that exact configuration:

```
dofile     -> blocked      require   -> blocked      io  -> nil
loadfile   -> blocked      bytecode  -> blocked      os  -> nil
```

Omitting `libraries` entirely gives a **bare state** with no standard library at
all, which is sealed by construction and is the right choice when the script
needs nothing but arithmetic.

> **Why a `'sandbox'` preset was not added.** It would duplicate what the array
> form already does, and a preset that silently differs from `'safe'` by two
> deleted globals is exactly the kind of thing that goes stale. Changing
> `'safe'` itself was rejected for a different reason: it would break every
> existing caller that uses `require` under it.

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

**Workaround:** keep binary data on one side of the boundary, or encode it
before crossing (`base64`, or `string.byte(s, 1, -1)` to get an array of
numbers). Both cost a copy.

**Status: an open API decision, not a bug.** Carrying binary faithfully means
returning a `Uint8Array` for non-UTF-8 strings, which changes the return type of
`execute_script` and every read path — a breaking change that needs a deliberate
choice (a `binaryStrings` option, or a separate `get_global_bytes()`). It is
ledgered as O1 in `tools/diff-oracle/accepted.mjs` and documented on
`execute_script` in `types.d.ts`. **Nothing here is silently wrong; it is
knowingly lossy.**

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

## Checked and *not* limitations

Recorded so they are not re-investigated. Each was verified on August 4, 2026.

| Assumption | Reality |
|---|---|
| `for await (… of coroutine)` needs `Symbol.asyncIterator` | **Works already.** JS falls back to `Symbol.iterator`, which coroutines have. |
| `__close` / to-be-closed variables are unsupported | **Supported.** Works in pure Lua and via `set_metatable`. It was merely undocumented; `MetatableDefinition` now lists it. |
| Registered classes cannot overload operators | **They can** — metamethods including `__add`/`__tostring` apply to instances. |
| Handles can be passed between contexts | Refused by design, with a clear error. See `CORRECTNESS.md` §15 and CODE-REVIEW-22. |
