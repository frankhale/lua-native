# FIDELITY-AND-REACH-PLAN

> **Superseded August 7, 2026 — executed in full and moved here the same day.**
> Every item (D1, D2, T1–T4, R1–R4) is done; §7's status table is the check.
> What survives as *instruction* lives where it executes: `LIMITATIONS.md` §1,
> §5 and §9 for the bounds and the options, `types.d.ts` and `README.md` for the
> API, and `check-invariants` / `roundtrip-matrix` / `capability-matrix` for the
> checks. **Read this for the reasoning and for what it got wrong — never for
> what to do next.**
>
> Three of its predictions were wrong in the useful direction (§8): D1's
> resolution was easier than forecast, T1's option had to move a layer deeper
> than designed, and R1 never touched the occupancy model it was expected to
> collide with.

**Written August 7, 2026.** Two questions asked together, kept apart here because
they have different evidence and different bars:

- **Fidelity** — where does a value cross this boundary and arrive *diminished*,
  and which of `LIMITATIONS.md`'s entries can be tightened rather than merely
  documented?
- **Reach** — what does a comparable bridge do that this one cannot, excluding
  the capabilities that are closed scope decisions?

**This is the fourth plan document.** `docs/README.md` sets the bar the first
three established, and it is met item by item below: **every item traces to
something measured in this repository** — a driven repro, a row in
`LIMITATIONS.md` whose mitigation turns out to be partial, or a precedent from an
earlier pass — **and §7 states a closing condition that can be checked rather
than felt.** The third plan supplied the corollary that matters most here: *a
plan can be rigorously derived and still be wrong in its details*, and the errors
land in the plan's own premises, not in the work. Two of `PERFORMANCE-PLAN`'s
four mistakes were in its controls. §8 is this plan's dated predictions so
execution can score them the same way.

**Not a review pass.** No boundary here is unsearched; `CORRECTNESS.md` §15.10's
clause 5 does not move because of anything in this document. This is product
work — features and defects — and it is written down because the survey that
produced it would otherwise evaporate.

---

## 1. The rule that generates the enumeration

Stated first, because `CORRECTNESS.md` §15.2 and §15.6 both had to learn this the
expensive way: *an enumeration has to record the rule that generated it, or it
cannot be checked for completeness — only extended when something leaks past.*

Two rules, one per part:

> **A fidelity item belongs here when a claim in `FEATURES.md`, `LIMITATIONS.md`
> or `types.d.ts` is falsified by driving the shipped addon, or when a
> limitation's stated mitigation covers a strict subset of the doors the
> limitation names.** The second clause is the W1 shape: `allowBytecode` was
> found five doors short of its own claim, and nothing about that was hard once
> someone compared the mitigation to the surface.

> **A reach item belongs here when a capability is present in a comparable
> JS↔Lua bridge (wasmoon, fengari) or in the wider embedding ecosystem
> (mlua, sol2, LuaJIT-FFI stacks), is absent here, and is *not* one of the four
> capabilities the owner or the correctness programme has already closed.** The
> closed four are listed in §6 so the rule is falsifiable rather than a matter of
> taste.

**What neither rule admits:** an idea that would be nice. `BRIDGE-COMPARISON.md`
is a frozen record and its priority matrix may not seed work
(`docs/README.md`); every reach item below is re-derived against the shipped API,
not lifted from that table.

---

## 2. Part I — defects (found while surveying, August 7, 2026)

These are not features. They are shipped claims that are false, and they are
first because they cost hours rather than days.

> **Both fixed August 7, 2026.** Resolution **(b)** for D1 — the key type widened
> rather than the claim narrowed — and the execution record is §2.3, including
> the prediction this plan got wrong about it.

### D1 — `handle.pairs()` silently drops non-string/number keys, and it is the documented remedy for that exact loss

`LIMITATIONS.md:317-319` offers the handle as the escape hatch needing no option:

> *"a handle from `get_global_ref` reads the real table in place, so boolean keys
> and colliding keys survive because nothing is converted."*

Driven against the addon on August 7, 2026:

```js
const lua = new lua_native.init({}, { libraries: 'all' });
lua.execute_script('t = {["\xFF"]=1, [true]=2, [3.5]=3, ["a"]=4}');
lua.get_global_ref('t').pairs();
// → [[3.5, 3], ["a", 4]]        the boolean key is not there
```

Colliding keys *do* survive, so half the sentence holds. The boolean key does
not come back — and `get(key)` / `has(key)` take `string | number`, so no other
method reaches it either. The value is still in the Lua table; nothing in the JS
API can observe it.

**Severity, argued rather than asserted.** This is `LIMITATIONS.md` §5's own
silent-loss class — *"a table key that is neither string nor number is
dropped"* — reappearing in the API §5 nominates as the way out of it. An
ordinary caller reading §5 and following its advice still loses the entry, and
loses it silently. By `CORRECTNESS.md` §15.5's definition that is a silent wrong
value reachable from plausible JavaScript.

**The narrower fault is a sentence, not a design.** `types.d.ts:464` declares
`pairs(): Array<[string | number, LuaValue]>`, so the drop is deliberate and
typed. What is false is `types.d.ts:461`'s *"Get all key-value pairs (like Lua
`pairs()`)"* and §5's escape-hatch paragraph. **Two resolutions, and the choice
is a design decision the plan does not pre-empt:**

- **(a) Narrow the claims.** `pairs()` documents that it yields string- and
  number-keyed entries only, and §5 stops offering it for the key classes it
  cannot deliver. Cheapest, and honest.
- **(b) Widen the key type.** `pairs()` yields boolean keys too (and §5's remedy
  becomes true as written). This is strictly better for the caller and is what
  T1 would want anyway — a `Map` can hold a boolean key, a JS object cannot.

**Do not ledger this.** `tools/README.md`: *never ledger an undocumented
defect* — while the loss is unspecified, ledgering launders a finding into a
feature. It becomes ledgerable when (a) or (b) ships.

### D2 — `pairs()`'s declared key type is wrong under `binaryStrings`

Same run, one option changed:

