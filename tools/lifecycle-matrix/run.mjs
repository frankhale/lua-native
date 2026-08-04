// The lifecycle matrix: what happens to a handle held across a lifecycle event?
//
//   node tools/lifecycle-matrix/run.mjs                  # the whole matrix
//   node tools/lifecycle-matrix/run.mjs --control        # just the controls
//   node tools/lifecycle-matrix/run.mjs --handle=coroutine
//   node tools/lifecycle-matrix/run.mjs --event=reset
//
// **Why this exists.** It is the last boundary on the enumeration
// CODE-REVIEW-20 opened and CODE-REVIEW-21 reduced to one row: the
// userdata/class lifecycle across `reset` and GC. Every other crossing in this
// project now has a generated search; this one has only hand-written tests,
// each stating its own expectation, which is precisely the arrangement that let
// CR-17 F1 (stale handles aliasing live tables) survive to be found by eye.
//
// **The property.** A handle held across a lifecycle event must end in exactly
// one of two states, and never anywhere else:
//
//   * still valid, answering with its own state's data; or
//   * refusing, with a message that names a reason.
//
// The forbidden middle is a handle that *answers with the wrong state's data*.
// That is not a crash and not an error — it is the binding lying, which is the
// failure mode this codebase moved to around CR-17 and the one no sanitizer
// sees. `reset-then-realias` exists to make it visible: it re-creates the
// global under the same name with a different value, so a stale read that
// succeeds can be attributed to the retired state or the replacement.
//
// **One process per cell**, as in CR-16/17/18: the failure being searched for
// is a use-after-free on a closed `lua_State`, which aborts the process, and an
// abort inside a shared runner ends the run instead of producing a data point.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLES } from './handles.mjs';
import { EVENTS } from './events.mjs';
import { ACCEPTED, acceptedReason } from './expected.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CELL = join(HERE, 'cell.mjs');

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const onlyHandle = arg('handle');
const onlyEvent = arg('event');
const controlOnly = argv.includes('--control');

function runCell(handleId, eventId, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--expose-gc', CELL, handleId, eventId, ...extra], {
      cwd: join(HERE, '../..'), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const marker = out.indexOf('##CR22##');
      let parsed = null;
      if (marker !== -1) {
        const line = out.slice(marker + '##CR22##'.length).trim().split('\n')[0];
        try { parsed = JSON.parse(line); } catch { /* fall through */ }
      }
      resolve({
        handleId, eventId, code, signal, parsed,
        // An abort is the headline failure and must never be mistaken for a
        // refusal: a cell that dies produced no JSON at all.
        crashed: parsed === null,
        stderr: err.slice(-400),
      });
    });
  });
}

