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

- Execute Lua scripts and files from Node.js, Bun or Deno
- Pass JavaScript functions to Lua as callbacks
- Bidirectional data exchange (numbers, strings, booleans, objects, arrays)
- Type-system fidelity — `BigInt`, `Date`, `Map`, `Set`, `Buffer`/`TypedArray`, and `RegExp` convert to natural Lua representations, with 64-bit integer precision preserved in both directions; register app-specific converters with `register_type_converter()`
- Global variable management (get and set)
- Userdata support — pass JavaScript objects to Lua by reference with optional property access and method binding
- Class / usertype binding — register a JS class with `register_class()` so Lua can construct instances (`Obj.new(...)`), call methods, access properties, and use overloaded operators
- Metatable support — attach metatables to Lua tables from JavaScript for operator overloading, custom indexing, and more
- Reference-based tables — metatabled tables returned from Lua are wrapped in JS Proxy objects, preserving metamethods across the boundary
- Table reference API — create, read, write, and iterate Lua tables directly from JavaScript with `create_table()` and `get_global_ref()`
- Module / require integration — register JS modules, add search paths, or resolve modules dynamically with a JS searcher (`add_searcher`) for Lua's `require()`
- Output redirection — route Lua `print()` / `io.write()` to a JS handler via `set_print_handler` or the `print` option
- Bytecode guard — `allowBytecode: false` refuses untrusted binary chunks (blocks `load_bytecode` and forces `load()` to text-only)
- Opt-in standard library loading with `'all'`, `'safe'`, and per-library presets
- Bytecode precompilation — compile Lua to bytecode with `compile()`, load with `load_bytecode()` for faster startup
- Async execution via `execute_script_async` / `execute_file_async` — runs Lua on worker threads, returns Promises
- Promise-aware async via `execute_async` — runs Lua as a main-thread coroutine that transparently `await`s JS Promises returned by host functions (with working callbacks and `cancel()`)
- Memory limits — cap Lua memory usage with `maxMemory` option, monitor with `get_memory_usage()`
- Coroutine support with yield/resume semantics
- Error fidelity — Lua errors carry stack tracebacks, thrown JS `Error` objects round-trip with full fidelity (type, message, stack, custom props), and `pcall()` runs a function protected, returning `{ ok, value/error }`
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

// Create a new Lua context (no callbacks or options needed)
const lua = new lua_native.init();

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

const lua = new lua_native.init();

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

### JavaScript Type Conversion

Common JavaScript built-in types convert to their natural Lua representations
when passed into Lua (via `set_global`, callbacks, `create_table`, etc.):

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

// BigInt -> Lua integer (64-bit)
lua.set_global("big", 9007199254740993n);
lua.execute_script("return math.type(big)"); // "integer"

// Date -> epoch milliseconds
lua.set_global("when", new Date(1234));
lua.execute_script("return when"); // 1234

// Buffer / TypedArray / ArrayBuffer -> binary-safe Lua string
lua.set_global("buf", Buffer.from("hello"));
lua.execute_script("return #buf"); // 5

// Map -> table, Set -> array
lua.set_global("m", new Map([["a", 1], ["b", 2]]));
lua.execute_script("return m.a"); // 1
lua.set_global("s", new Set([10, 20, 30]));
lua.execute_script("return #s"); // 3

// RegExp -> its source pattern string
lua.set_global("re", /foo\d+/g);
lua.execute_script("return re"); // "foo\\d+"
```

Full JavaScript → Lua mapping for built-in types:

| JavaScript type                         | Lua result       | Notes                                             |
| --------------------------------------- | ---------------- | ------------------------------------------------- |
| `BigInt`                                | `integer`        | Throws if outside signed 64-bit range             |
| `Buffer` / `TypedArray` / `ArrayBuffer` | `string`         | Raw bytes, binary-safe (honors `byteOffset`)      |
| `Date`                                  | `number`         | Epoch milliseconds                                |
| `Map`                                   | `table`          | Keys stringified; values convert recursively      |
| `Set`                                   | `table` (array)  | Values convert recursively                        |
| `RegExp`                                | `string`         | The `.source` pattern (flags are dropped)         |
| `Symbol`                                | —                | Rejected with an error (no Lua representation)     |

64-bit integer precision is preserved in both directions: a Lua integer whose
magnitude exceeds `2^53 - 1` is returned to JavaScript as a `BigInt` rather than
a lossy `number`. Smaller integers remain a `number`.

```javascript
const max = lua.execute_script("return math.maxinteger");
console.log(max); // 9223372036854775807n (BigInt — exact)

const small = lua.execute_script("return 123");
console.log(small); // 123 (number)
```

#### Custom Type Converters

Register your own converters to control how application-specific types cross into
Lua with `register_type_converter(match, convert)`. Converters are consulted in
registration order; the first whose `match` returns truthy has its `convert`
result passed into Lua (converted normally, so it may return any Lua-compatible
value):

```javascript
class Money {
  constructor(cents) {
    this.cents = cents;
  }
}

lua.register_type_converter(
  (v) => v instanceof Money,
  (v) => ({ cents: v.cents, dollars: v.cents / 100 }),
);

