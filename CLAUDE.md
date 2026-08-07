# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

lua-native is a native Node.js addon (N-API) that embeds Lua 5.5 into JavaScript/TypeScript applications. It enables bidirectional data exchange and function calls between Node.js and Lua. The module is an ES module (`type: "module"` in package.json).

## Build & Test Commands

```bash
# Build (debug, includes C++ test binary)
npm run build-debug

# Build (release, no test binary)
npm run build-release

# Build (prebuild)
npm run prebuildify

# Run TypeScript tests (Vitest, watch mode by default)
npm test

# Run C++ tests (Google Test)
npm run test-cpp

# Sanitizer harnesses (macOS/Linux; see docs/SANITIZERS.md)
npm run test-cpp-asan   # C++ core under ASan+UBSan
npm run test-ts-asan    # .node addon under ASan+UBSan, via the full vitest suite
npm run test-cpp-tsan   # C++ core under TSan (single-threaded — regression guard)
npm run test-ts-tsan    # addon under TSan, via the async vitest suite

# Source invariants (generated lists vs their frozen answers)
npm run check-invariants
node tools/invariants/run.mjs --update      # re-freeze after a reviewed change

# Exception-escape matrix (39 Lua C frames x 13 throw kinds, 1 process/cell)
npm run exception-matrix

# Differential oracle vs stock Lua 5.5 (2678 cases)
# Needs the vcpkg port's interpreter:  vcpkg install lua[tools]
npm run oracle

# JS -> Lua -> JS round-trip and entry-point parity
# (5 context modes x 19 doors x 50 values)
npm run roundtrip-matrix
node tools/roundtrip-matrix/run.mjs --mode=strict   # one mode

# Execution-door parity: async + bytecode doors vs execute_script (1339 cases x 5 doors)
npm run exec-parity

# Handle lifecycle across reset/GC (12 handle kinds x 12 events, 1 process/cell)
npm run lifecycle-matrix

# Two contexts exchanging values: handles refused, data intact, contexts independent
npm run cross-context

# What a libraries/allowBytecode/filesystem configuration grants (10 configs x 28 doors)
npm run capability-matrix

# Does the binding's own bookkeeping return to baseline?
# (13 retaining containers x 4 series; needs --expose-gc, which the script passes)
npm run binding-balance
node tools/binding-balance/run.mjs --control          # just the controls

# What does it cost, and are the docs right about that?
# (10 documented claims, 19 doors, 5 value kinds, 5 scaling knobs)
npm run crossing-cost
node tools/crossing-cost/run.mjs --control            # just the controls
node tools/crossing-cost/run.mjs --claims             # just the documented claims

# Clean build artifacts
npm run clean
```

**Prerequisites:** Lua must be available via vcpkg. The `get_vcpkg_path.js` script resolves include/lib/interpreter paths from the `VCPKG_ROOT` environment variable. Building and testing the addon needs only the library; `npm run oracle` additionally needs the port's interpreter (`vcpkg install lua[tools]`).

**Important:** After C++ changes, you must `npm run build-debug` before running `npm test`. The debug build is required for testing — do not use prebuilt binaries.

