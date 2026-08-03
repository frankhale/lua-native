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

---

## Addendum (July 28, 2026, after CODE-REVIEW-12)

CR-12 is the first pass to report nothing above low severity, and it argues —
correctly — that convergence was measured on a diff rather than on a tree. What
the *remediation* of CR-12 adds is a lesson aimed one level up, at the review
itself.

**A review's prescriptions are claims too, and they fail in the same way its
subjects do.** CR-12's closing note tells the reviewer to treat any comment
asserting completeness as a claim to be checked. Applied honestly, that rule does
not stop at the code under review. Two of this pass's five recommendations did
not survive being driven:

- **F5 proposed wiring `HasClass` into `register_class`'s duplicate check.** It
  looks obviously right: a dead public method and a check that cannot see the
  state's own registry. But a registration that *fails* after `luaL_newmetatable`
  leaves the class metatable behind, so the probe reports a name as taken that
  the binding has already rolled back and must let the caller retry. Wiring it in
  broke the CR-8 F3 pin on the first run. The two questions — "does this state
  have a metatable under this name" and "did this context register this class" —
  read as synonyms and are not.
- **F4 proposed guarding `StageJsError` on `runtime->IsExecuting()`.** Also
  plausible, and it would have silently disabled error fidelity through async:
  the promise-settlement path stages from a microtask with no execution in flight
  at all, which is indistinguishable from a retired state's finalizer by that
  test. The condition that actually separates them is owner identity, which the
  wrappers have to *carry* — no ambient state answers it.

Both were caught the same way, and it is the cheapest possible way: implement the
recommendation, run the existing suite, watch a pin from four reviews ago fail.
Neither needed insight. Both needed the fix to be *built* rather than agreed with.

> **Implement a recommendation before believing it. A review that reasons from
> the same reading of the code that produced the finding will reproduce that
> reading's blind spots in its prescription — and the existing regression suite
> is the cheapest referee available, because it encodes contracts the reviewer
> was not thinking about.**

**The other direction: a finding's severity is also a claim.** F4 was calibrated
low on the strength of "I could not construct a consumer", with the honest note
that the calibration rested on being unable to reach it. The consumer is two
lines — any later host-call failure that raises without staging, because the
bridge's catch prefers a pending value over its own message; returning a Promise
outside `execute_async()` is exactly that path. Before the fix, an unrelated
`execute_script` a generation later throws the retired state's error verbatim.
The finding was right about the mechanism and wrong about the reach, which is the
better failure of the two — but "I could not drive it" bounds the harness, not
the hazard, and the review says so about its own sanitizer runs three paragraphs
later. That sentence deserves to be applied to the findings as well as to the
tooling.

**What went right, worth keeping.** F2 asked for an invariant that could be
checked instead of believed, and the version that landed states it as a command:
`grep -n 'lua_pushcclosure(.*LuaCallHostFunction' src/core/lua-runtime.cpp` must
return exactly one hit. F3 asked for the "can allocate from Lua" enumeration to
be recorded where the invariant lives, so the class can be re-verified by reading
one list instead of re-deriving it; it now sits next to `IsExecuting()` and ends
with "unbracketed: nothing". Both are the same move — convert a property that
currently lives in a reviewer's head into something the next pass can confirm in
seconds — and both are cheaper than the review that discovered the need for them.

**And one nit that was not a bug.** F5's `Propagate` staleness cannot occur:
`set()` mutates the object `value_` holds rather than replacing it, so the
pre-loop snapshot is a handle to that same object and every push already sees the
newest contents. The re-read landed anyway, because it costs nothing and removes
a dependency on a property no caller states — but the comment and the test both
say plainly that they pin behaviour rather than close a defect. Recording a
non-finding as a non-finding is the same discipline as recording a deferral: the
ledger is only useful if it is honest in both directions.

---

## Addendum (July 28, 2026, after CODE-REVIEW-13)

CR-12 declared convergence and, to its credit, immediately qualified it: the
measurement was taken on a diff, not on a tree. CR-13 is what that qualification
was worth. The CR-12 remediation verified clean under an independent
re-derivation — and the tree it sat in contained an ASan-confirmed
use-after-free reachable from three public entry points, none of them in the
diff. One pass after "no findings above low", the finding is high.

That is not a failure of the convergence thesis. It is the thesis working as
stated: *reviews are samplers, not proofs*, and a sampler that keeps drawing
from the same distribution keeps returning the same answer. What changed in
CR-13 was not effort or care. It was one word in the question.

