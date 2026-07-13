#pragma once

#include <napi.h>
#include <atomic>
#include <string>
#include <unordered_map>
#include <memory>
#include <utility>
#include <vector>
#include <optional>

#include "core/lua-runtime.h"

class LuaContext;

struct LuaFunctionData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaFunctionRef funcRef;
  LuaContext* context;

  LuaFunctionData(std::shared_ptr<lua_core::LuaRuntime> rt,
                  lua_core::LuaFunctionRef ref,
                  LuaContext* ctx)
    : runtime(std::move(rt)), funcRef(std::move(ref)), context(ctx) {}

  ~LuaFunctionData() {
    funcRef.release();
  }
};

struct LuaThreadData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaThreadRef threadRef;

  LuaThreadData(std::shared_ptr<lua_core::LuaRuntime> rt, lua_core::LuaThreadRef ref)
    : runtime(std::move(rt)), threadRef(std::move(ref)) {}

  ~LuaThreadData() {
    threadRef.release();
  }
};

struct LuaUserdataData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaUserdataRef userdataRef;

  LuaUserdataData(std::shared_ptr<lua_core::LuaRuntime> rt,
                  lua_core::LuaUserdataRef ref)
    : runtime(std::move(rt)), userdataRef(std::move(ref)) {}

  ~LuaUserdataData() {
    userdataRef.release();
  }
};

struct LuaTableRefData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaTableRef tableRef;
  LuaContext* context;

  LuaTableRefData(std::shared_ptr<lua_core::LuaRuntime> rt,
                  lua_core::LuaTableRef ref,
                  LuaContext* ctx)
    : runtime(std::move(rt)), tableRef(std::move(ref)), context(ctx) {}

  ~LuaTableRefData() {
    tableRef.release();
  }
};

struct UserdataEntry {
  Napi::ObjectReference object;
  bool readable;
  bool writable;
};

class LuaContext final : public Napi::ObjectWrap<LuaContext> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    explicit LuaContext(const Napi::CallbackInfo& info);
    ~LuaContext() override;

    Napi::Value ExecuteScript(const Napi::CallbackInfo& info);
    Napi::Value ExecuteFile(const Napi::CallbackInfo& info);
    Napi::Value ExecuteScriptAsync(const Napi::CallbackInfo& info);
    Napi::Value ExecuteFileAsync(const Napi::CallbackInfo& info);
    Napi::Value ExecuteAsync(const Napi::CallbackInfo& info);
    Napi::Value Cancel(const Napi::CallbackInfo& info);
    Napi::Value IsBusyMethod(const Napi::CallbackInfo& info);
    Napi::Value SetGlobal(const Napi::CallbackInfo& info);
    Napi::Value GetGlobal(const Napi::CallbackInfo& info);
    Napi::Value SetUserdata(const Napi::CallbackInfo& info);
    Napi::Value SetMetatable(const Napi::CallbackInfo& info);
    Napi::Value CreateCoroutine(const Napi::CallbackInfo& info);
    Napi::Value ResumeCoroutine(const Napi::CallbackInfo& info);
    Napi::Value AddSearchPath(const Napi::CallbackInfo& info);
    Napi::Value RegisterModule(const Napi::CallbackInfo& info);
    Napi::Value Compile(const Napi::CallbackInfo& info);
    Napi::Value CompileFile(const Napi::CallbackInfo& info);
    Napi::Value LoadBytecode(const Napi::CallbackInfo& info);
    Napi::Value CreateTableMethod(const Napi::CallbackInfo& info);
    Napi::Value GetGlobalRef(const Napi::CallbackInfo& info);
    Napi::Value GetMemoryUsage(const Napi::CallbackInfo& info);
    Napi::Value RegisterTypeConverter(const Napi::CallbackInfo& info);
    Napi::Value RegisterClass(const Napi::CallbackInfo& info);
    Napi::Value Pcall(const Napi::CallbackInfo& info);
    Napi::Value SetPrintHandler(const Napi::CallbackInfo& info);
    Napi::Value AddSearcher(const Napi::CallbackInfo& info);

    void ClearBusy();

    // Public so LuaFunctionCallbackStatic can use it
    Napi::Value CoreToNapi(const lua_core::LuaValue& value);
    lua_core::LuaValue NapiToCoreInstance(const Napi::Value& value, int depth = 0);

    // Marshals a Lua result list to a JS value: undefined for none, the value
    // itself for one, an array for many. Public so the async workers and the
    // Lua-function trampoline can share it.
    Napi::Value ResultsToJs(const std::vector<lua_core::LuaPtr>& values);

    // Reconstructs the original JS error for a surfaced Lua error (or a plain
    // Error from the string) and throws it. Public so LuaFunctionCallbackStatic
    // can use it.
    Napi::Value LuaErrorToJsValue(const std::string& fallback);
    void ThrowLuaError(const std::string& fallback);

    // RAII: clears the JS-error registry when the outermost Lua call begins.
    struct CallScope {
      LuaContext* ctx;
      explicit CallScope(LuaContext* c) : ctx(c) {
        if (ctx->call_depth_++ == 0) ctx->js_error_registry_.clear();
      }
      ~CallScope() { --ctx->call_depth_; }
    };

