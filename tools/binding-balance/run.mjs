// The binding-balance search: does the addon's **own** bookkeeping return to
// baseline?
//
//   node --expose-gc tools/binding-balance/run.mjs              # everything
//   node --expose-gc tools/binding-balance/run.mjs --control    # just the controls
//   node --expose-gc tools/binding-balance/run.mjs --field=callbacks
//   node --expose-gc tools/binding-balance/run.mjs --rounds=40
//
// **The region, declared up front** (`CORRECTNESS.md` §15.9's first obligation).
// This project has two leak checks and they measure the same side: the Lua
// registry high-water mark, per handle kind in `lifecycle-matrix`'s `gc-churn`
// and in aggregate in `tools/gc-stress`. The *binding's* side — the callbacks,
// userdata wrappers, converters, searchers, accessors and handlers the addon
// retains as `Napi::Reference`s so Lua can reach them — was measured by nothing,
// because nothing could read it: there was no accessor. On a platform where
// LeakSanitizer does not exist (`docs/SANITIZERS.md`), that left roughly half
// the addon's retained memory unobservable by any instrument here.
//
// `info().bindingRefs` is the accessor, added for this search and shipped rather
// than hidden behind a debug build, because a diagnostic the released binary
// cannot answer is not a diagnostic. `CORRECTNESS.md` §15.10 records the call.
//
// **Three series, because "it grew" and "it leaked" are different claims.** The
// first draft had one series and reported seven leaks, all of which were the
// harness measuring the API's documented contract; `policy.mjs` records what it
// got wrong in detail, because that misreading is the twelfth of its kind here
// and by far the most likely thing to be repeated. The three:
//
//   repeat   The same registration N times — the idempotence question.
//   event    A fixed population, then N rounds of reset + collection — nothing
//            may grow, which is where an appending replay would show.
//   reclaim  For containers claiming a GC-driven reclaim path: mint the
//            reclaimable form, drop it, collect, require baseline.

import lua_native from '../../index.js';
import { forceGc } from '../lifecycle-matrix/events.mjs';
import { CONTAINERS, NOT_COUNTED, POLICIES, byField as policyFor } from './policy.mjs';
import { PRODUCERS, byField as producerFor } from './producers.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const ROUNDS = Number(arg('rounds', '12'));
const WARMUP = 2;
const onlyField = arg('field', null);
const controlOnly = argv.includes('--control');

if (typeof globalThis.gc !== 'function') {
  console.error('needs --expose-gc: a finalizer that never runs looks exactly '
    + 'like a container that never drains, which is this harness reporting dirt '
    + 'that is its own.');
  process.exit(2);
}

const ALL = { libraries: 'all' };

// --- the ledger -------------------------------------------------------------
//
// Known-acceptable results, each with its reason; a stale entry — one whose cell
// has started behaving differently — is reported rather than ignored. Empty is
// the honest state, and the rule is left here rather than deleted because the
// first temptation on a dirty result is to add a row instead of a fix
// (`tools/README.md`: never ledger an undocumented defect).
const LEDGER = {};
const ledgerUsed = new Set();

const refs = (lua) => lua.info().bindingRefs;

// A context built the way every producer expects: callbacks object present, all
// libraries, plus whatever `perContext` asks for.
function makeContext(producer, n) {
  const options = { ...ALL, ...(producer?.perContext ? producer.perContext(n) : {}) };
  return new lua_native.init(producer?.callbacks ?? {}, options);
}

// Both collectors, every round, and the pairing is deliberate. A binding
// reference is released by a napi finalizer (JS heap) that is *queued* rather
// than run inline — `forceGc` awaits a turn of the event loop between
// collections for exactly that reason, and getting it wrong is what made
// `gc-stress`'s first run report a 40-slot leak that was its own. But the entry
// that finalizer releases is often keyed off a *Lua* object's `__gc`, which only
// a Lua collection runs. Either alone leaves half the reclaim paths untouched
// and reports the residue as a leak.
async function collectBoth(lua) {
  lua.gc('collect');
  lua.gc('collect');
  await forceGc();
  lua.gc('collect');
}

