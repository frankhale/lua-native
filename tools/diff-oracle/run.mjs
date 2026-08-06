// The differential oracle: lua-native against stock Lua 5.5.
//
//   node tools/diff-oracle/run.mjs                  # both modes
//   node tools/diff-oracle/run.mjs --mode=a         # embedded VM only
//   node tools/diff-oracle/run.mjs --mode=b         # marshalling only
//   node tools/diff-oracle/run.mjs --category=math
//   node tools/diff-oracle/run.mjs --json=out.json
//
// **Why this exists.** Seventeen review passes, three exhaustive matrices and
// four sanitizer harnesses all check the same thing: that nothing crashed and
// that errors are clean. None of them checks whether an *answer is right*. That
// was tolerable while every finding announced itself with a segfault; it stopped
// being tolerable at CR-17, where the high was silent data corruption and the
// other two findings were a wrong return value and a wrong error message. A
// crash announces itself; a wrong answer has to be asked for.
//
// So: run the same Lua through two implementations and compare.
//
//   **Mode A — the embedded VM.** Both sides serialize in Lua, so nothing has
//   crossed a boundary. A difference here means the addon's hooks changed the
//   language: the instruction-count hook, the allocator under maxMemory, the
//   print override, the metatabled _G, the __gc bridge.
//
//   **Mode B — the crossing.** The reference serializes in Lua; lua-native
//   returns the marshalled JavaScript value and a mirror serializer canonicalizes
//   *that*. This is the half with no reference implementation of its own, and
//   it is where a silently wrong answer is most likely to live.
//
// The erasures — the distinctions JavaScript provably cannot carry — are
// specified once, in `canonical.lua`'s header, and implemented on both sides.
// Anything that survives them is a real disagreement.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import lua_native from '../../index.js';
import { buildCorpus } from './corpus.mjs';
import { canon, canonOutcome } from './js-canonical.mjs';
import { referenceLua, referenceVersion, embeddedVersion } from './reference.mjs';
import { ACCEPTED_DIVERGENCES, divergenceReason } from './accepted.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANONICAL_LUA = readFileSync(join(HERE, 'canonical.lua'), 'utf8');

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const mode = arg('mode') ?? 'both';
const onlyCategory = arg('category');
const jsonOut = arg('json');
const quiet = argv.includes('--quiet');
const controlOnly = argv.includes('--control');

// One reference process for the whole corpus.
//
// The first version spawned the reference per case, which made a 1300-case run
// take twenty minutes — and a corpus that slow is a corpus that gets run once.
// Batching moves the per-case cost to zero spawns and makes the oracle
// something the suite can afford to call.
//
// The corpus is handed over as Lua source rather than JSON so there is no
// encoder between the two sides to disagree about; each case's body goes in a
// long-bracket string at a level chosen to clear any brackets it contains.
function longBracket(src) {
  let level = '';
  while (src.includes(`]${level}]`) || src.includes(`[${level}[`)) level += '=';
  return `[${level}[${src}]${level}]`;
}

function referenceBatch(cases) {
  const entries = cases
    .map((c) => `{id=${longBracket(c.id)}, src=${longBracket(c.source)}}`)
    .join(',\n');
  // `print`, not `return`: the stock interpreter runs the chunk on stdin and
  // discards its return value, where the previous hand-written driver printed
  // it. Nothing else about the comparison changes — each case is still loaded
  // with the chunkname `=case` inside canonical.lua, so error messages are
  // unaffected by which program is hosting them.
  const chunk = `${CANONICAL_LUA.replace(/\breturn M\s*$/m, 'local canonical = M')}
local cases = {
${entries}
}
print(canonical.run_batch(cases))`;

  const out = execFileSync(referenceLua(), ['-'], {
    input: chunk, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 << 20,
  });
  const byId = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [id, a, b] = line.split('\t');
    if (id !== undefined) byId.set(id, { a, b });
  }
  return byId;
}

