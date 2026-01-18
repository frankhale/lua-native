import type { LuaNative } from './types';
export type { LuaCallback, LuaCallbacks, LuaContext, LuaNative } from './types';

declare const lua_module: LuaNative;
export default lua_module;