**Sanitizers (local, no CI required):** five harnesses cover the memory-safety /
UB / data-race hazard classes the code reviews track. `test-cpp-asan` and
`test-cpp-tsan` instrument the standalone C++ test binary; `test-ts-asan` and
`test-ts-tsan` instrument the `.node` addon and run the full vitest suite under a
preloaded sanitizer runtime (`run-sanitized-ts.js` handles the
`DYLD_INSERT_LIBRARIES` preload and forces vitest's threads pool, since a forked
worker would load the runtime too late). Each `test-*` script rebuilds the target,
so run `build-debug` afterward to return to the normal binary. `test-harness-asan` points the same instrumentation at the four `tools/`
harnesses instead of the suite — the adversarial paths, which ran uninstrumented
until August 6, 2026 — and `tools/gc-stress/run.mjs` is a fixture that hammers
handle and finalizer lifetimes under forced GC for either to watch. **No
sanitizer here sees a leak**: `detect_leaks=0` because LeakSanitizer does not
exist on macOS. Highest-value one is
`test-ts-asan` — the binding layer is where handle/finalizer use-after-frees live.
`test-ts-tsan` is a best-effort probe only (TSan can't see libuv/V8/Lua
synchronization, so a clean run is not a proof of race-freedom). Full details, the
preload mechanics, and the August 6, 2026 stress-test results are in
`docs/SANITIZERS.md`. These sanitizers do **not** catch the exception-abort class
(a `std::runtime_error` reaching `std::terminate`, e.g. CR-6 F1) — that is now
the job of `npm run exception-matrix`, the generated search for that class
(`docs/reviews/CODE-REVIEW-18.md`), alongside the CODE-REVIEW-6 behavioral matrix in the
suite. The judgment behind the four harnesses — what each is worth, and why
`test-ts-asan` is the one to run before shipping — is `docs/reviews/CODE-REVIEW-HISTORY.md`
Part III (archive; superseded on its "no more tooling needed" conclusion).

**Correctness harnesses (`tools/`).** Ten instruments the test suites do not replace; `tools/README.md` is the index. Nine ask whether an answer is *right*; the tenth, `crossing-cost`, asks what it *cost* — a cost defect returns the correct value slowly, so it is invisible to the other nine and to every sanitizer. Each is a directory named for what it does, with `run.mjs` as its entry point:

- `npm run check-invariants` — lists that used to live in comments (the
  `CallScope` classification, the `lua_next` traversal sites, the occupancy
  policy set, greppable counts, and every binding call to a `RunProtected`-backed
  core method scored guarded or not) are computed from the source and compared
  against `tools/invariants/expected.json`. The tenth, **`surface-census`**, is
  `CORRECTNESS.md` §15.6's trigger table computed rather than consulted: the
  options, value-taking entry points, inbound markers and host-callable Lua C
  frames are derived from the source and scored against the harness that covers
  each. `UNCLASSIFIED` means nobody has ruled on that piece of surface — a
  review item, not a defect. Its fifth census reads §15.6's **trigger table out
  of `CORRECTNESS.md`** and requires every row to be `COMPUTED`, `FAILS-CLOSED`
  or `MANUAL`-with-a-reason, so a trigger added in prose cannot go unruled. Its
  sixth derives every member that **retains a JS value** — transitively, so a
  container of a struct holding a `Napi::Reference` counts — and requires each to
  carry a `binding-balance` lifetime policy or a written exclusion. The
  eleventh, **`perf-claims`**, greps shipped documentation (`README.md`,
  `docs/*.md` and `types.d.ts`, which ships) for claim-shaped vocabulary and
  requires every hit to be measured by a `crossing-cost` cell or ledgered with a
  reason — scoped to sections describing shipped behaviour, since a census that
  flags estimates for code that was never built trains its reader to ignore it. **Do not silence one by inventing a ledger entry;
  either point an instrument at it or write down why it does not need one.** `tests/ts/invariants.spec.ts` runs the
  same checks, so drift is a red suite; re-freeze with `--update` so the change
  lands as a reviewable diff. **Do not "fix" a drifted invariant by editing the
  expected file without reading what moved** — the whole point is that the diff
  gets looked at.
- `npm run exception-matrix` — the exception-escape matrix. Runs its own controls
  first and refuses to proceed if they fail.
- `npm run oracle` — differential testing against stock `lua` from the same
  vcpkg port that supplies `liblua.a`. Requires `vcpkg install lua[tools]`; the
  oracle prints both Lua versions and warns if they differ. Checks whether an
  answer is *right* rather than whether nothing crashed, for the embedded VM and
  for values coming out of Lua. See `docs/DIFFERENTIAL-ORACLE.md`.
