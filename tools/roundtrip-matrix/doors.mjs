// CR-20, Axis B: the doors a JavaScript value can enter Lua through.
//
// Each door takes a value in and hands the same value back out, using only the
// public API. What comes back is compared with what went in (the round-trip
// assertion) and with what every *other* door produced for the same value (the
// parity assertion).
//
// Parity is the half with teeth. CR-17 F2 was one door of six behaving
// differently from its five siblings on a foreign table handle, found by
// eyeballing a column; there is no reason that has to be found by eye. Two
// doors disagreeing about the same value is a defect in the API's coherence
// even when neither answer is independently "wrong".
//
// `roundTrip(lua, value)` must return what the value became after a full
// crossing into Lua and back. Throwing is a legitimate outcome and is recorded
// as one — a door that refuses a value its siblings accept is exactly the shape
// being searched for.
//
// **`entryPoints` names the public methods the round-tripped value itself
// crosses through**, and it is read by the surface census
// (`tools/invariants/surface-census.mjs`), which computes the set of
// value-taking entry points from `types.d.ts` and reports any that no door
// drives. It is deliberately narrower than "methods this door calls": every
// door calls `execute_script`, but the value does not cross through the script
// string, and counting it would let one door claim coverage of everything.
// `[]` is a real answer — several doors carry the value *out* of Lua (returned
// from a class method, from a host callback) and enter it by no public method
// at all.

