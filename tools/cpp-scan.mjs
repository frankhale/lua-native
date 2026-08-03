// Minimal C++ source scanner for the invariant checks in `invariants.mjs`.
//
// It is deliberately not a parser. It does two things the invariant checks
// need and nothing else: strip comments/strings while preserving line numbers,
// and split a .cpp file into its top-level function definitions. Both are
// robust enough for this codebase's clang-formatted style (definitions start at
// column 0) and fail loudly rather than silently when they are not.

import { readFileSync } from 'node:fs';

// Replaces every comment and string/char literal with spaces, keeping the byte
// count and every newline so line numbers survive. Comment and string contents
// are exactly what a grep for `.Get(` must not see.
export function stripComments(src) {
  return stripCommentsAndStrings(src, { keepStrings: true });
}

export function stripCommentsAndStrings(src, { keepStrings = false } = {}) {
  const out = Array.from(src);
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === '\n') break; // unterminated; don't run away
        j++;
      }
      if (!keepStrings) blank(i, j);
      i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

const NOT_A_FUNCTION = /^(namespace|struct|class|enum|union|using|typedef|template|extern|static_assert|#|\}|\/|else|return|if|for|while|switch|do|case|default|public|private|protected)\b/;

// Top-level function definitions in a .cpp file: any line at column 0 that
// opens a body. Returns { name, startLine, bodyStartLine, endLine } with
// 1-based inclusive line numbers.
export function topLevelFunctions(rawSrc) {
  const src = stripCommentsAndStrings(rawSrc);
  const lines = src.split('\n');
  const rawLines = rawSrc.split('\n');
  const fns = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^[A-Za-z_~]/.test(line)) continue;
    if (NOT_A_FUNCTION.test(line)) continue;
    if (!line.includes('(')) continue;

    // Accumulate the signature until the body's opening brace, bailing out on a
    // `;` at paren depth 0 (a declaration, not a definition).
    let depthParen = 0;
    let bodyStart = -1;
    let j = i;
    let aborted = false;
    for (; j < lines.length && j < i + 25; j++) {
      const s = lines[j];
      for (let k = 0; k < s.length; k++) {
        const ch = s[k];
        if (ch === '(') depthParen++;
        else if (ch === ')') depthParen--;
        else if (ch === ';' && depthParen <= 0) { aborted = true; break; }
        else if (ch === '{' && depthParen <= 0) { bodyStart = j; break; }
      }
      if (aborted || bodyStart >= 0) break;
    }
    if (aborted || bodyStart < 0) continue;

    // Brace-match the body.
    let depth = 0;
    let end = -1;
    let started = false;
    for (let k = bodyStart; k < lines.length; k++) {
      for (const ch of lines[k]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') {
          depth--;
          if (started && depth === 0) { end = k; break; }
        }
      }
      if (end >= 0) break;
    }
    if (end < 0) continue;

    // The declarator name: the last identifier before the argument list's `(`.
    const sigText = lines.slice(i, bodyStart + 1).join(' ');
    const parenAt = sigText.indexOf('(');
    const beforeParen = sigText.slice(0, parenAt);
    const m = beforeParen.match(/([A-Za-z_~][A-Za-z0-9_]*(?:::[A-Za-z_~][A-Za-z0-9_]*)*)\s*$/);
    const name = m ? m[1] : `<line ${i + 1}>`;

    fns.push({
      name,
      startLine: i + 1,
      bodyStartLine: bodyStart + 1,
      endLine: end + 1,
      // Body text with comments/strings stripped, for pattern matching, and the
      // raw text for reporting.
      body: lines.slice(bodyStart, end + 1).join('\n'),
      rawBody: rawLines.slice(bodyStart, end + 1).join('\n'),
    });
    i = end;
  }
  return fns;
}

// The 1-based line numbers within `fn` (absolute in the file) where `re`
// matches, searching the comment/string-stripped body.
export function matchLines(fn, re) {
  const hits = [];
  const lines = fn.body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) hits.push(fn.bodyStartLine + i);
  }
  return hits;
}

export function readSource(path) {
  return readFileSync(path, 'utf8');
}

// A per-character map over `fn.body`: 1 where that character sits lexically
// inside a `try { … }` block of this function, 0 elsewhere.
//
// Per-character rather than per-line because `try { x(); } catch (...) {}` fits
// on one line and is the shape the codebase actually uses for best-effort
// cleanup — scoring that line by its end state reports the call as unguarded,
// which is how the first version of this scan produced a false positive.
//
// Scanning left to right also makes `} catch (…) {` behave: the closing brace
// pops the try region *before* the catch block's brace opens a new, unguarded
// one. A catch body is not protected by its own try, and treating it as though
// it were is how a rethrow-from-catch gets scored as contained.
export function tryGuardMap(fn) {
  const text = fn.body;
  const map = new Uint8Array(text.length);
  const tryDepths = [];
  let depth = 0;
  let pendingTry = false;

  for (let k = 0; k < text.length; k++) {
    map[k] = tryDepths.length > 0 ? 1 : 0;
    // Both boundaries matter. Without the left one, `entry`, `retry` and
    // `try_` all open a spurious guard region — and because a spurious region
    // marks everything after it as guarded, the effect is to report the whole
    // file safe. That is how the first version of this scan passed a source
    // with the try/catch deliberately deleted.
    const leftOk = k === 0 || !/[A-Za-z0-9_]/.test(text[k - 1]);
    if (leftOk && text.startsWith('try', k) && !/[A-Za-z0-9_]/.test(text[k + 3] ?? ' ')) {
      pendingTry = true;
      continue;
    }
    const ch = text[k];
    if (ch === '{') {
      depth++;
      if (pendingTry) { tryDepths.push(depth); pendingTry = false; }
      map[k] = tryDepths.length > 0 ? 1 : 0;
    } else if (ch === '}') {
      while (tryDepths.length && tryDepths[tryDepths.length - 1] >= depth) tryDepths.pop();
      depth--;
    }
  }
  return map;
}

// Offset of the start of each 0-based line within `fn.body`.
export function lineOffsets(fn) {
  const offs = [0];
  const text = fn.body;
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') offs.push(k + 1);
  return offs;
}