- `npm run roundtrip-matrix` — the other direction: 5 context modes × 19 entry
  points × 50 values, checking that a JS value survives the crossing *into* Lua
  and that all nineteen doors agree with each other — under `strictConversion`,
  `binaryStrings` and `tableAs: 'map'` as well as the defaults. **A mode must prove its option is
  in effect before its cells count**; a silently ignored option would otherwise
  report a clean column that searched nothing. See
  `docs/reviews/CODE-REVIEW-20.md` and `docs/reviews/CODE-REVIEW-23.md`.
- `npm run exec-parity` — the oracle's 1339-case corpus through each alternate
  execution door (`execute_script_async`, `execute_async`,
  `compile`→`load_bytecode`, `call_async`, `resume_async`), compared against
  `execute_script` — values *and* error messages. See
  `docs/reviews/CODE-REVIEW-21.md`.
- `npm run lifecycle-matrix` — 12 handle kinds held across `reset`, double
  reset, re-alias, GC, churn, release and `close`, one process per cell. A handle
  must stay valid or refuse; answering with another state's data is the defect it
  looks for. See `docs/reviews/CODE-REVIEW-22.md`.
- `npm run cross-context` — the context ↔ context boundary: a handle from one
  context must be refused by another, a plain value must cross unchanged, and
  neither context may observe the other. The boundary no earlier list contained
  (CR-22 F2). See `docs/reviews/CODE-REVIEW-22.md`.
- `npm run capability-matrix` — what a `libraries` / `allowBytecode` /
  `filesystem` configuration actually grants: an entry point must **work or
  refuse loudly**, never accept-and-retain (`LIMITATIONS.md` §8); each preset
  must load the libraries it claims and no others; and a bytecode door must
  refuse iff the guard is on. `filesystem: 'deny'` joined it on August 7, 2026,
  and the config caught `add_search_path` accepting a path `require` could never
  consult — accept-and-retain, found the moment the configuration existed. **Not an eighth boundary** — an axis across the seven; see
  `docs/CORRECTNESS.md` §15.1. It exists because `libraries` and `allowBytecode`
  were the two options no instrument could cover, and ruling on them found the
  E3 guard five doors short of its own claim. See
  `docs/reviews/UNSEARCHED-REGIONS-PLAN.md` §2.1.
- `npm run binding-balance` — the **binding's own** bookkeeping: do the
  `Napi::Reference`s the addon retains (callbacks, userdata wrappers, converters,
  searchers, class accessors, handlers) obey their declared lifetime policy, or
  strand an entry per cycle. The other side of the two existing leak checks,
  which measure the Lua registry only. Reads `info().bindingRefs`, the diagnostic
  accessor added for it; `surface-census`'s census F requires every retaining
  member to carry a policy, so a new one fails closed. **Not a boundary** — a
  resource-lifetime search; see `docs/CORRECTNESS.md` §15.1 and §15.10. Its four
  series exist because the first draft had one and reported seven leaks that were
  all its own: churning *fresh* registrations measures the API's contract, not a
  defect. Read `tools/binding-balance/policy.mjs` before extending it.

**Reviews are sweeps now, not read-throughs** (§15.9, August 6, 2026): a pass
declares the unsearched region it is aimed at, delivers an instrument plus a
ledger entry rather than a document, and proves the instrument can report dirty
before believing it clean. There are no more numbered general passes —
CODE-REVIEW-23 was the last.

