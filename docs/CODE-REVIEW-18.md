# CODE-REVIEW-18

**Date:** August 3, 2026
**Scope:** Eighteenth pass, against commit `8b9bfbd` — the CR-17 remediation —
executing the programme `docs/CODE-REVIEW-HISTORY.md` set out, minus §3
(cross-platform verification and CI), which is deferred by decision: this stays
a macOS/arm64 project for now, so CR-18 leads as that document says it should.

**Method:** the instrument this pass is an **exception-escape matrix** —
27 Lua C frames × 11 throw kinds, 297 cells, each in its own process. A *frame*
is a Lua C frame that calls into user JavaScript; a *kind* is a way for control
to leave that JavaScript abnormally. The axes were derived from the
call-into-JS surface and the public callback API rather than from a
recollection of which sites matter, per CR-14's standing rule.

Two supporting deliverables landed with it, both from the same document:

- **§4, the comment-enforced invariants**, converted to generated answers a test
  compares against (`tools/invariants/invariants.mjs`, `tests/ts/invariants.spec.ts`).
- **§5, a differential oracle** against stock Lua 5.5
  (`tools/diff-oracle/`) — the first harness in eighteen passes that checks
  whether an answer is *right* rather than whether nothing crashed.

**Baseline:** 850 TypeScript and 285 C++ tests pass at `8b9bfbd`, and all four
sanitizer harnesses are clean on it. Every finding below is reproducible against
that baseline and none of the four harnesses can see any of them —
`CLAUDE.md` states the exception class is invisible to the sanitizers, and this
pass is the first mechanical search of it.

---

## Headline

**Nothing aborted.** 297 cells, 27 frames, 11 kinds, and not one
`std::terminate`, not one signal, not one context left unusable. The class that
produced CR-2 H8, CR-6 F1 and CR-8 F1/F4 — a `std::runtime_error` unwinding
across N-API into the process — is, on this evidence, closed. That is the
result the matrix was built to get and it is worth stating before the findings,
because the findings are all of a different and milder kind.

**What it found instead is the code lying about why.** All three findings are
about what the caller is *told* when a contained failure happens:

- **F1 (medium).** Four protected barriers each invented a cause when
  `lua_tostring` returned null on the error value — and null is exactly what a
  *table* returns, which is what this binding stages a thrown JavaScript error
  into. So a JS `__index` callback that threw `new Error('...')` was reported to
  the caller as **`protected operation failed (out of memory?)`**. Eight entry
  points, including every `LuaTableHandle` method. The same callback reached
  through `execute_script` reported its real message correctly the whole time,
  because that path goes through `CaptureError` and these did not.
- **F2 (low).** `Napi::Error::Message()` — and so `what()` — is empty for any
  throw that is not an Error object, and the 45 binding catch sites rebuild the
  error from `what()`. A type converter that threw a string produced an `Error`
  with **no message at all**; the userdata property bridge produced
  `Error reading property 'p': ` with nothing after the colon. The
  host-function bridge had the correct fallback since it was written.
- **F3 (low).** A throwing print handler or debug hook is silently discarded and
  the script runs to completion as though the call succeeded. That is the right
  design — a C++ exception unwinding through Lua's C frame would corrupt the VM
  — and it was documented only in a C++ comment the caller cannot read. Its
  containment also caught `Napi::Error` alone, so any other C++ exception would
  have gone straight through the frame the comment claims to protect.

**And one finding about a fix.** The first version of F2's fix rethrew
`std::runtime_error`, which the sites that catch `Napi::Error` *specifically* —
the print-handler and debug-hook bridges among them — then missed, and the
escape took the process down. It was caught by the existing suite before it
shipped. This is CR-16's standing observation ("every structural fix has
introduced a fresh defect") recurring for the sixth pass running, and this time
the fresh defect was an instance of the very class the pass was closing.

---

## Resolution status (August 3, 2026)

