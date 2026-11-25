// The WASM binding: `LuaContext` over `lua_core::LuaRuntime`, written against
// `emscripten::val`. The browser target's counterpart of `src/lua-native.h`,
// with no N-API, real or emulated (`docs/reviews/WASM-TARGET-PLAN.md` D1, D2).
//
// **This is a port, not a design.** Each member below mirrors the member of
// the same name in the native binding — the same checks in the same order with
// the same message text — and the reasoning for each lives beside the
// original, not here. Where this file says "native:" it names what to read.
// What differs is only what has to:
//
//   Napi::Value / Napi::Reference   ->  emscripten::val (a refcounted handle)
//   Napi::Error (thrown C++)        ->  js::JsError
//   ThrowAsJavaScriptException()    ->  js::Throw*, a pending exception the
//                                       entry wrapper hands to the shell
//   Napi::CallbackInfo              ->  Args (the shell passes `arguments`)
//
// Written in seven slices (plan, Phase 2), **all of which are here**:
// `init` and its options, `execute_script`, values in both directions under
// every conversion mode, errors in both directions, `set_global`,
// `get_global`, `call`, `pcall`, a Lua function crossing to JS as a callable,
// tables by reference — the handle, the `Proxy` a metatabled table becomes,
// `create_table`, `get_global_ref`, `create_environment` and
// `execute_script_in` — and, from slice 4, userdata (`set_userdata`, the
// property bridge, a Lua-created userdata's handle), `set_metatable`,
// `register_class` and the two converter registries; and, from slice 5,
// coroutines (`create_coroutine`, `resume`, `close`, both iterators), the
// coroutine-driven async doors (`execute_async`, `call_async`, `resume_async`,
// `cancel`, `is_busy`), `execute_file`, and the two doors that natively run on
// a worker thread and here run on the calling one (plan, D3); and, from slice
// 6, bytecode (`compile`, `compile_file`, `load_bytecode`), modules
// (`register_module`, `add_search_path`, `add_searcher`), the print, read and
// file handlers, and the debug hook with `get_stack` and `get_locals`; and,
// from slice 7, `release`, `dispose`, `reset` and what it replays, `gc`,
// `get_memory_usage`, `info` with `bindingRefs`, and the `shared` option.

#pragma once

#include <emscripten/val.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "core/lua-runtime.h"
#include "js.h"

namespace lua_wasm {

using emscripten::val;

// Native: lua_occupancy in lua-native.h. Who currently owns the Lua state, as
// a set, so each entry point can say which owners it cannot share with.
namespace lua_occupancy {
enum class Claim : unsigned {
  None = 0,
  AsyncInFlight = 1U << 0,
  LuaExecuting = 1U << 1,
  BindingCall = 1U << 2,
  Resetting = 1U << 3,
};

constexpr Claim operator|(const Claim a, const Claim b) {
  return static_cast<Claim>(static_cast<unsigned>(a) | static_cast<unsigned>(b));
}
constexpr Claim operator&(const Claim a, const Claim b) {
  return static_cast<Claim>(static_cast<unsigned>(a) & static_cast<unsigned>(b));
}
constexpr bool Any(const Claim c) { return static_cast<unsigned>(c) != 0; }

inline constexpr Claim kSyncApi = Claim::AsyncInFlight;
inline constexpr Claim kExclusive =
    Claim::AsyncInFlight | Claim::LuaExecuting | Claim::BindingCall;
inline constexpr Claim kRetireState = kExclusive | Claim::Resetting;
}  // namespace lua_occupancy

// Native: ContextInitOptions.
struct ContextInitOptions {
  // 64 bits, as the core holds them. The native struct says `size_t`, which is
  // the same width there and half of it here.
  std::uint64_t max_memory = 0;
  std::uint64_t max_instructions = 0;
  std::uint64_t timeout_ms = 0;
  bool has_max_memory = false;
  bool has_max_instructions = false;
  bool has_timeout = false;
  std::vector<std::string> libraries;
  bool has_libraries = false;
  bool seal_base_filesystem = false;
  bool sandbox_preset = false;
  bool strict_conversion = false;
};

// Native: ContextLiveness. The liveness facts a handle needs, carried together.
// `handles` is flipped by reset() and by destruction, `context` only by
// destruction, `closed` only by close(); DeadReason() is the one place that
// turns them into words.
struct ContextLiveness {
  std::shared_ptr<std::atomic<bool>> handles;
  std::shared_ptr<std::atomic<bool>> context;
  std::shared_ptr<std::atomic<bool>> closed;

