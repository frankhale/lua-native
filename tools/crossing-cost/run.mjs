// The crossing-cost search: what does the binding cost, and does it cost what
// the documentation says?
//
//   node tools/crossing-cost/run.mjs             # everything
//   node tools/crossing-cost/run.mjs --control   # just the controls
//   node tools/crossing-cost/run.mjs --claims    # just Axis A
//   node tools/crossing-cost/run.mjs --shape     # just Axis B and C
//
// **The region, declared up front** (`CORRECTNESS.md` §15.9's first obligation).
// Nine harnesses ask whether an answer is *right*. None asked what it *costs*,
// and `CORRECTNESS.md` §15.2 — the list of areas deliberately not covered, where
// every row must name the criterion clause it fails — had no row for cost at
// all. It was not excluded; it was never considered. Meanwhile shipped
// documentation made nine performance claims with no number, no test and no
// harness behind any of them, four of which tell the reader to route on them.
//
// **This is not a boundary** (§15.1). A cost defect returns the *correct*
// answer, slowly: there is no mismatch, so the criterion does not apply. Filed
// as a cost search alongside `binding-balance`'s resource-lifetime search.
//
// **Everything here is a ratio or a shape**, never an elapsed time compared
// against a stored one. `expected.json` holds no timings and never should; a
// 5%-drift detector on a laptop reports dirt whose source is the instrument.
// `measure.mjs` carries the reasoning, and `FINDINGS.md` carries the six
// instrument defects that got it there.

import { calibrateReps, noiseFloor, fmtNs, pct, sinkValue, whichBinary } from './measure.mjs';
import { runControls } from './controls.mjs';
import { runClaims, runProductControl } from './claims.mjs';
import { runB1, runB2, runC } from './shape.mjs';
import { DOOR_NOTES, SHAPE_NOTES, ONCE_ONLY_REASON, staleEntries } from './accepted.mjs';

const argv = process.argv.slice(2);
const only = (f) => argv.includes(f);
const all = !only('--control') && !only('--claims') && !only('--shape');

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(`--- ${s} ${'-'.repeat(Math.max(0, 66 - s.length))}`); };

let failures = 0;
let vacuous = 0;
const record = (r) => {
  if (r.verdict === 'FAIL') failures++;
  else if (r.verdict === 'VACUOUS') vacuous++;
};

const show = (r, extra) => {
  record(r);
  line(`  ${String(r.verdict).padEnd(9)} ${r.id}`);
  if (r.describe) line(`            ${r.describe}`);
  if (r.proposition) line(`            claim: ${r.proposition}`);
  if (r.detail) line(`            ${r.detail}`);
  if (Number.isFinite(r.exponent)) {
    line(`            exponent ${r.exponent.toFixed(2)} -> ${r.observed}`
      + (r.declared ? ` (declared ${r.declared})` : ''));
  }
  if (Number.isFinite(r.ratio) && !Number.isFinite(r.exponent)) line(`            ratio ${r.ratio.toFixed(2)}`);
  if (extra) line(`            ${extra}`);
  if (r.reason) line(`            ${r.reason}`);
};

// ---------------------------------------------------------------------------
// The noise floor, measured before anything else. Every verdict below is
// relative to it, and a run whose floor is wide is a run whose results should
// not be trusted — so it is printed rather than folded away.
// ---------------------------------------------------------------------------
const probe = () => { let a = 0; for (let i = 0; i < 2000; i++) a += i % 7; return a; };
const probeReps = await calibrateReps(probe, { targetMs: 12 });
const NOISE = await noiseFloor(probe, { reps: probeReps });

const BIN = whichBinary();
line('crossing-cost — what the binding costs, and whether the docs are right about it');
line(`binary:      ${BIN.kind}  ${BIN.path}  (built ${BIN.mtime})`);
if (!BIN.optimised) {
  line('  NOTE: this is the DEBUG build, which index.js resolves first. It is roughly 3-12x');
  line('  slower than release, and unevenly so across operations. Every shape and ratio verdict');
  line('  below still holds — that is what ratios are for — but do not quote an absolute figure');
  line('  from this run as what a user experiences. Measure release for that:');
  line('    npm run build-release  (note: `rebuild` wipes build/Debug; npm run build-debug after)');
}
line(`noise floor: ${pct(NOISE)} (two measurements of identical work differ by this much on this machine now)`);
if (NOISE > 0.25) {
  line('  WARNING: that floor is wide. Something else is using this machine; results below are');
  line('  weak evidence at best. Re-run on a quiet machine before believing any FAIL.');
}