**The review programme is closed** (August 4, 2026). All seven boundaries have a
generated search, the enumeration is derived from a stated criterion, and review
is now **triggered by new surface rather than by the calendar**. That trigger was
exercised for the first time on August 5, 2026 (`docs/reviews/INTEROP-PARITY-PLAN.md`)
and it found three defects review had not — see `docs/CORRECTNESS.md` §15.6. Before adding a
public entry point, a handle kind, a marker, an `ObjectWrap` subclass, a Lua C
callback frame, or bumping Lua, read **`docs/CORRECTNESS.md` §15** —
§15.6 maps each of those to the instrument to extend, and §15.7 is the
regression-run matrix. A **capability** option (a preset, a library, the
bytecode guard) is a `capability-matrix` config rather than a `roundtrip-matrix`
mode — a distinction §15.6's table conflated until August 6, 2026, which is why
two options sat uncoverable rather than merely uncovered. (`docs/reviews/CODE-REVIEW-HISTORY.md` is the reasoning trail for
CR-17–22 — history, not instructions.) **A new performance claim in shipped docs is a trigger too**
(added August 6, 2026, and the first row in that table that fires on documentation rather than
on code) — `perf-claims` reports `UNCLAIMED` until a `crossing-cost` cell measures it or a ledger
entry gives a reason. Five classes now fail closed on their own (a new tag, a
new `ObjectWrap`, a new occupancy policy, a bare `.toThrow()`, an unmeasured performance claim),
so the check happens whether or not anyone remembers.

All ten follow the same conventions, and `tools/README.md` states them with the
reason each exists — chiefly: **an exhaustive search that reports clean must
first demonstrate it can report dirty**, so each runs positive controls before
its real work and refuses to proceed if they fail; each checks per-cell vacuity,
not just per-run; and each keeps a ledger where every entry carries its reason
and a stale entry is reported rather than silently ignored. Read it before
extending any of them.

## Architecture

### Two-Layer C++ Design

The native code has a deliberate two-layer separation:

1. **Core layer** (`src/core/lua-runtime.h`, `src/core/lua-runtime.cpp`) — `lua_core::LuaRuntime` class. Pure C++ with no N-API dependency. Manages the Lua state (`lua_State*`), executes scripts, handles globals, userdata, metatables, coroutines, bytecode, and modules. Uses `std::variant`-based `LuaValue` type for all Lua↔C++ data exchange.

2. **Binding layer** (`src/lua-native.h`, `src/lua-native.cpp`) — `LuaContext` class (extends `Napi::ObjectWrap`). N-API wrapper that converts between `Napi::Value` and `lua_core::LuaValue`, manages JavaScript object references (`Napi::Reference`), and exposes the public API to JS.

Data flows: **JS ↔ N-API (LuaContext) ↔ Core (LuaRuntime) ↔ Lua state**

### Lua Reference Management

Lua objects that cross the C++ boundary (functions, coroutines, userdata, metatabled tables) are stored in the Lua registry via `luaL_ref` and wrapped in ref structs (`LuaFunctionRef`, `LuaThreadRef`, `LuaUserdataRef`, `LuaTableRef`). These use move semantics — `release()` calls `luaL_unref`. The binding layer wraps these in `*Data` structs (e.g., `LuaFunctionData`) that pair the ref with a `shared_ptr<LuaRuntime>` to ensure correct destruction order.

### Module Entry Point

`index.js` is an ES module loader that tries multiple paths (prebuilds → debug → release → node-gyp-build) to find the compiled `.node` binary. It exports the native module as default.

### Type Definitions

`types.d.ts` contains the full TypeScript API. `index.d.ts` re-exports it. Key types: `LuaContext`, `LuaValue`, `LuaTable`, `LuaTableRef`, `LuaFunction`, `LuaCoroutine`, `MetatableDefinition`, `UserdataOptions`.

### Test Structure

- **TypeScript tests:** `tests/ts/lua-native.spec.ts` (~2900 lines, 256+ tests) — comprehensive coverage of all features
- **C++ tests:** `tests/cpp/lua-native-test.cpp` — Google Test suite for `LuaRuntime` directly
- **Fixtures:** `tests/fixtures/*.lua` — Lua scripts used by tests

### Key Features & Their Implementation Locations

