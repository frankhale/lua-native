// Type definitions for the Lua module

/**
 * Represents a Lua table that has a metatable, returned as a JS Proxy object.
 * Property access flows through Lua metamethods (__index, __newindex, etc.).
 * When passed back to Lua, the original metatabled table is restored.
 */
export interface LuaTableRef {
  [key: string]: LuaValue;
}

/**
 * Represents a value that can be passed to or returned from Lua.
 * This includes all primitive types, arrays, objects, and functions.
 *
 * Note: Tables with metatables are returned as Proxy objects (LuaTableRef)
 * that preserve metamethods. Plain tables (no metatable) are deep-copied.
 */
export type LuaValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | LuaValue[]
  | LuaTable
  | LuaTableRef
  | LuaTableHandle
  | LuaFunction;

/**
 * A value that may be *passed into* Lua. This is wider than {@link LuaValue}
 * (what Lua hands back): the binding also converts `undefined` to nil and has
 * built-in conversions for binary data and the common JS collection types, none
 * of which Lua can produce on the way out.
 *
 * Use this for arguments; use {@link LuaValue} for results.
 */
export type LuaInput =
  | LuaValue
  | undefined
  | Date
  | Map<LuaInput, LuaInput>
  | Set<LuaInput>
  | ArrayBuffer
  | ArrayBufferView
  | LuaInput[]
  | { [key: string]: LuaInput };

/**
 * Represents a Lua table with string keys
 */
export interface LuaTable {
  [key: string]: LuaValue;
}

/**
 * Represents a function that can be called from Lua or returned from Lua
 */
export interface LuaFunction {
  (...args: LuaInput[]): LuaValue | LuaValue[] | void;
}

/**
 * Represents a Lua coroutine that can be resumed from JavaScript.
 *
 * A coroutine is also iterable: each `yield` is one iteration step, so
 * `for (const v of coro)` drives it to completion without a hand-written
 * `resume()` loop. A yield of several values arrives as an array, matching the
 * rest of the API. The coroutine's final `return` value arrives with
 * `done: true`, which `for..of` discards — exactly the JS generator contract.
 *
 * Iteration and `resume()` advance the same underlying Lua thread, so a loop
 * that exits early leaves the coroutine suspended where it stopped and a later
 * loop (or `resume()`) picks up from there. An already-dead coroutine yields
 * nothing rather than raising "cannot resume dead coroutine".
 *
 * `for await (const v of coro)` also works, via JS's sync-iterable fallback —
 * the resume itself is synchronous.
 *
 * @example
 * const co = lua.create_coroutine(`
 *   return function()
 *     for i = 1, 3 do coroutine.yield(i) end
 *   end
 * `);
 * for (const n of co) console.log(n);  // 1, 2, 3
 */
export interface LuaCoroutine extends Iterable<LuaValue> {
  /** The current status of the coroutine */
  status: 'suspended' | 'running' | 'dead';
  /** Internal reference - do not modify */
  _coroutine: unknown;
  /**
   * Returns a fresh iteration cursor. `next(...args)` forwards its arguments as
   * the resume values, so a generator-style coroutine can be fed from JS.
   */
  [Symbol.iterator](): Iterator<LuaValue, LuaValue | undefined, LuaInput>;
}

/**
 * Result of a protected call via `LuaContext.pcall`.
 * On success, `value` holds the function's return value (an array when the Lua
 * function returned multiple values). On failure, `error` holds the caught
 * error — the original JS Error when the failure came from a JS callback,
 * otherwise an Error carrying the Lua message and stack traceback.
 */
export type PcallResult =
  | { ok: true; value: LuaValue | LuaValue[] }
  | { ok: false; error: unknown };

/**
 * Result of resuming a coroutine
 */
export interface CoroutineResult {
  /** The status after resuming */
  status: 'suspended' | 'running' | 'dead';
  /** Values yielded or returned by the coroutine */
  values: LuaValue[];
  /** Error message if the coroutine failed */
  error?: string;
}

/**
 * Callback function that can be passed to the Lua context.
 * Receives Lua values as arguments and should return a Lua-compatible value.
 */
export interface LuaCallback {
  (...args: LuaValue[]): LuaValue | void;
}

/**
 * Object containing callbacks and values that will be available in the Lua environment
 */
export interface LuaCallbacks {
  [key: string]: LuaCallback | LuaInput;
}

/**
 * Defines a Lua metatable with metamethods and/or static values.
 * Functions become Lua C closures; other values are set directly.
 */
export interface MetatableDefinition {
  [key: string]: LuaCallback | LuaInput;
}

/**
 * Options for bytecode compilation
 */
export interface CompileOptions {
  /** Strip debug info (line numbers, local variable names) for smaller bytecode. Default: false */
  stripDebug?: boolean;
  /** Chunk name used in error messages. Default: source prefix or "@filepath" */
  chunkName?: string;
}

/**
 * A method function registered on userdata.
 * The first argument is always the JS object (`self`), passed automatically
 * when Lua calls `obj:method(args)`.
 * Remaining arguments come from the Lua call.
 */
export interface UserdataMethod {
  (self: any, ...args: LuaInput[]): LuaValue | LuaValue[] | void;
}

/**
 * Options for set_userdata controlling property access and methods from Lua
 */
export interface UserdataOptions {
  /** Allow Lua to read properties via __index */
  readable?: boolean;
  /** Allow Lua to write properties via __newindex */
  writable?: boolean;
  /**
   * Methods callable from Lua via `obj:method()` syntax.
   * Each method receives the original JS object as the first argument (`self`).
   *
   * Methods take precedence over properties when names collide.
   * Methods work independently of `readable`/`writable` — an opaque handle
   * can have methods even if its properties are hidden.
   *
   * @example
   * lua.set_userdata('player', playerObj, {
   *   readable: true,
   *   methods: {
   *     move: (self, dx, dy) => { self.x += dx; self.y += dy; },
   *     get_pos: (self) => [self.x, self.y],
   *   }
   * });
   * // Lua: player:move(10, 20)
   */
  methods?: Record<string, UserdataMethod>;
}

/**
 * Defines a JavaScript class/usertype registered with `register_class()`.
 * Lua can construct instances via `ClassName.new(...)`, call methods with
 * `instance:method()`, access properties, and use overloaded operators.
 */
export interface ClassDefinition {
  /**
   * Constructor invoked when Lua calls `ClassName.new(...)`. Receives the Lua
   * call arguments and must return the instance object. Lua holds the returned
   * object by reference (as userdata), not a copy.
   */
  construct: (...args: LuaValue[]) => object;

  /**
   * Name of a class registered earlier on this context to inherit from.
   *
   * A method missing from this class is looked up along the base chain, and the
   * base's metamethods (`__add`, `__tostring`, …) apply to instances of this
   * class unless it defines its own. `readable` / `writable` are per-instance
   * and set by the constructor, so they are not inherited — state them here too
   * if this class needs them.
   *
   * Each class still supplies its own `construct`: the JS class hierarchy is
   * what decides how an instance is built, and `extends` only describes how Lua
   * resolves names on it.
   *
   * @example
   * lua.register_class('Animal', {
   *   construct: (name) => new Animal(name),
   *   readable: true,
   *   methods: { describe: (self) => `a ${self.species}` },
   * });
   * lua.register_class('Dog', {
   *   extends: 'Animal',
   *   construct: (name) => new Dog(name),
   *   readable: true,
   *   methods: { speak: () => 'woof' },
   * });
   * // Lua: local d = Dog.new('rex'); d:speak(); d:describe()
   */
  extends?: string;