// --- the verdict ------------------------------------------------------------
//
// One function, so the controls test the same code the matrix uses: a classifier
// the controls cannot reach is a classifier nobody has checked. `series` is the
// per-round counts; `calls` is how many registrations the series performed, which
// is what APPEND_ONLY is allowed to grow by.
function classify(container, series, { calls = 0 } = {}) {
  const measured = series.slice(WARMUP);
  const first = measured[0];
  const last = measured[measured.length - 1];
  const grew = last - first;

  if (container.policy === 'TRANSIENT') {
    return measured.every((v) => v === 0)
      ? { verdict: 'OK', detail: `zero at rest in all ${measured.length} rounds` }
      : { verdict: 'RESIDUE', detail: `non-zero at rest: ${series.join(',')}` };
  }

  if (container.policy === 'APPEND_ONLY') {
    // Growth is the contract; growing by more than one per call is not.
    const allowed = calls;
    return grew <= allowed
      ? { verdict: 'OK', detail: `grew ${grew} over ${allowed} registrations (bound ${allowed})` }
      : { verdict: 'LEAK', detail: `grew ${grew} over ${allowed} registrations: ${series.join(',')}` };
  }

  if (container.policy === 'SINGLETON') {
    const bound = container.bound ?? first;
    if (measured.some((v) => v > bound)) {
      return { verdict: 'LEAK', detail: `exceeded bound ${bound}: ${series.join(',')}` };
    }
    return grew <= 0
      ? { verdict: 'OK', detail: `flat at ${last}, bound ${bound}` }
      : { verdict: 'LEAK', detail: `grew ${grew} within bound but not flat: ${series.join(',')}` };
  }

  if (container.policy === 'KEYED') {
    return grew <= 0
      ? { verdict: 'OK', detail: `flat at ${last} across ${measured.length} rounds` }
      : { verdict: 'LEAK', detail: `grew ${grew} over ${measured.length} rounds: ${series.join(',')}` };
  }

  return { verdict: 'HARNESS FAULT', detail: `no rule for policy ${container.policy}` };
}

