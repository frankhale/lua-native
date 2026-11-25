// The WASM ledger: every way the WASM binding is known to answer differently
// from the native one, each with its reason (`docs/reviews/WASM-TARGET-PLAN.md`,
// Phase 3). `tools/wasm-verify/run.mjs` judges a run against it; the suite
// reads it for the three tests that cannot be run on this target at all.
//
// The rules, which are `tools/README.md`'s ledger conventions applied here:
//
//   - **A difference is ledgered, not skipped.** A suite test that does not
//     pass on WASM and is not named here is a red run.
//   - **Every entry is matched by something that runs.** An entry names suite
//     tests, or carries a probe, or both. A named test that passes or no
//     longer exists, and a probe that sees the same thing on both targets, are
//     reported STALE. An entry with neither is refused as malformed.
//   - **A ledgered test must fail the way the entry says.** `message` is
//     matched against the failure, so a test that starts failing for a second
//     reason is not hidden behind the first.
//   - **A probe freezes both answers.** Seeing something that is neither the
//     native answer nor the WASM one is MOVED, and red: the difference still
//     exists but is no longer the one written down.
//
// Three classes. The plan names two; the third exists so that neither of
// those has to lie:
//
//   target-semantics   a row of `docs/WASM.md`'s table of permitted
//                      differences, cited by its exact text. The
//                      rows are read out of the document, so an entry cannot
//                      cite a row that is not there.
//   defect             open, to be fixed in the WASM binding.
//   unruled            a real, reproducible difference that is **not** on
//                      the closed list and has not been called a defect.
//                      Whether it becomes a row or gets fixed is the owner's
//                      decision, and `decision` says where it is recorded.
//                      Filing these under target-semantics would launder them
//                      ("never ledger an undocumented defect"); filing them
//                      under defect would call a hash order a bug.
//
// Closing condition 2 needs zero `defect` and zero `unruled`. The runner
// reports both on every run and fails on them under `--closing`.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/** Where the closed list of permitted differences lives. It was §1.1 of the
 *  plan while the target was being built, and moved to the current reference
 *  with the rest of what outlived the plan. */
export const PERMITTED_DIFFERENCES = {
  file: path.resolve(HERE, '..', 'docs', 'WASM.md'),
  heading: '## The permitted differences',
};

export const CLASSES = ['target-semantics', 'defect', 'unruled'];

const ADAPTER = 'lua-native Node adapter';

/** A suite test's name as the ledger spells it: its `describe` chain and
 *  title. The suite and the runner both build it here, so they cannot drift. */
export const testKey = (ancestors, title) => [...ancestors, title].join(' > ');

const D3 = 'The two off-thread doors do not leave the calling thread';
const D4 = 'Bytecode is a `Uint8Array`, not a `Buffer`';

const FUNCTIONS =
  '`String(fn)` of a function the binding hands out is `[native code]` without the function\'s name';

