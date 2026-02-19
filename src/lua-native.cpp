#include "lua-native.h"
#include "lua-async-worker.h"

#include <cmath>
#include <limits>

// --- Proxy trap functions for LuaTableRef ---

static Napi::Value TableRefGetTrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());

  auto target = info[0].As<Napi::Object>();
  auto prop = info[1];

  // Skip symbols
  if (!prop.IsString()) return env.Undefined();

  std::string key = prop.As<Napi::String>().Utf8Value();

  // Round-trip marker
  if (key == "_tableRef") {
    return target.Get("_tableRef");
  }

  // "then" suppression - prevents Proxy from being treated as a thenable
  if (key == "then") return env.Undefined();

  try {
    auto result = data->runtime->GetTableField(data->tableRef.ref, key);
    return data->context->CoreToNapi(*result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

static Napi::Value TableRefSetTrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());

  auto prop = info[1];
  auto value = info[2];

  if (!prop.IsString()) return Napi::Boolean::New(env, true);

  std::string key = prop.As<Napi::String>().Utf8Value();

  try {
    auto coreValue = std::make_shared<lua_core::LuaValue>(
      data->context->NapiToCoreInstance(value));
    data->runtime->SetTableField(data->tableRef.ref, key, coreValue);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return Napi::Boolean::New(env, true);
}

static Napi::Value TableRefHasTrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());

  auto prop = info[1];

  if (!prop.IsString()) return Napi::Boolean::New(env, false);

  std::string key = prop.As<Napi::String>().Utf8Value();

  if (key == "_tableRef") return Napi::Boolean::New(env, true);

  try {
    bool has = data->runtime->HasTableField(data->tableRef.ref, key);
    return Napi::Boolean::New(env, has);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
}

static Napi::Value TableRefOwnKeysTrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());

  try {
    auto keys = data->runtime->GetTableKeys(data->tableRef.ref);
    Napi::Array arr = Napi::Array::New(env, keys.size());
    for (size_t i = 0; i < keys.size(); i++) {
      arr.Set(static_cast<uint32_t>(i), Napi::String::New(env, keys[i]));
    }
    return arr;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return Napi::Array::New(env, 0);
  }
}

