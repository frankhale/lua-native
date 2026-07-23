#pragma once

#include <lua.hpp>
#include <atomic>
#include <exception>
#include <functional>
#include <mutex>
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

// A table key whose Lua type is carried explicitly, so a caller that knows the
// intended type (e.g. the JS `LuaTableHandle` methods, which see whether the
// argument was a JS number or string) can reach an integer key and a genuine
// string key with the same textual form independently — `t[123]` vs `t["123"]`.
// Contrast the plain std::string key overloads, which coerce a numeric-looking
// string to an integer key (used by the Proxy path, where JS property keys are
// always strings and `obj[1]` must address the array part).
using TableKey = std::variant<std::string, int64_t, double>;

namespace detail {
// Unrefs `ref` from mainL's registry, unless a worker thread is mid-run on that
// state — in which case it defers the unref to a queue drained after the worker
// finishes (H9c). Defined in lua-runtime.cpp, where LuaRuntime is complete; the
// runtime is resolved from mainL's extra space (set in InitState), so this reads
// no registry and takes no Lua lock. Always runs on the main (JS) thread at GC /
// value-destruction time.
void UnrefRegistrySlot(lua_State* mainL, int ref);

// Produces a shared owner whose deleter unrefs `ref` from the registry when the
// last copy is destroyed. Returns null for the no-op refs (LUA_NOREF/LUA_REFNIL)
// so those never touch the registry.
//
// The registry is shared by every thread of a global Lua state, so any thread
// can perform the unref — but the captured state must still be alive when the
// deleter runs. A value can be converted on a *coroutine thread* (e.g. a value
// yielded or errored out of a coroutine), and that thread may be garbage
// collected while a ref taken on it is still held by JS. Capturing it directly
// would leave the deleter dereferencing a freed lua_State. Resolve and capture
// the main thread instead: it stays valid until lua_close. Refs stored on the
// runtime itself must still be dropped before lua_close (see the destructor).
inline std::shared_ptr<void> MakeRegistryOwner(lua_State* L, int ref) {
  if (!L || ref == LUA_NOREF || ref == LUA_REFNIL) return nullptr;
  lua_rawgeti(L, LUA_REGISTRYINDEX, LUA_RIDX_MAINTHREAD);
  lua_State* mainL = lua_tothread(L, -1);
  lua_pop(L, 1);
  if (!mainL) mainL = L;  // defensive: LUA_RIDX_MAINTHREAD is always populated
  return {nullptr, [mainL, ref](void*) {
    UnrefRegistrySlot(mainL, ref);
  }};
}
}  // namespace detail

// Holds a reference to a Lua function in the registry.
//
// The registry slot is owned by a shared control block: copies share ownership
// and the slot is unref'd exactly once, when the last copy is destroyed. This
// makes the refs safe to copy freely (e.g. round-tripping through JS) without
// leaking slots or double-unref'ing. `release()` drops this copy's share early.
struct LuaFunctionRef {
  int ref;
  lua_State* L;

  LuaFunctionRef(int r, lua_State* state)
      : ref(r), L(state), owner_(detail::MakeRegistryOwner(state, r)) {}

  LuaFunctionRef(const LuaFunctionRef&) = default;
  LuaFunctionRef& operator=(const LuaFunctionRef&) = default;
  LuaFunctionRef(LuaFunctionRef&&) noexcept = default;
  LuaFunctionRef& operator=(LuaFunctionRef&&) noexcept = default;

  void release() {
    owner_.reset();  // unrefs iff this was the last owner
    ref = LUA_NOREF;
    L = nullptr;
  }

 private:
  std::shared_ptr<void> owner_;
};

// Holds a reference to a Lua coroutine thread in the registry. See LuaFunctionRef
// for the shared-ownership semantics.
struct LuaThreadRef {
  int ref;
  lua_State* L;        // Main state
  lua_State* thread;   // The coroutine thread

