// Axis A — every kind of handle that crosses *out* of Lua and can be held by
// JavaScript across a lifecycle event.
//
// The list is derived from the source rather than remembered: a handle kind is
// anything the binding wraps in a `*Data` struct paired with a
// `shared_ptr<LuaRuntime>` (`LuaTableRefData`, `LuaFunctionData`,
// `LuaThreadData`, `LuaUserdataData`), plus the two JS-side objects that carry
// a registry-backed marker (`__luaClassRef`, the coroutine iterator binding).
// `grep -n 'struct Lua.*Data' src/lua-native.h` is the generator.
//
// **The two safety strategies are not the same, and the split is the reason
// this axis is worth enumerating.** Table and function handles carry a
// `ContextLiveness` pair and fail closed when `alive_` flips. Coroutines and
// userdata carry no liveness at all — they hold a `shared_ptr` to the runtime
// that minted them, and are policed at *use* by an identity comparison
// (`data->runtime.get() != runtime.get()`). Both are defensible; what matters
// is that every kind ends up refusing, and that none of them silently reaches
// the replacement state. A kind that used neither mechanism would look exactly
// like the ones that do, right up until it aliased.
//
// Each entry:
//   id     — cell name
//   make   — (lua) => handle, sets up whatever Lua-side state it needs
//   use    — (handle, lua) => value, the operation that must work or fail clean
//   probe  — optional: (lua) => re-alias the name this handle points at, so a
//            stale handle that reads the *new* state is detectable
//   release— optional: (handle) => explicit release, when the kind has one

export const HANDLES = [
  {
    id: 'table-ref',
    make: (lua) => { lua.execute_script('t = { v = 1 }'); return lua.get_global_ref('t'); },
    use: (h) => h.get('v'),
    probe: (lua) => lua.execute_script('t = { v = 999 }'),
    release: (h) => h.release(),
  },
  {
    id: 'table-created',
    make: (lua) => lua.create_table({ v: 1 }),
    use: (h) => h.get('v'),
    release: (h) => h.release(),
  },
  {
    id: 'table-proxy',
    // A metatabled table comes back as a JS Proxy over a LuaTableRefData, which
    // is a different door onto the same struct (CR-17 F2's shape).
    make: (lua) => lua.execute_script(
      'return setmetatable({ v = 1 }, { __index = function() return 7 end })'),
    use: (h) => h.v,
  },
  {
    id: 'function',
    make: (lua) => lua.execute_script('return function(a) return a + 1 end'),
    use: (h) => h(1),
  },
  {
    id: 'coroutine',
    make: (lua) => lua.create_coroutine('return function() coroutine.yield(1) return 2 end'),
    use: (h, lua) => lua.resume(h),
  },
  {
    // The genuine Lua-created userdata handle, and the only userdata kind that
    // *is* a handle. Its own properties are `["_userdata"]` — the marker and
    // nothing else — so a deep copy of it carries no data at all.
    id: 'userdata-lua',
    make: (lua) => lua.execute_script('return io.open("/dev/null", "r")'),
    use: (h, lua) => { lua.set_global('back', h); return lua.execute_script('return type(back)'); },
  },
  {
    // **Not a handle, and the distinction cost this matrix a false finding.**
    // `set_userdata` hands back the *identical JS object* the caller passed in
    // (`back === obj`), carrying no marker at all. So there is nothing here to
    // invalidate: after a reset it is still the caller's own object, and
    // pushing it into any context copies its fields exactly as passing a plain
    // object would. Kept in the matrix because "it keeps working" is the
    // property worth pinning, but expected to *work*, not to refuse — the
    // first draft expected a refusal, read the deep copy as an encapsulation
    // break, and reported three findings that were the instrument's own
    // assumption (CR-22 F1, corrected).
    id: 'userdata-js',
    notAHandle: true,
    make: (lua) => {
      lua.set_userdata('ud', { secret: 1 });
      return lua.execute_script('return ud');
    },
    use: (h, lua) => { lua.set_global('back', h); return lua.execute_script('return type(back)'); },
  },
  {
    // Same as userdata-js: the caller's own object, no marker. Not a handle.
    id: 'userdata-proxy',
    notAHandle: true,
    make: (lua) => {
      lua.set_userdata('pud', { n: 1 }, { proxy: true });
      return lua.execute_script('return pud');
    },
    use: (h, lua) => { lua.set_global('back', h); return lua.execute_script('return type(back)'); },
  },
  {
    // Same again. The methods live on the *registration*, which a reset clears
    // and another context never had; the object itself is the caller's.
    id: 'userdata-methods',
    notAHandle: true,
    make: (lua) => {
      lua.set_userdata('mud', { n: 1 }, { methods: { get: (self) => self.n } });
      return lua.execute_script('return mud');
    },
    use: (h, lua) => { lua.set_global('back', h); return lua.execute_script('return type(back)'); },
  },
  {
    // Carries markers *and* its own data, so a foreign one deep-copies the data
    // intact. That is the review ledger's M6 resolution, deliberate and pinned;
    // it is the one marker that is not refused, and the reason is that unlike
    // the two above it actually delivers the data.
    id: 'class-instance',
    notAHandle: true,
    // `make` is called more than once per cell (a baseline probe, then the real
    // subject, then 25 more under gc-churn), so it has to be idempotent.
    // `register_class` refuses a duplicate name, and a reset clears the
    // registration — so ask Lua whether the class is actually present on the
    // *current* state rather than remembering whether we have called it.
    //
    // `construct`, not `constructor`: the first draft used the latter and every
    // class-instance cell came back VACUOUS instead of passing, which is the
    // per-cell vacuity check doing its job (CR-19 F2 — an instrument that
    // swallows its own input reports a clean sheet).
    make: (lua) => {
      const present = lua.execute_script('return Point ~= nil');
      if (!present) {
        lua.register_class('Point', {
          construct: (x) => ({ x }),
          readable: true,
          methods: { getX: (self) => self.x },
        });
      }
      return lua.execute_script('return Point.new(5)');
    },
    use: (h, lua) => { lua.set_global('back', h); return lua.execute_script('return type(back)'); },
  },
  {
    id: 'coroutine-iterator',
    // The LuaContextBinding case: a bound C function with no Lua ref of its
    // own, whose context half can outlive the context (A4 in lua-native.h).
    make: (lua) => {
      const co = lua.create_coroutine(
        'return function() coroutine.yield(1) coroutine.yield(2) end');
      return co[Symbol.iterator]();
    },
    use: (h) => h.next(),
  },
];
