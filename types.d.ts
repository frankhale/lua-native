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
  | string
  | LuaValue[]
  | LuaTable
  | LuaTableRef
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
 * Options for set_userdata controlling property access from Lua
 */
export interface UserdataOptions {
  /** Allow Lua to read properties via __index */
  readable?: boolean;
  /** Allow Lua to write properties via __newindex */
  writable?: boolean;
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
