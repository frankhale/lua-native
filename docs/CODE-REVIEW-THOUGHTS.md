# CODE-REVIEW-THOUGHTS

An assessment of the code-review trajectory for this project: will future
reviews converge to reporting no significant issues, and what does "done"
actually look like?

**Short version:** convergence to *no significant issues* is achievable and
worth aiming for; convergence to *no findings at all* is the wrong target, and
chasing it can be counterproductive. The right measure of maturity is a **shift
in the character of findings**, backed by mechanical enforcement — not a raw
count trending to zero.

---

## What the two reviews already tell us

The most important observation is CODE-REVIEW-2's own diagnosis of
CODE-REVIEW-1:

> CODE-REVIEW-1's fixes were applied correctly at the sites it named, but
> several of the underlying hazard classes have **additional sites the first
> review didn't enumerate**.

That single sentence is the whole story of convergence in miniature. These
reviews are not finding random, unrelated bugs — they are finding **classes** of
hazard endemic to this domain:

- `longjmp` over live C++ objects (H1)
- unprotected metamethod-capable Lua calls → panic (H2, H6, M4)
- missing `lua_checkstack` (H4)
- raw `LuaContext*` / `lua_State*` that outlive their owner (H3, H5)
- thread/reentrancy guards keyed off the wrong flag (H9, H10)
- unbounded per-crossing bookkeeping (M2, M9)

CODE-REVIEW-1 fixed *instances*. CODE-REVIEW-2 found more instances of the same
classes, plus a few new classes. Whether the project converges depends entirely
on whether findings get fixed at the **class** level or the **site** level.

---

## Why "zero findings" is the wrong target

1. **Reviews are samplers, not proofs.** Each pass, with a given set of lenses,
   finds a subset of what exists. A third review with a fresh adversarial angle
   will very likely still find *something* — it just won't be H1-severity
   anymore. Diminishing returns is the realistic curve, not a step to zero.

2. **New code is new surface.** The `maxInstructions` execution-limit hook added
   in July 2026 is a concrete example: a new `lua_sethook` path, a new atomic,
   and a new `luaL_error` longjmp site inside the hook. A future review *should*
   scrutinize it — it would be a red flag if it didn't. As long as the code
   evolves, there is fresh material.

3. **Some issues are latent until usage changes.** The threading findings
   (H9/H10) matter only because of how the async paths get exercised. Change the
   concurrency pattern and dormant sites become reachable.

4. **This is a genuinely hard domain.** Lua linked as C into a C++ addon via
   N-API is close to a worst case: destructor-skipping unwinds, two threading
   models, manual registry-reference lifetimes, and GC finalizers firing on
   arbitrary threads. The bug surface is large and subtle by nature.

---

## What convergence should actually look like

The right definition of "done" is not a count — it is a shift in the
**character** of findings:

- **Early reviews:** systemic UB/correctness, whole classes, high severity.
- **Mature reviews:** confined to newly-added code, or genuine judgment calls
  (the deferred items), or low-severity polish.

The signal of maturity is:

> **No new instances of any previously-identified class, and everything found is
> either new code or a documented trade-off.**

Critically, the deferred backlog is **not** the same as unfound bugs.
`CODE-REVIEW-DEFERRED.md` is triaged, accepted risk (M4/M5 remainders, H9c, M11,
M12, …). A review that surfaces those again is working as intended — those are
decisions, not surprises.

---

## How to actually get there

The reason CODE-REVIEW-2 found more sites of CODE-REVIEW-1's classes is that
CODE-REVIEW-1 fixed **sites**, not **classes**. To break the long tail:

1. **For every past finding, do an exhaustive sweep, not a point fix.** When a
   review says "unprotected `lua_getfield` here," the response should be: grep
   *every* metamethod-capable call on a user table, route them all through the
   protected shim, and treat any remaining raw call as a commented, reviewed
   exception. Same discipline for `lua_push*`-without-`checkstack`, and for raw
   context pointers. This is the highest-leverage change to the *process*.

2. **Encode invariants mechanically so a class can't regress.** This is where a
   Lua + C++ embedding wins big:
   - **ASan / UBSan builds in CI** would catch the longjmp-over-locals,
     use-after-free, and out-of-bounds-stack classes automatically and
     continuously. Many of these exact findings are what those sanitizers exist
     to catch.
   - **TSan** for the async/worker races (H4/H9).
   - Stack-balance assertions — `StackGuard` already exists; make it ubiquitous
     and assert in debug builds.

   These convert "a sharp reviewer might notice" into "the build fails," which
   is what actually drives the count down and keeps it down.

3. **Once the tree is clean, review the diff, not the whole tree.** After a
   baseline is established, scoping reviews to changed code makes findings
   naturally track new work — and makes "few/no findings" a meaningful signal
   rather than an artifact of reviewer fatigue.

