// Types for the development loader. Both targets answer to the one contract,
// `types.d.ts`, so the default export is typed as `index.js`'s is.
import lua_native from '../index.js';

export default lua_native;

/** Which target was loaded, from `LUA_NATIVE_TARGET`. */
export declare const target: 'native' | 'wasm' | 'wasm-release';
