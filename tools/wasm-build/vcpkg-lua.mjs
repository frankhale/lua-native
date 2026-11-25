// npm run vcpkg-lua-wasm
//
// (Re)installs the vcpkg Lua for `wasm32-emscripten` through the overlay
// triplet, and ends by showing which `longjmp` runtime the result references —
// the WASM counterpart of `npm run vcpkg-lua`, and for the same reason: the
// overlay is not sticky, vcpkg reports "already installed" and skips unless the
// old one is removed first, and a script that claims a result should print it.
//
// A Node script rather than a one-liner because vcpkg's triplet needs
// EMSCRIPTEN_ROOT in the environment and nothing else sets it.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  REPO, TRIPLET, ToolchainError, requireEmscripten, vcpkgRoot, requireOverlayLua,
} from './toolchain.mjs';

function main() {
  const emscripten = requireEmscripten();
  const vcpkg = path.join(vcpkgRoot(), 'vcpkg');
  const env = { ...process.env, EMSCRIPTEN_ROOT: emscripten.root };
  const overlay = `--overlay-triplets=${path.join(REPO, 'triplets')}`;

  // Failure here is the normal case on a first install; nothing to remove.
  spawnSync(vcpkg, ['remove', `lua:${TRIPLET}`, '--recurse', overlay], { env, stdio: 'ignore' });

  const install = spawnSync(vcpkg, ['install', `lua:${TRIPLET}`, overlay], { env, stdio: 'inherit' });
  if (install.status !== 0) {
    throw new ToolchainError(`vcpkg install lua:${TRIPLET} exited ${install.status}.`);
  }

  const lua = requireOverlayLua();
  console.log(`\nemscripten ${emscripten.raw}  (${emscripten.root})`);
  console.log(`liblua.a   ${lua.lib}`);
  console.log(`longjmp    ${lua.runtime}  (${lua.symbols.join(', ')})`);
}

try {
  main();
} catch (error) {
  if (!(error instanceof ToolchainError)) throw error;
  console.error(`vcpkg-lua-wasm: ${error.message}`);
  process.exit(1);
}