lua.set_global("price", new Money(1299));
lua.execute_script("return price.dollars"); // 12.99
```

Converters run **after** internal round-trip markers (so reference-based tables
and userdata are never hijacked) but **before** the built-in handling above — so
you can also override how a built-in type like `Date` is converted:

```javascript
lua.register_type_converter(
  (v) => v instanceof Date,
  (v) => v.toISOString(),
);

lua.set_global("now", new Date("2026-07-10T00:00:00Z"));
lua.execute_script("return now"); // "2026-07-10T00:00:00.000Z"
```

Converters apply only to object values — plain primitives, functions, `BigInt`,
and `Symbol` bypass them.

### Returning Lua Functions

Lua functions can be returned to JavaScript and called directly:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init();

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

Lua errors are converted to JavaScript exceptions, and the message includes a
**stack traceback** (available even when the `debug` library is not loaded):

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

try {
  lua.execute_script('function foo() error("boom") end\nfoo()');
} catch (error) {
  console.error(error.message);
  // [string "..."]:1: boom
  // stack traceback:
  //   [C]: in function 'error'
  //   [string "..."]:1: in function 'foo'
  //   [string "..."]:2: in main chunk
}
```

#### JS Error fidelity

A JavaScript `Error` thrown by a host function is **preserved end-to-end**. If it
propagates uncaught back to JS, you get the *same* `Error` instance — type,
message, stack, and custom properties intact:

```javascript
class DBError extends Error {
  constructor(msg) { super(msg); this.name = "DBError"; this.code = "E_DB"; }
}

const lua = new lua_native.init(
  { query: () => { throw new DBError("connection failed"); } },
  { libraries: "all" },
);

try {
  lua.execute_script("query()");
} catch (error) {
  console.log(error instanceof DBError); // true
  console.log(error.name, error.code);   // "DBError" "E_DB"
}
```

Inside Lua, the same error is a readable table, so scripts can inspect it:

```javascript
const info = lua.execute_script(`
  local ok, err = pcall(query)
  return { message = err.message, name = err.name }
`);
// { message: "connection failed", name: "DBError" }
```

(Non-object throws — `throw "string"`, `throw 42` — surface as a plain message.)

#### Protected calls with `pcall`

Call a function in protected mode and get a result object instead of an
exception. The preserved error is returned in `error`:

```javascript
const fn = lua.execute_script(
  'return function(x) if x < 0 then error("negative") end return x * 2 end'
);

lua.pcall(fn, 5);   // { ok: true, value: 10 }
lua.pcall(fn, -1);  // { ok: false, error: Error("...negative...\nstack traceback...") }
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
const lua = new lua_native.init(
  {},
  {
    libraries: ["base", "string", "math"],
  },
);

lua.execute_script('print(string.upper("hello"))'); // "HELLO"
lua.execute_script("print(math.floor(3.7))"); // 3
lua.execute_script("print(type(io))"); // "nil" — io is not loaded
```

#### Bare state (default)

Omitting `libraries` (or omitting all arguments entirely) creates a bare Lua state
with no standard libraries at all:

```javascript
const bare = new lua_native.init();

// Basic Lua still works (arithmetic, strings, return)
bare.execute_script("return 1 + 2"); // 3

// But no standard functions are available
// bare.execute_script('print("hi")') -- ERROR: 'print' is nil
```

Available library names: `base`, `package`, `coroutine`, `table`, `io`, `os`,
`string`, `math`, `utf8`, `debug`.

Available presets: `'all'` (all 10 libraries), `'safe'` (all except `io`, `os`,
`debug`).

### Memory Limits

Cap the total memory a Lua state can allocate, preventing untrusted scripts from
crashing the host process:

```javascript
import lua_native from "lua-native";

// Limit Lua to 10 MB of memory
const lua = new lua_native.init({}, {
  libraries: "safe",
  maxMemory: 10 * 1024 * 1024,
});

// Normal scripts work fine within the limit
lua.execute_script("local t = {}; for i = 1, 1000 do t[i] = i end");

// Scripts that exceed the limit throw an out-of-memory error
try {
  lua.execute_script("local s = string.rep('x', 20 * 1024 * 1024)");
} catch (error) {
  console.error(error.message); // "not enough memory"
}

// The context remains usable after an OOM error
lua.execute_script("return 1 + 1"); // 2
```

Monitor memory usage with `get_memory_usage()`:

```javascript
const lua = new lua_native.init({}, { libraries: "all" });

console.log(lua.get_memory_usage()); // bytes currently allocated by Lua
lua.execute_script("big = string.rep('x', 100000)");
console.log(lua.get_memory_usage()); // increased after allocation
```

Memory tracking works even without `maxMemory` — every Lua context tracks its
memory usage automatically.

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

#### Dynamic Modules with a JS Searcher

`register_module` is a static preload and `add_search_path` hits the filesystem.
`add_searcher` resolves modules **lazily** through JavaScript — return the
module's Lua source (or `null` to let the next searcher try). Sources can come
from a bundle, database, or in-memory map:

```javascript
const modules = {
  greet: 'return function(name) return "Hello, " .. name end',
  mathx: 'return { square = function(x) return x * x end }',
};

lua.add_searcher((name) => modules[name] ?? null);

lua.execute_script(`
  local greet = require('greet')
  local mathx = require('mathx')
  return greet('Ada'), mathx.square(9)
`); // ['Hello, Ada', 81]
```