private:
    // The addon env, captured at construction. Safe to reuse from later instance
    // methods because they all run on the same JS thread while this ObjectWrap is
    // alive. It must NOT be used from a worker thread (see the async workers,
    // which take their env from the AsyncWorker instead).
    Napi::Env env;
    std::shared_ptr<lua_core::LuaRuntime> runtime;
    std::unordered_map<std::string, Napi::FunctionReference> js_callbacks_;
    // The per-crossing wrapper data (LuaFunctionData / LuaThreadData /
    // LuaUserdataData / LuaTableRefData) is not held here: each is owned by an
    // N-API finalizer tied to the JS object it backs, so it (and its registry
    // ref) is freed when that object is garbage-collected. Each *Data keeps its
    // own shared_ptr<LuaRuntime>, so the Lua state outlives every wrapper.

    // Set on the main thread around any in-flight async op (worker-thread
    // execute_*_async and coroutine-driven execute_async). Atomic for defensive
    // safety even though it is only touched on the main thread.
    std::atomic<bool> is_busy_{false};

    // In-flight coroutine-driven async execution state (execute_async).
    // Only one runs at a time (guarded by is_busy_).
    std::optional<lua_core::LuaThreadRef> async_co_;
    std::optional<Napi::Promise::Deferred> async_deferred_;
    Napi::ObjectReference async_pending_promise_;
    // Bumped when each execute_async run starts. The await-settlement callbacks
    // capture the generation they were created for; a settlement whose generation
    // no longer matches (e.g. a promise from a cancelled run) is ignored so it
    // can't drive a later run's coroutine.
    uint64_t async_generation_ = 0;

    void DriveAsync(std::vector<lua_core::LuaPtr> args, bool is_error);
    Napi::Value OnAwaitSettled(const Napi::Value& value, bool is_error, uint64_t gen);
    void FinishAsync();
    static Napi::Value OnAwaitResolveStatic(const Napi::CallbackInfo& info);
    static Napi::Value OnAwaitRejectStatic(const Napi::CallbackInfo& info);

    // User-registered JS->Lua type converters, consulted (in registration
    // order) before built-in type handling. Each entry is a {match, convert}
    // pair of JS functions.
    std::vector<std::pair<Napi::FunctionReference, Napi::FunctionReference>> type_converters_;

    // Userdata reference tracking. next_userdata_id_ keys the int-based userdata
    // maps and the in-userdata-block storage, so it stays int; the remaining
    // counters only feed unique-name strings and are widened to avoid overflow.
    std::unordered_map<int, UserdataEntry> js_userdata_;
    int next_userdata_id_ = 1;
    uint64_t next_metatable_id_ = 1;
    uint64_t next_module_id_ = 1;
    uint64_t next_class_id_ = 1;
    uint64_t next_searcher_id_ = 1;
    uint64_t next_js_callback_id_ = 1;  // monotonic id for anonymous nested callbacks

    // Output redirection (E1): JS handler for print()/io.write().
    Napi::FunctionReference print_handler_;
    void InstallPrintHandler(const Napi::Function& fn);

    // Error fidelity (D1): keeps thrown JS Error objects alive so they can be
    // reconstructed when a Lua error carrying their id surfaces back to JS.
    std::unordered_map<int, Napi::ObjectReference> js_error_registry_;
    int next_js_error_id_ = 1;
    int call_depth_ = 0;  // clears the registry when the outermost call starts

    // Stages a structured error table for a thrown JS value (object errors only)
    // and returns the display message.
    std::string StageJsError(const Napi::Value& value, const std::string& message);

    // Throws a JS "busy" error and returns true if an async op is in flight, so
    // the caller can early-return. Centralizes the guard duplicated across the
    // synchronous API methods.
    bool RejectIfBusy();

    void RegisterCallbacks(const Napi::Object& callbacks);
    lua_core::LuaRuntime::Function CreateJsCallbackWrapper(const std::string& name);
    lua_core::LuaRuntime::Function CreateConstructorWrapper(
        const std::string& name, const std::string& class_name,
        bool readable, bool writable);
    Napi::Object CreateTableHandle(Napi::Env env, int registry_ref);

public:
    static lua_core::LuaValue NapiToCore(const Napi::Value& value, int depth = 0);
};
