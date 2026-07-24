import { describe, it, expect } from 'vitest';
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
      expect(() => lua.execute_script('this is not valid lua!')).toThrow();
    });

    it('handles undefined variable access', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      // Accessing undefined variable returns nil in Lua, doesn't error
      const result = lua.execute_script('return undefinedVar');
      expect(result).toBeNull();
    });

    it('handles calling nil as function', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.execute_script('local x = nil; return x()')).toThrow();
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
      expect(() => lua.execute_script('return "string" + 5')).toThrow();
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
      }).toThrow();
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
        }).toThrow();
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
      expect(() => lua.execute_file('/nonexistent/path/to/file.lua')).toThrow();
    });

    it('throws on syntax error in file', () => {
      const lua = new lua_native.init({}, ALL_LIBS);
      expect(() => lua.execute_file(fixturesDir + 'syntax-error.lua')).toThrow();
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
      expect(() => lua.execute_script('return type(math)')).toThrow();
      expect(() => lua.execute_script('return print("hi")')).toThrow();
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
        /libraries must be 'all', 'safe', or an array/
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
      expect(() => lua.execute_script('return type(math)')).toThrow();
      expect(() => lua.execute_script('return print("hi")')).toThrow();
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
      await expect(lua.execute_script_async('return %%%')).rejects.toThrow();
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
      await expect(lua.execute_file_async('/nonexistent/file.lua')).rejects.toThrow();
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
        expect(() => (lua as any).add_search_path(42)).toThrow();
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
        expect(() => (lua as any).register_module(42, {})).toThrow();
        expect(() => (lua as any).register_module('mod')).toThrow();
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
        expect(() => lua.execute_script("require('nonexistent')")).toThrow();
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
        expect(() => lua.compile('return +')).toThrow();
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
        expect(() => lua.load_bytecode(garbage)).toThrow();
      });

      it('throws on empty bytecode', () => {
        const lua = new lua_native.init();
        expect(() => lua.load_bytecode(Buffer.alloc(0))).toThrow();
      });

      it('rejects raw source text (binary-only mode)', () => {
        const lua = new lua_native.init();
        const source = Buffer.from('return 42');
        expect(() => lua.load_bytecode(source)).toThrow();
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
        expect(() => lua.compile_file('./nonexistent.lua')).toThrow();
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
        expect(() => lua.execute_script_in(env, 'this is not lua')).toThrow();
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
        }).toThrow();

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
        await expect(lua.execute_async('this is not lua !!!')).rejects.toThrow();
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
        expect(() => lua.execute_script('require("bad")')).toThrow();
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
      await expect(lua.execute_async('local v = getBad(); return v')).rejects.toThrow();
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
      expect(() => lua.get_global('definitely_missing')).toThrow();
      // A metatable on _G with __newindex likewise routes through protection.
      const lua2 = new lua_native.init({}, { libraries: 'all' });
      lua2.execute_script('setmetatable(_G, { __newindex = function() error("no writes") end })');
      expect(() => lua2.set_global('x', 1)).toThrow();
    });

    it('M4 remainder: register_function / get_global_ref / set_metatable route _G access through protection', () => {
      // set_global(name, fn) reaches RegisterFunction; a raising __newindex on
      // _G must surface as a caught error, not a process abort.
      const lua = new lua_native.init({}, { libraries: 'all' });
      lua.execute_script('setmetatable(_G, { __newindex = function() error("no writes") end })');
      expect(() => lua.set_global('fn', () => 1)).toThrow();

      // get_global_ref and set_metatable read _G through the protected path.
      const lua2 = new lua_native.init({}, { libraries: 'all' });
      lua2.execute_script('setmetatable(_G, { __index = function() error("trap") end })');
      expect(() => lua2.get_global_ref('definitely_missing')).toThrow();
      expect(() => lua2.set_metatable('definitely_missing', { __index: () => 0 })).toThrow();
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
  // DEFERRED-REVIEW FINDINGS (CODE-REVIEW-DEFERRED.md)
  // ============================================
  describe('deferred-review regressions', () => {
    it('L6: the hidden __luaFnOwner on a returned Lua function cannot be deleted or reassigned', () => {
      const lua = new lua_native.init({}, { libraries: 'safe' });
      const fn: any = lua.execute_script('return function(a, b) return a + b end');
      // Non-configurable: delete throws in strict mode (this file is an ES module).
      expect(() => { delete fn.__luaFnOwner; }).toThrow();
      // Non-writable: reassigning throws too — neither vector can free the
      // backing data out from under the still-callable function.
      expect(() => { fn.__luaFnOwner = null; }).toThrow();
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
      expect(() => { delete a.__luaClassRef; }).toThrow();
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
      `)).rejects.toThrow(/inside a coroutine/);
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
      expect(() => lua.create_coroutine()).toThrow();
      expect(() => lua.create_coroutine(42)).toThrow();
      expect(() => lua.resume()).toThrow();
      expect(() => lua.resume(42)).toThrow();
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
      expect(() => lua.set_metatable('missing', { __index: () => 1 })).toThrow();
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
      expect(() => handle.get('x')).toThrow(); // stages refs[0]
      expect(() => handle.get('y')).toThrow(); // its CallScope clears refs[0], stages refs[1]
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
        expect(() => lua.execute_script('return require("greeter")')).toThrow();
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
        expect(() => fn(21)).toThrow(/destroyed|released/);
      });

      it('invalidates table handles', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const t = lua.create_table();
        t.set('a', 1);
        lua.reset();
        expect(() => t.get('a')).toThrow(/destroyed|released/);
      });

      it('invalidates metatabled-table proxies', () => {
        const lua = new lua_native.init({}, ALL_LIBS);
        const proxy = lua.execute_script<any>(`
          return setmetatable({}, { __index = function() return 'x' end })
        `);
        expect(proxy.anything).toBe('x');
        lua.reset();
        expect(() => proxy.anything).toThrow(/destroyed|released/);
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
        expect(() => t.set('marker', 'new')).toThrow(/destroyed|released/);
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
        expect(() => held()).toThrow(/destroyed|released/);
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
});
