# Windows: what the platform does differently, and what that broke

**August 9, 2026.** The full test set was run on Windows x64 (MSVC 19.44 /
VS 2022 17.14, node 24.19, vcpkg `x64-windows-static`, Lua 5.5.1) for the first
time. Seventy-nine cells failed across the two suites and four of the eleven
harnesses. Every one traced to five root causes, and **not one of them was a
disagreement about Lua semantics** — they were places where C++, the CRT, the
shell and the filesystem behave differently than they do under clang/macOS, and
where the source had, reasonably, assumed one of the two behaviours.

This file is the mechanism reference for those five. It is written for the
reader who hits a sixth: four of the five are recognisable classes rather than
one-off bugs, and three of them produced *plausible wrong answers* rather than
crashes, which is the failure shape this codebase is organised around.

> On scope: platform coverage and CI are closed subjects
> ([`CORRECTNESS.md`](CORRECTNESS.md) §14). Nothing here reopens them. This
> documents what the platform does, not what anyone should do about process.

---

## The accounting

Nine changes, and they are not the same kind of thing. Kept apart because the
distinction is the honest part of this record:

| | Change | Kind |
|---|---|---|
| 1 | `_HAS_EXCEPTIONS=0` overridden in `binding.gyp` | **Product defect** — shipped addon reported garbage errors |
| 2 | `StackGuard` removed from ten protected thunks | **Product defect** — shipped addon reported the wrong error |
| 3 | `perf-claims` line split | Instrument blind |
| 4 | `diff-oracle` line split | Instrument blind |
| 5 | `%p` address scrubbers (`exec-parity`, `diff-oracle`) | Instrument blind |
| 6 | `/dev/null` → platform null device (spec + 2 harnesses) | Instrument blind |
| 7 | `process.kill(SIGABRT)` → `process.abort()` | Instrument blind (fail-closed control) |
| 8 | NUL-key collision assertion no longer pins traversal order | Test over-specified |
| 9 | `crossing-cost` A8 gains a `k=1000` decade | Instrument threshold — **see the caveat** |

**Two product defects. Seven instrument corrections.** The product was right in
the other seven cases and the instrument could not see it — which is worth
stating plainly, because "71 failures" invites the opposite conclusion.

---

## 1. `_HAS_EXCEPTIONS=0` — 71 failures

**Symptom.** Every error message, in both suites, arrived as `0xDD` fill bytes:

```
"Host function 'fetchName' threw an exception: ���������������..."
```

**Mechanism.** node's `common.gypi` defines `_HAS_EXCEPTIONS=0` for every addon
target, because node itself is built without C++ exceptions. This project is
not: it compiles with `/EHsc` and reports every failure by throwing. The pair is
inconsistent, and nothing warns.

With `_HAS_EXCEPTIONS=0` the MSVC STL bypasses `<vcruntime_exception.h>` and
substitutes an exception class whose constructor **stores the message pointer**
rather than deep-copying it. So for the shape used throughout this codebase —

```cpp
std::string msg = "...";
throw std::runtime_error(msg);
```

— `what()` aliases `msg`'s heap buffer, which is freed when `msg` is destroyed
during unwinding. Proven by address, not inferred:

```
msg.data() = 00000137FDD82D10
e.what()   = 00000137FDD82D10   ALIASES msg buffer
```

**Why macOS never saw it.** libc++ always deep-copies. The guarantee the whole
codebase leans on is a *build* property on Windows and a library property
everywhere else.

**Fix.** `binding.gyp`, both Windows targets: `defines!` removes the `0` (rather
than appending a `1`, which would collide as C4005) and `defines` adds `1`.

**Guard.** `ExceptionMessageLifetime.WhatOutlivesTheSourceString` in the C++
suite states the invariant in one assertion, so the next reader gets a named
cause instead of a wall of garbled diffs. It is trivially true on libc++ and
aimed squarely at the Windows build.

---

## 2. `StackGuard` inside a protected thunk — 6 failures

