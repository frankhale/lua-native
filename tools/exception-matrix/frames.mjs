// CR-18, Axis B: the Lua C frame the exception has to unwind through.
//
// A frame installs the injected JS somewhere the addon will call it from inside
// a native call, then triggers that call. `install(lua, act)` receives the
// callback body from Axis A; `trigger(lua)` performs the operation that reaches
// it. Whatever `trigger` throws is what the top-level JS sees, which is half of
// what each cell records; the other half is whether the process is still alive
// to record anything.
//
// The frame list is derived from the call-into-JS surface rather than recalled:
// every `*Callback` / handler the public API can be handed (`types.d.ts`), plus
// the two converter families and the marshalling points CR-16's injection
// matrix enumerated. `tools/invariants.mjs` freezes the counts these were
// derived from.

export const FRAMES = [
  // --- Lua is executing: the callback runs from a Lua C frame -------------
  {
    id: 'host_function',
    describe: 'a JS global function called from Lua',
    install: (lua, act) => lua.set_global('cr18_hostile', act),
    trigger: (lua) => lua.execute_script('return cr18_hostile()'),
  },
  {
    id: 'metamethod_index',
    describe: '__index on a global table',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __index: act });
    },
    trigger: (lua) => lua.execute_script('return cr18_t.anything'),
  },
  {
    id: 'metamethod_newindex',
    describe: '__newindex on a global table',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __newindex: act });
    },
    trigger: (lua) => lua.execute_script('cr18_t.x = 1'),
  },
  {
    id: 'metamethod_add',
    describe: '__add (arithmetic dispatch)',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __add: act });
    },
    trigger: (lua) => lua.execute_script('return cr18_t + 1'),
  },
  {
    id: 'metamethod_tostring',
    describe: '__tostring',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __tostring: act });
    },
    trigger: (lua) => lua.execute_script('return tostring(cr18_t)'),
  },
  {
    id: 'metamethod_lt',
    describe: '__lt (comparison dispatch)',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {} cr18_u = {}');
      lua.set_metatable('cr18_t', { __lt: act });
      lua.execute_script('setmetatable(cr18_u, getmetatable(cr18_t))');
    },
    trigger: (lua) => lua.execute_script('return cr18_t < cr18_u'),
  },
  {
    id: 'metamethod_call',
    describe: '__call',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __call: act });
    },
    trigger: (lua) => lua.execute_script('return cr18_t()'),
  },
  {
    id: 'metamethod_concat',
    describe: '__concat',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __concat: act });
    },
    trigger: (lua) => lua.execute_script('return cr18_t .. "x"'),
  },
  {
    id: 'gc_finalizer',
    describe: '__gc at an ordinary collection',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __gc: act });
    },
    trigger: (lua) => {
      lua.execute_script('cr18_t = nil');
      lua.gc('collect');
      lua.gc('collect');
    },
  },
  {
    id: 'gc_finalizer_at_close',
    describe: '__gc fired by lua_close, from inside reset()',
    // The one frame whose exception has nowhere ordinary to go: the state is
    // being destroyed, so there is no Lua error handler above it and the C++
    // unwind is running inside a destructor path.
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __gc: act });
    },
    trigger: (lua) => lua.reset(),
  },
  {
    id: 'close_metamethod',
    describe: '__close on a to-be-closed variable',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __close: act });
    },
    trigger: (lua) => lua.execute_script('do local x <close> = cr18_t end'),
  },
  {
    id: 'debug_hook',
    describe: 'a debug hook',
    install: (lua, act) => lua.set_hook(act, { line: true }),
    trigger: (lua) => lua.execute_script('local a = 1\nlocal b = a + 1\nreturn b'),
  },
  {
    id: 'print_handler',
    describe: 'the print / io.write handler',
    install: (lua, act) => lua.set_print_handler(act),
    trigger: (lua) => lua.execute_script('print("cr18")'),
  },
  {
    id: 'require_searcher',
    describe: 'a JS require searcher',
    install: (lua, act) => lua.add_searcher(act),
    trigger: (lua) => lua.execute_script('return require("cr18_missing_module")'),
  },
  {
    id: 'coroutine_resume',
    describe: 'a host function called inside a coroutine body',
    install: (lua, act) => lua.set_global('cr18_hostile', act),
    trigger: (lua) => {
      const co = lua.create_coroutine('return function() return cr18_hostile() end');
      return lua.resume(co);
    },
  },
  {
    id: 'coroutine_iterator',
    describe: 'a host function reached through the coroutine for..of protocol',
    install: (lua, act) => lua.set_global('cr18_hostile', act),
    trigger: (lua) => {
      const co = lua.create_coroutine('return function() coroutine.yield(cr18_hostile()) end');
      const seen = [];
      for (const v of co) seen.push(v);
      return seen;
    },
  },
  {
    id: 'lua_load_reader',
    describe: 'a JS function used as the chunk reader by Lua load()',
    install: (lua, act) => lua.set_global('cr18_hostile', act),
    trigger: (lua) => lua.execute_script('return load(cr18_hostile)'),
  },
  {
    id: 'class_method',
    describe: 'a registered class method',
    install: (lua, act) => {
      lua.register_class('Cr18', { construct: () => ({ tag: 'cr18' }), methods: { m: act } });
    },
    trigger: (lua) => lua.execute_script('local c = Cr18.new() return c:m()'),
  },
  {
    id: 'class_constructor',
    describe: 'a registered class constructor',
    install: (lua, act) => {
      lua.register_class('Cr18', { construct: act, methods: { m: () => 1 } });
    },
    trigger: (lua) => lua.execute_script('local c = Cr18.new() return 1'),
  },
  {
    id: 'class_metamethod',
    describe: 'a registered class metamethod (__tostring)',
    install: (lua, act) => {
      lua.register_class('Cr18', { construct: () => ({ tag: 'cr18' }), metamethods: { __tostring: act } });
    },
    trigger: (lua) => lua.execute_script('local c = Cr18.new() return tostring(c)'),
  },
  {
    id: 'userdata_method',
    describe: 'a userdata method',
    install: (lua, act) => lua.set_userdata('cr18_ud', { tag: 'cr18' }, { methods: { m: act } }),
    trigger: (lua) => lua.execute_script('return cr18_ud:m()'),
  },
  {
    id: 'userdata_proxy_get',
    describe: 'a proxy-userdata property read reaching a JS getter',
    install: (lua, act) => {
      const obj = {};
      Object.defineProperty(obj, 'prop', { get: act, enumerable: true, configurable: true });
      lua.set_userdata('cr18_ud', obj, { readable: true });
    },
    trigger: (lua) => lua.execute_script('return cr18_ud.prop'),
  },

  // --- Binding call, no Lua running: converters and marshalling ----------
  {
    id: 'type_converter',
    describe: 'a registered JS->Lua type converter',
    install: (lua, act) => {
      lua.register_type_converter((v) => typeof v === 'object' && v !== null && 'cr18' in v, act);
    },
    trigger: (lua) => lua.set_global('cr18_v', { cr18: true }),
  },
  {
    id: 'from_lua_converter',
    describe: 'a registered Lua->JS from-Lua converter',
    install: (lua, act) => {
      lua.register_from_lua_converter(() => true, act);
    },
    // An object-valued result, not `return 42`: from-Lua converters see only
    // object-valued results (types.d.ts), so a number never reaches them and
    // the cell would be vacuous — it would report the callback's exception as
    // swallowed when the callback had simply never run.
    trigger: (lua) => lua.execute_script('return { a = 1 }'),
  },
  {
    id: 'from_lua_converter_async',
    describe: 'a from-Lua converter running in the async worker OnOK marshal',
    install: (lua, act) => {
      lua.register_from_lua_converter(() => true, act);
    },
    trigger: (lua) => lua.execute_script_async('return { a = 1 }'),
    isAsync: true,
  },
  {
    id: 'table_handle_get',
    describe: 'a JS __index reached through a table handle get()',
    install: (lua, act) => {
      lua.execute_script('cr18_t = {}');
      lua.set_metatable('cr18_t', { __index: act });
    },
    trigger: (lua) => lua.get_global_ref('cr18_t').get('anything'),
  },
  {
    id: 'pcall_frame',
    describe: 'the function handed to pcall()',
    install: () => {},
    trigger: (lua, act) => lua.pcall(act),
    takesAct: true,
  },
];