Modules are cached like any `require`, so the searcher runs once per module.
Searchers must be synchronous and return Lua **source** (not a value). Requires
the `package` library.

### Output Redirection

Route Lua `print()` and `io.write()` to a JavaScript handler instead of the
process stdout. The handler receives the fully-formatted text — exactly what
would have been printed (arguments joined with tabs, `__tostring` applied, and a
trailing newline for `print`):

```javascript
import lua_native from "lua-native";

const lines = [];
const lua = new lua_native.init({}, {
  libraries: "all",
  print: (text) => lines.push(text),
});

lua.execute_script('print("hello", 42)\nprint("world")');
console.log(lines); // ["hello\t42\n", "world\n"]
```

You can also set or change the handler at runtime, and pass `null` to send output
back to stdout:

```javascript
const lua = new lua_native.init({}, { libraries: "all" });
lua.set_print_handler((text) => process.stdout.write(`[lua] ${text}`));
lua.execute_script('print("captured")'); // [lua] captured
lua.set_print_handler(null);              // back to stdout
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
const contexts = [1, 2, 3, 4].map(
  () => new lua_native.init({}, { libraries: "all" }),
);

const results = await Promise.all(
  contexts.map((lua, i) => lua.execute_script_async(`return ${i + 1} * 10`)),
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
const lua = new lua_native.init(
  {
    greet: () => "hello",
  },
  { libraries: "all" },
);

// This will reject — JS callbacks can't run on the worker thread
await lua.execute_script_async("return greet()"); // Error: "JS callbacks are not available in async mode"

// Workaround: set up data before async, compute in Lua
lua.set_global("name", "World");
const result = await lua.execute_script_async(
  "return 'Hello, ' .. name .. '!'",
);
```

### Awaiting JavaScript Promises (`execute_async`)

`execute_script_async` runs on a worker thread and cannot call back into
JavaScript. `execute_async` is different: it runs Lua as a coroutine **on the
main thread**, so JS callbacks work — and when a host function returns a
**Promise**, the Lua coroutine transparently suspends until it resolves, then
continues with the resolved value. No special Lua syntax is needed.

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init(
  {
    // An async JS function — returns a Promise.
    fetchUser: async (id) => {
      const res = await fetch(`https://api.example.com/users/${id}`);
      return res.json(); // { id, name }
    },
    // A synchronous callback — also works during execute_async.
    upper: (s) => s.toUpperCase(),
  },
  { libraries: "all" },
);

const name = await lua.execute_async(`
  local user = fetchUser(42)     -- suspends here until the Promise resolves
  return upper(user.name)        -- sync callbacks work too
`);
console.log(name); // e.g. "ADA"
```

Awaits compose naturally — sequential calls, loops, and multiple values all work:

```javascript
const total = await lua.execute_async(`
  local sum = 0
  for i = 1, 3 do
    sum = sum + getAmount(i)   -- each getAmount(i) awaits a Promise
  end
  return sum
`);
```

Promise-returning methods on userdata and class instances are awaited too:

```javascript
lua.register_class("Client", {
  construct: () => ({}),
  methods: { get: async (self, id) => (await db.get(id)) },
});
const row = await lua.execute_async('return Client.new():get(7)');
```

**Rejections** surface as Lua errors, so scripts can `pcall` them; an uncaught
rejection rejects the returned Promise:

```javascript
lua.set_global("risky", () => Promise.reject(new Error("nope")));

// Caught inside Lua:
const [ok, err] = await lua.execute_async(`
  local ok, err = pcall(function() return risky() end)
  return ok, err
`); // [false, "...nope"]

// Uncaught -> the returned Promise rejects:
await lua.execute_async("return risky()").catch((e) => console.log(e.message)); // "nope"
```

**Cancellation** — `cancel()` aborts an in-flight run (its Promise rejects). It
takes effect while the script is suspended awaiting a Promise:

```javascript
const p = lua.execute_async("local x = slowCall(); return x");
setTimeout(() => lua.cancel(), 100);
await p.catch((e) => console.log(e.message)); // "execution cancelled"
```

Notes:

- Only one async run per context at a time — `is_busy()` is `true` meanwhile, and
  concurrent calls throw. Use separate contexts for true concurrency.
- Calling a Promise-returning host function from **synchronous** `execute_script`
  throws — such functions must be awaited via `execute_async`.
- Only native `Promise` results suspend; other values are converted as usual.

### Bytecode Precompilation

Compile Lua source to bytecode and load it later for faster startup. Bytecode
skips the parsing and compilation phases on subsequent loads.

```javascript
import lua_native from "lua-native";
import fs from "fs";

const lua = new lua_native.init({}, { libraries: "all" });

// Compile source to bytecode (returns a Buffer)
const bytecode = lua.compile("return function(x) return x * 2 end");

// Save to disk for later
fs.writeFileSync("my-script.luac", bytecode);

// Load and execute bytecode (identical result to execute_script)
const fn = lua.load_bytecode(bytecode);
fn(21); // 42
```

Compile files directly:

```javascript
const bytecode = lua.compile_file("./scripts/init.lua");
lua.load_bytecode(bytecode);
```

Strip debug information for smaller production bytecode:

```javascript
const devBuild = lua.compile(source);
const prodBuild = lua.compile(source, { stripDebug: true });
console.log(`Dev: ${devBuild.length} bytes, Prod: ${prodBuild.length} bytes`);
```

Bytecode is portable across Lua contexts (same Lua version and architecture):

```javascript
// Compile once, run in multiple independent contexts
const compiler = new lua_native.init();
const bytecode = compiler.compile("return function(x) return x * x end");

