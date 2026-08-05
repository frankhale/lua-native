// The execution-door parity matrix: do the alternate execution entry points
// agree with execute_script on the same script?
//
//   node tools/exec-parity/run.mjs                 # the whole matrix
//   node tools/exec-parity/run.mjs --control       # just the controls
//   node tools/exec-parity/run.mjs --category=coroutine
//   node tools/exec-parity/run.mjs --case=coroutine/c7
//
// **Why this exists.** CODE-REVIEW-20 closed with the observation that three
// boundaries had never been mechanically searched, and this instrument covers
// the two cheap ones (CODE-REVIEW-HISTORY A3): the async surface
// end-to-end, and the bytecode round trip. The suite exercises all of these
// doors heavily, but every one of those tests states its own expectation by
// hand — nothing has ever checked that the alternate doors and the synchronous
// door *agree* on a corpus neither was written against. The property is
// metamorphic, like the round-trip matrix's: no reference implementation is
// needed, because the doors are their own references.
//
// **Five comparisons per case**, against the same door the differential
// oracle already trusts (execute_script, which agrees with stock Lua on this
// corpus):
//
//   worker   — execute_script_async(s): same VM, executed on a libuv thread,
//              marshalled by the worker's OnOK. A difference here is a defect
//              in the handoff or the marshal, full stop: the documented
//              differences (no JS callbacks, print bypass) are unreachable by
//              this corpus, which calls neither.
//   driver   — execute_async(s): the script runs *as a coroutine* driven by
//              DriveAsync, so a difference is either the documented execution
//              model showing through (ledgered, with the doc pointed at) or a
//              defect in the coroutine-resume plumbing.
//   bytecode — compile(s) then load_bytecode(bc, s): the same chunk through
//              the dump/undump cycle. The chunk name passed to load_bytecode
//              is the source text, matching what every direct load site uses,
//              so an error-location difference between the doors is a real
//              difference and not harness noise.
//   call_async   — load(s) then call_async(fn) (P1a): the same chunk called
//              through the main-thread coroutine driver from a held function
//              ref. The chunk name is the source text, as above.
//   resume_async — load(s), create_coroutine(fn), then resume_async(co)
//              (P1b): the chunk runs as a caller-owned coroutine under the
//              same driver. Its values array is unwrapped to the bare-value
//              shape the other doors produce — see outcomeResumeAsync.
//
// The corpus is the differential oracle's (tools/diff-oracle/corpus.mjs),
// reused deliberately: it is generated, it is already known to terminate in
// the embedded VM, and execute_script's answers over it are oracle-verified —
// so a door that disagrees with execute_script here disagrees with stock Lua.
//
// Error messages are compared as part of the outcome (CR-17 F3's family: a
// wrong message is a wrong answer). Two normalisations only, each because the
// raw form cannot agree between doors for reasons that say nothing:
//   * addresses in tostring output ("table: 0x...") — two contexts never agree;
//   * the "stack traceback:" appendix — the doors genuinely stand in different
//     frames (a plain call vs a coroutine resume), so the frame list is
//     presentation; the message body ahead of it is what must agree, and does
//     or does not on its own.

import lua_native from '../../index.js';
import { buildCorpus } from '../diff-oracle/corpus.mjs';
import { canon } from '../diff-oracle/js-canonical.mjs';
import { ACCEPTED_DIVERGENCES, divergenceReason } from './accepted.mjs';

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const onlyCategory = arg('category');
const onlyCase = arg('case');
const controlOnly = argv.includes('--control');
const quiet = argv.includes('--quiet');

const TIMEOUT_MS = 20_000;

function freshContext(globals = {}) {
  return new lua_native.init(globals, { libraries: 'all' });
}

function messageOf(e) {
  return String(e && e.message !== undefined ? e.message : e);
}

// The two harness-inevitable normalisations described in the header. Nothing
// else — chunknames are NOT normalised, because every load site names the
// chunk identically (the source text), so a location difference between doors
// would be a real difference and must survive to a row.
function normaliseMessage(m) {
  return m
    .replace(/\b(table|thread|function|userdata): 0x[0-9a-fA-F]+/g, '$1: 0xADDR')
    .replace(/\nstack traceback:[\s\S]*$/, '');
}

function okCanon(values) {
  return `ok:${canon(values)}`
    .replace(/\b(table|thread|function|userdata): 0x[0-9a-fA-F]+/g, '$1: 0xADDR');
}

