// Source invariants that used to live in comments.
//
// Seventeen review passes found exactly one thing that stops a defect class
// recurring: making a machine check it. Comments did not survive — the
// `CallScope` enumeration was repaired in CR-13, CR-14 and CR-15 and was wrong
// each time; the `lua_next` traversal list was incomplete on arrival (CR-15 F3);
// a "33 synchronous methods" count was written in four places and was 31.
//
// So the lists are computed from the source by `tools/invariants.mjs` and frozen
// in `tools/invariants.expected.json`. A source change that moves one is not
// forbidden — it just cannot happen silently, because this test goes red and the
// re-freeze is a reviewable diff.
//
// The first block is the part CR-17 insists on: **an exhaustive check that
// reports clean must first be shown able to report dirty.** The scanner these
// invariants stand on is given hand-written inputs whose right answers are
// known, including the two false-friend cases that actually bit while it was
// being written.

import { describe, it, expect } from 'vitest';
import { topLevelFunctions, tryGuardMap } from '../../tools/cpp-scan.mjs';
import { INVARIANTS, computeAll, readExpected, diffInvariant } from '../../tools/invariants.mjs';

// Wraps a body in a function definition the scanner will pick up, and returns
// whether the marker call `boom()` is scored as inside a try block.
function guardedness(body: string): boolean {
  const src = `void Probe() {\n${body}\n}\n`;
  const fns = topLevelFunctions(src);
  expect(fns.length, `scanner did not find the probe function in:\n${src}`).toBe(1);
  const guard = tryGuardMap(fns[0]);
  const at = fns[0].body.indexOf('boom()');
  expect(at, 'probe body must contain the boom() marker').toBeGreaterThanOrEqual(0);
  return guard[at] === 1;
}

describe('invariant scanner: positive controls', () => {
  it('scores a bare call as unguarded', () => {
    expect(guardedness('  boom();')).toBe(false);
  });

  it('scores a call inside a multi-line try as guarded', () => {
    expect(guardedness('  try {\n    boom();\n  } catch (const std::exception& e) {\n    handle(e);\n  }')).toBe(true);
  });

  it('scores a call inside a single-line try/catch as guarded', () => {
    // The shape the codebase uses for best-effort cleanup. Scoring the line by
    // its end state calls this unguarded, which was the scan's first bug.
    expect(guardedness('  try { boom(); } catch (...) {}')).toBe(true);
  });

  it('scores a call in the catch body as unguarded', () => {
    // A catch body is not protected by its own try. A rethrow from here escapes.
    expect(guardedness('  try { safe(); } catch (...) { boom(); }')).toBe(false);
  });

  it('does not treat an identifier ending in "try" as a try block', () => {
    // `entry`, `retry`, `try_`. This one is not hypothetical: without the
    // left-hand word boundary the substring in `entry.key = key` opened a guard
    // region that never closed, so everything after it in the file scored as
    // guarded — and the whole check passed against a source with a try/catch
    // deliberately deleted.
    expect(guardedness('  MetatableEntry entry;\n  entry.key = key;\n  boom();')).toBe(false);
    expect(guardedness('  int retry = 0;\n  boom();')).toBe(false);
  });

  it('closes the guard region at the end of the try block', () => {
    expect(guardedness('  try { safe(); } catch (...) {}\n  boom();')).toBe(false);
  });

  it('handles a try nested inside an if', () => {
    expect(guardedness('  if (x) {\n    try {\n      boom();\n    } catch (...) {}\n  }')).toBe(true);
    expect(guardedness('  if (x) {\n    try { safe(); } catch (...) {}\n  }\n  boom();')).toBe(false);
  });

  it('ignores comments and string literals', () => {
    expect(guardedness('  // try {\n  const char* s = "try {";\n  boom();')).toBe(false);
  });

  it('finds top-level function definitions and skips declarations', () => {
    const src = [
      'void Declared(int a);',
      'namespace ns {',
      '}',
      'int Defined(int a) {',
      '  return a;',
      '}',
      'Napi::Value LuaContext::Method(const Napi::CallbackInfo& info) {',
      '  return env.Undefined();',
      '}',
    ].join('\n');
    expect(topLevelFunctions(src).map((f) => f.name)).toEqual(['Defined', 'LuaContext::Method']);
  });
});

describe('source invariants match their frozen answers', () => {
  const actual = computeAll();
  const expected = readExpected();

  for (const inv of INVARIANTS) {
    it(`${inv.id}: ${inv.title}`, () => {
      const drift = diffInvariant(actual[inv.id], expected[inv.id]);
      expect(
        drift,
        [
          '',
          `Invariant "${inv.id}" drifted from tools/invariants.expected.json.`,
          inv.note ? `  ${inv.note}` : '',
          '',
          ...drift.map((d) => `  ${d}`),
          '',
          'If the change is intended, re-freeze it so the diff lands in review:',
          '  node tools/check-invariants.mjs --update',
          '',
        ].join('\n'),
      ).toEqual([]);
    });
  }

  it('every invariant produced a non-empty answer', () => {
    // A scan that silently returns nothing matches an empty expectation and
    // reports clean forever. CR-17's vacuous orphan matrix, in miniature.
    for (const inv of INVARIANTS) {
      expect(Object.keys(actual[inv.id]).length, `${inv.id} produced no entries`).toBeGreaterThan(0);
    }
  });
});
