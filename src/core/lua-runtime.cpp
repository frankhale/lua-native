#include "lua-runtime.h"

#include <cerrno>
#include <cstdio>

namespace lua_core {

namespace {
struct StackGuard {
  lua_State* L;
  int top;
  explicit StackGuard(lua_State* s) : L(s), top(lua_gettop(s)) {}
  ~StackGuard() { lua_settop(L, top); }
};

// Outcome of a host-function bridge body, decided while C++ objects are still
// alive and acted on only after they have been destroyed. lua_error/lua_yieldk
// longjmp (skipping C++ destructors), so any error value must be staged on the
// Lua stack inside the scope and the jump performed from a scope with no
// non-trivial locals.
enum class HostCallOutcome { Return1, Raise, Yield };

// True if a table is a dense 1..n integer-keyed sequence. Order-independent:
// counts integer keys in [1, rawlen] and requires every slot to be present, so
// it does not depend on lua_next iteration order (which only tracks insertion
// order for the array part).
bool isSequentialArray(lua_State* L, int index) {
  const int abs_index = lua_absindex(L, index);
  const auto len = static_cast<lua_Integer>(lua_rawlen(L, abs_index));
  lua_Integer int_keys = 0;
  lua_pushnil(L);
  while (lua_next(L, abs_index) != 0) {
    if (!lua_isinteger(L, -2)) {
      lua_pop(L, 2);
      return false;
    }
    if (const lua_Integer k = lua_tointeger(L, -2); k < 1 || k > len) {
      lua_pop(L, 2);
      return false;  // an integer key outside [1, #t] means it's not a sequence
    }
    ++int_keys;
    lua_pop(L, 1);
  }
  return int_keys == len;  // every slot 1..len present and nothing else
}

// Pushes a table key as an integer when the whole string parses cleanly as one
// (without overflow), otherwise as a string. Note: this means a key that looks
// like an integer is always addressed as an integer key — a genuine string key
// such as "123" is not reachable through this string-based API. A value that
// overflows int64 (e.g. "99999999999999999999") stays a string key rather than
// being silently clamped.
void PushTableKey(lua_State* L, const std::string& key) {
  // strtoll accepts leading whitespace and a '+' sign, which would silently
  // alias e.g. " 12" or "+12" onto integer key 12. Only treat a key as integer
  // when it's a bare optional-'-' digit string, so those stay string keys.
  const bool looks_numeric =
      !key.empty() &&
      (key[0] == '-' ? key.size() > 1 && std::isdigit(static_cast<unsigned char>(key[1]))
                     : std::isdigit(static_cast<unsigned char>(key[0])));
  if (looks_numeric) {
    errno = 0;
    char* end = nullptr;
    const long long int_key = strtoll(key.c_str(), &end, 10);
    if (end != key.c_str() && *end == '\0' && errno != ERANGE) {
      lua_pushinteger(L, static_cast<lua_Integer>(int_key));
      return;
    }
  }
  lua_pushlstring(L, key.data(), key.size());
}

// Pushes an explicitly-typed table key. Unlike the string overload above, a
// string alternative is always pushed as a Lua string — no numeric coercion —
// so a genuine string key like "123" is reachable and distinct from integer
// key 123. (Lua itself normalizes a float key with an exact integer value to an
// integer key, so `1.0` and `1` address the same slot, matching Lua semantics.)
void PushTableKey(lua_State* L, const lua_core::TableKey& key) {
  std::visit([L](const auto& k) {
    using T = std::decay_t<decltype(k)>;
    if constexpr (std::is_same_v<T, std::string>) {
      lua_pushlstring(L, k.data(), k.size());
    } else if constexpr (std::is_same_v<T, int64_t>) {
      lua_pushinteger(L, static_cast<lua_Integer>(k));
    } else {  // double
      lua_pushnumber(L, static_cast<lua_Number>(k));
    }
  }, key);
}

// Protected trampolines for metamethod-triggering table-ref operations. Each is
// run under lua_pcall (see LuaRuntime::ProtectedTableCall) so a raising
// __index/__newindex/__len is caught instead of aborting the process. They hold
// no C++ locals, so the longjmp on raise has nothing to skip.
// (The former ProtectedTableGet/ProtectedTableSet trampolines are gone: the
// field accessors now do the gettable/settable inside a RunProtected frame that
// also covers staging the key and value, which those trampolines could not.)
int ProtectedTableLen(lua_State* L) {   // [t] -> [len]
  lua_pushinteger(L, luaL_len(L, 1));
  return 1;
}
int ProtectedTableICollect(lua_State* L) {  // [t] -> [dense array of values]
  lua_newtable(L);
  for (lua_Integer i = 1; ; ++i) {
    lua_geti(L, 1, i);  // respects __index
    if (lua_isnil(L, -1)) { lua_pop(L, 1); break; }
    lua_rawseti(L, 2, i);
  }
  return 1;
}

// Protected __tostring trampoline: [value] -> [string]. Run under lua_pcall so a
// raising __tostring metamethod (on an error object surfaced from an unprotected
// coroutine path) becomes a caught failure rather than a panic/abort.
int ProtectedToString(lua_State* L) {  // [value] -> [string]
  luaL_tolstring(L, 1, nullptr);
  return 1;
}
} // namespace

int LuaRuntime::LibraryMask(const std::vector<std::string>& libraries) {
  // Map from user-facing library name to the Lua 5.5 bitmask constant. Kept as a
  // function-local static to avoid a globally-constructed map.
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

void* LuaRuntime::LuaAllocator(void* ud, void* ptr, size_t osize, size_t nsize) {
  auto* alloc = static_cast<MemoryAllocator*>(ud);

  if (nsize == 0) {
    // Free: when ptr is non-null, osize is the old block size
    if (ptr) {
      alloc->current -= osize;
      free(ptr);
    }
    return nullptr;
  }

  // For new allocations (ptr == NULL), osize is the Lua type tag, not a size.
  // For reallocations, Lua guarantees osize is the true old block size, so
  // alloc->current >= old_size always holds and the subtraction never wraps.
  size_t old_size = ptr ? osize : 0;

  // Check limit (0 means unlimited)
  if (alloc->limit > 0 && alloc->current - old_size + nsize > alloc->limit) {
    return nullptr;  // Lua handles this as OOM
  }

  void* new_ptr = realloc(ptr, nsize);
  if (new_ptr) {
    alloc->current = alloc->current - old_size + nsize;
  }
  return new_ptr;
}

void LuaRuntime::InitState() {
  // Store the runtime in registry for callbacks
  lua_pushlightuserdata(L_, this);
  lua_setfield(L_, LUA_REGISTRYINDEX, kRuntimeRegistryKey);

  // Also stash `this` in the main state's extra space so a registry-owner
  // deleter can resolve the runtime without touching the registry (H9c). Set
  // before any ref could be created (refs only cross the boundary during
  // execution, after construction), so the deleter always reads a valid pointer.
  *static_cast<LuaRuntime**>(lua_getextraspace(L_)) = this;

  // Register userdata metatables
  RegisterUserdataMetatable();
  RegisterProxyUserdataMetatable();
  RegisterHostFnSentinelMetatable();

  // Install the instruction/cancel count-hook if a limit was configured. Must
  // run after the runtime pointer is in the registry (the hook reads it back).
  InstallExecutionHook();
}

// Retrieves the LuaRuntime from the registry, tallies instructions, and raises
// "instruction limit exceeded" (or "execution cancelled") when appropriate.
// Holds no non-trivial C++ locals, so the luaL_error longjmp skips nothing (see
// the H1 discussion in CODE-REVIEW-1). Always fires inside a lua_pcall /
// lua_resume frame, so the raise is protected rather than a panic.
void LuaRuntime::InstructionCountHook(lua_State* L, lua_Debug* /*ar*/) {
  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  if (!runtime) return;

  // Cooperative cancellation of a compute-bound loop.
  if (runtime->cancel_requested_.load(std::memory_order_relaxed)) {
    luaL_error(L, "execution cancelled");
    return;  // unreachable: luaL_error longjmps
  }

  if (runtime->max_instructions_ == 0) return;  // limit removed since install
  runtime->instruction_count_ +=
      static_cast<size_t>(runtime->instruction_hook_interval_);
  if (runtime->instruction_count_ >= runtime->max_instructions_) {
    luaL_error(L, "instruction limit exceeded");
  }
}

void LuaRuntime::InstallExecutionHook() {
  if (max_instructions_ > 0) {
    // Fire at least as often as the limit so a small limit is still enforced,
    // capped at 1000 to keep per-instruction overhead negligible for large ones.
    instruction_hook_interval_ =
        max_instructions_ < 1000 ? static_cast<int>(max_instructions_) : 1000;
    lua_sethook(L_, InstructionCountHook, LUA_MASKCOUNT, instruction_hook_interval_);
  } else {
    lua_sethook(L_, nullptr, 0, 0);
  }
}

void LuaRuntime::SetMaxInstructions(size_t limit) {
  max_instructions_ = limit;
  InstallExecutionHook();
}

std::vector<std::string> LuaRuntime::AllLibraries() {
  return {"base", "package", "coroutine", "table", "io", "os", "string", "math", "utf8", "debug"};
}

std::vector<std::string> LuaRuntime::SafeLibraries() {
  return {"base", "package", "coroutine", "table", "string", "math", "utf8"};
}

// Delegating constructors funnel into the RuntimeConfig overload so state
// creation, the null check, library loading, and InitState() live in one place.
LuaRuntime::LuaRuntime() : LuaRuntime(RuntimeConfig{}) {}

LuaRuntime::LuaRuntime(const std::vector<std::string>& libraries)
    : LuaRuntime(RuntimeConfig{libraries, 0}) {}

LuaRuntime::LuaRuntime(const RuntimeConfig& config) {
  allocator_.limit = config.max_memory;
  max_instructions_ = config.max_instructions;  // installed by InitState()
  L_ = lua_newstate(LuaAllocator, &allocator_, 0);
  if (!L_) {
    throw std::runtime_error("Failed to create Lua state");
  }
  if (!config.libraries.empty()) {
    luaL_openselectedlibs(L_, LibraryMask(config.libraries), 0);
  }
  InitState();
}

LuaRuntime::~LuaRuntime() {
  // Drop any registry-backed error values while the Lua state is still open;
  // their RAII owners call luaL_unref, which must run before lua_close.
  last_error_value_.reset();
  pending_error_value_.reset();

  // lua_close() below runs __gc metamethods, which can reach the userdata GC
  // and output callbacks. Clear them first so teardown never calls back into a
  // (possibly already torn-down) host handler. The binding layer also clears
  // these, but the core must not depend on it.
  userdata_gc_callback_ = nullptr;
  output_handler_ = nullptr;
  // lua_close also fires the host-fn sentinel __gc metamethods; clear the
  // callback so teardown never calls back into a torn-down binding handler (M2).
  host_fn_gc_callback_ = nullptr;

  // Remove the count-hook before lua_close so a __gc finalizer running during
  // teardown can't trip the instruction limit / cancel raise.
  if (L_) lua_sethook(L_, nullptr, 0, 0);

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

  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
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

  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  if (!runtime) {
    lua_pushnil(L);
    return 1;
  }

  // Stage any error on the Lua stack while the std::string / caught exception
  // are alive, then longjmp (lua_error) only after they are destroyed.
  bool raise = false;
  bool have_result = false;
  {
    // 1. Check for a registered method
    bool has_method_table = false;
    std::string registry_key =
        std::string(kUserdataMethodsPrefix) + std::to_string(*block);
    lua_getfield(L, LUA_REGISTRYINDEX, registry_key.c_str());
    if (lua_istable(L, -1)) {
      has_method_table = true;
      lua_getfield(L, -1, key);
      if (lua_isfunction(L, -1)) {
        // Cached closure from a previous access: return it (so obj.m == obj.m).
        lua_remove(L, -2);  // remove method table
        have_result = true;
      } else if (lua_isstring(L, -1)) {
        // First access: the value is the host function name. Build a closure
        // (upvalue 1: name), cache it back into the method table, and return it.
        lua_pushcclosure(L, UserdataMethodCall, 1);  // consumes the name string
        lua_pushvalue(L, -1);       // dup the closure
        lua_setfield(L, -3, key);   // method_table[key] = closure
        lua_remove(L, -2);          // remove method table
        have_result = true;
      } else {
        lua_pop(L, 1);  // pop nil (key not found in method table)
      }
    }

    if (!have_result) {
      lua_pop(L, 1);  // pop method table (or nil if no table)

      // 2. Fall through to property access
      if (runtime->property_getter_) {
        if (runtime->async_mode_) {
          // A worker thread owns the state; the getter would call into JS
          // off the main thread. Reject like the host-function path does.
          lua_pushfstring(L,
            "property access is not available in async mode (reading '%s')", key);
          raise = true;
        } else {
        try {
          auto result = runtime->property_getter_(*block, key);
          if (PushLuaValueProtected(L, result) == LUA_OK) {
            have_result = true;
          } else {
            // ERRMEM mid-push (F6): the frame unwound with the message on
            // top; raise it after the locals below are destroyed.
            raise = true;
          }
        } catch (const std::exception& e) {
          // If this userdata has methods but isn't readable, return nil instead
          // of erroring (methods work independently of readable).
          if (has_method_table) {
            lua_pushnil(L);
            have_result = true;
          } else {
            lua_pushfstring(L, "Error reading property '%s': %s", key, e.what());
            raise = true;
          }
        }
        }
      }
    }
  }  // registry_key destroyed here, before any longjmp

  if (raise) return lua_error(L);
  if (have_result) return 1;
  lua_pushnil(L);
  return 1;
}

int LuaRuntime::UserdataNewIndex(lua_State* L) {
  auto* block = static_cast<int*>(lua_touserdata(L, 1));
  if (!block) return 0;

  const char* key = lua_tostring(L, 2);
  if (!key) return 0;

  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  bool raise = false;
  if (runtime && runtime->property_setter_) {
    if (runtime->async_mode_) {
      // A worker thread owns the state; the setter would call into JS off the
      // main thread. Reject like the host-function path does.
      lua_pushfstring(L,
        "property access is not available in async mode (writing '%s')", key);
      raise = true;
    } else {
      try {
        auto value = ToLuaValue(L, 3);
        runtime->property_setter_(*block, key, value);
      } catch (const std::exception& e) {
        lua_pushfstring(L, "Error writing property '%s': %s", key, e.what());
        raise = true;
      }
    }
  }
  if (raise) return lua_error(L);  // after the exception object is destroyed
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

// --- Worker-thread registry-unref deferral (H9c) ---

void LuaRuntime::BeginWorkerUnrefDeferral() {
  std::lock_guard<std::mutex> lk(deferred_unref_mutex_);
  worker_active_ = true;
}

void LuaRuntime::EndWorkerUnrefDeferral() {
  std::lock_guard<std::mutex> lk(deferred_unref_mutex_);
  worker_active_ = false;
  // Drain under the lock: any concurrent main-thread finalizer blocks here, so
  // the drain's unrefs never overlap a finalizer's. The worker has finished
  // touching Lua and the main thread is still blocked (is_busy_), so mutating
  // the registry now is safe.
  for (int ref : deferred_unrefs_) luaL_unref(L_, LUA_REGISTRYINDEX, ref);
  deferred_unrefs_.clear();
}

void LuaRuntime::UnrefOrDefer(int ref) {
  std::lock_guard<std::mutex> lk(deferred_unref_mutex_);
  if (worker_active_) {
    // A worker is mid-run off-thread; queue the unref for EndWorkerUnrefDeferral
    // rather than mutating the registry concurrently with the worker's Lua.
    deferred_unrefs_.push_back(ref);
  } else {
    luaL_unref(L_, LUA_REGISTRYINDEX, ref);
  }
}

// Free function the registry-owner deleter routes through (declared in the
// header before LuaRuntime is complete). Resolves the runtime from the main
// state's extra space so it can consult the deferral queue without reading the
// registry or taking a Lua lock.
void detail::UnrefRegistrySlot(lua_State* mainL, int ref) {
  auto* runtime = *static_cast<LuaRuntime**>(lua_getextraspace(mainL));
  if (runtime) {
    runtime->UnrefOrDefer(ref);
  } else {
    // No runtime recorded (should not happen once InitState has run): fall back
    // to an immediate unref.
    luaL_unref(mainL, LUA_REGISTRYINDEX, ref);
  }
}

void LuaRuntime::CreateUserdataGlobal(const std::string& name, int ref_id) {
  // Protected so an OOM (under maxMemory) allocating the userdata, or a raising
  // __newindex on a _G metatable, throws instead of aborting (M3). The build is
  // self-contained; the pcall frame discards the stack on the way out.
  RunProtected([&]() {
    auto* block = static_cast<int*>(lua_newuserdata(L_, sizeof(int)));
    *block = ref_id;
    luaL_setmetatable(L_, kUserdataMetaName);          // [ud]
    lua_rawgeti(L_, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);  // [ud, _G]
    lua_pushlstring(L_, name.data(), name.size());     // [ud, _G, key]
    lua_pushvalue(L_, -3);                             // [ud, _G, key, ud]
    lua_settable(L_, -3);                             // _G[key] = ud (may __newindex)
  });
  IncrementUserdataRefCount(ref_id);
}

void LuaRuntime::CreateProxyUserdataGlobal(const std::string& name, int ref_id) {
  RunProtected([&]() {
    auto* block = static_cast<int*>(lua_newuserdata(L_, sizeof(int)));
    *block = ref_id;
    luaL_setmetatable(L_, kProxyUserdataMetaName);     // [ud]
    lua_rawgeti(L_, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);  // [ud, _G]
    lua_pushlstring(L_, name.data(), name.size());     // [ud, _G, key]
    lua_pushvalue(L_, -3);                             // [ud, _G, key, ud]
    lua_settable(L_, -3);                             // _G[key] = ud (may __newindex)
  });
  IncrementUserdataRefCount(ref_id);
}

void LuaRuntime::RemoveGlobalRaw(const std::string& name) const {
  // Raw so no metamethod can fire mid-rollback; protected because the key push
  // allocates and this runs on OOM-failure paths (CR-7 F3).
  RunProtected([&]() {
    lua_rawgeti(L_, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);  // [_G]
    lua_pushlstring(L_, name.data(), name.size());          // [_G, key]
    lua_pushnil(L_);                                        // [_G, key, nil]
    lua_rawset(L_, -3);                                     // _G[key] = nil (raw)
    lua_pop(L_, 1);                                         // pop _G
  });
}

void LuaRuntime::IncrementUserdataRefCount(int ref_id) {
  userdata_ref_counts_[ref_id]++;
}

void LuaRuntime::DecrementUserdataRefCount(int ref_id) {
  auto it = userdata_ref_counts_.find(ref_id);
  if (it != userdata_ref_counts_.end()) {
    if (--it->second <= 0) {
      userdata_ref_counts_.erase(it);

      // Clean up method table if one exists
      std::string registry_key = std::string(kUserdataMethodsPrefix) + std::to_string(ref_id);
      lua_pushnil(L_);
      lua_setfield(L_, LUA_REGISTRYINDEX, registry_key.c_str());

      // The GC callback reaches into the binding layer's N-API state (it frees a
      // Napi::ObjectReference). During worker-thread async that would be an
      // off-thread N-API call, so skip it. The binding entry is reclaimed when
      // the context is destroyed; leaking it for the run is better than a crash.
      if (userdata_gc_callback_ && !async_mode_) {
        userdata_gc_callback_(ref_id);
      }
    }
  }
}

void LuaRuntime::SetUserdataMethodTable(
    int ref_id,
    const std::unordered_map<std::string, std::string>& method_map) {
  const std::string registry_key =
      std::string(kUserdataMethodsPrefix) + std::to_string(ref_id);
  // Protected so an OOM building the method table throws instead of aborting (M3).
  RunProtected([&]() {
    // Create a table: { method_name = "host_func_name", ... }
    lua_newtable(L_);
    for (const auto& [name, func_name] : method_map) {
      lua_pushstring(L_, func_name.c_str());
      lua_setfield(L_, -2, name.c_str());
    }
    // Store in registry: _ud_methods_<ref_id> = table (consumes the table)
    lua_setfield(L_, LUA_REGISTRYINDEX, registry_key.c_str());
  });
}

int LuaRuntime::UserdataMethodCall(lua_State* L) {
  // upvalue 1: host function name (string)
  // When called as obj:method(a, b), the stack has: obj, a, b
  const char* func_name = lua_tostring(L, lua_upvalueindex(1));

  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  if (!runtime) {
    lua_pushstring(L, "LuaRuntime not found in registry");
    return lua_error(L);
  }

  const auto it = runtime->host_functions_.find(func_name ? func_name : "");
  if (it == runtime->host_functions_.end()) {
    lua_pushfstring(L, "Method '%s' not found", func_name ? func_name : "");
    return lua_error(L);
  }

  if (runtime->async_mode_) {
    return luaL_error(L,
      "JS callbacks are not available in async mode (called method '%s')",
      func_name ? func_name : "<unknown>");
  }

  // See HostCallOutcome / LuaCallHostFunction: stage any error on the Lua stack
  // inside the scope, then longjmp only after C++ locals are destroyed.
  HostCallOutcome outcome = HostCallOutcome::Return1;
  {
    // Convert all arguments (including self at position 1)
    const int argc = lua_gettop(L);
    std::vector<LuaPtr> args;
    args.reserve(argc);
    bool converted = true;
    try {
      for (int i = 1; i <= argc; ++i) args.push_back(ToLuaValue(L, i));
    } catch (const std::exception& e) {
      lua_pushfstring(L, "Error converting arguments for method '%s': %s",
                      func_name ? func_name : "<unknown>", e.what());
      outcome = HostCallOutcome::Raise;
      converted = false;
    }

    if (converted) {
      LuaPtr resultHolder;
      bool called = true;
      try {
        resultHolder = it->second(args);
      } catch (const std::exception& e) {
        if (runtime->HasPendingErrorValue()) {
          LuaPtr errVal = runtime->TakePendingErrorValue();
          // Protected (F6): an ERRMEM here must not longjmp over errVal/args.
          // On failure the pcall's message is on top and is raised instead.
          try { PushLuaValueProtected(L, errVal); } catch (...) { lua_pushstring(L, e.what()); }
        } else {
          lua_pushfstring(L, "Method '%s' threw an exception: %s",
                          func_name ? func_name : "<unknown>", e.what());
        }
        outcome = HostCallOutcome::Raise;
        called = false;
      } catch (...) {
        lua_pushfstring(L, "Method '%s' threw an unknown exception",
                        func_name ? func_name : "<unknown>");
        outcome = HostCallOutcome::Raise;
        called = false;
      }

      if (called) {
        if (runtime->await_pending_) {
          // A method that returned a JS Promise while in the async driver
          // suspends the coroutine until it settles (see LuaCallHostFunction).
          runtime->await_pending_ = false;
          if (L != runtime->await_driver_thread_) {
            // Same guard as LuaCallHostFunction: a promise-returning method
            // called from inside a user coroutine can't suspend correctly (M1).
            lua_pushfstring(L,
              "cannot await a JS Promise inside a coroutine (method '%s'); "
              "await only at the top level of execute_async",
              func_name ? func_name : "<unknown>");
            outcome = HostCallOutcome::Raise;
          } else {
            outcome = HostCallOutcome::Yield;
          }
        } else {
          try {
            if (PushLuaValueProtected(L, resultHolder) != LUA_OK) {
              // ERRMEM mid-push (F6): the frame unwound with the message on
              // top; raise it after the locals below are destroyed.
              outcome = HostCallOutcome::Raise;
            }
          } catch (const std::exception& e) {
            lua_pushfstring(L, "Error converting return value from method '%s': %s",
                            func_name ? func_name : "<unknown>", e.what());
            outcome = HostCallOutcome::Raise;
          }
        }
      }
    }
  }  // all C++ locals destroyed here, before any longjmp below

  switch (outcome) {
    case HostCallOutcome::Raise:
      return lua_error(L);
    case HostCallOutcome::Yield:
      return lua_yieldk(L, 0, 0, AsyncContinuation);
    case HostCallOutcome::Return1:
      return 1;
  }
  return 0;  // unreachable
}

// --- Class / usertype support ---

void LuaRuntime::RegisterClass(
    const std::string& class_name,
    const std::string& constructor_func_name,
    const std::unordered_map<std::string, std::string>& method_map,
    const std::vector<MetatableEntry>& metamethods) {
  // The whole build (metatable, method table, class global) runs in one
  // protected frame so an OOM under maxMemory, or a raising __newindex on a _G
  // metatable at the final lua_setglobal, throws instead of aborting (M3). Every
  // allocation and _G write below is therefore protected.
  //
  // The key strings live out here, not in the thunk: a Lua ERRMEM longjmp to
  // the pcall skips destructors of thunk-local C++ objects (N2).
  const std::string mt_name = std::string(kClassMetaPrefix) + class_name;
  const std::string methods_key = std::string(kClassMethodsPrefix) + class_name;
  RunProtected([&]() {
  // 1. Create the shared per-class instance metatable.
  luaL_newmetatable(L_, mt_name.c_str());

  lua_pushcfunction(L_, UserdataGC);
  lua_setfield(L_, -2, "__gc");

  // __index closure carries the class name as an upvalue so it can find the
  // shared method table, then falls through to property access.
  lua_pushstring(L_, class_name.c_str());
  lua_pushcclosure(L_, ClassIndex, 1);
  lua_setfield(L_, -2, "__index");

  // __newindex reuses the property-setter path (honors the writable flag).
  lua_pushcfunction(L_, UserdataNewIndex);
  lua_setfield(L_, -2, "__newindex");

  // __name aids default tostring() and error messages.
  lua_pushstring(L_, class_name.c_str());
  lua_setfield(L_, -2, "__name");

  // Marker so ToLuaValue recognizes instances as JS-backed class userdata
  // (and recovers the class name) rather than treating them as opaque.
  lua_pushstring(L_, class_name.c_str());
  lua_setfield(L_, -2, kClassMarkerField);

  // Operator overloads / other metamethods dispatch through the host bridge.
  for (const auto& mm : metamethods) {
    lua_pushstring(L_, mm.func_name.c_str());
    lua_pushcclosure(L_, LuaCallHostFunction, 1);
    lua_setfield(L_, -2, mm.key.c_str());
  }
  lua_pop(L_, 1);  // pop metatable

  // 2. Store the shared method table in the registry: { name = host_func_name }.
  lua_newtable(L_);
  for (const auto& [name, func_name] : method_map) {
    lua_pushstring(L_, func_name.c_str());
    lua_setfield(L_, -2, name.c_str());
  }
  lua_setfield(L_, LUA_REGISTRYINDEX, methods_key.c_str());

  // 3. Create the class global table with a `new` constructor function.
  lua_newtable(L_);
  lua_pushstring(L_, constructor_func_name.c_str());
  lua_pushcclosure(L_, LuaCallHostFunction, 1);
  lua_setfield(L_, -2, "new");
  lua_setglobal(L_, class_name.c_str());
  });
}

int LuaRuntime::ClassIndex(lua_State* L) {
  auto* block = static_cast<int*>(lua_touserdata(L, 1));
  if (!block) { lua_pushnil(L); return 1; }

  const char* key = lua_tostring(L, 2);
  if (!key) { lua_pushnil(L); return 1; }

  const char* class_name = lua_tostring(L, lua_upvalueindex(1));

  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  if (!runtime) { lua_pushnil(L); return 1; }

  // Stage any error on the Lua stack while the std::string / caught exception
  // are alive, then longjmp (lua_error) only after they are destroyed.
  bool raise = false;
  bool have_result = false;
  {
    // 1. Look up the key in the shared class method table.
    bool has_methods = false;
    const std::string methods_key =
        std::string(kClassMethodsPrefix) + std::string(class_name ? class_name : "");
    lua_getfield(L, LUA_REGISTRYINDEX, methods_key.c_str());
    if (lua_istable(L, -1)) {
      has_methods = true;
      lua_getfield(L, -1, key);
      if (lua_isfunction(L, -1)) {
        // Cached closure (shared across instances of this class): return it.
        lua_remove(L, -2);  // remove method table
        have_result = true;
      } else if (lua_isstring(L, -1)) {
        // First access: value is the host function name. Build a bound method
        // closure, cache it back into the shared method table, and return it.
        lua_pushcclosure(L, UserdataMethodCall, 1);  // consumes name as upvalue 1
        lua_pushvalue(L, -1);       // dup the closure
        lua_setfield(L, -3, key);   // method_table[key] = closure
        lua_remove(L, -2);          // remove method table
        have_result = true;
      } else {
        lua_pop(L, 1);  // pop nil (key not a method)
      }
    }

    if (!have_result) {
      lua_pop(L, 1);  // pop method table (or nil)

      // 2. Fall through to property access.
      if (runtime->property_getter_) {
        if (runtime->async_mode_) {
          // A worker thread owns the state; the getter would call into JS off
          // the main thread. Reject like the host-function path does.
          luaL_where(L, 1);
          lua_pushfstring(L,
            "property access is not available in async mode (reading '%s')", key);
          lua_concat(L, 2);
          raise = true;
        } else {
        try {
          auto result = runtime->property_getter_(*block, key);
          if (PushLuaValueProtected(L, result) == LUA_OK) {
            have_result = true;
          } else {
            // ERRMEM mid-push (F6): the frame unwound with the message on
            // top; raise it after the locals below are destroyed.
            raise = true;
          }
        } catch (const std::exception& e) {
          // Class with methods but not readable: return nil rather than erroring
          // (methods work independently of readable, matching userdata behavior).
          if (has_methods) {
            lua_pushnil(L);
            have_result = true;
          } else {
            // Reproduce luaL_error's "chunk:line: " location prefix.
            luaL_where(L, 1);
            lua_pushfstring(L, "Error reading property '%s': %s", key, e.what());
            lua_concat(L, 2);
            raise = true;
          }
        }
        }
      }
    }
  }  // methods_key destroyed here, before any longjmp

  if (raise) return lua_error(L);
  if (have_result) return 1;
  lua_pushnil(L);
  return 1;
}

// --- Metatable support ---

void LuaRuntime::StoreHostFunction(const std::string& name, Function fn) {
  host_functions_[name] = std::move(fn);
}

void LuaRuntime::RemoveHostFunction(const std::string& name) {
  host_functions_.erase(name);
}

void LuaRuntime::RegisterReclaimableHostFunction(const std::string& name, Function fn) {
  host_functions_[name] = std::move(fn);
  reclaimable_host_fns_[name] = 0;  // live-closure count, incremented on each push
}

bool LuaRuntime::EraseReclaimableIfUnpushed(const std::string& name) {
  auto it = reclaimable_host_fns_.find(name);
  if (it == reclaimable_host_fns_.end() || it->second != 0) return false;
  reclaimable_host_fns_.erase(it);
  host_functions_.erase(name);
  return true;
}

void LuaRuntime::SetHostFunctionGCCallback(HostFunctionGCCallback cb) {
  host_fn_gc_callback_ = std::move(cb);
}

void LuaRuntime::RegisterHostFnSentinelMetatable() {
  luaL_newmetatable(L_, kHostFnSentinelMeta);
  lua_pushcfunction(L_, HostFnSentinelGC);
  lua_setfield(L_, -2, "__gc");
  lua_pop(L_, 1);
}

// __gc for the sentinel userdata carried as a reclaimable closure's upvalue.
// Fires when that closure is collected. Holds no non-trivial C++ locals across
// a raise, so it is safe on any GC path.
int LuaRuntime::HostFnSentinelGC(lua_State* L) {
  auto** slot = static_cast<std::string**>(lua_touserdata(L, 1));
  if (!slot || !*slot) return 0;
  std::string* namep = *slot;
  *slot = nullptr;  // guard against a double __gc

  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  if (runtime) runtime->OnHostFnClosureCollected(*namep);

  delete namep;
  return 0;
}

void LuaRuntime::OnHostFnClosureCollected(const std::string& name) {
  auto it = reclaimable_host_fns_.find(name);
  if (it == reclaimable_host_fns_.end()) return;
  if (--it->second <= 0) {
    reclaimable_host_fns_.erase(it);
    host_functions_.erase(name);
    // Drop the binding's paired JS reference. Skip during a worker run — that
    // would be an off-thread N-API call; the entry is then reclaimed with the
    // context instead, matching the userdata GC callback's tradeoff.
    if (host_fn_gc_callback_ && !async_mode_) host_fn_gc_callback_(name);
  }
}

void LuaRuntime::SetGlobalMetatable(const std::string& name, const std::vector<MetatableEntry>& entries) {
  // One protected frame covers the read (already protected on its own), the
  // metatable allocation (M3), and lua_setmetatable. Validation throws and
  // PushLuaValue depth throws propagate out of RunProtected unchanged.
  RunProtected([&]() {
    // Read through the protected _G[name] path so a raising __index metamethod
    // on the globals table can't panic.
    PushProtectedGlobal(name);
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
  });
}

// --- Module / require support ---

bool LuaRuntime::HasPackageLibrary() const {
  StackGuard guard(L_);
  PushProtectedGlobal("package");
  return lua_istable(L_, -1);  // lua_istable already implies non-nil
}

void LuaRuntime::AddSearchPath(const std::string& path) const {
  if (!HasPackageLibrary()) {
    throw std::runtime_error(
      "Cannot add search path: the 'package' library is not loaded. "
      "Include 'package' in the libraries option.");
  }

  // Protected so the pushstring/setfield allocation (M3) — and a __newindex on
  // a metatabled package table — throw rather than abort.
  //
  // The appended string lives out here so no std::string local sits in the
  // thunk while a raise-capable Lua call executes — an ERRMEM longjmp to the
  // pcall would skip its destructor (N2). The assigns/appends inside the thunk
  // can only throw C++ exceptions, which the trampoline catches normally.
  std::string appended;
  RunProtected([&]() {
    PushProtectedGlobal("package");

    // Get current package.path
    lua_getfield(L_, -1, "path");
    const char* current_raw = lua_tostring(L_, -1);
    appended.assign(current_raw ? current_raw : "");
    lua_pop(L_, 1);  // pop path string

    // Append the new path
    if (!appended.empty()) {
      appended += ';';
    }
    appended += path;

    // Set the updated package.path
    lua_pushstring(L_, appended.c_str());
    lua_setfield(L_, -2, "path");
  });
}

void LuaRuntime::RegisterModuleTable(const std::string& name,
                                      const std::vector<MetatableEntry>& entries) const {
  if (!HasPackageLibrary()) {
    throw std::runtime_error(
      "Cannot register module: the 'package' library is not loaded. "
      "Include 'package' in the libraries option.");
  }

  // Protected so the table build (M3) and the reads/writes on package.loaded
  // can't abort; validation throws propagate out of RunProtected unchanged.
  RunProtected([&]() {
    PushProtectedGlobal("package");
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
  });
}

// --- Output redirection (E1) ---

void LuaRuntime::SetOutputHandler(OutputHandler handler) {
  if (handler) {
    // Install the redirection before committing the handler: the protected _G
    // writes can throw (OOM under maxMemory), and assigning first would leave
    // a handler set that print/io.write were never rewired to reach (CR-8 F7).
    // The overrides read output_handler_ at call time, so the order is safe.
    InstallOutputRedirection();
    output_handler_ = std::move(handler);
  } else {
    output_handler_ = nullptr;
  }
}

void LuaRuntime::InstallOutputRedirection() {
  // Protected so a __newindex on a _G metatable at the print override can't
  // panic (M3). Light C-function pushes don't allocate, so there's no OOM here.
  RunProtected([&]() {
    // Override the global print().
    lua_pushcfunction(L_, LuaPrint);
    lua_setglobal(L_, "print");
    // Override io.write() when the io library is loaded.
    lua_getglobal(L_, "io");
    if (lua_istable(L_, -1)) {
      lua_pushcfunction(L_, LuaIoWrite);
      lua_setfield(L_, -2, "write");
    }
  });
}

int LuaRuntime::LuaPrint(lua_State* L) {
  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  // Assemble the line with a Lua-side buffer so that if luaL_tolstring fires a
  // raising __tostring, the longjmp skips no live C++ object (the std::string is
  // only built afterward, from the finished Lua string) (M4).
  const int n = lua_gettop(L);
  luaL_Buffer b;
  luaL_buffinit(L, &b);
  for (int i = 1; i <= n; ++i) {
    if (i > 1) luaL_addchar(&b, '\t');
    luaL_tolstring(L, i, nullptr);  // respects __tostring; pushes the string
    luaL_addvalue(&b);              // moves it into the buffer
  }
  luaL_addchar(&b, '\n');
  luaL_pushresult(&b);              // finished line on top of the stack

  size_t len = 0;
  const char* s = lua_tolstring(L, -1, &len);
  // The one remaining allocation in this frame: a bad_alloc must not unwind
  // through the Lua C frame — fall back to raw stdout instead (N5).
  std::string out;
  try {
    out.assign(s ? s : "", s ? len : 0);
  } catch (const std::bad_alloc&) {
    if (s) fwrite(s, 1, len, stdout);
    lua_pop(L, 1);
    return 0;
  }
  lua_pop(L, 1);

  if (runtime && runtime->output_handler_ && !runtime->async_mode_) {
    runtime->output_handler_(out);
  } else {
    fwrite(out.data(), 1, out.size(), stdout);
  }
  return 0;
}

// Redirects io.write() to the output handler. Intentionally simplified versus
// stock io.write: it does not return the file handle (so `io.write(x):write(y)`
// chaining is unavailable), ignores io.output() redirection, and stringifies its
// arguments via __tostring rather than erroring on non-string/number values.
int LuaRuntime::LuaIoWrite(lua_State* L) {
  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  // See LuaPrint: build the output through a Lua buffer so a raising __tostring
  // can't longjmp over a live std::string (M4).
  const int n = lua_gettop(L);
  luaL_Buffer b;
  luaL_buffinit(L, &b);
  for (int i = 1; i <= n; ++i) {
    luaL_tolstring(L, i, nullptr);
    luaL_addvalue(&b);
  }
  luaL_pushresult(&b);

  size_t len = 0;
  const char* s = lua_tolstring(L, -1, &len);
  // See LuaPrint: trap the final allocation's bad_alloc (N5).
  std::string out;
  try {
    out.assign(s ? s : "", s ? len : 0);
  } catch (const std::bad_alloc&) {
    if (s) fwrite(s, 1, len, stdout);
    lua_pop(L, 1);
    return 0;
  }
  lua_pop(L, 1);

  if (runtime && runtime->output_handler_ && !runtime->async_mode_) {
    runtime->output_handler_(out);
  } else {
    fwrite(out.data(), 1, out.size(), stdout);
  }
  return 0;
}

// --- Bytecode / untrusted-chunk guard (E3) ---

void LuaRuntime::SetAllowBytecode(bool allow) {
  if (allow == allow_bytecode_) return;  // no transition: don't stack/unwrap wrappers
  allow_bytecode_ = allow;
  // Protected so the closure allocation (M3) and a __newindex on a _G metatable
  // at the load() reassignment throw rather than abort.
  RunProtected([&]() {
    if (!allow) {
      // Wrap the global load() to force text-only mode (binary chunks rejected).
      lua_getglobal(L_, "load");
      if (lua_isfunction(L_, -1)) {
        lua_pushcclosure(L_, SafeLoad, 1);  // upvalue 1 = original load
        lua_setglobal(L_, "load");
      }
    } else {
      // Re-enable: unwrap by restoring the original load() saved as SafeLoad's
      // upvalue 1. Only touch load() if it is still our wrapper (a user may have
      // replaced it in the meantime).
      lua_getglobal(L_, "load");
      if (lua_iscfunction(L_, -1) && lua_tocfunction(L_, -1) == SafeLoad) {
        if (lua_getupvalue(L_, -1, 1)) {  // push the original load
          lua_setglobal(L_, "load");      // restore it as the global load
        }
      }
    }
  });
}

int LuaRuntime::SafeLoad(lua_State* L) {
  const int nargs = lua_gettop(L);
  lua_pushvalue(L, lua_upvalueindex(1));                       // original load
  lua_pushvalue(L, 1);                                         // chunk
  if (nargs >= 2) lua_pushvalue(L, 2); else lua_pushnil(L);   // chunkname
  lua_pushliteral(L, "t");                                    // force text mode
  if (nargs >= 4) lua_pushvalue(L, 4); else lua_pushnil(L);   // env
  lua_call(L, 4, LUA_MULTRET);
  return lua_gettop(L) - nargs;
}

// --- Dynamic require via a JS searcher (E2) ---

void LuaRuntime::AddJsSearcher(const std::string& host_func_name) {
  if (!HasPackageLibrary()) {
    throw std::runtime_error(
      "Cannot add searcher: the 'package' library is not loaded.");
  }
  // Protected so the closure allocation (M3), the __len on package.searchers,
  // and the append (__newindex) throw rather than abort.
  RunProtected([&]() {
    PushProtectedGlobal("package");
    lua_getfield(L_, -1, "searchers");
    if (!lua_istable(L_, -1)) {
      throw std::runtime_error("package.searchers is not available");
    }
    const lua_Integer len = luaL_len(L_, -1);
    lua_pushstring(L_, host_func_name.c_str());
    lua_pushcclosure(L_, JsSearcher, 1);  // upvalue 1 = host function name
    lua_seti(L_, -2, len + 1);            // append to package.searchers
  });
}

int LuaRuntime::JsSearcher(lua_State* L) {
  const char* modname = lua_tostring(L, 1);
  if (!modname) { lua_pushstring(L, "\n\tinvalid module name"); return 1; }

  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  const char* func_name = lua_tostring(L, lua_upvalueindex(1));
  if (!runtime || !func_name) {
    lua_pushstring(L, "\n\tsearcher unavailable");
    return 1;
  }
  if (runtime->async_mode_) {
    return luaL_error(L, "JS searchers are not available in async mode");
  }

  const auto it = runtime->host_functions_.find(func_name);
  if (it == runtime->host_functions_.end()) {
    lua_pushfstring(L, "\n\tno searcher '%s'", func_name);
    return 1;
  }

  // Stage any raised error on the Lua stack while the LuaPtr / std::string locals
  // are alive, then longjmp (lua_error) only after they are destroyed. On the
  // non-raising paths, `nresults` values are already on the stack.
  bool raise = false;
  int nresults = 1;
  {
    LuaPtr result;
    bool ok = true;
    try {
      std::vector<LuaPtr> args{
        std::make_shared<LuaValue>(LuaValue::from(std::string(modname)))};
      result = it->second(args);
    } catch (const std::exception& e) {
      luaL_where(L, 1);
      lua_pushfstring(L, "searcher for '%s' failed: %s", modname, e.what());
      lua_concat(L, 2);
      raise = true;
      ok = false;
    }

    // Searchers must be synchronous — a Promise result is not supported.
    if (ok && runtime->await_pending_) {
      runtime->await_pending_ = false;
      luaL_where(L, 1);
      lua_pushfstring(L, "JS searcher for '%s' must be synchronous", modname);
      lua_concat(L, 2);
      raise = true;
      ok = false;
    }

    if (ok) {
      if (!result || std::holds_alternative<std::monostate>(result->value)) {
        // nil/absent -> not found by this searcher (try the next one).
        lua_pushfstring(L, "\n\tno JS module '%s'", modname);
      } else if (!std::holds_alternative<std::string>(result->value)) {
        luaL_where(L, 1);
        lua_pushfstring(L,
          "JS searcher for '%s' must return a Lua source string or nil", modname);
        lua_concat(L, 2);
        raise = true;
      } else {
        const std::string& source = std::get<std::string>(result->value);
        const std::string chunkname = "@" + std::string(modname);
        // Force text mode so a searcher can never inject bytecode.
        if (luaL_loadbufferx(L, source.c_str(), source.size(),
                             chunkname.c_str(), "t") != LUA_OK) {
          const char* loaderr = lua_tostring(L, -1);
          luaL_where(L, 1);
          lua_pushfstring(L, "error loading JS module '%s': %s",
                          modname, loaderr ? loaderr : "?");
          lua_concat(L, 2);
          lua_remove(L, -2);  // drop the raw loader error beneath the staged one
          raise = true;
        } else {
          // Return loader + modname (searcher data), per Lua's convention.
          lua_pushstring(L, modname);
          nresults = 2;
        }
      }
    }
  }  // result, args, source, chunkname destroyed here, before any longjmp

  if (raise) {
    // The searcher raises its own descriptive string, not the host bridge's
    // structured value. A JS searcher that threw left a staged error value
    // (StageJsError set it before throwing); drop it so it can't leak to and be
    // mis-raised by a later, unrelated host call that doesn't stage (M12).
    if (runtime->HasPendingErrorValue()) runtime->TakePendingErrorValue();
    return lua_error(L);
  }
  return nresults;
}

// --- Host function bridge ---

int LuaRuntime::LuaCallHostFunction(lua_State* L) {
  const char* func_name = lua_tostring(L, lua_upvalueindex(1));

  // Get runtime
  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  if (!runtime) {
    lua_pushstring(L, "LuaRuntime not found in registry");
    return lua_error(L);
  }

  const auto it = runtime->host_functions_.find(func_name ? func_name : "");
  if (it == runtime->host_functions_.end()) {
    lua_pushfstring(L, "Host function '%s' not found", func_name ? func_name : "");
    return lua_error(L);
  }

  if (runtime->async_mode_) {
    return luaL_error(L,
      "JS callbacks are not available in async mode (called '%s')",
      func_name ? func_name : "<unknown>");
  }

  HostCallOutcome outcome = HostCallOutcome::Return1;
  {
    const int argc = lua_gettop(L);
    std::vector<LuaPtr> args;
    args.reserve(argc);
    bool converted = true;
    try {
      for (int i = 1; i <= argc; ++i) args.push_back(ToLuaValue(L, i));
    } catch (const std::exception& e) {
      lua_pushfstring(L, "Error converting arguments for '%s': %s",
                      func_name ? func_name : "<unknown>", e.what());
      outcome = HostCallOutcome::Raise;
      converted = false;
    }

    if (converted) {
      LuaPtr resultHolder;
      bool called = true;
      try {
        resultHolder = it->second(args);
      } catch (const std::exception& e) {
        // If the wrapper staged a structured error (a JS Error object), raise
        // that table so the original error can be reconstructed on the way out.
        if (runtime->HasPendingErrorValue()) {
          LuaPtr errVal = runtime->TakePendingErrorValue();
          // Protected (F6): an ERRMEM here must not longjmp over errVal/args.
          // On failure the pcall's message is on top and is raised instead.
          try { PushLuaValueProtected(L, errVal); } catch (...) { lua_pushstring(L, e.what()); }
        } else {
          lua_pushfstring(L, "Host function '%s' threw an exception: %s",
                          func_name ? func_name : "<unknown>", e.what());
        }
        outcome = HostCallOutcome::Raise;
        called = false;
      } catch (...) {
        lua_pushfstring(L, "Host function '%s' threw an unknown exception",
                        func_name ? func_name : "<unknown>");
        outcome = HostCallOutcome::Raise;
        called = false;
      }

      if (called) {
        if (runtime->await_pending_) {
          // The host call returned a JS Promise while in the async driver:
          // suspend the coroutine until it settles (AsyncContinuation delivers
          // the resolved value).
          runtime->await_pending_ = false;
          if (L != runtime->await_driver_thread_) {
            // Awaiting from inside a user-created coroutine: yielding here would
            // suspend the wrong thread and deliver the settled value to the
            // driver frame instead. Raise rather than silently misbehave (M1).
            lua_pushfstring(L,
              "cannot await a JS Promise inside a coroutine (called '%s'); "
              "await only at the top level of execute_async",
              func_name ? func_name : "<unknown>");
            outcome = HostCallOutcome::Raise;
          } else {
            outcome = HostCallOutcome::Yield;
          }
        } else {
          try {
            if (PushLuaValueProtected(L, resultHolder) != LUA_OK) {
              // ERRMEM mid-push (F6): the frame unwound with the message on
              // top; raise it after the locals below are destroyed.
              outcome = HostCallOutcome::Raise;
            }
          } catch (const std::exception& e) {
            lua_pushfstring(L, "Error converting return value from '%s': %s",
                            func_name ? func_name : "<unknown>", e.what());
            outcome = HostCallOutcome::Raise;
          }
        }
      }
    }
  }  // all C++ locals destroyed here, before any longjmp below

  switch (outcome) {
    case HostCallOutcome::Raise:
      return lua_error(L);
    case HostCallOutcome::Yield:
      return lua_yieldk(L, 0, 0, AsyncContinuation);
    case HostCallOutcome::Return1:
      return 1;
  }
  return 0;  // unreachable
}

CompileResult LuaRuntime::CompileScript(const std::string& script,
                                         bool strip_debug,
                                         const std::string& chunk_name) const {
  StackGuard guard(L_);

  // Always load size-aware (luaL_loadstring stops at the first embedded NUL).
  // With no explicit chunk name, mirror luaL_loadstring by using the source
  // (up to its first NUL) as the display name.
  const int status = luaL_loadbuffer(
      L_, script.data(), script.size(),
      chunk_name.empty() ? script.c_str() : chunk_name.c_str());

  if (status != LUA_OK) {
    std::string err = lua_tostring(L_, -1);
    return err;
  }

  std::vector<uint8_t> bytecode;
  const int dump_status = lua_dump(L_, [](lua_State*, const void* p, size_t sz, void* ud) -> int {
    auto* bc = static_cast<std::vector<uint8_t>*>(ud);
    auto* bytes = static_cast<const uint8_t*>(p);
    // A std::bad_alloc here must not unwind across lua_dump's C frame; trap it
    // and report failure through the writer's status instead (M4).
    try {
      bc->insert(bc->end(), bytes, bytes + sz);
    } catch (...) {
      return 1;
    }
    return 0;
  }, &bytecode, strip_debug ? 1 : 0);
  if (dump_status != 0) {
    return std::string("failed to serialize bytecode (out of memory?)");
  }

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
  const int dump_status = lua_dump(L_, [](lua_State*, const void* p, size_t sz, void* ud) -> int {
    auto* bc = static_cast<std::vector<uint8_t>*>(ud);
    auto* bytes = static_cast<const uint8_t*>(p);
    try {
      bc->insert(bc->end(), bytes, bytes + sz);
    } catch (...) {
      return 1;
    }
    return 0;
  }, &bytecode, strip_debug ? 1 : 0);
  if (dump_status != 0) {
    return std::string("failed to serialize bytecode (out of memory?)");
  }

  return bytecode;
}

// Message handler for lua_pcall: appends a Lua traceback to string errors and
// leaves structured JS-error tables (identified by __jsErrorId) untouched.
int LuaRuntime::MessageHandler(lua_State* L) {
  if (lua_type(L, 1) == LUA_TTABLE) {
    // Raw probe (no __index): a metatabled error object with a raising __index
    // must not turn this message handler into a nested error (LUA_ERRERR) (L1).
    lua_pushstring(L, kJsErrorIdField);
    lua_rawget(L, 1);
    const bool is_js_error = !lua_isnil(L, -1);
    lua_pop(L, 1);
    if (is_js_error) return 1;  // preserve the structured error object as-is
  }
  const char* msg = lua_tostring(L, 1);
  if (msg == nullptr) {
    if (luaL_callmeta(L, 1, "__tostring") && lua_type(L, -1) == LUA_TSTRING) {
      return 1;  // use the __tostring result
    }
    msg = lua_pushfstring(L, "(error object is a %s value)", luaL_typename(L, 1));
  }
  luaL_traceback(L, L, msg, 1);
  return 1;
}

// Calls a function already on the stack (with nargs args above it) under the
// traceback message handler.
int LuaRuntime::ProtectedCall(int nargs, int nresults) const {
  // Fresh instruction budget per top-level execution (execute_script/file,
  // load_bytecode, a Lua function call). Nested Lua→host→Lua calls re-enter
  // here and legitimately get their own budget; a plain Lua loop that never
  // re-enters keeps accumulating and is caught. No-op when unlimited.
  instruction_count_ = 0;
  const int base = lua_gettop(L_) - nargs;  // index of the function
  lua_pushcfunction(L_, MessageHandler);
  lua_insert(L_, base);  // move handler below the function
  const int status = lua_pcall(L_, nargs, nresults, base);
  lua_remove(L_, base);  // remove handler
  return status;
}

// Runs the pre-pushed trampoline + nargs under lua_pcall; on failure pops the
// error and throws std::runtime_error so the binding layer surfaces it as a JS
// exception (rather than the Lua panic handler aborting the process).
void LuaRuntime::ProtectedTableCall(int nargs, int nresults) const {
  if (lua_pcall(L_, nargs, nresults, 0) != LUA_OK) {
    const char* msg = lua_tostring(L_, -1);
    std::string err = msg ? msg : "table access error";
    lua_pop(L_, 1);
    throw std::runtime_error(err);
  }
}

// Trampoline for RunProtected (M5). A light C function (0 upvalues), so pushing
// it never allocates. It resolves the runtime from the registry, runs the active
// thunk's operation, and captures any C++ exception so it can't unwind across the
// lua_pcall C frame — a Lua OOM instead longjmps straight to the pcall and is
// reported via its status code.
int LuaRuntime::ProtectedThunkRunner(lua_State* L) {
  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  if (!runtime || !runtime->active_thunk_) return 0;
  ProtectedThunk* thunk = runtime->active_thunk_;
  try {
    (*thunk->op)();
  } catch (...) {
    thunk->error = std::current_exception();
  }
  return 0;
}

// Runs `op` inside a lua_pcall frame so a Lua memory error (or a metamethod
// raise) becomes a caught std::runtime_error rather than an unprotected panic
// (M5). See the header for the stack-self-containment contract.
void LuaRuntime::RunProtected(const std::function<void()>& op) const {
  ProtectedThunk thunk{&op, nullptr};
  ProtectedThunk* prev = active_thunk_;
  active_thunk_ = &thunk;
  // Light C function (0 upvalues) — Lua guarantees this push never raises a
  // memory error, so the protected frame is established before any allocation.
  lua_pushcfunction(L_, ProtectedThunkRunner);
  const int status = lua_pcall(L_, 0, 0, 0);
  active_thunk_ = prev;

  // A C++ exception thrown by `op` was caught in the trampoline: rethrow it here,
  // in normal C++ control flow, now that the pcall frame has been left.
  if (thunk.error) std::rethrow_exception(thunk.error);
  if (status != LUA_OK) {
    // A Lua error (typically LUA_ERRMEM under maxMemory). pcall left the message
    // on top and unwound the stack; surface it as a catchable C++ exception.
    const char* msg = lua_tostring(L_, -1);
    std::string err = msg ? msg : "protected operation failed (out of memory?)";
    lua_pop(L_, 1);
    throw std::runtime_error(err);
  }
}

// Trampoline for ToLuaValueProtected. Like ProtectedThunkRunner it is a light C
// function (0 upvalues), but the value to convert is passed as its single
// argument: a pcall frame cannot address the caller's stack slots, so the value
// has to enter the frame the way any argument does.
int LuaRuntime::ProtectedConvertRunner(lua_State* L) {
  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  if (!runtime || !runtime->active_convert_) return 0;
  ProtectedConvert* convert = runtime->active_convert_;
  try {
    convert->result = ToLuaValue(L, 1);
  } catch (...) {
    convert->error = std::current_exception();
  }
  return 0;
}

// Reads a value out of Lua under protection (M5 residual). See the header for
// why only aggregates take the protected path and why it runs on the main state.
LuaPtr LuaRuntime::ToLuaValueProtected(lua_State* from, const int index) const {
  const int abs_index = lua_absindex(from, index);
  switch (lua_type(from, abs_index)) {
    case LUA_TTABLE:
    case LUA_TFUNCTION:
    case LUA_TTHREAD:
    case LUA_TUSERDATA:
      break;
    default:
      // nil / boolean / number / string: ToLuaValue performs no Lua allocation
      // for these, so there is nothing an ERRMEM could interrupt.
      return ToLuaValue(from, abs_index);
  }
  // Reserve the trampoline + argument slots before the frame is set up, so the
  // setup itself can't be the thing that fails (lua_checkstack reports failure
  // by return value rather than raising).
  if (!lua_checkstack(L_, 2) || (from != L_ && !lua_checkstack(from, 1))) {
    throw std::runtime_error("Lua stack overflow while reading a value");
  }
  ProtectedConvert convert;
  ProtectedConvert* prev = active_convert_;
  active_convert_ = &convert;
  // Light C function (0 upvalues) — its push never allocates, so the protected
  // frame is established before anything inside it can raise.
  lua_pushcfunction(L_, ProtectedConvertRunner);
  if (from == L_) {
    lua_pushvalue(L_, abs_index);
  } else {
    lua_pushvalue(from, abs_index);
    lua_xmove(from, L_, 1);
  }
  const int status = lua_pcall(L_, 1, 0, 0);
  active_convert_ = prev;

  // A C++ exception thrown by ToLuaValue (depth/stack limits) was caught in the
  // trampoline: rethrow it now that the pcall frame has been left.
  if (convert.error) std::rethrow_exception(convert.error);
  if (status != LUA_OK) {
    // Typically LUA_ERRMEM under maxMemory. pcall left the message on top and
    // unwound the stack; surface it as a catchable C++ exception.
    const char* msg = lua_tostring(L_, -1);
    std::string err = msg ? msg : "value conversion failed (out of memory?)";
    lua_pop(L_, 1);
    throw std::runtime_error(err);
  }
  if (!convert.result) {
    throw std::runtime_error("value conversion failed");
  }
  return convert.result;
}

// Trampoline for PushLuaValueProtected: [desc] -> [value]. The descriptor
// arrives as a light-userdata argument rather than via a runtime member
// because the bridges run on whichever thread called them and a pcall frame
// can't see the caller's stack — and a light userdata is a value, so pushing
// it never allocates. A C++ exception from PushLuaValue is captured so it
// can't unwind across the pcall's C frame; a Lua ERRMEM longjmps to the pcall
// and is reported via its status code.
int LuaRuntime::ProtectedPushRunner(lua_State* L) {
  auto* push = static_cast<ProtectedPush*>(lua_touserdata(L, 1));
  if (!push) return 0;
  try {
    PushLuaValue(L, *push->value);
    return 1;
  } catch (...) {
    push->error = std::current_exception();
    return 0;
  }
}

// Pushes a bridge result under protection (CR-8 F6); see the header. The
// two-slot setup (trampoline + descriptor) is reserved via lua_checkstack,
// which reports failure by return value rather than raising.
int LuaRuntime::PushLuaValueProtected(lua_State* L, const LuaPtr& value) {
  if (!lua_checkstack(L, 2)) {
    throw std::runtime_error("Lua stack overflow while pushing a result");
  }
  ProtectedPush push{&value, nullptr};
  lua_pushcfunction(L, ProtectedPushRunner);  // light C function: never raises
  lua_pushlightuserdata(L, &push);            // a value, not an allocation
  const int status = lua_pcall(L, 1, 1, 0);
  if (push.error) {
    // The conversion threw C++-side; the runner returned 0 results and the
    // pcall pushed a nil to satisfy nresults = 1. Drop it and rethrow now, in
    // normal control flow.
    if (status == LUA_OK) lua_pop(L, 1);
    std::rethrow_exception(push.error);
  }
  return status;
}

// Captures the error object at the top of L's stack: records the structured
// value (for JS-Error reconstruction) and returns a display string.
//
// This runs on unprotected paths (coroutine resume / async step have no message
// handler), so it must never invoke a user metamethod without a protected frame:
// ToLuaValue does only raw traversal, the "message" lookup uses lua_rawget (no
// __index), and stringification goes through a protected __tostring trampoline.
std::string LuaRuntime::CaptureError(lua_State* L) const {
  try {
    last_error_value_ = ToLuaValueProtected(L, -1);
  } catch (const std::exception&) {
    // A pathological error object (nested past kMaxDepth, or a stack overflow
    // while reading it) must not throw out of the error path — every execution
    // path funnels its failures through here, and a throw would unwind across
    // the N-API boundary and terminate the process (H1). Leave the structured
    // value absent; LuaErrorToJsValue already falls back to the display string.
    last_error_value_.reset();
  }
  if (lua_type(L, -1) == LUA_TTABLE) {
    lua_pushstring(L, "message");
    lua_rawget(L, -2);  // raw: won't fire __index on a user error object
    if (lua_type(L, -1) == LUA_TSTRING) {
      std::string m = lua_tostring(L, -1);
      lua_pop(L, 1);
      return m;
    }
    lua_pop(L, 1);
  }
  // Stringify under protection so a raising __tostring can't panic here.
  lua_pushcfunction(L, ProtectedToString);
  lua_pushvalue(L, -2);  // the error value
  if (lua_pcall(L, 1, 1, 0) == LUA_OK && lua_type(L, -1) == LUA_TSTRING) {
    size_t len = 0;
    const char* s = lua_tolstring(L, -1, &len);
    std::string msg(s ? s : "", s ? len : 0);
    lua_pop(L, 1);
    return msg;
  }
  lua_pop(L, 1);  // pop the failed pcall result / non-string
  // Fallback that never runs user code (the error value is still at -1).
  return std::string("(error object is a ") + luaL_typename(L, -1) + " value)";
}

ScriptResult LuaRuntime::LoadBytecode(const std::vector<uint8_t>& bytecode,
                                       const std::string& chunk_name) const {
  if (bytecode.empty()) {
    return std::string("Bytecode cannot be empty");
  }
  if (!allow_bytecode_) {
    return std::string("bytecode loading is disabled in this context");
  }

  last_error_value_.reset();
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

  if (ProtectedCall(0, LUA_MULTRET) != LUA_OK) {
    std::string error = CaptureError(L_);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_) - stackBefore;
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  try {
    for (int i = 0; i < nresults; ++i) {
      results.push_back(ToLuaValueProtected(L_, stackBefore + 1 + i));
    }
  } catch (const std::exception& e) {
    lua_pop(L_, nresults);
    return std::string(e.what());
  }
  lua_pop(L_, nresults);
  return results;
}

ScriptResult LuaRuntime::ExecuteScript(const std::string& script) const {
  last_error_value_.reset();
  const int stackBefore = lua_gettop(L_);

  // Size-aware load so scripts with embedded NULs aren't silently truncated.
  if (luaL_loadbuffer(L_, script.data(), script.size(), script.c_str()) != LUA_OK) {
    std::string error = CaptureError(L_);
    lua_pop(L_, 1);
    return error;
  }
  if (ProtectedCall(0, LUA_MULTRET) != LUA_OK) {
    std::string error = CaptureError(L_);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_) - stackBefore;
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  try {
    for (int i = 0; i < nresults; ++i) {
      results.push_back(ToLuaValueProtected(L_, stackBefore + 1 + i));
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

  last_error_value_.reset();
  const int stackBefore = lua_gettop(L_);

  if (luaL_loadfile(L_, filepath.c_str()) != LUA_OK) {
    std::string error = CaptureError(L_);
    lua_pop(L_, 1);
    return error;
  }
  if (ProtectedCall(0, LUA_MULTRET) != LUA_OK) {
    std::string error = CaptureError(L_);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_) - stackBefore;
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  try {
    for (int i = 0; i < nresults; ++i) {
      results.push_back(ToLuaValueProtected(L_, stackBefore + 1 + i));
    }
  } catch (const std::exception& e) {
    lua_pop(L_, nresults);
    return std::string(e.what());
  }
  lua_pop(L_, nresults);
  return results;
}

void LuaRuntime::SetGlobal(const std::string& name, const LuaPtr& value) const {
  // One protected frame covers the key-string allocation, the (arbitrarily
  // large) value the caller is assigning, and the store itself — so both a
  // __newindex metamethod on the globals table (M4) and an OOM building the
  // key or value (M5) surface as a std::runtime_error instead of an
  // unprotected panic. Staging the value in the caller, as this used to, left
  // the whole of PushLuaValue outside the frame. StackGuard also clears a
  // partially-built value if PushLuaValue throws a C++ exception.
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);  // globals table
    lua_pushlstring(L_, name.data(), name.size());          // key
    PushLuaValue(L_, value);                                // value
    lua_settable(L_, -3);                                   // may fire __newindex
  });
}

void LuaRuntime::RegisterFunction(const std::string& name, Function fn) {
  // Install _G[name] = <closure> inside a protected frame so BOTH a __newindex
  // metamethod on the globals table (M4) AND an OOM allocating the key string /
  // closure (M5) surface as a std::runtime_error instead of an unprotected panic.
  RunProtected([&]() {
    lua_rawgeti(L_, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);  // globals table
    lua_pushlstring(L_, name.data(), name.size());          // key (size-aware)
    lua_pushstring(L_, name.c_str());                       // closure upvalue
    lua_pushcclosure(L_, LuaCallHostFunction, 1);           // value = closure
    lua_settable(L_, -3);                                   // _G[key]=closure (may __newindex)
    lua_pop(L_, 1);                                         // pop globals table
  });
  // Stored only after the protected _G write succeeds, so a raising __newindex
  // doesn't leave an entry with no global pointing at it (N5).
  host_functions_[name] = std::move(fn);
}

// Trampoline for PushProtectedGlobal: [] -> [value]. Light C function (0
// upvalues) so its own push can't allocate; it then pushes the key string and
// reads _G[key] from *inside* the frame, which is the point — staging the key
// in the caller would leave that allocation unprotected.
int LuaRuntime::ProtectedGlobalGetRunner(lua_State* L) {
  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  if (!runtime || !runtime->active_global_name_) {
    lua_pushnil(L);
    return 1;
  }
  const std::string& name = *runtime->active_global_name_;
  lua_rawgeti(L, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);  // globals table
  lua_pushlstring(L, name.data(), name.size());          // key (may allocate)
  lua_gettable(L, -2);                                   // may fire __index
  return 1;
}

// Reads _G[name] under protection, leaving the value on top of the stack.
// Callers manage stack cleanup (typically via StackGuard).
void LuaRuntime::PushProtectedGlobal(const std::string& name) const {
  if (!lua_checkstack(L_, 2)) {
    throw std::runtime_error("Lua stack overflow while reading a global");
  }
  const std::string* prev = active_global_name_;
  active_global_name_ = &name;
  lua_pushcfunction(L_, ProtectedGlobalGetRunner);
  const int status = lua_pcall(L_, 0, 1, 0);
  active_global_name_ = prev;
  if (status != LUA_OK) {
    const char* msg = lua_tostring(L_, -1);
    std::string err = msg ? msg : "global access error";
    lua_pop(L_, 1);
    throw std::runtime_error(err);
  }
}

LuaPtr LuaRuntime::GetGlobal(const std::string& name) const {
  // Read through a protected _G[name] so a __index metamethod on the globals
  // table surfaces as a std::runtime_error instead of an unprotected panic.
  StackGuard guard(L_);
  PushProtectedGlobal(name);
  return ToLuaValueProtected(L_, -1);
}

void LuaRuntime::SetGlobalPath(const std::vector<std::string>& path, const LuaPtr& value) const {
  // One protected frame covers the whole traversal: an __index/__newindex
  // metamethod raise, an OOM building a key/table/value, or an attempt to index
  // a non-table intermediate all surface as a std::runtime_error. StackGuard
  // (a local of the lambda) restores the stack whether the lambda returns or
  // throws — the ProtectedThunkRunner catches the C++ throw after unwinding.
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);  // current container

    // Walk every segment but the last, descending into (or creating) tables.
    for (size_t i = 0; i + 1 < path.size(); ++i) {
      const std::string& seg = path[i];
      lua_pushlstring(L_, seg.data(), seg.size());  // key
      lua_gettable(L_, -2);                          // current[seg] (fires __index)

      if (lua_isnil(L_, -1)) {
        // Missing intermediate: create a fresh table, store it under the key,
        // and descend into it. pushvalue keeps a copy so the stored table
        // becomes the working container regardless of the store's mechanics.
        lua_pop(L_, 1);                                // drop nil
        lua_newtable(L_);                              // [current, newtable]
        lua_pushlstring(L_, seg.data(), seg.size());   // [current, newtable, key]
        lua_pushvalue(L_, -2);                         // [current, newtable, key, newtable]
        lua_settable(L_, -4);                          // current[seg]=newtable (fires __newindex)
        lua_remove(L_, -2);                            // drop current -> [newtable]
      } else if (lua_istable(L_, -1)) {
        lua_remove(L_, -2);                            // drop current -> [table]
      } else {
        const std::string type = lua_typename(L_, lua_type(L_, -1));
        throw std::runtime_error(
          "cannot set global path: intermediate '" + seg + "' is a " + type +
          ", not a table");
      }
    }

    // Assign the leaf: container[last] = value.
    const std::string& last = path.back();
    lua_pushlstring(L_, last.data(), last.size());  // key
    PushLuaValue(L_, value);                         // value (may allocate / recurse)
    lua_settable(L_, -3);                            // fires __newindex
  });
}