---

## Bottom line

Yes — expect future reviews to stop reporting significant issues; that is a
realistic and worthy goal. But measure success as:

> *Findings have collapsed to new-code and judgment calls, and no
> previously-identified class has reappeared* — backed by sanitizers and
> exhaustive sweeps rather than hoping the next reviewer runs out of things to
> say.

The two reviews done so far are trending the right way: CODE-REVIEW-1 was fully
resolved and re-verified, CODE-REVIEW-2 was more structured (four independent
passes), and test coverage grew (402 → 425 TypeScript, 162 → 170 C++). But
CODE-REVIEW-2 finding new sites of CODE-REVIEW-1's classes is the tell that the
work is still happening site-by-site. Close that gap — fix classes, enforce with
sanitizers — and the convergence you're expecting becomes the natural result
rather than a hope.

---

## Addendum (July 21, 2026, after CODE-REVIEW-6)

The prediction held, in the most literal way possible. Across CR-3 → CR-6 the
severity of *net-new* findings fell (H-class systemic → OOM-window accounting →
a coverage boundary), exactly the "shift in character" this document called the
real measure of maturity. But the site-vs-class tell never went away:

- **CR-4** found new sites of CR-3's classes (N1/N2 — longjmp/OOM accounting in
  the *new* M2/M3 machinery).
- **CR-5** found F1, a coverage *boundary* of CR-4's N4 sweep, plus F11 — a
  brand-new instance of the H1 "std::runtime_error unwinds past N-API → process
  abort" class, in `register_class`, a path every earlier pass missed.
- **CR-6** then found that F11 had fixed the **site, not the class**: the exact
  same defect was still live in `set_userdata` and `set_print_handler`, this time
  triggerable by ordinary Lua (`setmetatable(_G, {__newindex=...})`) with no
  `maxMemory` at all — a **high-severity process abort inside a fix that named
  the class.**

That is the whole thesis in one arc. A one-line `try`/`catch` around the site the
review happened to name did not stop the class; the next pass simply found the
next site, at higher severity. CR-6 closed all four reachable sites *and* added a
per-entry-point regression matrix (arm a raising `_G` metamethod, invoke every
binding method reaching a `RunProtected`-backed core call, assert a catchable
throw and process survival) — the first class-level enforcement for this hazard.

Mechanical enforcement is now in place — and deliberately **not** as a CI service
(this project builds locally). Four sanitizer harnesses cover the memory/UB and
race classes; all are local build flags in `binding.gyp`, run whenever you want.
See `docs/SANITIZERS.md` for the full write-up and the July 2026 stress-test
results; in brief:

- **`test-cpp-asan`** — the `LuaRuntime` core under ASan+UBSan (178 tests clean).
- **`test-ts-asan`** — the `.node` addon under ASan+UBSan, run through the whole
  vitest suite via a preloaded runtime. **This is the important one**: the binding
  layer is exactly where the historical use-after-frees lived (H3, L5, L6, H9c),
  and the standard C++ ASan build never touches it. 454 tests clean, plus a
  1,200-iteration `--expose-gc` stress run of every one of those UAF patterns —
  no report.
- **`test-cpp-tsan`** — the core under TSan; 0 races, expected, because the core
  suite is single-threaded. A guard, not a finder.
- **`test-ts-tsan`** — the addon under TSan through the async suite. It runs and
  reports 0 races, but with a real limit: TSan can't see libuv/V8/Lua
  synchronization, so a clean run is "no race in the interleavings that happened,"
  not a proof. Best-effort probe, not a gate.

Scope and honesty about what none of them catch:

- ASan/UBSan target memory-safety and UB (use-after-free on a released handle, a
  longjmp over a C++ destructor, out-of-bounds stack reads). They would **not**
  have caught F1: an uncaught C++ exception reaching `std::terminate` is a
  different failure mode. For the H1 abort class specifically, the CR-6
  per-entry-point regression matrix is the enforcement.
- Sanitizers are runtime tools — they only see bugs on paths a test executes. The
  clean stress run above is strong evidence, not proof; its value came from
  deliberately driving the adversarial + forced-GC paths. New adversarial tests
  are what extend the coverage.

So the tail is now closing from three directions: a behavioral matrix for the
exception-abort class, ASan over both layers for the memory/UB classes, and a
best-effort TSan probe for the async races. The remaining step is discipline —
adding each new binding method to the H1 matrix, and running `test-ts-asan` (with
a GC stress pass for lifetime changes) before shipping. CR-6 remains the
cautionary tale for why the discipline matters: a fix that names a class but
sweeps only one site leaves the next site for the next pass, at higher severity.

---

## Addendum (July 27, 2026, after CODE-REVIEW-9)

CR-9 is the first pass to invert the arc above, and the inversion is worth
recording because it changes how a low-severity finding should be triaged.

