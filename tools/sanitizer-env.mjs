// Shared by the harnesses that run one process per cell.
//
// **Why this exists.** `run-sanitized-ts.js` launches a target with the
// sanitizer runtime preloaded via `DYLD_INSERT_LIBRARIES` (macOS) /
// `LD_PRELOAD` (Linux). dyld honours the variable at exec and then **removes it
// from the process's own environment** — `process.env.DYLD_INSERT_LIBRARIES` is
// `undefined` inside the very process it instrumented. So a harness that spawns
// children with the inherited environment hands them an *un*preloaded one, and
// every child aborts on addon load with "Interceptors are not working".
//
// That is what happened on the first attempt to run `lifecycle-matrix` under
// ASan (W3.1): the parent was instrumented, all nine controls failed, and the
// reason was two layers away from the message. The runner therefore also exports
// the preload under a name macOS does not touch, and this re-injects it.
//
// **The vacuity question answers itself here, unusually.** A child that does not
// get the preload cannot silently run uninstrumented — the instrumented `.node`
// refuses to load at all and the cell dies loudly. So "the cells ran" *is* the
// proof that they ran instrumented; there is no third state to check for.

export const SANITIZED = Boolean(process.env.LUA_NATIVE_SANITIZER_PRELOAD);

/** Environment for a spawned cell: the inherited one, plus the preload that
 *  dyld stripped, when running under `run-sanitized-ts.js`. */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const preload = process.env.LUA_NATIVE_SANITIZER_PRELOAD;
  const varName = process.env.LUA_NATIVE_SANITIZER_VAR;
  if (preload && varName) env[varName] = preload;
  return env;
}
