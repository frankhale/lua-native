import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);

// Try to load the module from any possible location
function loadModule() {
  const baseName = 'lua-native';
  
  // Get the directory of the current file
  const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
  
  // Determine the platform for path construction
  const platform = os.platform();
  const arch = os.arch();
  
  // Map platform to the correct folder name used in prebuilds
  let platformDir;
  if (platform === 'win32') {
    platformDir = `win32-${arch}`;
  } else if (platform === 'darwin') {
    platformDir = `darwin-${arch}`;
  } else if (platform === 'linux') {
    platformDir = `linux-${arch}`;
  } else {
    platformDir = 'unknown';
  }
  
  // Candidate locations, in priority order. Local build outputs come FIRST so
  // that during development a freshly compiled binary (e.g. from
  // `npm run build-debug`) always wins over a checked-in or packaged prebuild.
  // Consumers who install from the registry have no build/ directory, so these
  // entries simply don't exist and resolution falls through to prebuilds.
  const relativePaths = [
    // node-gyp output (npm run build-debug / build-release)
    ['build', 'Debug', baseName],
    ['build', 'Release', baseName],

    // CMake output (see OUTPUT_DIR in CMakeLists.txt: build/<Config>/<os>)
    ['build', 'Debug', 'macos', baseName],
    ['build', 'Release', 'macos', baseName],
    ['build', 'Debug', 'windows', baseName],
    ['build', 'Release', 'windows', baseName],

    // Prebuilt binaries shipped in the published package
    ['prebuilds', platformDir, baseName],

    // Misc fallback layouts
    ['build', baseName],
    [baseName],
  ];

  // Convert relative paths to absolute paths
  const paths = relativePaths.map(segments =>
    path.join(currentDir, ...segments)
  );

  let lastError = null;

  // Try each path
  for (const modulePath of paths) {
    try {
      // Use require with the absolute path for more reliable loading
      const cleanPath = modulePath.replace(/\.node$/, '');
      return require(cleanPath);
    } catch (error) {
      lastError = error;
      // Keep trying on "not found" (this path simply doesn't exist) and on
      // "dlopen failed" (a prebuild built for a different arch/OS/ABI) — a
      // later candidate may still yield a working binary. Any other error is a
      // genuine failure and should surface immediately.
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_DLOPEN_FAILED') {
        throw error;
      }
    }
  }

  // Last resort: let node-gyp-build resolve a prebuild using its own naming
  // convention (this is what `prebuildify` output follows).
  try {
    const prebuild = require('node-gyp-build')(currentDir);
    if (prebuild) {
      return prebuild;
    }
  } catch (error) {
    lastError = error;
  }

  // Nothing worked — report every location we tried plus the last error.
  throw new Error(
    `Could not load the ${baseName} native binary.\n` +
    `Tried the following locations:\n` +
    paths.map(p => `  - ${p}`).join('\n') + '\n' +
    `and node-gyp-build resolution in ${currentDir}.\n` +
    `If you are developing locally, run 'npm run build-debug' first.` +
    (lastError ? `\nLast error: ${lastError.message}` : '')
  );
}

// Load the appropriate module
const lua_module = loadModule();

// Export the implementation
export default lua_module;