// --- controls ---------------------------------------------------------------
//
// A leak detector that can only report clean is not one. Each control shows this
// harness can report a *specific* kind of dirt, not merely that it runs.
async function runControls() {
  const checks = [
    {
      name: 'the accessor exists and reports every declared container',
      run: () => {
        const r = refs(makeContext(null, 0));
        const missing = CONTAINERS.filter((c) => typeof r[c.field] !== 'number');
        if (missing.length) console.log(`      no counter for: ${missing.map((c) => c.field).join(', ')}`);
        const extra = Object.keys(r).filter((k) => k !== 'total' && !policyFor(k));
        if (extra.length) console.log(`      counter with no policy: ${extra.join(', ')}`);
        return missing.length === 0 && extra.length === 0;
      },
    },
    {
      name: 'total is the sum of the parts (one source of truth)',
      run: () => {
        const lua = makeContext(null, 0);
        lua.set_global('f', () => 1);
        lua.set_userdata('u', { a: 1 });
        const r = refs(lua);
        const sum = Object.entries(r).filter(([k]) => k !== 'total')
          .reduce((a, [, v]) => a + v, 0);
        return sum === r.total && r.total > 0;
      },
    },
    {
      name: 'a KEYED container that really grows is reported as a LEAK',
      run: () => classify({ policy: 'KEYED' },
        Array.from({ length: ROUNDS }, (_, i) => 10 + i)).verdict === 'LEAK',
    },
    {
      name: 'a flat series is not reported',
      run: () => classify({ policy: 'KEYED' }, Array(ROUNDS).fill(7)).verdict === 'OK',
    },
    {
      name: 'a TRANSIENT container reading non-zero at rest is reported',
      run: () => classify({ policy: 'TRANSIENT' }, Array(ROUNDS).fill(1)).verdict === 'RESIDUE',
    },
    {
      name: 'an APPEND_ONLY container growing by two per call is reported',
      run: () => {
        const twoPerCall = Array.from({ length: ROUNDS }, (_, i) => 2 * (i + 1));
        return classify({ policy: 'APPEND_ONLY' }, twoPerCall,
          { calls: ROUNDS - WARMUP - 1 }).verdict === 'LEAK';
      },
    },
    {
      name: '...and growing by one per call is not',
      run: () => {
        const onePerCall = Array.from({ length: ROUNDS }, (_, i) => i + 1);
        return classify({ policy: 'APPEND_ONLY' }, onePerCall,
          { calls: ROUNDS - WARMUP - 1 }).verdict === 'OK';
      },
    },
    {
      name: 'a SINGLETON exceeding its bound is reported',
      run: () => classify({ policy: 'SINGLETON', bound: 4 },
        Array(ROUNDS).fill(5)).verdict === 'LEAK',
    },
    {
      name: 'collateral growth in a field the cell was not aimed at is reported',
      run: () => {
        const rising = Array.from({ length: ROUNDS }, (_, i) => ({
          callbacks: 1, searchers: 2 + i, total: 3 + i,
        }));
        const seen = collateralGrowth(rising, 'callbacks');
        return seen.length === 1 && seen[0].startsWith('searchers:');
      },
    },
    {
      name: '...and a flat non-target field is not',
      run: () => collateralGrowth(
        Array.from({ length: ROUNDS }, () => ({ callbacks: 1, searchers: 2, total: 3 })),
        'callbacks',
      ).length === 0,
    },
    {
      name: 'every declared container has a producer, and every producer a container',
      run: () => {
        const noProducer = CONTAINERS.filter((c) => !producerFor(c.field));
        const noPolicy = PRODUCERS.filter((p) => !policyFor(p.field));
        if (noProducer.length) console.log(`      no producer for: ${noProducer.map((c) => c.field).join(', ')}`);
        if (noPolicy.length) console.log(`      no policy for: ${noPolicy.map((p) => p.field).join(', ')}`);
        return noProducer.length === 0 && noPolicy.length === 0;
      },
    },
    {
      name: 'every declared policy is one the classifier implements',
      run: () => CONTAINERS.every((c) => POLICIES.includes(c.policy)),
    },
    {
      name: 'a reclaim claim and a reclaim producer imply each other',
      // A container claiming a reclaim path with nothing to exercise it would
      // have its strongest assertion silently unchecked; a mint/drop pair with
      // no claim is a series whose result nothing interprets.
      run: () => {
        let ok = true;
        for (const c of CONTAINERS) {
          const p = producerFor(c.field);
          const hasProducer = typeof p.mint === 'function' && typeof p.drop === 'function';
          if (Boolean(c.reclaimable) !== hasProducer) {
            console.log(`      ${c.field}: reclaimable=${Boolean(c.reclaimable)} but `
              + `${hasProducer ? 'has' : 'has no'} mint/drop`);
            ok = false;
          }
        }
        return ok;
      },
    },
    {
      name: 'each producer actually moves its own counter',
      // The per-cell vacuity check, and the one most likely to fire: a producer
      // pointed at an API that no-ops reports a beautifully flat series.
      //
      // Three shapes of proof, because three shapes of container. Most are
      // raised by a call; two are populated at construction and can only be
      // shown by contrast or scaling; one (asyncRefs) is *supposed* to be back
      // at zero by the time its producer returns. A single "did the call raise
      // it" rule would have declared three of the thirteen vacuous and been
      // wrong about all three.
      run: async () => {
        let ok = true;
        for (const p of PRODUCERS) {
          if (p.provesPopulation) {
            let proven = false;
            try {
              proven = await p.provesPopulation((n) => makeContext(p, n)) === true;
            } catch (e) {
              console.log(`      ${p.field}: population proof threw: ${e.message}`);
            }
            if (!proven) { console.log(`      ${p.field}: cannot show its counter responds`); ok = false; }
            continue;
          }
          if (p.field === 'asyncRefs') {
            if (!await asyncRefsHeldInFlight()) {
              console.log('      asyncRefs: never observed held in flight');
              ok = false;
            }
            continue;
          }
          const lua = makeContext(p, 1);
          const before = refs(lua)[p.field];
          try {
            await p.same(lua, 0);
          } catch (e) {
            console.log(`      ${p.field}: producer threw: ${e.message}`);
            ok = false;
            continue;
          }
          const after = refs(lua)[p.field];
          if (after <= before) {
            console.log(`      ${p.field}: ${before} -> ${after}, the producer moved nothing`);
            ok = false;
          }
        }
        return ok;
      },
    },
  ];

  console.log('Control (a search that reports clean must first report dirty):\n');
  let bad = 0;
  for (const c of checks) {
    let ok = false;
    try { ok = await c.run(); } catch (e) { console.log(`  threw: ${e.stack}`); }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
    if (!ok) bad += 1;
  }
  console.log('');
  return bad === 0;
}

