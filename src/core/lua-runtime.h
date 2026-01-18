#pragma once

#include <lua.hpp>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>
#include <memory>
#include <stdexcept>

namespace lua_core {

struct LuaValue;
using LuaPtr = std::shared_ptr<LuaValue>;
using LuaArray = std::vector<LuaPtr>;
using LuaTable = std::unordered_map<std::string, LuaPtr>;

struct LuaFunctionRef {
  int ref;
  lua_State* L;

  LuaFunctionRef(int r, lua_State* state) : ref(r), L(state) {}

  void release() {
    if (L && ref != LUA_NOREF) {
      luaL_unref(L, LUA_REGISTRYINDEX, ref);
      ref = LUA_NOREF;
    }
  }
};

struct LuaValue {
  using Variant = std::variant<
      std::monostate,  // nil
      bool,
      int64_t,
      double,
      std::string,
      LuaArray,
      LuaTable,
      LuaFunctionRef>;
  Variant value;
};

using ScriptResult = std::variant<std::vector<LuaPtr>, std::string>;

class LuaRuntime {
public:
  using Function = std::function<LuaPtr(const std::vector<LuaPtr>&)>;

  explicit LuaRuntime(bool openStdLibs = true);
  ~LuaRuntime();

  LuaRuntime(const LuaRuntime&) = delete;
  LuaRuntime& operator=(const LuaRuntime&) = delete;
  LuaRuntime(LuaRuntime&&) = delete;
  LuaRuntime& operator=(LuaRuntime&&) = delete;

  [[nodiscard]] ScriptResult ExecuteScript(const std::string& script) const;

  void SetGlobal(const std::string& name, const LuaPtr& value) const;
  void RegisterFunction(const std::string& name, Function fn);

  [[nodiscard]] std::optional<LuaPtr> GetGlobal(const std::string& name) const;

  [[nodiscard]] ScriptResult CallFunction(const LuaFunctionRef& funcRef,
                                          const std::vector<LuaPtr>& args) const;

  [[nodiscard]] lua_State* RawState() const { return L_; }

  static LuaPtr ToLuaValue(lua_State* L, int index, int depth = 0);
  static void PushLuaValue(lua_State* L, const LuaPtr& value, int depth = 0);

  void StoreFunctionData(void* data, void (*destructor)(void*)) {
    stored_function_data_.emplace_back(data, destructor);
  }

private:
  lua_State* L_ { nullptr };
  std::unordered_map<std::string, Function> host_functions_;
  std::vector<std::pair<void*, void (*)(void*)>> stored_function_data_;

  static int LuaCallHostFunction(lua_State* L);

  static constexpr int kMaxDepth = 100;
};

} // namespace lua_core


