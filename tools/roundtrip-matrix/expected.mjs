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
      + 'pinned in the suite.',
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
    reason:
      'The built-in conversions are one-way by specification. `LuaInput` says so '
      + 'directly: it is wider than `LuaValue` and covers "Date, Map, Set, '
      + 'ArrayBuffer, ArrayBufferView ... none of which Lua can produce on the way '
      + 'out." A Date arrives as a number, a Set as a sequence, a Uint8Array as a '
      + 'byte string, and none comes back as itself. Stated, and stated in the '
      + 'type the caller reads.',
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

export function expectedNote(valueId, doorId) {
  for (const e of EXPECTED) {
    if (e.door && e.door !== doorId) continue;
    if (e.value === valueId) return e.reason;
    if (e.valuePattern && new RegExp(e.valuePattern).test(valueId)) return e.reason;
  }
  return null;
}
