# Sanitizers

Local sanitizer harnesses for catching memory-safety and threading bugs. No CI —
these are build flags you run on your own machine when you want them. All are
macOS/Linux (clang/gcc); they are no-ops on MSVC.

## The five harnesses

| Script | What it instruments | What it catches | Value here |
|--------|--------------------|-----------------|-----------|
| `npm run test-cpp-asan` | the standalone C++ **test binary** (`LuaRuntime` core) | use-after-free, buffer overflow, double-free, UB | Core-layer memory/UB. |
| `npm run test-ts-asan` | the **`.node` addon** (`LuaContext` binding), run under the full vitest suite | same, on the binding layer | **Highest** — the binding is where handle/finalizer UAFs live. |
| `npm run test-harness-asan` | the **addon**, run under four `tools/` harnesses instead of the suite | same, on the *adversarial* paths | Added August 6, 2026 (W3.1). The suite exercises the happy paths; released handles, double reset, re-alias, GC churn, throws from C frames and two contexts trading handles live in the harnesses, and those ran uninstrumented until now. |
| `npm run test-cpp-tsan` | the C++ **test binary** under ThreadSanitizer | data races | Low — the core suite is single-threaded, so this finds nothing. Regression guard only. |
| `npm run test-ts-tsan` | the **addon** under TSan, run under the async vitest suite | data races between the main thread and libuv worker threads | The real threading target, but see the caveat. |

`gc-stress` is a *fixture* rather than a harness — it has no sanitizer of its
own, it makes the addon do dangerous things so that one of the above has
something to see: `node run-sanitized-ts.js asan tools/gc-stress/run.mjs`.

Each `test-*` script rebuilds the relevant target with the right flags, runs the
suite, then you return to a normal binary with `npm run build-debug`. The
`build-*` scripts (`build-asan`, `build-asan-addon`, etc.) build without running.

## How the addon harnesses work (and why they need a preload)

Node is not built with a sanitizer, so an instrumented `.node` can't just be
`dlopen`ed — the sanitizer runtime must already be present when the addon loads,
or you get *"interceptors are not working … AddressSanitizer is loaded too late."*
`run-sanitized-ts.js` handles this: it resolves the matching runtime dylib
(`clang -print-file-name=libclang_rt.asan_osx_dynamic.dylib`) and launches vitest
with it preloaded via `DYLD_INSERT_LIBRARIES` (macOS) / `LD_PRELOAD` (Linux).

Two things make the preload actually stick:

1. **Threads pool, not forks.** A forked vitest worker does not inherit
   `DYLD_INSERT_LIBRARIES` across its exec, so the addon would load the runtime
   too late. `--pool=threads --no-file-parallelism` runs the tests in
   worker_threads *inside* the already-preloaded process, so the runtime is
   installed before the addon loads.
2. **Node must not have library validation.** A Homebrew/nvm node is adhoc-signed
   without the hardened-runtime flag, so `DYLD_INSERT_LIBRARIES` is honored. A
   hardened/system node would strip it.
3. **The preload has to be re-injected for a spawned cell.** dyld honours
   `DYLD_INSERT_LIBRARIES` at exec and then **removes it from the process's own
   environment** — inside the instrumented process, `process.env
   .DYLD_INSERT_LIBRARIES` is `undefined`. A harness that spawns one process per
   cell therefore hands its children an *un*preloaded environment and every one
   of them aborts with "Interceptors are not working", two layers away from any
   message that says so. `run-sanitized-ts.js` exports the path under
   `LUA_NATIVE_SANITIZER_PRELOAD` (which macOS leaves alone) and
   `tools/sanitizer-env.mjs` puts the real variable back on each `spawn`.
   **The vacuity question answers itself here:** a child that misses the preload
   cannot quietly run uninstrumented, because the instrumented `.node` refuses to
   load at all — so "the cells ran" is the proof that they ran instrumented.

Runtime options are tuned for a *partially* instrumented process (only the addon
is instrumented; Node/V8/libuv and static Lua are not): `detect_leaks=0`
(LeakSanitizer is unsupported on macOS and would flag all of Node's own
allocations), `detect_container_overflow=0` (false positives when instrumented
and un-instrumented code share a `std::` container). A real memory error still
fails the run (`abort_on_error=1`).

## Stress-test results (August 6, 2026)

Re-run on macOS (arm64, Xcode clang 21). **The previous record was dated July 21,
2026 against a 454-test suite** — the suite is now 1117 tests, and `sandbox`,
`binaryStrings`, `strictConversion`, `set_read_handler`, the class accessors and
the new async doors *all landed after that date*. A memory-safety claim measured
against half the surface is a claim about the half that existed, which is why
this section carries its date in the heading and gets re-run rather than
inherited (W3.3).

