import os from "node:os";
import path from "node:path";

const arch = os.arch();
const platform = os.platform();

// Match the CMakeLists.txt triplet selection logic
let triplet;
if (platform === "win32") {
  // Windows - always use x64 for now (CMake uses x64-windows-static)
  triplet = "x64-windows-static";
} else if (platform === "darwin") {
  // Apple Silicon only, and it throws rather than falling back for the reason
  // CMakeLists.txt states: a fallback triplet builds a target nothing here
  // claims to support, and does it silently.
  if (arch !== "arm64" && arch !== "aarch64") {
    throw new Error(
      `Unsupported macOS architecture: ${arch}. This project targets Apple Silicon (arm64) only.`
    );
  }
  triplet = "arm64-osx";
} else {
  // Unsupported platform - use default
  console.warn(`Unsupported platform: ${platform} - using default x64 triplet`);
  triplet = "x64-unknown";
}

const vcpkgRoot =
  process.env.VCPKG_ROOT ||
  path.join(process.env.HOME || process.env.USERPROFILE, "vcpkg");
const includePath = path.join(vcpkgRoot, "installed", triplet, "include");
const libName = platform === "win32" ? "lua.lib" : "liblua.a";
const libPath = path.join(vcpkgRoot, "installed", triplet, "lib", libName);
// The stock Lua interpreter, installed by the port's `tools` feature
// (`vcpkg install lua[tools]`). Used as the reference implementation by the
// differential oracle; not needed to build or test the addon itself.
const interpreterPath = path.join(
  vcpkgRoot,
  "installed",
  triplet,
  "tools",
  "lua",
  platform === "win32" ? "lua.exe" : "lua"
);

// console.log(`triplet: ${triplet}`);
// console.log(`vcpkgRoot: ${vcpkgRoot}`);
// console.log(`includePath: ${includePath}`);
// console.log(`libPath: ${libPath}`);

const arg = process.argv[2];
if (arg === "include") {
  console.log(includePath);
} else if (arg === "lib") {
  console.log(libPath);
} else if (arg === "interpreter") {
  console.log(interpreterPath);
} else {
  console.log(includePath);
  console.log(libPath);
}
