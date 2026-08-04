# CODE-REVIEW-19

**Date:** August 3, 2026
**Scope:** Nineteenth pass, against the CR-18 remediation as it stands in the
working tree (on top of `8b9bfbd`). Primary target: **the instruments CR-18
added**. Secondary: the CR-18 remediation itself, and a fresh read of the
binding surface the recent passes have left alone.

**Method:** CR-18 did three things at once — it closed the exception-escape
family, it converted the comment-enforced invariants into generated checks, and
it built the first oracle in the series. The result is that roughly 2,700 lines
of harness now carry a meaningful share of this project's confidence, and none
of it has been reviewed. CR-17's lesson was that a matrix can be vacuous and
report clean; CR-18 found its own scanner vacuous mid-pass. So this pass treats
the harnesses as the code under review, and asks of each one the question the
series keeps having to ask: **what does this check actually cover, as opposed to
what its write-up says it covers?**

Where a gap was found it was **driven** — a reproduction, or a computed
enumeration of what the check cannot see — rather than argued.

**Baseline:** 898 TypeScript and 285 C++ tests pass; all four sanitizer
harnesses are clean; the 297-cell exception matrix reports 0 cells to read; the
2678-case differential oracle reports 0 disagreements.

**Findings were reported open and fixed subsequently.** The resolution table is
below; the findings themselves are unchanged from when they were written. Line
references are to the tree as reviewed.

---

## Headline

**The three findings are all in the instruments, and the two substantial ones
are the same defect in different clothes: a mechanical check whose universe is
smaller than the claim it is used to support.**

- **F1 (medium).** `core-call-guarding` — the invariant CR-18 introduced
  specifically to mechanize the CR-6 F1 class — is **one level deep**. It treats
  a core method as throwing only if that method calls `RunProtected` itself, so
  it misses **seven** core methods that throw transitively (`GetGlobal`,
  `TablePairs`, `TableIPairs`, `GetTableLength`, `SetOutputHandler`,
  `HasPackageLibrary`, `~LuaRuntime`). It also only ever looks at calls spelled
  `runtime->X(...)` inside a single binding function, so it cannot follow
  `SetPrintHandler → InstallPrintHandler → SetOutputHandler` — a chain where the
  `try` that makes it safe sits one frame up from the call it protects. "36
  rows, 0 unguarded" is true and is a much weaker statement than CR-18 made of
  it. **No live defect**: I enumerated the eight binding call sites reaching the
  seven missed methods and read all three `InstallPrintHandler` paths, and every
  one is guarded. The check simply cannot see that, in either direction.
- **F2 (medium).** The `CallScope` scanner **silently swallows a function**. A
  bodyless macro invocation at column 0 (`NODE_API_MODULE(...)`) has no `{`, so
  the scanner scans forward for one and finds the *next* function's — consuming
  `LuaContext::NapiToCoreInstance` whole. The frozen classification therefore
  contains a row named `NODE_API_MODULE` carrying `NapiToCoreInstance`'s data,
  and no row at all for `NapiToCoreInstance` — a function the header's own
  predicate names twice. The instrument built to stop this enumeration decaying
  shipped with the enumeration already wrong, which is CR-15 F3's shape exactly.
- **F3 (low, driven).** CR-18 F2's class is **unswept at a fifth site**.
  `SharedTable::Propagate` formats `e.Message()` into its aggregate failure
  string, and for a non-Error throw that is empty:
  `shared table update failed for 1 of 2 contexts (settings: )`. The fix cannot
  reach it by construction — `JsThrowMessage` is a private static of
  `LuaContext` and this is `SharedTable` — which is precisely the kind of
  structural reason a producer-side sweep leaves a consumer behind.

The pattern is worth naming before the detail. CR-18's own closing note argued
that fixing *producers* rather than *consumers* was the disciplined choice,
because "the consumers are correct given a correct `what()`." F3 is a consumer
that formats the message itself and is downstream of none of the four producers.
And F1 and F2 are the two checks written to prevent exactly this sort of thing
from recurring, each with a hole a new site could walk through.

> **A mechanical check inherits the authority of the thing it replaced, and none
> of its caveats.** The comment `core-call-guarding` replaced said "every
> `RunProtected`-backed core call reachable from N-API must be inside a
> `try`/`catch`" — a claim about *reachability*. The check computes something
> narrower and is cited as if it computed the claim.