**All findings resolved.** After the fixes: **898 TypeScript tests** (up from
850 — 22 new CR-18 pins, 10 new differential-oracle pins and 16 new invariant
tests) and **285 C++ tests** pass; all four sanitizer harnesses are clean
(`test-ts-asan` 898/898, `test-cpp-asan` 285/285, `test-cpp-tsan` 285/285,
`test-ts-tsan` 898/898); the full 297-cell matrix re-runs with 0 cells to read;
and the 2678-case differential oracle runs with 0 disagreements.

**Nine of the 22 new pins fail against the pre-fix binary** — verified by
stashing the source fixes, rebuilding, and re-running. The other thirteen are
controls and behaviour-documenting pins that must pass on both sides; they are
there so the *next* change to these paths is deliberate.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | A single `LuaRuntime::ProtectedFailureMessage()` (`lua-runtime.cpp`) replaces the four hand-written fallbacks. It keeps the cheap `lua_tostring` read for a string or number error value — which is what a genuine `LUA_ERRMEM` leaves, and stringifying under a state that has just failed to allocate is not something to attempt — and falls back to a new `ErrorValueToString()` for everything else. `ErrorValueToString` is `CaptureError`'s display-string half, split out **without** the side effect of recording the structured value: the barriers surface their failure as a plain `Napi::Error` rather than through `LuaErrorToJsValue`, so a recorded value would be left unconsumed for some later `ThrowLuaError` to pick up and attribute to the wrong failure. Eight entry points verified to report the real cause, and the string path verified unchanged. |
| F2 | ✅ Done | A single `LuaContext::JsThrowMessage(const Napi::Error&)` implements the rule `StageJsError` always had — empty `Message()` falls back to the thrown value's string form, with the `ToString()` itself contained because it runs user code on an error path. Applied at the **four producers** that call user JS without going through `StageJsError` (both property-bridge lambdas, the JS→Lua converter loop, the Lua→JS converter loop), and at `StageJsError`'s own two call sites so the rule has one home. Fixing the producers rather than the 45 consumers is deliberate: the consumers are correct given a correct `what()`, and a 45-site sweep is precisely the shape of change that has introduced a defect every time it has been made here. The rethrow **preserves the exception type** — see the headline. |
| F3 | ✅ Done | Both bridges widened from `catch (const Napi::Error&)` to `catch (...)`, closing the gap in kind (empirically all eleven throw kinds arrived as `Napi::Error`, so this is not a behaviour change so much as the containment now matching its own comment). The trade-off is now stated on `set_print_handler()` and `set_hook()` in `types.d.ts` — an `@remarks` block saying plainly that the exception is swallowed, that the script continues as though the call succeeded, and what to do instead. The behaviour was right and undiscoverable, and undiscoverable was the actual defect. |

---

## The exception-escape matrix

The instrument, described so it can be re-run and extended. It lives in
`tools/exception-matrix/` and **is** checked in, unlike CR-16's and CR-17's — the axes are
cheap to extend, the whole run is about four minutes, and the reason CR-16 gave
for not checking its own matrix in (fifteen minutes, one process per cell) does
not apply at this size.

```
node tools/exception-matrix/run.mjs                        # the whole matrix
node tools/exception-matrix/run.mjs --control              # just the controls
node tools/exception-matrix/run.mjs --frame=host_function  # one row
```

**Axis B — 27 frames**, grouped by what is on the C stack:

- *Lua executing* (22): host function; the `__index`, `__newindex`, `__add`,
  `__tostring`, `__lt`, `__call` and `__concat` metamethods; `__gc` at an
  ordinary collection and again from `lua_close` inside `reset()`; `__close` on
  a to-be-closed variable; the debug hook; the print/`io.write` handler; a JS
  `require` searcher; a host function inside a coroutine body and again through
  the `for…of` protocol; a JS function used as Lua's `load()` reader; a class
  method, constructor and metamethod; a userdata method; a proxy-userdata
  property read.
- *Binding call* (5): both converter families, the from-Lua converter again in
  the async worker's marshal, a JS `__index` reached through a table handle, and
  the function handed to `pcall()`.

**Axis A — 11 kinds:** `throw new Error`; `throw` a bare string; `throw null`;
throw an Error whose `.message` *and* `.name` getters both throw; return a
Symbol; return a BigInt too large for a Lua integer; return an object nested
past `kMaxDepth`; call back in so a raising `_G.__newindex` fires; exhaust
`maxMemory` from inside the callback (the `ERRMEM` longjmp); `reset()` the
context and then throw; re-enter Lua and throw from the inner frame.