  /**
   * Instance methods callable from Lua via `instance:method(args)`. Each method
   * receives the instance object as the first argument (`self`).
   */
  methods?: Record<string, UserdataMethod>;

  /**
   * Metamethods for the class — operator overloads and hooks such as `__add`,
   * `__eq`, `__lt`, `__le`, `__len`, `__concat`, `__unm`, `__tostring`, and
   * `__call`. Each receives its Lua operands (instances arrive as their JS
   * objects) and returns the result.
   */
  metamethods?: Record<string, LuaCallback>;

  /** Allow Lua to read instance properties via `instance.prop` (default: false) */
  readable?: boolean;

  /** Allow Lua to write instance properties via `instance.prop = v` (default: false) */
  writable?: boolean;
}

/**
 * A handle to a Lua table stored in the Lua registry.
 * Provides direct get/set/iterate access without execute_script.
 *
 * The handle holds a live reference — mutations from JS are visible
 * in Lua and vice versa. Call release() when done to free the
 * registry slot.
 */
export interface LuaTableHandle {
  /**
   * Get a field by key. Triggers __index if the table has a metatable.
   *
   * The key's JS type selects the Lua key type: a `number` addresses an
   * integer key when integral (e.g. `1`) or a float key otherwise (e.g. `1.5`),
   * while a `string` always addresses a string key — never coerced. This makes
   * a genuine string key like `"123"` distinct from integer key `123`
   * (`t.get("123")` vs `t.get(123)`), unlike Proxy-based access where JS
   * property keys are always strings.
   */
  get(key: string | number): LuaValue;

  /**
   * Get a nested table field as a live handle rather than a copy.
   *
   * `get()` follows the library's usual conversion rule: a Lua table **without**
   * a metatable comes back as a detached deep copy, so mutating it does nothing
   * to Lua and `set_metatable()` has nothing to attach to. `get_ref()` is the
   * explicit opt-in to the real table — `get_global_ref()` one level down.
   *
   * Handles compose, so any depth is reachable, and because the key keeps its JS
   * type (see {@link get}) an integer key and array element are addressable too
   * — neither of which a dotted string path could express.
   *
   * The read triggers `__index` like `get()`. The returned handle is independent
   * of the one it came from: it stays valid after the parent is released, and
   * needs its own `release()`.
   *
   * @param key The field to reference
   * @returns A handle to the table stored at `key`
   * @throws If the field is not a table (including nil), or this handle has been
   *   released
   * @example
   * lua.execute_script('config = { db = { host = "localhost" } }');
   *
   * const db = lua.get_global_ref('config').get_ref('db');
   * db.set('port', 5432);                       // reaches the real Lua table
   * lua.set_metatable(db, { __index: () => null });
   * db.release();
   */
  get_ref(key: string | number): LuaTableHandle;

  /** Set a field by key. Triggers __newindex if the table has a metatable. See {@link get} for how the key's JS type maps to the Lua key type. */
  set(key: string | number, value: LuaInput): void;

  /** Check if a key exists in the table. See {@link get} for how the key's JS type maps to the Lua key type. */
  has(key: string | number): boolean;

  /** Get the table length (# operator). Triggers __len metamethod. */
  length(): number;

  /**
   * Get all key-value pairs (like Lua pairs()).
   * Returns an array of [key, value] tuples.
   */
  pairs(): Array<[string | number, LuaValue]>;

  /**
   * Get integer-keyed sequence entries (like Lua ipairs()).
   * Iterates from index 1 until the first nil value.
   * Returns an array of [index, value] tuples.
   */
  ipairs(): Array<[number, LuaValue]>;

  /**
   * Release the registry reference. After calling release(),
   * all other methods throw. Safe to call multiple times.
   */
  release(): void;
}

/**
 * The kind of event a {@link LuaHookCallback} was fired for.
 *
 * - `'call'` — a function was entered
 * - `'tail call'` — a function was entered by a tail call (`return f()`);
 *   Lua reports these separately and no matching `'return'` event follows
 * - `'return'` — a function returned
 * - `'line'` — a new source line is about to execute
 * - `'count'` — the requested number of VM instructions has elapsed
 */
export type LuaHookEvent = 'call' | 'tail call' | 'return' | 'line' | 'count';

/**
 * Receives one debug-hook event.
 *
 * @param event What happened — see {@link LuaHookEvent}
 * @param line The current source line, or `-1` where Lua has no line
 *   information (a C function, or a stripped chunk)
 * @param name The function's name if Lua can determine one, otherwise `''`.
 *   Lua infers names from the call site, so an anonymous function, a tail call,
 *   or a main chunk usually reports `''`.
 */
export type LuaHookCallback = (
  event: LuaHookEvent,
  line: number,
  name: string
) => void;

/**
 * Which events a debug hook fires on. At least one must be requested.
 */
export interface HookOptions {
  /** Fire on function entry (`'call'` and `'tail call'` events). */
  call?: boolean;

  /** Fire on function return (`'return'` events). */
  return?: boolean;

  /** Fire on each new source line (`'line'` events). The most expensive option. */
  line?: boolean;

  /**
   * Fire a `'count'` event every N Lua VM instructions. Must be a positive
   * integer.
   *
   * When `maxInstructions` is also set, both share one underlying hook: the
   * finer interval is installed and each is tallied to its own granularity, so
   * the event still arrives every N instructions as requested.
   */
  count?: number;
}

/**
 * A diagnostics snapshot of a Lua context, returned by
 * {@link LuaContext.info}.
 */
export interface LuaStateInfo {
  /** Lua version of the linked build, e.g. `'Lua 5.5'`. */
  version: string;

  /** Full version including the patch level, e.g. `'Lua 5.5.0'`. */
  release: string;

  /** Numeric version for comparisons: major * 100 + minor (e.g. `505`). */
  versionNumber: number;

  /** Memory currently held by the Lua state, in bytes. Same value as `get_memory_usage()`. */
  memoryBytes: number;

  /** Memory currently held by the Lua state, in kilobytes (fractional). */
  memoryKB: number;

  /** The `maxMemory` this context was created with, in bytes. `0` means unlimited. */
  memoryLimit: number;

  /** The `maxInstructions` limit in force. `0` means unlimited. */
  maxInstructions: number;

  /** The `timeout` in force, in milliseconds. `0` means no timeout. */
  timeout: number;

  /**
   * Standard libraries loaded into this state, by name. A preset reads back as
   * the names it expanded to (`'all'` → all ten), and a bare state as `[]`.
   */
  libraries: LuaLibrary[];
}