```js
const lua = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
lua.execute_script('t = {["\xFF"]=1, ["a"]=4}');
lua.get_global_ref('t').pairs();
// → [[Uint8Array[97], 4], [Uint8Array[195,191], 1]]
```

`LIMITATIONS.md:264` describes this correctly and treats it as the reason the
handle is the remedy for byte keys. `types.d.ts:464` never gained the union: the
declared key type is `string | number`, and a `Uint8Array` is neither. A
TypeScript caller in the mode this behaviour exists for is told something untrue
at the call site.

**Fix:** widen to `string | number | Uint8Array` and say which mode produces
which. Note that this interacts with D1's resolution (b) — do them together, one
signature change.

### 2.3 Execution record — D1 and D2, August 7, 2026

**Resolution (b) was taken: `pairs()` emits boolean keys, and `get`/`set`/`has`/
`get_ref` accept them.** The asymmetry §2's D1 warned about is what made (b) the
right call rather than a nice-to-have — a key the caller can see and cannot read
back would have been worse than the drop it replaced — so the two halves shipped
together.

**Where the drop actually was, which the plan did not know when it was written.**
`ProtectedTablePairsCollect` (`src/core/lua-runtime.cpp`) skipped every key that
was not `LUA_TSTRING` or `LUA_TNUMBER`, under the comment *"only string and
number keys survive the crossing"*. That sentence is true of a Lua table
converted to a JS **object**, where a key becomes a property name, and it was
inherited from that path. `TablePairs` has **exactly one caller** —
`handle.pairs()` — which emits `[key, value]` tuples and converts the key as a
*value*, so the constraint never applied here. This is the plan's §1 second
clause in its purest form: a mitigation scoped to a strict subset of what it
names, for a reason that stopped being true somewhere else.

| Change | Where |
|---|---|
| Emit boolean keys; skip only what no accessor can address | `ProtectedTablePairsCollect` |
| Convert a boolean key as a boolean — checked *before* the integer branch, since `lua_tonumber` would coerce `true` to `1` and alias a real integer key | `LuaRuntime::TablePairs` |
| `TableKey` gains `bool` (with the P0608R3 note on why `const char*` still selects `std::string`) | `lua-runtime.h`, `PushTableKey` |
| Accept a boolean key; four error messages restated | `NapiToTableKey` and its four callers |
| Key unions widened; `pairs()` documents exactly which keys it emits and which it skips | `types.d.ts`, `TABLE-REFERENCE.md` |
| §5's escape-hatch sentence corrected, with the half that was false recorded | `LIMITATIONS.md` |

**Prediction 2 (§8) was wrong, and in the useful direction.** It said (b) *"will
look like a one-line type change and will not be"*, and that if round-trip
symmetry proved unreachable the honest move was (a). Symmetry turned out to be
**four contained edits**: the variant, the push, the Napi conversion, and the
collect filter. The prediction correctly identified symmetry as the deciding
question and then guessed wrong about the answer — which is the good failure mode
for a prediction, since it forced the question to be asked before any code moved.

**Prediction 1 was not exercised.** It warned that a `tableAs` mode would find a
second conversion path nobody listed. Here the opposite held — `TablePairs` has a
single caller, and confirming that is what made the fix safe. That is evidence
about `pairs()`, **not** about T1: the object-conversion path, the Proxy traps
and `pairs()` are still three sites, and T1 has to touch all three.

**Behaviour change, stated because it is one.** A table with boolean keys now
yields more entries from `pairs()` than it did. `Object.fromEntries(h.pairs())`
will gain a `"true"` property where it previously silently had none. That is the
point of the fix, and it is the only caller-visible regression risk in it.

**Regression run** (§15.7, plus the conversion-change row): `build-debug`,
1129 TS tests, 285 C++ tests, `check-invariants` (one reviewed re-freeze:
`toThrow assertions examined 437 → 440`, bare positives still 0),
`roundtrip-matrix` 3800 cells / 0 undocumented / 0 parity disagreements across
all four modes, `lifecycle-matrix` 0 findings, `cross-context` 0 findings,
`oracle` 2678 cases / 0 disagreements.

**Ledgerable now.** `tools/README.md` forbids ledgering an undocumented defect;
with `pairs()`'s emission rule written on the public API, the remaining
table/function/userdata skip is specified behaviour rather than a laundered
finding.

---

## 3. Part II — fidelity: tightening the limitations

### T1 — a `Map` representation for Lua→JS tables *(the substantial one)*

**Derivation.** `LIMITATIONS.md` §5's table has seven rows; **four are Lua→JS key
losses** and three of those are silent. Today there are exactly two answers, and
D1 has just shown the second one leaks:

| Answer | What it does | Limit |
|---|---|---|
| `strictConversion: true` | refuses the crossing | the data still cannot cross |
| a handle + `pairs()` | reads in place | drops boolean keys (D1); materializes an array |

**Proposal.** A context option — `tableAs: 'object' | 'map'` — making a Lua table
arrive as a `Map` instead of a plain object. A `Map` holds `1` and `"1"` as
distinct keys, holds `true`, and holds a `Uint8Array` key under `binaryStrings`.
Three of §5's four Lua→JS rows stop being losses; they become *representations*.

**Why this shape and not another.** It is all-or-nothing per context, which is
the rule §2 and §5 both state and both give the same reason for: a return type
that depends on the *data* is the defect class these reviews kept finding.
`tableAs` depends only on the option, exactly as `binaryStrings` does.

**The composition is the point.** `tableAs: 'map'` + `binaryStrings: true` would
be the first configuration of this binding with **no silent loss and no refusal
in either direction** — the JS→Lua rows are already covered by
`strictConversion`, and the Lua→JS rows would be represented rather than
refused. Neither wasmoon nor fengari offers anything of the kind.

