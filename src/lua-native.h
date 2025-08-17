#ifndef LUA_NATIVE_H
#define LUA_NATIVE_H

#include <napi.h>
#include <string>
#include <unordered_map>
#include <memory>

#include "core/lua-runtime.h"

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

    void RegisterCallbacks(const Napi::Object& callbacks);
    // Adapter conversions
    static lua_core::LuaValue NapiToCore(const Napi::Value& value);
    Napi::Value CoreToNapi(const lua_core::LuaValue& value);
};

#endif //LUA_NATIVE_H
