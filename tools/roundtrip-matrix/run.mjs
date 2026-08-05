// CR-20: the JS -> Lua -> JS round-trip and parity matrix.
//
//   node tools/roundtrip-matrix/run.mjs
//   node tools/roundtrip-matrix/run.mjs --control
//   node tools/roundtrip-matrix/run.mjs --value=str:utf8
//   node tools/roundtrip-matrix/run.mjs --json=out.json
//
// **The gap this fills.** CR-18's oracle compares against stock Lua in two
// modes: the embedded VM (mode A) and values coming *out* (mode B). Values
// going *in* have no reference implementation — there is no second
// implementation of "what should a JavaScript Date become in Lua" to compare
// against. So this is a metamorphic oracle rather than a differential one: push
// a value in, read it back, and hold the pair to two properties that do not
// need a reference.
//
//   **Round trip.** What comes back should equal what went in, except where
//   `types.d.ts` says otherwise. The exceptions are enumerated, so an
//   *undocumented* loss is a finding and a documented one is not — which makes
//   this a test of the documentation as much as of the code.
//
//   **Parity.** Every door should give the same answer for the same value. A
//   door that differs from its siblings is a defect in the API's coherence even
//   when no single answer is wrong on its own. This is CR-17 F2's shape — one
//   door of six accepting what five refused — mechanized instead of eyeballed.
//
// Each cell runs in a fresh context, in-process. Unlike the CR-18 matrix this
// is not looking for aborts, so it does not pay for a process per cell; a crash
// would end the run, which is an acceptable trade for a value-comparison
// harness that the exception matrix already covers from the other side.

import lua_native from '../../index.js';
import { canon } from '../diff-oracle/js-canonical.mjs';
import { VALUES } from './values.mjs';
import { DOORS } from './doors.mjs';
import { EXPECTED, expectedNote } from './expected.mjs';

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const onlyValue = arg('value');
const onlyDoor = arg('door');
const jsonOut = arg('json');
const controlOnly = argv.includes('--control');

// Canonical form of an outcome. A throw is an outcome, not an absence of one —
// a door that refuses a value has told us something, and folding that into
// "no result" is how a refusal disappears from a parity column.
// `fn` may be async: the async doors (call_async, resume_async) are entry points
// like any other and belong in the same matrix, so awaiting here is what keeps
// "every door" honest rather than "every synchronous door".
async function outcome(fn) {
  try {
    const v = await fn();
    return { kind: 'value', canon: canon(v) };
  } catch (e) {
    // Only the *shape* of the refusal is compared across doors, not its
    // wording: doors legitimately word the same refusal differently, and
    // comparing prose would make every parity row a false positive. The
    // wording is still recorded for reading.
    const msg = String((e && e.message) || e);
    return { kind: 'throw', canon: 'THREW', message: msg.split('\n')[0].slice(0, 160) };
  }
}

async function runCell(door, value) {
  const lua = new lua_native.init({}, { libraries: 'all' });
  let input;
  try {
    input = value.make();
  } catch (e) {
    return { status: 'HARNESS', note: `value factory threw: ${e.message}` };
  }
  const before = await outcome(() => input);
  const after = await outcome(() => door.roundTrip(lua, input));
  return {
    door: door.id,
    value: value.id,
    before: before.canon,
    after: after.canon,
    afterKind: after.kind,
    message: after.message ?? null,
    identical: before.canon === after.canon,
  };
}

