// Shared by `run.mjs` (the WASM build) and `vcpkg-lua.mjs` (the Lua install):
// where the toolchain is, which version it is, and whether a `liblua.a` is the
// one the module can link against. Nothing here builds anything.
//
// Why these checks exist is `docs/reviews/WASM-TARGET-PLAN.md` §2.3 and D5.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

export const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');

// The one Emscripten version this target has been measured on. Exception
// handling, `longjmp` lowering and Embind all changed between releases, so a
// different version is a different target until someone re-runs Phase 0's
// cells on it and edits this line.
export const EMSCRIPTEN_VERSION = '7.0.1';

export const TRIPLET = 'wasm32-emscripten';

export class ToolchainError extends Error {}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ToolchainError(`'${command}' is not on PATH. Install Emscripten ${EMSCRIPTEN_VERSION} (Homebrew: brew install emscripten).`);
    }
    throw new ToolchainError(`'${command} ${args.join(' ')}' failed:\n${error.stderr || error.message}`);
  }
}

// The `emcc` on PATH can be a wrapper with no toolchain file beside it
// (Homebrew's is), so the root is asked for rather than derived from PATH.
// vcpkg's triplet needs it in the environment; nothing else sets it.
export function emscriptenRoot() {
  const root = process.env.EMSCRIPTEN_ROOT || run('em-config', ['EMSCRIPTEN_ROOT']);
  if (!fs.existsSync(path.join(root, 'cmake', 'Modules', 'Platform', 'Emscripten.cmake'))) {
    throw new ToolchainError(`EMSCRIPTEN_ROOT is '${root}', which has no cmake/Modules/Platform/Emscripten.cmake.`);
  }
  return root;
}

export function emscriptenVersion(root) {
  // "7.0.1-git" on a Homebrew build; the suffix is not part of the version.
  const raw = fs.readFileSync(path.join(root, 'emscripten-version.txt'), 'utf8').trim().replace(/^"|"$/g, '');
  return { raw, version: raw.replace(/-.*$/, '') };
}

export function requireEmscripten() {
  const root = emscriptenRoot();
  const { raw, version } = emscriptenVersion(root);
  if (version !== EMSCRIPTEN_VERSION) {
    throw new ToolchainError(
      `Emscripten ${raw} found at ${root}; this target is recorded against ${EMSCRIPTEN_VERSION}.\n` +
      `Re-run Phase 0's cells on the new version before changing EMSCRIPTEN_VERSION in tools/wasm-build/toolchain.mjs.`
    );
  }
  return { root, raw, version };
}

export function vcpkgRoot() {
  const root = process.env.VCPKG_ROOT || path.join(process.env.HOME || '', 'vcpkg');
  if (!fs.existsSync(path.join(root, 'vcpkg'))) {
    throw new ToolchainError(`No vcpkg at '${root}'. Set VCPKG_ROOT.`);
  }
  return root;
}

export function luaPaths() {
  const installed = path.join(vcpkgRoot(), 'installed', TRIPLET);
  return { include: path.join(installed, 'include'), lib: path.join(installed, 'lib', 'liblua.a') };
}

// Which `longjmp` runtime a `liblua.a` was built against, read off its
// undefined symbols. `wasm` is the overlay triplet's; `emscripten` is the
// stock triplet's, which links only under `-fexceptions` and does not behave
// there (plan §2.3, cells A and B).
export function luaLongjmpRuntime(lib) {
  if (!fs.existsSync(lib)) {
    throw new ToolchainError(`No WASM Lua at ${lib}.\nRun: npm run vcpkg-lua-wasm`);
  }
  const symbols = new Set(
    run('emnm', ['-u', lib]).split('\n').map(line => line.trim().split(/\s+/).pop())
  );
  const wasm = ['__wasm_longjmp', '__c_longjmp'].filter(s => symbols.has(s));
  const js = ['emscripten_longjmp', 'getTempRet0'].filter(s => symbols.has(s));
  const runtime = wasm.length && !js.length ? 'wasm' : js.length && !wasm.length ? 'emscripten' : 'unknown';
  return { runtime, symbols: [...wasm, ...js], asksForCCallLimit: symbols.has('lua_native_max_c_calls') };
}

export function requireOverlayLua() {
  const paths = luaPaths();
  const found = luaLongjmpRuntime(paths.lib);
  if (found.runtime !== 'wasm') {
    throw new ToolchainError(
      `${paths.lib} references the '${found.runtime}' longjmp runtime (${found.symbols.join(', ') || 'no longjmp symbols'}).\n` +
      `The module needs the overlay triplet's library. A bare 'vcpkg install lua:${TRIPLET}' produces the other one.\n` +
      `Run: npm run vcpkg-lua-wasm`
    );
  }
  // Without it Lua's limit is the constant 200, and a thread with a smaller
  // stack loses the context instead of raising "C stack overflow".
  if (!found.asksForCCallLimit) {
    throw new ToolchainError(
      `${paths.lib} was built without triplets/lua-wasm-stack.h: its C-call limit is a constant.\n` +
      `Run: npm run vcpkg-lua-wasm`
    );
  }
  return { ...paths, ...found };
}
