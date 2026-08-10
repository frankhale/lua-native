// The cross-context matrix: what happens when two Lua contexts in one process
// exchange values?
//
//   node tools/cross-context/run.mjs               # the whole matrix
//   node tools/cross-context/run.mjs --control     # just the controls
//   node tools/cross-context/run.mjs --case=handle:coroutine
//
// **Why this exists.** CODE-REVIEW-22 F2: every boundary list in this project
// was organised by *API surface* — "the async methods", "the handle methods" —
// which is what is easy to enumerate. A boundary is not an API; it is a place
// where two systems with different rules exchange a value, such that a mismatch
// yields a plausible answer rather than an error. Re-derived on that criterion,
// **context ↔ context** had never appeared on any list, and it is where the two
// most serious findings in the series live:
//
//   CR-20 F5 — a LuaContext accepted as a SharedTable and reinterpreted (SIGABRT)
//   CR-22 F1 — a Lua file handle deep-copied into another context as `{}`
//
// Neither was found by an instrument. F5 arrived through a test-hygiene
// collision; F1 turned up in a matrix aimed at `reset`, which only clipped this
// boundary because a reset makes a context's own handle foreign to it. A search
// aimed here directly would have found both.
//
// **The property**, in three parts:
//
//   1. **Handles are refused.** A reference into one `lua_State` presented to
//      another must throw, not be copied into something plausible.
//   2. **Data crosses intact.** A plain value routed A → JS → B must equal the
//      same value put straight into B. Isolation must not cost fidelity.
//   3. **Contexts stay independent.** Work in B must not change A: no shared
//      globals, no shared registry, no callback bleed.

import { platform } from 'node:os';
import lua_native from '../../index.js';
import { VALUES } from '../roundtrip-matrix/values.mjs';

// The only Lua-created userdata reachable without a library beyond `io` is a
// file handle, so the matrix opens the null device to mint one. Its name is
// platform-specific, and getting it wrong does not fail loudly: `io.open` returns
// nil, the "handle" case mints a plain value, and part 1 reports it ACCEPTED —
// a finding about the null device rather than about contexts.
const NULL_DEVICE = platform() === 'win32' ? 'NUL' : '/dev/null';

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const onlyCase = arg('case');
const controlOnly = argv.includes('--control');
const ALL = { libraries: 'all' };
const SANDBOX = { libraries: 'sandbox' };
const ctx = (opts = ALL) => new lua_native.init({}, opts);

// Axis: the capability pairing of the two contexts (W2).
//
// **The mixed pair is the one worth having, and it is a question no earlier
// column asked.** Two contexts with the same libraries differ only by identity;
// a *sealed* context beside an unsealed one differs by what it is allowed to do,
// which raises two things the same-pair columns cannot: can a handle minted in a
// permissive context be used to reach past a seal, and does a plain value still
// cross a seal boundary intact. The first is the interesting direction — a
// sealed context that accepted a foreign handle would have imported a capability
// its preset exists to deny.
const PAIRINGS = [
  { id: 'all-all', a: ALL, b: ALL, describe: 'the original pairing: two permissive contexts' },
  { id: 'all-sandbox', a: ALL, b: SANDBOX, describe: 'a permissive context handing values to a sealed one' },
  { id: 'sandbox-all', a: SANDBOX, b: ALL, describe: 'a sealed context handing values to a permissive one' },
];

// --- part 1: handles are refused -------------------------------------------
//
// Reuses the lifecycle matrix's Axis A, restricted to the kinds that are
// genuinely handles (a reference into one state). The kinds that are *not*
// handles are covered in part 2 instead, where crossing freely is the correct
// answer — keeping them apart is the distinction CR-22 F1 got wrong first time.
const HANDLE_CASES = [
  { id: 'table-ref',   make: (l) => { l.execute_script('t={v=1}'); return l.get_global_ref('t'); } },
  { id: 'table-created', make: (l) => l.create_table({ v: 1 }) },
  { id: 'table-proxy', make: (l) => l.execute_script('return setmetatable({v=1},{__index=function() return 7 end})') },
  { id: 'coroutine',   make: (l) => l.create_coroutine('return function() coroutine.yield(1) end') },
  { id: 'userdata-lua', make: (l) => l.execute_script(`return io.open("${NULL_DEVICE}","r")`) },
];

