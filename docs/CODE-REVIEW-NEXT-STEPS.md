# CODE-REVIEW-NEXT-STEPS

**Date:** August 3, 2026
**Written after:** CODE-REVIEW-17, against commit `67e3025` plus the CR-17
remediation.

**Scope:** where the review programme should go next, and why. This is about the
*correctness programme* — what to search and how. `FUTURE.md` is the feature
roadmap and is a separate document.

---

## 1. Where the code actually stands

By any ordinary standard this is unusually hardened: **850 TypeScript and 285
C++ tests** over ~10.7k lines of C++, four sanitizer harnesses clean, three
exhaustive adversarial matrices clean, and every finding across seventeen passes
driven to a reproduction before being fixed.

### The finding curve

| Pass | Findings | Highs | | Pass | Findings | Highs |
|---|---|---|---|---|---|---|
| CR-1 | 29 | 6 | | CR-10 | 3 | 2 |
| CR-2 | 34 | 10 | | CR-11 | 5 | 2 |
| CR-3 | 15 | 3 | | CR-12 | 5 | 0 |
| CR-4 | 5 | 0 | | CR-13 | 3 | 1 |
| CR-5 | 10 | 0 | | CR-14 | 5 | 1 |
| CR-6 | 2 | 1 | | CR-15 | 6 | 1 |
| CR-7 | 5 | 1 | | CR-16 | 5 | 1 |
| CR-8 | 7 | ~1 | | CR-17 | 3 | 1 |
| CR-9 | 4 | 1 | | | | |

Total findings per pass collapsed by an order of magnitude and stayed there.
Highs dropped hard through CR-3 and then **plateaued at roughly one per pass for
eleven consecutive passes**. There is no saturation signal: seventeen passes in,
a pass still finds something serious.

### Why the plateau is misleading

**The count is flat; the density is collapsing.** CR-2 found ten highs by
reading the code. CR-16 found one crash in **1242** generated cells. CR-17 found
one root cause in **573** cells. Those are not the same "1" — each recent pass
builds a new instrument, and each instrument finds about one thing. That is a
fact about instruments, not about defect density.

**Families are being retired, not just sites.** Classifying the highs from CR-6
onward:

| Family | Passes that produced a high | Status |
|---|---|---|
| **Occupancy** (who holds the `lua_State`) | CR-9, CR-10 F1, CR-13, CR-14, CR-15, CR-16 | **Closed** structurally in the CR-15/16 refactor (`lua_occupancy::Claim`, one guard, a generative assert) |
| **Lifetime across layers** | CR-7 F1, CR-10 F2, CR-17 F1 | Mechanically searched as of CR-17 (orphan + life matrices) |
| **Exception escape / process abort** | CR-2 H8, CR-6 F1, CR-8 F1/F4 | **No mechanical search** |
| **Reentrancy invalidation** | CR-11 F1/F2 | Covered by CR-16's injection matrix |

The strongest single piece of evidence in the series: **CR-17's high is the
first high in five passes that is not occupancy.** That is exactly what closing
a class looks like — the recurring one stops recurring, and the next pass
surfaces a different family.

**The failure mode changed.** Every high from CR-1 to CR-16 announced itself
with a segfault or an abort. CR-17's high was found through *silent data
corruption* — stale handles aliasing live tables, a write landing in a table the
program was using — and its crash half was almost incidental. Its other two
findings are a wrong return value and a wrong error message. The code has moved
from **crashing to lying**, which is the normal maturation curve for a native
binding, and it means the previous discovery method stops working: a crash
announces itself, a wrong answer has to be asked for.

### What is not improving

1. **Every structural fix has introduced a fresh defect.** CR-15's occupancy
   refactor introduced a data race TSan caught pre-ship; all four of CR-16's
   lows lived inside that refactor. Change risk on this codebase is real.
2. **Comment and enumeration drift is chronic.** "Check enumerations against a
   generator" was written as a lesson in CR-14, CR-15 and CR-16 — and violated
   in CR-15, CR-16 and CR-17. Hand-maintained lists in comments decay within one
   commit here.
3. **All three matrices check survival, not truth.** CR-17 F2 and F3 were found
   by eyeballing a column of *successes*, not by any assertion.
4. **The exception-escape class has no generated coverage.** Sanitizers are
   explicitly blind to it (see `CLAUDE.md`); the CR-6 behavioural matrix is
   hand-written and therefore subject to point 2.
5. **Platform coverage is narrow.** Everything is verified on macOS/arm64.
   `binding.gyp` declares mac and win targets; `prebuilds/` has contained
   `darwin-arm64` only since CR-5. **There is no CI.**

---

## 2. Recommendation: CR-18 as an exception-escape matrix

Of the available next steps, this is the one to do.

### Why this one

- It is the **last known-live hazard family with no generated coverage**.
- It has produced highs three times, each found by a human thinking of a site.
- The **sanitizers cannot see it** — `CLAUDE.md` states that the exception-abort
  class (a `std::runtime_error` reaching `std::terminate`, e.g. CR-6 F1) is not
  caught by any of the four harnesses.