// Show that the async trio is genuinely held while a run is in flight, so the
// matrix's "zero at rest" assertion is a real drain rather than a counter that
// was never raised.
//
// The reading cannot be taken directly: `info()` refuses while the context is
// busy, for the reason stated at `LuaContext::Info` — a worker thread is
// mutating the allocator counter, so reading it concurrently is a data race.
// That refusal is observable, and it is the strongest in-flight evidence
// available without a second accessor that bypasses the busy guard. Stated
// plainly because it is weaker than the other twelve proofs: it establishes that
// a run is in flight and unreadable, then that the count is zero once it settles.
async function asyncRefsHeldInFlight() {
  const lua = makeContext(null, 0);
  const pending = lua.execute_script_async('local s = 0 for i = 1, 2000000 do s = s + i end return s');
  let refused = false;
  try { refs(lua); } catch { refused = true; }
  await pending;
  return refused && refs(lua).asyncRefs === 0;
}

// --- the series -------------------------------------------------------------

// Repeat the SAME registration. Refusals are counted, not swallowed: for
// `classes` the refusal IS the mechanism (L7), and a producer that started
// refusing everywhere would otherwise read as a flawless flat line.
async function seriesRepeat(container, producer) {
  const lua = makeContext(producer, 1);
  const series = [];
  let refusals = 0;
  let calls = 0;

  for (let n = 0; n < ROUNDS; n += 1) {
    try {
      await producer.same(lua, n);
      calls += 1;
    } catch {
      refusals += 1;
    }
    if (producer.settle) producer.settle(lua);
    await collectBoth(lua);
    series.push(refs(lua)[container.field]);
  }
  // Registrations performed after the warm-up — what APPEND_ONLY may grow by.
  const countedCalls = Math.max(0, calls - WARMUP - 1);
  return { series, refusals, calls, countedCalls };
}

// A fixed population, then nothing but reset and collection — **the population
// is established once, outside the loop, and never repeated.**
//
// That "never repeated" is load-bearing and it is the third thing this harness
// got wrong. Re-running the producer after each reset made the three APPEND_ONLY
// containers grow by one per round and the harness called it a leak for the
// second time, in a second way: a container with no removal API grows when you
// register something, and the loop was registering something. The series that
// answers "does a reset add anything" must contain nothing but resets.
//
// What each policy claims here: KEYED drops to its fresh baseline and stays
// (reset clears it); APPEND_ONLY and SINGLETON hold their populated level
// (reset replays them, and a replay that appended instead of re-establishing
// would show as a rise).
// Full snapshots are kept, not just the target field: `searchers` is the reason.
// Reset replays each searcher by minting a **fresh** `js_callbacks_` name from a
// monotonic counter (CR-9 F3), so a replay that stacked would grow the callbacks
// map in the searcher producer's context — a container the searcher cell is not
// looking at. Watching one counter per cell would have made that invisible; every
// field is checked in every context, which turns 13 cells into 13 x 13
// observations for the price of reading an object that was already being built.
async function seriesEvent(container, producer) {
  const lua = makeContext(producer, 1);
  await producer.fixed(lua);
  if (producer.settle) producer.settle(lua);
  const populated = refs(lua)[container.field];
  const snapshots = [];

  for (let n = 0; n < ROUNDS; n += 1) {
    lua.reset();
    await collectBoth(lua);
    snapshots.push(refs(lua));
  }
  return { series: snapshots.map((s) => s[container.field]), snapshots, populated };
}