  LuaThreadRef(int r, lua_State* mainState, lua_State* threadState)
      : ref(r), L(mainState), thread(threadState),
        owner_(detail::MakeRegistryOwner(mainState, r)) {}

  LuaThreadRef(const LuaThreadRef&) = default;
  LuaThreadRef& operator=(const LuaThreadRef&) = default;
  LuaThreadRef(LuaThreadRef&&) noexcept = default;
  LuaThreadRef& operator=(LuaThreadRef&&) noexcept = default;

  void release() {
    owner_.reset();
    ref = LUA_NOREF;
    L = nullptr;
    thread = nullptr;
  }

 private:
  std::shared_ptr<void> owner_;
};

// Holds a reference to userdata.
// For JS-created userdata: ref_id maps to a JS object, registry_ref is LUA_NOREF.
// For Lua-created userdata (opaque passthrough): ref_id is -1, registry_ref holds
// the Lua registry reference (owned via the shared control block below).
struct LuaUserdataRef {
  int ref_id;           // JS object map key (-1 if opaque/Lua-created)
  int registry_ref;     // Lua registry ref (for opaque/Lua-created passthrough)
  lua_State* L;
  bool opaque;          // true = Lua-created userdata (can't inspect internals)
  bool proxy;           // true = property access enabled (__index/__newindex)
  std::string class_name;  // non-empty => instance bound to a registered class metatable

  LuaUserdataRef(int id, lua_State* state, bool is_opaque = false,
                 int reg_ref = LUA_NOREF, bool is_proxy = false,
                 std::string cls = "")
      : ref_id(id), registry_ref(reg_ref), L(state),
        opaque(is_opaque), proxy(is_proxy), class_name(std::move(cls)),
        // Only opaque (Lua-created) userdata owns a registry slot; JS-backed
        // userdata is tracked by ref_id and freed via the __gc ref-count path.
        owner_(is_opaque ? detail::MakeRegistryOwner(state, reg_ref) : nullptr) {}

  LuaUserdataRef(const LuaUserdataRef&) = default;
  LuaUserdataRef& operator=(const LuaUserdataRef&) = default;
  LuaUserdataRef(LuaUserdataRef&&) noexcept = default;
  LuaUserdataRef& operator=(LuaUserdataRef&&) noexcept = default;

  void release() {
    owner_.reset();
    registry_ref = LUA_NOREF;
    L = nullptr;
  }

 private:
  std::shared_ptr<void> owner_;
};

// Holds a reference to a Lua table in the registry (metatabled tables preserved
// as refs). See LuaFunctionRef for the shared-ownership semantics.
struct LuaTableRef {
  int ref;
  lua_State* L;

  LuaTableRef(int r, lua_State* state)
      : ref(r), L(state), owner_(detail::MakeRegistryOwner(state, r)) {}

  LuaTableRef(const LuaTableRef&) = default;
  LuaTableRef& operator=(const LuaTableRef&) = default;
  LuaTableRef(LuaTableRef&&) noexcept = default;
  LuaTableRef& operator=(LuaTableRef&&) noexcept = default;

  void release() {
    owner_.reset();
    ref = LUA_NOREF;
    L = nullptr;
  }

 private:
  std::shared_ptr<void> owner_;
};

struct MemoryAllocator {
  size_t current = 0;
  size_t limit = 0;  // 0 = unlimited
};

struct RuntimeConfig {
  std::vector<std::string> libraries;
  size_t max_memory = 0;        // 0 = unlimited
  size_t max_instructions = 0;  // 0 = unlimited (VM instructions per execution)
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

// Result of one step of the coroutine-driven async executor.
struct AsyncStepResult {
  enum class State { Finished, Awaiting, Error };
  State state = State::Error;  // fail-safe default: treated as an error unless set
  std::vector<LuaPtr> values;  // return values when Finished
  std::string error;           // message when Error
};

// Names a registered host function so PushLuaValue can materialize it as a Lua
// closure. Lets JS functions nested inside objects/arrays cross into Lua as real
// callables (not as their internal registry-name string).
struct HostFunctionName {
  std::string name;
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
      LuaTableRef,
      HostFunctionName>;
  Variant value;

