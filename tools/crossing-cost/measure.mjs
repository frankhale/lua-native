// Timing primitives for the cost search.
//
// **The one design decision everything here serves** (`PERFORMANCE-PLAN` §4):
// nothing in this harness compares an elapsed time against a stored elapsed
// time. Every verdict is a *ratio between two measurements taken in the same
// process*. Machine speed, thermal state, Node version and CPU generation all
// cancel in a ratio; none of them cancel in a frozen nanosecond baseline, which
// is why `expected.json` holds no timings and never should. A 5%-drift detector
// on a laptop reports dirt whose source is the instrument, and that is this
// tree's most expensive recurring failure (`tools/README.md`: a search that
// reports dirty must show the dirt is in the subject).
//
// Four things below are load-bearing. Two of them were arrived at by getting
// them wrong first, in the first hour of building this; `FINDINGS.md` H2 and H3
// carry the reproductions, and both were predicted by `PERFORMANCE-PLAN` §12.1.
//
//   1. **Warm up by call count, not by batch count** (H3, the sharp one). V8
//      promotes a function to an optimising tier after a few thousand calls. A
//      batch-count warmup gives a closure measured at reps=800 a different tier
//      from the same closure measured at reps=13312 — so a ratio between two
//      such measurements compares *tiers*, not costs. Measured directly: the
//      identical 10x comparison returned 9.84, 17.59, 17.63, 10.36, 9.96 and
//      9.91 as reps varied, and returns 9.90 ± 0.02 at every one of those reps
//      once each closure is warmed past `MIN_WARM_CALLS`. Everything this
//      harness says rests on that constant.
//
//   2. **Do not `await` a synchronous workload** (H2). `await` on a non-thenable
//      still allocates a promise and schedules a microtask: measured at 39.6ns
//      per call against 1.5ns for a direct call, a 26x tax that lands entirely
//      on the cheapest cells — precisely the ones (a number crossing out of
//      Lua) where a claim is at stake. `timePerCall` probes the workload once
//      and takes a straight-line synchronous path when it can.
//
//   3. **min, not mean.** Measurement noise is one-sided: a preemption, a GC
//      pause or a thermal step can only make a sample slower. The minimum of N
//      samples is the best available estimate of true cost; the mean estimates
//      the cost plus whatever else the machine was doing. The median is
//      reported alongside, so a run whose min and median diverge is visible as
//      the busy machine it is.
//
//   4. **The sink defeats dead-code elimination.** A workload whose result is
//      unused may be deleted, and a deleted workload times at ~0ns and reads as
//      a spectacular result. Every measured call's result goes through
//      `consume()`.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A value the run prints at the end. Its content is meaningless; its existence
// is what keeps a workload from being optimised away.
let SINK = 0;

export function consume(v) {
  if (v === undefined || v === null) { SINK += 1; return; }
  switch (typeof v) {
    case 'number': SINK += v === 0 ? 0 : 1; break;
    case 'string': SINK += v.length === 0 ? 0 : 1; break;
    case 'boolean': SINK += v ? 1 : 0; break;
    default: SINK += 1;
  }
}

export function sinkValue() { return SINK; }

const now = () => process.hrtime.bigint();

// The tier threshold, with headroom. See note 1 — this is the constant that
// makes a ratio mean anything, and lowering it silently reintroduces H3.
const MIN_WARM_CALLS = 4000;
const MIN_WARM_MS = 12;

// True when calling `fn` produces a thenable, i.e. the workload must be
// awaited. Probed once, off the measured path.
async function isAsync(fn) {
  const r = fn(0);
  if (r && typeof r.then === 'function') { await r; return true; }
  consume(r);
  return false;
}

function warmSync(fn) {
  let calls = 0;
  const t0 = now();
  for (;;) {
    consume(fn(calls));
    calls++;
    if (calls >= MIN_WARM_CALLS && Number(now() - t0) / 1e6 >= MIN_WARM_MS) return calls;
    if (calls > 5_000_000) return calls;
  }
}

async function warmAsync(fn) {
  let calls = 0;
  const t0 = now();
  for (;;) {
    consume(await fn(calls));
    calls++;
    // Async workloads are orders of magnitude more expensive per call, so the
    // call-count floor is relaxed — reaching 4000 calls on a worker-thread door
    // would take minutes and the tier effect it guards against is swamped by
    // the door's own cost anyway.
    if (calls >= 200 && Number(now() - t0) / 1e6 >= MIN_WARM_MS) return calls;
    if (calls > 200_000) return calls;
  }
}