// Any counter that rises across a series of pure resets, in any context. The
// collateral half of the event series: `container` says which field the cell was
// aimed at, and this reports the others.
function collateralGrowth(snapshots, targetField) {
  const measured = snapshots.slice(WARMUP);
  if (measured.length < 2) return [];
  const first = measured[0];
  const last = measured[measured.length - 1];
  return Object.keys(last)
    .filter((k) => k !== 'total' && k !== targetField && last[k] > first[k])
    .map((k) => `${k}: ${snapshots.map((s) => s[k]).join(',')}`);
}

// The cross-product the pure event series deliberately drops: re-establish the
// population *after* each reset. This is where "reset, then register again"
// could stack in a way neither `repeat` (no resets) nor `event` (no repeated
// registrations) would reach — and for a KEYED container, whose entries a reset
// clears, it is the only series that exercises re-population at all.
async function seriesCycle(container, producer) {
  const lua = makeContext(producer, 1);
  const series = [];
  let calls = 0;

  for (let n = 0; n < ROUNDS; n += 1) {
    lua.reset();
    try {
      await producer.fixed(lua, n);
      calls += 1;
    } catch { /* an L7 refusal is a correct answer; counted via `calls` */ }
    if (producer.settle) producer.settle(lua);
    await collectBoth(lua);
    series.push(refs(lua)[container.field]);
  }
  return { series, calls, countedCalls: Math.max(0, calls - WARMUP - 1) };
}

// Mint the reclaimable form, drop it, collect, require baseline.
async function seriesReclaim(container, producer) {
  const lua = makeContext(producer, 1);
  const baseline = refs(lua)[container.field];
  const series = [];

  for (let n = 0; n < ROUNDS; n += 1) {
    await producer.mint(lua, n);
    await producer.drop(lua, n);
    await collectBoth(lua);
    series.push(refs(lua)[container.field]);
  }
  return { series, baseline };
}

// --- the matrix -------------------------------------------------------------

