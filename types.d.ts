// Type definitions for the Lua module

/**
 * Represents a value that can be passed to or returned from Lua.
 * This includes all primitive types, arrays, objects, and functions.
 */
export type LuaValue =
  | null
  | boolean
  | number
  | string
  | LuaValue[]
  | LuaTable
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
   * Sets a global variable or function in the Lua environment
   * @param name The name of the global variable or function
   * @param value The value to set (function, number, boolean, string, or object)
   */
  set_global(name: string, value: LuaValue | LuaCallback): void;

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
 * The main Lua module interface
 */
export interface LuaNative {
  /**
   * Creates a new Lua context with the provided callbacks and values
   * @param callbacks Object containing functions and values to be available in Lua
   */
  init: new (callbacks?: LuaCallbacks) => LuaContext;
}
