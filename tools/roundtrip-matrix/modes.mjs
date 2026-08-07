// CR-23 F4, Axis C: the context *modes* a value can cross under.
//
// **Why this axis exists.** The matrix ran every cell under `libraries: 'all'`
// and nothing else, because when it was built there was nothing else to run
// under. Three options have since been added that re-rule this exact boundary —
// `binaryStrings` changes what a Lua string becomes on the way out,
// `strictConversion` changes which conversions are performed at all — and
// `CORRECTNESS.md` §15.6's trigger table had no row that fired for either.
// The result was a boundary with a generated search covering one of its four
// modes, and a claim in `LIMITATIONS.md` §5 that strict mode is "refused
// uniformly at all eighteen entry points, checked against
// tools/roundtrip-matrix/doors.mjs" — describing a check that did not exist.
// This is that check.
//
// **The property each mode is held to is the same one the matrix always tested,
// which is the point.** Round trip: what comes back equals what went in, except
// where the ledger says otherwise. Parity: all eighteen doors agree. A mode that
// honours an option at `set_global` but not at a Lua function argument breaks
// parity and is reported, which is precisely the failure §5's sentence claims
// cannot happen.
//
// **Every mode carries a vacuity control**, for the reason §15.6 gives for
// doors: a mode whose option were silently ignored would behave exactly like
// `default`, agree with every door, round-trip everything, and report clean —
// a whole column of false confidence. `proves` must demonstrate the option is
// actually in effect before the mode's cells are believed. This is the same
// discipline as the per-cell vacuity check, one axis up.

export const MODES = [
  {
    id: 'default',
    options: {},
    describe: 'the shipped defaults; every other mode is read against this one',
    // The baseline needs no vacuity control: it *is* the behaviour the other
    // modes are compared to, and it has been the matrix's only mode since CR-20.
    proves: null,
  },
  {
    id: 'strict',
    options: { strictConversion: true },
    describe: 'strictConversion: refuse the silent conversion losses (LIMITATIONS §5)',
    proves: {
      describe: 'a null inside an array is refused rather than truncating the sequence',
      run: (lua) => {
        try {
          lua.set_global('__vacuity', [1, null, 3]);
          return false;  // performed the loss: the option is not in effect
        } catch (e) {
          return /strict conversion/.test(e.message);
        }
      },
    },
  },
  {
    id: 'binary',
    options: { binaryStrings: true },
    describe: 'binaryStrings: every Lua string comes back as its exact bytes (LIMITATIONS §2)',
    proves: {
      describe: 'a Lua string arrives as a Uint8Array rather than text',
      run: (lua) => lua.execute_script('return "x"') instanceof Uint8Array,
    },
  },
  {
    id: 'strict+binary',
    options: { strictConversion: true, binaryStrings: true },
    // The combination is a mode in its own right and not a formality: it is the
    // only configuration in which no silent loss remains in either direction,
    // which is a claim worth having a column for. It is also where the two
    // options could interact — strict inspects key bytes, binary changes what
    // value bytes become — and an interaction is invisible from either column
    // alone.
    describe: 'both options: the configuration with no silent loss left in either direction',
    proves: {
      describe: 'both options are in effect at once',
      run: (lua) => {
        if (!(lua.execute_script('return "x"') instanceof Uint8Array)) return false;
        try {
          lua.set_global('__vacuity', [1, null, 3]);
          return false;
        } catch (e) {
          return /strict conversion/.test(e.message);
        }
      },
    },
  },
  // T1, August 7, 2026. A conversion option, so a mode here rather than a
  // capability-matrix config — the split W1 had to draw.
  {
    id: 'map',
    options: { tableAs: 'map' },
    describe: "tableAs: 'map': every Lua table crosses as a Map with its real keys "
      + '(LIMITATIONS §5, three of the four Lua→JS key losses)',
    proves: {
      // The knob rule, and this mode needs it more than most: a disconnected
      // `tableAs` would hand back plain objects that round-trip everything the
      // default mode round-trips, agree at every door, and report a clean
      // column having searched nothing (CR-23 F4). So the control asserts the
      // *representation*, and asserts the thing only this mode can do:
      // a number key and a string key with the same text staying distinct.
      describe: 'a table arrives as a Map, and 1 and "1" survive as separate keys',
      run: (lua) => {
        const t = lua.execute_script('return {[1]="int", ["1"]="str"}');
        if (!(t instanceof Map)) return false;
        return t.size === 2 && t.get(1) === 'int' && t.get('1') === 'str';
      },
    },
  },
];
