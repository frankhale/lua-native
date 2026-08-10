// The perf-claims census: every performance claim in shipped documentation is
// measured by a cell, or carries a written admission that nobody has measured
// it.
//
// **Why this exists** (`PERFORMANCE-PLAN` §7). Four performance claims reached
// the shipped README with no number, no test and no harness behind them — and
// one of them (`register_from_lua_converter`'s "Keep `match` cheap") is advice
// the user is expected to *act* on. They got there because nothing was
// watching. Everything else this harness produces is a measurement taken on one
// day; this is the part that runs next time.
//
// It is modelled on `assertion-strength`, which greps the suite for bare
// `.toThrow()` and fails closed, and it makes the same trade: **fuzzy matching,
// erring toward flagging.** A false positive costs one ledger line with a
// reason. A missed claim is the exact failure being closed.
//
// **The scoping rule is the part that was learned rather than designed.**
// Drafting the plan, a grep for this vocabulary turned up what looked like the
// strongest claims in the tree — a table of microsecond and millisecond figures
// under a heading reading `### Performance Implications`. They are estimates
// for `## Phase 2: ThreadSafeFunction Callbacks (Future)`, a design that was
// never built. A census that flags prose about code that does not exist trains
// its reader to dismiss it, and a dismissed census is worth less than none. So
// hits are scoped to sections describing shipped behaviour, and the skip list
// lives here in the harness rather than in prose.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Everything a user receives. `docs/reviews/` is deliberately absent: those are
// frozen records of what was true on their date (`docs/README.md`), and a claim
// inside one is a historical statement, not a promise. `types.d.ts` *is* here —
// it ships in package.json's `files`, an editor surfaces it at the call site,
// and it carries its own copy of two of the four claims.
export function shippedDocs() {
  const docs = readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`)
    .sort();
  return ['README.md', 'types.d.ts', ...docs];
}

// Claim-shaped vocabulary. The last four entries are here because the plan's
// own first draft omitted them and missed two candidate claims as a direct
// result: a vocabulary is an enumeration, and this one was short before it
// shipped (`PERFORMANCE-PLAN` §1).
//
// Bare `free` was tried and dropped: 43 hits, almost all of them
// "free the registry reference", which is memory management and not a cost
// claim. The qualified forms carry the claim.
export const VOCABULARY = [
  ['fast-path', /fast path/i],
  ['faster', /\bfaster\b/i],
  ['slower', /\bslower\b/i],
  ['overhead', /\boverhead\b/i],
  ['cheap', /\bcheap(er|ly)?\b/i],
  ['for-free', /\b(for|is|not|isn't|are) free\b/i],
  ['bounded', /\bbounded\b/i],
  ['linear', /\blinear\b/i],
  ['big-O', /\bO\([1n]/],
  ['performance-note', /\*\*Performance[:*]|Performance note/i],
  ['latency', /\blatency\b/i],
  ['microsecond', /microsecond|µs/i],
  ['millisecond-figure', /\d+\s*ms\b/],
  ['negligible', /\bnegligible\b/i],
  ['dominates', /\bdominat(e|es|ing)\b/i],
  ['efficient', /\befficient/i],
];

// A heading whose subtree describes something that was never built, or an
// alternative that was not taken. A hit under one of these is an estimate about
// absent code and is not a promise to anyone.
const HYPOTHETICAL = /\(Future\)|\bPhase \d|\bChallenge \d|\bOption [A-Z]\b|Alternatives considered|\bNot implemented\b|\bwould need\b/i;

// The claims an Axis A cell measures. A hit is COVERED when its line matches one
// of the cell's phrases — matched on the text rather than on a line number,
// because a line number churns on every edit above it and an invariant that
// cries wolf gets re-frozen without being read.
//
// **Nine, where the plan enumerated four.** C1–C4 are `PERFORMANCE-PLAN` §1's
// list, arrived at by grepping the README. C5–C9 are what this census found on
// its first run over the surface the same section defines but the plan did not
// actually search: `docs/*.md`, and `types.d.ts`, which ships in the package and
// carries claims the README never makes. Every one of the five is shipped, was
// unmeasured, and four of them state something the reader is expected to route
// on. See `tools/crossing-cost/FINDINGS.md` E1.
export const CLAIM_CELLS = {
  C1: {
    cell: 'A1-fast-path',
    phrases: [/stays on the fast path/i],
  },
  C2: {
    cell: 'A2-converter-scan',
    phrases: [/every registered `match` runs/i, /in registration order, until one matches/i],
  },
  C3: {
    cell: 'A3-sampling-bound',
    phrases: [/the overhead stays bounded/i],
  },
  C4: {
    cell: 'A4-bytecode-start',
    phrases: [/for faster startup/i],
  },
  C5: {
    cell: 'A5-async-threshold',
    phrases: [
      /The overhead of creating an `AsyncWorker`/i,
      /synchronous path is faster/i,
      /sync is faster for < 1ms scripts/i,
    ],
  },
  C6: {
    cell: 'A6-timeout-overshoot',
    phrases: [/tens of microseconds for a tight numeric loop/i],
  },
  C7: {
    cell: 'A7-parse-overhead',
    phrases: [/Every `execute_script` call compiles Lua source/i],
  },
  C8: {
    cell: 'A8-js-to-lua-scan',
    phrases: [/every registered `match` predicate runs/i, /register only the converters you need/i],
  },
  C9: {
    cell: 'A9-proxy-read',
    phrases: [/Matching against a Proxy is not free/i],
  },
  // C10 is the first claim to arrive through this census rather than be found by
  // it: `crossing-cost` F1 measured a decomposition the docs did not state, the
  // sentence was added, and the cell that asserts it was written in the same
  // change. That is the trigger working in the direction it was built for
  // (`CORRECTNESS.md` §15.6's documentation row) — the sentence could not have
  // shipped alone, because this census would have reported it UNCLAIMED.
  C10: {
    cell: 'A10-hook-fixed-floor',
    phrases: [/Hook overhead is/i, /the fixed part was already most of the overhead/i],
  },
};

// Hits that are real matches but not claims about this binding's cost. Every
// entry carries its reason, and an entry that stops matching anything is
// reported STALE rather than silently ignored — a suppression list that can
// only ever hide things hides regressions in the other direction too.
//
// What may NOT go here: a claim about the binding that nobody has measured.
// That is the finding, and ledgering it launders it into a feature
// (`PERFORMANCE-PLAN` §8).
export const CLAIM_LEDGER = [
  // --- not about time at all -----------------------------------------------
  {
    match: /is therefore a safe latency knob/i,
    reason: 'Tells a user when to pause the collector. Names no cost.',
  },
  {
    match: /latency-sensitive/i,
    reason: "A property of the *user's* workload, offered as motivation for an API. Not a cost of the binding.",
  },
  {
    match: /Bounded honestly/i,
    reason: '"Bounded" here scopes a *security* claim (what a sandboxed script can reach), not a cost.',
  },
  {
    match: /the half that is cheap to add/i,
    reason: 'Engineering effort in a review document, not runtime cost.',
  },
  {
    // Caught on its own first run, against a sentence written the same hour.
    // The census's subject is what the *binding* costs a user; the harnesses are
    // development-time tooling and nothing ships their runtime as a promise.
    // Kept as a class rather than a one-off, because the review documents
    // discuss instrument cost routinely and every such line would otherwise
    // arrive here.
    match: /census is cheap and fail-closed|harness.{0,40}\b(cheap|slow|expensive)\b.{0,40}\bruns?\b/i,
    reason: 'Describes the runtime of a development-time check (`check-invariants` / a `tools/` harness), '
      + 'not of the shipped binding. Nothing in the package promises what an instrument costs to run.',
  },
  {
    match: /a predicate is free to be defensive/i,
    reason: '"Free" as in permitted, not as in costless.',
  },

  // --- memory, which is binding-balance's subject and not this harness's ----
  {
    match: /more memory-efficient when many instances/i,
    reason: 'A memory claim, not a time claim. Retained-reference growth is `binding-balance`\'s subject '
      + '(CORRECTNESS.md §15.10); this harness measures time and would report nothing about it.',
  },
  {
    match: /overhead of one small Lua table per userdata is negligible/i,
    reason: 'Memory per userdata instance, not time. Same boundary as the entry above.',
  },

  // --- internal design rationale: no public API promises a cost here --------
  {
    match: /\*\*Why `shared_ptr`:\*\*/i,
    reason: 'Rationale for an internal ownership choice. Nothing public promises a cost.',
  },
  {
    match: /`LuaAllocator` static function matching the `lua_Alloc` signature/i,
    reason: 'Describes how every state is constructed. No cost is claimed to a caller.',
  },
  {
    match: /\*\*Always use custom allocator:\*\*/i,
    reason: 'Rationale for not branching between two allocators. An internal uniformity argument.',
  },
  {
    match: /so constructing many instances is cheap/i,
    reason: 'Explains that a class metatable is per-registry rather than per-instance — a structural fact, '
      + 'with no magnitude claimed and no threshold offered to route on.',
  },
  {
    match: /so replaying it is free/i,
    reason: 'Explains why a module registration can be replayed across `reset()`: it has no Lua-side identity. '
      + 'A statement about what must be rebuilt, not what it costs.',
  },
  {
    match: /`CreateEnvironment`: Validates the options object/i,
    reason: 'An implementation walkthrough; the vocabulary hit is incidental.',
  },
  {
    match: /\*\*One helper resets both budgets\.\*\*/i,
    reason: 'Rationale for collapsing three assignment sites into one helper. Maintenance, not runtime.',
  },
  {
    match: /\*\*Whole-value pushes, not per-key\.\*\*/i,
    reason: 'Records a deliberate API-shape decision. It notes the cost exists without claiming a magnitude, '
      + 'and no public sentence offers the reader a threshold.',
  },
  {
    match: /\*\*A method on the handle, not dotted paths on `get_global_ref`\.\*\*/i,
    reason: 'Compares two API shapes that were considered. Not a cost claim.',
  },
  {
    match: /so checking the flag adds negligible/i,
    reason: 'An internal registry lookup inside a design-rationale section. Not a public promise.',
  },

  // --- guidance with no magnitude ------------------------------------------
  {
    match: /converting to a Lua table is correct and effic/i,
    reason: 'Guidance on which API fits which shape of data. No magnitude claimed.',
  },
  {
    match: /user-visible latency spikes/i,
    reason: 'Names the class of problem async execution addresses. No magnitude claimed.',
  },
  {
    match: /A Lua script that runs for 50ms blocks the entire|event loop for 50ms/i,
    reason: 'A worked example using an arbitrary script duration to illustrate event-loop blocking. '
      + 'The 50ms is the example\'s premise, not a measurement of anything here.',
  },

  // --- estimates for code that was never built ------------------------------
  {
    match: /parallelism is near zero and the overhead is strictly worse/i,
    reason: 'Describes a configuration `execute_script_async` refuses: JS callbacks are disallowed in async mode '
      + 'and raise (ASYNC.md:22, ASYNC.md:272), so no shipped configuration can reach this cost. '
      + 'It describes the unbuilt Phase 2 TSFN design.',
  },
  {
    match: /Per-callback overhead of ~10us-1ms for thread marshalling/i,
    reason: 'The **Phase 2 column** of a Phase-1-vs-Phase-2 comparison table — an estimate for the TSFN design '
      + 'that was never built. Same class as the two figures that caused the plan\'s §1 false start, but reached '
      + 'through a *table row* rather than a heading, which is why HYPOTHETICAL heading scoping does not catch it. '
      + 'If a third of these appears, scope table columns rather than growing this list.',
  },
];

