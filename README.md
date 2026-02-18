# lua-native

A native Node.js module for embedding Lua in your applications. This module
provides seamless integration between JavaScript and Lua, allowing you to
execute Lua scripts, pass functions between environments, and handle complex
data structures.

## Supported Runtimes

- Node.js
- Bun
- Deno

## Features

- Execute Lua scripts and files from Node.js
- Pass JavaScript functions to Lua as callbacks
- Bidirectional data exchange (numbers, strings, booleans, objects, arrays)
- Global variable management (get and set)
- Userdata support — pass JavaScript objects to Lua by reference with optional property access
- Metatable support — attach metatables to Lua tables from JavaScript for operator overloading, custom indexing, and more
- Reference-based tables — metatabled tables returned from Lua are wrapped in JS Proxy objects, preserving metamethods across the boundary
- Module / require integration — register JS modules and add search paths for Lua's `require()`
- Opt-in standard library loading with `'all'`, `'safe'`, and per-library presets
- Async execution via `execute_script_async` / `execute_file_async` — runs Lua on worker threads, returns Promises
- Coroutine support with yield/resume semantics
- Comprehensive error handling
- Cross-platform support (Windows, macOS)
- TypeScript support with full type definitions

## Installation

```bash
npm install lua-native
```

NOTE: Prebuilt binaries are currently available for macOS (Apple Silicon/arm64).
Intel Mac and Windows users will need to build from source. Linux has not been
tested.

NOTE: The prebuilt binaries include Lua 5.5 (pre-release). If you need a
different Lua version, you will need to build from source.

## Building from Source

### Prerequisites

- **Node.js** (v18 or later recommended)
- **Python** (required by node-gyp)
- **VCPKG** with Lua installed (`vcpkg install lua`) - [vcpkg.io](https://vcpkg.io/en/index.html)
- **Windows**: Visual Studio 2022 or Build Tools with C++ workload
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)

NOTE: There are two ways to build this module. You can use traditional
`bindings.gyp` along with `node-gyp` or you can use `cmake` on
Windows and macOS. Linux has not been tested.

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
  print: (msg) => {
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

### File Execution

Execute Lua files directly instead of passing script strings:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({
  greet: (name) => `Hello, ${name}!`,
});

// Execute a Lua file
const result = lua.execute_file("./scripts/init.lua");
console.log(result);
```

Return values, globals, and callbacks all work exactly as with `execute_script`:

```javascript
// scripts/math.lua:
//   return 6 * 7

const answer = lua.execute_file("./scripts/math.lua");
console.log(answer); // 42

// scripts/setup.lua:
//   config = { debug = true, level = 3 }

lua.execute_file("./scripts/setup.lua");
console.log(lua.get_global("config")); // { debug: true, level: 3 }
```

Errors (file not found, syntax errors, runtime errors) throw JavaScript exceptions:

```javascript
try {
  lua.execute_file("./nonexistent.lua");
} catch (error) {
  console.error(error.message); // "cannot open ./nonexistent.lua: No such file or directory"
}
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

// Read globals back from Lua
lua.execute_script("y = x * 3");
console.log(lua.get_global("y")); // 21
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

const lua = new lua_native.init({}, { libraries: "all" });

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
}, { libraries: "all" });

try {
  lua.execute_script("riskyOperation()");
} catch (error) {
  console.error(error.message);
  // Output: Host function 'riskyOperation' threw an exception: Database connection failed
}
```

### Standard Library Loading (Opt-In)

By default, `new lua_native.init()` creates a **bare Lua state** with no
standard libraries loaded. You opt in to the libraries you need via the
`libraries` option.

#### Load all libraries

The `'all'` preset loads all 10 standard libraries — equivalent to the previous
default behavior:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

lua.execute_script('print(string.upper("hello"))'); // "HELLO"
lua.execute_script("print(math.floor(3.7))"); // 3
lua.execute_script("print(os.clock())"); // works
```

#### Safe preset (sandboxing)

The `'safe'` preset loads everything except `io`, `os`, and `debug` — ideal for
running untrusted scripts:

```javascript
const sandbox = new lua_native.init({}, { libraries: "safe" });

sandbox.execute_script('print(string.upper("hello"))'); // "HELLO"
sandbox.execute_script("print(math.floor(3.7))"); // 3
sandbox.execute_script("print(type(io))"); // "nil" — io is not loaded
sandbox.execute_script("print(type(os))"); // "nil" — os is not loaded
sandbox.execute_script("print(type(debug))"); // "nil" — debug is not loaded
```

