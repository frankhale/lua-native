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

  io_write_handler:
    'The same containment as print_handler, at the other C frame behind the '
    + 'same handler. Added August 6, 2026 when the surface census reported '
    + '`LuaIoWrite` as a host-callable frame with no row: `LuaPrint` and '
    + '`LuaIoWrite` are separate C functions, print_handler triggered only the '
    + 'first, and its describe line claimed both. All eleven kinds are contained '
    + 'here exactly as they are through print(), which is the answer '
    + 'set_print_handler()\'s documentation already promised for io.write — this '
    + 'row is that promise now being checked rather than asserted.',

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
    'Reported correctly, as "Class \'Probe\' constructor must return an object". '
    + 'It lands here only because that message names the contract rather than the '
    + 'Symbol, so the kind\'s signature does not match it.',
  'class_constructor x return_bigint_out_of_range':
    'As above — the same "must return an object" error, which is the right one.',
  // --- frames added by INTEROP-PARITY-PLAN (August 5, 2026) -----------------

  // The three main-thread async frames share one reason: two of the eleven
  // kinds re-enter Lua from inside the callback (`errmem_oom` allocates by
  // running a script, `nested_then_throw` calls one), and re-entry during an
  // async run is refused by the occupancy guard. The refusal is the correct
  // outcome and it replaces the probe's own signature, so the cell reads as
  // "the failure never surfaced" when what actually happened is that the
  // failure was prevented. The other nine kinds surface normally at all three
  // frames, which is what makes this a property of the two kinds rather than
  // of the frames.
  'call_async_host x errmem_oom':
    'The kind re-enters Lua (execute_script) from inside the callback, which '
    + 'is_busy_ refuses during an async run. The refusal is correct and is what '
    + 'the cell observes instead of the OOM. The nine kinds that do not re-enter '
    + 'surface normally at this frame.',
  'call_async_host x nested_then_throw':
    'As above: the kind re-enters Lua before throwing, and re-entry is refused '
    + 'during an async run, so the inner throw never happens.',
  'resume_async_host x errmem_oom':
    'As call_async_host x errmem_oom — the same driver, the same guard.',
  'resume_async_host x nested_then_throw':
    'As call_async_host x nested_then_throw.',
  'coroutine_async_iterator x errmem_oom':
    'As call_async_host x errmem_oom; the async cursor steps through '
    + 'resume_async and inherits its occupancy guard.',
  'coroutine_async_iterator x nested_then_throw':
    'As call_async_host x nested_then_throw.',

  // The two handler frames whose contract is "return text": a *returned* value
  // is not a failure at all, so there is nothing to surface.
  'read_handler x return_bigint_out_of_range':
    'Not a failure. The read handler is contracted to return text and its '
    + 'return value is coerced with ToString, so a BigInt yields its digits — a '
    + 'perfectly good line of input. Nothing converts it through the LuaValue '
    + 'path, so the 2^53 range check never applies. Documented on '
    + 'set_read_handler().',
  'read_handler x return_deep_object':
    'As above — coerced with ToString to "[object Object]", which is a valid '
    + 'line. kMaxDepth never applies because no table conversion happens.',
  'file_reader x return_bigint_out_of_range':
    'The failure DOES surface, as the syntax error it should be: the reader is '
    + 'contracted to return Lua *source*, the value is coerced to text, and the '
    + 'text does not parse. The cell reads as non-surfacing only because the '
    + "parser's message carries no probe signature.",
  'file_reader x return_deep_object':
    'As above — coerced to "[object Object]", which is not valid Lua, and the '
    + 'load fails with a syntax error.',

  // A setter has no return value.
  'class_property_setter x return_symbol':
    'Not applicable. A property setter\'s return value is discarded — there is '
    + 'no conversion for a Symbol to be refused by.',
  'class_property_setter x return_bigint_out_of_range':
    'As above: the setter\'s return value is discarded, so an out-of-range '
    + 'BigInt is never converted.',
  'class_property_setter x return_deep_object':
    'As above: discarded, so kMaxDepth is never reached. (The matching getter '
    + 'cells DO surface, because a getter\'s return value is converted — which '
    + 'is what makes this a fact about setters rather than about accessors.)',

  // The proxy-userdata setter, added August 6, 2026 by the surface census —
  // `UserdataIndex` had a frame and `UserdataNewIndex` did not. Its three
  // non-surfacing cells are the same three as the class property setter's, for
  // the same reason, which is the evidence that the two accessor paths agree.
  'userdata_proxy_set x return_symbol':
    'Not applicable, as class_property_setter x return_symbol: a JS setter\'s '
    + 'return value is discarded, so there is no conversion for a Symbol to be '
    + 'refused by. The matching userdata_proxy_get cells DO surface.',
  'userdata_proxy_set x return_bigint_out_of_range':
    'As above: the setter\'s return value is discarded, so an out-of-range '
    + 'BigInt is never converted.',
  'userdata_proxy_set x return_deep_object':
    'As above: discarded, so kMaxDepth is never reached.',

  // loadfile, added August 6, 2026 by the surface census (`LuaLoadFile` was a
  // host-callable frame with no row; `file_reader` triggered only dofile).
  //
  // **The whole row is by-convention, not by-accident, and it was driven rather
  // than reasoned about.** `loadfile` returns `nil, message` where `dofile`
  // raises — Lua's own contract for the pair — so every failure here arrives as
  // a return value. Run side by side, the two frames produce the *identical*
  // message text through the two conventions:
  //
  //   dofile   -> THREW    "file reader failed for '/p.lua': boom"
  //   loadfile -> returned [null, "file reader failed for '/p.lua': boom"]
  //
  // Eight of the eleven kinds still read as surfacing because the probe's
  // signature survives into the message. These three do not, for reasons that
  // are already ledgered one frame over.
  'file_reader_loadfile x throw_error_hostile_message':
    'The failure DOES surface, in loadfile\'s `nil, message` form: the returned '
    + 'message is the generic "threw a value that could not be converted to a '
    + 'string". The cell reads as non-surfacing only because the hostile message '
    + 'is by construction unrecoverable, so nothing of the probe\'s identity is '
    + 'left to match on. Identical text to the dofile cell, which raises it.',
  'file_reader_loadfile x return_bigint_out_of_range':
    'As file_reader x return_bigint_out_of_range: the reader is contracted to '
    + 'return Lua *source*, the BigInt is coerced to its digits, and the digits '
    + 'do not parse. Surfaces as the syntax error it should be, via `nil, msg`.',
  'file_reader_loadfile x return_deep_object':
    'As above — coerced to "[object Object]", which is not valid Lua.',

};

// Longest-match lookup: a per-cell entry wins over a whole-row one.
export function expectedReason(frameId, kindId) {
  return EXPECTED_NON_SURFACING[`${frameId} x ${kindId}`]
    ?? EXPECTED_NON_SURFACING[frameId]
    ?? null;
}
