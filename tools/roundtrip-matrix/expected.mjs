// Round-trip changes that the public API specifies, so the matrix reports only
// what is *not* specified.
//
// Same terms as the exception-matrix and oracle ledgers: every entry carries the reason, cites where
// the reason is written down, and a value that starts round-tripping is
// reported as STALE rather than silently ignored.
//
// CR-20's three findings were absent from this ledger while they were open, on
// the principle that ledgering an *undocumented* loss launders a finding into a
// feature. They are here now because each has been resolved: F3 was fixed
// (negative zero round-trips, so it needs no entry at all), and F1 and F2 were
// resolved the way CR-18 resolved O1-O3 — by being specified on the public API,
// which is what makes them ledgerable.

export const EXPECTED = [
  {
    valuePattern: '^(arr:with-null|obj:null-value)$',
    reason:
      'CR-20 F1, now specified on `LuaInput` in types.d.ts. `null` and '
      + '`undefined` both become Lua nil, and a nil value removes its key — so a '
      + 'null inside an array truncates the sequence (`#` stops at the hole) and a '
      + 'null object value removes the key. The later array values are still '
      + 'present and reachable by index; it is the sequence that breaks. The '
      + 'documented workaround (`false` as a placeholder, or filtering first) is '
      + 'pinned in the suite. '
      + 'Under the `strict` modes these same cells are *changed* for the opposite '
      + 'reason — every door refuses them rather than performing the truncation — '
      + 'so the entry covers both without being two entries. The counts cannot '
      + 'tell those apart, but the mode vacuity control proves the refusal is '
      + 'happening and parity proves all eighteen doors do the same thing, which '
      + 'is the property LIMITATIONS.md §5 claims.',
  },
  {
    value: 'obj:cyclic',
    reason:
      'CR-20 F2, fixed: refused at the first repeat with a message naming the '
      + 'cycle rather than the depth limit. A refusal is the correct outcome — Lua '
      + 'tables cannot represent a cycle, so there is no lossy conversion to fall '
      + 'back on — and it is identical at all twelve doors. The message change is '
      + 'pinned, as is the DAG control that keeps the detection path-based.',
  },
  {
    valuePattern: '^builtin:',
    modes: ['default', 'strict'],
    reason:
      'The built-in conversions are one-way by specification. `LuaInput` says so '
      + 'directly: it is wider than `LuaValue` and covers "Date, Map, Set, '
      + 'ArrayBuffer, ArrayBufferView ... none of which Lua can produce on the way '
      + 'out." A Date arrives as a number, a Set as a sequence, a Uint8Array as a '
      + 'byte string, and none comes back as itself. Stated, and stated in the '
      + 'type the caller reads. Scoped to the text modes because one of them '
      + 'stops being true under `binaryStrings` — see the next two entries.',
  },
  {
    valuePattern: '^builtin:(Date|Map|Set|ArrayBuffer|RegExp)$',
    modes: ['binary', 'strict+binary'],
    reason:
      'The same one-way specification, still true under `binaryStrings` for the '
      + 'five built-ins that do not become a Lua *string*. A Date is a number, a '
      + 'Map a table, a Set a sequence, a RegExp its source text, and an '
      + 'ArrayBuffer arrives as a Uint8Array rather than as itself — Lua holds '
      + 'bytes and cannot record which of the two views produced them.',
  },
  {
    // Not an entry for a loss: an entry recording that a documented loss STOPS
    // here, kept because the matrix would otherwise report the absence as a
    // stale ledger row and because the property is worth stating. CR-23 F4's
    // mode axis found it on its first run.
    value: 'builtin:Uint8Array',
    modes: ['binary', 'strict+binary'],
    roundTripsInstead: true,
    reason:
      'ROUND-TRIPS under `binaryStrings`, unlike every other built-in. A '
      + 'Uint8Array goes in as a binary-safe Lua string (B1) and comes back as a '
      + 'Uint8Array of the same bytes, so binary data is the one conversion that '
      + 'is *closed* in this mode rather than one-way. Recorded because '
      + '`LuaInput` says the built-ins are one-way without qualification, and in '
      + 'this mode that sentence is too strong. See LIMITATIONS.md §2.',
  },
  {
    valuePattern: '^(str:.*|arr:mixed|obj:flat|obj:numeric-keys|obj:key-collision)$',
    modes: ['binary', 'strict+binary'],
    reason:
      'Every Lua string comes back as a Uint8Array of its exact bytes, which is '
      + 'the entire specification of `binaryStrings` (LIMITATIONS.md §2 and '
      + '`LuaContextOptions.binaryStrings`). It is a *type* change and not a data '
      + 'loss — the bytes are exactly what Lua held, which is more than the '
      + 'default path can say — and it reaches nested strings too, which is why '
      + 'the three container values and the mixed array are listed beside the '
      + 'nine string values. Table *keys* stay strings in this mode; the values '
      + 'under them do not.',
  },
  {
    value: 'symbol',
    reason:
      'Refused, identically at all twelve doors: "Cannot convert a JavaScript '
      + 'Symbol to a Lua value". A Symbol has no Lua counterpart and refusing is '
      + 'the correct outcome.',
  },
  {
    value: 'obj:deep',
    reason:
      'Refused at kMaxDepth (100), identically at all twelve doors. The limit is '
      + 'documented in CLAUDE.md and the message names the real cause.',
  },
  {
    value: 'int:2^53',
    reason:
      'Comes back as a BigInt rather than a number. This is the documented '
      + 'threshold — the binding emits a BigInt beyond +-(2^53 - 1) so a 64-bit Lua '
      + 'integer survives — and 2^53 is the first value past it. The *type* changes '
      + 'across the round trip while the value does not, which is the intended '
      + 'trade; noted as a nit rather than accepted silently.',
  },
];

// `modes` (CR-23 F4) is an allowlist of mode ids. An entry without one applies
// to every mode, which is the right default: most documented losses are
// properties of the conversion itself and do not depend on which options are on.
// An entry that names modes is saying the loss exists *only* there — and if it
// stops happening in a mode it claims, that cell is reported STALE rather than
// quietly excused, exactly as before.
function matches(e, valueId, doorId, modeId) {
  if (e.door && e.door !== doorId) return false;
  if (e.modes && modeId && !e.modes.includes(modeId)) return false;
  if (e.value === valueId) return true;
  return Boolean(e.valuePattern && new RegExp(e.valuePattern).test(valueId));
}

export function expectedNote(valueId, doorId, modeId) {
  for (const e of EXPECTED) {
    // A `roundTripsInstead` entry documents the *absence* of a loss, so it must
    // not excuse one. Leaving it out here is what makes it an assertion rather
    // than a licence: if the value stops round-tripping, no entry matches and
    // the cell is reported UNDOCUMENTED, which is the correct alarm.
    if (e.roundTripsInstead) continue;
    if (matches(e, valueId, doorId, modeId)) return e.reason;
  }
  return null;
}

// Entries that assert a value *does* round trip in a mode, against a broader
// entry that says it does not (CR-23 F4). Checked positively by the runner: a
// cell covered by one of these and not identical is a finding.
export function assertsRoundTrip(valueId, doorId, modeId) {
  for (const e of EXPECTED) {
    if (!e.roundTripsInstead) continue;
    if (matches(e, valueId, doorId, modeId)) return e.reason;
  }
  return null;
}