static Napi::Value TableRefGetOwnPropertyDescriptorTrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());

  auto prop = info[1];

  if (!prop.IsString()) return env.Undefined();

  std::string key = prop.As<Napi::String>().Utf8Value();

  try {
    if (data->runtime->HasTableField(data->tableRef.ref, key)) {
      auto value = data->runtime->GetTableField(data->tableRef.ref, key);
      Napi::Object desc = Napi::Object::New(env);
      desc.Set("configurable", Napi::Boolean::New(env, true));
      desc.Set("enumerable", Napi::Boolean::New(env, true));
      desc.Set("value", data->context->CoreToNapi(*value));
      return desc;
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

static Napi::Value LuaFunctionCallbackStatic(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  auto* data = static_cast<LuaFunctionData*>(info.Data());
  if (!data || !data->runtime || !data->context) {
    Napi::Error::New(env, "Invalid Lua function reference").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Convert JS arguments to Lua values
  std::vector<lua_core::LuaPtr> args;
  args.reserve(info.Length());
  try {
    for (size_t i = 0; i < info.Length(); ++i) {
      args.push_back(std::make_shared<lua_core::LuaValue>(
        data->context->NapiToCoreInstance(info[i])));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Call the Lua function
  const auto result = data->runtime->CallFunction(data->funcRef, args);

  // Handle error case
  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env, std::get<std::string>(result)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Convert results back to JS
  const auto& values = std::get<std::vector<lua_core::LuaPtr>>(result);
  if (values.empty()) return env.Undefined();

  // For single return value, return it directly
  if (values.size() == 1) {
    return data->context->CoreToNapi(*values[0]);
  }

  // For multiple return values, return as array
  Napi::Array arr = Napi::Array::New(env, values.size());
  for (size_t i = 0; i < values.size(); ++i) {
    arr.Set(i, data->context->CoreToNapi(*values[i]));
  }
  return arr;
}

Napi::Object LuaContext::Init(const Napi::Env env, const Napi::Object exports) {
  const Napi::Function func = DefineClass(env, "LuaContext", {
    InstanceMethod("execute_script", &LuaContext::ExecuteScript),
    InstanceMethod("execute_file", &LuaContext::ExecuteFile),
    InstanceMethod("set_global", &LuaContext::SetGlobal),
    InstanceMethod("get_global", &LuaContext::GetGlobal),
    InstanceMethod("set_userdata", &LuaContext::SetUserdata),
    InstanceMethod("set_metatable", &LuaContext::SetMetatable),
    InstanceMethod("create_coroutine", &LuaContext::CreateCoroutine),
    InstanceMethod("resume", &LuaContext::ResumeCoroutine),
    InstanceMethod("execute_script_async", &LuaContext::ExecuteScriptAsync),
    InstanceMethod("execute_file_async", &LuaContext::ExecuteFileAsync),
    InstanceMethod("is_busy", &LuaContext::IsBusyMethod),
    InstanceMethod("add_search_path", &LuaContext::AddSearchPath),
    InstanceMethod("register_module", &LuaContext::RegisterModule),
    InstanceMethod("compile", &LuaContext::Compile),
    InstanceMethod("compile_file", &LuaContext::CompileFile),
    InstanceMethod("load_bytecode", &LuaContext::LoadBytecode)
  });

  auto* constructor = new Napi::FunctionReference();
  *constructor = Napi::Persistent(func);

  exports.Set(Napi::String::New(env, "init"), constructor->Value());

  return exports;
}

LuaContext::LuaContext(const Napi::CallbackInfo& info)
  : ObjectWrap(info), env(info.Env()) {

  // Check for options (second argument)
  if (info.Length() > 1 && info[1].IsObject()) {
    auto options = info[1].As<Napi::Object>();
    if (options.Has("libraries")) {
      auto libsVal = options.Get("libraries");
      if (libsVal.IsArray()) {
        // Array of specific library names
        auto arr = libsVal.As<Napi::Array>();
        std::vector<std::string> libraries;
        libraries.reserve(arr.Length());
        for (uint32_t i = 0; i < arr.Length(); ++i) {
          if (!arr.Get(i).IsString()) {
            Napi::TypeError::New(env, "libraries array must contain only strings").ThrowAsJavaScriptException();
            return;
          }
          libraries.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
        }
        try {
          runtime = std::make_shared<lua_core::LuaRuntime>(libraries);
        } catch (const std::runtime_error& e) {
          Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
          return;
        }
      } else if (libsVal.IsString()) {
        // Preset string: 'all' or 'safe'
        std::string preset = libsVal.As<Napi::String>().Utf8Value();
        if (preset == "all") {
          runtime = std::make_shared<lua_core::LuaRuntime>(lua_core::LuaRuntime::AllLibraries());
        } else if (preset == "safe") {
          runtime = std::make_shared<lua_core::LuaRuntime>(lua_core::LuaRuntime::SafeLibraries());
        } else {
          Napi::TypeError::New(env, "libraries must be 'all', 'safe', or an array of library names").ThrowAsJavaScriptException();
          return;
        }
      } else {
        Napi::TypeError::New(env, "libraries must be 'all', 'safe', or an array of library names").ThrowAsJavaScriptException();
        return;
      }
    } else {
      // options present but no libraries field -> bare state
      runtime = std::make_shared<lua_core::LuaRuntime>();
    }
  } else {
    // No options at all -> bare state
    runtime = std::make_shared<lua_core::LuaRuntime>();
  }

  // Set up userdata GC callback
  runtime->SetUserdataGCCallback([this](int ref_id) {
    js_userdata_.erase(ref_id);
  });

  // Set up property handlers for proxy userdata
  runtime->SetPropertyHandlers(
    // Getter (__index)
    [this](int ref_id, const std::string& key) -> lua_core::LuaPtr {
      auto it = js_userdata_.find(ref_id);
      if (it == js_userdata_.end()) {
        return std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::nil());
      }
      if (!it->second.readable) {
        throw std::runtime_error("userdata is not readable");
      }
      Napi::Value val = it->second.object.Value().Get(key);
      return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val));
    },
    // Setter (__newindex)
    [this](int ref_id, const std::string& key, const lua_core::LuaPtr& value) {
      auto it = js_userdata_.find(ref_id);
      if (it == js_userdata_.end()) return;
      if (!it->second.writable) {
        throw std::runtime_error("userdata is not writable");
      }
      it->second.object.Value().Set(key, CoreToNapi(*value));
    }
  );

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
      runtime->RegisterFunction(key_str, CreateJsCallbackWrapper(key_str));
    } else {
      try {
        runtime->SetGlobal(key_str, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val)));
      } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return;
      }
    }
  }
}