**What it does not fix.** The JS→Lua rows (§5's first two) are unaffected — a
`Map` going *in* is already handled by the built-in conversions. And the
`BigInt` row stays as it is; a visible type change is not what this is for.

**Trigger cost (§15.6).** A new option that changes *conversion* is a
`roundtrip-matrix` **mode** (Axis C), not a `capability-matrix` config — the
distinction W1 had to draw. The mode must carry a **vacuity control proving the
option is in effect** before its cells count; a silently-ignored `tableAs` would
round-trip everything and report a clean column that searched nothing (CR-23 F4).
Expect the instrument work to be comparable to the feature.

### T1 execution record — August 7, 2026

**Prediction 1 was right about the shape and wrong about the layer, and the
difference is the whole story.** It warned that a `tableAs` mode honoured by
`CoreToNapi` but not by the Proxy traps or `pairs()` would be this tree's most
repeated defect. The real problem was worse and one level down: **`LuaTable` is
`std::unordered_map<std::string, LuaPtr>`**, so by the time *any* binding-layer
renderer sees a table, the number key `1` and the string key `"1"` have already
merged and a boolean key is already gone. Rendering a `Map` from that would have
produced a faithful-looking container full of data that was already lossy —
the worst outcome available for an option whose only purpose is fidelity.

**So the option was moved to where the loss happens.** Under `tableAs: 'map'`
the *core* keeps a plain table by reference — the branch metatabled tables
always used — and the binding materializes the Map by walking the real table
with `TablePairs`, whose keys are typed (D1) and byte-exact under `binaryStrings`
(shared with T4's `keys()`). **`LuaValue::Variant` is unchanged**, and the three
preceding items did most of the work. The generalizable lesson, now in
`LIMITATIONS.md` §5: *a fidelity option has to be applied where the fidelity is
lost, which is not always where the value is rendered.*

**A third defect, found by driving the round trip rather than by reading §5:**
a JS `Map`'s keys are **stringified crossing into Lua**, so `1` and `"1"`
collide there too and `true` becomes `"true"`. §5's JS→Lua rows had no entry for
it — it was missed because `Map` was assumed to *be* the answer to the outbound
losses, so nobody asked about its own keys inbound. §5 has the row now, and the
mode fixes that direction too (a real Lua table built with `SetTableFieldKeyed`,
which takes typed keys since D1). The default is untouched: "keys are
stringified, matching plain-object behaviour" is documented.

**Two aborts, one crash and one caught by the machine.** The depth guard first
threw `std::runtime_error` from `TableRefToMap`; a four-line self-referencing
table terminated the process — CR-6 F1, reachable from ordinary JavaScript,
because the *outbound* conversion path has no handler above it (~40 call sites,
most not inside a `try`). Fixed by raising `Napi::Error` directly. Then
`check-invariants` scored both new functions **UNGUARDED_AND_PROPAGATES** for
their *core* calls — the same hazard on the same path for an OOM under
`maxMemory` rather than for a deep table — which the crash had not revealed and
no test had asked about. Both are `GUARDED` now. **The invariant found the
second one; the test found the first; neither would have found both.**

**The shared canonicalizer bit again, exactly as `tools/README.md` warns.** The
new column needed `canon` to understand a `Map`. The comment written beside that
change claimed it could not affect the other harnesses — "they never set
`tableAs`" — and the next run reported **19 STALE ledger entries** in the four
pre-existing modes. True of their *outputs*, irrelevant, because the corpus
contains a JS Map as an **input value**, whose canonicalization changed in every
mode. The comment now records the mistake, and the rule gains a clause: *check
who else imports it, and then check the corpus too.*

**What those 19 stale entries turned out to mean is the nicer half.**
`builtin:Map` had been ledgered as a one-way conversion in all four text modes —
on the strength of a canonicalization that rendered every JS Map as `{}`,
because a Map has no own enumerable properties. It round-trips by content and
always did; the ledger was covering the instrument's blind spot rather than the
binding's behaviour. The entry is now a "the loss stops here" row, the second of
its kind.

**Ledger written, 133 cells, in three groups**, none of which launders a loss:
the five built-ins that are one-way by specification in this mode as in every
other; `builtin:Map`, which round-trips container and all and therefore has *no*
entry here; and `obj:numeric-keys` / `obj:key-collision`, which are **not a
loss at all** — a JS object key is always a string, `canon` renders the input
through a numeric-key heuristic that exists for the oracle's Lua-produced
values, and this mode reports the string key that actually crossed. Driven both
ways before ledgering: the Lua-side keys are strings in *both* modes, so nothing
about the crossing differs — only what the instrument prints.

**Regression run:** 1180 TS tests (13 new), 285 C++ tests, `check-invariants`
after a reviewed re-freeze, and **all ten harnesses clean** —
`roundtrip-matrix` 4750 cells across 5 modes / 0 undocumented / 0 stale / 0
parity disagreements, `oracle` 2678 / 0, `exec-parity` 6695 / 0,
`capability-matrix` 0, `exception-matrix` 507 clean, `lifecycle-matrix` 0,
`cross-context` 0, `binding-balance` 0.

### T2 — one switch for the filesystem, not three

**Derivation, and it is the W1 shape exactly.** `LIMITATIONS.md` §1 names the
file doors that make `'safe'` unsuitable for untrusted code: `dofile`,
`loadfile`, `require`'s two search paths, and `load(string.dump(f))`. The
mitigations cover them unevenly:

| Door | `set_file_reader` | `add_searcher` | `allowBytecode: false` |
|---|---|---|---|
| `dofile` / `loadfile` | ✅ | — | text-only |
| `require` (path searchers) | ❌ (`types.d.ts`: *"`require` is unaffected"*) | ✅ | text-only |
| `package.path` writable under `'safe'` | — | — | — |

So "this context cannot touch the disk" currently takes two calls plus a caveat,
and the caller has to know which door needs which. `allowBytecode` had this same
asymmetry and it was a defect (W1: the guard was five doors short of its own
claim).

**Proposal.** A single policy — an option or a method — under which *every* file
door resolves through the host or refuses, `require` included. `'sandbox'`
already proves the pieces work (§8's `io.read` synthesis and §1's cleared
globals); this is coherence, not new mechanism.

**Trigger cost.** A capability option → a `capability-matrix` **config** (Axis A),
which already ranges over the bytecode-guard doors and would range over these.

### T2 execution record — August 7, 2026

**Prediction 3 (§8) was right, and it understated the case.** It said the door
table above would be short and the list should be derived from the source. It
was short by **four**, and the two that mattered most are not `.lua` doors at
all:

```
package.loadlib("/usr/lib/libSystem.B.dylib", "*")   ->  true   (under 'safe')
```

`package.loadlib` links an **arbitrary native library** into the process, and
`package.searchers[3]`/`[4]` reach the same loader through `require`.
`package.searchpath` probes the filesystem for existence. `LIMITATIONS.md` §1's
*"Bounded honestly"* paragraph claimed the worst case was executing a readable
`.lua` file, on the grounds that a target "must parse as Lua" — true of
`loadfile`, and irrelevant to a `.dylib`. **That is a shipped bound that driving
disproved**, the same defect class as D1, and §1 now states the real one.

**Shipped: `filesystem: 'allow' | 'deny'`**, closing nine doors across four
libraries in one option — `dofile`, `loadfile`, `searchers[2]/[3]/[4]`,
`loadlib`, `searchpath`, and `io`/`os`'s file functions where those libraries
are loaded. `require` keeps working for `register_module` and `add_searcher`,
which is **the configuration that had no expression before**: `'safe'` reaches
the disk, `'sandbox'` has no `require` at all.

**Three design rulings, each of which the instruments forced:**

- **Each door refuses in its own idiom.** The first draft raised from all nine.
  `capability-matrix` reported a **HARNESS FAULT** on `lua:loadfile` — the door
  returned neither LOADED nor REFUSED, because it had thrown where the real
  `loadfile` returns `nil, msg`. The dirt was in the subject. `loadfile`,
  `io.open`, `os.remove`, `os.rename`, `loadlib` and `searchpath` now return
  `nil, message`; `dofile`, `io.lines`, `io.input`, `io.output` and `os.tmpname`
  raise — matching what each real function does on failure, so a script that
  already handles a missing file keeps working.
- **`add_search_path` refuses.** `capability-matrix` scored it
  **ACCEPT-AND-RETAIN** the moment the config existed: with the path searchers
  denied, a search path can never be consulted, so appending one to
  `package.path` is the accept-and-do-nothing that `LIMITATIONS.md` §8 forbids.
  It now throws and names the two doors that do still work. **This is the real
  product finding of T2**, and no test would have asked the question — the
  config did.
- **The option governs Lua, not the host.** `execute_file`, `compile_file` and a
  `set_file_reader` handler keep working; a reader re-opens `dofile`/`loadfile`
  backed by the *host*, never by the disk (driven both ways). Process execution
  (`os.execute`, `io.popen`) is untouched and documented as such — it is not
  filesystem access, and pretending otherwise would be a bound that rots.

**One harness model gap, fixed rather than worked around.** The bytecode-door
axis treated any refusal as the bytecode guard's doing, so four doors reported
`BYTECODE DOOR CLOSED WITHOUT CAUSE` under the new configs. A door closed by a
*different* policy is `ABSENT`, not "closed without cause" — preconditions now
receive the config and the file-based doors ask whether the filesystem is
reachable at all. The host-side doors are deliberately not in that list, which
is the same distinction the option itself draws.

**And the config's own control caught the idiom change**, which is the vacuity
rule paying: `all+nofs` first asserted `pcall(package.loadlib, ...) == false`,
which stopped being true when `loadlib` began returning `nil` instead of
raising. The run **refused to count the config's cells** rather than scoring
them against a claim nobody had rechecked.

**What the census did on its own:** `surface-census` scored
`option: filesystem → COVERED: capability-matrix:all+nofs, safe+nofs` without
being told. Had the option shipped without configs it would have reported
`UNCLASSIFIED` and turned the suite red — §15.6's fail-closed row working
forwards, the second time in this plan.

**Regression run:** 1167 TS tests (21 new), 285 C++ tests, `check-invariants`
after a reviewed re-freeze (six drifts; `D. Lua C frames in core` 27 → 30 while
**host-callable frames stayed at 13**, so the three new frames need no
`exception-matrix` row), `capability-matrix` 251 cells / 10 configs / 0 findings,
`exception-matrix` 507 cells clean, `exec-parity` 6695 cells / 0 disagreements,
`roundtrip-matrix` 3800 cells / 0 disagreements.

### T3 — chunk names on `execute_script`

**Derivation.** `CompileOptions` carries `chunkName` (`types.d.ts:222-227`);
`execute_script` (`types.d.ts:715`) takes a bare string and nothing else. Every
runtime error from a script run through the ordinary door therefore reads
`[string "..."]`, and an embedder running user-authored scripts by name has to
route through `compile()` + `load_bytecode()` to get a usable message.

**Proposal.** An options argument on `execute_script` (and `execute_async` /
`execute_script_async` for parity — a door that differs from its siblings is the
`INTEROP-PARITY-PLAN` defect class).

**Trigger cost.** Not a new door; an existing door gaining an option. It is
*execution-visible*, so `exec-parity` must agree across doors — a small addition,
since the corpus exists.

### T3 execution record — August 7, 2026

**Shipped on six doors, not three.** The plan named `execute_script`,
`execute_script_async` and `execute_async`. Driving the source-loading surface
found two more that take Lua source and load it — `execute_script_in` and
`create_coroutine(body)` — plus `compile`, which already had the option. Leaving
either out would have recreated the sibling asymmetry the item exists to fix, and
they share the same three core methods, so the marginal cost was one argument
each. The enumeration is *every call site of `luaL_loadbuffer` reachable from a
door that takes a JS string*, which is four in the core: `ExecuteScript`,
`ExecuteScriptInEnvironment`, `CreateCoroutineFromScript` and `CompileScript`.

| Door | Core method | Options at |
|---|---|---|
| `execute_script` | `ExecuteScript` | arg 1 |
| `execute_script_async` | `ExecuteScript` (on the worker) | arg 1 |
| `execute_async` | `CreateCoroutineFromScript` | arg 1 |
| `execute_script_in` | `ExecuteScriptInEnvironment` | arg 2 |
| `create_coroutine` | `ExecuteScript` | arg 1 |
| `compile` | `CompileScript` | arg 1 *(already had it)* |

**The default is bit-identical to the old behaviour**: an empty chunk name means
"use the source itself", which is what `luaL_loadstring` does and what every
caller got before.

**Two things found while building, neither predicted:**

- **`compile()` was reading `chunkName` leniently** — a non-string was silently
  ignored and the caller got the default name back. For an option whose entire
  purpose is a legible error message, failing silently is the CR-23 F4 failure
  (`strictConversion: 'yes'` quietly meaning off). All six doors now share
  `ParseChunkName`, which **refuses** a non-string and a non-object options bag.
  That is a small behaviour change to `compile()`, made deliberately.
- **`execute_script_async` had no `CallScope`, and now needs one.** Reading
  `{ chunkName }` off a caller's object can run an accessor — user JS — and this
  door previously read nothing off a caller's object at all. The read is placed
  **before `is_busy_` is set**, so a throwing getter leaves the context idle
  rather than wedged busy with no worker queued to clear it. There is a test for
  exactly that. `check-invariants` caught the consequence on the next run:
  `callscope-classification` gained `ParseChunkName: NO_SCOPE` and
  `LuaContext::ExecuteScriptAsync: SCOPE_NO_USER_JS`, both reviewed, and the
  header's list of helpers whose user JS counts as their caller's now names
  `ParseChunkName` and says why it is inert.

**Regression run:** 1138 TS tests (10 new), 285 C++ tests, `check-invariants`
after a reviewed re-freeze (three drifts, all explained above),
`exec-parity` 6695 cells / 0 disagreements, `roundtrip-matrix` 3800 cells / 0
disagreements, `capability-matrix` 0 findings, `oracle` 2678 cases / 0
disagreements, `exception-matrix` 507 cells clean.

### T4 — lazy table iteration

**Derivation.** `pairs()` and `ipairs()` return `Array`s (`types.d.ts:464,471`),
so iterating a large table materializes every entry before the first is read.
`crossing-cost`'s C9 cell puts a Proxy read at **212x** a plain object read, so
the per-entry price of that materialization is a measured quantity rather than an
assumption.

**Proposal.** `Symbol.iterator` on `LuaTableHandle` (and lazy `keys()`), so
`for (const [k, v] of handle)` streams. Coroutines already carry both iterator
protocols; handles carry neither.

**Trigger cost.** Lowest of the four. No new value crossing, no new option.

### T4 execution record — August 7, 2026

**The constraint the plan did not know about, and it decided the design.**
`pairs()` snapshots its traversal for a documented reason: converting a value
allocates, an allocation can drive a GC step, and a `__gc` finalizer can add a
key to the very table under a live `lua_next` cursor. CR-15 F2 drove exactly
that — a 200-entry table yielding **2682** entries. A "lazy iterator" in the
obvious sense — a cursor held open across `next()` — would hand that same
undefined behaviour to any caller who touched the table mid-loop, through a
window far wider than a finalizer: *arbitrary JS runs between every two steps of
a `for...of`.*

**So the split is: eager keys, lazy values.** `TableKeys` snapshots the key set
up front (no cursor outlives the traversal) and each step does an independent
**raw** read — raw so the cursor reports what `pairs()` reports rather than what
an `__index` metamethod would answer. The expensive half is the lazy one: a
value conversion is what mints handles and runs registered converters, and a key
is a string, number or boolean by construction.

**The laziness is measured, not asserted.** A from-Lua converter fires once per
value converted, so its call count *is* the laziness — on a 200-entry table of
tables:

| Call | Value conversions |
|---|---|
| `pairs()` | 200 |
| `for...of`, `break` after 1 | **1** |
| `for...of`, `break` after 10 | **10** |
| `keys()` | **0** |

**Shipped:** `handle[Symbol.iterator]()`, `handle.keys()`, and in the core
`TableKeys` + `RawGetTableFieldKeyed`. The key→`LuaValue` conversion that
`TablePairs` and `TableKeys` both need was factored into one `KeyAtTop` rather
than copied — a key-type rule split across two sites is §15.3's defect shape,
and D1 had just widened that rule.

**Documented contract**, because a snapshot/live split is observable: a key added
after iteration begins is not visited; a key deleted before its turn is skipped
rather than yielded as nil; a replaced value yields the new one; releasing the
handle mid-loop ends iteration; `reset()` mid-loop makes the next step throw
rather than read the retired state. Each call mints an independent cursor.

**What the invariants said, all of it expected and all of it read:**

- `lua-next-sites` gained `ProtectedTableKeysCollect: NOT_EXPOSED` — the
  mechanism working as designed ("a new raw-`lua_next` loop shows up as a new
  row rather than as a line somebody has to remember to add"). It inherits
  `ProtectedTablePairsCollect`'s ruling, being structurally identical and doing
  strictly less.
- `core-call-guarding` gained three binding→core edges, all **GUARDED**;
  `callscope-classification` gained three functions, all **SCOPE_FIRST**.
- `surface-census` counted a 27th Lua C frame in core, while **host-callable
  frames stayed at 13** — the new frame calls nothing back into the host, so it
  needs no `exception-matrix` row.

**One coverage boundary, ruled on rather than left implicit.** The cursor state
holds a `Napi::ObjectReference` to the handle — a member that retains a JS
value, which §15.6 routes to `binding-balance`. Census F cannot see it: its
universe is `src/lua-native.h`, and cursor states live in the `.cpp`. That
boundary **predates this work** (`LuaCoroIterState::coro` is the same shape) and
T4 adds its second member. Driven rather than assumed: 200 abandoned mid-loop
cursors plus 200 drained ones, under forced GC, leave every `info().bindingRefs`
counter unchanged — the state is owned by Externals rooted on the iterator
object, so it dies with it. Extending census F over the `.cpp` is a real item and
is **not** smuggled into T4; it is recorded here as the next thing that would
close this gap.

> **Closed August 7, 2026**, as its own item rather than inside T4. Census F now
> ranges over both translation units, and doing that immediately exposed a
> second defect in the census itself: its rule was *"an indented declaration"*,
> which means a struct field in a header and a **function local** in a
> translation unit. Four locals (`sub`, `entry`, `acc`, `accessors`) were scored
> before the rule was corrected to *"a field of a struct or class"*, which is
> what "member" always meant. Universe 25 → 28; the three real members
> (`coro`, `handle`, `self`) carry ledger entries in
> `binding-balance/policy.mjs` with the driven evidence.

**Regression run:** 1149 TS tests (11 new), 285 C++ tests, `check-invariants`
after a reviewed re-freeze (six drifts, all above), `roundtrip-matrix` 3800 cells
/ 0 disagreements, `lifecycle-matrix` 0 findings, `cross-context` 0 findings,
`binding-balance` 0 findings, `gc-stress` balanced (registry high-water flat at
67 over 12 rounds).

---

## 4. Part III — reach: capability gaps against comparable bridges

### R1 — debug introspection from JavaScript *(the one worth building)*

`set_hook` delivers `(event, line, name)` and nothing else. That is enough for a
profiler — `crossing-cost` C3/C10 measure exactly that path — and not enough for
a debugger: no breakpoint UI can show a variable's value. fengari exposes the
whole C API and gets this by construction; mlua and sol2 expose the `lua_Debug`
surface directly.

**Proposal, scoped so it does not become §7.** A read-only introspection
surface over `lua_getstack` / `lua_getinfo` / `lua_getlocal` — `get_stack()`,
`get_locals(level)` — callable from inside a hook. **This is not the raw C API
(`LIMITATIONS.md` §7) and must not become it**: no stack manipulation, no
pushing, no `lua_State` handed to JS. The two-layer split holds.

**Trigger cost, and it is the largest here.** New entry points that take JS
values → `roundtrip-matrix` doors. Called from inside a Lua C frame → an
`exception-matrix` Axis B frame. Reading frame state while a hook is on the stack
touches the occupancy model — check `RejectIfOccupied`'s policy set before
designing.

### R1 execution record — August 7, 2026

**Shipped: `get_stack()` and `get_locals(level)`**, read-only, scoped exactly as
§4 required — `lua_getstack` / `lua_getinfo` / `lua_getlocal` and nothing else.
No stack manipulation, no pushing, no `lua_State` handed to JavaScript, so
`LIMITATIONS.md` §7 stays true rather than being quietly eroded.

**What it buys, demonstrated rather than described.** From inside a `line` hook,
stopping at line 3 of a named chunk:

```
frame  : work.lua:3
locals : [ { name: 'n', value: 5 }, { name: 'doubled', value: 10 } ]
```

`tag`, declared on the line that has not run yet, is correctly absent. That is a
breakpoint view — the thing `set_hook` alone could not provide, and the stated
difference between a profiler and a debugger. It composes with T3: `shortSource`
reads `work.lua` because the chunk was named, and would otherwise read
`[string "local function f(n)..."]`.

**Prediction 4 was wrong, and pleasantly.** It expected the occupancy model to
be the sharp edge — a new policy, the generative `assert` firing. Neither
happened, because the model already draws the line in the right place:
`RejectIfBusy` marks a **worker-thread** run, where the state belongs to another
thread and reading its stack would be a data race, while a hook callback on the
main thread is not busy in that sense and Lua has already disabled the hook for
its duration. No new policy was needed, and the existing one refuses exactly the
case that must be refused (there is a test for it).

**Three design rulings worth keeping:**

- **An absent frame is a `RangeError`, not an empty array.** "No such frame" and
  "a frame with no named locals" are different answers, and a debugger UI has to
  tell them apart.
- **Compiler temporaries are skipped.** Lua names them in parentheses
  (`(temporary)`, `(for state)`); they are bookkeeping, not the caller's
  variables, and every consumer would filter them anyway.
- **An empty stack outside execution is the honest answer**, not an error —
  "is Lua running right now" is precisely what a caller asking for a stack wants
  to learn.

**Both new functions were caught by the invariants before any test was written.**
`callscope-classification` scored `GetStack` **NO_SCOPE**: it reads `maxLevels`
off a caller's options object, which can be an accessor, which can `reset()` the
context out from under the stack walk (CR-13 F1). Now `SCOPE_FIRST`, like its
sibling. And `assertion-strength` refused a **bare `.toThrow()`** in the
worker-busy test I had just written — the CR-20 F5 mechanism catching its author
rather than a stranger. `surface-census` reported **0 UNCLASSIFIED** across every
category: neither entry point takes a convertible JS value, so no
`roundtrip-matrix` door is owed, and neither adds a Lua C frame, so no
`exception-matrix` row is owed either. The trigger table decided that, not me.

**Regression run:** 1186 TS tests (6 new), 285 C++ tests, `check-invariants`
after a reviewed re-freeze, and **all ten harnesses clean**.

### R2 — Lua version and ecosystem reach *(a missing `LIMITATIONS.md` entry)*

This binding is **Lua 5.5 only**. wasmoon ships 5.4, fengari 5.3/5.4, and the
overwhelming majority of published Lua code and LuaRocks modules target 5.1–5.4.
A user arriving with an existing Lua codebase may find it does not run.

**`LIMITATIONS.md` has no entry for this at all**, which makes it the document's
blind spot rather than a decision anyone recorded — the state `CORRECTNESS.md`
§15.10 calls *worse than uncovered*. **The first deliverable is therefore a
`LIMITATIONS.md` section, not code**: what 5.5 changes for a 5.1/5.4 script,
which incompatibilities an embedder will actually hit, and whether supporting an
older Lua is refused or merely unbuilt. A version bump is already a `diff-oracle`
trigger (§15.6), so the instrument side is understood; the scope decision is the
owner's.

### R2 execution record — August 7, 2026

**Shipped as `LIMITATIONS.md` §9**, and it is a documentation deliverable by
design: the constraint is real, nothing about it is going to be fixed, and the
thing an embedder needs is to learn it before porting rather than during.

Written to §9's own standard — *every claim driven, not inferred*. The entry
carries what `info()` actually reports (`Lua 5.5`, release `Lua 5.5.0`, 505) and
a table of what a 5.1-era script hits, each row probed against the running
addon rather than recalled: `setfenv`, `getfenv`, `unpack`, `loadstring`,
`module`, `math.pow`, `math.mod`, `table.getn`, `bit32` and `math.atan2` are all
`nil`; `table.unpack`, `table.move`, `goto`, `<const>`, `<close>`,
`coroutine.close` and `warn` are present.

**The part worth having is not the removal list.** A 5.1 script that calls
`setfenv` fails at the first call, loudly — that is the *good* case. The entry
leads instead with the quiet one: the 5.3 integer/float split, where pre-5.3
code that assumed a single number type produces subtly different values rather
than an error, and where that difference reaches JavaScript as §5's BigInt row.

**Ruled not planned, with the reason stated as scope rather than difficulty:** a
second Lua means a second `liblua.a`, a version axis on every instrument that
asserts VM behaviour, and a `diff-oracle` that currently compares against *the*
stock interpreter from the same vcpkg port. A version *bump* is already a
trigger (§15.6); a version *choice* would be a standing axis.

### R3 — no browser / WASM target

wasmoon's entire premise. A native N-API addon runs in Node and in an Electron
process with Node integration; it cannot run in a browser or a renderer without
Node. Almost certainly out of scope — recorded because it is the single largest
capability difference in this field and someone will ask. It is **not** a
platform-support question in `CORRECTNESS.md` §14's sense; §14 is about which
OS/arch the addon is built for, and nothing here reopens it.

### R4 — mutable / zero-copy byte buffers

`binaryStrings` copies in both directions, and Lua strings are immutable and
interned, so a binary workload pays a copy per crossing in each direction. The
LuaJIT-FFI stacks people compare against mutate buffers in place.

**Proposal, if a concrete need appears.** A userdata-backed buffer over a JS
`Buffer` — `__index` / `__newindex` / `__len` — giving in-place mutation without
a crossing per byte. `set_userdata`'s method binding is most of the mechanism.
Filed last deliberately: it is the only item here with no driven repro and no
user behind it, and `docs/README.md`'s bar says work starts from a concrete need.

### R3 and R4 — decisions recorded, August 7, 2026

§7 asks these two for *a decision*, not an implementation, and here they are so
neither regenerates as an open question (§14's lesson about the word
*deferred*).

**R3 (browser / WASM): not planned.** A native N-API addon cannot follow
wasmoon there, and the alternative is a second implementation rather than a
port — a WASM build of Lua plus a JS-side binding layer, which would share this
project's tests and none of its code. Recorded as a capability difference in the
field, not as a gap in this binding. It is **not** a `CORRECTNESS.md` §14
question: §14 is about which OS/arch the addon is built for, and this is about
whether there is an addon at all.

**R4 (mutable / zero-copy byte buffers): not planned, and waiting on a need
rather than on a decision.** It remains the only item in this plan with no
driven repro and no user behind it, which is precisely the thing
`docs/README.md`'s bar excludes: *work starts from a concrete need*. The shape
is understood if one arrives — a userdata-backed buffer over a JS `Buffer` with
`__index` / `__newindex` / `__len`, for which `set_userdata`'s method binding is
most of the mechanism — and `binaryStrings` already closes the correctness half
of the problem, leaving only the copy. Filing it as "not planned" is therefore a
statement about evidence, not about value.

---

## 5. Order of work

Effort figures are a forecast dated August 7, 2026, and are expected to rot
(`PERFORMANCE-PLAN` §0's rule).

| # | Item | Why this order | Rough |
|---|---|---|---|
| 1 | ✅ **D1 + D2** — done August 7, 2026 (§2.3) | Shipped claims that are false, one signature between them. Nothing below depends on them, and leaving them costs a user silently. | ~1 hour |
| 2 | ✅ **T3** — done August 7, 2026 (§3, T3 execution record) | Smallest real feature; makes every error message from the main door usable. | half a day |
| 3 | ✅ **T4** — done August 7, 2026 (§3, T4 execution record) | No new crossing, no new option, immediate ergonomics. | half a day |
| 4 | ✅ **T2** — done August 7, 2026 (§3, T2 execution record) | Coherence over new mechanism; `capability-matrix` already has the axis. | 1–2 days |
| 5 | ✅ **T1** — done August 7, 2026 (§3, T1 execution record) | The one that changes what the library can claim. Do it after D1 settles the key-type question, since a `Map` mode wants the widened keys anyway. | 2–3 days incl. the mode + its vacuity control |
| 6 | ✅ **R2's documentation half** — done August 7, 2026 (§4, R2 execution record) | A `LIMITATIONS.md` entry, not code. Independent of everything above. | half a day |
| 7 | ✅ **R1** — done August 7, 2026 (§4, R1 execution record) | Largest trigger cost; worth its own decision after 1–5 land. | 3–5 days |

R3 and R4 are not sequenced: both are ruled **not planned** above (§4), which is what §7 asks of them.

---

## 6. What this plan deliberately does not do

Listed so the enumeration in §1 is falsifiable, and so no future pass re-derives
a closed question — the failure `CORRECTNESS.md` §14 exists to prevent.

- **No worker pool / true parallelism.** `LIMITATIONS.md` §4: a scope decision.
  Userland can build N contexts plus a scheduler over `execute_script_async`.
- **No `js.*` reflection inside Lua.** §6. An allowlist is the entire basis of
  the sandboxing story; `'sandbox'`, `maxMemory`, `maxInstructions` and
  `allowBytecode` all become meaningless with `js.global` in scope.
- **No raw Lua C API.** §7, and R1 is explicitly scoped to stay on this side of
  it.
- **No state snapshot / persistence.** §3, and neither wasmoon nor fengari offers
  it — a differentiator to consider some day, not a gap.
- **Nothing about platform coverage or CI.** §14 is binding and this document
  does not touch it. R3 is a runtime-target observation, not a build-target one.
- **No optimization work.** `crossing-cost` measures; acting on a measurement is
  a separate decision with its own scope (`PERFORMANCE-PLAN` §10).

---

## 7. Closing condition

Checkable rather than felt, which is the bar `docs/README.md` sets for a plan
document and the reason `CORRECTNESS.md` §15.10 exists in the operating manual
rather than in a plan.

> **The fidelity half is done when all four hold:**
>
> 1. **No claim in `LIMITATIONS.md`, `FEATURES.md` or `types.d.ts` about key
>    handling is falsifiable by driving the addon** — D1 and D2 were both found
>    by doing exactly that, so the check is the method that found them, re-run.
> 2. Every §5 Lua→JS loss row is **represented, refused, or documented as
>    unreachable** — no row is left with a mitigation that covers a subset of
>    what it names (T1, and the D1 resolution).
> 3. Every file door in §1 answers to **one** policy (T2), and
>    `capability-matrix` has a config that proves it.
> 4. Each shipped option added by this plan carries a `roundtrip-matrix` mode or
>    a `capability-matrix` config **with a vacuity control that fails when the
>    option is disconnected** — demonstrated failing, not assumed.

> **The reach half is done when:** R1 has either shipped or been refused in
> writing with its reason, and R2 has a `LIMITATIONS.md` entry stating the Lua
> 5.5 constraint and what it costs an embedder. R3 and R4 need no resolution to
> close this plan — they need a *decision recorded*, which "not planned" satisfies.

---

### Status — August 7, 2026, after D1, D2, T1–T4 and R1–R4

Every item in this plan is executed. Checked rather than felt:

| # | Clause | State |
|---|---|---|
| F1 | No claim about key handling falsifiable by driving the addon | ✅ met — D1, D2 and the §5 Map row were all found this way and all fixed; the method that found them is the check |
| F2 | Every §5 Lua→JS loss row represented, refused, or documented unreachable | ✅ met — three represented by `tableAs: 'map'`, all refusable under `strictConversion`, and the JS→Lua Map row added and fixed |
| F3 | Every §1 file door answers to one policy, with a `capability-matrix` config proving it | ✅ met — `filesystem: 'deny'`, nine doors, two configs |
| F4 | Each shipped option carries a mode or config **with a vacuity control demonstrated failing** | ✅ met — `tableAs` is a `roundtrip-matrix` mode, `filesystem` two `capability-matrix` configs, and both controls were seen refusing to count cells |
| R | R1 shipped or refused in writing; R2 documented; R3/R4 decided | ✅ met — R1 shipped, R2 is `LIMITATIONS.md` §9, R3 and R4 ruled not planned with reasons |

**The plan is closed.** What survives as instruction has moved to where it
executes: the options and their guards are in `types.d.ts` and the README, the
new rows and bounds are in `LIMITATIONS.md` §1/§5/§9, and every check added
here runs in `check-invariants`, `roundtrip-matrix` or `capability-matrix`
rather than in this document. Per `docs/README.md` rule 2 this file now belongs
in `reviews/`.

**What the whole plan is evidence for, stated once.** Nine of its findings were
produced by *driving the shipped addon and reading what came back* — not by
reading the source, and not by re-running the instruments, which found nothing
new by themselves. But six defects were caught by the machinery *while the work
was being done*: two `UNGUARDED_AND_PROPAGATES` scores, a `NO_SCOPE`, a bare
`.toThrow()`, an ACCEPT-AND-RETAIN, and a HARNESS FAULT. Neither habit
substitutes for the other. The instruments cannot ask whether a documented
sentence is true; driving cannot tell you that an OOM path aborts.

---

## 8. Predicted failure modes

Dated August 7, 2026, so execution can score them the way `PERFORMANCE-PLAN` §12
was scored. The point is not to be right; it is that being wrong is visible.

1. **T1 will surface a second table-conversion path nobody listed.** The
   Lua→JS conversion happens at `CoreToNapi` *and* through the Proxy traps for
   metatabled tables *and* through `handle.pairs()`. A `tableAs` mode honoured by
   one and not the others is this codebase's most repeated defect shape — CR-17
   fixed one of four markers, CR-21 covered two of four builtins, CR-22 fixed one
   and a fifth appeared. **Enumerate the conversion sites from the source before
   writing the option**, not after.
2. **D1's resolution (b) will look like a one-line type change and will not
   be.** Widening `pairs()` to boolean keys means the key must survive
   `NapiToCore` on the way back in for `get`/`set`/`has` to be symmetric, and
   asymmetric key support would be a worse limitation than the current honest
   one. If that turns out to be the case, take (a) and say so.
3. **T2 will find at least one file door the table in §3 does not list.** That
   table was built by reading `LIMITATIONS.md` §1, and §1's own door list has
   been corrected once already (August 6, 2026, the `"bt"` mode correction).
   Derive the doors from the source, and expect the count to be wrong here.
4. **R1's occupancy interaction is the sharp edge, not the C API surface.**
   Reading frame state from inside a hook means calling into the binding while
   the VM is mid-execution — which is the re-entrancy class closed *structurally*
   by one guard and one policy set (`CORRECTNESS.md` §15.2). The generative
   `assert` in `RejectIfOccupied` will fire on a new policy; that is the
   mechanism working, not an obstacle to route around.
5. **The smallest item will not be the fastest.** D1+D2 are estimated at an hour
   and touch `types.d.ts`, `LIMITATIONS.md` §5, and possibly the binding. Every
   estimate in this table is a forecast made before reading the implementation.

**Scored, August 7, 2026** — the four above are ruled in their execution records
(1 not exercised and its evidence explicitly withheld from T1, 2 wrong in the
useful direction, 3 right and understated, 4 wrong and pleasantly). **5 was
right.** D1+D2's code was about an hour, and the item still pulled in
`types.d.ts`, `LIMITATIONS.md` §5, `TABLE-REFERENCE.md`, three new tests and an
invariant re-freeze — the ratio of code to everything-around-code was the
highest of the seven, which is what the prediction was about.

---

## 9. When this plan is done

It moves to [`reviews/`](reviews/) with a superseded banner naming what replaced
it, per `docs/README.md` rule 2 — as `INTEROP-PARITY-PLAN`, `UNSEARCHED-REGIONS-PLAN`
and `PERFORMANCE-PLAN` all did, each on the day it was executed. Anything in it
that survives as an *instruction* rather than as a record moves into
`CORRECTNESS.md` or `LIMITATIONS.md` first; a plan document is not a place to
leave live guidance, which is the lesson §15.10 was moved to encode.
