# WASM-TARGET-PLAN

> **Superseded November 25, 2026 — executed, closed, and frozen.** All seven
> closing conditions in §6 are met and this file is a record, not an
> instruction. What outlived it:
>
> - **[`../WASM.md`](../WASM.md)** — the current reference for the target,
>   including the closed list of permitted differences that was §1.1 here.
>   `tools/wasm-ledger.mjs` reads that list from there now.
> - **[`../CORRECTNESS.md`](../CORRECTNESS.md)** §14's amendment, §15.4, the
>   two rows added to §15.6, and the WASM lines of §15.7.
> - `CLAUDE.md`'s "Two bindings" section, which carries the rule that a change
>   to one binding is a change to both.
>
> Paths in the body are as they were when each part was written: this file was
> `docs/WASM-TARGET-PLAN.md`, and "§1.1" is the table now in `WASM.md`.
>
> **Still open with the owner**, none of them a closing condition, all listed
> in `WASM.md`: the Safari worker's stack (Phase 4), state the whole module
> shares (slice 2, decision 2), and `DataView` (slice 7, decision 5).
>
> Read it for the decisions (D0–D7), the as-built record of each slice and
> phase, and the scored predictions in §7.

**Written November 22, 2026; revised November 24, 2026. Phases 0 and 1 were
run on November 24 and their record is in §2.3, §2.4, §3.1 and §4. The build
target and the test switch exist, and **all seven slices of the binding
(Phase 2) are written: every method the native binding has, this one has.**
Under Node, 1,181 of the suite's 1,190 tests pass on it and all ten harnesses
run on it with the native totals; the nine tests that do not pass are each
accounted for under "Slice 7 — as built", which also lists what the owner still
has to decide. **Phase 3 was finished on November 25:** every run now proves
by observation which binding it is on, and the nine tests are in
`tools/wasm-ledger.mjs` with six further differences beside them, judged by
`npm run verify-wasm`. Seven of its entries were not rows of §1.1; the owner
ruled on all seven the same day (Phase 3, "The rulings"): five became rows, and
the 32-bit limits were ruled a defect and fixed in the core, which is the
fourth exception to D7 and brought a native defect with it.
**Phase 4 was done the same day:** `browser.js`, the `exports` map and a
24-cell smoke set that passes on the main thread and in a Web Worker in
Chromium and in Safari; Gecko was not run. Its finding is how little stack a
Safari worker has (Phase 4, "As built"). Slice 5 found two more defects in
the *native* binding; the owner had them fixed in a separate session the same
day, the third exception to D7, and the port follows. Slice 3 also found a crash in the *native* binding, recorded
under "Slice 3 — as built"; the owner had it fixed in the native binding the
same day, the second exception to D7.
Slice 2 also found that the JavaScript engine's own call stack is a hazard on
this target that it is not natively; the record, and three decisions it leaves
for the owner, are under "Slice 2 — as built".**
Every claim below is either measured in this repository (§2.1), read from the
Emscripten documentation on November 24 (§2.2), measured in Phase 0 (§2.3) or
Phase 1 (§2.4), or listed as an unknown (§3).

One goal: **two targets with one user API.**

| Target | Loaded by | Binding | Status |
|---|---|---|---|
| Native addon | Node, through `index.js` | N-API (`src/lua-native.cpp`) | Exists. Not changed by this work, apart from the defects it found there and the owner had fixed (D7). |
| WASM module | A web browser, through a new `browser.js` | **No N-API.** A second binding written for the browser. | This plan. Phases 0 to 4 done: the binding is written, verified under Node with its differences ledgered, and run in two browser engines. Phase 5 is not started. |

