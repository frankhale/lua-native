# lua-native

A native Node.js module for embedding Lua in your applications. This module provides seamless integration between JavaScript and Lua, allowing you to execute Lua scripts, pass functions between environments, and handle complex data structures.

## Features

- Execute Lua scripts from Node.js
- Pass JavaScript functions to Lua as callbacks
- Bidirectional data exchange (numbers, strings, booleans, objects, arrays)
- Global variable management
- Comprehensive error handling
- Cross-platform support (Windows, macOS, Linux)
- TypeScript support with full type definitions

## Installation

```bash
npm install lua-native
```

## Building from Source

If you need to build the module from source:

```bash
# Debug build
npm run build-debug

# Release build  
npm run build-release
```

## Usage

### Basic Script Execution

```javascript
import lua_native from 'lua-native';

// Create a new Lua context
const lua = new lua_native.init({});

// Execute a simple script
const result = lua.execute_script('return 42');
console.log(result); // 42
```

### Passing JavaScript Functions to Lua

```javascript
import lua_native from 'lua-native';

// Create context with JavaScript function
const lua = new lua_native.init({ 
  add: (a, b) => a + b 
});

// Call the JavaScript function from Lua
const result = lua.execute_script('return add(2, 3)');
console.log(result); // 5
```

### Working with Global Variables

```javascript
import lua_native from 'lua-native';

const lua = new lua_native.init({});

// Set global variables
lua.set_global('x', 7);
lua.set_global('times2', (n) => n * 2);

// Use globals in Lua script
const [a, b] = lua.execute_script('return x, times2(x)');
console.log(a, b); // 7, 14
```

### Complex Data Structures

The module supports converting complex Lua tables to JavaScript objects:

```javascript
import lua_native from 'lua-native';

const lua = new lua_native.init({ 
  greet: (name) => `Hello, ${name}!` 
});

const result = lua.execute_script(`
  local t = {
    numbers = {1, 2, 3},
    flags = { on = true, off = false },
    msg = greet('World')
  }
  return t
`);

console.log(result);
// {
//   numbers: [1, 2, 3],
//   flags: { on: true, off: false },
//   msg: 'Hello, World!'
// }
```

### Error Handling

Lua errors are automatically converted to JavaScript exceptions:

```javascript
import lua_native from 'lua-native';

const lua = new lua_native.init({});

try {
  lua.execute_script("error('Something went wrong')");
} catch (error) {
  console.error('Lua error:', error.message);
}
```

## TypeScript Support

The module includes comprehensive TypeScript definitions:

```typescript
import lua_native from 'lua-native';
import type { LuaCallbacks, LuaContext } from 'lua-native/types';

// Type-safe callback definition
const callbacks: LuaCallbacks = {
  add: (a: number, b: number): number => a + b,
  greet: (name: string): string => `Hello, ${name}!`
};

const lua: LuaContext = new lua_native.init(callbacks);
const result: number = lua.execute_script('return add(10, 20)');
```

## API Reference

### `lua_native.init(callbacks?)`

Creates a new Lua execution context.

**Parameters:**
- `callbacks` (optional): Object containing JavaScript functions and values to make available in Lua

**Returns:** `LuaContext` instance

### `LuaContext.execute_script(script)`

Executes a Lua script and returns the result.

**Parameters:**
- `script`: String containing Lua code to execute

**Returns:** The result of the script execution (converted to appropriate JavaScript type)

### `LuaContext.set_global(name, value)`

Sets a global variable or function in the Lua environment.

**Parameters:**
- `name`: Name of the global variable
- `value`: Value to set (function, number, string, boolean, or object)

## Data Type Conversion

| Lua Type | JavaScript Type | Notes |
|----------|-----------------|-------|
| `nil` | `null` | |
| `boolean` | `boolean` | |
| `number` | `number` | |
| `string` | `string` | |
| `table` (array-like) | `Array` | Sequential numeric indices starting from 1 |
| `table` (object-like) | `Object` | String or mixed keys |
| `function` | `Function` | JavaScript functions passed to Lua |

## Development

### Running Tests

```bash
npm test
```

### Project Structure

- `src/` - C++ source code
  - `lua-native.cpp` - Main module implementation
  - `core/lua-runtime.cpp` - Lua runtime wrapper
- `tests/` - Test files
  - `ts/lua-native.spec.ts` - TypeScript/JavaScript tests
  - `cpp/lua-native-test.cpp` - C++ unit tests
- `types.d.ts` - TypeScript type definitions

## License

MIT

## Author

Frank Hale

## Repository

https://github.com/frankhale/lua-native.git

## Date

17-Aug-2025