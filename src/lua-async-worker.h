#pragma once

#include <napi.h>
#include <memory>
#include <string>
#include <variant>

#include "core/lua-runtime.h"

class LuaContext;

// Brackets one off-thread run. Main-thread registry unrefs (GC finalizers) are
// deferred for its duration so they cannot mutate the registry concurrently
// with the worker's Lua (H9c), and the teardown is RAII so that even if the run
// throws — an unexpected C++ exception the AsyncWorker base catches —
// async_mode_ is cleared and the deferral queue drained. Otherwise the context
// would be left permanently degraded (H1).
class WorkerRunScope {
public:
  explicit WorkerRunScope(lua_core::LuaRuntime* runtime) : runtime_(runtime) {
    runtime_->BeginWorkerUnrefDeferral();
    runtime_->SetAsyncMode(true);
  }
  ~WorkerRunScope() {
    runtime_->SetAsyncMode(false);
    runtime_->EndWorkerUnrefDeferral();
  }
  WorkerRunScope(const WorkerRunScope&) = delete;
  WorkerRunScope& operator=(const WorkerRunScope&) = delete;

private:
  lua_core::LuaRuntime* runtime_;
};

class LuaScriptAsyncWorker : public Napi::AsyncWorker {
public:
  LuaScriptAsyncWorker(
    std::shared_ptr<lua_core::LuaRuntime> runtime,
    std::string script,
    LuaContext* context,
    Napi::ObjectReference context_ref,
    const Napi::Promise::Deferred &deferred,
    // Copied across the thread boundary with the source, for the same reason
    // the source is: the worker thread must not touch a JS string.
    std::string chunk_name = "")
    : Napi::AsyncWorker(deferred.Env()),
      runtime_(std::move(runtime)),
      script_(std::move(script)),
      context_(context),
      // Persistent ref to the wrapping JS object keeps the LuaContext (an
      // ObjectWrap) alive until this worker is destroyed, so OnOK/OnError can
      // safely use context_ even if JS drops its last reference meanwhile.
      context_ref_(std::move(context_ref)),
      deferred_(deferred),
      chunk_name_(std::move(chunk_name)) {}

protected:

  void Execute() override {
    const WorkerRunScope run(runtime_.get());
    result_ = runtime_->ExecuteScript(script_, chunk_name_);
  }

  void OnOK() override;
  void OnError(const Napi::Error& error) override;

private:
  std::shared_ptr<lua_core::LuaRuntime> runtime_;
  std::string script_;
  LuaContext* context_;
  Napi::ObjectReference context_ref_;
  Napi::Promise::Deferred deferred_;
  std::string chunk_name_;
  lua_core::ScriptResult result_;
};

class LuaFileAsyncWorker : public Napi::AsyncWorker {
public:
  LuaFileAsyncWorker(
    std::shared_ptr<lua_core::LuaRuntime> runtime,
    std::string filepath,
    LuaContext* context,
    Napi::ObjectReference context_ref,
    const Napi::Promise::Deferred &deferred)
    : Napi::AsyncWorker(deferred.Env()),
      runtime_(std::move(runtime)),
      filepath_(std::move(filepath)),
      context_(context),
      context_ref_(std::move(context_ref)),
      deferred_(deferred) {}

protected:

  void Execute() override {
    const WorkerRunScope run(runtime_.get());
    result_ = runtime_->ExecuteFile(filepath_);
  }

  void OnOK() override;
  void OnError(const Napi::Error& error) override;

private:
  std::shared_ptr<lua_core::LuaRuntime> runtime_;
  std::string filepath_;
  LuaContext* context_;
  Napi::ObjectReference context_ref_;
  Napi::Promise::Deferred deferred_;
  lua_core::ScriptResult result_;
};