**The assertion per cell** is CR-6's shape, plus CR-17's:

1. no abort — checked by the parent, since the child dying *is* the signal;
2. the failure surfaces as a catchable error, checked against a per-kind
   signature rather than by "something threw";
3. the context is usable afterwards;
4. repeating the whole install-and-trigger strands nothing.

### The two things carried in from CR-17, and what they cost

**Prove the harness can report dirty before believing a clean cell.** The
runner runs four controls before every matrix run and refuses to proceed if any
fails: a deliberate `SIGABRT` must be reported as `ABORTED`, a contained error
that never mentions the marker as `SWALLOWED`, an unusable context as
`CONTEXT_DEAD`, an ordinary contained throw as `CLEAN`.

This was not ceremony. **The same discipline, applied to the §4 invariant
scanner, caught that scanner passing a source with a `try`/`catch` deliberately
deleted** — the substring `try` inside the identifier `entry` opened a guard
region that never closed, so every call after it in the file scored as guarded.
A whole check, reporting clean, measuring nothing. It is the third pass running
in which a search that would have been written up as a negative result turned
out to be vacuous, and the first in which the positive control caught it before
rather than after.

**Record the value, not just survival.** The first run reported **180 swallowed
cells**, which looked like a very large finding and was mostly instrumentation:

- Five kinds were scored swallowed at *every* frame because their correct
  failure does not carry the caller's marker — a returned Symbol surfaces as the
  addon's own "Cannot convert a JavaScript Symbol to a Lua value", which is the
  right message and contains nothing of the caller's. Each kind now declares the
  signature a correct surfacing has.
- Evidence can be nested. Lua's `load()` returns `nil, err`, so the error
  arrives inside a returned array with the marker down in `.stack`.
- **Two whole frames were vacuous.** `from_lua_converter` was triggered with
  `return 42`, and from-Lua converters are consulted only for object-valued
  results — so the callback never ran, and eleven cells reported an exception
  that was never raised as swallowed. Each cell now counts callback invocations
  and reports `VACUOUS` rather than `SWALLOWED` when the count is zero.

The count went 180 → 58 → 52 as those were fixed, and the 52 that remained were
all real behaviour. Which leads to the part worth keeping:

> **A harness that over-reports is not the safe direction.** The instinct is
> that a false positive is cheaper than a false negative, so a noisy harness is
> the conservative choice. It is not, at this scale: 180 rows is more than
> anyone reads, and the failure mode of an unreadable report is that its real
> rows are skimmed past with the rest. The three genuine findings in this pass
> were in that first 180 the whole time, and they only became visible once the
> other 128 were taken out.

### Result

| Outcome | Cells | |
|---|---|---|
| Clean — the failure surfaced and the context survived | 225 | |
| By design — recorded, with the reason, in `tools/exception-matrix/expected.mjs` | 52 | |
| Not applicable — the kind cannot be armed at that frame | 20 | |
| **Aborted, context-dead, vacuous or swallowed** | **0** | |

The 52 by-design cells are the honest half of the result and are worth naming
rather than folding into a total:

- **`__gc` at an ordinary collection, and from `lua_close` (20 cells).** Lua's
  own contract: a finalizer error is a warning and never propagates. The
  `lua_close` variant is the frame with the least margin in the whole matrix —
  the state is being destroyed, there is no Lua error handler above it, and the
  C++ unwind would be running inside a destructor path. All ten kinds contained.
- **Debug hook and print handler (22 cells).** F3's deliberate swallow.
- **Ten individually-justified cells**, mostly the from-Lua converter's
  documented "the return value is used verbatim" rule making an unconvertible
  value not unconvertible.

Each carries its reason in the ledger, and a ledger entry whose cell *starts*
agreeing is reported as `STALE_EXPECTATION` rather than silently ignored — a
suppression list that can only ever hide things hides regressions in the other
direction too.

### A negative result on strandedness

