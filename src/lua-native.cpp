#include "lua-native.h"
#include "lua-async-worker.h"

#include <cassert>
#include <cmath>
#include <iterator>
#include <limits>
#include <optional>
#include <functional>
#include <algorithm>
#include <array>

// --- Built-in JS type conversion helpers (JS -> Lua) ---

namespace {

// Defines a non-enumerable, non-configurable marker property on an object.
// `configurable: false` blocks `delete obj[key]`, which for a lifetime-owner
// property (an External whose finalizer frees a *Data still referenced by a
// bound C function) would otherwise let JS free the data out from under the
// binding — `delete fn.__luaFnOwner; gc(); fn()` (L6). When `writable` is false
// the value also can't be reassigned (closing the `fn.__luaFnOwner = null`
// vector); pass `writable = true` for identity markers that may be re-tagged
// (e.g. a construct() that returns a pooled object gets a fresh __luaClassRef).
void DefineHiddenProp(const Napi::Env env, Napi::Object obj,
                             const char* key, const Napi::Value value,
                             const bool writable = true) {
  const auto object_ctor = env.Global().Get("Object").As<Napi::Object>();
  const auto define_property = object_ctor.Get("defineProperty").As<Napi::Function>();
  const Napi::Object desc = Napi::Object::New(env);
  (void)desc.Set("value", value);
  (void)desc.Set("enumerable", Napi::Boolean::New(env, false));
  (void)desc.Set("configurable", Napi::Boolean::New(env, false));
  (void)desc.Set("writable", Napi::Boolean::New(env, writable));
  define_property.Call({obj, Napi::String::New(env, key), desc});
}

// --- Marker-External minting and reading (CR-15 F6) --------------------------
//
// The only two operations that should ever touch a marker External's payload.
// See the `lua_tags` block in lua-native.h for why the kind has to be checked
// and not just the provenance.

// Mints a branded External. The tag goes on immediately, so there is no window
// in which the External exists untagged and could be read as one.
template <typename T, typename Finalizer>
Napi::External<T> NewTaggedExternal(const Napi::Env env, T* data,
                                           const napi_type_tag& tag,
                                           Finalizer finalizer) {
  const auto external = Napi::External<T>::New(env, data, finalizer);
  external.TypeTag(&tag);
  return external;
}

// As above, for a payload the External does not own outright: the finalizer is
// handed `hint` and releases that instead (see TableRefOwner).
template <typename T, typename Hint, typename Finalizer>
Napi::External<T> NewTaggedExternal(const Napi::Env env, T* data,
                                           const napi_type_tag& tag,
                                           Finalizer finalizer, Hint* hint) {
  const auto external = Napi::External<T>::New(env, data, finalizer, hint);
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
T* TaggedData(const Napi::Value& value, const napi_type_tag& tag) {
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
std::string JsThrowMessage(const Napi::Error& e) {
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

bool IsInstanceOfGlobal(const Napi::Value& value, const char* ctor_name) {
  const Napi::Env env = value.Env();
  const Napi::Value ctor = env.Global().Get(ctor_name);
  if (!ctor.IsFunction()) return false;
  bool result = false;
  napi_instanceof(env, value, ctor, &result);
  return result;
}

// Copies the raw bytes of a Buffer/TypedArray/ArrayBuffer into a std::string
// (binary-safe). Guards zero-length views to avoid constructing from nullptr.
std::string BinaryBytesToString(const Napi::Value& value) {
  if (value.IsBuffer()) {
    const auto buf = value.As<Napi::Buffer<char>>();
    return buf.Length() ? std::string(buf.Data(), buf.Length()) : std::string();
  }
  if (value.IsTypedArray()) {
    const auto ta = value.As<Napi::TypedArray>();
    auto ab = ta.ArrayBuffer();
    const size_t len = ta.ByteLength();
    const auto* const base = static_cast<const char*>(ab.Data());
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
std::optional<lua_core::LuaValue> ConvertBuiltinType(
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
    const auto array_from =
      env.Global().Get("Array").As<Napi::Object>().Get("from").As<Napi::Function>();
    const auto entries = array_from.Call({value}).As<Napi::Array>();
    lua_core::LuaTable tbl;
    for (uint32_t i = 0; i < entries.Length(); ++i) {
      const auto pair = entries.Get(i).As<Napi::Array>();
      std::string k = pair.Get(static_cast<uint32_t>(0)).ToString().Utf8Value();
      tbl.emplace(std::move(k), std::make_shared<lua_core::LuaValue>(
        recurse(pair.Get(static_cast<uint32_t>(1)), depth + 1)));
    }
    return lua_core::LuaValue::from(std::move(tbl));
  }

  // Set -> Lua array
  if (IsInstanceOfGlobal(value, "Set")) {
    const auto array_from =
      env.Global().Get("Array").As<Napi::Object>().Get("from").As<Napi::Function>();
    const auto vals = array_from.Call({value}).As<Napi::Array>();
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

// A JS number as a size_t limit (maxMemory, maxInstructions, timeout, a gc step
// size), with every input defined. Casting a double that is NaN or out of
// range to an integer is undefined behaviour, and the old `< 0` test let both
// through: on arm64 `maxMemory: NaN` became 0, which means *unlimited* — a
// limit silently switched off. NaN and negatives are refused (nullopt);
// +Infinity and anything past SIZE_MAX saturate, which is what they meant.
// A fractional value truncates, as it always has.
std::optional<size_t> SizeLimitFromNumber(const double num) {
  if (!(num >= 0)) return std::nullopt;  // negative, or NaN
  // SIZE_MAX is not representable as a double; the cast rounds up to 2^N,
  // which makes this the exclusive upper bound.
  constexpr auto kLimitExclusive =
      static_cast<double>(std::numeric_limits<size_t>::max());
  if (num >= kLimitExclusive) return std::numeric_limits<size_t>::max();
  return static_cast<size_t>(num);
}

// The JS-facing name of a coroutine status. One function so a coroutine
// object's `status` and resume()'s result cannot drift apart.
const char* CoroutineStatusName(const lua_core::CoroutineStatus status) {
  switch (status) {
    case lua_core::CoroutineStatus::Suspended: return "suspended";
    case lua_core::CoroutineStatus::Running:   return "running";
    case lua_core::CoroutineStatus::Dead:      return "dead";
  }
  return "dead";
}

// --- Proxy trap functions for LuaTableRef ---

// Guards every table-ref trap and handle method. Throws (and returns true) if
// the handle can't be safely used right now, for either reason:
//  - the backing LuaContext has been destroyed (a retained handle outliving it);
//  - any async op is in flight. Checking the context's is_busy_ (set
//    synchronously before a worker Queue() or an execute_async begins) closes
//    the Queue()-to-async_mode_ window and also blocks reentry during a
//    suspended execute_async, which a runtime_->IsAsyncMode() check would miss.
bool RejectIfWorkerBusy(const Napi::Env env, const LuaTableRefData* data) {
  if (!data || !data->ContextLive() || !data->context) {
    Napi::Error::New(env, std::string("Lua table handle is not usable: ") +
                          (data ? data->liveness.DeadReason()
                                : "its Lua context has been destroyed"))
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

Napi::Value TableRefGetTrap(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

  const auto target = info[0].As<Napi::Object>();
  const auto prop = info[1];

  // Skip symbols
  if (!prop.IsString()) return env.Undefined();

  const std::string key = prop.As<Napi::String>().Utf8Value();

  // Round-trip marker
  if (key == "_tableRef") {
    return target.Get("_tableRef");
  }

  // "then" suppression - prevents Proxy from being treated as a thenable
  if (key == "then") return env.Undefined();

  // A Proxy released via lua.release() must fail clearly instead of indexing
  // registry slot LUA_NOREF (nil), matching the table-handle methods.
  if (data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // A __index metamethod reached here can call a JS host function that throws,
    // which stages a js_error_registry_ entry. This trap raises a plain string
    // (the structured value is stringified by ProtectedTableCall), so nothing
    // consumes that entry by id. The CallScope clears the registry at the
    // outermost access so such entries can't accumulate across trap calls (L7).
    const LuaContext::CallScope scope(data->context);
    const auto result = data->runtime->GetTableField(data->table_ref.ref, key);
    return data->context->CoreToNapi(*result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value TableRefSetTrap(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

  const auto prop = info[1];
  const auto value = info[2];

  if (!prop.IsString()) return Napi::Boolean::New(env, true);

  const std::string key = prop.As<Napi::String>().Utf8Value();

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, true);
  }

  try {
    // See TableRefGetTrap: clear the registry at the outermost access so a
    // staged entry from a raising __newindex host callback can't accumulate (L7).
    const LuaContext::CallScope scope(data->context);
    const auto core_value = std::make_shared<lua_core::LuaValue>(
      data->context->NapiToCoreInstance(value));
    data->runtime->SetTableField(data->table_ref.ref, key, core_value);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value TableRefHasTrap(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

  const auto prop = info[1];

  if (!prop.IsString()) return Napi::Boolean::New(env, false);

  const std::string key = prop.As<Napi::String>().Utf8Value();

  if (key == "_tableRef") return Napi::Boolean::New(env, true);

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  try {
    // Clear the JS-error registry at the outermost access so a staged entry from
    // a raising __index host callback can't accumulate (L3, mirrors get/set).
    const LuaContext::CallScope scope(data->context);
    const bool has = data->runtime->HasTableField(data->table_ref.ref, key);
    return Napi::Boolean::New(env, has);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
}

Napi::Value TableRefOwnKeysTrap(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return Napi::Array::New(env, 0);
  }

  try {
    const LuaContext::CallScope scope(data->context);
    auto keys = data->runtime->GetTableKeys(data->table_ref.ref);
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

Napi::Value TableRefGetOwnPropertyDescriptorTrap(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();

  const auto prop = info[1];

  if (!prop.IsString()) return env.Undefined();

  const std::string key = prop.As<Napi::String>().Utf8Value();

  // See TableRefGetTrap: a released Proxy fails clearly.
  if (data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    const LuaContext::CallScope scope(data->context);
    if (data->runtime->HasTableField(data->table_ref.ref, key)) {
      const auto value = data->runtime->GetTableField(data->table_ref.ref, key);
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
bool NapiToTableKey(const Napi::Value& value, lua_core::TableKey& out) {
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
  // Booleans are real Lua keys and `handle.pairs()` emits them (August 7, 2026).
  // Accepting them here is what makes that emission addressable: a key the
  // caller can see and cannot read back would be a worse limitation than the
  // silent drop it replaced.
  if (value.IsBoolean()) {
    out = value.As<Napi::Boolean>().Value();
    return true;
  }
  return false;
}

Napi::Value TableHandleGet(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "get() requires a key argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    Napi::TypeError::New(env, "get() key must be a string, number, or boolean").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // Metamethod-capable operation: scope under a CallScope so a staged
    // js_error_registry_ entry from a raising __index host callback is cleared
    // at the next outermost access instead of accumulating (CR-8 F5 — the
    // L7/L3 discipline the Proxy traps already follow, applied to the handle
    // surface).
    const LuaContext::CallScope scope(data->context);
    const auto result = data->runtime->GetTableFieldKeyed(data->table_ref.ref, key);
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
Napi::Value TableHandleGetRef(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "get_ref() requires a key argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    Napi::TypeError::New(env, "get_ref() key must be a string, number, or boolean").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::variant<int, std::string> result;
  try {
    // The read runs __index, so it carries the same CallScope discipline as
    // get() (CR-8 F5).
    const LuaContext::CallScope scope(data->context);
    result = data->runtime->GetTableFieldRef(data->table_ref.ref, key);
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

Napi::Value TableHandleSet(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "set() requires key and value arguments").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    Napi::TypeError::New(env, "set() key must be a string, number, or boolean").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // See TableHandleGet: CallScope so a raising __newindex host callback's
    // staged entry can't accumulate (CR-8 F5).
    const LuaContext::CallScope scope(data->context);
    const auto value = std::make_shared<lua_core::LuaValue>(
      data->context->NapiToCoreInstance(info[1]));
    data->runtime->SetTableFieldKeyed(data->table_ref.ref, key, value);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value TableHandleHas(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "has() requires a key argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  lua_core::TableKey key;
  if (!NapiToTableKey(info[0], key)) {
    Napi::TypeError::New(env, "has() key must be a string, number, or boolean").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // See TableHandleGet: CallScope for the metamethod-capable probe (CR-8 F5).
    const LuaContext::CallScope scope(data->context);
    const bool exists = data->runtime->HasTableFieldKeyed(data->table_ref.ref, key);
    return Napi::Boolean::New(env, exists);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
}

Napi::Value TableHandleLength(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // See TableHandleGet: CallScope — __len can reach a raising host callback
    // (CR-8 F5).
    const LuaContext::CallScope scope(data->context);
    const int64_t len = data->runtime->GetTableLength(data->table_ref.ref);
    return Napi::Number::New(env, static_cast<double>(len));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value TableHandlePairs(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
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
    const LuaContext::CallScope scope(data->context);
    auto pairs = data->runtime->TablePairs(data->table_ref.ref);
    Napi::Array result = Napi::Array::New(env, pairs.size());
    for (size_t i = 0; i < pairs.size(); ++i) {
      const Napi::Array entry = Napi::Array::New(env, 2);
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

// Defined with the coroutine iterator further down, which was the first user.
Napi::Value SymbolIteratorKey(Napi::Env env);

// The key snapshot behind `keys()` and `[Symbol.iterator]()`. Converting keys
// runs no from-Lua converter (a key is a string, number or boolean by the time
// it gets here) but CoreToNapi is still the one place that knows about
// `binaryStrings`, so it goes through the same door as everything else.
Napi::Value TableHandleKeys(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    const LuaContext::CallScope scope(data->context);  // as TableHandlePairs, CR-13 F1
    auto keys = data->runtime->TableKeys(data->table_ref.ref);
    Napi::Array result = Napi::Array::New(env, keys.size());
    for (size_t i = 0; i < keys.size(); ++i) {
      (void)result.Set(static_cast<uint32_t>(i), data->context->CoreToNapi(*keys[i]));
    }
    return result;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// How a table *handle's* data is owned: shared between the `_tableRef`
// External, whose finalizer deletes its TableRefOwner, and every cursor minted
// from the handle. The metatabled-table Proxy has no cursor and keeps the
// plain single-owner form.
using TableRefOwner = std::shared_ptr<LuaTableRefData>;

// One iteration cursor over a table handle. Mirrors LuaCoroIterState below:
// each `[Symbol.iterator]()` mints a fresh one, so two loops over the same
// handle are independent.
//
// **Why the keys are eager and only the values are lazy.** A cursor that kept
// `lua_next` open across a return into JavaScript would be undefined the
// moment the caller touched the table mid-loop — the same hazard CR-15 F2
// drove through a `__gc` finalizer (a 200-entry table yielding 2682 entries),
// except that arbitrary JS between two `next()` calls is a far wider window
// than a finalizer. So `TableKeys` snapshots the key set up front and each
// `next()` does an independent raw read. What that buys is the expensive
// half: values are converted one at a time instead of all at once, and a
// value conversion is what mints handles and runs registered converters.
//
// **The cursor co-owns the handle's data; it does not borrow it.** `data` was a
// raw pointer, kept valid only by `handle` below — and `handle` is `this`,
// which is the table handle only when `[Symbol.iterator]` is called as a
// method. `const f = h[Symbol.iterator]; const it = f.call(undefined)` left
// nothing rooting the data, and once the handle was collected `it.next()` read
// freed memory (a segfault, three runs of three). Found by the WASM port,
// which roots the table on the cursor and so answered where native crashed.
//
// The handle object is still held strongly (an ObjectReference), matching the
// coroutine iterator: nothing on the handle points back here, so no cycle. It
// is no longer what keeps `data` valid.
struct LuaTableIterState {
  TableRefOwner data;
  ContextLiveness liveness;
  Napi::ObjectReference handle;
  std::vector<lua_core::LuaPtr> keys;
  size_t index = 0;
  // Same predicate the handle itself uses: true while this handle's Lua
  // state is still the context's current one.
  [[nodiscard]] bool ContextLive() const { return liveness.HandlesLive(); }
};

// Same ownership discipline as the coroutine cursor below: the state is
// shared_ptr-owned and every GC root is an External wrapping its own copy, so
// "rooted on the iterator and on each bound method" is expressed by ownership
// rather than by keeping one designated holder alive (H3 / L6).
using TableIterOwner = std::shared_ptr<LuaTableIterState>;

// The unique_ptr owns the copy until the External's finalizer takes over, so
// a throw from External::New cannot leak it (CR-9 F4).
Napi::Value NewTableIterOwner(const Napi::Env env, const TableIterOwner& sp) {
  auto holder = std::make_unique<TableIterOwner>(sp);
  const auto ext = Napi::External<TableIterOwner>::New(env, holder.get(),
    [](Napi::Env, const TableIterOwner* h) { delete h; });
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)holder.release();  // ownership transferred to the finalizer
  return ext;
}

// Converts a snapshotted key back to the addressing type the raw read needs.
// Total by construction: TableKeys only emits these three.
bool KeyToTableKey(const lua_core::LuaValue& v, lua_core::TableKey& out) {
  if (std::holds_alternative<std::string>(v.value)) {
    out = std::get<std::string>(v.value);
  } else if (std::holds_alternative<int64_t>(v.value)) {
    out = std::get<int64_t>(v.value);
  } else if (std::holds_alternative<double>(v.value)) {
    out = std::get<double>(v.value);
  } else if (std::holds_alternative<bool>(v.value)) {
    out = std::get<bool>(v.value);
  } else {
    return false;
  }
  return true;
}

Napi::Value TableIteratorNext(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  auto* state = static_cast<LuaTableIterState*>(info.Data());
  if (!state) {
    Napi::Error::New(env, "table iterator is not usable").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const auto finished = [&]() {
    Napi::Object out = Napi::Object::New(env);
    (void)out.Set("value", env.Undefined());
    (void)out.Set("done", Napi::Boolean::New(env, true));
    return out;
  };

  if (!state->ContextLive()) {
    Napi::Error::New(env, std::string("table handle is not usable: ") +
                          state->liveness.DeadReason())
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Released mid-loop. Ending the iteration is the honest answer: the entries
  // this cursor was walking are no longer reachable, and inventing values for
  // them would be answering with another state's data.
  if (!state->data || state->data->table_ref.ref == LUA_NOREF) {
    state->keys.clear();
    return finished();
  }

  try {
    const LuaContext::CallScope scope(state->data->context);
    while (state->index < state->keys.size()) {
      const lua_core::LuaPtr key = state->keys[state->index++];
      lua_core::TableKey addr;
      if (!key || !KeyToTableKey(*key, addr)) continue;

      // Raw, so the cursor reports what `pairs()` reports rather than what an
      // `__index` metamethod would answer.
      const auto value = state->data->runtime->RawGetTableFieldKeyed(
        state->data->table_ref.ref, addr);
      // Deleted between the snapshot and now: skip it, as a traversal that
      // reached the key later would have.
      if (!value || std::holds_alternative<std::monostate>(value->value)) continue;

      const Napi::Array entry = Napi::Array::New(env, 2);
      (void)entry.Set(static_cast<uint32_t>(0), state->data->context->CoreToNapi(*key));
      (void)entry.Set(static_cast<uint32_t>(1), state->data->context->CoreToNapi(*value));

      Napi::Object out = Napi::Object::New(env);
      (void)out.Set("value", entry);
      (void)out.Set("done", Napi::Boolean::New(env, false));
      return out;
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  state->keys.clear();
  return finished();
}

Napi::Value TableIteratorSelf(const Napi::CallbackInfo& info) {
  return info.This();
}

// `info.Data()` is the handle's TableRefOwner, not the bare data the named
// methods get: this is the one method whose result outlives the call, so it is
// the one that needs a share to hand on. The owner itself is deleted by the
// `_tableRef` External's finalizer, and this function roots that External
// (`_tableOwner`), so it is valid for as long as the function can be called.
Napi::Value TableHandleSymbolIterator(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const auto* owner = static_cast<TableRefOwner*>(info.Data());
  const LuaTableRefData* data = owner ? owner->get() : nullptr;
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const TableIterOwner sp = std::make_shared<LuaTableIterState>();
  LuaTableIterState* state = sp.get();
  state->data = *owner;
  state->liveness = data->liveness;  // the handle already carries it
  if (info.This().IsObject()) state->handle = Napi::Persistent(info.This().As<Napi::Object>());

  // The snapshot happens here, at `[Symbol.iterator]()`, not at the first
  // `next()`: it is the traversal, and it must complete before any JS the loop
  // body runs can touch the table.
  try {
    const LuaContext::CallScope scope(data->context);
    state->keys = data->runtime->TableKeys(data->table_ref.ref);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const Napi::Object iterator = Napi::Object::New(env);
  DefineHiddenProp(env, iterator, "__tableIterOwner", NewTableIterOwner(env, sp),
                   /*writable=*/false);

  const auto add_method = [&](const char* name,
                       Napi::Value (*cb)(const Napi::CallbackInfo&)) {
    const Napi::Function fn = Napi::Function::New(env, cb, name, state);
    DefineHiddenProp(env, fn, "__tableIterOwner", NewTableIterOwner(env, sp),
                     /*writable=*/false);
    (void)iterator.Set(name, fn);
  };
  add_method("next", TableIteratorNext);
  (void)iterator.Set(SymbolIteratorKey(env),
    Napi::Function::New(env, TableIteratorSelf, "[Symbol.iterator]"));
  return iterator;
}

Napi::Value TableHandleIPairs(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "table handle has been released").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  try {
    // See TableHandleGet: CallScope — the ipairs collection respects __index
    // (CR-8 F5). pairs() has one too: it fires no metamethod, but it converts
    // results through user JS like this one does (CR-13 F1).
    const LuaContext::CallScope scope(data->context);
    auto ipairs = data->runtime->TableIPairs(data->table_ref.ref);
    Napi::Array result = Napi::Array::New(env, ipairs.size());
    for (size_t i = 0; i < ipairs.size(); ++i) {
      const Napi::Array entry = Napi::Array::New(env, 2);
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

Napi::Value TableHandleRelease(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  auto* data = static_cast<LuaTableRefData*>(info.Data());
  if (RejectIfWorkerBusy(env, data)) return env.Undefined();
  if (!data || data->table_ref.ref == LUA_NOREF) {
    // Already released — no-op
    return env.Undefined();
  }

  // Drop this handle's share of the registry slot (unref'd iff it was the last
  // owner) and mark the handle released.
  data->table_ref.release();
  return env.Undefined();
}

Napi::Value LuaFunctionCallbackStatic(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();

  const auto* data = static_cast<LuaFunctionData*>(info.Data());
  if (!data || !data->runtime || !data->context || !data->ContextLive()) {
    Napi::Error::New(env, std::string("Lua function is not usable: ") +
                          (data ? data->liveness.DeadReason()
                                : "its Lua context has been destroyed"))
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // A released ref would rawget registry slot LUA_NOREF (nil) and fail with an
  // opaque "attempt to call a nil value" — surface a clear error instead,
  // matching the table-handle behavior.
  if (data->func_ref.ref == LUA_NOREF) {
    Napi::Error::New(env, "Lua function has been released")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Reject reentry while any async op is in flight. Checking the context's
  // is_busy_ (set synchronously before either a worker Queue() or an
  // execute_async begins) closes two gaps that a runtime_->IsAsyncMode() check
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
  const LuaContext::CallScope call_scope(data->context);

  // Convert JS arguments to Lua values. One collector spans every argument so
  // that a later argument failing to convert sweeps the reclaimable callbacks
  // minted by the earlier ones — each argument's own conversion scope has
  // already closed by then, so it cannot clean up its siblings (F1).
  const LuaContext::JsCallbackCollectorScope collector(data->context);
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
  const auto result = data->runtime->CallFunction(data->func_ref, args);

  // Handle error case
  if (std::holds_alternative<std::string>(result)) {
    data->context->ThrowLuaError(std::get<std::string>(result));
    return env.Undefined();
  }

  // Convert results back to JS (undefined / single value / array)
  return data->context->ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(result));
}

}  // namespace

// --- SharedTable: JS-side state mirrored into several contexts ---

Napi::Function SharedTable::DefineSharedTable(const Napi::Env env) {
  return DefineClass(env, "SharedTable", {
    InstanceMethod("get", &SharedTable::Get),
    InstanceMethod("set", &SharedTable::Set),
    InstanceMethod("sync", &SharedTable::Sync)
  });
}

SharedTable::SharedTable(const Napi::CallbackInfo& info) : ObjectWrap(info) {
  const Napi::Env env = info.Env();
  // Brand the instance so AsSharedTable can ask what it *is* rather than what
  // its constructor claims. Applied at the one mint site there is; a second one
  // that forgot this would fail closed at the read, which is the right
  // direction to fail (see lua_tags).
  info.This().As<Napi::Object>().TypeTag(&lua_tags::kSharedTable);

  if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull()) {
    // IsObject() is true for functions too, so exclude them explicitly.
    if (!info[0].IsObject() || info[0].IsFunction()) {
      Napi::TypeError::New(env,
        "createSharedTable(initial) requires an object")
        .ThrowAsJavaScriptException();
      return;
    }
    // Held, not copied: the caller keeps a usable handle on the shared state,
    // so mutating it directly and calling sync() is a supported workflow.
    value_ = Napi::Persistent(info[0].As<Napi::Object>());
  } else {
    value_ = Napi::Persistent(Napi::Object::New(env));
  }
}

void SharedTable::PushValue(const Napi::Object& context, const std::string& name,
                            const Napi::Value& value) {
  const Napi::Env env = context.Env();
  const Napi::Value setter = context.Get("set_global");
  if (!setter.IsFunction()) {
    // Two different facts, and the old message asserted the wrong one: a
    // subscriber is always a real context (Subscribe is only ever called from
    // the constructor with `this`), so reaching here means its `set_global` has
    // been shadowed by an own property rather than that this is not a context
    // (CR-19 F5c).
    throw Napi::Error::New(env,
      "shared table subscriber's set_global is not a function; it has been "
      "shadowed by an own property on the context");
  }
  // Routed through the context's own public set_global so a shared value gets
  // exactly the same treatment as any other JS value crossing into that state:
  // registered type converters, nested-callback handling, the busy guard, and
  // the protected write that turns an OOM into a JS error.
  (void)setter.As<Napi::Function>().Call(context,
    {Napi::String::New(env, name), value});
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

void SharedTable::Propagate(const Napi::Env env) {
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
    throw Napi::Error::New(env,
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
  const Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "get(key) requires a string key")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return value_.Value().Get(info[0].As<Napi::String>());
}

Napi::Value SharedTable::Set(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString()) {
    Napi::TypeError::New(env, "set(key, value) requires a string key and a value")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  (void)value_.Value().Set(info[0].As<Napi::String>(), info[1]);
  Propagate(env);  // a failed push throws after every other context is updated
  return env.Undefined();
}

Napi::Value SharedTable::Sync(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  Propagate(env);
  return env.Undefined();
}

namespace {

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
SharedTable* AsSharedTable(const Napi::Env env, const Napi::Value& value) {
  if (!value.IsObject() || value.IsFunction()) return nullptr;
  const auto* data = env.GetInstanceData<AddonData>();
  if (!data || data->shared_table_constructor.IsEmpty()) return nullptr;
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

}  // namespace

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
    InstanceMethod("get_stack", &LuaContext::GetStack),
    InstanceMethod("get_locals", &LuaContext::GetLocals),
    InstanceMethod("add_searcher", &LuaContext::AddSearcher),
    InstanceMethod("release", &LuaContext::Release),
    InstanceMethod("dispose", &LuaContext::Dispose),
    InstanceMethod("reset", &LuaContext::Reset),
    InstanceMethod("gc", &LuaContext::GC)
  });

  // The constructor is kept alive by the persistent reference InitModule stores
  // as instance data (and by `exports` itself), so no separate leaked
  // FunctionReference is needed here.
  (void)exports.Set(Napi::String::New(env, "init"), func);

  return exports;
}

namespace {

// The constructor's option parsing, as functions of the options object alone.
// They run before any Lua state exists, so the user JS their `Has`/`Get` calls
// can run (a getter, a Proxy trap) has nothing to invalidate — the reason the
// constructor itself needs no CallScope (see lua-native.h). Each returns false
// with a JS exception pending. **The order of the reads is part of the
// behaviour**: an options object with getters observes it.

// One non-negative numeric limit: maxMemory, maxInstructions or timeout.
bool ReadLimitOption(const Napi::Env env, const Napi::Object& options, const char* key,
                     size_t& value, bool& present) {
  if (!options.Has(key)) return true;
  const Napi::Value raw = options.Get(key);
  if (raw.IsNumber()) {
    const auto limit = SizeLimitFromNumber(raw.As<Napi::Number>().DoubleValue());
    if (!limit) {
      Napi::RangeError::New(env, std::string(key) + " must be a non-negative number")
        .ThrowAsJavaScriptException();
      return false;
    }
    value = *limit;
    present = true;
    return true;
  }
  if (!raw.IsUndefined() && !raw.IsNull()) {
    Napi::TypeError::New(env, std::string(key) + " must be a number")
      .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// `strictConversion`: refuse the silent conversion losses instead of
// performing them (LIMITATIONS §5). A wrong *type* here is rejected rather
// than ignored, unlike `binaryStrings` — the option exists to catch mistakes,
// so `strictConversion: 'yes'` quietly meaning "off" would be the exact
// failure it is meant to prevent.
bool ReadStrictConversionOption(const Napi::Env env, const Napi::Object& options,
                                bool& strict_conversion) {
  if (!options.Has("strictConversion")) return true;
  const Napi::Value strict_val = options.Get("strictConversion");
  if (strict_val.IsBoolean()) {
    strict_conversion = strict_val.As<Napi::Boolean>().Value();
    return true;
  }
  if (!strict_val.IsUndefined() && !strict_val.IsNull()) {
    Napi::TypeError::New(env, "strictConversion must be a boolean")
      .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// A named `libraries` preset.
bool ApplyLibraryPreset(const Napi::Env env, const std::string& preset,
                        ContextInitOptions& init) {
  if (preset == "all") {
    init.libraries = lua_core::LuaRuntime::AllLibraries();
  } else if (preset == "safe") {
    init.libraries = lua_core::LuaRuntime::SafeLibraries();
  } else if (preset == "sandbox") {
    // 'safe' minus `package`, plus the base-library seal and a bytecode
    // default of off — the combination that is actually sealed against
    // untrusted code. See LuaRuntime::SandboxLibraries.
    init.libraries = lua_core::LuaRuntime::SandboxLibraries();
    init.seal_base_filesystem = true;
    init.sandbox_preset = true;
  } else {
    Napi::TypeError::New(env, "libraries must be 'all', 'safe', 'sandbox', or an array of library names").ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// `libraries`: an array of names, or a preset.
bool ReadLibrariesOption(const Napi::Env env, const Napi::Object& options,
                         ContextInitOptions& init) {
  if (!options.Has("libraries")) return true;
  const auto libs_val = options.Get("libraries");
  if (libs_val.IsArray()) {
    const auto arr = libs_val.As<Napi::Array>();
    init.libraries.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); ++i) {
      if (!arr.Get(i).IsString()) {
        Napi::TypeError::New(env, "libraries array must contain only strings").ThrowAsJavaScriptException();
        return false;
      }
      init.libraries.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
    }
    init.has_libraries = true;
    return true;
  }
  if (libs_val.IsString()) {
    if (!ApplyLibraryPreset(env, libs_val.As<Napi::String>().Utf8Value(), init)) {
      return false;
    }
    init.has_libraries = true;
    return true;
  }
  Napi::TypeError::New(env, "libraries must be 'all', 'safe', 'sandbox', or an array of library names").ThrowAsJavaScriptException();
  return false;
}

// Everything the runtime's *construction* depends on.
bool ParseInitOptions(const Napi::Env env, const Napi::Object& options,
                      ContextInitOptions& init) {
  return ReadLimitOption(env, options, "maxMemory", init.max_memory, init.has_max_memory) &&
         ReadLimitOption(env, options, "maxInstructions", init.max_instructions,
                         init.has_max_instructions) &&
         ReadLimitOption(env, options, "timeout", init.timeout_ms, init.has_timeout) &&
         ReadStrictConversionOption(env, options, init.strict_conversion) &&
         ReadLibrariesOption(env, options, init);
}

}  // namespace

// Builds the Lua state the parsed options describe. Guarded on every path:
// lua_newstate failing and an unknown library name both throw, and a
// std::exception leaving an ObjectWrap constructor is not converted by
// node-addon-api — it terminates.
bool LuaContext::CreateRuntime(ContextInitOptions& init) {
  try {
    // `seal_base_filesystem` and `strict_conversion` live on RuntimeConfig, so
    // either one must take the config path even with no limits set — the
    // libraries-only constructor would silently drop them.
    if (init.has_max_memory || init.has_max_instructions || init.has_timeout ||
        init.seal_base_filesystem || init.strict_conversion) {
      lua_core::RuntimeConfig config;
      config.libraries = std::move(init.libraries);
      config.max_memory = init.max_memory;
      config.max_instructions = init.max_instructions;
      config.timeout_ms = init.timeout_ms;
      config.seal_base_filesystem = init.seal_base_filesystem;
      // Carried on the config, so reset() — which rebuilds from GetConfig() —
      // keeps the mode without a replay step.
      config.strict_conversion = init.strict_conversion;
      runtime_ = std::make_shared<lua_core::LuaRuntime>(config);
    } else if (init.has_libraries) {
      runtime_ = std::make_shared<lua_core::LuaRuntime>(init.libraries);
    } else {
      // No options that matter -> bare state.
      runtime_ = std::make_shared<lua_core::LuaRuntime>();
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// T2. Applied after the libraries are open, because it closes doors that
// only exist once they are — and a non-string value is rejected rather
// than ignored, for the reason `strictConversion` states: an option whose
// job is to remove a capability must never fail quietly.
//
// Called inside ApplyStateOptions's try: SetFilesystemAccess throws on OOM.
bool LuaContext::ApplyFilesystemOption(const Napi::Object& options) {
  if (!options.Has("filesystem")) return true;
  const Napi::Value fs = options.Get("filesystem");
  if (fs.IsUndefined() || fs.IsNull()) return true;
  if (!fs.IsString()) {
    Napi::TypeError::New(env_, "filesystem must be 'allow' or 'deny'")
      .ThrowAsJavaScriptException();
    return false;
  }
  const std::string mode = fs.As<Napi::String>().Utf8Value();
  if (mode == "deny") {
    filesystem_denied_ = true;
    runtime_->SetFilesystemAccess(false);
  } else if (mode != "allow") {
    Napi::TypeError::New(env_,
      "filesystem must be 'allow' or 'deny', got '" + mode + "'")
      .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// T1. Rejected rather than ignored when misspelled, like `filesystem`
// above: an option that silently stayed off would hand back objects that
// look right and have already lost keys — the exact failure it exists to
// remove.
bool LuaContext::ApplyTableAsOption(const Napi::Object& options) {
  if (!options.Has("tableAs")) return true;
  const Napi::Value mode = options.Get("tableAs");
  if (mode.IsUndefined() || mode.IsNull()) return true;
  if (!mode.IsString()) {
    Napi::TypeError::New(env_, "tableAs must be 'object' or 'map'")
      .ThrowAsJavaScriptException();
    return false;
  }
  const std::string want = mode.As<Napi::String>().Utf8Value();
  if (want == "map") {
    table_as_map_ = true;
    runtime_->SetPreserveTableKeys(true);
  } else if (want != "object") {
    Napi::TypeError::New(env_,
      "tableAs must be 'object' or 'map', got '" + want + "'")
      .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// The options that act on a state that already exists, apart from `print`
// (which the constructor applies itself, last). Applied after callbacks and
// after libraries are loaded. SetAllowBytecode and SetFilesystemAccess run
// protected _G writes that throw on OOM under maxMemory; surface that as a JS
// error instead of letting a std::runtime_error unwind out of the constructor
// and terminate the process (the H1 class, CR-6 F1). A hostile _G metatable
// can't be armed before the constructor runs, so only the OOM trigger is
// reachable here.
bool LuaContext::ApplyStateOptions(const Napi::Object& options, const bool sandbox_preset) {
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
      runtime_->SetAllowBytecode(false);  // E3
    }
    if (!ApplyFilesystemOption(options)) return false;
    if (options.Has("binaryStrings") && options.Get("binaryStrings").IsBoolean() &&
        options.Get("binaryStrings").As<Napi::Boolean>().Value()) {
      binary_strings_ = true;
    }
    if (!ApplyTableAsOption(options)) return false;
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// Shared state: subscribe to each SharedTable and publish its current value
// as a global. Done last, because subscribing pushes the value through this
// context's own set_global — which needs the runtime, the handlers, and the
// type converters all in place. A failure here throws from `new`, so it must
// be reported the way every other constructor failure is (a pending JS
// exception, never a C++ throw unwinding out of a partially-built ObjectWrap).
void LuaContext::SubscribeSharedTables(const Napi::Object& self, const Napi::Object& options) {
  if (!options.Has("shared")) return;
  const Napi::Value shared_val = options.Get("shared");
  if (shared_val.IsUndefined() || shared_val.IsNull()) return;
  if (!shared_val.IsObject() || shared_val.IsArray() || shared_val.IsFunction()) {
    Napi::TypeError::New(env_,
      "shared must be an object mapping global names to shared tables")
      .ThrowAsJavaScriptException();
    return;
  }
  // A shared table handed over directly has no own enumerable keys, so it
  // would otherwise subscribe nothing at all — silently. Name the mistake.
  if (AsSharedTable(env_, shared_val)) {
    Napi::TypeError::New(env_,
      "shared must be an object mapping global names to shared tables "
      "(e.g. { settings: sharedTable }), not a shared table itself")
      .ThrowAsJavaScriptException();
    return;
  }
  const auto shared_obj = shared_val.As<Napi::Object>();
  const Napi::Array names = shared_obj.GetPropertyNames();
  for (uint32_t i = 0; i < names.Length(); ++i) {
    const std::string name = names.Get(i).As<Napi::String>().Utf8Value();
    const Napi::Value entry = shared_obj.Get(name);
    SharedTable* table = AsSharedTable(env_, entry);
    if (!table) {
      Napi::TypeError::New(env_,
        "shared." + name +
        " must be a shared table created with createSharedTable()")
        .ThrowAsJavaScriptException();
      return;
    }
    try {
      table->Subscribe(self, name);
    } catch (const Napi::Error& e) {
      e.ThrowAsJavaScriptException();
      return;
    } catch (const std::exception& e) {
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return;
    }
    // Retained so reset() can re-publish it onto the fresh state.
    shared_tables_.emplace_back(
      Napi::Persistent(entry.As<Napi::Object>()), name);
  }
}

// Three phases, each of which can fail with a JS exception pending: build the
// state the options describe, attach the callbacks, then apply the options
// that act on a live state. `init.sandbox_preset` is parsed with the libraries
// in the first phase and consumed in the third, where it sets the
// `allowBytecode` default.
LuaContext::LuaContext(const Napi::CallbackInfo& info)
  : ObjectWrap(info), env_(info.Env()) {
  // Check for options (second argument)
  const bool has_options = info.Length() > 1 && info[1].IsObject();

  ContextInitOptions init;
  if (has_options && !ParseInitOptions(env_, info[1].As<Napi::Object>(), init)) return;
  if (!CreateRuntime(init)) return;

  InstallRuntimeHandlers();

  if (info.Length() > 0 && info[0].IsObject()) {
    // Retained so reset() can re-register the same callbacks on a fresh state.
    callbacks_ref_ = Napi::Persistent(info[0].As<Napi::Object>());
    RegisterCallbacks(info[0].As<Napi::Object>());
  }

  if (!has_options) return;
  const auto options = info[1].As<Napi::Object>();
  if (!ApplyStateOptions(options, init.sandbox_preset)) return;

  // E1. Last of the state options, so the print override wins over any
  // callback-provided print. Applied here rather than in ApplyStateOptions
  // because tools/invariants/liveness-guarding scores InstallPrintHandler by
  // its callers, and the constructor is the one caller it knows cannot be
  // entered on a retired state. Guarded: the install is a protected _G write
  // that throws on OOM.
  try {
    if (options.Has("print") && options.Get("print").IsFunction()) {
      InstallPrintHandler(options.Get("print").As<Napi::Function>());
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return;
  }

  SubscribeSharedTables(info.This().As<Napi::Object>(), options);
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

// `__index` for proxy userdata and class instances (the core's property
// getter). Runs inside a Lua C frame; the HandleScope keeps per-access N-API
// handles from accumulating across a hot property-access loop.
lua_core::LuaPtr LuaContext::ReadUserdataProperty(const int ref_id, const std::string& key) {
  const Napi::HandleScope scope(env_);
  const auto it = js_userdata_.find(ref_id);
  if (it == js_userdata_.end()) {
    return std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::nil());
  }
  // Named accessors (P2b) are consulted before the readable check, and win
  // over it: declaring `properties: { health: { get } }` is how a class
  // exposes exactly `health` while leaving the rest of the instance opaque.
  // Methods still take precedence over both, because ClassIndex resolves the
  // method table before it ever reaches a property handler.
  const ClassAccessor* acc = it->second.class_name.empty()
    ? nullptr : FindClassAccessor(it->second.class_name, key);
  if (acc) {
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
      const Napi::Value val = getter.Call(self, {self});
      return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val));
    } catch (const Napi::Error& e) {
      throw Napi::Error::New(env_, JsThrowMessage(e));
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
    const Napi::Value val = it->second.object.Value().Get(key);
    return std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val));
  } catch (const Napi::Error& e) {
    throw Napi::Error::New(env_, JsThrowMessage(e));
  }
}

// `__newindex`, the setter half. See ReadUserdataProperty.
void LuaContext::WriteUserdataProperty(const int ref_id, const std::string& key,
                                       const lua_core::LuaPtr& value) {
  const Napi::HandleScope scope(env_);
  const auto it = js_userdata_.find(ref_id);
  if (it == js_userdata_.end()) return;
  // See the getter: accessors are consulted first and win over `writable`,
  // which is what makes a read-only field on an otherwise writable instance
  // expressible.
  const ClassAccessor* acc = it->second.class_name.empty()
    ? nullptr : FindClassAccessor(it->second.class_name, key);
  if (acc) {
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
      throw Napi::Error::New(env_, JsThrowMessage(e));
    }
    return;
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
    throw Napi::Error::New(env_, JsThrowMessage(e));  // see the getter (CR-18 F2)
  }
}

void LuaContext::InstallRuntimeHandlers() {
  // Set up userdata GC callback. The core has already dropped the Lua-side
  // method table by the time this runs; drop the JS half — the object reference
  // and the method callbacks minted alongside it — so a short-lived userdata
  // with methods doesn't pin them for the life of the context (CR-11 F4).
  runtime_->SetUserdataGCCallback([this](int ref_id) {
    js_userdata_.erase(ref_id);
    if (const auto it = ud_method_fns_.find(ref_id); it != ud_method_fns_.end()) {
      for (const auto& func_name : it->second) {
        js_callbacks_.erase(func_name);
        runtime_->RemoveHostFunction(func_name);
      }
      ud_method_fns_.erase(it);
    }
  });

  // Drop the paired JS reference when an anonymous nested callback's Lua closure
  // is collected, so callback-heavy patterns don't leak js_callbacks_ (M2).
  runtime_->SetHostFunctionGCCallback([this](const std::string& name) {
    js_callbacks_.erase(name);
  });

  // Set up property handlers for proxy userdata.
  runtime_->SetPropertyHandlers(
    // Getter (__index)
    [this](int ref_id, const std::string& key) -> lua_core::LuaPtr {
      return ReadUserdataProperty(ref_id, key);
    },
    // Setter (__newindex)
    [this](int ref_id, const std::string& key, const lua_core::LuaPtr& value) {
      WriteUserdataProperty(ref_id, key, value);
    }
  );
}

void LuaContext::DetachRuntimeHandlers() const {
  if (!runtime_) return;
  runtime_->SetUserdataGCCallback(nullptr);
  runtime_->SetHostFunctionGCCallback(nullptr);
  runtime_->SetPropertyHandlers(nullptr, nullptr);
  runtime_->SetOutputHandler(nullptr);
  // DropInputHandler, not SetInputHandler(nullptr), for the reason spelled out
  // for the file reader below: the latter removes a synthesized `io` through
  // RunProtected and can therefore throw. Same UNGUARDED_AND_PROPAGATES shape.
  runtime_->DropInputHandler();
  // DropFileReader, not SetFileReader(nullptr): the latter removes the
  // dofile/loadfile globals through RunProtected, which can throw, and this
  // function is on the reset/teardown path where an escaping exception reaches
  // N-API (CR-6 F1). The state is about to be replaced, so there is nothing to
  // remove the globals from. Flagged here by the core-call-guarding invariant as
  // UNGUARDED_AND_PROPAGATES.
  runtime_->DropFileReader();
  // lua_close fires __gc metamethods, which run Lua code — a line hook would
  // otherwise call into a context that is being torn down or repopulated.
  runtime_->RemoveDebugHook();
}

void LuaContext::RegisterCallbacks(const Napi::Object& callbacks) {
  Napi::Array keys = callbacks.GetPropertyNames();

  for (uint32_t i = 0; i < keys.Length(); i++) {
    const Napi::Value key = keys[i];
    const Napi::Value val = callbacks.Get(key);
    const std::string key_str = key.ToString();

    try {
      if (val.IsFunction()) {
        // Runtime registration first: if the protected _G write throws, no
        // js_callbacks_/host_functions_ entry is left behind (N5).
        runtime_->RegisterFunction(key_str, CreateJsCallbackWrapper(key_str));
        js_callbacks_[key_str] = Napi::Persistent(val.As<Napi::Function>());
      } else {
        runtime_->SetGlobal(key_str, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(val)));
      }
    } catch (const std::exception& e) {
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return;
    }
  }
}

namespace {

// Splits a dotted global path ("config.db.host") into its segments. Returns
// false for a malformed path — any empty segment from a leading, trailing, or
// doubled dot (".a", "a.", "a..b") — so the caller can reject it with a clear
// error. A name with no dot yields a single-element vector (but the callers
// only reach this on a name that contains a dot).
bool SplitGlobalPath(const std::string& name, std::vector<std::string>& out) {
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

}  // namespace

Napi::Value LuaContext::SetGlobal(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 2 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string name as first argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  // A metatabled _G runs its __newindex here, which can reach a throwing host
  // callback that stages a js_error_registry_ entry. Scope the whole method so
  // that entry is cleared at the next outermost call instead of accumulating —
  // the CR-8 F5 discipline, applied to the global-access surface it did not
  // sweep (CR-9 F1).
  const CallScope call_scope(this);

  // A dotted name addresses a nested field: config.db.host = value, creating
  // missing intermediate tables. Functions take the reclaimable nested-closure
  // path (via NapiToCoreInstance) rather than the named-persistent top-level
  // registration below — a nested field is conceptually an anonymous value.
  if (name.find('.') != std::string::npos) {
    std::vector<std::string> path;
    if (!SplitGlobalPath(name, path)) {
      Napi::TypeError::New(env_, "Invalid global path '" + name +
        "': path segments must be non-empty (no leading, trailing, or doubled dots)")
        .ThrowAsJavaScriptException();
      return env_.Undefined();
    }
    try {
      runtime_->SetGlobalPath(
        path, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[1])));
    } catch (const std::exception& e) {
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    }
    return env_.Undefined();
  }

  // Both branches can throw a std::runtime_error (a raising __index/__newindex
  // on a _G metatable now routes through the protected global path), so guard
  // the whole body rather than letting the exception unwind past N-API.
  try {
    if (const Napi::Value value = info[1]; value.IsFunction()) {
      // Runtime registration first: if the protected _G write throws, no
      // js_callbacks_/host_functions_ entry is left behind (N5).
      runtime_->RegisterFunction(name, CreateJsCallbackWrapper(name));
      js_callbacks_[name] = Napi::Persistent(value.As<Napi::Function>());
    } else {
      runtime_->SetGlobal(name, std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(value)));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  return env_.Undefined();
}

Napi::Value LuaContext::GetGlobal(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string name as first argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  // See SetGlobal: a metatabled _G runs its __index here, so scope the method
  // to keep staged js_error_registry_ entries from accumulating (CR-9 F1).
  const CallScope call_scope(this);

  // A dotted name reads a nested field: config.db.host. A nil anywhere along
  // the path yields null (optional chaining), matching how a missing single
  // global reads back as null.
  if (name.find('.') != std::string::npos) {
    std::vector<std::string> path;
    if (!SplitGlobalPath(name, path)) {
      Napi::TypeError::New(env_, "Invalid global path '" + name +
        "': path segments must be non-empty (no leading, trailing, or doubled dots)")
        .ThrowAsJavaScriptException();
      return env_.Undefined();
    }
    try {
      const auto result = runtime_->GetGlobalPath(path);
      return CoreToNapi(*result);
    } catch (const std::exception& e) {
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return env_.Undefined();
    }
  }

  // GetGlobal can throw (an over-deep table, or a raising __index on a _G
  // metatable via the protected-get path). Surface it as a JS exception rather
  // than letting a std::runtime_error unwind through the N-API boundary.
  try {
    const auto result = runtime_->GetGlobal(name);
    return CoreToNapi(*result);
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
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
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "call(name, ...args) requires a string name")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  // Opened *above* the lookup, not after it: resolving `name` goes through the
  // protected global path, so a metatabled _G runs its __index — Lua, and from
  // there a host callback — before the call itself begins (CR-9 F1).
  const CallScope scope(this);

  lua_core::LuaPtr target;
  try {
    if (name.find('.') != std::string::npos) {
      std::vector<std::string> path;
      if (!SplitGlobalPath(name, path)) {
        Napi::TypeError::New(env_, "Invalid global path '" + name +
          "': path segments must be non-empty (no leading, trailing, or doubled dots)")
          .ThrowAsJavaScriptException();
        return env_.Undefined();
      }
      target = runtime_->GetGlobalPath(path);
    } else {
      target = runtime_->GetGlobal(name);
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  // Only a genuine Lua function is accepted. A callable table (one with __call)
  // arrives as a LuaTableRef, not a function ref, and calling it would need a
  // different core entry point — get_global() still returns a Proxy for it.
  if (!target || !std::holds_alternative<lua_core::LuaFunctionRef>(target->value)) {
    Napi::TypeError::New(env_,
      "Lua global '" + name + "' is not a function").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  // One collector spans every argument so a later argument's conversion failure
  // sweeps the reclaimable callbacks minted by the earlier ones (CR-8 F1).
  const JsCallbackCollectorScope collector(this);
  std::vector<lua_core::LuaPtr> args;
  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  try {
    for (size_t i = 1; i < info.Length(); ++i) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[i])));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const auto result =
    runtime_->CallFunction(std::get<lua_core::LuaFunctionRef>(target->value), args);
  if (std::holds_alternative<std::string>(result)) {
    ThrowLuaError(std::get<std::string>(result));
    return env_.Undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(result));
}

namespace {

// set_userdata's options object. The caller holds the CallScope: every read
// here can be a getter that re-enters the context (CR-13 F1).
void ReadUserdataOptions(const Napi::Object& options, bool& readable, bool& writable,
                         std::vector<std::pair<std::string, Napi::Function>>& method_funcs) {
  if (options.Has("readable") && options.Get("readable").IsBoolean()) {
    readable = options.Get("readable").As<Napi::Boolean>().Value();
  }
  if (options.Has("writable") && options.Get("writable").IsBoolean()) {
    writable = options.Get("writable").As<Napi::Boolean>().Value();
  }
  if (!options.Has("methods") || !options.Get("methods").IsObject()) return;
  const auto methods_obj = options.Get("methods").As<Napi::Object>();
  const Napi::Array method_keys = methods_obj.GetPropertyNames();
  for (uint32_t i = 0; i < method_keys.Length(); i++) {
    std::string method_name = method_keys.Get(i).As<Napi::String>().Utf8Value();
    const Napi::Value method_val = methods_obj.Get(method_name);
    if (method_val.IsFunction()) {
      method_funcs.emplace_back(method_name, method_val.As<Napi::Function>());
    }
  }
}

}  // namespace

// Registers a userdata's methods as host functions and hands the core their
// name table. Called inside SetUserdata's try: both core calls throw on OOM.
// Every name is appended to `registered_method_fns` as it is minted, so the
// caller's rollback sees exactly what exists.
void LuaContext::RegisterUserdataMethods(
    const int ref_id,
    const std::vector<std::pair<std::string, Napi::Function>>& method_funcs,
    std::vector<std::string>& registered_method_fns) {
  std::unordered_map<std::string, std::string> method_map;

  for (const auto& [method_name, method_func] : method_funcs) {
    const std::string func_name = "__ud_method_" + std::to_string(ref_id)
                          + "_" + method_name;

    // Record the name before registering the pair, so the rollback
    // always sees it — a throw between the two registrations would
    // otherwise strand the js_callbacks_ entry (CR-8 F7). The rollback's
    // erase/RemoveHostFunction are no-ops for a name not yet registered.
    registered_method_fns.push_back(func_name);
    js_callbacks_[func_name] = Napi::Persistent(method_func);
    runtime_->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
    method_map[method_name] = func_name;
  }

  runtime_->SetUserdataMethodTable(ref_id, method_map);
  // Recorded only once the whole build succeeded, so the failure path
  // — which erases the same names itself — is the only cleanup on that
  // route. From here the userdata's own __gc owns their lifetime (CR-11 F4).
  ud_method_fns_[ref_id] = registered_method_fns;
}

// Undoes a set_userdata that failed part-way, so a rejected call strands
// nothing in js_userdata_ / js_callbacks_ / host_functions_.
void LuaContext::RollBackUserdata(const std::string& name, const int ref_id,
                                  const std::vector<std::string>& registered_method_fns,
                                  const bool global_installed) {
  js_userdata_.erase(ref_id);
  for (const auto& func_name : registered_method_fns) {
    js_callbacks_.erase(func_name);
    runtime_->RemoveHostFunction(func_name);
  }
  // If the global write succeeded before a later step failed, remove the
  // installed global too — otherwise the name stays bound to an inert proxy
  // whose js_userdata_ entry was just erased (CR-7 F3). Raw (no __newindex
  // can re-raise) and best-effort: the removal can itself fail under the same
  // OOM, and the inert global is the accepted floor then. Only when this call
  // installed it — a pre-existing same-named global must not be deleted.
  if (!global_installed) return;
  try {
    runtime_->RemoveGlobalRaw(name);
  } catch (...) {
    // Best-effort; see above.
  }
}

Napi::Value LuaContext::SetUserdata(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  // At entry, above the options / methods property reads below — any of which
  // can be a getter that re-enters this context (CR-13 F1).
  const CallScope call_scope(this);
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env_, "Expected (string, object[, options])").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();

  bool readable = false;
  bool writable = false;
  bool has_methods = false;

  // Temporarily hold method functions until we can register them
  std::vector<std::pair<std::string, Napi::Function>> method_funcs;

  if (info.Length() >= 3 && info[2].IsObject()) {
    ReadUserdataOptions(info[2].As<Napi::Object>(), readable, writable, method_funcs);
    has_methods = !method_funcs.empty();
  }

  int ref_id = 0;
  try {
    ref_id = NextUserdataId();
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
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
      runtime_->CreateProxyUserdataGlobal(name, ref_id);
    } else {
      runtime_->CreateUserdataGlobal(name, ref_id);
    }
    global_installed = true;

    // Register methods if present
    if (has_methods) RegisterUserdataMethods(ref_id, method_funcs, registered_method_fns);
  } catch (const std::exception& e) {
    RollBackUserdata(name, ref_id, registered_method_fns, global_installed);
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  return env_.Undefined();
}

namespace {

// register_class's reads of its definition object, one function per property.
// **Each property is read exactly once, into a snapshot**, so a hostile getter
// or Proxy cannot show validation one value and hand registration another (N3)
// — and the reads happen in the order RegisterClass calls these, which an
// observing definition object can see. The caller holds the CallScope and the
// name reservation; each bool-returning reader returns false with a JS
// exception pending.

using ClassFunctionList = std::vector<std::pair<std::string, Napi::Function>>;

// Inheritance (C4). The base must already be registered on THIS context: the
// core chains method lookups through its registry entries, and a name this
// context never registered would either be missing or — worse — belong to
// whatever else happens to sit at that registry key.
bool ReadClassExtends(const Napi::Env env, const Napi::Object& def,
                      const std::string& class_name,
                      const std::unordered_set<std::string>& registered,
                      std::string& parent_class) {
  if (const Napi::Value extends_val = def.Get("extends"); !extends_val.IsUndefined() &&
      !extends_val.IsNull()) {
    if (!extends_val.IsString()) {
      Napi::TypeError::New(env,
        "register_class(): 'extends' must be the name of a registered class")
        .ThrowAsJavaScriptException();
      return false;
    }
    parent_class = extends_val.As<Napi::String>().Utf8Value();
    if (parent_class == class_name || !registered.count(parent_class)) {
      Napi::Error::New(env,
        "register_class(): base class '" + parent_class + "' is not registered")
        .ThrowAsJavaScriptException();
      return false;
    }
  }
  return true;
}

// Validate reserved metamethods up front, before anything is registered, so a
// rejected definition doesn't strand the constructor/method callbacks in
// js_callbacks_/host_functions_ (L4). The property, its key list, and each
// value are read exactly once into this snapshot (N3); registration below
// uses the same snapshot.
bool ReadClassMetamethods(const Napi::Env env, const Napi::Object& def,
                          ClassFunctionList& mm_snapshot) {
  const Napi::Value mms_val = def.Get("metamethods");
  if (mms_val.IsObject()) {
    const auto mms = mms_val.As<Napi::Object>();
    const Napi::Array mm_keys = mms.GetPropertyNames();
    for (uint32_t i = 0; i < mm_keys.Length(); ++i) {
      std::string key = mm_keys.Get(i).As<Napi::String>().Utf8Value();
      if (key == "__gc" || key == "__index" || key == "__newindex" ||
          key == "__name" || key == lua_core::LuaRuntime::kClassMarkerField) {
        Napi::TypeError::New(env,
          "register_class(): metamethod '" + key + "' is reserved and cannot be overridden")
          .ThrowAsJavaScriptException();
        return false;
      }
      const Napi::Value val = mms.Get(key);
      if (val.IsFunction()) {
        mm_snapshot.emplace_back(std::move(key), val.As<Napi::Function>());
      }
    }
  }
  return true;
}

// Statics (P2a) — validated up front, alongside the metamethods and for the
// same reason (L4): a rejected definition must not have stranded anything.
// Read once into a snapshot (N3); registration below never consults `def`
// again. Functions and plain values are separated here because they take
// different routes into the class table.
bool ReadClassStatics(const Napi::Env env, const Napi::Object& def,
                      ClassFunctionList& static_fn_snapshot,
                      std::vector<std::pair<std::string, Napi::Value>>& static_val_snapshot) {
  const Napi::Value statics_val = def.Get("statics");
  if (statics_val.IsObject() && !statics_val.IsFunction()) {
    const auto statics = statics_val.As<Napi::Object>();
    const Napi::Array keys = statics.GetPropertyNames();
    for (uint32_t i = 0; i < keys.Length(); ++i) {
      std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
      if (key == "new") {
        Napi::TypeError::New(env,
          "register_class(): static 'new' is reserved — it is the constructor")
          .ThrowAsJavaScriptException();
        return false;
      }
      Napi::Value val = statics.Get(key);
      if (val.IsFunction()) {
        static_fn_snapshot.emplace_back(std::move(key), val.As<Napi::Function>());
      } else {
        static_val_snapshot.emplace_back(std::move(key), val);
      }
    }
  }
  return true;
}

// Named property accessors (P2b). Same snapshot discipline. Held in
// class_accessors_ rather than pushed into Lua — see the member's comment.
bool ReadClassProperties(const Napi::Env env, const Napi::Object& def,
                         ClassAccessorTable& accessors) {
  const Napi::Value props_val = def.Get("properties");
  if (props_val.IsObject() && !props_val.IsFunction()) {
    const auto props = props_val.As<Napi::Object>();
    const Napi::Array keys = props.GetPropertyNames();
    for (uint32_t i = 0; i < keys.Length(); ++i) {
      std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
      const Napi::Value entry_val = props.Get(key);
      if (!entry_val.IsObject() || entry_val.IsFunction()) {
        Napi::TypeError::New(env,
          "register_class(): property '" + key + "' must be an object with "
          "'get' and/or 'set' functions")
          .ThrowAsJavaScriptException();
        return false;
      }
      const auto entry = entry_val.As<Napi::Object>();
      const Napi::Value get_val = entry.Get("get");
      const Napi::Value set_val = entry.Get("set");
      const bool has_get = get_val.IsFunction();
      const bool has_set = set_val.IsFunction();
      if (!has_get && !has_set) {
        // A property with neither half is inert, and inert-by-typo is exactly
        // what a definition-time check is for.
        Napi::TypeError::New(env,
          "register_class(): property '" + key + "' declares neither 'get' nor 'set'")
          .ThrowAsJavaScriptException();
        return false;
      }
      ClassAccessor acc;
      if (has_get) acc.getter = Napi::Persistent(get_val.As<Napi::Function>());
      if (has_set) acc.setter = Napi::Persistent(set_val.As<Napi::Function>());
      accessors.props.emplace(std::move(key), std::move(acc));
    }
  }
  return true;
}

// Instance methods (obj:method()). Read last, after the validating reads, as
// it always was.
void ReadClassMethods(const Napi::Object& def, const uint64_t class_id,
                      std::unordered_map<std::string, std::string>& method_map,
                      ClassFunctionList& deferred_fns) {
  const Napi::Value methods_val = def.Get("methods");
  if (!methods_val.IsObject()) return;
  const auto methods = methods_val.As<Napi::Object>();
  const Napi::Array keys = methods.GetPropertyNames();
  for (uint32_t i = 0; i < keys.Length(); ++i) {
    const std::string name = keys.Get(i).As<Napi::String>().Utf8Value();
    const Napi::Value val = methods.Get(name);
    if (val.IsFunction()) {
      std::string func_name = "__class_method_" + std::to_string(class_id) + "_" + name;
      deferred_fns.emplace_back(func_name, val.As<Napi::Function>());
      method_map[name] = func_name;
    }
  }
}

}  // namespace

// Statics (P2a), from the snapshot. Functions become host-function closures
// on the class table; other values are converted once, here, and placed
// directly — a static is a class-level constant, not a live view of the JS
// property, and converting at registration is what makes that true.
//
// Returns false with a JS exception pending. Nothing is registered yet at that
// point and the caller's reservation guard releases the name.
bool LuaContext::BuildClassStatics(
    const uint64_t class_id,
    const std::vector<std::pair<std::string, Napi::Function>>& static_fn_snapshot,
    const std::vector<std::pair<std::string, Napi::Value>>& static_val_snapshot,
    std::vector<std::pair<std::string, Napi::Function>>& deferred_fns,
    std::vector<lua_core::MetatableEntry>& statics) {
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
      return false;
    } catch (const std::exception& e) {
      Napi::Error::New(env_,
        "register_class(): static '" + key + "': " + e.what())
        .ThrowAsJavaScriptException();
      return false;
    }
    statics.push_back(std::move(entry));
  }
  return true;
}

Napi::Value LuaContext::RegisterClass(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  // At entry, above every `def.Get(...)` below: each of those can run a hostile
  // getter or Proxy trap — the N3 threat model this method already defends
  // against — and one that called reset() used to succeed, wiping
  // `registered_classes_` and with it the reservation two lines below. The L7
  // duplicate guard then reported success for a second registration of the same
  // name, and luaL_newmetatable half-merged the two definitions (CR-13 F1).
  const CallScope call_scope(this);
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env_,
      "register_class(name, definition) requires a string name and an object")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string class_name = info[0].As<Napi::String>().Utf8Value();
  const auto def = info[1].As<Napi::Object>();

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
    Napi::Error::New(env_,
      "class '" + class_name + "' is already registered on this context")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
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
    ReservationGuard(std::unordered_set<std::string>* s, const std::string* n)
        : set(s), name(n) {}
    ~ReservationGuard() { if (set) set->erase(*name); }
    ReservationGuard(const ReservationGuard&) = delete;
    ReservationGuard& operator=(const ReservationGuard&) = delete;
    void Commit() { set = nullptr; }
  } reservation{&registered_classes_, &class_name};

  // Each property is read exactly once, into a local. A hostile getter/Proxy
  // therefore cannot show validation one value and hand registration another
  // (N3, extended to `construct` by F5) — everything below uses the snapshot.
  const Napi::Value construct_val = def.Get("construct");
  if (!construct_val.IsFunction()) {
    Napi::TypeError::New(env_,
      "register_class() definition requires a 'construct' function")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  const auto construct_fn = construct_val.As<Napi::Function>();

  std::string parent_class;
  if (!ReadClassExtends(env_, def, class_name, registered_classes_, parent_class)) {
    return env_.Undefined();
  }

  // Reserved metamethods are rejected up front, before anything is registered,
  // so a refused definition strands nothing (L4).
  std::vector<std::pair<std::string, Napi::Function>> mm_snapshot;
  if (!ReadClassMetamethods(env_, def, mm_snapshot)) return env_.Undefined();

  std::vector<std::pair<std::string, Napi::Function>> static_fn_snapshot;
  std::vector<std::pair<std::string, Napi::Value>> static_val_snapshot;
  if (!ReadClassStatics(env_, def, static_fn_snapshot, static_val_snapshot)) {
    return env_.Undefined();
  }

  ClassAccessorTable accessors;
  accessors.parent = parent_class;
  if (!ReadClassProperties(env_, def, accessors)) return env_.Undefined();

  const Napi::Value readable_val = def.Get("readable");
  const Napi::Value writable_val = def.Get("writable");
  const bool readable = readable_val.IsBoolean() && readable_val.As<Napi::Boolean>().Value();
  const bool writable = writable_val.IsBoolean() && writable_val.As<Napi::Boolean>().Value();

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

  std::unordered_map<std::string, std::string> method_map;
  std::vector<std::pair<std::string, Napi::Function>> deferred_fns;
  ReadClassMethods(def, class_id, method_map, deferred_fns);

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

  std::vector<lua_core::MetatableEntry> statics;
  if (!BuildClassStatics(class_id, static_fn_snapshot, static_val_snapshot,
                         deferred_fns, statics)) {
    return env_.Undefined();
  }

  // RegisterClass builds inside RunProtected, which throws on OOM under
  // maxMemory or a raising __newindex on a _G metatable at the class-global
  // write. Surface that as a JS error: letting a std::runtime_error unwind
  // across the N-API boundary terminates the process (the H1 class).
  try {
    // The class-global write fires __newindex on a metatabled _G (CR-9 F1);
    // the method-entry scope above already covers it.
    runtime_->RegisterClass(class_name, ctor_name, method_map, metamethods,
                           parent_class, statics);
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    // The reservation guard releases the name; nothing was registered, so
    // nothing is stranded (CR-8 F3).
    return env_.Undefined();
  }

  // Deliberately NOT reserved as reclaimable the way set_metatable's and
  // register_module's entries are (CR-11 F4): a class registration cannot be
  // superseded — `registered_classes_` rejects a second use of the name — so
  // its constructor and methods are permanent by design, not stranded.
  js_callbacks_[ctor_name] = Napi::Persistent(construct_fn);
  runtime_->StoreHostFunction(ctor_name,
    CreateConstructorWrapper(ctor_name, class_name, readable, writable));
  for (auto& [func_name, fn] : deferred_fns) {
    js_callbacks_[func_name] = Napi::Persistent(fn);
    runtime_->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }
  // Accessors go in with the rest, after the core build succeeded — an entry
  // here for a class the core rejected would answer property reads for a class
  // that does not exist.
  if (!accessors.props.empty() || !accessors.parent.empty()) {
    class_accessors_.emplace(class_name, std::move(accessors));
  }

  reservation.Commit();
  return env_.Undefined();
}

namespace {

// Defined further down, next to the table-reference API it belongs to.
LuaTableRefData* TableRefDataFrom(const Napi::Value& value);

}  // namespace

// set_metatable(target, metatable)
//
// `target` is either a global name (the original form) or a live table
// reference — a `create_table()` / `get_global_ref()` / `create_environment()`
// handle, or the Proxy a metatabled table round-trips as (F1). The metatable is
// built identically either way; only the final attach differs, so both forms get
// the same deferred host-function registration and the same rollback on failure.
Napi::Value LuaContext::SetMetatable(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  // At entry, above the mt.GetPropertyNames()/mt.Get() reads below: a getter on
  // the definition object that called reset() used to succeed, which made the
  // target's identity check further down stale. The core call at the end then
  // paired the *new* runtime with the *old* state's registry ref and attached
  // the metatable to whatever unrelated object had inherited that slot
  // (CR-13 F1).
  const CallScope call_scope(this);

  // Resolve the target before touching the metatable definition, so a bad target
  // is rejected without minting any callback names.
  const bool by_name = info.Length() >= 1 && info[0].IsString();
  const LuaTableRefData* target_ref =
      info.Length() >= 1 && !by_name ? TableRefDataFrom(info[0]) : nullptr;
  std::string name;
  if (by_name) {
    name = info[0].As<Napi::String>().Utf8Value();
  } else if (target_ref) {
    if (target_ref->runtime.get() != runtime_.get()) {
      Napi::Error::New(env_, "table handle belongs to a different Lua context")
        .ThrowAsJavaScriptException();
      return env_.Undefined();
    }
    if (target_ref->table_ref.ref == LUA_NOREF) {
      Napi::Error::New(env_, "table handle has been released")
        .ThrowAsJavaScriptException();
      return env_.Undefined();
    }
  } else {
    Napi::TypeError::New(env_,
      "set_metatable(target, metatable) requires a global name or a table handle")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  if (info.Length() < 2 || !info[1].IsObject() || info[1].IsFunction()) {
    Napi::TypeError::New(env_, "set_metatable(): metatable must be an object")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const auto mt = info[1].As<Napi::Object>();
  const Napi::Array keys = mt.GetPropertyNames();

  const uint64_t mt_id = next_metatable_id_++;
  std::vector<lua_core::MetatableEntry> entries;

  // One collector spans the whole entry build and the core call: the global form
  // validates its target only after every entry has been converted, so a
  // missing/non-table global discards them all. The destructor sweeps any
  // reclaimable callback that never reached Lua (CR-8 F1).
  const JsCallbackCollectorScope collector(this);

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
        Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
        return env_.Undefined();
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
    if (target_ref) {
      runtime_->SetTableRefMetatable(target_ref->table_ref.ref, entries);
    } else {
      runtime_->SetGlobalMetatable(name, entries);
    }
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();  // nothing registered, nothing stranded (CR-8 F3)
  }

  for (auto& [func_name, fn] : deferred_fns) {
    js_callbacks_[func_name] = Napi::Persistent(fn);
    runtime_->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }

  return env_.Undefined();
}

Napi::Value LuaContext::AddSearchPath(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string path = info[0].As<Napi::String>().Utf8Value();

  if (path.find('?') == std::string::npos) {
    Napi::Error::New(env_,
      "Search path must contain a '?' placeholder (e.g., './modules/?.lua')").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  try {
    // Reads and writes package.path, so a metatabled package runs its
    // __index/__newindex here (CR-9 F1).
    const CallScope call_scope(this);
    runtime_->AddSearchPath(path);
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  // Recorded only after the core call succeeds, so a rejected path is never
  // replayed by reset().
  search_paths_.push_back(path);

  return env_.Undefined();
}

Napi::Value LuaContext::RegisterModule(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  // At entry, above the module object's GetPropertyNames()/Get() reads below
  // (CR-13 F1).
  const CallScope call_scope(this);
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
    Napi::TypeError::New(env_, "Expected (string, object)").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();
  const auto module_obj = info[1].As<Napi::Object>();
  const Napi::Array keys = module_obj.GetPropertyNames();

  const uint64_t mod_id = next_module_id_++;
  std::vector<lua_core::MetatableEntry> entries;

  // See SetMetatable: one collector spans the entry build and the core call so
  // entries discarded by a later failure sweep their reclaimable callbacks (F1).
  const JsCallbackCollectorScope collector(this);

  // See SetMetatable: function entries are registered only after the core call
  // succeeds — RegisterModuleTable throws when the 'package' library isn't
  // loaded, and eager registration would strand the pairs (CR-8 F3).
  std::vector<std::pair<std::string, Napi::Function>> deferred_fns;

  for (uint32_t i = 0; i < keys.Length(); i++) {
    const std::string key = keys[i].As<Napi::String>().Utf8Value();
    const Napi::Value val = module_obj.Get(key);

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
        Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
        return env_.Undefined();
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
    runtime_->RegisterModuleTable(name, entries);
  } catch (const std::runtime_error& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();  // nothing registered, nothing stranded (CR-8 F3)
  }

  for (auto& [func_name, fn] : deferred_fns) {
    js_callbacks_[func_name] = Napi::Persistent(fn);
    runtime_->StoreHostFunction(func_name, CreateJsCallbackWrapper(func_name));
  }

  return env_.Undefined();
}

namespace {

// Reads `{ chunkName }` from an optional options object at `index`, shared by
// every door that loads Lua source (T3, August 7, 2026). Returns false with a
// TypeError pending when the argument is unusable; an absent options object,
// `undefined` or `null` all mean "no chunk name" and leave `out` alone.
//
// **It refuses a non-string rather than ignoring one**, which is a deliberate
// break from how `compile()` read this key until today. A silently ignored
// option is the failure mode CR-23 F4 is about — `strictConversion: 'yes'`
// quietly meaning off — and it is worse here than elsewhere, because the whole
// point of the option is to make an error message legible: a caller who
// mistypes it would get the default name back and no hint why.
bool ParseChunkName(const Napi::CallbackInfo& info, const size_t index,
                           const char* door, std::string& out) {
  const Napi::Env env = info.Env();
  if (info.Length() <= index) return true;
  const Napi::Value opts = info[index];
  if (opts.IsUndefined() || opts.IsNull()) return true;
  if (!opts.IsObject() || opts.IsFunction()) {
    Napi::TypeError::New(env, std::string(door) + " options must be an object")
      .ThrowAsJavaScriptException();
    return false;
  }
  // A property read can be an accessor, i.e. user JS — every caller of this
  // helper is already inside a CallScope for that reason (CR-13 F1).
  const Napi::Value name = opts.As<Napi::Object>().Get("chunkName");
  if (name.IsUndefined() || name.IsNull()) return true;
  if (!name.IsString()) {
    Napi::TypeError::New(env, std::string(door) + " chunkName must be a string")
      .ThrowAsJavaScriptException();
    return false;
  }
  out = name.As<Napi::String>().Utf8Value();
  return true;
}

}  // namespace

Napi::Value LuaContext::Compile(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string script = info[0].As<Napi::String>().Utf8Value();

  // Above the options reads below, which can be accessors (CR-13 F1), as well
  // as the parse further down.
  const CallScope call_scope(this);

  bool strip_debug = false;
  std::string chunk_name;
  if (!ParseChunkName(info, 1, "compile()", chunk_name)) return env_.Undefined();
  if (info.Length() >= 2 && info[1].IsObject()) {
    const auto options = info[1].As<Napi::Object>();
    if (options.Has("stripDebug") && options.Get("stripDebug").IsBoolean()) {
      strip_debug = options.Get("stripDebug").As<Napi::Boolean>().Value();
    }
  }

  // Compiling parses, parsing allocates, and an allocation can drive a GC step
  // whose __gc finalizers re-enter JS — so this runs Lua just as much as
  // execute_script does, and needs the same outermost scope (CR-10 F1); the
  // method-entry scope above covers it.
  const auto result = runtime_->CompileScript(script, strip_debug, chunk_name);

  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env_, std::get<std::string>(result)).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const auto& bytecode = std::get<std::vector<uint8_t>>(result);
  return {env_, Napi::Buffer<uint8_t>::Copy(env_, bytecode.data(), bytecode.size())};
}

Napi::Value LuaContext::CompileFile(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string filepath = info[0].As<Napi::String>().Utf8Value();

  // See Compile: above the options reads, which can be accessors (CR-13 F1).
  const CallScope call_scope(this);

  bool strip_debug = false;
  if (info.Length() >= 2 && info[1].IsObject()) {
    const auto options = info[1].As<Napi::Object>();
    if (options.Has("stripDebug") && options.Get("stripDebug").IsBoolean()) {
      strip_debug = options.Get("stripDebug").As<Napi::Boolean>().Value();
    }
  }

  // The parse allocates and can reach a __gc finalizer (CR-10 F1); the
  // method-entry scope above covers it.
  const auto result = runtime_->CompileFile(filepath, strip_debug);

  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env_, std::get<std::string>(result)).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const auto& bytecode = std::get<std::vector<uint8_t>>(result);
  return {env_, Napi::Buffer<uint8_t>::Copy(env_, bytecode.data(), bytecode.size())};
}

Napi::Value LuaContext::LoadBytecode(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env_, "Expected Buffer argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
  const std::vector<uint8_t> bytecode(buffer.Data(), buffer.Data() + buffer.Length());

  std::string chunk_name = "bytecode";
  if (info.Length() >= 2 && info[1].IsString()) {
    chunk_name = info[1].As<Napi::String>().Utf8Value();
  }

  const CallScope call_scope(this);
  const auto res = runtime_->LoadBytecode(bytecode, chunk_name);

  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return env_.Undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

Napi::Object LuaContext::CreateTableHandle(const Napi::Env handle_env, const int registry_ref) {
  // Take ownership of the caller's freshly-minted registry ref immediately:
  // LuaTableRef claims a share of the slot in its constructor, and the
  // unique_ptr releases it again if any N-API allocation below throws before
  // the External's finalizer becomes the owner. Without this, a throw between
  // the core call that minted the ref (get_global_ref, create_table,
  // create_environment, get_ref) and the External left the slot owned by
  // nobody (CR-9 F4).
  //
  // The data is shared rather than uniquely owned because a `for...of` cursor
  // takes a share of it (see LuaTableIterState). The unique_ptr guards the
  // External's share — the TableRefOwner — exactly as it used to guard the data.
  auto owner = std::make_unique<TableRefOwner>(std::make_shared<LuaTableRefData>(
    runtime_, lua_core::LuaTableRef(registry_ref, runtime_->RawState()), this,
    Liveness()));
  LuaTableRefData* const data_ptr = owner->get();

  const Napi::Object handle = Napi::Object::New(handle_env);

  // The External's finalizer is the sole owner of data_ptr. Root it on _tableRef
  // AND on every method function below, so a method destructured off the handle
  // (`const { get } = handle; get(...)`) keeps the data alive instead of reading
  // freed memory once the handle object is collected. Non-configurable so it
  // can't be deleted to free the data out from under the still-bound methods —
  // the same ownership discipline used for __luaFnOwner (H3 / L6).
  const auto external = NewTaggedExternal(handle_env, data_ptr, lua_tags::kTableRefData,
    [](Napi::Env, const LuaTableRefData*, const TableRefOwner* o) { delete o; },
    owner.get());
  // Ownership has transferred: from here a throw leaves the External unrooted,
  // and its finalizer drops the owner — and with it data_ptr and the ref, once
  // no cursor holds a share — when it is collected.
  TableRefOwner* const owner_ptr = owner.release();
  DefineHiddenProp(handle_env, handle, "_tableRef", external, /*writable=*/false);

  const auto add_method = [&](const char* name,
                       Napi::Value (*cb)(const Napi::CallbackInfo&)) {
    const Napi::Function fn = Napi::Function::New(handle_env, cb, name, data_ptr);
    DefineHiddenProp(handle_env, fn, "_tableOwner", external, /*writable=*/false);
    (void)handle.Set(name, fn);
  };
  add_method("get", TableHandleGet);
  add_method("get_ref", TableHandleGetRef);
  add_method("set", TableHandleSet);
  add_method("has", TableHandleHas);
  add_method("length", TableHandleLength);
  add_method("pairs", TableHandlePairs);
  add_method("ipairs", TableHandleIPairs);
  add_method("keys", TableHandleKeys);
  add_method("release", TableHandleRelease);
  // `for (const [k, v] of handle)`. Rooted like the named methods above: a
  // destructured `[Symbol.iterator]` keeps the handle data alive (H3 / L6).
  // It is given the owner rather than data_ptr so the cursor it mints can take
  // a share: rooting covers this function, not what it returns.
  {
    const Napi::Function fn = Napi::Function::New(handle_env, TableHandleSymbolIterator,
                                                 "[Symbol.iterator]", owner_ptr);
    DefineHiddenProp(handle_env, fn, "_tableOwner", external, /*writable=*/false);
    (void)handle.Set(SymbolIteratorKey(handle_env), fn);
  }

  return handle;
}

Napi::Value LuaContext::CreateTableMethod(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();

  int ref = LUA_NOREF;
  // One collector spans the element loop and CreateTableFrom so a failure part
  // way through (or in the core call) sweeps the reclaimable callbacks minted
  // by the elements already converted (F1). The CallScope covers the user JS a
  // registered type converter can run during conversion (CR-9 F1).
  const CallScope call_scope(this);
  const JsCallbackCollectorScope collector(this);
  if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull()) {
    try {
      if (info[0].IsArray()) {
        const auto arr = info[0].As<Napi::Array>();
        lua_core::LuaArray lua_arr;
        lua_arr.reserve(arr.Length());
        for (uint32_t i = 0; i < arr.Length(); ++i) {
          lua_arr.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arr.Get(i))));
        }
        ref = runtime_->CreateTableFrom(lua_arr);
      } else if (info[0].IsObject()) {
        const auto obj = info[0].As<Napi::Object>();
        lua_core::LuaTable lua_tbl;
        const auto keys = obj.GetPropertyNames();
        for (uint32_t i = 0; i < keys.Length(); ++i) {
          const std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
          lua_tbl[key] = std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(obj.Get(key)));
        }
        ref = runtime_->CreateTableFrom(lua_tbl);
      } else {
        Napi::TypeError::New(env_, "create_table() argument must be an object or array").ThrowAsJavaScriptException();
        return env_.Undefined();
      }
    } catch (const std::exception& e) {
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return env_.Undefined();
    }
  } else {
    try {
      ref = runtime_->CreateTable();
    } catch (const std::exception& e) {
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return env_.Undefined();
    }
  }

  return CreateTableHandle(env_, ref);
}

Napi::Value LuaContext::GetGlobalRef(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "get_global_ref() requires a string name").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string name = info[0].As<Napi::String>().Utf8Value();
  // GetGlobalRef reads _G[name] through the protected-get path, which throws a
  // std::runtime_error if a __index metamethod on the globals table raises;
  // surface it as a JS exception rather than letting it unwind past N-API.
  // That __index is Lua and can reach a host callback, so the read is scoped
  // like any other metamethod-capable operation (CR-9 F1).
  std::variant<int, std::string> result;
  try {
    const CallScope call_scope(this);
    result = runtime_->GetGlobalRef(name);
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  if (const auto* error = std::get_if<std::string>(&result)) {
    Napi::Error::New(env_, *error).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const int ref = std::get<int>(result);
  return CreateTableHandle(env_, ref);
}

namespace {

// Extracts the LuaTableRefData behind a table handle or a metatabled-table
// Proxy. Both carry the same `_tableRef` External — the Proxy's has/get traps
// answer for it explicitly — so one accessor serves both surfaces. Returns
// nullptr for anything else, leaving the caller to raise its own error.
LuaTableRefData* TableRefDataFrom(const Napi::Value& value) {
  if (!value.IsObject()) return nullptr;
  // One Get, and the kind is checked as well as the shape: a genuine
  // `_coroutine` or `__luaFnOwner` External re-presented under this name is a
  // real External from this very context, so `IsExternal()` plus the caller's
  // runtime-identity check both agree (CR-15 F6).
  return TaggedData<LuaTableRefData>(value.As<Napi::Object>().Get("_tableRef"),
                                     lua_tags::kTableRefData);
}

}  // namespace

namespace {

// create_environment's `whitelist`. Returns false with a JS exception pending.
bool ReadEnvironmentWhitelist(const Napi::Env env, const Napi::Object& options,
                              std::vector<std::string>& whitelist) {
  if (!options.Has("whitelist")) return true;
  const Napi::Value list = options.Get("whitelist");
  if (list.IsUndefined() || list.IsNull()) return true;
  if (!list.IsArray()) {
    Napi::TypeError::New(env,
      "create_environment(): whitelist must be an array of strings")
      .ThrowAsJavaScriptException();
    return false;
  }
  const auto arr = list.As<Napi::Array>();
  whitelist.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    const Napi::Value entry = arr.Get(i);
    if (!entry.IsString()) {
      Napi::TypeError::New(env,
        "create_environment(): whitelist entries must be strings")
        .ThrowAsJavaScriptException();
      return false;
    }
    whitelist.push_back(entry.As<Napi::String>().Utf8Value());
  }
  return true;
}

// create_environment's options object. The caller holds the CallScope: these
// reads can be Proxy-trapped or accessor-backed. Returns false with a JS
// exception pending.
bool ReadEnvironmentOptions(const Napi::Env env, const Napi::Value& arg,
                            std::vector<std::string>& whitelist, bool& inherit) {
  if (!arg.IsObject() || arg.IsArray() || arg.IsFunction()) {
    Napi::TypeError::New(env, "create_environment() options must be an object")
      .ThrowAsJavaScriptException();
    return false;
  }
  const auto options = arg.As<Napi::Object>();
  if (!ReadEnvironmentWhitelist(env, options, whitelist)) return false;

  if (options.Has("inherit")) {
    const Napi::Value v = options.Get("inherit");
    if (!v.IsUndefined() && !v.IsNull()) inherit = v.ToBoolean().Value();
  }
  return true;
}

}  // namespace

// Builds an environment table: a fresh Lua table seeded with the whitelisted
// globals, handed back as an ordinary table handle so it can be inspected,
// extended (`env.set('helper', fn)`) and released like any other.
//
//   create_environment()                                  -> empty environment
//   create_environment({ whitelist: ['math', 'print'] })   -> only those names
//   create_environment({ whitelist: [...], inherit: true }) -> + _G fallback
Napi::Value LuaContext::CreateEnvironment(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  // At entry, above the options / whitelist-array reads below: both can be
  // Proxy-trapped or accessor-backed. CR-13 F1 could not drive a reset through
  // this one, which bounds the probe rather than the hazard — it is a member of
  // the class and is guarded like the rest of it.
  const CallScope call_scope(this);

  std::vector<std::string> whitelist;
  bool inherit = false;

  if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsNull() &&
      !ReadEnvironmentOptions(env_, info[0], whitelist, inherit)) {
    return env_.Undefined();
  }

  int ref = LUA_NOREF;
  try {
    // Reading a whitelisted name can fire an __index on _G that re-enters JS.
    // The method-entry scope above already covers it — a second, shadowing
    // scope lived here until CR-14 F5, which made "find the first CallScope"
    // ambiguous in the one method that had two.
    ref = runtime_->CreateEnvironment(whitelist, inherit);
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  return CreateTableHandle(env_, ref);
}

// Runs a script with `env` as its _ENV. `env` is any table reference minted by
// this context — an environment from create_environment, or any table handle /
// metatabled-table Proxy, since an environment is nothing more than the table a
// chunk resolves its globals against.
Napi::Value LuaContext::ExecuteScriptIn(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 2 || !info[1].IsString()) {
    Napi::TypeError::New(env_,
      "execute_script_in(env, script) requires an environment and a script string")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const auto* data = TableRefDataFrom(info[0]);
  if (!data) {
    Napi::TypeError::New(env_,
      "execute_script_in(): the first argument must be an environment or table reference")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  // Same policy as release() and the round-trip markers: a ref index minted by
  // another context (or by this one before a reset()) addresses an unrelated
  // slot in the current registry.
  if (data->runtime.get() != runtime_.get()) {
    Napi::Error::New(env_, "environment belongs to a different Lua context")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  if (data->table_ref.ref == LUA_NOREF) {
    Napi::Error::New(env_, "table handle has been released")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string script = info[1].As<Napi::String>().Utf8Value();

  const CallScope call_scope(this);
  std::string chunk_name;
  if (!ParseChunkName(info, 2, "execute_script_in()", chunk_name)) return env_.Undefined();

  const auto res = runtime_->ExecuteScriptInEnvironment(data->table_ref.ref, script, chunk_name);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return env_.Undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

// NOLINTNEXTLINE(readability-make-member-function-const)
Napi::Value LuaContext::GetMemoryUsage(const Napi::CallbackInfo& /*info*/) {
  // A worker thread mutates the allocator counter during async execution;
  // reading it concurrently would be a data race.
  if (RejectIfBusy()) return env_.Undefined();
  return Napi::Number::New(env_, static_cast<double>(runtime_->GetMemoryUsage()));
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
  if (RejectIfBusy()) return env_.Undefined();

  const auto memory_bytes = static_cast<double>(runtime_->GetMemoryUsage());

  Napi::Object result = Napi::Object::New(env_);
  (void)result.Set("version", Napi::String::New(env_, lua_core::LuaRuntime::GetVersion()));
  (void)result.Set("release", Napi::String::New(env_, lua_core::LuaRuntime::GetRelease()));
  (void)result.Set("versionNumber",
    Napi::Number::New(env_, lua_core::LuaRuntime::GetVersionNumber()));
  (void)result.Set("memoryBytes", Napi::Number::New(env_, memory_bytes));
  (void)result.Set("memoryKB", Napi::Number::New(env_, memory_bytes / 1024.0));
  (void)result.Set("memoryLimit",
    Napi::Number::New(env_, static_cast<double>(runtime_->GetMemoryLimit())));
  (void)result.Set("maxInstructions",
    Napi::Number::New(env_, static_cast<double>(runtime_->GetMaxInstructions())));
  (void)result.Set("timeout",
    Napi::Number::New(env_, static_cast<double>(runtime_->GetTimeout())));

  // The libraries this state was opened with, verbatim from the config the
  // runtime kept — so a preset ('all'/'safe') reads back as the names it
  // expanded to, and a bare state as an empty array.
  const auto& libraries = runtime_->GetConfig().libraries;
  const Napi::Array libs = Napi::Array::New(env_, libraries.size());
  for (size_t i = 0; i < libraries.size(); ++i) {
    (void)libs.Set(static_cast<uint32_t>(i), Napi::String::New(env_, libraries[i]));
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

  const std::array counts = {
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
  static constexpr std::array kNames = {
    "callbacks", "userdata", "userdataMethods", "errorRegistry", "classes",
    "classAccessors", "typeConverters", "fromLuaConverters", "searchers",
    "sharedTables", "handlers", "asyncRefs", "callbacksObject",
  };
  static_assert(counts.size() == kNames.size(),
                "every bindingRefs count needs a name");

  Napi::Object refs = Napi::Object::New(env_);
  size_t total = 0;
  for (size_t i = 0; i < counts.size(); ++i) {
    (void)refs.Set(kNames[i], Napi::Number::New(env_, static_cast<double>(counts[i])));
    total += counts[i];
  }
  (void)refs.Set("total", Napi::Number::New(env_, static_cast<double>(total)));
  return refs;
}

namespace {

// gc('param', name, value?): the optional third argument. Leaves `value` alone
// when it is absent. Returns false with a JS exception pending.
bool ReadGCParamValue(const Napi::Env env, const Napi::CallbackInfo& info, int& value) {
  if (info.Length() <= 2 || info[2].IsUndefined() || info[2].IsNull()) return true;
  if (!info[2].IsNumber()) {
    Napi::TypeError::New(env, "gc('param', name, value): value must be a number")
      .ThrowAsJavaScriptException();
    return false;
  }
  const double raw = info[2].As<Napi::Number>().DoubleValue();
  if (raw < 0 || raw > lua_core::LuaRuntime::kMaxGCParam) {
    Napi::RangeError::New(env,
      "gc('param', name, value): value must be between 0 and " +
      std::to_string(lua_core::LuaRuntime::kMaxGCParam))
      .ThrowAsJavaScriptException();
    return false;
  }
  value = static_cast<int>(raw);
  return true;
}

// gc('step', stepSize?): the optional second argument. Leaves `step_size`
// alone when it is absent. Returns false with a JS exception pending.
bool ReadGCStepSize(const Napi::Env env, const Napi::CallbackInfo& info, size_t& step_size) {
  if (info.Length() <= 1 || info[1].IsUndefined() || info[1].IsNull()) return true;
  if (!info[1].IsNumber()) {
    Napi::TypeError::New(env, "gc('step', stepSize): stepSize must be a number")
      .ThrowAsJavaScriptException();
    return false;
  }
  const auto step = SizeLimitFromNumber(info[1].As<Napi::Number>().DoubleValue());
  if (!step) {
    Napi::RangeError::New(env,
      "gc('step', stepSize): stepSize must be non-negative")
      .ThrowAsJavaScriptException();
    return false;
  }
  step_size = *step;
  return true;
}

}  // namespace

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
  if (RejectIfBusy()) return env_.Undefined();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_,
      "gc(command) requires a command string (e.g. 'collect', 'count')")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  const std::string command = info[0].As<Napi::String>().Utf8Value();

  // 'collect' and 'step' run __gc finalizers, which are Lua and can re-enter a
  // host callback — the CR-9 F1 vector that needs no metatable at all. The core
  // brackets lua_gc itself; this scope additionally clears the JS-error
  // registry at the outermost entry, as every other Lua-running method does.
  const CallScope call_scope(this);

  try {
    if (command == "param") {
      if (info.Length() < 2 || !info[1].IsString()) {
        Napi::TypeError::New(env_,
          "gc('param', name, value?) requires a parameter name string")
          .ThrowAsJavaScriptException();
        return env_.Undefined();
      }
      const std::string param = info[1].As<Napi::String>().Utf8Value();
      // Omitting the value reads the current setting without changing it, which
      // Lua spells as a negative value.
      int value = -1;
      if (!ReadGCParamValue(env_, info, value)) return env_.Undefined();
      return Napi::Number::New(env_, runtime_->GarbageCollectParam(param, value));
    }

    size_t step_size = 0;
    if (command == "step" && !ReadGCStepSize(env_, info, step_size)) {
      return env_.Undefined();
    }

    const auto result = runtime_->GarbageCollect(command, step_size);
    return std::visit([this](const auto& v) -> Napi::Value {
      using T = std::decay_t<decltype(v)>;
      if constexpr (std::is_same_v<T, double>) {
        return Napi::Number::New(env_, v);
      } else if constexpr (std::is_same_v<T, bool>) {
        return Napi::Boolean::New(env_, v);
      } else if constexpr (std::is_same_v<T, std::string>) {
        return Napi::String::New(env_, v);
      } else {
        return env_.Undefined();
      }
    }, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }
}

Napi::Value LuaContext::RegisterTypeConverter(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsFunction()) {
    Napi::TypeError::New(env_,
      "register_type_converter(match, convert) requires two functions")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  type_converters_.emplace_back(
    Napi::Persistent(info[0].As<Napi::Function>()),
    Napi::Persistent(info[1].As<Napi::Function>()));
  return env_.Undefined();
}

// B3 — the Lua->JS half of the converter registry. See CoreToNapi for where the
// pair is consulted and why the converter's return value is used verbatim.
Napi::Value LuaContext::RegisterFromLuaConverter(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsFunction()) {
    Napi::TypeError::New(env_,
      "register_from_lua_converter(match, convert) requires two functions")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  from_lua_converters_.emplace_back(
    Napi::Persistent(info[0].As<Napi::Function>()),
    Napi::Persistent(info[1].As<Napi::Function>()));
  return env_.Undefined();
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
  if (runtime_) runtime_->ClearHostFunctions();
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
  const bool deliverable = owner == nullptr || owner == runtime_.get();
  if (!deliverable || !value.IsObject()) {
    return message.empty() ? value.ToString().Utf8Value() : message;
  }
  const auto obj = value.As<Napi::Object>();

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
  runtime_->SetPendingErrorValue(
    std::make_shared<lua_core::LuaValue>(lua_core::LuaValue::from(std::move(t))));
  return message;
}

Napi::Value LuaContext::LuaErrorToJsValue(const std::string& fallback) {
  const lua_core::LuaPtr ev = runtime_->TakeLastErrorValue();
  if (ev && std::holds_alternative<lua_core::LuaTable>(ev->value)) {
    const auto& t = std::get<lua_core::LuaTable>(ev->value);
    const auto it = t.find(lua_core::LuaRuntime::kJsErrorIdField);
    if (it != t.end() && it->second &&
        std::holds_alternative<int64_t>(it->second->value)) {
      // The field is a plain Lua number by the time it comes back, so anything
      // could be sitting in it — a hostile script can forge or mangle the id.
      // Negatives are rejected before the cast rather than wrapping into some
      // other live entry's key; a value we never minted simply misses.
      const int64_t raw = std::get<int64_t>(it->second->value);
      const auto rit = raw < 0 ? js_error_registry_.end()
                         : js_error_registry_.find(static_cast<uint64_t>(raw));
      if (rit != js_error_registry_.end()) {
        Napi::Object original = rit->second.Value();
        js_error_registry_.erase(rit);
        return original;  // the original JS Error object, fully preserved
      }
    }
  }
  return Napi::Error::New(env_, fallback).Value();
}

void LuaContext::ThrowLuaError(const std::string& fallback) {
  Napi::Error(env_, LuaErrorToJsValue(fallback)).ThrowAsJavaScriptException();
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
  // A by-copy capture of a const reference is a const member, so the closure's
  // move constructor copies the string and can, on paper, throw bad_alloc. The
  // closure lives on the heap inside a std::function and is never moved after
  // that; an init-capture would silence this at the cost of shadowing `name`.
  // NOLINTNEXTLINE(bugprone-exception-escape)
  return [this, name, alive = context_alive_, owner = runtime_.get()](
           const std::vector<lua_core::LuaPtr>& args) -> lua_core::LuaPtr {
    if (!alive || !alive->load()) {
      // Must precede every member access, including the HandleScope's `env_`.
      // Throwing is the right shape: the bridge stages it as an ordinary Lua
      // error, and inside a finalizer Lua reports it as a warning.
      throw std::runtime_error(
        "JS callback '" + name + "' outlived its Lua context");
    }
    // Runs inside a Lua C frame; scope the per-call handles (args + result) so a
    // tight Lua loop calling this host function doesn't accumulate millions of
    // live handles until the enclosing script returns. The stashed
    // async_pending_promise_ is a Persistent (strong) ref and survives the scope.
    const Napi::HandleScope scope(env_);
    // Look the callback up explicitly: operator[] would default-construct an
    // empty FunctionReference for a missing name, and calling that is UB.
    const auto cb_it = js_callbacks_.find(name);
    if (cb_it == js_callbacks_.end()) {
      throw std::runtime_error("JS callback '" + name + "' is no longer registered");
    }
    // Materialize the callback before anything below can run user JS: a nested
    // registration can rehash js_callbacks_, which invalidates iterators (the
    // stored FunctionReference is stable, the iterator is not). Taking the
    // value now also gives this call the function it started with, even if the
    // entry is replaced mid-flight (CR-11 F5, the binding half of F2).
    const Napi::Function callback = cb_it->second.Value();
    std::vector<napi_value> js_args;
    js_args.reserve(args.size());
    for (const auto& a : args) {
      js_args.push_back(CoreToNapi(*a));
    }
    try {
      const Napi::Value result = callback.Call(js_args);
      if (result.IsPromise()) {
        if (!runtime_->IsAwaitDriverMode()) {
          throw std::runtime_error(
            "'" + name + "' returned a Promise; call it inside execute_async(), "
            "call_async(), or resume_async() to await it");
        }
        // Stash the promise and signal LuaCallHostFunction to suspend.
        async_pending_promise_ = Napi::Persistent(result.As<Napi::Object>());
        runtime_->RequestAwaitYield();
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
  // NOLINTNEXTLINE(bugprone-exception-escape): see CreateJsCallbackWrapper.
  return [this, name, class_name, readable, writable, alive = context_alive_,
          owner = runtime_.get()](
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
    const Napi::HandleScope scope(env_);
    const auto cb_it = js_callbacks_.find(name);
    if (cb_it == js_callbacks_.end()) {
      throw std::runtime_error(
        "Class '" + class_name + "' constructor is no longer registered");
    }
    // See CreateJsCallbackWrapper: take the function out of the map before any
    // user JS runs, so a rehash can't invalidate the iterator (CR-11 F5).
    const Napi::Function callback = cb_it->second.Value();
    std::vector<napi_value> js_args;
    js_args.reserve(args.size());
    for (const auto& a : args) {
      js_args.push_back(CoreToNapi(*a));
    }

    Napi::Value instance;
    try {
      instance = callback.Call(js_args);
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
    const auto inst_obj = instance.As<Napi::Object>();
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
    DefineHiddenProp(env_, inst_obj, "__luaClassRef", Napi::Number::New(env_, ref_id));
    DefineHiddenProp(env_, inst_obj, "__luaClassName", Napi::String::New(env_, class_name));
    DefineHiddenProp(env_, inst_obj, "__luaClassOwner",
      NewTaggedExternal(env_, runtime_.get(), lua_tags::kRuntimeOwner,
        [](Napi::Env, lua_core::LuaRuntime*) { /* non-owning: identity only */ }));
    DefineHiddenProp(env_, inst_obj, "__luaClassOwnerId",
      Napi::BigInt::New(env_, runtime_->Id()));

    UserdataEntry entry;
    entry.object = Napi::Persistent(inst_obj);
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
        ref_id, runtime_->RawState(), /*is_opaque=*/false, LUA_NOREF,
        /*is_proxy=*/false, class_name)));
  };
}

Napi::Value LuaContext::ExecuteScript(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string script = info[0].As<Napi::String>().Utf8Value();

  const CallScope call_scope(this);
  std::string chunk_name;
  if (!ParseChunkName(info, 1, "execute_script()", chunk_name)) return env_.Undefined();

  const auto res = runtime_->ExecuteScript(script, chunk_name);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return env_.Undefined();
  }
  return ResultsToJs(std::get<std::vector<lua_core::LuaPtr>>(res));
}

Napi::Value LuaContext::ExecuteFile(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string filepath = info[0].As<Napi::String>().Utf8Value();

  const CallScope call_scope(this);
  const auto res = runtime_->ExecuteFile(filepath);
  if (std::holds_alternative<std::string>(res)) {
    ThrowLuaError(std::get<std::string>(res));
    return env_.Undefined();
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
  runtime_->ClearCancel();
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

namespace {

// The AsyncInFlight refusal. One definition because two kinds of site say it:
// RejectIfOccupied, which throws it, and the coroutine-driven doors, which
// reject a promise with it at their commit point (see BeginAsyncRun).
constexpr const char* kAsyncBusyMessage = "Lua context is busy with an async operation";

}  // namespace

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
//   state, firing inside lua_close, where `runtime_` already points at the
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

  // C2: a closed context refuses everything, and the check lives *here* rather
  // than in each method because that is what makes it complete. Every entry
  // point that reaches the core through a guard already calls this or
  // `RejectIfBusy`, which delegates to it — so `liveness-guarding`'s CHECKED
  // rows are closed-safe by construction, and its 21 UNCHECKED rows are exactly
  // the list that had to be ruled on by hand (twenty covered by the claim set
  // below, one — `cancel()` — guarded explicitly at its own site).
  if (closed_) {
    Napi::Error::New(env_, op
      ? std::string(op) + " is unavailable: the Lua context has been closed"
      : std::string("the Lua context has been closed"))
      .ThrowAsJavaScriptException();
    return true;
  }
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
    reason = kAsyncBusyMessage;
    parameterized = false;
  } else if (wants(Claim::LuaExecuting) && runtime_ && runtime_->IsExecuting()) {
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

  std::string message;
  if (parameterized) message = op ? op : "this operation";
  message += reason;
  if (detail) {
    message += ": ";
    message += detail;
  }
  Napi::Error::New(env_, message).ThrowAsJavaScriptException();
  return true;
}

bool LuaContext::RejectIfBusy() const {
  return RejectIfOccupied(nullptr, lua_occupancy::kSyncApi);
}

// NOLINTNEXTLINE(readability-make-member-function-const)
Napi::Value LuaContext::IsBusyMethod(const Napi::CallbackInfo& /*info*/) {
  return Napi::Boolean::New(env_, is_busy_.load());
}

namespace {

// Why the worker-async launchers use kExclusive: they hand the lua_State to a
// libuv thread, and a Lua state may be touched by one thread at a time. Stated
// once here rather than at both call sites.
constexpr const char* kWorkerHandoffDetail =
  "handing the state to a worker thread requires that nothing else holds it";

}  // namespace

// execute_script_async / execute_file_async run the script on a libuv worker
// thread: use them for CPU-bound Lua that shouldn't block the event loop, but
// note the script cannot call back into JS (host callbacks are disabled in
// async_mode_) and print redirection is bypassed. For Lua that needs to await JS
// Promises or invoke JS callbacks, use execute_async (coroutine-driven, stays on
// the main thread) instead.
Napi::Value LuaContext::ExecuteScriptAsync(const Napi::CallbackInfo& info) {
  if (RejectIfOccupied("execute_script_async()", lua_occupancy::kExclusive,
                       kWorkerHandoffDetail)) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string script = info[0].As<Napi::String>().Utf8Value();

  // Read before is_busy_ is set: the options read can be an accessor, i.e. user
  // JS, and a throw from it must leave the context idle rather than wedged
  // busy with no worker ever queued to clear it.
  std::string chunk_name;
  {
    const CallScope call_scope(this);
    if (!ParseChunkName(info, 1, "execute_script_async()", chunk_name)) return env_.Undefined();
  }
  is_busy_ = true;

  const auto deferred = Napi::Promise::Deferred::New(env_);
  auto* worker = new LuaScriptAsyncWorker(
    runtime_, script, this, Napi::Persistent(info.This().As<Napi::Object>()), deferred,
    chunk_name);
  worker->Queue();
  return deferred.Promise();
}

Napi::Value LuaContext::ExecuteFileAsync(const Napi::CallbackInfo& info) {
  if (RejectIfOccupied("execute_file_async()", lua_occupancy::kExclusive,
                       kWorkerHandoffDetail)) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string argument").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const std::string filepath = info[0].As<Napi::String>().Utf8Value();
  is_busy_ = true;

  const auto deferred = Napi::Promise::Deferred::New(env_);
  auto* worker = new LuaFileAsyncWorker(
    runtime_, filepath, this, Napi::Persistent(info.This().As<Napi::Object>()), deferred);
  worker->Queue();
  return deferred.Promise();
}

// --- Coroutine-driven async execution (execute_async / cancel) ---

Napi::Value LuaContext::ExecuteAsync(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env_, "Expected string argument").ThrowAsJavaScriptException();
    return env_.Undefined();
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
    const CallScope call_scope(this);
    std::string chunk_name;
    if (!ParseChunkName(info, 1, "execute_async()", chunk_name)) return env_.Undefined();
    co = runtime_->CreateCoroutineFromScript(script, chunk_name);
  } catch (const std::exception& e) {
    const auto deferred = Napi::Promise::Deferred::New(env_);
    deferred.Reject(Napi::Error::New(env_, e.what()).Value());
    return deferred.Promise();
  }
  if (std::holds_alternative<std::string>(co)) {
    // Reject (rather than throw) so `.catch` and `await` both see the error.
    const auto deferred = Napi::Promise::Deferred::New(env_);
    deferred.Reject(Napi::Error::New(env_, std::get<std::string>(co)).Value());
    return deferred.Promise();
  }

  // The commit-point check (see BeginAsyncRun): the chunkName read above can be
  // an accessor, and a run it started must not be overwritten by this one. The
  // thread just created is dropped with `co`.
  if (IsBusy()) {
    const auto deferred = Napi::Promise::Deferred::New(env_);
    deferred.Reject(Napi::Error::New(env_, kAsyncBusyMessage).Value());
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
//
// **The commit-point check.** One run at a time is this function's
// precondition, and a door's entry check does not establish it: between that
// check and here every door runs user JS (an argument's getter, a type
// converter, the `_coroutine` or `chunkName` read, a __gc finalizer), and
// `execute_async` may legitimately be started from any of it. Arming a second
// run over the first replaces `async_deferred_`, so the first promise never
// settles, and where the first run owns its thread `AsyncDrivenThread()` hands
// the second run *that* thread to drive. So each door re-checks `IsBusy()`
// after its last user JS and before it sets `async_co_` / `async_borrowed_`,
// and rejects with kAsyncBusyMessage. The assert below is what makes a door
// that forgets fail in the debug build the suite runs. Until November 24, 2026
// no door had the check, and the async cursor had no entry check either.
const lua_core::LuaThreadRef& LuaContext::AsyncDrivenThread() const {
  return async_co_ ? *async_co_ : async_borrowed_->thread_ref;
}

Napi::Value LuaContext::BeginAsyncRun(const Napi::Object& self,
                                      const std::vector<lua_core::LuaPtr>& args,
                                      const char* arg_role) {
  assert(!async_deferred_.has_value() && !is_busy_ &&
         "BeginAsyncRun over a run in flight: the door skipped its "
         "commit-point check");
  is_busy_ = true;
  ++async_generation_;  // invalidate any stale settlement from a prior run
  js_error_registry_.clear();
  runtime_->ClearCancel();
  runtime_->SetAwaitDriverMode(true);
  // Tell the core which thread is the driver so a promise awaited from a
  // coroutine this run is *not* driving is rejected rather than yielding the
  // wrong state (M1). Under resume_async the caller's own coroutine is the
  // driven thread, which is exactly what lets it await.
  runtime_->SetAwaitDriverThread(AsyncDrivenThread().thread);
  async_deferred_.emplace(Napi::Promise::Deferred::New(env_));
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

namespace {

// Defined further down, next to the coroutine API its other callers belong to.
LuaFunctionData* LuaFunctionDataFrom(const Napi::Value& value);

}  // namespace

// Resolves call_async's first argument — a Lua function handle or a global
// name — to the function to run. Three outcomes: a function; nullopt with
// `reject_reason` set (the caller rejects its promise); or nullopt with `threw`
// set and a JS exception pending. Called under CallAsync's CallScope: the
// marker read can be a Proxy trap and the global lookup a metatabled _G.
std::optional<lua_core::LuaFunctionRef> LuaContext::ResolveAsyncCallTarget(
    const Napi::Value& target_arg, std::string& reject_reason, bool& threw) {
  if (target_arg.IsFunction()) {
    // Same identity checks create_coroutine and resume apply (M1): a ref from
    // another context names a slot in an unrelated registry, and a released one
    // names nothing.
    const auto* fn_data = LuaFunctionDataFrom(target_arg);
    if (!fn_data) {
      Napi::TypeError::New(env_,
        "call_async() accepts a global name or a Lua function; a plain "
        "JavaScript function is not callable in Lua")
        .ThrowAsJavaScriptException();
      threw = true;
      return std::nullopt;
    }
    if (fn_data->runtime.get() != runtime_.get()) {
      reject_reason = "Lua function belongs to a different Lua context";
      return std::nullopt;
    }
    if (fn_data->func_ref.ref == LUA_NOREF) {
      reject_reason = "Lua function has been released";
      return std::nullopt;
    }
    // Copying shares the registry slot rather than minting a second owner, so
    // the body outlives the JS wrapper for the run's duration.
    return fn_data->func_ref;
  }

  const std::string name = target_arg.As<Napi::String>().Utf8Value();
  lua_core::LuaPtr target;
  try {
    if (name.find('.') != std::string::npos) {
      std::vector<std::string> path;
      if (!SplitGlobalPath(name, path)) {
        reject_reason = "Invalid global path '" + name +
          "': path segments must be non-empty (no leading, trailing, or doubled dots)";
        return std::nullopt;
      }
      target = runtime_->GetGlobalPath(path);
    } else {
      target = runtime_->GetGlobal(name);
    }
  } catch (const std::exception& e) {
    reject_reason = e.what();
    return std::nullopt;
  }
  // Only a genuine Lua function. A callable table (__call) arrives as a
  // LuaTableRef and would need a different core entry point — the same line
  // call() draws, and drawn the same way so the two doors agree.
  if (!target || !std::holds_alternative<lua_core::LuaFunctionRef>(target->value)) {
    reject_reason = "Lua global '" + name + "' is not a function";
    return std::nullopt;
  }
  return std::get<lua_core::LuaFunctionRef>(target->value);
}

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
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || (!info[0].IsString() && !info[0].IsFunction())) {
    Napi::TypeError::New(env_,
      "call_async(nameOrFn, ...args) requires a global name or a Lua function")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  // Rejections rather than throws for everything past argument validation, so
  // `await` and `.catch` see failures uniformly — the same choice execute_async
  // makes for a chunk that fails to load.
  const auto reject = [this](const std::string& msg) -> Napi::Value {
    const auto deferred = Napi::Promise::Deferred::New(env_);
    deferred.Reject(Napi::Error::New(env_, msg).Value());
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
  // One collector spans every argument so a later argument's conversion failure
  // sweeps the reclaimable callbacks minted by the earlier ones (CR-8 F1) —
  // **and stays open across the drive at the bottom**, because that is where
  // the arguments are pushed: BeginAsyncRun's first ResumeAsyncStep. Its sweep
  // erases every callback not yet pushed, so closed any earlier it erases all
  // of them, and a function argument reached Lua as a name that resolved to
  // nothing ("Host function '__js_callback_N' not found"). The synchronous
  // doors and OnAwaitSettled already hold theirs across the push. Unlike the
  // CallScope below it is safe to hold: it raises no depth counter, and the
  // drive returns to this frame when the run suspends, so it is never open
  // across an await.
  const JsCallbackCollectorScope collector(this);
  {
  const CallScope call_scope(this);

  std::string reject_reason;
  bool threw = false;
  const std::optional<lua_core::LuaFunctionRef> func_ref =
    ResolveAsyncCallTarget(info[0], reject_reason, threw);
  if (threw) return env_.Undefined();
  if (!func_ref) return reject(reject_reason);

  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  try {
    for (size_t i = 1; i < info.Length(); ++i) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(info[i])));
    }
  } catch (const std::exception& e) {
    return reject(e.what());
  }

  std::variant<lua_core::LuaThreadRef, std::string> co = std::string();
  try {
    co = runtime_->CreateCoroutine(*func_ref);
  } catch (const std::exception& e) {
    return reject(e.what());
  }
  if (std::holds_alternative<std::string>(co)) {
    return reject(std::get<std::string>(co));
  }
  thread.emplace(std::move(std::get<lua_core::LuaThreadRef>(co)));
  }  // CallScope closes here — nothing below runs user JS before the drive

  // The commit-point check (see BeginAsyncRun). `thread` and the converted
  // arguments are dropped, and the collector sweeps the callbacks they minted.
  if (IsBusy()) return reject(kAsyncBusyMessage);

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

Napi::Promise::Deferred LuaContext::ActiveAsyncDeferred() const {
  assert(async_deferred_.has_value() && "no async run is in flight");
  // NOLINTNEXTLINE(bugprone-unchecked-optional-access): precondition, see header.
  return *async_deferred_;
}

// A plain `coroutine.yield` reached the driver (not a suspension for a host
// Promise). The first of DriveAsync's three exits.
void LuaContext::SettlePlainYield(const lua_core::AsyncStepResult& step) {
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
    const auto yield_deferred = ActiveAsyncDeferred();
    Napi::Value resolved;
    bool ok = true;
    std::string conv_err;
    try {
      resolved = CoroutineResultToJs(async_coro_obj_.Value(),
                                     lua_core::CoroutineStatus::Suspended,
                                     step.values, std::nullopt);
    } catch (const std::exception& e) {
      ok = false;
      conv_err = e.what();
    }
    if (AsyncRunSuperseded(yield_gen)) return;
    FinishAsync();
    if (ok) {
      yield_deferred.Resolve(resolved);
    } else {
      yield_deferred.Reject(Napi::Error::New(env_,
        std::string("failed to convert yielded values: ") + conv_err).Value());
    }
    return;
  }
  // execute_async / call_async: nothing here can resume it.
  const auto deferred = ActiveAsyncDeferred();
  FinishAsync();
  deferred.Reject(Napi::Error::New(env_,
    "coroutine.yield is not supported at the top level of execute_async or "
    "call_async; only awaiting a host Promise suspends execution. Use "
    "resume_async() to drive a coroutine that yields").Value());
}

// The coroutine suspended for a host Promise: attach the continuation and
// return to the event loop. The second exit, and the only one that leaves the
// run in flight.
void LuaContext::AttachToAwaitedPromise() {
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
  const Napi::Object promise = async_pending_promise_.Value();
  async_pending_promise_.Reset();
  std::string attach_err;
  bool attached = false;
  // A hostile `then` can settle synchronously (re-entering OnAwaitSettled and
  // finishing this run) and THEN throw; the failure branch below must not
  // tear down a run that already ended — or a newer one started meanwhile.
  const uint64_t attach_gen = async_generation_;
  try {
    const Napi::Value then_val = promise.Get("then");
    if (!then_val.IsFunction()) {
      attach_err = "awaited Promise has no callable 'then'";
    } else {
      const auto then_fn = then_val.As<Napi::Function>();
      auto* cookie = new AwaitCookie{this, async_generation_, false, alive_};
      // Hand ownership to the External before anything else can throw, so a
      // failure below cannot leak the cookie (it is reclaimed with the
      // then-unrooted handles).
      const auto cookie_owner = Napi::External<AwaitCookie>::New(env_, cookie,
        [](Napi::Env, const AwaitCookie* c) { delete c; });
      const auto on_resolve = Napi::Function::New(env_, &LuaContext::OnAwaitResolveStatic, "onResolve", cookie);
      const auto on_reject = Napi::Function::New(env_, &LuaContext::OnAwaitRejectStatic, "onReject", cookie);
      DefineHiddenProp(env_, on_resolve, "__cookie", cookie_owner);
      DefineHiddenProp(env_, on_reject, "__cookie", cookie_owner);
      then_fn.Call(promise, {on_resolve, on_reject});
      attached = true;
    }
  } catch (const std::exception& e) {
    attach_err = e.what();
  }
  if (!attached && !AsyncRunSuperseded(attach_gen)) {
    const auto deferred = ActiveAsyncDeferred();
    FinishAsync();
    deferred.Reject(Napi::Error::New(env_,
      "failed to attach to the awaited Promise: " + attach_err).Value());
  }
}

// The coroutine finished or raised. The third exit.
void LuaContext::SettleFinishedRun(const lua_core::AsyncStepResult& step) {
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
  const auto deferred = ActiveAsyncDeferred();

  // resume_async answers with the same `{ status, values, error? }` object
  // resume() does — including for a Lua error, which resume() reports in the
  // result rather than throwing. Mirroring it exactly is what makes the async
  // door a drop-in replacement; diverging on error handling alone would be the
  // sibling-doors-disagree defect this work exists to remove.
  if (async_coroutine_mode_) {
    Napi::Value resolved;
    bool ok = true;
    std::string conv_err;
    const bool errored = step.state != lua_core::AsyncStepResult::State::Finished;
    try {
      resolved = CoroutineResultToJs(
        async_coro_obj_.Value(), lua_core::CoroutineStatus::Dead,
        errored ? std::vector<lua_core::LuaPtr>{} : step.values,
        errored ? std::optional<std::string>(step.error) : std::nullopt);
    } catch (const std::exception& e) {
      ok = false;
      conv_err = e.what();
    }
    if (AsyncRunSuperseded(settle_gen)) return;
    FinishAsync();
    if (ok) {
      deferred.Resolve(resolved);
    } else {
      deferred.Reject(Napi::Error::New(env_,
        std::string("failed to convert async result: ") + conv_err).Value());
    }
    return;
  }

  if (step.state == lua_core::AsyncStepResult::State::Finished) {
    Napi::Value resolved;
    bool ok = true;
    std::string conv_err;
    try {
      resolved = ResultsToJs(step.values);
    } catch (const std::exception& e) {
      ok = false;
      conv_err = e.what();
    }
    if (AsyncRunSuperseded(settle_gen)) return;  // cancel() already settled it
    FinishAsync();
    if (ok) {
      deferred.Resolve(resolved);
    } else {
      deferred.Reject(Napi::Error::New(env_,
        std::string("failed to convert async result: ") + conv_err).Value());
    }
  } else {
    // Reconstruct the original JS Error if this was a raised JS callback error.
    // LuaErrorToJsValue runs no user JS today — it is a registry lookup and a
    // Napi::Error construction — so this branch is currently unreachable from a
    // hostile converter. The check is here anyway because that is a property of
    // LuaErrorToJsValue's body rather than of this call site, and CR-14 F2's
    // lesson was that a guard whose soundness lives somewhere else stops
    // holding without anyone editing the guard.
    const Napi::Value err_value = LuaErrorToJsValue(step.error);
    if (AsyncRunSuperseded(settle_gen)) return;
    FinishAsync();
    deferred.Reject(err_value);
  }}

void LuaContext::DriveAsync(const std::vector<lua_core::LuaPtr>& args, bool is_error,
                            const char* arg_role) {
  // Mark the resume window so a cancel() arriving re-entrantly from a host
  // callback defers its teardown until after the coroutine leaves the C stack
  // (see Cancel()). Tearing down here would free the running coroutine. RAII so
  // the flag is cleared even if the resume unexpectedly throws (H1).
  lua_core::AsyncStepResult step;
  {
    const ScopedFlag resuming(async_resuming_);
    step = runtime_->ResumeAsyncStep(AsyncDrivenThread(), args, is_error, arg_role);
  }

  // Honor a cancel() that arrived during the resume, now that the coroutine has
  // returned. Also covers a cancel requested before an about-to-be-attached
  // continuation.
  if (runtime_->IsCancelRequested()) {
    const auto deferred = ActiveAsyncDeferred();
    FinishAsync();
    deferred.Reject(Napi::Error::New(env_, "execution cancelled").Value());
    return;
  }

  if (step.state != lua_core::AsyncStepResult::State::Awaiting) {
    SettleFinishedRun(step);
  } else if (!step.awaited || async_pending_promise_.IsEmpty()) {
    SettlePlainYield(step);
  } else {
    AttachToAwaitedPromise();
  }
}

Napi::Value LuaContext::OnAwaitSettled(const Napi::Value& value, bool is_error, uint64_t gen) {
  // Ignore a settlement from a run that has already ended or been superseded
  // (e.g. a promise from a cancelled run resolving after a new run has started).
  // A cancel() while suspended awaiting a promise tears the run down immediately
  // in Cancel() (clearing async_co_), so a pending cancel is never observed here
  // — the generation/liveness guard above already discards the late settlement.
  if (AsyncRunSuperseded(gen)) {
    return env_.Undefined();
  }

  std::vector<lua_core::LuaPtr> args;
  // Collect any reclaimable callback entries minted while converting the
  // settled value into args: if the H2 re-check below drops this settlement,
  // they were never pushed and must be swept (N4).
  const JsCallbackCollectorScope collector(this);
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
      if (runtime_->HasPendingErrorValue()) runtime_->TakePendingErrorValue();
    }
    if (runtime_->HasPendingErrorValue()) {
      args.push_back(runtime_->TakePendingErrorValue());
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
      const auto deferred = ActiveAsyncDeferred();
      FinishAsync();
      deferred.Reject(Napi::Error::New(env_,
        std::string("failed to convert awaited value: ") + e.what()).Value());
      return env_.Undefined();
    }
  }
  // Marshalling the settled value above (type converters, object getters, the
  // reject path's message/name/stack reads) can run user JS that calls cancel()
  // — which, since we are not inside a resume, takes the full-teardown branch
  // and disengages async_co_/async_deferred_ — or even starts a new run. Re-check
  // the liveness+generation guard before driving so we neither dereference a
  // disengaged optional nor inject this settlement into a newer run (H2).
  if (AsyncRunSuperseded(gen)) {
    return env_.Undefined();  // collector's destructor sweeps the dropped args
  }
  DriveAsync(args, is_error);
  return env_.Undefined();
}

void LuaContext::FinishAsync() {
  runtime_->SetAwaitDriverMode(false);
  runtime_->SetAwaitDriverThread(nullptr);
  runtime_->ClearCancel();
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

Napi::Value LuaContext::Cancel(const Napi::CallbackInfo& /*info*/) {
  // C1's one outlier. `cancel()` is deliberately outside the occupancy guards —
  // it has to work *while* a run is in flight, which is the whole point of it —
  // so it is the single binding→core path that the `kRetireState` claim set
  // does not cover for a closed context. Guarded here, explicitly, rather than
  // by weakening the policy that makes cancel useful.
  //
  // A no-op rather than a throw: cancelling a context that has already ended is
  // a request that has already been granted, and code that cancels on a timer
  // or an abort signal should not have to know which happened first.
  if (closed_) return env_.Undefined();

  if (AsyncDriverEngaged()) {
    if (async_resuming_) {
      // Called re-entrantly from a host callback while the coroutine is still
      // executing on the C stack. Tearing down now would free the running
      // coroutine (use-after-free) and disengage async_deferred_ out from under
      // DriveAsync. Defer: DriveAsync observes the request once the resume
      // returns and finishes the run then.
      runtime_->RequestCancel();
      return env_.Undefined();
    }
    // Abandon the suspended coroutine and reject immediately. Any pending
    // promise settlement becomes a no-op (the driver is disengaged).
    //
    // For a resume_async run the thread is the *caller's*, so "abandon" means
    // detach and leave it suspended exactly where it stopped — it stays
    // resumable, the same end state an early `break` out of `for..of` produces.
    // FinishAsync releases only a binding-owned thread.
    const auto deferred = ActiveAsyncDeferred();
    FinishAsync();
    deferred.Reject(Napi::Error::New(env_, "execution cancelled").Value());
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
    runtime_->RequestCancel();
  }
  return env_.Undefined();
}

// NOLINTNEXTLINE(readability-make-member-function-const)
Napi::Value LuaContext::Pcall(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env_, "pcall(fn, ...args) requires a function as the first argument")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const auto fn = info[0].As<Napi::Function>();
  std::vector<napi_value> args;
  for (size_t i = 1; i < info.Length(); ++i) args.push_back(info[i]);

  const Napi::Object result = Napi::Object::New(env_);
  try {
    const Napi::Value r = fn.Call(args);
    (void)result.Set("ok", Napi::Boolean::New(env_, true));
    (void)result.Set("value", r);
  } catch (const Napi::Error& e) {
    // The thrown value is preserved (reconstructed original JS Error when the
    // failure came from a JS callback; otherwise a Lua-error Error object).
    (void)result.Set("ok", Napi::Boolean::New(env_, false));
    (void)result.Set("error", e.Value());
  }
  return result;
}

// The object half of release(): a coroutine or a table handle. Returns true if
// `obj` was one — released, or refused as foreign with a JS exception pending —
// and false if it carries neither marker. Same rules as Release itself: each
// marker is read once and checked for kind, and the runtime identity check
// runs *after* the read, so a trap on it still fails closed.
// NOLINTNEXTLINE(readability-make-member-function-const)
bool LuaContext::ReleaseObjectHandle(const Napi::Object& obj) {
  if (auto* data = TaggedData<LuaThreadData>(obj.Get("_coroutine"),
                                             lua_tags::kThreadData)) {
    if (data->runtime.get() != runtime_.get()) {
      Napi::Error::New(env_, "value belongs to a different Lua context")
        .ThrowAsJavaScriptException();
      return true;
    }
    if (data->thread_ref.ref != LUA_NOREF) data->thread_ref.release();
    return true;
  }

  if (auto* data = TaggedData<LuaTableRefData>(obj.Get("_tableRef"),
                                               lua_tags::kTableRefData)) {
    if (data->runtime.get() != runtime_.get()) {
      Napi::Error::New(env_, "value belongs to a different Lua context")
        .ThrowAsJavaScriptException();
      return true;
    }
    if (data->table_ref.ref != LUA_NOREF) data->table_ref.release();
    return true;
  }
  return false;
}

// Explicit registry-reference release for the wrapper kinds that outlive a
// single call: Lua functions (__luaFnOwner), coroutines (_coroutine), and
// table handles / metatabled-table Proxies (_tableRef). Dropping the ref frees
// the registry slot on the next Lua GC cycle instead of waiting for the JS
// wrapper to be garbage-collected. Double release is a safe no-op; using a
// wrapper after release throws a clear "has been released" error.
// NOLINTNEXTLINE(readability-make-member-function-const)
Napi::Value LuaContext::Release(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1) {
    Napi::TypeError::New(env_,
      "release(value) requires a Lua function, coroutine, or table reference")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const Napi::Value target = info[0];

  // Only trust a marker minted by THIS context's runtime — a ref index from
  // another context would address an unrelated slot in that registry (the same
  // policy as the round-trip identity checks in NapiToCoreImpl).
  const auto reject_foreign = [this]() {
    Napi::Error::New(env_, "value belongs to a different Lua context")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  };

  // Each marker is read **once** and checked for kind as well as shape
  // (CR-15 F6). Both mattered here: the old form did `Has(k)` and then two
  // separate `Get(k)`s, which a Proxy can answer differently each time, and it
  // trusted the name rather than the payload — so
  // `release({ _coroutine: fn.__luaFnOwner })` reached `thread_ref.release()` on
  // a LuaFunctionData, i.e. a shared_ptr reset at an offset chosen by the
  // caller. A wrong-kind External now reads as nullptr and falls through to the
  // "requires a Lua function, coroutine, or table reference" error below.
  if (target.IsFunction()) {
    const auto fn = target.As<Napi::Object>();
    if (auto* data = TaggedData<LuaFunctionData>(fn.Get("__luaFnOwner"),
                                                 lua_tags::kFunctionData)) {
      if (data->runtime.get() != runtime_.get()) return reject_foreign();
      if (data->func_ref.ref != LUA_NOREF) data->func_ref.release();
      return env_.Undefined();
    }
    Napi::TypeError::New(env_,
      "release(value): the function is not a Lua function reference")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  if (target.IsObject() && ReleaseObjectHandle(target.As<Napi::Object>())) {
    return env_.Undefined();
  }

  Napi::TypeError::New(env_,
    "release(value) requires a Lua function, coroutine, or table reference")
    .ThrowAsJavaScriptException();
  return env_.Undefined();
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
// runtime_.get()` identity checks elsewhere (resume, release, round-trip markers)
// stop recognizing pre-reset coroutines and userdata as belonging to this
// context.
// C2 (CONTEXT-TEARDOWN-PLAN): end this context now.
//
// **Named `dispose()`, and the first name was wrong.** It shipped for an hour as
// a no-argument `close()`, dispatching on arity beside `close(coroutine)` — on
// the reasoning that a bare `close()` already threw, so nothing could depend on
// it. The suite disproved that immediately: a P3 test pins
// `close()` -> "requires a coroutine object", and it exists because that throw
// is the *guard* against a typo. Under arity dispatch, `lua.close()` written
// while meaning `lua.close(coro)` would have silently destroyed the context
// instead of refusing — a destructive branch reached by omission, which is the
// accept-and-do-something-else shape this tree refuses everywhere else. One
// verb per subject: `close(coroutine)` ends a coroutine, `dispose()` ends the
// context.
//
// **The retire half of `reset()` without the rebuild half**, which is exactly
// what the plan's §2 (B) asked for: the same guard, the same unbinding order,
// and then `CloseState()` instead of a swap. Sharing the ordering with the
// destructor (via `CloseState`) is what keeps this from being a third teardown
// path that drifts.
//
// Guarded by `kRetireState` — `AsyncInFlight | LuaExecuting | BindingCall |
// Resetting` — which is the whole reason this method can exist. C1 enumerated
// the 21 binding paths that reach the core without a liveness check; twenty of
// them run only while Lua executes, while a binding call is in flight, or as an
// async continuation, and each of those states is a claim this policy refuses.
// So a close cannot be granted while anything that could still touch the state
// is outstanding.
//
// **What it does not free:** the C++ `LuaRuntime` shell, while any handle still
// holds a share of it. That is `shared_ptr` semantics and deliberately not
// fought; what it frees is the `lua_State`, which is where the memory is.
Napi::Value LuaContext::Dispose(const Napi::CallbackInfo& /*info*/) {
  // Idempotent, and tested *before* the guard: closing a closed context is a
  // no-op rather than an error, matching `release()` and `close(coroutine)`.
  // Ordering matters — the guard would otherwise refuse the second call with
  // "the context has been closed", which is true and useless.
  if (closed_) return env_.Undefined();
  if (RejectIfOccupied("dispose()", lua_occupancy::kRetireState)) {
    return env_.Undefined();
  }

  // Set first: `CloseState()` below fires `__gc` metamethods, and a finalizer
  // that re-enters the host must find a context that refuses rather than one
  // half-way through teardown. This is the same hazard `in_reset_` covers for
  // reset(), answered by the flag that is about to be permanent anyway.
  closed_ = true;
  if (closed_flag_) closed_flag_->store(true);

  // Unbind the runtime's handlers before anything can call them, exactly as
  // reset() does before its swap.
  DetachRuntimeHandlers();

  if (async_co_) {
    async_co_->release();
    async_co_.reset();
  }
  async_borrowed_ = nullptr;
  async_coro_obj_.Reset();
  async_coroutine_mode_ = false;

  // Every outstanding handle refuses from here: `RejectIfWorkerBusy` and the
  // handle methods test `ContextLive()`, which reads this flag. Not re-minted,
  // unlike reset()'s — there is no successor state to hand out.
  if (alive_) alive_->store(false);

  // The bookkeeping described the contents of a state that is about to stop
  // existing. The id counters stay monotonic, as in reset().
  js_callbacks_.clear();
  js_userdata_.clear();
  ud_method_fns_.clear();
  js_error_registry_.clear();
  registered_classes_.clear();
  class_accessors_.clear();

  if (runtime_) {
    runtime_->ClearHostFunctions();
    runtime_->CloseState();
  }
  return env_.Undefined();
}
// reset()'s replay of runtime settings and shared tables. Both run under the
// CallScope reset() opens after the swap: they run user JS while reset() holds
// the fresh state (CR-15 F1c). ReplayRuntimeSettings returns false with a JS
// exception pending.
//
// Replay context-level configuration in the same order the constructor
// applies it, so the print override still wins over a callback-provided
// print. These run protected _G writes that can throw under maxMemory;
// surface that as a JS error rather than unwinding out (the H1 class).
bool LuaContext::ReplayRuntimeSettings() {
  try {
    if (!allow_bytecode_) runtime_->SetAllowBytecode(false);
    // The seal has to be re-applied, not remembered: reset() builds a fresh
    // lua_State with stock libraries, so the doors are open again on it. Same
    // rule as the sandbox preset's, and the reason SetFilesystemAccess is
    // one-way rather than a toggle.
    if (filesystem_denied_) runtime_->SetFilesystemAccess(false);
    if (table_as_map_) runtime_->SetPreserveTableKeys(true);
    for (const auto& path : search_paths_) runtime_->AddSearchPath(path);
    // Replay the JS searchers too (CR-9 F3): they are context configuration in
    // exactly the way the search paths above are, so dropping them made the two
    // halves of module resolution behave differently across a reset. Fresh
    // names are minted rather than reused — next_searcher_id_ stays monotonic,
    // so a name from before the reset can never collide with one after — and
    // the pair is registered only after the core call succeeds (the N5
    // ordering, as in add_searcher itself).
    for (const auto& searcher : searchers_) {
      const std::string name = "__searcher_" + std::to_string(next_searcher_id_++);
      runtime_->AddJsSearcher(name);
      js_callbacks_[name] = Napi::Persistent(searcher.Value());
      runtime_->StoreHostFunction(name, CreateJsCallbackWrapper(name));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// Re-publish the shared globals. Unlike modules and userdata — whose Lua-side
// objects die with the old state — a shared table's value lives in JS, so
// replaying it is just another push. The subscription itself is untouched:
// this context is still in each SharedTable's list, and its weak reference is
// to the JS wrapper, which the reset did not replace.
void LuaContext::ReplaySharedTables() {
  for (const auto& [table_ref, name] : shared_tables_) {
    const SharedTable* table = AsSharedTable(env_, table_ref.Value());
    if (!table) continue;  // defensive; the entry was validated at subscribe time
    try {
      table->PushTo(Value(), name);
    } catch (const Napi::Error& e) {
      e.ThrowAsJavaScriptException();
      return;
    } catch (const std::exception& e) {
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return;
    }
  }
}

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
  //   Resetting — swapping `runtime_` below destroys the outgoing state, and
  //     lua_close fires its __gc finalizers *after* the member already points
  //     at the replacement, so a finalizer calling reset() would find a fresh
  //     runtime reporting depth 0 (CR-9 F1).
  if (RejectIfOccupied("reset()", lua_occupancy::kRetireState)) {
    return env_.Undefined();
  }
  const ScopedFlag resetting(in_reset_);

  // Build the replacement first: if construction fails (allocation failure),
  // the context keeps its current, working state rather than being left
  // runtime-less.
  std::shared_ptr<lua_core::LuaRuntime> fresh;
  try {
    fresh = std::make_shared<lua_core::LuaRuntime>(runtime_->GetConfig());
  } catch (const std::exception& e) {
    Napi::Error::New(env_, std::string("reset failed: ") + e.what())
      .ThrowAsJavaScriptException();
    return env_.Undefined();
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
  runtime_ = std::move(fresh);

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
  const CallScope call_scope(this);

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
  // print.
  if (!ReplayRuntimeSettings()) return env_.Undefined();

  // The callbacks object and the four installed handlers are replayed here,
  // not in a helper: tools/invariants/liveness-guarding scores each installer
  // by whether its *caller* holds a guard, and this is the function that does.
  if (!callbacks_ref_.IsEmpty()) {
    RegisterCallbacks(callbacks_ref_.Value());  // throws a JS error on failure
    if (env_.IsExceptionPending()) return env_.Undefined();
  }

  if (!print_handler_.IsEmpty()) {
    // Take the function out first: InstallPrintHandler reassigns print_handler_,
    // and the local keeps the value alive across that.
    const Napi::Function handler = print_handler_.Value();
    try {
      InstallPrintHandler(handler);
    } catch (const std::exception& e) {
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return env_.Undefined();
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
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return env_.Undefined();
    }
  }
  if (!file_reader_.IsEmpty()) {
    const Napi::Function reader = file_reader_.Value();
    try {
      InstallFileReader(reader);
    } catch (const std::exception& e) {
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return env_.Undefined();
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
      Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
      return env_.Undefined();
    }
  }

  ReplaySharedTables();
  return env_.Undefined();
}

void LuaContext::InstallPrintHandler(const Napi::Function& fn) {
  // Run the runtime install first: it can throw (the protected print/io.write
  // overrides fail under OOM), and print_handler_ must not be left pointing at
  // a handler those overrides never reach (CR-8 F7). The lambda reads
  // print_handler_ at call time, so committing it after the install is safe —
  // no Lua runs between.
  runtime_->SetOutputHandler([this](const std::string& text) {
    if (print_handler_.IsEmpty()) return;
    // This runs inside Lua's C call frame (print/io.write). Lua is built as C,
    // so a C++ exception must not unwind through it. Contain a throwing handler,
    // and scope the per-call handles so a hot print loop doesn't accumulate them.
    const Napi::HandleScope scope(env_);
    try {
      print_handler_.Call({Napi::String::New(env_, text)});
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
  runtime_->SetDebugHook(
    [this](const std::string& event, int line, const std::string& name) {
      if (debug_hook_.IsEmpty()) return;
      // This runs inside Lua's execution, between VM instructions. Lua is built
      // as C, so a C++ exception must not unwind through it — the core contains
      // whatever escapes, and the per-event handles are scoped so a hot line
      // hook doesn't accumulate them.
      const Napi::HandleScope scope(env_);
      try {
        debug_hook_.Call({
          Napi::String::New(env_, event),
          Napi::Number::New(env_, line),
          Napi::String::New(env_, name)
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
  if (RejectIfBusy()) return env_.Undefined();
  // At entry, above the options-object reads below (CR-13 F1). This method runs
  // no Lua of its own beyond lua_sethook, so before CR-13 it had no scope at
  // all — "runs no Lua" was never the test that mattered.
  const CallScope call_scope(this);

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env_, "set_hook(callback, options) requires a function")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  if (info.Length() < 2 || !info[1].IsObject() || info[1].IsArray() ||
      info[1].IsFunction()) {
    Napi::TypeError::New(env_,
      "set_hook(callback, options) requires an options object "
      "({ call?, return?, line?, count? })")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
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
    const Napi::Value count_val = options.Get("count");
    if (!count_val.IsUndefined() && !count_val.IsNull()) {
      if (!count_val.IsNumber()) {
        Napi::TypeError::New(env_, "set_hook(): count must be a number")
          .ThrowAsJavaScriptException();
        return env_.Undefined();
      }
      const double raw = count_val.As<Napi::Number>().DoubleValue();
      if (!(raw >= 1) || raw != std::trunc(raw) ||
          raw > static_cast<double>(std::numeric_limits<int>::max())) {
        Napi::RangeError::New(env_,
          "set_hook(): count must be a positive integer")
          .ThrowAsJavaScriptException();
        return env_.Undefined();
      }
      count = static_cast<int>(raw);
      mask |= LUA_MASKCOUNT;
    }
  }

  if (mask == 0) {
    Napi::TypeError::New(env_,
      "set_hook(): at least one of call, return, line, or count must be requested")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  // SetDebugHook allocates the shared callback owner, so it can throw
  // std::bad_alloc; every neighbouring install is guarded and this one was the
  // exception. An unguarded throw here would unwind past N-API and terminate
  // the process (the H1 class, CR-9 F4).
  try {
    InstallDebugHook(info[0].As<Napi::Function>(), mask, count);
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
  }
  return env_.Undefined();
}

// remove_hook() — stop tracing. A no-op when no hook is set. The instruction
// limit's own use of lua_sethook survives (the core re-installs it).
// R1: read-only debug introspection. Both are callable from *inside* a
// set_hook callback, which is the only place they are much use — that is what
// makes the difference between a profiler and a debugger.
//
// `RejectIfBusy` rather than a new occupancy policy, and the distinction
// matters: `is_busy_` marks a **worker-thread** run, where the lua_State
// belongs to another thread and reading its stack would be a data race. A hook
// callback on the main thread is not busy in that sense — the state is ours,
// Lua has disabled the hook for the duration, and re-entering is already
// documented as supported. §8.4 predicted this item would collide with the
// occupancy model; it did not, because the model already draws the line in the
// right place.
Napi::Value LuaContext::GetStack(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();

  // Scoped for the options read alone: `Get("maxLevels")` can be an accessor,
  // i.e. user JS, which could `reset()` the context out from under the stack
  // walk below (CR-13 F1). `check-invariants` scored the first draft NO_SCOPE
  // and that is exactly what it is for.
  int max_levels = 200;
  {
    const CallScope call_scope(this);
    if (info.Length() > 0 && info[0].IsObject()) {
      const Napi::Value lv = info[0].As<Napi::Object>().Get("maxLevels");
      if (lv.IsNumber()) {
        const int want = lv.As<Napi::Number>().Int32Value();
        if (want < 0) {
          Napi::RangeError::New(env_, "maxLevels must be a non-negative integer")
            .ThrowAsJavaScriptException();
          return env_.Undefined();
        }
        max_levels = want;
      }
    }
  }

  std::vector<lua_core::LuaRuntime::StackFrame> frames;
  try {
    frames = runtime_->GetStack(max_levels);
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  Napi::Array out = Napi::Array::New(env_, frames.size());
  for (size_t i = 0; i < frames.size(); ++i) {
    const auto& f = frames[i];
    const Napi::Object o = Napi::Object::New(env_);
    (void)o.Set("level", Napi::Number::New(env_, f.level));
    (void)o.Set("source", Napi::String::New(env_, f.source));
    (void)o.Set("shortSource", Napi::String::New(env_, f.short_src));
    (void)o.Set("currentLine", Napi::Number::New(env_, f.current_line));
    (void)o.Set("lineDefined", Napi::Number::New(env_, f.line_defined));
    (void)o.Set("name", Napi::String::New(env_, f.name));
    (void)o.Set("nameWhat", Napi::String::New(env_, f.name_what));
    (void)o.Set("what", Napi::String::New(env_, f.what));
    (void)out.Set(static_cast<uint32_t>(i), o);
  }
  return out;
}

Napi::Value LuaContext::GetLocals(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env_, "get_locals(level) requires a stack level")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  const int level = info[0].As<Napi::Number>().Int32Value();
  if (level < 0) {
    Napi::RangeError::New(env_, "level must be a non-negative integer")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  // The conversion below runs registered from-Lua converters, i.e. user JS, so
  // the scope is not optional (CR-9 F1 / CR-13 F1).
  const CallScope call_scope(this);
  std::optional<std::vector<std::pair<std::string, lua_core::LuaPtr>>> locals;
  try {
    locals = runtime_->GetLocals(level);
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  if (!locals) {
    // A refusal rather than an empty array: "no such frame" and "a frame with
    // no named locals" are different answers and a debugger needs to tell them
    // apart.
    Napi::RangeError::New(env_, "no stack frame at level " + std::to_string(level)
      + "; call get_stack() to see which levels exist")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  Napi::Array out = Napi::Array::New(env_, locals->size());
  for (size_t i = 0; i < locals->size(); ++i) {
    const Napi::Object o = Napi::Object::New(env_);
    (void)o.Set("name", Napi::String::New(env_, (*locals)[i].first));
    (void)o.Set("value", CoreToNapi(*(*locals)[i].second));
    (void)out.Set(static_cast<uint32_t>(i), o);
  }
  return out;
}

Napi::Value LuaContext::RemoveHook(const Napi::CallbackInfo& /*info*/) {
  if (RejectIfBusy()) return env_.Undefined();

  runtime_->RemoveDebugHook();
  debug_hook_.Reset();
  debug_hook_mask_ = 0;
  debug_hook_count_ = 0;
  return env_.Undefined();
}

Napi::Value LuaContext::SetPrintHandler(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  // InstallPrintHandler routes through SetOutputHandler -> InstallOutputRedirection,
  // which does a protected _G reassignment of print/io.write and throws on a
  // raising __newindex on a _G metatable (or OOM under maxMemory). Surface that
  // as a JS error rather than letting it terminate the process (the H1 class,
  // CR-6 F1).
  try {
    // The print/io.write overrides are protected _G writes, so a metatabled _G
    // runs its __newindex here (CR-9 F1).
    const CallScope call_scope(this);
    if (info.Length() >= 1 && info[0].IsFunction()) {
      InstallPrintHandler(info[0].As<Napi::Function>());
    } else {
      // null/undefined clears redirection (print/io.write go to stdout).
      print_handler_.Reset();
      runtime_->SetOutputHandler(nullptr);
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  return env_.Undefined();
}

bool LuaContext::InstallReadHandler(const Napi::Function& fn) {
  // Same ordering as InstallPrintHandler (CR-8 F7): the runtime install can
  // throw, and read_handler_ must not be left pointing at a handler io.read was
  // never rewired to reach. The lambda reads read_handler_ at call time.
  const bool wired = runtime_->SetInputHandler(
    [this](const lua_core::LuaPtr& format) -> std::optional<std::string> {
      if (read_handler_.IsEmpty()) return std::nullopt;
      // Inside Lua's C call frame (io.read). Scope the per-call handles so a
      // read loop does not accumulate them.
      const Napi::HandleScope scope(env_);
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
      Napi::Value format_js = env_.Undefined();
      if (format) {
        if (const auto* spec = std::get_if<std::string>(&format->value)) {
          format_js = Napi::String::New(env_, *spec);
        } else if (const auto* count = std::get_if<double>(&format->value)) {
          format_js = Napi::Number::New(env_, *count);
        } else if (const auto* n = std::get_if<int64_t>(&format->value)) {
          format_js = Napi::Number::New(env_, static_cast<double>(*n));
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
        throw Napi::Error::New(env_, JsThrowMessage(e));
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
  if (RejectIfBusy()) return env_.Undefined();
  bool wired = true;
  try {
    // The io.read override is a protected write through a table a metatabled
    // `io` could trap, and it allocates a closure (CR-9 F1, M3).
    const CallScope call_scope(this);
    if (info.Length() >= 1 && info[0].IsFunction()) {
      wired = InstallReadHandler(info[0].As<Napi::Function>());
    } else {
      // Order mirrors the install: the core removal runs first and can throw, and
      // read_handler_ must not be cleared for a removal that did not happen.
      runtime_->SetInputHandler(nullptr);
      read_handler_.Reset();
    }
  } catch (const std::exception& e) {
    // A core throw must not unwind past N-API (the H1 class, CR-6 F1).
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  return Napi::Boolean::New(env_, wired);
}

void LuaContext::InstallFileReader(const Napi::Function& fn) {
  runtime_->SetFileReader(
    [this](const std::string& path) -> std::optional<std::string> {
      if (file_reader_.IsEmpty()) return std::nullopt;
      const Napi::HandleScope scope(env_);
      Napi::Value result;
      try {
        result = file_reader_.Call({Napi::String::New(env_, path)});
      } catch (const Napi::Error& e) {
        throw Napi::Error::New(env_, JsThrowMessage(e));  // see the read handler (CR-18 F2)
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
  if (RejectIfBusy()) return env_.Undefined();
  try {
    // Installing reassigns the dofile/loadfile globals, so a metatabled _G runs
    // its __newindex here (CR-9 F1).
    const CallScope call_scope(this);
    if (info.Length() >= 1 && info[0].IsFunction()) {
      InstallFileReader(info[0].As<Napi::Function>());
    } else {
      file_reader_.Reset();
      runtime_->SetFileReader(nullptr);
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  return env_.Undefined();
}

Napi::Value LuaContext::AddSearcher(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env_, "add_searcher(fn) requires a function")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
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
    const CallScope call_scope(this);
    runtime_->AddJsSearcher(name);
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  js_callbacks_[name] = Napi::Persistent(info[0].As<Napi::Function>());
  runtime_->StoreHostFunction(name, CreateJsCallbackWrapper(name));
  // Recorded only after the core call succeeds, so a rejected registration is
  // never replayed by reset() (CR-9 F3, mirroring add_search_path).
  //
  // A second, independent Persistent to the same function — not a leak. The two
  // have different lifetimes: the js_callbacks_ entry is keyed by the generated
  // __searcher_N name and is dropped wholesale by reset(), while this one is
  // context configuration that must survive a reset in order to be replayed
  // under a freshly minted name.
  searchers_.emplace_back(Napi::Persistent(info[0].As<Napi::Function>()));
  return env_.Undefined();
}

// --- AsyncWorker OnOK/OnError implementations ---

void LuaScriptAsyncWorker::OnOK() {
  const Napi::Env env = Env();
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
  const LuaContext::CallScope call_scope(context_);

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
  const Napi::Env env = Env();
  context_->ClearBusy();
  // See LuaScriptAsyncWorker::OnOK: the marshal below runs the Lua→JS
  // converters over values belonging to the state the run executed on, so
  // reset() must be refused for its duration (CR-14 F1).
  const LuaContext::CallScope call_scope(context_);

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

namespace {

// createSharedTable(initial?) — the only way to mint a SharedTable, and so the
// only place the `kSharedTable` brand is applied.
//
// The class constructor stays unexported, but that is a convenience rather than
// the security property: it is still reachable as
// `createSharedTable().constructor`, which is exactly how CR-15 F5 defeated the
// `InstanceOf` check this comment used to credit. What makes a `shared` entry
// identifiable is the type tag applied in the constructor and checked in
// AsSharedTable — see there.
Napi::Value CreateSharedTable(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const auto* data = env.GetInstanceData<AddonData>();
  if (!data || data->shared_table_constructor.IsEmpty()) {
    Napi::Error::New(env, "SharedTable class is not initialized")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const Napi::Function ctor = data->shared_table_constructor.Value();
  if (info.Length() > 0) return ctor.New({info[0]});
  return ctor.New({});
}

Napi::Object InitModule(const Napi::Env env, const Napi::Object exports) {
  const auto result = LuaContext::Init(env, exports);
  const Napi::Function shared_ctor = SharedTable::DefineSharedTable(env);
  // Both constructors are kept alive here for the life of the addon instance;
  // the SharedTable one is also what AsSharedTable checks against.
  env.SetInstanceData(new AddonData{
    Napi::Persistent(exports.Get("init").As<Napi::Function>()),
    Napi::Persistent(shared_ctor)
  });
  (void)result.Set("createSharedTable",
    Napi::Function::New(env, CreateSharedTable, "createSharedTable"));
  return result;
}

}  // namespace

// The macro declares its own `static` registration thunk; that is
// node-addon-api's spelling, not ours to change.
// NOLINTNEXTLINE(misc-use-anonymous-namespace)
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
  const ConversionPathScope path(this);
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
    runtime_->ReserveReclaimableHostFunction(func_name);
    if (js_callback_collector_) js_callback_collector_->push_back(func_name);
  }
}

void LuaContext::SweepUnpushedJsCallbacks(const std::vector<std::string>& names) {
  for (const auto& name : names) {
    if (runtime_ && runtime_->EraseReclaimableIfUnpushed(name)) {
      js_callbacks_.erase(name);
    }
  }
}

namespace {

// A JS number as a Lua value: an integer when it is integral and in range, a
// float otherwise.
lua_core::LuaValue NumberToCore(const double num) {
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
    double intpart = 0.0;
    if (std::modf(num, &intpart) == 0.0) {
      return lua_core::LuaValue::from(static_cast<int64_t>(num));
    }
  }
  return lua_core::LuaValue::from(num);
}

}  // namespace

// A registered class instance round-tripping back to Lua, recognised by its
// `__luaClass*` markers. nullopt for anything else — including a *foreign*
// instance, which deliberately falls through to a deep copy (M6).
//
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
std::optional<lua_core::LuaValue> LuaContext::ClassInstanceMarkerToCore(
    const Napi::Object& obj) {
  if (obj.Has("__luaClassRef")) {
    const Napi::Value r = obj.Get("__luaClassRef");
    const Napi::Value cn = obj.Get("__luaClassName");
    const Napi::Value owner = obj.Get("__luaClassOwner");
    const Napi::Value owner_id = obj.Get("__luaClassOwnerId");
    bool id_matches = false;
    if (owner_id.IsBigInt()) {
      bool lossless = false;
      const uint64_t stamped = owner_id.As<Napi::BigInt>().Uint64Value(&lossless);
      id_matches = lossless && stamped == runtime_->Id();
    }
    // Branded too (CR-15 F6), so the second barrier cannot be satisfied by
    // some *other* kind of External this context handed out.
    const auto* owner_ptr =
      TaggedData<lua_core::LuaRuntime>(owner, lua_tags::kRuntimeOwner);
    const bool owned = id_matches && owner_ptr == runtime_.get();
    if (owned && r.IsNumber() && cn.IsString()) {
      const int ref_id = r.As<Napi::Number>().Int32Value();
      if (js_userdata_.find(ref_id) != js_userdata_.end()) {
        return lua_core::LuaValue::from(lua_core::LuaUserdataRef(
          ref_id, runtime_->RawState(), /*is_opaque=*/false, LUA_NOREF,
          /*is_proxy=*/false, cn.As<Napi::String>().Utf8Value()));
      }
    }
    // A foreign class instance still deep-copies, and that is deliberate
    // (M6), not an oversight — see the paragraph above the `_userdata`
    // check for why this marker is the one exception to the refusal rule.
  }
  return std::nullopt;
}

// An object that is one of this binding's own handles coming back in: a table
// handle, a Lua-created userdata, a coroutine, or a class instance. Returns the
// value it stands for, nullopt if `obj` carries no marker this context honours
// (so it converts as an ordinary object), and throws for a handle minted by a
// different context. Each marker is read once.
std::optional<lua_core::LuaValue> LuaContext::RoundTripMarkerToCore(const Napi::Object& obj) {
  // Check if it's a LuaTableRef Proxy (metatabled table round-tripping through JS).
  // Copy the existing ref so it shares registry ownership rather than minting a
  // second owner for the same slot (which would double-unref). Only trust the
  // marker if it belongs to THIS context's runtime — a ref index from another
  // context would address an unrelated slot in this registry.
  // Read once, and check kind as well as provenance (CR-15 F6): a genuine
  // `_coroutine` External re-presented here as `_tableRef` used to pass —
  // same context, and every *Data begins with the shared_ptr the identity
  // check reads — and push a thread through the table-ref path.
  if (const auto* data = TaggedData<LuaTableRefData>(obj.Get("_tableRef"),
                                               lua_tags::kTableRefData)) {
    if (data->runtime.get() == runtime_.get()) {
      // A released handle would push registry slot LUA_NOREF (nil) silently;
      // surface it as an error instead, matching the handle methods (L2).
      if (data->table_ref.ref == LUA_NOREF) {
        throw std::runtime_error("table handle has been released");
      }
      return lua_core::LuaValue::from(lua_core::LuaTableRef(data->table_ref));
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
  if (const auto* data = TaggedData<LuaUserdataData>(obj.Get("_userdata"),
                                               lua_tags::kUserdataData)) {
    if (data->runtime.get() == runtime_.get()) {
      return lua_core::LuaValue::from(lua_core::LuaUserdataRef(data->userdata_ref));
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
  if (const auto* data = TaggedData<LuaThreadData>(obj.Get("_coroutine"),
                                                   lua_tags::kThreadData);
      data && data->runtime.get() != runtime_.get()) {
    throw std::runtime_error("coroutine belongs to a different Lua context");
  }

  return ClassInstanceMarkerToCore(obj);
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
std::optional<lua_core::LuaValue> LuaContext::ApplyTypeConverters(const Napi::Value& value,
                                                                  const int depth) {
  // NOLINTNEXTLINE(modernize-loop-convert): see above — index, never range-for.
  for (size_t i = 0; i < type_converters_.size(); ++i) {
    const Napi::Function match = type_converters_[i].first.Value();
    const Napi::Function convert = type_converters_[i].second.Value();
    // Same reason as the property bridge: a converter that throws a string
    // otherwise reaches the caller as `Error` with an empty message
    // (CR-18 F2).
    try {
      if (match.Call({value}).ToBoolean().Value()) {
        return NapiToCoreInstance(convert.Call({value}), depth + 1);
      }
    } catch (const Napi::Error& e) {
      throw Napi::Error::New(env_, JsThrowMessage(e));
    }
  }
  return std::nullopt;
}

// napi_object: one of our own handles, something a registered converter
// claims, a built-in JS type, an array, or a plain object — in that order.
lua_core::LuaValue LuaContext::ObjectToCore(const Napi::Value& value, const int depth) {
  if (value.IsObject()) {
    if (auto marked = RoundTripMarkerToCore(value.As<Napi::Object>())) {
      return std::move(*marked);
    }
  }

  if (auto converted = ApplyTypeConverters(value, depth)) return std::move(*converted);

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
  const ConversionPathEntry on_path(this, value);

  // T1's inbound half, and it is a *third* silent loss, found by driving the
  // round trip rather than by reading §5 — whose JS→Lua rows do not mention
  // it. `ConvertBuiltinType` renders a Map into a `LuaTable`, which is
  // string-keyed, so `new Map([[1,'int'],['1','str']])` arrives in Lua as one
  // entry and `true` arrives as the string `"true"`. The same collapse as the
  // outbound direction, in the other direction, for the same reason: the
  // value type cannot carry a typed key.
  //
  // Under `tableAs: 'map'` the Map is therefore built as a **real Lua table**
  // and passed by reference — `SetTableFieldKeyed` takes a typed key, and
  // takes booleans since D1 — so the mode round-trips instead of being
  // one-way. The default is untouched: "keys are stringified, matching
  // plain-object behaviour" is documented, and a caller relying on it would
  // break.
  if (table_as_map_ && IsInstanceOfGlobal(value, "Map")) {
    return MapToTableRef(value.As<Napi::Object>(), depth);
  }

  // B1: common built-in JS types (binary data, Date, Map, Set, RegExp)
  if (auto builtin = ConvertBuiltinType(value, depth,
        [this](const Napi::Value& v, const int d) { return NapiToCoreInstance(v, d); })) {
    return std::move(*builtin);
  }

  if (value.IsArray()) {
    const auto arr = value.As<Napi::Array>();
    lua_core::LuaArray core_arr;
    core_arr.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); ++i) {
      core_arr.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arr.Get(i), depth + 1)));
    }
    return lua_core::LuaValue::from(std::move(core_arr));
  }
  const auto obj = value.As<Napi::Object>();
  Napi::Array keys = obj.GetPropertyNames();
  lua_core::LuaTable tbl;
  for (uint32_t i = 0; i < keys.Length(); i++) {
    const Napi::Value key = keys[i];
    std::string key_str = key.ToString().Utf8Value();
    tbl.emplace(std::move(key_str), std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(obj.Get(key), depth + 1)));
  }
  return lua_core::LuaValue::from(std::move(tbl));
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
    runtime_->RegisterReclaimableHostFunction(name, CreateJsCallbackWrapper(name));
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
    return NumberToCore(value.As<Napi::Number>().DoubleValue());
  }
  if (type == napi_string) {
    return lua_core::LuaValue::from(value.As<Napi::String>().Utf8Value());
  }
  if (type == napi_symbol) {
    throw std::runtime_error("Cannot convert a JavaScript Symbol to a Lua value");
  }

  if (type == napi_object) return ObjectToCore(value, depth);

  return lua_core::LuaValue::nil();
}

Napi::Value LuaContext::ResultsToJs(const std::vector<lua_core::LuaPtr>& values) {
  if (values.empty()) return env_.Undefined();
  if (values.size() == 1) return CoreToNapi(*values[0]);
  const Napi::Array array = Napi::Array::New(env_, values.size());
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
// Materializes a plain Lua table as a JS `Map`, keys and all.
//
// **The keys are the point.** `TablePairs` reports the real key *values* —
// number `1` and string `"1"` as distinct entries, booleans included (D1), and
// byte-exact `Uint8Array`s under `binaryStrings` — none of which a JS object
// can hold. Three of the four Lua→JS losses in `LIMITATIONS.md` §5 stop being
// losses here; they become representations.
//
// **Depth is bounded the same way the deep copy is.** In the default mode a
// self-referencing table is refused by `ToLuaValue`'s `kMaxDepth` guard. Under
// this mode the recursion moved here, so the guard has to move with it — the
// same limit, so the two modes refuse the same shapes at the same point.
//
// The `Map` constructor is read off the global, which user JS can patch. That
// is the same exposure `DefineHiddenProp` and `SymbolIteratorKey` already
// carry, and every caller is inside a CallScope for it.
// The inbound mirror of TableRefToMap: a JS Map becomes a real Lua table with
// its keys' types intact, handed back as a reference.
//
// A key that is neither string, number nor boolean cannot be a Lua table key
// this API can address, and is refused rather than stringified — the same
// ruling `pairs()` makes outbound (D1), so the two directions agree on what a
// key *is*.
lua_core::LuaValue LuaContext::MapToTableRef(const Napi::Object& map, const int depth) {
  if (depth > kMaxTableDepth) {
    throw std::runtime_error(
      "Value nesting depth exceeds the maximum of " + std::to_string(kMaxTableDepth));
  }
  const Napi::Value array_from =
    env_.Global().Get("Array").As<Napi::Object>().Get("from");
  const auto entries =
    array_from.As<Napi::Function>().Call({map}).As<Napi::Array>();

  int ref = LUA_NOREF;
  try {
    ref = runtime_->CreateTable();
  } catch (const std::exception& e) {
    throw Napi::Error::New(env_, e.what());
  }
  lua_core::LuaTableRef handle(ref, runtime_->RawState());
  for (uint32_t i = 0; i < entries.Length(); ++i) {
    const auto pair = entries.Get(i).As<Napi::Array>();
    const Napi::Value k = pair.Get(static_cast<uint32_t>(0));
    lua_core::TableKey key;
    if (!NapiToTableKey(k, key)) {
      throw std::runtime_error(
        "tableAs: 'map': a Map key that is not a string, number or boolean "
        "cannot be a Lua table key this API can address");
    }
    const auto val = std::make_shared<lua_core::LuaValue>(
      NapiToCoreInstance(pair.Get(static_cast<uint32_t>(1)), depth + 1));
    try {
      runtime_->SetTableFieldKeyed(ref, key, val);
    } catch (const std::exception& e) {
      throw Napi::Error::New(env_, e.what());
    }
  }
  return lua_core::LuaValue::from(std::move(handle));
}

Napi::Value LuaContext::TableRefToMap(const lua_core::LuaTableRef& ref, const int depth) {
  // **A `Napi::Error`, not a `std::runtime_error`, and the difference is a
  // process abort.** The first draft threw the latter and `libc++abi`
  // terminated the process on the first self-referencing table — the CR-6 F1
  // class, reachable from four lines of ordinary JavaScript. The outbound
  // conversion path has no handler above it: `CoreToNapi` is called from ~40
  // sites, most of which are not inside a try. The inbound direction can throw
  // `std::runtime_error` (its circular-reference guard does) because its
  // callers *do* catch; this direction cannot, so it raises the JS exception
  // itself. Found by the test that exercises it, one minute after it was
  // written.
  if (depth > kMaxTableDepth) {
    throw Napi::Error::New(env_,
      "Value nesting depth exceeds the maximum of " + std::to_string(kMaxTableDepth)
      + " while converting a Lua table to a Map. A table that contains itself "
        "cannot be materialized; read it in place with get_global_ref().");
  }

  // Guarded, and `check-invariants` is why this line looks like this: it scored
  // the first draft UNGUARDED_AND_PROPAGATES — a `RunProtected`-backed core call
  // reachable from the binding with no `try` above it, i.e. the CR-6 F1 abort
  // class again, this time for an OOM under `maxMemory` rather than for a deep
  // table. The depth guard above had already been caught aborting; this is the
  // same hazard on the same path, found by the machine rather than by a crash.
  std::vector<std::pair<lua_core::LuaPtr, lua_core::LuaPtr>> pairs;
  try {
    pairs = runtime_->TablePairs(ref.ref);
  } catch (const std::exception& e) {
    throw Napi::Error::New(env_, e.what());
  }
  const Napi::Array entries = Napi::Array::New(env_, pairs.size());
  for (size_t i = 0; i < pairs.size(); ++i) {
    const Napi::Array entry = Napi::Array::New(env_, 2);
    (void)entry.Set(static_cast<uint32_t>(0), CoreToNapi(*pairs[i].first));

    // Nested plain tables recurse as Maps; everything else (including a
    // metatabled table, which arrives as its own ref) goes through the ordinary
    // conversion.
    const lua_core::LuaValue& val = *pairs[i].second;
    if (std::holds_alternative<lua_core::LuaTableRef>(val.value)) {
      const auto& nested = std::get<lua_core::LuaTableRef>(val.value);
      if (!runtime_->RefHasMetatable(nested.ref)) {
        (void)entry.Set(static_cast<uint32_t>(1), TableRefToMap(nested, depth + 1));
        (void)entries.Set(static_cast<uint32_t>(i), entry);
        continue;
      }
    }
    (void)entry.Set(static_cast<uint32_t>(1), CoreToNapi(val));
    (void)entries.Set(static_cast<uint32_t>(i), entry);
  }

  const Napi::Value ctor = env_.Global().Get("Map");
  if (!ctor.IsFunction()) {
    throw Napi::Error::New(env_, "tableAs: 'map' needs the global Map constructor, "
                                "which is missing or has been replaced");
  }
  return ctor.As<Napi::Function>().New({entries});
}

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
    const Napi::Function match = from_lua_converters_[i].first.Value();
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
      throw Napi::Error::New(env_, JsThrowMessage(e));
    }
  }
  return result;
}

// Pairs a registry ref with `runtime_` only when the ref actually belongs to it,
// and hands back an already-released copy when it does not.
//
// **Every registry-backed handle this file mints pairs a ref with a
// `shared_ptr<LuaRuntime>`, and that pairing is the entire lifetime
// guarantee**: the runtime — and so the `lua_State` whose registry the ref
// indexes — cannot be destroyed while the handle lives. The pairing is written
// as `LuaFunctionData(runtime_, v, ...)` at four sites, where `runtime_` is the
// context's *current* member. That is right whenever the value came from the
// current state, which is every path but one.
//
// The exception is `reset()`. It swaps the member first and destroys the
// outgoing runtime as part of that statement, so `lua_close`'s `__gc`
// finalizers dispatch into JS with `runtime_` already pointing at the
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
  if (ref.L && lua_core::detail::OwningRuntime(ref.L) == runtime_.get()) return ref;
  RefT dead = ref;
  dead.release();  // drops only this copy's share; the core's own still unrefs
  return dead;
}

// CoreToNapiBuiltin's conversions, one per kind of Lua value that takes more
// than a line. Each recurses through CoreToNapi, so registered from-Lua
// converters are consulted at every level.

// A Lua integer: a Number when it fits one exactly, a BigInt otherwise.
Napi::Value LuaContext::IntegerToNapi(const int64_t v) {
  // Values beyond ±(2^53 - 1) can't be represented exactly as a JS
  // Number, so emit a BigInt to preserve Lua's 64-bit integer.
  constexpr int64_t kMaxSafeInteger = 9007199254740991LL;  // 2^53 - 1
  if (v > kMaxSafeInteger || v < -kMaxSafeInteger) {
    return Napi::BigInt::New(env_, v);
  }
  return Napi::Number::New(env_, static_cast<double>(v));
}

// A Lua string: text by default, the exact bytes under `binaryStrings`.
Napi::Value LuaContext::StringToNapi(const std::string& v) {
  // Under `binaryStrings`, hand back the bytes Lua actually holds. The
  // default path decodes as UTF-8, which replaces every byte of an
  // invalid sequence with U+FFFD and is lossy for binary payloads
  // (string.pack, compression, crypto, image data) — see the
  // binary_strings_ comment in lua-native.h for why this is a switch
  // rather than an automatic choice.
  if (binary_strings_) {
    auto bytes = Napi::Uint8Array::New(env_, v.size());
    if (!v.empty()) std::memcpy(bytes.Data(), v.data(), v.size());
    // `{env, bytes}` and not `bytes`: this function returns Napi::Value,
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
    return {env_, bytes};
  }
  return Napi::String::New(env_, v);
}

// A sequence, converted element by element.
Napi::Value LuaContext::ArrayToNapi(const lua_core::LuaArray& v) {
  Napi::Array arr = Napi::Array::New(env_, v.size());
  for (size_t i = 0; i < v.size(); ++i) {
    arr.Set(i, CoreToNapi(*v[i]));
  }
  return arr;
}

// A string-keyed table, converted field by field.
Napi::Value LuaContext::TableToNapi(const lua_core::LuaTable& v) {
  Napi::Object obj = Napi::Object::New(env_);
  for (const auto& [k, val] : v) {
    obj.Set(k, CoreToNapi(*val));
  }
  return obj;
}

// A Lua function, as a callable JS function that owns its registry ref.
Napi::Value LuaContext::FunctionRefToNapi(const lua_core::LuaFunctionRef& v) {
  // The data is owned by a finalizer tied to the JS function, so it (and
  // its registry ref) is freed when the function is garbage-collected.
  // Held by unique_ptr until that finalizer becomes the owner, so an
  // N-API allocation that throws in between cannot leak it — the same
  // discipline CreateTableHandle and CreateCoroutineObject use
  // (CR-9 F4, swept to its remaining siblings by CR-11 F5).
  auto data = std::make_unique<LuaFunctionData>(
    runtime_, RefForThisRuntime(v), this, Liveness());
  LuaFunctionData* data_ptr = data.get();
  const Napi::Function fn =
    Napi::Function::New(env_, LuaFunctionCallbackStatic, "luaFunction", data_ptr);
  // Non-writable + non-configurable: this External's finalizer owns the
  // LuaFunctionData that `fn` still calls through, so it must not be
  // deletable or reassignable from JS (L6).
  const auto owner = NewTaggedExternal(env_, data_ptr, lua_tags::kFunctionData,
    [](Napi::Env, const LuaFunctionData* d) { delete d; });
  // Released the moment the External exists, not after DefineHiddenProp
  // (which can throw): the finalizer is already the owner by then, so
  // the discarded result is deliberate.
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)data.release();
  DefineHiddenProp(env_, fn, "__luaFnOwner", owner, /*writable=*/false);
  return fn;
}

// A userdata: the original JS object, or an opaque handle for a Lua-created one.
Napi::Value LuaContext::UserdataRefToNapi(const lua_core::LuaUserdataRef& v) {
  if (!v.opaque) {
    // JS-created userdata - return the original JS object
    const auto it = js_userdata_.find(v.ref_id);
    if (it != js_userdata_.end()) {
      return it->second.object.Value();
    }
    return env_.Null();
  }
  // Lua-created userdata - wrap as opaque handle for round-trip (data
  // owned by the External's finalizer; unique_ptr until then, see the
  // LuaFunctionRef branch above).
  auto data = std::make_unique<LuaUserdataData>(runtime_, RefForThisRuntime(v));
  Napi::Object handle = Napi::Object::New(env_);
  const auto owner = NewTaggedExternal(env_, data.get(), lua_tags::kUserdataData,
    [](Napi::Env, const LuaUserdataData* d) { delete d; });
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)data.release();  // ownership transferred to the finalizer
  handle.Set("_userdata", owner);
  return handle;
}

// A table kept by reference: a Map under `tableAs: 'map'`, otherwise a Proxy
// that preserves the Lua metamethods.
Napi::Value LuaContext::TableRefToNapi(const lua_core::LuaTableRef& v) {
  // `tableAs: 'map'` (T1). A *plain* table reaches this branch only in
  // map mode — ToLuaValue keeps it by reference there instead of
  // flattening it to a string-keyed LuaTable — so materialize it with
  // its real keys. A metatabled table is a live Proxy in every mode and
  // falls through: the option governs how a table is *converted*, and a
  // metatabled one deliberately is not.
  if (table_as_map_ && !runtime_->RefHasMetatable(v.ref)) {
    return TableRefToMap(v, 0);
  }

  // Create a JS Proxy that preserves Lua metamethods. The trap data is
  // owned by the External's finalizer, tied to the proxy target's life.
  const Napi::Object target = Napi::Object::New(env_);

  // unique_ptr until the External's finalizer owns it, see the
  // LuaFunctionRef branch above (CR-11 F5).
  auto data = std::make_unique<LuaTableRefData>(
      runtime_, RefForThisRuntime(v), this, Liveness());
  LuaTableRefData* data_ptr = data.get();

  // Store _tableRef as non-enumerable on target for round-trip detection
  auto external = NewTaggedExternal(env_, data_ptr, lua_tags::kTableRefData,
    [](Napi::Env, const LuaTableRefData* d) { delete d; });
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)data.release();  // ownership transferred to the finalizer
  const auto object_ctor = env_.Global().Get("Object").As<Napi::Object>();
  const auto define_property = object_ctor.Get("defineProperty").As<Napi::Function>();
  const Napi::Object descriptor = Napi::Object::New(env_);
  descriptor.Set("value", external);
  descriptor.Set("enumerable", Napi::Boolean::New(env_, false));
  descriptor.Set("configurable", Napi::Boolean::New(env_, true));
  define_property.Call({target, Napi::String::New(env_, "_tableRef"), descriptor});

  // Create handler with traps. Root the owner External on each trap so
  // `delete proxy._tableRef` (which forwards to the target, removing only
  // that reference) can't free data_ptr while the traps still point at it
  // (H3). The target's _tableRef stays configurable so the Proxy ownKeys
  // invariant — ownKeys omits _tableRef — is not violated.
  const Napi::Object handler = Napi::Object::New(env_);
  const auto add_trap = [&](const char* name,
                     Napi::Value (*cb)(const Napi::CallbackInfo&)) {
    const Napi::Function fn = Napi::Function::New(env_, cb, name, data_ptr);
    DefineHiddenProp(env_, fn, "_tableOwner", external, /*writable=*/false);
    (void)handler.Set(name, fn);
  };
  add_trap("get", TableRefGetTrap);
  add_trap("set", TableRefSetTrap);
  add_trap("has", TableRefHasTrap);
  add_trap("ownKeys", TableRefOwnKeysTrap);
  add_trap("getOwnPropertyDescriptor", TableRefGetOwnPropertyDescriptorTrap);

  // Create Proxy
  const auto proxy_ctor = env_.Global().Get("Proxy").As<Napi::Function>();
  return proxy_ctor.New({target, handler});
}

Napi::Value LuaContext::CoreToNapiBuiltin(const lua_core::LuaValue& value) {
  return std::visit(
      [&](const auto& v) -> Napi::Value {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, std::monostate>) {
          return env_.Null();
        } else if constexpr (std::is_same_v<T, bool>) {
          return Napi::Boolean::New(env_, v);
        } else if constexpr (std::is_same_v<T, int64_t>) {
          return IntegerToNapi(v);
        } else if constexpr (std::is_same_v<T, double>) {
          return Napi::Number::New(env_, v);
        } else if constexpr (std::is_same_v<T, std::string>) {
          return StringToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaArray>) {
          return ArrayToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaTable>) {
          return TableToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaFunctionRef>) {
          return FunctionRefToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaThreadRef>) {
          // Return a coroutine object with the thread reference (data owned by the
          // External's finalizer).
          const lua_core::CoroutineStatus status = lua_core::LuaRuntime::GetCoroutineStatus(v);
          return CreateCoroutineObject(
            std::make_unique<LuaThreadData>(runtime_, RefForThisRuntime(v)),
            CoroutineStatusName(status));
        } else if constexpr (std::is_same_v<T, lua_core::LuaUserdataRef>) {
          return UserdataRefToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::LuaTableRef>) {
          return TableRefToNapi(v);
        } else if constexpr (std::is_same_v<T, lua_core::HostFunctionName>) {
          // A JS function that crossed into Lua and came back: return the
          // original JS function if it's still registered.
          const auto it = js_callbacks_.find(v.name);
          if (it != js_callbacks_.end()) return it->second.Value();
          return env_.Undefined();
        }
        return env_.Undefined();
      },
      value.value);
}

// --- A4: coroutines as JS iterators ---

namespace {

// The realm's well-known Symbol.iterator.
Napi::Value SymbolIteratorKey(const Napi::Env env) {
  return env.Global().Get("Symbol").As<Napi::Object>().Get("iterator");
}

Napi::Value SymbolAsyncIteratorKey(const Napi::Env env) {
  return env.Global().Get("Symbol").As<Napi::Object>().Get("asyncIterator");
}

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
    return context != nullptr && liveness.HandlesLive();
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

Napi::Value CoroIterResult(const Napi::Env env, const Napi::Value& value,
                                  const bool done) {
  const Napi::Object result = Napi::Object::New(env);
  (void)result.Set("value", value);
  (void)result.Set("done", Napi::Boolean::New(env, done));
  return result;
}

Napi::Value CoroIteratorNext(const Napi::CallbackInfo& info) {
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
  if (const auto* thread_data =
        TaggedData<LuaThreadData>(coro.Get("_coroutine"), lua_tags::kThreadData);
      thread_data && thread_data->thread_ref.ref != LUA_NOREF &&
      lua_core::LuaRuntime::GetCoroutineStatus(thread_data->thread_ref) ==
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
  const LuaContext::CallScope scope(state->context);

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
Napi::Value CoroAsyncNextMap(const Napi::CallbackInfo& info) {
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
Napi::Value CoroAsyncIteratorNext(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  auto* state = static_cast<LuaCoroIterState*>(info.Data());

  // Everything past the liveness check settles a promise rather than throwing,
  // so `for await` sees failures through its normal channel.
  const auto settled = [&env](const Napi::Value& v) -> Napi::Value {
    const auto d = Napi::Promise::Deferred::New(env);
    d.Resolve(v);
    return d.Promise();
  };
  const auto rejected = [&env](const std::string& msg) -> Napi::Value {
    const auto d = Napi::Promise::Deferred::New(env);
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
  if (const auto* thread_data =
        TaggedData<LuaThreadData>(coro.Get("_coroutine"), lua_tags::kThreadData);
      thread_data && thread_data->thread_ref.ref != LUA_NOREF &&
      lua_core::LuaRuntime::GetCoroutineStatus(thread_data->thread_ref) ==
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
  //
  // No busy check here either, unlike CoroIteratorNext: ResumeCoroutineObjectAsync
  // makes it, and answers with a rejected promise — which the `then` below
  // passes through without calling the mapper, so `done` stays false.
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
  const auto promise_obj = promise.As<Napi::Object>();
  const Napi::Value then_val = promise_obj.Get("then");
  if (!then_val.IsFunction()) {
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
  return then_val.As<Napi::Function>().Call(promise_obj, {mapper});
}

Napi::Value CoroAsyncIteratorSelf(const Napi::CallbackInfo& info) {
  return info.This();
}

// Called when a for..of loop exits early (`break`, `return`, a throw). Ends
// this cursor only — the underlying coroutine keeps its suspension point, so a
// later loop resumes where this one stopped.
Napi::Value CoroIteratorReturn(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (auto* state = static_cast<LuaCoroIterState*>(info.Data())) state->done = true;
  return CoroIterResult(env, info.Length() > 0 ? info[0] : env.Undefined(), true);
}

Napi::Value CoroIteratorSelf(const Napi::CallbackInfo& info) {
  return info.This();
}

// The coroutine object's `[Symbol.iterator]`. `info.Data()` is the context
// binding minted alongside the coroutine; `info.This()` is the coroutine.
Napi::Value CoroSymbolIterator(const Napi::CallbackInfo& info) {
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

  const auto add_method = [&](const char* name,
                       Napi::Value (*cb)(const Napi::CallbackInfo&)) {
    const Napi::Function fn = Napi::Function::New(env, cb, name, state);
    DefineHiddenProp(env, fn, "__coroIterOwner", NewCoroIterOwner(env, sp),
                     /*writable=*/false);
    (void)iterator.Set(name, fn);
  };
  add_method("next", CoroIteratorNext);
  add_method("return", CoroIteratorReturn);
  (void)iterator.Set(SymbolIteratorKey(env),
    Napi::Function::New(env, CoroIteratorSelf, "[Symbol.iterator]"));
  return iterator;
}

// The coroutine object's `[Symbol.asyncIterator]` (P1b). Structurally identical
// to CoroSymbolIterator; the cursor it mints steps through resume_async, so the
// coroutine may await a host Promise at any yield.
Napi::Value CoroSymbolAsyncIterator(const Napi::CallbackInfo& info) {
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

  const auto add_method = [&](const char* name,
                       Napi::Value (*cb)(const Napi::CallbackInfo&)) {
    const Napi::Function fn = Napi::Function::New(env, cb, name, state);
    DefineHiddenProp(env, fn, "__coroIterOwner", NewCoroIterOwner(env, sp),
                     /*writable=*/false);
    (void)iterator.Set(name, fn);
  };
  add_method("next", CoroAsyncIteratorNext);
  // `return` ends the cursor without touching the thread, exactly as the sync
  // one does — an early `break` out of `for await` leaves the coroutine
  // suspended and resumable. It answers synchronously; JS wraps a non-promise
  // return from an async iterator's `return` for us.
  add_method("return", CoroIteratorReturn);
  (void)iterator.Set(SymbolAsyncIteratorKey(env),
    Napi::Function::New(env, CoroAsyncIteratorSelf, "[Symbol.asyncIterator]"));
  return iterator;
}

}  // namespace

Napi::Object LuaContext::CreateCoroutineObject(std::unique_ptr<LuaThreadData> data,
                                               const std::string& status) {
  // `data` owns the thread's registry ref until the External's finalizer takes
  // over, so a throw from the N-API allocations below releases the slot instead
  // of orphaning it (CR-9 F4).
  const Napi::Object coro = Napi::Object::New(env_);
  // The External's finalizer owns the data — freed when the coroutine object is
  // garbage-collected.
  (void)coro.Set("_coroutine", NewTaggedExternal(env_, data.get(), lua_tags::kThreadData,
    [](Napi::Env, const LuaThreadData* d) { delete d; }));
  // Discarding release() is deliberate: the pointer is already held by the
  // External above. Releasing *after* the External exists is what keeps the
  // throw path safe, so the result cannot be consumed by folding it into the
  // New() argument.
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)data.release();  // ownership transferred to the finalizer
  (void)coro.Set("status", Napi::String::New(env_, status));

  auto binding_owner = std::make_unique<LuaContextBinding>(LuaContextBinding{this, Liveness()});
  LuaContextBinding* binding = binding_owner.get();
  const Napi::Function iter_fn =
    Napi::Function::New(env_, CoroSymbolIterator, "[Symbol.iterator]", binding);
  const auto binding_external = Napi::External<LuaContextBinding>::New(env_, binding,
    [](Napi::Env, const LuaContextBinding* b) { delete b; });
  // Released the moment the External exists — not after DefineHiddenProp, which
  // can throw: the finalizer is already the owner by then, so a later release
  // would be a double free. The discarded result is deliberate for that reason.
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)binding_owner.release();
  DefineHiddenProp(env_, iter_fn, "__coroBindingOwner", binding_external,
    /*writable=*/false);
  (void)coro.Set(SymbolIteratorKey(env_), iter_fn);

  // Symbol.asyncIterator (P1b). `for await` previously bound to the *sync*
  // iterator through JS's fallback, which is precisely why a yield needing a
  // Promise could not work; with this present it binds here instead. A second
  // binding object rather than a shared one: each is owned by its own External
  // finalizer, and sharing would mean two finalizers over one allocation.
  auto async_binding_owner =
    std::make_unique<LuaContextBinding>(LuaContextBinding{this, Liveness()});
  LuaContextBinding* async_binding = async_binding_owner.get();
  const Napi::Function async_iter_fn = Napi::Function::New(
    env_, CoroSymbolAsyncIterator, "[Symbol.asyncIterator]", async_binding);
  const auto async_binding_external =
    Napi::External<LuaContextBinding>::New(env_, async_binding,
      [](Napi::Env, const LuaContextBinding* b) { delete b; });
  // NOLINTNEXTLINE(bugprone-unused-return-value)
  (void)async_binding_owner.release();  // see the sync binding above
  DefineHiddenProp(env_, async_iter_fn, "__coroBindingOwner", async_binding_external,
    /*writable=*/false);
  (void)coro.Set(SymbolAsyncIteratorKey(env_), async_iter_fn);
  return coro;
}

namespace {

// Extracts the LuaFunctionData behind a Lua function handed back to JS (the
// wrapper CoreToNapi mints for a LuaFunctionRef). Returns nullptr for a plain
// JS function, leaving the caller to raise its own error.
LuaFunctionData* LuaFunctionDataFrom(const Napi::Value& value) {
  if (!value.IsFunction()) return nullptr;
  // One Get, and branded — see TableRefDataFrom (CR-15 F6).
  return TaggedData<LuaFunctionData>(value.As<Napi::Object>().Get("__luaFnOwner"),
                                     lua_tags::kFunctionData);
}

}  // namespace

// create_coroutine(scriptOrFunction)
//
// The original form takes a script string that *returns* a function. It also
// accepts a Lua function already held on the JS side (A4), so a function
// obtained from execute_script / get_global can be turned into a coroutine
// without being re-sourced as text.
Napi::Value LuaContext::CreateCoroutine(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();

  std::optional<lua_core::LuaFunctionRef> func_ref;

  if (info.Length() >= 1 && info[0].IsFunction()) {
    const auto* fn_data = LuaFunctionDataFrom(info[0]);
    if (!fn_data) {
      Napi::TypeError::New(env_,
        "create_coroutine() accepts a script string or a Lua function; a plain "
        "JavaScript function cannot be a coroutine body")
        .ThrowAsJavaScriptException();
      return env_.Undefined();
    }
    // A function from another context refs a slot in an unrelated registry; a
    // released one refs nothing. Same identity checks resume() applies (M1).
    if (fn_data->runtime.get() != runtime_.get()) {
      Napi::Error::New(env_, "Lua function belongs to a different Lua context")
        .ThrowAsJavaScriptException();
      return env_.Undefined();
    }
    if (fn_data->func_ref.ref == LUA_NOREF) {
      Napi::Error::New(env_, "Lua function has been released")
        .ThrowAsJavaScriptException();
      return env_.Undefined();
    }
    // Copying shares the registry slot's ownership rather than minting a second
    // owner for it, so the coroutine body outlives the JS wrapper.
    func_ref = fn_data->func_ref;
  } else {
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env_,
        "Expected a script string that returns a function, or a Lua function")
        .ThrowAsJavaScriptException();
      return env_.Undefined();
    }

    // Execute script and get function
    const std::string script = info[0].As<Napi::String>().Utf8Value();
    const CallScope call_scope(this);
    std::string chunk_name;
    if (!ParseChunkName(info, 1, "create_coroutine()", chunk_name)) return env_.Undefined();

    const auto res = runtime_->ExecuteScript(script, chunk_name);
    if (std::holds_alternative<std::string>(res)) {
      ThrowLuaError(std::get<std::string>(res));
      return env_.Undefined();
    }

    const auto& values = std::get<std::vector<lua_core::LuaPtr>>(res);
    if (values.empty() || !std::holds_alternative<lua_core::LuaFunctionRef>(values[0]->value)) {
      Napi::TypeError::New(env_, "Script must return a function").ThrowAsJavaScriptException();
      return env_.Undefined();
    }
    func_ref = std::get<lua_core::LuaFunctionRef>(values[0]->value);
  }

  auto result = runtime_->CreateCoroutine(*func_ref);
  if (std::holds_alternative<std::string>(result)) {
    Napi::Error::New(env_, std::get<std::string>(result)).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  const auto& thread_ref = std::get<lua_core::LuaThreadRef>(result);
  return CreateCoroutineObject(
    std::make_unique<LuaThreadData>(runtime_, thread_ref), "suspended");
}

Napi::Value LuaContext::ResumeCoroutine(const Napi::CallbackInfo& info) {
  if (RejectIfBusy()) return env_.Undefined();
  // Clear the JS-error registry at the outermost entry so a staged error from a
  // prior resume (whose JS callback threw) can't accumulate — resume otherwise
  // has no CallScope and never consumes by id (L7).
  const CallScope scope(this);
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env_, "Expected a coroutine object as first argument").ThrowAsJavaScriptException();
    return env_.Undefined();
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
  if (RejectIfBusy()) return env_.Undefined();
  // A __close handler runs Lua, which can reach a host callback; the scope is
  // what makes that re-entrancy visible to the occupancy checks (CR-9 F1).
  const CallScope scope(this);
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env_, "close(coroutine) requires a coroutine object")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  const auto coro_obj = info[0].As<Napi::Object>();

  // Single branded read, and the same identity checks resume applies (CR-15 F6,
  // M1): a thread from another context would be closed with this context's main
  // state as `from`, which is two unrelated Lua states in one call.
  const auto* thread_data =
    TaggedData<LuaThreadData>(coro_obj.Get("_coroutine"), lua_tags::kThreadData);
  if (!thread_data || !thread_data->runtime) {
    Napi::TypeError::New(env_, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  if (thread_data->runtime.get() != runtime_.get()) {
    Napi::Error::New(env_, "coroutine belongs to a different Lua context")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  // Released, so there is no thread to close. Not an error: a released
  // coroutine has no pending state a caller could still be responsible for.
  if (thread_data->thread_ref.ref == LUA_NOREF) return env_.Undefined();

  std::optional<std::string> err;
  try {
    err = runtime_->CloseCoroutine(thread_data->thread_ref);
  } catch (const std::exception& e) {
    // A __close handler can reach the host, so this inherits the whole
    // exception surface a resume has; it must not unwind past N-API (H1).
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  // The thread is dead either way — a failed __close still closed everything it
  // reached — so the status is updated before the error is raised.
  (void)coro_obj.Set("status", Napi::String::New(env_, "dead"));
  if (err) {
    ThrowLuaError(*err);
    return env_.Undefined();
  }
  return env_.Undefined();
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
  if (RejectIfBusy()) return env_.Undefined();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env_,
      "resume_async(coroutine, ...args) requires a coroutine object")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  std::vector<Napi::Value> args;
  args.reserve(info.Length() > 0 ? info.Length() - 1 : 0);
  for (size_t i = 1; i < info.Length(); ++i) args.push_back(info[i]);
  return ResumeCoroutineObjectAsync(info[0].As<Napi::Object>(), args,
                                    info.This().As<Napi::Object>());
}

Napi::Value LuaContext::ResumeCoroutineObjectAsync(
    const Napi::Object& coro_obj, const std::vector<Napi::Value>& args_js,
    const Napi::Object& self) {
  const auto reject = [this](const std::string& msg) -> Napi::Value {
    const auto deferred = Napi::Promise::Deferred::New(env_);
    deferred.Reject(Napi::Error::New(env_, msg).Value());
    return deferred.Promise();
  };

  // The entry check, here rather than in the callers so neither can skip it.
  // resume_async never reaches it busy — its RejectIfBusy throws first, as
  // every method's does. The async cursor's `next` has no check of its own and
  // relies on this one; it gets a rejection because it settles a promise for
  // everything, and it is not marked done, so the cursor works again once the
  // context is free — what the synchronous cursor's throw leaves behind.
  //
  // Before anything else, and not only at the commit point below: a *worker*
  // run may be what holds the context, and then the conversion's callback
  // registration and the drive would both touch a state another thread is
  // running. Without it `next()` during execute_script_async did exactly that.
  if (IsBusy()) return reject(kAsyncBusyMessage);

  // Scoped like CallAsync's, and for the same two reasons: the marker read and
  // the argument conversion both run user JS and must be inside the guard
  // (CR-13 F1), and the guard must be released before the drive so call_depth_
  // is not held across a suspended await (CR-10 F1). The synchronous pair puts
  // this scope in ResumeCoroutine and leaves ResumeCoroutineObject bare; the
  // async pair cannot, because the scope has to end mid-function.
  LuaThreadData* thread_data = nullptr;
  std::vector<lua_core::LuaPtr> args;
  // One collector spans every argument so a later argument's conversion
  // failure sweeps the callbacks minted by the earlier ones (CR-8 F1), and
  // stays open across the drive that pushes them — see CallAsync, which had
  // the same early close and explains why this one may be held where the
  // CallScope may not.
  const JsCallbackCollectorScope collector(this);
  {
  const CallScope call_scope(this);

  // Identical validation to ResumeCoroutineObject, and identical for a reason:
  // a branded single read (CR-15 F6), same-context identity (M1), and a
  // released-ref check, because driving a foreign or released thread is the same
  // UB whether the driver is synchronous or not. Reported as rejections rather
  // than throws so `await`/`.catch` see everything past the argument check.
  thread_data =
    TaggedData<LuaThreadData>(coro_obj.Get("_coroutine"), lua_tags::kThreadData);
  if (!thread_data || !thread_data->runtime) {
    Napi::TypeError::New(env_, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  if (thread_data->runtime.get() != runtime_.get()) {
    return reject("coroutine belongs to a different Lua context");
  }
  if (thread_data->thread_ref.ref == LUA_NOREF) {
    return reject("coroutine has been released");
  }

  args.reserve(args_js.size());
  try {
    for (const auto& arg : args_js) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arg)));
    }
  } catch (const std::exception& e) {
    return reject(e.what());
  }
  }  // CallScope closes here — nothing below runs user JS before the drive

  // The commit-point check (see BeginAsyncRun): the marker read and the
  // conversion above ran user JS, which may have started a run of its own.
  if (IsBusy()) return reject(kAsyncBusyMessage);

  // Borrowed, not owned: async_co_ stays disengaged so FinishAsync releases
  // nothing, and the coroutine object is rooted for the run because
  // async_borrowed_ points into data owned by that object's External finalizer.
  async_borrowed_ = thread_data;
  async_coro_obj_ = Napi::Persistent(coro_obj);
  async_coroutine_mode_ = true;
  // `self` is the context wrapper, not the coroutine: async_self_ref_ exists to
  // keep the ObjectWrap alive across a suspended await (the settlement callbacks
  // hold only a raw pointer to it). The coroutine object is rooted separately,
  // above, because it owns the thread being driven.
  return BeginAsyncRun(self, args);
}

Napi::Value LuaContext::ResumeCoroutineObject(const Napi::Object& coro_obj,
                                              const std::vector<Napi::Value>& args_js) {
  // Single branded read (CR-15 F6). The old form did Has, then Get, then a
  // third read through As<>, and trusted the marker's *name*: a table handle's
  // `_tableRef` External presented as `_coroutine` reached lua_resume through a
  // LuaTableRefData.
  const auto* thread_data =
    TaggedData<LuaThreadData>(coro_obj.Get("_coroutine"), lua_tags::kThreadData);
  if (!thread_data) {
    Napi::TypeError::New(env_, "Invalid coroutine object").ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  if (!thread_data->runtime) {
    Napi::Error::New(env_, "Invalid coroutine reference").ThrowAsJavaScriptException();
    return env_.Undefined();
  }
  // Resuming a coroutine created by another context would run lua_resume with
  // this context's main state driving that context's thread — two unrelated Lua
  // states in one call (UB). Reject it, mirroring the round-trip identity checks
  // on table/userdata/class markers (M1).
  if (thread_data->runtime.get() != runtime_.get()) {
    Napi::Error::New(env_, "coroutine belongs to a different Lua context")
      .ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  // A released ref carries LUA_NOREF and a null thread pointer — resuming it
  // would drive lua_resume on nullptr. Surface a clear error instead.
  if (thread_data->thread_ref.ref == LUA_NOREF) {
    Napi::Error::New(env_, "coroutine has been released").ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  // Convert the resume arguments. One collector spans every argument so a later
  // argument's conversion failure sweeps the callbacks minted by the earlier
  // ones (CR-8 F1).
  const JsCallbackCollectorScope collector(this);
  std::vector<lua_core::LuaPtr> args;
  args.reserve(args_js.size());
  try {
    for (const auto& arg : args_js) {
      args.push_back(std::make_shared<lua_core::LuaValue>(NapiToCoreInstance(arg)));
    }
  } catch (const std::exception& e) {
    Napi::Error::New(env_, e.what()).ThrowAsJavaScriptException();
    return env_.Undefined();
  }

  // Resume the coroutine
  auto [status, values, error] = runtime_->ResumeCoroutine(thread_data->thread_ref, args);
  return CoroutineResultToJs(coro_obj, status, values, error);
}

// Marshals one coroutine step into the `{ status, values, error? }` object both
// resume() and resume_async() answer with, and updates the coroutine object's
// own `status`. Shared so the sync and async doors cannot drift apart in the
// shape they return — the two differ in whether they can await, and in nothing
// else.
Napi::Value LuaContext::CoroutineResultToJs(
    const Napi::Object& coro_obj,
    lua_core::CoroutineStatus status,
    const std::vector<lua_core::LuaPtr>& values,
    const std::optional<std::string>& error) {
  const Napi::Object result_obj = Napi::Object::New(env_);

  const std::string status_str = CoroutineStatusName(status);
  result_obj.Set("status", Napi::String::New(env_, status_str));

  // Update the coroutine object's status too
  coro_obj.Set("status", Napi::String::New(env_, status_str));

  // Set values
  const Napi::Array values_arr = Napi::Array::New(env_, values.size());
  for (size_t i = 0; i < values.size(); ++i) {
    values_arr.Set(i, CoreToNapi(*values[i]));
  }
  (void)result_obj.Set("values", values_arr);

  // Set error if present
  if (error.has_value()) {
    // Consume any staged fidelity state (the js_error_registry_ entry and
    // last_error_value_) so it doesn't linger after this resume (L7). The
    // coroutine API surfaces the error as a string, so the reconstructed Error
    // object LuaErrorToJsValue returns is intentionally discarded.
    (void)LuaErrorToJsValue(error.value());
    result_obj.Set("error", Napi::String::New(env_, error.value()));
  }

  return result_obj;
}
