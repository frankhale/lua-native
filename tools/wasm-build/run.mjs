// npm run build-wasm-debug | build-wasm-release
//   node tools/wasm-build/run.mjs <debug|release> [--stack-size=<bytes>] [--no-check]
//
// Builds the WASM target: the core (`src/core/lua-runtime.cpp`) and the WASM
// binding (`src/wasm/lua-wasm.cpp`), linked against the overlay triplet's
// `liblua.a` into two variants from the same objects:
//
//   node   -sNODERAWFS=1, -sENVIRONMENT=node. `execute_file` and the fixtures
//          see the real disk. Exists so the suite and the harnesses can run
//          against this target under Node; it never ships.
//   web    in-memory filesystem, -sENVIRONMENT=web,worker. The one that ships.
//
// Output is `build-wasm/<config>/<variant>/`, holding `lua-native-core.mjs` and
// `lua-native-core.wasm` (Emscripten's) and `lua-native.mjs` (a copy of
// `src/wasm/shell.js`, the file a loader imports). **Not `build/`**:
// `node-gyp rebuild` deletes that directory first, so a WASM build kept there
// would vanish on every `npm run build-debug`.
//
// The native target is not touched by anything here: node-gyp, `binding.gyp`
// and `index.js` neither know nor care that this script exists
// (`docs/reviews/WASM-TARGET-PLAN.md` D7).
//
// It ends by running `check.mjs` against what it built, because a build script
// that reports success should show the thing it built doing something.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  REPO, ToolchainError, requireEmscripten, requireOverlayLua,
} from './toolchain.mjs';

// The stack lives in linear memory, cannot grow, and — without the debug
// build's checks — overflows without a word (Emscripten's `settings.js` says so
// in as many words). Emscripten's default is 64 KiB. Lua bounds its own C-level
// nesting at LUAI_MAXCCALLS (200), so the question "how much is enough" has an
// answer that can be measured: the deepest chains a script can build before Lua
// itself refuses. `check.mjs` builds them on every run. See STACK-SIZE in
// `docs/reviews/WASM-TARGET-PLAN.md` §2.4 for the measurement behind this number.
export const STACK_SIZE = 1024 * 1024;

// Passed at compile and at link, in both variants. `-sSUPPORT_LONGJMP=wasm` is
// what `-fwasm-exceptions` already implies; it is spelled out because it is the
// flag `liblua.a` was built with and the two must agree.
const COMMON = ['-fwasm-exceptions', '-sSUPPORT_LONGJMP=wasm'];

const CONFIGS = {
  debug: {
    compile: ['-O0', '-g'],
    link: ['-O0', '-g', '-sASSERTIONS=1', '-sSTACK_OVERFLOW_CHECK=2',
      // Where the checked stack is, for the shell to put the limits back to.
      '-sEXPORTED_FUNCTIONS=_emscripten_stack_get_base,_emscripten_stack_get_end'],
  },
  release: {
    compile: ['-O2'],
    link: ['-O2'],
  },
};

const VARIANTS = {
  node: ['-sENVIRONMENT=node', '-sNODERAWFS=1'],
  web: ['-sENVIRONMENT=web,worker'],
};

const SOURCES = [
  'src/core/lua-runtime.cpp',
  'src/wasm/js.cpp',
  'src/wasm/stack.cpp',
  'src/wasm/suspend.cpp',
  'src/wasm/lua-wasm.cpp',
];

function parseArgs(argv) {
  const config = argv.find(a => !a.startsWith('--'));
  if (!Object.hasOwn(CONFIGS, config ?? '')) {
    throw new ToolchainError(`usage: node tools/wasm-build/run.mjs <${Object.keys(CONFIGS).join('|')}> [--stack-size=<bytes>] [--no-check]`);
  }
  const stackArg = argv.find(a => a.startsWith('--stack-size='));
  const stackSize = stackArg ? Number(stackArg.split('=')[1]) : STACK_SIZE;
  if (!Number.isInteger(stackSize) || stackSize <= 0) {
    throw new ToolchainError(`--stack-size wants a positive integer number of bytes, got '${stackArg}'.`);
  }
  return { config, stackSize, check: !argv.includes('--no-check') };
}

function emxx(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('em++', args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', code => (code === 0
      ? resolve()
      : reject(new ToolchainError(`em++ exited ${code}:\n  em++ ${args.join(' ')}`))));
  });
}

function sizes(file) {
  const bytes = fs.readFileSync(file);
  return { raw: bytes.length, gzip: zlib.gzipSync(bytes, { level: 9 }).length };
}

const kb = n => `${(n / 1024).toFixed(0)} KB`;

async function main() {
  const { config, stackSize, check } = parseArgs(process.argv.slice(2));
  const emscripten = requireEmscripten();
  const lua = requireOverlayLua();
  const env = { ...process.env, EMSCRIPTEN_ROOT: emscripten.root };

  const out = path.join(REPO, 'build-wasm', config);
  const objDir = path.join(out, 'obj');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(objDir, { recursive: true });

  console.log(`wasm-build: ${config}, emscripten ${emscripten.raw}, longjmp ${lua.runtime}, stack ${stackSize} bytes`);

  const includes = [`-I${lua.include}`, `-I${path.join(REPO, 'src')}`];
  const objects = SOURCES.map(source => path.join(objDir, `${path.basename(source, '.cpp')}.o`));
  await Promise.all(SOURCES.map((source, i) => emxx(
    ['-std=c++17', ...COMMON, ...CONFIGS[config].compile, ...includes, '-c', path.join(REPO, source), '-o', objects[i]],
    env,
  )));

  for (const [variant, flags] of Object.entries(VARIANTS)) {
    const dir = path.join(out, variant);
    fs.mkdirSync(dir, { recursive: true });
    await emxx([
      '-std=c++17', ...COMMON, ...CONFIGS[config].link,
      ...objects, lua.lib,
      '-lembind',
      '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createLuaNativeCore',
      '-sALLOW_MEMORY_GROWTH=1',
      // What the shell needs to notice, and tidy up after, a JavaScript
      // exception that unwound WASM frames ("foreign exceptions" in
      // src/wasm/shell.js): a view of the module's memory and its stack pointer.
      '-sEXPORTED_RUNTIME_METHODS=HEAPU32,stackSave,stackRestore,wasmTable',
      // The shell adds one function to the table: the one that suspends.
      '-sALLOW_TABLE_GROWTH=1',
      `-sSTACK_SIZE=${stackSize}`,
      ...flags,
      '-o', path.join(dir, 'lua-native-core.mjs'),
    ], env);
    fs.copyFileSync(path.join(REPO, 'src', 'wasm', 'shell.js'), path.join(dir, 'lua-native.mjs'));

    const wasm = sizes(path.join(dir, 'lua-native-core.wasm'));
    const glue = sizes(path.join(dir, 'lua-native-core.mjs'));
    console.log(`  ${variant.padEnd(4)}  wasm ${kb(wasm.raw)} (${kb(wasm.gzip)} gzip)   glue ${kb(glue.raw)} (${kb(glue.gzip)} gzip)   ${path.relative(REPO, dir)}/`);
  }

  if (!check) {
    console.log('wasm-build: built; check skipped (--no-check).');
    return;
  }
  const checked = spawnSync(process.execPath, [path.join(REPO, 'tools', 'wasm-build', 'check.mjs'), config], { stdio: 'inherit' });
  if (checked.status !== 0) {
    throw new ToolchainError('the build check failed; the output above says where.');
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof ToolchainError)) throw error;
  console.error(`wasm-build: ${error.message}`);
  process.exit(1);
}
