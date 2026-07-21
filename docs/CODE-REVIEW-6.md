# CODE-REVIEW-6

**Date:** July 21, 2026
**Scope:** Sixth pass. Primary target: the CODE-REVIEW-5 remediation commit
(`08f4560`) — each of its twelve resolutions (F1–F12, including the two
found-while-fixing defects F11/F12) re-verified against the tree, with the
recurring attention to what the fixes left *un*swept. Secondary target: a fresh
adversarial sweep of the whole binding surface for the one hazard class that has
reappeared in every prior pass — a `std::runtime_error` from the core unwinding
across the N-API boundary and terminating the process (the H1 class; CR-3 H1,
CR-4/CR-5 F11). Line numbers refer to commit `08f4560`.

**Method:** Full read of the `08f4560` diff hunk-by-hunk against the surrounding
code, re-deriving the safety argument for each resolution rather than trusting
the table. For the H1 class specifically, I enumerated **every** binding method
that reaches a core method built on `RunProtected` (which throws by design) and
checked each call site for a `try`/`catch`, rather than spot-checking the site
CR-5 named. Where a gap was found it was **exercised**: a hostile
`__newindex` on a `_G` metatable was armed and the suspect entry point called,
observing process termination directly (`exit 134`, `libc++abi: terminating due
to uncaught exception`).

**Baseline:** 448 TypeScript tests and 178 C++ tests pass on `08f4560`, re-run
during this review against the freshly built debug binary.

---

## Resolution status (July 21, 2026)

Both findings resolved. After the fixes: **454 TypeScript tests** (up from 448 —
six new F1 regression tests) and **178 C++ tests** pass against a freshly built
debug binary, and every previously-aborting reproduction now throws a catchable
JS error with the process surviving (`exit 0`).

| # | Status | Resolution |
|---|--------|------------|
| F1 | ✅ Done | `set_userdata` now wraps its whole core-call region (`CreateUserdataGlobal`/`CreateProxyUserdataGlobal` + the method loop + `SetUserdataMethodTable`) in `try`/`catch`, surfacing a JS error and **rolling back** the partial `js_userdata_`/`js_callbacks_`/`host_functions_` state on throw (a new `LuaRuntime::RemoveHostFunction` drops the C++ host-fn entries). `set_print_handler` and the constructor's `print`/`allowBytecode` install paths are likewise guarded. Verified: all three `set_userdata` forms, `set_print_handler`, and the guarded siblings now throw `boom` (or a validation error) instead of `SIGABRT`; the retry-after-rejection path confirms no state is stranded. |
| F2 | ✅ Done | Added a `code-review-6 regressions` block: a per-entry-point matrix that arms a raising `_G.__newindex` and asserts each binding method reaching a `RunProtected`-backed core call throws a catchable error and the context survives to run the next assertion (the three `set_userdata` forms, `set_print_handler`, the `_G`-writing guarded siblings, and a strand-nothing retry test). Six tests total. |

The original findings follow unchanged for reference.

---

## Overall assessment

The CODE-REVIEW-5 remediation is present and correct in all twelve rows. The F1
collector redesign (destructor-swept, method-scoped) is sound and closes the
sibling-conversion leak at all five named entry points; the F5 reservation guard
and single-read snapshot are correct; the CMake rewrite (F2/F3/F7) is a genuine
improvement; the type-definition and test-suite fixes (F6, F9, F10) all verify.

But the pattern `CODE-REVIEW-THOUGHTS.md` predicted has recurred one more time,
and this time it is **high severity**. CR-5's F11 correctly identified that
`RegisterClass` called a `RunProtected`-backed core method with no `try`/`catch`,
so an OOM or a raising `_G.__newindex` unwound a `std::runtime_error` across the
N-API boundary and **terminated the process** — "the H1 class, in a path every
earlier pass missed." F11 then fixed that **one site**. It did not sweep the
class. Two sibling entry points — **`set_userdata` (all three forms) and
`set_print_handler`** — have exactly the same defect and were left unguarded.
Both abort the process on a hostile input that needs no `maxMemory` and no
exotic setup; I reproduced all of them (see F1).

This is the fourth consecutive pass to find a new instance of a
previously-identified class, and the first to find it at high severity in a fix
that explicitly named the class. It is the strongest possible evidence for the
THOUGHTS document's central recommendation: **fix the class, not the site.** The
F11 remediation should have been a grep for every `RunProtected`-backed core
call reachable from an unguarded binding method — not a one-line `try`/`catch`
around `RegisterClass`.

