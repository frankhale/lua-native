// The source invariants, asked of the second binding.
//
// Until November 25, 2026 every invariant in `invariants.mjs` that reads a
// binding read `src/lua-native.cpp` by path, and the WASM target shipped a
// second one (`src/wasm/`) that none of them saw. `docs/reviews/WASM-TARGET-PLAN.md`
// Phase 5 asked for a ruling on each: extend it with its own frozen answers,
// or write down why it does not apply. The rulings:
//
//   callscope-classification   EXTENDED   wasm:callscope-classification
//   occupancy-policy-sites     EXTENDED   wasm:occupancy-policy-sites, and
//                                         required equal to the native set
//   exception-surface          EXTENDED   wasm:exception-surface
//   core-call-guarding         EXTENDED   wasm:core-call-guarding
//   scanner-coverage           EXTENDED   wasm:scanner-coverage
//   liveness-guarding          EXTENDED   wasm:liveness-guarding
//   objectwrap-branding        COUNTERPART wasm:brand-rule. There is no
//                                         ObjectWrap and no type tag here; the
//                                         rule they implement is asked of what
//                                         stands in for them.
//   greppable-counts           SPLIT      three counts, three answers: the
//                                         RejectIfBusy count is a row of
//                                         wasm:exception-surface; the
//                                         closure-push count is the core's;
//                                         the type-tag count is N-API's, and
//                                         what it stands for is brand-rule's
//   lua-next-sites             CORE       reads `src/core/` only, which both
//                                         targets compile unchanged
//   assertion-strength         SUITE      reads the specs, which run on both
//   perf-claims                DOCS       reads the documentation
//   surface-census             BY PARITY  its universes are derived from the
//                                         public types and the native binding
//                                         and scored against harnesses that
//                                         run on either target. They hold for
//                                         this binding exactly as far as its
//                                         surface is the native one, and
//                                         `binding-parity` below is that
//                                         requirement, computed. Census F (who
//                                         retains a JS value) is the one part
//                                         with no counterpart here; see
//                                         RETENTION below.
//
// **The analyses are shared, not copied.** Each EXTENDED row calls the native
// invariant's own function with this binding's file and its spelling of the
// same things, so a fix to the analysis reaches both and the two cannot drift
// apart as code. Only the answers are separate, and they are frozen under
// their own ids so that nothing here can move a native answer.
//
// **Why the port makes this cheap.** The WASM binding is a port that kept the
// native names — `CallScope`, `RejectIfBusy`, `RejectIfOccupied`, the same
// `try` shapes — so the native predicates apply to it nearly as written.
// `binding-parity` freezes how near: the functions that exist in one binding
// and not the other are listed by name.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource, topLevelFunctions, stripCommentsAndStrings, stripComments } from '../cpp-scan.mjs';
import {
  callScopeClassification, occupancyPolicySites, coreCallGuarding, scannerCoverage,
} from './invariants.mjs';
import { livenessGuarding } from './liveness-guarding.mjs';
import { stripTsComments, interfaceBody, optionKeys, methodSignatures } from './surface-census.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const NATIVE = join(ROOT, 'src/lua-native.cpp');
const WASM = join(ROOT, 'src/wasm/lua-wasm.cpp');
const JS_LAYER = join(ROOT, 'src/wasm/js.cpp');
const SHELL = join(ROOT, 'src/wasm/shell.js');
const TYPES = join(ROOT, 'types.d.ts');

// ---------------------------------------------------------------------------
// The extended invariants
// ---------------------------------------------------------------------------

