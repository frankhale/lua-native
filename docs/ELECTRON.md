# Using lua-native from Electron

This document covers what you need to consume `lua-native` from an Electron
application. The short version: because the addon is built with **N-API**
(`NAPI_VERSION=8` in `binding.gyp`), there are **no special build steps** — the
work is all in packaging and process placement.

## Why there are no special build steps

N-API is ABI-stable across Node and Electron versions. The **same compiled
`.node` binary works in Electron without recompiling** against Electron's
headers. Non-N-API addons (raw V8 / NAN) must be rebuilt for every Electron
version with `electron-rebuild` — `lua-native` skips all of that.

The one floor to be aware of: **N-API version 8 requires Electron ≥ 15**
(Electron 14 shipped N-API 8 experimentally; 15+ has it fully). Anything newer
is fine.

## 1. Where the module loads (process model)

Native addons cannot load in a sandboxed renderer. In practice:

- **Load `lua-native` in the main process** and expose it to the renderer over
  IPC (`ipcMain` / `ipcRenderer`). This is the recommended and safest path —
  embedding a Lua interpreter directly in a renderer is a security surface you
  probably do not want.
- If you must use it in a renderer, that renderer needs `sandbox: false` and
  `nodeIntegration: true`, which weakens Electron's security model.

`index.js` uses `createRequire(import.meta.url)` plus dynamic path resolution,
which works fine in the Electron main process.

## 2. Packaging: unpack the `.node` from the asar

This is the most common thing that breaks. Electron bundles the app into an
`app.asar` archive, and native `.node` binaries **cannot be `dlopen`'d from
inside an asar** — they must live on the real filesystem.

**electron-builder** (`package.json`):

```json
{
  "build": {
    "asarUnpack": ["**/*.node", "**/node_modules/lua-native/**"]
  }
}
```

**electron-forge** (`forge.config.js`):

```js
packagerConfig: {
  asar: { unpack: "**/*.node" }
}
```

When unpacked, the binary ends up under `app.asar.unpacked/...`. Node's
`require` and the fallback loader in `index.js` handle the redirect
automatically — no changes to `index.js` are needed.

## 3. Ship a prebuild (do not rely on a source build)

End users will not have vcpkg, node-gyp, or a C++ toolchain, so the
`get_vcpkg_path.js` resolution would fail at their install time. Therefore:

- Run `npm run prebuildify` (which uses `prebuildify --napi --strip`) to produce a
  binary under `prebuilds/<platform>-<arch>/`, and make sure that ships in the
  app.
- Because Lua is statically linked (`LUA_STATIC` in `binding.gyp`), there is
  **no external Lua `.dylib` / `.dll` to bundle** — the prebuilt `.node` is
  self-contained. This is a real advantage over a dynamically-linked Lua.
- Build a prebuild per target arch (`darwin-arm64`, `darwin-x64`,
  `win32-x64`) so packaged apps on each platform find a match.

## 4. Check the macOS deployment target

`binding.gyp` sets `MACOSX_DEPLOYMENT_TARGET: "26.0"`. That means the prebuilt
binary **requires macOS 26+ to load**. If you distribute an Electron app to
users on older macOS, the addon will fail to `dlopen` even though Electron
itself runs. Lower this to match the oldest macOS you intend to support
(Electron itself typically supports back several versions).

## Summary

| Step                     | Action                                                        |
| ------------------------ | ------------------------------------------------------------- |
| Build steps              | None — N-API is ABI-stable, no `electron-rebuild` required.    |
| Electron version         | Requires Electron ≥ 15 (for N-API 8).                          |
| Process placement        | Load in the main process; bridge to the renderer via IPC.     |
| Packaging                | Add `asarUnpack: ["**/*.node"]` (or forge `asar.unpack`).      |
| Distribution             | Ship a `prebuildify` prebuild per target arch.                |
| Native deps              | None to bundle — Lua is statically linked.                    |
| macOS                    | Verify `MACOSX_DEPLOYMENT_TARGET` matches your minimum macOS. |
