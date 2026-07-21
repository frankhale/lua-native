import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    poolOptions: {
      forks: {
        // Expose global.gc to the suite so the GC-lifetime regressions (e.g.
        // the CR-7 F1 cancel -> collect -> late-settle test) actually run;
        // they self-skip when gc is unavailable. The sanitized runner
        // (run-sanitized-ts.js) uses the threads pool instead and passes
        // --expose-gc on the node invocation itself (worker_threads reject V8
        // flags in execArgv, but inherit process-wide V8 flags).
        execArgv: ['--expose-gc'],
      },
    },
  },
});
