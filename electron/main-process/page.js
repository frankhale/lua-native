// Page script for the main-process demo. No Node and no lua-native here:
// everything goes through window.lua, which preload.cjs defines, and from
// there over IPC to the main process.

const MODES = {
  main: {
    hint: 'execute_async: host functions work and sleep() is awaited, but a CPU-bound loop blocks the app until it ends.',
    sample: `-- Main thread: runs as a coroutine in Electron's main process.
print("Hello from " .. _VERSION)

-- host is a JavaScript object, handed to Lua as a table.
print("Electron " .. host.electron .. " on " .. host.platform)

-- set_title is a JavaScript function. Calling it renames this window.
set_title("Renamed from Lua")

-- sleep returns a JavaScript Promise. The script waits for it here while the
-- app stays responsive. Press Stop during a wait to cancel the run.
for i = 3, 1, -1 do
  print(i .. "...")
  sleep(400)
end

-- Globals survive between runs until you press Reset state.
runs = (runs or 0) + 1

-- The returned table comes back to JavaScript as an object.
return { runs = runs, squares = { 1, 4, 9 } }
`,
  },
  worker: {
    hint: 'execute_script_async: the app stays responsive and Stop works mid-loop, but host functions are unavailable and print goes to the terminal.',
    sample: `-- Worker thread: runs off Electron's main thread, so the app stays
-- responsive while this computes and Stop interrupts it mid-loop.
--
-- The cost: a worker cannot call JavaScript. set_title and sleep raise an
-- error here, and print goes to the terminal instead of the pane below.
local function fib(n)
  if n < 2 then return n end
  return fib(n - 1) + fib(n - 2)
end

runs = (runs or 0) + 1

return { runs = runs, fib36 = fib(36) }
`,
  },
};

const source = document.getElementById('source');
const output = document.getElementById('output');
const status = document.getElementById('status');
const hint = document.getElementById('hint');
const mode = document.getElementById('mode');
const runButton = document.getElementById('run');
const stopButton = document.getElementById('stop');
const resetButton = document.getElementById('reset');

const isMac = navigator.platform.startsWith('Mac');
runButton.title = isMac ? 'Run (⌘↵)' : 'Run (Ctrl+Enter)';

let running = false;

function show(kind, text) {
  const span = document.createElement('span');
  span.className = kind;
  span.textContent = text;
  output.append(span);
}

function kilobytes(bytes) {
  return `Lua is holding ${(bytes / 1024).toFixed(1)} KB`;
}

function setRunning(value) {
  running = value;
  runButton.disabled = value;
  resetButton.disabled = value;
  mode.disabled = value;
  stopButton.disabled = !value;
}

// Swap in the other mode's sample, unless the editor holds something else.
function applyMode() {
  const isSample = Object.values(MODES).some((m) => m.sample === source.value);
  if (isSample || source.value === '') {
    source.value = MODES[mode.value].sample;
  }
  hint.textContent = MODES[mode.value].hint;
}

async function run() {
  if (running) {
    return;
  }
  setRunning(true);
  output.replaceChildren();
  status.textContent = 'Running…';

  const reply = await window.lua.run(source.value, mode.value);

  if (reply.ok && reply.result !== null) {
    show('result', `→ ${reply.result}\n`);
  }
  if (!reply.ok) {
    show('error', `${reply.error}\n`);
  }
  if (!output.hasChildNodes()) {
    show('muted', 'The script printed nothing here and returned nothing.\n');
  }
  status.textContent = `${(reply.ms / 1000).toFixed(2)} s · ${kilobytes(reply.memory)}`;
  setRunning(false);
}

async function reset() {
  const reply = await window.lua.reset();
  output.replaceChildren();
  show('muted', 'Lua state reset. Globals are gone; host, set_title and sleep are back.\n');
  status.textContent = kilobytes(reply.memory);
}

// print output arrives while the script is still running.
window.lua.onOutput((text) => show('printed', text));

runButton.addEventListener('click', run);
stopButton.addEventListener('click', () => window.lua.stop());
resetButton.addEventListener('click', reset);
mode.addEventListener('change', applyMode);
document.getElementById('open-canvas').addEventListener('click', () => window.lua.openCanvasDemo());

source.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    run();
    return;
  }
  // Tab indents instead of leaving the editor.
  if (event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault();
    source.setRangeText('  ', source.selectionStart, source.selectionEnd, 'end');
  }
});

applyMode();
