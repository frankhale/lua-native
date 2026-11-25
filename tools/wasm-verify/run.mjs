// WASM verification: is a run against the WASM binding really against it, and
// is every way it differs from the native one written down with a reason?
//
//   node tools/wasm-verify/run.mjs                         # controls, ledger, probes, suite
//   node tools/wasm-verify/run.mjs --control               # just the controls
//   node tools/wasm-verify/run.mjs --target=wasm-release   # the release build (default: wasm)
//   node tools/wasm-verify/run.mjs --harnesses             # ...then every instrument under tools/
//   node tools/wasm-verify/run.mjs --closing               # also fail on what the owner has yet to rule on
//
// **What it is.** `docs/reviews/WASM-TARGET-PLAN.md` Phase 3 in runnable form. The WASM
// binding is verified by pointing the native target's suite and instruments at
// it; this decides what such a run *means*. Three questions, in order:
//
//   1. **Which module answered?** `tools/target.mjs` observes the module in
//      every process that loads it. The controls here show that observation
//      can say no.
//   2. **Is each recorded difference still the difference recorded?** Every
//      ledger probe is run on both targets, a process each.
//   3. **Does the suite differ only where the ledger says?** A test that does
//      not pass and is not ledgered is red; a ledgered test that passes, or is
//      gone, is STALE.
//
// **What it is not.** It is not an eleventh search. It finds nothing by
// itself: the suite and the ten instruments do the searching, and this is the
// rule for reading their answer on the second target.
//
// Exit 0 means: the controls fired, the ledger is well formed, every probe
// holds, and the suite's non-passing tests are exactly the ledgered ones. It
// does **not** mean the plan's closing condition 2 is met — that also needs no
// entry in the `defect` or `unruled` class, which `--closing` adds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import { assertOnTarget, familyOf, observeTarget } from '../target.mjs';
import {
  LEDGER, judgeProbe, judgeSuite, notRunOn, permittedRows, testKey, validateLedger,
} from '../wasm-ledger.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const controlOnly = argv.includes('--control');
const withHarnesses = argv.includes('--harnesses');
const closing = argv.includes('--closing');
const TARGET = arg('target') ?? 'wasm';
const BUILDS = { wasm: 'debug', 'wasm-release': 'release' };

if (!Object.hasOwn(BUILDS, TARGET)) {
  console.error(`--target=${TARGET}: this verifies a WASM build. Known: ${Object.keys(BUILDS).join(', ')}.`);
  process.exit(2);
}

const wasmEntry = (target) => path.join(ROOT, 'build-wasm', BUILDS[target], 'node', 'lua-native.mjs');
if (!fs.existsSync(wasmEntry(TARGET))) {
  console.error(`No WASM build at ${wasmEntry(TARGET)}. Run 'npm run build-wasm-${BUILDS[TARGET]}'.`);
  process.exit(2);
}

const run = (target, args, { nodeArgs = [], timeout = 30 * 60_000 } = {}) => spawnSync(
  process.execPath, [...nodeArgs, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LUA_NATIVE_TARGET: target } },
);

let failed = false;
const fail = (line) => { failed = true; console.log(`  FAIL  ${line}`); };

// --- Controls ------------------------------------------------------------------
//
// Each shows that a part of this instrument can report dirty. If one does not
// fire, nothing after it is believed and the run stops.