// Nanoseconds per call, taking the minimum across `samples` batches of `reps`
// calls each.
export async function timePerCall(fn, { reps, samples = 7, async: forceAsync = null } = {}) {
  const useAsync = forceAsync ?? await isAsync(fn);
  const warmed = useAsync ? await warmAsync(fn) : warmSync(fn);

  const runs = [];
  if (useAsync) {
    for (let s = 0; s < samples; s++) {
      const t0 = now();
      for (let i = 0; i < reps; i++) consume(await fn(i));
      runs.push(Number(now() - t0) / reps);
    }
  } else {
    for (let s = 0; s < samples; s++) {
      const t0 = now();
      for (let i = 0; i < reps; i++) consume(fn(i));
      runs.push(Number(now() - t0) / reps);
    }
  }
  runs.sort((a, b) => a - b);
  return {
    ns: runs[0],
    median: runs[(runs.length / 2) | 0],
    worst: runs[runs.length - 1],
    reps,
    warmed,
    async: useAsync,
    samples: runs.length,
  };
}

// Picks `reps` so a batch lasts `targetMs`. Runs after warmup, so it is
// calibrating the steady-state cost rather than the cold one.
export async function calibrateReps(fn, { targetMs = 20, cap = 2_000_000 } = {}) {
  const useAsync = await isAsync(fn);
  let reps = 1;
  for (;;) {
    const t0 = now();
    if (useAsync) { for (let i = 0; i < reps; i++) consume(await fn(i)); }
    else { for (let i = 0; i < reps; i++) consume(fn(i)); }
    const elapsed = Number(now() - t0) / 1e6;
    if (elapsed >= targetMs || reps >= cap) return reps;
    const growth = elapsed > 0.05 ? Math.ceil((targetMs / elapsed) * 1.3) : 8;
    reps = Math.min(cap, Math.max(reps + 1, reps * Math.min(growth, 32)));
  }
}

// Measures the same workload twice, independently, and returns how far apart
// the two answers were — repeated `rounds` times, worst disagreement wins,
// because the floor has to cover the run's bad moments and not its good ones.
//
// Returns a relative figure: 0.04 means two measurements of identical work
// differed by 4%, so nothing below 4% means anything on this machine today.
export async function noiseFloor(fn, { reps, rounds = 4 } = {}) {
  let worst = 0;
  for (let r = 0; r < rounds; r++) {
    const a = await timePerCall(fn, { reps, samples: 5 });
    const b = await timePerCall(fn, { reps, samples: 5 });
    const lo = Math.min(a.ns, b.ns);
    if (lo <= 0) return 1;
    worst = Math.max(worst, Math.abs(a.ns - b.ns) / lo);
  }
  // A floor is a floor. Even on a perfectly quiet machine, refuse to believe
  // differences under 2%: below that the estimator's own discretisation matters
  // more than the subject does.
  return Math.max(worst, 0.02);
}

// Which binary is being measured, and is it the optimised one?
//
// **The omission this closes was found by a reader asking what the harness
// bought, not by the harness** (FINDINGS.md H8). `index.js` resolves
// `build/Debug` before `build/Release` before `prebuilds/`, so a developer
// running this measures the **debug** build by default — and debug is 2.7x to
// 12x slower than release on the same source, unevenly across operations. Every
// shape verdict survives that (a ratio is why), but a reader taking an absolute
// figure away from a run needs to know which binary produced it, and a cell
// whose ratio is between two paths with different debug overhead deserves a
// second look on release.
//
// `diff-oracle` sets the precedent: it prints both Lua versions and warns when
// they differ, because an instrument that does not say what it measured is
// asking to be misquoted.
export function whichBinary() {
  // Mirrors index.js's resolution order. If that order changes, this reports
  // the wrong binary — which is why the run prints the path it believes it
  // measured rather than only a label, so the two can be compared by eye.
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const candidates = [
    ['DEBUG', 'build/Debug/lua-native.node'],
    ['release', 'build/Release/lua-native.node'],
    ['prebuild', `prebuilds/${process.platform}-${process.arch}/lua-native.node`],
  ];
  for (const [kind, rel] of candidates) {
    const abs = join(root, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    return { kind, path: rel, mtime: st.mtime.toISOString().slice(0, 10), optimised: kind !== 'DEBUG' };
  }
  return { kind: 'unknown', path: '(none found)', mtime: '?', optimised: false };
}

export const fmtNs = (ns) => (ns >= 1e6 ? `${(ns / 1e6).toFixed(2)}ms`
  : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)}µs`
    : `${ns.toFixed(0)}ns`);

export const pct = (x) => `${(x * 100).toFixed(1)}%`;