- **`test-ts-asan` — clean.** 1117 tests, zero ASan/UBSan reports, no interceptor
  failures.
- **`test-harness-asan` — clean, and new.** The four adversarial harnesses under
  the instrumented addon: `cross-context` (62 checks), `capability-matrix` (203
  cells), `lifecycle-matrix` (78 cells, one process each), `exception-matrix`
  (429/429). These had never run instrumented — the suite covers happy paths,
  while released handles, double reset, re-alias, GC churn and throws from C
  frames live here. See the third preload note above for what had to change to
  make it work at all.
- **`gc-stress` — clean.** `tools/gc-stress/run.mjs`, 100 iterations: 9 patterns
  over all **12** handle kinds, ~1,200 handle operations plus 5,000
  `__gc`-finalizer re-entries and 2,500 abandoned contexts. **This replaces the
  July run's five hand-picked patterns, which lived in a scratch script that is
  not in the repository** — the strongest evidence this project had was a check
  nobody could re-run. It is now driven by `lifecycle-matrix`'s Axis A, so a new
  handle kind is stressed without anyone remembering to add it, and it covers the
  async coroutine cursor, which did not exist in July.
- **`test-cpp-asan` — clean.** 285 C++ tests under ASan+UBSan, no reports.
- **`test-cpp-tsan` — clean, as expected.** 285 tests, 0 races. The core is
  single-threaded (`LuaRuntimeWorkerUnref` simulates the queue/drain without real
  threads), so there is nothing for TSan to find. Kept as a guard for if
  threading is ever added to the core.
- **`test-ts-tsan` — ran clean, with the caveat below.** 1117 tests, **0 races
  reported**, plus 25 iterations of `gc-stress`. TSan was verified genuinely
  active when this harness was built (the addon links
  `libclang_rt.tsan_osx_dynamic.dylib` and the identical flags catch a planted
  race), so the clean result is real, not inert.

### The `test-ts-tsan` caveat (read before trusting a clean run)

TSan reasons about happens-before only from the memory accesses it *sees*. Here
only the addon is instrumented — **libuv's thread-pool synchronization, Node, V8,
and static Lua are invisible to it.** Consequences:

- It can **miss** a real race whose ordering runs through uninstrumented memory.
- A clean run means "no race in the interleavings that actually occurred," not
  "proven race-free." The H9c path (a GC finalizer's `luaL_unref` racing an
  active worker) only shows up if that exact interleaving happens during the run;
  the standard suite does not deterministically force it.
- On other machines it may also **false-positive** on cross-boundary
  synchronization it can't observe; triage with a suppressions file (drop a
  `tsan.supp` in the repo root — `run-sanitized-ts.js` picks it up automatically
  and passes it via `TSAN_OPTIONS=suppressions=`).

So treat `test-ts-asan` as the dependable everyday harness and `test-ts-tsan` as
a best-effort probe of the async paths, not a proof.

## Recommended cadence

- After **C++ core** changes: `npm run test-cpp-asan`.
- After **binding / handle / finalizer / async** changes, and before a release:
  `npm run test-ts-asan`, then `npm run test-harness-asan` — the harnesses are
  the adversarial paths and are where a handle/finalizer UAF would actually be
  reached. If you touched lifetime code, add
  `node run-sanitized-ts.js asan tools/gc-stress/run.mjs --iterations=100`.
- Occasionally, or after touching the worker/deferred-unref code:
  `npm run test-ts-tsan`, reading the caveat above.

Remember the blind spot common to all of them: sanitizers are runtime tools, so
they only see bugs on paths a test actually executes. Their value scales with how
adversarial your tests are — hostile metamethods, released handles, forced GC at
the wrong moment. That is the whole reason `test-harness-asan` and `gc-stress`
exist: the instrumentation was already there, pointed at the gentlest code in the
project.

**And none of them sees a leak on this platform.** `detect_leaks=0` is not a
tuning choice that could be revisited — LeakSanitizer is unsupported on macOS, so
a leak is invisible to all five. Do not read "the sanitizer harnesses are clean"
as covering it.

What does cover it, partially and by direct measurement rather than by
instrumentation: **`lifecycle-matrix`'s `gc-churn`** (the Lua registry
high-water mark per handle kind, one process each) and **`gc-stress`'s balance
check** (every handle kind together in one long-lived context, many rounds, mark
must stop growing — with a control that retains the handles and requires the
check to call that a leak). Both measure the *Lua* side. The binding's own maps
have no diagnostic accessor and are not covered by either. And none of them catch the exception-abort class (a
`std::runtime_error` reaching `std::terminate`, e.g. CR-6 F1) — that stays the job
of the CODE-REVIEW-6 behavioral matrix.
