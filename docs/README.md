# docs/

**The one thing to know:** of the 38 documents here, **six are live** and the
rest are archive. The count is not the problem — 22 numbered review passes are
self-evidently a record and nobody mistakes `CODE-REVIEW-7.md` for an
instruction. What causes confusion is not knowing *which* documents are still
in force, so that is what this index is for.

---

## Live — read these, keep them current

| Document | What it is |
|---|---|
| [`CODE-REVIEW-NEXT-STEPS.md`](CODE-REVIEW-NEXT-STEPS.md) | **The exit record.** §15 is what is covered, what is not, what reopens review, and the regression-run matrix. §14 is the binding platform/CI scope. Start here. |
| [`CODE-REVIEW-DEFERRED.md`](CODE-REVIEW-DEFERRED.md) | The deferred/resolved ledger. **Cited from source comments** (e.g. `deferred-ledger M6` in `src/lua-native.cpp`), so it is a reference, not a record. |
| [`SANITIZERS.md`](SANITIZERS.md) | How to run the four sanitizer harnesses, and what each can and cannot see. |
| [`DIFFERENTIAL-ORACLE.md`](DIFFERENTIAL-ORACLE.md) | How the oracle works and what it does not cover. |
| [`FEATURES.md`](FEATURES.md), [`FUTURE.md`](FUTURE.md) | What exists, and the feature roadmap. `FUTURE.md` is the roadmap; the correctness programme is separate and closed. |
| [`../tools/README.md`](../tools/README.md) | The harness index and the conventions every instrument follows. Read before extending one. |

## Design references — current, changed only when the feature changes

[`ASYNC.md`](ASYNC.md) ·
[`BYTECODE.md`](BYTECODE.md) ·
[`REQUIRE.md`](REQUIRE.md) ·
[`USERDATA.md`](USERDATA.md) ·
[`USERDATA-METHOD-BINDING.md`](USERDATA-METHOD-BINDING.md) ·
[`TABLE-REFERENCE.md`](TABLE-REFERENCE.md) ·
[`ELECTRON.md`](ELECTRON.md) ·
[`RELEASING.md`](RELEASING.md) ·
[`BRIDGE-GAP-ANALYSIS.md`](BRIDGE-GAP-ANALYSIS.md)

## Archive — never changes again

| Document | What it is |
|---|---|
| [`CODE-REVIEW-HISTORY.md`](CODE-REVIEW-HISTORY.md) | The programme's reasoning trail. **Part I** is the trajectory commentary CR-2 → CR-17 (was `CODE-REVIEW-THOUGHTS.md`, merged August 4, 2026); **Part II** is the programme CR-17 → CR-22 (was `CODE-REVIEW-NEXT-STEPS.md` §§1–12). Superseded by §15 — read it for reasoning, never for recommendations. |
| `CODE-REVIEW-1.md` … `CODE-REVIEW-22.md` | One per pass, in order. Each states its scope, method, baseline, findings, and — for most — a resolution table added after the fixes. |
| [`SANITIZERS-THOUGHTS.md`](SANITIZERS-THOUGHTS.md) | Reflective notes on the sanitizer work. Stops at CR-6; the operational content is in `SANITIZERS.md`. **The obvious next merge candidate** into `CODE-REVIEW-HISTORY.md` Part I, on the same grounds `CODE-REVIEW-THOUGHTS.md` was merged. |

---

## The rule that keeps this from decaying again

The programme's own recurring defect was a **stale marker** — a document that
still said something was open, or deferred, or the load-bearing guard, long
after it had stopped being true. It cost real time (see
`CODE-REVIEW-NEXT-STEPS.md` §14 on the word *"deferred"*), and CR-21 A5 found
three such comments where the review had named one.

So: **when something moves from live to archive, say so at the top of the
document, in the first screen, with a pointer to what replaced it.** Do not
leave it to a reader to infer from a date. Both merged documents carry that
banner; this index is the second line of defence, not the first.
