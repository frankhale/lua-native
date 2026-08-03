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

export const DOORS = [
  {
    id: 'set_global/get_global',
    describe: 'set_global(v) then get_global()',
    roundTrip: (lua, v) => { lua.set_global('rt', v); return lua.get_global('rt'); },
  },
  {
    id: 'set_global/script',
    describe: 'set_global(v) then `return rt` from a script',
    roundTrip: (lua, v) => { lua.set_global('rt', v); return lua.execute_script('return rt'); },
  },
  {
    id: 'create_table/get',
    describe: 'create_table({ k: v }) then handle.get("k")',
    roundTrip: (lua, v) => lua.create_table({ k: v }).get('k'),
  },
  {
    id: 'handle.set/get',
    describe: 'handle.set("k", v) then handle.get("k")',
    roundTrip: (lua, v) => {
      const h = lua.create_table({});
      h.set('k', v);
      return h.get('k');
    },
  },
  {
    id: 'lua-fn-arg',
    describe: 'passed as an argument to a Lua function that returns it',
    roundTrip: (lua, v) => {
      const f = lua.execute_script('return function(x) return x end');
      return f(v);
    },
  },
  {
    id: 'host-callback-return',
    describe: 'returned from a JS host callback, handed back by Lua',
    roundTrip: (lua, v) => {
      lua.set_global('give', () => v);
      return lua.execute_script('return give()');
    },
  },
  {
    id: 'coroutine-resume-arg',
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
    describe: 'placed in an environment, read by a script run in it',
    roundTrip: (lua, v) => {
      const env = lua.create_environment();
      env.set('rt', v);
      return lua.execute_script_in(env, 'return rt');
    },
  },
  {
    id: 'pcall-arg',
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
    describe: 'a field of a proxy userdata, read from Lua',
    roundTrip: (lua, v) => {
      lua.set_userdata('ud', { k: v }, { readable: true });
      return lua.execute_script('return ud.k');
    },
  },
  {
    id: 'class-method-return',
    describe: 'returned from a registered class method',
    roundTrip: (lua, v) => {
      lua.register_class('RT', { construct: () => ({}), methods: { get: () => v } });
      return lua.execute_script('local o = RT.new() return o:get()');
    },
  },
  {
    id: 'module-field',
    describe: 'a field of a registered module, read after require',
    roundTrip: (lua, v) => {
      lua.register_module('rtmod', { k: v });
      return lua.execute_script('local m = require("rtmod") return m.k');
    },
  },
];
