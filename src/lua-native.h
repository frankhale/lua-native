#ifndef LUA_NATIVE_H
#define LUA_NATIVE_H

#include <napi.h>
#include <string>
#include <unordered_map>
#include <memory>

#include "core/lua-runtime.h"

struct LuaFunctionData {
  std::shared_ptr<lua_core::LuaRuntime> runtime;
  lua_core::LuaFunctionRef funcRef;

  LuaFunctionData(std::shared_ptr<lua_core::LuaRuntime> rt, lua_core::LuaFunctionRef ref)
    : runtime(std::move(rt)), funcRef(ref) {}

  ~LuaFunctionData() {
    // Release the Lua registry reference when this data is destroyed
    funcRef.release();
  }
};

class LuaContext final : public Napi::ObjectWrap<LuaContext> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    explicit LuaContext(const Napi::CallbackInfo& info);
    ~LuaContext() override;

    Napi::Value ExecuteScript(const Napi::CallbackInfo& info);
    Napi::Value SetGlobal(const Napi::CallbackInfo& info);

private:
    Napi::Env env;
    std::shared_ptr<lua_core::LuaRuntime> runtime;
    std::unordered_map<std::string, Napi::FunctionReference> js_callbacks;
    std::vector<std::unique_ptr<LuaFunctionData>> lua_function_data_;  // Prevent leaks

    void RegisterCallbacks(const Napi::Object& callbacks);
    // Adapter conversion (private)
    Napi::Value CoreToNapi(const lua_core::LuaValue& value);

public:
    static lua_core::LuaValue NapiToCore(const Napi::Value& value);

private:

    static Napi::Value LuaFunctionCallback(const Napi::CallbackInfo& info);
};

#endif //LUA_NATIVE_H
