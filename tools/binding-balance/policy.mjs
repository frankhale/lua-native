// Axis A — the binding's own bookkeeping containers, and what each is allowed
// to do.
//
// **The rule that generated this list**, stated because an enumeration that
// cannot say where it came from cannot be checked for completeness — only
// extended when something leaks past (`CORRECTNESS.md` §15.6's closing lesson):
//
// > A container belongs here iff it is a member of `LuaContext` that **retains a
// > JS value beyond the call that supplied it** — a `Napi::Reference`, or a
// > collection holding one, or a collection whose entries name references held
// > elsewhere.
//
// That last clause is why `ud_method_fns_` is here: it holds only strings, but
// each names a `js_callbacks_` entry, so a strand in it strands a reference just
// as surely. And it is why the id counters, `in_reset_` and `debug_hook_mask_`
// are not — they retain nothing.
//
// `tools/invariants/binding-refs-census.mjs` computes that rule against
// `src/lua-native.h` and requires every member it finds to appear below with a
// policy, so a container added to the product cannot sit here unmeasured. This
// file is the *ruling*; the census is the check that the ruling is complete.
//
// --- the policies, and the mistake that produced them -----------------------
//
// **The first draft of this file had four different policies and the harness
// reported seven leaks, every one of which was its own.** They are recorded here
// rather than deleted, because the misreading is more instructive than the
// result and this project has now made it twelve times (`tools/README.md`: a
// search that reports dirty must show the dirt is in the subject).
//
// The draft's cycle was *populate a fresh thing, discard it, repeat* — and it
// asserted the count must come back flat. But `set_global(name, fn)` with a
// **fresh name each round** is not a leak when it grows: `LuaContext::SetGlobal`
// distinguishes the "named-persistent top-level registration" from the
// "reclaimable nested-closure path" in as many words, and a named top-level host
// function is documented to live until its name is reused or the state is
// replaced. Likewise `register_type_converter` and `add_searcher` have no
// removal API at all, so N calls is N entries by construction. The harness was
// measuring the API's contract and calling it a defect.
//
// The fix is to separate **what the caller asked for** from **what the container
// kept**. Three series do that, and each policy below answers all three:
//
//   repeat   The *same* registration, N times. This is the real idempotence
//            question — re-registering one name ten thousand times must not
//            accumulate ten thousand entries — and it is the one the draft
//            never asked, because every round used a fresh name.
//   event    A *fixed* population, then N rounds of reset + collection. Nothing
//            may grow: a replay that appended instead of re-establishing, or a
//            reset that failed to clear, shows here and nowhere else.
//   reclaim  For the containers with a documented GC-driven reclaim path: mint
//            the reclaimable form, drop it, collect, and require the count back
//            at baseline. This is the only series where growth-per-cycle is
//            genuinely a defect, and it is the M2 contract being checked rather
//            than assumed.
//
//   TRANSIENT    Must read zero at rest, in every round of every series. Held
//                only for the duration of something — an outermost call, an
//                async run — so a non-zero reading between operations *is* the
//                finding, no churn needed.
//
//   KEYED        Keyed by a name the caller chooses, so a repeated name replaces
//                rather than accumulates (or, for `classes`, is refused outright
//                by L7 — which keeps the count flat by a different mechanism and
//                is just as good an answer). Cleared wholesale by reset.
//
//   APPEND_ONLY  A list with no removal API: one entry per call, by design and
//                for the life of the context. Growth under `repeat` is the
//                contract; the assertions are that it grows by *exactly* one per
//                call — never two — and that it does not grow under `event`.
//
//   SINGLETON    Bounded at a fixed maximum by construction. Re-installing
//                replaces; the count can never exceed the bound.
//
// **Every policy is falsifiable in every series**, which is the point. A policy
// that could only ever be satisfied would be a description, not a check.

export const POLICIES = ['TRANSIENT', 'KEYED', 'APPEND_ONLY', 'SINGLETON'];

