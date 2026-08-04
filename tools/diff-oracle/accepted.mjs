// Divergences between lua-native and reference Lua that are the binding's
// design rather than defects.
//
// Same terms as `tools/exception-matrix/expected.mjs`: every entry carries the reason it is
// not a defect, and an entry whose case *starts* agreeing is reported as
// STALE rather than silently ignored — a ledger that can only ever suppress
// hides regressions in the other direction too.
//
// Three of these are silent data loss. They are ledgered because they are
// consequences of the JavaScript type system rather than mistakes in the code,
// and changing them is an API decision, not a bug fix. They are *not* ledgered
// quietly: each is now documented on the public API surface (`types.d.ts`) and
// pinned in the suite, which is what the oracle was built to make possible —
// before it, nothing in the project recorded that they happen.

export const ACCEPTED_DIVERGENCES = [
  {
    // O1. The big one.
    // Enumerated rather than matched by prefix, and the stale check is why: a
    // `^string/s10/` pattern also covered the cases that return a *length*, a
    // *byte value* or nil — which carry none of the bytes and so agree — and the
    // ledger reported six entries suppressing nothing. Only the cases whose
    // result actually carries the invalid bytes belong here.
    ids: [
      'string/s10/c1', 'string/s10/c2', 'string/s10/c3', 'string/s10/c6',
      'string/s10/c7', 'string/s10/c8', 'string/s10/c9', 'string/s10/c10',
      'string/s10/c11', 'string/s10/c12', 'string/s10/c13',
      'string/identity:s10', 'string/concat:s10',
      'string/s9/c3',              // string.reverse of valid UTF-8 is not valid UTF-8
      'crossing/v27:"\\xFF"',
    ],
    mode: 'b',
    reason:
      'Lua strings are byte strings; JavaScript strings are sequences of UTF-16 '
      + 'code units. A Lua string that is not valid UTF-8 cannot cross unchanged, '
      + 'and every invalid byte becomes U+FFFD. This is lossy and not idempotent: '
      + '"\\x00\\x01\\xFE\\xFF" is 4 bytes in Lua and comes back from a JS round '
      + 'trip as 8, with `blob == back` false. It is data-dependent, which is what '
      + 'makes it dangerous — `string.pack("i4", 7)` is all bytes below 0x80 and '
      + 'survives, so binary handling appears to work until a byte goes high. '
      + 'Documented on execute_script in types.d.ts and pinned. '
      + 'RESOLVED as an option (August 4, 2026): `binaryStrings: true` returns '
      + 'every Lua string as a Uint8Array of its raw bytes, which carries '
      + 'binary faithfully. It stays off by default because flipping it would '
      + 'change the return type for every existing caller, and it is all-or-'
      + 'nothing per context rather than "bytes only when the decode is lossy" '
      + '— a data-dependent return type is the defect class these reviews kept '
      + 'finding. This ledger entry describes the DEFAULT path, which is '
      + 'unchanged and still lossy; see docs/LIMITATIONS.md §2.',
  },
  {
    // O2.
    id: 'table/t7/o5',
    mode: 'b',
    reason:
      'A Lua table key that is neither a string nor a number is dropped when the '
      + 'table crosses to JS: `{[true]=1, [false]=2}` arrives as `{}`. Deliberate '
      + 'in the core (ProtectedTablePairsCollect skips them so the snapshot is a '
      + 'faithful list of what will be emitted) and now documented, because it is '
      + 'silent — the entries do not become null, they do not raise, they are '
      + 'simply not there.',
  },
  {
    // O3.
    id: 'table/t10/o5',
    mode: 'b',
    reason:
      'A Lua string key and an integer key with the same text are distinct in Lua '
      + 'and collide as one JavaScript property: `{["1"]="strkey", [1]="intkey"}` '
      + 'arrives as `{"1": "strkey"}` and the integer key\'s value is gone. JS '
      + 'object keys are strings, so the collision is unavoidable; which of the '
      + 'two survives is table-order dependent. Documented and pinned.',
  },
  {
    idPattern: '^error/e1[23]$',
    mode: 'b',
    reason:
      'lua-native describes a non-string error value rather than calling tostring '
      + 'on it: `error({code=7})` reports "(error object is a table value)" where '
      + 'stock Lua reports "table: 0x...", and `error(nil)` reports "(error object '
      + 'is a nil value)" where stock Lua reports "<no error object>". Both are '
      + 'deliberate and strictly more informative than an address: an address is '
      + 'not actionable, and it differs between runs. A difference in wording, '
      + 'not in what happened. '
      + 'NOTE (CR-21 F4a): this reason used to end "the structured value is still '
      + 'reachable through the thrown JS Error", which is false for a Lua-origin '
      + 'table error — the thrown Error carries only `message` and `stack`. '
      + 'Reconstruction applies to JS-origin errors (the __jsErrorId path), not '
      + 'to a table a Lua script raised. The wording difference is still '
      + 'acceptable; the consolation offered for it was not true.',
  },
];

export function divergenceReason(id, mode) {
  for (const d of ACCEPTED_DIVERGENCES) {
    if (d.mode && d.mode !== mode) continue;
    if (d.id === id) return d.reason;
    if (d.ids && d.ids.includes(id)) return d.reason;
    if (d.idPattern && new RegExp(d.idPattern).test(id)) return d.reason;
  }
  return null;
}
