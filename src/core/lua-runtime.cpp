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
  const int abs_index = lua_absindex(L, index);
  lua_Integer expected = 1;
  lua_pushnil(L);
  while (lua_next(L, abs_index) != 0) {
    if (!lua_isinteger(L, -2) || lua_tointeger(L, -2) != expected) {
      lua_pop(L, 2);
      return false;
    }
    expected++;
    lua_pop(L, 1);
  }
  return true;
}
} // namespace

// Map from user-facing library name to the Lua 5.5 bitmask constant
static const std::unordered_map<std::string, int> kLibFlags = {
  {"base",      LUA_GLIBK},
  {"package",   LUA_LOADLIBK},
  {"coroutine", LUA_COLIBK},
  {"debug",     LUA_DBLIBK},
  {"io",        LUA_IOLIBK},
  {"math",      LUA_MATHLIBK},
  {"os",        LUA_OSLIBK},
  {"string",    LUA_STRLIBK},
  {"table",     LUA_TABLIBK},
  {"utf8",      LUA_UTF8LIBK},
};

int LuaRuntime::LibraryMask(const std::vector<std::string>& libraries) {
  int mask = 0;
  for (const auto& lib : libraries) {
    const auto it = kLibFlags.find(lib);
    if (it == kLibFlags.end()) {
      throw std::runtime_error("Unknown Lua library: '" + lib + "'");
    }
    mask |= it->second;
  }
  return mask;
}

void LuaRuntime::InitState() {
  // Store the runtime in registry for callbacks
  lua_pushlightuserdata(L_, this);
  lua_setfield(L_, LUA_REGISTRYINDEX, "_lua_core_runtime");

  // Register userdata metatables
  RegisterUserdataMetatable();
  RegisterProxyUserdataMetatable();
}

std::vector<std::string> LuaRuntime::AllLibraries() {
  return {"base", "package", "coroutine", "table", "io", "os", "string", "math", "utf8", "debug"};
}

std::vector<std::string> LuaRuntime::SafeLibraries() {
  return {"base", "package", "coroutine", "table", "string", "math", "utf8"};
}

LuaRuntime::LuaRuntime() {
  L_ = luaL_newstate();
  if (!L_) {
    throw std::runtime_error("Failed to create Lua state");
  }
  InitState();
}

LuaRuntime::LuaRuntime(const std::vector<std::string>& libraries) {
  L_ = luaL_newstate();
  if (!L_) {
    throw std::runtime_error("Failed to create Lua state");
  }
  if (!libraries.empty()) {
    luaL_openselectedlibs(L_, LibraryMask(libraries), 0);
  }
  InitState();
}

LuaRuntime::~LuaRuntime() {
  // Clean up stored function data
  for (auto& [data, destructor] : stored_function_data_) {
    if (destructor) destructor(data);
  }
  stored_function_data_.clear();

  if (L_) {
    lua_close(L_);
    L_ = nullptr;
  }
}

// --- Userdata metatable registration ---

void LuaRuntime::RegisterUserdataMetatable() {
  luaL_newmetatable(L_, kUserdataMetaName);
  lua_pushcfunction(L_, UserdataGC);
  lua_setfield(L_, -2, "__gc");
  lua_pop(L_, 1);
}

void LuaRuntime::RegisterProxyUserdataMetatable() {
  luaL_newmetatable(L_, kProxyUserdataMetaName);
  lua_pushcfunction(L_, UserdataGC);
  lua_setfield(L_, -2, "__gc");
  lua_pushcfunction(L_, UserdataIndex);
  lua_setfield(L_, -2, "__index");
  lua_pushcfunction(L_, UserdataNewIndex);
  lua_setfield(L_, -2, "__newindex");
  lua_pop(L_, 1);
}

// --- Userdata metamethods ---

int LuaRuntime::UserdataGC(lua_State* L) {
  auto* block = static_cast<int*>(lua_touserdata(L, 1));
  if (!block) return 0;

  lua_getfield(L, LUA_REGISTRYINDEX, "_lua_core_runtime");
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  if (runtime) {
    runtime->DecrementUserdataRefCount(*block);
  }
  return 0;
}

