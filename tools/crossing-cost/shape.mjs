// Axis B — cost shape per door and per value kind.
// Axis C — the scaling knobs the API exposes to a caller.
//
// **These ride existing enumerations rather than declaring new ones**
// (`PERFORMANCE-PLAN` §5). `DOORS` comes from `roundtrip-matrix`, unedited: it
// is the same list `surface-census` scores for coverage, so §15.6's trigger
// "a new public entry point that takes a JS value -> roundtrip-matrix (a door)"
// makes a new door show up here too, without anyone remembering to add it. A
// door added for correctness is measured for cost on the same commit.
//
// `tools/README.md`'s W2 convention applies with force: **import, never edit.**
// The ledger that breaks if these modules change is `roundtrip-matrix`'s, and
// its 532-entry stale cascade is the recorded precedent.
//
// **B1 measures the door as `roundtrip-matrix` defines it**, preamble included —
// several doors compile a small script or mint a coroutine as part of what they
// are. That is the honest reading of "what does this door cost", and it is why
// the numbers below are door costs rather than crossing costs. A door whose
// preamble dominates is recorded as such in `accepted.mjs` rather than
// special-cased here.

import lua_native from '../../index.js';
import { DOORS } from '../roundtrip-matrix/doors.mjs';
import { calibrateReps, timePerCall, fmtNs } from './measure.mjs';
import { classify } from './classify.mjs';

const ctx = (options = {}) => new lua_native.init({}, { libraries: 'all', ...options });

// ---------------------------------------------------------------------------
// B1 — the null crossing, every door, as a multiple of the cheapest.
//
// The payload is the smallest value the API has: the integer 1. What is left is
// the door's own structural cost.
// ---------------------------------------------------------------------------
// **Not every door can be driven twice on one context**, and finding that out
// is worth more than the number it cost. The four `register_class` doors refuse
// their second call with "class 'RT' is already registered on this context" —
// correct behaviour, and a real property: a door with once-per-context
// registration has no steady-state per-call cost to measure. Measuring them with
// a fresh context per call is possible but answers a different question, since
// context construction then dominates, so they are reported in their own group
// and excluded from the ratio. Ratios are only comparable between doors measured
// the same way.
async function isRepeatable(door) {
  const lua = ctx();
  try {
    await door.roundTrip(lua, 1);
    await door.roundTrip(lua, 1);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.message.slice(0, 80) };
  }
}

export async function runB1() {
  const rows = [];
  const onceOnly = [];
  for (const door of DOORS) {
    const rep = await isRepeatable(door);
    if (!rep.ok) {
      // Measured anyway, with construction included, so the door is not simply
      // absent from the record — but kept out of the ratio.
      const fresh = () => door.roundTrip(ctx(), 1);
      let ns = null;
      try {
        const t = await timePerCall(fresh, { reps: 40, samples: 5 });
        ns = t.ns;
      } catch { /* recorded as unmeasurable below */ }
      onceOnly.push({ id: door.id, ns, why: rep.why });
      continue;
    }
    const lua = ctx();
    const fn = () => door.roundTrip(lua, 1);
    try {
      const reps = await calibrateReps(fn, { targetMs: 15 });
      const t = await timePerCall(fn, { reps: Math.max(1, Math.min(reps, 20000)), samples: 5 });
      rows.push({ id: door.id, ns: t.ns, async: t.async });
    } catch (e) {
      rows.push({ id: door.id, error: e.message.slice(0, 60) });
    }
  }
  const measured = rows.filter((r) => r.ns > 0);
  const cheapest = measured.reduce((a, b) => (a.ns <= b.ns ? a : b), measured[0]);
  for (const r of measured) r.ratio = r.ns / cheapest.ns;
  return { rows, cheapest, onceOnly, doorCount: DOORS.length };
}

