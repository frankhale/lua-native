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
- Type-system fidelity — `BigInt`, `Date`, `Map`, `Set`, `Buffer`/`TypedArray`, and `RegExp` convert to natural Lua representations, with 64-bit integer precision preserved in both directions; register app-specific converters in both directions with `register_type_converter()` and `register_from_lua_converter()`
- Conversion controls — `binaryStrings` returns Lua strings as exact bytes for binary protocols, `tableAs: 'map'` preserves table keys a JS object cannot hold, and `strictConversion` turns every silent conversion loss into an error
- Global variable management (get and set), including dotted paths (`set_global('config.db.host', v)`) that read and auto-create nested table fields
- Call Lua functions by name with `call('greet', 'world')` — dotted paths included — without a `get_global` round-trip
- Userdata support — pass JavaScript objects to Lua by reference with optional property access and method binding
- Class / usertype binding — register a JS class with `register_class()` so Lua can construct instances (`Obj.new(...)`), call methods, access properties, use overloaded operators, and inherit from another registered class with `extends`; declare class-level members with `statics` and computed or validated fields with `properties`
- Metatable support — attach metatables to Lua tables from JavaScript for operator overloading, custom indexing, and more, on a global name or any live table reference
- Reference-based tables — metatabled tables returned from Lua are wrapped in JS Proxy objects, preserving metamethods across the boundary
- Table reference API — create, read, write, and iterate Lua tables directly from JavaScript with `create_table()` and `get_global_ref()`, descending into nested tables by reference with `get_ref()`
- Environment tables — give each script its own global namespace with `create_environment()` / `execute_script_in()`, so scripts in one context can run at different permission levels
- Shared state between contexts — publish one JS object as a global in several contexts with `createSharedTable()` and keep them in step with `set()` / `sync()`
- Reference lifecycle — explicitly free the registry reference behind a returned Lua function, coroutine, or table reference with `release()`, so long-lived contexts don't accumulate Lua-side memory
- Context reset — `reset()` swaps in a fresh Lua state with the same options and replays your callbacks, so a long-lived process can drop accumulated global state without rebuilding the context
- Explicit teardown — `dispose()` tears the Lua state down for good and makes every later call refuse loudly, rather than leaving release up to the garbage collector
- Module / require integration — register JS modules, add search paths, or resolve modules dynamically with a JS searcher (`add_searcher`) for Lua's `require()`
- Output redirection — route Lua `print()` / `io.write()` to a JS handler via `set_print_handler` or the `print` option
- Input redirection and virtual files — route `io.read` to a JS handler with `set_read_handler()`, and resolve `dofile` / `loadfile` through a JS callback with `set_file_reader()`, so a sealed context can serve files that never touch the disk
- Bytecode guard — `allowBytecode: false` refuses untrusted binary chunks (blocks `load_bytecode` and forces `load()` to text-only)
- Opt-in standard library loading with the `'all'`, `'safe'` and `'sandbox'` presets, or an explicit list of libraries — `'sandbox'` is the sealed one, dropping `require`, `dofile`/`loadfile` and bytecode loading rather than just the `io`/`os`/`debug` libraries
- Filesystem policy — `filesystem: 'deny'` closes every door Lua has to the disk in one option (`dofile`, `loadfile`, the `package` path/cpath searchers, `loadlib`, `io.open`, `os.remove`, …), while `require` keeps working for host-registered modules
- Bytecode precompilation — compile Lua to bytecode with `compile()`, load with `load_bytecode()` for faster startup
- Async execution via `execute_script_async` / `execute_file_async` — runs Lua on worker threads, returns Promises
- Promise-aware async via `execute_async` — runs Lua as a main-thread coroutine that transparently `await`s JS Promises returned by host functions (with working callbacks and `cancel()`)
- Awaiting through every door — `call_async()` awaits inside a function you hold (by name or as a `LuaFunction` reference, with no chunk compiled per call) and `resume_async()` does the same for a coroutine you drive yourself
- Memory limits — cap Lua memory usage with `maxMemory` option, monitor with `get_memory_usage()`
- State introspection — `info()` returns a diagnostics snapshot: Lua version, current memory, configured limits, and loaded libraries
- Debug hooks — trace Lua execution from JavaScript with `set_hook()` (line, call, return, and instruction-count events) for profilers and debugger integrations, and read the call stack from inside one with `get_stack()` / `get_locals()`
- GC control — trigger, pause, step, and tune Lua's collector from JavaScript with `gc()`, using Lua's own `collectgarbage` command vocabulary
- Execution limits — cap Lua VM instructions with `maxInstructions`, or wall-clock time with `timeout`, so infinite loops abort instead of hanging
- Coroutine support with yield/resume semantics — created from a script or an existing Lua function, and iterable with `for..of` / `for await`; `close()` runs a suspended coroutine's pending `<close>` handlers, which nothing else in the API will do
- Error fidelity — Lua errors carry stack tracebacks, thrown JS `Error` objects round-trip with full fidelity (type, message, stack, custom props), and `pcall()` runs a function protected, returning `{ ok, value/error }`
- Cross-platform support (Windows, macOS)
- TypeScript support with full type definitions

## Installation

```bash
npm install lua-native
```

**Requires Node.js 20 or later.** The addon is built against N-API version 8, so
the binary itself will load on older releases, but 20+ is the supported and
tested floor (24 LTS recommended). Bun and Deno are supported through their
N-API compatibility layers.

NOTE: The supported targets are macOS (Apple Silicon/arm64) and Windows x64, and
the published package ships a prebuilt binary for both — no C++ toolchain, no
vcpkg, and no build step on install. Linux has not been tested.

NOTE: The prebuilt binaries include Lua 5.5.0. If you need a
different Lua version, you will need to build from source.

## Building from Source

On a supported target you do not need any of this — the prebuilt binary is used
automatically. Build from source to work on the addon itself, to link a
different Lua version, or to run on a platform with no prebuild. Note that this
means building **from a clone**: the published tarball contains prebuilds only,
so `npm install lua-native` on an unshipped platform reports that fact rather
than attempting a compile.

Building compiles a native N-API addon that statically links Lua, so you need a
C++17 toolchain and a Lua library in addition to Node.js. Linux has not been
tested.

### Prerequisites at a Glance

| Dependency               | Version                    | Why it's needed                                                     |
| ------------------------ | -------------------------- | ------------------------------------------------------------------- |
| Node.js                  | 20+ (24 LTS recommended)   | Runtime and host for the addon; supplies npm and `node-gyp`         |
| Python                   | 3.8+                       | Required by `node-gyp` to run gyp                                   |
| vcpkg                    | any recent checkout        | Provides Lua headers and the static Lua library                     |
| Lua (via vcpkg)          | 5.5.x                      | The embedded VM this addon links against                            |
| C++ toolchain            | MSVC v143 / Apple Clang    | Compiles the addon (C++17, exceptions and RTTI enabled)             |
| Git                      | any                        | Fetching the Google Test submodule for debug builds                 |
| CMake                    | 3.20+ *(optional)*         | Only for the alternative CMake build path                           |

The addon targets N-API version 8, so any Node.js ≥ 16 can *load* the compiled
binary. The 20+ floor is for the dev tooling — Vitest 4 requires Node
`^20 || ^22 || >=24`.

### 1. npm Dependencies

Clone the repository and install:

```bash
git clone https://github.com/frankhale/lua-native.git
cd lua-native
npm install
```

**Runtime dependencies** (installed into consumers of the package too):

- **`node-addon-api`** (`^8.9.1`) — the C++ wrapper around N-API. `binding.gyp`
  asks it for its header directory with
  `node -p "require('node-addon-api').include"`, so the build fails without it
  even though nothing imports it from JavaScript.
- **`node-gyp-build`** (`^4.8.4`) — runs as the package's `install` script. On a
  consumer machine it resolves the prebuilt binary in `prebuilds/` and does
  nothing further. Its usual source-build fallback cannot fire: the published
  tarball ships prebuilds only (no `src/`, no `binding.gyp`), so an unshipped
  platform gets a clear error from `index.js` instead of a failed compile.

**Dev dependencies:**

- **`vitest`** (`^4.1.10`) — the TypeScript/JavaScript test suite (`npm test`).
- **`prebuildify`** (`^6.0.1`) — produces the prebuilt binaries in `prebuilds/`
  (`npm run prebuildify`).
- **`@types/node`** (`^25.9.5`) — types for the test suite and build scripts.
  Also declared as an **optional peer dependency**, so a consumer using
  TypeScript gets the Node types the `.d.ts` files assume without it being
  forced on a plain-JS install.

**`node-gyp` is not in `package.json`.** It ships inside npm, and npm puts it on
the `PATH` for `npm run` scripts, which is how `build-debug` / `build-release`
find it. If you see `node-gyp: command not found` (common with alternate package
managers), install it yourself:

```bash
npm install -g node-gyp
```

`node-gyp` also needs **Python 3.8 or newer** on the `PATH`. If you have several
Pythons installed, point it at the right one:

```bash
npm config set python /path/to/python3
# or, per-invocation:
PYTHON=/path/to/python3 npm run build-debug
```

### 2. vcpkg and Lua