int LuaRuntime::UserdataIndex(lua_State* L) {
  auto* block = static_cast<int*>(lua_touserdata(L, 1));
  if (!block) return 0;

  const char* key = lua_tostring(L, 2);
  if (!key) return 0;

  lua_getfield(L, LUA_REGISTRYINDEX, "_lua_core_runtime");
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  if (runtime && runtime->property_getter_) {
    try {
      auto result = runtime->property_getter_(*block, key);
      PushLuaValue(L, result);
      return 1;
    } catch (const std::exception& e) {
      lua_pushfstring(L, "Error reading property '%s': %s", key, e.what());
      lua_error(L);
    }
  }
  lua_pushnil(L);
  return 1;
}

int LuaRuntime::UserdataNewIndex(lua_State* L) {
  auto* block = static_cast<int*>(lua_touserdata(L, 1));
  if (!block) return 0;

  const char* key = lua_tostring(L, 2);
  if (!key) return 0;

  lua_getfield(L, LUA_REGISTRYINDEX, "_lua_core_runtime");
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  if (runtime && runtime->property_setter_) {
    try {
      auto value = ToLuaValue(L, 3);
      runtime->property_setter_(*block, key, value);
    } catch (const std::exception& e) {
      lua_pushfstring(L, "Error writing property '%s': %s", key, e.what());
      lua_error(L);
    }
  }
  return 0;
}

// --- Userdata support methods ---

void LuaRuntime::SetUserdataGCCallback(UserdataGCCallback cb) {
  userdata_gc_callback_ = std::move(cb);
}

void LuaRuntime::SetPropertyHandlers(PropertyGetter getter, PropertySetter setter) {
  property_getter_ = std::move(getter);
  property_setter_ = std::move(setter);
}

void LuaRuntime::SetAsyncMode(bool enabled) { async_mode_ = enabled; }
bool LuaRuntime::IsAsyncMode() const { return async_mode_; }

void LuaRuntime::CreateUserdataGlobal(const std::string& name, int ref_id) {
  auto* block = static_cast<int*>(lua_newuserdata(L_, sizeof(int)));
  *block = ref_id;
  luaL_setmetatable(L_, kUserdataMetaName);
  lua_setglobal(L_, name.c_str());
  IncrementUserdataRefCount(ref_id);
}

void LuaRuntime::CreateProxyUserdataGlobal(const std::string& name, int ref_id) {
  auto* block = static_cast<int*>(lua_newuserdata(L_, sizeof(int)));
  *block = ref_id;
  luaL_setmetatable(L_, kProxyUserdataMetaName);
  lua_setglobal(L_, name.c_str());
  IncrementUserdataRefCount(ref_id);
}

void LuaRuntime::IncrementUserdataRefCount(int ref_id) {
  userdata_ref_counts_[ref_id]++;
}

void LuaRuntime::DecrementUserdataRefCount(int ref_id) {
  auto it = userdata_ref_counts_.find(ref_id);
  if (it != userdata_ref_counts_.end()) {
    if (--it->second <= 0) {
      userdata_ref_counts_.erase(it);
      if (userdata_gc_callback_) {
        userdata_gc_callback_(ref_id);
      }
    }
  }
}

// --- Metatable support ---

void LuaRuntime::StoreHostFunction(const std::string& name, Function fn) {
  host_functions_[name] = std::move(fn);
}

void LuaRuntime::SetGlobalMetatable(const std::string& name, const std::vector<MetatableEntry>& entries) {
  StackGuard guard(L_);

  lua_getglobal(L_, name.c_str());
  if (lua_isnil(L_, -1)) {
    throw std::runtime_error("Global '" + name + "' does not exist");
  }
  if (!lua_istable(L_, -1)) {
    throw std::runtime_error("Global '" + name + "' is not a table");
  }

  // Create the metatable
  lua_newtable(L_);

  for (const auto& entry : entries) {
    if (entry.is_function) {
      // Push function name as upvalue, then create closure
      lua_pushstring(L_, entry.func_name.c_str());
      lua_pushcclosure(L_, LuaCallHostFunction, 1);
    } else {
      PushLuaValue(L_, entry.value);
    }
    lua_setfield(L_, -2, entry.key.c_str());
  }

  // Set the metatable on the target table (pops metatable)
  lua_setmetatable(L_, -2);
}

// --- Module / require support ---