  LuaValue() = default;
  explicit LuaValue(Variant v) : value(std::move(v)) {}

  // Convenience factory functions
  static LuaValue nil() { return LuaValue{Variant{std::monostate{}}}; }
  static LuaValue from(bool b) { return LuaValue{Variant{b}}; }
  static LuaValue from(int64_t i) { return LuaValue{Variant{i}}; }
  static LuaValue from(double d) { return LuaValue{Variant{d}}; }
  static LuaValue from(std::string s) { return LuaValue{Variant{std::move(s)}}; }
  static LuaValue from(LuaArray arr) { return LuaValue{Variant{std::move(arr)}}; }
  static LuaValue from(LuaTable tbl) { return LuaValue{Variant{std::move(tbl)}}; }
  static LuaValue from(LuaFunctionRef&& ref) { return LuaValue{Variant{std::move(ref)}}; }
  static LuaValue from(LuaThreadRef&& ref) { return LuaValue{Variant{std::move(ref)}}; }
  static LuaValue from(LuaUserdataRef&& ref) { return LuaValue{Variant{std::move(ref)}}; }
  static LuaValue from(LuaTableRef&& ref) { return LuaValue{Variant{std::move(ref)}}; }
  static LuaValue from(HostFunctionName fn) { return LuaValue{Variant{std::move(fn)}}; }
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
  explicit LuaRuntime(const RuntimeConfig& config);
  ~LuaRuntime();

  static std::vector<std::string> AllLibraries();
  static std::vector<std::string> SafeLibraries();

  // The configuration this runtime was constructed from, kept verbatim so a
  // caller can build an identically-configured replacement state — the way the
  // binding layer implements reset(). max_instructions tracks
  // SetMaxInstructions; the remaining fields are fixed at construction.
  [[nodiscard]] const RuntimeConfig& GetConfig() const { return config_; }

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

  // Dotted-path variants of the two above. `path` addresses a nested field
  // (e.g. {"config","db","host"} for config.db.host), traversing through
  // __index/__newindex like real Lua field access. `path` must be non-empty.
  //
  // SetGlobalPath auto-creates missing intermediate tables and throws if an
  // existing intermediate is a non-table value. GetGlobalPath returns nil if
  // any intermediate is nil (optional-chaining semantics) and throws if an
  // intermediate is a non-nil, non-indexable value.
  void SetGlobalPath(const std::vector<std::string>& path, const LuaPtr& value) const;
  [[nodiscard]] LuaPtr GetGlobalPath(const std::vector<std::string>& path) const;

  [[nodiscard]] ScriptResult CallFunction(const LuaFunctionRef& funcRef,
                                          const std::vector<LuaPtr>& args) const;

  // Coroutine support
  [[nodiscard]] std::variant<LuaThreadRef, std::string> CreateCoroutine(const LuaFunctionRef& funcRef) const;
  [[nodiscard]] CoroutineResult ResumeCoroutine(const LuaThreadRef& threadRef,
                                                 const std::vector<LuaPtr>& args) const;
  [[nodiscard]] static CoroutineStatus GetCoroutineStatus(const LuaThreadRef& threadRef);

  // Coroutine-driven async execution (main thread; awaits JS promises).
  // Loads `script` as a chunk on a fresh coroutine thread.
  [[nodiscard]] std::variant<LuaThreadRef, std::string> CreateCoroutineFromScript(
      const std::string& script) const;
  // Resumes the async coroutine one step. `args` are the values to resume with
  // (the resolved promise value, or the rejection message when arg_is_error).
  [[nodiscard]] AsyncStepResult ResumeAsyncStep(const LuaThreadRef& threadRef,
      const std::vector<LuaPtr>& args, bool arg_is_error);
  void SetAwaitDriverMode(bool enabled);
  [[nodiscard]] bool IsAwaitDriverMode() const;
  // Records (or clears, with nullptr) the coroutine thread execute_async drives,
  // so the host-call bridge can tell a top-level await from one attempted inside
  // a user coroutine (M1).
  void SetAwaitDriverThread(lua_State* thread);
  void RequestAwaitYield();
  void RequestCancel();
  [[nodiscard]] bool IsCancelRequested() const;
  void ClearCancel();

