# Modern Lua Bridge — Competitive Gap Analysis

**Status:** Assessment / planning document
**Date:** July 2026
**Last source audit:** July 14, 2026 — every "implemented" claim below was
re-verified against `src/` (see [Verification audit](#verification-audit-july-14-2026))
**Purpose:** Identify the features that mature Lua bridges provide but `lua-native`
does not yet cover — including gaps *not* already tracked in [`FUTURE.md`](./FUTURE.md).

This document is deliberately scoped to **feature parity**, not incremental polish.
It answers one question: *if a developer picks `lua-native` over an established
bridge, what will they find missing?*

---

## Method

The comparison draws on the bridges that define user expectations in this space:

**JavaScript ↔ Lua (direct comparables):**

- **wasmoon** — Lua 5.4 compiled to WASM. The most feature-complete JS bridge.
  Notable for bidirectional Promise/async interop, a pluggable `TypeExtension`
  converter system, value decorators, and a mountable virtual filesystem for
  `require`.
- **fengari** — pure-JS reimplementation of the Lua 5.4 C API. Exposes a `js`
  library *inside* Lua (`js.global`, `js.new`, `js.of`) and a full `interop`
  layer, prioritizing complete C-API fidelity.
- **node-lua / lua.vm.js** — older Emscripten-based bindings; establish the
  baseline (execute + globals) that `lua-native` already exceeds.

**C++ ↔ Lua (they define the "usertype" bar):**

- **sol2** — the reference implementation for class/usertype binding:
  constructors, member functions, properties, operator overloading, inheritance,
  enums, protected calls, per-chunk environments, container adapters.
- **LuaBridge / LuaBridge3**, **kaguya**, **luwra** — same usertype focus,
  namespaces, ref-counted object lifetimes.

`lua-native` is a JS↔Lua bridge, so wasmoon and fengari are the closest
comparables. The C++ libraries set the expectation bar for **class binding** and
**operator overloading**, which is where the largest conceptual gap lies.

---

## Snapshot: what `lua-native` already covers well

For context, the following are implemented and competitive:

| Area | Status |
|---|---|
| Script/file execution (sync + async), multiple returns | ✅ |
| Bidirectional value conversion (primitives, arrays, plain tables) | ✅ |
| Host functions (JS callable from Lua) and Lua functions callable from JS | ✅ |
| Coroutines (create/resume) | ✅ |
| Userdata: opaque, property-proxy, and **method binding** on instances | ✅ |
| Metatables on global tables (all standard metamethods) | ✅ |
| Reference-preserving tables (Proxy) and live table handles | ✅ |
| Selective stdlib loading + `safe`/`all` presets | ✅ |
| `require` integration: search paths + JS-object module preload | ✅ |
| Bytecode: compile / compile_file / load_bytecode | ✅ |
| Memory limits + usage reporting | ✅ |

This is already broader than most JS bridges. The gaps below are what separates it
from **full** parity.

---

## Already on the roadmap (`FUTURE.md`) — not re-planned here

These real gaps are already tracked and should not be duplicated. Cross-referenced
so this document stands alone:

- ~~Execution time / instruction limits (Tier 1) + wall-clock timeout
  (Tier 3)~~ — **done** (July 2026: `maxInstructions`, whose count-hook also
  polls the cancel flag, so a compute-bound Lua loop is now cancellable —
  closing A3b; July 24, 2026: `timeout`, enforced from the same hook)
- ~~Error **stack traces** via `debug.traceback` (Tier 2)~~ — **done** (July
  2026, shipped with D2 via a `luaL_traceback` message handler in
  `lua-runtime.cpp`)
- ~~GC control, context reset (Tier 2), state introspection (Tier 3)~~ —
  **done** (July 23–24, 2026: `gc()`, `reset()`, and `info()`)
- ~~Debug hooks (`lua_sethook`) (Tier 3)~~ — **done** (July 24, 2026:
  `set_hook()` / `remove_hook()`, sharing one hook installation with the
  instruction limit and `cancel()`)
- ~~Environment tables / per-script `_ENV` sandboxing (Tier 3)~~ — **done**
  (July 24, 2026: `create_environment()` / `execute_script_in()`)
- ~~Reference lifecycle management / explicit `release()` (Tier 3)~~ — **done**
  (July 23, 2026): `LuaTableHandle.release()` plus context-level
  `release(value)` for function, coroutine, and table refs
- ~~Dotted-path globals (Tier 4)~~ — **done** (July 23, 2026).
  ~~Shared state between contexts (Tier 4)~~ — **done** (July 24, 2026:
  `createSharedTable()` + the `shared` init option)

The remainder of this document covers **gaps that are NOT in `FUTURE.md`** — the
net-new findings.

---

## Net-new gaps (not currently tracked anywhere)

### A. Asynchronous & concurrency interop — ✅ A1–A3 implemented (July 2026)

> **Status:** A1 (await JS Promises from Lua), A2 (callbacks during async), and
> A3 (cancellation) are implemented via `execute_async()` + `cancel()` — a
> main-thread coroutine driver that suspends on host Promises via `lua_yieldk`.
> A4 (coroutine-as-async-iterator) and A5 (worker pool) remain deferred (both
> have workarounds; A5 is deferred by design). See the "Coroutine-Driven Async
> Execution" section in [`FEATURES.md`](./FEATURES.md) and `execute_async()` in
> the API. The original gap analysis is retained below.

The single biggest divergence from modern bridges. Today `lua-native` async is
"fire a whole script on a worker thread, and JS callbacks are *forbidden* while it
runs" (see `docs/ASYNC.md`). Modern bridges treat async as bidirectional.

#### A1. Awaiting JS Promises from inside Lua ⭐ (highest-impact gap)

wasmoon lets Lua call a JS function that returns a Promise and transparently
`await` it (the Lua coroutine suspends, the microtask resolves, the coroutine
resumes). `lua-native` has no path for this — `execute_script_async` blocks all
callbacks, and sync execution can't suspend on a Promise at all.

- **Why it matters:** the defining use case for embedding Lua in Node is letting
  scripts call async host APIs (fetch, db queries, fs). Without it, every async
  host capability must be pre-resolved into globals before the script runs.
- **Approach:** run the script inside a Lua coroutine driven from JS. When a host
  function returns a JS Promise, yield the coroutine, attach `.then()` that
  resumes it with the resolved value. Requires a coroutine-based execution mode
  (`execute_script_async` v2) and a Promise detector in `CoreToNapi`/the host
  bridge (`value.IsPromise()` / thenable check).

#### A2. JS callbacks usable during async execution

Current async mode hard-errors on any host call (`async_mode_` guard in
`LuaCallHostFunction`). The stated reason is thread-safety. A main-thread
coroutine-driven async model (A1) removes this restriction entirely.

#### A3. Cancellation of a running execution

No way to abort a runaway or no-longer-needed async run from JS
(`lua.cancel()` / `AbortSignal`). `FUTURE.md` covers *timeouts* but not
*caller-initiated* cancellation. Implementable via the same `lua_sethook`
infrastructure as instruction limits — set a "cancel requested" flag the hook
checks.

> **Audit note (July 14, 2026):** the shipped `cancel()` sets a
> `cancel_requested_` flag that is checked at host-call and await boundaries
> only — there is no `lua_sethook` component. A script that calls host
> functions or awaits Promises cancels promptly; a pure-Lua compute loop
> (`while true do end`) does not. Full cancellation coverage is blocked on the
> Tier 1 instruction-limit hook in `FUTURE.md` (tracked below as **A3b**).
>
> **Update (July 2026): A3b is closed.** The `maxInstructions` count-hook now
> also polls `IsCancelRequested()` and raises `"execution cancelled"`, and the
> worker-thread `cancel()` path calls `RequestCancel()`. Compute-bound loops
> are therefore cooperatively cancellable — in both `execute_async` and the
> worker-thread `execute_script_async`/`execute_file_async` — whenever
> `maxInstructions` is set (the hook only exists then).

#### A4. Coroutine ↔ JS async iterator ergonomics

Bridges commonly expose a Lua coroutine as a JS `Iterator`/`AsyncIterator` so
`for (const v of coro)` / `for await` works. Today the consumer must hand-loop
`resume()` and inspect `status`. Thin wrapper over the existing coroutine API.

Related ergonomic gap to fold into the same work: `create_coroutine()` accepts
only a script **string** — a `LuaFunction` ref already held on the JS side
cannot be turned into a coroutine without re-sourcing it as text.

#### A5. True parallelism / worker pool

Each context is single-threaded and one-op-at-a-time. Server workloads want a
pool of contexts. `FUTURE.md` notes multi-context isolation exists but there is
no pooling/scheduling abstraction. (Lower priority — userland can build it.)

---

### B. Type-system fidelity — ✅ Implemented (July 2026)

> **Status:** Both B1 and B2 are implemented. See the "Type-System Fidelity"
> section in [`FEATURES.md`](./FEATURES.md) for the architecture and
> `register_type_converter()` in the API. The original gap analysis is retained
> below for context.
>
> **Audit note (July 14, 2026):** the shipped converter registry is
> **JS→Lua only** — `register_type_converter(match, convert)` has no `fromLua`
> counterpart, so app-specific reconstruction of Lua values into JS types
> (the second half of wasmoon's `TypeExtension` design) is not possible.
> Tracked below as **B3**.

Verified against `NapiToCoreInstance` (`src/lua-native.cpp:1157`): only
`function`, `undefined/null`, `boolean`, `number`, `string`, `Array`, and plain
`Object` are handled. **Everything else silently degrades.** This is a
correctness gap, not just a missing feature.

| JS type | Current behavior | Correct/expected |
|---|---|---|
| `BigInt` | → **`nil`** (falls through) | Lua 5.5 has native 64-bit ints — should map to integer |
| `number` > 2³ (int64 from Lua) | → JS `Number`, **precision lost** | Optional BigInt mapping to preserve 64-bit |
| `Date` | → **empty table `{}`** | epoch millis / `os.time` value or userdata |
| `Map` / `Set` | → **empty table `{}`** | table (Map→k/v table, Set→array) |
| `TypedArray` / `ArrayBuffer` / `Buffer` | → garbage/empty table | binary string or light userdata, ideally zero-copy |
| `RegExp` | → empty table | string pattern or documented rejection |
| `Symbol` | → **`nil`** | documented rejection (can't cross) |

Two concrete work items:

#### B1. Handle the common built-in types explicitly

At minimum: `BigInt` (correctness — Lua 5.5 is 64-bit native), `Date`,
`Map`/`Set`, and `Buffer`/`TypedArray`. Each is a small branch in
`NapiToCoreInstance` and a symmetric case in `CoreToNapi`.

#### B2. Pluggable type-converter registry (wasmoon's `TypeExtension`) ⭐

The extensible version of B1: let the host register a converter for a JS
constructor/predicate so app-specific types (a `Decimal`, a domain model, a
`Uint8Array` view) cross the boundary under app control. wasmoon and sol2 both
consider user-extensible conversion a core capability. Design: an ordered list of
`{ match(value): boolean, toLua(value), fromLua(ref) }` entries consulted before
the built-in fallback.

---

### C. Class / usertype binding — ✅ C1–C3 implemented (July 2026)

> **Status:** C1 (constructor binding), C2 (shared per-class metatable with
> methods + property access), and C3 (operator overloading) are implemented via
> `register_class()`. C4 (inheritance) remains deferred. See the
> "Class / Usertype Binding" section in [`FEATURES.md`](./FEATURES.md) and
> `register_class()` in the API. The original gap analysis is retained below.

`set_userdata` binds an **existing instance**. There is no way to register a JS
**class/constructor** so Lua can *construct new instances*:

```lua
local p = Player.new("Link", 100)   -- not possible today
p:take_damage(10)
print(p.health)
```

This is the headline feature of sol2, LuaBridge, kaguya, and is supported (via
proxying) in wasmoon. It is the difference between "pass my objects to Lua" and
"let Lua drive my object model."

Sub-capabilities, roughly in dependency order:

- **C1. Constructor binding** — `register_class(name, { construct, methods,
  properties })` producing a Lua table with a `.new`/`__call` that invokes the JS
  constructor and returns method-bound userdata. Builds directly on the existing
  userdata + method-table machinery.
- **C2. Type-level metatable** — one shared metatable per class (methods,
  `__index`/`__newindex`, `__gc`), rather than per-instance wiring. More
  efficient and the standard pattern.
- **C3. Operator overloading from JS** — expose `__add`, `__eq`, `__lt`, `__len`,
  `__concat`, `__tostring` for a class so Lua operators dispatch to JS. `set_metatable`
  already proves the metamethod bridge works; this generalizes it to types.
- **C4. Inheritance / `__index` chaining** — optional, sol2-level; defer until C1–C3 land.

---

### D. Error fidelity — ✅ D1–D3 implemented (July 2026)

> **Status:** D1 (JS Error fidelity round-trip), D2 (stack traces + structured
> surfacing), and D3 (protected calls from JS via `pcall()`) are implemented.
> See the "Error Fidelity" section in [`FEATURES.md`](./FEATURES.md). The
> original gap analysis is retained below.

#### D1. JS `Error` objects lose all structure crossing into Lua

Host-function exceptions are caught as `std::exception` and reduced to a string
message (`LuaCallHostFunction`). The Error's `name`, `stack`, `code`, and custom
properties are gone. Round-tripping a JS error through Lua and back yields a bare
string, not the original Error. Bridges that care about debuggability preserve at
least type + message + stack.

- **Approach:** carry structured error info (name, message, stack) as a Lua table
  or a dedicated error userdata, and reconstruct a JS `Error` (with `.cause`/stack)
  when it surfaces on the JS side.

#### D2. Structured error results, not just thrown strings

Complements `FUTURE.md`'s stack-trace item: return errors as objects
`{ message, traceback, luaStack }` rather than string-only exceptions, so callers
can inspect the Lua call chain programmatically.

#### D3. Protected calls from JS (`pcall`/`xpcall` surface)

No way to call a Lua function in protected mode from JS and receive a
`[ok, ...results]` tuple instead of a thrown exception. Minor but idiomatic;
useful when the caller wants to branch on failure without try/catch.

---

### E. I/O, output, and module resolution — ✅ E1–E3 implemented (July 2026)

> **Status:** E1 (`print`/`io.write` redirection via `set_print_handler` and the
> `print` option), E2 (dynamic `require` via `add_searcher`), and E3 (bytecode
> guard via the `allowBytecode` option) are implemented. See the "I/O, Output &
> Module Resolution" section in [`FEATURES.md`](./FEATURES.md). The original gap
> analysis is retained below.

#### E1. `print` / stdout redirection to a JS callback ⭐ (common, cheap, absent)

Lua `print` writes to the process stdout. Nearly every embedding wants to capture
script output into a JS handler (log panel, buffer, per-tenant isolation). There
is no hook today. Implementable by overriding the `print` global (and/or
`io.write`) with a host function that forwards to a JS callback set via options
(`{ print: (...args) => void }`).

#### E2. Dynamic `require` via a JS searcher / virtual modules

`register_module` is a *static* preload; `add_search_path` hits the real
filesystem. Missing: a JS callback searcher so `require(name)` can be resolved
lazily/virtually (bundled sources, DB-backed modules, an in-memory VFS — wasmoon
mounts exactly this). Approach: install a custom searcher in `package.searchers`
that calls back into JS to fetch source for an unknown module name.

#### E3. Bytecode load-mode / untrusted-chunk restriction (security)

`load_bytecode` accepts binary chunks unconditionally. Loading *untrusted*
bytecode is unsafe — malformed bytecode can crash or exploit the VM (Lua's own
docs warn against it). Lua's `load` supports a `mode` (`"t"`/`"b"`/`"bt"`) to
forbid binary chunks. Given the `safe` sandboxing story, there should be a way to
run a context in "text-only" mode that rejects bytecode. Currently no such guard
exists despite the sandboxing emphasis.

---

### F. Ergonomics / smaller parity items

- **F1. Metatables on non-global tables.** `set_metatable` only works on global
  names (documented limitation in `FEATURES.md`). No way to attach a metatable to
  a table *handle* or a freshly `create_table()`'d table from JS without dropping
  into `execute_script`. Natural extension of the table-handle API.
- **F2. Call a Lua global by name directly** — `lua.call('fn', ...args)` without a
  `get_global` round-trip. Trivial convenience present in most bridges.
- ~~**F3. Per-call environment on `execute_script`**~~ — **done (July 24,
  2026):** `execute_script_in(env, script)` runs one script against a supplied
  environment table, and accepts any live table reference — a `create_table()`
  handle or a `get_global_ref()` reference works, so the lighter-weight form
  needs none of the `create_environment` machinery. Shipped together with
  `FUTURE.md` Environment Tables.

---

## Verification audit (July 14, 2026)

A full pass over `src/lua-native.cpp`, `src/core/lua-runtime.cpp`, and
`types.d.ts` confirmed every "implemented" banner above is real:

| Claim | Evidence |
|---|---|
| A1–A3 async driver | `execute_async`/`cancel`/`is_busy` exposed; Promise detection + `RequestAwaitYield` in the host-call wrapper; sync execution rejects Promise-returning callbacks with a clear error pointing to `execute_async()` |
| B1 type fidelity | `BigInt` ↔ 64-bit integer both directions (with lossless-range checks and `> 2^53` → `BigInt` on the way out); integral JS numbers become Lua integers; `Date`/`Map`/`Set`/`Buffer`/`TypedArray`/`RegExp` branches present; `Symbol` throws a documented rejection |
| B2 converter registry | `register_type_converter(match, convert)` consulted before built-in object conversion |
| C1–C3 class binding | `register_class` with constructor wrapper, shared metatable, methods, properties, metamethods |
| D1–D3 error fidelity | Structured JS-error tables cross the boundary; `luaL_traceback` message handler on `lua_pcall` and coroutine resume; `pcall()` exposed to JS |
| E1–E3 I/O | `set_print_handler`, `add_searcher`, `allowBytecode` option all present |

The audit also surfaced **three previously untracked findings**, folded into the
matrix below:

- **A3b — cancellation is boundary-only.** `cancel()` sets a flag checked at
  host-call/await boundaries; there is no `lua_sethook` interrupt, so a
  compute-bound Lua loop is uncancellable. Fixing this is the same work as
  `FUTURE.md`'s Tier 1 instruction limits — implement them together.
  *(Since closed — see the update note under A3 and the completed matrix.)*
- **B3 — no Lua→JS custom conversion.** The converter registry only covers
  JS→Lua. wasmoon's `TypeExtension` is bidirectional.
- **A4 (extended) — coroutines only from source strings.** `create_coroutine()`
  cannot take an existing `LuaFunction` ref.

Also noted while auditing (already tracked in `FUTURE.md`, status updated
there): stack traces are done; reference lifecycle is partially done
(`LuaTableHandle.release()` exists, function/coroutine refs have none).
*(Since closed — July 23, 2026: context-level `release(value)` now covers
function, coroutine, and table refs. See `FUTURE.md`.)*

---

## Priority matrix

Ranked by *impact × (absence of workaround)*, highest first. ⭐ marks the items
with no reasonable JS-side workaround and broad demand.

### Completed (verified July 14, 2026)

| # | Gap | Impact |
|---|---|---|
| A1 | ✅ Await JS Promises from Lua | Very high |
| A2 | ✅ Callbacks during async | Medium |
| A3 | ✅ Caller-initiated cancellation (boundary-granularity; see A3b) | Medium |
| B1 | ✅ Built-in type fidelity (BigInt/Date/Map/Set/Buffer) | High |
| E1 | ✅ `print`/output redirection | High |
| C1–C3 | ✅ Class/usertype + operator binding | High |
| D1–D3 | ✅ JS Error fidelity, stack traces, structured errors, `pcall` | Medium-high |
| E3 | ✅ Bytecode text-only guard (`allowBytecode`) | Medium (security) |
| B2 | ✅ Pluggable type-converter registry (JS→Lua; see B3) | Medium |
| E2 | ✅ Dynamic `require` via JS searcher | Medium |
| A3b | ✅ Hook-based cancellation of compute-bound loops (via the `maxInstructions` count-hook; requires `maxInstructions` to be set) | High (sandboxing) |

### Remaining

| # | Gap | Impact | Workaround exists? | Rec. tier |
|---|---|---|---|---|
| B3 | Lua→JS direction of the type-converter registry | Medium | Manual post-processing of results | **3** |
| A4 | Coroutine as (async) iterator + coroutine-from-`LuaFunction` | Low-med | Manual `resume` loop | **3** |
| F1 | Metatables on non-global tables (table handles / `create_table`) | Low-med | `execute_script` | **3** |
| C4 | Class inheritance / `__index` chaining | Low-med | Flatten methods in JS | **4** |
| F2 | Call a Lua global by name (`lua.call('fn', ...)`) | Low | `get_global` | **4** |
| ~~F3~~ | ~~Per-call environment on `execute_script`~~ | — | Done — `execute_script_in` (July 24, 2026) | — |
| A5 | Worker pool / true parallelism | Low | Multiple contexts | **4** (by design) |

---

## Recommended sequencing (updated July 14, 2026)

The original three phases (correctness quick-wins → async overhaul → class
binding) are **complete**. What remains, in order:

1. ~~**Sandboxing completion (A3b + `FUTURE.md` Tier 1)**~~ — **done (July
   2026):** instruction limits (`maxInstructions`) and hook-based cancellation
   shipped together, closing the last no-workaround hole in the untrusted-code
   story (`safe` preset + memory limits + instruction limits +
   `allowBytecode: false` are all in place). The optional wall-clock timeout
   followed on July 24, 2026 (`timeout`), sharing the same hook.
2. **Operational control (`FUTURE.md` Tier 2):** GC control, context reset.
   Small, low-risk, natural follow-ons to the sandboxing theme. ~~Extend
   `release()` from table handles to function/coroutine refs while in the area
   (Tier 3 ref lifecycle).~~ *(Done — July 23, 2026: `lua.release(value)`.)*
3. **Interop polish, by demand:** B3 (Lua→JS converters), A4 (iterators +
   coroutine-from-function), F1 (metatables on handles). Each is small and
   independent.
4. **Defer until requested:** C4 (inheritance), F2, A5, and the `FUTURE.md`
   Tier 4 items. ~~Environment tables / F3~~ *(Done — July 24, 2026:
   `create_environment()` + `execute_script_in()`.)* ~~Debug hooks~~ *(Done —
   July 24, 2026: `set_hook()`.)*

---

## Relationship to `FUTURE.md`

`FUTURE.md` remains the authoritative plan for the sandboxing/operational-control
features it lists (limits, traces, GC, reset, hooks, environments, ref lifecycle).
This document adds the **interop-completeness** dimension those items don't
address: async, type fidelity, class binding, error fidelity, and I/O hooks. The
two together describe full parity with a best-in-class modern Lua bridge.