bool LuaRuntime::HasPackageLibrary() const {
  StackGuard guard(L_);
  lua_getglobal(L_, "package");
  bool has = !lua_isnil(L_, -1) && lua_istable(L_, -1);
  return has;
}

void LuaRuntime::AddSearchPath(const std::string& path) const {
  StackGuard guard(L_);

  if (!HasPackageLibrary()) {
    throw std::runtime_error(
      "Cannot add search path: the 'package' library is not loaded. "
      "Include 'package' in the libraries option.");
  }

  lua_getglobal(L_, "package");

  // Get current package.path
  lua_getfield(L_, -1, "path");
  const char* current_raw = lua_tostring(L_, -1);
  std::string current = current_raw ? current_raw : "";
  lua_pop(L_, 1);  // pop path string

  // Append the new path
  if (!current.empty()) {
    current += ";";
  }
  current += path;

  // Set the updated package.path
  lua_pushstring(L_, current.c_str());
  lua_setfield(L_, -2, "path");
}

void LuaRuntime::RegisterModuleTable(const std::string& name,
                                      const std::vector<MetatableEntry>& entries) const {
  StackGuard guard(L_);

  if (!HasPackageLibrary()) {
    throw std::runtime_error(
      "Cannot register module: the 'package' library is not loaded. "
      "Include 'package' in the libraries option.");
  }

  lua_getglobal(L_, "package");
  lua_getfield(L_, -1, "loaded");
  if (lua_isnil(L_, -1)) {
    throw std::runtime_error(
      "Cannot register module: package.loaded is not available.");
  }

  // Create the module table
  lua_newtable(L_);

  for (const auto& entry : entries) {
    if (entry.is_function) {
      // Push function name as upvalue, then create closure
      lua_pushstring(L_, entry.func_name.c_str());
      lua_pushcclosure(L_, LuaCallHostFunction, 1);
    } else {
      PushLuaValue(L_, entry.value);
    }
    lua_setfield(L_, -2, entry.key.c_str());
  }

  // package.loaded[name] = module_table
  lua_setfield(L_, -2, name.c_str());
}

// --- Host function bridge ---

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

  if (runtime->async_mode_) {
    return luaL_error(L,
      "JS callbacks are not available in async mode (called '%s')",
      func_name ? func_name : "<unknown>");
  }

  const int argc = lua_gettop(L);
  std::vector<LuaPtr> args;
  args.reserve(argc);
  try {
    for (int i = 1; i <= argc; ++i) {
      args.push_back(ToLuaValue(L, i));
    }
  } catch (const std::exception& e) {
    lua_pushfstring(L, "Error converting arguments for '%s': %s",
                    func_name ? func_name : "<unknown>", e.what());
    lua_error(L);
    return 0;
  }

  LuaPtr resultHolder;
  try {
    resultHolder = it->second(args);
  } catch (const std::exception& e) {
    lua_pushfstring(L, "Host function '%s' threw an exception: %s",
                    func_name ? func_name : "<unknown>", e.what());
    lua_error(L);
    return 0;
  } catch (...) {
    lua_pushfstring(L, "Host function '%s' threw an unknown exception",
                    func_name ? func_name : "<unknown>");
    lua_error(L);
    return 0;
  }

  try {
    PushLuaValue(L, resultHolder);
  } catch (const std::exception& e) {
    lua_pushfstring(L, "Error converting return value from '%s': %s",
                    func_name ? func_name : "<unknown>", e.what());
    lua_error(L);
    return 0;
  }
  return 1;
}

CompileResult LuaRuntime::CompileScript(const std::string& script,
                                         bool strip_debug,
                                         const std::string& chunk_name) const {
  StackGuard guard(L_);

  int status;
  if (!chunk_name.empty()) {
    status = luaL_loadbuffer(L_, script.c_str(), script.size(), chunk_name.c_str());
  } else {
    status = luaL_loadstring(L_, script.c_str());
  }

  if (status != LUA_OK) {
    std::string err = lua_tostring(L_, -1);
    return err;
  }

  std::vector<uint8_t> bytecode;
  lua_dump(L_, [](lua_State*, const void* p, size_t sz, void* ud) -> int {
    auto* bc = static_cast<std::vector<uint8_t>*>(ud);
    auto* bytes = static_cast<const uint8_t*>(p);
    bc->insert(bc->end(), bytes, bytes + sz);
    return 0;
  }, &bytecode, strip_debug ? 1 : 0);

  return bytecode;
}

