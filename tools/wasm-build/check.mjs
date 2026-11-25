// node tools/wasm-build/check.mjs <debug|release>
//
// What `run.mjs` runs against its own output. It answers three questions the
// build's exit code cannot:
//
//   1. Is the core really in there, with Lua errors and C++ exceptions crossing
//      frames the way they do natively? (The stock `liblua.a` links under one
//      exception mode and gets this wrong — plan §2.3, cell A.)
//   2. Is the stack large enough? The WASM stack cannot grow and, in a release
//      build, overflows without a word. Lua bounds C-level nesting itself, so
//      each stack cell builds the deepest chain of one kind a script can and
//      requires **Lua's own refusal** — not a trap, and not a quiet success
//      that never got deep. A cell that returns without reaching the limit has
//      measured nothing and fails as vacuous.
//   3. Is each variant what it claims to be? The node variant must read a real
//      file; the web variant must contain no Node imports.
//   4. When the JavaScript engine's own stack runs out while Lua is running,
//      does that fail closed? (The exhaustion cells, further down; nothing
//      inside the module can catch that, so the shell has to.)
//
// The node variant is executed. **The web variant is not** — Node cannot load
// a module built for `web,worker` — so for it this checks only that the
// `.wasm` compiles and the glue asks for nothing from Node. Running it is
// Phase 4's browser smoke set.
//
// One process per cell: a stack overflow leaves a module unusable, and the
// cells after it would otherwise report the first one's damage as their own.
//
// The dirty control for the stack cells is a build:
//   node tools/wasm-build/run.mjs debug --stack-size=65536
// fails them, which is how the shipped size was chosen (plan §2.4).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { EMSCRIPTEN_VERSION, REPO } from './toolchain.mjs';

const SELF = url.fileURLToPath(import.meta.url);
const FIXTURE = path.join(REPO, 'tests', 'fixtures');

// A stack cell returns `reached` (did Lua itself stop the recursion?), the
// depth it got to, and the message. `floor` is the least depth that counts as
// having gone deep; each is well under what the cell reaches, and exists only
// to catch a cell that stopped for some unrelated reason near the top.
const STACK_CELLS = {
  'stack: string.gsub callback': {
    floor: 100,
    script: `
      local depth = 0
      local function f() depth = depth + 1; return (string.gsub("x", "x", f)) end
      local ok, e = pcall(f)
      return ok, depth, tostring(e)`,
  },
  // Lua -> JS callback -> Lua function held by JS -> Lua: the deepest chain
  // there is, since every level adds the binding's frames and JavaScript's.
  'stack: JS callback re-entering Lua': {
    floor: 50,
    script: `
      local depth = 0
      local function f() depth = depth + 1; return reenter(f) end
      local ok, e = pcall(f)
      return ok, depth, type(e) == "table" and e.message or tostring(e)`,
  },
  'stack: __index metamethod chain': {
    floor: 100,
    script: `
      local depth = 0
      local mt = {}
      mt.__index = function(t, k) depth = depth + 1; return setmetatable({}, mt)[k] end
      local ok, e = pcall(function() return setmetatable({}, mt).x end)
      return ok, depth, tostring(e)`,
  },
  'stack: table.sort comparator': {
    floor: 50,
    script: `
      local depth = 0
      local function cmp(a, b) depth = depth + 1; table.sort({3, 1, 2}, cmp); return a < b end
      local ok, e = pcall(table.sort, {3, 1, 2}, cmp)
      return ok, depth, tostring(e)`,
  },
  'stack: nested coroutine.wrap': {
    floor: 100,
    script: `
      local depth = 0
      local function f() depth = depth + 1; return coroutine.wrap(f)() end
      local ok, e = pcall(f)
      return ok, depth, tostring(e)`,
  },
  'stack: traceback built at the limit': {
    floor: 100,
    script: `
      local depth = 0
      local function f() depth = depth + 1; return (string.gsub("x", "x", f)) end
      local ok, e = xpcall(f, debug.traceback)
      return ok, depth, tostring(e)`,
  },
  'stack: parser nesting past the limit': {
    floor: 0,
    script: `
      local chunk, e = load("return " .. string.rep("(", 400) .. "1" .. string.rep(")", 400))
      return chunk ~= nil, 400, tostring(e)`,
  },
};