Severity distribution: one high (F1), one low (F2, a coverage/enforcement gap
that is really F1's tail).

---

## Verification of the CODE-REVIEW-5 remediation

Every resolution row in CODE-REVIEW-5's table was checked against the diff that
claims to implement it. Every row has matching, correct code.

| CR-5 # | Verdict |
|--------|---------|
| F1 | ✅ Correct. `JsCallbackCollectorScope`'s destructor now sweeps `names` (`lua-native.h:183-190`), and a method-level scope is installed at all five entry points — the call trampoline (`lua-native.cpp:498`), `ResumeCoroutine` (`:2394`), `SetMetatable` (`:1020`), `RegisterModule` (`:1099`), `CreateTableMethod` (`:1262`). `NapiToCoreInstance` dropped its explicit try/catch in favor of the destructor + `PropagateToParent` (`:2008-2014`); `OnAwaitSettled`'s explicit sweep became the destructor's job (`:1817`). The success-path safety argument (a materialized closure has count ≥ 1, so a sweep is a no-op) holds, and `PropagateToParent` empties `names` so an owned value isn't double-swept. |
| F2 | ✅ Correct. `CMakeLists.txt` now defines `NODE_ADDON_API_CPP_EXCEPTIONS`, matching `binding.gyp`, with a comment explaining why the disable-exceptions mode would silently mis-handle errors. |
| F3 | ✅ Correct. `collect_node_gyp_dirs()` expands the node-gyp cache with `file(GLOB)` + `list(SORT ... NATURAL DESCENDING)` into explicit candidates before any `find_path`/`find_library`; the literal-`*`-in-PATHS bug is gone. Windows resolves `node.lib` from `<cache>/<version>/<arch>` with an actionable `npx node-gyp install` error. (Windows path structurally correct but, per CR-5, untested — no Windows machine.) |
| F4 | ✅ Correct. The backward-compat test binds `t` to a global, mutates the JS copy, and asserts `t.a` is still `1` in Lua (`lua-native.spec.ts:1647-1656`) — it now fails if plain tables regress to live proxies. |
| F5 | ✅ Correct. The class name is reserved (`registered_classes_.insert`) before any property read, with an RAII `ReservationGuard` that erases on every failure exit and `Commit()`s only after the core call (`lua-native.cpp:895-901`, `:998`); `construct`, `readable`, `writable`, `methods`, and `metamethods` are each read exactly once into a local. The three regression tests (reentrant-same-name rejected, rejected-definition-releases-name, construct-read-once) pass. |
| F6 | ✅ Correct. `LuaInput` added (`types.d.ts:31-47`) covering `undefined`/`Date`/`Map`/`Set`/`ArrayBuffer`/`ArrayBufferView`/recursive containers, applied to every input position; results keep `LuaValue`; `set_print_handler`'s arg is now optional. `index.d.ts` re-exports `LuaInput`. |
| F7 | ✅ Correct. The libnode-discovery / `GLOB_RECURSE`-first-file / executable-as-rpath / dead-`NODE_RUNTIME_LINK` code is deleted; Windows links `node.lib`, macOS uses `-undefined dynamic_lookup`, ELF permits undefined symbols; `lua_native_core` now gets `LUA_STATIC`/`NOMINMAX`/`WIN32_LEAN_AND_MEAN`/`_DARWIN_C_SOURCE`; version floor lowered to 3.20. |
| F8 | ✅ Correct (documented). `docs/RELEASING.md` records the per-platform prebuild requirement, the legacy `lua-native.node` deletion, the `MACOSX_DEPLOYMENT_TARGET` un-deferral (CR-3 M5), and tarball/consumer smoke-test steps. |
| F9 | ✅ Correct. `no-return.lua` fixture + `execute_file`-returns-`undefined` assertion; userdata-GC test now exercises the refcount through a surviving alias; both `stripDebug` tests assert strict `<` and that stripped bytecode still runs; `RepoPath()` walks up to the repo root; `CompileFileAndLoadBytecodeMatch` compares values; C++ suite dropped `unistd.h`/`mkstemp` for `std::filesystem`. The three new coverage tests (busy guard across sync entry points + table handles, coroutine arg validation, non-primitive call args) are present and pass. |
| F10 | ✅ Correct. `binding.gyp` collapsed to one vcpkg library declaration per target; `prebuild`→`prebuildify`; `clean` removes the `cmake-build-*` dirs; the spec uses real ESM imports and `fileURLToPath`; the four C++ conditional-message asserts gained `FAIL()` sentinels; the `GetGlobal` deref gained `ASSERT_NE`. |
| F11 | ✅ Correct **for the site it names** — `RegisterClass`'s core call is now wrapped (`lua-native.cpp:992-997`) and the reservation guard releases the name on throw. **But the fix is site-scoped, not class-scoped: the identical defect survives at `set_userdata` and `set_print_handler`. See F1.** |
| F12 | ✅ Correct. `index.d.ts` imports from `'./types.js'`; a `nodenext` typecheck no longer errors. |

---

## Findings

### F1. `set_userdata` and `set_print_handler` abort the process on a raising `_G` metamethod — the H1/F11 class, left unswept (high) — ✅ DONE

CR-5's F11 fixed `RegisterClass`: it now wraps its `RunProtected`-backed core
call in a `try`/`catch` so a `std::runtime_error` becomes a JS exception instead
of unwinding across N-API into `std::terminate`. The fix was applied to that one
method. The **class** — any binding method that calls a `RunProtected`-backed
core method without a surrounding `try`/`catch` — was not swept. Two reachable
sites remain:

**`set_userdata` (`lua-native.cpp:796-866`).** The entire method body has no
`try`/`catch`. It calls `CreateUserdataGlobal` / `CreateProxyUserdataGlobal`
(`:844-846`) and, for the methods form, `SetUserdataMethodTable` (`:862`) — all
three built on `RunProtected` (`lua-runtime.cpp:523`, `:536`, `:580`). Each does
a protected `_G[name] = ud` write (or a protected table build), which throws
`std::runtime_error` if a `__newindex` on a `_G` metatable raises, or on OOM
under `maxMemory`.

**`set_print_handler` (`lua-native.cpp:1927-1937`).** Calls
`InstallPrintHandler` → `runtime->SetOutputHandler` →
`InstallOutputRedirection` (`lua-runtime.cpp:1037-1051`), which does a protected
`print`/`io.write` reassignment on `_G`. Same throw, no `try`/`catch`.

Both were **reproduced** (freshly-built debug binary). Arming
`setmetatable(_G, { __newindex = function() error('boom') end })` and then
calling the entry point terminates the process — the JS `catch` never runs:

```
$ node repro.mjs                        # set_userdata, all three forms
libc++abi: terminating due to uncaught exception of type
std::runtime_error: [...]:1: boom
exit code: 134                          # SIGABRT

$ node repro.mjs                        # set_print_handler
libc++abi: terminating due to uncaught exception of type
std::runtime_error: [...]:1: boom
exit code: 134
```

For comparison, the *guarded* siblings behave correctly on the identical setup:
`set_global` throws a catchable JS error, and `register_class` (post-F11) throws
a catchable JS error. Only the two unswept methods abort.

This needs no `maxMemory` and no unusual state — a single `setmetatable(_G, …)`
with a raising `__newindex`, entirely legal Lua, converts any later
`set_userdata`/`set_print_handler` call into an unconditional process kill. That
is strictly more severe than F11 framed the class (F11 leaned on the OOM
trigger); the metamethod trigger is trivially reachable from ordinary script.

**Full site audit** (every `RunProtected`-backed core method vs. its binding
callers):

| Core method (`RunProtected`) | Binding caller | Guarded? |
|------------------------------|----------------|----------|
| `CreateUserdataGlobal` / `CreateProxyUserdataGlobal` | `set_userdata` | ❌ **aborts** |
| `SetUserdataMethodTable` | `set_userdata` (methods) | ❌ **aborts** |
| `InstallOutputRedirection` | `set_print_handler` | ❌ **aborts** |
| `InstallOutputRedirection` / `SetAllowBytecode` | `LuaContext` ctor (`print` / `allowBytecode:false` options) | ❌ latent (OOM-only at construction — a `_G` metatable can't be armed before the ctor runs) |
| `RegisterClass` | `register_class` | ✅ (F11) |
| `SetGlobalMetatable` | `set_metatable` | ✅ |
| `RegisterModuleTable` | `register_module` | ✅ |
| `AddSearchPath` | `add_search_path` | ✅ |
| `AddJsSearcher` | `add_searcher` | ✅ |
| `CreateTable` / `CreateTableFrom` | `create_table` | ✅ |
| `GetGlobalRef` | `get_global_ref` | ✅ |
| `RegisterFunction` | `set_global` / `RegisterCallbacks` | ✅ |
| `SetGlobal` (value) | `set_global` | ✅ |

**Secondary defect on the fix path.** `set_userdata` inserts
`js_userdata_[ref_id]` at `:840`, *before* the throwing core call at `:843-847`.
Simply wrapping the body in `try`/`catch` leaves that entry (a live
`Napi::ObjectReference`) stranded until context destruction, with no ref-count
ever incremented for it. The guard must also erase `js_userdata_[ref_id]` (and,
for the methods form, any `js_callbacks_`/`host_functions_` entries already
registered in the loop) on the failure exit — mirroring F5's `ReservationGuard`
and F11's reservation rollback.

**Recommendation.** Wrap the `set_userdata` core-call region and the
`set_print_handler` install in `try`/`catch (const std::exception&)`, surfacing a
JS error, and roll back the partial `js_userdata_`/`js_callbacks_` state on
throw. Guard the constructor's `print`/`allowBytecode` install paths too (they
are the same class, latent only because `_G` has no user metatable yet at
construction — but still OOM-reachable under `maxMemory`). Then treat the class
mechanically: every `RunProtected`-backed core call reachable from N-API must be
inside a `try`/`catch`, and any new one added later is a review checklist item.
The `ASan`/exhaustive-sweep discipline in `CODE-REVIEW-THOUGHTS.md` is the
durable fix — a single test that arms a raising `_G.__newindex` and then invokes
*every* binding method, asserting a catchable throw and process survival, would
have caught F11's incompleteness and would catch the next instance.

### F2. No test pins the H1 process-abort class at the binding boundary (low) — ✅ DONE

The recurring class has no dedicated regression coverage. F11's test
(`lua-native.spec.ts`, "F11: a class registration that exhausts memory throws
instead of aborting") exercises exactly one method via the OOM trigger; nothing
exercises the *metamethod* trigger, and nothing sweeps the other entry points —
which is precisely why F1's two sites shipped. Add a table-driven test that, for
each binding method reaching a `RunProtected`-backed core call, arms
`setmetatable(_G, { __newindex = function() error('x') end })` (or a raising
`__index` where the path reads `_G`) and asserts the call throws a catchable JS
error and the process survives. This converts "a sharp reviewer might notice"
into "the suite is red," which is the only thing that actually drives this class
to zero and keeps it there.

---

## Verified and rejected (spot-checks that held up)

Adversarial suspicions pursued against the new code and refuted:

- **F1 collector destructor swallowing a real error**: the `catch (...) {}` in
  `~JsCallbackCollectorScope` (`lua-native.h:187-189`) only wraps
  `SweepUnpushedJsCallbacks`, which does `unordered_map` erases and an
  `EraseReclaimableIfUnpushed` lookup — none of which legitimately throw. A
  destructor must not throw, so the containment is correct, not a swallowed bug.
- **F1 double-sweep via `PropagateToParent`**: a propagated name is removed from
  the child's `names` (`:194-196`), so the child destructor sweeps nothing and
  only the parent holds it — no double erase, and the count-0 guard makes a
  redundant sweep a no-op regardless.
- **F5 `ReservationGuard` vs. the duplicate-name early return**: the guard is
  constructed *after* the `registered_classes_.count` check (`:881-901`), so the
  pre-existing-duplicate path returns without arming/rolling-back the guard —
  the existing registration's name is not erased. Correct.
- **F5 reentrancy on a *different* name**: a hostile getter registering a
  different class fully succeeds and is independent; only the same-name reentrant
  case is (correctly) rejected by the early reservation. Verified against the F5
  regression test.
- **`register_class` post-F11 partial-state on throw**: the constructor/method/
  metamethod `host_functions_` + `js_callbacks_` entries registered before the
  core call are stale-but-unreachable on throw (the class global was never
  written), same L4-shape accepted residual as elsewhere — not a leak of live
  Lua state. (Note this is the pattern F1 asks `set_userdata` to handle
  explicitly, because there the stranded entry is a `Napi::ObjectReference`.)
- **CMake `NODE_ADDON_API_CPP_EXCEPTIONS` (F2)**: confirmed it matches
  `binding.gyp:134` and the whole binding's throwing error model; the CMake path
  now produces the same exception behavior as the gyp build.
- **Type surface (F6)**: `LuaInput` is applied at every JS→Lua input position
  and results keep the narrower `LuaValue`; `index.d.ts` re-exports it. No parity
  regression against the 26 native methods.
- **Test baseline**: 448 TS + 178 C++ green on `08f4560`, matching CR-5's
  post-fix count exactly.

---

## Suggested priority order

1. **F1** — wrap `set_userdata` (all three forms) and `set_print_handler` in
   `try`/`catch`, with partial-state rollback on `set_userdata`; guard the two
   constructor install paths. High: trivially-reachable process abort.
2. **F2** — add the table-driven H1-class regression across every binding entry
   point, so this class cannot silently regrow a site again.

Then, per `CODE-REVIEW-THOUGHTS.md`, adopt the mechanical enforcement (a
sanitizer build in CI and the exhaustive-sweep discipline) that turns "fix the
site" into "the class can't come back" — the fourth recurrence of a known class,
this time at high severity inside a fix that named the class, is the signal that
site-by-site remediation has reached its limit here.

(M5 from CODE-REVIEW-3 remains deferred by decision, tracked in
`docs/RELEASING.md`; intentionally absent from this list.)
