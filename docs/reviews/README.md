# docs/reviews/ — frozen

**Nothing in this directory is an instruction.** Every file is a record of what
was true on its date, kept for reasoning and provenance. If you are looking for
what to do, what is covered, or what to run, that is
[`../CORRECTNESS.md`](../CORRECTNESS.md).

- `CODE-REVIEW-1.md` … `CODE-REVIEW-23.md` — one per pass, in order. CR-23
  (August 6, 2026) is the second exercise of the new-surface trigger, over the
  post-closure option surface (`sandbox`, `binaryStrings`, `strictConversion`,
  the `set_read_handler` rewiring). All five findings resolved; it added the
  **mode** axis to `roundtrip-matrix` and the mode row to `CORRECTNESS.md`
  §15.6, which the trigger table had been missing.
- `CODE-REVIEW-HISTORY.md` — the reasoning trail (three parts). Superseded on
  its recommendations.
- `CODE-REVIEW-LEDGER.md` — disposition ledger, CR-1–14, audited at CR-8. Cited
  from source comments (M6).
- `FEATURE-HISTORY.md` — the planned feature work, all implemented.
- `BRIDGE-COMPARISON.md` — competitive survey; every gap closed.
- `INTEROP-PARITY-PLAN.md` — the five interop-parity gaps (P1–P5), planned and
  executed August 5, 2026; the first exercise of the new-surface trigger.
- `UNSEARCHED-REGIONS-PLAN.md` — the five unsearched-region workstreams (W1–W5),
  planned and executed August 6, 2026. Its §7 closing condition survives as an
  instruction and lives in `../CORRECTNESS.md` §15.10; everything else here is
  the record of how it was reached.

The correctness programme closed on August 4, 2026 after CODE-REVIEW-22. Review
is now triggered by **new surface, not by the calendar** — see
[`../CORRECTNESS.md`](../CORRECTNESS.md) §15.6 for what counts as a trigger and
which instrument to extend.
