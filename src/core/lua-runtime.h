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

struct LuaValue {
  using Variant = std::variant<
      std::monostate,  // nil
      bool,
      int64_t,
      double,
      std::string,
      LuaArray,
      LuaTable>;
  Variant value;
};

// Result type: either values or an error message
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

  // Optional helper for advanced testing
  [[nodiscard]] std::optional<LuaPtr> GetGlobal(const std::string& name) const;

  [[nodiscard]] lua_State* RawState() const { return L_; }

  // Conversion helpers (exposed for testing)
  static LuaPtr ToLuaValue(lua_State* L, int index, int depth = 0);
  static void PushLuaValue(lua_State* L, const LuaPtr& value, int depth = 0);

private:
  lua_State* L_ { nullptr };
  std::unordered_map<std::string, Function> host_functions_;

  static int LuaCallHostFunction(lua_State* L);

  static constexpr int kMaxDepth = 100;
};

} // namespace lua_core


