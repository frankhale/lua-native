// Locates the reference Lua interpreter for the differential oracle.
//
// The reference is **stock `lua` from vcpkg** — the same port, at the same
// version, that supplies the `liblua.a` the addon embeds. That matters: a
// reference at a different Lua version turns every version-specific behaviour
// into a false mismatch, and an oracle that cries wolf is one nobody runs.
//
// It is not installed by default. The port ships it behind a feature:
//
//     vcpkg install lua[tools]
//
// There is deliberately **no fallback**. An earlier version of this file built
// a small interpreter out of `liblua.a` so the oracle would run without that
// feature, and that was the wrong call: this whole package already requires
// vcpkg for its Lua, so requiring one more feature of the same port costs
// nothing a developer here has not already paid — while a hand-written
// interpreter is a second implementation to maintain, and one whose agreement
// with the real thing is exactly what nobody would be checking.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function resolvePath() {
  return execFileSync(process.execPath, [join(ROOT, 'get_vcpkg_path.js'), 'interpreter'], {
    encoding: 'utf8',
  }).trim();
}

// The interpreter's path, or a thrown error naming the one command that fixes it.
export function referenceLua() {
  const bin = resolvePath();
  if (!existsSync(bin)) {
    throw new Error(
      `reference Lua interpreter not found at:\n  ${bin}\n\n`
      + 'The differential oracle compares against stock Lua from the same vcpkg\n'
      + 'port that supplies liblua.a. Install the port\'s tools feature:\n\n'
      + '  vcpkg install lua[tools]\n\n'
      + 'It is not needed to build or test the addon — only to run the oracle.',
    );
  }
  return bin;
}

// Version string, so a run is never ambiguous about what it compared against —
// and so a reference that has drifted from the embedded library is visible
// rather than silently producing mismatches attributed to the addon.
export function referenceVersion(bin = referenceLua()) {
  return execFileSync(bin, ['-e', 'io.write(_VERSION)'], { encoding: 'utf8' }).trim();
}

// The version the addon itself embeds, read from the vcpkg headers, so the two
// can be compared rather than assumed equal.
export function embeddedVersion() {
  const include = execFileSync(process.execPath, [join(ROOT, 'get_vcpkg_path.js'), 'include'], {
    encoding: 'utf8',
  }).trim();
  const header = join(include, 'lua.h');
  if (!existsSync(header)) return null;
  const src = execFileSync('cat', [header], { encoding: 'utf8' });
  const major = src.match(/#define\s+LUA_VERSION_MAJOR_N\s+(\d+)/)?.[1];
  const minor = src.match(/#define\s+LUA_VERSION_MINOR_N\s+(\d+)/)?.[1];
  return major && minor ? `Lua ${major}.${minor}` : null;
}