const ctx1 = new lua_native.init();
const ctx2 = new lua_native.init();
const square1 = ctx1.load_bytecode(bytecode);
const square2 = ctx2.load_bytecode(bytecode);
square1(5); // 25
square2(7); // 49
```

#### Security Considerations

- **Binary-only loading** — `load_bytecode()` uses Lua's binary-only mode
  (`"b"`), rejecting raw source text. Use `execute_script()` for source strings.
- **Version-specific** — Lua bytecode encodes the Lua version, endianness, and
  pointer size. Bytecode from a different Lua version or architecture will fail
  with a clear error.
- **No integrity checks** — Lua bytecode has no built-in tamper protection.
  Malformed bytecode can crash the Lua VM. If bytecode comes from an untrusted
  source, verify its integrity (e.g., via checksum or signature) before loading.
- **Disable bytecode entirely for untrusted scripts** — Loading malicious
  bytecode is the most likely way an untrusted script escapes a sandbox. Pass
  `allowBytecode: false` to refuse it: `load_bytecode()` throws, and Lua's own
  `load()` is forced to text-only mode so binary chunks are rejected.

  ```javascript
  const sandbox = new lua_native.init({}, {
    libraries: "safe",
    allowBytecode: false,
  });

  sandbox.load_bytecode(bytecode);              // throws: "bytecode loading is disabled..."
  sandbox.execute_script('return load(evil)');  // load() returns nil for a binary chunk
  sandbox.execute_script('return load("return 1")()'); // text still works -> 1
  ```
- **Strip debug info for production** — Use `{ stripDebug: true }` to remove
  local variable names and line numbers, producing smaller bytecode that doesn't
  leak source structure.

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
const lua = new lua_native.init(
  {
    processFile: (fileHandle) => {
      // fileHandle is opaque to JS, but can be returned to Lua
      return fileHandle;
    },
  },
  { libraries: "all" },
);

lua.execute_script(`
  local f = io.tmpfile()
  local f2 = processFile(f)
  f2:write("hello")
  f2:seek("set")
  print(f2:read("*a"))  -- "hello"
  f2:close()
`);
```

#### Method Binding

You can register JavaScript functions as methods on userdata, callable from Lua
using the `:` method syntax (`obj:method(args)`). Methods receive the original
JavaScript object as the first argument (`self`), followed by any Lua-provided
arguments.

```javascript
const player = { x: 0, y: 0, name: "Alice" };

lua.set_userdata("player", player, {
  readable: true,
  methods: {
    move: (self, dx, dy) => {
      self.x += dx;
      self.y += dy;
    },
    get_pos: (self) => [self.x, self.y],
    greet: (self) => `Hello, I'm ${self.name}!`,
  },
});

lua.execute_script(`
  player:move(10, 20)
  local x, y = player:get_pos()
  print(x, y)           -- 10  20
  print(player:greet())  -- Hello, I'm Alice!
  print(player.name)     -- Alice (property access still works)
`);
```

Methods work independently of `readable`/`writable` — you can have methods on an
otherwise opaque handle:

```javascript
const handle = { secret: 42 };

lua.set_userdata("handle", handle, {
  methods: {
    get_value: (self) => self.secret,
  },
});

lua.execute_script(`
  print(handle:get_value())  -- 42
  print(handle.secret)       -- nil (not readable)
`);
```

When both methods and properties exist, methods take precedence over properties
with the same name:

```javascript
const obj = { info: "property" };

lua.set_userdata("obj", obj, {
  readable: true,
  methods: {
    info: (self) => "method result",
  },
});

lua.execute_script(`
  print(obj:info())  -- "method result" (method wins)
`);
```

### Classes / Usertypes

While `set_userdata` exposes a single existing object, `register_class` lets Lua
**construct and drive** your JavaScript objects. It creates a global constructor
table so Lua can build instances with `ClassName.new(...)`, call methods with
`instance:method()`, read/write properties, and use overloaded operators.

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

class Vec {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

lua.register_class("Vec", {
  // Called when Lua runs Vec.new(...); must return the instance object.
  construct: (x, y) => new Vec(x, y),
  readable: true, // Lua can read instance.x / instance.y
  writable: true, // Lua can assign instance.x = ...
  methods: {
    // First argument is always the instance (self).
    length: (self) => Math.hypot(self.x, self.y),
    scale: (self, k) => {
      self.x *= k;
      self.y *= k;
      return self; // returning self keeps it usable as a Vec (see note below)
    },
  },
  metamethods: {
    __add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    __eq: (a, b) => a.x === b.x && a.y === b.y,
    __tostring: (self) => `(${self.x}, ${self.y})`,
  },
});

lua.execute_script(`
  local v = Vec.new(3, 4)
  print(v:length())        -- 5
  print(v.x, v.y)          -- 3  4
  v:scale(2)
  print(tostring(v))       -- (6, 8)

  local sum = Vec.new(1, 2) + Vec.new(3, 4)
  print(sum.x, sum.y)      -- 4  6

  print(Vec.new(1, 1) == Vec.new(1, 1))  -- true