The matrix's fourth assertion — that a contained failure orphans nothing — came
back clean, and the measurement is worth recording because the raw numbers look
alarming until they are controlled. The two coroutine frames grew ~2.5 KB per
repeat, more than double the non-throwing rate. Driven separately:

```
handle released, callback succeeds      0 B/iter
handle released, callback THROWS        0 B/iter
handle NOT released, succeeds        1010 B/iter
handle NOT released, THROWS          2221 B/iter
```

Exactly flat on release, on the error path as well as the success path — no
orphaned registry slot, no stranded `js_error_registry_` entry. The growth is
un-released coroutine handles, which is documented behaviour, and the *extra*
growth on the throwing path is the staged error value and traceback that the
un-released handle keeps alive. Pinned.

---

## §4 — the comment-enforced invariants, mechanized

`CODE-REVIEW-HISTORY.md` called this "the only intervention in seventeen
passes that has demonstrably stopped a class from recurring". It is done, and
the three named candidates were all found to have drifted again in the interval:

| Invariant | State on arrival |
|---|---|
| The `CallScope` enumeration | Two hand-maintained lists, repaired in CR-13, CR-14 and CR-15 |
| The `lua_next` traversal list | Named four members, **two of which no longer contain a `lua_next` at all** (they traverse through the collectors), and **missed `RegisterClass`'s metamethod-inheritance copy**, which does `lua_getfield` / `lua_setfield` / `lua_tostring` inside a live cursor |
| The `RejectIfBusy()` count | CR-16 F2 replaced the number with the grep **at one of three sites**; the other two still said 33, and the answer is now 31 |

The third row is the whole argument in miniature: CR-16 found a stale count
stated in four places, corrected it in the place a reader was most likely to
look, and left two siblings saying the old number — the same fix-the-site-not-
the-class shape as CR-6 F1, applied to a comment.

So the answers are now **generated from the source and frozen**
(`tools/invariants/expected.json`). Six invariants:

1. `callscope-classification` — 71 functions, each scored SCOPE_FIRST /
   SCOPE_LATE / NO_SCOPE / SCOPE_NO_USER_JS by computing the predicate the
   header already states.
2. `lua-next-sites` — 5 sites, each with the list of allocating or
   metamethod-firing calls inside its cursor.
3. `occupancy-policy-sites` — which named operation declares which policy. Both
   matrices needed this set and each carried its own copy that agreed with the
   source by luck.
4. `greppable-counts` — the numbers that were previously prose.
5. `exception-surface` — the throw/catch/barrier counts CR-18's axes came from.
6. `core-call-guarding` — **the CR-6 F1 class, mechanized at last.** Every
   binding call to a `RunProtected`-backed core method, scored guarded or not.
   36 rows, 0 unguarded. CR-6 F1's recommendation closed with "treat the class
   mechanically… any new one added later is a review checklist item"; it has
   been a checklist item and is now a test.

The classification is *frozen*, not *asserted correct*: a function in NO_SCOPE
is not thereby a defect — the header documents why each current one is inert —
but a function that changes class, or a new one that arrives in either class,
turns the suite red instead of quietly joining a list. Re-freezing is
`node tools/invariants/run.mjs --update`, which makes the change a reviewable
diff rather than an invisible one.

It earned its keep within the hour: it caught the F2 fix changing the
throw/catch counts, which is exactly the prompt to check that a new `throw` is
contained.

The `lua_next` header comment has been replaced with the reachability analysis
rather than a corrected list. `RegisterClass`'s newly-found exposure is recorded
rather than fixed, and the reason is stated: for the two previously-known loops
the table under traversal is the caller's, so a finalizer could in principle
mutate it (undriven after several attempts at CR-15); for `RegisterClass` it is
a class metatable held only in the registry, which nothing outside that file can
name.

---

## §5 — the differential oracle

The strategic gap `CODE-REVIEW-HISTORY.md` identified: **no harness checks
whether an answer is right.** Three matrices and 850 tests check that nothing
crashed and that errors are clean. That was adequate while every finding
announced itself with a segfault, and stopped being adequate at CR-17.

