// CR-18 exception-escape matrix: the runner.
//
//   node tools/exception-matrix/run.mjs                       # the whole matrix
//   node tools/exception-matrix/run.mjs --frame=host_function # one row
//   node tools/exception-matrix/run.mjs --kind=throw_error    # one column
//   node tools/exception-matrix/run.mjs --control             # prove it can report dirty
//   node tools/exception-matrix/run.mjs --json=out.json
//
// One child process per cell. The failure mode being searched for is
// `std::terminate`, which kills the run — so a crash has to be a data point
// rather than the end of the matrix. This is the same construction CR-16 and
// CR-17 used, for the same reason.
//
// **The control is not optional.** CR-17's first orphan matrix was entirely
// vacuous and reported clean; the rule it left behind is that an exhaustive
// search reporting clean must first demonstrate it can report dirty.
// `--control` runs cells whose outcome is known bad and fails if they come back
// clean. `run.mjs` runs it automatically before the real matrix.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './frames.mjs';
import { KINDS } from './kinds.mjs';
import { expectedReason } from './expected.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CELL = join(HERE, 'cell.mjs');
const CONCURRENCY = Math.max(2, Math.min(8, (await import('node:os')).cpus().length - 2));
const TIMEOUT_MS = 30_000;

const argv = process.argv.slice(2);
const arg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const onlyFrame = arg('frame');
const onlyKind = arg('kind');
const jsonOut = arg('json');
const controlOnly = argv.includes('--control');
const quiet = argv.includes('--quiet');

function runCell(frameId, kindId, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--expose-gc', CELL, frameId, kindId, ...extraArgs], {
      cwd: join(HERE, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const at = stdout.indexOf('##CR18##');
      let parsed = null;
      if (at >= 0) {
        const line = stdout.slice(at + '##CR18##'.length).trim().split('\n')[0];
        try { parsed = JSON.parse(line); } catch { /* fall through to CRASH */ }
      }
      if (parsed && code === 0) {
        resolve({ ...parsed, exitCode: code, signal, stderr: stderr.slice(-600) });
        return;
      }
      // No JSON, or JSON followed by a bad exit: the process did not come back
      // cleanly. That is the finding this matrix exists for.
      resolve({
        frame: frameId,
        kind: kindId,
        status: signal || code !== 0 ? 'ABORTED' : 'NO_RESULT',
        exitCode: code,
        signal,
        surfaced: parsed ? parsed.surfaced : null,
        partial: parsed,
        stderr: stderr.slice(-600),
        notes: [parsed ? 'cell reported, then the process died on the way out' : 'cell produced no result'],
      });
    });
  });
}

async function runAll(cells) {
  const results = new Array(cells.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = next++;
      if (i >= cells.length) return;
      results[i] = await runCell(cells[i].frame, cells[i].kind, cells[i].extra);
      done++;
      if (!quiet) process.stderr.write(`\r  ${done}/${cells.length} cells`);
    }
  });
  await Promise.all(workers);
  if (!quiet) process.stderr.write('\n');
  return results;
}

