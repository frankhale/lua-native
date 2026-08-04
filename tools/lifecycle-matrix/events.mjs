// Axis B — the lifecycle events a handle can be held across.
//
// Two families, and the distinction decides what the cell may assert:
//
//   `expect: 'works'`  — the handle is still valid afterwards. Anything other
//                        than the right answer is a defect, including a throw.
//   `expect: 'refuses'`— the handle's state is gone. The *only* acceptable
//                        outcomes are a clean throw naming a reason, or (for
//                        kinds with no liveness flag) a documented refusal from
//                        the identity check. A returned value here is the
//                        dangerous case: it means the handle reached *some*
//                        state, and the aliasing probe then says which.
//
// "Refuses" is never satisfied by a crash, and never by a bare N-API message
// like "Invalid argument" — CR-20 F5 was exactly that message standing in for a
// refusal that had not actually happened.

export const EVENTS = [
  {
    id: 'none',
    expect: 'works',
    // The control that keeps every other row honest: if the baseline cell
    // cannot use the handle, the refusal rows prove nothing, because a handle
    // that never worked "refuses" trivially.
    apply: () => {},
  },
  {
    id: 'reset',
    expect: 'refuses',
    apply: (lua) => lua.reset(),
  },
  {
    id: 'reset-twice',
    expect: 'refuses',
    apply: (lua) => { lua.reset(); lua.reset(); },
  },
  {
    id: 'reset-then-realias',
    expect: 'refuses',
    // The aliasing probe. After the reset, re-create the global the handle
    // pointed at with a *different* value. A stale handle that answers at all
    // must not answer with the new state's data — that is CR-17 F1's silent
    // corruption, and it is invisible unless the two values differ.
    apply: (lua, handle, spec) => { lua.reset(); if (spec.probe) spec.probe(lua); },
  },
  {
    id: 'gc-handle',
    expect: 'works',
    // Dropping *other* references and collecting must not disturb the handle we
    // still hold. The inverse of the leak check: over-eager finalization.
    apply: async (lua) => { await forceGc(); },
  },
  {
    id: 'gc-churn',
    expect: 'works',
    // Mint and abandon many peers of the same kind, repeatedly. The handle
    // under test must survive, and registry slots must be *recycled* — the
    // "no stranded registry slot" half, measured rather than assumed.
    //
    // **Measured across rounds, not within one, and the first draft got this
    // wrong.** `luaL_unref` does not delete the registry key; it assigns the
    // slot onto a free list, so a key count only ever rises and is a
    // *high-water mark*, not a live-reference count. Measuring one round of 25
    // abandoned handles therefore showed "the registry grew 14 -> 40" for every
    // handle kind, and reported six findings that were all the instrument
    // misreading its own probe.
    //
    // The property that actually distinguishes a leak from recycling is whether
    // the mark keeps climbing once it has been established. So: burn a warm-up
    // round to set the mark, then run more rounds and require it to hold. A
    // genuine leak adds a slot per abandoned handle, every round, without
    // bound.
    apply: async (lua, handle, spec, opts = {}) => {
      const churn = async () => {
        for (let i = 0; i < 25; i += 1) {
          try {
            const made = spec.make(lua);
            // The leak control retains them, so the slots cannot be recycled.
            if (opts.retain) opts.retain.push(made);
          } catch { /* ignore */ }
        }
        await forceGc();
        try { lua.gc('collect'); } catch { /* library may be absent */ }
      };
      await churn();                       // warm-up: establishes the mark
      return { measureFrom: true, churn };  // cell.mjs samples, then churns again
    },
    measuresRegistry: true,
    rounds: 4,
  },
  {
    id: 'release-then-use',
    expect: 'refuses',
    only: (spec) => typeof spec.release === 'function',
    apply: (lua, handle, spec) => spec.release(handle),
  },
  {
    id: 'double-release',
    expect: 'refuses',
    only: (spec) => typeof spec.release === 'function',
    // Releasing twice must be a clean no-op or a clean throw, never a double
    // luaL_unref — which would free a slot a *later* handle now owns and is the
    // classic way to produce aliasing that shows up arbitrarily far away.
    apply: (lua, handle, spec) => { spec.release(handle); spec.release(handle); },
  },
];

export async function forceGc() {
  if (typeof global.gc !== 'function') {
    throw new Error('cell must run under --expose-gc');
  }
  await new Promise((r) => setTimeout(r, 5));
  global.gc();
  await new Promise((r) => setTimeout(r, 5));
  global.gc();
}
