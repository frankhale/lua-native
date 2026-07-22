import { defineConfig } from 'vitest/config';

// Expose global.gc to the suite so the GC-lifetime regressions (e.g. the CR-7
// F1 cancel -> collect -> late-settle test) actually run — they now FAIL, not
// skip, when it is missing (CR-8 F2).
//
// Vitest 4 removed `test.poolOptions` (silently ignoring it — which is exactly
// how the CR-7 plumbing was disarmed); `execArgv` is a top-level option now.
// It must NOT be set for the threads pool: worker_threads reject V8 flags in
// execArgv (ERR_WORKER_INVALID_EXEC_ARGV). The sanitized runner
// (run-sanitized-ts.js) forces --pool=threads and provides --expose-gc
// process-wide on the node invocation instead (worker threads inherit
// process-wide V8 flags); it sets LUA_NATIVE_SANITIZED=1 so this config leaves
// execArgv alone on that path.
export default defineConfig({
  test: {
    ...(process.env.LUA_NATIVE_SANITIZED ? {} : { execArgv: ['--expose-gc'] }),
  },
});
