// Page script for the RPG demo. No Node here, and no game either: Lua and the
// canvas live in preload.cjs. This file is the Restart button, the status
// line, and a pane that appears when the game prints or fails.

const output = document.getElementById('output');
const status = document.getElementById('status');
const restartButton = document.getElementById('restart');

const MAX_OUTPUT_NODES = 200;

function show(kind, text) {
  const span = document.createElement('span');
  span.className = kind;
  span.textContent = text;
  output.append(span);
  while (output.childNodes.length > MAX_OUTPUT_NODES) {
    output.firstChild.remove();
  }
  output.hidden = false;
  output.scrollTop = output.scrollHeight;
}

window.rpgDemo.onStats((stats) => {
  status.textContent =
    `${stats.fps.toFixed(0)} fps · ${stats.msPerFrame.toFixed(2)} ms of Lua per frame · ` +
    `${stats.callsPerFrame} host calls per frame`;
});

window.rpgDemo.onOutput((text) => show('printed', text));

// A Lua error stops the game where it is. Fixing the file restarts it.
window.rpgDemo.onError((message) => {
  show('error', `${message}\n`);
  status.textContent = 'Stopped';
});

window.rpgDemo.onLoaded(() => {
  output.replaceChildren();
  output.hidden = true;
});

restartButton.addEventListener('click', () => {
  window.rpgDemo.restart();
  // Give the keyboard back to the game.
  restartButton.blur();
});