**Symptom.** `handle.get()`, `.has()`, `.set()` and the dotted global accessors
reported a raising `__index` as `"function: 000001E6FFCDBC30"`. `handle.length()`,
`.get_ref()` and `execute_script` reported it correctly — the discrepancy that
made it findable.

**Mechanism.** Whether `longjmp` runs C++ destructors is platform-defined, and
the two targets disagree. Lua is linked as C, so `luaD_throw` is a `longjmp`.
Under clang/macOS that jump **skips** destructors — the assumption this file is
written against, stated in its own `HostCallOutcome` comment. MSVC's `longjmp`,
in a `/EHsc` translation unit, **unwinds and runs them**.

`~StackGuard()` calls `lua_settop`. Firing it mid-unwind lands between the raise
and Lua's own bookkeeping, and `luaD_seterrorobj` then reads the error from
`L->top - 1`:

```c
setobjs2s(L, oldtop, L->top - 1);  /* error message on current top */
```

With the stack already truncated, `L->top - 1` was the trampoline C function —
hence a *function* as the error message.

**Fix.** Removed from all ten `RunProtected` thunks. It was redundant there on
all three exits: `lua_pcall(L, n, 0, 0)` truncates to the function slot on a
normal return, on a C++ throw the trampoline converts to `return 0`, and on a
Lua error. The rule now lives on `StackGuard` itself.

**The part worth noticing.** The block comment above the six field accessors
already stated the rule those thunks broke — *"Only PODs live in the thunks; the
C++ results are declared outside, so an ERRMEM longjmp has no destructor of
consequence to skip."* `StackGuard` is a destructor of consequence. The
invariant was written down and violated in the same breath, and stayed harmless
for exactly as long as only one platform ran the code.

---

## 3. CRLF meets JS regex — 2 failures, both silent

`core.autocrlf=true` and no `.gitattributes`, so every file is CRLF on checkout.
**JS `.` excludes `\r`** along with the other line terminators. So a pattern
ending `(.*)$` cannot reach `$` on a CRLF line, and matches nothing.

- **`perf-claims`** matched **zero headings in the entire tree**. With an empty
  heading stack nothing was scoped hypothetical, and ten Phase-2 estimates the
  census exists to skip were reported UNCLAIMED.
- **`diff-oracle`** hit the same class through a pipe: the reference interpreter
  is a subprocess whose stdout arrives CRLF-terminated, so the last
  tab-separated field carried a trailing `\r`. All 1339 cases reported DISAGREE
  **while printing two values that looked identical**, because the difference
  was an invisible byte.

Both fixed by splitting on `/\r?\n/`. The oracle case is the sharper warning: a
diff display that renders the compared values can still hide the thing that
differs.

---

## 4. Platform-specific externals — 4 failures

Three unrelated assumptions, one class: a name or facility that only exists on
one platform, failing *quietly* rather than loudly.

- **`/dev/null`.** Used in the spec and two harnesses to mint a Lua file handle
  — the only Lua-created userdata reachable without extra libraries. On Windows
  `io.open` returns nil, so the cell held a non-handle and `cross-context`
  reported two HANDLE-ACCEPTED findings about the null device rather than about
  contexts. Now `NUL` on win32.
- **`process.kill(process.pid, 'SIGABRT')`.** libuv honours only
  SIGTERM/SIGKILL/SIGINT on Windows; SIGABRT raises EINVAL. So
  `exception-matrix`'s abort control survived its own abort, wrote its JSON and
  scored HARNESS_ERROR — which **failed the run closed and blocked all 507
  cells**. That is the control design working exactly as intended. Now
  `process.abort()`, which is what the comment always meant and is portable.
- **`%p`.** Lua renders addresses with C's `%p`, whose format is
  implementation-defined: `0x7f8e4b405a30` on glibc/macOS,
  `0000011BC933B700` on MSVC — no prefix, upper hex. The scrubbers in
  `exec-parity` and `diff-oracle` required the `0x`, so nothing was scrubbed and
  25 cells reported DISAGREE over object identity.

---