Napi::Value LuaContext::SetGlobal(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string name as first argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  if (const Napi::Value value = info[1]; value.IsFunction()) {
    js_callbacks[name] = Napi::Persistent(value.As<Napi::Function>());
    runtime->RegisterFunction(name, CreateJsCallbackWrapper(name));
  } else {
    try {
      runtime->SetGlobal(name, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value)));
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  return env.Undefined();
}

Napi::Value LuaContext::GetGlobal(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string name as first argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();
  auto result = runtime->GetGlobal(name);
  return CoreToNapi(*result);
}

Napi::Value LuaContext::SetUserdata(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "Expected (string, object[, options])").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  bool readable = false;
  bool writable = false;

  if (info.Length() >= 3 && info[2].IsObject()) {
    auto options = info[2].As<Napi::Object>();
    if (options.Has("readable") && options.Get("readable").IsBoolean()) {
      readable = options.Get("readable").As<Napi::Boolean>().Value();
    }
    if (options.Has("writable") && options.Get("writable").IsBoolean()) {
      writable = options.Get("writable").As<Napi::Boolean>().Value();
    }
  }

  int ref_id = next_userdata_id_++;

  UserdataEntry entry;
  entry.object = Napi::Persistent(info[1].As<Napi::Object>());
  entry.readable = readable;
  entry.writable = writable;
  js_userdata_[ref_id] = std::move(entry);

  if (readable || writable) {
    runtime->CreateProxyUserdataGlobal(name, ref_id);
  } else {
    runtime->CreateUserdataGlobal(name, ref_id);
  }

  return env.Undefined();
}

Napi::Value LuaContext::SetMetatable(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "Expected (string, object)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();
  const auto mt = info[1].As<Napi::Object>();
  const Napi::Array keys = mt.GetPropertyNames();

  int mt_id = next_metatable_id_++;
  std::vector<lua_core::MetatableEntry> entries;

  for (uint32_t i = 0; i < keys.Length(); i++) {
    const std::string key = keys[i].As<Napi::String>().Utf8Value();
    const Napi::Value val = mt.Get(key);

    lua_core::MetatableEntry entry;
    entry.key = key;

    if (val.IsFunction()) {
      const std::string func_name = "__mt_" + std::to_string(mt_id) + "_" + key;
      js_callbacks[func_name] = Napi::Persistent(val.As<Napi::Function>());
      runtime->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
      entry.is_function = true;
      entry.func_name = func_name;
    } else {
      entry.is_function = false;
      try {
        entry.value = std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val));
      } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Undefined();
      }
    }

    entries.push_back(std::move(entry));
  }

  try {
    runtime->SetGlobalMetatable(name, entries);
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return env.Undefined();
}