// "Can run user JS", as this binding spells it. The native predicate names
// `.Get(` / `.Call(` / `.Has(` / `GetPropertyNames(`; here every such
// operation is a function in `js::` (js.h), which is the point of that layer.
// The conversion and marker helpers kept their native names, and so did the
// helpers split out of the entry points.
const SPLIT_HELPERS = [
  'ParseInitOptions', 'ApplyStateOptions', 'SubscribeSharedTables',
  'ReadUserdataProperty', 'WriteUserdataProperty', 'ReadUserdataOptions',
  'ReadClassExtends', 'ReadClassMetamethods', 'ReadClassStatics',
  'ReadClassProperties', 'ReadClassMethods', 'BuildClassStatics',
  'ReadEnvironmentOptions', 'ResolveAsyncCallTarget', 'AttachToAwaitedPromise',
  'ReleaseObjectHandle', 'ObjectToCore',
  'ArrayToNapi', 'TableToNapi', 'FunctionRefToNapi', 'TableRefToNapi',
];
const USER_JS = new RegExp(
  'js::Get\\(|js::GetIndex\\(|js::Call\\(|js::CallWithThis\\(|js::Has\\(|js::Keys\\(|'
  + 'NapiToCoreInstance\\(|CoreToNapi\\(|LuaFunctionDataFrom\\(|TableRefDataFrom\\(|js::DefineHidden\\(|'
  + SPLIT_HELPERS.map((n) => `\\b${n}\\(`).join('|'));

// Both call-graph analyses find a call to a binding function by its bare name.
// This binding has `js::Call`, `js::Construct` and `js::Get` beside
// `LuaContext::Call` and `LuaContext::Construct`, so a bare-name match on
// `js::Construct(` drew an edge to the context's constructor from every
// function that builds a JS object — and two construction-only helpers were
// scored as reachable from JavaScript on that edge alone. A match preceded by
// `js::` is the JS layer's function, not the binding's.
const JS_LAYER_CALL = /\bjs::$/;

export function wasmCallScope() {
  return callScopeClassification({ path: WASM, userJs: USER_JS });
}

export function wasmOccupancy() {
  const mine = occupancyPolicySites(WASM);
  const native = occupancyPolicySites(NATIVE);
  // The policy an operation declares is behaviour a caller can observe, so
  // here the two bindings are not merely each frozen: they must agree.
  const same = JSON.stringify(Object.entries(mine).sort()) === JSON.stringify(Object.entries(native).sort());
  return { ...mine, 'the same operations and policies as the native binding': same ? 'yes' : 'NO' };
}

