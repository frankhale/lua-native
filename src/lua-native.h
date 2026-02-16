#ifndef LUA_NATIVE_H
#define LUA_NATIVE_H

#include <napi.h>
#include <string>
#include <unordered_map>
#include <memory>

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
    // Release the Lua registry reference when this data is destroyed
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
    Napi::Value SetGlobal(const Napi::CallbackInfo& info);
    Napi::Value GetGlobal(const Napi::CallbackInfo& info);
    Napi::Value SetUserdata(const Napi::CallbackInfo& info);
    Napi::Value SetMetatable(const Napi::CallbackInfo& info);
    Napi::Value CreateCoroutine(const Napi::CallbackInfo& info);
    Napi::Value ResumeCoroutine(const Napi::CallbackInfo& info);

    // Public so LuaFunctionCallbackStatic can use it
    Napi::Value CoreToNapi(const lua_core::LuaValue& value);
    lua_core::LuaValue NapiToCoreInstance(const Napi::Value& value, int depth = 0);

private:
    Napi::Env env;
    std::shared_ptr<lua_core::LuaRuntime> runtime;
    std::unordered_map<std::string, Napi::FunctionReference> js_callbacks;
    std::vector<std::unique_ptr<LuaFunctionData>> lua_function_data_;
    std::vector<std::unique_ptr<LuaThreadData>> lua_thread_data_;
    std::vector<std::unique_ptr<LuaUserdataData>> lua_userdata_data_;

    // Userdata reference tracking
    std::unordered_map<int, UserdataEntry> js_userdata_;
    int next_userdata_id_ = 1;
    int next_metatable_id_ = 1;

    void RegisterCallbacks(const Napi::Object& callbacks);
    lua_core::LuaRuntime::Function CreateJsCallbackWrapper(const std::string& name);

public:
    static lua_core::LuaValue NapiToCore(const Napi::Value& value, int depth = 0);
};

#endif //LUA_NATIVE_H
