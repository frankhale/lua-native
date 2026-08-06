// Axis B — how each container is populated, and how the population goes away
// again.
//
// A producer supplies up to three things, one per series (`policy.mjs` explains
// why there are three and what the first draft got wrong by having one):
//
//   repeat   `same(lua, n)` — perform the SAME registration again. The name or
//            key must not vary with `n`; that is the whole point. A KEYED
//            container must stay flat, an APPEND_ONLY one must grow by exactly
//            one, a SINGLETON must not pass its bound.
//   event    `fixed(lua)` — establish a population once, before the resets. The
//            series then does nothing but reset and collect, so anything that
//            grows is the reset's doing.
//   reclaim  `mint(lua, n)` / `drop(lua, n)` — the reclaimable *form* of this
//            container's contents, and the act of making it garbage. Only for
//            containers whose policy claims a reclaim path; the harness requires
//            one iff `reclaimable` is set, so a claim without a check and a
//            check without a claim are both errors.
//
// **Every producer must move its own counter, and the harness proves it before
// counting anything** (`tools/README.md`'s per-cell vacuity rule). A producer
// wired to an API that silently no-ops populates nothing, discards nothing,
// reports a perfectly flat series, and is indistinguishable from a container
// that never leaks.

import lua_native from '../../index.js';