#### Selective loading (array)

You can also pass an explicit array of library names:

```javascript
// Only load base, string, and math
const lua = new lua_native.init({}, {
  libraries: ["base", "string", "math"],
});

lua.execute_script('print(string.upper("hello"))'); // "HELLO"
lua.execute_script("print(math.floor(3.7))"); // 3
lua.execute_script("print(type(io))"); // "nil" — io is not loaded
```

#### Bare state (default)

Omitting `libraries` or passing an empty array creates a bare Lua state with no
standard libraries at all:

```javascript
const bare = new lua_native.init({});

// Basic Lua still works (arithmetic, strings, return)
bare.execute_script("return 1 + 2"); // 3

// But no standard functions are available
// bare.execute_script('print("hi")') -- ERROR: 'print' is nil
```

Available library names: `base`, `package`, `coroutine`, `table`, `io`, `os`,
`string`, `math`, `utf8`, `debug`.

Available presets: `'all'` (all 10 libraries), `'safe'` (all except `io`, `os`,
`debug`).

### Module / Require Integration

Register JavaScript objects as Lua modules available via `require()`, or add
filesystem search paths for Lua module loading. Requires the `package` library.

#### Registering JS Modules

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

// Register a JS object as a Lua module
lua.register_module("utils", {
  clamp: (x, min, max) => Math.min(Math.max(x, min), max),
  lerp: (a, b, t) => a + (b - a) * t,
  version: "1.0.0",
});

// Use it from Lua with require()
const result = lua.execute_script(`
  local utils = require('utils')
  return utils.clamp(15, 0, 10), utils.version
`);
console.log(result); // [10, '1.0.0']
```

Modules are pre-loaded into `package.loaded` — no filesystem search occurs.
Functions in the module become callable from Lua, and plain values (strings,
numbers, booleans) are set directly.

#### Adding Search Paths

```javascript
// Add filesystem search paths for Lua's require()
lua.add_search_path("./lua_modules/?.lua");
lua.add_search_path("./libs/?/init.lua");

// Lua can now require modules from those directories
lua.execute_script(`
  local mymod = require('mymod')  -- searches ./lua_modules/mymod.lua
  print(mymod.name)
`);
```

The path must contain a `?` placeholder that gets replaced by the module name.

#### Combined Usage

```javascript
// Mix filesystem modules with JS-registered modules
lua.add_search_path("./scripts/?.lua");

lua.register_module("config", {
  debug: true,
  maxRetries: 3,
});

lua.execute_script(`
  local config = require('config')   -- from JS
  local helpers = require('helpers')  -- from ./scripts/helpers.lua
  if config.debug then
    print(helpers.format_debug())
  end
`);
```

### Async Execution

By default, all Lua execution blocks the Node.js event loop. The async methods
run Lua on a worker thread and return Promises, keeping the event loop free for
other work.

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

// Non-blocking execution
const result = await lua.execute_script_async("return 6 * 7");
console.log(result); // 42

// File execution
const fileResult = await lua.execute_file_async("./scripts/heavy.lua");
```

Run multiple independent contexts concurrently with `Promise.all()`:

```javascript
const contexts = [1, 2, 3, 4].map(() => new lua_native.init({}, { libraries: "all" }));

const results = await Promise.all(
  contexts.map((lua, i) => lua.execute_script_async(`return ${i + 1} * 10`))
);
console.log(results); // [10, 20, 30, 40]
```

Error handling works with standard try/catch:

```javascript
try {
  await lua.execute_script_async("error('something failed')");
} catch (error) {
  console.error(error.message); // includes "something failed"
}
```

**Important:** JS callbacks registered on the context are not available during
async execution. Calling a registered JS function from async Lua code will
reject the promise with a clear error:

```javascript
const lua = new lua_native.init({
  greet: () => "hello",
}, { libraries: "all" });

// This will reject — JS callbacks can't run on the worker thread
await lua.execute_script_async("return greet()"); // Error: "JS callbacks are not available in async mode"

// Workaround: set up data before async, compute in Lua
lua.set_global("name", "World");
const result = await lua.execute_script_async("return 'Hello, ' .. name .. '!'");
```

### Coroutines