  // Userdata support
  void SetUserdataGCCallback(UserdataGCCallback cb);
  void SetPropertyHandlers(PropertyGetter getter, PropertySetter setter);

  void SetAsyncMode(bool enabled);
  bool IsAsyncMode() const;

  // Worker-thread registry-unref deferral (H9c). A worker (execute_script_async
  // / execute_file_async) runs Lua off-thread; a GC finalizer freeing a registry
  // slot on the main thread meanwhile would mutate the registry concurrently.
  // Begin/End bracket the worker run; between them, main-thread unrefs are queued
  // and drained (on the main state) by End. UnrefOrDefer is the queue-or-unref
  // entry point the registry-owner deleter routes through.
  void BeginWorkerUnrefDeferral();
  void EndWorkerUnrefDeferral();
  void UnrefOrDefer(int ref);
  // Metatable support
  void StoreHostFunction(const std::string& name, Function fn);
  // Drops a host function stored via StoreHostFunction. Used to roll back a
  // partially-registered binding operation whose later step failed (e.g. an
  // OOM building a userdata method table) so a rejected call strands nothing.
  // Only removes the C++ entry; the caller is responsible for any Lua-side
  // reference (there is none for a build that failed before installing it).
  void RemoveHostFunction(const std::string& name);
  // Like StoreHostFunction, but the registry entry (and the binding's paired JS
  // reference, via the host-function GC callback) is reclaimed once every Lua
  // closure materialized from this name is garbage-collected. Used for the
  // anonymous JS callbacks nested inside values crossing JS→Lua, which would
  // otherwise accumulate for the life of the context (M2).
  void RegisterReclaimableHostFunction(const std::string& name, Function fn);
  // Erases a reclaimable entry that was registered but never materialized as a
  // closure (live count still 0), so a conversion discarded before its value
  // was pushed doesn't strand the entry for the context's lifetime (N4).
  // Returns true if erased (the binding should drop its paired JS reference).
  // Safe on pushed names: a non-zero count (or missing entry) is untouched.
  bool EraseReclaimableIfUnpushed(const std::string& name);
  // Invoked when a reclaimable host function's last live closure is collected,
  // so the binding layer can drop its paired js_callbacks_ reference. Runs on
  // the thread the GC fires on; skipped during worker-thread async (off-thread
  // N-API is illegal), same as the userdata GC callback.
  using HostFunctionGCCallback = std::function<void(const std::string&)>;
  void SetHostFunctionGCCallback(HostFunctionGCCallback cb);
  void SetGlobalMetatable(const std::string& name, const std::vector<MetatableEntry>& entries);

  // Error fidelity: a host wrapper stages a structured error value (a plain
  // Lua table describing the JS error) that LuaCallHostFunction raises instead
  // of a string. The last captured error value is exposed so the binding layer
  // can reconstruct the original JS Error on the way out.
  void SetPendingErrorValue(LuaPtr value) { pending_error_value_ = std::move(value); }
  [[nodiscard]] bool HasPendingErrorValue() const { return static_cast<bool>(pending_error_value_); }
  LuaPtr TakePendingErrorValue() { return std::move(pending_error_value_); }
  LuaPtr TakeLastErrorValue() { return std::move(last_error_value_); }

  // Module / require support
  void AddSearchPath(const std::string& path) const;
  void RegisterModuleTable(const std::string& name, const std::vector<MetatableEntry>& entries) const;

