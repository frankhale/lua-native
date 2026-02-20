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

// Holds a reference to userdata.
// For JS-created userdata: ref_id maps to a JS object, registry_ref is LUA_NOREF.
// For Lua-created userdata (opaque passthrough): ref_id is -1, registry_ref holds the Lua registry reference.
struct LuaUserdataRef {
  int ref_id;           // JS object map key (-1 if opaque/Lua-created)
  int registry_ref;     // Lua registry ref (for opaque/Lua-created passthrough)
  lua_State* L;
  bool opaque;          // true = Lua-created userdata (can't inspect internals)
  bool proxy;           // true = property access enabled (__index/__newindex)

  LuaUserdataRef(int id, lua_State* state, bool is_opaque = false,
                 int reg_ref = LUA_NOREF, bool is_proxy = false)
    : ref_id(id), registry_ref(reg_ref), L(state),
      opaque(is_opaque), proxy(is_proxy) {}

  LuaUserdataRef(const LuaUserdataRef&) = default;
  LuaUserdataRef& operator=(const LuaUserdataRef&) = default;

  LuaUserdataRef(LuaUserdataRef&& other) noexcept
    : ref_id(other.ref_id), registry_ref(other.registry_ref),
      L(other.L), opaque(other.opaque), proxy(other.proxy) {
    other.registry_ref = LUA_NOREF;
    other.L = nullptr;
  }

  LuaUserdataRef& operator=(LuaUserdataRef&& other) noexcept {
    if (this != &other) {
      release();
      ref_id = other.ref_id;
      registry_ref = other.registry_ref;
      L = other.L;
      opaque = other.opaque;
      proxy = other.proxy;
      other.registry_ref = LUA_NOREF;
      other.L = nullptr;
    }
    return *this;
  }

  void release() {
    if (opaque && L && registry_ref != LUA_NOREF) {
      luaL_unref(L, LUA_REGISTRYINDEX, registry_ref);
      registry_ref = LUA_NOREF;
    }
  }
};

// Holds a reference to a Lua table in the registry.
// Used for metatabled tables to preserve metamethods across the JS boundary.
struct LuaTableRef {
  int ref;
  lua_State* L;

  LuaTableRef(int r, lua_State* state) : ref(r), L(state) {}

  LuaTableRef(const LuaTableRef&) = default;
  LuaTableRef& operator=(const LuaTableRef&) = default;

