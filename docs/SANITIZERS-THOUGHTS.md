# SANITIZERS-THOUGHTS

An assessment of the sanitizer effort for this project: what a sanitized build
actually buys you, where it is load-bearing versus theater, and how much of
"is the code solid?" it can honestly answer.

**Short version:** the addon-under-ASan harness (`test-ts-asan`) is genuinely
load-bearing — it gives continuous coverage to the binding layer, which is where
this project's use-after-frees have always lived, and a hard stress run over those
exact patterns came back clean. Everything else is either a narrow guard
(`test-cpp-tsan`), a best-effort probe with real blind spots (`test-ts-tsan`), or
useful-but-not-where-the-bugs-are (`test-cpp-asan`). A sanitizer is a runtime
tool: it answers "did anything go wrong on the paths I ran," not "is the code
correct." That distinction is the whole assessment.

For the operational how-to (commands, preload mechanics, options), see
`SANITIZERS.md`. This document is the judgment behind it.

---

## The core mental model

A sanitizer instruments the binary so that the instant a bad memory access or
undefined operation *executes*, you get an abort with a stack trace. Two things
follow, and they govern everything below:

1. **It is coverage-bound.** A use-after-free that no test triggers is invisible.
   The sanitizer's reach equals the reach of the tests you run under it — no more.
   This is why "we run under ASan" is not the same claim as "we are memory-safe."

2. **It catches a specific class.** ASan/UBSan find use-after-free, buffer
   overflow, double-free, and UB (signed overflow, misaligned/null deref, bad
   casts). TSan finds data races. None of them find logic errors, leaks on macOS
   (LeakSanitizer is unsupported here), or — the one that bit this project most
   recently — a C++ exception reaching `std::terminate`.

Everything that makes the effort "meaningful" versus "theater" is about aiming a
coverage-bound tool at the layer where the bug class actually lives, and driving
execution through the paths that are dangerous rather than the paths that are
convenient.

---

## Where the bugs in *this* project actually live

The review history is unusually clear on this point. The use-after-frees found in
CODE-REVIEW-2/3 — a table-handle method destructured off a handle that then gets
GC'd (H3), `delete fn.__luaFnOwner` freeing data a bound C function still calls
through (L6), the await-cookie freed on first settlement then read again by a
double-firing promise (L5), a finalizer's `luaL_unref` racing a worker run (H9c)
— are **all in the binding layer** (`LuaContext`, the Proxy traps, the `*Data`
finalizers), and **all reachable only through the JS API.**

This is the single most important fact for calibrating the effort. A sanitized
build of the standalone C++ test binary never loads the addon and never runs any
of that code. So the "obvious" sanitizer target — `test-cpp-asan`, which was the
first thing wired up — is aimed slightly off the bugs you most want to catch. It
still has value (the core has its own registry-reference and stack-conversion
management), but it is not where the UAF risk concentrates.

The harness that matters is the one that instruments the **addon** and runs the
**JS** suite under it. Getting that working is the difference between a sanitizer
program that looks responsible and one that is.

---

## What the four harnesses are actually worth

Ranked by value to this codebase, not by how easy they were to build:

- **`test-ts-asan` — load-bearing.** Instruments the addon, runs the full vitest
  suite under a preloaded ASan runtime. This is the one that covers the binding
  layer. It earns the top spot because it is the only harness that exercises the
  code where the historical UAFs lived, and because the stress evidence (below) is
  strong. Run it before shipping binding/lifetime changes.

- **`test-cpp-asan` — useful, narrower.** Core-layer memory/UB. Cheap, fast, no
  preload gymnastics. Good after C++ core changes. Just don't mistake a clean run
  here for binding-layer safety — it says nothing about that.

- **`test-ts-tsan` — best-effort probe.** The real threading target (main thread
  vs. libuv worker), but with a structural blind spot that caps what a clean run
  can mean — see the caveat section. Worth running occasionally; never a gate.

- **`test-cpp-tsan` — guard, not finder.** The core suite is single-threaded, so
  it finds nothing by construction. It exists to catch the day someone adds
  threading to the core and forgets it was supposed to stay single-threaded. Zero
  cost, near-zero signal today. Kept for honesty, not for results.

---

## The stress-test evidence (July 21, 2026)

The point of stress-testing was to separate "runs clean" from "runs clean on the
paths that actually matter." A suite can pass under ASan while never once forcing
a finalizer to fire at the dangerous moment — and finalizer timing is precisely
what the H3/L5/L6 bugs turned on.

So beyond running the standard suite under each harness (454 TS / 178 C++, all
clean, no reports), a dedicated `--expose-gc` harness drove **1,200 iterations**
of the exact historical UAF patterns with forced collection at the hazardous
point:

- table-handle methods destructured off a handle that is then dropped and GC'd
  (H3);