`tools/diff-oracle/` runs the same Lua through two implementations and compares.
The reference is stock `lua` from the same vcpkg port that supplies the
`liblua.a` the addon embeds, installed via `vcpkg install lua[tools]` — so it is
Lua **at the exact version the addon embeds**, and a reference at a different
version would turn every version-specific behaviour into a false mismatch. The
oracle prints both versions and warns if they diverge.

It runs in two modes, and the split is the design:

- **Mode A — the embedded VM.** Both sides serialize in Lua, so nothing has
  crossed a boundary. A difference means the addon's hooks changed the language:
  the instruction-count hook, the allocator, the print override, the metatabled
  `_G`, the `__gc` bridge.
- **Mode B — the crossing.** The reference serializes in Lua; lua-native returns
  the marshalled JavaScript value and a mirror serializer canonicalizes *that*.
  This is the half with no reference implementation of its own, and it is where
  a silently wrong answer is most likely to live.

**The erasures are the specification.** JavaScript cannot represent every Lua
value distinctly, so a raw comparison would report hundreds of differences that
are the binding's documented design. Those distinctions are erased once, in
`canonical.lua`'s header, each with its reason — and the boundaries of each
erasure are as load-bearing as the erasure itself. The integer/float subtype is
erased *within* ±2^53 and deliberately **not** beyond it, because the addon
emits a BigInt there and so the subtype genuinely does cross; a large integer
arriving as a float is a real finding and this form will show it.

The corpus is generated rather than written out — adding an operator or a
string function multiplies through every operand set — across arithmetic,
comparison, bitwise, strings, patterns, tables, error text, coroutines,
metamethods, `math`, and a `crossing` category whose whole point is to compare
values *as values* rather than as strings the Lua side built.

Eight controls run before the corpus, on the same rule as the matrix: identical
sources must compare equal, deliberately different ones unequal, each side must
demonstrably run the case rather than return a constant, an error must be a
comparable outcome rather than a missing row, and both edges of the
integer/float erasure must hold.

**2678 comparisons. Mode A is completely clean** — 1339 cases and zero
differences, so nothing the addon installs perturbs the language. That is a
substantial negative result and the first time it has been measured rather than
assumed.

**Mode B found three silent data losses on the crossing**, none of which
anything in the project previously recorded:

- **O1.** A Lua string that is not valid UTF-8 is mangled — every invalid byte
  becomes U+FFFD. The loss is **not idempotent**: a 4-byte blob round-tripped
  through JavaScript returns to Lua as **8 bytes**, and `blob == back` is false.
  It is data-dependent — `string.pack('i4', 7)` is all bytes below 0x80 and
  survives — so binary handling appears to work until a byte goes high.
- **O2.** Table keys that are neither strings nor numbers are dropped:
  `{[true]=1, [false]=2}` arrives as `{}`. Not null values; absent entries.
- **O3.** A string key and a number key with the same text collide into one
  JavaScript property, and which value survives is table-order dependent.

All three are consequences of the JavaScript type system rather than mistakes in
the code, so all three are **documented on `execute_script()` in `types.d.ts`
and pinned**, not silently changed: carrying binary faithfully would mean
returning a `Uint8Array` for non-UTF-8 strings, which is an API decision.

Full write-up, including the two harness problems that had to be solved first
and the one case that was removed for flapping, in `docs/DIFFERENTIAL-ORACLE.md`.

---

## Verification of the CODE-REVIEW-17 remediation

Verified by re-running each item's generator rather than by reading its list.

| CR-17 # | Verdict |
|---------|---------|
| F1 | ✅ Correct. `lua_core::detail::OwningRuntime` and `LuaContext::RefForThisRuntime` are in place and all four mint sites in `CoreToNapiBuiltin` pass their ref through it. The CR-18 matrix drove `reset_then_throw` at all 27 frames — including `gc_finalizer_at_close`, which is F1's exact window — with no abort and no aliasing. |
| F2 | ✅ Correct. `set_global` refuses a foreign table handle; the deep-copy policy for class instances and JS-created userdata is unchanged and its pin still passes. |
| F3 | ✅ Correct. The `ContextLiveness` pair and single `DeadReason()` are in place; the five tightened assertions still read `/replaced by reset/`. |
| Release deferrals | Unchanged, as decided. `MACOSX_DEPLOYMENT_TARGET` is still `"26.0"` and `prebuilds/` still contains `darwin-arm64` only. §3 of `CODE-REVIEW-HISTORY.md` is deferred by decision — macOS/arm64 only for now. **(Superseded: closed as out of scope, `CODE-REVIEW-NEXT-STEPS.md` §14.)** |