  [[nodiscard]] bool HandlesLive() const { return handles && handles->load(); }
  [[nodiscard]] bool ContextObjectLive() const { return context && context->load(); }
  [[nodiscard]] bool Closed() const { return closed && closed->load(); }
  [[nodiscard]] const char* DeadReason() const {
    if (Closed()) return "its Lua context has been closed";
    return ContextObjectLive()
      ? "its Lua state was replaced by reset(); acquire a new handle"
      : "its Lua context has been destroyed";
  }
};

class LuaContext;

// Native: LuaFunctionData. What a Lua function handed to JS calls through: the
// registry ref, the runtime that keeps that registry alive, and the context —
// an independent GC root that can go first, hence the liveness flags.
//
// Natively this sits behind a tagged External whose finalizer deletes it. Here
// it is an Embind class the shell holds: the shell's `FinalizationRegistry`
// calls `delete()` on the handle when the JS function is collected, and the
// brand is the shell's map from the function's hidden owner object to it.
struct LuaFunctionData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaFunctionRef func_ref;
  LuaContext* context;
  ContextLiveness liveness;

  LuaFunctionData(std::shared_ptr<lua_core::LuaRuntime> rt, lua_core::LuaFunctionRef ref,
                  LuaContext* ctx, ContextLiveness live)
      : runtime(std::move(rt)), func_ref(std::move(ref)), context(ctx), liveness(std::move(live)) {}

  ~LuaFunctionData() { func_ref.release(); }
  // Owned by exactly one shell handle; a copy would release the same share.
  LuaFunctionData(const LuaFunctionData&) = delete;
  LuaFunctionData& operator=(const LuaFunctionData&) = delete;
  LuaFunctionData(LuaFunctionData&&) = delete;
  LuaFunctionData& operator=(LuaFunctionData&&) = delete;

  // True while this handle's Lua state is still the context's current one.
  [[nodiscard]] bool ContextLive() const { return liveness.HandlesLive(); }
};

// Native: LuaTableRefData. What a table handle's methods and a metatabled
// table's Proxy traps call through. Held by the shell the way LuaFunctionData
// is; its brand is the `_tableRef` owner object.
struct LuaTableRefData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaTableRef table_ref;
  LuaContext* context;
  ContextLiveness liveness;

  LuaTableRefData(std::shared_ptr<lua_core::LuaRuntime> rt, lua_core::LuaTableRef ref,
                  LuaContext* ctx, ContextLiveness live)
      : runtime(std::move(rt)), table_ref(std::move(ref)), context(ctx), liveness(std::move(live)) {}

  ~LuaTableRefData() { table_ref.release(); }
  // Owned by exactly one shell handle; a copy would release the same share.
  LuaTableRefData(const LuaTableRefData&) = delete;
  LuaTableRefData& operator=(const LuaTableRefData&) = delete;
  LuaTableRefData(LuaTableRefData&&) = delete;
  LuaTableRefData& operator=(LuaTableRefData&&) = delete;

  // True while this handle's Lua state is still the context's current one.
  [[nodiscard]] bool ContextLive() const { return liveness.HandlesLive(); }
};

