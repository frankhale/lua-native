# Overlay triplet: the stock `arm64-osx` plus a deployment target.
#
# Deliberately named `arm64-osx` rather than something like `arm64-osx-13` so it
# shadows the built-in triplet and installs to the same
# `installed/arm64-osx` directory. `get_vcpkg_path.js` and `CMakeLists.txt` both
# hardcode that name, so a new name would mean editing two files to find the
# library; shadowing means neither changes.
#
# The added line exists because vcpkg's stock triplet sets no deployment target,
# so `liblua.a` was built `minos 26.0`. Linking that into an addon targeting an
# older macOS still works — Lua's external symbols are all ancient libc/libm —
# but it emits one `built for newer 'macOS' version` warning per Lua object and
# leaves the addon claiming support it was never linked for. 13.5 matches both
# `binding.gyp`'s MACOSX_DEPLOYMENT_TARGET and the minos of the official Node
# 24 macOS arm64 build, which is the real floor for anyone loading this addon.
#
# NOT STICKY: vcpkg only sees this when `--overlay-triplets` points at this
# directory. A plain `vcpkg install lua` silently rebuilds at the SDK default and
# the warnings come back. Use the `vcpkg-lua` npm script rather than a bare
# install.

set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME Darwin)
set(VCPKG_OSX_ARCHITECTURES arm64)
set(VCPKG_OSX_DEPLOYMENT_TARGET 13.5)