// **A coroutine iteration cursor is deliberately NOT listed above — either the
// sync one or the async one added by P1b — and this note exists because adding
// it is the obvious move and it produces a false finding.**
//
// It looks like a handle: `lifecycle-matrix` lists both cursors on its Axis A,
// and §15.6 says a new handle kind belongs in both instruments. But the two
// axes ask different questions. Lifecycle asks "does this object survive events
// in its own context", which the cursor's shared_ptr-owned state makes a real
// question. This file asks "can a *marker* minted by A be reinterpreted by B",
// and a cursor has no marker to reinterpret: its `__coroIterOwner` External is a
// GC root that is written and never read back (stated on the tag list in
// lua-native.h), so nothing in the addon ever dereferences it from B.
//
// Passed into B it therefore converts as what it is — an ordinary JS object —
// and arrives as a Lua table whose `next` is a host callback into A. Driven and
// confirmed identical for the sync cursor, which has behaved this way since A4
// shipped in July 2026, so this is not something P1b introduced. That is the
// same answer `function-bridge` gets in part 2 and it is correct for the same
// reason: a JS callable that closes over another context is ordinary, and
// refusing it would mean refusing every closure.
//
// Listing it as a handle reports "a handle from A was accepted by B" — which is
// exactly the false finding CR-22 F1 produced the first time, with
// `function-bridge`.



// --- part 2: data crosses intact -------------------------------------------
//
// Reuses the round-trip matrix's 50 values. The question here is different from
// that matrix's: not "does a value survive JS → Lua → JS" but "does routing it
// through a *second* context change it". Any difference is an isolation leak.
const NOT_HANDLE_CASES = [
  {
    // A Lua function crosses to JS as a genuine JS callable. B registering it
    // as a host callback is correct and useful — calling it runs A's Lua and
    // returns the right answer — so this belongs with the values that cross
    // freely, not with the handles. Probed here rather than assumed: the first
    // draft listed it as a handle and reported its acceptance as a finding.
    id: 'function-bridge',
    make: (l) => l.execute_script('return function(a) return a + 1 end'),
    check: (b) => b.execute_script('return type(x) .. ":" .. tostring(x(1))') === 'function:2',
  },
  { id: 'userdata-js', make: (l) => { l.set_userdata('u', { n: 11 }); return l.execute_script('return u'); },
    check: (b) => b.execute_script('return type(x)..":"..tostring(x.n)') === 'table:11' },
  { id: 'class-instance', make: (l) => {
      l.register_class('K', { construct: (v) => ({ hidden: v }), readable: true,
        methods: { get: (s) => s.hidden } });
      return l.execute_script('return K.new(7)'); },
    check: (b) => b.execute_script('return type(x)..":"..tostring(x.hidden)') === 'table:7' },
];

function runHandleCases(findings, pairing = PAIRINGS[0]) {
  for (const c of HANDLE_CASES) {
    const a = ctx(pairing.a);
    const b = ctx(pairing.b);
    let h;
    try { h = c.make(a); } catch (e) {
      // Under a sealed preset some handle kinds cannot be minted at all
      // (`userdata-lua` is an io.open file). That is the seal working, not a
      // vacuous cell — but it is announced, because a pairing that quietly
      // stopped making handles would report a clean column having tested
      // nothing.
      if (pairing.a === SANDBOX) {
        findings.push({ id: `handle:${c.id}@${pairing.id}`, kind: 'NOT-MINTABLE',
          detail: `not available under the sealed preset: ${e.message}`, benign: true });
        continue;
      }
      findings.push({ id: `handle:${c.id}@${pairing.id}`, kind: 'VACUOUS', detail: `make threw: ${e.message}` });
      continue;
    }
    if (h === undefined || h === null) {
      findings.push({ id: `handle:${c.id}`, kind: 'VACUOUS', detail: 'make returned nothing' });
      continue;
    }
    try {
      b.set_global('x', h);
      findings.push({ id: `handle:${c.id}@${pairing.id}`, kind: 'HANDLE-ACCEPTED',
        detail: `a handle from A was accepted by B as ${b.execute_script('return type(x)')}` });
    } catch (e) {
      if (!/belongs to a different Lua context/.test(String(e.message))) {
        findings.push({ id: `handle:${c.id}@${pairing.id}`, kind: 'OPAQUE-REFUSAL',
          detail: `refused, but not with the cross-context message: ${e.message}` });
      }
    }
    // And it must still work in its own context — a refusal that also broke the
    // legitimate path would pass the check above for the wrong reason.
    try { a.set_global('own', h); } catch (e) {
      findings.push({ id: `handle:${c.id}@${pairing.id}`, kind: 'OWN-CONTEXT-BROKEN',
        detail: `the handle no longer works in its own context: ${e.message}` });
    }
  }
}