---

## Resolution status (August 3, 2026)

**All findings resolved.** After the fixes: **913 TypeScript tests** (up from
898) and **285 C++ tests** pass; all four sanitizer harnesses are clean; the
invariants, the CR-18 exception matrix, the differential oracle and CR-20's
round-trip matrix all run clean.

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | `throwingCoreMethods()` now computes a **transitive closure** over unguarded sibling calls — 47 methods where it found 30, picking up the seven it could not see (`GetGlobal`, `TablePairs`, `TableIPairs`, `GetTableLength`, `SetOutputHandler`, `HasPackageLibrary`, `~LuaRuntime`) and two more (`GarbageCollect`, `GarbageCollectParam`) that fell out of it. `coreCallGuarding()` is now **path-aware**: it builds the binding-to-binding call graph and computes a fixpoint, so a function is scored by what reaches N-API rather than by its own body. `InstallPrintHandler` accordingly reports `CONTAINED_BY_CALLERS(3)` — the three guarded callers this pass verified by hand — instead of a bare `UNGUARDED`. The `DetachRuntimeHandlers` row that this review flagged as a false positive of its own analysis is now `JUSTIFIED_FALSE_POSITIVE`, carrying the argument-insensitivity reason in a ledger with a stale-entry check, because an over-approximating check presented as a defect list is its own failure mode. |
| F2 | ✅ Done | The scanner requires continuation lines of a signature to be **indented**, which is what distinguishes a real multi-line signature from a bodyless macro at column 0. `NODE_API_MODULE` no longer adopts the next function's brace: the binding scan finds 118 functions where it found 116, `LuaContext::NapiToCoreInstance` has its own row, and the bogus `NODE_API_MODULE` row is gone. **A seventh invariant, `scanner-coverage`, was added** — every column-0 definition-shaped line must be attributed to a function or explicitly classified as a declaration or macro invocation, and an `UNATTRIBUTED` line turns the suite red. That is the check whose absence let this survive: a scanner that drops input reports clean over a smaller universe than anyone believes it covers. |
| F3 | ✅ Done | `JsThrowMessage` moved from a private static of `LuaContext` to a **file-scope free function**, which is what makes the rule reachable from `SharedTable` — the structural reason the producer-side sweep could not have fixed this site. `Propagate` now formats it instead of `e.Message()`; a subscriber throwing a string, a number or `null` reports its cause where it previously contributed an empty one. Four pins. |
| F4 | ✅ Done | The cell records `reinstalls` and a `strandednessScope` of `install+trigger` or `trigger-only`, and the matrix reports the trigger-only cells separately rather than folding them into the clean total — so the three `class_*` frames no longer report a number for a sentence they did not measure. `process.memoryUsage().external` is captured alongside the Lua heap as a coarse signal for the C++-side maps that `get_memory_usage()` cannot see. |
| F5a | ✅ Done | The fifth `msg ? msg :` survivor is documented in place: `luaL_loadbuffer` always leaves a string, so the fallback is unreachable, and the reason the four barriers differed (a thrown JS error is staged as a *table*, which needs user code running) is written down rather than left to be re-derived. |
| F5b | ✅ Done | The oracle's address normalisation is anchored to the `table:` / `thread:` / `function:` / `userdata:` prefixes Lua emits. Verified: a string-valued result that looks like a hex literal is now visible to the comparator, and a genuine table address is still erased. |
| F5c | ✅ Done | `PushValue` names the real fact — the subscriber's `set_global` has been shadowed by an own property — instead of asserting that a context is not a context. Pinned. |
| F5d | ✅ Noted | Scope note only; `docs/DIFFERENTIAL-ORACLE.md` already states what mode B does not cover. |

**One defect was found while fixing these, and it is worth recording** because it
had been latent in the suite for five passes: the **CR-15 F5 test permanently
patched `Symbol.hasInstance` on the `SharedTable` constructor and never restored
it.** After it ran, `AsSharedTable`'s `InstanceOf` filter accepted any object,
so `napi_unwrap` was handed objects it had never wrapped and **every subsequent
`new init({}, { shared })` in the process failed with a bare "Invalid
argument"**. Nothing caught it because that test was the last in the suite to
construct a shared context — until CR-19 F3's pin was added after it, which is
how it surfaced. The patch is now `configurable: true`, restored in a `finally`,
and the test asserts an ordinary shared context still constructs afterwards.

