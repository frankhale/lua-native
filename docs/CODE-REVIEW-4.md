# CODE-REVIEW-4

**Date:** July 15, 2026
**Scope:** Fourth pass. Primary target: the CODE-REVIEW-3 remediation commit
(`d031eea`) — every one of its fixes adversarially re-verified against the
tree, with particular attention to new defects the fixes themselves may have
introduced (the pattern both prior verification passes found). Secondary
target: a fresh sweep of the three build/test scripts no earlier pass reviewed
(`get_vcpkg_path.js`, `run-tests.js`, `cmake-build.js`). Line numbers refer to
commit `d031eea`.

**Method:** Full read of the `d031eea` diff hunk-by-hunk against the
surrounding code, re-deriving the safety argument for each fix rather than
trusting the resolution table: longjmp/exception paths through the new
`RunProtected` thunks, GC-timing and thread placement of the new M2 sentinel
mechanism, reentrancy windows around the H2 re-check, and Proxy-invariant
implications of the H3 ownership changes. Where a claim could be exercised,
it was (the CODE-REVIEW-3 behavioral harness, both test suites).

**Baseline:** 438 TypeScript tests and 178 C++ tests pass on `d031eea`,
re-run during this review against the freshly built debug binary.

---

## Verification of the CODE-REVIEW-3 remediation

Every resolution row in CODE-REVIEW-3's table was checked against the diff
that claims to implement it (the process failure found last pass — a row
marked fixed with no code behind it — does **not** recur; every row has
matching, correct code). Detail:

| CR-3 # | Verdict |
|--------|---------|
| H1 | ✅ Correct. `CaptureError` contains its own `ToLuaValue` throw; `CallFunction` guards the arg-push and restores the stack; both workers tear down `async_mode_`/the unref deferral via RAII (order preserved: mode cleared, then drain); `DriveAsync` sets `async_resuming_` through an RAII flag. Additionally verified that with these throw *sources* fixed, no constructible C++-exception escape path remains at the unwrapped binding entries — the belt-and-braces try/catch recommended in CR-3 was consciously omitted and nothing currently needs it (noted, not a defect). |
| H2 | ✅ Correct. The liveness+generation re-check sits after the args build and immediately before `DriveAsync`, covering both the disengaged-optional and the new-run-injection variants. Verified the reject path's staged pending-error value is consumed into `args` *before* the potential drop, so no stale structured error survives a dropped settlement. |
| H3 | ✅ Correct. Handle `_tableRef` is non-configurable/non-writable via `DefineHiddenProp`; every handle method and every Proxy trap roots the owner External; the Proxy *target's* `_tableRef` is deliberately left configurable to preserve the ownKeys invariant, which is safe now that the traps own a root. Behaviorally verified (destructured method survives handle GC; `delete proxy._tableRef` + GC survives). |
| M1 | ✅ Correct. Identity check before `ResumeCoroutine`; same-context resume unaffected. |
| M2 | ✅ Correct in the common paths — the sentinel-upvalue design is sound: an executing closure is anchored by the Lua stack, so reclaim can never destroy a host `std::function` mid-call; a worker-thread sentinel firing skips the N-API callback (`async_mode_` check) and mutates maps only while every main-thread reader is excluded by `is_busy_`; `lua_close` fires the sentinels after the callback is cleared. Verified 0 bytes/iteration steady-state over 20k crossings and retained-callback correctness. **Two narrow accounting flaws found in the new code — see N1 and N4.** |
| M3 | ✅ Correct. All ten sites verified inside `RunProtected`; the thunks' leftover stack values are discarded by the trampoline frame (correct Lua C-function semantics — no StackGuard needed); nested `PushProtectedGlobal`-inside-`RunProtected` pcalls compose correctly; validation throws propagate unchanged. **One hygiene gap in three thunks — see N2.** |
| M4 | ✅ Correct. `luaL_Buffer` assembly leaves no C++ object alive across a `__tostring` raise (`luaL_Buffer` is trivially destructible, so the longjmp is clean); the `lua_dump` writers trap and report via status, and both compilers check it. Residual shrank to a single theoretical site — see N5. |
| M5 | ⏸️ Deferred (unchanged, per decision — correctly not touched). |
| L1–L7 | ✅ All verified in place and correct: raw `__jsErrorId` probe; released-handle round-trip throw; `CallScope` on all five traps; validation hoisted in `register_class` (**but see N3 for a bypass**); dead `NapiToCore` gone and `ReleaseTableRef` routed through `UnrefOrDefer`; `uint64_t` ids and `int64_t` length end-to-end; duplicate-class rejection with the name not consumed by a rejected definition. |
| Observation | ✅ `types.d.ts` documents the per-entry budget reset. |

---

## Overall assessment

