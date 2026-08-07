// Axis A — the performance claims shipped documentation makes, each restated as
// a falsifiable proposition and measured.
//
// **More cells than the plan's four, and the provenance is the interesting
// part** (a count is deliberately not restated here — `runClaims` below is the
// census of this list, and a tally in a comment is the stale marker
// `docs/README.md` rule 1 warns about, which this very paragraph used to be):
//
//   - **C1–C4** — `PERFORMANCE-PLAN` §1, arrived at by grepping the README.
//   - **C5–C9** — the `perf-claims` census, on its first run over the wider
//     surface the same section defines (README + `docs/*.md` + `types.d.ts`,
//     which ships). Equally shipped, equally unmeasured, and — like C2 — four of
//     them state a threshold the reader is expected to act on. That is the
//     plan's own enumeration coming up short at the fifth level, and the census
//     earning its place on its first run rather than later. See `FINDINGS.md` E1.
//   - **C10** — the census firing *forwards* for the first time (August 7,
//     2026): F1 measured something the docs did not say, the sentence was added,
//     and it could not ship without this cell because a claim-shaped line no cell
//     measures turns the suite red.
//
// See `FINDINGS.md` E1 and F1.
//
// Every cell here is a **ratio or a shape**, never an elapsed time compared
// against a stored one (§4). C6 arrived as the exception — an absolute
// microsecond figure in `types.d.ts` — and measuring it is what retired the
// exception: the figure was wrong by 5–20x on this hardware, the sentence was
// restated in terms of its mechanism, and the cell now tests the mechanism. §4
// predicted that an absolute number in shipped docs is a claim nothing here can
// defend; C6 is the instance.

import lua_native from '../../index.js';
import { calibrateReps, timePerCall, fmtNs } from './measure.mjs';
import { classify, ratioVerdict } from './classify.mjs';

const ctx = (options = {}) => new lua_native.init({}, { libraries: 'all', ...options });

// A converter that never matches. Registration order decides precedence and the
// first match wins, so N of these force a full scan of length N.
const missConverter = () => [(_v) => false, (v) => v];

function withMisses(lua, n) {
  for (let i = 0; i < n; i++) {
    const [m, c] = missConverter();
    lua.register_from_lua_converter(m, c);
  }
}

// ---------------------------------------------------------------------------
// C1 / A1-fast-path
//   "every number and string crossing out of Lua stays on the fast path"
//   README.md:614
//
// Restated: the cost of a number or string result crossing Lua→JS is CONSTANT
// in the number of registered from-Lua converters. The docs are explicit that
// converters "see only object-valued results, mirroring how the JS → Lua
// direction skips primitives, which keeps the common path free of a JS call per
// number and string" — so a scalar must not pay for the list at all.
//
// **Its witness is A2.** A CONSTANT verdict has to prove the knob was connected
// (`classify.mjs`), and the proof here is that the *same* knob, measured on the
// object-valued path in A2, moves the cost. Without that, "flat" and "wired to
// nothing" are the same measurement.
// ---------------------------------------------------------------------------
async function a1FastPath(noise, witnessMoved) {
  const pts = [];
  for (const k of [1, 10, 100]) {
    const lua = ctx();
    withMisses(lua, k);
    const f = lua.execute_script('return function() return 42 end');
    const fn = () => f();
    const reps = await calibrateReps(fn);
    const t = await timePerCall(fn, { reps });
    pts.push({ n: k, ns: t.ns });
  }
  const strings = [];
  for (const k of [1, 100]) {
    const lua = ctx();
    withMisses(lua, k);
    const f = lua.execute_script("return function() return 'hello world' end");
    const fn = () => f();
    const reps = await calibrateReps(fn);
    strings.push({ n: k, ns: (await timePerCall(fn, { reps })).ns });
  }
  return {
    id: 'A1-fast-path',
    claim: 'C1',
    site: 'README.md:614',
    proposition: 'a number or string result crossing Lua→JS costs the same with 1 and with 100 registered from-Lua converters',
    detail: `number: ${pts.map((p) => `k=${p.n} ${fmtNs(p.ns)}`).join(', ')}`
      + ` | string: ${strings.map((p) => `k=${p.n} ${fmtNs(p.ns)}`).join(', ')}`,
    ...classify(pts, {
      declared: 'CONSTANT',
      noise,
      witness: { label: 'A2: the same converter list moves the object-valued path', moved: witnessMoved },
    }),
  };
}