/**
 * An environment table: a private global namespace for scripts run with
 * {@link LuaContext.execute_script_in}.
 *
 * It is an ordinary table reference, so the full handle surface applies —
 * `get`/`set` to seed helpers or read back what a script defined, `pairs()` to
 * inspect it, `release()` when done.
 */
export interface LuaEnvironment extends LuaTableHandle {}

/**
 * Options for {@link LuaContext.create_environment}.
 */
export interface EnvironmentOptions {
  /**
   * Global names to seed the environment with, copied from `_G` by value
   * (e.g. `['math', 'print']`). A name that is unset in `_G` is skipped.
   * Default: none — an empty environment.
   */
  whitelist?: string[];

  /**
   * Fall back to the real globals for names the environment doesn't define,
   * via an `__index` metatable pointing at `_G`. Reads fall through; writes
   * never do, so an assignment shadows the global instead of overwriting it.
   * Default: false.
   */
  inherit?: boolean;
}

/**
 * Represents a Lua execution context
 */
export interface LuaContext {
  /**
   * Executes a Lua script string and returns the result.
   * Use the generic parameter to specify the expected return type.
   * @param script The Lua script to execute
   * @returns The result of the script execution
   * @example
   * const num = lua.execute_script<number>('return 42');
   * const fn = lua.execute_script<LuaFunction>('return function(x) return x * 2 end');
   */
  execute_script<T extends LuaValue | LuaValue[] = LuaValue>(script: string): T;

  /**
   * Executes a Lua file and returns the result.
   * Use the generic parameter to specify the expected return type.
   * @param filepath The path to the Lua file to execute
   * @returns The result of the file execution
   * @example
   * const result = lua.execute_file<number>('./scripts/init.lua');
   */
  execute_file<T extends LuaValue | LuaValue[] = LuaValue>(filepath: string): T;

  /**
   * Sets a global variable or function in the Lua environment.
   *
   * A dotted `name` addresses a nested field: `set_global('config.db.host', v)`
   * assigns `config.db.host = v`, creating any missing intermediate tables
   * (`config` and `config.db`) as it descends. Field access flows through
   * `__index`/`__newindex` metamethods, like real Lua field access. It throws
   * if an existing intermediate is a non-table value (e.g. `config` is a
   * number), or if the path is malformed (a leading, trailing, or doubled dot).
   * A name with no dot sets a single global whose key may itself contain dots.
   *
   * @param name The name of the global variable, or a dotted path to a nested field
   * @param value The value to set (function, number, boolean, string, or object)
   */
  set_global(name: string, value: LuaInput | LuaCallback): void;

  /**
   * Gets a global variable from the Lua environment.
   *
   * A dotted `name` reads a nested field: `get_global('config.db.host')`
   * returns `config.db.host`, descending through `__index` metamethods. If any
   * segment along the path is nil, the result is `null` (optional-chaining
   * semantics), just as a missing single global reads back as `null`. It throws
   * only if a non-nil intermediate is a non-indexable value (e.g. `config.db`
   * is a number) or if the path is malformed.
   *
   * @param name The name of the global variable, or a dotted path to a nested field
   * @returns The value of the global, or null if not set
   */
  get_global(name: string): LuaValue;

  /**
   * Calls a Lua function by global name, returning its result (an array when
   * the function returned several values, `undefined` when it returned none).
   *
   * Convenience over `get_global(name)` followed by calling the returned
   * wrapper — but it never mints that wrapper, so a hot call loop doesn't leave
   * a JS function object and its Lua registry slot behind on each iteration.
   *
   * `name` accepts a dotted path, like `get_global`. The target must be a Lua
   * function; a callable table (one with `__call`) is not accepted here — reach
   * it through `get_global` instead. A Lua error propagates as a thrown JS
   * error, with the original `Error` preserved when the failure came from a JS
   * callback.
   *
   * @param name The global name of a Lua function, or a dotted path to one
   * @param args Arguments to pass to the function
   * @example
   * lua.execute_script('function greet(name) return "hello " .. name end');
   * lua.call('greet', 'world');  // 'hello world'
   *
   * lua.execute_script('handlers = { onTick = function(n) return n * 2 end }');
   * lua.call('handlers.onTick', 21);  // 42
   */
  call<T extends LuaValue | LuaValue[] = LuaValue>(name: string, ...args: LuaInput[]): T;

  /**
   * Sets a JavaScript object as userdata in the Lua environment.
   * The object is passed by reference - Lua holds a handle to the original object,
   * not a copy. When the userdata flows back to JS (via callbacks or return values),
   * the original object is returned.
   *
   * @param name The global variable name in Lua
   * @param value The JavaScript object to store as userdata
   * @param options Optional access control for property access from Lua
   * @example
   * // Opaque handle (Lua can pass it around but not inspect it)
   * lua.set_userdata('handle', myObject);
   *
   * // With property access (Lua can read/write properties)
   * lua.set_userdata('player', playerObj, { readable: true, writable: true });
   *
   * // Read-only (Lua can read but not write)
   * lua.set_userdata('config', configObj, { readable: true });
   */
  set_userdata(name: string, value: object, options?: UserdataOptions): void;

  /**
   * Sets a metatable on a Lua table, enabling operator overloading, custom
   * indexing, __tostring, __call, and other metamethods.
   *
   * The target is either the name of an existing global table, or a live table
   * reference — a `create_table()` / `get_global_ref()` / `create_environment()`
   * handle, or the Proxy a metatabled table round-trips as. The table need not
   * have a global name.
   *
   * Any metatable the table already had is replaced, matching Lua's
   * `setmetatable`. A handle from another context, or one that has been
   * released, is rejected.
   *
   * @param target The name of an existing global table, or a table reference
   * @param metatable An object whose keys are metamethod names (e.g. __add, __tostring)
   *   and values are either callback functions or static Lua values
   * @example
   * lua.execute_script('vec = {x = 1, y = 2}');
   * lua.set_metatable('vec', {
   *   __tostring: (t) => `(${t.x}, ${t.y})`,
   *   __add: (a, b) => { ... }
   * });
   *
   * // On a table that has no global name:
   * const defaults = lua.create_table();
   * lua.set_metatable(defaults, { __index: (t, k) => `<${k}>` });
   * defaults.get('missing');  // '<missing>'
   */
  set_metatable(
    target: string | LuaTableHandle | LuaTableRef,
    metatable: MetatableDefinition
  ): void;

  /**
   * Appends a search path to Lua's `package.path` for module resolution.
   * The path must contain a `?` placeholder that gets replaced by the module name.
   * Requires the `package` library to be loaded.
   *
   * @param path Search path template (e.g., './modules/?.lua')
   * @example
   * lua.add_search_path('./lua_modules/?.lua');
   * lua.add_search_path('./libs/?/init.lua');
   * // Lua: local mod = require('mymod')  -- searches ./lua_modules/mymod.lua
   */
  add_search_path(path: string): void;

