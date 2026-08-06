// The GC stress fixture: hammer handle and finalizer lifetimes under forced
// collection, so a sanitizer has something adversarial to watch.
//
//   node --expose-gc tools/gc-stress/run.mjs                 # every pattern
//   node --expose-gc tools/gc-stress/run.mjs --iterations=50
//   node --expose-gc tools/gc-stress/run.mjs --pattern=drop-then-collect
//
// **Why this is a file rather than a paragraph.** `docs/SANITIZERS.md` recorded,
// on July 21, 2026, that a stress harness had hammered the historical UAF
// patterns for 1,200 iterations under ASan with no report. That harness was a
// scratch script and is not in the repository, so the strongest memory-safety
// evidence this project had cited **a check nobody could re-run** — the
// documentation-level version of the class `assertion-strength` catches in the
// suite. It is now a file, and the claim in SANITIZERS.md points at it.
//
// **It is not a search and reports no findings of its own.** A sanitizer is a
// runtime tool: it only sees bugs on paths that actually execute, so its value
// is entirely a function of how adversarial the execution is. This exists to
// *make* the execution adversarial. Run it under `run-sanitized-ts.js`; a clean
// run here alone means only that nothing threw.
//
// **The handle patterns are driven by `lifecycle-matrix`'s Axis A rather than by
// a list written here.** That axis is already derived from the source (a `*Data`
// struct paired with a `shared_ptr<LuaRuntime>`, plus the marker-carrying JS
// objects), it is what `surface-census` scores against, and reusing it means a
// handle kind added to the product is stressed without anyone remembering to add
// it. The July 2026 list was five hand-picked patterns; three handle kinds have
// been added since, including the async coroutine cursor, whose state is
// shared_ptr-owned and can outlive its iterator.

import lua_native from '../../index.js';
import { HANDLES } from '../lifecycle-matrix/handles.mjs';
import { forceGc } from '../lifecycle-matrix/events.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const ITERATIONS = Number(arg('iterations', '100'));
const onlyPattern = arg('pattern', null);
const ALL = { libraries: 'all' };

if (typeof globalThis.gc !== 'function') {
  console.error('needs --expose-gc: without a forced collection this fixture is '
    + 'a slow no-op, which is exactly the vacuous-run failure it exists to avoid.');
  process.exit(2);
}

// **Reused from `lifecycle-matrix`, and the reuse is the point.** A collection
// here has to be `gc()` *with an awaited turn of the event loop between the
// calls*, because a napi finalizer is queued rather than run inline: a
// synchronous `gc(); gc()` collects the JS object and never runs the finalizer
// that releases its Lua registry slot. This file's first balance run measured
// exactly that and reported a 40-slot-per-round leak in the product — the
// eleventh instrument false finding in this tree, and the reason
// `tools/README.md` says to drive a dirty result to a reproduction before
// believing it. Keeping one definition of "force a collection" is how that
// mistake stops being available.
const collect = () => forceGc();

// Several handle kinds are asynchronous (`use` returns a promise), so a bare
// try/catch around the call catches nothing — the rejection lands as an
// unhandled one and kills the run *after* the report says clean. Every use of a
// handle goes through here: perform it, await whatever comes back, and swallow a
// refusal, because refusing is a correct answer for a handle held across a
// lifecycle event. A crash is not, and a crash is what the sanitizer is for.
async function settle(fn) {
  try { await fn(); } catch { /* refusal is the correct answer here */ }
}

// --- the patterns -----------------------------------------------------------
//
// Each returns the number of operations it performed, so a pattern that silently
// stops doing anything shows up as a zero rather than as a fast clean run.