async function controls() {
  console.log('Controls');
  const problems = [];
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
    if (!ok) problems.push(name);
  };
  const throws = (f, pattern) => {
    try { f(); } catch (error) { return pattern.test(String(error?.message)); }
    return false;
  };

  // The target control. Both modules in one process, each handed to the
  // observation under the other's name: the mislabelled run the control exists
  // to stop.
  const native = (await import(url.pathToFileURL(path.join(ROOT, 'index.js')).href)).default;
  const wasm = (await import(url.pathToFileURL(wasmEntry(TARGET)).href)).default;
  check('target: the native module is observed to be native', observeTarget(native) === 'native');
  check(`target: the ${TARGET} module is observed to be wasm`, observeTarget(wasm) === 'wasm');
  check('target: the native module under the name wasm is refused',
    throws(() => assertOnTarget(TARGET, native), /observed to be the native one/));
  check('target: the wasm module under the name native is refused',
    throws(() => assertOnTarget('native', wasm), /observed to be the wasm one/));
  check('target: a module whose compile() answers with neither is refused',
    throws(() => observeTarget({ init: class { compile() { return 'bytes'; } dispose() {} } }), /neither binding/));

  // The loader's own two rules, since a run rests on them as well.
  const typo = run('wasn', ['--input-type=module', '-e', "await import('./tools/target.mjs')"]);
  check('target: an unknown LUA_NATIVE_TARGET is an error, not native',
    typo.status !== 0 && /Known targets/.test(typo.stderr), `exit ${typo.status}`);
  const loaded = run(TARGET, ['--input-type=module', '-e',
    "const t = await import('./tools/target.mjs'); console.log(t.target, t.observed)"]);
  check(`target: a process started with LUA_NATIVE_TARGET=${TARGET} reports ${TARGET} wasm`,
    loaded.status === 0 && loaded.stdout.trim() === `${TARGET} wasm`, (loaded.stdout + loaded.stderr).trim().slice(0, 120));

  // The closed list is read, not assumed.
  const rows = permittedRows();
  check('ledger: the permitted differences are read out of docs/WASM.md, bytecode and the deferred doors among them',
    rows.length >= 5 && rows.some(r => r.startsWith('Bytecode is')) && rows.some(r => r.startsWith('The two off-thread doors')), `${rows.length} rows`);

  // The ledger's own rules.
  const good = {
    id: 'x', class: 'target-semantics', row: rows[0], reason: 'a reason long enough to be one',
    tests: [{ name: 'a > b', outcome: 'fails', message: /boom/ }],
  };
  const refuses = (entry, pattern) => validateLedger([entry], rows).some(p => pattern.test(p));
  check('ledger: a well-formed entry is accepted', validateLedger([good], rows).length === 0);
  check('ledger: an entry citing a row the list does not have is refused',
    refuses({ ...good, row: 'Timers are slower' }, /not a row of the permitted differences/));
  check('ledger: an entry with no reason is refused', refuses({ ...good, reason: '' }, /no reason/));
  check('ledger: an entry nothing can show stale is refused', refuses({ ...good, tests: [] }, /nothing can ever show it stale/));
  check('ledger: a test that is never run needs a probe beside it',
    refuses({ ...good, tests: [{ name: 'a > b', outcome: 'not-run' }] }, /nothing would observe the difference/));
  check('ledger: an unruled entry must say where the decision is', refuses({ ...good, class: 'unruled' }, /open decision/));
  check('ledger: a failing test needs a message to fail by',
    refuses({ ...good, tests: [{ name: 'a > b', outcome: 'fails' }] }, /no message to fail by/));

  // The suite judge, on synthetic runs.
  const ledger = [
    good,
    { ...good, id: 'y', tests: [{ name: 'a > held', outcome: 'not-run' }], probe: { native: 'n', wasm: 'w' } },
  ];
  const clean = [
    { name: 'a > b', status: 'failed', message: 'boom' },
    { name: 'a > held', status: 'skipped' },
    { name: 'a > fine', status: 'passed' },
  ];
  const judged = (results) => judgeSuite(results, ledger);
  const swap = (name, patch) => clean.map(r => (r.name === name ? { ...r, ...patch } : r));
  const c = judged(clean);
  check('suite: a run that differs only as ledgered is clean', c.red.length === 0 && c.stale.length === 0 && c.accepted.length === 2);
  check('suite: a failing test that is not ledgered is red',
    judged([...clean, { name: 'a > new', status: 'failed', message: 'oops' }]).red.length === 1);
  check('suite: a skipped test that is not ledgered is red',
    judged([...clean, { name: 'a > quiet', status: 'skipped' }]).red.length === 1);
  check('suite: a ledgered test that passes is stale', judged(swap('a > b', { status: 'passed' })).stale.length === 1);
  check('suite: a ledgered test that no longer exists is stale', judged(clean.slice(1)).stale.length === 1);
  check('suite: a ledgered test failing some other way is red', judged(swap('a > b', { message: 'a different failure' })).red.length === 1);
  check('suite: a not-run test that ran is stale', judged(swap('a > held', { status: 'failed', message: 'x' })).stale.length === 1);

  // The probe judge.
  const probe = { probe: { native: 'n', wasm: 'w' } };
  check('probe: the frozen pair holds', judgeProbe(probe, 'n', 'w').verdict === 'holds');
  check('probe: the same answer on both targets is stale', judgeProbe(probe, 'n', 'n').verdict === 'stale');
  check('probe: a third answer on the WASM target is moved', judgeProbe(probe, 'n', 'z').verdict === 'moved');
  check('probe: a third answer on the native target is moved', judgeProbe(probe, 'z', 'w').verdict === 'moved');

  // The skip list is the ledger's and is empty on the native target.
  check('suite: nothing is held back on the native target', notRunOn('native').size === 0);
  check('suite: the tests held back on WASM are the ledger\'s not-run entries',
    notRunOn('wasm').size === LEDGER.flatMap(e => e.tests ?? []).filter(t => t.outcome === 'not-run').length);

  return problems;
}

