import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const isWin = os.platform() === "win32";
const exeName = isWin ? "lua-native-test.exe" : "lua-native-test";

const buildDirs = [
  path.join("build", "Debug", "windows"),
  path.join("build", "Debug"),
  path.join("build", "Release"),
  path.join("build", "test", "Debug"),
  path.join("build", "test", "Release"),
  "cmake-build-debug",
  "cmake-build-release",
  "cmake-build-debug-visual-studio",
  "cmake-build-release-visual-studio",
];

let found = false;
for (const dir of buildDirs) {
  const fullPath = path.join(process.cwd(), dir, exeName);
  if (fs.existsSync(fullPath)) {
    console.log(`Running C++ tests: ${fullPath}`);
    const result = spawnSync(fullPath, { stdio: "inherit" });
    if (result.status !== null) {
      process.exit(result.status);
    } else {
      process.exit(1);
    }
    found = true;
    break;
  }
}

if (!found) {
  console.error(
    "Could not find lua-native-test executable. Please build the project first."
  );
  console.error("Tried searching in:");
  buildDirs.forEach((dir) => console.error(` - ${path.join(dir, exeName)}`));
  process.exit(1);
}