// `field` is the key in `info().bindingRefs`; `members` are the C++ members it
// counts, which is what the census matches against the header. `bound`, where
// present, is the maximum a SINGLETON may reach.
export const CONTAINERS = [
  {
    field: 'callbacks',
    members: ['js_callbacks_'],
    policy: 'KEYED',
    reclaimable: true,
    why: 'Host functions registered for Lua to call, keyed by name. A top-level '
      + 'named registration persists until the name is reused or the state is '
      + 'replaced — SetGlobal says so explicitly, contrasting it with the '
      + 'nested path. The *anonymous* form (a function nested in a table, or '
      + 'behind a dotted path) is reclaimable and is dropped when the Lua '
      + 'closure is collected (M2), which is what the reclaim series checks. '
      + 'A userdata\'s method closures drop with the userdata (CR-11 F4).',
  },
  {
    field: 'userdata',
    members: ['js_userdata_'],
    policy: 'KEYED',
    reclaimable: true,
    why: 'One entry per live userdata instance, erased by the __gc that collects '
      + 'it and cleared wholesale by reset. The stranded-entry residual in '
      + 'CODE-REVIEW-LEDGER CR-8 F6 is the one documented exception, and it is '
      + 'OOM-window-only: not reachable without an allocation failure mid-push.',
  },
  {
    field: 'userdataMethods',
    members: ['ud_method_fns_'],
    policy: 'KEYED',
    reclaimable: true,
    why: 'Names of the per-userdata method closures, so they can be dropped with '
      + 'the userdata. Holds strings, but each names a js_callbacks_ entry — a '
      + 'strand here is a strand there.',
  },
  {
    field: 'errorRegistry',
    members: ['js_error_registry_'],
    policy: 'TRANSIENT',
    why: 'Thrown JS errors staged so a Lua error carrying their id can rebuild '
      + 'them. Cleared when the outermost call starts (call_depth_ == 0), so '
      + 'between calls it must read zero. A long-lived server with a throwing '
      + 'callback per request is the shape that would otherwise accumulate here.',
  },
  {
    field: 'classes',
    members: ['registered_classes_'],
    policy: 'KEYED',
    why: 'Names only, and the mechanism is a refusal rather than a replacement: '
      + 'luaL_newmetatable would silently merge a repeated registration, so a '
      + 'name cannot be reused (L7). Repeating one name therefore keeps the '
      + 'count flat by throwing, which is a correct answer to the same question.',
  },
  {
    field: 'classAccessors',
    members: ['class_accessors_'],
    policy: 'KEYED',
    why: 'Keyed by class name and permanent for the life of the context, stated '
      + 'at the member: a class registration cannot be superseded, the same '
      + 'reasoning that leaves a class\'s constructor and methods unreclaimable. '
      + 'Flat under a repeated name for the same L7 reason as `classes`.',
  },
  {
    field: 'typeConverters',
    members: ['type_converters_'],
    policy: 'APPEND_ONLY',
    why: 'Context configuration with no removal API: the converters run on every '
      + 'set_global, including the ones reset() performs during its replay, and '
      + 'reset deliberately leaves the vector alone. One entry per call is the '
      + 'contract; two would not be, and neither would growth across a reset.',
  },
  {
    field: 'fromLuaConverters',
    members: ['from_lua_converters_'],
    policy: 'APPEND_ONLY',
    why: 'The outbound half of the same pair, with the same lifetime.',
  },
  {
    field: 'searchers',
    members: ['searchers_'],
    policy: 'APPEND_ONLY',
    why: 'Replayed onto the fresh state by reset (CR-9 F3) — dropping them made '
      + 'the two halves of module resolution behave differently across a reset. '
      + 'The replay mints *fresh* js_callbacks_ names from a monotonic counter '
      + 'while re-using this vector, so the event series is precisely where an '
      + 'appending replay would show.',
  },
  {
    field: 'sharedTables',
    members: ['shared_tables_'],
    policy: 'SINGLETON',
    why: 'The subscriptions this context holds, fixed at construction because '
      + '`shared` is an init option. Reset re-pushes each value onto the fresh '
      + 'state "without recording it again" (SharedTable::PushTo\'s stated '
      + 'contract), so a reset that grew this would mean the recording and the '
      + 'pushing had been confused. Bounded by the subscription count.',
  },
  {
    field: 'handlers',
    members: ['print_handler_', 'read_handler_', 'file_reader_', 'debug_hook_'],
    policy: 'SINGLETON',
    bound: 4,
    why: 'The four redirection handlers, replayed onto the fresh state so a '
      + 'sandbox context does not silently lose its virtual filesystem across a '
      + 'reset. Each is a single reference, so the group is bounded at 4 and '
      + 're-installing must replace rather than stack.',
  },
  {
    field: 'asyncRefs',
    members: ['async_coro_obj_', 'async_pending_promise_', 'async_self_ref_'],
    policy: 'TRANSIENT',
    why: 'Held only between the start of an async run and its settlement — '
      + 'async_self_ref_ deliberately keeps the context alive across the await. '
      + 'At rest all three must be empty, and a settled run that left one behind '
      + 'would pin the whole context, which is the largest single object here.',
  },
  {
    field: 'callbacksObject',
    members: ['callbacks_ref_'],
    policy: 'SINGLETON',
    bound: 1,
    why: 'The callbacks object handed to the constructor, re-registered onto the '
      + 'fresh state by reset. One reference, so 0 or 1 — and the check is that '
      + 'a reset re-registers rather than stacking.',
  },
];

