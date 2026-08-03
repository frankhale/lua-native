#!/usr/bin/env node
// Reports drift between the invariants computed from the source and the frozen
// answers in `expected.json`.
//
//   node tools/invariants/run.mjs            # exit 1 on drift
//   node tools/invariants/run.mjs --update   # re-freeze after a reviewed change

import { writeFileSync } from 'node:fs';
import { INVARIANTS, EXPECTED_PATH, computeAll, readExpected, diffInvariant } from './invariants.mjs';

const update = process.argv.includes('--update');
const actual = computeAll();

if (update) {
  writeFileSync(EXPECTED_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`froze ${INVARIANTS.length} invariants -> ${EXPECTED_PATH}`);
  process.exit(0);
}

let expected;
try {
  expected = readExpected();
} catch (e) {
  console.error(`cannot read ${EXPECTED_PATH}: ${e.message}`);
  console.error('run with --update to create it');
  process.exit(1);
}

let dirty = 0;
for (const inv of INVARIANTS) {
  const drift = diffInvariant(actual[inv.id], expected[inv.id]);
  const n = Object.keys(actual[inv.id]).length;
  if (drift.length === 0) {
    console.log(`ok    ${inv.id}  (${n} entries)`);
    continue;
  }
  dirty++;
  console.log(`DRIFT ${inv.id}  (${n} entries)`);
  console.log(`      ${inv.title}`);
  if (inv.note) console.log(`      ${inv.note}`);
  for (const line of drift) console.log(`      ${line}`);
}

if (dirty > 0) {
  console.log(`\n${dirty} invariant(s) drifted. Review the change, then re-freeze with:`);
  console.log('  node tools/invariants/run.mjs --update');
  process.exit(1);
}
console.log('\nall invariants match.');
