// The browser smoke set (`docs/reviews/WASM-TARGET-PLAN.md`, Phase 4): a fixed list of
// cells, each one thing a page will do with lua-native, written against the
// public API and nothing else.
//
// It is one module with no imports so that the same file runs in three places:
//
//   - a page's main thread and a Web Worker   (`tools/wasm-smoke/page/`)
//   - Node, against the native addon and the node variant of the WASM build
//     (`tools/wasm-smoke/run.mjs`) — which is how the set itself is checked.
//     A cell that is wrong about lua-native fails on the native addon, where
//     the suite has already said what the right answer is.
//
// A cell returns a short string saying what it saw, or throws. Three outcomes:
//
//   pass          it returned
//   FAIL          it threw
//   INCONCLUSIVE  it threw `Inconclusive`: the thing it waits for is the
//                 engine's to do and the engine did not do it in the time
//                 allowed. Only the collection cell can say this; a browser
//                 has no `gc()`.
//
// **Nothing here branches on the target except by a row of the permitted
// differences in `docs/WASM.md`**,
// and each such branch names its row. `env.family` is not asked of the caller:
// it is observed, the way `tools/target.mjs` observes it.

export class Inconclusive extends Error {}

const check = (ok, what) => { if (!ok) throw new Error(what); };
const same = (got, want, what) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${what}: got ${a}, wanted ${b}`);
};
const thrown = (f) => { try { f(); } catch (error) { return error; } throw new Error('expected a throw, and it returned'); };
const rejected = async (promise) => {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a rejection, and it resolved');
};
const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms); });
const now = () => globalThis.performance.now();
const BUSY = 'local x = 0; for i = 1, 2e6 do x = x + i end; return x';
const BUSY_ANSWER = 2000001000000;
const LONG_BUSY = 'local x = 0; for i = 1, 2e7 do x = x + i end; return x';
const LONG_BUSY_ANSWER = 200000010000000;

/** `native` or `wasm`, by what `compile()` returns (D4). */
export function observeFamily(lua_native) {
  const lua = new lua_native.init({}, {});
  const bytecode = lua.compile('return 1');
  lua.dispose();
  if (typeof globalThis.Buffer === 'function' && globalThis.Buffer.isBuffer(bytecode)) return 'native';
  if (Object.getPrototypeOf(bytecode) === Uint8Array.prototype) return 'wasm';
  throw new Error(`compile() returned ${Object.prototype.toString.call(bytecode)}, which is neither binding's answer`);
}

// What a context is like after the engine's stack ran out under it, and
// whether the module is still good for a context that was not involved.
function aftermath(lua_native, lua) {
  try {
    check(lua.execute_script('return 6 * 7') === 42, 'the same context answered wrongly for 6 * 7');
  } catch (error) {
    check(false, `the same context then threw: ${String(error?.message).slice(0, 100)}`);
  }
  const fresh = new lua_native.init({}, { libraries: 'all' });
  check(fresh.execute_script('return 6 * 7') === 42, 'a fresh context answered wrongly');
  fresh.dispose();
  return 'the same context still works; a fresh context works';
}

const notRaw = (error) => {
  check(!(typeof WebAssembly === 'object' && error instanceof WebAssembly.Exception),
    'a raw WebAssembly.Exception reached the caller');
  check(error instanceof Error, `the caller was thrown a non-Error: ${String(error)}`);
  return error;
};

