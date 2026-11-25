// The development loader: which build of lua-native the suite and the
// harnesses run against. Not published, and not how a consumer loads anything —
// Node consumers get `index.js`, browser consumers will get `browser.js`.
//
//   LUA_NATIVE_TARGET unset, empty or `native`
//       `index.js`'s default export — the very object every caller here got
//       before this file existed.
//   LUA_NATIVE_TARGET=wasm
//       the node variant of the debug WASM build  (npm run build-wasm-debug)
//   LUA_NATIVE_TARGET=wasm-release
//       the node variant of the release WASM build (npm run build-wasm-release)
//
// Two rules, both about not lying to whoever reads a green run:
//
//   - **No fallback.** A WASM target that is not built is an error naming the
//     path. It never quietly becomes the native binary, which would report the
//     native target's results under the other one's name.
//   - **An unknown value is an error**, for the same reason: a typo must not
//     mean `native`.
//
// An environment variable rather than an argument because `exception-matrix`
// and `lifecycle-matrix` run one process per cell, and children inherit it.
//
// `index.js` is not edited to make this work (`docs/WASM-TARGET-PLAN.md` D7).

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const WASM_CONFIGS = { wasm: 'debug', 'wasm-release': 'release' };

const requested = process.env.LUA_NATIVE_TARGET ?? '';

async function load() {
  if (requested === '' || requested === 'native') {
    return { target: 'native', module: (await import('../index.js')).default };
  }
  if (!Object.hasOwn(WASM_CONFIGS, requested)) {
    throw new Error(
      `LUA_NATIVE_TARGET is '${requested}'. Known targets: native (or unset), ${Object.keys(WASM_CONFIGS).join(', ')}.`
    );
  }
  const config = WASM_CONFIGS[requested];
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const entry = path.resolve(here, '..', 'build-wasm', config, 'node', 'lua-native.mjs');
  if (!fs.existsSync(entry)) {
    throw new Error(
      `LUA_NATIVE_TARGET=${requested}, but there is no WASM build at\n  ${entry}\n` +
      `Run 'npm run build-wasm-${config}'. This loader does not fall back to the native binary.`
    );
  }
  return { target: requested, module: (await import(url.pathToFileURL(entry).href)).default };
}

const loaded = await load();

/** Which target was loaded: `native`, `wasm` or `wasm-release`. */
export const target = loaded.target;

export default loaded.module;