Napi::Value LuaContext::AddSearchPath(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string path = info[0].As<Napi::String>().Utf8Value();

  if (path.find('?') == std::string::npos) {
    Napi::Error::New(env,
      "Search path must contain a '?' placeholder (e.g., './modules/?.lua')").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    runtime->AddSearchPath(path);
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return env.Undefined();
}

Napi::Value LuaContext::RegisterModule(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "Expected (string, object)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();
  const auto moduleObj = info[1].As<Napi::Object>();
  const Napi::Array keys = moduleObj.GetPropertyNames();

  int mod_id = next_module_id_++;
  std::vector<lua_core::MetatableEntry> entries;

  for (uint32_t i = 0; i < keys.Length(); i++) {
    const std::string key = keys[i].As<Napi::String>().Utf8Value();
    const Napi::Value val = moduleObj.Get(key);

    lua_core::MetatableEntry entry;
    entry.key = key;

    if (val.IsFunction()) {
      const std::string func_name = "__module_" + std::to_string(mod_id) + "_" + key;
      js_callbacks[func_name] = Napi::Persistent(val.As<Napi::Function>());
      runtime->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
      entry.is_function = true;
      entry.func_name = func_name;
    } else {
      entry.is_function = false;
      try {
        entry.value = std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val));
      } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Undefined();
      }
    }

    entries.push_back(std::move(entry));
  }

  try {
    runtime->RegisterModuleTable(name, entries);
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return env.Undefined();
}

Napi::Value LuaContext::Compile(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string script = info[0].As<Napi::String>().Utf8Value();

  bool strip_debug = false;
  std::string chunk_name;
  if (info.Length() >= 2 && info[1].IsObject()) {
    auto options = info[1].As<Napi::Object>();
    if (options.Has("stripDebug") && options.Get("stripDebug").IsBoolean()) {
      strip_debug = options.Get("stripDebug").As<Napi::Boolean>().Value();
    }
    if (options.Has("chunkName") && options.Get("chunkName").IsString()) {
      chunk_name = options.Get("chunkName").As<Napi::String>().Utf8Value();
    }
  }

  const auto result = runtime->CompileScript(script, strip_debug, chunk_name);

  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env, std::get<std::string>(result)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& bytecode = std::get<std::vector<uint8_t>>(result);
  return Napi::Buffer<uint8_t>::Copy(env, bytecode.data(), bytecode.size());
}

Napi::Value LuaContext::CompileFile(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string filepath = info[0].As<Napi::String>().Utf8Value();

  bool strip_debug = false;
  if (info.Length() >= 2 && info[1].IsObject()) {
    auto options = info[1].As<Napi::Object>();
    if (options.Has("stripDebug") && options.Get("stripDebug").IsBoolean()) {
      strip_debug = options.Get("stripDebug").As<Napi::Boolean>().Value();
    }
  }

  const auto result = runtime->CompileFile(filepath, strip_debug);

  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env, std::get<std::string>(result)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& bytecode = std::get<std::vector<uint8_t>>(result);
  return Napi::Buffer<uint8_t>::Copy(env, bytecode.data(), bytecode.size());
}

Napi::Value LuaContext::LoadBytecode(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Expected Buffer argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
  std::vector<uint8_t> bytecode(buffer.Data(), buffer.Data() + buffer.Length());

  std::string chunk_name = "bytecode";
  if (info.Length() >= 2 && info[1].IsString()) {
    chunk_name = info[1].As<Napi::String>().Utf8Value();
  }

  const auto res = runtime->LoadBytecode(bytecode, chunk_name);

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

LuaContext::~LuaContext() {
  // Clear callbacks to prevent accessing member state during lua_close()
  if (runtime) {
    runtime->SetUserdataGCCallback(nullptr);
    runtime->SetPropertyHandlers(nullptr, nullptr);
  }
}

lua_core::LuaRuntime::Function LuaContext::CreateJsCallbackWrapper(const std::string& name) {
  return [this, name](const std::vector<lua_core::LuaPtr>& args) -> lua_core::LuaPtr {
    std::vector<napi_value> jsArgs;
    jsArgs.reserve(args.size());
    for (const auto& a : args) {
      jsArgs.push_back(CoreToNapi(*a));
    }
    try {
      const Napi::Value result = js_callbacks[name].Call(jsArgs);
      return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(result));
    } catch (const Napi::Error& e) {
      throw std::runtime_error(e.Message());
    }
  };
}

