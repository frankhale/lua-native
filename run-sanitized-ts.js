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

// Candidate runtime dylibs for this sanitizer + platform, most specific first.
// On Linux the clang runtime name embeds the target arch (so an x86_64
// hardcode broke arm64 — CR-7 F5), and gcc ships its own libasan/libtsan;
// probe each candidate until one resolves.
const arch =
  os.arch() === "x64" ? "x86_64" : os.arch() === "arm64" ? "aarch64" : os.arch();
const candidates =
  platform === "darwin"
    ? [
        kind === "asan"
          ? "libclang_rt.asan_osx_dynamic.dylib"
          : "libclang_rt.tsan_osx_dynamic.dylib",
      ]
    : kind === "asan"
      ? [`libclang_rt.asan-${arch}.so`, "libasan.so"]
      : [`libclang_rt.tsan-${arch}.so`, "libtsan.so"];

// Ask the compiler where its sanitizer runtime lives. `-print-file-name` echoes
// the name back unchanged if it can't resolve it, so treat that as "not found".
const cc = process.env.CC || "clang";
let resolved = null;
const tried = [];
for (const lib of candidates) {
  const probe = spawnSync(cc, [`-print-file-name=${lib}`], { encoding: "utf8" });
  const out = (probe.stdout || "").trim();
  tried.push(`${cc} -print-file-name=${lib} -> "${out}"`);
  if (out && out !== lib && fs.existsSync(out)) {
    resolved = out;
    break;
  }
}
if (!resolved) {
  console.error(
    `Could not locate the ${kind.toUpperCase()} runtime.\n` +
      tried.map((t) => `Tried: ${t}`).join("\n") +
      `\nEnsure a compiler with the sanitizer runtimes is on PATH ` +
      `(Xcode CLT on macOS; clang or gcc on Linux — set CC to match the ` +
      `compiler the addon was built with).`,
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
        // halt_on_error=1: the addon is built UBSan-recoverable (a violation
        // logs and continues), so without this the run would exit green with
        // findings only in the scrollback (CR-7 F5). The runtime still halts
        // when told to, recoverable build or not.
        UBSAN_OPTIONS:
          process.env.UBSAN_OPTIONS ?? "halt_on_error=1:print_stacktrace=1",
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
// --expose-gc: V8 flags are process-wide, so the worker_threads isolates
// inherit it and global.gc exists inside the suite — the GC-lifetime
// regressions (e.g. CR-7 F1's cancel -> collect -> late-settle test) skip
// themselves without it.
const result = spawnSync(
  process.execPath,
  ["--expose-gc", vitestBin, "run", "--pool=threads", "--no-file-parallelism"],
  { stdio: "inherit", env },
);
process.exit(result.status ?? 1);
