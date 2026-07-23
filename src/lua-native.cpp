#include "lua-native.h"
#include "lua-async-worker.h"

#include <cmath>
#include <limits>
#include <optional>
#include <functional>

// --- Built-in JS type conversion helpers (JS -> Lua) ---

// Defines a non-enumerable, non-configurable marker property on an object.
// `configurable: false` blocks `delete obj[key]`, which for a lifetime-owner
// property (an External whose finalizer frees a *Data still referenced by a
// bound C function) would otherwise let JS free the data out from under the
// binding — `delete fn.__luaFnOwner; gc(); fn()` (L6). When `writable` is false
// the value also can't be reassigned (closing the `fn.__luaFnOwner = null`
// vector); pass `writable = true` for identity markers that may be re-tagged
// (e.g. a construct() that returns a pooled object gets a fresh __luaClassRef).
static void DefineHiddenProp(const Napi::Env env, Napi::Object obj,
                             const char* key, const Napi::Value value,
                             const bool writable = true) {
  const auto Object = env.Global().Get("Object").As<Napi::Object>();
  const auto defineProperty = Object.Get("defineProperty").As<Napi::Function>();
  Napi::Object desc = Napi::Object::New(env);
  (void)desc.Set("value", value);
  (void)desc.Set("enumerable", Napi::Boolean::New(env, false));
  (void)desc.Set("configurable", Napi::Boolean::New(env, false));
  (void)desc.Set("writable", Napi::Boolean::New(env, writable));
  defineProperty.Call({obj, Napi::String::New(env, key), desc});
}

// True when `value` is an instance of the named global constructor
// (e.g. "Map", "Set", "RegExp"). Robust against subclassing.
static bool IsInstanceOfGlobal(const Napi::Value& value, const char* ctorName) {
  const Napi::Env env = value.Env();
  const Napi::Value ctor = env.Global().Get(ctorName);
  if (!ctor.IsFunction()) return false;
  bool result = false;
  napi_instanceof(env, value, ctor, &result);
  return result;
}

// Copies the raw bytes of a Buffer/TypedArray/ArrayBuffer into a std::string
// (binary-safe). Guards zero-length views to avoid constructing from nullptr.
static std::string BinaryBytesToString(const Napi::Value& value) {
  if (value.IsBuffer()) {
    const auto buf = value.As<Napi::Buffer<char>>();
    return buf.Length() ? std::string(buf.Data(), buf.Length()) : std::string();
  }
  if (value.IsTypedArray()) {
    const auto ta = value.As<Napi::TypedArray>();
    auto ab = ta.ArrayBuffer();
    const size_t len = ta.ByteLength();
    const auto base = static_cast<const char*>(ab.Data());
    return len ? std::string(base + ta.ByteOffset(), len) : std::string();
  }
  auto ab = value.As<Napi::ArrayBuffer>();
  const size_t len = ab.ByteLength();
  return len ? std::string(static_cast<const char*>(ab.Data()), len) : std::string();
}

// Converts common JS built-in reference types to LuaValue. Returns nullopt if
// `value` is not one of the handled types. `recurse` converts nested values
// (Map values, Set elements) through the caller's conversion path so that
// markers/converters continue to apply.
static std::optional<lua_core::LuaValue> ConvertBuiltinType(
    const Napi::Value& value, int depth,
    const std::function<lua_core::LuaValue(const Napi::Value&, int)>& recurse) {
  const Napi::Env env = value.Env();

  // Binary data -> binary-safe Lua string (Buffer is also a TypedArray, so it
  // must be checked first, but BinaryBytesToString handles the ordering).
  if (value.IsBuffer() || value.IsTypedArray() || value.IsArrayBuffer()) {
    return lua_core::LuaValue::from(BinaryBytesToString(value));
  }

  // Date -> epoch milliseconds (double)
  if (value.IsDate()) {
    return lua_core::LuaValue::from(value.As<Napi::Date>().ValueOf());
  }

  // Map -> Lua table. Keys are stringified, matching plain-object behavior.
  if (IsInstanceOfGlobal(value, "Map")) {
    const auto arrayFrom =
      env.Global().Get("Array").As<Napi::Object>().Get("from").As<Napi::Function>();
    const auto entries = arrayFrom.Call({value}).As<Napi::Array>();
    lua_core::LuaTable tbl;
    for (uint32_t i = 0; i < entries.Length(); ++i) {
      auto pair = entries.Get(i).As<Napi::Array>();
      std::string k = pair.Get(static_cast<uint32_t>(0)).ToString().Utf8Value();
      tbl.emplace(std::move(k), std::make_shared<lua_core::LuaValue>(
        recurse(pair.Get(static_cast<uint32_t>(1)), depth + 1)));
    }
    return lua_core::LuaValue::from(std::move(tbl));
  }

  // Set -> Lua array
  if (IsInstanceOfGlobal(value, "Set")) {
    const auto arrayFrom =
      env.Global().Get("Array").As<Napi::Object>().Get("from").As<Napi::Function>();
    const auto vals = arrayFrom.Call({value}).As<Napi::Array>();
    lua_core::LuaArray arr;
    arr.reserve(vals.Length());
    for (uint32_t i = 0; i < vals.Length(); ++i) {
      arr.push_back(std::make_shared<lua_core::LuaValue>(recurse(vals.Get(i), depth + 1)));
    }
    return lua_core::LuaValue::from(std::move(arr));
  }

  // RegExp -> its source pattern string (flags are dropped)
  if (IsInstanceOfGlobal(value, "RegExp")) {
    return lua_core::LuaValue::from(
      value.As<Napi::Object>().Get("source").ToString().Utf8Value());
  }

  return std::nullopt;
}

// --- Proxy trap functions for LuaTableRef ---

// Guards every table-ref trap and handle method. Throws (and returns true) if
// the handle can't be safely used right now, for either reason:
//  - the backing LuaContext has been destroyed (a retained handle outliving it);
//  - any async op is in flight. Checking the context's is_busy_ (set
//    synchronously before a worker Queue() or an execute_async begins) closes
//    the Queue()-to-async_mode_ window and also blocks reentry during a
//    suspended execute_async, which a runtime->IsAsyncMode() check would miss.
static bool RejectIfWorkerBusy(Napi::Env env, LuaTableRefData* data) {
  if (!data || !data->ContextLive() || !data->context) {
    Napi::Error::New(env, "Lua table handle's context has been destroyed")
      .ThrowAsJavaScriptException();
    return true;
  }
  if (data->context->IsBusy()) {
    Napi::Error::New(env, "Lua context is busy with an async operation")
      .ThrowAsJavaScriptException();
    return true;
  }
  return false;
}