// Native: LuaUserdataData. What the handle for a userdata *Lua* created holds:
// the registry ref and the runtime that keeps that registry alive. It has no
// methods — the handle only round-trips — so it carries no context.
struct LuaUserdataData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaUserdataRef userdata_ref;

  LuaUserdataData(std::shared_ptr<lua_core::LuaRuntime> rt, lua_core::LuaUserdataRef ref)
      : runtime(std::move(rt)), userdata_ref(std::move(ref)) {}

  ~LuaUserdataData() { userdata_ref.release(); }
  // Owned by exactly one shell handle; a copy would release the same share.
  LuaUserdataData(const LuaUserdataData&) = delete;
  LuaUserdataData& operator=(const LuaUserdataData&) = delete;
  LuaUserdataData(LuaUserdataData&&) = delete;
  LuaUserdataData& operator=(LuaUserdataData&&) = delete;
};

// Native: LuaThreadData. What a coroutine object's `_coroutine` marker stands
// for: the thread's registry ref and the runtime that keeps it alive.
struct LuaThreadData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaThreadRef thread_ref;

  LuaThreadData(std::shared_ptr<lua_core::LuaRuntime> rt, lua_core::LuaThreadRef ref)
      : runtime(std::move(rt)), thread_ref(std::move(ref)) {}

  ~LuaThreadData() { thread_ref.release(); }
  // Owned by exactly one shell handle; a copy would release the same share.
  LuaThreadData(const LuaThreadData&) = delete;
  LuaThreadData& operator=(const LuaThreadData&) = delete;
  LuaThreadData(LuaThreadData&&) = delete;
  LuaThreadData& operator=(LuaThreadData&&) = delete;
};

// Native: LuaContextBinding. The context half of a function that is not tied
// to one Lua reference — a coroutine object's two iterator factories.
struct LuaContextBinding {
  LuaContext* context{};
  ContextLiveness liveness;

  [[nodiscard]] bool ContextLive() const {
    return context != nullptr && liveness.HandlesLive();
  }
};

// Native: LuaCoroIterState. One iteration cursor over a coroutine; each
// `[Symbol.iterator]()` mints a fresh one over the one shared Lua thread. The
// coroutine object is held strongly: nothing on it points back here.
//
// The native struct also carries a weak pointer to itself, so that its async
// `next` can mint one more root for the function that maps the settled step.
// Here the shell does that rooting and hands `next` the owner to do it with.
struct LuaCoroIterState {
  LuaContext* context = nullptr;
  ContextLiveness liveness;
  val coro;
  bool done = false;

  [[nodiscard]] bool ContextLive() const {
    return context != nullptr && liveness.HandlesLive();
  }
};

// Native: AwaitCookie. What the two continuations attached to an awaited
// Promise carry: the context, the generation of the run that attached them,
// and the context's liveness flag, which is read before the context is.
struct AwaitCookie {
  LuaContext* ctx;
  uint64_t gen;
  bool settled;
  std::shared_ptr<std::atomic<bool>> alive;
};

// Native: Napi::Promise::Deferred. A promise and its two settling functions,
// minted by the shell from the intrinsic constructor. Neither settling
// function can throw, so neither is guarded.
class Deferred {
 public:
  static Deferred New();
  [[nodiscard]] val Promise() const { return record_["promise"]; }
  void Resolve(const val& value) const { record_["resolve"](value); }
  void Reject(const val& value) const { record_["reject"](value); }
  // The `{ promise, resolve, reject }` record itself, for the shell.
  [[nodiscard]] const val& Record() const { return record_; }

 private:
  explicit Deferred(val record) : record_(std::move(record)) {}
  val record_;
};

// Native: LuaScriptAsyncWorker and LuaFileAsyncWorker, as one struct. Natively
// each is a libuv work item whose `Execute` runs the script on a worker thread
// and whose `OnOK`/`OnError` settle the promise back on the main one. Here
// there is one thread: the shell takes the run up in a later task and both
// halves happen there, back to back (plan, D3).
struct LuaWorkerRun {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  bool is_file;
  std::string source;  // the script, or the file's path
  std::string chunk_name;
  LuaContext* context;
  // Keeps the context alive until the run has settled, as the worker's
  // persistent reference to the wrapping object does.
  val context_ref;
  Deferred deferred;