Napi::Value LuaContext::ExecuteScript(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
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

Napi::Value LuaContext::ExecuteFile(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string filepath = info[0].As<Napi::String>().Utf8Value();

  const auto res = runtime->ExecuteFile(filepath);
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

void LuaContext::ClearBusy() {
  is_busy_ = false;
}

Napi::Value LuaContext::IsBusyMethod(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(env, is_busy_);
}

Napi::Value LuaContext::ExecuteScriptAsync(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string script = info[0].As<Napi::String>().Utf8Value();
  is_busy_ = true;

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new LuaScriptAsyncWorker(runtime, script, this, deferred);
  worker->Queue();
  return deferred.Promise();
}

Napi::Value LuaContext::ExecuteFileAsync(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string filepath = info[0].As<Napi::String>().Utf8Value();
  is_busy_ = true;

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new LuaFileAsyncWorker(runtime, filepath, this, deferred);
  worker->Queue();
  return deferred.Promise();
}

// --- AsyncWorker OnOK/OnError implementations ---

void LuaScriptAsyncWorker::OnOK() {
  Napi::Env env = Env();
  context_->ClearBusy();

  if (std::holds_alternative<std::string>(result_)) {
    deferred_.Reject(Napi::Error::New(env, std::get<std::string>(result_)).Value());
    return;
  }

  const auto& values = std::get<std::vector<lua_core::LuaPtr>>(result_);
  if (values.empty()) {
    deferred_.Resolve(env.Undefined());
  } else if (values.size() == 1) {
    deferred_.Resolve(context_->CoreToNapi(*values[0]));
  } else {
    Napi::Array array = Napi::Array::New(env, values.size());
    for (size_t i = 0; i < values.size(); ++i) {
      array.Set(i, context_->CoreToNapi(*values[i]));
    }
    deferred_.Resolve(array);
  }
}

void LuaScriptAsyncWorker::OnError(const Napi::Error& error) {
  context_->ClearBusy();
  deferred_.Reject(error.Value());
}

void LuaFileAsyncWorker::OnOK() {
  Napi::Env env = Env();
  context_->ClearBusy();

  if (std::holds_alternative<std::string>(result_)) {
    deferred_.Reject(Napi::Error::New(env, std::get<std::string>(result_)).Value());
    return;
  }

  const auto& values = std::get<std::vector<lua_core::LuaPtr>>(result_);
  if (values.empty()) {
    deferred_.Resolve(env.Undefined());
  } else if (values.size() == 1) {
    deferred_.Resolve(context_->CoreToNapi(*values[0]));
  } else {
    Napi::Array array = Napi::Array::New(env, values.size());
    for (size_t i = 0; i < values.size(); ++i) {
      array.Set(i, context_->CoreToNapi(*values[i]));
    }
    deferred_.Resolve(array);
  }
}

void LuaFileAsyncWorker::OnError(const Napi::Error& error) {
  context_->ClearBusy();
  deferred_.Reject(error.Value());
}

Napi::Object InitModule(const Napi::Env env, const Napi::Object exports) {
  const auto result = LuaContext::Init(env, exports);
  env.SetInstanceData<Napi::FunctionReference>(
    new Napi::FunctionReference(Napi::Persistent(exports.Get("init").As<Napi::Function>())));
  return result;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, InitModule)

lua_core::LuaValue LuaContext::NapiToCoreInstance(const Napi::Value& value, int depth) {
  if (depth > lua_core::LuaRuntime::kMaxDepth) {
    throw std::runtime_error("Value nesting depth exceeds the maximum of "
      + std::to_string(lua_core::LuaRuntime::kMaxDepth) + " levels");
  }

  if (value.IsFunction()) {
    const std::string name = "__js_callback_" + std::to_string(js_callbacks.size());
    js_callbacks[name] = Napi::Persistent(value.As<Napi::Function>());
    runtime->RegisterFunction(name, CreateJsCallbackWrapper(name));
    // For JS functions passed to Lua, they become globals and we return their name
    return lua_core::LuaValue::from(name);
  }

  const napi_valuetype type = value.Type();
  if (type == napi_undefined || type == napi_null) {
    return lua_core::LuaValue::nil();
  }
  if (type == napi_boolean) {
    return lua_core::LuaValue::from(value.As<Napi::Boolean>().Value());
  }
  if (type == napi_number) {
    const double num = value.As<Napi::Number>().DoubleValue();
    if (std::isfinite(num) && num >= static_cast<double>(std::numeric_limits<int64_t>::min()) &&
        num <= static_cast<double>(std::numeric_limits<int64_t>::max())) {
      double intpart;
      if (std::modf(num, &intpart) == 0.0) {
        return lua_core::LuaValue::from(static_cast<int64_t>(num));
      }
    }
    return lua_core::LuaValue::from(num);
  }
  if (type == napi_string) {
    return lua_core::LuaValue::from(value.As<Napi::String>().Utf8Value());
  }

  if (type == napi_object) {
    if (value.IsObject()) {
      auto obj = value.As<Napi::Object>();

      // Check if it's a LuaTableRef Proxy (metatabled table round-tripping through JS)
      if (obj.Has("_tableRef") && obj.Get("_tableRef").IsExternal()) {
        auto* data = obj.Get("_tableRef").As<Napi::External<LuaTableRefData>>().Data();
        if (data) {
          return lua_core::LuaValue::from(
            lua_core::LuaTableRef(data->tableRef.ref, data->tableRef.L));
        }
      }

      // Check if it's an opaque userdata handle (Lua-created, round-tripping through JS)
      if (obj.Has("_userdata") && obj.Get("_userdata").IsExternal()) {
        auto* data = obj.Get("_userdata").As<Napi::External<LuaUserdataData>>().Data();
        if (data) {
          return lua_core::LuaValue::from(lua_core::LuaUserdataRef(
            data->userdataRef.ref_id, data->userdataRef.L,
            data->userdataRef.opaque, data->userdataRef.registry_ref,
            data->userdataRef.proxy));
        }
      }
    }

    if (value.IsArray()) {
      const auto arr = value.As<Napi::Array>();
      lua_core::LuaArray coreArr;
      coreArr.reserve(arr.Length());
      for (uint32_t i = 0; i < arr.Length(); ++i) {
        coreArr.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arr.Get(i), depth + 1)));
      }
      return lua_core::LuaValue::from(std::move(coreArr));
    }
    const auto obj = value.As<Napi::Object>();
    Napi::Array keys = obj.GetPropertyNames();
    lua_core::LuaTable tbl;
    for (uint32_t i = 0; i < keys.Length(); i++) {
      Napi::Value key = keys[i];
      std::string keyStr = key.ToString().Utf8Value();
      tbl.emplace(std::move(keyStr), std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(obj.Get(key), depth + 1)));
    }
    return lua_core::LuaValue::from(std::move(tbl));
  }

  return lua_core::LuaValue::nil();
}

