// Machine-checked source invariants.
//
// Why this file exists
// --------------------
// Seventeen review passes produced one intervention that demonstrably stopped a
// defect class from recurring: turning a comment into something the build or the
// suite checks (the `static_assert` on marker-tag distinctness, CR-15 F6a; the
// generative `assert` on occupancy-policy shape, CR-16 F4). Everything that
// stayed a hand-maintained list in a comment decayed instead — the `CallScope`
// enumeration was repaired in CR-13, CR-14 and CR-15 and was wrong each time;
// the `lua_next` traversal list was incomplete on arrival (CR-15 F3); a
// "33 synchronous methods" count was stated in four places and was 31.
//
// The lists here are therefore **generated from the source and frozen**. Each
// invariant computes its answer by scanning the tree, and the test compares that
// answer against `expected.json`. Changing the source's shape is
// allowed; changing it *silently* is not — the diff shows up in review.
//
//   node tools/invariants/run.mjs            # report (exit 1 on drift)
//   node tools/invariants/run.mjs --update   # re-freeze after a reviewed change
//
// `tests/ts/invariants.spec.ts` runs the same checks, so drift is a red suite.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSource, topLevelFunctions, stripCommentsAndStrings, stripComments, tryGuardMap,
  unattributedDefinitions,
} from '../cpp-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BINDING = join(ROOT, 'src/lua-native.cpp');
const CORE = join(ROOT, 'src/core/lua-runtime.cpp');

