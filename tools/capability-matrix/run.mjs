// The capability matrix: what does a configuration actually grant?
//
//   node tools/capability-matrix/run.mjs                 # everything
//   node tools/capability-matrix/run.mjs --control       # just the controls
//   node tools/capability-matrix/run.mjs --config=sandbox
//
// **Why this exists.** `libraries` and `allowBytecode` are the two options
// nobody had ruled on — `surface-census` reported both UNCLASSIFIED, and could
// not have reported anything else, because it scored an option covered only if
// a `roundtrip-matrix` mode set it and neither option changes conversion
// (`docs/UNSEARCHED-REGIONS-PLAN.md` §2.1). Ruling on them turned up a guard
// whose member set was five doors short. This is the search that would have
// found it.
//
// **Three properties, and only the first is a boundary in §15.1's sense.**
//
//   1. **A door works or refuses loudly — never accept-and-retain.** An entry
//      point that returns normally while doing nothing observable is a plausible
//      answer rather than an error, which is the criterion exactly.
//      `LIMITATIONS.md` §8's class; CR-23 fixed one member and checked the
//      siblings by hand.
//   2. **The seal is what it says.** Each preset loads the libraries it claims,
//      and no others. Not a value crossing — a capability assertion that rides
//      along because it shares the fixture. Said plainly rather than filed under
//      the criterion it does not meet.
//   3. **A bytecode door refuses iff the guard is on.** An implication rather
//      than a fixed expectation, so every cell is meaningful in every column —
//      including the columns where loading is the correct answer, which is where
//      a guard that over-reaches would show up.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import lua_native from '../../index.js';
import { CONFIGS, EXPECTED_LIBRARIES, LIBRARY_PROBE, luaLibraryNames } from './configs.mjs';
import { ENTRY_POINTS, BYTECODE_DOORS, SCRATCH, seedScratch } from './doors.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const onlyConfig = arg('config');
const controlOnly = argv.includes('--control');

// --- the ledger -------------------------------------------------------------
//
// Known-acceptable results, each with its reason. A stale entry — one whose
// cell has started behaving differently — is reported rather than ignored, for
// the reason tools/README.md gives: a suppression list that can only hide things
// hides regressions in the other direction too.
//
// **These four suppress nothing, and that is deliberate.** WORKS is never a
// finding, so each entry here is a *positive assertion* in the sense
// `roundtrip-matrix`'s `roundTripsInstead` is one: it pins a grant that widens a
// sealed preset, and if that grant ever stops working the cell reports STALE
// instead of quietly becoming a refusal nobody chose. A seal that gains a door
// is a decision; a seal that loses one is a regression, and this is the only
// place either would show.
const LEDGER = {
  'sandbox / set_read_handler': {
    expect: 'WORKS',
    why: 'Deliberate, and narrower than it looks: with no `io` present the '
      + 'handler synthesizes a table holding `read` alone, so the granted '
      + 'capability is exactly as wide as the grant. CR-23 F3 is the record of '
      + 'the bookkeeping around it. Refusing instead would have been the '
      + 'accept-and-retain cure that LIMITATIONS §8 rejected.',
  },
  'sandbox / set_file_reader': {
    expect: 'WORKS',
    why: 'Same shape: the reader installs its own `dofile`/`loadfile`, which a '
      + 'sealed preset had cleared. The doors it adds read only what the '
      + 'reader hands back — never the real filesystem — so the seal is not '
      + 'widened, and the host asked for exactly this by installing a reader.',
  },
  'bare / set_read_handler': {
    expect: 'WORKS',
    why: 'As above; the synthesized `io` needs no library behind it.',
  },
  'bare / set_file_reader': {
    expect: 'WORKS',
    why: 'As above; the reader supplies the doors it needs.',
  },
};
const ledgerUsed = new Set();