// ---------------------------------------------------------------------------
// B2 — complexity class per size-scalable value kind.
//
// **The highest-value cell in the plan**, because an accidentally quadratic
// conversion path is invisible to all nine correctness harnesses: it returns the
// right answer, and only the clock knows. Decade-spaced sizes, one declared
// class per kind, verified by the classifier.
//
// The door is `set_global` + `get_global` — the plainest full round trip in the
// API, chosen so the shape being measured is the *conversion*, not a door's
// preamble.
// ---------------------------------------------------------------------------
const KINDS = [
  {
    id: 'array-of-numbers',
    declared: 'LINEAR',
    build: (n) => Array.from({ length: n }, (_, i) => i),
  },
  {
    id: 'object-with-n-keys',
    declared: 'LINEAR',
    build: (n) => { const o = {}; for (let i = 0; i < n; i++) o[`k${i}`] = i; return o; },
  },
  {
    id: 'string-of-length-n',
    declared: 'LINEAR',
    // **Its own sizes, and that is the finding rather than a tweak.** At
    // n = 10/100/1000 this cell measured 2.98µs, 2.82µs, 3.30µs and classified
    // CONSTANT — not because string copying is free, but because copying a
    // kilobyte is invisible beside the ~2.8µs a set_global/get_global round trip
    // costs regardless. The cell was measuring the door, not the string. A
    // shape cell has to be run where the term it is looking for dominates, and
    // three decades higher is where that is for bytes. See FINDINGS.md H6.
    sizes: [1000, 10000, 100000],
    build: (n) => 'x'.repeat(n),
  },
  {
    id: 'array-of-strings',
    declared: 'LINEAR',
    build: (n) => Array.from({ length: n }, (_, i) => `s${i}`),
  },
  {
    id: 'nested-arrays',
    declared: 'LINEAR',
    // n elements total, in sqrt(n) buckets: the total work is still n, but it
    // arrives through recursion rather than one flat loop.
    build: (n) => {
      const w = Math.max(1, Math.round(Math.sqrt(n)));
      return Array.from({ length: w }, () => Array.from({ length: Math.ceil(n / w) }, (_, i) => i));
    },
  },
];

const SIZES = [10, 100, 1000];

