// Axis A — the capability configurations a context can be built in.
//
// **Why this axis exists.** `roundtrip-matrix`'s Axis C searches the options
// that re-rule *conversion* (`strictConversion`, `binaryStrings`). The other two
// options re-rule *capability*: `libraries` decides which doors exist at all,
// and `allowBytecode` decides which loaders will run. Neither changes how a
// value converts, so neither belongs in that axis — and because
// `surface-census` scored an option covered only if a round-trip mode set it,
// both were structurally unclassifiable rather than merely unclassified
// (`docs/reviews/UNSEARCHED-REGIONS-PLAN.md` §2.1).
//
// **Every config carries a vacuity control**, the same discipline
// `roundtrip-matrix`'s modes carry and for the same reason: a preset that were
// silently ignored would behave like `all`, answer every door the same way, and
// report a clean column that searched nothing. `proves` must demonstrate the
// configuration is in effect before its cells are counted.

export const CONFIGS = [
  {
    id: 'all',
    options: { libraries: 'all' },
    describe: 'every standard library; the baseline the others are read against',
    // The baseline needs no control: it is the state every other config is
    // compared to, and a failure to apply it shows up as every door vanishing.
    proves: null,
  },
  {
    id: 'safe',
    options: { libraries: 'safe' },
    describe: "all but io/os/debug — documented as NOT a sandbox (LIMITATIONS §1)",
    proves: {
      describe: 'io is gone but package (and so require) remains',
      run: (lua) => lua.execute_script('return io == nil and package ~= nil'),
    },
  },
  {
    id: 'sandbox',
    options: { libraries: 'sandbox' },
    describe: 'the sealed preset: safe minus package, dofile/loadfile cleared',
    proves: {
      describe: 'the filesystem doors are gone',
      run: (lua) => lua.execute_script(
        'return io == nil and package == nil and dofile == nil and loadfile == nil'),
    },
  },
  {
    id: 'bare',
    options: { libraries: [] },
    describe: 'no standard library at all — sealed by construction',
    proves: {
      describe: 'even base is absent',
      run: (lua) => lua.execute_script('return type == nil and print == nil'),
    },
  },
  {
    id: 'base-only',
    options: { libraries: ['base'] },
    describe: 'an explicit list: base alone, so dofile exists but package does not',
    proves: {
      describe: 'base is in and package is out',
      run: (lua) => lua.execute_script('return type ~= nil and package == nil'),
    },
  },
  {
    id: 'all+nobytecode',
    options: { libraries: 'all', allowBytecode: false },
    describe: 'the E3 guard with every door present — the configuration whose '
      + 'five file doors were open until August 6, 2026',
    proves: {
      describe: 'the in-memory loader refuses a binary chunk',
      run: (lua) => lua.execute_script(
        'local f = load(string.dump(function() return 1 end)); return f == nil'),
    },
  },
  {
    id: 'safe+nobytecode',
    options: { libraries: 'safe', allowBytecode: false },
    describe: 'the guard where a script cannot write a file but a planted one '
      + 'may already exist — the case LIMITATIONS §1 now speaks to',
    proves: {
      describe: 'the guard is on and io is still absent',
      run: (lua) => lua.execute_script(
        'local f = load(string.dump(function() return 1 end)); return f == nil and io == nil'),
    },
  },
  {
    id: 'sandbox+bytecode',
    options: { libraries: 'sandbox', allowBytecode: true },
    describe: "the documented override: sandbox defaults bytecode off, an "
      + 'explicit true still wins',
    proves: {
      describe: 'sealed, yet the loader is available again',
      run: (lua) => lua.execute_script(
        'return io == nil and load(string.dump(function() return 1 end)) ~= nil'),
    },
  },
];

// The ten library names, parsed from the `LuaLibrary` union in `types.d.ts`
// rather than listed here. Every config must classify every one of them as
// present or sealed (see run.mjs), so a library added to the union cannot be
// forgotten by this matrix — the closure trick the invariants use, applied to
// the one hand-written table this harness needs.
export function luaLibraryNames(typesSrc) {
  const m = /export type LuaLibrary =([^;]+);/.exec(typesSrc);
  if (!m) throw new Error('capability-matrix: LuaLibrary union not found in types.d.ts');
  // `[a-z]+` silently dropped `utf8` on the first run — a library name may carry
  // a digit. The control below caught it because the specification table named a
  // library the parse did not contain; a bare count would not have.
  const names = [...m[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]);
  if (names.length < 5) throw new Error('capability-matrix: LuaLibrary union parsed as ' + names.length);
  return names.sort();
}

// What each config is *specified* to load. This is a specification pin — the
// same status as a test's expected value — not a derivation, and it is written
// down because it is the claim `LIMITATIONS.md` §1 and the `libraries` JSDoc
// make to callers. The closure check above is what keeps it honest.
export const EXPECTED_LIBRARIES = {
  all: ['base', 'coroutine', 'debug', 'io', 'math', 'os', 'package', 'string', 'table', 'utf8'],
  safe: ['base', 'coroutine', 'math', 'package', 'string', 'table', 'utf8'],
  sandbox: ['base', 'coroutine', 'math', 'string', 'table', 'utf8'],
  bare: [],
  'base-only': ['base'],
  'all+nobytecode': ['base', 'coroutine', 'debug', 'io', 'math', 'os', 'package', 'string', 'table', 'utf8'],
  'safe+nobytecode': ['base', 'coroutine', 'math', 'package', 'string', 'table', 'utf8'],
  'sandbox+bytecode': ['base', 'coroutine', 'math', 'string', 'table', 'utf8'],
};

// A global that proves a library is loaded. `base` has no table of its own, so
// it is probed through one of its functions.
export const LIBRARY_PROBE = {
  base: 'type',
  coroutine: 'coroutine',
  debug: 'debug',
  io: 'io',
  math: 'math',
  os: 'os',
  package: 'package',
  string: 'string',
  table: 'table',
  utf8: 'utf8',
};