async function main() {
  if (!await runControls()) {
    console.error('controls failed; refusing to run a search that cannot report dirty.');
    process.exit(1);
  }
  if (controlOnly) return;

  const containers = CONTAINERS.filter((c) => !onlyField || c.field === onlyField);
  const findings = [];
  let cells = 0;

  console.log(`--- repeat: the same registration x${ROUNDS} `
    + `(first ${WARMUP} rounds discarded as warm-up)\n`);
  for (const container of containers) {
    const producer = producerFor(container.field);
    const { series, refusals, calls, countedCalls } = await seriesRepeat(container, producer);
    cells += 1;
    if (calls === 0) {
      findings.push({
        kind: 'VACUOUS CELL',
        id: `repeat / ${container.field}`,
        detail: 'every round refused; the series measured nothing',
      });
      console.log(`  ${'VACUOUS'.padEnd(9)} ${container.field.padEnd(18)} all ${ROUNDS} rounds refused`);
      continue;
    }
    const { verdict, detail } = classify(container, series, { calls: countedCalls });
    record(findings, `repeat / ${container.field}`, container, verdict,
      refusals ? `${detail} (${refusals} rounds refused — expected for L7 names)` : detail);
  }

  console.log(`\n--- event: fixed population, then x${ROUNDS} reset + collect (no re-registration)\n`);
  for (const container of containers) {
    const producer = producerFor(container.field);
    cells += 1;
    const { series, snapshots, populated } = await seriesEvent(container, producer);
    // Every policy says the same thing here, so they all get the same rule: the
    // population is held fixed, therefore any growth was added by the event.
    const { verdict, detail } = classify({ ...container, policy: 'KEYED' }, series);
    record(findings, `event / ${container.field}`, container, verdict,
      `${detail} (populated ${populated} before the resets)`);

    const collateral = collateralGrowth(snapshots, container.field);
    for (const line of collateral) {
      findings.push({
        kind: 'COLLATERAL GROWTH',
        id: `event / ${container.field}`,
        detail: `a counter the cell was not aimed at rose across pure resets — ${line}`,
      });
      console.log(`  ${'COLLATERAL'.padEnd(9)} ${''.padEnd(18)} ${line}`);
    }
  }

  console.log(`\n--- cycle: x${ROUNDS} (reset + re-register + collect)\n`);
  for (const container of containers) {
    const producer = producerFor(container.field);
    cells += 1;
    const { series, calls, countedCalls } = await seriesCycle(container, producer);
    if (calls === 0) {
      findings.push({
        kind: 'VACUOUS CELL',
        id: `cycle / ${container.field}`,
        detail: 'every round refused; the series measured nothing',
      });
      console.log(`  ${'VACUOUS'.padEnd(9)} ${container.field.padEnd(18)} all ${ROUNDS} rounds refused`);
      continue;
    }
    const { verdict, detail } = classify(container, series, { calls: countedCalls });
    record(findings, `cycle / ${container.field}`, container, verdict, detail);
  }

  const reclaimable = containers.filter((c) => c.reclaimable);
  console.log(`\n--- reclaim: mint the reclaimable form, drop it, collect (${reclaimable.length} containers)\n`);
  for (const container of reclaimable) {
    const producer = producerFor(container.field);
    cells += 1;
    const { series, baseline } = await seriesReclaim(container, producer);
    const { verdict, detail } = classify(container, series);
    const settled = series[series.length - 1];
    const backToBaseline = settled === baseline;
    record(findings, `reclaim / ${container.field}`, container,
      verdict === 'OK' && !backToBaseline ? 'LEAK' : verdict,
      backToBaseline ? `${detail}, back at baseline ${baseline}`
        : `settled at ${settled}, baseline ${baseline}: ${series.join(',')}`);
  }

  for (const key of Object.keys(LEDGER)) {
    if (!ledgerUsed.has(key)) {
      findings.push({ kind: 'STALE LEDGER ENTRY', id: key, detail: 'no such cell in this run' });
    }
  }

  console.log(`\n${cells} cells: ${containers.length} containers x `
    + `(repeat, event, cycle) + ${reclaimable.length} reclaim, ${ROUNDS} rounds each, `
    + `plus ${containers.length * (CONTAINERS.length - 1)} collateral observations. `
    + `${Object.keys(LEDGER).length} ledger entries, `
    + `${Object.keys(NOT_COUNTED).length} members deliberately not counted`);
  console.log(`  FINDINGS  ${findings.length}`);
  for (const f of findings) console.log(`\n${f.kind}  ${f.id}\n  ${f.detail}`);
  console.log(findings.length ? '\ndirty.' : '\nclean.');
  process.exit(findings.length ? 1 : 0);
}

function record(findings, key, container, verdict, detail) {
  const entry = LEDGER[key];
  if (entry) {
    ledgerUsed.add(key);
    if (entry.expect !== verdict) {
      findings.push({
        kind: 'STALE LEDGER ENTRY',
        id: key,
        detail: `ledgered as ${entry.expect}, observed ${verdict} — re-read the reason`,
      });
    }
    console.log(`  ${`LEDGERED(${verdict})`.padEnd(9)} ${container.field.padEnd(18)} ${detail}`);
    return;
  }
  if (verdict !== 'OK') {
    findings.push({ kind: verdict, id: key, detail: `${container.policy}: ${detail}` });
  }
  console.log(`  ${verdict.padEnd(9)} ${container.field.padEnd(18)} ${detail}`);
}

main();