| Feature                         | Core (lua-runtime.cpp)                                                        | Binding (lua-native.cpp)                         |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| Script/file execution           | `ExecuteScript`, `ExecuteFile`                                                | `ExecuteScript`, `ExecuteFile`                   |
| Async execution                 | —                                                                             | `ExecuteScriptAsync` (uses `lua-async-worker.h`) |
| Globals                         | `SetGlobal`, `GetGlobal`                                                      | `SetGlobal`, `GetGlobal`                         |
| Userdata (opaque/proxy/methods) | `CreateUserdataGlobal`, `CreateProxyUserdataGlobal`, `SetUserdataMethodTable` | `SetUserdata`                                    |
| Metatables                      | `SetGlobalMetatable`, `StoreHostFunction`                                     | `SetMetatable`                                   |
| Coroutines                      | `CreateCoroutine`, `ResumeCoroutine`                                          | `CreateCoroutine`, `ResumeCoroutine`             |
| Bytecode                        | `CompileScript`, `CompileFile`, `LoadBytecode`                                | `Compile`, `CompileFile`, `LoadBytecode`         |
| Modules/require                 | `RegisterModuleTable`, `AddSearchPath`                                        | `RegisterModule`, `AddSearchPath`                |
| Reference tables                | `GetTableField`, `SetTableField`, etc.                                        | Exposed via JS Proxy in `CoreToNapi`             |
| Awaiting through every door     | `ResumeAsyncStep` (reports `awaited`), `CreateCoroutine`                      | `BeginAsyncRun`, `CallAsync`, `ResumeAsync`      |
| Coroutine close                 | `CloseCoroutine` (`lua_closethread`)                                          | `CloseCoroutine`                                 |
| Class statics / accessors       | `RegisterClass` (`statics`), `PropertyAccessDenied`                           | `RegisterClass`, `FindClassAccessor`             |
| Input / virtual files           | `SetInputHandler`, `SetFileReader`, `LuaIoRead`, `LuaDoFile`                  | `SetReadHandler`, `SetFileReader`                |

## Documentation

Detailed design docs live in `docs/`: `ASYNC.md`, `BYTECODE.md`, `FEATURES.md`, `REQUIRE.md`, `USERDATA.md`, `USERDATA-METHOD-BINDING.md`. Consult these before implementing a feature. **There is no roadmap document** — `FEATURE-HISTORY.md` and `BRIDGE-COMPARISON.md` read like backlogs but are *records*: every item in both is implemented apart from A5 (worker pool), which is a scope decision. New work should start from a concrete need, not from either survey.

**`docs/README.md` is the index.** Everything at the top level of `docs/` is current; everything in `docs/reviews/` is frozen and is never an instruction. Two rules are recorded there and are worth following: a **filename states what a document is, never what state the work is in** (four files were renamed on August 4, 2026 because their names claimed open work that was finished), and anything that stops being current gets a superseded banner in its first screen **and** moves to `docs/reviews/`.

## Conventions

- C++17 standard, compiled via node-gyp (`binding.gyp`)
- N-API version 8, with `NODE_ADDON_API_CPP_EXCEPTIONS` enabled
- Supported platform targets: **macOS arm64 and Windows x64** (`binding.gyp`
  conditions on `OS` and declares no arch list).
  **In practice this is a macOS project and there is no CI, and both are settled
  decisions — not gaps.** Do not raise the untested targets, the absence of CI,
  pre-push hooks, or `CODE-REVIEW-LEDGER` M5 as findings, risks, action items,
  or caveats on a "clean"/"complete" conclusion, and do not propose narrowing
  `binding.gyp` either. The review programme re-derived this every pass until it
  was closed on August 4, 2026; see `docs/CORRECTNESS.md` §14.
  Revocable by the owner, but nothing should reopen it implicitly.
- All public `LuaRuntime` methods that can fail return `ScriptResult` (`variant<vector<LuaPtr>, string>`) where the string variant is an error message
- `LuaValue` uses `std::variant` with `std::monostate` for nil — use the `LuaValue::from()` factory functions
- Max recursion depth for table conversion: `kMaxDepth = 100`