lua_core::LuaValue LuaContext::NapiToCore(const Napi::Value& value, int depth) {
  if (depth > lua_core::LuaRuntime::kMaxDepth) {
    throw std::runtime_error("Value nesting depth exceeds the maximum of "
      + std::to_string(lua_core::LuaRuntime::kMaxDepth) + " levels");
  }

  const napi_valuetype type = value.Type();
  if (type == napi_undefined || type == napi_null) {
    return lua_core::LuaValue::nil();
  }
  if (type == napi_boolean) {
    return lua_core::LuaValue::from(value.As<Napi::Boolean>().Value());
  }
  if (type == napi_number) {
    const double num = value.As<Napi::Number>().DoubleValue();
    if (std::isfinite(num) && num >= static_cast<double>(std::numeric_limits<int64_t>::min()) &&
        num <= static_cast<double>(std::numeric_limits<int64_t>::max())) {
      double intpart;
      if (std::modf(num, &intpart) == 0.0) {
        return lua_core::LuaValue::from(static_cast<int64_t>(num));
      }
    }
    return lua_core::LuaValue::from(num);
  }
  if (type == napi_string) {
    return lua_core::LuaValue::from(value.As<Napi::String>().Utf8Value());
  }

  if (type == napi_object) {
    if (value.IsArray()) {
      const auto arr = value.As<Napi::Array>();
      lua_core::LuaArray coreArr;
      coreArr.reserve(arr.Length());
      for (uint32_t i = 0; i < arr.Length(); ++i) {
        coreArr.push_back(std::make_shared<lua_core::LuaValue>(NapiToCore(arr.Get(i), depth + 1)));
      }
      return lua_core::LuaValue::from(std::move(coreArr));
    }
    const auto obj = value.As<Napi::Object>();
    Napi::Array keys = obj.GetPropertyNames();
    lua_core::LuaTable tbl;
    for (uint32_t i = 0; i < keys.Length(); i++) {
      Napi::Value key = keys[i];
      std::string keyStr = key.ToString().Utf8Value();
      tbl.emplace(std::move(keyStr), std::make_shared<lua_core::LuaValue>(NapiToCore(obj.Get(key), depth + 1)));
    }
    return lua_core::LuaValue::from(std::move(tbl));
  }

  return lua_core::LuaValue::nil();
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
        } else if constexpr (std::is_same_v<T, lua_core::LuaFunctionRef>) {
          auto data = std::make_unique<LuaFunctionData>(runtime, v, this);
          auto* dataPtr = data.get();
          lua_function_data_.push_back(std::move(data));
          return Napi::Function::New(env, LuaFunctionCallbackStatic, "luaFunction", dataPtr);
        } else if constexpr (std::is_same_v<T, lua_core::LuaThreadRef>) {
          // Return a coroutine object with the thread reference
          auto data = std::make_unique<LuaThreadData>(runtime, v);
          auto* dataPtr = data.get();
          lua_thread_data_.push_back(std::move(data));
          Napi::Object coro = Napi::Object::New(env);
          coro.Set("_coroutine", Napi::External<LuaThreadData>::New(env, dataPtr));
          lua_core::CoroutineStatus status = runtime->GetCoroutineStatus(v);
          coro.Set("status", Napi::String::New(env,
            status == lua_core::CoroutineStatus::Suspended ? "suspended" :
            status == lua_core::CoroutineStatus::Running ? "running" : "dead"));
          return coro;
        } else if constexpr (std::is_same_v<T, lua_core::LuaUserdataRef>) {
          if (!v.opaque) {
            // JS-created userdata - return the original JS object
            auto it = js_userdata_.find(v.ref_id);
            if (it != js_userdata_.end()) {
              return it->second.object.Value();
            }
            return env.Null();
          } else {
            // Lua-created userdata - wrap as opaque handle for round-trip
            auto data = std::make_unique<LuaUserdataData>(runtime, v);
            auto* dataPtr = data.get();
            lua_userdata_data_.push_back(std::move(data));
            Napi::Object handle = Napi::Object::New(env);
            handle.Set("_userdata", Napi::External<LuaUserdataData>::New(env, dataPtr));
            return handle;
          }
        } else if constexpr (std::is_same_v<T, lua_core::LuaTableRef>) {
          // Create a JS Proxy that preserves Lua metamethods
          Napi::Object target = Napi::Object::New(env);

          // Store data for traps
          auto data = std::make_unique<LuaTableRefData>(runtime, v, this);
          auto* dataPtr = data.get();
          lua_table_ref_data_.push_back(std::move(data));

          // Store _tableRef as non-enumerable on target for round-trip detection
          auto external = Napi::External<LuaTableRefData>::New(env, dataPtr);
          auto Object = env.Global().Get("Object").As<Napi::Object>();
          auto defineProperty = Object.Get("defineProperty").As<Napi::Function>();
          Napi::Object descriptor = Napi::Object::New(env);
          descriptor.Set("value", external);
          descriptor.Set("enumerable", Napi::Boolean::New(env, false));
          descriptor.Set("configurable", Napi::Boolean::New(env, true));
          defineProperty.Call({target, Napi::String::New(env, "_tableRef"), descriptor});

          // Create handler with traps
          Napi::Object handler = Napi::Object::New(env);
          handler.Set("get", Napi::Function::New(env, TableRefGetTrap, "get", dataPtr));
          handler.Set("set", Napi::Function::New(env, TableRefSetTrap, "set", dataPtr));
          handler.Set("has", Napi::Function::New(env, TableRefHasTrap, "has", dataPtr));
          handler.Set("ownKeys", Napi::Function::New(env, TableRefOwnKeysTrap, "ownKeys", dataPtr));
          handler.Set("getOwnPropertyDescriptor",
            Napi::Function::New(env, TableRefGetOwnPropertyDescriptorTrap,
                                "getOwnPropertyDescriptor", dataPtr));

          // Create Proxy
          auto ProxyCtor = env.Global().Get("Proxy").As<Napi::Function>();
          return ProxyCtor.New({target, handler});
        }
        return env.Undefined();
      },
      value.value);
}