  // Output redirection (E1): route print()/io.write() to a JS handler.
  using OutputHandler = std::function<void(const std::string&)>;
  void SetOutputHandler(OutputHandler handler);

  // Bytecode / untrusted-chunk guard (E3): when disabled, load_bytecode() is
  // rejected and Lua's load() is forced to text-only mode (binary chunks fail).
  void SetAllowBytecode(bool allow);

  // Dynamic require (E2): append a package.searchers entry that resolves an
  // unknown module by calling the named host function (returning Lua source).
  void AddJsSearcher(const std::string& host_func_name);

  void CreateUserdataGlobal(const std::string& name, int ref_id);
  void CreateProxyUserdataGlobal(const std::string& name, int ref_id);
  // Raw removal of _G[name] (rawset, so no __newindex fires — a hostile _G
  // metatable can't re-raise during a rollback). Used to undo a userdata global
  // whose later build step failed, so a rejected set_userdata doesn't leave the
  // name bound to an inert proxy (CR-7 F3). Runs inside RunProtected because
  // the key push can itself fail under an exhausted maxMemory; that surfaces as
  // a throw the caller may treat as best-effort.
  void RemoveGlobalRaw(const std::string& name) const;
  void IncrementUserdataRefCount(int ref_id);
  void DecrementUserdataRefCount(int ref_id);

  /// Register a method table for a userdata ref_id.
  /// method_map: maps Lua-facing method name -> host function name
  void SetUserdataMethodTable(int ref_id,
      const std::unordered_map<std::string, std::string>& method_map);

  /// Register a class/usertype. Creates a global table `class_name` with a
  /// `new` function that invokes the constructor host function, plus a shared
  /// per-class instance metatable (methods, property access, metamethods).
  /// constructor_func_name: host function that builds+registers an instance and
  ///   returns a class-bound LuaUserdataRef.
  /// method_map: instance method name -> host function name (obj:method()).
  /// metamethods: operator/metamethod entries (all is_function == true).
  void RegisterClass(const std::string& class_name,
      const std::string& constructor_func_name,
      const std::unordered_map<std::string, std::string>& method_map,
      const std::vector<MetatableEntry>& metamethods);

  // Table reference operations (for metatabled tables preserved as refs).
  // The plain-string variants coerce a numeric-looking key to an integer key
  // (Proxy path, where JS property keys are always strings); the *Keyed variants
  // honor the caller's explicit key type so a genuine string key like "123" is
  // distinct from integer key 123.
  [[nodiscard]] LuaPtr GetTableField(int registry_ref, const std::string& key) const;
  void SetTableField(int registry_ref, const std::string& key, const LuaPtr& value) const;
  [[nodiscard]] bool HasTableField(int registry_ref, const std::string& key) const;
  [[nodiscard]] LuaPtr GetTableFieldKeyed(int registry_ref, const TableKey& key) const;
  void SetTableFieldKeyed(int registry_ref, const TableKey& key, const LuaPtr& value) const;
  [[nodiscard]] bool HasTableFieldKeyed(int registry_ref, const TableKey& key) const;
  [[nodiscard]] std::vector<std::string> GetTableKeys(int registry_ref) const;
  [[nodiscard]] int64_t GetTableLength(int registry_ref) const;

  // Table reference API — create and manage live table references
  [[nodiscard]] int CreateTable();
  [[nodiscard]] int CreateTableFrom(const LuaTable& initial);
  [[nodiscard]] int CreateTableFrom(const LuaArray& initial) const;
  [[nodiscard]] std::variant<int, std::string> GetGlobalRef(const std::string& name) const;
  [[nodiscard]] std::vector<std::pair<LuaPtr, LuaPtr>> TablePairs(int registry_ref) const;
  [[nodiscard]] std::vector<std::pair<int64_t, LuaPtr>> TableIPairs(int registry_ref) const;
  void ReleaseTableRef(int registry_ref);