function outcomeSync(source) {
  const lua = freshContext();
  try {
    return { kind: 'ok', canon: okCanon(lua.execute_script(source)) };
  } catch (e) {
    return { kind: 'error', canon: `error:${normaliseMessage(messageOf(e))}` };
  }
}

function outcomeBytecode(source) {
  const lua = freshContext();
  try {
    const bytecode = lua.compile(source);
    return { kind: 'ok', canon: okCanon(lua.load_bytecode(bytecode, source)) };
  } catch (e) {
    return { kind: 'error', canon: `error:${normaliseMessage(messageOf(e))}` };
  }
}

function withTimeout(promise) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('ASYNC_PARITY_TIMEOUT')), TIMEOUT_MS);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Both async doors funnel through here: run, await, canonicalise. A timeout is
// a HARNESS row, not a comparison — a cell that never settled measured
// nothing, and reporting it as "agrees" or "differs" would both be lies.
async function outcomeAsync(source, door) {
  const lua = freshContext();
  try {
    const promise = door === 'worker'
      ? lua.execute_script_async(source)
      : lua.execute_async(source);
    return { kind: 'ok', canon: okCanon(await withTimeout(promise)) };
  } catch (e) {
    if (messageOf(e) === 'ASYNC_PARITY_TIMEOUT') {
      return { kind: 'harness', canon: 'HARNESS:cell timed out' };
    }
    return { kind: 'error', canon: `error:${normaliseMessage(messageOf(e))}` };
  }
}

// The two doors added by INTEROP-PARITY-PLAN (August 5, 2026). Both take a
// *function*, not a chunk, so the corpus case is compiled with `load` using the
// source as its own chunkname — the same trick the bytecode door uses via
// `load_bytecode(bytecode, source)` — and an error location stays comparable.
//
// A compile failure is reported as the error it is, so a syntactically invalid
// case still produces a comparable row rather than a HARNESS hole.
function compileToFunction(lua, source) {
  lua.set_global('__parity_src', source);
  const fn = lua.execute_script('return load(__parity_src, __parity_src)');
  const msg = typeof fn === 'function' ? null
    : lua.execute_script('local _, e = load(__parity_src, __parity_src) return e');
  // The staging global must not survive into the case's run: only these two
  // doors would have it set, so a future corpus case that enumerates _G would
  // diverge here for a harness-caused reason rather than a real one.
  lua.set_global('__parity_src', null);
  if (typeof fn === 'function') return { fn };
  return { error: String(msg) };
}

async function outcomeCallAsync(source) {
  const lua = freshContext();
  try {
    const compiled = compileToFunction(lua, source);
    if (compiled.error) {
      return { kind: 'error', canon: `error:${normaliseMessage(compiled.error)}` };
    }
    return {
      kind: 'ok',
      canon: okCanon(await withTimeout(lua.call_async(compiled.fn))),
    };
  } catch (e) {
    if (messageOf(e) === 'ASYNC_PARITY_TIMEOUT') {
      return { kind: 'harness', canon: 'HARNESS:cell timed out' };
    }
    return { kind: 'error', canon: `error:${normaliseMessage(messageOf(e))}` };
  }
}

async function outcomeResumeAsync(source) {
  const lua = freshContext();
  try {
    const compiled = compileToFunction(lua, source);
    if (compiled.error) {
      return { kind: 'error', canon: `error:${normaliseMessage(compiled.error)}` };
    }
    const co = lua.create_coroutine(compiled.fn);
    const r = await withTimeout(lua.resume_async(co));
    if (r.error) {
      return { kind: 'error', canon: `error:${normaliseMessage(String(r.error))}` };
    }
    // A chunk that returns hands its values back at status 'dead'; one that
    // yields stops at 'suspended'. Both are the door's honest answer and both
    // are compared as values — a yield that the other doors turn into an error
    // is a real difference and belongs in a row.
    //
    // Unwrapped to the shape every other door produces: resume_async always
    // answers with a values *array*, while execute_script hands back a bare
    // value for one result. Comparing the raw array would have made all 1339
    // cells differ for a reason that says nothing about the door.
    const vs = r.values;
    return {
      kind: 'ok',
      canon: okCanon(vs.length === 0 ? undefined : vs.length === 1 ? vs[0] : vs),
    };
  } catch (e) {
    if (messageOf(e) === 'ASYNC_PARITY_TIMEOUT') {
      return { kind: 'harness', canon: 'HARNESS:cell timed out' };
    }
    return { kind: 'error', canon: `error:${normaliseMessage(messageOf(e))}` };
  }
}