function headingSkipReason(stack) {
  for (const h of stack) if (h && HYPOTHETICAL.test(h)) return h.trim();
  return null;
}

// Short, stable excerpt for the key. Long enough to identify the claim, short
// enough that the frozen file stays readable.
function excerpt(line) {
  const t = line.trim().replace(/\s+/g, ' ').replace(/^[-*>\s]+/, '');
  return t.length > 88 ? `${t.slice(0, 85)}...` : t;
}

export function perfClaims() {
  const out = {};
  const files = shippedDocs();
  const ledgerHits = new Map(CLAIM_LEDGER.map((e, i) => [i, 0]));
  const claimHits = new Map(Object.keys(CLAIM_CELLS).map((k) => [k, 0]));

  let examined = 0;
  let skipped = 0;
  let covered = 0;
  let ledgered = 0;
  const unclaimed = [];

  for (const rel of files) {
    let src;
    try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
    // `\r?\n`, not `\n`: with `core.autocrlf=true` (the default on Windows) every
    // file in the tree is checked out CRLF, and a split on `\n` leaves a trailing
    // `\r` on every line. That is not cosmetic here — JS regex `.` excludes line
    // terminators, `\r` among them, so the heading pattern's `(.*)$` could never
    // reach `$` and **not one heading in the tree matched**. With an empty
    // heading stack nothing was scoped as hypothetical, and the ten Phase-2
    // estimates this census exists to skip were reported as UNCLAIMED instead.
    // A scanner that silently sees no headings is exactly the "believing the
    // zero" failure the totals below are frozen to catch.
    const lines = src.split(/\r?\n/);
    const stack = [];
    let inFence = false;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h && !inFence) {
        const level = h[1].length;
        stack.length = level - 1;
        stack[level - 1] = h[2];
        continue;
      }
      // A fenced block is example code, not a claim. Its *prose* neighbours are
      // where the claims live.
      if (inFence) continue;

      const terms = VOCABULARY.filter(([, re]) => re.test(line)).map(([id]) => id);
      if (terms.length === 0) continue;
      examined += 1;

      const skip = headingSkipReason(stack);
      if (skip) { skipped += 1; continue; }

      const key = `${rel}: ${excerpt(line)}`;

      // Prose wraps, and a claim wraps with it. Matching a single line leaves
      // orphan fragments — `docs/ASYNC.md` really does have a line reading just
      // "overhead.", the tail of a sentence whose subject is on the line above,
      // and no honest ledger entry can be written for a word on its own. So
      // claim and ledger patterns are matched against the hit line joined with
      // its two neighbours, while the *key* stays the hit line.
      //
      // The trade this makes: a claim sentence sitting directly beside an
      // unrelated hit could cover it by proximity. Accepted, because the
      // alternative is a ledger of sentence fragments, which is the shape of a
      // list nobody reads. If it ever bites, narrow the window rather than
      // widening the ledger.
      // **The line wins over the window**, and that ordering is load-bearing.
      // Matched on the window alone, C2's "in registration order, until one
      // matches" reached across and claimed the *next* sentence — the Proxy
      // warning C9 measures — so C9 matched nothing and reported STALE while
      // every line was accounted for. A neighbour is evidence about an orphan
      // fragment, never about a line that can speak for itself.
      const window = [lines[idx - 1] ?? '', line, lines[idx + 1] ?? ''].join(' ');
      const cells = Object.entries(CLAIM_CELLS);
      const claim = cells.find(([, c]) => c.phrases.some((p) => p.test(line)))
        ?? cells.find(([, c]) => c.phrases.some((p) => p.test(window)));
      if (claim) {
        claimHits.set(claim[0], claimHits.get(claim[0]) + 1);
        covered += 1;
        out[key] = `COVERED by ${claim[1].cell} (${claim[0]})`;
        continue;
      }

      const li = CLAIM_LEDGER.findIndex((e) => e.match.test(line)) >= 0
        ? CLAIM_LEDGER.findIndex((e) => e.match.test(line))
        : CLAIM_LEDGER.findIndex((e) => e.match.test(window));
      if (li >= 0) {
        ledgerHits.set(li, ledgerHits.get(li) + 1);
        ledgered += 1;
        continue;
      }

      unclaimed.push(key);
      out[key] = `UNCLAIMED [${terms.join(',')}] — measure it with an Axis A cell, or ledger it with a reason`;
    }
  }

  for (const [i, n] of ledgerHits) {
    if (n === 0) {
      out[`stale ledger entry: ${CLAIM_LEDGER[i].match.source.slice(0, 60)}`] =
        'STALE — matches nothing; the claim it excused is gone, so remove the entry';
    }
  }
  for (const [id, n] of claimHits) {
    if (n === 0) {
      out[`stale claim: ${id}`] =
        `STALE — ${CLAIM_CELLS[id].cell} claims to measure a sentence that is no longer in the docs`;
    }
  }

  // The totals are frozen alongside the zero, and that is the load-bearing part
  // (CR-19 F2, CR-21 F3). "0 UNCLAIMED" is exactly what a scanner that has
  // stopped matching anything also reports; a drop in "claim-shaped lines
  // examined" reads as broken rather than as clean.
  out['files scanned'] = files.length;
  out['claim-shaped lines examined'] = examined;
  out['skipped: under a hypothetical heading'] = skipped;
  out['COVERED by a cell'] = covered;
  out['LEDGERED with a reason'] = ledgered;
  out['UNCLAIMED'] = unclaimed.length;
  return out;
}