  /**
   * Registers a JavaScript object as a Lua module, making it available via `require(name)`.
   * The module is pre-loaded into `package.loaded` — no filesystem search occurs.
   * Functions in the module object become callable from Lua.
   * Requires the `package` library to be loaded.
   *
   * @param name The module name used in `require(name)`
   * @param module An object whose properties become the module's fields
   * @example
   * lua.register_module('utils', {
   *   clamp: (x, min, max) => Math.min(Math.max(x, min), max),
   *   version: '1.0.0',
   * });
   * // Lua: local utils = require('utils'); utils.clamp(5, 0, 10)
   */
  register_module(name: string, module: LuaTable | LuaCallbacks): void;

  /**
   * Creates a coroutine from a Lua script that returns a function, or from a
   * Lua function already held on the JS side.
   *
   * The function form takes any `LuaFunction` this context produced — from
   * `execute_script`, `get_global`, a callback argument — so a function you
   * already have need not be re-sourced as text. A plain JavaScript function is
   * rejected: a coroutine body has to be a Lua function. A function belonging to
   * another context, or one passed to `release()`, is rejected too.
   *
   * The returned coroutine is iterable — see {@link LuaCoroutine}.
   *
   * @param body A Lua script that returns a function, or a Lua function
   * @returns A coroutine object that can be resumed or iterated
   * @example
   * const coro = lua.create_coroutine(`
   *   return function(x)
   *     coroutine.yield(x * 2)
   *     coroutine.yield(x * 3)
   *     return x * 4
   *   end
   * `);
   *
   * // From a function you already hold:
   * const fn = lua.get_global('producer') as LuaFunction;
   * for (const item of lua.create_coroutine(fn)) console.log(item);
   */
  create_coroutine(body: string | LuaFunction): LuaCoroutine;

  /**
   * Resumes a suspended coroutine with optional arguments.
   * @param coroutine The coroutine to resume
   * @param args Arguments to pass to the coroutine (received by yield on resume, or as function args on first resume)
   * @returns The result containing status and yielded/returned values
   * @example
   * const result = lua.resume(coro, 10);
   * // result.status: 'suspended' | 'dead'
   * // result.values: yielded or returned values
   */
  resume(coroutine: LuaCoroutine, ...args: LuaInput[]): CoroutineResult;

  /**
   * Executes a Lua script string asynchronously on a worker thread.
   * Returns a Promise that resolves with the result.
   * JS callbacks are not available during async execution.
   * @param script The Lua script to execute
   * @returns Promise resolving with the result of the script execution
   */
  execute_script_async<T extends LuaValue | LuaValue[] = LuaValue>(script: string): Promise<T>;

  /**
   * Executes a Lua file asynchronously on a worker thread.
   * Returns a Promise that resolves with the result.
   * JS callbacks are not available during async execution.
   * @param filepath The path to the Lua file to execute
   * @returns Promise resolving with the result of the file execution
   */
  execute_file_async<T extends LuaValue | LuaValue[] = LuaValue>(filepath: string): Promise<T>;

  /**
   * Executes a Lua script as a coroutine on the **main thread**, transparently
   * awaiting JavaScript Promises returned by host functions.
   *
   * Unlike `execute_script_async` (which runs on a worker thread and forbids
   * callbacks), this runs on the main thread, so:
   * - JS callbacks work normally.
   * - When a host function (global, module function, or `obj:method()`) returns
   *   a Promise, the Lua coroutine suspends until it settles and resumes with
   *   the resolved value. A rejection is raised as a Lua error (catchable with
   *   `pcall`); an uncaught rejection rejects the returned Promise.
   *
   * The event loop stays free during the `await` gaps. Only one async operation
   * may run per context at a time (`is_busy()` is true meanwhile).
   *
   * Calling a Promise-returning host function in synchronous `execute_script`
   * throws — such functions must be awaited via `execute_async`.
   *
   * @param script The Lua script to execute
   * @returns Promise resolving with the script's return value(s)
   * @example
   * const lua = new lua_native.init({
   *   fetchUser: async (id) => (await db.get(id)),
   * }, { libraries: 'all' });
   * const name = await lua.execute_async(`
   *   local user = fetchUser(42)   -- suspends until the JS Promise resolves
   *   return user.name
   * `);
   */
  execute_async<T extends LuaValue | LuaValue[] = LuaValue>(script: string): Promise<T>;

  /**
   * Cancels an in-flight `execute_async` run. The returned Promise from the
   * cancelled `execute_async` rejects with an "execution cancelled" error, and
   * the suspended coroutine is abandoned. No-op if nothing is running.
   *
   * Because JavaScript is single-threaded, this can only take effect while the
   * script is suspended awaiting a Promise (not during a synchronous Lua loop).
   */
  cancel(): void;

  /**
   * Returns whether the context is currently busy with an async operation.
   * While busy, sync methods will throw and new async calls will be rejected.
   */
  is_busy(): boolean;

  /**
   * Returns the current memory usage of the Lua state in bytes.
   * This is tracked by the custom allocator and works regardless of
   * whether `maxMemory` was set.
   * @returns The current memory usage in bytes
   */
  get_memory_usage(): number;

  /**
   * Returns a diagnostics snapshot of this context: the Lua version it runs,
   * the memory it currently holds, and the limits and libraries it was
   * configured with.
   *
   * Everything reported is read from state the runtime already tracks, so this
   * runs no Lua code and never triggers a collection — safe to call on a timer
   * for monitoring. It throws only while an async operation is in flight.
   *
   * @example
   * lua.info();
   * // {
   * //   version: 'Lua 5.5', release: 'Lua 5.5.0', versionNumber: 505,
   * //   memoryBytes: 19532, memoryKB: 19.07,
   * //   memoryLimit: 0, maxInstructions: 0,
   * //   libraries: ['base', 'package', ...]
   * // }
   *
   * @example
   * // Monitor headroom against the configured cap
   * const { memoryBytes, memoryLimit } = lua.info();
   * if (memoryLimit > 0 && memoryBytes / memoryLimit > 0.9) reset();
   */
  info(): LuaStateInfo;

  /**
   * Compiles Lua source code to bytecode without executing it.
   * The returned Buffer can be saved to disk or passed to `load_bytecode()`.
   *
   * @param script The Lua source code to compile
   * @param options Optional compilation settings
   * @returns Buffer containing the compiled bytecode
   * @throws Error if the source has syntax errors
   * @example
   * const bytecode = lua.compile('return function(x) return x * 2 end');
   * fs.writeFileSync('my-script.luac', bytecode);
   */
  compile(script: string, options?: CompileOptions): Buffer;

  /**
   * Compiles a Lua file to bytecode without executing it.
   * The chunk name defaults to "@filepath" matching Lua convention.
   *
   * @param filepath Path to the Lua source file
   * @param options Optional compilation settings
   * @returns Buffer containing the compiled bytecode
   * @throws Error if the file cannot be read or has syntax errors
   * @example
   * const bytecode = lua.compile_file('./scripts/init.lua');
   */
  compile_file(filepath: string, options?: CompileOptions): Buffer;

