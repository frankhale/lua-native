// One ledger probe, on one target, in a process of its own.
//
//   LUA_NATIVE_TARGET=<target> node [node args] tools/wasm-verify/probe.mjs <entry id>
//
// Prints one JSON line: `{ id, target, observed, saw }`. A process each because
// one probe exhausts the engine's stack and another needs a flag on the node
// command line; and importing `target.mjs` puts every probe behind the control.

import lua_native, { target, observed } from '../target.mjs';
import { LEDGER } from '../wasm-ledger.mjs';

const id = process.argv[2];
const entry = LEDGER.find(e => e.id === id);
if (!entry?.probe) {
  console.error(`probe.mjs: no ledger entry '${id}' with a probe`);
  process.exit(2);
}

let saw;
try {
  saw = await entry.probe.observe(lua_native);
} catch (error) {
  saw = `the probe itself threw ${error?.constructor?.name}: ${String(error?.message).slice(0, 120)}`;
}
console.log(JSON.stringify({ id, target, observed, saw }));