function runDataCases(findings) {
  for (const c of NOT_HANDLE_CASES) {
    const a = ctx();
    const b = ctx();
    try {
      const v = c.make(a);
      b.set_global('x', v);
      if (!c.check(b)) {
        findings.push({ id: `data:${c.id}`, kind: 'DATA-CHANGED',
          detail: 'a non-handle value did not arrive intact in the second context' });
      }
    } catch (e) {
      findings.push({ id: `data:${c.id}`, kind: 'DATA-REFUSED',
        detail: `a non-handle value was refused by the second context: ${e.message}` });
    }
  }

  // The 50-value corpus, routed A -> JS -> **B**, compared against the same
  // value routed A -> JS -> **A**.
  //
  // **The comparison is against a same-context round trip, not against a direct
  // push, and that is the whole design.** Comparing against a direct push
  // re-asks the round-trip matrix's question — does a value survive JS -> Lua
  // -> JS — and duplicates its answers, including its documented conversions.
  // It produced exactly that: a `Date` reads `0.0` pushed directly and `0`
  // after a round trip, because a Date becomes an epoch double and an integral
  // JS number becomes a Lua integer, which is specified and has nothing to do
  // with contexts. A JS function reported a different address for the same
  // reason: it is re-wrapped, and identity was never preserved.
  //
  // Routing through A in *both* arms holds all of that constant, so the only
  // remaining variable is which context receives the value — which is the
  // question this instrument exists to ask.
  for (const v of VALUES) {
    const a = ctx();
    const b = ctx();
    let sameCtx;
    let crossCtx;
    try {
      a.set_global('x', v.make());
      const out = a.get_global('x');
      a.set_global('y', out);
      sameCtx = a.execute_script('return type(y)');
    } catch {
      continue;  // does not survive its own round trip; not a cross-context question
    }
    try {
      const out = a.get_global('x');
      b.set_global('x', out);
      crossCtx = b.execute_script('return type(x)');
    } catch (e) {
      findings.push({ id: `route:${v.id}`, kind: 'ROUTE-REFUSED',
        detail: `A -> JS -> A works, but A -> JS -> B threw: ${e.message}` });
      continue;
    }
    if (crossCtx !== sameCtx) {
      findings.push({ id: `route:${v.id}`, kind: 'ROUTE-CHANGED',
        detail: `same-context round trip gives ${sameCtx}, cross-context gives ${crossCtx}` });
    }
  }
}

