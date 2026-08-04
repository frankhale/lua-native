# CODE-REVIEW-5

**Date:** July 19, 2026
**Scope:** Fifth pass. Primary target: the CODE-REVIEW-4 remediation commit
(`052099b`) — every one of its five fixes adversarially re-verified against the
tree, with particular attention to new defects the fixes themselves may have
introduced or left uncovered (the pattern every prior verification pass has
found). Secondary target: a fresh sweep of territory no earlier pass reviewed —
the CMake build path (`CMakeLists.txt`) and `binding.gyp`/`package.json`, the
type-definition surface (`types.d.ts`, `index.d.ts`) audited for parity against
the binding, and the test sources themselves
(`tests/cpp/lua-native-test.cpp`, `tests/ts/lua-native.spec.ts`,
`tests/fixtures/`). Line numbers refer to commit `052099b`.

**Method:** Full read of the `052099b` diff hunk-by-hunk against the
surrounding code, re-deriving the safety argument for each fix rather than
trusting the resolution table: raise/longjmp/GC-timing paths through the new
N1 sentinel ordering (including independent re-derivation of why the fix
deviates from CODE-REVIEW-4's recommended reorder), a mechanical scan of every
`RunProtected` thunk for surviving non-trivial C++ locals (N2), reentrancy and
double-read analysis of the N3 snapshot, and a systematic search for
conversion-discard paths the N4 collector scope does not span. Where a claim
could be exercised, it was: the N4-gap candidates were confirmed with a
GC-exposed leak harness (measured bytes/iteration against a fixed-path
control), and each secondary-sweep finding adopted below was spot-verified
against the sources before inclusion.

**Baseline:** 438 TypeScript tests and 178 C++ tests pass on `052099b`,
re-run during this review against the freshly built debug binary.

---

## Resolution status (July 19, 2026)

All findings resolved. Two additional defects were discovered *while* fixing
them and are recorded below as F11 and F12 (both fixed in the same pass).

After the fixes: **448 TypeScript tests** (up from 438 — ten new regression and
coverage tests) and **178 C++ tests** pass, plus the GC-exposed leak harness
(F1's two measured paths now flat) and a `tsc --strict --moduleResolution
nodenext` typecheck of the public type surface.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | `JsCallbackCollectorScope` now sweeps in its **destructor**, making every exit path self-cleaning, and a method-level scope was added at all five entry points (function-call trampoline, `ResumeCoroutine`, `SetMetatable`, `RegisterModule`, `CreateTableMethod`). Sibling conversions and post-conversion core-call failures are therefore covered. The two explicit sweep calls added in CR-4 became redundant and were removed. Measured: `set_metatable` path 55.9 → **-0.1** bytes/iter, multi-arg call path 56.1 → **0.1** bytes/iter (control unchanged at 0.0). Three regression tests added. |
| F2 | ✅ Done | `CMakeLists.txt` now defines `NODE_ADDON_API_CPP_EXCEPTIONS`, matching `binding.gyp`. Verified end-to-end: a CMake-built addon (Debug and Release) loads and correctly **throws** on a bad argument, which under the old `NAPI_DISABLE_CPP_EXCEPTIONS` define it would have swallowed. |
| F3 | ✅ Done | Added a `collect_node_gyp_dirs()` helper that expands the node-gyp cache with `file(GLOB)` (newest version first) into explicit candidate lists — `find_path`/`find_library` never see a wildcard again. Windows now locates `node.lib` from `<cache>/<version>/<arch>` with an actionable `npx node-gyp install` error if absent. Verified on macOS: `NODE_INCLUDE_DIR` now resolves to the node-gyp cache (`.../node-gyp/24.18.0/include/node`), which the old code could never match. **Caveat: the Windows path is structurally fixed but untested — no Windows machine was available.** |
| F4 | ✅ Done | The backward-compat test now binds the table to a global and asserts `t.a` is still `1` in Lua after the JS copy is mutated — it fails if plain tables ever regress to live proxies. |
| F5 | ✅ Done | `register_class` reserves the class name **before** reading any property off the definition (an RAII guard rolls the reservation back on every failure exit), so a hostile getter can no longer re-enter and half-merge a definition. `construct` is read once into a local, like `metamethods`; `readable`/`writable`/`methods` were given the same single-read treatment. Three regression tests added, including one asserting a reentrant registration is rejected and one asserting a rejected definition releases the name for retry. |
| F6 | ✅ Done | Added a `LuaInput` type — the JS→Lua direction — covering `undefined`, `Date`, `Map`, `Set`, `ArrayBuffer`/`ArrayBufferView`, and recursive containers, and applied it to every input position (`set_global`, handle `set`, `resume`, `create_table`, call/method/pcall arguments, `LuaCallbacks`, `MetatableDefinition`). Results keep the narrower `LuaValue`. `set_print_handler`'s argument is now optional, matching the C++. Verified by typechecking a consumer file that passes each previously-rejected type. |
| F7 | ✅ Done | The libnode search, `GLOB_RECURSE`-links-the-first-file-it-finds fallback, executable-as-rpath, and the dead `NODE_RUNTIME_LINK` branch are all deleted: Windows links `node.lib`, everything else uses runtime symbol resolution (`-undefined dynamic_lookup` on macOS). `lua_native_core` now receives the same `LUA_STATIC`/`NOMINMAX`/`WIN32_LEAN_AND_MEAN`/`_DARWIN_C_SOURCE` defines as the gyp build. Version floor lowered 3.31 → 3.20. |
| F8 | ✅ Done (documented) | New `docs/RELEASING.md` records the per-platform prebuild requirement, the legacy `lua-native.node` name to delete once real prebuilds exist, the `MACOSX_DEPLOYMENT_TARGET` un-deferral (CR-3 M5), and tarball/consumer smoke-test steps. Pack contents verified: 14 files, no `tests/` or `vendor/`. |
| F9 | ✅ Done | `execute_file` no-return now uses a new side-effect-only fixture and asserts `undefined`; the userdata-GC test exercises the refcount through a surviving alias; both `stripDebug` tests (TS and C++) assert strict `<` on a chunk with real debug info and check the stripped bytecode still runs; fixture paths use `fileURLToPath` (Windows-safe) and, in C++, a `RepoPath()` helper that walks up to the repo root — verified by running the gtest binary from `build/Debug`, where those tests previously failed; `CompileFileAndLoadBytecodeMatch` compares values, not just arity; the C++ suite dropped `unistd.h`/`mkstemp` for `std::filesystem` so it can compile for Windows. All three coverage gaps closed with new tests (busy guard across five sync entry points and two table-handle methods mid-worker, coroutine argument validation, non-primitive call arguments). |
| F10 | ✅ Done | Four conditional message assertions gained `FAIL()` sentinels; the unguarded `GetGlobal` deref gained `ASSERT_NE`; the spec converted to real ESM imports (`node:fs`/`node:path`/`node:os`, `fileURLToPath`-derived `__dirname`) so it no longer depends on vitest's CJS shims; the vcpkg library declaration went from six copies to two (one per gyp target); `prebuild` renamed to `prebuildify` (removing the npm lifecycle-hook trap) with doc references updated; `clean` now removes the `cmake-build-*` directories. The dead mac `cflags`/`ldflags` blocks were left as-is — they are inert and removing them risks disturbing a working build for no behavioural gain. |
| **F11** (new) | ✅ Done | **Discovered while fixing F5.** `LuaContext::RegisterClass` called `runtime->RegisterClass` with **no try/catch**, but the core builds inside `RunProtected`, which throws `std::runtime_error` on OOM under `maxMemory` or a raising `__newindex` on a `_G` metatable. That exception unwound across the N-API boundary and **terminated the process** — the H1 class, in a path every earlier pass missed. Now wrapped, surfacing a JS error; the reservation guard releases the name. Regression test added (confirmed it throws `not enough memory` instead of aborting). |
| **F12** (new) | ✅ Done | **Discovered while verifying F6.** `index.d.ts` imported from `'./types'` without an extension. The package is `"type": "module"`, so any consumer on TypeScript's `node16`/`nodenext` resolution got a hard `TS2834` error importing the package's types. Changed to `'./types.js'` (TS maps it to `types.d.ts`); a strict `nodenext` typecheck now passes clean. |

(M5 from CODE-REVIEW-3 remains deferred by decision; `docs/RELEASING.md` records
it as a release blocker.)

The original findings follow unchanged for reference.

---

## Verification of the CODE-REVIEW-4 remediation

Every resolution row in CODE-REVIEW-4's table was checked against the diff
that claims to implement it. Every row has matching, correct code. Detail:

| CR-4 # | Verdict |
|--------|---------|
| N1 | ✅ Correct — and the **deviation from the recommended fix was necessary**. CODE-REVIEW-4's recommendation ("move the increment to after `luaL_setmetatable`") is itself defective: a GC step inside `lua_newuserdatauv`/`luaL_setmetatable` can collect the name's last live closure, invoke `OnHostFnClosureCollected`, and erase the `reclaimable_host_fns_` entry — invalidating the held iterator before the deferred `++it->second` (UB), and leaving the about-to-be-built closure pointing at an erased entry. The shipped fix (build the sentinel inert-first, then *re-find*, arm, and increment last) closes the original OOM-strand flaw while avoiding both hazards. All five paths re-derived: ERRMEM at `lua_newuserdatauv` → count untouched; ERRMEM at `luaL_setmetatable` → inert metatable-less userdata, count untouched; `bad_alloc` at the string copy → slot still null, sentinel `__gc` no-ops, count untouched; ERRMEM at `lua_pushcclosure` after the increment → armed sentinel unwinds into the GC, whose `__gc` performs the matching decrement; entry erased mid-allocation → re-find fails, sentinel stays inert, and the closure surfaces the ordinary "Host function not found" error if ever called (defined, graceful degradation of an already-exotic race). The one `bad_alloc` source inside a Lua C frame (`LuaCallHostFunction`'s result push) was verified guarded (`lua-runtime.cpp:1376-1382`). |
| N2 | ✅ Correct. `mt_name`/`methods_key` hoisted above `RegisterClass`'s thunk; `AddSearchPath`'s appended string lives in the caller frame with only C++-throwing assigns inside the thunk. A mechanical scan of **every** `RunProtected` thunk body in `lua-runtime.cpp` found no remaining `std::string`/`std::vector` local declared inside a thunk. (Temporaries constructed by `throw std::runtime_error(...)` inside thunks are fine — a C++ throw unwinds normally into the trampoline's catch; no raise-capable Lua call executes while they live.) |
| N3 | ✅ Correct. The `metamethods` property, its key list, and each value are read exactly once into `mm_snapshot` (`lua-native.cpp:897-918`); registration at `:958-968` consults only the snapshot. Stored `Napi::Function` handles remain valid for the duration of the native callback's HandleScope, which covers every use. Two *adjacent* residuals in the same trust class remain — see F5. |
| N4 | ✅ Correct **within its scope** — the depth-0 collector/sweep, the nested-scope propagation, and the H2-drop sweep in `OnAwaitSettled` all verify, and the count-0 guard makes sweeping conservatively safe in every adversarial composition tried (type-converter reentrancy that pushes a collected name mid-conversion; hostile synchronous `then` re-entering `OnAwaitSettled`; a partial `PropagateToParent` under `bad_alloc`). Re-confirmed behaviorally: 0.0 bytes/iteration over 20,000 aborted `{ fn, Symbol }` conversions. **But the sweep does not span sibling conversions, and several binding entry points discard successfully-converted values outside any collector scope — the leak is still reachable and was measured. See F1.** |
| N5 | ✅ Correct. `LuaPrint`/`LuaIoWrite` trap the final `bad_alloc` with a raw-stdout fallback and correct stack hygiene; `run-tests.js` cleanup verified; the `RegisterFunction` store-after-write reorder and both binding-site reorders verified — including the residual window where `Napi::Persistent` could throw after registration, which degrades gracefully (`CreateJsCallbackWrapper` uses `find` and throws a clean "no longer registered" error, `lua-native.cpp:1384-1387`). |

---

## Overall assessment

The CODE-REVIEW-4 remediation is present and correct in all five rows, and the
one deliberate deviation (N1) is not merely defensible but required — the
recommendation as written would have introduced an iterator-invalidation UB.
The recurring pattern of these verification passes holds once more, in a
milder form: the genuinely new finding this pass (F1) is not a defect *in* the
new code but a **coverage boundary of it** — the N4 sweep is scoped to a single
top-level conversion, while five binding entry points discard converted values
from *outside* that scope. It was confirmed with a measured leak.

The fresh sweeps found the core/binding-facing surfaces in good shape (exact
.d.ts parity, sound packaging lists, sound fixtures) but turned up two real
problems in the never-reviewed CMake build path — it produces a behaviorally
different addon than the gyp build (opposite N-API exception mode) and cannot
work at all on Windows — plus one test that cannot fail on the exact behavior
boundary it exists to pin.

Severity distribution: no high findings; three medium (F1–F3), one
medium-low (F4), the rest low/nit.

---

## Findings

### F1. The N4 sweep does not span sibling conversions — five entry points still strand reclaimable entries, confirmed at ~56 bytes/iteration (medium) — ✅ DONE

The `JsCallbackCollectorScope` installed by `NapiToCoreInstance` covers exactly
one top-level conversion: a failure *inside* that conversion sweeps its own
mints. But when a binding method converts **several** values and then fails,
the earlier siblings were each converted in their own (already-closed) scope,
their names propagated to no parent — and the discarding catch/early-return
sweeps nothing:

- **Function-call trampoline** (`lua-native.cpp:497-505`): the per-argument
  loop; a later argument's conversion failure discards earlier converted args.
- **`ResumeCoroutine`** (`:2353-2359`): same per-argument loop shape.
- **`SetMetatable`** (`:1003-1008` per-entry conversion, and — the cleanest
  repro — `:1014-1019`: `SetGlobalMetatable` **validates the target global
  only after all entries are converted**, so `set_metatable("missing", …)`
  discards every entry).
- **`RegisterModule`** (`:1078-1083` / `:1089-1094`): identical shape.
- **`CreateTableMethod`** (`:1227-1229`, `:1235-1237`): per-element loops,
  plus a `CreateTableFrom` failure discarding all elements.

Exercised with a GC-exposed harness (20,000 iterations each):

| Path | bytes/iteration |
|------|-----------------|
| `set_metatable("noSuchGlobal", { payload: { fn: () => 1 } })` | **55.9** |
| `luaFn({ fn: () => 1 }, Symbol())` (multi-arg call, second arg fails) | **56.1** |
| control: `set_global("x", { fn: () => 1, bad: Symbol() })` (the fixed path) | 0.0 |

Same class and severity profile as the original N4 (bounded, one strand per
*failed* call, no UB), but unlike the residual CR-4 contemplated documenting,
these paths need no hostile input — a typo'd global name or a bad trailing
argument suffices.

**Recommendation.** The infrastructure already handles this: each top-level
conversion's wrapper calls `PropagateToParent()` on success, so a
**method-scope** `JsCallbackCollectorScope` at these five entry points
automatically accumulates every sibling's names. Install one at the top of the
conversion region and call `SweepUnpushedJsCallbacks(collector.names)` on each
failure exit (the catch blocks and the post-conversion core-call catches). The
count-0 guard already makes a sweep after a *partial* push safe, so the
`SetMetatable`/`RegisterModule` core-call catches can sweep unconditionally.
(A stale named `__mt_N_key`/`__module_N_key` entry from a mid-loop failure is
the known, separately-accepted L4-shape residual — unchanged by this.)

### F2. The CMake build compiles the addon in the opposite N-API exception mode from the gyp build (medium) — ✅ DONE

`CMakeLists.txt:392` defines `NAPI_DISABLE_CPP_EXCEPTIONS`; `binding.gyp:134`
(and the project convention) defines `NODE_ADDON_API_CPP_EXCEPTIONS`. The
binding is written for exception mode throughout — its error handling relies
on node-addon-api *throwing* `Napi::Error` from failed N-API calls into the
surrounding `try`/`catch`. Under `NAPI_DISABLE_CPP_EXCEPTIONS`, those calls
instead set a pending JS exception and **return**, so a
`npm run build-cmake-*` binary compiles cleanly but silently continues past
failed conversions with default-constructed values — a behaviorally different
addon from identical sources. The two build systems must agree; align CMake to
`NODE_ADDON_API_CPP_EXCEPTIONS` (and see F7 for the other per-target define
asymmetries).

### F3. CMake Node.js discovery is structurally broken; the CMake build cannot work on Windows at all (medium) — ✅ DONE (Windows path untested)

`CMakeLists.txt:104-120` (headers) and `:239-272` (libraries) pass literal
glob patterns (`"$ENV{HOME}/Library/Caches/node-gyp/*/include/node"`,
`"$ENV{APPDATA}/node-gyp/Cache/*/x64"`) to `find_path`/`find_library`, which
treat `PATHS` entries literally — every node-gyp-cache entry is dead. Lines
`:246-257` also use `$(Configuration)`, an MSBuild macro with no meaning in
CMake. Consequences: on Windows (a declared target) no path ever matches,
`C:/Program Files/nodejs` ships no `node.lib`, and configuration dies at the
`FATAL_ERROR` (`:377`) — there is no Windows link strategy at all; on macOS
without Homebrew node (nvm-only), header discovery fails despite a populated
node-gyp cache. Fix by expanding candidates with `file(GLOB ...)` before the
`find_*` calls, or drop discovery linking on macOS entirely in favor of the
already-present `-undefined dynamic_lookup` fallback, and implement a real
`node.lib` strategy for Windows.

### F4. A backward-compat test cannot fail on the behavior it pins (medium-low) — ✅ DONE

`tests/ts/lua-native.spec.ts:1630-1638`
(`plain table still deep-copies (backward compat)`): after `result.a = 999`
the test asserts nothing — the two earlier `expect`s pass whether plain tables
deep-copy or return live proxies, which is precisely the boundary the test
exists to guard (its metatabled sibling at `:1619-1628` does verify liveness
through Lua). If plain-table conversion regressed to live references, the
suite stays green. Add
`expect(lua.execute_script('return t.a')).toBe(1)`-style read-back through a
named global, mirroring the sibling test.

### F5. `register_class` residuals in the N3 trust class: `construct` double-read, and reentrancy bypasses the duplicate-name rejection (low) — ✅ DONE

Two hostile-definition-object paths survive the N3 snapshot (both
pre-existing, neither introduced by the fix):

- **`construct` is still read twice** (`lua-native.cpp:874` validation,
  `:880` use). A getter returning a function first and a non-function second
  passes validation, then `As<Napi::Function>` wraps the non-function
  unchecked. Degradation is graceful (the constructor call fails with a
  function-expected error at `new` time) — integrity holds, unlike the M7
  hazard N3 closed — but the validation is bypassable. Snapshot it once,
  like `metamethods`.
- **Any property getter on `def` can re-enter `register_class` with the same
  name** before `registered_classes_.insert` runs (`:970`). The reentrant call
  passes the duplicate check (`:883-888`), registers fully, and when the outer
  call resumes, `luaL_newmetatable` silently returns the existing metatable
  and the outer definition half-merges over it — exactly the L7 hazard, via
  reentrancy instead of a second call. Reserving the name (inserting before
  the property reads, erasing on the failure exits) closes it.

### F6. `LuaValue` input typing omits documented, supported types (low) — ✅ DONE

`types.d.ts:19-29` — the `LuaValue` union excludes `Buffer`, `TypedArray`,
`Date`, `Map`, `Set`, and `undefined`, all of which the binding converts
JS→Lua (`lua-native.cpp:46-83`) and which the `register_type_converter` JSDoc
itself advertises as built-in. TypeScript consumers must cast to pass a
`Buffer` or `Map` to `set_global`/call arguments. The union currently
conflates "what Lua returns" with "what you may pass in"; add a wider
`LuaConvertible` input type (or widen the union) for the JS→Lua direction.
Everything else in the .d.ts surface is in exact parity: all 26 native
methods present under correct names, arities matching the C++ validation,
return shapes (`PcallResult`, `CoroutineResult`, handle methods) and all
JSDoc claims spot-verified against the implementation (library lists,
`maxMemory`/`maxInstructions`, bytecode default chunk name).

### F7. CMake secondary defects: mismatched linking strategy, missing defines, inflated version floor (low) — ✅ DONE

- `CMakeLists.txt:140-152`: preferring a discovered Homebrew `libnode` over
  `-undefined dynamic_lookup` hard-binds the addon to a dylib that need not
  match the runtime Node; `:174-187` `GLOB_RECURSE`-links the *first* `.a`/
  `.dylib` found in an arbitrary cache directory, whatever it is;
  `INSTALL_RPATH` is set to an executable *file* path (`:339`, `:371`), which
  is a no-op; the `"NODE_RUNTIME_LINK"` sentinel branch (`:332`) is dead code.
- `lua_native_core` (`:295-301`) gets none of the gyp build's defines — no
  `LUA_STATIC`, no `_DARWIN_C_SOURCE`, no `WIN32_LEAN_AND_MEAN`/`NOMINMAX`
  (those are applied only to the other targets, `:398-407`) — so the same TU
  compiles under a different preprocessor environment per build system.
- `cmake_minimum_required(VERSION 3.31)` (`:1`) exceeds anything the file
  uses (`CMAKE_MSVC_RUNTIME_LIBRARY` needs 3.15); stock CMake 3.28–3.30
  installs fail to configure for no reason.

### F8. Prebuilds cover one of three declared platforms as committed (low, state-of-tree) — ✅ DONE (documented in docs/RELEASING.md)

`prebuilds/` contains only `darwin-arm64`. On win32-x64 and darwin-x64 a
published-package install falls back to `node-gyp rebuild`, which requires
`VCPKG_ROOT` plus a vcpkg-installed Lua on the consumer's machine
(`binding.gyp:17,21`) — i.e., install fails without a dev-style setup. Fine if
prebuilds are produced at release time; noted so the release checklist covers
it. The checked-in binary's non-prebuildify name (`lua-native.node`, not
`*.napi.node`) was verified to still match `node-gyp-build`'s resolver, but
`npm run prebuild` will deposit a second, differently-named binary beside it.

### F9. Test-suite weaknesses (low) — ✅ DONE

Beyond F4, verified in the sources:

- `execute_file` "no return value" test (`lua-native.spec.ts:2293-2301`) runs
  a fixture that *does* return a value and duplicates the assertion at
  `:2263`; the binding-layer undefined-return path is untested.
- `userdata cleanup on GC` (`:1317-1326`) asserts only `handle == nil` after
  collection — trivially true even with the refcount machinery broken (real
  coverage lives only in the C++ suite).
- The `stripDebug` tests (`:2769-2774`, `:2908-2913`; and
  `lua-native-test.cpp:2359-2367`) assert `stripped.length <= full.length`,
  which a no-op option satisfies; assert strict `<` on a chunk with locals.
- `new URL(...).pathname` for the fixtures dir (`:2249`) breaks on the
  declared Windows target (`/C:/...`); use `fileURLToPath`.
- `CompileFileAndLoadBytecodeMatch` (`lua-native-test.cpp:2546-2561`) compares
  only result *counts*, not values, despite the name.
- Four C++ tests use CWD-relative fixture paths (`:2259`, `:2388`, `:2549`,
  `:2553`) — fine under `npm run test-cpp`, confusing failures from IDE/build
  dirs.
- The C++ test file is POSIX-only (`<unistd.h>`, `mkstemp` — `:7`,
  `:1774-1778`) and cannot compile for the declared Windows target even
  though `run-tests.js`/CMake anticipate a Windows test binary.

**Coverage gaps** (each public method has at least one test; behaviors with
none): (1) no test invokes any *synchronous* method or table-handle trap while
an async run is in flight — the entire `RejectIfBusy`/`RejectIfWorkerBusy`
guard surface, the most defect-prone reentry boundary in the binding, is
untested; (2) `create_coroutine`/`resume` argument-validation error paths;
(3) calling returned Lua functions from JS with non-primitive arguments
(every existing test passes only numbers).

### F10. Nits — ✅ DONE

- `binding.gyp`: the vcpkg library is specified three times (`:20-27`
  `libraries` + `link_settings.libraries`, plus the `OS=='win'` block `:31`;
  same pattern in the test target `:159-176`) — harmless duplication, but one
  edited copy silently diverges. The `cflags*`/`ldflags` blocks inside
  `OS=='mac'` conditions (`:109-121`, `:248-260`) are ignored by the Xcode
  settings path (including an Apple-invalid `-static-libstdc++` that survives
  only because it is never applied); the Linux-only top-level `cflags_cc` of
  the *test* target omits `-fexceptions`, which would break a hypothetical
  Linux build.
- `package.json`: `prebuild` is an npm lifecycle hook name — adding a `build`
  script later would silently run prebuildify before it; `clean` does not
  remove the `cmake-build-*` directories present in the tree.
- C++ tests: the `try/catch`-without-`FAIL()` message assertions
  (`lua-native-test.cpp:819-823`, `:834-838`, `:2052-2056`, `:2160-2163`)
  silently skip if the call stops throwing (throw-ness is separately pinned by
  paired `EXPECT_THROW`s, so only message coverage is fragile);
  `:3103-3116` pins Lua's registry free-list reuse order (upgrade-fragile);
  `:2382-2383` dereferences a `GetGlobal` result without the `ASSERT_NE`
  guard used elsewhere.
- TS spec: CJS `require()`/`__dirname` usage inside the ESM spec
  (`:2514-2517`, `:2545`, `:2555-2559`, `:2596-2598`, `:2716-2719`) works
  only via vitest's module-runner shims; the `__newindex as function` test
  (`:1512-1528`) sets up an `intercepted` global it never asserts on
  (weakened, not dead).
- `set_print_handler`'s .d.ts signature requires an explicit `fn | null`
  argument while the C++ treats any non-function (including no argument) as
  "clear"; `resume`'s declared `LuaCoroutine` parameter is stricter than the
  duck-typed runtime check — both are safe-direction mismatches.

---

## Verified and rejected (spot-checks that held up)

Adversarial suspicions pursued against the new code and refuted:

- **CR-4's N1 recommendation vs. the shipped deviation**: independently
  re-derived; the recommendation's ordering is unsound (GC-driven map erasure
  during the sentinel allocations invalidates the held iterator and can erase
  the entry the closure is being built against). The shipped
  pin-free/re-find ordering is the correct one. The deviation was disclosed in
  the resolution table — the tracking-hygiene failure of earlier passes does
  not recur.
- **Sweep-after-partial-push safety**: every composition where a collected
  name gets pushed before a sweep (type-converter JS calling `set_global`
  mid-conversion; `OnAwaitSettled`'s collector alive across `DriveAsync`)
  resolves safely — a pushed name has count ≥ 1 (skipped) or its entry is
  already gone (no-op). `EraseReclaimableIfUnpushed` is idempotent, so the
  double-sweep reachable through a partially-propagated parent under
  `bad_alloc` is also harmless.
- **Nested collector scopes**: the save/restore chain is exception-safe RAII;
  reentrant top-level conversions (converter callbacks, hostile synchronous
  `then` re-entering `OnAwaitSettled`) each sweep only their own mints.
- **`RegisterCallbacks` is *not* an F1 site**: it converts and pushes per
  iteration, so a later key's failure discards nothing already converted.
  `Pcall` does no JS→Lua conversion. The userdata property setter and table
  traps convert exactly one value per call — covered by the wrapper's own
  scope.
- **`LuaCallHostFunction` result push**: guarded (`lua-runtime.cpp:1376-1382`),
  so the N1 fix's `new std::string` cannot throw a C++ exception through a
  Lua C frame on the host-return path; the pending-error push is likewise
  guarded (`:1343`).
- **`Persistent`-after-register window in the N5 reorder**: degrades to a
  clean "JS callback no longer registered" error via the wrapper's `find`
  guard — no UB, no silent misbehavior.
- **Thunk scan**: no `RunProtected` thunk in the tree declares a non-trivial
  C++ local (mechanical scan), confirming N2 is complete, not just fixed at
  the three named sites.
- **Type-definition surface**: all 26 `InstanceMethod` exports present in
  `types.d.ts` under correct names with matching arities; return shapes and
  JSDoc claims verified against the implementation; `index.js`/`index.d.ts`
  export shape consistent. (Sole exception: F6.)
- **Packaging lists**: every npm `files` entry exists; `node-addon-api`/
  `node-gyp-build` correctly in `dependencies`; the `skip_test` default
  correctly keeps the gtest target (whose inputs are not shipped) out of
  consumer installs; gyp test-target source/include paths all exist.
- **Test-suite async hygiene**: every `.rejects`/`.resolves` is awaited; the
  throw-sentinel try/catch patterns all fail correctly when nothing throws;
  the `is_busy`-immediately-after-`execute_async` test is race-free because
  the binding sets the busy flag synchronously before queuing; cancellation
  margins adequate; all referenced fixtures exist and match, with no orphans;
  vitest's default include picks up the spec without a config file.

---

## Suggested priority order

1. **F1** — one RAII scope + sweep-on-failure at five binding entry points;
   the infrastructure (`PropagateToParent`, count-0 guard) already does the
   hard part. Restores the M2/N4 guarantee for the last measured leak paths.
2. **F2** — one-line define fix in `CMakeLists.txt`; until then every
   `build-cmake-*` binary mishandles errors by construction.
3. **F3** — either repair CMake's Node discovery (`file(GLOB)` + a real
   Windows link strategy) or explicitly scope the CMake path to
   macOS-with-Homebrew and say so; as written it advertises a Windows build
   it cannot produce.
4. **F4 / F9** — the compat-test assertion is a two-line fix; the remaining
   test items are mechanical and independently landable.
5. **F5** — snapshot `construct`; reserve the class name before the property
   reads.
6. **F6–F8, F10** — opportunistic; F8 belongs on the release checklist rather
   than in code.

(M5 from CODE-REVIEW-3 remains deferred by decision and is intentionally
absent from this list.)