// --- The ledger and its probes --------------------------------------------------

function checkLedger() {
  console.log('\nLedger');
  const problems = validateLedger(LEDGER, permittedRows());
  for (const p of problems) fail(p);
  const tests = LEDGER.flatMap(e => e.tests ?? []);
  console.log(`  ${LEDGER.length} entries: ${tests.length} suite tests named, ${LEDGER.filter(e => e.probe).length} probes.`);
  return problems.length === 0;
}

function observe(entry, target) {
  const child = run(target, [path.join('tools', 'wasm-verify', 'probe.mjs'), entry.id],
    { nodeArgs: entry.probe.nodeArgs ?? [], timeout: 120_000 });
  const line = child.stdout.trim().split('\n').pop() ?? '';
  try {
    const out = JSON.parse(line);
    if (out.observed !== familyOf(target)) return `the probe ran on the ${out.observed} binding, not ${target}`;
    return out.saw;
  } catch {
    return `the probe process failed (exit ${child.status}${child.signal ? `, ${child.signal}` : ''}): ${child.stderr.trim().split('\n').pop()?.slice(0, 120) ?? ''}`;
  }
}

function runProbes() {
  console.log(`\nProbes (native and ${TARGET}, one process each)`);
  for (const entry of LEDGER.filter(e => e.probe)) {
    const verdict = judgeProbe(entry, observe(entry, 'native'), observe(entry, TARGET));
    if (verdict.verdict === 'holds') console.log(`  holds  ${entry.id}`);
    else fail(`${verdict.verdict.toUpperCase()}  ${entry.id}: ${verdict.why}`);
  }
}

// --- The suite ------------------------------------------------------------------

