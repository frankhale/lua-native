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
 * Represents a Lua coroutine that can be resumed from JavaScript
 */
export interface LuaCoroutine {
  /** The current status of the coroutine */
  status: 'suspended' | 'running' | 'dead';
  /** Internal reference - do not modify */
  _coroutine: unknown;
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
   * Sets a metatable on an existing global Lua table, enabling operator
   * overloading, custom indexing, __tostring, __call, and other metamethods.
   *
   * @param name The name of an existing global table
   * @param metatable An object whose keys are metamethod names (e.g. __add, __tostring)
   *   and values are either callback functions or static Lua values
   * @example
   * lua.execute_script('vec = {x = 1, y = 2}');
   * lua.set_metatable('vec', {
   *   __tostring: (t) => `(${t.x}, ${t.y})`,
   *   __add: (a, b) => { ... }
   * });
   */
  set_metatable(name: string, metatable: MetatableDefinition): void;

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
   * Creates a coroutine from a Lua script that returns a function.
   * @param script A Lua script that returns a function to be used as the coroutine body
   * @returns A coroutine object that can be resumed
   * @example
   * const coro = lua.create_coroutine(`
   *   return function(x)
   *     coroutine.yield(x * 2)
   *     coroutine.yield(x * 3)
   *     return x * 4
   *   end
   * `);
   */
  create_coroutine(script: string): LuaCoroutine;

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
}