LuaPtr LuaRuntime::GetGlobalPath(const std::vector<std::string>& path) const {
  LuaPtr result;
  // Protected for the same reasons as GetGlobal, extended across each hop.
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);  // current container

    for (size_t i = 0; i < path.size(); ++i) {
      const std::string& seg = path[i];
      lua_pushlstring(L_, seg.data(), seg.size());  // key
      lua_gettable(L_, -2);                          // current[seg] (fires __index)
      lua_remove(L_, -2);                            // drop container, keep value
      // A nil anywhere short-circuits the whole path to nil, and stops us from
      // trying to index that nil on the next hop (which would raise). A non-nil,
      // non-indexable intermediate instead falls through and the next
      // lua_gettable raises "attempt to index a <type> value" — reported as an
      // error, matching what `config.db.host` would do in a Lua script.
      if (lua_isnil(L_, -1)) break;
    }

    // Convert the leaf (an aggregate is converted here under protection, the
    // same pattern GetTableField uses).
    result = ToLuaValue(L_, -1);
  });
  return result;
}

ScriptResult LuaRuntime::CallFunction(const LuaFunctionRef& funcRef,
                                      const std::vector<LuaPtr>& args) const {
  last_error_value_.reset();
  const int stackBefore = lua_gettop(L_);

  if (!lua_checkstack(L_, static_cast<int>(args.size()) + LUA_MINSTACK)) {
    return std::string("stack overflow: too many arguments to Lua function");
  }
  lua_rawgeti(L_, LUA_REGISTRYINDEX, funcRef.ref);

  // PushLuaValue throws on depth/stack overflow; if it does, restore the stack
  // and return a string error rather than letting the exception unwind out of
  // this method (and, via the function-handle trampoline, past N-API) (H1).
  try {
    for (const auto& arg : args) {
      PushLuaValue(L_, arg);
    }
  } catch (const std::exception& e) {
    lua_settop(L_, stackBefore);
    return std::string("Error converting argument to Lua function: ") + e.what();
  }

  if (ProtectedCall(static_cast<int>(args.size()), LUA_MULTRET) != LUA_OK) {
    std::string error = CaptureError(L_);
    lua_pop(L_, 1);
    return error;
  }

  const int nresults = lua_gettop(L_) - stackBefore;
  std::vector<LuaPtr> results;
  results.reserve(nresults);
  try {
    for (int i = 0; i < nresults; ++i) {
      results.push_back(ToLuaValueProtected(L_, stackBefore + 1 + i));
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
  // Reserve headroom for this level's working set (metatable probe, key/value
  // during traversal). Lua only guarantees LUA_MINSTACK free slots and the raw
  // push APIs do not grow the stack, so deep/wide tables would otherwise overrun.
  if (!lua_checkstack(L, 4)) {
    throw std::runtime_error("Lua stack overflow while reading a value");
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
      // Check if it's a registered class instance (per-class metatable carries
      // a __lua_native_class marker). Treat as JS-backed userdata.
      if (lua_getmetatable(L, abs_index)) {
        lua_getfield(L, -1, kClassMarkerField);
        if (lua_isstring(L, -1)) {
          std::string class_name = lua_tostring(L, -1);
          lua_pop(L, 2);  // marker + metatable
          auto* block = static_cast<int*>(lua_touserdata(L, abs_index));
          if (block) {
            return std::make_shared<LuaValue>(LuaValue::from(
              LuaUserdataRef(*block, L, false, LUA_NOREF, false, std::move(class_name))));
          }
        } else {
          lua_pop(L, 2);  // non-string field + metatable
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
  // Reserve headroom before pushing (raw push APIs don't grow the stack). Each
  // recursion level ensures its own additional slots, so nested containers
  // accumulate the space they need instead of overrunning a full stack.
  if (!lua_checkstack(L, 4)) {
    throw std::runtime_error("Lua stack overflow while pushing a value");
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
        } else if constexpr (std::is_same_v<T, LuaFunctionRef> ||
                             std::is_same_v<T, LuaThreadRef> ||
                             std::is_same_v<T, LuaTableRef>) {
          lua_rawgeti(L, LUA_REGISTRYINDEX, v.ref);
        } else if constexpr (std::is_same_v<T, LuaUserdataRef>) {
          if (v.opaque) {
            // Lua-created userdata - push from registry
            lua_rawgeti(L, LUA_REGISTRYINDEX, v.registry_ref);
          } else {
            // JS-created userdata - create a new userdata block with same ref_id
            auto* block = static_cast<int*>(lua_newuserdata(L, sizeof(int)));
            *block = v.ref_id;
            if (!v.class_name.empty()) {
              // Class instance - use the per-class metatable
              const std::string mt_name = std::string(kClassMetaPrefix) + v.class_name;
              luaL_setmetatable(L, mt_name.c_str());
            } else {
              luaL_setmetatable(L, v.proxy ? kProxyUserdataMetaName : kUserdataMetaName);
            }
            // Increment ref count so __gc balances correctly
            lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
            auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
            lua_pop(L, 1);
            if (runtime) runtime->IncrementUserdataRefCount(v.ref_id);
          }
        } else if constexpr (std::is_same_v<T, HostFunctionName>) {
          // Materialize a registered host function as a Lua closure (upvalue 1 =
          // the host function name), the same shape RegisterFunction installs.
          lua_pushlstring(L, v.name.c_str(), v.name.size());
          // If the name is reclaimable (an anonymous nested callback), attach a
          // sentinel userdata as upvalue 2 whose __gc reclaims the registry
          // entry once this closure is collected, and bump the live-closure
          // count. LuaCallHostFunction only reads upvalue 1, so the extra
          // upvalue is inert to the call path (M2).
          bool reclaimable = false;
          lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
          if (auto* rt = static_cast<LuaRuntime*>(lua_touserdata(L, -1))) {
            lua_pop(L, 1);
            if (rt->reclaimable_host_fns_.count(v.name)) {
              reclaimable = true;
              // Build the sentinel fully before touching the live count: if
              // either allocation below raises LUA_ERRMEM, no accounting has
              // happened, so no phantom +1 can strand the entry (N1). The slot
              // stays null (its __gc no-ops) until the count owns a decrement.
              auto** slot = static_cast<std::string**>(
                  lua_newuserdatauv(L, sizeof(std::string*), 0));
              *slot = nullptr;
              luaL_setmetatable(L, kHostFnSentinelMeta);
              // Re-find after the raise-capable allocations: a GC step inside
              // them can collect this name's last live closure and erase the
              // entry (the count is not pinned yet). If that happened, the
              // host function is gone — leave the sentinel inert; the closure
              // raises the missing-function error if it is ever called.
              auto it = rt->reclaimable_host_fns_.find(v.name);
              if (it != rt->reclaimable_host_fns_.end()) {
                // Arm, then count: a bad_alloc from the string copy leaves the
                // slot null and the count untouched (still balanced), and once
                // armed the increment cannot fail. If the closure push below
                // raises, the unwound sentinel's __gc performs the matching
                // decrement.
                *slot = new std::string(v.name);
                ++it->second;
              }
            }
          } else {
            lua_pop(L, 1);
          }
          lua_pushcclosure(L, LuaCallHostFunction, reclaimable ? 2 : 1);
        }
      },
      value->value);
}

// --- Table reference operations ---

// The six field accessors below all run key staging, value staging, the table
// operation itself and (for the getters) the result conversion inside ONE
// protected frame. Staging the key/value in the caller — as these used to —
// left PushTableKey's string push and the whole of PushLuaValue outside any
// pcall, so an OOM there under an exhausted maxMemory panicked (M5). Only PODs
// live in the thunks; the C++ results are declared outside, so an ERRMEM
// longjmp has no destructor of consequence to skip.

LuaPtr LuaRuntime::GetTableField(int registry_ref, const std::string& key) const {
  LuaPtr result;
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);  // table
    PushTableKey(L_, key);                             // key
    lua_gettable(L_, -2);                              // may trigger __index
    result = ToLuaValue(L_, -1);
  });
  return result;
}

