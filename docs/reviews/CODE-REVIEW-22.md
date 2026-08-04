# CODE-REVIEW-22

**Date:** August 4, 2026
**Scope:** Twenty-second pass. Two targets:

1. **The last boundary on the enumeration** — the userdata/class lifecycle
   across `reset` and GC (`CODE-REVIEW-HISTORY` A3's remaining row), searched
   by a new instrument, `tools/lifecycle-matrix/` (`npm run lifecycle-matrix`).
2. **The enumeration itself.** The three-boundary list came from CR-20's closing
   paragraph and was written by hand. This codebase's recurring failure is a
   class boundary drawn one member short, so the list of boundaries is exactly
   the kind of thing that deserves the question asked of it before it is
   declared complete.

**Baseline:** 936 TypeScript and 285 C++ tests pass; nine invariants clean;
`test-ts-asan` clean; exception matrix 297/297; oracle 0 disagreements;
round-trip 456 identical / 0 undocumented / parity 50 of 50; exec-parity
4015 agree / 0 disagreements.

**Findings were reported open and fixed subsequently.** The resolution table is
below. **F1 was substantially wrong as written and is corrected there** — the
finding is real but much narrower than the text below claims, and the half that
was wrong is the more interesting half. The findings themselves are left
unedited, because the record of what the instrument reported is the point.

---

## Resolution status (August 4, 2026)

**All findings resolved.** After the fixes: **942 TypeScript tests** (up from
936 — 6 CR-22 pins), 285 C++ tests, nine invariants, `test-ts-asan` clean, and
**all seven harnesses clean** — including the new `cross-context` matrix that F2
asked for, and the lifecycle matrix now at 70 cells / 0 findings.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Fixed, **and half of it was wrong** | Real for *Lua-created* handles: a Lua file object's own properties are `["_userdata"]` — the marker and nothing else — so the deep copy produced a genuinely empty table (`type=table`, `key count = 0`). That now throws `"userdata handle belongs to a different Lua context"`. **Wrong for JS-created userdata**, which is not a handle at all — see below. |
| F1+ | ✅ Fixed (found while fixing) | The same class at a fifth marker: a **coroutine** object (`["_coroutine","status"]`) deep-copied cross-context into `{ status = "suspended" }` — a thing that looks like a coroutine and can do nothing. `resume` already refused a foreign thread; the *value* path did not. Found by the F2 instrument, which is what it was built for. |
| F2 | ✅ Fixed | `tools/cross-context/` (`npm run cross-context`) — three properties: handles are refused, data crosses intact, contexts stay independent. Clean. |
| F3a | ✅ Fixed | The stale "same policy as the `_tableRef` / `_userdata` markers above" comment is gone; the site now states the actual rule and why the class marker is its exception. |
| F3b | ✅ No change needed | Re-checked after F1: `release` on a stale handle stays a silent no-op, and with the marker policy unchanged for the kinds it applies to there is nothing to restate. |

### F1's correction: `set_userdata` does not return a handle

The finding claimed an encapsulation break — "an opaque userdata becomes a
readable table one context away, exposing `secret`". Driven again while fixing
it, that is **not what happens**, and the reasoning was wrong in a way worth
recording:

```
a.set_userdata('ud', original);
const back = a.execute_script('return ud');
back === original                      // true  — the identical JS object
Object.getOwnPropertyNames(back)       // ["n"] — no marker at all
```

`set_userdata` hands back **the caller's own object**. It carries no marker, so
it never reaches the round-trip branch, and passing it to another context is
passing a plain JS object the caller already holds. Copying its fields is
exactly what passing any object does. The "leak" was the object's owner reading
their own data.

The opacity contract is about **what Lua can index in the owning state**, and
that still holds — `ud.n` is refused there, before and after the fix. What
changes across a context is only that the object is not *registered* as userdata
in the second one, so `type()` says `table`. That is a registration not
following the object, not a handle failing.

So the rule the code now states, and the one the instrument encodes:

| | own properties | cross-context |
|---|---|---|
| table handle, Lua userdata, coroutine | the marker, no data | **refused** (a copy would carry nothing) |
| `set_userdata` object | the caller's data, no marker | crosses freely (it is theirs) |
| class instance | markers **and** data | deep-copies, data intact (M6, pinned) |

**The three markers are not one class, and forcing them to be one would have
been wrong.** The first draft of the fix refused all of them — including class
instances — which would have reversed the review ledger's M6, a deliberate,
documented, pinned resolution. It was caught by reading M6 before believing the
finding.

### What the correction cost, and what it says

CR-22's own closing note said this instrument's first three drafts produced
seven false findings, all of them the harness misreading its probe, and proposed
the rule *a search that reports dirty must show the dirt is in the subject*.
**F1 was an eighth**, and it got past that rule because the reproduction was
real — the values printed were exactly as reported. What was wrong was the
*interpretation*: `type()` changing from `userdata` to `table` was read as a
handle failing, when there was no handle. The reproduction proved a behaviour;
it did not prove the behaviour was a defect.

So the rule needs its second half, now in `tools/README.md`: reproduce the
behaviour, **then establish that the thing you think is a handle is one** —
check what the object actually carries before concluding that something was
lost.

---

## Headline

**The last boundary is not clean, and the enumeration was not complete.**

Both halves produced a finding, and they are the same finding seen from two
distances:

> *(Superseded — see the Resolution section: F1 is real only for handles that
> carry a marker and no data. `set_userdata` objects are not handles and the
> "opaque userdata" claim below is wrong.)*
>
> **F1 (serious).** Three of the four round-trip markers silently deep-copy a
> handle that belongs to another Lua state instead of refusing it. A userdata
> becomes a plain table, a method-bearing userdata loses its methods, and an
> **opaque** userdata — one Lua cannot index in its own context — becomes a
> fully readable table in the other. `_tableRef` refuses; `_userdata` and
> `__luaClassRef` do not. CR-17 F2 fixed exactly this for the one marker it was
> looking at, and the comment in the source still claims the other three match
> its policy.

> **F2 (medium, meta).** The boundary enumeration was an enumeration, not a
> closure. **Cross-context** — two `LuaContext`s in one process — is a boundary
> in its own right, it has never had an instrument, and it is where both F1 and
> CR-20 F5 live. It was invisible because every list so far was organised by
> *API surface* rather than by *what can differ on each side of a crossing*.

The matrix result itself, before the findings: **64 cells, 49 clean, 3
ledgered, 0 vacuous, 0 crashes, 0 registry leaks, 12 findings — all 12 one root
cause.** Nothing aborted, nothing aliased the replacement state, and no handle
stranded a registry slot. The `reset` machinery, which five separate passes
produced highs in, held on every cell.

---

## The instrument

```
npm run lifecycle-matrix
node tools/lifecycle-matrix/run.mjs --control
node tools/lifecycle-matrix/run.mjs --handle=coroutine --event=reset
```

**Axis A — 10 handle kinds**, derived from the source rather than remembered
(`grep -n 'struct Lua.*Data' src/lua-native.h` plus the two JS-side marker
objects): table handle from `get_global_ref`, table from `create_table`, a
metatabled table's Proxy, a Lua function, a coroutine, opaque / proxy / method
userdata, a registered class instance, and the coroutine `Symbol.iterator`
binding.

The axis is worth enumerating because **the kinds do not share a safety
mechanism.** Table and function handles carry a `ContextLiveness` pair and fail
closed when `alive_` flips. Coroutines and userdata carry no liveness at all —
they hold a `shared_ptr` to the runtime that minted them and are policed at
*use* by an identity comparison. Both designs are defensible; what matters is
that every kind ends up refusing, and a kind that used neither mechanism would
look exactly like the ones that do until the day it aliased.

**Axis B — 8 lifecycle events:** none (the baseline control), `reset`,
`reset-twice`, `reset-then-realias`, `gc-handle`, `gc-churn`, `release-then-use`,
`double-release`.

**The property.** A handle held across an event must end in exactly one of two
states: still valid and answering with its own state's data, or refusing with a
message that names a reason. **The forbidden middle is a handle that answers
with the wrong state's data** — not a crash and not an error, but the binding
lying, which is the failure mode this codebase moved to around CR-17 and which
no sanitizer sees. `reset-then-realias` exists to make that visible: it
re-creates the global under the same name with a *different* value, so a stale
read that succeeds can be attributed to the retired state or the replacement.

**One process per cell**, as in CR-16/17/18: the failure searched for is a
use-after-free on a closed `lua_State`, and an abort inside a shared runner ends
the run instead of producing a data point.

**Eight controls**, all passing, including three this instrument specifically
needed: a simulated stale read must be both detected *and* classified as a
finding (using the same `classify()` the real run uses, not a copy); the
re-alias probe must actually change the value it probes for, or "not aliased" is
unfalsifiable; and the registry probe must report a **genuine** leak when handles
are deliberately retained.

### Three instrument defects it caught in itself first

Reported because the corrections are the substance of what makes the clean cells
believable, and because two of them would have been *false findings* published
as real ones.

1. **Six false leaks.** The first registry probe compared one churn round
   against the start and reported "the registry grew 14 → 40" for six handle
   kinds. `luaL_unref` does not delete the registry key — it puts the slot on a
   free list — so a key count is a **high-water mark that never falls**, and
   growth within one round means nothing. Driven to the truth: across six rounds
   of 25 abandoned handles (150 total) the count plateaus at 38 and a fresh
   handle reuses a slot. **There is no leak in any kind.**
2. **One more false leak.** The second draft sampled after a single warm-up
   round, which is not enough for the mark to settle, and reported
   `coroutine-iterator` growing by exactly one round's worth. The measurement is
   now **slope-based** — sample after every round, compare the last two — which
   is immune to settling and still clears a real leak by 25 per round.
3. **Ten vacuous cells.** `register_class` takes `construct`, not
   `constructor`; the first draft used the latter, and every class-instance cell
   came back `VACUOUS` rather than passing. That is the per-cell vacuity check
   doing exactly its job (CR-19 F2: an instrument that swallows its own input
   reports a clean sheet), and it is why the check is per-cell rather than
   per-run.

**The lesson is uncomfortable and worth stating plainly: this instrument's first
three drafts produced seven findings, and all seven were wrong.** Every one was
the harness misreading its own probe. The programme's rule has been "a search
that reports clean must first prove it can report dirty"; these drafts prove the
converse rule is also needed — **a search that reports dirty must prove the
dirt is in the subject.** Both of the false-leak drafts had passing positive
controls at the time.

---

## Findings

### F1. A handle from another Lua state is silently deep-copied instead of refused (serious)

12 of 64 cells, and — the part that makes it serious — **reachable with no
`reset` at all.**

**Driven, two ordinary contexts:**

```js
const a = new lua_native.init({}, { libraries: 'all' });
const b = new lua_native.init({}, { libraries: 'all' });

a.set_userdata('ud', { secret: 'hunter2' });
const ud = a.execute_script('return ud');
b.set_global('x', ud);
```

```
in context A (opaque = not introspectable, as documented):
  a: type(ud)  = userdata
  a: ud.secret -> ERROR: attempt to index a lua_native_userdata value

after crossing into context B:
  b: type(x)   = table
  b: x.secret  = hunter2          <-- the opaque contract is gone
```

The same for the other two markers, and the contrast with the fourth:

```
cross-ctx opaque userdata  -> table, secret readable
cross-ctx methods userdata -> table, get = nil        (methods gone)
cross-ctx class instance   -> table, keys = x         (methods gone)
cross-ctx TABLE handle     -> REFUSED: "table handle belongs to a different Lua context"
```

**Three distinct harms, in increasing order of seriousness.**

1. **A wrong type, silently.** `type()` changes from `userdata` to `table`.
   Nothing raises.
2. **Behaviour is lost, silently.** A method-bearing userdata and a class
   instance arrive as data-only tables. `y:get()` becomes
   *attempt to call a nil value*, arbitrarily far from the crossing that caused
   it — the CR-17 class exactly.
3. **An encapsulation guarantee is defeated.** `set_userdata` without options is
   documented as *opaque*, and in its own context Lua genuinely cannot index it.
   One hop through another context converts it into a plain table whose fields
   Lua reads freely. This is the one that is more than a type error: the
   binding's own opacity contract does not survive a boundary it does not check.

**Why it is exactly CR-17 F2, one marker over.** That finding established the
principle for `_tableRef` — *a foreign handle is not a plain object; deep-copying
it produces a plausible value that is not the thing the caller asked for, so
refuse and say why.* The fix was applied to `_tableRef` alone. `_userdata`
(`lua-native.cpp:4196`) and `__luaClassRef` (`:4216`) still fall through, and the
comment above the second one says so in the present tense:

> "Foreign or invalid markers fall through to a plain deep copy **(same policy
> as the `_tableRef` / `_userdata` markers above)**."

