import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
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
  
  // List of possible relative paths where the module might be found
  const relativePaths = [
    ['prebuilds', platformDir, baseName],
    // CMake output paths with platform-specific directories
    ['build', 'Debug', platformDir, baseName],
    ['build', 'Release', platformDir, baseName],
    
    // Standard node-gyp paths (fallback)
    ['build', 'Debug', baseName],
    ['build', 'Release', baseName],
    
    // Some systems might place output directly in build
    ['build', baseName],
    
    // node-gyp might sometimes output to these locations
    ['build', 'Debug', `${baseName}.node`],
    ['build', 'Release', `${baseName}.node`],
    
    // For non-Windows platforms with different layout
    ['build', `${baseName}.node`],
    
    // For backwards compatibility or unusual configurations
    [baseName]
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
      // Only continue if it's a module not found error
      if (error.code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
    }
  }
  
  // Check if the build directory exists
  const buildDir = path.join(currentDir, 'build');
  if (!fs.existsSync(buildDir)) {
    throw new Error(`Build directory not found. Please run 'npm run build-debug' first.`);
  }

  const prebuild = require('node-gyp-build')(currentDir);
  if(prebuild) {
    return prebuild;
  }

  // If we get here, the module was not found in any expected location
  throw new Error(
    `Could not find ${baseName} module in any expected location. ` +
    `Expected paths included: ${paths.slice(0, 4).join(', ')}... ` +
    `Did you build the project? Try running 'npm run build-debug' first.`
  );
}

// Load the appropriate module
const lua_module = loadModule();

// Export the implementation
export default lua_module;