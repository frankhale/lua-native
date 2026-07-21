# Sanitizers

Local sanitizer harnesses for catching memory-safety and threading bugs. No CI —
these are build flags you run on your own machine when you want them. All are
macOS/Linux (clang/gcc); they are no-ops on MSVC.

## The four harnesses

| Script | What it instruments | What it catches | Value here |
|--------|--------------------|-----------------|-----------|
| `npm run test-cpp-asan` | the standalone C++ **test binary** (`LuaRuntime` core) | use-after-free, buffer overflow, double-free, UB | Core-layer memory/UB. |
| `npm run test-ts-asan` | the **`.node` addon** (`LuaContext` binding), run under the full vitest suite | same, on the binding layer | **Highest** — the binding is where handle/finalizer UAFs live. |
| `npm run test-cpp-tsan` | the C++ **test binary** under ThreadSanitizer | data races | Low — the core suite is single-threaded, so this finds nothing. Regression guard only. |
| `npm run test-ts-tsan` | the **addon** under TSan, run under the async vitest suite | data races between the main thread and libuv worker threads | The real threading target, but see the caveat. |

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

Runtime options are tuned for a *partially* instrumented process (only the addon
is instrumented; Node/V8/libuv and static Lua are not): `detect_leaks=0`
(LeakSanitizer is unsupported on macOS and would flag all of Node's own
allocations), `detect_container_overflow=0` (false positives when instrumented
and un-instrumented code share a `std::` container). A real memory error still
fails the run (`abort_on_error=1`).

## Stress-test results (July 21, 2026)

All four harnesses were built and exercised on macOS (arm64, Xcode clang 21):

- **`test-ts-asan` — clean.** The instrumented addon (913 ASan symbols) ran the
  full 454-test vitest suite with **zero** ASan/UBSan reports and no interceptor
  failures. A separate stress harness then hammered the historical UAF patterns
  under `--expose-gc` with forced collection — 1,200 iterations of: table-handle
  methods destructured off a then-GC'd handle (H3), Lua functions called after
  their context was dropped (H9c-shape), reclaimable nested-callback closures
  collected mid-run (M2), `delete fn.__luaFnOwner` then call (L6), and a
  spec-violating double-settling awaited promise (L5). **No ASan report.** Strong
  evidence the handle/finalizer lifetimes are sound on these paths.
- **`test-cpp-asan` — clean.** 178 C++ tests under ASan+UBSan, no reports.
- **`test-cpp-tsan` — clean, as expected.** 178 tests, 0 races. The core is
  single-threaded (`LuaRuntimeWorkerUnref` simulates the queue/drain without real
  threads), so there is nothing for TSan to find. Kept as a guard for if
  threading is ever added to the core.
- **`test-ts-tsan` — ran clean, with a caveat.** The TSan-instrumented addon
  loaded and ran the async suite (454 pass, **0 races reported**). TSan was
  verified genuinely active (the addon links `libclang_rt.tsan_osx_dynamic.dylib`
  and the identical flags catch a planted race), so the clean result is real, not
  inert.

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
  `npm run test-ts-asan` (plus a `--expose-gc` stress run of the dangerous
  patterns if you touched lifetime code).
- Occasionally, or after touching the worker/deferred-unref code:
  `npm run test-ts-tsan`, reading the caveat above.

Remember the blind spot common to all of them: sanitizers are runtime tools, so
they only see bugs on paths a test actually executes. Their value scales with how
adversarial your tests are — hostile metamethods, released handles, forced GC at
the wrong moment. And none of them catch the exception-abort class (a
`std::runtime_error` reaching `std::terminate`, e.g. CR-6 F1) — that stays the job
of the CODE-REVIEW-6 behavioral matrix.