// ---------------------------------------------------------------------------
// C2 / A2-converter-scan
//   "every registered `match` runs for every object-valued result crossing
//    Lua → JS, in registration order, until one matches. Keep `match` cheap."
//   README.md:3177, and the same sentence in types.d.ts
//
// The only claim in the tree the docs ask the *user* to act on, so both failure
// modes are findings: a flat slope means the advice is unnecessary, and a
// super-linear slope means it is insufficient.
//
// Two propositions, because the sentence makes two: the scan is linear in the
// number of converters, and it is *ordered* — a converter matching at index 0
// must beat one matching at index N.
// ---------------------------------------------------------------------------
async function a2ConverterScan(noise) {
  const pts = [];
  for (const k of [1, 10, 100]) {
    const lua = ctx();
    withMisses(lua, k);
    const f = lua.execute_script('return function() return {a=1} end');
    const fn = () => f();
    const reps = await calibrateReps(fn);
    pts.push({ n: k, ns: (await timePerCall(fn, { reps })).ns });
  }

  // Order sensitivity. Same population, different position for the one that
  // matches: first-registered wins, so an early match must short-circuit.
  const N = 100;
  const order = {};
  for (const where of ['first', 'last']) {
    const lua = ctx();
    const hit = [(v) => typeof v === 'object' && v !== null, (v) => v];
    if (where === 'first') lua.register_from_lua_converter(...hit);
    withMisses(lua, N);
    if (where === 'last') lua.register_from_lua_converter(...hit);
    const f = lua.execute_script('return function() return {a=1} end');
    const fn = () => f();
    const reps = await calibrateReps(fn);
    order[where] = (await timePerCall(fn, { reps })).ns;
  }
  const ordered = order.last > order.first * (1 + noise);

  const shape = classify(pts, { declared: 'LINEAR', noise });
  return {
    id: 'A2-converter-scan',
    claim: 'C2',
    site: 'README.md:3177, types.d.ts',
    proposition: 'object-valued result cost is linear in converter count, and a match at index 0 beats a match at index N',
    detail: `${pts.map((p) => `k=${p.n} ${fmtNs(p.ns)}`).join(', ')}`
      + ` | match first ${fmtNs(order.first)} vs last ${fmtNs(order.last)}`
      + ` — ${ordered ? 'ordered as documented' : 'NOT order-sensitive'}`,
    orderSensitive: ordered,
    growth: pts[pts.length - 1].ns / pts[0].ns,
    ...shape,
    verdict: shape.verdict === 'PASS' && !ordered ? 'FAIL' : shape.verdict,
    reason: shape.verdict === 'PASS' && !ordered
      ? 'cost scales with the converter count, but a match at index 0 is not cheaper than one at index N —'
        + ' the documented "in registration order, until one matches" short-circuit is not observable'
      : shape.reason,
  };
}