export const CELLS = [
  {
    name: 'values: JavaScript to Lua and back',
    run: (m) => {
      const value = { n: 42, f: 1.5, s: 'héllo ☃', yes: true, no: false, list: [1, 2, 3], nested: { deep: { deeper: 'x' } } };
      const lua = new m.init({ value }, { libraries: 'all' });
      same(lua.execute_script('return value.n, value.f, value.s, value.yes, value.no, #value.list, value.nested.deep.deeper'),
        [42, 1.5, 'héllo ☃', true, false, 3, 'x'], 'fields read in Lua');
      const back = lua.execute_script('return value');
      same([back.n, back.f, back.s, back.yes, back.no, back.list, back.nested], [42, 1.5, 'héllo ☃', true, false, [1, 2, 3], { deep: { deeper: 'x' } }], 'the round trip');
      lua.dispose();
      return 'numbers, strings, booleans, an array and nested objects';
    },
  },
  {
    name: 'values: Lua to JavaScript',
    run: (m) => {
      const lua = new m.init({}, { libraries: 'all' });
      same(lua.execute_script('return 1, "two", {3, 4}, {k = "v"}, nil, 2^53'), [1, 'two', [3, 4], { k: 'v' }, null, 9007199254740992], 'six results');
      check(lua.execute_script('return math.maxinteger') === 9223372036854775807n, 'a 64-bit integer did not arrive as a BigInt');
      check(lua.execute_script('return nil') === null, 'nil alone');
      const f = lua.execute_script('return function(a, b) return a + b end');
      check(f(2, 3) === 5, 'a Lua function called from JavaScript');
      lua.dispose();
      return 'multiple results, tables, a BigInt and a callable Lua function';
    },
  },
  {
    name: 'a JavaScript callback called from Lua',
    run: (m) => {
      const seen = [];
      const lua = new m.init({ add: (a, b) => a + b, note: (...args) => { seen.push(args); } }, { libraries: 'all' });
      check(lua.execute_script('return add(2, 40)') === 42, 'the callback\'s result');
      lua.execute_script('note("a", 1, {x = true})');
      same(seen, [['a', 1, { x: true }]], 'the arguments it was given');
      lua.dispose();
      return 'arguments in, result out';
    },
  },
  {
    name: 'an error: Lua to JavaScript',
    run: (m) => {
      const lua = new m.init({}, { libraries: 'all' });
      const error = notRaw(thrown(() => lua.execute_script('error("lua-boom")')));
      check(/lua-boom/.test(error.message), `the message was: ${error.message}`);
      const syntax = notRaw(thrown(() => lua.execute_script('return +')));
      check(/unexpected symbol|syntax/i.test(syntax.message), `the syntax error was: ${syntax.message}`);
      check(lua.execute_script('return 1') === 1, 'the context after the errors');
      lua.dispose();
      return error.message.split('\n')[0];
    },
  },
  {
    name: 'an error: JavaScript to Lua',
    run: (m) => {
      const original = new TypeError('js-boom');
      const lua = new m.init({ fail: () => { throw original; } }, { libraries: 'all' });
      same(lua.execute_script('local ok, e = pcall(fail); return ok, type(e) == "table" and e.message or tostring(e)'),
        [false, 'js-boom'], 'what pcall saw');
      const escaped = notRaw(thrown(() => lua.execute_script('fail()')));
      check(/js-boom/.test(escaped.message), `the uncaught error's message was: ${escaped.message}`);
      lua.dispose();
      return 'caught by pcall, and thrown to the caller when not';
    },
  },
  {
    name: 'a JavaScript callback that throws a non-Error',
    run: (m) => {
      const lua = new m.init({
        str: () => { throw 'a bare string'; },
        obj: () => { throw { code: 7 }; },    
      }, { libraries: 'all' });
      const [ok1, e1] = lua.execute_script('local ok, e = pcall(str); return ok, tostring(type(e) == "table" and e.message or e)');
      check(ok1 === false && /a bare string/.test(e1), `pcall saw ${ok1}, ${e1}`);
      check(lua.execute_script('local ok = pcall(obj); return ok') === false, 'an object thrown did not fail the call');
      check(lua.execute_script('return 1') === 1, 'the context afterwards');
      lua.dispose();
      return 'a string and an object, each a Lua error';
    },
  },
  {
    name: 'a coroutine',
    run: (m) => {
      const lua = new m.init({}, { libraries: 'all' });
      const co = lua.create_coroutine('return function() local a = coroutine.yield(1); local b = coroutine.yield(a + 1); return a + b end');
      const first = lua.resume(co);
      const second = lua.resume(co, 10);
      const third = lua.resume(co, 20);
      same([first.values, second.values, third.values, third.status], [[1], [11], [30], 'dead'], 'three resumes');
      const each = [...lua.create_coroutine('return function() for i = 1, 3 do coroutine.yield(i * i) end end')];
      same(each, [1, 4, 9], 'iterating one');
      lua.dispose();
      return 'resumed with values, and iterated';
    },
  },
  {
    name: 'execute_async awaits a Promise',
    run: async (m) => {
      const lua = new m.init({
        later: (v) => new Promise(resolve => { setTimeout(() => resolve(v * 2), 20); }),
        never: () => Promise.reject(new Error('rejected-in-js')),
      }, { libraries: 'all' });
      check(await lua.execute_async('return later(21)') === 42, 'the awaited value');
      same(await lua.execute_async('local ok, e = pcall(never); return ok, type(e) == "table" and e.message or tostring(e)'),
        [false, 'rejected-in-js'], 'a rejection inside pcall');
      const error = notRaw(await rejected(lua.execute_async('never()')));
      check(/rejected-in-js/.test(error.message), `the rejection was: ${error.message}`);
      lua.dispose();
      return 'a resolved value, a rejection caught in Lua, and one that rejects the run';
    },
  },
  {
    name: 'timeout ends a busy loop (U8)',
    run: (m) => {
      const lua = new m.init({}, { libraries: 'all', timeout: 250 });
      const started = now();
      const error = notRaw(thrown(() => lua.execute_script('while true do end')));
      const elapsed = Math.round(now() - started);
      check(/execution timeout/.test(error.message), `it ended with: ${error.message}`);
      check(elapsed >= 200 && elapsed < 5000, `it took ${elapsed} ms for a 250 ms timeout`);
      check(lua.execute_script('return 1') === 1, 'the context afterwards');
      lua.dispose();
      return `ended after ${elapsed} ms of a 250 ms timeout`;
    },
  },
  {
    name: 'maxInstructions ends a busy loop',
    run: (m) => {
      const lua = new m.init({}, { libraries: 'all', maxInstructions: 100000 });
      const error = notRaw(thrown(() => lua.execute_script('while true do end')));
      check(/instruction limit exceeded/.test(error.message), `it ended with: ${error.message}`);
      lua.dispose();
      return 'instruction limit exceeded';
    },
  },
  {
    name: 'a limit of Infinity is not a limit of zero',
    run: (m) => {
      for (const key of ['maxMemory', 'maxInstructions', 'timeout']) {
        const lua = new m.init({}, { libraries: 'all', [key]: Infinity });
        check(lua.execute_script(BUSY) === BUSY_ANSWER, `${key}: Infinity ended a script`);
        const info = lua.info();
        const reported = key === 'maxMemory' ? info.memoryLimit : info[key];
        check(reported > Number.MAX_SAFE_INTEGER, `${key}: Infinity is reported as ${reported}`);
        lua.dispose();
      }
      return 'all three saturate above 2^53 and let a long script finish';
    },
  },
  {
    name: 'bytecode: compile and load_bytecode',
    run: (m, env) => {
      const lua = new m.init({}, { libraries: 'all' });
      const bytecode = lua.compile('local a, b = ...; return (a or 20) + (b or 22)');
      check(bytecode instanceof Uint8Array && bytecode.length > 0 && bytecode[0] === 27, 'the result is not a Lua chunk in a Uint8Array');
      // Permitted: "Bytecode is a `Uint8Array`, not a `Buffer`".
      if (env.family === 'wasm') check(Object.getPrototypeOf(bytecode) === Uint8Array.prototype, 'on WASM the result must be a plain Uint8Array');
      if (env.browser) check(typeof globalThis.Buffer === 'undefined', 'this is a browser and there is a Buffer global');
      check(lua.load_bytecode(bytecode) === 42, 'loading what was compiled');
      check(lua.load_bytecode(new Uint8Array(bytecode)) === 42, 'loading a copy in a fresh Uint8Array');
      const refusal = notRaw(thrown(() => lua.load_bytecode('not bytes')));
      check(/Buffer/.test(refusal.message), `a string was refused with: ${refusal.message}`);
      const sealed = new m.init({}, { libraries: 'all', allowBytecode: false });
      notRaw(thrown(() => sealed.load_bytecode(bytecode)));
      lua.dispose();
      sealed.dispose();
      return `${bytecode.length} bytes, ${env.browser ? 'with no Buffer global' : 'under Node'}; refused under allowBytecode: false`;
    },
  },
  {
    name: 'deferred door: execute_script_async (D3)',
    run: async (m, env) => {
      const lua = new m.init({}, { libraries: 'all' });
      // Where the engine can suspend WebAssembly, the run gives the event loop a
      // turn every few milliseconds; elsewhere it holds the thread to its end.
      const suspends = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
      let fired = 0;
      const run = lua.execute_script_async(LONG_BUSY);
      const timer = setInterval(() => { fired += 1; }, 1);
      check(typeof run?.then === 'function', 'it did not return a promise');
      check(lua.is_busy() === true, 'the context is not busy while the run is pending');
      const refusal = notRaw(thrown(() => lua.execute_script('return 1')));
      check(/async|busy|in progress|in flight/i.test(refusal.message), `a synchronous call during the run was refused with: ${refusal.message}`);
      check(await run === LONG_BUSY_ANSWER, 'the run\'s value');
      clearInterval(timer);
      // Permitted: "The two off-thread doors do not leave the calling thread".
      if (env.family === 'wasm' && !suspends) check(fired <= 1, 'a timer fired during the run: the script did not hold the thread');
      else check(fired > 1, `the timer fired ${fired} time(s) during the run`);
      check(lua.is_busy() === false, 'the context is still busy after the run');
      const error = notRaw(await rejected(lua.execute_script_async('error("deferred-boom")')));
      check(/deferred-boom/.test(error.message), `the rejection was: ${error.message}`);
      lua.dispose();
      const how = env.family === 'native' ? 'runs off the thread' : suspends ? 'gives the thread back as it goes' : 'holds the thread';
      return `resolves and rejects; the script ${how} (a timer fired ${fired} times)`;
    },
  },
  {
    name: 'deferred door: cancel() from a timer',
    run: async (m, env) => {
      if (env.family === 'wasm' && typeof WebAssembly.Suspending !== 'function') return 'not possible: this engine cannot suspend WebAssembly';
      const lua = new m.init({}, { libraries: 'all', timeout: 20000 });
      const run = lua.execute_script_async('while true do end');
      setTimeout(() => lua.cancel(), 30);
      const error = notRaw(await rejected(run));
      check(/execution cancelled/.test(error.message), `it ended with: ${error.message}`);
      check(lua.execute_script('return 6 * 7') === 42 && !lua.is_busy(), 'the context afterwards');
      lua.dispose();
      return 'execution cancelled, and the context works';
    },
  },
  {
    name: 'deferred door: several runs at once, with other contexts running between',
    run: async (m) => {
      // Each run is deep in Lua and in the module's own stack when it is
      // suspended; the calls between use that stack too.
      const script = `
        local function deep(n)
          if n == 0 then
            local s = 0
            for i = 1, 5e5 do s = s + i % 7 end
            return s
          end
          local r
          local ok, e = pcall(string.gsub, "x", "x", function() r = deep(n - 1) end)
          if not ok then error(e, 0) end
          return r + n
        end
        local co = coroutine.wrap(function()
          for i = 1, 10 do
            local s = 0
            for j = 1, 1e5 do s = s + j % 3 end
            coroutine.yield(s + i)
          end
        end)
        local t = 0
        for _ = 1, 10 do t = t + co() end
        local ok, e = pcall(function() local function f() return (string.gsub("x", "x", f)) end f() end)
        return deep(25), t, ok, (tostring(e):match("C stack overflow")), string.format("%099d", 7)`;
      const contexts = Array.from({ length: 6 }, () => new m.init({}, { libraries: 'all' }));
      const expected = contexts[0].execute_script(script);
      let between = 0;
      const timer = setInterval(() => {
        const other = new m.init({ cb: (x) => x }, { libraries: 'all' });
        between += other.execute_script('local function f(n) if n == 0 then return 1 end return (string.gsub("x", "x", function() f(n - 1) end)) end f(15) return cb(1)');
        other.dispose();
      }, 1);
      const results = await Promise.all(contexts.map(lua => lua.execute_script_async(script)));
      clearInterval(timer);
      for (const result of results) same(result, expected, 'a run\'s values');
      for (const lua of contexts) { check(lua.execute_script('return 6 * 7') === 42, 'a context afterwards'); lua.dispose(); }
      return `6 runs, each right; ${between} call(s) into other contexts between`;
    },
  },
  {
    name: 'deferred door: execute_file_async, on a file Lua wrote (D3)',
    run: async (m) => {
      const lua = new m.init({}, { libraries: 'all' });
      const missing = notRaw(await rejected(lua.execute_file_async(`/no-such-dir-${Date.now()}/x.lua`)));
      check(/cannot open|No such file/i.test(missing.message), `a missing file rejected with: ${missing.message}`);
      // The filesystem is whatever this target has: a disk under Node, memory
      // in a page ("Files are virtual"). Either way a file Lua writes is
      // one Lua can run.
      const path = `${lua.execute_script('return os.tmpname()')}-smoke.lua`;
      lua.set_global('path', path);
      check(lua.execute_script('local f = assert(io.open(path, "w")); f:write("return 6 * 7"); f:close(); return true') === true, 'writing the file');
      check(await lua.execute_file_async(path) === 42, 'running the file');
      check(lua.execute_file(path) === 42, 'running it synchronously');
      lua.execute_script('os.remove(path)');
      lua.dispose();
      return `a missing file is refused; ${path} was written, run and removed`;
    },
  },
  {
    name: 'a deferred door is ended by its timeout',
    run: async (m) => {
      const lua = new m.init({}, { libraries: 'all', timeout: 250 });
      const error = notRaw(await rejected(lua.execute_script_async('while true do end')));
      check(/execution timeout/.test(error.message), `it ended with: ${error.message}`);
      lua.dispose();
      return 'execution timeout';
    },
  },
  {
    name: 'a file served by set_file_reader',
    run: (m) => {
      const files = { '/lib/util.lua': 'return { add = function(a, b) return a + b end }' };
      const asked = [];
      const lua = new m.init({}, { libraries: 'sandbox', filesystem: 'deny' });
      lua.set_file_reader((path) => { asked.push(path); return files[path] ?? null; });
      check(lua.execute_script('return dofile("/lib/util.lua").add(2, 3)') === 5, 'dofile through the reader');
      const [ok, message] = lua.execute_script('local ok, e = pcall(dofile, "/lib/missing.lua"); return ok, tostring(e)');
      check(ok === false && /missing\.lua/.test(message), `a file the reader does not have: ${ok}, ${message}`);
      same(asked, ['/lib/util.lua', '/lib/missing.lua'], 'what the reader was asked for');
      lua.dispose();
      return 'served one file and refused another, with the filesystem denied';
    },
  },
  {
    name: 'require through register_module and add_searcher',
    run: (m) => {
      const lua = new m.init({}, { libraries: 'all' });
      lua.register_module('host', { answer: 42, twice: (n) => n * 2 });
      lua.add_searcher((name) => (name === 'virtual' ? 'return { name = ... }' : null));
      same(lua.execute_script('local h = require("host"); return h.answer, h.twice(4), require("virtual").name'), [42, 8, 'virtual'], 'two modules');
      lua.dispose();
      return 'a host module and one found by a searcher';
    },
  },
  {
    name: 'os and io, as this target has them (U7)',
    run: (m) => {
      const lua = new m.init({}, { libraries: 'all' });
      const [time, clock, date] = lua.execute_script('return os.time(), os.clock(), os.date("%Y")');
      check(time > 1.7e9 && typeof clock === 'number' && /^\d{4}$/.test(date), `os.time ${time}, os.clock ${clock}, os.date ${date}`);
      // Each either works or says no; none may accept and do nothing loudly wrong.
      const probes = lua.execute_script(`
        local out = {}
        for _, p in ipairs({
          {"os.getenv", function() return os.getenv("HOME") end},
          {"os.execute()", function() return os.execute() end},
          {"os.execute('exit 3')", function() return select(3, os.execute("exit 3")) end},
          {"io.popen", function() local f = assert(io.popen("echo hi")); local s = f:read("a"); f:close(); return s end},
          {"io.write", function() return io.write("") ~= nil end},
        }) do
          local ok, v = pcall(p[2])
          out[#out + 1] = p[1] .. (ok and (" -> " .. tostring(v):gsub("%s+$", "")) or " refused")
        end
        return table.concat(out, "; ")`);
      lua.dispose();
      return probes;
    },
  },
  {
    name: 'a table reference dropped and collected',
    run: async (m) => {
      const lua = new m.init({}, { libraries: 'all' });
      const alive = () => lua.execute_script('collectgarbage(); collectgarbage(); return weak[1] ~= nil');
      (() => {
        // Its own scope, so that nothing here keeps the handle after it returns.
        const handle = lua.execute_script(`
          weak = setmetatable({}, { __mode = "v" })
          weak[1] = setmetatable({}, { __index = function() return 7 end })
          return weak[1]`);
        check(handle.anything === 7, 'the handle is not a live reference to the Lua table');
      })();
      check(alive() === true, 'the table was collected while JavaScript still held a reference to it');
      // The handle is garbage now. When the engine notices is its own business:
      // lean on the heap and keep asking.
      const started = now();
      let rounds = 0;
      while (alive()) {
        if (now() - started > 20000) {
          throw new Inconclusive(`the engine did not collect the handle in 20 s and ${rounds} rounds of allocation`);
        }
        if (typeof globalThis.gc === 'function') globalThis.gc();
        const junk = [];
        for (let i = 0; i < 64; i++) junk.push(new Array(16384).fill({ i }));
        rounds += 1;
        await sleep(20);
      }
      lua.dispose();
      return `the Lua table was freed ${Math.round(now() - started)} ms after the handle was dropped (${rounds} rounds)`;
    },
  },
  {
    name: 'stack: Lua recursing through C reaches Lua\'s own limit',
    run: (m) => {
      const lua = new m.init({}, { libraries: 'all' });
      let outcome;
      try {
        const r = lua.execute_script(`
          local depth = 0
          local function f() depth = depth + 1; return (string.gsub("x", "x", f)) end
          local ok, e = pcall(f)
          return ok, depth, tostring(e)`);
        check(Array.isArray(r) && r[0] === false && r[1] >= 20 && /overflow/.test(r[2]), `a wrong answer: ${JSON.stringify(r).slice(0, 120)}`);
        outcome = `Lua refused at depth ${r[1]} with its own C stack overflow`;
      } catch (error) {
        notRaw(error);
        check(false, `pcall did not see it: ${error.message.slice(0, 120)}`);
      }
      return `${outcome}; ${aftermath(m, lua)}`;
    },
  },
  {
    // A measurement, not a verdict: how much room this thread gives. Lua stops
    // a chain of C calls at 200 by itself, and sooner where the engine's stack
    // has no room for that many (docs/WASM.md). The number is the deepest chain
    // that returned here, found by bisection.
    name: 'stack: the deepest chain of Lua C calls this thread allows',
    run: (m) => {
      const reaches = (depth) => {
        const lua = new m.init({}, { libraries: 'all' });
        try {
          lua.set_global('limit', depth);
          return lua.execute_script(`
            local depth = 0
            local function f() depth = depth + 1; if depth >= limit then return "x" end; return (string.gsub("x", "x", f)) end
            f(); return depth`) === depth;
        } catch (error) {
          notRaw(error);
          return false;
        } finally {
          try { lua.dispose(); } catch { /* an unwound context may refuse even this */ }
        }
      };
      check(reaches(2), 'a chain two deep did not return');
      const LUA_LIMIT = 190;   // comfortably inside Lua's own 200
      if (reaches(LUA_LIMIT)) return `at least ${LUA_LIMIT}: Lua's own limit is the one that applies here`;
      let low = 2;
      let high = LUA_LIMIT;
      while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (reaches(mid)) low = mid; else high = mid;
      }
      const fresh = new m.init({}, { libraries: 'all' });
      check(fresh.execute_script('return 6 * 7') === 42, 'a fresh context after the bisection');
      fresh.dispose();
      return `${low}: a deeper chain is refused here before Lua's own limit of 200`;
    },
  },
  {
    name: 'stack exhaustion: JavaScript and Lua calling each other',
    run: (m) => {
      const lua = new m.init({ reenter: (f) => f() }, { libraries: 'all' });
      let outcome;
      try {
        const r = lua.execute_script(`
          local depth = 0
          local function f() depth = depth + 1; return reenter(f) end
          local ok, e = pcall(f)
          return ok, depth, type(e) == "table" and e.message or tostring(e)`);
        check(Array.isArray(r) && r.length === 3 && r[0] === false && typeof r[2] === 'string', `a wrong answer: ${JSON.stringify(r).slice(0, 120)}`);
        outcome = `pcall saw "${r[2].split('\n')[0].slice(0, 60)}" at depth ${r[1]}`;
      } catch (error) {
        notRaw(error);
        check(false, `it threw: ${error.message.slice(0, 120)}`);
      }
      return `${outcome}; ${aftermath(m, lua)}`;
    },
  },
  {
    name: 'stack exhaustion: the error swallowed in JavaScript',
    run: (m) => {
      let swallowed = 0;
      const lua = new m.init({ reenter: (f) => { try { return f(); } catch { swallowed += 1; return 'swallowed'; } } }, { libraries: 'all' });
      let outcome;
      try {
        const r = lua.execute_script(`
          local depth = 0
          local function f() depth = depth + 1; return reenter(f) end
          local ok, e = pcall(f)
          return ok, depth, type(e) == "table" and e.message or tostring(e)`);
        check(Array.isArray(r) && r.length === 3 && r[0] === true && r[2] === 'swallowed', `a wrong answer: ${JSON.stringify(r).slice(0, 120)}`);
        outcome = `returned after ${swallowed} swallowed error(s), depth ${r[1]}`;
      } catch (error) {
        notRaw(error);
        check(false, `it threw: ${error.message.slice(0, 120)}`);
      }
      return `${outcome}; ${aftermath(m, lua)}`;
    },
  },
  {
    name: 'stack exhaustion: deep values and calls from the edge of the stack',
    run: (m) => {
      const lua = new m.init({}, { libraries: 'all' });
      const fn = lua.execute_script('return function(n) local function f(k) if k == 0 then return 1 end return (string.gsub("x", "x", function() f(k - 1) end)) end f(n) return n end');
      let deep = {};
      for (let i = 0; i < 90; i++) deep = { a: deep };
      lua.set_global('deep', deep);
      const doors = [() => lua.get_global('deep'), () => lua.set_global('copy', deep), () => fn(30)];
      const seen = { answered: 0, refused: 0 };
      let odd = '';
      let tries = 0;
      const attempt = (door) => {
        try { door(); seen.answered += 1; } catch (error) {
          if (error instanceof RangeError || /overflow|Maximum call stack|too much recursion/.test(error.message)) seen.refused += 1;
          else odd = odd || error.message.slice(0, 120);
        }
      };
      const dive = () => {
        try { dive(); } catch (overflow) {
          tries += 1;
          if (tries % 8 === 0 && tries < 12000) { try { attempt(doors[(tries / 8) % doors.length]); } catch { /* the edge itself */ } }
          throw overflow;
        }
      };
      try { dive(); } catch { /* the overflow that started the unwinding */ }
      check(odd === '', `a call threw: ${odd}`);
      check(seen.refused > 0 && seen.answered > 0, `nothing on each side of the edge: ${JSON.stringify(seen)}`);
      check(lua.execute_script('return 6 * 7') === 42, 'the same context afterwards');
      return `${seen.refused} refused, ${seen.answered} answered; ${aftermath(m, lua)}`;
    },
  },
  {
    name: 'reset, dispose and a second context',
    run: (m) => {
      const a = new m.init({ who: () => 'a' }, { libraries: 'all' });
      const b = new m.init({ who: () => 'b' }, { libraries: 'all' });
      a.execute_script('x = 1');
      same([a.execute_script('return who(), x'), b.execute_script('return who(), x')], [['a', 1], ['b', null]], 'two contexts');
      a.reset();
      same(a.execute_script('return who(), x'), ['a', null], 'after reset');
      a.dispose();
      check(/disposed|closed/i.test(notRaw(thrown(() => a.execute_script('return 1'))).message), 'a disposed context did not refuse');
      check(b.execute_script('return who()') === 'b', 'the other context after the first was disposed');
      b.dispose();
      return 'independent, reset keeps callbacks and drops globals, dispose refuses';
    },
  },
];

/**
 * Run every cell against `lua_native`. `env` is `{ browser, where }`; the
 * family is observed here and added to it.
 */
export async function runSmokeSet(lua_native, env, onResult = () => {}) {
  const full = { ...env, family: observeFamily(lua_native) };
  const results = [];
  for (const cell of CELLS) {
    const started = now();
    let result;
    try {
      result = { name: cell.name, status: 'pass', detail: await cell.run(lua_native, full) };
    } catch (error) {
      result = {
        name: cell.name,
        status: error instanceof Inconclusive ? 'INCONCLUSIVE' : 'FAIL',
        detail: String(error?.message ?? error).slice(0, 400),
      };
    }
    result.ms = Math.round(now() - started);
    results.push(result);
    onResult(result);
  }
  return { family: full.family, cells: CELLS.length, results };
}
