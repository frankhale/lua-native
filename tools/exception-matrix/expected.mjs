// CR-18: cells whose failure correctly does *not* surface to the caller.
//
// A matrix that reports 52 rows for a human to re-triage on every run is a
// matrix nobody runs twice. The triage is therefore recorded here, one entry
// per reason, and the runner reports a matching cell as BY_DESIGN rather than
// SWALLOWED.
//
// Two rules keep this from becoming the kind of hand-maintained list this
// codebase keeps getting bitten by:
//
//   * Every entry carries the reason it is not a defect. "It was like that
//     before" is not one.
//   * An entry that stops applying — the cell surfaces its failure now — is
//     reported as STALE_EXPECTATION, not silently ignored. A list that only
//     ever suppresses can hide a regression in the opposite direction.
//
// Keys are `frameId` (the whole row) or `frameId x kindId` (one cell).

export const EXPECTED_NON_SURFACING = {
  gc_finalizer:
    "Lua's own contract: an error in a __gc finalizer is reported as a warning "
    + 'and never propagates to whoever triggered the collection. The addon has no '
    + 'caller to hand it to — `gc("collect")` is not the code that created the '
    + 'garbage. Process survival and a usable context afterwards are the whole '
    + 'assertion here, and both hold for all ten kinds.',

  gc_finalizer_at_close:
    'As gc_finalizer, and more so: these fire from lua_close inside reset(), '
    + 'where the state is being destroyed and there is no Lua error handler above '
    + 'them at all. This is the frame with the least margin in the matrix — an '
    + 'escape here unwinds through a destructor — and all ten kinds are contained.',

  debug_hook:
    'Deliberate containment (CR-18 F3): the hook runs between VM instructions '
    + 'inside Lua execution, so a C++ exception unwinding through it would corrupt '
    + 'the VM. The trade-off is now stated on set_hook() in types.d.ts, which is '
    + 'what was actually missing — the behaviour was right and undiscoverable.',

  print_handler:
    'Deliberate containment (CR-18 F3): the handler runs inside Lua\'s C call '
    + 'frame for print / io.write. Same trade-off, same fix — documented on '
    + 'set_print_handler() rather than only in a comment.',

  'class_constructor x return_deep_object':
    'Not a failure. The over-deep object is a perfectly good JS object; the '
    + 'constructor returns it and Lua holds it by reference as userdata. Nothing '
    + 'converts it, so the depth limit is never reached and the script succeeds — '
    + 'which is correct.',

  'from_lua_converter x return_bigint_out_of_range':
    "A from-Lua converter's return value is used verbatim (types.d.ts): the "
    + 'result is already a JS value and is not converted again. A BigInt is a legal '
    + 'JS value, so there is nothing to fail.',
  'from_lua_converter x return_deep_object':
    'As above — used verbatim, never converted, so kMaxDepth does not apply.',
  'from_lua_converter_async x return_bigint_out_of_range':
    'As from_lua_converter; the async marshal uses the same rule.',
  'from_lua_converter_async x return_deep_object':
    'As from_lua_converter; the async marshal uses the same rule.',

  'pcall_frame x return_bigint_out_of_range':
    'pcall() of a plain JS function returns its value as-is; no Lua conversion '
    + 'happens, so an unconvertible value is not unconvertible here.',
  'pcall_frame x return_deep_object':
    'As above — no conversion, so no depth limit.',
  'pcall_frame x throw_error_hostile_message':
    'The failure *is* reported: pcall returns { ok: false, error: <the Error> }. '
    + 'The harness cannot read the marker out of it because that specific kind\'s '
    + 'error is one whose .message and .name getters both throw — which is the '
    + 'point of the kind. Reported rather than hidden, so the row is honest.',

  'class_constructor x return_symbol':
    'Reported correctly, as "Class \'Cr18\' constructor must return an object". '
    + 'It lands here only because that message names the contract rather than the '
    + 'Symbol, so the kind\'s signature does not match it.',
  'class_constructor x return_bigint_out_of_range':
    'As above — the same "must return an object" error, which is the right one.',
};

// Longest-match lookup: a per-cell entry wins over a whole-row one.
export function expectedReason(frameId, kindId) {
  return EXPECTED_NON_SURFACING[`${frameId} x ${kindId}`]
    ?? EXPECTED_NON_SURFACING[frameId]
    ?? null;
}