  /**
   * Loads and executes precompiled Lua bytecode.
   * Only accepts binary bytecode (not source text). Use `execute_script()` for source.
   *
   * @param bytecode Buffer containing Lua bytecode (from `compile()`, `compile_file()`, or `luac`)
   * @param chunkName Optional name for error messages. Default: "bytecode"
   * @returns The result of executing the bytecode
   * @throws Error if the bytecode is invalid, corrupted, or from an incompatible Lua version
   * @example
   * const bytecode = lua.compile('return 42');
   * const result = lua.load_bytecode<number>(bytecode); // 42
   */
  load_bytecode<T extends LuaValue | LuaValue[] = LuaValue>(
    bytecode: Buffer,
    chunkName?: string
  ): T;

  /**
   * Create a new Lua table, optionally pre-populated with values.
   * Returns a handle for direct manipulation without execute_script.
   *
   * @param initial Optional initial values — a JS object for string keys,
   *   or an array for 1-indexed integer keys
   * @returns A live table handle
   * @example
   * const t = lua.create_table({ x: 1, y: 2 });
   * t.set('z', 3);
   * lua.set_global('point', t);
   * t.release();
   */
  create_table(initial?: { [key: string]: LuaInput } | LuaInput[]): LuaTableHandle;

  /**
   * Get a live reference to a global table.
   * Unlike get_global() which deep-copies plain tables, this returns a
   * handle that reads/writes the actual Lua table in place.
   *
   * @param name The global variable name
   * @returns A live table handle
   * @throws If the global does not exist or is not a table
   * @example
   * lua.execute_script('config = { host = "localhost", port = 5432 }');
   * const ref = lua.get_global_ref('config');
   * ref.get('host');  // 'localhost'
   * ref.set('debug', true);
   * ref.release();
   */
  get_global_ref(name: string): LuaTableHandle;

  /**
   * Create an environment table — a private global namespace a script can be
   * run in, so different scripts in the same context see different globals.
   *
   * The environment is an ordinary table reference: read and write it with the
   * handle methods to seed helpers or inspect what a script left behind, pass
   * it to {@link execute_script_in} to run code against it, and `release()` it
   * (or `lua.release(env)`) when done.
   *
   * Whitelisted names are copied by *value* — `math` in the environment is the
   * same table `_G.math` names, so a script that does `math.floor = nil`
   * changes it for everyone. Whitelist a name that is unset in `_G` and it is
   * simply absent. Whitelisting `'_G'` hands the script the real globals table
   * and defeats the isolation entirely.
   *
   * This restricts the global *namespace*, not the VM: use `maxMemory` and
   * `maxInstructions` for resource limits, and the `libraries` option to keep
   * dangerous libraries out of the context in the first place.
   *
   * @param options Which globals to seed, and whether to fall back to `_G`
   * @returns A live handle to the environment table
   * @example
   * const env = lua.create_environment({ whitelist: ['math', 'print'] });
   * env.set('answer', 42);
   * lua.execute_script_in(env, 'print(math.sqrt(16) + answer)');  // 46
   * lua.execute_script_in(env, 'return string.rep("x", 3)');      // throws: string is nil
   * env.release();
   */
  create_environment(options?: EnvironmentOptions): LuaEnvironment;

  /**
   * Execute a script with `env` installed as its `_ENV`, so the script's
   * global reads and writes resolve against that table instead of `_G`.
   *
   * Globals the script assigns land in `env` (visible via `env.get(...)`),
   * leaving the context's real globals untouched — even with
   * `inherit: true`, where reads fall through to `_G` but writes never do.
   *
   * Any table reference from this context works as an environment: an
   * environment from {@link create_environment}, a handle from
   * {@link create_table} or {@link get_global_ref}, or a metatabled-table
   * Proxy.
   *
   * @param env The environment (or any table reference) to run against
   * @param script The Lua script to execute
   * @returns The result of the script execution
   * @throws If the script errors, or if `env` is not a live table reference
   *   from this context
   * @example
   * const env = lua.create_environment({ whitelist: ['print'] });
   * lua.execute_script_in(env, 'counter = 1');
   * env.get('counter');            // 1
   * lua.get_global('counter');     // null — the real globals are untouched
   */
  execute_script_in<T extends LuaValue | LuaValue[] = LuaValue>(
    env: LuaEnvironment | LuaTableHandle,
    script: string
  ): T;

  /**
   * Registers a custom JS→Lua converter for values crossing into Lua.
   *
   * Converters are consulted in registration order, after internal round-trip
   * markers (metatabled-table Proxies and userdata handles) but before the
   * built-in handling of objects, arrays, and built-in types (Date, Map, Set,
   * Buffer, etc.). This lets application-specific types cross the boundary
   * under your control — and lets you override the built-in behavior for
   * types like Date or typed arrays.
   *
   * `match` is called with each object-typed value; if it returns a truthy
   * value, `convert` is called and its return value is converted to Lua
   * normally (so a converter may return a string, number, array, plain
   * object, etc.). Converters do not see primitives, functions, BigInt, or
   * Symbol values.
   *
   * Performance note: every registered `match` predicate runs for every
   * object-typed value crossing JS→Lua, in registration order, until one
   * matches. Keep `match` cheap and register only the converters you need.
   *
   * @param match Predicate deciding whether this converter applies to a value
   * @param convert Maps a matched value to a Lua-convertible JS value
   * @example
   * class Money { constructor(public cents: number) {} }
   * lua.register_type_converter(
   *   (v) => v instanceof Money,
   *   (v: Money) => ({ cents: v.cents, dollars: v.cents / 100 })
   * );
   * lua.set_global('price', new Money(1299));
   * lua.execute_script('return price.dollars'); // 12.99
   */
  register_type_converter(
    match: (value: unknown) => boolean,
    convert: (value: any) => LuaValue
  ): void;

  /**
   * Registers a converter for the Lua → JS direction: the mirror of
   * `register_type_converter`, for rebuilding application types out of the Lua
   * values that carry them.
   *
   * `match` is called with the value the built-in conversion produced — a plain
   * object for a Lua table, a Proxy for a metatabled one, the handle for opaque
   * userdata. If it returns a truthy value, `convert` is called and its return
   * value is used **verbatim**: the result is already a JS value, so unlike the
   * JS → Lua direction it is not converted again (which also means a converter
   * cannot loop by matching its own output).
   *
   * Converters are consulted at every level of the conversion, so they reach
   * values nested inside tables and arrays, and values arriving as callback
   * arguments — not just top-level results. They see only object-valued
   * results, mirroring how the JS → Lua direction skips primitives, which keeps
   * the common path free of a JS call per number and string. Registration order
   * decides precedence; the first match wins.
   *
   * Performance note: every registered `match` runs for every object-valued
   * result crossing Lua → JS, in registration order, until one matches. Keep
   * `match` cheap. Matching against a Proxy is not free either — each property
   * read runs the Lua `__index` path.
   *
   * @param match Predicate deciding whether this converter applies
   * @param convert Maps a matched value to the JS value the caller should see
   * @example
   * class Money { constructor(public cents: number) {} }
   *
   * // Lua -> JS
   * lua.register_from_lua_converter(
   *   (v: any) => v?.__type === 'Money',
   *   (v: any) => new Money(v.cents)
   * );
   * // JS -> Lua (the other half of the round trip)
   * lua.register_type_converter(
   *   (v) => v instanceof Money,
   *   (v: Money) => ({ __type: 'Money', cents: v.cents })
   * );
   *
   * lua.execute_script(`return { __type = 'Money', cents = 1299 }`);  // Money(1299)
   */
  register_from_lua_converter(
    match: (value: unknown) => boolean,
    convert: (value: any) => unknown
  ): void;