void LuaRuntime::SetTableField(int registry_ref, const std::string& key, const LuaPtr& value) const {
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);  // table
    PushTableKey(L_, key);                             // key
    PushLuaValue(L_, value);                           // value
    lua_settable(L_, -3);                              // may trigger __newindex
  });
}

bool LuaRuntime::HasTableField(int registry_ref, const std::string& key) const {
  bool present = false;
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);  // table
    PushTableKey(L_, key);                             // key
    lua_gettable(L_, -2);                              // may trigger __index
    present = !lua_isnil(L_, -1);
  });
  return present;
}

LuaPtr LuaRuntime::GetTableFieldKeyed(int registry_ref, const TableKey& key) const {
  LuaPtr result;
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);  // table
    PushTableKey(L_, key);                             // key
    lua_gettable(L_, -2);                              // may trigger __index
    result = ToLuaValue(L_, -1);
  });
  return result;
}

void LuaRuntime::SetTableFieldKeyed(int registry_ref, const TableKey& key, const LuaPtr& value) const {
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);  // table
    PushTableKey(L_, key);                             // key
    PushLuaValue(L_, value);                           // value
    lua_settable(L_, -3);                              // may trigger __newindex
  });
}

bool LuaRuntime::HasTableFieldKeyed(int registry_ref, const TableKey& key) const {
  bool present = false;
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);  // table
    PushTableKey(L_, key);                             // key
    lua_gettable(L_, -2);                              // may trigger __index
    present = !lua_isnil(L_, -1);
  });
  return present;
}