Lua coroutines are supported, allowing you to create pausable/resumable functions:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

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

### Userdata

JavaScript objects can be passed into Lua as userdata — Lua holds a reference to
the original object, not a copy. When the userdata flows back to JavaScript
(through callbacks or return values), the original object is returned.

#### Opaque Handles

By default, userdata is opaque — Lua can pass it around but cannot read or
modify its properties:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

const connection = { host: "localhost", port: 5432, connected: true };
lua.set_userdata("db", connection);

// Lua can pass the handle to JavaScript callbacks
lua.set_global("useConnection", (conn) => {
  console.log(conn === connection); // true — same object
  console.log(conn.host); // 'localhost'
});

lua.execute_script("useConnection(db)");
```

#### Property Access

You can grant Lua read and/or write access to the object's properties:

```javascript
const player = { name: "Alice", health: 100, score: 0 };

// Read-only access
lua.set_userdata("player", player, { readable: true });

lua.execute_script(`
  print(player.name)    -- "Alice"
  print(player.health)  -- 100
`);

// Read-write access
lua.set_userdata(
  "state",
  { lives: 3, level: 1 },
  { readable: true, writable: true },
);

lua.execute_script(`
  state.level = state.level + 1
  state.lives = state.lives - 1
`);

console.log(lua.get_global("state")); // Changes are visible in JS
```

#### Lua-Created Userdata Passthrough

Userdata created by Lua libraries (e.g., `io.open()` file handles) can pass
through JavaScript callbacks and back to Lua without losing their identity:

```javascript
const lua = new lua_native.init({
  processFile: (fileHandle) => {
    // fileHandle is opaque to JS, but can be returned to Lua
    return fileHandle;
  },
}, { libraries: "all" });

lua.execute_script(`
  local f = io.tmpfile()
  local f2 = processFile(f)
  f2:write("hello")
  f2:seek("set")
  print(f2:read("*a"))  -- "hello"
  f2:close()
`);
```

### Metatables

You can attach Lua metatables to global tables from JavaScript, enabling operator
overloading, custom `tostring`, callable tables, custom indexing, and more.

#### Basic Usage — `__tostring` and `__add`

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

// Create two vector tables in Lua
lua.execute_script("v1 = {x = 1, y = 2}; v2 = {x = 10, y = 20}");

// Attach a metatable with __tostring and __add
lua.set_metatable("v1", {
  __tostring: (t) => `(${t.x}, ${t.y})`,
  __add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
});

lua.execute_script("print(tostring(v1))"); // (1, 2)
const sum = lua.execute_script("return v1 + v2");
console.log(sum); // { x: 11, y: 22 }
```

#### Callable Tables — `__call`

```javascript
const lua = new lua_native.init({});

lua.execute_script("multiplier = {factor = 10}");

lua.set_metatable("multiplier", {
  __call: (self, x) => self.factor * x,
});

const result = lua.execute_script("return multiplier(5)");
console.log(result); // 50
```

#### Custom Indexing — `__index`

`__index` can be a function (for computed lookups) or a table (for fallback values):

```javascript
const lua = new lua_native.init({});

// __index as a function — compute missing keys dynamically
lua.execute_script("obj = {}");
lua.set_metatable("obj", {
  __index: (table, key) => `default_${key}`,
});

console.log(lua.execute_script("return obj.color")); // 'default_color'

// __index as a table — static fallback values
lua.execute_script("config = {}");
lua.set_metatable("config", {
  __index: { timeout: 30, retries: 3 },
});

console.log(lua.execute_script("return config.timeout")); // 30
```

#### Intercepting Writes — `__newindex`

```javascript
const lua = new lua_native.init({});

const log = [];
lua.execute_script("protected = {x = 1}");
lua.set_metatable("protected", {
  __newindex: (table, key, value) => {
    log.push(`blocked write: ${key} = ${value}`);
    // Not calling rawset, so the write is silently dropped
  },
});

lua.execute_script("protected.y = 42");
console.log(log); // ['blocked write: y = 42']
console.log(lua.execute_script("return protected.y")); // null (write was intercepted)
```

#### All Supported Metamethods

