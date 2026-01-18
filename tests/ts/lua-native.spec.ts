import { describe, it, expect } from 'vitest';
import lua_native from '../../index.js';

describe('lua-native Node adapter', () => {
  it('creates a Lua context and returns a number', () => {
    const lua = new lua_native.init({});
    const result = lua.execute_script('return 42');
    expect(result).toBe(42);
  });

  it('calls a JS function from Lua', () => {
    const lua = new lua_native.init({ add: (a: number, b: number) => a + b });
    const result = lua.execute_script('return add(2, 3)');
    expect(result).toBe(5);
  });

  it('modify JS variable from Lua', () => {
    let b = 42;
    const lua = new lua_native.init({ setVar: (a: number) => b = a });
    lua.execute_script('setVar(1999)');
    expect(b).toBe(1999);
  });

  it('sets globals and uses them in Lua', () => {
    const lua = new lua_native.init({});
    lua.set_global('x', 7);
    lua.set_global('times2', (n: number) => n * 2);
    lua.set_global('table', { a: 1, b: 42, c: "Hello,World!" })
    const [a, b, c, d] = lua.execute_script('return x, times2(x), table.b, table.c');
    expect(a).toBe(7);
    expect(b).toBe(14);
    expect(c).toBe(42);
    expect(d).toBe("Hello,World!");
  });

  it('returns nested table structures to JS', () => {
    const lua = new lua_native.init({ greet: (name: string) => `Hello, ${name}!` });
    const result = lua.execute_script(`
      local t = {
        numbers = {1, 2, 3},
        flags = { on = true, off = false },
        msg = greet('World')
      }
      return t
    `);
    expect(result).toBeTypeOf('object');
    expect(result.msg).toBe('Hello, World!');
    expect(result.flags.on).toBe(true);
    expect(result.flags.off).toBe(false);
    expect(Array.isArray(result.numbers)).toBe(true);
    expect(result.numbers).toEqual([1, 2, 3]);
  });

  it('propagates Lua errors as JS exceptions', () => {
    const lua = new lua_native.init({});
    expect(() => lua.execute_script("error('boom')")).toThrowError(/boom/);
  });

  it('returns Lua functions that can be called from JS', () => {
    const lua = new lua_native.init({});
    const add = lua.execute_script('return function(a, b) return a + b end');
    expect(typeof add).toBe('function');
    expect(add(5, 3)).toBe(8);
    expect(add(10, 20)).toBe(30);
  });

  it('Lua functions can call JS callbacks', () => {
    const lua = new lua_native.init({
      jsDouble: (x: number) => x * 2
    });
    const luaFunc = lua.execute_script(`
      return function(n)
        return jsDouble(n) + 10
      end
    `);
    expect(typeof luaFunc).toBe('function');
    expect(luaFunc(5)).toBe(20);  // jsDouble(5) = 10, + 10 = 20
  });

  it('Lua functions can return multiple values', () => {
    const lua = new lua_native.init({});
    const multiReturn = lua.execute_script(`
      return function(a, b)
        return a + b, a - b, a * b
      end
    `);
    expect(typeof multiReturn).toBe('function');
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
    const counter = makeCounter(10);
    expect(typeof counter).toBe('function');
    expect(counter()).toBe(11);
    expect(counter()).toBe(12);
    expect(counter()).toBe(13);
  });
});