// --- the control -----------------------------------------------------------
//
// Cells whose correct outcome is known, run before the matrix is believed.
// A control that comes back the way a clean cell comes back means the harness
// cannot see the thing it is looking for, and the matrix's clean rows mean
// nothing.
async function runControls() {
  const controls = [
    {
      name: 'a process abort is reported as ABORTED, not as a clean cell',
      cell: { frame: 'host_function', kind: 'throw_error', extra: ['--force-abort'] },
      ok: (r) => r.status === 'ABORTED',
    },
    {
      name: 'a swallowed exception is reported as SWALLOWED, not as clean',
      cell: { frame: 'host_function', kind: 'throw_error', extra: ['--force-swallow'] },
      ok: (r) => r.status === 'SWALLOWED',
    },
    {
      name: 'an unusable context is reported as CONTEXT_DEAD',
      cell: { frame: 'host_function', kind: 'throw_error', extra: ['--force-dead-context'] },
      ok: (r) => r.status === 'CONTEXT_DEAD',
    },
    {
      name: 'an ordinary contained throw is reported as CLEAN',
      cell: { frame: 'host_function', kind: 'throw_error', extra: [] },
      ok: (r) => r.status === 'CLEAN',
    },
  ];

  console.log('Control (an exhaustive search that reports clean must first report dirty):\n');
  let bad = 0;
  for (const c of controls) {
    const r = await runCell(c.cell.frame, c.cell.kind, c.cell.extra);
    const pass = c.ok(r);
    if (!pass) bad++;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${c.name}`);
    if (!pass) console.log(`        got status=${r.status} exit=${r.exitCode} signal=${r.signal}`);
  }
  console.log('');
  return bad;
}

// --- main ------------------------------------------------------------------

const badControls = await runControls();
if (badControls > 0) {
  console.error(`${badControls} control(s) failed — the harness cannot report what it claims to search for.`);
  console.error('Fix the harness before believing any clean cell.');
  process.exit(1);
}
if (controlOnly) process.exit(0);

const frames = onlyFrame ? FRAMES.filter((f) => f.id === onlyFrame) : FRAMES;
const kinds = onlyKind ? KINDS.filter((k) => k.id === onlyKind) : KINDS;
const cells = [];
for (const f of frames) for (const k of kinds) cells.push({ frame: f.id, kind: k.id });

console.log(`CR-18 exception-escape matrix: ${frames.length} frames x ${kinds.length} kinds = ${cells.length} cells`);
console.log(`  concurrency ${CONCURRENCY}, one process per cell\n`);

const results = await runAll(cells);

// --- report ----------------------------------------------------------------

// Fold in the recorded triage: a SWALLOWED cell with a justified reason is
// BY_DESIGN, and a cell that has a reason but no longer needs one is a stale
// expectation — reported, because a suppression list that can only ever hide
// things hides regressions in the other direction too.
for (const r of results) {
  const reason = expectedReason(r.frame, r.kind);
  if (!reason) continue;
  if (r.status === 'SWALLOWED') { r.status = 'BY_DESIGN'; r.reason = reason; }
  else if (r.status === 'CLEAN') { r.status = 'STALE_EXPECTATION'; r.reason = reason; }
}

const byStatus = {};
for (const r of results) (byStatus[r.status] ??= []).push(r);

const STATUS_ORDER = ['ABORTED', 'NO_RESULT', 'HARNESS_ERROR', 'CONTEXT_DEAD', 'VACUOUS', 'SWALLOWED', 'STALE_EXPECTATION', 'NOT_APPLICABLE', 'BY_DESIGN', 'CLEAN'];
console.log('Summary:');
for (const s of STATUS_ORDER) {
  if (byStatus[s]) console.log(`  ${s.padEnd(16)} ${String(byStatus[s].length).padStart(4)}`);
}
for (const s of Object.keys(byStatus)) {
  if (!STATUS_ORDER.includes(s)) console.log(`  ${s.padEnd(16)} ${String(byStatus[s].length).padStart(4)}`);
}

for (const s of ['ABORTED', 'NO_RESULT', 'HARNESS_ERROR', 'CONTEXT_DEAD', 'VACUOUS', 'STALE_EXPECTATION']) {
  if (!byStatus[s]) continue;
  console.log(`\n=== ${s} ===`);
  for (const r of byStatus[s]) {
    console.log(`  ${r.frame} x ${r.kind}  exit=${r.exitCode} signal=${r.signal}`);
    if (r.stderr) console.log(`      stderr: ${r.stderr.replace(/\n/g, ' | ').slice(0, 300)}`);
    if (r.contextProbe) console.log(`      probe:  ${r.contextProbe}`);
  }
}

if (byStatus.SWALLOWED) {
  console.log('\n=== SWALLOWED (the failure never surfaced; read each one) ===');
  for (const r of byStatus.SWALLOWED) {
    console.log(`  ${r.frame} x ${r.kind}`);
    console.log(`      trigger ${r.triggerOutcome} -> ${r.surfaced}`);
  }
}

// Strandedness is reported separately: it is not a pass/fail, it is a number to
// look at. A frame whose failure path orphans a registry slot or a callback
// registration grows here and nowhere else.
const leaky = results
  .filter((r) => typeof r.memGrowthPerIteration === 'number' && r.memGrowthPerIteration > 1024)
  .sort((a, b) => b.memGrowthPerIteration - a.memGrowthPerIteration);
if (leaky.length) {
  console.log('\n=== growth per repeat > 1 KB (possible stranded registration) ===');
  for (const r of leaky.slice(0, 25)) {
    console.log(`  ${String(r.memGrowthPerIteration).padStart(8)} B/iter  ${r.frame} x ${r.kind}  (${r.repeats} repeats, ${r.strandednessScope ?? '?'})`);
  }
}

// Cells whose re-install was refused measured the trigger only, not the
// registration path. Reported rather than folded into the clean total, because
// "install and trigger strands nothing" is not what those cells checked
// (CR-19 F4).
const triggerOnly = results.filter((r) => r.strandednessScope === 'trigger-only');
if (triggerOnly.length) {
  const frames = [...new Set(triggerOnly.map((r) => r.frame))];
  console.log(`\n=== strandedness measured trigger-only (re-install refused): ${triggerOnly.length} cells ===`);
  console.log(`  frames: ${frames.join(', ')}`);
  console.log('  these cells do not test whether re-registration strands anything');
}

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nfull results -> ${jsonOut}`);
}

const nonClean = results.filter((r) => !['CLEAN', 'NOT_APPLICABLE', 'BY_DESIGN'].includes(r.status));
console.log(`\n${results.length - nonClean.length}/${results.length} cells clean, by-design or not-applicable; ${nonClean.length} to read.`);
process.exit(nonClean.length > 0 ? 1 : 0);