- Lua functions returned to JS, their context dropped, then called (H9c-shape);
- reclaimable nested-callback closures minted in bulk and collected mid-run (M2);
- `delete fn.__luaFnOwner` followed by GC and a call (L6);
- a spec-violating promise that resolves twice and rejects once, awaited inside
  `execute_async`, with GC pressure between iterations (L5).

**No ASan report across all 1,200.** That is meaningful because it forced the
timing, not just the calls. It is strong evidence the handle and finalizer
lifetimes are sound — evidence the C++ ASan build structurally cannot produce.

The tools were also verified to actually work, not sit inert: the ASan flags abort
on a planted use-after-free, and the TSan flags abort on a planted data race, so a
clean project run is a real negative rather than a silent no-op. (The addon was
confirmed instrumented — it links the sanitizer runtimes and carries the
`__asan`/`__tsan` symbols — precisely because "green because nothing ran" is the
failure mode a sanitizer program most needs to rule out.)

---

## The `test-ts-tsan` caveat, and why it caps the claim

TSan reasons about happens-before only from the memory accesses it *sees*. In the
addon harness only the addon is instrumented; **libuv's thread-pool
synchronization, Node, V8, and static Lua are invisible to it.** Three
consequences, in order of how much they matter:

1. **A clean run is not a proof.** It means "no race in the interleavings that
   happened," not "race-free." The H9c interleaving — a GC finalizer's
   `luaL_unref` landing while a worker owns the state — only surfaces if that
   exact timing occurs during the run, and the standard suite does not force it.
2. **It can miss** a real race whose ordering runs through memory TSan can't see.
3. **It can false-positive** on cross-boundary synchronization it can't observe
   (it didn't here, but it may on another machine); triage with a `tsan.supp`
   suppressions file.

This is not a flaw in the harness — it is inherent to running TSan on a partially
instrumented process, which is the only option short of a sanitizer-built Node.
The honest framing is: `test-ts-tsan` is a probe that can *find* races but cannot
*certify* their absence. Treat a clean run as reassurance, not a guarantee, and
never wire it into a "must be green to ship" gate — that would launder a blind
spot into false confidence.

---

## What sanitizers do *not* do for this project

Worth stating plainly, because the most recent high-severity bug is exactly here.
CODE-REVIEW-6 F1 was a `std::runtime_error` escaping across the N-API boundary and
reaching `std::terminate` — `set_userdata`/`set_print_handler` aborting the
process on a hostile `_G` metamethod. **No sanitizer catches that.** It is not
memory corruption and not a race; it is C++ doing exactly what an uncaught
exception is defined to do. ASan/UBSan/TSan stay silent through the whole thing.

The enforcement for that class is behavioral, not tool-based: the CR-6
per-entry-point regression matrix (arm a raising `_G` metamethod, invoke every
binding method that reaches a `RunProtected`-backed core call, assert a catchable
throw and process survival). Sanitizers and that matrix are complementary and
non-overlapping — neither substitutes for the other.

---

## How this fits the review trajectory

`CODE-REVIEW-THOUGHTS.md` argued that convergence to "no significant issues"
requires fixing **classes**, not **sites**, and backing that with mechanical
enforcement so a class cannot silently regrow. This sanitizer work is the second
half of that — the enforcement half — for the memory/UB classes specifically. The
first half (the behavioral matrix) covers the exception-abort class.

The tail now closes from three directions:

- a behavioral matrix for the exception-abort class (CR-6 F2),
- ASan over **both** layers for the memory/UB classes, with the binding layer —
  the one that mattered — now genuinely covered,
- a best-effort TSan probe for the async races, honestly labeled as non-proving.

What remains is not more tooling but **discipline**, and it is worth naming so it
does not quietly lapse:

- add each new binding method to the H1 matrix when you write it;
- run `test-ts-asan` before shipping, and a `--expose-gc` stress pass when you
  touch lifetime code;
- when you touch the worker/deferred-unref path, run `test-ts-tsan` and read its
  output as a probe, not a verdict;
- keep the tests adversarial — hostile metamethods, released handles, forced GC —
  because a sanitizer over a gentle suite is a sanitizer over nothing.

---

## Bottom line

Yes, the sanitized build helps make the code solid — but only in proportion to
three choices: pointing it at the layer where the bug class lives (the addon, not
just the core), driving execution through the adversarial and GC-timing paths, and
being honest about the classes it cannot touch (the exception-abort class) and the
runs it cannot certify (`test-ts-tsan`).

Measured that way, the outcome here is genuinely good: the binding layer's
handle/finalizer lifetimes now have continuous ASan coverage and survived a
forced-timing stress run of every historical UAF pattern without a single report.
That is real evidence of solidity — not the theoretical kind. The remaining honest
gaps are the TSan blind spot and the exception-abort class, both of which are
named, both of which have a compensating control, and neither of which a sanitizer
was ever going to close on its own.
