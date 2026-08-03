// CR-18, Axis A: what the injected JavaScript does when the addon calls it.
//
// Each kind is a way for control to leave user JS abnormally. The matrix is
// about what happens to that abnormal exit while a Lua C frame is on the stack
// between it and the JS that started everything.
//
// `arm(lua)` runs once before the frame is triggered, for the kinds that need
// the Lua state prepared (a raising `_G` metamethod, a memory ceiling).
// `act(lua)` is the body spliced into whatever callback the frame installs.
// `options` is merged into the context's init options.

export const MARKER = 'PROBE-BOOM';

export const KINDS = [
  {
    id: 'throw_error',
    signature: /PROBE-BOOM(?!-)/,
    describe: 'throw new Error',
    act: () => { throw new Error(MARKER); },
  },
  {
    id: 'throw_string',
    signature: /PROBE-BOOM-string/,
    describe: 'throw a bare string (not an Error)',
    act: () => { throw `${MARKER}-string`; },
  },
  {
    id: 'throw_null',
    signature: /null|threw an exception|Error/i,
    describe: 'throw null',
    // A thrown null has no .message and no .name. Anything that reconstructs a
    // thrown value by reading properties off it meets an unusual shape here.
    act: () => { throw null; },
  },
  {
    id: 'throw_error_hostile_message',
    signature: /PROBE-BOOM-nested|outer|threw an exception|Error/i,
    describe: 'throw an Error whose .message getter throws',
    // CR-16 listed "a getter on a thrown Error's name" as an injection site.
    // Here it is a throw kind: the *second* exception is raised while the first
    // is being marshalled, which is the point at which a handler that is itself
    // unguarded turns a contained error into an escape.
    act: () => {
      const e = new Error('outer');
      Object.defineProperty(e, 'message', { get() { throw new Error(`${MARKER}-nested-message`); } });
      Object.defineProperty(e, 'name', { get() { throw new Error(`${MARKER}-nested-name`); } });
      throw e;
    },
  },
  {
    id: 'return_symbol',
    signature: /Symbol/i,
    describe: 'return a Symbol (unconvertible)',
    // Not a throw in JS; a throw raised by the addon's own conversion, on the
    // return path, with the Lua frame still on the stack.
    act: () => Symbol(MARKER),
  },
  {
    id: 'return_bigint_out_of_range',
    signature: /BigInt|out of range/i,
    describe: 'return a BigInt too large for a Lua integer',
    act: () => (1n << 200n),
  },
  {
    id: 'return_deep_object',
    signature: /nesting depth|depth exceeds|maximum of 100/i,
    describe: 'return an object nested past kMaxDepth',
    act: () => {
      let o = { leaf: 1 };
      for (let i = 0; i < 150; i++) o = { n: o };
      return o;
    },
  },
  {
    id: 'raise_g_metamethod',
    signature: /PROBE-BOOM-gmeta/,
    describe: 'call back into the context so a raising _G.__newindex fires',
    // The CR-6 F1 trigger, reached from inside a Lua C frame instead of from
    // top-level JS. The core raises a Lua error, RunProtected turns it into a
    // std::runtime_error, and that has to become a JS throw before it crosses
    // the frame.
    arm: (lua) => {
      lua.execute_script(`setmetatable(_G, { __newindex = function() error('${MARKER}-gmeta') end })`);
    },
    act: (lua) => { lua.set_global('probe_probe', 1); },
  },
  {
    id: 'errmem_oom',
    signature: /not enough memory|out of memory|memory/i,
    describe: 'exhaust maxMemory from inside the callback (ERRMEM longjmp)',
    options: { maxMemory: 2 * 1024 * 1024 },
    act: (lua) => {
      lua.execute_script("local t = {} for i = 1, 1e7 do t[i] = ('x'):rep(200) end");
    },
  },
  {
    id: 'reset_then_throw',
    signature: /PROBE-BOOM-after-reset/,
    describe: 'reset() the context, then throw',
    // The state the frame is running on is retired underneath it and *then*
    // the exception starts unwinding through it.
    act: (lua) => {
      try { lua.reset(); } catch { /* refused by the occupancy guard: expected */ }
      throw new Error(`${MARKER}-after-reset`);
    },
  },
  {
    id: 'nested_then_throw',
    signature: /PROBE-BOOM-inner/,
    describe: 're-enter Lua, then throw from the inner JS frame',
    // Two Lua C frames between the throw and the top-level catch instead of one.
    arm: (lua) => {
      lua.set_global('probe_inner', () => { throw new Error(`${MARKER}-inner`); });
    },
    act: (lua) => { lua.execute_script('probe_inner()'); },
  },
];