The CODE-REVIEW-3 remediation is high quality — every fix is present, and the
two hardest designs (the M2 reclaim sentinel and the M3 protected-thunk
pattern) hold up under adversarial analysis of GC timing, thread placement,
and longjmp paths. The four genuine findings this pass are all **in or
adjacent to the new code**, all narrow, and none reachable in a default
(no-`maxMemory`, non-hostile) configuration:

- two OOM-window accounting/hygiene flaws in the new mechanisms (N1, N2),
- one validation bypass via a hostile property getter (N3),
- one bounded leak on abandoned conversions (N4).

The build/test scripts reviewed for the first time are sound (nits only).

---

## Findings

### N1. Reclaim live-count incremented before a raise-capable allocation — an OOM permanently strands the entry (medium-low)

`src/core/lua-runtime.cpp:1993-1998` (the new reclaimable branch of
`PushLuaValue`):

```cpp
reclaimable = true;
++it->second;                                     // count bumped first
auto** slot = static_cast<std::string**>(
    lua_newuserdatauv(L, sizeof(std::string*), 0));  // can raise LUA_ERRMEM
```

Under `maxMemory`, if `lua_newuserdatauv` raises, the count was incremented
but **no sentinel exists** to ever decrement it. The phantom +1 means the
entry's count can never reach zero: even after every real closure for that
name is collected, the `host_functions_` entry and its paired
`js_callbacks_` reference live until context destruction. A leak (not UB),
and only under OOM at exactly this allocation — but it silently defeats the
M2 guarantee for that entry.

**Recommendation.** Move the increment to *after* `luaL_setmetatable`:

- `lua_newuserdatauv` raises → count untouched → balanced;
- `new std::string` throws → metatable not yet set, `__gc` never fires,
  count untouched → balanced (the inert userdata is collected harmlessly);
- `lua_pushcclosure` raises *after* the increment → the sentinel already
  exists on the (unwound) stack, its eventual `__gc` decrements → balanced,
  and the count correctly reaches zero for a closure that never existed.

The current order is the only one of these that cannot self-balance.

### N2. `std::string` locals constructed inside `RunProtected` thunks are skipped by an ERRMEM longjmp (low)

- `RegisterClass`: `mt_name` (`src/core/lua-runtime.cpp:711`) and
  `methods_key` (`:750`) are constructed inside the thunk, with raise-capable
  allocations (`luaL_newmetatable`, `lua_newtable`, string pushes) executing
  while they are alive.
- `AddSearchPath`: `current` (`:959`) is alive across `lua_pushstring` /
  `lua_setfield`.

`RunProtected` achieves its M3 goal — the pcall contains the raise, no panic
— but the longjmp from the raising allocation to the pcall **skips the
strings' destructors** (`ProtectedThunkRunner`'s catch handles C++
exceptions only; a C-Lua longjmp does not unwind C++ frames). That is a leak
per occurrence and formally UB — the H1 discipline, one level down.
`SetUserdataMethodTable` already does this right (its `registry_key` is
built *outside* the lambda).

**Recommendation.** Hoist the constructions above the `RunProtected` call
(capture by reference), as `SetUserdataMethodTable` does. For
`AddSearchPath`, build `current` in a first pass (the read side), then run
the write side in the protected thunk with the finished string captured.

### N3. `register_class` re-reads `metamethods` after validating it — a hostile getter bypasses the reserved-key check (low)

`src/lua-native.cpp:889-890` (validation) vs `:940-941` (registration) —
`def.Get("metamethods")` is evaluated **twice**, and `GetPropertyNames` is
called independently each time. A definition object whose `metamethods`
property is a getter (or a Proxy) can return a clean object during
validation and one containing `__gc` / `__index` / `__newindex` during
registration — reinstating exactly the CODE-REVIEW-2 M7 hazard the L4 hoist
was meant to close (a user `__gc` calls into JS during `lua_close`; a user
`__index` breaks method dispatch and leaks instance references).

Deliberate misuse, same trust class as L6 — but M7 is a machinery-integrity
guarantee, so it should hold against a hostile definition object.

**Recommendation.** Read the property once: snapshot `mms` and its keys (and
each `mms.Get(key)` value) into locals in a single pass, validate the
snapshot, then register from the same snapshot. (The other double-reads in
this function — `readable`/`writable` — only influence booleans and are
harmless.)

### N4. Reclaimable entries registered at conversion time but never pushed leak until context death (low, documented-residual candidate)

`src/lua-native.cpp:1956-1960`: `NapiToCoreInstance` registers the
`__js_callback_N` entry (count 0) when the JS function is *converted*; the
count only becomes reclaim-capable when `PushLuaValue` later materializes a
closure. If the converted value is never pushed, the entry and its
`js_callbacks_` reference live for the context's lifetime. Reachable paths:

- a sibling value's conversion throws mid-container (e.g. a table holding
  `{ fn: () => 1, bad: Symbol() }`) — the whole conversion aborts after `fn`
  was registered;
- the H2 re-check drops a settlement whose args contained a converted
  function;
