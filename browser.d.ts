// Types for the browser entry (`browser.js`), which `package.json`'s `exports`
// map selects under the `browser` condition.
//
// The contract is `types.d.ts`, unchanged, with one difference restated here:
// **bytecode is a `Uint8Array`, not a Node `Buffer`** — a browser has no
// `Buffer`. `compile()` and `compile_file()` return a plain `Uint8Array`, and
// `load_bytecode()` takes one. `types.d.ts` itself is not narrowed, because
// that would take `Buffer`'s methods away from Node consumers
// (`docs/reviews/WASM-TARGET-PLAN.md` D4).
//
// Everything else is re-exported as it is. `types.d.ts` begins with a
// reference to Node's ambient types, for that same `Buffer`; `@types/node` is
// an optional peer dependency, so a browser project without it needs
// `skipLibCheck` (TypeScript's default in most templates) and nothing else.
import type {
  CompileOptions,
  LuaCallbacks,
  LuaContext as NodeLuaContext,
  LuaInitOptions,
  LuaNative as NodeLuaNative,
  LuaValue,
} from './types.js';

export type {
  ClassDefinition,
  CompileOptions,
  CoroutineResult,
  EnvironmentOptions,
  HookOptions,
  LuaCallback,
  LuaCallbacks,
  LuaCoroutine,
  LuaEnvironment,
  LuaFunction,
  LuaGCMode,
  LuaGCParam,
  LuaHookCallback,
  LuaHookEvent,
  LuaInitOptions,
  LuaInput,
  LuaLibrary,
  LuaLibraryPreset,
  LuaStateInfo,
  LuaTable,
  LuaTableHandle,
  LuaTableRef,
  LuaValue,
  MetatableDefinition,
  PcallResult,
  SharedTable,
  UserdataMethod,
  UserdataOptions,
} from './types.js';

/** A Lua context, as `types.d.ts` describes it, with bytecode as a `Uint8Array`. */
export interface LuaContext extends Omit<NodeLuaContext, 'compile' | 'compile_file' | 'load_bytecode'> {
  /**
   * Compiles Lua source code to bytecode without executing it.
   * @returns A plain `Uint8Array` holding the compiled chunk
   */
  compile(script: string, options?: CompileOptions): Uint8Array;

  /**
   * Compiles a Lua file to bytecode without executing it. In a page the file
   * is one in the module's in-memory filesystem.
   * @returns A plain `Uint8Array` holding the compiled chunk
   */
  compile_file(filepath: string, options?: CompileOptions): Uint8Array;

  /**
   * Loads and executes precompiled Lua bytecode.
   * @param bytecode Bytes from `compile()`, `compile_file()` or `luac`
   * @param chunkName Optional name for error messages. Default: "bytecode"
   */
  load_bytecode<T extends LuaValue | LuaValue[] = LuaValue>(bytecode: Uint8Array, chunkName?: string): T;
}

/** The module's default export, as `types.d.ts` describes it, creating the context above. */
export interface LuaNative extends Omit<NodeLuaNative, 'init'> {
  init: new (callbacks?: LuaCallbacks, options?: LuaInitOptions) => LuaContext;
}

declare const lua_module: LuaNative;
export default lua_module;