export const DOORS = [
  {
    id: 'set_global/get_global',
    entryPoints: ['set_global'],
    describe: 'set_global(v) then get_global()',
    roundTrip: (lua, v) => { lua.set_global('rt', v); return lua.get_global('rt'); },
  },
  {
    id: 'set_global/script',
    entryPoints: ['set_global'],
    describe: 'set_global(v) then `return rt` from a script',
    roundTrip: (lua, v) => { lua.set_global('rt', v); return lua.execute_script('return rt'); },
  },
  {
    id: 'create_table/get',
    entryPoints: ['create_table'],
    describe: 'create_table({ k: v }) then handle.get("k")',
    roundTrip: (lua, v) => lua.create_table({ k: v }).get('k'),
  },
  {
    id: 'handle.set/get',
    entryPoints: ['set'],
    describe: 'handle.set("k", v) then handle.get("k")',
    roundTrip: (lua, v) => {
      const h = lua.create_table({});
      h.set('k', v);
      return h.get('k');
    },
  },
  {
    id: 'lua-fn-arg',
    entryPoints: [],
    describe: 'passed as an argument to a Lua function that returns it',
    roundTrip: (lua, v) => {
      const f = lua.execute_script('return function(x) return x end');
      return f(v);
    },
  },
  {
    id: 'host-callback-return',
    entryPoints: [],
    describe: 'returned from a JS host callback, handed back by Lua',
    roundTrip: (lua, v) => {
      lua.set_global('give', () => v);
      return lua.execute_script('return give()');
    },
  },
  {
    id: 'coroutine-resume-arg',
    entryPoints: ['resume'],
    describe: 'resume(co, v), yielded straight back',
    roundTrip: (lua, v) => {
      const co = lua.create_coroutine('return function(x) coroutine.yield(x) end');
      const r = lua.resume(co, v);
      if (r.error) throw new Error(r.error);
      return r.values.length === 1 ? r.values[0] : r.values;
    },
  },
  {
    id: 'environment',
    entryPoints: ['set'],
    describe: 'placed in an environment, read by a script run in it',
    roundTrip: (lua, v) => {
      const env = lua.create_environment();
      env.set('rt', v);
      return lua.execute_script_in(env, 'return rt');
    },
  },
  {
    id: 'pcall-arg',
    entryPoints: ['pcall'],
    describe: 'pcall(luaFn, v)',
    roundTrip: (lua, v) => {
      const f = lua.execute_script('return function(x) return x end');
      const r = lua.pcall(f, v);
      if (!r.ok) throw new Error(String(r.error && r.error.message ? r.error.message : r.error));
      return r.value;
    },
  },
  {
    id: 'userdata-field',
    entryPoints: ['set_userdata'],
    describe: 'a field of a proxy userdata, read from Lua',
    roundTrip: (lua, v) => {
      lua.set_userdata('ud', { k: v }, { readable: true });
      return lua.execute_script('return ud.k');
    },
  },
  {
    id: 'class-method-return',
    entryPoints: [],
    describe: 'returned from a registered class method',
    roundTrip: (lua, v) => {
      lua.register_class('RT', { construct: () => ({}), methods: { get: () => v } });
      return lua.execute_script('local o = RT.new() return o:get()');
    },
  },
  {
    id: 'module-field',
    entryPoints: ['register_module'],
    describe: 'a field of a registered module, read after require',
    roundTrip: (lua, v) => {
      lua.register_module('rtmod', { k: v });
      return lua.execute_script('local m = require("rtmod") return m.k');
    },
  },
  // --- doors added by INTEROP-PARITY-PLAN (August 5, 2026) -------------------
  //
  // §15.6: a new public entry point that takes a JS value is a new door here.
  // The async ones matter most: `call_async` and `resume_async` were added
  // precisely because a capability existed at one door and not its siblings, so
  // leaving them outside the parity search would repeat the mistake in the
  // instrument that exists to catch it.
  {
    id: 'class-static-return',
    entryPoints: [],
    describe: 'returned from a registered class static (P2a)',
    roundTrip: (lua, v) => {
      lua.register_class('RTS', { construct: () => ({}), statics: { get: () => v } });
      return lua.execute_script('return RTS.get()');
    },
  },
  {
    id: 'class-property-get',
    entryPoints: [],
    describe: 'returned from a registered class property accessor (P2b)',
    roundTrip: (lua, v) => {
      lua.register_class('RTP', {
        construct: () => ({}),
        properties: { k: { get: () => v } },
      });
      return lua.execute_script('local o = RTP.new() return o.k');
    },
  },
  {
    id: 'class-property-set',
    entryPoints: ['set_global'],
    describe: 'written through a class property setter and read back (P2b)',
    roundTrip: (lua, v) => {
      let held;
      lua.register_class('RTW', {
        construct: () => ({}),
        properties: { k: { get: () => held, set: (_self, x) => { held = x; } } },
      });
      // Round trip is JS -> Lua (as the value set on the instance) -> JS. The
      // Lua-side write is what carries it, so this door exercises the setter
      // path rather than only the getter's.
      lua.set_global('rtw_v', v);
      return lua.execute_script('local o = RTW.new() o.k = rtw_v return o.k');
    },
  },
  {
    // Added August 6, 2026 by the surface census, which reported `call` as the
    // one value-taking entry point no door drove. Its *asynchronous* twin got a
    // door when INTEROP-PARITY added `call_async`; the synchronous original —
    // older than the matrix — never had one, which is the same "the new sibling
    // was covered, the old one was assumed" shape as the two frames added to
    // the exception matrix in the same pass.
    id: 'call-arg',
    entryPoints: ['call'],
    describe: 'passed as an argument to call(), returned straight back',
    roundTrip: (lua, v) => {
      lua.execute_script('function rt_id(x) return x end');
      return lua.call('rt_id', v);
    },
  },
  {
    id: 'call_async-arg',
    entryPoints: ['call_async'],
    describe: 'passed as an argument to call_async, returned straight back (P1a)',
    roundTrip: async (lua, v) => {
      lua.execute_script('function rt_id(x) return x end');
      return await lua.call_async('rt_id', v);
    },
  },
  {
    id: 'resume_async-arg',
    entryPoints: ['resume_async'],
    describe: 'resume_async(co, v), yielded straight back (P1b)',
    roundTrip: async (lua, v) => {
      const co = lua.create_coroutine('return function(x) coroutine.yield(x) end');
      const r = await lua.resume_async(co, v);
      if (r.error) throw new Error(r.error);
      return r.values.length === 1 ? r.values[0] : r.values;
    },
  },
  {
    id: 'file-reader-source',
    entryPoints: ['set_global'],
    describe: 'set as a global by a chunk served through the file reader (P4b)',
    roundTrip: (lua, v) => {
      // The reader serves *source*, so the value crosses as a global the served
      // chunk reads — this door is about dofile being a real execution path for
      // values, not about the source string itself.
      lua.set_global('rt_in', v);
      lua.set_file_reader((p) => (p === '/rt.lua' ? 'return rt_in' : null));
      return lua.execute_script('return dofile("/rt.lua")');
    },
  },
];
