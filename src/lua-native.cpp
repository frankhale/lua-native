#include "lua-native.h"
#include "lua-async-worker.h"

#include <cassert>
#include <cmath>
#include <iterator>
#include <limits>
#include <optional>
#include <functional>
#include <algorithm>

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

// --- Marker-External minting and reading (CR-15 F6) --------------------------
//
// The only two operations that should ever touch a marker External's payload.
// See the `lua_tags` block in lua-native.h for why the kind has to be checked
// and not just the provenance.

// Mints a branded External. The tag goes on immediately, so there is no window
// in which the External exists untagged and could be read as one.
template <typename T, typename Finalizer>
static Napi::External<T> NewTaggedExternal(const Napi::Env env, T* data,
                                           const napi_type_tag& tag,
                                           Finalizer finalizer) {
  const auto external = Napi::External<T>::New(env, data, finalizer);
  external.TypeTag(&tag);
  return external;
}

// Reads a marker External's payload, or nullptr if `value` is not an External
// of exactly this kind. `CheckTypeTag` returns false (rather than throwing) for
// an untagged or differently-branded External, so callers keep failing closed
// the same way they did when they only checked `IsExternal()`.
//
// Takes the value by const& and reads it **once**: several call sites used to
// do `obj.Has(k) && obj.Get(k).IsExternal()` and then a second `obj.Get(k)`,
// which a Proxy can answer differently each time.
template <typename T>
static T* TaggedData(const Napi::Value& value, const napi_type_tag& tag) {
  if (!value.IsExternal()) return nullptr;
  const auto external = value.As<Napi::External<T>>();
  if (!external.CheckTypeTag(&tag)) return nullptr;
  return external.Data();
}

// True when `value` is an instance of the named global constructor
// (e.g. "Map", "Set", "RegExp"). Robust against subclassing.
// The message for a caught Napi::Error.
//
// `Napi::Error::Message()` — and therefore `Napi::Error::what()` — reads
// `.message` off the thrown value, so it is **empty for every throw that is not
// an Error object**: `throw 'boom'`, `throw 42`, `throw null`. Sites that build
// a diagnostic out of it then report nothing at all. See the comment above
// StageJsError for the full history; this is the rule, and it is a free
// function so that every class in this file can reach it (CR-19 F3).
static std::string JsThrowMessage(const Napi::Error& e) {
  if (std::string message = e.Message(); !message.empty()) return message;
  const Napi::Value value = e.Value();
  if (value.IsEmpty()) return "JavaScript callback threw with no value";
  // ToString() runs user code (a hostile `toString`/`Symbol.toPrimitive`) and
  // is on an error path, so it cannot be allowed to throw again.
  try {
    return value.ToString().Utf8Value();
  } catch (...) {
    return "JavaScript callback threw a value that could not be converted to a string";
  }
}

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
static bool RejectIfWorkerBusy(const Napi::Env env, const LuaTableRefData* data) {
  if (!data || !data->ContextLive() || !data->context) {
    Napi::Error::New(env, std::string("Lua table handle is not usable: ") +
                          data->liveness.DeadReason())
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

// get_ref(key) — the explicit opt-in to a *reference* where get() would hand
// back a deep copy. A plain (metatable-less) nested table is otherwise
// unreachable from JS: it converts to a detached object, so mutating it does
// nothing to Lua and set_metatable has nothing to attach to.
static Napi::Value TableHandleGetRef(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "get_ref() requires a key argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    Napi::TypeError::New(env, "get_ref() key must be a string or number").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::variant<int, std::string> result;
  try {
    // The read runs __index, so it carries the same CallScope discipline as
    // get() (CR-8 F5).
    LuaContext::CallScope scope(data->context);
    result = data->runtime->GetTableFieldRef(data->tableRef.ref, key);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (const auto* error = std::get_if<std::string>(&result)) {
    Napi::Error::New(env, *error).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return data->context->CreateTableHandle(env, std::get<int>(result));
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
    // The one table-handle entry point that had no CallScope. Its neighbours'
    // comments explain theirs in terms of metamethods, and pairs() genuinely
    // fires none — lua_next is a raw traversal. That reasoning is about Lua and
    // says nothing about the *other* thing the scope guards: the CoreToNapi
    // calls below run the registered Lua->JS converters, which are user JS that
    // can call reset(). Without this line a converter could retire the state
    // mid-loop, and the remaining table values were then wrapped as handles
    // pairing the new runtime with this state's registry refs — reads and
    // writes landing on unrelated live objects, and a use-after-free of the
    // retired lua_State when the handle was finalized (CR-13 F1). It also
    // clears a staged js_error_registry_ entry at the outermost access, which
    // is the half of DEFERRED L7 that named the Proxy traps and missed this.
    LuaContext::CallScope scope(data->context);
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
    // (CR-8 F5). pairs() has one too: it fires no metamethod, but it converts
    // results through user JS like this one does (CR-13 F1).
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
    Napi::Error::New(env, std::string("Lua function is not usable: ") +
                          data->liveness.DeadReason())
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

  // Above the argument conversion, not just around the call: the converters it
  // runs are user JS, and one that called reset() left this frame calling into
  // the retired state with arguments — including any nested callbacks — minted
  // on the new one (CR-13 F1).
  LuaContext::CallScope _cs(data->context);

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
  const auto result = data->runtime->CallFunction(data->funcRef, args);

  // Handle error case
  if (std::holds_alternative<std::string>(result)) {
    data->context->ThrowLuaError(std::get<std::string>(result));
    return env.Undefined();
  }

  // Convert results back to JS (undefined / single value / array)
  return data->context->ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(result));
}

// --- SharedTable: JS-side state mirrored into several contexts ---

Napi::Function SharedTable::DefineSharedTable(const Napi::Env env) {
  return DefineClass(env, "SharedTable", {
    InstanceMethod("get", &SharedTable::Get),
    InstanceMethod("set", &SharedTable::Set),
    InstanceMethod("sync", &SharedTable::Sync)
  });
}

SharedTable::SharedTable(const Napi::CallbackInfo& info) : ObjectWrap(info) {
  const Napi::Env env_ = info.Env();
  // Brand the instance so AsSharedTable can ask what it *is* rather than what
  // its constructor claims. Applied at the one mint site there is; a second one
  // that forgot this would fail closed at the read, which is the right
  // direction to fail (see lua_tags).
  info.This().As<Napi::Object>().TypeTag(&lua_tags::kSharedTable);

  if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull()) {
    // IsObject() is true for functions too, so exclude them explicitly.
    if (!info[0].IsObject() || info[0].IsFunction()) {
      Napi::TypeError::New(env_,
        "createSharedTable(initial) requires an object")
        .ThrowAsJavaScriptException();
      return;
    }
    // Held, not copied: the caller keeps a usable handle on the shared state,
    // so mutating it directly and calling sync() is a supported workflow.
    value_ = Napi::Persistent(info[0].As<Napi::Object>());
  } else {
    value_ = Napi::Persistent(Napi::Object::New(env_));
  }
}

void SharedTable::PushValue(const Napi::Object& context, const std::string& name,
                            const Napi::Value& value) {
  const Napi::Env env_ = context.Env();
  const Napi::Value setter = context.Get("set_global");
  if (!setter.IsFunction()) {
    // Two different facts, and the old message asserted the wrong one: a
    // subscriber is always a real context (Subscribe is only ever called from
    // the constructor with `this`), so reaching here means its `set_global` has
    // been shadowed by an own property rather than that this is not a context
    // (CR-19 F5c).
    throw Napi::Error::New(env_,
      "shared table subscriber's set_global is not a function; it has been "
      "shadowed by an own property on the context");
  }
  // Routed through the context's own public set_global so a shared value gets
  // exactly the same treatment as any other JS value crossing into that state:
  // registered type converters, nested-callback handling, the busy guard, and
  // the protected write that turns an OOM into a JS error.
  (void)setter.As<Napi::Function>().Call(context,
    {Napi::String::New(env_, name), value});
}

void SharedTable::PushTo(const Napi::Object& context, const std::string& name) const {
  PushValue(context, name, value_.Value());
}

void SharedTable::Subscribe(const Napi::Object& context, const std::string& name) {
  // Push before recording, so a context whose initial push failed (and whose
  // construction is therefore about to fail) is never left in the subscriber
  // list as a target for later updates.
  PushValue(context, name, value_.Value());

  Subscriber sub;
  sub.context = Napi::Weak(context);
  sub.name = name;
  subscribers_.push_back(std::move(sub));
}

void SharedTable::Propagate(const Napi::Env env_) {
  // Snapshot the live subscribers first. Pushing runs user JS (type converters,
  // a __newindex host callback on the target global), which could construct
  // another context that subscribes to this table — mutating subscribers_ while
  // it is being iterated. Pruning collected entries happens here too, before
  // any JS runs.
  struct Target {
    Napi::Object context;
    std::string name;
  };
  std::vector<Target> targets;
  targets.reserve(subscribers_.size());

  auto live = subscribers_.begin();
  for (auto it = subscribers_.begin(); it != subscribers_.end(); ++it) {
    const Napi::Object ctx = it->context.Value();  // weak: empty once collected
    if (ctx.IsEmpty()) continue;                   // drop the dead entry
    targets.push_back({ctx, it->name});
    if (live != it) *live = std::move(*it);
    ++live;
  }
  subscribers_.erase(live, subscribers_.end());

  std::string failures;
  size_t failed = 0;
  for (const auto& target : targets) {
    try {
      // Re-read per target rather than snapshotting before the loop. A push
      // runs user JS (a type converter, a __newindex on the target global) that
      // can call set()/sync() re-entrantly, and CR-12 F5 read the pre-loop
      // snapshot as leaving the remaining targets a generation behind.
      //
      // It does not, today, and the honest note is why: set() *mutates* the
      // object value_ holds rather than replacing it, so a snapshot is a handle
      // to that same object and each push converts its current contents — a
      // re-entrant update is already visible to every later target. Verified
      // both ways; the re-entrancy test in the suite passes with either form.
      // The re-read is kept because it makes that independent of a property no
      // caller states: the day value_ is reassigned rather than mutated, the
      // snapshot silently becomes the stale read CR-12 F5 described, and this
      // line is what stops it.
      PushValue(target.context, target.name, value_.Value());
    } catch (const Napi::Error& e) {
      // Keep going: one unavailable context (busy with an async op, say) must
      // not silently skip the updates the others can still receive.
      ++failed;
      if (!failures.empty()) failures += "; ";
      failures += target.name;
      failures += ": ";
      // JsThrowMessage, not Message(): a subscriber that throws a non-Error
      // otherwise contributes an empty cause and the aggregate reads
      // "(settings: )" (CR-19 F3).
      failures += JsThrowMessage(e);
    }
  }

  if (failed > 0) {
    throw Napi::Error::New(env_,
      "shared table update failed for " + std::to_string(failed) + " of " +
      std::to_string(targets.size()) + " contexts (" + failures +
      "). The JS-side value was updated; call sync() to retry.");
  }
}

// clang-tidy is right that this reads nothing but `value_` — and it cannot be
// const anyway. `ObjectWrap::InstanceMethod` takes
// `Napi::Value (T::*)(const CallbackInfo&)`; node-addon-api declares no
// const-qualified variant, so adding `const` here stops the member-function
// pointer matching any overload and DefineSharedTable fails to compile with
// "no viable function" at the registration site, not here. Set() and Sync()
// escape the warning only because they call the non-const Propagate().
// NOLINTNEXTLINE(readability-make-member-function-const)
Napi::Value SharedTable::Get(const Napi::CallbackInfo& info) {
  const Napi::Env env_ = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "get(key) requires a string key")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  return value_.Value().Get(info[0].As<Napi::String>());
}

Napi::Value SharedTable::Set(const Napi::CallbackInfo& info) {
  const Napi::Env env_ = info.Env();
  if (info.Length() < 2 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "set(key, value) requires a string key and a value")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  (void)value_.Value().Set(info[0].As<Napi::String>(), info[1]);
  Propagate(env_);  // a failed push throws after every other context is updated
  return env_.Undefined();
}

Napi::Value SharedTable::Sync(const Napi::CallbackInfo& info) {
  const Napi::Env env_ = info.Env();
  Propagate(env_);
  return env_.Undefined();
}

// Resolves a `shared` option entry to its SharedTable, or nullptr if the value
// wasn't minted by createSharedTable().
//
// **The guard is the type tag, and two earlier comments here each named a
// different wrong thing (CR-15 F5, CR-20 F5, CR-21 A5).** The history is worth
// three lines because both wrong answers were argued for in prose and believed:
//
//   1. "`InstanceOf` identifies it." False: `napi_instanceof` is the JS
//      `instanceof` operator, so it consults `Symbol.hasInstance` — and the
//      constructor, though never exported, is reachable as
//      `createSharedTable().constructor`. Four lines of JS defeat it.
//   2. "Then `Unwrap` is what holds the line." Also false, and this one aborted
//      the process. `napi_unwrap` is **not a type check**: it returns whatever
//      pointer was attached, so an object wrapped by a *different* ObjectWrap
//      subclass unwraps "successfully" into a wrongly-typed pointer. A
//      LuaContext was accepted as a SharedTable and reinterpreted (SIGABRT).
//
// What actually holds is `CheckTypeTag` below — a 128-bit brand written at mint
// time, which JS cannot reach at all. `Unwrap` stays, but as the accessor it is
// (contained, see below), not as a guard. Do not reinstate either claim above.
static SharedTable* AsSharedTable(const Napi::Env env, const Napi::Value& value) {
  if (!value.IsObject() || value.IsFunction()) return nullptr;
  const auto* data = env.GetInstanceData<AddonData>();
  if (!data || data->sharedTableConstructor.IsEmpty()) return nullptr;
  const auto obj = value.As<Napi::Object>();
  // The brand, and it is the whole type check (see the header).
  if (!obj.CheckTypeTag(&lua_tags::kSharedTable)) return nullptr;
  // `Unwrap` *throws* when it refuses, and this function's callers are written
  // for a nullptr. Two consequences, both fixed by containing it here:
  //
  //   * the raw N-API message ("Invalid argument") escaped in place of the
  //     caller's own — "shared.s must be a shared table created with
  //     createSharedTable()" — so the one error a user could act on never ran;
  //   * and it took *legitimate* calls with it. The constructor asks this
  //     question of the `shared` option object itself before asking it of each
  //     entry, so with a forgery active a correct `{ s: genuineSharedTable }`
  //     failed on the outer object and never reached the entry that was fine.
  //
  // Returning nullptr makes the predicate total: this answers "is this a shared
  // table", and "no" is an answer, not an exception.
  try {
    return SharedTable::Unwrap(obj);
  } catch (const Napi::Error&) {
    return nullptr;
  }
}

Napi::Object LuaContext::Init(const Napi::Env env, const Napi::Object exports) {
  const Napi::Function func = DefineClass(env, "LuaContext", {
    InstanceMethod("execute_script", &LuaContext::ExecuteScript),
    InstanceMethod("execute_file", &LuaContext::ExecuteFile),
    InstanceMethod("set_global", &LuaContext::SetGlobal),
    InstanceMethod("get_global", &LuaContext::GetGlobal),
    InstanceMethod("call", &LuaContext::Call),
    InstanceMethod("set_userdata", &LuaContext::SetUserdata),
    InstanceMethod("set_metatable", &LuaContext::SetMetatable),
    InstanceMethod("create_coroutine", &LuaContext::CreateCoroutine),
    InstanceMethod("resume", &LuaContext::ResumeCoroutine),
    InstanceMethod("close", &LuaContext::CloseCoroutine),
    InstanceMethod("resume_async", &LuaContext::ResumeAsync),
    InstanceMethod("execute_script_async", &LuaContext::ExecuteScriptAsync),
    InstanceMethod("execute_file_async", &LuaContext::ExecuteFileAsync),
    InstanceMethod("execute_async", &LuaContext::ExecuteAsync),
    InstanceMethod("call_async", &LuaContext::CallAsync),
    InstanceMethod("cancel", &LuaContext::Cancel),
    InstanceMethod("is_busy", &LuaContext::IsBusyMethod),
    InstanceMethod("add_search_path", &LuaContext::AddSearchPath),
    InstanceMethod("register_module", &LuaContext::RegisterModule),
    InstanceMethod("compile", &LuaContext::Compile),
    InstanceMethod("compile_file", &LuaContext::CompileFile),
    InstanceMethod("load_bytecode", &LuaContext::LoadBytecode),
    InstanceMethod("create_table", &LuaContext::CreateTableMethod),
    InstanceMethod("get_global_ref", &LuaContext::GetGlobalRef),
    InstanceMethod("create_environment", &LuaContext::CreateEnvironment),
    InstanceMethod("execute_script_in", &LuaContext::ExecuteScriptIn),
    InstanceMethod("get_memory_usage", &LuaContext::GetMemoryUsage),
    InstanceMethod("info", &LuaContext::Info),
    InstanceMethod("register_type_converter", &LuaContext::RegisterTypeConverter),
    InstanceMethod("register_from_lua_converter", &LuaContext::RegisterFromLuaConverter),
    InstanceMethod("register_class", &LuaContext::RegisterClass),
    InstanceMethod("pcall", &LuaContext::Pcall),
    InstanceMethod("set_print_handler", &LuaContext::SetPrintHandler),
    InstanceMethod("set_read_handler", &LuaContext::SetReadHandler),
    InstanceMethod("set_file_reader", &LuaContext::SetFileReader),
    InstanceMethod("set_hook", &LuaContext::SetHook),
    InstanceMethod("remove_hook", &LuaContext::RemoveHook),
    InstanceMethod("add_searcher", &LuaContext::AddSearcher),
    InstanceMethod("release", &LuaContext::Release),
    InstanceMethod("reset", &LuaContext::Reset),
    InstanceMethod("gc", &LuaContext::GC)
  });

  // The constructor is kept alive by the persistent reference InitModule stores
  // as instance data (and by `exports` itself), so no separate leaked
  // FunctionReference is needed here.
  (void)exports.Set(Napi::String::New(env, "init"), func);

  return exports;
}

// `sandbox_preset` is declared at constructor scope rather than beside the
// other library locals because the `allowBytecode` default it feeds is parsed
// in a later sibling block, not in the libraries block.
LuaContext::LuaContext(const Napi::CallbackInfo& info)
  : ObjectWrap(info), env(info.Env()) {

  // Check for options (second argument)
  bool sandbox_preset = false;
  if (info.Length() > 1 && info[1].IsObject()) {
    auto options = info[1].As<Napi::Object>();

    // Check for maxMemory option
    size_t max_memory = 0;
    bool has_max_memory = false;
    if (options.Has("maxMemory")) {
      if (auto memVal = options.Get("maxMemory"); memVal.IsNumber()) {
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

    // Check for timeout option (wall-clock execution limit, milliseconds)
    size_t timeout_ms = 0;
    bool has_timeout = false;
    if (options.Has("timeout")) {
      auto timeoutVal = options.Get("timeout");
      if (timeoutVal.IsNumber()) {
        double timeoutNum = timeoutVal.As<Napi::Number>().DoubleValue();
        if (timeoutNum < 0) {
          Napi::RangeError::New(env, "timeout must be a non-negative number").ThrowAsJavaScriptException();
          return;
        }
        timeout_ms = static_cast<size_t>(timeoutNum);
        has_timeout = true;
      } else if (!timeoutVal.IsUndefined() && !timeoutVal.IsNull()) {
        Napi::TypeError::New(env, "timeout must be a number").ThrowAsJavaScriptException();
        return;
      }
    }

    // Parse libraries
    std::vector<std::string> libraries;
    bool has_libraries = false;
    // Set by the 'sandbox' preset: clear dofile/loadfile after opening, and
    // default allowBytecode to off. Both are part of what makes that preset
    // sealed; see LuaRuntime::SandboxLibraries.
    bool seal_base_filesystem = false;
    // `strictConversion`: refuse the silent conversion losses instead of
    // performing them (LIMITATIONS §5). A wrong *type* here is rejected rather
    // than ignored, unlike `binaryStrings` below — the option exists to catch
    // mistakes, so `strictConversion: 'yes'` quietly meaning "off" would be the
    // exact failure it is meant to prevent.
    bool strict_conversion = false;
    if (options.Has("strictConversion")) {
      const Napi::Value strictVal = options.Get("strictConversion");
      if (strictVal.IsBoolean()) {
        strict_conversion = strictVal.As<Napi::Boolean>().Value();
      } else if (!strictVal.IsUndefined() && !strictVal.IsNull()) {
        Napi::TypeError::New(env, "strictConversion must be a boolean")
          .ThrowAsJavaScriptException();
        return;
      }
    }
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
        } else if (preset == "sandbox") {
          // 'safe' minus `package`, plus the base-library seal and a bytecode
          // default of off — the combination that is actually sealed against
          // untrusted code. See LuaRuntime::SandboxLibraries.
          libraries = lua_core::LuaRuntime::SandboxLibraries();
          seal_base_filesystem = true;
          sandbox_preset = true;
        } else {
          Napi::TypeError::New(env, "libraries must be 'all', 'safe', 'sandbox', or an array of library names").ThrowAsJavaScriptException();
          return;
        }
        has_libraries = true;
      } else {
        Napi::TypeError::New(env, "libraries must be 'all', 'safe', 'sandbox', or an array of library names").ThrowAsJavaScriptException();
        return;
      }
    }

    // Create runtime with appropriate constructor
    try {
      // `seal_base_filesystem` and `strict_conversion` live on RuntimeConfig, so
      // either one must take the config path even with no limits set — the
      // libraries-only constructor would silently drop them.
      if (has_max_memory || has_max_instructions || has_timeout ||
          seal_base_filesystem || strict_conversion) {
        lua_core::RuntimeConfig config;
        config.libraries = std::move(libraries);
        config.max_memory = max_memory;
        config.max_instructions = max_instructions;
        config.timeout_ms = timeout_ms;
        config.seal_base_filesystem = seal_base_filesystem;
        // Carried on the config, so reset() — which rebuilds from GetConfig() —
        // keeps the mode without a replay step.
        config.strict_conversion = strict_conversion;
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

  InstallRuntimeHandlers();

  if (info.Length() > 0 && info[0].IsObject()) {
    // Retained so reset() can re-register the same callbacks on a fresh state.
    callbacks_ref_ = Napi::Persistent(info[0].As<Napi::Object>());
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
      // `sandbox` defaults bytecode off — `string.dump` + `load` would
      // otherwise reach the bytecode loader and undo the point of the preset.
      // An explicit `allowBytecode: true` still wins, so the default is a
      // default and not a lock.
      const bool bytecode_explicit =
        options.Has("allowBytecode") && options.Get("allowBytecode").IsBoolean();
      const bool bytecode_wanted =
        bytecode_explicit ? options.Get("allowBytecode").As<Napi::Boolean>().Value()
                          : !sandbox_preset;
      if (!bytecode_wanted) {
        allow_bytecode_ = false;
        runtime->SetAllowBytecode(false);  // E3
      }
      if (options.Has("binaryStrings") && options.Get("binaryStrings").IsBoolean() &&
          options.Get("binaryStrings").As<Napi::Boolean>().Value()) {
        binary_strings_ = true;
      }
      if (options.Has("print") && options.Get("print").IsFunction()) {
        InstallPrintHandler(options.Get("print").As<Napi::Function>());  // E1
      }
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return;
    }
  }

  // Shared state: subscribe to each SharedTable and publish its current value
  // as a global. Done last, because subscribing pushes the value through this
  // context's own set_global — which needs the runtime, the handlers, and the
  // type converters all in place. A failure here throws from `new`, so it must
  // be reported the way every other constructor failure is (a pending JS
  // exception, never a C++ throw unwinding out of a partially-built ObjectWrap).
  if (info.Length() > 1 && info[1].IsObject()) {
    const auto options = info[1].As<Napi::Object>();
    if (options.Has("shared")) {
      const Napi::Value sharedVal = options.Get("shared");
      if (!sharedVal.IsUndefined() && !sharedVal.IsNull()) {
        if (!sharedVal.IsObject() || sharedVal.IsArray() || sharedVal.IsFunction()) {
          Napi::TypeError::New(env,
            "shared must be an object mapping global names to shared tables")
            .ThrowAsJavaScriptException();
          return;
        }
        // A shared table handed over directly has no own enumerable keys, so it
        // would otherwise subscribe nothing at all — silently. Name the mistake.
        if (AsSharedTable(env, sharedVal)) {
          Napi::TypeError::New(env,
            "shared must be an object mapping global names to shared tables "
            "(e.g. { settings: sharedTable }), not a shared table itself")
            .ThrowAsJavaScriptException();
          return;
        }
        const auto sharedObj = sharedVal.As<Napi::Object>();
        const Napi::Array names = sharedObj.GetPropertyNames();
        for (uint32_t i = 0; i < names.Length(); ++i) {
          const std::string name = names.Get(i).As<Napi::String>().Utf8Value();
          const Napi::Value entry = sharedObj.Get(name);
          SharedTable* table = AsSharedTable(env, entry);
          if (!table) {
            Napi::TypeError::New(env,
              "shared." + name +
              " must be a shared table created with createSharedTable()")
              .ThrowAsJavaScriptException();
            return;
          }
          try {
            table->Subscribe(info.This().As<Napi::Object>(), name);
          } catch (const Napi::Error& e) {
            e.ThrowAsJavaScriptException();
            return;
          } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
            return;
          }
          // Retained so reset() can re-publish it onto the fresh state.
          shared_tables_.emplace_back(
            Napi::Persistent(entry.As<Napi::Object>()), name);
        }
      }
    }
  }
}

const ClassAccessor* LuaContext::FindClassAccessor(
    const std::string& class_name, const std::string& key) const {
  constexpr int kMaxClassDepth = 32;  // see the header
  std::string current = class_name;
  for (int depth = 0; depth < kMaxClassDepth && !current.empty(); ++depth) {
    const auto it = class_accessors_.find(current);
    if (it == class_accessors_.end()) return nullptr;
    if (const auto p = it->second.props.find(key); p != it->second.props.end()) {
      return &p->second;
    }
    current = it->second.parent;
  }
  return nullptr;
}

void LuaContext::InstallRuntimeHandlers() {
  // Set up userdata GC callback. The core has already dropped the Lua-side
  // method table by the time this runs; drop the JS half — the object reference
  // and the method callbacks minted alongside it — so a short-lived userdata
  // with methods doesn't pin them for the life of the context (CR-11 F4).
  runtime->SetUserdataGCCallback([this](int ref_id) {
    js_userdata_.erase(ref_id);
    if (const auto it = ud_method_fns_.find(ref_id); it != ud_method_fns_.end()) {
      for (const auto& func_name : it->second) {
        js_callbacks_.erase(func_name);
        runtime->RemoveHostFunction(func_name);
      }
      ud_method_fns_.erase(it);
    }
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
      // Named accessors (P2b) are consulted before the readable check, and win
      // over it: declaring `properties: { health: { get } }` is how a class
      // exposes exactly `health` while leaving the rest of the instance opaque.
      // Methods still take precedence over both, because ClassIndex resolves the
      // method table before it ever reaches a property handler.
      if (!it->second.class_name.empty()) {
        if (const ClassAccessor* acc = FindClassAccessor(it->second.class_name, key)) {
          if (acc->getter.IsEmpty()) {
            // Declared set-only. Refusing beats returning nil: nil is what an
            // absent property already means, so silently conflating the two
            // would hide the definition error this is reporting.
            throw std::runtime_error(
              "property '" + key + "' of class '" + it->second.class_name +
              "' is write-only");
          }
          // Materialize both the instance and the accessor function before
          // anything below can run user JS. `it` is invalidated by a rehash of
          // js_userdata_, and `acc` by a re-entrant register_class rehashing
          // class_accessors_ — both reachable from a JS getter (the CR-11 F5 /
          // CR-13 class). Neither pointer is named again after this line.
          const Napi::Object self = it->second.object.Value();
          const Napi::Function getter = acc->getter.Value();
          try {
            Napi::Value val = getter.Call(self, {self});
            return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val));
          } catch (const Napi::Error& e) {
            throw Napi::Error::New(env, JsThrowMessage(e));
          }
        }
      }
      if (!it->second.readable) {
        // PropertyAccessDenied, not runtime_error: this is the access-policy
        // refusal the core is allowed to report as nil on an object with
        // methods. A genuine failure below must not take that path.
        throw lua_core::PropertyAccessDenied("userdata is not readable");
      }
      // Catch Napi::Error ahead of the core's generic `catch (std::exception&)`
      // so a non-Error throw keeps its text: `what()` is empty for one, and the
      // core's "Error reading property '%s': %s" would end at the colon
      // (CR-18 F2).
      try {
        Napi::Value val = it->second.object.Value().Get(key);
        return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val));
      } catch (const Napi::Error& e) {
        throw Napi::Error::New(env, JsThrowMessage(e));
      }
    },
    // Setter (__newindex)
    [this](int ref_id, const std::string& key, const lua_core::LuaPtr& value) {
      Napi::HandleScope scope(env);
      auto it = js_userdata_.find(ref_id);
      if (it == js_userdata_.end()) return;
      // See the getter: accessors are consulted first and win over `writable`,
      // which is what makes a read-only field on an otherwise writable instance
      // expressible.
      if (!it->second.class_name.empty()) {
        if (const ClassAccessor* acc = FindClassAccessor(it->second.class_name, key)) {
          if (acc->setter.IsEmpty()) {
            throw std::runtime_error(
              "property '" + key + "' of class '" + it->second.class_name +
              "' is read-only");
          }
          // Materialize the instance and the accessor BEFORE converting the
          // value: CoreToNapi runs the Lua->JS converters, which are user JS and
          // can rehash js_userdata_ (invalidating `it`) or, via a re-entrant
          // register_class, class_accessors_ (invalidating `acc`). Written as
          // named locals rather than relying on C++17's sequencing of a member
          // call's postfix-expression before its arguments — the plain-property
          // path below does depend on that rule, and says so precisely because
          // it is too subtle to leave implicit twice.
          const Napi::Object self = it->second.object.Value();
          const Napi::Function setter = acc->setter.Value();
          try {
            setter.Call(self, {self, CoreToNapi(*value)});
          } catch (const Napi::Error& e) {
            throw Napi::Error::New(env, JsThrowMessage(e));
          }
          return;
        }
      }
      if (!it->second.writable) {
        throw lua_core::PropertyAccessDenied("userdata is not writable");
      }
      // Order-critical, and correct only because C++17 sequences a member
      // call's postfix-expression before its arguments: `it` is dereferenced
      // and the Napi::Object materialized BEFORE CoreToNapi runs the Lua→JS
      // converters, which can register a userdata and rehash js_userdata_
      // (invalidating `it`). Do not hoist the argument into a local declared
      // above this line, and do not rewrite it as `auto& e = it->second; …` —
      // either form reintroduces a use-after-invalidate that no test can see,
      // since the language, not the code, is what currently enforces it
      // (CR-13's "verified and rejected"; comment added by CR-14 F5).
      try {
        it->second.object.Value().Set(key, CoreToNapi(*value));
      } catch (const Napi::Error& e) {
        throw Napi::Error::New(env, JsThrowMessage(e));  // see the getter (CR-18 F2)
      }
    }
  );
}

