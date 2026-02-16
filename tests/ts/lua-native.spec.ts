import { describe, it, expect } from 'vitest';
import lua_native from '../../index.js';

describe('lua-native Node adapter', () => {
  // ============================================
  // BASIC FUNCTIONALITY
  // ============================================
  describe('basic functionality', () => {
    it('creates a Lua context and returns a number', () => {
      const lua = new lua_native.init({});
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
      });
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
      });
      lua.execute_script('setVar(1999)');
      expect(b).toBe(1999);
    });

    it('sets globals and uses them in Lua', () => {
      const lua = new lua_native.init({});
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
      });
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
        const lua = new lua_native.init({});
        const result = lua.execute_script('return ""');
        expect(result).toBe('');
      });

      it('handles very long strings', () => {
        const lua = new lua_native.init({});
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
        const lua = new lua_native.init({});
        const unicode = '你好世界 🌍 émojis';
        lua.set_global('unicode', unicode);
        const result = lua.execute_script('return unicode');
        expect(result).toBe(unicode);
      });

      it('handles strings with special characters', () => {
        const lua = new lua_native.init({});
        const special = 'line1\nline2\ttab\\backslash"quote';
        lua.set_global('special', special);
        const result = lua.execute_script('return special');
        expect(result).toBe(special);
      });

      it('handles null bytes in strings', () => {
        const lua = new lua_native.init({});
        const result = lua.execute_script('return "hello\\0world"');
        expect(result).toBe('hello\0world');
      });
    });

    describe('numbers', () => {
      it('handles zero', () => {
        const lua = new lua_native.init({});
        expect(lua.execute_script('return 0')).toBe(0);
      });

      it('handles negative numbers', () => {
        const lua = new lua_native.init({});
        expect(lua.execute_script('return -42')).toBe(-42);
        expect(lua.execute_script('return -3.14')).toBeCloseTo(-3.14);
      });

      it('handles large integers', () => {
        const lua = new lua_native.init({});
        const big = lua.execute_script('return 9007199254740991');  // MAX_SAFE_INTEGER
        expect(big).toBe(9007199254740991);
      });

      it('handles floating point numbers', () => {
        const lua = new lua_native.init({});
        expect(lua.execute_script('return 3.14159265359')).toBeCloseTo(3.14159265359);
        expect(lua.execute_script('return 0.1 + 0.2')).toBeCloseTo(0.3);
      });

      it('handles very small numbers', () => {
        const lua = new lua_native.init({});
        const tiny = lua.execute_script('return 0.0000000001');
        expect(tiny).toBeCloseTo(0.0000000001);
      });

      it('handles infinity', () => {
        const lua = new lua_native.init({});
        const inf = lua.execute_script('return math.huge');
        expect(inf).toBe(Infinity);
      });

      it('handles negative infinity', () => {
        const lua = new lua_native.init({});
        const negInf = lua.execute_script('return -math.huge');
        expect(negInf).toBe(-Infinity);
      });
    });

    describe('booleans', () => {
      it('handles true', () => {
        const lua = new lua_native.init({});
        expect(lua.execute_script('return true')).toBe(true);
      });

      it('handles false', () => {
        const lua = new lua_native.init({});
        expect(lua.execute_script('return false')).toBe(false);
      });

      it('handles boolean from comparison', () => {
        const lua = new lua_native.init({});
        expect(lua.execute_script('return 1 > 0')).toBe(true);
        expect(lua.execute_script('return 1 < 0')).toBe(false);
      });
    });

    describe('nil/null', () => {
      it('handles nil return', () => {
        const lua = new lua_native.init({});
        const result = lua.execute_script('return nil');
        expect(result).toBeNull();
      });

      it('handles nil in callback argument', () => {
        const lua = new lua_native.init({
          checkNil: (...args) => args[0] === null
        });
        const result = lua.execute_script('return checkNil(nil)');
        expect(result).toBe(true);
      });

      it('passes null from JS to Lua as nil', () => {
        const lua = new lua_native.init({});
        lua.set_global('nullVal', null);
        const result = lua.execute_script('return nullVal == nil');
        expect(result).toBe(true);
      });
    });

    describe('arrays', () => {
      it('handles empty array', () => {
        const lua = new lua_native.init({});
        lua.set_global('arr', []);
        const result = lua.execute_script('return #arr');
        expect(result).toBe(0);
      });

      it('handles array with single element', () => {
        const lua = new lua_native.init({});
        const result = lua.execute_script('return {42}');
        expect(result).toEqual([42]);
      });

      it('handles large arrays', () => {
        const lua = new lua_native.init({});
        const arr = Array.from({ length: 1000 }, (_, i) => i);
        lua.set_global('arr', arr);
        const result = lua.execute_script('return arr');
        expect(result).toEqual(arr);
      });

      it('handles nested arrays', () => {
        const lua = new lua_native.init({});
        const result = lua.execute_script('return {{1, 2}, {3, 4}, {5, 6}}');
        expect(result).toEqual([[1, 2], [3, 4], [5, 6]]);
      });

      it('handles mixed type arrays', () => {
        const lua = new lua_native.init({});
        // Note: Lua tables don't preserve trailing nil - {1, "two", true, nil} only has 3 elements
        const result = lua.execute_script('return {1, "two", true, nil}');
        expect(result).toEqual([1, "two", true]);
      });
    });

    describe('tables/objects', () => {
      it('handles empty table', () => {
        const lua = new lua_native.init({});
        lua.set_global('obj', {});
        const result = lua.execute_script('return obj');
        // Empty Lua tables can't distinguish array vs object, defaults to array
        expect(result).toEqual([]);
      });

      it('handles deeply nested structures', () => {
        const lua = new lua_native.init({});
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
        const lua = new lua_native.init({});
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
        const lua = new lua_native.init({});
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
        const lua = new lua_native.init({});
        const result = lua.execute_script('return {["1"] = "a", ["2"] = "b"}');
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('Expected result to be a table object');
        }
        expect(result["1"]).toBe("a");
        expect(result["2"]).toBe("b");
      });

      it('handles table with special key names', () => {
        const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
      expect(() => lua.execute_script("error('boom')")).toThrowError(/boom/);
    });

    it('handles Lua syntax errors', () => {
      const lua = new lua_native.init({});
      expect(() => lua.execute_script('this is not valid lua!')).toThrow();
    });

    it('handles undefined variable access', () => {
      const lua = new lua_native.init({});
      // Accessing undefined variable returns nil in Lua, doesn't error
      const result = lua.execute_script('return undefinedVar');
      expect(result).toBeNull();
    });

    it('handles calling nil as function', () => {
      const lua = new lua_native.init({});
      expect(() => lua.execute_script('local x = nil; return x()')).toThrow();
    });

    it('propagates JS callback errors with function name', () => {
      const lua = new lua_native.init({
        failingFunc: () => { throw new Error('JS error message'); }
      });
      expect(() => lua.execute_script('failingFunc()')).toThrowError(/failingFunc/);
      expect(() => lua.execute_script('failingFunc()')).toThrowError(/JS error message/);
    });

    it('handles type errors in Lua operations', () => {
      const lua = new lua_native.init({});
      expect(() => lua.execute_script('return "string" + 5')).toThrow();
    });

    it('handles errors in returned Lua functions', () => {
      const lua = new lua_native.init({});
      const errorFunc = lua.execute_script('return function() error("func error") end');
      if (typeof errorFunc !== 'function') {
        throw new Error('Expected errorFunc to be a function');
      }
      expect(() => errorFunc()).toThrowError(/func error/);
    });

    it('handles pcall for protected calls', () => {
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      });
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
      const getFortyTwo = lua.execute_script('return function() return 42 end');
      if (typeof getFortyTwo !== 'function') {
        throw new Error('Expected getFortyTwo to be a function');
      }
      expect(getFortyTwo()).toBe(42);
    });

    it('handles function with many arguments', () => {
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      });
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
      const lua = new lua_native.init({});
      const double = lua.execute_script('return function(x) return x * 2 end');
      for (let i = 0; i < 100; i++) {
        if (typeof double !== 'function') {
          throw new Error('Expected double to be a function');
        }
        expect(double(i)).toBe(i * 2);
      }
    });

    it('multiple functions can coexist', () => {
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
      lua.set_global('x', 10);
      expect(lua.execute_script('return x')).toBe(10);
      lua.set_global('x', 20);
      expect(lua.execute_script('return x')).toBe(20);
    });

    it('can set null as global value', () => {
      const lua = new lua_native.init({});
      lua.set_global('x', 10);
      lua.set_global('x', null);
      const result = lua.execute_script('return x == nil');
      expect(result).toBe(true);
    });

    it('handles setting function as global', () => {
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
      lua.execute_script('globalVar = 100');
      const result = lua.execute_script('return globalVar');
      expect(result).toBe(100);
    });

    it('handles many globals', () => {
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
      expect(lua.execute_script('return string.upper("hello")')).toBe('HELLO');
      expect(lua.execute_script('return string.len("hello")')).toBe(5);
      expect(lua.execute_script('return string.sub("hello", 2, 4)')).toBe('ell');
    });

    it('table library is available', () => {
      const lua = new lua_native.init({});
      const result = lua.execute_script(`
        local t = {3, 1, 4, 1, 5}
        table.sort(t)
        return t
      `);
      expect(result).toEqual([1, 1, 3, 4, 5]);
    });

    it('math library is available', () => {
      const lua = new lua_native.init({});
      expect(lua.execute_script('return math.abs(-5)')).toBe(5);
      expect(lua.execute_script('return math.floor(3.7)')).toBe(3);
      expect(lua.execute_script('return math.ceil(3.2)')).toBe(4);
      expect(lua.execute_script('return math.max(1, 5, 3)')).toBe(5);
      expect(lua.execute_script('return math.min(1, 5, 3)')).toBe(1);
    });

    it('os.time is available', () => {
      const lua = new lua_native.init({});
      const luaTime = lua.execute_script('return os.time()');
      const jsTime = Math.floor(Date.now() / 1000);
      if (typeof luaTime !== 'number') {
        throw new Error('Expected luaTime to be a number');
      }
      expect(Math.abs(luaTime - jsTime)).toBeLessThan(2);
    });

    it('pairs iteration works', () => {
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({ index: i, value: i * 2 }));
      lua.set_global('data', largeArray);
      expect(lua.execute_script('return #data')).toBe(1000);
      expect(lua.execute_script('return data[500].index')).toBe(499);  // Lua 1-indexed
    });

    it('handles recursive function calls', () => {
      const lua = new lua_native.init({});
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
      });
      const result = lua.execute_script('return noReturn()');
      expect(result).toBeNull();
    });

    it('callback receives correct number of arguments', () => {
      let receivedArgs: unknown[] = [];
      const lua = new lua_native.init({
        capture: (...args: unknown[]) => { receivedArgs = args; }
      });
      lua.execute_script('capture(1, 2, 3)');
      expect(receivedArgs).toEqual([1, 2, 3]);
    });

    it('callback receives correct types', () => {
      let receivedTypes: string[] = [];
      const lua = new lua_native.init({
        captureTypes: (...args: unknown[]) => {
          receivedTypes = args.map(a => a === null ? 'null' : typeof a);
        }
      });
      lua.execute_script('captureTypes(1, "str", true, nil, {})');
      expect(receivedTypes).toEqual(['number', 'string', 'boolean', 'null', 'object']);
    });

    it('callback can modify external state multiple times', () => {
      let counter = 0;
      const lua = new lua_native.init({
        increment: () => { counter++; }
      });
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
      });
      const lua2 = new lua_native.init({
        setValue: (...args) => {
          if (typeof args[0] === 'number') {
            value2 = args[0];
          } else {
            throw new Error('setValue expects a number');
          }
        }
      });

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
      const lua = new lua_native.init({});
      const coro = lua.create_coroutine(`
        return function()
          return 42
        end
      `);
      expect(coro).toBeDefined();
      expect(coro.status).toBe('suspended');
    });

    it('resumes a coroutine and gets return value', () => {
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      });
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
      expect(() => {
        lua.create_coroutine('invalid lua syntax @@@@');
      }).toThrow();
    });

    it('throws error for non-function return', () => {
      const lua = new lua_native.init({});
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
      const lua = new lua_native.init({});
      lua.set_global('x', 42);
      expect(lua.get_global('x')).toBe(42);
    });

    it('gets a string global', () => {
      const lua = new lua_native.init({});
      lua.set_global('name', 'hello');
      expect(lua.get_global('name')).toBe('hello');
    });

    it('gets a boolean global', () => {
      const lua = new lua_native.init({});
      lua.set_global('flag', true);
      expect(lua.get_global('flag')).toBe(true);
    });

    it('gets a table global', () => {
      const lua = new lua_native.init({});
      lua.set_global('config', { a: 1, b: 'two' });
      const result = lua.get_global('config');
      expect(result).toEqual({ a: 1, b: 'two' });
    });

    it('gets a global set from Lua script', () => {
      const lua = new lua_native.init({});
      lua.execute_script('myVar = 999');
      expect(lua.get_global('myVar')).toBe(999);
    });

    it('returns null for non-existent global', () => {
      const lua = new lua_native.init({});
      expect(lua.get_global('doesNotExist')).toBeNull();
    });

    it('reflects updated global value', () => {
      const lua = new lua_native.init({});
      lua.set_global('x', 10);
      expect(lua.get_global('x')).toBe(10);
      lua.set_global('x', 20);
      expect(lua.get_global('x')).toBe(20);
    });

    it('gets a global modified by Lua script', () => {
      const lua = new lua_native.init({});
      lua.set_global('counter', 0);
      lua.execute_script('counter = counter + 1');
      expect(lua.get_global('counter')).toBe(1);
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
      });
      lua.set_userdata('handle', original);
      lua.execute_script('capture(handle)');
      expect(received).toBe(original); // Same reference, not a copy
    });

    it('userdata preserves object identity', () => {
      const obj = { id: 42 };
      let received: any = null;
      const lua = new lua_native.init({
        check: (...args: any[]) => { received = args[0]; }
      });
      lua.set_userdata('obj', obj);
      lua.execute_script('check(obj)');
      expect(received === obj).toBe(true);
    });

    it('userdata can be passed between Lua variables', () => {
      const original = { value: 'hello' };
      let received: any = null;
      const lua = new lua_native.init({
        capture: (...args: any[]) => { received = args[0]; }
      });
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
      const lua = new lua_native.init({});
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
      });
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
      });
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
      });
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
      const lua = new lua_native.init({});
      lua.set_userdata('handle', obj);
      // Set to nil and force GC
      lua.execute_script('handle = nil; collectgarbage()');
      // The global is now nil
      const result = lua.execute_script('return handle == nil');
      expect(result).toBe(true);
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
      });
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
      });
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
        const lua = new lua_native.init({});
        lua.set_userdata('point', obj, { readable: true });
        expect(lua.execute_script('return point.x')).toBe(10);
        expect(lua.execute_script('return point.y')).toBe(20);
        expect(lua.execute_script('return point.name')).toBe('point');
      });

      it('non-existent property returns nil', () => {
        const obj = { x: 10 };
        const lua = new lua_native.init({});
        lua.set_userdata('obj', obj, { readable: true });
        const result = lua.execute_script('return obj.nonexistent == nil');
        expect(result).toBe(true);
      });

      it('reads boolean properties correctly', () => {
        const obj = { active: true, deleted: false };
        const lua = new lua_native.init({});
        lua.set_userdata('obj', obj, { readable: true });
        expect(lua.execute_script('return obj.active')).toBe(true);
        expect(lua.execute_script('return obj.deleted')).toBe(false);
      });

      it('reads nested object properties as tables', () => {
        const obj = { nested: { a: 1, b: 2 } };
        const lua = new lua_native.init({});
        lua.set_userdata('obj', obj, { readable: true });
        // nested is returned as a Lua table (one level deep)
        const result = lua.execute_script('return obj.nested');
        expect(result).toEqual({ a: 1, b: 2 });
      });

      it('reads array properties', () => {
        const obj = { items: [10, 20, 30] };
        const lua = new lua_native.init({});
        lua.set_userdata('obj', obj, { readable: true });
        const result = lua.execute_script('return obj.items');
        expect(result).toEqual([10, 20, 30]);
      });

      it('reads null properties as nil', () => {
        const obj = { value: null };
        const lua = new lua_native.init({});
        lua.set_userdata('obj', obj, { readable: true });
        const result = lua.execute_script('return obj.value == nil');
        expect(result).toBe(true);
      });
    });

    describe('writable', () => {
      it('writes properties from Lua', () => {
        const obj: any = { x: 10, y: 20 };
        const lua = new lua_native.init({});
        lua.set_userdata('point', obj, { readable: true, writable: true });
        lua.execute_script('point.x = 100; point.y = 200');
        expect(obj.x).toBe(100);
        expect(obj.y).toBe(200);
      });

      it('creates new properties from Lua', () => {
        const obj: any = {};
        const lua = new lua_native.init({});
        lua.set_userdata('obj', obj, { readable: true, writable: true });
        lua.execute_script('obj.newProp = 42');
        expect(obj.newProp).toBe(42);
      });

      it('writes different types', () => {
        const obj: any = {};
        const lua = new lua_native.init({});
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
        const lua = new lua_native.init({});
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
        const lua = new lua_native.init({});
        lua.set_userdata('obj', obj, { readable: true, writable: false });
        expect(() => {
          lua.execute_script('obj.x = 20');
        }).toThrow(/not writable/);
        expect(obj.x).toBe(10); // Unchanged
      });

      it('write-only: reads throw a Lua error', () => {
        const obj: any = { x: 10 };
        const lua = new lua_native.init({});
        lua.set_userdata('obj', obj, { readable: false, writable: true });
        expect(() => {
          lua.execute_script('return obj.x');
        }).toThrow(/not readable/);
      });

      it('write-only: writes succeed', () => {
        const obj: any = { x: 10 };
        const lua = new lua_native.init({});
        lua.set_userdata('obj', obj, { readable: false, writable: true });
        lua.execute_script('obj.x = 99');
        expect(obj.x).toBe(99);
      });

      it('opaque userdata (no options) cannot be indexed', () => {
        const obj = { x: 10 };
        const lua = new lua_native.init({});
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
        });
        lua.set_userdata('player', player, { readable: true });
        lua.execute_script('getName(player)');
        expect(receivedName).toBe('Alice');
      });

      it('mutations through userdata are visible in JS', () => {
        const state: any = { score: 0 };
        const lua = new lua_native.init({});
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
        const lua = new lua_native.init({});
        lua.set_userdata('o1', obj1, { readable: true, writable: true });
        lua.set_userdata('o2', obj2, { readable: true, writable: true });
        lua.execute_script('o1.value = "x"; o2.value = "y"');
        expect(obj1.value).toBe('x');
        expect(obj2.value).toBe('y');
      });
    });
  });
});
