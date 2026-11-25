// clang-tidy over the C++ sources, with the configuration in /.clang-tidy.
//
//   node tools/lint/run.mjs             # controls, then src/ and the C++ tests
//   node tools/lint/run.mjs --control   # just the controls
//   node tools/lint/run.mjs --verbose   # print every diagnostic in full
//   node tools/lint/run.mjs --native-only   # leave out src/wasm (no Emscripten here)
//
// **Why this exists.** clang-tidy had been run against this tree before — from
// an IDE, by hand, with whatever checks the IDE had on — and once did damage:
// a "fix clang-tidy issues" commit turned an indexed loop into a range-for and
// shipped a use-after-free (CODE-REVIEW-11 F1). There was no checked-in
// configuration, so there was no answer to "which checks, and is it clean?".
// This is that answer: one configuration, one command, exit 0 or 1.
//
// **It is not one of the correctness harnesses and does not search a boundary.**
// It is a static check. It is here because it follows the same two rules they
// do, for the same reason:
//
//   1. *Controls first.* tools/lint/control.cpp is deliberately wrong. Unless
//      the checks it names fire — and the ones .clang-tidy disables stay
//      silent, which proves the project configuration is the one in effect —
//      nothing else runs.
//   2. *A translation unit that does not compile is a failure, not a clean
//      run.* clang-tidy keeps going after a compile error and reports whatever
//      it managed to see. The first run of this tool's ancestor did exactly
//      that: a missing include path, a third of the diagnostics, exit 0.
//
// It never passes --fix. See the note at the top of .clang-tidy.
//
// **What it does not do:** it cannot tell you a NOLINT has gone stale — clang-tidy
// has no "unused suppression" report. It lists every suppression with its check
// name and refuses a bare one, which is the part that can be automated.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const VERBOSE = args.has('--verbose');
const CONTROL_ONLY = args.has('--control');
const NATIVE_ONLY = args.has('--native-only');

const SOURCES = ['src/core/lua-runtime.cpp', 'src/lua-native.cpp'];
const HEADERS = ['src/core/lua-runtime.h', 'src/lua-native.h', 'src/lua-async-worker.h'];
// The second binding (`docs/reviews/WASM-TARGET-PLAN.md`, U10 and Phase 5). Its two
// translation units compile only against the Emscripten sysroot, so they are
// linted with the flags `em++` itself reports — the same configuration, the
// same rules, a different compiler front end's idea of where <emscripten/val.h>
// is. A run without `--native-only` that cannot find Emscripten fails: "clean"
// has to mean both bindings, or it means less than it says.
const WASM_SOURCES = ['src/wasm/js.cpp', 'src/wasm/stack.cpp', 'src/wasm/suspend.cpp', 'src/wasm/lua-wasm.cpp'];
const WASM_HEADERS = ['src/wasm/js.h', 'src/wasm/lua-wasm.h'];
const CONTROL = 'tools/lint/control.cpp';
// Held to the naming rules only. The test suite is gtest macros end to end, and
// the full check set reads those as findings; what the tests share with src/
// is the vocabulary, so that is the part kept from drifting.
const NAMING_ONLY = ['tests/cpp/lua-native-test.cpp'];
const NAMING_CHECKS = '-*,readability-identifier-naming';

// What the control must and must not produce. See control.cpp.
// A second element narrows the requirement to a diagnostic whose message
// matches it: identifier-naming is one check with a separate option per kind of
// name, and each kind has to be shown connected on its own.
const MUST_FIRE = [
  ['clang-analyzer-core.CallAndMessage'],
  ['cppcoreguidelines-init-variables'],
  ['cppcoreguidelines-special-member-functions'],
  ['readability-identifier-naming', /for local constant 'resultValue'/],
  ['readability-identifier-naming', /for parameter 'inputValue'/],
  ['readability-identifier-naming', /for private member 'callCount'/],
];
const MUST_NOT_FIRE = [
  'readability-identifier-length',
  'readability-magic-numbers',
  'modernize-use-trailing-return-type',
];

function fail(message) {
  console.error(`\nlint: ${message}`);
  process.exit(2);
}

function tryExec(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// clang-tidy is not part of Xcode's toolchain, so look in the usual places.
function findClangTidy() {
  const home = os.homedir();
  const candidates = [
    process.env.CLANG_TIDY,
    tryExec('/usr/bin/which', ['clang-tidy']),
    '/opt/homebrew/opt/llvm/bin/clang-tidy',
    '/usr/local/opt/llvm/bin/clang-tidy',
    path.join(home, 'Applications/CLion.app/Contents/bin/clang/mac/aarch64/bin/clang-tidy'),
    '/Applications/CLion.app/Contents/bin/clang/mac/aarch64/bin/clang-tidy',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  fail('clang-tidy not found. Install it (`brew install llvm`) or set CLANG_TIDY to its path.');
}

function findNodeHeaders() {
  const candidates = [
    path.resolve(path.dirname(process.execPath), '..', 'include', 'node'),
    path.join(os.homedir(), 'Library/Caches/node-gyp', process.versions.node, 'include/node'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'node_api.h'))) return c;
  }
  fail(`Node headers not found for ${process.version}; run \`npm run build-debug\` once so node-gyp fetches them.`);
}

