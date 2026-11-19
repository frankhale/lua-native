// Preload for the renderer-process demo. This window is created with
// `sandbox: false` (see main.mjs), so this script has Node and can load a
// native addon. Lua therefore lives here, inside the renderer process, and a
// Lua call that draws is a plain JavaScript call into the canvas: no IPC.
//
// Context isolation stays on. The page gets the small `window.canvasDemo`
// object below and nothing else, so it still has no `require` and no Node.

const { contextBridge } = require('electron');
const { default: lua_native } = require('lua-native');

let canvas = null;
let ctx = null;
let width = 0;
let height = 0;

let draw = null; // the script's draw function: a Lua function, callable from JS
let paused = false;
let startedAt = 0;
let hostCalls = 0;

const listeners = { stats: null, output: null, error: null };

// Everything Lua can call. Each one is counted so the page can show how many
// crossings a frame makes.
const lua = new lua_native.init(
  {
    clear(color) {
      hostCalls++;
      ctx.fillStyle = String(color ?? '#000');
      ctx.fillRect(0, 0, width, height);
    },
    rect(x, y, w, h, color) {
      hostCalls++;
      ctx.fillStyle = String(color ?? '#fff');
      ctx.fillRect(x, y, w, h);
    },
    circle(x, y, radius, color) {
      hostCalls++;
      ctx.fillStyle = String(color ?? '#fff');
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0, radius), 0, Math.PI * 2);
      ctx.fill();
    },
    line(x1, y1, x2, y2, color, thickness) {
      hostCalls++;
      ctx.strokeStyle = String(color ?? '#fff');
      ctx.lineWidth = thickness ?? 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    },
    text(value, x, y, color) {
      hostCalls++;
      ctx.fillStyle = String(color ?? '#fff');
      ctx.fillText(String(value), x, y);
    },
  },
  {
    libraries: 'sandbox',
    maxMemory: 32 * 1024 * 1024,
    // Per call into Lua, so per frame. A draw() that never returns raises an
    // error after a quarter of a second instead of freezing the page.
    timeout: 250,
  },
);

lua.set_print_handler((text) => listeners.output?.(text));

function publishSize() {
  lua.set_global('width', width);
  lua.set_global('height', height);
}

function publishMouse(x, y) {
  lua.set_global('mouse_x', x);
  lua.set_global('mouse_y', y);
}

function fitCanvas() {
  const scale = window.devicePixelRatio || 1;
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.font = '12px system-ui, sans-serif';
  publishSize();
}

// Load a script. Starts from a fresh Lua state each time, so a draw function
// left over from the previous script cannot keep running.
function run(source) {
  draw = null;
  try {
    lua.reset();
    publishSize();
    publishMouse(null, null);
    lua.execute_script(String(source), { chunkName: '=editor' });
    const fn = lua.get_global('draw');
    if (typeof fn !== 'function') {
      return { ok: false, error: 'The script must define a global function draw(t).' };
    }
    draw = fn;
    paused = false;
    startedAt = performance.now();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

let frames = 0;
let luaTime = 0;
let callTotal = 0;
let windowStart = 0;

function frame(now) {
  requestAnimationFrame(frame);
  if (!draw || paused) {
    windowStart = now;
    frames = 0;
    luaTime = 0;
    callTotal = 0;
    return;
  }

  hostCalls = 0;
  const before = performance.now();
  try {
    draw((now - startedAt) / 1000);
  } catch (error) {
    draw = null;
    listeners.error?.(error.message);
    return;
  }
  luaTime += performance.now() - before;
  callTotal += hostCalls;
  frames++;

  // Report twice a second, averaged, so the numbers are readable.
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

// A preload runs before the page exists but shares its DOM once it does.
window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('stage');
  ctx = canvas.getContext('2d');
  fitCanvas();
  new ResizeObserver(fitCanvas).observe(canvas);

  canvas.addEventListener('mousemove', (event) => publishMouse(event.offsetX, event.offsetY));
  canvas.addEventListener('mouseleave', () => publishMouse(null, null));

  requestAnimationFrame(frame);
});

contextBridge.exposeInMainWorld('canvasDemo', {
  run,
  setPaused: (value) => {
    paused = Boolean(value);
  },
  onStats: (listener) => {
    listeners.stats = listener;
  },
  onOutput: (listener) => {
    listeners.output = listener;
  },
  onError: (listener) => {
    listeners.error = listener;
  },
});
