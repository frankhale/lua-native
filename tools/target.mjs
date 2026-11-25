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
// `index.js` is not edited to make this work (`docs/reviews/WASM-TARGET-PLAN.md` D7).

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

// --- The control: which binding answered? -------------------------------------
//
// Everything above is the loader's own say-so: it knows which path it
// imported. A run on the wrong binary reports a clean column that searched
// nothing — the vacuity `roundtrip-matrix` guards its modes against — so every
// process that imports this file also *observes* the module it got, and
// refuses to go on if the observation and the request disagree
// (`docs/reviews/WASM-TARGET-PLAN.md`, Phase 3, item 1).
//
// The observation uses no API added for the purpose: `compile()` answers with
// a `Buffer` from the N-API binding and a plain `Uint8Array` from the WASM one
// (D4). It runs on a native run too, so a native result is equally proven to
// be native. The context it makes is disposed before anything else runs.
//
// That this can report dirty — each module handed in under the other's name —
// is shown by `tools/wasm-verify/run.mjs --control`.

/** `native` or `wasm`: the binding a target name asks for. */
export const familyOf = (name) => (Object.hasOwn(WASM_CONFIGS, name) ? 'wasm' : 'native');

/** Which binding `module` is, by what its `compile()` returns. */
export function observeTarget(module) {
  const lua = new module.init({}, {});
  let bytecode;
  try {
    bytecode = lua.compile('return 1');
  } finally {
    lua.dispose();
  }
  if (Buffer.isBuffer(bytecode)) return 'native';
  if (Object.getPrototypeOf(bytecode) === Uint8Array.prototype) return 'wasm';
  throw new Error(
    `tools/target.mjs: compile() returned ${Object.prototype.toString.call(bytecode)}, ` +
    'which is neither binding\'s answer. The control cannot tell which module this is.'
  );
}

/** Throws unless `module` is observed to be the binding `name` asks for. */
export function assertOnTarget(name, module) {
  const seen = observeTarget(module);
  if (seen !== familyOf(name)) {
    throw new Error(
      `tools/target.mjs: asked for the ${familyOf(name)} binding (LUA_NATIVE_TARGET=${name || 'native'}) ` +
      `but the module that loaded is observed to be the ${seen} one. Nothing run against it would be about ${name || 'native'}.`
    );
  }
  return seen;
}

const loaded = await load();

/** Which binding the loaded module was observed to be: `native` or `wasm`. */
export const observed = assertOnTarget(loaded.target, loaded.module);

/** Which target was loaded: `native`, `wasm` or `wasm-release`. */
export const target = loaded.target;

export default loaded.module;