// The single classifier, used by both the run and its controls. Shared on
// purpose: a control that re-implemented this would be testing a copy, and the
// copy is what stays right while the original drifts.
//
// Returns { kind, detail } — kind 'CLEAN' | 'ACCEPTED' | 'VACUOUS' | a finding.
function classify(r, event) {
  if (r.crashed) {
    return { kind: 'CRASH', detail: `exit=${r.code} signal=${r.signal} ${r.stderr}` };
  }
  const p = r.parsed;

  // Vacuity first: a cell whose handle was never built, or never worked before
  // the event, cannot support a conclusion about what the event did to it.
  if (!p.made) return { kind: 'VACUOUS', detail: 'handle was never made' };
  if (p.baselineWorked === false) {
    return { kind: 'VACUOUS', detail: `baseline failed: ${p.baselineError}` };
  }

  // The worst outcome available, and it outranks the ledger.
  if (p.aliased === true) {
    return { kind: 'ALIASED',
      detail: `stale handle returned the REPLACEMENT state's data (${p.value})` };
  }

  // A kind marked `notAHandle` carries no marker to invalidate — it is the
  // caller's own JS object, handed back unchanged — so a "stale" event leaves
  // it perfectly usable and the refusal expectation does not apply. This is
  // the correction to CR-22 F1's first draft, which expected refusals here and
  // reported the resulting deep copies as an encapsulation break.
  const spec = HANDLES.find((h) => h.id === r.handleId);
  const expectation = (spec && spec.notAHandle && event.expect === 'refuses')
    ? 'works' : event.expect;

  if (expectation === 'works') {
    if (p.outcome !== 'value') {
      return { kind: 'UNEXPECTED-REFUSAL',
        detail: `handle should still be valid but ${p.outcome}: ${p.message}` };
    }
    // Slope between the final two rounds (see cell.mjs). A settled plateau
    // reads 0; a genuine leak adds ~25 per round. Slack of 5 absorbs an
    // incidental ref without coming close to a real leak's magnitude.
    if (event.measuresRegistry && typeof p.registryBefore === 'number'
        && p.registryAfter - p.registryBefore > 5) {
      return { kind: 'REGISTRY-GROWTH',
        detail: `registry still climbing at the last round: ${p.registryBefore} -> ${p.registryAfter} `
          + `(samples ${JSON.stringify(p.registrySamples)}, 25 handles abandoned per round) — slots not recycled` };
    }
    return { kind: 'CLEAN' };
  }

  // expectation === 'refuses'
  if (p.outcome !== 'threw') {
    return { kind: 'STALE-ANSWERED', detail: `handle should refuse but returned ${p.value}` };
  }
  // A refusal must name a reason. A bare N-API message is what CR-20 F5 hid
  // behind, so it does not count as a clean refusal.
  if (/^Invalid argument\.?$/i.test((p.message || '').trim())) {
    return { kind: 'OPAQUE-REFUSAL',
      detail: 'refused with the raw N-API "Invalid argument" instead of a reason' };
  }
  if (acceptedReason(r.handleId, r.eventId, p.outcome)) return { kind: 'ACCEPTED' };
  return { kind: 'CLEAN' };
}

const FINDING_KINDS = new Set(['CRASH', 'ALIASED', 'UNEXPECTED-REFUSAL',
  'REGISTRY-GROWTH', 'STALE-ANSWERED', 'OPAQUE-REFUSAL']);

// --- controls --------------------------------------------------------------
//
// The standing rule, and this instrument needs it more than most: almost every
// cell here is *supposed* to end in a throw, so a harness that reported
// "refused" unconditionally would look perfect. Each control below breaks one
// specific thing and requires the matrix to notice.
async function runControls() {
  const checks = [
    {
      name: 'a baseline cell actually builds and uses its handle (not vacuous)',
      run: async () => {
        const r = await runCell('table-ref', 'none');
        return !r.crashed && r.parsed.made === true
          && r.parsed.baselineWorked === true && r.parsed.outcome === 'value';
      },
    },
    {
      name: 'the vacuity check fires when the handle is never made',
      run: async () => {
        const r = await runCell('table-ref', 'none', ['--break-vacuity']);
        return !r.crashed && r.parsed.made === false;
      },
    },
    {
      name: 'a stale handle after reset is seen to refuse',
      run: async () => {
        const r = await runCell('table-ref', 'reset');
        return !r.crashed && r.parsed.outcome === 'threw';
      },
    },
    {
      name: 'a simulated stale read is both detected and classified as a finding',
      run: async () => {
        const r = await runCell('table-ref', 'reset-then-realias', ['--break-alias']);
        // Both halves: the cell reports aliased, and classify() — the same
        // function the real run uses — turns that into a finding rather than
        // counting it clean.
        return !r.crashed && r.parsed.aliased === true
          && classify(r, EVENTS.find((e) => e.id === 'reset-then-realias')).kind === 'ALIASED';
      },
    },
    {
      name: 'the re-alias probe actually changes the value it probes for',
      run: async () => {
        // Otherwise "not aliased" is unfalsifiable: if the probe wrote the same
        // value the handle already held, a genuine alias would read as clean.
        const r = await runCell('table-ref', 'none');
        return !r.crashed && String(r.parsed.value) === '1';
      },
    },
    {
      name: 'the registry probe returns a number (leak measurement is live)',
      run: async () => {
        const r = await runCell('table-ref', 'gc-churn');
        return !r.crashed && typeof r.parsed.registryBefore === 'number'
          && typeof r.parsed.registryAfter === 'number';
      },
    },
    {
      name: 'the registry probe reports a GENUINE leak (retained handles)',
      run: async () => {
        // The control that makes the growth threshold meaningful. Retaining
        // every churned handle is a real leak — the slots cannot be recycled —
        // and the probe has to say so. Without this, relaxing the threshold to
        // tolerate the high-water mark could silently blind the probe, which is
        // the mistake the first draft of this event made in the other
        // direction.
        const r = await runCell('table-ref', 'gc-churn', ['--leak-registry']);
        const v = classify(r, EVENTS.find((e) => e.id === 'gc-churn'));
        return !r.crashed && v.kind === 'REGISTRY-GROWTH';
      },
    },
    {
      name: 'a crashed cell is reported as a crash, not as a refusal',
      run: async () => {
        // `unknown` is not a handle id, so the cell exits 2 with no JSON —
        // the same shape a SIGABRT produces.
        const r = await runCell('no-such-handle', 'none');
        return r.crashed === true;
      },
    },
  ];

  console.log('Control (a search that reports clean must first report dirty):\n');
  let bad = 0;
  for (const c of checks) {
    let ok = false;
    try { ok = await c.run(); } catch (e) { console.log(`  threw: ${e.message}`); }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
    if (!ok) bad += 1;
  }
  console.log('');
  return bad === 0;
}