---

## Verification of the CODE-REVIEW-18 remediation

Verified by re-running each item's generator, not by reading its table.

| CR-18 # | Verdict |
|---------|---------|
| F1 | ✅ Correct at the four barriers. `grep -c 'ProtectedFailureMessage()' src/core/lua-runtime.cpp` returns 5 — one definition and the four call sites — and the four invented causes are gone. Re-driven: a JS `__index` throwing `new Error('THE-REAL-CAUSE')` now reports that message through `handle.get/has/set/length/get_ref`, dotted `get_global`/`set_global`, and a raising `_G` metamethod, and the "out of memory?" wording appears nowhere. The string path is unchanged and still reports the Lua-side message with its chunk prefix. **One caveat, filed as a nit (F5a): a fifth `msg ? msg : "<invented cause>"` survives** at `lua-runtime.cpp:3581` (`"failed to load script"`). It is benign — `luaL_loadbuffer` always leaves a string — but nothing records that, and CR-18 F1's write-up says "four" without saying why the fifth is not one. |
| F2 | ✅ Correct at the four producers, and the type preservation holds: `grep -c 'throw Napi::Error::New(env, JsThrowMessage(e))'` returns 4 and `throw std::runtime_error(JsThrowMessage` returns 0, so the regression that took the worker down cannot silently return. **Incomplete as a class sweep — see F3.** |
| F3 | ✅ Correct. Both bridges carry `catch (...)`, and `types.d.ts` carries the `@remarks` on `set_print_handler` and `set_hook`. Re-driven: a throwing print handler and a throwing debug hook are both swallowed with the script completing, and the context survives. |
| §4 invariants | ⚠️ Present and running, and **two of the six are narrower than claimed** — F1 and F2. The other four (`lua-next-sites`, `occupancy-policy-sites`, `greppable-counts`, `exception-surface`) re-derive correctly; I re-ran each generator by hand against the source and got the frozen answer. |
| §5 oracle | ✅ Correct, and the switch to the vcpkg interpreter is verified behaviour-preserving: comparing the reference output of all 2678 cases before and after, **7 differ and all 7 are raw addresses**, which the comparator normalises. Mode A remains 1339/1339 clean. **One nit (F5b): the address normalisation is over-broad.** |

---

## Findings

### F1. The mechanized CR-6 F1 check is one level deep, and never looks where the guard actually is (medium)

CR-18 introduced `core-call-guarding` with an explicit claim:

> *"**The CR-6 F1 class, mechanized at last.** Every binding call to a
> `RunProtected`-backed core method, scored guarded or not. 36 rows, 0
> unguarded."*

Both halves of the mechanism are narrower than that sentence.

**Half one — the throwing set is computed one level deep.**
`throwingCoreMethods()` marks a core method as throwing iff its own body
contains an unguarded `RunProtected(`. A method that throws because it *calls*
one that throws is not in the set. Computing the transitive closure instead:

```
direct throwers   : 40
transitive total  : 47
missed by the check:  GetGlobal  GetTableLength  HasPackageLibrary
                      SetOutputHandler  TableIPairs  TablePairs  ~LuaRuntime
```

`LuaRuntime::GetGlobal` is the clearest case and needs no analysis to see:

```cpp
LuaPtr LuaRuntime::GetGlobal(const std::string& name) const {
  StackGuard guard(L_);
  PushProtectedGlobal(name);          // throws
  return ToLuaValueProtected(L_, -1); // throws
}
```

Two throwing calls, no `RunProtected` of its own, and therefore no row in the
table. A new binding method calling `runtime->GetGlobal(...)` outside a `try`
would not be reported as `UNGUARDED`; it would not appear at all.

**Half two — the guard is often not in the function that makes the call.** The
check scans one binding function at a time for `runtime->X(...)` and asks
whether *that* call site is inside a `try`. But the codebase's actual shape for
the print-handler path is:

```
SetPrintHandler        try { … InstallPrintHandler(fn) … } catch (std::exception&)
  InstallPrintHandler    runtime->SetOutputHandler(lambda)      <-- no try here
```

The call is unguarded where it is written and guarded where it matters, one
frame up. The check sees only the first fact.

