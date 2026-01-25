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

// Holds a reference to a Lua function in the registry.
// Note: Copies share the same registry ref - only one should call release().
// Prefer moving when transferring ownership.
struct LuaFunctionRef {
  int ref;
  lua_State* L;

  LuaFunctionRef(int r, lua_State* state) : ref(r), L(state) {}

  // Default copy (shares the same ref - be careful with release())
  LuaFunctionRef(const LuaFunctionRef&) = default;
  LuaFunctionRef& operator=(const LuaFunctionRef&) = default;

  // Move transfers ownership (source becomes invalid)
  LuaFunctionRef(LuaFunctionRef&& other) noexcept
      : ref(other.ref), L(other.L) {
    other.ref = LUA_NOREF;
    other.L = nullptr;
  }
  LuaFunctionRef& operator=(LuaFunctionRef&& other) noexcept {
    if (this != &other) {
      release();
      ref = other.ref;
      L = other.L;
      other.ref = LUA_NOREF;
      other.L = nullptr;
    }
    return *this;
  }

  void release() {
    if (L && ref != LUA_NOREF) {
      luaL_unref(L, LUA_REGISTRYINDEX, ref);
      ref = LUA_NOREF;
    }
  }
};

// Holds a reference to a Lua coroutine thread in the registry.
// Note: Copies share the same registry ref - only one should call release().
// Prefer moving when transferring ownership.
struct LuaThreadRef {
  int ref;
  lua_State* L;        // Main state
  lua_State* thread;   // The coroutine thread

  LuaThreadRef(int r, lua_State* mainState, lua_State* threadState)
    : ref(r), L(mainState), thread(threadState) {}

  // Default copy (shares the same ref - be careful with release())
  LuaThreadRef(const LuaThreadRef&) = default;
  LuaThreadRef& operator=(const LuaThreadRef&) = default;

  // Move transfers ownership (source becomes invalid)
  LuaThreadRef(LuaThreadRef&& other) noexcept
      : ref(other.ref), L(other.L), thread(other.thread) {
    other.ref = LUA_NOREF;
    other.L = nullptr;
    other.thread = nullptr;
  }
  LuaThreadRef& operator=(LuaThreadRef&& other) noexcept {
    if (this != &other) {
      release();
      ref = other.ref;
      L = other.L;
      thread = other.thread;
      other.ref = LUA_NOREF;
      other.L = nullptr;
      other.thread = nullptr;
    }
    return *this;
  }

  void release() {
    if (L && ref != LUA_NOREF) {
      luaL_unref(L, LUA_REGISTRYINDEX, ref);
      ref = LUA_NOREF;
      thread = nullptr;
    }
  }
};

enum class CoroutineStatus {
  Suspended,
  Running,
  Dead
};

struct CoroutineResult {
  CoroutineStatus status;
  std::vector<LuaPtr> values;
  std::optional<std::string> error;
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
      LuaFunctionRef,
      LuaThreadRef>;
  Variant value;

  LuaValue() = default;
  explicit LuaValue(Variant v) : value(std::move(v)) {}

  // Convenience factory functions
  static LuaValue nil() { return LuaValue{Variant{std::monostate{}}}; }
  static LuaValue from(bool b) { return LuaValue{Variant{b}}; }
  static LuaValue from(int64_t i) { return LuaValue{Variant{i}}; }
  static LuaValue from(double d) { return LuaValue{Variant{d}}; }
  static LuaValue from(const std::string& s) { return LuaValue{Variant{s}}; }
  static LuaValue from(std::string&& s) { return LuaValue{Variant{std::move(s)}}; }
  static LuaValue from(LuaArray arr) { return LuaValue{Variant{std::move(arr)}}; }
  static LuaValue from(LuaTable tbl) { return LuaValue{Variant{std::move(tbl)}}; }
  static LuaValue from(LuaFunctionRef&& ref) { return LuaValue{Variant{std::move(ref)}}; }
  static LuaValue from(LuaThreadRef&& ref) { return LuaValue{Variant{std::move(ref)}}; }
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

  // Coroutine support
  [[nodiscard]] std::variant<LuaThreadRef, std::string> CreateCoroutine(const LuaFunctionRef& funcRef) const;
  [[nodiscard]] CoroutineResult ResumeCoroutine(const LuaThreadRef& threadRef,
                                                 const std::vector<LuaPtr>& args) const;
  [[nodiscard]] CoroutineStatus GetCoroutineStatus(const LuaThreadRef& threadRef) const;

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


