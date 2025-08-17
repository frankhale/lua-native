#include "lua-native.h"

#include <limits>

Napi::Object LuaContext::Init(const Napi::Env env, const Napi::Object exports) {
  const Napi::Function func = DefineClass(env, "LuaContext", {
    InstanceMethod("execute_script", &LuaContext::ExecuteScript),
    InstanceMethod("set_global", &LuaContext::SetGlobal)
  });

  auto* constructor = new Napi::FunctionReference();
  *constructor = Napi::Persistent(func);

  exports.Set(Napi::String::New(env, "init"), constructor->Value());

  return exports;
}

LuaContext::LuaContext(const Napi::CallbackInfo& info)
  : ObjectWrap(info), env(info.Env()) {
  runtime = std::make_shared<lua_core::LuaRuntime>(true);
  if (info.Length() > 0 && info[0].IsObject()) {
    RegisterCallbacks(info[0].As<Napi::Object>());
  }
}

void LuaContext::RegisterCallbacks(const Napi::Object& callbacks) {
  Napi::Array keys = callbacks.GetPropertyNames();

  for (uint32_t i = 0; i < keys.Length(); i++) {
    Napi::Value key = keys[i];
    Napi::Value val = callbacks.Get(key);
    std::string key_str = key.ToString();

    if (val.IsFunction()) {
      js_callbacks[key_str] = Napi::Persistent(val.As<Napi::Function>());
      // Register wrapper into core runtime
      runtime->RegisterFunction(key_str, [this, name = key_str](const std::vector<lua_core::LuaPtr>& args) {
        std::vector<napi_value> jsArgs;
        jsArgs.reserve(args.size());
        for (const auto& a : args) jsArgs.push_back(CoreToNapi(*a));
        const Napi::Value result = js_callbacks[name].Call(jsArgs);
        return std::make_shared<lua_core::LuaValue>(NapiToCore(result));
      });
    } else {
      runtime->SetGlobal(key_str, std::make_shared<lua_core::LuaValue>(NapiToCore(val)));
    }
  }
}

Napi::Value LuaContext::SetGlobal(const Napi::CallbackInfo& info) {
  if (info.Length() < 2 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string name as first argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  if (const Napi::Value value = info[1]; value.IsFunction()) {
    js_callbacks[name] = Napi::Persistent(value.As<Napi::Function>());
    runtime->RegisterFunction(name, [this, name](const std::vector<lua_core::LuaPtr>& args) {
      std::vector<napi_value> jsArgs;
      jsArgs.reserve(args.size());
      for (const auto& a : args) jsArgs.push_back(CoreToNapi(*a));
      const Napi::Value result = js_callbacks[name].Call(jsArgs);
      return std::make_shared<lua_core::LuaValue>(NapiToCore(result));
    });
  } else {
    runtime->SetGlobal(name, std::make_shared<lua_core::LuaValue>(NapiToCore(value)));
  }

  return env.Undefined();
}

LuaContext::~LuaContext() { js_callbacks.clear(); }

Napi::Value LuaContext::ExecuteScript(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string script = info[0].As<Napi::String>().Utf8Value();

  const auto res = runtime->ExecuteScript(script);
  if (std::holds_alternative<std::string>(res)) {
    Napi::Error::New(env, std::get<std::string>(res)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& values = std::get<std::vector<lua_core::LuaPtr>>(res);
  if (values.empty()) return env.Undefined();
  if (values.size() == 1) return CoreToNapi(*values[0]);

  const Napi::Array array = Napi::Array::New(env, values.size());
  for (size_t i = 0; i < values.size(); ++i) array.Set(i, CoreToNapi(*values[i]));
  return array;
}

Napi::Object InitModule(const Napi::Env env, const Napi::Object exports) {
  const auto result = LuaContext::Init(env, exports);
  env.SetInstanceData<Napi::FunctionReference>(
    new Napi::FunctionReference(Napi::Persistent(exports.Get("init").As<Napi::Function>())));
  return result;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, InitModule)

// Adapter conversions
lua_core::LuaValue LuaContext::NapiToCore(const Napi::Value& value) {
  if (value.IsNull() || value.IsUndefined()) {
    return lua_core::LuaValue{lua_core::LuaValue::Variant{std::monostate{}}};
  }
  if (value.IsBoolean()) {
    return lua_core::LuaValue{lua_core::LuaValue::Variant{value.As<Napi::Boolean>().Value()}};
  }
  if (value.IsNumber()) {
    const double num = value.As<Napi::Number>().DoubleValue();
    if (std::isfinite(num) && num >= static_cast<double>(std::numeric_limits<int64_t>::min()) &&
        num <= static_cast<double>(std::numeric_limits<int64_t>::max())) {
      double intpart;
      if (std::modf(num, &intpart) == 0.0) {
        return lua_core::LuaValue{lua_core::LuaValue::Variant{static_cast<int64_t>(num)}};
      }
    }
    return lua_core::LuaValue{lua_core::LuaValue::Variant{num}};
  }
  if (value.IsString()) {
    return lua_core::LuaValue{lua_core::LuaValue::Variant{value.As<Napi::String>().Utf8Value()}};
  }
  if (value.IsObject()) {
    if (value.IsArray()) {
      const auto arr = value.As<Napi::Array>();
      lua_core::LuaArray coreArr;
      coreArr.reserve(arr.Length());
      for (uint32_t i = 0; i < arr.Length(); ++i) {
        coreArr.push_back(std::make_shared<lua_core::LuaValue>(NapiToCore(arr.Get(i))));
      }
      return lua_core::LuaValue{lua_core::LuaValue::Variant{std::move(coreArr)}};
    }
    const auto obj = value.As<Napi::Object>();
    Napi::Array keys = obj.GetPropertyNames();
    lua_core::LuaTable tbl;
    for (uint32_t i = 0; i < keys.Length(); i++) {
      Napi::Value key = keys[i];
      std::string keyStr;
      if (key.IsString()) keyStr = key.As<Napi::String>().Utf8Value();
      else if (key.IsNumber()) keyStr = std::to_string(key.As<Napi::Number>().Int64Value());
      else continue;
      tbl.emplace(std::move(keyStr), std::make_shared<lua_core::LuaValue>(NapiToCore(obj.Get(key))));
    }
    return lua_core::LuaValue{lua_core::LuaValue::Variant{std::move(tbl)}};
  }
  return lua_core::LuaValue{lua_core::LuaValue::Variant{std::monostate{}}};
}

Napi::Value LuaContext::CoreToNapi(const lua_core::LuaValue& value) {
  return std::visit(
      [&](const auto& v) -> Napi::Value {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, std::monostate>) {
          return env.Null();
        } else if constexpr (std::is_same_v<T, bool>) {
          return Napi::Boolean::New(env, v);
        } else if constexpr (std::is_same_v<T, int64_t>) {
          return Napi::Number::New(env, static_cast<double>(v));
        } else if constexpr (std::is_same_v<T, double>) {
          return Napi::Number::New(env, v);
        } else if constexpr (std::is_same_v<T, std::string>) {
          return Napi::String::New(env, v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaArray>) {
          Napi::Array arr = Napi::Array::New(env, v.size());
          for (size_t i = 0; i < v.size(); ++i) {
            arr.Set(i, CoreToNapi(*v[i]));
          }
          return arr;
        } else if constexpr (std::is_same_v<T, lua_core::LuaTable>) {
          Napi::Object obj = Napi::Object::New(env);
          for (const auto& [k, val] : v) {
            obj.Set(k, CoreToNapi(*val));
          }
          return obj;
        }
        return env.Undefined();
      },
      value.value);
}