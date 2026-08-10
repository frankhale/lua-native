// CR-18 exception-escape matrix: one cell, one process.
//
//   node tools/exception-matrix/cell.mjs <frameId> <kindId>
//
// Prints one JSON object on the line after `##CR18##`. The process exiting at
// all is half the result: the failure mode this matrix exists for is
// `std::terminate`, which no in-process assertion can report.
//
// The other half is the *value*. A swallowed exception is indistinguishable
// from success unless the cell checks what actually happened, and a silently
// dropped error is the same class of defect as a wrong return value — the code
// lying rather than crashing. So every cell records what the trigger did, what
// it surfaced, whether the marker ever appeared, and whether repeating the
// operation strands anything.

import lua_native from '../../index.js';
import { FRAMES } from './frames.mjs';
import { KINDS, MARKER } from './kinds.mjs';

const [frameId, kindId] = process.argv.slice(2);
const frame = FRAMES.find((f) => f.id === frameId);
const kind = KINDS.find((k) => k.id === kindId);
if (!frame || !kind) {
  console.error(`unknown frame/kind: ${frameId} / ${kindId}`);
  process.exit(2);
}

const REPEATS = 12;

// Control switches. These exist so `run.mjs --control` can make the harness
// produce each bad status on demand: a search that reports clean is only worth
// anything once it has been shown able to report dirty (CR-17). They are inert
// unless explicitly passed, and no matrix cell passes them.
const FORCE_ABORT = process.argv.includes('--force-abort');
const FORCE_SWALLOW = process.argv.includes('--force-swallow');
const FORCE_DEAD_CONTEXT = process.argv.includes('--force-dead-context');

const result = {
  frame: frameId,
  kind: kindId,
  status: 'UNKNOWN',
  armError: null,
  installError: null,
  triggerOutcome: null,
  surfaced: null,
  sawMarker: false,
  contextUsable: null,
  contextProbe: null,
  memBefore: null,
  memAfter: null,
  memGrowthPerIteration: null,
  repeats: 0,
  reinstalls: 0,
  strandednessScope: null,
  externalBefore: null,
  externalAfter: null,
  actCalls: 0,
  notes: [],
};

const describe = (v) => {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'object') {
    try { return JSON.stringify(v).slice(0, 400); } catch { return Object.prototype.toString.call(v); }
  }
  return String(v).slice(0, 400);
};

// Whether the failure *surfaced*, which is the question a swallowed exception
// has to be caught by — and it is not the same question as "did something
// throw".
//
// Two corrections the first run forced, both of which had inflated the
// swallowed count with harness noise rather than defects:
//
//   1. Not every kind's failure carries the marker. A returned Symbol surfaces
//      as the addon's own "Cannot convert a JavaScript Symbol to a Lua value",
//      which is the correct message and contains nothing of the caller's. So
//      each kind declares the signature a correct surfacing has, and the marker
//      is only the signature for the kinds that actually throw one.
//   2. The evidence can be nested. Lua's `load()` returns `nil, err`, so the
//      error arrives as an element of a returned array with the marker down in
//      `.stack`. A top-level String() of that array is "[object Object]".
//
// Every read is contained, because reading `.message` is itself one of the
// throw kinds.
const SIGNATURE = kind.signature ?? new RegExp(MARKER);

const collectText = (v, depth = 0, seen = new Set()) => {
  const out = [];
  if (depth > 6) return out;
  try { out.push(String(v)); } catch { /* toString threw */ }
  if (v && (typeof v === 'object' || typeof v === 'function')) {
    if (seen.has(v)) return out;
    seen.add(v);
    for (const k of ['message', 'stack', 'name', 'error', 'value', 'status', 'cause']) {
      try { if (k in v) out.push(...collectText(v[k], depth + 1, seen)); } catch { /* getter threw */ }
    }
    if (Array.isArray(v)) {
      for (const el of v.slice(0, 20)) out.push(...collectText(el, depth + 1, seen));
    }
  }
  return out;
};

const surfacedFailure = (v) => collectText(v).some((p) => typeof p === 'string' && SIGNATURE.test(p));

function makeContext() {
  return new lua_native.init({}, { libraries: 'all', ...(kind.options ?? {}) });
}

