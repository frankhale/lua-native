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
    Napi::Promise::Deferred deferred)
    : Napi::AsyncWorker(deferred.Env()),
      runtime_(std::move(runtime)),
      script_(std::move(script)),
      context_(context),
      deferred_(deferred) {}

  void Execute() override {
    runtime_->SetAsyncMode(true);
    result_ = runtime_->ExecuteScript(script_);
    runtime_->SetAsyncMode(false);
  }

  void OnOK() override;
  void OnError(const Napi::Error& error) override;

private:
  std::shared_ptr<lua_core::LuaRuntime> runtime_;
  std::string script_;
  LuaContext* context_;
  Napi::Promise::Deferred deferred_;
  lua_core::ScriptResult result_;
};

class LuaFileAsyncWorker : public Napi::AsyncWorker {
public:
  LuaFileAsyncWorker(
    std::shared_ptr<lua_core::LuaRuntime> runtime,
    std::string filepath,
    LuaContext* context,
    Napi::Promise::Deferred deferred)
    : Napi::AsyncWorker(deferred.Env()),
      runtime_(std::move(runtime)),
      filepath_(std::move(filepath)),
      context_(context),
      deferred_(deferred) {}

  void Execute() override {
    runtime_->SetAsyncMode(true);
    result_ = runtime_->ExecuteFile(filepath_);
    runtime_->SetAsyncMode(false);
  }

  void OnOK() override;
  void OnError(const Napi::Error& error) override;

private:
  std::shared_ptr<lua_core::LuaRuntime> runtime_;
  std::string filepath_;
  LuaContext* context_;
  Napi::Promise::Deferred deferred_;
  lua_core::ScriptResult result_;
};
