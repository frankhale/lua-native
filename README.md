# lua-native

A native Node.js module for embedding Lua in your applications. This module
provides seamless integration between JavaScript and Lua, allowing you to
execute Lua scripts, pass functions between environments, and handle complex
data structures.

## Supported Runtimes

- Node.js
- Bun
- Deno

All runtimes use the same API. Bun and Deno support native Node.js modules, so
the usage is identical across all three runtimes.

## Features

- Execute Lua scripts from Node.js
- Pass JavaScript functions to Lua as callbacks
- Bidirectional data exchange (numbers, strings, booleans, objects, arrays)
- Global variable management
- Coroutine support with yield/resume semantics
- Comprehensive error handling
- Cross-platform support (Windows, macOS, Linux)
- TypeScript support with full type definitions

## Installation

```bash
npm install lua-native
```

NOTE: Prebuilt binaries are available for Windows (x64) and macOS (Apple Silicon/arm64).
Linux prebuilt binaries are coming soon. Intel Mac users will need to build from source.

## Building from Source

### Prerequisites

- **Node.js** (v18 or later recommended)
- **Python** (required by node-gyp)
- **VCPKG** with Lua installed (`vcpkg install lua`) - [vcpkg.io](https://vcpkg.io/en/index.html)
- **Windows**: Visual Studio 2022 or Build Tools with C++ workload
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)

NOTE: There are two ways to build this module. You can use traditional
`bindings.gyp` along with `node-gyp` or you can use `cmake` on
Windows and macOS. I have not configured the build for Linux yet.

```bash
# Debug build
npm run build-debug

# Release build
npm run build-release
```

## Usage

### Basic Script Execution

Hello World:

```javascript
import lua_native from "lua-native";

// Create a new Lua context
const lua = new lua_native.init({
  print: (msg: string) => {
    console.log(msg);
  },
});

// Execute a simple script
lua.execute_script('print("Hello, World!")');
```

Return a value:

```javascript
import lua_native from "lua-native";

// Create a new Lua context
const lua = new lua_native.init({});

// Execute a simple script
const result = lua.execute_script("return 42");
console.log(result); // 42
```

### Passing JavaScript Functions to Lua

```javascript
import lua_native from "lua-native";

// Create context with JavaScript function
const lua = new lua_native.init({
  add: (a, b) => a + b,
});

// Call the JavaScript function from Lua
const result = lua.execute_script("return add(2, 3)");
console.log(result); // 5
```

### Working with Global Variables

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({});

// Set global variables
lua.set_global("x", 7);
lua.set_global("times2", (n) => n * 2);

// Use globals in Lua script
const [a, b] = lua.execute_script("return x, times2(x)");
console.log(a, b); // 7, 14
```

### Complex Data Structures

The module supports converting complex Lua tables to JavaScript objects:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({
  greet: (name) => `Hello, ${name}!`,
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

### Returning Lua Functions

Lua functions can be returned to JavaScript and called directly:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({});

// Return a Lua function
const add = lua.execute_script(`
  return function(a, b)
    return a + b
  end
`);

console.log(add(5, 3)); // 8

// Closures work too
const makeCounter = lua.execute_script(`
  return function(start)
    local count = start or 0
    return function()
      count = count + 1
      return count
    end
  end
`);

const counter = makeCounter(10);
console.log(counter()); // 11
console.log(counter()); // 12
```

### Error Handling

Lua errors are automatically converted to JavaScript exceptions:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({});

try {
  lua.execute_script("error('Something went wrong')");
} catch (error) {
  console.error("Lua error:", error.message);
  // Output: Lua error: [string "error('Something went wrong')"]:1: Something went wrong
}
```

Errors from JavaScript callbacks include the function name and original error message:

```javascript
const lua = new lua_native.init({
  riskyOperation: () => {
    throw new Error("Database connection failed");
  },
});

try {
  lua.execute_script("riskyOperation()");
} catch (error) {
  console.error(error.message);
  // Output: Host function 'riskyOperation' threw an exception: Database connection failed
}
```

### Coroutines

Lua coroutines are supported, allowing you to create pausable/resumable functions:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({});

// Create a coroutine from a function
const coro = lua.create_coroutine(`
  return function(x)
    coroutine.yield(x * 2)
    coroutine.yield(x * 3)
    return x * 4
  end
`);

// Resume with initial argument
let result = lua.resume(coro, 10);
console.log(result.status); // 'suspended'
console.log(result.values); // [20]

// Continue resuming
result = lua.resume(coro);
console.log(result.values); // [30]

result = lua.resume(coro);
console.log(result.status); // 'dead'
console.log(result.values); // [40]
```