**The audit question had a variable in it, and nobody was varying it.** Every
pass since CR-9 has checked the reentrancy guard by asking **"is it armed before
Lua runs?"** The answer was always yes — CR-9 made that structurally true by
moving `IsExecuting()` into the core, and that fix has held for four passes
without a single new site. The guard has a second half, `call_depth_`, whose job
is to say *"a binding method is on the stack, so JS may re-enter"*. Nobody asked
**"is it armed before user JS runs?"**, and the answer there was no: every method
opened its `CallScope` around the call into Lua, while the argument-conversion
and definition-reading phase above it — type converters, definition-object
getters, Proxy traps, all of them host extension points the library advertises —
ran unguarded. `reset()` was legal there, and a method caught mid-flight finished
its work against a state that no longer existed: handles pairing the new runtime
with the old state's registry refs, silent reads and writes onto unrelated live
tables, and a freed `lua_State` dereferenced at finalization.

So the clause this pass adds is about the shape of the audit rather than the
shape of the code:

> **When a guard protects against re-entrancy, the audit question is "armed
> before *what*?" — and the answer is not the thing the guard is named after.
> It is the first line that can run code you do not control.** At a JS↔native
> boundary those differ by the entire conversion phase. Enumerate the kinds of
> user code a method can run — converter, getter, trap, metamethod, finalizer —
> and check the guard against the *earliest* of them.

Three second-order lessons, each of which cost something to learn:

**Relocating one half of an invariant can hide that the other half was never
relocated.** CR-9's fix was right and remains right. Its side effect was that
`IsExecuting()` began answering every question anyone asked about reentrancy, so
`call_depth_` stopped being audited on its own — it survives in `Reset()` as what
the comment called "a cheap second opinion". It is not a second opinion. It
answers a different question, and it was the only thing guarding a window
`IsExecuting()` cannot see by construction. The remediation now reports the two
conditions with two distinct error messages, because a single message that said
"while Lua is executing" for a case where no Lua was running is exactly how the
distinction got lost.

**A comment justifying the *absence* of a guard is more dangerous than one
justifying its presence, and should be read as a completeness claim.** CR-12
established that "the single place", "every path", "all callers" are claims to
check. `TableHandlePairs` carried the inverse form — *"pairs() is raw traversal
and needs none"* — which is true about metamethods, silent about JS, and
terminates inquiry just as effectively. Three passes read it and agreed. A claim
that something is unnecessary is still a claim; the tell is that it explains a
difference from its siblings, and eleven siblings did have the guard.

**Check-then-use across user JS is its own class, and this codebase has it in
five places.** `targetRef->runtime.get() != runtime.get()`,
`threadData->runtime.get() != runtime.get()`, and their relatives each compare a
captured pointer against a member that user JS can change between the check and
the use. Every one is correct against the threat it was written for — a handle
from *another* context — and blind to the same context becoming a different
generation. Entry-armed scoping closes all of them at once, which is the
argument for fixing this at the class level rather than adding a re-check to
each.

Finally, on the harness. All four sanitizers and 796 tests passed on the tree
containing this bug, and ASan reported the use-after-free within seconds of a
reproduction existing. It had no way to invent one: no test in the suite called
`reset()` from inside a converter or a getter, because nobody had thought to.
CR-10's standing rule gets a sibling:

> **For every guard, one test per kind of user code the surrounding method can
> run** — converter, definition getter, Proxy trap, metamethod, finalizer. A
> guard is only as good as the callback shapes someone thought to try, and the
> suite is where that thinking is recorded.

The ten pins added with this remediation are that category's first members;
eight of them fail against the pre-fix binary.

---

## Addendum (July 28, 2026, after CODE-REVIEW-14)

CR-13 did the thing this document has asked for since CR-2: it converted a
property that lived in a reviewer's head into a procedure the next reviewer can
run in seconds — *"split lua-native.cpp by function, find the first `CallScope`
and the first `.Get(` per entry point, compare."* That was right, and it worked:
every one of CR-13's seven doors is still shut and re-verifying them took minutes
rather than a pass.