// The cells run against the public API of the module the build produced —
// `init`, `execute_script`, a JS callback, a Lua function called from JS. Until
// slice 2 they ran against a probe compiled into the module, which measured the
// core alone; these measure the chain a caller actually builds, with the
// binding's frames and the JavaScript frames between the Lua ones.
const reenter = (f) => {
  if (typeof f !== 'function') throw new Error('reenter: expected a function');
  return f();
};

const run = (lua, script) => {
  try {
    return { ok: true, value: lua.execute_script(script) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
};

// The stack cells ask about the WASM stack, so the engine's own must not be
// what stops them: a debug build's frames are large enough that Node's default
// runs out at about depth 127 of the JS-callback chain, well short of Lua's
// limit. The exhaustion cells below ask the other question.
const STACK_CELL_NODE_ARGS = ['--stack-size=3000'];
const CELL_NODE_ARGS = {};

const CELLS = {
  // `run.mjs` refuses to build with any Emscripten but the pinned one, so what
  // is left to check here is that the module answers at all and is the Lua it
  // should be — asked of the script and of `info()`, which must agree.
  'the module loads and is Lua 5.5': lua => {
    const r = run(lua, 'return _VERSION');
    const info = lua.info();
    const ok = r.ok && r.value === 'Lua 5.5' && info.version === 'Lua 5.5' &&
      info.versionNumber === 505 && /^Lua 5\.5\.\d+$/.test(info.release);
    return { ok, detail: `${JSON.stringify(r)}; info: ${info.release}, ${info.versionNumber}; built with emscripten ${EMSCRIPTEN_VERSION}` };
  },
  'values out of Lua': lua => {
    const r = run(lua, 'return 1 + 1, "s", 3 // 2, true');
    return { ok: r.ok && JSON.stringify(r.value) === '[2,"s",1,true]', detail: JSON.stringify(r) };
  },
  'a Lua error crosses the core': lua => {
    const r = run(lua, 'error("lua boom")');
    // Anchored on the position prefix: the chunk name quotes the script, so a
    // bare /lua boom/ also matches a failure to find `error` at all.
    return { ok: !r.ok && /:1: lua boom/.test(r.error), detail: JSON.stringify(r) };
  },
  'a host-function throw is seen by pcall': lua => {
    // A JS throw arrives in Lua as a table carrying `.message`, as it does natively.
    const r = run(lua, 'local ok, e = pcall(reenter, 1); return ok, type(e) == "table" and e.message or tostring(e)');
    return { ok: r.ok && r.value[0] === false && /expected a function/.test(r.value[1]), detail: JSON.stringify(r) };
  },
  'a Lua error crosses a host frame and is seen by pcall': lua => {
    const r = run(lua, 'local ok, e = pcall(reenter, function() error("inner") end); return ok, type(e) == "table" and e.message or tostring(e)');
    return { ok: r.ok && r.value[0] === false && /inner/.test(r.value[1]), detail: JSON.stringify(r) };
  },
  'the context survives an error': lua => {
    run(lua, 'error("first")');
    const r = run(lua, 'return "still here"');
    return { ok: r.ok && r.value === 'still here', detail: JSON.stringify(r) };
  },
  'node variant reads the real disk': lua => {
    const file = fs.readdirSync(FIXTURE).filter(f => f.endsWith('.lua')).sort()[0];
    const full = path.join(FIXTURE, file);
    const r = run(lua, `local f = assert(io.open(${JSON.stringify(full)}, "rb")); local s = f:read("a"); f:close(); return #s`);
    const expected = fs.statSync(full).size;
    return { ok: r.ok && r.value === expected, detail: `${file}: ${JSON.stringify(r)}, expected ${expected} bytes` };
  },
};

for (const [name, { script, floor }] of Object.entries(STACK_CELLS)) {
  CELL_NODE_ARGS[name] = STACK_CELL_NODE_ARGS;
  CELLS[name] = lua => {
    const r = run(lua, script);
    if (!r.ok) return { ok: false, detail: `the script failed: ${r.error.slice(0, 160)}` };
    // Every stack script returns exactly three values. Anything else is not a
    // Lua answer at all: a release build has no overflow check, and at 128 KiB
    // this is what the overflow looked like — a normal return, wrong contents.
    if (!Array.isArray(r.value) || r.value.length !== 3) {
      return { ok: false, detail: `WRONG ANSWER — the script returns 3 values and this is not them (${JSON.stringify(r.value)?.slice(0, 80)}); an unchecked stack overflow looks like this` };
    }
    const [ok, depth, message] = r.value;
    const reached = ok === false && typeof message === 'string' && /overflow/.test(message);
    if (!reached) return { ok: false, detail: `VACUOUS — Lua did not refuse (ok=${ok}, depth ${depth}): ${String(message).slice(0, 120)}` };
    if (depth < floor) return { ok: false, detail: `VACUOUS — stopped at depth ${depth}, under the floor of ${floor}: ${message.slice(0, 120)}` };
    return { ok: true, detail: `Lua refused at depth ${depth}: ${message.split('\n')[0].slice(0, 80)}` };
  };
}

// --- JavaScript stack exhaustion ----------------------------------------------
//
// The other stack: the engine's own. A chain of JS and Lua calling each other
// runs out of *it* long before Lua's limit when the engine's stack is small or
// the JS frames are large, and on this target that is not the routine event it
// is natively. A `RangeError` raised above Lua's frames cannot be stopped by
// C++ (`catch (...)` does not catch a JavaScript exception here) and Lua's
// protected calls do not see it, so it unwinds them without their bookkeeping.
// What the binding owes the caller is that this **fails closed**: an error,
// never a raw `WebAssembly.Exception` and never a wrong answer; a context that
// afterwards either works or says it cannot be used; and a module that other
// contexts can go on using.
//
// Each cell runs one scenario at one engine stack size, which is what moves
// the point of exhaustion around: into user JS, into the glue, into Lua.
//
// Dirty control: these were written against the build as it stood before the
// shell guarded its entry points (November 24, 2026). That build failed every
// "mutual recursion" cell, at every stack size, with a raw
// `WebAssembly.Exception` — Lua jumping to a handler in a frame that no longer
// existed.
const EXHAUSTION_STACK_KB = [200, 300, 400, 500, 600, 700, 800];
const UNWOUND = /can no longer be used/;

const classify = (error) => {
  if (error instanceof WebAssembly.Exception) return 'RAW WebAssembly.Exception';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof Error && UNWOUND.test(error.message)) return 'refused as unwound';
  if (error instanceof Error && /Maximum call stack size exceeded/.test(error.message)) return 'Lua error carrying the RangeError';
  return `UNEXPECTED ${Object.prototype.toString.call(error)}: ${String(error?.message ?? error).slice(0, 80)}`;
};

// After the event: the context that was running, and one that was not.
const aftermath = (module, lua) => {
  const notes = [];
  let ok = true;
  try {
    const v = lua.execute_script('return 6 * 7');
    if (v !== 42) { ok = false; notes.push(`same context answered ${JSON.stringify(v)} for 6 * 7`); }
    else notes.push('same context still works');
  } catch (error) {
    const kind = classify(error);
    if (kind !== 'refused as unwound') { ok = false; notes.push(`same context then threw ${kind}`); }
    else notes.push('same context refuses');
  }
  // A fresh context, made to go deep: a module whose stack pointer was left
  // where the unwinding found it has less stack than it thinks.
  try {
    const fresh = new module.init({}, { libraries: 'all' });
    const r = fresh.execute_script(STACK_CELLS['stack: string.gsub callback'].script);
    const fine = Array.isArray(r) && r.length === 3 && r[0] === false && r[1] >= 100 && /overflow/.test(r[2]);
    if (!fine) { ok = false; notes.push(`a fresh context got ${JSON.stringify(r)?.slice(0, 80)} from the gsub chain`); }
    else notes.push('a fresh context goes deep');
  } catch (error) {
    ok = false;
    notes.push(`a fresh context threw ${classify(error)}`);
  }
  return { ok, notes };
};

const REENTER_SCRIPT = `
  local depth = 0
  local function f() depth = depth + 1; return reenter(f) end
  local ok, e = pcall(f)
  return ok, depth, type(e) == "table" and e.message or tostring(e)`;

const EXHAUSTION = {
  // Lua and JS calling each other until something gives.
  'mutual recursion': (module) => {
    const lua = new module.init({ reenter }, { libraries: 'all' });
    let outcome;
    let ok = true;
    try {
      const r = lua.execute_script(REENTER_SCRIPT);
      const shaped = Array.isArray(r) && r.length === 3 && r[0] === false && typeof r[2] === 'string';
      if (shaped && /overflow/.test(r[2])) outcome = `Lua refused at depth ${r[1]}`;
      else if (shaped && /Maximum call stack size exceeded/.test(r[2])) outcome = `pcall saw the RangeError at depth ${r[1]}`;
      else if (shaped && UNWOUND.test(r[2])) outcome = `pcall saw the refusal at depth ${r[1]}`;
      else { ok = false; outcome = `WRONG ANSWER ${JSON.stringify(r)?.slice(0, 100)}`; }
    } catch (error) {
      outcome = `threw ${classify(error)}`;
      ok = !/RAW|UNEXPECTED/.test(outcome);
    }
    const after = aftermath(module, lua);
    return { ok: ok && after.ok, detail: [outcome, ...after.notes].join('; ') };
  },
  // The same, with a JS callback that swallows whatever its callee threw, so
  // Lua carries on running after the event.
  'mutual recursion, error swallowed in JS': (module) => {
    let swallowed = 0;
    const lua = new module.init({
      reenter: (f) => { try { return f(); } catch { swallowed++; return 'swallowed'; } },
    }, { libraries: 'all' });
    let outcome;
    let ok = true;
    try {
      const r = lua.execute_script(REENTER_SCRIPT);
      // Lua's own limit raises through the JS frame as an error and is
      // swallowed like any other, so the chain returns the marker.
      const shaped = Array.isArray(r) && r.length === 3 && r[0] === true && r[2] === 'swallowed';
      if (shaped) outcome = `returned after ${swallowed} swallowed error(s), depth ${r[1]}`;
      else { ok = false; outcome = `WRONG ANSWER ${JSON.stringify(r)?.slice(0, 100)}`; }
    } catch (error) {
      outcome = `threw ${classify(error)}`;
      ok = !/RAW|UNEXPECTED/.test(outcome);
    }
    const after = aftermath(module, lua);
    return { ok: ok && after.ok, detail: [outcome, ...after.notes].join('; ') };
  },
  // Lua recursing through C on its own, with an engine stack too small for it
  // to reach Lua's limit — twelve times, each in a context of its own. No JS
  // is involved, so the engine's check fires inside WASM and the frames go
  // without so much as a destructor; the module's stack pointer is left where
  // they were. Unrepaired, each run costs the module that much stack for good:
  // measured at 150 KB, 150,384 bytes a run, and the seventh run aborted the
  // module for every context in it. (Control: with the shell's `stackRestore`
  // call removed, this cell fails and no other does.)
  'Lua recursing alone, repeated': {
    sizes: [80, 100, 150],
    body: (module) => {
      const kinds = {};
      for (let i = 0; i < 12; i++) {
        let kind;
        try {
          const lua = new module.init({}, { libraries: 'all' });
          const r = lua.execute_script(STACK_CELLS['stack: string.gsub callback'].script);
          kind = Array.isArray(r) && r.length === 3 && r[0] === false && /overflow/.test(r[2])
            ? 'Lua refused' : `WRONG ANSWER ${JSON.stringify(r)?.slice(0, 60)}`;
        } catch (error) {
          kind = classify(error);
        }
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      }
      const tally = Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ');
      const bad = Object.keys(kinds).find(k => /RAW|UNEXPECTED|WRONG/.test(k));
      if (!bad && !kinds.RangeError) return { ok: false, detail: `VACUOUS — the engine stack never ran out: ${tally}` };
      // The module must still answer, from a context that was not involved.
      let fresh;
      try {
        fresh = new module.init({}, { libraries: 'all' }).execute_script('return 6 * 7');
      } catch (error) {
        fresh = classify(error);
      }
      return { ok: !bad && fresh === 42, detail: `12 runs: ${tally}; a fresh context answered ${JSON.stringify(fresh)}` };
    },
  },
  // JS recursing on its own to the limit, then calling into Lua from each of
  // the last frames on the way back out: the calls that start with almost no
  // stack, where the engine's check fires inside WASM itself.
  'calls made from the edge of the JS stack': (module) => {
    const lua = new module.init({}, { libraries: 'all' });
    // Forty levels of C-level recursion, so the call needs real stack.
    const script = `
      local function f(n)
        if n == 0 then return 0 end
        local r
        string.gsub("x", "x", function() r = f(n - 1) end)
        return r + 1
      end
      return f(40)`;
    // Nothing in the handler may call a function: at the edge that call is
    // itself the overflow, and the first draft of this cell recorded nothing
    // for exactly that reason. Outcomes are stored raw and classified after.
    const raw = new Array(600);
    let tries = 0;
    const dive = () => {
      try {
        dive();
      } catch (overflow) {
        if (tries < 600) {
          try { raw[tries] = { value: lua.execute_script(script) }; } catch (error) { raw[tries] = { error }; }
          tries++;
        }
        throw overflow;
      }
    };
    try { dive(); } catch { /* the RangeError that started the unwinding */ }
    const seen = {};
    for (let i = 0; i < tries; i++) {
      const kind = 'error' in raw[i]
        ? classify(raw[i].error)
        : (raw[i].value === 40 ? 'answered' : `WRONG ANSWER ${JSON.stringify(raw[i].value)?.slice(0, 40)}`);
      seen[kind] = (seen[kind] ?? 0) + 1;
    }
    const kinds = Object.keys(seen);
    const bad = kinds.find(k => /RAW|UNEXPECTED|WRONG/.test(k));
    const tally = Object.entries(seen).map(([k, n]) => `${n} ${k}`).join(', ');
    // A run in which every call failed, or none did, never had a call that
    // began near the edge and ran out partway.
    if (!bad && kinds.length < 2) {
      return { ok: false, detail: `VACUOUS — ${tries} calls, all alike: ${tally}` };
    }
    const after = aftermath(module, lua);
    return { ok: !bad && after.ok, detail: [`${tries} calls: ${tally}`, ...after.notes].join('; ') };
  },
};

for (const [scenario, spec] of Object.entries(EXHAUSTION)) {
  const body = typeof spec === 'function' ? spec : spec.body;
  for (const kb of spec.sizes ?? EXHAUSTION_STACK_KB) {
    const name = `exhaustion at ${kb} KB: ${scenario}`;
    CELL_NODE_ARGS[name] = [`--stack-size=${kb}`];
    CELLS[name] = (lua, module) => body(module);
  }
}

async function runCell(config, name) {
  const entry = path.join(REPO, 'build-wasm', config, 'node', 'lua-native.mjs');
  const module = (await import(url.pathToFileURL(entry).href)).default;
  return CELLS[name](new module.init({ reenter }, { libraries: 'all' }), module);
}

function checkWebVariant(config) {
  const dir = path.join(REPO, 'build-wasm', config, 'web');
  const glue = fs.readFileSync(path.join(dir, 'lua-native-core.mjs'), 'utf8');
  const nodeish = glue.match(/from\s*['"]node:[^'"]*['"]|createRequire|require\(\s*['"](?:node:)?(?:fs|path|module|url)['"]\s*\)/);
  const compiles = WebAssembly.validate(fs.readFileSync(path.join(dir, 'lua-native-core.wasm')));
  return [
    { name: 'web variant: the .wasm validates', ok: compiles, detail: compiles ? '' : 'WebAssembly.validate returned false' },
    { name: 'web variant: the glue asks for nothing from Node', ok: !nodeish, detail: nodeish ? `found ${nodeish[0]}` : '' },
    { name: 'web variant: shell copied', ok: fs.existsSync(path.join(dir, 'lua-native.mjs')), detail: '' },
  ];
}

function main() {
  const config = process.argv[2];
  if (config !== 'debug' && config !== 'release') {
    console.error('usage: node tools/wasm-build/check.mjs <debug|release>');
    process.exit(2);
  }

  const results = [];
  for (const name of Object.keys(CELLS)) {
    const child = spawnSync(process.execPath, [...(CELL_NODE_ARGS[name] ?? []), SELF, config, `--cell=${name}`], { encoding: 'utf8' });
    let result;
    try {
      result = JSON.parse(child.stdout.trim().split('\n').pop());
    } catch {
      // No verdict line: the cell's process died. On this target that is what
      // a stack overflow looks like, so say what the process said.
      const said = (child.stderr || child.stdout || '').trim().split('\n').filter(Boolean);
      result = { ok: false, detail: `process exited ${child.status ?? child.signal} with no verdict: ${(said.find(l => /overflow|Error|abort/i.test(l)) ?? said[0] ?? '').slice(0, 160)}` };
    }
    results.push({ name, ...result });
  }
  results.push(...checkWebVariant(config));

  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(failed
    ? `wasm-build check: ${failed} of ${results.length} FAILED (${config}).`
    : `wasm-build check: ${results.length} of ${results.length} pass (${config}; node variant executed, web variant validated but not executed).`);
  process.exit(failed ? 1 : 0);
}

const cellArg = process.argv.find(a => a.startsWith('--cell='));
if (cellArg) {
  const result = await runCell(process.argv[2], cellArg.slice('--cell='.length));
  console.log(JSON.stringify(result));
} else {
  main();
}
