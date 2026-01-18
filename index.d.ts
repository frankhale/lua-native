import type { LuaNative } from './types';
export type {
  LuaCallback,
  LuaCallbacks,
  LuaContext,
  LuaFunction,
  LuaNative,
  LuaTable,
  LuaValue,
} from './types';

declare const lua_module: LuaNative;
export default lua_module;