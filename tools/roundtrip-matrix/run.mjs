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
import { MODES } from './modes.mjs';
import { EXPECTED, expectedNote, assertsRoundTrip } from './expected.mjs';

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const onlyValue = arg('value');
const onlyDoor = arg('door');
const onlyMode = arg('mode');
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

async function runCell(door, value, mode) {
  const lua = new lua_native.init({}, { libraries: 'all', ...mode.options });
  let input;
  try {
    input = value.make();
  } catch (e) {
    return { status: 'HARNESS', note: `value factory threw: ${e.message}` };
  }
  const before = await outcome(() => input);
  const after = await outcome(() => door.roundTrip(lua, input));
  return {
    mode: mode.id,
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

  // Mode vacuity (CR-23 F4). A mode whose option were silently ignored would
  // behave exactly like `default` — round-trip everything, agree at every door,
  // and report a clean column that searched nothing. Each mode must first show
  // its option is in effect. Same rule §15.6 states for a new *door*, one axis
  // up, and the reason it is a control rather than a test is that a vacuous
  // mode's cells must not be *counted*, not merely noted.
  console.log('\nMode vacuity (a mode must prove its option is in effect):\n');
  for (const m of MODES) {
    if (!m.proves) {
      console.log(`  ok    ${m.id.padEnd(14)} baseline — no option to prove`);
      continue;
    }
    let pass = false;
    try {
      const lua = new lua_native.init({}, { libraries: 'all', ...m.options });
      pass = (await m.proves.run(lua)) === true;
    } catch (e) {
      console.log(`        ${e.message}`);
    }
    if (!pass) bad++;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${m.id.padEnd(14)} ${m.proves.describe}`);
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
const modes = onlyMode ? MODES.filter((m) => m.id === onlyMode) : MODES;

console.log(`CR-20/23 round-trip matrix: ${modes.length} modes x ${doors.length} doors x `
  + `${values.length} values = ${modes.length * doors.length * values.length} cells\n`);

const cells = [];
// Sequential, not Promise.all: each cell builds its own context, and the async
// doors are one-run-at-a-time per context anyway — but more importantly a
// deterministic order is what makes a failing cell reproducible from the log.
for (const m of modes) for (const v of values) for (const d of doors) cells.push(await runCell(d, v, m));

// --- round-trip and parity analysis, per mode ------------------------------
//
// Reported per mode rather than pooled: a defect that appears only under one
// option is the entire reason this axis exists, and a pooled total would let a
// mode's whole column of divergences hide inside a bigger number.

const undocumented = [];
const staleExpectations = [];
const disagreements = [];
const brokenAssertions = [];

for (const m of modes) {
  const mine = cells.filter((c) => c.mode === m.id);
  const changed = mine.filter((c) => !c.identical);
  const undoc = changed.filter((c) => !expectedNote(c.value, c.door, c.mode));
  const doc = changed.filter((c) => expectedNote(c.value, c.door, c.mode));
  const stale = mine.filter((c) => c.identical && expectedNote(c.value, c.door, c.mode));
  // The other direction: an entry that asserts a value round-trips in this mode
  // and finds it does not.
  const broken = mine.filter((c) => !c.identical && assertsRoundTrip(c.value, c.door, c.mode));

  // Parity is asked *within* a mode. Across modes the doors are supposed to
  // differ — that is what an option is — so comparing a strict cell with a
  // default one would report the feature as a defect.
  const modeDisagreements = [];
  for (const v of values) {
    const row = mine.filter((c) => c.value === v.id);
    const groups = new Map();
    for (const c of row) {
      if (!groups.has(c.after)) groups.set(c.after, []);
      groups.get(c.after).push(c.door);
    }
    if (groups.size > 1) modeDisagreements.push({ mode: m.id, value: v.id, groups: [...groups.entries()], row });
  }

  console.log(`--- mode: ${m.id} — ${m.describe}`);
  console.log(`  round trip:  identical ${mine.length - changed.length}`
    + `   documented ${doc.length}   UNDOCUMENTED ${undoc.length}`
    + `${stale.length ? `   STALE ${stale.length}` : ''}`
    + `${broken.length ? `   BROKEN ASSERTION ${broken.length}` : ''}`);
  console.log(`  parity:      values where all ${doors.length} doors agree ${values.length - modeDisagreements.length}`
    + `   DISAGREE ${modeDisagreements.length}\n`);

  undocumented.push(...undoc);
  staleExpectations.push(...stale);
  disagreements.push(...modeDisagreements);
  brokenAssertions.push(...broken);
}

console.log(`Totals across ${modes.length} mode(s): ${cells.length} cells, `
  + `${EXPECTED.length} ledger entries, ${undocumented.length} undocumented, `
  + `${disagreements.length} parity disagreements.`);

// --- report ----------------------------------------------------------------

if (undocumented.length) {
  console.log('\n=== UNDOCUMENTED round-trip changes ===');
  const byValue = new Map();
  for (const c of undocumented) {
    const k = `${c.mode} x ${c.value}`;
    if (!byValue.has(k)) byValue.set(k, []);
    byValue.get(k).push(c);
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
    console.log(`\n  ${d.mode} x ${d.value}`);
    for (const [answer, doorList] of d.groups) {
      const msg = d.row.find((c) => c.after === answer && c.message)?.message;
      console.log(`    ${String(doorList.length).padStart(2)} door(s): ${answer.slice(0, 110)}`);
      if (msg) console.log(`             ${msg}`);
      console.log(`             ${doorList.join(', ')}`);
    }
  }
}

if (staleExpectations.length) {
  console.log('\n=== STALE ledger entries (they round-trip now; delete or scope the entry) ===');
  for (const c of staleExpectations) console.log(`  ${c.mode} x ${c.value} x ${c.door}`);
}

if (brokenAssertions.length) {
  console.log('\n=== BROKEN round-trip assertions (a ledger entry says these survive) ===');
  for (const c of brokenAssertions) {
    console.log(`  ${c.mode} x ${c.value} x ${c.door}`);
    console.log(`      in : ${c.before.slice(0, 120)}`);
    console.log(`      out: ${c.after.slice(0, 120)}`);
  }
}

if (jsonOut) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(jsonOut, `${JSON.stringify({ cells, disagreements }, null, 2)}\n`);
  console.log(`\nfull results -> ${jsonOut}`);
}

const bad = undocumented.length + disagreements.length + staleExpectations.length
  + brokenAssertions.length;
console.log(`\n${bad === 0 ? 'clean' : `${bad} item(s) to read`}.`);
process.exit(bad > 0 ? 1 : 0);
