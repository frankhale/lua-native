import type { LuaNative } from './types.js';
export type {
  ClassDefinition,
  CompileOptions,
  CoroutineResult,
  LuaCallback,
  LuaCallbacks,
  LuaContext,
  LuaCoroutine,
  LuaFunction,
  LuaInitOptions,
  LuaInput,
  LuaLibrary,
  LuaLibraryPreset,
  LuaNative,
  LuaTable,
  LuaTableHandle,
  LuaTableRef,
  LuaValue,
  MetatableDefinition,
  PcallResult,
  UserdataMethod,
  UserdataOptions,
} from './types.js';

declare const lua_module: LuaNative;
export default lua_module;