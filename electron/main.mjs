// Main process. It opens three windows. The first two are one per way of
// using lua-native, and the third builds something on the second way:
//
//   main-process/      Lua lives HERE, in the main process. The window is
//                      sandboxed, so it sends source text over IPC and gets
//                      back what the script returned.
//   renderer-process/  Lua lives in that window's own renderer process, loaded
//                      by an unsandboxed preload. Nothing in this file touches
//                      it beyond creating the window.
//   rpg/               A small game, also in a renderer process. The game is
//                      Lua files; the window loads them the same way.

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { inspect } from 'node:util';
import lua_native from 'lua-native';

const here = import.meta.dirname;

let ipcWindow = null;
let canvasWindow = null;
let rpgWindow = null;

// The first argument is what Lua can see: plain values become Lua values, and
// functions become Lua functions that call back into this process.
const lua = new lua_native.init(
  {
    host: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: `${process.platform}-${process.arch}`,
    },
    set_title: (text) => {
      ipcWindow?.setTitle(String(text));
    },
    // Returns a Promise. Under execute_async the script suspends here and the
    // app carries on; Lua just sees a function that takes a while.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0)),
  },
  {
    // The editor runs whatever is typed into it, so no io, os or require.
    libraries: 'sandbox',
    maxMemory: 32 * 1024 * 1024,
    // Wall-clock budget for Lua compute; time spent awaiting a Promise is not
    // counted. Setting it is also what lets cancel() interrupt a worker run.
    timeout: 5000,
  },
);

// print() and io.write() would go to the terminal; forward them to the page.
// This handler is JavaScript, so it only runs for main-thread execution.
lua.set_print_handler((text) => {
  ipcWindow?.webContents.send('lua:output', text);
});

// Both doors return a Promise, and neither is the synchronous execute_script:
//
//   execute_async         main thread, as a coroutine. Host functions work and
//                         a Promise-returning one is awaited. A CPU-bound loop
//                         still blocks this process until it ends.
//   execute_script_async  worker thread. Nothing here is blocked, but the
//                         script cannot call JavaScript, so set_title and
//                         sleep fail and print goes to the real stdout.
const doors = {
  main: (source, options) => lua.execute_async(source, options),
  worker: (source, options) => lua.execute_script_async(source, options),
};

ipcMain.handle('lua:run', async (_event, source, mode) => {
  if (typeof source !== 'string') {
    throw new TypeError('source must be a string');
  }
  if (!Object.hasOwn(doors, mode)) {
    throw new TypeError(`unknown mode: ${mode}`);
  }

  const reply = { ok: true, result: null, error: null, ms: 0, memory: 0 };
  const started = performance.now();

  try {
    // '=editor' makes an error read "editor:3: ..." instead of quoting the
    // first line of the script.
    const result = await doors[mode](source, { chunkName: '=editor' });
    if (result !== undefined) {
      // A result can hold things IPC cannot clone (a Lua function, say), so
      // it crosses as text.
      reply.result = inspect(result, { depth: 6 });
    }
  } catch (error) {
    reply.ok = false;
    reply.error = error.message;
  }

  reply.ms = performance.now() - started;
  reply.memory = lua.get_memory_usage();
  return reply;
});

// Rejects the pending run with "execution cancelled". A worker run stops
// mid-loop. A main-thread run can only be stopped while it awaits a Promise:
// during a CPU-bound loop this process is busy and never gets here.
ipcMain.handle('lua:stop', () => {
  lua.cancel();
});

// Globals persist from one run to the next, like a REPL. reset() swaps in a
// fresh Lua state with the same options and the same callbacks.
ipcMain.handle('lua:reset', () => {
  lua.reset();
  return { memory: lua.get_memory_usage() };
});

ipcMain.handle('demo:open-canvas', () => {
  openCanvasWindow();
});

ipcMain.handle('demo:open-rpg', () => {
  openRpgWindow();
});

function openIpcWindow() {
  ipcWindow = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 720,
    minHeight: 360,
    title: 'lua-native + Electron',
    webPreferences: {
      // Sandboxed and context-isolated: Electron's defaults.
      preload: path.join(here, 'main-process', 'preload.cjs'),
    },
  });
  ipcWindow.on('closed', () => {
    ipcWindow = null;
  });
  ipcWindow.loadFile(path.join(here, 'main-process', 'index.html'));
}

function openCanvasWindow() {
  if (canvasWindow) {
    canvasWindow.focus();
    return;
  }
  canvasWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 720,
    minHeight: 360,
    title: 'lua-native in the renderer',
    webPreferences: {
      preload: path.join(here, 'renderer-process', 'preload.cjs'),
      // The one departure from the defaults: without the sandbox the preload
      // has Node, which is what lets it load lua-native. contextIsolation
      // stays on and nodeIntegration stays off, so the page itself still has
      // no Node. Only do this for content you ship with the app.
      sandbox: false,
    },
  });
  canvasWindow.on('closed', () => {
    canvasWindow = null;
  });
  canvasWindow.loadFile(path.join(here, 'renderer-process', 'index.html'));
}

function openRpgWindow() {
  if (rpgWindow) {
    rpgWindow.focus();
    return;
  }
  // The game screen is 800 x 384 and scales by whole device pixels. Open at
  // twice that size if the display has room, otherwise at one and a half
  // times, which is still a whole number of pixels on a high-density display.
  const room = screen.getPrimaryDisplay().workAreaSize;
  const double = room.width >= 1640 && room.height >= 900;
  rpgWindow = new BrowserWindow({
    width: double ? 1632 : 1232,
    height: double ? 880 : 700,
    useContentSize: true,
    minWidth: 800,
    minHeight: 500,
    title: 'Aldermoor: an RPG in Lua',
    webPreferences: {
      preload: path.join(here, 'rpg', 'preload.cjs'),
      // As for the canvas window: the preload needs Node to load lua-native.
      sandbox: false,
    },
  });
  rpgWindow.on('closed', () => {
    rpgWindow = null;
  });
  rpgWindow.loadFile(path.join(here, 'rpg', 'index.html'));
}

app.whenReady().then(() => {
  openIpcWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openIpcWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
