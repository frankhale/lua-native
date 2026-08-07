// Positive controls for the classifier.
//
// `tools/README.md`, first convention: an exhaustive search that reports clean
// must first demonstrate it can report dirty. Here the subject under control is
// **the classifier, not the product** — these workloads touch no Lua at all.
// Their shapes are known by construction, so if the classifier misreads one of
// them, every verdict downstream is worthless and the run must not proceed.
//
// The product-wiring control (a deliberately slowed converter, which must move
// `A2-converter-scan` off its expected slope) lives in `claims.mjs`, next to
// the cell it controls: it proves a different thing — that the claims axis is
// connected to the binding at all.
//
// **One of these was wrong in the plan, and the record is the point.**
// `PERFORMANCE-PLAN` §6 proposed "string concatenation in a loop" as the
// known-quadratic workload. It is not quadratic in V8: `s += x` builds a rope
// (a cons-string) in O(1) and only flattens on demand, so the loop is linear
// and the control would have failed — or worse, been "fixed" by widening the
// quadratic band until it passed, which is how a classifier gets talked into
// agreeing with whatever it is shown. Measured, then replaced with a nested
// loop, whose shape is not a runtime's choice. See `FINDINGS.md` H1.

import { calibrateReps, timePerCall } from './measure.mjs';
import { classify, ratioVerdict } from './classify.mjs';

const SIZES = [100, 1000, 10000];

// --- the workloads, each a known shape by construction ----------------------

// O(n): touch each element once.
function linearWork(n) {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += i % 7;
  return acc;
}

// O(n²): a nested loop. Not a rope, not a runtime's choice about strings, not
// something an optimiser can collapse while the accumulator is read.
function quadraticWork(n) {
  let acc = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) acc += (i ^ j) & 1;
  return acc;
}

// O(1): the argument is ignored, deliberately. This is the shape a disconnected
// knob produces, which is exactly why the CONSTANT verdict demands a witness.
function constantWork(_n) {
  let acc = 0;
  for (let i = 0; i < 50; i++) acc += i % 7;
  return acc;
}

// The rope workload the plan proposed, kept as a measured record rather than a
// claim. Reported, never asserted on: whether V8 flattens it is V8's business
// and could change, and a control that depends on that is not a control.
function ropeWork(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += 'x';
  return s.length;
}

// --- running them -----------------------------------------------------------

async function shapeOf(work, sizes = SIZES) {
  const pts = [];
  for (const n of sizes) {
    const fn = () => work(n);
    const reps = await calibrateReps(fn, { targetMs: 12 });
    const t = await timePerCall(fn, { reps, samples: 5 });
    pts.push({ n, ns: t.ns });
  }
  return pts;
}

export async function runControls(noise) {
  const results = [];

  // Control 1 — a known-linear workload must be classified LINEAR.
  const lin = await shapeOf(linearWork);
  results.push({
    id: 'classifier/linear',
    describe: 'a loop touching each of n elements once must classify LINEAR',
    ...classify(lin, { declared: 'LINEAR', noise }),
  });

  // Control 2 — a known-quadratic workload must be classified QUADRATIC.
  // Smaller sizes: n=10000 nested is 10^8 iterations.
  const quad = await shapeOf(quadraticWork, [30, 300, 3000]);
  results.push({
    id: 'classifier/quadratic',
    describe: 'a nested loop over n×n must classify QUADRATIC — the control that '
      + 'gives every shape verdict below its meaning',
    ...classify(quad, { declared: 'QUADRATIC', noise }),
  });

  // Control 3 — a workload that ignores n must classify CONSTANT, and must be
  // refused as VACUOUS when it cannot show the knob was connected.
  const con = await shapeOf(constantWork);
  results.push({
    id: 'classifier/constant',
    describe: 'a workload ignoring n classifies CONSTANT when a witness proves the knob moved',
    ...classify(con, { declared: 'CONSTANT', noise, witness: { label: 'synthetic: n reached the workload', moved: true } }),
  });

  // Control 3b — the same measurement with no witness must be REFUSED. This is
  // the control on the vacuity check itself: without it, "CONSTANT" would be
  // the verdict a disconnected knob earns, and Axis C is entirely knobs.
  const noWitness = classify(con, { declared: 'CONSTANT', noise });
  results.push({
    id: 'classifier/constant-needs-witness',
    describe: 'the same flat measurement, with no witness, must be refused as VACUOUS',
    verdict: noWitness.verdict === 'VACUOUS' ? 'PASS' : 'FAIL',
    reason: noWitness.verdict === 'VACUOUS'
      ? undefined
      : `expected VACUOUS without a witness, got ${noWitness.verdict} — a disconnected knob would pass as CONSTANT`,
  });

  // Control 4 — a workload doing 10x the work must measure ~10x, not merely
  // "more". A ratio check that only knows the *direction* of a change cannot
  // rule on A3's sampling bound, which is entirely a claim about magnitude.
  //
  // **The 10x is built by repetition, and that detail is the control** (H4).
  // The obvious construction — compare `work(1000)` against `work(10000)` — is
  // not a 1:10 pair on an optimising runtime: measured per iteration, the two
  // cost 0.452ns and 0.697ns, a 1.54x difference, because a loop bound the
  // compiler can see is a loop the compiler optimises differently. Built that
  // way this control reported 13.5x and 15.4x and would have been "fixed" by
  // widening the band until it passed. Repeating an *identical* inner call ten
  // times has no such freedom, and measures 10.05x.
  const one = () => linearWork(1000);
  const ten = () => { let a = 0; for (let k = 0; k < 10; k++) a += linearWork(1000); return a; };
  const repsA = await calibrateReps(one, { targetMs: 12 });
  const tA = await timePerCall(one, { reps: repsA, samples: 7 });
  const tB = await timePerCall(ten, { reps: Math.max(1, Math.round(repsA / 10)), samples: 7 });
  results.push({
    id: 'classifier/ten-times',
    describe: 'ten repetitions of an identical call must measure ~10x, not just "different"',
    ...ratioVerdict(tB.ns, tA.ns, 10, { noise }),
  });

  // Reported, not asserted: the plan's original proposal.
  const rope = await shapeOf(ropeWork);
  const ropeShape = classify(rope, { noise });
  results.push({
    id: 'classifier/rope-note',
    describe: `string += in a loop measures ${ropeShape.observed ?? 'UNKNOWN'}`
      + ' (exponent ' + (Number.isFinite(ropeShape.exponent) ? ropeShape.exponent.toFixed(2) : '?')
      + ') — recorded, never asserted; see FINDINGS.md H1',
    verdict: 'NOTE',
  });

  return results;
}