| Metamethod   | Lua Trigger         | Description                         |
| ------------ | ------------------- | ----------------------------------- |
| `__tostring` | `tostring(t)`       | Custom string representation        |
| `__add`      | `a + b`             | Addition                            |
| `__sub`      | `a - b`             | Subtraction                         |
| `__mul`      | `a * b`             | Multiplication                      |
| `__div`      | `a / b`             | Division                            |
| `__mod`      | `a % b`             | Modulo                              |
| `__unm`      | `-a`                | Unary minus                         |
| `__concat`   | `a .. b`            | String concatenation                |
| `__len`      | `#a`                | Length operator                     |
| `__eq`       | `a == b`            | Equality (both need metatable)      |
| `__lt`       | `a < b`             | Less than (both need metatable)     |
| `__le`       | `a <= b`            | Less or equal (both need metatable) |
| `__call`     | `t(args)`           | Calling table as function           |
| `__index`    | `t.key` (missing)   | Custom read (function or table)     |
| `__newindex` | `t.key = val` (new) | Custom write interception           |

### Reference-Based Tables

When a Lua table has a metatable, it is returned to JavaScript as a Proxy object
instead of being deep-copied. This preserves all metamethods — `__index`,
`__newindex`, `__tostring`, `__add`, `__call`, etc. — so they fire naturally when
you access the object from JavaScript. Plain tables (no metatable) are still
deep-copied as before.

#### Live Property Access via `__index`

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

const obj = lua.execute_script(`
  local t = {}
  setmetatable(t, {
    __index = function(_, key) return key:upper() end
  })
  return t
`);

console.log(obj.hello); // "HELLO" — __index fires through the Proxy
console.log(obj.world); // "WORLD"
```

#### Direct Property Read/Write

```javascript
const vec = lua.execute_script(`
  local v = {x = 10, y = 20}
  setmetatable(v, {})
  return v
`);

console.log(vec.x); // 10
vec.x = 99; // sets via Lua (triggers __newindex if defined)
console.log(vec.x); // 99
```

#### Object.keys() and `in` Operator

```javascript
console.log(Object.keys(vec)); // ['x', 'y']
console.log("x" in vec); // true
console.log("z" in vec); // false
```

#### Round-Trip Through JavaScript

Proxy objects passed back to Lua restore the original metatabled table, so
metamethods continue to work:

```javascript
lua.set_global("inspect", (tbl) => {
  console.log(tbl.x); // access via Proxy
  return tbl; // return to Lua — original table restored
});

lua.execute_script(`
  local t = {x = 42}
  setmetatable(t, {
    __tostring = function(self) return "x=" .. self.x end
  })
  local t2 = inspect(t)
  print(tostring(t2))  -- "x=42" — metamethods preserved after round-trip
`);
```

#### Arithmetic and Other Metamethods

All metamethods work when the Proxy is passed back to Lua:

```javascript
lua.execute_script(`
  v1 = {x = 1, y = 2}
  v2 = {x = 10, y = 20}
`);

lua.set_metatable("v1", {
  __add: (a, b) => {
    // Return a new metatabled table
    return lua.execute_script(
      `local r = {x = ${a.x + b.x}, y = ${a.y + b.y}}; setmetatable(r, getmetatable(v1)); return r`,
    );
  },
  __tostring: (t) => `(${t.x}, ${t.y})`,
});

// v1 + v2 triggers __add, tostring() triggers __tostring
lua.execute_script("print(tostring(v1 + v2))"); // (11, 22)
```

#### Plain Tables Are Unaffected

Tables without metatables continue to deep-copy as before — no behavior change:

```javascript
const plain = lua.execute_script("return {a = 1, b = 2}");
// plain is a regular JS object: { a: 1, b: 2 }
```

## TypeScript Support

The module includes comprehensive TypeScript definitions:

```typescript
import lua_native from "lua-native";
import type {
  LuaCallbacks,
  LuaContext,
  LuaCoroutine,
  LuaInitOptions,
  LuaLibraryPreset,
  CoroutineResult,
  LuaFunction,
  LuaTableRef,
  MetatableDefinition,
  UserdataOptions,
} from "lua-native";

// Type-safe callback definition
const callbacks: LuaCallbacks = {
  add: (a: number, b: number): number => a + b,
  greet: (name: string): string => `Hello, ${name}!`,
};

const lua: LuaContext = new lua_native.init(callbacks, { libraries: "all" });
const result: number = lua.execute_script("return add(10, 20)");