// ---------------------------------------------------------------------------
// Controls first, and the run refuses to proceed if they fail.
//
// An exhaustive search that reports clean must first demonstrate it can report
// dirty. The classifier controls prove the shape machinery works on synthetic
// inputs of known shape; the product control proves the claims axis is wired to
// the binding at all.
// ---------------------------------------------------------------------------
head('controls');
const controls = await runControls(NOISE);
const productControl = await runProductControl(NOISE);
for (const c of controls) {
  if (c.verdict === 'NOTE') { line(`  NOTE      ${c.id}`); line(`            ${c.describe}`); continue; }
  show(c);
}
show(productControl);

const badControls = [...controls, productControl].filter((c) => c.verdict !== 'PASS' && c.verdict !== 'NOTE');
if (badControls.length > 0) {
  line();
  line(`REFUSING TO PROCEED: ${badControls.length} control(s) failed.`);
  line('A classifier that cannot tell O(n) from O(n^2) on an input built to be one of them,');
  line('or a claims axis that does not move when work is injected into the product, cannot');
  line('rule on anything. Fix the instrument before reading a single verdict below.');
  process.exit(2);
}
if (only('--control')) {
  line('\ncontrols only: all passed.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Axis A — the documented claims.
// ---------------------------------------------------------------------------
let claims = [];
if (all || only('--claims')) {
  head('Axis A — shipped performance claims');
  claims = await runClaims(NOISE);
  for (const c of claims) show(c, `site: ${c.site}`);
}

// ---------------------------------------------------------------------------
// Axis B and C — cost shape and the scaling knobs.
// ---------------------------------------------------------------------------
let b1 = null;
let shapes = [];
if (all || only('--shape')) {
  head('Axis B1 — per-door cost, as a multiple of the cheapest door');
  b1 = await runB1();
  line(`  ${b1.doorCount} doors from roundtrip-matrix: ${b1.rows.length} repeatable, ${b1.onceOnly.length} once-only`);
  line(`  cheapest: ${b1.cheapest.id} at ${fmtNs(b1.cheapest.ns)}`);
  for (const r of [...b1.rows].sort((a, b) => (a.ns ?? Infinity) - (b.ns ?? Infinity))) {
    if (r.error) { line(`    ERROR             ${r.id}: ${r.error}`); failures++; continue; }
    line(`    ${r.ratio.toFixed(1).padStart(6)}x ${fmtNs(r.ns).padStart(9)}  ${r.id}${r.async ? ' (async)' : ''}`);
    if (DOOR_NOTES[r.id]) line(`              ${DOOR_NOTES[r.id]}`);
  }
  if (b1.onceOnly.length) {
    line(`  once-only (not ratio-comparable) — ${ONCE_ONLY_REASON}`);
    for (const r of b1.onceOnly) line(`    ${fmtNs(r.ns ?? 0).padStart(9)}  ${r.id}`);
  }

  head('Axis B2 — complexity class per value kind');
  const b2 = await runB2(NOISE);
  for (const c of b2) show(c);

  head('Axis C — the scaling knobs');
  const c = await runC(NOISE);
  for (const r of c) show(r, SHAPE_NOTES[r.id]);
  shapes = [...b2, ...c];
}

// ---------------------------------------------------------------------------
// Stale ledger entries — an excuse that no longer refers to anything is
// reported, not silently kept.
// ---------------------------------------------------------------------------
if (b1) {
  const stale = staleEntries({
    doorIds: b1.rows.map((r) => r.id),
    onceOnlyIds: b1.onceOnly.map((r) => r.id),
    shapeIds: shapes.map((s) => s.id),
  });
  if (stale.length) {
    head('stale ledger entries');
    for (const s of stale) line(`  STALE     ${s}`);
    failures += stale.length;
  }
}

head('summary');
const cells = [...claims, ...shapes];
line(`  cells: ${cells.length}   failures: ${failures}   vacuous: ${vacuous}`);
line(`  noise floor: ${pct(NOISE)}   (sink ${sinkValue()}, printed so no workload above is dead code)`);
if (vacuous > 0) {
  line('  A VACUOUS cell measured nothing — it is not a pass. Fix the cell or delete it;');
  line('  see FINDINGS.md H6 for what that usually means.');
}
if (failures > 0) {
  line();
  line('  Before believing any failure above: reproduce it by hand.');
  line('  Six of the defects found building this harness were the harness misreading itself,');
  line('  and two of them looked exactly like a product finding first (FINDINGS.md H4, H5).');
}
process.exit(failures > 0 ? 1 : 0);