std::vector<std::string> LuaRuntime::GetTableKeys(int registry_ref) const {
  // Protected because stringifying a *number* key allocates the resulting Lua
  // string (M5); traversal itself is raw and fires no metamethod. `keys` is
  // declared out here so an ERRMEM longjmp can't skip its destructor — the
  // partial result is simply discarded with the exception.
  std::vector<std::string> keys;
  RunProtected([&]() {
    StackGuard guard(L_);
    lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);
    // A stale/released ref (or a non-table slot) must not reach lua_next: raw
    // traversal of a non-table is an API violation. Bail out with no keys.
    if (!lua_istable(L_, -1)) {
      return;
    }

    lua_pushnil(L_);
    while (lua_next(L_, -2) != 0) {
      if (lua_type(L_, -2) == LUA_TSTRING) {
        // Length-aware so keys containing embedded NULs aren't truncated.
        size_t len = 0;
        const char* str = lua_tolstring(L_, -2, &len);
        keys.emplace_back(str, len);
      } else if (lua_type(L_, -2) == LUA_TNUMBER) {
        lua_pushvalue(L_, -2);  // stringify a copy (never mutate the live key)
        size_t len = 0;
        const char* str = lua_tolstring(L_, -1, &len);
        keys.emplace_back(str, len);
        lua_pop(L_, 1);
      }
      lua_pop(L_, 1);  // pop value, keep key
    }
  });
  return keys;
}