`_tableRef` has not had that policy since CR-17. The comment describes a
consistency that no longer exists, which is the comment-drift class sitting on
the exact site the inconsistency lives at — the same shape as CR-21 A5.

**Recommendation (not implemented).** Refuse all three, with the message
`_tableRef` already uses, naming the marker kind. The deep-copy fall-through
should not be reachable for any branded marker: a branded object that fails the
identity check is *known* to be a handle from elsewhere, which is precisely when
guessing is wrong. Note this changes behaviour some caller may depend on, so it
wants a pin per marker and a line in `types.d.ts`.

### F2. The boundary enumeration was an enumeration, not a closure (medium)

CR-20 closed by naming three unsearched boundaries; CR-21 searched two and
reduced the list to one; this pass searched the last one. On that accounting the
enumeration is now empty and `CODE-REVIEW-HISTORY` §10 criterion 1 is met.

**It is not, and the reason is structural.** Every list in the series has been
organised by **API surface** — "the async methods", "the bytecode methods",
"the handle methods" — because that is what is easy to enumerate. A boundary is
not an API; it is **a place where two systems with different rules exchange a
value, such that a mismatch yields a plausible answer rather than an error.**
Re-derived on that criterion, one boundary has never appeared on any list:

| Boundary | Instrument | Status |
|---|---|---|
| JS value → Lua | `roundtrip-matrix` | ✅ CR-20 |
| Lua value → JS | `diff-oracle` mode B | ✅ CR-18 |
| Lua semantics vs reference | `diff-oracle` mode A | ✅ CR-18 |
| Exception escape through C frames | `exception-matrix` | ✅ CR-18 |
| Execution doors (async, bytecode) | `exec-parity` | ✅ CR-21 |
| Handle lifetime across `reset` / GC | `lifecycle-matrix` | ✅ CR-22 |
| **Context ↔ context** | **—** | **never searched** |