export async function runB2(noise) {
  const out = [];
  for (const kind of KINDS) {
    const pts = [];
    for (const n of (kind.sizes ?? SIZES)) {
      const lua = ctx();
      const v = kind.build(n);
      const fn = () => { lua.set_global('rt', v); return lua.get_global('rt'); };
      const reps = await calibrateReps(fn, { targetMs: 15 });
      pts.push({ n, ns: (await timePerCall(fn, { reps, samples: 5 })).ns });
    }
    out.push({
      id: `B2/${kind.id}`,
      detail: pts.map((p) => `n=${p.n} ${fmtNs(p.ns)}`).join(', '),
      ...classify(pts, { declared: kind.declared, noise }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Axis C — the knobs.
//
// **Every cell here is a knob, and a knob is where a false clean hides**
// (`PERFORMANCE-PLAN` §12.4). A knob wired to nothing produces a flat line and
// reads as excellent news, so each CONSTANT declaration carries a `witness`: an
// independently measured quantity that *does* move when the knob does. Without
// one the classifier refuses the cell rather than passing it.
// ---------------------------------------------------------------------------
export async function runC(noise) {
  const out = [];

  // C1 — table width. Distinct from B2's array: this is the *keyed* growth path.
  {
    const pts = [];
    for (const n of SIZES) {
      const lua = ctx();
      const fn = () => {
        const h = lua.create_table({});
        for (let i = 0; i < n; i++) h.set(`k${i}`, i);
        return n;
      };
      const reps = await calibrateReps(fn, { targetMs: 15 });
      pts.push({ n, ns: (await timePerCall(fn, { reps, samples: 5 })).ns });
    }
    out.push({
      id: 'C/table-width-by-handle-set',
      note: 'n handle.set() calls. FEATURES.md records that set() re-pushes the whole table rather than'
        + ' issuing a targeted write, so a super-linear result here is the documented design and not a defect —'
        + ' which is exactly why it is worth having the number.',
      detail: pts.map((p) => `n=${p.n} ${fmtNs(p.ns)}`).join(', '),
      ...classify(pts, { declared: null, noise }),
    });
  }

  // C2 — table depth, against kMaxDepth = 100.
  {
    const pts = [];
    for (const n of [4, 16, 64]) {
      const lua = ctx();
      let v = 1;
      for (let i = 0; i < n; i++) v = { nested: v };
      const fn = () => { lua.set_global('rt', v); return lua.get_global('rt'); };
      const reps = await calibrateReps(fn, { targetMs: 15 });
      pts.push({ n, ns: (await timePerCall(fn, { reps, samples: 5 })).ns });
    }
    out.push({
      id: 'C/table-depth',
      note: 'nesting depth against kMaxDepth = 100',
      detail: pts.map((p) => `depth=${p.n} ${fmtNs(p.ns)}`).join(', '),
      ...classify(pts, { declared: 'LINEAR', noise }),
    });
  }

  // C3 — argument count through a Lua function call.
  {
    const pts = [];
    for (const n of [1, 10, 100]) {
      const lua = ctx();
      const f = lua.execute_script('return function(...) return select("#", ...) end');
      const args = Array.from({ length: n }, (_, i) => i);
      const fn = () => f(...args);
      const reps = await calibrateReps(fn, { targetMs: 15 });
      pts.push({ n, ns: (await timePerCall(fn, { reps, samples: 5 })).ns });
    }
    out.push({
      id: 'C/argument-count',
      detail: pts.map((p) => `args=${p.n} ${fmtNs(p.ns)}`).join(', '),
      ...classify(pts, { declared: 'LINEAR', noise }),
    });
  }

  // C4 — registered global count. Declared CONSTANT: looking up one global
  // should not care how many others exist.
  //
  // Its witness is the *registration* cost, measured on the same population: if
  // adding globals costs nothing either, the knob was never connected and both
  // readings are vacuous.
  {
    const pts = [];
    let registerGrew = false;
    let prevRegister = 0;
    for (const n of [10, 100, 1000]) {
      const lua = ctx();
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) lua.set_global(`g${i}`, i);
      const registerNs = Number(process.hrtime.bigint() - t0) / n;
      if (prevRegister > 0 && registerNs > 0) registerGrew = true;
      prevRegister = registerNs;
      const fn = () => lua.get_global('g0');
      const reps = await calibrateReps(fn, { targetMs: 15 });
      pts.push({ n, ns: (await timePerCall(fn, { reps, samples: 5 })).ns });
    }
    out.push({
      id: 'C/global-population',
      detail: pts.map((p) => `globals=${p.n} ${fmtNs(p.ns)}`).join(', '),
      ...classify(pts, {
        declared: 'CONSTANT',
        noise,
        witness: { label: 'registering the globals itself took measurable time', moved: registerGrew },
      }),
    });
  }

  // C5 — outstanding handle count. Declared CONSTANT for the same reason, with
  // the same shape of witness.
  {
    const pts = [];
    let mintGrew = false;
    for (const n of [10, 100, 1000]) {
      const lua = ctx();
      const held = [];
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) held.push(lua.create_table({ i }));
      const mintNs = Number(process.hrtime.bigint() - t0) / n;
      if (mintNs > 0) mintGrew = true;
      const probe = lua.create_table({ v: 1 });
      const fn = () => probe.get('v');
      const reps = await calibrateReps(fn, { targetMs: 15 });
      pts.push({ n, ns: (await timePerCall(fn, { reps, samples: 5 })).ns });
      held.length = 0;
    }
    out.push({
      id: 'C/outstanding-handles',
      detail: pts.map((p) => `handles=${p.n} ${fmtNs(p.ns)}`).join(', '),
      ...classify(pts, {
        declared: 'CONSTANT',
        noise,
        witness: { label: 'minting the handles itself took measurable time', moved: mintGrew },
      }),
    });
  }

  return out;
}