`);
```

Supported metamethods include `__add`, `__sub`, `__mul`, `__div`, `__mod`,
`__unm`, `__concat`, `__len`, `__eq`, `__lt`, `__le`, `__call`, and
`__tostring`. Each receives its Lua operands — class instances arrive as their
original JavaScript objects — and returns the result. Instances are
garbage-collected by Lua; when the last Lua reference is collected, the backing
JavaScript object is released.

#### Instance identity and returning new instances

An instance created by `ClassName.new(...)` keeps its identity across the
boundary: pass it to a JS callback and back, and it is still the same class
instance in Lua.

```javascript
lua.set_global("echo", (v) => v); // returns the same instance
lua.execute_script(`
  local v = Vec.new(3, 4)
  print(echo(v):length())  -- 5 — still a Vec after the round-trip
`);
```

There is one caveat: an object a JavaScript handler **constructs itself** (e.g.
`return new Vec(...)` inside `__add`) comes back to Lua as a **plain table**, not
a class instance — the library only treats objects as class userdata when they
were created through `ClassName.new`. To return a usable instance from a
method/operator, mutate and return `self` (as `scale` does above), or construct
the instance in Lua via `ClassName.new`. This mirrors the userdata round-trip
model described above.

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
const lua = new lua_native.init();

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
const lua = new lua_native.init();

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
const lua = new lua_native.init();

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

### Table Reference API

The table reference API lets you create, read, write, and iterate Lua tables
directly from JavaScript without round-tripping through `execute_script`. Table
handles hold a live reference to the Lua table — mutations from JS are visible in
Lua and vice versa.

#### Creating Tables

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

// Create an empty table
const t = lua.create_table();

// Create with an object initializer (string keys)
const point = lua.create_table({ x: 10, y: 20 });

// Create with an array initializer (1-indexed in Lua)
const list = lua.create_table([100, 200, 300]);
```

#### Reading and Writing Fields

```javascript
const t = lua.create_table();

t.set("name", "Alice");
t.set("score", 95);
t.set(1, "first");

console.log(t.get("name")); // 'Alice'
console.log(t.get("score")); // 95
console.log(t.get(1)); // 'first'
console.log(t.get("missing")); // null

console.log(t.has("name")); // true
console.log(t.has("missing")); // false
console.log(t.length()); // 1 (sequence length — the # operator)
```

#### Iterating Tables

```javascript
const t = lua.create_table({ a: 1, b: 2, c: 3 });

// pairs() — all key-value pairs (like Lua pairs())
for (const [key, value] of t.pairs()) {
  console.log(key, value); // 'a' 1, 'b' 2, 'c' 3
}

// ipairs() — integer sequence from 1 (like Lua ipairs())
const list = lua.create_table([10, 20, 30]);
for (const [index, value] of list.ipairs()) {
  console.log(index, value); // 1 10, 2 20, 3 30
}
```

#### Live References to Global Tables

`get_global_ref()` returns a live handle to an existing global table. Changes
through the handle are immediately visible in Lua, and Lua-side changes are
visible through the handle:

```javascript
lua.execute_script('config = { host = "localhost", port = 5432, debug = false }');

const config = lua.get_global_ref("config");
console.log(config.get("host")); // 'localhost'

// Modify from JS — visible in Lua
config.set("debug", true);
lua.execute_script("print(config.debug)"); // true

// Modify from Lua — visible in JS
lua.execute_script("config.port = 3306");
console.log(config.get("port")); // 3306

config.release(); // free the registry reference when done
```

#### Setting Tables as Globals

Table handles can be passed to `set_global()` to make them accessible from Lua:

```javascript
const player = lua.create_table({ name: "Alice", hp: 100 });
lua.set_global("player", player);

lua.execute_script('print(player.name)'); // Alice
player.release();
```

#### Releasing Handles

Call `release()` when you're done with a handle to free the Lua registry slot.
After release, all methods throw:

```javascript
const t = lua.create_table();
t.set("x", 1);
t.release();