**The evidence that this is a real boundary and not a taxonomy quibble is that
it has now produced two findings, and it produced the last two serious ones in
the series:**

- **CR-20 F5** — a `LuaContext` accepted as a `SharedTable` and reinterpreted
  (SIGABRT). A cross-context confusion.
- **CR-22 F1** — a handle from context A silently deep-copied into context B.

Neither was found by an instrument. F5 arrived through a test-hygiene collision;
F1 turned up here only because `reset` happens to make a context's *own* handle
foreign to it, so a matrix aimed at `reset` clipped the edge of a boundary it
was not aimed at. **A search aimed at cross-context directly would have found
both.**

What such a search would cover, none of which any existing instrument does: a
handle of each kind pushed into a second context (F1's cell); a shared table
subscribed by N contexts and mutated from each; a value that round-trips A → JS
→ B → JS → A; a callback registered on A invoked while B is executing; a
coroutine from A resumed by B; `reset` on A while B holds a shared table
subscription.

**Recommendation (not implemented).** Build it as CR-23, and note that it is
cheap: the axes already exist. Handle kinds come from `lifecycle-matrix`'s
Axis A; values come from `roundtrip-matrix`'s 50. Then — and only then — record
the enumeration as complete, having derived it from the "two systems, different
rules" criterion rather than from the API listing.

### F3. Nits

**a. The stale policy comment.** `lua-native.cpp:4206` claims the `_userdata`
and `_tableRef` markers share the fall-through policy. They have not since
CR-17 F2. Fix with F1 or independently.

**b. `release()` on a stale handle is a silent no-op.** Not filed as a finding
because no assertion is violated — `release-then-use` and `double-release` are
clean at every kind that has a `release`, and a double release does not
double-unref. Recorded only because the *first* release after a `reset` also
does nothing, and does not say so; the slot it would have freed belongs to a
state that is already gone. Harmless today, and worth a sentence if the marker
policy in F1 changes.

---

## Verified and rejected (suspicions that held up)

- **`reset` itself.** The machinery that produced highs in CR-9, CR-10, CR-13,
  CR-14 and CR-15 was hit from 10 handle kinds across single reset, double
  reset, and reset-then-realias. **No crash, no alias, no stranded slot.** Every
  liveness-carrying kind failed closed with a message naming the reason.
- **Aliasing the replacement state.** The finding this matrix was built to look
  for. `reset-then-realias` re-created each global with a different value and
  **no cell read it** — including the 12 F1 cells, which deep-copy the *JS-side*
  object rather than reaching into either Lua state. F1 is a wrong value, not
  memory corruption.
- **Registry slots.** No kind leaks. Measured across rounds after two false
  starts (above); slots are recycled through `luaL_unref`'s free list, and a
  deliberately-retained set is still detected as a leak, so the probe is live.
- **GC of a handle's peers.** `gc-churn` mints and abandons 25 peers per round
  for 5 rounds; the handle under test survives every time. No over-eager
  finalization.
- **Double release.** Clean at every kind. No double-`luaL_unref`, which would
  free a slot a later handle owns and produce aliasing arbitrarily far away.
- **The coroutine and userdata kinds' lack of a liveness flag.** Suspected as
  the gap; refuted for coroutines, which the identity check refuses cleanly
  (ledgered, with the wording noted as accurate). It *is* the gap for userdata,
  but the defect is the fall-through in the conversion path, not the missing
  flag.

---

## Suggested priority order

1. **F1** — the marker fall-through. The only serious finding, reachable from
   ordinary two-context code, and it defeats a documented opacity guarantee.
   Fix all three markers together; fixing one is what produced this.
2. **F3a** — the stale comment, with F1.
3. **F2** — build the cross-context matrix as CR-23, *then* declare the
   enumeration complete. The declaration is the deliverable, not the clean run.
4. **F3b** — the silent stale `release`, only if F1's policy changes.

---

## Note on the trajectory

The finding curve: CR-18 **3/0**, CR-19 **5/0**, CR-20 **4+1/1**, CR-21 **3/0**,
CR-22 **3/1 serious**.

**The honest reading is that the run of "nothing serious" ended, and it ended
where the assessment three days ago said the risk was.** That assessment argued
the remaining exposure was a coverage claim rather than a code claim, and that
the last boundary was the one most likely to still hold something because
lifetime and aliasing produced CR-17's high. That was right in direction and
wrong in detail: the boundary did hold something, but the something was not a
lifetime bug. `reset` and GC came back completely clean. What the instrument
actually found was a **conversion-policy** defect that was never about
lifetimes, and that is reachable without touching `reset` at all.

Three observations worth carrying forward.

**The per-instrument yield held exactly, for the sixth consecutive time.** A
genuinely new instrument found one root cause; the five existing ones, re-run,
found nothing new. Six data points now say the same thing, and it is the single
most reliable regularity in the series.

**The recurring class recurred at the meta level, which is new.** Every pass
since CR-19 has found a class boundary drawn one member short — in the product,
in a fix, in an instrument. This pass found it in **the list of things to
search**. F1 is CR-17 F2 applied to one of four markers; F2 is the boundary
enumeration missing one of seven boundaries. The same error, one level up, and
it is the more expensive of the two: a short class boundary leaves a defect, a
short *enumeration* leaves a whole region unsearched and then certifies it as
complete. `CODE-REVIEW-HISTORY` §10 criterion 1 asks for "the enumeration of
crossings, and each has an instrument" — this pass is why that criterion needs
to name the *criterion for being a crossing*, not just the list.

**The instrument's own error rate is now the thing to watch.** Three drafts,
seven false findings, all of them the harness misreading its probe, all with
passing controls. The suite and the other instruments caught none of them —
what caught them was driving each reported finding to a hand-run reproduction
before believing it. That step is not currently a stated rule anywhere in
`tools/README.md`, and on this evidence it should be: **a search that reports
dirty must show the dirt is in the subject, not in the search.**

**On winding down.** The position is unchanged in structure and slightly worse
in arithmetic: one boundary remains, but it is a different one than last week,
and it is the boundary that has produced the last two serious findings. After
CR-23 the enumeration can be declared complete against a stated criterion rather
than against a list, and at that point a pass that finds a documentation nit is
the expected result. That is one instrument away, and the axes for it already
exist.