CompileResult LuaRuntime::CompileFile(const std::string& filepath,
                                       bool strip_debug) const {
  if (filepath.empty()) {
    return std::string("File path cannot be empty");
  }

  StackGuard guard(L_);

  if (luaL_loadfile(L_, filepath.c_str()) != LUA_OK) {
    std::string err = lua_tostring(L_, -1);
    return err;
  }

  std::vector<uint8_t> bytecode;
  lua_dump(L_, [](lua_State*, const void* p, size_t sz, void* ud) -> int {
    auto* bc = static_cast<std::vector<uint8_t>*>(ud);
    auto* bytes = static_cast<const uint8_t*>(p);
    bc->insert(bc->end(), bytes, bytes + sz);
    return 0;
  }, &bytecode, strip_debug ? 1 : 0);

  return bytecode;
}

ScriptResult LuaRuntime::LoadBytecode(const std::vector<uint8_t>& bytecode,
                                       const std::string& chunk_name) const {
  if (bytecode.empty()) {
    return std::string("Bytecode cannot be empty");
  }

  const int stackBefore = lua_gettop(L_);

  struct ReaderData {
    const uint8_t* data;
    size_t size;
    bool consumed;
  };
  ReaderData reader{bytecode.data(), bytecode.size(), false};

  int status = lua_load(L_,
    [](lua_State*, void* ud, size_t* sz) -> const char* {
      auto* r = static_cast<ReaderData*>(ud);
      if (r->consumed) {
        *sz = 0;
        return nullptr;
      }
      *sz = r->size;
      r->consumed = true;
      return reinterpret_cast<const char*>(r->data);
    },
    &reader, chunk_name.c_str(), "b");

  if (status != LUA_OK) {
    std::string error = lua_tostring(L_, -1);
    lua_pop(L_, 1);
    return error;
  }

  if (lua_pcall(L_, 0, LUA_MULTRET, 0) != LUA_OK) {
    std::string error = lua_tostring(L_, -1);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_) - stackBefore;
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  try {
    for (int i = 0; i < nresults; ++i) {
      results.push_back(ToLuaValue(L_, stackBefore + 1 + i));
    }
  } catch (const std::exception& e) {
    lua_pop(L_, nresults);
    return std::string(e.what());
  }
  lua_pop(L_, nresults);
  return results;
}

ScriptResult LuaRuntime::ExecuteScript(const std::string& script) const {
  const int stackBefore = lua_gettop(L_);

  if (luaL_loadstring(L_, script.c_str()) || lua_pcall(L_, 0, LUA_MULTRET, 0)) {
    std::string error = lua_tostring(L_, -1);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_) - stackBefore;
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  try {
    for (int i = 0; i < nresults; ++i) {
      results.push_back(ToLuaValue(L_, stackBefore + 1 + i));
    }
  } catch (const std::exception& e) {
    lua_pop(L_, nresults);
    return std::string(e.what());
  }
  lua_pop(L_, nresults);
  return results;
}