void LuaContext::DetachRuntimeHandlers() const {
  if (!runtime) return;
  runtime->SetUserdataGCCallback(nullptr);
  runtime->SetHostFunctionGCCallback(nullptr);
  runtime->SetPropertyHandlers(nullptr, nullptr);
  runtime->SetOutputHandler(nullptr);
  // DropInputHandler, not SetInputHandler(nullptr), for the reason spelled out
  // for the file reader below: the latter removes a synthesized `io` through
  // RunProtected and can therefore throw. Same UNGUARDED_AND_PROPAGATES shape.
  runtime->DropInputHandler();
  // DropFileReader, not SetFileReader(nullptr): the latter removes the
  // dofile/loadfile globals through RunProtected, which can throw, and this
  // function is on the reset/teardown path where an escaping exception reaches
  // N-API (CR-6 F1). The state is about to be replaced, so there is nothing to
  // remove the globals from. Flagged here by the core-call-guarding invariant as
  // UNGUARDED_AND_PROPAGATES.
  runtime->DropFileReader();
  // lua_close fires __gc metamethods, which run Lua code — a line hook would
  // otherwise call into a context that is being torn down or repopulated.
  runtime->RemoveDebugHook();
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

// Splits a dotted global path ("config.db.host") into its segments. Returns
// false for a malformed path — any empty segment from a leading, trailing, or
// doubled dot (".a", "a.", "a..b") — so the caller can reject it with a clear
// error. A name with no dot yields a single-element vector (but the callers
// only reach this on a name that contains a dot).
static bool SplitGlobalPath(const std::string& name, std::vector<std::string>& out) {
  out.clear();
  size_t start = 0;
  while (true) {
    const size_t dot = name.find('.', start);
    std::string seg = name.substr(
      start, dot == std::string::npos ? std::string::npos : dot - start);
    if (seg.empty()) return false;  // empty segment => malformed path
    out.push_back(std::move(seg));
    if (dot == std::string::npos) break;
    start = dot + 1;
  }
  return true;
}

Napi::Value LuaContext::SetGlobal(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected string name as first argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  // A metatabled _G runs its __newindex here, which can reach a throwing host
  // callback that stages a js_error_registry_ entry. Scope the whole method so
  // that entry is cleared at the next outermost call instead of accumulating —
  // the CR-8 F5 discipline, applied to the global-access surface it did not
  // sweep (CR-9 F1).
  CallScope _cs(this);

  // A dotted name addresses a nested field: config.db.host = value, creating
  // missing intermediate tables. Functions take the reclaimable nested-closure
  // path (via NapiToCoreInstance) rather than the named-persistent top-level
  // registration below — a nested field is conceptually an anonymous value.
  if (name.find('.') != std::string::npos) {
    std::vector<std::string> path;
    if (!SplitGlobalPath(name, path)) {
      Napi::TypeError::New(env, "Invalid global path '" + name +
        "': path segments must be non-empty (no leading, trailing, or doubled dots)")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    try {
      runtime->SetGlobalPath(
        path, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[1])));
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    }
    return env.Undefined();
  }

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

  // See SetGlobal: a metatabled _G runs its __index here, so scope the method
  // to keep staged js_error_registry_ entries from accumulating (CR-9 F1).
  CallScope _cs(this);

  // A dotted name reads a nested field: config.db.host. A nil anywhere along
  // the path yields null (optional chaining), matching how a missing single
  // global reads back as null.
  if (name.find('.') != std::string::npos) {
    std::vector<std::string> path;
    if (!SplitGlobalPath(name, path)) {
      Napi::TypeError::New(env, "Invalid global path '" + name +
        "': path segments must be non-empty (no leading, trailing, or doubled dots)")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    try {
      auto result = runtime->GetGlobalPath(path);
      return CoreToNapi(*result);
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

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

// call(name, ...args) — invoke a Lua function by global name (F2).
//
// Sugar over get_global() + calling the returned wrapper, but it never mints
// that wrapper: the function stays a core LuaFunctionRef that is called and
// dropped, so a hot call loop doesn't leave a JS function object (and its
// registry slot) behind on every iteration. `name` accepts a dotted path, the
// same as get_global.
Napi::Value LuaContext::Call(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "call(name, ...args) requires a string name")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  // Opened *above* the lookup, not after it: resolving `name` goes through the
  // protected global path, so a metatabled _G runs its __index — Lua, and from
  // there a host callback — before the call itself begins (CR-9 F1).
  CallScope scope(this);

  lua_core::LuaPtr target;
  try {
    if (name.find('.') != std::string::npos) {
      std::vector<std::string> path;
      if (!SplitGlobalPath(name, path)) {
        Napi::TypeError::New(env, "Invalid global path '" + name +
          "': path segments must be non-empty (no leading, trailing, or doubled dots)")
          .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      target = runtime->GetGlobalPath(path);
    } else {
      target = runtime->GetGlobal(name);
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Only a genuine Lua function is accepted. A callable table (one with __call)
  // arrives as a LuaTableRef, not a function ref, and calling it would need a
  // different core entry point — get_global() still returns a Proxy for it.
  if (!target || !std::holds_alternative<lua_core::LuaFunctionRef>(target->value)) {
    Napi::TypeError::New(env,
      "Lua global '" + name + "' is not a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // One collector spans every argument so a later argument's conversion failure
  // sweeps the reclaimable callbacks minted by the earlier ones (CR-8 F1).
  JsCallbackCollectorScope collector(this);
  std::vector<lua_core::LuaPtr> args;
  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  try {
    for (size_t i = 1; i < info.Length(); ++i) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[i])));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto result =
    runtime->CallFunction(std::get<lua_core::LuaFunctionRef>(target->value), args);
  if (std::holds_alternative<std::string>(result)) {
    ThrowLuaError(std::get<std::string>(result));
    return env.Undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(result));
}

Napi::Value LuaContext::SetUserdata(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  // At entry, above the options / methods property reads below — any of which
  // can be a getter that re-enters this context (CR-13 F1).
  CallScope _cs(this);
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

  int ref_id;
  try {
    ref_id = NextUserdataId();
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

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
    // The global write fires __newindex on a metatabled _G — Lua, and from
    // there a host callback (CR-9 F1); the method-entry scope above covers it.
    // Not a declaration-in-condition: the name is unused in both branches, and
    // the init-statement form warns (-Wunused-but-set-variable) (CR-15 F6).
    if (readable || writable || has_methods) {
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
      // Recorded only once the whole build succeeded, so the failure path below
      // — which erases the same names itself — is the only cleanup on that
      // route. From here the userdata's own __gc owns their lifetime (CR-11 F4).
      ud_method_fns_[ref_id] = registered_method_fns;
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
  // At entry, above every `def.Get(...)` below: each of those can run a hostile
  // getter or Proxy trap — the N3 threat model this method already defends
  // against — and one that called reset() used to succeed, wiping
  // `registered_classes_` and with it the reservation two lines below. The L7
  // duplicate guard then reported success for a second registration of the same
  // name, and luaL_newmetatable half-merged the two definitions (CR-13 F1).
  CallScope _cs(this);
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env,
      "register_class(name, definition) requires a string name and an object")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string class_name = info[0].As<Napi::String>().Utf8Value();
  auto def = info[1].As<Napi::Object>();

  // Reject a duplicate class name before any callback is registered (L7).
  //
  // The binding's own ledger is the authority here, deliberately, and not the
  // core's registry: a registration that *failed* (a hostile `_G.__newindex`
  // rejecting the class global) has already created the class metatable via
  // luaL_newmetatable, so a registry probe would report the name as taken and
  // break the CR-8 F3 contract that a rolled-back registration is retryable.
  // "The state has a metatable under this name" and "this context registered
  // this class" are different questions; only the second one belongs here
  // (CR-12 F5, which suggested the probe — it does not work).
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

  // Inheritance (C4). The base must already be registered on THIS context: the
  // core chains method lookups through its registry entries, and a name this
  // context never registered would either be missing or — worse — belong to
  // whatever else happens to sit at that registry key.
  std::string parent_class;
  if (const Napi::Value extendsVal = def.Get("extends"); !extendsVal.IsUndefined() &&
      !extendsVal.IsNull()) {
    if (!extendsVal.IsString()) {
      Napi::TypeError::New(env,
        "register_class(): 'extends' must be the name of a registered class")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    parent_class = extendsVal.As<Napi::String>().Utf8Value();
    if (parent_class == class_name || !registered_classes_.count(parent_class)) {
      Napi::Error::New(env,
        "register_class(): base class '" + parent_class + "' is not registered")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

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

  // Statics (P2a) — validated up front, alongside the metamethods and for the
  // same reason (L4): a rejected definition must not have stranded anything.
  // Read once into a snapshot (N3); registration below never consults `def`
  // again. Functions and plain values are separated here because they take
  // different routes into the class table.
  std::vector<std::pair<std::string, Napi::Function>> static_fn_snapshot;
  std::vector<std::pair<std::string, Napi::Value>> static_val_snapshot;
  {
    const Napi::Value staticsVal = def.Get("statics");
    if (staticsVal.IsObject() && !staticsVal.IsFunction()) {
      auto statics = staticsVal.As<Napi::Object>();
      Napi::Array keys = statics.GetPropertyNames();
      for (uint32_t i = 0; i < keys.Length(); ++i) {
        std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
        if (key == "new") {
          Napi::TypeError::New(env,
            "register_class(): static 'new' is reserved — it is the constructor")
            .ThrowAsJavaScriptException();
          return env.Undefined();
        }
        Napi::Value val = statics.Get(key);
        if (val.IsFunction()) {
          static_fn_snapshot.emplace_back(std::move(key), val.As<Napi::Function>());
        } else {
          static_val_snapshot.emplace_back(std::move(key), val);
        }
      }
    }
  }

  // Named property accessors (P2b). Same snapshot discipline. Held in
  // class_accessors_ rather than pushed into Lua — see the member's comment.
  ClassAccessorTable accessors;
  accessors.parent = parent_class;
  {
    const Napi::Value propsVal = def.Get("properties");
    if (propsVal.IsObject() && !propsVal.IsFunction()) {
      auto props = propsVal.As<Napi::Object>();
      Napi::Array keys = props.GetPropertyNames();
      for (uint32_t i = 0; i < keys.Length(); ++i) {
        std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
        Napi::Value entryVal = props.Get(key);
        if (!entryVal.IsObject() || entryVal.IsFunction()) {
          Napi::TypeError::New(env,
            "register_class(): property '" + key + "' must be an object with "
            "'get' and/or 'set' functions")
            .ThrowAsJavaScriptException();
          return env.Undefined();
        }
        auto entry = entryVal.As<Napi::Object>();
        const Napi::Value getVal = entry.Get("get");
        const Napi::Value setVal = entry.Get("set");
        const bool hasGet = getVal.IsFunction();
        const bool hasSet = setVal.IsFunction();
        if (!hasGet && !hasSet) {
          // A property with neither half is inert, and inert-by-typo is exactly
          // what a definition-time check is for.
          Napi::TypeError::New(env,
            "register_class(): property '" + key + "' declares neither 'get' nor 'set'")
            .ThrowAsJavaScriptException();
          return env.Undefined();
        }
        ClassAccessor acc;
        if (hasGet) acc.getter = Napi::Persistent(getVal.As<Napi::Function>());
        if (hasSet) acc.setter = Napi::Persistent(setVal.As<Napi::Function>());
        accessors.props.emplace(std::move(key), std::move(acc));
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

  // Statics (P2a), from the snapshot. Functions become host-function closures
  // on the class table; other values are converted once, here, and placed
  // directly — a static is a class-level constant, not a live view of the JS
  // property, and converting at registration is what makes that true.
  std::vector<lua_core::MetatableEntry> statics;
  statics.reserve(static_fn_snapshot.size() + static_val_snapshot.size());
  for (const auto& [key, fn] : static_fn_snapshot) {
    std::string func_name = "__class_static_" + std::to_string(class_id) + "_" + key;
    deferred_fns.emplace_back(func_name, fn);
    lua_core::MetatableEntry entry;
    entry.key = key;
    entry.is_function = true;
    entry.func_name = std::move(func_name);
    statics.push_back(std::move(entry));
  }
  for (const auto& [key, val] : static_val_snapshot) {
    lua_core::MetatableEntry entry;
    entry.key = key;
    entry.is_function = false;
    try {
      entry.value = std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val));
    } catch (const Napi::Error& e) {
      // Conversion runs user JS (a converter, a Proxy trap) and can throw.
      // Nothing is registered yet and the reservation guard releases the name.
      e.ThrowAsJavaScriptException();
      return env.Undefined();
    } catch (const std::exception& e) {
      Napi::Error::New(env,
        "register_class(): static '" + key + "': " + e.what())
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    statics.push_back(std::move(entry));
  }

  // RegisterClass builds inside RunProtected, which throws on OOM under
  // maxMemory or a raising __newindex on a _G metatable at the class-global
  // write. Surface that as a JS error: letting a std::runtime_error unwind
  // across the N-API boundary terminates the process (the H1 class).
  try {
    // The class-global write fires __newindex on a metatabled _G (CR-9 F1);
    // the method-entry scope above already covers it.
    runtime->RegisterClass(class_name, ctor_name, method_map, metamethods,
                           parent_class, statics);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    // The reservation guard releases the name; nothing was registered, so
    // nothing is stranded (CR-8 F3).
    return env.Undefined();
  }

  // Deliberately NOT reserved as reclaimable the way set_metatable's and
  // register_module's entries are (CR-11 F4): a class registration cannot be
  // superseded — `registered_classes_` rejects a second use of the name — so
  // its constructor and methods are permanent by design, not stranded.
  js_callbacks_[ctor_name] = Napi::Persistent(constructFn);
  runtime->StoreHostFunction(ctor_name,
    CreateConstructorWrapper(ctor_name, class_name, readable, writable));
  for (auto& [func_name, fn] : deferred_fns) {
    js_callbacks_[func_name] = Napi::Persistent(fn);
    runtime->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }
  // Accessors go in with the rest, after the core build succeeded — an entry
  // here for a class the core rejected would answer property reads for a class
  // that does not exist.
  if (!accessors.props.empty() || !accessors.parent.empty()) {
    class_accessors_.emplace(class_name, std::move(accessors));
  }

  reservation.Commit();
  return env.Undefined();
}

// Defined further down, next to the table-reference API it belongs to.
static LuaTableRefData* TableRefDataFrom(const Napi::Value& value);

// set_metatable(target, metatable)
//
// `target` is either a global name (the original form) or a live table
// reference — a `create_table()` / `get_global_ref()` / `create_environment()`
// handle, or the Proxy a metatabled table round-trips as (F1). The metatable is
// built identically either way; only the final attach differs, so both forms get
// the same deferred host-function registration and the same rollback on failure.
Napi::Value LuaContext::SetMetatable(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  // At entry, above the mt.GetPropertyNames()/mt.Get() reads below: a getter on
  // the definition object that called reset() used to succeed, which made the
  // target's identity check further down stale. The core call at the end then
  // paired the *new* runtime with the *old* state's registry ref and attached
  // the metatable to whatever unrelated object had inherited that slot
  // (CR-13 F1).
  CallScope _cs(this);

  // Resolve the target before touching the metatable definition, so a bad target
  // is rejected without minting any callback names.
  LuaTableRefData* targetRef = nullptr;
  std::string name;
  if (info.Length() >= 1 && info[0].IsString()) {
    name = info[0].As<Napi::String>().Utf8Value();
  } else if (info.Length() >= 1 && ((targetRef = TableRefDataFrom(info[0])))) {
    if (targetRef->runtime.get() != runtime.get()) {
      Napi::Error::New(env, "table handle belongs to a different Lua context")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (targetRef->tableRef.ref == LUA_NOREF) {
      Napi::Error::New(env, "table handle has been released")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  } else {
    Napi::TypeError::New(env,
      "set_metatable(target, metatable) requires a global name or a table handle")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (info.Length() < 2 || !info[1].IsObject() || info[1].IsFunction()) {
    Napi::TypeError::New(env, "set_metatable(): metatable must be an object")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto mt = info[1].As<Napi::Object>();
  const Napi::Array keys = mt.GetPropertyNames();

  uint64_t mt_id = next_metatable_id_++;
  std::vector<lua_core::MetatableEntry> entries;

  // One collector spans the whole entry build and the core call: the global form
  // validates its target only after every entry has been converted, so a
  // missing/non-table global discards them all. The destructor sweeps any
  // reclaimable callback that never reached Lua (CR-8 F1).
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

  // Reserve the names as reclaimable *before* the core call, so the closures it
  // builds carry the reclaim sentinel and this metatable's callbacks are
  // released once a later set_metatable supersedes it — previously they were
  // pinned for the life of the context (CR-11 F4). The reservation creates no
  // host_functions_/js_callbacks_ entry, so the CR-8 F3 ordering is unchanged;
  // the collector sweeps any reservation whose closure was never built.
  ReserveDeferredCallbacks(deferred_fns);

  try {
    // The global form reads _G[name] through the protected path, so a
    // metatabled _G runs its __index here (CR-9 F1); the method-entry scope
    // above already covers it.
    if (targetRef) {
      runtime->SetTableRefMetatable(targetRef->tableRef.ref, entries);
    } else {
      runtime->SetGlobalMetatable(name, entries);
    }
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
    // Reads and writes package.path, so a metatabled package runs its
    // __index/__newindex here (CR-9 F1).
    CallScope _cs(this);
    runtime->AddSearchPath(path);
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Recorded only after the core call succeeds, so a rejected path is never
  // replayed by reset().
  search_paths_.push_back(path);

  return env.Undefined();
}

Napi::Value LuaContext::RegisterModule(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  // At entry, above the module object's GetPropertyNames()/Get() reads below
  // (CR-13 F1).
  CallScope _cs(this);
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

  // See SetMetatable: reserved before the core call so re-registering the same
  // module name releases the previous generation's callbacks (CR-11 F4).
  ReserveDeferredCallbacks(deferred_fns);

  try {
    // Reads package / package.loaded, so a metatabled package runs its
    // __index here (CR-9 F1); the method-entry scope above covers it.
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

  // Above the options reads below, which can be accessors (CR-13 F1), as well
  // as the parse further down.
  CallScope _cs(this);

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

  // Compiling parses, parsing allocates, and an allocation can drive a GC step
  // whose __gc finalizers re-enter JS — so this runs Lua just as much as
  // execute_script does, and needs the same outermost scope (CR-10 F1); the
  // method-entry scope above covers it.
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

  // See Compile: above the options reads, which can be accessors (CR-13 F1).
  CallScope _cs(this);

  bool strip_debug = false;
  if (info.Length() >= 2 && info[1].IsObject()) {
    auto options = info[1].As<Napi::Object>();
    if (options.Has("stripDebug") && options.Get("stripDebug").IsBoolean()) {
      strip_debug = options.Get("stripDebug").As<Napi::Boolean>().Value();
    }
  }

  // The parse allocates and can reach a __gc finalizer (CR-10 F1); the
  // method-entry scope above covers it.
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
  // Take ownership of the caller's freshly-minted registry ref immediately:
  // LuaTableRef claims a share of the slot in its constructor, and the
  // unique_ptr releases it again if any N-API allocation below throws before
  // the External's finalizer becomes the owner. Without this, a throw between
  // the core call that minted the ref (get_global_ref, create_table,
  // create_environment, get_ref) and the External left the slot owned by
  // nobody (CR-9 F4).
  auto data = std::make_unique<LuaTableRefData>(
    runtime, lua_core::LuaTableRef(registry_ref, runtime->RawState()), this,
    Liveness());

  const Napi::Object handle = Napi::Object::New(env_);

  // The External's finalizer is the sole owner of dataPtr. Root it on _tableRef
  // AND on every method function below, so a method destructured off the handle
  // (`const { get } = handle; get(...)`) keeps the data alive instead of reading
  // freed memory once the handle object is collected. Non-configurable so it
  // can't be deleted to free the data out from under the still-bound methods —
  // the same ownership discipline used for __luaFnOwner (H3 / L6).
  const auto external = NewTaggedExternal(env_, data.get(), lua_tags::kTableRefData,
    [](Napi::Env, const LuaTableRefData* d) { delete d; });
  // Ownership has transferred: from here a throw leaves the External unrooted,
  // and its finalizer reclaims dataPtr (and the ref) when it is collected.
  LuaTableRefData* const dataPtr = data.release();
  DefineHiddenProp(env_, handle, "_tableRef", external, /*writable=*/false);

  auto addMethod = [&](const char* name,
                       Napi::Value (*cb)(const Napi::CallbackInfo&)) {
    const Napi::Function fn = Napi::Function::New(env_, cb, name, dataPtr);
    DefineHiddenProp(env_, fn, "_tableOwner", external, /*writable=*/false);
    (void)handle.Set(name, fn);
  };
  addMethod("get", TableHandleGet);
  addMethod("get_ref", TableHandleGetRef);
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
  // by the elements already converted (F1). The CallScope covers the user JS a
  // registered type converter can run during conversion (CR-9 F1).
  CallScope _cs(this);
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
  // That __index is Lua and can reach a host callback, so the read is scoped
  // like any other metamethod-capable operation (CR-9 F1).
  std::variant<int, std::string> result;
  try {
    CallScope _cs(this);
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

// Extracts the LuaTableRefData behind a table handle or a metatabled-table
// Proxy. Both carry the same `_tableRef` External — the Proxy's has/get traps
// answer for it explicitly — so one accessor serves both surfaces. Returns
// nullptr for anything else, leaving the caller to raise its own error.
static LuaTableRefData* TableRefDataFrom(const Napi::Value& value) {
  if (!value.IsObject()) return nullptr;
  // One Get, and the kind is checked as well as the shape: a genuine
  // `_coroutine` or `__luaFnOwner` External re-presented under this name is a
  // real External from this very context, so `IsExternal()` plus the caller's
  // runtime-identity check both agree (CR-15 F6).
  return TaggedData<LuaTableRefData>(value.As<Napi::Object>().Get("_tableRef"),
                                     lua_tags::kTableRefData);
}

// Builds an environment table: a fresh Lua table seeded with the whitelisted
// globals, handed back as an ordinary table handle so it can be inspected,
// extended (`env.set('helper', fn)`) and released like any other.
//
//   create_environment()                                  -> empty environment
//   create_environment({ whitelist: ['math', 'print'] })   -> only those names
//   create_environment({ whitelist: [...], inherit: true }) -> + _G fallback
Napi::Value LuaContext::CreateEnvironment(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  // At entry, above the options / whitelist-array reads below: both can be
  // Proxy-trapped or accessor-backed. CR-13 F1 could not drive a reset through
  // this one, which bounds the probe rather than the hazard — it is a member of
  // the class and is guarded like the rest of it.
  CallScope _cs(this);

  std::vector<std::string> whitelist;
  bool inherit = false;

  if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull()) {
    if (!info[0].IsObject() || info[0].IsArray() || info[0].IsFunction()) {
      Napi::TypeError::New(env, "create_environment() options must be an object")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const auto options = info[0].As<Napi::Object>();

    if (options.Has("whitelist")) {
      const Napi::Value list = options.Get("whitelist");
      if (!list.IsUndefined() && !list.IsNull()) {
        if (!list.IsArray()) {
          Napi::TypeError::New(env,
            "create_environment(): whitelist must be an array of strings")
            .ThrowAsJavaScriptException();
          return env.Undefined();
        }
        const auto arr = list.As<Napi::Array>();
        whitelist.reserve(arr.Length());
        for (uint32_t i = 0; i < arr.Length(); ++i) {
          const Napi::Value entry = arr.Get(i);
          if (!entry.IsString()) {
            Napi::TypeError::New(env,
              "create_environment(): whitelist entries must be strings")
              .ThrowAsJavaScriptException();
            return env.Undefined();
          }
          whitelist.push_back(entry.As<Napi::String>().Utf8Value());
        }
      }
    }

    if (options.Has("inherit")) {
      const Napi::Value v = options.Get("inherit");
      if (!v.IsUndefined() && !v.IsNull()) inherit = v.ToBoolean().Value();
    }
  }

  int ref;
  try {
    // Reading a whitelisted name can fire an __index on _G that re-enters JS.
    // The method-entry scope above already covers it — a second, shadowing
    // scope lived here until CR-14 F5, which made "find the first CallScope"
    // ambiguous in the one method that had two.
    ref = runtime->CreateEnvironment(whitelist, inherit);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return CreateTableHandle(env, ref);
}

// Runs a script with `env` as its _ENV. `env` is any table reference minted by
// this context — an environment from create_environment, or any table handle /
// metatabled-table Proxy, since an environment is nothing more than the table a
// chunk resolves its globals against.
Napi::Value LuaContext::ExecuteScriptIn(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 2 || !info[1].IsString()) {
    Napi::TypeError::New(env,
      "execute_script_in(env, script) requires an environment and a script string")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* data = TableRefDataFrom(info[0]);
  if (!data) {
    Napi::TypeError::New(env,
      "execute_script_in(): the first argument must be an environment or table reference")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Same policy as release() and the round-trip markers: a ref index minted by
  // another context (or by this one before a reset()) addresses an unrelated
  // slot in the current registry.
  if (data->runtime.get() != runtime.get()) {
    Napi::Error::New(env, "environment belongs to a different Lua context")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (data->tableRef.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string script = info[1].As<Napi::String>().Utf8Value();

  CallScope _cs(this);
  const auto res = runtime->ExecuteScriptInEnvironment(data->tableRef.ref, script);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return env.Undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

// NOLINTNEXTLINE(readability-make-member-function-const)
Napi::Value LuaContext::GetMemoryUsage(const Napi::CallbackInfo& /*info*/) {
  // A worker thread mutates the allocator counter during async execution;
  // reading it concurrently would be a data race.
  if (RejectIfBusy()) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(runtime->GetMemoryUsage()));
}

// State introspection: a diagnostics snapshot of this context — which Lua it is
// running, how much memory it currently holds, and the limits and libraries it
// was configured with. Everything here is read from state the runtime already
// tracks, so `info()` runs no Lua code and cannot fail.
//
// `memoryKB` is `memoryBytes / 1024` rather than a second reading via
// `gc('count')`: one source of truth means the two memory fields can never
// disagree, and it keeps this consistent with `get_memory_usage()`.
// NOLINTNEXTLINE(readability-make-member-function-const)
Napi::Value LuaContext::Info(const Napi::CallbackInfo& /*info*/) {
  // Same reason as get_memory_usage: a worker thread mutates the allocator
  // counter during async execution, so reading it concurrently is a data race.
  if (RejectIfBusy()) return env.Undefined();

  const auto memory_bytes = static_cast<double>(runtime->GetMemoryUsage());

  Napi::Object result = Napi::Object::New(env);
  (void)result.Set("version", Napi::String::New(env, lua_core::LuaRuntime::GetVersion()));
  (void)result.Set("release", Napi::String::New(env, lua_core::LuaRuntime::GetRelease()));
  (void)result.Set("versionNumber",
    Napi::Number::New(env, lua_core::LuaRuntime::GetVersionNumber()));
  (void)result.Set("memoryBytes", Napi::Number::New(env, memory_bytes));
  (void)result.Set("memoryKB", Napi::Number::New(env, memory_bytes / 1024.0));
  (void)result.Set("memoryLimit",
    Napi::Number::New(env, static_cast<double>(runtime->GetMemoryLimit())));
  (void)result.Set("maxInstructions",
    Napi::Number::New(env, static_cast<double>(runtime->GetMaxInstructions())));
  (void)result.Set("timeout",
    Napi::Number::New(env, static_cast<double>(runtime->GetTimeout())));

  // The libraries this state was opened with, verbatim from the config the
  // runtime kept — so a preset ('all'/'safe') reads back as the names it
  // expanded to, and a bare state as an empty array.
  const auto& libraries = runtime->GetConfig().libraries;
  Napi::Array libs = Napi::Array::New(env, libraries.size());
  for (size_t i = 0; i < libraries.size(); ++i) {
    (void)libs.Set(static_cast<uint32_t>(i), Napi::String::New(env, libraries[i]));
  }
  (void)result.Set("libraries", libs);

  (void)result.Set("bindingRefs", BindingRefCounts());

  return result;
}

// How many JS values this context's own bookkeeping is holding alive, by
// container. Diagnostic only: nothing in the binding reads these back, and no
// behaviour depends on them.
//
// **Why this is public API rather than a debug-build hook.** Both existing leak
// checks — `lifecycle-matrix`'s gc-churn high-water mark and `tools/gc-stress`'s
// aggregate balance — measure the *Lua registry*. The binding side had no
// accessor at all, so the containers below were the one part of this addon's
// memory that no instrument could see, on a platform where LeakSanitizer does
// not exist (`docs/SANITIZERS.md`). A debug-only counter would have left the
// shipped binary unmeasurable, which is the configuration a user actually runs.
// `CORRECTNESS.md` §15.10 records the decision.
//
// Each field is the count of *entries*, not of `Napi::Reference`s: an entry may
// hold more than one (a class accessor holds a getter and a setter). Counting
// entries is what the lifetime policies in `tools/binding-balance/policy.mjs`
// are stated in terms of, and a reference count would make a get-only property
// and a get/set property read differently for no reason a caller could act on.
//
// `total` is summed here rather than by the caller for the same reason
// `memoryKB` is divided here: one source of truth means the parts and the whole
// can never disagree.
Napi::Object LuaContext::BindingRefCounts() {
  // Accessors are stored per class, each class holding a map of named
  // properties; the interesting number is the properties, since that is what a
  // register_class call adds and what a leak would accumulate.
  size_t accessor_props = 0;
  for (const auto& [class_name, table] : class_accessors_) {
    accessor_props += table.props.size();
  }

  // The four redirection handlers share one counter: they have identical
  // lifetimes (set once, replayed across reset, dropped only at close), so
  // splitting them would be four columns that always move together.
  const size_t handlers =
    static_cast<size_t>(!print_handler_.IsEmpty()) +
    static_cast<size_t>(!read_handler_.IsEmpty()) +
    static_cast<size_t>(!file_reader_.IsEmpty()) +
    static_cast<size_t>(!debug_hook_.IsEmpty());

  // The async trio is transient by construction — held only between the start
  // of an async run and its settlement — which makes it the one group where a
  // non-zero reading at rest is itself the finding.
  const size_t async_refs =
    static_cast<size_t>(!async_coro_obj_.IsEmpty()) +
    static_cast<size_t>(!async_pending_promise_.IsEmpty()) +
    static_cast<size_t>(!async_self_ref_.IsEmpty());

  const size_t counts[] = {
    js_callbacks_.size(),
    js_userdata_.size(),
    ud_method_fns_.size(),
    js_error_registry_.size(),
    registered_classes_.size(),
    accessor_props,
    type_converters_.size(),
    from_lua_converters_.size(),
    searchers_.size(),
    shared_tables_.size(),
    handlers,
    async_refs,
    static_cast<size_t>(!callbacks_ref_.IsEmpty()),
  };
  static constexpr const char* kNames[] = {
    "callbacks", "userdata", "userdataMethods", "errorRegistry", "classes",
    "classAccessors", "typeConverters", "fromLuaConverters", "searchers",
    "sharedTables", "handlers", "asyncRefs", "callbacksObject",
  };
  static_assert(std::size(counts) == std::size(kNames),
                "every bindingRefs count needs a name");

  Napi::Object refs = Napi::Object::New(env);
  size_t total = 0;
  for (size_t i = 0; i < std::size(counts); ++i) {
    (void)refs.Set(kNames[i], Napi::Number::New(env, static_cast<double>(counts[i])));
    total += counts[i];
  }
  (void)refs.Set("total", Napi::Number::New(env, static_cast<double>(total)));
  return refs;
}

// Garbage-collector control: a thin pass-through to lua_gc, using Lua's own
// `collectgarbage` command vocabulary.
//
//   gc('collect' | 'stop' | 'restart')     -> undefined
//   gc('count')                            -> number (KB, fractional)
//   gc('isrunning')                        -> boolean
//   gc('step', stepSize?)                  -> boolean (step finished a cycle)
//   gc('incremental' | 'generational')     -> string  (the previous mode)
//   gc('param', name, value?)              -> number  (the previous value)
//
// No reentrancy guard beyond the busy check: unlike reset(), lua_gc is a normal
// API call that is safe with Lua frames live on the C stack — it is what the VM
// does implicitly on any allocation. Calling it from inside a __gc finalizer is
// the one exception, and Lua reports that itself (the core turns the -1 into a
// thrown error).
Napi::Value LuaContext::GC(const Napi::CallbackInfo& info) {
  // A worker thread owns the Lua state during async execution; collecting from
  // the main thread meanwhile would be a data race, and a finalizer reaching
  // the userdata GC callback would be an off-thread N-API call.
  if (RejectIfBusy()) return env.Undefined();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env,
      "gc(command) requires a command string (e.g. 'collect', 'count')")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string command = info[0].As<Napi::String>().Utf8Value();

  // 'collect' and 'step' run __gc finalizers, which are Lua and can re-enter a
  // host callback — the CR-9 F1 vector that needs no metatable at all. The core
  // brackets lua_gc itself; this scope additionally clears the JS-error
  // registry at the outermost entry, as every other Lua-running method does.
  CallScope _cs(this);

  try {
    if (command == "param") {
      if (info.Length() < 2 || !info[1].IsString()) {
        Napi::TypeError::New(env,
          "gc('param', name, value?) requires a parameter name string")
          .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      const std::string param = info[1].As<Napi::String>().Utf8Value();
      // Omitting the value reads the current setting without changing it, which
      // Lua spells as a negative value.
      int value = -1;
      if (info.Length() > 2 && !info[2].IsUndefined() && !info[2].IsNull()) {
        if (!info[2].IsNumber()) {
          Napi::TypeError::New(env, "gc('param', name, value): value must be a number")
            .ThrowAsJavaScriptException();
          return env.Undefined();
        }
        const double raw = info[2].As<Napi::Number>().DoubleValue();
        if (raw < 0 || raw > lua_core::LuaRuntime::kMaxGCParam) {
          Napi::RangeError::New(env,
            "gc('param', name, value): value must be between 0 and " +
            std::to_string(lua_core::LuaRuntime::kMaxGCParam))
            .ThrowAsJavaScriptException();
          return env.Undefined();
        }
        value = static_cast<int>(raw);
      }
      return Napi::Number::New(env, runtime->GarbageCollectParam(param, value));
    }

    size_t step_size = 0;
    if (command == "step" && info.Length() > 1 &&
        !info[1].IsUndefined() && !info[1].IsNull()) {
      if (!info[1].IsNumber()) {
        Napi::TypeError::New(env, "gc('step', stepSize): stepSize must be a number")
          .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      const double raw = info[1].As<Napi::Number>().DoubleValue();
      if (raw < 0) {
        Napi::RangeError::New(env,
          "gc('step', stepSize): stepSize must be non-negative")
          .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      step_size = static_cast<size_t>(raw);
    }

    const auto result = runtime->GarbageCollect(command, step_size);
    return std::visit([this](auto&& v) -> Napi::Value {
      using T = std::decay_t<decltype(v)>;
      if constexpr (std::is_same_v<T, double>) {
        return Napi::Number::New(env, v);
      } else if constexpr (std::is_same_v<T, bool>) {
        return Napi::Boolean::New(env, v);
      } else if constexpr (std::is_same_v<T, std::string>) {
        return Napi::String::New(env, v);
      } else {
        return env.Undefined();
      }
    }, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
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

// B3 — the Lua->JS half of the converter registry. See CoreToNapi for where the
// pair is consulted and why the converter's return value is used verbatim.
Napi::Value LuaContext::RegisterFromLuaConverter(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsFunction()) {
    Napi::TypeError::New(env,
      "register_from_lua_converter(match, convert) requires two functions")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  from_lua_converters_.emplace_back(
    Napi::Persistent(info[0].As<Napi::Function>()),
    Napi::Persistent(info[1].As<Napi::Function>()));
  return env.Undefined();
}

LuaContext::~LuaContext() {
  // Signal any outstanding function/table handles that their context is gone, so
  // a call after destruction fails cleanly instead of dereferencing freed memory.
  if (alive_) alive_->store(false);
  // Same signal for the host-function wrappers stored on the runtime. They are
  // reached from lua_close's __gc metamethods, which run *after* this body — at
  // process teardown, or at an arbitrary later GC if a handle still holds a
  // share of the runtime (CR-10 F2). Unlike alive_, this flag is never
  // re-minted, so a reset() does not disarm the wrappers of the live context.
  if (context_alive_) context_alive_->store(false);

  // Clear callbacks to prevent accessing member state during lua_close()
  DetachRuntimeHandlers();
  // DetachRuntimeHandlers unbinds the four handler slots, but the JS-callback
  // bridge lives in a map it does not own. Unbind it here — not in
  // DetachRuntimeHandlers, which reset() also calls and where the retiring
  // state's finalizers must still reach this (live) context. Belt and braces
  // with the liveness flag above: this makes a teardown finalizer fail at
  // lookup rather than relying on every wrapper remembering to check.
  if (runtime) runtime->ClearHostFunctions();
}

// The message for a caught Napi::Error.
//
// `Napi::Error::Message()` — and therefore `Napi::Error::what()` — reads
// `.message` off the thrown value, so it is **empty for every throw that is
// not an Error object**: `throw 'boom'`, `throw 42`, `throw null`. That empty
// string then becomes the caller's whole diagnostic, because the 45 binding
// catch sites are `catch (const std::exception& e)` and rebuild the error from
// `e.what()`. Driven at CR-18: a type converter that threw a string produced
// `Error` with no message at all, and the userdata property bridge produced
// "Error reading property 'p': " with nothing after the colon.
//
// The rule has existed at one site since it was written — StageJsError falls
// back to the value's string form, which is why a host function that throws a
// string reports it correctly. This is that rule in one place, applied at the
// four points that call user JS *without* going through StageJsError. Fixing
// the producers rather than the 45 consumers is deliberate: the consumers are
// correct given a correct `what()`, and a 45-site edit is exactly the kind of
// sweep that has introduced a fresh defect every time it has been done here.
//
// The definition is a file-scope free function rather than a member, and that
// is CR-19 F3: as a private static of LuaContext it was invisible to
// SharedTable, which formats a caught Napi::Error itself and so was the one
// consumer the producer-side fix could not reach. A rule with "one home" has to
// have a home every site can see.
std::string LuaContext::StageJsError(const Napi::Value& value,
                                     const std::string& message,
                                     const lua_core::LuaRuntime* owner) {
  // A raise on a runtime this context no longer owns cannot be delivered: see
  // the header. Staging it would strand a pending value and a js_error_registry_
  // entry on the *live* runtime, belonging to an execution on a different Lua
  // state (CR-12 F4). Only object errors carry structure worth preserving
  // either, so both cases fall back to the value's string form the same way.
  const bool deliverable = !owner || owner == runtime.get();
  if (!deliverable || !value.IsObject()) {
    return message.empty() ? value.ToString().Utf8Value() : message;
  }
  auto obj = value.As<Napi::Object>();

  const uint64_t id = next_js_error_id_++;
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
      // The field is a plain Lua number by the time it comes back, so anything
      // could be sitting in it — a hostile script can forge or mangle the id.
      // Negatives are rejected before the cast rather than wrapping into some
      // other live entry's key; a value we never minted simply misses.
      const int64_t raw = std::get<int64_t>(it->second->value);
      auto rit = raw < 0 ? js_error_registry_.end()
                         : js_error_registry_.find(static_cast<uint64_t>(raw));
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
  // The liveness flag travels with `this` for the same reason every other
  // cross-boundary holder carries one (H3 / H5 / CR-7 F1): this wrapper is
  // stored on the runtime, the runtime outlives the context whenever a handle
  // holds a share of it, and lua_close's __gc metamethods dispatch through
  // here. Without the check, a finalizer firing after ~LuaContext reads
  // js_callbacks_ and env out of freed memory (CR-10 F2).
  // `owner` is the runtime this wrapper is about to be stored on — captured for
  // identity only, and it cannot dangle, since the map that owns the wrapper
  // lives on that runtime. It tells StageJsError below whether the raise it is
  // staging for is happening on this context's *current* state or on a retired
  // one whose finalizers are still running (CR-12 F4).
  return [this, name, alive = context_alive_, owner = runtime.get()](
           const std::vector<lua_core::LuaPtr>& args) -> lua_core::LuaPtr {
    if (!alive || !alive->load()) {
      // Must precede every member access, including the HandleScope's `env`.
      // Throwing is the right shape: the bridge stages it as an ordinary Lua
      // error, and inside a finalizer Lua reports it as a warning.
      throw std::runtime_error(
        "JS callback '" + name + "' outlived its Lua context");
    }
    // Runs inside a Lua C frame; scope the per-call handles (args + result) so a
    // tight Lua loop calling this host function doesn't accumulate millions of
    // live handles until the enclosing script returns. The stashed
    // async_pending_promise_ is a Persistent (strong) ref and survives the scope.
    Napi::HandleScope scope(env);
    // Look the callback up explicitly: operator[] would default-construct an
    // empty FunctionReference for a missing name, and calling that is UB.
    const auto cbIt = js_callbacks_.find(name);
    if (cbIt == js_callbacks_.end()) {
      throw std::runtime_error("JS callback '" + name + "' is no longer registered");
    }
    // Materialize the callback before anything below can run user JS: a nested
    // registration can rehash js_callbacks_, which invalidates iterators (the
    // stored FunctionReference is stable, the iterator is not). Taking the
    // value now also gives this call the function it started with, even if the
    // entry is replaced mid-flight (CR-11 F5, the binding half of F2).
    const Napi::Function callback = cbIt->second.Value();
    std::vector<napi_value> jsArgs;
    jsArgs.reserve(args.size());
    for (const auto& a : args) {
      jsArgs.push_back(CoreToNapi(*a));
    }
    try {
      const Napi::Value result = callback.Call(jsArgs);
      if (result.IsPromise()) {
        if (!runtime->IsAwaitDriverMode()) {
          throw std::runtime_error(
            "'" + name + "' returned a Promise; call it inside execute_async(), "
            "call_async(), or resume_async() to await it");
        }
        // Stash the promise and signal LuaCallHostFunction to suspend.
        async_pending_promise_ = Napi::Persistent(result.As<Napi::Object>());
        runtime->RequestAwaitYield();
        return std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::nil());
      }
      return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(result));
    } catch (const Napi::Error& e) {
      throw std::runtime_error(StageJsError(e.Value(), JsThrowMessage(e), owner));
    }
  };
}

lua_core::LuaRuntime::Function LuaContext::CreateConstructorWrapper(
    const std::string& name, const std::string& class_name,
    bool readable, bool writable) {
  // See CreateJsCallbackWrapper for `owner` (CR-12 F4).
  return [this, name, class_name, readable, writable, alive = context_alive_,
          owner = runtime.get()](
      const std::vector<lua_core::LuaPtr>& args) -> lua_core::LuaPtr {
    // See CreateJsCallbackWrapper: this wrapper is stored on the runtime, which
    // can outlive the context, so check liveness before any member access
    // (CR-10 F2).
    if (!alive || !alive->load()) {
      throw std::runtime_error(
        "class '" + class_name + "' constructor outlived its Lua context");
    }
    // Bound the N-API handles created below (arg conversions, the constructed
    // instance, the hidden-prop temporaries) to this call. Without a scope,
    // `for i=1,1e6 do MyClass() end` would pile every iteration's handles into
    // the outer entry scope until the whole Lua execution returns (M11). Nothing
    // needs to escape: the instance survives via the Napi::Persistent below.
    Napi::HandleScope scope(env);
    const auto cbIt = js_callbacks_.find(name);
    if (cbIt == js_callbacks_.end()) {
      throw std::runtime_error(
        "Class '" + class_name + "' constructor is no longer registered");
    }
    // See CreateJsCallbackWrapper: take the function out of the map before any
    // user JS runs, so a rehash can't invalidate the iterator (CR-11 F5).
    const Napi::Function callback = cbIt->second.Value();
    std::vector<napi_value> jsArgs;
    jsArgs.reserve(args.size());
    for (const auto& a : args) {
      jsArgs.push_back(CoreToNapi(*a));
    }

    Napi::Value instance;
    try {
      instance = callback.Call(jsArgs);
    } catch (const Napi::Error& e) {
      throw std::runtime_error(StageJsError(e.Value(), JsThrowMessage(e), owner));
    }

    if (!instance.IsObject() || instance.IsArray() || instance.IsFunction()) {
      throw std::runtime_error(
        "Class '" + class_name + "' constructor must return an object");
    }

    // Register the new instance as JS-backed userdata.
    // Throws rather than wrapping; the bridge stages it as an ordinary Lua
    // error like any other constructor failure.
    const int ref_id = NextUserdataId();
    const auto instObj = instance.As<Napi::Object>();
    // Tag the instance so that passing the JS object back into Lua re-materializes
    // it as the same class userdata instead of deep-copying it to a table. The
    // owner markers say which state minted it, so a ref_id from a foreign
    // context isn't mistaken for one of our js_userdata_ slots (the ref_id alone
    // is just an integer and would collide across contexts — CR-2 M6).
    //
    // Two markers, and the *id* is the load-bearing one. The External wraps the
    // raw runtime pointer for identity comparison only — it never owns or
    // dereferences it, so no finalizer is needed, and that is exactly why it is
    // not sufficient on its own: a pointer identifies a runtime only while that
    // runtime is alive. Once a context is collected, the allocator hands its
    // block to the next `make_shared<LuaRuntime>`, and this instance would then
    // pass an unrelated live context's ownership check — reproduced, silently
    // aliasing that context's own userdata (CR-14 F2). LuaRuntime::Id() is
    // monotonic and never reused, so it cannot be recycled. Both must match;
    // the External stays because a genuine one cannot be minted from JS.
    DefineHiddenProp(env, instObj, "__luaClassRef", Napi::Number::New(env, ref_id));
    DefineHiddenProp(env, instObj, "__luaClassName", Napi::String::New(env, class_name));
    DefineHiddenProp(env, instObj, "__luaClassOwner",
      NewTaggedExternal(env, runtime.get(), lua_tags::kRuntimeOwner,
        [](Napi::Env, lua_core::LuaRuntime*) { /* non-owning: identity only */ }));
    DefineHiddenProp(env, instObj, "__luaClassOwnerId",
      Napi::BigInt::New(env, runtime->Id()));

    UserdataEntry entry;
    entry.object = Napi::Persistent(instObj);
    entry.readable = readable;
    entry.writable = writable;
    // Carries the link the property handlers need to reach this class's named
    // accessors (P2b); set_userdata instances leave it empty and keep the
    // readable/writable-only behavior.
    entry.class_name = class_name;
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
  //
  // **Dropping is_busy_ disarms the reset() guard.** Three sites marshal a
  // completed async run's values into JS, and marshalling runs user JS (the
  // Lua→JS converters) over values that still hold the *running* state's
  // registry refs. `is_busy_` is what refuses a reset() during that window, so
  // it may not be dropped while the conversion is outstanding:
  //
  //   DriveAsync (Finished)  — ResultsToJs, then FinishAsync(). Correct.
  //   OnAwaitSettled         — converts while the run is still engaged. Correct.
  //   both workers' OnOK     — call this first, so they open a CallScope
  //                            instead, which arms the other half of the guard
  //                            (CR-14 F1).
  //
  // A caller that clears the flag before converting and opens no scope has an
  // unguarded window; that is what CR-14 F1 was.
  runtime->ClearCancel();
  is_busy_ = false;
}

int LuaContext::NextUserdataId() {
  if (next_userdata_id_ == std::numeric_limits<int>::max()) {
    // Not reachable in any sane program (2^31 userdata registrations on one
    // context), and reset() deliberately does not rewind the counter, so the
    // only remedy is a new context. Refusing is still the right answer: the
    // alternative is UB, and a wrapped id would alias a live js_userdata_ entry.
    throw std::runtime_error(
      "userdata id space exhausted on this context (2^31 registrations); "
      "create a new context");
  }
  return next_userdata_id_++;
}

// The single place that maps a claim to the state that answers it, and the
// single place that turns a conflict into a JS error.
//
// **Evaluation is lazy and ordered, and that is a thread-safety requirement
// rather than an optimization.** `AsyncInFlight` is tested first and returns
// immediately, because every claim below it reads state a *worker thread*
// mutates: `lua_depth_` behind `IsExecuting()` is a plain int that the worker's
// ExecutionScope increments while it runs Lua off-thread. Past the first test we
// know `is_busy_` is false, and a worker can only be started from the main
// thread — which is the thread we are on — so nothing can begin owning the state
// underneath us and the remaining reads are single-threaded.
//
// An eager "compute the whole claim set" version of this function is a data
// race on every kSyncApi call site, which is exactly what the first draft of
// this refactor was; TSan reported it on the async tests. If a future claim
// needs state a worker touches, it must be atomic *or* ordered below this line.
//
// Claims are reported **most specific first**, so the message names the reason a
// reader can act on. Several are routinely true at once and the order decides
// which one the caller is told about, so it is a correctness property of the
// diagnostics rather than a style choice:
//
//   `Resetting` is tested LAST, because it is the least specific of the four —
//   it is true for the whole of reset()'s second half, and during that half a
//   more specific claim usually also holds and says *where* in it we are. Since
//   CR-15 gave the replay phase a CallScope, a reset() from a replay Proxy trap
//   holds Resetting **and** BindingCall; reported as Resetting it produces
//   "from inside a __gc finalizer of the state being retired", which is simply
//   false — no finalizer is involved. Reported as BindingCall it names the
//   Proxy trap, which is what the caller can act on. Resetting is then left
//   holding exactly the case nothing else can see: a finalizer of the retiring
//   state, firing inside lua_close, where `runtime` already points at the
//   replacement (so IsExecuting() is false) and the replay's scope is not yet
//   open (so call_depth_ is 0). That is the case it was written for.
//
// This ordering is what the four hand-written `if` blocks did before the
// occupancy refactor; unifying them moved Resetting to second and silently
// changed the message for the replay-trap case (CR-16 F3).
bool LuaContext::RejectIfOccupied(const char* op,
                                  const lua_occupancy::Claim disallowed,
                                  const char* detail) const {
  using lua_occupancy::Claim;
  const auto wants = [disallowed](const Claim c) {
    return lua_occupancy::Any(disallowed & c);
  };

  // The lazy-ordering safety argument above holds only if AsyncInFlight is
  // actually tested. A policy that names a claim below it without naming it
  // reads `lua_depth_` / `call_depth_` with a worker possibly running, which is
  // the data race TSan caught during the CR-15 refactor. Generative rather than
  // a list of policies to keep in sync: this fires for any caller, present or
  // future, that assembles such a policy (CR-16 F4).
  assert((!lua_occupancy::Any(disallowed & (Claim::LuaExecuting |
                                            Claim::BindingCall |
                                            Claim::Resetting)) ||
          wants(Claim::AsyncInFlight)) &&
         "an occupancy policy that tests any claim below AsyncInFlight must "
         "also test AsyncInFlight: the claims below it read state a worker "
         "thread mutates, and AsyncInFlight returning first is what makes "
         "those reads single-threaded");

  const char* reason = nullptr;
  bool parameterized = true;
  if (wants(Claim::AsyncInFlight) && is_busy_) {
    // Unchanged wording, and deliberately not parameterized by `op`: it predates
    // the occupancy model and a great many tests match on it verbatim.
    reason = "Lua context is busy with an async operation";
    parameterized = false;
  } else if (wants(Claim::LuaExecuting) && runtime && runtime->IsExecuting()) {
    reason = " cannot be called while Lua is executing (from inside a host "
             "callback, metamethod, or __gc finalizer)";
  } else if (wants(Claim::BindingCall) && call_depth_ > 0) {
    reason = " cannot be called from inside another lua-native call (a type "
             "converter, a definition-object getter, or a Proxy trap running "
             "while that call converts its arguments or results)";
  } else if (wants(Claim::Resetting) && in_reset_) {
    reason = " cannot be called re-entrantly (from inside a __gc finalizer of "
             "the state being retired)";
  } else {
    return false;
  }

  std::string message = parameterized ? (op ? op : "this operation") : "";
  message += reason;
  if (detail) {
    message += ": ";
    message += detail;
  }
  Napi::Error::New(env, message).ThrowAsJavaScriptException();
  return true;
}

bool LuaContext::RejectIfBusy() const {
  return RejectIfOccupied(nullptr, lua_occupancy::kSyncApi);
}

// NOLINTNEXTLINE(readability-make-member-function-const)
Napi::Value LuaContext::IsBusyMethod(const Napi::CallbackInfo& /*info*/) {
  return Napi::Boolean::New(env, is_busy_.load());
}

// Why the worker-async launchers use kExclusive: they hand the lua_State to a
// libuv thread, and a Lua state may be touched by one thread at a time. Stated
// once here rather than at both call sites.
static constexpr const char* kWorkerHandoffDetail =
  "handing the state to a worker thread requires that nothing else holds it";

// execute_script_async / execute_file_async run the script on a libuv worker
// thread: use them for CPU-bound Lua that shouldn't block the event loop, but
// note the script cannot call back into JS (host callbacks are disabled in
// async_mode_) and print redirection is bypassed. For Lua that needs to await JS
// Promises or invoke JS callbacks, use execute_async (coroutine-driven, stays on
// the main thread) instead.
Napi::Value LuaContext::ExecuteScriptAsync(const Napi::CallbackInfo& info) {
  if (RejectIfOccupied("execute_script_async()", lua_occupancy::kExclusive,
                       kWorkerHandoffDetail)) return env.Undefined();
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
  if (RejectIfOccupied("execute_file_async()", lua_occupancy::kExclusive,
                       kWorkerHandoffDetail)) return env.Undefined();
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
    // Scoped to the load alone, and deliberately not across the DriveAsync
    // below: the chunk parse allocates and can reach a __gc finalizer, and this
    // runs *before* is_busy_ is set, so nothing else guards the window
    // (CR-10 F1). Holding it open past this point would also leave call_depth_
    // raised across a suspended await.
    CallScope _cs(this);
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

  // Binding-owned thread: created for this run, released by FinishAsync.
  async_co_.emplace(std::move(std::get<lua_core::LuaThreadRef>(co)));
  // Initial resume takes no arguments — a chunk has no parameters.
  return BeginAsyncRun(info.This().As<Napi::Object>(), {});
}

// Arm the await driver on `thread` and take the first step. Shared by every
// door that runs Lua on the main-thread coroutine driver, so the doors cannot
// drift apart in what they arm — which is the failure P1 was reported for: a
// capability that worked through execute_async and nowhere else.
//
// Takes ownership of `thread`: FinishAsync releases it. `self` is the JS wrapper
// to root for the run's duration.
const lua_core::LuaThreadRef& LuaContext::AsyncDrivenThread() const {
  return async_co_ ? *async_co_ : async_borrowed_->threadRef;
}

Napi::Value LuaContext::BeginAsyncRun(const Napi::Object& self,
                                      const std::vector<lua_core::LuaPtr>& args,
                                      const char* arg_role) {
  is_busy_ = true;
  ++async_generation_;  // invalidate any stale settlement from a prior run
  js_error_registry_.clear();
  runtime->ClearCancel();
  runtime->SetAwaitDriverMode(true);
  // Tell the core which thread is the driver so a promise awaited from a
  // coroutine this run is *not* driving is rejected rather than yielding the
  // wrong state (M1). Under resume_async the caller's own coroutine is the
  // driven thread, which is exactly what lets it await.
  runtime->SetAwaitDriverThread(AsyncDrivenThread().thread);
  async_deferred_.emplace(Napi::Promise::Deferred::New(env));
  // Root the wrapping JS object for the run's duration: while the coroutine is
  // suspended awaiting a promise, the settlement callbacks hold only a raw
  // pointer to this context, so the ObjectWrap must not be collectible.
  async_self_ref_ = Napi::Persistent(self);

  Napi::Promise promise = async_deferred_->Promise();
  // The opening step, so `arg_role` describes what the *caller* handed over —
  // "argument" for call_async, resume values for the other two doors (CR-23 F5).
  DriveAsync(args, false, arg_role);
  return promise;
}

// Defined further down, next to the coroutine API its other callers belong to.
static LuaFunctionData* LuaFunctionDataFrom(const Napi::Value& value);

// call_async(nameOrFn, ...args) — P1a.
//
// The awaiting counterpart to call(). Before this existed, awaiting a host
// Promise required routing the call through execute_async as *script text*,
// which needs a name to call — so a LuaFunction held only on the JS side could
// not await at all — and which compiles a fresh chunk per call, reintroducing
// exactly the per-call cost call() was added to remove (F2).
//
// Mechanically this is execute_async with the coroutine seeded from a function
// ref instead of a compiled chunk, so the driver, the M1 guard, cancel() and the
// one-run-at-a-time rule are all the existing ones, unchanged.
Napi::Value LuaContext::CallAsync(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || (!info[0].IsString() && !info[0].IsFunction())) {
    Napi::TypeError::New(env,
      "call_async(nameOrFn, ...args) requires a global name or a Lua function")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Rejections rather than throws for everything past argument validation, so
  // `await` and `.catch` see failures uniformly — the same choice execute_async
  // makes for a chunk that fails to load.
  const auto reject = [this](const std::string& msg) -> Napi::Value {
    auto deferred = Napi::Promise::Deferred::New(env);
    deferred.Reject(Napi::Error::New(env, msg).Value());
    return deferred.Promise();
  };

  // One scope over every step that can run user JS — the marker read (a Proxy
  // trap), the global lookup (a metatabled _G's __index), the argument
  // conversion (a registered type converter), and the coroutine creation — and
  // closed before the drive below. Held across BeginAsyncRun it would leave
  // call_depth_ raised for the whole suspended await, which is why execute_async
  // scopes only its chunk load (CR-10 F1); opened any later, a Proxy trap on
  // info[0] would run before the guard is armed (CR-13 F1).
  std::optional<lua_core::LuaThreadRef> thread;
  std::vector<lua_core::LuaPtr> args;
  {
  CallScope _cs(this);

  std::optional<lua_core::LuaFunctionRef> funcRef;
  if (info[0].IsFunction()) {
    // Same identity checks create_coroutine and resume apply (M1): a ref from
    // another context names a slot in an unrelated registry, and a released one
    // names nothing.
    auto* fnData = LuaFunctionDataFrom(info[0]);
    if (!fnData) {
      Napi::TypeError::New(env,
        "call_async() accepts a global name or a Lua function; a plain "
        "JavaScript function is not callable in Lua")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (fnData->runtime.get() != runtime.get()) {
      return reject("Lua function belongs to a different Lua context");
    }
    if (fnData->funcRef.ref == LUA_NOREF) {
      return reject("Lua function has been released");
    }
    // Copying shares the registry slot rather than minting a second owner, so
    // the body outlives the JS wrapper for the run's duration.
    funcRef = fnData->funcRef;
  } else {
    const std::string name = info[0].As<Napi::String>().Utf8Value();
    lua_core::LuaPtr target;
    try {
      if (name.find('.') != std::string::npos) {
        std::vector<std::string> path;
        if (!SplitGlobalPath(name, path)) {
          return reject("Invalid global path '" + name +
            "': path segments must be non-empty (no leading, trailing, or doubled dots)");
        }
        target = runtime->GetGlobalPath(path);
      } else {
        target = runtime->GetGlobal(name);
      }
    } catch (const std::exception& e) {
      return reject(e.what());
    }
    // Only a genuine Lua function. A callable table (__call) arrives as a
    // LuaTableRef and would need a different core entry point — the same line
    // call() draws, and drawn the same way so the two doors agree.
    if (!target || !std::holds_alternative<lua_core::LuaFunctionRef>(target->value)) {
      return reject("Lua global '" + name + "' is not a function");
    }
    funcRef = std::get<lua_core::LuaFunctionRef>(target->value);
  }

  // One collector spans every argument so a later argument's conversion failure
  // sweeps the reclaimable callbacks minted by the earlier ones (CR-8 F1).
  {
    JsCallbackCollectorScope collector(this);
    args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
    try {
      for (size_t i = 1; i < info.Length(); ++i) {
        args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[i])));
      }
    } catch (const std::exception& e) {
      return reject(e.what());
    }
  }

  std::variant<lua_core::LuaThreadRef, std::string> co = std::string();
  try {
    co = runtime->CreateCoroutine(*funcRef);
  } catch (const std::exception& e) {
    return reject(e.what());
  }
  if (std::holds_alternative<std::string>(co)) {
    return reject(std::get<std::string>(co));
  }
  thread.emplace(std::move(std::get<lua_core::LuaThreadRef>(co)));
  }  // CallScope closes here — nothing below runs user JS before the drive

  // Binding-owned, like execute_async: the thread wraps the target function
  // for this call alone and nothing else refers to it.
  async_co_.emplace(std::move(*thread));
  // These are the caller's call arguments, not resume values — the one door
  // where the shared machinery's default vocabulary is wrong (CR-23 F5).
  return BeginAsyncRun(info.This().As<Napi::Object>(), args, "argument");
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

void LuaContext::DriveAsync(const std::vector<lua_core::LuaPtr>& args, bool is_error,
                            const char* arg_role) {
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
    step = runtime->ResumeAsyncStep(AsyncDrivenThread(), args, is_error, arg_role);
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
    if (!step.awaited || async_pending_promise_.IsEmpty()) {
      // A plain `coroutine.yield` rather than a suspension for a host Promise.
      //
      // `step.awaited` is the authority and `IsEmpty()` is only a belt-and-braces
      // second condition: the stash is written by the host-call wrapper *before*
      // the core checks whether this thread is the one being driven, so a
      // refused nested await (M1) leaves a promise behind. Reading the stash
      // alone therefore mistook the next plain yield for that await, attached to
      // the stale promise, and resumed the coroutine with a value it never asked
      // for. Drop any such residue here — nothing is going to consume it.
      async_pending_promise_.Reset();

      // What a plain yield *means* depends on the door.
      if (async_coroutine_mode_) {
        // resume_async: an ordinary suspension. Settle with the yielded values
        // and detach, leaving the caller's thread suspended and resumable — the
        // same shape resume() returns, so the two doors agree on everything but
        // the ability to await.
        //
        // Marshalling runs user JS (converters, defineProperty), so the
        // supersede re-check below is the same one the Finished branch makes
        // and for the same reason (CR-16 F1).
        const uint64_t yield_gen = async_generation_;
        auto yield_deferred = *async_deferred_;
        Napi::Value resolved;
        bool ok = true;
        std::string convErr;
        try {
          resolved = CoroutineResultToJs(async_coro_obj_.Value(),
                                         lua_core::CoroutineStatus::Suspended,
                                         step.values, std::nullopt);
        } catch (const std::exception& e) {
          ok = false;
          convErr = e.what();
        }
        if (AsyncRunSuperseded(yield_gen)) return;
        FinishAsync();
        if (ok) {
          yield_deferred.Resolve(resolved);
        } else {
          yield_deferred.Reject(Napi::Error::New(env,
            std::string("failed to convert yielded values: ") + convErr).Value());
        }
        return;
      }
      // execute_async / call_async: nothing here can resume it.
      auto deferred = *async_deferred_;
      FinishAsync();
      deferred.Reject(Napi::Error::New(env,
        "coroutine.yield is not supported at the top level of execute_async or "
        "call_async; only awaiting a host Promise suspends execution. Use "
        "resume_async() to drive a coroutine that yields").Value());
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
          [](Napi::Env, const AwaitCookie* c) { delete c; });
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
    if (!attached && !AsyncRunSuperseded(attach_gen)) {
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
  //
  // It can also run **user JS**, and that is the harder problem. `ResultsToJs`
  // consults the registered from-Lua converters and installs hidden props via a
  // patchable `Object.defineProperty`, so an arbitrary JS function runs between
  // the copy of the deferred taken below and the settle at the bottom. Almost
  // everything that function could do is refused — `is_busy_` is still true, so
  // the occupancy guard turns reset(), the worker launchers and every
  // synchronous method away. `cancel()` is the exception, deliberately and necessarily: it
  // is the one method that must work while busy. It settles this very deferred
  // and may start a replacement run, after which settling our copy concludes a
  // freed napi_deferred (CR-16 F1, deterministic SIGSEGV).
  //
  // So re-check before settling, exactly as OnAwaitSettled does after its own
  // marshal. This is the third of DriveAsync's three exits; the Awaiting branch
  // above already had the check and this one did not.
  const uint64_t settle_gen = async_generation_;
  auto deferred = *async_deferred_;

  // resume_async answers with the same `{ status, values, error? }` object
  // resume() does — including for a Lua error, which resume() reports in the
  // result rather than throwing. Mirroring it exactly is what makes the async
  // door a drop-in replacement; diverging on error handling alone would be the
  // sibling-doors-disagree defect this work exists to remove.
  if (async_coroutine_mode_) {
    Napi::Value resolved;
    bool ok = true;
    std::string convErr;
    const bool errored = step.state != lua_core::AsyncStepResult::State::Finished;
    try {
      resolved = CoroutineResultToJs(
        async_coro_obj_.Value(), lua_core::CoroutineStatus::Dead,
        errored ? std::vector<lua_core::LuaPtr>{} : step.values,
        errored ? std::optional<std::string>(step.error) : std::nullopt);
    } catch (const std::exception& e) {
      ok = false;
      convErr = e.what();
    }
    if (AsyncRunSuperseded(settle_gen)) return;
    FinishAsync();
    if (ok) {
      deferred.Resolve(resolved);
    } else {
      deferred.Reject(Napi::Error::New(env,
        std::string("failed to convert async result: ") + convErr).Value());
    }
    return;
  }

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
    if (AsyncRunSuperseded(settle_gen)) return;  // cancel() already settled it
    FinishAsync();
    if (ok) {
      deferred.Resolve(resolved);
    } else {
      deferred.Reject(Napi::Error::New(env,
        std::string("failed to convert async result: ") + convErr).Value());
    }
  } else {
    // Reconstruct the original JS Error if this was a raised JS callback error.
    // LuaErrorToJsValue runs no user JS today — it is a registry lookup and a
    // Napi::Error construction — so this branch is currently unreachable from a
    // hostile converter. The check is here anyway because that is a property of
    // LuaErrorToJsValue's body rather than of this call site, and CR-14 F2's
    // lesson was that a guard whose soundness lives somewhere else stops
    // holding without anyone editing the guard.
    Napi::Value errValue = LuaErrorToJsValue(step.error);
    if (AsyncRunSuperseded(settle_gen)) return;
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
  if (AsyncRunSuperseded(gen)) {
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
  if (AsyncRunSuperseded(gen)) {
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
    async_co_->release();  // binding-owned: this run created it
    async_co_.reset();
  }
  // Borrowed threads are never released here — the caller still holds the
  // coroutine object and may resume it again. Dropping the root is all this
  // run is entitled to do.
  async_borrowed_ = nullptr;
  async_coro_obj_.Reset();
  async_coroutine_mode_ = false;
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
  if (AsyncDriverEngaged()) {
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
    // promise settlement becomes a no-op (the driver is disengaged).
    //
    // For a resume_async run the thread is the *caller's*, so "abandon" means
    // detach and leave it suspended exactly where it stopped — it stays
    // resumable, the same end state an early `break` out of `for..of` produces.
    // FinishAsync releases only a binding-owned thread.
    const auto deferred = *async_deferred_;
    FinishAsync();
    deferred.Reject(Napi::Error::New(env, "execution cancelled").Value());
  } else if (is_busy_) {
    // A worker-thread run (execute_script_async / execute_file_async) is in
    // flight. It executes Lua synchronously off-thread, so it can only be
    // interrupted cooperatively: signal the runtime and let the instruction
    // count-hook (polls IsCancelRequested) abort the VM at the next check.
    //
    // It therefore takes effect exactly when that hook is installed, which
    // InstallExecutionHook does for *any* of three consumers: maxInstructions,
    // timeout, or a debug hook with a count interval. The older wording here
    // (and in DEFERRED L8, and in types.d.ts) said "only when maxInstructions
    // is set", which understated it — a timeout-only worker run cancels, and
    // the hook checks cancellation before either limit (CR-13 F2). With none of
    // the three set there is no hook and the run is genuinely uninterruptible.
    // The worker's OnOK/OnError clears the flag via ClearBusy (L8).
    runtime->RequestCancel();
  }
  return env.Undefined();
}

// NOLINTNEXTLINE(readability-make-member-function-const)
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
// NOLINTNEXTLINE(readability-make-member-function-const)
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

  // Each marker is read **once** and checked for kind as well as shape
  // (CR-15 F6). Both mattered here: the old form did `Has(k)` and then two
  // separate `Get(k)`s, which a Proxy can answer differently each time, and it
  // trusted the name rather than the payload — so
  // `release({ _coroutine: fn.__luaFnOwner })` reached `threadRef.release()` on
  // a LuaFunctionData, i.e. a shared_ptr reset at an offset chosen by the
  // caller. A wrong-kind External now reads as nullptr and falls through to the
  // "requires a Lua function, coroutine, or table reference" error below.
  if (target.IsFunction()) {
    const auto fn = target.As<Napi::Object>();
    if (auto* data = TaggedData<LuaFunctionData>(fn.Get("__luaFnOwner"),
                                                 lua_tags::kFunctionData)) {
      if (data->runtime.get() != runtime.get()) return rejectForeign();
      if (data->funcRef.ref != LUA_NOREF) data->funcRef.release();
      return env.Undefined();
    }
    Napi::TypeError::New(env,
      "release(value): the function is not a Lua function reference")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (target.IsObject()) {
    const auto obj = target.As<Napi::Object>();

    if (auto* data = TaggedData<LuaThreadData>(obj.Get("_coroutine"),
                                               lua_tags::kThreadData)) {
      if (data->runtime.get() != runtime.get()) return rejectForeign();
      if (data->threadRef.ref != LUA_NOREF) data->threadRef.release();
      return env.Undefined();
    }

    if (auto* data = TaggedData<LuaTableRefData>(obj.Get("_tableRef"),
                                                 lua_tags::kTableRefData)) {
      if (data->runtime.get() != runtime.get()) return rejectForeign();
      if (data->tableRef.ref != LUA_NOREF) data->tableRef.release();
      return env.Undefined();
    }
  }

  Napi::TypeError::New(env,
    "release(value) requires a Lua function, coroutine, or table reference")
    .ThrowAsJavaScriptException();
  return env.Undefined();
}

// Replaces the Lua state with a freshly-constructed one carrying the same
// configuration, then replays the context-level registrations (callbacks, print
// handler, bytecode guard, search paths) onto it.
//
// The outgoing runtime is *not* closed here. Every handle that crossed the
// boundary (function, coroutine, table, opaque userdata) holds a
// shared_ptr<LuaRuntime>, so the old state stays open — and its registry slots
// stay valid — for exactly as long as some handle can still reach it. Closing
// it out from under those handles would leave their registry refs (and the
// lua_State* their unref deleters captured) dangling. When the last handle is
// collected the old runtime is destroyed and its memory reclaimed; with no
// outstanding handles, that happens synchronously inside this call.
//
// Those handles are still invalidated: `alive_` is flipped and re-minted, so a
// pre-reset function/table handle fails cleanly, and the `data->runtime.get() ==
// runtime.get()` identity checks elsewhere (resume, release, round-trip markers)
// stop recognizing pre-reset coroutines and userdata as belonging to this
// context.
Napi::Value LuaContext::Reset(const Napi::CallbackInfo& /*info*/) {
  // reset() retires the lua_State, so *any* holder is a conflict — which is
  // what kRetireState says, and saying it is the entire guard. Four separate
  // `if` blocks used to live here, accumulated one per review pass (CR-9 added
  // the execution check, CR-13 the binding-call check, CR-15 the scope over the
  // replay), and each addition had to be re-derived from scratch because
  // nothing connected them. The claims and their messages now live in one place;
  // see lua_occupancy::Claim for why.
  //
  // Each claim still answers a different question, and the messages stay
  // distinct because CR-13 F1 was the cost of collapsing two of them:
  //
  //   LuaExecuting — Lua frames are live on this thread's C stack, and
  //     retiring the state would free the one they are executing on (CR-9 F1).
  //     The authority is the *core's* depth: it is maintained at every point
  //     Lua can start running, so a binding method cannot disarm it by omission.
  //   BindingCall — no Lua is running, but a method is mid-flight with user JS
  //     above a conversion that will touch Lua when it returns. Not a "second
  //     opinion" on the above; it covers a window IsExecuting() cannot see by
  //     construction (CR-13 F1).
  //   Resetting — swapping `runtime` below destroys the outgoing state, and
  //     lua_close fires its __gc finalizers *after* the member already points
  //     at the replacement, so a finalizer calling reset() would find a fresh
  //     runtime reporting depth 0 (CR-9 F1).
  if (RejectIfOccupied("reset()", lua_occupancy::kRetireState)) {
    return env.Undefined();
  }
  struct ResetFlag {
    bool& f;
    explicit ResetFlag(bool& b) : f(b) { f = true; }
    ~ResetFlag() { f = false; }
  } resetting(in_reset_);

  // Build the replacement first: if construction fails (allocation failure),
  // the context keeps its current, working state rather than being left
  // runtime-less.
  std::shared_ptr<lua_core::LuaRuntime> fresh;
  try {
    fresh = std::make_shared<lua_core::LuaRuntime>(runtime->GetConfig());
  } catch (const std::exception& e) {
    Napi::Error::New(env, std::string("reset failed: ") + e.what())
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Unbind the outgoing runtime before it can be destroyed: lua_close fires __gc
  // metamethods, and those must not reach members this call is about to clear
  // and repopulate.
  DetachRuntimeHandlers();

  // async_co_ is the one registry ref the context holds directly (rather than
  // through a handle that owns a shared_ptr to the runtime). Drop it while its
  // state is still guaranteed open — the unref deleter captured that raw
  // lua_State*. The kRetireState guard above means a run in flight can't reach
  // here, so this only covers a defensive residue.
  if (async_co_) {
    async_co_->release();  // binding-owned: this run created it
    async_co_.reset();
  }
  // Borrowed threads are never released here — the caller still holds the
  // coroutine object and may resume it again. Dropping the root is all this
  // run is entitled to do.
  async_borrowed_ = nullptr;
  async_coro_obj_.Reset();
  async_coroutine_mode_ = false;

  // Invalidate every outstanding handle, then mint a fresh flag for the handles
  // this state will hand out.
  if (alive_) alive_->store(false);
  alive_ = std::make_shared<std::atomic<bool>>(true);

  // Swap. This drops the context's share of the old runtime; it is destroyed
  // here iff no handle still holds one.
  runtime = std::move(fresh);

  // From here to the end of the method, reset() is no longer only the *guarded*
  // operation — it is a *holder*, and it runs user JS while holding.
  // RegisterCallbacks reads the callbacks object (a Proxy's get traps),
  // InstallPrintHandler and the SharedTable replay push through set_global (the
  // registered type converters), and all of it mutates the freshly minted
  // lua_State. Until CR-15 F1c nothing said so: `in_reset_` blocks a nested
  // reset() and nothing else, `is_busy_` is false by the guard at the top, and
  // reset() opens no scope — so a converter reached from the replay could hand
  // this brand-new state to a libuv worker (SIGSEGV in 4 of 10 runs) while the
  // replay below kept writing to it from this thread.
  //
  // Declaring the holding is what makes the launchers' kExclusive policy
  // sufficient: it tests `BindingCall`, and this scope is what answers yes. It
  // must come *after* the swap above, because lua_close fires the retiring
  // state's __gc finalizers inside that statement and those are still supposed
  // to reach `in_reset_`'s more specific diagnosis rather than this one.
  CallScope _cs(this);

  // Drop the bookkeeping that described the old state's contents. The id
  // counters are deliberately left alone: they must stay monotonic so a name or
  // ref_id minted before the reset can never collide with one minted after.
  js_callbacks_.clear();
  js_userdata_.clear();
  ud_method_fns_.clear();  // the userdata whose __gc would drain these are gone
  js_error_registry_.clear();
  registered_classes_.clear();
  class_accessors_.clear();  // paired with registered_classes_ — same lifetime

  InstallRuntimeHandlers();

  // Replay context-level configuration in the same order the constructor
  // applies it, so the print override still wins over a callback-provided
  // print. These run protected _G writes that can throw under maxMemory;
  // surface that as a JS error rather than unwinding out (the H1 class).
  try {
    if (!allow_bytecode_) runtime->SetAllowBytecode(false);
    for (const auto& path : search_paths_) runtime->AddSearchPath(path);
    // Replay the JS searchers too (CR-9 F3): they are context configuration in
    // exactly the way the search paths above are, so dropping them made the two
    // halves of module resolution behave differently across a reset. Fresh
    // names are minted rather than reused — next_searcher_id_ stays monotonic,
    // so a name from before the reset can never collide with one after — and
    // the pair is registered only after the core call succeeds (the N5
    // ordering, as in add_searcher itself).
    for (const auto& searcher : searchers_) {
      const std::string name = "__searcher_" + std::to_string(next_searcher_id_++);
      runtime->AddJsSearcher(name);
      js_callbacks_[name] = Napi::Persistent(searcher.Value());
      runtime->StoreHostFunction(name, CreateJsCallbackWrapper(name));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!callbacks_ref_.IsEmpty()) {
    RegisterCallbacks(callbacks_ref_.Value());  // throws a JS error on failure
    if (env.IsExceptionPending()) return env.Undefined();
  }

  if (!print_handler_.IsEmpty()) {
    // Take the function out first: InstallPrintHandler reassigns print_handler_,
    // and the local keeps the value alive across that.
    const Napi::Function handler = print_handler_.Value();
    try {
      InstallPrintHandler(handler);
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // The read handler and file reader replay for the same reason the print
  // handler does: both are _G/io rewrites that the fresh state does not have.
  // A sandbox context that reset() without this would silently lose its virtual
  // filesystem while still holding the JS callback.
  if (!read_handler_.IsEmpty()) {
    const Napi::Function handler = read_handler_.Value();  // see the print handler
    try {
      InstallReadHandler(handler);
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }
  if (!file_reader_.IsEmpty()) {
    const Napi::Function reader = file_reader_.Value();
    try {
      InstallFileReader(reader);
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // Re-arm the debug hook on the fresh state. Like the print handler, it is a
  // JS callback plus a little configuration, so replaying it is straightforward
  // — and DetachRuntimeHandlers has just removed it from the outgoing runtime.
  if (!debug_hook_.IsEmpty()) {
    const Napi::Function hook = debug_hook_.Value();
    // Guarded for the same reason as set_hook's call site (CR-9 F4).
    try {
      InstallDebugHook(hook, debug_hook_mask_, debug_hook_count_);
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // Re-publish the shared globals. Unlike modules and userdata — whose Lua-side
  // objects die with the old state — a shared table's value lives in JS, so
  // replaying it is just another push. The subscription itself is untouched:
  // this context is still in each SharedTable's list, and its weak reference is
  // to the JS wrapper, which the reset did not replace.
  for (const auto& [table_ref, name] : shared_tables_) {
    SharedTable* table = AsSharedTable(env, table_ref.Value());
    if (!table) continue;  // defensive; the entry was validated at subscribe time
    try {
      table->PushTo(Value(), name);
    } catch (const Napi::Error& e) {
      e.ThrowAsJavaScriptException();
      return env.Undefined();
    } catch (const std::exception& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

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
    } catch (...) {
      // A throwing print handler is swallowed rather than corrupting the VM.
      // The script continues as though print() succeeded, which is a real
      // trade-off and is now stated in types.d.ts rather than only here —
      // CR-18 F3 reached this through all eleven throw kinds and every one
      // vanished with no way for the caller to learn it had.
      //
      // `catch (...)`, not `catch (const Napi::Error&)`: the narrower form was
      // the only containment, so any other C++ exception — a std::runtime_error
      // raised by a core call the handler made re-entrantly, a std::bad_alloc —
      // would have unwound straight through Lua's C frame, which is the exact
      // hazard this comment claims to prevent. Empirically nothing produced one
      // (all eleven kinds arrived as Napi::Error), so this closes the gap in
      // kind rather than in fact.
    }
  });
  print_handler_ = Napi::Persistent(fn);
}

// Arms the runtime-side debug hook to bridge into this context's JS callback.
// Shared by set_hook and reset(), which must re-arm it on the new state.
void LuaContext::InstallDebugHook(const Napi::Function& fn, const int mask,
                                  const int count) {
  runtime->SetDebugHook(
    [this](const std::string& event, int line, const std::string& name) {
      if (debug_hook_.IsEmpty()) return;
      // This runs inside Lua's execution, between VM instructions. Lua is built
      // as C, so a C++ exception must not unwind through it — the core contains
      // whatever escapes, and the per-event handles are scoped so a hot line
      // hook doesn't accumulate them.
      Napi::HandleScope scope(env);
      try {
        debug_hook_.Call({
          Napi::String::New(env, event),
          Napi::Number::New(env, line),
          Napi::String::New(env, name)
        });
      } catch (...) {
        // A throwing hook is swallowed rather than corrupting the VM. See
        // InstallPrintHandler for why this catches everything and why the
        // silence is documented on the public API (CR-18 F3).
      }
    }, mask, count);

  debug_hook_ = Napi::Persistent(fn);
  debug_hook_mask_ = mask;
  debug_hook_count_ = count;
}

// set_hook(callback, options) — trace Lua execution via lua_sethook.
//
//   { call: true }        -> "call" / "tail call" events
//   { return: true }      -> "return" events
//   { line: true }        -> "line" events (one per source line executed)
//   { count: 1000 }       -> "count" events every N VM instructions
//
// The callback receives (event, line, name). At least one event must be
// requested. The hook shares its lua_sethook installation with `maxInstructions`
// and `cancel()`, so setting or removing it never disturbs those.
Napi::Value LuaContext::SetHook(const Napi::CallbackInfo& info) {
  // A worker thread owns the state during async execution; re-installing the
  // hook underneath it would mutate state it is actively reading.
  if (RejectIfBusy()) return env.Undefined();
  // At entry, above the options-object reads below (CR-13 F1). This method runs
  // no Lua of its own beyond lua_sethook, so before CR-13 it had no scope at
  // all — "runs no Lua" was never the test that mattered.
  CallScope _cs(this);

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "set_hook(callback, options) requires a function")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[1].IsObject() || info[1].IsArray() ||
      info[1].IsFunction()) {
    Napi::TypeError::New(env,
      "set_hook(callback, options) requires an options object "
      "({ call?, return?, line?, count? })")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto options = info[1].As<Napi::Object>();
  const auto flag = [&options](const char* key) {
    if (!options.Has(key)) return false;
    const Napi::Value v = options.Get(key);
    return !v.IsUndefined() && !v.IsNull() && v.ToBoolean().Value();
  };

  int mask = 0;
  if (flag("call")) mask |= LUA_MASKCALL;
  if (flag("return")) mask |= LUA_MASKRET;
  if (flag("line")) mask |= LUA_MASKLINE;

  int count = 0;
  if (options.Has("count")) {
    const Napi::Value countVal = options.Get("count");
    if (!countVal.IsUndefined() && !countVal.IsNull()) {
      if (!countVal.IsNumber()) {
        Napi::TypeError::New(env, "set_hook(): count must be a number")
          .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      const double raw = countVal.As<Napi::Number>().DoubleValue();
      if (!(raw >= 1) || raw != std::trunc(raw) ||
          raw > static_cast<double>(std::numeric_limits<int>::max())) {
        Napi::RangeError::New(env,
          "set_hook(): count must be a positive integer")
          .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      count = static_cast<int>(raw);
      mask |= LUA_MASKCOUNT;
    }
  }

  if (mask == 0) {
    Napi::TypeError::New(env,
      "set_hook(): at least one of call, return, line, or count must be requested")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // SetDebugHook allocates the shared callback owner, so it can throw
  // std::bad_alloc; every neighbouring install is guarded and this one was the
  // exception. An unguarded throw here would unwind past N-API and terminate
  // the process (the H1 class, CR-9 F4).
  try {
    InstallDebugHook(info[0].As<Napi::Function>(), mask, count);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

// remove_hook() — stop tracing. A no-op when no hook is set. The instruction
// limit's own use of lua_sethook survives (the core re-installs it).
Napi::Value LuaContext::RemoveHook(const Napi::CallbackInfo& /*info*/) {
  if (RejectIfBusy()) return env.Undefined();

  runtime->RemoveDebugHook();
  debug_hook_.Reset();
  debug_hook_mask_ = 0;
  debug_hook_count_ = 0;
  return env.Undefined();
}

Napi::Value LuaContext::SetPrintHandler(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  // InstallPrintHandler routes through SetOutputHandler -> InstallOutputRedirection,
  // which does a protected _G reassignment of print/io.write and throws on a
  // raising __newindex on a _G metatable (or OOM under maxMemory). Surface that
  // as a JS error rather than letting it terminate the process (the H1 class,
  // CR-6 F1).
  try {
    // The print/io.write overrides are protected _G writes, so a metatabled _G
    // runs its __newindex here (CR-9 F1).
    CallScope _cs(this);
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

bool LuaContext::InstallReadHandler(const Napi::Function& fn) {
  // Same ordering as InstallPrintHandler (CR-8 F7): the runtime install can
  // throw, and read_handler_ must not be left pointing at a handler io.read was
  // never rewired to reach. The lambda reads read_handler_ at call time.
  const bool wired = runtime->SetInputHandler(
    [this](const lua_core::LuaPtr& format) -> std::optional<std::string> {
      if (read_handler_.IsEmpty()) return std::nullopt;
      // Inside Lua's C call frame (io.read). Scope the per-call handles so a
      // read loop does not accumulate them.
      Napi::HandleScope scope(env);
      Napi::Value result;
      // The format token is protocol metadata *this binding mints* — "l", "n",
      // "a", or a byte count — not a value coming out of the script, so it is
      // built directly instead of being run through the value converter
      // (CR-23 F2). Under `binaryStrings` that converter answers every string
      // with a Uint8Array, which turned the documented `format === 'l'`
      // comparison into one that silently never matches and contradicted the
      // declared `format: string | number` signature. `set_file_reader` already
      // minted its path argument directly (`Napi::String::New`) for exactly this
      // reason; the two channels carry the same kind of token and now behave the
      // same way.
      Napi::Value format_js = env.Undefined();
      if (format) {
        if (const auto* spec = std::get_if<std::string>(&format->value)) {
          format_js = Napi::String::New(env, *spec);
        } else if (const auto* count = std::get_if<double>(&format->value)) {
          format_js = Napi::Number::New(env, *count);
        } else if (const auto* n = std::get_if<int64_t>(&format->value)) {
          format_js = Napi::Number::New(env, static_cast<double>(*n));
        }
      }
      try {
        result = read_handler_.Call({format_js});
      } catch (const Napi::Error& e) {
        // Re-thrown with the message extracted here rather than left to the
        // core's `e.what()`: for a non-Error throw (`throw "boom"`) what() is
        // empty, and the core's "io.read handler failed: %s" would end at the
        // colon. Exactly CR-18 F2, which the property handlers already fix this
        // way — found again here by the exception matrix.
        throw Napi::Error::New(env, JsThrowMessage(e));
      }
      // null / undefined / any boolean mean end-of-input, which reaches Lua as
      // nil. A boolean is never meaningful input text, so it is not coerced to
      // "true"/"false". Deliberately not "empty string means EOF": an empty
      // line is a real line, and conflating them is the kind of data-dependent
      // answer this codebase keeps out.
      if (result.IsNull() || result.IsUndefined() || result.IsBoolean()) {
        return std::nullopt;
      }
      // Bytes are taken as bytes (CR-23 F2). `ToString()` on a Uint8Array is
      // `Array.prototype.toString` — comma-joined decimals — so handing back the
      // exact thing a `binaryStrings` context reads everywhere else fed Lua the
      // six-character *text* "255,65". Accepted in every mode rather than only
      // under the option: a handler that returns a byte view is being explicit,
      // and the inbound conversion path (B1) has always turned
      // Buffer/TypedArray/ArrayBuffer into a binary-safe Lua string. This makes
      // the one input channel agree with it.
      if (result.IsBuffer() || result.IsTypedArray() || result.IsArrayBuffer()) {
        return BinaryBytesToString(result);
      }
      return result.ToString().Utf8Value();
    });
  // Not committed when the core refused to wire io.read: retaining the JS
  // function would hold a closure alive for a handler that can never fire, and
  // would make the reset replay above re-attempt the same refused install
  // forever. Reporting false and keeping nothing is the honest pair.
  //
  // Any *previous* handler goes too. It is not collateral damage: the only way
  // to reach here is a global `io` that is no longer a table, which means the
  // wrapper the earlier handler was reached through is already gone.
  if (!wired) {
    read_handler_.Reset();
    return false;
  }
  read_handler_ = Napi::Persistent(fn);
  return true;
}

// set_read_handler(handler | null) — P4a. Returns whether io.read is now wired.
Napi::Value LuaContext::SetReadHandler(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  bool wired = true;
  try {
    // The io.read override is a protected write through a table a metatabled
    // `io` could trap, and it allocates a closure (CR-9 F1, M3).
    CallScope _cs(this);
    if (info.Length() >= 1 && info[0].IsFunction()) {
      wired = InstallReadHandler(info[0].As<Napi::Function>());
    } else {
      // Order mirrors the install: the core removal runs first and can throw, and
      // read_handler_ must not be cleared for a removal that did not happen.
      runtime->SetInputHandler(nullptr);
      read_handler_.Reset();
    }
  } catch (const std::exception& e) {
    // A core throw must not unwind past N-API (the H1 class, CR-6 F1).
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return Napi::Boolean::New(env, wired);
}

void LuaContext::InstallFileReader(const Napi::Function& fn) {
  runtime->SetFileReader(
    [this](const std::string& path) -> std::optional<std::string> {
      if (file_reader_.IsEmpty()) return std::nullopt;
      Napi::HandleScope scope(env);
      Napi::Value result;
      try {
        result = file_reader_.Call({Napi::String::New(env, path)});
      } catch (const Napi::Error& e) {
        throw Napi::Error::New(env, JsThrowMessage(e));  // see the read handler (CR-18 F2)
      }
      // null / undefined / any boolean mean "no such file" — a boolean is never
      // Lua source, so it is not coerced to "true"/"false". An empty string is
      // a valid empty module, so it is not folded into the same answer.
      if (result.IsNull() || result.IsUndefined() || result.IsBoolean()) {
        return std::nullopt;
      }
      return result.ToString().Utf8Value();
    });
  file_reader_ = Napi::Persistent(fn);
}

// set_file_reader(reader | null) — P4b.
Napi::Value LuaContext::SetFileReader(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  try {
    // Installing reassigns the dofile/loadfile globals, so a metatabled _G runs
    // its __newindex here (CR-9 F1).
    CallScope _cs(this);
    if (info.Length() >= 1 && info[0].IsFunction()) {
      InstallFileReader(info[0].As<Napi::Function>());
    } else {
      file_reader_.Reset();
      runtime->SetFileReader(nullptr);
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
    // Reads package.searchers and appends to it, so a metatabled package or
    // searchers table runs its __index/__len/__newindex here (CR-9 F1).
    CallScope _cs(this);
    runtime->AddJsSearcher(name);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  js_callbacks_[name] = Napi::Persistent(info[0].As<Napi::Function>());
  runtime->StoreHostFunction(name, CreateJsCallbackWrapper(name));
  // Recorded only after the core call succeeds, so a rejected registration is
  // never replayed by reset() (CR-9 F3, mirroring add_search_path).
  //
  // A second, independent Persistent to the same function — not a leak. The two
  // have different lifetimes: the js_callbacks_ entry is keyed by the generated
  // __searcher_N name and is dropped wholesale by reset(), while this one is
  // context configuration that must survive a reset in order to be replayed
  // under a freshly minted name.
  searchers_.emplace_back(Napi::Persistent(info[0].As<Napi::Function>()));
  return env.Undefined();
}

// --- AsyncWorker OnOK/OnError implementations ---

void LuaScriptAsyncWorker::OnOK() {
  Napi::Env env = Env();
  context_->ClearBusy();
  // The marshal below runs user JS — CoreToNapi consults the registered Lua→JS
  // converters — while `result_` still holds registry refs minted by the state
  // the run executed on. A converter that called reset() from here used to
  // succeed: is_busy_ has just been dropped, no Lua is executing, and OnOK is
  // not a binding method so nothing raised call_depth_. The remaining values
  // were then wrapped as handles pairing the *new* runtime with the *old*
  // state's refs — silent reads and writes onto unrelated live objects, and an
  // ASan-confirmed use-after-free of the retired state at finalization
  // (CR-14 F1, the CR-13 F1 class at a non-method entry point).
  //
  // A CallScope rather than deferring ClearBusy: a converter is legitimately
  // allowed to call back into the context synchronously here, and leaving
  // is_busy_ set would break that. Clearing the JS-error registry at this
  // outermost entry is inert — a worker run has JS callbacks disabled
  // (async_mode_), so it can stage nothing.
  LuaContext::CallScope _cs(context_);

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
  // See LuaScriptAsyncWorker::OnOK: the marshal below runs the Lua→JS
  // converters over values belonging to the state the run executed on, so
  // reset() must be refused for its duration (CR-14 F1).
  LuaContext::CallScope _cs(context_);

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

// createSharedTable(initial?) — the only way to mint a SharedTable, and so the
// only place the `kSharedTable` brand is applied.
//
// The class constructor stays unexported, but that is a convenience rather than
// the security property: it is still reachable as
// `createSharedTable().constructor`, which is exactly how CR-15 F5 defeated the
// `InstanceOf` check this comment used to credit. What makes a `shared` entry
// identifiable is the type tag applied in the constructor and checked in
// AsSharedTable — see there.
static Napi::Value CreateSharedTable(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = env.GetInstanceData<AddonData>();
  if (!data || data->sharedTableConstructor.IsEmpty()) {
    Napi::Error::New(env, "SharedTable class is not initialized")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const Napi::Function ctor = data->sharedTableConstructor.Value();
  if (info.Length() > 0) return ctor.New({info[0]});
  return ctor.New({});
}

static Napi::Object InitModule(const Napi::Env env, const Napi::Object exports) {
  const auto result = LuaContext::Init(env, exports);
  const Napi::Function sharedCtor = SharedTable::DefineSharedTable(env);
  // Both constructors are kept alive here for the life of the addon instance;
  // the SharedTable one is also what AsSharedTable checks against.
  env.SetInstanceData(new AddonData{
    Napi::Persistent(exports.Get("init").As<Napi::Function>()),
    Napi::Persistent(sharedCtor)
  });
  (void)result.Set("createSharedTable",
    Napi::Function::New(env, CreateSharedTable, "createSharedTable"));
  return result;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, InitModule)

bool LuaContext::IsOnConversionPath(const Napi::Value& v) const {
  return std::any_of(conversion_path_.begin(), conversion_path_.end(),
                     [&v](const auto& seen) { return seen.StrictEquals(v); });
}

lua_core::LuaValue LuaContext::NapiToCoreInstance(const Napi::Value& value, int depth) {
  if (depth > 0) return NapiToCoreImpl(value, depth);
  // Top-level conversion: if it aborts partway (a sibling value throwing after
  // a function was already registered), sweep the reclaimable entries it
  // minted — they will never be pushed and would otherwise live until context
  // destruction (N4). On success the names propagate to any enclosing scope,
  // which may still discard the converted value (see OnAwaitSettled).
  JsCallbackCollectorScope collector(this);
  // A fresh cycle-detection path per logical tree: a converter re-entering here
  // is converting something else, and a value in both trees is not a cycle.
  ConversionPathScope path(this);
  lua_core::LuaValue result = NapiToCoreImpl(value, 0);
  // Success: hand the names to any enclosing method-level scope, which may
  // still discard this value. A throw instead leaves them for the collector's
  // destructor to sweep.
  collector.PropagateToParent();
  return result;
}

// Marks each deferred name reclaimable and hands it to the active collector.
//
// Used by set_metatable / register_module, whose function-valued entries are
// registered only after their core call succeeds (CR-8 F3) but whose closures
// are built *by* that call — so the reclaim sentinel can only be attached if
// the name is already known to be reclaimable. The reservation itself creates
// no host_functions_ or js_callbacks_ entry, and the enclosing
// JsCallbackCollectorScope sweeps any reservation whose closure was never built
// (a failed core call), so nothing is stranded either way (CR-11 F4).
void LuaContext::ReserveDeferredCallbacks(
    const std::vector<std::pair<std::string, Napi::Function>>& deferred) const {
  for (const auto& [func_name, fn] : deferred) {
    runtime->ReserveReclaimableHostFunction(func_name);
    if (js_callback_collector_) js_callback_collector_->push_back(func_name);
  }
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
    // Negative zero is the one exception to "an integral JS number becomes a
    // Lua integer", and it is an exception because it is the one case where the
    // information exists on both sides and would be thrown away in the middle.
    // JavaScript distinguishes -0 from 0 (`Object.is`), Lua represents -0.0
    // exactly, and Lua's integers do not have a signed zero — so taking the
    // integral branch here loses the sign, and `1/x` comes out of the crossing
    // as +inf where it went in as -inf (CR-20 F3).
    //
    // Contrast 1.0 vs 1, which is *not* fixable and is not fixed: JavaScript
    // cannot tell those apart, so no conversion can preserve a distinction the
    // input never carried.
    if (num == 0.0 && std::signbit(num)) {
      return lua_core::LuaValue::from(num);  // stays a float, keeps the sign
    }
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
      // Read once, and check kind as well as provenance (CR-15 F6): a genuine
      // `_coroutine` External re-presented here as `_tableRef` used to pass —
      // same context, and every *Data begins with the shared_ptr the identity
      // check reads — and push a thread through the table-ref path.
      if (auto* data = TaggedData<LuaTableRefData>(obj.Get("_tableRef"),
                                                   lua_tags::kTableRefData)) {
        if (data->runtime.get() == runtime.get()) {
          // A released handle would push registry slot LUA_NOREF (nil) silently;
          // surface it as an error instead, matching the handle methods (L2).
          if (data->tableRef.ref == LUA_NOREF) {
            throw std::runtime_error("table handle has been released");
          }
          return lua_core::LuaValue::from(lua_core::LuaTableRef(data->tableRef));
        }
        // Foreign marker. Every other cross-context entry point refuses one —
        // `release`, `resume`, `create_coroutine`, `execute_script_in` and
        // `set_metatable` all throw "… belongs to a different Lua context" —
        // and this site used to fall through to "a plain deep copy" instead.
        //
        // A table handle is not a plain object. It is a **Proxy** whose own
        // keys are its API, so the same deep copy produced a Lua table
        // containing `get, get_ref, has, ipairs, length, pairs, release, set`
        // as functions and none of the referenced table's fields — silently, and
        // at ~1.5 KB of registered host callbacks per push (CR-17 F2). Refusing
        // matches the five siblings and tells the caller the thing that is
        // actually true; to copy the data across, pass `get_global(name)`
        // rather than `get_global_ref(name)`.
        throw std::runtime_error("table handle belongs to a different Lua context");
      }

      // A **Lua-created** userdata handle is refused across contexts, for the
      // reason the table handle above is, and the distinction that decides it
      // is *what the object's own properties are* (CR-22 F1):
      //
      //   Lua-created userdata (`io.open(...)` crossing to JS)
      //       own props = ["_userdata"] — the marker, and nothing else. A deep
      //       copy therefore yields an empty Lua table: a file handle silently
      //       becomes `{}`. Same shape as the table-handle Proxy above, same
      //       remedy.
      //
      //   JS-created userdata (`set_userdata('u', obj)`)
      //       own props = the caller's own data, and `execute_script('return u')`
      //       hands back **the identical JS object** — `back === obj` is true,
      //       with no marker on it at all. It never reaches this branch, and it
      //       must not: passing it to another context is passing a plain JS
      //       object the caller already holds, so copying its fields is exactly
      //       what passing any object does. `type()` going from `userdata` to
      //       `table` is that object not being registered in the second
      //       context, not a handle failing.
      //
      // That difference is why CR-22 F1's first draft was wrong and is worth
      // keeping written down: it read the second case as an encapsulation
      // break — "an opaque userdata becomes readable one context away" — when
      // the reader was the object's own owner, who had it all along. The
      // opacity contract is about what *Lua* can index in the owning state, and
      // that still holds. Only the marker-carrying case is a handle, and only a
      // handle can be stale.
      if (auto* data = TaggedData<LuaUserdataData>(obj.Get("_userdata"),
                                                   lua_tags::kUserdataData)) {
        if (data->runtime.get() == runtime.get()) {
          return lua_core::LuaValue::from(lua_core::LuaUserdataRef(data->userdataRef));
        }
        throw std::runtime_error("userdata handle belongs to a different Lua context");
      }

      // A coroutine object, for the same reason and found the same way — by the
      // cross-context search built after the userdata case, which is the point
      // of building it (CR-22 F2, then F1's class completed).
      //
      // Its own properties are `["_coroutine", "status"]`: one marker and one
      // descriptive string. The deep copy therefore dropped the marker and
      // produced `{ status = "suspended" }` — an object that looks like a
      // coroutine, reports a status, and can do nothing. `resume` already
      // refused a foreign thread ("coroutine belongs to a different Lua
      // context"); the *value* path did not, so the two halves of the same
      // question gave different answers.
      //
      // There is deliberately no same-runtime branch here. A coroutine is not a
      // value Lua can hold as a `LuaValue` — `resume` is the only thing that
      // consumes one, and it reads the marker directly — so within one context
      // this object still deep-copies exactly as before, and only the foreign
      // case changes.
      if (auto* data = TaggedData<LuaThreadData>(obj.Get("_coroutine"),
                                                 lua_tags::kThreadData)) {
        if (data->runtime.get() != runtime.get()) {
          throw std::runtime_error("coroutine belongs to a different Lua context");
        }
      }

      // The class-instance marker below is the deliberate exception to that
      // rule, and it stays one. A foreign instance carries **both** the markers
      // and its own data (`["hidden", "__luaClassRef", …]`), so the deep copy
      // moves the data across intact — which is what the review ledger's M6 chose
      // and pins (`foreign.x, foreign.y` survive, methods and metatable do
      // not). Refusing it would reverse a decision that is documented, pinned,
      // and — unlike the two cases above — actually delivers the data.

      // Check if it's a registered class instance round-tripping back to Lua.
      // Only honor the marker if it was minted by THIS context's runtime — the
      // ref_id is a bare integer, so an instance from another context could
      // otherwise alias an unrelated slot in this js_userdata_ (M6).
      //
      // The id is what makes "this runtime" mean this runtime. The pointer
      // comparison beside it is a second barrier, not the test: the `*Data`
      // structs behind _tableRef / _userdata / _coroutine each hold a
      // shared_ptr<LuaRuntime>, so *their* address comparisons are backed by a
      // lifetime and cannot see a recycled block — this marker holds no share,
      // and before CR-14 F2 the address alone was the whole check.
      if (obj.Has("__luaClassRef")) {
        Napi::Value r = obj.Get("__luaClassRef");
        Napi::Value cn = obj.Get("__luaClassName");
        Napi::Value owner = obj.Get("__luaClassOwner");
        Napi::Value ownerId = obj.Get("__luaClassOwnerId");
        bool id_matches = false;
        if (ownerId.IsBigInt()) {
          bool lossless = false;
          const uint64_t stamped = ownerId.As<Napi::BigInt>().Uint64Value(&lossless);
          id_matches = lossless && stamped == runtime->Id();
        }
        // Branded too (CR-15 F6), so the second barrier cannot be satisfied by
        // some *other* kind of External this context handed out.
        const auto* ownerPtr =
          TaggedData<lua_core::LuaRuntime>(owner, lua_tags::kRuntimeOwner);
        const bool owned = id_matches && ownerPtr == runtime.get();
        if (owned && r.IsNumber() && cn.IsString()) {
          const int ref_id = r.As<Napi::Number>().Int32Value();
          if (js_userdata_.find(ref_id) != js_userdata_.end()) {
            return lua_core::LuaValue::from(lua_core::LuaUserdataRef(
              ref_id, runtime->RawState(), /*is_opaque=*/false, LUA_NOREF,
              /*is_proxy=*/false, cn.As<Napi::String>().Utf8Value()));
          }
        }
        // A foreign class instance still deep-copies, and that is deliberate
        // (M6), not an oversight — see the paragraph above the `_userdata`
        // check for why this marker is the one exception to the refusal rule.
      }
    }

    // B2: user-registered converters get first look at objects (after internal
    // round-trip markers, before built-in type handling). A converter returns a
    // JS value that is then converted normally.
    //
    // Index the vector — do NOT use a range-for — and pull both function
    // handles out BEFORE calling match(): a match/convert callback may re-enter
    // and register another converter, reallocating the vector. Copying the
    // handles protects this iteration's operands; re-reading size() and
    // indexing each time is what protects the *cursor*, which a range-for
    // caches as a raw pointer into the old buffer. CR-2 established this and a
    // later modernization pass reverted it to a range-for, reintroducing a
    // confirmed heap-use-after-free (CR-11 F1). The NOLINT is load-bearing.
    // NOLINTNEXTLINE(modernize-loop-convert)
    for (size_t i = 0; i < type_converters_.size(); ++i) {
      Napi::Function match = type_converters_[i].first.Value();
      Napi::Function convert = type_converters_[i].second.Value();
      // Same reason as the property bridge: a converter that throws a string
      // otherwise reaches the caller as `Error` with an empty message
      // (CR-18 F2).
      try {
        if (match.Call({value}).ToBoolean().Value()) {
          return NapiToCoreInstance(convert.Call({value}), depth + 1);
        }
      } catch (const Napi::Error& e) {
        throw Napi::Error::New(env, JsThrowMessage(e));
      }
    }

    // Cycle check before descending, so an object that is its own ancestor is
    // named as one at the first repeat instead of after a hundred levels of
    // conversion work that then reports the wrong cause (CR-20 F2).
    //
    // **Above ConvertBuiltinType, not below it (CR-21 F2).** `Map` and `Set`
    // recurse into their entries, and while this sat below the builtin branch
    // those two containers were converted without ever joining the path they
    // are compared against — so a self-containing Map still reported the depth
    // limit, which is precisely the wrong message CR-20 F2 existed to remove.
    // The fix is placement rather than a second check in each container branch,
    // because "recurses" is a property of the builtin *set*, and a new
    // recursing builtin added below would otherwise be short by the same
    // member a third time.
    //
    // Pushing the non-recursing builtins (Date, RegExp, the binary views) is
    // inert: they never descend, so they cannot meet themselves, and the entry
    // is popped before any sibling is converted.
    if (IsOnConversionPath(value)) {
      throw std::runtime_error(
        "Value contains a circular reference, which Lua tables cannot represent; "
        "break the cycle before passing it in");
    }
    ConversionPathEntry on_path(this, value);

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

// Converts a Lua value to JS, then gives the registered Lua->JS converters
// (B3) a chance to replace the result with an application type.
//
// The converter sees the natural conversion — a plain object for a Lua table, a
// Proxy for a metatabled one — because that is the only shape expressible to a
// JS predicate. Its return value is used verbatim rather than re-converted: the
// result is already a JS value, and re-running the converters over it would
// invite a converter that matches its own output to loop forever.
//
// Only object-valued results are offered, mirroring the JS->Lua direction's
// "converters do not see primitives" rule — and keeping the common path (every
// number and string crossing out of Lua) free of a JS call per value.
Napi::Value LuaContext::CoreToNapi(const lua_core::LuaValue& value) {
  Napi::Value result = CoreToNapiBuiltin(value);
  if (from_lua_converters_.empty()) return result;
  if (!result.IsObject() || result.IsFunction()) return result;

  // Index the vector — do NOT use a range-for — and pull both handles out
  // BEFORE calling match(): a match/convert callback may re-enter and register
  // another converter, reallocating the vector. See NapiToCoreImpl's loop for
  // why the cursor, not just the operands, is what the indexing protects, and
  // why the NOLINT must stay (CR-11 F1).
  // NOLINTNEXTLINE(modernize-loop-convert)
  for (size_t i = 0; i < from_lua_converters_.size(); ++i) {
    Napi::Function match = from_lua_converters_[i].first.Value();
    const Napi::Function convert = from_lua_converters_[i].second.Value();
    // Rethrown as a Napi::Error, not a std::runtime_error, and the type is
    // load-bearing: CoreToNapi is reached from sites that catch Napi::Error
    // *specifically* (the print-handler and debug-hook bridges among them).
    // Converting the type here made those handlers miss it, and the escape
    // took the process down — the CR-6 F1 class, reintroduced by a fix for
    // CR-18 F2 and caught by the suite before it shipped. Napi::Error derives
    // from std::exception, so the generic catch sites still see it and now see
    // a non-empty what().
    try {
      if (match.Call({result}).ToBoolean().Value()) {
        return convert.Call({result});
      }
    } catch (const Napi::Error& e) {
      throw Napi::Error::New(env, JsThrowMessage(e));
    }
  }
  return result;
}

// Pairs a registry ref with `runtime` only when the ref actually belongs to it,
// and hands back an already-released copy when it does not.
//
// **Every registry-backed handle this file mints pairs a ref with a
// `shared_ptr<LuaRuntime>`, and that pairing is the entire lifetime
// guarantee**: the runtime — and so the `lua_State` whose registry the ref
// indexes — cannot be destroyed while the handle lives. The pairing is written
// as `LuaFunctionData(runtime, v, ...)` at four sites, where `runtime` is the
// context's *current* member. That is right whenever the value came from the
// current state, which is every path but one.
//
// The exception is `reset()`. It swaps the member first and destroys the
// outgoing runtime as part of that statement, so `lua_close`'s `__gc`
// finalizers dispatch into JS with `runtime` already pointing at the
// replacement. A metatabled table reaching a JS `__gc` handler is converted
// here, and the ref — an index in the *retiring* registry — was being paired
// with the *replacement* runtime. Two consequences, both driven (CR-17 F1):
// the handle's `luaL_unref` runs against a freed `lua_State` at teardown, and
// while it is alive it reads and writes the replacement state's registry at the
// retiring state's slot number, aliasing whatever the new state put there.
//
// Taking a share of the retiring runtime is not an option — it is inside its
// own `shared_ptr` deleter, so its use count is already zero and no new share
// can exist. The ref therefore *cannot* be made valid, and the only correct
// handle is a dead one. Releasing our copy is the whole fix: the core still
// holds its own share of the same slot and unrefs it, correctly, against the
// live retiring state when the dispatch returns.
//
// A JS handler consequently sees a handle that reports "has been released",
// which is the accurate answer rather than a fudge — the object it refers to is
// mid-finalization and will not exist a moment later.
//
// The check is derived from the ref rather than from a flag a caller sets,
// because the callers are not enumerable by inspection: `owner` was already
// captured in two wrappers for exactly this hazard (CR-12 F4) and used only on
// the error path, and any future bridge dispatching from a retiring state would
// have had to remember to opt in. See `lua_core::detail::OwningRuntime`.
template <typename RefT>
RefT LuaContext::RefForThisRuntime(const RefT& ref) const {
  if (ref.L && lua_core::detail::OwningRuntime(ref.L) == runtime.get()) return ref;
  RefT dead = ref;
  dead.release();  // drops only this copy's share; the core's own still unrefs
  return dead;
}

Napi::Value LuaContext::CoreToNapiBuiltin(const lua_core::LuaValue& value) {
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
          // Under `binaryStrings`, hand back the bytes Lua actually holds. The
          // default path decodes as UTF-8, which replaces every byte of an
          // invalid sequence with U+FFFD and is lossy for binary payloads
          // (string.pack, compression, crypto, image data) — see the
          // binary_strings_ comment in lua-native.h for why this is a switch
          // rather than an automatic choice.
          if (binary_strings_) {
            auto bytes = Napi::Uint8Array::New(env, v.size());
            if (!v.empty()) std::memcpy(bytes.Data(), v.data(), v.size());
            // `{env, bytes}` and not `bytes`: this lambda returns Napi::Value,
            // and Uint8Array is the one type it yields that carries state of
            // its own over the base — `_type`, `_length` and `_data`, 24 bytes
            // of cached typed-array info. Returning it directly slices those
            // off (clang-tidy flags it), and while that is harmless here — the
            // napi_env/napi_value pair that identifies the JS object lives in
            // the base, so the value still arrives as a real Uint8Array — a
            // silent slice is not worth leaving in place. Constructing the
            // Value from the two scalars copies the handle instead of
            // truncating an object. Same idiom as the two Buffer returns in
            // Compile/CompileFile; the other branches here (Boolean, Number,
            // BigInt, String, Array, Object, Function) add no members over
            // Value, so `return x;` is exact for them.
            return {env, bytes};
          }
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
          // Held by unique_ptr until that finalizer becomes the owner, so an
          // N-API allocation that throws in between cannot leak it — the same
          // discipline CreateTableHandle and CreateCoroutineObject use
          // (CR-9 F4, swept to its remaining siblings by CR-11 F5).
          auto data = std::make_unique<LuaFunctionData>(
            runtime, RefForThisRuntime(v), this, Liveness());
          LuaFunctionData* dataPtr = data.get();
          const Napi::Function fn =
            Napi::Function::New(env, LuaFunctionCallbackStatic, "luaFunction", dataPtr);
          // Non-writable + non-configurable: this External's finalizer owns the
          // LuaFunctionData that `fn` still calls through, so it must not be
          // deletable or reassignable from JS (L6).
          const auto owner = NewTaggedExternal(env, dataPtr, lua_tags::kFunctionData,
            [](Napi::Env, const LuaFunctionData* d) { delete d; });
          // Released the moment the External exists, not after DefineHiddenProp
          // (which can throw): the finalizer is already the owner by then, so
          // the discarded result is deliberate.
          // NOLINTNEXTLINE(bugprone-unused-return-value)
          (void)data.release();
          DefineHiddenProp(env, fn, "__luaFnOwner", owner, /*writable=*/false);
          return fn;
        } else if constexpr (std::is_same_v<T, lua_core::LuaThreadRef>) {
          // Return a coroutine object with the thread reference (data owned by the
          // External's finalizer).
          const lua_core::CoroutineStatus status = lua_core::LuaRuntime::GetCoroutineStatus(v);
          return CreateCoroutineObject(
            std::make_unique<LuaThreadData>(runtime, RefForThisRuntime(v)),
            status == lua_core::CoroutineStatus::Suspended ? "suspended" :
            status == lua_core::CoroutineStatus::Running ? "running" : "dead");
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
            // owned by the External's finalizer; unique_ptr until then, see the
            // LuaFunctionRef branch above).
            auto data = std::make_unique<LuaUserdataData>(runtime, RefForThisRuntime(v));
            Napi::Object handle = Napi::Object::New(env);
            const auto owner = NewTaggedExternal(env, data.get(), lua_tags::kUserdataData,
              [](Napi::Env, const LuaUserdataData* d) { delete d; });
            // NOLINTNEXTLINE(bugprone-unused-return-value)
            (void)data.release();  // ownership transferred to the finalizer
            handle.Set("_userdata", owner);
            return handle;
          }
        } else if constexpr (std::is_same_v<T, lua_core::LuaTableRef>) {
          // Create a JS Proxy that preserves Lua metamethods. The trap data is
          // owned by the External's finalizer, tied to the proxy target's life.
          Napi::Object target = Napi::Object::New(env);

          // unique_ptr until the External's finalizer owns it, see the
          // LuaFunctionRef branch above (CR-11 F5).
          auto data = std::make_unique<LuaTableRefData>(
              runtime, RefForThisRuntime(v), this, Liveness());
          LuaTableRefData* dataPtr = data.get();

          // Store _tableRef as non-enumerable on target for round-trip detection
          auto external = NewTaggedExternal(env, dataPtr, lua_tags::kTableRefData,
            [](Napi::Env, const LuaTableRefData* d) { delete d; });
          // NOLINTNEXTLINE(bugprone-unused-return-value)
          (void)data.release();  // ownership transferred to the finalizer
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

// --- A4: coroutines as JS iterators ---

// The realm's well-known Symbol.iterator.
static Napi::Value SymbolIteratorKey(const Napi::Env env) {
  return env.Global().Get("Symbol").As<Napi::Object>().Get("iterator");
}

static Napi::Value SymbolAsyncIteratorKey(const Napi::Env env) {
  return env.Global().Get("Symbol").As<Napi::Object>().Get("asyncIterator");
}

namespace {
  // One iteration cursor over a coroutine. Each `[Symbol.iterator]()` call mints
  // a fresh one, so two loops over the same coroutine are independent cursors
  // advancing one shared Lua thread. The coroutine object is held strongly:
  // nothing on the coroutine points back at the iterator, so there is no cycle.
  struct LuaCoroIterState {
    LuaContext* context = nullptr;
    ContextLiveness liveness;
    Napi::ObjectReference coro;
    bool done = false;
    // A weak handle to this same object, so a method holding only the raw
    // `info.Data()` pointer can mint an additional GC root for it. The async
    // cursor needs exactly that: its per-step mapper closure can outlive the
    // `next` function that created it (`const p = it.next(); it = null; await p`),
    // and would otherwise be the one holder of a freed state. Weak, not strong,
    // because a strong self-reference is a cycle that never collects.
    std::weak_ptr<LuaCoroIterState> self;

    [[nodiscard]] bool ContextLive() const {
      return context && liveness.HandlesLive();
    }
  };

  // The state is shared_ptr-owned and each GC root is an External wrapping its
  // own shared_ptr copy, so "rooted on the iterator, on every bound method, and
  // on any pending async mapper" is expressed by ownership rather than by
  // remembering to keep one designated holder alive.
  using CoroIterOwner = std::shared_ptr<LuaCoroIterState>;

  // Mints one such root. The unique_ptr owns the copy until the External's
  // finalizer takes over, so a throw from External::New cannot leak it
  // (CR-9 F4, the discipline the rest of this file follows).
  Napi::Value NewCoroIterOwner(const Napi::Env env, const CoroIterOwner& sp) {
    auto holder = std::make_unique<CoroIterOwner>(sp);
    const auto ext = Napi::External<CoroIterOwner>::New(env, holder.get(),
      [](Napi::Env, const CoroIterOwner* h) { delete h; });
    // NOLINTNEXTLINE(bugprone-unused-return-value)
    (void)holder.release();  // ownership transferred to the finalizer
    return ext;
  }
}

static Napi::Value CoroIterResult(const Napi::Env env, const Napi::Value& value,
                                  const bool done) {
  const Napi::Object result = Napi::Object::New(env);
  (void)result.Set("value", value);
  (void)result.Set("done", Napi::Boolean::New(env, done));
  return result;
}

static Napi::Value CoroIteratorNext(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  auto* state = static_cast<LuaCoroIterState*>(info.Data());
  if (!state || !state->ContextLive()) {
    Napi::Error::New(env, std::string("Lua coroutine is not usable: ") +
                          (state ? state->liveness.DeadReason()
                                 : "its Lua context has been destroyed"))
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (state->done) return CoroIterResult(env, env.Undefined(), true);

  const Napi::Object coro = state->coro.Value();

  // A coroutine that is already dead — exhausted by an earlier loop, or driven
  // to completion by hand — simply ends the iteration, rather than surfacing
  // Lua's "cannot resume dead coroutine" as a thrown error.
  // `this` is user-supplied (`iter.call(proxy)`), so this Get can be a trap and
  // the External it returns can be any the addon has handed out — branded, so a
  // wrong-kind one reads as nullptr and the probe simply declines (CR-15 F6).
  if (const auto* threadData =
        TaggedData<LuaThreadData>(coro.Get("_coroutine"), lua_tags::kThreadData);
      threadData && threadData->threadRef.ref != LUA_NOREF &&
      lua_core::LuaRuntime::GetCoroutineStatus(threadData->threadRef) ==
        lua_core::CoroutineStatus::Dead) {
    state->done = true;
    return CoroIterResult(env, env.Undefined(), true);
  }

  if (state->context->IsBusy()) {
    Napi::Error::New(env, "Lua context is busy with an async operation")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Same outermost-entry bookkeeping resume() does (L7), opened above the
  // argument handling and the resume it feeds — ResumeCoroutineObject converts
  // those arguments through user JS (CR-13 F1).
  LuaContext::CallScope scope(state->context);

  // `next(v)` forwards its arguments as the resume values, so a caller can feed
  // a generator-style coroutine from JS.
  std::vector<Napi::Value> args;
  args.reserve(info.Length());
  for (size_t i = 0; i < info.Length(); ++i) args.push_back(info[i]);

  const Napi::Value res = state->context->ResumeCoroutineObject(coro, args);
  if (env.IsExceptionPending() || !res.IsObject()) {
    state->done = true;  // a broken cursor must not be resumable
    return env.Undefined();
  }

  const auto result = res.As<Napi::Object>();
  if (result.Has("error")) {
    state->done = true;
    Napi::Error::New(env, result.Get("error").ToString().Utf8Value())
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // A yield is an iteration step; the coroutine's final `return` arrives with
  // done=true, which for..of discards — exactly the JS generator contract.
  const bool dead = result.Get("status").ToString().Utf8Value() == "dead";
  if (dead) state->done = true;

  const auto values = result.Get("values").As<Napi::Array>();
  Napi::Value value = env.Undefined();
  if (values.Length() == 1) {
    value = values.Get(static_cast<uint32_t>(0));
  } else if (values.Length() > 1) {
    value = values;  // multiple yielded values arrive as an array, as elsewhere
  }
  return CoroIterResult(env, value, dead);
}

// Maps one resume_async result object into the `{ value, done }` an async
// iterator answers with. `info.Data()` is the cursor state; `info[0]` is the
// `{ status, values, error? }` the promise resolved with. Deliberately the same
// mapping CoroIteratorNext applies to the synchronous result — the two cursors
// differ in *when* they get the step, not in what a step means.
static Napi::Value CoroAsyncNextMap(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  auto* state = static_cast<LuaCoroIterState*>(info.Data());
  const Napi::Value res = info.Length() > 0 ? info[0] : env.Undefined();
  if (!state || !res.IsObject()) {
    if (state) state->done = true;
    return CoroIterResult(env, env.Undefined(), true);
  }
  const auto result = res.As<Napi::Object>();
  if (result.Has("error")) {
    state->done = true;
    Napi::Error::New(env, result.Get("error").ToString().Utf8Value())
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const bool dead = result.Get("status").ToString().Utf8Value() == "dead";
  if (dead) state->done = true;

  const auto values = result.Get("values").As<Napi::Array>();
  Napi::Value value = env.Undefined();
  if (values.Length() == 1) {
    value = values.Get(static_cast<uint32_t>(0));
  } else if (values.Length() > 1) {
    value = values;
  }
  return CoroIterResult(env, value, dead);
}

// The async cursor's `next()`. Same shape as CoroIteratorNext, driven through
// resume_async so a host function that returns a Promise anywhere inside the
// coroutine suspends it instead of hard-erroring.
//
// Before this existed, `for await (const v of coro)` worked — but only via JS's
// sync-iterable fallback, which is exactly why a yield that needed a Promise
// could not. With Symbol.asyncIterator present, `for await` binds to this
// instead and the fallback no longer applies.
static Napi::Value CoroAsyncIteratorNext(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  auto* state = static_cast<LuaCoroIterState*>(info.Data());

  // Everything past the liveness check settles a promise rather than throwing,
  // so `for await` sees failures through its normal channel.
  const auto settled = [&env](const Napi::Value& v) -> Napi::Value {
    auto d = Napi::Promise::Deferred::New(env);
    d.Resolve(v);
    return d.Promise();
  };
  const auto rejected = [&env](const std::string& msg) -> Napi::Value {
    auto d = Napi::Promise::Deferred::New(env);
    d.Reject(Napi::Error::New(env, msg).Value());
    return d.Promise();
  };

  if (!state || !state->ContextLive()) {
    return rejected(std::string("Lua coroutine is not usable: ") +
                    (state ? state->liveness.DeadReason()
                           : "its Lua context has been destroyed"));
  }
  if (state->done) return settled(CoroIterResult(env, env.Undefined(), true));

  const Napi::Object coro = state->coro.Value();

  // An already-dead coroutine ends the iteration rather than surfacing Lua's
  // "cannot resume dead coroutine" — see CoroIteratorNext for the branding note.
  if (const auto* threadData =
        TaggedData<LuaThreadData>(coro.Get("_coroutine"), lua_tags::kThreadData);
      threadData && threadData->threadRef.ref != LUA_NOREF &&
      lua_core::LuaRuntime::GetCoroutineStatus(threadData->threadRef) ==
        lua_core::CoroutineStatus::Dead) {
    state->done = true;
    return settled(CoroIterResult(env, env.Undefined(), true));
  }

  std::vector<Napi::Value> args;
  args.reserve(info.Length());
  for (size_t i = 0; i < info.Length(); ++i) args.push_back(info[i]);

  // No CallScope around the drive: resume_async suspends and returns, so a scope
  // held here would leave call_depth_ raised across the await — the reason
  // execute_async scopes only its chunk load (CR-10 F1). The argument conversion
  // inside ResumeCoroutineObjectAsync opens its own collector.
  const Napi::Value promise =
    state->context->ResumeCoroutineObjectAsync(coro, args, state->context->Value());
  if (env.IsExceptionPending()) {
    state->done = true;  // a broken cursor must not be resumable
    return env.Undefined();
  }
  if (!promise.IsPromise()) {
    state->done = true;
    return rejected("resume_async did not return a Promise");
  }

  // `then` is user-influenceable (a patched Promise.prototype), so a failure
  // here must not leave the cursor in a half-advanced state.
  const auto promiseObj = promise.As<Napi::Object>();
  Napi::Value thenVal = promiseObj.Get("then");
  if (!thenVal.IsFunction()) {
    state->done = true;
    return rejected("the Promise from resume_async has no callable 'then'");
  }
  const Napi::Function mapper =
    Napi::Function::New(env, CoroAsyncNextMap, "next", state);
  // Root the cursor state on the mapper the same way the cursor's own methods
  // root it. This one is not optional bookkeeping: the mapper runs when the
  // promise settles, which can be after `next` and the iterator have both been
  // dropped, leaving it the only holder (H3 / L6).
  if (const CoroIterOwner keep = state->self.lock()) {
    DefineHiddenProp(env, mapper, "__coroIterOwner", NewCoroIterOwner(env, keep),
                     /*writable=*/false);
  }
  return thenVal.As<Napi::Function>().Call(promiseObj, {mapper});
}

static Napi::Value CoroAsyncIteratorSelf(const Napi::CallbackInfo& info) {
  return info.This();
}

// Called when a for..of loop exits early (`break`, `return`, a throw). Ends
// this cursor only — the underlying coroutine keeps its suspension point, so a
// later loop resumes where this one stopped.
static Napi::Value CoroIteratorReturn(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (auto* state = static_cast<LuaCoroIterState*>(info.Data())) state->done = true;
  return CoroIterResult(env, info.Length() > 0 ? info[0] : env.Undefined(), true);
}

static Napi::Value CoroIteratorSelf(const Napi::CallbackInfo& info) {
  return info.This();
}

// The coroutine object's `[Symbol.iterator]`. `info.Data()` is the context
// binding minted alongside the coroutine; `info.This()` is the coroutine.
static Napi::Value CoroSymbolIterator(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* binding = static_cast<LuaContextBinding*>(info.Data());
  if (!binding || !binding->ContextLive()) {
    Napi::Error::New(env, std::string("Lua coroutine is not usable: ") +
                          (binding ? binding->liveness.DeadReason()
                                   : "its Lua context has been destroyed"))
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!info.This().IsObject()) {
    Napi::TypeError::New(env,
      "coroutine[Symbol.iterator]() must be called on a coroutine object")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const CoroIterOwner sp = std::make_shared<LuaCoroIterState>();
  sp->self = sp;
  LuaCoroIterState* state = sp.get();
  state->context = binding->context;
  state->liveness = binding->liveness;
  state->coro = Napi::Persistent(info.This().As<Napi::Object>());

  const Napi::Object iterator = Napi::Object::New(env);
  // Rooted on the iterator AND on each bound method, so a method destructured
  // off the iterator keeps the state alive — the same ownership discipline as
  // the table handles (H3 / L6). Each root is an independent shared_ptr copy.
  DefineHiddenProp(env, iterator, "__coroIterOwner", NewCoroIterOwner(env, sp),
                   /*writable=*/false);

  auto addMethod = [&](const char* name,
                       Napi::Value (*cb)(const Napi::CallbackInfo&)) {
    const Napi::Function fn = Napi::Function::New(env, cb, name, state);
    DefineHiddenProp(env, fn, "__coroIterOwner", NewCoroIterOwner(env, sp),
                     /*writable=*/false);
    (void)iterator.Set(name, fn);
  };
  addMethod("next", CoroIteratorNext);
  addMethod("return", CoroIteratorReturn);
  (void)iterator.Set(SymbolIteratorKey(env),
    Napi::Function::New(env, CoroIteratorSelf, "[Symbol.iterator]"));
  return iterator;
}

// The coroutine object's `[Symbol.asyncIterator]` (P1b). Structurally identical
// to CoroSymbolIterator; the cursor it mints steps through resume_async, so the
// coroutine may await a host Promise at any yield.
static Napi::Value CoroSymbolAsyncIterator(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* binding = static_cast<LuaContextBinding*>(info.Data());
  if (!binding || !binding->ContextLive()) {
    Napi::Error::New(env, std::string("Lua coroutine is not usable: ") +
                          (binding ? binding->liveness.DeadReason()
                                   : "its Lua context has been destroyed"))
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!info.This().IsObject()) {
    Napi::TypeError::New(env,
      "coroutine[Symbol.asyncIterator]() must be called on a coroutine object")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const CoroIterOwner sp = std::make_shared<LuaCoroIterState>();
  sp->self = sp;
  LuaCoroIterState* state = sp.get();
  state->context = binding->context;
  state->liveness = binding->liveness;
  state->coro = Napi::Persistent(info.This().As<Napi::Object>());

  const Napi::Object iterator = Napi::Object::New(env);
  DefineHiddenProp(env, iterator, "__coroIterOwner", NewCoroIterOwner(env, sp),
                   /*writable=*/false);

  auto addMethod = [&](const char* name,
                       Napi::Value (*cb)(const Napi::CallbackInfo&)) {
    const Napi::Function fn = Napi::Function::New(env, cb, name, state);
    DefineHiddenProp(env, fn, "__coroIterOwner", NewCoroIterOwner(env, sp),
                     /*writable=*/false);
    (void)iterator.Set(name, fn);
  };
  addMethod("next", CoroAsyncIteratorNext);
  // `return` ends the cursor without touching the thread, exactly as the sync
  // one does — an early `break` out of `for await` leaves the coroutine
  // suspended and resumable. It answers synchronously; JS wraps a non-promise
  // return from an async iterator's `return` for us.
  addMethod("return", CoroIteratorReturn);
  (void)iterator.Set(SymbolAsyncIteratorKey(env),
    Napi::Function::New(env, CoroAsyncIteratorSelf, "[Symbol.asyncIterator]"));
  return iterator;
}

Napi::Object LuaContext::CreateCoroutineObject(std::unique_ptr<LuaThreadData> data,
                                               const std::string& status) {
  // `data` owns the thread's registry ref until the External's finalizer takes
  // over, so a throw from the N-API allocations below releases the slot instead
  // of orphaning it (CR-9 F4).
  const Napi::Object coro = Napi::Object::New(env);
  // The External's finalizer owns the data — freed when the coroutine object is
  // garbage-collected.
  (void)coro.Set("_coroutine", NewTaggedExternal(env, data.get(), lua_tags::kThreadData,
    [](Napi::Env, const LuaThreadData* d) { delete d; }));
  // Discarding release() is deliberate: the pointer is already held by the
  // External above. Releasing *after* the External exists is what keeps the
  // throw path safe, so the result cannot be consumed by folding it into the
  // New() argument.
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)data.release();  // ownership transferred to the finalizer
  (void)coro.Set("status", Napi::String::New(env, status));

  auto binding_owner = std::make_unique<LuaContextBinding>(LuaContextBinding{this, Liveness()});
  LuaContextBinding* binding = binding_owner.get();
  const Napi::Function iterFn =
    Napi::Function::New(env, CoroSymbolIterator, "[Symbol.iterator]", binding);
  const auto bindingExternal = Napi::External<LuaContextBinding>::New(env, binding,
    [](Napi::Env, const LuaContextBinding* b) { delete b; });
  // Released the moment the External exists — not after DefineHiddenProp, which
  // can throw: the finalizer is already the owner by then, so a later release
  // would be a double free. The discarded result is deliberate for that reason.
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)binding_owner.release();
  DefineHiddenProp(env, iterFn, "__coroBindingOwner", bindingExternal,
    /*writable=*/false);
  (void)coro.Set(SymbolIteratorKey(env), iterFn);

  // Symbol.asyncIterator (P1b). `for await` previously bound to the *sync*
  // iterator through JS's fallback, which is precisely why a yield needing a
  // Promise could not work; with this present it binds here instead. A second
  // binding object rather than a shared one: each is owned by its own External
  // finalizer, and sharing would mean two finalizers over one allocation.
  auto async_binding_owner =
    std::make_unique<LuaContextBinding>(LuaContextBinding{this, Liveness()});
  LuaContextBinding* async_binding = async_binding_owner.get();
  const Napi::Function asyncIterFn = Napi::Function::New(
    env, CoroSymbolAsyncIterator, "[Symbol.asyncIterator]", async_binding);
  const auto asyncBindingExternal =
    Napi::External<LuaContextBinding>::New(env, async_binding,
      [](Napi::Env, const LuaContextBinding* b) { delete b; });
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)async_binding_owner.release();  // see the sync binding above
  DefineHiddenProp(env, asyncIterFn, "__coroBindingOwner", asyncBindingExternal,
    /*writable=*/false);
  (void)coro.Set(SymbolAsyncIteratorKey(env), asyncIterFn);
  return coro;
}

// Extracts the LuaFunctionData behind a Lua function handed back to JS (the
// wrapper CoreToNapi mints for a LuaFunctionRef). Returns nullptr for a plain
// JS function, leaving the caller to raise its own error.
static LuaFunctionData* LuaFunctionDataFrom(const Napi::Value& value) {
  if (!value.IsFunction()) return nullptr;
  // One Get, and branded — see TableRefDataFrom (CR-15 F6).
  return TaggedData<LuaFunctionData>(value.As<Napi::Object>().Get("__luaFnOwner"),
                                     lua_tags::kFunctionData);
}

// create_coroutine(scriptOrFunction)
//
// The original form takes a script string that *returns* a function. It also
// accepts a Lua function already held on the JS side (A4), so a function
// obtained from execute_script / get_global can be turned into a coroutine
// without being re-sourced as text.
Napi::Value LuaContext::CreateCoroutine(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();

  std::optional<lua_core::LuaFunctionRef> funcRef;

  if (info.Length() >= 1 && info[0].IsFunction()) {
    auto* fnData = LuaFunctionDataFrom(info[0]);
    if (!fnData) {
      Napi::TypeError::New(env,
        "create_coroutine() accepts a script string or a Lua function; a plain "
        "JavaScript function cannot be a coroutine body")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    // A function from another context refs a slot in an unrelated registry; a
    // released one refs nothing. Same identity checks resume() applies (M1).
    if (fnData->runtime.get() != runtime.get()) {
      Napi::Error::New(env, "Lua function belongs to a different Lua context")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (fnData->funcRef.ref == LUA_NOREF) {
      Napi::Error::New(env, "Lua function has been released")
        .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    // Copying shares the registry slot's ownership rather than minting a second
    // owner for it, so the coroutine body outlives the JS wrapper.
    funcRef = fnData->funcRef;
  } else {
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env,
        "Expected a script string that returns a function, or a Lua function")
        .ThrowAsJavaScriptException();
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
    funcRef = std::get<lua_core::LuaFunctionRef>(values[0]->value);
  }

  auto result = runtime->CreateCoroutine(*funcRef);
  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env, std::get<std::string>(result)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto& threadRef = std::get<lua_core::LuaThreadRef>(result);
  return CreateCoroutineObject(
    std::make_unique<LuaThreadData>(runtime, threadRef), "suspended");
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

  std::vector<Napi::Value> args;
  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  for (size_t i = 1; i < info.Length(); ++i) args.push_back(info[i]);
  return ResumeCoroutineObject(info[0].As<Napi::Object>(), args);
}

// close(coro) — P3.
//
// Runs a suspended coroutine's pending to-be-closed variables (`local x <close>`)
// and marks the thread dead, mirroring Lua's own `coroutine.close`. Before this
// existed there was no way to run them from JS at all: `release()` frees the
// registry slot without executing anything, and collecting the thread runs `__gc`
// but not `__close`.
//
// It matters here more than in most bridges because two shipped features make an
// abandoned suspended coroutine ordinary rather than exceptional — `__close` is
// explicitly advertised as working through `set_metatable`, and `for..of` over a
// coroutine deliberately leaves it suspended when the loop breaks.
//
// **`release()` deliberately still does not close.** Folding a close into it
// would make a "free this slot" call run arbitrary Lua — and from there JS —
// re-entrantly, and give it a way to throw; release() is called from teardown
// paths where neither is acceptable. The two stay orthogonal, exactly as
// `coroutine.close` and letting a thread be collected are orthogonal in Lua.
Napi::Value LuaContext::CloseCoroutine(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  // A __close handler runs Lua, which can reach a host callback; the scope is
  // what makes that re-entrancy visible to the occupancy checks (CR-9 F1).
  CallScope scope(this);
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "close(coroutine) requires a coroutine object")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const auto coroObj = info[0].As<Napi::Object>();

  // Single branded read, and the same identity checks resume applies (CR-15 F6,
  // M1): a thread from another context would be closed with this context's main
  // state as `from`, which is two unrelated Lua states in one call.
  auto* threadData =
    TaggedData<LuaThreadData>(coroObj.Get("_coroutine"), lua_tags::kThreadData);
  if (!threadData || !threadData->runtime) {
    Napi::TypeError::New(env, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (threadData->runtime.get() != runtime.get()) {
    Napi::Error::New(env, "coroutine belongs to a different Lua context")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Released, so there is no thread to close. Not an error: a released
  // coroutine has no pending state a caller could still be responsible for.
  if (threadData->threadRef.ref == LUA_NOREF) return env.Undefined();

  std::optional<std::string> err;
  try {
    err = runtime->CloseCoroutine(threadData->threadRef);
  } catch (const std::exception& e) {
    // A __close handler can reach the host, so this inherits the whole
    // exception surface a resume has; it must not unwind past N-API (H1).
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // The thread is dead either way — a failed __close still closed everything it
  // reached — so the status is updated before the error is raised.
  (void)coroObj.Set("status", Napi::String::New(env, "dead"));
  if (err) {
    ThrowLuaError(*err);
    return env.Undefined();
  }
  return env.Undefined();
}

// resume_async(coro, ...args) — P1b.
//
// The awaiting counterpart to resume(). A coroutine resumed through resume() is
// driven synchronously, so a host function that returns a Promise anywhere
// inside it hard-errors: A1 (await) and A4 (coroutines) shipped without ever
// intersecting, and `for await (… of coro)` appeared to work only because JS
// falls back to the *synchronous* iterator.
//
// The mechanism is the execute_async driver pointed at a thread the binding does
// not own. Two things follow, and both are deliberate:
//
//  * the M1 guard now admits awaits from this coroutine, because it *is* the
//    driven thread — a coroutine nested inside it still cannot await, and says
//    so;
//  * abandoning the run (cancel(), or a failure) leaves the caller's coroutine
//    suspended and resumable rather than releasing it.
Napi::Value LuaContext::ResumeAsync(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env,
      "resume_async(coroutine, ...args) requires a coroutine object")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::vector<Napi::Value> args;
  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  for (size_t i = 1; i < info.Length(); ++i) args.push_back(info[i]);
  return ResumeCoroutineObjectAsync(info[0].As<Napi::Object>(), args,
                                    info.This().As<Napi::Object>());
}

Napi::Value LuaContext::ResumeCoroutineObjectAsync(
    const Napi::Object& coroObj, const std::vector<Napi::Value>& args_js,
    const Napi::Object& self) {
  const auto reject = [this](const std::string& msg) -> Napi::Value {
    auto deferred = Napi::Promise::Deferred::New(env);
    deferred.Reject(Napi::Error::New(env, msg).Value());
    return deferred.Promise();
  };

  // Scoped like CallAsync's, and for the same two reasons: the marker read and
  // the argument conversion both run user JS and must be inside the guard
  // (CR-13 F1), and the guard must be released before the drive so call_depth_
  // is not held across a suspended await (CR-10 F1). The synchronous pair puts
  // this scope in ResumeCoroutine and leaves ResumeCoroutineObject bare; the
  // async pair cannot, because the scope has to end mid-function.
  LuaThreadData* threadData = nullptr;
  std::vector<lua_core::LuaPtr> args;
  {
  CallScope _cs(this);

  // Identical validation to ResumeCoroutineObject, and identical for a reason:
  // a branded single read (CR-15 F6), same-context identity (M1), and a
  // released-ref check, because driving a foreign or released thread is the same
  // UB whether the driver is synchronous or not. Reported as rejections rather
  // than throws so `await`/`.catch` see everything past the argument check.
  threadData =
    TaggedData<LuaThreadData>(coroObj.Get("_coroutine"), lua_tags::kThreadData);
  if (!threadData || !threadData->runtime) {
    Napi::TypeError::New(env, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (threadData->runtime.get() != runtime.get()) {
    return reject("coroutine belongs to a different Lua context");
  }
  if (threadData->threadRef.ref == LUA_NOREF) {
    return reject("coroutine has been released");
  }

  {
    // One collector spans every argument so a later argument's conversion
    // failure sweeps the callbacks minted by the earlier ones (CR-8 F1).
    JsCallbackCollectorScope collector(this);
    args.reserve(args_js.size());
    try {
      for (const auto& arg : args_js) {
        args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arg)));
      }
    } catch (const std::exception& e) {
      return reject(e.what());
    }
  }
  }  // CallScope closes here — nothing below runs user JS before the drive

  // Borrowed, not owned: async_co_ stays disengaged so FinishAsync releases
  // nothing, and the coroutine object is rooted for the run because
  // async_borrowed_ points into data owned by that object's External finalizer.
  async_borrowed_ = threadData;
  async_coro_obj_ = Napi::Persistent(coroObj);
  async_coroutine_mode_ = true;
  // `self` is the context wrapper, not the coroutine: async_self_ref_ exists to
  // keep the ObjectWrap alive across a suspended await (the settlement callbacks
  // hold only a raw pointer to it). The coroutine object is rooted separately,
  // above, because it owns the thread being driven.
  return BeginAsyncRun(self, args);
}

Napi::Value LuaContext::ResumeCoroutineObject(const Napi::Object& coroObj,
                                              const std::vector<Napi::Value>& args_js) {
  // Single branded read (CR-15 F6). The old form did Has, then Get, then a
  // third read through As<>, and trusted the marker's *name*: a table handle's
  // `_tableRef` External presented as `_coroutine` reached lua_resume through a
  // LuaTableRefData.
  const auto* threadData =
    TaggedData<LuaThreadData>(coroObj.Get("_coroutine"), lua_tags::kThreadData);
  if (!threadData) {
    Napi::TypeError::New(env, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!threadData->runtime) {
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

  // Convert the resume arguments. One collector spans every argument so a later
  // argument's conversion failure sweeps the callbacks minted by the earlier
  // ones (CR-8 F1).
  JsCallbackCollectorScope collector(this);
  std::vector<lua_core::LuaPtr> args;
  args.reserve(args_js.size());
  try {
    for (const auto& arg : args_js) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arg)));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Resume the coroutine
  auto [status, values, error] = runtime->ResumeCoroutine(threadData->threadRef, args);
  return CoroutineResultToJs(coroObj, status, values, error);
}

// Marshals one coroutine step into the `{ status, values, error? }` object both
// resume() and resume_async() answer with, and updates the coroutine object's
// own `status`. Shared so the sync and async doors cannot drift apart in the
// shape they return — the two differ in whether they can await, and in nothing
// else.
Napi::Value LuaContext::CoroutineResultToJs(
    const Napi::Object& coroObj,
    lua_core::CoroutineStatus status,
    const std::vector<lua_core::LuaPtr>& values,
    const std::optional<std::string>& error) {
  const Napi::Object resultObj = Napi::Object::New(env);

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
