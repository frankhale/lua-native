#include "lua-runtime.h"

namespace lua_core {

namespace {
struct StackGuard {
  lua_State* L;
  int top;
  explicit StackGuard(lua_State* s) : L(s), top(lua_gettop(s)) {}
  ~StackGuard() { lua_settop(L, top); }
};

 bool isSequentialArray(lua_State* L, int index) {
  // Simple heuristic: treat as array if keys are 1..n with no gaps
  const int abs_index = lua_absindex(L, index);
  lua_Integer expected = 1;
  constexpr bool isArray = true;
  lua_pushnil(L);
  while (lua_next(L, abs_index) != 0) {
    if (!lua_isinteger(L, -2) || lua_tointeger(L, -2) != expected) {
      // Not a sequential array; pop value and key to balance the stack
      lua_pop(L, 2);
      return false;
    }
    expected++;
    lua_pop(L, 1);
  }
  return isArray;
}
} // namespace

LuaRuntime::LuaRuntime(const bool openStdLibs) {
  L_ = luaL_newstate();
  if (!L_) {
    throw std::runtime_error("Failed to create Lua state");
  }
  if (openStdLibs) {
    luaL_openlibs(L_);
  }
  // Store the runtime in registry for callbacks
  lua_pushlightuserdata(L_, this);
  lua_setfield(L_, LUA_REGISTRYINDEX, "_lua_core_runtime");
}

LuaRuntime::~LuaRuntime() {
  if (L_) {
    lua_close(L_);
    L_ = nullptr;
  }
}

int LuaRuntime::LuaCallHostFunction(lua_State* L) {
  const char* func_name = lua_tostring(L, lua_upvalueindex(1));

  // Get runtime
  lua_getfield(L, LUA_REGISTRYINDEX, "_lua_core_runtime");
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  if (!runtime) {
    lua_pushstring(L, "LuaRuntime not found in registry");
    lua_error(L);
    return 0;
  }

  const auto it = runtime->host_functions_.find(func_name ? func_name : "");
  if (it == runtime->host_functions_.end()) {
    lua_pushfstring(L, "Host function '%s' not found", func_name ? func_name : "");
    lua_error(L);
    return 0;
  }

  const int argc = lua_gettop(L);
  std::vector<LuaPtr> args;
  args.reserve(argc);
  for (int i = 1; i <= argc; ++i) {
    args.push_back(ToLuaValue(L, i));
  }

  LuaPtr resultHolder;
  try {
    resultHolder = it->second(args);
  } catch (...) {
    lua_pushstring(L, "Host function threw an exception");
    lua_error(L);
    return 0;
  }

  PushLuaValue(L, resultHolder);
  return 1;
}

ScriptResult LuaRuntime::ExecuteScript(const std::string& script) const {
  if (luaL_loadstring(L_, script.c_str()) || lua_pcall(L_, 0, LUA_MULTRET, 0)) {
    std::string error = lua_tostring(L_, -1);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_);
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  for (int i = 1; i <= nresults; ++i) {
    results.push_back(ToLuaValue(L_, i));
  }
  lua_pop(L_, nresults);
  return results;
}

void LuaRuntime::SetGlobal(const std::string& name, const LuaPtr& value) const {
  PushLuaValue(L_, value);
  lua_setglobal(L_, name.c_str());
}

void LuaRuntime::RegisterFunction(const std::string& name, Function fn) {
  host_functions_[name] = std::move(fn);
  lua_pushstring(L_, name.c_str());
  lua_pushcclosure(L_, LuaCallHostFunction, 1);
  lua_setglobal(L_, name.c_str());
}

std::optional<LuaPtr> LuaRuntime::GetGlobal(const std::string& name) const {
  lua_getglobal(L_, name.c_str());
  LuaPtr v = ToLuaValue(L_, -1);
  lua_pop(L_, 1);
  return v;
}

LuaPtr LuaRuntime::ToLuaValue(lua_State* L, const int index, const int depth) {
  if (depth > kMaxDepth) return std::make_shared<LuaValue>(LuaValue{LuaValue::Variant{std::monostate{}}});
  switch (const int abs_index = lua_absindex(L, index); lua_type(L, abs_index)) {
    case LUA_TNIL:
      return std::make_shared<LuaValue>(LuaValue{LuaValue::Variant{std::monostate{}}});
    case LUA_TNUMBER:
      if (lua_isinteger(L, abs_index)) {
        return std::make_shared<LuaValue>(LuaValue{LuaValue::Variant{static_cast<int64_t>(lua_tointeger(L, abs_index))}});
      } else {
        return std::make_shared<LuaValue>(LuaValue{LuaValue::Variant{static_cast<double>(lua_tonumber(L, abs_index))}});
      }
    case LUA_TBOOLEAN:
      return std::make_shared<LuaValue>(LuaValue{LuaValue::Variant{static_cast<bool>(lua_toboolean(L, abs_index))}});
    case LUA_TSTRING: {
      size_t len;
      const char* str = lua_tolstring(L, abs_index, &len);
      return std::make_shared<LuaValue>(LuaValue{LuaValue::Variant{std::string(str, len)}});
    }
    case LUA_TTABLE: {
      StackGuard guard(L);
      if (isSequentialArray(L, abs_index)) {
        LuaArray arr;
        const int len = static_cast<int>(lua_rawlen(L, abs_index));
        arr.reserve(len);
        for (int i = 1; i <= len; ++i) {
          lua_rawgeti(L, abs_index, i);
          arr.push_back(ToLuaValue(L, -1, depth + 1));
          lua_pop(L, 1);
        }
        return std::make_shared<LuaValue>(LuaValue{LuaValue::Variant{std::move(arr)}});
      }

      LuaTable map;
      lua_pushnil(L);
      while (lua_next(L, abs_index) != 0) {
        std::string key;
        if (lua_type(L, -2) == LUA_TSTRING) {
          size_t len;
          const char* str = lua_tolstring(L, -2, &len);
          key.assign(str, len);
        } else if (lua_type(L, -2) == LUA_TNUMBER) {
          lua_pushvalue(L, -2);
          key = lua_tostring(L, -1);
          lua_pop(L, 1);
        } else {
          lua_pop(L, 1);
          continue;
        }
        map.emplace(std::move(key), ToLuaValue(L, -1, depth + 1));
        lua_pop(L, 1);
      }
      return std::make_shared<LuaValue>(LuaValue{LuaValue::Variant{std::move(map)}});
    }
    default:
      return std::make_shared<LuaValue>(LuaValue{LuaValue::Variant{std::monostate{}}});
  }
}

void LuaRuntime::PushLuaValue(lua_State* L, const LuaPtr& value, const int depth) {
  if (depth > kMaxDepth) { lua_pushnil(L); return; }
  std::visit(
      [&](const auto& v) {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, std::monostate>) {
          lua_pushnil(L);
        } else if constexpr (std::is_same_v<T, bool>) {
          lua_pushboolean(L, v);
        } else if constexpr (std::is_same_v<T, int64_t>) {
          lua_pushinteger(L, static_cast<lua_Integer>(v));
        } else if constexpr (std::is_same_v<T, double>) {
          lua_pushnumber(L, static_cast<lua_Number>(v));
        } else if constexpr (std::is_same_v<T, std::string>) {
          lua_pushlstring(L, v.c_str(), v.size());
        } else if constexpr (std::is_same_v<T, LuaArray>) {
          lua_newtable(L);
          int idx = 1;
          for (const auto& item : v) {
            PushLuaValue(L, item, depth + 1);
            lua_rawseti(L, -2, idx++);
          }
        } else if constexpr (std::is_same_v<T, LuaTable>) {
          lua_newtable(L);
          for (const auto& [k, val] : v) {
            lua_pushlstring(L, k.c_str(), k.size());
            PushLuaValue(L, val, depth + 1);
            lua_settable(L, -3);
          }
        }
      },
      value->value);
}

} // namespace lua_core


