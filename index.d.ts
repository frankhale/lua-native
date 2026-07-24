import type { LuaNative } from './types.js';
export type {
  ClassDefinition,
  CompileOptions,
  CoroutineResult,
  EnvironmentOptions,
  LuaCallback,
  LuaCallbacks,
  LuaContext,
  LuaCoroutine,
  LuaEnvironment,
  LuaFunction,
  LuaGCMode,
  LuaGCParam,
  LuaInitOptions,
  LuaInput,
  LuaLibrary,
  LuaLibraryPreset,
  LuaNative,
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

declare const lua_module: LuaNative;
export default lua_module;