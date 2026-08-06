// Axis B — the doors whose behaviour depends on the configuration.
//
// Two families, because they fail in two different ways.
//
// **Family 1: host entry points that need a library.** The property is the one
// `LIMITATIONS.md` §8 names — an entry point must either *work* or *refuse
// loudly*. The third outcome, **accept-and-retain** (return normally, keep the
// argument, and do nothing observable), is the defect: it is a plausible answer
// rather than an error, which is exactly §15.1's clause three. CR-23 fixed one
// member of this class on `set_read_handler` and checked its siblings **by
// hand**; this is that check, run.
//
// Each door therefore states how to *observe its effect* rather than only how to
// call it. "Report the value, not just survival" (tools/README.md): a call that
// returns and a call that worked are the same row unless the cell looks.
//
// **Family 2: the bytecode doors.** Every way a binary chunk can enter the VM.
// The property is an implication rather than a fixed expectation — a door must
// refuse iff the config has the guard on — so the same nine rows are meaningful
// in every column, including the ones where the guard is off and loading is
// correct.

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A scratch directory shared by the file-shaped doors. Created once per run.
export const SCRATCH = mkdtempSync(join(tmpdir(), 'capability-matrix-'));

export function seedScratch(bytecode) {
  writeFileSync(join(SCRATCH, 'textmod.lua'), 'return { tag = "TEXT" }');
  writeFileSync(join(SCRATCH, 'plain.lua'), 'return "PLAIN"');
  writeFileSync(join(SCRATCH, 'binmod.lua'), bytecode);   // .lua name, bytecode content
  writeFileSync(join(SCRATCH, 'chunk.luac'), bytecode);
}

const q = (s) => JSON.stringify(s);

// --- Family 1 ---------------------------------------------------------------
//
// `call` performs the entry point. `observe` returns true iff the effect is
// visible from Lua. A door that throws is REFUSED; one that returns with
// `observe` false is ACCEPT-AND-RETAIN.
export const ENTRY_POINTS = [
  {
    id: 'register_module',
    needs: 'package',
    call: (lua) => lua.register_module('capmod', { tag: 'MOD' }),
    observe: (lua) => lua.execute_script('return require("capmod").tag') === 'MOD',
  },
  {
    id: 'add_search_path',
    needs: 'package',
    call: (lua) => lua.add_search_path(join(SCRATCH, '?.lua')),
    observe: (lua) => lua.execute_script('return require("textmod").tag') === 'TEXT',
  },
  {
    id: 'add_searcher',
    needs: 'package',
    call: (lua) => lua.add_searcher((name) => (name === 'dyn' ? 'return { tag = "DYN" }' : null)),
    observe: (lua) => lua.execute_script('return require("dyn").tag') === 'DYN',
  },
  {
    id: 'set_read_handler',
    // Needs no library: it synthesizes a minimal `io` holding `read` alone when
    // one is absent (CR-23). That grant is the behaviour under test.
    needs: null,
    call: (lua) => lua.set_read_handler(() => 'LINE'),
    observe: (lua) => lua.execute_script('return io.read()') === 'LINE',
  },
  {
    id: 'set_file_reader',
    // Also installs its own `dofile`/`loadfile`, so it grants doors a sealed
    // preset had cleared. Bounded to the reader; ledgered in run.mjs.
    needs: null,
    call: (lua) => lua.set_file_reader((p) => (p === 'v.lua' ? 'return "VIRT"' : null)),
    observe: (lua) => lua.execute_script('return dofile("v.lua")') === 'VIRT',
  },
  {
    id: 'set_print_handler',
    needs: 'base',
    call: (lua) => { lua.__lines = []; lua.set_print_handler((t) => lua.__lines.push(t)); },
    observe: (lua) => {
      lua.execute_script('print("x")');
      return lua.__lines.length > 0;
    },
  },
  {
    id: 'set_global',
    needs: null,   // control: works in every configuration
    call: (lua) => lua.set_global('capvar', 7),
    observe: (lua) => lua.execute_script('return capvar') === 7,
  },
  {
    id: 'register_class',
    needs: null,   // control: no library dependency
    call: (lua) => lua.register_class('Cap', { construct: () => ({}), methods: { v: () => 3 } }),
    observe: (lua) => lua.execute_script('return Cap.new():v()') === 3,
  },
];

