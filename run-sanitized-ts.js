// Runs the TypeScript (vitest) suite against a sanitizer-instrumented .node
// addon. Node itself is not built with a sanitizer, so an instrumented addon
// cannot load unless the sanitizer runtime is present in the process from the
// start — we arrange that by preloading the matching runtime dylib via
// DYLD_INSERT_LIBRARIES (macOS) / LD_PRELOAD (Linux).
//
// Usage: node run-sanitized-ts.js <asan|tsan>
// Build the matching addon first (npm run build-asan-addon / build-tsan-addon).

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const kind = process.argv[2];
if (kind !== "asan" && kind !== "tsan") {
  console.error("usage: node run-sanitized-ts.js <asan|tsan>");
  process.exit(2);
}

const platform = os.platform();
if (platform === "win32") {
  console.error("run-sanitized-ts.js supports macOS/Linux only (clang/gcc).");
  process.exit(2);
}

// The runtime dylib name clang ships for this sanitizer + platform.
const runtimeLib =
  platform === "darwin"
    ? kind === "asan"
      ? "libclang_rt.asan_osx_dynamic.dylib"
      : "libclang_rt.tsan_osx_dynamic.dylib"
    : kind === "asan"
      ? "libclang_rt.asan-x86_64.so"
      : "libclang_rt.tsan-x86_64.so";

// Ask the compiler where its sanitizer runtime lives. `-print-file-name` echoes
// the name back unchanged if it can't resolve it, so treat that as "not found".
const cc = process.env.CC || "clang";
const probe = spawnSync(cc, [`-print-file-name=${runtimeLib}`], {
  encoding: "utf8",
});
const resolved = (probe.stdout || "").trim();
if (!resolved || resolved === runtimeLib || !fs.existsSync(resolved)) {
  console.error(
    `Could not locate the ${kind.toUpperCase()} runtime (${runtimeLib}).\n` +
      `Tried: ${cc} -print-file-name=${runtimeLib} -> "${resolved}".\n` +
      `Ensure a clang with the sanitizer runtimes is on PATH (Xcode CLT on macOS).`,
  );
  process.exit(2);
}

const preloadVar =
  platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";

// Sanitizer runtime options tuned for a partially-instrumented process (only the
// addon is instrumented; Node/V8/libuv and static Lua are not):
//  - detect_leaks=0: LeakSanitizer is unsupported on macOS and would flag all of
//    Node's own allocations anyway.
//  - detect_container_overflow=0: false positives when instrumented and
//    un-instrumented code share a std::container across the boundary.
//  - abort_on_error=1 (ASan): a real memory error fails the run with non-zero exit.
//  - halt_on_error=0 (TSan): keep going so one run surfaces every race, not just
//    the first; the report count is what we triage.
const suppressions = path.join(process.cwd(), `${kind}.supp`);
const hasSupp = fs.existsSync(suppressions);
const optionEnv =
  kind === "asan"
    ? {
        ASAN_OPTIONS:
          process.env.ASAN_OPTIONS ??
          "detect_leaks=0:detect_container_overflow=0:abort_on_error=1:print_stacktrace=1",
        UBSAN_OPTIONS: process.env.UBSAN_OPTIONS ?? "print_stacktrace=1",
      }
    : {
        TSAN_OPTIONS:
          process.env.TSAN_OPTIONS ??
          `halt_on_error=0:second_deadlock_stack=1${hasSupp ? `:suppressions=${suppressions}` : ""}`,
      };

const env = {
  ...process.env,
  [preloadVar]: [resolved, process.env[preloadVar]].filter(Boolean).join(":"),
  ...optionEnv,
};

console.log(`[${kind}] preloading ${resolved}`);
console.log(`[${kind}] ${preloadVar} + ${Object.keys(optionEnv).join(", ")} set`);
if (hasSupp) console.log(`[${kind}] using suppressions: ${suppressions}`);

// Use the THREADS pool, single-threaded. A forked worker does not inherit
// DYLD_INSERT_LIBRARIES (macOS drops it across the fork's exec), so the addon
// would dlopen the sanitizer runtime too late — "interceptors are not working".
// worker_threads instead run inside this preloaded process, so the runtime is
// already installed when the addon loads. Run vitest's entry directly (not via
// npx) so the preloaded env reaches the one node process that matters.
const vitestBin = path.join(
  process.cwd(),
  "node_modules",
  "vitest",
  "vitest.mjs",
);
const result = spawnSync(
  process.execPath,
  [vitestBin, "run", "--pool=threads", "--no-file-parallelism"],
  { stdio: "inherit", env },
);
process.exit(result.status ?? 1);