Nothing regressed. Every CR-8 fix was intact, and the fourteen feature commits
reviewed were visibly written with the prior reviews in hand — `create_environment`
opens a `CallScope` and says why; the debug hook copies its callback owner before
dispatch so a hook that removes itself mid-call cannot destroy the running
`std::function`. The high-severity finding was not introduced by careless new
code. **It was created by careful new code landing next to an old, unswept gap.**

`reset()` — new in this window, and the first API that can free the `lua_State`
while the context survives — correctly refused to run when `call_depth_ > 0`.
But `call_depth_` is raised by `CallScope`, which only eight of thirty-six
binding methods opened. Before `reset()` existed, a missing `CallScope` cost one
leaked `js_error_registry_` entry: CR-8 F5, correctly triaged **low**. After
`reset()` existed, the same omission meant the reentrancy guard was simply not
armed, and nine entry points were reproduced crashing the process with an
ASan-confirmed use-after-free. One of them, `gc('collect')` reaching an ordinary
Lua `__gc` finalizer, needed no hostile input at all.

So the thesis of this document — *fix classes, not sites* — needs a second
clause:

> **An unswept gap is not merely a known low-severity residual; it is a hazard
> whose severity is set by code that has not been written yet.**

CR-8 F5 was not mis-triaged. The reason to have swept it anyway was never its
severity — it was that a partially-held invariant is a trap for the next
feature, and the next feature does not know the invariant is only partially
held.

The remediation drew the corresponding process lesson. Both CR-9 findings had
the same root shape: the binding layer knew it was about to run Lua, and the
core — which owns both the reentrancy question and the execution budget — was
not told. The fix therefore did not add twelve `CallScope`s and hope the next
author remembers the thirteenth. It moved the invariant into the core, where a
single RAII scope (`LuaRuntime::ExecutionScope`) brackets every path that can
run Lua and maintains both facts at once. A new binding method is now safe by
construction rather than by review, because it never has to know the invariant
exists. That is what "enforce the class mechanically" looks like when the class
is a *precondition* rather than a memory error — the sanitizers cannot see it,
and a behavioral matrix would only cover the entry points someone remembered to
enumerate.

One data point on the harness, in its favour: the CR-8 F2 plumbing held (the
`global.gc` assertion is present and the GC-lifetime pins really ran), and the
ASan harness identified F1 on the first instrumented run *once a reproduction
drove the path* — again confirming that its value is bounded entirely by the
adversarial coverage of the suite it runs. The eleven new guard tests crash the
vitest worker outright without the fix, which is the loudest possible form of
the "regression pins must not rot" lesson from CR-8.

---

## Addendum (July 28, 2026, after CODE-REVIEW-10)

CR-9's remediation was the first *structural* fix in this series, and it worked:
CR-10 found no binding method that had forgotten a `CallScope`, because the core
no longer lets one matter. The thesis about relocating invariants held.

What CR-10 adds is the next turn of the same screw:

> **Relocating an invariant does not make it complete; it makes its *statement*
> load-bearing. Audit the wording against the mechanism, not against the sites
> the last review listed.**

Once the core owned "Lua is executing," everything downstream depended on the
core's definition of that phrase — and the definition chosen, *runs Lua*, was
one word narrower than the hazard, which is *allocates from Lua*. Every
metamethod path was found and bracketed. Both `lua_resume` sites were found.
`lua_gc` was found, with the `__gc`-finalizer reasoning spelled out in the
comment. The chunk loader — the heaviest allocator in the library, called by
seven core methods — was not, because it does not *look* like it runs Lua. It
only allocates, and allocation is how the collector gets its turn. Three entry
points (`compile`, `compile_file`, `execute_async`) were reproduced crashing with
an ASan-confirmed use-after-free at the identical instruction CR-9 F1 named,
reached through the parser instead of a metamethod.

The second finding is the more humbling one, and it argues for a new standing
test category rather than a new design rule. `host_functions_` — the map every
JS callback dispatches through — sits three lines below `userdata_gc_callback_`
and `output_handler_` in a `~LuaRuntime` teardown block whose comment states the
exact hazard it fails to cover. CR-9 *edited that very block* without noticing
the fourth bridge. Seven lines of entirely ordinary code (a JS callback plus a
Lua `__gc` finalizer) segfaulted; with a table handle keeping the runtime alive
past its context, it segfaulted mid-program at an arbitrary GC point rather than
at exit.

Nine passes missed it for one reason, and it is a coverage reason rather than a
reasoning one. The suite has eleven `__gc` tests and several *do* call a JS
callback from a finalizer — but every one of them drains the finalizer with an
explicit `gc('collect')` while the context is still alive. None ever left one
**pending at destruction**, which is the only state in which the bug fires. The
sanitizers found it instantly once a reproduction drove the path; they had never
been given one.

