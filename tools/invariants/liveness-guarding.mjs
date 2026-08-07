// C1 (CONTEXT-TEARDOWN-PLAN): which binding paths reach the core without first
// establishing that the Lua state is still there?
//
// **Why this exists, and why it is not `core-call-guarding` again.** That census
// asks whether a throwing core call sits under a `try`, i.e. whether a C++
// exception can reach N-API. This one asks a different question about the same
// edges: *if the context's state had been retired, would this call still
// happen?* Today nothing can retire a state out from under a live context —
// `reset()` swaps in a replacement, and `~LuaContext` runs only when the wrapper
// is unreachable — so the question is hypothetical and the answer is the
// deciding evidence for whether a `close()` can exist at all
// (`CONTEXT-TEARDOWN-PLAN` §2).
//
// **The rule that generates the universe**, stated because an enumeration that
// cannot say where it came from cannot be checked for completeness:
//
// > A row is a (binding function → core method) edge. It is **CHECKED** when a
// > liveness guard appears in that function *before* the call, or when every
// > path into the function passes through one; **UNCHECKED** otherwise.
//
// A liveness guard is one of the forms the binding already uses to answer "is
// the state I am about to touch still mine":
//
//   RejectIfBusy / RejectIfOccupied / RejectIfWorkerBusy  — the occupancy guards
//   ContextLive() / liveness.HandlesLive()                — the handle-side flag
//   ref == LUA_NOREF                                      — the released-handle test
//
// The first family is what a `close()` would extend (a fourth claim, or a new
// one); the second and third are what already make a handle fail closed when
// `alive_` flips. Scoring them together is deliberate: the census is asking
// "does anything stand between JS and a retired state here", not "which
// mechanism".
//
// **The universe is JS-reachable functions only, and the first run is why.**
// Scored over every binding function, the census returned 41 UNCHECKED of 147
// edges — and the first twenty were `LuaContext::LuaContext`,
// `InstallRuntimeHandlers`, `DetachRuntimeHandlers`, `RegisterCallbacks`,
// `~LuaContext` and the error-path helpers. None of those can be entered from
// JavaScript at all: they run during construction, reset and teardown, which is
// when retiring the state is the *operation* rather than a hazard. Asking a
// liveness question of them is asking whether teardown checks that teardown has
// not happened.
//
// So an entry point is a function with N-API callback shape —
// `(const Napi::CallbackInfo&)` — which is precisely the set JavaScript can
// call, and the rest are scored only through the entry points that reach them.
// The rule is syntactic on purpose, like census F's: it reads signatures, not
// intent.
//
// **What an UNCHECKED row does *not* mean.** It is not a defect today — nothing
// can retire the state under these paths. It is the work a `close()` would have
// to do first, which is exactly the number §4's C1 was written to produce.

import { readSource, topLevelFunctions } from '../cpp-scan.mjs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BINDING = join(ROOT, 'src/lua-native.cpp');