export const LEDGER = [
  // ------------------------------------------- the rows the target began with
  {
    id: 'bytecode-is-a-uint8array',
    class: 'target-semantics',
    row: D4,
    reason:
      'compile() and compile_file() answer with a plain Uint8Array: a browser has no Buffer. ' +
      'Two tests assert `instanceof Buffer`; the third calls `.toString(\'latin1\')` on the result, ' +
      'which on a Uint8Array is the list of decimals, so what it hands Lua is not a binary chunk.',
    tests: [
      {
        name: testKey([ADAPTER, 'bytecode precompilation', 'compile()'], 'compiles a script to a bytecode buffer'),
        outcome: 'fails',
        message: /to be an instance of Buffer/,
      },
      {
        name: testKey([ADAPTER, 'bytecode precompilation', 'compile_file()'], 'compiles a file to bytecode'),
        outcome: 'fails',
        message: /to be an instance of Buffer/,
      },
      {
        name: testKey([ADAPTER, 'INTEROP-PARITY-PLAN', 'P4b: set_file_reader'],
          'rejects bytecode, so a reader cannot route around allowBytecode'),
        outcome: 'fails',
        message: /to match \/\^nil\\\|\.\*binary chunk\//,
      },
    ],
  },
  {
    id: 'deferred-doors-share-the-thread',
    class: 'target-semantics',
    row: D3,
    reason:
      'execute_script_async runs on the calling thread, in slices where the engine can suspend it. ' +
      'It makes progress only while that thread is free; a worker thread\'s run does not care. The ' +
      'probe keeps the thread busy for three times as long as the run takes and then asks how much ' +
      'of the run was left.',
    probe: {
      native: 'the run had finished while the thread was busy',
      wasm: 'the run was still to be done',
      observe: async (module) => {
        const lua = new module.init({}, {});
        const script = 'local x = 0; for i = 1, 3e7 do x = x + i end; return x';
        const alone = performance.now();
        await lua.execute_script_async(script);
        const took = performance.now() - alone;
        const run = lua.execute_script_async(script);
        const until = performance.now() + 3 * took;
        while (performance.now() < until) { /* busy */ }
        const after = performance.now();
        await run;
        const left = performance.now() - after;
        lua.dispose();
        return left < took / 3
          ? 'the run had finished while the thread was busy'
          : 'the run was still to be done';
      },
    },
  },

  // ------------------------------------- rows added November 25, 2026
  //
  // Each of these was `unruled` for a day: found during the port, real, and on
  // nobody's list. The owner ruled each a permitted difference and added its
  // row. (A seventh, the three limits being 32 bits wide, was ruled a defect
  // and fixed instead; its entry went STALE on the next run and was removed.
  // Four more were fixed and removed the same day: key order, own `arguments`
  // and `caller`, the `stack` of a constructed error, and the forged promise.)
  {
    id: 'small-stack-refuses-sooner',
    class: 'target-semantics',
    row: "A thread with a small engine stack refuses nested calls before Lua's limit of 200",
    reason:
      'Lua\'s C calls are on the JavaScript engine\'s stack here, and natively on the thread\'s own. ' +
      'Where the engine\'s is too small for 200 of them the same "C stack overflow" arrives sooner. ' +
      'Until November 25, 2026 the engine ran out instead, and the context was lost.',
    probe: {
      nodeArgs: ['--stack-size=160'],
      native: 'C stack overflow at the limit; the context still works',
      wasm: 'C stack overflow before the limit; the context still works',
      observe: (module) => {
        const lua = new module.init({}, { libraries: 'all' });
        const [ok, depth, error] = lua.execute_script(`
          local depth = 0
          local function f() depth = depth + 1; return (string.gsub("x", "x", f)) end
          local ok, e = pcall(f)
          return ok, depth, tostring(e)`);
        const event = !ok && /C stack overflow/.test(error) ? 'C stack overflow' : `something else: ${error}`;
        const after = lua.execute_script('return 6 * 7') === 42 ? 'the context still works' : 'the context answers wrongly';
        return `${event} ${depth >= 190 ? 'at' : 'before'} the limit; ${after}`;
      },
    },
  },
  {
    id: 'function-source-text',
    class: 'target-semantics',
    row: FUNCTIONS,
    reason:
      'The shell\'s functions are Proxies with no traps, whose source text an engine does not show. ' +
      'The engine writes `[native code]` for one as it does for an N-API function, but has no name ' +
      'for it, and a module cannot make a function that has both.',
    probe: {
      native: 'function luaFunction() { [native code] }',
      wasm: 'function () { [native code] }',
      observe: (module) => {
        const lua = new module.init({}, {});
        const text = String(lua.execute_script('return function() end'));
        lua.dispose();
        return text;
      },
    },
  },
];

// --- Reading the closed list ---------------------------------------------------

/** The first cell of each row of the permitted-differences table, read out
 *  of the document. */
export function permittedRows(source = PERMITTED_DIFFERENCES) {
  const lines = fs.readFileSync(source.file, 'utf8').split('\n');
  const start = lines.findIndex(line => line.startsWith(source.heading));
  if (start < 0) throw new Error(`wasm-ledger: no heading '${source.heading}' in ${source.file}`);
  const rows = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (!line.startsWith('|')) { if (inTable) break; continue; }
    inTable = true;
    const first = line.split('|')[1].trim();
    if (first === 'Difference' || /^-+$/.test(first)) continue;
    rows.push(first);
  }
  if (rows.length === 0) throw new Error(`wasm-ledger: '${source.heading}' in ${source.file} has no table rows`);
  return rows;
}

// --- Judging --------------------------------------------------------------------

