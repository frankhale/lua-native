import type { LuaNative } from './types';
export type {
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
  LuaTableRef,
  LuaValue,
} from './types';

declare const lua_module: LuaNative;
export default lua_module;