// Types for the development loader. Both targets answer to the one contract,
// `types.d.ts`, so the default export is typed as `index.js`'s is.
import lua_native from '../index.js';

export default lua_native;

/** Which target was loaded, from `LUA_NATIVE_TARGET`. */
export declare const target: 'native' | 'wasm' | 'wasm-release';

/** Which binding the loaded module was observed to be (the Phase 3 control). */
export declare const observed: 'native' | 'wasm';

/** `native` or `wasm`: the binding a target name asks for. */
export declare function familyOf(name: string): 'native' | 'wasm';

/** Which binding `module` is, by what its `compile()` returns. */
export declare function observeTarget(module: typeof lua_native): 'native' | 'wasm';

/** Throws unless `module` is observed to be the binding `name` asks for. */
export declare function assertOnTarget(name: string, module: typeof lua_native): 'native' | 'wasm';