// --- controls --------------------------------------------------------------
//
// The standing rule (tools/README.md): a search that reports clean must first
// demonstrate it can report dirty. The last two controls are this instrument's
// specific vacuity hazards: an async door implemented as a thin synchronous
// wrapper would sail through every comparison, so each door has to prove the
// property that makes it *that* door — the worker door that the work is
// deferred past the call, the driver door that the await machinery actually
// suspends and resumes the script.
async function runControls() {
  const controls = [
    {
      name: 'the comparator sees a value difference',
      run: async () => outcomeSync('return 1').canon !== outcomeSync('return 2').canon,
    },
    {
      name: 'the comparator sees a kind difference (ok vs error)',
      run: async () => {
        const ok = outcomeSync('return 1');
        const err = outcomeSync('error("boom")');
        return ok.kind === 'ok' && err.kind === 'error' && ok.canon !== err.canon;
      },
    },
    {
      name: 'all six doors actually run the case (sync/worker/driver/bytecode/call_async/resume_async)',
      run: async () => outcomeSync('return 6 * 7').canon === 'ok:num:42'
        && (await outcomeAsync('return 6 * 7', 'worker')).canon === 'ok:num:42'
        && (await outcomeAsync('return 6 * 7', 'driver')).canon === 'ok:num:42'
        && outcomeBytecode('return 6 * 7').canon === 'ok:num:42'
        && (await outcomeCallAsync('return 6 * 7')).canon === 'ok:num:42'
        && (await outcomeResumeAsync('return 6 * 7')).canon === 'ok:num:42',
    },
    {
      // The vacuity hazard for the two new doors: both compile through `load`,
      // so a bug that ran the *loader* rather than the loaded function would
      // still return something plausible. Prove each reaches the real body.
      name: 'the call_async door actually awaits (a Promise-returning host fn resolves in-script)',
      run: async () => {
        const lua = freshContext({ fetch42: async () => 42 });
        const compiled = compileToFunction(lua, 'return fetch42() + 1');
        if (compiled.error) return false;
        return (await withTimeout(lua.call_async(compiled.fn))) === 43;
      },
    },
    {
      name: 'the resume_async door actually awaits (and is a coroutine, not a plain call)',
      run: async () => {
        const lua = freshContext({ fetch42: async () => 42 });
        const compiled = compileToFunction(lua,
          'local v = fetch42() coroutine.yield(v) return "after"');
        if (compiled.error) return false;
        const co = lua.create_coroutine(compiled.fn);
        const first = await withTimeout(lua.resume_async(co));
        // Suspended at the yield with the awaited value proves both halves:
        // the await resolved, and this really is a coroutine.
        return first.status === 'suspended' && first.values[0] === 42;
      },
    },
    {
      name: 'the bytecode door actually goes through the dump (source rejected raw)',
      run: async () => {
        const lua = freshContext();
        try {
          lua.load_bytecode(Buffer.from('return 1'), 'ctl');
          return false;  // a door that executes source is not the bytecode door
        } catch {
          return true;
        }
      },
    },
    {
      name: 'the worker door defers the work past the call (is_busy while queued)',
      run: async () => {
        const lua = freshContext();
        const promise = lua.execute_script_async('return 1');
        const busyDuring = lua.is_busy();
        await withTimeout(promise);
        return busyDuring === true && lua.is_busy() === false;
      },
    },
    {
      name: 'the driver door actually awaits (a Promise-returning host fn resolves in-script)',
      run: async () => {
        const lua = freshContext({ fetch42: async () => 42 });
        const result = await withTimeout(lua.execute_async('return fetch42() + 1'));
        return result === 43;
      },
    },
    {
      name: 'a known door difference reaches the report (isyieldable, driver vs sync)',
      run: async () => {
        const sync = outcomeSync('return tostring(coroutine.isyieldable())');
        const driver = await outcomeAsync('return tostring(coroutine.isyieldable())', 'driver');
        return sync.canon !== driver.canon;
      },
    },
    {
      name: 'an error is a comparable outcome at every door, not a missing row',
      run: async () => outcomeSync('error("x")').kind === 'error'
        && (await outcomeAsync('error("x")', 'worker')).kind === 'error'
        && (await outcomeAsync('error("x")', 'driver')).kind === 'error',
    },
  ];

  console.log('Control (a comparator that reports clean must first report dirty):\n');
  let bad = 0;
  for (const c of controls) {
    let passed = false;
    try {
      passed = await c.run();
    } catch (e) {
      console.log(`  control threw: ${messageOf(e)}`);
    }
    console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${c.name}`);
    if (!passed) bad += 1;
  }
  console.log('');
  return bad === 0;
}

// --- the matrix ------------------------------------------------------------

async function main() {
  const controlsClean = await runControls();
  if (!controlsClean) {
    console.error('controls failed; refusing to run a search that cannot report dirty.');
    process.exit(1);
  }
  if (controlOnly) return;

  let cases = buildCorpus();
  if (onlyCategory) cases = cases.filter((c) => c.category === onlyCategory);
  if (onlyCase) cases = cases.filter((c) => c.id === onlyCase);
  console.log(`${cases.length} cases x 5 doors `
    + `(worker/driver/bytecode/call_async/resume_async), vs execute_script\n`);

  const rows = [];
  const usedLedger = new Set();
  let done = 0;
  let agree = 0;
  let accepted = 0;
  let harness = 0;

  const DOORS = ['worker', 'driver', 'bytecode', 'call_async', 'resume_async'];
  for (const c of cases) {
    const sync = outcomeSync(c.source);
    for (const door of DOORS) {
      const got = door === 'bytecode' ? outcomeBytecode(c.source)
        : door === 'call_async' ? await outcomeCallAsync(c.source)
        : door === 'resume_async' ? await outcomeResumeAsync(c.source)
        : await outcomeAsync(c.source, door);
      if (sync.kind === 'harness' || got.kind === 'harness') {
        harness += 1;
        rows.push({ id: c.id, door, kind: 'HARNESS', sync: sync.canon, got: got.canon });
        continue;
      }
      const match = got.canon === sync.canon;
      const reason = divergenceReason(c.id, door);
      if (match) {
        if (reason !== null) {
          // The ledgered case has started agreeing: the ledger is stale, and a
          // stale entry is a report, not a silent no-op.
          rows.push({ id: c.id, door, kind: 'STALE', sync: sync.canon, got: got.canon });
        } else {
          agree += 1;
        }
      } else if (reason !== null) {
        accepted += 1;
        usedLedger.add(`${c.id}#${door}`);
      } else {
        rows.push({ id: c.id, door, kind: 'DISAGREE', sync: sync.canon, got: got.canon });
      }
    }
    done += 1;
    if (!quiet && done % 200 === 0) process.stdout.write(`  ${done}/${cases.length}`);
  }
  if (!quiet) console.log('\n');

  const disagreements = rows.filter((r) => r.kind === 'DISAGREE');
  const stale = rows.filter((r) => r.kind === 'STALE');
  const harnessRows = rows.filter((r) => r.kind === 'HARNESS');

  console.log(`Cells: ${cases.length * DOORS.length}`);
  console.log(`  agree               ${agree}`);
  console.log(`  accepted divergence ${accepted}   (${ACCEPTED_DIVERGENCES.length} ledger entries)`);
  console.log(`  DISAGREE            ${disagreements.length}`);
  console.log(`  HARNESS             ${harnessRows.length}`);

  for (const r of [...disagreements, ...harnessRows]) {
    console.log(`\n${r.kind}  ${r.id}  [${r.door}]`);
    console.log(`  execute_script : ${r.sync}`);
    console.log(`  ${r.door.padEnd(15)}: ${r.got}`);
  }
  for (const r of stale) {
    console.log(`\nSTALE ledger entry: ${r.id} [${r.door}] now agrees `
      + `(${r.got}); remove or explain it.`);
  }
  // A full run in which a ledger entry's case never appeared is also a stale
  // ledger — the entry suppresses nothing and can only hide a future
  // regression (same rule as the oracle's).
  if (!onlyCategory && !onlyCase) {
    for (const entry of ACCEPTED_DIVERGENCES) {
      if (entry.id !== undefined && !usedLedger.has(`${entry.id}#${entry.door}`)
          && !stale.some((r) => r.id === entry.id && r.door === entry.door)) {
        console.log(`\nUNUSED ledger entry: ${entry.id} [${entry.door}] matched no cell.`);
      }
    }
  }

  const dirty = disagreements.length > 0 || stale.length > 0 || harnessRows.length > 0;
  console.log(dirty ? '\ndirty.' : '\nclean.');
  process.exit(dirty ? 1 : 0);
}

await main();