---

## Findings

### F1. Four protected barriers invented a cause, and the cause they invented was "out of memory" (medium)

**What a barrier does.** `RunProtected`, `ProtectedTableCall`,
`PushProtectedGlobal` and `ProtectedConvert` each run an operation inside a
`lua_pcall` so a raising metamethod or a memory error becomes a catchable C++
exception instead of an unprotected panic. On failure each read the error value
Lua left on the stack:

```cpp
const char* msg = lua_tostring(L_, -1);
std::string err = msg ? msg : "protected operation failed (out of memory?)";
```

`lua_tostring` answers for a string or a number and returns null for everything
else. **Everything else includes a table** — and a table is exactly what this
binding stages a thrown JavaScript error into (`StageJsError` builds one with
`message`, `name`, `stack` and `__jsErrorId` fields). So the null branch, whose
comment reads "typically `LUA_ERRMEM` under `maxMemory`", was in practice the
*JavaScript callback threw* branch.

**Driven.** A JS `__index` that throws `new Error('MY-REAL-ERROR')`:

```
execute_script("return t.x")      -> MY-REAL-ERROR
handle.get("x")                   -> protected operation failed (out of memory?)
handle.has("x")                   -> protected operation failed (out of memory?)
handle.set("x", 1)                -> protected operation failed (out of memory?)
handle.length()                   -> table access error
handle.get_ref("x")               -> protected operation failed (out of memory?)
get_global("t.x")                 -> protected operation failed (out of memory?)
set_global("t.x", 1)              -> protected operation failed (out of memory?)
```

and through a raising `_G` metamethod:

```
set_global("zz", 1)               -> protected operation failed (out of memory?)
get_global("zz")                  -> global access error
```

The control is the sharp part: an error whose value *is* a Lua string reports
correctly through the identical path.

```
handle.get("x")  ->  [string "..."]:1: PLAIN-LUA-STRING
```

So the barrier was not broken; it was correct for one shape of error value and
guessing for the other, and the shape it guessed on was the common one.

**Why `execute_script` was right the whole time.** It routes its pcall failure
through `CaptureError`, which raw-reads the `"message"` key out of a table error
value before falling back to a protected `__tostring`. Seven call sites use it.
The four barriers each had their own one-line fallback instead. This is the
CR-16 F1 shape — an analysis done once and applied to some of the windows that
needed it — with the twist that here the *correct* implementation was the
widely-used one and the four exceptions were the copies.

**Recommendation — implemented and verified before being recommended.**

One `ProtectedFailureMessage()` for all four. It keeps the cheap `lua_tostring`
read for string and number values, and that is not an optimization: a genuine
`LUA_ERRMEM` leaves the string `"not enough memory"`, and `ErrorValueToString`
interns a key and runs a protected `__tostring`, neither of which is a good idea
on a state that has just failed to allocate. **The expensive path runs only for
the values that were being misreported.**

`ErrorValueToString` is `CaptureError` split in half, deliberately **without**
the side effect of recording the structured value. The barriers surface their
failure as a plain `Napi::Error`, not through `LuaErrorToJsValue`, so recording
would leave a value unconsumed for some later `ThrowLuaError` to pick up and
attribute to an unrelated failure — introducing a cross-path coupling in the
course of fixing a message.

**Recorded residual.** The handle methods now report the right *message* but
still deliver a fresh `Napi::Error` rather than the original JS Error object,
which `execute_script` does deliver. Closing that means moving 45 catch sites
from `catch (const std::exception&)` to the `ThrowLuaError` path, and this pass
has direct evidence about what a sweep of that size does to this codebase —
see F2's fix, below. It is a separate change with a separate risk profile and it
is recorded rather than smuggled in here.

