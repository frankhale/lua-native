// How much of the JavaScript engine's stack is left (docs/WASM.md, "The engine's
// stack"). The other half of this is triplets/lua-wasm-stack.h, through which
// Lua's own C-call limit asks the same question.

#pragma once

namespace js {

// False when the engine's stack is too nearly spent to go on safely.
bool StackHeadroom();

}  // namespace js