  // **No native counterpart.** What Execute leaves for the completion, and, for
  // a run that can be suspended, the stack it has to itself (src/wasm/suspend.h).
  bool suspendable = false;
  std::unique_ptr<char[]> stack;
  lua_core::ScriptResult result;
  std::optional<std::string> failure;
};

// Native: UserdataEntry. A JS object standing behind a Lua userdata.
struct UserdataEntry {
  val object;
  bool readable = false;
  bool writable = false;
  // Empty for set_userdata instances; the class name for register_class ones.
  std::string class_name;
};

// Native: ClassAccessor. One named property accessor from `register_class`;
// either half may be absent, and an absent half refuses that direction.
struct ClassAccessor {
  std::optional<val> getter;
  std::optional<val> setter;
};

// Native: ClassAccessorTable. One class's accessors plus its base-class link.
struct ClassAccessorTable {
  std::string parent;  // empty when the class has no base
  std::unordered_map<std::string, ClassAccessor> props;
};

// Native: LuaTableIterState. One iteration cursor over a table handle: the
// keys are snapshotted when it is made and each `next()` is an independent raw
// read, so nothing is held open across a return into JavaScript.
//
// `data` is not owned. Natively it is kept alive by `handle`, the object the
// iterator method was called on — which is the handle only when the method is
// called *as* a method. Here the shell roots the table's owner on the cursor
// itself, so it is alive for as long as `next` can be called whatever `this`
// was; `handle` is kept as well because the native cursor keeps it.
struct LuaTableIterState {
  const LuaTableRefData* data = nullptr;
  ContextLiveness liveness;
  val handle;
  std::vector<lua_core::LuaPtr> keys;
  size_t index = 0;
  [[nodiscard]] bool ContextLive() const { return liveness.HandlesLive(); }
};

// The arguments of one call, as the shell passed them. `info.Length()` and
// `info[i]` of Napi::CallbackInfo: an index past the end reads as undefined.
struct Args {
  val list;
  uint32_t length;

  explicit Args(val arguments);
  [[nodiscard]] uint32_t Length() const { return length; }
  [[nodiscard]] val operator[](uint32_t index) const;
};

class LuaContext final {
 public:
  // The shell's `new init(callbacks, options)`: `call` is `{ args, state }`,
  // the constructor's arguments and the shell's record for the new context.
  // Returns null with a JS exception pending when construction fails; never
  // throws.
  static LuaContext* Create(const val& call);

  // Where the shell reads how many entry points have begun; see EntriesBegun.
  static double EntryCounterAddress();

  ~LuaContext();
  LuaContext(const LuaContext&) = delete;
  LuaContext& operator=(const LuaContext&) = delete;
  LuaContext(LuaContext&&) = delete;
  LuaContext& operator=(LuaContext&&) = delete;

  // --- entry points: each takes the call's `arguments` ----------------------
  val ExecuteScript(const Args& info);
  val SetGlobal(const Args& info);
  val GetGlobal(const Args& info);
  val Call(const Args& info);
  val Pcall(const Args& info);

  val CreateTableMethod(const Args& info);
  val GetGlobalRef(const Args& info);
  val CreateEnvironment(const Args& info);
  val ExecuteScriptIn(const Args& info);

  val SetUserdata(const Args& info);
  val SetMetatable(const Args& info);
  val RegisterClass(const Args& info);
  val RegisterTypeConverter(const Args& info);
  val RegisterFromLuaConverter(const Args& info);

  val ExecuteFile(const Args& info);
  val CreateCoroutine(const Args& info);
  val ResumeCoroutine(const Args& info);
  val CloseCoroutine(const Args& info);
  val ResumeAsync(const Args& info);
  val ExecuteScriptAsync(const Args& info);
  val ExecuteFileAsync(const Args& info);
  val ExecuteAsync(const Args& info);
  val CallAsync(const Args& info);
  val Cancel(const Args& info);
  val IsBusyMethod(const Args& info);