- The **recipe already exists and has transferred cleanly twice** (CR-16's
  injection matrix, CR-17's lifetime matrices): partition, generate, one process
  per cell.
- The search space is **bounded and enumerable**: 78 `throw` sites across the
  two layers, 99 `catch` sites, 54 `RunProtected` / `lua_pcall` barriers.

The other two candidates lose on timing rather than merit. Mechanizing the
remaining comment invariants (§4) is real but small — it prevents recurrence
rather than finding anything, so it rides along rather than leading. A
differential oracle (§5) is the strategically correct answer for where the
failure mode is heading, but it is an open-ended project, and building it before
knowing whether the exception family is clean is the wrong order.

### What it concretely is

Two axes, both enumerable by `grep` rather than by memory — which is the point,
per CR-14's standing rule.

**Axis A — throw kinds reachable from user code:**

- a registered JS callback throwing
- a `Napi::Error` raised by a conversion (Symbol, out-of-range BigInt, over-deep object)
- an `ERRMEM` longjmp under `maxMemory`
- a throwing print handler
- a throwing debug hook
- a throwing `__gc` metamethod
- a throwing `require` searcher
- a raising `_G` metamethod (`__index` / `__newindex`)
- a throwing type converter / from-Lua converter
- a throwing Proxy trap on a definition object

**Axis B — the Lua C frame the exception must unwind through:**

- host-function call (`LuaCallHostFunction`)
- metamethod dispatch (`__index`, `__newindex`, `__add`, `__tostring`, comparison)
- `__gc` finalizer, both at ordinary GC and inside `lua_close`
- debug hook
- `print` / `io.write`
- `require` searcher
- coroutine resume boundary
- `lua_load` reader
- to-be-closed variables (`__close`)
- the async worker's off-thread `Execute()`

Roughly 80 cells.

**The assertion per cell** is the CR-6 shape: no abort; the failure surfaces as
a catchable Lua error or a JS throw; the context is usable afterwards; and no
callback registration or registry slot is stranded.

**Partitioning is mandatory here.** The failure mode is `std::terminate`, which
kills the run — so, exactly as in CR-16 and CR-17, each cell needs its own
process for a crash to be a data point rather than the end of the run.

### Two things to carry in from CR-17

1. **Prove the harness can report dirty before believing a clean cell.**
   CR-17's first orphan matrix was entirely vacuous and reported clean. For this
   matrix that means deliberately un-catching one known-contained site and
   watching it abort. An exhaustive search that reports clean must first
   demonstrate it can report dirty.
2. **Record the value, not just survival.** The interesting failure here may be
   a *swallowed* exception, which is indistinguishable from success unless the
   cell checks what actually happened. A silently-dropped error is the same
   class as CR-17 F2/F3 — the code lying rather than crashing.

---

## 3. The one thing that would outrank it

**If shipping to Windows x64 or Intel macOS is on the roadmap, do platform
verification and CI first.**

Two of three declared targets have never had a single test executed against
them. That is a *certain* correctness gap for those users, against a *probable*
one from exception escape. And with no CI, 850 tests, four sanitizer harnesses
and three matrices all depend on someone remembering to run them — a fair amount
of what seventeen passes bought is currently protected by habit rather than by
process.

If this stays a macOS/arm64 project for now, that reverses and CR-18 leads.

Minimum useful version: build + TypeScript suite + C++ suite on macOS arm64,
macOS x64 and Windows x64; `test-ts-asan` on at least one Linux or macOS runner.
The sanitizer harnesses are documented as local-only in `CLAUDE.md`, which was a
reasonable decision when they were new and is now the main thing standing
between a regression and a release.

---

## 4. Cheap task to do alongside, either way

**Convert the remaining comment-enforced invariants to assertions.** This is the
only intervention in seventeen passes that has demonstrably stopped a class from
recurring:

- the `static_assert` on marker-tag distinctness (CR-15 F6a)
- the generative `assert` on occupancy-policy shape (CR-16 F4)
- replacing the "33 synchronous methods" count with the `grep` that produces it
  (CR-16 F2)

Named candidates already sitting in the reviews:

- the hand-maintained **`CallScope` enumeration** (repaired in CR-13, CR-14 and
  CR-15, and wrong each time)
- the **`lua_next` traversal list** (incomplete on arrival, CR-15 F3)
- the occupancy matrix's **`EXCLUSIVE_OPS`**, which currently agrees with
  `grep -n 'lua_occupancy::k' src/lua-native.cpp` by luck rather than by
  construction

About a day's work. It is the difference between a lesson written down and a
lesson enforced.

---

## 5. After that: the oracle problem

Now that the failure mode is lying rather than crashing, the strategic gap is
that **no harness checks whether an answer is right** — all three matrices, and
most of the suite, check that nothing crashed and that errors are clean.

The tractable form is **differential testing against reference Lua**: run the
same script through `lua-native` and through the stock `lua` interpreter (already
available via vcpkg, per the build prerequisites) and compare results. That gives
a real oracle for the large surface where the binding should be transparent —
arithmetic, string handling, table semantics, error messages, coroutine
scheduling — and it is generated rather than hand-written, so it does not decay.

It will not cover the JS-boundary semantics, which have no reference
implementation; those need hand-written expectations. But it would put an oracle
under the majority of the Lua surface, which is where a silent wrong answer is
most likely to go unnoticed.

This is the largest of the three items and should follow CR-18, not precede it.

---

## Summary

| Priority | Task | Effort | Rationale |
|---|---|---|---|
| **1** | CR-18: exception-escape matrix | Medium | Last known-live family with no generated coverage; sanitizers blind to it; proven recipe |
| **1 (if shipping cross-platform)** | CI + macOS x64 / Windows x64 verification | Medium | Two of three declared targets never executed; no automated regression protection |
| **2** | Mechanize the remaining comment invariants | ~1 day | The only intervention that has stopped a class recurring |
| **3** | Differential oracle against reference Lua | Large | Addresses the failure mode the code has moved to; no harness currently checks truth |

**Direct answer to "are we making progress on the class of findings":** yes,
demonstrably — but the evidence is family retirement and defect density, not the
per-pass high count, which has been flat for eleven passes and will likely stay
flat as long as each pass brings a new instrument. The marginal value of another
review pass *in the CR-9-through-CR-15 style* is now low; the value is in
building searches for the families that have never had one.