It is also how CR-14's high finding survived. **The check ran clean on a tree
containing the very hazard it was written for.** Not through carelessness — the
sentence that defines it says "per entry point" and never says what an entry
point *is*. Read at all, the only definition under which its recorded count of
six comes out right is "`LuaContext` instance method". The hazard does not care
whether the frame is a method; it cares whether user JS can run while the addon
holds live references into a `lua_State` that `reset()` can retire.
`LuaScriptAsyncWorker::OnOK` is a main-thread N-API completion callback with no
`CallbackInfo` at all, it clears `is_busy_` and *then* runs the Lua→JS converters
over the run's results, and it produced the same ASan `heap-use-after-free` at
`lua-runtime.cpp:782` that CR-13 F1 did.

So the clause this pass adds is about mechanical checks rather than about guards:

> **A mechanical check has two halves: the predicate and the universe it ranges
> over. The predicate is almost always written down and the universe almost
> never is — and a check whose universe is narrower than its class returns
> "clean" forever.** Write the universe beside the predicate, and justify it
> against the hazard rather than against the sites the finding happened to name.

Three second-order lessons, each of which cost something:

**A completeness claim decays fastest exactly where being wrong is harmless.**
CR-13's enumeration had ten omissions and every single one was inert — seven
scope-free methods that run no user JS, two helper-hidden reads that fail closed,
one `SharedTable` sibling that delegates to a scoped call. That is not luck, it
is the mechanism: an omission with a consequence gets found by a test or a crash,
so the ones that survive in a hand-maintained list are precisely the ones nothing
detects. The list therefore *looks* healthy right up to the moment a non-inert
member joins it. CR-12's rule was "treat a comment asserting completeness as a
claim to be checked"; the sharper form is **check an enumeration against a
generator, not against your memory of writing it.** A grep that produces the list
is worth more than a list a grep would have produced — which is why CR-12 F2's
one-hit grep has aged better than any prose enumeration in this codebase.

**Address identity is not identity, and the two are textually identical.** The
binding has five markers that answer "did this context mint you?", and four of
them compare `data->runtime.get() == runtime.get()`. Those four are sound — but
not for any reason visible at the comparison. They are sound because the `*Data`
struct holds a `shared_ptr<LuaRuntime>`, declared in another file, whose job of
keeping the address unique is mentioned nowhere near the check. The fifth,
`__luaClassOwner`, holds no share, so once its context was collected the
allocator handed the block to the next `make_shared<LuaRuntime>` and a retained
instance passed an unrelated live context's ownership check — silently aliasing
that context's own userdata, in about two runs in three. CR-13 noted that this
codebase's identity guards "all share a failure mode" along the *generation*
axis; the *lifetime* axis is a second one, and it is the axis where the guard was
wrong rather than merely narrow. **Where a pointer is used as an identity token,
its uniqueness comes from a lifetime — so name the lifetime at the comparison, or
don't use a pointer.** The fix uses a monotonic id, which has no lifetime to
name.

**Ordering that is correct at every site can still be undefended.** Three
functions marshal a completed async run's values into JS, and marshalling runs
user JS. Two of them convert before dropping `is_busy_` and one drops it first.
Nothing anywhere stated that the order mattered, so the two correct sites were
correct by accident and the third was not a regression from a rule — it predated
the rule and was never brought under it. The remediation therefore records the
constraint at `ClearBusy()`, the function that drops the flag, rather than at the
two sites that got it wrong: **an invariant belongs at the operation that can
violate it, not at the callers that happened to.** That is the same relocation
CR-9 made for `ExecutionScope`, at a much smaller scale.

