#pragma once

#include <napi.h>
#include <memory>
#include <string>
#include <variant>
#include <vector>

#include "core/lua-runtime.h"

class LuaContext;

class LuaScriptAsyncWorker : public Napi::AsyncWorker {
public:
  LuaScriptAsyncWorker(
    std::shared_ptr<lua_core::LuaRuntime> runtime,
    std::string script,
    LuaContext* context,
    Napi::ObjectReference contextRef,
    Napi::Promise::Deferred deferred)
    : Napi::AsyncWorker(deferred.Env()),
      runtime_(std::move(runtime)),
      script_(std::move(script)),
      context_(context),
      // Persistent ref to the wrapping JS object keeps the LuaContext (an
      // ObjectWrap) alive until this worker is destroyed, so OnOK/OnError can
      // safely use context_ even if JS drops its last reference meanwhile.
      contextRef_(std::move(contextRef)),
      deferred_(deferred) {}

  void Execute() override {
    // Defer main-thread registry unrefs (GC finalizers) for the duration of the
    // off-thread run so they can't mutate the registry concurrently (H9c).
    runtime_->BeginWorkerUnrefDeferral();
    runtime_->SetAsyncMode(true);
    result_ = runtime_->ExecuteScript(script_);
    runtime_->SetAsyncMode(false);
    runtime_->EndWorkerUnrefDeferral();
  }

  void OnOK() override;
  void OnError(const Napi::Error& error) override;

private:
  std::shared_ptr<lua_core::LuaRuntime> runtime_;
  std::string script_;
  LuaContext* context_;
  Napi::ObjectReference contextRef_;
  Napi::Promise::Deferred deferred_;
  lua_core::ScriptResult result_;
};

class LuaFileAsyncWorker : public Napi::AsyncWorker {
public:
  LuaFileAsyncWorker(
    std::shared_ptr<lua_core::LuaRuntime> runtime,
    std::string filepath,
    LuaContext* context,
    Napi::ObjectReference contextRef,
    Napi::Promise::Deferred deferred)
    : Napi::AsyncWorker(deferred.Env()),
      runtime_(std::move(runtime)),
      filepath_(std::move(filepath)),
      context_(context),
      contextRef_(std::move(contextRef)),
      deferred_(deferred) {}

  void Execute() override {
    // See LuaScriptAsyncWorker::Execute — defer main-thread registry unrefs for
    // the off-thread run (H9c).
    runtime_->BeginWorkerUnrefDeferral();
    runtime_->SetAsyncMode(true);
    result_ = runtime_->ExecuteFile(filepath_);
    runtime_->SetAsyncMode(false);
    runtime_->EndWorkerUnrefDeferral();
  }

  void OnOK() override;
  void OnError(const Napi::Error& error) override;

private:
  std::shared_ptr<lua_core::LuaRuntime> runtime_;
  std::string filepath_;
  LuaContext* context_;
  Napi::ObjectReference contextRef_;
  Napi::Promise::Deferred deferred_;
  lua_core::ScriptResult result_;
};
