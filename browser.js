// The browser entry: `import lua_native from 'lua-native'` in a page or a
// bundle resolves here, through the `browser` condition of `package.json`'s
// `exports` map (`docs/reviews/WASM-TARGET-PLAN.md` D6). Under Node the same specifier
// resolves to `index.js` and the native addon, as it always has.
//
// It exports the same default object `index.js` does, with the same API
// (`types.d.ts`), built on WebAssembly and with no N-API. The module below is
// the web variant of the release build; it instantiates the `.wasm` with a
// top-level `await`, so the object is ready to use the moment this import
// settles — which is what makes this one line the same on both targets.
//
// A static re-export, deliberately: a bundler follows it, and follows the
// `new URL('lua-native-core.wasm', import.meta.url)` inside to the `.wasm`,
// with no plugin and no configuration.
//
// Like `prebuilds/`, the three files under `build-wasm/release/web/` are built
// locally (`npm run build-wasm-release`) and published, never committed.
export { default } from './build-wasm/release/web/lua-native.mjs';