int64_t LuaRuntime::GetTableLength(int registry_ref) const {
  StackGuard guard(L_);
  lua_pushcfunction(L_, ProtectedTableLen);
  lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);  // table
  ProtectedTableCall(1, 1);                          // -> len (may trigger __len)
  return static_cast<int64_t>(lua_tointeger(L_, -1));
}

// --- Table reference API ---

int LuaRuntime::CreateTable() {
  // Protected so an OOM (under maxMemory) in lua_newtable/luaL_ref throws instead
  // of aborting (M5). The table is created and ref'd entirely inside the frame.
  int ref = LUA_NOREF;
  RunProtected([&]() {
    lua_newtable(L_);
    ref = luaL_ref(L_, LUA_REGISTRYINDEX);
  });
  return ref;
}

int LuaRuntime::CreateTableFrom(const LuaTable& initial) {
  // Build and ref the whole table inside a protected frame so an OOM anywhere in
  // the build throws rather than aborting (M5). PushLuaValue may also throw a C++
  // exception (depth/stack); RunProtected captures and rethrows it. On any error
  // the pcall unwinds the partially-built table, so no StackGuard is needed.
  int ref = LUA_NOREF;
  RunProtected([&]() {
    lua_newtable(L_);
    for (const auto& [key, value] : initial) {
      PushLuaValue(L_, value);
      lua_setfield(L_, -2, key.c_str());
    }
    ref = luaL_ref(L_, LUA_REGISTRYINDEX);
  });
  return ref;
}

