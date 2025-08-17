// Type definitions for the Lua module

/**
 * Callback function that can be passed to the Lua context
 */
export interface LuaCallback {
  (...args: any[]): any;
}

/**
 * Object containing callbacks and values that will be available in the Lua environment
 */
export interface LuaCallbacks {
  [key: string]: LuaCallback | number | boolean | string | object;
}

/**
 * Represents a Lua execution context
 */
export interface LuaContext {
  /**
   * Executes a Lua script string and returns the result
   * @param script The Lua script to execute
   * @returns The result of the script execution
   */
  execute_script(script: string): any;
  
  /**
   * Sets a global variable or function in the Lua environment
   * @param name The name of the global variable or function
   * @param value The value to set (function, number, boolean, string, or object)
   */
  set_global(name: string, value: any): void;
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
