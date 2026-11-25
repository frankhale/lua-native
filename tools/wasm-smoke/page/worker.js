// The same set, with the VM inside a Web Worker: the recommended way to keep a
// page responsive, since on this target a running script holds its thread (D3).
// A module worker, so it loads `/browser.js` exactly as the page does.

try {
  const loadStarted = performance.now();
  const { default: lua_native } = await import('/browser.js');
  const { runSmokeSet } = await import('../set.mjs');
  const loadMs = Math.round(performance.now() - loadStarted);
  const outcome = await runSmokeSet(lua_native, { browser: true, where: 'worker' },
    (result) => self.postMessage({ result }));
  outcome.loadMs = loadMs;
  self.postMessage({ outcome });
} catch (error) {
  self.postMessage({ outcome: { loadError: String(error?.stack ?? error) } });
}