// Members that match the rule above but are deliberately not counted, each with
// the reason. `tools/README.md`: never ledger an undocumented defect — these are
// exclusions of scope, not suppressions of a result, and the census requires one
// of these or a CONTAINERS row for every member it finds.
export const NOT_COUNTED = {
  // --- iteration cursors ----------------------------------------------------
  //
  // The three below entered this ledger on August 7, 2026, when `surface-census`
  // widened census F's universe from `lua-native.h` to both translation units.
  // They had been invisible, not excused: cursor states are declared in the
  // .cpp, and `LuaCoroIterState::coro` predates the census entirely. Ruled
  // together because they are one shape.
  //
  // **Why no counter, argued rather than asserted.** `bindingRefs` counts what a
  // *context* retains, and a cursor retains nothing on the context's behalf: its
  // reference is owned by an External rooted on the iterator object, so it lives
  // exactly as long as the iterator and dies with it. Counting it would mean a
  // per-cursor accessor on an object the caller already holds — it can see its
  // own iterator — and a context-level number that changed with how many `for`
  // loops happened to be live would report churn, not lifetime.
  //
  // **Driven, not assumed** (T4): 200 cursors abandoned mid-iteration plus 200
  // drained, under forced GC, leave every `info().bindingRefs` counter
  // unchanged. `gc-stress` and `lifecycle-matrix` cover the coroutine side.
  coro: 'A field of LuaCoroIterState: the coroutine object a `for...of` cursor is '
    + 'walking, held strongly so the coroutine cannot be collected mid-loop. Per '
    + 'cursor, not per context; owned by an External rooted on the iterator '
    + 'object and released with it.',
  handle: 'A field of LuaTableIterState: the table handle a `for...of` cursor is '
    + 'walking (T4). Same lifetime as `coro` above and for the same reason.',
  self: 'A field of LuaCoroIterState: a shared_ptr to the state itself, which is '
    + 'what lets a method destructured off the cursor keep it alive (the H3 / L6 '
    + 'discipline the table handles use). It is a deliberate cycle, broken by the '
    + "External's finalizer, which resets it — so the state outlives every "
    + 'borrowed method and nothing outlives the iterator object. Not a retained '
    + 'JS value at all in the sense this census means: the reference is to C++ '
    + 'state, and it qualifies only because that state transitively holds `coro`.',

  subscribers_: 'A member of SharedTable, not LuaContext, so it is outside this '
    + 'harness\'s subject: the count is per shared table rather than per context, '
    + 'and no context can read it. It holds *weak* references and prunes collected '
    + 'entries on the next propagation, which bounds it by the number of live '
    + 'subscribers — but a table whose subscribers die and is never sync()ed again '
    + 'holds the not-yet-pruned residue, and nothing here measures that. Stated '
    + 'rather than closed: it needs an accessor on SharedTable, which is a second '
    + 'API decision and belongs to whoever makes it.',
  value_: 'A member of SharedTable: the shared object itself, held for the life of '
    + 'the table by construction — that is what a shared table is.',
  contextConstructor: 'A member of AddonData: one reference for the life of the '
    + 'addon instance, by design, so the exported class survives.',
  sharedTableConstructor: 'As above.',
  object: 'A field of UserdataEntry, counted through `userdata` rather than on its '
    + 'own — one entry holds exactly one, so a second column would always equal '
    + 'the first.',
  getter: 'A field of ClassAccessor, counted through `classAccessors`.',
  setter: 'As above.',
  props: 'The per-class accessor map inside ClassAccessorTable. `classAccessors` '
    + 'counts exactly this — summed across classes rather than per class — so a '
    + 'column of its own would be the same number sliced differently.',
  context: 'A field of SharedTable::Subscriber; see `subscribers_`.',
};

export const byField = (field) => CONTAINERS.find((c) => c.field === field);
