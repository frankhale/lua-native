# The WASM target

lua-native ships two targets with one API.

| Target | Loaded by | Built from |
|---|---|---|
| Native addon | Node, through `index.js` | `src/lua-native.{h,cpp}` on N-API |
| WASM module | a browser, through `browser.js` | `src/wasm/` on Embind, with no N-API |

Both compile the same core (`src/core/`) against the same Lua 5.5. The API is
`types.d.ts` for both, and a program written against it runs on either with
the differences listed under [The permitted differences](#the-permitted-differences)
and no others.

This document is the current reference: how to load it, how to build it, how
the two bindings are kept the same, and what is known about browsers. The
record of how it was built, with its decisions and measurements, is
[`reviews/WASM-TARGET-PLAN.md`](reviews/WASM-TARGET-PLAN.md).

---

## Using it in a page

```js
import lua_native from 'lua-native';

const lua = new lua_native.init({ print: console.log }, { libraries: 'safe' });
lua.execute_script('print(6 * 7)');
```

It is the same line as under Node. `package.json`'s `exports` map resolves
`lua-native` to `browser.js` under the `browser` condition, which bundlers set
for a browser build, and to `index.js` otherwise. `browser.js` instantiates the
module with a top-level `await`, so the object is ready when the import
settles.

**With a bundler.** `vite build` needs no configuration: it emits the `.wasm`
as an asset and rewrites the reference. A bundler that leaves
`new URL('lua-native-core.wasm', import.meta.url)` as written (rolldown on its
own does) produces a working bundle once that file is served beside it.

**Without one.** Import `node_modules/lua-native/browser.js` by URL, or map the
bare name to it with an import map. The three files it needs are in
`build-wasm/release/web/` inside the package and find each other by relative
URL. Serve the `.wasm` as `application/wasm`.

**No cross-origin isolation is needed.** The module uses no threads and no
`SharedArrayBuffer`. The smoke server sends no isolation headers, on purpose.

**Types.** `browser.d.ts` is `types.d.ts` with bytecode restated as a
`Uint8Array`. `types.d.ts` references Node's ambient types for `Buffer`, and
`@types/node` is an optional peer dependency, so a browser project without it
needs `skipLibCheck`.

### Keep the VM off the page's thread

On this target a running script holds the thread it was started on. A long
`execute_script` on the main thread freezes the page until it ends or its
`timeout` does.

`execute_script_async` and `execute_file_async` **share** the thread where the
engine can suspend WebAssembly: every eight milliseconds the run gives the
event loop a turn, so timers fire, the page responds, and `cancel()` reaches
the run — as natively, only if a `timeout`, `maxInstructions` or a counting
hook is set. Chromium and Safari 27 can. Where the engine cannot, they run in a
later task and hold the thread to their end. Three things to know:

- They share the thread and do not add one. Nothing runs in parallel, and the
  run takes longer the busier the thread is. `timeout` counts that time.
- Suspending is asked about in Lua's instruction-count hook, which is installed
  for the length of the run. A tight arithmetic loop took about twice as long
  with it as without (the same hook `timeout` installs).
- One long call into C (`string.rep` of something enormous) is not divided.

For anything heavier, the answer is a Web Worker. Import `lua-native` inside a
module worker and talk to it with messages; the smoke page does exactly this.

**A worker has less stack than a page, and in Safari much less.** See
[The engine's stack](#the-engines-stack) before putting deeply recursive Lua
in one.

### Files

A page has no disk. `execute_file`, `compile_file`, `dofile` and `require` see
Emscripten's in-memory filesystem, which starts empty apart from a few
directories and is gone when the page is. Lua can write a file there and run
it. The supported way to give Lua source files is the one that already
existed: `set_file_reader` for `dofile` and `loadfile`, `add_searcher` or
`register_module` for `require`, and `filesystem: 'deny'` to close the
in-memory filesystem off.

---

## The permitted differences

`types.d.ts` is the contract and the suite is its test. These are the ways the
WASM target is allowed to answer differently, and the list is **closed**: a
difference that is not a row here is a defect, or a decision the owner has not
made yet.

| Difference | Why it cannot be removed |
|---|---|
| Bytecode is a `Uint8Array`, not a `Buffer` | Browsers have no `Buffer`. `compile()` and `compile_file()` return a plain `Uint8Array`; `load_bytecode()` takes any `Uint8Array`. |
| The two off-thread doors do not leave the calling thread | No thread without cross-origin isolation. `execute_script_async` and `execute_file_async` keep their signatures and run in a later task, sharing the thread a few milliseconds at a time where the engine has JavaScript Promise Integration and holding it to their end where it does not. |
| Files are virtual: `execute_file`, `compile_file` and `require` see an in-memory filesystem and `set_file_reader`, not a disk | A page has no disk. |
| `os` and `io` behave as Emscripten implements them | No process, no environment. `os.execute()` reports no shell and `io.popen` raises. |
| Finalizers run in a later task than a GC | `FinalizationRegistry` semantics. |
| A thread with a small engine stack refuses nested calls before Lua's limit of 200 | Lua's C calls are on the engine's stack, whose size the engine chooses. The refusal is the ordinary "C stack overflow" (or the engine's own RangeError, for a callback chain), and the context carries on. |
| `String(fn)` of a function the binding hands out is `[native code]` without the function's name | The text is the engine's own. A module can make a function whose source is hidden, or one whose name shows, and not both. V8 leaves the name out; JavaScriptCore writes `ProxyObject`. |

**This table is read by a program.** `tools/wasm-ledger.mjs` parses the rows
out of this file, and an entry in the ledger's *target semantics* class must
cite one by its exact text. A ledger cannot add a row; the owner does, here.
Rewording a row means updating the entries that cite it, and
`npm run verify-wasm` says which.

The first five were decided when the target was planned. The last two were
found during the port and ruled on by the owner on November 25, 2026; the one
about the engine's stack then said that running out ended the context, which is
fixed. Four
differences found the same way were later removed instead, on the same day:

- **The key order of a converted table.** The core holds it in an ordered map,
  so keys arrive in byte order on both targets. (JavaScript still puts
  integer-like keys first.)
- **No own `arguments` or `caller`** on a function the binding hands out. They
  are defined by hand.
- **The `stack` of an error the binding constructs** beginning in the binding.
  It begins at the JavaScript that called in, where the engine has
  `Error.captureStackTrace`. In an engine without it the stack is the one the
  engine made.
- **A forged promise taken for a real one**, and a promise made in another
  realm (an iframe's) not taken for one. The engine's own test is asked. One
  thing is not asked it: a promise whose prototype has been replaced with
  `Object.prototype` or `Array.prototype`, which converts as what it looks like.

A fifth, the three limits being 32 bits wide here, was ruled a defect; they
are 64 bits on both targets.

---

## The engine's stack

The module's own stack is fixed at 1 MiB and is the same everywhere. The
JavaScript engine's stack is not, and nothing inside the module can catch it
running out. So the module asks before it needs the room:

- **Before every call into the module**, the shell makes a call with as many
  arguments as the margin is wide. If the engine refuses, the caller gets the
  `RangeError` it was about to get anyway, before anything has started.
- **Every eight nested C calls**, Lua asks the same question through its own
  limit (`triplets/lua-wasm-stack.h`, `src/wasm/stack.cpp`). The answer no is
  Lua's ordinary "C stack overflow".
- **Every four levels of a converted value**, the conversions ask.

`pcall` sees any of these, and the context carries on.

The margin is 32 Lua C levels, measured once when the module loads because a
frame is several times larger in one engine than in another, and never less
than 64 KB: V8 compiles a function the first time it runs, on the caller's
stack, and that is where a 40 KB margin lost contexts.

**It costs about 2 microseconds a call into the module** (Node 24, arm64),
whatever the call does. A call from Lua out to JavaScript does not pay it.

What each thread allows:

| Thread | Deepest chain of Lua C calls | JavaScript and Lua calling each other |
|---|---|---|
| Chromium 156, main | Lua's own limit (198) | Lua's own limit (198) |
| Chromium 156, worker | Lua's own limit (198) | refused at 116 |
| Safari 27.2, main | Lua's own limit (198) | Lua's own limit (198) |
| Safari 27.2, worker | refused at 87 | refused at about 22 |

Measured on November 25, 2026 with the smoke set. In every row the context
works afterwards. Before the check, the two worker rows read 132, 102 and 27,
and each of those ended the context.

A "chain of Lua C calls" is Lua re-entering itself through C: a `string.gsub`
callback that calls `string.gsub`, nested `pcall`, a metamethod that triggers
a metamethod. Lua stops such a chain at 200 by itself.

**A margin is not a proof.** If the engine's stack runs out inside the module
regardless, the older guard still holds: the caller gets an `Error`, never a
raw `WebAssembly.Exception`, and the context either works or refuses every
later call with a message that says why. `tools/wasm-build/check.mjs` runs
that with the question switched off.

A deferred run that is suspended has frames on a stack of its own in some
engines (V8 gives it 984 KB), and the question is answered for the page's
stack and not for that one. Lua's own limit of 200 is what applies there, and
in V8 it fits: `check.mjs` reaches it inside such a run. Safari reaches it or
refuses sooner. No other engine was measured.

---

## Building it

```bash
brew install emscripten          # 7.0.1; the build refuses any other version
npm run vcpkg-lua-wasm           # Lua for wasm32-emscripten, via the overlay triplet
npm run build-wasm-debug         # build-wasm/debug/{node,web}/
npm run build-wasm-release       # build-wasm/release/{node,web}/
```

`tools/wasm-build/run.mjs` compiles the core and `src/wasm/` with `em++` and
links two variants from the same objects:

- **web** — in-memory filesystem, `-sENVIRONMENT=web,worker`. The one that
  ships, from `build-wasm/release/web/`.
- **node** — the real filesystem, `-sENVIRONMENT=node`. Not published. It
  exists so that the suite and the instruments can run against this binding
  under Node.

Every object, Lua's included, is built with WASM-native exceptions and
WASM-native `longjmp`. **Install Lua with `npm run vcpkg-lua-wasm`, not
`vcpkg install lua:wasm32-emscripten`**: vcpkg's stock triplet builds a
library tied to the other exception mode, in which Lua's `longjmp` through a
C++ frame does not behave. The build reads which runtime the library
references and refuses the stock one before linking.
`triplets/wasm32-emscripten.cmake` has the reasoning.

The output is in `build-wasm/` and not `build/` because `node-gyp rebuild`
deletes `build/`. Like `prebuilds/`, it is gitignored: the three web files are
built locally and published, never committed.

Sizes of what ships, release build of November 25, 2026:

| File | Bytes | gzip -9 |
|---|---|---|
| `lua-native-core.wasm` | 748,604 | 250,969 |
| `lua-native-core.mjs` | 99,992 | 26,132 |
| `lua-native.mjs` | 53,784 | 17,136 |

The glue contains no `eval` and no `new Function`.

---

## Two bindings, one API

The WASM binding is a second implementation, not a recompilation: C++ against
Embind's `emscripten::val` in `src/wasm/lua-wasm.{h,cpp}` and `js.{h,cpp}`,
with `stack.{h,cpp}` and `suspend.{h,cpp}` for what only this target needs,
plus a JavaScript shell, `src/wasm/shell.js`, for what has to be JavaScript.
It is a port that kept the native names, function for function, and each
function says which native one it is.

**The rule: a change to one binding is a change to both.** A fix, a guard, a
new option, a reworded error. Nothing shares code between them, by decision,
so nothing carries a change across but the person making it. What makes
forgetting visible:

| What drifts | What notices |
|---|---|
| A method, an option, a handle method or an export exists in one binding only | `binding-parity`, in `npm run check-invariants` and so in the suite |
| A helper function is added to one binding's C++ | the same census: a new "function only in…" row in the diff |
| A behaviour differs — a value, an error message, a refusal | `npm run verify-wasm`: the suite on this target, judged against the ledger |
| An operation's occupancy policy changes on one side | `wasm:occupancy-policy-sites`, which requires the two sets equal |
| A core call loses its `try`, a `CallScope` moves, a receiver check goes | the `wasm:` invariants, each the native analysis over this binding |

Nothing notices between runs, and nothing runs by itself.

### What verifies it

- **`npm run verify-wasm`** — the suite against the node variant, judged by
  `tools/wasm-ledger.mjs`. A test that does not pass and is not ledgered is
  red; a ledgered test that passes is STALE. Add `--harnesses` for all ten
  instruments and `--closing` to fail on anything not yet ruled on. Every
  process that loads the module first observes which binding it got and
  refuses to go on if that is not the one asked for.
- **`npm run check-invariants`** — the source invariants. Those that read a
  binding are asked of this one under ids beginning `wasm:`, and
  `binding-parity` compares the two.
- **`npm run lint`** — clang-tidy over both bindings with the one
  configuration.
- **`npm run smoke-wasm`** — the only thing that executes the build that
  ships. See below.
- **`npm run check-package`** — packs the tree and resolves the tarball as a
  consumer would, under Node and under a browser condition.

The four sanitizer harnesses instrument the native target only.

`tools/README.md` has the conventions these follow and the reason for each.

---

## The browser run

Node cannot load the web variant, so the build that ships is run in a browser
with a fixed smoke set: 27 cells, each one thing a page does with lua-native.

```bash
npm run smoke-wasm                          # http://localhost:8377/
node --expose-gc tools/wasm-smoke/run.mjs   # the same set under Node, as a check on the set
```

The page imports `/browser.js`, runs the set on its main thread and again in a
module worker, and posts both results to the server, which prints a line per
report and keeps each in `build-wasm/smoke/`.

**Recorded run: November 25, 2026, macOS 27.2.1 on arm64.**

| Engine | Main thread | Web Worker |
|---|---|---|
| Chromium 156.0.8078.100 (V8), the Claude desktop app's browser pane | 27 of 27 | 27 of 27 |
| Safari 27.2 (WebKit, JavaScriptCore) | 27 of 27 | 27 of 27 |

No cell failed and none was inconclusive, on the build whose sizes are above.
An earlier run the same day failed two cells in the Safari worker, where
message tasks starved the timers a deferred run should have let fire; the fix
is in `nextTurn` in `shell.js`. **Gecko was not run**; Firefox was not on the
machine. The run was driven from a tool session, and the results are what each
page posted back.

What it established that a run under Node could not:

- Both engines accept the module's exception-handling instructions.
- `timeout` ends a busy loop on a page's main thread, in a worker, and through
  a deferred door.
- A deferred door's run lets timers fire as it goes, and `cancel()` from one
  ends it.
- A file Lua writes to the in-memory filesystem can be run; a missing path is
  refused; `set_file_reader` serves `dofile` with the filesystem denied.
- `os.getenv("HOME")` is `/home/web_user`, `os.execute()` reports no shell,
  `os.execute("exit 3")` fails, and `io.popen` raises: each works or says no.
- A dropped table reference is collected without a `gc()`.
- The stack figures in the table above.

Re-run it before a release, and after any change to `src/wasm/shell.js` or the
link flags. Update this section with the date and the versions when you do.

---

## Not part of this target

- **N-API in the browser**, real or emulated.
- **Threads.** A build with `-pthread`, a pool and cross-origin isolation
  would let the two deferred doors leave the page's thread. It is a separate
  decision and nothing here depends on it.
- **The WASM module as a product under Node.** Node consumers get the native
  addon; the node variant exists to verify the binding.
- **WASI**, non-browser WASM hosts, and 64-bit WASM memory.
- **Preloading files** into the in-memory filesystem.

## Open with the owner

- **State the whole module shares.** If the engine's stack runs out inside the
  module's allocator, the damage is not confined to one context and nothing
  can tell. The choices are to accept that, as this paragraph now documents
  it, or to refuse every context after any such event and give the caller a
  way to start a fresh module instance, which is new API.
- **`DataView`.** Refused as a value, as bytecode and as a read handler's
  result on both targets, with "Invalid argument" natively. Whether that is
  intended is undecided; the two targets agree, so it is not a difference.