  [[nodiscard]] size_t GetMemoryUsage() const { return allocator_.current; }
  [[nodiscard]] size_t GetMemoryLimit() const { return allocator_.limit; }

  // Execution time limits: cap the number of VM instructions a single execution
  // (execute_script/file, a Lua function call, or one coroutine resume) may run
  // before it is aborted with "instruction limit exceeded". 0 = unlimited. The
  // count-hook that enforces this also honors a pending cancel() request, so a
  // compute-bound loop can be interrupted cooperatively. Best set at
  // construction; a post-construction change applies to threads created after.
  void SetMaxInstructions(size_t limit);
  [[nodiscard]] size_t GetMaxInstructions() const { return max_instructions_; }

  [[nodiscard]] lua_State* RawState() const { return L_; }

  static LuaPtr ToLuaValue(lua_State* L, int index, int depth = 0);
  static void PushLuaValue(lua_State* L, const LuaPtr& value, int depth = 0);

  void StoreFunctionData(void* data, void (*destructor)(void*)) {
    stored_function_data_.emplace_back(data, destructor);
  }

  static constexpr int kMaxDepth = 100;
  static constexpr const char* kUserdataMetaName = "lua_native_userdata";
  static constexpr const char* kProxyUserdataMetaName = "lua_native_proxy_userdata";
  static constexpr const char* kHostFnSentinelMeta = "lua_native_hostfn_sentinel";

  // Registry keys / markers shared between the core and binding layers.
  static constexpr const char* kRuntimeRegistryKey = "_lua_core_runtime";
  static constexpr const char* kUserdataMethodsPrefix = "_ud_methods_";
  static constexpr const char* kClassMetaPrefix = "_class_mt_";
  static constexpr const char* kClassMethodsPrefix = "_class_methods_";
  static constexpr const char* kClassMarkerField = "__lua_native_class";
  static constexpr const char* kJsErrorIdField = "__jsErrorId";

private:
  // allocator_ must be declared before L_ so it outlives the Lua state
  // (C++ destroys members in reverse declaration order, and lua_close calls the allocator).
  // The destructor also runs an explicit teardown sequence — reset the
  // registry-backed error values, run stored_function_data_ destructors, then
  // lua_close — because lua_close fires __gc metamethods that can call back into
  // host_functions_ and read these members while the state is still open.
  MemoryAllocator allocator_;
  lua_State* L_ { nullptr };
  RuntimeConfig config_;  // see GetConfig()
  std::unordered_map<std::string, Function> host_functions_;
  std::vector<std::pair<void*, void (*)(void*)>> stored_function_data_;

  // Userdata support
  UserdataGCCallback userdata_gc_callback_;
  std::unordered_map<int, int> userdata_ref_counts_;
  PropertyGetter property_getter_;
  PropertySetter property_setter_;

  // Reclaimable host functions (M2). reclaimable_host_fns_ maps a name to the
  // number of live Lua closures materialized from it; each closure carries a
  // sentinel userdata whose __gc decrements the count and, at zero, drops the
  // host_functions_ entry and notifies the binding via host_fn_gc_callback_.
  std::unordered_map<std::string, int> reclaimable_host_fns_;
  HostFunctionGCCallback host_fn_gc_callback_;
  // True only while a worker thread (execute_script_async / execute_file_async)
  // owns the Lua state. Read from the main thread (e.g. binding-layer guards) to
  // reject concurrent access, so it must be atomic. Note: the main-thread
  // coroutine driver (execute_async) uses await_driver_mode_, not this flag.
  std::atomic<bool> async_mode_{false};

  // H9c: guards the registry-unref deferral queue. worker_active_ is true only
  // between BeginWorkerUnrefDeferral / EndWorkerUnrefDeferral (a worker run).
  // Every registry unref (finalizer path and the End drain) and every flag flip
  // happens under this mutex, so no two luaL_unref calls — and no unref and the
  // worker's own registry mutation — race. Accessed from the main thread
  // (finalizers) and the worker thread (Begin/End).
  std::mutex deferred_unref_mutex_;
  bool worker_active_ = false;
  std::vector<int> deferred_unrefs_;

