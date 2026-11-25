#include "stack.h"

#include <emscripten/em_js.h>

#include <algorithm>

// Is there room left on the engine's stack for what may happen before this is
// next asked? Only JavaScript can find out: the engine's refusal can be caught
// there and nowhere else. The shell sets `stackHeadroom` (shell.js, "headroom").
// clang-format off
EM_JS(int, lua_native_stack_headroom, (), {
  return Module['stackHeadroom']();
});
// clang-format on

namespace {

// Lua's own value, and how many nested C calls may pass between questions.
constexpr unsigned kLuaMaxCCalls = 200;
constexpr unsigned kStride = 8;
// Once Lua has been refused, how much further its error handling may go. Lua
// allows a tenth of the limit, which is 20 of 200.
constexpr unsigned kHandlingZone = 12;

// The count at which to ask next, and the one at which the answer was last no
// (0: none). Not per context: a count is only ever compared with the count
// of a call that is on the stack now, and a context entered at a lower count
// pulls `next_question` down with it.
struct Questions {
  unsigned next = kStride;
  unsigned refused_at = 0;
};

Questions& State() {
  static Questions state;
  return state;
}

}  // namespace

bool js::StackHeadroom() { return lua_native_stack_headroom() != 0; }

// The value LUAI_MAXCCALLS has for a thread whose count is `count`. Lua compares
// the two with >=, then ==, then >= eleven tenths, in separate evaluations, so
// the answer must not change between them.
extern "C" unsigned lua_native_max_c_calls(const unsigned count) {
  auto& [next_question, refused_at] = State();
  next_question = std::min(next_question, count + kStride);
  if (count < next_question) {
    if (count < refused_at) refused_at = 0;
    return kLuaMaxCCalls;
  }
  // At and past Lua's own limit there is nothing to ask: it refuses by itself.
  if (count >= kLuaMaxCCalls && refused_at == 0) return kLuaMaxCCalls;
  if (js::StackHeadroom()) {
    next_question = count + kStride;
    refused_at = 0;
    return kLuaMaxCCalls;
  }
  if (refused_at == 0 || count <= refused_at) {
    refused_at = count;
    return count;  // equal: "C stack overflow", an ordinary error
  }
  if (count < refused_at + kHandlingZone) return kLuaMaxCCalls;  // handling it
  return count / 2;  // well past it: an error while handling the error
}