// ---------------------------------------------------------------------------
// C3 / A3-sampling-bound
//   "`count` is the option to reach for when tracing whole programs — it
//    samples instead of reporting everything, so the overhead stays bounded"
//   README.md:1029-1030
//
// **Read the claim, not a restatement of it** (H5). This cell first tested
// whether overhead scales as 1/count, failed at 1.24x against an expected 10x,
// and looked like a finding. It was not: "instead of reporting everything" names
// **line mode**, which is what reports everything. The proposition the sentence
// actually makes is a comparison against `line: true`, and the plan's §5 table
// had invented a different one. Driving the failure to a reproduction is what
// surfaced that — the rule that has now paid thirteen times.
//
// The decomposition — hook overhead is `fixed + per-fire x fires`, and the fixed
// part is the cost of having any hook installed at all — is *reported* here
// rather than asserted, because this cell's proposition is the count-vs-line
// comparison and a cell that carries two propositions cannot say which one a
// FAIL belongs to. It was reported-only for one day (F1: the decomposition was
// decision-relevant and the docs did not mention it). **The README now does
// mention it**, which makes it a shipped claim rather than an observation, so
// `A10-hook-fixed-floor` asserts it. See `FINDINGS.md` F1.
// ---------------------------------------------------------------------------
async function a3SamplingBound(noise) {
  const SCRIPT = 'local s=0 for i=1,20000 do s=s+i%7 end return s';
  const measure = async (opts) => {
    const lua = ctx();
    if (opts) lua.set_hook(() => {}, opts);
    const fn = () => lua.execute_script(SCRIPT);
    const reps = await calibrateReps(fn);
    return (await timePerCall(fn, { reps })).ns;
  };
  const base = await measure(null);
  const line = await measure({ line: true });
  const fine = await measure({ count: 1000 });

  // The fixed component, isolated: an interval coarser than the whole script
  // fires zero times, so whatever overhead remains is not per-fire.
  const never = await measure({ count: 10_000_000 });
  const fixed = never - base;
  const overheadLine = line - base;
  const overheadCount = fine - base;

  const r = ratioVerdict(overheadLine, overheadCount, 10, { tolerance: 0.9, noise });
  // A ratio far *above* the expected 10x still confirms "bounded" — the claim is
  // one-sided. Only a count mode that fails to be much cheaper falsifies it.
  const verdict = overheadCount <= 0 ? 'VACUOUS'
    : overheadLine / overheadCount >= 10 ? 'PASS' : r.verdict;
  return {
    id: 'A3-sampling-bound',
    claim: 'C3',
    site: 'README.md:1029-1030',
    proposition: 'count-mode overhead is bounded well below line mode, which is what "reporting everything" means',
    detail: `no hook ${fmtNs(base)} | line:true +${fmtNs(overheadLine)} | count=1000 +${fmtNs(overheadCount)}`
      + ` | ${(overheadLine / overheadCount).toFixed(0)}x cheaper`
      + ` || fixed component (hook installed, never fires) +${fmtNs(fixed)}`
      + ` = ${((fixed / overheadCount) * 100).toFixed(0)}% of count-mode overhead`,
    fixedShare: fixed / overheadCount,
    verdict,
    reason: verdict === 'PASS' ? undefined
      : verdict === 'VACUOUS' ? 'count mode added no measurable overhead; nothing to bound'
        : `count mode is only ${(overheadLine / overheadCount).toFixed(1)}x cheaper than line mode`,
  };
}