  // Error fidelity state (mutable: set while capturing errors in const methods)
  mutable LuaPtr last_error_value_;     // structured value of the last error
  LuaPtr pending_error_value_;          // staged by a host wrapper to be raised

  // I/O and chunk-loading control
  OutputHandler output_handler_;        // print()/io.write() sink (null = stdout)
  bool allow_bytecode_ = true;          // false = reject binary chunks

  // Coroutine-driven async (main-thread promise awaiting) state
  bool await_driver_mode_ = false;  // true while execute_async is driving
  bool await_pending_ = false;      // set by a host call that returned a promise
  bool await_is_error_ = false;     // next resume delivers a rejection to raise
  // The specific coroutine thread execute_async drives. A host call that returns
  // a Promise may only suspend when it runs on THIS thread; awaiting from inside
  // a user-created coroutine would yield the wrong state, so the bridge raises
  // instead (M1). nullptr when not driving.
  lua_State* await_driver_thread_ = nullptr;
  // execute_async was cancelled; also polled by the instruction count-hook so a
  // compute-bound loop can be aborted. Atomic because a worker-thread run reads
  // it (in the hook) while the JS thread may set it via cancel().
  std::atomic<bool> cancel_requested_{false};

  // Execution time limits (see SetMaxInstructions). instruction_count_ tallies
  // the VM instructions run in the current execution and resets at each entry
  // point; the hook increments it by instruction_hook_interval_ each time it
  // fires (LUA_MASKCOUNT granularity) and raises once max_instructions_ is hit.
  size_t max_instructions_ = 0;             // 0 = unlimited
  mutable size_t instruction_count_ = 0;    // instructions run this execution
  int instruction_hook_interval_ = 1000;    // count-hook firing granularity

  void InitState();
  // Installs or removes the count-hook on L_ to reflect max_instructions_.
  // Newly created coroutine threads inherit the hook from L_ (lua_newthread
  // copies the parent's hook), so a single install covers all threads.
  void InstallExecutionHook();
  static void InstructionCountHook(lua_State* L, lua_Debug* ar);
  static int LibraryMask(const std::vector<std::string>& libraries);
  bool HasPackageLibrary() const;
  static void* LuaAllocator(void* ud, void* ptr, size_t osize, size_t nsize);

  void RegisterUserdataMetatable();
  void RegisterProxyUserdataMetatable();
  void RegisterHostFnSentinelMetatable();

  // Reclaims a reclaimable host function's entries once its last closure dies.
  void OnHostFnClosureCollected(const std::string& name);
  static int HostFnSentinelGC(lua_State* L);

  static int LuaCallHostFunction(lua_State* L);
  static int UserdataGC(lua_State* L);
  static int UserdataIndex(lua_State* L);
  static int UserdataNewIndex(lua_State* L);
  static int UserdataMethodCall(lua_State* L);
  static int ClassIndex(lua_State* L);
  static int AsyncContinuation(lua_State* L, int status, lua_KContext ctx);

  // Error handling: message handler that appends a Lua traceback (leaving
  // structured JS-error tables untouched), a protected-call helper that installs
  // it, and a capture helper that records the structured error value + a display
  // string.
  static int MessageHandler(lua_State* L);
  int ProtectedCall(int nargs, int nresults) const;
  std::string CaptureError(lua_State* L) const;

  // Runs a pre-pushed C trampoline (function + nargs already on the stack) under
  // lua_pcall so a raising metamethod becomes a std::runtime_error rather than a
  // panic/abort. Used by the table-reference operations, whose refs preserve
  // metatables and can therefore trigger __index/__newindex/__len.
  void ProtectedTableCall(int nargs, int nresults) const;