// Type-safe global access
lua.set_global("x", 42);
const x = lua.get_global("x"); // LuaValue

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
const fn = lua.execute_script<LuaFunction>(
  "return function(a, b) return a + b end",
);
console.log(fn(5, 3)); // 8

// Type-safe userdata
const opts: UserdataOptions = { readable: true, writable: true };
lua.set_userdata("player", { name: "Alice", score: 0 }, opts);

// Type-safe metatable
lua.execute_script("vec = {x = 1, y = 2}");
const mt: MetatableDefinition = {
  __tostring: (t) => `(${t.x}, ${t.y})`,
  __unm: (t) => ({ x: -t.x, y: -t.y }),
};
lua.set_metatable("vec", mt);

// Type-safe reference-based tables
const proxy = lua.execute_script<LuaTableRef>(`
  local t = {x = 1}
  setmetatable(t, { __index = function(_, k) return k end })
  return t
`);
console.log(proxy.x); // 1
console.log(proxy.hello); // "hello" — __index fires

// Type-safe module registration
lua.register_module("math_utils", {
  clamp: (x: number, min: number, max: number): number =>
    Math.min(Math.max(x, min), max),
  PI: Math.PI,
});
lua.add_search_path("./lua_modules/?.lua");
const mod = lua.execute_script("return require('math_utils').clamp(15, 0, 10)");

// Type-safe library loading with presets
const preset: LuaLibraryPreset = "safe";
const sandboxed: LuaContext = new lua_native.init({}, { libraries: preset });
sandboxed.execute_script('print(string.upper("safe"))'); // "SAFE"

