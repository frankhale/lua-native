## lua-native 1.2.0

lua-native now runs in web browsers, through a WebAssembly build with the same
API. For Node users this is a minor release with no API changes; see
**Changed** for what you might notice.

### Added

- **Browser support.** `import lua_native from 'lua-native'` in a page or a
  bundle loads a WebAssembly build; under Node, the same line still loads the
  native addon. Vite needs no configuration, and no cross-origin isolation is
  required. It has been run in Chromium and Safari, on pages and in Web Workers.
  Firefox has not been tested.
  - `execute_script_async` and `execute_file_async` share the page's thread where
    the browser can suspend WebAssembly, so the page stays responsive and
    `cancel()` works as it does under Node. Elsewhere they hold the thread.
  - A page has no disk and no processes. `docs/LIMITATIONS.md` §11 lists the
    limits, and `docs/WASM.md` lists every difference from the native addon.
- **A walkthrough and a sample page.** "Using lua-native in a Browser" in the
  README, and `examples/browser/index.html` in the repository.
- **An Electron demo** in the repository (`electron/`): Lua in the main process,
  Lua in a renderer, and a small tile-based RPG written in Lua.

### Fixed

- **Use-after-free in table iterators.** Calling a table handle's
  `[Symbol.iterator]` detached from the handle could leave the iterator reading
  freed memory once the handle was collected.
- **Functions passed to async calls.** A JavaScript function passed as an argument
  to `call_async`, `resume_async` or an async cursor's `next()` was released
  before Lua could call it.
- **Overlapping async runs.** An async cursor's `next()` is now refused while
  another run is in flight, instead of leaving that run's promise pending. A run
  started while another call was still converting its arguments is no longer
  overwritten.
- **Very large timeouts.** A `timeout` too large for the system clock, `Infinity`
  included, could end the script at once with "execution timeout". It now
  means, in effect, no deadline.
- **Lost error text at the C-stack limit.** A Lua string error could be reported
  as `(error object is a string value)` when there was no C stack left to format
  it. It keeps its message.

### Changed

- **Key order of converted tables.** A Lua table converted to a plain object now
  has its keys in byte order (JavaScript still puts integer-like keys first). The
  order was unspecified before.
- **The package has an `exports` map.** `lua-native`, `lua-native/index.js`,
  `lua-native/index.d.ts`, `lua-native/types.d.ts` and `lua-native/package.json`
  can be imported. Other paths inside the package, `prebuilds/` included, cannot.
- **Bundled Electron renderers.** A renderer page bundled for the browser now gets
  the WebAssembly build, where bundling it with Vite crashed before. To use the
  native addon in a renderer, load it in a preload or keep it external.

### Internal

- The test suite and all ten correctness harnesses also run against the
  WebAssembly build, held to a closed list of permitted differences.
- The sanitizer runs are clean on the native addon.

### Prebuilt binaries

macOS arm64 (macOS 13.5 or later) and Windows x64, both with Lua 5.5.1, and the
WebAssembly build for browsers.

**Full changelog:** https://github.com/frankhale/lua-native/compare/v1.1.1...v1.2.0