  // Runs `op` inside a lua_pcall frame so a Lua memory error (LUA_ERRMEM under
  // maxMemory) — or a metamethod raise — becomes a caught std::runtime_error
  // instead of an unprotected panic/abort (M5). `op` may perform Lua allocations
  // and may throw a C++ exception (captured and rethrown after the frame
  // unwinds). It must be self-contained on the Lua stack: a pcall frame can't see
  // the caller's stack slots, so any value `op` needs must be created inside it.
  // The light C-function trampoline is pushed without allocating, so the setup
  // itself can never OOM.
  void RunProtected(const std::function<void()>& op) const;
  // The operation + captured C++ exception for the active RunProtected call.
  struct ProtectedThunk {
    const std::function<void()>* op;
    std::exception_ptr error;
  };
  mutable ProtectedThunk* active_thunk_ = nullptr;
  static int ProtectedThunkRunner(lua_State* L);

  // Converts the value at `index` on `from` inside a lua_pcall frame, so the
  // luaL_ref / table allocations ToLuaValue performs when it materializes a
  // function, thread, userdata or metatabled-table *result* can't raise
  // LUA_ERRMEM (exhausted maxMemory) outside any protected frame — the CR-2 M5
  // documented residual, pinned to a concrete instance by CR-7. Scalars allocate
  // nothing and are converted directly, so the pcall is off the common path.
  // The frame always runs on the main state (a suspended coroutine can't be
  // called into); a value living on another thread is copied across first, which
  // is equivalent because the registry the refs land in is shared.
  LuaPtr ToLuaValueProtected(lua_State* from, int index) const;
  // The result + captured C++ exception for the active ToLuaValueProtected call.
  struct ProtectedConvert {
    LuaPtr result;
    std::exception_ptr error;
  };
  mutable ProtectedConvert* active_convert_ = nullptr;
  static int ProtectedConvertRunner(lua_State* L);

  // Pushes a value onto `L` inside its own lua_pcall frame (CR-8 F6). The
  // host-call bridges (LuaCallHostFunction, UserdataMethodCall, UserdataIndex,
  // ClassIndex) run inside the caller's pcall, but an LUA_ERRMEM raised by
  // PushLuaValue's allocations would longjmp straight to that pcall, skipping
  // the destructors of the bridge's live C++ locals — the args vector, the
  // result holder, and any registry slots they own. This turns the raise into
  // a status code: returns LUA_OK with the pushed value on top, or the pcall
  // error status with the error message on top (Lua's preallocated
  // memory-error string for ERRMEM), so control returns normally and the
  // bridge's locals are destroyed before it re-raises via lua_error. A C++
  // exception from the conversion (depth/stack limits) is rethrown in normal
  // control flow. Static, and the descriptor travels as a light-userdata
  // argument (pushing one never allocates), so it works on whichever thread
  // the bridge was invoked on without a registry read.
  struct ProtectedPush {
    const LuaPtr* value;
    std::exception_ptr error;
  };
  static int PushLuaValueProtected(lua_State* L, const LuaPtr& value);
  static int ProtectedPushRunner(lua_State* L);

  // Reads _G[name] inside a lua_pcall frame — so both an __index metamethod
  // installed via setmetatable(_G, ...) (M4) and the allocation of the key
  // string (M5) surface as a std::runtime_error instead of an unprotected panic
  // — and leaves the resulting value on top of the stack. The name is handed to
  // the trampoline out-of-band via `active_global_name_` rather than pushed as
  // an argument, because pushing it is itself the allocation being protected.
  void PushProtectedGlobal(const std::string& name) const;
  mutable const std::string* active_global_name_ = nullptr;
  static int ProtectedGlobalGetRunner(lua_State* L);

  // I/O redirection and chunk-loading guards
  void InstallOutputRedirection();
  static int LuaPrint(lua_State* L);
  static int LuaIoWrite(lua_State* L);
  static int SafeLoad(lua_State* L);
  static int JsSearcher(lua_State* L);
};

} // namespace lua_core
