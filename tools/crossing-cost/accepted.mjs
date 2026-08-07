// The known-acceptable results, each with its reason.
//
// Standard form (`tools/README.md`): an entry whose case has started passing is
// reported **STALE** rather than silently ignored. A suppression list that can
// only ever hide things hides regressions in the other direction too.
//
// **Two things may never go in here** (`PERFORMANCE-PLAN` §8):
//
//   - **A false claim in shipped docs.** If an Axis A cell contradicts a
//     documented claim, the resolution is to fix the product or delete the
//     sentence — never to ledger the gap. A documented claim that is false has
//     already been promised to a user, which makes it the sharper form of the
//     standing rule against ledgering an undocumented defect. C6 is the worked
//     example: the sentence was restated, not ledgered.
//   - **A cell that is noisy.** Ledgering a cell because it fluctuates turns the
//     ledger into a place to put measurement problems. A cell that cannot be
//     measured stably is redesigned as a ratio or deleted, and the deletion is
//     recorded in `FINDINGS.md`.

// Doors whose structural cost is inherently above the cheapest, with the reason.
// These are *not* findings: they are what the door is. The ratio is recorded so
// a door that changes character shows up as a diff.
export const DOOR_NOTES = {
  'create_table/get': 'Mints a registry-backed table handle per call (luaL_ref) and reads a field back'
    + ' through it. Two crossings plus a registry entry against set_global\'s one.',
  'handle.set/get': 'Same as above, plus a write. FEATURES.md records that `set` re-pushes the whole'
    + ' table rather than issuing a targeted write, which is the documented design.',
  environment: 'Builds a fresh environment table and runs the chunk inside it — the door is a'
    + ' sandbox construction, not a value crossing.',
  'coroutine-resume-arg': 'Creates a coroutine (a new lua_State via lua_newthread, registry-anchored)'
    + ' and resumes it. ASYNC.md documents the coroutine as the unit of suspension.',
  'resume_async-arg': 'The above plus a microtask turn: an async door pays the event-loop hop by'
    + ' construction, and that turn is part of what the door costs rather than an overhead to subtract.',
  'call_async-arg': 'Microtask turn on top of a plain `call`. Same reasoning as above.',
  'pcall-arg': 'Runs the crossing inside a protected call, which installs and unwinds a Lua error barrier.',
};

// Doors that cannot be driven twice on one context. Recorded rather than
// skipped: "this door registers once per context" is a real property, and the
// measurement that made it visible belongs in the record.
export const ONCE_ONLY_REASON =
  'register_class refuses a duplicate name on the same context, so the door has no steady-state'
  + ' per-call cost. Measured with a fresh context per call instead, which includes context'
  + ' construction and is therefore not comparable to the repeatable doors\' ratios.';

// Shape cells whose declared class is deliberately not the naive one.
export const SHAPE_NOTES = {
  'C/table-width-by-handle-set':
    'Reported rather than declared. FEATURES.md ("Whole-value pushes, not per-key") records that'
    + ' `set` re-pushes the entire table, so a super-linear result here would be the documented'
    + ' design rather than a defect. It is measured so the number exists and a *change* is visible.',
};

// A cell measured at sizes other than the default decade triple, and why.
export const SIZE_NOTES = {
  'B2/string-of-length-n':
    'Measured at 1e3/1e4/1e5 rather than 1e1/1e2/1e3. Below a kilobyte the byte copy is invisible'
    + ' beside the round trip\'s fixed cost, and the cell classified CONSTANT while measuring the'
    + ' door rather than the string (FINDINGS.md H6).',
};

export function staleEntries({ doorIds, onceOnlyIds, shapeIds }) {
  const stale = [];
  for (const id of Object.keys(DOOR_NOTES)) {
    if (!doorIds.includes(id)) stale.push(`DOOR_NOTES["${id}"] — no such door in roundtrip-matrix any more`);
  }
  for (const id of Object.keys(SHAPE_NOTES)) {
    if (!shapeIds.includes(id)) stale.push(`SHAPE_NOTES["${id}"] — no such shape cell any more`);
  }
  if (Object.keys(DOOR_NOTES).length && onceOnlyIds.length === 0 && ONCE_ONLY_REASON) {
    // Not stale on its own — the reason is still correct if a once-only door
    // reappears — but worth surfacing when the class empties out.
    stale.push('ONCE_ONLY_REASON — every door is now repeatable; drop the group if that is intended');
  }
  return stale;
}