// ---------------------------------------------------------------------------
// 1. The CallScope classification
// ---------------------------------------------------------------------------
//
// `lua-native.h` states the invariant and its predicate: within the universe of
// functions that can run user JS, a `CallScope` should appear above the first
// `.Get(` / `.Call(` / `GetPropertyNames(` / `NapiToCoreInstance(` /
// `CoreToNapi(` / `LuaFunctionDataFrom(` / `TableRefDataFrom(` line, plus the
// `Has` reads and the two global-reading helpers the same paragraph names as
// counting for their caller.
//
// This computes that predicate rather than restating its answer. A function
// classified NO_SCOPE or SCOPE_LATE is *not* thereby a defect — the header
// documents why each current one is inert — but a function that *changes*
// class, or a new one that arrives in either class, is a review item, and that
// is exactly what the frozen map makes impossible to miss.
const USER_JS = /\.Get\(|\.Call\(|\.Has\(|GetPropertyNames\(|NapiToCoreInstance\(|CoreToNapi\(|LuaFunctionDataFrom\(|TableRefDataFrom\(|DefineHiddenProp\(|SymbolIteratorKey\(/;
const CALL_SCOPE = /CallScope\s+[A-Za-z_]/;

export function callScopeClassification() {
  const out = {};
  for (const fn of topLevelFunctions(readSource(BINDING))) {
    const lines = fn.body.split('\n');
    let firstJs = -1;
    let firstScope = -1;
    for (let i = 0; i < lines.length; i++) {
      if (firstJs < 0 && USER_JS.test(lines[i])) firstJs = i;
      if (firstScope < 0 && CALL_SCOPE.test(lines[i])) firstScope = i;
      if (firstJs >= 0 && firstScope >= 0) break;
    }
    if (firstJs < 0 && firstScope < 0) continue;
    if (firstJs < 0) out[fn.name] = 'SCOPE_NO_USER_JS';
    else if (firstScope < 0) out[fn.name] = 'NO_SCOPE';
    else if (firstScope < firstJs) out[fn.name] = 'SCOPE_FIRST';
    else out[fn.name] = 'SCOPE_LATE';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. The lua_next traversal sites
// ---------------------------------------------------------------------------
//
// CR-14 F5 / CR-15 F2: an allocation inside a live `lua_next` cursor can drive a
// GC step whose `__gc` finalizer re-enters the host and adds a key to the table
// under traversal, which Lua's manual makes undefined. The mitigation is to
// collect the traversal into a Lua array first and convert afterwards.
//
// The header's list of which loops do that was written from memory and was
// missing sites. This derives the site list from the source and records, for
// each, whether the loop body contains a call that can allocate.
//
// The exposing calls are the ones that can allocate a *new* Lua object, intern
// a string, or run a metamethod — the three things that can drive a GC step
// while the cursor is live. Raw writes into a different table (`lua_rawseti`
// into the snapshot array) are deliberately not on the list: that is precisely
// what the collect-first mitigation does, so counting it would classify the
// mitigation as the hazard.
const EXPOSING_CALL =
  /\b(lua_pcall|lua_call|lua_callk|luaL_ref|lua_setfield|lua_settable|lua_setglobal|lua_seti|lua_getfield|lua_gettable|lua_geti|lua_pushstring|lua_pushlstring|lua_pushfstring|lua_tostring|lua_tolstring|luaL_tolstring|lua_concat|lua_newtable|lua_createtable|ToLuaValue|ToLuaValueProtected|PushLuaValue|PushLuaValueProtected)\b/g;

export function luaNextSites() {
  const out = {};
  for (const fn of topLevelFunctions(readSource(CORE))) {
    const lines = fn.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/\blua_next\s*\(/.test(lines[i])) continue;
      // Brace-match the loop body starting at this line.
      let depth = 0;
      let started = false;
      let end = i;
      for (let k = i; k < lines.length; k++) {
        for (const ch of lines[k]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') {
            depth--;
            if (started && depth === 0) { end = k; break; }
          }
        }
        if (started && depth === 0) { end = k; break; }
      }
      const bodyText = lines.slice(i, end + 1).join('\n');
      const hits = [...new Set(bodyText.match(EXPOSING_CALL) ?? [])].sort();
      // Record which calls expose it, not just that it is exposed: a loop that
      // grows a new exposing call is a review item even if it was exposed
      // already.
      out[fn.name] = hits.length ? `EXPOSED: ${hits.join(' ')}` : 'NOT_EXPOSED';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. The occupancy policy sites
// ---------------------------------------------------------------------------
//
// CR-16 F4 made the *shape* of a policy generative. This makes the *set of
// operations declaring one* generative: which named operation asks for which
// policy. The exception-escape and injection matrices both need this set, and
// until now each carried its own copy that agreed with the source by luck.
export function occupancyPolicySites() {
  const src = stripComments(readSource(BINDING));
  const out = {};
  const re = /RejectIfOccupied\(\s*(nullptr|"[^"]*")\s*,\s*lua_occupancy::(k[A-Za-z]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const op = m[1] === 'nullptr' ? '<kSyncApi default>' : m[1].slice(1, -1);
    out[op] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Counts that comments used to state as numbers
// ---------------------------------------------------------------------------
//
// Every entry is a grep whose result was, at some point, written into a comment
// as a literal and then went stale. The number lives here, where a test reads
// it, instead of in prose where only a reader can.
export function greppableCounts() {
  const binding = stripCommentsAndStrings(readSource(BINDING));
  const core = stripCommentsAndStrings(readSource(CORE));
  const count = (text, re) => (text.match(re) || []).length;
  return {
    // The kSyncApi policy's call sites. Written as 33 in four places; was 31.
    'RejectIfBusy() call sites': count(binding, /if \(RejectIfBusy\(\)\)/g),
    // CR-12 F2's "single place that pushes the host-function closure" claim.
    'LuaCallHostFunction closure pushes': count(core, /lua_pushcclosure\([^;]*LuaCallHostFunction/g),
    // The tagged-External kinds the static_assert on tag distinctness covers.
    'napi_type_tag definitions': count(readSource(join(ROOT, 'src/lua-native.h')).replace(/\/\/[^\n]*/g, ''), /constexpr napi_type_tag/g),
  };
}

// ---------------------------------------------------------------------------
// 5. The exception-escape surface (CR-18)
// ---------------------------------------------------------------------------
//
// CR-18's axes were derived from these greps rather than from a recollection of
// which sites matter. Freezing them means a new unguarded core call, or a
// `RunProtected`-backed core method that grows a new binding caller, changes a
// number here and has to be looked at — which is the check CR-6 F1 asked for
// ("every RunProtected-backed core call reachable from N-API must be inside a
// try/catch, and any new one added later is a review checklist item") and never
// got.
export function exceptionSurface() {
  const binding = stripCommentsAndStrings(readSource(BINDING));
  const core = stripCommentsAndStrings(readSource(CORE));
  const count = (text, re) => (text.match(re) || []).length;
  return {
    'throw sites (binding)': count(binding, /\bthrow\b/g),
    'throw sites (core)': count(core, /\bthrow\b/g),
    'catch sites (binding)': count(binding, /\bcatch\s*\(/g),
    'catch sites (core)': count(core, /\bcatch\s*\(/g),
    'RunProtected calls (core)': count(core, /\bRunProtected\(/g),
    'lua_pcall calls (core)': count(core, /\blua_pcall\(/g),
  };
}

// ---------------------------------------------------------------------------
// 6. Every binding method that calls a RunProtected-backed core method must be
//    inside a try/catch (the CR-6 F1 class, mechanized)
// ---------------------------------------------------------------------------
//
// CR-6 F1 was CR-5 F11's class left unswept: `RegisterClass` got a `try`/`catch`
// and its two siblings did not, and a raising `_G.__newindex` turned each of
// them into an unconditional process abort. The recommendation closed with
// "treat the class mechanically". This is that.
//
// It derives the set of throwing core methods from the core source — a public
// `LuaRuntime` method whose body calls `RunProtected` — and then, for every call
// to one of them from the binding layer, reports whether the call site is
// lexically inside a `try` block.
// A core method lets a C++ exception escape to its caller if it calls
// `RunProtected` (which throws by design) outside its own `try`/`catch` — or if
// it *calls another core method that does*.
//
// The transitive half is CR-19 F1. Computing only the direct half missed seven
// methods, `LuaRuntime::GetGlobal` most plainly: it calls `PushProtectedGlobal`
// and `ToLuaValueProtected`, both of which throw, and contains no `RunProtected`
// of its own. A binding call to it was not scored `UNGUARDED`; it produced no
// row at all, which is worse, because a missing row reads as nothing to check.
//
// `CreateCoroutine` is why the guarded half still matters: it is
// RunProtected-backed and cannot throw, because it catches and returns the
// message as a `std::string`.
export function throwingCoreMethods() {
  const fns = topLevelFunctions(readSource(CORE)).filter((f) => f.name.startsWith('LuaRuntime::'));
  const shortName = (f) => f.name.slice('LuaRuntime::'.length);
  const guards = new Map(fns.map((f) => [f.name, tryGuardMap(f)]));

  // Seed: an unguarded `RunProtected(` or an unguarded bare `throw`.
  const throwing = new Set();
  for (const f of fns) {
    const g = guards.get(f.name);
    for (const at of allMatches(f.body, /\bRunProtected\(|\bthrow\b/g)) {
      if (!g[at]) { throwing.add(shortName(f)); break; }
    }
  }

  // Closure: an unguarded call to a sibling that throws.
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fns) {
      if (throwing.has(shortName(f))) continue;
      const g = guards.get(f.name);
      for (const callee of throwing) {
        const re = new RegExp(`\\b${callee}\\s*\\(`, 'g');
        let hit = false;
        for (const at of allMatches(f.body, re)) {
          // Skip a qualified name (`Other::Callee`) — not this method.
          if (at > 0 && /[A-Za-z0-9_:]/.test(f.body[at - 1])) continue;
          if (!g[at]) { hit = true; break; }
        }
        if (hit) { throwing.add(shortName(f)); changed = true; break; }
      }
    }
  }
  return [...throwing].sort();
}

// Whether a C++ exception can escape each binding function to *its* caller, and
// therefore whether it can reach N-API from a function nobody calls.
//
// The second half of CR-19 F1. Asking "is this call site inside a try" of one
// function body at a time gets the print-handler chain wrong:
//
//     SetPrintHandler        try { … InstallPrintHandler(fn) … } catch (…)
//       InstallPrintHandler    runtime->SetOutputHandler(lambda)   <- no try
//
// The call is unguarded where it is written and guarded where it matters, one
// frame up. So the question is asked of a *path*: a function escapes if it has
// an unguarded call to a throwing core method, or an unguarded call to another
// binding function that escapes. What matters is the fixpoint at the roots —
// the functions nothing else calls, which are what N-API invokes.
export function coreCallGuarding() {
  const throwing = throwingCoreMethods();
  if (throwing.length === 0) throw new Error('no throwing core methods found — the scan is broken');
  const coreCall = new RegExp(`(?:runtime|runtime_|rt)(?:->|\\.)(${throwing.join('|')})\\s*\\(`, 'g');

  const fns = topLevelFunctions(readSource(BINDING));
  const guards = new Map(fns.map((f) => [f.name, tryGuardMap(f)]));
  const bare = (n) => (n.includes('::') ? n.slice(n.lastIndexOf('::') + 2) : n);

  // Direct, unguarded calls into a throwing core method.
  const localUnguarded = new Map();   // fn name -> [callee]
  const rows = {};
  for (const f of fns) {
    const g = guards.get(f.name);
    coreCall.lastIndex = 0;
    let m;
    while ((m = coreCall.exec(f.body)) !== null) {
      const key = `${f.name} -> ${m[1]}`;
      const guarded = !!g[m.index];
      if (rows[key] !== 'UNGUARDED') rows[key] = guarded ? 'GUARDED' : 'UNGUARDED';
      if (!guarded) {
        if (!localUnguarded.has(f.name)) localUnguarded.set(f.name, []);
        localUnguarded.get(f.name).push(m[1]);
      }
    }
  }

  // Unguarded calls from one binding function to another.
  const callers = new Map();          // callee fn name -> [{caller, guarded}]
  const called = new Set();
  for (const f of fns) {
    const g = guards.get(f.name);
    for (const other of fns) {
      if (other.name === f.name) continue;
      const re = new RegExp(`\\b${bare(other.name)}\\s*\\(`, 'g');
      for (const at of allMatches(f.body, re)) {
        if (at > 0 && /[A-Za-z0-9_]/.test(f.body[at - 1])) continue;
        called.add(other.name);
        if (!callers.has(other.name)) callers.set(other.name, []);
        callers.get(other.name).push({ caller: f.name, guarded: !!g[at] });
      }
    }
  }

  // Fixpoint: escapes(f) = local unguarded core call, or an unguarded call to
  // some g with escapes(g).
  const escapes = new Set(localUnguarded.keys());
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fns) {
      if (escapes.has(f.name)) continue;
      const g = guards.get(f.name);
      for (const other of fns) {
        if (!escapes.has(other.name)) continue;
        const re = new RegExp(`\\b${bare(other.name)}\\s*\\(`, 'g');
        let hit = false;
        for (const at of allMatches(f.body, re)) {
          if (at > 0 && /[A-Za-z0-9_]/.test(f.body[at - 1])) continue;
          if (!g[at]) { hit = true; break; }
        }
        if (hit) { escapes.add(f.name); changed = true; break; }
      }
    }
  }

  // Report each locally-unguarded function by what actually happens to it.
  for (const [fn, callees] of localUnguarded) {
    const cs = callers.get(fn) ?? [];
    const key = `${fn} -> ${[...new Set(callees)].sort().join('+')}`;
    delete rows[`${fn} -> ${callees[0]}`];
    if (cs.length === 0) {
      // Nothing calls it: N-API does, so an escape here reaches the process.
      rows[key] = 'ESCAPES_AT_ROOT';
    } else if (cs.every((c) => c.guarded)) {
      rows[key] = `CONTAINED_BY_CALLERS(${cs.length})`;
    } else {
      rows[key] = 'UNGUARDED_AND_PROPAGATES';
    }
    if (JUSTIFIED_ESCAPES[key]) {
      rows[key] = rows[key] === 'GUARDED' || String(rows[key]).startsWith('CONTAINED')
        ? `STALE_JUSTIFICATION(${rows[key]})`   // it is contained now; drop the entry
        : 'JUSTIFIED_FALSE_POSITIVE';
    }
  }
  return rows;
}

// Escape rows that are false positives of the analysis, with the reason.
//
// The closure is argument-insensitive, and CR-19 predicted this exact cost:
// "an over-approximating check that is fed to a reader as a list of defects is
// its own failure mode." So the over-approximations are named here rather than
// left for a reader to re-derive every time — and, as with the other ledgers in
// this repo, an entry that stops applying is reported instead of being silently
// ignored.
export const JUSTIFIED_ESCAPES = {
  'LuaContext::DetachRuntimeHandlers -> SetOutputHandler':
    'Passes `nullptr`, and `SetOutputHandler(nullptr)` takes the `else` branch — '
    + '`output_handler_.reset()` — which never reaches `InstallOutputRedirection` '
    + 'and so cannot throw. The analysis cannot see argument values. Verified by '
    + 'reading both branches at CR-19; the throwing branch is the `if (handler)` '
    + 'one only.',
};

// Kept as a named export for the review docs that cite it.
export const unguardedCoreCalls = coreCallGuarding;

function allMatches(text, re) {
  const at = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) at.push(m.index);
  return at;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. The scanner's own coverage
// ---------------------------------------------------------------------------
//
// Every invariant above stands on `topLevelFunctions`, and CR-19 F2 was that
// scanner silently dropping a function: a bodyless macro at column 0 had no
// brace of its own, so the scan adopted the next function's and swallowed it.
// The result was a checked-in classification with a bogus row and a missing
// member, and nothing noticed, because a scanner that drops input reports clean
// over a smaller universe than anyone believes it covers.
//
// So the scanner now has to account for its own input: every column-0 line that
// looks like a definition is either attributed to a function or explicitly
// classified as a declaration or a macro invocation. `UNATTRIBUTED` is a
// scanner bug and turns the suite red.
export function scannerCoverage() {
  const out = {};
  for (const [label, path] of [['binding', BINDING], ['core', CORE]]) {
    const src = readSource(path);
    out[`${label}: functions found`] = topLevelFunctions(src).length;
    const un = unattributedDefinitions(src);
    // Keyed by the line's *text*, not its line number: a line number changes
    // whenever anything above it does, so keying on it would make this drift on
    // every unrelated edit — and an invariant that cries wolf is one that gets
    // re-frozen without being read, which is the failure it exists to prevent.
    for (const u of un) out[`${label}: ${u.text}`] = u.reason;
    out[`${label}: unattributed`] = un.filter((u) => u.reason === 'UNATTRIBUTED').length;
  }
  return out;
}

export const INVARIANTS = [
  {
    id: 'callscope-classification',
    title: 'CallScope placement, per function that can run user JS',
    compute: callScopeClassification,
    note: 'See the CallScope comment in src/lua-native.h. A class change is a review item, not automatically a defect.',
  },
  {
    id: 'lua-next-sites',
    title: 'lua_next traversals, and whether they allocate inside the cursor',
    compute: luaNextSites,
    note: 'ALLOCATES_INSIDE_CURSOR is the CR-14 F5 exposure. See the IsExecuting comment in src/core/lua-runtime.h.',
  },
  {
    id: 'occupancy-policy-sites',
    title: 'Which operation declares which lua_occupancy policy',
    compute: occupancyPolicySites,
    note: 'The kExclusive rows are what an occupancy matrix must cover.',
  },
  {
    id: 'greppable-counts',
    title: 'Counts that were previously written into comments as literals',
    compute: greppableCounts,
  },
  {
    id: 'exception-surface',
    title: 'Throw / catch / protected-barrier counts (CR-18 axes)',
    compute: exceptionSurface,
  },
  {
    id: 'scanner-coverage',
    title: "The C++ scanner accounts for every definition-shaped line it saw",
    compute: scannerCoverage,
    note: 'An UNATTRIBUTED line is a scanner bug: the invariants above would be silently ranging over a smaller universe than they claim (CR-19 F2).',
  },
  {
    id: 'core-call-guarding',
    title: 'Binding calls that can let a C++ exception reach N-API',
    compute: coreCallGuarding,
    note: 'The CR-6 F1 class. ESCAPES_AT_ROOT or UNGUARDED_AND_PROPAGATES is a process-abort candidate and must be justified.',
  },
];

export const EXPECTED_PATH = join(ROOT, 'tools/invariants/expected.json');

export function computeAll() {
  const out = {};
  for (const inv of INVARIANTS) out[inv.id] = inv.compute();
  return out;
}

export function readExpected() {
  return JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));
}

// Returns [] when `actual` matches `expected`, else a list of human-readable
// drift lines.
export function diffInvariant(actual, expected) {
  const drift = [];
  const aKeys = Object.keys(actual);
  const eKeys = Object.keys(expected ?? {});
  for (const k of aKeys) {
    if (!(k in (expected ?? {}))) drift.push(`+ ${k}: ${JSON.stringify(actual[k])}   (new)`);
    else if (JSON.stringify(actual[k]) !== JSON.stringify(expected[k])) {
      drift.push(`~ ${k}: ${JSON.stringify(expected[k])} -> ${JSON.stringify(actual[k])}`);
    }
  }
  for (const k of eKeys) {
    if (!(k in actual)) drift.push(`- ${k}: ${JSON.stringify(expected[k])}   (gone)`);
  }
  return drift.sort();
}

void readdirSync;