// Or with an explicit array
const options: LuaInitOptions = { libraries: ["base", "string", "math"] };
const custom: LuaContext = new lua_native.init({}, options);
custom.execute_script('print(string.upper("custom"))'); // "CUSTOM"
```

## API Reference

### `lua_native.init(callbacks?, options?)`

Creates a new Lua execution context.

**Parameters:**

- `callbacks` (optional): Object containing JavaScript functions and values to
  make available in Lua
- `options` (optional): Configuration object
  - `libraries` (optional): Which standard libraries to load. If omitted, **no
    libraries are loaded** (bare state). Accepts:
    - `'all'` — loads all 10 standard libraries
    - `'safe'` — loads all except `io`, `os`, and `debug`
    - `LuaLibrary[]` — array of specific library names
    - `[]` — bare state (no libraries)

    Valid library names: `'base'`, `'package'`, `'coroutine'`, `'table'`, `'io'`,
    `'os'`, `'string'`, `'math'`, `'utf8'`, `'debug'`

**Returns:** `LuaContext` instance

**Throws:** Error if an unknown library name is provided

### `LuaContext.execute_script(script)`

Executes a Lua script and returns the result.

**Parameters:**

- `script`: String containing Lua code to execute

**Returns:** The result of the script execution (converted to the appropriate
JavaScript type). Tables with metatables are returned as Proxy objects that
preserve metamethods; plain tables are deep-copied into objects or arrays.

### `LuaContext.execute_file(filepath)`

Executes a Lua file and returns the result.

**Parameters:**

- `filepath`: Path to the Lua file to execute

**Returns:** The result of the file execution (converted to the appropriate
JavaScript type), identical to `execute_script`. Returns `undefined` if the file
has no return statement.

**Throws:** Error if the file is not found, contains syntax errors, or encounters
a runtime error.

### `LuaContext.execute_script_async(script)`

Executes a Lua script asynchronously on a worker thread.

**Parameters:**

- `script`: String containing Lua code to execute

**Returns:** `Promise` that resolves with the script result or rejects on error.
JS callbacks are not available during async execution.

**Throws:** Error if the context is busy with another async operation.

### `LuaContext.execute_file_async(filepath)`

Executes a Lua file asynchronously on a worker thread.

**Parameters:**

- `filepath`: Path to the Lua file to execute

**Returns:** `Promise` that resolves with the file result or rejects on error.
JS callbacks are not available during async execution.

**Throws:** Error if the context is busy with another async operation.

### `LuaContext.is_busy()`

Returns whether the context is currently busy with an async operation.

**Returns:** `boolean` — `true` while an async operation is in progress, `false`
otherwise.

### `LuaContext.add_search_path(path)`

Appends a search path to Lua's `package.path` for module resolution.

**Parameters:**

- `path`: Search path template containing a `?` placeholder (e.g., `'./modules/?.lua'`)

**Throws:** Error if the `package` library is not loaded, or if the path does not
contain a `?` placeholder.

### `LuaContext.register_module(name, module)`

Registers a JavaScript object as a Lua module, making it available via
`require(name)`. The module is pre-loaded into `package.loaded` — no filesystem
search occurs.

**Parameters:**

- `name`: The module name used in `require(name)`
- `module`: An object whose properties become the module's fields. Functions
  become callable from Lua; other values are set directly.

**Throws:** Error if the `package` library is not loaded.

### `LuaContext.set_global(name, value)`

Sets a global variable or function in the Lua environment.

**Parameters:**

- `name`: Name of the global variable
- `value`: Value to set (function, number, string, boolean, or object)

### `LuaContext.get_global(name)`

Gets a global variable from the Lua environment.

**Parameters:**

- `name`: Name of the global variable

**Returns:** The value of the global (converted to JavaScript), or `null` if not set

### `LuaContext.set_userdata(name, value, options?)`

Sets a JavaScript object as userdata in the Lua environment. The object is
passed by reference — Lua holds a handle to the original object, not a copy.

**Parameters:**

- `name`: The global variable name in Lua
- `value`: The JavaScript object to store as userdata
- `options` (optional): Access control for property access from Lua
  - `readable`: Allow Lua to read properties via `__index` (default: `false`)
  - `writable`: Allow Lua to write properties via `__newindex` (default: `false`)

### `LuaContext.set_metatable(name, metatable)`

Sets a metatable on an existing global Lua table, enabling operator overloading,
custom indexing, `__tostring`, `__call`, and other metamethods.

**Parameters:**

- `name`: The name of an existing global table
- `metatable`: Object whose keys are metamethod names (e.g. `__add`, `__tostring`)
  and values are either callback functions or static Lua values

**Throws:** Error if the global does not exist or is not a table

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

| Lua Type              | JavaScript Type | Notes                                                                                                         |
| --------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `nil`                 | `null`          |                                                                                                               |
| `boolean`             | `boolean`       |                                                                                                               |
| `number`              | `number`        |                                                                                                               |
| `string`              | `string`        |                                                                                                               |
| `table` (array-like)  | `Array`         | Sequential numeric indices starting from 1 (no metatable)                                                     |
| `table` (object-like) | `Object`        | String or mixed keys (no metatable)                                                                           |
| `table` (metatabled)  | `Proxy`         | Wrapped as JS Proxy — metamethods preserved                                                                   |
| `function`            | `Function`      | Bidirectional: JS→Lua and Lua→JS                                                                              |
| `thread`              | `LuaCoroutine`  | Created via `create_coroutine()`                                                                              |
| `userdata`            | `Object`        | JS-created via `set_userdata()`, returned by reference. Lua-created userdata passes through as opaque handles |

## Limitations

- **Nesting depth limit** — Nested data structures (tables, arrays, objects) are limited to 100 levels deep. Exceeding this limit throws an error.
- **`set_metatable()` only for globals** — `set_metatable()` works on global tables only. To set metatables on non-global tables, use `setmetatable()` in Lua code.
- **Plain tables are copied, not referenced** — When Lua tables _without metatables_ are returned to JavaScript, they are converted to plain objects/arrays (deep copy). Changes to the JavaScript object do not affect the Lua table. Tables _with metatables_ are returned as live Proxy objects that maintain a reference to the original Lua table.

## Development

### Running Tests

```bash
# JavaScript/TypeScript integration tests (vitest)
npm test

# C++ unit tests (Google Test)
npm run test-cpp
```

### Project Structure

- `src/` - C++ source code
  - `lua-native.cpp` - N-API binding layer
  - `lua-native.h` - N-API binding header
  - `core/lua-runtime.cpp` - Lua runtime wrapper
  - `core/lua-runtime.h` - Lua runtime header
- `tests/` - Test files
  - `ts/lua-native.spec.ts` - TypeScript/JavaScript integration tests
  - `cpp/lua-native-test.cpp` - C++ unit tests
- `index.js` - Module loader (finds and loads the native binary)
- `index.d.ts` - TypeScript entry point (re-exports from `types.d.ts`)
- `types.d.ts` - TypeScript type definitions

## Repository

https://github.com/frankhale/lua-native.git

## License

MIT

## Author

Frank Hale &lt;frankhale@gmail.com&gt;

## Date

18 February 2026
