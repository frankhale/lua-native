// One cell of the lifecycle matrix, one process.
//
//   node --expose-gc tools/lifecycle-matrix/cell.mjs <handleId> <eventId>
//
// Prints one JSON object on the line after `##CR22##`. **The process exiting at
// all is half the result**: the failure this matrix exists for is a
// use-after-free on a retired `lua_State`, which aborts, and no in-process
// assertion can report its own abort.
//
// The other half is *what the handle did*. A stale handle that throws is
// correct; a stale handle that returns a value has reached some state, and the
// aliasing probe is what says whether it was the retired one or — far worse —
// the replacement. CR-17 F1 was exactly that: stale handles aliasing live
// tables, found by reading a column of successes rather than by any crash.

import lua_native from '../../index.js';
import { HANDLES } from './handles.mjs';
import { EVENTS, forceGc } from './events.mjs';

const [handleId, eventId, ...flags] = process.argv.slice(2);
const spec = HANDLES.find((h) => h.id === handleId);
const event = EVENTS.find((e) => e.id === eventId);
if (!spec || !event) {
  console.error(`unknown handle/event: ${handleId} / ${eventId}`);
  process.exit(2);
}

// Control switches, so `run.mjs --control` can make the harness fail on
// purpose. A search that reports clean must first demonstrate it can report
// dirty (the standing rule, tools/README.md).
const BREAK_ALIAS = flags.includes('--break-alias');   // pretend a stale read succeeded with new data
const BREAK_VACUITY = flags.includes('--break-vacuity'); // pretend the handle was never made
// Retain every churned handle instead of abandoning it. This is a *genuine*
// registry leak — the slots can never be recycled because the refs are still
// live — and the churn probe must report it. Without this control, loosening
// the growth threshold to allow for the high-water mark would have quietly
// made the probe unable to see anything at all.
const LEAK_REGISTRY = flags.includes('--leak-registry');
const leaked = [];

const ALL_LIBS = { libraries: 'all' };
const countRegistry = (lua) => {
  try {
    return lua.execute_script(
      'local n = 0 for k in pairs(debug.getregistry()) do n = n + 1 end return n');
  } catch {
    return null;
  }
};

const result = {
  handle: handleId,
  event: eventId,
  expect: event.expect,
  made: false,          // per-cell vacuity: did the handle actually get built?
  baselineWorked: null, // and did it work *before* the event?
  outcome: null,        // 'value' | 'threw'
  value: null,
  message: null,
  aliased: null,        // stale handle returned the *replacement* state's data
  registryBefore: null,
  registryAfter: null,
};

const MARKER_BEFORE = 1;
const MARKER_AFTER = 999;

try {
  const lua = new lua_native.init({}, ALL_LIBS);
  let handle = BREAK_VACUITY ? null : spec.make(lua);
  result.made = handle !== null && handle !== undefined;

  // Per-cell vacuity check, not just per-run (tools/README.md). A cell whose
  // handle never worked cannot say anything about what happens to it later:
  // "refuses after reset" is trivially true of a handle that refused already.
  if (result.made) {
    try {
      // Awaited: a handle whose `use` is asynchronous (the async coroutine
      // cursor) would otherwise be measured as "returned a Promise", which is
      // true of a working handle and of a broken one alike.
      const v = await spec.use(handle, lua);
      result.baselineWorked = v !== undefined && v !== null;
    } catch (e) {
      result.baselineWorked = false;
      result.baselineError = String(e && e.message).slice(0, 160);
    }
  }

  // Re-make the handle for the real measurement, so the baseline probe above
  // cannot have consumed it (a coroutine resume advances state).
  if (result.made) handle = spec.make(lua);

  const applied = await event.apply(lua, handle, spec,
    LEAK_REGISTRY ? { retain: leaked } : {});

  // Registry measurement is **slope-based**, and two earlier drafts got it
  // wrong in opposite directions, so the reasoning is worth stating:
  //
  //   draft 1 — compared one round against the start. Every kind "grew", because
  //             `luaL_unref` recycles a slot onto a free list without deleting
  //             the key, so a key count is a *high-water mark* that never falls.
  //             Six findings, all of them the instrument misreading its probe.
  //   draft 2 — took the mark after one warm-up round. Still wrong: the mark
  //             needs more than one round to settle (handles from the warm-up
  //             are not all collected when the sample is taken), so a one-time
  //             +25 settle looked like a leak for `coroutine-iterator`.
  //
  // What actually separates a leak from recycling is the **slope once it has
  // settled**: recycling plateaus, a leak adds a slot per abandoned handle in
  // *every* round, without bound. So sample after each round and compare the
  // last two. A genuine leak clears any slack by 25 per round; a settled
  // plateau reads zero.
  if (event.measuresRegistry && applied && applied.churn) {
    const samples = [countRegistry(lua)];
    for (let round = 0; round < (event.rounds ?? 4); round += 1) {
      await applied.churn();
      samples.push(countRegistry(lua));
    }
    result.registrySamples = samples;
    result.registryBefore = samples[samples.length - 2];
    result.registryAfter = samples[samples.length - 1];
    result.churnRounds = event.rounds ?? 4;
  }

  // The aliasing control has to be injected *here*, ahead of the real use,
  // rather than folded into the success branch below. The handles this matrix
  // cares most about correctly refuse, so the success branch never executes for
  // them — a control that lived inside it would be checking a path that never
  // runs, which is the vacuity this whole instrument is built to avoid. Forcing
  // the simulated stale read proves the detector *and* run.mjs's classifier
  // both fire.
  if (BREAK_ALIAS && eventId === 'reset-then-realias') {
    result.outcome = 'value';
    result.value = String(MARKER_AFTER);
    result.aliased = true;
  } else {
    try {
      const v = await spec.use(handle, lua);   // see the baseline probe above
      result.outcome = 'value';
      result.value = typeof v === 'object' && v !== null
        ? JSON.stringify(v).slice(0, 120) : String(v);
      // Did a stale handle read the *replacement* state? Only meaningful where
      // the event re-aliased the name with a different value.
      if (eventId === 'reset-then-realias' && spec.probe) {
        const raw = (v && typeof v === 'object' && 'value' in v) ? v.value : v;
        result.aliased = Number(raw) === MARKER_AFTER;
      }
    } catch (e) {
      result.outcome = 'threw';
      result.message = String(e && e.message).slice(0, 200);
    }
  }
} catch (e) {
  result.outcome = 'harness';
  result.message = String(e && e.message).slice(0, 300);
}

console.log('##CR22##');
console.log(JSON.stringify(result));