export function wasmExceptionSurface() {
  const binding = stripCommentsAndStrings(readSource(WASM));
  const layer = stripCommentsAndStrings(readSource(JS_LAYER));
  const count = (text, re) => (text.match(re) || []).length;
  return {
    'throw sites (wasm binding)': count(binding, /\bthrow\b/g),
    'catch sites (wasm binding)': count(binding, /\bcatch\s*\(/g),
    'throw sites (wasm js layer)': count(layer, /\bthrow\b/g),
    'catch sites (wasm js layer)': count(layer, /\bcatch\s*\(/g),
    // greppable-counts' first row, for this binding.
    'RejectIfBusy() call sites (wasm binding)': count(binding, /if \(RejectIfBusy\(\)\)/g),
  };
}

// Escape rows that are false positives of the analysis, with the reason. The
// same rule as `JUSTIFIED_ESCAPES`: an entry that stops applying is reported.
export const WASM_JUSTIFIED_ESCAPES = {
  'LuaContext::DetachRuntimeHandlers -> SetOutputHandler':
    'The native entry of the same name, for the same code: it passes `nullptr`, '
    + 'and `SetOutputHandler(nullptr)` takes the branch that only resets a '
    + '`shared_ptr` and cannot throw. Read on November 25, 2026: this binding\'s '
    + '`DetachRuntimeHandlers` is the native one line for line, and uses '
    + '`DropInputHandler` / `DropFileReader` for the two handlers whose null '
    + 'branch *can* throw.',
};

export function wasmCoreCallGuarding() {
  return coreCallGuarding({ path: WASM, justified: WASM_JUSTIFIED_ESCAPES, foreign: JS_LAYER_CALL });
}

export function wasmScannerCoverage() {
  return scannerCoverage([['wasm binding', WASM], ['wasm js layer', JS_LAYER]]);
}

// An entry point here takes `(const Args&)` where a native one takes
// `(const Napi::CallbackInfo&)`. Construction is two functions, `Create` and
// `Construct`, where natively it is the constructor; both are lifecycle for
// the reason the native constructor is.
export function wasmLiveness() {
  return livenessGuarding({
    path: WASM,
    isEntry: /\(\s*const\s+Args\s*&/,
    lifecycle: /^LuaContext::(LuaContext|~LuaContext|Create|Construct)$/,
    foreign: JS_LAYER_CALL,
  });
}

// ---------------------------------------------------------------------------
// The brand rule, where there is no ObjectWrap and no type tag
// ---------------------------------------------------------------------------
//
// `objectwrap-branding` checks one rule in N-API's terms: *provenance is not
// kind*. A value JavaScript hands in is whatever it claims to be only if the
// binding can tell, by something JavaScript cannot forge, and `napi_unwrap`
// cannot tell (CR-20 F5: a `LuaContext*` accepted as a `SharedTable*`).
//
// This binding has the same rule and none of the same machinery, so the check
// is a counterpart and not a copy. There are three places a JS-supplied value
// becomes something the C++ trusts:
//
//   1. **An owner becomes a struct pointer.** A handle's hidden marker holds
//      an *owner*; C++ asks the shell for the struct behind it and casts the
//      answer to a pointer. The type tag is which `WeakMap` the owner is a key
//      of — one map per kind. So every cast of a JS value to a raw pointer
//      must follow, in the same function, a `Host().call` to a shell method
//      that answers from exactly one kind map.
//   2. **A receiver becomes a context or a shared table.** N-API's
//      `DefineClass` refuses a foreign receiver before any method runs. Here a
//      method is a JavaScript function and has to refuse for itself, with a
//      private-field check, before it touches private state.
//   3. **An argument becomes a shared table.** `AsSharedTable`'s counterpart:
//      the private field again, never `instanceof`.
//
// Each is derived from the source. Zero sites is what a broken scan reports
// too, so the counts are frozen beside the verdicts.
export function wasmBrandRule() {
  const out = {};
  const cpp = readSource(WASM);
  const shell = readFileSync(SHELL, 'utf8');

  // The shell's lookups: `name(owner) { return taggedData(<map>, owner); }`.
  const lookups = new Map();
  for (const m of shell.matchAll(/^ {2}(\w+)\(owner\) \{\s*return taggedData\((\w+), owner\);\s*\}/gm)) {
    lookups.set(m[1], m[2]);
  }
  // The kind maps, and that no two lookups answer from the same one — the
  // counterpart of the static_assert on tag distinctness.
  const maps = [...lookups.values()];
  out['kind maps answered from'] = [...lookups].map(([name, map]) => `${name}: ${map}`).sort().join(', ');
  out['each lookup has a kind map of its own'] = new Set(maps).size === maps.length && maps.length > 0 ? 'yes' : 'NO';
  for (const map of new Set(maps)) {
    out[`kind map ${map} is a WeakMap`] = new RegExp(`const ${map} = new WeakMap\\(\\)`).test(shell) ? 'yes' : 'NO';
  }

  // 1. Every inbound raw pointer.
  let casts = 0;
  for (const fn of topLevelFunctions(cpp)) {
    const body = stripComments(fn.rawBody);
    for (const m of body.matchAll(/\.as<\s*(\w+)\s*\*\s*>\s*\(\s*emscripten::allow_raw_pointers\(\)\s*\)/g)) {
      casts += 1;
      const before = body.slice(0, m.index);
      const asked = [...before.matchAll(/js::Host\(\)\.call<val>\(\s*"(\w+)"/g)].pop();
      const map = asked ? lookups.get(asked[1]) : undefined;
      out[`pointer: ${m[1]}* from JavaScript in ${fn.name}`] = map ? `KIND-CHECKED (${asked[1]}: ${map})` : 'UNGUARDED';
    }
  }
  out['inbound pointer casts found'] = casts;

  // 2. Receivers. The context's methods are generated from one template.
  const template = /for \(const name of CONTEXT_METHODS\) \{[\s\S]*?\n {4}\}/.exec(shell)?.[0] ?? '';
  const checkAt = template.search(/!\(#core in this\)/);
  const useAt = template.search(/this\.#(core|state)/);
  out['LuaContext methods: the template refuses a foreign receiver first'] =
    checkAt >= 0 && useAt >= 0 && checkAt < useAt && /throw makeError\(TypeError, 'Illegal invocation', method\)/.test(template) ? 'yes' : 'NO';

  const sharedBody = classBody(shell, 'SharedTableImpl');
  out['SharedTable: the receiver check is a private-field test'] =
    /static #check\(receiver, door\) \{[\s\S]*?!\(#value in receiver\)[\s\S]*?Illegal invocation/.test(sharedBody) ? 'yes' : 'NO';
  let methods = 0;
  for (const m of sharedBody.matchAll(SHARED_METHOD)) {
    methods += 1;
    const check = m[3].search(/SharedTableImpl\.#check\(this, door\)/);
    const use = m[3].search(/this\.#/);
    out[`SharedTable.${m[1]}: checks its receiver before private state`] = check >= 0 && (use < 0 || check < use) ? 'yes' : 'NO';
  }
  out['SharedTable public methods found'] = methods;

  // 3. Arguments.
  out['a shared table argument is recognised by private field'] =
    /isSharedTable = \(value\) => typeof value === 'object' && value !== null && #value in value;/.test(shell) ? 'yes' : 'NO';
  out['IsSharedTable (C++) asks the shell'] =
    /js::Host\(\)\.call<bool>\("isSharedTable", value\)/.test(
      topLevelFunctions(cpp).find((f) => f.name === 'IsSharedTable')?.rawBody ?? '') ? 'yes' : 'NO';
  out['instanceof used to recognise a handle or a shared table'] =
    (stripJsComments(shell).match(/instanceof (LuaContext|SharedTable)\w*/g) ?? []).length;
  return out;
}

// A public method of `SharedTableImpl`. They are written as members of one
// object literal inside the class's static block (so that they can be given
// N-API's property order), which puts each at six spaces. Each is a function
// expression named `door`, which is how it names itself to `makeError`.
const SHARED_METHOD = /^ {6}([a-z]\w*): function door\(([^)]*)\) \{([\s\S]*?)\n {6}\}/gm;

function classBody(src, name) {
  const at = src.indexOf(`class ${name} {`);
  if (at < 0) return '';
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return '';
}

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// The parity census
// ---------------------------------------------------------------------------
//
// D1's permanent cost is two bindings, and the way two bindings fail is that a
// door or an option lands in one. This derives the public surface three times
// — from the contract (`types.d.ts`), from the native binding's registrations
// and from this binding's — and requires them equal. A method added to one
// turns the suite red on its own.
//
// It also freezes, by name, every function that exists in one binding's C++
// and not the other's. That list is not a defect list; most of it is the two
// platforms' plumbing (N-API workers there, the shell's entry counter here).
// It is frozen because a helper added to one binding and not ported shows up
// as a new row, which is the only place such a change is visible at all.

// Why a name is in one binding's list and not the other's.
export const SURFACE_LEDGER = {
  'wasm context method: subscribe_shared':
    'Not public. The second half of construction, called once by the shell after it has made the '
    + 'JS object a context (the plan, "Slice 7 — as built"). It is on the embind class and not on '
    + 'the prototype: `CONTEXT_METHODS` in shell.js is the public list and does not contain it.',
};

// Property keys a binding reads that are not options of the public API: the
// JavaScript built-ins the native binding reaches through `env.Global()`, which
// this binding's shell holds as captured intrinsics instead.
export const KEY_LEDGER = {
  native: {
    Array: 'a global, for `Array.from`', Map: 'a global, for `tableAs: "map"`',
    Object: 'a global, for `Object.defineProperty`', Proxy: 'a global', Symbol: 'a global',
    asyncIterator: '`Symbol.asyncIterator`', iterator: '`Symbol.iterator`',
    defineProperty: '`Object.defineProperty`', from: '`Array.from`',
    init: 'the module export, read back to brand a context',
    set_global: 'the context\'s own public method, called by a shared table',
  },
  wasm: {
    length: 'an array\'s length, read through `js::Get` in one place; natively `Array::Length()`',
  },
};

const sortedKeys = (iterable) => [...new Set(iterable)].sort();

function stringKeysRead(path, re) {
  return sortedKeys([...stripComments(readSource(path)).matchAll(re)].map((m) => m[1]));
}

export function bindingParity() {
  const out = {};
  const types = stripTsComments(readFileSync(TYPES, 'utf8'));
  const native = readSource(NATIVE);
  const wasm = readSource(WASM);
  const shell = readFileSync(SHELL, 'utf8');
  const nativeClean = stripComments(native);
  const wasmClean = stripComments(wasm);
  const arrayLiteral = (name) => {
    const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(shell);
    return m ? sortedKeys([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) : [];
  };

  // Compare one surface across its sources. Every source must be non-empty,
  // or a regex that stopped matching would report three equal empty sets.
  const compare = (what, sources) => {
    const names = Object.keys(sources);
    const all = sortedKeys(names.flatMap((n) => sources[n]));
    let equal = true;
    for (const n of names) {
      if (sources[n].length === 0) { out[`${what}: ${n}`] = 'VACUOUS — nothing found'; equal = false; }
    }
    for (const item of all) {
      const missing = names.filter((n) => !sources[n].includes(item));
      if (missing.length === 0) continue;
      const key = `${what}: ${item}`;
      const ledgerKey = Object.keys(SURFACE_LEDGER).find((k) => k.endsWith(`: ${item}`) && missing.length === names.length - 1
        && k.startsWith(names.find((n) => sources[n].includes(item)).split(' ')[0]));
      if (ledgerKey) { out[key] = `LEDGERED: only in ${names.find((n) => sources[n].includes(item))}`; continue; }
      out[key] = `MISSING from ${missing.join(' and ')}`;
      equal = false;
    }
    out[`${what}: count`] = all.length;
    out[`${what}: the same in ${names.join(', ')}`] = equal ? 'yes' : 'NO';
  };

  // Context methods.
  compare('context method', {
    'types.d.ts': sortedKeys(methodSignatures(interfaceBody(types, 'LuaContext')).keys()),
    'native binding': sortedKeys([...nativeClean.matchAll(/InstanceMethod\("(\w+)",\s*&LuaContext::/g)].map((m) => m[1])),
    'wasm binding (embind)': sortedKeys([...wasmClean.matchAll(/\.function\("(\w+)",\s*&lua_wasm::Thunk<\s*&LuaContext::/g)].map((m) => m[1])),
    'wasm shell (CONTEXT_METHODS)': arrayLiteral('CONTEXT_METHODS'),
  });

  // Shared table methods.
  compare('shared table method', {
    'types.d.ts': sortedKeys(methodSignatures(interfaceBody(types, 'SharedTable')).keys()),
    'native binding': sortedKeys([...nativeClean.matchAll(/InstanceMethod\("(\w+)",\s*&SharedTable::/g)].map((m) => m[1])),
    'wasm shell': sortedKeys([...classBody(shell, 'SharedTableImpl').matchAll(SHARED_METHOD)].map((m) => m[1])),
  });

  // Table handle methods and Proxy traps.
  compare('table handle method', {
    'types.d.ts': sortedKeys(methodSignatures(interfaceBody(types, 'LuaTableHandle')).keys()),
    // `add_method` is also how the three iterators get `next` and `return`;
    // a table handle's are the ones bound to a `TableHandle…` function.
    'native binding': sortedKeys([...nativeClean.matchAll(/add_method\("(\w+)",\s*TableHandle\w+\)/g)].map((m) => m[1])),
    'wasm shell (TABLE_METHODS)': arrayLiteral('TABLE_METHODS'),
  });
  const traps = /const TABLE_TRAPS = \{([\s\S]*?)\};/.exec(shell)?.[1] ?? '';
  compare('table proxy trap', {
    'native binding': sortedKeys([...nativeClean.matchAll(/add_trap\("(\w+)"/g)].map((m) => m[1])),
    'wasm shell (TABLE_TRAPS)': sortedKeys([...traps.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])),
  });

  // Module exports.
  // What the module registers: the `Set` calls in the two functions that build
  // the exports object, and nowhere else (`info()` builds an object the same way).
  const nativeExports = sortedKeys(topLevelFunctions(native)
    .filter((f) => f.name === 'InitModule' || f.name === 'LuaContext::Init')
    .flatMap((f) => [...stripComments(f.rawBody).matchAll(/\b(?:exports|result)\.Set\(\s*(?:Napi::String::New\(env,\s*)?"(\w+)"/g)].map((m) => m[1])));
  const defaultExport = /export default \{([\s\S]*?)\};/.exec(shell)?.[1] ?? '';
  const luaNative = interfaceBody(types, 'LuaNative');
  compare('module export', {
    'types.d.ts': sortedKeys([...optionKeys(luaNative), ...methodSignatures(luaNative).keys()]),
    'native binding': nativeExports,
    'wasm shell': sortedKeys([...defaultExport.matchAll(/^\s*(\w+)\s*[:,]/gm)].map((m) => m[1])),
  });

  // Options. Every key of every options object in the contract must be named,
  // as a string literal, by both bindings. "Named" and not "passed to a Get":
  // the three limits are read by a helper that takes the key as an argument.
  const nativeKeys = stringKeysRead(NATIVE, /\.(?:Get|Has)\(\s*"([A-Za-z_]\w*)"\s*\)/g);
  const wasmKeys = stringKeysRead(WASM, /js::(?:Get|Has)\(\s*[\w.\->[\]]+\s*,\s*"([A-Za-z_]\w*)"\s*\)/g);
  const OPTION_INTERFACES = ['LuaInitOptions', 'UserdataOptions', 'CompileOptions', 'EnvironmentOptions', 'HookOptions', 'ChunkNameOptions', 'ClassDefinition'];
  let options = 0;
  let unread = 0;
  for (const iface of OPTION_INTERFACES) {
    for (const key of optionKeys(interfaceBody(types, iface))) {
      options += 1;
      const literal = `"${key}"`;
      const missing = [!nativeClean.includes(literal) && 'the native binding', !wasmClean.includes(literal) && 'the wasm binding'].filter(Boolean);
      if (missing.length) { unread += 1; out[`option ${iface}.${key}`] = `NOT NAMED by ${missing.join(' or ')}`; }
    }
  }
  out['options in the contract'] = options;
  out['options not named by both bindings'] = unread;

  // The converse: a key one binding reads and the other does not is either an
  // option one of them invented, or plumbing with a reason.
  for (const [side, mine, theirs] of [['native', nativeKeys, wasmKeys], ['wasm', wasmKeys, nativeKeys]]) {
    for (const key of mine.filter((k) => !theirs.includes(k))) {
      out[`key read only by the ${side} binding: ${key}`] = KEY_LEDGER[side][key] ? 'LEDGERED' : 'UNEXPLAINED';
    }
    for (const key of Object.keys(KEY_LEDGER[side])) {
      if (!mine.includes(key) || theirs.includes(key)) out[`key ledger (${side}): ${key}`] = 'STALE LEDGER ENTRY';
    }
  }
  out['property keys read: native binding'] = nativeKeys.length;
  out['property keys read: wasm binding'] = wasmKeys.length;

  // Function names, binding against binding.
  const nativeFns = sortedKeys(topLevelFunctions(native).map((f) => f.name));
  const wasmFns = sortedKeys(topLevelFunctions(wasm).map((f) => f.name));
  for (const name of nativeFns.filter((n) => !wasmFns.includes(n))) out[`function only in the native binding: ${name}`] = 'frozen';
  for (const name of wasmFns.filter((n) => !nativeFns.includes(n))) out[`function only in the wasm binding: ${name}`] = 'frozen';
  out['functions in both bindings'] = nativeFns.filter((n) => wasmFns.includes(n)).length;

  for (const key of Object.keys(SURFACE_LEDGER)) {
    const item = key.slice(key.lastIndexOf(': ') + 2);
    if (!Object.keys(out).some((k) => k.endsWith(`: ${item}`) && String(out[k]).startsWith('LEDGERED'))) {
      out[`surface ledger: ${key}`] = 'STALE LEDGER ENTRY';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RETENTION: the one census with no counterpart here, and why
// ---------------------------------------------------------------------------
//
// `surface-census`'s census F derives every native member that retains a JS
// value — a `Napi::Reference`, transitively — and requires each to carry a
// `binding-balance` lifetime policy. Here a retained JS value is an
// `emscripten::val` member, and the same derivation over `lua-wasm.h` would be
// the honest extension.
//
// It is not built. What stands in for it is behavioural and already runs:
// `info().bindingRefs` reports the same thirteen container names from this
// binding, `binding-balance` searches them under `LUA_NATIVE_TARGET=wasm` with
// the native totals (42 cells, 0 findings), and `wasm-verify --harnesses`
// requires it on every full run. That covers every container that exists
// today. What it does not do is fail closed on a *new* `val` member with no
// counter — the thing census F exists for — so that gap is real, and is
// recorded in `docs/CORRECTNESS.md` §15.6 beside the row for a second binding.

export const WASM_INVARIANTS = [
  {
    id: 'wasm:scanner-coverage',
    title: 'The C++ scanner accounts for every definition-shaped line of the WASM binding',
    compute: wasmScannerCoverage,
    note: 'As scanner-coverage: an UNATTRIBUTED line means every invariant below ranges over less than it claims.',
  },
  {
    id: 'wasm:callscope-classification',
    title: 'CallScope placement in the WASM binding, per function that can run user JS',
    compute: wasmCallScope,
    note: 'As callscope-classification, over src/wasm/lua-wasm.cpp. A class change is a review item, not automatically a defect. Compare the function\'s native row: the port kept the names.',
  },
  {
    id: 'wasm:occupancy-policy-sites',
    title: 'Which operation declares which lua_occupancy policy in the WASM binding',
    compute: wasmOccupancy,
    note: 'Must equal the native binding\'s set: a policy is behaviour a caller observes. NO on the last row means one binding changed an operation\'s policy and the other did not.',
  },
  {
    id: 'wasm:exception-surface',
    title: 'Throw / catch counts in the WASM binding and its JS layer',
    compute: wasmExceptionSurface,
  },
  {
    id: 'wasm:core-call-guarding',
    title: 'WASM binding calls that can let a C++ exception reach JavaScript',
    compute: wasmCoreCallGuarding,
    note: 'The CR-6 F1 class on this target. An exception that escapes an entry point here does not abort a process; it reaches the caller as a raw WebAssembly exception with the module\'s frames abandoned, which the binding promises never to do. ESCAPES_AT_ROOT or UNGUARDED_AND_PROPAGATES must be justified.',
  },
  {
    id: 'wasm:liveness-guarding',
    title: 'WASM binding paths that reach the core without establishing the state is still there',
    compute: wasmLiveness,
    note: 'As liveness-guarding. An UNCHECKED row is not a defect today; a NEW one is a review item. Compare the native row of the same name first.',
  },
  {
    id: 'wasm:brand-rule',
    title: 'A JS-supplied value becomes a struct, a context or a shared table only by something JS cannot forge',
    compute: wasmBrandRule,
    note: 'The counterpart of objectwrap-branding (CR-20 F5, CR-15 F6). UNGUARDED on a pointer row is a JS value cast to a C++ pointer with no kind check. NO on a receiver row is a method that reads private state from whatever it was called on.',
  },
  {
    id: 'binding-parity',
    title: 'The public surface is the same in types.d.ts, the native binding and the WASM binding',
    compute: bindingParity,
    note: 'D1\'s cost made visible. MISSING / NOT NAMED / NO means a door or an option exists in one binding and not the other: port it, or it is not part of the API. UNEXPLAINED means a binding reads a property key the other does not and nobody has said why. A new "function only in…" row is a review item: a helper landed in one binding.',
  },
];
