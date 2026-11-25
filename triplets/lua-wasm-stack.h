// Force-included into every file of Lua's own source by the overlay triplet
// (wasm32-emscripten.cmake). It replaces one constant, LUAI_MAXCCALLS: how many
// C calls may be nested before Lua raises "C stack overflow".
//
// Natively that is 200, chosen to fit the C stack. Here the frames are on the
// JavaScript engine's stack, whose size depends on the engine and the thread,
// and which ends the Lua context if it runs out (docs/WASM.md, "The engine's
// stack"). So the limit is asked for each time, with the count it is compared
// against, and src/wasm/stack.cpp answers 200 or whatever is safe.
//
// Every use of LUAI_MAXCCALLS in Lua 5.5 has a `lua_State *L` in scope and
// compares it with getCcalls(L). A version of Lua that uses it otherwise will
// not compile.
#pragma once

#ifdef __cplusplus
extern "C"
#endif
unsigned int lua_native_max_c_calls(unsigned int count);

#define LUAI_MAXCCALLS (lua_native_max_c_calls(getCcalls(L)))
