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
 * Represents a Lua table with string keys
 */
export interface LuaTable {
  [key: string]: LuaValue;
}

/**
 * Represents a function that can be called from Lua or returned from Lua
 */
export interface LuaFunction {
  (...args: LuaValue[]): LuaValue | LuaValue[] | void;
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
  [key: string]: LuaCallback | LuaValue;
}

/**
 * Defines a Lua metatable with metamethods and/or static values.
 * Functions become Lua C closures; other values are set directly.
 */
export interface MetatableDefinition {
  [key: string]: LuaCallback | LuaValue;
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
  (self: any, ...args: LuaValue[]): LuaValue | LuaValue[] | void;
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
  set(key: string | number, value: LuaValue): void;

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
   * Sets a global variable or function in the Lua environment
   * @param name The name of the global variable or function
   * @param value The value to set (function, number, boolean, string, or object)
   */
  set_global(name: string, value: LuaValue | LuaCallback): void;

  /**
   * Gets a global variable from the Lua environment
   * @param name The name of the global variable
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
  resume(coroutine: LuaCoroutine, ...args: LuaValue[]): CoroutineResult;

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
  create_table(initial?: LuaTable | LuaValue[]): LuaTableHandle;

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
  pcall(fn: LuaFunction | ((...args: LuaValue[]) => unknown), ...args: LuaValue[]): PcallResult;

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
  set_print_handler(handler: ((text: string) => void) | null): void;

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
}

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
