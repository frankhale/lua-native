// Page script for the renderer-process demo. Still no Node here: Lua and the
// canvas drawing live in preload.cjs, which hands this page window.canvasDemo.
// This file is only the editor and the buttons.

const SAMPLE = `-- Lua runs inside this window. draw(t) is called
-- once per animation frame, and each clear, line,
-- circle and text below is a direct call into the
-- canvas.
--
-- The host provides width, height, and mouse_x /
-- mouse_y (nil while the pointer is elsewhere).
-- Move the pointer over the canvas, or edit this
-- and press Run.

local count = 160

function draw(t)
  clear("#101418")

  local cx, cy = width / 2, height / 2
  local reach = math.min(width, height)

  for i = 1, count do
    local k = i / count
    local angle = t * (0.25 + k) + k * math.pi * 10
    local wobble = 1 + 0.08 * math.sin(t * 2 + i)
    local radius = reach * (0.08 + 0.36 * k) * wobble
    local x = cx + math.cos(angle) * radius
    local y = cy + math.sin(angle) * radius
    local hue = (k * 360 + t * 40) % 360
    local color = string.format("hsl(%.0f 80%% 60%%)", hue)

    if mouse_x then
      line(mouse_x, mouse_y, x, y, color, 0.15)
    end
    circle(x, y, 1.5 + 4 * k, color)
  end

  text(count .. " circles, drawn from Lua", 12, 22, "#9a9a94")
end
`;

const source = document.getElementById('source');
const output = document.getElementById('output');
const status = document.getElementById('status');
const runButton = document.getElementById('run');
const pauseButton = document.getElementById('pause');

const MAX_OUTPUT_NODES = 200;

const isMac = navigator.platform.startsWith('Mac');
runButton.title = isMac ? 'Run (⌘↵)' : 'Run (Ctrl+Enter)';

let paused = false;

function show(kind, text) {
  const span = document.createElement('span');
  span.className = kind;
  span.textContent = text;
  output.append(span);
  // A print inside draw() arrives every frame; keep only the recent ones.
  while (output.childNodes.length > MAX_OUTPUT_NODES) {
    output.firstChild.remove();
  }
  output.scrollTop = output.scrollHeight;
}

function setPaused(value) {
  paused = value;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
  window.canvasDemo.setPaused(paused);
  if (paused) {
    status.textContent = 'Paused';
  }
}

function run() {
  output.replaceChildren();
  status.textContent = '';
  setPaused(false);
  const reply = window.canvasDemo.run(source.value);
  if (!reply.ok) {
    show('error', `${reply.error}\n`);
    status.textContent = 'Stopped';
  }
}

window.canvasDemo.onStats((stats) => {
  if (paused) {
    return;
  }
  status.textContent =
    `${stats.fps.toFixed(0)} fps · ${stats.msPerFrame.toFixed(2)} ms of Lua per frame · ` +
    `${stats.callsPerFrame} host ${stats.callsPerFrame === 1 ? 'call' : 'calls'} per frame`;
});

window.canvasDemo.onOutput((text) => show('printed', text));

// An error inside draw() stops the animation; the preload reports it here.
window.canvasDemo.onError((message) => {
  show('error', `${message}\n`);
  status.textContent = 'Stopped';
});

runButton.addEventListener('click', run);
pauseButton.addEventListener('click', () => setPaused(!paused));

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

source.value = SAMPLE;
run();