// The flags binding.gyp compiles the addon with on macOS, spelled out so the
// lint does not depend on a CMake or IDE build directory existing.
function compileFlags() {
  const vcpkgInclude = tryExec(process.execPath, [path.join(ROOT, 'get_vcpkg_path.js'), 'include']);
  if (!vcpkgInclude || !fs.existsSync(path.join(vcpkgInclude, 'lua.hpp'))) {
    fail('Lua headers not found via get_vcpkg_path.js — is VCPKG_ROOT set and `npm run vcpkg-lua` done?');
  }
  const flags = [
    '-std=c++17',
    '-fexceptions',
    '-DNAPI_VERSION=8',
    '-DNODE_ADDON_API_CPP_EXCEPTIONS',
    '-DNODE_ADDON_API_DISABLE_DEPRECATED',
    '-DLUA_STATIC',
    '-D_DARWIN_C_SOURCE',
    `-I${path.join(ROOT, 'src')}`,
    `-I${path.dirname(require.resolve('node-addon-api/napi.h'))}`,
    `-isystem${findNodeHeaders()}`,
    `-isystem${vcpkgInclude}`,
  ];
  if (process.platform === 'darwin') {
    // A clang-tidy that is not Apple's ships without the SDK's notion of where
    // the system and builtin headers are; without these two it cannot find
    // <stdarg.h> and every TU "compiles" with errors.
    const sdk = tryExec('xcrun', ['--show-sdk-path']);
    const resourceDir = tryExec('clang', ['-print-resource-dir']);
    if (sdk) flags.push('-isysroot', sdk);
    if (resourceDir) flags.push('-resource-dir', resourceDir);
  }
  return flags;
}

// What `em++` compiles the WASM binding with, as clang flags: the target, the
// sysroot and its defines come from `em++ --cflags`, and the rest is what
// tools/wasm-build/run.mjs adds.
async function wasmCompileFlags() {
  const { requireEmscripten, luaPaths, ToolchainError } = await import('../wasm-build/toolchain.mjs');
  let lua;
  try {
    requireEmscripten();
    lua = luaPaths();
  } catch (error) {
    if (!(error instanceof ToolchainError)) throw error;
    fail(`cannot lint src/wasm: ${error.message}\n      Pass --native-only to lint the native target alone; the result then says so.`);
  }
  if (!fs.existsSync(path.join(lua.include, 'lua.hpp'))) {
    fail(`cannot lint src/wasm: no Lua headers at ${lua.include}. Run \`npm run vcpkg-lua-wasm\`, or pass --native-only.`);
  }
  const cflags = tryExec('em++', ['--cflags', '-fwasm-exceptions']);
  if (!cflags) fail('cannot lint src/wasm: `em++ --cflags` printed nothing. Pass --native-only to lint the native target alone.');
  return ['-std=c++17', ...cflags.split(/\s+/).filter(Boolean), `-I${path.join(ROOT, 'src')}`, `-isystem${lua.include}`];
}

// `checks`, when given, is appended to the configuration's own list, so
// '-*,x' narrows the run to x while keeping every CheckOption.
function runTidy(clangTidy, file, flags, checks = null) {
  return new Promise((resolve) => {
    const child = spawn(clangTidy, [
      '--quiet',
      `--config-file=${path.join(ROOT, '.clang-tidy')}`,
      ...(checks ? [`--checks=${checks}`] : []),
      path.join(ROOT, file),
      '--',
      ...flags,
    ], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('close', () => resolve(parse(out)));
  });
}

// One entry per distinct diagnostic. A header included by both TUs reports its
// findings twice; the key collapses them.
function parse(output) {
  const seen = new Map();
  const re = /^(.+?):(\d+):(\d+): (warning|error): (.*) \[([^\]]+)\]$/;
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const [, file, line, col, level, message, checks] = m;
    const rel = path.relative(ROOT, file);
    const key = `${rel}:${line}:${col}:${checks}`;
    if (seen.has(key)) continue;
    const context = [];
    for (let j = i + 1; j < lines.length && !re.test(lines[j]) && context.length < 4; j++) {
      if (/: note: /.test(lines[j])) break;
      context.push(lines[j]);
    }
    seen.set(key, { file: rel, line: Number(line), col: Number(col), level, message, checks: checks.split(','), context });
  }
  return [...seen.values()];
}