export const PRODUCERS = [
  {
    field: 'callbacks',
    describe: 'a named host function, re-registered under one name',
    // One name, every round: this is the idempotence question the first draft
    // never asked, because it used a fresh name each time and then called the
    // resulting growth a leak.
    same: (lua) => {
      lua.set_global('cb', () => 1);
      lua.execute_script('return cb()');
    },
    fixed: (lua) => {
      lua.set_global('cb', () => 1);
      lua.execute_script('return cb()');
    },
    // The M2 contract: a function nested inside a table takes the reclaimable
    // path rather than the named-persistent one, and its js_callbacks_ entry is
    // dropped when the materialized Lua closure is collected.
    mint: (lua, n) => {
      lua.set_global('tbl', { fn: () => n, nested: { g: () => n } });
      lua.execute_script('return tbl.fn() + tbl.nested.g()');
    },
    drop: (lua) => { lua.set_global('tbl', null); },
  },
  {
    field: 'userdata',
    describe: 'set_userdata under one name',
    same: (lua) => {
      lua.set_userdata('ud', { v: 1 }, { readable: true, writable: true });
      lua.execute_script('return ud.v');
    },
    fixed: (lua) => {
      lua.set_userdata('ud', { v: 1 }, { readable: true, writable: true });
      lua.execute_script('return ud.v');
    },
    mint: (lua, n) => {
      lua.set_userdata(`ud_${n}`, { v: n }, { readable: true });
      lua.execute_script(`return ud_${n}.v`);
    },
    drop: (lua, n) => { lua.set_global(`ud_${n}`, null); },
  },
  {
    field: 'userdataMethods',
    describe: 'set_userdata with methods — the CR-11 F4 shape',
    same: (lua) => {
      lua.set_userdata('udm', { v: 1 }, { methods: { get: () => 1 } });
      lua.execute_script('return udm:get()');
    },
    fixed: (lua) => {
      lua.set_userdata('udm', { v: 1 }, { methods: { get: () => 1 } });
      lua.execute_script('return udm:get()');
    },
    mint: (lua, n) => {
      lua.set_userdata(`udm_${n}`, { v: n }, { methods: { get: () => n } });
      lua.execute_script(`return udm_${n}:get()`);
    },
    drop: (lua, n) => { lua.set_global(`udm_${n}`, null); },
  },
  {
    field: 'errorRegistry',
    describe: 'a host callback that throws, caught in Lua by pcall',
    same: (lua) => {
      lua.set_global('thrower', () => { throw new Error('boom'); });
      lua.execute_script('local ok, err = pcall(thrower) return tostring(err)');
    },
    fixed: (lua) => {
      lua.set_global('thrower', () => { throw new Error('boom'); });
      lua.execute_script('local ok, err = pcall(thrower) return tostring(err)');
    },
    // The registry is cleared when the *next* outermost call starts, not when
    // this one ends. Reading without this would measure the one moment the
    // product documents as populated and call it a residue.
    settle: (lua) => { lua.execute_script('return 1'); },
  },
  {
    field: 'classes',
    describe: 'register_class under one name (L7 refuses the repeat)',
    // A repeated name throws, which is the mechanism keeping the count flat —
    // so the throw is the expected outcome here, not a producer failure. The
    // harness records refusals separately rather than swallowing them.
    same: (lua) => {
      lua.register_class('Klass', { construct: () => ({ v: 1 }), methods: { get: (s) => s.v } });
      lua.execute_script('local k = Klass.new() return k:get()');
    },
    fixed: (lua) => {
      lua.register_class('Klass', { construct: () => ({ v: 1 }), methods: { get: (s) => s.v } });
      lua.execute_script('local k = Klass.new() return k:get()');
    },
  },
  {
    field: 'classAccessors',
    describe: 'register_class with a named property accessor, under one name',
    same: (lua) => {
      lua.register_class('Acc', {
        construct: () => ({ v: 1 }),
        properties: { v: { get: (s) => s.v, set: (s, x) => { s.v = x; } } },
      });
      lua.execute_script('local a = Acc.new() return a.v');
    },
    fixed: (lua) => {
      lua.register_class('Acc', {
        construct: () => ({ v: 1 }),
        properties: { v: { get: (s) => s.v, set: (s, x) => { s.v = x; } } },
      });
      lua.execute_script('local a = Acc.new() return a.v');
    },
  },
  {
    field: 'typeConverters',
    describe: 'register_type_converter, then push a value through it',
    // No removal API, so `same` genuinely adds one per call. APPEND_ONLY says
    // exactly one — the assertion is against two, not against growth.
    same: (lua, n) => {
      lua.register_type_converter((v) => v instanceof Date, (v) => `date:${v.getTime()}`);
      lua.set_global(`d_${n}`, new Date(0));
    },
    fixed: (lua) => {
      lua.register_type_converter((v) => v instanceof Date, (v) => `date:${v.getTime()}`);
      lua.set_global('d', new Date(0));
    },
  },
  {
    field: 'fromLuaConverters',
    describe: 'register_from_lua_converter, then read a value back through it',
    same: (lua) => {
      lua.register_from_lua_converter(
        (v) => typeof v === 'object' && v !== null && v.__tag === 't',
        (v) => ({ converted: v.__tag }),
      );
      lua.execute_script("return { __tag = 't' }");
    },
    fixed: (lua) => {
      lua.register_from_lua_converter(
        (v) => typeof v === 'object' && v !== null && v.__tag === 't',
        (v) => ({ converted: v.__tag }),
      );
      lua.execute_script("return { __tag = 't' }");
    },
  },
  {
    field: 'searchers',
    describe: 'add_searcher, then require through it',
    same: (lua) => {
      lua.add_searcher((name) => (name === 'mod' ? 'return 1' : null));
      lua.execute_script("return require('mod')");
    },
    fixed: (lua) => {
      lua.add_searcher((name) => (name === 'mod' ? 'return 1' : null));
      lua.execute_script("return require('mod')");
    },
  },
  {
    field: 'sharedTables',
    describe: 'subscribe a context to shared tables at construction',
    // The only container whose population is fixed before the context exists:
    // `shared` is an init option, so there is no per-round registration to
    // repeat. `same` is therefore a no-op and the real question — does a reset
    // re-record a subscription it was only supposed to re-push — is the event
    // series, which is where SharedTable::PushTo's contract is actually tested.
    perContext: (n) => {
      const shared = {};
      for (let i = 0; i < Math.max(1, n); i += 1) {
        shared[`sh_${i}`] = lua_native.createSharedTable({ v: i });
      }
      return { shared };
    },
    same: (lua) => { lua.execute_script('return sh_0.v'); },
    fixed: (lua) => { lua.execute_script('return sh_0.v'); },
    // `same` cannot raise this counter, so the vacuity proof is that the option
    // *scales* it. Without this the column would be flat whether or not
    // `shared` were wired to anything at all.
    provesPopulation: (make) => make(1).info().bindingRefs.sharedTables === 1
      && make(5).info().bindingRefs.sharedTables === 5,
  },
  {
    field: 'handlers',
    describe: 'install all four redirection handlers, then re-install them',
    same: (lua, n) => {
      lua.set_print_handler(() => {});
      lua.set_read_handler(() => `line ${n}`);
      lua.set_file_reader(() => `return ${n}`);
      lua.set_hook(() => {}, { count: 1000000 });
      lua.execute_script('print("x")');
    },
    fixed: (lua) => {
      lua.set_print_handler(() => {});
      lua.set_read_handler(() => 'line');
      lua.set_file_reader(() => 'return 1');
      lua.set_hook(() => {}, { count: 1000000 });
      lua.execute_script('print("x")');
    },
  },
  {
    field: 'asyncRefs',
    describe: 'run an async script to settlement',
    same: async (lua, n) => { await lua.execute_script_async(`return ${n}`); },
    fixed: async (lua) => { await lua.execute_script_async('return 1'); },
  },
  {
    field: 'callbacksObject',
    describe: 'construct with a callbacks object and call into it',
    perContext: () => ({}),
    callbacks: { probe: (x) => x },
    same: (lua, n) => { lua.execute_script(`return probe(${n})`); },
    fixed: (lua) => { lua.execute_script('return probe(1)'); },
    // A constructor argument, and the counter is 0-or-1, so no call could raise
    // it. The proof is the contrast: built without a callbacks object it reads
    // 0, built with one it reads 1. A counter hard-wired to 1 would pass a
    // scaling test and fail this one.
    provesPopulation: () => new lua_native.init().info().bindingRefs.callbacksObject === 0
      && new lua_native.init({ probe: (x) => x }).info().bindingRefs.callbacksObject === 1,
  },
];

export const byField = (field) => PRODUCERS.find((p) => p.field === field);
