# Overlay triplet: vcpkg's community `wasm32-emscripten` plus one flag
# and one force-included header.
#
# Deliberately named `wasm32-emscripten` so it shadows the stock triplet and
# installs to `installed/wasm32-emscripten`, for the reason
# `triplets/arm64-osx.cmake` gives: one path for the build script to know.
#
# The added flag is `-sSUPPORT_LONGJMP=wasm`, for C and C++. The stock triplet
# builds Lua against Emscripten's JavaScript-based `longjmp`, and that ties the
# whole module to `-fexceptions`. In that mode a Lua error raised through a C++
# frame holding a destructor or a `catch` block does not leave the frame as it
# does natively — the error value is lost and the statement after the `try`
# runs. The core has `catch` blocks in its Lua C frames, so that mode is out.
# With this flag Lua's `longjmp` uses WASM exception-handling instructions and
# the module is built with `-fwasm-exceptions`. Measurements:
# `docs/reviews/WASM-TARGET-PLAN.md` §2.3 (Phase 0, November 24, 2026).
#
# The force-included header makes Lua's C-call limit a question the module
# answers; `lua-wasm-stack.h` says why.
#
# NOT STICKY: vcpkg only sees this when `--overlay-triplets` points at this
# directory. A bare `vcpkg install lua:wasm32-emscripten` rebuilds the stock
# library, which the module will not link against. Use `npm run vcpkg-lua-wasm`,
# which also sets EMSCRIPTEN_ROOT and checks which `longjmp` runtime the result
# references. `tools/wasm-build/run.mjs` makes the same check before it links.
#
# Everything below the two flag lines is the stock triplet, unchanged, apart
# from VCPKG_CHAINLOAD_TOOLCHAIN_FILE: vcpkg's wrapper toolchain is what
# applies VCPKG_C_FLAGS / VCPKG_CXX_FLAGS, and without it they are dropped
# without a word.

set(VCPKG_C_FLAGS "-sSUPPORT_LONGJMP=wasm -include ${CMAKE_CURRENT_LIST_DIR}/lua-wasm-stack.h")
set(VCPKG_CXX_FLAGS "-sSUPPORT_LONGJMP=wasm -include ${CMAKE_CURRENT_LIST_DIR}/lua-wasm-stack.h")

set(VCPKG_ENV_PASSTHROUGH_UNTRACKED EMSCRIPTEN_ROOT EMSDK PATH)

if(NOT DEFINED ENV{EMSCRIPTEN_ROOT})
   find_path(EMSCRIPTEN_ROOT "emcc")
else()
   set(EMSCRIPTEN_ROOT "$ENV{EMSCRIPTEN_ROOT}")
endif()

if(NOT EMSCRIPTEN_ROOT)
   if(NOT DEFINED ENV{EMSDK})
      message(FATAL_ERROR "The emcc compiler not found in PATH")
   endif()
   set(EMSCRIPTEN_ROOT "$ENV{EMSDK}/upstream/emscripten")
endif()

if(NOT EXISTS "${EMSCRIPTEN_ROOT}/cmake/Modules/Platform/Emscripten.cmake")
   message(FATAL_ERROR "Emscripten.cmake toolchain file not found")
endif()

set(VCPKG_TARGET_ARCHITECTURE wasm32)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Emscripten)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${VCPKG_ROOT_DIR}/scripts/toolchains/emscripten.cmake")