**What changed on November 24.** The first version of this plan recompiled the
existing binding against emnapi, an implementation of Node-API on Emscripten.
The owner has ruled that out: the browser target carries no N-API layer, real
or emulated. That removes the premise the first version rested on ("the binding
is recompiled, not rewritten") and replaces it with the largest item in this
plan — a second binding (D2). The core layer, the Lua build, the verification
strategy and the single-threaded default carry over.

This plan is held to the bar the earlier plan documents set (`docs/README.md`):
items traceable to something measured, a closing condition that can be checked
rather than felt (§6), and dated predictions so execution can be scored (§7).

---

## 0. The shape of the work in one screen

| Piece | Approach |
|---|---|
| Compiler | Emscripten 7.0.1 (`em++`), driven by a new Node script. node-gyp cannot target WASM. |
| Flags | WASM-native exceptions and WASM-native `longjmp` on every object, Lua's included. Phase 0 showed the other mode is unusable (§2.3). |
| Lua 5.5 | `liblua.a` for `wasm32-emscripten` from an overlay triplet. Phase 0 tried vcpkg's stock triplet first and it is not usable (D5). |
| Core layer (`src/core/`) | Recompiled unchanged. It has no N-API dependency. |
| Native binding (`src/lua-native.{h,cpp}`) | **Not compiled for WASM and not edited** (D7). |
| WASM binding (`src/wasm/`) | **New.** C++ against Embind's `emscripten::val`, plus a small JS shell (D2). Implements the API in `types.d.ts`. |
| Parity | Not argued — run. The existing vitest suite and all ten harnesses, pointed at the WASM module **running under Node**, then a browser smoke test. |
| Threads | **None in the first cut** (D3). |
| Shipping | A `browser` entry beside `index.js`; the `.wasm` is built locally and published, never committed — the same rule as `prebuilds/`. No new runtime dependency. |

---

## 1. Decisions

### D0 — this is a scope change, and it is the owner's (decided)

`docs/CORRECTNESS.md` §14 records "macOS-only" as a closed decision that only
the owner may reopen, and only deliberately. This plan is that deliberate act,
and it is **narrow**: it adds one target, WASM in a browser. It does not reopen
Windows coverage, and it does not reopen CI — no step below proposes automation
that runs without someone running it. Phase 5 writes the amendment into §14 and
§15.4 so the next reader does not mistake the WASM target for drift.

### D1 — no N-API in the WASM target (decided November 24, 2026)

The browser module does not link emnapi, does not include `napi.h`, and ships
no N-API runtime. Node keeps loading the native addon exactly as it does today.
Consequence, stated once so it is not rediscovered: **there are now two
bindings over one core, and keeping them in step is permanent work**, not a
one-off port. §8 lists what limits that.

### D2 — how the WASM binding is written (decided November 24, 2026: C++ on `emscripten::val`, thin JS shell)

Three shapes were considered.

- **A. A second C++ binding against `emscripten::val` (chosen).**
  `src/wasm/lua-wasm.{h,cpp}` mirrors the native binding function for function:
  the same conversion rules, the same guards, the same order of checks. `val`
  is a refcounted handle to a JS value (§2.2), which is the role
  `Napi::Value` / `Napi::Reference` play today. A JS shell
  (`src/wasm/shell.js`) holds only what has to be JavaScript: the `LuaContext`
  and `SharedTable` class objects, the table-ref `Proxy` handlers, the
  `FinalizationRegistry`, the Promise plumbing, and the trampoline in the rule
  below.
- **B. A flat C ABI over the core, with the binding written in JavaScript.**
  Rejected: `LuaValue` is a C++ variant tree, so every crossing would need a
  third representation of it, and the binding's guards would move into a
  language that `tools/cpp-scan.mjs`, `check-invariants` and `npm run lint`
  cannot read.
- **C. Refactor the native binding into a host-neutral layer with N-API and
  `val` back ends.** Rejected for now: it would give parity by construction,
  but it rewrites 8,764 reviewed lines, moves every row in every invariant, and
  breaks this plan's promise that the native target is unchanged. Worth
  reconsidering only after shape A exists and the duplicated parts can be
  counted rather than guessed.

Two rules for shape A, both for the instruments' sake:

1. **No policy lives only in the JS shell.** Liveness, busy, re-entrancy and
   cross-context refusals are decided in C++, as they are natively, so the
   invariants can be pointed at them (Phase 5).
2. **A JavaScript exception never unwinds through a WASM frame.** Every call
   from C++ into JS goes through one trampoline in the shell that catches and
   returns a status plus the thrown value. This is needed regardless of U3's
   answer: a JS exception that skipped a Lua C frame would leave the Lua state
   mid-call, which is the class `exception-matrix` exists to find.

### D3 — the two off-thread doors (decided November 24, 2026: same signature, run on the calling thread)

`execute_script_async` and `execute_file_async` are the only two uses of
`Napi::AsyncWorker`. A real thread in a browser needs `SharedArrayBuffer`,
which needs every embedding page served with the two cross-origin isolation
headers (§2.2).

- **Run on the calling thread (chosen).** Both doors keep their signature,
  return a Promise, run the script to completion, and settle it. They keep the
  native rule that a JS callback called from such a script is refused with the
  same message, so a script behaves identically on both targets. **The one
  difference:** the page's thread is occupied while the script runs, so
  `cancel()` cannot be called during it (`timeout` still applies — U8). A page
  that must stay responsive hosts the VM in a Web Worker. This is the option
  that keeps the user API the same.
- **Refuse loudly (not taken).** Both doors throw "not available in the WASM
  build". Honest about the thread, but it is an API difference a caller must
  branch on.
- **Threaded.** Deferred to Phase 6 as its own decision. It is §15.6's "a new
  threading mode" row, which says *everything* gets re-run.

The coroutine-driven doors (`execute_async`, `call_async`, `resume_async`) use
no thread and are expected to work unchanged (§7 prediction 4).

### D4 — bytes (decided November 24, 2026: `Uint8Array` on WASM, declared in a `browser.d.ts`)

`compile()` and `compile_file()` return a Node `Buffer` natively, and browsers
have none. On WASM they return a plain `Uint8Array`, **under Node as well as in
a browser**, so the behaviour that is verified is the behaviour that ships.
`load_bytecode()` and every other byte-taking door accept any `Uint8Array`,
which already includes `Buffer`. `types.d.ts` is not changed — narrowing it
would take `Buffer` methods away from Node consumers. A `browser.d.ts`
re-exports it with those signatures restated.

### D5 — where the WASM `liblua.a` comes from (decided by Phase 0, November 24, 2026: an overlay triplet)

The owner's direction was to try vcpkg's **stock** `wasm32-emscripten` triplet
first and write an overlay only if it proved necessary. Phase 0 tried it. **It
is not usable**, and the reason is not the one anyone guessed (§2.3 has the
measurements):

- The stock library builds and installs without trouble, and its objects
  reference the JavaScript-based `longjmp` runtime — what the stock triplet's
  flags predict.
- That ties the whole module to `-fexceptions`. Under `-fwasm-exceptions` it
  does not link (cell B).
- Under `-fexceptions` it links, and 285 of the 286 C++ tests pass. But in that
  mode **Lua's `longjmp` through a C++ frame that has a destructor or a `catch`
  block does not behave as it does natively**: the error value is lost, and
  code after the raising call runs. One test aborts the process because of it
  (cell A). It held at every optimisation level tried, and it belongs to the
  exception mode rather than to how the library was built. No other flag
  combination on the stock route was tried.
- The overlay — the stock triplet plus `-sSUPPORT_LONGJMP=wasm` for C and C++ —
  with the module on `-fwasm-exceptions` passes all 286 tests and matches
  native on every probe result but one (cell C).

So the library comes from `triplets/wasm32-emscripten.cmake`, which shadows the
stock name for the reason `triplets/arm64-osx.cmake` does, and from an
`npm run vcpkg-lua-wasm` script modelled on `vcpkg-lua`: it removes first,
passes `--overlay-triplets`, sets `EMSCRIPTEN_ROOT`, and prints proof of its
own result — the `emcc` version and which `longjmp` runtime the library
references.

The macOS trap applies here too and is worth restating: **the overlay is not
sticky**, and a bare `vcpkg install lua:wasm32-emscripten` quietly produces the
library that does not work. Unlike macOS the consequence is loud — the module
will not link against it.

Compiling the Lua sources directly in the build script was the second fallback
and was not needed.

### D6 — package shape (decided November 24, 2026: same package, conditional export)

One package. `package.json` gains an `exports` map whose `.` entry resolves to
`browser.js` (types `browser.d.ts`) under the `browser` condition and to
`index.js` (types `index.d.ts`) otherwise. `main` and `types` stay, for
resolvers that do not read `exports`. A second package (`lua-native-wasm`) was
the alternative and is not taken.

**The accepted consequence:** the package has only `main` today, and an
`exports` map blocks every deep import it does not list. The package publishes
four things — `index.js`, `index.d.ts`, `types.d.ts` and `prebuilds/` — so the
map also lists `./types.d.ts` and `./package.json`, which leaves `prebuilds/`
paths as the only ones that stop resolving. The release note says so.

### D7 — the native target is left exactly as it is (decided November 24, 2026)

The WASM target is **added beside** the Node addon. Nothing the addon is built
from, loaded through or typed by is edited:

| Not edited | What it is |
|---|---|
| `src/lua-native.{h,cpp}`, `src/lua-async-worker.h` | the N-API binding (defects fixed on the owner's word: the table iterator, "Slice 3 — as built", and the async doors, "Slice 5 — as built") |
| `src/core/lua-runtime.{h,cpp}` | the core, shared by both targets (one `#include` added on the owner's word, below; and on November 25 the three limits widened to 64 bits and the timeout deadline made to saturate, Phase 3, "The rulings") |
| `binding.gyp`, `CMakeLists.txt` | the native builds |
| `index.js`, `index.d.ts`, `types.d.ts` | the loader and the public types |
| `prebuildify` and the `prebuilds/` layout | how the addon ships |

What does change, and why none of it changes what a Node consumer gets:

- **`package.json`** gains the `exports` map (D6), new entries in `files`, and
  new scripts. Under Node the map resolves to the same `index.js` that `main`
  names today. D6 records the one visible effect.
- **The 13 places the suite and harnesses import `index.js`** (one spec file,
  twelve under `tools/`) import a development-only loader instead (Phase 1).
  None of them is published.
- **`.gitignore`** gains `build-wasm/`, and **`triplets/`** gains a second
  overlay beside the macOS one. Neither is read by the native build.
- **`tools/invariants/`** learns to read a second binding (Phase 5). The frozen
  answers for the native binding must not move as a result.

An earlier draft of this plan added a `LUA_NATIVE_TARGET` branch to `index.js`
and an `info().target` field to the native binding. Both are withdrawn: each
was an edit to the shipped Node module made for the benefit of the other
target.

**The one way this could fail, and the rule if it does.** The core is shared,
so if Phase 0 shows it needs a source change to compile or pass as WASM, that
change is not made quietly. Phase 0 stops and reports it, and it goes ahead
only on the owner's word.

**The rule fired, and the owner ruled (November 24, 2026).** The core needed
`<cstdlib>` and the C++ test file needed `<algorithm>` (§2.3). Phase 0 worked
around both from the command line and edited nothing. The owner chose to **add
the two `#include` lines** rather than have the WASM build script force-include
the headers:

- `src/core/lua-runtime.cpp` gains `#include <cstdlib>`.
- `tests/cpp/lua-native-test.cpp` gains `#include <algorithm>`.

No behaviour changes on either target; the native build had been relying on
another header to supply them. Checked the same day on the native target:
`npm run build-debug`, `npm run test-cpp` (286 of 286), `npm run lint` (0
findings) and `npm run check-invariants` (all match, nothing re-frozen). This
is the **one permitted edit** to a path in the table above, and closing
condition 3 names it. The WASM build passes no `-include` flags.

### 1.1 What "the same API" means here

`types.d.ts` is the contract and the existing suite is its test. The target is
that a program written against it runs on either module, with the differences
below and no others. Each is a row in the Phase 3 ledger; a difference that is
not on this list and not in the ledger is a defect.

| Difference | Why it cannot be removed |
|---|---|
| Bytecode is a `Uint8Array`, not a `Buffer` (D4) | Browsers have no `Buffer`. |
| The two off-thread doors do not leave the calling thread (D3) | No thread without cross-origin isolation. |
| Files are virtual: `execute_file`, `compile_file` and `require` see an in-memory filesystem and `setFileReader`, not a disk | A page has no disk. |
| `os` and `io` behave as Emscripten implements them (U7) | No process, no environment. |
| Finalizers run in a later task than a GC (U5) | `FinalizationRegistry` semantics. |
| Exhausting the JavaScript engine's stack while Lua is running ends the context | Nothing inside the module can catch the engine's `RangeError`. The shell detects it and the context refuses from then on; natively it is an ordinary error. |
| The key order of a Lua table converted to a plain object differs | The core holds it in a hash map. The order is unspecified on both targets and follows the platform's string hash, which is not the same on a 64-bit build and a 32-bit one. |
| Functions the binding hands out are strict JavaScript functions: no own `arguments` or `caller`, and `String(fn)` shows source | An ES module cannot define any other kind without `new Function`, which a page's content security policy may forbid. |
| The `stack` of an error the binding constructs begins in the binding | The error is constructed inside the module, and `stack` is the engine's own text. The message, the name and the type are the same. |
| An object forged with `Object.create(Promise.prototype)` is taken for a promise | JavaScript can ask only whether the prototype is on the chain. The engine's own test is reachable only through `then`, which has effects. |

The last five rows were added on November 25, 2026, on the owner's ruling
(Phase 3, "The rulings"). Each had been found during the port and recorded
slice by slice; none was on this list until then.

`import lua_native from 'lua-native'` stays the same line on both targets:
`browser.js` uses top-level `await` to instantiate the module before exporting.

---

## 2. What is known

### 2.1 Measured in this repository

November 22, 2026 unless marked † (November 24).

| Fact | Where |
|---|---|
| Core layer is 6,649 lines and includes only the standard library and `lua.hpp` | `src/core/lua-runtime.{h,cpp}` |
| Native binding is 8,764 lines, all node-addon-api | `src/lua-native.{h,cpp}`, `src/lua-async-worker.h` |
| † 1,133 lines of the binding name a `Napi::` type; nothing in it can be reused on a target without N-API | `grep -c "Napi::"` over the three files |
| † The public surface is 44 `LuaContext` methods, 3 `SharedTable` methods, `init` and `createSharedTable`, declared in 2,606 lines of types | `src/lua-native.cpp:1170–1214`, `:949`, `types.d.ts` |
| † What the second binding has to reproduce beyond value conversion, counted as mentions of each type: 68 of the persistent-reference types, 10 of `External`, 17 of `Promise`, one weak reference, a `Proxy` built from C++, and two `ObjectWrap` classes identified by brand | `src/lua-native.cpp` (the `Proxy` is at `:6436`) |
| † The core calls back into its host through `std::function` (host functions, property getters and setters, output, input, file reader, debug hook) — the seam the second binding plugs into | `src/core/lua-runtime.h:363–668`, `:1104` |
| † Four instruments read the native binding by hardcoded path | `tools/invariants/{invariants,surface-census,liveness-guarding}.mjs`, `tools/lint/run.mjs` |
| About 140 lines contain `throw`; errors are reported by C++ exception throughout | both `.cpp` files |
| Lua unwinds with `longjmp`; the code depends on C++ frames returning before a Lua C frame jumps | `CLAUDE.md` conventions, rule (3) |
| Two `Napi::AsyncWorker` subclasses, and no other thread creation | `src/lua-async-worker.h`, used at `src/lua-native.cpp:3937`, `:3956` |
| The core still holds a `std::mutex` and several `std::atomic` members for that worker | `src/core/lua-runtime.h:1228–1310` |
| `Napi::Buffer` at four sites: bytecode out (two), bytecode in, binary-string in | `src/lua-native.cpp:107`, `:2803`, `:2836`, `:2846` |
| Wall-clock timeouts use `std::chrono::steady_clock` inside a `lua_sethook` hook | `src/core/lua-runtime.cpp:434`, `:603` |
| File access goes through `luaL_loadfilex` at three sites, plus the stock `io`/`os` libraries | `src/core/lua-runtime.cpp:2687`, `:3057`, `:3516` |
| **The suite and every harness load the addon through one file**, `index.js` | 13 import sites under `tests/ts/` and `tools/` |
| `index.js` imports `node:fs`, `node:module`, `node:os` — it cannot be a browser entry | `index.js:1–5` |
| On November 22 `emcc` was not installed; by November 24 Emscripten 7.0.1 was, through Homebrew. vcpkg has `triplets/community/wasm32-emscripten.cmake` | this machine |
| † The only Lua vcpkg has installed is `arm64-osx`, a native archive. There is no WASM `liblua.a` to reuse | `$VCPKG_ROOT/installed/` |
| † The stock WASM triplet sets no `VCPKG_C_FLAGS` or `VCPKG_CXX_FLAGS`. It chainloads vcpkg's Emscripten wrapper toolchain, whose comment says that wrapper is what applies those flags — so an overlay, if needed, is one added line | `triplets/community/wasm32-emscripten.cmake` |
| † The Lua port compiles Lua as C unless its `cpp` feature is requested | `ports/lua/portfile.cmake:21–22` |
| `perf-claims` scans every `docs/*.md`, including this file and any `docs/WASM.md` | `tools/invariants/perf-claims.mjs:39` |

### 2.2 Read from the Emscripten documentation (November 24, 2026)

Source: `https://emscripten.org/docs/` — *porting/exceptions*,
*porting/setjmp-longjmp*, *api_reference/val.h*,
*porting/connecting_cpp_and_javascript/embind*, *porting/pthreads*,
*porting/files/file_systems_overview*, and *tools_reference/settings_reference*.

- **Exceptions are off unless asked for.** "By default, exception catching is
  disabled in Emscripten." Two modes exist, `-fexceptions` (JavaScript-based)
  and `-fwasm-exceptions` (native WASM exception handling), and the chosen flag
  must be passed at both compile time and link time.
- **`longjmp` follows the exception mode, and C files must be told.**
  `-sSUPPORT_LONGJMP` takes `emscripten`, `wasm`, `0` or `1`; the default `1`
  resolves to `wasm` under `-fwasm-exceptions` and `emscripten` otherwise. For C
  sources the docs say to pass `-sSUPPORT_LONGJMP=wasm` at compile time,
  because a C compile carries no exception flag. One stated restriction under
  WASM exceptions: `setjmp` cannot be called within a C++ `catch` clause.
- **`emscripten::val`.** Documented: `global()`, `module_property()`, property
  get (`operator[]`) and `set()`, `operator()` and `call<R>()`, `new_()`,
  `typeof()`, `as<T>()`, `hasOwnProperty()`, `array()`, `object()`,
  `undefined()`, `null()`, `as_handle()` and `take_ownership()`. Handles are
  refcounted: copying adds a reference, the destructor drops one. "JavaScript
  values can't be shared across threads." `await()` requires `ASYNCIFY`.
- **Not stated on those pages:** how a JavaScript exception thrown by a
  function called through `val` reaches C++, or whether the thrown value can be
  recovered (U3). Also not stated: what `std::mutex` and `std::atomic` do in a
  build without `-pthread` (U4).
- **Embind** links with `-lembind`. `int64_t`/`uint64_t` map to `BigInt` and
  need `-sWASM_BIGINT`.
- **Threads.** They need the two cross-origin isolation headers in a browser.
  On the browser main thread `Atomics.wait` does not work and
  `pthread_mutex_lock` busy-waits; the core takes `deferred_unref_mutex_` on
  the main thread. This matters to Phase 6 only.
- **Filesystem.** The default is `MEMFS`, an in-memory filesystem mounted at `/`.
- **Settings.** `ALLOW_MEMORY_GROWTH` defaults to off, and an allocation past
  the limit aborts. *The remaining entries reached this plan as a summary
  rather than as quoted text, so Phase 0 confirms each by building:*
  `MODULARIZE` wraps the output in a function returning a promise;
  `EXPORT_ES6` implies it; `ENVIRONMENT` accepts `web`, `worker` and `node`
  together, so one build can run in a browser and under Node; `NODERAWFS`
  gives direct access to Node's filesystem; `WASM_BIGINT` defaults to on;
  `FILESYSTEM` can be switched off.
- **Version.** The pages read did not establish the current release. Phase 0
  ran on 7.0.1, the version Homebrew had installed.

### 2.3 Measured in Phase 0 (November 24, 2026)

Toolchain: Emscripten 7.0.1 (Homebrew), Lua 5.5.1 from the vcpkg port, Node
24.22.3. All builds at `-O1`, C++17.

**The toolchain and the library**

| Fact | How it was measured |
|---|---|
| The stock triplet needs `EMSCRIPTEN_ROOT` set to `/opt/homebrew/opt/emscripten/libexec`: the `emcc` on `PATH` is a wrapper with no toolchain file beside it | triplet source; the install succeeds with the variable set |
| vcpkg builds Lua for `wasm32-emscripten` in about two seconds, stock or overlay | install log |
| Stock `liblua.a` references `emscripten_longjmp`, `invoke_vii`, `getTempRet0`. Built with `VCPKG_C_FLAGS "-sSUPPORT_LONGJMP=wasm"` it references `__wasm_longjmp` and `__c_longjmp` instead | `llvm-nm -u` |
| **`src/core/lua-runtime.cpp` does not compile under Emscripten's libc++**: `strtoll` (`:104`) and `realloc` (`:369`) are used without `<cstdlib>`. `tests/cpp/lua-native-test.cpp` uses `std::sort` (`:1794`, `:2856`) without `<algorithm>`. Apple's libc++ supplies both transitively. With `-include cstdlib -include algorithm` on the command line both compile, and nothing else in the core needed attention. Both includes were added to the source afterwards (D7) | `em++` errors |
| `std::mutex`, `std::atomic` and `std::this_thread::sleep_for` compile and run with no `-pthread` | the suite, cell C |
| The default 64 KiB WASM stack was enough for the C++ suite | link line; cell C |

**The three cells** — the C++ suite (286 tests) as WASM under Node, `-sNODERAWFS=1`

| Cell | `liblua.a` | Module flags | Result |
|---|---|---|---|
| A | stock | `-fexceptions` | 285 pass. `LuaRuntimeProtectedAlloc.ResultConversionUnderExhaustedMemoryReportsInsteadOfAborting` aborts the process: Lua panics inside an unprotected `luaL_unref`. Reproduced alone and in the full run. |
| B | stock | `-fwasm-exceptions` | Does not link: `undefined symbol: emscripten_longjmp` |
| C | overlay | `-fwasm-exceptions` | **286 pass** |

**Why A fails** — a probe of what happens to a C++ frame when Lua raises an
error through it. Four Lua C functions called under `lua_pcall`, built three
ways; A was repeated at `-O0` and `-O2` with the same result.

| The frame… | Native | A | C |
|---|---|---|---|
| holds a local with a destructor | error delivered; destructor **not** run | **error value lost** (`nil`); destructor run | error delivered; destructor **run** |
| wraps the raising call in `catch (...)` | error delivered; handler not entered | **the statement after the `try` runs**; handler not entered | as native |
| wraps it in `catch (const std::exception&)` | as above | **same failure** | as native |
| catches its own C++ exception, then raises | delivered | delivered | delivered |

Cell A is disqualifying on its own terms: the core has `catch` blocks in Lua C
frames throughout, and in that mode a Lua error raised inside one does not
leave the frame. **Cell C differs from native in one cell** — a destructor in a
frame Lua jumps through *does* run. The suite does not notice, and it is the
safer direction, but it is a difference: `CLAUDE.md`'s rule that a Lua C
frame's helper returns before the frame jumps exists because natively those
destructors are skipped. Phase 3's `exception-matrix` run is where this gets
looked at properly.

**The spike** — the real core behind `emscripten::val`, cell C's flags plus
`-lembind -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web,worker`, run
under Node with `--expose-gc`. About 120 lines of C++ and 55 of JS.

| Check | Result |
|---|---|
| Values Lua → JS and JS → Lua → JS through a JS callback | pass |
| A Lua error reaches JS with message and traceback | pass |
| A JS `Error` thrown by a callback inside a Lua C frame is seen by Lua's `pcall`, and the identical object is recoverable afterwards | pass |
| The same for a thrown value that is not an `Error` | pass |
| An uncaught JS throw surfaces through `execute`, and the context is usable afterwards | pass |
| A Lua function handle is released by a `FinalizationRegistry` callback | pass — **but not synchronously**: after `gc()` returns the handle is still live, and it is released in a later task |
| A coroutine is resumed from a Promise's `.then` callback with no `ASYNCIFY` | pass |
| Size of the spike module (core, Lua and Embind; no real binding) | 436 KB raw, 156 KB gzip |

**clang-tidy** — CLion's clang-tidy (LLVM 24) with the repository's
`/.clang-tidy` parses the spike with no compile error when given the output of
`em++ --cflags -fwasm-exceptions`, and reports findings of the ordinary kind
(8, all about the spike's own globals and parameters).

### 2.4 Measured in Phase 1 (November 24, 2026)

Same toolchain as §2.3. Debug is `-O0 -g`, release is `-O2`.

**STACK-SIZE.** The WASM stack is a fixed region of the module's memory and cannot grow.
Emscripten's default is 64 KiB. Lua limits C-level nesting itself
(`LUAI_MAXCCALLS`, 200), so "enough" can be measured: build the deepest chain
of each kind a script can, and require Lua's own `C stack overflow` rather
than a trap. Seven chains, through the real core, in `check.mjs`:
`string.gsub` callbacks, a host function re-entering Lua, an `__index` chain,
a `table.sort` comparator, nested `coroutine.wrap`, a traceback built at the
limit, and parser nesting past the limit.

| `-sSTACK_SIZE` | Debug | Release |
|---|---|---|
| 64 KiB (the default) | 3 of 7 fail — `Aborted(stack overflow …)` | 3 of 7 fail — `RuntimeError: memory access out of bounds` |
| 128 KiB | 3 of 7 fail, same abort | **2 of 7 fail by returning a wrong answer with no error**: the script returns three values and the probe reports none |
| 256 KiB | 7 pass | 7 pass |
| 512 KiB | 7 pass | 7 pass |
| 1 MiB (**chosen**) | 7 pass | 7 pass |

The 128 KiB release row is the reason this was worth measuring: a release
build has no overflow check, and there the overflow was neither a trap nor a
Lua error. 1 MiB is four times the smallest size that passed. It is sized on
the core alone — the Phase 2 binding adds `val` frames to every host crossing —
so the same seven cells are re-run against the real entry points when slice 2
lands, and the number is revisited if the margin has gone. (Done November 24,
2026: all seven pass against the real entry points in both configurations, and
the number stands. What slice 2 found instead was the *other* stack — see
"Slice 2 — as built".)

**Other facts**

| Fact | How it was measured |
|---|---|
| `node-gyp rebuild` deletes the whole `build/` directory | a marker directory under `build/` was gone after `npm run build-debug` |
| Emscripten 7.0.1 emits the legacy WASM exception-handling instructions unless told otherwise (`WASM_LEGACY_EXCEPTIONS` is on by default), and that is what both the module and `liblua.a` are built with | `src/settings.js`; the debug link pulled `libc++-debug-legacyexcept` |
| `em-config EMSCRIPTEN_ROOT` returns the toolchain root on a Homebrew install | run |
| Skeleton sizes (core, Lua, Embind, no real binding): release `.wasm` 345 KB raw, 141 KB gzip; glue 79 KB (web) and 90 KB (node). Debug `.wasm` 7.6 MB with DWARF | the build's own report |
| The web variant's glue contains no `new Function`, so Embind is not generating code at run time in this version | `grep` on the release web glue |
| `LUA_NATIVE_TARGET` unset returns the identical object `index.js` exports | `===` |

---

## 3. Unknowns that Phase 0 must settle

Each is a question with a concrete experiment. **Phase 0 does not exit until
each has a written answer**, and a "no" on U1, U2 or U3 stops the plan.

| # | Question | Experiment |
|---|---|---|
| U1 | Do C++ exceptions and Lua's `longjmp` coexist with one consistent flag set across `liblua.a` and the module's objects? | Compile the **C++ Google Test binary to WASM** and run it under Node. It exercises the core and Lua with no binding in the way. |
| U2 | Does any core path enter Lua from inside a C++ `catch` block, and does the documented `setjmp` restriction bite if so? | Falls out of U1's run; if a test dies, grep the core's `catch` blocks for `lua_` calls. |
| U3 | Can the binding call JS and get a thrown value back without the exception crossing a WASM frame (D2 rule 2), in both directions, including a non-`Error` thrown value? | A spike of well under 100 lines: a JS callback that throws, called from a Lua C frame through the trampoline; and a Lua error surfaced to JS as an `Error`. |
| U4 | Do `std::mutex` and `std::atomic` compile and behave in a build without `-pthread`? | Falls out of U1's test run. |
| U5 | Do finalizers arrive when the harnesses expect? Without N-API they come from a `FinalizationRegistry` in the shell, whose callbacks run in a later task than `gc()`. | The spike registers one; then `gc-stress`, `binding-balance` and `lifecycle-matrix` run first in Phase 3, before anything else is trusted. |
| U6 | Can a Lua coroutine be resumed from a Promise's `.then` callback with no `ASYNCIFY`? The native binding does exactly this, so the expectation is yes. | The spike: `execute_async` awaiting one resolved Promise. |
| U7 | What do `os.execute`, `io.popen`, `os.getenv`, `os.tmpname` and `package.loadlib` do under Emscripten — refuse loudly, or accept and do nothing? | `capability-matrix` (its rule is *work or refuse loudly*, `LIMITATIONS.md` §8). |
| U8 | Does a busy Lua loop on the browser main thread still honour `timeout`? | Browser smoke test; the hook and clock are in the core, so the expectation is yes. |
| U9 | Is the `liblua.a` from vcpkg's **stock** `wasm32-emscripten` triplet usable as built, with no overlay? | `vcpkg install lua:wasm32-emscripten`, then Phase 0 cells A and B. Linking is not the test — a `longjmp` mismatch can link and fail only when Lua first raises an error — so the test is the C++ suite, which exercises error paths. Routes 2 and 3 in D5 if not. |
| U10 | Can clang-tidy lint `src/wasm/lua-wasm.cpp`, which includes `<emscripten/val.h>`, when pointed at the Emscripten sysroot? | Run it. If not, the file is outside `npm run lint` and that is written down, not left implicit. |

### 3.1 Answers (Phase 0, November 24, 2026)

| # | Answer |
|---|---|
| U1 | **Yes, in one of the two modes.** WASM-native exceptions with WASM-native `longjmp`, on every object including Lua's: 286 of 286. The JavaScript-based mode is not usable — see §2.3. |
| U2 | **No bite observed.** The core does enter Lua from inside a `catch` block (`src/core/lua-runtime.cpp:2853` is one such site) and the suite passes in cell C; the `setjmp` is inside Lua's own C function, not in the `catch` clause. Whether the suite exercises that exact line was not checked. |
| U3 | **Yes.** A trampoline in JS that catches and returns `{ok, value}` keeps every JS exception out of WASM frames, and the thrown value — `Error` or not — is recoverable by identity. |
| U4 | **Yes.** They compile and the suite passes with no `-pthread`. |
| U5 | **Confirmed different, and it cost nothing.** A finalizer does not run during `gc()`; it runs in a later task. The harnesses already yield between collections, for N-API's own queued finalizers, so `gc-stress`, `binding-balance` and `lifecycle-matrix` ran on this target unmodified and clean (slice 7). |
| U6 | **Yes.** No `ASYNCIFY`. |
| U7 | **No finding.** `capability-matrix` runs on this target with the native totals, 251 cells and 0 findings (slices 6 and 7), so none of them accepts and does nothing. What each of the five answers individually was not read off. |
| U8 | **Yes under Node** (slice 5): an unbounded loop started through a deferred door is ended by its `timeout`. In a browser, yes (Phase 4): on the main thread and in a worker, in Chromium 156 and Safari 27.2. |
| U9 | **No.** The stock library works only with the exception mode that fails U1. The overlay is one added flag. D5. |
| U10 | **Yes**, with flags taken from `em++ --cflags -fwasm-exceptions`. |

---

## 4. Phases

### Phase 0 — toolchain and go/no-go spike (**run November 24, 2026 — go**)

The steps as planned:

1. Install the Emscripten SDK and **pin its version** in the build script.
2. **Install the stock library and write no triplet:**
   `vcpkg install lua:wasm32-emscripten`. Record the `emcc` version that built
   it and, from `llvm-nm`, which `longjmp` runtime its objects reference.
3. Compile `src/core/lua-runtime.cpp` plus `tests/cpp/lua-native-test.cpp` plus
   Google Test to WASM against that library, and run the result under Node
   (U1, U2, U4, U9), in cells A (stock, `-fexceptions`), B (stock,
   `-fwasm-exceptions`) and, only if A fails, C (overlay,
   `-fwasm-exceptions`).
4. Write the spike for U3, U5 and U6 against the real core, with the flag set
   that won step 3.
5. Write the answers into §3 and rewrite D5.

**Exit:** the C++ suite is green as WASM, the spike passes under Node, and the
library source and flag set are recorded. Otherwise stop and report.

#### What happened

| Step | Result |
|---|---|
| 1 | Nothing to install: Emscripten 7.0.1 was already present through Homebrew. §2.1's November 22 row saying `emcc` was absent no longer held. |
| 2 | Installed in about two seconds. The objects reference the JavaScript-based `longjmp` runtime. |
| 3, compile | **The core did not compile** — two standard headers are missing (§2.3). The run continued with them force-included on the command line and no source edited. The owner then approved adding the two `#include` lines (D7), which was done the same day. |
| 3, cell A | Links. **285 of 286 pass; one aborts the process.** |
| 3, cell B | **Does not link**: `undefined symbol: emscripten_longjmp`. |
| 3, cell C | Built because A failed. **286 of 286 pass.** |
| 4 | Spike written against cell C's flags: 12 of 12 checks pass under Node. |
| 5 | Done — §2.3, §3.1, D5, and the scores in §7. |

**The exit condition is met on route 2** (the overlay), with one item waiting
on the owner: the two missing includes (D7).

Three things in this record differ from the plan as written, stated so they
are not mistaken for the plan having been followed to the letter:

- The SDK is Homebrew's, not an `emsdk` checkout, so "pinned" means the build
  script will refuse any version but the one recorded here. Homebrew does not
  keep old versions installable; if that becomes a problem, `emsdk` is the
  answer and nothing else in this plan changes.
- Cell C's library was installed under a separate throwaway triplet name
  (`wasm32-emscripten-wasmsjlj`) so both libraries could exist side by side.
  The real overlay, written in Phase 1, shadows the stock name instead.
- Both experiment installs were left in the local vcpkg tree. Phase 1's
  script has since replaced the stock one; the throwaway one remains.

The spike, the probe and the cell builds lived in a scratch directory and are
gone, as intended. Everything needed to repeat them is in §2.3.

### Phase 1 — the build target and the test switch (**done November 24, 2026**)

What was planned, as built:

- `tools/wasm-build/run.mjs` compiles the core and the WASM binding and links
  two variants from the same objects — **node** (`-sENVIRONMENT=node
  -sNODERAWFS=1`, so `execute_file` and the fixtures see the real disk; used
  only for verification) and **web** (`-sENVIRONMENT=web,worker`, in-memory
  filesystem; the one that ships).
- `triplets/wasm32-emscripten.cmake` — the stock triplet plus
  `-sSUPPORT_LONGJMP=wasm` in `VCPKG_C_FLAGS` and `VCPKG_CXX_FLAGS` — and
  `npm run vcpkg-lua-wasm` (`tools/wasm-build/vcpkg-lua.mjs`), which removes,
  installs through the overlay, and prints the `emcc` version and which
  `longjmp` runtime the library references (D5).
- Flags: `-std=c++17 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm` at compile and
  link, `-lembind`, `-sMODULARIZE=1 -sEXPORT_ES6=1`,
  `-sALLOW_MEMORY_GROWTH=1`, `-sSTACK_SIZE=1048576`. Debug is `-O0 -g` with
  `-sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=2`; release is `-O2`.
- The script refuses any Emscripten but 7.0.1, sets `EMSCRIPTEN_ROOT` itself
  (from `em-config`), and refuses a `liblua.a` that references the
  JavaScript-based `longjmp` runtime before it links anything.
- npm scripts `build-wasm-debug` and `build-wasm-release`; `npm run clean`
  removes the output.
- `binding.gyp`, `CMakeLists.txt` and `index.js` are not edited (D7).
- **Development loader**, `tools/target.mjs`, unpublished. With
  `LUA_NATIVE_TARGET` unset (or `native`) it hands back `index.js`'s default
  export — checked to be the identical object. `LUA_NATIVE_TARGET=wasm` imports
  the node variant of the debug build and `wasm-release` the release one, **by
  explicit path, with no fallback**: a missing build is an error naming the
  path, and an unknown value is an error. It exports `target`. The 13 import
  sites import this file.
- An environment variable rather than an argument because `exception-matrix`
  and `lifecycle-matrix` spawn one process per cell, and children inherit it.

**What happened**

| | |
|---|---|
| Output directory | **`build-wasm/`, not `build/wasm/` as this plan first said.** `node-gyp rebuild` deletes `build/` before it configures — a marker placed there was gone after `npm run build-debug` — so a WASM build kept there would vanish on every native rebuild. `.gitignore` gains the directory. |
| Stack size | Measured rather than inherited (§2.4): the core alone needs more than 128 KiB and no more than 256 KiB. Set to 1 MiB. |
| A binding to compile | Phase 2 writes the binding, but the build needs a translation unit now. `src/wasm/lua-wasm.cpp` and `src/wasm/shell.js` are **skeletons**: they expose `buildInfo` and `probeExecute` under a `__phase1` key for the build's own check, and no public API. `init` is absent, so a program written against `types.d.ts` fails at its first line on this target rather than part of the way in. |
| The build checks itself | `tools/wasm-build/check.mjs`, run by every build, one process per cell: 17 cells — the core and Lua are linked in, errors cross frames in both directions, the node variant reads a real file, seven stack cells, and three checks on the web variant. |
| The web variant | **Validated but not executed.** Node cannot load a `web,worker` module. Its `.wasm` validates and its glue imports nothing from Node (the same pattern finds one such import in the node variant's glue). Running it is Phase 4. |
| A second WASM target name | `wasm-release` was added so `crossing-cost` can be pointed at an optimised build in Phase 3 without a fallback rule. |
| The native target, after the switch | `npm run test-cpp` 286 of 286, `npm test` 1204 of 1204, `npm run lint` 0 findings, `npm run check-invariants` all match with nothing re-frozen, and all ten harnesses plus `gc-stress` clean. The sanitizer harnesses were not re-run. |
| The suite under `LUA_NATIVE_TARGET=wasm` | Fails at collection — `createSharedTable is not a function`, no tests run. This is the expected state until Phase 2's first slice. |
| The skeleton and the linter | CLion's clang-tidy with `/.clang-tidy` and the flags from `em++ --cflags -fwasm-exceptions` reports nothing in `src/wasm/lua-wasm.cpp`, and reports a planted naming violation. `npm run lint` does not cover the file yet (Phase 5). |
| Left in the vcpkg tree | `lua:wasm32-emscripten` is now the overlay's library. Phase 0's throwaway `lua:wasm32-emscripten-wasmsjlj` is still installed and is used by nothing. |

### Phase 2 — the WASM binding (**done November 24, 2026**)

The bulk of the work. Written in slices, each closed by running the part of
the existing suite that covers it with `LUA_NATIVE_TARGET=wasm` — the suite,
not a new one, so that no slice is judged by tests written to fit it.

| Slice | Surface |
|---|---|
| 1 — **done November 24, 2026** | `init` and every option, `execute_script`, values in both directions under every conversion mode, errors in both directions |
| 2 — **done November 24, 2026** | Globals, Lua functions as JS functions, `call`, `pcall`, JS callbacks |
| 3 — **done November 24, 2026** | Table references and their `Proxy`, `create_table`, `get_global_ref`, environments |
| 4 — **done November 24, 2026** | Userdata, metatables, classes, type converters |
| 5 — **done November 24, 2026** | Coroutines and the three coroutine-driven async doors; then the two doors in D3 |
| 6 — **done November 24, 2026** | Bytecode, modules, search paths and searchers, the print, read and file handlers, hooks, stack and locals |
| 7 — **done November 24, 2026** | `release`, `dispose`, `reset`, `gc`, `info` including `bindingRefs`, `SharedTable` |

Rules that hold for every slice:

- **Port, do not redesign.** Each native entry point is read beside its port.
  Error text is copied, not paraphrased: the suite asserts on messages (a bare
  `.toThrow()` fails closed) and `exec-parity` compares them.
- **Brands, not `instanceof`.** N-API type tags do not exist here. Handles and
  the two classes are identified by a private brand the shell holds, for the
  reason `SharedTable`'s header comment records: a constructor reachable from
  JS makes `instanceof` user-defeatable. `cross-context` depends on this.
- **`info().bindingRefs` is implemented over the WASM binding's own
  containers**, with the same field names, so `binding-balance` measures this
  binding and not a stub.
- The conventions in `CLAUDE.md` apply to `src/wasm/lua-wasm.cpp` in full —
  definitions at column 0, anonymous namespace, naming, complexity, helpers
  within one hop of a guarded entry point, and a Lua C frame's helper returning
  before the frame jumps — because Phase 5 points the scanners at it.

#### Slice 1 — as built (November 24, 2026)

**Files.** `src/wasm/lua-wasm.{h,cpp}` is the binding, as planned. Two files
were added beside it: `src/wasm/js.{h,cpp}`, the binding's view of JavaScript
(what `node-addon-api` is to the native one), and `src/wasm/probe.cpp`, the
Phase 1 build probe moved out of the binding. About 1,600 lines of C++ and 390
of shell so far.

**How the two exception models were mapped**, since every later slice leans on
it:

| Native | WASM |
|---|---|
| A JS exception is a thrown `Napi::Error`, which is a `std::exception` | `js::JsError`, also a `std::exception`. The ported `catch` sites keep their shape and meaning. |
| Any N-API call can raise one | Every operation that can run user JS — a property read, a call, `String(v)`, `instanceof`, key enumeration — goes through a function on the shell's `host` object that catches and returns a sentinel; `js.cpp` rethrows it as a `JsError`. **No JS exception unwinds through a WASM frame** (D2, rule 2). |
| `ThrowAsJavaScriptException(); return env.Undefined();` | `js::Throw*(); return val::undefined();` — a pending exception. The entry wrapper returns the sentinel and the shell throws the value. |
| A `std::exception` that is not a `Napi::Error` escaping an entry point terminates the process | It becomes a JS `Error` carrying `what()`. **A deliberate difference**: an abort would take the page with it. `exception-matrix` on this target therefore cannot see a missing guard as a crash; Phase 5's `core-call-guarding` census is what has to. |

**Decisions that came up**

- **`SharedTable` lives wholly in the shell and landed now, not in slice 7.**
  Natively it is a C++ class holding one JS object and calling each
  subscriber's `set_global`; there is no Lua in it. And the suite cannot be
  collected without it: `tests/ts/lua-native.spec.ts` calls
  `createSharedTable({})` at module scope. `get`, `set` and `sync` are real.
  *Subscribing a context* — the `shared` option — is still slice 7, and until
  then the constructor refuses the option rather than ignoring it.
- **A value kind that a later slice ports is refused by name.** A Lua function,
  coroutine, userdata, or a table kept by reference outside `tableAs: 'map'`
  reaching JS raises an error naming its slice. A method not yet ported is
  simply absent. Nothing returns something that merely looks right.
- **A property named by a `std::string` stops at its first NUL.** The native
  binding names properties through C-string N-API calls, so a Lua key `"a\0b"`
  has always addressed the JS property `"a"` — a documented loss the suite
  pins. The first WASM build kept the whole key and one test failed for it;
  the port now truncates as native does.
- **Strings cross through `TextEncoder` and `TextDecoder`**, not Embind's own
  conversion: a lone surrogate becomes U+FFFD going in and an invalid byte
  sequence becomes U+FFFD coming out, as N-API's two calls do.
- `print` (the constructor option) is ported here because it is an `init`
  option; `set_print_handler` is still slice 6.

**Where N-API asks V8 a question JavaScript cannot ask exactly.** Each is a
candidate ledger row for Phase 3, written down now so it is not rediscovered:

| Native asks | The shell asks | Where they can differ |
|---|---|---|
| `IsPromise()` — is it a promise | is the intrinsic `Promise.prototype` on its chain | an object given that prototype by hand reads as a promise |
| `IsArray()` — false for a Proxy over an array | `Array.isArray` — true for one | a Proxy-wrapped array converts as an array here and as an object natively |
| `napi_instanceof`, with a failure status the native code ignores | `instanceof`, and a throwing `Symbol.hasInstance` propagates | what a hostile `hasInstance` on `Map`, `Set` or `RegExp` produces |
| `IsBuffer()` / `IsTypedArray()` / `IsArrayBuffer()` | `ArrayBuffer.isView` and a brand check on the intrinsic `byteLength` getter | none known |

**Results**

| Check | Result |
|---|---|
| The suite, `LUA_NATIVE_TARGET=wasm` | 1173 tests: **173 pass on their merits**, 6 pass only because an absent method threw inside a broad `toThrow` or a `try`, 994 fail. Of the failures, 924 call a method not yet ported and 70 hit a not-ported refusal; **none is unexplained.** |
| How that was counted | A throwaway vitest setup file put a recording `Proxy` behind `LuaContext.prototype`, so any read of a method that does not exist is attributed to the test that made it. A pass that touched one is not counted as a pass. |
| A smoke script of 26 calls, run on both targets and diffed | Identical output apart from four expected lines: the extra `__phase1` key, a printed table address, and the two not-ported refusals. |
| `npm run oracle`, debug and release WASM builds | 2657 agree, 19 accepted (the same four ledger entries as native), **2 disagree — both the slice 3 refusal** for a metatabled table. The `--binary` column gives the same numbers. Prediction 8 holds so far, `os` and `io` included. |
| The one real difference the suite found | the NUL-truncated key above — found by an existing test, fixed by porting more exactly |
| Contexts are freed | 3,000 contexts created and dropped with a collection every 100: resident memory went from 18 MB to 43 MB and stayed there |
| clang-tidy with `/.clang-tidy` over `js.cpp`, `lua-wasm.cpp`, `probe.cpp` | 0 findings. Seven were reported and fixed by hand; four suppressions remain, each checked to be needed by disabling it. `npm run lint` still does not cover these files (Phase 5). |
| The build's own check | 17 of 17, debug and release |
| Release module | 426 KB raw, 168 KB gzip |
| The native target | untouched by this slice: `npm test` 1204 of 1204, `npm run lint` 0 findings, `npm run check-invariants` all match |

**Not done in slice 1, and stated so it is not assumed:** no handle kind exists
yet, so `RoundTripMarkerToCore` recognises nothing; the type-converter loops
are ported but nothing can register a converter; a callback that returns a
Promise is refused with the native message, and the await path behind it is
slice 5. The harnesses other than `oracle` need doors that later slices port
and were not run on this target.

#### Slice 2 — as built (November 24, 2026)

**Files.** `set_global`, `get_global` (both with dotted paths), `call`, `pcall`
and the conversion of a Lua function to a JS function are in
`src/wasm/lua-wasm.{h,cpp}`, each a port of the native function of the same
name with the same checks in the same order and the same message text. The
Phase 1 probe (`src/wasm/probe.cpp`, the `__phase1` key) is gone:
`tools/wasm-build/check.mjs` now asks its questions through `init`,
`execute_script`, a JS callback and a Lua function called from JS.

**How a Lua function is held**

| Native | Here |
|---|---|
| `Napi::Function::New(..., "luaFunction", data)` | a `function luaFunction(...args)` expression built by the shell: same `name`, same `length` of 0, has a `prototype` |
| `LuaFunctionData` freed by an `External`'s finalizer | the same struct as an Embind class; the shell's `FinalizationRegistry` calls `delete()` on it when the function is collected |
| `__luaFnOwner`, a hidden non-writable, non-configurable `External` | the same property, holding an opaque frozen object |
| the `External`'s type tag says what kind of handle it is (CR-15 F6) | the owner object is a key in the shell's `WeakMap` of *function* owners; being in that map is the tag |
| liveness: `alive_`, `context_alive_`, `closed_flag_` | the same three flags, carried the same way (`ContextLiveness`) |

A Lua function handed back into Lua is not unwrapped to the original: as
natively, it crosses as a JS callback that calls through.

**The finding: the engine's own call stack**

Phase 1 sized the module's stack, which lives in the module's memory. The
first stack cell run through the real entry points failed for a different
reason: the *JavaScript engine's* stack ran out first, and what came back was
a bare `WebAssembly.Exception`.

| Measurement | Result |
|---|---|
| A JS callback and a Lua function calling each other until something stops them, Node's default stack — **native** | stopped by the engine at depth 168. Lua sees `Maximum call stack size exceeded` as an ordinary error, `pcall` catches it, and the context goes on working. |
| The same — WASM debug | the engine stops it at depth 127; the caller got a bare `WebAssembly.Exception` |
| The same — WASM release | reaches Lua's own limit at depth 198 and is refused by Lua. With `--stack-size=800` the engine stops it at 190; at 600, 141; at 400, 93 — each time with the bare exception. So the release build fits on Node's default stack with about a sixth to spare, on trivial callbacks. |
| Does C++ `catch (...)` catch a JavaScript exception? | **No.** A scratch program threw a `RangeError` from JS through a frame with `catch (...)`: the destructor in the frame ran, the handler did not. |
| What happens when the engine's stack check fires inside a WASM function? | **Not even destructors run.** A scratch program recursed in WASM under an object with a destructor: 0 destructors ran, `catch (...)` did not run, and the module's stack pointer was left 498,560 bytes from where it started. |
| What that does to Lua | Lua's protected calls do not see the exception, so the frames it crosses are abandoned with Lua's handler chain still pointing into them. The next Lua error jumps to a handler in a frame that is gone; nothing claims the jump, and it surfaces as the bare `WebAssembly.Exception` above. |
| What an unrepaired stack pointer costs | Lua recursing alone with a 150 KB engine stack: 150,384 bytes of the module's stack lost per event, and the seventh event aborted the module for every context in it. |

Natively none of this exists: N-API reports a JavaScript exception as a status
code, native frames are not unwound by it, and the engine does not check its
stack inside native code. It is a property of the target, not of this
binding's design, and D2's choice of `emscripten::val` neither caused nor
could have avoided it.

**What was built for it.** Detection has to live in the shell, because the
shell's `try` is the only thing that can see the event:

- Every call from the shell into the module goes through one function,
  `enter`. By protocol nothing is thrown out of such a call, so anything that
  is thrown is the event.
- C++ counts each entry point as it begins, in a word of the module's memory
  that the shell reads directly. If a call threw and the count moved, C++ had
  started and its frames were unwound. A `RangeError` raised before that — a
  caller already at the edge of the stack — harmed nothing and marks nothing.
- A context whose C++ side was unwound is **refused from then on**, together
  with every handle it minted: `this Lua context can no longer be used …
  Create a new context.` Neither its Lua state nor the binding's own
  bookkeeping can be trusted after frames went without their destructors, and
  Lua's public API offers no way to repair the handler chain.
- The bare `WebAssembly.Exception` is replaced by that error, with the
  original as its `cause`.
- The module's stack pointer is put back once no call into the module is in
  progress.
- The shell's guarded primitives now park a caught exception without calling
  anything, since a call from a handler at the edge of the stack is the next
  overflow; and each entry point clears the pending-exception flag as it
  begins.

**Open with the owner.** Three things here are decisions, not implementation:

1. **The difference itself.** *Ruled November 25: added to §1.1.* Natively the context survives this; here it is
   lost. §1.1 is a closed list and this is not on it. Either it is added —
   "exhausting the JavaScript stack while Lua is running ends the context" —
   or more is spent to narrow it (item 3).
2. **State the whole module shares.** If the engine's check fires inside the
   module's allocator, the damage is not confined to one context and nothing
   here can tell. The choices are to accept and document that, or to refuse
   *every* context after any such event and give the caller a way to start a
   fresh module instance, which is new API.
3. **A depth limit on nested JS and Lua calls**, on this target only. It would
   turn the commonest way of getting here into an ordinary Lua error with the
   context intact. It is visible API — the native target's only limit is
   Lua's own 200 — so it is not adopted here.

Also for later slices: `reset()` (slice 7) must not revive a refused context,
since it replaces the Lua state and not the binding's bookkeeping; and Phase 4
has to run the exhaustion cells in each browser, because every number above is
Node's.

**Differences from native found by diffing.** A scratch script of 127 calls
across this slice's surface was run on both targets and its output compared.
One difference was a defect and is fixed; three are recorded for the Phase 3
ledger:

| Difference | Disposition |
|---|---|
| A method called on the wrong receiver threw a private-field `TypeError`, where native throws `TypeError: Illegal invocation` | **Fixed** — the shell checks the brand and throws the same text. It applied to `execute_script` since slice 1 and to `SharedTable`; all are covered. |
| The key order of a Lua table converted to a plain object differs (`{s, m, d, u}` natively, `{m, s, d, u}` here) | The core holds such a table in a hash map, whose order depends on the platform's hash; it is unspecified on both targets and differs between a 64-bit and a 32-bit build. Ledger. |
| A Lua function's own property names: native also has `arguments` and `caller` | An ES module cannot define a non-strict function. Ledger. |
| `String(fn)` shows `[native code]` natively and the shell's source here; V8 quotes it in the error for deleting `__luaFnOwner` | The suite's assertion on that error still matches. Ledger. |

Everything else in the 127 was identical, error text and object identity
included: a thrown `Error` comes back as the same object through `pcall` and
through a Lua `error()` rethrow; a JS function stored in Lua comes back as the
same function.

**Results**

| Check | Result |
|---|---|
| The suite, `LUA_NATIVE_TARGET=wasm` and `wasm-release` | 1173 tests: **309 pass on their merits** (173 after slice 1), 3 pass only because an absent method threw inside a broad `toThrow`, 861 fail. Of the failures, 824 call a method not yet ported and 37 hit a not-ported refusal; **none is unexplained.** Counted as in slice 1. |
| Whole groups now passing | `global variables` 6 of 6, `get_global` 8 of 8, `dotted path globals` 17 of 17, `call()` 8 of 8, `Lua function returns` 10 of 10, `callback edge cases` 5 of 5, `error handling` 8 of 8 |
| The 127-call script, debug and release | as above; the two WASM builds agree with each other exactly |
| `npm run oracle`, both WASM builds, with and without `--binary` | 2657 agree, 19 accepted, 2 disagree — unchanged, both the slice 3 refusal |
| Lua functions are released | 2,000 closures held from JS, then dropped and collected: Lua's memory went 15 KB → 409 KB → 34 KB (native: 19 → 608 → 38) |
| A function outliving its context | 300 contexts dropped with a function from each kept: 299 refuse with `Lua function is not usable: its Lua context has been destroyed`, on both targets |
| The build's own check | **41 of 41**, debug and release: 7 core cells, 7 stack cells, 24 exhaustion cells, 3 for the web variant |
| That check reports dirty | Before the shell guarded its entries, all 7 `mutual recursion` cells failed with the bare exception. With the stack-pointer repair removed, the `Lua recursing alone, repeated` cells fail and no other does. |
| Two cells were wrong first | One passed because `/lua boom/` also matched the chunk name in an unrelated error; it is anchored now. One recorded nothing because its own handler overflowed; it stores outcomes raw and fails as vacuous if every call ends alike. |
| clang-tidy with `/.clang-tidy` over `js.cpp` and `lua-wasm.cpp` | 0 findings; one reported and fixed by hand, one new suppression checked to be needed by removing it. Still not covered by `npm run lint` (Phase 5). |
| Release module | 441 KB raw, 171 KB gzip |
| The native target | untouched by this slice: `npm test` 1204 of 1204, `npm run lint` 0 findings, `npm run check-invariants` all match |

**Not done in slice 2, and stated so it is not assumed:** the function brand
is minted but nothing looks a function up by it yet — `create_coroutine`,
`call_async` and `release` are slices 5 and 7. The exact Lua release and the
Emscripten version are no longer read back from the module by the build's
check (the probe that reported them is gone); it checks `_VERSION`, and
`run.mjs` still refuses to build with any Emscripten but the recorded one.
`info()` restores the exact check in slice 7. Nothing has run in a browser.

#### Slice 3 — as built (November 24, 2026)

**Files.** `create_table`, `get_global_ref`, `create_environment` and
`execute_script_in` are members of `LuaContext` in `src/wasm/lua-wasm.cpp`.
The nine table-handle methods, the handle's iterator and its `next`, and the
five `Proxy` traps are non-member functions there, as they are natively, each a
port of the native function of the same name. They reach the context through
their handle's struct, so the members they use (`CallScope`, `CoreToNapi`,
`NapiToCoreInstance`, `CreateTableHandle` and three more) are public on this
`LuaContext`, again as natively; slice 2's `LuaFunctionCallback` moved out to
join them as `LuaFunctionCallbackStatic`. `RoundTripMarkerToCore` now
recognises a table handle or Proxy coming back in, refuses a released one,
and refuses one from another context with the native message.

**How a table reference is held.** The shell's "handles" section states the
scheme once for every handle kind; for tables:

| Native | Here |
|---|---|
| `LuaTableRefData` behind a tagged `External`, freed by its finalizer | the same struct as an Embind class; freed when the *owner* object is collected |
| `_tableRef`, hidden and non-configurable on a handle, configurable on a Proxy's target | the same property with the same attributes, holding the owner |
| the `External`'s type tag (`kTableRefData`) | the owner is a key in the shell's map of *table* owners. A function's owner presented as `_tableRef` is not in it and converts as a plain object, as natively |
| `_tableOwner` on each method and each trap, rooting the `External` (H3 / L6) | the same hidden property on each, rooting the owner |
| the handle: a plain object with nine enumerable methods and `[Symbol.iterator]` | the same, built by the shell; each method a function with the native one's `name` and a `length` of 0 |
| the Proxy: `get`, `set`, `has`, `ownKeys`, `getOwnPropertyDescriptor` | the same five traps, each calling the C++ function of the same name |
| the iterator: `next`, `[Symbol.iterator]`, hidden `__tableIterOwner` | the same |

**One deliberate difference, and a native defect behind it.** A table
iterator reads through its table's struct without owning it. Natively the
struct is kept alive by `info.This()` — the object the iterator method was
called on — which is the handle only when the method is called *as* a method.
Called with any other receiver, nothing keeps the struct alive, and once the
handle and the method are collected the cursor reads freed memory:

```js
let h = lua.create_table([7, 8, 9]);
let f = h[Symbol.iterator];
const it = f.call(undefined);
h = null; f = null;        // then let the collector run
it.next();                 // native: segmentation fault, 3 runs of 3
```

Found by reading the native function to port it, and confirmed by running it.
Here the shell roots the table's owner on the iterator's own owner, so the
struct is alive for as long as `next` can be called, whatever `this` was; the
same script returns `[1, 7]` and `[2, 8]`.

**Fixed natively on November 24, 2026, on the owner's instruction** — the
second edit D7 has allowed. A handle's struct is now `shared_ptr`-owned: one
share belongs to the `_tableRef` `External`, and each cursor takes another, so
the cursor owns what it reads instead of borrowing it. The two targets reach
the same behaviour by different means (ownership natively, rooting here), and
the port is not changed.

| Check | Unfixed source | Fixed |
|---|---|---|
| The script above, three runs | segmentation fault, 3 of 3 | `[1, 7]`, `[2, 8]`, 3 of 3 |
| The same shape under AddressSanitizer | `heap-use-after-free`, a read in `TableIteratorNext` | clean |
| Four new suite tests (`a cursor outlives the handle it came from`) | the worker dies with `SIGSEGV` | pass |
| New `gc-stress` pattern `table-cursor-outlives-handle` | the process dies before reporting | 2,400 operations, balanced |
| `npm test`, and the same suite under AddressSanitizer | — | 1208 of 1208, both |
| `npm run test-cpp`, `lint`, `binding-balance`, `lifecycle-matrix` | — | 286 of 286; 0 findings; clean; clean |
| `npm run check-invariants` | — | one frozen answer moved and was re-frozen: `scanner-coverage`, binding functions found 196 → 197 (the new `NewTaggedExternal` overload) |

A cursor still ends when its handle is released mid-loop and still refuses
after `reset()`; the last of the four tests checks that 300 abandoned cursors
give their tables back.

**Results**

| Check | Result |
|---|---|
| The suite, `LUA_NATIVE_TARGET=wasm` and `wasm-release` | 1173 tests: **421 pass on their merits** (309 after slice 2), 2 pass only because an absent method threw inside a broad `toThrow`, 750 fail. Of the failures, 720 call a method not yet ported and 30 hit a not-ported refusal; **none is unexplained.** |
| A scratch script of 233 calls across this slice's surface, both targets, diffed | **No difference**, debug and release — own keys and descriptors, function names, every error message, iteration under mutation and release, round trips, cross-context refusals, all three conversion modes. 156 of the calls return and 77 throw, so it is not agreeing on failure. |
| Slice 2's 127-call script | unchanged: the same three ledgered differences |
| `npm run oracle`, both WASM builds, with and without `--binary` | **2659 agree, 19 accepted, 0 disagree** — the two slice 3 refusals are gone, and the numbers are now the native target's exactly |
| Lifetimes under forced collection, both builds | 6,000 table references held and dropped: Lua's memory went 15 KB → 12,380 KB → 87 KB (native: 19 → 12,560 → 91). A method destructured off a dropped handle still works; a Proxy still works after `delete proxy._tableRef`; an owner object kept alone still stands for its table; 199 of 200 handles refuse once their context is collected, with the native message. |
| The build's own check | 41 of 41, debug and release |
| clang-tidy with `/.clang-tidy` over `js.cpp` and `lua-wasm.cpp` | 0 findings; thirteen reported (a parameter that could be `const`) and fixed by hand. Three new suppressions of the form slice 2 checked. Still not covered by `npm run lint` (Phase 5). |
| Release module | 503 KB raw, 184 KB gzip |
| The native target | untouched by this slice: `npm test` 1204 of 1204, `npm run lint` 0 findings, `npm run check-invariants` all match, `npm run oracle` 2659 / 19 / 0 |

**Not done in slice 3, and stated so it is not assumed:** `release(handle)`
on the context is slice 7 (a handle's own `release()` is here);
`set_metatable` on a handle is slice 4; the round-trip checks for a
Lua-created userdata, a coroutine and a class instance arrive with those
kinds. `cross-context` and `roundtrip-matrix` were tried on this target and
fail loudly at the first method a later slice ports (`reset`, and the doors
past the ninth), as intended.

#### Slice 4 — as built (November 24, 2026)

**Files.** `set_userdata`, `set_metatable`, `register_class`,
`register_type_converter` and `register_from_lua_converter` are members of
`LuaContext` in `src/wasm/lua-wasm.cpp`, each a port of the native member of
the same name, with their helpers beside them under the native names
(`ReadUserdataOptions`, `RegisterUserdataMethods`, `RollBackUserdata`, the
five `ReadClass…` readers, `BuildClassStatics`, `ReserveDeferredCallbacks`,
`CreateConstructorWrapper`, `NextUserdataId`). `InstallRuntimeHandlers` now
installs the userdata collection callback and the two property handlers,
which are `ReadUserdataProperty` and `WriteUserdataProperty` with
`FindClassAccessor`. `RoundTripMarkerToCore` recognises a Lua-created
userdata's handle and, through `ClassInstanceMarkerToCore`, a class instance.
The two converter loops were already in the conversion from slice 1; this
slice adds the methods that fill them. The shell gained five entries in its
method list, four `host` functions and two primitives (`callWith`,
`defineHidden`); `js.h` gained `CallWithThis`, `DefineHidden` and `Int32`.

**How each thing is held.**

| Native | Here |
|---|---|
| `js_userdata_`: id → `Napi::ObjectReference` plus the readable, writable and class-name fields | the same map, holding an `emscripten::val` |
| a Lua-created userdata crossing to JS: `{ _userdata: External }`, the External tagged `kUserdataData` and owning a `LuaUserdataData` | `{ _userdata: owner }`, the owner a key in the shell's map of *userdata* owners and registered for the struct's deletion; the property is an ordinary one, as natively |
| a class instance's four markers, defined non-enumerable and non-configurable but writable | the same four, defined the same way through a guarded `defineHidden`, so a frozen instance fails with the engine's own message as it does natively |
| `__luaClassOwner`: an External wrapping the runtime's address, compared for identity as a second barrier behind the id (CR-14 F2) | an owner object the shell maps to the constructing runtime's id; one is minted per instance, as natively. It cannot be minted from JS, and an id cannot be recycled the way an address can |
| `class_accessors_` holding `Napi::FunctionReference` halves, either of which may be empty | the same table holding `std::optional<val>` halves |
| an accessor called as `getter.Call(self, {self})` | `CallWithThis`, so `this` and the first argument are both the instance |

**An owner is not an object, and until this slice it was treated as one.**
Natively the value of `_tableRef`, `__luaFnOwner` or `_userdata` is an N-API
External: it fails every "is this an object" check in the binding and converts
to `nil`. Slices 2 and 3 minted owners as plain frozen objects and gave them no
kind of their own, so one passed *by itself* — `set_global('x', h._tableRef)` —
arrived in Lua as an empty table where native gives `nil`, and would have been
accepted by `set_userdata` as its object. Neither earlier diff script passed a
bare owner, so neither saw it. `host.kind` now reports an owner as its own kind
(`js::Kind::External`), which is what `napi_typeof` does, and the 22 calls in
this slice's script that pass one — as a global, nested, as a table key, to
`create_table`, as a metatable, as a class definition, as an environment —
agree with native.

**A marker that is read but not yet checked.** `RoundTripMarkerToCore` reads
`_tableRef`, `_userdata` and `_coroutine` and then asks for `__luaClassRef`, in
that order, and an object that observes its own property reads can see the
order. The coroutine check itself is slice 5, but the read is made now so that
the order is the native one; the script's logging `Proxy` records the same
sequence on both targets.

**One new difference, ledgered.** An error the *binding* constructs — the
fresh `Error` a throwing converter or property getter is rethrown as — has a
`stack` that begins in the shell and the module, because that is where it was
constructed. Natively the same error's stack begins at the JavaScript frame
that called in. The message, the name and the type are the same. It shows in
one call of 336, where a Lua script reads `e.stack` off such an error.

**Results**

| Check | Result |
|---|---|
| The suite, `LUA_NATIVE_TARGET=wasm` and `wasm-release` | 1177 tests: **632 pass on their merits** (421 after slice 3), 2 pass only because an absent method threw inside a broad `toThrow`, 543 fail. Of the failures, 517 call a method not yet ported and 26 hit a not-ported refusal; **none is unexplained.** |
| A scratch script of 336 calls across this slice's surface, both targets, diffed | **One difference**, the `stack` text above, debug and release. 228 of the calls return and 108 throw. It covers argument checks and their order, every refusal message, opaque, readable, writable and method-carrying userdata, getters and setters that throw an `Error`, a string, `null` or an object, a definition object's reads in order, a registration refused part-way and then retried, every `set_metatable` target form and 20 metamethod behaviours, 36 class-definition cases, inheritance to depth 2, 16 constructor cases (wrong return kinds, throws, a pooled object, a frozen one), forged instance markers, and both converter registries including a converter that registers another while it runs. |
| Slice 2's and slice 3's scripts | unchanged: slice 2's three ledgered differences, and none in slice 3's |
| `npm run oracle`, both WASM builds, with and without `--binary` | 2659 agree, 19 accepted, 0 disagree — the native target's numbers |
| Lifetimes under forced collection, native and both WASM builds, same output on all three | 200 userdata objects and 200 method functions are let go once Lua collects the userdata; 3,000 class instances likewise; 5,000 handles to a Lua-created userdata give their registry slots back for reuse; a superseded metatable's callbacks are let go; a context's converters, constructor and accessors go with the context; 100 handles from collected contexts are refused by another with the native message. |
| The build's own check | 41 of 41, debug and release |
| clang-tidy with `/.clang-tidy` over `js.cpp` and `lua-wasm.cpp` | 0 findings. Still not covered by `npm run lint` (Phase 5). |
| Release module | 583 KB raw, 210 KB gzip (503 and 184 after slice 3) |

**Not done in slice 4, and stated so it is not assumed:** the check on a
coroutine's marker is slice 5, as is a method or metamethod that returns a
`Promise` (refused here with the native message, since nothing can yet put the
runtime in the mode that awaits one). `info().bindingRefs` over the containers
this slice added, and `reset()` replaying them, are slice 7. No harness beyond
`oracle` runs on this target yet: each of the others needs a method from a
later slice and fails loudly at it.

#### Slice 5 — as built (November 24, 2026)

**Files.** `create_coroutine`, `resume`, `close`, `resume_async`,
`execute_async`, `call_async`, `cancel`, `is_busy`, `execute_script_async` and
`execute_file_async` are members of `LuaContext` in `src/wasm/lua-wasm.cpp`,
with the await driver beside them under the native names (`BeginAsyncRun`,
`DriveAsync` and its three exits, `OnAwaitSettled`, `FinishAsync`,
`ResolveAsyncCallTarget`, `CoroutineResultToJs`). The coroutine cursors and the
two await continuations are non-member functions, as natively.
`execute_file` is here too: no slice named it, and its async sibling needs
nothing it does not. A callback that returns a `Promise` now suspends the
coroutine where slices 1 to 4 refused it, and `RoundTripMarkerToCore` refuses a
coroutine from another context.

**How each thing is held.**

| Native | Here |
|---|---|
| `Napi::Promise::Deferred` | a `{ promise, resolve, reject }` record the shell makes from the intrinsic `Promise` captured at load |
| the coroutine object: `_coroutine` (an External owning a `LuaThreadData`), `status`, and two iterator factories each rooting its own `LuaContextBinding` | the same object built by the shell: three Embind handles, three owners |
| a cursor's state, `shared_ptr`-owned, rooted by a separate External on the iterator and on each method | one owner for the state, and a distinct root object per holder that keeps that owner alive, so the roots differ from one another as they do natively. The table iterator from slice 3 was changed to match. |
| the cursor's weak pointer to itself, used by the async `next` to root the function that maps the settled step | the shell's async `next` hands C++ the owner, and `coroAsyncMapper` roots it |
| the await cookie: an External rooted on both continuations | an Embind handle whose owner is the `__cookie` of both |
| `async_self_ref_`, a persistent reference to `info.This()` | a strong reference to the context's own JS object, which C++ reaches through a `WeakRef` in the shell's record. Weak there so that a handle does not keep its context alive; strong only for the length of a run. |
| the function's receiver, which an N-API function always sees as an object | the shell's functions are strict code, so they convert the receiver themselves where C++ is handed it (`receiverOf`) |

**D3 as built.** `execute_script_async` and `execute_file_async` validate,
mark the context busy, and return a promise at once; the shell takes the run up
in a later task (`setTimeout`, captured at load) and settles the promise there.
Between the call and that task the context answers as it does natively while a
worker is queued: `is_busy()` is true and every synchronous entry point
refuses. The script runs with host callbacks refused, exactly as on a worker.
`cancel()` before the run starts is honoured when a limit has installed the
instruction-count check and ignored when none has, which is the native rule.

**Three suite tests cannot pass on this target, by D3, and each occupies the
thread until its own limit ends it.** They start `while true do end` through
`execute_script_async` and call `cancel()` from a timer:

- `still honors cancel() during async execution`
- `L8: cancel() aborts a compute-bound worker run when maxInstructions is set`
- `F2: cancel() interrupts a worker run with only a timeout configured`

Natively the timer fires while the worker runs. Here the script has the only
thread, so the timer waits for the script, and the script ends when its 60
second `timeout` (or five billion instructions) does. The first full suite run
of this slice sat in them past ten minutes. They were set aside by name for the
tally below. Phase 3's ledger has to name them, and the suite has to skip them
on this target and not run them to their limit.

**A context that is unwound with a run in flight.** Slice 2's hazard has a new
edge: an async run suspended on a context that the engine's stack then unwinds
can no longer be driven. The context records its run's promise in the shell's
record (`run`); when a continuation arrives for an unwound context the shell
rejects that promise with the unwound message, so it is not left pending.

**Found in the port itself and fixed.**

| Found by | What | Fix |
|---|---|---|
| the suite's 600 MB result test | The shell's string and byte conversions were unguarded because they run no user code — but each can still be refused by the engine. A Lua string longer than the engine's longest string threw out of one, which unwound the module and cost the caller the context. Natively it is an ordinary error. In place since slice 1. | All four are guarded, and the test passes. |
| this slice's script | `coro[Symbol.iterator].call(undefined)` returned a cursor natively and threw here: an N-API function receives a missing or primitive receiver converted to an object. | `receiverOf`, above. |
| this slice's script | Anonymous callbacks were numbered from 0 here and from 1 natively, visible in one error message. In place since slice 2. | Numbered from 1. |

**One new difference, ledgered.** Whether a value *is* a promise is asked of
the engine natively. JavaScript can only ask whether the intrinsic prototype is
on the value's chain (the shell's `isPromise`, since slice 1). An object made
with `Object.create(Promise.prototype)` and returned by a callback is therefore
awaited here, and the await fails with the engine's "incompatible receiver"
error, where natively it converts as a plain object. A real promise, a subclass
instance and a plain thenable behave the same on both.

**Two more native defects, found by diffing.** Both behaved identically here,
because the port was faithful; neither was covered by the suite. **Both were
fixed natively on November 24, 2026**, in a separate session the owner started
— the third edit D7 has allowed — and the fix was ported here during slice 6
(see there). As found:

1. **A JavaScript function cannot be an argument to `call_async`,
   `resume_async` or an async cursor's `next`.** Each converts its arguments
   under a collector that closes before the driver's first step pushes them,
   so the callback is swept as never pushed. Lua then fails to call it:

   ```js
   lua.execute_script('function apply(g) return g(4) end');
   lua.call('apply', (x) => x * 10);              // 40
   await lua.call_async('apply', (x) => x * 10);  // rejects:
   // Host function '__js_callback_3' not found
   ```

   `resume()` keeps its collector open across the resume and works.
   A function nested in an object argument fails the same way.

2. **An async cursor's `next()` is not refused while another async run is in
   flight.** `resume_async` checks; the cursor calls the shared body directly
   and does not. The second run then drives the *first* run's thread, the first
   run's promise is never settled, and the cursor's coroutine is marked dead
   without its body having run:

   ```js
   const first = lua.execute_async('local v = gate()  return v');  // suspended
   const step = co[Symbol.asyncIterator]().next();
   await step;        // { value: <what the first run returned>, done: true }
   co.status;         // 'dead'
   // `first` stays pending for good
   ```

   The synchronous cursor has the check and answers "Lua context is busy with
   an async operation".

**Results**

| Check | Result |
|---|---|
| The suite, `LUA_NATIVE_TARGET=wasm` and `wasm-release`, the three D3 tests set aside | 1177 tests: **804 pass on their merits** (632 after slice 4), 2 pass only because an absent method threw inside a broad `toThrow`, 368 fail. Of the failures, 343 call a method not yet ported and 25 hit a not-ported refusal; **none is unexplained.** |
| A scratch script of 206 calls across this slice's surface, both targets, diffed | **Two differences, both accounted for**: the promise test above, and the D3 call, which answers "execution cancelled" natively and "execution timeout" here. 130 of the calls return or resolve and 76 throw or reject. |
| Slices 2, 3 and 4's scripts | unchanged |
| `npm run exec-parity -- --config=sandbox`, the configuration in which that harness drops its bytecode door | **runs on this target**: 5,356 cells over four doors, 5,350 agree, 6 accepted, 0 disagree — the native numbers. In its default configuration it still refuses to start, at the bytecode door (slice 6). |
| `npm run oracle`, both WASM builds, with and without `--binary` | 2659 agree, 19 accepted, 0 disagree |
| Lifetimes under forced collection, native and both WASM builds, same output on all three | 3,000 coroutine objects give their registry slots back for reuse; a cursor, a `next` taken off a cursor, and the function mapping an async step each keep what they need alive after everything else is dropped; a suspended run keeps its context alive and `cancel()` lets it go; a settlement arriving after that harms nothing; a deferred run keeps its context alive until it settles; 100 coroutines from collected contexts are refused. |
| The build's own check | 41 of 41, debug and release |
| clang-tidy with `/.clang-tidy` over `js.cpp` and `lua-wasm.cpp` | 0 findings; one reported and fixed by hand. Still not covered by `npm run lint` (Phase 5). |
| Release module | 660 KB raw, 230 KB gzip (583 and 210 after slice 4) |

**Not done in slice 5, and stated so it is not assumed:** `release(coroutine)`
is slice 7. Nothing has run in a browser, where the later task is the page's
and not Node's (Phase 4). The three D3 tests are not yet in a ledger.

#### Slice 6 — as built (November 24, 2026)

**Files.** `compile`, `compile_file`, `load_bytecode`, `add_search_path`,
`register_module`, `add_searcher`, `set_print_handler`, `set_read_handler`,
`set_file_reader`, `set_hook`, `remove_hook`, `get_stack` and `get_locals` are
members of `LuaContext` in `src/wasm/lua-wasm.cpp`, each a port of the native
member of the same name, with `InstallReadHandler`, `InstallFileReader` and
`InstallDebugHook` beside the `InstallPrintHandler` slice 1 brought. Nothing
new is held by the shell: a handler is a `val` on the context, as it is a
`Napi::FunctionReference` natively. The search paths and searchers are
recorded as natively, for `reset()` to replay in slice 7.

**D4 as built.** `compile()` and `compile_file()` answer with a plain
`Uint8Array`. `load_bytecode()` accepts what `napi_is_buffer` accepts — any
`ArrayBuffer` view — and refuses anything else with the native wording,
"Expected Buffer argument". Three suite tests cannot pass on this target for
that reason and no other: two assert `instanceof Buffer`, and one calls
`.toString('latin1')` on the result, which on a `Uint8Array` is the list of
decimals. With the three D3 tests they are the six tests the Phase 3 ledger
must name.

**A `DataView` is refused, as it is natively.** Natively a `DataView` handed
over as a value, as bytecode, or as what a read handler returns fails with
`Error: Invalid argument`: N-API agrees it is a Buffer and then declines to
read it as one. Since slice 1 this target had quietly converted its bytes.
Slice 6's script was the first to pass one, and the shell's byte reader now
raises the same error. Whether the native answer is the one intended is the
owner's question — the comments there list Buffer, TypedArray and ArrayBuffer
and do not mention it — and if it changes, this follows.

**The native async-door fixes, ported.** The session that fixed the two
defects from slice 5 also found a third of the same family: a run started
while a door is still converting its arguments (from a getter or a converter)
was overwritten by that door's own. Natively each coroutine-driven door now
re-checks for a run in flight after its last user JavaScript and rejects with
"Lua context is busy with an async operation"; `ResumeCoroutineObjectAsync`
checks on entry, so the async cursor cannot skip it; and `call_async` and
`resume_async` hold their argument collector open across the first step.
`ExecuteAsync`, `BeginAsyncRun`, `CallAsync` and `ResumeCoroutineObjectAsync`
here carry the same changes, the same assertion and the same message. Both
repros from slice 5 now print the same output on both targets, and the 13
tests that session added pass here.
phase
**Results**

| Check | Result |
|---|---|
| The suite, `LUA_NATIVE_TARGET=wasm` and `wasm-release`, the three D3 tests set aside | 1190 tests (13 added by the native fix): **963 pass on their merits** (804 after slice 5), 2 pass only because an absent method threw inside a broad `toThrow`, 222 fail. Of the failures, 194 call a method not yet ported, 25 hit a not-ported refusal, and 3 are the D4 tests above; **none is unexplained.** |
| A scratch script of 215 calls across this slice's surface, both targets, diffed | **One difference, by decision**: the constructor of what `compile()` returns (D4). 136 of the calls return and 79 throw. It covers bytecode through every accepted and refused container and under the guard, `require` through a search path, a registered module, a searcher and a file reader, each handler returning 12 kinds of value and throwing, all four hook events, and the stack and locals read from inside a callback and a hook. |
| Slices 2 to 5's scripts | unchanged |
| `npm run oracle` | 2659 agree, 19 accepted, 0 disagree, both builds, with and without `--binary` |
| `npm run exec-parity`, default configuration | **runs on this target**: 6,695 cells over five doors, 6,689 agree, 6 accepted, 0 disagree — the native numbers |
| `npm run capability-matrix` | **runs on this target**: 251 cells across 10 configurations, 0 findings — the native numbers |
| `npm run roundtrip-matrix` | **runs on this target**: 4,750 cells across 5 modes, 12 ledger entries, 0 undocumented, 0 parity disagreements — the native numbers |
| `cross-context`, `lifecycle-matrix`, `binding-balance` | each stops at `reset` or `info`, which are slice 7 |
| `crossing-cost` | stops at its own control `product/injected-slowdown`, which fails here; not looked into in this slice |
| Lifetimes under forced collection, native and both WASM builds, same output on all three | a replaced or cleared handler or hook is let go, 200 of 200; a superseded module's callbacks are let go; searchers and handlers go with their context; bytecode is a copy that outlives growth of the module's memory. |
| The build's own check | 41 of 41, debug and release |
| clang-tidy with `/.clang-tidy` over `js.cpp` and `lua-wasm.cpp` | 0 findings. Still not covered by `npm run lint` (Phase 5). |
| Release module | 718 KB raw, 244 KB gzip (660 and 230 after slice 5) |

**Not done in slice 6, and stated so it is not assumed:** the search paths,
searchers, handlers and hook are recorded for `reset()` but nothing replays
them yet (slice 7). The web variant's in-memory filesystem has not been
exercised, since nothing has run in a browser (Phase 4); under Node this
target reads the real disk. Whether bytecode compiled on one target loads on
the other was not tested.

#### Slice 7 — as built (November 24, 2026)

**Files.** `release`, `dispose`, `reset`, `gc`, `get_memory_usage` and `info`
are members of `LuaContext` in `src/wasm/lua-wasm.cpp`, with
`ReleaseObjectHandle`, `ReplayRuntimeSettings`, `ReplaySharedTables`,
`BindingRefCounts` and `SubscribeSharedTables` beside them under the native
names. `info().bindingRefs` reports the same thirteen names over this
binding's own containers. The refusal that stood in for an unported value kind
is gone, since no kind is unported.

**`reset()` replays what the native one does, in the same order:** the
bytecode guard, the filesystem seal and the table mode; the search paths and
the searchers under freshly minted names; the callbacks object; the print,
read and file handlers; the debug hook; and the shared tables. Handles from
before a reset refuse with the native message, and the retiring state is
closed when its last handle goes, or at once if it has none.

**The `shared` option, and the one place construction is split.** Subscribing
publishes each table through the context's own public `set_global`, as
natively. Here the JS object is not yet a context while the C++ side is being
constructed, so construction is two calls: `create`, then `subscribe_shared`
once the shell has made the object a context. The option is still the last one
read, a failure still throws from `new`, and a context whose first publish
failed is still never left in a table's subscriber list. `SharedTable` itself
stays in the shell, as before; C++ keeps what `reset()` needs.

**The two classes' public faces.** A JavaScript class refuses a call without
`new` in the engine's words and lists `constructor` first on its prototype;
what N-API's `DefineClass` hands out refuses in N-API's fixed words and lists
it last. `LuaContext` and `SharedTable` are each still a class inside, for the
private fields, behind a named constructor function that gives the native
answers. The prototype's methods are declared in the native order.

**A platform difference that is not on §1.1's list: the limits are 32 bits
wide here.** The core holds `maxMemory`, `maxInstructions` and `timeout` as
`size_t`, which is 64 bits natively and 32 on this target. A value past 2³²−1
saturates there, as `Infinity` does natively at 2⁶⁴−1. For memory that is the
address space itself, and for `timeout` it is 49 days. For `maxInstructions`
it is a real ceiling of about 4.29 billion: a script given a larger budget is
stopped at that one. Three suite tests assert that `Infinity` reports a limit
above `Number.MAX_SAFE_INTEGER` and fail on that assertion alone.

**Open with the owner** (with slice 2's three, which are unchanged):

4. **The instruction limit's width.** *Ruled November 25: all three limits
   widened to 64 bits in the core (Phase 3, "The rulings").* Either accept the 2³²−1 ceiling and add
   it to §1.1, or widen `max_instructions_` and its counter in the core to 64
   bits on both targets, which is a core change and needs the owner's word
   (D7). Recommended: widen those two, and list the memory and timeout
   ceilings in §1.1, where they cost nothing.
5. **`DataView`** (slice 6): whether the native "Invalid argument" is intended.

**The nine suite tests that do not pass, and one the tally miscounts, all
accounted for.**

| Tests | Why | What it needs |
|---|---|---|
| 3: `cancel()` from a timer during an unbounded deferred run | D3: the script has the only thread | the Phase 3 ledger, and a skip on this target so the suite does not sit in them |
| 3: `instanceof Buffer` twice, `.toString('latin1')` once | D4: bytecode is a `Uint8Array` | the Phase 3 ledger |
| 3: `Infinity` reports a limit above `MAX_SAFE_INTEGER` | 32-bit limits, above | decision 4 |
| 1: counted by the scratch tally as touching an absent method | a false positive of the tally: the test sets a property of its own, `__armed`, on the context | nothing; it passes |

**Results**

| Check | Result |
|---|---|
| The suite, `LUA_NATIVE_TARGET=wasm` and `wasm-release`, the three D3 tests set aside | 1190 tests: **1,181 pass** (963 after slice 6), counting the one the tally miscounts; 9 do not, as tabled. No test calls a method that is absent and none is refused as unported. |
| A scratch script of 194 calls across this slice's surface and the module's whole shape, both targets, diffed | **Two differing calls, one already-ledgered cause**: the two constructors are strict functions and so have no own `arguments` and `caller`, as slice 2 recorded for Lua functions. 117 of the calls return and 77 throw. It covers every method called after `dispose()`, `reset()` and its replay of each registration, handles held across a reset, every refusal from inside a callback, a converter, a getter and a finalizer, and 40 shared-table cases. |
| Slices 2 to 6's scripts | unchanged |
| **All ten harnesses run on this target, each with the native totals:** | |
| `oracle` | 2659 agree, 19 accepted, 0 disagree |
| `exec-parity` | 6,695 cells, 6,689 agree, 6 accepted, 0 disagree |
| `roundtrip-matrix` | 4,750 cells, 0 undocumented, 0 parity disagreements |
| `capability-matrix` | 251 cells, 0 findings |
| `cross-context` | 0 findings |
| `lifecycle-matrix` | 111 clean, 3 accepted, 0 vacuous, 0 findings |
| `binding-balance` | 42 cells over 13 containers, 0 findings — measuring this binding's own containers |
| `exception-matrix` | 507 of 507 cells clean, one process each |
| `crossing-cost` | release build: 20 cells, 0 failures, 0 vacuous. On the *debug* build it refuses at its control `product/injected-slowdown`: an unoptimised module's own cost per crossing is large enough that the work the control injects does not show. |
| `check-invariants` | reads the native sources and is the same on either target; it does not yet read `src/wasm/` (Phase 5) |
| `gc-stress` (a fixture, not a search) | no crash, no vacuous pattern, balanced, both builds |
| Lifetimes under forced collection, native and both WASM builds, same output on all three | 300 contexts are collected; 3,000 create-and-dispose cycles and 2,000 resets leave memory flat; a retired state is closed with its last handle; a shared table holds its subscribers weakly and a context holds its tables strongly; 20,000 released handles leave the registry small. |
| The build's own check | 41 of 41, debug and release; its first cell now reads the Lua release through `info()` (Lua 5.5.1) |
| clang-tidy with `/.clang-tidy` over `js.cpp` and `lua-wasm.cpp` | 0 findings. Still not covered by `npm run lint` (Phase 5). |
| Release module | 745 KB raw, 251 KB gzip |

**Phase 2 is complete. What it leaves for the phases after it:**

- **Phase 3:** `tools/wasm-ledger.mjs` does not exist yet. The differences it
  has to hold are the ones each slice recorded: D3 and D4; the 32-bit limits;
  hash order of converted table keys (slice 2); a strict function's missing
  `arguments` and `caller`, and `String(fn)` showing source (slice 2); the
  `stack` of an error the binding constructs (slice 4); and the
  prototype-chain promise test (slice 5). The six scratch diff scripts and the
  tally are throwaways in a scratch directory and are not in the repository.
- **Phase 4:** nothing has run in a browser. The exhaustion cells, the later
  task the deferred doors use, and the in-memory filesystem are each
  browser-specific and unmeasured.
- **Phase 5:** `npm run lint` and `check-invariants` do not read `src/wasm/`;
  `CLAUDE.md` does not mention the target.

### Phase 3 — verification under Node (**done November 25, 2026**)

| Item | State |
|---|---|
| 1. The control proving a run is on the WASM module | **Done** November 25: `tools/target.mjs` observes the module in every process that loads it. "As built", below. |
| 2. `npm test`, `gc-stress`, `binding-balance`, `lifecycle-matrix` | **Done**, during slice 7: 1,181 of 1,190 tests; the three instruments clean, unmodified. |
| 3. `oracle` | **Done**: 2659 agree, 19 accepted, 0 disagree, the native totals. |
| 4. `exception-matrix` | **Done**: 507 of 507 cells clean. |
| 5. `roundtrip-matrix`, `exec-parity`, `cross-context`, `capability-matrix` | **Done**: each with the native totals. |
| 6. `crossing-cost` | **Done** on the release build: 20 cells, 0 failures. It refuses on the debug build. |
| `tools/wasm-ledger.mjs` | **Done** November 25: eight entries, and `npm run verify-wasm` judges a run against them. It began with nine, seven of them in a third class, `unruled`; the owner ruled on all seven the same day. "As built" and "The rulings", below. |

The November 24 results are under "Slice 7 — as built". The order below is the regression
matrix from `CORRECTNESS.md` §15.7, run with `LUA_NATIVE_TARGET=wasm`:

1. **Control first.** Every run proves it is on the WASM module before any
   cell counts — the same rule `roundtrip-matrix` applies to its modes, since a
   run that was really on the native binary would report a clean column that
   searched nothing. The proof is an observation of the module, not the
   loader's own say-so: `compile('return 1')` returns a `Buffer` natively and a
   plain `Uint8Array` on WASM (D4). No new API is added to either target for
   this.
2. `npm test`, then `gc-stress`, `binding-balance`, `lifecycle-matrix` (U5 —
   if finalizer timing is different, everything downstream is suspect).
3. `oracle` — stock native Lua against Lua-in-WASM is a direct check on numeric
   formatting, integer/float behaviour and string handling on a 32-bit target.
4. `exception-matrix` — the instrument for U1 and U3 at full width.
5. `roundtrip-matrix`, `exec-parity`, `cross-context`, `capability-matrix`.
6. `crossing-cost` — run to learn the numbers, not to pass. See Phase 5.

**Differences are ledgered, not skipped.** A `tools/wasm-ledger.mjs` lists each
test or cell that is expected to differ on WASM, each with its reason, in two
classes: *target semantics* (the rows of §1.1) and *defect* (open, to be
fixed). A ledger entry that no longer matches anything is reported as stale,
per `tools/README.md`. A test that fails and is not in the ledger is a red run.

Not available on this target, stated once: the four native sanitizer harnesses.
Whether Emscripten's own sanitizers are worth wiring is a separate question
and not part of this plan.

#### As built (November 25, 2026)

**Files.** `tools/target.mjs` gains the control. `tools/wasm-ledger.mjs` is the
ledger and the functions that judge a run against it. `tools/wasm-verify/` is
the runner (`npm run verify-wasm`) and the one-process probe it spawns. The
suite gains one `beforeEach` that reads the ledger. Nothing in D7's table is
touched, and no API is added to either binding.

**The control is in the loader, so no run can go without it.** Every process
that imports `tools/target.mjs` constructs a context, calls
`compile('return 1')`, disposes the context, and compares what came back with
what `LUA_NATIVE_TARGET` asked for: a `Buffer` is the N-API binding, a plain
`Uint8Array` is this one, and anything else is refused. A mismatch throws from
the import, so the suite fails to load and a harness never starts. Putting it
in the loader and not in each of the thirteen importers means the two
one-process-per-cell harnesses get it in every cell, and a fourteenth importer
gets it without anyone remembering. It runs on a native run too, so a native
result is proven native by the same observation. That it can say no is shown
by `verify-wasm`'s controls, which load both modules in one process and hand
each to the check under the other's name.

**The ledger holds differences, and each is matched by something that runs.**
An entry is one difference. It names the suite tests it accounts for, or
carries a **probe**, or both. A probe is a few lines run on both targets, a
process each, with both answers frozen in the entry. This is what lets the
differences slices 2, 4 and 5 found by diffing scratch scripts — which are not
in the repository and which no suite test touches — sit in the ledger under
the stale rule. Without a probe each would have been a sentence nothing could
ever contradict.

| Verdict | When |
|---|---|
| accepted | A named test fails with the message the entry gives, or a named `not-run` test was skipped. |
| red | A test does not pass and is not named; or a named test fails with a different message; or a test is skipped that the ledger does not hold back. |
| STALE | A named test passes, or no longer exists; a `not-run` test ran; a probe sees the native answer on WASM. |
| MOVED | A probe sees an answer that is neither frozen one, on either target. Red. |

**The three D3 tests are held back, and the suite reads which from the
ledger.** `LUA_NATIVE_TARGET=wasm npm test` no longer sits in them. A test that
is never run cannot go stale by passing, so the ledger refuses such an entry
unless a probe stands beside it. The D3 entry's probe sets a timer during a
finite `execute_script_async` run and reports whether it fired before the run
settled: it does natively and does not here.

**A third class, which the plan did not have.** The plan names two classes,
*target semantics* (a row of §1.1) and *defect*. Seven of the nine entries are
neither: each is real and reproduces, none is on §1.1's closed list, and none
has been called a defect. Slices 2, 4 and 5 each wrote "ledgered" beside
theirs, but closing condition 2 rejects an entry whose reason is not a row of
§1.1, and the rule this project's ledgers follow is that an undocumented
difference is not ledgerable until it is fixed or specified. They are filed as
`unruled`, each naming where its decision is recorded. An entry in the
*target semantics* class cites a §1.1 row by its exact text, and the rows are
parsed out of this file, so the ledger cannot add to the list.

The ledger as first written, before the rulings below:

| Entry | Class | Matched by |
|---|---|---|
| `bytecode-is-a-uint8array` | §1.1, D4 | 3 tests |
| `deferred-doors-hold-the-thread` | §1.1, D3 | 3 tests held back, 1 probe |
| `limits-are-32-bits-wide` | unruled: slice 7, decision 4 | 3 tests |
| `js-stack-exhaustion-ends-the-context` | unruled: slice 2, decision 1 | 1 probe, run with `--stack-size=300` |
| `converted-table-key-order` | unruled: slice 2 | 1 probe |
| `strict-functions-lack-arguments-and-caller` | unruled: slice 2 | 1 probe |
| `function-source-text` | unruled: slice 2 | 1 probe |
| `binding-constructed-error-stack` | unruled: slice 4 | 1 probe |
| `promise-asked-by-prototype-chain` | unruled: slice 5 | 1 probe |

Three of §1.1's five rows have no entry: virtual files, `os` and `io`, and
finalizer timing. None shows as a failing test or a differing cell under Node,
where the verified variant has the real filesystem. A row is a permitted
difference, not a required one. The first two are Phase 4's to observe.

Slice 2's decisions 2 and 3 and slice 7's decision 5 are not ledger entries:
none of them is a difference between the two targets as built. They are
unchanged and still open.

**Results**

| Check | Result |
|---|---|
| `node tools/wasm-verify/run.mjs --control` | 28 of 28 controls fire: 7 on the target control, 8 on the ledger's own rules, 7 on the suite judge, 4 on the probe judge, 2 on the held-back list. |
| `npm run verify-wasm`, debug and release builds | The same on both. 7 of 7 probes hold. Suite: 1,221 tests, **1,212 pass, 9 differ as ledgered, 0 red, 0 stale**. Exit 0. (1,221 and not slice 7's 1,190: this count includes the 31 tests of `invariants.spec.ts`, which read source and pass on any target.) |
| `node tools/wasm-verify/run.mjs --harnesses` | Every instrument exits 0 on this target: `gc-stress` balanced; `binding-balance`, `lifecycle-matrix`, `cross-context` and `capability-matrix` 0 findings; `oracle` 2659 agree, 19 accepted, 0 disagree; `exception-matrix` 507 of 507; `roundtrip-matrix` 4,750 cells, 0 undocumented, 0 parity disagreements; `exec-parity` clean; `crossing-cost` on the release build, 20 cells, 0 failures, 0 vacuous. |
| `node tools/wasm-verify/run.mjs --closing`, before the rulings | Exit 1, as it should be: 7 `unruled`, 0 `defect`. |
| The first run of the verifier | Two probes MOVED, and both were the probes' own mistakes: one froze the wrong native answer for the error's stack, one called `type` in a context with no libraries. Recorded because the frozen native answer being checked *on the native target* is what caught them; a probe that only compared the two targets would have reported each as a difference. |
| An unplanned red run | While this section was being written, a sentence in it moved a `perf-claims` count, `invariants.spec.ts` failed on both targets, and the verifier reported that test RED: failing, and not in the ledger. The sentence was reworded and nothing was re-frozen. It is the one time the suite judge has said no to a real run and not a synthetic one. |
| **The native target, with the control now in its loader:** | |
| `npm test` | 1,221 of 1,221 |
| The ten instruments and `gc-stress`, no variable set | each exits 0 with the totals it had before |
| `npm run check-invariants` | all match, nothing re-frozen |

No C++ was changed, so `npm run lint` and `npm run test-cpp` were not re-run.

#### The rulings (November 25, 2026)

The owner ruled on all seven `unruled` entries the same day. "As built" above
describes the ledger as it was first written; this is what it became.

| Entry | Ruling | Effect |
|---|---|---|
| `limits-are-32-bits-wide` | **A defect. Fix it: widen all three limits.** | Core change, below. The entry went STALE on the next run — three tests "ledgered as failing, and it passes" — and was removed. |
| `js-stack-exhaustion-ends-the-context` | A permitted difference. | Row added to §1.1. Slice 2's decision 1 is closed; its decisions 2 and 3 are not. |
| `converted-table-key-order` | A permitted difference. | Row added to §1.1. |
| `strict-functions-lack-arguments-and-caller`, `function-source-text` | Permitted, as one difference. | One row added to §1.1, cited by both entries. |
| `binding-constructed-error-stack` | A permitted difference. | Row added to §1.1. |
| `promise-asked-by-prototype-chain` | A permitted difference. | Row added to §1.1. |

§1.1 has ten rows where it had five. The ledger has eight entries, all in the
*target semantics* class, and the `unruled` class is empty. It stays in the
ledger's vocabulary: the next difference found will need somewhere to wait.

**The limits, and the fourth exception to D7.** `maxMemory`, `maxInstructions`
and `timeout` are `std::uint64_t` in the core where they were `size_t`: the
three `RuntimeConfig` fields, the allocator's limit, `max_instructions_` and
its counter, `timeout_ms_`, and the setters and getters. A limit is a number
the caller chose, not the size of anything in the address space. Natively the
two types are the same width and the N-API binding is not edited. The WASM
binding reads the three options through a 64-bit `LimitFromNumber` and holds
them in 64-bit fields; `SizeLimitFromNumber` stays for the one remaining
`size_t`, the `gc` step size. `Infinity` now saturates at 2⁶⁴−1 on both targets
and the three tests pass on both.

**A native defect, found before the change and not by it.** Before widening
`timeout`, its behaviour at the new width was tried on the native target,
which already has that width:

| `timeout` | Native, before | WASM, before |
|---|---|---|
| `Infinity`, 2⁶³, 2⁶² | a two-million-iteration loop is ended at once with "execution timeout" | runs (clamped to 49 days) |
| 10¹⁶, 10¹⁵, 2³²−1, 60000 | runs | runs |

The core computed the deadline as `now() + std::chrono::milliseconds(ms)`.
2⁶⁴−1 read as the signed count that type holds is minus one, a deadline already
past; and anything beyond roughly 292 years overflows on its way to
nanoseconds, which is undefined and happened to come out past for 2⁶² and
future for 10¹⁶. The suite's test of `timeout: Infinity` is named `is not
"unlimited by accident"`; it reads the limit back and runs `return 1 + 1`,
which ends long before the count hook first fires, so it never met the
deadline. The WASM target was right only because of the width this ruling
removes, so widening without a fix would have carried the defect across.

The owner was asked before the core was edited and chose to fix it: a new
file-local `DeadlineAfter` returns the clock's last instant when the timeout
does not fit before it, and both places that set `deadline_` use it. Native
behaviour changes for those values only. Seven tests were added — six in the
suite, which run a script long enough to be checked under each limit at
`Infinity` and under three out-of-range timeouts, and one in the C++ suite —
and the three that exercise the overflow were seen to fail on the unfixed
native build first.

**Results, after the rulings**

| Check | Result |
|---|---|
| `npm run build-wasm-debug`, `npm run build-wasm-release` | both build; the build's own check 41 of 41 on each |
| `node tools/wasm-verify/run.mjs --harnesses --closing` | **Exit 0.** 7 of 7 probes hold. Suite: 1,227 tests, 1,221 pass, 6 differ as ledgered, 0 red, 0 stale. Every instrument exits 0 with the totals it had. Closing condition 2: 8 *target semantics*, 0 `unruled`, 0 `defect`. |
| The same, `--target=wasm-release --closing` | Exit 0, the same counts. |
| The stale rule, on a real run | Between the fix and the ledger edit the verifier was run once: 3 STALE, "ledgered as failing, and it passes", exit 1. |
| Native `npm test` | 1,227 of 1,227 (1,221 before the six new tests) |
| Native `npm run test-cpp` | 287 of 287 (286 before the new one) |
| `npm run test-cpp-asan` | 287 of 287 under ASan and UBSan, no report. Run with the fix in; the unfixed deadline arithmetic was not run under it. |
| Native instruments and `gc-stress`, no variable set | each exits 0 with the totals it had |
| `npm run lint` | 0 findings |
| `npm run check-invariants` | one frozen answer moved and was re-frozen after reading it: the core's function count, 207 to 208, which is `DeadlineAfter` |

**What Phase 3 leaves.** `CLAUDE.md` does not yet
mention `verify-wasm`, the ledger or the control; that is Phase 5's edit, with
the rest of the target's commands. The ledger reads §1.1 from this file, and
Phase 5 moves that list to `docs/WASM.md`: `PERMITTED_DIFFERENCES` in
`tools/wasm-ledger.mjs` is the one line to change when it does.

### Phase 4 — the browser (**done November 25, 2026, in two engines; Gecko not run**)

- **`browser.js`.** Instantiates the web variant with top-level `await` and
  exports the same default object as `index.js`. `browser.d.ts` per D4.
- `package.json`: the `exports` map in D6. `files` gains the browser entry,
  its types and the release `.wasm`. Checked by resolving `lua-native`,
  `lua-native/types.d.ts` and `lua-native/package.json` from a packed tarball
  under Node, and the bare specifier under a bundler's `browser` condition.
- A static smoke page that loads `browser.js` and runs a fixed script set:
  values each way, an error each way, a JS callback that throws, a coroutine,
  an awaited Promise through `execute_async`, a `timeout` on a busy loop (U8),
  `compile`/`load_bytecode` with no `Buffer` global, both D3 doors, a table
  reference dropped and collected, and a file served by `setFileReader`.
- The same set with the VM hosted in a Web Worker, since that is the
  recommended way to keep a page responsive under D3.
- Run by hand in the built-in browser pane and in one other engine. Recorded in
  `docs/WASM.md` with the date and browser versions.
- Files: the browser story is `setFileReader` and `filesystem: 'deny'`, both of
  which already exist. Preloading files into the in-memory filesystem is not
  planned.
- Record the release `.wasm` size, raw and gzip.

#### As built (November 25, 2026)

**Files.** `browser.js` and `browser.d.ts` at the root, beside `index.js`.
`package.json` gains the `exports` map and three entries in `files`.
`tools/wasm-smoke/` is the smoke set, its page and worker, the server that
serves them, and a Node run of the same set. `tools/wasm-package/` checks the
packed tarball. Nothing in D7's table is touched.

**`browser.js` is one line.** The web variant's shell already instantiates the
module with a top-level `await` and exports the default object, so the entry
is a static re-export of `build-wasm/release/web/lua-native.mjs`. Static so
that a bundler follows it, and follows the glue's
`new URL('lua-native-core.wasm', import.meta.url)` to the `.wasm`, with no
plugin. The three web files ship from where the build writes them: `files`
lists `build-wasm/release/web/*`, so there is no copy step that could go stale.
The published path is the build's own; a tidier name would be a copy.

**`browser.d.ts`** re-exports `types.d.ts` and restates `compile`,
`compile_file` and `load_bytecode` with `Uint8Array` (D4). Checked with
TypeScript 5.9.3 against a small consumer, including a line that must fail
(`.toString('latin1', 0, 1)` on the result) and one that must still hold on the
Node entry (`compile()` is a `Buffer`); and the same consumer with the browser
result typed as a `Buffer` is refused. TypeScript is not a dependency of this
repository, so that check is not a script.

**The package** (`npm run check-package`). Packs the tree, unpacks the tarball
as a dependency of an empty project outside the repository, and asks from
there:

| Check | Result |
|---|---|
| The tarball | 13 files: the four it had, `browser.js`, `browser.d.ts`, the three web files, the two prebuilds, `README.md`, `LICENSE`. No source, tooling or other build output. |
| Under Node | `lua-native` is `index.js`; `lua-native/types.d.ts` and `lua-native/package.json` resolve. |
| Under Node with `--conditions=browser` | `lua-native` is `browser.js`. |
| Controls | `lua-native/prebuilds/…`, `lua-native/index.js` and the web shell by path are each `ERR_PACKAGE_PATH_NOT_EXPORTED`: the map is in effect, and D6's accepted consequence is real. |
| rolldown 1.2.19, `platform: 'browser'` | Takes `browser.js`, the shell and the glue; not `index.js`; nothing from Node in the bundle. It leaves the `.wasm` reference as written, so that file has to be served beside the bundle. |
| `vite build` 8.3.8, no configuration | Emits the `.wasm` as an asset, byte for byte the release one, and the script refers to the emitted name. |

**The smoke set** is 24 cells in one module with no imports
(`tools/wasm-smoke/set.mjs`), so the same file runs in a page, in a worker and
under Node. The plan's list is all there — values each way, an error each way,
a callback that throws, a coroutine, an awaited Promise, `timeout` on a busy
loop, bytecode with no `Buffer` global, both D3 doors, a table reference
dropped and collected, a file served by `set_file_reader` — and what the
slices left for this phase is added: the exhaustion cells, the stack cell, the
in-memory filesystem, `os` and `io`, and the three limits at `Infinity`.

Two things keep it honest. **It is run on the native addon first**
(`node --expose-gc tools/wasm-smoke/run.mjs`): a cell that is wrong about
lua-native fails there, where the suite has already settled the answer. That
caught one on its first run, a coroutine cell that passed a body where the API
takes a script returning a function. **And its control** runs the set against a
module whose every script answers nothing, on both targets, and requires all
24 cells to fail.

The page imports `/browser.js`, the package's real entry, runs the set on the
main thread, runs it again in a module worker, and posts each result to the
server that served it, which is how a browser that cannot be driven from here
was read. The server sends no cross-origin isolation headers, and every report
has `crossOriginIsolated: false`.

**Results, November 25, 2026, macOS 27.2.1 on arm64**

| Engine | Main thread | Web Worker |
|---|---|---|
| Chromium 156.0.8078.100 (V8), the Claude desktop app's browser pane | 24 of 24 | 24 of 24 |
| Safari 27.2 (WebKit, JavaScriptCore) | 24 of 24 | 24 of 24 |
| Node 24.22.3, native addon — the check on the set | 24 of 24 | |
| Node 24.22.3, node variant of the release build | 24 of 24 | |

No cell failed and none was inconclusive. **Gecko was not run**: Firefox is not
installed on this machine. The debug web variant was not run in a browser.

**What the two engines answered that Node could not:**

| Question | Answer |
|---|---|
| Does each engine accept the module's exception-handling instructions (§8)? | Both load and run it. |
| U8: does `timeout` end a busy loop on a page's main thread? | Yes, in both, on the main thread and in a worker, and through a deferred door. |
| The later task a deferred door uses | The run settles before a timer set after the call fires, on both threads in both engines: the script holds its thread, as D3 says. |
| The in-memory filesystem | A file Lua writes with `io.open` under `os.tmpname()` can be run by `execute_file` and `execute_file_async`; a missing path is refused. `set_file_reader` serves `dofile` with `filesystem: 'deny'`. |
| U7, `os` and `io` | The same four answers everywhere: `os.getenv("HOME")` is `/home/web_user`; `os.execute()` is `false`, no shell; `os.execute("exit 3")` fails with status 52; `io.popen` raises. Each works or says no. |
| Is a dropped table reference collected with no `gc()`? | Yes. The Lua table was freed within one round of allocation everywhere except the Safari worker, which took thirteen. |

**The engine's stack is a different size on every thread, and one of them is
small.** This is the finding of the phase.

| Thread | Deepest chain of Lua C calls | JavaScript and Lua calling each other |
|---|---|---|
| Chromium, main | Lua's own limit (198) | Lua's own limit (198); the context survives |
| Chromium, worker | Lua's own limit (198) | the engine's stack ends it at 132; the context is lost |
| Safari, main | Lua's own limit (198) | Lua's own limit (198); the context survives |
| **Safari, worker** | **the engine's stack ends it at 102**; the context is lost | the engine's stack ends it at 27; the context is lost |

Every outcome is the fail-closed one slice 2 built: an `Error` and never a raw
`WebAssembly.Exception`, the context either works or refuses, and a fresh
context works afterwards. So nothing here is a defect, and the row added to
§1.1 by the Phase 3 rulings covers it. But the advice this plan gives — host the VM in a
Web Worker so a running script does not hold the page — puts it on the thread
with the least stack. In a Safari worker, Lua code that recurses through C more
than about a hundred deep (a `string.gsub` callback chain, nested
`pcall`/metamethod calls) ends its context, where everywhere else it gets
Lua's "C stack overflow" and carries on. A callback chain between JavaScript
and Lua gets 27 levels.

**Open with the owner.** Slice 2's decision 3 — a depth limit on this target —
was left open with "not adopted here" because it is visible API and the hazard
looked remote. These numbers are the evidence it lacked. The choices, none
taken:

1. Leave it, and document the Safari worker figure in `docs/WASM.md` (Phase 5).
2. Lower Lua's C-call limit on this target (`LUAI_MAXCCALLS`, in the overlay
   triplet), so Lua's own error arrives before the engine's on every thread
   measured. It changes what a deep script sees on WASM and needs a row.
3. Slice 2's nested-call limit for the JavaScript-and-Lua chain.

**Not done, and stated so it is not assumed.**

- `docs/WASM.md` does not exist yet. This phase's bullet says the run is
  recorded there; it is recorded here, and Phase 5, which creates that file,
  carries it over.
- The run was driven from a tool session and not by hand. The built-in pane
  was read through its accessibility tree; Safari was opened with `open -a` and
  read from what its page posted back.
- The bundles `check-package` builds are inspected, not executed in a browser.

**Sizes of what ships**, release build:

| File | Raw | gzip -9 |
|---|---|---|
| `lua-native-core.wasm` | 746,116 | 250,165 |
| `lua-native-core.mjs` | 99,676 | 26,073 |
| `lua-native.mjs` | 38,275 | 11,944 |

### Phase 5 — instruments, documentation and release (**done November 25, 2026**)

A second binding is surface no row in `CORRECTNESS.md` §15.6 anticipates, and
four instruments read the native binding by path (§2.1). Each gets a ruling;
none is left reading one binding while two ship.

- **`check-invariants`.** For each invariant that scans `src/lua-native.cpp` —
  the `CallScope` classification, `core-call-guarding`, `liveness-guarding`,
  `exception-surface`, `scanner-coverage`, `objectwrap-branding`, and
  `surface-census` — either extend it to
  `src/wasm/lua-wasm.cpp` with its own frozen answers, or write down why it
  does not apply. The N-API-specific ones (type tags, `ObjectWrap`) need a
  counterpart for the brand rule rather than a copy.
- **A parity census.** New: the set of public methods and options derived from
  each binding's source and from `types.d.ts`, required to be equal. A door
  added to one binding and not the other then turns the suite red on its own,
  which is what makes D1's permanent cost visible.
- **`npm run lint`.** Per U10.
- **§15.6.** Add the row "a second binding or build target" with a disposition
  — `surface-census` reads that table and reports `UNDISPOSED` otherwise — and
  add the WASM run to §15.7's matrix. Amend §14 and §15.4 per D0.
- `docs/WASM.md`: a current design reference — how to build, how to load, the
  §1.1 differences, the two-binding rule. Linked from `docs/README.md`.
- `docs/FEATURES.md`, `docs/LIMITATIONS.md`, `README.md`: one section each.
- `docs/RELEASING.md`: the WASM build joins `prebuildify` as a required step,
  because neither artifact is committed.
- `CLAUDE.md`: the new commands, `tools/target.mjs` and its switch, the second
  row in the architecture section, and the rule that a change to one binding
  is a change to both.
- **Measured claims.** Every such claim in the shipped docs was measured on the
  native build. Either scope them to it in one sentence, or measure them again
  on WASM. `perf-claims` will object to any new claim-shaped sentence in
  `docs/WASM.md` that has no `crossing-cost` cell — which is the mechanism
  working, not an obstacle to route around.
- Move this file to `docs/reviews/` with a superseded banner when §6 is met.

#### As built (November 25, 2026)

**Each bullet above, and what became of it.**

| Bullet | Outcome |
|---|---|
| `check-invariants` | **A ruling per invariant**, recorded at the top of `tools/invariants/wasm-binding.mjs`. Six are extended under ids beginning `wasm:`; `objectwrap-branding` has a counterpart, `wasm:brand-rule`; three read the core, the suite or the docs and are the same on either target; `surface-census` holds by parity. Census F is not carried, and §15.6 says so. |
| A parity census | **`binding-parity`.** Context methods, shared-table methods, table-handle methods, Proxy traps, module exports and every option name, each derived from `types.d.ts`, the native binding and the WASM binding and required equal; plus the functions that exist in one binding's C++ and not the other's, frozen by name. |
| `npm run lint` | Covers `src/wasm/` with the flags `em++ --cflags` reports. 4 translation units, 5 headers, 0 findings. `--native-only` leaves it out and says so. |
| §15.6, §15.7, §14, §15.4 | Two rows added to §15.6 with dispositions, one `FAILS-CLOSED` and one `MANUAL`; the WASM lines added to §15.7; §14 carries the amendment and §15.4 the second target. |
| `docs/WASM.md` | Written, and linked from `docs/README.md`. It holds the closed list, which the ledger now reads from there. |
| `FEATURES.md`, `LIMITATIONS.md`, `README.md` | One section each. |
| `docs/RELEASING.md` | Step 2a: the WASM build, its verification and the smoke page, before the tarball check. |
| `CLAUDE.md` | The commands, the "Two bindings" section, `browser.js`, the limits' type. |
| Measured claims | **Scoped, not re-measured.** One sentence in `README.md`: every measured cost figure there and in `types.d.ts` was taken on the native addon. No claim-shaped sentence was added to the shipped docs; `perf-claims` reports none. |
| Move this file | Done, with the banner above. |

**The analyses are shared and only the answers are separate.** The native
invariants' functions take the binding's path and its spelling of "can run user
JS" and "is an entry point" as parameters, defaulting to the native ones. The
WASM invariants call those same functions. No native answer moved when they
were parameterised, which was checked before anything was added.

**What the extended invariants found.** Nothing in the binding. Asked of the
WASM binding, `core-call-guarding` returns the native answer row for row — 55
guarded, 5 contained by their callers, and the one justified false positive,
for the same line of code. `liveness-guarding` returns a subset of the native
rows. The occupancy policies are equal. `binding-parity` is equal on every
surface. That is the expected result of a port that kept the native names and
was diffed call for call while it was written, and it is worth less than it
looks until the instrument is shown able to say otherwise:

| Mutation, applied to the source and then restored | Reported |
|---|---|
| A public method dropped from the shell's list | `binding-parity`: MISSING from the wasm shell |
| The receiver check removed from the context's method template | `wasm:brand-rule`: NO |
| A struct pointer taken from a lookup with no kind map | `wasm:brand-rule`: UNGUARDED |
| An occupancy policy changed in this binding only | `wasm:occupancy-policy-sites`: NO |
| An option key renamed in this binding only | `binding-parity`: UNEXPLAINED |
| A naming violation planted in `src/wasm/js.cpp` | `npm run lint`: 4 findings, FAILED |

**What it found in the instruments.** Three false readings, each fixed in the
instrument and recorded in `tools/README.md`: the shared C++ scanner named an
operator definition after its line number; both call-graph analyses matched a
callee by bare name and so took `js::Construct(` for a call to
`LuaContext::Construct`, which scored two construction-only helpers as
reachable from JavaScript; and the parity census's first draft reported four
kinds of difference that were all its own.

**One frozen native answer moved, as the plan required.** `surface-census`
reads §15.6's trigger table out of `CORRECTNESS.md`, so adding the two rows
moved its row count from 14 to 16 and two disposition counts by one each. No
other native answer changed in this phase.

**Closing condition 1** was checked here, since no earlier phase had: with
`build-wasm/` deleted, `npm run build-wasm-release` produces both variants and
its own check passes 41 of 41; the two `.wasm` files and the two glue files
contain no `napi` or `emnapi` string; nothing under `src/wasm/`, `src/core/`
or the build script includes an N-API header.

**Not done, and stated so it is not assumed.**

- **Census F for the WASM binding.** A new `emscripten::val` member that
  retains a JS value does not fail closed. Recorded in §15.6 as a manual
  trigger.
- **The claims were not measured on WASM.** `crossing-cost` runs on the
  release build and passes its 20 cells, which says each documented claim's
  *shape* holds there; the figures in the docs remain the native ones.
- **TypeScript is not a dependency**, so the check that `browser.d.ts` types a
  consumer correctly was run by hand with a compiler from elsewhere on the
  machine and is not a script.

**Results, with everything rebuilt after the last source change**

| Check | Result |
|---|---|
| `npm run check-invariants` | 20 invariants, all match: the 12 there were, 7 under `wasm:`, and `binding-parity` |
| `npm run lint` | 4 translation units, 5 headers, 0 findings |
| Native `npm test` | 1,236 of 1,236. The count grew by nine in this phase: eight new invariants, each a test, and one scanner control. |
| `node tools/wasm-verify/run.mjs --harnesses --closing` | Exit 0. Suite: 1,236 tests, 1,230 pass, 6 differ as ledgered, 0 red, 0 stale. Every instrument exits 0 with the totals it had. 8 *target semantics*, 0 `unruled`, 0 `defect`. |
| The same, `--target=wasm-release --closing` | Exit 0, the same counts. |
| `node --expose-gc tools/wasm-smoke/run.mjs` | Controls fire; 24 of 24 on the native addon and on the node variant |
| The smoke page, against the rebuilt module | 24 of 24 on the main thread and in a Web Worker, in Chromium 156 and Safari 27.2 |
| `npm run check-package` | every check passes |
| `npm run build-wasm-debug`, `npm run build-wasm-release` | 41 of 41 each |

The native instruments were last run after the core change in Phase 3 and
nothing they load has changed since. `npm run test-cpp` likewise: 287 of 287,
and under ASan and UBSan.

### Phase 6 — threaded build (separate decision, not part of the closing condition)

`-pthread`, a thread pool and the cross-origin isolation headers would let the
two D3 doors leave the page's thread. Before starting: resolve the main-thread
mutex hazard in §2.2, and accept that §15.6 classifies this as a new threading
mode. Only worth doing if a real page needs it and cannot use a Web Worker.

---

## 5. Out of scope

- **N-API in the browser**, real or emulated (D1).
- **Loading the WASM module in Node as a product.** Node consumers get the
  native addon. The node-variant WASM build exists to verify the binding and is
  not published.
- **Electron.** The addon already loads natively there (`docs/ELECTRON.md`).
- WASI and non-browser WASM runtimes; 64-bit WASM memory.
- CI in any form, and anything about the Windows target (§14).
- A worker pool (bridge-gap A5 remains a scope decision).
- Replacing the native build, changing its loader order, or refactoring the
  native binding to share code with the new one (D2, shape C).

---

## 6. Closing condition

**State on November 25, 2026, after Phase 5: all seven met.**

| # | State |
|---|---|
| 1 | **Met.** From a deleted `build-wasm/`, `npm run build-wasm-release` produces both variants, 41 of 41; no `napi` or `emnapi` in either `.wasm` or either glue file, and no N-API header included by anything the target is built from. Phase 5, "As built". |
| 2 | **Met.** `node tools/wasm-verify/run.mjs --harnesses --closing` exits 0: every non-passing test is in the ledger with a reason, zero stale entries, zero in the *defect* class, and all eight entries cite a row of the closed list. It stood at seven `unruled` entries until the owner ruled on them. Phase 3, "The rulings". |
| 3 | **Holds, with four exceptions the owner approved.** The fourth is the limits and the deadline in `src/core/lua-runtime.{h,cpp}`. The native suite, `test-cpp`, `lint` and `check-invariants` are green. Two frozen native answers moved: the core's function count, 207 to 208 (the fourth exception), and `surface-census`'s trigger-row counts (the §15.6 rows Phase 5 was required to add). |
| 4 | **Met.** 24 of 24 cells on the main thread and in a Web Worker, in Chromium 156.0.8078.100 and Safari 27.2. Phase 4, "As built". |
| 5 | **Met.** Every invariant that reads the native binding has a ruling, and `binding-parity` is green. Phase 5, "As built". |
| 6 | **Met**, U8's browser half included (Phase 4). |
| 7 | **Met.** `docs/WASM.md` exists and §14 carries the amendment. |

All of these, each checkable by running something:

1. `npm run build-wasm-release` produces both variants from a clean tree, and
   neither links or includes anything from N-API or emnapi.
2. With `LUA_NATIVE_TARGET=wasm`: `npm test` and all ten harnesses finish with
   every non-passing cell present in the WASM ledger with a reason, zero stale
   ledger entries, zero entries in the *defect* class, and no entry whose
   reason is not a row of §1.1.
3. **The native target is untouched (D7).** `git diff` against the commit this
   work started from is empty for every path in D7's table, with three
   exceptions the owner approved: the added `#include <cstdlib>` line in
   `src/core/lua-runtime.cpp`, the table-iterator fix in
   `src/lua-native.{h,cpp}` ("Slice 3 — as built"), and the async-door fixes
   there ("Slice 5 — as built"). (A fourth was approved on November 25: the
   limits' width and the timeout deadline in `src/core/lua-runtime.{h,cpp}`,
   Phase 3, "The rulings".) Without the
   variable, `npm run build-debug && npm test && npm run test-cpp`,
   `npm run check-invariants` and `npm run lint` are green, and every frozen
   answer about the native binding in `tools/invariants/expected.json` is
   unchanged apart from what those two fixes moved — the only other
   differences in that file are additions for the WASM binding, and the core's
   function count, which the fourth exception moved by one.
4. The Phase 4 smoke set passes on the main thread and in a Web Worker, in two
   browser engines, with versions recorded.
5. Every invariant that reads the native binding has a ruling for the WASM
   binding, and the parity census is green.
6. U1–U10 each have a written answer in §3.
7. `docs/WASM.md` exists and §14 carries the amendment.

---

## 7. Predictions (November 24, 2026)

Written before any code, so execution can score them. They replace the
November 22 set, which was written for the emnapi route.

1. The C++ Google Test suite passes as WASM with **no source change**, only
   build flags.
   **Scored: wrong as written.** Two missing `#include`s stop it compiling.
   With those supplied from the command line it passes, 286 of 286.
2. The stock `wasm32-emscripten` triplet's `liblua.a` is usable as built: cell
   A passes and **no overlay triplet is written**. (Revised the same day,
   before anything ran. The first draft predicted the overlay would be
   necessary; reading what the stock triplet passes to a C compile, §2.1 and
   §2.2, is what changed it.)
   **Scored: wrong, and the first draft was right.** The reading was correct
   about what the stock library is; it did not ask whether the exception mode
   that library requires is one this code can live with.
3. Cell B fails — the stock library does not work under `-fwasm-exceptions` —
   so the flag set that ships is JavaScript-based exceptions and `longjmp`,
   on every object including Lua's.
   **Scored: half.** Cell B fails, at link. The flag set that ships is the
   opposite one.
4. `execute_async`, `call_async` and `resume_async` need no `ASYNCIFY`, because
   they yield with `lua_yieldk` and resume from a `.then` callback.
   **Scored: right.** The three doors are built with no `ASYNCIFY` and
   `exec-parity` reports them equal to `execute_script` on 6,689 of 6,695
   cells, the native figure.
5. The WASM binding lands between 4,000 and 6,000 lines of C++ and under 800
   lines of JS shell — smaller than the native one because `val` needs no
   handle scopes or callback-info unpacking, not because anything was left out.
   **Scored: half.** 5,561 lines of `.cpp` (6,402 with the two headers), inside
   the range or just over it by how the headers are counted. The shell is 935
   lines, over: every handle kind needed a JS half, which the estimate left out.
6. Slices 1 and 2 are a minority of the lines and a majority of the surprises.
   The single hardest item in Phase 2 is the table-reference `Proxy` together
   with its finalizer, not the async doors.
   **Scored: half.** Slices 1 and 2 are a minority of the lines, and the
   largest surprise — the engine's own stack — was slice 2's. But each of
   slices 3 to 7 produced one as well, and the hardest item was that stack
   handling; the `Proxy` and its finalizer went in without incident.
7. Finalizer timing (U5) costs more harness work than any other single item.
   **Scored: wrong.** It cost none: no harness was changed (U5).
8. `oracle` reports no value difference outside the `os` and `io` libraries.
   **Scored: right, and by more than predicted.** It reports none at all: 2659
   agree and the same 19 accepted cases as the native target.
9. The first full Phase 3 run finds more than twenty parity differences that
   are defects in the **new** binding — message text, check order, a missed
   guard — and every one is found by an existing test or harness cell rather
   than by reading.
   **Scored: wrong twice.** By the time the suite and harnesses were run whole
   they found one — a Lua string too long for the engine. About ten more had
   been found slice by slice, all by the scratch scripts that diffed the two
   targets call for call, which the plan did not have in it.
10. Porting finds at least one defect in the **native** binding: something
    noticed only because every entry point was read beside its copy.
    **Scored: right.** Three: a use-after-free in the table iterator (slice
    3), and two in the async doors (slice 5). The session that fixed those
    found a fourth of the same family. Phase 3 found one more, in the core and
    not the binding, and by the same mechanism: reading a native behaviour
    beside its copy before changing the copy (`timeout: Infinity`, "The
    rulings").
11. The release `.wasm` is under 1.5 MB raw.
    **Scored: right.** 745 KB raw, 251 KB gzip.

---

## 8. Risks

| Risk | What limits it |
|---|---|
| U1, U2 or U3 has no working answer | Retired: Phase 0 answered all three (§3.1). |
| On WASM a destructor runs in a frame Lua jumps through; natively it does not (§2.3) | The code is already written so that no such local is alive at a jump. Phase 3's `exception-matrix` run is the check, and the difference is recorded so a failure there is recognised. |
| Someone installs the stock Lua library by habit | The build script reads the library's `longjmp` runtime and refuses it before linking, naming `npm run vcpkg-lua-wasm`; shown refusing the stock library on November 24, 2026. |
| The stack is sized on the core alone, and a release build overflows without an error (§2.4) | 1 MiB against a measured need under 256 KiB; the seven stack cells run on every build, and since slice 2 they run against the real entry points. |
| **The JavaScript engine's call stack runs out while Lua is running** (Slice 2). Nothing inside the module can catch it, and Lua's frames are abandoned mid-call | The shell detects it and refuses the context from then on, so it fails closed; 24 cells in the build's check hold that. It is not prevented, the context is lost where natively it survives, and damage to state the whole module shares is not detectable. Three decisions are open with the owner (Slice 2, "Open with the owner"). Browser stack sizes were measured in Phase 4: a Safari worker ends a chain of Lua C calls at 102 and a JavaScript-and-Lua chain at 27, and one decision is open on it (Phase 4, "Open with the owner"). |
| The shipped module uses the legacy exception-handling instructions (§2.4) | It is what Phase 0 and Phase 1 measured. Chromium 156 and Safari 27.2 load and run it (Phase 4); Gecko was not run. Switching proposals means rebuilding Lua as well and re-running the cells. |
| **Two bindings drift.** A fix or feature lands in one and not the other | The parity census (Phase 5) fails closed on surface; the suite and harnesses run against both for behaviour; `CLAUDE.md` carries the rule. Nothing limits it between runs, and no automation is proposed (§14). |
| The second binding is as large as the first and has had none of its 23 review passes | It is not reviewed by reading: all ten instruments are pointed at it, and Phase 5 extends the source invariants to it. Prediction 9 expects them to find defects. |
| The verified binary (node variant) is not the shipped one (web variant) | They differ only in filesystem backend and are linked from the same objects; Phase 4 exercised the shipped one directly, through `browser.js`, with a 24-cell set that is first run on the native addon. |
| The work reaches into the native target after all | D7 names the files, closing condition 3 checks them with `git diff`, and a core change needs the owner's word. |
| "The same API" erodes one exception at a time | §1.1 is a closed list, and closing condition 2 rejects a ledger entry that is not on it. |
| Adding `exports` breaks an existing consumer | D6 accepts it knowingly and narrows it to deep imports of `prebuilds/`; the two other published subpaths stay listed, and the release note names the change. |
| The WASM target is run less often than native and rots | The control in Phase 3 and the stale-entry rule make a neglected ledger report itself the next time it is run. |