/** Everything wrong with the ledger itself, before any run is judged. */
export function validateLedger(ledger, rows) {
  const problems = [];
  const ids = new Set();
  const names = new Set();
  for (const entry of ledger) {
    const at = `entry '${entry.id}'`;
    if (!entry.id) problems.push('an entry has no id');
    if (ids.has(entry.id)) problems.push(`${at}: the id is used twice`);
    ids.add(entry.id);
    if (!CLASSES.includes(entry.class)) problems.push(`${at}: class '${entry.class}' is not one of ${CLASSES.join(', ')}`);
    if (!entry.reason || entry.reason.trim().length < 20) problems.push(`${at}: no reason`);
    if (entry.class === 'target-semantics' && !rows.includes(entry.row)) {
      problems.push(`${at}: cites '${entry.row}', which is not a row of the permitted differences in docs/WASM.md. The list is closed; the owner adds rows, a ledger does not.`);
    }
    if (entry.class === 'unruled' && !entry.decision) problems.push(`${at}: unruled, and does not say where the open decision is recorded`);
    if (!entry.probe && !(entry.tests?.length > 0)) problems.push(`${at}: names no test and carries no probe, so nothing can ever show it stale`);
    for (const test of entry.tests ?? []) {
      if (names.has(test.name)) problems.push(`${at}: '${test.name}' is named by two entries`);
      names.add(test.name);
      if (test.outcome !== 'fails' && test.outcome !== 'not-run') problems.push(`${at}: '${test.name}' has outcome '${test.outcome}'`);
      if (test.outcome === 'fails' && !(test.message instanceof RegExp)) problems.push(`${at}: '${test.name}' fails with no message to fail by`);
      if (test.outcome === 'not-run' && !entry.probe) {
        problems.push(`${at}: '${test.name}' is never run, and the entry has no probe — nothing would observe the difference`);
      }
    }
    if (entry.probe && entry.probe.native === entry.probe.wasm) problems.push(`${at}: the probe freezes the same answer for both targets`);
  }
  return problems;
}

/** The tests the suite must not start on a target, with the reason: full name
 *  to reason. Empty for the native binding. */
export function notRunOn(family, ledger = LEDGER) {
  const map = new Map();
  if (family !== 'wasm') return map;
  for (const entry of ledger) {
    for (const test of entry.tests ?? []) {
      if (test.outcome === 'not-run') map.set(test.name, `WASM ledger '${entry.id}': ${entry.row ?? entry.decision}`);
    }
  }
  return map;
}

/**
 * Judge a suite run. `results` is `[{ name, status, message }]` with status
 * `passed`, `failed` or `skipped`.
 *
 *   accepted  did not pass, and the ledger says so and says why
 *   red       did not pass and is not ledgered, or fails some other way
 *   stale     ledgered, and the run does not bear the entry out
 */
export function judgeSuite(results, ledger = LEDGER) {
  const byName = new Map(results.map(r => [r.name, r]));
  const ledgered = new Map();
  for (const entry of ledger) for (const test of entry.tests ?? []) ledgered.set(test.name, { entry, test });

  const accepted = [];
  const red = [];
  const stale = [];

  for (const [name, { entry, test }] of ledgered) {
    const result = byName.get(name);
    if (!result) { stale.push({ id: entry.id, name, why: 'no test of this name ran or exists' }); continue; }
    if (test.outcome === 'not-run') {
      if (result.status === 'skipped') accepted.push({ id: entry.id, name, how: 'not run' });
      else stale.push({ id: entry.id, name, why: `ledgered as not run on this target, and it ran (${result.status})` });
      continue;
    }
    if (result.status === 'passed') stale.push({ id: entry.id, name, why: 'ledgered as failing, and it passes' });
    else if (result.status === 'skipped') red.push({ name, why: `ledgered as failing ('${entry.id}'), but it did not run` });
    else if (!test.message.test(result.message ?? '')) {
      red.push({ name, why: `ledgered ('${entry.id}') as failing with ${test.message}, but it fails with: ${firstLine(result.message)}` });
    } else accepted.push({ id: entry.id, name, how: 'fails as ledgered' });
  }

  for (const result of results) {
    if (result.status === 'passed' || ledgered.has(result.name)) continue;
    red.push({ name: result.name, why: `${result.status}, and not in the ledger: ${firstLine(result.message)}` });
  }
  return { accepted, red, stale };
}

/** Judge one probe from what each target was observed to answer. */
export function judgeProbe(entry, sawNative, sawWasm) {
  const { native, wasm } = entry.probe;
  if (sawNative !== native) {
    return { verdict: 'moved', why: `the native target answered '${sawNative}', not the frozen '${native}'` };
  }
  if (sawWasm === native) return { verdict: 'stale', why: `both targets now answer '${native}'` };
  if (sawWasm !== wasm) return { verdict: 'moved', why: `the WASM target answered '${sawWasm}', not the frozen '${wasm}'` };
  return { verdict: 'holds' };
}

function firstLine(message) {
  return String(message ?? '').split('\n')[0].slice(0, 160) || '(no message)';
}