// t.get('x');  // Error: table handle has been released
// t.release(); // safe — double release is a no-op
```

## TypeScript Support

The module includes comprehensive TypeScript definitions:

```typescript
import lua_native from "lua-native";
import type {
  LuaCallbacks,
  LuaContext,
  ClassDefinition,
  CompileOptions,
  LuaCoroutine,
  LuaInitOptions,
  LuaLibraryPreset,
  CoroutineResult,
  LuaFunction,
  LuaTableHandle,
  LuaTableRef,
  MetatableDefinition,
  PcallResult,
  UserdataMethod,
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

// Type-safe userdata with methods
const move: UserdataMethod = (self, dx, dy) => {
  self.x += dx;
  self.y += dy;
};
lua.set_userdata("entity", { x: 0, y: 0 }, { methods: { move } });

// Type-safe class / usertype binding
class Vec {
  constructor(public x: number, public y: number) {}
}
const vecClass: ClassDefinition = {
  construct: (x, y) => new Vec(x as number, y as number),
  readable: true,
  methods: { length: (self) => Math.hypot(self.x, self.y) },
  metamethods: { __tostring: (self) => `(${self.x}, ${self.y})` },
};
lua.register_class("Vec", vecClass);
const vlen: number = lua.execute_script("return Vec.new(3, 4):length()"); // 5

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

// Type-safe bytecode precompilation
const opts: CompileOptions = { stripDebug: true, chunkName: "@my-script" };
const bytecode: Buffer = lua.compile("return 6 * 7", opts);
const answer: number = lua.load_bytecode<number>(bytecode);

const fileBytecode: Buffer = lua.compile_file("./scripts/init.lua");
lua.load_bytecode(fileBytecode);

// Type-safe memory limits
const limited: LuaContext = new lua_native.init({}, {
  libraries: "safe",
  maxMemory: 10 * 1024 * 1024,  // 10 MB
});
const usage: number = limited.get_memory_usage();

// Type-safe custom type converters
class Temperature {
  constructor(public celsius: number) {}
}
lua.register_type_converter(
  (v): v is Temperature => v instanceof Temperature,
  (t: Temperature) => ({ celsius: t.celsius, fahrenheit: t.celsius * 1.8 + 32 }),
);
lua.set_global("temp", new Temperature(20));
const fahrenheit = lua.execute_script("return temp.fahrenheit"); // 68

// 64-bit integers round-trip as bigint when they exceed Number.MAX_SAFE_INTEGER
lua.set_global("big", 9007199254740993n);
const back = lua.execute_script<bigint>("return big"); // 9007199254740993n

// Type-safe promise-aware async execution
const asyncLua: LuaContext = new lua_native.init(
  { load: async (id: number): Promise<number> => id * 2 },
  { libraries: "all" },
);
const doubled: number = await asyncLua.execute_async<number>("return load(21)"); // 42
asyncLua.cancel(); // aborts an in-flight run (no-op here)

// Type-safe protected calls
const risky = lua.execute_script<LuaFunction>(
  'return function(n) if n < 0 then error("neg") end return n end'
);
const pr: PcallResult = lua.pcall(risky, -5);
if (!pr.ok) console.log((pr.error as Error).message); // "...neg..."

// Type-safe output redirection and a dynamic module searcher
const captured: string[] = [];
const io: LuaContext = new lua_native.init({}, {
  libraries: "safe",
  allowBytecode: false, // reject untrusted bytecode
  print: (text: string) => captured.push(text),
});
io.set_print_handler((text: string) => captured.push(text.toUpperCase()));
io.add_searcher((name: string): string | null =>
  name === "util" ? "return { double = function(x) return x * 2 end }" : null
);
io.execute_script('print(require("util").double(21))'); // captured: ["42\n"]

// Type-safe library loading with presets
const preset: LuaLibraryPreset = "safe";
const sandboxed: LuaContext = new lua_native.init({}, { libraries: preset });
sandboxed.execute_script('print(string.upper("safe"))'); // "SAFE"

// Or with an explicit array
const options: LuaInitOptions = { libraries: ["base", "string", "math"] };
const custom: LuaContext = new lua_native.init({}, options);
custom.execute_script('print(string.upper("custom"))'); // "CUSTOM"

// Type-safe table reference API
const handle: LuaTableHandle = lua.create_table({ x: 1, y: 2 });
handle.set("z", 3);
const val: LuaValue = handle.get("x"); // LuaValue
const exists: boolean = handle.has("z");
const len: number = handle.length();
const entries: Array<[string | number, LuaValue]> = handle.pairs();
const seq: Array<[number, LuaValue]> = handle.ipairs();
lua.set_global("point", handle);
handle.release();

// Type-safe get_global_ref
lua.execute_script("data = { items = {1, 2, 3} }");
const ref: LuaTableHandle = lua.get_global_ref("data");
ref.set("count", 3);
ref.release();
```

## API Reference

### `lua_native.init(callbacks?, options?)`

Creates a new Lua execution context. Both arguments are optional — `new lua_native.init()`
creates a bare Lua state with no callbacks and no standard libraries.

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
  - `maxMemory` (optional): Maximum memory in bytes that the Lua state can
    allocate. When exceeded, Lua raises an out-of-memory error. `0` or omitted
    means unlimited. Memory usage is tracked even without a limit.
  - `print` (optional): Handler receiving `print()`/`io.write()` output as
    formatted text (see `set_print_handler`). Takes precedence over a `print`
    in the callbacks object.
  - `allowBytecode` (optional): When `false`, refuses binary chunks —
    `load_bytecode()` throws and `load()` is forced to text-only. Default `true`.

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

### `LuaContext.execute_async(script)`

Executes a Lua script as a coroutine on the **main thread**, transparently
awaiting JavaScript Promises returned by host functions. Unlike
`execute_script_async`, JS callbacks work normally.

**Parameters:**

- `script`: String containing Lua code to execute

**Behavior:**

- When a host function (global, module function, or `obj:method()`) returns a
  `Promise`, the Lua coroutine suspends until it settles, then resumes with the
  resolved value.
- A rejected Promise is raised as a Lua error (catchable with `pcall`); an
  uncaught rejection rejects the returned Promise.
- Only one async run per context at a time (`is_busy()` is `true` meanwhile).

**Returns:** `Promise` resolving with the script's return value(s), or rejecting
on error/cancellation.

**Throws:** Error if the context is busy with another async operation. (Compile
errors reject the returned Promise rather than throwing.)

### `LuaContext.cancel()`

Cancels an in-flight `execute_async` run: its Promise rejects with an "execution
cancelled" error and the suspended coroutine is abandoned. No-op if nothing is
running. Because JavaScript is single-threaded, this takes effect while the
script is suspended awaiting a Promise (not during a synchronous Lua loop).

**Returns:** `void`

### `LuaContext.is_busy()`

Returns whether the context is currently busy with an async operation.

**Returns:** `boolean` — `true` while an async operation is in progress, `false`
otherwise.

### `LuaContext.get_memory_usage()`

Returns the current memory usage of the Lua state in bytes.

**Returns:** `number` — bytes currently allocated by the Lua state

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

### `LuaContext.add_searcher(searcher)`

Adds a JavaScript-backed module searcher for dynamic `require()`. When a required
module is not already loaded or found by earlier searchers, `searcher(name)` is
called; return the module's Lua **source** string to provide it, or
`null`/`undefined` to fall through. Searchers must be synchronous.

**Parameters:**

- `searcher`: `(name: string) => string | null` — maps a module name to its Lua
  source, or null if unknown

**Throws:** `TypeError` if `searcher` is not a function; Error if the `package`
library is not loaded.

### `LuaContext.set_print_handler(handler)`

Redirects Lua `print()` and `io.write()` output to a JS handler, which receives
the fully-formatted output text. Pass `null` to restore output to stdout.

**Parameters:**

- `handler`: `((text: string) => void) | null`

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

### `LuaContext.register_type_converter(match, convert)`

Registers a custom JS→Lua converter for values crossing into Lua. Converters are
consulted in registration order, after internal round-trip markers (Proxy tables
and userdata handles) but before built-in type handling — letting
application-specific types cross the boundary, and letting you override the
built-in conversion of types like `Date` or typed arrays.

**Parameters:**

- `match`: Predicate `(value) => boolean` called with each object-typed value.
  Returning truthy selects this converter.
- `convert`: `(value) => LuaValue` mapping a matched value to a Lua-convertible
  JS value (which is then converted normally). Converters do not see primitives,
  functions, `BigInt`, or `Symbol` values.

**Throws:** `TypeError` if either argument is not a function.

### `LuaContext.set_userdata(name, value, options?)`

Sets a JavaScript object as userdata in the Lua environment. The object is
passed by reference — Lua holds a handle to the original object, not a copy.

**Parameters:**

- `name`: The global variable name in Lua
- `value`: The JavaScript object to store as userdata
- `options` (optional): Access control and methods for the userdata
  - `readable`: Allow Lua to read properties via `__index` (default: `false`)
  - `writable`: Allow Lua to write properties via `__newindex` (default: `false`)
  - `methods`: Object mapping method names to functions callable from Lua via
    `obj:method()` syntax. Each method receives the original JS object as its
    first argument (`self`). Methods work independently of `readable`/`writable`.

### `LuaContext.set_metatable(name, metatable)`

Sets a metatable on an existing global Lua table, enabling operator overloading,
custom indexing, `__tostring`, `__call`, and other metamethods.

**Parameters:**

- `name`: The name of an existing global table
- `metatable`: Object whose keys are metamethod names (e.g. `__add`, `__tostring`)
  and values are either callback functions or static Lua values

**Throws:** Error if the global does not exist or is not a table

### `LuaContext.register_class(name, definition)`

Registers a JavaScript class/usertype so Lua can construct and drive its
instances. Creates a global table `name` with a `new(...)` constructor.

**Parameters:**

- `name`: The global class name in Lua (also the constructor table name)
- `definition`: Object describing the class
  - `construct`: **Required.** Function invoked on `name.new(...)`; receives the
    Lua arguments and must return the instance object (held by reference, not
    copied)
  - `methods` (optional): Map of method name → function, callable via
    `instance:method(args)`. Each receives the instance as its first argument
    (`self`)
  - `metamethods` (optional): Map of metamethod name → function for operator
    overloads and hooks (`__add`, `__eq`, `__lt`, `__le`, `__len`, `__concat`,
    `__unm`, `__tostring`, `__call`, etc.)
  - `readable` (optional): Allow Lua to read instance properties (default:
    `false`)
  - `writable` (optional): Allow Lua to write instance properties (default:
    `false`)

**Throws:** `TypeError` if `name` is not a string, `definition` is not an
object, or `definition.construct` is not a function. A runtime error is raised
if the constructor returns a non-object.

**Note:** Instances created via `name.new(...)` keep their identity across the
JS boundary. An object a JS handler constructs itself and returns (e.g.
`new Vec(...)` inside `__add`) comes back to Lua as a plain table — return
`self`, or construct via `name.new`, to yield a usable instance.

### `LuaContext.pcall(fn, ...args)`

Calls a function in protected mode, returning a result object instead of
throwing.

**Parameters:**

- `fn`: The function to call (typically a Lua function returned to JS)
- `...args`: Arguments to pass to the function

**Returns:** `{ ok: true, value }` on success (where `value` is the return value,
or an array for multiple Lua return values), or `{ ok: false, error }` on
failure. `error` is the original JS `Error` when the failure came from a JS
callback that threw; otherwise an `Error` whose message includes the Lua stack
traceback.

**Throws:** `TypeError` if `fn` is not a function.

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

### `LuaContext.compile(script, options?)`

Compiles Lua source code to bytecode without executing it.

**Parameters:**

- `script`: Lua source code string
- `options` (optional): Compilation settings
  - `stripDebug`: Strip debug information for smaller bytecode (default: `false`)
  - `chunkName`: Name used in error messages (default: derived from source)

**Returns:** `Buffer` containing the compiled bytecode

**Throws:** Error if the source has syntax errors

### `LuaContext.compile_file(filepath, options?)`

Compiles a Lua file to bytecode without executing it.

**Parameters:**

- `filepath`: Path to the Lua source file
- `options` (optional): Same as `compile()`

**Returns:** `Buffer` containing the compiled bytecode

**Throws:** Error if the file cannot be read or has syntax errors

### `LuaContext.load_bytecode(bytecode, chunkName?)`

Loads and executes precompiled Lua bytecode. Only accepts binary bytecode — raw
source text is rejected (use `execute_script()` for source).

**Parameters:**

- `bytecode`: `Buffer` containing Lua bytecode (from `compile()`, `compile_file()`,
  or the `luac` compiler)
- `chunkName` (optional): Name for error messages (default: `"bytecode"`). Note:
  for binary bytecode, the name embedded at compile time takes precedence.

**Returns:** The result of executing the bytecode (converted to the appropriate
JavaScript type), identical to `execute_script`.

**Throws:** Error if the bytecode is invalid, corrupted, or from an incompatible
Lua version.

### `LuaContext.create_table(initial?)`

Creates a new Lua table, optionally pre-populated with values. Returns a live
handle for direct manipulation without `execute_script`.

**Parameters:**

- `initial` (optional): Initial values — a JS object for string keys, or an
  array for 1-indexed integer keys

**Returns:** `LuaTableHandle` — a live reference to the table

### `LuaContext.get_global_ref(name)`

Gets a live reference to an existing global table. Unlike `get_global()` which
deep-copies plain tables, this returns a handle that reads and writes the actual
Lua table in place.

**Parameters:**

- `name`: The global variable name

**Returns:** `LuaTableHandle` — a live reference to the table

**Throws:** Error if the global does not exist or is not a table

### `LuaTableHandle`

A handle to a Lua table stored in the Lua registry. Provides direct get/set/iterate
access. The handle holds a live reference — mutations from JS are visible in Lua
and vice versa. Call `release()` when done to free the registry slot.

**Methods:**

- `get(key: string | number): LuaValue` — Get a field by key. Triggers `__index` if the table has a metatable.
- `set(key: string | number, value: LuaValue): void` — Set a field by key. Triggers `__newindex` if the table has a metatable.
- `has(key: string | number): boolean` — Check if a key exists in the table.
- `length(): number` — Get the table length (`#` operator). Triggers `__len` metamethod.
- `pairs(): Array<[string | number, LuaValue]>` — Get all key-value pairs (like Lua `pairs()`).
- `ipairs(): Array<[number, LuaValue]>` — Get integer-keyed sequence entries (like Lua `ipairs()`). Iterates from index 1 until the first nil.
- `release(): void` — Release the registry reference. After calling `release()`, all other methods throw. Safe to call multiple times.

## Data Type Conversion

| Lua Type              | JavaScript Type | Notes                                                                                                         |
| --------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `nil`                 | `null`          |                                                                                                               |
| `boolean`             | `boolean`       |                                                                                                               |
| `number` (integer)    | `number` \| `bigint` | Integers beyond ±(2^53 − 1) become `bigint` to preserve 64-bit precision                                 |
| `number` (float)      | `number`        |                                                                                                               |
| `string`              | `string`        |                                                                                                               |
| `table` (array-like)  | `Array`         | Sequential numeric indices starting from 1 (no metatable)                                                     |
| `table` (object-like) | `Object`        | String or mixed keys (no metatable)                                                                           |
| `table` (metatabled)  | `Proxy`         | Wrapped as JS Proxy — metamethods preserved                                                                   |
| `function`            | `Function`      | Bidirectional: JS→Lua and Lua→JS                                                                              |
| `thread`              | `LuaCoroutine`  | Created via `create_coroutine()`                                                                              |
| `userdata`            | `Object`        | JS-created via `set_userdata()`, returned by reference. Lua-created userdata passes through as opaque handles |

For the reverse direction — how JavaScript built-in types (`BigInt`, `Date`,
`Map`, `Set`, `Buffer`/`TypedArray`, `RegExp`) convert into Lua — see
[JavaScript Type Conversion](#javascript-type-conversion).

## Limitations

- **Nesting depth limit** — Nested data structures (tables, arrays, objects) are limited to 100 levels deep. Exceeding this limit throws an error.
- **`set_metatable()` only for globals** — `set_metatable()` works on global tables only. To set metatables on non-global tables, use `setmetatable()` in Lua code.
- **Plain tables are copied, not referenced** — When Lua tables _without metatables_ are returned to JavaScript, they are converted to plain objects/arrays (deep copy). Changes to the JavaScript object do not affect the Lua table. Tables _with metatables_ are returned as live Proxy objects that maintain a reference to the original Lua table. Use `create_table()` or `get_global_ref()` to get live handles to plain tables.

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

10 July 2026
