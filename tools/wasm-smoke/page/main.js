// The smoke page: run the set on the main thread, then again inside a Web
// Worker, show both, and hand the results to the server that served the page.
//
// It imports the package's real browser entry, `/browser.js`, and nothing from
// the build directory by name: what is exercised is what a consumer gets.

const $ = (id) => document.getElementById(id);
const verdict = (text) => { $('verdict').textContent = text; };

$('agent').textContent = navigator.userAgent;

function row(table, result) {
  const tr = table.insertRow();
  const status = tr.insertCell();
  status.className = `status ${result.status}`;
  status.textContent = result.status;
  const body = tr.insertCell();
  body.append(result.name);
  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.textContent = result.detail;
  body.append(detail);
  const ms = tr.insertCell();
  ms.className = 'ms';
  ms.textContent = `${result.ms} ms`;
}

async function report(where, outcome) {
  const body = {
    where,
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    ...outcome,
  };
  try {
    await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    // Opened from somewhere that is not the smoke server; the page still shows it.
  }
}

async function onMain() {
  const loadStarted = performance.now();
  let lua_native;
  let runSmokeSet;
  try {
    ({ default: lua_native } = await import('/browser.js'));
    ({ runSmokeSet } = await import('../set.mjs'));
  } catch (error) {
    const outcome = { loadError: String(error?.stack ?? error) };
    row($('main'), { status: 'FAIL', name: 'importing /browser.js', detail: outcome.loadError, ms: 0 });
    await report('main', outcome);
    return outcome;
  }
  const loadMs = Math.round(performance.now() - loadStarted);
  const outcome = await runSmokeSet(lua_native, { browser: true, where: 'main' }, (r) => row($('main'), r));
  outcome.loadMs = loadMs;
  await report('main', outcome);
  return outcome;
}

function inWorker() {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      resolve({ loadError: `the worker could not be started: ${String(error)}` });
      return;
    }
    worker.onmessage = ({ data }) => {
      if (data.result) row($('worker'), data.result);
      if (data.outcome) { worker.terminate(); resolve(data.outcome); }
    };
    worker.onerror = (event) => {
      resolve({ loadError: `the worker failed: ${event.message ?? 'no message'} (${event.filename ?? ''}:${event.lineno ?? ''})` });
    };
  });
}

const tally = (outcome) => {
  if (outcome.loadError) return 'did not load';
  const count = (s) => outcome.results.filter(r => r.status === s).length;
  const parts = [`${count('pass')} of ${outcome.cells} pass`];
  if (count('FAIL')) parts.push(`${count('FAIL')} FAIL`);
  if (count('INCONCLUSIVE')) parts.push(`${count('INCONCLUSIVE')} inconclusive`);
  return parts.join(', ');
};

verdict('Running on the main thread…');
const main = await onMain();
verdict(`Main thread: ${tally(main)}. Running in a Web Worker…`);
const worker = await inWorker();
if (worker.loadError) row($('worker'), { status: 'FAIL', name: 'starting the worker', detail: worker.loadError, ms: 0 });
await report('worker', worker);
verdict(`Main thread: ${tally(main)}. Web Worker: ${tally(worker)}.`);
document.title = `${document.title} — done`;
