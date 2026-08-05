# docs/

Everything at **this level is current**. Everything in
**[`reviews/`](reviews/) is frozen** — 27 files, none of them an instruction.

That split is carried by the directory itself rather than by this page, on
purpose: a reader who never opens this file still cannot mistake
`reviews/CODE-REVIEW-7.md` for something to act on.

---

## Start here

| Document | What it is |
|---|---|
| [`CORRECTNESS.md`](CORRECTNESS.md) | **The correctness posture.** What is covered and what is not, what reopens review (§15.6), the regression-run matrix (§15.7), and the binding platform scope (§14). The correctness programme is closed; this is its conclusion and operating manual. |
| [`FEATURES.md`](FEATURES.md) | What the binding actually does today. The reference for behaviour. |
| [`LIMITATIONS.md`](LIMITATIONS.md) | What it deliberately does **not** do, and what it does less completely than you might assume — the sandbox's real reach, binary strings, and the documented conversion losses. Every claim driven, not inferred. |

## Tooling

| Document | What it is |
|---|---|
| [`SANITIZERS.md`](SANITIZERS.md) | How to run the four sanitizer harnesses, and what each can and cannot see. |
| [`DIFFERENTIAL-ORACLE.md`](DIFFERENTIAL-ORACLE.md) | How the oracle works and what it does not cover. |
| [`../tools/README.md`](../tools/README.md) | The seven correctness harnesses and the conventions every instrument follows. Read before extending one. |

## Design references

Current; changed when the feature changes.

[`ASYNC.md`](ASYNC.md) ·
[`BYTECODE.md`](BYTECODE.md) ·
[`REQUIRE.md`](REQUIRE.md) ·
[`USERDATA.md`](USERDATA.md) ·
[`USERDATA-METHOD-BINDING.md`](USERDATA-METHOD-BINDING.md) ·
[`TABLE-REFERENCE.md`](TABLE-REFERENCE.md) ·
[`ELECTRON.md`](ELECTRON.md) ·
[`RELEASING.md`](RELEASING.md)

## [`reviews/`](reviews/) — frozen

| Document | What it is |
|---|---|
| `CODE-REVIEW-1.md` … `CODE-REVIEW-22.md` | One per pass. Each states its scope, method, baseline, findings, and — for most — a resolution table added after the fixes. These have **not** decayed, because each only claims what was true on its date. |
| [`CODE-REVIEW-HISTORY.md`](reviews/CODE-REVIEW-HISTORY.md) | The reasoning trail, in three parts: the trajectory commentary (CR-2→CR-17), the programme (CR-17→CR-22), and the sanitizer assessment. All three superseded **on their recommendations** — read for reasoning, never for what to do next. |
| [`CODE-REVIEW-LEDGER.md`](reviews/CODE-REVIEW-LEDGER.md) | Disposition ledger for CR-1–14, last audited at CR-8. Kept because entries (notably M6) are cited from source comments as the record of a deliberate decision. |
| [`FEATURE-HISTORY.md`](reviews/FEATURE-HISTORY.md) | The planned feature work, all implemented. Kept for rationale and as-built deltas. |
| [`BRIDGE-COMPARISON.md`](reviews/BRIDGE-COMPARISON.md) | Competitive survey against wasmoon, fengari and others. Every gap closed. Carries one dated **correction** (§C1 described a `properties` key that did not ship until August 2026) — the one file here that did *not* only claim what was true on its date. |
| [`INTEROP-PARITY-PLAN.md`](reviews/INTEROP-PARITY-PLAN.md) | The August 5, 2026 interop work: five gaps the survey's enumeration had no row for, because it was organised by capability and every capability answered yes. All implemented; the banner carries the three defects found while building that the plan itself did not predict. |

**There is no roadmap document.** New work must not start from either survey's
priority matrix — both are records, and every item in both is either implemented
or a stated scope decision. Bridge-gap **A5 (worker pool)** is the one item
either survey still shows as open, and it is a *scope decision, not a pending
task*: a `LuaRuntime` is single-threaded by construction, so parallelism means N
contexts plus a scheduler, which userland can build over `execute_script_async`
today.

One plan document existed briefly and is worth knowing about, because it says
what a *good* reason to write one looks like:
[`reviews/INTEROP-PARITY-PLAN.md`](reviews/INTEROP-PARITY-PLAN.md) (August 5,
2026, superseded the same day it was executed). It was not survey-derived —
every item came from driving the shipped API and finding a door that behaved
differently from its siblings, which is a different question from "what does the
competition have". That is the bar for the next one.

---

## Two rules that keep this from decaying

**1. A filename states what a document *is*, never what state the work is in.**

Identity is stable; status is not. A name containing *next*, *future*,
*deferred*, *gap*, *TODO*, *draft*, *WIP* or *pending* becomes false the moment
the work completes — and it is the worst place for a stale claim, because nobody
re-reads a filename to check it.

This was not hypothetical. Four files were renamed on August 4, 2026 for
exactly this, and every one had been lying for weeks:

| Was | Claimed | Actually | Now |
|---|---|---|---|
| `CODE-REVIEW-NEXT-STEPS.md` | next steps exist | the exit record; nothing open | `CORRECTNESS.md` |
| `CODE-REVIEW-DEFERRED.md` | items deferred | self-described "standing backlog"; mostly ✅ RESOLVED | `reviews/CODE-REVIEW-LEDGER.md` |
| `FUTURE.md` | a backlog | every entry struck through as Completed | `reviews/FEATURE-HISTORY.md` |
| `BRIDGE-GAP-ANALYSIS.md` | gaps exist | all closed | `reviews/BRIDGE-COMPARISON.md` |

**2. When something stops being current, say so in its first screen — and move
it to `reviews/`.**

Do not leave a reader to infer it from a date. Every frozen document here
carries a banner naming what superseded it. The programme's own recurring defect
was the stale marker — a document still calling something open, or deferred, or
the load-bearing guard, long after it had stopped being true — and it cost real
time (see `CORRECTNESS.md` §14 on the word *"deferred"*).

**A corollary, learned the expensive way.** Three reflective documents were
written during the programme and all three rotted identically: their analysis
aged fine, their *"what remains"* sections were overtaken within weeks. The
lessons that survived did so because they were **mechanized** — an invariant, a
control, a convention in `tools/README.md` — or **attached to the site** in a
code comment. So: if a lesson matters, encode it where it executes; failing
that, comment it at the line it protects; write prose only as a last resort, and
date its forecast so the rot is visible.