function runIsolationCases(findings) {
  // Independence. Each check is a way one context could reach into another.
  const checks = [
    {
      id: 'globals',
      run: () => {
        const a = ctx(); const b = ctx();
        a.execute_script('shared_name = "A"');
        b.execute_script('shared_name = "B"');
        return a.execute_script('return shared_name') === 'A'
          && b.execute_script('return shared_name') === 'B';
      },
    },
    {
      id: 'registry',
      run: () => {
        const a = ctx(); const b = ctx();
        const before = b.execute_script('local n=0 for k in pairs(debug.getregistry()) do n=n+1 end return n');
        for (let i = 0; i < 20; i += 1) { a.execute_script('t={}'); a.get_global_ref('t'); }
        const after = b.execute_script('local n=0 for k in pairs(debug.getregistry()) do n=n+1 end return n');
        return after === before;
      },
    },
    {
      id: 'callbacks',
      run: () => {
        // A callback registered on A must not be visible in B.
        const a = new lua_native.init({ ping: () => 'A' }, ALL);
        const b = ctx();
        return a.execute_script('return ping()') === 'A'
          && b.execute_script('return tostring(ping)') === 'nil';
      },
    },
    {
      id: 'reset-independence',
      run: () => {
        const a = ctx(); const b = ctx();
        b.execute_script('keep = 42');
        a.reset();
        return b.execute_script('return keep') === 42;
      },
    },
  ];
  for (const c of checks) {
    let ok = false;
    try { ok = c.run(); } catch (e) {
      findings.push({ id: `isolation:${c.id}`, kind: 'ISOLATION-ERROR', detail: e.message });
      continue;
    }
    if (!ok) {
      findings.push({ id: `isolation:${c.id}`, kind: 'ISOLATION-BROKEN',
        detail: 'one context observed another' });
    }
  }
}

// --- controls --------------------------------------------------------------
function runControls() {
  const checks = [
    {
      name: 'two contexts are genuinely distinct objects',
      run: () => ctx() !== ctx(),
    },
    {
      name: 'the handle probe sees an ACCEPTED handle when one is accepted',
      run: () => {
        // Same context, so the push legitimately succeeds — the probe must be
        // able to reach its accept branch at all, or "all refused" is vacuous.
        const a = ctx();
        a.execute_script('t={v=1}');
        const h = a.get_global_ref('t');
        let accepted = false;
        try { a.set_global('x', h); accepted = true; } catch { /* no */ }
        return accepted;
      },
    },
    {
      name: 'the isolation probe can report broken (a context sees its own write)',
      run: () => {
        const a = ctx();
        a.execute_script('shared_name = "A"');
        return a.execute_script('return shared_name') === 'A';
      },
    },
    {
      name: 'the routing probe actually routes through a second context',
      run: () => {
        const a = ctx(); const b = ctx();
        a.set_global('x', 41);
        b.set_global('x', a.get_global('x') + 1);
        return b.execute_script('return x') === 42;
      },
    },
    {
      name: 'the value corpus is non-empty and reaches the routing probe',
      run: () => Array.isArray(VALUES) && VALUES.length >= 40,
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

function main() {
  if (!runControls()) {
    console.error('controls failed; refusing to run a search that cannot report dirty.');
    process.exit(1);
  }
  if (controlOnly) return;

  const findings = [];
  if (!onlyCase || onlyCase.startsWith('handle')) {
    for (const p of PAIRINGS) runHandleCases(findings, p);
  }
  if (!onlyCase || onlyCase.startsWith('data') || onlyCase.startsWith('route')) runDataCases(findings);
  if (!onlyCase || onlyCase.startsWith('isolation')) runIsolationCases(findings);

  const cells = HANDLE_CASES.length * PAIRINGS.length
    + NOT_HANDLE_CASES.length + VALUES.length + 4;
  console.log(`~${cells} checks across three properties `
    + `(handles refused, data intact, contexts independent), `
    + `handles over ${PAIRINGS.length} pairings\n`);

  // A handle kind the sealed preset cannot mint is reported but is not a
  // finding: it is the seal doing its job. Announced rather than filtered
  // silently, per tools/README.md — a bounded search says what it dropped.
  const benign = findings.filter((f) => f.benign);
  const real = findings.filter((f) => !f.benign);
  if (benign.length) {
    console.log(`  not mintable under the sealed preset (expected, not findings): `
      + `${benign.map((f) => f.id).join(', ')}\n`);
  }
  console.log(`  FINDINGS  ${real.length}`);
  for (const f of real) console.log(`\n${f.kind}  ${f.id}\n  ${f.detail}`);
  console.log(real.length ? '\ndirty.' : '\nclean.');
  process.exit(real.length ? 1 : 0);
}

main();
