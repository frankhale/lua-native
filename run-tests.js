import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const isWin = os.platform() === "win32";
const exeName = isWin ? "lua-native-test.exe" : "lua-native-test";

const buildDirs = [
  // node-gyp output
  path.join("build", "Debug"),
  path.join("build", "Release"),
  // CMake output (see OUTPUT_DIR in CMakeLists.txt: build/<Config>/<os>)
  path.join("build", "Debug", "macos"),
  path.join("build", "Release", "macos"),
  path.join("build", "Debug", "windows"),
  path.join("build", "Release", "windows"),
  path.join("build", "test", "Debug"),
  path.join("build", "test", "Release"),
  "cmake-build-debug",
  "cmake-build-release",
  "cmake-build-debug-visual-studio",
  "cmake-build-release-visual-studio",
];

// Sanitizer runtime options, applied when the binary was built with
// `build-asan` (harmless no-ops for a non-instrumented binary, which ignores
// these env vars). abort_on_error makes ASan exit non-zero so a failure fails
// the run; halt_on_error does the same for UBSan; detect_leaks=0 because
// LeakSanitizer is unsupported on macOS. Any pre-set value is respected.
const sanitizerEnv = {
  ASAN_OPTIONS:
    process.env.ASAN_OPTIONS ?? "abort_on_error=1:detect_leaks=0",
  UBSAN_OPTIONS:
    process.env.UBSAN_OPTIONS ?? "halt_on_error=1:print_stacktrace=1",
  TSAN_OPTIONS:
    process.env.TSAN_OPTIONS ?? "halt_on_error=1:second_deadlock_stack=1",
};

for (const dir of buildDirs) {
  const fullPath = path.join(process.cwd(), dir, exeName);
  if (fs.existsSync(fullPath)) {
    console.log(`Running C++ tests: ${fullPath}`);
    const result = spawnSync(fullPath, {
      stdio: "inherit",
      env: { ...process.env, ...sanitizerEnv },
    });
    if (result.status !== null) {
      process.exit(result.status);
    } else {
      process.exit(1);
    }
  }
}

console.error(
  "Could not find lua-native-test executable. Please build the project first."
);
console.error("Tried searching in:");
buildDirs.forEach((dir) => console.error(` - ${path.join(dir, exeName)}`));
process.exit(1);
