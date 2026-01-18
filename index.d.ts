import type { LuaNative } from './types';
export type {
  CoroutineResult,
  LuaCallback,
  LuaCallbacks,
  LuaContext,
  LuaCoroutine,
  LuaFunction,
  LuaNative,
  LuaTable,
  LuaValue,
} from './types';

declare const lua_module: LuaNative;
export default lua_module;