- binding-side validation failure after conversion.

Bounded (one entry per *failed* conversion, not per call), so far less
severe than the original M2 — but it is the remaining gap in the reclaim
story. Registration cannot simply move to push time (the JS function handle
needs `env`, which push time doesn't have).

**Recommendation.** Either document as an accepted residual, or sweep: on
the conversion-failure paths (the `catch` sites that discard a partially
converted value), erase any entries registered during that conversion whose
count is still 0 (track the names minted per top-level conversion in a small
scoped collector).

### N5. Nits

- `LuaPrint` / `LuaIoWrite` (`src/core/lua-runtime.cpp:1057, :1090`): the
  final `std::string out(...)` construction can throw `bad_alloc` inside a
  Lua C frame. The M4 residual shrank from every-iteration to this single
  true-OOM site; listed for the record, not worth restructuring.
- `run-tests.js:37-38`: `found = true; break;` is unreachable after
  `process.exit(...)`. Cosmetic.
- `LuaContext::SetGlobal`'s function branch registers
  `js_callbacks_[name]` + `host_functions_[name]` before `RegisterFunction`'s
  protected `_G` write; if that write throws (a raising `_G.__newindex`), the
  two entries remain without a global pointing at them — the same
  partial-registration shape as L4, but harmless (a stale, unreachable
  entry). Opportunistic cleanup only.
- `get_vcpkg_path.js` / `cmake-build.js` (first review): sound. The
  `x64-unknown` fallback triplet for unsupported platforms produces a clear
  downstream failure; acceptable for the supported-platform matrix.

---

## Verified and rejected (spot-checks that held up)

Adversarial suspicions pursued against the new code and refuted:

- **Reclaim vs. an executing host function**: a closure being called is
  anchored by the Lua stack, so its sentinel cannot be collected mid-call —
  `OnHostFnClosureCollected` can never destroy the `std::function` that is
  currently on the C++ call stack, and a *different* dying closure for the
  same name only decrements the count (≥1 remains). No use-after-free.
- **Sentinel `__gc` on the worker thread**: mutates
  `reclaimable_host_fns_` / `host_functions_` off-main — safe because every
  main-thread reader of those maps is excluded by `is_busy_` for the whole
  worker run, and the N-API-touching callback is skipped under
  `async_mode_` (matching the userdata-GC tradeoff). The `EndWorkerUnrefDeferral`
  drain cannot trigger GC (`luaL_unref` doesn't allocate), so no sentinel
  fires in the brief `async_mode_ == false` teardown window.
- **Sentinel `__gc` during `lua_close`**: the destructor clears
  `host_fn_gc_callback_` first; only live member maps are mutated. Correct.
- **Double-`__gc` / resurrection**: the null-slot guard makes a second
  finalization a no-op; a `new std::string` failure leaves the userdata
  without its metatable, so its `__gc` never runs on garbage. Correct.
- **`RunProtected` thunk stack discipline**: leftover values on the
  trampoline's frame are discarded when it returns 0 results — the removed
  `StackGuard`s are genuinely unnecessary, including for the early-throw
  paths (the pcall unwinds).
- **`SetGlobalMetatable`'s nested pcall** (`PushProtectedGlobal` inside
  `RunProtected`): composes correctly; error messages surface unchanged.
- **H2 window via a hostile `then`**: `thenFn.Call` runs user JS inside
  `DriveAsync`'s Awaiting branch, but no context state is touched after the
  call — a reentrant `cancel()` there is safe.
- **`ResumeFlag` + default-`Error` `AsyncStepResult`**: if the resume ever
  did throw, the flag still clears and the default state routes to the
  reject branch rather than UB.
- **Round-trip of reclaimed names**: a closure returned Lua→JS crosses as a
  `LuaFunctionRef` (which anchors it), never as a `HostFunctionName`, so the
  reclaimed-name `CoreToNapi` branch can't surface a dangling name for a
  live function. Pre-existing semantics unchanged.
- **`CreateCoroutine`'s `RunProtected` conversion**: the post-`luaL_ref`
  operations in the thunk (`lua_rawgeti`, `lua_xmove`) cannot raise, so the
  anchored-then-error ref-leak window is not reachable.
- **CR-3 tracking hygiene**: text numbering, table numbering, and code all
  agree this time; the M15/M5 deferral is recorded consistently in both
  review documents.

---

## Suggested priority order

1. **N1** — a three-line reorder in `PushLuaValue`; restores the M2
   guarantee under `maxMemory`.
2. **N2** — hoist three string constructions out of their thunks; mechanical.
3. **N3** — snapshot `metamethods` once in `register_class`; small, closes
   the M7 bypass.
4. **N4** — decide: document as accepted residual (defensible) or add the
   per-conversion sweep.
5. **N5** — opportunistic.

(M5 from CODE-REVIEW-3 remains deferred by decision and is intentionally
absent from this list.)