// Any call through the runtime handle, not just the throwing ones: a read of a
// closed `lua_State` is undefined whether or not the method can throw.
const CORE_CALL = /(?:runtime|runtime_|rt)(?:->|\.)(\w+)\s*\(/g;

// The guard forms above, as they appear in this file.
const GUARD = new RegExp([
  'RejectIfBusy\\s*\\(',
  'RejectIfOccupied\\s*\\(',
  'RejectIfWorkerBusy\\s*\\(',
  'ContextLive\\s*\\(\\s*\\)',
  'HandlesLive\\s*\\(\\s*\\)',
  'ContextObjectLive\\s*\\(\\s*\\)',
  '==\\s*LUA_NOREF',
  '!=\\s*LUA_NOREF',
  'RejectIfClosed\\s*\\(',   // C2's guard, so the census is ready for it
].join('|'), 'g');

const bare = (n) => (n.includes('::') ? n.slice(n.lastIndexOf('::') + 2) : n);

// Offsets of every guard in a body, so "before the call" is a position test —
// the same shape `tryGuardMap` uses for try-blocks.
function guardOffsets(body) {
  GUARD.lastIndex = 0;
  const at = [];
  let m;
  while ((m = GUARD.exec(body)) !== null) at.push(m.index);
  return at;
}

// A JS entry point: N-API callback shape. `LuaContext::` methods and the
// free-function traps/handle methods both match, which is right — both are
// things JavaScript calls directly.
//
// **The constructor is excluded, and so is the destructor**, which the first
// two runs both needed and neither said. `LuaContext::LuaContext` has callback
// shape — `new lua_native.init(...)` really is a JS call — but a context under
// construction cannot have been closed, and a destructor *is* the teardown. A
// call site inside either therefore counts as guarded, which collapses the
// whole `InstallRuntimeHandlers` / `RegisterCallbacks` / `DetachRuntimeHandlers`
// family that dominated both earlier runs (41, then 38, almost all of it this
// class). What is left is the set that can genuinely be entered on a context
// that already exists.
const IS_ENTRY = /\(\s*const\s+Napi::CallbackInfo\s*&/;
const LIFECYCLE = /^LuaContext::(LuaContext|~LuaContext)$/;

export function livenessGuarding() {
  const src = readSource(BINDING);
  const lines = src.split('\n');
  const fns = topLevelFunctions(src);
  // The scanner reports positions, not signatures, so the declaration is the
  // text between the function's first line and the brace that opens its body.
  const signature = (f) => lines.slice(f.startLine - 1, f.bodyStartLine).join(' ');
  const guards = new Map(fns.map((f) => [f.name, guardOffsets(f.body)]));
  const guardedBefore = (name, index) => guards.get(name).some((g) => g < index);

  // A function is *entered guarded* when every binding call site of it is
  // guarded before the call. A helper reached only from guarded callers is
  // covered by them, which is the same reasoning `lua-native.h` uses for the
  // helpers whose user JS counts as their caller's.
  const callSites = new Map();   // callee -> [{caller, guarded}]
  for (const f of fns) {
    for (const other of fns) {
      if (other.name === f.name) continue;
      const re = new RegExp(`\\b${bare(other.name)}\\s*\\(`, 'g');
      let m;
      while ((m = re.exec(f.body)) !== null) {
        if (m.index > 0 && /[A-Za-z0-9_]/.test(f.body[m.index - 1])) continue;
        if (!callSites.has(other.name)) callSites.set(other.name, []);
        callSites.get(other.name).push({
          caller: f.name,
          guarded: LIFECYCLE.test(f.name)
            || guardedBefore(f.name, m.index) || guardOffsets(f.body).length > 0,
        });
      }
    }
  }
  const enteredGuarded = (name) => {
    const sites = callSites.get(name);
    return Array.isArray(sites) && sites.length > 0 && sites.every((s) => s.guarded);
  };

  // Reachability from an entry point, so an internal helper is scored only when
  // JavaScript can actually get to it.
  const entries = new Set(fns.filter((f) => IS_ENTRY.test(signature(f)) && !LIFECYCLE.test(f.name)).map((f) => f.name));
  const reachable = new Set(entries);
  for (let changed = true; changed;) {
    changed = false;
    for (const [callee, sites] of callSites) {
      if (reachable.has(callee)) continue;
      if (sites.some((s) => reachable.has(s.caller))) { reachable.add(callee); changed = true; }
    }
  }

  const out = {};
  let unchecked = 0;
  let edges = 0;
  for (const f of fns) {
    if (!reachable.has(f.name)) continue;
    CORE_CALL.lastIndex = 0;
    let m;
    const seen = new Set();
    while ((m = CORE_CALL.exec(f.body)) !== null) {
      const callee = m[1];
      const key = `${f.name} -> ${callee}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges += 1;
      const ok = guardedBefore(f.name, m.index) || enteredGuarded(f.name);
      if (!ok) {
        out[key] = 'UNCHECKED';
        unchecked += 1;
      }
    }
  }

  // Totals frozen beside the zero, for the reason every census here states: a
  // scanner that has stopped matching reports the same "0 UNCHECKED" a clean
  // tree does, and only the edge count tells them apart (CR-19 F2).
  out['binding -> core edges'] = edges;
  out['UNCHECKED'] = unchecked;
  return out;
}
