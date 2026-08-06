// Source invariants that used to live in comments.
//
// Seventeen review passes found exactly one thing that stops a defect class
// recurring: making a machine check it. Comments did not survive — the
// `CallScope` enumeration was repaired in CR-13, CR-14 and CR-15 and was wrong
// each time; the `lua_next` traversal list was incomplete on arrival (CR-15 F3);
// a "33 synchronous methods" count was written in four places and was 31.
//
// So the lists are computed from the source by `tools/invariants/invariants.mjs` and frozen
// in `tools/invariants/expected.json`. A source change that moves one is not
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
import { INVARIANTS, computeAll, readExpected, diffInvariant } from '../../tools/invariants/invariants.mjs';
import {
  score, mappedCoverage, valueBearingTypes, methodSignatures, inboundMarkers,
  hostCallbackMembers, hostReachingCoreMethods,
} from '../../tools/invariants/surface-census.mjs';

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

// The surface census is the newest scanner here and, per `tools/README.md`, the
// newest code is the least trustworthy part of any instrument — this one alone
// produced three false findings while it was being written (an empty marker
// universe scored as a clean sheet, a member-declaration pattern that dropped
// `host_functions_` and so declared the main host bridge unable to reach the
// host, and a coverage scan that read one of cross-context's two case arrays and
// would have argued for reversing ledger entry M6).
//
// So each of its four censuses is driven against a synthetic input whose right
// answer is known, in both directions: it must find the thing, and it must
// report the thing missing.
describe('surface census: positive controls', () => {
  it('scores an option with no mode as UNCLASSIFIED, and one with a mode as COVERED', () => {
    const out: Record<string, unknown> = {};
    const n = score(['covered', 'orphan'], new Map([['covered', 'some-mode']]), {}, out, 'option: ');
    expect(out['option: orphan']).toBe('UNCLASSIFIED');
    expect(out['option: covered']).toBe('COVERED: some-mode');
    expect(n).toBe(1);
  });

  it('reports a ledger entry for surface that no longer exists', () => {
    const out: Record<string, unknown> = {};
    score(['still-here'], new Map(), { 'still-here': 'reason', gone: 'reason' }, out, 'x: ');
    expect(out['x: still-here']).toBe('LEDGERED');
    expect(String(out['x: gone'])).toMatch(/STALE LEDGER ENTRY/);
  });

  it('reports a ledger entry that the instrument has since covered', () => {
    const out: Record<string, unknown> = {};
    score(['m'], new Map([['m', 'case-1']]), { m: 'stale excuse' }, out, 'x: ');
    expect(String(out['x: m'])).toMatch(/LEDGERED_BUT_COVERED/);
  });

  it('reports a mapping that names a case the instrument does not have', () => {
    const { cover, broken } = mappedCoverage({ a: ['real', 'imaginary'] }, ['real']);
    expect(cover.get('a')).toBe('real');
    expect(broken).toEqual(['a -> imaginary']);
  });

  it('closes the value-bearing type set transitively', () => {
    const src = [
      'export interface Direct { x: LuaInput; }',
      'export interface Indirect { d: Direct; }',
      'export interface Unrelated { flag: boolean; }',
    ].join('\n');
    const set = valueBearingTypes(src);
    expect(set.has('Direct')).toBe(true);
    // The hop that matters: `ClassDefinition` is reached this way, and a
    // one-level scan is how an enumeration goes a member short.
    expect(set.has('Indirect')).toBe(true);
    expect(set.has('Unrelated')).toBe(false);
  });

  it('captures a method signature that spans several lines', () => {
    const sigs = methodSignatures([
      '  short(a: string): void;',
      '  spread(',
      '    a: LuaInput,',
      '    b: (x: number) => void,',
      '  ): void;',
    ].join('\n'));
    expect([...sigs.keys()]).toEqual(['short', 'spread']);
    expect(sigs.get('spread')).toMatch(/LuaInput/);
  });

  it('counts a marker that is read back and ignores one that is only written', () => {
    const src = 'DefineHiddenProp(env, o, "__writeOnly", x);\n'
      + 'auto* d = TaggedData<X>(obj.Get("_readBack"), tag);\n'
      + 'if (obj.Has("__alsoRead")) {}\n';
    expect(inboundMarkers(src)).toEqual(['__alsoRead', '_readBack']);
  });

  it('finds a host-callback member whatever container it is declared in', () => {
    const header = [
      'using OutputHandler = std::function<void(int)>;',
      'using Function = std::function<int(int)>;',
      '  std::shared_ptr<OutputHandler> output_handler_;',
      '  std::unordered_map<std::string, std::shared_ptr<Function>> host_functions_;',
      '  int unrelated_;',
    ].join('\n');
    const { aliases, members } = hostCallbackMembers(header);
    expect(aliases).toEqual(['OutputHandler', 'Function']);
    // `host_functions_` is the one an anchored pattern dropped, which made the
    // census declare LuaCallHostFunction unable to reach the host.
    expect(members).toEqual(['host_functions_', 'output_handler_']);
  });

  it('follows a frame to a host callback through an accessor', () => {
    const core = [
      'bool LuaRuntime::HasInputHandler() const {',
      '  return input_handler_ != nullptr;',
      '}',
      'int LuaRuntime::Indirect(lua_State* L) {',
      '  if (runtime->HasInputHandler()) return 1;',
      '  return 0;',
      '}',
      'int LuaRuntime::Unrelated(lua_State* L) {',
      '  return 0;',
      '}',
    ].join('\n');
    const reaching = hostReachingCoreMethods(core, ['input_handler_']);
    expect(reaching.has('HasInputHandler')).toBe(true);
    // The transitive hop. Without it the census saw 3 host-callable frames of
    // 23 and missed the print, io, dofile and searcher bridges.
    expect(reaching.has('Indirect')).toBe(true);
    expect(reaching.has('Unrelated')).toBe(false);
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
          `Invariant "${inv.id}" drifted from tools/invariants/expected.json.`,
          inv.note ? `  ${inv.note}` : '',
          '',
          ...drift.map((d) => `  ${d}`),
          '',
          'If the change is intended, re-freeze it so the diff lands in review:',
          '  node tools/invariants/run.mjs --update',
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