### F2. A thrown non-Error loses its text entirely at three of four JS-crossing sites (low)

`Napi::Error::Message()` reads `.message` off the thrown value. For
`throw 'boom'`, `throw 42` or `throw null` there is no such property, so
`Message()` — and therefore `what()` — is the empty string. The 45 binding catch
sites are `catch (const std::exception& e)` and rebuild the error with
`Napi::Error::New(env, e.what())`.

```
                    throw 'STR-BOOM'                    throw new Error('ERR-BOOM')
host function       Host function 'f' ... : STR-BOOM    ERR-BOOM
type converter      Error, message ""                   ERR-BOOM
userdata getter     Error reading property 'p':         Error reading property 'p': ERR-BOOM
```

The host-function bridge is correct because it goes through `StageJsError`,
which has had the right rule since it was written: `message.empty() ? value.ToString() : message`.

**Recommendation.** That rule, in one place — `JsThrowMessage` — applied at the
four producers that call user JS without going through `StageJsError`, and at
`StageJsError`'s own two call sites so there is a single home for it. The
`ToString()` is itself contained, because it runs user code (`toString`,
`Symbol.toPrimitive`) on an error path.

**Fix the producers, not the 45 consumers.** The consumers are correct given a
correct `what()`, and this pass has a direct demonstration of what the
alternative costs.

**The fix that broke it, because it is the most useful thing in this section.**
The first version rethrew `std::runtime_error(JsThrowMessage(e))`. All 850 tests
had passed on the three property/converter sites; adding the fourth — the
Lua→JS converter loop inside `CoreToNapi` — took the vitest worker down.
`CoreToNapi` is reached from sites that catch **`Napi::Error` specifically**,
the print-handler and debug-hook bridges among them. Changing the exception's
*type* made those handlers miss it, and the escape unwound through Lua's C
frame: an instance of the CR-6 abort class, created by a fix for a message bug,
inside the pass whose entire subject is that class.

The corrected fix rethrows `Napi::Error::New(env, JsThrowMessage(e))` —
type-preserving, so every `catch (const Napi::Error&)` still works, and since
`Napi::Error` derives from `std::exception` the generic sites see it too and now
see a non-empty `what()`. Pinned, with the pin's own comment noting that if it
regresses the worker dies rather than the assertion failing, so the real
assertion is that the run reaches it at all.

> **An exception's type is part of its interface.** A catch site that names a
> type is a contract with everything that can throw through it, and it is
> invisible at the throw. Nothing in the four producers named the print handler;
> nothing in the print handler named the converters. The link was
> `catch (const Napi::Error&)` and a call graph, and no grep for either would
> have been prompted by "make this message non-empty".

### F3. The deliberate swallows were right, undocumented, and incompletely implemented (low)

A throwing print handler or debug hook is discarded and the script continues:

```
handler calls: 1   script returned: "script finished"
hook calls:    3   script returned: "script finished"
```

All eleven throw kinds, both frames, 22 cells — every one contained, every one
silent. The containment is correct and the source comments say why: the handler
runs inside Lua's C call frame for `print`/`io.write`, and the hook runs between
VM instructions, so a C++ exception unwinding through either would corrupt a VM
built as C.

Two things were wrong with it anyway.

**It was documented where the caller cannot read it.** `types.d.ts` described
`set_print_handler` and `set_hook` in detail and said nothing about the swallow.
A user whose handler throws sees their script succeed and their handler's error
vanish, with no way to learn that this is intended. Both now carry an
`@remarks` block stating it plainly, including what to do instead —
`cancel()` rather than throwing, from a hook.

**The containment caught one exception type.** `catch (const Napi::Error&)` was
the whole guard, so a `std::runtime_error` — from a core call the handler made
re-entrantly, say — would have unwound straight through the frame the comment
claims to protect. Empirically nothing produced one (all eleven kinds arrive as
`Napi::Error`), so widening to `catch (...)` closes the gap in kind rather than
in fact. Worth doing precisely because it *was* only true by accident: F2's
first fix would have started producing `std::runtime_error` on one of these
paths within the hour.

---

## Verified and rejected (adversarial suspicions that held up)

