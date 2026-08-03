// The JavaScript mirror of `canonical.lua`, for mode B of the oracle.
//
// Mode A compares two Lua-side serializations, so it tests the embedded VM.
// Mode B serializes the value *after* it has crossed into JavaScript, so it
// tests the marshalling — which is where a silently wrong answer is most
// likely to live, and which has no reference implementation of its own.
//
// The two serializers must agree on the erasures listed in `canonical.lua`.
// They are mirrors on purpose and not shared code, because the whole question
// mode B asks is "did the value survive the crossing", and answering it with
// one serializer running on one side would beg it.

const MAX_SAFE = 9007199254740991n; // 2^53 - 1

function fmtNumber(v) {
  if (Number.isNaN(v)) return 'num:nan';
  if (v === Infinity) return 'num:inf';
  if (v === -Infinity) return 'num:-inf';
  if (Object.is(v, -0)) return 'num:-0';
  if (Number.isInteger(v)) return `num:${v.toFixed(0)}`;
  // %.17g on the Lua side; the JS equivalent that round-trips is toPrecision(17)
  // with the exponent form normalised.
  return `num:${normaliseG(v)}`;
}

// Renders a double the way C's %.17g does, so the two sides agree character for
// character on a value neither has rounded.
function normaliseG(v) {
  let s = v.toPrecision(17);
  if (s.includes('e')) {
    let [mant, exp] = s.split('e');
    if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    const sign = exp[0] === '-' ? '-' : '+';
    const digits = exp.replace(/^[+-]/, '').padStart(2, '0');
    return `${mant}e${sign}${digits}`;
  }
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function fmtBigInt(v) {
  if (v > MAX_SAFE || v < -MAX_SAFE) return `bigint:${v.toString()}`;
  // A BigInt inside the safe range means the addon widened something it did not
  // need to. Recorded as a number so the comparison flags it rather than
  // hiding it behind the bigint tag.
  return `num:${v.toString()}`;
}

function fmtString(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x22 || code === 0x5c || code === 0x7f) {
      out += `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else if (code > 0x7f) {
      // The Lua side escapes each *byte* above 0x7f; mirror that by encoding
      // this code point to UTF-8 bytes, so an encoding difference in the
      // crossing shows up rather than being normalised away.
      for (const b of new TextEncoder().encode(ch)) {
        out += `\\x${b.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    } else {
      out += ch;
    }
  }
  return `str:"${out}"`;
}

const keyRank = (k) => {
  if (typeof k === 'number' || typeof k === 'bigint') return 1;
  if (typeof k === 'string') return 2;
  if (typeof k === 'boolean') return 3;
  return 4;
};

function sortKeys(keys) {
  return keys.sort((a, b) => {
    const ra = keyRank(a);
    const rb = keyRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return Number(a) - Number(b);
    if (ra === 2) return a < b ? -1 : a > b ? 1 : 0;
    return String(a) < String(b) ? -1 : 1;
  });
}

export function canon(v, depth = 0, seen = new Set()) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return fmtNumber(v);
  if (typeof v === 'bigint') return fmtBigInt(v);
  if (typeof v === 'string') return fmtString(v);
  if (typeof v === 'function') return 'function';
  if (typeof v === 'symbol') return 'symbol';
  if (typeof v !== 'object') return typeof v;

  if (seen.has(v)) return 'cycle';
  if (depth > 12) return 'deep';
  seen.add(v);
  let out;
  if (Array.isArray(v)) {
    // A Lua sequence arrives as a JS array; its keys were 1..n.
    const parts = v.map((el, i) => `num:${i + 1}=${canon(el, depth + 1, seen)}`);
    out = `{${parts.join(',')}}`;
  } else {
    // A Lua table arrives as a plain object with string keys — including keys
    // that were Lua *numbers*, which stringify on the way. Recovering the
    // number is not guesswork here: the reference side only ever produced
    // numeric keys for the integer part, and a key that round-trips through
    // Number() unchanged was one.
    const keys = sortKeys(Object.keys(v).map((k) => {
      const n = Number(k);
      return k !== '' && Number.isFinite(n) && String(n) === k ? n : k;
    }));
    const parts = keys.map((k) => {
      const raw = v[typeof k === 'number' ? String(k) : k];
      const kk = typeof k === 'number' ? `num:${k}` : fmtString(k);
      return `${kk}=${canon(raw, depth + 1, seen)}`;
    });
    out = `{${parts.join(',')}}`;
  }
  seen.delete(v);
  return out;
}

// The mode-B counterpart of canonical.lua's `M.run`: the same three outcome
// shapes, built from what `execute_script` actually returned or threw.
export function canonOutcome(run) {
  if (run.kind === 'loaderror') return `loaderror:${fmtString(run.message)}`;
  if (run.kind === 'error') return `error:${fmtString(run.message)}`;
  const values = run.values;
  if (values === undefined) return 'ok:[]';
  if (Array.isArray(values) && run.multi) {
    return `ok:[${values.map((v) => canon(v)).join(',')}]`;
  }
  return `ok:[${canon(values)}]`;
}