int LuaRuntime::CreateTableFrom(const LuaArray& initial) const {
  int ref = LUA_NOREF;
  RunProtected([&]() {
    lua_createtable(L_, static_cast<int>(initial.size()), 0);
    for (size_t i = 0; i < initial.size(); ++i) {
      PushLuaValue(L_, initial[i]);
      lua_seti(L_, -2, static_cast<lua_Integer>(i) + 1);
    }
    ref = luaL_ref(L_, LUA_REGISTRYINDEX);
  });
  return ref;
}

std::variant<int, std::string> LuaRuntime::GetGlobalRef(const std::string& name) const {
  // Read _G[name] and ref it inside one protected frame so both a raising
  // __index metamethod (M4) and an OOM in the lua_gettable/luaL_ref allocation
  // (M5) surface as a caught error instead of a panic. The value must be fetched
  // inside the frame (a pcall frame can't reach a value left by the caller).
  int ref = LUA_NOREF;
  int got_type = LUA_TNIL;
  RunProtected([&]() {
    lua_rawgeti(L_, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);  // globals table
    lua_pushlstring(L_, name.data(), name.size());          // key
    lua_gettable(L_, -2);                                   // _G[name] (may __index)
    lua_remove(L_, -2);                                     // drop globals table
    got_type = lua_type(L_, -1);
    if (got_type == LUA_TTABLE) {
      ref = luaL_ref(L_, LUA_REGISTRYINDEX);                // pops the value
    } else {
      lua_pop(L_, 1);
    }
  });
  if (got_type != LUA_TTABLE) {
    return "global '" + name + "' is not a table (got " +
           lua_typename(L_, got_type) + ")";
  }
  return ref;
}

