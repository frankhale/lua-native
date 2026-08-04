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
// **Three comparisons per case**, against the same door the differential
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
      name: 'all four doors actually run the case (sync/worker/driver/bytecode)',
      run: async () => outcomeSync('return 6 * 7').canon === 'ok:num:42'
        && (await outcomeAsync('return 6 * 7', 'worker')).canon === 'ok:num:42'
        && (await outcomeAsync('return 6 * 7', 'driver')).canon === 'ok:num:42'
        && outcomeBytecode('return 6 * 7').canon === 'ok:num:42',
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
  console.log(`${cases.length} cases x 3 doors (worker/driver/bytecode), vs execute_script\n`);

  const rows = [];
  const usedLedger = new Set();
  let done = 0;
  let agree = 0;
  let accepted = 0;
  let harness = 0;

  for (const c of cases) {
    const sync = outcomeSync(c.source);
    for (const door of ['worker', 'driver', 'bytecode']) {
      const got = door === 'bytecode'
        ? outcomeBytecode(c.source)
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

  console.log(`Cells: ${cases.length * 3}`);
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