// --- controls ---------------------------------------------------------------
//
// Each property gets a control that shows the harness can report *dirty* for
// that property, not merely that it can run. The accept-and-retain control is
// the one that matters: it is the only outcome here that no ordinary door
// produces today, so without a synthetic one the classifier would be untested.
function runControls(bytecode) {
  const checks = [
    {
      name: 'a door that does nothing is classified ACCEPT-AND-RETAIN',
      run: () => {
        const lua = new lua_native.init({}, { libraries: 'all' });
        return classifyEntryPoint(lua, { id: 'synthetic', call: () => {}, observe: () => false })
          === 'ACCEPT-AND-RETAIN';
      },
    },
    {
      name: 'a door that throws is classified REFUSED',
      run: () => {
        const lua = new lua_native.init({}, { libraries: 'all' });
        return classifyEntryPoint(lua, {
          id: 'synthetic', call: () => { throw new Error('nope'); }, observe: () => false,
        }) === 'REFUSED';
      },
    },
    {
      name: 'a door whose effect is visible is classified WORKS',
      run: () => {
        const lua = new lua_native.init({}, { libraries: 'all' });
        return classifyEntryPoint(lua, {
          id: 'synthetic',
          call: (l) => l.set_global('ctl', 1),
          observe: (l) => l.execute_script('return ctl') === 1,
        }) === 'WORKS';
      },
    },
    {
      name: 'the seal check can see a library that should not be there',
      run: () => {
        const lua = new lua_native.init({}, { libraries: 'all' });
        // 'all' really does have io; asking sandbox's question of it must fail.
        return lua.execute_script('return io ~= nil') === true;
      },
    },
    {
      name: 'the bytecode corpus is a real binary chunk',
      run: () => bytecode.length > 4 && bytecode[0] === 0x1b,
    },
    {
      name: 'a bytecode door loads when the guard is off',
      run: () => {
        const lua = new lua_native.init({}, { libraries: 'all' });
        return BYTECODE_DOORS[0].run(lua, bytecode) === 'LOADED';
      },
    },
    {
      name: 'every config declares a vacuity control (except the baseline)',
      run: () => CONFIGS.filter((c) => !c.proves).length === 1,
    },
    {
      name: 'every config has a specified library set, and it is closed over LuaLibrary',
      run: () => {
        const names = luaLibraryNames(readFileSync(join(ROOT, 'types.d.ts'), 'utf8'));
        let ok = true;
        for (const c of CONFIGS) {
          const spec = EXPECTED_LIBRARIES[c.id];
          if (!Array.isArray(spec)) { console.log(`      ${c.id}: no specified library set`); ok = false; continue; }
          const unknown = spec.filter((n) => !names.includes(n));
          if (unknown.length) { console.log(`      ${c.id}: specifies ${unknown.join(', ')}, absent from the LuaLibrary union`); ok = false; }
        }
        const unprobed = names.filter((n) => !LIBRARY_PROBE[n]);
        if (unprobed.length) { console.log(`      no probe for: ${unprobed.join(', ')}`); ok = false; }
        return ok;
      },
    },
  ];

  console.log('Control (a search that reports clean must first report dirty):\n');
  let bad = 0;
  for (const c of checks) {
    let ok = false;
    try { ok = c.run(); } catch (e) { console.log(`  threw: ${e.message}`); }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
    if (!ok) bad += 1;
  }
  console.log('');
  return bad === 0;
}

function classifyEntryPoint(lua, door) {
  try {
    door.call(lua);
  } catch {
    return 'REFUSED';
  }
  let seen = false;
  try { seen = door.observe(lua) === true; } catch { seen = false; }
  return seen ? 'WORKS' : 'ACCEPT-AND-RETAIN';
}

// --- the matrix -------------------------------------------------------------