ScriptResult LuaRuntime::ExecuteFile(const std::string& filepath) const {
  if (filepath.empty()) {
    return std::string("File path cannot be empty");
  }

  const int stackBefore = lua_gettop(L_);

  if (luaL_loadfile(L_, filepath.c_str()) || lua_pcall(L_, 0, LUA_MULTRET, 0)) {
    std::string error = lua_tostring(L_, -1);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_) - stackBefore;
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  try {
    for (int i = 0; i < nresults; ++i) {
      results.push_back(ToLuaValue(L_, stackBefore + 1 + i));
    }
  } catch (const std::exception& e) {
    lua_pop(L_, nresults);
    return std::string(e.what());
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

LuaPtr LuaRuntime::GetGlobal(const std::string& name) const {
  StackGuard guard(L_);
  lua_getglobal(L_, name.c_str());
  return ToLuaValue(L_, -1);
}

ScriptResult LuaRuntime::CallFunction(const LuaFunctionRef& funcRef,
                                      const std::vector<LuaPtr>& args) const {
  const int stackBefore = lua_gettop(L_);

  lua_rawgeti(L_, LUA_REGISTRYINDEX, funcRef.ref);

  for (const auto& arg : args) {
    PushLuaValue(L_, arg);
  }

  if (lua_pcall(L_, static_cast<int>(args.size()), LUA_MULTRET, 0) != LUA_OK) {
    std::string error = lua_tostring(L_, -1);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_) - stackBefore;
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  try {
    for (int i = 0; i < nresults; ++i) {
      results.push_back(ToLuaValue(L_, stackBefore + 1 + i));
    }
  } catch (const std::exception& e) {
    lua_pop(L_, nresults);
    return std::string(e.what());
  }
  lua_pop(L_, nresults);
  return results;
}

// --- Value conversion ---

LuaPtr LuaRuntime::ToLuaValue(lua_State* L, const int index, const int depth) {
  if (depth > kMaxDepth) {
    throw std::runtime_error("Value nesting depth exceeds the maximum of " + std::to_string(kMaxDepth) + " levels");
  }
  switch (const int abs_index = lua_absindex(L, index); lua_type(L, abs_index)) {
    case LUA_TNIL:
      return std::make_shared<LuaValue>(LuaValue::nil());
    case LUA_TNUMBER:
      if (lua_isinteger(L, abs_index)) {
        return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(lua_tointeger(L, abs_index))));
      } else {
        return std::make_shared<LuaValue>(LuaValue::from(static_cast<double>(lua_tonumber(L, abs_index))));
      }
    case LUA_TBOOLEAN:
      return std::make_shared<LuaValue>(LuaValue::from(static_cast<bool>(lua_toboolean(L, abs_index))));
    case LUA_TSTRING: {
      size_t len;
      const char* str = lua_tolstring(L, abs_index, &len);
      return std::make_shared<LuaValue>(LuaValue::from(std::string(str, len)));
    }
    case LUA_TTABLE: {
      StackGuard guard(L);
      // Metatabled tables are kept as registry references to preserve metamethods
      if (lua_getmetatable(L, abs_index)) {
        lua_pop(L, 1);  // pop metatable
        lua_pushvalue(L, abs_index);
        int ref = luaL_ref(L, LUA_REGISTRYINDEX);
        return std::make_shared<LuaValue>(LuaValue::from(LuaTableRef(ref, L)));
      }
      // Plain tables (no metatable) are deep-copied as before
      if (isSequentialArray(L, abs_index)) {
        LuaArray arr;
        const int len = static_cast<int>(lua_rawlen(L, abs_index));
        arr.reserve(len);
        for (int i = 1; i <= len; ++i) {
          lua_rawgeti(L, abs_index, i);
          arr.push_back(ToLuaValue(L, -1, depth + 1));
          lua_pop(L, 1);
        }
        return std::make_shared<LuaValue>(LuaValue::from(std::move(arr)));
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
      return std::make_shared<LuaValue>(LuaValue::from(std::move(map)));
    }
    case LUA_TFUNCTION: {
      lua_pushvalue(L, abs_index);
      const int ref = luaL_ref(L, LUA_REGISTRYINDEX);
      return std::make_shared<LuaValue>(LuaValue::from(LuaFunctionRef(ref, L)));
    }
    case LUA_TTHREAD: {
      lua_State* thread = lua_tothread(L, abs_index);
      lua_pushvalue(L, abs_index);
      const int ref = luaL_ref(L, LUA_REGISTRYINDEX);
      return std::make_shared<LuaValue>(LuaValue::from(LuaThreadRef(ref, L, thread)));
    }
    case LUA_TUSERDATA: {
      // Check if it's our proxy userdata (property-access-enabled)
      if (luaL_testudata(L, abs_index, kProxyUserdataMetaName)) {
        auto* block = static_cast<int*>(lua_touserdata(L, abs_index));
        if (block) {
          return std::make_shared<LuaValue>(LuaValue::from(
            LuaUserdataRef(*block, L, false, LUA_NOREF, true)));
        }
      }
      // Check if it's our opaque userdata
      if (luaL_testudata(L, abs_index, kUserdataMetaName)) {
        auto* block = static_cast<int*>(lua_touserdata(L, abs_index));
        if (block) {
          return std::make_shared<LuaValue>(LuaValue::from(
            LuaUserdataRef(*block, L)));
        }
      }
      // Lua-created userdata (from libraries like io) - store as opaque registry ref
      lua_pushvalue(L, abs_index);
      const int ref = luaL_ref(L, LUA_REGISTRYINDEX);
      return std::make_shared<LuaValue>(LuaValue::from(
        LuaUserdataRef(-1, L, true, ref)));
    }
    default:
      return std::make_shared<LuaValue>(LuaValue::nil());
  }
}

void LuaRuntime::PushLuaValue(lua_State* L, const LuaPtr& value, const int depth) {
  if (!value) {
    lua_pushnil(L);
    return;
  }
  if (depth > kMaxDepth) {
    throw std::runtime_error("Value nesting depth exceeds the maximum of " + std::to_string(kMaxDepth) + " levels");
  }
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
        } else if constexpr (std::is_same_v<T, LuaFunctionRef>) {
          lua_rawgeti(L, LUA_REGISTRYINDEX, v.ref);
        } else if constexpr (std::is_same_v<T, LuaThreadRef>) {
          lua_rawgeti(L, LUA_REGISTRYINDEX, v.ref);
        } else if constexpr (std::is_same_v<T, LuaUserdataRef>) {
          if (v.opaque) {
            // Lua-created userdata - push from registry
            lua_rawgeti(L, LUA_REGISTRYINDEX, v.registry_ref);
          } else {
            // JS-created userdata - create a new userdata block with same ref_id
            auto* block = static_cast<int*>(lua_newuserdata(L, sizeof(int)));
            *block = v.ref_id;
            luaL_setmetatable(L, v.proxy ? kProxyUserdataMetaName : kUserdataMetaName);
            // Increment ref count so __gc balances correctly
            lua_getfield(L, LUA_REGISTRYINDEX, "_lua_core_runtime");
            auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
            lua_pop(L, 1);
            if (runtime) runtime->IncrementUserdataRefCount(v.ref_id);
          }
        } else if constexpr (std::is_same_v<T, LuaTableRef>) {
          lua_rawgeti(L, LUA_REGISTRYINDEX, v.ref);
        }
      },
      value->value);
}