  LuaTableRef(LuaTableRef&& other) noexcept
      : ref(other.ref), L(other.L) {
    other.ref = LUA_NOREF;
    other.L = nullptr;
  }
  LuaTableRef& operator=(LuaTableRef&& other) noexcept {
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

struct MetatableEntry {
  std::string key;
  bool is_function;
  std::string func_name;  // Used when is_function == true
  LuaPtr value;           // Used when is_function == false
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
      LuaThreadRef,
      LuaUserdataRef,
      LuaTableRef>;
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
  static LuaValue from(LuaUserdataRef&& ref) { return LuaValue{Variant{std::move(ref)}}; }
  static LuaValue from(LuaTableRef&& ref) { return LuaValue{Variant{std::move(ref)}}; }
};

using ScriptResult = std::variant<std::vector<LuaPtr>, std::string>;
using CompileResult = std::variant<std::vector<uint8_t>, std::string>;

class LuaRuntime {
public:
  using Function = std::function<LuaPtr(const std::vector<LuaPtr>&)>;
  using UserdataGCCallback = std::function<void(int)>;
  using PropertyGetter = std::function<LuaPtr(int, const std::string&)>;
  using PropertySetter = std::function<void(int, const std::string&, const LuaPtr&)>;

  LuaRuntime();
  explicit LuaRuntime(const std::vector<std::string>& libraries);
  ~LuaRuntime();

  static std::vector<std::string> AllLibraries();
  static std::vector<std::string> SafeLibraries();

  LuaRuntime(const LuaRuntime&) = delete;
  LuaRuntime& operator=(const LuaRuntime&) = delete;
  LuaRuntime(LuaRuntime&&) = delete;
  LuaRuntime& operator=(LuaRuntime&&) = delete;

  [[nodiscard]] ScriptResult ExecuteScript(const std::string& script) const;
  [[nodiscard]] ScriptResult ExecuteFile(const std::string& filepath) const;

  [[nodiscard]] CompileResult CompileScript(const std::string& script,
                                             bool strip_debug = false,
                                             const std::string& chunk_name = "") const;
  [[nodiscard]] CompileResult CompileFile(const std::string& filepath,
                                           bool strip_debug = false) const;
  [[nodiscard]] ScriptResult LoadBytecode(const std::vector<uint8_t>& bytecode,
                                           const std::string& chunk_name = "bytecode") const;

  void SetGlobal(const std::string& name, const LuaPtr& value) const;
  void RegisterFunction(const std::string& name, Function fn);

  [[nodiscard]] LuaPtr GetGlobal(const std::string& name) const;

  [[nodiscard]] ScriptResult CallFunction(const LuaFunctionRef& funcRef,
                                          const std::vector<LuaPtr>& args) const;

  // Coroutine support
  [[nodiscard]] std::variant<LuaThreadRef, std::string> CreateCoroutine(const LuaFunctionRef& funcRef) const;
  [[nodiscard]] CoroutineResult ResumeCoroutine(const LuaThreadRef& threadRef,
                                                 const std::vector<LuaPtr>& args) const;
  [[nodiscard]] CoroutineStatus GetCoroutineStatus(const LuaThreadRef& threadRef) const;

  // Userdata support
  void SetUserdataGCCallback(UserdataGCCallback cb);
  void SetPropertyHandlers(PropertyGetter getter, PropertySetter setter);

  void SetAsyncMode(bool enabled);
  bool IsAsyncMode() const;
  // Metatable support
  void StoreHostFunction(const std::string& name, Function fn);
  void SetGlobalMetatable(const std::string& name, const std::vector<MetatableEntry>& entries);

  // Module / require support
  void AddSearchPath(const std::string& path) const;
  void RegisterModuleTable(const std::string& name, const std::vector<MetatableEntry>& entries) const;

  void CreateUserdataGlobal(const std::string& name, int ref_id);
  void CreateProxyUserdataGlobal(const std::string& name, int ref_id);
  void IncrementUserdataRefCount(int ref_id);
  void DecrementUserdataRefCount(int ref_id);

  /// Register a method table for a userdata ref_id.
  /// method_map: maps Lua-facing method name -> host function name
  void SetUserdataMethodTable(int ref_id,
      const std::unordered_map<std::string, std::string>& method_map);

  // Table reference operations (for metatabled tables preserved as refs)
  [[nodiscard]] LuaPtr GetTableField(int registry_ref, const std::string& key) const;
  void SetTableField(int registry_ref, const std::string& key, const LuaPtr& value) const;
  [[nodiscard]] bool HasTableField(int registry_ref, const std::string& key) const;
  [[nodiscard]] std::vector<std::string> GetTableKeys(int registry_ref) const;
  [[nodiscard]] int GetTableLength(int registry_ref) const;

  [[nodiscard]] lua_State* RawState() const { return L_; }

  static LuaPtr ToLuaValue(lua_State* L, int index, int depth = 0);
  static void PushLuaValue(lua_State* L, const LuaPtr& value, int depth = 0);

  void StoreFunctionData(void* data, void (*destructor)(void*)) {
    stored_function_data_.emplace_back(data, destructor);
  }

  static constexpr int kMaxDepth = 100;
  static constexpr const char* kUserdataMetaName = "lua_native_userdata";
  static constexpr const char* kProxyUserdataMetaName = "lua_native_proxy_userdata";

private:
  lua_State* L_ { nullptr };
  std::unordered_map<std::string, Function> host_functions_;
  std::vector<std::pair<void*, void (*)(void*)>> stored_function_data_;

  // Userdata support
  UserdataGCCallback userdata_gc_callback_;
  std::unordered_map<int, int> userdata_ref_counts_;
  PropertyGetter property_getter_;
  PropertySetter property_setter_;
  bool async_mode_ = false;

  void InitState();
  static int LibraryMask(const std::vector<std::string>& libraries);
  bool HasPackageLibrary() const;

  void RegisterUserdataMetatable();
  void RegisterProxyUserdataMetatable();

  static int LuaCallHostFunction(lua_State* L);
  static int UserdataGC(lua_State* L);
  static int UserdataIndex(lua_State* L);
  static int UserdataNewIndex(lua_State* L);
  static int UserdataMethodCall(lua_State* L);
};

} // namespace lua_core