// ---------------------------------------------------------------------------
// C10 / A10-hook-fixed-floor
//   "Hook overhead is `fixed + per-fire x fires` ... widening it further buys
//    nothing measurable ... the fixed part was already most of the overhead at
//    `count: 1000`"
//   README.md:1063-1071
//
// The claim F1 recommended and the README now makes, restated as two
// propositions and measured as two ratios:
//
//   1. the fixed component is **most** of count-mode overhead at `count: 1000`
//      — a share, not a figure;
//   2. an interval coarse enough to fire a handful of times has **converged**
//      onto that floor, so widening it further changes nothing measurable.
//
// **Its vacuity check is the fine interval**, and it is the whole reason this
// cell can be believed. A hook that was never installed, a `count` option
// silently ignored, or a script too short to reach the interval would each
// produce a flat line across every interval — which reads as proposition 2
// holding perfectly while measuring nothing at all. This is `tools/README.md`'s
// knob rule (*whenever a new axis is a knob rather than a value, ask what it
// would look like if the knob were disconnected*), and here the disconnected
// knob and the confirmed claim have the *same* shape, so the witness is not
// optional. `count: 100` must therefore cost measurably more than the
// never-fires floor before either proposition is scored.
// ---------------------------------------------------------------------------
async function a10HookFixedFloor(noise) {
  // The same workload A3 uses: ~20k iterations, so `count: 100` fires hundreds
  // of times, `count: 10_000` a handful, and `count: 10_000_000` never.
  const SCRIPT = 'local s=0 for i=1,20000 do s=s+i%7 end return s';
  const measure = async (opts) => {
    const lua = ctx();
    if (opts) lua.set_hook(() => {}, opts);
    const fn = () => lua.execute_script(SCRIPT);
    const reps = await calibrateReps(fn);
    return (await timePerCall(fn, { reps })).ns;
  };
  const base = await measure(null);
  const fine = (await measure({ count: 100 })) - base;
  const practical = (await measure({ count: 1000 })) - base;
  const coarse = (await measure({ count: 10_000 })) - base;
  const floor = (await measure({ count: 10_000_000 })) - base;

  // Band for "no measurable difference". The noise floor is measured on a bare
  // JS probe and is narrower than a run that enters Lua, so it is a lower bound
  // on this comparison rather than the right band on its own.
  const band = 1 + Math.max(noise, 0.15);
  const share = practical > 0 ? floor / practical : NaN;
  const convergence = floor > 0 ? coarse / floor : NaN;

  // The knob must be connected before either proposition means anything.
  const witnessMoved = fine > floor * band && floor > 0;
  const verdict = !witnessMoved ? 'VACUOUS'
    : share > 0.5 && convergence <= band ? 'PASS' : 'FAIL';

  return {
    id: 'A10-hook-fixed-floor',
    claim: 'C10',
    site: 'README.md:1063-1071',
    proposition: 'hook overhead is fixed + per-fire x fires: the fixed part is most of it at count=1000,'
      + ' and a coarser interval has already converged onto that floor',
    detail: `no hook ${fmtNs(base)} | +count=100 ${fmtNs(fine)} | +count=1000 ${fmtNs(practical)}`
      + ` | +count=10000 ${fmtNs(coarse)} | +never-fires ${fmtNs(floor)}`
      + ` || fixed share at count=1000 ${(share * 100).toFixed(0)}%`
      + ` | coarse/floor ${convergence.toFixed(2)}x`,
    fixedShare: share,
    ratio: convergence,
    verdict,
    reason: verdict === 'PASS' ? undefined
      : !witnessMoved
        ? `count=100 cost ${fmtNs(fine)} against a ${fmtNs(floor)} floor — the per-fire component is not`
          + ' measurable here, so a flat line across intervals is not evidence of convergence'
        : share <= 0.5
          ? `the fixed component is only ${(share * 100).toFixed(0)}% of count=1000 overhead —`
            + ' the README says it is most of it'
          : `count=10000 costs ${convergence.toFixed(2)}x the never-fires floor — widening the interval`
            + ' is still buying something, so "buys nothing measurable" is stated too early',
  };
}

// ---------------------------------------------------------------------------
// C4 / A4-bytecode-start
//   "compile Lua to bytecode ... load with load_bytecode() for faster startup"
//   README.md:35, README.md:1357
// ---------------------------------------------------------------------------
async function a4BytecodeStart(noise) {
  const SRC = Array.from({ length: 40 }, (_, i) => `local x${i} = ${i} * 2`).join('\n')
    + '\nreturn 1';
  const lua = ctx();
  const bc = lua.compile(SRC);
  const src = () => lua.execute_script(SRC);
  const byte = () => lua.load_bytecode(bc);
  const rs = await calibrateReps(src);
  const tSrc = (await timePerCall(src, { reps: rs })).ns;
  const rb = await calibrateReps(byte);
  const tByte = (await timePerCall(byte, { reps: rb })).ns;
  const speedup = tSrc / tByte;
  return {
    id: 'A4-bytecode-start',
    claim: 'C4',
    site: 'README.md:35, README.md:1357',
    proposition: 'load_bytecode(compiled) is cheaper than execute_script(source) for the same chunk',
    detail: `source ${fmtNs(tSrc)} | bytecode ${fmtNs(tByte)} | ${speedup.toFixed(2)}x`,
    speedup,
    verdict: speedup > 1 + noise ? 'PASS' : (Math.abs(speedup - 1) <= noise ? 'FAIL' : 'FAIL'),
    reason: speedup > 1 + noise ? undefined
      : `bytecode is ${speedup >= 1 ? 'no faster' : 'slower'} (${speedup.toFixed(2)}x) — the claim is not observable`,
  };
}