// --- Table reference operations ---

LuaPtr LuaRuntime::GetTableField(int registry_ref, const std::string& key) const {
  StackGuard guard(L_);
  lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);

  // Try integer key
  char* end = nullptr;
  long long int_key = strtoll(key.c_str(), &end, 10);
  if (end != key.c_str() && *end == '\0') {
    lua_geti(L_, -1, static_cast<lua_Integer>(int_key));
  } else {
    lua_getfield(L_, -1, key.c_str());
  }

  return ToLuaValue(L_, -1);
}

void LuaRuntime::SetTableField(int registry_ref, const std::string& key, const LuaPtr& value) const {
  StackGuard guard(L_);
  lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);
  PushLuaValue(L_, value);

  char* end = nullptr;
  long long int_key = strtoll(key.c_str(), &end, 10);
  if (end != key.c_str() && *end == '\0') {
    lua_seti(L_, -2, static_cast<lua_Integer>(int_key));
  } else {
    lua_setfield(L_, -2, key.c_str());
  }
}

bool LuaRuntime::HasTableField(int registry_ref, const std::string& key) const {
  StackGuard guard(L_);
  lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);

  char* end = nullptr;
  long long int_key = strtoll(key.c_str(), &end, 10);
  if (end != key.c_str() && *end == '\0') {
    lua_geti(L_, -1, static_cast<lua_Integer>(int_key));
  } else {
    lua_getfield(L_, -1, key.c_str());
  }

  bool has = !lua_isnil(L_, -1);
  return has;
}

std::vector<std::string> LuaRuntime::GetTableKeys(int registry_ref) const {
  StackGuard guard(L_);
  lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);

  std::vector<std::string> keys;
  lua_pushnil(L_);
  while (lua_next(L_, -2) != 0) {
    if (lua_type(L_, -2) == LUA_TSTRING) {
      keys.emplace_back(lua_tostring(L_, -2));
    } else if (lua_type(L_, -2) == LUA_TNUMBER) {
      lua_pushvalue(L_, -2);
      keys.emplace_back(lua_tostring(L_, -1));
      lua_pop(L_, 1);
    }
    lua_pop(L_, 1);  // pop value, keep key
  }
  return keys;
}

