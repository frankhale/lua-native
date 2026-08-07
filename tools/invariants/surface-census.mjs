// The surface census — CORRECTNESS.md §15.6's trigger table, computed.
//
// Why this file exists
// --------------------
// §15.6 lists what reopens review and, for each trigger, the instrument to
// extend. Four of its rows already fail closed on their own (a new
// `napi_type_tag`, a new `ObjectWrap`, a new occupancy policy, a bare
// `.toThrow()`) — those say "nothing" in the "extend" column because the
// mechanism turns the suite red without anyone deciding to look. The other rows
// do not. They are a **table in a document that a human has to consult**, and
// this codebase has measured, five separate times, what happens to a
// hand-maintained enumeration:
//
//   * in the product      — CR-17 F2 fixed one round-trip marker of four;
//   * in a fix            — CR-21 F2 covered arrays and objects, not the two
//                           recursing builtins;
//   * in an instrument    — CR-22's drafts;
//   * in the boundary list— CR-22 F2 (cross-context, missing for 21 passes);
//   * in the trigger table itself — CR-23 F4: `sandbox`, `binaryStrings` and
//                           `strictConversion` matched **no row**, so the
//                           trigger correctly fired nothing while two defects
//                           sat in the region it did not name.
//
// The table gained a mode row and a stated criterion after CR-23. This file is
// the other half of that fix: the criterion, run.
//
//   > A trigger is anything that adds a **new way for a value or a call to
//   > cross a boundary** — a new place (an entry point, a frame, a handle kind)
//   > *or a new rule at an existing place* (an option, a preset, a version
//   > bump).
//
// Four censuses, one per half of that sentence that is mechanically decidable.
// Each computes its universe from the source, computes what the relevant
// instrument actually covers by reading that instrument's own axis file, and
// scores every member of the universe:
//
//   COVERED       the instrument has a row for it
//   LEDGERED      it is deliberately out of scope, with the reason below
//   UNCLASSIFIED  nobody has ruled on it  <- the state this file exists to end
//
// **UNCLASSIFIED is not an accusation of a defect.** It is the same contract
// `callScopeClassification` offers: a NO_SCOPE row is not automatically wrong,
// it is automatically *a review item*. What this ends is the third state —
// surface that is neither covered nor consciously excluded, which is what
// `binaryStrings` was for two commits.
//
// Two conventions inherited from the rest of the tree, both load-bearing:
//
//   * **Totals are frozen alongside the verdicts** (CR-19 F2, CR-21 F3). These
//     censuses are count-shaped: a regex that stops matching reports an empty
//     universe, and an empty universe scores no UNCLASSIFIED rows and reads as
//     a clean sheet. `diffInvariant` cannot catch that with missing keys, so
//     each census freezes the size of every set it derived.
//   * **A stale ledger entry is reported, never silently ignored**
//     (`tools/README.md`). An excuse for surface that no longer exists is an
//     excuse nobody re-examined.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOORS } from '../roundtrip-matrix/doors.mjs';
import { MODES } from '../roundtrip-matrix/modes.mjs';
import { CONFIGS } from '../capability-matrix/configs.mjs';
import { HANDLES } from '../lifecycle-matrix/handles.mjs';
import { FRAMES } from '../exception-matrix/frames.mjs';
import { CONTAINERS, NOT_COUNTED } from '../binding-balance/policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// TypeScript declaration scanning
// ---------------------------------------------------------------------------

// Block comments in `types.d.ts` contain `{@link …}`, so brace matching has to
// run on a stripped source or the first JSDoc paragraph swallows the file.
export function stripTsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

export function interfaceBody(src, name) {
  const decl = new RegExp(`export interface ${name}(?:\\s+extends [^{]+)?\\s*\\{`);
  const m = decl.exec(src);
  if (!m) throw new Error(`surface census: interface ${name} not found in types.d.ts`);
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      return src.slice(m.index + m[0].length, i);
    }
  }
  throw new Error(`surface census: interface ${name} is unbalanced`);
}

// Members declared at the interface's own indent level. Nested object types are
// indented further and are deliberately not members.
export function optionKeys(body) {
  return [...new Set([...body.matchAll(/^ {2}(\w+)\??\s*:/gm)].map((m) => m[1]))].sort();
}

// Every method signature in an interface body, as `{ name, params }`. A
// signature may span lines (`set_metatable(`, `call_async<…>(`), so the
// parameter text is taken by matching parens rather than by reading one line.
// Overloads are merged: `gc` is declared seven times and is one entry point.
export function methodSignatures(body) {
  const out = new Map();
  const re = /^ {2}(\w+)\s*(?:<[^(]*>)?\(/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const open = body.indexOf('(', m.index + m[1].length + 2);
    let depth = 0;
    let close = -1;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')' && --depth === 0) { close = i; break; }
    }
    if (close < 0) throw new Error(`surface census: unbalanced signature for ${m[1]}`);
    const params = body.slice(open + 1, close);
    out.set(m[1], (out.get(m[1]) ?? '') + params + ';');
  }
  return out;
}