  val AddSearchPath(const Args& info);
  val RegisterModule(const Args& info);
  val AddSearcher(const Args& info);
  val Compile(const Args& info);
  val CompileFile(const Args& info);
  val LoadBytecode(const Args& info);
  val SetPrintHandler(const Args& info);
  val SetReadHandler(const Args& info);
  val SetFileReader(const Args& info);
  val SetHook(const Args& info);
  val RemoveHook(const Args& info);
  val GetStack(const Args& info);
  val GetLocals(const Args& info);

  val GetMemoryUsage(const Args& info);
  val Info(const Args& info);
  val Release(const Args& info);
  val Dispose(const Args& info);
  val Reset(const Args& info);
  val GC(const Args& info);
  // Native: the constructor's call to SubscribeSharedTables. A second step
  // here, made by the shell once the JS object is a context; see shell.js.
  val SubscribeShared(const Args& info);

  [[nodiscard]] bool IsBusy() const { return is_busy_.load(); }

  // --- what the handle functions use ----------------------------------------
  //
  // Public for the reason it is natively: a Lua function's call, a table
  // handle's methods and a Proxy's traps are free functions (in lua-wasm.cpp),
  // not members, and each names its context through its `*Data`.

  // Native: LuaContext::CallScope.
  struct CallScope {
    LuaContext* ctx;
    explicit CallScope(LuaContext* c) : ctx(c) {
      if (ctx->call_depth_++ == 0) ctx->js_error_registry_.clear();
    }
    ~CallScope() { --ctx->call_depth_; }
    CallScope(const CallScope&) = delete;
    CallScope& operator=(const CallScope&) = delete;
  };

  // **No native counterpart.** One level of a core value becoming a JS one. The
  // recursion carries no depth of its own, and here it needs one, to ask
  // whether the engine's stack has room (stack.h).
  struct ConvertScope {
    int& depth;
    explicit ConvertScope(int& d) : depth(d) {
      // Asked before counting: a constructor that throws runs no destructor.
      try {
        lua_core::detail::RequireStackHeadroom(depth);
      } catch (const std::exception& e) {
        throw js::MakeError(e.what());
      }
      ++depth;
    }
    ~ConvertScope() { --depth; }
    ConvertScope(const ConvertScope&) = delete;
    ConvertScope& operator=(const ConvertScope&) = delete;
  };

  // Native: LuaContext::JsCallbackCollectorScope.
  struct JsCallbackCollectorScope {
    LuaContext* ctx;
    std::vector<std::string>* prev;
    std::vector<std::string> names;
    explicit JsCallbackCollectorScope(LuaContext* c)
        : ctx(c), prev(c->js_callback_collector_) {
      ctx->js_callback_collector_ = &names;
    }
    ~JsCallbackCollectorScope() {
      ctx->js_callback_collector_ = prev;
      try {
        if (!names.empty()) ctx->SweepUnpushedJsCallbacks(names);
      } catch (...) {
        // Deliberately swallowed: a destructor must not throw, and a failed
        // sweep only strands an entry until the context is destroyed.
      }
    }
    JsCallbackCollectorScope(const JsCallbackCollectorScope&) = delete;
    JsCallbackCollectorScope& operator=(const JsCallbackCollectorScope&) = delete;
    void PropagateToParent() {
      if (prev) prev->insert(prev->end(), names.begin(), names.end());
      names.clear();
    }
  };

