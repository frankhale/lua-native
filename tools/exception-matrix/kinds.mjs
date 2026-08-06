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

  // --- the strictConversion kinds (W2, August 6, 2026) ----------------------
  //
  // **Why these are kinds and not a second matrix.** W2 asked for
  // `exception-matrix` × `strictConversion`, and the obvious reading — re-run
  // all 429 cells with the option on — would spend 8 of every 11 cells on kinds
  // the option cannot affect. The option changes exactly one thing: whether a
  // *conversion* refuses. Axis A already models "the addon's own conversion
  // throws on the return path, with the Lua frame still on the stack"
  // (`return_symbol`, `return_bigint_out_of_range`, `return_deep_object`), and a
  // kind already carries `options`. So the mode enters where it belongs: as two
  // more ways for the conversion to refuse, run against all 39 frames.
  //
  // **This is the class CR-23 verified by hand and could not leave behind.** Its
  // "Verified and rejected" section drove a strict refusal out of one Lua C
  // frame and confirmed it arrived as a catchable Lua error rather than an
  // abort — the CR-6 F1 shape. That was one frame, once, in a scratch script.
  // These are all thirty-nine, every run.
  //
  // **The vacuity question answers itself, as it does for the other kinds.** If
  // `strictConversion` were ignored, the lossy value would convert silently, no
  // error would surface, and every cell would report SWALLOWED — the loudest
  // result this harness has. A disconnected knob cannot read as clean here.
  {
    id: 'return_lossy_array_strict',
    signature: /strict conversion/i,
    describe: 'return an array with a hole under strictConversion (refusal raised mid-frame)',
    options: { strictConversion: true },
    // [1, null, 3] would become a Lua sequence that ends at index 1. Under the
    // option that is a refusal, raised by the addon inside whatever Lua C frame
    // this cell installed the callback in.
    act: () => [1, null, 3],
  },
  {
    id: 'return_lossy_object_strict',
    signature: /strict conversion/i,
    describe: 'return an object with a null value under strictConversion',
    options: { strictConversion: true },
    // The other JS→Lua refusal: a nil object value removes the key rather than
    // storing one. Included because the two take different branches of the
    // converter (sequence vs map), and the whole reason this matrix exists is
    // that a class fixed on one branch tends to be short on the other.
    act: () => ({ a: null, b: 2 }),
  },
];