- **The 225 clean cells.** Stated as a finding in the negative. Every throw kind
  at every frame surfaces a catchable error and leaves a working context.
- **No aborts anywhere.** The class that produced highs in CR-2, CR-6 and CR-8
  did not produce one cell here, including at `__gc`-inside-`lua_close`, where
  there is no Lua error handler above the frame at all.
- **The `handle.x` property read returning `undefined`.** Suspected as a silent
  swallow and it is not: `get_global_ref` returns a method-based
  `LuaTableHandle`, not a property Proxy, so a bare property read was never
  going to reach Lua. Checked against a table with the field actually present —
  `p.a` is `undefined` there too. Behaving as documented.
- **Strandedness on the error path.** 0 B/iter over 200 iterations, released.
- **The class constructor returning an unconvertible value.** Reports
  `Class 'Cr18' constructor must return an object`, which is the right error;
  it appeared in the swallowed column only because that message names the
  contract rather than the Symbol.
- **`RunProtected`'s new `CaptureError`-derived path under real OOM.** Avoided by
  construction rather than tested into submission — the string branch is taken
  for `LUA_ERRMEM`, so the allocating path never runs on the OOM route.
- **CR-16's occupancy work and CR-17's lifetime fixes.** Neither regressed; all
  four sanitizer harnesses clean and the full suite green after every step.

---

## Suggested priority order

1. **F1** — the fabricated cause. It is the one a user actually hits: an
   ordinary JS callback throwing inside any table-handle operation, reported as
   a memory exhaustion.
2. **F2** — the lost message, and the type-preserving rethrow.
3. **F3** — document the swallow and widen the containment.

---

## Note on the trajectory

CR-17 said the failure mode had moved from crashing to lying. CR-18 is the first
pass where **nothing crashed at all** — 297 cells across the last hazard family
that had never had a generated search, and the abort count is zero. All three
findings are the code lying: a fabricated cause, a lost message, an undocumented
silence.

That makes the shape of the remaining risk clearer, and it is not where the
first seventeen passes were looking:

> **The instruments have caught up with the crashes.** Four sanitizer harnesses,
> an injection matrix, two lifetime matrices and now an exception matrix all
> answer the question "did it survive". They now come back clean, and a fifth
> instrument of the same kind would very likely also come back clean. What
> none of them can answer is whether the value was right — and the three
> findings here, like CR-17's three, were all found by *reading a column of
> successes*.

That is why §5 was built in the same pass rather than deferred behind another
matrix: it is the first harness in the series whose failure mode is "this answer
is wrong" rather than "this run died".

Three second-order observations.

**A vacuous cell and a clean cell are the same row until something distinguishes
them.** Two of this matrix's 27 frames never ran their callback at all, and
reported eleven swallowed exceptions each for exceptions that were never raised.
CR-17 established that a matrix needs a positive control; CR-18 adds that the
control has to be **per cell**, not per harness. The four run-level controls all
passed while two frames were measuring nothing, because the controls exercised a
frame that worked. The fix — count the callback invocations and report zero as
`VACUOUS` — is three lines, and it is the difference between a search and the
appearance of one.

**Over-reporting is a failure mode, not a safe default.** 180 swallowed rows
contained the three real findings and 128 pieces of instrumentation noise, and
the noise is what made the report unreadable. The temptation with an exhaustive
search is to leave every questionable row in on the grounds that a human will
triage it; the honest accounting is that nobody triages 180 rows twice, so the
second run of a noisy matrix is the run where a real regression is skimmed past.
Encoding the triage — with a reason per entry, and a stale-entry check so the
list cannot only ever suppress — is what makes a matrix worth re-running.

**The class this pass closed is the class its own fix reopened.** F2's first
version put a `std::runtime_error` on a path guarded by
`catch (const Napi::Error&)`, and the process died. Six passes running have now
found that a structural fix introduces a fresh defect, and this one is the most
pointed instance: the defect was an instance of the very family being closed,
introduced by the person who had spent the day characterising it, in the same
file. The mechanism that caught it was the pre-existing test suite, not the new
matrix and not the reasoning — which is an argument for making the small change
and keeping the suite green after each one, rather than for reviewing harder.