  lua_core::LuaValue NapiToCoreInstance(const val& value, int depth = 0);
  val CoreToNapi(const lua_core::LuaValue& value);
  val ResultsToJs(const std::vector<lua_core::LuaPtr>& values);
  void ThrowLuaError(const std::string& fallback);
  // Native: LuaContext::CreateTableHandle. Takes ownership of `registry_ref`.
  val CreateTableHandle(int registry_ref);
  // The shell's record for this context; see shell_state_.
  [[nodiscard]] const val& ShellState() const { return shell_state_; }
  // This context's own JS object. Native: `ObjectWrap::Value()`.
  [[nodiscard]] val Self() const;

  // What the coroutine cursors, the await continuations and a deferred run
  // call through; public for the reason the members above are.
  val ResumeCoroutineObject(const val& coro_obj, const std::vector<val>& args_js);
  val ResumeCoroutineObjectAsync(const val& coro_obj, const std::vector<val>& args_js,
                                 const val& self);
  val OnAwaitSettled(const val& value, bool is_error, uint64_t gen);
  void ClearBusy();

 private:
  LuaContext() = default;
  // The body of the native constructor. Returns with a JS exception pending
  // on failure, exactly as the native one does.
  void Construct(const Args& info);

  // Native: ConversionPathScope / ConversionPathEntry.
  struct ConversionPathScope {
    LuaContext* ctx;
    std::vector<val> saved;
    explicit ConversionPathScope(LuaContext* c) : ctx(c) { saved.swap(ctx->conversion_path_); }
    ~ConversionPathScope() { ctx->conversion_path_.swap(saved); }
    ConversionPathScope(const ConversionPathScope&) = delete;
    ConversionPathScope& operator=(const ConversionPathScope&) = delete;
  };
  struct ConversionPathEntry {
    LuaContext* ctx;
    ConversionPathEntry(LuaContext* c, const val& v) : ctx(c) { ctx->conversion_path_.push_back(v); }
    ~ConversionPathEntry() { ctx->conversion_path_.pop_back(); }
    ConversionPathEntry(const ConversionPathEntry&) = delete;
    ConversionPathEntry& operator=(const ConversionPathEntry&) = delete;
  };

  // --- construction ---------------------------------------------------------
  bool CreateRuntime(ContextInitOptions& init);
  void InstallRuntimeHandlers();
  void DetachRuntimeHandlers() const;
  void RegisterCallbacks(const val& callbacks);
  bool ApplyFilesystemOption(const val& options);
  bool ApplyTableAsOption(const val& options);
  bool ApplyStateOptions(const val& options, bool sandbox_preset);
  void InstallPrintHandler(const val& fn);
  bool InstallReadHandler(const val& fn);
  void InstallFileReader(const val& fn);
  void InstallDebugHook(const val& fn, int mask, int count);
  void SubscribeSharedTables(const val& self, const val& options);

  // --- teardown and reset ---------------------------------------------------
  val BindingRefCounts();
  bool ReleaseObjectHandle(const val& obj);
  bool ReplayRuntimeSettings();
  void ReplaySharedTables();

  // --- occupancy ------------------------------------------------------------
  [[nodiscard]] bool RejectIfOccupied(const char* op, lua_occupancy::Claim disallowed,
                                      const char* detail = nullptr) const;
  [[nodiscard]] bool RejectIfBusy() const;

  // --- errors ---------------------------------------------------------------
  std::string StageJsError(const val& value, const std::string& message,
                           const lua_core::LuaRuntime* owner);
  val LuaErrorToJsValue(const std::string& fallback);
  lua_core::LuaRuntime::Function CreateJsCallbackWrapper(const std::string& name);
  lua_core::LuaRuntime::Function CreateConstructorWrapper(
      const std::string& name, const std::string& class_name, bool readable, bool writable);

