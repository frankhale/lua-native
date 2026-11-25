// The package shape: does what `npm pack` produces resolve the way
// `docs/reviews/WASM-TARGET-PLAN.md` D6 says, for a Node consumer and for a browser one?
//
//   node tools/wasm-package/run.mjs
//
// It packs the working tree into a real tarball, unpacks that as
// `node_modules/lua-native` of an empty consumer project outside the
// repository, and asks from inside that project. Nothing is checked against
// the working tree: a file missing from `files` is missing here.
//
// One package, two entries:
//
//   - under Node, `lua-native` resolves to `index.js`, as it did before the
//     package had an `exports` map;
//   - under the `browser` condition it resolves to `browser.js` — asked of
//     Node itself with `--conditions=browser`, and of a bundler (rolldown, the
//     one already in `node_modules`), which also has to follow it to the shell
//     and the `.wasm`.
//
// Not a search, and it exits 0 or 1. The controls are the refusals: an
// `exports` map blocks every path it does not list, so a deep import of
// `prebuilds/` must now fail (D6's accepted consequence). If that resolves,
// the map is not in effect and the checks above it proved nothing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const WEB = 'build-wasm/release/web';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

for (const file of ['lua-native.mjs', 'lua-native-core.mjs', 'lua-native-core.wasm']) {
  if (!fs.existsSync(path.join(ROOT, WEB, file))) {
    console.error(`No ${WEB}/${file}. Run 'npm run build-wasm-release' first: the web build is published, not committed.`);
    process.exit(2);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-native-package-'));
try {
  // --- Pack ---------------------------------------------------------------
  const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work],
    { cwd: ROOT, encoding: 'utf8' });
  if (packed.status !== 0) {
    console.error(`npm pack failed:\n${packed.stderr}`);
    process.exit(1);
  }
  const manifest = JSON.parse(packed.stdout)[0];
  const files = manifest.files.map(f => f.path);

  console.log(`Tarball (${manifest.filename}, ${files.length} files, ${manifest.size} bytes packed)`);
  for (const wanted of ['package.json', 'index.js', 'index.d.ts', 'types.d.ts', 'browser.js', 'browser.d.ts',
    `${WEB}/lua-native.mjs`, `${WEB}/lua-native-core.mjs`, `${WEB}/lua-native-core.wasm`]) {
    check(`contains ${wanted}`, files.includes(wanted));
  }
  const stray = files.filter(f => /^(src|tools|tests|docs|build|triplets)\//.test(f) ||
    (f.startsWith('build-wasm/') && !f.startsWith(`${WEB}/`)));
  check('contains no source, tooling, tests or other build output', stray.length === 0, stray.slice(0, 5).join(', '));

  // --- Unpack as a consumer's dependency ----------------------------------
  const consumer = path.join(work, 'consumer');
  const installed = path.join(consumer, 'node_modules', 'lua-native');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(consumer, 'package.json'), '{ "name": "consumer", "private": true, "type": "module" }\n');
  const untar = spawnSync('tar', ['-xzf', path.join(work, manifest.filename), '-C', installed, '--strip-components=1']);
  if (untar.status !== 0) {
    console.error('tar could not unpack the tarball');
    process.exit(1);
  }
  const real = fs.realpathSync(installed);

  // What a specifier resolves to from inside the consumer, or the error code.
  const resolve = (specifier, nodeArgs = []) => {
    const child = spawnSync(process.execPath, [...nodeArgs, '--input-type=module', '-e',
      `try { console.log(import.meta.resolve(${JSON.stringify(specifier)})); } catch (e) { console.log('ERROR ' + e.code); }`],
    { cwd: consumer, encoding: 'utf8' });
    const out = child.stdout.trim();
    return out.startsWith('file:') ? path.relative(real, fs.realpathSync(url.fileURLToPath(out))) : out || `ERROR ${child.stderr.trim().split('\n').pop()}`;
  };

  console.log('\nUnder Node');
  const expectResolve = (specifier, want, nodeArgs) => {
    const got = resolve(specifier, nodeArgs);
    check(`${specifier} resolves to ${want}`, got === want, `got ${got}`);
  };
  expectResolve('lua-native', 'index.js');
  expectResolve('lua-native/index.js', 'index.js');
  expectResolve('lua-native/index.d.ts', 'index.d.ts');
  expectResolve('lua-native/types.d.ts', 'types.d.ts');
  expectResolve('lua-native/package.json', 'package.json');

  console.log('\nUnder Node with --conditions=browser');
  expectResolve('lua-native', 'browser.js', ['--conditions=browser']);
  expectResolve('lua-native/types.d.ts', 'types.d.ts', ['--conditions=browser']);

  console.log('\nControls: what the map must refuse');
  for (const blocked of ['lua-native/prebuilds/darwin-arm64/lua-native.node', 'lua-native/browser.js', `lua-native/${WEB}/lua-native.mjs`]) {
    const got = resolve(blocked);
    check(`${blocked} is not exported`, got === 'ERROR ERR_PACKAGE_PATH_NOT_EXPORTED', `got ${got}`);
  }

  console.log('\nThe declared types');
  const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  check('the browser condition comes before default', Object.keys(pkg.exports['.'])[0] === 'browser');
  check('each condition names its types first', ['browser', 'default'].every(c => Object.keys(pkg.exports['.'][c])[0] === 'types'));
  check('main and types still name the Node entry', pkg.main === 'index.js' && pkg.types === 'index.d.ts');
  for (const target of [pkg.exports['.'].browser.types, pkg.exports['.'].browser.default, pkg.exports['.'].default.types, pkg.exports['.'].default.default]) {
    check(`${target} is in the tarball`, fs.existsSync(path.join(installed, target)));
  }

  // --- A bundler, under its browser condition -----------------------------
  console.log('\nUnder a bundler (rolldown, platform: browser)');
  const { rolldown } = await import('rolldown');
  fs.writeFileSync(path.join(consumer, 'entry.js'),
    "import lua_native from 'lua-native';\nexport const answer = new lua_native.init({}, {}).execute_script('return 6 * 7');\n");
  let bundled;
  let bundleError = '';
  try {
    const bundle = await rolldown({ input: path.join(consumer, 'entry.js'), cwd: consumer, platform: 'browser', logLevel: 'silent' });
    bundled = await bundle.generate({ format: 'esm' });
    await bundle.close();
  } catch (error) {
    bundleError = String(error?.message ?? error).split('\n')[0];
  }
  check('the bundle builds', Boolean(bundled), bundleError);
  if (bundled) {
    const modules = new Set(bundled.output.flatMap(chunk => Object.keys(chunk.modules ?? {}))
      .map(id => path.relative(real, fs.realpathSync(id.split('?')[0]))));
    check('it took browser.js', modules.has('browser.js'), [...modules].join(', '));
    check('it followed browser.js to the shell and the glue',
      modules.has(`${WEB}/lua-native.mjs`) && modules.has(`${WEB}/lua-native-core.mjs`), [...modules].join(', '));
    check('it did not take index.js', !modules.has('index.js'));
    const code = bundled.output.filter(o => o.type === 'chunk').map(o => o.code).join('\n');
    check('nothing from Node is in the bundle', !/from ['"]node:|require\(['"]node:|node-gyp-build/.test(code));
    const assets = bundled.output.filter(o => o.type === 'asset').map(o => o.fileName);
    const emitted = assets.some(name => name.endsWith('.wasm'));
    // Reported, not required: a bundler that leaves `new URL(..., import.meta.url)`
    // alone still produces a working bundle once the `.wasm` is served beside it.
    console.log(`  note  the .wasm is ${emitted ? `emitted as an asset (${assets.find(n => n.endsWith('.wasm'))})` : 'not emitted as an asset'}; ` +
      `the bundle ${/lua-native-core\.wasm/.test(code) ? 'refers to it by name' : 'does not name it'}`);
  }

  // --- The bundler most pages are built with -------------------------------
  //
  // rolldown on its own leaves `new URL('lua-native-core.wasm', import.meta.url)`
  // as it found it. Vite is the same bundler with the asset handling a page
  // build has, and is the case worth knowing: does a plain `vite build`, with
  // no plugin and no configuration for this package, carry the `.wasm` along?
  console.log('\nUnder vite build, no configuration');
  const { build } = await import('vite');
  fs.writeFileSync(path.join(consumer, 'index.html'), '<!doctype html><script type="module" src="./entry.js"></script>\n');
  let built;
  let buildError = '';
  try {
    const result = await build({ root: consumer, configFile: false, logLevel: 'silent', build: { write: false } });
    built = (Array.isArray(result) ? result[0] : result).output;
  } catch (error) {
    buildError = String(error?.message ?? error).split('\n')[0];
  }
  check('the page builds', Boolean(built), buildError);
  if (built) {
    const wasm = built.find(o => o.type === 'asset' && o.fileName.endsWith('.wasm'));
    const code = built.filter(o => o.type === 'chunk').map(o => o.code).join('\n');
    check('the .wasm is emitted as an asset', Boolean(wasm), built.map(o => o.fileName).join(', '));
    if (wasm) {
      check('it is the release .wasm, byte for byte',
        Buffer.compare(Buffer.from(wasm.source), fs.readFileSync(path.join(installed, WEB, 'lua-native-core.wasm'))) === 0);
      check('the script refers to the emitted file', code.includes(path.basename(wasm.fileName)), wasm.fileName);
    }
    check('nothing from Node is in the page', !/from ['"]node:|require\(['"]node:|node-gyp-build/.test(code));
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED.` : '\nThe package resolves as D6 says.');
process.exit(failed ? 1 : 0);