## 5. One over-specified assertion

The `strictConversion` NUL-key test pinned *which* of two colliding keys
survives (`{a: 'v1'}`). That is `lua_next` traversal order, which Lua does not
specify; it is stable on each platform and opposite between them — `v1` on
macOS, `v2` on Windows (12/12 across fresh contexts).

The finding is the collision: two Lua entries land on one JS property and one
value is lost. The test now asserts that, and that the survivor is one of the
two. Its sibling test three lines up already used the order-independent form.

---

## The caveat that needs a second opinion

**`crossing-cost` A8 is the one change where I moved an instrument's threshold
so a failing cell passed.** It deserves scrutiny on its own terms.

A8 declares the JS→Lua converter scan LINEAR; on Windows it measured CONSTANT
(exponent 0.28) and failed. The scan is *not* non-linear — the per-converter
increment is dead linear:

| step | Δ | per converter |
|---|---|---|
| k=1 → 10 | +1.21µs over 9 | **0.134µs** |
| k=10 → 100 | +11.99µs over 90 | **0.133µs** |
| k=100 → 1000 | +111.05µs over 900 | **0.123µs** |

What differs is the *fixed* term. `set_global` costs ~12µs per call on this
machine against ~0.13µs per converter, so at k=100 the linear term had only just
drawn level with the overhead and the log-log slope was still depressed. The
classifier's own header names this exact case — *"t(n) = a + b·n has a log-log
slope that is depressed at small n… the asymptotic pair is the one that answers
the question actually being asked"* — so adding a `k=1000` decade is that note
taken at its word, not a threshold loosened to get green.

It is still a judgement call, and it is the one item here I would want re-read
by someone who did not make it. The alternative reading — that the declared
class should be qualified rather than the range extended — is defensible.

## The other thing that changed under you

Running the oracle required `vcpkg install lua[tools]`, which needs `--recurse`
because adding the feature **rebuilds the port**. Both static libraries changed
hash (same 5.5.1, rebuilt):

```
lib/lua.lib        cde9dcc4… → e2a19202…
debug/lib/lua.lib  d8812602… → d27f1d64…
```

Everything was re-run against the rebuilt library and is green, but the build
environment is no longer byte-identical to what it was before this session.

---

## State on this date

All twelve suites pass on Windows x64.

| Suite | Result |
|---|---|
| C++ (Google Test) | 286/286 |
| TypeScript (vitest) | 1196/1196 |
| `check-invariants` | all match |
| `oracle` | 2678 cases, 0 DISAGREE |
| `exception-matrix` | 507/507 |
| `exec-parity` | 6695 cells, 0 DISAGREE |
| `roundtrip-matrix` | 4750 cells, 0 undocumented |
| `lifecycle-matrix` | 114 cells, 0 findings |
| `cross-context` | 0 findings |
| `capability-matrix` | 251 cells, 0 findings |
| `binding-balance` | 42 cells, 0 findings |
| `crossing-cost` | 20 cells, 0 failures |

Not re-run: the five sanitizer harnesses, which are macOS/Linux only
([`SANITIZERS.md`](SANITIZERS.md)) and were not part of this pass.

---

## The generalisation

The two product defects share a shape, and it is the shape to carry forward:
**a guarantee that is a language guarantee on one platform and a build-flag
guarantee on the other.** `std::exception` deep-copies — unless a define says
otherwise. `longjmp` skips destructors — unless the compiler unwinds. Both were
assumed, both were written down as assumptions in the source, and both held for
as long as one toolchain ran the code.

The seven instrument corrections share a different one, and it is the more
useful of the two: **each failed quietly in the direction of a plausible
answer.** `io.open` returned nil instead of raising. A regex matched zero
headings instead of erroring. An address went unscrubbed and compared unequal
while printing identically. None of these announce themselves; they are found by
an instrument that already had to explain a number, which is what the totals
frozen alongside each census are for. `perf-claims` reporting *"claim-shaped
lines examined"* next to its zero is why its blindness surfaced as a drift
rather than as a clean run.
