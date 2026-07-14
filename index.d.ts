import type { LuaNative } from './types';
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
} from './types';

declare const lua_module: LuaNative;
export default lua_module;