const PATTERNS = [
  {
    id: 'drop-then-collect',
    describe: 'make every handle kind, drop the only reference, force GC, keep using the context',
    run: async () => {
      let n = 0;
      for (const h of HANDLES) {
        const lua = new lua_native.init({}, ALL);
        let handle = h.make(lua);
        handle = null;              // the finalizer is now eligible
        await collect();
        // The context must still be usable after the handle's __gc ran: this is
        // where a finalizer that unrefs into a dead registry shows up.
        lua.execute_script('local t = {} for i = 1, 200 do t[i] = tostring(i) end return #t');
        n += 1;
      }
      return n;
    },
  },
  {
    id: 'method-outlives-handle',
    describe: 'destructure a method off a handle, drop the handle, collect, then call (H3)',
    run: async () => {
      let n = 0;
      for (const h of HANDLES) {
        const lua = new lua_native.init({}, ALL);
        let handle = h.make(lua);
        // Only the bound method survives the drop. The receiver's data must stay
        // alive behind it, or the call reads freed memory.
        const held = typeof handle === 'object' && handle !== null && typeof handle.get === 'function'
          ? handle.get.bind(handle) : null;
        await settle(() => h.use(handle, lua));
        handle = null;
        await collect();
        if (held) await settle(() => held('v'));
        n += 1;
      }
      return n;
    },
  },
  {
    id: 'context-dropped-under-handle',
    describe: 'drop the context, keep the handle, collect, then use it (H9c shape)',
    run: async () => {
      let n = 0;
      for (const h of HANDLES) {
        let lua = new lua_native.init({}, ALL);
        const handle = h.make(lua);
        lua = null;
        await collect();
        // The handle holds a shared_ptr to the runtime, so the state must still
        // be alive here — or must refuse. Either is correct; a read of freed
        // memory is not.
        await settle(() => h.use(handle, null));
        n += 1;
      }
      return n;
    },
  },
  {
    id: 'reset-under-handle',
    describe: 'hold every handle kind across reset(), collect, then use (the lifecycle event with a live retired state)',
    run: async () => {
      let n = 0;
      for (const h of HANDLES) {
        const lua = new lua_native.init({}, ALL);
        const handle = h.make(lua);
        lua.reset();
        await collect();
        await settle(() => h.use(handle, lua));
        n += 1;
      }
      return n;
    },
  },
  {
    id: 'marker-stripped',
    describe: 'delete the ownership marker off a bridged function, then call it (L6)',
    run: async () => {
      const lua = new lua_native.init({}, ALL);
      const fn = lua.execute_script('return function(a) return a + 1 end');
      try { delete fn.__luaFnOwner; } catch { /* non-configurable is fine */ }
      await collect();
      await settle(() => fn(1));
      return 1;
    },
  },
  {
    id: 'callback-closure-churn',
    describe: 'reclaimable nested-callback closures collected mid-run (M2)',
    run: async () => {
      const lua = new lua_native.init({}, ALL);
      let n = 0;
      for (let i = 0; i < 20; i++) {
        lua.set_global(`cb${i}`, () => {
          // A closure that itself calls back into Lua while a collection may be
          // pending underneath it.
          return lua.execute_script('return 1');
        });
        lua.execute_script(`return cb${i}()`);
        n += 1;
      }
      await collect();
      lua.execute_script('collectgarbage("collect")');
      return n;
    },
  },
  {
    id: 'gc-finalizer-reentry',
    describe: 'a Lua __gc finalizer that re-enters the host while JS is collecting',
    run: async () => {
      const lua = new lua_native.init({}, ALL);
      let fired = 0;
      lua.set_global('host_note', () => { fired += 1; });
      lua.execute_script(`
        for i = 1, 50 do
          local u = setmetatable({}, { __gc = function() host_note() end })
          u = nil
        end
        collectgarbage("collect")
      `);
      await collect();
      return fired;
    },
  },
  {
    id: 'async-cursor-outlives-iterator',
    describe: 'the async coroutine cursor: drop the iterator mid-iteration, collect, keep going',
    // The handle kind §15.6 singles out — shared_ptr-owned state that can
    // outlive the iterator that created it, and the one added since the July
    // 2026 stress run.
    run: async () => {
      const lua = new lua_native.init({}, ALL);
      const co = lua.create_coroutine(
        'return function() for i = 1, 5 do coroutine.yield(i) end return "done" end');
      let it = co[Symbol.asyncIterator]();
      await it.next();
      await it.next();
      it = null;                    // cursor dropped mid-iteration
      await collect();
      // The coroutine itself must survive its iterator being collected.
      await settle(() => lua.resume_async(co));
      await collect();
      return 1;
    },
  },
  {
    id: 'context-churn',
    describe: 'build and abandon whole contexts with live handles still pointing into them',
    run: async () => {
      const kept = [];
      for (let i = 0; i < 25; i++) {
        const lua = new lua_native.init({}, ALL);
        lua.execute_script('t = { v = 1 }');
        kept.push(lua.get_global_ref('t'));   // handle outlives its context reference
      }
      await collect();
      for (const h of kept) await settle(() => h.get('v'));
      await collect();
      return kept.length;
    },
  },
];