static Napi::Value TableRefGetTrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

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

  // A Proxy released via lua.release() must fail clearly instead of indexing
  // registry slot LUA_NOREF (nil), matching the table-handle methods.
  if (data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // A __index metamethod reached here can call a JS host function that throws,
    // which stages a js_error_registry_ entry. This trap raises a plain string
    // (the structured value is stringified by ProtectedTableCall), so nothing
    // consumes that entry by id. The CallScope clears the registry at the
    // outermost access so such entries can't accumulate across trap calls (L7).
    LuaContext::CallScope scope(data->context);
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
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

  auto prop = info[1];
  auto value = info[2];

  if (!prop.IsString()) return Napi::Boolean::New(env, true);

  std::string key = prop.As<Napi::String>().Utf8Value();

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, true);
  }

  try {
    // See TableRefGetTrap: clear the registry at the outermost access so a
    // staged entry from a raising __newindex host callback can't accumulate (L7).
    LuaContext::CallScope scope(data->context);
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
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

  auto prop = info[1];

  if (!prop.IsString()) return Napi::Boolean::New(env, false);

  std::string key = prop.As<Napi::String>().Utf8Value();

  if (key == "_tableRef") return Napi::Boolean::New(env, true);

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  try {
    // Clear the JS-error registry at the outermost access so a staged entry from
    // a raising __index host callback can't accumulate (L3, mirrors get/set).
    LuaContext::CallScope scope(data->context);
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
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return Napi::Array::New(env, 0);
  }

  try {
    LuaContext::CallScope scope(data->context);
    auto keys = data->runtime->GetTableKeys(data->tableRef.ref);
    Napi::Array arr = Napi::Array::New(env, keys.size());
    for (size_t i = 0; i < keys.size(); i++) {
      (void)arr.Set(static_cast<uint32_t>(i), Napi::String::New(env, keys[i]));
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
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

  auto prop = info[1];

  if (!prop.IsString()) return env.Undefined();

  std::string key = prop.As<Napi::String>().Utf8Value();

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    LuaContext::CallScope scope(data->context);
    if (data->runtime->HasTableField(data->tableRef.ref, key)) {
      auto value = data->runtime->GetTableField(data->tableRef.ref, key);
      Napi::Object desc = Napi::Object::New(env);
      (void)desc.Set("configurable", Napi::Boolean::New(env, true));
      (void)desc.Set("enumerable", Napi::Boolean::New(env, true));
      (void)desc.Set("value", data->context->CoreToNapi(*value));
      return desc;
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

// --- Table handle method functions ---

// Builds an explicitly-typed Lua table key from a LuaTableHandle argument. A JS
// number becomes an integer key when its value is integral and in int64 range
// (so `handle.get(1)` reaches the array part) and a float key otherwise (so
// `handle.get(1.5)` is no longer truncated to key 1). A JS string becomes a
// string key verbatim — never coerced to an integer — so a genuine string key
// like "123" is reachable and distinct from integer key 123. Returns false for
// any other JS type so the caller can raise its own TypeError.
static bool NapiToTableKey(const Napi::Value& value, lua_core::TableKey& out) {
  if (value.IsNumber()) {
    const double d = value.As<Napi::Number>().DoubleValue();
    if (std::isfinite(d) && d == std::trunc(d) &&
        d >= -9223372036854775808.0 && d < 9223372036854775808.0) {
      out = static_cast<int64_t>(d);
    } else {
      out = d;
    }
    return true;
  }
  if (value.IsString()) {
    out = value.As<Napi::String>().Utf8Value();
    return true;
  }
  return false;
}

static Napi::Value TableHandleGet(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "get() requires a key argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    Napi::TypeError::New(env, "get() key must be a string or number").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // Metamethod-capable operation: scope under a CallScope so a staged
    // js_error_registry_ entry from a raising __index host callback is cleared
    // at the next outermost access instead of accumulating (CR-8 F5 — the
    // L7/L3 discipline the Proxy traps already follow, applied to the handle
    // surface).
    LuaContext::CallScope scope(data->context);
    auto result = data->runtime->GetTableFieldKeyed(data->tableRef.ref, key);
    return data->context->CoreToNapi(*result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

static Napi::Value TableHandleSet(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "set() requires key and value arguments").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    Napi::TypeError::New(env, "set() key must be a string or number").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // See TableHandleGet: CallScope so a raising __newindex host callback's
    // staged entry can't accumulate (CR-8 F5).
    LuaContext::CallScope scope(data->context);
    auto value = std::make_shared<lua_core::LuaValue>(
      data->context->NapiToCoreInstance(info[1]));
    data->runtime->SetTableFieldKeyed(data->tableRef.ref, key, value);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

static Napi::Value TableHandleHas(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "has() requires a key argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    Napi::TypeError::New(env, "has() key must be a string or number").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // See TableHandleGet: CallScope for the metamethod-capable probe (CR-8 F5).
    LuaContext::CallScope scope(data->context);
    bool exists = data->runtime->HasTableFieldKeyed(data->tableRef.ref, key);
    return Napi::Boolean::New(env, exists);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
}

static Napi::Value TableHandleLength(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // See TableHandleGet: CallScope — __len can reach a raising host callback
    // (CR-8 F5).
    LuaContext::CallScope scope(data->context);
    int64_t len = data->runtime->GetTableLength(data->tableRef.ref);
    return Napi::Number::New(env, static_cast<double>(len));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

static Napi::Value TableHandlePairs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    auto pairs = data->runtime->TablePairs(data->tableRef.ref);
    Napi::Array result = Napi::Array::New(env, pairs.size());
    for (size_t i = 0; i < pairs.size(); ++i) {
      Napi::Array entry = Napi::Array::New(env, 2);
      (void)entry.Set(static_cast<uint32_t>(0),
                data->context->CoreToNapi(*pairs[i].first));
      (void)entry.Set(static_cast<uint32_t>(1),
                data->context->CoreToNapi(*pairs[i].second));
      (void)result.Set(static_cast<uint32_t>(i), entry);
    }
    return result;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

static Napi::Value TableHandleIPairs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // See TableHandleGet: CallScope — the ipairs collection respects __index
    // (CR-8 F5). pairs() is raw traversal and needs none.
    LuaContext::CallScope scope(data->context);
    auto ipairs = data->runtime->TableIPairs(data->tableRef.ref);
    Napi::Array result = Napi::Array::New(env, ipairs.size());
    for (size_t i = 0; i < ipairs.size(); ++i) {
      Napi::Array entry = Napi::Array::New(env, 2);
      (void)entry.Set(static_cast<uint32_t>(0),
                Napi::Number::New(env, static_cast<double>(ipairs[i].first)));
      (void)entry.Set(static_cast<uint32_t>(1),
                data->context->CoreToNapi(*ipairs[i].second));
      (void)result.Set(static_cast<uint32_t>(i), entry);
    }
    return result;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

static Napi::Value TableHandleRelease(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->tableRef.ref == LUA_NOREF) {
    // Already released — no-op
    return env.Undefined();
  }

  // Drop this handle's share of the registry slot (unref'd iff it was the last
  // owner) and mark the handle released.
  data->tableRef.release();
  return env.Undefined();
}

static Napi::Value LuaFunctionCallbackStatic(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  auto* data = static_cast<LuaFunctionData*>(info.Data());
  if (!data || !data->runtime || !data->context || !data->ContextLive()) {
    Napi::Error::New(env, "Lua function's context has been destroyed")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // A released ref would rawget registry slot LUA_NOREF (nil) and fail with an
  // opaque "attempt to call a nil value" — surface a clear error instead,
  // matching the table-handle behavior.
  if (data->funcRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "Lua function has been released")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Reject reentry while any async op is in flight. Checking the context's
  // is_busy_ (set synchronously before either a worker Queue() or an
  // execute_async begins) closes two gaps that a runtime->IsAsyncMode() check
  // misses: the window between Queue() and the worker setting async_mode_, and a
  // suspended execute_async (which never sets async_mode_ at all).
  if (data->context->IsBusy()) {
    Napi::Error::New(env, "Lua context is busy with an async operation")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Convert JS arguments to Lua values. One collector spans every argument so
  // that a later argument failing to convert sweeps the reclaimable callbacks
  // minted by the earlier ones — each argument's own conversion scope has
  // already closed by then, so it cannot clean up its siblings (F1).
  LuaContext::JsCallbackCollectorScope collector(data->context);
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

  // Call the Lua function. A failed call can also leave arguments unpushed
  // (CallFunction restores the stack if an arg push raises); the collector's
  // destructor sweeps those too.
  LuaContext::CallScope _cs(data->context);
  const auto result = data->runtime->CallFunction(data->funcRef, args);

  // Handle error case
  if (std::holds_alternative<std::string>(result)) {
    data->context->ThrowLuaError(std::get<std::string>(result));
    return env.Undefined();
  }

  // Convert results back to JS (undefined / single value / array)
  return data->context->ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(result));
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
    InstanceMethod("execute_async", &LuaContext::ExecuteAsync),
    InstanceMethod("cancel", &LuaContext::Cancel),
    InstanceMethod("is_busy", &LuaContext::IsBusyMethod),
    InstanceMethod("add_search_path", &LuaContext::AddSearchPath),
    InstanceMethod("register_module", &LuaContext::RegisterModule),
    InstanceMethod("compile", &LuaContext::Compile),
    InstanceMethod("compile_file", &LuaContext::CompileFile),
    InstanceMethod("load_bytecode", &LuaContext::LoadBytecode),
    InstanceMethod("create_table", &LuaContext::CreateTableMethod),
    InstanceMethod("get_global_ref", &LuaContext::GetGlobalRef),
    InstanceMethod("get_memory_usage", &LuaContext::GetMemoryUsage),
    InstanceMethod("register_type_converter", &LuaContext::RegisterTypeConverter),
    InstanceMethod("register_class", &LuaContext::RegisterClass),
    InstanceMethod("pcall", &LuaContext::Pcall),
    InstanceMethod("set_print_handler", &LuaContext::SetPrintHandler),
    InstanceMethod("add_searcher", &LuaContext::AddSearcher),
    InstanceMethod("release", &LuaContext::Release)
  });

  // The constructor is kept alive by the persistent reference InitModule stores
  // as instance data (and by `exports` itself), so no separate leaked
  // FunctionReference is needed here.
  (void)exports.Set(Napi::String::New(env, "init"), func);

  return exports;
}

LuaContext::LuaContext(const Napi::CallbackInfo& info)
  : ObjectWrap(info), env(info.Env()) {

  // Check for options (second argument)
  if (info.Length() > 1 && info[1].IsObject()) {
    auto options = info[1].As<Napi::Object>();

    // Check for maxMemory option
    size_t max_memory = 0;
    bool has_max_memory = false;
    if (options.Has("maxMemory")) {
      auto memVal = options.Get("maxMemory");
      if (memVal.IsNumber()) {
        double memNum = memVal.As<Napi::Number>().DoubleValue();
        if (memNum < 0) {
          Napi::RangeError::New(env, "maxMemory must be a non-negative number").ThrowAsJavaScriptException();
          return;
        }
        max_memory = static_cast<size_t>(memNum);
        has_max_memory = true;
      } else if (!memVal.IsUndefined() && !memVal.IsNull()) {
        Napi::TypeError::New(env, "maxMemory must be a number").ThrowAsJavaScriptException();
        return;
      }
    }

    // Check for maxInstructions option (VM instruction execution limit)
    size_t max_instructions = 0;
    bool has_max_instructions = false;
    if (options.Has("maxInstructions")) {
      auto insVal = options.Get("maxInstructions");
      if (insVal.IsNumber()) {
        double insNum = insVal.As<Napi::Number>().DoubleValue();
        if (insNum < 0) {
          Napi::RangeError::New(env, "maxInstructions must be a non-negative number").ThrowAsJavaScriptException();
          return;
        }
        max_instructions = static_cast<size_t>(insNum);
        has_max_instructions = true;
      } else if (!insVal.IsUndefined() && !insVal.IsNull()) {
        Napi::TypeError::New(env, "maxInstructions must be a number").ThrowAsJavaScriptException();
        return;
      }
    }

    // Parse libraries
    std::vector<std::string> libraries;
    bool has_libraries = false;
    if (options.Has("libraries")) {
      auto libsVal = options.Get("libraries");
      if (libsVal.IsArray()) {
        auto arr = libsVal.As<Napi::Array>();
        libraries.reserve(arr.Length());
        for (uint32_t i = 0; i < arr.Length(); ++i) {
          if (!arr.Get(i).IsString()) {
            Napi::TypeError::New(env, "libraries array must contain only strings").ThrowAsJavaScriptException();
            return;
          }
          libraries.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
        }
        has_libraries = true;
      } else if (libsVal.IsString()) {
        std::string preset = libsVal.As<Napi::String>().Utf8Value();
        if (preset == "all") {
          libraries = lua_core::LuaRuntime::AllLibraries();
        } else if (preset == "safe") {
          libraries = lua_core::LuaRuntime::SafeLibraries();
        } else {
          Napi::TypeError::New(env, "libraries must be 'all', 'safe', or an array of library names").ThrowAsJavaScriptException();
          return;
        }
        has_libraries = true;
      } else {
        Napi::TypeError::New(env, "libraries must be 'all', 'safe', or an array of library names").ThrowAsJavaScriptException();
        return;
      }
    }

    // Create runtime with appropriate constructor
    try {
      if (has_max_memory || has_max_instructions) {
        lua_core::RuntimeConfig config;
        config.libraries = std::move(libraries);
        config.max_memory = max_memory;
        config.max_instructions = max_instructions;
        runtime = std::make_shared<lua_core::LuaRuntime>(config);
      } else if (has_libraries) {
        runtime = std::make_shared<lua_core::LuaRuntime>(libraries);
      } else {
        runtime = std::make_shared<lua_core::LuaRuntime>();
      }
    } catch (const std::runtime_error& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return;
    }
  } else {
    // No options at all -> bare state
    runtime = std::make_shared<lua_core::LuaRuntime>();
  }

  // Set up userdata GC callback
  runtime->SetUserdataGCCallback([this](int ref_id) {
    js_userdata_.erase(ref_id);
  });

  // Drop the paired JS reference when an anonymous nested callback's Lua closure
  // is collected, so callback-heavy patterns don't leak js_callbacks_ (M2).
  runtime->SetHostFunctionGCCallback([this](const std::string& name) {
    js_callbacks_.erase(name);
  });

  // Set up property handlers for proxy userdata. Each runs inside a Lua C frame
  // during __index/__newindex; a HandleScope keeps per-access N-API handles from
  // accumulating across a hot property-access loop.
  runtime->SetPropertyHandlers(
    // Getter (__index)
    [this](int ref_id, const std::string& key) -> lua_core::LuaPtr {
      Napi::HandleScope scope(env);
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
      Napi::HandleScope scope(env);
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

  // Apply I/O options after callbacks so the print override wins over any
  // callback-provided print, and after libraries are loaded. SetAllowBytecode
  // and InstallPrintHandler both run protected _G writes that throw on OOM under
  // maxMemory; surface that as a JS error instead of letting a std::runtime_error
  // unwind out of the constructor and terminate the process (the H1 class, CR-6
  // F1). A hostile _G metatable can't be armed before the constructor runs, so
  // only the OOM trigger is reachable here.
  if (info.Length() > 1 && info[1].IsObject()) {
    auto options = info[1].As<Napi::Object>();
    try {
      if (options.Has("allowBytecode") && options.Get("allowBytecode").IsBoolean() &&
          !options.Get("allowBytecode").As<Napi::Boolean>().Value()) {
        runtime->SetAllowBytecode(false);  // E3
      }
      if (options.Has("print") && options.Get("print").IsFunction()) {
        InstallPrintHandler(options.Get("print").As<Napi::Function>());  // E1
      }
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return;
    }
  }
}

void LuaContext::RegisterCallbacks(const Napi::Object& callbacks) {
  Napi::Array keys = callbacks.GetPropertyNames();

  for (uint32_t i = 0; i < keys.Length(); i++) {
    Napi::Value key = keys[i];
    Napi::Value val = callbacks.Get(key);
    std::string key_str = key.ToString();

    try {
      if (val.IsFunction()) {
        // Runtime registration first: if the protected _G write throws, no
        // js_callbacks_/host_functions_ entry is left behind (N5).
        runtime->RegisterFunction(key_str, CreateJsCallbackWrapper(key_str));
        js_callbacks_[key_str] = Napi::Persistent(val.As<Napi::Function>());
      } else {
        runtime->SetGlobal(key_str, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val)));
      }
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return;
    }
  }
}

Napi::Value LuaContext::SetGlobal(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string name as first argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  // Both branches can throw a std::runtime_error (a raising __index/__newindex
  // on a _G metatable now routes through the protected global path), so guard
  // the whole body rather than letting the exception unwind past N-API.
  try {
    if (const Napi::Value value = info[1]; value.IsFunction()) {
      // Runtime registration first: if the protected _G write throws, no
      // js_callbacks_/host_functions_ entry is left behind (N5).
      runtime->RegisterFunction(name, CreateJsCallbackWrapper(name));
      js_callbacks_[name] = Napi::Persistent(value.As<Napi::Function>());
    } else {
      runtime->SetGlobal(name, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value)));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return env.Undefined();
}

Napi::Value LuaContext::GetGlobal(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string name as first argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();
  // GetGlobal can throw (an over-deep table, or a raising __index on a _G
  // metatable via the protected-get path). Surface it as a JS exception rather
  // than letting a std::runtime_error unwind through the N-API boundary.
  try {
    auto result = runtime->GetGlobal(name);
    return CoreToNapi(*result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value LuaContext::SetUserdata(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "Expected (string, object[, options])").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  bool readable = false;
  bool writable = false;
  bool has_methods = false;

  // Temporarily hold method functions until we can register them
  std::vector<std::pair<std::string, Napi::Function>> method_funcs;

  if (info.Length() >= 3 && info[2].IsObject()) {
    auto options = info[2].As<Napi::Object>();
    if (options.Has("readable") && options.Get("readable").IsBoolean()) {
      readable = options.Get("readable").As<Napi::Boolean>().Value();
    }
    if (options.Has("writable") && options.Get("writable").IsBoolean()) {
      writable = options.Get("writable").As<Napi::Boolean>().Value();
    }
    if (options.Has("methods") && options.Get("methods").IsObject()) {
      auto methodsObj = options.Get("methods").As<Napi::Object>();
      Napi::Array methodKeys = methodsObj.GetPropertyNames();
      for (uint32_t i = 0; i < methodKeys.Length(); i++) {
        std::string methodName = methodKeys.Get(i).As<Napi::String>().Utf8Value();
        Napi::Value methodVal = methodsObj.Get(methodName);
        if (methodVal.IsFunction()) {
          method_funcs.emplace_back(methodName, methodVal.As<Napi::Function>());
        }
      }
      has_methods = !method_funcs.empty();
    }
  }

  int ref_id = next_userdata_id_++;

  UserdataEntry entry;
  entry.object = Napi::Persistent(info[1].As<Napi::Object>());
  entry.readable = readable;
  entry.writable = writable;
  js_userdata_[ref_id] = std::move(entry);

  // The core calls below build inside RunProtected, which throws on OOM under
  // maxMemory or a raising __newindex on a _G metatable at the global write.
  // Surface that as a JS error: letting a std::runtime_error unwind across the
  // N-API boundary terminates the process (the H1 class — the same defect F11
  // fixed for register_class, here at its unswept sibling site, CR-6 F1). On
  // failure, roll back the js_userdata_/js_callbacks_/host_functions_ entries
  // registered above so a rejected call strands nothing.
  std::vector<std::string> registered_method_fns;
  bool global_installed = false;
  try {
    bool needs_proxy = readable || writable || has_methods;
    if (needs_proxy) {
      runtime->CreateProxyUserdataGlobal(name, ref_id);
    } else {
      runtime->CreateUserdataGlobal(name, ref_id);
    }
    global_installed = true;

    // Register methods if present
    if (has_methods) {
      std::unordered_map<std::string, std::string> method_map;

      for (auto& [methodName, methodFunc] : method_funcs) {
        std::string func_name = "__ud_method_" + std::to_string(ref_id)
                              + "_" + methodName;

        // Record the name before registering the pair, so the rollback below
        // always sees it — a throw between the two registrations would
        // otherwise strand the js_callbacks_ entry (CR-8 F7). The rollback's
        // erase/RemoveHostFunction are no-ops for a name not yet registered.
        registered_method_fns.push_back(func_name);
        js_callbacks_[func_name] = Napi::Persistent(methodFunc);
        runtime->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
        method_map[methodName] = func_name;
      }

      runtime->SetUserdataMethodTable(ref_id, method_map);
    }
  } catch (const std::exception& e) {
    js_userdata_.erase(ref_id);
    for (const auto& func_name : registered_method_fns) {
      js_callbacks_.erase(func_name);
      runtime->RemoveHostFunction(func_name);
    }
    // If the global write succeeded before a later step failed, remove the
    // installed global too — otherwise the name stays bound to an inert proxy
    // whose js_userdata_ entry was just erased (CR-7 F3). Raw (no __newindex
    // can re-raise) and best-effort: the removal can itself fail under the same
    // OOM, and the inert global is the accepted floor then. Only when this call
    // installed it — a pre-existing same-named global must not be deleted.
    if (global_installed) {
      try { runtime->RemoveGlobalRaw(name); } catch (...) {}
    }
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return env.Undefined();
}

Napi::Value LuaContext::RegisterClass(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env,
      "register_class(name, definition) requires a string name and an object")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string class_name = info[0].As<Napi::String>().Utf8Value();
  auto def = info[1].As<Napi::Object>();

  // Reject a duplicate class name before any callback is registered (L7).
  if (registered_classes_.count(class_name)) {
    Napi::Error::New(env,
      "class '" + class_name + "' is already registered on this context")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Reserve the name *before* reading any property off `def`. Every read below
  // can run user JS (a getter or Proxy trap), and a reentrant
  // register_class(sameName) from one of them would otherwise pass the check
  // above, register fully, and then be half-merged over by this outer call when
  // luaL_newmetatable silently returns the existing metatable — the L7 hazard
  // reached through reentrancy instead of a second top-level call (F5). The
  // guard rolls the reservation back on every failure exit.
  registered_classes_.insert(class_name);
  struct ReservationGuard {
    std::unordered_set<std::string>* set;
    const std::string* name;
    ~ReservationGuard() { if (set) set->erase(*name); }
    void Commit() { set = nullptr; }
  } reservation{&registered_classes_, &class_name};

  // Each property is read exactly once, into a local. A hostile getter/Proxy
  // therefore cannot show validation one value and hand registration another
  // (N3, extended to `construct` by F5) — everything below uses the snapshot.
  const Napi::Value constructVal = def.Get("construct");
  if (!constructVal.IsFunction()) {
    Napi::TypeError::New(env,
      "register_class() definition requires a 'construct' function")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto constructFn = constructVal.As<Napi::Function>();

  // Validate reserved metamethods up front, before anything is registered, so a
  // rejected definition doesn't strand the constructor/method callbacks in
  // js_callbacks_/host_functions_ (L4). The property, its key list, and each
  // value are read exactly once into this snapshot (N3); registration below
  // uses the same snapshot.
  std::vector<std::pair<std::string, Napi::Function>> mm_snapshot;
  {
    const Napi::Value mmsVal = def.Get("metamethods");
    if (mmsVal.IsObject()) {
      auto mms = mmsVal.As<Napi::Object>();
      Napi::Array mmKeys = mms.GetPropertyNames();
      for (uint32_t i = 0; i < mmKeys.Length(); ++i) {
        std::string key = mmKeys.Get(i).As<Napi::String>().Utf8Value();
        if (key == "__gc" || key == "__index" || key == "__newindex" ||
            key == "__name" || key == lua_core::LuaRuntime::kClassMarkerField) {
          Napi::TypeError::New(env,
            "register_class(): metamethod '" + key + "' is reserved and cannot be overridden")
            .ThrowAsJavaScriptException();
          return env.Undefined();
        }
        Napi::Value val = mms.Get(key);
        if (val.IsFunction()) {
          mm_snapshot.emplace_back(std::move(key), val.As<Napi::Function>());
        }
      }
    }
  }

  const Napi::Value readableVal = def.Get("readable");
  const Napi::Value writableVal = def.Get("writable");
  const bool readable = readableVal.IsBoolean() && readableVal.As<Napi::Boolean>().Value();
  const bool writable = writableVal.IsBoolean() && writableVal.As<Napi::Boolean>().Value();

  const uint64_t class_id = next_class_id_++;

  // Names are minted and the JS functions collected here, but nothing is
  // registered into js_callbacks_/host_functions_ until the core call below
  // succeeds: RegisterClass can throw (OOM under maxMemory, or a raising
  // __newindex on a _G metatable at the class-global write), and eager
  // registration would strand the pairs — a retry mints fresh ids, so the
  // previous attempt's entries would be pinned forever (CR-8 F3). Deferring is
  // safe: the closures the core installs (the class table's `new`, the shared
  // method table) carry these names only as upvalues, nothing resolves them in
  // host_functions_ until Lua calls them, and no Lua runs between the core
  // call and the registration (the N5 / CR-7 F4 ordering discipline).
  const std::string ctor_name = "__class_ctor_" + std::to_string(class_id);

  // Instance methods (obj:method()).
  std::unordered_map<std::string, std::string> method_map;
  std::vector<std::pair<std::string, Napi::Function>> deferred_fns;
  if (const Napi::Value methodsVal = def.Get("methods"); methodsVal.IsObject()) {
    auto methods = methodsVal.As<Napi::Object>();
    Napi::Array keys = methods.GetPropertyNames();
    for (uint32_t i = 0; i < keys.Length(); ++i) {
      std::string name = keys.Get(i).As<Napi::String>().Utf8Value();
      Napi::Value val = methods.Get(name);
      if (val.IsFunction()) {
        std::string func_name = "__class_method_" + std::to_string(class_id) + "_" + name;
        deferred_fns.emplace_back(func_name, val.As<Napi::Function>());
        method_map[name] = func_name;
      }
    }
  }

  // Metamethods (operator overloads, __tostring, __call, etc.), taken from
  // the snapshot validated above (N3) — the definition object is not
  // consulted again.
  std::vector<lua_core::MetatableEntry> metamethods;
  for (const auto& [key, fn] : mm_snapshot) {
    std::string func_name = "__class_mm_" + std::to_string(class_id) + "_" + key;
    deferred_fns.emplace_back(func_name, fn);
    lua_core::MetatableEntry entry;
    entry.key = key;
    entry.is_function = true;
    entry.func_name = func_name;
    metamethods.push_back(std::move(entry));
  }

  // RegisterClass builds inside RunProtected, which throws on OOM under
  // maxMemory or a raising __newindex on a _G metatable at the class-global
  // write. Surface that as a JS error: letting a std::runtime_error unwind
  // across the N-API boundary terminates the process (the H1 class).
  try {
    runtime->RegisterClass(class_name, ctor_name, method_map, metamethods);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    // The reservation guard releases the name; nothing was registered, so
    // nothing is stranded (CR-8 F3).
    return env.Undefined();
  }

  js_callbacks_[ctor_name] = Napi::Persistent(constructFn);
  runtime->StoreHostFunction(ctor_name,
    CreateConstructorWrapper(ctor_name, class_name, readable, writable));
  for (auto& [func_name, fn] : deferred_fns) {
    js_callbacks_[func_name] = Napi::Persistent(fn);
    runtime->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }

  reservation.Commit();
  return env.Undefined();
}

Napi::Value LuaContext::SetMetatable(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "Expected (string, object)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();
  const auto mt = info[1].As<Napi::Object>();
  const Napi::Array keys = mt.GetPropertyNames();

  uint64_t mt_id = next_metatable_id_++;
  std::vector<lua_core::MetatableEntry> entries;

  // One collector spans the whole entry build and the core call: SetGlobalMetatable
  // validates the target global only after every entry has been converted, so a
  // missing/non-table global discards them all. The destructor sweeps any
  // reclaimable callback that never reached Lua (F1).
  JsCallbackCollectorScope collector(this);

  // Function-valued entries are collected here and registered only AFTER the
  // core call succeeds: SetGlobalMetatable throws on a trivially reachable
  // input (a nonexistent or non-table global), and eagerly-registered
  // js_callbacks_/host_functions_ pairs would be stranded by it (CR-8 F3).
  // Deferring is safe — the closures the core installs carry the names only as
  // upvalues, nothing resolves a name in host_functions_ until a metamethod
  // fires, and no Lua runs between the core call and the registration (the
  // N5 / CR-7 F4 ordering discipline).
  std::vector<std::pair<std::string, Napi::Function>> deferred_fns;

  for (uint32_t i = 0; i < keys.Length(); i++) {
    const std::string key = keys[i].As<Napi::String>().Utf8Value();
    const Napi::Value val = mt.Get(key);

    lua_core::MetatableEntry entry;
    entry.key = key;

    if (val.IsFunction()) {
      const std::string func_name = "__mt_" + std::to_string(mt_id) + "_" + key;
      deferred_fns.emplace_back(func_name, val.As<Napi::Function>());
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
    return env.Undefined();  // nothing registered, nothing stranded (CR-8 F3)
  }

  for (auto& [func_name, fn] : deferred_fns) {
    js_callbacks_[func_name] = Napi::Persistent(fn);
    runtime->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }

  return env.Undefined();
}

Napi::Value LuaContext::AddSearchPath(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
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
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "Expected (string, object)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();
  const auto moduleObj = info[1].As<Napi::Object>();
  const Napi::Array keys = moduleObj.GetPropertyNames();

  uint64_t mod_id = next_module_id_++;
  std::vector<lua_core::MetatableEntry> entries;

  // See SetMetatable: one collector spans the entry build and the core call so
  // entries discarded by a later failure sweep their reclaimable callbacks (F1).
  JsCallbackCollectorScope collector(this);

  // See SetMetatable: function entries are registered only after the core call
  // succeeds — RegisterModuleTable throws when the 'package' library isn't
  // loaded, and eager registration would strand the pairs (CR-8 F3).
  std::vector<std::pair<std::string, Napi::Function>> deferred_fns;

  for (uint32_t i = 0; i < keys.Length(); i++) {
    const std::string key = keys[i].As<Napi::String>().Utf8Value();
    const Napi::Value val = moduleObj.Get(key);

    lua_core::MetatableEntry entry;
    entry.key = key;

    if (val.IsFunction()) {
      const std::string func_name = "__module_" + std::to_string(mod_id) + "_" + key;
      deferred_fns.emplace_back(func_name, val.As<Napi::Function>());
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
    return env.Undefined();  // nothing registered, nothing stranded (CR-8 F3)
  }

  for (auto& [func_name, fn] : deferred_fns) {
    js_callbacks_[func_name] = Napi::Persistent(fn);
    runtime->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }

  return env.Undefined();
}

Napi::Value LuaContext::Compile(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
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
  return {env, Napi::Buffer<uint8_t>::Copy(env, bytecode.data(), bytecode.size())};
}

Napi::Value LuaContext::CompileFile(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
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
  return {env, Napi::Buffer<uint8_t>::Copy(env, bytecode.data(), bytecode.size())};
}

Napi::Value LuaContext::LoadBytecode(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Expected Buffer argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
  const std::vector<uint8_t> bytecode(buffer.Data(), buffer.Data() + buffer.Length());

  std::string chunk_name = "bytecode";
  if (info.Length() >= 2 && info[1].IsString()) {
    chunk_name = info[1].As<Napi::String>().Utf8Value();
  }

  CallScope _cs(this);
  const auto res = runtime->LoadBytecode(bytecode, chunk_name);

  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return env.Undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

Napi::Object LuaContext::CreateTableHandle(const Napi::Env env_, const int registry_ref) {
  auto* dataPtr = new LuaTableRefData(
    runtime, lua_core::LuaTableRef(registry_ref, runtime->RawState()), this, alive_);

  const Napi::Object handle = Napi::Object::New(env_);

  // The External's finalizer is the sole owner of dataPtr. Root it on _tableRef
  // AND on every method function below, so a method destructured off the handle
  // (`const { get } = handle; get(...)`) keeps the data alive instead of reading
  // freed memory once the handle object is collected. Non-configurable so it
  // can't be deleted to free the data out from under the still-bound methods —
  // the same ownership discipline used for __luaFnOwner (H3 / L6).
  const auto external = Napi::External<LuaTableRefData>::New(env_, dataPtr,
    [](Napi::Env, const LuaTableRefData* d) { delete d; });
  DefineHiddenProp(env_, handle, "_tableRef", external, /*writable=*/false);

  auto addMethod = [&](const char* name,
                       Napi::Value (*cb)(const Napi::CallbackInfo&)) {
    const Napi::Function fn = Napi::Function::New(env_, cb, name, dataPtr);
    DefineHiddenProp(env_, fn, "_tableOwner", external, /*writable=*/false);
    (void)handle.Set(name, fn);
  };
  addMethod("get", TableHandleGet);
  addMethod("set", TableHandleSet);
  addMethod("has", TableHandleHas);
  addMethod("length", TableHandleLength);
  addMethod("pairs", TableHandlePairs);
  addMethod("ipairs", TableHandleIPairs);
  addMethod("release", TableHandleRelease);

  return handle;
}

Napi::Value LuaContext::CreateTableMethod(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();

  int ref;
  // One collector spans the element loop and CreateTableFrom so a failure part
  // way through (or in the core call) sweeps the reclaimable callbacks minted
  // by the elements already converted (F1).
  JsCallbackCollectorScope collector(this);
  if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull()) {
    try {
      if (info[0].IsArray()) {
        auto arr = info[0].As<Napi::Array>();
        lua_core::LuaArray luaArr;
        luaArr.reserve(arr.Length());
        for (uint32_t i = 0; i < arr.Length(); ++i) {
          luaArr.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arr.Get(i))));
        }
        ref = runtime->CreateTableFrom(luaArr);
      } else if (info[0].IsObject()) {
        auto obj = info[0].As<Napi::Object>();
        lua_core::LuaTable luaTbl;
        auto keys = obj.GetPropertyNames();
        for (uint32_t i = 0; i < keys.Length(); ++i) {
          std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
          luaTbl[key] = std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(obj.Get(key)));
        }
        ref = runtime->CreateTableFrom(luaTbl);
      } else {
        Napi::TypeError::New(env, "create_table() argument must be an object or array").ThrowAsJavaScriptException();
        return env.Undefined();
      }
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  } else {
    try {
      ref = runtime->CreateTable();
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  return CreateTableHandle(env, ref);
}

Napi::Value LuaContext::GetGlobalRef(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "get_global_ref() requires a string name").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string name = info[0].As<Napi::String>().Utf8Value();
  // GetGlobalRef reads _G[name] through the protected-get path, which throws a
  // std::runtime_error if a __index metamethod on the globals table raises;
  // surface it as a JS exception rather than letting it unwind past N-API.
  std::variant<int, std::string> result;
  try {
    result = runtime->GetGlobalRef(name);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (auto* error = std::get_if<std::string>(&result)) {
    Napi::Error::New(env, *error).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  int ref = std::get<int>(result);
  return CreateTableHandle(env, ref);
}

Napi::Value LuaContext::GetMemoryUsage(const Napi::CallbackInfo& /*info*/) {
  // A worker thread mutates the allocator counter during async execution;
  // reading it concurrently would be a data race.
  if (RejectIfBusy()) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(runtime->GetMemoryUsage()));
}

Napi::Value LuaContext::RegisterTypeConverter(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsFunction()) {
    Napi::TypeError::New(env,
      "register_type_converter(match, convert) requires two functions")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  type_converters_.emplace_back(
    Napi::Persistent(info[0].As<Napi::Function>()),
    Napi::Persistent(info[1].As<Napi::Function>()));
  return env.Undefined();
}

LuaContext::~LuaContext() {
  // Signal any outstanding function/table handles that their context is gone, so
  // a call after destruction fails cleanly instead of dereferencing freed memory.
  if (alive_) alive_->store(false);

  // Clear callbacks to prevent accessing member state during lua_close()
  if (runtime) {
    runtime->SetUserdataGCCallback(nullptr);
    runtime->SetHostFunctionGCCallback(nullptr);
    runtime->SetPropertyHandlers(nullptr, nullptr);
    runtime->SetOutputHandler(nullptr);
  }
}

std::string LuaContext::StageJsError(const Napi::Value& value, const std::string& message) {
  // Only object errors carry structure worth preserving. For non-object throws
  // (throw "str", throw 42) fall back to the value's string form.
  if (!value.IsObject()) {
    return message.empty() ? value.ToString().Utf8Value() : message;
  }
  auto obj = value.As<Napi::Object>();

  const int id = next_js_error_id_++;
  js_error_registry_.emplace(id, Napi::Persistent(obj));

  lua_core::LuaTable t;
  t.emplace("message",
    std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::from(message)));
  t.emplace(lua_core::LuaRuntime::kJsErrorIdField,
    std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::from(static_cast<int64_t>(id))));
  if (obj.Get("name").IsString()) {
    t.emplace("name", std::make_shared<lua_core::LuaValue>(
      lua_core::LuaValue::from(obj.Get("name").As<Napi::String>().Utf8Value())));
  }
  if (obj.Get("stack").IsString()) {
    t.emplace("stack", std::make_shared<lua_core::LuaValue>(
      lua_core::LuaValue::from(obj.Get("stack").As<Napi::String>().Utf8Value())));
  }
  runtime->SetPendingErrorValue(
    std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::from(std::move(t))));
  return message;
}

Napi::Value LuaContext::LuaErrorToJsValue(const std::string& fallback) {
  lua_core::LuaPtr ev = runtime->TakeLastErrorValue();
  if (ev && std::holds_alternative<lua_core::LuaTable>(ev->value)) {
    const auto& t = std::get<lua_core::LuaTable>(ev->value);
    auto it = t.find(lua_core::LuaRuntime::kJsErrorIdField);
    if (it != t.end() && it->second &&
        std::holds_alternative<int64_t>(it->second->value)) {
      const int id = static_cast<int>(std::get<int64_t>(it->second->value));
      auto rit = js_error_registry_.find(id);
      if (rit != js_error_registry_.end()) {
        Napi::Object original = rit->second.Value();
        js_error_registry_.erase(rit);
        return original;  // the original JS Error object, fully preserved
      }
    }
  }
  return Napi::Error::New(env, fallback).Value();
}

void LuaContext::ThrowLuaError(const std::string& fallback) {
  Napi::Error(env, LuaErrorToJsValue(fallback)).ThrowAsJavaScriptException();
}

lua_core::LuaRuntime::Function LuaContext::CreateJsCallbackWrapper(const std::string& name) {
  return [this, name](const std::vector<lua_core::LuaPtr>& args) -> lua_core::LuaPtr {
    // Runs inside a Lua C frame; scope the per-call handles (args + result) so a
    // tight Lua loop calling this host function doesn't accumulate millions of
    // live handles until the enclosing script returns. The stashed
    // async_pending_promise_ is a Persistent (strong) ref and survives the scope.
    Napi::HandleScope scope(env);
    // Look the callback up explicitly: operator[] would default-construct an
    // empty FunctionReference for a missing name, and calling that is UB.
    auto cbIt = js_callbacks_.find(name);
    if (cbIt == js_callbacks_.end()) {
      throw std::runtime_error("JS callback '" + name + "' is no longer registered");
    }
    std::vector<napi_value> jsArgs;
    jsArgs.reserve(args.size());
    for (const auto& a : args) {
      jsArgs.push_back(CoreToNapi(*a));
    }
    try {
      const Napi::Value result = cbIt->second.Call(jsArgs);
      if (result.IsPromise()) {
        if (!runtime->IsAwaitDriverMode()) {
          throw std::runtime_error(
            "'" + name + "' returned a Promise; call it inside execute_async() to await it");
        }
        // Stash the promise and signal LuaCallHostFunction to suspend.
        async_pending_promise_ = Napi::Persistent(result.As<Napi::Object>());
        runtime->RequestAwaitYield();
        return std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::nil());
      }
      return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(result));
    } catch (const Napi::Error& e) {
      throw std::runtime_error(StageJsError(e.Value(), e.Message()));
    }
  };
}

lua_core::LuaRuntime::Function LuaContext::CreateConstructorWrapper(
    const std::string& name, const std::string& class_name,
    bool readable, bool writable) {
  return [this, name, class_name, readable, writable](
      const std::vector<lua_core::LuaPtr>& args) -> lua_core::LuaPtr {
    // Bound the N-API handles created below (arg conversions, the constructed
    // instance, the hidden-prop temporaries) to this call. Without a scope,
    // `for i=1,1e6 do MyClass() end` would pile every iteration's handles into
    // the outer entry scope until the whole Lua execution returns (M11). Nothing
    // needs to escape: the instance survives via the Napi::Persistent below.
    Napi::HandleScope scope(env);
    auto cbIt = js_callbacks_.find(name);
    if (cbIt == js_callbacks_.end()) {
      throw std::runtime_error(
        "Class '" + class_name + "' constructor is no longer registered");
    }
    std::vector<napi_value> jsArgs;
    jsArgs.reserve(args.size());
    for (const auto& a : args) {
      jsArgs.push_back(CoreToNapi(*a));
    }

    Napi::Value instance;
    try {
      instance = cbIt->second.Call(jsArgs);
    } catch (const Napi::Error& e) {
      throw std::runtime_error(StageJsError(e.Value(), e.Message()));
    }

    if (!instance.IsObject() || instance.IsArray() || instance.IsFunction()) {
      throw std::runtime_error(
        "Class '" + class_name + "' constructor must return an object");
    }

    // Register the new instance as JS-backed userdata.
    const int ref_id = next_userdata_id_++;
    const auto instObj = instance.As<Napi::Object>();
    // Tag the instance so that passing the JS object back into Lua re-materializes
    // it as the same class userdata instead of deep-copying it to a table. The
    // owner marker carries this context's runtime pointer so a ref_id from a
    // foreign context isn't mistaken for one of our js_userdata_ slots (the ref_id
    // alone is just an integer and would collide across contexts). The External
    // wraps the raw pointer for identity comparison only — it never owns or
    // dereferences the runtime, so no finalizer is needed.
    DefineHiddenProp(env, instObj, "__luaClassRef", Napi::Number::New(env, ref_id));
    DefineHiddenProp(env, instObj, "__luaClassName", Napi::String::New(env, class_name));
    DefineHiddenProp(env, instObj, "__luaClassOwner",
      Napi::External<lua_core::LuaRuntime>::New(env, runtime.get()));

    UserdataEntry entry;
    entry.object = Napi::Persistent(instObj);
    entry.readable = readable;
    entry.writable = writable;
    js_userdata_[ref_id] = std::move(entry);

    // Return a class-bound userdata reference; PushLuaValue materializes it
    // with the per-class metatable.
    return std::make_shared<lua_core::LuaValue>(
      lua_core::LuaValue::from(lua_core::LuaUserdataRef(
        ref_id, runtime->RawState(), /*is_opaque=*/false, LUA_NOREF,
        /*is_proxy=*/false, class_name)));
  };
}

Napi::Value LuaContext::ExecuteScript(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string script = info[0].As<Napi::String>().Utf8Value();

  CallScope _cs(this);
  const auto res = runtime->ExecuteScript(script);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return env.Undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

Napi::Value LuaContext::ExecuteFile(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string filepath = info[0].As<Napi::String>().Utf8Value();

  CallScope _cs(this);
  const auto res = runtime->ExecuteFile(filepath);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return env.Undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

void LuaContext::ClearBusy() {
  // Worker teardown (OnOK/OnError). Clear any cancel signalled during the run so
  // a cancelled worker doesn't leave the flag set to abort the next run (L8).
  runtime->ClearCancel();
  is_busy_ = false;
}

bool LuaContext::RejectIfBusy() {
  if (is_busy_) {
    Napi::Error::New(env, "Lua context is busy with an async operation")
      .ThrowAsJavaScriptException();
    return true;
  }
  return false;
}

Napi::Value LuaContext::IsBusyMethod(const Napi::CallbackInfo& /*info*/) {
  return Napi::Boolean::New(env, is_busy_.load());
}

// execute_script_async / execute_file_async run the script on a libuv worker
// thread: use them for CPU-bound Lua that shouldn't block the event loop, but
// note the script cannot call back into JS (host callbacks are disabled in
// async_mode_) and print redirection is bypassed. For Lua that needs to await JS
// Promises or invoke JS callbacks, use execute_async (coroutine-driven, stays on
// the main thread) instead.
Napi::Value LuaContext::ExecuteScriptAsync(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string script = info[0].As<Napi::String>().Utf8Value();
  is_busy_ = true;

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new LuaScriptAsyncWorker(
    runtime, script, this, Napi::Persistent(info.This().As<Napi::Object>()), deferred);
  worker->Queue();
  return deferred.Promise();
}

Napi::Value LuaContext::ExecuteFileAsync(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string filepath = info[0].As<Napi::String>().Utf8Value();
  is_busy_ = true;

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new LuaFileAsyncWorker(
    runtime, filepath, this, Napi::Persistent(info.This().As<Napi::Object>()), deferred);
  worker->Queue();
  return deferred.Promise();
}

// --- Coroutine-driven async execution (execute_async / cancel) ---

Napi::Value LuaContext::ExecuteAsync(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string script = info[0].As<Napi::String>().Utf8Value();

  // CreateCoroutineFromScript can now throw a std::runtime_error if creating the
  // coroutine thread OOMs under maxMemory (M5); reject rather than let it unwind
  // past N-API.
  std::variant<lua_core::LuaThreadRef, std::string> co = std::string();
  try {
    co = runtime->CreateCoroutineFromScript(script);
  } catch (const std::exception& e) {
    auto deferred = Napi::Promise::Deferred::New(env);
    deferred.Reject(Napi::Error::New(env, e.what()).Value());
    return deferred.Promise();
  }
  if (std::holds_alternative<std::string>(co)) {
    // Reject (rather than throw) so `.catch` and `await` both see the error.
    auto deferred = Napi::Promise::Deferred::New(env);
    deferred.Reject(Napi::Error::New(env, std::get<std::string>(co)).Value());
    return deferred.Promise();
  }

  is_busy_ = true;
  ++async_generation_;  // invalidate any stale settlement from a prior run
  js_error_registry_.clear();
  runtime->ClearCancel();
  runtime->SetAwaitDriverMode(true);
  async_co_.emplace(std::move(std::get<lua_core::LuaThreadRef>(co)));
  // Tell the core which thread is the driver so a promise awaited from inside a
  // user coroutine is rejected rather than yielding the wrong state (M1).
  runtime->SetAwaitDriverThread(async_co_->thread);
  async_deferred_.emplace(Napi::Promise::Deferred::New(env));
  // Root the wrapping JS object for the run's duration: while the coroutine is
  // suspended awaiting a promise, the settlement callbacks hold only a raw
  // pointer to this context, so the ObjectWrap must not be collectible.
  async_self_ref_ = Napi::Persistent(info.This().As<Napi::Object>());

  Napi::Promise promise = async_deferred_->Promise();
  // Initial resume (no arguments) — runs until the script finishes or awaits.
  DriveAsync({}, false);
  return promise;
}

// Data passed to the await-settlement callbacks: the context plus the generation
// of the execute_async run that attached them (see async_generation_). `settled`
// makes a second invocation a no-op — a spec-violating Promise whose `then`
// fires both callbacks, or the same one twice, must not re-enter the resume
// logic (L5). The cookie is never freed by the callbacks; its lifetime is owned
// by an Napi::External finalizer rooted on both callback functions, so it stays
// valid for any late/duplicate settlement and is reclaimed only when the promise
// (and thus the callbacks) is collected.
//
// `alive` is the context's shared liveness flag (the same one the function/table
// handles carry). The callbacks outlive the run by design — cancel() releases
// async_self_ref_, so the context can be garbage-collected while the awaited
// promise is still pending — and a late settlement must then be discarded
// WITHOUT touching `ctx`: dereferencing it reads freed memory and aborts the
// process (CR-7 F1, the H3/H5 class).
namespace {
struct AwaitCookie {
  LuaContext* ctx;
  uint64_t gen;
  bool settled;
  std::shared_ptr<std::atomic<bool>> alive;
};
}  // namespace

void LuaContext::DriveAsync(const std::vector<lua_core::LuaPtr>& args, bool is_error) {
  // Mark the resume window so a cancel() arriving re-entrantly from a host
  // callback defers its teardown until after the coroutine leaves the C stack
  // (see Cancel()). Tearing down here would free the running coroutine. RAII so
  // the flag is cleared even if the resume unexpectedly throws (H1).
  struct ResumeFlag {
    bool& f;
    explicit ResumeFlag(bool& b) : f(b) { f = true; }
    ~ResumeFlag() { f = false; }
  };
  lua_core::AsyncStepResult step;
  {
    ResumeFlag resuming(async_resuming_);
    step = runtime->ResumeAsyncStep(*async_co_, args, is_error);
  }

  // Honor a cancel() that arrived during the resume, now that the coroutine has
  // returned. Also covers a cancel requested before an about-to-be-attached
  // continuation.
  if (runtime->IsCancelRequested()) {
    auto deferred = *async_deferred_;
    FinishAsync();
    deferred.Reject(Napi::Error::New(env, "execution cancelled").Value());
    return;
  }

  if (step.state == lua_core::AsyncStepResult::State::Awaiting) {
    if (async_pending_promise_.IsEmpty()) {
      // The coroutine yielded without a pending host Promise — e.g. user code
      // called coroutine.yield at the top level. That has no resumer here.
      auto deferred = *async_deferred_;
      FinishAsync();
      deferred.Reject(Napi::Error::New(env,
        "coroutine.yield is not supported at the top level of execute_async; "
        "only awaiting a host Promise suspends execution").Value());
      return;
    }
    // Attach continuation callbacks to the pending promise. The callbacks carry
    // a heap cookie tagged with this run's generation. The cookie's lifetime is
    // owned by an External finalizer (not by the callbacks), and that External is
    // rooted as a hidden prop on BOTH callbacks — so the cookie outlives any
    // duplicate/late settlement from a misbehaving promise and is freed only when
    // the promise and its callbacks are garbage-collected (L5). It also carries
    // the context's shared liveness flag so a settlement arriving after the
    // context is destroyed is discarded without dereferencing it (CR-7 F1).
    //
    // The whole attach runs guarded (CR-7 F2): `then` is user-influenced (an own
    // property shadows Promise.prototype.then, and the prototype itself can be
    // patched), so the lookup or the call can throw. Unwinding out of DriveAsync
    // mid-run would leave the context wedged (is_busy_ true, async_co_ engaged)
    // with a promise the caller may never have received — and the only recovery,
    // cancel(), would then reject a promise nothing can have a handler on. On
    // failure, settle the run instead: reject the deferred and tear down.
    Napi::Object promise = async_pending_promise_.Value();
    async_pending_promise_.Reset();
    std::string attach_err;
    bool attached = false;
    // A hostile `then` can settle synchronously (re-entering OnAwaitSettled and
    // finishing this run) and THEN throw; the failure branch below must not
    // tear down a run that already ended — or a newer one started meanwhile.
    const uint64_t attach_gen = async_generation_;
    try {
      Napi::Value thenVal = promise.Get("then");
      if (!thenVal.IsFunction()) {
        attach_err = "awaited Promise has no callable 'then'";
      } else {
        auto thenFn = thenVal.As<Napi::Function>();
        auto* cookie = new AwaitCookie{this, async_generation_, false, alive_};
        // Hand ownership to the External before anything else can throw, so a
        // failure below cannot leak the cookie (it is reclaimed with the
        // then-unrooted handles).
        auto cookieOwner = Napi::External<AwaitCookie>::New(env, cookie,
          [](Napi::Env, AwaitCookie* c) { delete c; });
        auto onResolve = Napi::Function::New(env, &LuaContext::OnAwaitResolveStatic, "onResolve", cookie);
        auto onReject = Napi::Function::New(env, &LuaContext::OnAwaitRejectStatic, "onReject", cookie);
        DefineHiddenProp(env, onResolve, "__cookie", cookieOwner);
        DefineHiddenProp(env, onReject, "__cookie", cookieOwner);
        thenFn.Call(promise, {onResolve, onReject});
        attached = true;
      }
    } catch (const std::exception& e) {
      attach_err = e.what();
    }
    if (!attached && async_deferred_ && async_generation_ == attach_gen) {
      auto deferred = *async_deferred_;
      FinishAsync();
      deferred.Reject(Napi::Error::New(env,
        "failed to attach to the awaited Promise: " + attach_err).Value());
    }
    return;
  }

  // Finished or errored: settle the promise and tear down. Marshalling can throw
  // (e.g. a result value that fails to cross to JS); catch it so the deferred is
  // always settled and the context is never left permanently busy.
  auto deferred = *async_deferred_;
  if (step.state == lua_core::AsyncStepResult::State::Finished) {
    Napi::Value resolved;
    bool ok = true;
    std::string convErr;
    try {
      resolved = ResultsToJs(step.values);
    } catch (const std::exception& e) {
      ok = false;
      convErr = e.what();
    }
    FinishAsync();
    if (ok) {
      deferred.Resolve(resolved);
    } else {
      deferred.Reject(Napi::Error::New(env,
        std::string("failed to convert async result: ") + convErr).Value());
    }
  } else {
    // Reconstruct the original JS Error if this was a raised JS callback error.
    Napi::Value errValue = LuaErrorToJsValue(step.error);
    FinishAsync();
    deferred.Reject(errValue);
  }
}

Napi::Value LuaContext::OnAwaitSettled(const Napi::Value& value, bool is_error, uint64_t gen) {
  // Ignore a settlement from a run that has already ended or been superseded
  // (e.g. a promise from a cancelled run resolving after a new run has started).
  // A cancel() while suspended awaiting a promise tears the run down immediately
  // in Cancel() (clearing async_co_), so a pending cancel is never observed here
  // — the generation/liveness guard above already discards the late settlement.
  if (!async_co_ || !async_deferred_ || gen != async_generation_) {
    return env.Undefined();
  }

  std::vector<lua_core::LuaPtr> args;
  // Collect any reclaimable callback entries minted while converting the
  // settled value into args: if the H2 re-check below drops this settlement,
  // they were never pushed and must be swept (N4).
  JsCallbackCollectorScope collector(this);
  if (is_error) {
    // Every read below can run user JS and throw: the `message` probe (a
    // hostile getter), the ToString fallback (a Symbol or null-prototype
    // rejection value has no usable coercion), and StageJsError's name/stack
    // reads. This callback cannot tolerate a throw — it would unwind into the
    // promise reaction job (an unhandled rejection, process exit by default)
    // and leave the run wedged with its deferred never settled. Fall back to a
    // generic message and deliver the rejection to Lua anyway (CR-8 F1),
    // mirroring the guarded resolve path below.
    std::string msg;
    try {
      if (value.IsObject() && value.As<Napi::Object>().Get("message").IsString()) {
        msg = value.As<Napi::Object>().Get("message").As<Napi::String>().Utf8Value();
      } else {
        msg = value.ToString().Utf8Value();
      }
      // Stage a structured error for object rejections so the original JS Error
      // is reconstructed if the rejection surfaces uncaught (D1 through async).
      StageJsError(value, msg);
    } catch (const std::exception&) {
      msg = "(rejection value could not be converted)";
      // Drop anything a partially-run StageJsError staged, so the fallback
      // string (not a half-built structured error) is what Lua raises.
      if (runtime->HasPendingErrorValue()) runtime->TakePendingErrorValue();
    }
    if (runtime->HasPendingErrorValue()) {
      args.push_back(runtime->TakePendingErrorValue());
    } else {
      args.push_back(std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::from(msg)));
    }
  } else {
    // Converting the resolved value can throw (Symbol, out-of-range BigInt, an
    // over-deep object). Don't let it escape this N-API callback: settle the
    // deferred with the error and tear down instead of leaving the run wedged.
    try {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value)));
    } catch (const std::exception& e) {
      auto deferred = *async_deferred_;
      FinishAsync();
      deferred.Reject(Napi::Error::New(env,
        std::string("failed to convert awaited value: ") + e.what()).Value());
      return env.Undefined();
    }
  }
  // Marshalling the settled value above (type converters, object getters, the
  // reject path's message/name/stack reads) can run user JS that calls cancel()
  // — which, since we are not inside a resume, takes the full-teardown branch
  // and disengages async_co_/async_deferred_ — or even starts a new run. Re-check
  // the liveness+generation guard before driving so we neither dereference a
  // disengaged optional nor inject this settlement into a newer run (H2).
  if (!async_co_ || !async_deferred_ || gen != async_generation_) {
    return env.Undefined();  // collector's destructor sweeps the dropped args
  }
  DriveAsync(args, is_error);
  return env.Undefined();
}

void LuaContext::FinishAsync() {
  runtime->SetAwaitDriverMode(false);
  runtime->SetAwaitDriverThread(nullptr);
  runtime->ClearCancel();
  if (async_co_) {
    async_co_->release();
    async_co_.reset();
  }
  async_deferred_.reset();
  async_pending_promise_.Reset();
  async_self_ref_.Reset();  // release the wrapper root taken in ExecuteAsync
  js_error_registry_.clear();
  is_busy_ = false;
}

Napi::Value LuaContext::OnAwaitResolveStatic(const Napi::CallbackInfo& info) {
  auto* cookie = static_cast<AwaitCookie*>(info.Data());
  // Ignore a duplicate settlement (hostile/broken promise firing twice). The
  // cookie is owned by the External finalizer, never freed here, so reading the
  // flag is always safe (L5).
  if (cookie->settled) return info.Env().Undefined();
  cookie->settled = true;
  // The context may have been destroyed since the callbacks were attached (a
  // cancel() released async_self_ref_ and GC collected the wrapper). Check the
  // shared liveness flag BEFORE touching ctx — the generation guard inside
  // OnAwaitSettled reads members of the (then freed) context (CR-7 F1).
  if (!cookie->alive || !cookie->alive->load()) return info.Env().Undefined();
  return cookie->ctx->OnAwaitSettled(
    info.Length() > 0 ? info[0] : info.Env().Undefined(), false, cookie->gen);
}

Napi::Value LuaContext::OnAwaitRejectStatic(const Napi::CallbackInfo& info) {
  auto* cookie = static_cast<AwaitCookie*>(info.Data());
  if (cookie->settled) return info.Env().Undefined();
  cookie->settled = true;
  // See OnAwaitResolveStatic: discard a settlement that outlived the context
  // without dereferencing it (CR-7 F1).
  if (!cookie->alive || !cookie->alive->load()) return info.Env().Undefined();
  return cookie->ctx->OnAwaitSettled(
    info.Length() > 0 ? info[0] : info.Env().Undefined(), true, cookie->gen);
}

Napi::Value LuaContext::Cancel(const Napi::CallbackInfo& info) {
  if (async_co_ && async_deferred_) {
    if (async_resuming_) {
      // Called re-entrantly from a host callback while the coroutine is still
      // executing on the C stack. Tearing down now would free the running
      // coroutine (use-after-free) and disengage async_deferred_ out from under
      // DriveAsync. Defer: DriveAsync observes the request once the resume
      // returns and finishes the run then.
      runtime->RequestCancel();
      return env.Undefined();
    }
    // Abandon the suspended coroutine and reject immediately. Any pending
    // promise settlement becomes a no-op (async_co_ is cleared).
    const auto deferred = *async_deferred_;
    FinishAsync();
    deferred.Reject(Napi::Error::New(env, "execution cancelled").Value());
  } else if (is_busy_) {
    // A worker-thread run (execute_script_async / execute_file_async) is in
    // flight. It executes Lua synchronously off-thread, so it can only be
    // interrupted cooperatively: signal the runtime and let the instruction
    // count-hook (polls IsCancelRequested) abort the VM at the next check. This
    // therefore only takes effect when maxInstructions is set — the hook exists
    // only then. The worker's OnOK/OnError clears the flag via ClearBusy (L8).
    runtime->RequestCancel();
  }
  return env.Undefined();
}

Napi::Value LuaContext::Pcall(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "pcall(fn, ...args) requires a function as the first argument")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto fn = info[0].As<Napi::Function>();
  std::vector<napi_value> args;
  for (size_t i = 1; i < info.Length(); ++i) args.push_back(info[i]);

  const Napi::Object result = Napi::Object::New(env);
  try {
    const Napi::Value r = fn.Call(args);
    (void)result.Set("ok", Napi::Boolean::New(env, true));
    (void)result.Set("value", r);
  } catch (const Napi::Error& e) {
    // The thrown value is preserved (reconstructed original JS Error when the
    // failure came from a JS callback; otherwise a Lua-error Error object).
    (void)result.Set("ok", Napi::Boolean::New(env, false));
    (void)result.Set("error", e.Value());
  }
  return result;
}

// Explicit registry-reference release for the wrapper kinds that outlive a
// single call: Lua functions (__luaFnOwner), coroutines (_coroutine), and
// table handles / metatabled-table Proxies (_tableRef). Dropping the ref frees
// the registry slot on the next Lua GC cycle instead of waiting for the JS
// wrapper to be garbage-collected. Double release is a safe no-op; using a
// wrapper after release throws a clear "has been released" error.
Napi::Value LuaContext::Release(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1) {
    Napi::TypeError::New(env,
      "release(value) requires a Lua function, coroutine, or table reference")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const Napi::Value target = info[0];

  // Only trust a marker minted by THIS context's runtime — a ref index from
  // another context would address an unrelated slot in that registry (the same
  // policy as the round-trip identity checks in NapiToCoreImpl).
  const auto rejectForeign = [this]() {
    Napi::Error::New(env, "value belongs to a different Lua context")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  };

  if (target.IsFunction()) {
    const auto fn = target.As<Napi::Object>();
    if (fn.Has("__luaFnOwner") && fn.Get("__luaFnOwner").IsExternal()) {
      auto* data = fn.Get("__luaFnOwner").As<Napi::External<LuaFunctionData>>().Data();
      if (data && data->runtime.get() != runtime.get()) return rejectForeign();
      if (data && data->funcRef.ref != LUA_NOREF) data->funcRef.release();
      return env.Undefined();
    }
    Napi::TypeError::New(env,
      "release(value): the function is not a Lua function reference")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (target.IsObject()) {
    const auto obj = target.As<Napi::Object>();

    if (obj.Has("_coroutine") && obj.Get("_coroutine").IsExternal()) {
      auto* data = obj.Get("_coroutine").As<Napi::External<LuaThreadData>>().Data();
      if (data && data->runtime.get() != runtime.get()) return rejectForeign();
      if (data && data->threadRef.ref != LUA_NOREF) data->threadRef.release();
      return env.Undefined();
    }

    if (obj.Has("_tableRef") && obj.Get("_tableRef").IsExternal()) {
      auto* data = obj.Get("_tableRef").As<Napi::External<LuaTableRefData>>().Data();
      if (data && data->runtime.get() != runtime.get()) return rejectForeign();
      if (data && data->tableRef.ref != LUA_NOREF) data->tableRef.release();
      return env.Undefined();
    }
  }

  Napi::TypeError::New(env,
    "release(value) requires a Lua function, coroutine, or table reference")
    .ThrowAsJavaScriptException();
  return env.Undefined();
}

void LuaContext::InstallPrintHandler(const Napi::Function& fn) {
  // Run the runtime install first: it can throw (the protected print/io.write
  // overrides fail under OOM), and print_handler_ must not be left pointing at
  // a handler those overrides never reach (CR-8 F7). The lambda reads
  // print_handler_ at call time, so committing it after the install is safe —
  // no Lua runs between.
  runtime->SetOutputHandler([this](const std::string& text) {
    if (print_handler_.IsEmpty()) return;
    // This runs inside Lua's C call frame (print/io.write). Lua is built as C,
    // so a C++ exception must not unwind through it. Contain a throwing handler,
    // and scope the per-call handles so a hot print loop doesn't accumulate them.
    Napi::HandleScope scope(env);
    try {
      print_handler_.Call({Napi::String::New(env, text)});
    } catch (const Napi::Error&) {
      // A throwing print handler is swallowed rather than corrupting the VM.
    }
  });
  print_handler_ = Napi::Persistent(fn);
}

Napi::Value LuaContext::SetPrintHandler(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  // InstallPrintHandler routes through SetOutputHandler -> InstallOutputRedirection,
  // which does a protected _G reassignment of print/io.write and throws on a
  // raising __newindex on a _G metatable (or OOM under maxMemory). Surface that
  // as a JS error rather than letting it terminate the process (the H1 class,
  // CR-6 F1).
  try {
    if (info.Length() >= 1 && info[0].IsFunction()) {
      InstallPrintHandler(info[0].As<Napi::Function>());
    } else {
      // null/undefined clears redirection (print/io.write go to stdout).
      print_handler_.Reset();
      runtime->SetOutputHandler(nullptr);
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return env.Undefined();
}

Napi::Value LuaContext::AddSearcher(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "add_searcher(fn) requires a function")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string name = "__searcher_" + std::to_string(next_searcher_id_++);
  // Core call first: if it throws (e.g. the 'package' library isn't loaded — a
  // trivially reachable failure), no js_callbacks_/host_functions_ entry is
  // left behind, so retry loops can't accumulate stranded state (the N5
  // ordering discipline, CR-7 F4). Safe to register after: AddJsSearcher only
  // stores the name in the searcher closure's upvalue, and nothing resolves it
  // in host_functions_ until a later require().
  try {
    runtime->AddJsSearcher(name);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  js_callbacks_[name] = Napi::Persistent(info[0].As<Napi::Function>());
  runtime->StoreHostFunction(name, CreateJsCallbackWrapper(name));
  return env.Undefined();
}

// --- AsyncWorker OnOK/OnError implementations ---

void LuaScriptAsyncWorker::OnOK() {
  Napi::Env env = Env();
  context_->ClearBusy();

  if (std::holds_alternative<std::string>(result_)) {
    deferred_.Reject(Napi::Error::New(env, std::get<std::string>(result_)).Value());
    return;
  }
  // Marshalling can throw (e.g. a result string exceeding V8's maximum string
  // length). Unwinding out of OnOK is an uncaughtException with the promise
  // never settled; reject it instead (CR-8 F4, mirroring DriveAsync's guard).
  try {
    deferred_.Resolve(context_->ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(result_)));
  } catch (const std::exception& e) {
    deferred_.Reject(Napi::Error::New(env,
      std::string("failed to convert async result: ") + e.what()).Value());
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
  // See LuaScriptAsyncWorker::OnOK: a marshalling failure must reject, not
  // unwind (CR-8 F4).
  try {
    deferred_.Resolve(context_->ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(result_)));
  } catch (const std::exception& e) {
    deferred_.Reject(Napi::Error::New(env,
      std::string("failed to convert async result: ") + e.what()).Value());
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
  if (depth > 0) return NapiToCoreImpl(value, depth);
  // Top-level conversion: if it aborts partway (a sibling value throwing after
  // a function was already registered), sweep the reclaimable entries it
  // minted — they will never be pushed and would otherwise live until context
  // destruction (N4). On success the names propagate to any enclosing scope,
  // which may still discard the converted value (see OnAwaitSettled).
  JsCallbackCollectorScope collector(this);
  lua_core::LuaValue result = NapiToCoreImpl(value, 0);
  // Success: hand the names to any enclosing method-level scope, which may
  // still discard this value. A throw instead leaves them for the collector's
  // destructor to sweep.
  collector.PropagateToParent();
  return result;
}

void LuaContext::SweepUnpushedJsCallbacks(const std::vector<std::string>& names) {
  for (const auto& name : names) {
    if (runtime && runtime->EraseReclaimableIfUnpushed(name)) {
      js_callbacks_.erase(name);
    }
  }
}

lua_core::LuaValue LuaContext::NapiToCoreImpl(const Napi::Value& value, int depth) {
  if (depth > lua_core::LuaRuntime::kMaxDepth) {
    throw std::runtime_error("Value nesting depth exceeds the maximum of "
      + std::to_string(lua_core::LuaRuntime::kMaxDepth) + " levels");
  }

  if (value.IsFunction()) {
    // Register the callback (without creating a global) and return a
    // HostFunctionName so PushLuaValue materializes it as a real Lua closure —
    // even when the function is nested inside a table or array.
    const std::string name = "__js_callback_" + std::to_string(next_js_callback_id_++);
    js_callbacks_[name] = Napi::Persistent(value.As<Napi::Function>());
    // Reclaimable: the entry (and the js_callbacks_ reference above) is dropped
    // when the materialized Lua closure is garbage-collected, so anonymous
    // callbacks don't accumulate for the life of the context (M2).
    runtime->RegisterReclaimableHostFunction(name, CreateJsCallbackWrapper(name));
    if (js_callback_collector_) js_callback_collector_->push_back(name);
    return lua_core::LuaValue::from(lua_core::HostFunctionName{name});
  }

  const napi_valuetype type = value.Type();
  if (type == napi_undefined || type == napi_null) {
    return lua_core::LuaValue::nil();
  }
  if (type == napi_boolean) {
    return lua_core::LuaValue::from(value.As<Napi::Boolean>().Value());
  }
  if (type == napi_bigint) {
    bool lossless = false;
    const int64_t i = value.As<Napi::BigInt>().Int64Value(&lossless);
    if (!lossless) {
      throw std::runtime_error(
        "BigInt value is out of range for a 64-bit Lua integer");
    }
    return lua_core::LuaValue::from(i);
  }
  if (type == napi_number) {
    const double num = value.As<Napi::Number>().DoubleValue();
    // Upper bound is strictly < 2^63: static_cast<double>(INT64_MAX) rounds up
    // to exactly 2^63, and casting a double == 2^63 back to int64_t is UB.
    constexpr double kInt64UpperExclusive = 9223372036854775808.0;  // 2^63
    if (std::isfinite(num) && num >= static_cast<double>(std::numeric_limits<int64_t>::min()) &&
        num < kInt64UpperExclusive) {
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
  if (type == napi_symbol) {
    throw std::runtime_error("Cannot convert a JavaScript Symbol to a Lua value");
  }

  if (type == napi_object) {
    if (value.IsObject()) {
      auto obj = value.As<Napi::Object>();

      // Check if it's a LuaTableRef Proxy (metatabled table round-tripping through JS).
      // Copy the existing ref so it shares registry ownership rather than minting a
      // second owner for the same slot (which would double-unref). Only trust the
      // marker if it belongs to THIS context's runtime — a ref index from another
      // context would address an unrelated slot in this registry.
      if (obj.Has("_tableRef") && obj.Get("_tableRef").IsExternal()) {
        auto* data = obj.Get("_tableRef").As<Napi::External<LuaTableRefData>>().Data();
        if (data && data->runtime.get() == runtime.get()) {
          // A released handle would push registry slot LUA_NOREF (nil) silently;
          // surface it as an error instead, matching the handle methods (L2).
          if (data->tableRef.ref == LUA_NOREF) {
            throw std::runtime_error("table handle has been released");
          }
          return lua_core::LuaValue::from(lua_core::LuaTableRef(data->tableRef));
        }
        // Foreign or invalid marker: fall through to a plain deep copy.
      }

      // Check if it's an opaque userdata handle (Lua-created, round-tripping through JS)
      if (obj.Has("_userdata") && obj.Get("_userdata").IsExternal()) {
        auto* data = obj.Get("_userdata").As<Napi::External<LuaUserdataData>>().Data();
        if (data && data->runtime.get() == runtime.get()) {
          return lua_core::LuaValue::from(lua_core::LuaUserdataRef(data->userdataRef));
        }
      }

      // Check if it's a registered class instance round-tripping back to Lua.
      // Only honor the marker if it was minted by THIS context's runtime — the
      // ref_id is a bare integer, so an instance from another context could
      // otherwise alias an unrelated slot in this js_userdata_. Foreign or
      // invalid markers fall through to a plain deep copy (same policy as the
      // _tableRef / _userdata markers above).
      if (obj.Has("__luaClassRef")) {
        Napi::Value r = obj.Get("__luaClassRef");
        Napi::Value cn = obj.Get("__luaClassName");
        Napi::Value owner = obj.Get("__luaClassOwner");
        const bool owned = owner.IsExternal() &&
          owner.As<Napi::External<lua_core::LuaRuntime>>().Data() == runtime.get();
        if (owned && r.IsNumber() && cn.IsString()) {
          const int ref_id = r.As<Napi::Number>().Int32Value();
          if (js_userdata_.find(ref_id) != js_userdata_.end()) {
            return lua_core::LuaValue::from(lua_core::LuaUserdataRef(
              ref_id, runtime->RawState(), /*is_opaque=*/false, LUA_NOREF,
              /*is_proxy=*/false, cn.As<Napi::String>().Utf8Value()));
          }
        }
      }
    }

    // B2: user-registered converters get first look at objects (after internal
    // round-trip markers, before built-in type handling). A converter returns a
    // JS value that is then converted normally. Index the vector and pull both
    // function handles out BEFORE calling match(): a match/convert callback may
    // re-enter and register another converter, reallocating the vector and
    // invalidating any reference held across the call.
    for (auto &[fst, snd] : type_converters_) {
      Napi::Function match = fst.Value();
      Napi::Function convert = snd.Value();
      if (match.Call({value}).ToBoolean().Value()) {
        return NapiToCoreInstance(convert.Call({value}), depth + 1);
      }
    }

    // B1: common built-in JS types (binary data, Date, Map, Set, RegExp)
    if (auto builtin = ConvertBuiltinType(value, depth,
          [this](const Napi::Value& v, const int d) { return NapiToCoreInstance(v, d); })) {
      return std::move(*builtin);
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

Napi::Value LuaContext::ResultsToJs(const std::vector<lua_core::LuaPtr>& values) {
  if (values.empty()) return env.Undefined();
  if (values.size() == 1) return CoreToNapi(*values[0]);
  const Napi::Array array = Napi::Array::New(env, values.size());
  for (size_t i = 0; i < values.size(); ++i) array.Set(i, CoreToNapi(*values[i]));
  return array;
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
          // Values beyond ±(2^53 - 1) can't be represented exactly as a JS
          // Number, so emit a BigInt to preserve Lua's 64-bit integer.
          constexpr int64_t kMaxSafeInteger = 9007199254740991LL;  // 2^53 - 1
          if (v > kMaxSafeInteger || v < -kMaxSafeInteger) {
            return Napi::BigInt::New(env, v);
          }
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
          // The data is owned by a finalizer tied to the JS function, so it (and
          // its registry ref) is freed when the function is garbage-collected.
          auto* dataPtr = new LuaFunctionData(runtime, v, this, alive_);
          const Napi::Function fn =
            Napi::Function::New(env, LuaFunctionCallbackStatic, "luaFunction", dataPtr);
          // Non-writable + non-configurable: this External's finalizer owns the
          // LuaFunctionData that `fn` still calls through, so it must not be
          // deletable or reassignable from JS (L6).
          DefineHiddenProp(env, fn, "__luaFnOwner",
            Napi::External<LuaFunctionData>::New(env, dataPtr,
              [](Napi::Env, LuaFunctionData* d) { delete d; }),
            /*writable=*/false);
          return fn;
        } else if constexpr (std::is_same_v<T, lua_core::LuaThreadRef>) {
          // Return a coroutine object with the thread reference (data owned by the
          // External's finalizer).
          auto* dataPtr = new LuaThreadData(runtime, v);
          Napi::Object coro = Napi::Object::New(env);
          coro.Set("_coroutine", Napi::External<LuaThreadData>::New(env, dataPtr,
            [](Napi::Env, LuaThreadData* d) { delete d; }));
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
            // Lua-created userdata - wrap as opaque handle for round-trip (data
            // owned by the External's finalizer).
            auto* dataPtr = new LuaUserdataData(runtime, v);
            Napi::Object handle = Napi::Object::New(env);
            handle.Set("_userdata", Napi::External<LuaUserdataData>::New(env, dataPtr,
              [](Napi::Env, LuaUserdataData* d) { delete d; }));
            return handle;
          }
        } else if constexpr (std::is_same_v<T, lua_core::LuaTableRef>) {
          // Create a JS Proxy that preserves Lua metamethods. The trap data is
          // owned by the External's finalizer, tied to the proxy target's life.
          Napi::Object target = Napi::Object::New(env);

          auto* dataPtr = new LuaTableRefData(runtime, v, this, alive_);

          // Store _tableRef as non-enumerable on target for round-trip detection
          auto external = Napi::External<LuaTableRefData>::New(env, dataPtr,
            [](Napi::Env, LuaTableRefData* d) { delete d; });
          const auto Object = env.Global().Get("Object").As<Napi::Object>();
          const auto defineProperty = Object.Get("defineProperty").As<Napi::Function>();
          Napi::Object descriptor = Napi::Object::New(env);
          descriptor.Set("value", external);
          descriptor.Set("enumerable", Napi::Boolean::New(env, false));
          descriptor.Set("configurable", Napi::Boolean::New(env, true));
          defineProperty.Call({target, Napi::String::New(env, "_tableRef"), descriptor});

          // Create handler with traps. Root the owner External on each trap so
          // `delete proxy._tableRef` (which forwards to the target, removing only
          // that reference) can't free dataPtr while the traps still point at it
          // (H3). The target's _tableRef stays configurable so the Proxy ownKeys
          // invariant — ownKeys omits _tableRef — is not violated.
          Napi::Object handler = Napi::Object::New(env);
          auto addTrap = [&](const char* name,
                             Napi::Value (*cb)(const Napi::CallbackInfo&)) {
            Napi::Function fn = Napi::Function::New(env, cb, name, dataPtr);
            DefineHiddenProp(env, fn, "_tableOwner", external, /*writable=*/false);
            (void)handler.Set(name, fn);
          };
          addTrap("get", TableRefGetTrap);
          addTrap("set", TableRefSetTrap);
          addTrap("has", TableRefHasTrap);
          addTrap("ownKeys", TableRefOwnKeysTrap);
          addTrap("getOwnPropertyDescriptor", TableRefGetOwnPropertyDescriptorTrap);

          // Create Proxy
          auto ProxyCtor = env.Global().Get("Proxy").As<Napi::Function>();
          return ProxyCtor.New({target, handler});
        } else if constexpr (std::is_same_v<T, lua_core::HostFunctionName>) {
          // A JS function that crossed into Lua and came back: return the
          // original JS function if it's still registered.
          auto it = js_callbacks_.find(v.name);
          if (it != js_callbacks_.end()) return it->second.Value();
          return env.Undefined();
        }
        return env.Undefined();
      },
      value.value);
}

Napi::Value LuaContext::CreateCoroutine(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected a script string that returns a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Execute script and get function
  const std::string script = info[0].As<Napi::String>().Utf8Value();
  CallScope _cs(this);
  const auto res = runtime->ExecuteScript(script);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
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
  // Data owned by the External's finalizer, freed when the coroutine object is
  // garbage-collected.
  auto* threadDataPtr = new LuaThreadData(runtime, threadRef);

  Napi::Object coro = Napi::Object::New(env);
  coro.Set("_coroutine", Napi::External<LuaThreadData>::New(env, threadDataPtr,
    [](Napi::Env, LuaThreadData* d) { delete d; }));
  coro.Set("status", Napi::String::New(env, "suspended"));
  return coro;
}

Napi::Value LuaContext::ResumeCoroutine(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  // Clear the JS-error registry at the outermost entry so a staged error from a
  // prior resume (whose JS callback threw) can't accumulate — resume otherwise
  // has no CallScope and never consumes by id (L7).
  CallScope scope(this);
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Expected a coroutine object as first argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto coroObj = info[0].As<Napi::Object>();
  if (!coroObj.Has("_coroutine")) {
    Napi::TypeError::New(env, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Value externalVal = coroObj.Get("_coroutine");
  if (!externalVal.IsExternal()) {
    Napi::TypeError::New(env, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto* threadData = externalVal.As<Napi::External<LuaThreadData>>().Data();
  if (!threadData || !threadData->runtime) {
    Napi::Error::New(env, "Invalid coroutine reference").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Resuming a coroutine created by another context would run lua_resume with
  // this context's main state driving that context's thread — two unrelated Lua
  // states in one call (UB). Reject it, mirroring the round-trip identity checks
  // on table/userdata/class markers (M1).
  if (threadData->runtime.get() != runtime.get()) {
    Napi::Error::New(env, "coroutine belongs to a different Lua context")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // A released ref carries LUA_NOREF and a null thread pointer — resuming it
  // would drive lua_resume on nullptr. Surface a clear error instead.
  if (threadData->threadRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "coroutine has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Collect arguments (skip the first one which is the coroutine object). One
  // collector spans every argument so a later argument's conversion failure
  // sweeps the callbacks minted by the earlier ones (F1).
  JsCallbackCollectorScope collector(this);
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
  auto [status, values, error] = runtime->ResumeCoroutine(threadData->threadRef, args);

  // Build the result object
  const Napi::Object resultObj = Napi::Object::New(env);

  // Set status
  std::string statusStr;
  switch (status) {
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
  const Napi::Array valuesArr = Napi::Array::New(env, values.size());
  for (size_t i = 0; i < values.size(); ++i) {
    valuesArr.Set(i, CoreToNapi(*values[i]));
  }
  (void)resultObj.Set("values", valuesArr);

  // Set error if present
  if (error.has_value()) {
    // Consume any staged fidelity state (the js_error_registry_ entry and
    // last_error_value_) so it doesn't linger after this resume (L7). The
    // coroutine API surfaces the error as a string, so the reconstructed Error
    // object LuaErrorToJsValue returns is intentionally discarded.
    (void)LuaErrorToJsValue(error.value());
    resultObj.Set("error", Napi::String::New(env, error.value()));
  }

  return resultObj;
}