// ---------------------------------------------------------------------------
// C5 / A5-async-threshold — found by the census, not by the plan
//   "Short scripts (< 1ms): The overhead of creating an AsyncWorker, queuing
//    it, and marshalling results back exceeds the execution time. The
//    synchronous path is faster."   docs/ASYNC.md:84-86
//
// Shipped guidance under `### When It Is NOT Worth It`, with a numeric
// threshold the reader is told to route on. Restated as the comparison it is.
// ---------------------------------------------------------------------------
async function a5AsyncThreshold(noise) {
  const SHORT = 'local s=0 for i=1,200 do s=s+i end return s';
  const lua = ctx();
  const sync = () => lua.execute_script(SHORT);
  const rs = await calibrateReps(sync);
  const tSync = (await timePerCall(sync, { reps: rs })).ns;

  const asyncFn = () => lua.execute_script_async(SHORT);
  const tAsync = (await timePerCall(asyncFn, { reps: 60, samples: 5 })).ns;

  const ratio = tAsync / tSync;
  return {
    id: 'A5-async-threshold',
    claim: 'C5 (census-found)',
    site: 'docs/ASYNC.md:84-86',
    proposition: 'for a sub-millisecond script the synchronous path is faster than execute_script_async',
    detail: `sync ${fmtNs(tSync)} | async ${fmtNs(tAsync)} | async costs ${ratio.toFixed(1)}x sync`,
    ratio,
    verdict: ratio > 1 + noise ? 'PASS' : 'FAIL',
    reason: ratio > 1 + noise ? undefined
      : `async is not slower for a short script (${ratio.toFixed(2)}x) — the routing advice is not supported`,
  };
}

// ---------------------------------------------------------------------------
// C6 / A6-timeout-overshoot — found by the census, not by the plan
//   "granularity is the hook's sampling interval, so expect overshoot on the
//    order of a few hundred microseconds rather than exactness."  types.d.ts
//
// **This claim was measurably wrong as originally written, and the way it was
// wrong is the plan's own §4 rule arriving as evidence.** The sentence used to
// read "expect overshoot on the order of a few hundred microseconds". Measured
// here: 13–85µs, i.e. tens of microseconds — off by roughly 5–20x, in the
// forgiving direction. It was not a defect in the binding; it was an absolute
// figure in shipped documentation, and an absolute figure is a claim about the
// hardware it was written on. The mechanism is fixed (`InstallExecutionHook`
// checks the deadline every 1000 VM instructions for a timeout-only context);
// how long 1000 instructions take is not.
//
// So the cell tests the **mechanism**, in two machine-independent forms, and
// `types.d.ts` was restated to match. See `FINDINGS.md` F2.
// ---------------------------------------------------------------------------
async function a6TimeoutOvershoot(noise) {
  const overshootFor = async (timeoutMs) => {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const lua = ctx({ timeout: timeoutMs });
      const t0 = process.hrtime.bigint();
      try { lua.execute_script('while true do end'); } catch { /* the timeout is the point */ }
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6 - timeoutMs);
    }
    samples.sort((a, b) => a - b);
    return samples;
  };

  const at50 = await overshootFor(50);
  const at200 = await overshootFor(200);
  const us50 = at50[0] * 1000;
  const us200 = at200[0] * 1000;

  // Proposition 1: overshoot is a small fraction of the deadline it overshoots.
  const share = at50[0] / 50;
  const small = share > 0 && share < 0.01;

  // Proposition 2 — the mechanism claim. Overshoot is a function of the
  // sampling interval, not of the deadline, so quadrupling the timeout must not
  // meaningfully grow it. This is what makes the claim checkable on any
  // machine: both measurements move together with CPU speed and cancel.
  const grew = us200 > Math.max(us50 * 3, us50 + 500);

  const verdict = !small ? 'FAIL' : grew ? 'FAIL' : 'PASS';
  return {
    id: 'A6-timeout-overshoot',
    claim: 'C6 (census-found)',
    site: 'types.d.ts (timeout)',
    proposition: 'timeout overshoot is bounded by the hook sampling interval: a small fraction of the deadline, and independent of it',
    detail: `timeout=50ms overshoot ${us50.toFixed(0)}µs (${(share * 100).toFixed(3)}% of deadline)`
      + ` | timeout=200ms overshoot ${us200.toFixed(0)}µs — ${grew ? 'GREW with the deadline' : 'independent of the deadline'}`,
    overshootUs: us50,
    verdict,
    reason: verdict === 'PASS' ? undefined
      : !small ? `overshoot is ${(share * 100).toFixed(2)}% of the deadline — not "granularity", a real delay`
        : 'overshoot grew with the timeout, so it is not bounded by the sampling interval as documented',
  };
}