Napi::Value LuaContext::CreateCoroutine(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected a script string that returns a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Execute script and get function
  const std::string script = info[0].As<Napi::String>().Utf8Value();
  const auto res = runtime->ExecuteScript(script);
  if (std::holds_alternative<std::string>(res)) {
    Napi::Error::New(env, std::get<std::string>(res)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& values = std::get<std::vector<lua_core::LuaPtr>>(res);
  if (values.empty() || !std::holds_alternative<lua_core::LuaFunctionRef>(values[0]->value)) {
    Napi::TypeError::New(env, "Script must return a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& funcRef = std::get<lua_core::LuaFunctionRef>(values[0]->value);
  auto result = runtime->CreateCoroutine(funcRef);
  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env, std::get<std::string>(result)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& threadRef = std::get<lua_core::LuaThreadRef>(result);
  auto threadData = std::make_unique<LuaThreadData>(runtime, threadRef);
  auto* threadDataPtr = threadData.get();
  lua_thread_data_.push_back(std::move(threadData));

  Napi::Object coro = Napi::Object::New(env);
  coro.Set("_coroutine", Napi::External<LuaThreadData>::New(env, threadDataPtr));
  coro.Set("status", Napi::String::New(env, "suspended"));
  return coro;
}

Napi::Value LuaContext::ResumeCoroutine(const Napi::CallbackInfo& info) {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Expected a coroutine object as first argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object coroObj = info[0].As<Napi::Object>();
  if (!coroObj.Has("_coroutine")) {
    Napi::TypeError::New(env, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Value externalVal = coroObj.Get("_coroutine");
  if (!externalVal.IsExternal()) {
    Napi::TypeError::New(env, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* threadData = externalVal.As<Napi::External<LuaThreadData>>().Data();
  if (!threadData || !threadData->runtime) {
    Napi::Error::New(env, "Invalid coroutine reference").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Collect arguments (skip the first one which is the coroutine object)
  std::vector<lua_core::LuaPtr> args;
  try {
    for (size_t i = 1; i < info.Length(); ++i) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[i])));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Resume the coroutine
  lua_core::CoroutineResult result = runtime->ResumeCoroutine(threadData->threadRef, args);

  // Build the result object
  Napi::Object resultObj = Napi::Object::New(env);

  // Set status
  std::string statusStr;
  switch (result.status) {
    case lua_core::CoroutineStatus::Suspended:
      statusStr = "suspended";
      break;
    case lua_core::CoroutineStatus::Running:
      statusStr = "running";
      break;
    case lua_core::CoroutineStatus::Dead:
      statusStr = "dead";
      break;
  }
  resultObj.Set("status", Napi::String::New(env, statusStr));

  // Update the coroutine object's status too
  coroObj.Set("status", Napi::String::New(env, statusStr));

  // Set values
  Napi::Array valuesArr = Napi::Array::New(env, result.values.size());
  for (size_t i = 0; i < result.values.size(); ++i) {
    valuesArr.Set(i, CoreToNapi(*result.values[i]));
  }
  resultObj.Set("values", valuesArr);

  // Set error if present
  if (result.error.has_value()) {
    resultObj.Set("error", Napi::String::New(env, result.error.value()));
  }

  return resultObj;
}