// --- Family 2 ---------------------------------------------------------------
//
// `run` returns 'LOADED' or 'REFUSED'; anything else is a harness fault and is
// reported as such rather than scored. `precondition` marks a door that cannot
// exist in a configuration (no `dofile` under `sandbox`), which is ABSENT — a
// distinct outcome from a refusal, because a door that is gone proves nothing
// about the guard.
export const BYTECODE_DOORS = [
  {
    id: 'load_bytecode',
    precondition: () => true,
    run: (lua, bc) => { try { lua.load_bytecode(bc); return 'LOADED'; } catch { return 'REFUSED'; } },
  },
  {
    id: 'execute_file',
    precondition: () => true,
    run: (lua) => { try { lua.execute_file(join(SCRATCH, 'chunk.luac')); return 'LOADED'; } catch { return 'REFUSED'; } },
  },
  {
    id: 'compile_file',
    precondition: () => true,
    run: (lua) => { try { lua.compile_file(join(SCRATCH, 'chunk.luac')); return 'LOADED'; } catch { return 'REFUSED'; } },
  },
  {
    id: 'lua:load',
    precondition: (lua) => lua.execute_script('return load ~= nil and string ~= nil'),
    run: (lua) => lua.execute_script(
      'local f = load(string.dump(function() return 1 end)); return f == nil and "REFUSED" or "LOADED"'),
  },
  {
    id: 'lua:loadfile',
    precondition: (lua) => lua.execute_script('return loadfile ~= nil'),
    run: (lua) => lua.execute_script(
      `local f = loadfile(${q(join(SCRATCH, 'chunk.luac'))}); return f == nil and "REFUSED" or "LOADED"`),
  },
  {
    id: 'lua:dofile',
    precondition: (lua) => lua.execute_script('return dofile ~= nil'),
    run: (lua) => lua.execute_script(
      `local ok = pcall(dofile, ${q(join(SCRATCH, 'chunk.luac'))}); return ok and "LOADED" or "REFUSED"`),
  },
  {
    id: 'lua:require-package-path',
    precondition: (lua) => lua.execute_script('return package ~= nil'),
    run: (lua) => lua.execute_script(
      `package.path = ${q(join(SCRATCH, '?.lua'))}
       local ok = pcall(require, "binmod"); return ok and "LOADED" or "REFUSED"`),
  },
  {
    id: 'host:add_search_path+require',
    precondition: (lua) => lua.execute_script('return package ~= nil'),
    run: (lua) => {
      lua.add_search_path(join(SCRATCH, '?.lua'));
      return lua.execute_script('local ok = pcall(require, "binmod"); return ok and "LOADED" or "REFUSED"');
    },
  },
  // The last two are **always** text-only, in every configuration, and are not
  // governed by the guard at all: `LoadFromReader` and `JsSearcher` both pass a
  // hardcoded "t" so that a host-supplied channel can never be the way bytecode
  // arrives (FEATURES.md, "Source only"). They are listed here because that is
  // a documented promise worth pinning, and `alwaysRefuses` says so rather than
  // letting them read as guard coverage they do not provide.
  //
  // The harness's first run scored them as defects in four columns — the
  // implication "refuses iff the guard is on" was the harness's model, not the
  // product's contract. Driving them to a reproduction showed the dirt was
  // here, which is the rule that caught ten of these before it.
  {
    id: 'file_reader-returns-bytecode',
    alwaysRefuses: true,
    // `pcall` lives in base: under a bare state there is nothing to run the
    // probe with, and the door is genuinely unreachable rather than refusing.
    precondition: (lua) => lua.execute_script('return pcall ~= nil'),
    run: (lua, bc) => {
      lua.set_file_reader(() => Buffer.from(bc).toString('latin1'));
      return lua.execute_script('local ok = pcall(dofile, "x.lua"); return ok and "LOADED" or "REFUSED"');
    },
  },
  {
    id: 'searcher-returns-bytecode',
    alwaysRefuses: true,
    precondition: (lua) => lua.execute_script('return package ~= nil and pcall ~= nil'),
    run: (lua, bc) => {
      lua.add_searcher(() => Buffer.from(bc).toString('latin1'));
      return lua.execute_script('local ok = pcall(require, "bcmod"); return ok and "LOADED" or "REFUSED"');
    },
  },
];