// Batched, but in chunks, and a chunk that times out is bisected down to the
// individual case rather than taking the run with it.
//
// A generated corpus will eventually contain a case that does not terminate —
// this one already did — and the failure mode of a single 1340-case batch is
// that the whole oracle dies with no result and no indication of which case did
// it. Chunking plus bisection turns that into one HARNESS row naming the
// culprit, which is the difference between a harness that reports a problem and
// one that *is* the problem.
function referenceAll(cases, chunkSize = 200) {
  const byId = new Map();
  const runChunk = (slice) => {
    if (slice.length === 0) return;
    try {
      for (const [k, v] of referenceBatch(slice)) byId.set(k, v);
    } catch (e) {
      if (slice.length === 1) {
        const why = `HARNESS:${(e.code === 'ETIMEDOUT' ? 'timed out (non-terminating?)' : String(e.message)).slice(0, 200)}`;
        byId.set(slice[0].id, { a: why, b: why });
        return;
      }
      const mid = Math.floor(slice.length / 2);
      runChunk(slice.slice(0, mid));
      runChunk(slice.slice(mid));
    }
  };
  for (let i = 0; i < cases.length; i += chunkSize) {
    runChunk(cases.slice(i, i + chunkSize));
  }
  return byId;
}

// A single case through the reference, for the controls.
function runReference(caseSource, which = 'a') {
  const got = referenceBatch([{ id: 'x', source: caseSource }]).get('x');
  return { canon: got ? got[which] : 'HARNESS:no row' };
}

function runEmbeddedModeA(caseSource) {
  const lua = new lua_native.init({}, { libraries: 'all' });
  let level = '';
  while (caseSource.includes(`]${level}]`) || caseSource.includes(`[${level}[`)) level += '=';
  const chunk = `${CANONICAL_LUA.replace(/\breturn M\s*$/m, 'local canonical = M')}
return canonical.run([${level}[${caseSource}]${level}])`;
  try {
    const out = lua.execute_script(chunk);
    if (typeof out !== 'string') return { canon: `HARNESS:non-string ${typeof out}` };
    return { canon: out.trim() };
  } catch (e) {
    return { canon: `HARNESS:${String(e && e.message).slice(0, 300)}` };
  }
}

// Axis: the conversion mode mode B runs under (W2). `binaryStrings` re-rules
// exactly the crossing mode B searches — Lua value out to JS — so it is a column
// here, and the only instrument that can compare the byte form against a
// *reference* rather than against itself.
const BINARY = process.argv.slice(2).includes('--binary');

// Under `binaryStrings` every Lua string arrives as its exact bytes. Decoded
// here, on the oracle's side of the call, rather than inside the shared `canon`
// — which three harnesses use and whose semantics are not this column's to
// change (see js-canonical.mjs).
//
// UTF-8 with replacement, deliberately: that is what the *default* mode does, so
// this column asks the right question — **do the bytes carry what stock Lua
// printed** — rather than merely whether the byte form is self-consistent, which
// is what roundtrip-matrix's binary mode already covers.
const BINARY_DECODER = new TextDecoder('utf-8');
function decodeBinaryStrings(v) {
  if (v instanceof Uint8Array) return BINARY_DECODER.decode(v);
  if (Array.isArray(v)) return v.map(decodeBinaryStrings);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, decodeBinaryStrings(val)]));
  }
  return v;
}

function runEmbeddedModeB(caseSource) {
  const lua = new lua_native.init({}, { libraries: 'all', ...(BINARY ? { binaryStrings: true } : {}) });
  try {
    const values = lua.execute_script(caseSource);
    return { canon: canonOutcome({ kind: 'ok', values: BINARY ? decodeBinaryStrings(values) : values, multi: false }) };
  } catch (e) {
    // The reference reports a failure as its display string; the binding
    // surfaces it as a JS throw whose message is that same display string. So
    // the two sides are answering the same question — which is the only way an
    // error-message difference (CR-17 F3's family) shows up as a row here.
    return { canon: canonOutcome({ kind: 'error', message: String(e && e.message) }) };
  }
}

