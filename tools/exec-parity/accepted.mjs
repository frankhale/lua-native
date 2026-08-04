// Divergences between the async doors and execute_script that are the
// binding's design rather than defects.
//
// Same terms as the other ledgers (tools/README.md): every entry carries the
// reason it is not a defect, and an entry whose case *starts* agreeing is
// reported as STALE rather than silently ignored. Never ledger an undocumented
// difference — while it is unspecified, ledgering it launders a finding into a
// feature. Entries here must point at the public statement that specifies them.

export const ACCEPTED_DIVERGENCES = [
  {
    id: 'coroutine/c7',            // return tostring(coroutine.isyieldable())
    door: 'driver',
    reason:
      'execute_async is documented as "Executes a Lua script as a coroutine on '
      + 'the main thread" (types.d.ts), so inside it coroutine.isyieldable() is '
      + 'true where execute_script\'s top level says false. The difference is '
      + 'the documented execution model, observed from inside the script.',
  },
  {
    id: 'error/e13',               // error(nil)
    door: 'driver',
    reason:
      'The difference is Lua\'s, not the binding\'s, and it is upstream of any '
      + 'code here: lua_resume replaces a nil error object with the string '
      + '"<no error object>" before returning, so the driver door receives a '
      + 'string where the pcall doors receive nil and describe it as "(error '
      + 'object is a nil value)". Demonstrable from inside Lua with no '
      + 'lua-native code involved — `coroutine.resume(coroutine.create('
      + 'function() error(nil) end))` yields a string — and pinned that way in '
      + 'the suite. Converging it would mean matching on liblua\'s internal '
      + 'string, which would also mistranslate a user\'s own '
      + 'error("<no error object>"). CR-21 F1 fixed the cells that *were* the '
      + 'binding\'s (table, boolean, number); this one is not one of them.',
  },
];

export function divergenceReason(id, door) {
  for (const entry of ACCEPTED_DIVERGENCES) {
    if (entry.door !== door) continue;
    if (entry.id !== undefined && entry.id === id) return entry.reason;
    if (entry.idPattern !== undefined && new RegExp(entry.idPattern).test(id)) {
      return entry.reason;
    }
  }
  return null;
}
