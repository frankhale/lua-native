/**
 * Cross-platform CMake build script.
 *
 * Usage:
 *   node cmake-build.js [debug|release]   (default: debug)
 *
 * Requires: cmake on PATH and VCPKG_ROOT set (or vcpkg in ~/vcpkg).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const buildType =
  (process.argv[2] || "debug").toLowerCase() === "release"
    ? "Release"
    : "Debug";

const sourceDir = path.resolve(import.meta.dirname);
const buildDir = path.join(sourceDir, `cmake-build-${buildType.toLowerCase()}`);

// Resolve vcpkg toolchain file
const vcpkgRoot =
  process.env.VCPKG_ROOT ||
  path.join(process.env.HOME || process.env.USERPROFILE, "vcpkg");
const toolchainFile = path.join(
  vcpkgRoot,
  "scripts",
  "buildsystems",
  "vcpkg.cmake",
);

if (!existsSync(toolchainFile)) {
  console.error(
    `vcpkg toolchain not found at: ${toolchainFile}\n` +
      `Set VCPKG_ROOT to your vcpkg installation directory.`,
  );
  process.exit(1);
}

const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: sourceDir });
};

// Configure
run("cmake", [
  `-DCMAKE_BUILD_TYPE=${buildType}`,
  `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`,
  "-S",
  sourceDir,
  "-B",
  buildDir,
]);

// Build
run("cmake", ["--build", buildDir, "--config", buildType]);