std::vector<std::pair<LuaPtr, LuaPtr>> LuaRuntime::TablePairs(int registry_ref) const {
  StackGuard guard(L_);
  std::vector<std::pair<LuaPtr, LuaPtr>> result;

  lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);
  if (!lua_istable(L_, -1)) {
    return result;
  }

  // lua_next performs a raw traversal (no metamethods), so this loop needs no
  // protected call. Determine the key type first and skip unsupported keys
  // before converting the value, so nothing is converted needlessly.
  lua_pushnil(L_);
  while (lua_next(L_, -2) != 0) {
    LuaPtr key;
    const int key_type = lua_type(L_, -2);
    if (key_type == LUA_TSTRING) {
      size_t len;
      const char* str = lua_tolstring(L_, -2, &len);
      key = std::make_shared<LuaValue>(LuaValue::from(std::string(str, len)));
    } else if (key_type == LUA_TNUMBER) {
      if (lua_isinteger(L_, -2)) {
        key = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(lua_tointeger(L_, -2))));
      } else {
        key = std::make_shared<LuaValue>(LuaValue::from(static_cast<double>(lua_tonumber(L_, -2))));
      }
    } else {
      // Skip non-string/non-number keys
      lua_pop(L_, 1);
      continue;
    }
    LuaPtr value = ToLuaValueProtected(L_, lua_absindex(L_, -1));
    result.emplace_back(std::move(key), std::move(value));
    lua_pop(L_, 1);  // pop value, keep key for next iteration
  }

  return result;
}