  // --- userdata and classes -------------------------------------------------
  using FunctionList = std::vector<std::pair<std::string, val>>;
  int NextUserdataId();
  lua_core::LuaPtr ReadUserdataProperty(int ref_id, const std::string& key);
  void WriteUserdataProperty(int ref_id, const std::string& key, const lua_core::LuaPtr& value);
  [[nodiscard]] const ClassAccessor* FindClassAccessor(const std::string& class_name,
                                                       const std::string& key) const;
  void RegisterUserdataMethods(int ref_id, const FunctionList& method_funcs,
                               std::vector<std::string>& registered_method_fns);
  void RollBackUserdata(const std::string& name, int ref_id,
                        const std::vector<std::string>& registered_method_fns,
                        bool global_installed);
  bool BuildClassStatics(uint64_t class_id, const FunctionList& static_fn_snapshot,
                         const FunctionList& static_val_snapshot, FunctionList& deferred_fns,
                         std::vector<lua_core::MetatableEntry>& statics);
  void ReserveDeferredCallbacks(const FunctionList& deferred) const;

  // --- coroutines and the await driver --------------------------------------
  val CreateCoroutineObject(std::unique_ptr<LuaThreadData> data, const std::string& status);
  val CoroutineResultToJs(const val& coro_obj, lua_core::CoroutineStatus status,
                          const std::vector<lua_core::LuaPtr>& values,
                          const std::optional<std::string>& error);
  [[nodiscard]] const lua_core::LuaThreadRef& AsyncDrivenThread() const;
  val BeginAsyncRun(const val& self, const std::vector<lua_core::LuaPtr>& args,
                    const char* arg_role = "resume value");
  std::optional<lua_core::LuaFunctionRef> ResolveAsyncCallTarget(
      const val& target_arg, std::string& reject_reason, bool& threw);
  [[nodiscard]] Deferred ActiveAsyncDeferred() const;
  void DriveAsync(const std::vector<lua_core::LuaPtr>& args, bool is_error,
                  const char* arg_role = "resume value");
  void SettlePlainYield(const lua_core::AsyncStepResult& step);
  void AttachToAwaitedPromise();
  void SettleFinishedRun(const lua_core::AsyncStepResult& step);
  void FinishAsync();
  void ScheduleWorkerRun(bool is_file, std::string source, std::string chunk_name,
                         const Deferred& deferred);
  // Native: LuaContext::AsyncDriverEngaged / AsyncRunSuperseded.
  [[nodiscard]] bool AsyncDriverEngaged() const {
    return (async_co_.has_value() || async_borrowed_ != nullptr) &&
           async_deferred_.has_value();
  }
  [[nodiscard]] bool AsyncRunSuperseded(const uint64_t gen) const {
    return !AsyncDriverEngaged() || gen != async_generation_;
  }

  // --- JS -> Lua ------------------------------------------------------------
  lua_core::LuaValue NapiToCoreImpl(const val& value, int depth);
  lua_core::LuaValue ObjectToCore(const val& value, int depth);
  std::optional<lua_core::LuaValue> RoundTripMarkerToCore(const val& obj);
  std::optional<lua_core::LuaValue> ClassInstanceMarkerToCore(const val& obj);
  std::optional<lua_core::LuaValue> ApplyTypeConverters(const val& value, int depth);
  lua_core::LuaValue MapToTableRef(const val& map, int depth);
  [[nodiscard]] bool IsOnConversionPath(const val& v) const;
  void SweepUnpushedJsCallbacks(const std::vector<std::string>& names);

  // --- Lua -> JS ------------------------------------------------------------
  val CoreToNapiBuiltin(const lua_core::LuaValue& value);
  static val IntegerToNapi(int64_t v);
  [[nodiscard]] val StringToNapi(const std::string& v) const;
  val ArrayToNapi(const lua_core::LuaArray& v);
  val TableToNapi(const lua_core::LuaTable& v);
  val FunctionRefToNapi(const lua_core::LuaFunctionRef& v);
  val UserdataRefToNapi(const lua_core::LuaUserdataRef& v);
  val TableRefToNapi(const lua_core::LuaTableRef& v);
  val TableRefToMap(const lua_core::LuaTableRef& ref, int depth);