So the harness lesson from CR-6 and CR-9 gets a concrete extension:

> **A teardown-ordering bug is invisible to a suite that always tears down
> cleanly.** For every piece of state that bridges the two layers, there should
> be one test that leaves it *in use* at destruction time rather than draining
> it first.

The remediation follows the CR-9 pattern deliberately. It did not add three
`CallScope`s and stop: all seven chunk loaders are bracketed, including the four
that were only ever *masked* by the binding's `call_depth_`, so the core's
invariant is self-sufficient rather than co-dependent. And F2 was fixed at the
class level — a liveness flag captured by the wrappers, which holds however the
destruction races — with the explicit unbind in `~LuaContext` as belt and
braces rather than as the mechanism. One subtlety is worth remembering because
the tidier-looking version is wrong: the wrappers need a flag distinct from
`alive_`, and the unbind must live in `~LuaContext` rather than `~LuaRuntime`,
because `reset()` also destroys a runtime and the state it retires must still be
able to run its own finalizers against the live context. Both are pinned by
control tests, since both are the kind of thing a later cleanup would happily
"simplify" away.

---

## Addendum (July 28, 2026, after CODE-REVIEW-11)

That last sentence turned out to be the whole of CR-11, and it arrived faster
than expected. This document has spent nine passes on one thesis — *fix classes,
not sites* — and CR-11 is the first pass to find the two failure modes that
thesis does not by itself prevent. Both are about durability rather than
reasoning.

**A fix is only as durable as the thing that stops it being undone.** CR-2 found
that the type-converter loop held a reference into a vector across a call that
could reallocate it, rewrote it as an indexed loop, and left a comment saying
exactly why the indexed form was required. Nine days later a commit whose message
was "add `const` and `[[nodiscard]]` annotations" turned it back into a
range-`for`; a day after that, "fix clang-tidy issues" did the same to its twin
in the other direction. Neither commit touched the comment. The file therefore
*documented* the fix immediately above code that did not implement it, and three
subsequent review passes read that comment, agreed with it, and moved on. CR-11
reproduced the result as a `heap-use-after-free` in both directions.

> **A comment describes intent; only a test or a lint suppression describes what
> the code is currently doing. When a fix depends on a non-obvious *form* —
> indexed loop, copy-before-call, scope placement — leave a marker the tooling
> honours, not only prose.**

**An enumeration error is invisible to a reviewer who checks the sites the fix
names.** CR-9 F4 stated its class correctly ("a handler that replaces itself
mid-call must not destroy the `std::function` currently executing") and fixed two
members of it, `output_handler_` and `debug_hook_`. The third —
`host_functions_`, one entry per registered JS callback, by far the largest
population — was never counted, and `set_global('foo', fn)` called from inside
`foo` remained a use-after-free. M2 built a reclaim mechanism precisely so host
functions would stop accumulating, and wired it to one of the five sites that
mint them; the other four pinned their JS closures for the life of the context.
Neither is a reasoning failure. Both are census failures.

> **When a fix names a class, write the full member list down at the class's
> home, not at the site being fixed.** `output_handler_`'s comment was the right
> text in the wrong file: the rule it stated governed a map declared a thousand
> lines away and never mentioned it.

Two smaller lessons worth carrying forward, both about the *harness* rather than
the code:

- **A regression pin must fail without the fix, in the exact shape it will be
  written.** CR-11's F1 needs *two* registered converters — a range-`for` caches
  `end()` at loop entry, so with one converter the invalidated cursor still
  compares equal and the run is clean. F2 needs a Promise-returning callback and
  a capture list past libc++'s small-object buffer — with a plain return the
  compiler keeps `this` in a register, and with a small capture the closure never
  leaves the map node, so ASan sees nothing either way. The natural way to write
  both tests produces a test that passes without the fix. Every pin in this
  remediation was run against the pre-fix tree, and the ones that did *not* fail
  were rewritten until they did.
- **Add "supersede" to the standing test categories**, beside CR-10's "leave it
  in use at destruction". The suite had thorough coverage of *failed*
  registrations stranding nothing (CR-8 F3) and none at all of *successful,
  replaced* ones — the same one-step-past-where-every-test-stops shape that hid
  CR-10 F2.

One closing data point in the sanitizers' favour, and a nicely humbling one. The
first draft of CR-11's own C++ probe for F3 declared its recorder after the
`LuaRuntime` it observed, so `~LuaRuntime`'s teardown finalizers fired into a
destroyed `std::vector`. `test-cpp-asan` reported it as a `stack-use-after-scope`
on the first run. The test written to pin a lifetime bug had the lifetime bug —
which is as good an argument as this series will produce for keeping the
sanitizer harnesses pointed at the tests as well as the code.