std::vector<std::pair<int64_t, LuaPtr>> LuaRuntime::TableIPairs(int registry_ref) const {
  StackGuard guard(L_);
  std::vector<std::pair<int64_t, LuaPtr>> result;

  // Collect the dense-sequence values into a plain Lua array under protection
  // (lua_geti can trigger __index), then convert that array to C++ afterwards so
  // no C++ locals are live across a potential metamethod raise.
  lua_pushcfunction(L_, ProtectedTableICollect);
  lua_rawgeti(L_, LUA_REGISTRYINDEX, registry_ref);
  if (!lua_istable(L_, -1)) {
    return result;  // StackGuard drops the function + non-table value
  }
  ProtectedTableCall(1, 1);  // -> array of values

  const int n = static_cast<int>(lua_rawlen(L_, -1));
  result.reserve(n);
  for (int i = 1; i <= n; ++i) {
    lua_rawgeti(L_, -1, i);
    result.emplace_back(i, ToLuaValueProtected(L_, -1));
    lua_pop(L_, 1);
  }
  return result;
}

void LuaRuntime::ReleaseTableRef(int registry_ref) {
  if (registry_ref != LUA_NOREF && registry_ref != LUA_REFNIL) {
    // Route through the deferral queue so a caller invoking this while a worker
    // owns the state doesn't mutate the registry concurrently (H9c) (L5).
    UnrefOrDefer(registry_ref);
  }
}

// --- Coroutine support ---

std::variant<LuaThreadRef, std::string> LuaRuntime::CreateCoroutine(const LuaFunctionRef& funcRef) const {
  // Build and anchor the thread inside a protected frame so an OOM under
  // maxMemory in lua_newthread/luaL_ref throws instead of aborting (M3).
  lua_State* thread = nullptr;
  int threadRef = LUA_NOREF;
  try {
    RunProtected([&]() {
      thread = lua_newthread(L_);                     // [thread]
      threadRef = luaL_ref(L_, LUA_REGISTRYINDEX);    // anchors it (pops thread)
      lua_rawgeti(L_, LUA_REGISTRYINDEX, funcRef.ref);  // push the function
      lua_xmove(L_, thread, 1);                        // move it onto the thread
    });
  } catch (const std::exception& e) {
    return std::string(e.what());
  }
  if (!thread) {
    return std::string("Failed to create coroutine thread");
  }

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
  if (!lua_checkstack(threadRef.thread, static_cast<int>(args.size()) + LUA_MINSTACK)) {
    result.status = CoroutineStatus::Dead;
    result.error = "stack overflow: too many coroutine arguments";
    return result;
  }
  try {
    for (const auto& arg : args) {
      PushLuaValue(threadRef.thread, arg);
    }
  } catch (const std::exception& e) {
    result.status = CoroutineStatus::Dead;
    result.error = std::string("Error converting coroutine arguments: ") + e.what();
    return result;
  }

  // Resume the coroutine (fresh instruction budget for this resume step).
  instruction_count_ = 0;
  int nresults = 0;
  int resumeStatus = lua_resume(threadRef.thread, L_, static_cast<int>(args.size()), &nresults);

  if (resumeStatus == LUA_YIELD) {
    result.status = CoroutineStatus::Suspended;
    // Collect yielded values
    try {
      for (int i = 1; i <= nresults; ++i) {
        result.values.push_back(ToLuaValueProtected(threadRef.thread, i));
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
        result.values.push_back(ToLuaValueProtected(threadRef.thread, i));
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
    // Use CaptureError: the error object may be a table (e.g. error({code=1}) or
    // a structured JS-error) for which lua_tostring returns NULL — constructing a
    // std::string from NULL is undefined behavior. This also records the
    // structured value for JS-error reconstruction, matching the other paths.
    result.error = CaptureError(threadRef.thread);
    lua_pop(threadRef.thread, 1);
  }

  return result;
}

// Reports Suspended or Dead only. CoroutineStatus::Running is never returned:
// with the single-threaded driver a coroutine is never observed mid-execution
// from here (a resume runs to its next yield or completion before returning).
CoroutineStatus LuaRuntime::GetCoroutineStatus(const LuaThreadRef& threadRef) {
  if (!threadRef.thread) {
    return CoroutineStatus::Dead;
  }

  if (const int status = lua_status(threadRef.thread); status == LUA_YIELD) {
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

// --- Coroutine-driven async execution ---

void LuaRuntime::SetAwaitDriverMode(bool enabled) { await_driver_mode_ = enabled; }
bool LuaRuntime::IsAwaitDriverMode() const { return await_driver_mode_; }
void LuaRuntime::SetAwaitDriverThread(lua_State* thread) { await_driver_thread_ = thread; }
void LuaRuntime::RequestAwaitYield() { await_pending_ = true; }
void LuaRuntime::RequestCancel() { cancel_requested_ = true; }
bool LuaRuntime::IsCancelRequested() const { return cancel_requested_; }
void LuaRuntime::ClearCancel() { cancel_requested_ = false; }

std::variant<LuaThreadRef, std::string> LuaRuntime::CreateCoroutineFromScript(
    const std::string& script) const {
  StackGuard guard(L_);

  // Load the script chunk as a function on the main stack (size-aware so
  // embedded NULs aren't truncated).
  if (luaL_loadbuffer(L_, script.data(), script.size(), script.c_str()) != LUA_OK) {
    const char* msg = lua_tostring(L_, -1);
    return std::string(msg ? msg : "failed to load script");
  }
  // Stack: [chunk]. Create + anchor the thread inside a protected frame so an OOM
  // in lua_newthread / luaL_ref throws instead of aborting (M5). These run in the
  // pcall frame (above the chunk), so they don't touch the chunk left below.
  lua_State* thread = nullptr;
  int threadRef = LUA_NOREF;
  RunProtected([&]() {
    thread = lua_newthread(L_);
    threadRef = luaL_ref(L_, LUA_REGISTRYINDEX);  // pops the thread, anchors it
  });
  if (!thread) {
    return std::string("Failed to create coroutine thread");
  }
  // Stack: [chunk] again (pcall restored it). Move the chunk onto the thread.
  lua_xmove(L_, thread, 1);

  return LuaThreadRef(threadRef, L_, thread);
}

// Continuation resumed after a host call suspended to await a JS promise.
// The resume argument (resolved value, or rejection message) sits on top.
int LuaRuntime::AsyncContinuation(lua_State* L, int status, lua_KContext ctx) {
  (void)status;
  (void)ctx;
  lua_getfield(L, LUA_REGISTRYINDEX, kRuntimeRegistryKey);
  auto* runtime = static_cast<LuaRuntime*>(lua_touserdata(L, -1));
  lua_pop(L, 1);

  if (runtime && runtime->await_is_error_) {
    // Raise the rejection as a Lua error (the message is on top of the stack).
    return lua_error(L);
  }
  // Return the resolved value (on top) as the awaited call's result.
  return 1;
}

AsyncStepResult LuaRuntime::ResumeAsyncStep(const LuaThreadRef& threadRef,
    const std::vector<LuaPtr>& args, bool arg_is_error) {
  AsyncStepResult result;

  if (!threadRef.thread) {
    result.state = AsyncStepResult::State::Error;
    result.error = "invalid coroutine thread";
    return result;
  }

  // Don't resume a coroutine that has already finished or errored; resuming a
  // dead thread corrupts it. (The binding state machine should never do this,
  // but the core API must not depend on its caller for validity.)
  const int thread_status = lua_status(threadRef.thread);
  if (thread_status != LUA_OK && thread_status != LUA_YIELD) {
    result.state = AsyncStepResult::State::Error;
    result.error = "cannot resume a dead coroutine";
    return result;
  }
  // A finished coroutine has status LUA_OK with an empty stack (exactly the
  // state this function leaves behind via lua_settop(co, 0)). Resuming it would
  // call below the stack base — reject it like ResumeCoroutine does.
  if (thread_status == LUA_OK && lua_gettop(threadRef.thread) == 0) {
    result.state = AsyncStepResult::State::Error;
    result.error = "cannot resume a finished coroutine";
    return result;
  }

  last_error_value_.reset();
  instruction_count_ = 0;  // fresh instruction budget for this resume step
  await_is_error_ = arg_is_error;

  if (!lua_checkstack(threadRef.thread, static_cast<int>(args.size()) + LUA_MINSTACK)) {
    result.state = AsyncStepResult::State::Error;
    result.error = "stack overflow: too many resume values";
    return result;
  }
  try {
    for (const auto& arg : args) {
      PushLuaValue(threadRef.thread, arg);
    }
  } catch (const std::exception& e) {
    result.state = AsyncStepResult::State::Error;
    result.error = std::string("Error converting resume value: ") + e.what();
    return result;
  }

  int nresults = 0;
  const int status = lua_resume(threadRef.thread, L_,
                                static_cast<int>(args.size()), &nresults);

  if (status == LUA_YIELD) {
    // Suspended to await a promise; discard any yielded values (we yield none).
    if (nresults > 0) lua_pop(threadRef.thread, nresults);
    result.state = AsyncStepResult::State::Awaiting;
  } else if (status == LUA_OK) {
    try {
      for (int i = 1; i <= nresults; ++i) {
        result.values.push_back(ToLuaValueProtected(threadRef.thread, i));
      }
    } catch (const std::exception& e) {
      result.values.clear();
      lua_settop(threadRef.thread, 0);
      result.state = AsyncStepResult::State::Error;
      result.error = e.what();
      return result;
    }
    lua_settop(threadRef.thread, 0);
    result.state = AsyncStepResult::State::Finished;
  } else {
    lua_State* co = threadRef.thread;
    // Append a traceback for string errors; structured JS-error tables pass
    // through and are captured as-is.
    if (lua_type(co, -1) == LUA_TSTRING) {
      const char* m = lua_tostring(co, -1);
      luaL_traceback(co, co, m, 1);
      lua_remove(co, -2);  // drop the original string, keep the traceback'd one
    }
    result.error = CaptureError(co);
    lua_settop(co, 0);
    result.state = AsyncStepResult::State::Error;
  }

  return result;
}

} // namespace lua_core
