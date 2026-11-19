# lua-native in Electron

A small Electron app that runs Lua through
[lua-native](https://www.npmjs.com/package/lua-native), two ways: with Lua in
the **main process**, reached over IPC, and with Lua inside a **renderer
process**, called directly.

## Run it

```bash
npm install
npm start
```

Electron downloads its own binary the first time it starts, so the first launch
takes longer than the rest. The app opens on the main-process demo; its
**Canvas demo** button opens the renderer-process one.

## The two demos

|                         | Main-process demo                      | Renderer-process demo                        |
| ----------------------- | -------------------------------------- | -------------------------------------------- |
| Where Lua runs          | Electron's main process                | The window's own renderer process            |
| How the page reaches it | IPC, through a sandboxed preload       | Direct calls, through an unsandboxed preload |
| Window settings         | Electron's defaults                    | `sandbox: false`                             |
| A call from Lua to JS   | Runs in the main process               | Runs in the page's process, synchronously    |
| A runaway script        | Freezes the whole app until it ends    | Freezes that one window until it ends        |
| Lua state lives as long as | The app                             | The page; a reload starts a fresh one        |
| Good for                | Scripting the app: files, windows, menus | Per-frame work: drawing, simulation, UI logic |

In both, the page itself has no Node and no `require`. Only the preload differs.

## Files

| File                           | Process  | What it does                                                 |
| ------------------------------ | -------- | ------------------------------------------------------------ |
| `main.mjs`                     | main     | Opens both windows; owns the Lua context for the first demo  |
| `main-process/preload.cjs`     | preload  | Sandboxed. Exposes `window.lua`, which forwards over IPC     |
| `main-process/page.js`         | renderer | Editor and output pane                                       |
| `renderer-process/preload.cjs` | preload  | Unsandboxed. Loads lua-native, owns the canvas and the frame loop |
| `renderer-process/page.js`     | renderer | Editor and buttons; calls `window.canvasDemo`                |
| `styles.css`                   | —        | Shared by both windows                                       |

## Main-process demo

Type Lua, press **Run**, and what it prints and returns appears below. The
window is sandboxed, so it cannot load a native addon: it sends source text
over IPC and receives plain data back.

Every run is asynchronous. The **Run on** menu picks one of lua-native's two
async doors, and they trade off against each other:

|                                   | Main thread (`execute_async`)      | Worker thread (`execute_script_async`) |
| --------------------------------- | ---------------------------------- | -------------------------------------- |
| Host functions (`set_title`)      | Work                               | Raise a Lua error                      |
| Promise-returning ones (`sleep`)  | Awaited; the app stays responsive  | Raise a Lua error                      |
| `print`                           | Streamed to the output pane        | Goes to the terminal                   |
| A CPU-bound loop                  | Blocks the app until it ends       | The app stays responsive               |
| **Stop** (`cancel()`)             | Only while awaiting a Promise      | Any time, mid-loop                     |

Use the main thread when a script needs to talk to the app, and a worker when
it only needs to compute. Globals are shared between the two, because both run
in the same Lua context; only one run can be in flight at a time.

It also shows:

- **Values into Lua.** `host` is a JavaScript object that Lua reads as a table.
- **Calls out of Lua.** `set_title` is a JavaScript function; calling it from
  Lua renames the window.
- **Values out of Lua.** The table a script returns arrives in JavaScript as an
  object.
- **Captured output.** `print` is redirected with `set_print_handler` and sent
  to the page as it happens.
- **Persistent state.** Globals survive between runs. **Reset state** calls
  `reset()`, which swaps in a fresh Lua state and keeps the callbacks.
- **Limits.** `libraries: 'sandbox'`, a 32 MB memory cap and a 5 second
  timeout, so `while true do end` ends in an error. The timeout counts Lua
  compute only; time spent waiting in `sleep` is free.

## Renderer-process demo

A canvas animated by Lua. The script defines `draw(t)`, the preload calls it
once per animation frame, and each `clear`, `rect`, `circle`, `line` and `text`
is a JavaScript function that draws straight onto the canvas. The status line
shows the frame rate, the Lua time per frame and the number of host calls per
frame. The sample makes 162 calls a frame, or 322 with the pointer over the
canvas.

That many crossings per frame is the point: over IPC each one would be an
asynchronous message to another process. Here each is an ordinary function
call.

How it is put together:

- **The window sets `sandbox: false`.** That gives the preload Node, which is
  what lets it `require('lua-native')`. `contextIsolation` stays on and
  `nodeIntegration` stays off.
- **The preload does the privileged work.** It owns the Lua context, the canvas
  context and the frame loop, so the hot path (Lua → JavaScript → canvas) never
  leaves it.
- **The page gets a narrow API.** `window.canvasDemo` has `run`, `setPaused`
  and three listeners. The page cannot reach lua-native or Node.
- **Each call into Lua has a 250 ms timeout.** A `draw` that never returns
  stops with an error instead of hanging the window.
- **Run starts from a fresh state.** It calls `reset()` first, so a `draw` left
  over from the previous script cannot keep running.

Two things to know before copying it:

- **Keep handle-based code in the preload.** Plain values, JavaScript callbacks
  and Lua functions cross `contextBridge`. A metatabled table does not (it
  arrives as a Proxy, and the bridge refuses with "An object could not be
  cloned"), so code that uses table handles or userdata belongs on the preload
  side.
- **Only unsandbox windows that load your own files.** An unsandboxed preload
  is the usual way to use a native addon in a renderer, but it is a real
  reduction in isolation for that window.

`nodeIntegration: true` with `contextIsolation: false` also works, and lets
page code use the whole lua-native API directly. It also gives every script in
the page full Node access, which is why this demo does not do it.

## Notes

- **No rebuild step.** lua-native ships N-API prebuilds, which load in Electron
  as they are, in the main process and in a renderer. `electron-rebuild` is not
  needed.
- **Supported platforms** are the ones lua-native ships binaries for: macOS
  arm64 and Windows x64.
- **Packaging.** If you bundle the app into an asar archive, keep lua-native's
  `.node` file outside it (`asarUnpack` in electron-builder).
- **`await app.whenReady()` at the top level of `main.mjs` hangs.** Electron
  waits for an ES module entry point to finish loading before it fires `ready`,
  so that await never resolves. Use `.then()`, as `main.mjs` does.