function main() {
  const trusted = new lua_native.init({}, { libraries: 'all' });
  const bytecode = Buffer.from(trusted.compile('return 42'));
  seedScratch(bytecode);

  if (!runControls(bytecode)) {
    console.error('controls failed; refusing to run a search that cannot report dirty.');
    process.exit(1);
  }
  if (controlOnly) return;

  const libNames = luaLibraryNames(readFileSync(join(ROOT, 'types.d.ts'), 'utf8'));
  const findings = [];
  const configs = CONFIGS.filter((c) => !onlyConfig || c.id === onlyConfig);
  let cells = 0;

  for (const config of configs) {
    // Axis vacuity: prove the configuration is in effect before believing a
    // single cell in this column.
    if (config.proves) {
      let proven = false;
      try {
        proven = config.proves.run(new lua_native.init({}, config.options)) === true;
      } catch (e) {
        console.error(`  config ${config.id}: vacuity control threw: ${e.message}`);
      }
      if (!proven) {
        console.error(`config '${config.id}' cannot prove its options are in effect `
          + `(${config.proves.describe}); refusing to count its cells.`);
        process.exit(1);
      }
    }

    const guardOn = config.options.allowBytecode === false
      || (config.options.libraries === 'sandbox' && config.options.allowBytecode === undefined);

    console.log(`\n--- ${config.id}  (${config.describe})`);

    // Property 2: the seal. Every LuaLibrary name is classified, so a new
    // library cannot slip past the specification table.
    const spec = EXPECTED_LIBRARIES[config.id];
    for (const lib of libNames) {
      cells += 1;
      const lua = new lua_native.init({}, config.options);
      const present = lua.execute_script(`return ${LIBRARY_PROBE[lib]} ~= nil`) === true;
      const wanted = spec.includes(lib);
      if (present !== wanted) {
        findings.push({
          kind: present ? 'SEAL LEAK' : 'MISSING LIBRARY',
          id: `${config.id} / ${lib}`,
          detail: `specified ${wanted ? 'present' : 'absent'}, observed ${present ? 'present' : 'absent'}`,
        });
      }
    }

    // Property 1: works or refuses loudly.
    for (const door of ENTRY_POINTS) {
      cells += 1;
      const lua = new lua_native.init({}, config.options);
      const verdict = classifyEntryPoint(lua, door);
      const key = `${config.id} / ${door.id}`;
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
        // Printed, not skipped: a ledgered cell that vanishes from the report is
        // a cell nobody can see has stopped being examined.
        console.log(`  ${`LEDGERED(${verdict})`.padEnd(18)} ${door.id}`);
        continue;
      }
      if (verdict === 'ACCEPT-AND-RETAIN') {
        findings.push({
          kind: 'ACCEPT-AND-RETAIN',
          id: key,
          detail: `${door.id} returned normally and had no observable effect`
            + (door.needs ? ` (needs '${door.needs}', absent here)` : ''),
        });
      }
      console.log(`  ${verdict.padEnd(18)} ${door.id}`);
    }

    // Property 3: a bytecode door refuses iff the guard is on.
    for (const door of BYTECODE_DOORS) {
      const lua = new lua_native.init({}, config.options);
      let reachable = true;
      try { reachable = door.precondition(lua) === true; } catch { reachable = false; }
      if (!reachable) {
        console.log(`  ${'ABSENT'.padEnd(18)} bytecode:${door.id}`);
        continue;
      }
      cells += 1;
      let outcome;
      try { outcome = door.run(lua, bytecode); } catch (e) { outcome = `HARNESS: ${e.message}`; }
      if (outcome !== 'LOADED' && outcome !== 'REFUSED') {
        findings.push({ kind: 'HARNESS FAULT', id: `${config.id} / ${door.id}`, detail: String(outcome) });
        continue;
      }
      const want = (door.alwaysRefuses || guardOn) ? 'REFUSED' : 'LOADED';
      if (outcome !== want) {
        findings.push({
          kind: door.alwaysRefuses ? 'TEXT-ONLY CHANNEL ACCEPTED BYTECODE'
            : guardOn ? 'BYTECODE DOOR OPEN' : 'BYTECODE DOOR CLOSED WITHOUT CAUSE',
          id: `${config.id} / ${door.id}`,
          detail: door.alwaysRefuses
            ? `a host-supplied channel is documented text-only in every mode: expected REFUSED, observed ${outcome}`
            : `guard ${guardOn ? 'on' : 'off'}: expected ${want}, observed ${outcome}`,
        });
      }
      console.log(`  ${outcome.padEnd(18)} bytecode:${door.id}`);
    }
  }

  // A ledger entry naming a cell that no longer exists is an excuse nobody
  // re-read.
  if (!onlyConfig) {
    for (const key of Object.keys(LEDGER)) {
      if (!ledgerUsed.has(key)) {
        findings.push({ kind: 'STALE LEDGER ENTRY', id: key, detail: 'no such cell in this run' });
      }
    }
  }

  console.log(`\n${cells} cells across ${configs.length} configs `
    + `(${ENTRY_POINTS.length} entry points, ${BYTECODE_DOORS.length} bytecode doors, `
    + `${libNames.length} libraries), ${Object.keys(LEDGER).length} ledger entries`);
  console.log(`  FINDINGS  ${findings.length}`);
  for (const f of findings) console.log(`\n${f.kind}  ${f.id}\n  ${f.detail}`);
  console.log(findings.length ? '\ndirty.' : '\nclean.');
  process.exit(findings.length ? 1 : 0);
}

main();