int LuaRuntime::GetTableLength(int registry_ref) const {
  StackGuard guard(L_);
  lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);
  return static_cast<int>(luaL_len(L_, -1));
}

// --- Coroutine support ---

std::variant<LuaThreadRef, std::string> LuaRuntime::CreateCoroutine(const LuaFunctionRef& funcRef) const {
  StackGuard guard(L_);

  // Create a new Lua thread (coroutine)
  lua_State* thread = lua_newthread(L_);
  if (!thread) {
    return std::string("Failed to create coroutine thread");
  }

  // Store the thread in the registry to prevent GC (pops thread from stack)
  const int threadRef = luaL_ref(L_, LUA_REGISTRYINDEX);

  // Push the function onto the new thread's stack
  lua_rawgeti(L_, LUA_REGISTRYINDEX, funcRef.ref);
  lua_xmove(L_, thread, 1);

  return LuaThreadRef(threadRef, L_, thread);
}

CoroutineResult LuaRuntime::ResumeCoroutine(const LuaThreadRef& threadRef,
                                             const std::vector<LuaPtr>& args) const {
  CoroutineResult result;

  if (!threadRef.thread) {
    result.status = CoroutineStatus::Dead;
    result.error = "Invalid coroutine thread";
    return result;
  }

  // Check if coroutine is already dead
  int status = lua_status(threadRef.thread);
  if (status != LUA_OK && status != LUA_YIELD) {
    result.status = CoroutineStatus::Dead;
    result.error = "Coroutine is dead";
    return result;
  }

  // Also check if it's finished (stack is empty and status is OK)
  if (status == LUA_OK && lua_gettop(threadRef.thread) == 0) {
    result.status = CoroutineStatus::Dead;
    result.error = "Coroutine has finished";
    return result;
  }

  // Push arguments onto the coroutine's stack
  try {
    for (const auto& arg : args) {
      PushLuaValue(threadRef.thread, arg);
    }
  } catch (const std::exception& e) {
    result.status = CoroutineStatus::Dead;
    result.error = std::string("Error converting coroutine arguments: ") + e.what();
    return result;
  }

  // Resume the coroutine
  int nresults = 0;
  int resumeStatus = lua_resume(threadRef.thread, L_, static_cast<int>(args.size()), &nresults);

  if (resumeStatus == LUA_YIELD) {
    result.status = CoroutineStatus::Suspended;
    // Collect yielded values
    try {
      for (int i = 1; i <= nresults; ++i) {
        result.values.push_back(ToLuaValue(threadRef.thread, i));
      }
    } catch (const std::exception& e) {
      result.values.clear();
      lua_pop(threadRef.thread, nresults);
      result.status = CoroutineStatus::Dead;
      result.error = e.what();
      return result;
    }
    lua_pop(threadRef.thread, nresults);
  } else if (resumeStatus == LUA_OK) {
    result.status = CoroutineStatus::Dead;
    // Collect return values
    try {
      for (int i = 1; i <= nresults; ++i) {
        result.values.push_back(ToLuaValue(threadRef.thread, i));
      }
    } catch (const std::exception& e) {
      result.values.clear();
      lua_pop(threadRef.thread, nresults);
      result.error = e.what();
      return result;
    }
    lua_pop(threadRef.thread, nresults);
  } else {
    result.status = CoroutineStatus::Dead;
    result.error = lua_tostring(threadRef.thread, -1);
    lua_pop(threadRef.thread, 1);
  }

  return result;
}

CoroutineStatus LuaRuntime::GetCoroutineStatus(const LuaThreadRef& threadRef) const {
  if (!threadRef.thread) {
    return CoroutineStatus::Dead;
  }

  int status = lua_status(threadRef.thread);
  if (status == LUA_YIELD) {
    return CoroutineStatus::Suspended;
  } else if (status == LUA_OK) {
    // Check if coroutine has any code to run
    if (lua_gettop(threadRef.thread) == 0) {
      return CoroutineStatus::Dead;
    }
    return CoroutineStatus::Suspended;
  }
  return CoroutineStatus::Dead;
}

} // namespace lua_core