function runSuite() {
  console.log(`\nSuite (LUA_NATIVE_TARGET=${TARGET})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-verify-'));
  const report = path.join(dir, 'suite.json');
  const child = run(TARGET, [path.join('node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=json', `--outputFile=${report}`]);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(report, 'utf8'));
  } catch {
    fail(`vitest wrote no report (exit ${child.status}): ${child.stderr.trim().split('\n').pop()?.slice(0, 160) ?? ''}`);
    return;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const results = [];
  for (const file of json.testResults) {
    // A file that fails without having run a test did not load — which is
    // what the target control does to a run on the wrong module.
    if (file.assertionResults.length === 0) {
      fail(`${path.relative(ROOT, file.name)} ran no tests: ${String(file.message ?? '').split('\n')[0].slice(0, 160) || file.status}`);
    }
    for (const a of file.assertionResults) {
      results.push({
        name: testKey(a.ancestorTitles, a.title),
        status: a.status === 'passed' || a.status === 'failed' ? a.status : 'skipped',
        message: (a.failureMessages ?? []).join('\n'),
      });
    }
  }
  if (results.length === 0) { fail('VACUOUS — the suite ran no tests'); return; }

  const { accepted, red, stale } = judgeSuite(results);
  const passed = results.filter(r => r.status === 'passed').length;
  console.log(`  ${results.length} tests: ${passed} pass, ${accepted.length} differ as ledgered, ${red.length} red, ${stale.length} stale.`);
  for (const a of accepted) console.log(`  ledgered  [${a.id}] ${a.how}: ${a.name}`);
  for (const r of red) fail(`RED  ${r.name}\n          ${r.why}`);
  for (const s of stale) fail(`STALE  [${s.id}] ${s.name}\n          ${s.why}`);
}

// --- The instruments ------------------------------------------------------------
//
// Each already carries its own controls and its own ledger, and those ledgers
// are the native target's: there is no WASM-only cell in any of them. So the
// rule is the plain one — an instrument that exits non-zero on this target is
// red. `check-invariants` is not here: it reads source, and is the same run on
// either target.

const HARNESSES = [
  ['gc-stress', ['tools/gc-stress/run.mjs'], { nodeArgs: ['--expose-gc'] }],
  ['binding-balance', ['tools/binding-balance/run.mjs'], { nodeArgs: ['--expose-gc'] }],
  ['lifecycle-matrix', ['tools/lifecycle-matrix/run.mjs']],
  ['oracle', ['tools/diff-oracle/run.mjs']],
  ['exception-matrix', ['tools/exception-matrix/run.mjs']],
  ['roundtrip-matrix', ['tools/roundtrip-matrix/run.mjs']],
  ['exec-parity', ['tools/exec-parity/run.mjs']],
  ['cross-context', ['tools/cross-context/run.mjs']],
  ['capability-matrix', ['tools/capability-matrix/run.mjs']],
  // An unoptimised module's cost per crossing swamps the work this one's
  // control injects, so it refuses on the debug build. Always the release one.
  ['crossing-cost', ['tools/crossing-cost/run.mjs'], { target: 'wasm-release' }],
];

function runHarnesses() {
  console.log('\nInstruments');
  for (const [name, args, options = {}] of HARNESSES) {
    const target = options.target ?? TARGET;
    if (!fs.existsSync(wasmEntry(target))) { fail(`${name}: needs the ${target} build, which is not there`); continue; }
    const started = Date.now();
    const child = run(target, args, options);
    // The summary is the end of stdout; several of these write progress to
    // stderr, which says nothing. On a failure, show the end of both.
    const last = (text, n) => text.trim().split('\n').filter(l => l.trim()).slice(-n).map(l => l.trim().slice(0, 150));
    const tail = child.status === 0 ? last(child.stdout, 2) : [...last(child.stdout, 3), ...last(child.stderr, 2)];
    const seconds = Math.round((Date.now() - started) / 1000);
    const label = `${name} (${target}, ${seconds}s)`;
    if (child.status === 0) console.log(`  ok     ${label}: ${tail.join(' | ')}`);
    else fail(`${label} exited ${child.status ?? child.signal}:\n          ${tail.join('\n          ')}`);
  }
}

// --- Main -----------------------------------------------------------------------

const broken = await controls();
if (broken.length > 0) {
  console.log(`\n${broken.length} control(s) did not fire. Nothing after this point would mean anything; stopping.`);
  process.exit(1);
}
if (controlOnly) process.exit(0);

if (checkLedger()) {
  runProbes();
  runSuite();
  if (withHarnesses) runHarnesses();
}

const open = LEDGER.filter(e => e.class !== 'target-semantics');
console.log('\nClosing condition 2');
for (const cls of ['target-semantics', 'unruled', 'defect']) {
  const entries = LEDGER.filter(e => e.class === cls);
  console.log(`  ${cls}: ${entries.length}`);
  if (cls !== 'target-semantics') for (const e of entries) console.log(`    ${e.id} — ${e.decision ?? 'open defect'}`);
}
console.log(open.length === 0
  ? '  Every entry is a row of the permitted differences.'
  : `  NOT MET: ${open.length} entr${open.length === 1 ? 'y is' : 'ies are'} not a row of the permitted differences.`);

if (failed) console.log('\nRED.');
else if (open.length > 0 && closing) console.log('\nThe run is as ledgered, and --closing fails on what is still open.');
else console.log(`\nAs ledgered${withHarnesses ? '' : ' (suite and probes; --harnesses adds the instruments)'}.`);
process.exit(failed || (closing && open.length > 0) ? 1 : 0);