  /**
   * Registers a JavaScript class/usertype so Lua can construct and drive its
   * instances. Creates a global table `name` with a `new(...)` constructor.
   *
   * When Lua calls `name.new(...)`, the definition's `construct` function runs
   * and its returned object is held by reference as userdata bound to a shared
   * per-class metatable — so methods, property access, and overloaded operators
   * all dispatch back to JavaScript. Instances are garbage-collected by Lua.
   *
   * @param name The global class name in Lua (also the constructor table name)
   * @param definition Constructor, methods, metamethods, and property access flags
   * @example
   * class Vec {
   *   constructor(public x: number, public y: number) {}
   * }
   * lua.register_class('Vec', {
   *   construct: (x, y) => new Vec(x, y),
   *   readable: true,
   *   methods: {
   *     length: (self) => Math.hypot(self.x, self.y),
   *   },
   *   metamethods: {
   *     __add: (a, b) => new Vec(a.x + b.x, a.y + b.y),
   *     __tostring: (self) => `(${self.x}, ${self.y})`,
   *   },
   * });
   * lua.execute_script(`
   *   local a = Vec.new(3, 4)
   *   print(a:length())        -- 5
   *   print(tostring(a + Vec.new(1, 1)))  -- (4, 5)
   * `);
   */
  register_class(name: string, definition: ClassDefinition): void;

  /**
   * Calls a function in protected mode, returning a result object instead of
   * throwing. Mirrors Lua's `pcall`: on success `{ ok: true, value }`; on
   * failure `{ ok: false, error }`.
   *
   * Error fidelity is preserved — if the failure originated from a JS callback
   * that threw an `Error`, `error` is that original `Error` instance; otherwise
   * it is an `Error` whose message includes the Lua stack traceback.
   *
   * @param fn The function to call (typically a Lua function returned to JS)
   * @param args Arguments to pass to the function
   * @example
   * const fn = lua.execute_script<LuaFunction>('return function(x) if x < 0 then error("neg") end return x end');
   * const a = lua.pcall(fn, 5);   // { ok: true, value: 5 }
   * const b = lua.pcall(fn, -1);  // { ok: false, error: Error("...neg...") }
   */
  pcall(fn: LuaFunction | ((...args: LuaInput[]) => unknown), ...args: LuaInput[]): PcallResult;

  /**
   * Redirects Lua `print()` and `io.write()` output to a JavaScript handler.
   * The handler receives the fully-formatted output text — exactly what would
   * have been written to stdout (`print` joins its arguments with tabs, applies
   * `__tostring`, and appends a newline; `io.write` writes its arguments
   * verbatim). Pass `null` to restore output to stdout.
   *
   * @param handler Called with each chunk of output text, or `null` to clear
   * @example
   * const lines: string[] = [];
   * lua.set_print_handler((text) => lines.push(text));
   * lua.execute_script('print("hello", 42)'); // lines: ["hello\t42\n"]
   * lua.set_print_handler(null); // back to stdout
   */
  set_print_handler(handler?: ((text: string) => void) | null): void;

  /**
   * Installs a debug hook (`lua_sethook`) that reports execution events to a
   * JavaScript callback — the building block for profilers, tracers, and
   * debugger integrations.
   *
   * Setting a hook replaces any previous one. Call {@link remove_hook} to stop
   * tracing; calling it from inside the callback itself is safe and is the
   * usual way to trace only until some condition is met.
   *
   * **Cost.** `line` fires for every source line executed and crosses into JS
   * each time, which slows scripts down by orders of magnitude. Prefer `count`
   * with a coarse interval for sampling profilers.
   *
   * **Coroutines.** The hook is installed on the main state and inherited by
   * coroutine threads created *afterwards*, so set it before creating the
   * coroutines you want traced (the same rule as `maxInstructions`).
   *
   * **Async.** Hooks do not fire into JS during `execute_script_async` /
   * `execute_file_async`, which run Lua on a worker thread where calling
   * JavaScript is not permitted. Use `execute_async` (main thread) if you need
   * tracing with async.
   *
   * **Errors.** An exception thrown by the callback is swallowed rather than
   * corrupting the VM — the hook is a diagnostic channel, not a control one.
   * Use `maxInstructions` or `cancel()` to stop a running script.
   *
   * Coexists with `maxInstructions` and `cancel()`: they share one underlying
   * hook, so setting or removing a debug hook never disturbs them.
   *
   * @param callback Receives `(event, line, name)` for each event
   * @param options Which events to fire on — at least one is required
   * @throws If the callback is not a function, no event is requested, `count`
   *   is not a positive integer, or an async operation is in flight
   * @example
   * lua.set_hook((event, line) => {
   *   console.log(`${event} at line ${line}`);
   * }, { call: true, line: true });
   *
   * lua.execute_script(myScript);
   * lua.remove_hook();
   *
   * @example
   * // Sampling profiler: a count event every 10,000 instructions
   * const samples = new Map<number, number>();
   * lua.set_hook((_event, line) => {
   *   samples.set(line, (samples.get(line) ?? 0) + 1);
   * }, { count: 10_000 });
   */
  set_hook(callback: LuaHookCallback, options: HookOptions): void;

  /**
   * Removes the debug hook installed by {@link set_hook}. Safe to call when no
   * hook is set, and safe to call from inside the hook callback.
   *
   * `maxInstructions` and `cancel()` are unaffected — they use the same
   * underlying hook and keep working.
   */
  remove_hook(): void;

  /**
   * Adds a module searcher backed by JavaScript, enabling dynamic/virtual
   * `require()`. When Lua requires a module not already loaded or found by
   * earlier searchers, `searcher(name)` is called; return the module's Lua
   * source as a string to provide it, or `null`/`undefined` to let the next
   * searcher try. Requires the `package` library.
   *
   * Unlike `register_module` (a static preload), this resolves modules lazily,
   * so sources can come from a bundle, database, or in-memory map. Searchers
   * must be synchronous. Requiring a module caches it as usual.
   *
   * @param searcher Maps a module name to its Lua source, or null if unknown
   * @example
   * const modules = { greet: 'return function(n) return "Hi " .. n end' };
   * lua.add_searcher((name) => modules[name] ?? null);
   * lua.execute_script('return require("greet")("Ada")'); // "Hi Ada"
   */
  add_searcher(searcher: (name: string) => string | null | undefined): void;

