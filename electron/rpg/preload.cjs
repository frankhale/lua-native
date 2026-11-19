// Preload for the RPG demo. Like the canvas demo, this window is created with
// `sandbox: false` (see main.mjs), so Lua lives here in the renderer process.
//
// The whole game is Lua, in rpg/game/*.lua. This file is only the machine it
// runs on: it loads the two tilesheets, gives Lua three drawing functions,
// passes key presses in, and calls update() and draw() once a frame.

const { contextBridge } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { default: lua_native } = require('lua-native');

const gameDir = path.join(__dirname, 'game');
const TILE = 16; // the tilesheets are 16 tiles across, 16 pixels each
const SHEET_COLUMNS = 16;

// The same tiles twice. The second sheet is the other frame of everything
// that moves: water, fire, people, monsters.
const sheets = [new Image(), new Image()];

let canvas = null;
let ctx = null;
let screenWidth = 768;
let screenHeight = 384;

let game = null; // { update, draw, keypressed, keyreleased }: Lua functions
let lastFrame = 0;
let hostCalls = 0;

const listeners = { stats: null, output: null, error: null, loaded: null };

const lua = new lua_native.init(
  {
    // Draw one tile. Called a few hundred times a frame.
    sprite(id, x, y, size, alt) {
      hostCalls++;
      const sheet = sheets[alt ? 1 : 0];
      const side = size ?? TILE;
      ctx.drawImage(
        sheet,
        (id % SHEET_COLUMNS) * TILE,
        Math.floor(id / SHEET_COLUMNS) * TILE,
        TILE,
        TILE,
        x,
        y,
        side,
        side,
      );
    },
    fill(x, y, w, h, color) {
      hostCalls++;
      ctx.fillStyle = String(color ?? '#000');
      ctx.fillRect(x, y, w, h);
    },
    // The game says how big its screen is; the canvas is scaled to fit.
    screen(w, h) {
      screenWidth = w;
      screenHeight = h;
      if (canvas) {
        fitCanvas();
      }
    },
  },
  {
    // The game is our own code and uses require(), so 'safe' rather than
    // 'sandbox': it adds the package library.
    libraries: 'safe',
    maxMemory: 64 * 1024 * 1024,
    // Per call into Lua. A frame that never ends raises an error instead of
    // freezing the window.
    timeout: 250,
  },
);

// Lets `require('atlas')` find rpg/game/atlas.lua. reset() keeps it.
lua.add_search_path(path.join(gameDir, '?.lua'));
lua.set_print_handler((text) => listeners.output?.(text));

// Scale the screen up by a whole number of device pixels, so every tile
// pixel stays square and sharp.
function fitCanvas() {
  const stage = canvas.parentElement;
  const density = window.devicePixelRatio || 1;
  const scale = Math.max(
    1,
    Math.floor(
      Math.min(
        (stage.clientWidth * density) / screenWidth,
        (stage.clientHeight * density) / screenHeight,
      ),
    ),
  );
  canvas.width = screenWidth * scale;
  canvas.height = screenHeight * scale;
  canvas.style.width = `${canvas.width / density}px`;
  canvas.style.height = `${canvas.height / density}px`;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

// Start the game from a fresh Lua state. Also how it restarts.
function load() {
  game = null;
  try {
    lua.reset();
    lua.execute_file(path.join(gameDir, 'main.lua'));
    const loaded = {};
    for (const name of ['update', 'draw', 'keypressed', 'keyreleased']) {
      const fn = lua.get_global(name);
      if (typeof fn !== 'function') {
        throw new Error(`main.lua must define a global function ${name}()`);
      }
      loaded[name] = fn;
    }
    game = loaded;
    lastFrame = performance.now();
    listeners.loaded?.();
    return { ok: true, error: null };
  } catch (error) {
    listeners.error?.(error.message);
    return { ok: false, error: error.message };
  }
}

// Call into the game. An error stops it until the next load.
function call(name, ...args) {
  if (!game) {
    return;
  }
  try {
    game[name](...args);
  } catch (error) {
    game = null;
    listeners.error?.(error.message);
  }
}

let frames = 0;
let luaTime = 0;
let callTotal = 0;
let windowStart = 0;

function frame(now) {
  requestAnimationFrame(frame);
  if (!game) {
    windowStart = now;
    frames = 0;
    luaTime = 0;
    callTotal = 0;
    return;
  }

  // Cap the step, so a window that was hidden does not replay the gap.
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  hostCalls = 0;
  const before = performance.now();
  call('update', dt);
  call('draw');
  luaTime += performance.now() - before;
  callTotal += hostCalls;
  frames++;

  if (now - windowStart >= 500) {
    listeners.stats?.({
      fps: (frames * 1000) / (now - windowStart),
      msPerFrame: luaTime / frames,
      callsPerFrame: Math.round(callTotal / frames),
    });
    windowStart = now;
    frames = 0;
    luaTime = 0;
    callTotal = 0;
  }
}

const KEY_NAMES = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ' ': 'space' };
// Keys the page would otherwise act on by scrolling.
const SCROLL_KEYS = new Set(['up', 'down', 'left', 'right', 'space']);
const down = new Set();

function keyName(event) {
  return KEY_NAMES[event.key] ?? event.key.toLowerCase();
}

function loadImage(image, file) {
  return new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error(`could not load ${file}`));
    image.src = `../assets/${file}`;
  });
}

// Edit a .lua file and the game restarts with it. The directory is watched,
// not the files, because editors save by replacing the file.
function watchGame() {
  let pending = null;
  fs.watch(gameDir, () => {
    clearTimeout(pending);
    pending = setTimeout(load, 100);
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  canvas = document.getElementById('stage');
  ctx = canvas.getContext('2d');
  fitCanvas();
  new ResizeObserver(fitCanvas).observe(canvas.parentElement);

  window.addEventListener('keydown', (event) => {
    // Leave shortcuts such as reload and quit alone.
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const key = keyName(event);
    if (SCROLL_KEYS.has(key)) {
      event.preventDefault();
    }
    // The browser's own key repeat is ignored; the game does its own.
    if (!event.repeat && !down.has(key)) {
      down.add(key);
      call('keypressed', key);
    }
  });
  window.addEventListener('keyup', (event) => {
    const key = keyName(event);
    if (down.delete(key)) {
      call('keyreleased', key);
    }
  });
  // A key released while the window is elsewhere would stay held forever.
  window.addEventListener('blur', () => {
    for (const key of down) {
      call('keyreleased', key);
    }
    down.clear();
  });

  try {
    await Promise.all([
      loadImage(sheets[0], 'tilesheet.png'),
      loadImage(sheets[1], 'tilesheet_frame2.png'),
    ]);
  } catch (error) {
    listeners.error?.(error.message);
    return;
  }

  load();
  watchGame();
  requestAnimationFrame(frame);
});

contextBridge.exposeInMainWorld('rpgDemo', {
  restart: load,
  onStats: (listener) => {
    listeners.stats = listener;
  },
  onOutput: (listener) => {
    listeners.output = listener;
  },
  onError: (listener) => {
    listeners.error = listener;
  },
  onLoaded: (listener) => {
    listeners.loaded = listener;
  },
});