Coroutines can receive values on each resume:

```javascript
const coro = lua.create_coroutine(`
  return function()
    local a = coroutine.yield("first")
    local b = coroutine.yield("second")
    return a + b
  end
`);

let result = lua.resume(coro);
console.log(result.values); // ['first']

result = lua.resume(coro, 10);
console.log(result.values); // ['second']

result = lua.resume(coro, 20);
console.log(result.values); // [30]
```

Generator pattern with coroutines:

```javascript
const squares = lua.create_coroutine(`
  return function(n)
    for i = 1, n do
      coroutine.yield(i * i)
    end
  end
`);

// Generate squares from 1 to 5
let result = lua.resume(squares, 5);
const values = [result.values[0]];
while (result.status === "suspended") {
  result = lua.resume(squares);
  values.push(result.values[0]);
}
console.log(values); // [1, 4, 9, 16, 25]
```

## TypeScript Support

The module includes comprehensive TypeScript definitions:

```typescript
import lua_native from "lua-native";
import type {
  LuaCallbacks,
  LuaContext,
  LuaCoroutine,
  CoroutineResult,
  LuaFunction,
} from "lua-native";

// Type-safe callback definition
const callbacks: LuaCallbacks = {
  add: (a: number, b: number): number => a + b,
  greet: (name: string): string => `Hello, ${name}!`,
};

const lua: LuaContext = new lua_native.init(callbacks);
const result: number = lua.execute_script("return add(10, 20)");

// Type-safe coroutine usage
const coro: LuaCoroutine = lua.create_coroutine(`
  return function(x)
    coroutine.yield(x * 2)
    return x * 3
  end
`);

const res: CoroutineResult = lua.resume(coro, 10);
console.log(res.status); // 'suspended' | 'dead'
console.log(res.values); // LuaValue[]

// Type-safe Lua function return
const fn = lua.execute_script<LuaFunction>("return function(a, b) return a + b end");
console.log(fn(5, 3)); // 8
```

## API Reference

### `lua_native.init(callbacks?)`

Creates a new Lua execution context.

**Parameters:**

- `callbacks` (optional): Object containing JavaScript functions and values to
  make available in Lua

**Returns:** `LuaContext` instance

### `LuaContext.execute_script(script)`

Executes a Lua script and returns the result.

**Parameters:**

- `script`: String containing Lua code to execute

**Returns:** The result of the script execution (converted to the appropriate
JavaScript type)

### `LuaContext.set_global(name, value)`

Sets a global variable or function in the Lua environment.

**Parameters:**

- `name`: Name of the global variable
- `value`: Value to set (function, number, string, boolean, or object)

### `LuaContext.create_coroutine(script)`

Creates a coroutine from a Lua script that returns a function.

**Parameters:**

- `script`: String containing Lua code that returns a function to be used as the
  coroutine body

**Returns:** `LuaCoroutine` object with `status` property (`'suspended'`,
`'running'`, or `'dead'`)

### `LuaContext.resume(coroutine, ...args)`

Resumes a suspended coroutine with optional arguments.

**Parameters:**

- `coroutine`: The `LuaCoroutine` object to resume
- `...args`: Arguments to pass to the coroutine (received by `yield` on resume,
  or as function arguments on first resume)

**Returns:** `CoroutineResult` object containing:

- `status`: `'suspended'` | `'running'` | `'dead'`
- `values`: Array of values yielded or returned by the coroutine
- `error`: Error message if the coroutine failed (optional)

## Data Type Conversion

| Lua Type              | JavaScript Type  | Notes                                      |
| --------------------- | ---------------- | ------------------------------------------ |
| `nil`                 | `null`           |                                            |
| `boolean`             | `boolean`        |                                            |
| `number`              | `number`         |                                            |
| `string`              | `string`         |                                            |
| `table` (array-like)  | `Array`          | Sequential numeric indices starting from 1 |
| `table` (object-like) | `Object`         | String or mixed keys                       |
| `function`            | `Function`       | Bidirectional: JS→Lua and Lua→JS           |
| `thread`              | `LuaCoroutine`   | Created via `create_coroutine()`           |

## Limitations

- **No metatable support** - Lua metatables are not accessible or configurable from JavaScript.
- **No userdata support** - Lua userdata types are not supported.

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

## Repository

https://github.com/frankhale/lua-native.git

## License

MIT

## Author

Frank Hale

## Date

18 January 2026