Lua is **not** vendored — it comes from [vcpkg](https://vcpkg.io). Both build
paths (`node-gyp` and CMake) resolve the Lua include and library paths from the
`VCPKG_ROOT` environment variable, falling back to `~/vcpkg` when it is unset.

Install vcpkg (skip if you already have one, e.g. the copy CLion manages):

```bash
# macOS / Linux
git clone https://github.com/microsoft/vcpkg.git ~/vcpkg
~/vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT="$HOME/vcpkg"      # add to ~/.zshrc or ~/.bashrc
```

```powershell
# Windows (PowerShell)
git clone https://github.com/microsoft/vcpkg.git C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat
setx VCPKG_ROOT "C:\vcpkg"           # reopen the shell afterward
```

Then install Lua. **The triplet matters** — `get_vcpkg_path.js` looks for a
*static* library at
`$VCPKG_ROOT/installed/<triplet>/lib/{liblua.a,lua.lib}`, and the triplet is
chosen from your platform and architecture:

| Platform            | Triplet             | Command                             |
| ------------------- | ------------------- | ----------------------------------- |
| macOS Apple Silicon | `arm64-osx`         | `npm run vcpkg-lua`                 |
| Windows x64         | `x64-windows-static`| `vcpkg install lua:x64-windows-static` |

**On macOS, use `npm run vcpkg-lua` rather than a bare `vcpkg install lua`.**
The default triplets are already static, so a plain install *links* fine — but
vcpkg's stock `arm64-osx` triplet sets no deployment target, so it builds
`liblua.a` against whatever SDK the machine has. Building on macOS 26 that way
yields a `minos 26.0` static library, one `built for newer 'macOS' version`
warning per Lua object at link time, and an addon whose recorded minimum macOS
is a claim it was never actually linked for.

`triplets/arm64-osx.cmake` in this repo is an overlay triplet that adds
`VCPKG_OSX_DEPLOYMENT_TARGET 13.5`, matching the two `MACOSX_DEPLOYMENT_TARGET`
settings in `binding.gyp`. It is named `arm64-osx` on purpose so it shadows the
built-in triplet and installs to the same `installed/arm64-osx` directory that
`get_vcpkg_path.js` and `CMakeLists.txt` already hardcode. The overlay applies
only when `--overlay-triplets` is passed, which is exactly what the script does —
along with removing the package first (vcpkg otherwise reports "already
installed" and leaves the previous library in place) and printing the resulting
`minos` so you can see the target it actually produced. It installs
`lua[tools]`, since `npm run oracle` needs the port's interpreter.

**On Windows you must ask for `x64-windows-static` explicitly** — the default
`x64-windows` triplet builds a DLL and installs to the wrong directory, and the
addon is built against the static CRT (`/MT`), so it must link a static Lua.
Windows has no deployment-target equivalent, so no overlay is involved there.

vcpkg's `lua` port is currently **5.5.0**, which is what this project targets.
The code uses Lua 5.5 APIs (`luaL_openselectedlibs`, the 5.5 `lua_gc` arities,
native 64-bit integers), so it will **not** compile against Lua 5.4 or earlier.

Verify the resolution before building — these print the exact paths the build
will use:

```bash
npm run get-vcpkg-include   # .../installed/arm64-osx/include
npm run get-vcpkg-lib       # .../installed/arm64-osx/lib/liblua.a
```

If either path does not exist on disk, fix `VCPKG_ROOT` or the triplet before
going further; the compiler error you would otherwise get (`lua.hpp` not found,
or an unresolved-symbol link failure) is much less obvious.

### 3. Platform Build Tools

#### Windows

- **Visual Studio 2022** with the **"Desktop development with C++"** workload,
  or the standalone **Build Tools for Visual Studio 2022**.
- That workload supplies the **MSVC v143 toolset** and the **Windows 10/11 SDK**,
  both required.
- The build uses the **static runtime** (`/MT`, `/MTd` for debug) and defines
  `LUA_STATIC`, which is why the static vcpkg triplet above is mandatory.
- Only **x64** is configured.

#### macOS

- **Xcode Command Line Tools**:

  ```bash
  xcode-select --install
  ```

  A full Xcode install works too, but the Command Line Tools alone are enough.
- Apple Clang with `libc++`, C++17, exceptions and RTTI enabled.
- `binding.gyp` sets `MACOSX_DEPLOYMENT_TARGET` to **13.5**, in both places it
  appears (the addon target and the C++ test target), matching the `minos` of
  the official Node 24 macOS arm64 build. Lua must be built to the same target,
  which is what `npm run vcpkg-lua` and the `triplets/arm64-osx.cmake` overlay
  are for — see "vcpkg and Lua" above. If you change the target, change it in
  all three (both `binding.gyp` settings and the overlay triplet), reinstall Lua
  with `npm run vcpkg-lua`, and regenerate any prebuild.
- Both arm64 and x64 are supported; prebuilt binaries only cover arm64.

### 4. Google Test Submodule (Debug Builds)

The debug build also compiles the C++ test binary, whose sources include
`vendor/googletest`. That directory is a **git submodule** — a fresh clone
leaves it empty and the build fails on a missing `gtest-all.cc`:

```bash
git submodule update --init --recursive
```

`npm run build-release` sets `-Dskip_test=1` and skips the test target, so it
does not need the submodule.

### 5. Build

```bash
# macOS only, and only once per vcpkg tree: install Lua at this project's
# deployment target (see "vcpkg and Lua" above for why a bare install differs).
npm run vcpkg-lua

# Debug build — includes the C++ test binary. Required before `npm test`.
npm run build-debug

# Release build — addon only.
npm run build-release
```

Output lands in `build/Debug/` or `build/Release/` as `lua-native.node`;
`index.js` searches local build output (debug → release → the CMake layouts)
first, then `prebuilds/`, then `node-gyp-build`. Local builds deliberately win,
so a freshly compiled binary is always what loads during development even when a
prebuild is present.

**After any C++ change, re-run `npm run build-debug` before `npm test`** — the
test suite loads the freshly built binary, not a prebuilt one.

#### Alternative: CMake

There are two independent build paths — `binding.gyp` with `node-gyp` (the
default and the one used for releases) and CMake. The CMake path needs **CMake
3.20+** on the `PATH` plus the same `VCPKG_ROOT`; it wires up vcpkg's toolchain
file automatically:

```bash
npm run build-cmake-debug
npm run build-cmake-release
```

#### Clean

```bash
npm run clean   # removes node-gyp's build/ and the cmake-build-* directories
```

### Troubleshooting

| Symptom                                                        | Cause and fix                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `node-gyp: command not found`                                  | Not using npm's bundled copy — `npm install -g node-gyp`                                        |
| `gyp ERR! find Python`                                         | No Python 3.8+ on the `PATH` — install it, or `npm config set python <path>`                    |
| `fatal error: 'lua.hpp' file not found`                        | Wrong or unset `VCPKG_ROOT`, or Lua not installed for the right triplet — check `npm run get-vcpkg-include` |
| `cannot open input file 'lua.lib'` / unresolved Lua symbols    | On Windows, Lua installed for `x64-windows` instead of `x64-windows-static`                     |
| `gtest-all.cc: No such file or directory`                      | Submodule not fetched — `git submodule update --init --recursive`                               |
| Undefined `luaL_openselectedlibs` or `lua_gc` arity errors     | Linking Lua 5.4 or older; this project requires Lua 5.5                                         |
| `npm test` behaves as though your C++ change never happened    | Rebuild with `npm run build-debug` first                                                        |

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

JavaScript functions are callable from Lua even when nested inside an object or
array — they cross the boundary as real Lua functions, not placeholders:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init();

// Functions nested inside a table/array remain callable in Lua
lua.set_global("math_ops", {
  double: (n) => n * 2,
  ops: [(a, b) => a + b],
});

const [d, sum] = lua.execute_script(`
  return math_ops.double(21), math_ops.ops[1](3, 4)
`);
console.log(d, sum); // 42 7
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

// Dotted paths read and auto-create nested table fields
lua.set_global("config.db.host", "localhost"); // creates config and config.db
console.log(lua.get_global("config.db.host")); // 'localhost'
console.log(lua.get_global("config.db.port")); // null (missing leaf)
console.log(lua.get_global("missing.a.b")); // null (nil intermediate, no error)
```

#### Calling Lua Functions by Name

`call(name, ...args)` invokes a Lua function directly, accepting a dotted path
just like `get_global`:

```javascript
lua.execute_script(`
  function greet(name) return "hello " .. name end
  handlers = { on = { tick = function(n) return n * 2 end } }
`);

console.log(lua.call("greet", "world")); // 'hello world'
console.log(lua.call("handlers.on.tick", 21)); // 42
```

This is more than shorthand for `get_global(name)(...)`. `get_global` on a
function mints a JavaScript wrapper backed by its own Lua registry slot, freed
only when that wrapper is garbage-collected — one per call in a per-frame or
per-request loop. `call()` keeps the function on the Lua side, so the steady
state is flat.

The target must be a genuine Lua function; a callable table (one with `__call`)
is rejected with a clear message — reach it through `get_global` instead.

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

#### The Other Direction — `register_from_lua_converter`

`register_from_lua_converter(match, convert)` is the mirror: it rebuilds
application types out of the Lua values that encode them. Together the two make a
round trip:

```javascript
class Money {
  constructor(cents) {
    this.cents = cents;
  }
}

// JS -> Lua
lua.register_type_converter(
  (v) => v instanceof Money,
  (v) => ({ __type: "Money", cents: v.cents }),
);

// Lua -> JS
lua.register_from_lua_converter(
  (v) => v?.__type === "Money",
  (v) => new Money(v.cents),
);

lua.set_global("price", new Money(1299));
const back = lua.get_global("price");
console.log(back instanceof Money, back.cents); // true 1299

// Values Lua builds itself convert too
const total = lua.execute_script(`return { __type = 'Money', cents = 250 }`);
console.log(total instanceof Money); // true
```

`match` sees the value the built-in conversion produced — a plain object for a
Lua table, a Proxy for a metatabled one — since that is the only shape a
JavaScript predicate can inspect. `convert`'s return value is used **verbatim**:
it is already a JavaScript value, so unlike the JS→Lua direction it is not
converted again (which also means a converter matching its own output cannot
loop).

Converters are consulted at every level of the conversion, so they reach values
nested inside tables and arrays, and values arriving as callback arguments — not
just top-level results:

```javascript
lua.set_global("charge", (m) => console.log(m instanceof Money)); // true
lua.execute_script(`
  local order = { items = { { __type = 'Money', cents = 100 } } }
  charge(order.items[1])
`);
```

As with the JS→Lua direction, only object-valued results are offered — every
number and string crossing out of Lua stays on the fast path.

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

#### Safe preset

The `'safe'` preset loads everything except `io`, `os`, and `debug`:

```javascript
const safe = new lua_native.init({}, { libraries: "safe" });

safe.execute_script('print(string.upper("hello"))'); // "HELLO"
safe.execute_script("print(math.floor(3.7))"); // 3
safe.execute_script("print(type(io))"); // "nil" — io is not loaded
safe.execute_script("print(type(os))"); // "nil" — os is not loaded
safe.execute_script("print(type(debug))"); // "nil" — debug is not loaded
```

**`'safe'` is not a sandbox**, and the name is about which libraries load rather
than about what a script can reach. `base` still carries `dofile` and `loadfile`,
and `package` still provides `require` with a writable `package.path` — so
untrusted Lua under `'safe'` can execute any readable `.lua` file on the host.
Use `'sandbox'` below, or add `filesystem: 'deny'`, if that is what you need.

#### Sealed preset (`'sandbox'`)

The `'sandbox'` preset is the sealed one. It loads the computational libraries
and nothing that reaches outside the VM:

```javascript
const lua = new lua_native.init(
  {},
  {
    libraries: "sandbox",
    maxMemory: 256 * 1024,
    maxInstructions: 1_000_000,
  },
);

lua.execute_script('return string.upper("ok")'); // "OK" — base/string/math/table/utf8 are loaded
lua.execute_script("return type(dofile)"); // "nil" — cleared from base
lua.execute_script("return type(require)"); // "nil" — no package library
lua.execute_script("return type(io)"); // "nil"
```

| | `'all'` | `'safe'` | `'sandbox'` |
|---|---|---|---|
| `io`, `os`, `debug` | ✅ | — | — |
| `package` / `require` | ✅ | ✅ | — |
| `dofile`, `loadfile` | ✅ | ✅ | — (cleared from `base`) |
| bytecode loading | ✅ | ✅ | off by default |
| `base`, `coroutine`, `table`, `string`, `math`, `utf8` | ✅ | ✅ | ✅ |

`dofile` and `loadfile` are cleared after the libraries open, because they live
in `base` and cannot be dropped by omitting a library without also losing
`pairs`, `type` and `tostring`. `allowBytecode` defaults to `false` under this
preset, since `string.dump` plus `load` would otherwise reach the bytecode
loader; an explicit `allowBytecode: true` still wins. **The seal survives
`reset()`** — it is part of the runtime config, not a constructor-only step.

A sealed context is not a mute one: [`set_read_handler`](#input-redirection-and-virtual-files)
and [`set_file_reader`](#input-redirection-and-virtual-files) give it input and
files backed by JavaScript rather than by the disk.

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

For deterministic cleanup, run a collection explicitly with
[`gc('collect')`](#luacontextgccommand-), and see that section for how
`gc('count')` relates to `get_memory_usage()`.

### State Introspection

`info()` returns a diagnostics snapshot of a context — which Lua it runs, how
much memory it holds right now, and the limits and libraries it was created
with:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, {
  libraries: "safe",
  maxMemory: 10 * 1024 * 1024,
  maxInstructions: 1_000_000,
});

console.log(lua.info());
// {
//   version: 'Lua 5.5',
//   release: 'Lua 5.5.0',
//   versionNumber: 505,
//   memoryBytes: 15022,
//   memoryKB: 14.669921875,
//   memoryLimit: 10485760,
//   maxInstructions: 1000000,
//   timeout: 0,
//   libraries: ['base', 'package', 'coroutine', 'table', 'string', 'math', 'utf8']
// }
```

Everything reported comes from state the runtime already tracks, so `info()`
runs no Lua code and never triggers a collection — it's safe to poll on a timer:

```javascript
setInterval(() => {
  const { memoryBytes, memoryLimit } = lua.info();
  if (memoryLimit > 0 && memoryBytes / memoryLimit > 0.9) {
    console.warn("Lua context approaching its memory cap");
    lua.reset();
  }
}, 30_000);
```

`libraries` reports the names a preset expanded to, which makes it easy to
confirm what a sandboxed context can actually reach:

```javascript
new lua_native.init({}, { libraries: "safe" }).info().libraries;
// ['base', 'package', 'coroutine', 'table', 'string', 'math', 'utf8'] — no io/os/debug

new lua_native.init().info().libraries; // [] — bare state
```

`memoryBytes` is the same counter `get_memory_usage()` returns, and `memoryKB`
is simply that divided by 1024 — one source of truth, so the two can never
disagree. (Lua's own `gc('count')` is an independent reading; see the
[`gc()`](#luacontextgccommand-) section for how the two relate.)

### Execution Time Limits

Cap the number of Lua VM instructions a single execution may run, so an infinite
loop aborts instead of hanging the host process. This is the second half of
sandboxing alongside `maxMemory`:

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, {
  libraries: "safe",
  maxInstructions: 1_000_000,
});

// Normal scripts complete well within the budget
lua.execute_script("local s = 0; for i = 1, 100 do s = s + i end; return s"); // 5050

// A runaway loop is aborted instead of hanging
try {
  lua.execute_script("while true do end");
} catch (error) {
  console.error(error.message); // "instruction limit exceeded"
}

// The context remains usable afterward
lua.execute_script("return 1 + 1"); // 2
```

The budget applies **per execution call** — each `execute_script`,
`execute_file`, `load_bytecode`, Lua-function call from JS, and each coroutine
`resume` gets a fresh budget, so the limit catches a single runaway execution
without accumulating across unrelated calls. So does any other operation that
runs Lua: a metamethod fired by a table handle, a Proxy read, or access to a
metatabled `_G`. Nested entries — a Lua loop calling a JS callback that
re-enters Lua — share the enclosing budget rather than restarting it, so the
limit bounds the whole call tree. Coroutines created inside a script (including
via `coroutine.create`) inherit the limit. Enforcement is approximate to within
~1000 instructions (the sampling granularity of the hook). Set to `0` or omit
for unlimited execution.

#### Wall-Clock Timeout

`maxInstructions` is deterministic but abstract — how many instructions is "two
seconds"? `timeout` caps real elapsed time instead, in milliseconds:

```javascript
const lua = new lua_native.init({}, {
  libraries: "safe",
  timeout: 5000, // abort any execution running longer than 5 seconds
});

try {
  lua.execute_script("while true do end");
} catch (error) {
  console.error(error.message); // "execution timeout"
}

lua.execute_script("return 1 + 1"); // 2 — the context is still usable
```

The two limits are complements, not alternatives. Set both and whichever is
reached first aborts the script:

```javascript
const sandbox = new lua_native.init({}, {
  libraries: "safe",
  maxMemory: 256 * 1024,
  maxInstructions: 1_000_000,
  timeout: 1000,
});
```

`timeout` follows the same per-execution-call rule as `maxInstructions`: each
`execute_script`, `execute_file`, `load_bytecode`, Lua-function call, coroutine
`resume`, and every other operation that runs Lua (a table-handle metamethod, a
Proxy read, metatabled `_G` access) starts a fresh deadline, and nested entries
share the enclosing one. Under `execute_async`, time spent suspended awaiting a
JS Promise doesn't count — the timeout bounds Lua compute per step, not the
whole round trip.

Both limits are enforced from the same instruction hook, which means the
deadline is checked *between VM instructions*. A single long-running C call — a
huge `string.rep`, or a host callback that blocks — is not interrupted. The
clock is monotonic, so changing the system time can't shorten or extend a
running script.

### Debug Hooks

`set_hook()` exposes Lua's `lua_sethook` to JavaScript: a callback that fires as
the script runs, reporting lines, calls, returns, or instruction counts. It's
the building block for profilers, tracers, and debugger integrations.

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

lua.set_hook((event, line, name) => {
  console.log(`${event} at line ${line}${name ? ` in ${name}` : ""}`);
}, { call: true, line: true });

lua.execute_script(`
  local function add(a, b)
    return a + b
  end
  return add(1, 2)
`);

lua.remove_hook();
```

The callback receives `(event, line, name)`:

| Argument | Meaning |
| --- | --- |
| `event` | `'call'`, `'tail call'`, `'return'`, `'line'`, or `'count'` |
| `line` | Current source line, or `-1` where Lua has no line information |
| `name` | The function's name if Lua can infer one from the call site, else `''` |

Request events with the options object — at least one is required:

```javascript
lua.set_hook(fn, { line: true });    // every source line (most detailed, slowest)
lua.set_hook(fn, { call: true });    // function entry ('call' and 'tail call')
lua.set_hook(fn, { return: true });  // function exit
lua.set_hook(fn, { count: 10_000 }); // every N VM instructions
```

#### Sampling Profiler

`count` is the option to reach for when tracing whole programs — it samples
instead of reporting everything, so the overhead stays bounded:

```javascript
const samples = new Map();

lua.set_hook((_event, line) => {
  samples.set(line, (samples.get(line) ?? 0) + 1);
}, { count: 10_000 });

lua.execute_file("./workload.lua");
lua.remove_hook();

const hottest = [...samples].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log("Hottest lines:", hottest);
```

#### Tracing Until a Condition

Calling `remove_hook()` from inside the callback is safe and is the usual way
to trace only as far as you need:

```javascript
lua.set_hook((event, line) => {
  console.log(event, line);
  if (line >= 100) lua.remove_hook();
}, { line: true });
```

#### Inspecting the Stack — `get_stack()` / `get_locals()`

A hook tells you *where* execution is. These tell you what the stack looks like
there and what its variables hold — the difference between building a profiler
and building a debugger:

```javascript
lua.set_hook((event, line) => {
  if (line === breakpoint) {
    for (const f of lua.get_stack()) {
      console.log(`${f.shortSource}:${f.currentLine}  ${f.name || '?'} (${f.what})`);
    }
    console.log(lua.get_locals(0));   // [{ name: 'n', value: 5 }, ...]
    lua.remove_hook();
  }
}, { line: true });
```

`get_stack()` returns frames innermost-first, each with `level`, `source` /
`shortSource`, `currentLine`, `lineDefined`, `name`, `nameWhat` and `what`
(`'Lua'`, `'C'` or `'main'`). Pass `{ maxLevels }` to cap the walk. Outside
execution it returns `[]`.

`get_locals(level)` returns the named locals of that frame with their values.
Lua's compiler temporaries are skipped, and a level that does not exist is a
`RangeError` rather than an empty array. Both are **read-only** — there is no
stack manipulation and no `lua_State` handed to JavaScript, which keeps the
design decision in [LIMITATIONS.md](docs/LIMITATIONS.md) §7 intact. Both are
refused while `execute_script_async` holds the state on a worker thread.

Chunk names make this legible: pass `{ chunkName: '@file.lua' }` when you run a
script and `shortSource` reports it.

#### What to Know Before Using It

- **`line` is expensive.** It crosses into JavaScript for every source line
  executed, which slows a script by orders of magnitude. Use `count` with a
  coarse interval for anything long-running.
- **A coarser `count` stops paying off.** Hook overhead is
  `fixed + per-fire × fires`, and the fixed part — the cost of the VM taking its
  hook-dispatch path at all — is there whether the callback fires hundreds of
  times or not once. Once the interval is coarse enough that the hook fires only
  a handful of times across your script, what is left is that fixed part, and
  widening it further buys nothing measurable: the remaining choice is between
  *a hook* and *no hook*, not between intervals. On a tight numeric loop
  (measured August 7, 2026) the fixed part was already most of the overhead at
  `count: 1000`.
- **A throwing callback is swallowed.** The hook is a diagnostic channel, not a
  control one — an exception can't be allowed to unwind through Lua's C frames,
  so it's contained and execution continues. To stop a running script, use
  `maxInstructions` or `cancel()`.
- **Coroutines inherit the hook at creation.** It's installed on the main state
  and copied into coroutine threads created *afterwards*, so set it before
  creating the coroutines you want traced — the same rule as `maxInstructions`.
- **Worker-thread async is not traced.** `execute_script_async` /
  `execute_file_async` run Lua on a worker thread, where calling into
  JavaScript is not permitted, so the hook doesn't fire there. `execute_async`
  (main thread) traces normally.
- **It coexists with `maxInstructions` and `cancel()`.** All three share one
  underlying `lua_sethook` installation, and the masks are combined — so
  setting or removing a debug hook never disables the limit or cancellation,
  and a `count` interval finer than the limit's own still works.

Re-entering Lua from the hook is allowed — Lua disables the hook while it runs,
so `lua.execute_script(...)` inside a callback won't recurse.

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

### Input Redirection and Virtual Files

`set_print_handler` covers output. Two more handlers cover the ways Lua reads:
`set_read_handler` routes `io.read`, and `set_file_reader` resolves `dofile` and
`loadfile`. Both matter most in a sealed context, where the real ones are gone.

#### Reading input — `set_read_handler()`

Without it, a prompting script under a print handler has its output captured and
then blocks on the process's real stdin:

```javascript
const lua = new lua_native.init({}, { libraries: "all" });

const lines = ["Ada", "42"];
let i = 0;
lua.set_read_handler(() => (i < lines.length ? lines[i++] : null));

lua.execute_script("return io.read()"); // "Ada"
lua.execute_script('return io.read("n")'); // 42 — a number, like real io.read("n")
```

The handler receives the format as Lua passes it — `'l'`, `'n'`, `'a'`, or a
**number** for a byte count, with the Lua 5.3 `*` prefix already stripped so only
one spelling is ever seen. Return `null` for end-of-input; an empty string is a
valid empty line. Returning a `Uint8Array` or `Buffer` sends those exact bytes to
Lua, which is the only way to feed it a sequence that is not valid UTF-8.

It works in a sealed context, and does not widen the seal:

```javascript
const lua = new lua_native.init({}, { libraries: "sandbox" });

lua.set_read_handler(() => "Ada"); // true — io.read is now wired
lua.execute_script("return io.read()"); // "Ada"
lua.execute_script("return type(io.open)"); // "nil" — still sealed
```

Under `'sandbox'` there is no `io` library, so an `io` table is synthesized to
hold `read` and nothing else — no `open`, `lines`, `write` or `stdout`. The
method **returns whether `io.read` is now wired to your handler**. The only
`false` case is a global `io` that exists and is not a table (`io = 42`): that
value belongs to the script, so it is left alone and the handler is not retained.

Unlike a print handler, a throwing read handler is **not** swallowed — it
surfaces as a Lua error, because a read that failed has no sensible value to
continue with.

#### Serving files — `set_file_reader()`

`add_searcher` covers `require`; this covers the other two ways Lua reaches a
file. Under `'sandbox'`, where `dofile` and `loadfile` are cleared, installing a
reader brings them back backed only by what you choose to serve:

```javascript
const files = {
  "/lib/util.lua": "return { add = function(a, b) return a + b end }",
};

const lua = new lua_native.init({}, { libraries: "sandbox" });
lua.set_file_reader((path) => files[path] ?? null);

lua.execute_script('return dofile("/lib/util.lua").add(2, 3)'); // 5
```

Return the Lua **source** for a path, or `null`/`undefined` for "no such file" —
which `loadfile` reports as `nil, message` and `dofile` raises, the shapes the
real ones use:

```javascript
lua.execute_script('local f, err = loadfile("/nope.lua"); return err');
// "cannot open /nope.lua"
```

**While a reader is installed the real filesystem is never consulted** — this is
deliberately not a fallback chain, because "the reader, or the disk if the reader
declines" would make the meaning of a path depend on the reader's answer. A
reader that wants disk access can read the disk itself. Source is loaded in
text-only mode, so a reader cannot hand back bytecode and route around
`allowBytecode`.

Pass `null` to remove either handler. Both are re-installed automatically across
`reset()`, so a sandboxed context that resets does not silently lose its virtual
filesystem while still holding your callback.

### Filesystem Policy

Closing Lua's access to the disk otherwise takes several calls and still leaves
`package.path` writable from inside the sandbox. `filesystem: 'deny'` closes
every door in one option:

```javascript
const lua = new lua_native.init({}, { libraries: "safe", filesystem: "deny" });

// Modules from the host still work.
lua.register_module("config", { env: "prod" });
lua.execute_script('return require("config").env'); // "prod"

// The disk does not.
lua.execute_script('dofile("/etc/passwd")'); // throws
lua.execute_script('local f, err = loadfile("/etc/passwd"); return err');
// "loadfile is unavailable: this Lua context was created with filesystem access denied"
```

The full door list, which is longer than it first appears:

| Library | Denied |
|---------|--------|
| `base` | `dofile`, `loadfile` |
| `package` | `searchers[2]` (path), `searchers[3]`/`[4]` (cpath → **native code**), `loadlib`, `searchpath` |
| `io` | `open`, `lines`, `input`, `output` |
| `os` | `remove`, `rename`, `tmpname` |

`package.loadlib` and the cpath searchers link an arbitrary shared library into
the process, which is a stronger capability than executing a readable `.lua`
file.

**`require` keeps working** for `register_module` modules and `add_searcher`
searchers — only the searchers that read the disk are closed. That configuration
has no other expression: `'safe'` reaches the disk, and `'sandbox'` has no
`require` at all.

Each door refuses in its own idiom — `loadfile`, `io.open`, `os.remove`,
`os.rename`, `loadlib` and `searchpath` return `nil, message`, while `dofile`,
`io.lines`, `io.input`, `io.output` and `os.tmpname` raise — so a script that
already handles a missing file keeps working. `add_search_path()` refuses rather
than accepting a path `require` could never consult:

```javascript
lua.add_search_path("./modules/?.lua");
// throws: "Cannot add search path: this Lua context was created with filesystem
//  access denied, so require() never consults package.path. Use register_module()
//  or add_searcher() to serve modules from the host."
```

**It governs Lua, not the host.** `execute_file()`, `compile_file()` and a
`set_file_reader` handler keep working — the host asking for a file by name is
your own decision. Process execution (`os.execute`, `io.popen`) is not filesystem
access and is untouched. The seal is re-applied across `reset()` and cannot be
lifted for the life of the context.

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

#### Awaiting in a function you hold — `call_async()`

`execute_async` needs a script to run. `call_async` is the awaiting counterpart
to [`call()`](#luacontextcallname-args): it takes a global name (dotted paths
included) or a `LuaFunction` reference this context produced.

```javascript
const lua = new lua_native.init(
  { fetchName: async (id) => "Ada" }, // a host function returning a Promise
  { libraries: "all" },
);

lua.execute_script('function greet(id) return "hi " .. fetchName(id) end');
await lua.call_async("greet", 7); // "hi Ada"
```

It closes two things `execute_async` cannot. A `LuaFunction` held only on the
JavaScript side — never stored as a global — has no name to route through, so it
could not await at all:

```javascript
const fn = lua.execute_script("return function(id) return fetchName(id) end");
await lua.call_async(fn, 7); // "Ada" — not reachable by name
```

And `execute_async('return f(1)')` compiles a fresh chunk on every call, where
this keeps the function a reference. Everything else matches `execute_async`: the
same driver, the same one-run-per-context rule, and the same `cancel()`
behaviour.

#### Awaiting in a coroutine you drive — `resume_async()`

The awaiting counterpart to [`resume()`](#luacontextresumecoroutine-args), and a
drop-in for it — the resolved value is the same `{ status, values, error? }`
object, **including for a Lua error**, which is reported in the result rather
than thrown.

```javascript
const lua = new lua_native.init(
  { fetchUser: async (id) => ({ name: "Ada", id }) },
  { libraries: "all" },
);

const co = lua.create_coroutine(`
  return function(id)
    local user = fetchUser(id)   -- suspends until the Promise settles
    coroutine.yield(user.name)
    return "done"
  end
`);

const first = await lua.resume_async(co, 7);
console.log(first.status, first.values); // "suspended" ["Ada"]

const second = await lua.resume_async(co);
console.log(second.status, second.values); // "dead" ["done"]
```

Under plain `resume()` the coroutine runs synchronously, so a host callback
returning a Promise anywhere inside it hard-errors. Under `resume_async` the
coroutine *is* the driven thread, so that call suspends it and then continues. A
coroutine created *inside* it still cannot await, and says so.

`for await` over a coroutine steps through `resume_async`, which is what makes an
awaiting loop work:

```javascript
const co = lua.create_coroutine(`
  return function()
    for i = 1, 3 do coroutine.yield(delay(i)) end   -- delay returns a Promise
  end
`);

for await (const v of co) console.log(v); // 2, 4, 6
```

Because the coroutine is yours rather than the binding's, `cancel()` leaves it
**suspended and resumable** at the point it reached — exactly as breaking out of
a `for await` loop does.

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

#### Iterating a coroutine

That hand-written resume loop isn't necessary — a coroutine is iterable, with one
iteration per `yield`:

```javascript
const squares = lua.create_coroutine(`
  return function()
    for i = 1, 5 do
      coroutine.yield(i * i)
    end
  end
`);

console.log([...squares]); // [1, 4, 9, 16, 25]
```

Iteration and `resume()` drive the same Lua thread, so a loop that exits early
leaves the coroutine suspended where it stopped:

```javascript
const co = lua.create_coroutine(`
  return function()
    for i = 1, 5 do coroutine.yield(i) end
  end
`);

for (const n of co) {
  if (n === 3) break;
}

console.log([...co]); // [4, 5] — picks up where the loop stopped
```

The coroutine's final `return` value arrives with `done: true`, which `for..of`
discards — the same contract as a JS generator. `for await (const v of co)` works
too, and steps through [`resume_async`](#awaiting-in-a-coroutine-you-drive--resume_async),
so a coroutine that awaits a host Promise can be iterated the same way.

#### Closing a coroutine — `close()`

Breaking out of a `for..of` loop deliberately leaves the coroutine **suspended**,
so producing an unclosed thread is an ordinary outcome of the documented API
rather than an edge case. If that coroutine holds a to-be-closed variable
(`local f <close> = …`), `close()` is the only way to run its handler from
JavaScript — `release()` frees the registry slot without executing anything, and
garbage collection runs `__gc` but not `__close`:

```javascript
lua.set_global("markClosed", () => console.log("resource released"));

const co = lua.create_coroutine(`
  return function()
    local guard = setmetatable({}, { __close = function() markClosed() end })
    local f <close> = guard
    for i = 1, 100 do coroutine.yield(i) end
  end
`);

for (const n of co) {
  if (n === 3) break; // suspended — the guard is still open
}

lua.close(co); // "resource released" — __close runs now
```

`close()` is **idempotent**: closing an already-closed, finished, or released
coroutine succeeds and does nothing, which is what lets you close defensively. It
throws if a `__close` handler raises, but the thread is dead either way — a
failed close still closed everything it reached.

#### Coroutines from an existing function

`create_coroutine` also takes a Lua function you already hold, so a function
obtained from `execute_script`, `get_global`, or a callback argument doesn't have
to be re-sourced as text:

```javascript
lua.execute_script(`
  function walk(dir)
    for _, name in ipairs(dir) do coroutine.yield(name) end
  end
`);

const walk = lua.get_global("walk");
const co = lua.create_coroutine(walk);

console.log(lua.resume(co, ["a", "b"]).values); // ['a']
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

#### Inheritance

A class can extend another class registered earlier on the same context. A method
missing from the derived class is looked up along the base chain, and the base's
metamethods apply to derived instances unless the derived class defines its own:

```javascript
const lua = new lua_native.init({}, { libraries: "all" });

lua.register_class("Animal", {
  construct: (name) => ({ name, legs: 4 }),
  readable: true,
  methods: {
    speak: (self) => `${self.name} makes a sound`,
    describe: (self) => `${self.name} has ${self.legs} legs`,
  },
  metamethods: {
    __tostring: (self) => `Animal(${self.name})`,
  },
});

lua.register_class("Dog", {
  extends: "Animal",
  construct: (name) => ({ name, legs: 4 }),
  readable: true,
  methods: {
    speak: (self) => `${self.name} barks`, // overrides Animal's
  },
});

lua.execute_script(`
  local d = Dog.new('rex')
  print(d:speak())       -- rex barks       (Dog's own)
  print(d:describe())    -- rex has 4 legs  (inherited from Animal)
  print(tostring(d))     -- Animal(rex)     (inherited metamethod)
`);
```

Three things are deliberately **not** inherited:

- **`construct`.** Each class supplies its own. The JavaScript class hierarchy
  already decides how an instance is built; `extends` only describes how Lua
  resolves names on it.
- **`readable` / `writable`.** These are per-instance flags set by the
  constructor, not metatable state, so state them on each class that needs them.
- **`statics`.** They live on the class table, which has no metatable and
  therefore no lookup chain to extend. A derived class that wants a base's static
  states it again. Named `properties` accessors *are* inherited, because those
  resolve names on an instance.

The base class must already be registered — a forward reference is rejected,
which also makes inheritance cycles impossible.

#### Class-level members — `statics`

`statics` puts members on the class *table* rather than on instances, so Lua
reaches them as `Player.count()` and `Player.VERSION`:

```javascript
class Player {
  constructor(name) {
    this._name = name;
    Player.instances++;
  }
}
Player.instances = 0;

lua.register_class("Player", {
  construct: (name) => new Player(name),
  statics: {
    count: () => Player.instances,
    VERSION: "1.2.0",
  },
});

lua.execute_script(`
  local a, b = Player.new('a'), Player.new('b')
  print(Player.count())    -- 2
  print(Player.VERSION)    -- 1.2.0
`);
```

Functions become callable as `ClassName.fn(...)` and receive the Lua call
arguments with **no `self`**. Other values are converted **once, at
registration** — a static is a class-level constant, not a live view of the
JavaScript property, so reassigning `Player.VERSION` in JS afterwards does not
change what Lua sees. The name `new` is reserved (it is the constructor) and is
rejected.

#### Computed and validated fields — `properties`

`readable` / `writable` are blanket flags over every field. `properties` declares
named accessors instead, which is what makes a computed property, a validated
setter, and a read-only field on an otherwise writable instance expressible:

```javascript
lua.register_class("Player", {
  construct: (name) => new Player(name),
  properties: {
    health: {
      get: (self) => self._hp,
      set: (self, v) => {
        if (v < 0) throw new Error("hp must be >= 0");
        self._hp = v;
      },
    },
    name: { get: (self) => self._name }, // no setter — read-only from Lua
  },
});

lua.execute_script(`
  local p = Player.new('Ada')
  p.health = 10          -- the setter runs
  print(p.health, p.name) -- 10   Ada
`);
```

Reading a set-only property or writing a get-only one is **refused with a message
naming the class**, rather than silently answering `nil` or doing nothing:

```javascript
lua.execute_script("local p = Player.new('Ada'); p.name = 'x'");
// throws: Error writing property 'name': property 'name' of class 'Player' is read-only
```

Precedence is **methods, then accessors, then `readable`/`writable`**. A method
of the same name shadows an accessor, and an accessor beats the blanket flags —
which is what lets a class with `readable: false` expose exactly the properties it
declares and nothing else.

### Metatables

You can attach Lua metatables to Lua tables from JavaScript, enabling operator
overloading, custom `tostring`, callable tables, custom indexing, and more. The
target is either a global name or a live table reference.

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

#### Tables Without a Global Name

`set_metatable` also takes a live table reference — a `create_table()`,
`get_global_ref()`, or `create_environment()` handle, or the Proxy a metatabled
table round-trips as. The table doesn't need a global name:

```javascript
const lua = new lua_native.init({}, { libraries: "all" });

const settings = lua.create_table({ theme: "dark" });
lua.set_metatable(settings, {
  __index: (t, key) => `<unset:${key}>`,
});

console.log(settings.get("theme")); // 'dark'
console.log(settings.get("font")); // '<unset:font>'

// The metatable travels with the table into Lua
lua.set_global("settings", settings);
console.log(lua.execute_script("return settings.font")); // '<unset:font>'
```

The handle's own `get`/`set` go through the metatable, so `__newindex` is visible
from JavaScript exactly as it is from Lua. Any metatable the table already had is
replaced, matching Lua's `setmetatable`.

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

The key's JavaScript type selects the Lua key type: a `number` addresses an
integer key when integral (`1`) or a float key otherwise (`1.5`), while a
`string` always addresses a string key — never coerced to a number. This lets a
genuine string key like `"123"` stay distinct from integer key `123`:

```javascript
const t = lua.create_table();

t.set("123", "string key");
t.set(123, "integer key");
t.set(1.5, "float key"); // preserved, not truncated to key 1

console.log(t.get("123")); // 'string key'
console.log(t.get(123)); //  'integer key'
console.log(t.get(1.5)); //  'float key'
```

(Proxy-based access — reading a table returned into JS as a plain object — can
only use string keys, since JavaScript property keys are always strings. Use a
table handle's `get`/`set`/`has` when you need to distinguish the two.)

#### Tables as Maps — `tableAs: 'map'`

A Lua table's keys can be numbers, strings *and* booleans, and `1` is not
`"1"`. A JavaScript object cannot hold that, so the default conversion loses
some of it. `tableAs: 'map'` returns a `Map` instead:

```javascript
const lua = new lua_native.init({}, { libraries: "all", tableAs: "map" });

lua.execute_script('return {[1]="int", ["1"]="str", [true]="bool"}');
// Map { 1 => 'int', '1' => 'str', true => 'bool' }

// The default mode, for comparison — two entries collapse into one:
// { '1': 'int' }
```

Every table becomes a `Map`, including sequences (`{"a","b"}` → `Map { 1 => "a",
2 => "b" }`) — the shape never depends on what the table happens to contain. It
round-trips: a `Map` passed back into Lua keeps its key types in this mode. A
metatabled table is still returned as a live Proxy, in both modes.

Combined with `strictConversion: true` there is nothing left to refuse, which
makes the pair the only configuration with no silent loss **and** no refusal in
either direction. See [LIMITATIONS.md](docs/LIMITATIONS.md) §5.

#### Refusing Lossy Conversions — `strictConversion: true`

Some conversions cannot be performed faithfully and are documented in
[LIMITATIONS.md](docs/LIMITATIONS.md) §5. By default the lossy ones happen
silently. `strictConversion: true` turns each into an error naming what would
have been lost:

```javascript
const lua = new lua_native.init({}, { libraries: "all", strictConversion: true });

lua.set_global("rows", [1, null, 3]);
// throws: strict conversion: null/undefined at array index 1 becomes a Lua nil,
//   which ends the sequence there — #t and ipairs would stop before the later
//   elements. Filter the array, or use false as a present placeholder.

lua.set_global("rows", [1, false, 3]); // fine — false is a present value

lua.execute_script('return {["1"]="a", [1]="b"}');
// throws: strict conversion: the Lua table keys 1 (number) and "1" (string) both
//   become the JavaScript property "1", so one value would be lost. Read the
//   table in place with get_global_ref() to keep both.
```

| Direction | Refused under `strictConversion` |
|---|---|
| JS → Lua | `null`/`undefined` inside an **array** — it becomes a Lua nil, which ends the sequence there |
| JS → Lua | `null`/`undefined` as an **object value** — a nil removes the key rather than storing one |
| Lua → JS | a table key that is neither string nor number — dropped, since JS cannot key an object by boolean, table or function |
| Lua → JS | a string key and a number key with the same text — `"1"` and `1` collapse, and *which* one survives depends on table order |

The last two are refusals only in the default `tableAs: 'object'` mode; under
`tableAs: 'map'` a `Map` can represent both, so there is nothing to refuse.

#### Byte-Faithful Strings — `binaryStrings: true`

Lua strings are **byte** strings; JavaScript strings are UTF-16. By default a
string crossing out of Lua is decoded as UTF-8, so any byte sequence that is not
valid UTF-8 comes back with U+FFFD in place of each bad byte — fine for text,
lossy for anything else:

```javascript
const lua = new lua_native.init({}, { libraries: "all" });
lua.execute_script('return string.pack("i4", -2)');
// "����" — the bytes are gone
```

With `binaryStrings: true`, every Lua string arrives as a `Uint8Array` of its
exact bytes:

```javascript
const lua = new lua_native.init({}, { libraries: "all", binaryStrings: true });

lua.execute_script('return string.pack("i4", 7)');
// Uint8Array(4) [7, 0, 0, 0]

new TextDecoder().decode(lua.execute_script('return "caf\\xC3\\xA9"')); // 'café'
```

Use it for `string.pack`/`unpack`, compression, crypto, image data, or any binary
protocol. Three things to know:

- **All-or-nothing per context.** Returning bytes only when the decode would have
  been lossy would make the return type depend on the data — the failure mode
  that is hardest to write correct code against. Either every string is text or
  every string is bytes.
- **Table keys are unaffected.** A JS property key is a string either way.
- **Values round-trip.** A `Uint8Array` passed back into Lua was already
  converted to a byte string, so `#b` and `string.byte(b, i)` see the original
  bytes.

#### Iterating Tables

```javascript
const t = lua.create_table({ a: 1, b: 2, c: 3 });

// The handle is directly iterable, and converts each value as it reaches it —
// so stopping early costs only what you consumed. Prefer this on large tables.
for (const [key, value] of t) {
  console.log(key, value); // 'a' 1, 'b' 2, 'c' 3
}

// keys() — the keys alone, converting no values
t.keys(); // ['a', 'b', 'c']

// pairs() — every entry at once, as an array
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

#### Live References to Nested Tables

`get()` follows the library's usual conversion rule: a Lua table **without** a
metatable comes back as a detached deep copy. That's convenient for reading, but
it means a nested table isn't something you can write through:

```javascript
lua.execute_script('outer = { inner = { v = 1 } }');

const copy = lua.get_global_ref("outer").get("inner");
copy.v = 99;
lua.execute_script("return outer.inner.v"); // still 1 — it was a copy
```

`get_ref()` is the explicit opt-in to the real table — `get_global_ref()` one
level down:

```javascript
const inner = lua.get_global_ref("outer").get_ref("inner");

inner.set("v", 99);
lua.execute_script("return outer.inner.v"); // 99

// ...and now it can carry a metatable, which a copy could not
lua.set_metatable(inner, { __index: (t, k) => `<${k}>` });
lua.execute_script("return outer.inner.missing"); // '<missing>'

inner.release();
```

Handles compose, so any depth is reachable — and because the key keeps its
JavaScript type, integer keys and array elements work too, which a dotted string
path could not express:

```javascript
lua.execute_script("a = { b = { c = { d = 7 } } }");
lua.get_global_ref("a").get_ref("b").get_ref("c").get("d"); // 7

lua.execute_script("rows = { { n = 1 }, { n = 2 } }");
lua.get_global_ref("rows").get_ref(2).get("n"); // 2
```

The returned handle is independent of the one it came from: it stays valid after
the parent is released, and needs its own `release()`. `get_ref()` throws if the
field is not a table (including nil).

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

### Environment Tables

The `libraries` option sets one permission level for a whole context.
Environment tables go a step further: they give each *script* its own global
namespace, so scripts running in the same context can see different globals.

An environment is a plain Lua table installed as a chunk's `_ENV` — the table
Lua resolves free variables against. Anything not in it simply reads as `nil`.

```javascript
import lua_native from "lua-native";

const lua = new lua_native.init({}, { libraries: "all" });

// Only math and print are reachable
const env = lua.create_environment({ whitelist: ["math", "print"] });

lua.execute_script_in(env, 'print(math.sqrt(16))'); // 4.0
lua.execute_script_in(env, 'return io.open("/etc/passwd")');
// Error: attempt to index a nil value (global 'io')
```

#### Environments Are Table Handles

`create_environment()` returns an ordinary [table handle](#luatablehandle), so
you can seed it with helpers, read back what a script defined, and release it
the same way:

```javascript
const env = lua.create_environment({ whitelist: ["math"] });

env.set("answer", 42);
lua.execute_script_in(env, "result = math.floor(answer / 5)");

console.log(env.get("result")); // 8
console.log(env.pairs().map(([k]) => k)); // ['math', 'answer', 'result']

env.release();
```

Globals a script assigns land in the environment, never in the real globals:

```javascript
lua.execute_script("counter = 1");
lua.execute_script_in(env, "counter = 99");

console.log(lua.get_global("counter")); // 1 — untouched
console.log(env.get("counter")); // 99
```

Two environments are fully isolated from each other, which is what makes this
useful for multi-tenant scripting:

```javascript
const a = lua.create_environment({ whitelist: ["print"] });
const b = lua.create_environment({ whitelist: ["print"] });

lua.execute_script_in(a, 'tenant = "a"');
lua.execute_script_in(b, 'tenant = "b"');

lua.execute_script_in(a, "return tenant"); // 'a'
lua.execute_script_in(b, "return tenant"); // 'b'
```

#### Inheriting from the Real Globals

With `inherit: true`, names the environment doesn't define fall through to `_G`
via an `__index` metatable. Reads fall through; writes never do — so an
assignment shadows the global instead of overwriting it:

```javascript
lua.execute_script('app_name = "demo"');

const env = lua.create_environment({ inherit: true });

lua.execute_script_in(env, "return app_name"); // 'demo' — read through
lua.execute_script_in(env, 'app_name = "sandboxed"');

lua.execute_script_in(env, "return app_name"); // 'sandboxed'
lua.get_global("app_name"); // 'demo' — the global is untouched
```

Use `inherit: true` for scoping (keeping a script's globals out of the shared
namespace) and `inherit: false` — the default — for sandboxing.

#### What an Environment Does and Doesn't Restrict

- Whitelisted globals are copied **by value**. `math` in the environment is the
  same table `_G.math` names, so a script that does `math.floor = nil` breaks it
  for everyone. Give untrusted scripts their own copies if that matters.
- Whitelisting `'_G'` hands the script the real globals table and defeats the
  isolation entirely.
- An environment restricts the global **namespace**, not the VM. Pair it with
  `maxMemory` and `maxInstructions` for resource limits, and with the
  `libraries` option to keep dangerous libraries out of the context to begin
  with — a library that was never loaded can't be whitelisted by mistake.

Any table reference works as an environment, not just one from
`create_environment()`:

```javascript
lua.execute_script("sandbox = { limit = 3 }");
lua.execute_script_in(lua.get_global_ref("sandbox"), "return limit"); // 3
```

### Shared State Between Contexts

Each `new lua_native.init()` is a fully independent Lua state, and Lua states
cannot share memory. A **shared table** gives you the next best thing:
synchronized copies. One JavaScript object is published as a global in every
context that subscribes to it, and every update is pushed to all of them.

```javascript
import lua_native from "lua-native";

const settings = lua_native.createSharedTable({ mode: "dev", retries: 3 });

const lua1 = new lua_native.init({}, { libraries: "all", shared: { settings } });
const lua2 = new lua_native.init({}, { libraries: "all", shared: { settings } });

console.log(lua1.execute_script("return settings.mode")); // 'dev'
console.log(lua2.execute_script("return settings.retries")); // 3

// One update, both contexts
settings.set("mode", "prod");
console.log(lua1.execute_script("return settings.mode")); // 'prod'
console.log(lua2.execute_script("return settings.mode")); // 'prod'
```

The key in the `shared` option is the global name, so the same shared table can
appear under different names in different contexts, and a context can subscribe
to several shared tables at once:

```javascript
const lua = new lua_native.init({}, {
  libraries: "all",
  shared: { config: configTable, cache: cacheTable },
});
```

#### Reading and Updating

`get()` and `set()` operate on the JavaScript-side value. `set()` publishes
immediately; `sync()` publishes after you mutate the object directly:

```javascript
const shared = lua_native.createSharedTable({ config: { debug: true } });
const lua = new lua_native.init({}, { libraries: "all", shared: { settings: shared } });

shared.set("retries", 5); // published right away
shared.get("retries"); // 5

// Mutating a nested object (or the object you passed to createSharedTable)
// is not self-publishing — call sync() when you're done.
shared.get("config").debug = false;
shared.sync();

lua.execute_script("return settings.config.debug"); // false
```

A context that subscribes later gets the current value, not the initial one:

```javascript
const shared = lua_native.createSharedTable({ n: 1 });
const early = new lua_native.init({}, { shared: { s: shared } });
shared.set("n", 2);
const late = new lua_native.init({}, { shared: { s: shared } }); // sees n = 2
```

#### What "Shared" Means Here

Since Lua states cannot share memory, the sharing is maintained by copying.
That has three consequences worth knowing:

- **Propagation is one-way (JS → Lua).** A Lua script that assigns into the
  shared global changes only its own context's copy. That edit does not reach
  the other contexts, does not update the JS-side value, and is overwritten by
  the next `set()` / `sync()`. Read a context's own view back with
  `get_global()` if you need it.

  ```javascript
  lua1.execute_script("settings.n = 999");
  lua1.execute_script("return settings.n"); // 999 — local only
  lua2.execute_script("return settings.n"); // unchanged
  shared.get("n"); // unchanged
  ```

- **Every update re-pushes the whole value.** A large shared table costs
  proportionally on every `set()` and `sync()`. Shared tables are meant for
  configuration-sized state, not bulk data.

- **A context that can't accept the update is reported, not skipped silently.**
  If a subscriber is busy with an async operation, `set()` still updates the JS
  value and every other context, then throws naming the ones that failed. Call
  `sync()` to retry once they're free.

Subscriptions don't keep contexts alive — a garbage-collected context is
dropped from the subscriber list. And because the value lives in JS, `reset()`
re-publishes the shared globals onto the fresh state automatically.

#### Alternative: `set_global` on Each Context

Sharing is copy-and-sync either way, so for a one-off value there's nothing
wrong with the manual form:

```javascript
const config = { mode: "prod" };
lua1.set_global("settings", config);
lua2.set_global("settings", config);
```

A shared table is worth it once you have several contexts, updates over time,
or contexts created at different points — it keeps the subscriber list and the
"publish to everyone" step in one place.

## TypeScript Support

The module includes comprehensive TypeScript definitions:

```typescript
import lua_native from "lua-native";
import type {
  LuaCallbacks,
  LuaContext,
  ClassDefinition,
  CompileOptions,
  EnvironmentOptions,
  HookOptions,
  LuaCoroutine,
  LuaEnvironment,
  LuaInitOptions,
  LuaLibraryPreset,
  LuaStateInfo,
  CoroutineResult,
  LuaFunction,
  LuaTableHandle,
  LuaTableRef,
  MetatableDefinition,
  PcallResult,
  SharedTable,
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

// ...or iterate it, one step per yield
const counter: LuaCoroutine = lua.create_coroutine(`
  return function() for i = 1, 3 do coroutine.yield(i) end end
`);
const seen: LuaValue[] = [...counter]; // [1, 2, 3]

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

// ...and the Lua -> JS direction, completing the round trip
lua.register_from_lua_converter(
  (v: any) => v?.__type === "Temperature",
  (v: any) => new Temperature(v.celsius),
);
const t = lua.execute_script(`return { __type = 'Temperature', celsius = 20 }`);
// t instanceof Temperature

// Type-safe call by name
lua.execute_script("function scale(n, by) return n * by end");
const scaled: number = lua.call<number>("scale", 21, 2); // 42

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
const entries: Array<[string | number | boolean | Uint8Array, LuaValue]> = handle.pairs();
for (const [k, v] of handle) { /* lazy: one value converted per step */ }
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
    - `'safe'` — loads all except `io`, `os`, and `debug`. **Not a sandbox** —
      `require`, `dofile` and `loadfile` still reach the disk.
    - `'sandbox'` — the sealed preset: `base`, `coroutine`, `table`, `string`,
      `math` and `utf8`, with `dofile`/`loadfile` cleared from `base`, no
      `package`/`require`, and `allowBytecode` defaulting to `false`. Survives
      `reset()`.
    - `LuaLibrary[]` — array of specific library names
    - `[]` — bare state (no libraries)

    Valid library names: `'base'`, `'package'`, `'coroutine'`, `'table'`, `'io'`,
    `'os'`, `'string'`, `'math'`, `'utf8'`, `'debug'`
  - `maxMemory` (optional): Maximum memory in bytes that the Lua state can
    allocate. When exceeded, Lua raises an out-of-memory error. `0` or omitted
    means unlimited. Memory usage is tracked even without a limit.
  - `maxInstructions` (optional): Maximum number of Lua VM instructions a single
    execution may run before it is aborted with an `"instruction limit
    exceeded"` error, preventing infinite loops from hanging the process. The
    budget applies per execution call (each `execute_script`/`execute_file`/
    `load_bytecode`, Lua-function call, coroutine `resume`, and any other
    operation that runs Lua, such as a metamethod fired by a table handle);
    nested entries share the enclosing budget. `0` or omitted means unlimited.
    Enforcement is approximate to within ~1000 instructions.
  - `timeout` (optional): Maximum wall-clock milliseconds a single execution may
    run before it is aborted with an `"execution timeout"` error. Same
    per-execution-call rule as `maxInstructions`; set both and whichever is
    reached first wins. `0` or omitted means no timeout. Checked between VM
    instructions, so a single long-running C call is not interrupted.
  - `print` (optional): Handler receiving `print()`/`io.write()` output as
    formatted text (see `set_print_handler`). Takes precedence over a `print`
    in the callbacks object.
  - `allowBytecode` (optional): When `false`, refuses binary chunks —
    `load_bytecode()` throws and `load()` is forced to text-only. Defaults to
    `true` everywhere except `libraries: 'sandbox'`, which defaults it to
    `false`; an explicit value always wins.
  - `filesystem` (optional): `'allow'` (default) or `'deny'`. Under `'deny'`,
    every door Lua has to the disk is closed — `dofile`, `loadfile`, the
    `package` path/cpath searchers, `loadlib`, `searchpath`, `io.open`/`lines`/
    `input`/`output`, and `os.remove`/`rename`/`tmpname`. `require` keeps working
    for `register_module` modules and `add_searcher` searchers, and
    `add_search_path()` refuses rather than accepting a path that could never be
    consulted. Governs Lua only: `execute_file()`, `compile_file()` and a
    `set_file_reader` handler are unaffected. Re-applied across `reset()` and
    cannot be lifted for the life of the context.
  - `binaryStrings` (optional): When `true`, every Lua string arrives in JS as a
    `Uint8Array` of its exact bytes instead of a UTF-8-decoded string, so binary
    data survives the crossing. All-or-nothing per context; table keys are
    unaffected. Default `false`.
  - `strictConversion` (optional): When `true`, a conversion that would silently
    lose data raises instead — `null`/`undefined` in an array or as an object
    value, and (in `tableAs: 'object'` mode) a dropped or colliding Lua table
    key. Default `false`.
  - `tableAs` (optional): `'object'` (default) or `'map'`. Under `'map'` a Lua
    table arrives as a `Map`, which can hold the number, string and boolean keys
    a JS object cannot — `{[1]="a", ["1"]="b"}` keeps both entries. Applies to
    every table including sequences; metatabled tables are still returned as
    live Proxies in both modes.
  - `shared` (optional): Object mapping global names to `SharedTable` instances
    (see `createSharedTable`). Each one's current value is published as that
    global at construction, and the context receives every later update.

**Returns:** `LuaContext` instance

**Throws:** Error if an unknown library name is provided, or if a `shared` entry
is not a shared table created with `createSharedTable()`

### `lua_native.createSharedTable(initial?)`

Creates a shared table — a JavaScript object that can be published as a global
in several Lua contexts and kept in step across them. Subscribe a context by
passing the shared table in the `shared` init option.

**Parameters:**

- `initial` (optional): The object to share. Held, not copied — mutating it and
  calling `sync()` publishes the change. Defaults to an empty object.

**Returns:** `SharedTable`

**Throws:** `TypeError` if `initial` is not an object

### `SharedTable`

A JavaScript value mirrored as a global in one or more Lua contexts. Because Lua
states cannot share memory, "shared" means synchronized copies: propagation is
one-way (JS → Lua) and re-pushes the whole value on every update. See
[Shared State Between Contexts](#shared-state-between-contexts) for the full
model.

**Methods:**

- `get(key: string): LuaValue` — Read a top-level field of the JavaScript-side
  value. Lua-side edits are not reflected here.
- `set(key: string, value: LuaInput): void` — Set a top-level field and
  immediately publish the whole value to every subscribed context. Throws if a
  subscriber rejects the update (e.g. one busy with an async operation) — the JS
  value is still updated and the other contexts still receive it.
- `sync(): void` — Re-publish the current value to every subscribed context. Use
  after mutating the shared object directly, or to retry a rejected `set()`.

### `LuaContext.execute_script(script, options?)`

Executes a Lua script and returns the result.

**Parameters:**

- `script`: String containing Lua code to execute
- `options` (optional):
  - `chunkName`: what Lua calls this chunk in errors and tracebacks. See
    [Naming a Chunk](#naming-a-chunk). A non-string is rejected, not ignored.

**Returns:** The result of the script execution (converted to the appropriate
JavaScript type). Tables with metatables are returned as Proxy objects that
preserve metamethods; plain tables are deep-copied into objects or arrays.

#### Naming a Chunk

Without a name, a chunk loaded from a string is identified by its own source, so
an error reads `[string "local cfg = nil..."]:2:` — which says nothing useful
when the script came from a file, a database row, or a user. Every door that
loads Lua source takes `chunkName`: `execute_script`, `execute_script_async`,
`execute_async`, `execute_script_in`, `create_coroutine` and `compile`.

Lua's prefix conventions decide the formatting, and they are worth knowing
because `@` is almost always the one you want:

| `chunkName` | An error reads |
| ----------- | -------------- |
| *(omitted)* | `[string "local cfg = nil..."]:2:` |
| `'config.lua'` | `[string "config.lua"]:2:` |
| `'@config.lua'` | `config.lua:2:` — `@` means "this is a file" |
| `'=config'` | `config:2:` — `=` means "print verbatim" |

```javascript
lua.execute_script(source, { chunkName: `@${path}` });
// scripts/init.lua:12: attempt to index a nil value (local 'cfg')
```

`@` is what `execute_file` and `compile_file` use for real files, so a named
string chunk reports exactly like one.

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

### `LuaContext.call_async(nameOrFn, ...args)`

The awaiting counterpart to `call()` — calls a Lua function on the **main
thread** as a coroutine, so host functions it invokes may return Promises.

**Parameters:**

- `nameOrFn`: A global name, a dotted path (like `get_global`), or a
  `LuaFunction` this context produced
- `...args`: Arguments to pass to the function

Unlike `execute_async`, a `LuaFunction` held only on the JavaScript side can
await — routing through `execute_async` needs a *name* to call. It also compiles
no chunk per call. A callable table (`__call`) is refused, exactly as `call()`
refuses it.

```javascript
lua.execute_script('function greet(id) return "hi " .. fetchName(id) end');
await lua.call_async("greet", 7); // "hi Ada"

const fn = lua.execute_script("return function(id) return fetchName(id) end");
await lua.call_async(fn, 7); // "Ada" — not reachable by name
```

**Returns:** `Promise` resolving with the function's return value(s).

**Throws:** Error if the context is busy with another async operation, or if
argument validation fails. Failures past that point reject the Promise.

### `LuaContext.cancel()`

Cancels an in-flight `execute_async` run: its Promise rejects with an "execution
cancelled" error and the suspended coroutine is abandoned. No-op if nothing is
running. Because JavaScript is single-threaded, this takes effect while the
script is suspended awaiting a Promise (not during a synchronous Lua loop).

**Returns:** `void`

### `LuaContext.is_busy()`

Returns whether the context is currently busy with an async operation. Only one
runs per context at a time, so this is the check that tells you whether a second
async call would throw.

```javascript
const p = lua.execute_script_async("local s = 0; for i=1,200000 do s = s + i end; return s");
lua.is_busy(); // true
await p;
lua.is_busy(); // false
```

**Returns:** `boolean` — `true` while an async operation is in progress, `false`
otherwise.

### `LuaContext.get_memory_usage()`

Returns the current memory usage of the Lua state in bytes.

**Returns:** `number` — bytes currently allocated by the Lua state

**Throws:** Error if the context is busy with an async operation (the allocator
counter is being updated on another thread).

### `LuaContext.info()`

Returns a diagnostics snapshot of the context. Reads only state the runtime
already tracks — no Lua code runs and no collection is triggered, so it is safe
to call on a monitoring timer.

**Returns:** `LuaStateInfo`

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `string` | Lua version of the linked build, e.g. `'Lua 5.5'` |
| `release` | `string` | Full version including the patch level, e.g. `'Lua 5.5.0'` |
| `versionNumber` | `number` | Numeric form for comparisons: major × 100 + minor (e.g. `505`) |
| `memoryBytes` | `number` | Memory currently held by the state — the same value as `get_memory_usage()` |
| `memoryKB` | `number` | `memoryBytes / 1024` (fractional) |
| `memoryLimit` | `number` | The `maxMemory` this context was created with, in bytes. `0` = unlimited |
| `maxInstructions` | `number` | The `maxInstructions` limit in force. `0` = unlimited |
| `timeout` | `number` | The `timeout` in force, in milliseconds. `0` = no timeout |
| `libraries` | `string[]` | Standard libraries loaded, by name. A preset reads back as the names it expanded to; a bare state as `[]` |

**Throws:** Error if the context is busy with an async operation (the allocator
counter is being updated on another thread).

### `LuaContext.gc(command, ...)`

Controls Lua's garbage collector. The command names mirror Lua's own
`collectgarbage`, so anything you know from Lua transfers directly.

| Command | Returns | Description |
| ------- | ------- | ----------- |
| `'collect'` | `undefined` | Runs a full collection cycle, including pending `__gc` finalizers |
| `'stop'` | `undefined` | Stops automatic collection |
| `'restart'` | `undefined` | Resumes automatic collection |
| `'count'` | `number` | Memory in use, in KB (fractional — `× 1024` is the exact byte count) |
| `'isrunning'` | `boolean` | Whether automatic collection is running |
| `'step'` | `boolean` | Performs one step; `true` if it finished a cycle. Optional second argument: bytes to treat as newly allocated (`0`/omitted = one basic step) |
| `'incremental'` / `'generational'` | `'incremental' \| 'generational'` | Switches mode, returning the previous one |
| `'param'` | `number` | Reads or sets a tuning parameter, returning the previous value |

```javascript
lua.gc('collect'); // full cycle

// Keep a latency-sensitive batch free of collector pauses.
lua.gc('stop');
lua.execute_script('process_batch()');
lua.gc('restart');

const kb = lua.gc('count'); // e.g. 19.07
const done = lua.gc('step', 1024); // drive collection in slices

const previousMode = lua.gc('generational'); // 'incremental'
const previousPause = lua.gc('param', 'pause', 400);
```

Tunable parameters for `gc('param', name, value?)` are `'minormul'`,
`'majorminor'`, `'minormajor'` (generational mode) and `'pause'`, `'stepmul'`,
`'stepsize'` (incremental mode). Omit `value` to read without changing;
values must be in the range 0–100000.

**`gc('count')` vs `get_memory_usage()`:** both report the same memory, but from
different sources. `gc('count')` is Lua's own GC accounting (KB), identical to
`collectgarbage('count')` inside Lua. `get_memory_usage()` is this binding's
allocator tally (bytes) and is the larger of the two — `luaL_Buffer` scratch
memory (used by `string.rep`, `table.concat`, and friends) goes straight to the
allocator, bypassing Lua's accounting until the buffer is collected. The
allocator tally is what `maxMemory` enforces against.

Stopping the collector does **not** defeat `maxMemory`: Lua still runs an
emergency collection when an allocation would exceed the cap.

**Throws:** `TypeError` for a missing or non-string command; Error for an
unrecognized command or parameter name, if the context is busy with an async
operation, or if called while a collection is in progress (Lua forbids
`lua_gc` from inside a `__gc` finalizer).

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

### `LuaContext.set_read_handler(handler)`

Routes `io.read` to a JavaScript handler — the input counterpart to
`set_print_handler`. Pass `null` to clear. See
[Input Redirection and Virtual Files](#input-redirection-and-virtual-files).

**Parameters:**

- `handler`: `((format: string | number) => string | Uint8Array | ArrayBuffer | null | undefined) | null`
  - `format` is the format as Lua passes it — `'l'`, `'n'`, `'a'`, or a **number**
    for a byte count, with the Lua 5.3 `*` prefix stripped so only one spelling is
    ever seen. It is always a string or number, even under `binaryStrings`.
  - Return `null` for end-of-input; an empty string is a valid empty line. A
    `Uint8Array`/`Buffer` sends those exact bytes to Lua. The `'n'` format
    converts to a number or `nil`, matching real `io.read("n")`.

```javascript
const lines = ["Ada", "42"];
let i = 0;
lua.set_read_handler(() => (i < lines.length ? lines[i++] : null));
lua.execute_script("return io.read()"); // "Ada"
lua.execute_script('return io.read("n")'); // 42
```

**Returns:** `boolean` — whether `io.read` is now wired to the handler. Under a
bare or `'sandbox'` state an `io` table holding only `read` is synthesized, so
this is normally `true`. The one `false` case is a global `io` that exists and is
not a table (`io = 42`): that value belongs to the script, so it is left alone
and the handler is not retained.

**Notes:** Unlike a print handler, a throwing read handler is **not** swallowed —
it surfaces as a Lua error, because a read that failed has no sensible value to
continue with. Re-installed automatically across `reset()`.

### `LuaContext.set_file_reader(reader)`

Resolves `dofile` and `loadfile` through a JavaScript callback instead of the
filesystem — a virtual filesystem for the two entry points `add_searcher` does
not cover. Pass `null` to remove.

**Parameters:**

- `reader`: `((path: string) => string | null | undefined) | null` — return the
  Lua **source** for a path, or `null`/`undefined` for "no such file", which
  `loadfile` reports as `nil, message` and `dofile` raises. An empty string is a
  valid empty file.

```javascript
const files = { "/lib/util.lua": "return { add = function(a,b) return a+b end }" };
const lua = new lua_native.init({}, { libraries: "sandbox" });
lua.set_file_reader((path) => files[path] ?? null);
lua.execute_script('return dofile("/lib/util.lua").add(2, 3)'); // 5
```

**Notes:** While a reader is installed, `dofile`/`loadfile` resolve through it
**exclusively** — the real filesystem is never consulted. Deliberately not a
fallback chain, since "the reader, or the disk if the reader declines" would make
the meaning of a path depend on the reader's answer. Source loads in text-only
mode, so a reader cannot hand back bytecode and route around `allowBytecode`.
`require` is unaffected — use `add_searcher()` for that. Re-installed
automatically across `reset()`.

### `LuaContext.set_hook(callback, options)`

Installs a debug hook (`lua_sethook`) that reports execution events to a JS
callback. Setting a hook replaces any previous one. See
[Debug Hooks](#debug-hooks) for the caveats that matter in practice.

**Parameters:**

- `callback`: `(event, line, name) => void`
  - `event`: `'call'` | `'tail call'` | `'return'` | `'line'` | `'count'`
  - `line`: current source line, or `-1` where Lua has no line information
  - `name`: the function's name if Lua can infer one, otherwise `''`
- `options`: which events to fire on — at least one is required
  - `call` (optional): fire on function entry (`'call'` and `'tail call'`)
  - `return` (optional): fire on function return
  - `line` (optional): fire on each new source line — the most expensive option
  - `count` (optional): fire every N VM instructions (positive integer)

**Throws:** `TypeError` if the callback is not a function, the options object is
missing, or no event is requested; `RangeError` if `count` is not a positive
integer; Error if an async operation is in flight.

**Notes:** An exception thrown by the callback is swallowed. Hooks do not fire
during worker-thread async execution (`execute_script_async` /
`execute_file_async`). Coroutines inherit the hook only if created after it was
installed. Shares one `lua_sethook` installation with `maxInstructions` and
`cancel()`, which keep working regardless.

### `LuaContext.remove_hook()`

Removes the debug hook installed by `set_hook()`. Safe to call when no hook is
set, and safe to call from inside the hook callback. `maxInstructions` and
`cancel()` are unaffected.

**Throws:** Error if an async operation is in flight.

### `LuaContext.get_stack(options?)`

Returns the current Lua call stack, innermost frame first. Read-only
introspection over `lua_getstack`/`lua_getinfo` — intended to be called from
inside a `set_hook()` callback or a host function, where there is a stack to
read. See [Inspecting the Stack](#inspecting-the-stack--get_stack--get_locals).

**Parameters:**

- `options` (optional):
  - `maxLevels`: cap on how many frames to walk

**Returns:** `LuaStackFrame[]`, each with `level`, `source`, `shortSource`,
`currentLine`, `lineDefined`, `name`, `nameWhat`, and `what`.

```javascript
lua.set_hook(() => {
  for (const f of lua.get_stack()) {
    console.log(`${f.level}: ${f.name || "?"} at ${f.shortSource}:${f.currentLine}`);
  }
}, { call: true });
```

### `LuaContext.get_locals(level)`

Returns the named local variables of one stack frame, with their values.

**Parameters:**

- `level`: The stack level to inspect — `0` is the innermost frame, matching the
  `level` field of a `get_stack()` entry

**Returns:** `Array<{ name: string; value: LuaValue }>`. Lua's internal temporaries
(names beginning with `(`) are not included, and a frame with no named locals
returns an empty array.

```javascript
lua.get_locals(0); // [{ name: 'n', value: 5 }, ...]
```

### `LuaContext.set_global(name, value)`

Sets a global variable or function in the Lua environment.

A dotted `name` addresses a **nested field** and creates any missing
intermediate tables as it descends:

```javascript
lua.set_global('config.db.host', 'localhost');
lua.execute_script('return config.db.host'); // 'localhost' (config and config.db were auto-created)
```

Field access flows through `__index`/`__newindex` metamethods, like real Lua
field access. It throws if an existing intermediate is a non-table value (e.g.
`config` is already a number), or if the path is malformed (a leading, trailing,
or doubled dot). A name with no dot sets a single global whose key may itself
contain dots.

**Parameters:**

- `name`: Name of the global variable, or a dotted path to a nested field
- `value`: Value to set (function, number, string, boolean, or object)

### `LuaContext.get_global(name)`

Gets a global variable from the Lua environment.

A dotted `name` reads a **nested field**, descending through `__index`
metamethods. If any segment along the path is nil, the result is `null`
(optional-chaining semantics), just as a missing single global reads back as
`null`:

```javascript
lua.execute_script('config = { db = { host = "localhost" } }');
lua.get_global('config.db.host'); // 'localhost'
lua.get_global('config.db.port'); // null (leaf missing)
lua.get_global('missing.a.b');    // null (intermediate nil — no error)
```

It throws only if a non-nil intermediate is a non-indexable value (e.g.
`config.db` is a number) or if the path is malformed.

**Parameters:**

- `name`: Name of the global variable, or a dotted path to a nested field

**Returns:** The value of the global (converted to JavaScript), or `null` if not set

### `LuaContext.call(name, ...args)`

Calls a Lua function by global name.

Convenience over `get_global(name)` followed by calling the returned wrapper —
but it never mints that wrapper, so a hot call loop doesn't leave a JS function
object and its Lua registry slot behind on each iteration.

```javascript
lua.execute_script('function greet(name) return "hello " .. name end');
lua.call('greet', 'world'); // 'hello world'

lua.execute_script('handlers = { on = { tick = function(n) return n * 2 end } }');
lua.call('handlers.on.tick', 21); // 42
```

**Parameters:**

- `name`: Global name of a Lua function, or a dotted path to one
- `...args`: Arguments to pass to the function

**Returns:** The function's return value — `undefined` for no returns, the value
itself for one, an array for several

**Throws:** `TypeError` if `name` is not a string, the path is malformed, or the
target is not a Lua function (a callable table with `__call` is not accepted —
reach it through `get_global`). A Lua error propagates as a thrown JS error, with
the original `Error` preserved when the failure came from a JS callback.

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

### `LuaContext.register_from_lua_converter(match, convert)`

Registers a custom Lua→JS converter — the mirror of
`register_type_converter()`, for rebuilding application types out of the Lua
values that encode them.

```javascript
class Money {
  constructor(cents) { this.cents = cents; }
}

// Lua -> JS
lua.register_from_lua_converter(
  (v) => v?.__type === 'Money',
  (v) => new Money(v.cents),
);
// JS -> Lua (the other half of the round trip)
lua.register_type_converter(
  (v) => v instanceof Money,
  (v) => ({ __type: 'Money', cents: v.cents }),
);

lua.execute_script(`return { __type = 'Money', cents = 1299 }`); // Money { cents: 1299 }
```

Converters are consulted at every level of the conversion, so they reach values
nested inside tables and arrays, and values arriving as callback arguments — not
just top-level results.

**Parameters:**

- `match`: Predicate `(value) => boolean` called with the value the built-in
  conversion produced — a plain object for a Lua table, a Proxy for a metatabled
  one, the handle for opaque userdata. Only object-valued results are offered
  (primitives and functions are skipped), mirroring the JS→Lua direction.
  Returning truthy selects this converter.
- `convert`: `(value) => unknown` mapping a matched value to what the caller
  should see. Its return value is used **verbatim** — unlike the JS→Lua
  direction, it is not converted again, so a converter cannot loop by matching
  its own output.

Registration order decides precedence; the first match wins.

**Throws:** `TypeError` if either argument is not a function.

**Performance:** every registered `match` runs for every object-valued result
crossing Lua→JS, in registration order, until one matches. Keep `match` cheap.
Matching against a Proxy is not free either — each property read runs the Lua
`__index` path.

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

Sets a metatable on a Lua table, enabling operator overloading, custom indexing,
`__tostring`, `__call`, and other metamethods.

The target is either the name of an existing global table, or a live table
reference — a `create_table()` / `get_global_ref()` / `create_environment()`
handle, or the Proxy a metatabled table round-trips as. The table need not have a
global name:

```javascript
const defaults = lua.create_table();
lua.set_metatable(defaults, { __index: (t, k) => `<${k}>` });
defaults.get('missing'); // '<missing>'
```

The handle's own `get`/`set` go through the metatable too, so a `__newindex` that
swallows writes is visible from JS exactly as it is from Lua.

**Parameters:**

- `target`: The name of an existing global table, or a table reference
- `metatable`: Object whose keys are metamethod names (e.g. `__add`, `__tostring`)
  and values are either callback functions or static Lua values

Any metatable the table already had is replaced, matching Lua's `setmetatable`.

**Throws:** `TypeError` if `target` is neither a string nor a table reference, or
if `metatable` is not an object. An `Error` if a named global does not exist or is
not a table, or if a handle has been released or belongs to another context.

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
  - `extends` (optional): Name of a class registered earlier on this context to
    inherit from. A method missing from this class is looked up along the base
    chain, and the base's metamethods apply unless this class defines its own
  - `readable` (optional): Allow Lua to read instance properties (default:
    `false`)
  - `writable` (optional): Allow Lua to write instance properties (default:
    `false`)

**Throws:** `TypeError` if `name` is not a string, `definition` is not an
object, `definition.construct` is not a function, or `extends` is not a string.
An `Error` if `extends` names a class that is not registered on this context. A
runtime error is raised if the constructor returns a non-object.

**Note on inheritance:** each class supplies its own `construct` — the JS class
hierarchy already decides how an instance is built, and `extends` only describes
how Lua resolves names on it. `readable` / `writable` are per-instance flags set
by the constructor, so they are not inherited either; state them on each class
that needs them.

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

### `LuaContext.create_coroutine(body)`

Creates a coroutine from a Lua script that returns a function, or from a Lua
function you already hold.

```javascript
// From a script
const a = lua.create_coroutine('return function() coroutine.yield(1) end');

// From a function this context produced
const fn = lua.get_global('producer');
const b = lua.create_coroutine(fn);
```

**Parameters:**

- `body`: A string of Lua code that returns a function to be used as the
  coroutine body, or a `LuaFunction` this context produced (from
  `execute_script`, `get_global`, a callback argument, …)

**Returns:** `LuaCoroutine` object with a `status` property (`'suspended'`,
`'running'`, or `'dead'`). It is also iterable — see
[`LuaCoroutine`](#luacoroutine).

**Throws:** `TypeError` if `body` is neither a string nor a Lua function, if a
script does not return a function, or if a plain JavaScript function is passed (a
coroutine body has to be a Lua function). An `Error` if the function has been
released or belongs to another context.

### `LuaCoroutine`

A coroutine object is iterable: each `yield` is one iteration step, so `for..of`
drives it to completion without a hand-written `resume()` loop.

```javascript
const co = lua.create_coroutine(`
  return function()
    for i = 1, 3 do coroutine.yield(i) end
  end
`);

for (const n of co) console.log(n); // 1, 2, 3
```

- A yield of several values arrives as an array, matching the rest of the API.
- The coroutine's final `return` value arrives with `done: true`, which `for..of`
  discards — the same contract as a JS generator.
- Iteration and `resume()` advance the **same** Lua thread. A loop that exits
  early leaves the coroutine suspended where it stopped, and a later loop (or
  `resume()`) picks up from there.
- An already-dead coroutine iterates empty rather than raising "cannot resume
  dead coroutine".
- `next(...args)` forwards its arguments as the resume values, so a
  generator-style coroutine can be fed from JS.
- `for await (const v of co)` also works, and steps through `resume_async()`, so
  a coroutine whose host functions return Promises can be iterated this way.

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

### `LuaContext.resume_async(coroutine, ...args)`

Resumes a coroutine **asynchronously**, so host functions it calls may return
Promises. A drop-in for `resume()`: the resolved value is the same
`CoroutineResult`, **including for a Lua error**, which is reported in the result
rather than thrown.

**Parameters:**

- `coroutine`: The `LuaCoroutine` object to resume
- `...args`: Arguments to pass to the coroutine

```javascript
const step = await lua.resume_async(co, 7);
// step.status === 'suspended', step.values === ['Ada']
```

Under `resume()` the coroutine runs synchronously, so a callback returning a
Promise inside it hard-errors. Under `resume_async` the coroutine *is* the driven
thread, so such a call suspends it until the Promise settles. A coroutine created
*inside* it still cannot await, and says so.

`cancel()` abandons the run and rejects the Promise, and — because the coroutine
is yours, not the binding's — leaves it **suspended and resumable** at the point
it reached.

**Returns:** `Promise<CoroutineResult>`

**Throws:** Error if the context is busy with another async operation.

### `LuaContext.close(coroutine)`

Closes a coroutine: runs its pending to-be-closed variables
(`local x <close> = …`) and marks the thread dead. Mirrors Lua's own
`coroutine.close`.

**This is the only way to run those handlers from JavaScript.** `release()` frees
the registry slot without executing anything, and garbage collection runs `__gc`
but not `__close`. Because breaking out of a `for..of` loop deliberately leaves
the coroutine suspended, an unclosed thread is an ordinary outcome of the
documented API rather than an edge case.

**Parameters:**

- `coroutine`: The `LuaCoroutine` object to close

```javascript
for (const n of co) {
  if (n === 3) break; // suspended, the <close> guard still open
}
lua.close(co); // __close runs now
```

Idempotent — closing an already-closed, finished, or released coroutine succeeds
and does nothing, which is what lets you close defensively.

**Returns:** `void`

**Throws:** If a `__close` handler raises. The thread is dead either way, since a
failed close still closed everything it reached.

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

### `LuaContext.create_environment(options?)`

Creates an environment table — a private global namespace for scripts run with
`execute_script_in()`. Returns an ordinary table handle, so the environment can
be seeded, inspected, and released like any other table reference.

**Parameters:**

- `options` (optional):
  - `whitelist`: Global names to seed the environment with, copied from `_G` by
    value (e.g. `['math', 'print']`). A name unset in `_G` is skipped. Default:
    none — an empty environment.
  - `inherit`: Fall back to the real globals for names the environment doesn't
    define, via an `__index` metatable pointing at `_G`. Reads fall through;
    writes never do. Default: `false`.

**Returns:** `LuaEnvironment` (a `LuaTableHandle`) — a live reference to the
environment table

**Note:** This restricts the global namespace, not the VM. Use `maxMemory` /
`maxInstructions` for resource limits. Whitelisting `'_G'` defeats the
isolation.

### `LuaContext.execute_script_in(env, script)`

Executes a script with `env` installed as its `_ENV`, so the script's global
reads and writes resolve against that table instead of `_G`. Globals the script
assigns land in `env`, leaving the context's real globals untouched — even with
`inherit: true`.

**Parameters:**

- `env`: The environment to run against. Any table reference from this context
  works: an environment from `create_environment()`, a handle from
  `create_table()` / `get_global_ref()`, or a metatabled-table Proxy.
- `script`: The Lua script to execute

**Returns:** The result of the script execution (same marshalling as
`execute_script`: `undefined` for no results, the value for one, an array for
many)

**Throws:** Error if the script fails, or if `env` is not a live table
reference from this context

### `LuaContext.release(value)`

Releases the Lua registry reference held by a value that crossed the boundary: a
Lua function returned to JS, a coroutine, or a table reference (a
`LuaTableHandle` or a metatabled-table Proxy). Without an explicit release, the
reference occupies its registry slot until the JS wrapper is garbage-collected;
releasing lets Lua's GC reclaim the referent on its next cycle. Equivalent to
`handle.release()` for table handles.

After release, using the wrapper throws a clear error (`"Lua function has been
released"`, `"coroutine has been released"`, `"table handle has been
released"`). Releasing the same value again is a safe no-op.

```javascript
const fn = lua.execute_script('return function(x) return x * 2 end');
fn(21); // 42
lua.release(fn); // registry slot freed
fn(21); // throws: Lua function has been released
```

**Parameters:**

- `value`: The Lua function, coroutine, or table reference to release

**Throws:** `TypeError` if the value holds no Lua reference; Error if the value
belongs to a different Lua context

### `LuaContext.dispose()`

Ends the context: closes its Lua state now rather than at some later garbage
collection.

Afterwards every method on the context refuses, and every outstanding handle
refuses too. Idempotent. Refused while the state is held — during execution,
from inside a host callback, or with an async run in flight.

```javascript
const lua = new lua_native.init({}, { libraries: "sandbox" });
try {
  lua.execute_script(untrusted);
} finally {
  lua.dispose();
}
```

Dropping the last reference to a context does **not** end it — V8 decides when,
and a single outstanding handle pins the whole state
([LIMITATIONS.md](docs/LIMITATIONS.md) §10). `dispose()` is the verb for "I am
done with this". It is not `close()`, which belongs to coroutines.

### `LuaContext.reset()`

Discards the Lua state and replaces it with a fresh one carrying the same
options, without creating a new context. Intended for long-lived server
processes that run many independent scripts and would otherwise accumulate
global state (and memory) indefinitely.

```javascript
const lua = new lua_native.init({ log: console.log }, { libraries: 'safe' });

lua.execute_script('x = expensive_computation()');
lua.reset();

lua.execute_script('return x'); // null — the state was reset
lua.execute_script('log("hi")'); // callbacks still work
```

**Replayed automatically:** the callbacks object passed to `init()`, the print
handler, the debug hook, the `allowBytecode` guard, every path added with
`add_search_path`, every searcher added with `add_searcher`, the globals
published from any `shared` table, and the constructor options (`libraries`,
`maxMemory`, `maxInstructions`, `timeout`). Registered type converters are pure
JavaScript-side policy and are unaffected.

**Not replayed** — these bind to Lua-side objects that die with the old state
and must be re-applied after a reset: `set_global`, `set_userdata`,
`set_metatable`, `register_module`, and `register_class`.

Values that previously crossed into JavaScript (Lua functions, coroutines, table
references, opaque userdata) belong to the old state and are invalidated: using
one afterwards throws rather than reaching into the new state. The old state is
kept alive until the last such wrapper is garbage-collected, so `release()` them
first if you need its memory reclaimed immediately.

**Throws:** Error if an async operation is in flight (`is_busy()`), or if called
while Lua is executing — from inside a host callback, metamethod, table trap,
debug hook, or `__gc` finalizer (including one reached from `gc('collect')`) —
since the state being retired is the one those frames are running on. A
re-entrant `reset()` from a finalizer of the state already being retired throws
for the same reason

### `LuaTableHandle`

A handle to a Lua table stored in the Lua registry. Provides direct get/set/iterate
access. The handle holds a live reference — mutations from JS are visible in Lua
and vice versa. Call `release()` when done to free the registry slot.

**Methods:**

- `get(key: string | number): LuaValue` — Get a field by key. Triggers `__index` if the table has a metatable.
- `get_ref(key: string | number): LuaTableHandle` — Get a nested table field as a **live handle** instead of the deep copy `get()` returns for a metatable-less table. Composes to any depth (`a.get_ref('b').get_ref('c')`). Triggers `__index`. Throws if the field is not a table (including nil). The returned handle is independent — it survives its parent's `release()` and needs its own.
- `set(key: string | number, value: LuaValue): void` — Set a field by key. Triggers `__newindex` if the table has a metatable.
- `has(key: string | number): boolean` — Check if a key exists in the table.
- `length(): number` — Get the table length (`#` operator). Triggers `__len` metamethod.
- `pairs(): Array<[string | number | boolean | Uint8Array, LuaValue]>` — Every entry at once. String, number and boolean keys (`Uint8Array` under `binaryStrings`); table/function/userdata keys are skipped, since no accessor here can address them.
- `keys(): Array<string | number | boolean | Uint8Array>` — The keys alone, converting no values.
- `[Symbol.iterator]()` — Lazy iteration: `for (const [k, v] of handle)`. Same entries as `pairs()`, but each value is converted as it is reached. The key set is snapshotted when iteration begins and reads are raw; see [TABLE-REFERENCE.md](docs/TABLE-REFERENCE.md) for what that means when the table is mutated mid-loop.
- `ipairs(): Array<[number, LuaValue]>` — Get integer-keyed sequence entries (like Lua `ipairs()`). Iterates from index 1 until the first nil.
- `release(): void` — Release the registry reference. After calling `release()`, all other methods throw. Safe to call multiple times.

### `LuaEnvironment`

An environment table returned by `create_environment()` — a private global
namespace for scripts run with `execute_script_in()`. It is a `LuaTableHandle`,
so the full handle surface applies: `get`/`set` to seed helpers or read back
what a script defined, `pairs()` to inspect it, `release()` when done.

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
| `function`            | `Function`      | Bidirectional: JS→Lua and Lua→JS, including functions nested inside objects/arrays                            |
| `thread`              | `LuaCoroutine`  | Created via `create_coroutine()`                                                                              |
| `userdata`            | `Object`        | JS-created via `set_userdata()`, returned by reference. Lua-created userdata passes through as opaque handles |

For the reverse direction — how JavaScript built-in types (`BigInt`, `Date`,
`Map`, `Set`, `Buffer`/`TypedArray`, `RegExp`) convert into Lua — see
[JavaScript Type Conversion](#javascript-type-conversion).

## Limitations

- **Nesting depth limit** — Nested data structures (tables, arrays, objects) are limited to 100 levels deep. Exceeding this limit throws an error.
- **`set_metatable()` needs a name or a handle** — the target is either a global name or a live table reference (`create_table()`, `get_global_ref()`, `create_environment()`, `get_ref()`, or a metatabled-table Proxy). Nested tables are reachable via `get_ref()`, which composes to any depth. What remains out of reach is a table you can't name or navigate to at all — a Lua local, or one only ever held in a local variable — for which `setmetatable()` in Lua is the answer.
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

10 August 2026