async function run() {
  let lua = makeContext();

  // The act: the callback body Axis A supplies, bound to this context.
  //
  // Counted, and the count is load-bearing. A frame whose `install` does not
  // actually put the callback anywhere the addon will reach reports every kind
  // as SWALLOWED — the exception never surfaced because it was never raised —
  // and eleven such cells look exactly like a serious finding. The first run of
  // this matrix produced two such frames (`from_lua_converter` triggered with
  // `return 42`, which converters never see, since they are consulted only for
  // object-valued results). CR-17's rule, per cell: prove the thing you are
  // measuring actually happened before believing what you measured about it.
  const act = (...args) => { result.actCalls++; return kind.act(lua, ...args); };

  if (kind.arm) {
    try {
      kind.arm(lua);
    } catch (e) {
      result.armError = describe(e);
      result.status = 'NOT_APPLICABLE';
      result.notes.push('arming the throw kind failed before the frame was reached');
      return;
    }
  }

  try {
    frame.install(lua, act);
  } catch (e) {
    result.installError = describe(e);
    result.status = 'NOT_APPLICABLE';
    result.notes.push('installing the callback at this frame failed');
    return;
  }

  result.memBefore = lua.get_memory_usage();
  const extBefore = process.memoryUsage().external;

  if (FORCE_ABORT) {
    // Kill the process the way `std::terminate` does, mid-cell, with no JSON
    // written. If the runner scores this as anything but ABORTED it cannot see
    // the failure mode the matrix exists for.
    //
    // `process.abort()`, not `process.kill(process.pid, 'SIGABRT')`: Windows has
    // no POSIX signals, and libuv's `uv_kill` honours only SIGTERM/SIGKILL/SIGINT
    // there — SIGABRT raises EINVAL, so the cell survived its own control, wrote
    // its JSON and was scored HARNESS_ERROR. The control failed closed, which is
    // the design working, but it made the whole matrix unrunnable on Windows.
    // `abort()` is what the comment above always meant, and it is portable.
    process.abort();  // does not return
  }

  try {
    if (FORCE_SWALLOW) throw new Error('a contained error that never mentions the marker');
    const out = frame.takesAct ? frame.trigger(lua, act) : frame.trigger(lua);
    const value = frame.isAsync ? await out : out;
    result.triggerOutcome = 'returned';
    result.surfaced = describe(value);
    // A pcall-shaped or resume-shaped result reports its own failure rather
    // than throwing; that counts as surfacing, and is why the value is read
    // rather than only the control flow.
    result.sawMarker = surfacedFailure(value);
  } catch (e) {
    result.triggerOutcome = 'threw';
    result.surfaced = describe(e);
    result.sawMarker = surfacedFailure(e);
  }

  // Is the context still usable? The CR-6 assertion: a contained failure leaves
  // a working context behind.
  try {
    if (FORCE_DEAD_CONTEXT) throw new Error('control: context deliberately reported unusable');
    const probe = lua.execute_script('return 6 * 7');
    result.contextUsable = probe === 42;
    result.contextProbe = describe(probe);
  } catch (e) {
    result.contextUsable = false;
    result.contextProbe = describe(e);
  }

  // Strandedness: repeat the whole install+trigger and watch what accumulates.
  //
  // Two corrections from CR-19 F4, both about the assertion being narrower than
  // its wording:
  //
  //   * **The Lua heap is not the heap in question.** What CR-6 F1 was actually
  //     about is a stranded `js_userdata_` / `js_callbacks_` / `host_functions_`
  //     entry — C++ maps, invisible to `get_memory_usage()`. A registration also
  //     mints a Lua closure, so part of it shows, but the map entry never did.
  //     `process.memoryUsage().external` is a coarse second signal that at least
  //     moves when the C++ side grows.
  //   * **The install half was silently a no-op for three frames.** The
  //     `class_*` frames re-register the same class name, which is refused after
  //     the first iteration, so iterations 2..N exercised the trigger against the
  //     original registration and never re-entered the registration path — the
  //     path most likely to strand anything. A cell whose re-install fails now
  //     says so instead of reporting a number for a sentence it did not measure.
  if (result.contextUsable) {
    let done = 0;
    let reinstalled = 0;
    for (let i = 0; i < REPEATS; i++) {
      try {
        frame.install(lua, act);
        reinstalled++;
      } catch { /* the frame refuses re-installation; recorded below */ }
      try {
        const out = frame.takesAct ? frame.trigger(lua, act) : frame.trigger(lua);
        if (frame.isAsync) await out;
      } catch { /* expected */ }
      done++;
    }
    result.repeats = done;
    result.reinstalls = reinstalled;
    result.strandednessScope = reinstalled === done ? 'install+trigger' : 'trigger-only';
    result.externalBefore = extBefore;
    result.externalAfter = process.memoryUsage().external;
    try {
      lua.gc('collect');
      lua.gc('collect');
      result.memAfter = lua.get_memory_usage();
      if (result.memBefore > 0 && done > 0) {
        result.memGrowthPerIteration = Math.round((result.memAfter - result.memBefore) / done);
      }
    } catch (e) {
      result.notes.push(`post-repeat gc/memory read failed: ${describe(e)}`);
    }
  }

  // Drop the context and collect, so a finalizer-time fault surfaces as a
  // non-zero exit rather than being missed. CR-17's teardown segfault only
  // manifested when the process exited with the handle still alive.
  lua = null;
  if (global.gc) { global.gc(); global.gc(); }

  if (result.contextUsable === false) result.status = 'CONTEXT_DEAD';
  else if (result.actCalls === 0) result.status = 'VACUOUS';
  else if (!result.sawMarker) result.status = 'SWALLOWED';
  else result.status = 'CLEAN';
}

run().then(
  () => {
    console.log('##CR18##');
    console.log(JSON.stringify(result));
  },
  (e) => {
    result.status = 'HARNESS_ERROR';
    result.notes.push(describe(e));
    console.log('##CR18##');
    console.log(JSON.stringify(result));
  },
);