// --- the balance check ------------------------------------------------------
//
// **The leak check that works on this platform.** `detect_leaks=0` is not a
// tuning choice — LeakSanitizer does not exist on macOS, so none of the four
// sanitizer harnesses can see a leak at all. What can be measured directly is
// *balance*: mint and abandon every handle kind in one long-lived context, over
// and over, and require the state to stop growing.
//
// **Two things it deliberately is not.**
//
// It is not a duplicate of `lifecycle-matrix`'s `gc-churn`, which measures the
// same registry mark **per handle kind, in its own process**. This runs every
// kind together in one context for many more rounds, which is the shape a slow
// per-cycle strand shows up in and a per-kind cell does not.
//
// It does not observe the binding's own bookkeeping (`js_userdata_`,
// `js_callbacks_`, the `Napi::Reference` set). Those are private C++ members
// with no diagnostic accessor, and adding a public one to make a test easier is
// a change to the shipped API — which is a decision for the owner, not a side
// effect of writing an instrument. Stated so the gap is visible rather than
// implied: **this measures the Lua side and the context's own memory, not the
// addon's maps.**
//
// The technique is `gc-churn`'s, and its lesson is inherited whole: `luaL_unref`
// does not delete a registry key, it puts the slot on a free list, so the key
// count is a **high-water mark and not a live-reference count**. A single round
// therefore always "grows". Burn a warm-up round to establish the mark, then
// require it to hold.
async function balanceCheck(rounds, retain = null) {
  const lua = new lua_native.init({}, ALL);
  const registryCount = () => lua.execute_script(
    'local n = 0 for k in pairs(debug.getregistry()) do n = n + 1 end return n');

  const round = async () => {
    for (const h of HANDLES) {
      for (let i = 0; i < 5; i++) {
        let handle;
        try { handle = h.make(lua); } catch { continue; }
        await settle(() => h.use(handle, lua));
        // `retain` is the control: holding the handles is a real leak, and the
        // check must see it. Without this the balance check could only ever
        // report clean, which is the failure every other harness here runs
        // controls to avoid.
        if (retain) retain.push(handle);
        handle = null;
      }
    }
    await collect();
    lua.execute_script('collectgarbage("collect")');
  };

  await round();                       // warm-up: establishes the mark
  const samples = [];
  const memory = [];
  for (let i = 0; i < rounds; i++) {
    await round();
    samples.push(registryCount());
    memory.push(lua.get_memory_usage());
  }

  // A leak adds slots every round without bound. Recycling holds the mark, give
  // or take the few slots a round legitimately keeps alive.
  const growth = samples[samples.length - 1] - samples[0];
  const memGrowth = memory[memory.length - 1] - memory[0];
  if (retain) return { growth, memGrowth, samples };
  console.log(`\n  balance over ${rounds} rounds x ${HANDLES.length} handle kinds x 5:`);
  console.log(`    registry high-water: ${JSON.stringify(samples)}  (growth ${growth})`);
  console.log(`    lua memory bytes:    ${memory[0]} -> ${memory[memory.length - 1]}  (growth ${memGrowth})`);
  const bad = [];
  if (growth > 5) {
    bad.push(`registry slots are not being recycled: ${samples[0]} -> ${samples[samples.length - 1]} `
      + `across ${rounds} post-warm-up rounds`);
  }
  // Lua's own allocator keeps arenas, so a small drift is normal; an unbounded
  // strand shows as growth proportional to the round count.
  if (memGrowth > 64 * 1024 * rounds) {
    bad.push(`Lua memory grew ${memGrowth} bytes across ${rounds} rounds, which scales with the round count`);
  }
  return bad;
}

// The control, run before anything is believed: retain every handle instead of
// dropping it, and require the balance check to call it a leak. A fixture whose
// leak detector cannot detect a leak is a fixture that reports "balanced" about
// nothing.
async function runControls() {
  const retained = [];
  const r = await balanceCheck(4, retained);
  const sawLeak = r.growth > 5;
  console.log('Control (a balance check that reports clean must first report dirty):\n');
  console.log(`  ${sawLeak ? 'ok  ' : 'FAIL'}  a retained handle per round is reported as a leak `
    + `(growth ${r.growth} over ${JSON.stringify(r.samples)})`);
  console.log(`  ${retained.length > 0 ? 'ok  ' : 'FAIL'}  the control actually retained handles `
    + `(${retained.length})`);
  console.log('');
  return sawLeak && retained.length > 0;
}

async function main() {
  if (!await runControls()) {
    console.error('controls failed; refusing to report a balance that cannot report dirty.');
    process.exit(1);
  }
  const patterns = PATTERNS.filter((p) => !onlyPattern || p.id === onlyPattern);
  console.log(`GC stress: ${patterns.length} patterns x ${ITERATIONS} iterations, `
    + `over ${HANDLES.length} handle kinds\n`);

  const counts = new Map();
  for (let i = 0; i < ITERATIONS; i++) {
    for (const p of patterns) {
      let n = 0;
      try {
        n = await p.run();
      } catch (e) {
        console.error(`\nPATTERN THREW  ${p.id} (iteration ${i})\n  ${e.message}`);
        process.exit(1);
      }
      counts.set(p.id, (counts.get(p.id) ?? 0) + (Number(n) || 0));
    }
    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${ITERATIONS}`);
  }
  console.log('\n');

  // A pattern that performed no operations is a vacuous cell, and a stress
  // fixture reporting "no crash" over zero work is the exact failure the
  // controls elsewhere in tools/ exist to prevent.
  let vacuous = 0;
  for (const p of patterns) {
    const n = counts.get(p.id) ?? 0;
    console.log(`  ${String(n).padStart(6)} ops   ${p.id}  — ${p.describe}`);
    if (n === 0) vacuous += 1;
  }
  if (vacuous) {
    console.error(`\n${vacuous} pattern(s) performed no operations; that is a vacuous run.`);
    process.exit(1);
  }

  if (!onlyPattern) {
    const leaks = await balanceCheck(Math.max(4, Math.min(12, ITERATIONS)));
    if (leaks.length) {
      console.error('\nBALANCE FINDINGS');
      for (const l of leaks) console.error(`  ${l}`);
      process.exit(1);
    }
    console.log('    balanced.');
  }

  console.log('\nno crash, no vacuous pattern, no unbounded growth. '
    + 'Run under run-sanitized-ts.js for the use-after-free verdict.');
}

main();