function listSuppressions() {
  const found = [];
  const bare = [];
  const scanned = NATIVE_ONLY ? [...SOURCES, ...HEADERS] : [...SOURCES, ...HEADERS, ...WASM_SOURCES, ...WASM_HEADERS];
  for (const file of scanned) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((text, idx) => {
      // Only a marker that opens a comment and is followed by a check list or
      // nothing is a suppression; prose that mentions the word NOLINT is not.
      const m = /\/\/\s*NOLINT(?:NEXTLINE|BEGIN|END)?(?:\(([^)]*)\)|\s*$)/.exec(text);
      if (!m) return;
      const where = `${file}:${idx + 1}`;
      if (!m[1]) bare.push(where);
      else found.push({ where, checks: m[1] });
    });
  }
  return { found, bare };
}

const clangTidy = findClangTidy();
const flags = compileFlags();
const version = (tryExec(clangTidy, ['--version']) ?? '').match(/version\s+(\S+)/)?.[1] ?? 'unknown';
console.log(`clang-tidy ${version}  (${clangTidy})`);

// ---- controls -------------------------------------------------------------

const control = await runTidy(clangTidy, CONTROL, flags);
const controlChecks = new Set(control.flatMap((d) => d.checks));
const compileErrors = control.filter((d) => d.level === 'error');
const problems = [];
if (compileErrors.length) {
  problems.push(`the control does not compile: ${compileErrors[0].message}`);
}
for (const [check, message] of MUST_FIRE) {
  const fired = control.some((d) => d.checks.includes(check) && (!message || message.test(d.message)));
  if (!fired) {
    problems.push(`expected ${check}${message ? ` (${message})` : ''} to fire on ${CONTROL}; it did not`);
  }
}
for (const check of MUST_NOT_FIRE) {
  if (controlChecks.has(check)) {
    problems.push(`${check} fired on ${CONTROL}, but .clang-tidy disables it — the project configuration is not in effect`);
  }
}
if (problems.length) {
  console.error('\nCONTROL FAILED — refusing to lint, a clean result would mean nothing:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}
console.log(`control ok   ${MUST_FIRE.length} checks fired as required, ${MUST_NOT_FIRE.length} disabled checks stayed silent`);
if (CONTROL_ONLY) process.exit(0);

// ---- the sources ----------------------------------------------------------

const testFlags = [...flags, `-I${path.join(ROOT, 'vendor/googletest/googletest/include')}`];
const wasmFlags = NATIVE_ONLY ? null : await wasmCompileFlags();
const results = await Promise.all([
  ...SOURCES.map((file) => runTidy(clangTidy, file, flags)),
  ...(wasmFlags ? WASM_SOURCES.map((file) => runTidy(clangTidy, file, wasmFlags)) : []),
  ...NAMING_ONLY.map((file) => runTidy(clangTidy, file, testFlags, NAMING_CHECKS)),
]);
const all = new Map();
for (const d of results.flat()) {
  if (d.file.startsWith('..') || d.file.startsWith('node_modules')) continue;  // not ours
  all.set(`${d.file}:${d.line}:${d.col}:${d.checks.join(',')}`, d);
}
const diagnostics = [...all.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const broken = results.flat().filter((d) => d.level === 'error');
if (broken.length) {
  console.error('\nA translation unit did not compile under clang-tidy; its findings are incomplete:');
  for (const d of broken.slice(0, 5)) console.error(`  ${d.file}:${d.line}: ${d.message}`);
  process.exit(2);
}

const { found: suppressions, bare } = listSuppressions();
const byCheck = new Map();
for (const s of suppressions) byCheck.set(s.checks, (byCheck.get(s.checks) ?? 0) + 1);
console.log(`suppressions ${suppressions.length} NOLINT markers, each naming its check:`);
for (const [check, n] of [...byCheck].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}  ${check}`);
}

if (bare.length) {
  console.error('\nBare NOLINT (names no check, so it hides every future one too):');
  for (const where of bare) console.error(`  ${where}`);
}

if (diagnostics.length) {
  const tally = new Map();
  for (const d of diagnostics) for (const c of d.checks) tally.set(c, (tally.get(c) ?? 0) + 1);
  console.error(`\n${diagnostics.length} finding(s):`);
  for (const [check, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.error(`    ${String(n).padStart(3)}  ${check}`);
  }
  console.error('');
  for (const d of diagnostics) {
    console.error(`${d.file}:${d.line}:${d.col}: ${d.message} [${d.checks.join(',')}]`);
    if (VERBOSE) for (const c of d.context) console.error(c);
  }
}

if (diagnostics.length || bare.length) {
  console.error('\nlint: FAILED');
  process.exit(1);
}
const units = SOURCES.length + (wasmFlags ? WASM_SOURCES.length : 0);
const headers = HEADERS.length + (wasmFlags ? WASM_HEADERS.length : 0);
console.log(`\nlint: clean — ${units} translation units, ${headers} headers, ` +
  `${NAMING_ONLY.length} test file (naming only), 0 findings.` +
  (wasmFlags ? '' : '\n      NATIVE ONLY: src/wasm was not linted (--native-only).'));