// ---------------------------------------------------------------------------
// C7 / A7-parse-overhead — found by the census, not by the plan
//   "Parsing overhead. Every `execute_script` call compiles Lua source. For
//    hot paths, this is wasteful."   docs/TABLE-REFERENCE.md:50
//
// The motivating claim for the entire table-reference API, so if it is not
// true the API's stated rationale is not either.
// ---------------------------------------------------------------------------
async function a7ParseOverhead(noise) {
  const lua = ctx();
  const BODY = 'local s=0 for i=1,50 do s=s+i end return s';
  const viaScript = () => lua.execute_script(BODY);
  const f = lua.execute_script(`return function() ${BODY} end`);
  const viaHandle = () => f();
  const r1 = await calibrateReps(viaScript);
  const tScript = (await timePerCall(viaScript, { reps: r1 })).ns;
  const r2 = await calibrateReps(viaHandle);
  const tHandle = (await timePerCall(viaHandle, { reps: r2 })).ns;
  const ratio = tScript / tHandle;
  return {
    id: 'A7-parse-overhead',
    claim: 'C7 (census-found)',
    site: 'docs/TABLE-REFERENCE.md:50',
    proposition: 'execute_script recompiles its source every call, so it costs more than calling a retained function that runs the same body',
    detail: `execute_script ${fmtNs(tScript)} | retained handle ${fmtNs(tHandle)} | ${ratio.toFixed(1)}x`,
    ratio,
    verdict: ratio > 1 + noise ? 'PASS' : 'FAIL',
    reason: ratio > 1 + noise ? undefined
      : `execute_script is not measurably more expensive (${ratio.toFixed(2)}x); the stated rationale is not observable`,
  };
}

// ---------------------------------------------------------------------------
// C8 / A8-js-to-lua-scan — found by the census, not by the plan
//   "Performance note: every registered `match` predicate runs for every
//    object-typed value crossing JS→Lua, in registration order, until one
//    matches. Keep `match` cheap and register only the converters you need."
//   types.d.ts (register_type_converter)
//
// C2's mirror, and a separate claim about a separate list: C2 is
// `register_from_lua_converter` (Lua→JS), this is `register_type_converter`
// (JS→Lua). The plan's enumeration had neither direction separated because it
// only read the README, where the JS→Lua sentence does not appear.
// ---------------------------------------------------------------------------
async function a8JsToLuaScan(noise) {
  const pts = [];
  for (const k of [1, 10, 100]) {
    const lua = ctx();
    for (let i = 0; i < k; i++) lua.register_type_converter(() => false, (v) => v);
    const obj = { a: 1, b: 2 };
    const fn = () => { lua.set_global('rt', obj); return 1; };
    const reps = await calibrateReps(fn);
    pts.push({ n: k, ns: (await timePerCall(fn, { reps })).ns });
  }
  return {
    id: 'A8-js-to-lua-scan',
    claim: 'C8 (census-found)',
    site: 'types.d.ts (register_type_converter)',
    proposition: 'an object crossing JS→Lua pays a scan linear in the number of registered type converters',
    detail: pts.map((p) => `k=${p.n} ${fmtNs(p.ns)}`).join(', '),
    ...classify(pts, { declared: 'LINEAR', noise }),
  };
}