// The set of declared types that can carry a JS value into Lua, as a transitive
// closure rather than a list.
//
// Seeded with the three the API is written in terms of, then closed over every
// interface and type alias whose body mentions a member of the set. This is the
// same shape as `throwingCoreMethods`' fixpoint and it exists for the same
// reason: `ClassDefinition` carries values (its `construct` takes `LuaValue[]`)
// and `CompileOptions` does not, and deciding that by hand is how the
// enumeration goes one member short.
export function valueBearingTypes(src) {
  const seed = ['LuaInput', 'LuaValue', 'LuaCallback', 'LuaCallbacks'];
  const set = new Set(seed);
  const decls = new Map();
  for (const m of src.matchAll(/export (?:interface|type) (\w+)/g)) {
    const name = m[1];
    let body;
    try {
      body = interfaceBody(src, name);
    } catch {
      // A type alias: take the text to the terminating semicolon.
      const at = src.indexOf(m[0]);
      body = src.slice(at, src.indexOf(';', at));
    }
    decls.set(name, body);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, body] of decls) {
      if (set.has(name)) continue;
      for (const known of set) {
        if (new RegExp(`\\b${known}\\b`).test(body)) { set.add(name); changed = true; break; }
      }
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// C++ scanning
// ---------------------------------------------------------------------------

// The Lua C frames: a function the Lua VM can call, i.e. one with C-function
// signature. Both free functions and `LuaRuntime::` static members count — the
// VM cannot tell them apart and neither should this.
function luaCFrames(core) {
  return [...core.matchAll(/^int ((?:LuaRuntime::)?\w+)\(lua_State\* ?L\)\s*\{/gm)]
    .map((m) => ({ name: m[1].replace('LuaRuntime::', ''), at: m.index }));
}

// Whether a frame can re-enter the host, decided by whether its body reaches one
// of the runtime's host-callback members. That member set is itself computed: a
// data member of the core whose declared type mentions one of the
// `std::function` aliases the header defines. A new kind of host callback
// therefore widens this automatically instead of needing to be remembered.
//
// The declaration form has to be matched loosely, because the members are not
// uniform: `PropertyGetter property_getter_;` sits beside
// `std::shared_ptr<InputHandler> input_handler_;` and
// `std::unordered_map<std::string, std::shared_ptr<Function>> host_functions_;`.
// An anchored pattern found eight of the nine and dropped `host_functions_` —
// which is the one the main bridge uses, so the census scored
// `LuaCallHostFunction` as unable to reach the host. Frozen counts below.
export function hostCallbackMembers(header) {
  const aliases = [...header.matchAll(/using (\w+) = std::function</g)].map((m) => m[1]);
  const members = new Set();
  for (const m of header.matchAll(/^\s+([\w:<>, ]+?)\s+(\w+_);/gm)) {
    if (aliases.some((a) => new RegExp(`\\b${a}\\b`).test(m[1]))) members.add(m[2]);
  }
  return { aliases, members: [...members].sort() };
}

// Core methods that reach a host callback, as a fixpoint.
//
// A frame rarely touches the member itself: `LuaIoRead` asks
// `runtime->HasInputHandler()`, `LuaPrint` goes through the output plumbing.
// Asking only "does the body name a member" found three host-callable frames of
// the twenty-three and missed the print, io, dofile and searcher bridges — so
// the question is asked of a *path*, the same shape `coreCallGuarding` uses one
// section up: a method reaches the host if it names a callback member, or calls
// a method that does.
// Members that retain a JS value beyond the call that supplied it — the
// universe of census F.
//
// > A member qualifies iff its type mentions a `Napi::*Reference`, **or a
// > struct that transitively does**.
//
// Stated as a rule rather than a list for the reason §15.6 gives: an
// enumeration that cannot say where it came from cannot be checked for
// completeness, only extended when something leaks past. The rule is
// deliberately syntactic — it reads types, not intent — so a member whose type
// says it retains but whose author believed otherwise still shows up.
//
// **The transitive clause was added after the direct-only version was written
// and run**, which is worth recording because it is the same defect this file
// exists to catch, made in this file. The first draft matched only types
// literally containing `Napi::…Reference`, and so returned 21 members while
// missing `js_userdata_` (a map of `UserdataEntry`, which holds one),
// `class_accessors_` (a map of `ClassAccessorTable`, which holds a map of
// `ClassAccessor`, which holds two) and `subscribers_` (a vector of
// `Subscriber`, which holds one). A class boundary drawn one member short, at
// the seventh level of this stack: the *rule* that generates the enumeration
// that governs the census that scores the instrument.
//
// Two consequences of ranging over the whole header rather than `LuaContext`:
//
//   * `SharedTable` and `AddonData` hold references too. Dropping them silently
//     would be the same defect again, so they are scored and then ledgered,
//     with reasons, in `binding-balance/policy.mjs`'s NOT_COUNTED.
//   * The *fields* of a retaining struct (`UserdataEntry::object`,
//     `ClassAccessor::getter`) qualify alongside the containers holding them.
//     They are counted through their container rather than separately — a
//     ruling, and one that has to be written down, which is the point.
//
// What the rule **cannot** see, stated rather than left to be discovered: a
// container holding *names* of references held elsewhere. `ud_method_fns_`
// (strings naming `js_callbacks_` entries) and `registered_classes_` are exactly
// that, and no type-directed scan can decide it. They are covered by
// `binding-balance` anyway, and the census reports such rows as coverage beyond
// its own universe rather than pretending it derived them.
export function retainingMembers(header) {
  const DIRECT = /Napi::\w*Reference/;
  // Struct bodies, so the transitive step has something to walk. Indented
  // declarations included: `SharedTable::Subscriber` is nested and private, and
  // it is the member that most needs to be seen — a vector of it is the one
  // retaining container in this header that belongs to neither LuaContext nor
  // the harness's subject.
  const structs = new Map();
  for (const m of header.matchAll(/^[ \t]*(?:struct|class)\s+(\w+)[^;{]*\{/gm)) {
    structs.set(m[1], functionBodyAt(header, m.index));
  }

  // A struct retains if a field's type is a reference, or names a struct that
  // retains. Iterated to a fixpoint, the same shape `hostReachingCoreMethods`
  // uses one section down — for the same reason: one hop is never enough.
  const retaining = new Set(
    [...structs].filter(([, body]) => DIRECT.test(body)).map(([name]) => name),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, body] of structs) {
      if (retaining.has(name)) continue;
      for (const other of retaining) {
        if (new RegExp(`\\b${other}\\b`).test(body)) { retaining.add(name); changed = true; break; }
      }
    }
  }

  const members = new Set();
  for (const m of header.matchAll(/^\s+((?:const\s+)?[\w:<>,\s*&]+?)\s+(\w+_?);/gm)) {
    const type = m[1];
    // A raw pointer or reference to a retaining type does not itself retain —
    // it observes. Without this the RAII scope structs' `LuaContext* ctx`
    // back-pointers qualify, and four of them would sit in the universe wanting
    // a lifetime policy they can only answer "not mine".
    if (/[*&]\s*$/.test(type)) continue;
    if (DIRECT.test(type) || [...retaining].some((s) => new RegExp(`\\b${s}\\b`).test(type))) {
      members.add(m[2]);
    }
  }
  return [...members].sort();
}

export function hostReachingCoreMethods(core, members) {
  const fns = [...core.matchAll(/^[\w:<>&* ]+?\b(?:LuaRuntime::)?(\w+)\([^;{]*\)(?: const)?\s*\{/gm)]
    .map((m) => ({ name: m[1], body: functionBodyAt(core, m.index) }));
  const reaching = new Set(fns.filter((f) => members.some((mem) => f.body.includes(mem))).map((f) => f.name));
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fns) {
      if (reaching.has(f.name)) continue;
      for (const callee of reaching) {
        if (new RegExp(`(?:^|[^\\w:])${callee}\\s*\\(`).test(f.body)) {
          reaching.add(f.name); changed = true; break;
        }
      }
    }
  }
  return reaching;
}

function functionBodyAt(src, at) {
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

// Marker literals the binding reads back off a JS object it was handed.
//
// This is the set §15.6's own note says to use — "the distinction is *is there
// a marker to reinterpret*, not *is it a handle*" — so the universe is markers
// **consulted**, not every hidden property defined.
//
// Which makes the read side the whole definition, and lets this be one regex
// over the file rather than a list of the functions that do the consulting. The
// first attempt named `NapiToCoreInstance` and `NapiToCore`; the reads are
// actually in `NapiToCoreImpl`, so it found nothing and scored a clean sheet
// over an empty universe — the exact failure the frozen totals below exist to
// catch, reproduced here on the first run.
//
// A marker that is written and never read (`__coroIterOwner`, a GC root that is
// never dereferenced back) cannot be reinterpreted by another context, and drops
// out on its own because it appears in no `.Get(` or `.Has(`.
export function inboundMarkers(binding) {
  const markers = new Set();
  for (const m of binding.matchAll(/\.(?:Get|Has)\("(_{1,2}[a-zA-Z]\w*)"\)/g)) markers.add(m[1]);
  return [...markers].sort();
}

// ---------------------------------------------------------------------------
// Instrument coverage
// ---------------------------------------------------------------------------

// `cross-context/run.mjs` constructs Lua contexts at module scope, so its case
// list is read as text rather than imported. The count is frozen below for the
// usual reason: a regex that stops matching would report an empty instrument,
// and an empty instrument covers nothing without saying so.
//
// **Both arrays count as coverage, and reading only the first was this file's
// third self-inflicted false finding.** `HANDLE_CASES` asks "is a handle from A
// refused by B"; `NOT_HANDLE_CASES` asks "does this cross freely and arrive
// intact". For a marker, *either* is a ruling — and CR-22 F1 established that
// the second is the correct ruling for three of them. Scoring only the refusal
// array reported `__luaClassRef`, `__luaFnOwner` and the class companions as
// unsearched, when in fact the instrument searches them deliberately, on the
// other side, with the answer the ledger's M6 entry pins. Reporting those as
// gaps would have argued for reversing M6 — which is precisely the mistake
// CR-22's own first draft made and caught by reading M6 before believing itself.
function crossContextCases(src) {
  const ids = [];
  for (const name of ['HANDLE_CASES', 'NOT_HANDLE_CASES']) {
    const start = src.indexOf(`const ${name} = [`);
    if (start < 0) throw new Error(`surface census: ${name} not found in cross-context/run.mjs`);
    const end = src.indexOf('\n];', start);
    ids.push(...[...src.slice(start, end).matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]));
  }
  return [...new Set(ids)].sort();
}

// ---------------------------------------------------------------------------
// The ledgers
// ---------------------------------------------------------------------------
//
// Every entry is surface that is deliberately not covered by its instrument,
// with the reason. An entry naming something no longer in the universe is
// reported as STALE rather than dropped: an excuse for surface that no longer
// exists is an excuse nobody re-read.

export const OPTION_LEDGER = {
  maxMemory:
    'A resource limit, not a conversion rule. CORRECTNESS.md §15.2 rules the '
    + 'limits out of matrix coverage by the §15.1 criterion: exhausting the budget '
    + 'aborts the VM loudly rather than producing a plausible wrong answer, so it '
    + 'fails clause three. Covered by 117 suite references and by the exception '
    + 'matrix, which owns the ERRMEM longjmp frame.',
  maxInstructions: 'Same as maxMemory: a resource limit that fails loudly. §15.2.',
  timeout: 'Same as maxMemory: a resource limit that fails loudly. §15.2.',
  print:
    'An output channel, not a rule on values crossing inward. The print handler '
    + 'is an exception-matrix frame (`print_handler`) because it can throw from '
    + 'inside a Lua C frame; it changes nothing about how a value converts.',
  shared:
    'Shared tables are the cross-context instrument\'s subject, not a mode. A '
    + 'mode re-rules the JS->Lua crossing for every door; `shared` adds a '
    + 'participant to the context<->context boundary, which is boundary 7 and '
    + 'has its own search.',
};

export const ENTRY_POINT_LEDGER = {
  set_metatable:
    'Its values reach Lua as metamethods, which are called rather than read '
    + 'back, so there is no round trip to compare. The crossing is searched from '
    + 'the other end: `metamethod_index`, `_newindex`, `_add`, `_tostring`, '
    + '`_lt`, `_call` and `_concat` are seven exception-matrix frames.',
  register_type_converter:
    'A converter is a rule about the crossing rather than a value crossing it. '
    + 'Its frames are `type_converter` and `from_lua_converter` in the exception '
    + 'matrix. A round-trip door would be testing the test.',
  create_coroutine:
    'Its value-typed parameter is a `LuaFunction` — a handle, not data. Handles '
    + 'crossing is boundary 6 and 7 (`lifecycle-matrix` Axis A `function`, '
    + '`cross-context` `function-bridge`), and the coroutine it returns is itself '
    + 'a door (`coroutine-resume-arg`, `resume_async-arg`).',
  execute_script_in:
    'Same shape: the value-typed parameter is a `LuaEnvironment` handle. The '
    + 'value crossing *into* that environment is the `environment` door, which '
    + 'drives this method as its read side.',
  register_class:
    'A class definition\'s values reach Lua through its methods, statics and '
    + 'property accessors, and each of those is already a door: '
    + '`class-method-return`, `class-static-return`, `class-property-get`, '
    + '`class-property-set`. A door on `register_class` itself would be those '
    + 'four again with one fewer assertion.',
  release:
    'Takes a handle to destroy it. Handle lifetime under explicit release is '
    + 'Axis B of the lifecycle matrix (`release-then-use`, `double-release`, '
    + '`close-then-release`, `release-then-close`), which is a stronger search '
    + 'than a round trip.',
  close: 'Same as release: a lifecycle event, covered by the lifecycle matrix.',
};

export const MARKER_LEDGER = {};

// --- Census E: the trigger table's own rows --------------------------------
//
// **The kind-level check, and the one §1.1 of UNSEARCHED-REGIONS-PLAN predicted
// would be needed next.** Censuses A–D each compute one *kind* of surface, and
// the list of kinds — options, value-taking entry points, inbound markers,
// host-callable frames — was itself a hand-written enumeration with no
// generating rule. That is the exact shape of every defect this programme has
// found at four levels already, and CR-23 found it one level up in §15.6.
//
// The rule the kind list is generated from is §15.6's own criterion:
//
//   > A trigger is anything that adds a new way for a value or a call to cross a
//   > boundary — a new place (an entry point, a frame, a handle kind) *or a new
//   > rule at an existing place* (an option, a preset, a version bump).
//
// So rather than assert the kinds by hand a second time, this census **reads the
// trigger table out of `docs/CORRECTNESS.md` and requires every row to have a
// disposition**. A row can be:
//
//   COMPUTED     — one of censuses A-D derives its universe
//   FAILS-CLOSED — no census needed; the mechanism turns the suite red on its own
//   MANUAL       — genuinely not mechanically decidable, with the reason
//
// A row with none of the three is UNDISPOSED and turns the suite red. **A new
// row added to the table in prose therefore cannot be added without ruling on
// it**, which is the property the table has never had — and a row deleted from
// the doc while its disposition remains here reports STALE.
export const TRIGGER_DISPOSITION = [
  { match: /new public entry point that takes a JS value/i, verdict: 'COMPUTED: census B' },
  { match: /new entry point that executes a script/i,
    verdict: 'MANUAL: "executes a script" is a semantic property of a method body, '
      + 'not a signature; exec-parity\'s doors are declared by whoever adds one' },
  { match: /new \*?asynchronous\*? entry point/i,
    verdict: 'MANUAL: same reason, plus the door must prove it really awaits' },
  { match: /new handle kind, or a new marker/i, verdict: 'COMPUTED: census C' },
  { match: /new option that changes \*?conversion\*?/i, verdict: 'COMPUTED: census A (roundtrip-matrix modes)' },
  { match: /changes \*?capability\*?/i, verdict: 'COMPUTED: census A (capability-matrix configs)' },
  { match: /new Lua C frame/i, verdict: 'COMPUTED: census D' },
  { match: /new member that retains a JS value/i, verdict: 'COMPUTED: census F' },
  { match: /new `?ObjectWrap`? subclass/i, verdict: 'FAILS-CLOSED: objectwrap-branding' },
  { match: /new `?napi_type_tag`?/i, verdict: 'FAILS-CLOSED: greppable-counts + AllTagsDistinct' },
  { match: /new performance claim in shipped docs/i,
    verdict: 'FAILS-CLOSED: perf-claims reports UNCLAIMED and the suite goes red' },
  { match: /new occupancy policy/i, verdict: 'FAILS-CLOSED: the generative assert in RejectIfOccupied' },
  { match: /Lua version bump/i,
    verdict: 'MANUAL: the reference moves; nothing in this repository can detect '
      + 'that the vcpkg port changed underneath it' },
  { match: /new threading mode/i,
    verdict: 'MANUAL: would invalidate §15.2\'s race row and every instrument\'s '
      + 'single-threaded assumption; not a row a scan can score' },
];

// The §15.6 trigger table, read out of the document rather than restated.
export function triggerTableRows(correctnessMd) {
  const at = correctnessMd.indexOf('## 15.6');
  if (at < 0) throw new Error('surface census: §15.6 not found in CORRECTNESS.md');
  const section = correctnessMd.slice(at, correctnessMd.indexOf('\n## ', at + 10));
  const rows = [];
  for (const line of section.split('\n')) {
    const m = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const trigger = m[1].trim();
    if (/^-+$/.test(trigger) || /^Trigger$/i.test(trigger)) continue;
    rows.push(trigger);
  }
  if (rows.length < 5) throw new Error(`surface census: §15.6 table parsed as ${rows.length} rows`);
  return rows;
}

export const FRAME_LEDGER = {
  HostFnSentinelGC:
    'Reaches a host callback but not *user* JS, which is the distinction the '
    + 'exception matrix searches. `host_fn_gc_callback_` is bound in the binding '
    + 'to `js_callbacks_.erase(name)` — addon bookkeeping with no user code in '
    + 'it — so there is no user throw to unwind through this frame. **This is the '
    + 'one place the computed predicate over-approximates**, and it is written '
    + 'down rather than narrowed: tightening the predicate to "reaches user JS" '
    + 'would need to follow the callback into the binding and decide what a '
    + 'lambda body can call, and an over-approximation with a stated reason is '
    + 'worth more than a tighter scan nobody can check. `userdata_gc_callback_` '
    + 'is the same shape but its frame (`UserdataGC`) is covered anyway.',
};

// ---------------------------------------------------------------------------
// The two stated mappings, and why they are stated rather than derived
// ---------------------------------------------------------------------------
//
// Censuses A and B derive their coverage: a mode declares the option keys it
// sets, and a door names the entry point it drives in its own id, so both can
// be read off the instrument. C and D cannot. "Which cross-context case carries
// the `_userdata` marker" and "which exception-matrix frame is
// `LuaCallHostFunction`" are semantic facts about what a probe *does*; no regex
// over `run.mjs` recovers them, and the one attempt at it here — inferring the
// marker from the lifecycle handle id — was a hand-written table wearing a
// derivation's clothes, which is worse than an honest one.
//
// So they are stated. What keeps them from decaying is that **both ends are
// checked against a computed universe**, the same contract `JUSTIFIED_ESCAPES`
// works under:
//
//   * a key that is not in the computed universe  -> STALE, reported;
//   * a value naming a case or frame id the instrument does not have
//                                                 -> BROKEN LINK, reported;
//   * a universe member with no entry             -> UNCLASSIFIED, reported.
//
// The third is the one that matters and is the whole point of the file: a new
// inbound marker or a new host-callable frame cannot arrive without landing in
// exactly one of these three states, all of which turn the suite red.

// Marker -> the cross-context cases that hand an object bearing it to a foreign
// context. A case from either array is a ruling; see `crossContextCases`.
export const MARKER_CASES = {
  _tableRef: ['table-ref', 'table-created', 'table-proxy'],
  _coroutine: ['coroutine'],
  // Two rulings, deliberately: a Lua userdata handle is refused, a
  // `set_userdata` object is the caller's own object and crosses freely. CR-22
  // F1's correction table.
  _userdata: ['userdata-lua', 'userdata-js'],
  // Crosses freely and correctly — refusing it would mean refusing every
  // closure over another context (CR-22 F1's correction).
  __luaFnOwner: ['function-bridge'],
  // The class-instance marker set is read as a unit by the round-trip identity
  // check (`__luaClassRef` gated on `__luaClassOwner` + `__luaClassOwnerId`,
  // with `__luaClassName` alongside), so one case rules on all four. The ruling
  // is deep-copy-with-data-intact, which is ledger entry M6 and is pinned.
  __luaClassRef: ['class-instance'],
  __luaClassName: ['class-instance'],
  __luaClassOwner: ['class-instance'],
  __luaClassOwnerId: ['class-instance'],
};

// Lua C frame -> the exception-matrix frames that unwind through it.
export const FRAME_CASES = {
  LuaCallHostFunction: ['host_function', 'metamethod_index', 'metamethod_newindex',
    'metamethod_add', 'metamethod_tostring', 'metamethod_lt', 'metamethod_call',
    'metamethod_concat', 'call_async_host', 'resume_async_host'],
  UserdataIndex: ['userdata_proxy_get'],
  UserdataMethodCall: ['userdata_method'],
  ClassIndex: ['class_method', 'class_metamethod'],
  LuaPrint: ['print_handler'],
  LuaIoRead: ['read_handler'],
  LuaDoFile: ['file_reader'],
  LuaLoadFile: ['file_reader_loadfile'],
  LuaIoWrite: ['io_write_handler'],
  UserdataNewIndex: ['userdata_proxy_set'],
  JsSearcher: ['require_searcher'],
  UserdataGC: ['gc_finalizer', 'gc_finalizer_at_close'],
};

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

export function score(universe, coveredBy, ledger, out, prefix) {
  let unclassified = 0;
  for (const member of universe) {
    const cover = coveredBy.get(member);
    const excuse = ledger[member];
    if (cover && excuse) out[`${prefix}${member}`] = `LEDGERED_BUT_COVERED(${cover}) — drop the ledger entry`;
    else if (cover) out[`${prefix}${member}`] = `COVERED: ${cover}`;
    else if (excuse) out[`${prefix}${member}`] = 'LEDGERED';
    else { out[`${prefix}${member}`] = 'UNCLASSIFIED'; unclassified += 1; }
  }
  for (const key of Object.keys(ledger)) {
    if (!universe.includes(key)) out[`${prefix}${key}`] = 'STALE LEDGER ENTRY — no longer in the universe';
  }
  return unclassified;
}

// Coverage from a stated mapping, with both ends checked (see the note above
// the mappings). A mapping value naming an id the instrument does not have is a
// BROKEN LINK: it reads as coverage and is not.
export function mappedCoverage(mapping, instrumentIds) {
  const cover = new Map();
  const broken = [];
  for (const [member, ids] of Object.entries(mapping)) {
    const missing = ids.filter((id) => !instrumentIds.includes(id));
    if (missing.length) broken.push(`${member} -> ${missing.join(', ')}`);
    const present = ids.filter((id) => instrumentIds.includes(id));
    if (present.length) cover.set(member, present.join(', '));
  }
  return { cover, broken };
}

export function surfaceCensus() {
  const types = stripTsComments(read('types.d.ts'));
  const binding = read('src/lua-native.cpp');
  const core = read('src/core/lua-runtime.cpp');
  const header = read('src/core/lua-runtime.h');
  const out = {};

  // --- A. Options -> the axis of whichever instrument re-rules the boundary --
  //
  // **An option is covered by whichever instrument varies it, and until August
  // 6, 2026 this census could only see one of them.** Coverage was the union of
  // the option keys set by a `roundtrip-matrix` mode, which is right for the
  // options that re-rule *conversion* and structurally wrong for the ones that
  // re-rule *capability*: `libraries` and `allowBytecode` change which doors
  // exist, not how a value converts, so no round-trip mode would ever set them
  // and `LEDGERED` was the only verdict they could reach. They read as
  // UNCLASSIFIED; they were in fact unclassifiable, which is a worse state and
  // one the census had no way to distinguish.
  //
  // That is the same defect this file was written to end, one level up: an
  // enumeration (here, "the instruments an option can be covered by") with a
  // single member and no stated rule. The rule now is the one §15.1 already
  // implies — **an option is covered iff some instrument's configuration axis
  // varies it** — and the axis list below is what it ranges over. A third
  // instrument with a config axis joins it by being added here.
  const AXES = [
    { instrument: 'roundtrip-matrix', entries: MODES },
    { instrument: 'capability-matrix', entries: CONFIGS },
  ];
  const options = optionKeys(interfaceBody(types, 'LuaInitOptions'));
  const modeCover = new Map();
  for (const axis of AXES) {
    for (const entry of axis.entries) {
      for (const key of Object.keys(entry.options ?? {})) {
        // Accumulate as an array. Joining on each pass and re-spreading the
        // result spreads a *string*, one character per mode id.
        modeCover.set(key, [...(modeCover.get(key) ?? []), `${axis.instrument}:${entry.id}`]);
      }
    }
  }
  for (const [k, v] of modeCover) modeCover.set(k, v.join(', '));
  const optionUnclassified = score(options, modeCover, OPTION_LEDGER, out, 'option: ');
  out['A. options declared'] = options.length;
  out['A. modes in roundtrip-matrix'] = MODES.length;
  out['A. configs in capability-matrix'] = CONFIGS.length;
  out['A. options UNCLASSIFIED'] = optionUnclassified;

  // --- B. Value-taking entry points -> round-trip doors ---------------------
  const bearing = valueBearingTypes(types);
  const entryPoints = [];
  for (const iface of ['LuaContext', 'LuaTableHandle']) {
    for (const [name, params] of methodSignatures(interfaceBody(types, iface))) {
      const takesValue = [...bearing].some((t) => new RegExp(`\\b${t}\\b`).test(params));
      if (takesValue && !entryPoints.includes(name)) entryPoints.push(name);
    }
  }
  entryPoints.sort();
  // Each door declares the entry points the round-tripped value crosses through
  // (`entryPoints` in doors.mjs). Keeping the fact in the instrument means
  // whoever writes a door states its coverage where they are already looking,
  // instead of in a second list here that would decay independently — the
  // failure this whole file is about.
  //
  // The first attempt inferred it from the door *id* by substring match, which
  // is why it is stated now: ids are named after mechanisms, so `userdata-field`
  // never matched `set_userdata` and `module-field` never matched
  // `register_module`, and both read as uncovered.
  const doorCover = new Map();
  for (const d of DOORS) {
    if (!Array.isArray(d.entryPoints)) throw new Error(`surface census: door ${d.id} declares no entryPoints`);
    for (const ep of d.entryPoints) doorCover.set(ep, [...(doorCover.get(ep) ?? []), d.id]);
  }
  for (const [k, v] of doorCover) doorCover.set(k, v.join(', '));
  const entryUnclassified = score(entryPoints, doorCover, ENTRY_POINT_LEDGER, out, 'entry point: ');
  out['B. value-bearing types (closure)'] = bearing.size;
  out['B. value-taking entry points'] = entryPoints.length;
  out['B. doors in roundtrip-matrix'] = DOORS.length;
  out['B. entry points UNCLASSIFIED'] = entryUnclassified;

  // --- C. Inbound markers -> lifecycle + cross-context ----------------------
  //
  // **This census deliberately does NOT demand parity between the two
  // instruments**, and that restraint is the finding CR-22 F1 paid for. A
  // handle kind can be a real lifecycle case and correctly absent from
  // cross-context — the async coroutine cursor is exactly that. So the universe
  // here is the *markers the binding reads back*, which is the property that
  // makes cross-context reinterpretation possible at all, and lifecycle
  // coverage is reported beside it rather than required to match.
  const markers = inboundMarkers(binding);
  const xctxCases = crossContextCases(read('tools/cross-context/run.mjs'));
  const marked = mappedCoverage(MARKER_CASES, xctxCases);
  const markerUnclassified = score(markers, marked.cover, MARKER_LEDGER, out, 'marker: ');
  for (const b of marked.broken) out[`marker link: ${b}`] = 'BROKEN LINK — no such cross-context case';
  out['C. inbound markers'] = markers.length;
  out['C. lifecycle handle kinds'] = HANDLES.length;
  out['C. cross-context handle cases'] = xctxCases.length;
  out['C. markers UNCLASSIFIED'] = markerUnclassified;

  // --- D. Host-callable Lua C frames -> exception matrix --------------------
  const { aliases, members } = hostCallbackMembers(header);
  const frames = luaCFrames(core);
  const reaching = hostReachingCoreMethods(core, members);
  const hostCallable = frames.filter((f) => reaching.has(f.name)).map((f) => f.name).sort();
  const framed = mappedCoverage(FRAME_CASES, FRAMES.map((f) => f.id));
  const frameUnclassified = score(hostCallable, framed.cover, FRAME_LEDGER, out, 'frame: ');
  for (const b of framed.broken) out[`frame link: ${b}`] = 'BROKEN LINK — no such exception-matrix frame';
  out['D. host-callback aliases'] = aliases.length;
  out['D. host-callback members'] = members.join(', ');
  out['D. Lua C frames in core'] = frames.length;
  out['D. host-callable frames'] = hostCallable.length;
  out['D. exception-matrix frames'] = FRAMES.length;
  out['D. frames UNCLASSIFIED'] = frameUnclassified;

  // --- E. The trigger table's own rows --------------------------------------
  const triggers = triggerTableRows(read('docs/CORRECTNESS.md'));
  const usedDispositions = new Set();
  let undisposed = 0;
  for (const trigger of triggers) {
    const hit = TRIGGER_DISPOSITION.find((d) => d.match.test(trigger));
    // The row text is long prose; key on a short stable prefix so the frozen
    // answer does not churn on an edit to the wording after the first clause.
    const key = `trigger: ${trigger.replace(/[*`]/g, '').slice(0, 52)}`;
    if (hit) {
      usedDispositions.add(hit.match.source);
      out[key] = hit.verdict;
    } else {
      out[key] = 'UNDISPOSED — add it to TRIGGER_DISPOSITION or give it a census';
      undisposed += 1;
    }
  }
  for (const d of TRIGGER_DISPOSITION) {
    if (!usedDispositions.has(d.match.source)) {
      out[`trigger disposition: ${d.match.source.slice(0, 40)}`] =
        'STALE — no row in §15.6 matches this disposition';
    }
  }
  out['E. trigger rows in §15.6'] = triggers.length;
  out['E. triggers UNDISPOSED'] = undisposed;
  // The per-class breakdown is computed rather than counted by hand, because
  // §15.6's prose carried one and it was wrong: it read "Twelve rows, twelve
  // dispositions: five computed, three fail closed, four manual" while this
  // census was already reporting thirteen. That is `docs/README.md` rule 1
  // applied to a tally instead of a filename — the same defect the directory
  // listing note calls out — and the fix is the same one this file exists to
  // apply everywhere else: compute it, freeze it, and let the prose point here
  // instead of restating it.
  for (const cls of ['COMPUTED', 'FAILS-CLOSED', 'MANUAL']) {
    out[`E. dispositions ${cls}`] = triggers.filter((t) => {
      const hit = TRIGGER_DISPOSITION.find((d) => d.match.test(t));
      return hit?.verdict.startsWith(cls);
    }).length;
  }

  // --- F. Retaining members -> binding-balance containers -------------------
  //
  // The universe nothing scored until August 6, 2026, because nothing could
  // read it: the binding's own bookkeeping had no diagnostic accessor, so the
  // question "does this container return to baseline" had no way to be asked at
  // all (`CORRECTNESS.md` §15.10). `info().bindingRefs` is that accessor and
  // `tools/binding-balance` is the search; this scores whether the search's
  // ruling covers every member the rule finds.
  //
  // A container declared in `policy.mjs` but absent from the computed universe
  // is reported as coverage *beyond* it rather than as staleness — see
  // `retainingMembers` on the two name-holding containers a type-directed scan
  // cannot derive. Reporting them as STALE would push whoever saw it to delete
  // real coverage to satisfy a rule that admits it cannot see them.
  const retaining = retainingMembers(read('src/lua-native.h'));
  const containerCover = new Map();
  for (const c of CONTAINERS) {
    for (const mem of c.members) {
      containerCover.set(mem, [...(containerCover.get(mem) ?? []), c.field]);
    }
  }
  for (const [k, v] of containerCover) containerCover.set(k, v.join(', '));
  const beyond = [...containerCover.keys()].filter((m) => !retaining.includes(m));
  const inUniverse = new Map([...containerCover].filter(([m]) => retaining.includes(m)));
  const retainUnclassified = score(retaining, inUniverse, NOT_COUNTED, out, 'retains: ');
  for (const m of beyond.sort()) {
    out[`retains: ${m}`] = `COVERED BEYOND THE COMPUTED UNIVERSE: ${containerCover.get(m)} `
      + '— holds names of references held elsewhere, which no type-directed scan derives';
  }
  out['F. retaining members'] = retaining.length;
  out['F. binding-balance containers'] = CONTAINERS.length;
  out['F. members covered beyond the universe'] = beyond.length;
  out['F. retaining members UNCLASSIFIED'] = retainUnclassified;

  return out;
}