// Normalisations applied to *both* sides before comparing.
//
// These are not the erasures — those live in `canonical.lua` and are about what
// JavaScript can represent. These are about what the two *harnesses* inevitably
// differ on, and each one is here because leaving it in produced rows that say
// nothing:
//
//   * **Addresses.** `tostring({})` is "table: 0x...". Two processes never
//     agree and never could. Anchored to the `table:` / `thread:` /
//     `function:` / `userdata:` prefixes Lua actually emits, rather than to
//     bare `0x…`: the unanchored form also erased any *string-valued* result
//     that happened to look like a hex literal, so a future `string.format('%x')`
//     case would have compared equal to a different one and passed silently
//     (CR-19 F5b).
//   * **The chunk location prefix.** The reference loads each case as `=case`;
//     `execute_script` names its chunk `[string "..."]`. Both are correct
//     reports of where the error happened, in harnesses that put it in
//     different places. The *message body* after the prefix is the part CR-17
//     F3's family lives in, and it survives this untouched.
//   * **The traceback appendix.** lua-native appends `stack traceback: ...` to
//     its error messages; stock Lua's `pcall` does not. That is a deliberate
//     feature of the binding, not a disagreement about what went wrong.
//
// Everything else is left alone on purpose, including whitespace and quoting.
function normalise(c) {
  return c
    .replace(/\b(table|thread|function|userdata): 0x[0-9a-fA-F]+/g, '$1: 0xADDR')
    .replace(/\[string \\x22[\s\S]*?\\x22\]:\d+:/g, 'CHUNK:LINE:')
    .replace(/\bcase:\d+:/g, 'CHUNK:LINE:')
    // Strip the traceback but keep whatever closed the canonical form — taking
    // the quote with it made every message compare unequal for a reason that
    // had nothing to do with the message.
    .replace(/\\x0Astack traceback:[\s\S]*$/g, (m) => (m.match(/("\]?)$/) ?? ['', ''])[1])
    .replace(/\\x0A\\x09/g, ' ');
}

function compare(caseSource, id, category, m, refCanon) {
  const emb = m === 'a' ? runEmbeddedModeA(caseSource) : runEmbeddedModeB(caseSource);
  const reference = refCanon ?? 'HARNESS:no reference row';
  return {
    id, category, mode: m,
    match: normalise(reference) === normalise(emb.canon),
    reference, embedded: emb.canon,
  };
}

// --- controls --------------------------------------------------------------
//
// CR-17's rule, again: a search that reports clean must first demonstrate it can
// report dirty. Here that means feeding the comparator inputs whose answers are
// known to differ and known to agree, so a comparator that says "same" to
// everything — which is what a broken harness looks like — is caught.
function runControls() {
  const controls = [
    {
      name: 'identical sources compare equal',
      run: () => compare('return 1 + 1', 'ctl/equal', 'control', 'a', runReference('return 1 + 1').canon).match === true,
    },
    {
      name: 'a deliberately different source compares unequal',
      run: () => {
        const a = runReference('return 1 + 1');
        const b = runReference('return 1 + 2');
        return a.canon !== b.canon;
      },
    },
    {
      name: 'the reference actually runs the case (not a constant)',
      run: () => runReference('return 6 * 7').canon === 'ok:[num:42]',
    },
    {
      name: 'the embedded side actually runs the case (mode A)',
      run: () => runEmbeddedModeA('return 6 * 7').canon === 'ok:[num:42]',
    },
    {
      name: 'the embedded side actually runs the case (mode B)',
      run: () => runEmbeddedModeB('return 6 * 7').canon === 'ok:[num:42]',
    },
    {
      // The axis vacuity control (CR-23 F4's rule, `tools/README.md`): a
      // `--binary` run whose option were silently ignored would behave exactly
      // like the default column, agree with the reference on all 1339 cases,
      // and report a clean sheet having searched nothing. Prove the knob is
      // connected before believing the column — and prove the *decode* is
      // reached too, since a canon that never saw a Uint8Array would be equally
      // vacuous.
      name: BINARY
        ? 'binaryStrings is in effect, and the byte form decodes to the text form'
        : 'binaryStrings is off in this run (the default column)',
      run: () => {
        const lua = new lua_native.init({}, { libraries: 'all', ...(BINARY ? { binaryStrings: true } : {}) });
        const v = lua.execute_script('return "abc"');
        return BINARY
          ? v instanceof Uint8Array && canon(decodeBinaryStrings(v)) === canon('abc')
          : typeof v === 'string';
      },
    },
    {
      name: 'an error is a comparable outcome, not a missing row',
      run: () => runReference('error("x")').canon.startsWith('error:'),
    },
    {
      name: 'the integer/float erasure holds where it should',
      run: () => runReference('return 3').canon === runReference('return 3.0').canon,
    },
    {
      name: 'the erasure stops at 2^53, where BigInt takes over',
      run: () => runReference('return 9007199254740993').canon.startsWith('bigint:')
        || runReference('return 9007199254740993').canon.includes('bigint:'),
    },
  ];
  console.log('Control (a comparator that reports clean must first report dirty):\n');
  let bad = 0;
  for (const c of controls) {
    let pass = false;
    let detail = '';
    try { pass = c.run() === true; } catch (e) { detail = String(e && e.message); }
    if (!pass) bad++;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${c.name}${detail ? `  (${detail})` : ''}`);
  }
  console.log('');
  return bad;
}

// --- main ------------------------------------------------------------------

// Resolve the reference before anything else, so a missing `lua[tools]` is one
// clear message rather than 2678 harness errors — and print it as a message
// rather than as a stack trace, since the only thing the reader needs is the
// one command that fixes it.
let REF_BIN;
let refVersion;
let embVersion;
try {
  REF_BIN = referenceLua();
  refVersion = referenceVersion(REF_BIN);
  embVersion = embeddedVersion();
} catch (e) {
  console.error(`\n${e.message}\n`);
  process.exit(1);
}
console.log(`Reference: ${refVersion}  (${REF_BIN})`);
console.log(`Embedded:  ${embVersion ?? 'unknown'}`);
if (embVersion && refVersion !== embVersion) {
  // Not fatal — you may deliberately want to compare across versions — but it
  // has to be said out loud, because every version-specific behaviour will
  // otherwise show up as a defect in the addon.
  console.log(`  WARNING: reference and embedded Lua differ; version-specific`);
  console.log(`  behaviour will appear as disagreements.`);
}
console.log('');

const badControls = runControls();
if (badControls > 0) {
  console.error(`${badControls} control(s) failed — the comparator cannot tell same from different.`);
  process.exit(1);
}
if (controlOnly) process.exit(0);

let corpus = buildCorpus();
if (onlyCategory) corpus = corpus.filter((c) => c.category === onlyCategory);

const modes = mode === 'both' ? ['a', 'b'] : [mode];

// One reference pass for the whole corpus, both forms at once.
if (!quiet) process.stderr.write(`  running ${corpus.length} cases through reference Lua...\n`);
const refRows = referenceAll(corpus);

const results = [];
let done = 0;
const total = corpus.length * modes.length;

for (const m of modes) {
  for (const c of corpus) {
    // Mode B needs a single returned value; see corpus.mjs.
    if (m === 'b' && !c.singleValue) continue;
    const row = refRows.get(c.id);
    results.push(compare(c.source, c.id, c.category, m, row ? row[m] : undefined));
    done++;
    if (!quiet && done % 200 === 0) process.stderr.write(`\r  ${done}/${total}`);
  }
}
if (!quiet) process.stderr.write(`\r  ${done}/${total}\n\n`);

// Fold in the accepted-divergence ledger, on the same terms as CR-18's: every
// entry carries its reason, and an entry that no longer applies is reported
// rather than silently ignored.
for (const r of results) {
  if (r.match) {
    const reason = divergenceReason(r.id, r.mode);
    if (reason) { r.stale = true; r.reason = reason; }
    continue;
  }
  const reason = divergenceReason(r.id, r.mode);
  if (reason) { r.accepted = true; r.reason = reason; }
}

const mismatches = results.filter((r) => !r.match && !r.accepted);
const accepted = results.filter((r) => r.accepted);
const stale = results.filter((r) => r.stale);
const harness = results.filter((r) => r.reference.startsWith('HARNESS:') || r.embedded.startsWith('HARNESS:'));

console.log(`Cases: ${results.length}  (mode A ${results.filter((r) => r.mode === 'a').length}, mode B ${results.filter((r) => r.mode === 'b').length})`);
console.log(`  agree              ${results.filter((r) => r.match).length}`);
console.log(`  accepted divergence ${accepted.length}   (${ACCEPTED_DIVERGENCES.length} ledger entries)`);
console.log(`  DISAGREE           ${mismatches.length}`);
if (stale.length) console.log(`  STALE ledger entry ${stale.length}`);
if (harness.length) console.log(`  harness error      ${harness.length}`);

const show = (label, rows, limit = 60) => {
  if (!rows.length) return;
  console.log(`\n=== ${label} ===`);
  for (const r of rows.slice(0, limit)) {
    console.log(`  [${r.mode}] ${r.id}`);
    console.log(`      reference: ${r.reference.slice(0, 200)}`);
    console.log(`      lua-native: ${r.embedded.slice(0, 200)}`);
  }
  if (rows.length > limit) console.log(`  ... and ${rows.length - limit} more`);
};

show('HARNESS ERRORS (fix before reading anything else)', harness, 20);
show('DISAGREEMENTS', mismatches);
if (stale.length) {
  console.log('\n=== STALE LEDGER ENTRIES (they agree now; delete the entry) ===');
  for (const r of stale) console.log(`  [${r.mode}] ${r.id}`);
}

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nfull results -> ${jsonOut}`);
}

void canon;
process.exit(mismatches.length || harness.length || stale.length ? 1 : 0);