// ---------------------------------------------------------------------------
// C9 / A9-proxy-read — found by the census, not by the plan
//   "Matching against a Proxy is not free either — each property read runs the
//    Lua `__index` path."   README.md:3178, types.d.ts
//
// A warning attached to C2, and a distinct measurable claim: a property read on
// a Proxy-wrapped metatabled table must cost measurably more than the same read
// on the plain object a non-metatabled table produces.
// ---------------------------------------------------------------------------
async function a9ProxyRead(noise) {
  const lua = ctx();
  const plain = lua.execute_script('return { a = 1 }');
  const proxied = lua.execute_script(
    'local t = setmetatable({ a = 1 }, { __index = function(_, k) return 1 end }) return t',
  );
  const isProxy = typeof proxied === 'object' && proxied !== null;
  const fPlain = () => plain.a;
  const fProxy = () => proxied.a;
  const rp = await calibrateReps(fPlain);
  const tPlain = (await timePerCall(fPlain, { reps: rp })).ns;
  const rq = await calibrateReps(fProxy);
  const tProxy = (await timePerCall(fProxy, { reps: rq })).ns;
  const ratio = tProxy / tPlain;
  return {
    id: 'A9-proxy-read',
    claim: 'C9 (census-found)',
    site: 'README.md:3178, types.d.ts',
    proposition: 'a property read on a metatabled (Proxy) result costs more than the same read on a plain converted table',
    detail: `plain object ${fmtNs(tPlain)} | Proxy ${fmtNs(tProxy)} | ${ratio.toFixed(1)}x`,
    ratio,
    verdict: !isProxy ? 'VACUOUS' : ratio > 1 + noise ? 'PASS' : 'FAIL',
    reason: !isProxy ? 'the metatabled result did not come back as an object; nothing was compared'
      : ratio > 1 + noise ? undefined
        : `a Proxy read costs ${ratio.toFixed(2)}x a plain read — "not free" is not observable`,
  };
}

// ---------------------------------------------------------------------------
// The product-wiring control.
//
// Distinct from the classifier controls, which touch no Lua: this one proves
// **the claims axis is connected to the binding at all**. A converter whose
// `match` does fixed busy work must move A2's measured cost. If it does not,
// then either the converters are not being consulted or the harness is not
// measuring the path it thinks it is, and every verdict above is vacuous —
// including, especially, A1's flat line.
// ---------------------------------------------------------------------------
export async function runProductControl(noise) {
  const build = async (busy) => {
    const lua = ctx();
    for (let i = 0; i < 20; i++) {
      lua.register_from_lua_converter(() => {
        if (busy) { let a = 0; for (let j = 0; j < 400; j++) a += j % 7; if (a === -1) return true; }
        return false;
      }, (v) => v);
    }
    const f = lua.execute_script('return function() return {a=1} end');
    const fn = () => f();
    const reps = await calibrateReps(fn);
    return (await timePerCall(fn, { reps })).ns;
  };
  const plain = await build(false);
  const slowed = await build(true);
  const ratio = slowed / plain;
  return {
    id: 'product/injected-slowdown',
    describe: 'a converter whose match does busy work must move the object-valued path',
    detail: `plain ${fmtNs(plain)} -> slowed ${fmtNs(slowed)} (${ratio.toFixed(2)}x)`,
    verdict: ratio > 1 + Math.max(noise, 0.15) ? 'PASS' : 'FAIL',
    reason: ratio > 1 + Math.max(noise, 0.15) ? undefined
      : `injecting work into 20 converters changed cost by only ${ratio.toFixed(2)}x —`
        + ' the claims axis is not measuring the converter path, so A1 and A2 are vacuous',
  };
}

export async function runClaims(noise) {
  const a2 = await a2ConverterScan(noise);
  // A1's witness: did the same knob move the object-valued path?
  const witnessMoved = Number.isFinite(a2.growth) && a2.growth > 1 + noise;
  const a1 = await a1FastPath(noise, witnessMoved);
  return [
    a1,
    a2,
    await a3SamplingBound(noise),
    await a4BytecodeStart(noise),
    await a5AsyncThreshold(noise),
    await a6TimeoutOvershoot(noise),
    await a7ParseOverhead(noise),
    await a8JsToLuaScan(noise),
    await a9ProxyRead(noise),
    await a10HookFixedFloor(noise),
  ];
}