  /**
   * Releases the Lua registry reference held by a value that crossed the
   * boundary: a Lua function returned to JS, a coroutine, or a table
   * reference (a `LuaTableHandle` or a metatabled-table Proxy).
   *
   * Without an explicit release, such references occupy their registry slot
   * until the JS wrapper is garbage-collected, which for long-lived contexts
   * that mint many references can accumulate significant Lua-side memory.
   * Releasing lets Lua's GC reclaim the referent on its next cycle.
   *
   * After release, using the wrapper throws a clear error ("Lua function has
   * been released" / "coroutine has been released" / "table handle has been
   * released"). Releasing the same value again is a safe no-op. Equivalent to
   * `handle.release()` for table handles.
   *
   * @param value The Lua function, coroutine, or table reference to release
   * @example
   * const fn = lua.execute_script<LuaFunction>('return function(x) return x * 2 end');
   * fn(21);          // 42
   * lua.release(fn); // registry slot freed
   * fn(21);          // throws: Lua function has been released
   */
  release(value: LuaFunction | LuaCoroutine | LuaTableRef | LuaTableHandle): void;

  /**
   * Discards the Lua state and replaces it with a fresh one carrying the same
   * options, without creating a new context. Intended for long-lived server
   * processes that run many independent scripts and would otherwise accumulate
   * global state (and memory) indefinitely.
   *
   * **Replayed automatically** onto the new state: the callbacks object passed
   * to `init()`, the print handler, the `allowBytecode` guard, and every path
   * added with `add_search_path`. Registered type converters are pure
   * JavaScript-side policy and are unaffected.
   *
   * **Not replayed** — these bind to Lua-side objects that die with the old
   * state and must be re-applied after a reset: `set_global`, `set_userdata`,
   * `set_metatable`, `register_module`, `register_class`, and `add_searcher`.
   *
   * Values that previously crossed into JavaScript (Lua functions, coroutines,
   * table references, opaque userdata) belong to the old state and are
   * invalidated: using one afterwards throws rather than reaching into the new
   * state. The old state itself is kept alive until the last such wrapper is
   * garbage-collected, so its memory is only reclaimed once they are gone —
   * `release()` them first to reclaim it immediately.
   *
   * Throws if an async operation is in flight (`is_busy()`), or if called while
   * Lua is executing — from inside a host callback, metamethod, or table trap —
   * since the state being retired is the one those frames are running on.
   *
   * @example
   * const lua = new lua_native.init({ log: console.log }, { libraries: 'safe' });
   * lua.execute_script('x = 42');
   * lua.reset();
   * lua.execute_script('return x');   // null — the state was reset
   * lua.execute_script('log("hi")');  // callbacks still work
   */
  reset(): void;

  /**
   * Runs a full garbage-collection cycle. Reclaims everything unreachable,
   * including running pending `__gc` finalizers.
   *
   * @example
   * lua.gc('collect');
   */
  gc(command: 'collect'): void;

  /**
   * Stops (`'stop'`) or resumes (`'restart'`) automatic collection. While
   * stopped, Lua collects only when you call `gc('collect')` or `gc('step')` —
   * useful for keeping a latency-sensitive batch free of collector pauses.
   *
   * A `maxMemory` limit stays enforced while the collector is stopped: Lua
   * still runs an emergency collection when an allocation would exceed the cap,
   * so stopping the collector cannot turn the limit into a spurious failure.
   *
   * @example
   * lua.gc('stop');
   * lua.execute_script('process_batch()');
   * lua.gc('restart');
   * lua.gc('collect');
   */
  gc(command: 'stop' | 'restart'): void;

  /**
   * Returns the memory Lua currently has in use, in kilobytes. The value has a
   * fractional part, so `gc('count') * 1024` is the exact byte count.
   *
   * This is Lua's own accounting; `get_memory_usage()` reports the same memory
   * in bytes as tallied by this binding's allocator.
   *
   * @example
   * const kb = lua.gc('count');
   */
  gc(command: 'count'): number;

  /** Returns whether automatic collection is currently running (not stopped). */
  gc(command: 'isrunning'): boolean;

  /**
   * Performs one garbage-collection step and returns whether the step finished
   * a collection cycle (in generational mode, a major collection).
   *
   * @param stepSize Number of bytes to treat as newly allocated; omit or pass 0
   *   for one basic step
   * @example
   * lua.gc('stop');
   * // Drive collection in small slices, interleaved with other work.
   * while (!lua.gc('step', 1024)) doSomeOtherWork();
   */
  gc(command: 'step', stepSize?: number): boolean;

  /**
   * Switches the collector mode and returns the previous mode. Generational
   * mode favors workloads that allocate many short-lived objects; incremental
   * mode spreads collection across smaller pauses.
   *
   * @example
   * const previous = lua.gc('generational'); // 'incremental'
   */
  gc(command: 'incremental' | 'generational'): LuaGCMode;

  /**
   * Reads or sets a collector tuning parameter, returning its previous value.
   * Omit `value` to read without changing anything. Values must be in the range
   * 0–100000.
   *
   * @param name The parameter to read or set
   * @param value The new value, or omit to read the current one
   * @example
   * const previousPause = lua.gc('param', 'pause');
   * lua.gc('param', 'pause', 400); // let the heap grow 4x before collecting
   */
  gc(command: 'param', name: LuaGCParam, value?: number): number;
}

/**
 * Garbage-collector modes reported and selected by `gc('incremental')` /
 * `gc('generational')`.
 */
export type LuaGCMode = 'incremental' | 'generational';

/**
 * Tunable garbage-collector parameters for `gc('param', name, value?)`. The
 * first three apply to generational mode, the last three to incremental mode.
 */
export type LuaGCParam =
  | 'minormul'
  | 'majorminor'
  | 'minormajor'
  | 'pause'
  | 'stepmul'
  | 'stepsize';

/**
 * Available Lua standard library names for selective loading
 */
export type LuaLibrary =
  | 'base'
  | 'package'
  | 'coroutine'
  | 'debug'
  | 'io'
  | 'math'
  | 'os'
  | 'string'
  | 'table'
  | 'utf8';

/**
 * Preset names for loading groups of standard libraries
 * - 'all': Load all 10 standard libraries
 * - 'safe': Load all except io, os, and debug (for sandboxing)
 */
export type LuaLibraryPreset = 'all' | 'safe';

/**
 * Options for configuring a new Lua context
 */
export interface LuaInitOptions {
  /**
   * Which Lua standard libraries to load. If omitted, NO libraries are loaded (bare state).
   *
   * - `'all'` — load all 10 standard libraries
   * - `'safe'` — load all except io, os, and debug (for sandboxing)
   * - `LuaLibrary[]` — load specific libraries by name
   * - `[]` — bare state with no standard libraries
   *
   * @example
   * // Load all libraries
   * { libraries: 'all' }
   *
   * // Safe sandboxed environment
   * { libraries: 'safe' }
   *
   * // Only load string and math
   * { libraries: ['base', 'string', 'math'] }
   */
  libraries?: LuaLibrary[] | LuaLibraryPreset;

  /**
   * Maximum memory (in bytes) the Lua state is allowed to allocate.
   * When the limit is reached, Lua throws an out-of-memory error.
   * Set to 0 or omit for unlimited memory.
   *
   * @example
   * // Limit to 10 MB
   * { maxMemory: 10 * 1024 * 1024 }
   *
   * // Limit to 256 KB (tight sandbox)
   * { maxMemory: 256 * 1024 }
   */
  maxMemory?: number;