**Driven — the enumeration, not the argument.** Computing the closure and then
locating every binding call site to one of the seven missed methods gives eight
rows:

```
guarded    TableHandleLength              -> GetTableLength
guarded    TableHandlePairs               -> TablePairs
guarded    TableHandleIPairs              -> TableIPairs
guarded    LuaContext::GetGlobal          -> GetGlobal
guarded    LuaContext::Call               -> GetGlobal
guarded    LuaContext::SetPrintHandler    -> SetOutputHandler
UNGUARDED  LuaContext::InstallPrintHandler-> SetOutputHandler
UNGUARDED  LuaContext::DetachRuntimeHandlers -> SetOutputHandler
```

Both `UNGUARDED` rows were then read, and **neither is a defect**:

- `DetachRuntimeHandlers` passes `nullptr`, and `SetOutputHandler(nullptr)`
  takes the `else` branch — `output_handler_.reset()` — which never calls
  `InstallOutputRedirection`. My closure is argument-insensitive; this is a
  false positive of the analysis, and worth recording as such, because an
  over-approximating check that is fed to a reader as a list of defects is its
  own failure mode.
- `InstallPrintHandler` does pass a real handler and can throw, but all three of
  its callers wrap it: the constructor (`lua-native.cpp:1040`), `reset()`'s
  replay (`:3605`), and `SetPrintHandler` (`:3817`). Each carries a comment
  naming CR-6 F1. The class is genuinely clean.

**So there is no live abort — and that is the finding.** The class is clean by
the same means it was clean before CR-18: somebody read the code. The check that
was supposed to make that unnecessary would not have noticed if it were not.

**Recommendation.** Compute the throwing set as a transitive closure over
unguarded sibling calls, and make the *unit of the guarding question* a path
from an N-API entry point rather than a single function body — i.e. a binding
function that calls a throwing core method unguarded is only reportable if none
of *its* callers guards it. Both are ordinary fixpoints over the same scan that
already exists. Failing that, the row count must stop being quoted as coverage:
the check's honest claim is "the 36 direct `runtime->X()` calls to a directly-
throwing method are guarded", and it should say so where it is read.

### F2. The CallScope scanner swallows the function after a bodyless macro (medium)

`topLevelFunctions()` finds a definition by matching a line at column 0, then
scanning forward up to 25 lines for the `{` that opens its body. A macro
invocation at column 0 with no body defeats this: it matches, has no brace of
its own, and the scan finds the *next* function's.

`src/lua-native.cpp` has exactly one:

```cpp
NODE_API_MODULE(NODE_GYP_MODULE_NAME, InitModule)      // :3971

lua_core::LuaValue LuaContext::NapiToCoreInstance(...) {   // :3973
```

Driven:

```
scanner thinks NODE_API_MODULE spans lines 3971 - 3987
its "body" actually begins:
    lua_core::LuaValue LuaContext::NapiToCoreInstance(const Napi::Value& value, int depth) {
```

Having consumed through line 3987, the scan resumes past `NapiToCoreInstance`
entirely. The consequences are both in the frozen answer:

```
NapiToCoreInstance present in the classification: false
NODE_API_MODULE  present in the classification: true  -> "NO_SCOPE"
```

The `NO_SCOPE` verdict on the `NODE_API_MODULE` row is a verdict on
`NapiToCoreInstance`, filed under the wrong name.

**Why it matters more than one row.** `NapiToCoreInstance` is not incidental to
this invariant — it is *named in the predicate the header states*, twice, as one
of the calls whose first occurrence a `CallScope` must precede. It is the
top-level JS→Lua conversion entry and it opens the `JsCallbackCollectorScope`
that CR-5 F1 exists for. A reviewer checking whether it is in the universe finds
nothing and reasonably concludes it is out of scope. And if it later gained or
lost a scope, the check would report the change under `NODE_API_MODULE`.

This is CR-15 F3's finding — *"the enumeration was wrong on arrival"* — recurring
one level up: the enumeration is now generated, and the generator was wrong on
arrival. That the mechanism is code rather than a comment did not help, because
nothing checked the generator's own coverage.

