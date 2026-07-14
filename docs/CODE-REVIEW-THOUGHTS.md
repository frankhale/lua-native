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
