// The smoke set under Node: is the set itself right?
//
//   node --expose-gc tools/wasm-smoke/run.mjs            # controls, then both targets
//   node --expose-gc tools/wasm-smoke/run.mjs --control  # just the controls
//
// The set's real run is in a browser (`tools/wasm-smoke/serve.mjs`). This is
// the check on the instrument: every cell is run against the **native addon**,
// where the suite has already settled what the right answer is, and against
// the node variant of the WASM build. A cell that is wrong about lua-native
// fails on the first; a cell that only passes in a page was never checked.
//
// Controls first, per `tools/README.md`: the set is run against a module that
// answers wrongly, and it must say so in every cell.

import path from 'node:path';
import url from 'node:url';
import { CELLS, runSmokeSet } from './set.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const controlOnly = process.argv.includes('--control');

const native = (await import(url.pathToFileURL(path.join(ROOT, 'index.js')).href)).default;
const wasm = (await import(url.pathToFileURL(path.join(ROOT, 'build-wasm', 'release', 'node', 'lua-native.mjs')).href)).default;

// A module whose every script and every async run answers with nothing. The
// contexts are real, so construction and `compile()` still work and the set
// gets as far as each cell's first question.
function sabotaged(module) {
  class Mute extends module.init {
    execute_script() { return undefined; }
    execute_async() { return Promise.resolve(undefined); }
    execute_script_async() { return Promise.resolve(undefined); }
    execute_file_async() { return Promise.resolve(undefined); }
    load_bytecode() { return undefined; }
    resume() { return { status: 'dead', values: [] }; }
  }
  return { init: Mute, createSharedTable: module.createSharedTable };
}

console.log('Controls');
let broken = 0;
for (const [name, module] of [['native', native], ['wasm', wasm]]) {
  const { results } = await runSmokeSet(sabotaged(module), { browser: false, where: 'control' });
  const passed = results.filter(r => r.status === 'pass');
  const ok = passed.length === 0;
  if (!ok) broken += 1;
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} a ${name} module that answers nothing fails all ${CELLS.length} cells` +
    (ok ? '' : ` — these passed: ${passed.map(r => r.name).join('; ')}`));
}
if (broken) {
  console.log('\nA control did not fire: the set can pass a module that does nothing. Stopping.');
  process.exit(1);
}
if (controlOnly) process.exit(0);

let failed = 0;
for (const [name, module] of [['native addon', native], ['WASM, node variant (release)', wasm]]) {
  console.log(`\n${name}`);
  const { family, results } = await runSmokeSet(module, { browser: false, where: 'node' });
  for (const r of results) {
    if (r.status !== 'pass') failed += 1;
    console.log(`  ${r.status === 'pass' ? 'pass ' : r.status.padEnd(5)} ${r.name} (${r.ms} ms)\n          ${r.detail}`);
  }
  console.log(`  observed family: ${family}; ${results.filter(r => r.status === 'pass').length} of ${results.length} pass.`);
}
process.exit(failed ? 1 : 0);