  // Native: LuaContext::RefForThisRuntime / Liveness.
  template <typename RefT>
  RefT RefForThisRuntime(const RefT& ref) const;
  [[nodiscard]] ContextLiveness Liveness() const { return {alive_, context_alive_, closed_flag_}; }

  static constexpr int kMaxTableDepth = 100;  // matches the core's kMaxDepth

  // --- state (native: the members of the same names) --------------------------
  std::shared_ptr<lua_core::LuaRuntime> runtime_;
  std::unordered_map<std::string, val> js_callbacks_;
  std::atomic<bool> is_busy_{false};
  std::shared_ptr<std::atomic<bool>> alive_ = std::make_shared<std::atomic<bool>>(true);
  std::shared_ptr<std::atomic<bool>> context_alive_ = std::make_shared<std::atomic<bool>>(true);

  uint64_t next_js_callback_id_ = 1;  // monotonic id for anonymous nested callbacks
  std::vector<std::pair<val, val>> type_converters_;
  std::vector<std::pair<val, val>> from_lua_converters_;

  std::optional<val> print_handler_;
  // Native: the members of the same names. Each handler's lambda reads its
  // member at call time, so the member is committed after the core install.
  std::optional<val> read_handler_;
  std::optional<val> file_reader_;
  std::optional<val> debug_hook_;
  int debug_hook_mask_ = 0;
  int debug_hook_count_ = 0;
  uint64_t next_module_id_ = 1;
  uint64_t next_searcher_id_ = 1;
  // Context configuration that reset() replays (slice 7): recorded only after
  // the core call that applied it succeeded.
  std::vector<std::string> search_paths_;
  std::vector<val> searchers_;
  // Each shared table this context subscribed to, with the global it is
  // published as, so reset() can publish it onto the fresh state.
  std::vector<std::pair<val, std::string>> shared_tables_;

  // Native: the members of the same names, where each one's constraints are
  // written down — the userdata id is an `int` because the core's API is, and
  // reset() deliberately does not rewind it.
  std::unordered_map<int, UserdataEntry> js_userdata_;
  std::unordered_map<int, std::vector<std::string>> ud_method_fns_;
  int next_userdata_id_ = 1;
  uint64_t next_metatable_id_ = 1;
  uint64_t next_class_id_ = 1;
  std::unordered_set<std::string> registered_classes_;
  std::unordered_map<std::string, ClassAccessorTable> class_accessors_;

  // The await driver. Native: the members of the same names, where the two
  // ownership modes (a thread this run created, or one borrowed from the
  // caller's coroutine object) and the generation counter are explained.
  std::optional<lua_core::LuaThreadRef> async_co_;
  const LuaThreadData* async_borrowed_ = nullptr;
  std::optional<val> async_coro_obj_;
  bool async_coroutine_mode_ = false;
  std::optional<Deferred> async_deferred_;
  std::optional<val> async_pending_promise_;
  std::optional<val> async_self_ref_;
  bool async_resuming_ = false;
  uint64_t async_generation_ = 0;

  std::unordered_map<uint64_t, val> js_error_registry_;
  uint64_t next_js_error_id_ = 1;
  int call_depth_ = 0;
  int convert_depth_ = 0;  // see ConvertScope
  bool in_reset_ = false;

  std::vector<std::string>* js_callback_collector_ = nullptr;
  std::vector<val> conversion_path_;

  std::optional<val> callbacks_ref_;
  bool allow_bytecode_ = true;
  bool filesystem_denied_ = false;
  bool table_as_map_ = false;
  bool closed_ = false;
  std::shared_ptr<std::atomic<bool>> closed_flag_ = std::make_shared<std::atomic<bool>>(false);

  // **No native counterpart.** The shell's record for this context, handed to
  // every handle it mints so that the shell can refuse them together; see
  // "foreign exceptions" in shell.js. C++ reads nothing from it and writes one
  // field: `run`, the promise record of the async run in flight.
  val shell_state_;
  bool binary_strings_ = false;
};

}  // namespace lua_wasm