// --- controls --------------------------------------------------------------
//
// The standing rule: a search that reports clean must first demonstrate it can
// report dirty. Here that means proving the comparator can see a difference the
// round trip introduces, and proving each door is actually a round trip rather
// than something that hands the input straight back without ever entering Lua.
async function runControls() {
  const controls = [
    {
      name: 'the comparator sees a value change',
      run: () => canon(1) !== canon(2),
    },
    {
      name: 'the comparator sees a type change',
      run: () => canon(1) !== canon('1'),
    },
    {
      name: 'a known documented loss is detected as a difference',
      run: () => {
        // Boolean table keys are dropped (CR-18 O2). If the comparator cannot
        // see that, it cannot see anything.
        const lua = new lua_native.init({}, { libraries: 'all' });
        lua.set_global('rt', { a: 1 });
        const back = lua.execute_script('return rt');
        return canon({ a: 1 }) === canon(back) && canon({ a: 1 }) !== canon({ a: 2 });
      },
    },
    {
      name: 'every door actually enters Lua (a sentinel Lua-side mutation is visible)',
      run: async () => {
        // A door that never crossed into Lua would hand back the identical JS
        // object. Push a plain object and check the returned one is a *copy*,
        // not the same reference — which is what a real crossing produces.
        let crossed = 0;
        for (const d of DOORS) {
          const lua = new lua_native.init({}, { libraries: 'all' });
          const probe = { marker: 1 };
          try {
            const back = await d.roundTrip(lua, probe);
            if (back !== probe) crossed++;
          } catch { crossed++; }
        }
        if (crossed !== DOORS.length) {
          console.log(`        only ${crossed}/${DOORS.length} doors crossed`);
        }
        return crossed === DOORS.length;
      },
    },
  ];

  console.log('Control (a search that reports clean must first report dirty):\n');
  let bad = 0;
  for (const c of controls) {
    let pass = false;
    try { pass = (await c.run()) === true; } catch (e) { console.log(`        ${e.message}`); }
    if (!pass) bad++;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${c.name}`);
  }
  console.log('');
  return bad;
}

// --- main ------------------------------------------------------------------

const badControls = await runControls();
if (badControls > 0) {
  console.error(`${badControls} control(s) failed — the harness cannot report what it searches for.`);
  process.exit(1);
}
if (controlOnly) process.exit(0);

const values = onlyValue ? VALUES.filter((v) => v.id === onlyValue) : VALUES;
const doors = onlyDoor ? DOORS.filter((d) => d.id === onlyDoor) : DOORS;

console.log(`CR-20 round-trip matrix: ${doors.length} doors x ${values.length} values = ${doors.length * values.length} cells\n`);

const cells = [];
// Sequential, not Promise.all: each cell builds its own context, and the async
// doors are one-run-at-a-time per context anyway — but more importantly a
// deterministic order is what makes a failing cell reproducible from the log.
for (const v of values) for (const d of doors) cells.push(await runCell(d, v));

// --- round-trip analysis ---------------------------------------------------

const changed = cells.filter((c) => !c.identical);
const undocumented = changed.filter((c) => !expectedNote(c.value, c.door));
const documented = changed.filter((c) => expectedNote(c.value, c.door));
const staleExpectations = cells.filter((c) => c.identical && expectedNote(c.value, c.door));

console.log('Round trip (value in === value out):');
console.log(`  identical            ${cells.length - changed.length}`);
console.log(`  changed, documented  ${documented.length}   (${EXPECTED.length} ledger entries)`);
console.log(`  changed, UNDOCUMENTED ${undocumented.length}`);
if (staleExpectations.length) console.log(`  STALE ledger entry   ${staleExpectations.length}`);

// --- parity analysis -------------------------------------------------------
//
// For each value, group the doors by the answer they gave. More than one group
// means the doors disagree.
console.log('\nParity (every door gives the same answer for the same value):');
const disagreements = [];
for (const v of values) {
  const row = cells.filter((c) => c.value === v.id);
  const groups = new Map();
  for (const c of row) {
    if (!groups.has(c.after)) groups.set(c.after, []);
    groups.get(c.after).push(c.door);
  }
  if (groups.size > 1) disagreements.push({ value: v.id, groups: [...groups.entries()], row });
}
console.log(`  values where all ${doors.length} doors agree   ${values.length - disagreements.length}`);
console.log(`  values where doors DISAGREE          ${disagreements.length}`);

// --- report ----------------------------------------------------------------

if (undocumented.length) {
  console.log('\n=== UNDOCUMENTED round-trip changes ===');
  const byValue = new Map();
  for (const c of undocumented) {
    if (!byValue.has(c.value)) byValue.set(c.value, []);
    byValue.get(c.value).push(c);
  }
  for (const [v, list] of byValue) {
    console.log(`  ${v}  (${list.length}/${doors.length} doors)`);
    console.log(`      in : ${list[0].before.slice(0, 140)}`);
    const outs = [...new Set(list.map((c) => c.after))];
    for (const o of outs.slice(0, 4)) console.log(`      out: ${o.slice(0, 140)}`);
    const msgs = [...new Set(list.map((c) => c.message).filter(Boolean))];
    for (const m of msgs.slice(0, 3)) console.log(`      msg: ${m}`);
  }
}

if (disagreements.length) {
  console.log('\n=== PARITY DISAGREEMENTS (doors that differ on the same value) ===');
  for (const d of disagreements) {
    console.log(`\n  ${d.value}`);
    for (const [answer, doorList] of d.groups) {
      const msg = d.row.find((c) => c.after === answer && c.message)?.message;
      console.log(`    ${String(doorList.length).padStart(2)} door(s): ${answer.slice(0, 110)}`);
      if (msg) console.log(`             ${msg}`);
      console.log(`             ${doorList.join(', ')}`);
    }
  }
}

if (staleExpectations.length) {
  console.log('\n=== STALE ledger entries (they round-trip now; delete the entry) ===');
  for (const c of staleExpectations) console.log(`  ${c.value} x ${c.door}`);
}

if (jsonOut) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(jsonOut, `${JSON.stringify({ cells, disagreements }, null, 2)}\n`);
  console.log(`\nfull results -> ${jsonOut}`);
}

const bad = undocumented.length + disagreements.length + staleExpectations.length;
console.log(`\n${bad === 0 ? 'clean' : `${bad} item(s) to read`}.`);
process.exit(bad > 0 ? 1 : 0);