  /**
   * Maximum number of Lua VM instructions a single execution may run before it
   * is aborted with an `"instruction limit exceeded"` error. This prevents an
   * infinite loop (`while true do end`) from hanging the process — the second
   * half of sandboxing alongside `maxMemory`. Set to 0 or omit for unlimited.
   *
   * The limit applies **per execution call**: each `execute_script`,
   * `execute_file`, `load_bytecode`, Lua-function call from JS, and each
   * coroutine `resume` gets a fresh budget. Enforcement is approximate to within
   * ~1000 instructions (the hook's sampling granularity).
   *
   * Because the budget resets on every entry, it bounds **pure-Lua** compute
   * only: a Lua loop whose body calls a JS callback that re-enters Lua (via a
   * returned function handle or another execution) restarts the counter each
   * re-entry. `maxInstructions` is not a wall-clock or total-work ceiling once
   * host callbacks re-enter the VM.
   *
   * Best set at construction so every coroutine created afterward inherits the
   * limit.
   *
   * @example
   * // Abort runaway scripts after ~10 million instructions
   * { maxInstructions: 10_000_000 }
   *
   * // Tight sandbox for untrusted code
   * { libraries: 'safe', maxMemory: 256 * 1024, maxInstructions: 1_000_000 }
   */
  maxInstructions?: number;

  /**
   * Maximum wall-clock time, in milliseconds, that a single execution may run
   * before it is aborted with an `"execution timeout"` error. Set to 0 or omit
   * for no timeout.
   *
   * Real time is the more intuitive budget; `maxInstructions` is the more
   * deterministic one. They are complements, not alternatives — set both and
   * whichever is reached first aborts the script.
   *
   * Like `maxInstructions`, the budget applies **per execution call**: each
   * `execute_script`, `execute_file`, `load_bytecode`, Lua-function call from
   * JS, and each coroutine `resume` starts a fresh deadline. Time a script
   * spends suspended awaiting a JS Promise under `execute_async` is therefore
   * not counted — the timeout bounds Lua compute per step, not the round trip.
   *
   * Enforcement is hook-driven, with two consequences: the deadline is checked
   * between VM instructions (so a single long-running C call — a huge
   * `string.rep`, or a host callback that blocks — is not interrupted), and
   * granularity is the hook's sampling interval, so expect overshoot on the
   * order of a few hundred microseconds rather than exactness.
   *
   * The clock is monotonic, so a system time change cannot shorten or extend a
   * running script.
   *
   * @example
   * // Abort any script that runs longer than 5 seconds
   * { timeout: 5000 }
   *
   * // Belt and braces for untrusted code
   * { libraries: 'safe', maxMemory: 256 * 1024, maxInstructions: 1_000_000, timeout: 1000 }
   */
  timeout?: number;

  /**
   * Redirects Lua `print()` and `io.write()` to this handler (see
   * `set_print_handler`). The handler receives the formatted output text.
   * Equivalent to calling `set_print_handler` right after construction, and
   * takes precedence over a `print` provided in the callbacks object.
   */
  print?: (text: string) => void;

  /**
   * When `false`, this context refuses to load Lua bytecode: `load_bytecode()`
   * throws, and Lua's `load()` is forced to text-only mode so binary chunks are
   * rejected. Loading untrusted bytecode is unsafe, so disable it when running
   * untrusted scripts. Default: `true`.
   */
  allowBytecode?: boolean;

  /**
   * Shared tables to publish as globals in this context, keyed by the global
   * name each should take. Every subscribing context receives the shared
   * table's current value at construction and every subsequent update.
   *
   * @example
   * const shared = lua_native.createSharedTable({ debug: true });
   * const lua1 = new lua_native.init({}, { shared: { settings: shared } });
   * const lua2 = new lua_native.init({}, { shared: { settings: shared } });
   * shared.set('debug', false);  // both contexts see settings.debug === false
   *
   * @see {@link SharedTable} for the propagation model and its limits
   */
  shared?: Record<string, SharedTable>;
}

/**
 * A JS-side value mirrored as a global in one or more Lua contexts.
 *
 * Lua states cannot share memory, so "shared" here means **synchronized
 * copies**: the shared table holds one JavaScript object and pushes it into
 * every subscribed context's global namespace. Subscribe a context by passing
 * the shared table in the `shared` init option.
 *
 * Propagation has two properties worth knowing:
 *
 * - **One-way (JS → Lua).** A Lua script that assigns into the shared global
 *   changes only its own context's copy; that edit is not seen by the other
 *   contexts and does not update the JS-side value. Read a context's own view
 *   back with `get_global()` if you need it.
 * - **Whole-value.** Each update re-pushes the entire value into every
 *   subscriber, so a large shared table costs proportionally on every `set()`
 *   or `sync()`.
 *
 * A context that rejects an update (one busy with an async operation, say) is
 * reported in the error thrown by `set()`/`sync()` — after every other context
 * has been updated. The JS-side value is always updated; `sync()` retries.
 *
 * Subscriptions do not keep a context alive: once a context is garbage
 * collected it is dropped from the subscriber list.
 *
 * @example
 * const shared = lua_native.createSharedTable({ mode: 'dev' });
 * const lua1 = new lua_native.init({}, { shared: { settings: shared } });
 * const lua2 = new lua_native.init({}, { shared: { settings: shared } });
 *
 * shared.set('mode', 'prod');
 * lua1.execute_script("return settings.mode");  // 'prod'
 * lua2.execute_script("return settings.mode");  // 'prod'
 */
export interface SharedTable {
  /**
   * Read a top-level field of the shared value. This reads the JavaScript-side
   * object, not any one context's copy — so a Lua-side edit is not reflected
   * here.
   */
  get(key: string): LuaValue;

  /**
   * Set a top-level field and immediately publish the whole value to every
   * subscribed context.
   *
   * @throws If a subscriber rejects the update. The JS-side value is still
   *   updated and the other contexts still receive it; call `sync()` to retry.
   */
  set(key: string, value: LuaInput): void;

  /**
   * Re-publish the current value to every subscribed context. Use it after
   * mutating the shared object directly (including through a nested object
   * returned by `get()`), or to retry a `set()` that a busy context rejected.
   *
   * @throws If a subscriber rejects the update.
   */
  sync(): void;
}

/**
 * The main Lua module interface
 */
export interface LuaNative {
  /**
   * Creates a new Lua context with the provided callbacks and values
   * @param callbacks Object containing functions and values to be available in Lua
   * @param options Optional configuration for the Lua context
   */
  init: new (callbacks?: LuaCallbacks, options?: LuaInitOptions) => LuaContext;

  /**
   * Creates a shared table: a JavaScript object that can be published as a
   * global in several Lua contexts and kept in step across them.
   *
   * The object is held, not copied — mutating the object you passed in and
   * calling `sync()` publishes the change, and `get()` returns live nested
   * objects.
   *
   * @param initial The object to share. Defaults to an empty object.
   * @example
   * const shared = lua_native.createSharedTable({ config: { debug: true } });
   * const lua = new lua_native.init({}, { shared: { settings: shared } });
   * lua.execute_script('return settings.config.debug');  // true
   */
  createSharedTable(initial?: Record<string, LuaInput> | LuaInput[]): SharedTable;
}
