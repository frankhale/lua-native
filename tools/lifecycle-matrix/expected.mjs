// Cells whose outcome is the binding's design rather than a defect.
//
// Same terms as every other ledger here (tools/README.md): each entry carries
// the reason it is not a defect, and an entry whose cell stops matching is
// reported STALE rather than silently ignored. **Never ledger an undocumented
// behaviour** — while it is unspecified, ledgering it launders a finding into a
// feature.

export const ACCEPTED = [
  {
    // Every kind that carries no ContextLiveness refuses via the identity
    // comparison instead, and its message says "different Lua context" rather
    // than naming the reset. Accurate — after a reset the handle genuinely
    // belongs to a different (retired) state — but worth stating once here so
    // the wording is not mistaken for a wrong diagnosis.
    handles: ['coroutine'],
    events: ['reset', 'reset-twice', 'reset-then-realias'],
    outcome: 'threw',
    reason:
      'A coroutine handle carries no liveness flag; it holds a shared_ptr to '
      + 'the runtime that minted it and is policed at use by the identity check '
      + '(data->runtime.get() != runtime.get()). After a reset the context '
      + 'points at a new runtime, so the check fires and the message names a '
      + 'different context rather than naming the reset. Accurate — after a '
      + 'reset the handle genuinely does belong to a different (retired) state '
      + '— and the refusal is what matters. Ledgered only so the wording is not '
      + 'later mistaken for a wrong diagnosis. '
      + 'NOTE: this entry used to also list the userdata and class-instance '
      + 'kinds. They are not handles at all — `set_userdata` returns the '
      + "caller's own JS object with no marker — so they neither refuse nor "
      + 'need to (CR-22 F1, corrected). `userdata-lua` (a genuine Lua-created '
      + 'handle) does refuse, and is deliberately NOT ledgered: its refusal is '
      + 'the CR-22 fix and should read as clean, not as an accepted deviation.',
  },
];

export function acceptedReason(handleId, eventId, outcome) {
  for (const e of ACCEPTED) {
    if (e.handles && !e.handles.includes(handleId)) continue;
    if (e.events && !e.events.includes(eventId)) continue;
    if (e.outcome && e.outcome !== outcome) continue;
    return e.reason;
  }
  return null;
}
