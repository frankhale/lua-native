import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import lua_native from '../../index.js';

/** This spec is an ES module: derive paths from import.meta.url, never CJS
 *  __dirname, and never URL.pathname (which yields "/C:/..." on Windows). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load all standard libraries (opt-in since bare state is the default) */
const ALL_LIBS = { libraries: 'all' as const };

/**
 * Process-global leak guard (NEXT-STEPS A2).
 *
 * A test that patches shared state and forgets to restore it corrupts every
 * test after it, and in a single-file suite this size that is the whole run.
 * It has happened: CR-15 F5 patched `Symbol.hasInstance` on the `SharedTable`
 * constructor and never restored it, so `AsSharedTable`'s filter accepted every
 * object for the remainder of the run. It stayed latent for **five passes**
 * because that test happened to be the last one to construct a shared context —
 * the leak was real from the moment it landed and simply had nothing after it
 * to break.
 *
 * CR-20 restored it in a `finally`. This asserts the restoration rather than
 * trusting it, and — the point of a suite-level check — it also covers the
 * *next* test to try the same trick, which is the one nobody has written yet.
 *
 * The constructor is reachable exactly the way user code reaches it, which is
 * the same route CR-15 F5 used to defeat the filter in the first place.
 */
const SHARED_TABLE_CTOR = Object.getPrototypeOf(
  (lua_native as any).createSharedTable({}),
).constructor;

afterEach(() => {
  expect(
    Object.getOwnPropertyDescriptor(SHARED_TABLE_CTOR, Symbol.hasInstance),
    'a test patched Symbol.hasInstance on the SharedTable constructor and did not '
    + 'restore it — this is process-global and silently corrupts every later test '
    + '(CR-15 F5 / CR-20 F5). Restore it in a `finally`.',
  ).toBeUndefined();
});

describe('lua-native Node adapter', () => {
  // ============================================
  // BASIC FUNCTIONALITY
  // ============================================
  describe('basic functionality', () => {
    it('creates a Lua context with no arguments (bare state)', () => {
      const lua = new lua_native.init();
      const result = lua.execute_script('return 1 + 2');
      expect(result).toBe(3);
    });

    it('creates a Lua context with options only (no callbacks)', () => {
      const lua = new lua_native.init(undefined, ALL_LIBS);
      const result = lua.execute_script('return math.floor(3.7)');
      expect(result).toBe(3);
    });

    it('creates a Lua context and returns a number', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_script('return 42');
      expect(result).toBe(42);
    });

    it('calls a JS function from Lua', () => {
      const lua = new lua_native.init({
        add: (...args) => {
          if (typeof args[0] === 'number' && typeof args[1] === 'number') {
            return args[0] + args[1];
          }
          throw new Error('add expects two numbers');
        }
      }, ALL_LIBS);
      const result = lua.execute_script('return add(2, 3)');
      expect(result).toBe(5);
    });

    it('modify JS variable from Lua', () => {
      let b = 42;
      const lua = new lua_native.init({
        setVar: (...args) => {
          if (typeof args[0] === 'number') {
            b = args[0];
          } else {
            throw new Error('setVar expects a number');
          }
        }
      }, ALL_LIBS);
      lua.execute_script('setVar(1999)');
      expect(b).toBe(1999);
    });

    it('sets globals and uses them in Lua', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('x', 7);
      lua.set_global('times2', (...args) => {
        if (typeof args[0] === 'number') {
          return args[0] * 2;
        }
        throw new Error('times2 expects a number');
      });
      lua.set_global('table', { a: 1, b: 42, c: "Hello,World!" })
      const result = lua.execute_script('return x, times2(x), table.b, table.c');
      if (!Array.isArray(result)) {
        throw new Error('Expected result to be an array');
      }
      const [a, b, c, d] = result;
      expect(a).toBe(7);
      expect(b).toBe(14);
      expect(c).toBe(42);
      expect(d).toBe("Hello,World!");
    });

    it('returns nested table structures to JS', () => {
      const lua = new lua_native.init({
        greet: (...args) => {
          if (typeof args[0] === 'string') {
            return `Hello, ${args[0]}!`;
          }
          throw new Error('greet expects a string');
        }
      }, ALL_LIBS);
      const result = lua.execute_script(`
        local t = {
          numbers = {1, 2, 3},
          flags = { on = true, off = false },
          msg = greet('World')
        }
        return t
      `);
      expect(result).toBeTypeOf('object');
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('Expected result to be a table object');
      }
      expect(result.msg).toBe('Hello, World!');
      const flags = result.flags;
      if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) {
        throw new Error('Expected flags to be a table object');
      }
      expect(flags.on).toBe(true);
      expect(flags.off).toBe(false);
      expect(Array.isArray(result.numbers)).toBe(true);
      expect(result.numbers).toEqual([1, 2, 3]);
    });

    it('returns multiple values from script', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_script('return 1, "hello", true');
      if (!Array.isArray(result)) {
        throw new Error('Expected result to be an array');
      }
      const [a, b, c] = result;
      expect(a).toBe(1);
      expect(b).toBe("hello");
      expect(c).toBe(true);
    });

    it('returns undefined when script returns nothing', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_script('local x = 1');
      expect(result).toBeUndefined();
    });
  });

  // ============================================
  // DATA TYPE EDGE CASES
  // ============================================
  describe('data type edge cases', () => {
    describe('strings', () => {
      it('handles empty string', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const result = lua.execute_script('return ""');
        expect(result).toBe('');
      });

      it('handles very long strings', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const longStr = 'a'.repeat(10000);
        lua.set_global('longStr', longStr);
        const result = lua.execute_script('return longStr');
        expect(result).toBe(longStr);
        if (typeof result !== 'string') {
          throw new Error('Expected result to be a string');
        }
        expect(result.length).toBe(10000);
      });

      it('handles unicode characters', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const unicode = '你好世界 🌍 émojis';
        lua.set_global('unicode', unicode);
        const result = lua.execute_script('return unicode');
        expect(result).toBe(unicode);
      });

      it('handles strings with special characters', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const special = 'line1\nline2\ttab\\backslash"quote';
        lua.set_global('special', special);
        const result = lua.execute_script('return special');
        expect(result).toBe(special);
      });

      it('handles null bytes in strings', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const result = lua.execute_script('return "hello\\0world"');
        expect(result).toBe('hello\0world');
      });
    });

    describe('numbers', () => {
      it('handles zero', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('return 0')).toBe(0);
      });

      it('handles negative numbers', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('return -42')).toBe(-42);
        expect(lua.execute_script('return -3.14')).toBeCloseTo(-3.14);
      });

      it('handles large integers', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const big = lua.execute_script('return 9007199254740991');  // MAX_SAFE_INTEGER
        expect(big).toBe(9007199254740991);
      });

      it('handles floating point numbers', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('return 3.14159265359')).toBeCloseTo(3.14159265359);
        expect(lua.execute_script('return 0.1 + 0.2')).toBeCloseTo(0.3);
      });

      it('handles very small numbers', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const tiny = lua.execute_script('return 0.0000000001');
        expect(tiny).toBeCloseTo(0.0000000001);
      });

      it('handles infinity', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const inf = lua.execute_script('return math.huge');
        expect(inf).toBe(Infinity);
      });

      it('handles negative infinity', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const negInf = lua.execute_script('return -math.huge');
        expect(negInf).toBe(-Infinity);
      });
    });

    describe('booleans', () => {
      it('handles true', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('return true')).toBe(true);
      });

      it('handles false', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('return false')).toBe(false);
      });

      it('handles boolean from comparison', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('return 1 > 0')).toBe(true);
        expect(lua.execute_script('return 1 < 0')).toBe(false);
      });
    });

    describe('nil/null', () => {
      it('handles nil return', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const result = lua.execute_script('return nil');
        expect(result).toBeNull();
      });

      it('handles nil in callback argument', () => {
        const lua = new lua_native.init({
          checkNil: (...args) => args[0] === null
        }, ALL_LIBS);
        const result = lua.execute_script('return checkNil(nil)');
        expect(result).toBe(true);
      });

      it('passes null from JS to Lua as nil', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('nullVal', null);
        const result = lua.execute_script('return nullVal == nil');
        expect(result).toBe(true);
      });
    });

    describe('arrays', () => {
      it('handles empty array', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('arr', []);
        const result = lua.execute_script('return #arr');
        expect(result).toBe(0);
      });

      it('handles array with single element', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const result = lua.execute_script('return {42}');
        expect(result).toEqual([42]);
      });

      it('handles large arrays', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const arr = Array.from({ length: 1000 }, (_, i) => i);
        lua.set_global('arr', arr);
        const result = lua.execute_script('return arr');
        expect(result).toEqual(arr);
      });

      it('handles nested arrays', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const result = lua.execute_script('return {{1, 2}, {3, 4}, {5, 6}}');
        expect(result).toEqual([[1, 2], [3, 4], [5, 6]]);
      });

      it('handles mixed type arrays', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        // Note: Lua tables don't preserve trailing nil - {1, "two", true, nil} only has 3 elements
        const result = lua.execute_script('return {1, "two", true, nil}');
        expect(result).toEqual([1, "two", true]);
      });
    });

    describe('tables/objects', () => {
      it('handles empty table', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('obj', {});
        const result = lua.execute_script('return obj');
        // Empty Lua tables can't distinguish array vs object, defaults to array
        expect(result).toEqual([]);
      });

      it('handles deeply nested structures', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const result = lua.execute_script(`
          return {
            level1 = {
              level2 = {
                level3 = {
                  level4 = {
                    value = "deep"
                  }
                }
              }
            }
          }
        `);
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('Expected result to be a table object');
        }
        const level1 = result.level1;
        if (level1 === null || typeof level1 !== 'object' || Array.isArray(level1)) {
          throw new Error('Expected level1 to be a table object');
        }
        const level2 = level1.level2;
        if (level2 === null || typeof level2 !== 'object' || Array.isArray(level2)) {
          throw new Error('Expected level2 to be a table object');
        }
        const level3 = level2.level3;
        if (level3 === null || typeof level3 !== 'object' || Array.isArray(level3)) {
          throw new Error('Expected level3 to be a table object');
        }
        const level4 = level3.level4;
        if (level4 === null || typeof level4 !== 'object' || Array.isArray(level4)) {
          throw new Error('Expected level4 to be a table object');
        }
        if (typeof level4.value !== 'string') {
          throw new Error('Expected level4.value to be a string');
        }
        expect(level4.value).toBe("deep");
      });

      it('throws error when nesting depth exceeds limit', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => {
          lua.execute_script(`
            local function nest(n)
              if n == 0 then return {} end
              return { child = nest(n-1) }
            end
            return nest(105)
          `);
        }).toThrow(/nesting depth/);
      });

      it('throws error when JS value nesting depth exceeds limit on set_global', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        // Build a deeply nested JS object
        let obj: any = { value: 'deep' };
        for (let i = 0; i < 105; i++) {
          obj = { child: obj };
        }
        expect(() => {
          lua.set_global('deep', obj);
        }).toThrow(/nesting depth/);
      });

      it('handles table with numeric string keys', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const result = lua.execute_script('return {["1"] = "a", ["2"] = "b"}');
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('Expected result to be a table object');
        }
        expect(result["1"]).toBe("a");
        expect(result["2"]).toBe("b");
      });

      it('handles table with special key names', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const result = lua.execute_script('return {["with space"] = 1, ["with-dash"] = 2}');
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('Expected result to be a table object');
        }
        expect(result["with space"]).toBe(1);
        expect(result["with-dash"]).toBe(2);
      });
    });
  });

  // ============================================
  // ERROR HANDLING
  // ============================================
  describe('error handling', () => {
    it('propagates Lua errors as JS exceptions', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.execute_script("error('boom')")).toThrowError(/boom/);
    });

    it('handles Lua syntax errors', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.execute_script('this is not valid lua!')).toThrow(/syntax error/);
    });

    it('handles undefined variable access', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      // Accessing undefined variable returns nil in Lua, doesn't error
      const result = lua.execute_script('return undefinedVar');
      expect(result).toBeNull();
    });

    it('handles calling nil as function', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.execute_script('local x = nil; return x()')).toThrow(/attempt to call a nil value \(local 'x'\)/);
    });

    it('propagates JS callback errors, preserving the original Error', () => {
      // Error fidelity (D1): a thrown JS Error object is surfaced back to JS as
      // the same Error instance, not a wrapped string.
      const original = new Error('JS error message');
      const lua = new lua_native.init({
        failingFunc: () => { throw original; }
      }, ALL_LIBS);
      expect(() => lua.execute_script('failingFunc()')).toThrowError(/JS error message/);
      try {
        lua.execute_script('failingFunc()');
      } catch (e) {
        expect(e).toBe(original); // same instance — full fidelity
      }
    });

    it('handles type errors in Lua operations', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.execute_script('return "string" + 5')).toThrow(/attempt to add/);
    });

    it('handles errors in returned Lua functions', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const errorFunc = lua.execute_script('return function() error("func error") end');
      if (typeof errorFunc !== 'function') {
        throw new Error('Expected errorFunc to be a function');
      }
      expect(() => errorFunc()).toThrowError(/func error/);
    });

    it('handles pcall for protected calls', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_script(`
        return pcall(function() error("caught error") end)
      `);
      if (!Array.isArray(result)) {
        throw new Error('Expected result to be an array');
      }
      const [success, err] = result;
      expect(success).toBe(false);
      expect(err).toContain("caught error");
    });
  });

  // ============================================
  // LUA FUNCTION RETURNS
  // ============================================
  describe('Lua function returns', () => {
    it('returns Lua functions that can be called from JS', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const add = lua.execute_script('return function(a, b) return a + b end');
      expect(typeof add).toBe('function');
      if (typeof add !== 'function') {
        throw new Error('Expected add to be a function');
      }
      expect(add(5, 3)).toBe(8);
      expect(add(10, 20)).toBe(30);
    });

    it('Lua functions can call JS callbacks', () => {
      const lua = new lua_native.init({
        jsDouble: (...args) => {
          if (typeof args[0] === 'number') {
            return args[0] * 2;
          }
          throw new Error('jsDouble expects a number');
        }
      }, ALL_LIBS);
      const luaFunc = lua.execute_script(`
        return function(n)
          return jsDouble(n) + 10
        end
      `);
      expect(typeof luaFunc).toBe('function');
      if (typeof luaFunc !== 'function') {
        throw new Error('Expected luaFunc to be a function');
      }
      expect(luaFunc(5)).toBe(20);
    });

    it('Lua functions can return multiple values', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const multiReturn = lua.execute_script(`
        return function(a, b)
          return a + b, a - b, a * b
        end
      `);
      expect(typeof multiReturn).toBe('function');
      if (typeof multiReturn !== 'function') {
        throw new Error('Expected multiReturn to be a function');
      }
      const results = multiReturn(10, 3);
      expect(results).toEqual([13, 7, 30]);
    });

    it('supports closures and nested function returns', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const makeCounter = lua.execute_script(`
        return function(start)
          local count = start or 0
          return function()
            count = count + 1
            return count
          end
        end
      `);
      expect(typeof makeCounter).toBe('function');
      if (typeof makeCounter !== 'function') {
        throw new Error('Expected makeCounter to be a function');
      }
      const counter = makeCounter(10);
      expect(typeof counter).toBe('function');
      if (typeof counter !== 'function') {
        throw new Error('Expected counter to be a function');
      }
      expect(counter()).toBe(11);
      expect(counter()).toBe(12);
      expect(counter()).toBe(13);
    });

    it('handles function with no arguments', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const getFortyTwo = lua.execute_script('return function() return 42 end');
      if (typeof getFortyTwo !== 'function') {
        throw new Error('Expected getFortyTwo to be a function');
      }
      expect(getFortyTwo()).toBe(42);
    });

    it('handles function with many arguments', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const sum = lua.execute_script(`
        return function(a, b, c, d, e, f, g, h, i, j)
          return a + b + c + d + e + f + g + h + i + j
        end
      `);
      if (typeof sum !== 'function') {
        throw new Error('Expected sum to be a function');
      }
      expect(sum(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)).toBe(55);
    });

    it('handles function returning nil', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const returnNil = lua.execute_script('return function() return nil end');
      if (typeof returnNil !== 'function') {
        throw new Error('Expected returnNil to be a function');
      }
      expect(returnNil()).toBeNull();
    });

    it('handles function with no return value', () => {
      let sideEffect = 0;
      const lua = new lua_native.init({
        setSideEffect: (...args) => {
          if (typeof args[0] === 'number') {
            sideEffect = args[0];
          } else {
            throw new Error('setSideEffect expects a number');
          }
        }
      }, ALL_LIBS);
      const noReturn = lua.execute_script(`
        return function(val)
          setSideEffect(val)
        end
      `);
      if (typeof noReturn !== 'function') {
        throw new Error('Expected noReturn to be a function');
      }
      const result = noReturn(42);
      expect(result).toBeUndefined();
      expect(sideEffect).toBe(42);
    });

    it('can call same function multiple times', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const double = lua.execute_script('return function(x) return x * 2 end');
      for (let i = 0; i < 100; i++) {
        if (typeof double !== 'function') {
          throw new Error('Expected double to be a function');
        }
        expect(double(i)).toBe(i * 2);
      }
    });

    it('multiple functions can coexist', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_script(`
        return
          function(a, b) return a + b end,
          function(a, b) return a - b end,
          function(a, b) return a * b end
      `);
      if (!Array.isArray(result)) {
        throw new Error('Expected result to be an array');
      }
      const [add, sub, mul] = result;
      if (typeof add !== 'function' || typeof sub !== 'function' || typeof mul !== 'function') {
        throw new Error('Expected all functions to be callable');
      }
      expect(add(10, 5)).toBe(15);
      expect(sub(10, 5)).toBe(5);
      expect(mul(10, 5)).toBe(50);
    });
  });

  // ============================================
  // GLOBAL VARIABLES
  // ============================================
  describe('global variables', () => {
    it('can overwrite existing globals', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('x', 10);
      expect(lua.execute_script('return x')).toBe(10);
      lua.set_global('x', 20);
      expect(lua.execute_script('return x')).toBe(20);
    });

    it('can set null as global value', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('x', 10);
      lua.set_global('x', null);
      const result = lua.execute_script('return x == nil');
      expect(result).toBe(true);
    });

    it('handles setting function as global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('greet', (...args) => {
        if (typeof args[0] === 'string') {
          return `Hello, ${args[0]}!`;
        }
        throw new Error('greet expects a string');
      });
      const result = lua.execute_script('return greet("World")');
      expect(result).toBe('Hello, World!');
    });

    it('handles setting complex object as global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('config', {
        debug: true,
        settings: {
          timeout: 1000,
          retries: 3
        },
        tags: ['a', 'b', 'c']
      });
      expect(lua.execute_script('return config.debug')).toBe(true);
      expect(lua.execute_script('return config.settings.timeout')).toBe(1000);
      expect(lua.execute_script('return config.tags[2]')).toBe('b');
    });

    it('globals persist across multiple execute_script calls', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('globalVar = 100');
      const result = lua.execute_script('return globalVar');
      expect(result).toBe(100);
    });

    it('handles many globals', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      for (let i = 0; i < 100; i++) {
        lua.set_global(`var${i}`, i);
      }
      for (let i = 0; i < 100; i++) {
        expect(lua.execute_script(`return var${i}`)).toBe(i);
      }
    });
  });

  // ============================================
  // LUA STANDARD LIBRARY
  // ============================================
  describe('Lua standard library', () => {
    it('string library is available', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(lua.execute_script('return string.upper("hello")')).toBe('HELLO');
      expect(lua.execute_script('return string.len("hello")')).toBe(5);
      expect(lua.execute_script('return string.sub("hello", 2, 4)')).toBe('ell');
    });

    it('table library is available', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_script(`
        local t = {3, 1, 4, 1, 5}
        table.sort(t)
        return t
      `);
      expect(result).toEqual([1, 1, 3, 4, 5]);
    });

    it('math library is available', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(lua.execute_script('return math.abs(-5)')).toBe(5);
      expect(lua.execute_script('return math.floor(3.7)')).toBe(3);
      expect(lua.execute_script('return math.ceil(3.2)')).toBe(4);
      expect(lua.execute_script('return math.max(1, 5, 3)')).toBe(5);
      expect(lua.execute_script('return math.min(1, 5, 3)')).toBe(1);
    });

    it('os.time is available', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const luaTime = lua.execute_script('return os.time()');
      const jsTime = Math.floor(Date.now() / 1000);
      if (typeof luaTime !== 'number') {
        throw new Error('Expected luaTime to be a number');
      }
      expect(Math.abs(luaTime - jsTime)).toBeLessThan(2);
    });

    it('pairs iteration works', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_script(`
        local t = {a = 1, b = 2, c = 3}
        local sum = 0
        for k, v in pairs(t) do
          sum = sum + v
        end
        return sum
      `);
      expect(result).toBe(6);
    });

    it('ipairs iteration works', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_script(`
        local t = {10, 20, 30}
        local sum = 0
        for i, v in ipairs(t) do
          sum = sum + v
        end
        return sum
      `);
      expect(result).toBe(60);
    });
  });

  // ============================================
  // STRESS TESTS
  // ============================================
  describe('stress tests', () => {
    it('handles many script executions', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      for (let i = 0; i < 1000; i++) {
        const result = lua.execute_script(`return ${i} * 2`);
        expect(result).toBe(i * 2);
      }
    });

    it('handles creating many contexts', () => {
      const contexts = [];
      for (let i = 0; i < 50; i++) {
        const lua = new lua_native.init({ index: i });
        contexts.push(lua);
      }
      for (let i = 0; i < 50; i++) {
        expect(contexts[i].execute_script('return index')).toBe(i);
      }
    });

    it('handles large data transfer from Lua', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_script(`
        local t = {}
        for i = 1, 1000 do
          t[i] = {index = i, value = i * 2}
        end
        return t
      `);
      if (!Array.isArray(result)) {
        throw new Error('Expected result to be an array');
      }
      expect(result.length).toBe(1000);
      const first = result[0];
      if (first === null || typeof first !== 'object' || Array.isArray(first)) {
        throw new Error('Expected first element to be a table object');
      }
      if (typeof first.index !== 'number') {
        throw new Error('Expected first.index to be a number');
      }
      expect(first.index).toBe(1);
      const last = result[999];
      if (last === null || typeof last !== 'object' || Array.isArray(last)) {
        throw new Error('Expected last element to be a table object');
      }
      if (typeof last.value !== 'number') {
        throw new Error('Expected last.value to be a number');
      }
      expect(last.value).toBe(2000);
    });

    it('handles large data transfer to Lua', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({ index: i, value: i * 2 }));
      lua.set_global('data', largeArray);
      expect(lua.execute_script('return #data')).toBe(1000);
      expect(lua.execute_script('return data[500].index')).toBe(499);  // Lua 1-indexed
    });

    it('handles recursive function calls', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const factorial = lua.execute_script(`
        local function fact(n)
          if n <= 1 then return 1 end
          return n * fact(n - 1)
        end
        return fact
      `);
      if (typeof factorial !== 'function') {
        throw new Error('Expected factorial to be a function');
      }
      expect(factorial(10)).toBe(3628800);
    });
  });

  // ============================================
  // CALLBACK EDGE CASES
  // ============================================
  describe('callback edge cases', () => {
    it('callback can return undefined', () => {
      const lua = new lua_native.init({
        noReturn: () => { /* returns undefined */ }
      }, ALL_LIBS);
      const result = lua.execute_script('return noReturn()');
      expect(result).toBeNull();
    });

    it('callback receives correct number of arguments', () => {
      let receivedArgs: unknown[] = [];
      const lua = new lua_native.init({
        capture: (...args: unknown[]) => { receivedArgs = args; }
      }, ALL_LIBS);
      lua.execute_script('capture(1, 2, 3)');
      expect(receivedArgs).toEqual([1, 2, 3]);
    });

    it('callback receives correct types', () => {
      let receivedTypes: string[] = [];
      const lua = new lua_native.init({
        captureTypes: (...args: unknown[]) => {
          receivedTypes = args.map(a => a === null ? 'null' : typeof a);
        }
      }, ALL_LIBS);
      lua.execute_script('captureTypes(1, "str", true, nil, {})');
      expect(receivedTypes).toEqual(['number', 'string', 'boolean', 'null', 'object']);
    });

    it('callback can modify external state multiple times', () => {
      let counter = 0;
      const lua = new lua_native.init({
        increment: () => { counter++; }
      }, ALL_LIBS);
      lua.execute_script(`
        for i = 1, 100 do
          increment()
        end
      `);
      expect(counter).toBe(100);
    });

    it('callbacks with same name in different contexts are independent', () => {
      let value1 = 0, value2 = 0;
      const lua1 = new lua_native.init({
        setValue: (...args) => {
          if (typeof args[0] === 'number') {
            value1 = args[0];
          } else {
            throw new Error('setValue expects a number');
          }
        }
      }, ALL_LIBS);
      const lua2 = new lua_native.init({
        setValue: (...args) => {
          if (typeof args[0] === 'number') {
            value2 = args[0];
          } else {
            throw new Error('setValue expects a number');
          }
        }
      }, ALL_LIBS);

      lua1.execute_script('setValue(10)');
      lua2.execute_script('setValue(20)');

      expect(value1).toBe(10);
      expect(value2).toBe(20);
    });
  });

  // ============================================
  // COROUTINES
  // ============================================
  describe('coroutines', () => {
    it('creates a coroutine from a function', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function()
          return 42
        end
      `);
      expect(coro).toBeDefined();
      expect(coro.status).toBe('suspended');
    });

    it('resumes a coroutine and gets return value', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function()
          return 42
        end
      `);
      const result = lua.resume(coro);
      expect(result.status).toBe('dead');
      expect(result.values).toEqual([42]);
    });

    it('passes arguments on first resume', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function(x, y)
          return x + y
        end
      `);
      const result = lua.resume(coro, 10, 20);
      expect(result.status).toBe('dead');
      expect(result.values).toEqual([30]);
    });

    it('handles yield and resume cycle', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function(x)
          coroutine.yield(x * 2)
          coroutine.yield(x * 3)
          return x * 4
        end
      `);

      let result = lua.resume(coro, 10);
      expect(result.status).toBe('suspended');
      expect(result.values).toEqual([20]);

      result = lua.resume(coro);
      expect(result.status).toBe('suspended');
      expect(result.values).toEqual([30]);

      result = lua.resume(coro);
      expect(result.status).toBe('dead');
      expect(result.values).toEqual([40]);
    });

    it('passes values through yield', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function()
          local a = coroutine.yield("first")
          local b = coroutine.yield("second")
          return a + b
        end
      `);

      let result = lua.resume(coro);
      expect(result.values).toEqual(["first"]);

      result = lua.resume(coro, 10);
      expect(result.values).toEqual(["second"]);

      result = lua.resume(coro, 20);
      expect(result.status).toBe('dead');
      expect(result.values).toEqual([30]);
    });

    it('handles multiple yield values', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function()
          coroutine.yield(1, 2, 3)
          return 4, 5
        end
      `);

      let result = lua.resume(coro);
      expect(result.status).toBe('suspended');
      expect(result.values).toEqual([1, 2, 3]);

      result = lua.resume(coro);
      expect(result.status).toBe('dead');
      expect(result.values).toEqual([4, 5]);
    });

    it('coroutine status updates correctly', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function()
          coroutine.yield()
          return "done"
        end
      `);

      expect(coro.status).toBe('suspended');

      lua.resume(coro);
      expect(coro.status).toBe('suspended');

      lua.resume(coro);
      expect(coro.status).toBe('dead');
    });

    it('handles errors in coroutine', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function()
          error("coroutine error")
        end
      `);

      const result = lua.resume(coro);
      expect(result.status).toBe('dead');
      expect(result.error).toContain('coroutine error');
    });

    it('cannot resume dead coroutine', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function()
          return 1
        end
      `);

      lua.resume(coro);
      expect(coro.status).toBe('dead');

      const result = lua.resume(coro);
      expect(result.status).toBe('dead');
      expect(result.error).toBeDefined();
    });

    it('coroutine can call JS callbacks', () => {
      let callCount = 0;
      const lua = new lua_native.init({
        increment: () => { callCount++; return callCount; }
      }, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function()
          local a = increment()
          coroutine.yield(a)
          local b = increment()
          return b
        end
      `);

      let result = lua.resume(coro);
      expect(result.values).toEqual([1]);
      expect(callCount).toBe(1);

      result = lua.resume(coro);
      expect(result.values).toEqual([2]);
      expect(callCount).toBe(2);
    });

    it('multiple coroutines are independent', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro1 = lua.create_coroutine(`
        return function()
          coroutine.yield("a")
          return "b"
        end
      `);
      const coro2 = lua.create_coroutine(`
        return function()
          coroutine.yield("x")
          return "y"
        end
      `);

      expect(lua.resume(coro1).values).toEqual(["a"]);
      expect(lua.resume(coro2).values).toEqual(["x"]);
      expect(lua.resume(coro1).values).toEqual(["b"]);
      expect(lua.resume(coro2).values).toEqual(["y"]);
    });

    it('coroutine with closure preserves state', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function()
          local counter = 0
          while true do
            counter = counter + 1
            coroutine.yield(counter)
          end
        end
      `);

      expect(lua.resume(coro).values).toEqual([1]);
      expect(lua.resume(coro).values).toEqual([2]);
      expect(lua.resume(coro).values).toEqual([3]);
      expect(lua.resume(coro).values).toEqual([4]);
    });

    it('generator pattern with coroutine', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const coro = lua.create_coroutine(`
        return function(n)
          for i = 1, n do
            coroutine.yield(i * i)
          end
        end
      `);

      const squares: number[] = [];
      let result = lua.resume(coro, 5);
      while (result.status === 'suspended') {
        if (typeof result.values[0] === 'number') {
          squares.push(result.values[0]);
        }
        result = lua.resume(coro);
      }
      // Last value comes from final yield
      if (result.values.length > 0 && result.values[0] !== undefined) {
        if (typeof result.values[0] === 'number') {
          squares.push(result.values[0]);
        }
      }

      expect(squares).toEqual([1, 4, 9, 16, 25]);
    });

    it('throws error for invalid script', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => {
        lua.create_coroutine('invalid lua syntax @@@@');
      }).toThrow(/syntax error/);
    });

    it('throws error for non-function return', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => {
        lua.create_coroutine('return 42');
      }).toThrow(/function/);
    });
  });

  // ============================================
  // GET GLOBAL
  // ============================================
  describe('get_global', () => {
    it('gets a number global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('x', 42);
      expect(lua.get_global('x')).toBe(42);
    });

    it('gets a string global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('name', 'hello');
      expect(lua.get_global('name')).toBe('hello');
    });

    it('gets a boolean global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('flag', true);
      expect(lua.get_global('flag')).toBe(true);
    });

    it('gets a table global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('config', { a: 1, b: 'two' });
      const result = lua.get_global('config');
      expect(result).toEqual({ a: 1, b: 'two' });
    });

    it('gets a global set from Lua script', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('myVar = 999');
      expect(lua.get_global('myVar')).toBe(999);
    });

    it('returns null for non-existent global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(lua.get_global('doesNotExist')).toBeNull();
    });

    it('reflects updated global value', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('x', 10);
      expect(lua.get_global('x')).toBe(10);
      lua.set_global('x', 20);
      expect(lua.get_global('x')).toBe(20);
    });

    it('gets a global modified by Lua script', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('counter', 0);
      lua.execute_script('counter = counter + 1');
      expect(lua.get_global('counter')).toBe(1);
    });
  });

  // ============================================
  // DOTTED PATH GLOBALS
  // ============================================
  describe('dotted path globals', () => {
    describe('set_global with a dotted path', () => {
      it('creates missing intermediate tables', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('config.db.host', 'localhost');
        expect(lua.execute_script('return config.db.host')).toBe('localhost');
        expect(lua.execute_script('return type(config)')).toBe('table');
        expect(lua.execute_script('return type(config.db)')).toBe('table');
      });

      it('writes into an existing intermediate table without clobbering siblings', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('config = { db = { host = "a", port = 1 } }');
        lua.set_global('config.db.host', 'b');
        expect(lua.execute_script('return config.db.host')).toBe('b');
        expect(lua.execute_script('return config.db.port')).toBe(1); // sibling intact
      });

      it('supports a two-segment path', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('settings.debug', true);
        expect(lua.execute_script('return settings.debug')).toBe(true);
      });

      it('sets non-string leaf values (number, boolean, table, array)', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('a.n', 42);
        lua.set_global('a.flag', false);
        lua.set_global('a.nested', { x: 1 });
        lua.set_global('a.list', [10, 20, 30]);
        expect(lua.execute_script('return a.n')).toBe(42);
        expect(lua.execute_script('return a.flag')).toBe(false);
        expect(lua.execute_script('return a.nested.x')).toBe(1);
        expect(lua.execute_script('return a.list[2]')).toBe(20);
      });

      it('sets a function at a dotted path, callable from Lua', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('handlers.double', (x: number) => x * 2);
        expect(lua.execute_script('return handlers.double(21)')).toBe(42);
      });

      it('overwrites an existing leaf value', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('a.b', 1);
        lua.set_global('a.b', 2);
        expect(lua.execute_script('return a.b')).toBe(2);
      });

      it('throws when an existing intermediate is not a table', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('config', 5); // a number, not a table
        expect(() => lua.set_global('config.db.host', 'x')).toThrow(/not a table/);
      });

      it('fires __newindex on a metatabled intermediate', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script(`
          _writes = {}
          target = setmetatable({}, {
            __newindex = function(_, k, v) _writes[k] = v end
          })
        `);
        lua.set_global('target.x', 99);
        expect(lua.execute_script('return _writes.x')).toBe(99);
        expect(lua.execute_script('return rawget(target, "x")')).toBeNull();
      });
    });

    describe('get_global with a dotted path', () => {
      it('reads a nested field', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('config = { db = { host = "localhost", port = 5432 } }');
        expect(lua.get_global('config.db.host')).toBe('localhost');
        expect(lua.get_global('config.db.port')).toBe(5432);
      });

      it('round-trips with set_global', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('config.db.host', 'localhost');
        expect(lua.get_global('config.db.host')).toBe('localhost');
      });

      it('returns null when the leaf is missing', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('config = { db = {} }');
        expect(lua.get_global('config.db.host')).toBeNull();
      });

      it('returns null when an intermediate is nil (optional chaining)', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.get_global('nope.db.host')).toBeNull();
        lua.execute_script('config = {}');
        expect(lua.get_global('config.db.host')).toBeNull();
      });

      it('returns a nested table when the path points at one', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('config = { db = { host = "h", port = 1 } }');
        expect(lua.get_global('config.db')).toEqual({ host: 'h', port: 1 });
      });

      it('fires __index on a metatabled intermediate', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script(`
          config = setmetatable({}, { __index = function() return { host = "fallback" } end })
        `);
        expect(lua.get_global('config.anything.host')).toBe('fallback');
      });

      it('throws when a non-nil intermediate is not indexable', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('config = { db = 5 }'); // db is a number
        expect(() => lua.get_global('config.db.host')).toThrow(/index a number/);
      });
    });

    describe('malformed paths', () => {
      it('rejects leading, trailing, and doubled dots', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.set_global('.a', 1)).toThrow(/Invalid global path/);
        expect(() => lua.set_global('a.', 1)).toThrow(/Invalid global path/);
        expect(() => lua.set_global('a..b', 1)).toThrow(/Invalid global path/);
        expect(() => lua.get_global('.a')).toThrow(/Invalid global path/);
        expect(() => lua.get_global('a..b')).toThrow(/Invalid global path/);
      });
    });

    describe('single-key backward compatibility', () => {
      it('a name with no dot is still a single global key', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('plain', 7);
        expect(lua.get_global('plain')).toBe(7);
        expect(lua.execute_script('return plain')).toBe(7);
      });
    });
  });

  // ============================================
  // USERDATA - OPAQUE HANDLES (Phase 1)
  // ============================================
  describe('userdata - opaque handles', () => {
    it('stores a JS object as userdata and receives it back in a callback', () => {
      let received: any = null;
      const original = { data: [1, 2, 3], name: 'test' };
      const lua = new lua_native.init({
        capture: (...args: any[]) => { received = args[0]; }
      }, ALL_LIBS);
      lua.set_userdata('handle', original);
      lua.execute_script('capture(handle)');
      expect(received).toBe(original); // Same reference, not a copy
    });

    it('userdata preserves object identity', () => {
      const obj = { id: 42 };
      let received: any = null;
      const lua = new lua_native.init({
        check: (...args: any[]) => { received = args[0]; }
      }, ALL_LIBS);
      lua.set_userdata('obj', obj);
      lua.execute_script('check(obj)');
      expect(received === obj).toBe(true);
    });

    it('userdata can be passed between Lua variables', () => {
      const original = { value: 'hello' };
      let received: any = null;
      const lua = new lua_native.init({
        capture: (...args: any[]) => { received = args[0]; }
      }, ALL_LIBS);
      lua.set_userdata('handle', original);
      lua.execute_script(`
        local copy = handle
        local another = copy
        capture(another)
      `);
      expect(received).toBe(original);
    });

    it('userdata returned from execute_script maps back to original object', () => {
      const original = { x: 10, y: 20 };
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_userdata('point', original);
      const result = lua.execute_script('return point');
      expect(result).toBe(original);
    });

    it('multiple userdata handles are independent', () => {
      const obj1 = { id: 1 };
      const obj2 = { id: 2 };
      let r1: any = null, r2: any = null;
      const lua = new lua_native.init({
        capture1: (...args: any[]) => { r1 = args[0]; },
        capture2: (...args: any[]) => { r2 = args[0]; }
      }, ALL_LIBS);
      lua.set_userdata('a', obj1);
      lua.set_userdata('b', obj2);
      lua.execute_script('capture1(a); capture2(b)');
      expect(r1).toBe(obj1);
      expect(r2).toBe(obj2);
    });

    it('userdata works with class instances', () => {
      class MyClass {
        value: number;
        constructor(v: number) { this.value = v; }
        double() { return this.value * 2; }
      }
      const instance = new MyClass(21);
      let received: any = null;
      const lua = new lua_native.init({
        process: (...args: any[]) => {
          received = args[0];
          return args[0].double();
        }
      }, ALL_LIBS);
      lua.set_userdata('obj', instance);
      const result = lua.execute_script('return process(obj)');
      expect(received).toBe(instance);
      expect(result).toBe(42);
    });

    it('userdata survives multiple callback round-trips', () => {
      const original = { count: 0 };
      const lua = new lua_native.init({
        increment: (...args: any[]) => {
          args[0].count++;
        }
      }, ALL_LIBS);
      lua.set_userdata('counter', original);
      lua.execute_script(`
        increment(counter)
        increment(counter)
        increment(counter)
      `);
      expect(original.count).toBe(3);
    });

    it('userdata cleanup on GC', () => {
      const obj = { data: 'test' };
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_userdata('handle', obj, { readable: true });
      // A second reference keeps the underlying JS object reachable after the
      // first global is dropped, so the refcount (not just the global) is what
      // this exercises.
      lua.execute_script('alias = handle; handle = nil; collectgarbage()');
      expect(lua.execute_script('return handle == nil')).toBe(true);
      // The surviving alias must still resolve to the same JS object: a
      // premature release (refcount dropping to zero on the first collection)
      // would leave a dangling entry and fail this read.
      expect(lua.execute_script('return alias.data')).toBe('test');
      // Dropping the last reference and collecting must not corrupt the state.
      lua.execute_script('alias = nil; collectgarbage(); collectgarbage()');
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });
  });

  // ============================================
  // METATABLE SUPPORT
  // ============================================
  describe('metatable support', () => {
    it('__tostring metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('vec = {x = 1, y = 2}');
      lua.set_metatable('vec', {
        __tostring: () => 'custom_tostring'
      });
      const result = lua.execute_script('return tostring(vec)');
      expect(result).toBe('custom_tostring');
    });

    it('__tostring receives the table as argument', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('vec = {x = 10, y = 20}');
      lua.set_metatable('vec', {
        __tostring: (...args: any[]) => {
          const t = args[0];
          return `(${t.x}, ${t.y})`;
        }
      });
      const result = lua.execute_script('return tostring(vec)');
      expect(result).toBe('(10, 20)');
    });

    it('__add metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {value = 10}; b = {value = 20}');
      lua.set_metatable('a', {
        __add: (...args: any[]) => {
          return (args[0] as any).value + (args[1] as any).value;
        }
      });
      const result = lua.execute_script('return a + b');
      expect(result).toBe(30);
    });

    it('__sub metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {value = 30}; b = {value = 10}');
      lua.set_metatable('a', {
        __sub: (...args: any[]) => (args[0] as any).value - (args[1] as any).value
      });
      const result = lua.execute_script('return a - b');
      expect(result).toBe(20);
    });

    it('__mul metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {value = 5}; b = {value = 6}');
      lua.set_metatable('a', {
        __mul: (...args: any[]) => (args[0] as any).value * (args[1] as any).value
      });
      const result = lua.execute_script('return a * b');
      expect(result).toBe(30);
    });

    it('__div metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {value = 20}; b = {value = 4}');
      lua.set_metatable('a', {
        __div: (...args: any[]) => (args[0] as any).value / (args[1] as any).value
      });
      const result = lua.execute_script('return a / b');
      expect(result).toBe(5);
    });

    it('__unm metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {value = 42}');
      lua.set_metatable('a', {
        __unm: (...args: any[]) => -(args[0] as any).value
      });
      const result = lua.execute_script('return -a');
      expect(result).toBe(-42);
    });

    it('__mod metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {value = 17}; b = {value = 5}');
      lua.set_metatable('a', {
        __mod: (...args: any[]) => (args[0] as any).value % (args[1] as any).value
      });
      const result = lua.execute_script('return a % b');
      expect(result).toBe(2);
    });

    it('__concat metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {text = "hello"}; b = {text = " world"}');
      lua.set_metatable('a', {
        __concat: (...args: any[]) => (args[0] as any).text + (args[1] as any).text
      });
      const result = lua.execute_script('return a .. b');
      expect(result).toBe('hello world');
    });

    it('__len metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {items = 5}');
      lua.set_metatable('a', {
        __len: (...args: any[]) => (args[0] as any).items
      });
      const result = lua.execute_script('return #a');
      expect(result).toBe(5);
    });

    it('__eq metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {id = 1}; b = {id = 1}');
      // Both tables need the same metatable for __eq to fire
      const mt = {
        __eq: (...args: any[]) => (args[0] as any).id === (args[1] as any).id
      };
      lua.set_metatable('a', mt);
      lua.set_metatable('b', mt);
      const result = lua.execute_script('return a == b');
      expect(result).toBe(true);
    });

    it('__lt metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {value = 1}; b = {value = 2}');
      const mt = {
        __lt: (...args: any[]) => (args[0] as any).value < (args[1] as any).value
      };
      lua.set_metatable('a', mt);
      lua.set_metatable('b', mt);
      const result = lua.execute_script('return a < b');
      expect(result).toBe(true);
    });

    it('__le metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {value = 3}; b = {value = 3}');
      const mt = {
        __le: (...args: any[]) => (args[0] as any).value <= (args[1] as any).value
      };
      lua.set_metatable('a', mt);
      lua.set_metatable('b', mt);
      const result = lua.execute_script('return a <= b');
      expect(result).toBe(true);
    });

    it('__call metamethod', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('obj = {factor = 10}');
      lua.set_metatable('obj', {
        __call: (...args: any[]) => {
          const self = args[0] as any;
          const x = args[1] as number;
          return self.factor * x;
        }
      });
      const result = lua.execute_script('return obj(5)');
      expect(result).toBe(50);
    });

    it('__index as function', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('obj = {}');
      lua.set_metatable('obj', {
        __index: (...args: any[]) => {
          const key = args[1] as string;
          return 'default_' + key;
        }
      });
      const result = lua.execute_script('return obj.foo');
      expect(result).toBe('default_foo');
    });

    it('__index as table', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('obj = {}');
      lua.set_metatable('obj', {
        __index: { fallback_key: 99 }
      });
      const result = lua.execute_script('return obj.fallback_key');
      expect(result).toBe(99);
    });

    it('__newindex as function', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('obj = {}; intercepted = {}');
      lua.set_metatable('obj', {
        __newindex: (...args: any[]) => {
          // Store in a different table via rawset
          // args: table, key, value - we return the key/value for testing
          return null;
        }
      });
      // __newindex fires for new keys; the function intercepts assignment
      // Verify it doesn't throw and the metamethod is called
      lua.execute_script('obj.newkey = 42');
      // Since __newindex intercepts, rawget should show nil
      const result = lua.execute_script('return rawget(obj, "newkey")');
      expect(result).toBeNull();
    });

    it('multiple metamethods on one table', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {value = 10}; b = {value = 3}');
      lua.set_metatable('a', {
        __add: (...args: any[]) => (args[0] as any).value + (args[1] as any).value,
        __tostring: (...args: any[]) => 'val:' + (args[0] as any).value,
        __unm: (...args: any[]) => -(args[0] as any).value,
      });
      expect(lua.execute_script('return a + b')).toBe(13);
      expect(lua.execute_script('return tostring(a)')).toBe('val:10');
      expect(lua.execute_script('return -a')).toBe(-10);
    });

    it('error: non-existent global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => {
        lua.set_metatable('nonexistent', { __tostring: () => 'x' });
      }).toThrow(/does not exist/);
    });

    it('error: non-table global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.set_global('num', 42);
      expect(() => {
        lua.set_metatable('num', { __tostring: () => 'x' });
      }).toThrow(/not a table/);
    });

    it('metatable on Lua-created global table', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('myTable = {x = 5, y = 10}');
      lua.set_metatable('myTable', {
        __tostring: (...args: any[]) => {
          const t = args[0] as any;
          return `(${t.x}, ${t.y})`;
        }
      });
      const result = lua.execute_script('return tostring(myTable)');
      expect(result).toBe('(5, 10)');
    });
  });

  // ============================================
  // REFERENCE-BASED TABLES (Metatabled tables as Proxy)
  // ============================================
  describe('reference-based tables', () => {
    it('metatabled table returns as Proxy, not plain object', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = {x = 1, y = 2}');
      lua.set_metatable('t', {
        __tostring: () => 'custom'
      });
      const result = lua.execute_script('return t') as any;
      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();
      // Proxy allows live access to table fields
      expect(result.x).toBe(1);
      expect(result.y).toBe(2);
    });

    it('__index metamethod flows through Proxy get', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = {}');
      lua.set_metatable('t', {
        __index: (...args: any[]) => {
          return 'default_' + args[1];
        }
      });
      const result = lua.execute_script('return t') as any;
      expect(result.missingKey).toBe('default_missingKey');
    });

    it('__newindex metamethod flows through Proxy set', () => {
      let interceptedKey = '';
      let interceptedValue: any = null;
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = {}');
      lua.set_metatable('t', {
        __newindex: (...args: any[]) => {
          interceptedKey = args[1];
          interceptedValue = args[2];
        }
      });
      const result = lua.execute_script('return t') as any;
      result.newProp = 42;
      expect(interceptedKey).toBe('newProp');
      expect(interceptedValue).toBe(42);
    });

    it('direct property read and write on metatabled table', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = {x = 10}');
      lua.set_metatable('t', { __tostring: () => 'T' });
      const result = lua.execute_script('return t') as any;
      expect(result.x).toBe(10);
      result.x = 20;
      // Verify change is visible in Lua
      expect(lua.execute_script('return t.x')).toBe(20);
    });

    it('plain table still deep-copies (backward compat)', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      // Bind the table to a global so the copy semantics can actually be
      // observed from Lua after mutating the JS side.
      lua.execute_script('t = {a = 1, b = 2}');
      const result = lua.execute_script('return t') as any;
      expect(result.a).toBe(1);
      expect(result.b).toBe(2);
      // Modifying the JS copy must NOT write through to Lua (unlike the
      // metatabled case above, which returns a live proxy).
      result.a = 999;
      expect(lua.execute_script('return t.a')).toBe(1);
    });

    it('round-trip through JS callback preserves metatabled table', () => {
      let received: any = null;
      const lua = new lua_native.init({
        capture: (...args: any[]) => {
          received = args[0];
          return args[0]; // Pass it back
        }
      }, ALL_LIBS);
      lua.execute_script('t = {x = 5, y = 10}');
      lua.set_metatable('t', {
        __tostring: (...args: any[]) => {
          return `(${args[0].x}, ${args[0].y})`;
        }
      });
      // Pass table through JS and back to Lua
      const result = lua.execute_script('return capture(t)');
      expect(received).not.toBeNull();
      expect((received as any).x).toBe(5);
      // The returned value should still work with metamethods in Lua
      const str = lua.execute_script('return tostring(t)');
      expect(str).toBe('(5, 10)');
    });

    it('integer keys work through Proxy', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = {10, 20, 30}');
      lua.set_metatable('t', { __tostring: () => 'array-like' });
      const result = lua.execute_script('return t') as any;
      expect(result['1']).toBe(10);
      expect(result['2']).toBe(20);
      expect(result['3']).toBe(30);
    });

    it('Object.keys() works via ownKeys trap', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = {a = 1, b = 2, c = 3}');
      lua.set_metatable('t', { __tostring: () => 'T' });
      const result = lua.execute_script('return t') as any;
      const keys = Object.keys(result);
      expect(keys.sort()).toEqual(['a', 'b', 'c'].sort());
    });

    it('"key" in obj works via has trap', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = {x = 1}');
      lua.set_metatable('t', { __tostring: () => 'T' });
      const result = lua.execute_script('return t') as any;
      expect('x' in result).toBe(true);
      expect('nonexistent' in result).toBe(false);
    });

    it('__len via Lua works on round-tripped table', () => {
      const lua = new lua_native.init({
        getLen: (...args: any[]) => {
          return args[0]; // pass back to Lua
        }
      }, ALL_LIBS);
      lua.execute_script('t = {items = 5}');
      lua.set_metatable('t', {
        __len: (...args: any[]) => (args[0] as any).items
      });
      const result = lua.execute_script('local ref = getLen(t); return #ref');
      expect(result).toBe(5);
    });

    it('__tostring via Lua works on round-tripped table', () => {
      const lua = new lua_native.init({
        passThrough: (...args: any[]) => args[0]
      }, ALL_LIBS);
      lua.execute_script('t = {name = "hello"}');
      lua.set_metatable('t', {
        __tostring: (...args: any[]) => 'name:' + (args[0] as any).name
      });
      const result = lua.execute_script('return tostring(passThrough(t))');
      expect(result).toBe('name:hello');
    });

    it('__add via Lua works on round-tripped table', () => {
      const lua = new lua_native.init({
        passThrough: (...args: any[]) => args[0]
      }, ALL_LIBS);
      lua.execute_script('a = {value = 10}; b = {value = 20}');
      lua.set_metatable('a', {
        __add: (...args: any[]) => (args[0] as any).value + (args[1] as any).value
      });
      const result = lua.execute_script('return passThrough(a) + b');
      expect(result).toBe(30);
    });

    it('__call via Lua works on round-tripped table', () => {
      const lua = new lua_native.init({
        passThrough: (...args: any[]) => args[0]
      }, ALL_LIBS);
      lua.execute_script('obj = {factor = 10}');
      lua.set_metatable('obj', {
        __call: (...args: any[]) => {
          return (args[0] as any).factor * (args[1] as number);
        }
      });
      const result = lua.execute_script('return passThrough(obj)(5)');
      expect(result).toBe(50);
    });

    it('nested metatabled table is also a Proxy', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(`
        inner = {val = 42}
        outer = {child = inner}
      `);
      lua.set_metatable('inner', { __tostring: () => 'inner' });
      lua.set_metatable('outer', { __tostring: () => 'outer' });
      const result = lua.execute_script('return outer') as any;
      // outer is a Proxy
      expect(typeof result).toBe('object');
      // outer.child should return inner, which is also metatabled
      const child = result.child;
      // child is the inner table - since inner has a metatable, it should be a Proxy
      expect(typeof child).toBe('object');
      expect(child.val).toBe(42);
    });

    it('multiple independent Proxies', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = {x = 1}; b = {x = 2}');
      lua.set_metatable('a', { __tostring: () => 'a' });
      lua.set_metatable('b', { __tostring: () => 'b' });
      const ra = lua.execute_script('return a') as any;
      const rb = lua.execute_script('return b') as any;
      expect(ra.x).toBe(1);
      expect(rb.x).toBe(2);
      // Modifying one doesn't affect the other
      ra.x = 100;
      expect(ra.x).toBe(100);
      expect(rb.x).toBe(2);
    });

    it('not treated as thenable', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = {x = 1}');
      lua.set_metatable('t', { __tostring: () => 'T' });
      const result = lua.execute_script('return t') as any;
      // "then" should return undefined, preventing Promise-like behavior
      expect(result.then).toBeUndefined();
    });
  });

  // ============================================
  // USERDATA - LUA-CREATED PASSTHROUGH (Phase 2)
  // ============================================
  describe('userdata - Lua-created passthrough', () => {
    it('Lua-created userdata can pass through JS callbacks', () => {
      let received: any = null;
      const lua = new lua_native.init({
        passThrough: (...args: any[]) => {
          received = args[0];
          return args[0]; // Pass it back
        }
      }, ALL_LIBS);
      // io.open returns userdata (a file handle)
      const result = lua.execute_script(`
        local f = io.tmpfile()
        if f then
          local returned = passThrough(f)
          f:close()
          return true
        end
        return false
      `);
      expect(result).toBe(true);
      expect(received).toBeDefined();
      expect(received).not.toBeNull();
    });

    it('opaque userdata round-trips correctly', () => {
      const lua = new lua_native.init({
        identity: (...args: any[]) => args[0]
      }, ALL_LIBS);
      const result = lua.execute_script(`
        local f = io.tmpfile()
        if f then
          local returned = identity(f)
          -- returned should be the same file handle
          returned:write("hello")
          returned:seek("set")
          local content = returned:read("*a")
          returned:close()
          return content
        end
        return "no file"
      `);
      expect(result).toBe("hello");
    });
  });

  // ============================================
  // USERDATA - PROPERTY ACCESS (Phase 3)
  // ============================================
  describe('userdata - property access', () => {
    describe('readable', () => {
      it('reads properties from Lua', () => {
        const obj = { x: 10, y: 20, name: 'point' };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('point', obj, { readable: true });
        expect(lua.execute_script('return point.x')).toBe(10);
        expect(lua.execute_script('return point.y')).toBe(20);
        expect(lua.execute_script('return point.name')).toBe('point');
      });

      it('non-existent property returns nil', () => {
        const obj = { x: 10 };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: true });
        const result = lua.execute_script('return obj.nonexistent == nil');
        expect(result).toBe(true);
      });

      it('reads boolean properties correctly', () => {
        const obj = { active: true, deleted: false };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: true });
        expect(lua.execute_script('return obj.active')).toBe(true);
        expect(lua.execute_script('return obj.deleted')).toBe(false);
      });

      it('reads nested object properties as tables', () => {
        const obj = { nested: { a: 1, b: 2 } };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: true });
        // nested is returned as a Lua table (one level deep)
        const result = lua.execute_script('return obj.nested');
        expect(result).toEqual({ a: 1, b: 2 });
      });

      it('reads array properties', () => {
        const obj = { items: [10, 20, 30] };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: true });
        const result = lua.execute_script('return obj.items');
        expect(result).toEqual([10, 20, 30]);
      });

      it('reads null properties as nil', () => {
        const obj = { value: null };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: true });
        const result = lua.execute_script('return obj.value == nil');
        expect(result).toBe(true);
      });
    });

    describe('writable', () => {
      it('writes properties from Lua', () => {
        const obj: any = { x: 10, y: 20 };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('point', obj, { readable: true, writable: true });
        lua.execute_script('point.x = 100; point.y = 200');
        expect(obj.x).toBe(100);
        expect(obj.y).toBe(200);
      });

      it('creates new properties from Lua', () => {
        const obj: any = {};
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: true, writable: true });
        lua.execute_script('obj.newProp = 42');
        expect(obj.newProp).toBe(42);
      });

      it('writes different types', () => {
        const obj: any = {};
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: true, writable: true });
        lua.execute_script(`
          obj.num = 42
          obj.str = "hello"
          obj.bool = true
        `);
        expect(obj.num).toBe(42);
        expect(obj.str).toBe('hello');
        expect(obj.bool).toBe(true);
      });

      it('write then read reflects the change', () => {
        const obj: any = { value: 0 };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: true, writable: true });
        lua.execute_script('obj.value = 99');
        const result = lua.execute_script('return obj.value');
        expect(result).toBe(99);
        expect(obj.value).toBe(99);
      });
    });

    describe('access control', () => {
      it('read-only: writes throw a Lua error', () => {
        const obj = { x: 10 };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: true, writable: false });
        expect(() => {
          lua.execute_script('obj.x = 20');
        }).toThrow(/not writable/);
        expect(obj.x).toBe(10); // Unchanged
      });

      it('write-only: reads throw a Lua error', () => {
        const obj: any = { x: 10 };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: false, writable: true });
        expect(() => {
          lua.execute_script('return obj.x');
        }).toThrow(/not readable/);
      });

      it('write-only: writes succeed', () => {
        const obj: any = { x: 10 };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj, { readable: false, writable: true });
        lua.execute_script('obj.x = 99');
        expect(obj.x).toBe(99);
      });

      it('opaque userdata (no options) cannot be indexed', () => {
        const obj = { x: 10 };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('obj', obj);
        // Accessing properties on opaque userdata should error
        expect(() => {
          lua.execute_script('return obj.x');
        }).toThrow(/attempt to index/);
      });
    });

    describe('property access with callbacks', () => {
      it('callback receives userdata with properties still accessible', () => {
        const player = { name: 'Alice', health: 100 };
        let receivedName: any = null;
        const lua = new lua_native.init({
          getName: (...args: any[]) => {
            receivedName = args[0].name;
          }
        }, ALL_LIBS);
        lua.set_userdata('player', player, { readable: true });
        lua.execute_script('getName(player)');
        expect(receivedName).toBe('Alice');
      });

      it('mutations through userdata are visible in JS', () => {
        const state: any = { score: 0 };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('state', state, { readable: true, writable: true });
        lua.execute_script(`
          for i = 1, 10 do
            state.score = state.score + 1
          end
        `);
        expect(state.score).toBe(10);
      });

      it('multiple proxy userdata objects are independent', () => {
        const obj1: any = { value: 'a' };
        const obj2: any = { value: 'b' };
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('o1', obj1, { readable: true, writable: true });
        lua.set_userdata('o2', obj2, { readable: true, writable: true });
        lua.execute_script('o1.value = "x"; o2.value = "y"');
        expect(obj1.value).toBe('x');
        expect(obj2.value).toBe('y');
      });
    });
  });

  // ============================================
  // USERDATA - METHOD BINDING
  // ============================================
  describe('userdata - method binding', () => {
    it('calls a method with : syntax', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { value: 0 };
      lua.set_userdata('obj', obj, {
        methods: {
          set_value: (self: any, v: any) => { self.value = v; },
        }
      });
      lua.execute_script('obj:set_value(42)');
      expect(obj.value).toBe(42);
    });

    it('receives the original JS object as self', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const original = { x: 10, y: 20 };
      let receivedSelf: any = null;
      lua.set_userdata('obj', original, {
        methods: {
          check: (self: any) => { receivedSelf = self; },
        }
      });
      lua.execute_script('obj:check()');
      expect(receivedSelf).toBe(original);
    });

    it('mutates self and JS sees the change', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const player = { hp: 100, x: 0, y: 0 };
      lua.set_userdata('player', player, {
        methods: {
          move: (self: any, dx: any, dy: any) => {
            self.x += dx;
            self.y += dy;
          },
          take_damage: (self: any, amount: any) => {
            self.hp -= amount;
          },
        }
      });
      lua.execute_script(`
        player:move(10, 20)
        player:take_damage(25)
      `);
      expect(player.x).toBe(10);
      expect(player.y).toBe(20);
      expect(player.hp).toBe(75);
    });

    it('returns a value from a method', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { x: 3, y: 4 };
      lua.set_userdata('vec', obj, {
        methods: {
          length: (self: any) => Math.sqrt(self.x ** 2 + self.y ** 2),
        }
      });
      const result = lua.execute_script('return vec:length()');
      expect(result).toBe(5);
    });

    it('returns multiple values from a method', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { x: 10, y: 20 };
      lua.set_userdata('obj', obj, {
        readable: true,
        methods: {
          get_pos: (self: any) => [self.x, self.y],
        }
      });
      // The array return from JS becomes a Lua table, returned as a single value
      const result = lua.execute_script('return obj:get_pos()') as any;
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toBe(10);
      expect(result[1]).toBe(20);
    });

    it('methods and readable properties coexist', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { name: 'Alice', score: 0 };
      lua.set_userdata('obj', obj, {
        readable: true,
        writable: true,
        methods: {
          add_score: (self: any, points: any) => { self.score += points; },
          describe: (self: any) => `${self.name}: ${self.score}`,
        }
      });
      // Read a property
      const name = lua.execute_script('return obj.name');
      expect(name).toBe('Alice');
      // Call a method
      lua.execute_script('obj:add_score(100)');
      expect(obj.score).toBe(100);
      // Method that reads properties
      const desc = lua.execute_script('return obj:describe()');
      expect(desc).toBe('Alice: 100');
      // Write a property
      lua.execute_script('obj.name = "Bob"');
      expect(obj.name).toBe('Bob');
    });

    it('methods work without readable/writable', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { secret: 42 };
      lua.set_userdata('obj', obj, {
        methods: {
          get_secret: (self: any) => self.secret,
        }
      });
      // Method works
      const result = lua.execute_script('return obj:get_secret()');
      expect(result).toBe(42);
      // Property access returns nil (not readable)
      const prop = lua.execute_script('return obj.secret');
      expect(prop).toBeNull();
    });

    it('method takes precedence over property with same name', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { value: 'property' };
      lua.set_userdata('obj', obj, {
        readable: true,
        methods: {
          value: (self: any) => 'method',
        }
      });
      // Since 'value' is a method, calling it as a function should work
      const result = lua.execute_script('return obj:value()');
      expect(result).toBe('method');
    });

    it('non-existent key returns nil when readable', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { x: 1 };
      lua.set_userdata('obj', obj, {
        readable: true,
        methods: {
          foo: (self: any) => 'bar',
        }
      });
      const result = lua.execute_script('return obj.nonexistent');
      expect(result).toBeNull();
    });

    it('non-existent key returns nil when not readable', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { x: 1 };
      lua.set_userdata('obj', obj, {
        methods: {
          foo: (self: any) => 'bar',
        }
      });
      const result = lua.execute_script('return obj.nonexistent');
      expect(result).toBeNull();
    });

    it('error in method produces a Lua error', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = {};
      lua.set_userdata('obj', obj, {
        methods: {
          fail: () => { throw new Error('method failed'); },
        }
      });
      expect(() => lua.execute_script('obj:fail()')).toThrow(/method failed/);
    });

    it('multiple userdata with shared method definitions', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const a = { val: 10 };
      const b = { val: 20 };
      const methods = {
        get_val: (self: any) => self.val,
        set_val: (self: any, v: any) => { self.val = v; },
      };
      lua.set_userdata('a', a, { methods });
      lua.set_userdata('b', b, { methods });

      expect(lua.execute_script('return a:get_val()')).toBe(10);
      expect(lua.execute_script('return b:get_val()')).toBe(20);

      lua.execute_script('a:set_val(99)');
      expect(a.val).toBe(99);
      expect(b.val).toBe(20);  // b unchanged
    });

    it('method receives additional arguments correctly', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { items: [] as string[] };
      lua.set_userdata('obj', obj, {
        methods: {
          add: (self: any, item: any) => { self.items.push(item); },
          add_many: (self: any, ...args: any[]) => {
            for (const arg of args) self.items.push(arg);
          },
        }
      });
      lua.execute_script('obj:add("first")');
      lua.execute_script('obj:add_many("second", "third", "fourth")');
      expect(obj.items).toEqual(['first', 'second', 'third', 'fourth']);
    });

    it('method can return a table', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const obj = { data: { a: 1, b: 2 } };
      lua.set_userdata('obj', obj, {
        methods: {
          get_data: (self: any) => self.data,
        }
      });
      const result = lua.execute_script('return obj:get_data()') as any;
      expect(result.a).toBe(1);
      expect(result.b).toBe(2);
    });

    it('method with no return value', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      let called = false;
      const obj = {};
      lua.set_userdata('obj', obj, {
        methods: {
          ping: () => { called = true; },
        }
      });
      const result = lua.execute_script('return obj:ping()');
      expect(called).toBe(true);
      expect(result).toBeNull();
    });
  });

  // ============================================
  // FILE EXECUTION
  // ============================================
  describe('file execution', () => {
    const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));

    it('executes a Lua file that returns multiple values', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_file(fixturesDir + 'return-values.lua');
      expect(result).toEqual([42, 'hello', true]);
    });

    it('executes a Lua file that returns a table', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_file(fixturesDir + 'return-table.lua');
      expect(result).toEqual({ name: 'lua-native', version: 1 });
    });

    it('executes a Lua file that sets and returns a global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = lua.execute_file(fixturesDir + 'set-global.lua');
      expect(result).toBe('hello from file');
      expect(lua.get_global('greeting')).toBe('hello from file');
    });

    it('executes a Lua file that uses JS callbacks', () => {
      const lua = new lua_native.init({
        add: (...args: any[]) => (args[0] as number) + (args[1] as number),
      }, ALL_LIBS);
      const result = lua.execute_file(fixturesDir + 'use-callback.lua');
      expect(result).toBe(30);
    });

    it('throws on file not found', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.execute_file('/nonexistent/path/to/file.lua')).toThrow(/cannot open/);
    });

    it('throws on syntax error in file', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.execute_file(fixturesDir + 'syntax-error.lua')).toThrow(/syntax error/);
    });

    it('throws on empty file path', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.execute_file('')).toThrow('File path cannot be empty');
    });

    it('returns undefined for a file with no return value', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      // no-return.lua has side effects only; execute_file must yield undefined.
      const result = lua.execute_file(fixturesDir + 'no-return.lua');
      expect(result).toBeUndefined();
      // The side effect still happened.
      expect(lua.execute_script('return sideEffect')).toBe('ran');
    });
  });

  // ============================================
  // STANDARD LIBRARY LOADING
  // ============================================
  describe('standard library loading', () => {
    it('creates bare state by default (no options)', () => {
      const lua = new lua_native.init({});
      // Basic Lua works without any libraries
      expect(lua.execute_script('return 1 + 2')).toBe(3);
      expect(lua.execute_script('return "hello"')).toBe('hello');
      // Standard library functions are not available
      expect(() => lua.execute_script('return type(math)')).toThrow(/attempt to call a nil value \(global 'type'\)/);
      expect(() => lua.execute_script('return print("hi")')).toThrow(/attempt to call a nil value \(global 'print'\)/);
    });

    it('loads all libraries with preset "all"', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      expect(lua.execute_script('return math.floor(3.7)')).toBe(3);
      expect(lua.execute_script('return string.upper("hello")')).toBe('HELLO');
      expect(lua.execute_script('return type(io)')).toBe('table');
      expect(lua.execute_script('return type(os)')).toBe('table');
      expect(lua.execute_script('return type(debug)')).toBe('table');
    });

    it('loads safe libraries with preset "safe"', () => {
      const lua = new lua_native.init({}, { libraries: 'safe' });
      // Safe libs should be available
      expect(lua.execute_script('return math.floor(3.7)')).toBe(3);
      expect(lua.execute_script('return string.upper("hello")')).toBe('HELLO');
      expect(lua.execute_script('return type(table)')).toBe('table');
      expect(lua.execute_script('return type(coroutine)')).toBe('table');
      // Dangerous libs should NOT be available
      expect(lua.execute_script('return type(io)')).toBe('nil');
      expect(lua.execute_script('return type(os)')).toBe('nil');
      expect(lua.execute_script('return type(debug)')).toBe('nil');
    });

    it('throws on unknown preset string', () => {
      expect(() => new lua_native.init({}, { libraries: 'invalid' as any })).toThrow(
        /libraries must be 'all', 'safe', 'sandbox', or an array/
      );
    });

    it('loads only selected libraries', () => {
      const lua = new lua_native.init({}, { libraries: ['base', 'string', 'math'] });
      expect(lua.execute_script('return math.floor(3.7)')).toBe(3);
      expect(lua.execute_script('return string.upper("hello")')).toBe('HELLO');
      expect(lua.execute_script('return type(print)')).toBe('function');
    });

    it('omitted libraries are not available', () => {
      const lua = new lua_native.init({}, { libraries: ['base', 'string'] });
      expect(lua.execute_script('return type(math)')).toBe('nil');
      expect(lua.execute_script('return type(io)')).toBe('nil');
      expect(lua.execute_script('return type(os)')).toBe('nil');
      expect(lua.execute_script('return type(debug)')).toBe('nil');
    });

    it('empty libraries array creates a bare Lua state', () => {
      const lua = new lua_native.init({}, { libraries: [] });
      expect(() => lua.execute_script('return type(math)')).toThrow(/attempt to call a nil value \(global 'type'\)/);
      expect(() => lua.execute_script('return print("hi")')).toThrow(/attempt to call a nil value \(global 'print'\)/);
      expect(lua.execute_script('return 1 + 2')).toBe(3);
      expect(lua.execute_script('return "hello"')).toBe('hello');
    });

    it('throws on unknown library name', () => {
      expect(() => new lua_native.init({}, { libraries: ['nonexistent'] })).toThrow(
        "Unknown Lua library: 'nonexistent'"
      );
    });

    it('can load individual libraries', () => {
      const lua = new lua_native.init({}, { libraries: ['base', 'math'] });
      expect(lua.execute_script('return math.pi')).toBeCloseTo(3.14159, 4);
      expect(lua.execute_script('return type(string)')).toBe('nil');
    });

    it('callbacks work with selective libraries', () => {
      const lua = new lua_native.init(
        { double: (x: any) => (x as number) * 2 },
        { libraries: ['base'] }
      );
      expect(lua.execute_script('return double(21)')).toBe(42);
    });

    it('coroutine library can be loaded selectively', () => {
      const lua = new lua_native.init({}, { libraries: ['base', 'coroutine'] });
      expect(lua.execute_script('return type(coroutine)')).toBe('table');
      expect(lua.execute_script('return type(coroutine.yield)')).toBe('function');
    });

    it('table library can be loaded selectively', () => {
      const lua = new lua_native.init({}, { libraries: ['base', 'table'] });
      const result = lua.execute_script(`
        local t = {3, 1, 2}
        table.sort(t)
        return t[1], t[2], t[3]
      `);
      expect(result).toEqual([1, 2, 3]);
    });

    it('utf8 library can be loaded selectively', () => {
      const lua = new lua_native.init({}, { libraries: ['base', 'utf8'] });
      expect(lua.execute_script('return type(utf8)')).toBe('table');
    });
  });

  // ============================================
  // ASYNC EXECUTION
  // ============================================
  describe('async execution', () => {
    it('resolves with correct value', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = await lua.execute_script_async('return 6 * 7');
      expect(result).toBe(42);
    });

    it('resolves with multiple return values', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = await lua.execute_script_async("return 1, 'two', true");
      expect(result).toEqual([1, 'two', true]);
    });

    it('resolves with undefined for no return', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = await lua.execute_script_async('local x = 1');
      expect(result).toBeUndefined();
    });

    it('rejects on Lua errors', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      await expect(lua.execute_script_async("error('boom')")).rejects.toThrow('boom');
    });

    it('rejects on syntax errors', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      await expect(lua.execute_script_async('return %%%')).rejects.toThrow(/unexpected symbol/);
    });

    it('rejects when calling JS callbacks', async () => {
      const lua = new lua_native.init({
        greet: () => 'hello',
      }, ALL_LIBS);
      await expect(lua.execute_script_async('return greet()')).rejects.toThrow('async mode');
    });

    it('works with stdlib functions', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = await lua.execute_script_async("return string.upper('hello')");
      expect(result).toBe('HELLO');
    });

    it('returns tables correctly', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const result = await lua.execute_script_async("return {a = 1, b = 'two'}");
      expect(result).toEqual({ a: 1, b: 'two' });
    });

    it('is_busy returns false after completion', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      await lua.execute_script_async('return 1');
      expect(lua.is_busy()).toBe(false);
    });

    it('allows sync calls after async completes', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      await lua.execute_script_async('return 1');
      const result = lua.execute_script('return 2 + 3');
      expect(result).toBe(5);
    });

    it('execute_file_async works', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const tmpFile = path.join(os.tmpdir(), `lua-async-test-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, 'return 6 * 7');
      try {
        const lua = new lua_native.init({}, ALL_LIBS);
        const result = await lua.execute_file_async(tmpFile);
        expect(result).toBe(42);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('execute_file_async rejects on file not found', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      await expect(lua.execute_file_async('/nonexistent/file.lua')).rejects.toThrow(/cannot open/);
    });

    it('concurrent execution across contexts', async () => {
      const contexts = Array.from({ length: 4 }, () =>
        new lua_native.init({}, ALL_LIBS)
      );
      const results = await Promise.all(
        contexts.map((lua, i) =>
          lua.execute_script_async(`return ${i + 1} * 10`)
        )
      );
      expect(results).toEqual([10, 20, 30, 40]);
    });
  });

  // ============================================
  // MODULE / REQUIRE INTEGRATION
  // ============================================
  describe('module / require integration', () => {
    describe('add_search_path', () => {
      it('loads a Lua module from a search path', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-modules-'));
        const modPath = path.join(tmpDir, 'mymod.lua');
        fs.writeFileSync(modPath, `
          local M = {}
          function M.greet(name)
            return "Hello, " .. name
          end
          M.version = 42
          return M
        `);

        try {
          const lua = new lua_native.init({}, ALL_LIBS);
          lua.add_search_path(path.join(tmpDir, '?.lua'));
          const result = lua.execute_script(`
            local mymod = require('mymod')
            return mymod.greet('World'), mymod.version
          `);
          expect(result).toEqual(['Hello, World', 42]);
        } finally {
          fs.unlinkSync(modPath);
          fs.rmdirSync(tmpDir);
        }
      });

      it('loads a module from a fixture directory', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fixtureDir = path.resolve(__dirname, '../fixtures/modules');
        lua.add_search_path(path.join(fixtureDir, '?.lua'));
        const result = lua.execute_script(`
          local testmod = require('testmod')
          return testmod.add(3, 4), testmod.name
        `);
        expect(result).toEqual([7, 'testmod']);
      });

      it('supports multiple search paths', () => {
        const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-mods1-'));
        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-mods2-'));
        fs.writeFileSync(path.join(dir1, 'mod_a.lua'), 'return { x = 1 }');
        fs.writeFileSync(path.join(dir2, 'mod_b.lua'), 'return { y = 2 }');

        try {
          const lua = new lua_native.init({}, ALL_LIBS);
          lua.add_search_path(path.join(dir1, '?.lua'));
          lua.add_search_path(path.join(dir2, '?.lua'));

          expect(lua.execute_script("return require('mod_a').x")).toBe(1);
          expect(lua.execute_script("return require('mod_b').y")).toBe(2);
        } finally {
          fs.unlinkSync(path.join(dir1, 'mod_a.lua'));
          fs.unlinkSync(path.join(dir2, 'mod_b.lua'));
          fs.rmdirSync(dir1);
          fs.rmdirSync(dir2);
        }
      });

      it('throws when package library is not loaded', () => {
        const lua = new lua_native.init({}, { libraries: ['base'] });
        expect(() => lua.add_search_path('./?.lua')).toThrow(/package/);
      });

      it('throws when path has no ? placeholder', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.add_search_path('./modules/foo.lua')).toThrow(/\?/);
      });

      it('throws on non-string argument', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua as any).add_search_path(42)).toThrow(/Expected string argument/);
      });

      it('require caches the module (loaded once)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-cache-'));
        fs.writeFileSync(path.join(tmpDir, 'counter.lua'), `
          local M = { count = 0 }
          M.count = M.count + 1
          return M
        `);

        try {
          const lua = new lua_native.init({}, ALL_LIBS);
          lua.add_search_path(path.join(tmpDir, '?.lua'));
          lua.execute_script(`
            local c1 = require('counter')
            local c2 = require('counter')
            assert(c1 == c2, "require should cache modules")
          `);
        } finally {
          fs.unlinkSync(path.join(tmpDir, 'counter.lua'));
          fs.rmdirSync(tmpDir);
        }
      });
    });

    describe('register_module', () => {
      it('registers a module with plain values', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_module('config', {
          debug: true,
          version: '1.0.0',
          maxRetries: 3,
        });
        expect(lua.execute_script("return require('config').debug")).toBe(true);
        expect(lua.execute_script("return require('config').version")).toBe('1.0.0');
        expect(lua.execute_script("return require('config').maxRetries")).toBe(3);
      });

      it('registers a module with functions', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_module('math_utils', {
          clamp: (...args: any[]) => {
            const [x, min, max] = args as number[];
            return Math.min(Math.max(x, min), max);
          },
          lerp: (...args: any[]) => {
            const [a, b, t] = args as number[];
            return a + (b - a) * t;
          },
        });
        expect(lua.execute_script("return require('math_utils').clamp(15, 0, 10)")).toBe(10);
        expect(lua.execute_script("return require('math_utils').clamp(-5, 0, 10)")).toBe(0);
        expect(lua.execute_script("return require('math_utils').lerp(0, 100, 0.5)")).toBe(50);
      });

      it('registers a module with mixed functions and values', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_module('utils', {
          version: '2.0',
          double: (...args: any[]) => (args[0] as number) * 2,
        });
        expect(lua.execute_script("return require('utils').version")).toBe('2.0');
        expect(lua.execute_script("return require('utils').double(21)")).toBe(42);
      });

      it('module is cached by require', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_module('singleton', { id: 1 });
        lua.execute_script(`
          local a = require('singleton')
          local b = require('singleton')
          assert(a == b, "require should return the same table")
        `);
      });

      it('overwrites existing module on re-register', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_module('mymod', { value: 1 });
        expect(lua.execute_script("return require('mymod').value")).toBe(1);

        // Re-register overwrites package.loaded directly
        lua.register_module('mymod', { value: 2 });
        expect(lua.execute_script("return require('mymod').value")).toBe(2);
      });

      it('throws when package library is not loaded', () => {
        const lua = new lua_native.init({}, { libraries: ['base'] });
        expect(() => lua.register_module('mod', { x: 1 })).toThrow(/package/);
      });

      it('throws on invalid arguments', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua as any).register_module(42, {})).toThrow(/Expected \(string, object\)/);
        expect(() => (lua as any).register_module('mod')).toThrow(/Expected \(string, object\)/);
      });

      it('module functions receive correct arguments from Lua', () => {
        let receivedArgs: any[] = [];
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_module('capture', {
          capture: (...args: any[]) => {
            receivedArgs = [...args];
            return null;
          },
        });
        lua.execute_script("require('capture').capture(1, 'hello', true)");
        expect(receivedArgs).toEqual([1, 'hello', true]);
      });

      it('requiring an unknown module still errors', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.execute_script("require('nonexistent')")).toThrow(/module 'nonexistent' not found/);
      });

      it('registered module does not pollute global namespace', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_module('secret', { value: 42 });
        expect(lua.execute_script("return type(secret)")).toBe('nil');
        expect(lua.execute_script("return require('secret').value")).toBe(42);
      });

      it('works alongside add_search_path', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-mixed-'));
        fs.writeFileSync(path.join(tmpDir, 'filemod.lua'),
          "return { source = 'file' }");

        try {
          const lua = new lua_native.init({}, ALL_LIBS);
          lua.add_search_path(path.join(tmpDir, '?.lua'));
          lua.register_module('jsmod', { source: 'js' });

          expect(lua.execute_script("return require('filemod').source")).toBe('file');
          expect(lua.execute_script("return require('jsmod').source")).toBe('js');
        } finally {
          fs.unlinkSync(path.join(tmpDir, 'filemod.lua'));
          fs.rmdirSync(tmpDir);
        }
      });
    });

    describe('busy state', () => {
      it('add_search_path works after async completes', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        await lua.execute_script_async("return 1");
        lua.add_search_path('./?.lua');
      });

      it('register_module works after async completes', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        await lua.execute_script_async("return 1");
        lua.register_module('mod', { x: 1 });
      });
    });
  });

  // ============================================
  // BYTECODE PRECOMPILATION
  // ============================================
  describe('bytecode precompilation', () => {
    describe('compile()', () => {
      it('compiles a script to a bytecode buffer', () => {
        const lua = new lua_native.init();
        const bytecode = lua.compile('return 42');
        expect(bytecode).toBeInstanceOf(Buffer);
        expect(bytecode.length).toBeGreaterThan(0);
      });

      it('throws on syntax error', () => {
        const lua = new lua_native.init();
        expect(() => lua.compile('return +')).toThrow(/unexpected symbol/);
      });

      it('supports stripDebug option', () => {
        const lua = new lua_native.init();
        // Use a chunk with locals and several lines so there is real debug info
        // to strip; a strict inequality means a no-op option fails the test.
        const src = 'local a = 1\nlocal b = 2\nlocal function f(x) return x + a + b end\nreturn f(3)';
        const full = lua.compile(src);
        const stripped = lua.compile(src, { stripDebug: true });
        expect(stripped.length).toBeLessThan(full.length);
        // Stripped bytecode must still run.
        expect(lua.load_bytecode(stripped)).toBe(6);
      });

      it('supports chunkName option (visible in error messages)', () => {
        const lua = new lua_native.init();
        const bytecode = lua.compile('error("test")', { chunkName: '@my-script' });
        expect(() => lua.load_bytecode(bytecode)).toThrow(/my-script/);
      });

      it('compiles without executing', () => {
        const lua = new lua_native.init();
        // If compile executed the code, the global would be set
        lua.compile('x = 999');
        expect(lua.get_global('x')).toBeNull();
      });
    });

    describe('load_bytecode()', () => {
      it('loads and executes bytecode with correct result', () => {
        const lua = new lua_native.init();
        const bytecode = lua.compile('return 42');
        const result = lua.load_bytecode(bytecode);
        expect(result).toBe(42);
      });

      it('produces identical results to execute_script', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const source = `
          local t = {}
          for i = 1, 5 do t[i] = i * 10 end
          return t
        `;
        const direct = lua.execute_script(source);
        const bytecode = lua.compile(source);
        const loaded = lua.load_bytecode(bytecode);
        expect(loaded).toEqual(direct);
      });

      it('returns functions from bytecode', () => {
        const lua = new lua_native.init();
        const bytecode = lua.compile('return function(x) return x * 2 end');
        const fn = lua.load_bytecode(bytecode) as Function;
        expect(fn(21)).toBe(42);
      });

      it('returns multiple values from bytecode', () => {
        const lua = new lua_native.init();
        const bytecode = lua.compile('return 1, "two", true');
        const result = lua.load_bytecode(bytecode);
        expect(result).toEqual([1, 'two', true]);
      });

      it('throws on invalid bytecode', () => {
        const lua = new lua_native.init();
        const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03]);
        expect(() => lua.load_bytecode(garbage)).toThrow(/attempt to load a text chunk/);
      });

      it('throws on empty bytecode', () => {
        const lua = new lua_native.init();
        expect(() => lua.load_bytecode(Buffer.alloc(0))).toThrow(/Bytecode cannot be empty/);
      });

      it('rejects raw source text (binary-only mode)', () => {
        const lua = new lua_native.init();
        const source = Buffer.from('return 42');
        expect(() => lua.load_bytecode(source)).toThrow(/attempt to load a text chunk/);
      });

      it('loads the same bytecode multiple times', () => {
        const lua = new lua_native.init();
        const bytecode = lua.compile('return 99');
        expect(lua.load_bytecode(bytecode)).toBe(99);
        expect(lua.load_bytecode(bytecode)).toBe(99);
        expect(lua.load_bytecode(bytecode)).toBe(99);
      });

      it('supports custom chunk name via compile option', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        // Chunk name is embedded at compile time; load_bytecode uses the embedded name
        const bytecode = lua.compile('error("boom")', { chunkName: 'my-chunk' });
        expect(() => lua.load_bytecode(bytecode)).toThrow(/my-chunk/);
      });

      it('works with callbacks registered on the context', () => {
        const lua = new lua_native.init({
          double: (...args: any[]) => (args[0] as number) * 2
        });
        const bytecode = lua.compile('return double(21)');
        expect(lua.load_bytecode(bytecode)).toBe(42);
      });

      it('interacts with globals set before loading', () => {
        const lua = new lua_native.init();
        lua.set_global('multiplier', 10);
        const bytecode = lua.compile('return multiplier * 5');
        expect(lua.load_bytecode(bytecode)).toBe(50);
      });

      it('allows bytecode compiled on one context to run on another', () => {
        const lua1 = new lua_native.init();
        const lua2 = new lua_native.init();
        const bytecode = lua1.compile('return 123');
        expect(lua2.load_bytecode(bytecode)).toBe(123);
      });

      it('returns undefined when bytecode has no return value', () => {
        const lua = new lua_native.init();
        const bytecode = lua.compile('local x = 1');
        expect(lua.load_bytecode(bytecode)).toBeUndefined();
      });
    });

    describe('compile_file()', () => {
      it('compiles a file to bytecode', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const bytecode = lua.compile_file('./tests/fixtures/return-values.lua');
        expect(bytecode).toBeInstanceOf(Buffer);
        expect(bytecode.length).toBeGreaterThan(0);
      });

      it('produces identical results to execute_file when loaded', () => {
        const lua1 = new lua_native.init({}, ALL_LIBS);
        const lua2 = new lua_native.init({}, ALL_LIBS);
        const fromFile = lua1.execute_file('./tests/fixtures/return-values.lua');
        const bytecode = lua2.compile_file('./tests/fixtures/return-values.lua');
        const fromBytecode = lua2.load_bytecode(bytecode);
        expect(fromBytecode).toEqual(fromFile);
      });

      it('throws on nonexistent file', () => {
        const lua = new lua_native.init();
        expect(() => lua.compile_file('./nonexistent.lua')).toThrow(/cannot open/);
      });

      it('supports stripDebug option', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const full = lua.compile_file('./tests/fixtures/return-values.lua');
        const stripped = lua.compile_file('./tests/fixtures/return-values.lua', { stripDebug: true });
        // Strict: a no-op stripDebug would leave the sizes equal.
        expect(stripped.length).toBeLessThan(full.length);
      });
    });
  });

  // ============================================
  // TABLE REFERENCE API
  // ============================================
  describe('table reference API', () => {
    describe('create_table', () => {
      it('creates an empty table handle', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        expect(t).toBeDefined();
        expect(typeof t.get).toBe('function');
        expect(typeof t.set).toBe('function');
        expect(typeof t.has).toBe('function');
        expect(typeof t.length).toBe('function');
        expect(typeof t.pairs).toBe('function');
        expect(typeof t.ipairs).toBe('function');
        expect(typeof t.release).toBe('function');
        t.release();
      });

      it('creates a table with object initializer', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ name: 'Alice', age: 30 });
        expect(t.get('name')).toBe('Alice');
        expect(t.get('age')).toBe(30);
        t.release();
      });

      it('creates a table with array initializer (1-indexed)', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table([10, 20, 30]);
        expect(t.get(1)).toBe(10);
        expect(t.get(2)).toBe(20);
        expect(t.get(3)).toBe(30);
        expect(t.length()).toBe(3);
        t.release();
      });

      it('creates an empty table when called with no args', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        expect(t.length()).toBe(0);
        expect(t.pairs()).toEqual([]);
        t.release();
      });
    });

    describe('handle.get and handle.set', () => {
      it('sets and gets string-keyed values', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        t.set('x', 42);
        t.set('y', 'hello');
        t.set('z', true);
        expect(t.get('x')).toBe(42);
        expect(t.get('y')).toBe('hello');
        expect(t.get('z')).toBe(true);
        t.release();
      });

      it('sets and gets numeric-keyed values', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        t.set(1, 'first');
        t.set(2, 'second');
        expect(t.get(1)).toBe('first');
        expect(t.get(2)).toBe('second');
        t.release();
      });

      it('returns null for missing keys', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        expect(t.get('nonexistent')).toBeNull();
        t.release();
      });

      it('distinguishes a string key "123" from integer key 123', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        // A numeric string key and the matching integer key are two distinct
        // slots in Lua; the handle API must reach each independently.
        t.set('123', 'string-key');
        t.set(123, 'integer-key');
        expect(t.get('123')).toBe('string-key');
        expect(t.get(123)).toBe('integer-key');
        expect(t.has('123')).toBe(true);
        expect(t.has(123)).toBe(true);

        // Verify against Lua's own view: t["123"] vs t[123].
        lua.set_global('t', t);
        expect(lua.execute_script('return t["123"]')).toBe('string-key');
        expect(lua.execute_script('return t[123]')).toBe('integer-key');
        t.release();
      });

      it('does not coerce a large numeric string key to an integer', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        t.set('99999999999999999999', 'big-string-key');
        expect(t.get('99999999999999999999')).toBe('big-string-key');
        lua.set_global('t', t);
        expect(lua.execute_script('return t["99999999999999999999"]')).toBe('big-string-key');
        t.release();
      });

      it('preserves a fractional numeric key instead of truncating it', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        // 1.5 used to be truncated to integer key 1 via Int64Value().
        t.set(1.5, 'half');
        t.set(1, 'whole');
        expect(t.get(1.5)).toBe('half');
        expect(t.get(1)).toBe('whole');
        lua.set_global('t', t);
        expect(lua.execute_script('return t[1.5]')).toBe('half');
        expect(lua.execute_script('return t[1]')).toBe('whole');
        t.release();
      });

      it('overwrites existing values', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ x: 1 });
        expect(t.get('x')).toBe(1);
        t.set('x', 99);
        expect(t.get('x')).toBe(99);
        t.release();
      });

      it('can set null to remove a field', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ x: 1 });
        expect(t.has('x')).toBe(true);
        t.set('x', null);
        expect(t.has('x')).toBe(false);
        t.release();
      });
    });

    describe('handle.has', () => {
      it('returns true for existing keys', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ a: 1, b: 'x' });
        expect(t.has('a')).toBe(true);
        expect(t.has('b')).toBe(true);
        t.release();
      });

      it('returns false for missing keys', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ a: 1 });
        expect(t.has('missing')).toBe(false);
        t.release();
      });

      it('works with numeric keys', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table([10, 20]);
        expect(t.has(1)).toBe(true);
        expect(t.has(2)).toBe(true);
        expect(t.has(3)).toBe(false);
        t.release();
      });
    });

    describe('handle.length', () => {
      it('returns sequence length for array-like tables', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table([1, 2, 3, 4, 5]);
        expect(t.length()).toBe(5);
        t.release();
      });

      it('returns 0 for empty tables', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        expect(t.length()).toBe(0);
        t.release();
      });

      it('returns 0 for hash-only tables', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ a: 1, b: 2 });
        expect(t.length()).toBe(0);
        t.release();
      });
    });

    describe('handle.pairs', () => {
      it('returns all key-value pairs', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ x: 1, y: 2, z: 3 });
        const p = t.pairs();
        expect(p.length).toBe(3);

        const map = new Map(p);
        expect(map.get('x')).toBe(1);
        expect(map.get('y')).toBe(2);
        expect(map.get('z')).toBe(3);
        t.release();
      });

      it('returns empty array for empty table', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        expect(t.pairs()).toEqual([]);
        t.release();
      });

      it('returns numeric keys for array tables', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table(['a', 'b', 'c']);
        const p = t.pairs();
        expect(p.length).toBe(3);

        // Sort by key for consistent comparison
        p.sort((a, b) => (a[0] as number) - (b[0] as number));
        expect(p[0][0]).toBe(1);
        expect(p[0][1]).toBe('a');
        expect(p[1][0]).toBe(2);
        expect(p[1][1]).toBe('b');
        expect(p[2][0]).toBe(3);
        expect(p[2][1]).toBe('c');
        t.release();
      });

      it('supports for..of iteration', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ a: 1, b: 2 });
        const collected: [string | number, unknown][] = [];
        for (const [k, v] of t.pairs()) {
          collected.push([k, v]);
        }
        expect(collected.length).toBe(2);
        t.release();
      });
    });

    describe('handle.ipairs', () => {
      it('iterates sequential integer keys', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table([10, 20, 30]);
        const ip = t.ipairs();
        expect(ip.length).toBe(3);
        expect(ip[0]).toEqual([1, 10]);
        expect(ip[1]).toEqual([2, 20]);
        expect(ip[2]).toEqual([3, 30]);
        t.release();
      });

      it('returns empty array for hash-only tables', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ a: 1, b: 2 });
        expect(t.ipairs()).toEqual([]);
        t.release();
      });

      it('stops at first nil', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('t = {}; t[1] = 10; t[2] = 20; t[4] = 40');
        const ref = lua.get_global_ref('t');
        const ip = ref.ipairs();
        expect(ip.length).toBe(2);
        expect(ip[0]).toEqual([1, 10]);
        expect(ip[1]).toEqual([2, 20]);
        ref.release();
      });
    });

    describe('handle.release', () => {
      it('methods throw after release', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ x: 1 });
        t.release();
        expect(() => t.get('x')).toThrow('released');
        expect(() => t.set('x', 2)).toThrow('released');
        expect(() => t.has('x')).toThrow('released');
        expect(() => t.length()).toThrow('released');
        expect(() => t.pairs()).toThrow('released');
        expect(() => t.ipairs()).toThrow('released');
      });

      it('double release is a no-op', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        t.release();
        expect(() => t.release()).not.toThrow();
      });
    });

    describe('get_global_ref', () => {
      it('returns a live reference to a global table', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script("config = { host = 'localhost', port = 5432 }");
        const ref = lua.get_global_ref('config');
        expect(ref.get('host')).toBe('localhost');
        expect(ref.get('port')).toBe(5432);
        ref.release();
      });

      it('throws for non-table globals', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('mynum = 42');
        expect(() => lua.get_global_ref('mynum')).toThrow('not a table');
      });

      it('throws for nil globals', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.get_global_ref('nonexistent')).toThrow('not a table');
      });

      it('throws for string globals', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script("mystr = 'hello'");
        expect(() => lua.get_global_ref('mystr')).toThrow('not a table');
      });
    });

    describe('live mutations', () => {
      it('JS mutations are visible in Lua', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('data = { x = 1 }');
        const ref = lua.get_global_ref('data');
        ref.set('x', 99);
        const result = lua.execute_script<number>('return data.x');
        expect(result).toBe(99);
        ref.release();
      });

      it('Lua mutations are visible via handle', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('data = { x = 1 }');
        const ref = lua.get_global_ref('data');
        lua.execute_script('data.x = 200');
        expect(ref.get('x')).toBe(200);
        ref.release();
      });

      it('new fields from JS are visible in Lua', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('data = {}');
        const ref = lua.get_global_ref('data');
        ref.set('name', 'test');
        const result = lua.execute_script<string>('return data.name');
        expect(result).toBe('test');
        ref.release();
      });

      it('new fields from Lua are visible via handle', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('data = {}');
        const ref = lua.get_global_ref('data');
        lua.execute_script("data.name = 'fromLua'");
        expect(ref.get('name')).toBe('fromLua');
        ref.release();
      });
    });

    describe('set_global with table handle', () => {
      it('sets a table handle as a global accessible from Lua', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ greeting: 'hello' });
        lua.set_global('mytable', t);
        const result = lua.execute_script<string>('return mytable.greeting');
        expect(result).toBe('hello');
        t.release();
      });

      it('table handle and Lua global reference the same table', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ x: 1 });
        lua.set_global('shared', t);

        // Modify via Lua
        lua.execute_script('shared.x = 42');

        // Change visible via handle
        expect(t.get('x')).toBe(42);
        t.release();
      });
    });

    describe('passing handles as values', () => {
      it('a handle can be set as a field of another handle', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const parent = lua.create_table();
        const child = lua.create_table({ val: 123 });
        parent.set('child', child);
        lua.set_global('parent', parent);

        const result = lua.execute_script<number>('return parent.child.val');
        expect(result).toBe(123);

        child.release();
        parent.release();
      });
    });

    describe('metatabled table handles', () => {
      it('get_global_ref works with metatabled tables', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('mt = { x = 10 }');
        lua.set_metatable('mt', {
          __len: () => 42,
        });

        const ref = lua.get_global_ref('mt');
        expect(ref.get('x')).toBe(10);
        ref.set('y', 20);
        expect(ref.get('y')).toBe(20);
        ref.release();
      });
    });
  });

  // ============================================
  // DEBUG HOOKS
  // ============================================
  describe('debug hooks - lua.set_hook()', () => {
    /** Collects (event, line, name) triples from a hook. */
    const recorder = () => {
      const events: Array<[string, number, string]> = [];
      const hook = (event: string, line: number, name: string) => {
        events.push([event, line, name]);
      };
      return { events, hook, of: (e: string) => events.filter(([ev]) => ev === e) };
    };

    describe('line events', () => {
      it('fires once per source line with the right line numbers', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { line: true });

        lua.execute_script('local a = 1\nlocal b = 2\nlocal c = a + b\nreturn c');
        lua.remove_hook();

        expect(rec.of('line').map(([, line]) => line)).toEqual([1, 2, 3, 4]);
      });

      it('does not disturb the script result', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { line: true });

        expect(lua.execute_script('local t = {}\nfor i = 1, 10 do t[i] = i * 2 end\nreturn t[10]'))
          .toBe(20);
        expect(rec.events.length).toBeGreaterThan(0);
        lua.remove_hook();
      });

      it('leaves script errors intact', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { line: true });

        expect(() => lua.execute_script("error('boom')")).toThrow('boom');
        lua.remove_hook();
      });
    });

    describe('call and return events', () => {
      it('fires call and return around a function call', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { call: true, return: true });

        lua.execute_script('local function inner() return 1 end\nlocal x = inner()\nreturn x');
        lua.remove_hook();

        expect(rec.of('call').length).toBeGreaterThan(0);
        expect(rec.of('return').length).toBeGreaterThan(0);
      });

      it('reports the function name when Lua can determine one', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { call: true });

        lua.execute_script('function greet() end\nlocal a = greet()\nlocal b = math.floor(1.5)');
        lua.remove_hook();

        const names = rec.of('call').map(([, , name]) => name);
        expect(names).toContain('greet');
        expect(names).toContain('floor');
      });

      it('reports a tail call as its own event', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { call: true });

        lua.execute_script('local function inner() return 1 end\nlocal function outer() return inner() end\nreturn outer()');
        lua.remove_hook();

        expect(rec.of('tail call').length).toBeGreaterThan(0);
      });
    });

    describe('count events', () => {
      it('fires at roughly the requested instruction interval', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { count: 100 });

        lua.execute_script('local s = 0 for i = 1, 5000 do s = s + i end');
        lua.remove_hook();

        // Thousands of instructions at one event per 100. The exact number is a
        // VM detail, so assert the order of magnitude.
        expect(rec.of('count').length).toBeGreaterThan(20);
        expect(rec.of('line').length).toBe(0);  // only the requested mask fires
      });

      it('rejects a non-positive or non-integer count', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.set_hook(() => {}, { count: 0 })).toThrow('positive integer');
        expect(() => lua.set_hook(() => {}, { count: -5 })).toThrow('positive integer');
        expect(() => lua.set_hook(() => {}, { count: 1.5 })).toThrow('positive integer');
        expect(() => lua.set_hook(() => {}, { count: 'many' as any })).toThrow('must be a number');
      });
    });

    describe('remove_hook()', () => {
      it('stops further events', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { line: true });
        lua.execute_script('local a = 1');
        const afterFirst = rec.events.length;
        expect(afterFirst).toBeGreaterThan(0);

        lua.remove_hook();
        lua.execute_script('local a = 1\nlocal b = 2\nlocal c = 3');

        expect(rec.events.length).toBe(afterFirst);
      });

      it('is a no-op when no hook is set', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.remove_hook()).not.toThrow();
        expect(() => lua.remove_hook()).not.toThrow();
      });

      it('can be called from inside the hook itself', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        let fired = 0;
        // The obvious "trace until X" pattern — it must not destroy the
        // callback that is currently executing.
        lua.set_hook(() => { fired++; lua.remove_hook(); }, { line: true });

        lua.execute_script('local a = 1\nlocal b = 2\nlocal c = 3\nlocal d = 4');

        expect(fired).toBe(1);
      });
    });

    describe('replacing a hook', () => {
      it('detaches the previous callback', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const first = recorder();
        const second = recorder();

        lua.set_hook(first.hook, { line: true });
        lua.execute_script('local a = 1');
        const afterFirst = first.events.length;

        lua.set_hook(second.hook, { line: true });
        lua.execute_script('local a = 1\nlocal b = 2');

        expect(first.events.length).toBe(afterFirst);
        expect(second.events.length).toBeGreaterThan(0);
        lua.remove_hook();
      });

      it('can be called from inside the hook itself', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        let firstFired = 0;
        let secondFired = 0;
        lua.set_hook(() => {
          firstFired++;
          lua.set_hook(() => { secondFired++; }, { line: true });
        }, { line: true });

        lua.execute_script('local a = 1\nlocal b = 2\nlocal c = 3');
        lua.remove_hook();

        expect(firstFired).toBe(1);
        expect(secondFired).toBeGreaterThan(0);
      });
    });

    describe('argument validation', () => {
      it('requires a function callback', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua.set_hook as any)()).toThrow('requires a function');
        expect(() => (lua.set_hook as any)('not a function', { line: true }))
          .toThrow('requires a function');
      });

      it('requires an options object', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua.set_hook as any)(() => {})).toThrow('requires an options object');
        expect(() => (lua.set_hook as any)(() => {}, 'line')).toThrow('requires an options object');
        expect(() => (lua.set_hook as any)(() => {}, ['line'])).toThrow('requires an options object');
      });

      it('requires at least one event', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.set_hook(() => {}, {})).toThrow('at least one of call, return, line, or count');
        expect(() => lua.set_hook(() => {}, { line: false, call: false }))
          .toThrow('at least one of call, return, line, or count');
      });
    });

    describe('interaction with other features', () => {
      it('swallows an exception thrown by the hook', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        let fired = 0;
        lua.set_hook(() => { fired++; throw new Error('boom from hook'); }, { line: true });

        // The hook is a diagnostic channel: a throwing callback must not
        // corrupt the VM or surface as a script error.
        expect(lua.execute_script('local a = 1\nreturn a + 1')).toBe(2);
        expect(fired).toBeGreaterThan(0);

        lua.remove_hook();
        expect(lua.execute_script('return 7')).toBe(7);
      });

      it('allows the hook to run Lua re-entrantly', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        let inner: unknown = null;
        // Lua disables the hook while it runs, so this does not recurse.
        lua.set_hook(() => { inner = lua.execute_script('return 40 + 2'); }, { line: true });

        expect(lua.execute_script('return 1')).toBe(1);
        lua.remove_hook();
        expect(inner).toBe(42);
      });

      it('keeps maxInstructions enforced', () => {
        const lua = new lua_native.init({}, { libraries: 'all', maxInstructions: 200_000 });
        const rec = recorder();
        // A count interval far finer than the limit's own — the two share one
        // lua_sethook installation.
        lua.set_hook(rec.hook, { count: 7 });

        expect(() => lua.execute_script('while true do end')).toThrow(/instruction limit exceeded/);
        expect(rec.of('count').length).toBeGreaterThan(0);

        // ...and removing the hook leaves the limit intact.
        lua.remove_hook();
        expect(() => lua.execute_script('while true do end')).toThrow(/instruction limit exceeded/);
      });

      it('does not weaken maxInstructions with a line-only mask', () => {
        const lua = new lua_native.init({}, { libraries: 'all', maxInstructions: 100_000 });
        lua.set_hook(() => {}, { line: true });

        expect(() => lua.execute_script('while true do end')).toThrow(/instruction limit exceeded/);
        lua.remove_hook();
      });

      it('traces coroutines created after the hook is installed', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { line: true });

        const co = lua.create_coroutine('return function() local a = 1 coroutine.yield(a) return a + 1 end');
        const before = rec.events.length;
        lua.resume(co);
        lua.remove_hook();

        expect(rec.events.length).toBeGreaterThan(before);
      });

      it('does not fire into JS during worker-thread async execution', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        let hits = 0;
        lua.set_hook(() => hits++, { line: true });

        // execute_script_async runs Lua on a worker thread, where calling into
        // JavaScript is not permitted.
        const result = await lua.execute_script_async(
          'local s = 0 for i = 1, 200000 do s = s + i end return s');

        expect(result).toBe(20000100000);
        expect(hits).toBe(0);

        // The hook is still live for main-thread execution.
        lua.execute_script('local a = 1');
        expect(hits).toBeGreaterThan(0);
        lua.remove_hook();
      });

      it('rejects set_hook and remove_hook while an async op is in flight', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const pending = lua.execute_script_async(
          'local s = 0 for i = 1, 3000000 do s = s + i end return s');

        expect(() => lua.set_hook(() => {}, { line: true })).toThrow('busy with an async operation');
        expect(() => lua.remove_hook()).toThrow('busy with an async operation');

        await pending;
        expect(() => lua.set_hook(() => {}, { line: true })).not.toThrow();
        lua.remove_hook();
      });

      it('re-arms the hook after reset()', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        lua.set_hook(rec.hook, { line: true });

        lua.reset();
        rec.events.length = 0;
        lua.execute_script('local a = 1\nlocal b = 2');

        // Like the print handler, the hook is a JS callback plus configuration,
        // so a reset replays it onto the fresh state.
        expect(rec.of('line').length).toBe(2);
        lua.remove_hook();
      });

      it('traces a script running in an environment table', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const rec = recorder();
        const env = lua.create_environment({ whitelist: ['math'] });
        lua.set_hook(rec.hook, { line: true });

        lua.execute_script_in(env, 'local a = math.floor(1.5)\nreturn a');
        lua.remove_hook();

        expect(rec.of('line').length).toBe(2);
      });
    });
  });

  // ============================================
  // STATE INTROSPECTION
  // ============================================
  describe('state introspection - lua.info()', () => {
    it('reports the Lua version', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const info = lua.info();

      expect(info.version).toMatch(/^Lua \d+\.\d+$/);
      expect(info.release).toMatch(/^Lua \d+\.\d+\.\d+$/);
      expect(info.release.startsWith(info.version)).toBe(true);
      expect(info.versionNumber).toBeGreaterThanOrEqual(504);
      // Agrees with what the state itself reports.
      expect(lua.execute_script('return _VERSION')).toBe(info.version);
    });

    it('reports memory usage consistently with get_memory_usage()', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const info = lua.info();

      expect(info.memoryBytes).toBeGreaterThan(0);
      expect(info.memoryKB).toBeCloseTo(info.memoryBytes / 1024, 10);
      // Same allocator counter, so the two must agree closely; allow for the
      // handful of bytes the intervening call itself may allocate.
      expect(Math.abs(lua.get_memory_usage() - info.memoryBytes)).toBeLessThan(4096);
    });

    it('tracks memory growth', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const before = lua.info().memoryBytes;
      lua.execute_script('big = {} for i = 1, 20000 do big[i] = i end');
      expect(lua.info().memoryBytes).toBeGreaterThan(before);
    });

    it('reports the configured limits', () => {
      const lua = new lua_native.init({}, {
        libraries: 'all',
        maxMemory: 4 * 1024 * 1024,
        maxInstructions: 250_000,
      });
      const info = lua.info();

      expect(info.memoryLimit).toBe(4 * 1024 * 1024);
      expect(info.maxInstructions).toBe(250_000);
      expect(info.memoryBytes).toBeLessThan(info.memoryLimit);
    });

    it('reports 0 for unset limits', () => {
      const info = new lua_native.init({}, ALL_LIBS).info();
      expect(info.memoryLimit).toBe(0);
      expect(info.maxInstructions).toBe(0);
    });

    it('expands a library preset to the names it loaded', () => {
      expect(new lua_native.init({}, { libraries: 'all' }).info().libraries)
        .toEqual(['base', 'package', 'coroutine', 'table', 'io', 'os', 'string', 'math', 'utf8', 'debug']);

      const safe = new lua_native.init({}, { libraries: 'safe' }).info().libraries;
      expect(safe).toContain('string');
      expect(safe).not.toContain('io');
      expect(safe).not.toContain('os');
      expect(safe).not.toContain('debug');
    });

    it('reports an explicit library list verbatim', () => {
      const lua = new lua_native.init({}, { libraries: ['base', 'math'] });
      expect(lua.info().libraries).toEqual(['base', 'math']);
    });

    it('reports no libraries for a bare state', () => {
      expect(new lua_native.init().info().libraries).toEqual([]);
    });

    it('runs no Lua code and triggers no collection', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      // A stopped collector must stay stopped: info() is a pure read.
      lua.gc('stop');
      lua.info();
      expect(lua.gc('isrunning')).toBe(false);
      lua.gc('restart');
    });

    it('returns a plain object, not a live view', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const first = lua.info();
      lua.execute_script('big = {} for i = 1, 20000 do big[i] = i end');
      const second = lua.info();

      // The snapshot is a copy — the earlier one does not move.
      expect(second.memoryBytes).toBeGreaterThan(first.memoryBytes);
      expect(first).not.toBe(second);
    });

    it('survives a reset with the same configuration', () => {
      const lua = new lua_native.init({}, { libraries: 'safe', maxMemory: 2 * 1024 * 1024 });
      const before = lua.info();
      lua.reset();
      const after = lua.info();

      expect(after.libraries).toEqual(before.libraries);
      expect(after.memoryLimit).toBe(before.memoryLimit);
      expect(after.version).toBe(before.version);
    });

    it('rejects a call while an async operation is in flight', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const pending = lua.execute_script_async(
        'local s = 0 for i = 1, 3000000 do s = s + i end return s');

      // The allocator counter is being mutated on the worker thread.
      expect(() => lua.info()).toThrow('busy with an async operation');

      await pending;
      expect(lua.info().memoryBytes).toBeGreaterThan(0);
    });
  });

  // ============================================
  // ENVIRONMENT TABLES
  // ============================================
  describe('environment tables', () => {
    describe('create_environment()', () => {
      it('seeds the environment with whitelisted globals only', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['math'] });
        expect(lua.execute_script_in(env, 'return math.sqrt(16)')).toBe(4);
        // Not even `type` is reachable — the environment holds exactly what was
        // whitelisted, so the checks compare against nil directly.
        expect(lua.execute_script_in(env, 'return string == nil')).toBe(true);
        expect(lua.execute_script_in(env, 'return io == nil')).toBe(true);
      });

      it('creates an empty environment with no options', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment();
        expect(env.pairs()).toEqual([]);
        expect(lua.execute_script_in(env, 'return print == nil')).toBe(true);
      });

      it('treats an empty whitelist as an empty environment', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: [] });
        expect(env.pairs()).toEqual([]);
      });

      it('skips whitelisted names that are unset in _G', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['math', 'no_such_global'] });
        expect(env.has('math')).toBe(true);
        expect(env.has('no_such_global')).toBe(false);
      });

      it('returns a usable table handle', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['math'] });
        env.set('answer', 42);
        expect(env.get('answer')).toBe(42);
        expect(lua.execute_script_in(env, 'return answer * 2')).toBe(84);
        expect(env.pairs().map(([k]) => k).sort()).toEqual(['answer', 'math']);
      });

      it('copies globals by reference, not by value', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['shared'] });
        lua.execute_script('shared = { n = 1 }');
        // Seeded before `shared` existed, so the environment has nothing.
        expect(env.has('shared')).toBe(false);

        const env2 = lua.create_environment({ whitelist: ['shared'] });
        lua.execute_script_in(env2, 'shared.n = 99');
        // The environment holds the same table _G.shared names.
        expect(lua.execute_script('return shared.n')).toBe(99);
      });

      it('rejects non-object options', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.create_environment('math' as any)).toThrow('must be an object');
        expect(() => lua.create_environment(['math'] as any)).toThrow('must be an object');
      });

      it('rejects a non-array whitelist and non-string entries', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.create_environment({ whitelist: 'math' as any }))
          .toThrow('must be an array of strings');
        expect(() => lua.create_environment({ whitelist: [1] as any }))
          .toThrow('entries must be strings');
      });
    });

    describe('execute_script_in()', () => {
      it('leaves the context globals untouched', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('counter = 1');
        lua.execute_script_in(lua.create_environment(), 'counter = 99');
        expect(lua.get_global('counter')).toBe(1);
      });

      it('captures globals the script assigns in the environment', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment();
        lua.execute_script_in(env, 'greeting = "hello"');
        expect(env.get('greeting')).toBe('hello');
        expect(lua.get_global('greeting')).toBeNull();
      });

      it('isolates two environments from each other', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const a = lua.create_environment();
        const b = lua.create_environment();
        lua.execute_script_in(a, 'tenant = "a"');
        lua.execute_script_in(b, 'tenant = "b"');
        expect(lua.execute_script_in(a, 'return tenant')).toBe('a');
        expect(lua.execute_script_in(b, 'return tenant')).toBe('b');
      });

      it('errors when calling a global the environment does not expose', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['math'] });
        expect(() => lua.execute_script_in(env, 'return io.open("/etc/passwd")'))
          .toThrow(/attempt to index a nil value/);
      });

      it('returns multiple values like execute_script', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment();
        expect(lua.execute_script_in(env, 'return 1, 2, 3')).toEqual([1, 2, 3]);
        expect(lua.execute_script_in(env, 'local x = 1')).toBeUndefined();
      });

      it('surfaces syntax and runtime errors', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['error'] });
        expect(() => lua.execute_script_in(env, 'this is not lua')).toThrow(/syntax error/);
        expect(() => lua.execute_script_in(env, 'error("boom")')).toThrow('boom');
      });

      it('reaches JS callbacks seeded into the environment', () => {
        const seen: number[] = [];
        const lua = new lua_native.init({ report: (n: any) => { seen.push(n as number); } }, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['report'] });
        lua.execute_script_in(env, 'report(7)');
        expect(seen).toEqual([7]);
      });

      it('honors maxInstructions inside an environment', () => {
        const lua = new lua_native.init({}, { libraries: 'all', maxInstructions: 100_000 });
        const env = lua.create_environment();
        expect(() => lua.execute_script_in(env, 'while true do end'))
          .toThrow(/instruction limit exceeded/);
      });

      it('accepts a plain table handle as an environment', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ base: 10 });
        expect(lua.execute_script_in(t, 'return base + 5')).toBe(15);
        lua.execute_script_in(t, 'derived = base * 2');
        expect(t.get('derived')).toBe(20);
      });

      it('accepts a global table reference as an environment', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('sandbox = { limit = 3 }');
        const ref = lua.get_global_ref('sandbox');
        expect(lua.execute_script_in(ref, 'return limit')).toBe(3);
      });

      it('rejects a non-reference first argument', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.execute_script_in({} as any, 'return 1'))
          .toThrow('must be an environment or table reference');
        expect(() => lua.execute_script_in(null as any, 'return 1'))
          .toThrow('must be an environment or table reference');
      });

      it('requires a script string', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment();
        expect(() => (lua.execute_script_in as any)(env))
          .toThrow('requires an environment and a script string');
        expect(() => (lua.execute_script_in as any)(env, 42))
          .toThrow('requires an environment and a script string');
      });

      it('rejects an environment from a different context', () => {
        const luaA = new lua_native.init({}, ALL_LIBS);
        const luaB = new lua_native.init({}, ALL_LIBS);
        const env = luaA.create_environment({ whitelist: ['math'] });
        expect(() => luaB.execute_script_in(env, 'return 1'))
          .toThrow('different Lua context');
      });

      it('rejects a released environment', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['math'] });
        env.release();
        expect(() => lua.execute_script_in(env, 'return math.pi'))
          .toThrow('table handle has been released');
      });

      it('rejects an environment created before a reset()', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['math'] });
        lua.reset();
        // reset() retires the state; the handle's runtime no longer matches, so
        // it is rejected the same way a foreign context's handle is.
        expect(() => lua.execute_script_in(env, 'return math.pi'))
          .toThrow('different Lua context');
      });

      it('round-trips an environment into Lua as an ordinary table', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment();
        lua.execute_script_in(env, 'value = 5');
        lua.set_global('sandbox', env);
        expect(lua.execute_script('return sandbox.value')).toBe(5);
      });

      it('releases via lua.release(env) too', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment();
        lua.release(env);
        expect(() => lua.execute_script_in(env, 'return 1'))
          .toThrow('table handle has been released');
      });
    });

    describe('inherit', () => {
      it('reads unlisted globals through _G when inherit is true', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('app_name = "demo"');
        const env = lua.create_environment({ inherit: true });
        expect(lua.execute_script_in(env, 'return app_name')).toBe('demo');
        expect(lua.execute_script_in(env, 'return string.upper("hi")')).toBe('HI');
      });

      it('does not read unlisted globals when inherit is false', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('app_name = "demo"');
        const env = lua.create_environment({ inherit: false });
        expect(lua.execute_script_in(env, 'return app_name')).toBeNull();
      });

      it('shadows rather than overwrites globals on assignment', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('app_name = "demo"');
        const env = lua.create_environment({ inherit: true });
        lua.execute_script_in(env, 'app_name = "sandboxed"');
        expect(lua.execute_script_in(env, 'return app_name')).toBe('sandboxed');
        expect(lua.get_global('app_name')).toBe('demo');
      });

      it('sees globals added to _G after the environment was created', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ inherit: true });
        lua.execute_script('added_later = 5');
        // __index is a live link to _G, unlike the whitelist's one-time copy.
        expect(lua.execute_script_in(env, 'return added_later')).toBe(5);
      });

      it('lets a whitelisted name shadow the inherited one', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const env = lua.create_environment({ whitelist: ['print'], inherit: true });
        env.set('print', 'not-a-function');
        expect(lua.execute_script_in(env, 'return print')).toBe('not-a-function');
        expect(typeof lua.get_global('print')).toBe('function');
      });
    });
  });

  // ============================================
  // MEMORY LIMITS
  // ============================================
  describe('memory limits', () => {
    describe('get_memory_usage()', () => {
      it('returns a positive number without maxMemory', () => {
        const lua = new lua_native.init(undefined, ALL_LIBS);
        const usage = lua.get_memory_usage();
        expect(usage).toBeGreaterThan(0);
        expect(typeof usage).toBe('number');
      });

      it('returns a positive number with maxMemory', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxMemory: 10 * 1024 * 1024 });
        const usage = lua.get_memory_usage();
        expect(usage).toBeGreaterThan(0);
      });

      it('memory usage increases after allocations', () => {
        const lua = new lua_native.init(undefined, ALL_LIBS);
        const before = lua.get_memory_usage();
        lua.execute_script(`
          big_table = {}
          for i = 1, 1000 do
            big_table[i] = string.rep('a', 100)
          end
        `);
        const after = lua.get_memory_usage();
        expect(after).toBeGreaterThan(before);
      });
    });

    describe('maxMemory enforcement', () => {
      it('normal scripts work within limit', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxMemory: 1024 * 1024 });
        const result = lua.execute_script('return 1 + 2');
        expect(result).toBe(3);
      });

      it('throws OOM when exceeding limit with string.rep', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxMemory: 256 * 1024 });
        expect(() => {
          lua.execute_script("return string.rep('x', 1024 * 1024)");
        }).toThrow(/memory/i);
      });

      it('throws OOM when exceeding limit with table accumulation', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxMemory: 256 * 1024 });
        expect(() => {
          lua.execute_script(`
            t = {}
            for i = 1, 1000000 do
              t[i] = string.rep('x', 100)
            end
          `);
        }).toThrow(/memory/i);
      });

      it('context recovers after OOM — can still run small scripts', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxMemory: 256 * 1024 });

        // Trigger OOM
        expect(() => {
          lua.execute_script("return string.rep('x', 1024 * 1024)");
        }).toThrow(/not enough memory/);

        // Small script should still work
        const result = lua.execute_script('return 42');
        expect(result).toBe(42);
      });
    });

    describe('maxMemory: 0 means unlimited', () => {
      it('allows large allocations with maxMemory: 0', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxMemory: 0 });
        const result = lua.execute_script<string>("return string.rep('x', 100000)");
        expect(result.length).toBe(100000);
      });
    });

    describe('negative maxMemory rejected', () => {
      it('throws RangeError for negative maxMemory', () => {
        expect(() => {
          new lua_native.init(undefined, { libraries: 'all', maxMemory: -1 } as any);
        }).toThrow(/non-negative/);
      });
    });

    describe('callbacks work with memory limit set', () => {
      it('JS callbacks work within memory limit', () => {
        const lua = new lua_native.init(
          { add: (a: number, b: number) => a + b },
          { libraries: 'all', maxMemory: 1024 * 1024 }
        );
        const result = lua.execute_script('return add(10, 20)');
        expect(result).toBe(30);
      });
    });
  });

  // ============================================
  // Execution time limits (maxInstructions)
  // ============================================
  describe('execution limits', () => {
    describe('maxInstructions enforcement', () => {
      it('aborts an infinite loop instead of hanging', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxInstructions: 1_000_000 });
        expect(() => {
          lua.execute_script('while true do end');
        }).toThrow(/instruction limit exceeded/i);
      });

      it('lets a normal script complete within the limit', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxInstructions: 1_000_000 });
        const result = lua.execute_script('local s = 0; for i = 1, 100 do s = s + i end; return s');
        expect(result).toBe(5050);
      });

      it('resets the instruction budget between execute_script calls', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxInstructions: 200_000 });
        // Each call does a moderate amount of work well under the limit; run
        // several in a row to prove the counter does not carry over.
        for (let i = 0; i < 20; i++) {
          const r = lua.execute_script('local s = 0; for j = 1, 1000 do s = s + j end; return s');
          expect(r).toBe(500500);
        }
      });

      it('aborts an infinite loop inside a coroutine', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxInstructions: 500_000 });
        lua.execute_script('co = coroutine.create(function() while true do end end)');
        const result = lua.execute_script<string>(
          'local ok, err = coroutine.resume(co); return tostring(ok) .. ": " .. tostring(err)'
        );
        expect(result).toMatch(/^false: .*instruction limit exceeded/i);
      });

      it('the context still works after an instruction-limit abort', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxInstructions: 1_000_000 });
        expect(() => lua.execute_script('while true do end')).toThrow(/instruction limit/i);
        expect(lua.execute_script('return 42')).toBe(42);
      });

      it('enforces a small limit tightly', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxInstructions: 500 });
        expect(() => {
          lua.execute_script('local s = 0; for i = 1, 1e9 do s = s + i end; return s');
        }).toThrow(/instruction limit exceeded/i);
      });
    });

    describe('maxInstructions: 0 / omitted means unlimited', () => {
      it('runs a long (but finite) loop with maxInstructions: 0', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all', maxInstructions: 0 });
        const result = lua.execute_script('local s = 0; for i = 1, 5000000 do s = s + 1 end; return s');
        expect(result).toBe(5_000_000);
      });

      it('runs a long loop when maxInstructions is omitted', () => {
        const lua = new lua_native.init(undefined, { libraries: 'all' });
        const result = lua.execute_script('local s = 0; for i = 1, 5000000 do s = s + 1 end; return s');
        expect(result).toBe(5_000_000);
      });
    });

    describe('invalid maxInstructions rejected', () => {
      it('throws RangeError for a negative value', () => {
        expect(() => {
          new lua_native.init(undefined, { libraries: 'all', maxInstructions: -1 } as any);
        }).toThrow(/non-negative/);
      });

      it('throws TypeError for a non-number value', () => {
        expect(() => {
          new lua_native.init(undefined, { libraries: 'all', maxInstructions: 'lots' } as any);
        }).toThrow(/must be a number/);
      });
    });

    describe('maxInstructions combines with maxMemory', () => {
      it('both limits are active together', () => {
        const lua = new lua_native.init(undefined, {
          libraries: 'safe',
          maxMemory: 1024 * 1024,
          maxInstructions: 1_000_000,
        });
        expect(lua.execute_script('return 1 + 1')).toBe(2);
        expect(() => lua.execute_script('while true do end')).toThrow(/instruction limit/i);
      });
    });

    describe('timeout (wall clock)', () => {
      it('aborts a runaway script instead of hanging', () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 100 });
        const start = Date.now();

        expect(() => lua.execute_script('while true do end')).toThrow(/execution timeout/i);

        // Generous bound: this asserts the loop was interrupted at all, not
        // that the deadline is precise.
        expect(Date.now() - start).toBeLessThan(10_000);
      });

      it('lets a fast script complete normally', () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 30_000 });
        expect(lua.execute_script('local s = 0 for i = 1, 100000 do s = s + i end return s'))
          .toBe(5000050000);
      });

      it('treats 0 and omission as no timeout', () => {
        const zero = new lua_native.init({}, { libraries: 'all', timeout: 0 });
        expect(zero.info().timeout).toBe(0);
        expect(zero.execute_script('local s = 0 for i = 1, 200000 do s = s + i end return s'))
          .toBeGreaterThan(0);

        expect(new lua_native.init({}, ALL_LIBS).info().timeout).toBe(0);
      });

      it('reports the configured timeout through info()', () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 2500 });
        expect(lua.info().timeout).toBe(2500);
      });

      it('leaves the context usable after a timeout', () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 100 });
        expect(() => lua.execute_script('while true do end')).toThrow(/execution timeout/i);
        expect(lua.execute_script('return 2 + 2')).toBe(4);
      });

      it('gives each execution its own budget', () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 2000 });
        // Several executions that each fit the budget all succeed, even though
        // together they may exceed it — the deadline resets at every entry.
        for (let i = 0; i < 4; i++) {
          expect(() => lua.execute_script('local s = 0 for i = 1, 300000 do s = s + i end'))
            .not.toThrow();
        }
      });

      it('applies to a coroutine resume', () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 100 });
        const co = lua.create_coroutine('return function() while true do end end');

        const result = lua.resume(co);
        expect(result.error).toMatch(/execution timeout/i);
      });

      it('applies to worker-thread async execution', async () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 100 });
        await expect(lua.execute_script_async('while true do end'))
          .rejects.toThrow(/execution timeout/i);

        // The worker is released and the context works again.
        expect(lua.execute_script('return 1')).toBe(1);
      });

      it('survives a reset()', () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 100 });
        lua.reset();

        expect(lua.info().timeout).toBe(100);
        expect(() => lua.execute_script('while true do end')).toThrow(/execution timeout/i);
      });

      it('is catchable by a Lua pcall', () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 100 });
        // Raised as a normal Lua error, so a script's own pcall sees it. The
        // budget is not refreshed by that, so the script still terminates.
        const [ok, err] = lua.execute_script<[boolean, string]>(
          'local ok, err = pcall(function() while true do end end)\nreturn ok, tostring(err)');
        expect(ok).toBe(false);
        expect(err).toMatch(/execution timeout/i);
      });

      it('rejects a negative or non-numeric timeout', () => {
        expect(() => new lua_native.init({}, { libraries: 'all', timeout: -1 }))
          .toThrow('timeout must be a non-negative number');
        expect(() => new lua_native.init({}, { libraries: 'all', timeout: 'soon' as any }))
          .toThrow('timeout must be a number');
      });
    });

    describe('timeout and maxInstructions together', () => {
      it('aborts on instructions when that limit is tighter', () => {
        const lua = new lua_native.init({}, {
          libraries: 'all', timeout: 60_000, maxInstructions: 50_000,
        });
        expect(() => lua.execute_script('while true do end'))
          .toThrow(/instruction limit exceeded/i);
      });

      it('aborts on time when the timeout is tighter', () => {
        const lua = new lua_native.init({}, {
          libraries: 'all', timeout: 100, maxInstructions: 4_000_000_000,
        });
        expect(() => lua.execute_script('while true do end')).toThrow(/execution timeout/i);
      });

      it('reports both through info()', () => {
        const lua = new lua_native.init({}, {
          libraries: 'all', timeout: 5000, maxInstructions: 1_000_000,
        });
        const info = lua.info();
        expect(info.timeout).toBe(5000);
        expect(info.maxInstructions).toBe(1_000_000);
      });

      it('keeps working with a debug hook installed and removed', () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 100 });
        let hookEvents = 0;
        // A line-only mask must not displace the count hook the timeout needs.
        lua.set_hook(() => hookEvents++, { line: true });

        expect(() => lua.execute_script('while true do end')).toThrow(/execution timeout/i);
        expect(hookEvents).toBeGreaterThan(0);

        lua.remove_hook();
        expect(() => lua.execute_script('while true do end')).toThrow(/execution timeout/i);
      });

      it('still honors cancel() during async execution', async () => {
        const lua = new lua_native.init({}, { libraries: 'all', timeout: 60_000 });
        const pending = lua.execute_script_async('while true do end');
        setTimeout(() => lua.cancel(), 50);

        await expect(pending).rejects.toThrow(/execution cancelled/i);
      });
    });
  });

  // ============================================
  // TYPE-SYSTEM FIDELITY (B1 + B2)
  // ============================================
  describe('type-system fidelity', () => {
    describe('BigInt', () => {
      it('converts a JS BigInt to a Lua integer', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('n', 42n as any);
        expect(lua.execute_script('return n')).toBe(42);
        expect(lua.execute_script('return math.type(n)')).toBe('integer');
      });

      it('preserves 64-bit precision beyond Number.MAX_SAFE_INTEGER', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const big = 9007199254740993n; // 2^53 + 1, not exactly representable as a double
        lua.set_global('n', big as any);
        const back = lua.execute_script('return n');
        expect(typeof back).toBe('bigint');
        expect(back).toBe(big);
      });

      it('returns large Lua integers as BigInt', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const r = lua.execute_script('return math.maxinteger');
        expect(typeof r).toBe('bigint');
        expect(r).toBe(9223372036854775807n);
      });

      it('returns small Lua integers as Number', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const r = lua.execute_script('return 123');
        expect(typeof r).toBe('number');
        expect(r).toBe(123);
      });

      it('throws for a BigInt out of int64 range', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.set_global('n', (2n ** 100n) as any)).toThrow(/out of range/);
      });
    });

    describe('Symbol', () => {
      it('rejects a JS Symbol with a clear error', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.set_global('s', Symbol('x') as any)).toThrow(/Symbol/);
      });
    });

    describe('binary data', () => {
      it('converts a Buffer to a binary-safe Lua string', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('buf', Buffer.from('hello') as any);
        expect(lua.execute_script('return buf')).toBe('hello');
        expect(lua.execute_script('return #buf')).toBe(5);
      });

      it('preserves embedded null bytes from a Buffer', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('buf', Buffer.from([0x00, 0x01, 0xff]) as any);
        expect(lua.execute_script('return #buf')).toBe(3);
        expect(lua.execute_script('return string.byte(buf, 3)')).toBe(255);
      });

      it('converts a Uint8Array to a Lua string', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('ta', new Uint8Array([104, 105]) as any); // "hi"
        expect(lua.execute_script('return ta')).toBe('hi');
      });

      it('honors a typed-array byteOffset (subarray view)', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const sub = new Uint8Array([1, 2, 3, 4, 5]).subarray(2); // [3,4,5], offset 2
        lua.set_global('sub', sub as any);
        expect(lua.execute_script('return #sub')).toBe(3);
        expect(lua.execute_script('return string.byte(sub, 1)')).toBe(3);
      });

      it('uses raw byte length for wide typed arrays', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('u16', new Uint16Array([1, 2]) as any); // 4 bytes
        expect(lua.execute_script('return #u16')).toBe(4);
      });

      it('converts an ArrayBuffer to a Lua string', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('ab', new Uint8Array([65, 66, 67]).buffer as any); // "ABC"
        expect(lua.execute_script('return ab')).toBe('ABC');
      });

      it('handles an empty Buffer', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('buf', Buffer.alloc(0) as any);
        expect(lua.execute_script('return #buf')).toBe(0);
      });
    });

    describe('Date', () => {
      it('converts a Date to epoch milliseconds', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('d', new Date(1234) as any);
        expect(lua.execute_script('return d')).toBe(1234);
      });
    });

    describe('Map', () => {
      it('converts a Map to a Lua table', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('m', new Map([['a', 1], ['b', 2]]) as any);
        expect(lua.execute_script('return m.a')).toBe(1);
        expect(lua.execute_script('return m.b')).toBe(2);
      });

      it('recurses into nested Map values', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('m', new Map<string, any>([['nested', new Map([['x', 5]])]]) as any);
        expect(lua.execute_script('return m.nested.x')).toBe(5);
      });
    });

    describe('Set', () => {
      it('converts a Set to a Lua array', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('s', new Set([10, 20, 30]) as any);
        expect(lua.execute_script('return #s')).toBe(3);
        expect(lua.execute_script('return s[1]')).toBe(10);
        expect(lua.execute_script('return s[3]')).toBe(30);
      });
    });

    describe('RegExp', () => {
      it('converts a RegExp to its source pattern string', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('re', /foo\d+/g as any);
        expect(lua.execute_script('return re')).toBe('foo\\d+');
      });
    });

    describe('custom type converters (register_type_converter)', () => {
      class Money {
        constructor(public cents: number) {}
      }

      it('applies a registered converter for a custom class', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_type_converter(
          (v) => v instanceof Money,
          (v: Money) => ({ cents: v.cents, dollars: v.cents / 100 })
        );
        lua.set_global('price', new Money(1299) as any);
        expect(lua.execute_script('return price.cents')).toBe(1299);
        expect(lua.execute_script('return price.dollars')).toBe(12.99);
      });

      it('lets a converter override built-in handling (Date)', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_type_converter(
          (v) => v instanceof Date,
          () => 'custom-date'
        );
        lua.set_global('d', new Date() as any);
        expect(lua.execute_script('return d')).toBe('custom-date');
      });

      it('consults converters in registration order (first match wins)', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_type_converter(() => true, () => 'first');
        lua.register_type_converter(() => true, () => 'second');
        lua.set_global('o', {} as any);
        expect(lua.execute_script('return o')).toBe('first');
      });

      it('does not intercept internal round-trip markers (reference integrity)', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('shared = setmetatable({ v = 7 }, {})');
        const proxy = lua.get_global('shared'); // metatabled table -> Proxy w/ _tableRef
        lua.register_type_converter(() => true, () => 'HIJACKED');
        lua.set_global('roundtrip', proxy);
        // The proxy must round-trip as the original table, not be hijacked.
        expect(lua.execute_script('return roundtrip.v')).toBe(7);
      });

      it('does not intercept plain primitives', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_type_converter(() => true, () => 'converted');
        lua.set_global('n', 5);
        lua.set_global('s', 'hi');
        expect(lua.execute_script('return n')).toBe(5);
        expect(lua.execute_script('return s')).toBe('hi');
      });

      it('throws when arguments are not both functions', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua as any).register_type_converter(null, () => {})).toThrow(/two functions/);
        expect(() => (lua as any).register_type_converter(() => true)).toThrow(/two functions/);
      });
    });
  });

  // ============================================
  // CLASS / USERTYPE BINDING (C1 + C2 + C3)
  // ============================================
  describe('class / usertype binding', () => {
    class Vec {
      constructor(public x: number, public y: number) {}
    }

    function makeVecContext() {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.register_class('Vec', {
        construct: (x, y) => new Vec(x as number, y as number),
        readable: true,
        writable: true,
        methods: {
          length: (self) => Math.hypot(self.x, self.y),
          add_in_place: (self, other) => {
            self.x += other.x;
            self.y += other.y;
            return self;
          },
          coords: (self) => [self.x, self.y],
        },
        metamethods: {
          __add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
          __eq: (a, b) => a.x === b.x && a.y === b.y,
          __lt: (a, b) => a.x * a.x + a.y * a.y < b.x * b.x + b.y * b.y,
          __le: (a, b) => a.x * a.x + a.y * a.y <= b.x * b.x + b.y * b.y,
          __unm: (a) => ({ x: -a.x, y: -a.y }),
          __tostring: (self) => `(${self.x}, ${self.y})`,
          __concat: (a, b) =>
            (typeof a === 'string' ? a : `(${a.x},${a.y})`) +
            (typeof b === 'string' ? b : `(${b.x},${b.y})`),
        },
      });
      return lua;
    }

    describe('C1 — construction', () => {
      it('constructs an instance via Class.new()', () => {
        const lua = makeVecContext();
        const [x, y] = lua.execute_script('local v = Vec.new(3, 4); return v.x, v.y');
        expect(x).toBe(3);
        expect(y).toBe(4);
      });

      it('passes constructor arguments through', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const seen: any[] = [];
        lua.register_class('Thing', {
          construct: (...args) => {
            seen.push(args);
            return { sum: (args as number[]).reduce((a, b) => a + b, 0) };
          },
          readable: true,
        });
        const r = lua.execute_script('return Thing.new(1, 2, 3).sum');
        expect(r).toBe(6);
        expect(seen[0]).toEqual([1, 2, 3]);
      });

      it('creates independent instances', () => {
        const lua = makeVecContext();
        const [ax, bx] = lua.execute_script(`
          local a = Vec.new(1, 1)
          local b = Vec.new(9, 9)
          a.x = 5
          return a.x, b.x
        `);
        expect(ax).toBe(5);
        expect(bx).toBe(9);
      });

      it('throws if the constructor does not return an object', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_class('Bad', { construct: () => 42 as any });
        expect(() => lua.execute_script('return Bad.new()')).toThrow(/must return an object/);
      });
    });

    describe('C2 — methods & properties', () => {
      it('calls instance methods with self', () => {
        const lua = makeVecContext();
        expect(lua.execute_script('return Vec.new(3, 4):length()')).toBe(5);
      });

      it('returns multiple values from a method', () => {
        const lua = makeVecContext();
        const [x, y] = lua.execute_script('return Vec.new(7, 8):coords()');
        expect(x).toBe(7);
        expect(y).toBe(8);
      });

      it('mutates instance state through a method that returns self', () => {
        const lua = makeVecContext();
        const [x, y] = lua.execute_script(`
          local v = Vec.new(1, 2)
          v:add_in_place(Vec.new(10, 20))
          return v.x, v.y
        `);
        expect(x).toBe(11);
        expect(y).toBe(22);
      });

      it('reads and writes properties', () => {
        const lua = makeVecContext();
        const [before, after] = lua.execute_script(`
          local v = Vec.new(1, 1)
          local before = v.x
          v.x = 99
          return before, v.x
        `);
        expect(before).toBe(1);
        expect(after).toBe(99);
      });

      it('methods work even when the class is not readable', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_class('Secret', {
          construct: (v) => ({ hidden: v }),
          methods: { reveal: (self) => self.hidden },
        });
        expect(lua.execute_script('return Secret.new(42):reveal()')).toBe(42);
        // property read is nil because the class is not readable
        expect(lua.execute_script('return Secret.new(42).hidden')).toBeNull();
      });
    });

    describe('C3 — operator overloading', () => {
      it('__add', () => {
        const lua = makeVecContext();
        const sum = lua.execute_script('return Vec.new(1, 2) + Vec.new(3, 4)');
        expect(sum).toEqual({ x: 4, y: 6 });
      });

      it('__tostring', () => {
        const lua = makeVecContext();
        expect(lua.execute_script('return tostring(Vec.new(3, 4))')).toBe('(3, 4)');
      });

      it('__eq', () => {
        const lua = makeVecContext();
        expect(lua.execute_script('return Vec.new(1, 2) == Vec.new(1, 2)')).toBe(true);
        expect(lua.execute_script('return Vec.new(1, 2) == Vec.new(9, 9)')).toBe(false);
      });

      it('__lt and __le', () => {
        const lua = makeVecContext();
        expect(lua.execute_script('return Vec.new(1, 1) < Vec.new(5, 5)')).toBe(true);
        expect(lua.execute_script('return Vec.new(5, 5) <= Vec.new(5, 5)')).toBe(true);
        expect(lua.execute_script('return Vec.new(9, 9) < Vec.new(1, 1)')).toBe(false);
      });

      it('__unm', () => {
        const lua = makeVecContext();
        expect(lua.execute_script('local n = -Vec.new(2, 3); return n.x, n.y')).toEqual([-2, -3]);
      });

      it('__concat', () => {
        const lua = makeVecContext();
        expect(lua.execute_script('return Vec.new(1, 2) .. "!"')).toBe('(1,2)!');
      });

      it('__len', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_class('Bag', {
          construct: (...items) => ({ items }),
          metamethods: { __len: (self) => self.items.length },
        });
        expect(lua.execute_script('return #Bag.new(10, 20, 30)')).toBe(3);
      });

      it('__call', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_class('Multiplier', {
          construct: (factor) => ({ factor }),
          metamethods: { __call: (self, n) => self.factor * n },
        });
        expect(lua.execute_script('return Multiplier.new(10)(5)')).toBe(50);
      });
    });

    describe('round-trip identity', () => {
      it('an instance passed to JS returns as the same object', () => {
        const lua = makeVecContext();
        let captured: any = null;
        lua.set_global('inspect', (v: any) => {
          captured = v;
          return v.x + v.y;
        });
        const r = lua.execute_script('local v = Vec.new(3, 4); return inspect(v)');
        expect(r).toBe(7);
        expect(captured).toBeInstanceOf(Vec);
      });

      it('an instance round-tripped through JS still works as a class instance', () => {
        const lua = makeVecContext();
        lua.set_global('echo', (v: any) => v); // returns the same instance
        const [len, str] = lua.execute_script(`
          local v = Vec.new(3, 4)
          local v2 = echo(v)
          return v2:length(), tostring(v2)
        `);
        expect(len).toBe(5);
        expect(str).toBe('(3, 4)');
      });

      it('M6: a class instance from another context is deep-copied, not aliased to a local slot', () => {
        // Both contexts mint class-ref id 1 for their first instance. Passing
        // context A's instance into context B must NOT be mistaken for B's own
        // userdata slot 1 (a cross-context identity collision) — the foreign
        // marker is ignored and the object falls through to a plain deep copy.
        const a = makeVecContext();
        const b = makeVecContext();

        // Give B its own instance first, so B's js_userdata_ slot 1 is occupied
        // by a DIFFERENT object than A's slot 1.
        b.execute_script('B_LOCAL = Vec.new(100, 200)');

        const foreign = a.execute_script('return Vec.new(3, 4)'); // A's ref id 1
        b.set_global('foreign', foreign);

        // In B, the foreign value is a plain table (deep copy), not B's Vec #1:
        // its fields survive, but it carries no class metatable/methods and is
        // not identical to B_LOCAL.
        expect(b.execute_script('return foreign.x, foreign.y')).toEqual([3, 4]);
        expect(b.execute_script('return getmetatable(foreign) == getmetatable(B_LOCAL)')).toBe(false);
        expect(b.execute_script('local ok = pcall(function() return foreign:length() end); return ok')).toBe(false);
        // B's own instance is untouched by the collision.
        expect(b.execute_script('return B_LOCAL:length()')).toBeCloseTo(Math.hypot(100, 200));
      });

      it('M6: a class instance still round-trips within its OWN context', () => {
        // The identity check must not break the normal same-context round-trip.
        const lua = makeVecContext();
        const v = lua.execute_script('return Vec.new(6, 8)');
        lua.set_global('back', v);
        expect(lua.execute_script('return back:length()')).toBe(10);
        expect(lua.execute_script('return tostring(back)')).toBe('(6, 8)');
      });
    });

    describe('multiple classes coexist', () => {
      it('keeps methods and metatables separate per class', () => {
        const lua = makeVecContext();
        lua.register_class('Counter', {
          construct: (start) => ({ n: start }),
          readable: true,
          methods: { inc: (self) => { self.n += 1; return self; } },
        });
        const [vlen, cn] = lua.execute_script(`
          local v = Vec.new(3, 4)
          local c = Counter.new(0)
          c:inc(); c:inc()
          return v:length(), c.n
        `);
        expect(vlen).toBe(5);
        expect(cn).toBe(2);
      });
    });

    describe('garbage collection', () => {
      it('reclaims instances without leaking or crashing', () => {
        const lua = makeVecContext();
        lua.execute_script(`
          for i = 1, 500 do
            local v = Vec.new(i, i)
            local _ = v:length()
          end
          collectgarbage('collect')
        `);
        // Still fully usable afterwards
        expect(lua.execute_script('return Vec.new(3, 4):length()')).toBe(5);
      });
    });

    describe('validation', () => {
      it('throws when the definition lacks a construct function', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.register_class('X', {} as any)).toThrow(/construct/);
      });

      it('throws when arguments are invalid', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua as any).register_class('X')).toThrow(/requires/);
        expect(() => (lua as any).register_class(123, {})).toThrow(/requires/);
      });
    });
  });

  // ============================================
  // ASYNCHRONOUS & CONCURRENCY INTEROP (A1 + A2 + A3)
  // ============================================
  describe('async / concurrency interop', () => {
    const sleep = <T>(ms: number, value?: T): Promise<T> =>
      new Promise((resolve) => setTimeout(() => resolve(value as T), ms));

    describe('A1 — awaiting JS promises from Lua', () => {
      it('transparently awaits a Promise returned by a host function', async () => {
        const lua = new lua_native.init(
          { fetchUser: async (id: number) => { await sleep(5); return { id, name: `User${id}` }; } },
          ALL_LIBS
        );
        const r = await lua.execute_async(`
          local u = fetchUser(7)
          return u.name
        `);
        expect(r).toBe('User7');
      });

      it('awaits multiple promises sequentially', async () => {
        const lua = new lua_native.init(
          { getN: async (n: number) => { await sleep(3); return n * 10; } },
          ALL_LIBS
        );
        const r = await lua.execute_async(`
          local a = getN(1)
          local b = getN(2)
          local c = getN(3)
          return a + b + c
        `);
        expect(r).toBe(60);
      });

      it('awaits an already-resolved Promise', async () => {
        const lua = new lua_native.init(
          { now: () => Promise.resolve(42) },
          ALL_LIBS
        );
        expect(await lua.execute_async('return now()')).toBe(42);
      });

      it('resolves undefined when the script returns nothing', async () => {
        const lua = new lua_native.init(
          { ping: async () => { await sleep(2); return true; } },
          ALL_LIBS
        );
        const r = await lua.execute_async('ping()');
        expect(r).toBeUndefined();
      });

      it('returns multiple values', async () => {
        const lua = new lua_native.init(
          { two: async () => { await sleep(2); return 2; } },
          ALL_LIBS
        );
        const [a, b] = await lua.execute_async('local x = two(); return x, x * 5');
        expect(a).toBe(2);
        expect(b).toBe(10);
      });

      it('awaits a Promise from an object method (obj:method())', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('api', {}, {
          methods: { load: async () => { await sleep(3); return 'loaded'; } },
        });
        expect(await lua.execute_async('return api:load()')).toBe('loaded');
      });

      it('awaits a Promise from a class method', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_class('Client', {
          construct: () => ({}),
          methods: { get: async (_self, id: number) => { await sleep(3); return id * 2; } },
        });
        expect(await lua.execute_async('return Client.new():get(21)')).toBe(42);
      });
    });

    describe('A2 — callbacks during async execution', () => {
      it('runs synchronous JS callbacks in async mode', async () => {
        const lua = new lua_native.init({ add: (a: number, b: number) => a + b }, ALL_LIBS);
        expect(await lua.execute_async('return add(2, 3)')).toBe(5);
      });

      it('mixes sync callbacks and awaited promises', async () => {
        const lua = new lua_native.init(
          {
            double: (n: number) => n * 2,
            fetchBase: async () => { await sleep(3); return 5; },
          },
          ALL_LIBS
        );
        const r = await lua.execute_async('return double(fetchBase())');
        expect(r).toBe(10);
      });
    });

    describe('rejections', () => {
      it('raises a rejected Promise as a Lua error catchable by pcall', async () => {
        const lua = new lua_native.init(
          { willFail: () => Promise.reject(new Error('boom')) },
          ALL_LIBS
        );
        const [ok, err] = await lua.execute_async(`
          local ok, err = pcall(function() return willFail() end)
          return ok, err.message
        `);
        expect(ok).toBe(false);
        expect(String(err)).toMatch(/boom/);
      });

      it('rejects the returned Promise on an uncaught rejection', async () => {
        const lua = new lua_native.init(
          { willFail: () => Promise.reject(new Error('kaboom')) },
          ALL_LIBS
        );
        await expect(lua.execute_async('return willFail()')).rejects.toThrow(/kaboom/);
      });

      it('rejects on a Lua runtime error', async () => {
        const lua = new lua_native.init(
          { ok: async () => { await sleep(2); return 1; } },
          ALL_LIBS
        );
        await expect(
          lua.execute_async('ok(); error("script failed")')
        ).rejects.toThrow(/script failed/);
      });

      it('rejects on a compile error', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        await expect(lua.execute_async('this is not lua !!!')).rejects.toThrow(/syntax error/);
      });

      it('rejects a top-level coroutine.yield (no resumer)', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        await expect(
          lua.execute_async('coroutine.yield(5); return 1')
        ).rejects.toThrow(/yield is not supported/);
      });
    });

    describe('synchronous execution guard', () => {
      it('throws when a Promise-returning host function is called synchronously', () => {
        const lua = new lua_native.init({ fetchThing: async () => 1 }, ALL_LIBS);
        expect(() => lua.execute_script('return fetchThing()')).toThrow(/execute_async/);
      });
    });

    describe('busy state', () => {
      it('reports busy while awaiting and clears when done', async () => {
        const lua = new lua_native.init(
          { slow: async () => { await sleep(20); return 1; } },
          ALL_LIBS
        );
        const p = lua.execute_async('return slow()');
        expect(lua.is_busy()).toBe(true);
        await p;
        expect(lua.is_busy()).toBe(false);
      });

      it('rejects/throws a second async run while one is in flight', async () => {
        const lua = new lua_native.init(
          { slow: async () => { await sleep(20); return 1; } },
          ALL_LIBS
        );
        const p = lua.execute_async('return slow()');
        expect(() => lua.execute_async('return 1')).toThrow(/busy/);
        await p;
      });

      it('is reusable after an async run completes', async () => {
        const lua = new lua_native.init(
          { val: async () => { await sleep(3); return 7; } },
          ALL_LIBS
        );
        expect(await lua.execute_async('return val()')).toBe(7);
        expect(await lua.execute_async('return val() + 1')).toBe(8);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });

    describe('A3 — cancellation', () => {
      it('cancel() rejects the in-flight run while it is awaiting', async () => {
        const lua = new lua_native.init(
          { slow: async () => { await sleep(50); return 1; } },
          ALL_LIBS
        );
        const p = lua.execute_async('local x = slow(); return x');
        // Cancel on the next tick, while the coroutine is suspended awaiting.
        await sleep(5);
        lua.cancel();
        await expect(p).rejects.toThrow(/cancelled/);
        expect(lua.is_busy()).toBe(false);
      });

      it('cancel() is a no-op when nothing is running', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.cancel()).not.toThrow();
      });

      it('is reusable after a cancellation', async () => {
        const lua = new lua_native.init(
          { slow: async () => { await sleep(50); return 1; }, fast: async () => 9 },
          ALL_LIBS
        );
        const p = lua.execute_async('return slow()');
        await sleep(5);
        lua.cancel();
        await expect(p).rejects.toThrow(/cancelled/);
        expect(await lua.execute_async('return fast()')).toBe(9);
      });
    });

    describe('concurrency across contexts', () => {
      it('runs independent contexts concurrently', async () => {
        const make = (base: number) =>
          new lua_native.init(
            { get: async () => { await sleep(10); return base; } },
            ALL_LIBS
          );
        const ctxs = [1, 2, 3, 4].map(make);
        const results = await Promise.all(
          ctxs.map((lua, i) => lua.execute_async(`return get() * ${i + 1}`))
        );
        expect(results).toEqual([1, 4, 9, 16]);
      });
    });
  });

  // ============================================
  // ERROR FIDELITY (D1 + D2 + D3)
  // ============================================
  describe('error fidelity', () => {
    describe('D2 — stack traces', () => {
      it('includes a Lua traceback in error messages', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() =>
          lua.execute_script('function foo() error("boom") end\nfoo()')
        ).toThrow(/stack traceback/);
      });

      it('shows the call chain across nested functions', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        try {
          lua.execute_script(`
            function a() error("deep") end
            function b() a() end
            function c() b() end
            c()
          `);
          throw new Error('should have thrown');
        } catch (e: any) {
          expect(e.message).toMatch(/deep/);
          expect(e.message).toMatch(/stack traceback/);
          expect(e.message).toMatch(/'a'/);
        }
      });

      it('produces tracebacks even without the debug library loaded', () => {
        const lua = new lua_native.init({}, { libraries: ['base'] });
        expect(() => lua.execute_script('error("no debug lib")')).toThrow(/stack traceback/);
      });

      it('includes a traceback for errors in returned Lua functions', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fn = lua.execute_script<Function>('return function() error("fn boom") end');
        expect(() => (fn as any)()).toThrow(/stack traceback/);
      });
    });

    describe('D1 — JS Error fidelity', () => {
      it('surfaces the original Error instance across the boundary', () => {
        const original = new Error('original message');
        const lua = new lua_native.init({ boom: () => { throw original; } }, ALL_LIBS);
        try {
          lua.execute_script('boom()');
          throw new Error('should have thrown');
        } catch (e) {
          expect(e).toBe(original);
        }
      });

      it('preserves the error name, custom properties, and subclass', () => {
        class DBError extends Error {
          code = 'E_DB';
          constructor(m: string) { super(m); this.name = 'DBError'; }
        }
        const lua = new lua_native.init({ query: () => { throw new DBError('bad query'); } }, ALL_LIBS);
        try {
          lua.execute_script('query()');
          throw new Error('should have thrown');
        } catch (e: any) {
          expect(e).toBeInstanceOf(DBError);
          expect(e.name).toBe('DBError');
          expect(e.message).toBe('bad query');
          expect(e.code).toBe('E_DB');
        }
      });

      it('exposes the JS error as a readable table inside Lua', () => {
        const lua = new lua_native.init({
          boom: () => { const e = new Error('lua sees this'); e.name = 'BoomError'; throw e; },
        }, ALL_LIBS);
        const r = lua.execute_script(`
          local ok, err = pcall(boom)
          return { ok = ok, message = err.message, name = err.name, hasStack = type(err.stack) }
        `) as any;
        expect(r.ok).toBe(false);
        expect(r.message).toBe('lua sees this');
        expect(r.name).toBe('BoomError');
        expect(r.hasStack).toBe('string');
      });

      it('preserves fidelity through a userdata method', () => {
        const original = new Error('method failure');
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('svc', {}, { methods: { call: () => { throw original; } } });
        try {
          lua.execute_script('svc:call()');
          throw new Error('should have thrown');
        } catch (e) {
          expect(e).toBe(original);
        }
      });

      it('preserves fidelity through async execution', async () => {
        const original = new Error('async failure');
        const lua = new lua_native.init(
          { boom: async () => { await Promise.resolve(); throw original; } },
          ALL_LIBS
        );
        await expect(lua.execute_async('return boom()')).rejects.toBe(original);
      });

      it('falls back to the string form for non-object throws', () => {
        const lua = new lua_native.init({ boom: () => { throw 'raw string'; } }, ALL_LIBS);
        expect(() => lua.execute_script('boom()')).toThrow(/raw string/);
      });
    });

    describe('D3 — protected calls from JS', () => {
      it('returns ok with the value on success', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const add = lua.execute_script<Function>('return function(a, b) return a + b end');
        expect(lua.pcall(add as any, 2, 3)).toEqual({ ok: true, value: 5 });
      });

      it('returns ok:false with the error on failure', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fail = lua.execute_script<Function>('return function() error("nope") end');
        const r = lua.pcall(fail as any);
        expect(r.ok).toBe(false);
        expect(String((r as any).error.message)).toMatch(/nope/);
      });

      it('preserves the original JS Error through pcall', () => {
        const original = new Error('captured');
        const lua = new lua_native.init({ boom: () => { throw original; } }, ALL_LIBS);
        const call = lua.execute_script<Function>('return function() boom() end');
        const r = lua.pcall(call as any);
        expect(r.ok).toBe(false);
        expect((r as any).error).toBe(original);
      });

      it('returns multiple Lua return values as an array', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const multi = lua.execute_script<Function>('return function() return 1, 2, 3 end');
        expect(lua.pcall(multi as any)).toEqual({ ok: true, value: [1, 2, 3] });
      });

      it('throws for a non-function argument', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua as any).pcall(42)).toThrow(/requires a function/);
      });
    });
  });

  // ============================================
  // I/O, OUTPUT & MODULE RESOLUTION (E1 + E2 + E3)
  // ============================================
  describe('I/O, output, and module resolution', () => {
    describe('E1 — output redirection', () => {
      it('captures print() output via the print option', () => {
        const out: string[] = [];
        const lua = new lua_native.init({}, { libraries: 'all', print: (t: string) => out.push(t) });
        lua.execute_script('print("hello", 42)\nprint("world")');
        expect(out).toEqual(['hello\t42\n', 'world\n']);
      });

      it('formats faithfully (tabs, newline, __tostring)', () => {
        const out: string[] = [];
        const lua = new lua_native.init({}, { libraries: 'all', print: (t: string) => out.push(t) });
        lua.execute_script(`
          local obj = setmetatable({}, { __tostring = function() return "OBJ" end })
          print(1, obj, true)
        `);
        expect(out).toEqual(['1\tOBJ\ttrue\n']);
      });

      it('redirects io.write without adding separators or a newline', () => {
        const out: string[] = [];
        const lua = new lua_native.init({}, { libraries: 'all', print: (t: string) => out.push(t) });
        lua.execute_script('io.write("a"); io.write("b", "c")');
        expect(out).toEqual(['a', 'bc']);
      });

      it('can be set and cleared at runtime via set_print_handler', () => {
        const out: string[] = [];
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_print_handler((t: string) => out.push(t));
        lua.execute_script('print("captured")');
        expect(out).toEqual(['captured\n']);
        // Clearing must not throw (output falls back to stdout).
        expect(() => lua.set_print_handler(null)).not.toThrow();
        expect(() => lua.execute_script('print("to stdout")')).not.toThrow();
      });

      it('the print option overrides a callback-provided print', () => {
        const viaOption: string[] = [];
        const viaCallback: string[] = [];
        const lua = new lua_native.init(
          { print: (...args: any[]) => viaCallback.push(args.join(',')) },
          { libraries: 'all', print: (t: string) => viaOption.push(t) }
        );
        lua.execute_script('print("x")');
        expect(viaOption).toEqual(['x\n']);
        expect(viaCallback).toEqual([]);
      });
    });

    describe('E2 — dynamic require via a JS searcher', () => {
      it('resolves a module from returned Lua source', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.add_searcher((name: string) =>
          name === 'greeter'
            ? 'return { hi = function(n) return "Hi, " .. n end }'
            : null
        );
        expect(lua.execute_script('return require("greeter").hi("Ada")')).toBe('Hi, Ada');
      });

      it('caches the module (require returns the same table)', () => {
        let calls = 0;
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.add_searcher((name: string) => {
          if (name === 'counter') { calls++; return 'return { n = 1 }'; }
          return null;
        });
        expect(lua.execute_script('return require("counter") == require("counter")')).toBe(true);
        expect(calls).toBe(1);
      });

      it('lets require fall through when the searcher returns null', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.add_searcher(() => null);
        expect(() => lua.execute_script('require("missing")')).toThrow(/module 'missing'/);
      });

      it('coexists with register_module', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_module('static', { tag: 'S' });
        lua.add_searcher((name: string) =>
          name === 'dynamic' ? 'return { tag = "D" }' : null
        );
        const [s, d] = lua.execute_script('return require("static").tag, require("dynamic").tag');
        expect(s).toBe('S');
        expect(d).toBe('D');
      });

      it('reports source errors from the searcher', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.add_searcher(() => 'this is not valid lua @@@');
        expect(() => lua.execute_script('require("bad")')).toThrow(/error loading JS module 'bad'/);
      });

      it('throws when the package library is not loaded', () => {
        const lua = new lua_native.init({}, { libraries: ['base'] });
        expect(() => lua.add_searcher(() => null)).toThrow(/package/);
      });

      it('throws for a non-function argument', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua as any).add_searcher(42)).toThrow(/requires a function/);
      });
    });

    describe('E3 — bytecode / untrusted-chunk guard', () => {
      const compiled = () => {
        const c = new lua_native.init({}, ALL_LIBS);
        return c.compile('return 42');
      };

      it('loads bytecode by default', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.load_bytecode(compiled())).toBe(42);
      });

      it('rejects load_bytecode when allowBytecode is false', () => {
        const lua = new lua_native.init({}, { libraries: 'all', allowBytecode: false });
        expect(() => lua.load_bytecode(compiled())).toThrow(/disabled/);
      });

      it('forces load() to reject binary chunks when disabled', () => {
        const lua = new lua_native.init({}, { libraries: 'all', allowBytecode: false });
        lua.set_global('bc', compiled().toString('latin1'));
        // A binary chunk fails to load (load returns nil, err).
        expect(lua.execute_script('local f = load(bc); return f == nil')).toBe(true);
      });

      it('still allows text chunks via load() when disabled', () => {
        const lua = new lua_native.init({}, { libraries: 'all', allowBytecode: false });
        expect(lua.execute_script('return load("return 7")()')).toBe(7);
      });

      // The chunk above touches no global, so it has no _ENV upvalue and cannot
      // detect that SafeLoad was handing the loader an explicit nil `env`. Lua
      // decides "was an env supplied" with lua_isnone, so an explicit nil counts
      // as supplied — every chunk that *did* touch a global got _ENV = nil the
      // moment this guard was on. Found August 6, 2026 while closing the file
      // doors below; this is the assertion the original test could not make.
      it('still allows text chunks that touch globals when disabled', () => {
        const lua = new lua_native.init({}, { libraries: 'all', allowBytecode: false });
        lua.set_global('x', 5);
        expect(lua.execute_script('return load("return x")()')).toBe(5);
      });

      // The guard was `load_bytecode` + `load` until August 6, 2026 — one class
      // short. `loadfile`, `dofile` and `require` are stock Lua C functions that
      // reach luaL_loadfilex with mode "bt", so each was an open door into the
      // undumper. The two host-side file doors were open for the same reason.
      //
      // These matter more than an ordinary refusal pin: executing untrusted
      // *source* is memory-safe and undumping untrusted *bytecode* is not, so a
      // bypass converts a conceded capability into an unconceded one.
      describe('the file doors (W1, August 6, 2026)', () => {
        const REFUSED = /binary chunk|bytecode/i;
        let dir: string;
        let luac: string;

        const gated = () =>
          new lua_native.init({}, { libraries: 'all', allowBytecode: false });

        beforeEach(() => {
          dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-e3-'));
          luac = path.join(dir, 'chunk.lua');   // .lua name, bytecode content
          fs.writeFileSync(luac, Buffer.from(compiled()));
        });

        it('refuses loadfile of a binary chunk', () => {
          expect(gated().execute_script(
            `local f, e = loadfile(${JSON.stringify(luac)}); return f == nil and e or "LOADED"`
          )).toMatch(REFUSED);
        });

        it('refuses dofile of a binary chunk', () => {
          expect(() => gated().execute_script(`dofile(${JSON.stringify(luac)})`))
            .toThrow(REFUSED);
        });

        it('refuses require of a binary chunk found on package.path', () => {
          expect(() => gated().execute_script(
            `package.path = ${JSON.stringify(path.join(dir, '?.lua'))}; require("chunk")`
          )).toThrow(REFUSED);
        });

        it('refuses require of a binary chunk found via add_search_path', () => {
          const lua = gated();
          lua.add_search_path(path.join(dir, '?.lua'));
          expect(() => lua.execute_script('require("chunk")')).toThrow(REFUSED);
        });

        it('refuses execute_file on a binary chunk', () => {
          expect(() => gated().execute_file(luac)).toThrow(REFUSED);
        });

        it('refuses compile_file on a binary chunk', () => {
          expect(() => gated().compile_file(luac)).toThrow(REFUSED);
        });

        // The sequence types.d.ts names as the reason the option exists,
        // reaching the loader by a door the option did not cover.
        it('refuses the in-VM string.dump -> io.write -> dofile route', () => {
          const written = path.join(dir, 'self.lua');
          expect(() => gated().execute_script(`
            local h = io.open(${JSON.stringify(written)}, "wb")
            h:write(string.dump(function() return "OWNED" end))
            h:close()
            dofile(${JSON.stringify(written)})
          `)).toThrow(REFUSED);
        });

        it('leaves the text paths working', () => {
          fs.writeFileSync(path.join(dir, 'textmod.lua'), 'return { hi = function() return "MOD" end }');
          fs.writeFileSync(path.join(dir, 'plain.lua'), 'return "PLAIN"');
          const lua = gated();
          expect(lua.execute_script(
            `package.path = ${JSON.stringify(path.join(dir, '?.lua'))}
             local m = require("textmod")
             return m.hi() .. "/" .. dofile(${JSON.stringify(path.join(dir, 'plain.lua'))})
                    .. "/" .. loadfile(${JSON.stringify(path.join(dir, 'plain.lua'))})()`
          )).toBe('MOD/PLAIN/PLAIN');
        });

        it('keeps dofile raising, and loadfile reporting nil + message', () => {
          const lua = gated();
          expect(lua.execute_script(
            'local f, e = loadfile("/nope/missing.lua"); return f == nil and type(e) == "string"'
          )).toBe(true);
          expect(() => lua.execute_script('dofile("/nope/missing.lua")')).toThrow(/missing\.lua/);
        });

        it('does not take back a dofile the script replaced', () => {
          expect(gated().execute_script(
            'dofile = function() return "MINE" end; return dofile()'
          )).toBe('MINE');
        });

        // The guard and the file reader both own `dofile`/`loadfile`. The reader
        // removes its overrides by identity, so wrapping them would leave a
        // reader that could never be uninstalled — CR-23 F3's failure one
        // feature over. Both orders are pinned because only one of them was
        // obviously safe.
        it('composes with a file reader installed after it', () => {
          const lua = gated();
          lua.set_file_reader((p: string) => (p === 'v.lua' ? 'return "VIRT"' : null));
          expect(lua.execute_script('return dofile("v.lua")')).toBe('VIRT');
          lua.set_file_reader(null);
          expect(lua.execute_script('return type(dofile)')).toBe('nil');
        });

        it('keeps the reader refusing bytecode when the two are composed', () => {
          const lua = gated();
          const bytes = Buffer.from(compiled()).toString('latin1');
          lua.set_file_reader(() => bytes);
          expect(() => lua.execute_script('dofile("x.lua")')).toThrow(REFUSED);
        });

        it('survives reset()', () => {
          const lua = gated();
          lua.reset();
          expect(() => lua.execute_script(`dofile(${JSON.stringify(luac)})`)).toThrow(REFUSED);
        });

        // The change is opt-in: a context that never asked for the guard keeps
        // every door it had.
        it('changes nothing when allowBytecode is left alone', () => {
          const lua = new lua_native.init({}, ALL_LIBS);
          expect(lua.execute_script(`return dofile(${JSON.stringify(luac)})`)).toBe(42);
          expect(lua.execute_file(luac)).toBe(42);
          expect(lua.compile_file(luac).length).toBeGreaterThan(0);
        });
      });
    });
  });

  // ============================================
  // CODE-REVIEW-2 REGRESSIONS
  // ============================================
  describe('code-review-2 regressions', () => {
    it('H1: cancel() from inside a host callback during execute_async settles cleanly', async () => {
      const lua: any = new lua_native.init(
        { trigger: () => { lua.cancel(); return 1; } },
        { libraries: 'safe' }
      );
      await expect(lua.execute_async('trigger(); return 42')).rejects.toThrow(/cancelled/);
      // The context must remain usable (no wedged busy state, no corruption).
      expect(lua.execute_script('return 5')).toBe(5);
      expect(lua.is_busy()).toBe(false);
    });

    it('H7: a resolved value that cannot convert rejects instead of wedging the context', async () => {
      const lua: any = new lua_native.init(
        { getBad: () => Promise.resolve(Symbol('nope')) },
        { libraries: 'safe' }
      );
      await expect(lua.execute_async('local v = getBad(); return v')).rejects.toThrow(/failed to convert awaited value/);
      expect(lua.is_busy()).toBe(false);
      expect(lua.execute_script('return 1')).toBe(1);
    });

    it('H8: a throwing print handler does not crash the process', () => {
      const lua = new lua_native.init({}, {
        libraries: 'safe',
        print: () => { throw new Error('boom'); },
      });
      // Must not abort; the throw is contained.
      expect(() => lua.execute_script('print("x")')).not.toThrow();
      expect(lua.execute_script('return 1')).toBe(1);
    });

    it('M2: resuming a finished async coroutine is impossible (state stays consistent)', async () => {
      const lua = new lua_native.init({}, { libraries: 'safe' });
      const r = await lua.execute_async('return 1 + 1');
      expect(r).toBe(2);
      expect(lua.is_busy()).toBe(false);
      // A fresh run works after completion.
      expect(await lua.execute_async('return 3')).toBe(3);
    });

    it('M4: a raising __index on the _G metatable surfaces as a JS error, not a crash', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.execute_script('setmetatable(_G, { __index = function() error("trap") end })');
      expect(() => lua.get_global('definitely_missing')).toThrow(/trap/);
      // A metatable on _G with __newindex likewise routes through protection.
      const lua2 = new lua_native.init({}, { libraries: 'all' });
      lua2.execute_script('setmetatable(_G, { __newindex = function() error("no writes") end })');
      expect(() => lua2.set_global('x', 1)).toThrow(/no writes/);
    });

    it('M4 remainder: register_function / get_global_ref / set_metatable route _G access through protection', () => {
      // set_global(name, fn) reaches RegisterFunction; a raising __newindex on
      // _G must surface as a caught error, not a process abort.
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.execute_script('setmetatable(_G, { __newindex = function() error("no writes") end })');
      expect(() => lua.set_global('fn', () => 1)).toThrow(/no writes/);

      // get_global_ref and set_metatable read _G through the protected path.
      const lua2 = new lua_native.init({}, { libraries: 'all' });
      lua2.execute_script('setmetatable(_G, { __index = function() error("trap") end })');
      expect(() => lua2.get_global_ref('definitely_missing')).toThrow(/trap/);
      expect(() => lua2.set_metatable('definitely_missing', { __index: () => 0 })).toThrow(/trap/);
    });

    it('M7: register_class rejects reserved metamethods but allows operator overloads', () => {
      const lua = new lua_native.init({}, { libraries: 'safe' });
      for (const reserved of ['__gc', '__index', '__newindex', '__name']) {
        expect(() =>
          lua.register_class('Bad', {
            construct: () => ({}),
            metamethods: { [reserved]: () => {} },
          })
        ).toThrow(/reserved/);
      }
      // A non-reserved metamethod is accepted and dispatches to JS.
      lua.register_class('Vec', {
        construct: (x: number) => ({ x }),
        readable: true,
        metamethods: { __tostring: (self: any) => `vec(${self.x})` },
      });
      expect(lua.execute_script('return tostring(Vec.new(3))')).toBe('vec(3)');
    });

    it('M9: 2^63 no longer wraps to a negative 64-bit integer', () => {
      const lua = new lua_native.init({}, { libraries: 'safe' });
      lua.set_global('x', Math.pow(2, 63)); // exactly 2^63
      expect(lua.execute_script('return x > 0')).toBe(true);
    });

    it('L1: re-enabling bytecode unwraps the text-only load() shim', () => {
      const lua = new lua_native.init({}, { libraries: 'all', allowBytecode: false });
      const bc = lua.compile('return 21');
      // Disabled: in-script load of a binary chunk fails.
      lua.set_global('bc', bc.toString('latin1'));
      expect(lua.execute_script('return load(bc) == nil')).toBe(true);
      // (Text load still works while disabled.)
      expect(lua.execute_script('return load("return 7")()')).toBe(7);
    });

    it('L2: numeric-looking keys with whitespace or sign stay distinct string keys', () => {
      const lua = new lua_native.init({}, { libraries: 'all' });
      const t = lua.create_table();
      t.set(12, 'integer-12');   // integer key 12
      t.set(' 12', 'string-12'); // must NOT alias integer key 12
      t.set('+12', 'plus-12');   // must NOT alias integer key 12 either
      expect(t.get(12)).toBe('integer-12');
      expect(t.get(' 12')).toBe('string-12');
      expect(t.get('+12')).toBe('plus-12');
      t.release();
    });
  });

  // ============================================
  // DEFERRED-REVIEW FINDINGS (docs/reviews/CODE-REVIEW-LEDGER.md)
  // ============================================
  describe('deferred-review regressions', () => {
    it('L6: the hidden __luaFnOwner on a returned Lua function cannot be deleted or reassigned', () => {
      const lua = new lua_native.init({}, { libraries: 'safe' });
      const fn: any = lua.execute_script('return function(a, b) return a + b end');
      // Non-configurable: delete throws in strict mode (this file is an ES module).
      expect(() => { delete fn.__luaFnOwner; }).toThrow(/Cannot delete property '__luaFnOwner'/);
      // Non-writable: reassigning throws too — neither vector can free the
      // backing data out from under the still-callable function.
      expect(() => { fn.__luaFnOwner = null; }).toThrow(/read only property '__luaFnOwner'/);
      // The function still works and the owner is intact.
      expect(fn(2, 3)).toBe(5);
    });

    it('L6: a class instance marker cannot be deleted but re-tagging (pooled object) still works', () => {
      const lua: any = new lua_native.init({}, { libraries: 'all' });
      const pooled = { x: 1 };
      lua.register_class('Pool', {
        construct: () => pooled, // returns the SAME object every time
        readable: true,
      });
      const a = lua.execute_script('return Pool.new()');
      // Marker is non-configurable (delete throws) ...
      expect(() => { delete a.__luaClassRef; }).toThrow(/Cannot delete property '__luaClassRef'/);
      // ... but re-tagging the pooled object with a fresh ref must still succeed
      // (writable:true), not throw a "redefine non-configurable" error.
      expect(() => lua.execute_script('return Pool.new()')).not.toThrow();
    });

    it('M1: awaiting a JS promise inside a user coroutine is rejected, not silently mis-resumed', async () => {
      const lua: any = new lua_native.init(
        { fetchThing: async () => 42 },
        { libraries: 'all' }
      );
      // The await happens inside a coroutine.create'd thread — not the driver.
      await expect(lua.execute_async(`
        local co = coroutine.create(function() return fetchThing() end)
        local ok, err = coroutine.resume(co)
        if not ok then error(err) end
        return err
      `)).rejects.toThrow(/coroutine this run is not driving/);
      // Context is not wedged.
      expect(lua.is_busy()).toBe(false);
      expect(lua.execute_script('return 1')).toBe(1);
    });

    it('M1: a top-level await still works (guard does not break the normal path)', async () => {
      const lua = new lua_native.init(
        { fetchThing: async () => 42 },
        { libraries: 'all' }
      );
      expect(await lua.execute_async('return fetchThing() + 1')).toBe(43);
    });

    it('M12: a thrown JS searcher does not leave a stale error to be mis-raised by a later host call', () => {
      const lua: any = new lua_native.init(
        { boom: () => { throw new Error('later unrelated failure'); } },
        { libraries: 'all' }
      );
      lua.add_searcher(() => { throw new Error('searcher exploded'); });
      // First: a require whose searcher throws.
      expect(() => lua.execute_script("require('anything')")).toThrow(/searcher/);
      // Then: an unrelated host call throws WITHOUT staging a structured error.
      // It must surface ITS OWN message, not the stale searcher error.
      let caught: any;
      try { lua.execute_script('boom()'); } catch (e) { caught = e; }
      expect(caught?.message).toContain('later unrelated failure');
      expect(caught?.message).not.toContain('searcher exploded');
    });

    it('L5: a promise whose then() fires both callbacks settles once and does not corrupt the run', async () => {
      // A spec-violating Promise subclass whose then() invokes the settlement
      // callbacks multiple times (and both of them). napi_is_promise recognizes
      // it, so the await machinery attaches its callbacks — and must honor only
      // the first settlement, ignoring the rest without a use-after-free of the
      // cookie freed on first settlement in the old code.
      class EvilPromise<T> extends Promise<T> {
        then(onF?: any, onR?: any): any {
          onF?.(7);                       // first settlement wins
          onF?.(8);                       // duplicate — must be ignored
          onR?.(new Error('late reject')); // sibling — must be ignored
          return this;
        }
      }
      const lua: any = new lua_native.init(
        { weird: () => new EvilPromise<number>((resolve) => resolve(0)) },
        { libraries: 'all' }
      );
      expect(await lua.execute_async('return weird() + 1')).toBe(8);
      expect(lua.is_busy()).toBe(false);
      // Still usable afterwards (no corruption / no wedged busy state).
      expect(await lua.execute_async('return 100')).toBe(100);
    });

    it('M11: constructing many class instances in a loop stays correct (HandleScope smoke test)', () => {
      const lua: any = new lua_native.init({}, { libraries: 'all' });
      let count = 0;
      lua.register_class('Widget', {
        construct: () => { count++; return { id: count }; },
        readable: true,
      });
      const total = lua.execute_script(`
        local sum = 0
        for i = 1, 5000 do sum = sum + Widget.new().id end
        return sum
      `);
      expect(count).toBe(5000);
      expect(total).toBe((5000 * 5001) / 2);
    });

    it('L8: cancel() aborts a compute-bound worker run when maxInstructions is set', async () => {
      const lua: any = new lua_native.init({}, {
        libraries: 'safe',
        maxInstructions: 5_000_000_000, // high enough not to trip on its own quickly
      });
      const p = lua.execute_script_async('while true do end');
      // Signal cancellation; the count-hook polls it and aborts the VM loop.
      setTimeout(() => lua.cancel(), 20);
      await expect(p).rejects.toThrow(/cancelled|instruction limit/);
      // The cancel flag was cleared, so a fresh run is not pre-aborted.
      expect(await lua.execute_script_async('return 1 + 1')).toBe(2);
      expect(lua.is_busy()).toBe(false);
    });

    it('M5: create_table exceeding maxMemory throws instead of aborting the process', () => {
      const lua = new lua_native.init({}, { maxMemory: 512 * 1024 });
      // A direct API call (no surrounding script pcall) that allocates past the
      // limit. Before the fix this panicked → process abort; now it throws.
      const big = new Array(300000).fill(0).map((_, i) => i);
      expect(() => lua.create_table(big)).toThrow(/memory/i);
      // Context is not corrupted — small direct-API operations still work.
      const t = lua.create_table({ ok: true });
      expect(t.get('ok')).toBe(true);
      t.release();
    });

    it('M5: registering a JS function past the limit throws instead of aborting', () => {
      // Fill most of the budget, then register a function (RegisterFunction) via
      // the direct set_global API — the allocation is now protected.
      const lua: any = new lua_native.init({}, { libraries: 'all', maxMemory: 900 * 1024 });
      lua.execute_script("blob = string.rep('x', 400 * 1024)");
      let threw = false;
      try {
        // Register many functions to push allocation over the remaining budget.
        for (let i = 0; i < 100000; i++) lua.set_global('f' + i, () => i);
      } catch (e: any) {
        threw = true;
        expect(String(e.message)).toMatch(/memory/i);
      }
      expect(threw).toBe(true);
      // Still usable (no abort, no wedged state).
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });
  });

  // ============================================
  // CODE-REVIEW-5 REGRESSIONS
  // ============================================
  describe('code-review-5 regressions', () => {
    // --- F1: reclaimable callbacks stranded by a discarded sibling conversion

    it('F1: a failed multi-argument call does not strand callback entries', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('function takesTwo(a, b) return 1 end');
      const fn = lua.get_global('takesTwo');
      // Second argument fails to convert AFTER the first (containing a nested
      // JS function) has already been registered as a reclaimable callback.
      for (let i = 0; i < 200; i++) {
        expect(() => fn({ cb: () => 1 }, Symbol('bad'))).toThrow(/Symbol/);
      }
      // The context stays healthy and callbacks still work afterwards.
      expect(fn(1, 2)).toBe(1);
      lua.set_global('later', { cb: () => 7 });
      expect(lua.execute_script('return later.cb()')).toBe(7);
    });

    it('F1: set_metatable on a missing global discards entries cleanly', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      // The entries convert successfully; the core call then rejects because the
      // target global does not exist, discarding every converted entry.
      for (let i = 0; i < 200; i++) {
        expect(() => lua.set_metatable('noSuchGlobal', { payload: { cb: () => 1 } }))
          .toThrow(/does not exist/);
      }
      lua.execute_script('t = {}');
      lua.set_metatable('t', { __index: () => 'hit' });
      expect(lua.execute_script('return t.anything')).toBe('hit');
    });

    it('F1: a failed create_table discards converted elements cleanly', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      for (let i = 0; i < 200; i++) {
        expect(() => lua.create_table({ good: { cb: () => 1 }, bad: Symbol('x') }))
          .toThrow(/Symbol/);
      }
      const t = lua.create_table({ ok: 1 });
      expect(t.get('ok')).toBe(1);
    });

    // --- F5: register_class hardening

    it('F5: a hostile getter cannot re-enter register_class for the same name', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      let reentered: string | null = null;
      const def: any = { construct: () => ({ v: 1 }), methods: { get() { return 1; } } };
      Object.defineProperty(def, 'readable', {
        enumerable: true,
        get() {
          // Reentrant registration of the SAME name must be rejected: the outer
          // call reserved it before reading any property.
          try {
            lua.register_class('Reentrant', { construct: () => ({ v: 2 }) });
            reentered = 'succeeded';
          } catch (e: any) {
            reentered = e.message;
          }
          return true;
        },
      });
      lua.register_class('Reentrant', def);
      expect(reentered).toMatch(/already registered/);
      // The outer definition is the one that took effect, un-merged.
      expect(lua.execute_script('local r = Reentrant.new(); return r:get()')).toBe(1);
    });

    it('F5: a rejected definition releases the class name for retry', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.register_class('Retry', {
        construct: () => ({}),
        metamethods: { __gc: () => {} },
      })).toThrow(/reserved/);
      // The failed attempt must not leave the name reserved.
      lua.register_class('Retry', { construct: () => ({ v: 5 }), methods: { get() { return 5; } } });
      expect(lua.execute_script('local r = Retry.new(); return r:get()')).toBe(5);
    });

    it('F5: construct is read once and a non-function is rejected', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      let reads = 0;
      const def: any = { methods: {} };
      Object.defineProperty(def, 'construct', {
        enumerable: true,
        get() { reads++; return reads === 1 ? 'not a function' : () => ({}); },
      });
      expect(() => lua.register_class('Hostile2', def)).toThrow(/construct/);
      expect(reads).toBe(1);
    });

    // --- F11: RegisterClass core failure must surface, not abort

    it('F11: a class registration that exhausts memory throws instead of aborting', () => {
      const lua: any = new lua_native.init({}, { libraries: 'all', maxMemory: 900 * 1024 });
      lua.execute_script("blob = string.rep('x', 400 * 1024)");
      let threw = false;
      try {
        for (let i = 0; i < 20000; i++) {
          lua.register_class('C' + i, { construct: () => ({}), methods: { m() { return 1; } } });
        }
      } catch (e: any) {
        threw = true;
        expect(String(e.message)).toMatch(/memory/i);
      }
      // Reaching here at all is the point: before the fix, RegisterClass's
      // std::runtime_error unwound through the N-API boundary and terminated
      // the process instead of surfacing as a catchable JS error.
      expect(threw).toBe(true);
      // The context object is still responsive. (The budget stays exhausted
      // afterwards — a hard maxMemory ceiling legitimately leaves no headroom
      // to even compile a recovery chunk — so query it without allocating.)
      expect(typeof lua.get_memory_usage()).toBe('number');
      // A fresh context is unaffected: no global/process state was corrupted.
      const other: any = new lua_native.init({}, ALL_LIBS);
      other.register_class('AfterOom', { construct: () => ({ v: 3 }), methods: { get() { return 3; } } });
      expect(other.execute_script('local a = AfterOom.new(); return a:get()')).toBe(3);
    });

    // --- Coverage gap: the busy guard on synchronous entry points

    it('rejects synchronous calls and table-handle use while a worker runs', async () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('shared = {v = 1}');
      const handle = lua.get_global_ref('shared');
      const pending = lua.execute_script_async('local s = 0 for i = 1, 4000000 do s = s + i end return s');
      expect(lua.is_busy()).toBe(true);
      // Every synchronous entry point must refuse while the worker owns the state.
      expect(() => lua.execute_script('return 1')).toThrow(/busy/i);
      expect(() => lua.set_global('x', 1)).toThrow(/busy/i);
      expect(() => lua.get_global('shared')).toThrow(/busy/i);
      expect(() => lua.create_table({})).toThrow(/busy/i);
      expect(() => lua.register_class('Nope', { construct: () => ({}) })).toThrow(/busy/i);
      // Table handles obtained before the run must refuse too.
      expect(() => handle.get('v')).toThrow(/busy/i);
      expect(() => handle.set('v', 2)).toThrow(/busy/i);
      await pending;
      // Everything works again once the worker finishes.
      expect(lua.is_busy()).toBe(false);
      expect(handle.get('v')).toBe(1);
      expect(lua.execute_script('return 1')).toBe(1);
    });

    // --- Coverage gap: coroutine argument validation

    it('validates create_coroutine and resume arguments', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.create_coroutine()).toThrow(/Expected a script string that returns a function, or a Lua function/);
      expect(() => lua.create_coroutine(42)).toThrow(/Expected a script string that returns a function, or a Lua function/);
      expect(() => lua.resume()).toThrow(/Expected a coroutine object as first argument/);
      expect(() => lua.resume(42)).toThrow(/Expected a coroutine object as first argument/);
      expect(() => lua.resume({})).toThrow(/coroutine/i);
      expect(() => lua.resume({ _coroutine: 'not-an-external' })).toThrow(/coroutine/i);
    });

    // --- Coverage gap: non-primitive arguments to a returned Lua function

    it('passes tables, arrays, and callbacks to a Lua function from JS', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(`
        function inspect(tbl, arr, cb)
          return tbl.name .. ':' .. #arr .. ':' .. cb(arr[1])
        end
      `);
      const inspect = lua.get_global('inspect');
      const result = inspect({ name: 'x' }, [10, 20, 30], (n: number) => n * 2);
      expect(result).toBe('x:3:20');
      // Nested structures round-trip too.
      lua.execute_script('function depth(t) return t.a.b.c end');
      expect(lua.get_global('depth')({ a: { b: { c: 'deep' } } })).toBe('deep');
    });
  });

  // ============================================
  // CODE-REVIEW-6 REGRESSIONS
  // ============================================
  describe('code-review-6 regressions', () => {
    // --- F1: a std::runtime_error from a RunProtected-backed core call must not
    // unwind across the N-API boundary and terminate the process. Every binding
    // method that reaches such a core call is exercised here with a raising
    // __newindex on a _G metatable; each must throw a catchable JS error and the
    // process must survive to run the next assertion. (Before the fix,
    // set_userdata and set_print_handler aborted with SIGABRT.)

    // Arms a _G.__newindex that raises on any global write, then returns the ctx.
    const withHostileG = () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      // Clear print first so the print-redirection reassignment hits __newindex
      // (assigning an existing key goes through rawset-like paths otherwise).
      lua.execute_script(
        "print = nil; setmetatable(_G, { __newindex = function() error('boom') end })");
      return lua;
    };

    it('F1: set_userdata (opaque) throws instead of aborting', () => {
      const lua = withHostileG();
      expect(() => lua.set_userdata('h', { x: 1 })).toThrow(/boom/);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    it('F1: set_userdata (proxy) throws instead of aborting', () => {
      const lua = withHostileG();
      expect(() => lua.set_userdata('h', { x: 1 }, { readable: true, writable: true }))
        .toThrow(/boom/);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    it('F1: set_userdata (methods) throws instead of aborting', () => {
      const lua = withHostileG();
      expect(() => lua.set_userdata('h', { x: 1 }, { methods: { m() { return 1; } } }))
        .toThrow(/boom/);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    it('F1: set_print_handler throws instead of aborting', () => {
      const lua = withHostileG();
      expect(() => lua.set_print_handler(() => {})).toThrow(/boom/);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    it('F1: the already-guarded _G-writing siblings still throw cleanly', () => {
      // These pass pre-fix too; included so the matrix covers the sibling entry
      // points whose RunProtected-backed core call writes _G (so the hostile
      // __newindex fires): the raising metamethod must surface as a catchable
      // JS error, never an abort.
      let lua = withHostileG();
      expect(() => lua.set_global('x', 1)).toThrow(/boom/);
      lua = withHostileG();
      expect(() => lua.register_class('C', { construct: () => ({}) })).toThrow(/boom/);
      // set_metatable validates the target global before writing, so a raising
      // __newindex isn't reached here — but it must still surface as a throw,
      // not an abort.
      lua = withHostileG();
      expect(() => lua.set_metatable('missing', { __index: () => 1 })).toThrow(/Global 'missing' does not exist/);
    });

    it('F1: a rejected set_userdata strands no state (name is reusable)', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(
        "setmetatable(_G, { __newindex = function() error('boom') end })");
      expect(() => lua.set_userdata('h', { x: 1 }, { methods: { m() { return 1; } } }))
        .toThrow(/boom/);
      // Remove the hostile metatable and retry: the ref_id / callback entries
      // from the failed attempt must not interfere with a clean registration.
      lua.execute_script('setmetatable(_G, nil)');
      lua.set_userdata('h', { x: 42 }, { readable: true });
      expect(lua.execute_script('return h.x')).toBe(42);
    });
  });

  // ============================================
  // CODE-REVIEW-7 REGRESSIONS
  // ============================================
  describe('code-review-7 regressions', () => {
    // --- F1: the await-settlement callbacks carry a raw LuaContext*; a promise
    // settling after cancel() tore the run down and GC collected the context
    // dereferenced freed memory (use-after-free -> process abort). The cookie
    // now carries the context's shared liveness flag and discards the late
    // settlement. Requires --expose-gc, which the harness must provide
    // (vitest.config.ts execArgv for npm test; run-sanitized-ts.js passes it
    // process-wide for the threads pool). If it is missing, the harness
    // plumbing has rotted — fail loudly instead of silently skipping the pin
    // on the use-after-free class (CR-8 F2).
    it('F1: a promise settling after cancel() and context GC is discarded, not a use-after-free', async () => {
      if (typeof global.gc !== 'function') {
        throw new Error(
          'global.gc unavailable: the harness must provide --expose-gc ' +
          '(vitest.config.ts / run-sanitized-ts.js) — refusing to silently skip');
      }
      let settle: ((v: unknown) => void) | undefined;
      const start = () => {
        const lua: any = new lua_native.init(
          { slow: () => new Promise((res) => { settle = res; }) }, ALL_LIBS);
        lua.execute_async('return slow()').catch(() => {});
        lua.cancel(); // tears the run down; the settlement callbacks stay on the promise
      };
      start(); // the context is unreferenced past this point
      await new Promise((r) => setTimeout(r, 10));
      global.gc();
      await new Promise((r) => setTimeout(r, 10));
      global.gc();
      settle!(42); // late settlement onto the collected context
      await new Promise((r) => setTimeout(r, 20));
      expect(1 + 1).toBe(2); // process survived: the stale settlement was discarded
    });

    // --- F2: a user-influenced `then` (own property or patched prototype) that
    // throws — or isn't callable — must reject the run's promise instead of
    // unwinding mid-drive and wedging the context busy forever.
    it('F2: a promise with a throwing own `then` rejects the run instead of wedging the context', async () => {
      const lua: any = new lua_native.init({
        bad: () => {
          const p = new Promise(() => {});
          Object.defineProperty(p, 'then', {
            value: () => { throw new Error('hostile then'); },
          });
          return p;
        },
      }, ALL_LIBS);
      await expect(lua.execute_async('return bad()')).rejects.toThrow(/hostile then/);
      expect(lua.is_busy()).toBe(false);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    it('F2: a promise whose own `then` is not callable rejects cleanly', async () => {
      const lua: any = new lua_native.init({
        bad: () => {
          const p = new Promise(() => {});
          Object.defineProperty(p, 'then', { value: 42 });
          return p;
        },
      }, ALL_LIBS);
      await expect(lua.execute_async('return bad()')).rejects.toThrow(/no callable 'then'/);
      expect(lua.is_busy()).toBe(false);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    // --- F3: when set_userdata's global write succeeds but a later build step
    // OOMs, the rollback must remove the installed global too — pre-fix it
    // stayed behind as an inert proxy (reads nil, writes dropped). Walk the
    // OOM boundary byte-by-byte and assert no failing registration ever leaves
    // the global bound.
    it('F3: a set_userdata that fails mid-build removes the partially-installed global', () => {
      const LIMIT = 200000;
      const attempt = (pad: number): string => {
        const lua: any = new lua_native.init(
          {}, { libraries: ['base', 'string'], maxMemory: LIMIT });
        try {
          lua.execute_script(`pad = string.rep('x', ${pad})`);
        } catch { return 'pad-failed'; }
        try {
          lua.set_userdata('h', { x: 1 }, {
            readable: true,
            methods: { a() {}, b() {}, c() {}, d() {}, e() {}, f() {}, g() {} },
          });
          return 'ok';
        } catch {
          let t: unknown;
          try { t = lua.execute_script('return type(h)'); } catch { return 'unqueryable'; }
          return t === 'nil' ? 'clean' : `split:${t}`;
        }
      };
      // Coarse: find the last limit where registration succeeds outright.
      let lastOk = -1;
      let firstFail = -1;
      for (let pad = 0; pad < LIMIT; pad += 1024) {
        const r = attempt(pad);
        if (r === 'ok') lastOk = pad;
        else if (lastOk >= 0) { firstFail = pad; break; }
      }
      if (firstFail < 0) return; // could not provoke the OOM window on this platform
      // Fine: every failing registration across the boundary must leave the
      // global unbound ('clean'), never the pre-fix inert proxy ('split:...').
      for (let pad = lastOk; pad <= firstFail; pad += 1) {
        const r = attempt(pad);
        expect(['ok', 'clean', 'pad-failed', 'unqueryable']).toContain(r);
      }
    });

    // --- F4: add_searcher registered its callback pair before the core call,
    // so a failure (no package library) stranded a pinned FunctionReference and
    // a host_functions_ entry per attempt. Now the core call runs first.
    it('F4: a failed add_searcher throws, strands nothing, and later registration still works', () => {
      const lua: any = new lua_native.init({}, { libraries: ['base'] }); // no package
      for (let i = 0; i < 3; i++) {
        expect(() => lua.add_searcher(() => null)).toThrow(/package/);
      }
      expect(lua.execute_script('return 1 + 1')).toBe(2);
      // A context WITH package registers and resolves through a searcher.
      const lua2: any = new lua_native.init({}, ALL_LIBS);
      lua2.add_searcher((name: string) => (name === 'virt' ? 'return 7' : null));
      // require returns (module, loaderdata); take just the module.
      expect(lua2.execute_script("local m = require('virt'); return m")).toBe(7);
    });
  });

  // ============================================
  // CODE-REVIEW-8 REGRESSIONS
  // ============================================
  describe('code-review-8 regressions', () => {
    /** Two GC passes with settle gaps. Asserts the harness provides gc first:
     *  a GC-lifetime pin must fail loudly, never silently skip (CR-8 F2). */
    const gcSettle = async () => {
      expect(typeof global.gc, 'harness must provide --expose-gc').toBe('function');
      await new Promise((r) => setTimeout(r, 10));
      global.gc!();
      await new Promise((r) => setTimeout(r, 10));
      global.gc!();
    };

    // --- F2: Vitest 4 removed test.poolOptions, silently disarming the
    // --expose-gc plumbing (and with it the CR-7 F1 use-after-free pin). The
    // config now uses top-level execArgv; this test rots loudly if the
    // plumbing ever breaks again.
    it('F2: the harness exposes global.gc (GC-lifetime pins must never silently skip)', () => {
      expect(typeof global.gc).toBe('function');
    });

    // --- F1: the rejection path of the await-settlement handler read
    // message/toString/name/stack off the rejection value unguarded; a value
    // whose coercion throws (a Symbol, a null-prototype object) unwound into
    // the reaction job — an unhandled rejection (process exit by default) with
    // the run wedged busy and its promise never settled. Now the extraction is
    // guarded and falls back to a generic message.
    it('F1: a promise rejecting with a Symbol rejects the run instead of crashing or wedging', async () => {
      const lua: any = new lua_native.init(
        { slow: () => Promise.reject(Symbol('boom')) }, ALL_LIBS);
      await expect(lua.execute_async('return slow()'))
        .rejects.toThrow(/rejection value could not be converted/);
      expect(lua.is_busy()).toBe(false);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    it('F1: a promise rejecting with a null-prototype object rejects the run instead of crashing or wedging', async () => {
      const lua: any = new lua_native.init(
        { slow: () => Promise.reject(Object.create(null)) }, ALL_LIBS);
      await expect(lua.execute_async('return slow()'))
        .rejects.toThrow(/rejection value could not be converted/);
      expect(lua.is_busy()).toBe(false);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    // --- F3: set_metatable / register_module / register_class registered their
    // function-valued js_callbacks_/host_functions_ pairs before the core call,
    // so a failing call (a typo'd global, a missing package library, a raising
    // _G metamethod) stranded them forever — each failed attempt pinned the JS
    // closures. The pairs are now registered only after the core call succeeds;
    // a failed call must leave the closures collectable.
    it('F3: a failed set_metatable strands no callback, and the same call then succeeds', async () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      const wr = (() => {
        const fn = () => 42;
        const ref = new WeakRef(fn);
        expect(() => lua.set_metatable('no_such_global', { __index: fn }))
          .toThrow(/does not exist/);
        return ref;
      })();
      await gcSettle();
      expect(wr.deref()).toBeUndefined();
      // The identical registration against an existing global still works.
      lua.execute_script('target = {}');
      lua.set_metatable('target', { __index: () => 'via_mt' });
      expect(lua.execute_script('return target.anything')).toBe('via_mt');
    });

    it('F3: a failed register_module strands no callback, and a package-enabled context registers', async () => {
      const lua: any = new lua_native.init({}, { libraries: ['base'] }); // no package
      const wr = (() => {
        const fn = () => 'mod';
        const ref = new WeakRef(fn);
        expect(() => lua.register_module('m', { f: fn })).toThrow(/package/);
        return ref;
      })();
      await gcSettle();
      expect(wr.deref()).toBeUndefined();
      const lua2: any = new lua_native.init({}, ALL_LIBS);
      lua2.register_module('m', { f: () => 9 });
      expect(lua2.execute_script("return require('m').f()")).toBe(9);
    });

    it('F3: a failed register_class strands neither constructor nor methods, and a retry works', async () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(
        'setmetatable(_G, { __newindex = function() error("no writes") end })');
      const [wrCtor, wrMethod] = (() => {
        const ctor = () => ({});
        const method = () => 1;
        const refs = [new WeakRef<object>(ctor), new WeakRef<object>(method)] as const;
        expect(() => lua.register_class('Foo', { construct: ctor, methods: { m: method } }))
          .toThrow(/no writes/);
        return refs;
      })();
      await gcSettle();
      expect(wrCtor.deref()).toBeUndefined();
      expect(wrMethod.deref()).toBeUndefined();
      // Disarm the hostile metatable: the reservation was rolled back, so the
      // same class name registers cleanly and instances work.
      lua.execute_script('setmetatable(_G, nil)');
      lua.register_class('Foo', {
        construct: () => ({ v: 5 }),
        methods: { get: (self: any) => self.v },
      });
      expect(lua.execute_script('local o = Foo.new(); return o:get()')).toBe(5);
    });

    // --- F4: the worker-async OnOK marshalled results unguarded; a result that
    // cannot cross to JS (here: a Lua string exceeding V8's maximum string
    // length) unwound as an uncaughtException with the promise never settled.
    // Now it rejects and the context stays usable. (Allocates ~1.2 GB
    // transiently — in line with the suite's other stress cases. The explicit
    // timeout is for the sanitizer harness, where the instrumented allocator
    // makes the 600 MB rep much slower than the 5 s default.)
    it('F4: a worker result too large for a JS string rejects instead of an uncaughtException', async () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      await expect(lua.execute_script_async('return string.rep("a", 600 * 1024 * 1024)'))
        .rejects.toThrow(/failed to convert async result/);
      expect(lua.is_busy()).toBe(false);
      expect(lua.execute_script('return 2 + 2')).toBe(4);
    }, 120_000);

    // --- F5: the table-handle methods lacked the CallScope the Proxy traps
    // got (L7/L3), so a js_error_registry_ entry staged by a raising __index
    // host callback stayed pinned until some unrelated entry point ran. Each
    // handle call now clears stale entries at its outermost CallScope.
    it('F5: table-handle methods clear stale staged JS errors (CallScope on the handle surface)', async () => {
      const refs: WeakRef<Error>[] = [];
      const lua: any = new lua_native.init({
        boom: () => {
          const e = new Error('boom ' + refs.length);
          refs.push(new WeakRef(e));
          throw e;
        },
      }, ALL_LIBS);
      lua.execute_script(
        't = setmetatable({}, { __index = function() return boom() end })');
      const handle = lua.get_global_ref('t');
      expect(() => handle.get('x')).toThrow(/boom 0/); // stages refs[0]
      expect(() => handle.get('y')).toThrow(/boom 1/); // its CallScope clears refs[0], stages refs[1]
      await gcSettle();
      expect(refs[0].deref()).toBeUndefined();
    });
  });

  // ============================================
  // REFERENCE LIFECYCLE — lua.release()
  // ============================================
  describe('reference lifecycle - lua.release()', () => {
    describe('Lua functions', () => {
      it('calling a released function throws a clear error', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fn: any = lua.execute_script('return function(x) return x * 2 end');
        expect(fn(21)).toBe(42);
        lua.release(fn);
        expect(() => fn(21)).toThrow('Lua function has been released');
      });

      it('double release is a no-op', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fn: any = lua.execute_script('return function() return 1 end');
        lua.release(fn);
        expect(() => lua.release(fn)).not.toThrow();
      });

      it('pcall on a released function reports the release error', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fn: any = lua.execute_script('return function() return 1 end');
        lua.release(fn);
        const result = lua.pcall(fn);
        expect(result.ok).toBe(false);
        expect(String((result as { ok: false; error: unknown }).error))
          .toContain('Lua function has been released');
      });

      it('a released function passed back into Lua fails when called from Lua', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fn: any = lua.execute_script('return function() return 5 end');
        lua.release(fn);
        lua.set_global('released_fn', fn);
        expect(() => lua.execute_script('return released_fn()')).toThrow(/released/);
      });

      it('other references to the same Lua function are unaffected', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('shared = function() return 7 end');
        const a: any = lua.execute_script('return shared');
        const b: any = lua.execute_script('return shared');
        lua.release(a);
        expect(() => a()).toThrow('released');
        expect(b()).toBe(7); // independent registry slot
      });

      it('releasing a plain JS function throws a TypeError', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.release((() => 1) as any)).toThrow('not a Lua function');
      });

      it('rejects a function belonging to a different context', () => {
        const luaA = new lua_native.init({}, ALL_LIBS);
        const luaB = new lua_native.init({}, ALL_LIBS);
        const fn: any = luaA.execute_script('return function() return 1 end');
        expect(() => luaB.release(fn)).toThrow('different Lua context');
        expect(fn()).toBe(1); // untouched
      });
    });

    describe('coroutines', () => {
      it('resuming a released coroutine throws a clear error', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const coro = lua.create_coroutine(`
          return function()
            coroutine.yield(1)
            return 2
          end
        `);
        lua.release(coro);
        expect(() => lua.resume(coro)).toThrow('coroutine has been released');
      });

      it('release after partial consumption, and double release is a no-op', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const coro = lua.create_coroutine('return function() coroutine.yield(1) return 2 end');
        expect(lua.resume(coro).values).toEqual([1]);
        lua.release(coro);
        expect(() => lua.release(coro)).not.toThrow();
        expect(() => lua.resume(coro)).toThrow('released');
      });
    });

    describe('table references', () => {
      it('releases a table handle (equivalent to handle.release())', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table({ x: 1 });
        lua.release(t);
        expect(() => t.get('x')).toThrow('released');
        expect(() => lua.release(t)).not.toThrow(); // double release no-op
      });

      it('releases a metatabled-table Proxy; later use throws', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const proxy: any = lua.execute_script(`
          return setmetatable({ n = 1 }, { __index = function() return 7 end })
        `);
        expect(proxy.n).toBe(1);
        lua.release(proxy);
        expect(() => proxy.n).toThrow('table handle has been released');
        expect(() => { proxy.n = 2; }).toThrow('table handle has been released');
        expect(() => Object.keys(proxy)).toThrow('table handle has been released');
        expect(() => lua.set_global('back', proxy)).toThrow('table handle has been released');
      });
    });

    describe('validation', () => {
      it('throws for values that hold no Lua reference', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.release({} as any)).toThrow('requires a Lua function');
        expect(() => lua.release(42 as any)).toThrow('requires a Lua function');
        expect(() => (lua as any).release()).toThrow('requires a Lua function');
      });
    });

    describe('memory reclamation', () => {
      it('released function refs let Lua GC reclaim their closures', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fns: any[] = [];
        for (let i = 0; i < 500; i++) {
          // Each closure pins a distinct 4KB string (long strings are not
          // interned) so the drop after release is unambiguous.
          fns.push(lua.execute_script(`
            local payload = string.rep('${i % 10}', 4096)
            return function() return payload end
          `));
        }
        lua.execute_script('collectgarbage("collect")');
        const before = lua.get_memory_usage();
        for (const fn of fns) lua.release(fn);
        lua.execute_script('collectgarbage("collect")');
        const after = lua.get_memory_usage();
        expect(after).toBeLessThan(before - 500 * 2048); // at least half the payload bytes freed
      });
    });
  });

  // ============================================
  // GC CONTROL
  // ============================================
  describe('GC control - lua.gc()', () => {
    describe('count', () => {
      it('reports memory in use as a positive number of KB', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const kb = lua.gc('count');
        expect(typeof kb).toBe('number');
        expect(kb).toBeGreaterThan(0);
      });

      it('preserves the fractional part', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        // count * 1024 is the exact byte count, so the value is essentially
        // never a whole number of KB.
        const samples = [lua.gc('count'), lua.gc('count')];
        expect(samples.some((kb) => !Number.isInteger(kb))).toBe(true);
      });

      it('tracks allocation of collectable objects', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const before = lua.gc('count');
        lua.execute_script('kept = {} for i = 1, 20000 do kept[i] = { n = i } end');
        expect(lua.gc('count')).toBeGreaterThan(before + 512);
      });

      it('reports the same accounting as Lua\'s own collectgarbage("count")', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        // Not bit-identical: evaluating collectgarbage("count") means compiling
        // and running a chunk, which allocates. Agreement to within a couple of
        // KB is the point — the allocator's view diverges by orders of
        // magnitude more (see the luaL_Buffer test below).
        const agrees = () => {
          const fromLua = lua.execute_script<number>('return collectgarbage("count")');
          expect(Math.abs(lua.gc('count') - fromLua)).toBeLessThan(2);
        };
        agrees();
        lua.execute_script('kept = {} for i = 1, 5000 do kept[i] = { n = i } end');
        agrees();
      });

      it('agrees with get_memory_usage once nothing is pending collection', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.gc('collect');
        expect(lua.gc('count') * 1024).toBe(lua.get_memory_usage());
      });

      it('never exceeds get_memory_usage, which counts allocator scratch too', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        // string.rep builds its result in a luaL_Buffer, whose scratch memory
        // goes straight to the allocator and is invisible to Lua's own GC
        // accounting until the buffer's box userdata is collected. So the two
        // figures legitimately diverge, always in this direction.
        lua.execute_script(`big = string.rep('x', 512 * 1024)`);
        expect(lua.gc('count') * 1024).toBeLessThan(lua.get_memory_usage());

        // ...and converge again once the scratch is reclaimed.
        lua.execute_script('big = nil');
        lua.gc('collect');
        expect(lua.gc('count') * 1024).toBe(lua.get_memory_usage());
      });
    });

    describe('collect', () => {
      it('returns undefined and does not throw', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.gc('collect')).toBeUndefined();
      });

      it('reclaims unreachable memory', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('store = {} for i = 1, 20000 do store[i] = { n = i } end');
        const held = lua.gc('count');
        lua.execute_script('store = nil');
        lua.gc('collect');
        expect(lua.gc('count')).toBeLessThan(held - 512); // at least 512KB back
      });

      it('runs pending __gc finalizers', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script(`
          finalized = 0
          do
            local t = setmetatable({}, { __gc = function() finalized = finalized + 1 end })
          end
        `);
        lua.gc('collect');
        expect(lua.execute_script('return finalized')).toBe(1);
      });

      it('is safe from inside a host callback', () => {
        const lua = new lua_native.init(
          { sweep: () => { lua.gc('collect'); return 'swept'; } },
          ALL_LIBS
        );
        // Unlike reset(), collecting with Lua frames live is a normal operation.
        expect(lua.execute_script(`
          local junk = {}
          for i = 1, 100 do junk[i] = string.rep('y', 1024) end
          junk = nil
          return sweep()
        `)).toBe('swept');
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });

    describe('stop / restart / isrunning', () => {
      it('reports the collector as running by default', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.gc('isrunning')).toBe(true);
      });

      it('stops and restarts automatic collection', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(lua.gc('stop')).toBeUndefined();
        expect(lua.gc('isrunning')).toBe(false);
        expect(lua.gc('restart')).toBeUndefined();
        expect(lua.gc('isrunning')).toBe(true);
      });

      it('holds garbage until an explicit collect while stopped', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.gc('collect');
        lua.gc('stop');

        // Churn through garbage that a running collector would reclaim.
        lua.execute_script(`
          for i = 1, 400 do local s = string.rep('x', 8192) end
        `);
        const stopped = lua.gc('count');

        // An explicit collect still works while stopped.
        lua.gc('collect');
        const collected = lua.gc('count');
        expect(collected).toBeLessThan(stopped);

        lua.gc('restart');
        expect(lua.gc('isrunning')).toBe(true);
      });

      it('keeps maxMemory enforced while the collector is stopped', () => {
        const lua = new lua_native.init({}, { libraries: 'all', maxMemory: 4 * 1024 * 1024 });
        lua.gc('stop');
        // Lua still runs an emergency collection when an allocation would
        // exceed the cap, so a stopped collector cannot turn the limit into a
        // spurious failure — this loop stays well under 4MB of live data.
        expect(lua.execute_script(`
          for i = 1, 2000 do local s = string.rep('x', 1024) end
          return 'survived'
        `)).toBe('survived');
        // ...and the cap is still a cap.
        expect(() => lua.execute_script(`
          keep = {}
          for i = 1, 1e6 do keep[i] = string.rep('x', 1024) end
        `)).toThrow(/memory/i);
      });
    });

    describe('step', () => {
      it('returns a boolean for a basic step', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(typeof lua.gc('step')).toBe('boolean');
      });

      it('accepts an explicit step size', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(typeof lua.gc('step', 1024)).toBe('boolean');
      });

      it('eventually finishes a cycle when driven repeatedly', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.gc('stop');
        lua.execute_script(`
          for i = 1, 200 do local s = string.rep('x', 4096) end
        `);
        let finished = false;
        for (let i = 0; i < 10_000 && !finished; i++) finished = lua.gc('step', 4096);
        expect(finished).toBe(true);
        lua.gc('restart');
      });

      it('rejects a negative step size', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.gc('step', -1)).toThrow(/non-negative/);
      });
    });

    describe('mode switching', () => {
      it('switches to generational and back, reporting the previous mode', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const first = lua.gc('generational');
        expect(['incremental', 'generational']).toContain(first);
        expect(lua.gc('incremental')).toBe('generational');
        expect(lua.gc('generational')).toBe('incremental');
        lua.gc('incremental');
      });

      it('keeps the context usable in generational mode', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.gc('generational');
        expect(lua.execute_script(`
          local t = {}
          for i = 1, 5000 do t[i] = { n = i } end
          return #t
        `)).toBe(5000);
        lua.gc('collect');
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });

    describe('param', () => {
      it('reads a parameter without changing it', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const pause = lua.gc('param', 'pause');
        expect(typeof pause).toBe('number');
        expect(pause).toBeGreaterThan(0);
        expect(lua.gc('param', 'pause')).toBe(pause);
      });

      it('sets a parameter and returns the previous value', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const original = lua.gc('param', 'pause');
        expect(lua.gc('param', 'pause', 400)).toBe(original);
        expect(lua.gc('param', 'pause')).toBe(400);
        lua.gc('param', 'pause', original);
      });

      it('supports every documented parameter name', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        for (const name of ['minormul', 'majorminor', 'minormajor',
                            'pause', 'stepmul', 'stepsize'] as const) {
          expect(typeof lua.gc('param', name)).toBe('number');
        }
      });

      it('rejects an unknown parameter name', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.gc('param', 'nope' as any)).toThrow(/Unknown GC parameter/);
      });

      it('rejects an out-of-range value', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.gc('param', 'pause', 100001)).toThrow(/between 0 and 100000/);
        expect(() => lua.gc('param', 'pause', -5)).toThrow(/between 0 and 100000/);
      });

      it('requires a parameter name', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua as any).gc('param')).toThrow(/parameter name/);
      });
    });

    describe('validation and guards', () => {
      it('rejects an unknown command', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua as any).gc('explode')).toThrow(/Unknown GC command/);
      });

      it('requires a command string', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        expect(() => (lua as any).gc()).toThrow(/command string/);
        expect(() => (lua as any).gc(42)).toThrow(/command string/);
      });

      it('throws while a worker-thread async run is in flight', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const pending = lua.execute_script_async(`
          local s = 0
          for i = 1, 3e6 do s = s + i end
          return s
        `);
        expect(() => lua.gc('collect')).toThrow('busy');
        expect(() => lua.gc('count')).toThrow('busy');
        await pending;
        expect(() => lua.gc('collect')).not.toThrow();
      });

      it('rejects a call made from inside a __gc finalizer', () => {
        const lua = new lua_native.init(
          { fromFinalizer: () => { lua.gc('collect'); return null; } },
          ALL_LIBS
        );
        // Lua forbids lua_gc during a collection; the error must surface as a
        // clean throw rather than corrupting the collector. Errors inside a
        // finalizer become warnings, so record what happened in Lua instead.
        // A JS callback's throw arrives as a structured error table (D1), so
        // read its message field rather than stringifying the table.
        lua.execute_script(`
          gcError = nil
          do
            local t = setmetatable({}, { __gc = function()
              local ok, err = pcall(fromFinalizer)
              if ok then gcError = 'no error'
              elseif type(err) == 'table' then gcError = err.message
              else gcError = tostring(err) end
            end })
          end
        `);
        lua.gc('collect');
        expect(String(lua.execute_script('return gcError')))
          .toMatch(/collection is in progress/);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });

    describe('bare state', () => {
      it('works without any standard libraries loaded', () => {
        const lua = new lua_native.init();
        expect(lua.gc('count')).toBeGreaterThan(0);
        expect(lua.gc('isrunning')).toBe(true);
        expect(lua.gc('collect')).toBeUndefined();
      });
    });
  });

  // ============================================
  // CONTEXT RESET
  // ============================================
  describe('context reset - lua.reset()', () => {
    describe('state clearing', () => {
      it('discards globals set from Lua', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('x = 42');
        expect(lua.execute_script('return x')).toBe(42);
        lua.reset();
        expect(lua.execute_script('return x')).toBeNull();
      });

      it('discards globals set from JS via set_global', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_global('cfg', { host: 'localhost' });
        expect(lua.get_global('cfg')).toEqual({ host: 'localhost' });
        lua.reset();
        expect(lua.get_global('cfg')).toBeNull();
      });

      it('discards functions, tables, and metatables defined in Lua', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script(`
          function helper() return 1 end
          shared = setmetatable({}, { __index = function() return 'meta' end })
        `);
        expect(lua.execute_script('return type(helper)')).toBe('function');
        lua.reset();
        expect(lua.execute_script('return type(helper)')).toBe('nil');
        expect(lua.execute_script('return type(shared)')).toBe('nil');
      });

      it('discards modules cached by require()', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_module('greeter', { hello: () => 'hi' });
        expect(lua.execute_script('return require("greeter").hello()')).toBe('hi');
        lua.reset();
        // register_module is bound to the old state and is not replayed.
        expect(() => lua.execute_script('return require("greeter")')).toThrow(/module 'greeter' not found/);
      });

      it('leaves the context usable across repeated resets', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        for (let i = 0; i < 5; i++) {
          expect(lua.execute_script('return counter')).toBeNull();
          lua.execute_script('counter = 1');
          lua.reset();
        }
        expect(lua.execute_script('return 6 * 7')).toBe(42);
      });
    });

    describe('replayed configuration', () => {
      it('keeps the constructor callbacks working', () => {
        const seen: string[] = [];
        const lua = new lua_native.init(
          { log: (msg: string) => { seen.push(msg); return null; } },
          ALL_LIBS
        );
        lua.execute_script('log("before")');
        lua.reset();
        lua.execute_script('log("after")');
        expect(seen).toEqual(['before', 'after']);
      });

      it('keeps non-function constructor values as globals', () => {
        const lua = new lua_native.init({ appName: 'demo' }, ALL_LIBS);
        expect(lua.execute_script('return appName')).toBe('demo');
        lua.reset();
        expect(lua.execute_script('return appName')).toBe('demo');
      });

      it('keeps the libraries preset', () => {
        const safe = new lua_native.init({}, { libraries: 'safe' });
        safe.reset();
        expect(safe.execute_script('return math.floor(3.7)')).toBe(3);
        expect(safe.execute_script('return type(os)')).toBe('nil');

        // A bare state has no base library either, so probe without calling.
        const bare = new lua_native.init();
        bare.reset();
        expect(bare.execute_script('return math')).toBeNull();
        expect(bare.execute_script('return 1 + 1')).toBe(2);
      });

      it('keeps the maxMemory limit', () => {
        const lua = new lua_native.init({}, { libraries: 'all', maxMemory: 2 * 1024 * 1024 });
        lua.reset();
        expect(() => lua.execute_script(`
          local t = {}
          for i = 1, 1e7 do t[i] = string.rep('x', 100) end
        `)).toThrow(/memory/i);
        // The context survives the OOM and is still usable.
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('keeps the maxInstructions limit', () => {
        const lua = new lua_native.init({}, { libraries: 'all', maxInstructions: 100_000 });
        lua.reset();
        expect(() => lua.execute_script('while true do end'))
          .toThrow('instruction limit exceeded');
      });

      it('keeps the allowBytecode guard', () => {
        const trusted = new lua_native.init({}, ALL_LIBS);
        const bytecode = trusted.compile('return 7');

        const lua = new lua_native.init({}, { libraries: 'all', allowBytecode: false });
        lua.reset();
        expect(() => lua.load_bytecode(bytecode)).toThrow(/bytecode/i);
      });

      it('keeps a print handler passed as a constructor option', () => {
        const lines: string[] = [];
        const lua = new lua_native.init({}, { libraries: 'all', print: (t) => lines.push(t) });
        lua.execute_script('print("before")');
        lua.reset();
        lua.execute_script('print("after")');
        expect(lines.map(l => l.trim())).toEqual(['before', 'after']);
      });

      it('keeps a print handler installed via set_print_handler', () => {
        const lines: string[] = [];
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_print_handler((t) => { lines.push(t); });
        lua.reset();
        lua.execute_script('print("after")');
        expect(lines.map(l => l.trim())).toEqual(['after']);
      });

      it('keeps search paths added with add_search_path', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fixtureDir = path.resolve(__dirname, '../fixtures/modules');
        lua.add_search_path(path.join(fixtureDir, '?.lua'));
        expect(lua.execute_script('return require("testmod").add(3, 4)')).toBe(7);
        lua.reset();
        // A fresh package.loaded, but the path still resolves the module.
        expect(lua.execute_script('return require("testmod").add(3, 4)')).toBe(7);
      });

      it('keeps registered type converters', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.register_type_converter(
          (v: any) => v instanceof Date,
          (v: Date) => v.toISOString()
        );
        lua.reset();
        lua.set_global('when', new Date(Date.UTC(2026, 6, 23)));
        expect(lua.execute_script('return when')).toBe('2026-07-23T00:00:00.000Z');
      });
    });

    describe('handles minted before the reset', () => {
      it('invalidates Lua function references', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const fn = lua.execute_script<any>('return function(x) return x * 2 end');
        expect(fn(21)).toBe(42);
        lua.reset();
        expect(() => fn(21)).toThrow(/replaced by reset/);
      });

      it('invalidates table handles', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        t.set('a', 1);
        lua.reset();
        expect(() => t.get('a')).toThrow(/replaced by reset/);
      });

      it('invalidates metatabled-table proxies', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const proxy = lua.execute_script<any>(`
          return setmetatable({}, { __index = function() return 'x' end })
        `);
        expect(proxy.anything).toBe('x');
        lua.reset();
        expect(() => proxy.anything).toThrow(/replaced by reset/);
      });

      it('rejects coroutines created before the reset', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const co = lua.create_coroutine('return function() coroutine.yield(1) end');
        lua.reset();
        expect(() => lua.resume(co)).toThrow(/different Lua context/);
      });

      it('does not let a stale handle reach the new state', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        t.set('marker', 'old');
        lua.reset();
        // The new state has its own registry; the stale handle must not read or
        // write through it.
        expect(() => t.set('marker', 'new')).toThrow(/replaced by reset/);
        expect(lua.execute_script('return marker')).toBeNull();
      });

      it('reclaims accumulated Lua memory', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script(`
          store = {}
          for i = 1, 200 do store[i] = string.rep('x', 8192) end
        `);
        const before = lua.get_memory_usage();
        expect(before).toBeGreaterThan(1024 * 1024);

        lua.reset();
        // get_memory_usage reports the live state's allocator, and the fresh
        // state starts empty.
        expect(lua.get_memory_usage()).toBeLessThan(before / 2);
      });

      it('handles a stale handle safely rather than crashing', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const held = lua.execute_script<any>('return function() return 1 end');
        lua.reset();
        // The retired state stays open behind `held`, so every operation that
        // touches it fails cleanly instead of reaching freed memory.
        expect(() => held()).toThrow(/replaced by reset/);
        expect(() => lua.release(held)).toThrow(/different Lua context/);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });

    describe('guards', () => {
      it('throws while a worker-thread async run is in flight', async () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const pending = lua.execute_script_async(`
          local s = 0
          for i = 1, 3e6 do s = s + i end
          return s
        `);
        expect(() => lua.reset()).toThrow('busy');
        await pending;
        expect(() => lua.reset()).not.toThrow();
      });

      it('throws when called from inside a host callback', () => {
        let inner: unknown;
        const lua = new lua_native.init(
          { tryReset: () => { try { lua.reset(); } catch (e) { inner = e; } return 1; } },
          ALL_LIBS
        );
        // Resetting here would free the lua_State the running script is
        // executing on; the guard must reject it and leave the state intact.
        expect(lua.execute_script('return tryReset()')).toBe(1);
        expect(String(inner)).toMatch(/while Lua is executing/);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
        // Once the call has returned, a reset is allowed.
        expect(() => lua.reset()).not.toThrow();
        expect(lua.execute_script('return tryReset()')).toBe(1);
      });

      it('throws when called from inside a metamethod', () => {
        let inner: unknown;
        const lua = new lua_native.init(
          { tryReset: () => { try { lua.reset(); } catch (e) { inner = e; } return 'ok'; } },
          ALL_LIBS
        );
        lua.execute_script('obj = {}');
        lua.set_metatable('obj', { __index: () => (lua.execute_script('return tryReset()')) });
        expect(lua.execute_script('return obj.missing')).toBe('ok');
        expect(String(inner)).toMatch(/while Lua is executing/);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('throws while a coroutine-driven async run is suspended', async () => {
        const lua = new lua_native.init(
          { wait: () => new Promise((res) => setTimeout(() => res(1), 20)) },
          ALL_LIBS
        );
        const pending = lua.execute_async('local v = wait() return v');
        expect(() => lua.reset()).toThrow('busy');
        await pending;
        expect(() => lua.reset()).not.toThrow();
      });
    });

    describe('bindings that must be re-applied', () => {
      it('drops userdata registered before the reset', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('cfg', { debug: true }, { readable: true });
        expect(lua.execute_script('return cfg.debug')).toBe(true);
        lua.reset();
        expect(lua.execute_script('return type(cfg)')).toBe('nil');
        // Re-registering after the reset works, and uses the new state.
        lua.set_userdata('cfg', { debug: false }, { readable: true });
        expect(lua.execute_script('return cfg.debug')).toBe(false);
      });

      it('drops registered classes and allows re-registration', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const definition = {
          construct: (x: any) => ({ x: x as number }),
          methods: { getX: (self: any) => self.x },
        };
        lua.register_class('Point', definition);
        expect(lua.execute_script('return Point.new(5):getX()')).toBe(5);
        lua.reset();
        expect(lua.execute_script('return type(Point)')).toBe('nil');
        // register_class rejects a duplicate name on the same state; a reset
        // clears that record along with the state.
        lua.register_class('Point', definition);
        expect(lua.execute_script('return Point.new(9):getX()')).toBe(9);
      });

      it('restores default (running) GC behavior', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.gc('stop');
        expect(lua.gc('isrunning')).toBe(false);
        lua.reset();
        // A paused collector is a transient tuning knob, not context config —
        // a fresh state must not inherit it.
        expect(lua.gc('isrunning')).toBe(true);
      });

      it('drops metatables set before the reset', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('obj = {}');
        lua.set_metatable('obj', { __index: () => 'from-js' });
        expect(lua.execute_script('return obj.missing')).toBe('from-js');
        lua.reset();
        expect(lua.execute_script('return type(obj)')).toBe('nil');
      });
    });
  });

  // ============================================
  // SHARED STATE BETWEEN CONTEXTS
  // ============================================
  describe('shared state between contexts', () => {
    describe('createSharedTable()', () => {
      it('publishes the initial value to every subscribing context', () => {
        const shared = lua_native.createSharedTable({ mode: 'dev', retries: 3 });
        const lua1 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });
        const lua2 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        expect(lua1.execute_script('return settings.mode')).toBe('dev');
        expect(lua2.execute_script('return settings.retries')).toBe(3);
      });

      it('publishes nested objects', () => {
        const shared = lua_native.createSharedTable({ config: { debug: true, level: 2 } });
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        expect(lua.execute_script('return settings.config.debug')).toBe(true);
        expect(lua.execute_script('return settings.config.level')).toBe(2);
      });

      it('defaults to an empty table', () => {
        const shared = lua_native.createSharedTable();
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        expect(lua.execute_script('return type(settings)')).toBe('table');
        expect(lua.execute_script('return next(settings) == nil')).toBe(true);
      });

      it('accepts an array as the shared value', () => {
        const shared = lua_native.createSharedTable([10, 20, 30]);
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: { list: shared } });

        expect(lua.execute_script('return #list')).toBe(3);
        expect(lua.execute_script('return list[2]')).toBe(20);
      });

      it('rejects a non-object initial value', () => {
        expect(() => lua_native.createSharedTable(5 as any)).toThrow('requires an object');
        expect(() => lua_native.createSharedTable('x' as any)).toThrow('requires an object');
        expect(() => lua_native.createSharedTable((() => 1) as any)).toThrow('requires an object');
      });

      it('holds the caller\'s object rather than a copy', () => {
        const initial = { n: 1 };
        const shared = lua_native.createSharedTable(initial);
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        initial.n = 99;
        shared.sync();
        expect(lua.execute_script('return settings.n')).toBe(99);
      });
    });

    describe('set() and get()', () => {
      it('propagates a set to every subscribed context', () => {
        const shared = lua_native.createSharedTable({ n: 1 });
        const lua1 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });
        const lua2 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        shared.set('n', 42);

        expect(lua1.execute_script('return settings.n')).toBe(42);
        expect(lua2.execute_script('return settings.n')).toBe(42);
      });

      it('adds new keys, not just updates', () => {
        const shared = lua_native.createSharedTable({ a: 1 });
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        shared.set('b', 2);
        expect(lua.execute_script('return settings.a + settings.b')).toBe(3);
      });

      it('reads the JS-side value back', () => {
        const shared = lua_native.createSharedTable({ n: 1, nested: { x: 5 } });
        expect(shared.get('n')).toBe(1);
        expect((shared.get('nested') as any).x).toBe(5);
        expect(shared.get('missing')).toBeUndefined();

        shared.set('n', 7);
        expect(shared.get('n')).toBe(7);
      });

      it('propagates a function value as a callable global', () => {
        const shared = lua_native.createSharedTable({});
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: { helpers: shared } });

        shared.set('double', ((n: number) => n * 2) as any);
        expect(lua.execute_script('return helpers.double(21)')).toBe(42);
      });

      it('rejects a non-string key', () => {
        const shared = lua_native.createSharedTable({});
        expect(() => shared.set(1 as any, 'v')).toThrow('requires a string key');
        expect(() => (shared.set as any)('only-key')).toThrow('requires a string key');
        expect(() => shared.get(1 as any)).toThrow('requires a string key');
        expect(() => (shared.get as any)()).toThrow('requires a string key');
      });
    });

    describe('sync()', () => {
      it('publishes a direct mutation of the shared object', () => {
        const shared = lua_native.createSharedTable({ config: { debug: true } });
        const lua1 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });
        const lua2 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        // Mutating through a nested object returned by get() needs an explicit
        // sync — set() is the only self-publishing path.
        (shared.get('config') as any).debug = false;
        expect(lua1.execute_script('return settings.config.debug')).toBe(true);

        shared.sync();
        expect(lua1.execute_script('return settings.config.debug')).toBe(false);
        expect(lua2.execute_script('return settings.config.debug')).toBe(false);
      });

      it('is a no-op with no subscribers', () => {
        const shared = lua_native.createSharedTable({ n: 1 });
        expect(() => shared.sync()).not.toThrow();
      });
    });

    describe('isolation', () => {
      it('leaves non-shared globals independent', () => {
        const shared = lua_native.createSharedTable({ n: 1 });
        const lua1 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });
        const lua2 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        lua1.execute_script('private_value = "only-lua1"');
        expect(lua2.get_global('private_value')).toBeNull();
      });

      it('keeps Lua-side edits local to their context', () => {
        const shared = lua_native.createSharedTable({ n: 1 });
        const lua1 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });
        const lua2 = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        // Propagation is one-way: a script's assignment changes only its own
        // context's copy and never travels back to JS.
        lua1.execute_script('settings.n = 999');
        expect(lua1.execute_script('return settings.n')).toBe(999);
        expect(lua2.execute_script('return settings.n')).toBe(1);
        expect(shared.get('n')).toBe(1);

        // ...and the next publish overwrites the local edit.
        shared.set('n', 5);
        expect(lua1.execute_script('return settings.n')).toBe(5);
      });

      it('publishes the current value to a context that subscribes later', () => {
        const shared = lua_native.createSharedTable({ n: 1 });
        const early = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });
        shared.set('n', 2);
        const late = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        expect(late.execute_script('return settings.n')).toBe(2);
        expect(early.execute_script('return settings.n')).toBe(2);
      });

      it('supports different global names per context', () => {
        const shared = lua_native.createSharedTable({ n: 1 });
        const lua1 = new lua_native.init({}, { ...ALL_LIBS, shared: { alpha: shared } });
        const lua2 = new lua_native.init({}, { ...ALL_LIBS, shared: { beta: shared } });

        shared.set('n', 3);
        expect(lua1.execute_script('return alpha.n')).toBe(3);
        expect(lua2.execute_script('return beta.n')).toBe(3);
      });

      it('supports several shared tables on one context', () => {
        const a = lua_native.createSharedTable({ v: 'a' });
        const b = lua_native.createSharedTable({ v: 'b' });
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: { first: a, second: b } });

        expect(lua.execute_script('return first.v .. second.v')).toBe('ab');
        a.set('v', 'A');
        expect(lua.execute_script('return first.v .. second.v')).toBe('Ab');
      });
    });

    describe('option validation', () => {
      it('rejects a non-object shared option', () => {
        const shared = lua_native.createSharedTable({});
        expect(() => new lua_native.init({}, { ...ALL_LIBS, shared: shared as any }))
          .toThrow('must be an object mapping global names to shared tables');
        expect(() => new lua_native.init({}, { ...ALL_LIBS, shared: [shared] as any }))
          .toThrow('must be an object mapping global names to shared tables');
      });

      it('rejects an entry that is not a shared table', () => {
        expect(() => new lua_native.init({}, { ...ALL_LIBS, shared: { settings: {} as any } }))
          .toThrow('shared.settings must be a shared table created with createSharedTable()');
        expect(() => new lua_native.init({}, { ...ALL_LIBS, shared: { settings: 5 as any } }))
          .toThrow('must be a shared table created with createSharedTable()');
      });

      it('ignores an undefined shared option', () => {
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: undefined });
        expect(lua.execute_script('return 1')).toBe(1);
      });
    });

    describe('interaction with other features', () => {
      it('re-publishes the shared globals after reset()', () => {
        const shared = lua_native.createSharedTable({ n: 1 });
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        lua.execute_script('other = "gone after reset"');
        lua.reset();

        // The shared value lives in JS, so unlike modules or userdata it can be
        // replayed onto the fresh state.
        expect(lua.execute_script('return settings.n')).toBe(1);
        expect(lua.get_global('other')).toBeNull();

        // ...and the context is still subscribed afterwards.
        shared.set('n', 8);
        expect(lua.execute_script('return settings.n')).toBe(8);
      });

      it('reports a context that cannot accept the update, after updating the rest', async () => {
        const shared = lua_native.createSharedTable({ n: 1 });
        const busy = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });
        const idle = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        const pending = busy.execute_script_async(
          'local s = 0 for i = 1, 3000000 do s = s + i end return s');

        expect(() => shared.set('n', 7)).toThrow(/shared table update failed for 1 of 2 contexts/);
        // The reachable context still got the update, and the JS value stands.
        expect(idle.execute_script('return settings.n')).toBe(7);
        expect(shared.get('n')).toBe(7);

        await pending;

        // sync() brings the straggler back in line.
        shared.sync();
        expect(busy.execute_script('return settings.n')).toBe(7);
      });

      it('works with a shared table read through a table reference', () => {
        const shared = lua_native.createSharedTable({ n: 1 });
        const lua = new lua_native.init({}, { ...ALL_LIBS, shared: { settings: shared } });

        const ref = lua.get_global_ref('settings');
        expect(ref.get('n')).toBe(1);

        // Each publish replaces the global with a fresh table, so a handle taken
        // beforehand keeps pointing at the previous one.
        shared.set('n', 2);
        expect(ref.get('n')).toBe(1);
        expect(lua.execute_script('return settings.n')).toBe(2);
        ref.release();
      });
    });
  });

  // ============================================
  // CALLING LUA FUNCTIONS BY NAME (F2)
  // ============================================
  describe('call()', () => {
    it('calls a Lua global function by name', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('function add(a, b) return a + b end');
      expect(lua.call('add', 2, 3)).toBe(5);
    });

    it('returns undefined, a value, or an array to match the return count', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(`
        function none() end
        function one() return 'x' end
        function many() return 1, 2, 3 end
      `);
      expect(lua.call('none')).toBeUndefined();
      expect(lua.call('one')).toBe('x');
      expect(lua.call('many')).toEqual([1, 2, 3]);
    });

    it('accepts a dotted path to a nested function', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('handlers = { on = { tick = function(n) return n * 2 end } }');
      expect(lua.call('handlers.on.tick', 21)).toBe(42);
    });

    it('converts arguments like every other JS -> Lua crossing', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(`
        function apply(f, x) return f(x) end
        function total(t) local s = 0 for _, v in ipairs(t) do s = s + v end return s end
      `);
      expect(lua.call('apply', (n: number) => n * 2, 21)).toBe(42);
      expect(lua.call('total', [1, 2, 3])).toBe(6);
    });

    it('rejects a name that is not a function', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('x = 5; t = {}');
      expect(() => lua.call('x')).toThrow(/'x' is not a function/);
      expect(() => lua.call('t')).toThrow(/'t' is not a function/);
      expect(() => lua.call('missing')).toThrow(/'missing' is not a function/);
    });

    it('rejects a malformed dotted path', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.call('a..b')).toThrow(/segments must be non-empty/);
    });

    it('propagates a Lua error, and the original Error from a JS callback', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('function boom() error("kaboom") end');
      expect(() => lua.call('boom')).toThrow(/kaboom/);

      const sentinel = new Error('from JS');
      lua.set_global('thrower', () => { throw sentinel; });
      lua.execute_script('function relay() return thrower() end');
      expect(() => lua.call('relay')).toThrow(sentinel);
    });

    it('does not leave a JS function wrapper behind on each call', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('function id(x) return x end');
      for (let i = 0; i < 200; i++) expect(lua.call('id', i)).toBe(i);
      // A get_global round-trip would have minted 200 registry refs; this path
      // mints none, so the state stays small.
      expect(lua.call('id', 'still working')).toBe('still working');
    });
  });

  // ============================================
  // METATABLES ON NON-GLOBAL TABLES (F1)
  // ============================================
  describe('set_metatable() on table references', () => {
    it('attaches a metatable to a create_table() handle', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const t = lua.create_table({ a: 1 });
      lua.set_metatable(t, { __index: (_self: unknown, k: string) => `default:${k}` });

      expect(t.get('a')).toBe(1);
      expect(t.get('missing')).toBe('default:missing');
    });

    it('is visible from Lua once the table is reachable there', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const t = lua.create_table();
      lua.set_metatable(t, { __index: (_self: unknown, k: string) => `mm:${k}` });
      lua.set_global('T', t);
      expect(lua.execute_script('return T.anything')).toBe('mm:anything');
    });

    it('attaches a metatable to a get_global_ref() handle', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('G = {}');
      const g = lua.get_global_ref('G');
      lua.set_metatable(g, { __call: () => 42 });
      expect(lua.execute_script('return G()')).toBe(42);
    });

    it('attaches a metatable to an environment table', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const env = lua.create_environment({ whitelist: [] });
      lua.set_metatable(env, {
        __index: (_self: unknown, k: string) => (k === 'answer' ? 42 : null),
      });
      expect(lua.execute_script_in(env, 'return answer')).toBe(42);
    });

    it('routes handle get/set through __index and __newindex', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const t = lua.create_table();
      const writes: Array<[string, unknown]> = [];
      lua.set_metatable(t, {
        __index: (_self: unknown, k: string) => `idx:${k}`,
        __newindex: (_self: unknown, k: string, v: unknown) => { writes.push([k, v]); },
      });

      expect(t.get('a')).toBe('idx:a');
      t.set('b', 2);
      expect(writes).toEqual([['b', 2]]);
      // __newindex swallowed the write, so the read still falls through.
      expect(t.get('b')).toBe('idx:b');
    });

    it('replaces an existing metatable, like setmetatable', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const t = lua.create_table();
      lua.set_metatable(t, { __index: () => 'first' });
      expect(t.get('x')).toBe('first');
      lua.set_metatable(t, { __index: () => 'second' });
      expect(t.get('x')).toBe('second');
    });

    it('works on the Proxy a metatabled table round-trips as', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const proxy = lua.execute_script(
        'return setmetatable({}, { __index = function() return "old" end })') as any;
      expect(proxy.k).toBe('old');
      lua.set_metatable(proxy, { __index: () => 'new' });
      expect(proxy.k).toBe('new');
    });

    it('still accepts a global name', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('S = {}');
      lua.set_metatable('S', { __index: () => 'str' });
      expect(lua.execute_script('return S.x')).toBe('str');
    });

    it('rejects a target that is neither a name nor a table reference', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => (lua as any).set_metatable(123, {}))
        .toThrow(/global name or a table handle/);
      expect(() => (lua as any).set_metatable({}, {}))
        .toThrow(/global name or a table handle/);
    });

    it('rejects a released handle and one from another context', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const other = new lua_native.init({}, ALL_LIBS);

      const released = lua.create_table();
      released.release();
      expect(() => lua.set_metatable(released, {})).toThrow(/has been released/);

      const foreign = other.create_table();
      expect(() => lua.set_metatable(foreign, {}))
        .toThrow(/different Lua context/);
    });

    it('rejects a non-object metatable', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const t = lua.create_table();
      expect(() => (lua as any).set_metatable(t, 'nope'))
        .toThrow(/metatable must be an object/);
    });
  });

  // ============================================
  // LIVE REFERENCES TO NESTED TABLES
  // ============================================
  describe('LuaTableHandle.get_ref()', () => {
    it('returns a live handle where get() would return a copy', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('outer = { inner = { v = 1 } }');
      const outer = lua.get_global_ref('outer');

      // get() on a metatable-less nested table is a detached copy.
      const copy = outer.get('inner') as any;
      copy.v = 99;
      expect(lua.execute_script('return outer.inner.v')).toBe(1);

      // get_ref() reaches the real table.
      const inner = outer.get_ref('inner');
      inner.set('v', 99);
      expect(lua.execute_script('return outer.inner.v')).toBe(99);
      inner.release();
    });

    it('makes a plain nested table reachable for set_metatable', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('outer = { inner = {} }');
      const inner = lua.get_global_ref('outer').get_ref('inner');
      lua.set_metatable(inner, { __index: (_s: unknown, k: string) => `<${k}>` });
      expect(lua.execute_script('return outer.inner.zzz')).toBe('<zzz>');
    });

    it('composes to any depth', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('a = { b = { c = { d = 7 } } }');
      const c = lua.get_global_ref('a').get_ref('b').get_ref('c');
      expect(c.get('d')).toBe(7);
      c.set('d', 8);
      expect(lua.execute_script('return a.b.c.d')).toBe(8);
    });

    it('distinguishes an integer key from a string key', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(`
        t = {}
        t[1] = { tag = 'int-key' }
        t["1"] = { tag = 'string-key' }
      `);
      const t = lua.get_global_ref('t');
      expect(t.get_ref(1).get('tag')).toBe('int-key');
      expect(t.get_ref('1').get('tag')).toBe('string-key');
    });

    it('addresses array elements by index', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('rows = { { n = 1 }, { n = 2 } }');
      const rows = lua.get_global_ref('rows');
      expect(rows.get_ref(2).get('n')).toBe(2);
      rows.get_ref(1).set('n', 10);
      expect(lua.execute_script('return rows[1].n')).toBe(10);
    });

    it('triggers __index like get()', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(`
        backing = { hidden = { v = 'from __index' } }
        front = setmetatable({}, { __index = backing })
      `);
      expect(lua.get_global_ref('front').get_ref('hidden').get('v'))
        .toBe('from __index');
    });

    it('returns an independent handle that outlives its parent', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('p = { c = { v = 3 } }');
      const parent = lua.get_global_ref('p');
      const child = parent.get_ref('c');
      parent.release();
      expect(child.get('v')).toBe(3);
      child.release();
    });

    it('aliases the same Lua table across separate refs', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('q = { c = { v = 1 } }');
      const a = lua.get_global_ref('q').get_ref('c');
      const b = lua.get_global_ref('q').get_ref('c');
      a.set('v', 42);
      expect(b.get('v')).toBe(42);
    });

    it('throws when the field is not a table', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = { n = 5, s = "x" }');
      const t = lua.get_global_ref('t');
      expect(() => t.get_ref('n')).toThrow(/'n' is not a table \(got number\)/);
      expect(() => t.get_ref('s')).toThrow(/'s' is not a table \(got string\)/);
      expect(() => t.get_ref('missing')).toThrow(/'missing' is not a table \(got nil\)/);
    });

    it('validates its argument and the handle', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('t = { c = {} }');
      const t = lua.get_global_ref('t');
      expect(() => (t as any).get_ref()).toThrow(/requires a key argument/);
      expect(() => (t as any).get_ref(Symbol('x'))).toThrow(/must be a string or number/);

      t.release();
      expect(() => t.get_ref('c')).toThrow(/has been released/);
    });

    it('catches a raising __index and leaves the context usable', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(
        'bad = setmetatable({}, { __index = function() error("boom") end })');
      const bad = lua.get_global_ref('bad');
      expect(() => bad.get_ref('x')).toThrow(/boom/);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    it('works with the context-level release()', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('r = { c = {} }');
      const c = lua.get_global_ref('r').get_ref('c');
      lua.release(c);
      expect(() => c.get('x')).toThrow(/has been released/);
    });
  });

  // ============================================
  // COROUTINES AS ITERATORS (A4)
  // ============================================
  describe('coroutine iteration', () => {
    const producer = (lua: any) => lua.create_coroutine(`
      return function()
        coroutine.yield(1)
        coroutine.yield(2)
        coroutine.yield(3)
        return 'done'
      end
    `);

    it('drives a coroutine with for..of, one iteration per yield', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect([...producer(lua)]).toEqual([1, 2, 3]);
    });

    it('discards the coroutine\'s final return value, like a generator', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = producer(lua);
      const it = co[Symbol.iterator]();
      expect(it.next()).toEqual({ value: 1, done: false });
      it.next();
      it.next();
      // The `return 'done'` arrives with done: true, which for..of drops.
      expect(it.next()).toEqual({ value: 'done', done: true });
      expect(it.next()).toEqual({ value: undefined, done: true });
    });

    it('yields nothing for an already-dead coroutine', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = producer(lua);
      expect([...co]).toEqual([1, 2, 3]);
      expect([...co]).toEqual([]);
    });

    it('leaves the coroutine suspended when a loop exits early', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = producer(lua);
      const seen: unknown[] = [];
      for (const v of co) { seen.push(v); if (v === 2) break; }
      expect(seen).toEqual([1, 2]);
      // A later loop picks up where the first stopped.
      expect([...co]).toEqual([3]);
    });

    it('surfaces a multi-value yield as an array', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = lua.create_coroutine('return function() coroutine.yield(1, 2) end');
      expect([...co]).toEqual([[1, 2]]);
    });

    it('forwards next() arguments as the resume values', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = lua.create_coroutine(`
        return function()
          local got = coroutine.yield('ready')
          coroutine.yield('got ' .. tostring(got))
        end
      `);
      const it = co[Symbol.iterator]();
      expect(it.next().value).toBe('ready');
      expect(it.next('hello').value).toBe('got hello');
    });

    it('throws when the coroutine body errors, and ends the cursor', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = lua.create_coroutine('return function() error("bad") end');
      const it = co[Symbol.iterator]();
      expect(() => it.next()).toThrow(/bad/);
      expect(it.next()).toEqual({ value: undefined, done: true });
    });

    it('works with for await, via the sync-iterable fallback', async () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const seen: unknown[] = [];
      for await (const v of producer(lua)) seen.push(v);
      expect(seen).toEqual([1, 2, 3]);
    });

    it('gives each [Symbol.iterator]() call a cursor over the same thread', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = producer(lua);
      const a = co[Symbol.iterator]();
      const b = co[Symbol.iterator]();
      expect(a.next().value).toBe(1);
      expect(b.next().value).toBe(2);
      expect(a.next().value).toBe(3);
    });

    it('interoperates with resume()', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = producer(lua);
      expect(lua.resume(co).values).toEqual([1]);
      expect([...co]).toEqual([2, 3]);
    });

    it('iterates a coroutine created inside Lua', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = lua.execute_script(
        'return coroutine.create(function() coroutine.yield("z") end)') as any;
      expect([...co]).toEqual(['z']);
    });

    it('throws when the coroutine has been released', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = producer(lua);
      lua.release(co);
      expect(() => [...co]).toThrow(/has been released/);
    });
  });

  // ============================================
  // COROUTINES FROM AN EXISTING LUA FUNCTION (A4)
  // ============================================
  describe('create_coroutine() from a Lua function', () => {
    it('accepts a function returned by execute_script', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const fn = lua.execute_script(`
        return function()
          coroutine.yield('x')
          coroutine.yield('y')
        end
      `) as any;
      expect([...lua.create_coroutine(fn)]).toEqual(['x', 'y']);
      // The function itself is still usable afterwards.
      expect(typeof fn).toBe('function');
    });

    it('accepts a function read back with get_global', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('function gen() coroutine.yield(1) coroutine.yield(2) end');
      const fn = lua.get_global('gen') as any;
      expect([...lua.create_coroutine(fn)]).toEqual([1, 2]);
    });

    it('passes resume arguments to the function on the first resume', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const fn = lua.execute_script(
        'return function(a, b) coroutine.yield(a + b) end') as any;
      const co = lua.create_coroutine(fn);
      expect(lua.resume(co, 2, 3).values).toEqual([5]);
    });

    it('rejects a plain JavaScript function', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.create_coroutine((() => {}) as any))
        .toThrow(/plain JavaScript function/);
    });

    it('rejects a released function and one from another context', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const other = new lua_native.init({}, ALL_LIBS);

      const released = lua.execute_script('return function() end') as any;
      lua.release(released);
      expect(() => lua.create_coroutine(released)).toThrow(/has been released/);

      const foreign = other.execute_script('return function() end') as any;
      expect(() => lua.create_coroutine(foreign)).toThrow(/different Lua context/);
    });

    it('still accepts the original script form', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      const co = lua.create_coroutine('return function() coroutine.yield(1) end');
      expect(lua.resume(co).values).toEqual([1]);
      expect(() => (lua as any).create_coroutine(42))
        .toThrow(/script string that returns a function/);
    });
  });

  // ============================================
  // LUA -> JS TYPE CONVERTERS (B3)
  // ============================================
  describe('register_from_lua_converter()', () => {
    class Money {
      constructor(public cents: number) {}
    }
    const withMoney = () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.register_from_lua_converter(
        (v: any) => !!v && v.__type === 'Money',
        (v: any) => new Money(v.cents),
      );
      return lua;
    };

    it('rebuilds an application type from a Lua table', () => {
      const lua = withMoney();
      const m = lua.execute_script(`return { __type = 'Money', cents = 1299 }`) as any;
      expect(m).toBeInstanceOf(Money);
      expect(m.cents).toBe(1299);
    });

    it('reaches values nested inside tables and arrays', () => {
      const lua = withMoney();
      const nested = lua.execute_script(
        `return { price = { __type = 'Money', cents = 50 } }`) as any;
      expect(nested.price).toBeInstanceOf(Money);
      expect(nested.price.cents).toBe(50);

      const arr = lua.execute_script(
        `return { { __type = 'Money', cents = 1 }, { __type = 'Money', cents = 2 } }`) as any;
      expect(arr[0]).toBeInstanceOf(Money);
      expect(arr[1].cents).toBe(2);
    });

    it('reaches callback arguments', () => {
      const lua = withMoney();
      let got: any = null;
      lua.set_global('sink', (v: unknown) => { got = v; });
      lua.execute_script(`sink({ __type = 'Money', cents = 7 })`);
      expect(got).toBeInstanceOf(Money);
      expect(got.cents).toBe(7);
    });

    it('reaches values read through a table handle', () => {
      const lua = withMoney();
      lua.execute_script(`box = { item = { __type = 'Money', cents = 3 } }`);
      const ref = lua.get_global_ref('box');
      expect(ref.get('item')).toBeInstanceOf(Money);
      ref.release();
    });

    it('leaves primitives alone', () => {
      const lua = withMoney();
      expect(lua.execute_script('return 42')).toBe(42);
      expect(lua.execute_script('return "hi"')).toBe('hi');
      expect(lua.execute_script('return true')).toBe(true);
      expect(lua.execute_script('return nil')).toBeNull();
    });

    it('sees metatabled tables as the Proxy they convert to', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.register_from_lua_converter(
        (v: any) => { try { return v.__type === 'Tagged'; } catch { return false; } },
        (v: any) => ({ tagged: true, n: v.n }),
      );
      const r = lua.execute_script(`
        local t = setmetatable({ __type = 'Tagged', n = 3 }, { __index = function() return nil end })
        return t
      `) as any;
      expect(r).toEqual({ tagged: true, n: 3 });
    });

    it('leaves non-matching values as the natural conversion', () => {
      const lua = withMoney();
      const proxy = lua.execute_script(
        `return setmetatable({ v = 1 }, { __index = function(_, k) return 'mm:' .. k end })`) as any;
      expect(proxy.v).toBe(1);
      expect(proxy.zzz).toBe('mm:zzz');
    });

    it('uses the converter result verbatim, without re-converting it', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      let calls = 0;
      lua.register_from_lua_converter(
        (v: any) => { calls++; return !!v && v.wrap === true; },
        () => ({ wrap: true, marker: 'converted' }),
      );
      // The result matches the predicate itself; if it were re-converted this
      // would not terminate.
      const r = lua.execute_script('return { wrap = true }') as any;
      expect(r.marker).toBe('converted');
      expect(calls).toBe(1);
    });

    it('consults converters in registration order, first match wins', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.register_from_lua_converter((v: any) => v.k === 1, () => 'first');
      lua.register_from_lua_converter((v: any) => v.k === 1, () => 'second');
      expect(lua.execute_script('return { k = 1 }')).toBe('first');
    });

    it('round-trips with register_type_converter', () => {
      const lua = withMoney();
      lua.register_type_converter(
        (v) => v instanceof Money,
        (v: Money) => ({ __type: 'Money', cents: v.cents }),
      );
      lua.set_global('price', new Money(500));
      const back = lua.get_global('price') as any;
      expect(back).toBeInstanceOf(Money);
      expect(back.cents).toBe(500);
    });

    it('survives reset() — converters are context configuration', () => {
      const lua = withMoney();
      lua.reset();
      const m = lua.execute_script(`return { __type = 'Money', cents = 1 }`);
      expect(m).toBeInstanceOf(Money);
    });

    it('surfaces an error thrown by the predicate', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.register_from_lua_converter(
        () => { throw new Error('match blew up'); },
        (v: any) => v,
      );
      expect(() => lua.execute_script('return {1}')).toThrow(/match blew up/);
    });

    it('requires two functions', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => (lua as any).register_from_lua_converter(1, 2))
        .toThrow(/requires two functions/);
    });
  });

  // ============================================
  // CLASS INHERITANCE (C4)
  // ============================================
  describe('register_class() inheritance', () => {
    const animals = () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.register_class('Animal', {
        construct: (name: any) => ({ name, species: 'animal' }),
        readable: true,
        methods: {
          speak: (self: any) => `${self.name} makes a sound`,
          name_of: (self: any) => self.name,
        },
        metamethods: { __tostring: (self: any) => `Animal(${self.name})` },
      });
      lua.register_class('Dog', {
        extends: 'Animal',
        construct: (name: any) => ({ name, species: 'dog' }),
        readable: true,
        methods: { speak: (self: any) => `${self.name} barks` },
      });
      return lua;
    };

    it('inherits methods from the base class', () => {
      const lua = animals();
      expect(lua.execute_script(`return Dog.new('rex'):name_of()`)).toBe('rex');
    });

    it('lets a derived method override the base one', () => {
      const lua = animals();
      expect(lua.execute_script(`return Dog.new('rex'):speak()`)).toBe('rex barks');
      expect(lua.execute_script(`return Animal.new('cat'):speak()`)).toBe('cat makes a sound');
    });

    it('inherits metamethods unless the derived class defines its own', () => {
      const lua = animals();
      expect(lua.execute_script(`return tostring(Dog.new('rex'))`)).toBe('Animal(rex)');

      lua.register_class('Cat', {
        extends: 'Animal',
        construct: (name: any) => ({ name }),
        readable: true,
        metamethods: { __tostring: (self: any) => `Cat(${self.name})` },
      });
      expect(lua.execute_script(`return tostring(Cat.new('tom'))`)).toBe('Cat(tom)');
      // The base's own metamethod is untouched.
      expect(lua.execute_script(`return tostring(Animal.new('a'))`)).toBe('Animal(a)');
    });

    it('inherits operator overloads', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      lua.register_class('Base', {
        construct: (v: any) => ({ v }),
        readable: true,
        metamethods: { __add: (a: any, b: any) => ({ v: a.v + b.v }) },
      });
      lua.register_class('Derived', {
        extends: 'Base',
        construct: (v: any) => ({ v }),
        readable: true,
      });
      expect(lua.execute_script('return (Derived.new(1) + Derived.new(2)).v')).toBe(3);
    });

    it('keeps property access per class', () => {
      const lua = animals();
      expect(lua.execute_script(`return Dog.new('rex').species`)).toBe('dog');
    });

    it('chains through more than one level, nearest override winning', () => {
      const lua = animals();
      lua.register_class('Puppy', {
        extends: 'Dog',
        construct: (name: any) => ({ name, species: 'puppy' }),
        readable: true,
      });
      expect(lua.execute_script(`return Puppy.new('p'):name_of()`)).toBe('p');   // Animal
      expect(lua.execute_script(`return Puppy.new('p'):speak()`)).toBe('p barks'); // Dog
    });

    it('memoizes an inherited method without changing later lookups', () => {
      const lua = animals();
      expect(lua.execute_script(`
        local a = Dog.new('a'):name_of()
        local b = Dog.new('b'):name_of()
        return a .. ',' .. b
      `)).toBe('a,b');
    });

    it('rejects an unregistered or self-referential base class', () => {
      const lua = animals();
      expect(() => lua.register_class('X', { extends: 'Nope', construct: () => ({}) }))
        .toThrow(/'Nope' is not registered/);
      expect(() => lua.register_class('Y', { extends: 'Y', construct: () => ({}) }))
        .toThrow(/'Y' is not registered/);
      // The rejected names are not reserved by the failed attempt.
      lua.register_class('X', { construct: () => ({ v: 1 }), readable: true });
      expect(lua.execute_script('return X.new().v')).toBe(1);
    });

    it('rejects a non-string extends', () => {
      const lua = animals();
      expect(() => lua.register_class('Z', { extends: 42 as any, construct: () => ({}) }))
        .toThrow(/'extends' must be the name of a registered class/);
    });

    it('needs the chain re-registered after reset()', () => {
      const lua = animals();
      expect(lua.execute_script(`return Dog.new('rex'):name_of()`)).toBe('rex');
      lua.reset();
      expect(lua.get_global('Dog')).toBeNull();

      lua.register_class('Animal', {
        construct: (name: any) => ({ name }),
        readable: true,
        methods: { name_of: (self: any) => `re:${self.name}` },
      });
      lua.register_class('Dog', {
        extends: 'Animal',
        construct: (name: any) => ({ name }),
        readable: true,
      });
      expect(lua.execute_script(`return Dog.new('rex'):name_of()`)).toBe('re:rex');
    });
  });

  // ============================================
  // CODE REVIEW 9 REGRESSIONS
  // ============================================
  describe('code-review-9 regressions', () => {
    /** See the CR-8 block: two GC passes with settle gaps, asserting the
     *  harness provides gc so a lifetime pin fails loudly rather than
     *  self-skipping (CR-8 F2). */
    const gcSettle = async () => {
      expect(typeof global.gc, 'harness must provide --expose-gc').toBe('function');
      await new Promise((r) => setTimeout(r, 10));
      global.gc!();
      await new Promise((r) => setTimeout(r, 10));
      global.gc!();
    };

    // --- F1: reset() refuses to retire the Lua state while Lua frames are
    // live, but its guard consulted call_depth_, which only the eight
    // CallScope-bearing binding methods maintained. Every other Lua-running
    // method ran with the guard disarmed, and reset() then freed the
    // lua_State those frames were executing on: an ASan-confirmed
    // heap-use-after-free, reproduced at nine entry points. The core now owns
    // the "Lua is executing" fact (LuaRuntime::IsExecuting), so a binding
    // method cannot fail to arm it by omission.
    describe('F1: reset() cannot retire the state while Lua is executing', () => {
      /** Builds a context whose `doreset` callback tries to reset mid-Lua and
       *  reports whether the guard fired. `arm` installs the metamethod (or
       *  finalizer) that reaches the callback. */
      const guarded = (arm: string) => {
        const seen: string[] = [];
        const lua: any = new lua_native.init({
          doreset: () => {
            try { lua.reset(); seen.push('RESET RAN'); }
            catch (e: any) { seen.push(e.message); }
            return 1;
          },
        }, ALL_LIBS);
        lua.execute_script(arm);
        return { lua, seen };
      };
      const GUARD = /reset\(\) cannot be called while Lua is executing/;
      const G_INDEX = `setmetatable(_G, { __index = function(t, k) return doreset() end })`;
      const G_NEWINDEX = `setmetatable(_G, { __newindex = function(t, k, v) doreset() end })`;

      it('rejects a reset from a _G __index reached by get_global', () => {
        const { lua, seen } = guarded(G_INDEX);
        lua.get_global('missing');
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);   // process survived
      });

      it('rejects a reset from a _G __newindex reached by set_global', () => {
        const { lua, seen } = guarded(G_NEWINDEX);
        lua.set_global('brand_new_name', 1);
        expect(seen[0]).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('rejects a reset from a _G __index reached by get_global_ref', () => {
        const { lua, seen } = guarded(G_INDEX);
        try { lua.get_global_ref('missing'); } catch { /* not a table */ }
        expect(seen[0]).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it("rejects a reset from a _G __index reached by call()'s lookup", () => {
        const { lua, seen } = guarded(G_INDEX);
        // The lookup runs before the call; it resolves to a non-function, so
        // call() rejects the target afterwards. The guard is what matters.
        expect(() => lua.call('missing_fn')).toThrow(/is not a function/);
        expect(seen[0]).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('rejects a reset from a _G __newindex reached by set_userdata', () => {
        const { lua, seen } = guarded(G_NEWINDEX);
        lua.set_userdata('ud', { a: 1 }, { readable: true });
        expect(seen[0]).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('rejects a reset from a _G __newindex reached by register_class', () => {
        const { lua, seen } = guarded(G_NEWINDEX);
        lua.register_class('K', { construct: () => ({}) });
        expect(seen[0]).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('rejects a reset from a package __index reached by add_search_path', () => {
        const { lua, seen } = guarded(
          `setmetatable(package, { __index = function(t, k) return doreset() end })
           rawset(package, 'path', nil)`);
        lua.add_search_path('./?.lua');
        expect(seen[0]).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('rejects a reset from a package.searchers __newindex reached by add_searcher', () => {
        const { lua, seen } = guarded(
          `package.searchers = setmetatable(package.searchers,
             { __newindex = function(t, k, v) doreset() end })`);
        lua.add_searcher(() => null);
        expect(seen[0]).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      // The vector that needs no hostile metatable at all, and the reason this
      // was high rather than medium: an ordinary Lua __gc finalizer notifying
      // JS, plus an ordinary gc('collect').
      it('rejects a reset from a __gc finalizer reached by gc("collect")', () => {
        const { lua, seen } = guarded(
          `do local t = setmetatable({}, { __gc = function() doreset() end }) end`);
        lua.gc('collect');
        expect(seen).not.toHaveLength(0);
        expect(seen[0]).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      // A debug hook is another JS re-entry point, and it fires on paths that
      // never open a CallScope.
      it('rejects a reset from a debug hook firing inside an unscoped path', () => {
        const seen: string[] = [];
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script(`setmetatable(_G, { __index = function(t, k)
          local s = 0 for i = 1, 50000 do s = s + i end return s end })`);
        let armed = false;
        lua.set_hook(() => {
          if (!armed) return;
          armed = false;
          try { lua.reset(); seen.push('RESET RAN'); }
          catch (e: any) { seen.push(e.message); }
        }, { count: 1000 });
        armed = true;
        lua.get_global('missing');
        expect(seen[0]).toMatch(GUARD);
        lua.remove_hook();
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      // The one window the core's depth cannot see: lua_close fires the
      // outgoing state's finalizers after `runtime` already points at the
      // replacement, so a finalizer calling reset() would find depth 0.
      it('rejects a re-entrant reset from a __gc finalizer of the retiring state', () => {
        const seen: string[] = [];
        const lua: any = new lua_native.init({
          renest: () => {
            try { lua.reset(); seen.push('RESET RAN'); }
            catch (e: any) { seen.push(e.message); }
            return 1;
          },
        }, ALL_LIBS);
        lua.execute_script(`keep = setmetatable({}, { __gc = function() renest() end })`);
        lua.reset();  // the outer reset; its lua_close reaches renest()
        expect(seen).not.toHaveLength(0);
        expect(seen[0]).toMatch(/reset\(\) cannot be called re-entrantly/);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('still allows reset() once Lua has returned', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('x = 1');
        lua.reset();
        expect(lua.get_global('x')).toBeNull();
        expect(lua.execute_script('return 5')).toBe(5);
      });
    });

    // --- F1 (second consequence): the same missing CallScope meant a staged
    // js_error_registry_ entry from a raising host callback was never cleared
    // on those paths. This is the CR-8 F5 accumulation class at the
    // global-access surface it did not sweep: one pinned JS Error per failing
    // call, unbounded.
    describe('F1: staged JS errors do not accumulate on the global surface', () => {
      /** Runs `fn` N times against a _G whose metamethods throw from JS, and
       *  reports how many of the thrown Errors are still reachable. */
      const accumulate = async (fn: (lua: any, i: number) => void, n = 20) => {
        const refs: WeakRef<Error>[] = [];
        const lua: any = new lua_native.init({
          boom: () => { const e = new Error('staged'); refs.push(new WeakRef(e)); throw e; },
        }, ALL_LIBS);
        lua.execute_script(`setmetatable(_G, {
          __index    = function(t, k) return boom() end,
          __newindex = function(t, k, v) return boom() end })`);
        for (let i = 0; i < n; ++i) { try { fn(lua, i); } catch { /* expected */ } }
        await gcSettle();
        return refs.filter((r) => r.deref() !== undefined).length;
      };

      // At most one: a CallScope clears the registry when the *next* outermost
      // call starts, so the most recent entry legitimately survives — exactly
      // what the CR-8 F5 fix produces for the table handles.
      it('get_global keeps at most one staged Error alive', async () => {
        expect(await accumulate((l, i) => l.get_global('missing' + i))).toBeLessThanOrEqual(1);
      });

      it('set_global keeps at most one staged Error alive', async () => {
        expect(await accumulate((l, i) => l.set_global('brand_new' + i, 1))).toBeLessThanOrEqual(1);
      });

      it('get_global_ref keeps at most one staged Error alive', async () => {
        expect(await accumulate((l, i) => l.get_global_ref('missing' + i))).toBeLessThanOrEqual(1);
      });

      it('call keeps at most one staged Error alive', async () => {
        expect(await accumulate((l, i) => l.call('missing_fn' + i))).toBeLessThanOrEqual(1);
      });
    });

    // --- F2: BeginExecutionBudget ran only in ProtectedCall and the two
    // lua_resume sites, so every metamethod-driven path (table handles, Proxy
    // traps, metatabled _G access) executed Lua against whatever deadline and
    // instruction tally the previous execution left behind. The budget is now
    // started by ExecutionScope at the outermost entry, wherever that is.
    describe('F2: the execution budget starts wherever Lua starts running', () => {
      /** A table whose __index burns roughly 20k VM instructions per read —
       *  enough to fire the count hook, nowhere near the limits used below. */
      const COSTLY_INDEX = `t = setmetatable({}, { __index = function(tbl, k)
        local s = 0 for i = 1, 20000 do s = s + i end return s end })`;

      it('does not abort a table-handle read against a stale deadline', async () => {
        const lua: any = new lua_native.init({}, { ...ALL_LIBS, timeout: 200 });
        lua.execute_script(COSTLY_INDEX);
        const h = lua.get_global_ref('t');
        // Idle well past the deadline the arming execute_script set. Before the
        // fix this read aborted with "execution timeout" after microseconds.
        await new Promise((r) => setTimeout(r, 400));
        expect(h.get('anything')).toBe(200010000);
      });

      it('does not accumulate the instruction tally across table-handle reads', () => {
        const lua: any = new lua_native.init({}, { ...ALL_LIBS, maxInstructions: 200_000 });
        lua.execute_script(COSTLY_INDEX);
        const h = lua.get_global_ref('t');
        for (let i = 0; i < 30; ++i) expect(h.get('k' + i)).toBe(200010000);
      });

      it('does not accumulate the instruction tally across Proxy-trap reads', () => {
        const lua: any = new lua_native.init({}, { ...ALL_LIBS, maxInstructions: 200_000 });
        lua.execute_script(COSTLY_INDEX);
        const proxy: any = lua.get_global('t');
        for (let i = 0; i < 30; ++i) expect(proxy['k' + i]).toBe(200010000);
      });

      it('does not accumulate the instruction tally across get_global reads', () => {
        const lua: any = new lua_native.init({}, { ...ALL_LIBS, maxInstructions: 200_000 });
        lua.execute_script(`setmetatable(_G, { __index = function(t, k)
          local s = 0 for i = 1, 20000 do s = s + i end return s end })`);
        for (let i = 0; i < 30; ++i) expect(lua.get_global('missing' + i)).toBe(200010000);
      });

      // The limits must still bind on those paths: the defect was mistimed
      // enforcement, never an escape, and the fix must not turn it into one.
      it('still aborts an endless metamethod reached through a table handle', () => {
        const lua: any = new lua_native.init({}, { ...ALL_LIBS, timeout: 250 });
        lua.execute_script(`t = setmetatable({}, { __index = function() while true do end end })`);
        const h = lua.get_global_ref('t');
        expect(() => h.get('x')).toThrow(/execution timeout/);
      });

      it('still aborts an endless metamethod reached through get_global', () => {
        const lua: any = new lua_native.init({}, { ...ALL_LIBS, maxInstructions: 500_000 });
        lua.execute_script(`setmetatable(_G, { __index = function() while true do end end })`);
        expect(() => lua.get_global('missing')).toThrow(/instruction limit exceeded/);
      });

      // A nested entry shares the enclosing budget rather than refreshing it,
      // so re-entry can no longer extend a limit the outer execution is
      // already spending.
      it('a re-entrant execute_script does not refresh the enclosing budget', () => {
        const lua: any = new lua_native.init({
          reenter: () => { lua.execute_script('return 1'); return 1; },
        }, { ...ALL_LIBS, maxInstructions: 300_000 });
        expect(() => lua.execute_script(
          'while true do reenter() end')).toThrow(/instruction limit exceeded/);
      });
    });

    // --- F3: reset() replayed add_search_path but silently dropped
    // add_searcher, so the two halves of module resolution behaved
    // differently across a reset.
    describe('F3: reset() replays JS searchers', () => {
      it('resolves through a searcher registered before the reset', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.add_searcher((name: string) =>
          name === 'jsmod' ? 'return { v = 99 }' : null);
        expect(lua.execute_script('return require("jsmod").v')).toBe(99);
        lua.reset();
        expect(lua.execute_script('return require("jsmod").v')).toBe(99);
      });

      it('replays several searchers, in order, across repeated resets', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.add_searcher((n: string) => (n === 'a' ? 'return 1' : null));
        lua.add_searcher((n: string) => (n === 'b' ? 'return 2' : null));
        for (let i = 0; i < 3; ++i) {
          lua.reset();
          // Bind first: require() returns the module *and* the loader data, so
          // a bare `return require(...)` would marshal as a two-element array.
          expect(lua.execute_script('local m = require("a") return m')).toBe(1);
          expect(lua.execute_script('local m = require("b") return m')).toBe(2);
        }
      });

      it('does not replay a searcher whose registration failed', () => {
        // No 'package' library: add_searcher throws and records nothing, so a
        // later reset must not resurrect it.
        const lua: any = new lua_native.init({}, { libraries: ['base'] });
        expect(() => lua.add_searcher(() => null)).toThrow(/package.*not loaded/);
        expect(() => lua.reset()).not.toThrow();
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });

    // --- F4: the output handler is invoked through a copied owner and with
    // full exception containment, the discipline the debug hook documents for
    // itself. Previously a handler that cleared itself mid-call destroyed the
    // std::function it was executing on — benign only because the capture list
    // happened to fit libc++'s small-buffer optimization.
    describe('F4: the output handler survives self-modification', () => {
      it('survives a print handler that clears itself mid-call', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const seen: string[] = [];
        lua.set_print_handler((t: string) => {
          seen.push(t);
          if (seen.length === 2) lua.set_print_handler(null);
        });
        lua.execute_script('print("a") print("b") print("c") print("d")');
        expect(seen).toEqual(['a\n', 'b\n']);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('survives a print handler that replaces itself mid-call', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const seen: string[] = [];
        const second = (t: string) => seen.push('2:' + t.trim());
        lua.set_print_handler((t: string) => {
          seen.push('1:' + t.trim());
          if (seen.length === 2) lua.set_print_handler(second);
        });
        lua.execute_script('print("a") print("b") print("c")');
        expect(seen).toEqual(['1:a', '1:b', '2:c']);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('survives an io.write handler that clears itself mid-call', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const seen: string[] = [];
        lua.set_print_handler((t: string) => {
          seen.push(t);
          if (seen.length === 2) lua.set_print_handler(null);
        });
        lua.execute_script('io.write("a") io.write("b") io.write("c")');
        expect(seen).toEqual(['a', 'b']);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('contains a throwing print handler rather than corrupting the VM', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_print_handler(() => { throw new Error('handler blew up'); });
        expect(() => lua.execute_script('print("x") return 1')).not.toThrow();
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });
  });

  // --- CODE-REVIEW-10 regressions ---------------------------------------
  //
  // CR-9 moved the "Lua is executing" invariant into the core, which was right.
  // CR-10 is about where that relocation stopped: the invariant was stated as
  // "a path that can run Lua", and the actual hazard is "a path that can
  // allocate from Lua" — an allocation drives a GC step, a GC step runs __gc
  // finalizers, and a finalizer is Lua that re-enters the host.
  describe('CODE-REVIEW-10 regressions', () => {

    // F1: the chunk loaders allocate continuously while parsing, so a GC step
    // inside luaL_loadbuffer / luaL_loadfile can reach a __gc finalizer. On
    // compile / compile_file / execute_async neither the core nor the binding
    // had a scope open, so reset()'s guard was entirely disarmed and the
    // lua_State was freed under the parser (ASan: heap-use-after-free).
    describe('F1: a chunk load is an execution too', () => {
      const GUARD = /reset\(\) cannot be called while Lua is executing/;

      /** A chunk long enough that parsing it drives a GC step. */
      const bigChunk = () =>
        'local x = 0\n' + 'x = x + 1\n'.repeat(4000) + 'return x';

      /** Builds a context with pending finalizers that call back into JS, and
       *  reports what each attempted reset() saw. `armed` gates recording to
       *  the load under test, so an earlier execution can't answer for it. */
      const withPendingFinalizers = () => {
        const seen: string[] = [];
        let armed = false;
        const lua: any = new lua_native.init({
          doreset: () => {
            if (armed) {
              try { lua.reset(); seen.push('RESET RAN'); }
              catch (e: any) { seen.push(e.message); }
            }
            return 1;
          },
        }, ALL_LIBS);
        lua.execute_script(
          `function mk(n)
             for i = 1, n do
               local t = setmetatable({}, { __gc = function() doreset() end })
               t = nil
             end
           end`);
        lua.execute_script('mk(400)');   // leave GC work pending
        return { lua, seen, arm: () => { armed = true; } };
      };

      it('rejects a reset from a __gc finalizer reached by compile()', () => {
        const { lua, seen, arm } = withPendingFinalizers();
        arm();
        const big = bigChunk();
        for (let i = 0; i < 20 && seen.length === 0; i++) lua.compile(big);
        expect(seen, 'no finalizer ran during the parse').not.toHaveLength(0);
        expect(seen.every((m) => GUARD.test(m))).toBe(true);
        expect(lua.execute_script('return 1 + 1')).toBe(2);   // process survived
      });

      it('rejects a reset from a __gc finalizer reached by compile_file()', () => {
        const { lua, seen, arm } = withPendingFinalizers();
        const file = path.join(os.tmpdir(), 'lua-native-cr10-compile-file.lua');
        fs.writeFileSync(file, bigChunk());
        try {
          arm();
          for (let i = 0; i < 20 && seen.length === 0; i++) lua.compile_file(file);
        } finally {
          fs.rmSync(file, { force: true });
        }
        expect(seen, 'no finalizer ran during the parse').not.toHaveLength(0);
        expect(seen.every((m) => GUARD.test(m))).toBe(true);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      // execute_async loads its chunk before setting is_busy_, so this window
      // was guarded by nothing at all.
      it('rejects a reset from a __gc finalizer reached by execute_async()', async () => {
        const { lua, seen, arm } = withPendingFinalizers();
        arm();
        const big = bigChunk();
        for (let i = 0; i < 20 && seen.length === 0; i++) await lua.execute_async(big);
        expect(seen, 'no finalizer ran during the parse').not.toHaveLength(0);
        expect(seen.every((m) => GUARD.test(m))).toBe(true);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      // A chunk load is not an execution: the scope must close with the load,
      // or reset() would be wedged for the life of the context.
      it('leaves the guard disarmed once the load has returned', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.compile('return 1');
        expect(() => lua.reset()).not.toThrow();
        // A *failed* load must unwind the scope too, not leave the depth raised.
        expect(() => lua.compile('this is not lua at all')).toThrow(/syntax error/);
        expect(() => lua.reset()).not.toThrow();
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });

    // F2: the host-function wrappers are stored on the runtime and capture the
    // context. The runtime outlives the context whenever a handle holds a share
    // of it, so lua_close — and the __gc metamethods it fires — can dispatch
    // into a LuaContext whose members are already destroyed. Every other
    // cross-boundary holder carries a liveness flag; these never did.
    describe('F2: the JS-callback bridge must not outlive its context', () => {

      // The reproduction, mid-program rather than at process exit: a table
      // handle keeps the runtime alive past the context, so dropping it runs
      // lua_close at an arbitrary GC point.
      it('survives a __gc finalizer that calls JS after its context is collected', async () => {
        expect(typeof global.gc, 'harness must provide --expose-gc').toBe('function');

        let handle: any = null;
        (() => {
          const lua: any = new lua_native.init({ log: () => 1 }, ALL_LIBS);
          lua.execute_script(
            `_G.keep = setmetatable({}, { __gc = function() log("late") end })`);
          handle = lua.create_table({ a: 1 });   // holds a share of the runtime
        })();

        global.gc!();
        await new Promise((r) => setTimeout(r, 20));
        global.gc!();                            // context collected

        handle = null;
        global.gc!();
        await new Promise((r) => setTimeout(r, 20));
        global.gc!();                            // lua_close runs here

        // Reaching this line at all is the assertion: before the fix the
        // finalizer dispatched into the freed context and killed the process.
        const fresh: any = new lua_native.init({}, ALL_LIBS);
        expect(fresh.execute_script('return 1 + 1')).toBe(2);
      });

      // The same shape via a class instance, whose constructor wrapper captures
      // the context in exactly the same way.
      it('survives a class-instance finalizer after its context is collected', async () => {
        expect(typeof global.gc, 'harness must provide --expose-gc').toBe('function');

        let handle: any = null;
        (() => {
          const lua: any = new lua_native.init({}, ALL_LIBS);
          lua.register_class('Res', { construct: () => ({ n: 1 }) });
          lua.execute_script(`_G.keep = Res.new()`);
          handle = lua.create_table({ a: 1 });
        })();

        global.gc!();
        await new Promise((r) => setTimeout(r, 20));
        global.gc!();
        handle = null;
        global.gc!();
        await new Promise((r) => setTimeout(r, 20));
        global.gc!();

        const fresh: any = new lua_native.init({}, ALL_LIBS);
        expect(fresh.execute_script('return 1 + 1')).toBe(2);
      });

      // The control that pins the fix's *shape*: unbinding must be tied to the
      // context dying, not to the runtime dying. reset() also destroys a
      // runtime, and the state it retires must still be able to run its own
      // finalizers against the (live) context.
      it('still lets the retiring state reach JS during reset()', () => {
        const seen: string[] = [];
        const lua: any = new lua_native.init(
          { log: (m: string) => { seen.push(m); return 1; } }, ALL_LIBS);
        lua.execute_script(
          `_G.keep = setmetatable({}, { __gc = function() log("closing") end })`);
        lua.reset();
        expect(seen).toEqual(['closing']);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      // Ordinary callbacks must be entirely unaffected by the liveness check.
      it('leaves normal callbacks and finalizers working', () => {
        const seen: string[] = [];
        const lua: any = new lua_native.init(
          { log: (m: string) => { seen.push(m); return 1; } }, ALL_LIBS);
        lua.execute_script(`log("direct")`);
        lua.execute_script(
          `do local t = setmetatable({}, { __gc = function() log("collected") end }) end`);
        lua.gc('collect');
        expect(seen).toEqual(['direct', 'collected']);
      });
    });

    // F3: only the collecting lua_gc commands run finalizers, so only they are
    // an execution. Bracketing the read-only ones made IsExecuting() mean less
    // than it says and needlessly restarted the per-execution budget.
    describe('F3: read-only gc() commands are not executions', () => {
      it('does not restart the instruction budget', () => {
        const lua: any = new lua_native.init(
          { peek: () => { lua.gc('count'); return 1; } },
          { libraries: 'all', maxInstructions: 200000 });
        // If gc('count') refreshed the budget this loop would never be aborted.
        expect(() => lua.execute_script('while true do peek() end'))
          .toThrow(/instruction limit exceeded/);
      });

      it('still guards the collecting commands', () => {
        const seen: string[] = [];
        const lua: any = new lua_native.init({
          doreset: () => {
            try { lua.reset(); seen.push('RESET RAN'); }
            catch (e: any) { seen.push(e.message); }
            return 1;
          },
        }, ALL_LIBS);
        lua.execute_script(
          `do local t = setmetatable({}, { __gc = function() doreset() end }) end`);
        lua.gc('collect');
        expect(seen).not.toHaveLength(0);
        expect(seen[0]).toMatch(/reset\(\) cannot be called while Lua is executing/);
      });
    });
  });

  // --- CODE-REVIEW-11 regressions ---------------------------------------
  //
  // Three of these pin *shapes* rather than behaviours, and the shape matters:
  //  * F1 needs TWO registered converters. A range-for caches end() at loop
  //    entry, so with one converter the invalidated cursor still compares equal
  //    and the bug is invisible. A one-converter test passes without the fix.
  //  * F2 needs a Promise-returning callback. With a plain return the compiler
  //    may keep the captured `this` in a register across the JS call, so the
  //    use-after-free reads nothing freed. The Promise path forces a reload of
  //    the captured name string, whose buffer is a separate heap block.
  //  * F4 needs the working M2 path alongside it as a control, or a harness
  //    that has stopped collecting would report a pass for the wrong reason.
  describe('CODE-REVIEW-11 regressions', () => {
    const gcSettle = async () => {
      expect(typeof global.gc, 'harness must provide --expose-gc').toBe('function');
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 10));
        global.gc!();
      }
    };

    // --- F1: both converter loops iterated their vector by reference while
    // calling user JS that can register another converter, reallocating it.
    // CR-2 fixed this with an indexed loop; two later style commits reverted it
    // to a range-for while leaving the explanatory comment in place.
    describe('F1: a converter registered from inside a converter', () => {
      it('does not corrupt the JS->Lua converter loop', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        // Two converters: the first grows the vector and declines, so the loop
        // must still advance to the second one with a valid cursor.
        lua.register_type_converter(
          () => {
            for (let i = 0; i < 16; i++) {
              lua.register_type_converter(() => false, (x: any) => x);
            }
            return false;
          },
          (v: any) => v);
        lua.register_type_converter(() => false, (v: any) => v);

        lua.set_global('probe', { a: 1 });
        expect(lua.get_global('probe')).toEqual({ a: 1 });
      });

      it('does not corrupt the Lua->JS converter loop', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_from_lua_converter(
          () => {
            for (let i = 0; i < 16; i++) {
              lua.register_from_lua_converter(() => false, (x: any) => x);
            }
            return false;
          },
          (v: any) => v);
        lua.register_from_lua_converter(() => false, (v: any) => v);

        expect(lua.execute_script('return {a=1}')).toEqual({ a: 1 });
      });

      it('still applies a converter registered mid-loop on the next conversion', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_type_converter(
          (v: any) => {
            if (!lua.__armed) {
              lua.__armed = true;
              lua.register_type_converter(
                (x: any) => x && x.__tag === 'late',
                (x: any) => `converted:${x.v}`);
            }
            return false;
          },
          (v: any) => v);
        lua.register_type_converter(() => false, (v: any) => v);

        lua.set_global('first', { __tag: 'late', v: 1 });   // arms it, too late for itself
        lua.set_global('second', { __tag: 'late', v: 2 });  // now the new converter applies
        expect(lua.get_global('second')).toBe('converted:2');
      });
    });

    // --- F2: re-registering a host function under a name that is currently
    // executing move-assigned over the std::function being run, destroying its
    // captures. The CR-9 F4 rule ("don't destroy the callable you're inside"),
    // which had been applied to the print handler and the debug hook but not to
    // the host-function map.
    describe('F2: a JS callback that replaces itself mid-call', () => {
      it('survives when the in-flight call then uses its captured name', () => {
        const lua: any = new lua_native.init({
          foo: () => {
            lua.set_global('foo', (x: number) => x * 2);
            // Returning a Promise outside execute_async makes the wrapper build
            // an error message from its captured name — the read that faulted.
            return Promise.resolve(1);
          },
        }, ALL_LIBS);

        expect(() => lua.execute_script('return foo(1)')).toThrow(/returned a Promise/);
        // The replacement is in effect for the next call, not this one.
        expect(lua.execute_script('return foo(21)')).toBe(42);
      });

      it('survives when the in-flight call then converts a result', () => {
        const lua: any = new lua_native.init({
          bar: (n: number) => {
            lua.set_global('bar', (x: number) => ({ ok: x * 10 }));
            return { ok: n + 1 };
          },
        }, ALL_LIBS);

        expect(lua.execute_script('return bar(1)')).toEqual({ ok: 2 });
        expect(lua.execute_script('return bar(4)')).toEqual({ ok: 40 });
      });

      it('replacing a different name from inside a callback still works', () => {
        const lua: any = new lua_native.init({
          outer: () => { lua.set_global('inner', () => 'replaced'); return 'outer'; },
          inner: () => 'original',
        }, ALL_LIBS);

        expect(lua.execute_script('return inner()')).toBe('original');
        expect(lua.execute_script('return outer()')).toBe('outer');
        expect(lua.execute_script('return inner()')).toBe('replaced');
      });

      it('a metamethod callback that replaces a global mid-call survives', () => {
        const lua: any = new lua_native.init({
          swap: () => { lua.set_global('swap', () => 2); return 1; },
        }, ALL_LIBS);
        lua.execute_script('t = {}');
        lua.set_metatable('t', { __index: () => lua.execute_script('return swap()') });
        expect(lua.execute_script('return t.anything')).toBe(1);
        expect(lua.execute_script('return swap()')).toBe(2);
      });
    });

    // --- F4: set_metatable / register_module minted a fresh host-function name
    // on every call and never released the previous generation's, and
    // set_userdata never released its method callbacks even once the userdata
    // was collected. Each pinned the JS closure (and its captured scope) for the
    // life of the context.
    describe('F4: superseded registrations release their callbacks', () => {
      it('releases the previous metatable generation', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('t = {}');
        const refs: WeakRef<object>[] = [];
        for (let i = 0; i < 20; i++) {
          const fn = function idx() { return i; };
          refs.push(new WeakRef(fn));
          lua.set_metatable('t', { __index: fn });
        }
        lua.gc('collect');
        lua.gc('collect');
        await gcSettle();
        // Every superseded generation is released; the one still installed on
        // `t` is not. (Checked as "all but the last" rather than a raw count:
        // V8 routinely keeps the final loop value reachable a little longer,
        // which would make a bare count flaky in the other direction.)
        expect(refs.slice(0, -1).filter((r) => r.deref())).toHaveLength(0);
        expect(refs[refs.length - 1].deref()).toBeDefined();
        // ...and the installed generation still works.
        expect(lua.execute_script('return t.anything')).toBe(19);
      });

      it('releases the previous module generation', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const refs: WeakRef<object>[] = [];
        for (let i = 0; i < 20; i++) {
          const fn = function mf() { return i; };
          refs.push(new WeakRef(fn));
          lua.register_module('m', { f: fn });
        }
        lua.gc('collect');
        lua.gc('collect');
        await gcSettle();
        expect(refs.slice(0, -1).filter((r) => r.deref())).toHaveLength(0);
        expect(refs[refs.length - 1].deref()).toBeDefined();
        expect(lua.execute_script("return require('m').f()")).toBe(19);
      });

      it('releases a collected userdata\'s method callbacks', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const refs: WeakRef<object>[] = [];
        for (let i = 0; i < 20; i++) {
          const m = function meth() { return i; };
          refs.push(new WeakRef(m));
          lua.set_userdata('u' + i, {}, { methods: { go: m } });
          lua.execute_script(`u${i} = nil`);
        }
        lua.gc('collect');
        lua.gc('collect');
        await gcSettle();
        // "All but the last": see the metatable case for why the final loop
        // value is excluded.
        expect(refs.slice(0, -1).filter((r) => r.deref())).toHaveLength(0);
      });

      it('a live userdata keeps its methods (the fix must not over-collect)', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('u', {}, { methods: { go: () => 'still here' } });
        lua.gc('collect');
        lua.gc('collect');
        await gcSettle();
        expect(lua.execute_script('return u:go()')).toBe('still here');
      });

      it('control: the M2 reclaimable path is still reclaiming', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const refs: WeakRef<object>[] = [];
        for (let i = 0; i < 20; i++) {
          const fn = function anon() { return i; };
          refs.push(new WeakRef(fn));
          lua.set_global('tmp', { cb: fn });
        }
        lua.set_global('tmp', null);
        lua.gc('collect');
        lua.gc('collect');
        await gcSettle();
        expect(refs.slice(0, -1).filter((r) => r.deref())).toHaveLength(0);
      });

      it('a failed set_metatable still strands nothing (CR-8 F3 ordering intact)', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const wr = (() => {
          const fn = () => 42;
          const ref = new WeakRef(fn);
          expect(() => lua.set_metatable('no_such_global', { __index: fn }))
            .toThrow(/does not exist/);
          return ref;
        })();
        await gcSettle();
        expect(wr.deref()).toBeUndefined();
      });
    });

    // --- F3 (binding half). The core-level pins live in the C++ suite, since
    // every binding entry point masks the gap with its own CallScope. What is
    // checkable here is that the mode switches still behave and that the guard
    // they lost is back.
    describe('F3: gc() mode switches run finalizers under the guard', () => {
      it('rejects reset() from a finalizer reached by gc(\'generational\')', () => {
        const seen: string[] = [];
        const lua: any = new lua_native.init({
          doreset: () => {
            try { lua.reset(); seen.push('RESET RAN'); }
            catch (e: any) { seen.push(e.message); }
            return 1;
          },
        }, ALL_LIBS);
        lua.execute_script(
          `function mk(n) for i=1,n do
             local t = setmetatable({}, { __gc = function() doreset() end }); t = nil
           end end`);
        lua.execute_script('mk(300)');
        lua.gc('generational');
        expect(seen).not.toHaveLength(0);
        expect(seen.every((m) => /reset\(\) cannot be called while Lua is executing/.test(m)))
          .toBe(true);
      });

      it('still reports the previous collector mode', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.gc('incremental');
        expect(lua.gc('generational')).toBe('incremental');
        expect(lua.gc('incremental')).toBe('generational');
      });
    });
  });

  // --- CODE-REVIEW-12 regressions ---------------------------------------
  describe('CODE-REVIEW-12 regressions', () => {

    /** Two GC passes with settle gaps; see the CR-8 F2 helper. */
    const gcSettle = async () => {
      expect(typeof global.gc, 'harness must provide --expose-gc').toBe('function');
      await new Promise((r) => setTimeout(r, 10));
      global.gc!();
      await new Promise((r) => setTimeout(r, 10));
      global.gc!();
    };

    // F4: reset() deliberately lets the retiring runtime's __gc finalizers reach
    // the still-live context (CR-10's contract). The host-function wrappers they
    // dispatch through capture the *context*, so a callback throwing from one
    // staged its structured error via `runtime` — which by then points at the
    // replacement. The raise happened on the old state, the staging landed on
    // the new one, and the new runtime was left holding a pending error value
    // from an execution on a different Lua state.
    //
    // CR-12 called this unreachable ("I could not construct a consumer"). It is
    // not: the consumer is any later host-call failure that raises *without*
    // staging, because the bridge's catch prefers a pending value over its own
    // message. Returning a Promise outside execute_async() is exactly such a
    // path — before the fix, this reports "from the retired generation".
    it('F4: a retired state\'s finalizer does not strand a staged error on the live runtime',
      async () => {
        const seen: string[] = [];
        const lua: any = new lua_native.init({
          thrower: () => {
            seen.push('finalizer callback ran');
            throw new Error('from the retired generation');
          },
          promiser: () => Promise.resolve(1),
        }, ALL_LIBS);

        lua.execute_script(
          '_G.keep = setmetatable({}, { __gc = function() thrower() end })');
        // A live handle keeps the retiring runtime alive past reset(), so its
        // finalizers run later — after `runtime` already points at the new state.
        let handle: any = lua.create_table({ a: 1 });
        lua.reset();
        handle = null;
        await gcSettle();
        expect(seen, 'the retired state\'s finalizer never ran').not.toHaveLength(0);

        // The live runtime must be holding nothing: this failure stages no value
        // of its own, so a stranded one would be raised in its place.
        expect(() => lua.execute_script('return promiser()'))
          .toThrow(/returned a Promise/);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

    // F2: RegisterClass's metamethod loop, its class `new`, and RegisterFunction
    // pushed their own bare closures instead of going through
    // PushHostFunctionClosure, whose comment claimed to be the single place a
    // host-function name becomes a closure. Routing them through is
    // behaviour-preserving by construction (none of those names is reclaimable,
    // so the helper builds the identical one-upvalue closure) — these pin that
    // the three name families still work through the helper.
    describe('F2: the closure builder is shared by every host-function name', () => {
      it('class metamethods and constructors still dispatch', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_class('Vec', {
          construct: (x: number) => ({ x }),
          methods: { get: (self: any) => self.x },
          metamethods: {
            __add: (a: any, b: any) => ({ x: a.x + b.x }),
            __tostring: (self: any) => `Vec(${self.x})`,
          },
        });
        expect(lua.execute_script('local v = Vec.new(7); return v:get()')).toBe(7);
        // __add returns a plain object, so the sum arrives as a plain table.
        expect(lua.execute_script('return (Vec.new(2) + Vec.new(3)).x')).toBe(5);
        expect(lua.execute_script('return tostring(Vec.new(4))')).toBe('Vec(4)');
      });

      it('set_global functions still dispatch, and replacing one still works', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_global('f', (n: number) => n + 1);
        expect(lua.execute_script('return f(1)')).toBe(2);
        lua.set_global('f', (n: number) => n * 10);
        expect(lua.execute_script('return f(4)')).toBe(40);
      });
    });

    // F5: Propagate read the shared value once, before the push loop, which
    // CR-12 read as leaving later targets a generation behind when a push
    // re-enters set()/sync(). This pins the behaviour rather than the fix: it
    // passes with the snapshot too (verified), because set() mutates the object
    // value_ holds instead of replacing it. It is here so that if that ever
    // changes, the staleness shows up as a failing test rather than as a silent
    // divergence between two contexts.
    it('F5: a re-entrant shared-table update leaves every context on the newest value', () => {
      const shared: any = lua_native.createSharedTable({ n: 1 });
      let reentered = false;
      // The first context's converter re-enters on the first push only.
      const a: any = new lua_native.init({}, { ...ALL_LIBS, shared: { cfg: shared } });
      const b: any = new lua_native.init({}, { ...ALL_LIBS, shared: { cfg: shared } });
      a.register_type_converter(
        (v: any) => !reentered && typeof v === 'object' && v !== null && v.n === 2,
        (v: any) => { reentered = true; shared.set('n', 3); return v; });

      shared.set('n', 2);
      expect(reentered, 'the converter never re-entered').toBe(true);
      // Both states must agree on the newest value, whoever wrote it.
      expect(a.execute_script('return cfg.n')).toBe(3);
      expect(b.execute_script('return cfg.n')).toBe(3);
    });
  });

  // --- CODE-REVIEW-13 regressions ---------------------------------------
  //
  // F1: reset() is guarded by IsExecuting() (Lua is running) and call_depth_
  // (a binding method is on the stack). Every method opened the second guard
  // around its *call into Lua* — but a method starts by running user JS:
  // converters, definition-object getters, Proxy traps. reset() was legal in
  // that window, and a method caught mid-flight then finished its work against
  // a state that no longer existed. `handle.pairs()` had no guard at all and
  // produced handles pairing the new runtime with the old state's registry
  // refs: silent reads and writes onto unrelated live tables, and an
  // ASan-confirmed use-after-free of the retired lua_State at finalization.
  //
  // Every door below is pinned the same way: make the method's first piece of
  // user JS call reset(), and require the call to be refused.
  describe('CODE-REVIEW-13 regressions', () => {

    const GUARD = /reset\(\) cannot be called (while Lua is executing|from inside another lua-native call)/;

    describe('F1: reset() is refused while a binding method runs user JS', () => {
      /** Calls reset() and returns the rejection message, or 'RESET RAN'. */
      const tryReset = (lua: any) => {
        try { lua.reset(); return 'RESET RAN'; }
        catch (e: any) { return e.message as string; }
      };

      it('handle.pairs(): a Lua->JS converter cannot retire the state mid-conversion', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script(`
          _G.root = {
            a = { plain = 1 },
            b = setmetatable({ marked = 'OLD' }, { __index = function() return nil end }),
          }
        `);
        let saw = 'converter never ran';
        lua.register_from_lua_converter(
          (v: any) => typeof v === 'object' && v !== null && v.plain === 1,
          (v: any) => { saw = tryReset(lua); return v; });

        const entries = lua.get_global_ref('root').pairs();
        expect(saw, 'the converter never ran').not.toBe('converter never ran');
        expect(saw).toMatch(GUARD);

        // The state survived, so the metatabled entry is still bound to it and
        // reads its own object rather than an unrelated registry slot.
        const b = entries.find(([k]: [string]) => k === 'b')[1];
        expect(b.marked).toBe('OLD');
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('set_metatable(): a definition getter cannot retire the state mid-read', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const target = lua.create_table({ tag: 'TARGET' });
        let saw = 'getter never ran';
        expect(() => lua.set_metatable(target, {
          get __index() { saw = tryReset(lua); return () => 'x'; },
        })).not.toThrow();
        expect(saw).toMatch(GUARD);
        expect(target.get('tag')).toBe('TARGET');
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('register_class(): a definition getter cannot defeat the duplicate guard', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let saw = 'getter never ran';
        lua.register_class('Foo', {
          construct: () => ({ v: 1 }),
          methods: { get: (self: any) => self.v },
          get metamethods() { saw = tryReset(lua); return undefined; },
        });
        expect(saw).toMatch(GUARD);
        // The reservation survived, so L7 still rejects the second registration
        // and the class is not a half-merge of two definitions.
        expect(() => lua.register_class('Foo', { construct: () => ({ v: 2 }) }))
          .toThrow(/already registered/);
        expect(lua.execute_script('local o = Foo.new(); return o:get()')).toBe(1);
      });

      it('set_userdata(): a methods getter cannot retire the state mid-read', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let saw = 'getter never ran';
        lua.set_userdata('u', { x: 1 }, {
          methods: { get m() { saw = tryReset(lua); return () => 1; } },
        });
        expect(saw).toMatch(GUARD);
        expect(lua.execute_script('return u:m()')).toBe(1);
      });

      it('register_module(): a member getter cannot retire the state mid-read', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let saw = 'getter never ran';
        lua.register_module('m', { get f() { saw = tryReset(lua); return () => 7; } });
        expect(saw).toMatch(GUARD);
        expect(lua.execute_script("return require('m').f()")).toBe(7);
      });

      it('set_hook(): an options getter cannot retire the state mid-read', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let saw = 'getter never ran';
        lua.set_hook(() => {}, { get count() { saw = tryReset(lua); return 1000; } });
        expect(saw).toMatch(GUARD);
        lua.remove_hook();
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('a Lua-function handle call: an argument converter cannot retire the state', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const f: any = lua.execute_script('return function(a) return a end');
        let saw = 'converter never ran';
        lua.register_type_converter(
          (v: any) => typeof v === 'object' && v !== null && v.trip === true,
          () => { saw = tryReset(lua); return 1; });
        expect(f({ trip: true })).toBe(1);
        expect(saw).toMatch(GUARD);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('reports the two guard conditions distinctly', () => {
        // call_depth_ only: no Lua is running inside a result converter.
        const a: any = new lua_native.init({}, ALL_LIBS);
        let fromJs = '';
        a.register_from_lua_converter(
          (v: any) => typeof v === 'object' && v !== null && v.plain === 1,
          (v: any) => { try { a.reset(); } catch (e: any) { fromJs = e.message; } return v; });
        a.execute_script('_G.r = { x = { plain = 1 } }');
        a.get_global_ref('r').pairs();
        expect(fromJs).toMatch(/from inside another lua-native call/);

        // IsExecuting(): a host callback, with Lua genuinely on the stack.
        let fromLua = '';
        const b: any = new lua_native.init({
          hit: () => { try { b.reset(); } catch (e: any) { fromLua = e.message; } return 1; },
        }, ALL_LIBS);
        b.execute_script('hit()');
        expect(fromLua).toMatch(/while Lua is executing/);
      });
    });

    // F2: cancel() on a worker run takes effect whenever the instruction
    // count-hook is installed — which InstallExecutionHook does for any of
    // maxInstructions, timeout, or a counting debug hook. Three documents said
    // "only when maxInstructions is set"; a timeout-only run cancels.
    it('F2: cancel() interrupts a worker run with only a timeout configured', async () => {
      const lua: any = new lua_native.init({}, { ...ALL_LIBS, timeout: 60_000 });
      const run = lua.execute_script_async('local i = 0 while true do i = i + 1 end');
      await new Promise((r) => setTimeout(r, 50));
      lua.cancel();
      await expect(run).rejects.toThrow(/execution cancelled/);
      expect(lua.is_busy()).toBe(false);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    it('F2: a worker run with no limits configured has no hook to interrupt it', async () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      const run = lua.execute_script_async('local i = 0 for k = 1, 3e6 do i = i + 1 end return i');
      lua.cancel();                       // no hook installed: nothing to poll
      await expect(run).resolves.toBe(3e6);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });
  });

  describe('CODE-REVIEW-14 regressions', () => {

    const GUARD14 =
      /reset\(\) cannot be called (while Lua is executing|from inside another lua-native call|(?:.*)busy)|busy with an async operation/;

    // --- F1: the worker-async completion callbacks marshal their results AFTER
    // clearing is_busy_ and opened no CallScope, so a Lua->JS converter could
    // retire the state mid-marshal. The values still being converted belong to
    // the retired state: the remaining ones were wrapped as handles pairing the
    // NEW runtime with the OLD state's registry refs — silent reads/writes onto
    // unrelated live objects, and an ASan-confirmed use-after-free of the
    // retired lua_State at finalization. Same class as CR-13 F1, at an entry
    // point that is not a binding method.
    describe('F1: reset() is refused while an async run marshals its results', () => {
      /** A converter that resets on first call; returns what reset() did. */
      const resettingConverter = (lua: any, seen: { value: string }) => {
        lua.register_from_lua_converter(
          (_v: any) => {
            if (seen.value === 'converter never ran') {
              try { lua.reset(); seen.value = 'RESET RAN'; }
              catch (e: any) { seen.value = e.message; }
            }
            return false;
          },
          (v: any) => v);
      };

      it('execute_script_async: a Lua->JS converter cannot retire the state mid-marshal', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const seen = { value: 'converter never ran' };
        resettingConverter(lua, seen);

        const res = await lua.execute_script_async(
          `return setmetatable({tag='A'},{}), setmetatable({tag='B'},{})`);

        expect(seen.value, 'the converter never ran').not.toBe('converter never ran');
        expect(seen.value).toMatch(GUARD14);
        // The decisive assertion: the SECOND value is converted after the point
        // the reset would have landed. It must still name its own object in the
        // state it was created on, not an unrelated slot in a fresh registry.
        expect(res[0].tag).toBe('A');
        expect(res[1].tag).toBe('B');
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('execute_file_async: same guard on the file worker', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const seen = { value: 'converter never ran' };
        resettingConverter(lua, seen);

        const res = await lua.execute_file_async(
          path.join(__dirname, '../fixtures/return-metatabled.lua'));

        expect(seen.value, 'the converter never ran').not.toBe('converter never ran');
        expect(seen.value).toMatch(GUARD14);
        expect(res[0].tag).toBe('A');
        expect(res[1].tag).toBe('B');
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('a handle minted during the marshal survives its own collection', async () => {
        // The endgame of the mis-binding: the stale handle's registry-owner
        // deleter captured the RETIRED state's lua_State* while its shared_ptr
        // kept only the replacement alive, so nothing held the old state up and
        // finalizing the handle unref'd into freed memory (heap-use-after-free
        // under test-ts-asan). Drive the collection explicitly — the finalizer
        // is the only place the free is observable.
        if (typeof global.gc !== 'function') {
          throw new Error('this test requires --expose-gc (see run-sanitized-ts.js)');
        }
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const seen = { value: 'converter never ran' };
        resettingConverter(lua, seen);

        let res: any = await lua.execute_script_async(
          `return setmetatable({tag='A'},{}), setmetatable({tag='B'},{})`);
        let stale: any = res[1];
        res = null;
        for (let i = 0; i < 4; i++) global.gc!();
        await new Promise((r) => setTimeout(r, 20));
        for (let i = 0; i < 4; i++) global.gc!();

        expect(stale.tag).toBe('B');   // still bound to a state that exists
        stale = null;
        for (let i = 0; i < 4; i++) global.gc!();
        await new Promise((r) => setTimeout(r, 20));
        for (let i = 0; i < 4; i++) global.gc!();

        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('a converter may still call back into the context during the marshal', () => {
        // The fix must not over-reach: dropping is_busy_ before the marshal is
        // deliberate, so an ordinary synchronous call from a converter has to
        // keep working. Only reset() is refused.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let observed: unknown = null;
        lua.register_from_lua_converter(
          (_v: any) => { observed ??= lua.execute_script('return 7'); return false; },
          (v: any) => v);
        return lua.execute_script_async(`return setmetatable({tag='A'},{})`)
          .then((r: any) => {
            expect(observed).toBe(7);
            expect(r.tag).toBe('A');
          });
      });
    });

    // --- F2: __luaClassOwner was a raw LuaRuntime*, which identifies a runtime
    // only while it is alive. Once a context was collected the allocator handed
    // its block to the next make_shared<LuaRuntime>, and a retained instance
    // from the dead context passed the live one's ownership check — silently
    // aliasing that context's own userdata instead of deep-copying (CR-2 M6's
    // guarantee). LuaRuntime::Id() is monotonic and never reused.
    describe('F2: a class instance from a collected context cannot alias a new one', () => {
      const makeCtx = (tag: string) => {
        const lua: any = new lua_native.init({}, { libraries: 'safe' as const });
        lua.register_class('Thing', {
          construct: (n: string) => ({ name: n, from: tag }),
          readable: true,
          writable: true,
        });
        return lua;
      };

      it('deep-copies rather than aliasing after the minting context is freed', async () => {
        if (typeof global.gc !== 'function') {
          throw new Error('this test requires --expose-gc (see run-sanitized-ts.js)');
        }
        // Whether the replacement runtime lands on a freed one's address is up
        // to the allocator, so a single A→B pair reproduces the pre-fix defect
        // only some of the time. Retain instances from several collected
        // contexts and offer them all: one hit is enough, and post-fix every one
        // of them must still deep-copy. (Verified against the pre-fix binary:
        // this shape fails, the single-pair shape failed only ~2 runs in 3.)
        const foreigners: any[] = [];
        for (let i = 0; i < 8; i++) {
          let a: any = makeCtx(`A${i}`);
          foreigners.push(a.execute_script(`return Thing.new("alpha${i}")`));
          a = null;
          for (let g = 0; g < 3; g++) global.gc!();
        }
        await new Promise((r) => setTimeout(r, 20));
        for (let g = 0; g < 6; g++) global.gc!();
        expect(foreigners[0].name).toBe('alpha0');

        const b = makeCtx('B');
        const own = b.execute_script('return Thing.new("beta")');

        for (let i = 0; i < foreigners.length; i++) {
          b.set_global('incoming', foreigners[i]);
          // Whether or not B's runtime landed on this one's freed address, the
          // answer must be the same: a foreign instance is a plain table.
          expect(b.execute_script('return type(incoming)'),
            `foreign instance ${i} was aliased instead of deep-copied`).toBe('table');
          expect(b.execute_script('return incoming.name')).toBe(`alpha${i}`);
          expect(b.execute_script('return incoming.from')).toBe(`A${i}`);
          // And B's own instance is untouched by anything done through it.
          b.execute_script('incoming.name = "WRITTEN"');
          expect(own.name).toBe('beta');
        }
      });

      it('a same-context instance still round-trips as userdata', () => {
        const lua = makeCtx('C');
        const inst = lua.execute_script('return Thing.new("gamma")');
        lua.set_global('back', inst);
        expect(lua.execute_script('return type(back)')).toBe('userdata');
        expect(lua.execute_script('return back.name')).toBe('gamma');
      });

      it('an instance does not survive its own context being reset', () => {
        const lua = makeCtx('D');
        const inst = lua.execute_script('return Thing.new("delta")');
        lua.reset();
        lua.register_class('Thing', {
          construct: (n: string) => ({ name: n, from: 'D2' }),
          readable: true,
        });
        lua.execute_script('return Thing.new("post-reset")');
        lua.set_global('stale', inst);
        // The fresh runtime has a new id, so the pre-reset stamp misses.
        expect(lua.execute_script('return type(stale)')).toBe('table');
        expect(lua.execute_script('return stale.name')).toBe('delta');
      });
    });

    // --- F4: reset() has three distinct throw conditions and types.d.ts
    // documented one. Pin all three, since the contract is now written as three.
    it('F4: reset() reports its three refusal conditions distinctly', async () => {
      // (2) Lua executing.
      let fromLua = '';
      const a: any = new lua_native.init(
        { hit: () => { try { a.reset(); } catch (e: any) { fromLua = e.message; } return 1; } },
        ALL_LIBS);
      a.execute_script('hit()');
      expect(fromLua).toMatch(/while Lua is executing/);

      // (3) A binding call on the stack running user JS, no Lua executing.
      const b: any = new lua_native.init({}, ALL_LIBS);
      let fromJs = '';
      b.register_from_lua_converter(
        (v: any) => typeof v === 'object' && v !== null && v.plain === 1,
        (v: any) => { try { b.reset(); } catch (e: any) { fromJs = e.message; } return v; });
      b.execute_script('_G.r = { x = { plain = 1 } }');
      b.get_global_ref('r').pairs();
      expect(fromJs).toMatch(/from inside another lua-native call/);

      // (1) An async run in flight.
      const c: any = new lua_native.init({}, ALL_LIBS);
      const run = c.execute_script_async('local i = 0 for k = 1, 2e5 do i = i + 1 end return i');
      expect(() => c.reset()).toThrow(/busy with an async operation/);
      await run;
    });
  });

  // ============================================
  // CODE-REVIEW-15 REGRESSIONS
  // ============================================
  describe('CODE-REVIEW-15 regressions', () => {
    // F1. Nothing refused a worker-thread async start while the main thread was
    // already inside the lua_State. is_busy_ is written by the launcher and read
    // by everyone else, so it answers "may I enter while a worker runs" and never
    // "may I hand the state to a worker while I am already in it". The worker
    // then parses and executes on a lua_State the main thread is running in.
    //
    // Doors (a) and (c) below segfault against the pre-fix binary — (a) 5/5 and
    // 8/8, (c) 4/10 — with the main thread faulting in _longjmp on a shared
    // errorJmp chain while the worker faults in lua_load.
    const HELD = /cannot be called (while Lua is executing|from inside another lua-native call)/;

    it('F1a: a host callback cannot start a worker run while Lua is executing', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      let refusal = '';
      let accepted = false;
      lua.set_global('cb', () => {
        try {
          lua.execute_script_async('local s = 0 for i = 1, 4e6 do s = s + i end return s')
             .then(() => {}, () => {});
          accepted = true;
        } catch (e: any) { refusal = e.message; }
        return 1;
      });
      // The main thread stays inside Lua after cb() returns; pre-fix, the worker
      // ran concurrently on the same state.
      expect(lua.execute_script('cb() local t = 0 for i = 1, 4e6 do t = t + i end return t'))
        .toBe(8000002000000);
      expect(accepted).toBe(false);
      expect(refusal).toMatch(/while Lua is executing/);
      expect(lua.is_busy()).toBe(false);
    });

    it('F1a: execute_file_async is refused from the same door', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      let refusal = '';
      lua.set_global('cb', () => {
        try { lua.execute_file_async('nonexistent.lua').then(() => {}, () => {}); }
        catch (e: any) { refusal = e.message; }
        return 1;
      });
      lua.execute_script('cb()');
      expect(refusal).toMatch(/while Lua is executing/);
    });

    it('F1b: a type converter cannot start a worker run mid-conversion', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      let refusal = '';
      lua.register_type_converter(
        (v: any) => v !== null && typeof v === 'object' && v.__mark === true,
        (v: any) => {
          try { lua.execute_script_async('return 1').then(() => {}, () => {}); }
          catch (e: any) { refusal = e.message; }
          return v.n;
        });
      lua.set_global('x', { __mark: true, n: 42 });
      expect(lua.get_global('x')).toBe(42);
      expect(refusal).toMatch(/from inside another lua-native call/);
    });

    // F1c. reset()'s replay phase runs user JS — the callbacks object's traps,
    // and the type converters reached through the SharedTable replay — against
    // the state it has just minted, with is_busy_ false, no Lua executing and
    // (pre-fix) call_depth_ 0. in_reset_ blocks a nested reset() and nothing
    // else, so a trap could hand the brand-new state to a worker while reset()
    // kept writing to it from this thread.
    it('F1c: reset()\'s replay phase refuses a worker start from a callbacks trap', () => {
      let lua: any = null;
      let accepted = 0;
      let refusal = '';
      const cbs = new Proxy({ a() {}, b() {}, c() {} } as any, {
        get(t: any, k: string) {
          if (k === 'a' && lua) {
            try {
              lua.execute_script_async('local s = 0 for i = 1, 8e6 do s = s + i end return s')
                 .then(() => {}, () => {});
              accepted++;
            } catch (e: any) { refusal = e.message; }
          }
          return t[k];
        },
      });
      lua = new lua_native.init(cbs, ALL_LIBS);
      lua.reset();
      expect(accepted).toBe(0);
      expect(refusal).toMatch(HELD);
      expect(lua.is_busy()).toBe(false);
      expect(lua.execute_script('return 1 + 1')).toBe(2);
    });

    // Controls. These pass both before and after the fix; they exist so the
    // guard cannot be widened later into something that breaks ordinary async.
    it('F1 control: a top-level worker start still works', async () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      await expect(lua.execute_script_async('return 6 * 7')).resolves.toBe(42);
      expect(lua.is_busy()).toBe(false);
    });

    it('F1 control: a worker start from a settled promise callback still works', async () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      const second = await lua.execute_script_async('return 1')
        .then(() => lua.execute_script_async('return 2'));
      expect(second).toBe(2);
    });

    it('F1 control: execute_async is deliberately NOT guarded — it stays on this thread', async () => {
      const lua: any = new lua_native.init(
        { slow: async () => 41 }, ALL_LIBS);
      let inner: Promise<any> | null = null;
      lua.set_global('cb', () => { inner = lua.execute_async('local x = slow() return x + 1'); return 1; });
      expect(lua.execute_script('cb() return "outer"')).toBe('outer');
      await expect(inner!).resolves.toBe(42);
    });

    // F2. TablePairs used to run ToLuaValueProtected — a lua_pcall, therefore an
    // allocation, therefore a possible __gc finalizer — with a live lua_next
    // cursor into the user's table. Not driven (repeated attempts could not get
    // a finalizer to fire inside the cursor), so this pins the behaviour the
    // collect-first rewrite must preserve rather than a defect it closes.
    it('F2: pairs() still round-trips keys, values and mixed key types', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(`
        t = { alpha = 1, beta = 'two' }
        t[10] = 'ten'
        t[2.5] = 'frac'
        t.nested = { deep = true }
      `);
      const seen = new Map<any, any>([...lua.get_global_ref('t').pairs()] as any);
      expect(seen.get('alpha')).toBe(1);
      expect(seen.get('beta')).toBe('two');
      expect(seen.get(10)).toBe('ten');
      expect(seen.get(2.5)).toBe('frac');
      expect(seen.get('nested')).toEqual({ deep: true });
      expect(seen.size).toBe(5);
    });

    it('F2: pairs() skips unsupported key types, as before', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      lua.execute_script(`
        t = { ok = 1 }
        t[{}] = 'table key'
        t[print] = 'function key'
      `);
      const seen = [...lua.get_global_ref('t').pairs()] as any[];
      expect(seen).toHaveLength(1);
      expect(seen[0][0]).toBe('ok');
    });

    // F5. Symbol.hasInstance defeats AsSharedTable's InstanceOf filter; what
    // actually holds is napi_unwrap rejecting an object it never wrapped. This
    // pins the fail-closed behaviour, since the comment now says the guard is
    // one line lower than it looks.
    it('F5: a Symbol.hasInstance forgery cannot be passed off as a SharedTable', () => {
      const genuine: any = lua_native.createSharedTable({ a: 1 });
      const victim: any = new lua_native.init({}, ALL_LIBS);
      const ctor = genuine.constructor;
      const original = Object.getOwnPropertyDescriptor(ctor, Symbol.hasInstance);
      // `configurable: true`, and restored in the `finally` — both added at
      // CR-20's remediation. Patching Symbol.hasInstance on the SharedTable
      // constructor is process-global and this test left it patched, which made
      // AsSharedTable's InstanceOf filter accept *any* object for the rest of
      // the run; napi_unwrap then rejected the object it had never wrapped and
      // every later `new init({}, { shared })` failed with a bare
      // "Invalid argument". Nothing caught it because this was the last test in
      // the suite that constructed a shared context — until one was added after
      // it, which is how it surfaced.
      Object.defineProperty(ctor, Symbol.hasInstance, { value: () => true, configurable: true });
      try {
        expect(({}) instanceof ctor).toBe(true);  // the filter is defeated

        // Assert the *message*, not merely that something threw. A bare
        // toThrow() passed for as long as this behaviour has existed and could
        // not distinguish the intended refusal from a raw N-API
        // "Invalid argument" — which is what was actually happening, and is the
        // loose-assertion hazard CR-17 F3 is about.
        expect(() => new lua_native.init({}, { ...ALL_LIBS, shared: { s: {} } }))
          .toThrow(/must be a shared table created with createSharedTable/);

        // A *differently-wrapped* ObjectWrap is the sharp case: `napi_unwrap` is
        // not a type check, so before the type tag this unwrapped successfully
        // and handed back a LuaContext* reinterpreted as a SharedTable*. It was
        // accepted, and the process aborted.
        expect(() => new lua_native.init({}, { ...ALL_LIBS, shared: { s: victim } }))
          .toThrow(/must be a shared table created with createSharedTable/);

        // And the forgery must not cost a *legitimate* caller anything: the
        // constructor asks this question of the options object before asking it
        // of each entry, so a defeatable filter used to fail the whole call.
        const stillWorks: any = new lua_native.init(
          {}, { ...ALL_LIBS, shared: { s: genuine } });
        expect(stillWorks.execute_script('return s.a')).toBe(1);
      } finally {
        if (original) Object.defineProperty(ctor, Symbol.hasInstance, original);
        else delete ctor[Symbol.hasInstance];
      }
      // The forgery is undone: an ordinary shared context still constructs.
      const after = lua_native.createSharedTable({ ok: 1 });
      const fresh: any = new lua_native.init({}, { ...ALL_LIBS, shared: { s: after } });
      expect(fresh.execute_script('return s.ok')).toBe(1);
    });

    // F6. Marker Externals carried no type tag, so every read validated
    // provenance (`IsExternal()` plus `data->runtime.get() == runtime.get()`)
    // and never *kind*. JS cannot mint an External — but it can take a genuine
    // one the addon handed out and present it under a different marker name.
    // All four *Data structs begin with a shared_ptr<LuaRuntime>, so the
    // identity check reads the right field of the wrong struct and agrees.
    describe('F6: marker Externals are branded by kind', () => {
      const fixture = () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('t = { a = 1 } function f(x) return x end');
        const handle = lua.get_global_ref('t');
        const fn = lua.get_global('f');
        const coro = lua.create_coroutine(lua.get_global('f'));
        return { lua, handle, fn, coro,
                 tableExt: handle._tableRef,
                 fnExt: fn.__luaFnOwner,
                 coroExt: coro._coroutine };
      };

      it('a thread External presented as _tableRef no longer reaches the table path', () => {
        const { lua, coroExt } = fixture();
        lua.set_global('x', { _tableRef: coroExt });
        // Pre-fix this was 'thread': the coroutine was pushed through the
        // table-ref path. It now deep-copies as a plain object instead.
        expect(lua.execute_script('return type(x)')).toBe('table');
      });

      it('a userdata External presented as _userdata no longer reaches the userdata path', () => {
        const { lua, tableExt } = fixture();
        lua.set_global('y', { _userdata: tableExt });
        expect(lua.execute_script('return type(y)')).toBe('table');  // was 'userdata'
      });

      // The sharpest one: pre-fix these three succeeded and *destroyed the
      // genuine handle's registry ref* through a mistyped struct — the controls
      // at the end of this test failed with "has been released" as a result.
      it('release() dispatches on the payload kind, not the marker name', () => {
        const { lua, handle, fn, coro, tableExt, fnExt, coroExt } = fixture();
        expect(() => lua.release({ _coroutine: fnExt })).toThrow(/requires a Lua function/);
        expect(() => lua.release({ _tableRef: coroExt })).toThrow(/requires a Lua function/);
        const g = () => {};
        Object.defineProperty(g, '__luaFnOwner', { value: tableExt });
        expect(() => lua.release(g)).toThrow(/not a Lua function reference/);

        // The genuine handles survived all three attempts.
        lua.set_global('z', handle);
        expect(lua.execute_script('return type(z) .. ":" .. tostring(z.a)')).toBe('table:1');
        expect(fn(21)).toBe(21);
        expect(lua.resume(coro, 5).status).toBe('dead');
      });

      it('resume() rejects a table-ref External presented as _coroutine', () => {
        const { lua, tableExt } = fixture();
        expect(() => lua.resume({ _coroutine: tableExt })).toThrow(/Invalid coroutine object/);
      });

      it('control: every genuine marker still round-trips', () => {
        const { lua, handle, fn, coro } = fixture();
        lua.set_global('z', handle);
        expect(lua.execute_script('return z.a')).toBe(1);
        expect(fn(7)).toBe(7);
        expect(lua.resume(coro, 3).status).toBe('dead');
        lua.release(handle);
        expect(() => lua.get_global_ref('t').get('a')).not.toThrow();
      });
    });

    // The occupancy matrix.
    //
    // Every operation that takes the lua_State away from its holder declares
    // `lua_occupancy::kExclusive`, so all of them refuse under all of its
    // claims. Before the model was unified these three checked 3, 1 and 1 of
    // the same conditions respectively, and each gap was a separate
    // high-severity finding a pass apart (CR-13, CR-15).
    //
    // **Add any new kExclusive operation to `EXCLUSIVE_OPS` below.** The matrix
    // is the enforcement: a policy that drifts fails here rather than in a
    // review three passes later.
    describe('occupancy: every kExclusive operation shares one policy', () => {
      const EXCLUSIVE_OPS: Array<[string, (lua: any) => unknown]> = [
        ['reset()', (lua) => lua.reset()],
        ['execute_script_async()', (lua) => lua.execute_script_async('return 1')],
        ['execute_file_async()', (lua) => lua.execute_file_async('nonexistent.lua')],
      ];

      // Each claim, and how to be holding it when the operation is attempted.
      const CLAIMS: Array<[string, RegExp, (lua: any, attempt: () => void) => Promise<void> | void]> = [
        ['AsyncInFlight', /busy with an async operation/, async (lua, attempt) => {
          const run = lua.execute_script_async('local i = 0 for k = 1, 2e5 do i = i + 1 end return i');
          attempt();
          await run;
        }],
        ['LuaExecuting', /while Lua is executing/, (lua, attempt) => {
          lua.set_global('hit', () => { attempt(); return 1; });
          lua.execute_script('hit()');
        }],
        ['BindingCall', /from inside another lua-native call/, (lua, attempt) => {
          lua.register_type_converter(
            (v: any) => v !== null && typeof v === 'object' && v.__mark === true,
            (v: any) => { attempt(); return v.n; });
          lua.set_global('probe', { __mark: true, n: 1 });
        }],
      ];

      for (const [claimName, expected, induce] of CLAIMS) {
        for (const [opName, invoke] of EXCLUSIVE_OPS) {
          it(`${opName} refuses while ${claimName} is held`, async () => {
            const lua: any = new lua_native.init({}, ALL_LIBS);
            let message = '';
            const attempt = () => {
              try {
                const r: any = invoke(lua);
                // A rejected promise must not surface as an unhandled rejection
                // if the guard let it through; swallow either way.
                if (r && typeof r.then === 'function') r.then(() => {}, () => {});
              } catch (e: any) { message = e.message; }
            };
            await induce(lua, attempt);
            expect(message, `${opName} under ${claimName}`).toMatch(expected);
            // The context survives every refusal and stays usable.
            expect(lua.execute_script('return 1 + 1')).toBe(2);
          });
        }
      }
    });

    // CR-16 F1. `cancel()` is the one method deliberately exempt from the
    // occupancy guard — it must work while `is_busy_` is true, that being its
    // entire job. It is therefore the only thing user JS can do during an
    // execute_async result marshal, and what it does is settle the very
    // deferred the marshal is about to settle. DriveAsync's terminal exit had
    // no liveness re-check, so it concluded an already-concluded (freed)
    // napi_deferred: a deterministic SIGSEGV, 8/8, that took the process down
    // rather than throwing. Both tests below crash the runner pre-fix.
    describe('occupancy: cancel() during an async result marshal (CR-16 F1)', () => {
      it('a from-Lua converter may cancel() the run it is marshalling', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let fired = false;
        lua.register_from_lua_converter(
          (v: any) => !!(v && v.k === 1),
          (v: any) => { if (!fired) { fired = true; lua.cancel(); } return v; });

        await expect(lua.execute_async('return {k=1}')).rejects.toThrow(/execution cancelled/);
        expect(fired).toBe(true);
        // The run is fully torn down, not wedged half-settled.
        expect(lua.is_busy()).toBe(false);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('a from-Lua converter may cancel() and start a replacement run', async () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let started: Promise<any> | null = null;
        let fired = false;
        lua.register_from_lua_converter(
          (v: any) => !!(v && v.k === 1),
          (v: any) => {
            if (!fired) {
              fired = true;
              lua.cancel();
              started = lua.execute_async('return 99');
            }
            return v;
          });

        await expect(lua.execute_async('return {k=1}')).rejects.toThrow(/execution cancelled/);
        // The generation half of the guard: the outer run's teardown must not
        // reach into the replacement. Checking the optional alone would pass
        // here and still tear this run down.
        expect(started).not.toBeNull();
        await expect(started!).resolves.toBe(99);
        expect(lua.is_busy()).toBe(false);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('the sibling window in OnAwaitSettled stays guarded (control)', async () => {
        // Already had the re-check; pinned so a refactor cannot remove the one
        // copy that was right while unifying it with the one that was wrong.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_type_converter(
          (v: any) => !!(v && v.__mark),
          (v: any) => { lua.cancel(); return 1; });
        lua.set_global('mk', () => Promise.resolve({ __mark: true }));

        await expect(lua.execute_async('local v = await(mk()) return v'))
          .rejects.toThrow(/execution cancelled/);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });

    // CR-16 F3. Several claims are routinely held at once and the order in
    // RejectIfOccupied decides which one the caller is told about. Since
    // CR-15 gave reset()'s replay phase a CallScope, a replay Proxy trap holds
    // Resetting *and* BindingCall — and for one commit it was reported as
    // "from inside a __gc finalizer of the state being retired", which is
    // false. These two pin the split.
    describe('occupancy: the refusal message names the most specific claim', () => {
      it('a reset() from the replay phase blames the trap, not a finalizer', () => {
        let armed = false;
        let seen = '';
        const cbs = new Proxy({ a() {}, b() {} }, {
          get(t: any, k: any, r: any) {
            if (armed && typeof k === 'string') {
              armed = false;
              try { lua.reset(); } catch (e: any) { seen = e.message; }
            }
            return Reflect.get(t, k, r);
          },
        });
        const lua: any = new lua_native.init(cbs, ALL_LIBS);
        armed = true;
        lua.reset();
        expect(seen).toMatch(/from inside another lua-native call/);
        expect(seen).not.toMatch(/__gc finalizer of the state being retired/);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('Resetting still answers for the case nothing else can see', () => {
        // The finalizer fires inside lua_close, where `runtime` already points
        // at the replacement (IsExecuting() false) and the replay scope is not
        // yet open (call_depth_ 0). This is the CR-9 case; it must keep its own
        // message after Resetting was moved last.
        const seen: string[] = [];
        const lua: any = new lua_native.init({
          renest: () => {
            try { lua.reset(); seen.push('RESET RAN'); }
            catch (e: any) { seen.push(e.message); }
            return 1;
          },
        }, ALL_LIBS);
        lua.execute_script(`keep = setmetatable({}, { __gc = function() renest() end })`);
        lua.reset();
        expect(seen[0]).toMatch(/reset\(\) cannot be called re-entrantly/);
      });
    });
  });

  // ============================================
  // CODE-REVIEW-17 regressions
  // ============================================
  describe('CODE-REVIEW-17 regressions', () => {
    // CR-17 F1. reset() swaps `runtime` and destroys the outgoing state in the
    // same statement, so lua_close's __gc finalizers dispatch into JS with the
    // member already pointing at the replacement. A metatabled table reaching a
    // JS __gc handler was converted there, pairing a ref minted in the RETIRING
    // registry with the REPLACEMENT runtime. Driven twice: a use-after-free at
    // teardown (SIGSEGV 3/3, so these kill the runner pre-fix) and, while the
    // handle lives, silent aliasing of the new state's registry at the old
    // state's slot number.
    describe('handles minted from a retiring state (CR-17 F1)', () => {
      it('a JS __gc metamethod plus reset() does not corrupt teardown', () => {
        let hits = 0;
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('fin = {}');
        lua.set_metatable('fin', { __gc: () => { hits++; } });
        lua.reset();
        // The finalizer must still reach JS — that dispatch is pinned by CR-9's
        // re-entrancy test and the fix must not silence it.
        expect(hits).toBe(1);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('a handle escaping a __gc handler cannot alias the replacement state', () => {
        const escaped: any[] = [];
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('a = {} b = {} c = {}');
        for (const n of ['a', 'b', 'c']) {
          lua.set_metatable(n, { __gc: (t: any) => { escaped.push(t); } });
        }
        lua.reset();
        expect(escaped.length).toBe(3);

        // Populate the replacement registry with identifiable tables. Pre-fix,
        // escaped[i] read and wrote fresh[i] one-for-one.
        const fresh: any[] = [];
        for (let i = 0; i < 6; i++) {
          const h = lua.create_table();
          h.set('iam', 'fresh#' + i);
          fresh.push(h);
        }

        for (const h of escaped) {
          expect(() => h.iam).toThrow(/has been released/);
          expect(() => { h.injected = 'x'; }).toThrow(/has been released/);
        }
        // Nothing the retired handles touched reached a live table.
        for (let i = 0; i < fresh.length; i++) {
          expect(fresh[i].get('injected')).toBeNull();
          expect(fresh[i].get('iam')).toBe('fresh#' + i);
        }
      });

      it('the same context keeps minting live handles normally (control)', () => {
        // The guard is "does this ref belong to my current runtime", so the
        // ordinary path must be untouched.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('m = setmetatable({ v = 1 }, { __index = function() return 9 end })');
        const t: any = lua.get_global('m');
        expect(t.v).toBe(1);
        expect(t.missing).toBe(9);
        const h = lua.create_table();
        h.set('a', 1);
        expect(h.get('a')).toBe(1);
        h.release();
      });
    });

    // CR-17 F2. Five cross-context entry points refuse a foreign table handle;
    // set_global fell through to "a plain deep copy", which is correct for the
    // plain objects it was written for and wrong for a Proxy, whose own keys
    // are its API rather than its data.
    describe('a foreign table handle is refused, not silently mis-copied (CR-17 F2)', () => {
      it('set_global refuses a table handle from another context', () => {
        const a: any = new lua_native.init({}, ALL_LIBS);
        const b: any = new lua_native.init({}, ALL_LIBS);
        a.execute_script('cfg = { host = "db1", port = 5432 }');
        const h = a.get_global_ref('cfg');
        expect(() => b.set_global('cfg', h))
          .toThrow(/table handle belongs to a different Lua context/);
        // And it is not half-applied.
        expect(b.execute_script('return cfg')).toBeNull();
      });

      it('every cross-context entry point now agrees', () => {
        const a: any = new lua_native.init({}, ALL_LIBS);
        const b: any = new lua_native.init({}, ALL_LIBS);
        a.execute_script('cfg = { a = 1 }');
        const h = a.get_global_ref('cfg');
        for (const attempt of [
          () => b.release(h),
          () => b.set_metatable(h, { __index: () => 1 }),
          () => b.set_global('x', h),
        ]) {
          expect(attempt).toThrow(/belongs to a different Lua context/);
        }
      });

      it('a handle names the reason it is unusable (CR-17 F3)', async () => {
        // Two different facts shared one message. reset() and ~LuaContext both
        // flip `alive_`, so a handle used after a reset that left the context
        // demonstrably alive still reported "its context has been destroyed".
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('cfg = { a = 1 }');
        const h = lua.get_global_ref('cfg');
        const fn = lua.execute_script('return function() return 1 end');
        lua.reset();
        // The context is alive; only its state was replaced.
        expect(lua.execute_script('return 1 + 1')).toBe(2);
        expect(() => h.get('a')).toThrow(/state was replaced by reset/);
        expect(() => h.get('a')).not.toThrow(/context has been destroyed/);
        expect(() => fn()).toThrow(/state was replaced by reset/);

        // The other branch of the same pair: the context really is gone.
        let orphan: any;
        (() => {
          const tmp: any = new lua_native.init({}, ALL_LIBS);
          tmp.execute_script('c = { a = 1 }');
          orphan = tmp.get_global_ref('c');
        })();
        for (let i = 0; i < 4; i++) { (globalThis as any).gc?.(); await new Promise((r) => setImmediate(r)); }
        // Only assert the wording when the wrapper actually got collected —
        // otherwise the cell is vacuous, not passing.
        try { orphan.get('a'); } catch (e: any) {
          expect(e.message).toMatch(/context has been destroyed|state was replaced by reset/);
        }
      });

      it('copying the data across contexts still works by value (the alternative)', () => {
        const a: any = new lua_native.init({}, ALL_LIBS);
        const b: any = new lua_native.init({}, ALL_LIBS);
        a.execute_script('cfg = { host = "db1", port = 5432 }');
        b.set_global('cfg', a.get_global('cfg'));
        expect(b.execute_script('return cfg.host, cfg.port')).toEqual(['db1', 5432]);
      });
    });
  });

  // ============================================
  // CODE-REVIEW-18 regressions
  // ============================================
  //
  // Found by the exception-escape matrix (`tools/exception-matrix/`): 27 Lua C frames x 11
  // throw kinds, one process per cell. Nothing aborted and no context was left
  // unusable — the findings are all about what the caller is *told* when a
  // contained failure happens, which is the class this codebase moved into.

  describe('CODE-REVIEW-18 regressions', () => {
    describe('F1: a protected barrier reports the real cause, not a guessed one', () => {
      // Pre-fix these all reported "protected operation failed (out of memory?)",
      // because lua_tostring returns null for the *table* a thrown JS error is
      // staged into, and each barrier had its own invented fallback. The same
      // callback reached through execute_script always reported correctly, which
      // is what made it a discrepancy rather than a missing feature.
      const armed = () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('t = {}');
        const boom = () => { throw new Error('THE-REAL-CAUSE'); };
        lua.set_metatable('t', { __index: boom, __newindex: boom, __len: boom });
        return lua;
      };

      it('execute_script reports it (the control that was always right)', () => {
        const lua = armed();
        expect(() => lua.execute_script('return t.x')).toThrow(/THE-REAL-CAUSE/);
      });

      for (const [name, op] of [
        ['handle.get()', (h: any) => h.get('x')],
        ['handle.has()', (h: any) => h.has('x')],
        ['handle.set()', (h: any) => h.set('x', 1)],
        ['handle.length()', (h: any) => h.length()],
        ['handle.get_ref()', (h: any) => h.get_ref('x')],
      ] as Array<[string, (h: any) => unknown]>) {
        it(`${name} reports it`, () => {
          const lua = armed();
          const h = lua.get_global_ref('t');
          expect(() => op(h)).toThrow(/THE-REAL-CAUSE/);
          // The specific wrong answer, asserted specifically: a generic
          // toThrow() passed for as long as the wrong message existed.
          try { op(h); } catch (e: any) { expect(e.message).not.toMatch(/out of memory/i); }
        });
      }

      it('a dotted get_global / set_global reports it', () => {
        const lua = armed();
        expect(() => lua.get_global('t.x')).toThrow(/THE-REAL-CAUSE/);
        expect(() => lua.set_global('t.x', 1)).toThrow(/THE-REAL-CAUSE/);
      });

      it('a raising _G metamethod reports it through set_global and get_global', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_global('raiser', () => { throw new Error('THE-REAL-CAUSE'); });
        lua.execute_script(
          'setmetatable(_G, { __newindex = function() raiser() end,'
          + ' __index = function() raiser() end })');
        expect(() => lua.set_global('zz', 1)).toThrow(/THE-REAL-CAUSE/);
        expect(() => lua.get_global('zz')).toThrow(/THE-REAL-CAUSE/);
      });

      it('a genuine Lua string error is unchanged (the cheap path stays cheap)', () => {
        // The string case must not start going through ErrorValueToString: it is
        // what a real LUA_ERRMEM leaves behind, and stringifying under a state
        // that has just failed to allocate is not something to attempt.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('t = setmetatable({}, { __index = function() error("PLAIN-LUA") end })');
        expect(() => lua.get_global_ref('t').get('x')).toThrow(/PLAIN-LUA/);
      });
    });

    describe('F2: a thrown non-Error keeps its text', () => {
      // Napi::Error::Message() reads `.message` off the thrown value, so it is
      // empty for `throw 'boom'`. The 45 binding catch sites rebuild the error
      // from what(), so the caller got an Error with no message at all. The
      // host-function bridge had the right fallback all along; the fix gives the
      // other three the same one rather than editing the 45 consumers.
      for (const thrown of ['a plain string', 42, null] as const) {
        it(`host function: throw ${JSON.stringify(thrown)}`, () => {
          const lua: any = new lua_native.init({}, ALL_LIBS);
          lua.set_global('f', () => { throw thrown; });
          expect(() => lua.execute_script('return f()')).toThrow(/THREW|threw an exception/i);
        });
      }

      it('a type converter that throws a string keeps the string', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_type_converter(
          (v: any) => v && typeof v === 'object' && 'tag' in v,
          () => { throw 'STRING-FROM-CONVERTER'; },
        );
        expect(() => lua.set_global('x', { tag: 1 })).toThrow(/STRING-FROM-CONVERTER/);
      });

      it('a userdata property getter that throws a string keeps the string', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const obj = {};
        Object.defineProperty(obj, 'p', {
          get: () => { throw 'STRING-FROM-GETTER'; }, enumerable: true,
        });
        lua.set_userdata('ud', obj, { readable: true });
        expect(() => lua.execute_script('return ud.p')).toThrow(/STRING-FROM-GETTER/);
      });

      it('a from-Lua converter that throws a string keeps the string', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_from_lua_converter(() => true, () => { throw 'STRING-FROM-FROM-LUA'; });
        expect(() => lua.execute_script('return { a = 1 }')).toThrow(/STRING-FROM-FROM-LUA/);
      });

      it('an Error thrown from a converter is unaffected', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_type_converter(
          (v: any) => v && typeof v === 'object' && 'tag' in v,
          () => { throw new Error('ERROR-FROM-CONVERTER'); },
        );
        expect(() => lua.set_global('x', { tag: 1 })).toThrow(/ERROR-FROM-CONVERTER/);
      });

      it('the rethrow keeps the exception a Napi::Error, not a std::runtime_error', () => {
        // Load-bearing, and the reason this pin exists: the first version of the
        // F2 fix rethrew std::runtime_error, which the sites that catch
        // Napi::Error *specifically* — the print-handler and debug-hook bridges —
        // then missed, and the escape took the process down. If that regresses,
        // this whole file's worker dies rather than failing an assertion, so the
        // real assertion is that the run gets here at all.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_print_handler(() => { throw 'from the print handler'; });
        lua.register_from_lua_converter(() => true, (v: any) => v);
        expect(lua.execute_script('print("x") return 1 + 1')).toBe(2);
      });
    });

    describe('F3: the deliberate swallows stay deliberate, and stay documented', () => {
      it('a throwing print handler is swallowed and the script completes', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let calls = 0;
        lua.set_print_handler(() => { calls++; throw new Error('PRINT-BOOM'); });
        expect(lua.execute_script('print("a") return "finished"')).toBe('finished');
        expect(calls).toBe(1);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('a throwing debug hook is swallowed and the script completes', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let calls = 0;
        lua.set_hook(() => { calls++; throw new Error('HOOK-BOOM'); }, { line: true });
        expect(lua.execute_script('local a = 1\nlocal b = 2\nreturn "finished"')).toBe('finished');
        expect(calls).toBeGreaterThan(0);
        lua.remove_hook();
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('a throwing __gc finalizer is contained and leaves a usable context', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let calls = 0;
        lua.execute_script('t = {}');
        lua.set_metatable('t', { __gc: () => { calls++; throw new Error('GC-BOOM'); } });
        lua.execute_script('t = nil');
        lua.gc('collect');
        lua.gc('collect');
        expect(calls).toBe(1);
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });

      it('a throwing __gc finalizer at reset() is contained', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('t = {}');
        lua.set_metatable('t', { __gc: () => { throw new Error('GC-BOOM'); } });
        expect(() => lua.reset()).not.toThrow();
        expect(lua.execute_script('return 1 + 1')).toBe(2);
      });
    });

    describe('F4 (negative result): a contained failure strands nothing', () => {
      it('a coroutine whose host callback throws frees its slot on release', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_global('f', () => { throw new Error('BOOM'); });
        const cycle = () => {
          const co = lua.create_coroutine('return function() return f() end');
          try { lua.resume(co); } catch { /* expected */ }
          lua.release(co);
        };
        for (let i = 0; i < 20; i++) cycle();
        lua.gc('collect'); lua.gc('collect');
        const before = lua.get_memory_usage();
        for (let i = 0; i < 200; i++) cycle();
        lua.gc('collect'); lua.gc('collect');
        // Exactly flat: the error path must not orphan a registry slot or a
        // staged js_error_registry_ entry. Measured at 0 B over 200 iterations.
        expect(lua.get_memory_usage() - before).toBeLessThan(4096);
      });
    });
  });

  // ============================================
  // DIFFERENTIAL ORACLE regressions
  // ============================================
  //
  // Found by `tools/diff-oracle/` — 2678 cases run through both lua-native and
  // stock Lua 5.5 and compared. These three are silent data loss on the Lua->JS
  // crossing: no error, no crash, a plausible value. They are pinned rather than
  // fixed because each is a consequence of the JavaScript type system and
  // changing any of them is an API decision; the pins exist so that if the
  // decision is ever taken, it is taken deliberately.
  //
  // Each is also documented on execute_script() in types.d.ts. Before the
  // oracle, nothing in the project recorded that they happen.

  describe('differential-oracle regressions', () => {
    describe('O1: a Lua string that is not valid UTF-8 does not survive the crossing', () => {
      it('invalid bytes become U+FFFD', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('return #("\\xFF\\xFE")')).toBe(2);
        const crossed = lua.execute_script('return "\\xFF\\xFE"');
        expect([...Buffer.from(crossed, 'utf8')]).toEqual([0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd]);
      });

      it('the loss is not idempotent — a round trip changes the length', () => {
        // The sharpest statement of the problem: 4 bytes out, 8 bytes back, and
        // Lua itself reports the two strings as different.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('blob = "\\x00\\x01\\xFE\\xFF"');
        expect(lua.execute_script('return #blob')).toBe(4);
        lua.set_global('back', lua.execute_script('return blob'));
        expect(lua.execute_script('return #back')).toBe(8);
        expect(lua.execute_script('return blob == back')).toBe(false);
      });

      it('is data-dependent: bytes below 0x80 survive, which is what hides it', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const packed = lua.execute_script('return string.pack("i4", 7)');
        expect([...Buffer.from(packed, 'utf8')]).toEqual([7, 0, 0, 0]);
        lua.set_global('back', packed);
        expect(lua.execute_script('return #back')).toBe(4);
      });

      it('valid UTF-8 crosses unchanged', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('return "caf\\xC3\\xA9"')).toBe('café');
      });

      it('the documented workaround works: encode it', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('blob = "\\x00\\x01\\xFE\\xFF"');
        const hex = lua.execute_script('return (blob:gsub(".", function(c) return string.format("%02x", c:byte()) end))');
        expect(hex).toBe('0001feff');
        lua.set_global('hex', hex);
        expect(lua.execute_script(
          'local b = (hex:gsub("%x%x", function(h) return string.char(tonumber(h, 16)) end)) return b == blob',
        )).toBe(true);
      });

      it('a handle keeps it intact, because nothing is marshalled out', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.execute_script('t = { blob = "\\x00\\x01\\xFE\\xFF" }');
        const h = lua.get_global_ref('t');
        h.set('copy', 'placeholder');
        expect(lua.execute_script('return #t.blob')).toBe(4);
      });
    });

    describe('O2: table keys that are neither string nor number are dropped', () => {
      it('boolean keys vanish rather than becoming null', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script(
          'local c = 0 for _ in pairs({[true]=1,[false]=2}) do c = c + 1 end return c',
        )).toBe(2);
        expect(lua.execute_script('return {[true]=1, [false]=2}')).toEqual({});
      });

      it('a table key vanishes too', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('local k = {} return {[k] = 1}')).toEqual({});
      });

      it('string and number keys are unaffected', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script('return {a = 1, [2] = "two"}')).toEqual({ a: 1, 2: 'two' });
      });
    });

    describe('O3: a string key and a number key with the same text collide', () => {
      it('two distinct Lua entries arrive as one JS property', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script(
          'local t = {["1"]="strkey", [1]="intkey"} return t["1"] .. "/" .. t[1]',
        )).toBe('strkey/intkey');
        const crossed = lua.execute_script('return {["1"]="strkey", [1]="intkey"}');
        expect(Object.keys(crossed)).toEqual(['1']);
      });
    });
  });

  // ============================================
  // CODE-REVIEW-19 / CODE-REVIEW-20 regressions
  // ============================================
  //
  // CR-19 reviewed the instruments CR-18 added; CR-20 pointed the first
  // instrument at the JS -> Lua direction. The product-visible fixes are pinned
  // here; the instrument fixes are pinned in tests/ts/invariants.spec.ts.

  describe('CODE-REVIEW-19 regressions', () => {
    describe('F3: a shared-table subscriber that throws a non-Error keeps its cause', () => {
      // The CR-18 F2 class at a fifth site. It survived the producer-side sweep
      // because SharedTable formats the caught Napi::Error itself, and could not
      // even call the fix: JsThrowMessage was a private static of LuaContext.
      const shadow = (ctx: any, fn: unknown) =>
        Object.defineProperty(ctx, 'set_global', { value: fn, configurable: true });

      for (const [label, thrown] of [
        ['an Error', new Error('REAL-CAUSE')],
        ['a bare string', 'REAL-CAUSE'],
        ['a number', 42],
      ] as Array<[string, unknown]>) {
        it(`reports the cause when a subscriber throws ${label}`, () => {
          const shared = (lua_native as any).createSharedTable({ v: 1 });
          const a: any = new lua_native.init({}, { ...ALL_LIBS, shared: { s: shared } });
          shadow(a, () => { throw thrown; });
          expect(() => shared.set('v', 2)).toThrow(/REAL-CAUSE|42/);
        });
      }

      it('names the real fact when set_global has been shadowed by a non-function', () => {
        // Was "shared table subscriber is not a Lua context" — said of something
        // that is one. Subscribers are only ever real contexts.
        const shared = (lua_native as any).createSharedTable({ v: 1 });
        const a: any = new lua_native.init({}, { ...ALL_LIBS, shared: { s: shared } });
        Object.defineProperty(a, 'set_global', { value: 42, configurable: true });
        expect(() => shared.set('v', 2)).toThrow(/shadowed by an own property/);
      });
    });
  });

  describe('CODE-REVIEW-20 regressions', () => {
    describe('F2: a circular reference is named as one, not as depth', () => {
      it('a two-key cyclic object reports a cycle', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const cyc: any = { a: 1 };
        cyc.self = cyc;
        expect(() => lua.set_global('c', cyc)).toThrow(/circular reference/);
        // Specifically NOT the old message, which sent the user to flatten an
        // object that was two levels deep.
        try { lua.set_global('c', cyc); } catch (e: any) {
          expect(e.message).not.toMatch(/nesting depth/);
        }
      });

      it('a cyclic array reports a cycle', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const arr: any[] = [1];
        arr.push(arr);
        expect(() => lua.set_global('a', arr)).toThrow(/circular reference/);
      });

      it('a genuinely deep acyclic object still reports depth', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        let deep: any = {};
        for (let i = 0; i < 150; i++) deep = { n: deep };
        expect(() => lua.set_global('d', deep)).toThrow(/nesting depth/);
      });

      it('a DAG is not a cycle — the same object twice is accepted', () => {
        // The control that makes the detection path-based rather than a
        // visited-set. Sharing a subobject is legal and common.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const shared = { x: 1 };
        expect(() => lua.set_global('g', { a: shared, b: shared })).not.toThrow();
        expect(lua.execute_script('return g.a.x + g.b.x')).toBe(2);
      });

      it('a converter re-entering with a value from the outer tree is not a cycle', () => {
        // The other half of path-scoping: a type converter converts a different
        // tree, and a value present in both must not read as circular.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const shared = { x: 1 };
        lua.register_type_converter(
          (v: any) => v && typeof v === 'object' && v.wrap === true,
          (v: any) => ({ inner: shared, tag: v.tag }),
        );
        expect(() => lua.set_global('w', { outer: shared, w: { wrap: true, tag: 'z' } })).not.toThrow();
        expect(lua.execute_script('return w.w.inner.x')).toBe(1);
      });
    });

    describe('F3: negative zero keeps its sign and float subtype', () => {
      it('-0 crosses as a Lua float, not as integer 0', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_global('nz', -0);
        expect(lua.execute_script('return math.type(nz)')).toBe('float');
        expect(lua.execute_script('return tostring(1/nz)')).toBe('-inf');
        expect(Object.is(lua.get_global('nz'), -0)).toBe(true);
      });

      it('positive zero is still an integer', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_global('z', 0);
        expect(lua.execute_script('return math.type(z)')).toBe('integer');
        expect(lua.execute_script('return tostring(1/z)')).toBe('inf');
      });

      it('an ordinary integral float is still an integer (this one is not fixable)', () => {
        // JS cannot tell 1.0 from 1, so no conversion can preserve a
        // distinction the input never carried. Pinned so the -0 fix is not
        // later "generalized" into changing this.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_global('one', 1.0);
        expect(lua.execute_script('return math.type(one)')).toBe('integer');
      });
    });

    describe('F1: the documented array-hole behaviour', () => {
      // Not a fix — a documented loss, pinned so it cannot change silently in
      // either direction. See LuaInput in types.d.ts.
      it('a null in an array truncates the Lua sequence', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_global('rows', [1, null, 3, 4]);
        expect(lua.execute_script('return #rows')).toBe(1);
        expect(lua.execute_script('local c=0 for _ in ipairs(rows) do c=c+1 end return c')).toBe(1);
        expect(lua.execute_script('local c=0 for _ in pairs(rows) do c=c+1 end return c')).toBe(3);
        // The later values are present, just not part of the sequence.
        expect(lua.execute_script('return rows[3]')).toBe(3);
      });

      it('the documented workaround keeps the sequence intact', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_global('rows', [1, false, 3, 4]);
        expect(lua.execute_script('return #rows')).toBe(4);
      });
    });
  });

  describe('binaryStrings — byte-faithful Lua strings (LIMITATIONS §2)', () => {
    const BINARY = 'return "\\xFF\\xFE\\x41"';   // bytes FF FE 41

    it('is lossy by default — the documented behaviour', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      const s: string = lua.execute_script(BINARY);
      expect([...s].map((c) => c.codePointAt(0))).toEqual([0xfffd, 0xfffd, 0x41]);
    });

    it('returns exact bytes when enabled', () => {
      const lua: any = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
      const b = lua.execute_script(BINARY);
      expect(b).toBeInstanceOf(Uint8Array);
      expect([...b]).toEqual([255, 254, 65]);
    });

    it('round-trips: bytes out, bytes back in, same length and content', () => {
      const lua: any = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
      const b = lua.execute_script(BINARY);
      lua.set_global('b', b);
      expect(lua.execute_script('return #b')).toBe(3);
      expect(lua.execute_script('return string.byte(b, 1)')).toBe(255);
      expect(lua.execute_script('return string.byte(b, 3)')).toBe(65);
    });

    it('string.pack survives, which it does not by default', () => {
      // The motivating case: all-low-byte packs work either way, so the bug
      // only shows on data with a high byte. Use a value that produces one.
      const plain: any = new lua_native.init({}, ALL_LIBS);
      const bin: any = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
      const script = 'return string.pack("i4", -2)';   // FE FF FF FF
      expect([...bin.execute_script(script)]).toEqual([254, 255, 255, 255]);
      // …and the default path cannot represent it.
      expect([...(plain.execute_script(script) as string)]
        .map((c) => c.codePointAt(0))).not.toEqual([254, 255, 255, 255]);
    });

    it('table keys stay strings; string values become bytes', () => {
      const lua: any = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
      const t: any = lua.execute_script('return { alpha = "hi" }');
      expect(Object.keys(t)).toEqual(['alpha']);          // key is still a string
      expect(t.alpha).toBeInstanceOf(Uint8Array);
      expect([...t.alpha]).toEqual([104, 105]);
    });

    it('valid UTF-8 is unaffected by default and still decodable when enabled', () => {
      const plain: any = new lua_native.init({}, ALL_LIBS);
      expect(plain.execute_script('return "caf\\xC3\\xA9"')).toBe('café');
      const bin: any = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
      const b = bin.execute_script('return "caf\\xC3\\xA9"');
      expect(new TextDecoder().decode(b)).toBe('café');
    });
  });

  describe('strictConversion — refusing the silent losses (LIMITATIONS §5)', () => {
    const strict = () => new lua_native.init({}, { libraries: 'all', strictConversion: true }) as any;
    const lossy = () => new lua_native.init({}, ALL_LIBS) as any;

    // The four losses §5 lists that are *silent*. Each is pinned twice: the
    // default still performs it (so the option is genuinely opt-in and no
    // existing caller changed), and strict mode refuses it.
    describe('Lua -> JS: table keys', () => {
      it('drops a non-string/number key by default, refuses under strict', () => {
        expect(lossy().execute_script('return {[true]=1,[false]=2}')).toEqual({});
        expect(() => strict().execute_script('return {[true]=1}'))
          .toThrow(/strict conversion.*key of type 'boolean'.*would be dropped/s);
      });

      it('names the offending key type', () => {
        expect(() => strict().execute_script('return {[{}]=1}'))
          .toThrow(/key of type 'table'/);
        expect(() => strict().execute_script('return {[print]=1}'))
          .toThrow(/key of type 'function'/);
      });

      // The nastier of the two: which value survives depends on lua_next order,
      // so the default is not merely lossy but unpredictably lossy.
      it('collapses a colliding string/number key by default, refuses under strict', () => {
        expect(lossy().execute_script('return {["1"]="s",[1]="i"}')).toEqual({ 1: 's' });
        expect(() => strict().execute_script('return {["1"]="s",[1]="i"}'))
          .toThrow(/strict conversion.*both become the JavaScript property "1".*one value would be lost/s);
      });

      // CR-23 F1: the third member of the same class, and the one that was
      // missing from the §5 enumeration the option was built from. A Lua key is
      // bytes and a JS property name is text, so two byte sequences do not
      // survive — and both lose a whole *entry*, not a byte.
      describe('a key whose bytes cannot become a JS property name', () => {
        it('collapses two binary keys into one by default, refuses under strict', () => {
          // Two distinct Lua keys; both decode to U+FFFD, so one entry vanishes.
          const back = lossy().execute_script('return {["\\xFF"]="a", ["\\xFE"]="b"}');
          expect(Object.keys(back)).toHaveLength(1);
          expect(() => strict().execute_script('return {["\\xFF"]="a", ["\\xFE"]="b"}'))
            .toThrow(/strict conversion.*not valid UTF-8.*U\+FFFD.*collapse into one/s);
        });

        it('refuses a single non-UTF-8 key too — a mangled key is already a loss', () => {
          expect(Object.keys(lossy().execute_script('return {["k\\xFF"]="v"}'))).toEqual(['k�']);
          expect(() => strict().execute_script('return {["k\\xFF"]="v"}'))
            .toThrow(/strict conversion.*not valid UTF-8/s);
        });

        it('refuses an embedded NUL key, which truncates rather than replaces', () => {
          // "a\0b" arrives as the property "a", colliding with a real "a".
          expect(lossy().execute_script('return {["a\\0b"]="v1", ["a"]="v2"}'))
            .toEqual({ a: 'v1' });
          expect(() => strict().execute_script('return {["a\\0b"]="v1"}'))
            .toThrow(/strict conversion.*embedded NUL is truncated/s);
        });

        // Measured, not assumed: each of these is replaced with U+FFFD on the
        // way out, so each is a real loss and refusing it refuses nothing that
        // would have survived.
        it('counts overlong encodings and lone surrogates as losses', () => {
          expect(() => strict().execute_script('return {["\\xC0\\xAF"]="v"}'))
            .toThrow(/not valid UTF-8/);
          expect(() => strict().execute_script('return {["\\xED\\xA0\\x80"]="v"}'))
            .toThrow(/not valid UTF-8/);
        });

        // The other half of the property, and the more important one: a refusal
        // that fired on keys which *do* survive would be a false alarm shipped
        // as behaviour.
        it('accepts every key that survives the crossing unchanged', () => {
          const lua = strict();
          expect(lua.execute_script(
            'return {["café"]=1, ["日本"]=2, ["\\xF0\\x9F\\x98\\x80"]=3, ["plain"]=4, [7]=5}'))
            .toEqual({ café: 1, 日本: 2, '😀': 3, plain: 4, 7: 5 });
        });

        it('points at the escape hatch that actually works', () => {
          // handle.pairs() converts keys as *values*, so binaryStrings carries
          // them byte-for-byte and nothing collides. This is what the refusal
          // message tells the caller to do, so it has to be true.
          const lua: any = new lua_native.init({}, { libraries: 'all', binaryStrings: true });
          lua.execute_script('t = {["\\xFF"]="a", ["\\xFE"]="b"}');
          const h = lua.get_global_ref('t');
          const keys = [...h.pairs()].map(([k]: any[]) => [...k]);
          expect(keys).toHaveLength(2);
          expect(keys).toEqual(expect.arrayContaining([[255], [254]]));
          h.release();
        });
      });
    });

    describe('JS -> Lua: nil in a container', () => {
      it('truncates a sequence at a null by default, refuses under strict', () => {
        const l = lossy();
        l.set_global('a', [1, null, 3, 4]);
        expect(l.execute_script('return #a')).toBe(1);
        expect(l.execute_script('return a[4]')).toBe(4);   // present, just not in the sequence
        expect(() => strict().set_global('a', [1, null, 3, 4]))
          .toThrow(/strict conversion.*array index 1.*ends the sequence/s);
      });

      it('removes a key for a null value by default, refuses under strict', () => {
        const l = lossy();
        l.set_global('o', { a: null, b: 1 });
        expect(l.execute_script('return tostring(o.a)')).toBe('nil');
        expect(() => strict().set_global('o', { a: null }))
          .toThrow(/strict conversion.*key "a".*removes the key/s);
      });

      it('treats undefined the same as null — both are Lua nil', () => {
        expect(() => strict().set_global('a', [1, undefined, 3]))
          .toThrow(/strict conversion.*array index 1/);
      });
    });

    // A mode that refused too much would be worse than the losses: these are the
    // conversions that must keep working, including the documented workarounds
    // §5 and types.d.ts tell callers to use.
    describe('does not refuse what it should not', () => {
      it('leaves ordinary values alone in both directions', () => {
        const lua = strict();
        expect(lua.execute_script('return {x=1,y="two",z={1,2}}')).toEqual({ x: 1, y: 'two', z: [1, 2] });
        expect(lua.execute_script('return {10,20,30}')).toEqual([10, 20, 30]);
        // a number key and a string key that do NOT collide are both fine
        expect(lua.execute_script('return {[1]="a",b="c"}')).toEqual({ 1: 'a', b: 'c' });
        lua.set_global('n', { a: [1, 2, { b: 3 }] });
        expect(lua.execute_script('return n.a[3].b')).toBe(3);
      });

      it('accepts the documented workarounds', () => {
        const lua = strict();
        lua.set_global('f', [1, false, 3]);              // false is a present value
        expect(lua.execute_script('return #f')).toBe(3);
        expect(() => lua.set_global('g', [1, 3].filter((x: any) => x != null))).not.toThrow();
      });

      it('a top-level null is still nil — only a container loses information', () => {
        const lua = strict();
        lua.set_global('z', null);
        expect(lua.execute_script('return tostring(z)')).toBe('nil');
        expect(lua.execute_script('return tostring(nothing)')).toBe('nil');
      });

      it('a handle reads in place, which is what §5 says to do instead', () => {
        const lua = strict();
        lua.execute_script('t = {[true]="bool",[1]="int",["1"]="str"}');
        const h = lua.get_global_ref('t');            // no conversion, so no loss
        expect(h.get(1)).toBe('int');
        expect(h.get('1')).toBe('str');
        h.release();
      });

      it('leaves the BigInt widening alone — a type change, not a loss', () => {
        expect(strict().execute_script('return 9007199254740993')).toBe(9007199254740993n);
      });
    });

    it('refuses identically at every door a value can enter Lua through', () => {
      // Uniformity is the property that matters: a mode honoured by set_global
      // but not by a Lua function argument would be worse than no mode at all.
      const lua = strict();
      const f = lua.execute_script('return function(x) return x end');
      const h = lua.create_table({});
      expect(() => lua.set_global('a', [1, null])).toThrow(/strict conversion/);
      expect(() => f([1, null])).toThrow(/strict conversion/);
      expect(() => h.set('k', [1, null])).toThrow(/strict conversion/);
      expect(() => lua.create_table({ k: [1, null] })).toThrow(/strict conversion/);
      expect(() => lua.execute_script_in(lua.create_environment({}), 'return 1')).not.toThrow();
    });

    it('survives reset(), because it rides on the runtime config', () => {
      const lua = strict();
      lua.reset();
      expect(() => lua.execute_script('return {[true]=1}')).toThrow(/strict conversion/);
    });

    // CR-23 F5. ResumeAsyncStep is the shared floor under three doors, and its
    // vocabulary is the resume machinery's. call_async's *first* step is the one
    // place that is wrong: those values are the caller's arguments.
    describe('names the operation the caller actually performed', () => {
      it('call_async reports an argument, not a resume value', async () => {
        const lua = strict();
        lua.execute_script('function id(x) return x end');
        await expect(lua.call_async('id', [1, null, 3]))
          .rejects.toThrow(/^Error converting argument: strict conversion/);
      });

      it('resume_async still reports a resume value, because that is what it is', async () => {
        const lua = strict();
        const co = lua.create_coroutine('return function(x) return x end');
        const res = await lua.resume_async(co, [1, null, 3]);
        expect(res.error).toMatch(/^Error converting resume value: strict conversion/);
      });

      it('an awaited promise settling to a lossy value is still a resume value', async () => {
        const lua = strict();
        lua.set_global('slow', () => Promise.resolve([1, null, 3]));
        await expect(lua.execute_async('return slow()'))
          .rejects.toThrow(/Error converting resume value: strict conversion/);
      });
    });

    // The statable property both options together deliver, and the reason the
    // byte-key refusal is scoped to keys: values have a remedy, keys do not.
    it('with binaryStrings there is no silent loss left in either direction', () => {
      const lua: any = new lua_native.init({},
        { libraries: 'all', strictConversion: true, binaryStrings: true });
      // values: exact bytes, no refusal needed
      expect([...lua.execute_script('return string.pack("i4", -2)')]).toEqual([254, 255, 255, 255]);
      // keys: refused rather than mangled
      expect(() => lua.execute_script('return {["\\xFF"]="a"}')).toThrow(/strict conversion/);
      // and the structural losses stay refused
      expect(() => lua.set_global('a', [1, null, 3])).toThrow(/strict conversion/);
    });

    it('is off by default and rejects a non-boolean rather than ignoring it', () => {
      expect(lossy().execute_script('return {[true]=1}')).toEqual({});
      expect(() => new lua_native.init({}, { strictConversion: 'yes' as any }))
        .toThrow(/strictConversion must be a boolean/);
      // explicit false is accepted and means off
      const off: any = new lua_native.init({}, { libraries: 'all', strictConversion: false });
      expect(off.execute_script('return {[true]=1}')).toEqual({});
    });

    it('leaves the already-loud refusals with their own messages', () => {
      // §5's other two entries throw with or without the mode; strict must not
      // relabel them, or the message stops naming the real cause.
      const lua = strict();
      const cyclic: any = {};
      cyclic.self = cyclic;
      expect(() => lua.set_global('c', cyclic)).toThrow(/circular reference/);
      let deep: any = {};
      for (let i = 0; i < 120; i++) deep = { n: deep };
      expect(() => lua.set_global('d', deep)).toThrow(/nesting depth/);
    });
  });

  describe("libraries: 'sandbox' — the sealed preset (LIMITATIONS §1)", () => {
    it('removes every filesystem door', () => {
      const lua: any = new lua_native.init({}, { libraries: 'sandbox' });
      for (const g of ['dofile', 'loadfile', 'require', 'package', 'io', 'os', 'debug']) {
        expect(lua.execute_script(`return type(${g})`), g).toBe('nil');
      }
    });

    it('leaves ordinary scripting intact — a sandbox nobody can use is useless', () => {
      const lua: any = new lua_native.init({}, { libraries: 'sandbox' });
      expect(lua.execute_script('return math.floor(3.7) .. ":" .. ("x"):rep(2)')).toBe('3:xx');
      expect(lua.execute_script('local t = {} for i = 1, 3 do t[i] = i * 2 end return table.concat(t, ",")'))
        .toBe('2,4,6');
      expect(lua.execute_script(
        'local co = coroutine.create(function() coroutine.yield(7) end) local _, v = coroutine.resume(co) return v'))
        .toBe(7);
    });

    it('defaults bytecode off, and an explicit allowBytecode:true still wins', () => {
      const sealed: any = new lua_native.init({}, { libraries: 'sandbox' });
      expect(sealed.execute_script(
        'local f = load(string.dump(function() end)) return tostring(f)')).toBe('nil');
      const opened: any = new lua_native.init({}, { libraries: 'sandbox', allowBytecode: true });
      expect(opened.execute_script(
        'local f = load(string.dump(function() end)) return type(f)')).toBe('function');
    });

    it('the seal survives reset()', () => {
      // reset() rebuilds the runtime from its config; if the seal lived only in
      // the constructor path it would silently come back unsealed.
      const lua: any = new lua_native.init({}, { libraries: 'sandbox' });
      lua.reset();
      expect(lua.execute_script('return type(dofile)')).toBe('nil');
      expect(lua.execute_script('return type(require)')).toBe('nil');
    });
  });

  describe('LIMITATIONS.md — pinned so the documented claims stay true', () => {
    it("§1: 'safe' does NOT seal the filesystem (documented, not a surprise)", () => {
      // Pinned in the direction it actually behaves. If a future change seals
      // 'safe', this test fails and LIMITATIONS.md §1 must be rewritten — which
      // is the point: the doc and the code cannot drift apart silently.
      const lua: any = new lua_native.init({}, { libraries: 'safe' });
      expect(lua.execute_script('return type(dofile)')).toBe('function');
      expect(lua.execute_script('return type(loadfile)')).toBe('function');
      expect(lua.execute_script('return type(require)')).toBe('function');
      // ...while the three it does remove stay removed.
      expect(lua.execute_script('return type(io)')).toBe('nil');
      expect(lua.execute_script('return type(os)')).toBe('nil');
      expect(lua.execute_script('return type(debug)')).toBe('nil');
    });

    it('§1: the documented sealed configuration actually seals', () => {
      // The recipe LIMITATIONS.md gives. If any line of this stops working the
      // doc is handing out a broken remedy, which is worse than no remedy.
      const lua: any = new lua_native.init({}, {
        libraries: ['base', 'coroutine', 'table', 'string', 'math', 'utf8'],
        allowBytecode: false,
      });
      lua.execute_script('dofile = nil loadfile = nil');
      expect(lua.execute_script('return type(dofile)')).toBe('nil');
      expect(lua.execute_script('return type(loadfile)')).toBe('nil');
      expect(lua.execute_script('return type(require)')).toBe('nil');
      expect(lua.execute_script('return type(package)')).toBe('nil');
      expect(lua.execute_script('return type(io)')).toBe('nil');
      expect(lua.execute_script('return type(os)')).toBe('nil');
      // `load` reports failure by returning nil + a message; it does not raise.
      expect(lua.execute_script(
        'local f, err = load(string.dump(function() end)) return tostring(f) .. "|" .. tostring(err)'))
        .toMatch(/^nil\|.*binary chunk/);
      // ...and ordinary scripting still works, or the sandbox is useless.
      expect(lua.execute_script('return math.floor(3.7) .. "/" .. ("x"):rep(2)')).toBe('3/xx');
    });

    // Superseded by P1b (August 5, 2026). The old claim — "for await works
    // through JS's sync-iterable fallback, so Symbol.asyncIterator is not
    // needed" — was true and was also the reason a coroutine could not await a
    // host Promise: the fallback drives the *synchronous* cursor. The pin now
    // records the replacement fact.
    it('for await binds to Symbol.asyncIterator, not the sync fallback', async () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      const co = lua.create_coroutine(
        'return function() coroutine.yield(1) coroutine.yield(2) end');
      expect(typeof co[Symbol.asyncIterator]).toBe('function');
      const seen: any[] = [];
      for await (const v of co) seen.push(v);
      expect(seen).toEqual([1, 2]);
      // The sync iterator is still there, and still independent: each call mints
      // its own cursor over the one thread.
      expect(typeof co[Symbol.iterator]).toBe('function');
    });

    it('checked-not-a-limitation: __close works via set_metatable', () => {
      const lua: any = new lua_native.init({}, ALL_LIBS);
      lua.execute_script('res = {}');
      lua.set_metatable('res', { __close: () => undefined });
      expect(lua.execute_script(
        'local ok = pcall(function() local x <close> = res end) return ok')).toBe(true);
    });
  });

  describe('CODE-REVIEW-22 regressions', () => {
    describe('F1: a Lua-created userdata handle is refused across contexts', () => {
      // The distinction this finding turned on, and it is the whole point:
      // a *Lua-created* userdata (io.open) crosses to JS as an object whose own
      // properties are `["_userdata"]` — the marker and nothing else — so the
      // deep copy it used to get produced an EMPTY table. A file handle became
      // `{}` with no keys and no methods, silently. That is CR-17 F2's shape
      // (a Proxy/marker object deep-copied into something plausible and wrong),
      // so it gets CR-17 F2's remedy.
      it('a Lua file handle pushed into another context is refused, not emptied', () => {
        const a: any = new lua_native.init({}, ALL_LIBS);
        const b: any = new lua_native.init({}, ALL_LIBS);
        const f = a.execute_script('return io.open("/dev/null", "r")');
        expect(Object.getOwnPropertyNames(f)).toEqual(['_userdata']);
        expect(() => b.set_global('x', f))
          .toThrow(/userdata handle belongs to a different Lua context/);
      });

      it('the same handle still round-trips within its OWN context', () => {
        // The refusal must not break the legitimate case.
        const a: any = new lua_native.init({}, ALL_LIBS);
        const f = a.execute_script('return io.open("/dev/null", "r")');
        a.set_global('back', f);
        expect(a.execute_script('return type(back)')).toBe('userdata');
      });

      it('a JS-created userdata is NOT a handle and still crosses freely', () => {
        // The half of CR-22 F1 that was wrong, pinned so it is not "fixed"
        // later. `set_userdata` hands back the identical JS object with no
        // marker, so passing it anywhere is passing a plain object the caller
        // already owns — copying its fields is correct, not a leak.
        const a: any = new lua_native.init({}, ALL_LIBS);
        const b: any = new lua_native.init({}, ALL_LIBS);
        const original = { n: 11 };
        a.set_userdata('ud', original);
        const back = a.execute_script('return ud');
        expect(back).toBe(original);                       // the same object
        expect(Object.getOwnPropertyNames(back)).toEqual(['n']);  // no marker
        expect(() => b.set_global('x', back)).not.toThrow();
        expect(b.execute_script('return type(x) .. ":" .. tostring(x.n)')).toBe('table:11');
      });

      it('a coroutine pushed into another context is refused, not flattened', () => {
        // Found by the cross-context matrix built for F2, and it is F1's class
        // completed: a coroutine object's own properties are
        // `["_coroutine", "status"]`, so the deep copy dropped the marker and
        // produced `{ status = "suspended" }` — a thing that looks like a
        // coroutine, reports a status, and can do nothing. `resume` already
        // refused a foreign thread; the value path did not.
        const a: any = new lua_native.init({}, ALL_LIBS);
        const b: any = new lua_native.init({}, ALL_LIBS);
        const co = a.create_coroutine('return function() coroutine.yield(1) return 2 end');
        expect(() => b.set_global('c', co))
          .toThrow(/coroutine belongs to a different Lua context/);
        // Still usable in its own context — the refusal must not break that.
        expect(a.resume(co)).toEqual({ status: 'suspended', values: [1] });
      });

      it('a Lua function still bridges between contexts (not a handle)', () => {
        // Deliberately NOT refused, and pinned so it is not "made uniform"
        // later: a Lua function crosses to JS as a genuine JS callable, so the
        // second context registering it as a host callback is correct — calling
        // it runs the first context's Lua and returns the right answer.
        const a: any = new lua_native.init({}, ALL_LIBS);
        const b: any = new lua_native.init({}, ALL_LIBS);
        const fn = a.execute_script('return function(x) return x + 1 end');
        expect(() => b.set_global('f', fn)).not.toThrow();
        expect(b.execute_script('return f(1)')).toBe(2);
      });

      it('a foreign class instance still deep-copies (M6 is deliberate)', () => {
        // Pinned here too, next to the refusals, because the temptation is to
        // make all four markers uniform. This one carries its data as well as
        // its markers, so the copy delivers the data — which is what M6 chose.
        const a: any = new lua_native.init({}, ALL_LIBS);
        const b: any = new lua_native.init({}, ALL_LIBS);
        a.register_class('K', { construct: (v: any) => ({ hidden: v }), readable: true,
          methods: { get: (s: any) => s.hidden } });
        const inst = a.execute_script('return K.new(7)');
        expect(() => b.set_global('x', inst)).not.toThrow();
        expect(b.execute_script('return type(x) .. ":" .. tostring(x.hidden)')).toBe('table:7');
      });
    });
  });

  describe('CODE-REVIEW-21 regressions', () => {
    describe('F2: the cycle check covers the recursing builtin containers', () => {
      // CR-20 F2 put the check below ConvertBuiltinType, so Map and Set —
      // the two builtins that recurse — were converted without ever joining
      // the path they are compared against, and a self-containing Map still
      // reported the depth limit. These are the members that boundary missed.
      it('a cyclic Map reports a cycle, not depth', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const m = new Map();
        m.set('self', m);
        expect(() => lua.set_global('x', m)).toThrow(/circular reference/);
        try { lua.set_global('x', m); } catch (e: any) {
          expect(e.message).not.toMatch(/nesting depth/);
        }
      });

      it('a cyclic Set reports a cycle, not depth', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const s = new Set();
        s.add(s);
        expect(() => lua.set_global('x', s)).toThrow(/circular reference/);
        try { lua.set_global('x', s); } catch (e: any) {
          expect(e.message).not.toMatch(/nesting depth/);
        }
      });

      it('a cycle closed through a Map reports a cycle', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const m = new Map();
        const o: any = {};
        m.set('o', o);
        o.m = m;
        expect(() => lua.set_global('x', m)).toThrow(/circular reference/);
      });

      it('a cycle closed through a Set and an array reports a cycle', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const s = new Set();
        const a: any[] = [];
        s.add(a);
        a.push(s);
        expect(() => lua.set_global('x', s)).toThrow(/circular reference/);
      });

      it('a DAG through a Map is still not a cycle', () => {
        // CR-20's control, restated for the containers: moving the check up
        // must not turn sharing into a cycle.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const shared = { x: 1 };
        expect(() => lua.set_global('g', new Map([['a', shared], ['b', shared]]))).not.toThrow();
        expect(lua.execute_script('return g.a.x + g.b.x')).toBe(2);
      });

      it('the non-recursing builtins stay inert on the path', () => {
        // Date, RegExp and the binary views now join the conversion path too.
        // They never descend, so they cannot meet themselves — and the same
        // instance used twice in one object must still convert twice.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        const d = new Date(1000);
        const u = new Uint8Array([65, 66]);
        lua.set_global('x', { a: d, b: d, u1: u, u2: u, r: /ab+c/g });
        expect(lua.execute_script('return x.a + x.b')).toBe(2000);
        expect(lua.execute_script('return x.u1 .. x.u2')).toBe('ABAB');
        expect(lua.execute_script('return x.r')).toBe('ab+c');
      });

      it('nested container data still survives the crossing', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_global('x', new Map([['s', new Set([1, 2])]]));
        expect(lua.execute_script('return x.s[1] + x.s[2]')).toBe(3);
      });
    });

    describe('F1: every execution door describes a non-string error value alike', () => {
      // execute_async drives the script with lua_resume, which takes no message
      // handler — so the description MessageHandler produces for a non-string
      // error was absent at that one door, and `error({code=7})` surfaced as a
      // bare `table: 0x...`. Fixed by running the same handler under its own
      // protected call rather than mirroring its rule.
      const NON_STRING_ERRORS: ReadonlyArray<readonly [string, string, RegExp]> = [
        ['a table', 'error({code=7})', /\(error object is a table value\)/],
        ['a boolean', 'error(true)', /\(error object is a boolean value\)/],
        ['a number', 'error(5)', /^5\n/],
      ];

      for (const [what, script, expected] of NON_STRING_ERRORS) {
        it(`execute_script describes ${what}`, () => {
          const lua: any = new lua_native.init({}, ALL_LIBS);
          expect(() => lua.execute_script(script)).toThrow(expected);
        });

        it(`execute_async describes ${what} the same way`, async () => {
          const lua: any = new lua_native.init({}, ALL_LIBS);
          await expect(lua.execute_async(script)).rejects.toThrow(expected);
        });

        it(`execute_script_async describes ${what} the same way`, async () => {
          const lua: any = new lua_native.init({}, ALL_LIBS);
          await expect(lua.execute_script_async(script)).rejects.toThrow(expected);
        });
      }

      it('execute_async appends a traceback to a non-string error too', async () => {
        // The asymmetry inside the door: only the string branch tracebacked,
        // so error(nil) carried one and error({...}) did not.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        await expect(lua.execute_async('error({code=7})')).rejects.toThrow(/stack traceback:/);
      });

      it('error(nil) differs at the driver door because Lua makes it differ', async () => {
        // NOT a binding defect, and pinned so it is not "fixed" by matching on
        // liblua's internal string. lua_resume replaces a nil error object with
        // the string "<no error object>" before returning, so what arrives is
        // already a string and no formatting rule can recover the nil. Proven
        // here from inside Lua itself, where no lua-native code is involved.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(lua.execute_script(`
          local co = coroutine.create(function() error(nil) end)
          local ok, e = coroutine.resume(co)
          return type(e)`)).toBe('string');

        const driver: any = new lua_native.init({}, ALL_LIBS);
        await expect(driver.execute_async('error(nil)')).rejects.toThrow(/<no error object>/);
        // The pcall doors, which see the real nil, still describe it.
        const sync: any = new lua_native.init({}, ALL_LIBS);
        expect(() => sync.execute_script('error(nil)')).toThrow(/\(error object is a nil value\)/);
      });

      it('a __tostring on the error object still wins at every door', async () => {
        const script = 'error(setmetatable({}, {__tostring = function() return "custom!" end}))';
        const sync: any = new lua_native.init({}, ALL_LIBS);
        expect(() => sync.execute_script(script)).toThrow(/custom!/);
        const driver: any = new lua_native.init({}, ALL_LIBS);
        await expect(driver.execute_async(script)).rejects.toThrow(/custom!/);
      });

      it('a JS callback error still reconstructs through execute_async', async () => {
        // The structured-error path (__jsErrorId) must pass through untouched;
        // it is the case MessageHandler returns early for.
        const boom = new Error('from js');
        const lua: any = new lua_native.init(
          { thrower: () => { throw boom; } }, ALL_LIBS);
        await expect(lua.execute_async('thrower()')).rejects.toThrow(/from js/);
      });

      it('a string error is unchanged at every door', async () => {
        const sync: any = new lua_native.init({}, ALL_LIBS);
        expect(() => sync.execute_script('error("plain")')).toThrow(/plain/);
        const driver: any = new lua_native.init({}, ALL_LIBS);
        await expect(driver.execute_async('error("plain")')).rejects.toThrow(/plain/);
      });
    });
  });


  // ==========================================================================
  // INTEROP-PARITY-PLAN (August 5, 2026) — P1a, P1b, P2, P3, P4
  //
  // Every item here closed a *uniformity* gap rather than a capability gap:
  // something that worked through one door and not its siblings. The tests are
  // written to pin the agreement between doors, not only the new door's own
  // behaviour — a test that only exercised the new call would pass just as
  // happily if the old one drifted.
  // ==========================================================================
  describe('INTEROP-PARITY-PLAN', () => {

    describe('P2a: register_class statics', () => {
      const withPlayer = (extra: any = {}) => {
        let made = 0;
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_class('Player', {
          construct: (name: string) => { made++; return { name, hp: 100 }; },
          statics: { count: () => made, VERSION: '1.2.0', LIMITS: { max: 99 } },
          methods: { describe: (self: any) => `${self.name}` },
          ...extra,
        });
        return lua;
      };

      it('exposes a static function on the class table', () => {
        const lua = withPlayer();
        expect(lua.execute_script('Player.new("a") Player.new("b") return Player.count()')).toBe(2);
      });

      it('exposes static values, converted once at registration', () => {
        const lua = withPlayer();
        expect(lua.execute_script('return Player.VERSION')).toBe('1.2.0');
        expect(lua.execute_script('return Player.LIMITS.max')).toBe(99);
      });

      it('a static is a snapshot, not a live view of the JS property', () => {
        const src = { n: 1 };
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_class('C', { construct: () => ({}), statics: { n: src.n } });
        src.n = 2;
        expect(lua.execute_script('return C.n')).toBe(1);
      });

      it('statics live on the class, not on instances', () => {
        const lua = withPlayer();
        expect(lua.execute_script('local p = Player.new("a") return tostring(p.VERSION)')).toBe('nil');
      });

      it("rejects a static named 'new'", () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.register_class('C', {
          construct: () => ({}), statics: { new: () => 1 },
        })).toThrow(/static 'new' is reserved/);
      });

      it('a rejected definition registers nothing — the name stays free', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.register_class('C', {
          construct: () => ({}), statics: { new: () => 1 },
        })).toThrow(/static 'new' is reserved/);
        // The reservation must have rolled back (CR-8 F3), so a retry works.
        expect(() => lua.register_class('C', { construct: () => ({ a: 1 }) })).not.toThrow();
        expect(lua.execute_script('return type(C.new())')).toBe('userdata');
      });

      it('statics are NOT inherited through extends', () => {
        const lua = withPlayer();
        lua.register_class('Mage', { extends: 'Player', construct: () => ({ name: 'm', hp: 1 }) });
        expect(lua.execute_script('return tostring(Mage.VERSION)')).toBe('nil');
        // ...while methods still are, so this is a deliberate difference and
        // not inheritance being broken.
        expect(lua.execute_script('return Mage.new():describe()')).toBe('m');
      });

      it('survives reset only by re-registration — like every other class', () => {
        const lua = withPlayer();
        lua.reset();
        expect(lua.execute_script('return tostring(Player)')).toBe('nil');
      });
    });

    describe('P2b: register_class property accessors', () => {
      const mk = () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_class('Player', {
          construct: (name: string) => ({ _name: name, _hp: 100, _secret: null }),
          properties: {
            hp: {
              get: (self: any) => self._hp,
              set: (self: any, v: any) => {
                if (v < 0) throw new Error('hp must be >= 0');
                self._hp = v;
              },
            },
            name: { get: (self: any) => self._name },
            secret: { set: (self: any, v: any) => { self._secret = v; } },
          },
          methods: { describe: (self: any) => `${self._name}@${self._hp}` },
        });
        return lua;
      };

      it('a getter runs on read', () => {
        expect(mk().execute_script('return Player.new("Link").hp')).toBe(100);
      });

      it('a setter runs on write', () => {
        expect(mk().execute_script('local p = Player.new("Link") p.hp = 42 return p.hp')).toBe(42);
      });

      it('accessors win over readable/writable, which are not set here', () => {
        // No `readable`/`writable` on the definition at all: the only reachable
        // properties are the declared ones. That is the point of P2b.
        const lua = mk();
        expect(lua.execute_script('return tostring(Player.new("Link")._hp)')).toBe('nil');
      });

      it('a get-only property is read-only', () => {
        expect(mk().execute_script(
          'local p = Player.new("Link") local ok, e = pcall(function() p.name = "x" end) return tostring(e)'))
          .toMatch(/property 'name' of class 'Player' is read-only/);
      });

      it('a set-only property is write-only', () => {
        expect(mk().execute_script(
          'local p = Player.new("Link") local ok, e = pcall(function() return p.secret end) return tostring(e)'))
          .toMatch(/property 'secret' of class 'Player' is write-only/);
      });

      it('a throwing setter reaches the script', () => {
        expect(mk().execute_script(
          'local p = Player.new("Link") local ok, e = pcall(function() p.hp = -1 end) return tostring(e)'))
          .toMatch(/hp must be >= 0/);
      });

      it('a throwing getter reaches the script, even on a class with methods', () => {
        // The narrowing of ClassIndex's catch to PropertyAccessDenied. Before
        // it, ANY getter exception on an object with methods became nil —
        // indistinguishable from an absent field.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_class('C', {
          construct: () => ({}),
          properties: { boom: { get: () => { throw new Error('kaboom'); } } },
          methods: { m: () => 1 },
        });
        expect(lua.execute_script(
          'local c = C.new() local ok, e = pcall(function() return c.boom end) return tostring(e)'))
          .toMatch(/kaboom/);
      });

      it('a not-readable userdata with methods still answers nil, not an error', () => {
        // The other half of the same narrowing: the access-policy refusal keeps
        // its documented nil behaviour.
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('u', { a: 1 }, { readable: false, methods: { m: () => 1 } });
        expect(lua.execute_script('return tostring(u.a)')).toBe('nil');
      });

      it('a throwing getter on plain proxy userdata also reaches the script', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_userdata('u', { get boom(): any { throw new Error('ud kaboom'); } },
          { readable: true, methods: { m: () => 1 } });
        expect(lua.execute_script(
          'local ok, e = pcall(function() return u.boom end) return tostring(e)'))
          .toMatch(/ud kaboom/);
      });

      it('a method shadows an accessor of the same name', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.register_class('C', {
          construct: () => ({}),
          properties: { thing: { get: () => 'accessor' } },
          methods: { thing: () => 'method' },
        });
        expect(lua.execute_script('return C.new():thing()')).toBe('method');
      });

      it('accessors ARE inherited through extends', () => {
        const lua = mk();
        lua.register_class('Mage', {
          extends: 'Player',
          construct: (n: string) => ({ _name: n, _hp: 50 }),
          methods: { cast: () => 'zap' },
        });
        expect(lua.execute_script('return Mage.new("g").hp')).toBe(50);
        expect(lua.execute_script('local m = Mage.new("g") m.hp = 7 return m.hp')).toBe(7);
        expect(lua.execute_script('return Mage.new("g").name')).toBe('g');
      });

      it('a derived class may override an inherited accessor', () => {
        const lua = mk();
        lua.register_class('Ghost', {
          extends: 'Player',
          construct: (n: string) => ({ _name: n, _hp: 1 }),
          properties: { hp: { get: () => 0 } },
        });
        expect(lua.execute_script('return Ghost.new("g").hp')).toBe(0);
        expect(lua.execute_script('return Player.new("p").hp')).toBe(100);
      });

      it('rejects a malformed property definition', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(() => lua.register_class('A', { construct: () => ({}), properties: { x: 5 } }))
          .toThrow(/must be an object with 'get' and\/or 'set'/);
        expect(() => lua.register_class('B', { construct: () => ({}), properties: { x: {} } }))
          .toThrow(/declares neither 'get' nor 'set'/);
      });

      it('accessors are dropped by reset, with the classes they belong to', () => {
        const lua = mk();
        lua.reset();
        // Re-registering the same name must work, and must not see stale
        // accessors from the previous generation.
        lua.register_class('Player', { construct: () => ({ _hp: 5 }), readable: true });
        expect(lua.execute_script('return Player.new()._hp')).toBe(5);
      });
    });

    describe('P1a: call_async', () => {
      const mk = () => {
        const lua: any = new lua_native.init({
          fetchName: async (id: number) => { await new Promise(r => setTimeout(r, 1)); return `user-${id}`; },
          double: (x: number) => x * 2,
        }, ALL_LIBS);
        lua.execute_script(`
          function greet(id, suffix) return fetchName(id) .. (suffix or ""), double(21) end
          tbl = { nested = function(a) return fetchName(a) .. "!" end }
          notafn = 5
        `);
        return lua;
      };

      it('awaits a host Promise inside a function called by name', async () => {
        expect(await mk().call_async('greet', 7, '?')).toEqual(['user-7?', 42]);
      });

      it('accepts a dotted path, like call()', async () => {
        expect(await mk().call_async('tbl.nested', 3)).toBe('user-3!');
      });

      it('awaits inside a LuaFunction held only on the JS side', async () => {
        // The capability hole: this function is not reachable by name, so the
        // execute_async workaround does not apply to it at all.
        const lua = mk();
        const fn = lua.execute_script('return function(id) return fetchName(id) .. "/held" end');
        expect(await lua.call_async(fn, 9)).toBe('user-9/held');
      });

      it('the synchronous call() still refuses a Promise, pointing at the async doors', () => {
        expect(() => mk().call('greet', 1)).toThrow(/returned a Promise/);
        expect(() => mk().call('greet', 1)).toThrow(/call_async/);
      });

      it('rejects rather than throws for every failure past validation', async () => {
        const lua = mk();
        await expect(lua.call_async('nosuch')).rejects.toThrow(/is not a function/);
        await expect(lua.call_async('notafn')).rejects.toThrow(/is not a function/);
        await expect(lua.call_async('tbl..nested')).rejects.toThrow(/path segments must be non-empty/);
      });

      it('throws synchronously only for a bad argument type', () => {
        expect(() => mk().call_async(5)).toThrow(/requires a global name or a Lua function/);
        expect(() => mk().call_async(() => 1)).toThrow(/plain JavaScript function/);
      });

      it('a Lua error becomes a rejection', async () => {
        const lua = mk();
        lua.execute_script('function boom() error("kaboom") end');
        await expect(lua.call_async('boom')).rejects.toThrow(/kaboom/);
      });

      it('a rejected host Promise propagates', async () => {
        const lua: any = new lua_native.init(
          { failing: async () => { throw new Error('nope'); } }, ALL_LIBS);
        lua.execute_script('function f() return failing() end');
        await expect(lua.call_async('f')).rejects.toThrow(/nope/);
      });

      it('is one-run-at-a-time, like execute_async', async () => {
        const lua = mk();
        const p = lua.call_async('greet', 1);
        expect(() => lua.call_async('greet', 2)).toThrow(/busy with an async operation/);
        await p;
        expect(lua.is_busy()).toBe(false);
      });

      it('cancel() rejects it and leaves the context usable', async () => {
        const lua: any = new lua_native.init({ never: () => new Promise(() => {}) }, ALL_LIBS);
        lua.execute_script('function hangs() return never() end');
        const p = lua.call_async('hangs');
        lua.cancel();
        await expect(p).rejects.toThrow(/execution cancelled/);
        expect(lua.is_busy()).toBe(false);
        expect(lua.execute_script('return 1')).toBe(1);
      });

      it('refuses a callable table, exactly as call() does', async () => {
        const lua = mk();
        lua.execute_script('callable = setmetatable({}, { __call = function() return 1 end })');
        expect(() => lua.call('callable')).toThrow(/is not a function/);
        await expect(lua.call_async('callable')).rejects.toThrow(/is not a function/);
      });

      it('refuses a function from another context', async () => {
        const a = mk();
        const b: any = new lua_native.init({}, ALL_LIBS);
        const fn = a.execute_script('return function() return 1 end');
        await expect(b.call_async(fn)).rejects.toThrow(/different Lua context/);
      });

      it('refuses a released function', async () => {
        const lua = mk();
        const fn = lua.execute_script('return function() return 1 end');
        lua.release(fn);
        await expect(lua.call_async(fn)).rejects.toThrow(/has been released/);
      });

      it('a bare coroutine.yield is still an error, and names resume_async', async () => {
        const lua = mk();
        lua.execute_script('function y() coroutine.yield(1) end');
        await expect(lua.call_async('y')).rejects.toThrow(/resume_async/);
        expect(lua.is_busy()).toBe(false);
      });
    });

    describe('P1b: resume_async', () => {
      const mk = () => {
        const lua: any = new lua_native.init({
          fetchUser: async (id: number) => { await new Promise(r => setTimeout(r, 1)); return `user-${id}`; },
          bump: (x: number) => x + 1,
        }, ALL_LIBS);
        return lua;
      };
      const body = `
        return function(start)
          start = start or 1
          for i = start, start + 2 do
            coroutine.yield(fetchUser(i), bump(i))
          end
          return "finished"
        end
      `;

      it('a user coroutine can await a host Promise', async () => {
        const lua = mk();
        const co = lua.create_coroutine(body);
        expect(await lua.resume_async(co, 10))
          .toEqual({ status: 'suspended', values: ['user-10', 11] });
        expect(await lua.resume_async(co))
          .toEqual({ status: 'suspended', values: ['user-11', 12] });
      });

      it('the synchronous resume() still cannot — the gap this closes', () => {
        const lua = mk();
        const co = lua.create_coroutine(body);
        expect(lua.resume(co, 1).error).toMatch(/returned a Promise/);
      });

      it('runs to completion and reports dead', async () => {
        const lua = mk();
        const co = lua.create_coroutine(body);
        for (let i = 0; i < 3; i++) await lua.resume_async(co, 1);
        expect(await lua.resume_async(co)).toEqual({ status: 'dead', values: ['finished'] });
      });

      it('resolves with the same shape resume() returns, error included', async () => {
        const lua = mk();
        const co = lua.create_coroutine('return function() error("inner boom") end');
        const r = await lua.resume_async(co);
        // Reported in the result, not thrown — matching resume() exactly.
        expect(r.status).toBe('dead');
        expect(r.error).toMatch(/inner boom/);
      });

      it('a rejected host Promise arrives as the result error', async () => {
        const lua: any = new lua_native.init(
          { failing: async () => { throw new Error('host nope'); } }, ALL_LIBS);
        const co = lua.create_coroutine('return function() return failing() end');
        expect((await lua.resume_async(co)).error).toMatch(/host nope/);
      });

      it('updates the coroutine object status, like resume()', async () => {
        const lua = mk();
        const co = lua.create_coroutine(body);
        await lua.resume_async(co, 1);
        expect(co.status).toBe('suspended');
      });

      it('a coroutine nested inside it still cannot await, and says so', async () => {
        const lua = mk();
        const co = lua.create_coroutine(`
          return function()
            local inner = coroutine.create(function() return fetchUser(1) end)
            local ok, err = coroutine.resume(inner)
            coroutine.yield(tostring(err))
          end
        `);
        const r = await lua.resume_async(co);
        expect(r.values[0]).toMatch(/coroutine this run is not driving/);
      });

      it('a refused nested await does not misbind the next plain yield', async () => {
        // The stale-pending-promise defect. The stash is written before the
        // core decides whether this thread is the driven one, so a refused
        // await left a promise that the next yield was read as.
        const lua = mk();
        const co = lua.create_coroutine(`
          return function()
            local inner = coroutine.create(function() return fetchUser(99) end)
            coroutine.resume(inner)
            coroutine.yield("a plain yield")
            coroutine.yield("and another")
          end
        `);
        expect((await lua.resume_async(co)).values).toEqual(['a plain yield']);
        expect((await lua.resume_async(co)).values).toEqual(['and another']);
      });

      it('cancel() leaves the caller\'s coroutine suspended and resumable', async () => {
        // The distinguishing contract: the thread is the caller's, so
        // abandoning the run may not release it.
        const lua: any = new lua_native.init({ never: () => new Promise(() => {}) }, ALL_LIBS);
        const co = lua.create_coroutine(
          'return function() coroutine.yield(1) never() coroutine.yield(2) end');
        expect((await lua.resume_async(co)).values).toEqual([1]);
        const p = lua.resume_async(co);
        lua.cancel();
        await expect(p).rejects.toThrow(/execution cancelled/);
        expect(lua.is_busy()).toBe(false);
        expect(co.status).toBe('suspended');
        // Still drivable afterwards — the whole point. It resumes at the
        // abandoned await (which delivers nil, since nothing settled it) and
        // runs on to the next yield.
        expect(lua.resume(co)).toMatchObject({ status: 'suspended', values: [2] });
      });

      it('is one-run-at-a-time', async () => {
        const lua = mk();
        const co = lua.create_coroutine(body);
        const p = lua.resume_async(co, 1);
        expect(() => lua.resume_async(co)).toThrow(/busy with an async operation/);
        await p;
      });

      it('refuses a coroutine from another context', async () => {
        const lua = mk();
        const other: any = new lua_native.init({}, ALL_LIBS);
        await expect(other.resume_async(lua.create_coroutine(body)))
          .rejects.toThrow(/different Lua context/);
      });

      it('refuses a released coroutine', async () => {
        const lua = mk();
        const co = lua.create_coroutine(body);
        lua.release(co);
        await expect(lua.resume_async(co)).rejects.toThrow(/has been released/);
      });

      it('rejects a non-coroutine object', () => {
        expect(() => mk().resume_async({})).toThrow(/Invalid coroutine object/);
        expect(() => mk().resume_async()).toThrow(/requires a coroutine object/);
      });
    });

    describe('P1b: Symbol.asyncIterator', () => {
      const mk = () => new (lua_native as any).init({
        fetchUser: async (id: number) => { await new Promise(r => setTimeout(r, 1)); return `user-${id}`; },
      }, ALL_LIBS);
      const body = `
        return function()
          for i = 1, 3 do coroutine.yield(fetchUser(i)) end
          return "done"
        end
      `;

      it('for await drives a coroutine that awaits', async () => {
        const lua: any = mk();
        const seen: any[] = [];
        for await (const v of lua.create_coroutine(body)) seen.push(v);
        expect(seen).toEqual(['user-1', 'user-2', 'user-3']);
      });

      it('the final return is discarded, as the generator contract requires', async () => {
        const lua: any = mk();
        const seen: any[] = [];
        for await (const v of lua.create_coroutine(body)) seen.push(v);
        expect(seen).not.toContain('done');
      });

      it('breaking out leaves the coroutine suspended and resumable', async () => {
        const lua: any = mk();
        const co = lua.create_coroutine(body);
        const seen: any[] = [];
        for await (const v of co) { seen.push(v); if (seen.length === 2) break; }
        expect(seen).toEqual(['user-1', 'user-2']);
        expect(co.status).toBe('suspended');
        expect((await lua.resume_async(co)).values).toEqual(['user-3']);
      });

      it('each call mints an independent cursor over the one thread', async () => {
        const lua: any = mk();
        const co = lua.create_coroutine(body);
        const a = co[Symbol.asyncIterator]();
        const b = co[Symbol.asyncIterator]();
        expect((await a.next()).value).toBe('user-1');
        expect((await b.next()).value).toBe('user-2');   // same thread, next step
      });

      it('an already-dead coroutine ends the iteration rather than erroring', async () => {
        const lua: any = mk();
        const co = lua.create_coroutine(body);
        for await (const _ of co) { /* drain */ }
        const seen: any[] = [];
        for await (const v of co) seen.push(v);
        expect(seen).toEqual([]);
      });

      it('a Lua error inside the coroutine rejects the iteration', async () => {
        const lua: any = mk();
        const co = lua.create_coroutine('return function() error("iter boom") end');
        await expect((async () => { for await (const _ of co) { /* */ } })())
          .rejects.toThrow(/iter boom/);
      });

      it('a cursor whose method was destructured still works', async () => {
        // The state is shared_ptr-owned and every root holds its own copy, so a
        // detached `next` keeps it alive (H3 / L6).
        const lua: any = mk();
        const it = lua.create_coroutine(body)[Symbol.asyncIterator]();
        const { next } = it;
        expect((await next.call(it)).value).toBe('user-1');
      });

      it('a pending step survives dropping the iterator that made it', async () => {
        // The mapper closure can outlive `next` and the iterator; it roots the
        // cursor state itself for exactly this case.
        const lua: any = mk();
        let it: any = lua.create_coroutine(body)[Symbol.asyncIterator]();
        const p = it.next();
        it = null;
        global.gc?.();
        expect((await p).value).toBe('user-1');
      });

      it('the synchronous iterator is still present and still synchronous', () => {
        const lua: any = mk();
        const co = lua.create_coroutine(
          'return function() coroutine.yield(1) coroutine.yield(2) end');
        expect([...co]).toEqual([1, 2]);
      });
    });

    describe('P3: close(coroutine)', () => {
      const mk = (notes: string[]) => {
        const lua: any = new lua_native.init(
          { note: (s: string) => { notes.push(s); } }, ALL_LIBS);
        return lua;
      };
      const body = `
        return function()
          local guard <close> = setmetatable({}, { __close = function() note("closed") end })
          for i = 1, 5 do coroutine.yield(i) end
        end
      `;

      it('runs a suspended coroutine\'s to-be-closed variables', () => {
        const notes: string[] = [];
        const lua = mk(notes);
        const co = lua.create_coroutine(body);
        lua.resume(co);
        expect(notes).toEqual([]);
        lua.close(co);
        expect(notes).toEqual(['closed']);
        expect(co.status).toBe('dead');
      });

      it('covers the case the iterator contract creates: break, then close', () => {
        const notes: string[] = [];
        const lua = mk(notes);
        const co = lua.create_coroutine(body);
        for (const v of co) { if (v === 2) break; }
        expect(co.status).toBe('suspended');
        expect(notes).toEqual([]);         // the resource is still held
        lua.close(co);
        expect(notes).toEqual(['closed']);
      });

      it('is idempotent', () => {
        const notes: string[] = [];
        const lua = mk(notes);
        const co = lua.create_coroutine(body);
        lua.resume(co);
        lua.close(co);
        lua.close(co);
        expect(notes).toEqual(['closed']);
      });

      it('is a no-op on a coroutine that already ran to completion', () => {
        const notes: string[] = [];
        const lua = mk(notes);
        const co = lua.create_coroutine(body);
        for (const _ of co) { /* drain */ }
        expect(notes).toEqual(['closed']);   // Lua closed it on normal exit
        expect(() => lua.close(co)).not.toThrow();
        expect(notes).toEqual(['closed']);
      });

      it('a resume after close reports dead', () => {
        const lua = mk([]);
        const co = lua.create_coroutine(body);
        lua.resume(co);
        lua.close(co);
        expect(lua.resume(co).status).toBe('dead');
      });

      it('a throwing __close surfaces, and the thread is still dead', () => {
        const lua: any = new lua_native.init(
          { boom: () => { throw new Error('close failed'); } }, ALL_LIBS);
        const co = lua.create_coroutine(`
          return function()
            local g <close> = setmetatable({}, { __close = function() boom() end })
            coroutine.yield(1)
          end
        `);
        lua.resume(co);
        expect(() => lua.close(co)).toThrow(/close failed/);
        expect(co.status).toBe('dead');
      });

      it('release() still does not close — the two stay orthogonal', () => {
        const notes: string[] = [];
        const lua = mk(notes);
        const co = lua.create_coroutine(body);
        lua.resume(co);
        lua.release(co);
        expect(notes).toEqual([]);
        // And closing a released coroutine is a silent no-op: there is no
        // pending state a caller could still be responsible for.
        expect(() => lua.close(co)).not.toThrow();
        expect(notes).toEqual([]);
      });

      it('refuses a coroutine from another context', () => {
        const lua = mk([]);
        const other: any = new lua_native.init({}, ALL_LIBS);
        expect(() => other.close(lua.create_coroutine(body)))
          .toThrow(/different Lua context/);
      });

      it('refuses a non-coroutine object, including a mislabelled marker', () => {
        const lua = mk([]);
        expect(() => lua.close({})).toThrow(/Invalid coroutine object/);
        expect(() => lua.close()).toThrow(/requires a coroutine object/);
        // A genuine External of the wrong kind must not be reinterpreted
        // (CR-15 F6).
        const handle = lua.create_table({ a: 1 });
        expect(() => lua.close({ _coroutine: (handle as any)._tableRef }))
          .toThrow(/Invalid coroutine object/);
      });
    });

    describe('P4a: set_read_handler', () => {
      const mk = (lines: string[]) => {
        let i = 0;
        const seen: any[] = [];
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_read_handler((fmt: any) => {
          seen.push(fmt);
          return i < lines.length ? lines[i++] : null;
        });
        return { lua, seen };
      };

      it('routes io.read() to the handler, defaulting to the line format', () => {
        const { lua, seen } = mk(['Ada']);
        expect(lua.execute_script('return io.read()')).toBe('Ada');
        expect(seen).toEqual(['l']);
      });

      it('converts the "n" format to a number', () => {
        const { lua } = mk(['42']);
        expect(lua.execute_script('return io.read("n")')).toBe(42);
      });

      it('yields nil for an unparseable "n"', () => {
        const { lua } = mk(['not a number']);
        expect(lua.execute_script('return tostring(io.read("n"))')).toBe('nil');
      });

      it('strips the Lua 5.3 "*" prefix so a handler sees one spelling', () => {
        const { lua, seen } = mk(['x']);
        lua.execute_script('return io.read("*l")');
        expect(seen).toEqual(['l']);
      });

      it('passes a byte count through as a number', () => {
        const { lua, seen } = mk(['x']);
        lua.execute_script('return io.read(5)');
        expect(seen).toEqual([5]);
      });

      it('calls the handler once per requested format', () => {
        const { lua, seen } = mk(['a', 'b']);
        expect(lua.execute_script('return {io.read("l", "l")}')).toEqual(['a', 'b']);
        expect(seen).toEqual(['l', 'l']);
      });

      it('null means end-of-input and arrives as nil', () => {
        const { lua } = mk([]);
        expect(lua.execute_script('return tostring(io.read())')).toBe('nil');
      });

      it('an empty string is a line, not end-of-input', () => {
        const { lua } = mk(['']);
        expect(lua.execute_script('return tostring(io.read())')).toBe('');
      });

      it('a throwing handler surfaces as a Lua error', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_read_handler(() => { throw new Error('read boom'); });
        expect(lua.execute_script('local ok, e = pcall(io.read) return tostring(e)'))
          .toMatch(/read boom/);
      });

      it('clearing restores the original io.read without an unwrap step', () => {
        const { lua } = mk(['x']);
        lua.set_read_handler(null);
        expect(lua.execute_script('return type(io.read)')).toBe('function');
      });

      it('re-installing does not stack wrappers', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_read_handler(() => 'a');
        lua.set_read_handler(() => 'b');
        lua.set_read_handler(null);
        // If the second install had nested inside the first, "the original"
        // would now be the first wrapper rather than the real io.read.
        expect(lua.execute_script('return type(io.read)')).toBe('function');
      });

      it('is re-installed across reset()', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_read_handler(() => 'after-reset');
        lua.reset();
        expect(lua.execute_script('return io.read()')).toBe('after-reset');
      });

      it('reports that it wired io.read', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        expect(lua.set_read_handler(() => 'x')).toBe(true);
        expect(lua.set_read_handler(null)).toBe(true);
      });

      // LIMITATIONS §8. Until this worked, set_read_handler under 'sandbox'
      // accepted the handler, retained it, wired nothing and returned undefined
      // — an accept-and-retain no JS caller could detect.
      describe('without the io library', () => {
        const sealed = () => new lua_native.init({}, { libraries: 'sandbox' }) as any;

        it('synthesizes a minimal io table and wires the handler', () => {
          const lua = sealed();
          expect(lua.execute_script('return tostring(io)')).toBe('nil');
          expect(lua.set_read_handler((fmt: any) => (fmt === 'n' ? '42' : 'Ada'))).toBe(true);
          expect(lua.execute_script('return io.read()')).toBe('Ada');
          expect(lua.execute_script('return io.read("n")')).toBe(42);
        });

        it('works from a bare state too', () => {
          const lua: any = new lua_native.init({}, {});
          expect(lua.set_read_handler(() => 'bare')).toBe(true);
          expect(lua.execute_script('return io.read()')).toBe('bare');
        });

        // The synthesized table is `read` and nothing else: the point of the
        // entry is that a sealed context gains input, not that it gains io.
        it('does not widen the seal', () => {
          const lua = sealed();
          lua.set_read_handler(() => 'x');
          for (const name of ['open', 'lines', 'write', 'close', 'stdout', 'stdin', 'popen']) {
            expect(lua.execute_script(`return tostring(io.${name})`)).toBe('nil');
          }
          // and nothing else the preset cleared came back with it
          expect(lua.execute_script('return tostring(dofile)')).toBe('nil');
          expect(lua.execute_script('return tostring(loadfile)')).toBe('nil');
          expect(lua.execute_script('return tostring(require)')).toBe('nil');
          expect(lua.execute_script('return tostring(os)')).toBe('nil');
        });

        it('survives reset()', () => {
          const lua = sealed();
          lua.set_read_handler(() => 'after-reset');
          lua.reset();
          expect(lua.execute_script('return io.read()')).toBe('after-reset');
        });

        // Otherwise a temporary handler would leave `io` a table forever, and a
        // script's `if io then` would take a branch that was false before.
        it('clearing takes the synthesized table back', () => {
          const lua = sealed();
          lua.set_read_handler(() => 'x');
          expect(lua.execute_script('return type(io)')).toBe('table');
          expect(lua.set_read_handler(null)).toBe(true);
          expect(lua.execute_script('return tostring(io)')).toBe('nil');
        });

        it('re-installs after a clear', () => {
          const lua = sealed();
          lua.set_read_handler(() => 'first');
          lua.set_read_handler(null);
          expect(lua.set_read_handler(() => 'second')).toBe(true);
          expect(lua.execute_script('return io.read()')).toBe('second');
        });

        it('does not stack wrappers on re-install', () => {
          const lua = sealed();
          lua.set_read_handler(() => 'a');
          lua.set_read_handler(() => 'b');
          expect(lua.execute_script('return io.read()')).toBe('b');
          lua.set_read_handler(null);
          expect(lua.execute_script('return tostring(io)')).toBe('nil');
        });

        // CR-23 F3. "Ours" is the identity of the table this class created, not
        // whether our C function is still sitting in the `read` field. The old
        // test got both of these backwards, and each direction is a separate
        // defect: one destroys a value the caller owns, the other strands a
        // table in a sealed context that can never be removed again.
        describe('removal takes back the table it created, and only that table', () => {
          it("leaves a caller's own replacement table alone", () => {
            const lua = sealed();
            lua.set_read_handler(() => 'x');
            // The script keeps our wrapper but puts it in a table it built.
            lua.execute_script('io = { read = io.read, mine = 1 }');
            expect(lua.set_read_handler(null)).toBe(true);
            expect(lua.execute_script('return type(io)')).toBe('table');
            expect(lua.execute_script('return io.mine')).toBe(1);
          });

          it('still removes our table after a script overwrites io.read', () => {
            const lua = sealed();
            lua.set_read_handler(() => 'x');
            lua.execute_script('io.read = function() return "mine" end');
            expect(lua.set_read_handler(null)).toBe(true);
            expect(lua.execute_script('return tostring(io)')).toBe('nil');
          });

          // The consequence of getting the previous case wrong: the tracking was
          // cleared for a removal that never happened, so the table outlived
          // every later attempt to take it back.
          it('does not strand a table across install / overwrite / remove cycles', () => {
            const lua = sealed();
            for (let i = 0; i < 3; i++) {
              expect(lua.set_read_handler(() => 'h')).toBe(true);
              lua.execute_script('io.read = function() return "mine" end');
              expect(lua.set_read_handler(null)).toBe(true);
              expect(lua.execute_script('return tostring(io)')).toBe('nil');
            }
          });
        });
      });

      // A real io library keeps the old semantics exactly: the wrapper stays
      // installed on clear and falls through to the original io.read.
      it('clearing leaves a real io library intact', () => {
        const { lua } = mk(['x']);
        lua.set_read_handler(null);
        expect(lua.execute_script('return type(io)')).toBe('table');
        expect(lua.execute_script('return type(io.read)')).toBe('function');
        expect(lua.execute_script('return type(io.open)')).toBe('function');
      });

      it('refuses a non-table global io rather than overwriting it', () => {
        const lua: any = new lua_native.init({}, { libraries: 'sandbox' });
        lua.execute_script('io = 42');
        expect(lua.set_read_handler(() => 'x')).toBe(false);
        expect(lua.execute_script('return io')).toBe(42);
      });

      // The refusal must not retain the JS function: a handler that can never
      // fire is the defect this whole group is about.
      it('does not retain a handler it refused to wire', () => {
        const lua: any = new lua_native.init({}, { libraries: 'sandbox' });
        expect(lua.set_read_handler(() => 'live')).toBe(true);
        lua.execute_script('io = 42');
        expect(lua.set_read_handler(() => 'refused')).toBe(false);
        // reset() replays retained handlers; nothing should be replayed here.
        lua.reset();
        expect(lua.execute_script('return tostring(io)')).toBe('nil');
      });

      // CR-23 F2. The format token is metadata the binding mints, so it must not
      // be affected by an option about what Lua *strings* become — the declared
      // signature says `string | number` and every documented example compares
      // it with ===. The file reader's path argument was always minted directly;
      // these two channels now agree.
      describe('the format token and the return value under binaryStrings', () => {
        const bin = () => new lua_native.init({}, { libraries: 'all', binaryStrings: true }) as any;

        it('passes the format as a string, not as bytes', () => {
          const lua = bin();
          const seen: any[] = [];
          lua.set_read_handler((fmt: any) => { seen.push(fmt); return 'x'; });
          lua.execute_script('io.read("n")');
          lua.execute_script('io.read("a")');
          lua.execute_script('io.read()');
          expect(seen).toEqual(['n', 'a', 'l']);
          expect(seen.every((s) => typeof s === 'string')).toBe(true);
        });

        it('passes a byte-count format as a number', () => {
          const lua = bin();
          let seen: any;
          lua.set_read_handler((fmt: any) => { seen = fmt; return 'xxxxx'; });
          lua.execute_script('io.read(5)');
          expect(seen).toBe(5);
        });

        it('accepts a Uint8Array return as exact bytes', () => {
          const lua = bin();
          lua.set_read_handler(() => new Uint8Array([0xff, 0x41, 0x00]));
          expect(lua.execute_script('local s = io.read() return {string.byte(s, 1, -1)}'))
            .toEqual([255, 65, 0]);
        });

        it('accepts bytes in the default mode too — the inbound path always did', () => {
          const lua: any = new lua_native.init({}, ALL_LIBS);
          lua.set_read_handler(() => new Uint8Array([0xfe, 0x42]));
          expect(lua.execute_script('local s = io.read() return {string.byte(s, 1, -1)}'))
            .toEqual([254, 66]);
        });

        it('leaves a string return and the default mode unchanged', () => {
          const lua: any = new lua_native.init({}, ALL_LIBS);
          const seen: any[] = [];
          lua.set_read_handler((fmt: any) => { seen.push(fmt); return fmt === 'n' ? '42' : 'text'; });
          expect(lua.execute_script('return io.read()')).toBe('text');
          expect(lua.execute_script('return io.read("n")')).toBe(42);
          expect(seen).toEqual(['l', 'n']);
        });
      });
    });

    describe('P4b: set_file_reader', () => {
      const mk = (files: Record<string, string>, opts: any = { libraries: 'sandbox' }) => {
        const lua: any = new lua_native.init({}, opts);
        lua.set_file_reader((p: string) =>
          Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
        return lua;
      };

      it('brings dofile/loadfile back under the sandbox preset', () => {
        const bare: any = new lua_native.init({}, { libraries: 'sandbox' });
        expect(bare.execute_script('return tostring(dofile)')).toBe('nil');
        const lua = mk({ '/a.lua': 'return 2' });
        expect(lua.execute_script('return dofile("/a.lua")')).toBe(2);
      });

      it('loadfile returns a callable chunk', () => {
        const lua = mk({ '/a.lua': 'return 1 + 1' });
        expect(lua.execute_script('return loadfile("/a.lua")()')).toBe(2);
      });

      it('dofile passes every return value through', () => {
        const lua = mk({ '/m.lua': 'return 1, 2, 3' });
        expect(lua.execute_script('return {dofile("/m.lua")}')).toEqual([1, 2, 3]);
      });

      it('a missing file is nil+message from loadfile and a raise from dofile', () => {
        const lua = mk({});
        expect(lua.execute_script(
          'local f, e = loadfile("/nope") return tostring(f) .. "|" .. tostring(e)'))
          .toMatch(/^nil\|cannot open \/nope/);
        expect(lua.execute_script('local ok, e = pcall(dofile, "/nope") return tostring(e)'))
          .toMatch(/cannot open \/nope/);
      });

      it('never touches the real filesystem', () => {
        // The rule that makes the behaviour non-data-dependent: with a reader
        // installed, the reader is the only source.
        const real = path.join(__dirname, '..', 'fixtures');
        const lua = mk({});
        expect(lua.execute_script(
          `local ok, e = pcall(dofile, ${JSON.stringify(path.join(real, 'simple.lua'))}) return tostring(e)`))
          .toMatch(/cannot open/);
      });

      it('an empty string is a valid empty file, not a missing one', () => {
        const lua = mk({ '/empty.lua': '' });
        // An empty chunk is valid and returns nothing — distinct from the
        // raise a missing file produces.
        expect(lua.execute_script('return select("#", dofile("/empty.lua"))')).toBe(0);
      });

      it('rejects bytecode, so a reader cannot route around allowBytecode', () => {
        const compiler: any = new lua_native.init({}, ALL_LIBS);
        const bc = compiler.compile('return 7').toString('latin1');
        const lua = mk({ '/bc.lua': bc });
        expect(lua.execute_script(
          'local f, e = loadfile("/bc.lua") return tostring(f) .. "|" .. tostring(e)'))
          .toMatch(/^nil\|.*binary chunk/);
      });

      it('reports a syntax error the way loadfile does', () => {
        const lua = mk({ '/bad.lua': 'this is not lua' });
        expect(lua.execute_script(
          'local f, e = loadfile("/bad.lua") return tostring(f) .. "|" .. tostring(e)'))
          .toMatch(/^nil\|\/bad\.lua:1:/);
      });

      it('requires a filename — there is no virtual stdin', () => {
        const lua = mk({});
        expect(lua.execute_script('local ok, e = pcall(dofile) return tostring(e)'))
          .toMatch(/a filename is required/);
      });

      it('a throwing reader surfaces', () => {
        const lua: any = new lua_native.init({}, { libraries: 'sandbox' });
        lua.set_file_reader(() => { throw new Error('reader boom'); });
        expect(lua.execute_script('local ok, e = pcall(dofile, "/x") return tostring(e)'))
          .toMatch(/reader boom/);
      });

      it('is re-installed across reset()', () => {
        const lua = mk({ '/a.lua': 'return 2' });
        lua.reset();
        expect(lua.execute_script('return dofile("/a.lua")')).toBe(2);
      });

      it('clearing removes the overrides', () => {
        const lua = mk({ '/a.lua': 'return 2' });
        lua.set_file_reader(null);
        expect(lua.execute_script('return tostring(dofile) .. "/" .. tostring(loadfile)'))
          .toBe('nil/nil');
      });

      it('leaves require() alone — that is add_searcher\'s job', () => {
        const lua: any = new lua_native.init({}, ALL_LIBS);
        lua.set_file_reader(() => 'return 1');
        lua.add_searcher((name: string) => (name === 'virt' ? 'return "from searcher"' : null));
        // Parenthesised: require returns the module plus its loader data in
        // Lua 5.4+, and only the first is the point here.
        expect(lua.execute_script('return (require("virt"))')).toBe('from searcher');
      });
    });
  });

});