// --- the matrix ------------------------------------------------------------

async function main() {
  if (!await runControls()) {
    console.error('controls failed; refusing to run a search that cannot report dirty.');
    process.exit(1);
  }
  if (controlOnly) return;

  let handles = HANDLES;
  let events = EVENTS;
  if (onlyHandle) handles = handles.filter((h) => h.id === onlyHandle);
  if (onlyEvent) events = events.filter((e) => e.id === onlyEvent);

  const cells = [];
  for (const h of handles) {
    for (const e of events) {
      if (e.only && !e.only(h)) continue;
      cells.push([h.id, e.id, e]);
    }
  }
  console.log(`${cells.length} cells (${handles.length} handle kinds x lifecycle events), one process each\n`);

  const findings = [];
  const vacuous = [];
  const accepted = [];
  const usedLedger = new Set();
  let clean = 0;
  let done = 0;

  for (const [handleId, eventId, event] of cells) {
    const r = await runCell(handleId, eventId);
    done += 1;
    if (done % 10 === 0) process.stdout.write(`  ${done}/${cells.length}`);

    const verdict = classify(r, event);
    if (verdict.kind === 'CLEAN') clean += 1;
    else if (verdict.kind === 'ACCEPTED') {
      accepted.push({ handleId, eventId });
      usedLedger.add(`${handleId}#${eventId}`);
    } else if (verdict.kind === 'VACUOUS') {
      vacuous.push({ handleId, eventId, detail: verdict.detail });
    } else if (FINDING_KINDS.has(verdict.kind)) {
      findings.push({ handleId, eventId, ...verdict });
    }
  }
  console.log('\n');

  console.log(`Cells: ${cells.length}`);
  console.log(`  clean               ${clean}`);
  console.log(`  accepted (ledger)   ${accepted.length}   (${ACCEPTED.length} ledger entries)`);
  console.log(`  vacuous             ${vacuous.length}`);
  console.log(`  FINDINGS            ${findings.length}`);

  for (const v of vacuous) {
    console.log(`\nVACUOUS  ${v.handleId} x ${v.eventId}\n  ${v.detail}`);
  }
  for (const f of findings) {
    console.log(`\n${f.kind}  ${f.handleId} x ${f.eventId}\n  ${f.detail}`);
  }
  // A ledger entry that matched nothing is stale and is reported, because a
  // suppression list that can only ever hide things hides regressions too.
  if (!onlyHandle && !onlyEvent) {
    for (const e of ACCEPTED) {
      const matched = (e.handles || []).some((h) => (e.events || [])
        .some((ev) => usedLedger.has(`${h}#${ev}`)));
      if (!matched) console.log(`\nUNUSED ledger entry: matched no cell — remove or explain it.`);
    }
  }

  const dirty = findings.length > 0 || vacuous.length > 0;
  console.log(dirty ? '\ndirty.' : '\nclean.');
  process.exit(dirty ? 1 : 0);
}

await main();