Finally, the harness. All four sanitizer runs and 806 tests passed on the tree
containing F1 — the third consecutive pass where that sentence is true — and ASan
reported the use-after-free within seconds of a reproduction existing. CR-13's
standing rule was *"for every guard, one test per kind of user code the
surrounding method can run."* The suite **has** the kind: a `register_from_lua_-
converter` handler that calls `reset()` is CR-13's own first regression test.
What it did not have is that converter at this **site**. So the rule needs its
other half:

> **One test per kind of user code × per site that can run it.** The kinds are a
> short list a person can hold in their head; the sites are a long one that has
> to be generated. When a rule is expressed as kinds × sites, the sites are
> always the half that rots.

One data point in the pins' favour, and it is the loudest this series has
produced: the F1 GC-lifetime pin does not merely fail against the pre-fix binary,
it terminates the vitest worker with `mutex lock failed: Invalid argument` —
`UnrefOrDefer` taking a mutex on a destroyed `LuaRuntime`. And one against
complacency: the F2 pin, written the obvious way as a single A→B pair, passed
about one run in three purely because the allocator did not recycle the block
that time. It had to be rewritten to offer instances from eight collected
contexts before it failed reliably. **A pin that depends on the allocator is not
a pin until you have run it enough times to know its failure rate** — the same
lesson CR-11 learned about needing two converters and a large capture list, in a
new disguise.

---

## Addendum (August 3, 2026, after CODE-REVIEW-15)

CR-14's clause was about mechanical checks: a check has a predicate and a
universe, the universe is usually unwritten, and a check whose universe is
narrower than its class returns "clean" forever. That held up — the universe
CR-14 wrote down is why re-verifying its remediation took minutes rather than a
pass.

CR-15 is the same idea moved one level out, and it is the first finding in this
series that neither a wider universe nor a sharper predicate would have caught.
Writing the universe fixes *where* you look. It does not fix *what you are
looking for*, and the whole of CR-15's high finding lives in that gap.

Every pass since CR-9 has audited one operation: `reset()`. It retires the
`lua_State`, so it accumulated three guard conditions across three passes — CR-9
added `IsExecuting()`, CR-13 added `call_depth_`, CR-14 extended the busy
condition to cover the async marshal — each because the previous set was
insufficient. That work was correct and it holds. What nobody asked is whether
`reset()` is the only operation of its kind. It is not.
`execute_script_async` / `execute_file_async` hand the same `lua_State` to a
libuv worker thread, which takes it away from its current holder exactly as
`reset()` does, and they check one of the three. A registered JS callback that
starts an async run — seven lines, no hostile input — puts two threads in one
Lua state and segfaults deterministically, main thread faulting in `_longjmp` on
a shared `errorJmp` chain while the worker faults in `lua_load`.

> **A guard is defined by a pair — the hazard, and the set of operations that
> create it — and only the hazard tends to get written down. When you harden an
> operation, ask what else does the same thing to the same object. The sibling
> you miss will be guarded by whatever it happened to inherit, and the reason it
> looks fine is that what it inherited was genuinely designed for something.**

Three second-order lessons, each of which cost something:

**A one-directional guard reads as a bidirectional one, and the writer is never
covered by the protocol it establishes.** `is_busy_` is set by the async
launchers and read by every other entry point. CR-1 H4 established that read side
and swept it exhaustively; re-driven this pass, **21 of 21 main-thread doors
refuse while a worker runs**, including every entry point added in the fourteen
passes since. The sweep is perfect and it is perfectly one-directional. The
launcher *writes* the flag, so it reads as a participant in the mutual-exclusion
protocol rather than as the one operation the protocol does not cover — and no
amount of auditing the readers will surface it, because auditing readers is what
a mutual-exclusion flag invites you to do. This is a different failure from
CR-11's census failures: the member was not miscounted, it was miscategorised.

**A function's classification is a claim with an expiry date, and the expiry is
whenever somebody appends to it.** The nastiest of the three doors is
`reset()`'s own replay phase. `reset()` was classified — correctly, once — as
"the operation being guarded", and the `CallScope` comment filed it under the
methods that need no scope for exactly that reason. Then it grew a second half:
CR-9 F3 added searcher replay, CR-12 added shared-table replay, and the print
handler and debug hook re-arming landed alongside. That half runs the callbacks
object's Proxy traps and the registered type converters against the state
`reset()` has just minted, with `is_busy_` false, no Lua executing, and
`call_depth_` at zero — so it could hand the brand-new state to a worker while
the replay kept writing to it (SIGSEGV, 4 of 10 runs). Note what this does to the
fix: adding the two missing conditions to the launchers does *not* close this
door, because all three read false. `reset()` has to declare that it is holding.
Every guard in the file trusted a one-line description that was accurate when it
was written and that nobody re-read after the function doubled in size.

**An enumeration written as the remedy for decaying enumerations decayed
immediately.** CR-14's closing note is the sharpest process advice in this
document: *check an enumeration against a generator, not against your memory of
writing it.* The `lua_next` residual list CR-14 F5 wrote in the same remediation
has two members. `grep -n lua_next src/core/lua-runtime.cpp` returns three
traversals in the class, and the missing one — `TablePairs` — is not a marginal
member: it ran a full `lua_pcall` per value inside a live cursor, where the two
listed members intern a string and take a `luaL_ref`. Its own sibling thirty
lines below, `TableIPairs`, already collected under protection first and carried
a comment explaining why for the neighbouring hazard. No insight was required to
catch this; only the difference between writing a list and running the grep that
produces it. **The instruction to use a generator has to be followed in the
commit that writes the list — that is the only moment when the author still
believes it might be wrong.**

Finally, the harness, and an honest correction. All four sanitizer harnesses and
814 tests passed on the tree containing F1 — the fourth consecutive pass where
that is true — and this time the sanitizers were never going to help. A race
between the main thread and a libuv worker is TSan's department, and
`test-ts-tsan` is explicitly a best-effort probe that cannot see libuv/V8/Lua
synchronization. What found F1 was a probe that asked one question of
twenty-two entry points and noticed the twenty-second answered differently.

The correction belongs here too, because CR-12's addendum asked for it. CR-15's
F2 was *initially written up as driven*, on the strength of a probe showing a
200-entry table yielding 2682 entries during a traversal. Re-reading the probe
showed all 2482 injections happened before the traversal began: the table
honestly had 2682 entries. Several later attempts to time a finalizer into the
cursor all failed, and the finding shipped as an undriven hardening. **The
failure mode was reading a number that matched the expected shape and stopping.**
CR-12's rule — implement a recommendation before believing it — has a twin:
*re-read a reproduction before believing it, especially when it agrees with you.*

CR-14's standing rule was one test per kind of user code × per site that can run
it. F1 adds a third axis, and it is the cheapest of the three:

> **For every guarded resource, one probe per *direction*.** The suite has
> exhaustive coverage of "call X while an async run is in flight". It had
> nothing for "start an async run while X is on the stack" — because the guard
> is named for a *state* rather than a *transition*, and a state only suggests
> one question.

One last lesson, and it is the most embarrassing one in this document, because
the review committed the error in the same file where it quotes the warning
against it.

CR-15's first draft filed the untyped marker Externals under **"verified and
rejected"** — the section for suspicions that held up under scrutiny. The
reasoning was that a wrong-kind External passes every identity check (all four
`*Data` structs begin with a `shared_ptr<LuaRuntime>`, so the check reads the
right field of the wrong struct), that this is genuinely reachable from JS, but
that *no crash could be produced*, because the reads that would be wild land on
a pointer `MakeRegistryOwner` always initialises to `nullptr` and
`LuaFunctionRef` and `LuaTableRef` happen to be layout-identical. Two accidents
of struct layout doing the work of a guard — noted as luck, and deferred.

Fixing it produced a better probe, and the better probe showed the assessment
was simply wrong. The forged `release({_coroutine: fn.__luaFnOwner})` calls do
not merely fail to crash; they **succeed**, and they destroy the genuine
handles' registry refs through the mistyped struct. The tell was sitting in the
probe output the whole time: the *control* assertions at the end — the ones
using the untouched handles — failed with "table handle has been released" and
"coroutine has been released". A control failing is the loudest signal a probe
can produce, and it was read as noise because the interesting lines above it
said "no crash".

> **"I could not crash it" is a statement about the probe, not about the
> hazard** — CR-12's addendum, verbatim. What CR-15 adds is where the violation
> hides: not in the assertions you are watching, but in the *controls*. A
> control that fails is telling you the setup is no longer what you think it is,
> and in a memory-safety probe that is usually the finding rather than a flaw in
> the test.

This is the second correction of its kind in one pass — F2's traversal probe was
also initially written up as driven, on a number that matched the expected shape
and turned out to be counting injections that happened before the traversal
began. Both errors have the same root, and it is not carelessness: **a
reproduction that agrees with your hypothesis gets read once, and one that
disagrees gets read three times.** The discipline CR-12 established for
recommendations — implement it before believing it — needs its twin stated
plainly, because this pass demonstrates it twice in opposite directions:

> **Re-read a reproduction before believing it, and re-read the ones that
> confirm you first.**

---

## Addendum (August 3, 2026, after unifying the occupancy model)

This document has argued since CR-2 that the measure of maturity is a *shift in
the character of findings*. After CR-15 it was worth checking whether that shift
had actually happened, and the honest answer was no. Counting the high-severity
findings from CR-6 onward and classifying them:

**Seven of ten are one family** — user code runs at a moment the native code did
not expect, and claims, frees or invalidates something the native code is
mid-way through using. CR-9 (a method with no `CallScope`), CR-10 F1
(unbracketed chunk loaders), CR-11 F1 (a converter reallocating the vector being
iterated), CR-11 F2 (a callback replacing itself mid-call), CR-13 (`reset()`
during argument conversion), CR-14 (`reset()` during the async marshal), CR-15
(a worker start while the main thread holds the state).

Severity was not falling. The series was producing roughly one high per pass,
three passes running, all from the same family. That is not convergence, and the
reason it looked like progress is that each fix was correct: the site closed,
the class stayed open, and the next pass found the next site.

**The root cause was countable.** Ten occupancy and liveness variables across the
two layers, four of which (`is_busy_`, `IsExecuting()`, `call_depth_`,
`in_reset_`) answer "who holds the `lua_State`" — and every guarded operation
picked a subset **by hand**. `reset()` checked all four, having accumulated them
one per review pass. `execute_script_async`, which does the same thing to the
same object, checked one. Nothing connected them, and nothing made a *new*
operation inherit the right set.

So the fix was not another site, and not another comment enumerating the class.
It was to make the class un-instantiable: one `Claim` set, one `CurrentClaims()`
that computes what is held, one `RejectIfOccupied` that reports it, and named
**policies** (`kSyncApi`, `kExclusive`, `kRetireState`) that operations *declare*
rather than assemble.

> **When the same class produces a finding every pass, stop fixing sites and
> count the variables the class ranges over. A hazard family that keeps
> recurring is usually a missing abstraction wearing a disguise — and the tell
> is that the fix for pass N looks nothing like the fix for pass N−1 even though
> the bug is the same bug.**

Two things about this that are worth carrying into future work:

**The inheritance property has to be demonstrated, not asserted.** It is easy to
write a refactor that *looks* unified and still has three copies of the policy.
The check is a negative one: remove a claim from the single `kExclusive`
definition and watch all three operations lose that guard simultaneously. They
do — including `reset()`, which inherits through `kRetireState`. One line, three
operations. Conversely, adding a fifth kind of holder now protects all of them
without any being edited, which is precisely what CR-9, CR-13, CR-14 and CR-15
each had to do by hand, once each, after the fact.

**Unification is not the same as tightening, and conflating them would have
broken the library.** The obvious mistake here is to conclude that if `reset()`
needs four conditions then everything should check four. It must not: the 33
synchronous methods deliberately *permit* `LuaExecuting` and `BindingCall`,
because calling `execute_script` from inside a host callback — or converting a
value from within a type converter — is a supported, tested pattern that Lua
allows on one thread. Two policies, both correct, genuinely different. The value
of the model is not that it makes everything strict; it is that it turns an
implicit per-operation judgement into an explicit named one, so the next author
makes a *choice* instead of an omission.

The enforcement is a 3×3 occupancy matrix — every `kExclusive` operation × every
claim — with the instruction to add new operations to it. That is CR-15's "one
probe per direction" rule made mechanical: the suite had exhaustive coverage of
"call X while an async run is in flight" and none of "start an async run while X
is on the stack", and a matrix covers both axes by construction rather than by
someone remembering the second one exists.

**And the refactor introduced a data race, which is the most useful thing that
happened all day.** The first draft computed the whole claim set eagerly through
a `CurrentClaims()` accessor — the obvious shape, and the one that reads best.
`IsExecuting()` reads `lua_depth_`, a plain `mutable int` written by the async
worker's `ExecutionScope` **on the worker thread**, so routing all 33
`RejectIfBusy()` sites through it made every synchronous method read that int
while a worker ran. `test-ts-tsan` reported ten races on the first run.

The old code had been safe by an argument nobody had written down: `RejectIfBusy`
read only the atomic `is_busy_`, and the two operations that read `lua_depth_`
did so *only after* confirming `is_busy_` was false — at which point no worker
can own the state, because a worker can only be started from the main thread.
Unifying four hand-written guards into one function silently discarded that
ordering, because the ordering existed nowhere except in the sequence of `if`
statements it replaced.

> **A safety property enforced by statement order is invisible to a refactor
> that preserves behaviour.** Every observable output was identical — all 838
> tests passed, every pinned message byte-for-byte — and the property was gone.
> This is CR-11's lesson ("a comment describes intent; only a test or a lint
> suppression describes what the code is doing") one level deeper: here there
> was not even a comment, because when guards are written inline nobody thinks
> of their *sequence* as a claim worth stating.

Two things follow. First, the fix — evaluate claims lazily in the definition's
order, delete the eager accessor rather than repair it — now says at both the
declaration and the definition that the ordering is a thread-safety requirement,
so the next person to collapse the sequential `if`s into a computed bitmask finds
the reason before doing it. Second, and more uncomfortably: **a refactor whose
entire purpose was to retire a recurring hazard class introduced a fresh instance
of a different one.** Structural fixes are not safer than point fixes by nature;
they are larger, and they move code across a threading boundary that point fixes
leave alone.

The saving grace is which tool caught it. This document has reported `test-ts-tsan`
as a best-effort probe for four passes running — clean every time, and explicitly
discounted, because TSan cannot see libuv/V8/Lua synchronization and the
assessment above said in as many words that it "reports clean and cannot see" the
thread hazards. It caught this on the first run, with a stack trace naming both
sides. **A harness whose clean runs are weak evidence can still produce strong
evidence when it fails**, and the correct posture toward one is to keep running
it precisely because you cannot trust its silence.

What none of this fixes: the other three highs (lifetime across layers, and the
exception-escape class), and it does not make the search mechanical. Every
finding in this series still required a human to think of a site. The remaining
high-value step is a harness that injects a hostile callback — one that calls
`reset()`, starts an async run, releases a handle, replaces itself — at *every*
JS-crossing point and asserts survival, so the site list is generated rather than
remembered. That is the same "check against a generator" lesson this document
keeps re-learning, finally applied to the search instead of to a comment.

---

## CODE-REVIEW-16 (August 3, 2026) — the generator, finally built

CR-15 closed by naming the step it had not taken:

> *"The remaining high-value step is a harness that injects a hostile callback —
> one that calls `reset()`, starts an async run, releases a handle, replaces
> itself — at **every** JS-crossing point and asserts survival, so the site list
> is generated rather than remembered."*

CR-16 built it: **46 sites × 27 actions, 1242 combinations**, one child process
each so a crash is a data point rather than the end of the run. The site list
came out of `grep` over the call-into-JS surface, not out of anyone's memory of
which sites matter.

**It found one crash, and 1241 clean cells.** That ratio is the substantive
result of the pass, and it is the first honest evidence that this series is
converging. The counting exercise in the previous addendum found seven of ten
highs in one family and severity flat across three passes. The count is still
one high — but the *cost of finding it* changed completely: CR-9 through CR-15
each found their high by a human imagining a site, and CR-16 found its high by
exhausting the space and reading off the single cell that differed. A hazard
class you can exhaust is a hazard class that has stopped generating.

### The one that got through was not an omission

The five previous highs were guards consulting a subset of the facts. This one
was a guard that is complete, with a hole cut in it on purpose:

`cancel()` is exempt from the occupancy model because it *must* be — a `cancel()`
that refused while `is_busy_` is true would never work at all. During
`execute_async`'s result marshal, `is_busy_` is still true, so of 27 hostile
actions attempted from inside a from-Lua converter running on the result, 25 are
refused. The 26th is harmless. The 27th is `cancel()`, and what `cancel()` does
is settle the very `Promise::Deferred` the marshal is about to settle —
concluding a `napi_deferred` that N-API has already freed. Deterministic SIGSEGV
in `ConcludeDeferred`, 8/8.

> **Every exemption from a guard is an unguarded operation, and it is invisible
> precisely because it was a decision rather than an oversight.** An omission
> leaves a gap someone can notice by comparing the guard to its siblings. An
> exemption leaves a *documented, justified* gap that reads as evidence the
> question was considered — and the question that was considered was "may this
> operation run while busy?", never "what is running when it does?"

The rule that follows is cheap: for every deliberate exemption from a guard,
enumerate what holds the resource at the moments the exemption is reachable, and
ask what the exempt operation does to each. There is exactly one exemption in
this codebase and it took five minutes to check once someone asked.

### The analysis was already in the file, one function away

`OnAwaitSettled` — the *other* place that marshals a value with a run engaged —
carries a comment naming `cancel()` explicitly, naming the "or even starts a new
run" variant, and prescribing the exact re-check that was missing thirty lines
up in `DriveAsync`. And that re-check is *present* at `OnAwaitSettled`. The
window with the comment had the guard; the window without the comment had
neither, and it is the one that settles a promise.

> **A comment explaining a hazard is evidence the hazard was understood, and no
> evidence whatever that it was searched for.** CR-15's rule — *ask what else
> does the same thing to the same object* — failed here in its easiest possible
> case: not a subtle sibling in another layer, but the other exit of a two-exit
> relationship in the same function's neighbourhood.

The fix was not to add a fourth copy of the predicate. There were three copies,
all correct, and the fourth site had none; the natural steady state of a
hand-copied guard is *n−1 of n right*, with no way to tell from reading any one
of them which is missing. So the predicate became one function,
`AsyncRunSuperseded(gen)`, and the three copies were replaced by calls to it —
the same move the occupancy refactor made for the four claim flags, applied to
the four liveness checks nobody had noticed were also a family.

### A refactor reproduces the class it was built to kill

All four low findings this pass are inside the occupancy refactor, and each is a
miniature of exactly what that refactor exists to prevent:

- **F2** — the header paragraph that teaches the model told the reader to add a
  line to `CurrentClaims()`, a function *the same commit deleted*, and deleted
  because an eager claim set is a data race. The extension point instructs the
  next author to re-create the hazard the refactor removed. An enumeration that
  decayed within one commit — CR-14's lesson, with a negative lead time.
- **F3** — moving `Resetting` from last to second made a `reset()` from the
  replay phase report "from inside a `__gc` finalizer of the state being
  retired" when no finalizer is involved. Two distinct facts collapsed into one
  message, which is CR-13's finding, committed *by a comment citing CR-13* — the
  overlap that makes the reasoning wrong was created by CR-15's own fix one
  commit earlier.
- **F4** — the lazy-evaluation ordering that TSan caught the refactor breaking is
  explained at length in two comments and enforced nowhere; a policy omitting
  `AsyncInFlight` silently skips the first test and reads worker-mutated state.
  An invariant stated and unchecked — CR-15 F6a's finding, one screen away from
  CR-15 F6a's `static_assert`.
- **F5** — the public contract in `types.d.ts`, `ASYNC.md` and `FEATURES.md`
  still describes the pre-refactor messages.

CR-15 recorded the general form ("a refactor whose entire purpose was to retire a
recurring hazard class introduced a fresh instance of a different one"). CR-16
adds that the instances are not random:

> **A refactor reproduces the class it was written to kill, because the author is
> thinking about the abstraction and not about the prose and the constants
> around it.** The code was right in every case. Everything *describing* the code
> was one revision behind — and in a codebase where the guards are enforced by
> comments telling the next person what to do, the description is part of the
> mechanism.

The corollary for review: **the remediation of pass N is the highest-density
place to look for pass N+1's findings**, and the denser it is the more
structural the change was.

### The count nobody depends on

"33 synchronous methods" appears in four comments and three paragraphs of CR-15.
`grep -c 'if (RejectIfBusy())' src/lua-native.cpp` returns **31**. Nothing
breaks; that is the point. It is the fourth enumeration in four passes written
from memory with a one-line command that produces it sitting in the same
repository. The fix was to replace the number with the grep, not with a
corrected number — the only version that stays true.

### The harness, and why the suite could not have caught this

All four sanitizer harnesses and 838 tests passed on the tree containing F1 —
the fifth consecutive pass where that sentence is true. This time neither could
have helped for a structural reason worth recording: ASan cannot see it because
the freed object belongs to **libnode**, not to the addon's allocator; TSan
cannot see it because there is no second thread. It is a use-after-free that a
memory sanitizer misses because of *whose* memory it is.

And the suite could not have caught it either, for a reason that generalises:

> **A test suite catches the failures a test can survive.** Two of CR-16's five
> pins do not fail against the pre-fix binary — they take the vitest worker
> process down, and any suite containing them beforehand would have reported an
> infrastructure error rather than a test failure. That is a thing people mute.
> The matrix works because each cell is its own process; **the search space has
> to be partitioned so that finding a crash is a data point instead of the end of
> the run.** That, rather than the length of the site list, is the part of this
> harness worth keeping.

What remains: the harness is not in CI, deliberately — it takes ~15 minutes and
1242 processes, and its value this pass was in being written *from the grep*.
Its five findings are pinned in the suite; its sixth output is the knowledge that
the rest of the space is clean, which belongs in a document rather than a job.
The open question for CR-17 is whether the same partition-and-exhaust treatment
can be applied to the *lifetime* class — the remaining highs that are not about
occupancy at all — where the axis is not "what does user JS do" but "in what
order do these objects die".