**Recommendation.** Two changes, both small. Reject a candidate whose "body"
opens on a line that itself looks like a definition, or more simply: require the
opening `{` to appear within the same *statement*, treating a candidate with a
matched `)` followed by a newline and no `{`/`;` as a macro invocation and
skipping it. Independently, add a coverage assertion of the kind this pass used
to find it — every column-0 line that looks like a definition is either
attributed to a function that starts on it, or explicitly classified as a
declaration or macro. A scanner that silently drops input is the same hazard as
a matrix cell that silently runs nothing, and it should be checked the same way.

### F3. CR-18 F2's class survives at a fifth site, structurally out of the fix's reach (low)

`SharedTable::Propagate` builds an aggregate failure message across subscribers:

```cpp
} catch (const Napi::Error& e) {
  ++failed;
  ...
  failures += e.Message();       // lua-native.cpp:790
}
```

`Napi::Error::Message()` is empty for any throw that is not an Error object —
the whole subject of CR-18 F2 — and this site formats it directly rather than
receiving it from one of the four producers that were fixed.

**Driven.** Two contexts subscribed to one shared table; the subscribing
context's `set_global` shadowed by an own property, which is the path
`lua-native.h`'s own `CallScope` commentary already documents as reachable
(*"an own property on the wrapper shadows the prototype method, so the push can
be an arbitrary user function"*). Plain assignment is refused — the prototype
method is non-writable — but `Object.defineProperty` on the instance succeeds:

```
new Error("REAL")  -> shared table update failed for 1 of 2 contexts (settings: REAL). …
a bare string      -> shared table update failed for 1 of 2 contexts (settings: ). …
null               -> shared table update failed for 1 of 2 contexts (settings: ). …
42                 -> shared table update failed for 1 of 2 contexts (settings: ). …
```

`settings: ` with nothing after the colon — the same shape CR-18 F2 reported at
the userdata property bridge (`Error reading property 'p': `) and fixed there.

**Why the sweep could not have reached it, which is the interesting part.**
CR-18 F2 argued explicitly for fixing producers over consumers:

> *"the consumers are correct given a correct `what()`, and a 45-site edit is
> exactly the kind of sweep that has introduced a fresh defect every time."*

That reasoning is sound for the 45 `catch (const std::exception& e)` sites, which
re-wrap `what()`. It does not hold for a consumer that reads `Message()` off the
`Napi::Error` itself and is not downstream of any producer: here the throw comes
from a JS function `PushValue` calls directly. And the remedy is not a one-line
edit either, because `JsThrowMessage` is a **private static member of
`LuaContext`** while this is `SharedTable` — the single home the fix created for
the rule is not visible from the one site still needing it.

Severity is low: the message is a diagnostic, the data is not lost (the JS-side
value is updated and `sync()` retries), and reaching an empty cause requires the
shadow. But it is the class, unswept, in the pass that made not-sweeping-a-class
its central lesson.

**Recommendation.** Move the rule out of `LuaContext` — a free function in an
anonymous namespace at the top of `lua-native.cpp` reaches both classes — and
call it here. Then the "one home" claim is true of the file rather than of one
class.

### F4. The matrix's strandedness assertion measures the wrong heap, and is a no-op for three frames (low)

CR-18 stated four assertions per cell, the fourth being *"repeating the whole
install-and-trigger strands nothing"*, and reported it as a negative result:
`0 B/iter` on release, on the error path as well as the success path.

Two limits on what that measured.

**It measures the Lua heap only.** The probe is
`lua.get_memory_usage()`, which reports Lua's allocator. The strandedness CR-6
F1 was actually about is C++-side: a `js_userdata_` entry left behind (*"a live
`Napi::ObjectReference` stranded until context destruction"*), a `js_callbacks_`
or `host_functions_` entry, a `type_converters_` vector that only grows. None of
those live in the Lua heap. Some registrations also mint a Lua closure and so
are partly visible, but the map entry itself is not — so the assertion is
weaker than "nothing is stranded" and cannot distinguish the two.

**For three frames the install half never runs twice.** The repeat loop calls
`frame.install` again each iteration inside a `try {} catch {}`. For the three
`class_*` frames that is `register_class('Cr18', …)`, which refuses a duplicate:

```
install #0: ok
install #1: THREW -> class 'Cr18' is already registered on this context
install #2: THREW -> class 'Cr18' is already registered on this context
```

So iterations 2–12 exercise the trigger against the first registration and never
re-enter the registration path — which is the path most likely to strand a
callback entry. The reported number is real; it just is not a measurement of
what the assertion says.

**Recommendation.** Report the C++-side counts rather than the Lua heap — the
context already exposes enough through `info()` to add a registered-callback
count, or the probe can use `process.memoryUsage().external` as a coarse second
signal. And have the repeat loop assert that `install` actually succeeded, or
mark the cell's strandedness column not-applicable when it did not — the same
`VACUOUS`-versus-`CLEAN` distinction the pass added for the trigger, applied to
the other half of the sentence.

### F5. Nits

**a. A fifth invented cause survives, undocumented.**
`lua-runtime.cpp:3581` keeps `return std::string(msg ? msg : "failed to load script")`
— the exact pattern CR-18 F1 removed from four barriers. It is benign, because
`luaL_loadbuffer` always leaves a string error value, but nothing says so, and a
reader grepping the pattern that F1 is about finds a survivor with no
explanation. Either route it through `ProtectedFailureMessage()` for uniformity
or record why it is not one of the four.

**b. The oracle's address normalisation is over-broad.** `normalise()` replaces
`/0x[0-9a-fA-F]+/g` on both sides, which is correct for `table: 0x…` and wrong
for any *string-valued* result that happens to look like a hex literal. Driven
against the comparator:

```
MASKED   a string result that looks like an address
MASKED   string.format(%x) output
MASKED   a genuine table address (must be erased)
```

No corpus case currently produces one — `tonumber("0x10")` yields a number, not a
string — so this is latent rather than live. Anchoring the pattern to the
`table: ` / `thread: ` / `function: ` prefixes that Lua actually emits would
keep it correct and make a future `%x` case comparable instead of silently
passing.

**c. `PushValue` misattributes a shadowed non-function `set_global`.** Shadowing
the method with a non-function makes
`throw Napi::Error::New(env_, "shared table subscriber is not a Lua context")`
fire against something that *is* one. The message names the wrong fact — CR-17
F3's family — and the accurate one ("its `set_global` has been replaced") is
available at the throw site.

**d. The oracle's mode B covers one entry point.** It compares what
`execute_script` returns. The JS→Lua direction, table handles, userdata,
registered classes and the async surface are outside it. `docs/DIFFERENTIAL-ORACLE.md`
says so under "What it does not cover", so this is a scope note rather than a
defect — but the oracle's headline result ("2659 agree") reads as broader than
one entry point, and the two are quoted together.

---

## Verified and rejected (adversarial suspicions that held up)

- **`ErrorValueToString`'s stack discipline.** CR-18 F1 inserted it under four
  callers that then `lua_pop(L_, 1)`. All three exit paths were traced: the
  table/`message` branch pushes a key and rawgets (net +1), then pops on both
  outcomes; the protected-`__tostring` branch pushes a function and a value
  (+2), `lua_pcall(1,1,0)` leaves one result (net +1), and both outcomes pop it;
  the `luaL_typename` fallback pushes nothing. Net zero on every path, error
  value still at −1 for the caller's pop. Correct.
- **The unprotected allocation CR-18 F1 widened the reach of.**
  `ErrorValueToString` does `lua_pushstring(L, "message")` outside any protected
  frame, and F1 gave four more barriers a path to it. Pursued and found bounded
  rather than reportable: the guard F1 added means only a *non-string* error
  value reaches it, and a genuine `LUA_ERRMEM` leaves the string
  `"not enough memory"` — so the OOM route never takes the expensive path. The
  residual case (memory nearly exhausted *and* a JS callback throwing) needs
  `lua_pushstring` on a short literal that `CaptureError` interns on every error
  path already, which does not allocate. Worth knowing; not worth a finding.
- **`DetachRuntimeHandlers`.** Flagged `UNGUARDED` by my own transitive closure
  and refuted by reading: the `nullptr` argument selects the non-throwing
  branch. Recorded in F1 as a false positive of the analysis rather than
  quietly dropped.
- **The three `InstallPrintHandler` call sites.** All guarded, each with a
  comment naming CR-6 F1. The class is clean.
- **`Propagate`'s subscriber list.** Only real contexts reach it —
  `Subscribe` is called from the constructor with `this` — so `PushValue`'s
  "not a Lua context" guard cannot be fed an arbitrary object, only a context
  whose method has been shadowed. F5c is about the wording, not a hole.
- **`JsThrowMessage`'s containment.** `value.ToString()` runs user code on an
  error path and is wrapped in `catch (...)`; a Symbol, a throwing
  `Symbol.toPrimitive` and a null all return a fixed string rather than
  re-entering the failure.
- **The `catch (...)` widening (CR-18 F3).** Considered whether it could now
  swallow a pending N-API exception and leave the environment inconsistent. It
  cannot: node-addon-api clears the pending exception when it constructs the
  `Napi::Error` it throws, so there is nothing left pending to swallow.
- **The oracle's mode A result.** Re-run: 1339/1339. The embedded VM still
  matches stock Lua exactly, and the vcpkg-interpreter switch changed nothing
  but addresses.
- **The remaining four invariants.** `lua-next-sites` (5), `occupancy-policy-sites`
  (4), `greppable-counts` (3) and `exception-surface` (6) were each re-derived
  by hand against the source and match the frozen answer.

---

## Suggested priority order

1. **F2** — the swallowed function. It is the cheapest to fix, it is silently
   wrong *now* in a checked-in artifact, and until it is fixed the
   `callscope-classification` row count cannot be quoted at all.
2. **F1** — the shallow guarding check. No live defect, but it is the check the
   project will lean on the next time somebody adds a binding method, and it
   would not catch the thing it exists to catch.
3. **F3** — the fifth `Message()` site, and moving the rule somewhere both
   classes can see.
4. **F4** — the strandedness probe, which currently reports a number for a
   sentence it does not measure.
5. **F5** — nits.

---

## Note on the trajectory

The user's standing question is whether findings are moving from high to lower.
This pass answers it in a way the previous eighteen could not, because for the
first time **none of the findings are in the product**.

F1, F2 and F4 are defects in test infrastructure. F3 is a diagnostic string
behind a deliberately-shadowed method. Nothing here crashes, corrupts, leaks or
returns a wrong value to an ordinary caller. Against CR-17 — silent
cross-registry aliasing and a use-after-free at teardown — that is a large
distance in two passes.

But the shape of it deserves more suspicion than celebration, and there are
three things worth writing down.

**The instruments are now the largest unreviewed surface in the repository.**
CR-18 added ~2,700 lines of harness and reviewed none of it, and this pass found
two coverage holes and one silent parse failure in it. That is roughly the
defect density the *product* had around CR-8. The harnesses have no tests of
their own beyond the controls, and the controls check that the harness can
report dirty — a necessary property that says nothing about whether the harness
looks at everything it claims to. **A positive control proves the instrument can
fire; it does not prove the instrument is pointed at the whole subject.** F2 is
exactly that gap: the invariant spec passes its controls, and silently omits a
function.

**Mechanization moves the decay, it does not stop it.** The argument in
CR-18 §4 was that a hand-maintained list decays and a generated one cannot. What
this pass shows is that a generated list decays in a *different place* — into the
generator's own coverage, where it is much harder to see, because the output
looks authoritative and nobody re-derives it by hand. Three passes repaired the
`CallScope` list and each repair was visibly a list somebody had edited; this
one is a JSON file nobody will ever read. That is a real improvement in the
common case and a real regression in the failure case, and the mitigation is not
more generation but the boring one: **a generator needs a coverage assertion —
that every input was classified — as much as it needs a correctness assertion.**

**And the class-versus-site lesson claimed a victim in the pass that taught
it.** CR-18 F2's write-up is a careful argument for fixing producers rather than
consumers, and it is right about the 45 consumers it considered. It reached that
conclusion by enumerating the consumers that re-wrap `what()` — and
`SharedTable::Propagate`, which formats `Message()` itself, is not one of those
and was never in the set being reasoned about. The enumeration that justified
the strategy had the same hole as the strategy.

> **The recurring failure in this codebase is not fixing the site instead of the
> class. It is being confident about the boundary of the class.** CR-5 F11 knew
> the class and drew it around one method. CR-6 drew it around
> `RunProtected`-backed calls and missed the transitive ones — the same boundary
> CR-18's mechanization inherited without noticing. CR-18 F2 drew it around
> producers and missed a consumer that was not shaped like the others. Every one
> of those was a considered boundary, argued for in prose, and short by a
> little. The instrument that would help is not a better argument; it is the
> habit this pass used throughout — **compute the closure, then read the rows it
> adds.**
